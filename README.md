# Scorched Tanks

A 2D **Scorched Earth remake** that runs straight in the browser — no build step, no
dependencies, no server-side code. 2–8 players (human hotseat or CPU), procedurally
generated 1024×768 mountains where **every pixel of ground is destructible**, and a
classic turn-based artillery economy.

## Play it directly from GitHub (GitHub Pages)

1. Create a repository on GitHub and push this folder to it:
   ```sh
   git init
   git add -A
   git commit -m "Scorched Tanks"
   git remote add origin https://github.com/USERNAME/REPO.git
   git branch -M main
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / root**.
3. The game is live at `https://USERNAME.github.io/REPO/` — there is nothing to build.

Locally, just open `index.html` in any modern browser (it works from `file://` too).

## How a match works

- A **match = a series of battles** (3 by default, changeable on the setup screen and in
  `js/config.js`). Tanks are placed **randomly on brand-new terrain for every battle**.
- The **shop runs only before the first battle and between battles** — never mid-battle.
  Money and purchased ammo **carry over**; HP and fuel reset each battle.
- Each turn: change barrel angle, pick power (or drag on the field to aim & fire),
  optionally drive (fuel!), choose ammo, fire. **Wind is re-rolled every turn.**
- Turn resolution is strictly ordered, so nothing "happens behind your back":
  1. the shot resolves — every projectile finishes, and each explosive shows its
     **damage circle growing** from the impact point,
  2. the circle finishes growing → **ground and players take damage** (craters dug,
     dirt mounds built),
  3. **the ground falls**: soil collapses into every hole and slumps down over-steep
     slopes until stable (mass is exactly conserved),
  4. **tanks fall** if their ground went away, and **fall damage** is applied.
- Direct hit = 100 damage = always lethal. Blast damage falls off inside the shown
  circle. Kill rewards, battle-win and survival pays fund your shopping.
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
are implemented once in [`js/weapons.js`](js/weapons.js) (`explode`, `cluster`, `roll`,
`multiblast`, `addground`). Current lineup:

| Ammo | Effect |
|---|---|
| Basic Shot | free, unlimited |
| Cluster Bomb | splits at the apex into 4 bomblets raining down |
| Roller | lands, **rolls along the mountain** until a wall or tank stops it, then blows |
| Napalm | huge fire radius, **wide shallow crater** (`craterY` squashes the dig) |
| Big Bomb | three overlapping staggered blasts |
| Dirt Bomb | **builds a mound of ground** instead of destroying it |

Example of adding your own in seconds:

```js
{
  id: 'mega', name: 'Mega Shot', price: 900, count: 1,
  desc: 'Absurd single blast.', color: '#ff0', trail: 'rgba(255,255,0,0.6)', size: 4,
  launch: { speedScale: 1.1, gravityScale: 1.0, windScale: 1.0, drag: 0 },
  behavior: 'explode',
  explosion: { radius: 95, damage: 100, crater: 0.95 },   // craterY optional
}
```

## Controls

- **Drag on the field** to aim & fire, or: ←/→ angle, ↑/↓ power, **Space** fire,
  **1–6** select ammo, **A/D** drive.
- Setup screen picks players (HUMAN/CPU mix), seat names, and battle count.

## Tests

The engine is DOM-free, so the whole game can be simulated headless:

```sh
node test/sim.js      # terrain invariants, every weapon, strict turn order,
                      # multi-battle match flow, 5 seeded full matches + an 8P match
node test/stress.js   # 40 seeded matches: all must terminate
```

## Files

| File | What lives there |
|---|---|
| `js/config.js` | **every tunable** — physics, economy, terrain stability, the ammo table |
| `js/terrain.js` | pixel terrain: one bit per pixel, hole collapse + slope slumping |
| `js/weapons.js` | projectile behaviors shared by all ammo definitions |
| `js/game.js` | match/battle/turn state machine, resolution order, economy |
| `js/ai.js` | CPU aiming (trajectory sampling against terrain) and shopping |
| `js/render.js` | canvas: single-color terrain via dirty-rect repaint, sprites, effects |
| `js/ui.js` | DOM: setup, shop, HUD, turn panel, scoreboard |
| `js/main.js` | bootstrap + fixed-step 60 Hz loop |

## Design interpretations

The brief said "tanks placed randomly each round" and "each round starts with a shop".
Since battles now reshape the map, placement and shops are done **per battle** (fresh
terrain + random placement each battle; shop before each battle). A "round" inside a
battle means one turn cycle of every living tank — that's what the storm counts.
