/* =====================================================================
 * CPU PLAYERS — aim by sampling a coarse trajectory grid against terrain,
 * keep the best impacts, then add human-like jitter. Shop policy is a
 * simple set of "when rich, buy fun" heuristics.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});
const U = SE.util;
const CFG = SE.CONFIG;
const DEG = Math.PI / 180;

const AI = {
  chooseShot(game, shooter) {
    const terrain = game.terrain, W = CFG.W;
    const targets = game.players.filter(function (t) { return t.alive && t.id !== shooter.id; });
    if (!targets.length) return { weaponId: 'basic', angle: 90, power: 30 };
    targets.sort(function (a, b) { return Math.abs(a.x - shooter.x) - Math.abs(b.x - shooter.x); });
    const target = targets[Math.floor(Math.random() * Math.min(2, targets.length))];

    // choose a purchased weapon sometimes
    let weaponId = 'basic';
    const owned = Object.keys(shooter.ammo).filter(function (id) {
      return shooter.ammo[id] > 0 && id !== 'basic';
    });
    if (owned.length && Math.random() < 0.65) {
      weaponId = owned[Math.floor(Math.random() * owned.length)];
    }
    const def = SE.weaponById(weaponId);

    const px = CFG.BARREL_LEN;
    const mx = shooter.x + 0, my = shooter.y - CFG.TANK_H + 3;

    let best = null;
    const cands = [];
    for (let angle = 15; angle <= 165; angle += 5) {
      for (let power = 35; power <= 100; power += 12) {
        const res = this._simulate(terrain, W, game.wind, mx, my, angle,
          Weapons_speed(def, power), def);
        if (!res.landed) continue;
        const d = Math.hypot(res.x - target.x, res.y - (target.y - CFG.TANK_H / 2));
        cands.push({ angle: angle, power: power, d: d });
        if (!best || d < best.d) best = { angle: angle, power: power, d: d };
      }
    }
    if (!best) return { weaponId: weaponId, angle: 60, power: 70 };

    // pick randomly among the best few, then jitter
    cands.sort(function (a, b) { return a.d - b.d; });
    const top = cands.slice(0, 5);
    const pick = top[Math.floor(Math.random() * top.length)];
    const angle = U.clamp(pick.angle + (Math.random() * 2.4 - 1.2), 2, 178);
    const power = U.clamp(pick.power + (Math.random() * 6 - 3), 10, 100);
    return { weaponId: weaponId, angle: angle, power: power };
  },

  _simulate(terrain, W, wind, x, y, angleDeg, speed, def) {
    const a = angleDeg * DEG;
    let vx = Math.cos(a) * speed, vy = -Math.sin(a) * speed;
    const g = CFG.GRAVITY * (def.launch.gravityScale || 1);
    const wf = wind * CFG.WIND_ACCEL * (def.launch.windScale || 1);
    for (let t = 0; t < 1200; t++) {
      vy += g; vx += wf; x += vx; y += vy;
      if (x < -20 || x > W + 20) return { landed: false, x: x, y: y };
      if (terrain.solid(x, y)) return { landed: true, x: x, y: y };
    }
    return { landed: false, x: x, y: y };
  },

  shopPolicy(game, p) {
    const buys = [];
    const money = function () { return p.money; };
    function tryBuy(id) {
      const w = SE.weaponById(id) || SE.itemById(id);
      if (w && money() >= w.price) buys.push(id);
    }
    if (money() > 700 && Math.random() < 0.55) tryBuy('big');
    if (money() > 600 && Math.random() < 0.45) tryBuy('cluster');
    if (money() > 400 && Math.random() < 0.5) tryBuy('roller');
    if (money() > 500 && Math.random() < 0.4) tryBuy('napalm');
    if (money() > 500 && !p.shield && Math.random() < 0.35) tryBuy('shield');
    if (money() > 500 && p.para < 1 && Math.random() < 0.3) tryBuy('parachute');
    return buys;
  },
};

function Weapons_speed(def, power) {
  return SE.Weapons.speedOf(def, power);
}

SE.AI = AI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
