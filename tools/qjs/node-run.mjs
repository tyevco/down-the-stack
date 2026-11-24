// V8 side of the differential phase: the same driver.js, shims and sandbox prelude as run.mjs,
// under Node. Prints {kind: digests} as JSON.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const REPO = path.resolve(opt("repo", path.join(HERE, "..", "..")));
const MOD_DIR = path.join(REPO, "mods", "mapledr");
process.env.QJS_MOD_DIR_URL = pathToFileURL(MOD_DIR + "/").href;
register("./node-hooks.mjs", import.meta.url);
const NOW = Date.UTC(2026, 10, 24, 9, 30, 0);
const allow = JSON.parse(fs.readFileSync(path.join(REPO, "tools", "api-allowlist.json"), "utf8"));
const LAYOUT_FILE = fs.readdirSync(path.join(REPO, "layouts")).filter((f) => f.endsWith(".json")).sort()[0];
const LAYOUT = JSON.parse(fs.readFileSync(path.join(REPO, "layouts", LAYOUT_FILE), "utf8"));
const mockState = await import(pathToFileURL(path.join(REPO, "tools", "mock", "state.mjs")).href);
const f = mockState.defaultFixture();
const base = {};
for (const k of Object.keys(f)) if (typeof f[k] !== "function") base[k] = f[k];
base.layout = LAYOUT;
globalThis.__ELEMENT_METHODS = allow.element_methods;
globalThis.__baseFixture = JSON.parse(JSON.stringify(base));
globalThis.__NOW = NOW;
globalThis.__clock = NOW;
const realNow = performance.now.bind(performance);
globalThis.__hrnow = () => realNow();
Date.now = () => globalThis.__clock;
const kinds = opt("kinds", "mid").split(",");
const ticks = Number(opt("ticks", 300));
// load the module graph first (Node's loader must not run under frozen prototypes), then freeze
await import(pathToFileURL(path.join(HERE, "driver.js")).href);
if (!argv.includes("--no-sandbox")) vm.runInThisContext(fs.readFileSync(path.join(HERE, "shims", "sandbox.js"), "utf8"));
const out = {};
const full = {};
for (const kind of kinds) {
  const r = JSON.parse(globalThis.__drv.world(JSON.stringify({ kind, ticks, layout: LAYOUT })));
  out[kind] = argv.includes("--full") ? r : r.digests;
}
process.stdout.write(JSON.stringify(out));
