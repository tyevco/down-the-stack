#!/usr/bin/env node
// tools/gen-art.mjs: deterministic SVG generator for mods/mapledr/art (ARCHITECTURE §8).
//
//   node tools/gen-art.mjs            write every asset into mods/mapledr/art (+ preview.svg)
//   node tools/gen-art.mjs --out DIR  write into DIR instead (DIR/art/..., DIR/preview.svg)
//
// Every asset is drawn on a pixel Grid (1 px cells; bodies on a 2 px lattice for the chunky
// "2x pixel" look of D§11.1) and emitted as one <path> per colour made of merged axis-aligned
// rectangles, with shape-rendering="crispEdges". No <text>: glyphs come from a tiny pixel font.
// Masks (svg() tinted by text colour) are emitted with a single fill (#000) and no background.
// The viewBox is always the display size at zoom 1; full-colour art that image() draws larger than
// that carries width/height = k × viewBox so herdr's one-time raster stays sharp (`intrinsicScale`).
// Nothing here is random: same code, same bytes.
//
// `generateAll()` returns Map<relativePath, svgText> (paths relative to mods/mapledr), so the
// test suite can check the files on disk are exactly what this script produces.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ZONES, MOBS, ADDS, BOSSES, CLASSES, CHEST_TIERS, BACKLOG } from "../mods/mapledr/game/data.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// =============================================================================================
// Colour helpers
// =============================================================================================

function rgb(c) {
  let s = c.slice(1);
  if (s.length === 3 || s.length === 4) s = s.split("").map((ch) => ch + ch).join("");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
const h2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
/** Linear mix of two colours (t = 0 → a, 1 → b). Alpha is dropped. */
export function mix(a, b, t) {
  const A = rgb(a), B = rgb(b);
  return "#" + A.map((v, i) => h2(v + (B[i] - v) * t)).join("");
}
const dk = (c, t = 0.25) => mix(c, "#000000", t);
const lt = (c, t = 0.25) => mix(c, "#ffffff", t);
/** "#rrggbb" + alpha 0..1 → "#rrggbbaa" (emitted as fill + fill-opacity). */
const al = (c, a) => c.slice(0, 7) + h2(a * 255);

/** Composite colour c over d: a translucent c on an opaque d becomes an opaque mix. */
function over(c, d) {
  if (!c || c.length !== 9 || !d || d.length === 9) return c;
  return mix(d, c.slice(0, 7), parseInt(c.slice(7, 9), 16) / 255);
}

/** Shared ink colours. */
const OUT = "#1b1726";     // 2 px outline on mobs and bosses
const INK = "#1b1726";     // eyes, glyph ink
const WHITE = "#ffffff";
const SHADOW = al("#1b1726", 0.28);

// =============================================================================================
// Pixel font (3x5 mostly; a few glyphs are 2 or 4 wide). "#" = ink.
// =============================================================================================

const FONT = {
  "0": ["###", "#.#", "#.#", "#.#", "###"], "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["##.", "..#", ".#.", "#..", "###"], "3": ["##.", "..#", ".#.", "..#", "##."],
  "4": ["#.#", "#.#", "###", "..#", "..#"], "5": ["###", "#..", "##.", "..#", "##."],
  "6": [".##", "#..", "###", "#.#", "###"], "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"], "9": ["###", "#.#", "###", "..#", "##."],
  "+": ["...", ".#.", "###", ".#.", "..."], "-": ["...", "...", "###", "...", "..."],
  "?": ["##.", "..#", ".#.", "...", ".#."], "/": ["..#", "..#", ".#.", "#..", "#.."],
  ";": ["..", ".#", "..", ".#", "#."], ".": [".", ".", ".", ".", "#"],
  "*": ["...", "#.#", ".#.", "#.#", "..."], "<": ["..#", ".#.", "#..", ".#.", "..#"],
  ">": ["#..", ".#.", "..#", ".#.", "#.."], "=": ["...", "###", "...", "###", "..."],
  "(": [".#", "#.", "#.", "#.", ".#"], ")": ["#.", ".#", ".#", ".#", "#."],
  "^": [".#.", "#.#", "...", "...", "..."], "~": ["....", "....", ".#.#", "#.#.", "...."],
  "_": ["...", "...", "...", "...", "###"], "$": [".##", "##.", ".#.", ".##", "##."],
  " ": ["..", "..", "..", "..", ".."], "#": ["#.#", "###", "#.#", "###", "#.#"],
  A: [".#.", "#.#", "###", "#.#", "#.#"], D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"], F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"], H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"], K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"], N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."], P: ["##.", "#.#", "##.", "#..", "#.."],
  S: [".##", "#..", ".#.", "..#", "##."], T: ["###", ".#.", ".#.", ".#.", ".#."],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"], Z: ["###", "..#", ".#.", "#..", "###"],
  a: ["...", ".##", "#.#", "#.#", ".##"], e: [".#.", "#.#", "###", "#..", ".##"],
  g: ["...", ".##", "#.#", ".##", "..#", "##."], h: ["#..", "#..", "##.", "#.#", "#.#"],
  k: ["#..", "#.#", "##.", "#.#", "#.#"], p: ["...", "##.", "#.#", "##.", "#..", "#.."],
  t: [".#.", "###", ".#.", ".#.", ".##"], U: ["#.#", "#.#", "#.#", "#.#", "###"],
  B: ["##.", "#.#", "##.", "#.#", "##."], C: [".##", "#..", "#..", "#..", ".##"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"], M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
  W: ["#...#", "#...#", "#.#.#", "##.##", "#...#"], Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."], n: ["...", "##.", "#.#", "#.#", "#.#"],
};

// =============================================================================================
// The pixel grid
// =============================================================================================

export class Grid {
  /**
   * @param {number} w @param {number} h
   * @param {{wrapX?: boolean, snap?: number}} [o] wrapX: x wraps (seamless tiles);
   *   snap: lattice size used by oval/poly/line (2 = chunky 2x2 blocks; rect is always exact).
   */
  constructor(w, h, { wrapX = false, snap = 2 } = {}) {
    this.w = w; this.h = h; this.wrapX = wrapX; this.snap = snap;
    this.px = new Array(w * h).fill(null);
  }
  _i(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (this.wrapX) x = ((x % this.w) + this.w) % this.w;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }
  get(x, y) { const i = this._i(x, y); return i < 0 ? null : this.px[i]; }
  /** Set one pixel (null clears). A translucent colour over an opaque pixel is composited. */
  set(x, y, c) { const i = this._i(x, y); if (i >= 0) this.px[i] = over(c ?? null, this.px[i]); return this; }
  rect(x, y, w, h, c) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c);
    return this;
  }
  /** Run `fn` with a different lattice size (e.g. 1 for fine detail). */
  fine(fn, snap = 1) { const s = this.snap; this.snap = snap; try { fn(this); } finally { this.snap = s; } return this; }
  /** Fill every lattice cell inside [x0,x1)x[y0,y1) whose centre passes `test`. */
  area(x0, y0, x1, y1, test, c) {
    const s = this.snap;
    const sx = Math.floor(x0 / s) * s, sy = Math.floor(y0 / s) * s;
    for (let y = sy; y < y1; y += s) for (let x = sx; x < x1; x += s) {
      if (test(x + s / 2, y + s / 2)) this.rect(x, y, s, s, c);
    }
    return this;
  }
  /** Filled ellipse inscribed in the box (x, y, w, h). */
  oval(x, y, w, h, c) {
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
    return this.area(x, y, x + w, y + h, (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1.0001, c);
  }
  /** Elliptical ring of thickness t inscribed in the box. */
  ring(x, y, w, h, t, c) {
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2, ix = rx - t, iy = ry - t;
    return this.area(x, y, x + w, y + h, (px, py) => {
      const o = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;
      const i = ix > 0 && iy > 0 ? ((px - cx) / ix) ** 2 + ((py - cy) / iy) ** 2 : 2;
      return o <= 1.0001 && i > 1;
    }, c);
  }
  /** Filled polygon (even-odd), vertices in pixel-edge coordinates. */
  poly(pts, c) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return this.area(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), (px, py) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }, c);
  }
  /** Line through cell centres from cell (x0,y0) to cell (x1,y1), thickness t. */
  line(x0, y0, x1, y1, c, t = 2) {
    const o = this.snap / 2;
    const ax = x0 + o, ay = y0 + o, bx = x1 + o, by = y1 + o;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1, r = t / 2 + 0.001;
    return this.area(Math.min(ax, bx) - t, Math.min(ay, by) - t, Math.max(ax, bx) + t, Math.max(ay, by) + t, (px, py) => {
      const k = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
      return Math.hypot(px - (ax + k * dx), py - (ay + k * dy)) <= r;
    }, c);
  }
  /** Polyline. */
  path(pts, c, t = 2) {
    for (let i = 1; i < pts.length; i++) this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], c, t);
    return this;
  }
  /** ASCII bitmap: `pal` maps characters to colours; "." and " " are skipped. */
  bitmap(x, y, rows, pal, scale = 1) {
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      const c = typeof pal === "string" ? (ch === "#" ? pal : null) : pal[ch];
      if (c) this.rect(x + i * scale, y + j * scale, scale, scale, c);
    }));
    return this;
  }
  /** Pixel-font text (no <text> element: every glyph is rects). Returns the width drawn. */
  text(x, y, str, c, { scale = 1, gap = 1 } = {}) {
    let cx = x;
    for (const ch of str) {
      const g = FONT[ch];
      if (!g) throw new Error(`gen-art: no glyph for ${JSON.stringify(ch)}`);
      this.bitmap(cx, y, g, c, scale);
      cx += (g[0].length + gap) * scale;
    }
    return cx - x - gap * scale;
  }
  /** Paint colour `c` on empty pixels within distance r of any opaque pixel (rounded square kernel). */
  outline(c, { r = 2, skip = null } = {}) {
    const src = this.px.slice(), w = this.w, h = this.h;
    const at = (x, y) => {
      if (this.wrapX) x = ((x % w) + w) % w;
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const v = src[y * w + x];
      return v && !(skip && skip.includes(v)) ? v : null;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (src[y * w + x]) continue;
      let hit = false;
      for (let dy = -r; dy <= r && !hit; dy++) for (let dx = -r; dx <= r && !hit; dx++) {
        if (r > 1 && Math.abs(dx) === r && Math.abs(dy) === r) continue;
        if (at(x + dx, y + dy)) hit = true;
      }
      if (hit) this.px[y * w + x] = c;
    }
    return this;
  }
  /** Recolour `from` pixels that are within d px of an empty pixel in direction (dx, dy). */
  shade(from, to, dx, dy, d = 2) {
    const src = this.px.slice();
    const at = (x, y) => { const i = this._i(x, y); return i < 0 ? null : src[i]; };
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (src[y * this.w + x] !== from) continue;
      for (let k = 1; k <= d; k++) if (at(x + dx * k, y + dy * k) == null) { this.px[y * this.w + x] = to; break; }
    }
    return this;
  }
  /** Replace colour `from` by `to` everywhere (or where `where(x,y)` is true). */
  swap(from, to, where = null) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const i = y * this.w + x;
      if (this.px[i] === from && (!where || where(x, y))) this.px[i] = to;
    }
    return this;
  }
  /** Generic per-pixel map: fn(colour, x, y) → colour|null. */
  map(fn) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const i = y * this.w + x;
      this.px[i] = fn(this.px[i], x, y) ?? null;
    }
    return this;
  }
  /** Copy another grid's opaque pixels at (ox, oy). scale 0.5 samples every 2nd pixel. under: only fill empty pixels. */
  stamp(src, ox = 0, oy = 0, { scale = 1, under = false } = {}) {
    const sw = Math.floor(src.w * scale), sh = Math.floor(src.h * scale);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const c = src.get(Math.floor(x / scale), Math.floor(y / scale));
      if (!c) continue;
      const d = this.get(ox + x, oy + y);
      if (under && d) continue;
      this.set(ox + x, oy + y, over(c, d));
    }
    return this;
  }
  /** Draw `fn` on a fresh layer, outline it on its own, and stamp it over this grid. */
  layer(fn, outline = OUT, r = 2) {
    const g = new Grid(this.w, this.h, { wrapX: this.wrapX, snap: this.snap });
    fn(g);
    if (outline) g.outline(outline, { r });
    return this.stamp(g);
  }
  /** Shift a horizontal band of rows by dx (glitch effect); vacated pixels become empty. */
  shiftRows(y0, y1, dx) {
    for (let y = y0; y < y1; y++) {
      const row = this.px.slice(y * this.w, (y + 1) * this.w);
      for (let x = 0; x < this.w; x++) this.px[y * this.w + x] = row[x - dx] ?? null;
    }
    return this;
  }
  /** Mirror horizontally (returns a new grid). */
  flipX() {
    const g = new Grid(this.w, this.h, { wrapX: this.wrapX, snap: this.snap });
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) g.px[y * this.w + x] = this.px[y * this.w + (this.w - 1 - x)];
    return g;
  }
  /** One <path> per colour, rectangles merged by rows then columns (mask: everything #000). */
  toPaths({ mask = false } = {}) {
    const W = this.w, H = this.h;
    const groups = new Map();
    let open = new Map();
    for (let y = 0; y < H; y++) {
      const cur = new Map();
      let x = 0;
      while (x < W) {
        let c = this.px[y * W + x];
        if (!c) { x++; continue; }
        if (mask) c = "#000000";
        let x1 = x + 1;
        while (x1 < W && this.px[y * W + x1] && (mask || this.px[y * W + x1] === c)) x1++;
        const key = `${c}|${x}|${x1}`;
        let r = open.get(key);
        if (r && r.y + r.h === y) r.h++;
        else {
          r = { x, y, w: x1 - x, h: 1 };
          if (!groups.has(c)) groups.set(c, []);
          groups.get(c).push(r);
        }
        cur.set(key, r);
        x = x1;
      }
      open = cur;
    }
    const parts = [];
    for (const [c, rects] of groups) {
      const d = rects.map((r) => `M${r.x} ${r.y}h${r.w}v${r.h}h-${r.w}z`).join("");
      const fill = c.slice(0, 7).toLowerCase();
      const a = c.length === 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1;
      const op = a < 1 ? ` fill-opacity="${+a.toFixed(2)}"` : "";
      parts.push(`<path fill="${fill}"${op} d="${d}"/>`);
    }
    return parts.join("\n");
  }
  /** Standalone SVG document at the grid's own size (viewBox = display size). */
  toSVG({ mask = false, rendering = "crispEdges" } = {}) {
    return svgDoc(this.w, this.h, this.toPaths({ mask }), rendering);
  }
}

function svgDoc(w, h, body, rendering = "crispEdges") {
  const sr = rendering ? ` shape-rendering="${rendering}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${sr}>\n${body}\n</svg>\n`;
}

// Small drawing helpers shared by sprites ------------------------------------------------------

/** 2x2 eye with a 1 px glint. */
function eye(g, x, y, c = INK, glint = WHITE) { g.rect(x, y, 2, 2, c); g.set(x + 1, y, glint); }
/** White eye (w x h) with a pupil on its LEFT side (looking left, towards the heroes). */
function lookEye(g, x, y, w = 4, h = 4, pupil = INK, white = WHITE) {
  g.rect(x, y, w, h, white);
  g.rect(x, y + Math.floor((h - 2) / 2), Math.max(2, Math.floor(w / 2)), Math.min(h, 2 + (h > 4 ? 1 : 0)), pupil);
}
/** Ground shadow under floating sprites. */
function shadow(g, cx, w, y = g.h - 3) {
  const s = new Grid(g.w, g.h, { snap: 1 });
  s.oval(cx - w / 2, y, w, 3, SHADOW);
  g.stamp(s, 0, 0, { under: true });
}
/** 4-point sparkle. */
function sparkle(g, x, y, c = WHITE, big = false) {
  g.set(x, y, c); g.set(x - 1, y, c); g.set(x + 1, y, c); g.set(x, y - 1, c); g.set(x, y + 1, c);
  if (big) { g.set(x - 2, y, c); g.set(x + 2, y, c); g.set(x, y - 2, c); g.set(x, y + 2, c); }
}
/** Volume: light top-left band and dark bottom band for one fill colour. */
function volume(g, base, { light = 0.28, dark = 0.22, d = 2, lightDir = [0, -1] } = {}) {
  g.shade(base, dk(base, dark), 0, 1, d);
  g.shade(base, lt(base, light), lightDir[0], lightDir[1], d);
  return g;
}

// =============================================================================================
// Mobs (all face LEFT; feet on the bottom edge; S 28, M 40, L 56)
// =============================================================================================

const SIZE_PX = { S: 28, M: 40, L: 56 };

const MOB_ART = {
  // --- Zone 1: Lint Meadows ------------------------------------------------------------------
  typo_sprout(g) {
    const leaf = "#b8e986", leafD = "#7cc35a", stem = "#4e9a44", body = "#8dd16b", soil = "#8a5a35";
    g.oval(6, 20, 16, 8, soil); g.rect(4, 26, 20, 2, null);
    g.rect(14, 10, 2, 8, stem);
    g.oval(6, 14, 16, 12, body); volume(g, body);
    g.oval(16, 6, 8, 6, leafD);
    g.poly([[2, 4], [6, 2], [18, 2], [21, 5], [18, 11], [4, 11], [2, 9]], leaf);
    g.shade(leaf, leafD, 0, 1, 1);
    g.fine(() => {
      g.text(5, 3, "teh", "#2f5e2a");
      // red spell-check squiggle under the typo
      for (let x = 4; x < 17; x++) g.set(x, 9 + (x % 2), "#e0605a");
    });
    eye(g, 8, 18); eye(g, 12, 18);
    g.rect(10, 22, 2, 1, INK);
    g.outline(OUT);
  },
  semicolon_snail(g) {
    const body = "#f0a07b", shell = "#f4e6c1", semi = "#6b4a9e";
    g.poly([[4, 20], [22, 20], [26, 26], [2, 26]], body);
    g.oval(2, 14, 10, 12, body);
    volume(g, body);
    g.fine(() => { g.line(4, 15, 3, 8, body, 1.6); g.line(8, 15, 9, 8, body, 1.6); });
    g.oval(10, 2, 17, 20, shell); g.shade(shell, "#d8c08a", 1, 1, 2); g.shade(shell, WHITE, -1, -1, 1);
    // the shell IS a semicolon: a dot over a comma with a tail
    g.fine(() => {
      g.oval(15, 5, 6, 6, semi);
      g.oval(15, 12, 6, 6, semi); g.poly([[17, 16], [21, 16], [17, 21], [14, 21]], semi);
    });
    g.rect(2, 7, 3, 3, INK); g.rect(8, 7, 3, 3, INK); g.set(2, 7, WHITE); g.set(8, 7, WHITE);
    g.fine(() => g.rect(3, 19, 3, 1, dk(body, 0.45)));
    g.outline(OUT);
    // dotted trail
    for (const x of [22, 25]) g.rect(x, 26, 2, 1, "#c9e7a8");
  },
  unused_import(g) {
    const imp = "#9c8fb8", crate = "#b9824b", plank = "#8f5f32", label = "#f3ead2";
    g.layer((l) => {
      l.oval(18, 8, 18, 16, imp); l.oval(20, 18, 16, 18, imp);
      l.poly([[20, 10], [20, 4], [24, 9]], imp); l.poly([[32, 10], [34, 4], [28, 9]], imp);
      l.line(34, 30, 37, 22, imp, 2); l.rect(36, 20, 2, 2, "#e0605a");
      l.rect(26, 34, 8, 4, imp);
      volume(l, imp);
      l.rect(21, 15, 4, 1, INK); l.rect(28, 15, 4, 1, INK); // closed, sleeping eyes
      l.rect(25, 19, 3, 1, dk(imp, 0.4));
    });
    g.layer((l) => {
      l.rect(4, 22, 20, 16, crate);
      l.rect(4, 22, 20, 2, plank); l.rect(4, 36, 20, 2, plank); l.rect(4, 22, 2, 16, plank); l.rect(22, 22, 2, 16, plank);
      l.rect(8, 26, 12, 8, label);
      // "import" stamp: arrow down into a tray
      l.rect(13, 27, 2, 4, "#6b4a9e"); l.rect(11, 29, 6, 1, "#6b4a9e"); l.rect(12, 30, 4, 1, "#6b4a9e");
      l.rect(10, 32, 1, 1, "#6b4a9e"); l.rect(17, 32, 1, 1, "#6b4a9e"); l.rect(10, 33, 8, 1, "#6b4a9e");
    });
    // the hugging arm over the crate
    g.layer((l) => { l.rect(10, 20, 14, 4, imp); l.rect(8, 22, 4, 4, imp); volume(l, imp, { d: 1 }); });
    g.fine(() => { g.text(6, 3, "Z", "#e9e4ff"); g.bitmap(12, 9, ["##", ".#", "##"], "#e9e4ff"); });
  },

  // --- Zone 2: Callback Caverns -------------------------------------------------------------
  callback_bat(g) {
    const body = "#7a5bc7", wing = "#a98bea", rib = "#6a4cb4", tail = "#9ee6ff";
    g.poly([[12, 12], [2, 2], [0, 8], [10, 18]], wing);
    g.poly([[16, 12], [26, 2], [28, 8], [18, 18]], wing);
    g.line(4, 4, 10, 12, rib, 1); g.line(23, 4, 17, 12, rib, 1);
    g.oval(9, 8, 10, 12, body); volume(g, body);
    g.poly([[10, 10], [10, 5], [13, 9]], body); g.poly([[18, 10], [18, 5], [15, 9]], body);
    g.rect(11, 12, 2, 2, "#ff9cc8"); g.rect(15, 12, 2, 2, "#ff9cc8"); g.set(11, 12, WHITE); g.set(15, 12, WHITE);
    g.fine(() => { g.rect(12, 16, 1, 1, WHITE); g.rect(15, 16, 1, 1, WHITE); });
    g.outline(OUT);
    // tail shaped like a return arrow (call me back)
    g.fine(() => {
      g.rect(14, 21, 2, 3, tail); g.rect(8, 22, 8, 2, tail);
      g.rect(7, 21, 1, 4, tail); g.rect(6, 22, 1, 2, tail);
    });
    shadow(g, 14, 12);
  },
  promise_wisp(g) {
    const silk = "#e2daf7", band = "#b5a8e0", well = "#3b2d70";
    g.fine(() => g.rect(14, 0, 1, 4, "#cfc6f0"));
    g.oval(5, 3, 18, 22, silk);
    g.shade(silk, "#c8bdea", 1, 1, 2);
    g.fine(() => { g.line(6, 8, 21, 6, band, 1); g.line(6, 21, 21, 23, band, 1); });
    eye(g, 9, 6); eye(g, 13, 6);
    // a loading spinner in a dark window: 8 dots fading round the clock
    g.oval(8, 10, 12, 12, well);
    const cx = 14, cy = 16, R = 4;
    g.fine(() => {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 - Math.PI / 2;
        const x = Math.round(cx + Math.cos(a) * R - 1), y = Math.round(cy + Math.sin(a) * R - 1);
        g.rect(x, y, 2, 2, mix("#5b4a9a", "#f2eeff", k / 7));
      }
    });
    g.outline(OUT);
    shadow(g, 14, 12);
  },
  null_pointer_frog(g) {
    const skin = "#4fc08d", belly = "#dff5d8", ink = "#2a3a5e";
    g.oval(4, 14, 32, 22, skin);
    g.oval(24, 26, 14, 10, skin);
    g.oval(4, 8, 10, 10, skin); g.oval(13, 8, 10, 10, skin);
    g.rect(2, 34, 8, 4, skin); g.rect(28, 34, 8, 4, skin);
    volume(g, skin);
    g.oval(9, 22, 22, 13, belly);
    lookEye(g, 6, 10, 5, 5); lookEye(g, 15, 10, 5, 5);
    g.rect(4, 20, 9, 1, dk(skin, 0.45));
    // "->∅": an arrow pointing confidently at nothing
    g.fine(() => {
      g.rect(11, 28, 7, 2, ink); g.rect(16, 26, 1, 6, ink); g.rect(17, 27, 1, 4, ink); g.rect(18, 28, 1, 2, ink);
      g.ring(20, 24, 9, 10, 1.6, ink); g.line(19, 33, 28, 24, ink, 1.4);
    });
    g.outline(OUT);
  },

  // --- Zone 3: Regex Ruins --------------------------------------------------------------------
  capture_group_goblins(g) {
    const skin = "#8fb34a", tunic = "#8c5a3c", paren = "#2fb9a8";
    g.layer((l) => {
      l.oval(8, 6, 12, 10, skin);
      l.poly([[9, 9], [4, 6], [9, 13]], skin); l.poly([[19, 9], [24, 6], [19, 13]], skin);
      l.rect(10, 15, 8, 8, tunic); l.rect(11, 23, 2, 3, skin); l.rect(15, 23, 2, 3, skin);
      volume(l, skin, { d: 1 }); volume(l, tunic, { d: 1 });
      eye(l, 10, 9); eye(l, 14, 9);
      l.fine(() => { l.rect(11, 13, 5, 1, INK); l.set(12, 14, WHITE); l.set(14, 14, WHITE); });
      l.rect(10, 18, 8, 1, "#d9b26a");
    });
    // ( and ): the goblin is a capture group
    const paren1 = (l, flip) => {
      l.fine(() => l.area(0, 2, 28, 27, (x, y) => {
        const cx = flip ? 4 : 24, d = ((x - cx) / 21) ** 2 + ((y - 14.5) / 12) ** 2;
        const di = ((x - cx) / 17.5) ** 2 + ((y - 14.5) / 10.2) ** 2;
        return d <= 1 && di > 1 && (flip ? x > 20 : x < 8);
      }, paren));
      l.shade(paren, lt(paren, 0.35), -1, 0, 1);
    };
    g.layer((l) => paren1(l, false)); g.layer((l) => paren1(l, true));
  },
  backslash_bandit(g) {
    const skin = "#e0a878", suit = "#2e3a66", scarf = "#d64545", cape = "#b83a4b";
    g.layer((l) => { l.poly([[18, 15], [26, 15], [38, 33], [38, 38], [30, 38]], cape); l.shade(cape, dk(cape, 0.25), 1, 0, 2); });
    g.layer((l) => {
      l.rect(13, 18, 12, 12, suit); l.rect(14, 30, 4, 6, suit); l.rect(20, 30, 4, 6, suit);
      l.rect(12, 36, 6, 2, INK); l.rect(19, 36, 6, 2, INK);
      l.rect(9, 22, 6, 3, suit); l.rect(7, 22, 3, 3, skin);
      volume(l, suit, { d: 1 });
      l.rect(12, 17, 14, 3, scarf); l.rect(22, 19, 4, 3, scarf);
      l.oval(12, 5, 14, 13, skin); volume(l, skin, { d: 1 });
      l.rect(11, 9, 16, 4, INK); l.rect(13, 10, 3, 2, WHITE); l.rect(19, 10, 3, 2, WHITE);
      l.rect(13, 10, 1, 2, "#6b5a4a"); l.rect(19, 10, 1, 2, "#6b5a4a");
      l.rect(10, 4, 18, 2, suit); l.rect(13, 0, 12, 5, suit); l.rect(13, 3, 12, 1, scarf);
    });
  },
  greedy_glob(g) {
    const blob = "#a877e0", inner = "#8a5bc8", pebble = "#b8b0a0", mouth = "#3e1f5e";
    g.oval(6, 8, 32, 30, blob); g.rect(8, 30, 28, 8, blob);
    volume(g, blob, { d: 2 });
    // swallowed pebbles, visible through the jelly
    g.oval(24, 28, 6, 5, inner); g.oval(30, 22, 5, 5, inner); g.oval(20, 32, 4, 4, inner);
    // wide-open mouth on the left, mid-gulp
    g.oval(4, 20, 14, 13, mouth); g.rect(4, 26, 4, 2, blob);
    g.fine(() => { g.rect(8, 21, 2, 2, WHITE); g.rect(12, 21, 2, 2, WHITE); g.oval(8, 27, 6, 5, "#c05a8a"); });
    g.oval(10, 24, 4, 4, pebble);
    lookEye(g, 12, 12, 5, 5); lookEye(g, 19, 11, 5, 5);
    // ".*" stamped on its side
    g.rect(24, 19, 3, 3, WHITE);
    g.fine(() => g.bitmap(29, 15, ["#.#.#", ".###.", "#####", ".###.", "#.#.#"], WHITE));
    g.outline(OUT);
    g.layer((l) => { l.oval(0, 20, 4, 4, pebble); l.oval(1, 30, 3, 3, pebble); }, OUT, 1);
  },

  // --- Zone 4: Merge Marshes ------------------------------------------------------------------
  diff_leech(g) {
    const red = "#e05a5a", green = "#5ac46a";
    g.oval(4, 14, 23, 12, red);
    g.oval(2, 15, 8, 9, red);
    g.map((c, x) => (c === red && x >= 8 && Math.floor((x - 8) / 4) % 2 === 0 ? green : c));
    g.shade(red, dk(red, 0.25), 0, 1, 2); g.shade(green, dk(green, 0.25), 0, 1, 2);
    g.shade(red, lt(red, 0.3), 0, -1, 1); g.shade(green, lt(green, 0.3), 0, -1, 1);
    g.fine(() => {
      for (const x of [8, 16, 24]) { g.rect(x + 1, 18, 1, 3, WHITE); g.rect(x, 19, 3, 1, WHITE); }
      for (const x of [12, 20]) g.rect(x, 19, 3, 1, WHITE);
    });
    g.ring(1, 17, 5, 5, 1, INK); eye(g, 6, 16);
    g.outline(OUT);
  },
  rebase_wraith(g) {
    const body = "#cfe0ff", rew = "#5a7bd8";
    const ghost = (l, ox, c) => {
      l.oval(6 + ox, 3, 22, 22, c); l.rect(6 + ox, 14, 22, 16, c);
      for (let k = 0; k < 4; k++) l.poly([[6 + ox + k * 6, 30], [9 + ox + k * 6, 36], [12 + ox + k * 6, 30]], c);
      l.rect(28 + ox - 2, 30, 2, 2, null);
    };
    g.layer((l) => {
      ghost(l, 0, body); volume(l, body, { dark: 0.12 });
      l.rect(9, 10, 4, 6, "#2a3466"); l.rect(16, 10, 4, 6, "#2a3466");
      l.rect(9, 10, 2, 2, WHITE); l.rect(16, 10, 2, 2, WHITE);
      l.oval(11, 18, 4, 4, "#2a3466");
      // rewind symbol on the chest: history gets rewritten
      l.fine(() => { l.poly([[15, 26], [19, 23], [19, 29]], rew); l.poly([[19, 26], [23, 23], [23, 29]], rew); });
    });
    const after = new Grid(g.w, g.h); ghost(after, 6, al("#b4ceff", 0.55));
    const after2 = new Grid(g.w, g.h); ghost(after2, 11, al("#b4ceff", 0.28));
    g.stamp(after, 0, 0, { under: true }); g.stamp(after2, 0, 0, { under: true });
  },
  merge_conflict_golem(g) {
    const ours = "#b86a62", theirs = "#6fa36a", head = "#9a9aa0", slab = "#2a2433";
    g.layer((l) => { l.rect(14, 40, 10, 14, ours); l.rect(32, 40, 10, 14, theirs); l.rect(12, 50, 13, 4, dk(ours, 0.2)); l.rect(31, 50, 13, 4, dk(theirs, 0.2)); });
    g.layer((l) => {
      l.rect(10, 14, 18, 28, ours); l.rect(28, 14, 18, 28, theirs);
      volume(l, ours); volume(l, theirs);
      l.rect(13, 17, 30, 22, slab);
      // the conflict markers, as shapes: <<<< ==== >>>>
      l.fine(() => {
        for (let i = 0; i < 6; i++) l.bitmap(15 + i * 4, 18, FONT["<"], "#ff8a80");
        for (let i = 0; i < 6; i++) l.bitmap(15 + i * 4, 25, ["###", "...", "###"], "#f0f0f0");
        for (let i = 0; i < 6; i++) l.bitmap(15 + i * 4, 31, FONT[">"], "#8fe39a");
        // crack down the middle
        l.path([[28, 14], [27, 17], [29, 20], [27, 24], [29, 29], [27, 34], [28, 41]], INK, 1);
      });
    });
    g.layer((l) => { l.rect(2, 16, 9, 22, ours); l.rect(1, 34, 11, 7, dk(ours, 0.15)); volume(l, ours, { d: 1 }); });
    g.layer((l) => { l.rect(45, 16, 9, 22, theirs); l.rect(44, 34, 11, 7, dk(theirs, 0.15)); volume(l, theirs, { d: 1 }); });
    g.layer((l) => {
      l.rect(19, 2, 18, 13, head); volume(l, head);
      l.rect(21, 7, 4, 3, "#fff4c2"); l.rect(28, 7, 4, 3, "#fff4c2"); l.rect(21, 7, 2, 3, "#ff8a5c"); l.rect(28, 7, 2, 3, "#ff8a5c");
      l.rect(22, 12, 8, 1, INK);
    });
  },

  // --- Zone 5: Dependency Jungle --------------------------------------------------------------
  left_pad_mites(g) {
    const vine = "#4e9a5a", leaf = "#8fd46b", mite = "#d9833b";
    // a whole vine, carried overhead by something very small
    g.layer((l) => {
      l.fine(() => {
        for (let x = 1; x < 27; x++) l.rect(x, 7 + Math.round(Math.sin(x / 3) * 2), 1, 4, vine);
      });
      for (const [x, y] of [[2, 2], [9, 10], [15, 2], [21, 9]]) l.oval(x, y, 6, 4, leaf);
      l.shade(vine, lt(vine, 0.3), 0, -1, 1);
    });
    g.layer((l) => {
      l.fine(() => { l.rect(9, 12, 1, 6, INK); l.rect(15, 12, 1, 6, INK); });
      l.oval(6, 16, 14, 9, mite); volume(l, mite, { d: 1 });
      l.fine(() => { for (const x of [8, 12, 16]) { l.rect(x, 25, 1, 2, INK); l.rect(x + 1, 26, 1, 1, INK); } });
      l.rect(4, 18, 5, 5, mite); eye(l, 5, 19);
    }, OUT, 1);
  },
  transitive_vine(g) {
    const vine = "#3f7f3a", bud = "#6fbf55", leaf = "#8fd46b", crate = "#c08a50", arrow = "#f2c14e";
    // a dependency graph: bud -> crate -> crate, edges drawn as vines ending in arrowheads
    g.layer((l) => {
      l.path([[10, 22], [14, 28], [19, 31]], vine, 3);
      l.path([[28, 26], [31, 22], [35, 22]], vine, 3);
      l.oval(12, 22, 6, 4, leaf); l.oval(28, 18, 6, 4, leaf);
    });
    g.layer((l) => {
      l.rect(18, 28, 11, 10, crate); l.rect(30, 24, 9, 9, crate); volume(l, crate, { d: 1 });
      l.fine(() => { l.rect(18, 32, 11, 1, dk(crate, 0.3)); l.rect(30, 28, 9, 1, dk(crate, 0.3)); l.text(22, 30, "?", WHITE); l.text(33, 26, "?", WHITE); });
    });
    g.fine(() => {
      g.poly([[15, 26], [19, 31], [13, 31]], arrow);
      g.poly([[34, 18], [38, 22], [33, 24]], arrow);
    });
    g.layer((l) => {
      l.oval(2, 8, 14, 15, bud); volume(l, bud);
      l.poly([[2, 10], [0, 4], [6, 8]], leaf); l.poly([[14, 9], [18, 3], [16, 11]], leaf);
      lookEye(l, 4, 12, 4, 4); lookEye(l, 9, 12, 4, 4);
      l.rect(5, 18, 5, 1, INK);
    });
  },
  version_pin_porcupine(g) {
    const fur = "#8a5a3c", snout = "#c99a6b", quill = "#f1e6cf", tip = "#f2c14e";
    // quills fan up and back, each tipped with a caret ^ (the semver range it refuses to take)
    g.layer((l) => {
      l.fine(() => {
        for (let k = 0; k < 6; k++) {
          const a = Math.PI * (0.84 - k * 0.13), cx = 22, cy = 27, L = 16;
          const ux = Math.cos(a), uy = -Math.sin(a);
          const x = Math.round(cx + ux * L), y = Math.round(cy + uy * L);
          l.line(cx, cy, x, y, quill, 2);
          // caret tip: an arrowhead pointing outwards
          const px = -uy, py = ux, tx = x + ux * 4, ty = y + uy * 4;
          l.poly([[tx, ty], [x + px * 3, y + py * 3], [x + ux, y + uy], [x - px * 3, y - py * 3]], tip);
        }
      });
    }, OUT, 1);
    g.layer((l) => {
      l.oval(6, 18, 30, 18, fur); l.rect(10, 34, 4, 3, fur); l.rect(26, 34, 4, 3, fur);
      volume(l, fur);
      l.fine(() => { for (let x = 14; x < 34; x += 4) l.line(x, 22, x + 2, 19, lt(fur, 0.3), 1); });
      l.oval(1, 24, 12, 9, snout); l.rect(1, 26, 2, 2, INK);
      eye(l, 9, 22);
    });
    // the pin that keeps it at 0.3.1 forever
    g.layer((l) => { l.fine(() => l.rect(25, 10, 1, 10, "#c0c4cc")); l.oval(21, 3, 10, 8, "#e0393e"); l.set(23, 5, lt("#e0393e", 0.5)); l.set(24, 5, lt("#e0393e", 0.5)); }, OUT, 1);
  },

  // --- Zone 6: Threadlock Keep ---------------------------------------------------------------
  race_condition_rats(g) {
    const fur = "#aaa2bc", ear = "#f2a0b5", speed = "#ffb347";
    g.fine(() => g.path([[22, 21], [25, 19], [26, 15], [25, 12]], ear, 1));
    g.oval(6, 13, 18, 12, fur);
    g.poly([[1, 21], [9, 13], [12, 23]], fur);
    volume(g, fur);
    g.oval(7, 9, 6, 6, ear);
    g.rect(1, 20, 2, 2, ear);
    eye(g, 6, 16);
    // race bib: nobody knows who's first
    g.rect(13, 15, 7, 7, WHITE); g.fine(() => g.text(15, 16, "?", "#d0453f"));
    g.rect(8, 25, 3, 2, ear); g.rect(18, 25, 3, 2, ear);
    g.outline(OUT);
    g.fine(() => { for (const [y, w] of [[12, 3], [16, 4], [20, 3]]) g.rect(28 - w, y, w, 1, speed); });
  },
  spinlock_top(g) {
    const a = "#e08a3c", b = "#f3d9b1", stem = "#7e4a22";
    g.rect(18, 2, 4, 8, stem); g.rect(17, 2, 6, 2, dk(stem, 0.2));
    g.oval(5, 9, 30, 18, a);
    g.poly([[8, 20], [32, 20], [20, 36]], a);
    // spiral stripes
    g.map((c, x, y) => (c === a && Math.floor((x + y * 1.6) / 5) % 2 === 0 ? b : c));
    g.shade(a, dk(a, 0.25), 0, 1, 2); g.shade(b, dk(b, 0.2), 0, 1, 2);
    // dizzy @ eyes and a padlock badge
    g.fine(() => {
      for (const x of [9, 15]) { g.rect(x, 13, 5, 5, WHITE); g.rect(x + 1, 14, 3, 3, INK); g.set(x + 2, 15, WHITE); g.set(x + 3, 16, WHITE); }
      g.ring(23, 11, 7, 8, 1.3, "#5a5f6a"); g.rect(22, 15, 9, 6, "#5a5f6a"); g.rect(26, 17, 1, 2, INK);
    });
    g.outline(OUT);
    g.fine(() => { g.rect(0, 15, 3, 1, "#ffd9a8"); g.rect(1, 20, 3, 1, "#ffd9a8"); g.rect(37, 14, 3, 1, "#ffd9a8"); g.rect(36, 19, 3, 1, "#ffd9a8"); });
    shadow(g, 20, 14);
  },
  starved_thread(g) {
    const body = "#c9ccd6", ticket = "#f5efd8";
    g.layer((l) => {
      l.oval(16, 2, 12, 13, body);
      l.poly([[17, 10], [27, 10], [26, 22], [28, 34], [16, 34], [18, 22]], body);
      l.fine(() => { for (let k = 0; k < 3; k++) l.poly([[16 + k * 4, 33], [17.5 + k * 4, 38], [20 + k * 4, 33]], body); });
      volume(l, body, { dark: 0.15, d: 1 });
      l.rect(17, 7, 3, 4, "#3a3d4a"); l.rect(22, 7, 3, 4, "#3a3d4a");
      l.fine(() => { l.rect(19, 13, 3, 2, "#3a3d4a"); l.rect(17, 12, 1, 2, dk(body, 0.2)); l.rect(25, 12, 1, 2, dk(body, 0.2)); });
      l.fine(() => l.path([[18, 18], [13, 21], [10, 21]], body, 2));
    });
    g.layer((l) => {
      l.rect(1, 16, 10, 9, ticket); l.rect(1, 16, 10, 2, "#e0605a");
      l.fine(() => { l.text(2, 19, "4", INK, { gap: 0 }); l.text(6, 19, "2", INK, { gap: 0 }); });
    });
    shadow(g, 21, 12);
  },

  // --- Zone 7: Legacy Catacombs --------------------------------------------------------------
  todo_ghost(g) {
    const body = "#dfffe9", tag = "#f4ecd0";
    g.layer((l) => {
      l.oval(5, 2, 18, 16, body); l.rect(5, 10, 18, 11, body);
      for (let k = 0; k < 3; k++) l.poly([[5 + k * 6, 21], [8 + k * 6, 25], [11 + k * 6, 21]], body);
      volume(l, body, { dark: 0.14 });
      l.rect(8, 7, 2, 3, "#244a34"); l.rect(13, 7, 2, 3, "#244a34");
    });
    g.layer((l) => {
      l.fine(() => l.line(20, 8, 20, 12, "#8a7a5a", 1));
      l.rect(2, 12, 19, 8, tag); l.rect(2, 12, 19, 1, "#c8b88a");
      l.fine(() => l.text(4, 14, "TODO", "#2f5e3a"));
    }, OUT, 1);
  },
  anonymous_author(g) {
    const vane = "#ede6d6", hood = "#3f3a55", glow = "#66ff99", nib = "#2a2540";
    g.layer((l) => {
      l.poly([[20, 6], [31, 12], [30, 27], [21, 35], [11, 28], [10, 14]], vane);
      l.shade(vane, "#cfc6b0", 1, 0, 2);
      l.fine(() => { l.line(21, 34, 22, 8, "#a49c88", 1); for (let y = 12; y < 32; y += 4) { l.line(22, y, 28, y - 3, "#cfc6b0", 1); l.line(21, y, 13, y - 3, "#cfc6b0", 1); } });
      l.poly([[17, 32], [25, 32], [21, 39]], nib);
    });
    g.layer((l) => {
      l.oval(9, 1, 22, 17, hood); l.poly([[28, 8], [36, 16], [28, 14]], hood); volume(l, hood, { light: 0.2 });
      l.oval(11, 6, 13, 10, "#120f1a");
      l.rect(13, 10, 2, 2, glow); l.rect(18, 10, 2, 2, glow);
    });
    g.layer((l) => { l.rect(12, 20, 15, 9, WHITE); l.rect(12, 20, 15, 2, "#e0393e"); l.fine(() => l.text(14, 23, "???", INK)); }, OUT, 1);
  },
  spaghetti_mummy(g) {
    const pasta = "#ebcb7a", line = "#c79a45", eyeC = "#66ff99", ball = "#8a4a32";
    const isPasta = (c) => c === pasta || c === lt(pasta, 0.15) || c === dk(pasta, 0.12);
    g.layer((l) => { l.rect(16, 38, 9, 16, pasta); l.rect(30, 38, 9, 16, pasta); });
    g.layer((l) => { l.rect(4, 28, 14, 6, pasta); l.rect(2, 29, 4, 4, pasta); volume(l, pasta, { dark: 0.12, light: 0.15, d: 1 }); });
    g.layer((l) => {
      l.rect(14, 18, 28, 22, pasta); l.oval(16, 3, 22, 19, pasta);
      volume(l, pasta, { dark: 0.12, light: 0.15 });
    });
    g.layer((l) => { l.rect(4, 18, 14, 6, pasta); l.rect(2, 19, 4, 4, pasta); volume(l, pasta, { dark: 0.12, light: 0.15, d: 1 }); });
    // noodle strands everywhere
    g.fine(() => {
      for (let y = 5; y < 54; y += 3) for (let x = 0; x < 56; x++) {
        const yy = y + Math.round(Math.sin((x + y * 3) / 2.2) * 1.1);
        if (isPasta(g.get(x, yy))) g.set(x, yy, line);
      }
      g.rect(18, 9, 14, 6, "#3a2a1a"); g.rect(19, 11, 3, 2, eyeC); g.rect(25, 11, 3, 2, eyeC);
    });
    g.outline(OUT);
    g.fine(() => { for (const [x, y] of [[6, 35], [11, 36], [20, 41], [36, 41]]) g.path([[x, y], [x + 1, y + 3], [x, y + 6], [x + 1, y + 9]], line, 1); });
    g.layer((l) => { l.oval(34, 12, 9, 9, ball); l.fine(() => { l.set(36, 14, lt(ball, 0.3)); l.set(39, 17, dk(ball, 0.3)); }); });
    // a fork stuck in its head
    g.fine(() => {
      g.line(40, 6, 35, 2, "#c0c4cc", 1.5);
      g.rect(41, 0, 1, 6, "#c0c4cc"); g.rect(43, 0, 1, 6, "#c0c4cc"); g.rect(45, 0, 1, 6, "#c0c4cc"); g.rect(41, 6, 5, 2, "#c0c4cc");
    });
  },

  // --- Zone 8: Production Peaks ---------------------------------------------------------------
  flaky_test_phantom(g) {
    const body = "#bfefff", pass = "#4cc38a", fail = "#ff5a5f";
    g.oval(7, 2, 26, 24, body); g.rect(7, 14, 26, 18, body);
    for (let k = 0; k < 4; k++) g.poly([[7 + k * 6.5, 32], [10 + k * 6.5, 38], [13.5 + k * 6.5, 32]], body);
    volume(g, body, { dark: 0.15 });
    g.rect(11, 10, 4, 5, "#203048"); g.rect(18, 10, 4, 5, "#203048"); g.rect(11, 10, 2, 2, WHITE); g.rect(18, 10, 2, 2, WHITE);
    // half pass, half fail
    g.rect(10, 19, 20, 9, "#203048");
    g.fine(() => {
      g.path([[12, 23], [14, 25], [18, 20]], pass, 1.6);
      g.line(22, 20, 27, 26, fail, 1.6); g.line(27, 20, 22, 26, fail, 1.6);
    });
    g.outline(OUT);
    // flicker: torn scanlines
    g.shiftRows(16, 18, 3); g.shiftRows(29, 31, -2);
    g.fine(() => { for (const y of [7, 22, 33]) for (let x = 0; x < 40; x++) if (g.get(x, y) && (x + y) % 3 === 0) g.set(x, y, null); });
  },
  memory_leak_slime(g) {
    const slime = "#d65db1", puddle = "#b8479a";
    g.layer((l) => { l.oval(24, 34, 15, 5, puddle); l.rect(33, 30, 2, 5, puddle); });
    g.layer((l) => {
      l.oval(3, 10, 32, 28, slime); l.rect(3, 30, 32, 8, slime);
      volume(l, slime);
      l.oval(8, 13, 6, 4, lt(slime, 0.45));
      lookEye(l, 8, 20, 5, 5); lookEye(l, 15, 20, 5, 5);
      l.rect(10, 29, 6, 2, "#6e1f58");
    });
    g.layer((l) => { l.oval(25, 0, 13, 10, "#f7c3e6"); l.fine(() => l.text(27, 2, "+1", "#6e1f58")); }, OUT, 1);
    g.layer((l) => l.oval(20, 5, 5, 5, "#f7c3e6"), OUT, 1);
  },
  pager_wyvern(g) {
    const skin = "#e86a4a", wing = "#b33d35", belly = "#f6d7b0";
    g.layer((l) => {
      l.poly([[18, 16], [22, 1], [28, 6], [36, 2], [35, 14], [28, 20]], wing);
      l.fine(() => { l.line(22, 3, 22, 16, dk(wing, 0.25), 1); l.line(28, 7, 26, 17, dk(wing, 0.25), 1); l.line(34, 4, 30, 16, dk(wing, 0.25), 1); });
    });
    g.layer((l) => {
      l.path([[28, 26], [34, 30], [38, 28]], skin, 3); l.poly([[36, 25], [40, 28], [36, 31]], skin);
      l.oval(12, 15, 20, 15, skin); l.rect(16, 28, 3, 9, skin); l.rect(24, 28, 3, 9, skin);
      l.rect(14, 36, 6, 2, skin); l.rect(22, 36, 6, 2, skin);
      l.oval(2, 7, 14, 11, skin); l.rect(9, 12, 7, 8, skin);
      l.poly([[12, 8], [18, 3], [16, 10]], skin);
      volume(l, skin);
      l.oval(16, 20, 12, 8, belly);
      eye(l, 6, 10); l.rect(2, 14, 2, 1, INK);
      // pager on the collar
      l.rect(9, 18, 8, 6, "#23262e"); l.rect(10, 19, 5, 2, "#9dff9d");
    });
    g.fine(() => { g.rect(6, 18, 1, 3, WHITE); g.rect(4, 17, 1, 5, WHITE); g.rect(19, 18, 1, 3, WHITE); });
  },

  // --- Zone 9: Undefined Depths ---------------------------------------------------------------
  off_by_one_twins(g) {
    const a = "#b48cf2", b = "#8e68d6";
    g.layer((l) => {
      l.oval(14, 8, 12, 16, b); l.rect(16, 23, 3, 3, b); l.rect(21, 23, 3, 3, b);
      volume(l, b, { d: 1 }); eye(l, 15, 12);
    });
    g.layer((l) => {
      l.oval(3, 6, 14, 19, a); l.rect(5, 23, 3, 3, a); l.rect(11, 23, 3, 3, a);
      volume(l, a); eye(l, 5, 11); eye(l, 9, 11);
      l.rect(7, 17, 4, 1, INK);
    });
    g.fine(() => g.text(19, 1, "+1", "#9ee6ff"));
  },
  bitflip_moth(g) {
    const wing = "#e6d8ff", body = "#5b3e8c", mark = "#7a55c0";
    g.poly([[12, 9], [2, 2], [1, 16], [12, 18]], wing); g.poly([[16, 9], [26, 2], [27, 16], [16, 18]], wing);
    g.poly([[12, 16], [5, 22], [12, 22]], wing); g.poly([[16, 16], [23, 22], [16, 22]], wing);
    g.shade(wing, "#c8b4f0", 0, 1, 2);
    g.oval(11, 6, 6, 18, body); g.oval(10, 3, 7, 6, body); volume(g, body, { d: 1 });
    // a 0 on one wing, a 1 on the other: one of them is about to flip
    g.fine(() => { g.ring(4, 6, 6, 8, 1.5, mark); g.rect(21, 6, 2, 8, mark); g.rect(20, 7, 1, 1, mark); g.rect(20, 13, 4, 1, mark); });
    eye(g, 10, 4);
    g.outline(OUT);
    g.fine(() => { g.path([[11, 3], [8, 1], [5, 1]], "#c8a6ff", 1); g.path([[14, 2], [15, 0]], "#c8a6ff", 1); });
    sparkle(g, 2, 24, "#9ee6ff");
    shadow(g, 14, 10);
  },
  undefined_behavior(g) {
    const blob = "#c8a6ff", chk1 = "#ff4fd8", chk2 = "#2a1b40";
    g.oval(4, 14, 48, 40, blob); g.oval(4, 10, 18, 12, blob); g.oval(18, 4, 20, 16, blob); g.oval(34, 8, 16, 14, blob);
    g.rect(8, 46, 40, 8, blob); g.oval(0, 40, 10, 8, blob);
    volume(g, blob);
    // the back half renders as a missing-texture checkerboard
    g.map((c, x, y) => (c && x + y * 0.5 >= 48 ? ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? chk1 : chk2) : c));
    lookEye(g, 12, 18, 8, 7); lookEye(g, 24, 14, 6, 6); lookEye(g, 17, 31, 5, 5);
    g.rect(10, 41, 14, 4, "#3a2466"); g.rect(12, 41, 2, 2, WHITE); g.rect(18, 41, 2, 2, WHITE);
    g.outline(OUT);
    g.shiftRows(26, 30, 3); g.shiftRows(37, 40, -3); g.shiftRows(47, 50, 2);
    // chromatic split on the edges
    const m = g.px.map((c) => !!c);
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (g.get(x, y)) continue;
      if (x + 2 < g.w && m[y * g.w + x + 2]) g.set(x, y, al("#4fe3ff", 0.85));
      else if (x - 2 >= 0 && m[y * g.w + x - 2]) g.set(x, y, al("#ff4f6b", 0.85));
    }
  },

  // --- Adds and the duck ----------------------------------------------------------------------
  warning_mite(g) {
    const amber = "#f0a830";
    g.poly([[14, 3], [26, 23], [2, 23]], amber);
    g.shade(amber, dk(amber, 0.2), 0, 1, 2); g.shade(amber, "#f7c867", -1, 0, 2);
    g.rect(6, 23, 3, 3, dk(amber, 0.35)); g.rect(18, 23, 3, 3, dk(amber, 0.35));
    eye(g, 9, 14); eye(g, 14, 14);
    g.fine(() => { g.rect(8, 12, 3, 1, INK); g.rect(14, 12, 3, 1, INK); g.rect(11, 19, 4, 1, INK); });
    g.outline(OUT);
  },
  nitpick(g) {
    const pen = "#e0393e";
    g.fine(() => {
      for (let x = 2; x < 23; x++) g.rect(x, 14 + Math.round(Math.sin((x - 2) / 1.9) * 3.4), 1, 4, pen);
      g.poly([[21, 10], [27, 7], [25, 14], [22, 15]], "#2a2540"); g.set(26, 8, "#c0c4cc");
    });
    g.shade(pen, dk(pen, 0.22), 0, 1, 1); g.shade(pen, lt(pen, 0.3), 0, -1, 1);
    g.fine(() => { g.oval(1, 3, 7, 8, WHITE); g.oval(9, 3, 7, 8, WHITE); });
    g.rect(2, 6, 3, 3, INK); g.rect(10, 6, 3, 3, INK);
    g.outline(OUT);
    shadow(g, 13, 14);
  },
  holo_duck(g) {
    const pearl = "#efe9ff", beak = "#f28c38";
    const bands = ["#ffc2e2", "#bdf5da", "#bfe3ff", "#dcc8ff"];
    g.oval(5, 12, 21, 13, pearl); g.oval(3, 4, 12, 12, pearl);
    g.poly([[20, 14], [26, 9], [25, 18]], pearl);
    g.map((c, x, y) => (c === pearl && (x + y) % 9 < 3 ? bands[Math.floor((x + y) / 9) % 4] : c));
    g.oval(11, 15, 11, 6, "#d7ccf5"); g.fine(() => g.rect(13, 17, 7, 1, "#bfb2ea"));
    g.poly([[0, 9], [4, 8], [5, 13], [0, 13]], beak); g.fine(() => g.rect(0, 11, 4, 1, dk(beak, 0.25)));
    eye(g, 6, 7);
    g.outline(OUT);
    sparkle(g, 19, 4, WHITE, true); sparkle(g, 25, 23, WHITE);
  },
};

// =============================================================================================
// Bosses (112 x 96, feet on the bottom edge) and their separate parts (32 x 32)
// =============================================================================================

/** A curly brace "{" (open) or "}" drawn as a 2 px stroke, h px tall. */
function brace(g, x, y, h, open, c, t = 2) {
  const m = y + h / 2, w = 7;
  let pts = [[6, 0], [4, 0], [3, 2], [3, m - y - 3], [0, m - y], [3, m - y + 3], [3, h - 3], [4, h - 1], [6, h - 1]];
  if (!open) pts = pts.map(([px, py]) => [w - 1 - px, py]);
  g.fine(() => g.path(pts.map(([px, py]) => [x + px, y + py]), c, t));
}

/**
 * Copper hydra head facing left (mirrored when `right`), drawn into a (32 + keyLen) x 26 box at
 * (x, y): the head fills the right 32 px; the key it clutches (the one the OTHER head wants)
 * sticks out of its jaw to the left. keyLen 0 = no key.
 */
function hydraHead(g, x, y, right = false, keyLen = 14) {
  const cu = "#b8733a", key = "#ffb347", K = keyLen, W = 32 + K;
  const h = new Grid(W, 26);
  h.oval(K + 8, 4, 22, 18, cu); h.rect(K, 10, 16, 10, cu);
  h.poly([[K + 22, 6], [K + 30, 0], [K + 28, 10]], cu); h.poly([[K + 16, 4], [K + 20, 0], [K + 22, 6]], cu);
  volume(h, cu);
  h.rect(K, 16, 14, 2, "#5a3216");
  h.fine(() => { for (const tx of [2, 6, 10]) { h.rect(K + tx, 18, 1, 2, WHITE); h.rect(K + tx, 14, 1, 2, WHITE); } });
  h.rect(K + 12, 8, 5, 4, "#ffd9a0"); h.rect(K + 12, 9, 2, 3, "#c2410c");
  h.rect(K + 2, 11, 2, 2, "#5a3216");
  for (const [rx, ry] of [[20, 14], [24, 10], [24, 18]]) h.fine(() => h.rect(K + rx, ry, 2, 2, "#e0a06a"));
  h.outline(OUT);
  const head = new Grid(W, 26);
  if (K > 0) {
    const k = new Grid(W, 26);
    k.fine(() => {
      k.ring(1, 12, 9, 9, 2.2, key);                          // bow
      k.rect(8, 15, K + 2, 3, key);                           // shaft into the jaw
      k.rect(12, 18, 2, 3, key); k.rect(15, 18, 2, 4, key);   // bit
    });
    k.outline(OUT, { r: 1 });
    head.stamp(k);
  }
  head.stamp(h);
  g.stamp(right ? head.flipX() : head, x, y);
}

/** Isometric glowing cube (Monolith microservice), s x s box. */
function cube(g, x, y, s, glow = "#7fffe0") {
  const c = new Grid(s, s);
  const m = s / 2, q = Math.round(s / 4);
  c.poly([[m, 1], [s - 1, q], [m, 2 * q], [1, q]], "#b4b8c0");
  c.poly([[1, q], [m, 2 * q], [m, s - 1], [1, s - q]], "#80848c");
  c.poly([[m, 2 * q], [s - 1, q], [s - 1, s - q], [m, s - 1]], "#5a5e66");
  c.fine(() => { c.line(1, q, m, 2 * q, glow, 1); c.line(m, 2 * q, s - 2, q, glow, 1); c.line(m, 2 * q, m, s - 2, glow, 1); });
  if (s >= 16) { c.rect(Math.round(s * 0.22), Math.round(s * 0.55), 2, 2, "#66ff99"); c.rect(Math.round(s * 0.7), Math.round(s * 0.5), 2, 2, "#ffb347"); }
  c.outline(OUT, { r: s >= 16 ? 2 : 1 });
  g.stamp(c, x, y);
}

/** A tentacle: polyline through `pts`, thickness tapering t0 → t1, suckers and a branch band. */
function tentacle(g, pts, t0, t1, band, { plum = "#8e4585", sucker = "#f2b8d8" } = {}) {
  const l = new Grid(g.w, g.h, { snap: 1 });
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const t = t0 + (t1 - t0) * (i / n);
    l.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], plum, t);
  }
  l.shade(plum, dk(plum, 0.25), 0, 1, 2); l.shade(plum, lt(plum, 0.2), 0, -1, 1);
  for (let i = 1; i < n; i += 2) l.rect(Math.round(pts[i][0]), Math.round(pts[i][1] + (t0 + (t1 - t0) * (i / n)) / 2 - 2), 2, 2, sucker);
  if (band) {
    const i = Math.max(1, n - 3), [bx, by] = pts[i], bw = Math.round(t0 + (t1 - t0) * (i / n)) + 3;
    l.rect(Math.round(bx - bw / 2), Math.round(by - bw / 2), bw, bw, band);
    l.line(Math.round(bx) + 1, Math.round(by - bw / 2) + 1, Math.round(bx) - 1, Math.round(by + bw / 2) - 2, WHITE, 1);
  }
  l.outline(OUT, { r: 2 });
  g.stamp(l);
}

const BRANCH_COLORS = ["#4ea3ff", "#5ac46a", "#f2a93b", "#c9a2ff", "#45c2a8", "#a0a4ab", "#ff5a5f", "#e8b84a"];

/** Smooth path helper: quadratic bezier sampled into points. */
function bez(a, c, b, n = 10) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}

const BOSS_ART = {
  ignored_warning(g) {
    const amber = "#f0a830", ink = "#2b1d0e";
    // cape of tiny triangles, fluttering behind (to the right)
    g.layer((l) => {
      for (let r = 0; r < 9; r++) for (let c = 0; c < 3 + Math.floor(r / 2); c++) {
        const y = 14 + r * 8, edge = 48 + (y - 2) * (44 / 82);
        const x = Math.round(edge - 8 + c * 7 + (r % 2) * 3);
        if (x > 104) continue;
        l.fine(() => l.poly([[x, y + 7], [x + 3.5, y], [x + 7, y + 7]], (r + c) % 2 ? "#c2452d" : "#e07a2e"));
      }
    }, OUT, 1);
    g.layer((l) => { l.rect(24, 82, 12, 10, dk(amber, 0.35)); l.rect(62, 82, 12, 10, dk(amber, 0.35)); l.rect(22, 90, 16, 2, dk(amber, 0.5)); l.rect(60, 90, 16, 2, dk(amber, 0.5)); });
    g.layer((l) => {
      l.poly([[48, 0], [94, 84], [2, 84]], amber);
      l.shade(amber, "#f8cd6a", -1, 0, 3); l.shade(amber, "#c77d1a", 0, 1, 3);
      // the classic inner border of a warning sign
      l.poly([[48, 16], [80, 76], [16, 76]], ink);
      l.poly([[48, 22], [75, 73], [21, 73]], amber);
      // where the exclamation mark should be: 999+
      l.fine(() => l.text(33, 52, "999+", ink, { scale: 2 }));
      // eyes, one behind a monocle
      l.rect(38, 38, 6, 6, WHITE); l.rect(38, 40, 3, 4, ink);
      l.rect(52, 38, 6, 6, WHITE); l.rect(52, 40, 3, 4, ink);
      l.fine(() => {
        l.ring(34, 34, 14, 14, 1.6, "#dfe4ec");
        l.rect(37, 31, 8, 2, ink); l.rect(51, 34, 8, 2, ink);
        for (let i = 0; i < 6; i++) l.rect(46 + i * 2, 47 + i * 3, 1, 2, "#dfe4ec");
      });
    });
  },
  pyramid_of_doom(g) {
    const stone = "#5e4f8c", brc = "#9ee6ff";
    const layers = [[4, 66, 104, 26, 20, 14], [18, 40, 76, 26, 16, 12], [34, 14, 44, 26, 13, 10]];
    for (const [x, y, w, h, ew, eh] of layers) {
      g.layer((l) => {
        l.rect(x, y, w, h, stone);
        volume(l, stone, { light: 0.18, dark: 0.25 });
        l.fine(() => {
          for (let yy = y + 6; yy < y + h - 2; yy += 7) l.rect(x + 2, yy, w - 4, 1, dk(stone, 0.18));
          for (let yy = y; yy < y + h - 6; yy += 7) for (let xx = x + 8 + ((yy / 7) % 2) * 6; xx < x + w - 4; xx += 12) l.rect(xx, yy + 1, 1, 5, dk(stone, 0.18));
        });
        brace(l, x + 3, y + 3, h - 6, true, brc, 2.4); brace(l, x + w - 10, y + 3, h - 6, false, brc, 2.4);
        // one eye per layer, looking left
        const ex = x + w / 2 - ew / 2, ey = y + h / 2 - eh / 2;
        l.oval(ex, ey, ew, eh, WHITE);
        l.oval(ex + ew * 0.12, ey + eh * 0.18, ew * 0.5, eh * 0.64, brc);
        l.oval(ex + ew * 0.16, ey + eh * 0.3, ew * 0.3, eh * 0.42, INK);
        l.rect(ex - 2, ey - 2, ew + 4, 2, dk(stone, 0.45));
      });
    }
  },
  catastrophic_backtracker(g) {
    const body = "#2fb9a8", glyph = "#f3ddb0";
    // a serpent of .*.*.* tokens coiled into a loop: tail (inside) first so the outer coil overlaps.
    // cx = 76 keeps the head (and its forked tongue, 34 px left of the coil start) inside the frame.
    const N = 21, cx = 76, cy = 64;
    const at = (s) => { const a = Math.PI + s * 1.95 * Math.PI, r = 41 - 24 * s; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
    for (let i = N; i >= 1; i--) {
      const s = i / N, [x, y] = at(s), sz = Math.round(15 - 7 * s);
      const c = i % 2 ? body : dk(body, 0.18);
      g.layer((l) => {
        l.oval(x - sz / 2, y - sz / 2, sz, sz, c);
        l.shade(c, lt(c, 0.3), -1, -1, 1);
        l.fine(() => {
          if (i % 2) l.rect(Math.round(x) - 1, Math.round(y) + Math.floor(sz / 4) - 1, 3, 3, glyph);   // "."
          else if (sz >= 9) l.bitmap(Math.round(x) - 2, Math.round(y) - 2, ["#.#.#", ".###.", "#####", ".###.", "#.#.#"], glyph); // "*"
          else l.bitmap(Math.round(x) - 1, Math.round(y) - 1, ["#.#", ".#.", "#.#"], glyph);
        });
      });
    }
    // the head, facing left, at the start of the coil
    g.layer((l) => {
      const [hx, hy] = at(0);
      l.oval(hx - 16, hy - 13, 28, 24, body); l.rect(hx - 24, hy - 5, 18, 13, body);
      volume(l, body);
      l.rect(hx - 24, hy + 4, 18, 2, "#145c54");
      l.fine(() => { l.rect(hx - 20, hy + 6, 2, 3, WHITE); l.rect(hx - 12, hy + 6, 2, 3, WHITE); });
      l.rect(hx - 10, hy - 7, 6, 5, "#ff8a5c"); l.rect(hx - 10, hy - 6, 2, 4, INK);
      l.fine(() => l.rect(hx - 13, hy - 9, 10, 2, "#145c54"));
      l.fine(() => { l.rect(hx - 2, hy - 2, 3, 3, glyph); l.bitmap(hx + 4, hy - 4, ["#.#.#", ".###.", "#####", ".###.", "#.#.#"], glyph); });
    });
    g.fine(() => { const [hx, hy] = at(0); g.path([[hx - 25, hy + 1], [hx - 31, hy + 1], [hx - 34, hy - 2]], "#e0393e", 1.4); g.path([[hx - 31, hy + 1], [hx - 34, hy + 4]], "#e0393e", 1.4); });
  },
  octopus_merge(g) {
    const plum = "#8e4585";
    const T = [];
    for (let i = 0; i < 8; i++) {
      const sx = 40 + i * 5, ex = 4 + i * 14, ey = 84 + (i % 2) * 6;
      const c = [(sx + ex) / 2 + (i < 4 ? -14 : 14), 74 - (i % 3) * 6];
      const pts = bez([sx, 46], c, [ex, ey], 9);
      const last = pts[pts.length - 1], dir = i < 4 ? -1 : 1;
      pts.push([last[0] + dir * 4, last[1] - 4], [last[0] + dir * 1, last[1] - 7]);
      T.push(pts);
    }
    // back row first, then the mantle, then the front row
    for (const i of [1, 3, 5, 7]) tentacle(g, T[i], 9, 3, BRANCH_COLORS[i], { plum: dk(plum, 0.12) });
    g.layer((l) => {
      l.oval(30, 2, 60, 52, plum); l.rect(36, 40, 48, 12, plum);
      volume(l, plum, { d: 3 });
      for (const [x, y, w] of [[60, 10, 6], [72, 18, 4], [52, 6, 4], [78, 30, 5]]) l.oval(x, y, w, w, lt(plum, 0.22));
      l.oval(36, 28, 12, 12, WHITE); l.oval(52, 28, 12, 12, WHITE);
      l.rect(37, 32, 6, 4, INK); l.rect(53, 32, 6, 4, INK);
      l.rect(35, 26, 13, 2, dk(plum, 0.45)); l.rect(51, 26, 13, 2, dk(plum, 0.45));
      l.rect(44, 44, 10, 2, dk(plum, 0.45));
    });
    for (const i of [0, 2, 4, 6]) tentacle(g, T[i], 10, 3, BRANCH_COLORS[i], { plum });
  },
  bloatodon(g) {
    const wood = "#b9824b", dark = "#7a4e28", metal = "#9aa3ad", ink = "#8e2f2a";
    // smaller crates spilling out of the top (behind the body)
    for (const [x, y, s, c] of [[22, 10, 16, "#c99a5b"], [40, 4, 18, "#a8733e"], [60, 10, 14, "#d2a468"], [76, 14, 12, "#b07a45"]]) {
      g.layer((l) => {
        l.rect(x, y, s, s, c); l.rect(x, y, s, 2, dk(c, 0.3)); l.rect(x, y + s - 2, s, 2, dk(c, 0.3));
        l.fine(() => { l.line(x + 1, y + 2, x + s - 2, y + s - 3, dk(c, 0.3), 1); });
      });
    }
    g.layer((l) => { l.poly([[94, 46], [100, 28], [96, 16], [110, 20], [110, 36], [102, 50]], wood); l.shade(wood, dk(wood, 0.2), 0, 1, 2); });
    g.layer((l) => {
      for (const x of [20, 36, 70, 86]) { l.rect(x, 74, 7, 18, dark); l.rect(x - 1, 90, 9, 4, dk(dark, 0.3)); }
    });
    g.layer((l) => {
      l.rect(10, 22, 88, 54, wood);
      l.fine(() => { for (let y = 30; y < 72; y += 8) l.rect(12, y, 84, 1, dk(wood, 0.2)); });
      l.rect(10, 22, 88, 4, dark); l.rect(10, 72, 88, 4, dark); l.rect(10, 22, 4, 54, dark); l.rect(94, 22, 4, 54, dark);
      for (const [x, y] of [[10, 22], [90, 22], [10, 68], [90, 68]]) { l.rect(x, y, 8, 8, metal); l.rect(x + 3, y + 3, 2, 2, dk(metal, 0.4)); }
      // whale face at the front (left)
      l.rect(20, 36, 10, 8, WHITE); l.rect(20, 38, 5, 6, INK); l.rect(18, 33, 14, 2, dark);
      l.rect(14, 56, 30, 2, INK);
      l.fine(() => { for (let x = 16; x < 42; x += 3) l.rect(x, 58, 1, 3, "#f3ead2"); });
      // "pkg" stamp
      l.fine(() => {
        l.rect(50, 36, 34, 22, al(ink, 0.15));
        l.rect(50, 36, 34, 2, ink); l.rect(50, 56, 34, 2, ink); l.rect(50, 36, 2, 22, ink); l.rect(82, 36, 2, 22, ink);
        l.text(56, 41, "pkg", ink, { scale: 2 });
      });
    });
  },
  deadlock_hydra(g) {
    const cu = "#b8733a";
    g.layer((l) => { l.path([[82, 74], [98, 82], [108, 74], [110, 66]], cu, 6); volume(l, cu, { d: 1 }); });
    g.layer((l) => {
      l.path([[46, 62], [38, 46], [28, 32]], cu, 11); l.path([[68, 62], [76, 46], [84, 32]], cu, 11);
      volume(l, cu);
      l.fine(() => { for (const [x, y] of [[40, 50], [34, 40], [72, 50], [78, 40]]) l.rect(x, y, 8, 1, dk(cu, 0.35)); });
    });
    g.layer((l) => {
      for (const x of [36, 70]) { l.rect(x, 80, 10, 10, dk(cu, 0.15)); l.rect(x - 2, 88, 14, 4, dk(cu, 0.35)); }
      l.oval(28, 50, 58, 38, cu); volume(l, cu, { d: 3 });
      l.oval(40, 62, 34, 22, "#e0a06a");
      l.fine(() => { for (let x = 44; x < 72; x += 6) l.rect(x, 64, 1, 18, dk("#e0a06a", 0.15)); });
      // the padlock both heads are waiting on
      l.fine(() => l.ring(50, 58, 14, 14, 2.4, "#5a5e66"));
      l.rect(48, 64, 18, 14, "#3a3d4a"); l.rect(56, 68, 2, 5, "#ffb347"); l.rect(55, 68, 4, 2, "#ffb347");
      for (const [x, y] of [[32, 66], [80, 66], [56, 54]]) l.fine(() => l.rect(x, y, 2, 2, "#e0a06a"));
    });
    hydraHead(g, 0, 8, true, 18);    // Mutex, holding the key Semaphore wants
    hydraHead(g, 62, 8, false, 18);  // Semaphore, holding the key Mutex wants
  },
  monolith(g) {
    const grey = "#7c8088", glow = "#7fffe0";
    g.layer((l) => {
      l.rect(24, 88, 64, 6, "#50535a");
      l.rect(30, 6, 52, 84, grey); l.rect(28, 2, 56, 6, "#686c74");
      l.shade(grey, "#a4a8b0", -1, 0, 4); l.shade(grey, "#50535a", 1, 0, 4);
      // slit eyes
      l.rect(40, 16, 10, 4, "#ff5a5f"); l.rect(62, 16, 10, 4, "#ff5a5f"); l.rect(42, 17, 6, 2, "#ffb0b0"); l.rect(64, 17, 6, 2, "#ffb0b0");
      // LED panel
      l.rect(38, 28, 36, 26, "#4a4d55");
      const leds = ["#66ff99", "#66ff99", "#ffb347", "#3a3d44", "#66ff99", "#ff5a5f", "#3a3d44"];
      for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) l.rect(41 + c * 6, 31 + r * 6, 2, 2, leds[(r * 5 + c * 3) % leds.length]);
      // vent grille
      l.fine(() => { for (let y = 62; y < 80; y += 3) l.rect(40, y, 32, 1, "#50535a"); });
      // glowing cracks: it is about to decompose
      l.fine(() => {
        l.path([[82, 10], [74, 22], [78, 30], [70, 44], [74, 56]], glow, 1.4);
        l.path([[30, 60], [38, 66], [34, 76], [40, 88]], glow, 1.4);
        l.path([[56, 2], [58, 10], [54, 14]], glow, 1.2);
      });
    });
    cube(g, 6, 64, 16); cube(g, 92, 56, 14); cube(g, 12, 30, 10); cube(g, 96, 80, 12); cube(g, 2, 84, 10);
  },
  friday_deploy(g) {
    const night = "#26357a", belly = "#4a63b5", wing = "#34428f", fire = ["#ff5a3d", "#ff8a3d"];
    g.layer((l) => {
      l.poly([[56, 42], [62, 4], [78, 12], [92, 2], [100, 26], [84, 44]], wing);
      l.fine(() => { l.line(62, 6, 64, 40, lt(wing, 0.25), 1); l.line(78, 12, 74, 42, lt(wing, 0.25), 1); l.line(92, 4, 84, 40, lt(wing, 0.25), 1); });
    });
    // tail: a flaming progress bar stuck at 99%
    g.layer((l) => {
      l.rect(78, 64, 32, 12, "#dde3f0"); l.rect(80, 66, 28, 8, "#11162e");
      l.fine(() => { for (let x = 80; x < 106; x++) l.rect(x, 66, 1, 8, fire[Math.floor((x - 80) / 3) % 2]); });
      l.fine(() => l.poly([[86, 66], [90, 56], [93, 62], [97, 52], [100, 60], [104, 54], [106, 66]], "#ffb347"));
      l.fine(() => l.poly([[90, 66], [93, 60], [97, 64], [101, 58], [104, 66]], "#fff1b8"));
    });
    g.layer((l) => {
      for (const [x, w] of [[40, 10], [68, 12]]) { l.rect(x, 70, w, 20, night); l.rect(x - 2, 88, w + 4, 6, dk(night, 0.3)); }
      l.oval(34, 34, 52, 42, night);
      l.oval(16, 30, 26, 18, night);
      l.oval(8, 12, 30, 22, night); l.rect(2, 22, 16, 10, night);
      l.poly([[30, 14], [42, 4], [38, 18]], night);
      for (const x of [48, 58, 68, 78]) l.poly([[x, 38], [x + 4, 30], [x + 8, 38]], lt(night, 0.15));
      volume(l, night, { light: 0.32, d: 3 });
      l.oval(40, 50, 34, 22, belly);
      l.fine(() => { for (let y = 54; y < 70; y += 4) l.rect(44, y, 26, 1, dk(belly, 0.2)); });
      l.rect(14, 18, 6, 5, "#ff5a5f"); l.rect(14, 18, 2, 2, WHITE);
      l.rect(2, 30, 14, 2, dk(night, 0.5)); l.rect(4, 24, 2, 2, dk(night, 0.5));
      // pager on the collar
      l.rect(22, 34, 22, 4, "#11162e"); l.rect(28, 36, 10, 8, "#23262e"); l.rect(30, 38, 6, 3, "#9dff9d");
    });
    // tiny party hat
    g.layer((l) => {
      l.fine(() => l.poly([[16, 15], [30, 15], [22, 0]], "#ff6fa1"));
      l.fine(() => { l.poly([[18, 11], [27, 11], [26, 8], [19, 8]], "#6be3d0"); l.poly([[20, 5], [24, 5], [23, 3], [21, 3]], "#6be3d0"); });
      l.oval(19, -2, 6, 5, WHITE);
    }, OUT, 2);
    g.fine(() => { g.rect(0, 22, 2, 2, "#8a93b8"); g.rect(1, 18, 2, 2, "#8a93b8"); g.rect(0, 14, 2, 2, "#6b7396"); });
  },
  heisenbug(g) {
    const wing = "#c8a6ff", body = "#8a6bd1", spot = "#9ee6ff";
    const m = new Grid(112, 96);
    m.poly([[52, 38], [14, 6], [4, 42], [48, 52]], wing); m.poly([[62, 38], [100, 4], [110, 40], [66, 52]], wing);
    m.poly([[52, 52], [20, 60], [28, 86], [54, 68]], wing); m.poly([[62, 52], [92, 60], [86, 86], [60, 68]], wing);
    for (const [x, y, s] of [[22, 24, 14], [82, 22, 14], [30, 66, 10], [76, 66, 10]]) {
      m.oval(x, y, s, s, lt(wing, 0.35)); m.oval(x + s / 4, y + s / 4, s / 2, s / 2, spot);
    }
    m.oval(50, 30, 14, 50, body); m.oval(42, 22, 16, 14, body);
    volume(m, body, { d: 2 });
    m.rect(44, 26, 4, 4, "#f2eeff"); m.rect(44, 27, 2, 3, INK);
    m.fine(() => { m.path([[46, 22], [40, 12], [30, 10], [28, 14]], body, 2); m.path([[52, 22], [54, 10], [60, 6]], body, 2); });
    // dotted outline that never quite holds still (light and dark dashes: reads on any sky)
    const o = new Grid(112, 96); o.stamp(m); o.outline(OUT, { r: 2 });
    for (let y = 0; y < 96; y++) for (let x = 0; x < 112; x++) {
      if (m.get(x, y) || o.get(x, y) !== OUT) continue;
      const k = ((x >> 1) + (y >> 1)) % 4;
      if (k === 0) g.set(x, y, OUT); else if (k === 2) g.set(x, y, "#f4eeff");
    }
    // translucent body, plus a motion-blurred echo
    g.stamp(new Grid(112, 96).stamp(m).map((c) => (c ? al(c, c === body || c === lt(body, 0.28) || c === dk(body, 0.22) ? 0.92 : 0.7) : null)));
    g.stamp(new Grid(112, 96).stamp(m).map((c) => (c ? al("#c8a6ff", 0.18) : null)), 7, 2, { under: true });
    for (const [x, y] of [[8, 54], [104, 52], [36, 88], [96, 14], [4, 20]]) g.rect(x, y, 2, 2, al(wing, 0.7));
    shadow(g, 56, 40);
  },
};

/** Separate boss parts (32 x 32): octopus tentacle, hydra head, monolith microservice cube. */
const BOSS_PARTS_ART = {
  octopus_merge(g) {
    const pts = bez([6, 30], [4, 10], [22, 8], 8);
    pts.push([27, 12], [25, 17], [21, 15]);
    tentacle(g, pts, 9, 3, BRANCH_COLORS[0]);
  },
  deadlock_hydra(g) { hydraHead(g, 0, 4, false, 0); },
  monolith(g) { cube(g, 2, 2, 28); },
};

/** The review opponent (48 x 56): a greyed-out Termling in a tall hoodie with a red pen. */
function seniorReviewer() {
  const g = new Grid(48, 56);
  const hoodie = "#8a8f98", bar = "#5c616b", screen = "#22252b", pale = "#cfd6e0";
  g.layer((l) => { l.rect(13, 48, 6, 6, "#5c616b"); l.rect(28, 48, 6, 6, "#5c616b"); });
  g.layer((l) => {
    l.oval(6, 2, 34, 20, dk(hoodie, 0.1));
    l.rect(6, 10, 34, 40, hoodie); l.rect(6, 10, 2, 2, null); l.rect(38, 10, 2, 2, null);
    l.rect(2, 26, 4, 10, hoodie); l.rect(40, 26, 4, 10, hoodie);
    volume(l, hoodie, { d: 2 });
    l.rect(10, 12, 26, 6, bar);
    for (const x of [12, 16, 20]) l.rect(x, 14, 2, 2, pale);
    l.rect(10, 18, 26, 18, screen);
    // stern face: glasses over flat eyes, flat mouth
    l.fine(() => {
      l.ring(12, 21, 9, 7, 1, pale); l.ring(24, 21, 9, 7, 1, pale); l.rect(21, 23, 3, 1, pale);
      l.rect(14, 24, 5, 1, pale); l.rect(26, 24, 5, 1, pale);
      l.rect(18, 31, 10, 1, pale);
    });
    l.fine(() => { l.line(12, 37, 16, 48, dk(hoodie, 0.2), 1); l.line(34, 37, 30, 48, dk(hoodie, 0.2), 1); });
  });
  // the red pen
  g.layer((l) => {
    l.fine(() => { l.line(40, 40, 46, 18, "#e0393e", 3.2); l.line(45, 21, 46, 18, WHITE, 2); l.line(40, 40, 39, 44, "#2a2540", 2); });
  }, OUT, 1);
  return g;
}

// =============================================================================================
// Backgrounds: far silhouette tiles (160 x 100) and ground tiles (32 x 40) are drawn on wrapX
// grids with periodic functions, so they tile seamlessly; props (<= 48 x 64) stand on their
// bottom edge.
// =============================================================================================

const TAU = Math.PI * 2;
/** Sum of sines with integer frequencies k over period W: periodic, so tiles wrap seamlessly. */
const wave = (x, W, terms) => terms.reduce((s, [a, k, ph]) => s + a * Math.sin((TAU * k * x) / W + ph), 0);
/** Fill each 2 px column from f(x) down to the bottom. */
function ridge(g, f, c, step = 2) {
  for (let x = 0; x < g.w; x += step) { const y = Math.round(f(x + step / 2) / 2) * 2; g.rect(x, y, step, g.h - y, c); }
}
/** Tiny deterministic PRNG (LCG) for scattering texture. */
function rnd(seed) { let st = seed >>> 0 || 1; return () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296); }
/** Scatter n small rects of colour c (w x h) inside [x0,x1)x[y0,y1). */
function speckle(g, r, n, c, x0, y0, x1, y1, w = 2, h = 2) {
  for (let i = 0; i < n; i++) g.rect(Math.floor(x0 + r() * (x1 - x0) / 2) * 2, Math.floor(y0 + r() * (y1 - y0) / 2) * 2, w, h, c);
}

const BG = {
  lint_meadows: {
    far(g, p) {
      const back = mix(p.far, p.sky, 0.45);
      const front = (x) => 70 + wave(x, 160, [[7, 1, 2.2], [4, 3, 0.4]]);
      ridge(g, (x) => 46 + wave(x, 160, [[9, 1, 0.3], [5, 2, 1.7]]), back);
      ridge(g, front, p.far);
      for (const x of [16, 62, 102, 138]) {
        const y = Math.round(front(x) / 2) * 2;
        g.fine(() => { for (let k = 0; k < 14; k++) g.set(x + (k % 4 < 2 ? 0 : 1), y - k, p.accent); });
        g.oval(x - 5, y - 24, 12, 12, "#fbfbf2");
        g.fine(() => { g.set(x, y - 18, "#d8d8c8"); g.set(x - 2, y - 20, "#d8d8c8"); g.set(x + 3, y - 16, "#d8d8c8"); });
      }
    },
    ground(g, p) {
      const grass = mix(p.ground, "#9be07a", 0.4), r = rnd(11);
      g.rect(0, 0, 32, 40, p.ground);
      g.rect(0, 0, 32, 5, grass);
      const blades = [3, 6, 2, 5, 7, 3, 4, 6, 2, 5, 3, 7, 4, 2, 6, 3];
      blades.forEach((h, i) => g.rect(i * 2, 5, 2, h, grass));
      speckle(g, r, 10, dk(p.ground, 0.2), 0, 14, 32, 40);
      speckle(g, r, 5, lt(p.ground, 0.2), 0, 16, 32, 40);
      g.rect(10, 26, 4, 2, "#a8987a"); g.rect(24, 34, 2, 2, "#a8987a");
    },
    props: [
      [16, 40, (g, p) => {
        g.fine(() => { for (let y = 12; y < 40; y++) g.set(7 + (Math.floor(y / 2) % 2), y, p.accent); });
        g.poly([[8, 40], [2, 30], [6, 33], [4, 26], [9, 36]], "#5fae5a"); g.poly([[9, 40], [15, 31], [11, 34], [13, 27], [8, 36]], "#5fae5a");
        g.oval(1, 0, 14, 14, "#fbfbf2"); g.shade("#fbfbf2", "#dcdccc", 1, 1, 2);
        g.fine(() => { for (const [x, y] of [[4, 4], [8, 3], [11, 6], [6, 9], [10, 10]]) g.set(x, y, "#b8b8a8"); });
      }],
      [24, 16, (g) => {
        const c = ["#5fae5a", "#7cc96b", "#4e9a4a"];
        g.fine(() => { for (let i = 0; i < 9; i++) g.line(3 + i * 2, 15, 1 + i * 2.5, 4 + (i % 3) * 3, c[i % 3], 2); });
        g.rect(6, 4, 2, 2, "#fbfbf2"); g.rect(16, 6, 2, 2, "#e0605a");
      }],
      [24, 32, (g, p) => {
        g.rect(10, 12, 4, 20, "#8a5a35");
        g.poly([[1, 2], [19, 2], [23, 8], [19, 14], [1, 14]], "#f3ead2");
        g.shade("#f3ead2", "#d8cba8", 0, 1, 2);
        g.fine(() => { g.rect(4, 5, 8, 1, "#5a4a3a"); g.rect(4, 8, 12, 1, "#5a4a3a"); for (let x = 3; x < 16; x++) g.set(x, 11 + (x % 2), p.accent); });
      }],
    ],
  },
  callback_caverns: {
    far(g, p) {
      const back = mix(p.far, p.sky, 0.4);
      ridge(g, (x) => 84 + wave(x, 160, [[5, 2, 0.6], [3, 5, 1.1]]), back);
      ridge(g, (x) => 92 + wave(x, 160, [[4, 3, 2.0], [2, 7, 0.2]]), p.far);
      // cave ceiling with stalactites shaped like nested braces {{{
      for (let x = 0; x < 160; x += 2) g.rect(x, 0, 2, Math.round((6 + wave(x, 160, [[3, 4, 0.5]])) / 2) * 2, p.far);
      for (const [x, h] of [[14, 30], [44, 22], [78, 36], [110, 26], [140, 32]]) {
        g.fine(() => {
          for (let k = 0; k < 3; k++) brace(g, x + k * 7, 2, h - k * 6, true, k === 1 ? back : p.far, 3);
        });
      }
      for (const [x, h] of [[30, 12], [64, 16], [96, 10], [128, 14]]) g.poly([[x - 4, 4], [x + 4, 4], [x, 4 + h]], p.far);
      for (const x of [24, 58, 92, 122, 152]) {
        const y = Math.round((92 + wave(x, 160, [[4, 3, 2.0], [2, 7, 0.2]])) / 2) * 2;
        g.rect(x, y - 4, 2, 4, lt(p.far, 0.3)); g.oval(x - 3, y - 8, 8, 4, p.accent);
      }
    },
    ground(g, p) {
      const r = rnd(22);
      g.rect(0, 0, 32, 40, p.ground);
      g.rect(0, 0, 32, 4, lt(p.ground, 0.15));
      g.fine(() => { g.path([[0, 14], [6, 16], [12, 13], [20, 18], [32, 14]], dk(p.ground, 0.3), 1); g.path([[4, 30], [12, 28], [18, 32], [26, 29], [36, 30]], dk(p.ground, 0.3), 1); });
      speckle(g, r, 8, lt(p.ground, 0.12), 0, 6, 32, 40);
      g.rect(8, 22, 2, 2, p.accent); g.rect(26, 10, 2, 2, al(p.accent, 0.7)); g.rect(18, 36, 2, 2, al(p.accent, 0.6));
    },
    props: [
      [24, 24, (g, p) => {
        for (const [x, w, h] of [[2, 10, 14], [12, 8, 10], [17, 6, 7]]) {
          g.rect(x + w / 2 - 1, 24 - h, 2 + (w > 8 ? 2 : 0), h, "#d9d0f0");
          g.oval(x, 24 - h - 4, w, 6, p.accent); g.shade(p.accent, "#5fc8e8", 0, 1, 1);
          g.fine(() => g.set(x + 2, 24 - h - 3, WHITE));
        }
      }],
      [16, 40, (g, p) => {
        g.poly([[2, 40], [14, 40], [11, 24], [9, 4], [6, 24]], "#5b4a86");
        g.shade("#5b4a86", "#463566", 1, 0, 2);
        brace(g, 5, 14, 20, true, p.accent, 2);
      }],
      [16, 24, (g, p) => {
        g.poly([[2, 24], [4, 8], [7, 4], [8, 24]], "#7fd4f0"); g.poly([[7, 24], [10, 2], [13, 6], [14, 24]], p.accent);
        g.shade(p.accent, "#5fc8e8", 1, 0, 2); g.fine(() => { g.rect(10, 6, 1, 8, WHITE); g.rect(5, 10, 1, 6, WHITE); });
      }],
    ],
  },
  regex_ruins: {
    far(g, p) {
      const back = mix(p.far, p.sky, 0.45);
      ridge(g, (x) => 82 + wave(x, 160, [[6, 1, 0.9], [3, 3, 2.4]]), back);
      // colonnade with lintels
      for (const x of [8, 28, 48]) g.rect(x, 34, 10, 66, p.far);
      g.rect(4, 28, 58, 8, p.far);
      g.rect(96, 50, 10, 50, p.far); g.rect(122, 42, 10, 58, p.far);
      g.oval(94, 20, 40, 40, p.far); g.oval(104, 30, 20, 30, null); g.rect(96, 40, 36, 10, p.far);
      g.rect(106, 50, 16, 50, null);
      g.fine(() => { g.text(28 - 1, 40, "^", p.accent); g.text(30, 48, ".", p.accent); g.text(28, 56, "*", p.accent); g.text(28, 64, "$", p.accent); });
      ridge(g, (x) => 90 + wave(x, 160, [[4, 2, 0.1], [2, 5, 1.3]]), dk(p.far, 0.1));
    },
    ground(g, p) {
      g.rect(0, 0, 32, 40, p.ground);
      const mort = dk(p.ground, 0.25), hi = lt(p.ground, 0.15);
      for (let row = 0; row < 5; row++) {
        const y = row * 8;
        g.rect(0, y, 32, 1, mort);
        const off = row % 2 ? 8 : 0;
        for (let x = off; x < 32 + off; x += 16) { g.rect(x, y + 1, 1, 7, mort); g.rect(x + 1, y + 1, 14, 1, hi); }
      }
      g.rect(20, 18, 2, 2, p.accent); g.rect(5, 34, 2, 2, p.accent);
    },
    props: [
      [16, 48, (g, p) => {
        g.rect(1, 0, 14, 4, "#e6d3a8"); g.rect(1, 44, 14, 4, "#e6d3a8");
        g.rect(3, 4, 10, 40, p.accent); g.shade(p.accent, dk(p.accent, 0.25), 1, 0, 2); g.shade(p.accent, lt(p.accent, 0.3), -1, 0, 1);
        g.fine(() => { const ink = dk(p.accent, 0.55); g.text(6, 7, "^", ink); g.text(7, 15, ".", ink); g.text(6, 23, "*", ink); g.text(6, 32, "$", ink); });
      }],
      [24, 24, (g) => {
        const c = "#d6b27c";
        g.poly([[2, 24], [2, 6], [8, 2], [12, 6], [16, 0], [22, 4], [22, 24]], c);
        g.shade(c, dk(c, 0.2), 1, 0, 2); g.shade(c, lt(c, 0.2), 0, -1, 1);
        g.fine(() => { g.rect(7, 8, 1, 16, dk(c, 0.2)); g.rect(15, 8, 1, 16, dk(c, 0.2)); });
      }],
      [16, 20, (g, p) => {
        const c = "#b8643a";
        g.oval(1, 6, 14, 14, c); g.rect(4, 2, 8, 6, c); g.rect(3, 0, 10, 2, dk(c, 0.2));
        g.rect(1, 12, 14, 2, p.accent); g.shade(c, dk(c, 0.2), 1, 1, 2);
      }],
    ],
  },
  merge_marshes: {
    far(g, p) {
      const back = mix(p.far, p.sky, 0.45);
      ridge(g, (x) => 60 + wave(x, 160, [[6, 1, 1.4], [4, 3, 0.2]]), back);
      // dead trees
      for (const x of [20, 112]) { g.rect(x, 30, 4, 60, p.far); g.line(x, 44, x - 10, 34, p.far, 3); g.line(x + 2, 52, x + 14, 40, p.far, 3); g.line(x - 8, 36, x - 12, 30, p.far, 2); }
      // fence posts carved with <<<<<<<
      for (let x = 44; x < 100; x += 12) {
        g.rect(x, 66, 6, 26, p.far);
        g.fine(() => { for (let k = 0; k < 4; k++) g.bitmap(x + 2, 69 + k * 5, FONT["<"], mix(p.accent, p.far, 0.3)); });
      }
      g.rect(42, 72, 60, 2, p.far); g.rect(42, 82, 60, 2, p.far);
      for (const x of [6, 34, 132, 150]) for (let k = 0; k < 3; k++) g.rect(x + k * 3, 78 - k * 4, 2, 14 + k * 4, p.far);
      // two-tone diff water
      for (let y = 90; y < 100; y += 2) g.rect(0, y, 160, 2, (y / 2) % 2 ? mix("#5ac46a", p.far, 0.55) : mix(p.accent, p.far, 0.55));
    },
    ground(g, p) {
      const r = rnd(44);
      g.rect(0, 0, 32, 40, p.ground);
      g.rect(0, 0, 32, 4, mix(p.ground, "#8fa36a", 0.5));
      [2, 4, 1, 3, 5, 2, 3, 1, 4, 2, 3, 5, 1, 2, 4, 3].forEach((h, i) => g.rect(i * 2, 4, 2, h, mix(p.ground, "#8fa36a", 0.5)));
      g.rect(4, 20, 10, 4, mix("#e05a5a", p.ground, 0.55)); g.rect(18, 30, 10, 4, mix("#5ac46a", p.ground, 0.55));
      speckle(g, r, 8, dk(p.ground, 0.2), 0, 10, 32, 40);
    },
    props: [
      [32, 30, (g, p) => {
        // a fence board carved with a conflict marker: <<<<<<<
        const wood = "#8a6a45", board = "#c9a878";
        g.rect(4, 2, 4, 28, wood); g.rect(24, 2, 4, 28, wood);
        g.shade(wood, dk(wood, 0.25), 1, 0, 2);
        g.rect(1, 6, 30, 9, board); g.shade(board, dk(board, 0.2), 0, 1, 1);
        g.fine(() => g.text(3, 8, "<<<<<<<", p.accent));
      }],
      [20, 32, (g) => {
        g.fine(() => { for (const [x, h] of [[3, 26], [8, 30], [13, 22], [17, 18]]) { g.rect(x, 32 - h, 1, h, "#6b7f45"); g.rect(x - 1, 32 - h, 3, 6, "#6a4630"); } });
        g.poly([[0, 32], [4, 20], [6, 32]], "#7f9a52"); g.poly([[12, 32], [18, 22], [16, 32]], "#7f9a52");
      }],
      [28, 8, (g, p) => {
        // a two-tone diff puddle: the red half is "-", the green half is "+"
        g.fine(() => { g.oval(0, 2, 18, 6, mix(p.accent, "#4f5e34", 0.2)); g.oval(10, 1, 18, 7, "#5ac46a"); g.oval(6, 3, 10, 4, mix(p.accent, "#4f5e34", 0.2)); });
        g.fine(() => { g.rect(5, 4, 3, 1, WHITE); g.rect(19, 4, 3, 1, WHITE); g.rect(20, 3, 1, 3, WHITE); });
      }],
    ],
  },
  dependency_jungle: {
    far(g, p) {
      const back = mix(p.far, p.sky, 0.45);
      ridge(g, (x) => 30 + wave(x, 160, [[8, 2, 0.4], [5, 5, 1.9]]), back);
      for (const [x, y, w] of [[0, 14, 40], [36, 6, 46], [78, 16, 38], [112, 8, 50], [150, 12, 30]]) g.oval(x, y, w, w * 0.7, p.far);
      ridge(g, (x) => 60 + wave(x, 160, [[6, 3, 0.4]]), dk(p.far, 0.1));
      // vines drawn as dependency graphs: nodes and arrows
      for (const x of [22, 70, 120]) {
        g.fine(() => {
          g.rect(x, 30, 1, 40, mix(p.accent, p.far, 0.3));
          for (const y of [36, 50, 64]) { g.oval(x - 2, y - 2, 5, 5, mix(p.accent, p.far, 0.2)); g.line(x, y + 3, x + 6, y + 9, mix(p.accent, p.far, 0.3), 1); g.rect(x + 5, y + 8, 2, 2, mix(p.accent, p.far, 0.3)); }
        });
      }
      for (const x of [40, 140]) { g.rect(x, 80, 16, 14, mix("#c08a50", p.far, 0.4)); g.fine(() => g.text(x + 2, 84, "pkg", dk(p.far, 0.3))); }
    },
    ground(g, p) {
      const r = rnd(55);
      g.rect(0, 0, 32, 40, p.ground);
      g.rect(0, 0, 32, 4, lt(p.ground, 0.15));
      g.fine(() => { g.path([[0, 12], [8, 15], [14, 12], [22, 17], [32, 12]], lt(p.ground, 0.2), 1); g.path([[0, 28], [10, 25], [18, 30], [32, 28]], lt(p.ground, 0.2), 1); });
      speckle(g, r, 6, "#4e9a5a", 0, 6, 32, 40, 3, 2);
      speckle(g, r, 4, dk(p.ground, 0.3), 0, 6, 32, 40);
      g.rect(24, 22, 2, 2, al(p.accent, 0.7));
    },
    props: [
      [24, 24, (g, p) => {
        const c = "#c08a50";
        g.rect(1, 2, 22, 22, c); g.rect(1, 2, 22, 2, dk(c, 0.3)); g.rect(1, 22, 22, 2, dk(c, 0.3)); g.rect(1, 2, 2, 22, dk(c, 0.3)); g.rect(21, 2, 2, 22, dk(c, 0.3));
        g.fine(() => { g.rect(5, 8, 14, 9, "#f3ead2"); g.text(6, 10, "pkg", "#8e2f2a"); });
      }],
      [20, 48, (g, p) => {
        const v = "#3f7f3a";
        g.fine(() => {
          g.path([[10, 48], [8, 36], [12, 24], [9, 12], [11, 2]], v, 3);
          for (const [x, y, d] of [[9, 36, -1], [12, 24, 1], [9, 12, -1]]) {
            g.oval(x - 3, y - 3, 6, 6, p.accent); g.line(x, y, x + d * 7, y - 5, v, 1.4);
            g.poly([[x + d * 9, y - 6], [x + d * 5, y - 7], [x + d * 6, y - 3]], v);
          }
        });
        g.oval(12, 40, 8, 5, "#7cc96b"); g.oval(1, 28, 8, 5, "#7cc96b");
      }],
      [28, 20, (g) => {
        const c = "#4e9a5a";
        g.fine(() => { for (let i = 0; i < 5; i++) { const a = Math.PI * (0.15 + i * 0.17); g.line(14, 20, 14 - Math.cos(a) * 14, 20 - Math.sin(a) * 18, i % 2 ? c : "#6fbf55", 3); } });
      }],
    ],
  },
  threadlock_keep: {
    far(g, p) {
      const back = mix(p.far, p.sky, 0.45);
      // big clockwork gear behind the walls
      g.ring(96, 4, 52, 52, 8, back);
      for (let k = 0; k < 10; k++) { const a = (k / 10) * TAU; g.rect(Math.round(122 + Math.cos(a) * 28) - 3, Math.round(30 + Math.sin(a) * 28) - 3, 6, 6, back); }
      g.oval(116, 24, 12, 12, back);
      // castle wall with crenellations and two towers
      g.rect(0, 50, 160, 50, p.far);
      for (let x = 0; x < 160; x += 10) g.rect(x, 44, 6, 6, p.far);
      for (const x of [26, 86]) { g.rect(x, 22, 22, 30, p.far); g.poly([[x - 2, 22], [x + 11, 6], [x + 24, 22]], p.far); g.rect(x + 8, 30, 6, 10, p.sky); }
      // padlocks in the wall and sparks
      for (const x of [10, 60, 120, 146]) { g.fine(() => g.ring(x, 58, 8, 8, 1.5, dk(p.far, 0.35))); g.rect(x - 1, 62, 10, 8, dk(p.far, 0.35)); g.rect(x + 3, 65, 2, 2, p.accent); }
      for (const [x, y] of [[50, 40], [52, 36], [140, 46], [74, 30]]) g.fine(() => g.set(x, y, p.accent));
    },
    ground(g, p) {
      g.rect(0, 0, 32, 40, p.ground);
      const copper = "#8a5a3b";
      g.rect(0, 0, 32, 3, copper);
      for (let row = 0; row < 3; row++) {
        const y = 4 + row * 12, off = row % 2 ? 8 : 0;
        g.rect(0, y + 11, 32, 1, dk(p.ground, 0.4));
        for (let x = off; x < 32 + off; x += 16) { g.rect(x, y, 1, 11, dk(p.ground, 0.4)); g.rect(x + 1, y, 15, 1, lt(p.ground, 0.12)); g.rect(x + 3, y + 3, 1, 1, copper); }
      }
    },
    props: [
      [16, 32, (g, p) => {
        g.rect(5, 14, 6, 18, "#5a5e66"); g.shade("#5a5e66", "#3a3d4a", 1, 0, 2);
        g.ring(3, 0, 10, 12, 2, "#9aa3ad"); g.rect(1, 6, 14, 12, "#8a5a3b"); g.shade("#8a5a3b", "#5a3216", 0, 1, 2);
        g.fine(() => { g.rect(7, 10, 2, 3, p.accent); g.rect(6, 10, 4, 1, p.accent); });
      }],
      [28, 20, (g, p) => {
        const c = "#b8733a";
        g.ring(4, 2, 20, 20, 5, c);
        for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; g.rect(Math.round(14 + Math.cos(a) * 11) - 2, Math.round(12 + Math.sin(a) * 11) - 2, 4, 4, c); }
        g.shade(c, dk(c, 0.25), 1, 1, 1); g.rect(0, 18, 28, 2, "#3a3d4a");
        g.fine(() => g.set(22, 4, p.accent));
      }],
      [12, 32, (g, p) => {
        g.rect(4, 12, 4, 20, "#5a5e66"); g.rect(2, 10, 8, 4, "#8a5a3b");
        g.poly([[2, 10], [6, 0], [10, 10]], p.accent); g.poly([[4, 10], [6, 4], [8, 10]], "#fff1b8");
      }],
    ],
  },
  legacy_catacombs: {
    far(g, p) {
      const back = mix(p.far, p.sky, 0.45);
      // punch-card brick wall
      g.rect(0, 20, 160, 80, back);
      for (let row = 0; row < 10; row++) {
        const y = 20 + row * 8, off = row % 2 ? 10 : 0;
        g.rect(0, y, 160, 1, p.sky);
        for (let x = off; x < 160 + off; x += 20) { g.rect(x, y, 1, 8, p.sky); g.rect(x + 4, y + 3, 2, 2, p.sky); g.rect(x + 10, y + 3, 2, 2, p.sky); g.rect(x + 14, y + 5, 2, 1, p.sky); }
      }
      // CRT tombstones with green text
      for (const [x, h] of [[12, 30], [52, 36], [96, 28], [132, 34]]) {
        const y = 100 - h;
        g.rect(x, y + 6, 26, h - 6, p.far); g.oval(x, y, 26, 14, p.far);
        g.rect(x + 5, y + 7, 16, 12, dk(p.far, 0.5));
        g.fine(() => { for (let k = 0; k < 3; k++) g.rect(x + 7, y + 9 + k * 3, 6 + ((k * 5 + x) % 7), 1, p.accent); });
      }
    },
    ground(g, p) {
      g.rect(0, 0, 32, 40, p.ground);
      const brick = lt(p.ground, 0.1);
      for (let row = 0; row < 5; row++) {
        const y = row * 8, off = row % 2 ? 8 : 0;
        for (let x = off; x < 32 + off; x += 16) {
          g.rect(x + 1, y + 1, 14, 6, brick);
          g.rect(x + 4, y + 3, 2, 2, p.ground); g.rect(x + 9, y + 3, 2, 2, p.ground);
        }
      }
      g.rect(0, 0, 32, 2, al(p.accent, 0.35)); g.rect(6, 2, 4, 2, al(p.accent, 0.35)); g.rect(22, 2, 2, 3, al(p.accent, 0.35));
    },
    props: [
      [24, 28, (g, p) => {
        const c = "#6a7068";
        g.rect(1, 8, 22, 20, c); g.oval(1, 0, 22, 16, c); g.shade(c, dk(c, 0.25), 1, 1, 2);
        g.rect(5, 6, 14, 12, "#0d130f");
        g.fine(() => { g.rect(7, 8, 8, 1, p.accent); g.rect(7, 11, 5, 1, p.accent); g.rect(7, 14, 9, 1, p.accent); g.rect(13, 11, 1, 1, p.accent); });
      }],
      [16, 36, (g) => {
        const c = "#e8dcc0";
        for (let k = 0; k < 9; k++) g.rect(1 + (k % 2), 36 - (k + 1) * 4, 14, 4, k % 2 ? c : dk(c, 0.08));
        g.fine(() => { for (let k = 0; k < 9; k++) for (let j = 0; j < 3; j++) g.rect(3 + ((k * 3 + j * 5) % 10), 37 - (k + 1) * 4, 1, 2, "#9a8e74"); });
      }],
      [16, 16, (g, p) => {
        for (const [x, h] of [[2, 8], [7, 11], [12, 6]]) { g.fine(() => { g.rect(x, 16 - h, 3, h, "#e8e0c8"); g.rect(x, 12 - h, 3, 3, p.accent); g.set(x + 1, 11 - h, WHITE); }); }
      }],
    ],
  },
  production_peaks: {
    far(g, p) {
      const back = mix(p.far, p.sky, 0.45);
      // jagged peaks whose cliffs are server racks
      g.poly([[-10, 100], [30, 20], [56, 60], [80, 8], [118, 70], [140, 30], [170, 100]], back);
      g.poly([[150, 100], [140 + 30, 20], [216, 60], [240, 8], [278, 70], [300, 30], [330, 100]].map(([x, y]) => [x - 160, y]), back);
      for (const [x, w, top] of [[8, 22, 50], [40, 18, 64], [70, 26, 34], [108, 20, 58], [132, 24, 44]]) {
        g.rect(x, top, w, 100 - top, p.far);
        for (let y = top + 4; y < 100; y += 6) {
          g.rect(x + 2, y, w - 4, 1, dk(p.far, 0.3));
          g.fine(() => g.set(x + w - 4, y + 2, (y + x) % 3 ? "#66ff99" : p.accent));
        }
      }
      g.fine(() => g.path([[100, 0], [96, 10], [102, 12], [97, 24]], "#c8d0ff", 1.5));
    },
    ground(g, p) {
      g.rect(0, 0, 32, 40, p.ground);
      g.rect(0, 0, 32, 4, lt(p.ground, 0.15));
      for (const x of [0, 16]) { g.rect(x, 4, 1, 36, dk(p.ground, 0.4)); g.rect(x + 3, 8, 1, 1, lt(p.ground, 0.3)); g.rect(x + 12, 8, 1, 1, lt(p.ground, 0.3)); }
      g.rect(0, 20, 32, 4, dk(p.ground, 0.35)); g.rect(0, 21, 32, 1, "#3e4a6b");
      g.rect(6, 21, 2, 1, p.accent); g.rect(22, 21, 2, 1, "#66ff99");
      g.rect(0, 34, 32, 1, dk(p.ground, 0.4));
    },
    props: [
      [20, 40, (g, p) => {
        g.rect(1, 0, 18, 40, "#2a3148"); g.rect(1, 0, 18, 2, "#4a5578");
        for (let y = 4; y < 38; y += 5) {
          g.rect(3, y, 14, 4, "#3e4a6b");
          g.fine(() => { g.set(5, y + 1, (y % 3) ? "#66ff99" : p.accent); g.set(7, y + 1, "#66ff99"); g.rect(10, y + 2, 5, 1, "#2a3148"); });
        }
      }],
      [24, 16, (g) => {
        g.poly([[0, 16], [4, 6], [12, 2], [20, 6], [24, 16]], "#3e4a6b"); g.shade("#3e4a6b", "#2a3148", 1, 1, 2);
        g.fine(() => g.path([[2, 16], [8, 10], [14, 12], [22, 8]], "#ff8a3d", 1.4));
      }],
      [10, 36, (g, p) => {
        g.rect(4, 8, 2, 28, "#5a6480"); g.rect(1, 32, 8, 4, "#3e4a6b");
        g.oval(1, 0, 8, 8, p.accent); g.fine(() => { g.set(3, 2, WHITE); g.rect(0, 3, 1, 2, al(p.accent, 0.5)); g.rect(9, 3, 1, 2, al(p.accent, 0.5)); });
      }],
    ],
  },
  undefined_depths: {
    far(g, p) {
      const back = mix(p.far, p.sky, 0.45);
      for (const [x, y, w, h] of [[6, 20, 40, 16], [70, 34, 30, 12], [118, 14, 36, 18]]) {
        g.rect(x, y, w, 4, back); g.poly([[x, y + 4], [x + w, y + 4], [x + w * 0.6, y + h], [x + w * 0.3, y + h - 3]], back);
      }
      ridge(g, (x) => 84 + wave(x, 160, [[6, 2, 0.3], [4, 5, 1.2]]), p.far);
      // glitch static and NaN motes
      const r = rnd(99);
      for (let i = 0; i < 14; i++) g.rect(Math.floor(r() * 80) * 2, 40 + Math.floor(r() * 20) * 2, 2 + Math.floor(r() * 4) * 2, 2, i % 3 ? back : p.accent);
      g.fine(() => { g.text(48, 14, "NaN", p.accent); g.text(104, 54, "NaN", mix(p.accent, p.far, 0.4)); g.text(14, 64, "NaN", mix(p.accent, p.far, 0.4)); });
    },
    ground(g, p) {
      const r = rnd(77);
      g.rect(0, 0, 32, 40, p.ground);
      g.rect(0, 0, 32, 4, mix(p.ground, p.accent, 0.2));
      speckle(g, r, 8, mix(p.ground, p.accent, 0.25), 0, 6, 32, 40, 2, 1);
      speckle(g, r, 3, al(p.accent, 0.6), 0, 6, 32, 40, 1, 1);
      g.rect(4, 18, 16, 2, mix(p.ground, "#3a2466", 0.7)); g.rect(10, 18, 4, 2, "#05020c");
    },
    props: [
      [24, 24, (g, p) => {
        g.poly([[2, 24], [6, 16], [18, 16], [22, 24]], "#3a2466");
        g.poly([[8, 16], [10, 2], [14, 0], [16, 16]], p.accent); g.shade(p.accent, dk(p.accent, 0.25), 1, 0, 2);
        g.fine(() => g.text(5, 18, "NaN", WHITE));
      }],
      [16, 40, (g, p) => {
        const c = "#4a3480";
        g.poly([[3, 40], [5, 6], [8, 0], [11, 6], [13, 40]], c); g.shade(c, dk(c, 0.3), 1, 0, 2);
        g.shiftRows(12, 15, 3); g.shiftRows(24, 27, -2);
        g.fine(() => { g.rect(7, 18, 2, 2, p.accent); g.rect(6, 30, 2, 1, p.accent); });
      }],
      [16, 20, (g, p) => {
        g.rect(6, 10, 4, 10, "#d9ccf5"); g.oval(1, 2, 14, 10, "#7a4fc2"); g.shade("#7a4fc2", "#5a3696", 0, 1, 2);
        g.fine(() => { g.set(4, 5, p.accent); g.set(9, 4, p.accent); g.set(11, 7, p.accent); });
      }],
    ],
  },
  backlog: {
    far(g, p) {
      const back = mix(p.far, p.sky, 0.45);
      for (const [x, h, w] of [[4, 60, 22], [30, 82, 18], [52, 50, 26], [84, 74, 20], [108, 56, 24], [136, 88, 20]]) {
        for (let y = 100 - h; y < 100; y += 6) g.rect(x + ((y / 6) % 2) * 2, y, w, 5, (y / 6) % 2 ? p.far : back);
      }
      for (const x of [26, 104]) { g.rect(x, 20, 2, 80, back); g.oval(x - 4, 14, 10, 8, p.accent); }
    },
    ground(g, p) {
      g.rect(0, 0, 32, 40, p.ground);
      for (const y of [0, 16, 32]) g.rect(0, y, 32, 1, lt(p.ground, 0.15));
      for (const [x, y] of [[0, 1], [16, 17], [8, 33], [24, 33]]) g.rect(x, y, 1, 15, lt(p.ground, 0.12));
      g.rect(10, 6, 8, 5, lt(p.ground, 0.08)); g.rect(26, 24, 4, 3, al(p.accent, 0.3));
    },
    props: [
      [16, 32, (g) => { for (let k = 0; k < 8; k++) g.rect(1 + (k % 3), 32 - (k + 1) * 4, 13, 4, k % 2 ? "#e8eaf0" : "#c8ccd8"); g.fine(() => { for (let k = 0; k < 8; k++) g.rect(4 + (k % 3), 33 - (k + 1) * 4, 6, 1, "#8a90a0"); }); }],
      [12, 40, (g, p) => { g.rect(5, 8, 2, 32, "#5a6070"); g.rect(2, 36, 8, 4, "#3a4050"); g.oval(1, 0, 10, 10, p.accent); g.fine(() => g.set(4, 3, WHITE)); }],
      [24, 16, (g) => { g.rect(1, 4, 22, 12, "#8a7a5a"); g.rect(1, 4, 22, 2, "#6a5a3a"); for (let k = 0; k < 5; k++) g.rect(3 + k * 4, 0 + (k % 2), 3, 5, "#e8eaf0"); }],
    ],
  },
};

const BG_ZONES = () => [...ZONES.map((z) => ({ id: z.id, palette: z.palette })), { id: BACKLOG.id, palette: BACKLOG.palette }];

function bgAssets(out) {
  for (const z of BG_ZONES()) {
    const def = BG[z.id], p = z.palette;
    if (!def) throw new Error(`gen-art: no background for ${z.id}`);
    const far = new Grid(160, 100, { wrapX: true });
    def.far(far, p);
    out.set(`art/bg/${z.id}-far.svg`, far.toSVG());
    const ground = new Grid(32, 40, { wrapX: true });
    def.ground(ground, p);
    out.set(`art/bg/${z.id}-ground.svg`, ground.toSVG());
    def.props.forEach(([w, h, draw], i) => {
      const g = new Grid(w, h);
      draw(g, p);
      g.outline(dk(p.ground, 0.55), { r: 1 });
      out.set(`art/bg/${z.id}-prop-${i + 1}.svg`, g.toSVG());
    });
  }
}

// =============================================================================================
// FX (chests, campfire, bubble, ...), gear and UI icons
// =============================================================================================

function chest(tier, open) {
  const c = CHEST_TIERS.find((t) => t.id === tier).color;
  const band = { wooden: "#5a5e66", iron: "#4a4f58", silver: "#8fb0cc", gold: "#c9971a" }[tier];
  const g = new Grid(28, 22);
  const body = c, shadeC = dk(c, 0.22);
  g.rect(2, 10, 24, 10, body);
  if (open) {
    g.rect(3, 1, 22, 4, dk(c, 0.15)); g.rect(3, 4, 22, 2, dk(c, 0.4));     // lid flipped back
    g.rect(3, 6, 22, 4, "#2a1d14");                                         // inside
    g.rect(6, 7, 16, 3, "#fff4d6"); g.rect(9, 6, 10, 1, "#fff4d6");          // glow of loot
  } else {
    g.rect(2, 4, 24, 7, lt(c, 0.08)); g.rect(4, 2, 20, 2, lt(c, 0.08));
    g.rect(2, 10, 24, 1, dk(c, 0.4));
  }
  g.shade(body, shadeC, 0, 1, 2);
  for (const x of [6, 20]) { g.rect(x, open ? 10 : 2, 2, open ? 10 : 18, band); }
  if (tier === "wooden") g.fine(() => { g.rect(2, 14, 24, 1, dk(c, 0.3)); });
  if (tier === "iron" || tier === "silver") for (const [x, y] of [[3, 12], [24, 12], [3, 18], [24, 18]]) g.set(x, y, dk(band, 0.3));
  g.rect(12, open ? 10 : 8, 4, 5, tier === "gold" ? "#8a5a10" : "#3a3d4a"); g.rect(13, open ? 12 : 10, 2, 2, tier === "gold" ? "#fff4d6" : "#c9971a");
  if (tier === "gold") g.fine(() => { g.set(4, open ? 12 : 5, WHITE); g.set(23, 15, WHITE); });
  g.outline(OUT);
  return g;
}

/** Duck Chest (D§8.6): pastel holo chest with a little duck on the lid, 28 x 28. */
function duckChest(open) {
  const g = new Grid(28, 28);
  const base = "#e9e2ff", bands = ["#ffc2e2", "#bdf5da", "#bfe3ff"];
  g.rect(2, 16, 24, 10, base);
  if (open) { g.rect(3, 8, 22, 4, "#d7ccf5"); g.rect(3, 12, 22, 4, "#2a1d3a"); g.rect(6, 13, 16, 3, "#fff4d6"); }
  else { g.rect(2, 10, 24, 7, base); g.rect(4, 8, 20, 2, base); }
  g.map((c, x, y) => (c === base && (x + y) % 8 < 2 ? bands[Math.floor((x + y) / 8) % 3] : c));
  g.rect(12, 15, 4, 5, "#7a5bc7"); g.rect(13, 17, 2, 2, WHITE);
  if (!open) { g.oval(10, 0, 9, 9, "#efe9ff"); g.oval(14, 4, 9, 6, "#efe9ff"); g.rect(8, 4, 3, 2, "#f28c38"); g.rect(12, 3, 1, 1, INK); }
  g.outline(OUT);
  return g;
}

const FX_ART = {
  "campfire.svg": [24, 24, (g) => {
    g.layer((l) => { for (const x of [2, 8, 14, 18]) l.oval(x, 19, 6, 5, "#8a8f98"); l.shade("#8a8f98", "#5c616b", 0, 1, 1); }, OUT, 1);
    g.layer((l) => { l.fine(() => { l.line(4, 20, 19, 15, "#8a5a35", 3); l.line(5, 15, 19, 20, "#6e4426", 3); }); }, OUT, 1);
    g.layer((l) => {
      l.fine(() => {
        l.poly([[6, 17], [7, 9], [10, 12], [12, 2], [15, 10], [17, 7], [18, 17]], "#ff5a3d");
        l.poly([[8, 17], [10, 12], [12, 6], [14, 12], [16, 17]], "#ff9a2e");
        l.poly([[10, 17], [12, 11], [14, 17]], "#fff1b8");
      });
    }, null);
  }],
  "bubble.svg": [18, 20, (g) => {
    const ink = "#1b1b1f";
    g.fine(() => {
      g.rect(3, 2, 12, 13, WHITE); g.rect(2, 3, 14, 11, WHITE);
      g.poly([[4, 14], [9, 14], [4, 18]], WHITE);
    });
    g.outline(ink);
    g.rect(8, 4, 2, 6, ink); g.rect(8, 11, 2, 2, ink);   // the "!" (reserved for blocked), drawn as rects
  }],
  "crate.svg": [24, 16, (g) => {
    const c = "#b9824b";
    g.rect(2, 2, 20, 12, c);
    g.rect(2, 2, 20, 2, dk(c, 0.3)); g.rect(2, 12, 20, 2, dk(c, 0.3)); g.rect(2, 2, 2, 12, dk(c, 0.3)); g.rect(20, 2, 2, 12, dk(c, 0.3));
    g.fine(() => { g.line(4, 4, 19, 11, dk(c, 0.25), 1.4); g.rect(4, 8, 16, 1, dk(c, 0.15)); });
    g.outline(OUT, { r: 1 });
  }],
  "coin.svg": [6, 6, (g) => {
    g.bitmap(0, 0, [".oooo.", "ohhcco", "ohccco", "occcdo", "occddo", ".oooo."], { o: "#7a5a1c", c: "#c89b3c", h: "#f0d28a", d: "#a07a28" });
  }],
  "poof.svg": [24, 24, (g) => {
    const c = "#f4f2ec";
    for (const [x, y, w] of [[2, 10, 10], [7, 4, 11], [12, 9, 10], [5, 13, 14], [14, 14, 8]]) g.oval(x, y, w, w, c);
    g.shade(c, "#d8d4ca", 1, 1, 2);
    g.outline("#8a8a94", { r: 1 });
    g.fine(() => { g.set(1, 4, "#d8d4ca"); g.set(21, 5, "#d8d4ca"); g.set(22, 20, "#d8d4ca"); });
  }],
  "door.svg": [24, 40, (g) => {
    const stone = "#6a6f7a";
    g.rect(1, 8, 22, 32, stone); g.oval(1, 0, 22, 18, stone);
    g.rect(5, 10, 14, 30, "#1b1726"); g.oval(5, 4, 14, 14, "#1b1726");
    for (let y = 20; y < 40; y += 4) g.rect(5, y, 14, 4, mix("#1b1726", "#ff5a5f", 0.12 + (y - 20) / 50));
    g.fine(() => { for (let y = 12; y < 40; y += 6) { g.rect(1, y, 4, 1, dk(stone, 0.3)); g.rect(19, y + 3, 4, 1, dk(stone, 0.3)); } });
    // horned boss mark over the doorway
    g.fine(() => { g.poly([[8, 4], [10, 8], [14, 8], [16, 4], [15, 10], [9, 10]], "#ff5a5f"); });
    g.outline(OUT, { r: 1 });
  }],
  "portal.svg": [32, 48, (g) => {
    g.oval(2, 2, 28, 44, "#3a2f6b"); g.oval(5, 5, 22, 38, "#45c2a8"); g.oval(8, 9, 16, 30, "#8ff0dc"); g.oval(11, 13, 10, 22, "#e8fff9");
    g.fine(() => { g.rect(4, 23, 24, 2, WHITE); for (const [x, y] of [[3, 8], [28, 14], [2, 36], [29, 40]]) sparkle(g, x, y, "#c8fff4"); });
  }],
  "banner.svg": [12, 18, (g) => {
    g.rect(1, 0, 2, 18, "#8a8f98");
    g.poly([[3, 1], [11, 1], [9, 5], [11, 9], [3, 9]], "#45c2a8");
    g.fine(() => g.path([[4, 5], [5, 6], [8, 3]], WHITE, 1));
  }],
  "mug.svg": [12, 12, (g) => {
    g.fine(() => {
      g.rect(1, 5, 7, 6, "#f3ead2"); g.rect(1, 5, 7, 1, "#6b3f22"); g.rect(1, 10, 7, 1, "#c8bea6");
      g.ring(6, 6, 5, 5, 1.2, "#f3ead2");
    });
    g.outline(OUT, { r: 1 });
    g.fine(() => { for (const [x, y] of [[3, 0], [2, 1], [3, 2], [6, 1], [5, 2]]) g.set(x, y, "#c8ccd6"); });
  }],
  "stink.svg": [16, 12, (g) => {
    g.fine(() => { for (const x0 of [2, 7, 12]) for (let y = 0; y < 12; y++) g.set(x0 + (Math.floor((y + x0) / 3) % 2), y, "#a3d65c"); });
  }],
  "ribbon.svg": [40, 10, (g) => {
    const gold = "#ffd447";
    g.fine(() => {
      g.poly([[0, 2], [6, 2], [6, 9], [0, 9], [2, 5.5]], dk(gold, 0.25)); g.poly([[40, 2], [34, 2], [34, 9], [40, 9], [38, 5.5]], dk(gold, 0.25));
      g.rect(4, 1, 32, 8, gold); g.rect(4, 7, 32, 1, dk(gold, 0.12));
      g.text(7, 2, "SHIPPED", "#5a3d00");
    });
    g.outline(OUT, { r: 1 });
  }],
  "tent.svg": [16, 14, (g) => {
    const c = "#c8a26a";
    g.fine(() => { g.poly([[1, 13], [8, 1], [15, 13]], c); g.poly([[6, 13], [8, 7], [10, 13]], "#3a2a1a"); g.line(8, 1, 8, 0, "#8a8f98", 1); });
    g.shade(c, dk(c, 0.2), 1, 0, 2);
    g.outline(OUT, { r: 1 });
  }],
  "lanyard.svg": [10, 12, (g) => {
    g.fine(() => { g.line(1, 0, 4, 5, "#45c2a8", 1.4); g.line(8, 0, 5, 5, "#45c2a8", 1.4); g.rect(2, 5, 6, 7, WHITE); g.rect(3, 6, 2, 2, "#a0a4ab"); g.rect(3, 9, 4, 1, "#a0a4ab"); });
    g.outline(OUT, { r: 1 });
  }],
};

/** FIXED stamp, 80 x 28: a grungy red stamp baked at -6 degrees (GPUI cannot rotate). */
function stampFixed() {
  const g = new Grid(72, 20, { snap: 1 });
  const red = "#e0393e";
  g.rect(0, 0, 72, 2, red); g.rect(0, 18, 72, 2, red); g.rect(0, 0, 2, 20, red); g.rect(70, 0, 2, 20, red);
  g.text(8, 3, "FIXED", red, { scale: 3 });
  const r = rnd(808);
  for (let i = 0; i < 70; i++) g.set(Math.floor(r() * 72), Math.floor(r() * 20), null);
  return svgDoc(80, 28, `<g transform="rotate(-6 40 14) translate(4 4)">\n${g.toPaths()}\n</g>`, "geometricPrecision");
}

/** Weapon masks, 16 x 16, held at the hero's right: handle bottom-left, pointing up-right. */
const WEAPON_ART = {
  intern(g) { g.line(2, 14, 13, 2, "#000", 2.2); g.line(8, 8, 12, 9, "#000", 1.6); g.oval(11, 7, 4, 3, "#000"); g.oval(12, 0, 4, 4, "#000"); },
  refactorer(g) {
    g.poly([[5, 9], [13, 1], [15, 1], [15, 3], [7, 11]], "#000");
    g.line(2, 8, 7, 13, "#000", 2); g.line(1, 14, 4, 11, "#000", 2.4); g.rect(0, 14, 2, 2, "#000");
    g.line(8, 7, 13, 2, null, 1);
  },
  hotfixer(g) {
    g.poly([[3, 10], [11, 2], [13, 2], [13, 4], [5, 12]], "#000"); g.line(1, 14, 3, 12, "#000", 2.4); g.line(2, 9, 5, 12, "#000", 1.6);
    g.poly([[9, 12], [15, 7], [15, 9], [11, 13]], "#000"); g.line(7, 14, 9, 12, "#000", 2.4);
  },
  shellmancer(g) {
    g.line(2, 15, 9, 8, "#000", 2.2);
    g.oval(8, 0, 8, 9, "#000"); g.rect(11, 2, 2, 5, null);   // the pipe "|" through the orb
  },
  forkbinder(g) {                                  // an open manpage: two pages, a spine, lines
    g.bitmap(0, 0, ["................", "###..........###", "######....######", "#######..#######", "#######..#######",
      "##....#..#....##", "#######..#######", "#######..#######", "##....#..#....##", "#######..#######",
      "#######..#######", "##....#..#....##", "#######..#######", "################", ".######..######.", "................"], K);
  },
  rubberducker(g) {
    g.line(2, 15, 6, 9, "#000", 2);
    g.oval(4, 4, 11, 7, "#000"); g.oval(8, 0, 6, 6, "#000"); g.rect(14, 2, 2, 2, "#000"); g.set(11, 2, null);
  },
};

/** Hat masks, 24 x 12 (tier shapes: beanie, headphones, cap, helm, crown). */
const HAT_ART = [
  (g) => {                                         // beanie: dome, ribbed cuff, pompom
    g.bitmap(0, 0, ["..........####..........", "..........####..........", "......############......", "....################....",
      "...##################...", "..####################..", "..####################..", "..####################..",
      ".######################.", ".######################.", ".######################.", ".######################."], K);
    for (let x = 3; x < 22; x += 3) g.rect(x, 9, 1, 2, null);
  },
  (g) => { g.ring(3, 0, 18, 22, 2.5, "#000"); g.rect(0, 8, 24, 4, null); g.rect(1, 6, 5, 6, "#000"); g.rect(18, 6, 5, 6, "#000"); g.rect(3, 8, 1, 3, null); g.rect(20, 8, 1, 3, null); },
  (g) => {                                         // cap: crown with a seam, brim to the right
    g.bitmap(0, 0, [".........##.............", "......########..........", "....############........", "...##############.......",
      "..################......", "..################......", "..################......", "..################......",
      "..######################", "..######################", "..################......", "........................"], K);
    g.rect(9, 2, 1, 6, null);
  },
  (g) => { g.oval(3, 0, 18, 22, "#000"); g.rect(0, 11, 24, 1, null); g.rect(3, 9, 18, 3, "#000"); g.rect(5, 6, 14, 2, null); g.rect(11, 0, 2, 4, null); g.rect(11, 0, 2, 3, "#000"); },
  (g) => { g.rect(3, 7, 18, 5, "#000"); g.poly([[3, 8], [3, 1], [8, 6]], "#000"); g.poly([[8, 7], [12, 0], [16, 7]], "#000"); g.poly([[21, 8], [21, 1], [16, 6]], "#000"); g.rect(6, 9, 2, 2, null); g.rect(11, 9, 2, 2, null); g.rect(16, 9, 2, 2, null); },
];

/** Class accessories, 16 x 16, full colour. */
const ACC_ART = {
  intern(g) { g.line(2, 0, 6, 8, "#45c2a8", 1.6); g.line(13, 0, 9, 8, "#45c2a8", 1.6); g.rect(4, 8, 8, 8, WHITE); g.rect(5, 9, 6, 1, "#c8ccd6"); g.outline(OUT, { r: 1 }); },
  refactorer(g) {
    const a = "#e0605a", b = "#f3ead2";
    g.rect(1, 2, 14, 5, a); g.rect(9, 6, 5, 9, a);
    g.map((c, x, y) => (c === a && y % 4 < 2 ? b : c));   // knit stripes
    g.fine(() => { for (const x of [9, 11, 13]) g.rect(x, 15, 1, 1, a); });
    g.outline(OUT, { r: 1 });
  },
  hotfixer(g) {
    g.fine(() => { g.poly([[11, 6], [16, 2], [16, 12]], al("#fff1b8", 0.55)); });
    g.rect(0, 6, 9, 3, "#3a3d4a"); g.oval(6, 4, 7, 7, "#d6dae2"); g.oval(8, 5, 4, 5, "#fff1b8"); g.outline(OUT, { r: 1 });
  },
  shellmancer(g) {
    g.poly([[1, 15], [9, 3], [14, 1], [12, 6], [8, 15]], "#3f9a74"); g.shade("#3f9a74", "#2c6e53", 1, 0, 2);
    g.rect(12, 0, 3, 2, WHITE);  // the blinking cursor at the tip
    g.outline(OUT, { r: 1 });
  },
  forkbinder(g) {
    g.poly([[1, 8], [7, 6], [8, 7], [8, 13], [1, 14]], "#f3ead2"); g.poly([[8, 7], [9, 6], [15, 8], [15, 14], [8, 13]], "#e8dcc0");
    g.fine(() => { for (const y of [9, 11]) { g.rect(2, y, 4, 1, "#a49c88"); g.rect(10, y, 4, 1, "#a49c88"); } });
    g.outline(OUT, { r: 1 });
    g.fine(() => { g.rect(2, 2, 2, 2, "#c9a2ff"); g.rect(12, 1, 2, 2, "#c9a2ff"); g.rect(7, 0, 2, 2, "#9ee6ff"); });
  },
  rubberducker(g) {
    const ochre = "#c08a3e";
    g.poly([[0, 4], [7, 9], [8, 16], [0, 16]], ochre); g.poly([[16, 4], [9, 9], [8, 16], [16, 16]], ochre);
    g.shade(ochre, dk(ochre, 0.2), 0, 1, 2); g.rect(7, 10, 2, 6, dk(ochre, 0.35));
    g.fine(() => { g.rect(10, 11, 2, 2, "#f3ead2"); g.rect(10, 14, 2, 2, "#f3ead2"); });
    g.outline(OUT, { r: 1 });
  },
};

/** UI icon masks, 16 x 16. */
const K = "#000";
const UI_ART = {
  "slot-weapon": (g) => { g.line(4, 11, 13, 2, K, 2.6); g.line(2, 8, 7, 13, K, 2); g.line(1, 14, 3, 12, K, 2.4); },
  "slot-hat": (g) => {
    g.bitmap(0, 1, [".......##.......", ".......##.......", "....########....", "...##########...", "..############..",
      "..############..", "..############..", ".##############.", ".##############.", ".##############.", ".##############."], K);
    for (const x of [3, 6, 9, 12]) g.rect(x, 9, 1, 2, null);
  },
  "slot-hoodie": (g) => {
    g.bitmap(0, 1, [".....######.....", "....##....##....", "...##.####.##...", ".######..######.", "################", "####.######.####",
      "####.######.####", "###..######..###", "###..##..##..###", "###..#....#..###", "###..######..###", "....########....", "....########...."], K);
  },
  "slot-mug": (g) => { g.rect(2, 5, 9, 10, K); g.ring(8, 6, 7, 7, 2, K); g.rect(4, 7, 5, 6, null); g.rect(4, 7, 5, 6, K); g.rect(4, 0, 1, 3, K); g.rect(7, 1, 1, 3, K); g.rect(3, 6, 7, 1, null); },
  "slot-boots": (g) => { g.rect(3, 1, 7, 9, K); g.rect(3, 9, 12, 5, K); g.rect(12, 10, 3, 1, null); g.rect(2, 14, 14, 2, K); g.rect(5, 3, 3, 1, null); g.rect(5, 6, 3, 1, null); },
  "slot-sticker": (g) => { g.poly([[1, 3], [3, 1], [15, 1], [15, 10], [10, 15], [3, 15], [1, 13]], K); g.poly([[10, 15], [10, 10], [15, 10]], null); g.poly([[11, 14], [11, 11], [14, 11]], K); g.oval(4, 4, 5, 5, null); },
  "split-right": (g) => { g.rect(1, 2, 14, 12, K); g.rect(3, 4, 4, 8, null); g.rect(9, 4, 4, 8, null); },
  "split-down": (g) => { g.rect(1, 2, 14, 12, K); g.rect(3, 4, 10, 3, null); g.rect(3, 9, 10, 3, null); },
  zoom: (g) => { for (const [x, y, dx, dy] of [[1, 1, 1, 1], [14, 1, -1, 1], [1, 14, 1, -1], [14, 14, -1, -1]]) { g.rect(Math.min(x, x + dx * 4), y, 5, 1, K); g.rect(x, Math.min(y, y + dy * 4), 1, 5, K); g.line(x, y, x + dx * 4, y + dy * 4, K, 1.6); } },
  unzoom: (g) => { for (const [x, y, dx, dy] of [[6, 6, -1, -1], [9, 6, 1, -1], [6, 9, -1, 1], [9, 9, 1, 1]]) { g.rect(Math.min(x, x + dx * 4), y, 5, 1, K); g.rect(x, Math.min(y, y + dy * 4), 1, 5, K); g.line(x, y, x + dx * 5, y + dy * 5, K, 1.6); } },
  close: (g) => { g.line(3, 3, 12, 12, K, 2.6); g.line(12, 3, 3, 12, K, 2.6); },
  sheet: (g) => { g.rect(1, 2, 14, 12, K); g.rect(3, 4, 10, 8, null); g.oval(4, 5, 4, 4, K); g.rect(4, 9, 4, 2, K); g.rect(9, 5, 3, 1, K); g.rect(9, 8, 3, 1, K); g.rect(9, 10, 3, 1, K); },
  herd: (g) => { g.oval(5, 1, 6, 6, K); g.rect(4, 8, 8, 7, K); g.oval(0, 4, 4, 4, K); g.rect(0, 9, 4, 6, K); g.oval(12, 4, 4, 4, K); g.rect(12, 9, 4, 6, K); },
  calm: (g) => { g.oval(2, 1, 13, 14, K); g.oval(6, 0, 11, 11, null); g.set(13, 12, K); },
  gold: (g) => {                                   // a little stack of coins
    g.bitmap(0, 1, ["....########....", "..############..", ".###........###.", "..############..", "....########....", "................",
      ".##############.", "................", "..##############", "................", ".##############.", "................", "..##############", "..##############"], K);
  },
  snippet: (g) => { g.path([[5, 3], [1, 8], [5, 13]], K, 2); g.path([[11, 3], [15, 8], [11, 13]], K, 2); g.line(9, 2, 7, 14, K, 1.8); },
  chest: (g) => { g.rect(1, 3, 14, 11, K); g.rect(2, 2, 12, 1, K); g.rect(1, 7, 14, 1, null); g.rect(6, 6, 4, 4, null); g.rect(7, 7, 2, 2, K); g.rect(4, 3, 1, 4, null); g.rect(11, 3, 1, 4, null); },
  boss: (g) => { g.oval(2, 3, 12, 12, K); g.poly([[2, 7], [0, 0], [6, 4]], K); g.poly([[14, 7], [16, 0], [10, 4]], K); g.rect(4, 7, 3, 3, null); g.rect(9, 7, 3, 3, null); g.rect(6, 12, 1, 2, null); g.rect(9, 12, 1, 2, null); },
  star: (g) => { const pts = []; for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? 3.2 : 7.6; pts.push([8 + Math.cos(a) * r, 8.4 + Math.sin(a) * r]); } g.poly(pts, K); },
  fork: (g) => { g.oval(1, 0, 5, 5, K); g.oval(10, 0, 5, 5, K); g.oval(5, 11, 5, 5, K); g.line(3, 4, 3, 7, K, 2); g.line(12, 4, 12, 7, K, 2); g.path([[3, 7], [7, 10]], K, 2); g.path([[12, 7], [8, 10]], K, 2); g.rect(6, 9, 3, 3, K); },
  gear: (g) => { for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4; g.rect(Math.round(7 + Math.cos(a) * 6), Math.round(7 + Math.sin(a) * 6), 2, 2, K); } g.oval(2, 2, 12, 12, K); g.oval(5.5, 5.5, 5, 5, null); for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4; g.line(8 + Math.cos(a) * 5, 8 + Math.sin(a) * 5, 8 + Math.cos(a) * 7, 8 + Math.sin(a) * 7, K, 2.2); } },
  skills: (g) => { g.poly([[9, 0], [2, 9], [7, 9], [5, 16], [14, 6], [9, 6], [11, 0]], K); },
  stats: (g) => { g.rect(1, 9, 3, 6, K); g.rect(6, 5, 3, 10, K); g.rect(11, 1, 3, 14, K); g.rect(0, 15, 16, 1, K); },
  career: (g) => { g.rect(2, 0, 2, 16, K); g.rect(12, 0, 2, 16, K); for (const y of [2, 6, 10, 14]) g.rect(4, y, 8, 2, K); },
  journal: (g) => { g.rect(2, 1, 12, 14, K); g.rect(4, 3, 8, 3, null); g.rect(5, 4, 6, 1, K); g.rect(10, 0, 2, 8, null); g.rect(10, 0, 2, 7, K); g.rect(10, 6, 1, 1, null); g.rect(2, 13, 1, 2, null); g.rect(4, 13, 10, 1, null); },
  lock: (g) => { g.ring(3, 0, 10, 12, 2, K); g.rect(1, 6, 14, 10, K); g.rect(7, 9, 2, 4, null); g.rect(6, 9, 4, 2, null); },
};

function fxAssets(out) {
  for (const t of CHEST_TIERS) {
    out.set(`art/fx/chest-${t.id}.svg`, chest(t.id, false).toSVG());
    out.set(`art/fx/chest-${t.id}-open.svg`, chest(t.id, true).toSVG());
  }
  out.set("art/fx/chest-duck.svg", duckChest(false).toSVG());
  out.set("art/fx/chest-duck-open.svg", duckChest(true).toSVG());
  for (const [name, [w, h, draw]] of Object.entries(FX_ART)) { const g = new Grid(w, h); draw(g); out.set(`art/fx/${name}`, g.toSVG()); }
  const loot = new Grid(10, 10, { snap: 1 });
  // an isometric cube: top face, then two side faces split by transparent seams
  loot.bitmap(0, 0, ["....##....", "..######..", "##########", "..######..", "#...##...#", "###....###", "####..####", "####..####", ".###..###.", "...#..#..."], K);
  out.set("art/fx/loot.svg", loot.toSVG({ mask: true }));
  const star = new Grid(20, 20, { snap: 1 });
  star.poly([[10, 0], [12.4, 7.6], [20, 10], [12.4, 12.4], [10, 20], [7.6, 12.4], [0, 10], [7.6, 7.6]], K);
  out.set("art/fx/starburst.svg", star.toSVG({ mask: true }));
  out.set("art/fx/stamp-fixed.svg", stampFixed());
}

function gearAssets(out) {
  for (const c of CLASSES) {
    const g = new Grid(16, 16, { snap: 1 });
    WEAPON_ART[c.id](g);
    out.set(`art/gear/weapon-${c.id}.svg`, g.toSVG({ mask: true }));
    // edge mask for the tier-5 tone's cyan edge (D§11.1): weapon pixels open to the top or right
    const e = new Grid(16, 16, { snap: 1 });
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (g.get(x, y) && (!g.get(x, y - 1) || !g.get(x + 1, y))) e.set(x, y, K);
    out.set(`art/gear/weapon-${c.id}-edge.svg`, e.toSVG({ mask: true }));
    const a = new Grid(16, 16, { snap: 1 });
    ACC_ART[c.id](a);
    out.set(`art/gear/acc-${c.id}.svg`, a.toSVG());
  }
  HAT_ART.forEach((draw, i) => { const g = new Grid(24, 12, { snap: 1 }); draw(g); out.set(`art/gear/hat-${i + 1}.svg`, g.toSVG({ mask: true })); });
  for (const [name, draw] of Object.entries(UI_ART)) { const g = new Grid(16, 16, { snap: 1 }); draw(g); out.set(`art/ui/${name}.svg`, g.toSVG({ mask: true })); }
}

// =============================================================================================
// preview.svg (320 x 200): the mapledr layout as herdr's Settings shows it (like win98.svg)
// =============================================================================================

/** A tiny Termling (10 x 12) for the preview: hoodie body, title bar, screen with ">_". */
function miniTermling(g, x, y, hoodie, { face = "work", hat = null } = {}) {
  const t = new Grid(12, 15, { snap: 1 });
  t.rect(1, 3, 10, 9, hoodie); t.set(1, 3, null); t.set(10, 3, null);
  t.rect(2, 4, 8, 2, dk(hoodie, 0.35)); t.set(3, 4, "#ffffff"); t.set(5, 4, "#ffffff");
  t.rect(3, 6, 6, 4, "#16141f");
  const ink = "#9dff9d";
  if (face === "work") { t.set(4, 7, ink); t.set(5, 8, ink); t.set(4, 9, ink); t.rect(6, 9, 2, 1, ink); }
  else if (face === "blocked") { t.set(4, 7, "#f2a93b"); t.set(7, 7, "#f2a93b"); t.rect(5, 9, 2, 1, "#f2a93b"); }
  else { t.rect(4, 8, 1, 1, "#ffd447"); t.rect(7, 8, 1, 1, "#ffd447"); t.set(5, 9, "#ffd447"); t.set(6, 9, "#ffd447"); }
  t.rect(3, 12, 2, 2, dk(hoodie, 0.4)); t.rect(7, 12, 2, 2, dk(hoodie, 0.4));
  if (hat) { t.rect(3, 1, 6, 2, hat); t.rect(2, 2, 8, 1, hat); }
  t.outline(OUT, { r: 1 });
  g.stamp(t, x - 1, y - 1);
}

function preview() {
  const g = new Grid(320, 200, { snap: 1 });
  const canvas = "#131518", chrome = "#0f1114", line = "#2a2d33", text = "#d2d4d9", dim = "#5c6068", focus = "#7fa7ff";
  const hp = "#ff5a5f", xp = "#7fe9f5";
  g.rect(0, 0, 320, 200, canvas);
  // --- sidebar: brand, spaces, the party (role "party"), footer
  g.rect(0, 0, 70, 200, chrome); g.rect(70, 0, 1, 200, line);
  miniTermling(g, 4, 2, "#6c8cf5");
  g.rect(18, 6, 26, 3, text); g.rect(60, 6, 5, 3, dim);
  g.rect(4, 19, 62, 9, "#22252b");
  [["#96b2d7", 26, 20], ["#a6bd91", 20, 31], ["#d8be87", 24, 41]].forEach(([c, w, y]) => { g.rect(8, y + 1, 4, 4, c); g.rect(15, y + 2, w, 2, y === 20 ? text : "#818793"); });
  g.rect(5, 52, 20, 2, text); g.rect(28, 52, 12, 2, dim); g.rect(60, 51, 6, 4, dim);
  const rows = [["#4cc38a", "#6c8cf5", "work", 0.8, 0.55], ["#f2a93b", "#f07d5c", "blocked", 0.6, 0.3], ["#ffd447", "#45c2a8", "done", 1, 0.85], ["#4cc38a", "#c47be8", "work", 0.4, 0.7], ["#8a8f98", "#e8b84a", "idle", 0.9, 0.2]];
  rows.forEach(([stripe, hoodie, face, h, x], i) => {
    const y = 60 + i * 23;
    g.rect(3, y, 64, 20, i === 0 ? "#1f2228" : "#181a1f");
    g.rect(3, y, 2, 20, stripe);
    g.rect(7, y + 3, 14, 14, "#2a2d36");
    miniTermling(g, 9, y + 4, hoodie, { face });
    g.rect(24, y + 4, 24 - (i % 3) * 4, 2, text); g.rect(56, y + 3, 9, 4, "#2a2d36"); g.rect(57, y + 4, 7, 2, "#a0a4ab");
    g.rect(24, y + 9, 20, 1, dim);
    g.rect(24, y + 13, 18, 2, "#3a1f22"); g.rect(24, y + 13, Math.round(18 * h), 2, hp);
    g.rect(44, y + 13, 20, 2, "#173438"); g.rect(44, y + 13, Math.round(20 * x), 2, xp);
    if (face === "blocked") { g.rect(58, y + 10, 7, 6, WHITE); g.rect(61, y + 11, 1, 3, "#1b1b1f"); g.set(61, y + 15 - 0, "#1b1b1f"); }
    if (face === "done") { g.rect(58, y + 11, 7, 5, "#ffd447"); g.rect(58, y + 13, 7, 1, "#8a5a10"); }
  });
  g.rect(0, 186, 70, 14, "#0c0d10"); g.rect(5, 191, 4, 4, "#c89b3c"); g.rect(11, 192, 14, 2, "#818793"); g.rect(30, 192, 10, 2, "#818793"); g.rect(52, 190, 13, 6, "#22252b");
  // --- tab bar
  g.rect(71, 0, 249, 12, chrome);
  [[75, 34, true], [112, 28, false], [143, 30, false]].forEach(([x, w, on]) => { g.rect(x, 2, w, 9, on ? "#2a2d36" : "#181a1f"); g.rect(x + 4, 5, w - 12, 2, on ? text : dim); });
  g.rect(300, 4, 4, 4, dim); g.rect(308, 4, 4, 4, dim);
  // --- two terminal panes with nameplate headers (role "nameplate")
  const pane = (x, w, focused, hoodie, lines) => {
    g.rect(x, 15, w, 124, focused ? focus : line); g.rect(x + 1, 16, w - 2, 122, "#0b0c0e");
    g.set(x, 15, canvas); g.set(x + w - 1, 15, canvas); g.set(x, 138, canvas); g.set(x + w - 1, 138, canvas);
    g.rect(x + 1, 16, w - 2, 11, "#16181d"); g.rect(x + 1, 27, w - 2, 1, line);
    g.rect(x + 4, 19, 5, 5, hoodie); g.rect(x + 11, 20, 26, 2, text); g.rect(x + 40, 20, 14, 2, dim);
    g.rect(x + w - 44, 20, 12, 2, "#3a1f22"); g.rect(x + w - 44, 20, 9, 2, hp);
    g.rect(x + w - 30, 20, 14, 2, "#173438"); g.rect(x + w - 30, 20, 8, 2, xp);
    g.rect(x + w - 13, 18, 10, 6, focused ? "#2a2d36" : "#3a2a12"); g.rect(x + w - 11, 20, 6, 2, focused ? "#a0a4ab" : "#f2a93b");
    lines.forEach(([dx, ww, c], i) => g.rect(x + 5 + dx, 33 + i * 7, ww, 2, c));
  };
  pane(74, 122, true, "#6c8cf5", [[0, 4, "#4cc38a"], [6, 40, "#c8ccd6"], [0, 60, "#818793"], [0, 72, "#818793"], [0, 34, "#818793"], [6, 52, "#7fa7ff"], [0, 4, "#4cc38a"], [6, 22, "#c8ccd6"], [0, 66, "#818793"], [0, 48, "#818793"], [0, 4, "#4cc38a"], [6, 1, "#d2d4d9"]]);
  pane(199, 118, false, "#f07d5c", [[0, 4, "#4cc38a"], [6, 30, "#c8ccd6"], [0, 70, "#818793"], [0, 58, "#818793"], [0, 76, "#e0a06a"], [0, 40, "#818793"], [0, 62, "#818793"], [0, 52, "#f2a93b"], [0, 24, "#f2a93b"]]);
  // --- the stage strip (role "stage"): two rooms, heroes, mobs, a chest and a blocked bubble
  const top = 142, ground = 178, bottom = 188;
  const rooms = [[71, 210, ZONES[0].palette], [211, 320, ZONES[1].palette]];
  for (const [x0, x1, p] of rooms) {
    for (let i = 0; i < 4; i++) g.rect(x0, top + i * 9, x1 - x0, 9, mix(p.sky, p.far, i * 0.12));
    for (let x = x0; x < x1; x++) {
      const yb = Math.round(top + 22 + wave(x, 160, [[3, 3, 0.4], [2, 7, 1.0]]));
      g.rect(x, yb, 1, ground - yb, mix(p.far, p.sky, 0.45));
    }
    g.rect(x0, ground, x1 - x0, bottom - ground, p.ground); g.rect(x0, ground, x1 - x0, 1, p.accent);
    g.rect(x0, top, x1 - x0, 5, mix(p.sky, "#000000", 0.3)); g.rect(x0 + 3, top + 1, 22, 2, "#e8e8e8"); g.rect(x0 + 28, top + 1, 16, 2, mix(p.sky, "#ffffff", 0.5));
    g.rect(x0 + 48, top + 2, 14, 1, "#3a3d44"); g.rect(x0 + 48, top + 2, 9, 1, "#ffd447");
  }
  for (let x = 211; x < 320; x += 14) g.rect(x + 4, top + 5, 2, 6 + (x % 3) * 2, ZONES[1].palette.far);
  g.rect(210, top, 1, bottom - top, "#1b1726");
  const half = (id, size, x) => { const m = mobGrid(id, size); g.stamp(m, x, ground - m.h / 2, { scale: 0.5 }); };
  miniTermling(g, 90, ground - 13, "#6c8cf5", { hat: "#e86f9c" });
  half("typo_sprout", "S", 128); half("semicolon_snail", "S", 152); half("unused_import", "M", 178);
  const ch = chest("gold", false); g.stamp(ch, 104, ground - 11, { scale: 0.5 });
  miniTermling(g, 226, ground - 13, "#f07d5c", { face: "blocked" });
  const b = new Grid(18, 20); FX_ART["bubble.svg"][2](b); g.stamp(b, 227, ground - 25, { scale: 0.5 });
  half("callback_bat", "S", 256); half("null_pointer_frog", "M", 280);
  // nameplate pills on the ground band
  for (const [x, w] of [[86, 18], [222, 18]]) { g.rect(x, ground + 3, w, 5, "#000000"); g.rect(x + 2, ground + 4, w - 7, 2, "#e8e8e8"); g.rect(x + 2, ground + 6, w - 4, 1, hp); }
  // --- status bar
  g.rect(71, 189, 249, 11, chrome); g.rect(71, 189, 249, 1, line);
  g.rect(76, 193, 4, 4, "#4cc38a"); g.rect(83, 194, 22, 2, "#818793"); g.rect(112, 193, 4, 4, "#f2a93b"); g.rect(119, 194, 14, 2, "#818793");
  g.rect(280, 194, 34, 2, "#818793");
  return g.toSVG();
}

// =============================================================================================
// Asset table
// =============================================================================================

function mobGrid(id, size) {
  const px = SIZE_PX[size];
  const draw = MOB_ART[id];
  if (!draw) throw new Error(`gen-art: no art for mob ${id}`);
  const g = new Grid(px, px);
  draw(g);
  return g;
}
const mobSvg = (id, size) => mobGrid(id, size).toSVG();

/** Every lane entity with art: the 27 zone mobs, adds, and the Holo Rubber Duck. */
export function mobList() {
  const list = MOBS.map((m) => ({ id: m.id, size: m.size }));
  for (const a of ADDS) list.push({ id: a.id, size: a.size });
  list.push({ id: "holo_duck", size: "S" });
  return list;
}

/** Masks: one-colour SVGs drawn with svg() and tinted by text colour (ARCHITECTURE §8). */
export function isMaskPath(rel) {
  return /^art\/gear\/(weapon|hat)-/.test(rel) || rel.startsWith("art/ui/") ||
    rel === "art/fx/loot.svg" || rel === "art/fx/starburst.svg";
}

// Intrinsic size of full-colour art (ARCHITECTURE §8). herdr's image() hands an SVG to GPUI's
// image loader, which rasterises it ONCE at twice its width/height attributes
// (gpui-pre elements/img.rs:773-775 `render_single_frame(&bytes, 1.0)` → svg_renderer.rs:200-207
// ScaleFactor(1 × SMOOTH_SVG_SCALE_FACTOR 2)) and then samples that bitmap into the element's
// bounds with a linear filter and a single mip level (gpui-pre-wgpu wgpu_renderer.rs:1416-1420,
// wgpu_atlas.rs:215; gpui-pre-apple shaders.metal:716-717). A sprite drawn larger than its
// width/height is therefore upscaled and its crisp pixel edges go soft. So art that is drawn
// bigger than its viewBox carries width/height = k × viewBox: the viewBox (and so every coordinate
// and the layout size at zoom 1) is unchanged, only the raster gets k times denser. k is the
// largest draw / viewBox ratio, rounded up:
//   mob/*         elite ELITE.scale 1.25 × a full grower (1 + TRAITS.grower.cap 0.6) = 2.0 → 2
//   gear/acc-*    the sheet portrait draws them at 25.2 of 16 = 1.58                   → 2
//   fx/campfire   the Herd panel building icon, 26 of 24                               → 2
//   fx/mug        the Herd panel building icon, 26 of 12 = 2.17                        → 3
//   fx/stamp-fixed  the FIXED stamp starts at 160×56 (2 × 80×28, ui/stage.js) and shrinks
//                 to its size over 300 ms while it fades in over 150 ms                → 2
// Transitions count: a size a width/height transition passes through while visible is a draw.
// Everything else is drawn at or below its viewBox and stays at k = 1: a denser raster would only
// be minified more, and one mip level aliases large downscales (bosses in the Herd panel are
// drawn at 64 of 112). Masks go through svg(), which rasterises at the painted size, so they are
// always k = 1. test/art.test.mjs checks k against every image() draw in the check role matrix
// (the stamp's slam is not in it, so its k is pinned there by hand).
const INTRINSIC_SCALE = [
  [/^art\/fx\/mug\.svg$/, 3],
  [/^art\/mob\//, 2],
  [/^art\/gear\/acc-/, 2],
  [/^art\/fx\/campfire\.svg$/, 2],
  [/^art\/fx\/stamp-fixed\.svg$/, 2],
];

/** The intrinsic-size multiplier k of a generated file (width/height = k × viewBox). */
export function intrinsicScale(rel) {
  if (isMaskPath(rel)) return 1;
  for (const [re, k] of INTRINSIC_SCALE) if (re.test(rel)) return k;
  return 1;
}

/** Rewrite the root's width/height to k × its viewBox (svgDoc always writes them in that order). */
function withIntrinsicScale(rel, text) {
  const k = intrinsicScale(rel);
  if (k === 1) return text;
  const re = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/;
  const m = re.exec(text);
  if (!m || m[1] !== m[3] || m[2] !== m[4]) throw new Error(`gen-art: ${rel}: unexpected root tag for an intrinsic scale`);
  return text.replace(re, (_, w, h, vw, vh) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w * k}" height="${h * k}" viewBox="0 0 ${vw} ${vh}"`);
}

/** Map<relativePath (from mods/mapledr), svgText>. */
export function generateAll() {
  const out = generateAt1x();
  for (const [rel, text] of out) out.set(rel, withIntrinsicScale(rel, text));
  return out;
}

/** Every file at width/height = viewBox (before the intrinsic scale). */
function generateAt1x() {
  const out = new Map();
  for (const { id, size } of mobList()) out.set(`art/mob/${id}.svg`, mobSvg(id, size));
  for (const b of BOSSES) {
    const g = new Grid(112, 96);
    BOSS_ART[b.id](g);
    out.set(`art/boss/${b.id}.svg`, g.toSVG());
  }
  for (const [id, draw] of Object.entries(BOSS_PARTS_ART)) {
    const g = new Grid(32, 32);
    draw(g);
    out.set(`art/boss/${id}-part.svg`, g.toSVG());
  }
  out.set("art/boss/senior_reviewer.svg", seniorReviewer().toSVG());
  bgAssets(out);
  fxAssets(out);
  gearAssets(out);
  out.set("preview.svg", preview());
  return out;
}

export function writeAll(outDir = path.join(ROOT, "mods/mapledr")) {
  const files = generateAll();
  // Clear stale generated files so renamed assets don't linger.
  const artDir = path.join(outDir, "art");
  if (fs.existsSync(artDir)) fs.rmSync(artDir, { recursive: true, force: true });
  for (const [rel, text] of files) {
    const p = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return files;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const i = process.argv.indexOf("--out");
  const dir = i > 0 ? path.resolve(process.argv[i + 1]) : undefined;
  const files = writeAll(dir);
  let bytes = 0;
  for (const t of files.values()) bytes += Buffer.byteLength(t);
  console.log(`gen-art: wrote ${files.size} files (${(bytes / 1024).toFixed(1)} KB) to ${dir ?? "mods/mapledr"}`);
}
