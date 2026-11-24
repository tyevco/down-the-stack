// Mock `herdr-app check` for the mapledr mod, plus a role matrix (ARCHITECTURE §7.2).
//
//   node --import ./tools/mock/register.mjs tools/check.mjs [--main path] [--fixtures path]
//        [--role name] [--widths 360,960,1600] [--zooms 1,2] [--json] [--quiet]
//
// 0. Lint: every .js file of the mod is scanned for things QuickJS/herdr refuse (setTimeout,
//    eval, structuredClone, private #fields, static blocks, frozen-prototype writes, top-level
//    await, JSON or extension-less imports, imports from tools/ or test/) and for game/ purity (§3).
// 1. Real check, exactly as herdr runs it: checking() = true, props() = null, empty lists,
//    graphite, file permissions narrowed; module eval + constructor + init + one render.
// 2. Role matrix from the fixtures module (default tools/fixtures.mjs):
//      export const roles = [{ name, props, fixture?, world?, setup?, height?, widths?, zooms?, nowMs? }]
//    `fixture` is herdr live data (see tools/mock/samples.mjs for shapes; `files` seeds the
//    in-memory FS). `world` (object or ({nowMs, host, mod, mock}) => world) is put on
//    getHost().world from the mod's host.js before the first render; `setup({ mod, host, mock })`
//    may do anything else. For each role: init, render; then for each zoom: settings change +
//    re-render, and for each width: on_size_change (width × zoom window px), render,
//    3 × 1000 ms of timers (re-rendering when notified), re-render; finally close().
// Exit code: 0 pass, 1 errors, 2 missing inputs (main.js or the fixtures module).
//
// Also a library: `import { runCheck } from "./tools/check.mjs"` → { ok, exitCode, ... }.

import "./mock/register.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as M from "./mock/index.mjs";

const REPO = M.REPO;
export const DEFAULT_MAIN = path.join(REPO, "mods", "mapledr", "main.js");
export const DEFAULT_FIXTURES = path.join(REPO, "tools", "fixtures.mjs");
export const DEFAULT_NOW = Date.UTC(2026, 10, 24, 9, 30, 0); // a fixed Tuesday morning (UTC)
// Logical block heights (layouts/mapledr.json: stage 200, header 34, hud 26; overlays per §4).
const ROLE_HEIGHT = { stage: 200, party: 520, nameplate: 34, hud: 26, sheet: 500, herd: 520 };

const rel = (p) => path.relative(process.cwd(), p) || p;

// ---------------------------------------------------------------------------------------------
// Lint

/**
 * Blank out comments, string and regex literal bodies and template text so patterns only see
 * code. Template `${…}` expressions stay code (they nest: a template inside an expression inside a
 * template is handled with a stack). Output keeps every index and newline of the source.
 */
function codeOnly(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  const blankCh = (ch) => (ch === "\n" ? "\n" : " ");
  // Brace depth in code, and the depths at which open `${` expressions resume their template.
  let depth = 0;
  const resume = [];
  // Skip template text from i (just after "`" or after the "}" closing an expression).
  const templateText = () => {
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") { out += blankCh(src[i + 1] ?? "") === "\n" ? " \n" : "  "; i += 2; continue; }
      if (ch === "`") { out += "`"; i++; return; }
      if (ch === "$" && src[i + 1] === "{") { out += "${"; i += 2; resume.push(depth); depth++; return; }
      out += blankCh(ch); i++;
    }
  };
  // A "/" starts a regex literal (not a division) after these tokens or at the start.
  const regexAllowed = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    if ("(,=:[!&|?{};+-*%<>~^".includes(out[j])) return true;
    const word = /[A-Za-z_$]+$/.exec(out.slice(Math.max(0, j - 10), j + 1));
    return !!word && ["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"].includes(word[0]);
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && d === "*") { const end = src.indexOf("*/", i + 2); const stop = end < 0 ? n : end + 2; out += src.slice(i, stop).replace(/[^\n]/g, " "); i = stop; continue; }
    if (c === '"' || c === "'") {
      out += c; i++;
      while (i < n && src[i] !== c && src[i] !== "\n") { if (src[i] === "\\") { out += "  "; i += 2; continue; } out += " "; i++; }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    if (c === "`") { out += "`"; i++; templateText(); continue; }
    if (c === "/" && regexAllowed()) {
      out += "/"; i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        const ch = src[i];
        if (ch === "\\") { out += "  "; i += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        out += " "; i++;
      }
      if (i < n && src[i] === "/") { out += "/"; i++; }
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (resume.length && resume[resume.length - 1] === depth) { resume.pop(); out += "}"; i++; templateText(); continue; }
    }
    out += c; i++;
  }
  return out;
}

/** Indexes of `await` at module top level (brace depth 0, outside any arrow/function body). */
function topLevelAwaits(code) {
  const hits = [];
  let depth = 0;
  let stmt = 0; // start of the current top-level statement
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) stmt = i + 1; }
    else if (c === ";" && depth === 0) stmt = i + 1;
    else if (depth === 0 && c === "a" && code.startsWith("await", i) && !/[\w$]/.test(code[i - 1] ?? "") && !/[\w$]/.test(code[i + 5] ?? "")) {
      // `const f = async () => await g();` is an expression-bodied arrow, not top-level await.
      if (!/=>/.test(code.slice(stmt, i))) hits.push(i);
    }
  }
  return hits;
}

const RULES = [
  [/\b(setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/, "error", "throws in herdr; use cx.timer.after/every"],
  [/\beval\s*\(/, "error", "eval is deleted in herdr's sandbox"],
  [/\bnew\s+Function\s*\(/, "error", "the Function constructor throws in herdr"],
  [/\bstructuredClone\s*\(/, "error", "QuickJS has no structuredClone"],
  [/\bthis\.#[A-Za-z_$]|(?:^|[{;}])\s*(?:static\s+)?#[A-Za-z_$][\w$]*\s*[=;(]|#[A-Za-z_$][\w$]*\s+in\b/m, "error", "private #fields are not allowed (ARCHITECTURE §2.14)"],
  [/\bstatic\s*\{/, "error", "class static blocks are not allowed (ARCHITECTURE §2.14)"],
  [/\b(Object|Array|String|Number|Boolean|Function|Promise|Map|Set|Date|RegExp|Error)\.prototype\.[\w$]+\s*=[^=]/, "error", "built-in prototypes are frozen in herdr"],
  [/\brequire\s*\(/, "error", "require() throws in herdr; use ESM imports"],
];

function lintFile(file, modDir) {
  const src = fs.readFileSync(file, "utf8");
  const code = codeOnly(src);
  const out = [];
  const lineOf = (idx) => code.slice(0, idx).split("\n").length;
  const add = (level, idx, msg) => out.push({ level, code: "lint", message: `${rel(file)}:${lineOf(idx)}: ${msg}` });
  for (const [re, level, msg] of RULES) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of code.matchAll(g)) add(level, m.index, `${m[0].trim()} — ${msg}`);
  }
  for (const idx of topLevelAwaits(code)) add("error", idx, "await at module top level — not allowed (ARCHITECTURE §2.14); load in init/cx.spawn");
  // Imports (specifiers are string literals, so read them from the raw source).
  const importRe = /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of src.matchAll(importRe)) {
    if (code[m.index] === " ") continue; // inside a comment or string
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec.startsWith(".")) {
      if (!/\.m?js$/.test(spec)) add("error", m.index, `import "${spec}" — relative imports must name the file with its .js extension`);
      const target = path.resolve(path.dirname(file), spec);
      if (!target.startsWith(modDir + path.sep)) add("error", m.index, `import "${spec}" — reaches outside the mod folder (mods may not depend on tools/ or test/)`);
    }
    if (/\.json$/.test(spec)) add("error", m.index, `import "${spec}" — QuickJS has no JSON modules`);
  }
  if (/\bwith\s*\{\s*type\s*:/.test(code)) add("error", code.search(/\bwith\s*\{\s*type\s*:/), "import attributes are not supported");
  // game/ is the pure, deterministic engine (ARCHITECTURE §1, §3).
  const relInMod = path.relative(modDir, file).split(path.sep);
  if (relInMod[0] === "game") {
    for (const m of src.matchAll(/\bfrom\s*["'](herdr|gpui-kit|gpui|gpui-base|gpui-shell|fs\/promises)["']/g)) add("error", m.index, `game/ must not import "${m[1]}" (pure engine)`);
    for (const m of code.matchAll(/\b(Date\.now|Math\.random)\s*\(/g)) add("error", m.index, `${m[1]}() in game/ — the engine is deterministic; take time/rng from the snapshot/state`);
  }
  return out;
}

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Running copies

function collect(h, ctx, from) {
  const errs = h.errors.slice(from.e).map((e) => ({ ...e, ctx }));
  const warns = h.warnings.slice(from.w).map((w) => ({ ...w, ctx }));
  from.e = h.errors.length;
  from.w = h.warnings.length;
  return { errs, warns };
}

/** The real `herdr-app check` path. */
export async function realCheck(main) {
  M.resetState({ checking: true });
  M.resetStorage();
  const h = await M.mountMod(main, { checking: true, fixture: M.checkFixture() });
  const tree = h.view ? h.render() : null;
  const result = {
    name: "herdr-app check (props null, checking)",
    errors: [...h.errors, ...M.globalErrors()].map((e) => ({ ...e, ctx: "check" })),
    warnings: [...h.warnings, ...M.globalWarnings()].map((w) => ({ ...w, ctx: "check" })),
    renders: h.stats.renders, maxRenderMs: h.stats.maxRenderMs, nodes: h.stats.nodes,
    evalMs: h.stats.evalMs, initMs: h.stats.initMs, tree,
  };
  if (h.view && !tree && !result.errors.length) result.errors.push({ level: "error", code: "render-error", message: "render produced no tree", ctx: "check" });
  M.setChecking(false);
  return result;
}

async function applyWorld(h, role) {
  let host = null;
  if (role.world !== undefined || role.setup) {
    try {
      const hm = await h.import("./host.js");
      host = typeof hm.getHost === "function" ? hm.getHost() : null;
    } catch (e) {
      if (role.world !== undefined) M.report("warning", "no-host", `role "${role.name}": world given but mods/mapledr/host.js could not be imported (${e.message})`, { copy: h.copy });
    }
  }
  if (role.world !== undefined) {
    // `mod` lets a world builder load engine code from the mod's own module graph
    // (`await mod.import("./game/demo.js")`), so the world shares module instances with host.js.
    const world = typeof role.world === "function" ? await role.world({ nowMs: M.mockNow(), host, mod: h, mock: M }) : role.world;
    if (host && world) {
      host.world = world;
      if (typeof host.version === "number") host.version++;
    } else if (!host) {
      M.report("warning", "no-host", `role "${role.name}": world given but getHost() is not available`, { copy: h.copy });
    }
  }
  if (typeof role.setup === "function") await role.setup({ mod: h, host, mock: M });
}

/** One role through init, sizes × zooms, ticks and close. */
export async function checkRole(main, role, { widths = [360, 960, 1600], zooms = [1, 2], ticks = 3, tickMs = 1000 } = {}) {
  M.resetState({ checking: false });
  M.resetStorage();
  const nowMs = role.nowMs ?? role.fixture?.nowMs ?? DEFAULT_NOW;
  const h = await M.mountMod(main, { props: role.props ?? null, fixture: role.fixture ?? {}, nowMs });
  const result = { name: role.name, props: role.props ?? null, errors: [], warnings: [], renders: 0, maxRenderMs: 0, nodes: 0 };
  const cursor = { e: 0, w: 0 };
  const take = (ctx) => {
    const { errs, warns } = collect(h, ctx, cursor);
    result.errors.push(...errs);
    result.warnings.push(...warns);
  };
  take("load/init");
  if (h.view) {
    try {
      await applyWorld(h, role);
    } catch (e) {
      result.errors.push({ level: "error", code: "setup", message: `fixture setup threw: ${e.message}`, ctx: "setup" });
    }
    take("setup");
    h.render();
    take("first render");
    const height = role.height ?? ROLE_HEIGHT[role.props?.role] ?? 240;
    for (const zoom of role.zooms ?? zooms) {
      // herdr re-renders every copy when settings change, before layout reports the new size, so
      // the on_size_change handler that runs next is the one built under the new zoom.
      M.updateFixture({ settings: { zoom } });
      if (h.dirty) h.render();
      take(`zoom ${zoom}: settings re-render`);
      for (const width of role.widths ?? widths) {
        const ctx = `zoom ${zoom} width ${width}`;
        // `width`/`height` are the block's logical size (layout px at zoom 1); on_size_change
        // reports window px, i.e. logical × zoom, and the mod divides by settings().zoom (§6.1).
        h.size(width * zoom, height * zoom);
        h.render();
        take(`${ctx}: size+render`);
        for (let i = 0; i < ticks; i++) {
          await h.tick(tickMs);
          take(`${ctx}: tick ${i + 1}`);
        }
        h.render();
        take(`${ctx}: re-render`);
      }
    }
    await h.close();
    take("close");
  }
  result.errors.push(...M.globalErrors().map((e) => ({ ...e, ctx: "global" })));
  result.warnings.push(...M.globalWarnings().map((w) => ({ ...w, ctx: "global" })));
  result.renders = h.stats.renders;
  result.maxRenderMs = h.stats.maxRenderMs;
  result.nodes = h.stats.nodes;
  return result;
}

async function loadRoles(fixturesPath) {
  const mod = await import(pathToFileURL(fixturesPath).href);
  const roles = mod.roles ?? mod.default?.roles ?? mod.default;
  if (!Array.isArray(roles)) throw new Error(`${rel(fixturesPath)} must export \`roles\` (an array of { name, props, fixture?, world? })`);
  return roles;
}

/**
 * Run everything. Options: { main, fixtures, role, widths, zooms, ticks, tickMs, log }.
 * Returns { ok, exitCode, missing: [], lint: [...], real, roles: [...], errors, warnings }.
 */
export async function runCheck(opts = {}) {
  const main = path.resolve(opts.main ?? DEFAULT_MAIN);
  const fixturesPath = path.resolve(opts.fixtures ?? DEFAULT_FIXTURES);
  const log = opts.log ?? (() => {});
  const out = { ok: false, exitCode: 1, missing: [], lint: [], real: null, roles: [], errors: [], warnings: [] };

  if (!fs.existsSync(main)) {
    out.missing.push(main);
    out.exitCode = 2;
    log(`mock check: ${rel(main)} does not exist yet — nothing to check.`);
    return out;
  }
  const modDir = path.dirname(main);

  // 0. lint
  const files = listJs(modDir);
  for (const f of files) out.lint.push(...lintFile(f, modDir));
  out.errors.push(...out.lint.filter((l) => l.level === "error"));
  out.warnings.push(...out.lint.filter((l) => l.level !== "error"));
  log(`lint        ${files.length} files, ${out.lint.filter((l) => l.level === "error").length} errors`);

  // 1. real check
  out.real = await realCheck(main);
  out.errors.push(...out.real.errors.map((e) => ({ ...e, where: "herdr-app check" })));
  out.warnings.push(...out.real.warnings.map((w) => ({ ...w, where: "herdr-app check" })));
  log(`check       ${out.real.errors.length ? "FAIL" : "PASS"}  eval ${fmt(out.real.evalMs)}  init ${fmt(out.real.initMs)}  render ${fmt(out.real.maxRenderMs)}  ${out.real.nodes} nodes`);

  // 2. roles
  if (!fs.existsSync(fixturesPath)) {
    out.missing.push(fixturesPath);
    log(`roles       SKIPPED: ${rel(fixturesPath)} does not exist yet (export const roles = [{ name, props, fixture, world? }])`);
  } else {
    let roles = [];
    try {
      roles = await loadRoles(fixturesPath);
    } catch (e) {
      out.errors.push({ level: "error", code: "fixtures", message: `could not load ${rel(fixturesPath)}: ${e.message}`, where: "fixtures" });
    }
    if (opts.role) roles = roles.filter((r) => r.name === opts.role || r.props?.role === opts.role);
    log(`roles       ${roles.length} from ${rel(fixturesPath)}  (widths ${(opts.widths ?? [360, 960, 1600]).join("/")}, zooms ${(opts.zooms ?? [1, 2]).join("/")})`);
    for (const role of roles) {
      const r = await checkRole(main, role, opts);
      out.roles.push(r);
      out.errors.push(...r.errors.map((e) => ({ ...e, where: role.name })));
      out.warnings.push(...r.warnings.map((w) => ({ ...w, where: role.name })));
      log(`  ${pad(role.name, 22)} ${r.errors.length ? "FAIL" : "PASS"}  renders ${pad(r.renders, 3)}  max ${pad(fmt(r.maxRenderMs), 8)}  nodes ${pad(r.nodes, 4)}  ${r.errors.length} errors, ${r.warnings.length} warnings`);
    }
  }

  out.ok = out.errors.length === 0 && out.missing.length === 0;
  out.exitCode = out.errors.length ? 1 : out.missing.length ? 2 : 0;
  return out;
}

const fmt = (ms) => `${(ms ?? 0).toFixed(1)} ms`;
const pad = (s, n) => String(s).padEnd(n);

function printProblems(list, title, limit) {
  if (!list.length) return;
  console.log(`\n${title} (${list.length}${list.length > limit ? `, first ${limit}` : ""}):`);
  for (const p of list.slice(0, limit)) {
    const where = [p.where, p.ctx].filter(Boolean).join(" · ");
    console.log(`  [${p.code}] ${where ? where + ": " : ""}${p.message}`);
  }
}

async function cli(argv) {
  const opts = {};
  let json = false;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--main") opts.main = argv[++i];
    else if (a === "--fixtures") opts.fixtures = argv[++i];
    else if (a === "--role") opts.role = argv[++i];
    else if (a === "--widths") opts.widths = argv[++i].split(",").map(Number);
    else if (a === "--zooms") opts.zooms = argv[++i].split(",").map(Number);
    else if (a === "--json") json = true;
    else if (a === "--quiet") quiet = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: node --import ./tools/mock/register.mjs tools/check.mjs [--main path] [--fixtures path] [--role name] [--widths 360,960,1600] [--zooms 1,2] [--json] [--quiet]");
      return 0;
    }
  }
  if (!json) console.log("Down the Stack — mock herdr-app check\n");
  const res = await runCheck({ ...opts, log: json ? () => {} : console.log });
  if (json) {
    const slim = { ...res, real: res.real && { ...res.real, tree: undefined }, roles: res.roles };
    console.log(JSON.stringify(slim, null, 2));
    return res.exitCode;
  }
  printProblems(res.errors, "ERRORS", 200);
  if (!quiet) printProblems(res.warnings, "WARNINGS", 40);
  const verdict = res.exitCode === 0 ? "PASS" : res.exitCode === 2 && !res.errors.length ? "INCOMPLETE (missing inputs)" : "FAIL";
  console.log(`\nRESULT: ${verdict} — ${res.errors.length} errors, ${res.warnings.length} warnings${res.missing.length ? `; missing: ${res.missing.map(rel).join(", ")}` : ""}`);
  return res.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(e); process.exit(1); },
  );
}
