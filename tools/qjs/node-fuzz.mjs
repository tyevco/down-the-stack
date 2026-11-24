// The fuzz phase under V8 without herdr's frozen prototypes (what the Node mock and the tests see).
//   node tools/qjs/node-fuzz.mjs
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
process.env.QJS_MOD_DIR_URL = pathToFileURL(path.join(REPO, "mods", "mapledr") + "/").href;
register("./node-hooks.mjs", import.meta.url);
const LAYOUT_FILE = fs.readdirSync(path.join(REPO, "layouts")).filter((f) => f.endsWith(".json")).sort()[0];
const LAYOUT = JSON.parse(fs.readFileSync(path.join(REPO, "layouts", LAYOUT_FILE), "utf8"));
const mockState = await import(pathToFileURL(path.join(REPO, "tools", "mock", "state.mjs")).href);
const f = mockState.defaultFixture(); const base = {}; for (const k of Object.keys(f)) if (typeof f[k] !== "function") base[k] = f[k];
globalThis.__ELEMENT_METHODS = JSON.parse(fs.readFileSync(path.join(REPO, "tools", "api-allowlist.json"), "utf8")).element_methods;
globalThis.__baseFixture = JSON.parse(JSON.stringify(base)); globalThis.__NOW = Date.UTC(2026, 10, 24, 9, 30); globalThis.__clock = globalThis.__NOW;
globalThis.__hrnow = () => performance.now(); Date.now = () => globalThis.__clock;
await import("./driver.js");
const r = JSON.parse(globalThis.__drv.fuzz(JSON.stringify({ layout: LAYOUT })));
console.log(`V8, prototypes NOT frozen: ${r.cases} cases, ${r.failures.length} failures`);
for (const x of r.failures) if (/pump|snapshot fields = "constructor"/.test(x)) console.log("  " + x.slice(0, 260));
