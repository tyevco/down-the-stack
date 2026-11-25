// Shared state of the mock herdr runtime: the fixture (herdr's live data), the mounted mod copies,
// the "current copy" (herdr resolves host calls against the calling copy), the manual clock, the
// recorded host calls and the error/warning sink.

import { AsyncLocalStorage } from "node:async_hooks";
import { isModPath } from "./config.mjs";
import { resolveTheme } from "./theme.mjs";
import { memfs } from "./memfs.mjs";

/** The copy whose code is running (set around init/render/handlers/timers; follows awaits). */
export const als = new AsyncLocalStorage();

const realNow = Date.now.bind(Date);
export const realSetImmediate = globalThis.setImmediate.bind(globalThis);
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

export const S = {
  checking: false,
  fixture: null,
  /** Every mounted, not yet closed copy. */
  copies: [],
  /** herdr's "default policy": the most recently loaded copy answers calls made with no frame. */
  lastCopy: null,
  /** Global phase, like herdr's scope::current_phase(): "none"|"render"|"layout"|"event"|"task". */
  phase: "none",
  /** Render bookkeeping: `gen` increments per render; elements from an older gen are expired. */
  render: { gen: 0, active: false, copy: null, created: 0 },
  /** True while a mod module graph is being evaluated by mountMod (top-level code). */
  evaluating: false,
  calls: freshCalls(),
  shared: new Map(),
  clipboard: "",
  ids: { overlay: 0, notify: 0, handle: 0, copy: 0 },
  globalErrors: [],
  globalWarnings: [],
  agentOrder: null,
};

function freshCalls() {
  return {
    run: [], openOverlay: [], closeOverlay: [], notify: [], setAgentOrder: [], playSound: [],
    setWindowTitle: [], setBadge: [], setShared: [], exec: [], hc: [], readTextFile: [],
    writeTextFile: [], openUrl: [], setTheme: [], presentUpdateNotes: [], watchFolder: [], toasts: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Fixture

const DEFAULT_SETTINGS = {
  font_family: "JetBrains Mono", font_size: 14, font_weight: 500, font_weight_bold: 700,
  font_ligatures: false, terminal_line_height: 1, terminal_cell_width: 1, terminal_scroll_speed: 1,
  ui_font_family: "Geist", ui_font_size: 13, zoom: 1, theme: "graphite", theme_light: "paper",
  theme_dark: "graphite", dark: true, colors: {}, pane_scrollbars: true, terminal_padding: [10, 6],
  terminal_opacity: 1, clipboard_write: true, copy_on_select: true, minimum_contrast: 1,
  option_as_alt: "auto", sounds: { enabled: true },
};

const DEFAULT_WINDOW = { platform: "linux", titlebar: "none", buttons: true, maximized: false, fullscreen: false, active: true, visible: true };

/** The live-app defaults: empty lists, a visible window, graphite, zoom 1. */
export function defaultFixture() {
  return {
    agents: [], panes: [], terminals: [], spaces: [], machines: [{ name: null, layout: "ready" }],
    focused: null, layout: null, layouts: ["main", "terminals", "win98", "Down-the-Stack"],
    window: { ...DEFAULT_WINDOW }, placement: null, props: null,
    theme: resolveTheme("graphite"), settings: structuredClone(DEFAULT_SETTINGS),
    fonts: ["Geist", "Geist Mono", "JetBrains Mono"], keys: [], knownAgents: [],
    exec: null, // optional (command, args, options) => ExecResult
    nowMs: null,
  };
}

/** Exactly what `herdr-app check` gives a mod: null/empty everything, graphite, defaults. */
export function checkFixture() {
  return {
    ...defaultFixture(),
    agents: [], panes: [], terminals: [], spaces: [], machines: [],
    focused: null, layout: null, window: null, placement: null, props: null, fonts: [],
  };
}

/** Replace the fixture: defaults + the given fields. theme/settings merge over the defaults. */
export function setFixture(fx = {}) {
  const base = S.checking ? checkFixture() : defaultFixture();
  S.fixture = mergeFixture(base, fx);
  return S.fixture;
}

function mergeFixture(base, fx) {
  const out = { ...base, ...fx };
  if (fx.theme && typeof fx.theme === "object") out.theme = { ...base.theme, ...fx.theme };
  if (typeof fx.theme === "string") out.theme = resolveTheme(fx.theme);
  if (fx.settings) out.settings = { ...base.settings, ...fx.settings };
  // The shown layout's root `colors` join herdr's theme map, custom names included
  // (settings.rs: colors.extend(look.colors); layout.md §0.6), so `theme().mdr_gold` works
  // while the layout shows. Names the fixture's own theme map sets explicitly win.
  const lc = out.layout && typeof out.layout === "object" ? out.layout.colors : null;
  if (lc && typeof lc === "object") {
    const explicit = fx.theme && typeof fx.theme === "object" ? fx.theme : {};
    const extra = {};
    for (const [k, v] of Object.entries(lc)) if (typeof v === "string" && v.startsWith("#") && !(k in explicit)) extra[k] = v;
    out.theme = { ...out.theme, ...extra };
  }
  if (fx.files) for (const [p, text] of Object.entries(fx.files)) memfs.write(p, text, { mkdirs: true });
  if (fx.shared) for (const [k, v] of Object.entries(fx.shared)) S.shared.set(k, structuredClone(v));
  return out;
}

/**
 * Merge changes into the live fixture (like herdr publishing new live data). Copies that read a
 * changed key (agents, panes, ...) are marked dirty; settings/theme changes dirty every copy.
 * Returns the copies that would re-render.
 */
export function updateFixture(partial = {}) {
  if (!S.fixture) setFixture({});
  S.fixture = mergeFixture(S.fixture, partial);
  const keys = Object.keys(partial);
  const all = keys.some((k) => k === "settings" || k === "theme");
  const dirty = S.copies.filter((c) => all || keys.some((k) => c.liveReads.has(k)));
  for (const c of dirty) c.dirty = true;
  return dirty;
}

export function fixture() {
  if (!S.fixture) setFixture({});
  return S.fixture;
}

export function setChecking(on) {
  S.checking = !!on;
}

// ---------------------------------------------------------------------------------------------
// Per-VM globals. herdr runs one QuickJS VM per window: globalThis survives a hot reload (a mod
// may hand state to its next build through it) but not a VM restart, and two windows never see
// each other's. Node has one globalThis, so the mock keeps `globalThis[Symbol.for("<mod>.…")]`
// (registered symbols named after a mounted mod) per VM. A proxy in globalThis's prototype chain
// answers reads and writes of those symbols (they are never own properties of globalThis) from the
// VM of the copy whose code is running: the async context (`als`, which follows a load's awaits
// across timers and other VMs' work), else the VM entered last (mount, reload: module evaluation).
// A mount on a fresh graph starts with none; a reload, or a mount into an existing graph, sees that
// VM's own. The mock's own `Symbol.for("<mod>.mock.…")` hooks stay ordinary globals.

const VM_STORE = new Map(); // `${mod}|${vm}` -> Map(symbol -> value)
const VM_MODS = new Set();
const VM_SHOWN = new Map(); // modName -> the VM entered last (module evaluation, no copy running)
/** The mounted mod a registered symbol belongs to, or null (not per VM). */
function vmModOf(key) {
  if (typeof key !== "symbol") return null;
  const k = Symbol.keyFor(key);
  if (typeof k !== "string") return null;
  for (const mod of VM_MODS) if (k.startsWith(`${mod}.`) && !k.startsWith(`${mod}.mock.`)) return mod;
  return null;
}
/** The per-VM store a read or write of `mod`'s symbol goes to now. */
function vmStore(mod) {
  const copy = als.getStore();
  const h = copy && copy.modName === mod ? copy.handle : null;
  const vm = h ? h.vm ?? h.graph : VM_SHOWN.get(mod);
  const key = `${mod}|${vm}`;
  let m = VM_STORE.get(key);
  if (!m) VM_STORE.set(key, (m = new Map()));
  return m;
}
const vmProto = Object.getPrototypeOf(globalThis);
Object.setPrototypeOf(globalThis, new Proxy(vmProto, {
  get(t, k, r) { const mod = vmModOf(k); return mod ? vmStore(mod).get(k) : Reflect.get(t, k, r); },
  set(t, k, v, r) {
    const mod = r === globalThis ? vmModOf(k) : null;
    if (!mod) return Reflect.set(t, k, v, r);
    vmStore(mod).set(k, v);
    return true;
  },
  has(t, k) { const mod = vmModOf(k); return mod ? vmStore(mod).has(k) : Reflect.has(t, k); },
}));
/** Own properties a mod defined directly (Object.defineProperty) move into the VM shown now. */
function adoptOwn(mod) {
  for (const sym of Object.getOwnPropertySymbols(globalThis)) {
    if (vmModOf(sym) !== mod) continue;
    const d = Object.getOwnPropertyDescriptor(globalThis, sym);
    if (!d || d.configurable === false) continue;
    const v = globalThis[sym];
    delete globalThis[sym];
    vmStore(mod).set(sym, v);
  }
}
/** Code with no copy running (module evaluation) sees VM `vm`'s per-VM globals of mod `modName`. */
export function enterVm(vm, modName) {
  VM_MODS.add(modName);
  VM_SHOWN.set(modName, vm);
  adoptOwn(modName);
}
/** (Kept for callers: the per-VM store needs no copying when a mount or reload is done.) */
export function leaveVm(vm, modName) {
  if (VM_SHOWN.get(modName) === vm) adoptOwn(modName);
}
function resetVmGlobals() {
  for (const mod of VM_MODS) {
    for (const sym of Object.getOwnPropertySymbols(globalThis)) {
      if (vmModOf(sym) === mod && Object.getOwnPropertyDescriptor(globalThis, sym)?.configurable !== false) delete globalThis[sym];
    }
  }
  VM_STORE.clear();
  VM_SHOWN.clear();
}

/** Reset everything (fixture, copies, calls, fs, shared, clock, errors, per-VM globals). */
export function resetState({ checking = false } = {}) {
  resetVmGlobals();
  for (const c of S.copies) c.alive = false;
  S.copies = [];
  S.lastCopy = null;
  S.phase = "none";
  S.render = { gen: S.render.gen + 1, active: false, copy: null, created: 0 };
  S.evaluating = false;
  S.calls = freshCalls();
  S.shared = new Map();
  S.clipboard = "";
  S.globalErrors = [];
  S.globalWarnings = [];
  S._seen = new Set(); // report() dedupe for global problems; must not outlive a reset
  S.agentOrder = null;
  S.checking = checking;
  memfs.reset();
  clock.timers = [];
  clock.offset = 0;
  clock.frozen = null;
  S.fixture = null;
  setFixture({});
}

// ---------------------------------------------------------------------------------------------
// Copies and reporting

/** Push a command into one copy's nextCommand() queue. */
export function deliver(copy, cmd) {
  if (copy.waiters.length) copy.waiters.shift()(cmd);
  else copy.queue.push(cmd);
}

export function currentCopy() {
  return als.getStore() ?? S.lastCopy;
}

/**
 * Record a problem. level "error" | "warning". `code` classifies it (e.g. "missing-image").
 * Goes to the current copy (or the given one), else to the global lists.
 */
export function report(level, code, message, { copy = als.getStore() ?? S.render.copy ?? null, phase = S.phase, stack } = {}) {
  const entry = { level, code, message, phase, copy: copy?.label ?? null };
  if (stack) entry.stack = stack;
  const list = copy ? (level === "error" ? copy.errors : copy.warnings) : (level === "error" ? S.globalErrors : S.globalWarnings);
  // Keep reports readable: the same problem from every render is reported once per copy.
  const key = `${code}|${message}`;
  const seen = copy ? copy.seen : (S._seen ??= new Set());
  if (seen.has(key)) return entry;
  seen.add(key);
  list.push(entry);
  return entry;
}

// ---------------------------------------------------------------------------------------------
// Manual clock: Date.now() and every cx timer run on it.

export const clock = {
  /** Fixed epoch (ms) when frozen; null = real time. */
  frozen: null,
  /** Added to the base by advanceTimers(). */
  offset: 0,
  /** Pending timers: { due, seq, ms, fn, every, copy, task } */
  timers: [],
  seq: 0,
};

export function mockNow() {
  return (clock.frozen ?? realNow()) + clock.offset;
}

/** Freeze Date.now() at `ms` (deterministic), or pass null to follow real time again. */
export function setClock(ms) {
  clock.frozen = ms == null ? null : Number(ms);
  clock.offset = 0;
}

// Date.now() is what mods use to measure time (ARCHITECTURE §2.4), so it follows the mock clock.
// `new Date()` without arguments stays real time.
Date.now = mockNow;

// ---------------------------------------------------------------------------------------------
// herdr's throwing globals: setTimeout & co. throw a TypeError naming the replacement. Node needs
// the real ones, so only calls made directly from mod code (a file under a mods/ folder) throw.

function callerFile(skipFn) {
  const holder = {};
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 3;
  Error.captureStackTrace(holder, skipFn);
  Error.stackTraceLimit = limit;
  const line = String(holder.stack ?? "").split("\n")[1] ?? "";
  return line;
}

function guardGlobal(name, hint) {
  const real = globalThis[name];
  if (typeof real !== "function" || real.__mockGuarded) return;
  const wrapped = function (...args) {
    if (isModPath(callerFile(wrapped))) {
      const e = new TypeError(`${name} is not available in herdr mods; ${hint}`);
      e.code = "forbidden-global";
      report("error", "forbidden-global", e.message);
      throw e;
    }
    return real.apply(this, args);
  };
  wrapped.__mockGuarded = true;
  Object.defineProperty(wrapped, "name", { value: name });
  for (const k of Object.keys(real)) { try { wrapped[k] = real[k]; } catch { /* ignore */ } }
  if (real[Symbol.for("nodejs.util.promisify.custom")]) wrapped[Symbol.for("nodejs.util.promisify.custom")] = real[Symbol.for("nodejs.util.promisify.custom")];
  globalThis[name] = wrapped;
}

guardGlobal("setTimeout", "use cx.timer.after(ms, (cx) => ...)");
guardGlobal("setInterval", "use cx.timer.every(ms, (cx) => ...)");
guardGlobal("clearTimeout", "cancel the task returned by cx.timer.after/every");
guardGlobal("clearInterval", "cancel the task returned by cx.timer.every");
guardGlobal("structuredClone", "QuickJS has no structuredClone (ARCHITECTURE §2.14); copy explicitly");
// eval / new Function are not wrapped (that would change direct-eval semantics); check.mjs lints for them.

/** Let pending promise callbacks and async continuations run. */
export async function flush(rounds = 3) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => realSetImmediate(r));
}

/**
 * A budget clock a busy machine cannot fail: `ms()` is the lower of the wall time since it started
 * and this process's CPU time over the same span. Waiting for a CPU (parallel test files, a browser
 * taking screenshots, another fixer's build) adds wall time but no CPU time; GC or loader threads
 * can add CPU time, but never more than the wall time the call took. Work the script really does
 * counts in both, so a callback that is slow on an idle machine is still over its budget.
 */
export function stopwatch() {
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  return {
    wall: () => performance.now() - t0,
    ms() {
      const wall = performance.now() - t0;
      const c = process.cpuUsage(c0);
      return Math.min(wall, (c.user + c.system) / 1000);
    },
  };
}

/** Resolve after `ms` real milliseconds (harness use only). */
export function realDelay(ms) {
  return new Promise((r) => realSetTimeout(r, ms));
}

setFixture({});
