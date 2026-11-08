/* =====================================================================
 * SCORCHED TANKS — configuration
 * Everything you might want to tweak lives in this file.
 * Adding a new ammunition type = copy one entry in SE.WEAPONS, change
 * the numbers, and (if needed) reuse one of the existing behaviors
 * ('explode', 'cluster', 'roll', 'multiblast', 'addground') implemented
 * in js/weapons.js. It shows up in the shop automatically.
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
  MAX_SPEED: 11.6,          // projectile speed at power 100
  SPEED_CLAMP: 16,          // hard clamp on total projectile speed
  WIND_MAX: 4,              // wind is re-rolled every turn, in [-max, +max]
  WIND_ACCEL: 0.0026,       // horizontal acceleration per wind unit

  /* Terrain stability — after any explosion, soil above this slope slumps */
  REPOSE: 3,                // max stable height step between neighbour columns
  SLUMP_MAX: 5,             // max px transferred per column pair per pass

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

  /* A match = best-of series of battles. The shop runs ONLY before the
     first battle and between battles — never mid-battle. Between
     battles the map is brand new and tanks are placed randomly again
     (HP and fuel reset; money and purchased ammo carry over). */
  TOTAL_BATTLES: 3,
  INTER_BATTLE_FRAMES: 150,    // pause between battles, for banners

  /* Economy — money carries across battles */
  START_MONEY: 1000,
  WIN_PAY: 400,               // paid to the winner at the end of a battle
  SURVIVE_PAY: 200,           // paid to every tank still standing at battle end
  KILL_PAY: 500,              // paid instantly to the killer

  /* Blast telegraph: the damage circle grows visibly from the impact
     point for this many frames BEFORE ground + players are damaged. */
  BLAST_TELEGRAPH: 45,

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
 *  behavior      : 'explode' | 'cluster' | 'roll' | 'multiblast' | 'addground'
 *  explosion     : radius = damage circle, crater = crater radius multiplier
 *  launch        : per-weapon multipliers on shared ballistics
 * ===================================================================== */
SE.WEAPONS = [
  {
    id: 'basic', name: 'Basic Shot', free: true, hidden: false,
    desc: 'Free and unlimited. The reliable standard shell.',
    color: '#ffe27a', trail: 'rgba(255,226,122,0.55)', size: 2.4,
    launch: { speedScale: 1.0, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'explode',
    explosion: { radius: 42, damage: 100, crater: 0.8 },
  },
  {
    id: 'cluster', name: 'Cluster Bomb', price: 600, count: 3,
    desc: 'Splits at the top of its arc into 4 bomblets that rain down.',
    color: '#ffb347', trail: 'rgba(255,179,71,0.5)', size: 3,
    launch: { speedScale: 0.95, gravityScale: 1.0, windScale: 1.1, drag: 0 },
    behavior: 'cluster',
    split: {
      n: 4, minTime: 40, maxTime: 320, child: 'clusterlet', inherit: 0.5,
      spread: { minAngle: 35, maxAngle: 105, speed: 1.5, jitter: 0.8 },
    },
  },
  {
    id: 'clusterlet', name: 'Bomblet', hidden: true,
    color: '#ffd27a', trail: 'rgba(255,210,122,0.4)', size: 1.8,
    launch: { speedScale: 1, gravityScale: 1.05, windScale: 1.0, drag: 0 },
    behavior: 'explode',
    explosion: { radius: 24, damage: 70, crater: 0.6 },
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
      explode: { radius: 28, damage: 85, crater: 0.65 },
    },
  },
  {
    id: 'napalm', name: 'Napalm', price: 400, count: 2,
    desc: 'Enormous fire damage area, wide shallow crater. Great for flattening slopes.',
    color: '#ff7a3c', trail: 'rgba(255,122,60,0.55)', size: 2.8,
    launch: { speedScale: 0.9, gravityScale: 1.0, windScale: 1.2, drag: 0.0015 },
    behavior: 'explode',
    // craterY squashes the crater vertically: wide burn scar, shallow dig
    explosion: { radius: 88, damage: 95, crater: 0.45, craterY: 0.55, burn: 240 },
  },
  {
    id: 'big', name: 'Big Bomb', price: 600, count: 1,
    desc: 'Three overlapping blasts. Huge craters, huge price.',
    color: '#ff5f5f', trail: 'rgba(255,95,95,0.6)', size: 3.6,
    launch: { speedScale: 0.9, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'multiblast',
    blasts: [
      { dx: 0,   dy: 0,  delay: 0,  radius: 72, damage: 100, crater: 0.8 },
      { dx: -46, dy: -8, delay: 9,  radius: 48, damage: 80,  crater: 0.6 },
      { dx: 44,  dy: -14, delay: 17, radius: 48, damage: 80, crater: 0.6 },
    ],
  },
  {
    id: 'dirt', name: 'Dirt Bomb', price: 300, count: 2,
    desc: 'Instead of destroying ground it BUILDS a fresh mound. Bury or bridge your rivals.',
    color: '#c98f5a', trail: 'rgba(201,143,90,0.5)', size: 3,
    launch: { speedScale: 0.9, gravityScale: 1.0, windScale: 1.0, drag: 0 },
    behavior: 'addground',
    add: { radius: 40, raise: 6 },
    explosion: { radius: 26, damage: 25, crater: 0 },
  },
];

/* ---------- consumable items ---------- */
SE.ITEMS = [
  { id: 'parachute', name: 'Parachute', price: 120,
    desc: 'Auto-opens on long falls and softens the landing (falling still hurts).' },
  { id: 'shield', name: 'Shield', price: 250,
    desc: 'Absorbs ALL damage from everyone else until your next turn begins.' },
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
