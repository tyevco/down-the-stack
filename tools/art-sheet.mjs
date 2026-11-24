#!/usr/bin/env node
// tools/art-sheet.mjs: contact sheet of every generated asset (mods/mapledr/art + preview.svg),
// on a light and a dark background, plus one stage mock per zone (sky bands, far tiles at 50%,
// props, ground, the zone's mobs and boss) to judge the art in context.
//
//   node tools/art-sheet.mjs                       → out/art-sheet.png (deviceScaleFactor 2)
//   node tools/art-sheet.mjs --scale 4 --only mob --out /tmp/x.png   (close-up of one folder)
//   node tools/art-sheet.mjs --html out/art-sheet.html             (also keep the HTML)
//
// Masks (svg() assets) are shown the way herdr draws them: the SVG alpha filled with a tint.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ZONES, MOBS, BOSSES, BACKLOG, CLASSES, RARITIES, ITEM_BASES } from "../mods/mapledr/game/data.js";
import { isMaskPath } from "./gen-art.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = path.join(ROOT, "mods/mapledr");

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const SCALE = Number(opt("--scale", 2));
const SCENE_SCALE = Number(opt("--scene-scale", 1)); // stage mocks at native size (×2 device px)
const ONLY = opt("--only", null);           // folder filter: mob, boss, bg, fx, gear, ui, scene, preview
const OUT = path.resolve(opt("--out", path.join(ROOT, "out/art-sheet.png")));
const HTML = opt("--html", null);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith(".svg")) out.push(p);
  }
  return out;
}
const uri = (abs) => `data:image/svg+xml;base64,${fs.readFileSync(abs).toString("base64")}`;
const sizeOf = (abs) => {
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(fs.readFileSync(abs, "utf8"));
  return m ? [Number(m[1]), Number(m[2])] : [16, 16];
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const METAL = ITEM_BASES.weaponTierTones;
const RAR = RARITIES.map((r) => r.color);

/** One asset tile: full colour via <img>, masks via CSS mask with one or more tints. */
function tile(rel, abs, bg, fg) {
  const [w, h] = sizeOf(abs);
  const W = w * SCALE, H = h * SCALE;
  const name = rel.replace(/^art\//, "").replace(/\.svg$/, "");
  let body;
  if (isMaskPath(rel)) {
    let tints = [fg];
    if (rel.includes("/weapon-")) tints = METAL;
    else if (rel.includes("/hat-")) tints = [fg, "#e86f9c", "#5fb0e8"];
    else if (rel.endsWith("loot.svg")) tints = RAR;
    else if (rel.endsWith("starburst.svg")) tints = ["#fff4d6", "#ffd447"];
    body = tints.map((t) => `<div class="m" style="width:${W}px;height:${H}px;background:${t};` +
      `-webkit-mask-image:url(${uri(abs)});mask-image:url(${uri(abs)})"></div>`).join("");
  } else {
    body = `<img src="${uri(abs)}" style="width:${W}px;height:${H}px">`;
  }
  return `<figure style="background:${bg};color:${fg}"><div class="row">${body}</div><figcaption>${esc(name)} <i>${w}×${h}</i></figcaption></figure>`;
}

function section(title, rels) {
  if (!rels.length) return "";
  const light = rels.map(([rel, abs]) => tile(rel, abs, "#eeeae0", "#2a2633")).join("");
  const dark = rels.map(([rel, abs]) => tile(rel, abs, "#1d1f26", "#e6e6e6")).join("");
  return `<h2>${esc(title)}</h2><div class="grid">${light}</div><div class="grid dark">${dark}</div>`;
}

/** A 600x200 stage mock for one zone (renderer-like composition, D§11.2 / ARCHITECTURE §6.1). */
function scene(zone, mobIds, bossId) {
  const p = zone.palette, Wd = 600, S = SCENE_SCALE;
  const a = (rel) => path.join(MOD, "art", rel);
  const exists = (rel) => fs.existsSync(a(rel));
  const bands = [0, 1, 2, 3].map((i) => mixHex(p.sky, p.far, i * 0.12));
  let h = `<div class="scene" style="width:${Wd * S}px;height:${200 * S}px;background:${p.sky}">`;
  bands.forEach((c, i) => { h += `<div style="position:absolute;left:0;top:${(18 + i * 35) * S}px;width:100%;height:${36 * S}px;background:${c}"></div>`; });
  if (exists(`bg/${zone.id}-far.svg`)) for (let x = 0; x < Wd; x += 160) {
    h += `<img src="${uri(a(`bg/${zone.id}-far.svg`))}" style="position:absolute;left:${x * S}px;top:${40 * S}px;width:${160 * S}px;height:${100 * S}px;opacity:.5">`;
  }
  [[40, 1], [250, 2], [420, 3], [560, 1]].forEach(([x, k]) => {
    const rel = `bg/${zone.id}-prop-${k}.svg`;
    if (!exists(rel)) return;
    const [w, hh] = sizeOf(a(rel));
    h += `<img src="${uri(a(rel))}" style="position:absolute;left:${x * S}px;top:${(160 - hh) * S}px;width:${w * S}px;height:${hh * S}px">`;
  });
  h += `<div style="position:absolute;left:0;top:${160 * S}px;width:100%;height:${40 * S}px;background:${p.ground}"></div>`;
  if (exists(`bg/${zone.id}-ground.svg`)) for (let x = 0; x < Wd; x += 32) {
    h += `<img src="${uri(a(`bg/${zone.id}-ground.svg`))}" style="position:absolute;left:${x * S}px;top:${160 * S}px;width:${32 * S}px;height:${40 * S}px">`;
  }
  h += `<div style="position:absolute;left:0;top:${160 * S}px;width:100%;height:${2 * S}px;background:${p.accent}"></div>`;
  // a stand-in Termling (the real one is built from divs by ui/termling.js)
  h += `<div style="position:absolute;left:${60 * S}px;top:${112 * S}px;width:${40 * S}px;height:${48 * S}px;background:#6c8cf5;border-radius:${6 * S}px;border:${2 * S}px solid #2b3a7a;box-sizing:border-box"></div>`;
  if (exists("gear/weapon-shellmancer.svg")) h += `<div class="m" style="position:absolute;left:${98 * S}px;top:${124 * S}px;width:${16 * S}px;height:${16 * S}px;background:${METAL[2]};-webkit-mask-image:url(${uri(a("gear/weapon-shellmancer.svg"))})"></div>`;
  if (exists("gear/hat-2.svg")) h += `<div class="m" style="position:absolute;left:${68 * S}px;top:${102 * S}px;width:${24 * S}px;height:${12 * S}px;background:#e86f9c;-webkit-mask-image:url(${uri(a("gear/hat-2.svg"))})"></div>`;
  mobIds.forEach((id, i) => {
    const rel = `mob/${id}.svg`;
    if (!exists(rel)) return;
    const [w, hh] = sizeOf(a(rel));
    const x = 150 + i * 62;
    h += `<img src="${uri(a(rel))}" style="position:absolute;left:${x * S}px;top:${(160 - hh) * S}px;width:${w * S}px;height:${hh * S}px">`;
  });
  if (bossId && exists(`boss/${bossId}.svg`)) {
    h += `<img src="${uri(a(`boss/${bossId}.svg`))}" style="position:absolute;left:${400 * S}px;top:${64 * S}px;width:${112 * S}px;height:${96 * S}px">`;
  }
  if (exists("fx/chest-gold.svg")) h += `<img src="${uri(a("fx/chest-gold.svg"))}" style="position:absolute;left:${110 * S}px;top:${138 * S}px;width:${28 * S}px;height:${22 * S}px">`;
  h += `<div class="lbl">${esc(zone.name ?? zone.id)}</div></div>`;
  return h;
}
function mixHex(a, b, t) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

function build() {
  const files = walk(path.join(MOD, "art")).map((abs) => [path.relative(MOD, abs).split(path.sep).join("/"), abs]);
  const groups = {};
  for (const f of files) { const k = f[0].split("/")[1]; (groups[k] ??= []).push(f); }
  const want = (k) => !ONLY || ONLY === k;
  let body = "";
  for (const k of ["mob", "boss", "bg", "fx", "gear", "ui"]) if (want(k) && groups[k]) {
    if (k === "bg") {
      const byZone = {};
      for (const f of groups.bg) { const z = f[0].split("/")[2].replace(/-(far|ground|prop-\d)\.svg$/, ""); (byZone[z] ??= []).push(f); }
      body += Object.entries(byZone).map(([z, fs_]) => section(`bg: ${z}`, fs_)).join("");
    } else body += section(k, groups[k]);
  }
  if (want("preview") && fs.existsSync(path.join(MOD, "preview.svg"))) {
    body += section("preview", [["preview.svg", path.join(MOD, "preview.svg")]]);
  }
  if (want("scene")) {
    body += `<h2>stage mocks (×${SCENE_SCALE})</h2><div class="scenes">`;
    ZONES.forEach((z, i) => {
      body += scene(z, MOBS.filter((m) => m.zone === i).map((m) => m.id), BOSSES[i]?.id);
    });
    body += scene(BACKLOG, ["warning_mite", "nitpick", "holo_duck"], null) + "</div>";
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:12px;background:#8c8c94;font:12px/1.3 monospace;color:#111}
    h2{margin:14px 0 4px;font-size:14px}
    .grid{display:flex;flex-wrap:wrap;gap:6px;padding:6px;align-items:flex-end}
    .grid.dark{background:#1d1f26}
    figure{margin:0;padding:6px;display:flex;flex-direction:column;align-items:center;gap:3px}
    figure .row{display:flex;gap:4px;align-items:flex-end}
    figcaption{font-size:10px;opacity:.8} figcaption i{opacity:.6}
    img{display:block;image-rendering:pixelated}
    .m{-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat}
    .scenes{display:flex;flex-wrap:wrap;gap:6px}
    .scene{position:relative;overflow:hidden;margin:0}
    .scene img{image-rendering:pixelated}
    .lbl{position:absolute;left:6px;top:4px;color:#fff;background:#0008;padding:1px 4px}
  </style></head><body>${body}</body></html>`;
}

const html = build();
if (HTML) fs.writeFileSync(path.resolve(HTML), html);
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: Math.max(1240, 620 * SCENE_SCALE + 40), height: 900 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, fullPage: true });
  console.log(`art-sheet: ${OUT}`);
} finally {
  await browser.close();
}
