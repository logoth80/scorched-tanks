/* =====================================================================
 * SCORCHED TANKS — configuration
 * Everything you might want to tweak lives in this file.
 * Adding a new ammunition type = copy one entry in SE.WEAPONS, change
 * the numbers, and (if needed) reuse one of the existing behaviors
 * ('explode', 'thud', 'cluster', 'roll', 'multiblast', 'addground', 'fire')
 * implemented in js/weapons.js. It shows up in the shop automatically.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});

/* ---------- small shared helpers ---------- */
SE.util = {
  clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
  lerp(a, b, t) { return a + (b - a) * t; },
  mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },
  hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  },
  rgbaOf(hex, a) {
    const c = SE.util.hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  },
};

/* ---------- game constants ---------- */
SE.CONFIG = {
  W: 1024,
  H: 768,

  /* Sky + terrain look (ground is exactly ONE color) */
  SKY_TOP: '#13294b',
  SKY_MID: '#2e6fa7',
  SKY_BOTTOM: '#a8cfe6',
  GROUND_COLOR: '#7a4a2c',
  SUN: '#ffe9a8',

  /* Physics — all values in pixels / frames at 60 Hz */
  GRAVITY: 0.15,
  MAX_SPEED: 11.6,          // projectile speed at power 100 (power 200 = 2×)
  POWER_MAX: 200,           // upper bound of the power dial (100 = normal range)
  SPEED_CLAMP: 30,          // hard clamp on total projectile speed
  WIND_MAX: 12,             // wind is re-rolled every turn, in [-max, +max]
  WIND_ACCEL: 0.0026,       // horizontal acceleration per wind unit

  /* Terrain settling has exactly ONE rule: a soil pixel with EMPTY space
     directly below it falls (at most FALL_RATE px per pass). Soil is NEVER
     redistributed sideways — an intact mountainside keeps its shape forever;
     only land whose support was blasted away moves. */
  FALL_RATE: 3,             // px a soil pixel drops per settling pass (lower = slower collapse)

  /* Open borders: terrain generation fades mountains down to low ground in
     the first/last EDGE_OPEN columns — shots past the screen edge fly off
     into open sky instead of hitting a wall at the border. */
  EDGE_OPEN: 70,

  /* Liquid fire (napalm) — a burning fluid that flows down to level,
     clings to the ground and burns for `life` frames. A tank the fire
     merely touches is stung every FIRE_TICK frames (kept LOW on purpose).
     DROWNING is special: deep fluid kills ONLY when the tank is between
     high walls (its ground is a pit ≥ FIRE_PIT_RISE lower than ground on
     BOTH sides within FIRE_PIT_WIN) — a tank standing on open ground while
     fluid flows over it is never instantly killed, no matter the depth. */
  FIRE_MAX: 26,             // max depth of burning fluid per column
  FIRE_FLOW: 0.5,           // max px transferred between neighbours per pass (SLOW spreading)
  FIRE_MIN_LEVEL: 0.8,      // below this surface difference fire stops leveling out
  FIRE_SLIDE: 1.4,          // max px per pass flowing DOWNHILL along the ground slope
  FIRE_SLIDE_STEP: 1.0,     // min ground drop (px/col) that starts downhill sliding
  FIRE_SLIDE_DEPTH: 0.7,    // fire must be at least this deep to slide
  FIRE_KEEP: 0.997,         // slow burn-down while still alive
  FIRE_BURNOUT: 0.8,        // fast shrink once its time is up
  FIRE_DOT: 1,              // harm per tick while touched by fire (≈2 hp/s: a slow ember, never a melter)
  FIRE_TICK: 30,            // frames between fire damage ticks
  FIRE_PIT_WIN: 120,        // px left/right of the tank that must hold…
  FIRE_PIT_RISE: 12,        // …a wall at least this high for deep fire to DROWN it ("between high walls")
  FIRE_WAIT_MAX: 560,       // a turn WAITS for burning ground to vanish; hard cap (frames)

  /* Tanks — small simple sprites */
  TANK_W: 20,
  TANK_H: 12,
  BARREL_LEN: 16,
  HP: 100,
  DIRECT_DAMAGE: 100,       // a direct hit always does full (lethal) damage

  /* Fuel: total movement for the WHOLE combat, max 5 tank lengths,
     and never up a steep climb. */
  FUEL_TOTAL: 100,          // px = 5 * TANK_W
  CLIMB_MAX: 4,             // max ground step-up while driving (px)

  /* Falling (ground collapsing under a tank) */
  FALL_GRAVITY: 0.25,
  TERM_FALL_VY: 9,
  FALL_MIN_PX: 12,          // falls shorter than this are harmless
  FALL_DAMAGE_PER_PX: 1.4,
  PARA_MIN_FALL: 18,        // parachute auto-triggers beyond this fall
  PARA_VY: 1.6,             // terminal speed while parachuting
  PARA_RESCUE: 0.15,        // parachuted landings keep only 15% of fall damage

  /* Death effect: a destroyed tank explodes like a NORMAL ammo — the blast is
     the Basic Shot's own explosion (radius/damage/crater from its table entry,
     so tuning Basic retunes wreck-blasts too). It even chains: a wreck blast
     damages nearby tanks. See Game._deathFx. */

  /* A match = best-of series of battles. The shop runs ONLY before the
     first battle and between battles — never mid-battle. Between
     battles the map is brand new and tanks are placed randomly again
     (HP and fuel reset; money and purchased ammo carry over). */
  TOTAL_BATTLES: 3,
  INTER_BATTLE_FRAMES: 150,    // pause between battles, for banners

  /* Economy — money carries across battles */
  START_MONEY: 1000,
  BATTLE_BASE_PAY: 700,     // every tank gets this after a battle ends…
  OUTLAST_PAY: 100,         // …plus this for every enemy it outlasted (died after it)
  KILL_PAY: 500,            // paid instantly to the killer

  /* Blast telegraph: the damage circle grows visibly from the impact
     point for this many frames BEFORE ground + players are damaged. */
  BLAST_TELEGRAPH: 85,      // damage circle grows ~1.4 s before detonation

  /* AI character — the CPU genuinely remembers+corrects its shots, but aims
     like a person, not a machine: imperfect wind reading and a jitter that
     makes direct hits earned, not guaranteed. Tune freely. */
  AI_JITTER_ANGLE: 3.0,     // degrees of sloppiness on the final pick
  AI_JITTER_POWER: 5,       // power units of sloppiness
  AI_WIND_BLUNDER: 1.6,     // how wrong the AI "reads" the wind (± units)
  AI_TOPK: 3,               // picks randomly among its best K plans

  /* Storm — anti-stalemate: from this round on, every surviving tank is
     harmed a little more each round (a shield blocks it). Tune freely. */
  STORM_FROM_ROUND: 14,
  STORM_DAMAGE_BASE: 10,
  STORM_DAMAGE_STEP: 5,
  STORM_DAMAGE_MAX: 100,

  MIN_PLAYERS: 2,
  MAX_PLAYERS: 8,
};

/* ---------- look ---------- */
SE.PLAYER_COLORS = [
  { main: '#e0453a', dark: '#7e1f18' },
  { main: '#3d7dd8', dark: '#1c3f7c' },
  { main: '#39b64a', dark: '#1a5c26' },
  { main: '#e8b62c', dark: '#7d5a0c' },
  { main: '#a457c9', dark: '#53256e' },
  { main: '#e8842c', dark: '#7e400c' },
  { main: '#28bfae', dark: '#0f5f56' },
  { main: '#d9d9e3', dark: '#6c6c7c' },
];

/* Three simple tank silhouettes; players get them round-robin */
SE.TANK_VARIANTS = ['compact', 'stalker', 'hauler'];

/* =====================================================================
 * AMMUNITION TABLE — tune freely, add more.
 *  price / count : shop pack (buying gives `count` shots for `price` $)
 *  hidden:true   : internal child projectile, not sold in the shop
 *  behavior      : 'explode' | 'thud' | 'cluster' | 'roll' | 'multiblast' |
 *                  'addground' | 'fire' | 'hop' | 'funny'
 *  explosion     : radius = damage circle, crater = crater radius multiplier
 *                  (crater sizes stay independent of radius — scale freely)
 *  fire          : liquid-fire pour for behavior 'fire' (radius/depth px, life frames)
 *  hop           : behavior 'hop' — explode on impact, then spawn `child`
 *                  hopping FORWARD (vx = hop speed in travel direction, vy =
 *                  launch hop). Chain children to control how many hops.
 *  funny         : behavior 'funny' — normal blast, then `count` children
 *                  fired in RANDOM directions (angles deg, speeds px/frame)
 *  launch        : per-weapon multipliers on shared ballistics; optional
 *                  `terminal` caps how fast the projectile can fall (px/frame)
 * ===================================================================== */
SE.WEAPONS = [
  {
    id: 'basic', name: 'Basic Shot', free: true, hidden: false,
    desc: 'Free and unlimited. The reliable standard shell.',
    color: '#ffe27a', trail: 'rgba(255,226,122,0.55)', size: 2.4,
    launch: { speedScale: 1.0, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'explode',
    // radius = DAMAGE circle; crater 1.0 = the circle destroys ALL ground it covers
    explosion: { radius: 63, damage: 100, crater: 1.0 },
  },
  {
    id: 'cluster', name: 'Cluster Bomb', price: 600, count: 3,
    desc: 'Splits just BEFORE the top of its arc into 3 bomblets: one follows the original trajectory, the other two land progressively further on. Each pops in a full-size blast.',
    color: '#ffb347', trail: 'rgba(255,179,71,0.5)', size: 3,
    launch: { speedScale: 0.95, gravityScale: 1.0, windScale: 1.1, drag: 0 },
    behavior: 'cluster',
    /* ladder split: at apVy ≈ the apex is reached (still rising slightly),
       3 children are born with the PARENT's velocity scaled by boosts —
       child 1 = the original path, child 2/3 = further downrange */
    split: { atVy: -0.35, boosts: [1.0, 1.28, 1.6], child: 'clusterlet' },
  },
  {
    id: 'clusterlet', name: 'Bomblet', hidden: true,
    desc: 'Bomblet from the Cluster Bomb. Drifts down slowly, then pops in a full-size blast.',
    color: '#ffd27a', trail: 'rgba(255,210,122,0.4)', size: 1.8,
    /* low terminal velocity (terminal) + drag = it floats down like real
       cluster bomblets, letting wind scatter it over a wide pattern */
    launch: { speedScale: 1, gravityScale: 0.85, windScale: 1.3, drag: 0.01, terminal: 2.4 },
    behavior: 'explode',
    /* bomblets pop at FULL Basic-Shot scale — drifting is the trick,
       not being weak */
    explosion: { radius: 63, damage: 100, crater: 1.0 },
  },
  {
    id: 'roller', name: 'Roller', price: 300, count: 5,
    desc: 'Lands on the mountain and ROLLS downhill until a tank or a wall stops it.',
    color: '#c8a2ff', trail: 'rgba(200,162,255,0.45)', size: 2.6,
    launch: { speedScale: 0.85, gravityScale: 1.0, windScale: 0.8, drag: 0 },
    behavior: 'roll',
    roll: {
      slopeAccel: 0.16, friction: 0.993, maxSpeed: 7, stopSpeed: 0.3,
      maxTime: 900,
      explode: { radius: 63, damage: 100, crater: 1.0 },   // full Basic scale
    },
  },
  {
    id: 'napalm', name: 'Napalm', price: 400, count: 2,
    desc: 'No blast — pours LIQUID FIRE that flows downhill, fills low ground and burns for 5 seconds. On open ground it only stings; trapped between high walls in deep fluid, a tank drowns.',
    color: '#ff7a3c', trail: 'rgba(255,122,60,0.55)', size: 2.8,
    launch: { speedScale: 0.9, gravityScale: 1.0, windScale: 1.2, drag: 0.0015 },
    behavior: 'fire',
    fire: { radius: 78, depth: 15, life: 300 },   // 300 frames = 5 seconds at 60 Hz
  },
  {
    id: 'fissure', name: 'Fissure Bomb', price: 350, count: 3,
    desc: 'NO blast, NO damage. The hit FIRES LIGHTNING-BOLT TUNNELS through the ground: a web of jagged, branching fissures tears down and out from the impact, hollowing the rock while the surface above still stands. One second of silence — then gravity resumes and the ground COLLAPSES into a wide field of sinking hollows. Anything standing on it rides the ground down.',
    color: '#8fd6a8', trail: 'rgba(143,214,168,0.5)', size: 3,
    launch: { speedScale: 0.9, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'fissure',
    nodamage: true,                 // stops against a hull without hurting it
    /* at impact: branching tunnels (bolts, forking `forks` deep) are bored
       through the ground inside this reach/depth box, `tunnel` px wide; the
       first bolt is a near-vertical trunk so the impact column sinks most.
       The surface holds for `delay` frames, then normal settling collapses
       it. Deterministic from position — same shot, same tunnel web. */
    fissure: { reach: 150, depth: 95, bolts: 9, tunnel: 3.4, forks: 2, delay: 60 },
  },
  {
    id: 'big', name: 'Big Bomb', price: 600, count: 1,
    desc: 'Three overlapping blasts. Huge craters, huge price.',
    color: '#ff5f5f', trail: 'rgba(255,95,95,0.6)', size: 3.6,
    launch: { speedScale: 0.9, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'multiblast',
    blasts: [
      { dx: 0,   dy: 0,  delay: 0,  radius: 108, damage: 100, crater: 1.0 },
      { dx: -46, dy: -8, delay: 9,  radius: 72,  damage: 80,  crater: 1.0 },
      { dx: 44,  dy: -14, delay: 17, radius: 72, damage: 80,  crater: 1.0 },
    ],
  },
  {
    id: 'dirt', name: 'Dirt Bomb', price: 300, count: 2,
    desc: 'Instead of destroying ground it BUILDS a fresh mound. Bury or bridge your rivals.',
    color: '#c98f5a', trail: 'rgba(201,143,90,0.5)', size: 3,
    launch: { speedScale: 0.9, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'addground',
    add: { radius: 58, raise: 6 },
    explosion: { radius: 52, damage: 25, crater: 0 },
  },
  {
    id: 'leapfrog', name: 'Leap Frog', price: 500, count: 2,
    desc: 'Explodes on impact, then HOPS a long way forward and explodes again — and leaps once more. Three full-size blasts chasing downrange.',
    color: '#8ee06e', trail: 'rgba(142,224,110,0.5)', size: 2.8,
    launch: { speedScale: 0.9, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'hop',
    explosion: { radius: 63, damage: 100, crater: 1.0 },
    hop: { child: 'leapfrog2', vx: 3.0, vy: 5.0 },
  },
  {
    id: 'leapfrog2', name: 'Leap Frog (2nd hop)', hidden: true,
    desc: 'The second hop of a Leap Frog.',
    color: '#a8e88a', trail: 'rgba(168,232,138,0.45)', size: 2.5,
    launch: { speedScale: 1, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'hop',
    explosion: { radius: 63, damage: 100, crater: 1.0 },
    hop: { child: 'leapfrog3', vx: 2.6, vy: 4.2 },
  },
  {
    id: 'leapfrog3', name: 'Leap Frog (final splash)', hidden: true,
    desc: 'The last hop of a Leap Frog — lands with a bang.',
    color: '#c2efac', trail: 'rgba(194,239,172,0.4)', size: 2.2,
    launch: { speedScale: 1, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'explode',
    explosion: { radius: 63, damage: 100, crater: 1.0 },
  },
  {
    id: 'funny', name: 'Funny Bomb', price: 450, count: 2,
    desc: 'BOOM first — and only when that blast has actually gone off do THREE firecrackers pop out in WIDE RANDOM directions: some barely leave the crater, some fly almost sideways an entire ridge away. Anybody\'s guess.',
    color: '#ff8ad4', trail: 'rgba(255,138,212,0.55)', size: 3,
    launch: { speedScale: 0.95, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'funny',
    explosion: { radius: 63, damage: 100, crater: 1.0 },
    funny: { count: 3, child: 'funnylet', angleMin: 8, angleMax: 172, speedMin: 2.2, speedMax: 9.8 },
  },
  {
    id: 'funnylet', name: 'Firecracker', hidden: true,
    desc: 'One of the Funny Bomb\'s random pops. Waits for the main blast to detonate, then flies.',
    color: '#ffc2e6', trail: 'rgba(255,194,230,0.45)', size: 1.8,
    launch: { speedScale: 1, gravityScale: 1.0, windScale: 1.2, drag: 0.006 },
    behavior: 'explode',
    /* fuse: sits still until the parent blast has DETONATED (its telegraph
       is BLAST_TELEGRAPH frames) — explode first, THEN send the shots */
    fuse: 95,
    explosion: { radius: 63, damage: 100, crater: 1.0 },
  },
];

/* ---------- consumable items ---------- */
SE.ITEMS = [
  { id: 'parachute', name: 'Parachute', price: 120,
    desc: 'Auto-opens on long falls and softens the landing (falling still hurts).' },
  { id: 'shield', name: 'Shield', price: 250,
    desc: 'Eats the FIRST hit aimed at you, then it\'s gone (it also fades when your own next turn begins). Spare shields stay in your bag — raise one during your move.' },
];

/* ---------- lookup helper ---------- */
SE._wmap = null;
SE.weaponById = function (id) {
  if (!SE._wmap) {
    SE._wmap = {};
    for (const w of SE.WEAPONS) SE._wmap[w.id] = w;
  }
  return SE._wmap[id];
};
SE.shopWeapons = function () {
  return SE.WEAPONS.filter(function (w) { return !w.hidden; });
};
SE.itemById = function (id) {
  return SE.ITEMS.find(function (i) { return i.id === id; });
};

})(typeof globalThis !== 'undefined' ? globalThis : this);
