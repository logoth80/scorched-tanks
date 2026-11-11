/* =====================================================================
 * DESTRUCTIBLE PIXEL TERRAIN
 * - one bit of soil per pixel (Uint8Array), rendered in ONE color
 * - per-column `tops` cache + solid counts for fast queries
 * - dig() / add() modify single pixels; every change registers a dirty
 *   rect so the renderer only repaints what changed
 * - settleStep() runs the ONE "pixels fall down" rule until stable:
 *     ANY soil pixel with empty space directly below it drops toward it —
 *     at most FALL_RATE px per pass, so ground visibly FALLS instead of
 *     teleporting; a column ends as a solid stack from the floor up.
 *   There is NO sideways redistribution on purpose: a column of land never
 *   "slumps" into a pyramid — an intact slope stays exactly as generated.
 *   Mass is exactly conserved by settling; only dig/add change it.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});
const U = SE.util;

/* Deterministic position hash for the fissure's jagged profile — the same
   shot at the same place always tears exactly the same crack. */
function crackRand(n, salt) {
  let h = (Math.imul(n | 0, 2654435761) ^ Math.imul(salt | 0, 40503)) >>> 0;
  h = (h ^ (h >>> 15)); h = Math.imul(h, 2246822507) >>> 0;
  h = (h ^ (h >>> 13)); h = Math.imul(h, 3266489909) >>> 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

class Terrain {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.data = new Uint8Array(W * H);
    this.tops = new Int16Array(W);
    this.counts = new Int32Array(W);
    for (let x = 0; x < W; x++) this.tops[x] = H;
    /* liquid fire (napalm): depth px per column + remaining life frames */
    this.fire = new Float32Array(W);
    this.fireTtl = new Int16Array(W);
    this.fireOwner = new Int16Array(W).fill(-1);
    this._fflip = 0;
    this.rects = [];
  }

  /* ---------- procedural mountains (layered value noise) ---------- */
  generate(rand) {
    const W = this.W, H = this.H;
    this.data.fill(0);
    const h = new Float32Array(W);
    const octs = [[95, 150], [34, 62], [12, 24], [5, 8]];
    let mn = Infinity, mx = -Infinity;
    for (const oct of octs) {
      const g = this._grid(rand, oct[0]);
      for (let x = 0; x < W; x++) {
        h[x] += oct[1] * this._sampleGrid(g, x, oct[0]);
        if (h[x] < mn) mn = h[x];
        if (h[x] > mx) mx = h[x];
      }
    }
    for (let x = 0; x < W; x++) {
      const n = (h[x] - mn) / (mx - mn || 1);
      let gy = Math.round(H * (0.74 - n * 0.46));
      gy = U.clamp(gy, 90, H - 140);
      /* OPEN BORDERS: mountains fade to low open ground at the screen edges,
         so a shot that flies past the border flies off into sky — the border
         never stops a missile. */
      const EO = SE.CONFIG.EDGE_OPEN || 0;
      const edgeDist = Math.min(x, W - 1 - x);
      if (edgeDist < EO) {
        const t = edgeDist / EO;
        const s = t * t * (3 - 2 * t);
        gy = Math.round(U.lerp(H - 140, gy, s));
      }
      this.tops[x] = gy;
      this.counts[x] = H - gy;
      for (let y = gy; y < H; y++) this.data[y * W + x] = 1;
    }
    this.clearFire();
    this.rects = [[0, 0, W, H]];
  }

  _grid(rand, w) {
    const n = Math.ceil(this.W / w) + 2;
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = rand();
    return g;
  }
  _sampleGrid(g, x, w) {
    const f = x / w, i = Math.floor(f), t = f - i;
    const s = t * t * (3 - 2 * t);
    return g[i] * (1 - s) + g[i + 1] * s;
  }

  /* ---------- queries ---------- */
  solid(x, y) {
    /* the LEFT/RIGHT screen borders are OPEN SKY — nothing at the border
       stops or explodes a missile; a shot past the edge simply flies away.
       (y below the map stays solid: that is the ground you came from.) */
    if (x < 0 || x >= this.W) return false;
    if (y >= this.H) return true;
    if (y < 0) return false;
    /* MUST floor: Uint8Array with a fractional index yields undefined */
    return this.data[(y | 0) * this.W + (x | 0)] === 1;
  }
  top(x) {
    x = U.clamp(x | 0, 0, this.W - 1);
    return this.tops[x];
  }
  /* highest ground (smallest y) across a span — where a tank stands */
  supportY(x0, x1) {
    let y = this.H;
    for (let x = Math.max(0, x0 | 0); x <= Math.min(this.W - 1, x1 | 0); x++) {
      if (this.tops[x] < y) y = this.tops[x];
    }
    return y;
  }

  /* ---------- dirty rects for the renderer ---------- */
  addRect(x, y, w, h) {
    const x0 = U.clamp(x | 0, 0, this.W), x1 = U.clamp((x + w) | 0, 0, this.W);
    const y0 = U.clamp(y | 0, 0, this.H), y1 = U.clamp((y + h) | 0, 0, this.H);
    if (x1 > x0 && y1 > y0) this.rects.push([x0, y0, x1 - x0, y1 - y0]);
  }
  consumeRects() {
    if (!this.rects.length) return null;
    const r = this.rects; this.rects = [];
    return r;
  }

  refreshTop(x) {
    const W = this.W;
    let y = this.tops[x];
    if (y > this.H - 1) y = 0;
    while (y < this.H && this.data[y * W + x] === 0) y++;
    this.tops[x] = y;
  }

  /* ---------- destruction / creation ---------- */
  dig(cx, cy, r, yScale) {
    cx |= 0; cy |= 0; r |= 0;
    const ys = yScale > 0 && isFinite(yScale) ? yScale : 1;
    if (r <= 0) return;
    const x0 = Math.max(0, cx - r), x1 = Math.min(this.W - 1, cx + r);
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const w = Math.floor(Math.sqrt(Math.max(0, r * r - dx * dx)) * ys);
      const y0 = Math.max(0, cy - w), y1 = Math.min(this.H - 1, cy + w);
      let lo = -1, hi = -1, removed = 0;
      for (let y = y0; y <= y1; y++) {
        const idx = y * this.W + x;
        if (this.data[idx]) { this.data[idx] = 0; removed++; if (lo < 0) lo = y; hi = y; }
      }
      if (removed) {
        this.counts[x] -= removed;
        this.refreshTop(x);
        this.addRect(x, lo, 1, hi - lo + 1);
      }
    }
    this.addRect(cx - r, cy - r, 2 * r + 1, 2 * r + 1);
  }

  /* ---------- the Fissure Bomb: tear a long jagged crack ----------
     Pure ground removal with a jagged depth profile: deepest at the centre,
     tapering toward both ends. Deterministic from position + salt — the same
     shot tears exactly the same crack. Nothing "slumps" after: with vertical
     settling only, the fissure keeps its sharp walls forever. */
  crack(cx, halfLen, maxDepth, salt) {
    cx |= 0; halfLen |= 0;
    if (halfLen <= 0) return;
    const x0 = Math.max(0, cx - halfLen), x1 = Math.min(this.W - 1, cx + halfLen);
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(x - cx) / (halfLen + 1);        // 0 centre → ~1 edge
      if (d >= 1) continue;
      const jag = 0.55 + 0.45 * crackRand(x, salt);
      const depth = Math.round(maxDepth * (1 - d) * jag);
      if (depth <= 0) continue;
      const top = this.tops[x];
      const y1 = Math.min(this.H - 1, top + depth - 1);
      let removed = 0, lo = -1, hi = -1;
      for (let y = top; y <= y1; y++) {
        const idx = y * this.W + x;
        if (this.data[idx]) { this.data[idx] = 0; removed++; if (lo < 0) lo = y; hi = y; }
      }
      if (removed) {
        this.counts[x] -= removed;
        this.refreshTop(x);
        this.addRect(x, lo, 1, hi - lo + 1);
      }
    }
  }

  /* dirt bomb: pile fresh ground where it lands */
  add(cx, cy, r, raise) {
    cx |= 0; cy = (cy - (raise || 0)) | 0; r |= 0;
    if (r <= 0) return;
    const x0 = Math.max(0, cx - r), x1 = Math.min(this.W - 1, cx + r);
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const w = Math.floor(Math.sqrt(Math.max(0, r * r - dx * dx)));
      const y0 = Math.max(0, cy - w), y1 = Math.min(this.H - 1, cy + w);
      let minY = -1, placed = 0;
      for (let y = y0; y <= y1; y++) {
        const idx = y * this.W + x;
        if (!this.data[idx]) { this.data[idx] = 1; placed++; if (minY < 0) minY = y; }
      }
      if (placed) {
        this.counts[x] += placed;
        if (minY >= 0 && minY < this.tops[x]) this.tops[x] = minY;
      }
    }
    this.addRect(cx - r, cy - r, 2 * r + 1, 2 * r + 1);
  }

  /* ---------- liquid fire (napalm) — a burning FLUID on the ground -------
     fire[x] = depth in px of burning fluid on top of ground column x.
     TWO separate flow rules (so it behaves like heavy liquid fuel):
       1. LEVELING (slow): spreads only while its free SURFACE is uneven
          — this is gentle, fire does not "splash" sideways fast.
       2. SLIDING (faster): fire on sloped ground keeps moving toward the
          LOWER GROUND even when its surface is already level — that is
          what makes it run down mountains and fill valleys.
     It stays alive for fireTtl frames, then burns itself away. It never
     digs or adds soil — the ground only changes from ordinary blasts. -- */
  addFire(cx, r, depth, ttl, owner) {
    cx |= 0; r |= 0;
    if (r <= 0 || depth <= 0) return;
    const G = SE.CONFIG;
    const x0 = Math.max(0, cx - r), x1 = Math.min(this.W - 1, cx + r);
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const w = Math.sqrt(Math.max(0, r * r - dx * dx)) / r;   // round pour pattern
      this.fire[x] = Math.min(G.FIRE_MAX, this.fire[x] + depth * w);
      if (this.fireTtl[x] < ttl) {
        this.fireTtl[x] = ttl;
        this.fireOwner[x] = owner != null ? owner : -1;
      }
    }
  }

  /* one flow+burn pass — call once per game frame while fire is present */
  stepFire() {
    const W = this.W, G = SE.CONFIG, fire = this.fire, ttl = this.fireTtl, tops = this.tops;
    this._fflip ^= 1;
    const xs = this._fflip ? 0 : W - 2, xe = this._fflip ? W - 2 : 0, st = this._fflip ? 1 : -1;
    for (let x = xs; st > 0 ? x <= xe : x >= xe; x += st) {
      if (fire[x] <= 0 && fire[x + 1] <= 0) continue;
      let src = -1, dst = -1, amt = 0;
      /* rule 1 — slow LEVELING toward a flat fluid surface */
      const diff = (tops[x + 1] - fire[x + 1]) - (tops[x] - fire[x]);
      if (Math.abs(diff) >= G.FIRE_MIN_LEVEL) {
        src = diff > 0 ? x : x + 1; dst = diff > 0 ? x + 1 : x;
        amt = Math.min(Math.abs(diff) / 2, G.FIRE_FLOW, fire[src]);
      }
      /* rule 2 — SLIDING down the ground slope; this one dominates */
      const gd = tops[x + 1] - tops[x];             // >0: ground drops to the right
      if (Math.abs(gd) >= G.FIRE_SLIDE_STEP) {
        const s2 = gd > 0 ? x : x + 1, d2 = gd > 0 ? x + 1 : x;
        if (fire[s2] >= G.FIRE_SLIDE_DEPTH) {
          const a2 = Math.min(fire[s2], fire[s2] * 0.45, G.FIRE_SLIDE);
          if (a2 > amt) { src = s2; dst = d2; amt = a2; }
        }
      }
      if (src < 0 || amt <= 0) continue;
      fire[src] -= amt; fire[dst] += amt;
      /* the burning STATE travels with the fluid: the receiver inherits the
         donor's remaining life, so fire flowing down a hill still burns */
      if (ttl[src] > ttl[dst]) { ttl[dst] = ttl[src]; this.fireOwner[dst] = this.fireOwner[src]; }
      if (fire[src] < 0.02) fire[src] = 0;
      if (fire[dst] < 0.02) fire[dst] = 0;
    }
    for (let x = 0; x < W; x++) {
      if (ttl[x] > 0) { ttl[x]--; fire[x] *= G.FIRE_KEEP; }
      else if (fire[x] > 0) {
        fire[x] *= G.FIRE_BURNOUT;
        if (fire[x] < 0.05) { fire[x] = 0; this.fireOwner[x] = -1; }
      }
    }
  }

  hasFire() {
    const f = this.fire;
    for (let x = 0, n = f.length; x < n; x++) if (f[x] > 0) return true;
    return false;
  }
  clearFire() {
    this.fire.fill(0);
    this.fireTtl.fill(0);
    this.fireOwner.fill(-1);
  }

  /* ---------- "land pixels fall down" — one relaxation pass ----------
     The ONLY rule: a soil pixel with empty space directly under it falls.
     There is deliberately NO sideways slumping — a column of land keeps its
     full height forever. An untouched mountain never "settles" at all. */
  settleStep() {
    const W = this.W, H = this.H, G = SE.CONFIG;
    let moved = 0;

    /* soil FALLS into holes — each pixel drops at most FALL_RATE px
       per pass, so a collapse reads as ground falling, not teleporting.
       Bottom→top scan: every pixel moves at most once per pass. */
    const FR = Math.max(1, G.FALL_RATE | 0);
    for (let x = 0; x < W; x++) {
      if (this.counts[x] === H - this.tops[x]) continue; // already a clean stack
      let fell = 0;
      for (let y = H - 2; y >= 0; y--) {
        const idx = y * W + x;
        if (!this.data[idx]) continue;
        if (this.data[idx + W]) continue;                // resting on soil
        let d = 1;                                       // fall through clear air
        while (d < FR && y + d + 1 < H && this.data[idx + (d + 1) * W] === 0) d++;
        this.data[idx] = 0;
        this.data[idx + d * W] = 1;
        fell++;
      }
      if (fell) {
        this.refreshTop(x);                              // counts unchanged: pure fall
        this.addRect(x, 0, 1, H);
        moved++;
      } else if (this.counts[x] !== H - this.tops[x]) {
        /* self-heal: tops can go stale after a collapse while the stack is
           actually fine — without this, settling deadlocks on a phantom top */
        this.refreshTop(x);
      }
    }
    return moved;
  }

  countSolid() {
    let c = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i]) c++;
    return c;
  }
}

SE.Terrain = Terrain;
})(typeof globalThis !== 'undefined' ? globalThis : this);
