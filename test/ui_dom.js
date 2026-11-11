'use strict';
/* Headless DOM smoke test for the UI layer — no browser here, so we stub
   just enough DOM for ui.js to run, then verify the three UI features:
     1. the player card strip is SORTED by the dealt shot order (and re-sorted
        when a new map re-deals it), with the position number on each card
     7. the ammo list is an openable dropdown (closed by default, label follows
        the current selection)
     4. the "raise shield" button appears only when the bag holds one, it is
        your own human turn, and you are not shielded yet.
   Run: node test/ui_dom.js
*/

/* ---------------- tiny DOM stub ---------------- */
function makeEl(id) {
  const el = {
    id: id || 'dyn', children: [], style: {}, dataset: {}, _cls: new Set(), _html: '',
    textContent: '', disabled: false,
    addEventListener() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 1024, height: 768 }; },
    appendChild(c) { el.children.push(c); return c; },
    insertBefore(n, ref) { const i = el.children.indexOf(ref); if (i < 0) el.children.push(n); else el.children.splice(i, 0, n); return n; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    get childNodes() { return el.children; },
    get firstChild() { return el.children[0] || null; },
    classList: {
      add(c) { el._cls.add(c); }, remove(c) { el._cls.delete(c); },
      toggle(c, on) { if (on === undefined) on = !el._cls.has(c); if (on) el._cls.add(c); else el._cls.delete(c); },
      contains(c) { return el._cls.has(c); },
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); if (v === '') el.children.length = 0; },
  });
  return el;
}
const registry = {};
global.document = {
  getElementById(id) { if (!registry[id]) registry[id] = makeEl(id); return registry[id]; },
  createElement(tag) { return makeEl(tag); },
  addEventListener() {},
};
if (typeof globalThis.addEventListener !== 'function') globalThis.addEventListener = function () {};
global.window = globalThis;   // ui.js picks window as its root — alias it,
                             // so every module shares ONE SE namespace (as in a browser)

/* ---------------- game + UI ---------------- */
require('../js/config.js');
require('../js/names.js');
require('../js/terrain.js');
require('../js/weapons.js');
require('../js/ai.js');
require('../js/game.js');
/* sfx stub — no audio in node; ui.js calls it from event handlers */
const SEPRE = globalThis.SE;
SEPRE.sfx = { init() {}, muted: false };
['chime', 'click', 'shot', 'explosion', 'hit', 'death', 'buy', 'chute'].forEach(function (k) { SEPRE.sfx[k] = function () {}; });
require('../js/ui.js');
const SE = globalThis.SE;
const CFG = SE.CONFIG;

let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok  ' + name); }
  else { fails++; console.log(' FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

function seatset(n) { const a = []; for (let i = 0; i < n; i++) a.push({ human: true }); return a; }

const g = new SE.Game({ seed: 77, seats: seatset(4), battles: 2 });
g.start();                                       // shop phase
while (g.state === 'shop') g.endCurrentBuyer();  // straight to the dealt order
for (const p of g.players) p.hp = 1e9;           // keep everyone for the test

const ui = new SE.UI();
ui.attach(g, { addFloater() {} });

check('game is in aim state with 4 seats', g.state === 'aim' && g.players.length === 4);

/* --- 1. card strip mirrors the dealt shot order --- */
function stripOrder() {
  ui._updateCards();
  const kids = registry.playerCards.children;
  return kids.map(function (c) {
    const ord = /cOrd[^>]*>(\d+)</.exec(c.innerHTML);
    const nm = /<b>([^<]*)<\/b>/.exec(c.innerHTML);
    return { ord: ord ? parseInt(ord[1], 10) : -1, name: nm ? nm[1] : '?' };
  });
}
let strip = stripOrder();
let want = g.roundOrder.map(function (id) { return g.playerById(id).name; });
check('card strip equals the dealt shot order', strip.map(function (s) { return s.name; }).join('|') === want.join('|'),
  strip.map(function (s) { return s.name; }).join('|') + ' vs ' + want.join('|'));
check('each card carries its position number', strip.every(function (s, i) { return s.ord === i + 1; }),
  JSON.stringify(strip.map(function (s) { return s.ord; })));

// a new map re-deals the order → the strip must follow it
let changed = false;
for (let t = 0; t < 12 && !changed; t++) { g._beginRound(); changed = g.roundOrder.join(',') !== want.join(','); }
if (changed) {
  strip = stripOrder();
  want = g.roundOrder.map(function (id) { return g.playerById(id).name; });
  check('after a NEW MAP the strip re-sorts to the new order',
    strip.map(function (s) { return s.name; }).join('|') === want.join('|'));
} else {
  check('a new map eventually deals a different order', false, 'never changed in 12 deals');
}
g._beginRound();                                  // fresh, predictable state for the rest

/* --- 7. ammo list is an openable dropdown --- */
const p = g.current();
ui._syncTurnPanel();
check('ammo list starts CLOSED', registry.ammoRow.classList.contains('hidden'));
check('the picker button shows the current selection',
  /Basic/.test(registry.ammoPickName.textContent),
  JSON.stringify(registry.ammoPickName.textContent));
p.ammo.leapfrog = 2; p.ammo.funny = 1;
g.selectWeapon(p.id, 'leapfrog');
ui._ammoOpen = true;                              // opened by the button
ui._syncTurnPanel();
check('when opened, the list is visible', !registry.ammoRow.classList.contains('hidden'));
check('the list contains the NEW ammunition with stock counts',
  /Leap Frog 2/.test(registry.ammoRow.innerHTML) && /Funny Bomb 1/.test(registry.ammoRow.innerHTML),
  registry.ammoRow.innerHTML.replace(/\n/g, '').slice(0, 200));
check('picker label follows the selection',
  /Leap Frog 2/.test(registry.ammoPickName.textContent), JSON.stringify(registry.ammoPickName.textContent));

/* --- 4. raise-shield button: only when it would actually work --- */
const sb = registry.useShieldBtn;
p.ammo.shield = 2; p.shield = false;
ui._syncTurnPanel();
check('button appears when the bag has shields on my own turn',
  sb.style.display !== 'none' && registry.shieldBag.textContent === 2,
  'display=' + sb.style.display + ' bag=' + registry.shieldBag.textContent);
p.shield = true;
ui._syncTurnPanel();
check('button hides while already shielded', sb.style.display === 'none');
p.shield = false; p.ammo.shield = 0;
ui._syncTurnPanel();
check('button hides with an empty bag', sb.style.display === 'none');

// the real click path: bind nothing — call the engine the button would call
p.ammo.shield = 1;
check('and the engine action the button calls works from the aim phase',
  g.useShield(p.id) === true && p.shield === true && p.ammo.shield === 0);

/* --- the shield is ALSO a one-click entry INSIDE the open ammo list --- */
p.shield = false; p.ammo.shield = 2;
ui._ammoOpen = true;
ui._syncTurnPanel();
check('the open list offers "Raise shield" with the bag count next to the ammo',
  /data-shield/.test(registry.ammoRow.innerHTML) && /Raise shield 2/.test(registry.ammoRow.innerHTML),
  registry.ammoRow.innerHTML.replace(/\n/g, '').slice(0, 240));
check('ammo entries stay clickable (enabled, carry their id)',
  /data-wid="funny"/.test(registry.ammoRow.innerHTML) &&
  /<button class="ammoBtn" data-wid="funny"[^>]*>Funny Bomb 1/.test(registry.ammoRow.innerHTML) &&
  !/data-wid="funny"[^>]*disabled/.test(registry.ammoRow.innerHTML),
  registry.ammoRow.innerHTML.replace(/\n/g, '').slice(0, 240));
p.shield = true;
ui._syncTurnPanel();
check('the list entry disappears while already shielded',
  !/data-shield/.test(registry.ammoRow.innerHTML));
p.shield = false; p.ammo.shield = 0;
ui._syncTurnPanel();
check('the list entry disappears with an empty bag',
  !/data-shield/.test(registry.ammoRow.innerHTML));
// the list click calls exactly this engine action:
p.ammo.shield = 1;
check('the action the list entry calls raises the shield and spends the bag',
  g.useShield(p.id) === true && p.shield === true && p.ammo.shield === 0);

/* the wind flag is a pure DOM widget — terrain can never cover it,
   and it must read strength AND direction from the wind event */
g.emit('wind', { wind: -9 });
check('strong wind: flag stretches wide and mirrors to point left',
  parseInt(ui.el.flagCloth.style.width, 10) >= 18 && ui.el.flagMount.style.transform.indexOf('scaleX(-1)') >= 0,
  'w=' + ui.el.flagCloth.style.width + ' t=' + ui.el.flagMount.style.transform);
check('strong wind flutters fast',
  parseFloat(ui.el.flagCloth.style.animationDuration) < 0.8,
  'dur=' + ui.el.flagCloth.style.animationDuration);
g.emit('wind', { wind: 10 });
check('right wind: no mirroring, cloth longer than calm',
  ui.el.flagMount.style.transform.indexOf('scaleX') < 0 &&
  parseInt(ui.el.flagCloth.style.width, 10) >= 20,
  'w=' + ui.el.flagCloth.style.width + ' t=' + ui.el.flagMount.style.transform);
g.emit('wind', { wind: 0 });
check('dead calm: the cloth hangs down the pole',
  ui.el.flagMount.style.transform.indexOf('rotate(84deg)') >= 0 &&
  parseInt(ui.el.flagCloth.style.width, 10) <= 6,
  'w=' + ui.el.flagCloth.style.width + ' t=' + ui.el.flagMount.style.transform);

console.log(fails ? '\nFAILURES: ' + fails : '\nALL UI DOM CHECKS PASSED');
process.exit(fails ? 1 : 0);
