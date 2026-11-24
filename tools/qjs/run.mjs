#!/usr/bin/env node
// QuickJS-ng harness for the mapledr mod ("Down the Stack").
//
//   npm run qjs -- [--only <phase>[,<phase>...]] [--kinds mid,late] [--ticks 300] [--seconds 120]
//                  [--long 20000] [--long-kind late] [--json out.json] [--repo <repo root>]
//   (= node tools/qjs/run.mjs ...; needs the devDependencies: `npm install`. Results go to
//   out/qjs/results.json unless --json says otherwise.)
//
// Phases (default: all, in this order):
//   lint      static scan of mods/mapledr (acorn): syntax features, risky built-ins, regex flags,
//             assignments that hit herdr's frozen prototypes (the "override mistake")
//   builtins  the same probe script in QuickJS-ng and V8: sort stability, number formatting, JSON,
//             Date, regex, Intl/locale, frozen-prototype behaviour; every differing answer listed
//   modeval   module evaluation of main.js (herdr budget 500 ms: the load runs in a Task scope,
//             plugin.rs load_view_with_policy; sandbox.rs gives Task the event budget), fresh VM
//   check     `herdr-app check` path: checking() true, props() null, empty lists; init + render
//   worlds    every demo world (game/demo.js), fresh VM each: build, save round trip, cold tick +
//             cold views on the reloaded world, N warm ticks, every view builder (stage at
//             360/960/1600/2400, party, hud, nameplates, sheet × tab, herd × tab), every role
//             renderer through main.js (cold = memo miss incl. view build; warm = memo hit)
//   window    a whole window per demo world for --seconds: stage + party + hud + every nameplate +
//             sheet + Herd panel; each second the stage copy's 1 s timer (host.pump) then every
//             copy renders. Timer callback (500 ms budget) and per-render / per-frame times
//   diff      differential: the worlds phase's output digests (VMs, render trees, save text) from
//             QuickJS-ng vs the same driver under V8 (node-run.mjs); any mismatch is an engine
//             divergence
//   fuzz      external strings that collide with frozen Object.prototype names ("constructor",
//             "__proto__", "toString", ...) as hero/herd names, titles, program keys, addresses
//   long      memory: one world through the real pump for --long seconds (default 20000);
//             QuickJS heap at 1k/5k/20k and every array/Map/Set size reachable from the world,
//             host and module caches
//
// The engine is quickjs-emscripten's QuickJS-ng release-sync wasm build (an interpreter, no JIT),
// with herdr's runtime limits (256 MiB heap, 1 MiB stack: sandbox.rs:407-419) and herdr's sandbox
// prelude (frozen prototypes, no eval/Function: sandbox.rs:166-212). herdr runs quickjs-jit
// (QuickJS-ng + a tiered Cranelift JIT, natively), so wasm-interpreter times are a conservative
// upper bound for herdr's.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import os from "node:os";

// The engine packages are devDependencies: `npm test` and `npm run check` never need them.
let newQuickJSWASMModuleFromVariant, variant;
try {
  ({ newQuickJSWASMModuleFromVariant } = await import("quickjs-emscripten"));
  variant = (await import("@jitl/quickjs-ng-wasmfile-release-sync")).default;
} catch (e) {
  console.error(`npm run qjs needs the QuickJS-ng packages (devDependencies): run \`npm install\` first.\n(${e.message})`);
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const REPO = path.resolve(opt("repo", path.join(HERE, "..", "..")));
const MOD_DIR = path.join(REPO, "mods", "mapledr");
const SHIMS = path.join(HERE, "shims");
const ALL = ["lint", "builtins", "modeval", "check", "roles", "load", "worlds", "window", "diff", "fuzz", "long"];
const ONLY = (opt("only", "") || "").split(",").filter(Boolean);
for (const o of ONLY) if (!ALL.includes(o)) { console.error(`unknown phase ${o} (one of ${ALL.join(", ")})`); process.exit(2); }
const PHASES = ONLY.length ? ONLY : ALL;
const TICKS = Number(opt("ticks", 300));
const SECONDS = Number(opt("seconds", 120));
const LONG = Number(opt("long", 20000));
const LONG_KIND = opt("long-kind", "late");
const JSON_OUT = opt("json", path.join(REPO, "out", "qjs", "results.json"));

const NOW = Date.UTC(2026, 10, 24, 9, 30, 0); // tools/fixtures.mjs NOW (a Tuesday morning)
const RENDER_BUDGET = 50, CALLBACK_BUDGET = 500, MODULE_BUDGET = 500, TICK_TARGET = 5;

const allow = JSON.parse(fs.readFileSync(path.join(REPO, "tools", "api-allowlist.json"), "utf8"));
const ELEMENT_METHODS = allow.element_methods;
// the repo's one layout (layouts/<name>.json)
const LAYOUT_FILE = fs.readdirSync(path.join(REPO, "layouts")).filter((f) => f.endsWith(".json")).sort()[0];
const LAYOUT = JSON.parse(fs.readFileSync(path.join(REPO, "layouts", LAYOUT_FILE), "utf8"));

// herdr's default theme/settings as the Node mock knows them (tools/mock/state.mjs defaultFixture)
const mockState = await import(pathToFileURL(path.join(REPO, "tools", "mock", "state.mjs")).href);
const baseFixture = (() => {
  const f = mockState.defaultFixture();
  const out = {};
  for (const k of Object.keys(f)) if (typeof f[k] !== "function") out[k] = f[k];
  out.layout = LAYOUT;
  return JSON.parse(JSON.stringify(out));
})();
const checkFixture = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(mockState.checkFixture()).filter(([, v]) => typeof v !== "function"))));
const demo = await import(pathToFileURL(path.join(MOD_DIR, "game", "demo.js")).href);
const KINDS = (opt("kinds", "") || "").split(",").filter(Boolean).length ? opt("kinds").split(",") : [...demo.DEMO_KINDS, "stress30"];

const QJS = await newQuickJSWASMModuleFromVariant(variant);
const results = { engine: "quickjs-ng 0.12.1 (quickjs-emscripten @jitl/quickjs-ng-wasmfile-release-sync 0.32.0, wasm interpreter)", node: process.version, phases: {} };

// ---------------------------------------------------------------------------------------------
// module loading: debug exports appended to module-level caches (harness only, never on disk)

const INSTRUMENT = {
  "game/heroes.js": "export const __qjsDbg = () => ({ effCache: effCache.size, dryCache: dryCache.size });",
  "game/combat.js": "export const __qjsDbg = () => ({ spawnCache: spawnCache.size, ROOM_ENT: ROOM_ENT.length, ROOM_ACTORS: ROOM_ACTORS.length });",
  "game/boss.js": "export const __qjsDbg = () => ({ ACTORS: ACTORS.length });",
  "game/view/panels.js": "export const __qjsDbg = () => ({ SCORES: SCORES.size, scoreEntries: Array.from(SCORES.values()).reduce((n, s) => n + ((s && s.cur && s.cur.size) || 0) + ((s && s.prev && s.prev.size) || 0), 0) });",
  "game/view/chrome.js": "export const __qjsDbg = () => ({ PLATES: PLATES.map.size });",
  "game/save.js": "export const __qjsDbg = () => ({ defaultJson: defaultJson.size });",
};

function normalize(base, req) {
  if (req === "herdr" || req === "gpui-kit" || req === "gpui-base") return path.join(SHIMS, `${req}.js`);
  if (req.startsWith("@mod/")) return path.join(MOD_DIR, req.slice(5));
  if (req.startsWith("./") || req.startsWith("../")) return path.resolve(path.dirname(base), req);
  if (req.startsWith("/")) return req;
  throw new Error(`herdr has no module "${req}" (imported from ${base})`);
}

function loadSource(name, instrument) {
  let src = fs.readFileSync(name, "utf8");
  if (instrument && name.startsWith(MOD_DIR + path.sep)) {
    const rel = path.relative(MOD_DIR, name).split(path.sep).join("/");
    if (INSTRUMENT[rel]) src += "\n" + INSTRUMENT[rel] + "\n";
  }
  return src;
}

// ---------------------------------------------------------------------------------------------
// a VM

function newVM({ instrument = false } = {}) {
  const loaded = [];
  const rt = QJS.newRuntime({
    memoryLimitBytes: 256 * 1024 * 1024, // sandbox.rs:407
    maxStackSizeBytes: 1024 * 1024, // sandbox.rs:417
  });
  rt.setModuleLoader(
    (name) => {
      try {
        loaded.push(name);
        return loadSource(name, instrument);
      } catch (e) {
        return { error: e };
      }
    },
    (base, req) => {
      try {
        return normalize(base, req);
      } catch (e) {
        return { error: e };
      }
    },
  );
  const ctx = rt.newContext();
  const log = [];
  const fn = (name, f) => {
    const h = ctx.newFunction(name, f);
    ctx.setProp(ctx.global, name, h);
    h.dispose();
  };
  fn("__hrnow", () => ctx.newNumber(performance.now()));
  // heap in use (QuickJS JS_ComputeMemoryUsage), callable mid-run: a drop across a render = a GC cycle ran in it
  fn("__mem", () => { const h = rt.computeMemoryUsage(); const m = ctx.getNumber(ctx.getProp(h, "memory_used_size")); h.dispose(); return ctx.newNumber(m); });
  fn("__print", (h) => { const s = ctx.getString(h); if (log.length < 500) log.push(s); return ctx.undefined; });
  const setGlobalJSON = (name, value) => {
    const r = ctx.evalCode(`globalThis.${name} = ${JSON.stringify(value)};`, `<${name}>`, { type: "global" });
    if (r.error) { const e = ctx.dump(r.error); r.error.dispose(); throw new Error(`${name}: ${JSON.stringify(e)}`); }
    r.value.dispose();
  };
  setGlobalJSON("__ELEMENT_METHODS", ELEMENT_METHODS);
  setGlobalJSON("__baseFixture", baseFixture);
  setGlobalJSON("__NOW", NOW);
  evalGlobal(ctx, `
    globalThis.__clock = __NOW;
    Date.now = () => globalThis.__clock;
    globalThis.console = { log: (...a) => __print(a.map(String).join(" ")), warn: (...a) => __print("warn: " + a.map(String).join(" ")), error: (...a) => __print("error: " + a.map(String).join(" ")) };
  `, "<prelude>");
  evalGlobal(ctx, fs.readFileSync(path.join(SHIMS, "sandbox.js"), "utf8"), "<herdr sandbox>");
  return { rt, ctx, loaded, log };
}

function evalGlobal(ctx, code, name) {
  const r = ctx.evalCode(code, name, { type: "global" });
  if (r.error) {
    const e = ctx.dump(r.error);
    r.error.dispose();
    throw new Error(`${name}: ${typeof e === "object" ? `${e.name}: ${e.message}\n${e.stack}` : e}`);
  }
  const v = ctx.dump(r.value);
  r.value.dispose();
  return v;
}

/** Evaluate a module (by file path) and settle its evaluation promise. */
function evalModule(vm, file) {
  const { rt, ctx } = vm;
  const code = fs.readFileSync(file, "utf8");
  const t0 = performance.now();
  const r = ctx.evalCode(code, file, { type: "module" });
  if (r.error) {
    const e = ctx.dump(r.error);
    r.error.dispose();
    throw new Error(`module ${file}: ${typeof e === "object" ? `${e.name}: ${e.message}\n${e.stack}` : e}`);
  }
  let settled = r.value;
  const state = ctx.getPromiseState(settled);
  if (state.type === "pending") rt.executePendingJobs();
  const st = ctx.getPromiseState(settled);
  if (st.type === "rejected") {
    const e = ctx.dump(st.error);
    st.error.dispose();
    settled.dispose();
    throw new Error(`module ${file} rejected: ${typeof e === "object" ? `${e.name}: ${e.message}\n${e.stack}` : e}`);
  }
  if (st.type === "fulfilled" && st.value && st.value !== settled) st.value.dispose();
  settled.dispose();
  return performance.now() - t0;
}

/** Load a module by import specifier through a tiny wrapper module. */
function importInto(vm, spec) {
  const file = path.join(os.tmpdir(), `mdr-qjs-entry-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, `import ${JSON.stringify(spec)};\n`);
  try {
    return evalModule(vm, file);
  } finally {
    fs.unlinkSync(file);
  }
}

function call(vm, name, arg) {
  const { rt, ctx } = vm;
  const drv = ctx.getProp(ctx.global, "__drv");
  const f = ctx.getProp(drv, name);
  const a = ctx.newString(JSON.stringify(arg ?? {}));
  const t0 = performance.now();
  const r = ctx.callFunction(f, drv, a);
  const wall = performance.now() - t0;
  a.dispose(); f.dispose(); drv.dispose();
  if (r.error) {
    const e = ctx.dump(r.error);
    r.error.dispose();
    throw new Error(`__drv.${name}: ${typeof e === "object" ? `${e.name}: ${e.message}\n${e.stack}` : e}`);
  }
  const s = ctx.getString(r.value);
  r.value.dispose();
  const tj = performance.now();
  rt.executePendingJobs();
  const jobs = performance.now() - tj;
  const out = JSON.parse(s);
  if (out && typeof out === "object") { out.__wallMs = +wall.toFixed(1); out.__jobsMs = +jobs.toFixed(2); }
  return out;
}

/** A driver call whose JSON result is returned as text; the job queue is drained after it. */
function callRaw(vm, name, argText) {
  const { rt, ctx } = vm;
  const drv = ctx.getProp(ctx.global, "__drv");
  const f = ctx.getProp(drv, name);
  const a = ctx.newString(argText);
  const r = ctx.callFunction(f, drv, a);
  a.dispose(); f.dispose(); drv.dispose();
  if (r.error) {
    const e = ctx.dump(r.error);
    r.error.dispose();
    throw new Error(`__drv.${name}: ${typeof e === "object" ? `${e.name}: ${e.message}\n${e.stack}` : e}`);
  }
  const s = ctx.getString(r.value);
  r.value.dispose();
  rt.executePendingJobs();
  return s;
}

function statOf(list) {
  if (!list.length) return null;
  const a = list.slice().sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { n: a.length, mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +a[a.length - 1].toFixed(3) };
}

function memory(vm) {
  const h = vm.rt.computeMemoryUsage();
  const m = vm.ctx.dump(h);
  h.dispose();
  return m;
}

function bootDriver(opts = {}) {
  const vm = newVM(opts);
  const ms = evalModule(vm, path.join(HERE, "driver.js"));
  return { vm, loadMs: ms };
}

const fmt = (x) => (typeof x === "number" ? x.toFixed(2) : String(x));
const out = (s = "") => console.log(s);
const flags = [];
const flagIf = (cond, text) => { if (cond) flags.push(text); };

// ---------------------------------------------------------------------------------------------
// phases

const phases = {};

phases.lint = async () => {
  const r = await import(pathToFileURL(path.join(HERE, "lint.mjs")).href);
  const res = r.lint(MOD_DIR);
  out(`files ${res.files}, lines ${res.lines}`);
  out(`syntax features: ${JSON.stringify(res.features)}`);
  out(`risky built-ins: ${res.risky.length ? "" : "none"}`);
  for (const x of res.risky) out(`  ${x}`);
  out(`regex literals: ${res.regexes.length} (flags: ${JSON.stringify(res.regexFlags)})`);
  for (const x of res.regexNotes) out(`  ${x}`);
  out(`frozen-prototype assignment candidates: ${res.override.length ? "" : "none"}`);
  for (const x of res.override) out(`  ${x}`);
  out(`computed-key writes on plain objects (key provenance checked by the fuzz phase): ${res.computedWrites}`);
  out(`sort calls needing a look: ${res.sorts.length ? "" : "none"}`);
  for (const x of res.sorts) out(`  ${x}`);
  // every free identifier the mod references must exist in herdr's QuickJS-ng context
  const vm = newVM();
  const names = Object.keys(res.globals).filter((g) => /^[A-Za-z_$][\w$]*$/.test(g));
  const types = evalGlobal(vm.ctx, `(${JSON.stringify(names)}).map((n) => [n, typeof globalThis[n]])`, "<globals>");
  vm.ctx.dispose(); vm.rt.dispose();
  const missing = types.filter(([n, t]) => t === "undefined" && !["undefined"].includes(n));
  out(`free globals referenced (${names.length}): ${names.join(" ")}`);
  out(`  missing in QuickJS-ng + herdr sandbox: ${missing.length ? missing.map(([n]) => `${n} (${res.globals[n]} refs)`).join(", ") : "none"}`);
  res.missingGlobals = missing.map(([n]) => n);
  for (const [n] of missing) flags.push(`global ${n} referenced by the mod is undefined in QuickJS-ng`);
  return res;
};

phases.builtins = async () => {
  const probe = fs.readFileSync(path.join(HERE, "probe.js"), "utf8");
  const vm = newVM();
  const q = evalGlobal(vm.ctx, probe, "<probe>");
  vm.ctx.dispose(); vm.rt.dispose();
  const node = spawnSync(process.execPath, [path.join(HERE, "probe-node.mjs")], { encoding: "utf8" });
  if (node.status !== 0) throw new Error(node.stderr);
  const v = JSON.parse(node.stdout);
  const diffs = [];
  for (const k of Object.keys(q)) if (JSON.stringify(q[k]) !== JSON.stringify(v[k])) diffs.push({ probe: k, quickjs: q[k], v8: v[k] });
  out(`${Object.keys(q).length} probes, ${diffs.length} differ between QuickJS-ng and V8:`);
  for (const d of diffs) out(`  ${d.probe}: quickjs=${JSON.stringify(d.quickjs)}  v8=${JSON.stringify(d.v8)}`);
  return { probes: Object.keys(q).length, diffs, quickjs: q };
};

phases.modeval = () => {
  const res = {};
  for (const rep of [1, 2, 3]) {
    const vm = newVM();
    const ms = importInto(vm, path.join(MOD_DIR, "main.js"));
    const mem = memory(vm);
    res[`run${rep}`] = { ms: +ms.toFixed(1), modules: vm.loaded.length, heapBytes: mem.memory_used_size, log: vm.log };
    vm.ctx.dispose(); vm.rt.dispose();
  }
  out(`main.js module graph (${res.run1.modules} modules) evaluated in ${res.run1.ms} / ${res.run2.ms} / ${res.run3.ms} ms (budget ${MODULE_BUDGET} ms); heap after eval ${(res.run1.heapBytes / 1048576).toFixed(1)} MiB`);
  flagIf(res.run1.ms > MODULE_BUDGET / 2, `module eval ${res.run1.ms} ms > 50% of the ${MODULE_BUDGET} ms budget`);
  return res;
};

phases.check = () => {
  const { vm, loadMs } = bootDriver();
  const r = call(vm, "check", { fixture: checkFixture });
  vm.ctx.dispose(); vm.rt.dispose();
  out(`herdr-app check path: init ${r.initMs} ms, render ${r.renderMs} ms, timers ${r.timers}, error ${r.error || "none"}`);
  out(`  tree: ${JSON.stringify(r.tree).slice(0, 200)}`);
  out(`  shim errors ${JSON.stringify(r.shimErrs)}, task errors ${JSON.stringify(r.copyErrors)}`);
  return r;
};

phases.roles = async () => {
  const F = await import(pathToFileURL(path.join(REPO, "tools", "fixtures.mjs")).href);
  const HEIGHT = { stage: 200, party: 820, nameplate: 34, hud: 26, sheet: 500, herd: 520 };
  const extras = [{}, { agents: [F.CONTRACTOR] }, { shell: true }, { modPane: true }];
  const res = {};
  for (const role of F.roles) {
    const fx = role.fixture;
    let kind = null, ex = null;
    for (const k of demo.DEMO_KINDS) for (const e of extras) if (!kind && F.demoFixture(k, e) === fx) { kind = k; ex = e; }
    const arg = {
      name: role.name, props: role.props, fixture: JSON.parse(JSON.stringify(fx, (k, v) => (typeof v === "function" ? undefined : v))),
      kind: role.name === "nameplate-loading" ? "mid" : kind, contractor: /contractor/.test(role.name), loading: role.name === "nameplate-loading",
      widths: role.widths || [360, 960, 1600], zooms: role.zooms || [1, 2], height: role.height || HEIGHT[role.props.role] || 240,
    };
    if (!arg.kind) { out(`  ${role.name}: could not map its fixture to a demo kind`); flags.push(`roles: ${role.name} unmapped`); continue; }
    const { vm } = bootDriver();
    const r = call(vm, "fixtureRole", arg);
    vm.ctx.dispose(); vm.rt.dispose();
    res[role.name] = r;
    const errs = [...r.errors, ...r.hostErrors, ...r.engineErrors.map((x) => `engine ${x}`), ...r.shimErrs.map((x) => `${x.code}: ${x.msg}`), ...r.copyErrors];
    out(`  ${role.name.padEnd(22)} (${arg.kind}${arg.contractor ? "+contractor" : ""}) ${r.renders.length} renders, max ${r.max.toFixed(2)} ms, max nodes ${r.maxNodes}${errs.length ? "  ERRORS " + JSON.stringify(errs.slice(0, 4)) : ""}`);
    for (const e of errs) flags.push(`roles ${role.name}: ${e}`);
    flagIf(r.max > RENDER_BUDGET / 2, `roles ${role.name}: render max ${r.max} ms > 50% of 50 ms`);
  }
  return res;
};

phases.load = async () => {
  const res = {};
  const S = await import(pathToFileURL(path.join(MOD_DIR, "game", "save.js")).href);
  const flipDigit = (t) => { let i = t.length >> 1; while (!/[0-8]/.test(t[i])) i++; return t.slice(0, i) + String(Number(t[i]) + 1) + t.slice(i + 1); };
  const newerVersion = async (t) => {
    const t0 = t.replace(/"crc":"[0-9a-f]*"/, '"crc":""').replace(/^\{"v":\d+/, '{"v":99');
    return t0.replace('"crc":""', `"crc":"${S.crc32(t0)}"`);
  };
  const DIR = "/mock/home/data/mapledr";
  const { vm: v0 } = bootDriver();
  const good = call(v0, "saveText", { kind: "stress30" }).text;
  const older = call(v0, "saveText", { kind: "mid" }).text;
  v0.ctx.dispose(); v0.rt.dispose();
  const cases = {
    "no save (fresh)": {},
    "save.json (30 heroes)": { [`${DIR}/save.json`]: good },
    "corrupt save.json + good save.bak": { [`${DIR}/save.json`]: good.slice(0, good.length >> 1), [`${DIR}/save.bak`]: older },
    "save.json with a flipped digit (CRC mismatch) + good save.bak": { [`${DIR}/save.json`]: flipDigit(good), [`${DIR}/save.bak`]: older },
    "save from a newer version (valid CRC)": { [`${DIR}/save.json`]: await newerVersion(good) },
  };
  for (const [name, files] of Object.entries(cases)) {
    const { vm } = bootDriver();
    const a = call(vm, "loadStart", { files, layout: LAYOUT, kind: "stress30" });
    const settle = a.__jobsMs; // the job queue after init: readTextFile resolves, the load task's loadWorld continuation runs
    const b = call(vm, "loadCheck", {});
    vm.ctx.dispose(); vm.rt.dispose();
    res[name] = { ...a, ...b, settleMs: +settle.toFixed(2) };
    out(`  ${name}: from ${b.from}, heroes ${b.heroes}, readOnly ${b.readOnly}, load task (after init) ${settle.toFixed(1)} ms, first render ${typeof b.renderMs === "number" ? b.renderMs.toFixed(2) + " ms" : b.renderMs}${b.chip ? " ERROR CHIP" : ""}, pump ${b.pumpMs} ms, files ${JSON.stringify(b.files.map((f) => f.split("/").pop()))}${b.errors.length ? ", host errors " + JSON.stringify(b.errors) : ""}${b.warning ? ", warning " + b.warning : ""}`);
    flagIf(settle > CALLBACK_BUDGET / 2, `load ${name}: task ${settle.toFixed(1)} ms > 50% of 500 ms`);
    if (b.chip || typeof b.renderMs !== "number") flags.push(`load ${name}: render failed`);
  }
  return res;
};

phases.worlds = () => {
  const res = {};
  for (const kind of KINDS) {
    const { vm, loadMs } = bootDriver();
    const r = call(vm, "world", { kind, ticks: TICKS, layout: LAYOUT });
    r.memAfter = memory(vm).memory_used_size;
    r.log = vm.log.slice(0, 20);
    vm.ctx.dispose(); vm.rt.dispose();
    res[kind] = r;
    out(`\n== ${kind}: ${r.heroes} heroes (${r.live} live), build ${r.buildMs} ms, driver load ${loadMs.toFixed(0)} ms`);
    out(`  save: ${r.save.bytes} B, serialize ${r.save.serializeMs} ms, loadWorld ${r.save.loadWorldMs} ms, round trip identical ${r.save.identical}${r.save.warning ? ", warning " + r.save.warning : ""}`);
    out(`  after ${TICKS} ticks: ${r.saveAfter.bytes} B, serialize ${r.saveAfter.serializeMs} ms, loadWorld ${r.saveAfter.loadWorldMs} ms, identical ${r.saveAfter.identical}`);
    out(`  cold tick (reloaded world) ${fmt(r.coldTickMs)} ms; warm ticks ${JSON.stringify(r.ticks)}${r.tickErrors ? " ERRORS " + JSON.stringify(r.tickErrors) : ""}`);
    if (r.engineErrors && r.engineErrors.length) out(`  engine rt.errors: ${JSON.stringify(r.engineErrors)}`);
    const row = (label, o) => out(`  ${label}: ` + Object.entries(o || {}).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join("  "));
    row("cold views", r.coldViews);
    row("warm views", r.views);
    row("memo hits", r.viewsMemoHit);
    for (const [name, v] of Object.entries(r.roles || {})) {
      out(`  render ${name}: ${v.error ? "ERROR " + v.error : `cold ${v.cold} ms (memo miss, incl. view)  warm p50 ${v.warm.p50} max ${v.warm.max} ms  nodes ${v.nodes}${v.errors ? "  host errors " + JSON.stringify(v.errors) : ""}${v.chip ? "  ERROR CHIP" : ""}`}`);
      if (!v.error) {
        flagIf(v.cold > RENDER_BUDGET / 2, `${kind} render ${name}: cold ${v.cold} ms > 50% of the 50 ms render budget`);
        flagIf(v.warm.max > RENDER_BUDGET / 2, `${kind} render ${name}: warm max ${v.warm.max} ms > 50% of the 50 ms render budget`);
      } else flags.push(`${kind} render ${name}: ${v.error}`);
      if (v.errors || v.chip) flags.push(`${kind} render ${name}: host errors ${JSON.stringify(v.errors)}`);
    }
    if (r.shimErrs.length) out(`  shim errors: ${JSON.stringify(r.shimErrs.slice(0, 5))}`);
    if (r.copyErrors.length) out(`  task errors: ${JSON.stringify(r.copyErrors.slice(0, 5))}`);
    flagIf(!r.save.identical || !r.saveAfter.identical, `${kind}: save round trip not identical`);
    flagIf(r.ticks && r.ticks.max > CALLBACK_BUDGET / 2, `${kind}: tick max ${r.ticks.max} ms > 50% of the 500 ms callback budget`);
    flagIf(typeof r.coldTickMs === "number" && r.coldTickMs > CALLBACK_BUDGET / 2, `${kind}: cold tick ${r.coldTickMs} ms > 50% of the 500 ms callback budget`);
    flagIf(r.ticks && r.ticks.p95 > TICK_TARGET, `${kind}: tick p95 ${r.ticks.p95} ms > the ~5 ms tick target (ARCHITECTURE §2.5)`);
    for (const [name, v] of Object.entries(r.views || {})) if (typeof v === "number" && v > CALLBACK_BUDGET / 2) flags.push(`${kind}: view ${name} ${v} ms > 50% of the 500 ms callback budget`);
    for (const [name, v] of Object.entries(r.coldViews || {})) if (typeof v === "object") flags.push(`${kind}: cold view ${name} threw ${v.error}`);
    for (const [name, v] of Object.entries(r.views || {})) if (typeof v === "object") flags.push(`${kind}: view ${name} threw ${v.error}`);
    flagIf(r.save.serializeMs > CALLBACK_BUDGET / 2 || r.save.loadWorldMs > CALLBACK_BUDGET / 2, `${kind}: save ${r.save.serializeMs}/${r.save.loadWorldMs} ms > 50% of the callback budget`);
  }
  return res;
};

phases.window = () => {
  const res = {};
  for (const kind of KINDS) {
    if (kind === "empty") continue;
    const { vm } = bootDriver();
    call(vm, "windowStart", { kind, layout: LAYOUT });
    for (let i = 0; i < SECONDS; i++) callRaw(vm, "windowStep", "{}");
    const r = call(vm, "windowEnd", {});
    r.heap = memory(vm).memory_used_size;
    vm.ctx.dispose(); vm.rt.dispose();
    res[kind] = r;
    out(`\n== window ${kind}: ${r.copies} copies, ${SECONDS} s`);
    out(`  timer callback (pump: tick + save + prewarm): ${JSON.stringify(r.pump)}   writes ${r.saves}, saves done ${r.savesDone} (max ${r.maxSaveBytes} B)`);
    out(`  frame (all copies render after a broadcast): ${JSON.stringify(r.frame)}`);
    for (const [k, v] of Object.entries(r.renders)) out(`  render ${k}: ${JSON.stringify(v)}`);
    for (const sp of r.spikes || []) out(`  render spike: ${sp.copy} ${sp.ms} ms at ${sp.t} s, heap ${(sp.heapBefore / 1048576).toFixed(2)} → ${(sp.heapAfter / 1048576).toFixed(2)} MiB${sp.heapAfter < sp.heapBefore - 262144 ? "  (a GC cycle ran inside this render)" : ""}`);
    if (r.hostErrors.length) out(`  host errors: ${JSON.stringify(r.hostErrors)}`);
    if (r.engineErrors.length) out(`  engine errors: ${JSON.stringify(r.engineErrors)}`);
    if (r.shimErrs.length) out(`  shim errors: ${JSON.stringify(r.shimErrs.slice(0, 5))}`);
    if (r.copyErrors.length) out(`  task errors: ${JSON.stringify(r.copyErrors.slice(0, 5))}`);
    flagIf(r.pump.max > CALLBACK_BUDGET / 2, `window ${kind}: timer callback max ${r.pump.max} ms > 50% of 500 ms`);
    for (const [k, v] of Object.entries(r.renders)) flagIf(v.max > RENDER_BUDGET / 2, `window ${kind}: render ${k} max ${v.max} ms > 50% of 50 ms`);
    if (r.hostErrors.length) flags.push(`window ${kind}: host errors ${JSON.stringify(r.hostErrors)}`);
  }
  return res;
};

phases.diff = () => {
  const kinds = KINDS;
  const q = {};
  for (const kind of kinds) {
    const { vm } = bootDriver();
    q[kind] = call(vm, "world", { kind, ticks: TICKS, layout: LAYOUT }).digests;
    vm.ctx.dispose(); vm.rt.dispose();
  }
  const node = spawnSync(process.execPath, ["--stack-size=4000", path.join(HERE, "node-run.mjs"), "--repo", REPO, "--kinds", kinds.join(","), "--ticks", String(TICKS)], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (node.status !== 0) throw new Error(`node-run failed: ${node.stderr}`);
  const v = JSON.parse(node.stdout);
  const diffs = [];
  let n = 0;
  for (const kind of kinds) {
    for (const k of Object.keys(q[kind])) {
      n++;
      if (q[kind][k] !== (v[kind] || {})[k]) diffs.push(`${kind} ${k}: quickjs ${q[kind][k]} v8 ${(v[kind] || {})[k]}`);
    }
  }
  out(`${n} outputs compared (VMs, render trees, save texts, world state after 100/${TICKS} ticks): ${diffs.length} differ`);
  for (const d of diffs) out(`  ${d}`);
  if (diffs.length) flags.push(`differential: ${diffs.length} outputs differ between QuickJS-ng and V8`);
  return { compared: n, diffs };
};

phases.fuzz = () => {
  const { vm } = bootDriver();
  const r = call(vm, "fuzz", { layout: LAYOUT });
  vm.ctx.dispose(); vm.rt.dispose();
  out(`${r.cases} cases; ${r.failures.length} failures`);
  for (const f of r.failures) out(`  ${f}`);
  for (const f of r.failures) flags.push(`fuzz: ${f}`);
  return r;
};

phases.long = () => {
  const { vm } = bootDriver({ instrument: true });
  call(vm, "longStart", { kind: LONG_KIND, layout: LAYOUT, viewsEvery: 10 });
  const marks = [0, 1000, 5000, 10000, 20000].filter((x) => x <= LONG);
  if (!marks.includes(LONG)) marks.push(LONG);
  const rows = [];
  let done = 0;
  const pumps = [];
  for (const m of marks) {
    while (done < m) {
      const step = Math.min(500, m - done);
      const p = [];
      for (let i = 0; i < step; i++) p.push(JSON.parse(callRaw(vm, "longStep", "{\"n\":1}")).pump.max);
      pumps.push(statOf(p));
      done += step;
    }
    const mem = memory(vm);
    const sz = call(vm, "longSizes", {});
    rows.push({ seconds: m, heap: mem.memory_used_size, props: mem.prop_count, objs: mem.obj_count, arrays: mem.array_count, strings: mem.str_count, atoms: mem.atom_count, shapes: mem.shape_count, saveBytes: sz.saveBytes, modCaches: sz.modCaches, hostMemo: sz.hostMemo, engineErrors: sz.engineErrors, sizes: sz.sizes });
    out(`  t=${String(m).padStart(6)} s  heap ${(mem.memory_used_size / 1048576).toFixed(2)} MiB  objs ${mem.obj_count}  arrays ${mem.array_count}  strings ${mem.str_count}  atoms ${mem.atom_count}  shapes ${mem.shape_count}  save ${sz.saveBytes} B  caches ${JSON.stringify(sz.modCaches)}  memo ${sz.hostMemo}  engineErr ${sz.engineErrors}`);
  }
  const first = rows[1] || rows[0];
  const growth = {};
  const last = rows[rows.length - 1];
  for (const k of Object.keys(last.sizes)) growth[k] = rows.map((r) => r.sizes[k] || 0);
  out(`  containers ≥ 8 entries (sizes at ${marks.join("/")} s):`);
  for (const [k, v] of Object.entries(growth)) out(`    ${k}: ${v.join(" → ")}`);
  const worstPump = pumps.reduce((m, p) => Math.max(m, p ? p.max : 0), 0);
  out(`  pump max over the run ${worstPump.toFixed(1)} ms; pump p95 per 500 s window: ${pumps.map((p) => p && p.p95).filter((x) => x != null).slice(-5).join(", ")} …`);
  vm.ctx.dispose(); vm.rt.dispose();
  return { kind: LONG_KIND, rows, pumps };
};

// ---------------------------------------------------------------------------------------------

out(`QuickJS-ng harness: ${results.engine}; repo ${REPO}`);
out(`budgets (ARCHITECTURE §2.5, sandbox.rs:436-444): render ${RENDER_BUDGET} ms, callbacks ${CALLBACK_BUDGET} ms, module eval ${MODULE_BUDGET} ms; flags at 50%`);
out(`note: wasm interpreter (no JIT) = conservative upper bound for herdr's quickjs-jit`);
for (const p of PHASES) {
  out(`\n######## ${p}`);
  const t0 = performance.now();
  try {
    results.phases[p] = await phases[p]();
  } catch (e) {
    out(`PHASE ${p} FAILED: ${e.stack || e}`);
    results.phases[p] = { failed: String(e.stack || e) };
    flags.push(`phase ${p} failed: ${String(e.message || e).split("\n")[0]}`);
  }
  out(`(${p}: ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
results.flags = flags;
out(`\n######## flags (${flags.length})`);
for (const f of flags) out(`  - ${f}`);
fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
out(`\nresults: ${JSON_OUT}`);
