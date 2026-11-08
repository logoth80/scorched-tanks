/* =====================================================================
 * DESTRUCTIBLE PIXEL TERRAIN
 * - one bit of soil per pixel (Uint8Array), rendered in ONE color
 * - per-column `tops` cache + solid counts for fast queries
 * - dig() / add() modify single pixels; every change registers a dirty
 *   rect so the renderer only repaints what changed
 * - settleStep() runs the two "pixels fall down" rules until stable:
 *     1) ANY hole collapses: soil above a void drops to fill it, so a
 *        column is always a solid stack from the floor up
 *     2) over-steep slopes slump: the top slice of a too-high column
 *        slides onto its lower neighbour (angle of repose)
 *   Mass is exactly conserved by settling; only dig/add change it.
 * ===================================================================== */
(function (root) {
'use strict';
const SE = (root.SE = root.SE || {});
const U = SE.util;

class Terrain {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.data = new Uint8Array(W * H);
    this.tops = new Int16Array(W);
    this.counts = new Int32Array(W);
    for (let x = 0; x < W; x++) this.tops[x] = H;
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
      this.tops[x] = gy;
      this.counts[x] = H - gy;
      for (let y = gy; y < H; y++) this.data[y * W + x] = 1;
    }
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
    if (x < 0 || x >= this.W || y >= this.H) return true;
    if (y < 0) return false;
    return this.data[y * this.W + x] === 1;
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

  /* ---------- "land pixels fall down" — one relaxation pass ---------- */
  _flip = 0;
  settleStep() {
    const W = this.W, H = this.H, G = SE.CONFIG;
    let moved = 0;

    /* rule 1: any hole collapses — soil in the column falls into the void */
    for (let x = 0; x < W; x++) {
      if (this.counts[x] === H - this.tops[x]) continue; // already a clean stack
      const oldTop = this.tops[x];
      let w = H - 1;
      for (let y = H - 1; y >= 0; y--) {
        const idx = y * W + x;
        if (this.data[idx]) {
          if (y !== w) { this.data[w * W + x] = 1; this.data[idx] = 0; }
          w--;
        }
      }
      const newTop = H - this.counts[x];
      this.tops[x] = newTop;
      const y0 = Math.min(oldTop, newTop);
      this.addRect(x, y0, 1, H - y0);
      moved++;
    }

    /* rule 2: over-steep neighbours slump toward each other */
    this._flip ^= 1;
    const xs = this._flip ? 0 : W - 2;
    const xe = this._flip ? W - 2 : 0;
    const step = this._flip ? 1 : -1;
    for (let x = xs; step > 0 ? x <= xe : x >= xe; x += step) {
      const a = this.tops[x], b = this.tops[x + 1];
      if (a === b) continue;
      const excess = Math.abs(a - b) - G.REPOSE;
      if (excess <= 0) continue;
      const amt = Math.min(Math.ceil(excess / 2), G.SLUMP_MAX);
      const hiCol = a < b ? x : x + 1;      // smaller top = higher column
      const loCol = hiCol === x ? x + 1 : x;
      const hTop = this.tops[hiCol], lTop = this.tops[loCol];
      // move only a contiguous top slice; if a void stops the run, re-scan
      let t = 0;
      while (t < amt && hTop + t < H && this.data[(hTop + t) * W + hiCol]) t++;
      if (t === 0) continue;
      for (let i = 0; i < t; i++) {
        this.data[(hTop + i) * W + hiCol] = 0;
        this.data[(lTop - 1 - i) * W + loCol] = 1;
      }
      this.counts[hiCol] -= t;
      this.counts[loCol] += t;
      if (t === amt) this.tops[hiCol] = hTop + t;
      else { this.tops[hiCol] = hTop; this.refreshTop(hiCol); }
      this.tops[loCol] = Math.max(0, lTop - t);
      const yMin = Math.min(lTop - t, hTop);
      const yMax = Math.max(hTop + t - 1, lTop - 1);
      this.addRect(Math.min(x, x + 1), yMin, 2, yMax - yMin + 1);
      moved++;
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
