/* =====================================================================
 * names.js — the nickname list. CPU seats draw their in-game name from
 * HERE, shuffled per game (a seat keeps its nickname for the whole
 * match). Add/remove freely — keep entries short (shown in the player
 * strip), unique, and family-friendly. Fallback if this file is missing:
 * the engine still uses "CPU n".
 * ===================================================================== */
(function (g) {
  'use strict';
  var SE = (g.SE = g.SE || {});

  SE.NAMES = [
    'Boomhild', 'Gunther', 'Kaboom Kate', 'Shell Shock', 'Baron Blitz',
    'Powder Peg', 'Craterface', 'Ricochet', 'Shrapnel', 'Deadeye',
    'Gen. Tnt', 'Sgt. Soot', 'Moley', 'Diggy Doug', 'Hopalong',
    'Cannonball', 'Windy Bill', 'Spitfire', 'Greasegun', 'Old Smokey',
    'Betsy', 'Big Bertha', 'Anzio Annie', 'Sparky', 'Tumbleweed',
    'Sidewinder', 'Long Tom', 'Mortar Marty', 'Firefly', 'Dusty',
    'Slugger', 'Bomber Bill', 'Sticky', 'Napalm Ned', 'Gunpowder',
    'Tricky Vic', 'Lobber', 'Torque', 'Crankcase', 'Kilowatt',
    'Fizzy', 'Wobbly', 'Pistons', 'Hoppity', 'Boom Bus',
  ];
})(typeof globalThis !== 'undefined' ? globalThis : this);
