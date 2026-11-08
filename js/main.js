/* =====================================================================
 * BOOTSTRAP — wires UI + Game + Renderer and runs the fixed-step loop.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});
const CFG = SE.CONFIG;

window.addEventListener('load', function () {
  const canvas = document.getElementById('game');
  const ui = new SE.UI();
  ui.showSetup();

  let game = null, renderer = null, running = false;

  function newGame(cfg) {
    const seed = (Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0;
    game = new SE.Game({ seats: cfg.seats, battles: cfg.battles, seed: seed });
    renderer = new SE.Renderer(canvas, game);
    ui.attach(game, renderer);
    document.getElementById('setupModal').classList.add('hidden');
    document.getElementById('overModal').classList.add('hidden');
    game.start();
    if (!running) {
      running = true;
      requestAnimationFrame(frame);
    }
  }

  let last = 0, acc = 0;
  const STEP = 1 / 60;
  function frame(now) {
    if (!last) last = now;
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    let guard = 0;
    while (acc >= STEP && guard++ < 4) {
      if (game) game.tick();
      acc -= STEP;
    }
    if (renderer) renderer.frame();
    requestAnimationFrame(frame);
  }

  /* buttons on the modals (UI handles gameplay controls) */
  document.getElementById('startBtn').addEventListener('click', function () {
    SE.sfx.init();
    newGame(ui.readSetup());
  });
  document.getElementById('againBtn').addEventListener('click', function () {
    SE.sfx.init();
    const seats = ui.readSetup();
    ui.detach();
    newGame(seats);
  });
  document.getElementById('toSetupBtn').addEventListener('click', function () {
    ui.detach();
    ui.showSetup();
  });
  window.__dshRestartToSetup = function () {
    ui.detach();
    ui.showSetup();
  };
});
})(window);
