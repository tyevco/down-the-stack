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
    writeTextFile: [], openUrl: [], setTheme: [], presentUpdateNotes: [], watchFolder: [],
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
    focused: null, layout: null, layouts: ["main", "terminals", "win98", "mapledr"],
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

/** Reset everything (fixture, copies, calls, fs, shared, clock, errors). */
export function resetState({ checking = false } = {}) {
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

/** Resolve after `ms` real milliseconds (harness use only). */
export function realDelay(ms) {
  return new Promise((r) => realSetTimeout(r, ms));
}

setFixture({});
