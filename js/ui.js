/* =====================================================================
 * UI — DOM overlay: setup screen, shop, HUD cards, turn controls,
 * keyboard + mouse aiming, banners, event log, game-over screen.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});
const U = SE.util;
const CFG = SE.CONFIG;

const AMMO_SHORT = { basic: 'BAS', cluster: 'CLU', roller: 'ROL', napalm: 'NAP', big: 'BIG', dirt: 'DIR', leapfrog: 'LEP', funny: 'FUN' };

class UI {
  constructor() {
    this.el = {};
    const ids = ['game', 'roundLabel', 'windArrow', 'windVal', 'flagMount', 'flagCloth',
      'muteBtn', 'newGameBtn',
      'playerCards', 'log', 'turnpanel', 'tpName', 'angleVal', 'powerVal', 'fuelVal',
      'ammoRow', 'ammoPick', 'ammoPickName', 'useShieldBtn', 'shieldBag',
      'fireBtn', 'moveL', 'moveR', 'banner',
      'shopModal', 'shopTitle', 'shopMoney', 'shopItems', 'shopDone',
      'setupModal', 'seatList', 'seatCount', 'battlesInput', 'startBtn',
      'overModal', 'overTitle', 'overStats', 'againBtn', 'toSetupBtn'];
    for (const id of ids) this.el[id] = document.getElementById(id);
    this.game = null;
    this.renderer = null;
    this.seatRows = [];
    this._cardTimer = 0;
    this._ammoOpen = false;   // the ammo list is an OPEN-ON-DEMAND dropdown
    this._bindControls();   // bind input exactly once for the whole session
  }

  /* ---------------- setup screen ---------------- */
  showSetup() {
    const list = this.el.seatList;
    if (!this.seatRows.length) {
      for (let i = 0; i < CFG.MAX_PLAYERS; i++) {
        const col = SE.PLAYER_COLORS[i];
        const row = document.createElement('div');
        row.className = 'seatRow';
        row.innerHTML =
          '<span class="seatDot" style="background:' + col.main + '"></span>' +
          '<b>Seat ' + (i + 1) + '</b>' +
          '<input class="seatName" type="text" maxlength="12" placeholder="Player ' + (i + 1) + '">' +
          '<button class="seatMode" data-mode="cpu">CPU</button>';
        const modeBtn = row.querySelector('.seatMode');
        const setState = function (human) {
          modeBtn.textContent = human ? 'HUMAN' : 'CPU';
          modeBtn.dataset.mode = human ? 'human' : 'cpu';
        };
        modeBtn.addEventListener('click', function () {
          setState(modeBtn.dataset.mode !== 'human');
          SE.sfx.click();
        });
        setState(i < 2);   // default: two humans hotseat
        list.appendChild(row);
        this.seatRows.push({ row: row, name: row.querySelector('.seatName'), mode: modeBtn });
      }
      this._loadSetupPrefs();          // remember last match: players, names, CPU/human
    }
    const n = parseInt(this.el.seatCount.value, 10) || 4;
    this._applySeatCount(n);
    this.el.seatCount.addEventListener('change', () => this._applySeatCount(parseInt(this.el.seatCount.value, 10) || 4));
    this.el.setupModal.classList.remove('hidden');
    this.el.shopModal.classList.add('hidden');
    this.el.overModal.classList.add('hidden');
  }
  _applySeatCount(n) {
    n = U.clamp(n, CFG.MIN_PLAYERS, CFG.MAX_PLAYERS);
    this.el.seatCount.value = n;
    this.seatRows.forEach(function (r, i) {
      r.row.style.display = i < n ? '' : 'none';
    });
  }
  _setMode(row, human) {
    const btn = row.mode;
    btn.textContent = human ? 'HUMAN' : 'CPU';
    btn.dataset.mode = human ? 'human' : 'cpu';
  }
  /* remembered new-game setup (players count, names, human/CPU, battles) */
  _loadSetupPrefs() {
    let prefs = null;
    try { prefs = JSON.parse(localStorage.getItem('scorchtanks.setup') || 'null'); }
    catch (e) { prefs = null; }
    if (!prefs || !Array.isArray(prefs.seats)) return;
    for (let i = 0; i < this.seatRows.length; i++) {
      const s = prefs.seats[i];
      if (!s) continue;
      if (typeof s.name === 'string' && s.name) this.seatRows[i].name.value = s.name;
      this._setMode(this.seatRows[i], !!s.human);
    }
    if (prefs.battles && this.el.battlesInput) this.el.battlesInput.value = U.clamp(prefs.battles | 0, 1, 9);
    if (prefs.seatCount) this.el.seatCount.value = U.clamp(prefs.seatCount | 0, CFG.MIN_PLAYERS, CFG.MAX_PLAYERS);
  }
  _saveSetupPrefs(setup) {
    try {
      localStorage.setItem('scorchtanks.setup', JSON.stringify({
        seatCount: setup.seats.length,
        battles: setup.battles,
        seats: setup.seats,
      }));
    } catch (e) { /* private mode / no storage — not important enough to bother the player */ }
  }
  readSetup() {
    const n = U.clamp(parseInt(this.el.seatCount.value, 10) || 4, CFG.MIN_PLAYERS, CFG.MAX_PLAYERS);
    const battles = U.clamp(parseInt(this.el.battlesInput && this.el.battlesInput.value, 10) ||
      CFG.TOTAL_BATTLES, 1, 9);
    const seats = [];
    for (let i = 0; i < n; i++) {
      const r = this.seatRows[i];
      seats.push({
        human: r.mode.dataset.mode === 'human',
        name: r.name.value.trim() || null,
      });
    }
    const setup = { seats: seats, battles: battles };
    this._saveSetupPrefs(setup);       // next start opens with these settings
    return setup;
  }

  /* ---------------- attach to a game ---------------- */
  attach(game, renderer) {
    this.game = game;
    this.renderer = renderer;
    const self = this;

    game.on('state', function () { self._sync(); });
    game.on('battleStart', function (e) {
      self._battleLabel(e.battle, e.total);
      self._log('══ Battle ' + e.battle + ' of ' + e.total + ' — new battlefield, good luck! ══', 'sys');
      self._banner('BATTLE ' + e.battle + '/' + e.total, '#ffd76a', 'fresh mountains — shop first');
    });
    game.on('battleEnd', function (e) {
      const w = e.winnerId != null ? game.playerById(e.winnerId) : null;
      if (w) self._log('Battle ' + e.battle + ': ' + w.name + ' outlasts the field! All tanks paid $' +
        CFG.BATTLE_BASE_PAY + ' + $' + CFG.OUTLAST_PAY + ' per enemy outlasted', 'kill');
      else self._log('Battle ' + e.battle + ': mutual destruction — no winner, everyone still gets paid', 'sys');
    });
    game.on('round', function (e) {
      self._battleLabel(e.battle, game.totalBattles, e.round);
      self._log('— Round ' + e.round + ' —', 'sys');
      SE.sfx.chime();
    });
    game.on('storm', function (e) {
      self._log('A storm moves through — ' + e.damage + ' harm to every tank.', 'sys');
      self._banner('STORM', '#9fd0ff', 'each surviving tank takes ' + e.damage + ' harm');
      SE.sfx.death();
    });
    game.on('wind', function (e) {
      self.el.windArrow.textContent = e.wind === 0 ? '·' : (e.wind > 0 ? '→' : '←');
      self.el.windVal.textContent = Math.abs(e.wind).toFixed(1);
      self._windFlag(e.wind);
    });
    game.on('shopBuyer', function (e) { self._openShop(e.playerId); });
    game.on('buy', function (e) {
      const p = game.playerById(e.playerId);
      const def = SE.weaponById(e.id) || SE.itemById(e.id);
      self._log(p.name + ' bought ' + def.name, 'buy');
      SE.sfx.buy();
      if (!p.human) self._flashChip(p);
      self._renderShop();
      self._updateCards();
    });
    game.on('turnStart', function (e) {
      self._ammoOpen = false;            // a new turn: the ammo list starts closed
      const p = game.playerById(e.playerId);
      self._banner(p.name.toUpperCase(), p.color.main, p.human ? 'YOUR TURN' : 'thinking…');
      SE.sfx.chime();
      self._sync();
    });
    game.on('fire', function () { SE.sfx.shot(); self._sync(); });
    game.on('aim', function () { self._sync(); });
    game.on('aimWeapon', function () { self._sync(); });
    game.on('moved', function () { self._sync(); });
    game.on('fx', function (e) {
      if (e.kind === 'explosion') SE.sfx.explosion(e.r);
      else if (e.kind === 'direct') SE.sfx.hit();
      else if (e.kind === 'parachute') SE.sfx.chute();
    });
    game.on('damage', function (e) {
      const p = game.playerById(e.playerId);
      self.renderer.addFloater(p.x, p.y - 30, '-' + e.amount, 'rgba(255,120,100,ALPHA)');
      if (e.srcId != null && e.srcId >= 0) {
        const s = game.playerById(e.srcId);
        // fire burns tick every few frames — the floaters say it, don't spam the log
        if (s.id !== p.id && e.cause !== 'fall' && e.cause !== 'fire')
          self._log(s.name + ' hit ' + p.name + ' for ' + e.amount, 'hit');
      }
      SE.sfx.hit();
    });
    game.on('kill', function (e) {
      const v = game.playerById(e.victimId);
      const k = e.killerId != null ? game.playerById(e.killerId) : null;
      if (e.cause === 'fire') {
        self._log(v.name + ' drowned in burning liquid fire' + (k ? ' — lit by ' + k.name : ''), 'kill');
      } else {
        self._log(v.name + ' destroyed' + (k ? ' by ' + k.name : ''), 'kill');
      }
      self.renderer.addFloater(v.x, v.y - 40, 'KO', 'rgba(255,80,60,ALPHA)');
      SE.sfx.death();
      self._updateCards();
    });
    game.on('money', function (e) {
      const p = game.playerById(e.playerId);
      const txt = (e.amount >= 0 ? '+$' : '-$') + Math.abs(e.amount);
      self.renderer.addFloater(p.x, p.y - 38, txt, 'rgba(120,255,140,ALPHA)');
      self._updateCards();
    });
    game.on('ammoUse', function (e) {
      const p = game.playerById(e.playerId);
      self._log(p.name + ' raises a shield from the bag', 'sys');
      SE.sfx.buy();
      self._updateCards();
    });
    game.on('over', function (e) { self._showOver(e.winner, e.wins); });

    this._updateCards();
    this._cardTimer = setInterval(function () { self._updateCards(); self._syncTurnPanel(); }, 250);
  }

  detach() {
    if (this._cardTimer) clearInterval(this._cardTimer);
    this._cardTimer = 0;
    this.game = null;
  }

  _battleLabel(battle, total, round) {
    let t = 'Battle ' + battle + '/' + total;
    if (round) t += ' · Round ' + round;
    this.el.roundLabel.textContent = t;
  }

  /* ---------------- HUD cards ----------------
     The card strip is SORTED to mirror the play order dealt with this
     map — left-to-right on screen = the order the tanks actually shoot.
     Dead seats keep their place (they show where they were in the order). */
  _updateCards() {
    if (!this.game) return;
    const g = this.game;
    const wrap = this.el.playerCards;
    wrap.innerHTML = '';
    const ordered = (g.roundOrder && g.roundOrder.length === g.players.length)
      ? g.roundOrder.map(function (id) { return g.players[id]; })
      : g.players.slice();
    let ord = 0;
    for (const p of ordered) {
      ord++;
      const c = document.createElement('div');
      c.className = 'card' + (p.alive ? '' : ' dead') +
        (g.currentId === p.id ? ' active' : '');
      const ammos = [];
      for (const w of SE.shopWeapons()) {
        if (w.free) { ammos.push(AMMO_SHORT[w.id] + ' ∞'); continue; }
        const n = p.ammo[w.id] || 0;
        if (n > 0) ammos.push(AMMO_SHORT[w.id] + ' ' + n);
      }
      const extras = [];
      if (p.para > 0) extras.push('PFD ' + p.para);
      if (p.shield) extras.push('SHLD');
      else if (p.ammo && p.ammo.shield > 0) extras.push('SHLD×' + p.ammo.shield + ' in bag');
      c.innerHTML =
        '<div class="cHead"><span class="cOrd" title="shot order">' + ord + '</span>' +
        '<span class="sw" style="background:' + p.color.main + '"></span><b>' +
        this._esc(p.name) + '</b><span class="cMoney">$' + p.money + '</span></div>' +
        '<div class="bar"><i style="width:' + (p.hp / CFG.HP * 100) + '%;background:' +
        (p.hp > 50 ? '#5ad15a' : p.hp > 25 ? '#e8b62c' : '#e0453a') + '"></i></div>' +
        '<div class="bar fuel"><i style="width:' + (p.fuel / CFG.FUEL_TOTAL * 100) + '%"></i></div>' +
        '<div class="cAmmo">' + this._esc(ammos.join(' · ') || '—') +
        (extras.length ? ' · <b>' + this._esc(extras.join(' ')) + '</b>' : '') + '</div>';
      wrap.appendChild(c);
    }
  }
  _esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch];
    });
  }
  _flashChip(p) {
    this._log(p.name + ' is shopping…', 'sys');
  }

  /* ---------------- turn panel + controls ---------------- */
  _sync() {
    if (!this.game) return;
    this._syncTurnPanel();
    this._updateCards();
  }
  _syncTurnPanel() {
    if (!this.game) return;
    const tp = this.el.turnpanel;
    const g = this.game;
    if (g.state !== 'aim') { tp.classList.add('hidden'); return; }
    const p = g.current();
    if (!p) { tp.classList.add('hidden'); return; }
    tp.classList.remove('hidden');
    this.el.tpName.innerHTML = '<span style="background:' + p.color.main + '"></span>' + this._esc(p.name);
    this.el.angleVal.textContent = Math.round(p.angle) + '°';
    this.el.powerVal.textContent = Math.round(p.power);
    this.el.fuelVal.textContent = p.fuel + 'px';
    const isHuman = p.human;
    tp.classList.toggle('cpuTurn', !isHuman);
    // ammo list — an OPEN-ON-DEMAND dropdown, opened by the picker button
    const row = this.el.ammoRow;
    const bag = (p.ammo && p.ammo.shield) || 0;
    let wanted = '<button class="ammoBtn' + (p.selected === 'basic' ? ' on' : '') + '" data-wid="basic">Basic ∞</button>';
    for (const w of SE.shopWeapons()) {
      if (w.free) continue;
      const n = p.ammo[w.id] || 0;
      wanted += '<button class="ammoBtn' + (n <= 0 ? ' off' : (p.selected === w.id ? ' on' : '')) +
        '" data-wid="' + w.id + '"' + (n <= 0 ? ' disabled' : '') + '>' + w.name + ' ' + n + '</button>';
    }
    /* the shield lives IN this open list too: one click raises it right
       now — exactly the rules of the HUD button (own move, not already
       raised, bag has one) */
    if (isHuman && bag > 0 && !p.shield) {
      wanted += '<button class="ammoBtn shieldOpt" data-shield="1">Raise shield ' + bag + '</button>';
    }
    if (row.dataset.sig !== wanted) { row.dataset.sig = wanted; row.innerHTML = wanted; }
    row.classList.toggle('hidden', !this._ammoOpen);
    const selW = SE.weaponById(p.selected);
    this.el.ammoPickName.textContent = (selW ? selW.name : 'Basic') +
      (p.selected === 'basic' ? ' ∞' : ' ' + (p.ammo[p.selected] || 0));
    // shield from the bag — usable right now, during your own move
    const sb = this.el.useShieldBtn;
    sb.style.display = (isHuman && bag > 0 && !p.shield) ? '' : 'none';
    this.el.shieldBag.textContent = bag;
  }

  _bindControls() {
    const self = this;
    const canvas = this.el.game;

    /* buttons (setup + delegated turn panel) */
    document.addEventListener('click', function (ev) {
      const t = ev.target;
      if (t.dataset && t.dataset.angle !== undefined && self.game) {
        const p = self.game.current();
        if (p && p.human) self.game.aimTo(p.id, p.angle + parseFloat(t.dataset.angle), p.power);
      } else if (t.dataset && t.dataset.power !== undefined && self.game) {
        const p = self.game.current();
        if (p && p.human) self.game.aimTo(p.id, p.angle, p.power + parseFloat(t.dataset.power));
      } else if (t.dataset && t.dataset.shield !== undefined && self.game) {
        const p = self.game.current();
        if (p && p.human && !p.shield && ((p.ammo && p.ammo.shield) || 0) > 0) {
          self.game.useShield(p.id); SE.sfx.click();
          self._ammoOpen = false; self._syncTurnPanel();
        }
      } else if (t.dataset && t.dataset.wid && self.game) {
        const p = self.game.current();
        if (p && p.human) { self.game.selectWeapon(p.id, t.dataset.wid); SE.sfx.click(); self._ammoOpen = false; }
      }
    });
    this.el.fireBtn.addEventListener('click', function () {
      if (self.game && self.game.state === 'aim' && self.game.current() && self.game.current().human) {
        self.game.fire();
      }
    });
    /* ammo dropdown: the list opens only when you ask for it */
    this.el.ammoPick.addEventListener('click', function () {
      self._ammoOpen = !self._ammoOpen;
      SE.sfx.click();
      self._syncTurnPanel();
    });
    /* raise a shield from the bag — only meaningful on your own move */
    this.el.useShieldBtn.addEventListener('click', function () {
      const p = self.game && self.game.current();
      if (p && p.human) self.game.useShield(p.id);
    });
    this.el.moveL.addEventListener('click', function () { if (self.game) self.game.moveTank(-1); });
    this.el.moveR.addEventListener('click', function () { if (self.game) self.game.moveTank(1); });
    this.el.muteBtn.addEventListener('click', function () {
      SE.sfx.init();
      SE.sfx.muted = !SE.sfx.muted;
      this.textContent = SE.sfx.muted ? '🔇' : '🔊';
    });
    this.el.newGameBtn.addEventListener('click', function () {
      if (window.__dshRestartToSetup) window.__dshRestartToSetup();
    });
    this.el.shopDone.addEventListener('click', function () {
      if (self.game && self.game.state === 'shop') { self.game.endCurrentBuyer(); SE.sfx.click(); }
    });
    /* shop purchases — ONE delegated listener on the wrapper. Cards are
       rebuilt on every render; per-card listeners could go stale, which is
       exactly the "sometimes clicking does nothing" bug. The decision is
       made at CLICK time against live state. */
    this.el.shopItems.addEventListener('click', function (ev) {
      const g = self.game;
      if (!g || g.state !== 'shop') return;
      const cardEl = ev.target.closest ? ev.target.closest('.shopCard') : null;
      if (!cardEl || !cardEl.dataset.wid) return;
      const idx = g.shopQueue[0];
      const buyer = idx !== undefined ? g.players[idx] : null;
      if (!buyer || !buyer.human) return;
      if (g.buy(buyer.id, cardEl.dataset.wid)) {
        SE.sfx.buy();                    // the 'buy' event handler refreshes the modal
      } else {
        // cannot afford / already capped → say so instead of staying silent
        const m = self.el.shopMoney;
        m.classList.remove('nope');
        void m.offsetWidth;              // restart CSS flash
        m.classList.add('nope');
        m.textContent = '$' + buyer.money + ' — not enough';
        setTimeout(function () {
          if (g.state === 'shop') m.textContent = '$' + buyer.money;
          m.classList.remove('nope');
        }, 900);
        SE.sfx.deny();
      }
    });

    /* keyboard */
    window.addEventListener('keydown', function (ev) {
      if (!self.game) return;
      if (!self.el.setupModal.classList.contains('hidden')) return;
      if (!self.el.overModal.classList.contains('hidden')) return;
      const g = self.game;
      if (g.state !== 'aim') return;
      const p = g.current();
      if (!p || !p.human) return;
      const stepA = ev.shiftKey ? 5 : 1;
      const stepP = ev.shiftKey ? 5 : 2;
      switch (ev.key) {
        case 'ArrowLeft': g.aimTo(p.id, p.angle + stepA, p.power); ev.preventDefault(); break;
        case 'ArrowRight': g.aimTo(p.id, p.angle - stepA, p.power); ev.preventDefault(); break;
        case 'ArrowUp': g.aimTo(p.id, p.angle, p.power + stepP); ev.preventDefault(); break;
        case 'ArrowDown': g.aimTo(p.id, p.angle, p.power - stepP); ev.preventDefault(); break;
        case 'a': case 'A': case ',': g.moveTank(-1); break;
        case 'd': case 'D': case '.': g.moveTank(1); break;
        case ' ': g.fire(); ev.preventDefault(); break;
        default:
          if (ev.key >= '1' && ev.key <= '9') {
            const list = ['basic'].concat(SE.shopWeapons().filter(function (w) { return !w.free; }).map(function (w) { return w.id; }));
            const id = list[parseInt(ev.key, 10) - 1];
            if (id) g.selectWeapon(p.id, id);
          }
      }
    });

    /* mouse / touch aim: press-drag-release on the battlefield */
    let aiming = false;
    const toGame = function (ev) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (ev.clientX - r.left) * (CFG.W / r.width),
        y: (ev.clientY - r.top) * (CFG.H / r.height),
      };
    };
    canvas.addEventListener('pointerdown', function (ev) {
      SE.sfx.init();
      if (!self.game || self.game.state !== 'aim') return;
      const p = self.game.current();
      if (!p || !p.human) return;
      aiming = true;
      canvas.setPointerCapture(ev.pointerId);
      self._aimAt(p, toGame(ev));
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!aiming || !self.game) return;
      const p = self.game.current();
      if (p && p.human) self._aimAt(p, toGame(ev));
    });
    canvas.addEventListener('pointerup', function (ev) {
      if (!aiming || !self.game) return;
      aiming = false;
      const g = self.game;
      const p = g.current();
      if (p && p.human && g.state === 'aim' && p.power >= 5) g.fire();
    });
  }

  _aimAt(p, gp) {
    const px = p.x, py = p.y - CFG.TANK_H + 3;
    const dx = gp.x - px, dy = gp.y - py;
    const angle = U.clamp(Math.atan2(-dy, dx) * 180 / Math.PI, 0, 180);
    const dist = Math.hypot(dx, dy);
    const power = U.clamp(dist * 0.62, 3, 100);
    this.game.aimTo(p.id, angle, power);
  }

  /* ---------------- shop ---------------- */
  /* HUD wind flag — pure DOM in the topbar, so terrain and craters can
     never touch it. Length + flutter speed read the strength, mirroring
     reads the direction, and dead calm hangs the cloth down the pole. */
  _windFlag(wind) {
    const mount = this.el.flagMount, cloth = this.el.flagCloth;
    if (!mount || !cloth) return;
    const max = ((SE.CONFIG && SE.CONFIG.WIND_MAX) || 12);
    const mag = Math.min(1, Math.abs(wind) / max);
    const calm = mag < 0.04;
    mount.style.transform =
      (wind < 0 ? 'scaleX(-1) ' : '') + (calm ? 'rotate(84deg)' : 'rotate(0deg)');
    cloth.style.width = (calm ? 6 : Math.round(7 + mag * 17)) + 'px';
    cloth.style.animationDuration = (1.6 - mag * 1.25).toFixed(2) + 's';
  }

  _openShop(playerId) {
    const p = this.game.playerById(playerId);
    if (!p.human) {
      this.el.shopModal.classList.add('hidden');
      this._banner(p.name.toUpperCase(), p.color.main, 'shopping…');
      return;
    }
    this.el.shopModal.classList.remove('hidden');
    this._renderShop();
    SE.sfx.chime();
  }
  _renderShop() {
    const g = this.game;
    const idx = g.shopQueue[0];
    if (idx === undefined) { this.el.shopModal.classList.add('hidden'); return; }
    const p = g.players[idx];
    if (!p.human) { this.el.shopModal.classList.add('hidden'); return; }
    this.el.shopTitle.innerHTML = '<span style="background:' + p.color.main + '"></span>' +
      this._esc(p.name) + ' — shop before battle ' + g.battle + ' of ' + g.totalBattles;
    this.el.shopMoney.textContent = '$' + p.money;
    const wrap = this.el.shopItems;
    wrap.innerHTML = '';
    function card(defHtml, canBuy, wid, free) {
      const d = document.createElement('div');
      d.className = 'shopCard' + (free ? ' free' : canBuy ? '' : ' off');
      if (!free) d.dataset.wid = wid;   // the delegated wrapper listener handles clicks
      d.innerHTML = defHtml;
      wrap.appendChild(d);
    }
    for (const w of SE.shopWeapons()) {
      const owned = w.free ? '∞' : (p.ammo[w.id] || 0);
      card(
        '<b>' + this._esc(w.name) + '</b>' +
        '<div class="sDesc">' + this._esc(w.desc) + '</div>' +
        '<div class="sFoot"><span>' + (w.free ? 'free · owned ∞' : w.count + ' × · owned ' + owned) +
        '</span><span class="sPrice">$' + w.price + '</span></div>',
        !w.free && p.money >= w.price,
        w.id, !!w.free
      );
    }
    for (const it of SE.ITEMS) {
      const owned = it.id === 'parachute' ? p.para : (p.shield ? 1 : 0);
      card(
        '<b>' + this._esc(it.name) + '</b>' +
        '<div class="sDesc">' + this._esc(it.desc) + '</div>' +
        '<div class="sFoot"><span>owned ' + owned + '</span><span class="sPrice">$' + it.price + '</span></div>',
        p.money >= it.price,
        it.id, false
      );
    }
    this.el.shopDone.textContent = 'Done — pass the device on';
  }

  /* ---------------- banner + log ---------------- */
  _banner(title, color, sub) {
    const b = this.el.banner;
    b.innerHTML = '<b style="color:' + color + '">' + this._esc(title) + '</b><span>' + this._esc(sub) + '</span>';
    b.classList.remove('fade');
    void b.offsetWidth;           // restart CSS animation
    b.classList.add('fade');
  }
  _log(text, kind) {
    const l = this.el.log;
    const d = document.createElement('div');
    d.className = 'logLine ' + (kind || '');
    d.textContent = text;
    l.appendChild(d);
    while (l.childNodes.length > 7) l.removeChild(l.firstChild);
  }

  /* ---------------- game over — the match scoreboard ---------------- */
  _showOver(winnerId, wins) {
    const g = this.game;
    const w = winnerId != null ? g.playerById(winnerId) : null;
    this.el.overTitle.textContent = w
      ? w.name + ' wins the match ' + (wins[winnerId] || 0) + '–' +
        (g.totalBattles - (wins[winnerId] || 0)) + ' battles!'
      : 'No one left standing — draw!';
    let rows = '';
    const order = g.players.map(function (p, i) { return i; }).sort(function (a, b) {
      return (wins[b] || 0) - (wins[a] || 0) || g.players[b].kills - g.players[a].kills;
    });
    for (const i of order) {
      const p = g.players[i];
      rows += '<div class="oRow"><span style="background:' + p.color.main + '"></span>' +
        this._esc(p.name) + ' — <b>' + (wins[i] || 0) + ' battle' + ((wins[i] || 0) === 1 ? '' : 's') +
        ' won</b>, ' + p.kills + ' kill' + (p.kills === 1 ? '' : 's') +
        ', ' + p.shots + ' shots, $' + p.money + '</div>';
    }
    this.el.overStats.innerHTML = rows;
    this.el.overModal.classList.remove('hidden');
    this.el.turnpanel.classList.add('hidden');
    this.el.shopModal.classList.add('hidden');
  }
}

SE.UI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
