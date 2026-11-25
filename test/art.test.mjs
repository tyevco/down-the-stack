// Art contract tests (ARCHITECTURE §8): every asset exists for every content id, is well-formed
// SVG without <text>, has viewBox = display size, carries enough intrinsic pixels (width/height =
// k × viewBox) for the largest image() draw, masks are single-colour, tiles are seamless,
// sprites stand on their bottom edge, and the files on disk are exactly what tools/gen-art.mjs
// produces (art is generated, never hand-edited).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZONES, MOBS, ADDS, BOSSES, CLASSES, CHEST_TIERS, BACKLOG, ELITE, TRAITS } from "../mods/down-the-stack/game/data.js";
import { generateAll, isMaskPath, intrinsicScale } from "../tools/gen-art.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = path.join(ROOT, "mods/down-the-stack");
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
  "stink": [16, 12], "ribbon": [40, 10], "tent": [16, 14] };

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
/** The root's width/height attributes: the size GPUI's image() rasterises at (×2). */
const intrinsicOf = (src) => {
  const m = /^<svg[^>]* width="(\d+)" height="(\d+)"/.exec(src);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

// ---------------------------------------------------------------------------------------------

const EXP = expected();

test("every asset in the art contract exists for every content id", () => {
  const missing = [...EXP.keys()].filter((rel) => !fs.existsSync(path.join(MOD, rel)));
  assert.deepEqual(missing, []);
  assert.ok(MOBS.length === 27 && BOSSES.length === 9, "content tables changed shape");
  assert.deepEqual(CHEST_TIERS.map((t) => t.id), ["wooden", "iron", "silver", "gold"]);
});

test("each SVG is well-formed, text-free, self-contained, and sized by its viewBox (width/height = k × viewBox)", () => {
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
    const k = intrinsicScale(rel);
    assert.ok(Number.isInteger(k) && k >= 1, `${rel}: intrinsic scale ${k}`);
    assert.deepEqual(intrinsicOf(src), [k * w, k * h], `${rel}: width/height must be ${k} × the viewBox`);
    if (Array.isArray(want)) assert.deepEqual(vb, want, `${rel}: size`);
    else assert.ok(w <= want.max[0] && h <= want.max[1], `${rel}: ${w}x${h} exceeds ${want.max.join("x")}`);
    assert.ok(src.length < 64 * 1024, `${rel}: ${src.length} bytes is too big`);
  }
});

// herdr's image() rasterises an SVG once at 2 × its width/height and samples that bitmap into the
// element (gpui-pre img.rs:773-775, svg_renderer.rs:200-207; linear filter, one mip). On a 2×
// display at zoom 1 a draw stays sharp while drawn / viewBox ≤ k. svg() masks are rasterised at
// the painted size, so they need no headroom.
test("the intrinsic scale k gives each image() family headroom for its largest draw", () => {
  const all = [...generateAll().keys()];
  for (const rel of all) {
    const k = intrinsicScale(rel);
    if (isMaskPath(rel)) assert.equal(k, 1, `${rel}: masks are rasterised at the painted size`);
    else if (rel.startsWith("art/mob/")) assert.equal(k, 2, rel);
    else if (rel.startsWith("art/gear/acc-")) assert.equal(k, 2, rel);
    else if (rel === "art/fx/campfire.svg") assert.equal(k, 2, rel);
    else if (rel === "art/fx/mug.svg") assert.equal(k, 3, rel);
    // the FIXED stamp slams in from 2× its size (ui/stage.js: 160×56 at age 0, then a 300 ms
    // width/height transition to 80×28 while it fades in); the role matrix never shows that frame
    else if (rel === "art/fx/stamp-fixed.svg") assert.equal(k, 2, rel);
    // bosses, backgrounds, the other fx and the layout preview are drawn at or below their viewBox
    else assert.equal(k, 1, `${rel}: drawn at or below its viewBox`);
  }
  // the biggest mob draw: an elite (ELITE.scale) grower at its cap (ui/stage.js sizes mobs at
  // px × elite × growScale)
  assert.ok(ELITE.scale * (1 + TRAITS.grower.cap) <= intrinsicScale("art/mob/memory_leak_slime.svg") + 1e-9,
    "an elite, fully grown mob outgrows its intrinsic raster");
});

/**
 * Record the largest drawn / viewBox ratio of every mods/down-the-stack/art file drawn with image() in any
 * mock render while `body` runs. Every render counts, so both ends of a width/height transition do.
 */
async function imageDraws(body) {
  await import("../tools/mock/register.mjs");
  const { Mounted, walkLive } = await import("../tools/mock/index.mjs");
  const PREFIX = "mods/down-the-stack/";
  const worst = new Map(); // rel → { scale, at }
  const vbCache = new Map();
  const num = (args) => (Array.isArray(args) && typeof args[0] === "number" ? args[0] : null);
  const render = Mounted.prototype.render;
  Mounted.prototype.render = function (...args) {
    const out = render.apply(this, args);
    if (this.live) walkLive(this.live, (n) => {
      if (n.type !== "image" || typeof n.src !== "string" || !n.src.startsWith(`${PREFIX}art/`)) return;
      const rel = n.src.slice(PREFIX.length);
      const w = num(n.last("w")) ?? num(n.last("size")), h = num(n.last("h")) ?? num(n.last("size"));
      if (w === null || h === null) return;
      if (!vbCache.has(rel)) vbCache.set(rel, sizeOf(read(rel)));
      const [vw, vh] = vbCache.get(rel);
      const scale = Math.min(w / vw, h / vh); // fit is always "contain"
      if (!(worst.get(rel)?.scale >= scale)) worst.set(rel, { scale, at: `${w}x${h} of ${vw}x${vh}` });
    });
    return out;
  };
  try {
    await body();
  } finally {
    Mounted.prototype.render = render;
  }
  return worst;
}

const softDraws = (worst) => [...worst].filter(([rel, d]) => d.scale > intrinsicScale(rel) + 1e-6)
  .map(([rel, d]) => `${rel} drawn ${d.at} (×${d.scale.toFixed(2)}) but k = ${intrinsicScale(rel)}`);

test("every image() draw in the check role matrix fits within its art's intrinsic scale (and the matrix passes)", async () => {
  // The only full run of npm run check's role matrix inside npm test: its errors fail here too, so
  // npm test alone is a gate for what check finds (warnings, such as a slow first render under V8,
  // are left to npm run check).
  const { runCheck } = await import("../tools/check.mjs");
  let res = null;
  const worst = await imageDraws(async () => { res = await runCheck({ log: () => {} }); });
  assert.ok(worst.size >= 40, `the role matrix drew only ${worst.size} art files with image()`);
  assert.deepEqual(softDraws(worst), [], "raise the art's intrinsic scale in tools/gen-art.mjs (INTRINSIC_SCALE)");
  assert.ok(res && res.roles.length >= 40, `the matrix ran ${res ? res.roles.length : 0} roles`);
  const errors = res.errors.map((e) => `[${e.code}] ${[e.where, e.ctx].filter(Boolean).join(" · ")}: ${String(e.message).split("\n")[0]}`);
  assert.deepEqual(errors.slice(0, 12), [], `npm run check finds ${errors.length} errors`);
  assert.equal(res.exitCode, 0);
});

test("every image() draw of the stage scenarios, the FIXED stamp's slam included, fits within k", async () => {
  const worst = await imageDraws(async () => {
    const M = await import("../tools/mock/index.mjs");
    const { View } = await import("gpui-kit");
    const { SCENARIOS, makeScenario } = await import("../tools/vm-samples/stage.mjs");
    const Stage = (await import("../mods/down-the-stack/ui/stage.js")).default;
    const mount = async (vm, zoom) => {
      M.resetState();
      M.setFixture({ settings: { zoom }, layout: M.readLayout(), panes: [] });
      const host = { world: null, version: 1, claim: () => true, view: () => vm, command: () => ({ ok: true }) };
      class Wrap extends View {
        init(_p, cx) { this.stage = new Stage(); this.stage.init({ role: "stage" }, cx, host); }
        render(cx) { return this.stage.render(cx); }
      }
      const mod = await M.mountView(Wrap, { props: { role: "stage" } });
      mod.size((vm?.width ?? 960) * zoom, (vm?.height ?? 200) * zoom);
      mod.render();
    };
    let stamps = 0;
    for (const name of SCENARIOS) {
      const vm = makeScenario(name, { width: 1600 });
      for (const zoom of [1, 2]) await mount(vm, zoom);
      // a won fight's stamp at age 0: the first frame of its slam (drawn big, then shrinking)
      if (vm?.boss?.stamp) {
        stamps++;
        await mount({ ...vm, boss: { ...vm.boss, stamp: { ...vm.boss.stamp, age: 0 } } }, 1);
      }
    }
    assert.ok(stamps >= 1, "no stage scenario has a FIXED stamp");
  });
  assert.ok(worst.has("art/fx/stamp-fixed.svg"), "the stamp was not drawn with image()");
  assert.ok(worst.get("art/fx/stamp-fixed.svg").scale > 1, "the stamp no longer slams in from above its size: lower its k");
  assert.deepEqual(softDraws(worst), [], "raise the art's intrinsic scale in tools/gen-art.mjs (INTRINSIC_SCALE)");
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

test("originality: the first zones' mobs echo no famous game's starter monsters (round 4)", async () => {
  // a snail, mushroom, slime or pig as the first thing a hero fights reads as a copy of a
  // well-known game's starters: none in the first two zones (names, ids, sprite notes, flavour)
  const early = MOBS.filter((m) => m.zone <= 1);
  assert.equal(early.length, 6);
  for (const m of early) {
    for (const text of [m.id, m.name, m.sprite, m.flavor]) {
      assert.doesNotMatch(String(text), /snail|mushroom|shroom|slime|\bpigs?\b|piglet|boar|blob/i, `${m.id}: ${text}`);
    }
  }
  // the slow mob of Whitespace Fields is the Semicolon Sloth: same numbers as the snail it replaced
  const { MOB_BY_ID, MOB_GLYPHS, MAP_BY_ID } = await import("../mods/down-the-stack/game/data.js");
  const sloth = MOB_BY_ID.semicolon_sloth;
  assert.equal(sloth.name, "Semicolon Sloth");
  assert.deepEqual([sloth.zone, sloth.map, sloth.size, sloth.traits.join(), sloth.hp, sloth.atk, sloth.xp, sloth.gold], [0, 2, "S", "slow", 1.3, 0.8, 0.86, 1]);
  assert.equal(MOB_GLYPHS.semicolon_sloth, ";");
  assert.deepEqual(MAP_BY_ID["1-2"].spawn, { semicolon_sloth: 0.75, typo_sprout: 0.25 });
  assert.deepEqual(MAP_BY_ID["1-3"].spawn, { unused_import: 0.75, semicolon_sloth: 0.25 });
  // the old id still resolves (a stale reference), but is never listed or spawned
  assert.equal(MOB_BY_ID.semicolon_snail, sloth);
  assert.ok(!Object.keys(MOB_BY_ID).includes("semicolon_snail"));
  assert.ok(!fs.existsSync(path.join(MOD, "art/mob/semicolon_snail.svg")));
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

// Effect sprites are one-offs, not a family keyed by content ids, so one nothing draws is dead
// weight in every install (fx/lanyard.svg was generated for a design idea the UI never used:
// onboarding is the sheet's "New hire" chip). Each one must be named in the mod's code; the
// chests are drawn through one template (ui/stage.js `fx/chest-${tier}…`).
test("every effect sprite the generator writes is drawn by the mod", () => {
  const src = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "art") walk(p); } else if (e.name.endsWith(".js")) src.push(fs.readFileSync(p, "utf8"));
    }
  };
  walk(MOD);
  const code = src.join("\n");
  const tiers = new Set([...CHEST_TIERS.map((t) => t.id), "duck"]);
  const unused = [];
  for (const rel of generateAll().keys()) {
    const m = /^art\/(fx\/([^/]+))\.svg$/.exec(rel);
    if (!m) continue;
    const chest = /^chest-(\w+?)(-open)?$/.exec(m[2]);
    if (chest) {
      assert.ok(tiers.has(chest[1]), `${rel}: not a chest tier`);
      assert.ok(code.includes("`fx/chest-${"), "the chest template is gone from the mod");
    } else if (!code.includes(`"${m[1]}.svg"`)) unused.push(rel);
  }
  assert.deepEqual(unused, [], "effect sprites that nothing in mods/down-the-stack draws");
});

// ---------------------------------------------------------------------------------------------
// The sharing files herdr's own convention expects next to the layout (defaults/AGENTS.md
// "Layouts and mods other people made"): RECIPE.md in its fixed section order with preview.png,
// and a README that says where the two installed pieces go.
// ---------------------------------------------------------------------------------------------

test("RECIPE.md follows herdr's recipe order and README.md gives the install targets", () => {
  const recipe = fs.readFileSync(path.join(ROOT, "RECIPE.md"), "utf8");
  const heads = [...recipe.matchAll(/^(#{1,2}) (.+)$/gm)].map((m) => `${m[1]} ${m[2].trim()}`);
  assert.deepEqual(heads, ["# Down the Stack", "## What you see", "## How it behaves", "## Built from", "## Watch out", "## Done when"]);
  assert.match(recipe, /!\[Down the Stack\]\(preview\.png\)/);
  assert.ok(fs.existsSync(path.join(ROOT, "preview.png")), "preview.png is missing");
  // the install targets are the files that really ship: every layout file, the mod folder, and
  // every keys section of keys.json (named after the layout, so a rename shows up here; round 4:
  // keys.json at the repo's root is the file herdr's install flow merges, keys.example.json is gone)
  const layouts = fs.readdirSync(path.join(ROOT, "layouts")).filter((f) => f.endsWith(".json"));
  assert.ok(layouts.length >= 1, "no layout file");
  const sections = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "keys.json"), "utf8")));
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const s of [...layouts.map((f) => `layouts/${f}`), "mods/down-the-stack", "HERDR_APP_HOME", "XDG_CONFIG_HOME",
    "~/.config/herdr-app", "herdr-app check", "layout.switch", "keys.json", ...sections])
    assert.ok(readme.includes(s), `README.md does not mention ${s}`);
  for (const f of layouts) {
    const name = f.slice(0, -".json".length);
    assert.ok(readme.includes(`layout.switch {"name": "${name}"}`), `README.md does not say how to switch to ${name}`);
    assert.ok(recipe.includes(`layouts/${f}`), `RECIPE.md does not name layouts/${f}`);
  }
  // every repo path the two files name in backticks must exist
  const named = new Set([...(readme + recipe).matchAll(/`((?:layouts|mods|tools|docs|test)\/[^`\s*<>]+?)`/g)].map((m) => m[1]));
  const missing = [...named].filter((rel) => !fs.existsSync(path.join(ROOT, rel.replace(/\/$/, ""))));
  assert.deepEqual(missing, [], "README.md / RECIPE.md name paths that do not exist");
});

// The lists in RECIPE.md "Built from" and README.md are read off the code here, so a feature that
// adds a herdr call, a command, a key or a save file cannot leave them behind (round 2 found the
// nameplate's pane.split / pane.zoom / pane.close and save.unsaved missing).
test("README.md and RECIPE.md name the herdr functions, commands, keys, save files and art the mod uses", () => {
  const recipe = fs.readFileSync(path.join(ROOT, "RECIPE.md"), "utf8");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const files = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "art") walk(p); } else if (e.name.endsWith(".js")) files.set(path.relative(MOD, p), fs.readFileSync(p, "utf8"));
    }
  };
  walk(MOD);
  // code lines only: a whole-line comment (//, /*, * …) may name a command it does not run
  const codeOf = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  /** The text of a "- **label**" bullet of RECIPE.md, with its indented continuation lines. */
  const bullet = (label) => {
    const lines = recipe.split("\n");
    const i = lines.findIndex((l) => l.startsWith(`- **${label}**`));
    assert.ok(i >= 0, `RECIPE.md has no "${label}" bullet`);
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith("  ")) j++;
    return lines.slice(i, j).join("\n");
  };
  const ticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const sorted = (xs) => [...new Set(xs)].sort();

  // herdr functions: every name imported from "herdr", no more, no less
  const imported = [];
  for (const src of files.values()) {
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"herdr"/g)) {
      for (const part of m[1].split(",")) { const name = part.trim().split(/\s+as\s+/)[0]; if (name) imported.push(name); }
    }
  }
  assert.ok(imported.includes("notify") && imported.includes("readTextFile"), "the herdr import scan found nothing");
  assert.deepEqual(sorted(ticked(bullet("herdr functions"))), sorted(imported), "RECIPE.md herdr functions vs the mod's imports");

  // commands: every herdr app command the code names as a string literal (run(), the nameplate's
  // buttons, the host's layout calls, the toast's mod.open action)
  const app = new Set([...fs.readFileSync(path.join(ROOT, "tools/mock/herdr-commands.md"), "utf8").matchAll(/^## `([^`]+)`\s*$/gm)].map((m) => m[1]));
  const used = [];
  for (const src of files.values()) for (const m of codeOf(src).matchAll(/"([a-z]+\.[a-z_]+)"/g)) if (app.has(m[1])) used.push(m[1]);
  assert.ok(used.includes("pane.focus") && used.includes("layout.hide"), "the command scan found nothing");
  const cmds = bullet("Commands run");
  const listed = ticked(cmds).map((t) => t.split(/\s/)[0]).filter((t) => app.has(t));
  assert.deepEqual(sorted(listed), sorted(used), "RECIPE.md Commands run vs the commands the mod's code names");
  assert.ok(files.get("host.js").includes("run(`${MOD}.tick`)") && cmds.includes("`down-the-stack.tick`"), "the host's own tick broadcast");

  // keys: README's table row per key with its action; RECIPE names every key
  const keys = JSON.parse(fs.readFileSync(path.join(ROOT, "keys.json"), "utf8"));
  for (const [section, map] of Object.entries(keys)) {
    for (const [key, action] of Object.entries(map)) {
      assert.ok(readme.split("\n").some((l) => l.trim().startsWith("|") && l.includes(`\`${key}\``) && l.includes(`\`${action}\``)),
        `README.md has no key table row "${key}" → ${action} (${section})`);
      assert.ok(recipe.includes(`\`${key}\``), `RECIPE.md does not name the key ${key}`);
    }
  }

  // save files: every save.<x> host.js builds in its data folder (`${dir}/save.json` …)
  const saves = sorted([...codeOf(files.get("host.js")).matchAll(/\}\/(save\.[a-z]+)\b/g)].map((m) => m[1]));
  assert.deepEqual(saves, ["save.bak", "save.broken", "save.json", "save.unsaved"], "host.js save files (update this list and the docs together)");
  for (const f of saves) {
    assert.ok(readme.includes(`\`${f}\``), `README.md does not name ${f}`);
    assert.ok(recipe.includes(`\`${f}\``), `RECIPE.md does not name ${f}`);
  }

  // the art count RECIPE.md "Built from" gives is the generator's (preview.svg counted apart)
  const artCount = [...generateAll().keys()].filter((r) => r.startsWith("art/")).length;
  const said = /\*\*Art\*\*: (\d+) SVGs/.exec(recipe);
  assert.equal(said ? Number(said[1]) : null, artCount, "RECIPE.md Art: the number of SVGs gen-art.mjs writes under art/");
});
