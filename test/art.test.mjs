// Art contract tests (ARCHITECTURE §8): every asset exists for every content id, is well-formed
// SVG without <text>, has viewBox = display size, masks are single-colour, tiles are seamless,
// sprites stand on their bottom edge, and the files on disk are exactly what tools/gen-art.mjs
// produces (art is generated, never hand-edited).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZONES, MOBS, ADDS, BOSSES, CLASSES, CHEST_TIERS, BACKLOG } from "../mods/mapledr/game/data.js";
import { generateAll, isMaskPath } from "../tools/gen-art.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = path.join(ROOT, "mods/mapledr");
const read = (rel) => fs.readFileSync(path.join(MOD, rel), "utf8");

// ---------------------------------------------------------------------------------------------
// The size table (ARCHITECTURE §8), built from the content ids in data.js
// ---------------------------------------------------------------------------------------------

const MOB_PX = { S: 28, M: 40, L: 56 };
const UI_ICONS = ["split-right", "split-down", "zoom", "unzoom", "close", "sheet", "herd", "calm", "gold", "snippet",
  "chest", "boss", "star", "fork", "gear", "skills", "stats", "career", "journal", "lock"];
const SLOTS = ["weapon", "hat", "hoodie", "mug", "boots", "sticker"];
const FX = { "campfire": [24, 24], "bubble": [18, 20], "crate": [24, 16], "coin": [6, 6], "loot": [10, 10], "poof": [24, 24],
  "starburst": [20, 20], "door": [24, 40], "portal": [32, 48], "banner": [12, 18], "stamp-fixed": [80, 28], "mug": [12, 12],
  "stink": [16, 12], "ribbon": [40, 10], "tent": [16, 14], "lanyard": [10, 12] };

/** Map<relPath, [w, h] | {max: [w, h]}> of every required asset. */
function expected() {
  const m = new Map();
  for (const mob of MOBS) m.set(`art/mob/${mob.id}.svg`, [MOB_PX[mob.size], MOB_PX[mob.size]]);
  for (const a of ADDS) m.set(`art/mob/${a.id}.svg`, [MOB_PX[a.size], MOB_PX[a.size]]);
  m.set("art/mob/holo_duck.svg", [28, 28]);
  for (const b of BOSSES) m.set(`art/boss/${b.id}.svg`, [112, 96]);
  for (const id of ["octopus_merge", "deadlock_hydra", "monolith"]) m.set(`art/boss/${id}-part.svg`, [32, 32]);
  m.set("art/boss/senior_reviewer.svg", [48, 56]);
  for (const z of [...ZONES, BACKLOG]) {
    m.set(`art/bg/${z.id}-far.svg`, [160, 100]);
    m.set(`art/bg/${z.id}-ground.svg`, [32, 40]);
    for (const k of [1, 2, 3]) m.set(`art/bg/${z.id}-prop-${k}.svg`, { max: [48, 64] });
  }
  for (const t of CHEST_TIERS) { m.set(`art/fx/chest-${t.id}.svg`, [28, 22]); m.set(`art/fx/chest-${t.id}-open.svg`, [28, 22]); }
  for (const [name, wh] of Object.entries(FX)) m.set(`art/fx/${name}.svg`, wh);
  for (const c of CLASSES) { m.set(`art/gear/weapon-${c.id}.svg`, [16, 16]); m.set(`art/gear/acc-${c.id}.svg`, [16, 16]); }
  for (const k of [1, 2, 3, 4, 5]) m.set(`art/gear/hat-${k}.svg`, [24, 12]);
  for (const s of SLOTS) m.set(`art/ui/slot-${s}.svg`, [16, 16]);
  for (const n of UI_ICONS) m.set(`art/ui/${n}.svg`, [16, 16]);
  m.set("preview.svg", [320, 200]);
  return m;
}

// ---------------------------------------------------------------------------------------------
// A tiny XML well-formedness checker (no deps): tags balance, attributes are quoted and unique,
// text holds no stray "<" or bare "&".
// ---------------------------------------------------------------------------------------------

function checkXml(src) {
  const stack = [];
  let i = 0, root = null;
  const ENT = /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const textEnd = lt < 0 ? src.length : lt;
    const text = src.slice(i, textEnd);
    for (let k = text.indexOf("&"); k >= 0; k = text.indexOf("&", k + 1)) if (!ENT.test(text.slice(k))) return `bare & in text`;
    if (lt < 0) break;
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt); if (e < 0) return "unclosed comment"; i = e + 3; continue; }
    if (src.startsWith("<?", lt)) { const e = src.indexOf("?>", lt); if (e < 0) return "unclosed PI"; i = e + 2; continue; }
    const gt = src.indexOf(">", lt);
    if (gt < 0) return "unclosed tag";
    const body = src.slice(lt + 1, gt);
    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      if (stack.pop() !== name) return `mismatched </${name}>`;
    } else {
      const self = body.endsWith("/");
      const m = /^([A-Za-z_][\w:.-]*)([\s\S]*?)\/?$/.exec(body);
      if (!m) return `bad tag <${body.slice(0, 20)}>`;
      const [, name, attrs] = m;
      const seen = new Set();
      const rest = attrs.replace(/\s+([A-Za-z_][\w:.-]*)\s*=\s*("[^"<]*"|'[^'<]*')/g, (_, a) => {
        if (seen.has(a)) throw new Error(`duplicate attribute ${a}`);
        seen.add(a);
        return "";
      });
      if (rest.trim() !== "") return `bad attributes in <${name}>: ${rest.trim().slice(0, 30)}`;
      if (!root) root = name; else if (stack.length === 0) return "more than one root element";
      if (!self) stack.push(name);
    }
    i = gt + 1;
  }
  if (stack.length) return `unclosed <${stack.pop()}>`;
  return root === "svg" ? null : `root is <${root}>`;
}

// ---------------------------------------------------------------------------------------------
// Rasterizer for the generator's output format: <path fill=.. [fill-opacity=..] d="M x y h w v h h -w z ...">
// ---------------------------------------------------------------------------------------------

function raster(src, w, h) {
  const px = new Array(w * h).fill(null);
  for (const m of src.matchAll(/<path fill="(#[0-9a-f]{6})"(?: fill-opacity="([\d.]+)")? d="([^"]+)"\/>/g)) {
    const color = m[1] + (m[2] ? `@${m[2]}` : "");
    for (const r of m[3].matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-\d+z/g)) {
      const [x, y, rw, rh] = r.slice(1).map(Number);
      for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) px[yy * w + xx] = color;
    }
  }
  return px;
}

const sizeOf = (src) => {
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(src);
  return vb ? [Number(vb[1]), Number(vb[2])] : null;
};

// ---------------------------------------------------------------------------------------------

const EXP = expected();

test("every asset in the art contract exists for every content id", () => {
  const missing = [...EXP.keys()].filter((rel) => !fs.existsSync(path.join(MOD, rel)));
  assert.deepEqual(missing, []);
  assert.ok(MOBS.length === 27 && BOSSES.length === 9, "content tables changed shape");
  assert.deepEqual(CHEST_TIERS.map((t) => t.id), ["wooden", "iron", "silver", "gold"]);
});

test("each SVG is well-formed, text-free, self-contained, and sized by its viewBox", () => {
  for (const [rel, want] of EXP) {
    const src = read(rel);
    assert.equal(checkXml(src), null, `${rel}: not well-formed`);
    assert.ok(!/<text[\s>]/i.test(src), `${rel}: contains <text>`);
    assert.ok(!/<(script|image|foreignObject|style)[\s>]/i.test(src), `${rel}: embeds script/image/style`);
    assert.ok(!/href=/.test(src), `${rel}: references another resource`);
    assert.match(src, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /, `${rel}: root must be <svg xmlns=...>`);
    const vb = sizeOf(src);
    assert.ok(vb, `${rel}: viewBox must be "0 0 W H"`);
    const [w, h] = vb;
    assert.match(src, new RegExp(`<svg[^>]* width="${w}" height="${h}"`), `${rel}: width/height must equal the viewBox`);
    if (Array.isArray(want)) assert.deepEqual(vb, want, `${rel}: size`);
    else assert.ok(w <= want.max[0] && h <= want.max[1], `${rel}: ${w}x${h} exceeds ${want.max.join("x")}`);
    assert.ok(src.length < 64 * 1024, `${rel}: ${src.length} bytes is too big`);
  }
});

test("masks are a single fill colour on a transparent background", () => {
  const masks = [...EXP.keys()].filter(isMaskPath);
  assert.ok(masks.length >= 6 + 5 + 26 + 2, `found ${masks.length} masks`);
  for (const rel of masks) {
    const src = read(rel);
    const fills = new Set([...src.matchAll(/fill="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
    assert.equal(fills.size, 1, `${rel}: fills ${[...fills]}`);
    assert.ok(!/fill-opacity|opacity=|stroke=/.test(src), `${rel}: masks must be one flat colour`);
    const [w, h] = sizeOf(src);
    const px = raster(src, w, h);
    const filled = px.filter(Boolean).length;
    assert.ok(filled > 0 && filled < w * h, `${rel}: mask is empty or a solid block`);
  }
  // full-colour sprites use several colours (they are drawn with image(), not tinted)
  for (const rel of [...EXP.keys()].filter((r) => /^art\/(mob|boss)\//.test(r))) {
    const fills = new Set([...read(rel).matchAll(/fill="([^"]+)"/g)].map((m) => m[1]));
    assert.ok(fills.size >= 3, `${rel}: only ${fills.size} colours`);
  }
});

// A tile drawn from periodic functions on a wrapping grid has no step at the seam that it does not
// also have somewhere inside; a tile drawn without wrapping shows a seam step (column w-1 → 0)
// rougher than any interior step, and its silhouette jumps there.
test("far and ground tiles tile seamlessly (the wrap seam is no rougher than the tile itself)", () => {
  const tiles = [...EXP.keys()].filter((r) => /-(far|ground)\.svg$/.test(r));
  assert.equal(tiles.length, (ZONES.length + 1) * 2);
  for (const rel of tiles) {
    const src = read(rel);
    const [w, h] = sizeOf(src);
    const px = raster(src, w, h);
    const diff = (a, b) => { let n = 0; for (let y = 0; y < h; y++) if (px[y * w + a] !== px[y * w + b]) n++; return n; };
    const interior = [];
    for (let x = 0; x < w - 1; x++) interior.push(diff(x, x + 1));
    interior.sort((a, b) => a - b);
    const seam = diff(w - 1, 0), maxStep = interior[interior.length - 1];
    assert.ok(seam <= maxStep, `${rel}: seam differs in ${seam} rows (largest interior column step: ${maxStep})`);
    // silhouette continuity for far tiles: the top of the opaque area must not jump at the seam
    if (rel.endsWith("-far.svg")) {
      const top = (x) => { for (let y = 0; y < h; y++) if (px[y * w + x]) return y; return h; };
      let jump = 0;
      for (let x = 0; x < w - 1; x++) jump = Math.max(jump, Math.abs(top(x + 1) - top(x)));
      assert.ok(Math.abs(top(w - 1) - top(0)) <= jump, `${rel}: silhouette jumps at the seam`);
    }
    if (rel.endsWith("-ground.svg")) assert.equal(px.filter(Boolean).length, w * h, `${rel}: ground tiles must be opaque`);
  }
});

test("mobs and bosses are outlined and stand on their bottom edge", () => {
  for (const rel of [...EXP.keys()].filter((r) => /^art\/(mob|boss)\/[^/]+\.svg$/.test(r) && !r.endsWith("-part.svg"))) {
    const src = read(rel);
    assert.ok(src.includes('fill="#1b1726"'), `${rel}: missing the dark outline colour`);
    const [w, h] = sizeOf(src);
    const px = raster(src, w, h);
    let lowest = -1;
    for (let y = h - 1; y >= 0 && lowest < 0; y--) for (let x = 0; x < w; x++) if (px[y * w + x]) { lowest = y; break; }
    assert.ok(lowest >= h - 3, `${rel}: lowest pixel row ${lowest} of ${h} (feet must touch the bottom)`);
  }
});

test("the files on disk are exactly the generator's output (deterministic, nothing stale)", () => {
  const a = generateAll(), b = generateAll();
  assert.deepEqual([...a.keys()], [...b.keys()]);
  for (const [rel, text] of a) assert.equal(b.get(rel), text, `${rel}: generator is not deterministic`);
  for (const rel of EXP.keys()) assert.ok(a.has(rel), `generator does not produce ${rel}`);
  const stale = [];
  for (const [rel, text] of a) if (!fs.existsSync(path.join(MOD, rel)) || read(rel) !== text) stale.push(rel);
  assert.deepEqual(stale, [], "art is out of date: run `npm run art`");
  const onDisk = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else onDisk.push(path.relative(MOD, p).split(path.sep).join("/")); } };
  walk(path.join(MOD, "art"));
  assert.deepEqual(onDisk.filter((r) => !a.has(r)), [], "files under art/ that the generator does not produce");
});
