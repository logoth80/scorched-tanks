/* =====================================================================
 * PROJECTILE / AMMUNITION BEHAVIORS
 * A projectile is just data; what it DOES is chosen by `def.behavior`.
 * Behaviors implemented here — new weapons from config reuse them:
 *   'explode'     fly → single blast
 *   'thud'        fly → lands with a small spark, NO explosion
 *   'cluster'     fly → split just before the apex into 3 children with
 *                 scaled-up horizontal speed (a range ladder)
 *   'roll'        fly → land → roll down the mountain → blast when stopped
 *   'multiblast'  fly → 3 staggered blasts (Big Bomb)
 *   'addground'   fly → builds a mound of dirt instead of digging (Dirt Bomb)
 *   'fire'        fly → pour liquid fire (flows downhill, burns for a while)
 *   'hop'         fly → blast → spawn child HOPPING forward → blast → … (Leap Frog)
 *   'funny'       fly → blast → 3 children in random directions that just
 *                 explode normally (Funny Bomb). Children carry a `def.fuse`
 *                 countdown: they sit still while the main blast detonates,
 *                 so the order on screen is BLAST FIRST, then the shots.
 *
 * Optional def fields honoured by the flier: `fuse` (frames to wait in
 * place before flight begins) — used to order chain weapons correctly.
 *
 * step(p, ctx, out) pushes events into `out` which the game applies:
 *   {type:'blast'|'add'|'fire'|'direct'|'fx'|'despawn'}
 * ctx = { terrain, tanks, wind, W } and ctx.spawn() adds child projectiles.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});
const U = SE.util;
const CFG = SE.CONFIG;
const DEG = Math.PI / 180;

const Weapons = {
  create(defId, x, y, angleDeg, speed, owner) {
    const def = SE.weaponById(defId);
    const a = angleDeg * DEG;
    const vx = Math.cos(a) * speed, vy = -Math.sin(a) * speed;
    return {
      def, x, y, vx, vy, prevVy: vy, t: 0,
      state: 'fly', rollT: 0, owner,
    };
  },
  createVelocity(defId, x, y, vx, vy, owner) {
    const def = SE.weaponById(defId);
    /* def.fuse: wait in place for N frames before flying — the Funny Bomb's
       firecrackers sit still while the main blast detonates, THEN scatter */
    return { def, x, y, vx, vy, prevVy: vy, t: 0, state: 'fly', rollT: 0, owner,
      fuseLeft: def.fuse || 0 };
  },

  speedOf(def, power) {
    const s = (def.launch.speedScale || 1);
    // power is on the config dial (default max 200); 100 = MAX_SPEED
    return (U.clamp(power, 1, CFG.POWER_MAX || 100) / 100) * CFG.MAX_SPEED * s;
  },

  step(p, ctx, out) {
    if (p.state === 'fly') this._fly(p, ctx, out);
    else if (p.state === 'roll') this._roll(p, ctx, out);
  },

  /* ---------------- flight ---------------- */
  _fly(p, ctx, out) {
    const def = p.def, L = def.launch;

    /* fused sub-projectile (Funny Bomb): waits for the parent blast to go
       off first — explode, THEN send the shots */
    if (p.fuseLeft > 0) { p.fuseLeft--; return; }

    // cluster fuse: split JUST BEFORE the top of the arc, into a range ladder
    if (def.behavior === 'cluster') {
      const s = def.split;
      if (p.vy < s.atVy - 0.4) p.rose = true;          // clearly still climbing
      if (p.rose && p.vy >= s.atVy) {                  // apex reached any frame now
        this._split(p, ctx, out);
        return;
      }
    }

    p.prevVy = p.vy;
    p.vy += CFG.GRAVITY * (L.gravityScale || 1);
    p.vx += ctx.wind * CFG.WIND_ACCEL * (L.windScale || 1);
    if (L.drag) { p.vx *= (1 - L.drag); p.vy *= (1 - L.drag); }
    if (L.terminal && p.vy > L.terminal) p.vy = L.terminal;  // parachute-style fall cap
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > CFG.SPEED_CLAMP) { p.vx *= CFG.SPEED_CLAMP / sp; p.vy *= CFG.SPEED_CLAMP / sp; }

    // sub-stepped movement so fast shots never tunnel through pixels
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(p.vx), Math.abs(p.vy)) / 1.4));
    const sx = p.vx / steps, sy = p.vy / steps;
    for (let i = 0; i < steps; i++) {
      p.x += sx; p.y += sy; p.t++;
      if (p.x < -30 || p.x > ctx.W + 30) { p.dead = true; out.push({ type: 'despawn', x: p.x, y: p.y }); return; }
      if (p.t > 4000) { p.dead = true; return; } // hard safety cap
      if (ctx.terrain.solid(p.x, p.y)) { this._impact(p, ctx, out); return; }
      const t = this._tankHit(p, ctx);
      if (t) { p.dead = true; out.push({ type: 'direct', tank: t, owner: p.owner, def }); return; }
    }
  },

  _tankHit(p, ctx) {
    const hw = CFG.TANK_W / 2, hh = CFG.TANK_H;
    for (const t of ctx.tanks) {
      if (!t.alive) continue;
      const own = t.id === p.owner;
      if (own && p.t < 20) continue;           // don't clip own tank at muzzle start
      const e = own ? 0 : 1.5;
      if (Math.abs(p.x - t.x) <= hw + e && p.y <= t.y + e && p.y >= t.y - hh - e) return t;
    }
    return null;
  },

  /* ---------------- impact resolution ---------------- */
  _impact(p, ctx, out) {
    const def = p.def, b = def.behavior;
    if (b === 'roll') {
      p.state = 'roll'; p.rollT = 0;
      p.vx *= 0.4; p.vy = 0;
      out.push({ type: 'fx', kind: 'thud', x: p.x, y: p.y });
      return;
    }
    p.dead = true;
    if (b === 'cluster') { // shot never peaked (fired downhill): burst at contact
      this._split(p, ctx, out);
      return;
    }
    if (b === 'thud') {   // bomblets: they interact with terrain, they never blow up
      out.push({ type: 'fx', kind: 'spark', x: p.x, y: p.y, owner: p.owner });
      return;
    }
    if (b === 'multiblast') {
      for (const bl of def.blasts) {
        out.push({
          type: 'blast', x: p.x + bl.dx, y: p.y + bl.dy, owner: p.owner,
          radius: bl.radius, damage: bl.damage, crater: bl.crater,
          craterY: bl.craterY, delay: bl.delay || 0,
        });
      }
      return;
    }
    if (b === 'addground') {
      out.push({ type: 'add', x: p.x, y: p.y, r: def.add.radius, raise: def.add.raise });
      out.push({ type: 'blast', x: p.x, y: p.y, owner: p.owner,
        radius: def.explosion.radius, damage: def.explosion.damage,
        crater: def.explosion.crater });
      return;
    }
    if (b === 'fire') {   // napalm: no blast — pour burning liquid along the ground
      out.push({ type: 'fire', x: p.x, y: p.y, owner: p.owner,
        radius: def.fire.radius, depth: def.fire.depth, life: def.fire.life });
      out.push({ type: 'fx', kind: 'fire', x: p.x, y: p.y });
      return;
    }
    if (b === 'hop') {   // Leap Frog: blast here, then hop FORWARD and blast again
      const ex = def.explosion;
      out.push({ type: 'blast', x: p.x, y: p.y, owner: p.owner,
        radius: ex.radius, damage: ex.damage, crater: ex.crater,
        craterY: ex.craterY, burn: ex.burn || 0 });
      if (def.hop && def.hop.child) {
        const dir = p.vx < 0 ? -1 : 1;    // keeps travelling its direction
        // start just above the ACTUAL surface, so the hop never drowns in the slope
        const sy = Math.min(p.y - 6, ctx.terrain.top(p.x) - 4);
        ctx.spawn(def.hop.child, p.x, sy, dir * def.hop.vx, -def.hop.vy, p.owner);
        out.push({ type: 'fx', kind: 'hop', x: p.x, y: p.y });
      }
      return;
    }
    if (b === 'funny') { // Funny Bomb: normal blast + 3 firecrackers in RANDOM directions
      const ex = def.explosion, f = def.funny;
      out.push({ type: 'blast', x: p.x, y: p.y, owner: p.owner,
        radius: ex.radius, damage: ex.damage, crater: ex.crater,
        craterY: ex.craterY, burn: ex.burn || 0 });
      const rnd = (ctx && ctx.rand) || this._seedRng(p);
      const sy = Math.min(p.y - 6, ctx.terrain.top(p.x) - 4);   // above the surface
      for (let i = 0; i < f.count; i++) {
        const a = (f.angleMin + rnd() * (f.angleMax - f.angleMin)) * DEG;
        const s = f.speedMin + rnd() * (f.speedMax - f.speedMin);
        ctx.spawn(f.child, p.x, sy, Math.cos(a) * s, -Math.sin(a) * s, p.owner);
      }
      out.push({ type: 'fx', kind: 'burst', x: p.x, y: p.y });
      return;
    }
    // default: plain explosion
    const ex = def.explosion;
    out.push({ type: 'blast', x: p.x, y: p.y, owner: p.owner,
      radius: ex.radius, damage: ex.damage, crater: ex.crater,
      craterY: ex.craterY, burn: ex.burn || 0 });
  },

  /* deterministic RNG fallback for scatter weapons (tests / bare ctx) */
  _seedRng(p) {
    let s = (((p.x | 0) * 73856093) ^ ((p.y | 0) * 19349663) ^ ((p.owner | 0) * 83492791)) >>> 0;
    const f = SE.util && SE.util.mulberry32;
    if (f) return f(s);
    return function () { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  },

  /* ---------------- cluster split: a 3-bomb RANGE LADDER -----------------
     At the last moment before the apex every bomblet keeps the parent's
     current velocity — child 1 travels the ORIGINAL trajectory, child 2 is
     boosted to land "slightly further", child 3 further again. Boosting
     horizontal speed near the apex is exactly how you lengthen a range. -- */
  _split(p, ctx, out) {
    const s = p.def.split;
    p.dead = true;
    for (let i = 0; i < s.boosts.length; i++) {
      const m = s.boosts[i];
      ctx.spawn(s.child, p.x, p.y - 2, p.vx * m, p.vy, p.owner);
    }
    out.push({ type: 'fx', kind: 'burst', x: p.x, y: p.y });
  },

  /* ---------------- roller ---------------- */
  _roll(p, ctx, out) {
    const r = p.def.roll;
    p.x += p.vx; p.t++; p.rollT++;
    const ty = ctx.terrain.top(p.x);
    p.y = ty - 1;
    const slope = (ctx.terrain.top(p.x + 5) - ctx.terrain.top(p.x - 5)) / 10;
    p.vx += slope * r.slopeAccel;
    p.vx *= r.friction;
    p.vx = U.clamp(p.vx, -r.maxSpeed, r.maxSpeed);
    if (p.rollT % 3 === 0) out.push({ type: 'fx', kind: 'rolltrail', x: p.x, y: p.y });

    const t = this._tankHit(p, ctx);
    if (t) { p.dead = true; out.push({ type: 'direct', tank: t, owner: p.owner, def: p.def }); return; }

    const dirNow = Math.sign(p.vx) || 1;
    const aheadTop = ctx.terrain.top(p.x + dirNow * 4);
    const blocked = aheadTop < p.y - 6;               // wall straight ahead
    const stopped = Math.abs(p.vx) < r.stopSpeed && Math.abs(slope) < 0.2;
    if (p.x < 3 || p.x > ctx.W - 3 || blocked || stopped || p.rollT > r.maxTime) {
      p.dead = true;
      out.push({ type: 'blast', x: p.x, y: p.y, owner: p.owner,
        radius: r.explode.radius, damage: r.explode.damage, crater: r.explode.crater });
    }
  },
};

SE.Weapons = Weapons;
})(typeof globalThis !== 'undefined' ? globalThis : this);
