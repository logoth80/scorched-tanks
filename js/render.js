/* =====================================================================
 * RENDERER — canvas only. Repaints terrain dirty rects into an offscreen
 * ImageData (ground = ONE flat color), draws sky, tanks, projectiles,
 * effects, particles, floaters and a short aiming preview.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});
const U = SE.util;
const CFG = SE.CONFIG;
const DEG = Math.PI / 180;

class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.game = game;
    this.ctx = canvas.getContext('2d');
    const W = CFG.W, H = CFG.H;

    /* sky, drawn once */
    this.sky = document.createElement('canvas');
    this.sky.width = W; this.sky.height = H;
    this._paintSky();

    /* terrain offscreen + ImageData */
    this.tcv = document.createElement('canvas');
    this.tcv.width = W; this.tcv.height = H;
    this.tctx = this.tcv.getContext('2d');
    this.img = this.tctx.createImageData(W, H);
    this.groundRGB = U.hexToRgb(CFG.GROUND_COLOR);
    this._paintTerrainAll();

    this.particles = [];
    this.floaters = [];
    this.shake = 0;
    this.time = 0;

    game.on('fx', this._onFx.bind(this));
    game.on('damage', function (e) {});
    game.on('kill', function (e) {});
  }

  /* ---------- static layers ---------- */
  _paintSky() {
    const c = this.sky.getContext('2d'), W = CFG.W, H = CFG.H;
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, CFG.SKY_TOP);
    g.addColorStop(0.55, CFG.SKY_MID);
    g.addColorStop(1, CFG.SKY_BOTTOM);
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const sunX = W * 0.82, sunY = H * 0.14;
    const sg = c.createRadialGradient(sunX, sunY, 4, sunX, sunY, 90);
    sg.addColorStop(0, U.rgbaOf(CFG.SUN, 0.9));
    sg.addColorStop(0.25, U.rgbaOf(CFG.SUN, 0.25));
    sg.addColorStop(1, 'rgba(255,233,168,0)');
    c.fillStyle = sg; c.fillRect(sunX - 100, sunY - 100, 200, 200);
  }

  _terrainPixelBytes() {
    const W = CFG.W, H = CFG.H;
    const d = this.game.terrain.data, px = this.img.data;
    const rgb = this.groundRGB;
    for (let i = 0, p = 0; i < d.length; i++, p += 4) {
      if (d[i]) { px[p] = rgb.r; px[p + 1] = rgb.g; px[p + 2] = rgb.b; px[p + 3] = 255; }
      else { px[p] = 0; px[p + 1] = 0; px[p + 2] = 0; px[p + 3] = 0; }
    }
  }
  _paintTerrainAll() {
    this._terrainPixelBytes();
    this.tctx.putImageData(this.img, 0, 0);
  }
  _repaintRects(rects) {
    const W = CFG.W;
    const d = this.game.terrain.data, px = this.img.data, rgb = this.groundRGB;
    for (const r of rects) {
      const x0 = r[0], y0 = r[1], x1 = Math.min(W, r[0] + r[2]), y1 = Math.min(CFG.H, r[1] + r[3]);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * W + x) * 4;
          if (d[y * W + x]) { px[p] = rgb.r; px[p + 1] = rgb.g; px[p + 2] = rgb.b; px[p + 3] = 255; }
          else { px[p + 3] = 0; }
        }
      }
      this.tctx.putImageData(this.img, 0, 0, x0, y0, x1 - x0, y1 - y0);
    }
  }

  /* ---------- effects ---------- */
  _onFx(e) {
    switch (e.kind) {
      case 'explosion': {
        // the damage circle was already telegraphed while it grew; this is the
        // pop at detonation — deliberately SLOW so it reads as one event:
        // flash → crater ring → a last shockwave to the telegraph edge → debris
        this.particles.push({ k: 'flash', x: e.x, y: e.y, r: e.r * 0.5, ttl: 16, t: 0 });
        this.particles.push({ k: 'ring', x: e.x, y: e.y, r0: 6, r1: e.r * 0.55, ttl: 26, t: 0 });
        this.particles.push({ k: 'ring', x: e.x, y: e.y, r0: e.r * 0.5, r1: e.r, ttl: 34, t: 0 });
        const n = Math.min(40, Math.round(e.r * 0.7));
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI - Math.PI; // upward-ish hemisphere
          const sp = 1 + Math.random() * (e.r / 26);
          this.particles.push({
            k: 'dirt', x: e.x, y: e.y, vx: Math.cos(a) * sp * (Math.random() < 0.5 ? -1 : 1),
            vy: Math.sin(a) * sp - 1, ttl: 44 + Math.random() * 36, t: 0,
          });
        }

        if (e.r > 55) this.shake = Math.max(this.shake, 10);
        break;
      }
      case 'fire':   // napalm hit: a splash of burning liquid
        for (let i = 0; i < 24; i++) {
          const a = Math.random() * Math.PI;
          const sp = 1.2 + Math.random() * 3.2;
          this.particles.push({
            k: 'drop', x: e.x, y: e.y,
            vx: Math.cos(a) * sp * 1.6, vy: -Math.sin(a) * sp,
            ttl: 26 + Math.random() * 18, t: 0,
          });
        }
        break;
      case 'spark':   // a small hit with no explosion
        this.particles.push({ k: 'spark', x: e.x, y: e.y, ttl: 14, t: 0 });
        for (let i = 0; i < 4; i++) {
          this.particles.push({ k: 'dust', x: e.x, y: e.y,
            vx: (Math.random() - 0.5) * 1.5, vy: -Math.random() * 0.8, ttl: 16 + Math.random() * 8, t: 0 });
        }
        break;
      case 'burst':
        this.particles.push({ k: 'ring', x: e.x, y: e.y, r0: 3, r1: 26, ttl: 10, t: 0 });
        break;
      case 'muzzle':
        this.particles.push({ k: 'muzzle', x: e.x, y: e.y, angle: e.angle, ttl: 6, t: 0 });
        break;
      case 'direct':
        this.particles.push({ k: 'spark', x: e.x, y: e.y, ttl: 12, t: 0 });
        this.shake = Math.max(this.shake, 6);
        break;
      case 'thud': case 'landing': case 'impact': case 'hop':
        for (let i = 0; i < 8; i++) {
          this.particles.push({ k: 'dust', x: e.x, y: e.y,
            vx: (Math.random() - 0.5) * 2, vy: -Math.random() * 1.2, ttl: 18 + Math.random() * 10, t: 0 });
        }
        break;
      case 'rolltrail':
        this.particles.push({ k: 'dust', x: e.x, y: e.y, vx: 0, vy: -0.3, ttl: 12, t: 0 });
        break;
      case 'dirt':
        this.particles.push({ k: 'ring', x: e.x, y: e.y, r0: 4, r1: e.r, ttl: 14, t: 0 });
        break;
      case 'shieldHit':
        this.particles.push({ k: 'shield', x: e.x, y: e.y, ttl: 14, t: 0 });
        break;
      case 'shieldOn':   // arming a shield from the bag: the dome implodes in
        this.particles.push({ k: 'ring', x: e.x, y: e.y, r0: 28, r1: 8, ttl: 10, t: 0 });
        this.particles.push({ k: 'shield', x: e.x, y: e.y, ttl: 12, t: 0 });
        break;
      case 'shieldBreak': {   // one hit eaten — the dome SHATTERS into shards
        this.particles.push({ k: 'shield', x: e.x, y: e.y, ttl: 8, t: 0 });
        for (let i = 0; i < 12; i++) {
          const a = Math.random() * Math.PI * 2, sp = 1.4 + Math.random() * 2.6;
          this.particles.push({ k: 'shard', x: e.x, y: e.y,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.6,
            ttl: 14 + Math.random() * 10, t: 0 });
        }
        break;
      }
      case 'deathExplosion':
        /* (kept for compatibility) — a wreck's blast now goes through the
           NORMAL 'explosion' fx like any ammo; nothing special to draw. */
        break;
      case 'parachute':
        break;
    }
  }

  addFloater(x, y, text, color) {
    this.floaters.push({ x: x, y: y, text: text, color: color, ttl: 75, t: 0 });
  }

  /* ---------- main frame ---------- */
  frame() {
    const game = this.game, ctx = this.ctx, W = CFG.W, H = CFG.H;
    this.time++;

    const rects = game.terrain.consumeRects();
    if (rects) this._repaintRects(rects);

    let ox = 0, oy = 0;
    if (this.shake > 0) {
      this.shake--;
      ox = (Math.random() - 0.5) * this.shake;
      oy = (Math.random() - 0.5) * this.shake;
    }
    ctx.save();
    ctx.translate(ox, oy);

    ctx.drawImage(this.sky, 0, 0);
    ctx.drawImage(this.tcv, 0, 0);
    this._drawFire();             // burning fluid hugs the ground, tanks wade/are swallowed by it
    /* the wind flag is NOT drawn in the world anymore — it lives in the HUD
       (a DOM element), so terrain, craters and shaking never touch it */

    for (const t of game.players) if (t.alive) this._drawTank(t);
    this._drawProjectiles();
    if (game.state === 'aim') this._drawAimPreview();
    this._drawBlastTelegraphs();
    this._drawParticles();
    this._drawFloaters();

    ctx.restore();
  }

  /* ---------- tanks: three tiny silhouettes, one color per player ---------- */
  _drawTank(t) {
    const ctx = this.ctx;
    const main = t.color.main, dark = t.color.dark;
    const x = t.x, fy = t.y;              // fy = ground line (feet)
    const v = t.variant;

    // tracks
    ctx.fillStyle = '#22242a';
    this._roundRect(x - 10, fy - 5, 20, 5, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let i = -8; i <= 8; i += 4) { ctx.beginPath(); ctx.arc(x + i, fy - 2.5, 1.3, 0, 7); ctx.fill(); }

    // hull (per-variant silhouette)
    ctx.fillStyle = main;
    if (v === 'compact') {
      this._roundRect(x - 8, fy - 10, 16, 5, 2); ctx.fill();
    } else if (v === 'stalker') {
      this._roundRect(x - 9, fy - 9, 14, 4, 2); ctx.fill();
      ctx.fillRect(x + 5, fy - 8, 4, 3);
    } else { // hauler: boxier, taller
      this._roundRect(x - 9, fy - 11, 18, 6, 2); ctx.fill();
    }
    // turret
    ctx.fillStyle = dark;
    this._roundRect(x - 3, fy - 13, 8, 4, 1.5); ctx.fill();

    // barrel follows aim (live for the active player)
    const angle = (t.id === this.game.currentId ? t.angle : 60) * DEG;
    const px = x, py = fy - CFG.TANK_H + 3;
    ctx.strokeStyle = dark;
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(angle) * CFG.BARREL_LEN, py - Math.sin(angle) * CFG.BARREL_LEN);
    ctx.stroke();

    // parachute canopy while deployed
    if (t.paraActive) {
      ctx.fillStyle = 'rgba(240,240,250,0.95)';
      ctx.beginPath();
      ctx.arc(x, fy - 26, 11, Math.PI, 0);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(220,220,235,0.8)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 9, fy - 26); ctx.lineTo(x - 3, fy - 14);
      ctx.moveTo(x + 9, fy - 26); ctx.lineTo(x + 3, fy - 14);
      ctx.stroke();
    }

    // shield bubble
    if (t.shield) {
      const pulse = 0.25 + 0.08 * Math.sin(this.time * 0.15);
      ctx.fillStyle = 'rgba(110,180,255,' + pulse + ')';
      ctx.beginPath(); ctx.arc(x, fy - 8, 17, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(160,210,255,0.8)'; ctx.lineWidth = 1.4; ctx.stroke();
    }

    // hp bar + name
    const bw = 20;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - bw / 2, fy - 22, bw, 3);
    ctx.fillStyle = t.hp > 50 ? '#5ad15a' : (t.hp > 25 ? '#e8b62c' : '#e0453a');
    ctx.fillRect(x - bw / 2, fy - 22, bw * (t.hp / CFG.HP), 3);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(t.name, x, fy - 25);

    // active marker
    if (t.id === this.game.currentId && this.game.state === 'aim') {
      const bob = Math.sin(this.time * 0.2) * 2;
      ctx.fillStyle = main;
      ctx.beginPath();
      ctx.moveTo(x - 4, fy - 32 + bob); ctx.lineTo(x + 4, fy - 32 + bob); ctx.lineTo(x, fy - 27 + bob);
      ctx.closePath(); ctx.fill();
    }
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------- projectiles ---------- */
  _drawProjectiles() {
    const ctx = this.ctx;
    for (const p of this.game.projectiles) {
      const hist = p._trail || (p._trail = []);
      hist.push([p.x, p.y]);
      if (hist.length > 14) hist.shift();
      ctx.strokeStyle = p.def.trail;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i < hist.length; i++) {
        const q = hist[i];
        if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
      }
      ctx.stroke();
      ctx.fillStyle = p.def.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.def.size, 0, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.def.size * 0.45, 0, 7);
      ctx.fill();
    }
  }

  /* ---------- aim preview: a few dots, not the full arc ---------- */
  _drawAimPreview() {
    const game = this.game, p = game.current();
    if (!p || !p.human) return;
    const def = SE.weaponById(p.selected) || SE.weaponById('basic');
    const speed = SE.Weapons.speedOf(def, p.power);
    let x = p.x + Math.cos(p.angle * DEG) * CFG.BARREL_LEN;
    let y = (p.y - CFG.TANK_H + 3) - Math.sin(p.angle * DEG) * CFG.BARREL_LEN;
    let vx = Math.cos(p.angle * DEG) * speed, vy = -Math.sin(p.angle * DEG) * speed;
    const g = CFG.GRAVITY * (def.launch.gravityScale || 1);
    const wf = game.wind * CFG.WIND_ACCEL * (def.launch.windScale || 1);
    const ctx = this.ctx;
    for (let i = 0; i < 30; i++) {
      for (let s = 0; s < 4; s++) { vy += g / 4; vx += wf / 4; x += vx / 4; y += vy / 4; }
      if (game.terrain.solid(x, y)) break;
      const a = 0.5 * (1 - i / 30);
      ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, 7); ctx.fill();
    }
  }

  /* ---------- blast telegraph: the damage circle grows from the impact
     point BEFORE anything is hurt — everyone can read the danger zone ---- */
  _drawBlastTelegraphs() {
    const ctx = this.ctx, G = CFG.BLAST_TELEGRAPH;
    for (const b of (this.game.blastsActive || [])) {
      const f = Math.min(1, b.t / G);
      const ease = f;   // steady linear growth — the danger zone is readable
                        // for its whole expansion, not over in a blink
      const r = Math.max(2, b.radius * ease);
      const fiery = b.burn > 0;
      ctx.fillStyle = fiery
        ? 'rgba(255,110,40,' + (0.13 + 0.05 * Math.sin(this.time * 0.3)) + ')'
        : 'rgba(255,150,60,' + (0.10 + 0.04 * Math.sin(this.time * 0.3)) + ')';
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, 7); ctx.fill();
      ctx.strokeStyle = fiery ? 'rgba(255,150,80,0.85)' : 'rgba(255,210,140,0.8)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -this.time * 0.6;
      ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
      if (f > 0.75) {
        ctx.strokeStyle = 'rgba(255,240,200,' + (0.3 + 0.5 * (f - 0.75) * 4) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(b.x, b.y, r + 2, 0, 7); ctx.stroke();
      }
    }
  }

  /* ---------- burns / particles / floaters ---------- */
  /* liquid fire (napalm): per-column burning fluid depth from terrain.fire,
     drawn as a dense molten body with bright flickering tips */
  _drawFire() {
    const T = this.game.terrain, ctx = this.ctx;
    const fire = T.fire;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let x = 0; x < T.W; x++) {
      const d = fire[x];
      if (d < 0.2) continue;
      const ty = T.tops[x];
      if (ty >= T.H) continue;
      const flick = 1 + 0.10 * Math.sin(this.time * 0.35 + x * 0.7) +
                    0.08 * Math.sin(this.time * 0.13 + x * 2.3);
      const h = Math.min(d * flick, 60);
      ctx.fillStyle = 'rgba(235,84,20,0.55)';                 // burning fluid body
      ctx.fillRect(x, ty - h, 1, h);
      ctx.fillStyle = 'rgba(255,205,80,0.45)';                // bright surface film
      ctx.fillRect(x, ty - h, 1, Math.min(h, 5 + d * 0.4));
      if ((x * 13 + this.time) % 19 === 0 && h > 3) {        // occasional flame tongue
        ctx.fillStyle = 'rgba(255,236,150,0.4)';
        ctx.fillRect(x, ty - h - 11 - (d | 0), 1, 13);
      }
    }
    ctx.restore();
  }

  _drawParticles() {
    const ctx = this.ctx;
    const G = this.groundRGB;
    this.particles = this.particles.filter(function (p) { return p.t < p.ttl; });
    for (const p of this.particles) {
      p.t++;
      const f = p.t / p.ttl;
      switch (p.k) {
        case 'ring': {
          const r = U.lerp(p.r0, p.r1, f);
          ctx.strokeStyle = 'rgba(255,200,120,' + (1 - f) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.stroke();
          break;
        }
        case 'flash':
          ctx.fillStyle = 'rgba(255,240,200,' + (0.8 * (1 - f)) + ')';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.5 + f * 0.5), 0, 7); ctx.fill();
          break;
        case 'dirt': case 'dust': {
          p.x += p.vx; p.y += p.vy; p.vy += 0.32;
          const s = p.k === 'dirt' ? 2 : 1.3;
          ctx.fillStyle = p.k === 'dirt'
            ? 'rgba(' + G.r + ',' + G.g + ',' + G.b + ',' + (1 - f) + ')'
            : 'rgba(200,180,150,' + (0.6 * (1 - f)) + ')';
          ctx.fillRect(p.x, p.y, s, s);
          break;
        }
        case 'drop': {   // burning napalm droplet — bright while it flies
          p.x += p.vx; p.y += p.vy; p.vy += 0.3;
          p.vx *= 0.99;
          ctx.fillStyle = 'rgba(255,' + (120 + ((1 - f) * 100 | 0)) + ',40,' + (1 - f * 0.7) + ')';
          ctx.fillRect(p.x, p.y, 2, 2);
          break;
        }
        case 'muzzle': {
          const a = (p.angle || 0) * DEG;
          ctx.strokeStyle = 'rgba(255,240,180,' + (1 - f) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + Math.cos(a) * 10 * (1 - f * 0.5), p.y - Math.sin(a) * 10 * (1 - f * 0.5));
          ctx.stroke();
          break;
        }
        case 'spark': {
          ctx.strokeStyle = 'rgba(255,255,160,' + (1 - f) + ')';
          ctx.lineWidth = 1.5;
          for (let i = 0; i < 6; i++) {
            const a = i / 6 * Math.PI * 2 + f * 2;
            const r1 = 3 + f * 12, r0 = r1 - 4;
            ctx.beginPath();
            ctx.moveTo(p.x + Math.cos(a) * r0, p.y + Math.sin(a) * r0);
            ctx.lineTo(p.x + Math.cos(a) * r1, p.y + Math.sin(a) * r1);
            ctx.stroke();
          }
          break;
        }
        case 'shard': {   // shield fragments / tank scrap — flung, gravity, spin
          p.x += p.vx; p.y += p.vy; p.vy += 0.22; p.vx *= 0.99;
          ctx.strokeStyle = p.c || ('rgba(160,215,255,' + (1 - f) + ')');
          ctx.globalAlpha = p.c ? (1 - f) : 1;
          ctx.lineWidth = 1.4;
          const a = (p.ttl - p.t) * 0.35;
          ctx.beginPath();
          ctx.moveTo(p.x - Math.cos(a) * 2.5, p.y - Math.sin(a) * 2.5);
          ctx.lineTo(p.x + Math.cos(a) * 2.5, p.y + Math.sin(a) * 2.5);
          ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        }
        case 'shield': {
          ctx.strokeStyle = 'rgba(140,200,255,' + (1 - f) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.x, p.y, 17 + f * 6, 0, 7); ctx.stroke();
          break;
        }
      }
    }
  }

  _drawFloaters() {
    const ctx = this.ctx;
    this.floaters = this.floaters.filter(function (fl) { return fl.t < fl.ttl; });
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    for (const fl of this.floaters) {
      fl.t++;
      fl.y -= 0.6;
      ctx.fillStyle = fl.color.replace('ALPHA', (1 - fl.t / fl.ttl).toFixed(2));
      ctx.fillText(fl.text, fl.x, fl.y);
    }
  }
}

SE.Renderer = Renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
