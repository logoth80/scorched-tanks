/* =====================================================================
 * GAME LOGIC — no DOM here, so the whole engine can also be simulated
 * headless (see test/sim.js). The UI/renderer just subscribe to events.
 *
 * MATCH FLOW
 *   start → SHOP (once, before battle 1) → battle 1 → ... → battle N
 *   The shop runs ONLY before battles, never mid-battle. Every battle
 *   gets brand-new terrain and a fresh random tank placement; HP and
 *   fuel reset, money and purchased ammo carry over. Last battle over
 *   → match winner = most battle wins.
 *
 * TURN RESOLUTION ORDER (strict, per the design):
 *   1. the shot resolves (every projectile finishes; blast circles are
 *      shown GROWING from each impact — no damage yet)
 *   2. once all circles finish growing: damage to players + craters
 *   3. the ground falls (settling runs to completion)
 *   4. tanks fall if their ground went, then fall damage is applied
 *   ... only then does the next turn (or the next battle) begin.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});
const U = SE.util;
const CFG = SE.CONFIG;
const DEG = Math.PI / 180;

class Game {
  constructor(opts) {
    const seed = (opts.seed || 12345) >>> 0;
    this.rand = U.mulberry32(seed);
    this.seed = seed;
    this.totalBattles = U.clamp(opts.battles || CFG.TOTAL_BATTLES, 1, 9);
    this.battle = 0;
    this.battleWins = [];
    this.seats = opts.seats.map(function (s) {
      return { human: !!s.human, name: s.name || null };
    });
    this.terrain = new SE.Terrain(CFG.W, CFG.H);

    this.players = this.seats.map(function (s, i) {
      const col = SE.PLAYER_COLORS[i % SE.PLAYER_COLORS.length];
      return {
        id: i, name: s.name || (s.human ? 'Player ' + (i + 1) : 'CPU ' + (i + 1)),
        human: s.human, color: col, colorIdx: i,
        variant: SE.TANK_VARIANTS[i % SE.TANK_VARIANTS.length],
        x: 0, y: 0, vy: 0, falling: false, fallStartY: 0, paraActive: false,
        hp: CFG.HP, alive: true, money: CFG.START_MONEY, fuel: CFG.FUEL_TOTAL,
        para: 0, shield: false,
        ammo: { basic: Infinity },
        angle: 60, power: 50, selected: 'basic',
        kills: 0, shots: 0,
      };
    });

    this.state = 'idle';          // idle | between | shop | aim | flight | resolve | over
    this.round = 0;              // turn-cycles inside the current battle (for the storm)
    this.turnIdx = -1;
    this.currentId = -1;
    this.wind = 0;
    this.projectiles = [];
    this.blastQueue = [];         // delayed extra blasts of multiblast weapons
    this.blastsActive = [];       // growing telegraph circles, not yet applied
    this.resPhase = null;         // blasts | settle | tanks
    this.resolveTimer = 0;
    this.tankQuiet = 0;
    this.settling = false;
    this.settleBudget = 0;
    this.shopQueue = [];
    this.aiTimer = 0;
    this.betweenTimer = 0;
    this.winner = null;
    this._handlers = {};
  }

  /* ---------- events ---------- */
  on(type, cb) { (this._handlers[type] = this._handlers[type] || []).push(cb); return this; }
  emit(type, data) {
    const hs = this._handlers[type];
    if (hs) for (const cb of hs) cb(data || {});
  }
  _setState(s) { this.state = s; this.emit('state', { state: s }); }

  playerById(id) { return this.players[id]; }
  current() { return this.currentId >= 0 ? this.players[this.currentId] : null; }
  aliveCount() { return this.players.filter(function (p) { return p.alive; }).length; }
  firstAliveSeat() {
    for (let i = 0; i < this.players.length; i++) if (this.players[i].alive) return i;
    return -1;
  }

  /* ---------- match / battle flow ---------- */
  start() {
    this.battleWins = this.players.map(function () { return 0; });
    this._nextBattle(true);
  }

  _nextBattle(first) {
    this.battle++;
    // brand-new battlefield every battle
    this.terrain.generate(this.rand);
    this.round = 0;
    this.wind = 0;
    this.projectiles = [];
    this.blastQueue = [];
    this.blastsActive = [];
    this.pendingAdds = [];
    this.settling = false;
    this.resPhase = null;
    for (const p of this.players) {
      p.alive = true; p.hp = CFG.HP; p.fuel = CFG.FUEL_TOTAL;
      p.x = 0; p.y = 0; p.vy = 0; p.falling = false; p.paraActive = false;
      p.shield = false;
      p.needsAim = true;                 // fresh battlefield: aim defaults again,
      p.lastShot = null; p.lastImpact = null;  // but bought ammo + selection stay
    }
    this.placeTanks();
    this.emit('battleStart', { battle: this.battle, total: this.totalBattles, first: !!first });
    this.openShop();
  }

  placeTanks() {
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const p = this.players[i];
      let placed = false;
      for (let att = 0; att < 500 && !placed; att++) {
        const x = Math.round(60 + this.rand() * (CFG.W - 120));
        let ok = true;
        for (let j = 0; j < i; j++) {
          if (Math.abs(this.players[j].x - x) < 150) { ok = false; break; }
        }
        if (!ok) continue;
        const gy = this.terrain.top(x);
        if (Math.abs(this.terrain.top(x - 9) - gy) > 3 ||
            Math.abs(this.terrain.top(x + 9) - gy) > 3) continue;
        p.x = x; p.y = gy; placed = true;
      }
      if (!placed) {
        p.x = Math.round((i + 1) * CFG.W / (n + 1));
        p.y = this.terrain.top(p.x);
      }
    }
  }

  _endOfBattle() {
    const alive = this.players.filter(function (p) { return p.alive; });
    const winnerId = alive.length === 1 ? alive[0].id : null;
    if (winnerId != null) {
      this.battleWins[winnerId]++;
      this.addMoney(this.players[winnerId], CFG.WIN_PAY, 'win');
    }
    for (const p of alive) this.addMoney(p, CFG.SURVIVE_PAY, 'survive');
    this.emit('battleEnd', { battle: this.battle, winnerId: winnerId });

    if (this.battle >= this.totalBattles) { this._finishMatch(); return; }
    this._setState('between');
    this.betweenTimer = CFG.INTER_BATTLE_FRAMES;
  }

  _finishMatch() {
    this._setState('over');
    let best = -1;
    for (let i = 0; i < this.players.length; i++) {
      if (best < 0) { best = i; continue; }
      if (this.battleWins[i] > this.battleWins[best]) best = i;
      else if (this.battleWins[i] === this.battleWins[best] &&
               this.players[i].kills > this.players[best].kills) best = i;
    }
    this.winner = best;
    this.emit('over', {
      winner: this.winner, wins: this.battleWins,
    });
  }

  /* ---------- shop: only ever opens before a battle ---------- */
  openShop() {
    this._setState('shop');
    this.shopQueue = [];
    for (let i = 0; i < this.players.length; i++) if (this.players[i].alive) this.shopQueue.push(i);
    this.currentId = this.shopQueue.length ? this.players[this.shopQueue[0]].id : -1;
    this.aiTimer = this.currentShopBuyerIsCpu() ? 45 + Math.floor(this.rand() * 40) : 0;
    this._emitShopBuyer();
  }
  currentShopBuyerIsCpu() {
    const idx = this.shopQueue[0];
    return idx !== undefined && !this.players[idx].human;
  }
  _emitShopBuyer() {
    if (this.shopQueue.length) {
      const p = this.players[this.shopQueue[0]];
      this.emit('shopBuyer', { playerId: p.id });
    }
  }
  endCurrentBuyer() {
    if (this.state !== 'shop') return;
    this.shopQueue.shift();
    if (!this.shopQueue.length) { this.startTurn(this.firstAliveSeat()); return; }
    this.currentId = this.players[this.shopQueue[0]].id;
    this.aiTimer = this.currentShopBuyerIsCpu() ? 45 + Math.floor(this.rand() * 40) : 0;
    this._emitShopBuyer();
  }

  buy(pid, entryId) {
    if (this.state !== 'shop') return false;
    const p = this.players[pid];
    if (!p || !p.alive) return false;
    if (this.shopQueue[0] !== pid) return false;    // only the current buyer shops
    const w = SE.weaponById(entryId);
    const soldWeapon = w && !w.hidden && w.price > 0 ? w : null;
    const item = SE.itemById(entryId);
    const entry = soldWeapon || item;
    if (!entry) return false;
    if (p.money < entry.price) return false;
    p.money -= entry.price;
    if (soldWeapon) {
      p.ammo[entryId] = (p.ammo[entryId] || 0) + entry.count;
    } else {
      if (entryId === 'parachute') p.para = Math.min(3, p.para + 1);
      if (entryId === 'shield') p.shield = true;
    }
    this.emit('buy', { playerId: pid, id: entryId, kind: soldWeapon ? 'weapon' : 'item' });
    return true;
  }

  addMoney(p, amt, reason) {
    p.money += amt;
    this.emit('money', { playerId: p.id, amount: amt, reason: reason });
  }

  /* ---------- turns ---------- */
  startTurn(idx) {
    if (idx < 0 || !this.players[idx] || !this.players[idx].alive) {
      idx = this.firstAliveSeat();
      if (idx < 0) { this._endOfBattle(); return; }
    }
    const p = this.players[idx];
    this.turnIdx = idx;
    this.currentId = p.id;
    p.shield = false;   // a shield covers everyone else's shots, it fades as
                       // your own turn begins — "lasts one round", never forever
    this._setState('aim');
    this.wind = Math.round((this.rand() * 2 - 1) * CFG.WIND_MAX * 10) / 10;

    // First turn on this battlefield gets a sensible default aim.
    // After that the player's own angle/power are KEPT for the next turn —
    // fine corrections are how artillery is actually played.
    if (p.needsAim) {
      let nearest = null, nd = Infinity;
      for (const q of this.players) {
        if (q.id === p.id || !q.alive) continue;
        const d = Math.abs(q.x - p.x);
        if (d < nd) { nd = d; nearest = q; }
      }
      p.angle = nearest && nearest.x < p.x ? 125 : 55;
      p.power = 55;
      p.needsAim = false;
    }
    if (!(p.ammo[p.selected] > 0)) p.selected = 'basic';

    this.emit('wind', { wind: this.wind });
    this.emit('turnStart', { playerId: p.id });
    if (!p.human) this.aiTimer = 55 + Math.floor(this.rand() * 55);
  }

  _beginRound() {   // every player has shot — a new turn-cycle starts
    this.round++;
    this.emit('round', { round: this.round, battle: this.battle });
    if (this.round >= CFG.STORM_FROM_ROUND) {
      const dmg = Math.min(CFG.STORM_DAMAGE_MAX,
        CFG.STORM_DAMAGE_BASE + (this.round - CFG.STORM_FROM_ROUND) * CFG.STORM_DAMAGE_STEP);
      this.emit('storm', { damage: dmg });
      for (const p of this.players) {
        if (p.alive) this.damage(p, dmg, null, 'storm');
      }
      if (this.aliveCount() <= 1) { this._endOfBattle(); return; }
    }
    this.startTurn(this.firstAliveSeat());
  }

  aimTo(pid, angle, power) {
    const p = this.players[pid];
    if (!p || this.currentId !== pid) return;
    p.angle = U.clamp(angle, 0, 180);
    p.power = U.clamp(power, 1, 100);
    this.emit('aim', { playerId: pid, angle: p.angle, power: p.power });
  }
  selectWeapon(pid, weaponId) {
    const p = this.players[pid];
    if (!p || this.currentId !== pid) return;
    if (weaponId !== 'basic' && !(p.ammo[weaponId] > 0)) weaponId = 'basic';
    p.selected = weaponId;
    this.emit('aimWeapon', { playerId: pid, weaponId: weaponId });
  }

  fire() {
    if (this.state !== 'aim') return;
    const p = this.current();
    if (!p) return;
    let weaponId = p.selected;
    if (weaponId !== 'basic') {
      if (p.ammo[weaponId] > 0) p.ammo[weaponId]--;
      else weaponId = 'basic';
    }
    const def = SE.weaponById(weaponId);
    const speed = SE.Weapons.speedOf(def, p.power);
    const px = p.x + Math.cos(p.angle * DEG) * CFG.BARREL_LEN;
    const py = (p.y - CFG.TANK_H + 3) - Math.sin(p.angle * DEG) * CFG.BARREL_LEN;
    this.projectiles.push(SE.Weapons.create(weaponId, px, py, p.angle, speed, p.id));
    p.shots++;
    // remember what this shot WAS — smarter AI and shot-mirroring depend on it
    p.lastShot = { angle: p.angle, power: p.power, weaponId: weaponId };
    this._setState('flight');
    this.emit('fire', { playerId: p.id, weaponId: weaponId, x: px, y: py, angle: p.angle });
    this.emit('fx', { kind: 'muzzle', x: px, y: py, angle: p.angle });
  }

  /* ---------- movement: fuel-limited, never up a steep climb ---------- */
  moveTank(dir) {
    if (this.state !== 'aim') return false;
    const p = this.current();
    if (!p || p.falling || p.fuel <= 0) return false;
    const nx = U.clamp(p.x + dir, 10, CFG.W - 10);
    if (nx === p.x) return false;
    const hw = CFG.TANK_W / 2 - 2;
    const gy = this.terrain.supportY(nx - hw, nx + hw);
    if (gy < p.y - CFG.CLIMB_MAX) return false;    // the climb is too steep
    p.x = nx;
    p.fuel--;
    if (gy > p.y + CFG.CLIMB_MAX) {                 // walked off an edge → fall
      p.falling = true; p.vy = 0; p.fallStartY = p.y;
    } else if (gy !== p.y) {
      p.y = gy;
    }
    this.emit('moved', { playerId: p.id, fuel: p.fuel });
    return true;
  }

  /* ---------- per-frame tick ---------- */
  tick() {
    if (this.aiTimer > 0) {
      this.aiTimer--;
      if (this.aiTimer === 0) {
        if (this.state === 'shop') {
          const idx = this.shopQueue[0];
          if (idx !== undefined && !this.players[idx].human) {
            const buys = SE.AI.shopPolicy(this, this.players[idx]);
            for (const id of buys) this.buy(idx, id);
            this.endCurrentBuyer();
          }
        } else if (this.state === 'aim') {
          const p = this.current();
          if (p && !p.human) {
            const shot = SE.AI.chooseShot(this, p);
            this.aimTo(p.id, shot.angle, shot.power);
            this.selectWeapon(p.id, shot.weaponId);
            this.fire();
          }
        }
      }
    }

    switch (this.state) {
      case 'between':
        if (--this.betweenTimer <= 0) this._nextBattle(false);
        break;

      case 'shop':
      case 'aim':
        // ground is stable here; only a tank that drove off an edge may fall
        this._updateTanks();
        break;

      case 'flight':
        this._stepBlastQueue();
        this._tickBlasts(1);          // circles grow, but apply NOTHING yet
        this._stepProjectiles();
        if (!this.projectiles.length && !this.blastQueue.length) this._startResolve();
        break;

      case 'resolve':
        this._resolveTick();
        break;

      default: break;   // idle / over
    }
  }

  /* ---------- turn resolution state machine ---------- */
  _startResolve() {
    this.resPhase = 'blasts';
    this.resolveTimer = 0;
    this.tankQuiet = 0;
    this._setState('resolve');
  }

  _resolveTick() {
    this.resolveTimer++;

    if (this.resPhase === 'blasts') {
      // phase 2: circles that finished growing now damage ground + players,
      // and any ground the ammunition BUILDS (dirt bombs) is added here
      this._tickBlasts(0);
      const done = [], grow = [];
      for (const b of this.blastsActive) (b.t >= CFG.BLAST_TELEGRAPH ? done : grow).push(b);
      this.blastsActive = grow;
      for (const b of done) this.applyBlast(b);
      if (!this.blastsActive.length) {
        if (this.pendingAdds.length) {
          for (const a of this.pendingAdds) {
            this.terrain.add(a.x, a.y, a.r, a.raise);
            this.emit('fx', { kind: 'dirt', x: a.x, y: a.y, r: a.r });
          }
          this.pendingAdds = [];
        }
        this.resPhase = 'settle';
        this._settleStart();
      }
      return;
    }

    if (this.resPhase === 'settle') {
      // phase 3: the ground falls — run settling to full completion
      let quiet = true;
      for (let i = 0; i < 3 && this.settleBudget > 0; i++) {
        if (this.terrain.settleStep()) quiet = false;
        this.settleBudget--;
      }
      if ((quiet && this.settleBudget > 0) || this.settleBudget <= 0) {
        this.resPhase = 'tanks';
        this.tankQuiet = 0;
      }
      return;
    }

    if (this.resPhase === 'tanks') {
      // phase 4: tanks fall if their ground went, then fall damage
      this._updateTanks();
      let anyFalling = false;
      for (const p of this.players) if (p.alive && p.falling) anyFalling = true;
      if (!anyFalling) this.tankQuiet++; else this.tankQuiet = 0;
      if (this.tankQuiet >= 15 || this.resolveTimer > 1500) this._turnDone();
    }
  }

  _tickBlasts(growOnly) {
    for (const b of this.blastsActive) b.t++;
  }

  /* ---------- blast telegraph: impacts create growing circles ---------- */
  _createBlast(b) {
    this.blastsActive.push({
      x: b.x, y: b.y, owner: b.owner, radius: b.radius, damage: b.damage,
      crater: b.crater, craterY: b.craterY, burn: b.burn || 0, t: 0,
    });
    if (b.owner != null && this.players[b.owner]) {
      this.players[b.owner].lastImpact = { x: b.x, y: b.y };   // feedback for next shot
    }
    this.emit('fx', { kind: 'impact', x: b.x, y: b.y, r: b.radius });
  }

  _settleStart() { this.settling = true; this.settleBudget = 500; }

  /* ---------- tanks fall when the ground under them goes ---------- */
  _updateTanks() {
    for (const p of this.players) {
      if (!p.alive) continue;
      const hw = CFG.TANK_W / 2 - 2;
      const gy = this.terrain.supportY(p.x - hw, p.x + hw);
      if (p.falling) {
        p.vy = Math.min(p.vy + CFG.FALL_GRAVITY, CFG.TERM_FALL_VY);
        if (p.paraActive) p.vy = Math.min(p.vy, CFG.PARA_VY);
        p.y += p.vy;
        if (!p.paraActive && p.para > 0 && (p.y - p.fallStartY) > CFG.PARA_MIN_FALL) {
          p.paraActive = true; p.para--;
          this.emit('fx', { kind: 'parachute', x: p.x, y: p.y });
        }
        if (p.y >= gy) {
          const rescued = p.paraActive;
          const fallDist = gy - p.fallStartY;
          p.y = gy; p.falling = false; p.vy = 0; p.paraActive = false;
          this.emit('fx', { kind: 'landing', x: p.x, y: p.y });
          if (fallDist > CFG.FALL_MIN_PX) {
            const dmg = Math.round(CFG.FALL_DAMAGE_PER_PX * fallDist *
              (rescued ? CFG.PARA_RESCUE : 1));
            this.damage(p, dmg, null, 'fall');
          }
        }
      } else {
        if (gy > p.y + 1) { p.falling = true; p.vy = 0; p.fallStartY = p.y; }
        else if (gy < p.y) p.y = gy;                 // fresh ground lifts you up
      }
    }
  }

  /* ---------- projectiles ---------- */
  _stepProjectiles() {
    const newProjs = [];
    const ctx = {
      terrain: this.terrain, tanks: this.players, wind: this.wind, W: CFG.W,
      spawn: function (defId, x, y, vx, vy, owner) {
        newProjs.push(SE.Weapons.createVelocity(defId, x, y, vx, vy, owner));
      },
    };
    const out = [];
    for (const p of this.projectiles) SE.Weapons.step(p, ctx, out);
    this.projectiles = this.projectiles.filter(function (p) { return !p.dead; })
      .concat(newProjs);
    this._applyEvents(out);
  }

  _stepBlastQueue() {
    const ready = [];
    this.blastQueue = this.blastQueue.filter(function (e) {
      e.delay--;
      if (e.delay <= 0) { ready.push(e.b); return false; }
      return true;
    });
    for (const b of ready) this._createBlast(b);   // start telegraph, apply later
  }

  _applyEvents(out) {
    for (const e of out) {
      if (e.type === 'blast') {
        if (e.delay > 0) this.blastQueue.push({ delay: e.delay, b: e });
        else this._createBlast(e);                 // telegraph only — no damage yet
      } else if (e.type === 'add') {
        // ground BUILDING is also deferred to the resolution phase, so the
        // strict order (shot → terrain changes → settling → tanks) holds
        this.pendingAdds.push({ x: e.x, y: e.y, r: e.r, raise: e.raise });
      } else if (e.type === 'direct') {
        this.emit('fx', { kind: 'direct', x: e.tank.x, y: e.tank.y - CFG.TANK_H / 2 });
        if (e.owner != null && this.players[e.owner]) {
          this.players[e.owner].lastImpact = { x: e.tank.x, y: e.tank.y };
        }
        this.damage(e.tank, CFG.DIRECT_DAMAGE, e.owner, 'direct');
      } else if (e.type === 'fx') {
        if (e.kind === 'spark' && e.owner != null && this.players[e.owner]) {
          this.players[e.owner].lastImpact = { x: e.x, y: e.y };
        }
        this.emit('fx', e);
      }
    }
  }

  /* applied only when the telegraph circle has finished growing */
  applyBlast(b) {
    this.emit('fx', { kind: 'explosion', x: b.x, y: b.y, r: b.radius, burn: b.burn });
    for (const t of this.players) {
      if (!t.alive) continue;
      const d = Math.hypot(b.x - t.x, b.y - (t.y - CFG.TANK_H / 2));
      if (d < b.radius) {
        const f = 1 - d / b.radius;
        const dmg = Math.max(1, Math.round(b.damage * f));
        this.damage(t, dmg, b.owner != null ? b.owner : null, 'blast');
      }
    }
    if (b.crater > 0) {
      const ys = b.craterY > 0 && isFinite(b.craterY) ? b.craterY : 1;
      this.terrain.dig(b.x, b.y, Math.round(b.radius * b.crater), ys);
      // settling itself only runs in the resolve/settle phase after the shot
    }
  }

  /* ---------- damage / kills ---------- */
  damage(t, amount, owner, cause) {
    if (!t.alive) return;
    if (t.shield) {
      this.emit('fx', { kind: 'shieldHit', x: t.x, y: t.y - CFG.TANK_H / 2 });
      return;
    }
    t.hp -= amount;
    if (t.hp < 0) t.hp = 0;
    this.emit('damage', { playerId: t.id, amount: amount, cause: cause, srcId: owner });
    if (t.hp <= 0) {
      t.alive = false;
      if (owner != null && owner !== t.id && this.players[owner]) {
        this.players[owner].kills++;
        this.addMoney(this.players[owner], CFG.KILL_PAY, 'kill');
      }
      this.emit('kill', { victimId: t.id, killerId: owner != null ? owner : null });
    }
  }

  _turnDone() {
    this.emit('turnEnd', { playerId: this.currentId });
    if (this.aliveCount() <= 1) { this._endOfBattle(); return; }
    let next = -1;
    for (let i = this.turnIdx + 1; i < this.players.length; i++) {
      if (this.players[i].alive) { next = i; break; }
    }
    if (next < 0) { this._beginRound(); return; }   // everyone had a turn → new round
    this.startTurn(next);
  }
}

SE.Game = Game;
})(typeof globalThis !== 'undefined' ? globalThis : this);
