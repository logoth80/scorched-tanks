/* =====================================================================
 * HEADLESS SIMULATION TEST — loads only the DOM-free engine modules and:
 *  1. terrain invariants: gen / dig / add / ALL holes collapse /
 *     slope slumping / mass conservation / wide-shallow crater scaling
 *  2. every weapon behavior (blast, cluster+small bomblet blasts, roller,
 *     multiblast, dirt-add, napalm liquid fire) + fire hazard flow/kill rules
 *  3. ammunition ↔ terrain interaction through the real turn pipeline:
 *     blast circles grow BEFORE damage, ground changes only at resolve,
 *     then settle, then tanks
 *  3.5 nicknames from names.js (unique, per-game), turn order dealt per
 *     map and fixed during a fight, spawn slots assigned to random seats
 *  4. full matches (multi-battle): shop exactly once per battle,
 *     fresh terrain+placement each battle, money/ammo carry over,
 *     storms keep matches finite
 * Run: node test/sim.js
 * ===================================================================== */
'use strict';
require('../js/config.js');
require('../js/names.js');
require('../js/terrain.js');
require('../js/weapons.js');
require('../js/ai.js');
require('../js/game.js');

const SE = globalThis.SE;
const CFG = SE.CONFIG;
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.error('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* ---------------- 1. terrain ---------------- */
console.log('[terrain]');
const terr = new SE.Terrain(CFG.W, CFG.H);
terr.generate(SE.util.mulberry32(42));
let ok = true;
for (let x = 0; x < CFG.W; x++) {
  const t = terr.tops[x];
  if (t <= 0 || t >= CFG.H) { ok = false; break; }
  if (!terr.solid(x, CFG.H - 1) || terr.solid(x, t - 1)) { ok = false; break; }
}
check('generate: sane columns, solid floor', ok);

/* OPEN BORDER: mountains must fade to low ground near the screen edges,
   and beyond the edges there is only sky — the border never stops a missile */
{
  let okE = true, worst = '';
  for (const seed of [42, 7, 77, 101]) {
    const tE = new SE.Terrain(CFG.W, CFG.H);
    tE.generate(SE.util.mulberry32(seed));
    const low = CFG.H - 140;
    if (tE.top(0) < low || tE.top(CFG.W - 1) < low) { okE = false; worst = 'seed ' + seed + ' edges too high'; }
    if (tE.solid(-3, 400) || tE.solid(CFG.W + 3, 400) || tE.solid(-3, CFG.H - 1)) { okE = false; worst = 'seed ' + seed + ' border is a wall'; }
  }
  check('map edges fade to low open ground; beyond them is sky', okE, worst);
}

const before = terr.countSolid();
terr.dig(500, terr.tops[500] + 10, 40);
check('dig removes pixels', terr.countSolid() < before);

const mid = terr.countSolid();
terr.add(200, terr.tops[200] - 20, 30, 0);
check('add creates ground', terr.countSolid() > mid);

let massBefore = terr.countSolid(), passes = 0;
while (terr.settleStep() && passes < 9000) passes++;
let maxSlope = 0;
for (let x = 0; x < CFG.W - 1; x++) maxSlope = Math.max(maxSlope, Math.abs(terr.tops[x] - terr.tops[x + 1]));
check('settling converges', passes < 9000, 'passes=' + passes);
check('final slope <= repose', maxSlope <= CFG.REPOSE, 'max=' + maxSlope);
check('settling conserves mass', terr.countSolid() === massBefore,
  terr.countSolid() + ' vs ' + massBefore);

/* every hole collapses: after settling, no column has a gap below its top */
let holes = 0;
for (let x = 0; x < CFG.W; x++) {
  for (let y = terr.tops[x]; y < CFG.H; y++) if (!terr.data[y * CFG.W + x]) holes++;
}
check('no holes remain anywhere after settling', holes === 0, 'holes=' + holes);

/* a cave with a roof: the roof must fall into the void */
const t5 = new SE.Terrain(CFG.W, CFG.H);
t5.generate(SE.util.mulberry32(5));
const cx5 = 430, top5 = t5.tops[cx5];
t5.dig(cx5, top5 + 35, 20);          // cave at depth 15 → solid roof remains
const mass5 = t5.countSolid();
const roofBefore = t5.tops[cx5];
let p5 = 0;
while (t5.settleStep() && p5 < 9000) p5++;
check('roof above a cave falls into it', t5.tops[cx5] > roofBefore,
  'top ' + roofBefore + ' → ' + t5.tops[cx5]);
check('cave collapse conserves mass', t5.countSolid() === mass5,
  t5.countSolid() + ' vs ' + mass5);

/* craterY squashes craters vertically (vertical squash factor of dig) */
function dugAmount(seed, ys) {
  const t = new SE.Terrain(CFG.W, CFG.H);
  t.generate(SE.util.mulberry32(seed));
  const cx = 600, cy = t.tops[600] + 5;
  const m0 = t.countSolid();
  t.dig(cx, cy, 40, ys);
  return m0 - t.countSolid();
}
const dugFull = dugAmount(11, 1);
const dugFlat = dugAmount(11, 0.55);
check('craterY=0.55 digs a shallower wide crater', dugFlat < dugFull * 0.75,
  'flat=' + dugFlat + ' full=' + dugFull);

/* the bug that made everything pass through terrain: fractional lookups */
{
  const t6 = new SE.Terrain(CFG.W, CFG.H);
  t6.generate(SE.util.mulberry32(42));
  const fx = 640, fy = t6.tops[640] + 12;          // deep underground, no dig here
  check('solid() sees ground at fractional coordinates',
    t6.solid(fx, fy) && t6.solid(fx + 0.4, fy + 0.6) && t6.solid(fx + 0.9, fy + 11.5));
  /* and end to end: a shell dropped on a mountain stops AT the surface */
  const t7 = new SE.Terrain(CFG.W, CFG.H);
  t7.generate(SE.util.mulberry32(42));
  const ctx7 = { terrain: t7, tanks: [], wind: 0, W: CFG.W, spawn: function () {} };
  const drop = SE.Weapons.createVelocity('basic', 300, t7.tops[300] - 60, 0, 4, null);
  const ev7 = [];
  for (let f = 0; f < 400 && !drop.dead; f++) SE.Weapons.step(drop, ctx7, ev7);
  const hit = ev7.find(function (e) { return e.type === 'blast'; });
  check('projectile stops at the real surface, not at the map bottom',
    !!hit && hit.y < t7.tops[300] + 6 && hit.y < CFG.H - 60,
    'y=' + (hit ? hit.y.toFixed(1) : 'none') + ' (floor at ' + CFG.H + ')');
}

/* the explosion circle destroys ALL ground it covers (crater = full radius) */
{
  const t8 = new SE.Terrain(CFG.W, CFG.H);
  t8.generate(SE.util.mulberry32(7));
  let px = -1;
  for (let x = 300; x < 700; x++) {
    if (t8.H - t8.tops[x] > 170) { px = x; break; }
  }
  const py = t8.tops[px] + 60;
  t8.dig(px, py, 50, 1);
  let left = 0;
  for (let dy = -46; dy <= 46; dy++) {
    for (let dx = -46; dx <= 46; dx++) {
      if (dx * dx + dy * dy <= 46 * 46 && t8.solid(px + dx, py + dy)) left++;
    }
  }
  check('a blast circle leaves NO ground inside itself', left === 0, 'leftover px=' + left);
}

/* ground FALLS at a visible, limited speed — never teleports in one frame */
{
  const t9 = new SE.Terrain(CFG.W, CFG.H);
  t9.generate(SE.util.mulberry32(8));
  t9.dig(500, t9.tops[500] + 30, 25);          // cave: roof must start sinking
  const before = t9.tops[500];
  t9.settleStep();                              // ONE pass only
  check('soil drops at most FALL_RATE px per settling pass',
    t9.tops[500] - before <= CFG.FALL_RATE, 'dropped ' + (t9.tops[500] - before) + ' px in one pass');
}

/* ---------------- 2. weapon behaviors ---------------- */
console.log('[weapons]');
function runProj(p, maxFrames) {
  const events = [], spawned = [];
  const ctx = {
    terrain: terr, tanks: [], wind: 0, W: CFG.W,
    spawn: function (id, x, y, vx, vy, o) { spawned.push(SE.Weapons.createVelocity(id, x, y, vx, vy, o)); },
  };
  for (let f = 0; f < maxFrames && !p.dead && p.state !== 'roll'; f++) SE.Weapons.step(p, ctx, events);
  return { events: events, spawned: spawned };
}

let r = runProj(SE.Weapons.create('basic', 100, 100, 45, 8, 0), 600);
check('basic produces a blast', r.events.some(function (e) { return e.type === 'blast'; }));

/* cluster: splits into a 3-bomb RANGE LADDER just before the apex.
   Flat test bed so the three impact points are measurable. */
{
  const tC = new SE.Terrain(CFG.W, CFG.H);
  for (let x = 0; x < CFG.W; x++) {
    tC.tops[x] = 500; tC.counts[x] = CFG.H - 500;
    for (let y = 500; y < CFG.H; y++) tC.data[y * CFG.W + x] = 1;
  }
  const kids = [];
  const ctxC = {
    terrain: tC, tanks: [], wind: 0, W: CFG.W,
    spawn: function (id, x, y, vx, vy, o) { kids.push({ id: id, x: x, y: y, vx: vx, vy: vy, o: o }); },
  };
  const parent = SE.Weapons.create('cluster', 100, 498, 55, 9, 0);
  const evP = [];
  for (let f = 0; f < 900 && !parent.dead; f++) SE.Weapons.step(parent, ctxC, evP);
  check('cluster splits into EXACTLY 3 bomblets just BEFORE the apex (still rising)',
    kids.length === 3 && parent.vy < 0 && parent.vy >= -0.4,
    'kids=' + kids.length + ' vy_at_split=' + (parent.vy || 0).toFixed(2));
  const S = SE.weaponById('cluster').split;
  check('children: first rides the ORIGINAL trajectory, others are boosted further',
    kids.every(function (k, i) {
      return k.id === 'clusterlet' &&
        Math.abs(k.vx - parent.vx * S.boosts[i]) < 1e-9 && Math.abs(k.vy - parent.vy) < 1e-9;
    }), JSON.stringify(kids.map(function (k) { return k.vx.toFixed(2); })));
  const hits = [];
  for (const k of kids) {
    const c = SE.Weapons.createVelocity('clusterlet', k.x, k.y, k.vx, k.vy, 0);
    const evK = [];
    for (let f = 0; f < 900 && !c.dead; f++) SE.Weapons.step(c, ctxC, evK);
    const bl = evK.find(function (e) { return e.type === 'blast'; });
    hits.push(bl ? bl.x : null);
  }
  check('the ladder lands 3 blasts in increasing range, WIDENING gaps',
    hits.every(function (h) { return h != null; }) &&
    hits[1] > hits[0] + 12 && hits[2] - hits[1] > hits[1] - hits[0],
    'hits=' + JSON.stringify(hits));
}

// slope for the roller: create one with add, then settle it
const terr2 = new SE.Terrain(CFG.W, CFG.H);
terr2.generate(SE.util.mulberry32(7));
const ctxR = { terrain: terr2, tanks: [], wind: 0, W: CFG.W, spawn: function () {} };
const roll = SE.Weapons.create('roller', 300, 100, 20, 6, 0);
const rev = [];
let rolledDistance = 0;
const x0 = roll.x;
for (let f = 0; f < 900 && !roll.dead; f++) { SE.Weapons.step(roll, ctxR, rev); if (roll.state === 'roll') rolledDistance = Math.abs(roll.x - x0); }
check('roller lands, rolls, then detonates',
  roll.dead && rev.some(function (e) { return e.type === 'blast'; }) && rolledDistance > 30,
  'dist=' + rolledDistance.toFixed(1));

r = runProj(SE.Weapons.create('big', 300, 100, 45, 8, 0), 600);
check('big bomb emits 3 staggered blasts',
  r.events.filter(function (e) { return e.type === 'blast'; }).length === 3);

r = runProj(SE.Weapons.create('dirt', 400, terr2.tops[400] - 1, 10, 3, 0), 400);
check('dirt bomb adds ground instead of digging',
  r.events.some(function (e) { return e.type === 'add'; }));

r = runProj(SE.Weapons.create('napalm', 200, 200, 45, 7, 0), 600);
check('napalm pours LIQUID FIRE — no blast, no crater, just the fire event',
  r.events.some(function (e) { return e.type === 'fire' && e.radius >= 60 && e.depth > 0 && e.life >= 240; }) &&
  !r.events.some(function (e) { return e.type === 'blast'; }),
  JSON.stringify(r.events.map(function (e) { return e.type; })));

// bomblets: they now DO detonate — in small blasts — and drift down slowly
r = runProj(SE.Weapons.create('clusterlet', 300, 100, 60, 6, 0), 600);
check('bomblets explode in SMALL blasts (area weapon again)',
  r.events.some(function (e) { return e.type === 'blast' && e.radius <= 40 && e.radius >= 12; }),
  JSON.stringify(r.events.map(function (e) { return e.type; })));

// their fall speed is capped, so bomblets DRIFT instead of dropping like stones
{
  const p = SE.Weapons.create('clusterlet', 500, 30, -90, 0, 0);
  const ctx = { terrain: terr, tanks: [], wind: 0, W: CFG.W, spawn: function () {} };
  const ev = [];
  let maxVy = 0;
  for (let f = 0; f < 400 && !p.dead; f++) { SE.Weapons.step(p, ctx, ev); maxVy = Math.max(maxVy, p.vy); }
  const term = SE.weaponById('clusterlet').launch.terminal;
  check('bomblet fall speed is capped by launch.terminal — they drift',
    term > 0 && maxVy > 1 && maxVy <= term + 1e-9, 'maxVy=' + maxVy.toFixed(3) + ' cap=' + term);
}

/* LEAP FROG: explode → HOP forward → explode → hop again → explode. */
{
  let cur = SE.Weapons.create('leapfrog', 100, 100, 45, 8, 0);
  const ids = [], blastXs = [];
  let totalBlasts = 0, guard = 0;
  while (cur && guard++ < 8) {
    const rr = runProj(cur, 900);
    ids.push(cur.def.id);
    for (const e of rr.events) if (e.type === 'blast') { totalBlasts++; blastXs.push(e.x); }
    cur = rr.spawned.length === 1 ? rr.spawned[0] : (rr.spawned.length > 1 ? null : null);
    if (rr.spawned.length > 1) { check('leap frog hops spawn exactly ONE child per stage', false, 'got ' + rr.spawned.length); break; }
  }
  check('leap frog chains exactly 3 stages (3rd one has no further hop)',
    ids.join(',') === 'leapfrog,leapfrog2,leapfrog3', ids.join(','));
  check('leap frog makes EXACTLY 3 blasts — one per stage', totalBlasts === 3, 'blasts=' + totalBlasts);
  check('every hop travels FORWARD or dies at the wall — never back, overall it marches downrange',
    blastXs.length === 3 && blastXs[1] >= blastXs[0] && blastXs[2] >= blastXs[1] &&
    blastXs[2] - blastXs[0] > 50,
    JSON.stringify(blastXs.map(function (x) { return Math.round(x); })));
}

/* FUNNY BOMB: normal blast, then 3 firecrackers in random directions. */
{
  const rr = runProj(SE.Weapons.create('funny', 300, 100, 60, 8, 0), 900);
  const launched = rr.spawned.map(function (k) { return { vx: k.vx, vy: k.vy }; });
  check('funny bomb explodes on impact itself',
    rr.events.some(function (e) { return e.type === 'blast'; }));
  check('it fires EXACTLY 3 firecrackers, launched in different directions',
    rr.spawned.length === 3 && rr.spawned.every(function (k) { return k.def.id === 'funnylet'; }) &&
    new Set(rr.spawned.map(function (k) { return k.vx.toFixed(3); })).size === 3,
    'kids=' + rr.spawned.length);
  let pops = 0;
  const kidX = [];
  for (const kid of rr.spawned) {
    const rk = runProj(kid, 900);
    pops += rk.events.filter(function (e) { return e.type === 'blast'; }).length;
    kidX.push(kid.x);
  }
  check('the firecrackers explode normally (one blast each)', pops === 3, 'pops=' + pops);
  check('they scatter over an area (random directions land apart)',
    Math.max.apply(null, kidX) - Math.min.apply(null, kidX) > 30,
    JSON.stringify(kidX.map(function (x) { return Math.round(x); })));
  // random but reproducible: same shot → same scatter; different shot → different
  const r2 = runProj(SE.Weapons.create('funny', 300, 100, 60, 8, 0), 900);
  const same = r2.spawned.length === 3 && r2.spawned.every(function (k, i) {
    return Math.abs(k.vx - launched[i].vx) < 1e-12 && Math.abs(k.vy - launched[i].vy) < 1e-12;
  });
  const r3 = runProj(SE.Weapons.create('funny', 420, 100, 60, 8, 0), 900);
  const differs = r3.spawned.length === 3 && r3.spawned.some(function (k, i) {
    return Math.abs(k.vx - launched[i].vx) > 1e-9;
  });
  check('scatter is deterministic per impact but changes with the shot', same && differs,
    'same=' + same + ' differs=' + differs);
}

// every explosive weapon clears its ENTIRE damage circle
check('all explosive weapons dig with crater factor 1.0 (full circle)',
  SE.WEAPONS.every(function (w) {
    if (w.behavior === 'explode') return w.explosion.crater >= 0.999;
    if (w.behavior === 'roll') return w.roll.explode.crater >= 0.999;
    if (w.behavior === 'multiblast') return w.blasts.every(function (b) { return b.crater >= 0.999; });
    if (w.behavior === 'hop' || w.behavior === 'funny') return w.explosion.crater >= 0.999;
    return true;   // thud / cluster parent / addground / fire: no digging blast of their own
  }));

// muzzle speed: the power dial may reach POWER_MAX; 200 = exactly 2× of 100
{
  const b = SE.weaponById('basic');
  const s100 = SE.Weapons.speedOf(b, 100), s200 = SE.Weapons.speedOf(b, 200);
  check('power 200 = 2× the muzzle speed of power 100 (POWER_MAX)',
    Math.abs(s200 - 2 * s100) < 1e-9 && CFG.POWER_MAX >= 200,
    's100=' + s100 + ' s200=' + s200);
  check('power above POWER_MAX is clamped',
    SE.Weapons.speedOf(b, 999) === s200);
}

/* ---------------- 3. turn pipeline: strict order + terrain effects ------ */
console.log('[turn pipeline]');
function seatset(n, humanAt) {
  const s = [];
  for (let i = 0; i < n; i++) s.push({ human: !!(humanAt && humanAt.includes(i)) });
  return s;
}
function bareGame(seed) {                 // 2 humans, 1 battle; seat 0 is up
  const g = new SE.Game({ seed: seed, seats: seatset(2, [0, 1]), battles: 1 });
  g.start();
  g.endCurrentBuyer();
  g.endCurrentBuyer();
  // cycle order is RANDOM now — fast-forward until it is seat 0's turn
  let guard = 0;
  while (g.currentId !== 0 && guard++ < 10) g._turnDone();
  return g;                              // state: aim, seat 0
}

/* ---------------- liquid fire hazard (napalm): flow / burn / hurt -------- */
console.log('[fire hazard]');

/* the fluid itself: it runs down the mountain, pools low, then burns out.
   The flow test uses a SETTLED map — that is what the engine presents
   after any shot — raw generation has cliff ridges that legitimately dam
   a fluid whose surface is below the ridge ground. */
{
  const T = new SE.Terrain(CFG.W, CFG.H);
  T.generate(SE.util.mulberry32(61));
  let nS = 0; while (T.settleStep() && nS++ < 9000);
  let px = -1, ptop = 1e9;
  for (let x = 150; x < 850; x++) if (T.tops[x] < ptop) { ptop = T.tops[x]; px = x; }
  T.addFire(px, 30, 12, 900, 0);
  for (let i = 0; i < 160; i++) T.stepFire();
  let spread = 0;
  for (let x = Math.max(0, px - 100); x <= Math.min(CFG.W - 1, px + 100); x++)
    if (Math.abs(x - px) >= 10) spread = Math.max(spread, T.fire[x]);
  check('liquid fire runs DOWN the mountain away from its pour point',
    spread >= 1 && T.fire[px] < 2,
    'downhill=' + spread.toFixed(1) + ' center=' + T.fire[px].toFixed(1));
  let far = -1, fmax = 0;
  for (let x = px + 10; x < Math.min(CFG.W, px + 200); x++) if (T.fire[x] > fmax) { fmax = T.fire[x]; far = x; }
  check('fire pools where the ground is LOW — not on the peak it was dropped on',
    fmax > 2 && T.tops[far] > ptop + 20,
    'pool@' + far + ' depth=' + fmax.toFixed(1) + ' ground ' + T.tops[far] + ' vs peak ' + ptop);
  for (let i = 0; i < 1500; i++) T.stepFire();
  check('fire burns out completely after its life runs out', !T.hasFire());
}

/* the hazard: submersion kills, shallow contact burns over time.
   We carve a FLAT-bottomed basin so the fluid behaves predictably. */
function levelBasin(T, cx, halfW) {
  let bx = cx, top = -1;
  for (let x = Math.max(60, cx - halfW); x <= Math.min(CFG.W - 60, cx + halfW); x++)
    if (T.tops[x] > top) { top = T.tops[x]; bx = x; }
  const fy = T.tops[bx];
  for (let x = bx - 60; x <= bx + 60; x++) {
    for (let y = T.tops[x]; y < fy; y++) T.data[y * T.W + x] = 0;
    T.refreshTop(x);
  }
  return bx;
}
{
  const g = bareGame(51);
  const T = g.terrain;
  const bx = levelBasin(T, 500, 150);
  const v = g.players[1];
  v.x = bx; v.y = T.top(bx);
  T.addFire(bx, 40, 15, 600, 0);        // deep pool right on the tank
  g._tickFire();
  check('tank FULLY SUBMERGED in fire dies; credit goes to the fire owner',
    !v.alive && g.players[0].kills === 1 && v.deathRank > 0,
    'alive=' + v.alive + ' kills=' + g.players[0].kills);
  check('battle with only one tank left ends immediately',
    g.aliveCount() <= 1 && (g.state === 'between' || g.state === 'over'),
    'state=' + g.state);
}
{
  const g = bareGame(53);
  const T = g.terrain;
  const bx = levelBasin(T, 500, 150);
  const v = g.players[1];
  v.x = bx; v.y = T.top(bx);
  T.addFire(bx, 78, 8, 3000, 0);        // shallow (8 < TANK_H): burns, never drowns
  for (let i = 0; i < CFG.FIRE_TICK; i++) g._tickFire();
  check('touching fire hurts once per FIRE_TICK frames (damage over time)',
    v.alive && v.hp === CFG.HP - CFG.FIRE_DOT, 'hp=' + v.hp + ' alive=' + v.alive);
  check('shallow fire never instant-kills (depth stays under TANK_H)',
    (() => { for (let x = bx - 10; x <= bx + 10; x++) if (T.fire[x] >= CFG.TANK_H) return false; return true; })());
  let guard = 0;
  while (v.alive && guard++ < 900) g._tickFire();
  check('sustained contact with the fire pool eventually kills the tank',
    !v.alive && g.players[0].kills === 1);
}
{
  const g = bareGame(57);
  const T = g.terrain;
  const bx = levelBasin(T, 500, 150);
  const v = g.players[1];
  v.x = bx; v.y = T.top(bx);
  v.shield = true;                       // shield eats the FIRST hit — then it's gone
  T.addFire(bx, 60, 15, 300, 0);
  g._tickFire();
  check('a shield eats the first fire hit (submersion included) and shatters',
    v.alive && v.shield === false && v.hp === CFG.HP,
    'hp=' + v.hp + ' alive=' + v.alive + ' shield=' + v.shield);
  g._tickFire();
  check('the very next fire hit lands — a shield never eats two',
    !v.alive, 'hp=' + v.hp + ' alive=' + v.alive);
}

/* the NEXT PLAYER waits until the fire has completely vanished.
   Mid-battle ground is already stable — pre-settle, so the fire's life
   cannot be consumed by the initial settling of a raw generated map. */
{
  const g = bareGame(71);
  let nP = 0; while (g.terrain.settleStep() && nP++ < 9000);
  g.wind = 0;
  const p = g.players[0];
  const r0 = g.round;                                  // cycle we are inside
  p.hp = 1e9; g.players[1].hp = 1e9;                 // nobody dies during this test
  p.ammo = p.ammo || {}; p.ammo.napalm = 1;      // engine grants ammo via shop; grant here
  g.aimTo(p.id, 90, 40);
  g.selectWeapon(p.id, 'napalm');
  g.fire();
  let sawBurn = false, maxBurn = 0, guard = 0;
  while (guard++ < 4000 && g.state !== 'aim') {
    g.tick();
    if (g.state === 'resolve' && g.resPhase === 'burn') {
      sawBurn = true;
      maxBurn = Math.max(maxBurn, g.burnWait);
    }
  }
  check('turn resolution HOLDS while the ground burns (burn phase exists)',
    sawBurn && maxBurn >= 60, 'sawBurn=' + sawBurn + ' held=' + maxBurn);
  check('the turn passes ONLY once the fire is gone',
    g.state === 'aim' && !g.terrain.hasFire() && (g.currentId !== p.id || g.round > r0),
    'state=' + g.state + ' current=' + g.currentId + ' round=' + g.round + ' fire=' + g.terrain.hasFire());
}

/* power may be raised to POWER_MAX through the game layer too */
{
  const g = bareGame(59);
  g.aimTo(0, 90, 9999);
  check('game.aimTo caps power at POWER_MAX', g.players[0].power === CFG.POWER_MAX,
    'power=' + g.players[0].power);
}

/* blast circles grow BEFORE the ground is touched */
{
  const g = bareGame(31);
  check('humans wait at their turn', g.state === 'aim', 'state=' + g.state);
  const bx = 512, by = g.terrain.top(512) + 3;
  g._createBlast({ x: bx, y: by, owner: null, radius: 40, damage: 60, crater: 0.8 });
  g._startResolve();
  const mass0 = g.terrain.countSolid();
  for (let i = 0; i < CFG.BLAST_TELEGRAPH - 8; i++) g.tick();
  check('nothing happens to the ground while the circle grows',
    g.terrain.countSolid() === mass0,
    'during telegraph: ' + g.terrain.countSolid() + ' vs ' + mass0);
  let guard = 0;
  while (g.state === 'resolve' && guard++ < 3000) g.tick();
  check('blast applied after the circle finished (crater dug)',
    g.terrain.countSolid() < mass0,
    'after resolve: ' + g.terrain.countSolid() + ' vs ' + mass0);
  check('resolve runs to the end and hands the turn over',
    g.state === 'aim' || g.state === 'over' || g.state === 'shop', 'state=' + g.state);
  let holes2 = 0;
  for (let x = 400; x < 620; x++) {
    for (let y = g.terrain.tops[x]; y < CFG.H; y++) if (!g.terrain.data[y * CFG.W + x]) holes2++;
  }
  check('ground after the blast is hole-free (settled)', holes2 === 0, 'holes=' + holes2);
}

/* dirt mounds are also built only at resolution, then slumped to stability */
{
  const g = bareGame(32);
  const px = 300, py = g.terrain.top(300);
  const m0 = g.terrain.countSolid();
  g._applyEvents([{ type: 'add', x: px, y: py, r: 30, raise: 6 }]);
  check('dirt mound deferred until the resolve phase', g.terrain.countSolid() === m0);
  g._startResolve();
  let guard = 0;
  while (g.state === 'resolve' && guard++ < 3000) g.tick();
  check('dirt mound built during resolve', g.terrain.countSolid() > m0,
    'added ' + (g.terrain.countSolid() - m0) + ' px');
  let ms = 0;
  for (let x = px - 90; x < px + 90; x++) ms = Math.max(ms, Math.abs(g.terrain.tops[x] - g.terrain.tops[x + 1]));
  check('dirt mound slumps to a stable pile', ms <= CFG.REPOSE, 'max slope=' + ms);
}

/* shields protect against everyone else, then fade — never forever */
{
  const g = new SE.Game({ seed: 8, seats: seatset(2, [0, 1]), battles: 1 });
  g.start();                               // shop phase, buyer 0
  const b0 = g.buy(0, 'shield');
  const b0b = g.buy(0, 'shield');          // a SECOND one goes to the bag, not double-arming
  g.endCurrentBuyer();
  const b1 = g.buy(1, 'shield');
  g.endCurrentBuyer();                     // → a RANDOM seat's turn begins
  check('shields bought at the pre-battle shop', b0 && b0b && b1);
  check('beyond the first, bought shields wait in the bag',
    g.players[0].ammo.shield === 1, 'bag=' + (g.players[0].ammo && g.players[0].ammo.shield));
  const cur = g.currentId, other = 1 - cur;
  check('the current player\'s own shield already faded at their turn start; the other keeps theirs',
    g.players[cur].shield === false && g.players[other].shield === true,
    'cur=' + cur + ' p0=' + g.players[0].shield + ' p1=' + g.players[1].shield);
  g.startTurn(other);                      // the other seat's turn begins
  check('opponent shield fades when their turn begins',
    g.players[other].shield === false, 'other=' + other);
}

/* the player's angle/power and shot feedback survive into the next turn */
{
  const g = bareGame(34);                        // humans-only, seat 0 at aim
  const r0 = g.round;
  g.aimTo(0, 77, 42);
  g.fire();
  let guard = 0;
  while ((g.state === 'flight' || g.state === 'resolve') && guard++ < 5000) g.tick();
  check('shot completed, the flow moved on (next seat, or a fresh reshuffled cycle)',
    g.state === 'aim' && (g.currentId !== 0 || g.round > r0),
    'state=' + g.state + ' current=' + g.currentId + ' round=' + g.round);
  check('shot memory was recorded (angle + impact)',
    !!g.players[0].lastShot && Math.abs(g.players[0].lastShot.angle - 77) < 0.01 &&
    !!g.players[0].lastImpact,
    'lastShot=' + JSON.stringify(g.players[0].lastShot && g.players[0].lastShot.angle) +
    ' lastImpact=' + (g.players[0].lastImpact ? 'ok' : 'missing'));
  g.startTurn(0);                                // next round, same player
  check('angle and power remembered for the next turn',
    Math.abs(g.players[0].angle - 77) < 0.01 && Math.abs(g.players[0].power - 42) < 0.01,
    'now ' + g.players[0].angle + '/' + g.players[0].power);
}

/* a tank fully inside the blast circle takes FULL damage — and battle-end
   pay is exactly base + $100 per enemy outlasted */
{
  const g = bareGame(77);
  const a = g.players[0], b = g.players[1];
  b.x = 400; b.y = g.terrain.top(400);
  g.applyBlast({ x: 400, y: b.y - CFG.TANK_H / 2, radius: 60, damage: 100, crater: 0, owner: null });
  check('tank fully inside the circle takes the weapon\'s FULL 100',
    !b.alive && b.hp === 0, 'hp=' + b.hp);
  g._endOfBattle();          // end the battle the same way the resolve pipeline would
  check('outlast pay is exact: winner gets base + $100 (outlasted 1), dead gets base only',
    a.money === CFG.START_MONEY + CFG.BATTLE_BASE_PAY + CFG.OUTLAST_PAY &&
    b.money === CFG.START_MONEY + CFG.BATTLE_BASE_PAY,
    'a=' + a.money + ' b=' + b.money);
}
{
  const g = bareGame(78);
  const b = g.players[1];
  b.x = 600; b.y = g.terrain.top(600); b.shield = true;
  g.applyBlast({ x: 600, y: b.y - CFG.TANK_H / 2, radius: 60, damage: 100, crater: 0, owner: null });
  check('shielded this turn: swallowed by the circle, zero damage',
    b.alive && b.hp === CFG.HP);
}
{
  const g = bareGame(79);
  const b = g.players[1];
  b.x = 700; b.y = g.terrain.top(700);
  // centre sits clearly OUTSIDE the tank (nearest edge 55px, radius 60) → partial bite only
  g.applyBlast({ x: 765, y: b.y - CFG.TANK_H / 2, radius: 60, damage: 100, crater: 0, owner: null });
  check('partially inside the circle: hurt, but not the full amount',
    b.alive && b.hp > 0 && b.hp < CFG.HP, 'hp=' + b.hp);
}

/* no two tanks can ever spawn next to each other — slot placement */
{
  let worst = Infinity;
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    for (const seed of [7, 21, 99]) {
      const g = new SE.Game({ seed: seed, seats: seatset(n), battles: 1 });
      g.start();
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          worst = Math.min(worst, Math.abs(g.players[i].x - g.players[j].x));
        }
      }
    }
  }
  check('tanks never spawn touching each other (closest pair >= 85px)',
    worst >= 85, 'closest pair was ' + worst + ' px apart');
}

/* ---------------- 3.5 nicknames, random round order, random slots ---- */
console.log('[names]');
{
  const g = new SE.Game({ seed: 5, seats: seatset(4), battles: 2 });
  const n1 = g.players.map(function (p) { return p.name; });
  check('CPU seats get random NICKNAMES from names.js (never "CPU n")',
    n1.every(function (n, i) { return n !== 'CPU ' + (i + 1) && SE.NAMES.indexOf(n) >= 0; }),
    JSON.stringify(n1));
  check('nicknames are unique within a game', new Set(n1).size === n1.length, JSON.stringify(n1));
  const g2 = new SE.Game({ seed: 6, seats: seatset(4), battles: 1 });
  const n2 = g2.players.map(function (p) { return p.name; });
  check('a NEW game draws different nicknames',
    n1.some(function (n, i) { return n2[i] !== n; }), JSON.stringify(n2));
  g._nextBattle(false);            // later battles must NOT redraw names
  check('nicknames last the WHOLE game (not redrawn per battle)',
    g.players.every(function (p, i) { return p.name === n1[i]; }),
    JSON.stringify(g.players.map(function (p) { return p.name; })));
  const gh = new SE.Game({ seed: 5, seats: seatset(2, [0]), battles: 1 });
  check('humans stay "Player N"; a custom seat name still wins',
    gh.players[0].name === 'Player 1' && SE.NAMES.indexOf(gh.players[1].name) >= 0);
  check('names.js list has no duplicates and has plenty to choose from',
    new Set(SE.NAMES).size === SE.NAMES.length && SE.NAMES.length >= 16);
}

/* shields eat EXACTLY ONE hit — then they are gone */
console.log('[shield breaks on first damage]');
{
  const g = bareGame(88);
  const v = g.players[1];
  v.shield = true;
  g.damage(v, 40, 0, 'test');
  check('the first hit is fully eaten AND the shield shatters',
    v.hp === CFG.HP && v.shield === false, 'hp=' + v.hp + ' shield=' + v.shield);
  g.damage(v, 40, 0, 'test');
  check('the next hit lands — a shield never eats two',
    v.hp === CFG.HP - 40, 'hp=' + v.hp);
}

/* ground that covers a tank: it DIES down there — no teleport, no shield rescue */
console.log('[tanks buried by the ground]');
{
  const g = bareGame(91);
  let ns = 0; while (g.terrain.settleStep() && ns++ < 9000);
  const p = g.players[0], q = g.players[1];
  p.y = g.terrain.top(p.x); q.y = g.terrain.top(q.x);
  const py0 = p.y, qy0 = q.y;
  p.shield = true;
  g.terrain.add(p.x, py0, 30, 20);          // a mound grows right OVER this tank
  g.terrain.add(q.x, qy0 + 19, 25, 0);      // ground rises only 6 px UNDER that one
  g._updateTanks();
  check('a tank the terrain covers DIES in place — it is not teleported up',
    !p.alive && p.y === py0, 'alive=' + p.alive + ' y=' + p.y + ' was ' + py0);
  check('burial beats a shield — it is useless underground',
    p.shield === false, 'shield=' + p.shield);
  check('ground rising only UNDER a tank (stays below its head) still carries it up',
    q.alive && q.y === qy0 - 6, 'q.y=' + q.y + ' was ' + qy0);
}

/* destroyed tanks EXPLODE — the first death effect, leaving a real small crater */
console.log('[death effect: explosion]');
{
  const g = bareGame(61);
  let ns = 0; while (g.terrain.settleStep() && ns++ < 9000);
  const kinds = [];
  g.on('fx', function (e) { kinds.push(e.kind); });
  const v = g.players[1];
  const mass0 = g.terrain.countSolid();
  g.damage(v, CFG.HP, 0, 'test');
  check('a destroyed tank emits a death-explosion effect',
    !v.alive && kinds.indexOf('deathExplosion') >= 0, 'kinds=' + kinds.join(','));
  const removed = mass0 - g.terrain.countSolid();
  check('its own blast leaves a small crater in the ground',
    removed >= 20, 'removed px=' + removed);
  check('the death crater stays small (tuned by DEATH_BLAST_R)',
    removed <= 2500, 'removed px=' + removed);
}

/* extra shields sit in the bag and are raised DURING your move */
console.log('[shields from the bag during your turn]');
{
  const g = bareGame(23);
  const p = g.players[0];
  p.ammo = p.ammo || {};
  check('nothing to raise with an empty bag',
    g.useShield(p.id) === false && p.shield === false);
  p.ammo.shield = 2;
  check('raise a stored shield during your own move',
    g.useShield(p.id) === true && p.shield === true && p.ammo.shield === 1);
  check('while already shielded, a second use is refused (bag untouched)',
    g.useShield(p.id) === false && p.ammo.shield === 1);
  check('cannot use the bag during another seat\'s turn',
    g.useShield(1 - p.id) === false && g.players[1 - p.id].shield === false);
  g.startTurn(p.id);                        // your NEXT turn begins
  check('the raised shield fades at your next turn start — the bag keeps the rest',
    p.shield === false && p.ammo.shield === 1);
}

console.log('[turn order — dealt per map, fixed during a fight]');{
  const firsts = {};
  for (let s = 1; s <= 8; s++) {
    const g = new SE.Game({ seed: s * 111, seats: seatset(4), battles: 1 });
    g.start();
    let guard = 0;
    while (g.state !== 'aim' && guard++ < 4000) g.tick();   // CPUs shop by themselves
    firsts[s] = g.currentId;
  }
  check('each new map starts the fight from a RANDOM seat (not always seat 1)',
    new Set(Object.keys(firsts).map(function (k) { return firsts[k]; })).size >= 2,
    JSON.stringify(firsts));

  const g = new SE.Game({ seed: 3, seats: seatset(4), battles: 1 });
  g.start();
  let guard = 0;
  while (g.state !== 'aim' && guard++ < 4000) g.tick();
  const battleOrder = g.roundOrder.slice();
  check('a dealt order contains every player EXACTLY once',
    battleOrder.slice().sort().join(',') === '0,1,2,3', battleOrder.join(','));
  const seen = new Set([battleOrder.join(',')]);
  const starters = new Set([g.currentId]);
  // this test is ABOUT ORDER — make forced storms harmless to it
  for (const p of g.players) p.hp = 999999;
  for (let r = 0; r < 10; r++) { g._beginRound(); seen.add(g.roundOrder.join(',')); starters.add(g.currentId); }
  check('during a fight the order NEVER changes — every round replays the same sequence',
    seen.size === 1 && starters.size === 1 && g.currentId === battleOrder[0],
    'orders=' + JSON.stringify([...seen]) + ' starters=' + JSON.stringify([...starters]));

  const g2 = new SE.Game({ seed: 7, seats: seatset(4), battles: 3 });
  g2.start();                                   // map 1 dealt
  const deals = [g2.roundOrder.join(',')];
  g2._nextBattle(false); deals.push(g2.roundOrder.join(','));   // new map → re-dealt
  g2._nextBattle(false); deals.push(g2.roundOrder.join(','));
  check('each dealt order is a complete permutation',
    deals.every(function (o) { return o.split(',').slice().sort().join(',') === '0,1,2,3'; }),
    deals.join(' // '));
  check('ONLY a new map changes it — battle 2+ get a freshly dealt order',
    new Set(deals).size >= 2, deals.join(' // '));
}

console.log('[random spawn slots]');
{
  const patterns = {};
  for (let s = 1; s <= 8; s++) {
    const g = new SE.Game({ seed: 400 + s * 7, seats: seatset(4), battles: 1 });
    g.start();                                    // generation + placement happen here
    const xs = g.players.map(function (p) { return p.x; });
    let mn = 0, mx = 0;
    for (let i = 1; i < 4; i++) { if (xs[i] < xs[mn]) mn = i; if (xs[i] > xs[mx]) mx = i; }
    patterns[s] = mn + '->' + mx;                 // leftmost seat -> rightmost seat
  }
  check('spawn slots go to RANDOM seats (seat 1 is not always left, seat 4 not always right)',
    new Set(Object.keys(patterns).map(function (k) { return patterns[k]; })).size >= 3,
    JSON.stringify(patterns));
}

/* ---------------- 4. full matches to termination ---------------- */
console.log('[full matches]');
function playMatch(seed, seats, battles, maxTicks) {
  const g = new SE.Game({ seed: seed, seats: seats, battles: battles });
  const info = {
    shopBuyers: 0, explosions: 0, landings: 0, battleEnds: [], battleStarts: [],
    solidAtStart: 0, moneyAtEnd: 0,
  };
  g.on('shopBuyer', function () { info.shopBuyers++; });
  g.on('fx', function (e) {
    if (e.kind === 'explosion') info.explosions++;
    if (e.kind === 'explosion' || e.kind === 'fire' || e.kind === 'thud' ||
        e.kind === 'direct' || e.kind === 'spark') info.landings++;
  });
  g.on('battleStart', function (e) { info.battleStarts.push(e.battle); });
  g.on('battleEnd', function (e) { info.battleEnds.push(e); });
  g.start();
  info.solidAtStart = g.terrain.countSolid();
  let ticks = 0;
  while (g.state !== 'over' && ticks < maxTicks) { g.tick(); ticks++; }
  return { g: g, ticks: ticks, info: info };
}

const seeds = [1, 2, 99, 12345, 777];
for (const s of seeds) {
  const res = playMatch(s, seatset(4), 1, 400000);
  const g = res.g;
  check('seed ' + s + ': single-battle game terminates',
    g.state === 'over', 'ticks=' + res.ticks + ' state=' + g.state);
  check('seed ' + s + ': a match always has a declared winner',
    g.winner != null && g.winner >= 0, 'winner=' + g.winner);
  const alive = g.players.filter(function (p) { return p.alive; });
  check('seed ' + s + ': sole survivor gets the win',
    alive.length !== 1 || g.winner === alive[0].id,
    'winner=' + g.winner + ' alive=' + alive.length);
  check('seed ' + s + ': ammunition actually landed on the map (blast, fire, roll or hit)',
    res.info.landings >= 1, 'landings=' + res.info.landings + ' explosions=' + res.info.explosions);
  // sanity: no NaNs anywhere
  let nan = false;
  for (const p of g.players) if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.hp) || !isFinite(p.money)) nan = true;
  if (g.wind && !isFinite(g.wind)) nan = true;
  check('seed ' + s + ': no NaN state', !nan);
  console.log('       round=' + g.round + ' ticks=' + res.ticks +
    ' winner=' + (g.winner != null ? g.players[g.winner].name : 'draw') +
    ' kills=' + g.players.reduce(function (a, p) { return a + p.kills; }, 0) +
    ' shots=' + g.players.reduce(function (a, p) { return a + p.shots; }, 0));
}

const res8 = playMatch(4242, seatset(8), 2, 900000);
check('8-player 2-battle match terminates', res8.g.state === 'over', 'ticks=' + res8.ticks);

/* multi-battle structure: 2 battles, fresh everything, money carries over */
{
  let moneyAtBattle2Start = -1, moneyAtBattle1End = -1, decisive = 0;
  let payoutsOk = true, paidList = [];
  const g0 = new SE.Game({ seed: 3141, seats: seatset(3), battles: 2 });
  g0.on('battleStart', function (e) {
    if (e.battle === 2) moneyAtBattle2Start = g0.players.reduce(function (a, p) { return a + p.money; }, 0);
  });
  g0.on('money', function (e) { if (e.reason === 'battle') paidList.push(e); });
  g0.on('battleEnd', function (e) {
    // every tank must have been paid exactly: base + OUTLAST × enemies it outlived
    const seq = g0.battleDeathSeq;
    let wantN = 0, wantTotal = 0;
    for (const p of g0.players) {
      const rank = p.alive ? seq + 1 : (p.deathRank || 0);
      let out = 0;
      for (const q of g0.players) {
        if (q.id === p.id) continue;
        const qr = q.alive ? seq + 1 : (q.deathRank || 0);
        if (qr < rank) out++;
      }
      wantTotal += CFG.BATTLE_BASE_PAY + CFG.OUTLAST_PAY * out; wantN++;
    }
    const gotTotal = paidList.reduce(function (sum, m) { return sum + m.amount; }, 0);
    if (paidList.length !== wantN || gotTotal !== wantTotal) payoutsOk = false;
    paidList = [];
    if (e.battle === 1) moneyAtBattle1End = g0.players.reduce(function (a, p) { return a + p.money; }, 0);
    if (e.winnerId != null) decisive++;
  });
  const info = { battleEnds: [], battleStarts: [] };
  g0.on('battleStart', function (e) { info.battleStarts.push(e.battle); });
  g0.on('battleEnd', function (e) { info.battleEnds.push(e); });
  let shopBuyers = 0;
  g0.on('shopBuyer', function () { shopBuyers++; });
  g0.start();
  let ticks = 0;
  while (g0.state !== 'over' && ticks < 400000) { g0.tick(); ticks++; }
  const g = g0;
  check('match ran exactly 2 battles', info.battleStarts.join(',') === '1,2',
    'starts=' + info.battleStarts.join(','));
  check('shop ran exactly once per battle (buyers = battles × players)',
    shopBuyers === 2 * 3, 'shopBuyers=' + shopBuyers);
  check('battle wins = decisive battles (draws add none)',
    (g.battleWins || []).reduce(function (a, b) { return a + b; }, 0) === decisive,
    'wins=' + (g.battleWins || []).join(',') + ' decisive=' + decisive);
  // money entered the second battle's shop = exactly what battle 1 ended with
  check('money carries over unchanged between battles',
    moneyAtBattle2Start === moneyAtBattle1End,
    'battle2 start=' + moneyAtBattle2Start + ' battle1 end=' + moneyAtBattle1End);
  check('every battle paid all tanks exactly base + outlast bonuses', payoutsOk);
  console.log('       battles=2 moneyAtBattle2=' + moneyAtBattle2Start +
    ' wins=' + g.battleWins.join(','));
}

/* humans idle in the middle shouldn't break anything: the game waits
   at their shop step, then at their turn — it never spins forward */
{
  const g = new SE.Game({ seed: 5, seats: seatset(3, [1]), battles: 2 });
  g.start();
  // CPU seats shop automatically; the game must park at the human buyer
  let guard = 0;
  while (g.state === 'shop' && g.shopQueue[0] !== 1 && guard++ < 4000) g.tick();
  check('human seat idle => game waits at their shop',
    g.state === 'shop' && g.shopQueue[0] === 1,
    'state=' + g.state + ' nextBuyer=' + g.shopQueue[0]);
  // CPUs before them shop automatically, the human buyer never auto-passes
  let ticks = 0;
  while (g.state === 'shop' && g.shopQueue[0] === 1 && ticks < 300) { g.tick(); ticks++; }
  check('game stays parked at the human shop', g.shopQueue[0] === 1,
    'queue=' + g.shopQueue.join(','));
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\nFAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);
