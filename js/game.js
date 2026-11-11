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
 *   TURN RESOLUTION ORDER (strict, per the design):
 *   1. the shot resolves (every projectile finishes; blast circles are
 *      shown GROWING from each impact — no damage yet)
 *   2. once all circles finish growing: damage to players (a tank FULLY
 *      inside the circle takes the weapon's FULL hit points; a tank
 *      carrying a shield eats the FIRST hit and loses the shield) + the
 *      circle's ground is destroyed
 *   3. the ground falls (settling runs to completion — visibly, slowly)
 *   4. tanks fall if their ground went, then fall damage is applied
 *   5. while liquid fire still burns the game WAITS — the next player
 *      only starts once the fire has vanished (FIRE_WAIT_MAX cap)
 *   ... only then does the next turn (or the next battle) begin.
 *
 *   WHO PLAYS WHEN: the play order is DEALT (shuffled) when a new map
 *   spawns and stays FIXED for that whole fight — dead tanks are skipped,
 *   and the next battle's fresh map re-deals it. Spawn slots are likewise
 *   dealt to random seats per battle. CPU seats draw one-off nicknames
 *   from names.js that last the whole match.
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

    // CPU seats draw unique nicknames from names.js (js/names.js), shuffled
    // with THIS game's seed — a nickname lasts for the whole match.
    const nameBag = this._shuffle((SE.NAMES && SE.NAMES.length) ? SE.NAMES : null);
    let nameAt = 0;

    this.players = this.seats.map(function (s, i) {
      const col = SE.PLAYER_COLORS[i % SE.PLAYER_COLORS.length];
      const nick = !s.human && nameBag.length ? nameBag[nameAt++ % nameBag.length] : null;
      return {
        id: i, name: s.name || (s.human ? 'Player ' + (i + 1) : (nick || 'CPU ' + (i + 1))),
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
    this.roundOrder = [];        // the fight's play order — dealt per new map, fixed in-battle
    this.turnPtr = 0;            // position inside roundOrder for the current cycle
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
    this.battleEnded = false;
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
  _shuffle(list) {  // Fisher–Yates with THIS game's seeded RNG
    const a = (list || []).slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
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
    this.terrain.clearFire();
    this.round = 0;
    this.roundOrder = [];
    this.wind = 0;
    this.projectiles = [];
    this.blastQueue = [];
    this.blastsActive = [];
    this.pendingAdds = [];
    this.pendingFissures = [];
    this.settling = false;
    this.resPhase = null;
    this.battleEnded = false;
    this.battleDeathSeq = 0;              // kill ORDER this battle (for outlast pay)
    for (const p of this.players) {
      p.alive = true; p.hp = CFG.HP; p.fuel = CFG.FUEL_TOTAL;
      p.x = 0; p.y = 0; p.vy = 0; p.falling = false; p.paraActive = false;
      p.shield = false; p.deathRank = 0; p._fireAcc = 0;
      p.needsAim = true;                 // fresh battlefield: aim defaults again,
      p.lastShot = null; p.lastImpact = null;  // but bought ammo + selection stay
    }
    this.placeTanks();
    // turn order is DEALT when a new map spawns — it stays fixed for the
    // whole fight and is re-dealt only when the next battle generates terrain
    this._dealTurnOrder();
    this.emit('battleStart', { battle: this.battle, total: this.totalBattles, first: !!first });
    this.openShop();
  }

  placeTanks() {
    // Slot placement: each tank lives in its own 1/n slice of the map with
    // bounded jitter, so NO TWO TANKS can ever spawn touching each other,
    // whatever the RNG does. Min separation = W/n − 2·jitter (≥ 90 px even
    // for 8 players — tanks are 26 px wide).
    // WHICH seat gets WHICH slot is re-shuffled every battle — seat 1 is
    // not "always the left one".
    const n = this.players.length;
    const seats = this._shuffle(this.players.map(function (p) { return p.id; }));
    const step = CFG.W / n;
    const jit = Math.min(60, (step - 90) / 2);
    for (let i = 0; i < n; i++) {
      const p = this.players[seats[i]];
      const center = step * (i + 0.5);
      const w = Math.max(4, Math.floor(jit) - 3);   // random centre stays inside the jitter budget
      let placed = false;
      const want = center + (this.rand() * 2 - 1) * w;
      // search only ±3 px around the wanted spot — total drift from the slot
      // centre never exceeds jit, so pair separation stays ≥ 90 px by design
      const scan = (tol) => {
        for (let off = 0; off <= 3; off++) {
          for (const sgn of (off === 0 ? [1] : [1, -1])) {
            const x = U.clamp(Math.round(want + sgn * off), 20, CFG.W - 20);
            const gy = this.terrain.top(x);
            if (Math.abs(this.terrain.top(x - 9) - gy) > tol ||
                Math.abs(this.terrain.top(x + 9) - gy) > tol) continue;
            p.x = x; p.y = gy; placed = true;
            return;
          }
        }
      };
      scan(3);
      if (!placed) scan(8);          // second tier: accept a mild slope; tanks
      if (!placed) scan(20);         // settle to stable ground on their first physics tick
      if (!placed) {                 // last resort: slot centre (still guaranteed apart)
        p.x = U.clamp(Math.round(center), 20, CFG.W - 20);
        p.y = this.terrain.top(p.x);
      }
    }
  }

  _endOfBattle() {
    if (this.battleEnded) return;          // idempotent — fire/storm can kill too
    this.battleEnded = true;
    const alive = this.players.filter(function (p) { return p.alive; });
    const winnerId = alive.length === 1 ? alive[0].id : null;
    if (winnerId != null) this.battleWins[winnerId]++;
    // every tank is paid for surviving the battle: a base amount, plus a
    // bonus for EACH enemy it outlasted (whoever died before it did).
    // Tanks alive at the end outlast everyone who died; co-survivors tie.
    for (const p of this.players) {
      const rank = p.alive ? this.battleDeathSeq + 1 : (p.deathRank || 0);
      let outlasted = 0;
      for (const q of this.players) {
        if (q.id === p.id) continue;
        const qr = q.alive ? this.battleDeathSeq + 1 : (q.deathRank || 0);
        if (qr < rank) outlasted++;
      }
      this.addMoney(p, CFG.BATTLE_BASE_PAY + CFG.OUTLAST_PAY * outlasted, 'battle');
    }
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
    if (!this.shopQueue.length) { this._startCycle(); return; }
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
      if (entryId === 'shield') {
        // the first shield bought goes up at once; ANY FURTHER ones sit in
        // the bag — useShield() fires them during your own move
        p.ammo.shield = (p.ammo.shield || 0) + 1;
        if (!p.shield) this._useStoredShield(p);
      }
    }
    this.emit('buy', { playerId: pid, id: entryId, kind: soldWeapon ? 'weapon' : 'item' });
    return true;
  }

  addMoney(p, amt, reason) {
    p.money += amt;
    this.emit('money', { playerId: p.id, amount: amt, reason: reason });
  }

  /* ---------- shields from the bag ---------- */
  _useStoredShield(p) {
    if (!(p.ammo && p.ammo.shield > 0) || p.shield) return false;
    p.ammo.shield--;
    p.shield = true;
    this.emit('fx', { kind: 'shieldOn', x: p.x, y: p.y - CFG.TANK_H / 2, owner: p.id });
    return true;
  }

  /* use a stored shield during YOUR OWN move (aim phase) */
  useShield(id) {
    const p = this.players[id];
    if (!p || !p.alive || this.state !== 'aim' || this.currentId !== id) return false;
    if (!this._useStoredShield(p)) return false;
    this.emit('ammoUse', { playerId: id, id: 'shield' });
    return true;
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

  _beginRound() {   // every player has shot — the SAME order starts over
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
    this._startCycle();
  }

  /* The play order is dealt EXACTLY ONCE PER MAP (_nextBattle shuffles the
     seats). It never changes during a fight — dead tanks are simply skipped
     — and only the next battle's fresh map re-deals it. */
  _dealTurnOrder() {
    this.roundOrder = this._shuffle(this.players.map(function (p) { return p.id; }));
    this.turnPtr = 0;
  }

  _startCycle() {   // next turn-cycle: start again from the head of that order
    this.turnPtr = 0;
    if (!this._takeNextTurn()) this.startTurn(this.firstAliveSeat());
  }

  /* step from turnPtr to the NEXT ALIVE seat in the fixed order */
  _takeNextTurn() {
    const ps = this.players;
    for (let i = this.turnPtr; i < this.roundOrder.length; i++) {
      const id = this.roundOrder[i];
      if (ps[id].alive) { this.turnPtr = i; this.startTurn(id); return true; }
    }
    return false;
  }

  aimTo(pid, angle, power) {
    const p = this.players[pid];
    if (!p || this.currentId !== pid) return;
    p.angle = U.clamp(angle, 0, 180);
    p.power = U.clamp(power, 1, CFG.POWER_MAX || 100);
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
        if (this.state === 'aim') this._tickFire();   // liquid fire burns in real time
        break;

      case 'flight':
        this._tickFire();
        this._stepBlastQueue();
        this._tickBlasts(1);          // circles grow, but apply NOTHING yet
        this._stepProjectiles();
        if (!this.projectiles.length && !this.blastQueue.length) this._startResolve();
        break;

      case 'resolve':
        this._tickFire();
        this._resolveTick();
        break;

      default: break;   // idle / over
    }
  }

  /* ---------- liquid fire hazard (napalm): flows, burns, hurts ---------- */
  _tickFire() {
    const T = this.terrain;
    if (!T.hasFire()) return;
    T.stepFire();
    const hw = CFG.TANK_W / 2;
    for (const t of this.players) {
      if (!t.alive) { t._fireAcc = 0; continue; }
      let best = 0, bestX = -1;
      for (let x = Math.max(0, (t.x - hw) | 0); x <= Math.min(CFG.W - 1, (t.x + hw) | 0); x++) {
        if (T.fire[x] > best) { best = T.fire[x]; bestX = x; }
      }
      if (best < 0.6) { t._fireAcc = 0; continue; }
      const owner = bestX >= 0 && T.fireOwner[bestX] >= 0 ? T.fireOwner[bestX] : null;
      /* DROWNING KILLS — but ONLY when the tank is genuinely trapped in
         deep fluid "between high walls". Deep fluid flowing OVER a tank on
         open ground never instant-kills: it only stings, slow and mild. */
      if (best >= CFG.TANK_H && this._inFirePit(t)) {
        this.damage(t, 9999, owner, 'fire');
        t._fireAcc = 0;
      } else {
        t._fireAcc = (t._fireAcc || 0) + 1;
        if (t._fireAcc % CFG.FIRE_TICK === 0) this.damage(t, CFG.FIRE_DOT, owner, 'fire');
      }
    }
    if (this.aliveCount() <= 1) this._endOfBattle();   // fire can end the battle
  }

  /* Is the tank standing in a genuine ground PIT — its own floor at least
     FIRE_PIT_RISE px lower than ground on BOTH sides within FIRE_PIT_WIN?
     That is what "between high walls" means; only then can fluid drown it. */
  _inFirePit(t) {
    const T = this.terrain;
    const x0 = Math.round(t.x), hw = CFG.TANK_W / 2 + 4;
    const gy = T.top(x0);
    const win = CFG.FIRE_PIT_WIN, rise = CFG.FIRE_PIT_RISE;
    let wallL = false, wallR = false;
    for (let x = Math.max(0, x0 - win); x <= x0 - hw && !wallL; x++)
      if (T.top(x) <= gy - rise) wallL = true;
    for (let x = Math.min(CFG.W - 1, x0 + win); x >= x0 + hw && !wallR; x--)
      if (T.top(x) <= gy - rise) wallR = true;
    return wallL && wallR;
  }

  /* ---------- turn resolution state machine ---------- */
  _startResolve() {
    this.resPhase = 'blasts';
    this.resolveTimer = 0;
    this.tankQuiet = 0;
    this.burnWait = 0;
    this.fissureStage = [];
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
        if (this.pendingFissures.length) {
          /* Fissure Bomb: the impact FIRES LIGHTNING-BOLT TUNNELS through
             the solid ground — a branching web of empty spaces forms under
             a surface that (mostly) keeps standing, holding its drama… */
          this.fissureStage = [];
          for (const fr of this.pendingFissures) {
            const f = fr.spec;
            const salt = (fr.x | 0) ^ ((this.battleNo || 0) * 0x9e37);
            const gy = Math.min(CFG.H - 2, this.terrain.top(fr.x) + 2);
            this.terrain.lightning(fr.x, gy, f, salt);
            for (let i = -2; i <= 2; i++)
              this.emit('fx', { kind: 'spark', x: fr.x + i * f.reach * 0.45, y: gy + f.depth * 0.25 });
            this.fissureStage.push({ x: fr.x, owner: fr.owner, spec: f });
          }
          this.pendingFissures = [];
          this.resPhase = 'fissureWait';
          this.fissureWait = 0;
          return;
        }
        this.resPhase = 'settle';
        this._settleStart();
      }
      return;
    }

    if (this.resPhase === 'fissureWait') {
      /* …one full second of ground hanging over its brand-new hollows.
         Then GRAVITY RESUMES: the settle phase is the exact one any blast
         uses, so the ground collapses down into the voids and the tanks
         phase that follows drops any tank whose floor went lower. */
      this.fissureWait++;
      let need = 0;
      for (const s of this.fissureStage) need = Math.max(need, s.spec.delay || 60);
      if (this.fissureWait >= (need || 60)) {
        for (const s of this.fissureStage) {
          this.emit('fx', { kind: 'thud', x: s.x, y: this.terrain.top(s.x) });
          if (s.owner != null && this.players[s.owner]) {
            this.players[s.owner].lastImpact = { x: s.x, y: this.terrain.top(s.x) };
          }
        }
        this.fissureStage = [];
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
      if (this.tankQuiet >= 15 || this.resolveTimer > 1500) {
        // NEXT PLAYER waits until the burning ground has vanished completely
        // (the fire keeps flowing + hurting the whole time; hard-capped)
        if (this.resolveTimer <= 1500 && this.terrain.hasFire()) {
          this.resPhase = 'burn';
          this.burnWait = 0;
        } else {
          this._turnDone();
        }
      }
      return;
    }

    if (this.resPhase === 'burn') {
      // phase 5 (only while ground is on fire): the fire ticks in tick()
      this.burnWait++;
      if (!this.terrain.hasFire() || this.burnWait >= (CFG.FIRE_WAIT_MAX || 600)) this._turnDone();
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

  _settleStart() { this.settling = true; this.settleBudget = 4000; }

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
        else {
          // ground rose IN THE TANK'S OWN COLUMN (dirt bombs etc.). A tank the
          // terrain fully COVERS does not teleport up onto it — the earth
          // buries it, and a shield buys you nothing down there. Ground that
          // merely rises under it (not over its head) carries it up. A mound
          // beside the tank never moves it — support loss is handled above.
          const tc = this.terrain.top(p.x);
          if (tc < p.y) {
            if (tc <= p.y - CFG.TANK_H + 2) {
              p.shield = false;
              this.damage(p, CFG.HP, null, 'buried');
              continue;
            }
            p.y = tc;
          }
        }
      }
    }
  }

  /* ---------- projectiles ---------- */
  _stepProjectiles() {
    const newProjs = [];
    const ctx = {
      terrain: this.terrain, tanks: this.players, wind: this.wind, W: CFG.W,
      rand: this.rand,   // weapons that scatter (Funny Bomb) draw from the match RNG
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
      } else if (e.type === 'fissure') {
        // ground TEARING is deferred exactly like digging and building —
        // the crack opens at resolution, never mid-flight
        this.pendingFissures.push({ x: e.x, y: e.y, owner: e.owner, spec: e.spec });
      } else if (e.type === 'fire') {
        // liquid fire pours immediately — it is a flowing hazard, not a dig
        this.terrain.addFire(e.x, e.radius, e.depth, e.life, e.owner);
      } else if (e.type === 'direct') {
        this.emit('fx', { kind: 'direct', x: e.tank.x, y: e.tank.y - CFG.TANK_H / 2 });
        if (e.owner != null && this.players[e.owner]) {
          this.players[e.owner].lastImpact = { x: e.tank.x, y: e.tank.y };
        }
        if (e.def && e.def.behavior === 'fire' && e.def.fire) {
          // a napalm canister that hits a tank still pours its burning fluid
          const f = e.def.fire;
          this.terrain.addFire(e.tank.x, f.radius, f.depth, f.life, e.owner);
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
    const hw = CFG.TANK_W / 2;
    for (const t of this.players) {
      if (!t.alive) continue;
      const top = t.y - CFG.TANK_H;
      /* FULLY INSIDE THE CIRCLE → FULL DAMAGE. A whole tank swallowed by the
         blast eats the weapon's full hit points (Basic = 100 = dead), unless
         it is shielded this turn. Measured to the tank's FARTHEST corner. */
      const dxFar = Math.max(Math.abs(t.x - hw - b.x), Math.abs(t.x + hw - b.x));
      const dyFar = Math.max(Math.abs(top - b.y), Math.abs(t.y - b.y));
      if (Math.hypot(dxFar, dyFar) <= b.radius) {
        this.damage(t, b.damage, b.owner != null ? b.owner : null, 'blast');
        continue;
      }
      /* partially inside → scaled by how deep it sits in the circle */
      const cx = U.clamp(b.x, t.x - hw, t.x + hw);
      const cy = U.clamp(b.y, top, t.y);
      const dNear = Math.hypot(cx - b.x, cy - b.y);
      if (dNear < b.radius) {
        const f = 1 - dNear / b.radius;
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
    if (t.shield && cause !== 'buried') {
      /* a shield eats EXACTLY ONE HIT and is gone — it never eats the next
         one either. (It also fades when your own next turn begins.) */
      t.shield = false;
      this.emit('fx', { kind: 'shieldBreak', x: t.x, y: t.y - CFG.TANK_H / 2, owner: t.id });
      return;
    }
    t.hp -= amount;
    if (t.hp < 0) t.hp = 0;
    this.emit('damage', { playerId: t.id, amount: amount, cause: cause, srcId: owner });
    if (t.hp <= 0) {
      t.alive = false;
      t.deathRank = ++this.battleDeathSeq;   // when it died decides its outlast pay
      if (owner != null && owner !== t.id && this.players[owner]) {
        this.players[owner].kills++;
        this.addMoney(this.players[owner], CFG.KILL_PAY, 'kill');
      }
      this.emit('kill', { victimId: t.id, killerId: owner != null ? owner : null, cause: cause });
      this._deathFx(t);
    }
  }

  /* ---------- death effects (pluggable — "explosion" is the first kind;
     later: per-weapon death styles can pick by cause).
     A destroyed tank explodes like a NORMAL round: the Basic Shot's own
     blast — same telegraphed circle semantics (we apply it straight away,
     the wreck does not wait for the next frame), same crater, and it
     DAMAGES nearby tanks — wrecks chain. (Applied with NO owner: it is an
     exploding wreck, not a shot — the AI's ballistics memory stays honest.) */
  _deathFx(t) {
    if ((this._deathChain = (this._deathChain || 0) + 1) > 9) { this._deathChain--; return; }
    const cy = t.y - CFG.TANK_H / 2;
    const b = SE.weaponById('basic').explosion;
    this.applyBlast({ x: t.x, y: cy, radius: b.radius, damage: b.damage,
      crater: b.crater, craterY: b.craterY, owner: null });
    this._deathChain--;
    let n = 0;
    while (n < 200 && this.terrain.settleStep()) n++;
    // tanks whose support the collapse just took away settle NOW, unless the
    // resolve pipeline is mid-phase (its own tanks phase will handle them)
    const ph = this.resPhase;
    if (ph === 'blasts' || ph === 'settle' || ph === 'tanks') return;
    let guard = 0;
    for (;;) {
      this._updateTanks();
      let any = false;
      for (const p of this.players) if (p.alive && p.falling) { any = true; break; }
      if (!any || ++guard > 900) break;
    }
  }

  _turnDone() {
    this.emit('turnEnd', { playerId: this.currentId });
    if (this.aliveCount() <= 1) { this._endOfBattle(); return; }
    // the fight's order is FIXED: step past whoever just shot, skipping
    // any tank that died mid-fight — nobody ever re-rolls during a battle
    const at = this.roundOrder.indexOf(this.currentId);
    this.turnPtr = (at >= 0 ? at : this.turnPtr) + 1;
    if (this._takeNextTurn()) return;
    this._beginRound();   // everyone had a turn → storm counter, then the SAME order again
  }
}

SE.Game = Game;
})(typeof globalThis !== 'undefined' ? globalThis : this);
