'use strict';
require('../js/config.js');
require('../js/names.js');
require('../js/terrain.js');
require('../js/weapons.js');
require('../js/ai.js');
require('../js/game.js');
const SE = globalThis.SE;
let worst = { ticks: 0, seed: 0 }, sum = 0, n = 40, bad = 0;
for (let seed = 1; seed <= n; seed++) {
  const seats = [];
  const cnt = 2 + (seed % 7); // mix of 2..8 players
  for (let i = 0; i < cnt; i++) seats.push({ human: false });
  const g = new SE.Game({ seed: seed * 7919, seats });
  g.start();
  let t = 0;
  while (g.state !== 'over' && t < 400000) { g.tick(); t++; }
  if (g.state !== 'over') { bad++; console.log('NOT FINISHED seed', seed, 'players', cnt, 'round', g.round); }
  else if (g.round > 40) console.log('long game seed', seed, 'players', cnt, 'round', g.round, 'shots', g.players.reduce((a, p) => a + p.shots, 0));
  sum += t;
  if (t > worst.ticks) worst = { ticks: t, seed: seed };
}
console.log('games:', n, 'unfinished:', bad, 'avg ticks:', (sum / n) | 0, 'worst:', worst.ticks, 'seed', worst.seed);
