# Scorched Tanks

A 2D **Scorched Earth remake** that runs straight in the browser — no build step, no
dependencies, no server-side code. 2–8 players (human hotseat or CPU), procedurally
generated 1024×768 mountains where **every pixel of ground is destructible**, and a
classic turn-based artillery economy.

## Play it online

**https://logoth80.github.io/scorched-tanks/** — that's the live game, served straight
from this repo by GitHub Pages. Nothing to build; the repo root *is* the web root.

Locally, just open `index.html` in any modern browser (it works from `file://` too).
Forking to your own GitHub? Push the folder and enable **Settings → Pages →
Deploy from a branch → default branch / root** — it will serve `index.html` the same way.

## How a match works

- A **match = a series of battles** (3 by default, changeable on the setup screen and in
  `js/config.js`). Every battle gets **brand-new terrain and a fresh placement — and the
  spawn slots themselves are re-shuffled between seats**, so seat 1 is not "always the
  left one" (each tank still keeps a guaranteed personal slice, no spawning on top
  of each other).
- **Turn order is dealt when a new map spawns** (a random shuffle of the seats) and
  then **stays fixed for that whole fight** — dead tanks are simply skipped. Only the
  next battle's fresh map re-deals it.
- CPU tanks get **random nicknames** (Boomhild, Baron Blitz, Anzio Annie…) from
  `js/names.js` — unique per game, kept for the whole match, easy to extend.
- The **shop runs only before the first battle and between battles** — never mid-battle.
  Money and purchased ammo **carry over**; HP and fuel reset each battle.
- Each turn: change barrel angle, pick power (or drag on the field to aim & fire),
  optionally drive (fuel!), choose ammo, fire. **Your angle, power and selected
  ammo are remembered for your next turn** — artillery is played by correcting,
  so you only ever fine-tune. **Wind is re-rolled every turn and it bites
  hard** (up to ±12 — lead it or lose it).
- Turn resolution is strictly ordered, so nothing "happens behind your back":
  1. the shot resolves — every projectile finishes, and each explosive shows its
     **damage circle growing** from the impact point,
  2. the circle finishes growing → **ground and players take damage** (craters dug,
     dirt mounds built),
  3. **the ground falls**: soil collapses into every hole and slumps down over-steep
     slopes until stable (mass is exactly conserved),
  4. **tanks fall** if their ground went away, and **fall damage** is applied,
  5. **burning ground keeps burning**: if any liquid fire is still alive, the game
     *waits right there* — the next player only starts **once the fire has
     vanished** (hard-capped by `FIRE_WAIT_MAX` so it can never hang forever).
- Direct hit / **tank fully inside a blast circle = 100 damage = always lethal**
  (measured to the tank's farthest corner). Blast damage falls off only for tanks
  *partially* inside the shown circle. Shields block either case.
- **Every tank is paid at the end of each battle: $700 plus $100 for every enemy it
  outlasted** (survivors outlast all dead tanks; tanks that die in the same exchange
  tie). Kills pay an extra bonus during battle. No separate "win bonus" — placement
  inside the battle already pays.
- Tanks **spawn in their own guaranteed slice of the map** — two tanks can never
  spawn touching, whatever the RNG does — and **which seat gets which slice is
  re-shuffled every battle**.
- Anti-stalemate "storm": from round 14 every survivor is harmed a little more each
  round, so no match can drag forever (fully tunable).

## Tanks, fuel, and items

- Tanks are tiny 3-variant sprites, one color per player (up to 8).
- **Fuel is total, never refilled: 5 tank-lengths per battle**, and tanks never climb
  steep slopes — repositioning is a rare, precious action.
- **Parachutes** auto-open on long falls (falling still hurts without one; with one,
  fall damage is cut hard). **Shields** absorb all damage from everyone else — until
  your own next turn begins.

## Ammunition

All ammo lives in one table in [`js/config.js`](js/config.js) — copy an entry, change
numbers, and it shows up in the shop and the AI's decisions automatically. Behaviors
are implemented once in [`js/weapons.js`](js/weapons.js) (`explode`, `thud`, `cluster`,
`roll`, `multiblast`, `addground`, `fire`). Each weapon's `launch` block can tune
`speedScale / gravityScale / windScale / drag` and a per-shot **fall-speed cap**
(`terminal` — small values make ordnance *drift*). Current lineup:

| Ammo | Effect |
|---|---|
| Basic Shot | free, unlimited |
| Cluster Bomb | **splits just before its apex into 3 bomblets**: one continues on the original trajectory, one lands a bit further, one further still — a range ladder of small blasts |
| Roller | lands, **rolls along the mountain** until a wall or tank stops it, then blows |
| Napalm | **pours liquid fire** — no blast, no crater: a burning FLUID that flows down slopes, pools in valleys and stays alive for 5 s; see below |
| Big Bomb | three overlapping staggered blasts |
| Dirt Bomb | **builds a mound of ground** instead of destroying it |

**Liquid fire** is a per-column fluid (`js/terrain.js`: `fire[]` + flow/burn rules).
It behaves like heavy liquid fuel: it **spreads sideways only slowly** (gentle
surface leveling), but **slides fast down any slope** and fills valleys and low
ground; it burns for `fire.life` frames, then shrinks away. Touching it hurts over
time (`FIRE_DOT` every `FIRE_TICK` frames); a tank **fully submerged** in the fluid
(depth ≥ tank height) dies on the spot — unless shielded. The fire's owner gets
credit for the kill, and the kill's battle-death order feeds the outlast payout.
And the turn **does not pass on while the ground is burning**: resolution simply
waits until the fire has vanished (capped by `FIRE_WAIT_MAX`). All knobs
(`FIRE_MAX/FLOW/MIN_LEVEL/SLIDE/SLIDE_STEP/SLIDE_DEPTH/KEEP/BURNOUT/DOT/TICK/WAIT_MAX`)
are in `config.js`.

Every explosion's **damage circle** (`explosion.radius`) is deliberately decoupled
from the **crater** it digs (`explosion.crater` × radius) — every *explosive* weapon
digs the full circle (a blast removes everything it shows), while the dirt bomb's
small defensive blast builds instead of digs. All damage radii are 1.5× by design;
the circles are telegraphed on screen before anything detonates, so bigger danger
stays fair.

The **power dial reaches 200** (`POWER_MAX`; 100 = normal muzzle speed, 200 = 2×).
High power is a real choice: longer flight, harder to read the wind, and a
backboarded shot can sail over the target.

The map's **left/right screen borders are open sky** — mountains fade to low
ground near the edges (`EDGE_OPEN`), so a missile that flies past the border
flies away; nothing explodes "against the wall".

Example of adding your own in seconds:

```js
{
  id: 'mega', name: 'Mega Shot', price: 900, count: 1,
  desc: 'Absurd single blast.', color: '#ff0', trail: 'rgba(255,255,0,0.6)', size: 4,
  launch: { speedScale: 1.1, gravityScale: 1.0, windScale: 1.0, drag: 0, terminal: 0 },
  behavior: 'explode',
  explosion: { radius: 95, damage: 100, crater: 1.0 },   // craterY optional
}
```

## Controls

- **Drag on the field** to aim & fire, or: **←/→** barrel angle (← aims left),
  **↑/↓** power (1–200), **Space** fire, **1–6** select ammo, **A/D** drive.
- Your aim (angle/power) and chosen ammo **carry over to your next turn** —
  correct like a real artillery spotter instead of re-dialing from scratch.
- Setup screen picks players (HUMAN/CPU mix), seat names, and battle count —
  and **remembers them** (browser localStorage), so the next start opens with
  your usual table already dialed in.
- The player strip (health / fuel / money / ammo for everyone) lives along the
  **bottom of the screen** so it never covers the leftmost tank; the event log
  sits above it on the right.

## The CPU (and how to make it nicer or meaner)

The AI simulates real ballistics against the terrain, **remembers its last shot and
where it landed, and brackets you like a human**: short → more power, long → less,
off to the side → angle tweak. It finishes wounded tanks first, avoids parking its
own blast next to itself, and won't spend bought ammo when a free Basic Shot would
score the same hit. It aims with **tunable human imperfection** — all in
`js/config.js`:

```js
AI_JITTER_ANGLE: 3.0,   // degrees of sloppiness on the final pick
AI_JITTER_POWER: 5,     // power units of sloppiness
AI_WIND_BLUNDER: 1.6,   // how wrong it "reads" the wind
AI_TOPK: 3,             // picks randomly among its best K plans
```

Set them near zero for a brutal tournament CPU, raise them for a fun-beatable one.

## Tests

The engine is DOM-free, so the whole game can be simulated headless:

```sh
node test/sim.js      # terrain invariants, open map borders, every weapon incl.
                      # liquid-fire flow/kill rules, power cap, strict turn pipeline,
                      # nicknames, per-map-dealt (fight-fixed) turn order, random spawn
                      # slots, multi-battle match flow, 5 seeded full matches + an 8P match
node test/stress.js   # 40 seeded matches: all must terminate
```

## Files

| File | What lives there |
|---|---|
| `js/config.js` | **every tunable** — physics, economy, terrain stability, fire fluid, the ammo table |
| `js/names.js` | CPU nickname list — add/remove entries freely, the game draws from it |
| `js/terrain.js` | pixel terrain: one bit per pixel, hole collapse + slope slumping, liquid-fire fluid |
| `js/weapons.js` | projectile behaviors shared by all ammo definitions |
| `js/game.js` | match/battle/turn state machine, resolution order, turn-order dealing, economy |
| `js/ai.js` | CPU aiming (trajectory sampling against terrain) and shopping |
| `js/render.js` | canvas: single-color terrain via dirty-rect repaint, sprites, effects |
| `js/ui.js` | DOM: setup, shop, HUD, turn panel, scoreboard |
| `js/main.js` | bootstrap + fixed-step 60 Hz loop |

## Design interpretations

The brief said "tanks placed randomly each round" and "each round starts with a shop".
Since battles now reshape the map, placement and shops are done **per battle** (fresh
terrain + random placement each battle; shop before each battle). A "round" inside a
battle means one turn cycle of every living tank — that's what the storm counts.
"Randomise who starts the round" is implemented as **dealing a shuffled order when
each new map spawns and keeping it fixed for that entire fight** — random per battle,
predictable mid-fight (dead tanks are skipped); and
"player location should be random" is done by **re-dealing spawn slots to seats**
each battle — the per-seat guaranteed spacing still holds because the guarantee is
positional, not seat-based.

## License

MIT — free to use, modify and redistribute (see [LICENSE](LICENSE)).
"Scorched Earth" is an existing game by Reflexive Entertainment; this is an
independent homage/remake, sharing no code or assets with it.
