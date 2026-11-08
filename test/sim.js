/* =====================================================================
 * HEADLESS SIMULATION TEST — loads only the DOM-free engine modules and:
 *  1. terrain invariants: gen / dig / add / ALL holes collapse /
 *     slope slumping / mass conservation / wide-shallow crater scaling
 *  2. every weapon behavior (blast, cluster, roller, multiblast, dirt)
 *  3. ammunition ↔ terrain interaction through the real turn pipeline:
 *     blast circles grow BEFORE damage, ground changes only at resolve,
 *     then settle, then tanks
 *  4. full matches (multi-battle): shop exactly once per battle,
 *     fresh terrain+placement each battle, money/ammo carry over,
 *     storms keep matches finite
 * Run: node test/sim.js
 * ===================================================================== */
'use strict';
require('../js/config.js');
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

const before = terr.countSolid();
terr.dig(500, terr.tops[500] + 10, 40);
check('dig removes pixels', terr.countSolid() < before);

const mid = terr.countSolid();
terr.add(200, terr.tops[200] - 20, 30, 0);
check('add creates ground', terr.countSolid() > mid);

let massBefore = terr.countSolid(), passes = 0;
while (terr.settleStep() && passes < 3000) passes++;
let maxSlope = 0;
for (let x = 0; x < CFG.W - 1; x++) maxSlope = Math.max(maxSlope, Math.abs(terr.tops[x] - terr.tops[x + 1]));
check('settling converges', passes < 3000, 'passes=' + passes);
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
while (t5.settleStep() && p5 < 3000) p5++;
check('roof above a cave falls into it', t5.tops[cx5] > roofBefore,
  'top ' + roofBefore + ' → ' + t5.tops[cx5]);
check('cave collapse conserves mass', t5.countSolid() === mass5,
  t5.countSolid() + ' vs ' + mass5);

/* craterY squashes craters vertically (napalm: wide scar, shallow dig) */
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

r = runProj(SE.Weapons.create('cluster', 500, 300, 60, 9, 0), 600);
check('cluster splits at apex into 4 bomblets', r.spawned.length === 4,
  'spawned=' + r.spawned.length);

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
check('napalm passes craterY through to the blast event',
  r.events.some(function (e) { return e.type === 'blast' && e.craterY === 0.55; }));

// bomblets: they interact with the terrain but NEVER detonate
r = runProj(SE.Weapons.create('clusterlet', 300, 100, 60, 6, 0), 600);
check('bomblets thud into terrain without any blast',
  r.events.every(function (e) { return e.type !== 'blast'; }) &&
  r.events.some(function (e) { return e.type === 'fx' && e.kind === 'spark'; }));

/* ---------------- 3. turn pipeline: strict order + terrain effects ------ */
console.log('[turn pipeline]');
function seatset(n, humanAt) {
  const s = [];
  for (let i = 0; i < n; i++) s.push({ human: !!(humanAt && humanAt.includes(i)) });
  return s;
}
function bareGame(seed) {                 // 2 humans, 1 battle, at first turn
  const g = new SE.Game({ seed: seed, seats: seatset(2, [0, 1]), battles: 1 });
  g.start();
  g.endCurrentBuyer();
  g.endCurrentBuyer();
  return g;                              // state: aim, seat 0
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
  g.endCurrentBuyer();
  const b1 = g.buy(1, 'shield');
  g.endCurrentBuyer();                     // → seat 0's turn begins
  check('shields bought at the pre-battle shop', b0 && b1);
  check('own shield already faded when own turn begins',
    g.players[0].shield === false && g.players[1].shield === true,
    'p0=' + g.players[0].shield + ' p1=' + g.players[1].shield);
  g.startTurn(1);                          // seat 1's turn begins
  check('opponent shield fades when their turn begins',
    g.players[1].shield === false, 'p1=' + g.players[1].shield);
}

/* the player's angle/power and shot feedback survive into the next turn */
{
  const g = bareGame(34);                        // humans-only, seat 0 at aim
  g.aimTo(0, 77, 42);
  g.fire();
  let guard = 0;
  while ((g.state === 'flight' || g.state === 'resolve') && guard++ < 5000) g.tick();
  check('shot completed, next player is up',
    g.state === 'aim' && g.currentId === 1, 'state=' + g.state + ' current=' + g.currentId);
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

/* ---------------- 4. full matches to termination ---------------- */
console.log('[full matches]');
function playMatch(seed, seats, battles, maxTicks) {
  const g = new SE.Game({ seed: seed, seats: seats, battles: battles });
  const info = {
    shopBuyers: 0, explosions: 0, battleEnds: [], battleStarts: [],
    solidAtStart: 0, moneyAtEnd: 0,
  };
  g.on('shopBuyer', function () { info.shopBuyers++; });
  g.on('fx', function (e) { if (e.kind === 'explosion') info.explosions++; });
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
  check('seed ' + s + ': ammunition actually detonated on the map',
    res.info.explosions >= 1, 'explosions=' + res.info.explosions);
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
  let moneyAtBattle2Start = -1, moneyAtBattle1End = -1, winPays = 0, decisive = 0;
  const g0 = new SE.Game({ seed: 3141, seats: seatset(3), battles: 2 });
  g0.on('battleStart', function (e) {
    if (e.battle === 2) moneyAtBattle2Start = g0.players.reduce(function (a, p) { return a + p.money; }, 0);
  });
  g0.on('battleEnd', function (e) {
    if (e.battle === 1) moneyAtBattle1End = g0.players.reduce(function (a, p) { return a + p.money; }, 0);
    if (e.winnerId != null) decisive++;
  });
  g0.on('money', function (e) { if (e.reason === 'win') winPays++; });
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
  check('battle winners were paid', winPays === decisive, 'winPays=' + winPays + ' decisive=' + decisive);
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
