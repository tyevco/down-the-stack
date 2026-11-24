// Lifecycle driver: mounts a mod (or a View class) the way herdr does, renders it, runs its timers
// on the manual clock, fires handlers, and checks every finished tree.
//
//   const mod = await mountMod("mods/mapledr/main.js", { props: { role: "stage" }, fixture });
//   const tree = mod.render();          // serialisable tree (null if render threw)
//   mod.size(960, 210);                 // on_size_change on the root
//   await mod.tick(1000);               // advance timers 1 s (re-renders if notified)
//   mod.fire("hero-1");                 // on_click on the element with .id("hero-1"), bubbling
//   mod.errors / mod.warnings           // everything the validator found

import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { S, als, report, setFixture, fixture, setChecking, setClock, flush, realDelay, deliver, clock, enterVm, leaveVm } from "./state.mjs";
import { assetRoots, setAssetRoot, resolveAsset } from "./config.mjs";
import { NODE, isElement, textNode, serialize, Node } from "./elements.mjs";
import { View, construct, makeCx, withPhase, advanceTimers } from "./view.mjs";
import { mockError } from "./validate.mjs";
import "./globals.mjs";

/**
 * herdr's budgets (ms), plus the mock's warning thresholds (renderWarn, moduleWarn, elements).
 * Module evaluation runs inside the Task scope herdr opens around every load (plugin.rs
 * load_view_with_policy → ScopePhase::Task; scope.rs enter_application keeps that phase), and the
 * interrupt handler gives Task the event budget, 500 ms (sandbox.rs), not the 5 s "detached" one.
 */
export const BUDGET = { render: 50, renderWarn: 10, event: 500, init: 500, module: 500, moduleWarn: 150, close: 250, elements: 400 };
const LIST_CAP = 200;
let graphSeq = 0;

function newCopy({ modName, props, label }) {
  const id = ++S.ids.copy;
  const copy = {
    id, label: label ?? `${modName}#${id}`, modName, props: props ?? null,
    alive: true, view: null, errors: [], warnings: [], seen: new Set(),
    dirty: true, notifies: 0, liveReads: new Set(), queue: [], waiters: [], tasks: new Set(),
    renders: 0, renderMs: [], handle: null,
  };
  S.copies.push(copy);
  S.lastCopy = copy;
  return copy;
}

function recordThrow(copy, e, phase) {
  const msg = e?.message ?? String(e);
  report("error", e?.code ?? `${phase}-error`, `${phase}: ${msg}`, { copy, phase, stack: e?.stack });
}

/** Does a node set a definite size on an axis ("w" or "h")? */
function sizeSet(node, axis) {
  let set = false;
  for (const [name, args] of node.methods) {
    const generic = name === "size" || name === "min_size" || name.startsWith("size_");
    if (name === axis || generic || name.startsWith(axis + "_")) {
      const auto = name.endsWith("_auto") || args[0] === "auto";
      set = !auto;
    }
  }
  return set;
}

/** Asset verdicts per path: [level, code, message] or null. Cached: renders stay cheap. */
const assetVerdicts = new Map();
function assetVerdict(src) {
  if (assetVerdicts.has(src)) return assetVerdicts.get(src);
  let v = null;
  const r = resolveAsset(src);
  let st = null;
  if (r.real) { try { st = fs.statSync(r.real); } catch { st = null; } }
  if (r.error) v = ["error", "missing-image", r.error];
  else if (!st || !st.isFile()) v = ["error", "missing-image", `file not found (looked for ${r.real})`];
  else if (st.size > 16 * 1024 * 1024) v = ["error", "missing-image", "larger than 16 MiB; herdr refuses it"];
  else if (r.real.endsWith(".svg") && /<text[\s>]/.test(fs.readFileSync(r.real, "utf8"))) {
    v = ["warning", "svg-text", "the SVG uses <text>; fonts are not guaranteed in herdr's SVG renderer (ARCHITECTURE §2.9)"];
  }
  assetVerdicts.set(src, v);
  return v;
}
/** Forget cached asset verdicts (after art was regenerated). */
export function clearAssetCache() { assetVerdicts.clear(); }

function checkAssetFile(node) {
  const v = assetVerdict(node.src);
  if (v) report(v[0], v[1], `${node.type}("${node.src}"): ${v[2]}`);
}

export class Mounted {
  constructor(copy, opts = {}) {
    this.copy = copy;
    copy.handle = this;
    this.opts = opts;
    this.graph = null;
    /** VM identity: copies on one VM share module scope and globals; it survives reload(). */
    this.vm = null;
    this.mainPath = null;
    this.module = null;
    /** last good live Node tree / serialised tree */
    this.live = null;
    this.tree = null;
    this.size_ = null;
    this.stats = { renders: 0, lastRenderMs: 0, maxRenderMs: 0, nodes: 0, elements: 0, created: 0, evalMs: 0, initMs: 0 };
  }

  get view() { return this.copy.view; }
  get errors() { return this.copy.errors; }
  get warnings() { return this.copy.warnings; }
  get ok() { return this.copy.errors.length === 0; }
  get props() { return this.copy.props; }
  get dirty() { return this.copy.dirty; }

  // ---------------------------------------------------------------------------------------
  // render

  render() {
    const copy = this.copy;
    if (!copy.alive) throw new Error(`${copy.label} is closed`);
    if (!copy.view) return null;
    S.render.gen++;
    S.render.active = true;
    S.render.copy = copy;
    S.render.created = 0;
    S.render.views = new Set();
    let root = null;
    let failed = false;
    this._spent = 0;
    try {
      const out = this._renderView(copy.view);
      root = this._root(out, "render()");
      this._finalize(root);
    } catch (e) {
      failed = true;
      recordThrow(copy, e, "render");
    } finally {
      S.render.active = false;
      S.render.copy = null;
    }
    // Script time only (the view's render() and nested views' renders), not the mock's checks.
    const ms = this._spent;
    copy.renders++;
    copy.renderMs.push(ms);
    this.stats.renders++;
    this.stats.lastRenderMs = ms;
    this.stats.maxRenderMs = Math.max(this.stats.maxRenderMs, ms);
    this.stats.created = S.render.created;
    if (ms > BUDGET.render) report("error", "budget", `render took ${ms.toFixed(1)} ms (herdr's budget is ${BUDGET.render} ms)`, { copy, phase: "render" });
    else if (ms > BUDGET.renderWarn) report("warning", "slow-render", `render took ${ms.toFixed(1)} ms under V8; QuickJS interprets several times slower than that and herdr's budget is ${BUDGET.render} ms`, { copy, phase: "render" });
    if (failed) return null; // herdr keeps the last good snapshot (with an error banner)
    copy.dirty = false;
    this.live = root;
    this.tree = serialize(root);
    let n = 0, els = 0;
    walkLive(root, (x) => { n++; if (x.type !== "text" && x.type !== "view") els++; });
    this.stats.nodes = n;
    this.stats.elements = els;
    if (els > BUDGET.elements) report("warning", "many-elements", `one render built ${els} elements (ARCHITECTURE §7.4 budgets 400 per stage render; every redraw rebuilds the window)`, { copy });
    return this.tree;
  }

  _renderView(view) {
    const { cx, scope } = makeCx(this.copy, "render");
    const t0 = performance.now();
    try {
      return als.run(this.copy, () => withPhase("render", () => view.render(cx)));
    } finally {
      scope.live = false;
      this._spent = (this._spent ?? 0) + performance.now() - t0;
    }
  }

  _root(out, what) {
    if (isElement(out)) {
      const node = out[NODE];
      if (node.gen !== S.render.gen) throw mockError("expired-element", `${what} returned an element from a previous render pass; elements are single-use values and must be rebuilt each time render runs`);
      if (node.parent) throw mockError("reused-element", `${what} returned an element that was already added to a parent`);
      return node;
    }
    if (typeof out === "string") return textNode(out);
    if (out && out.__entity) {
      const v = new Node("view");
      v.entity = out;
      return v;
    }
    throw mockError("bad-render", `${what} must return an element, an entity from cx.new() or a string; got ${out === null ? "null" : typeof out}`);
  }

  /** Expand lists and child views, then validate every node of the finished tree. */
  _finalize(root) {
    const copy = this.copy;
    const ids = new Map();
    const visit = (node) => {
      if (node.type === "text") return;
      if (node.type === "view") return this._expandView(node, visit);
      if (node.list) this._expandList(node);
      if (node.id != null) {
        if (ids.has(node.id)) report("warning", "duplicate-id", `.id("${node.id}") is used by more than one element in one render; transitions and clicks may land on the wrong one`, { copy });
        ids.set(node.id, node);
      }
      if (node.type === "image" || node.type === "svg") {
        if (!sizeSet(node, "w") || !sizeSet(node, "h")) {
          report("error", "image-size", `${node.type}("${node.src}") needs both .w() and .h() (or .size()); otherwise it draws at its raw intrinsic size, not zoom-scaled`, { copy });
        }
        checkAssetFile(node);
      }
      const hasFrames = node.methods.some((m) => m[0] === "frames");
      if (hasFrames && node.children.length) report("warning", "frames-children", `frames() replaces the element's children; ${node.children.length} child(ren) of ${describeNode(node)} are dropped`, { copy });
      const animated = node.methods.some((m) => m[0] === "transition" || m[0] === "spring");
      if (animated && node.id == null) report("warning", "transition-no-id", `${describeNode(node)} has transition()/spring() but no .id(); its animation state is keyed by creation order and will jump`, { copy });
      for (const c of node.children.slice()) visit(c);
      for (const c of Object.values(node.slots)) visit(c);
    };
    als.run(copy, () => visit(root));
  }

  _expandView(node, visit) {
    const ent = node.entity;
    if (ent.__released) throw mockError("released-entity", "a released Entity was mounted with .child()");
    if (S.render.views.has(ent)) throw mockError("duplicate-child-view", "a child view handle can be mounted only once in one snapshot; create a second Entity for a second position");
    S.render.views.add(ent);
    const out = this._renderView(ent.__view);
    const sub = this._root(out, "a child view's render()");
    sub.parent = node;
    node.children = [sub];
    visit(sub);
  }

  _expandList(node) {
    const L = node.list;
    const n = Math.min(L.count, LIST_CAP);
    const { cx, scope } = makeCx(this.copy, "render");
    try {
      withPhase("layout", () => {
        const add = (el, i) => {
          if (!isElement(el)) throw mockError("bad-child", `${node.type} item ${i} rendered ${el === null ? "null" : typeof el}, not an element`);
          const c = el[NODE];
          if (c.parent) throw mockError("reused-element", `${node.type} item ${i} was already added to a parent`);
          c.parent = node;
          node.children.push(c);
        };
        for (let i = 0; i < n; i++) {
          const key = L.getKey(i);
          if (typeof key !== "string") report("error", "list-key", `${node.type}("${node.id}") get_key(${i}) returned ${typeof key}; it must return a stable string key`);
        }
        if (L.perItem) {
          for (let i = 0; i < n; i++) add(L.render(i, cx), i);
        } else {
          const out = L.render({ start: 0, end: n }, cx);
          if (!Array.isArray(out)) throw mockError("bad-child", `${node.type}("${node.id}") render(range, cx) must return an array of elements`);
          out.forEach(add);
        }
      });
    } finally {
      scope.live = false;
    }
    if (L.count > LIST_CAP) node.methods.push(["__mock_list_truncated", [L.count]]);
  }

  // ---------------------------------------------------------------------------------------
  // queries

  /** Live Node with this .id() in the last good render (or null). */
  node(id) {
    let found = null;
    if (this.live) walkLive(this.live, (n) => { if (!found && n.id === id) found = n; });
    return found;
  }
  /** Serialised node with this .id() in the last good render (or null). */
  find(id) { const n = this.node(id); return n ? serialize(n) : null; }
  /** Every live node matching a predicate. */
  findAll(pred) { const out = []; if (this.live) walkLive(this.live, (n) => { if (pred(n)) out.push(n); }); return out; }
  /** Concatenated text of the whole last tree (for assertions). */
  text() { const parts = []; if (this.live) walkLive(this.live, (n) => { if (n.type === "text") parts.push(n.text); }); return parts.join(" "); }

  // ---------------------------------------------------------------------------------------
  // events

  /**
   * Fire a handler like herdr would. `target` is an .id() string or a live Node.
   * kind: "click" (default), "mouse_down" / "mouse_up" (event.button, default "left"), "hover",
   * "key_down", "key_up", "scroll_wheel", "mouse_move", "size_change", "action:<name>", or a raw
   * handler name such as "on_drop". Pointer and key events bubble to ancestors until a handler
   * calls cx.stop_propagation(). Returns { called, stopped }.
   */
  fire(target, event, kind = "click") {
    const node = typeof target === "string" ? this.node(target) : target;
    if (!node) throw new Error(`fire: no element with .id("${target}") in the last render of ${this.copy.label}`);
    let key = kind.startsWith("on_") ? kind : kind.startsWith("action:") ? `on_action:${kind.slice(7)}` : `on_${kind}`;
    let evt = event;
    const mods = { shift: false, control: false, alt: false, platform: false, function: false };
    if (key === "on_click") evt = { click_count: 1, modifiers: mods, ...(event ?? {}) };
    else if (key === "on_mouse_down" || key === "on_mouse_up") {
      key = `${key}:${event?.button ?? "left"}`;
      evt = { button: "left", click_count: 1, position: { x: 0, y: 0 }, modifiers: mods, ...(event ?? {}) };
    } else if (key === "on_hover") evt = event ?? true;
    else if (key === "on_key_down" || key === "on_key_up") evt = { key: "", keystroke: "", modifiers: mods, ...(typeof event === "string" ? { key: event, keystroke: event } : event ?? {}) };
    const bubbles = /^on_(click|mouse_down|mouse_up|mouse_move|scroll_wheel|key_down|key_up|action)/.test(key);
    const chain = [];
    for (let n = node; n; n = n.parent) { chain.push(n); if (!bubbles) break; }
    let called = 0;
    let stopped = false;
    for (const n of chain) {
      if (key === "on_click" && n.methods.some((m) => m[0] === "disabled" && m[1][0])) continue;
      for (const fn of n.handlers[key] ?? []) {
        called++;
        if (this._callHandler(fn, evt, key)) stopped = true;
      }
      if (stopped) break;
    }
    return { called, stopped };
  }

  _callHandler(fn, evt, key) {
    const copy = this.copy;
    const { cx, scope } = makeCx(copy, "event");
    const t0 = performance.now();
    try {
      const r = als.run(copy, () => withPhase("event", () => fn(evt, cx)));
      if (r && typeof r.then === "function") r.catch((e) => recordThrow(copy, e, `event ${key}`));
    } catch (e) {
      // herdr logs a throwing handler and carries on
      recordThrow(copy, e, `event ${key}`);
    } finally {
      scope.live = false;
    }
    const ms = performance.now() - t0;
    if (ms > BUDGET.event) report("error", "budget", `${key} handler took ${ms.toFixed(1)} ms (budget ${BUDGET.event} ms)`, { copy });
    return scope.stopped;
  }

  hover(target, on = true) { return this.fire(target, on, "hover"); }

  /**
   * Report a size through on_size_change (logical window px, as herdr does: a mod divides by
   * settings().zoom). Targets the root unless { id } is given. Returns the number of handlers run.
   */
  size(width, height, { id } = {}) {
    this.size_ = { width, height };
    const node = id ? this.node(id) : this.live;
    if (!node) return 0;
    const fns = node.handlers.on_size_change ?? [];
    for (const fn of fns) this._callHandler(fn, { width, height }, "on_size_change");
    return fns.length;
  }

  /** Deliver a key command to this copy's nextCommand() (like keys.json "<mod>:<command>"). */
  async command(name) {
    deliver(this.copy, name);
    await flush();
  }

  // ---------------------------------------------------------------------------------------
  // time

  /** Advance the clock `ms`, running due timers; re-render if this copy was notified. */
  async tick(ms = 1000, { render = true } = {}) {
    const fired = await advanceTimers(ms, { flush, budgetMs: BUDGET.event });
    await flush();
    let rendered = false;
    if (render && this.copy.alive && this.copy.dirty && !this.copy.hidden) {
      this.render();
      rendered = true;
    }
    return { fired, rendered };
  }

  async flush() { await flush(); }

  /** Import another file of this mod from the same module graph (e.g. "./host.js"). */
  async import(rel) {
    if (!this.mainPath) throw new Error("import(): this copy was mounted from a class, not a file");
    const url = pathToFileURL(path.resolve(path.dirname(this.mainPath), rel)).href + (this.graph != null ? `?mockgen=${this.graph}` : "");
    return import(url);
  }

  // ---------------------------------------------------------------------------------------
  // lifecycle

  async close() {
    const copy = this.copy;
    if (!copy.alive) return;
    const view = copy.view;
    if (view && typeof view.close === "function") {
      const { cx } = makeCx(copy, "async");
      try {
        const r = als.run(copy, () => withPhase("event", () => view.close(cx)));
        if (r && typeof r.then === "function") {
          const timedOut = await Promise.race([r.then(() => false), realDelay(BUDGET.close).then(() => true)]);
          if (timedOut) report("error", "budget", `close() took longer than ${BUDGET.close} ms`, { copy });
        }
      } catch (e) {
        recordThrow(copy, e, "close");
      }
    }
    this._release();
  }

  _release() {
    // Timers and tasks die with the copy, and the clock lets go of their callbacks.
    for (const t of this.copy.tasks) { t.cancelled = true; t.done = true; }
    clock.timers = clock.timers.filter((t) => t.copy !== this.copy);
    this.copy.alive = false;
    S.copies = S.copies.filter((c) => c !== this.copy);
    if (S.lastCopy === this.copy) S.lastCopy = S.copies[S.copies.length - 1] ?? null;
  }

  /**
   * Hot reload of this copy alone: re-evaluate the module graph, init a new instance, then cancel
   * the old tasks (no close()). herdr reloads every copy of a mod together into one new module
   * scope: use reloadAll(handles) for that.
   */
  async reload() {
    await reloadAll([this]);
    return this;
  }

  /** Hide or show this copy: hidden copies keep their timers but neither render nor get `<mod>.<command>`. */
  hide(on = true) {
    this.copy.hidden = !!on;
    if (!on) this.copy.dirty = true; // herdr draws a copy that shows again
    return this;
  }
}

function describeNode(n) {
  return `${n.type}${n.id != null ? `#${n.id}` : ""}${n.src ? `("${n.src}")` : ""}`;
}

/** Walk a live tree including slots and nested views. */
export function walkLive(node, fn) {
  fn(node);
  for (const c of node.children) walkLive(c, fn);
  for (const c of Object.values(node.slots)) walkLive(c, fn);
}

/**
 * Hot reload, as herdr does it when a mod's file is saved: the new code is evaluated once (one new
 * module scope, shared by every copy, as herdr caches it per source revision), each copy gets a
 * new instance, then each copy's old tasks and timers are cancelled without close(). `handles`
 * should be every copy of one VM (pass the ones the test cares about).
 */
export async function reloadAll(handles) {
  const list = handles.filter((h) => h && h.copy.alive);
  for (const h of list) if (!h.mainPath) throw new Error("reload(): this copy was mounted from a class, not a file");
  if (!list.length) return;
  const graph = `g${++graphSeq}`;
  const vm = list[0].vm ?? list[0].graph;
  const modName = list[0].copy.modName;
  enterVm(vm, modName);
  const old = list.map((h) => {
    const tasks = new Set(h.copy.tasks);
    h.copy.tasks = new Set();
    return tasks;
  });
  try {
    for (const h of list) {
      h.graph = graph;
      h.vm = vm;
      await loadInto(h, h.mainPath, graph);
    }
  } finally {
    leaveVm(vm, modName);
  }
  list.forEach((h, i) => {
    for (const t of old[i]) { t.cancelled = true; t.done = true; }
    clock.timers = clock.timers.filter((t) => !old[i].has(t.task));
  });
  await flush();
}

async function loadInto(handle, abs, graph) {
  const copy = handle.copy;
  const url = pathToFileURL(abs).href + (graph != null ? `?mockgen=${graph}` : "");
  S.lastCopy = copy;
  S.evaluating = true;
  const t0 = performance.now();
  let mod;
  try {
    mod = await import(url);
  } catch (e) {
    recordThrow(copy, e, "load");
    return false;
  } finally {
    S.evaluating = false;
  }
  handle.stats.evalMs = performance.now() - t0;
  // (Node caches a graph's modules: only the copy that evaluated it measures real work.)
  if (handle.stats.evalMs > BUDGET.module) report("error", "budget", `module evaluation took ${handle.stats.evalMs.toFixed(0)} ms (herdr's budget is ${BUDGET.module} ms: it runs inside the load's Task scope)`, { copy });
  else if (handle.stats.evalMs > BUDGET.moduleWarn) report("warning", "slow-module", `module evaluation took ${handle.stats.evalMs.toFixed(0)} ms under V8; QuickJS interprets several times slower and herdr's budget is ${BUDGET.module} ms`, { copy });
  handle.module = mod;
  const Class = mod.default;
  if (typeof Class !== "function" || !(Class.prototype instanceof View)) {
    report("error", "no-view", `load: the default export of ${path.relative(process.cwd(), abs)} must be a class that extends View (from "gpui-kit")`, { copy });
    return false;
  }
  return instantiate(handle, Class);
}

async function instantiate(handle, Class) {
  const copy = handle.copy;
  let view;
  try {
    view = als.run(copy, () => withPhase("event", () => construct(Class)));
  } catch (e) {
    recordThrow(copy, e, "constructor");
    return false;
  }
  const { cx } = makeCx(copy, "async");
  const t0 = performance.now();
  try {
    // herdr passes `undefined` as a root view's init props; mods read props() instead.
    const r = typeof view.init === "function" ? als.run(copy, () => withPhase("event", () => view.init(undefined, cx))) : undefined;
    if (r && typeof r.then === "function") r.catch((e) => recordThrow(copy, e, "init (async)"));
  } catch (e) {
    recordThrow(copy, e, "init");
    copy.view = null;
    return false;
  }
  handle.stats.initMs = performance.now() - t0;
  if (handle.stats.initMs > BUDGET.init) report("error", "budget", `init took ${handle.stats.initMs.toFixed(1)} ms (budget ${BUDGET.init} ms)`, { copy });
  copy.view = view;
  copy.dirty = true;
  await flush();
  return true;
}

function prepare(opts) {
  if (opts.checking !== undefined) setChecking(opts.checking);
  if (opts.fixture !== undefined) setFixture(opts.fixture);
  const nowMs = opts.nowMs ?? opts.fixture?.nowMs;
  if (nowMs != null) setClock(nowMs);
}

/**
 * Mount a mod's main.js as one copy.
 * opts: { props, fixture, checking, nowMs, name, label, graph }
 *  - props: this copy's props() (default fixture.props; always null while checking)
 *  - fixture: replaces the live data (state.setFixture) before mounting
 *  - graph: module-graph key. Copies mounted with the same key share module scope (like herdr's one
 *    VM); by default every mount gets a fresh graph (like a VM restart). `handle.graph` is the key.
 */
export async function mountMod(mainPath, opts = {}) {
  prepare(opts);
  const abs = path.resolve(mainPath);
  const modName = opts.name ?? path.basename(path.dirname(abs));
  if (!assetRoots.has(`mods/${modName}`)) setAssetRoot(`mods/${modName}`, path.dirname(abs));
  const props = S.checking ? null : opts.props !== undefined ? opts.props : fixture().props ?? null;
  const copy = newCopy({ modName, props, label: opts.label });
  const handle = new Mounted(copy, opts);
  handle.mainPath = abs;
  handle.graph = opts.graph ?? `g${++graphSeq}`;
  // a graph seen before is that VM (its copies' reloads may have moved its graph key along)
  handle.vm = mounted().find((h) => h !== handle && (h.graph === handle.graph || h.vm === handle.graph))?.vm ?? handle.graph;
  enterVm(handle.vm, modName);
  try {
    await loadInto(handle, abs, handle.graph);
  } finally {
    leaveVm(handle.vm, modName);
  }
  return handle;
}

/** Mount a View class directly (no file). opts as mountMod, plus name (default "mapledr"). */
export async function mountView(Class, opts = {}) {
  prepare(opts);
  const modName = opts.name ?? "mapledr";
  const props = S.checking ? null : opts.props !== undefined ? opts.props : fixture().props ?? null;
  const copy = newCopy({ modName, props, label: opts.label });
  const handle = new Mounted(copy, opts);
  if (typeof Class !== "function" || !(Class.prototype instanceof View)) {
    report("error", "no-view", "mountView(Class): Class must extend View", { copy });
    return handle;
  }
  await instantiate(handle, Class);
  return handle;
}

/** Every mounted copy's handle. */
export function mounted() {
  return S.copies.map((c) => c.handle).filter(Boolean);
}

/** Advance the clock and re-render every notified copy. */
export async function tickAll(ms = 1000) {
  const fired = await advanceTimers(ms, { flush, budgetMs: BUDGET.event });
  await flush();
  for (const h of mounted()) if (h.copy.dirty && !h.copy.hidden) h.render();
  return fired;
}

/** Problems reported outside any copy (e.g. elements built in a test, top-level code). */
export function globalErrors() { return S.globalErrors; }
export function globalWarnings() { return S.globalWarnings; }
