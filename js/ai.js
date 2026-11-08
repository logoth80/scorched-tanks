/* =====================================================================
 * CPU PLAYERS — a real artillery brain:
 *   • simulates ballistics against terrain (sub-stepped, like the game)
 *   • REMEMBERS its previous shot and impact (shooter.lastShot /
 *     .lastImpact), then brackets the target: tight local search around
 *     what it just did, exactly how humans correct — short → more power,
 *     long → less, off-side → angle tweak
 *   • avoids landing its own blast next to itself
 *   • doesn't spend bought ammo when Basic Shot scores the same hit
 *   • prefers finishing wounded enemies; keeps bought cluster only for
 *     direct-hit chances (bomblets never explode)
 * Shop policy is a simple "when rich, buy fun" heuristic set.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});
const U = SE.util;
const CFG = SE.CONFIG;
const DEG = Math.PI / 180;

function blastRadius(def) {
  if (def.behavior === 'roll') return def.roll.explode.radius;
  if (def.behavior === 'multiblast') {
    let m = 0; for (const b of def.blasts) m = Math.max(m, b.radius); return m;
  }
  if (def.behavior === 'fire') return def.fire.radius;      // fire pool (flows!)
  if (def.behavior === 'cluster') return 55;                // bomblets cover a wide patch
  return (def.explosion && def.explosion.radius) || 0;
}

const AI = {
  chooseShot(game, shooter) {
    const terrain = game.terrain, W = CFG.W;
    const targets = game.players.filter(function (t) { return t.alive && t.id !== shooter.id; });
    if (!targets.length) return { weaponId: 'basic', angle: 90, power: 30 };

    // pick a target: wounded prey to finish, otherwise the nearest threat
    let target = null, tBest = -Infinity;
    for (const t of targets) {
      const d = Math.hypot(t.x - shooter.x, t.y - shooter.y);
      const score = (CFG.HP - t.hp) * 6 - d;
      if (score > tBest) { tBest = score; target = t; }
    }

    let weaponId = this._pickWeapon(shooter, game, target);
    const def = SE.weaponById(weaponId);

    // like a human, the AI does NOT read the wind perfectly
    const perceivedWind = U.clamp(
      game.wind + (Math.random() * 2 - 1) * CFG.AI_WIND_BLUNDER,
      -CFG.WIND_MAX, CFG.WIND_MAX);

    const mx = shooter.x;
    const my = shooter.y - CFG.TANK_H + 3;
    const selfX = shooter.x, selfY = shooter.y - CFG.TANK_H / 2;
    const dangerR = blastRadius(def) * 0.8;
    const isThud = def.behavior === 'thud';

    const PMAX = CFG.POWER_MAX || 100;
    const cands = [];
    const self = this;
    function consider(angle, power) {
      if (angle < 2 || angle > 178 || power < 5 || power > PMAX) return;
      const res = self._simulate(terrain, W, perceivedWind, mx, my, angle,
        SE.Weapons.speedOf(def, power), def, target);
      if (!res.landed) return;
      const dLand = Math.hypot(res.x - target.x, res.y - (target.y - CFG.TANK_H / 2));
      let d = isThud ? Math.min(dLand, res.nearest) : dLand;
      // do not park our own blast on top of ourselves
      const selfD = Math.hypot(res.x - selfX, res.y - selfY);
      if (dangerR > 0 && selfD < dangerR) d += 60;
      cands.push({ angle: angle, power: power, d: d });
    }

    const prev = shooter.lastShot, lastHit = shooter.lastImpact;
    const missedRecently = prev && lastHit;
    if (missedRecently) {
      // bracketing: a fine sweep centred on the LAST shot — the correction
      // a human makes instantly ("that was short, add power")
      const da = Math.min(20, 4 + Math.abs(target.x - lastHit.x) * 0.04);
      const dp = Math.min(35, 6 + Math.abs(target.x - lastHit.x) * 0.12);
      for (let a = prev.angle - da; a <= prev.angle + da; a += 1) {
        for (let pw = prev.power - dp; pw <= prev.power + dp; pw += 2) consider(a, pw);
      }
    }
    // always keep the full-field search too, then refine the best coarse hit —
    // so terrain changes / new positions never strand the local memory
    let coarseBest = null;
    for (let angle = 15; angle <= 165; angle += 5) {
      for (let power = 35; power <= PMAX; power += 12) {
        const before = cands.length;
        consider(angle, power);
        for (let i = before; i < cands.length; i++) {
          if (!coarseBest || cands[i].d < coarseBest.d) coarseBest = cands[i];
        }
      }
    }
    if (coarseBest) {
      for (let a = coarseBest.angle - 6; a <= coarseBest.angle + 6; a += 1) {
        for (let pw = coarseBest.power - 14; pw <= coarseBest.power + 14; pw += 2) consider(a, pw);
      }
    }
    if (!cands.length) return { weaponId: 'basic', angle: 60, power: 70 };

    cands.sort(function (a, b) { return a.d - b.d; });

    // save purchased ammo when Basic would score just as well
    if (weaponId !== 'basic') {
      const bestDef = SE.weaponById('basic');
      let basicCanDoIt = false;
      for (let i = 0; i < Math.min(3, cands.length); i++) {
        const res = this._simulate(terrain, W, perceivedWind, mx, my, cands[i].angle,
          SE.Weapons.speedOf(bestDef, cands[i].power), bestDef, target);
        if (res.landed) {
          const d = Math.hypot(res.x - target.x, res.y - (target.y - CFG.TANK_H / 2));
          if (d <= cands[i].d + 25) { basicCanDoIt = true; break; }
        }
      }
      if (basicCanDoIt) weaponId = 'basic';   // never pay for what free ammo does
    }

    // aim like a person: pick among the best plans, then add real error —
    // corrections (the whole point of remembering) matter, direct hits are earned
    const top = cands.slice(0, CFG.AI_TOPK);
    const pick = top[Math.floor(Math.random() * top.length)];
    const angle = U.clamp(pick.angle + (Math.random() * 2 - 1) * CFG.AI_JITTER_ANGLE, 2, 178);
    const power = U.clamp(pick.power + (Math.random() * 2 - 1) * CFG.AI_JITTER_POWER, 10, PMAX);
    return { weaponId: weaponId, angle: angle, power: power };
  },

  _pickWeapon(shooter, game, target) {
    const owned = Object.keys(shooter.ammo).filter(function (id) {
      return shooter.ammo[id] > 0 && id !== 'basic';
    });
    if (!owned.length || Math.random() > 0.65) return 'basic';
    const pick = owned[Math.floor(Math.random() * owned.length)];
    return pick;
  },

  _simulate(terrain, W, wind, x, y, angleDeg, speed, def, target) {
    const a = angleDeg * DEG;
    let vx = Math.cos(a) * speed, vy = -Math.sin(a) * speed;
    const g = CFG.GRAVITY * (def.launch.gravityScale || 1);
    const wf = wind * CFG.WIND_ACCEL * (def.launch.windScale || 1);
    const tx = target.x, ty = target.y - CFG.TANK_H / 2;
    let nearest = Infinity;
    for (let t = 0; t < 1200; t++) {
      vy += g; vx += wf;
      if (def.launch.drag) { vx *= (1 - def.launch.drag); vy *= (1 - def.launch.drag); }
      if (def.launch.terminal && vy > def.launch.terminal) vy = def.launch.terminal;
      // sub-step like the real flight so walls are actually seen
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(vx), Math.abs(vy)) / 2));
      const sx = vx / steps, sy = vy / steps;
      let landed = false;
      for (let i = 0; i < steps; i++) {
        x += sx; y += sy;
        const nd = Math.hypot(x - tx, y - ty);
        if (nd < nearest) nearest = nd;
        if (x < -20 || x > W + 20) return { landed: false, x: x, y: y, nearest: nearest };
        if (terrain.solid(x, y)) { landed = true; break; }
      }
      if (landed) return { landed: true, x: x, y: y, nearest: nearest };
    }
    return { landed: false, x: x, y: y, nearest: nearest };
  },

  shopPolicy(game, p) {
    const buys = [];
    const money = function () { return p.money; };
    function tryBuy(id) {
      const w = SE.weaponById(id) || SE.itemById(id);
      if (w && money() >= w.price) buys.push(id);
    }
    // big / napalm / roller hit areas got much bigger — they are the core buys
    if (money() > 700 && Math.random() < 0.6) tryBuy('big');
    if (money() > 400 && Math.random() < 0.55) tryBuy('roller');
    if (money() > 500 && Math.random() < 0.5) tryBuy('napalm');
    if (money() > 800 && Math.random() < 0.25) tryBuy('cluster');
    if (money() > 500 && !p.shield && Math.random() < 0.35) tryBuy('shield');
    if (money() > 500 && p.para < 1 && Math.random() < 0.3) tryBuy('parachute');
    return buys;
  },
};

SE.AI = AI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
