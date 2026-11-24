// Screenshots of recorded trees / HTML with Playwright (Chromium), written to out/*.png.
//
// Library:
//   import { shoot } from "./tools/preview/shoot.mjs";
//   await shoot([{ name: "stage", tree, width: 960, height: 200, userFacing: true }]);
//   // shot: { name, html? | tree?, width, height, userFacing? (deviceScaleFactor 2, else 1),
//   //         scale? (explicit deviceScaleFactor), zoom?, theme? }  → [{ name, file }]
//   import { renderRoles, previewAll } from "./tools/preview/shoot.mjs";
//
// CLI (package.json "preview"):
//   node --import ./tools/mock/register.mjs tools/preview/shoot.mjs [--out dir] [--only name]
//        [--main path] [--fixtures path] [--demo]
// With mods/mapledr/main.js and tools/fixtures.mjs: every fixture role → out/role-<name>.png (1×),
// plus out/window.png (2×): the mock herdr window with party, stage and nameplates.
// Without them (or with --demo): the mock's sample mod → out/mock-demo*.png.

import "../mock/register.mjs";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as M from "../mock/index.mjs";
import { treeToHtml } from "./render.mjs";
import { composeWindow } from "./window.mjs";

const require = createRequire(import.meta.url);
const ROLE_SIZE = { stage: [1192, 200], party: [248, 820], nameplate: [590, 34], hud: [1192, 26], sheet: [760, 500], herd: [760, 520] };
const DEFAULT_NOW = Date.UTC(2026, 10, 24, 9, 30, 0);

/** Write PNGs for a list of shots. Returns [{ name, file }]. */
export async function shoot(shots, { outDir = M.OUT_DIR } = {}) {
  const { chromium } = require("playwright");
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const contexts = new Map();
  const written = [];
  try {
    for (const s of shots) {
      const scale = s.scale ?? (s.userFacing ? 2 : 1);
      if (!contexts.has(scale)) contexts.set(scale, await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 800, height: 600 } }));
      const page = await contexts.get(scale).newPage();
      const width = Math.ceil(s.width ?? 960);
      const height = Math.ceil(s.height ?? 240);
      await page.setViewportSize({ width, height });
      const html = s.html ?? treeToHtml(s.tree, { width, height, zoom: s.zoom ?? 1, theme: s.theme, title: s.name });
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts?.ready);
      await page.evaluate(() => window.__previewReady ?? null); // SVG images rasterised as herdr does
      const file = path.join(outDir, `${s.name}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height } });
      if (s.saveHtml) fs.writeFileSync(file.replace(/\.png$/, ".html"), html);
      written.push({ name: s.name, file });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return written;
}

/**
 * Mount every role and render it at a block size; returns [{ role, tree, width, height, errors }].
 * roles: [{ name, props, fixture?, world?, setup?, preview?: {width, height} }] (tools/fixtures.mjs).
 */
export async function renderRoles(main, roles, { ticks = 2, sizeFor } = {}) {
  const out = [];
  for (const role of roles) {
    M.resetState({ checking: false });
    M.resetStorage();
    const kind = role.props?.role;
    const [w, h] = sizeFor?.(role) ?? (role.preview ? [role.preview.width, role.preview.height] : ROLE_SIZE[kind] ?? [960, 240]);
    const mod = await M.mountMod(main, { props: role.props ?? null, fixture: role.fixture ?? {}, nowMs: role.nowMs ?? role.fixture?.nowMs ?? DEFAULT_NOW });
    if (mod.view) {
      if (role.world !== undefined || role.setup) {
        let host = null;
        try { host = (await mod.import("./host.js")).getHost?.() ?? null; } catch { host = null; }
        if (role.world !== undefined && host) {
          host.world = typeof role.world === "function" ? await role.world({ nowMs: M.mockNow(), host, mod, mock: M }) : role.world;
          if (typeof host.version === "number") host.version++;
        }
        if (role.setup) await role.setup({ mod, host, mock: M });
      }
      mod.render();
      mod.size(w, h);
      mod.render();
      for (let i = 0; i < ticks; i++) await mod.tick(1000);
      mod.render();
    }
    out.push({ role, tree: mod.tree, width: w, height: h, errors: mod.errors.slice(), warnings: mod.warnings.slice() });
    await mod.close();
  }
  return out;
}

/** Per-role shots + the composed window. Returns the written files. */
export async function previewAll({ main, roles, outDir = M.OUT_DIR, only, prefix = "role-", windowName = "window" } = {}) {
  // `only`: one name or a comma-separated list of role names (and/or the window's name)
  const wanted = only ? new Set(String(only).split(",").map((x) => x.trim()).filter(Boolean)) : null;
  const pickRoles = wanted && !wanted.has(windowName) ? roles.filter((r) => wanted.has(r.name)) : roles;
  const rendered = await renderRoles(main, pickRoles, {
    sizeFor: (role) => {
      const kind = role.props?.role;
      if (role.preview) return [role.preview.width, role.preview.height];
      const { blocks } = composeWindow({});
      if (kind === "party") return [blocks.party.width, blocks.party.height];
      if (kind === "stage") return [blocks.stage.width, blocks.stage.height];
      if (kind === "nameplate") return [blocks.nameplate.width - 2, blocks.nameplate.height];
      if (kind === "hud") return [blocks.hud.width, 26];
      return ROLE_SIZE[kind] ?? [960, 240];
    },
  });
  const shots = rendered
    .filter((r) => !wanted || wanted.has(r.role.name))
    .map((r) => ({ name: `${prefix}${r.role.name}`, tree: r.tree, width: r.width, height: r.height, saveHtml: true }));
  const pick = (kind) => rendered.find((r) => r.role.props?.role === kind && r.tree)?.tree ?? null;
  const nameplates = rendered.filter((r) => r.role.props?.role === "nameplate" && r.role.props?.terminal && r.tree).slice(0, 3).map((r) => r.tree);
  if (!wanted || wanted.has(windowName)) {
    const win = composeWindow({ party: pick("party"), stage: pick("stage"), hud: pick("hud"), nameplates: nameplates.length ? nameplates : [pick("nameplate")].filter(Boolean) });
    shots.push({ name: windowName, html: win.html, width: win.sizes.width, height: win.sizes.height, userFacing: true, saveHtml: true });
  }
  for (const r of rendered) {
    for (const e of r.errors) console.warn(`  ! ${r.role.name}: [${e.code}] ${e.message}`);
  }
  return shoot(shots, { outDir });
}

async function cli(argv) {
  const opt = { main: path.join(M.REPO, "mods", "mapledr", "main.js"), fixtures: path.join(M.REPO, "tools", "fixtures.mjs"), outDir: M.OUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") opt.outDir = path.resolve(argv[++i]);
    else if (argv[i] === "--only") opt.only = argv[++i];
    else if (argv[i] === "--main") opt.main = path.resolve(argv[++i]);
    else if (argv[i] === "--fixtures") opt.fixtures = path.resolve(argv[++i]);
    else if (argv[i] === "--demo") opt.demo = true;
  }
  let files;
  if (!opt.demo && fs.existsSync(opt.main) && fs.existsSync(opt.fixtures)) {
    const fx = await import(pathToFileURL(opt.fixtures).href);
    const roles = fx.roles ?? fx.default?.roles ?? fx.default;
    files = await previewAll({ main: opt.main, roles, outDir: opt.outDir, only: opt.only });
  } else {
    if (!opt.demo) console.log(`preview: ${!fs.existsSync(opt.main) ? path.relative(M.REPO, opt.main) : path.relative(M.REPO, opt.fixtures)} not found; rendering the mock's sample mod instead.`);
    const demo = path.join(M.REPO, "tools", "mock", "sample", "mods", "mockdemo", "main.js");
    const fixture = M.sampleFixture(3);
    files = await previewAll({
      main: demo, outDir: opt.outDir, prefix: "mock-demo-", windowName: "mock-demo-window",
      roles: [
        { name: "stage", props: { role: "stage" }, fixture },
        { name: "party", props: { role: "party" }, fixture },
        { name: "nameplate", props: { role: "nameplate", pane: "p1", terminal: "t1" }, fixture },
      ],
    });
  }
  for (const f of files) console.log(`wrote ${path.relative(process.cwd(), f.file)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
