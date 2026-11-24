// Driver evaluated INSIDE the engine under test (QuickJS-ng via run.mjs, or V8 via node-run.mjs for
// the differential check). It imports the mod as real ES modules ("@mod/..." is mapped to
// mods/down-the-stack/ by the loader; "herdr" / "gpui-kit" / "gpui-base" to ./shims/) and exposes
// globalThis.__drv: every entry takes a JSON string and returns a JSON string.
//
// Clock: Date.now is pinned to globalThis.__clock (harness only) so every engine sees the same
// times; timings use globalThis.__hrnow() (the host's performance.now()).

import * as H from "herdr";
import { treeOf, countNodes } from "gpui-kit";
import * as Demo from "@mod/game/demo.js";
import * as W from "@mod/game/world.js";
import * as V from "@mod/game/view.js";
import * as HeroesNS from "@mod/game/heroes.js";
import * as CombatNS from "@mod/game/combat.js";
import * as BossNS from "@mod/game/boss.js";
import * as PanelsNS from "@mod/game/view/panels.js";
import * as ChromeNS from "@mod/game/view/chrome.js";
import * as StageNS from "@mod/game/view/stage.js";
import * as SaveNS from "@mod/game/save.js";
import DownTheStack from "@mod/main.js";
import { getHost } from "@mod/host.js";
import { SHEET_TABS } from "@mod/ui/sheet.js";
import { HERD_TABS } from "@mod/ui/herdpanel.js";
import { liveHeroes } from "@mod/game/agents.js";
import { rollItem, stashPut } from "@mod/game/items.js";
import { addGold, addSnippets } from "@mod/game/herd.js";
import { stressWorld as stressRecipe } from "./stress30.js";

const hr = globalThis.__hrnow;
const SHIM_ERRS = globalThis.__shimErrs;
const STATS = globalThis.__shimStats;
const NOW = globalThis.__NOW;
const SEC = 1000;
const STAGE_WIDTHS = [360, 960, 1600, 2400];

// ---------------------------------------------------------------------------------------------
// helpers

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}
const digest = (v) => { const s = JSON.stringify(v); return s === undefined ? "undef" : fnv(s) + ":" + s.length; };
function stat(list) {
  if (!list.length) return null;
  const a = list.slice().sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  return { n: a.length, mean: +mean.toFixed(3), p50: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +a[a.length - 1].toFixed(3) };
}
// The lower of wall and CPU time (run.mjs stopwatch): a busy machine makes nothing look slower.
const cpu = typeof globalThis.__cpunow === "function" ? globalThis.__cpunow : null;
function timed(fn) {
  const t0 = hr();
  const c0 = cpu ? cpu() : 0;
  const v = fn();
  const wall = hr() - t0;
  return [v, +(cpu ? Math.min(wall, cpu() - c0) : wall).toFixed(3)];
}
const setClock = (ms) => { globalThis.__clock = ms; };
const errMsg = (e) => String((e && e.stack) || (e && e.message) || e);

/** herdr live data (tools/mock/samples.mjs + tools/fixtures.mjs shapes) for a demo snapshot. */
function liveOf(snap, layoutJson) {
  const CWD = (space) => `/mock/user/src/${space}`;
  const agents = (snap.agents || []).map((a) => Object.assign({}, a, { focused: snap.focusedTerminal != null && a.address === snap.focusedTerminal }));
  const panes = agents.map((a) => ({
    pane: a.pane, terminal: a.address, tab: a.tab, title: a.title, name: a.pane_name, cwd: CWD(a.space), branch: "main",
    status: a.status, app: a.app, program: a.program, focused: a.focused, zoomed: false, movable: true,
    scroll: { total: 200, offset: 160, len: 40, from_bottom: 0 },
  }));
  const terminals = agents.map((a) => ({
    address: a.address, argv: [a.program && a.program.key], name: a.title, template: null, parent: null, labels: {}, state: "live",
    status: a.status, report: { app: a.app }, program: a.program, selection: null,
  }));
  for (const s of snap.subagents || []) {
    terminals.push({ address: s.address, argv: ["agent"], name: s.title, template: null, parent: s.parent, labels: {}, state: "live", status: s.status, report: null, program: s.program || null, selection: null });
  }
  const order = [];
  const by = new Map();
  for (const sp of snap.spaces || []) if (!by.has(sp.id)) { by.set(sp.id, { id: sp.id, name: sp.name, tabs: new Map() }); order.push(sp.id); }
  for (const a of agents) {
    if (!by.has(a.space)) { by.set(a.space, { id: a.space, name: a.space_name, tabs: new Map() }); order.push(a.space); }
    const sp = by.get(a.space);
    if (!sp.tabs.has(a.tab)) sp.tabs.set(a.tab, { id: a.tab, name: a.tab_name, agents: [] });
    sp.tabs.get(a.tab).agents.push(a);
  }
  const fa = agents.find((a) => a.focused) || null;
  const spaces = order.map((id, i) => {
    const sp = by.get(id);
    const tabs = Array.from(sp.tabs.values()).map((t, k) => ({
      id: t.id, index: k + 1, name: t.name, named: t.name != null, active: fa ? fa.tab === t.id : k === 0, status: (t.agents[0] && t.agents[0].status) || null,
      panes: t.agents.length, zoomed: false, settled: false, settled_at: null, changed_at: null,
      working_since: snap.tabs && snap.tabs[t.id] ? snap.tabs[t.id].working_since : null,
    }));
    return { id, index: i + 1, name: sp.name, named: true, folder: CWD(id), machine: null, branch: "main", active: fa ? fa.space === id : i === 0, status: null, tabs };
  });
  const focused = fa ? { space: fa.space, tab: fa.tab, pane: fa.pane, terminal: fa.address, shown: null, agent: null, cwd: CWD(fa.space), selection: null } : null;
  return { agents, panes, terminals, spaces, focused, layout: layoutJson, window: { active: true, visible: true } };
}

// ---------------------------------------------------------------------------------------------
// copies of main.js (herdr's per-copy instance + cx)

let handleSeq = 1000;
const copyErrors = [];
// A cx used after its copy's build was released (hot reload): herdr throws (qjs/mod.rs "this cx
// belongs to a build of the script that was reloaded or closed"); the reload phase lists them.
const staleCx = [];
function makeCx(copy) {
  const live = (what) => {
    if (!copy.released) return;
    if (staleCx.length < 50) staleCx.push(`${copy.name || "copy"}: cx.${what} after its build was released`);
    throw new Error("this cx belongs to a build of the script that was reloaded or closed");
  };
  return {
    notify() { live("notify"); copy.dirty = true; },
    stop_propagation() {},
    propagate() {},
    phase() { return "event"; },
    theme() { return H.theme(); },
    focus_handle() { live("focus_handle"); return { __handle: ++handleSeq, focus() {}, is_focused() { return false; }, release() {} }; },
    spawn(fn) {
      live("spawn");
      const task = { done: false };
      if (copy.tasks) copy.tasks.push(task);
      let r;
      try { r = fn(makeCx(copy)); } catch (e) { task.done = true; copyErrors.push(`spawn: ${errMsg(e)}`); }
      if (r && typeof r.then === "function") r.then(() => { task.done = true; }, (e) => { task.done = true; copyErrors.push(`task: ${errMsg(e)}`); });
      else task.done = true;
      return { cancel() {}, is_done() { return task.done; } };
    },
    sleep() { live("sleep"); return new Promise(() => {}); },
    timer: {
      every(ms, fn) { live("timer.every"); copy.timers.push({ ms, fn, every: true }); return { cancel() {}, is_done() { return false; } }; },
      after(ms, fn) { live("timer.after"); copy.timers.push({ ms, fn, every: false }); return { cancel() {}, is_done() { return false; } }; },
    },
    bind_keys(list) { return list.length; },
    open_url() {},
    read_from_clipboard() { return ""; },
    write_to_clipboard() {},
  };
}
/** herdr's frame for a copy's callback: its props, and (reload phase) the build its host calls belong to. */
function enter(copy) {
  H.__ctl.setProps(copy.props);
  H.__ctl.setFrame(copy.tracked ? copy : null);
}
/** A copy: constructor + init(undefined, cx) of `Class` (main.js's default export of a build). */
function mount(props, Class = DownTheStack, more) {
  const copy = Object.assign({ props, timers: [], dirty: false, view: null, cx: null }, more || {});
  copy.cx = makeCx(copy);
  enter(copy);
  copy.view = new Class();
  copy.view.init(undefined, copy.cx);
  return copy;
}
function renderCopy(copy) {
  enter(copy);
  return copy.view.render(makeCx(copy));
}
/** Fire the root's on_size_change with window px (logical × zoom), as herdr reports it. */
function sizeCopy(copy, root, w, h) {
  if (!root || !root.m) return false;
  for (const call of root.m) {
    if (call[0] === "on_size_change" && typeof call[1] === "function") {
      enter(copy);
      call[1]({ width: w, height: h }, makeCx(copy));
      return true;
    }
  }
  return false;
}
function runTimer(copy) {
  enter(copy);
  const t = copy.timers.find((x) => x.every);
  if (!t) return false;
  t.fn(makeCx(copy));
  return true;
}

function freshHost(world) {
  const host = getHost();
  host.started = true;
  host.loaded = true;
  host.memoryOnly = false;
  host.placeholder = null;
  host.world = world;
  host.lastText = null;
  host.lastGood = false;
  host.lastSaveMs = globalThis.__clock;
  host.saving = null;
  host.saveSoonAt = null;
  host.errors = [];
  host.errorCount = 0;
  H.__ctl.S.files.clear();
  host.version++;
  return host;
}

// ---------------------------------------------------------------------------------------------
// view builders, called directly

function viewList(world) {
  const heroes = world.state.heroes;
  const heroId = heroes.length ? heroes[0].id : 1;
  const out = [];
  for (const w of STAGE_WIDTHS) out.push([`stageView@${w}`, () => V.stageView(world, { width: w, height: 200, nowMs: globalThis.__clock })]);
  out.push(["partyView@248", () => V.partyView(world, { width: 248, nowMs: globalThis.__clock })]);
  out.push(["hudView", () => V.hudView(world, { nowMs: globalThis.__clock })]);
  const addrs = world.rt && world.rt.bind ? Array.from(world.rt.bind.keys()) : [];
  for (const a of addrs.slice(0, 6)) out.push([`nameplateView:${a}`, () => V.nameplateView(world, { terminal: a, pane: `p_${a}` })]);
  for (const tab of SHEET_TABS) out.push([`sheetView:${tab}`, () => V.sheetView(world, { heroId, tab, filter: {} })]);
  for (const tab of HERD_TABS) out.push([`herdView:${tab}`, () => V.herdView(world, { tab, filter: {} })]);
  return out;
}

function resetViewMemos(world) {
  if (StageNS._resetStageMemo) StageNS._resetStageMemo(world);
  if (PanelsNS._resetPanelsMemo) PanelsNS._resetPanelsMemo();
}

function runViews(world, { reset = true, digests = null } = {}) {
  const res = {};
  for (const [name, fn] of viewList(world)) {
    if (reset) resetViewMemos(world);
    world.rt.version++; // a new version, as after a tick: every view memo misses
    let vm, ms;
    try {
      [vm, ms] = timed(fn);
    } catch (e) {
      res[name] = { error: errMsg(e) };
      continue;
    }
    res[name] = ms;
    if (digests) digests[name] = digest(vm);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// role copies (main.js → ui/*.js render)

function roleSet(world, fx) {
  const heroes = world.state.heroes;
  const heroId = heroes.length ? heroes[0].id : 1;
  const roles = [];
  for (const w of STAGE_WIDTHS) roles.push({ name: `stage@${w}`, props: { role: "stage" }, size: [w, 200] });
  roles.push({ name: "party@248", props: { role: "party" }, size: [248, 820] });
  roles.push({ name: "hud@960", props: { role: "hud" }, size: [960, 26] });
  for (const p of (fx.panes || []).slice(0, 4)) roles.push({ name: `nameplate:${p.terminal}@700`, props: { role: "nameplate", pane: p.pane, terminal: p.terminal }, size: [700, 34] });
  for (const tab of SHEET_TABS) roles.push({ name: `sheet:${tab}`, props: { role: "sheet", overlay: "o1", heroId, tab }, size: [760, 500] });
  for (const tab of HERD_TABS) roles.push({ name: `herd:${tab}`, props: { role: "herd", overlay: "o2", tab }, size: [760, 520] });
  return roles;
}

/** Render every role: cold (fresh copy, memo miss: view build + render), then warm (memo hit). */
function runRoles(world, fx, { digests = null, warmReps = 5 } = {}) {
  const host = freshHost(world);
  const out = {};
  for (const r of roleSet(world, fx)) {
    const before = host.errors.length;
    let copy;
    try { copy = mount(r.props); } catch (e) { out[r.name] = { error: `init: ${errMsg(e)}` }; continue; }
    host.version++; // memo miss for the cold render
    let el, cold, nodes = 0, calls0 = STATS.calls;
    try {
      [el, cold] = timed(() => renderCopy(copy));
      sizeCopy(copy, el, r.size[0], r.size[1]);
      host.version++;
      const [el2, cold2] = timed(() => renderCopy(copy)); // sized: memo miss again at the real width
      el = el2;
      cold = Math.max(cold, cold2);
    } catch (e) { out[r.name] = { error: `render: ${errMsg(e)}` }; continue; }
    const calls = STATS.calls - calls0;
    const warm = [];
    let last = el;
    for (let i = 0; i < warmReps; i++) {
      let t;
      [last, t] = timed(() => renderCopy(copy));
      warm.push(t);
    }
    nodes = countNodes(last);
    const errs = host.errors.slice(before).map((x) => `${x.where}: ${x.message}`);
    out[r.name] = { cold, warm: stat(warm), nodes, errors: errs.length ? errs : undefined, chip: JSON.stringify(treeOf(last)).indexOf("hit a snag") >= 0 || undefined };
    if (digests) digests[r.name] = digest(treeOf(last));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// phases


// ---------------------------------------------------------------------------------------------
// "stress30": the 30-hero herd (tools/qjs/stress30.js, the recipe tools/fixtures.mjs builds too, so
// npm run check and this harness run the same world). Not a game/demo.js kind: tools only.

const stressWorld = (nowMs) => stressRecipe({ Demo, W, liveHeroes, rollItem, stashPut, addGold, addSnippets }, nowMs);
const buildKind = (kind, nowMs) => (kind === "stress30" ? stressWorld(nowMs) : Demo.demoWorld(kind, nowMs));

const drv = {};

/** herdr-app check: checking() true, props() null, empty lists; construct, init, one render. */
drv.check = (argJson) => {
  const { fixture } = JSON.parse(argJson);
  H.__ctl.setChecking(true);
  H.__ctl.setFixture(fixture);
  H.__ctl.setProps(null);
  const copy = { props: null, timers: [], dirty: false };
  copy.cx = makeCx(copy);
  let initMs, renderMs, tree, error = null;
  try {
    const [v, cms] = timed(() => new DownTheStack());
    copy.view = v;
    [, initMs] = timed(() => v.init(undefined, copy.cx));
    let el;
    [el, renderMs] = timed(() => v.render(makeCx(copy)));
    tree = treeOf(el);
  } catch (e) { error = errMsg(e); }
  H.__ctl.setChecking(false);
  return JSON.stringify({ initMs, renderMs, tree, error, timers: copy.timers.length, shimErrs: SHIM_ERRS.slice(), copyErrors: copyErrors.slice() });
};

/** Every demo world: build, save round trip, cold tick/views on the reloaded world, N warm ticks, views, roles. */
drv.world = (argJson) => {
  const { kind, ticks = 300, layout, roles = true, views = true } = JSON.parse(argJson);
  const res = { kind, digests: {} };
  const D = res.digests;
  setClock(NOW);
  const [built, buildMs] = timed(() => buildKind(kind, NOW));
  if (built.challenge) res.challenge = built.challenge;
  const world = built.world;
  res.buildMs = buildMs;
  res.heroes = world.state.heroes.length;
  res.live = world.rt.live ? world.rt.live.size : 0;
  D.build = digest(JSON.parse(W.serialize(world)));

  // save round trip (serialize → loadWorld → serialize identical)
  const [text, serMs] = timed(() => W.serialize(world));
  const [loaded, loadMs] = timed(() => W.loadWorld(text, { nowMs: NOW }));
  const [text2, ser2Ms] = timed(() => W.serialize(loaded.world));
  res.save = { bytes: text.length, serializeMs: serMs, loadWorldMs: loadMs, reserializeMs: ser2Ms, identical: text === text2, warning: loaded.warning || null };
  D.saveText = digest(text);

  // cold: the reloaded world (every engine cache empty, as after a hot reload / VM restart)
  const lw = loaded.world;
  const snap0 = Object.assign({}, built.snapshot, { nowMs: NOW + SEC });
  setClock(NOW + SEC);
  let coldTick;
  try { [, coldTick] = timed(() => W.tick(lw, snap0)); } catch (e) { coldTick = { error: errMsg(e) }; }
  res.coldTickMs = coldTick;
  if (views) res.coldViews = runViews(lw, { reset: true });

  // warm: the scripted cast keeps statuses moving; one world tick per second
  setClock(NOW);
  const tickMs = [];
  const tickErr = [];
  let now = NOW;
  for (let i = 0; i < ticks; i++) {
    now += SEC;
    setClock(now);
    const snap = Demo.demoSnapshot(world, now);
    try {
      const [, ms] = timed(() => W.tick(world, snap));
      tickMs.push(ms);
    } catch (e) { if (tickErr.length < 5) tickErr.push(errMsg(e)); }
    if (i === 99) D.tick100 = digest(JSON.parse(W.serialize(world)));
  }
  res.ticks = stat(tickMs);
  res.tickErrors = tickErr.length ? tickErr : undefined;
  res.engineErrors = (world.rt.errors || []).slice(0, 10);
  D.tickEnd = digest(JSON.parse(W.serialize(world)));
  res.afterTicks = { heroes: world.state.heroes.length, live: world.rt.live ? world.rt.live.size : 0, fight: !!(world.rt.fights && world.rt.fights.length) };

  if (views) {
    res.views = runViews(world, { reset: true, digests: D });
    // memo hit (same version, same args): the cost every further copy pays
    const again = {};
    for (const [name, fn] of viewList(world)) { try { again[name] = timed(fn)[1]; } catch (e) { again[name] = { error: errMsg(e) }; } }
    res.viewsMemoHit = again;
  }

  // save after play
  const [t3, ser3] = timed(() => W.serialize(world));
  const [l3, load3] = timed(() => W.loadWorld(t3, { nowMs: now }));
  res.saveAfter = { bytes: t3.length, serializeMs: ser3, loadWorldMs: load3, identical: W.serialize(l3.world) === t3 };

  if (roles) {
    const fx = liveOf(Demo.demoSnapshot(world, now), layout);
    H.__ctl.setFixture(Object.assign({}, globalThis.__baseFixture, fx));
    res.roles = runRoles(world, fx, { digests: D });
  }
  res.shimErrs = SHIM_ERRS.splice(0);
  res.copyErrors = copyErrors.splice(0);
  return JSON.stringify(res);
};

/**
 * A window for `seconds`: stage, party, hud, every nameplate, a sheet and the Herd panel. Each
 * second: the stage copy's 1 s timer (host.pump: tick + save when due + prewarm), then every copy
 * renders (as after the broadcast). Measures the timer callback and each render (memo hits).
 */
const WIN = { world: null, host: null, copies: null, layout: null, now: 0, pumpMs: [], frameMs: [], per: {}, writes0: 0, maxSaveBytes: 0, kind: null };

drv.windowStart = (argJson) => {
  const { kind, layout, dialogs = true } = JSON.parse(argJson);
  setClock(NOW);
  const built = buildKind(kind, NOW);
  const world = built.world;
  const host = freshHost(world);
  const fx = liveOf(built.snapshot, layout);
  H.__ctl.setFixture(Object.assign({}, globalThis.__baseFixture, fx));
  const heroId = world.state.heroes.length ? world.state.heroes[0].id : 1;
  const specs = [
    { props: { role: "stage" }, size: [960, 200] },
    { props: { role: "party" }, size: [248, 820] },
    { props: { role: "hud" }, size: [960, 26] },
  ];
  for (const p of fx.panes) specs.push({ props: { role: "nameplate", pane: p.pane, terminal: p.terminal }, size: [700, 34] });
  if (dialogs) {
    specs.push({ props: { role: "sheet", overlay: "o1", heroId, tab: "gear" }, size: [760, 500] });
    specs.push({ props: { role: "herd", overlay: "o2", tab: "roster" }, size: [760, 520] });
  }
  const copies = specs.map((sp) => {
    const c = mount(sp.props);
    const el = renderCopy(c);
    sizeCopy(c, el, sp.size[0], sp.size[1]);
    c.name = sp.props.role + (sp.props.terminal ? `:${sp.props.terminal}` : sp.props.tab ? `:${sp.props.tab}` : "");
    return c;
  });
  for (const c of copies) renderCopy(c);
  WIN.spikes = [];
  Object.assign(WIN, { world, host, copies, layout, now: NOW, pumpMs: [], frameMs: [], per: {}, writes0: H.__ctl.S.calls.writeTextFile, maxSaveBytes: 0, kind });
  return JSON.stringify({ copies: copies.length });
};

/**
 * One second of a window: the stage copy's 1 s timer (host.pump: tick + save when due + prewarm),
 * then every copy renders (as after the broadcast). The host drains the job queue after the call,
 * as herdr does after every callback.
 */
drv.windowStep = () => {
  WIN.now += SEC;
  setClock(WIN.now);
  const fx = liveOf(Demo.demoSnapshot(WIN.world, WIN.now), WIN.layout);
  H.__ctl.setFixture(Object.assign({}, globalThis.__baseFixture, fx));
  const [, pms] = timed(() => runTimer(WIN.copies[0]));
  WIN.pumpMs.push(pms);
  let frame = 0;
  const memFn = globalThis.__memOn ? globalThis.__mem : null;
  for (const c of WIN.copies) {
    const m0 = memFn ? memFn() : 0;
    const [, ms] = timed(() => renderCopy(c));
    const m1 = memFn ? memFn() : 0;
    frame += ms;
    (WIN.per[c.name] = WIN.per[c.name] || []).push(ms);
    if (ms > 12.5) (WIN.spikes = WIN.spikes || []).push({ copy: c.name, ms, heapBefore: m0, heapAfter: m1, t: WIN.pumpMs.length });
  }
  WIN.frameMs.push(frame);
  for (const w of H.__ctl.S.calls.writes) if (w.bytes > WIN.maxSaveBytes) WIN.maxSaveBytes = w.bytes;
  return "{}";
};

drv.windowEnd = () => {
  const renders = {};
  for (const k of Object.keys(WIN.per)) renders[k] = stat(WIN.per[k]);
  const host = WIN.host;
  const world = WIN.world;
  const out = JSON.stringify({
    spikes: WIN.spikes || [], kind: WIN.kind, seconds: WIN.pumpMs.length, copies: WIN.copies.length, pump: stat(WIN.pumpMs), frame: stat(WIN.frameMs), renders,
    saves: H.__ctl.S.calls.writeTextFile - WIN.writes0, savesDone: host.stats.saves, maxSaveBytes: WIN.maxSaveBytes,
    hostErrors: host.errors.map((x) => `${x.where}: ${x.message} ×${x.count}`), engineErrors: (world.rt.errors || []).slice(0, 10),
    hostStats: host.stats, shimErrs: SHIM_ERRS.splice(0), copyErrors: copyErrors.splice(0),
  });
  WIN.world = null; WIN.copies = null; WIN.host = null;
  return out;
};

// ---- long run (memory): state lives across calls
const LONG = { world: null, now: 0, n: 0, host: null, copies: null, layout: null, viewsEvery: 10 };

drv.longStart = (argJson) => {
  const { kind, layout, viewsEvery = 10 } = JSON.parse(argJson);
  setClock(NOW);
  const built = buildKind(kind, NOW);
  LONG.world = built.world;
  LONG.now = NOW;
  LONG.n = 0;
  LONG.layout = layout;
  LONG.viewsEvery = viewsEvery;
  LONG.host = freshHost(LONG.world);
  const fx = liveOf(built.snapshot, layout);
  H.__ctl.setFixture(Object.assign({}, globalThis.__baseFixture, fx));
  LONG.copies = [{ role: "stage" }, { role: "party" }, { role: "hud" }].concat(fx.panes.slice(0, 4).map((p) => ({ role: "nameplate", pane: p.pane, terminal: p.terminal }))).map((p) => mount(p));
  return JSON.stringify({ ok: true, copies: LONG.copies.length });
};

/** n more seconds through the real pump (tick + save when due + prewarm) + renders every viewsEvery s. */
drv.longStep = (argJson) => {
  const { n = 1 } = JSON.parse(argJson);
  const tick = [];
  const pump = [];
  for (let i = 0; i < n; i++) {
    LONG.now += SEC;
    LONG.n++;
    setClock(LONG.now);
    const fx = liveOf(Demo.demoSnapshot(LONG.world, LONG.now), LONG.layout);
    H.__ctl.setFixture(Object.assign({}, globalThis.__baseFixture, fx));
    const [, ms] = timed(() => runTimer(LONG.copies[0]));
    pump.push(ms);
    tick.push(LONG.host.stats.lastTickMs);
    if (LONG.n % LONG.viewsEvery === 0) for (const c of LONG.copies) renderCopy(c);
  }
  return JSON.stringify({ n: LONG.n, pump: stat(pump) });
};

/** Sizes of every array / Map / Set reachable from the world, the host and module caches. */
drv.longSizes = () => {
  const w = LONG.world;
  const sizes = {};
  const seen = new Set();
  const walk = (v, path, depth) => {
    if (v == null || typeof v !== "object" || seen.has(v) || depth > 7) return;
    seen.add(v);
    if (Array.isArray(v)) {
      if (v.length >= 8) sizes[path] = Math.max(sizes[path] || 0, v.length);
      for (let i = 0; i < Math.min(v.length, 64); i++) walk(v[i], path + "[]", depth + 1);
      return;
    }
    if (v instanceof Map || v instanceof Set) {
      if (v.size >= 8) sizes[path] = Math.max(sizes[path] || 0, v.size);
      let i = 0;
      for (const x of v.values()) { if (i++ > 64) break; walk(x, path + "{}", depth + 1); }
      return;
    }
    const keys = Object.keys(v);
    if (keys.length >= 64) sizes[path + "(keys)"] = Math.max(sizes[path + "(keys)"] || 0, keys.length);
    for (const k of keys) walk(v[k], path + "." + (/^\d+$/.test(k) || keys.length > 64 ? "*" : k), depth + 1);
  };
  walk(w.state, "state", 0);
  walk(w.rt, "rt", 0);
  const host = LONG.host;
  const modCaches = {};
  for (const [name, ns] of [["heroes", HeroesNS], ["combat", CombatNS], ["boss", BossNS], ["panels", PanelsNS], ["chrome", ChromeNS], ["stage", StageNS], ["save", SaveNS]]) {
    if (typeof ns.__qjsDbg === "function") modCaches[name] = ns.__qjsDbg();
  }
  const text = W.serialize(w);
  return JSON.stringify({
    n: LONG.n, sizes, saveBytes: text.length, hostMemo: host.memo.map.size, hostErrors: host.errors.length, hostCopies: host.copies.size,
    claims: Object.keys(host.claims).length, modCaches, heroes: w.state.heroes.length, engineErrors: (w.rt.errors || []).length,
  });
};

drv.longDone = () => {
  LONG.world = null; LONG.host = null; LONG.copies = null;
  return "{}";
};

/** Digest of one demo world's outputs only (for the differential run). */
drv.digestWorld = (argJson) => drv.world(argJson);


// ---- frozen-prototype key fuzz: external strings named like Object.prototype members
const EVIL = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "toLocaleString", "__defineGetter__"];

drv.fuzz = (argJson) => {
  const { layout } = JSON.parse(argJson);
  const failures = [];
  let cases = 0;
  const check = (label, fn) => {
    cases++;
    try {
      const r = fn();
      if (r) failures.push(`${label}: ${r}`);
    } catch (e) {
      const st = String((e && e.stack) || "").split("\n").filter((l) => /mods\/down-the-stack|driver/.test(l)).slice(0, 4).map((l) => l.trim().replace(/.*mods\/down-the-stack\//, "")).join(" <- ");
      failures.push(`${label}: THREW ${String((e && e.message) || e).split("\n")[0]} at ${st}`);
    }
  };
  const engineErr = (world, n0) => (world.rt.errors || []).slice(n0).map(String).join(" | ");
  const roundTrip = (world) => {
    const t = W.serialize(world);
    const l = W.loadWorld(t, { nowMs: globalThis.__clock });
    const t2 = W.serialize(l.world);
    return t === t2 ? null : `save round trip differs (${t.length} vs ${t2.length} B)`;
  };

  // 1. live data: addresses, program keys, apps, titles, spaces, tabs, panes named after prototype members
  for (const evil of EVIL) {
    check(`snapshot fields = "${evil}"`, () => {
      setClock(NOW);
      const built = Demo.demoWorld("mid", NOW);
      const world = built.world;
      const n0 = (world.rt.errors || []).length;
      const snap = JSON.parse(JSON.stringify(built.snapshot));
      snap.agents.forEach((a, i) => {
        if (i === 0) { a.address = evil; a.pane = evil; }
        if (i === 1) { a.program = Object.assign({}, a.program, { key: evil, name: evil }); a.app = evil; }
        if (i === 2) { a.title = evil; a.pane_name = evil; a.tab = evil; a.tab_name = evil; }
        if (i === 3) { a.space = evil; a.space_name = evil; }
      });
      snap.spaces = (snap.spaces || []).concat([{ id: evil, name: evil }]);
      snap.tabs = Object.assign({}, snap.tabs);
      Object.defineProperty(snap.tabs, evil, { value: { working_since: NOW - 60000 }, enumerable: true, configurable: true, writable: true });
      snap.subagents = [{ address: evil + "-sub", parent: evil, status: "working", title: evil, program: null }];
      snap.focusedTerminal = evil;
      for (let i = 1; i <= 12; i++) {
        setClock(NOW + i * SEC);
        W.tick(world, Object.assign({}, snap, { nowMs: NOW + i * SEC }));
      }
      const bound = world.rt.bind && world.rt.bind.has(evil);
      // host path too: herdr live data (host.snapshot builds tabs{} from spaces()[].tabs[].id)
      const fx = liveOf(snap, layout);
      fx.spaces.push({ id: evil, index: 9, name: evil, named: true, folder: "/x", machine: null, branch: null, active: false, status: null,
        tabs: [{ id: evil, index: 1, name: evil, named: true, active: false, status: null, panes: 0, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: NOW }] });
      H.__ctl.setFixture(Object.assign({}, globalThis.__baseFixture, fx));
      const host = freshHost(world);
      let tabOk = true;
      let hostErr = null;
      try {
        const hs = host.snapshot(NOW + 13 * SEC);
        tabOk = Object.prototype.hasOwnProperty.call(hs.tabs, evil);
        setClock(NOW + 13 * SEC);
        W.tick(world, hs);
      } catch (e) {
        hostErr = `host.snapshot threw "${e && e.message}" at ${String((e && e.stack) || "").split("\n").filter((l) => /mods\/down-the-stack/.test(l)).slice(0, 2).map((l) => l.trim().replace(/.*mods\/down-the-stack\//, "")).join(" <- ")}`;
      }
      const views = runViews(world, { reset: true });
      const bad = Object.entries(views).filter(([, v]) => typeof v === "object").map(([k, v]) => `${k}: ${v.error.split("\n")[0]}`);
      const roles = runRoles(world, fx, { warmReps: 1 });
      const badR = Object.entries(roles).filter(([, v]) => v.error || v.errors || v.chip).map(([k, v]) => `${k}: ${(v.error || JSON.stringify(v.errors)).split("\n")[0]}`);
      const e = engineErr(world, n0);
      const rtp = roundTrip(world);
      const out = [];
      if (!bound) out.push(`agent "${evil}" not bound to a hero`);
      if (hostErr) out.push(hostErr);
      if (!tabOk) out.push(`host.snapshot dropped tab "${evil}" (tabs is a plain object)`);
      if (bad.length) out.push(`views: ${bad.join("; ")}`);
      if (badR.length) out.push(`roles: ${badR.join("; ")}`);
      if (e) out.push(`engine errors: ${e}`);
      if (rtp) out.push(rtp);
      return out.length ? out.join(" / ") : null;
    });
  }

  // 2. commands with prototype-member names as values and keys
  const names = W.COMMAND_NAMES || [];
  for (const evil of EVIL) {
    check(`commands with "${evil}"`, () => {
      setClock(NOW);
      const built = Demo.demoWorld("late", NOW);
      const world = built.world;
      const n0 = (world.rt.errors || []).length;
      const hero = world.state.heroes[0];
      const out = [];
      const argsList = [
        { heroId: evil }, { heroId: hero.id, name: evil }, { herd: true, name: evil }, { key: evil, value: true }, { key: `auto.${evil}`, value: true },
        { key: `notify.${evil}`, value: true }, { building: evil }, { kind: evil, idx: evil }, { kind: "boss", idx: evil }, { heroId: hero.id, mapId: evil },
        { heroId: hero.id, cls: evil }, { uid: evil }, { uid: evil, locked: true }, { uids: [evil, evil, evil] }, { uid: evil, affix: evil },
        { heroId: hero.id, slot: evil }, { heroId: hero.id, address: evil }, { heroId: hero.id, on: evil },
      ];
      for (const name of names.concat([evil])) {
        for (const a of argsList) {
          let r;
          try { r = W.command(world, name, a, NOW); } catch (e) { out.push(`${name}(${JSON.stringify(a)}) threw ${e && e.message}`); continue; }
          if (r && r.error && /Internal error/.test(r.error)) out.push(`${name}(${JSON.stringify(a)}): ${r.error}`);
        }
      }
      // renamed hero / herd survive views and the save
      W.command(world, "rename", { heroId: hero.id, name: evil }, NOW);
      W.command(world, "rename", { herd: true, name: evil }, NOW);
      const views = runViews(world, { reset: true });
      for (const [k, v] of Object.entries(views)) if (typeof v === "object") out.push(`view ${k}: ${v.error.split("\n")[0]}`);
      const e = engineErr(world, n0);
      if (e) out.push(`engine errors: ${e}`);
      const rtp = roundTrip(world);
      if (rtp) out.push(rtp);
      const t = W.serialize(world);
      const l = W.loadWorld(t, { nowMs: NOW }).world;
      if (l.state.herd.name !== world.state.herd.name) out.push(`herd name "${world.state.herd.name}" reloads as "${l.state.herd.name}"`);
      return out.length ? out.slice(0, 6).join(" / ") + (out.length > 6 ? ` (+${out.length - 6} more)` : "") : null;
    });
  }

  // 3. the real 1 s pump while herdr reports a tab whose id is a prototype-member name
  for (const evil of ["constructor", "__proto__"]) {
    check(`pump with a tab id "${evil}"`, () => {
      setClock(NOW);
      const built = Demo.demoWorld("mid", NOW);
      const world = built.world;
      const host = freshHost(world);
      const fx = liveOf(built.snapshot, layout);
      fx.spaces[0].tabs.push({ id: evil, index: 9, name: "x", named: true, active: false, status: null, panes: 0, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: null });
      H.__ctl.setFixture(Object.assign({}, globalThis.__baseFixture, fx));
      const copy = mount({ role: "stage" });
      const tick0 = world.state.herd.tick;
      for (let i = 1; i <= 5; i++) { setClock(NOW + i * SEC); try { runTimer(copy); } catch (e) { /* main.js rethrows surfaced errors once */ } }
      const advanced = world.state.herd.tick - tick0;
      const errs = host.errors.map((x) => `${x.where}: ${x.message} ×${x.count}`);
      return advanced > 0 && !errs.length ? null : `world advanced ${advanced} ticks in 5 pumps; host errors ${JSON.stringify(errs)}`;
    });
  }
  return JSON.stringify({ cases, failures, shimErrs: SHIM_ERRS.splice(0), copyErrors: copyErrors.splice(0) });
};

// ---- tools/fixtures.mjs roles (what tools/check.mjs runs under the Node mock), under QuickJS
const CONTRACTOR_AGENT = {
  address: "t7", pane: "p_t7", space: "spc_1", space_name: "herdr-app", tab: "tab_1", tab_index: 0, tab_name: "main",
  status: "working", app: "codex", program: Demo.PROGRAMS.codex, title: "Hotfix the login redirect", pane_name: null,
  seq: 700, pinned: false, focused: false,
};

drv.fixtureRole = (argJson) => {
  const { name, props, fixture, kind, contractor, loading, widths, zooms, height, ticks = 3 } = JSON.parse(argJson);
  setClock(NOW);
  const res = { name, renders: [], errors: [] };
  let world;
  if (kind) {
    const built = buildKind(kind, NOW);
    world = built.world;
    if (contractor) W.tick(world, Object.assign({}, built.snapshot, { nowMs: NOW + SEC, agents: built.snapshot.agents.concat([Object.assign({}, CONTRACTOR_AGENT)]) }));
  } else {
    world = buildKind("mid", NOW).world;
  }
  const host = freshHost(world);
  if (loading) { host.loaded = false; host.placeholder = host.world; host.loadingSince = Date.now(); }
  const base = Object.assign({}, globalThis.__baseFixture, fixture);
  H.__ctl.setFixture(base);
  let copy;
  try { copy = mount(props); } catch (e) { res.errors.push(`init: ${errMsg(e)}`); return JSON.stringify(res); }
  const take = (label) => {
    let el, ms;
    try { [el, ms] = timed(() => renderCopy(copy)); } catch (e) { res.errors.push(`${label}: render threw ${errMsg(e)}`); return null; }
    const tree = JSON.stringify(treeOf(el));
    if (tree.indexOf("hit a snag") >= 0) res.errors.push(`${label}: error chip`);
    res.renders.push({ label, ms, nodes: countNodes(el) });
    return el;
  };
  let el = take("first");
  for (const z of zooms) {
    H.__ctl.setFixture(Object.assign({}, base, { settings: Object.assign({}, base.settings || {}, { zoom: z }) }));
    el = take(`zoom ${z}`) || el;
    for (const w of widths) {
      sizeCopy(copy, el, w * z, height * z);
      el = take(`zoom ${z} width ${w}`) || el;
    }
    for (let t = 0; t < ticks; t++) {
      setClock(Date.now() + SEC);
      try { runTimer(copy); } catch (e) { res.errors.push(`zoom ${z} timer: ${errMsg(e).split("\n")[0]}`); }
      el = take(`zoom ${z} tick ${t + 1}`) || el;
    }
  }
  res.hostErrors = host.errors.map((x) => `${x.where}: ${x.message}`);
  res.engineErrors = (world.rt.errors || []).slice(0, 5);
  res.shimErrs = SHIM_ERRS.splice(0);
  res.copyErrors = copyErrors.splice(0);
  res.max = res.renders.reduce((m, r) => Math.max(m, r.ms), 0);
  res.maxNodes = res.renders.reduce((m, r) => Math.max(m, r.nodes), 0);
  return JSON.stringify(res);
};

// ---- save load through the real host (cx.spawn task → readTextFile → loadWorld), as on startup
const LOADP = { copy: null, t0: 0 };
drv.loadStart = (argJson) => {
  const { files, layout, kind } = JSON.parse(argJson);
  setClock(NOW);
  const host = getHost();
  // a brand-new host, as after a VM restart (module state is gone)
  for (const k of Object.keys(host)) delete host[k];
  Object.assign(host, new (Object.getPrototypeOf(host).constructor)());
  H.__ctl.S.files.clear();
  for (const [p, t] of Object.entries(files || {})) H.__ctl.S.files.set(p, t);
  const built = kind ? buildKind(kind, NOW) : null;
  H.__ctl.setFixture(Object.assign({}, globalThis.__baseFixture, built ? liveOf(built.snapshot, layout) : {}));
  const [copy, ms] = timed(() => mount({ role: "stage" }));
  LOADP.copy = copy;
  return JSON.stringify({ initMs: ms, ready: host.ready, loaded: host.loaded });
};
drv.loadCheck = () => {
  const host = getHost();
  const w = host.world;
  let renderMs = null, chip = false;
  try {
    const [el, ms] = timed(() => renderCopy(LOADP.copy));
    renderMs = ms;
    chip = JSON.stringify(treeOf(el)).indexOf("hit a snag") >= 0;
  } catch (e) { renderMs = errMsg(e); }
  setClock(NOW + 2 * SEC);
  const [, pumpMs] = timed(() => runTimer(LOADP.copy));
  return JSON.stringify({
    ready: host.ready, loaded: host.loaded, from: host.stats.loadedFrom, heroes: w ? w.state.heroes.length : null, readOnly: !!(w && w.rt.readOnly),
    warning: host.stats.warning, errors: host.errors.map((x) => `${x.where}: ${x.message}`), files: Array.from(H.__ctl.S.files.keys()),
    renderMs, chip, pumpMs, copyErrors: copyErrors.splice(0),
  });
};
drv.saveText = (argJson) => {
  const { kind } = JSON.parse(argJson);
  setClock(NOW);
  return JSON.stringify({ text: W.serialize(buildKind(kind, NOW).world) });
};

// ---------------------------------------------------------------------------------------------
// Hot reload in one context (run.mjs phase "reload"), as herdr does it when a file of the mod is
// saved: src/window.rs files_changed → runtime.reload_now → shell watch.rs reload(), for every
// copy of the mod in one synchronous pass:
//   1. load_app: the first copy evaluates the new revision once, as new module records
//      "<file>?v=<generation>" in the same context (run.mjs importBuild); the others reuse it;
//   2. instantiate_for_view: constructor + init of a new instance while the old one still lives;
//   3. release_application_generation of the old instance: its timers and tasks are cancelled (a
//      pending host call never resumes), and close() is NOT called.
// globalThis and the host modules carry over. Host IO is held (__ctl.setHold) and answered one call
// at a time in the frame that made it (settleIO; run.mjs drains the jobs after each), so a write
// can be in flight across the reload.

const SAVE_PATH = "/mock/home/data/down-the-stack/save.json";
const LIVE_KEY = Symbol.for("down-the-stack.live.v1");
const RL = { copies: [], released: [], specs: [], castWorld: null, layout: null, now: 0, gen: 1, host: null, prevHost: null, prevGen: 0, before: null, globals0: null, inflightFrom: null, ticks: [] };

const buildOf = (gen) => (gen === 1 ? { DownTheStack, getHost, W } : (globalThis.__builds || {})[gen]);
const globalKeys = () => Object.getOwnPropertyNames(globalThis).concat(Object.getOwnPropertySymbols(globalThis).map((x) => String(x)));
const copyName = (p) => p.role + (p.terminal ? `:${p.terminal}` : p.tab ? `:${p.tab}` : "");

/** One copy of a build: tracked (its host calls belong to it), named "<role>@b<gen>". */
function mountBuild(spec, gen) {
  const B = buildOf(gen);
  return mount(spec.props, B.DownTheStack, { tracked: true, released: false, tasks: [], name: `${copyName(spec.props)}@b${gen}`, gen, spec, sized: false });
}
/** watch.rs reload step 3 for one copy: its build is released (timers, tasks; its cx goes stale). */
function release(copy) {
  copy.released = true;
  copy.timersAtRelease = copy.timers.length;
  copy.pendingAtRelease = copy.tasks.filter((t) => !t.done).length;
  copy.timers = [];
  copy.view = null; // herdr drops the instance (only what the mod itself kept stays reachable)
  copy.last = null;
}
const pending = (copy) => copy.tasks.filter((t) => !t.done).length;
const heroesOf = (world) => world.state.heroes.map((h) => `${h.id}:${h.name}`).join(",");
const tickOf = (text) => { try { return JSON.parse(text).tick; } catch (e) { return null; } };

drv.reloadStart = (argJson) => {
  const { kind, layout } = JSON.parse(argJson);
  setClock(NOW);
  const built = buildKind(kind, NOW);
  H.__ctl.S.files.clear();
  H.__ctl.resetCalls();
  H.__ctl.S.files.set(SAVE_PATH, W.serialize(built.world));
  H.__ctl.setHold(true);
  RL.castWorld = built.world; // drives the cast (statuses) only; the host loads its save
  RL.layout = layout;
  RL.now = NOW;
  RL.gen = 1;
  RL.released = [];
  RL.ticks = [];
  const fx = liveOf(built.snapshot, layout);
  H.__ctl.setFixture(Object.assign({}, globalThis.__baseFixture, fx));
  RL.specs = [
    { props: { role: "stage" }, size: [960, 200] },
    { props: { role: "party" }, size: [248, 820] },
    { props: { role: "hud" }, size: [960, 26] },
  ].concat(fx.panes.slice(0, 2).map((p) => ({ props: { role: "nameplate", pane: p.pane, terminal: p.terminal }, size: [700, 34] })))
    .concat([{ props: { role: "herd", overlay: "o2", tab: "roster" }, size: [760, 520] }]);
  RL.copies = RL.specs.map((sp) => mountBuild(sp, 1));
  RL.host = getHost();
  RL.globals0 = null; // taken at the first reload, once the first build's host has registered itself
  return JSON.stringify({ copies: RL.copies.length, heroes: built.world.state.heroes.length });
};

/** Deliver the held host IO (run.mjs drains the job queue after this, then asks again); `only`: just this build's. */
drv.settleIO = (argJson) => {
  const { only } = JSON.parse(argJson || "{}");
  return String(H.__ctl.settle(only ? (f) => !!f && f.gen === only : undefined));
};
drv.reloadLoaded = () => JSON.stringify({ loaded: !!(RL.host && RL.host.loaded) });

/** n seconds: every copy's 1 s timer (the host pumps once per 900 ms), then every copy renders. */
drv.reloadStep = (argJson) => {
  const { n = 1 } = JSON.parse(argJson || "{}");
  const errs = [];
  for (let i = 0; i < n; i++) {
    RL.now += SEC;
    setClock(RL.now);
    const fx = liveOf(Demo.demoSnapshot(RL.castWorld, RL.now), RL.layout);
    H.__ctl.setFixture(Object.assign({}, globalThis.__baseFixture, fx));
    for (const c of RL.copies) {
      // main.js rethrows a host problem once from its timer; herdr logs it and keeps the timer
      try { runTimer(c); } catch (e) { if (errs.length < 5) errs.push(`${c.name} timer: ${errMsg(e).split("\n")[0]}`); }
    }
    for (const c of RL.copies) {
      try {
        let el = renderCopy(c);
        if (!c.sized) { c.sized = sizeCopy(c, el, c.spec.size[0], c.spec.size[1]); el = renderCopy(c); }
        c.last = el;
      } catch (e) { if (errs.length < 5) errs.push(`${c.name} render: ${errMsg(e).split("\n")[0]}`); }
    }
    if (RL.host && RL.host.world) RL.ticks.push(RL.host.world.state.herd.tick);
  }
  if (errs.length) (RL.stepErrors = RL.stepErrors || []).push(...errs);
  return "{}";
};

/** A save due now, started in the stage copy's frame (as its pump would): run.mjs then lets its writes land up to save.json. */
drv.reloadInflight = () => {
  const h = RL.host;
  const stage = RL.copies[0];
  RL.inflightFrom = H.__ctl.S.files.get(SAVE_PATH);
  enter(stage);
  h.world.rt.dirty = true;
  h.saveSoonAt = RL.now;
  const p = h.maybeSave(false, RL.now);
  return JSON.stringify({ started: !!p });
};
/** Has the in-flight save's save.json write landed (its answer still held)? */
drv.reloadIO = () => JSON.stringify({ saveWritten: H.__ctl.S.files.get(SAVE_PATH) !== RL.inflightFrom, held: H.__ctl.S.held.length, saving: !!(RL.host && RL.host.saving) });

/**
 * Another window (another VM sharing the save) writes save.json just before the reload: the same
 * herd at the same tick, 7 gold richer. save.json is no longer the old host's text, so it declines
 * the handover and the new host loads the file.
 */
drv.reloadForeign = () => {
  const PB = buildOf(RL.gen);
  const w = PB.W.loadWorld(PB.W.serialize(RL.host.world), { nowMs: RL.now }).world;
  addGold(w.state, 7);
  RL.foreign = PB.W.serialize(w);
  H.__ctl.S.files.set(SAVE_PATH, RL.foreign);
  return JSON.stringify({ tick: tickOf(RL.foreign) });
};

/** The reload itself: per copy, the new build's instance (constructor + init), then the old one released. */
drv.reloadSwap = (argJson) => {
  const { gen, keep = [] } = JSON.parse(argJson); // keep: roles whose new instance fails (watch.rs: the old one keeps running)
  const B = buildOf(gen);
  if (!B) throw new Error(`build ${gen} was never evaluated`);
  const h1 = RL.host;
  const PB = buildOf(RL.gen);
  if (!RL.globals0) RL.globals0 = globalKeys();
  const fileText = H.__ctl.S.files.get(SAVE_PATH);
  RL.before = {
    fileText, fileTick: tickOf(fileText), worldText: PB.W.serialize(h1.world), tick: h1.world.state.herd.tick, heroes: heroesOf(h1.world),
    saves: h1.stats.saves, own: h1.ownTexts.length, inFlight: !!h1.saving, writes: H.__ctl.S.calls.writeTextFile, errors: h1.errors.length,
    pumps: h1.stats.pumps, reloads: h1.stats.reloads,
  };
  const old = RL.copies;
  const fresh = [];
  const initMs = [];
  for (const c of old) {
    if (keep.includes(c.spec.props.role)) { fresh.push(c); continue; } // reload() failed: nothing released
    const [copy, ms] = timed(() => mountBuild(c.spec, gen));
    fresh.push(copy);
    initMs.push(+ms.toFixed(2));
    release(c);
  }
  RL.copies = fresh;
  RL.released = RL.released.concat(old.filter((c) => c.released));
  RL.prevHost = h1;
  RL.prevGen = RL.gen;
  RL.gen = gen;
  RL.host = B.getHost();
  return JSON.stringify({ initMs, newHost: RL.host !== h1, loadingAfterInit: !RL.host.loaded });
};

/**
 * Right after the new build's load (every held read delivered): the handover's outcome. `declined`:
 * another window wrote save.json (reloadForeign), so the new host loads that file instead, and
 * retires the old host all the same.
 */
drv.reloadCheck = (argJson) => {
  const { declined = false } = JSON.parse(argJson || "{}");
  const B = buildOf(RL.gen);
  const h2 = RL.host;
  const h1 = RL.prevHost;
  const b = RL.before;
  const fail = [];
  const want = (ok, text) => { if (!ok) fail.push(text); };
  want(h2 !== h1, "the new build shares the old build's host (module scope did not start fresh)");
  want(h2.loaded, "the new build's host never finished loading");
  want(h2.world && h2.world !== h1.world, "the new host runs the old build's world object instead of decoding it with its own code");
  const text = h2.world ? B.W.serialize(h2.world) : null;
  if (declined) {
    want(h2.stats.loadedFrom === "save", `loaded from "${h2.stats.loadedFrom}", not the other window's save.json ("save")`);
    want(text === RL.foreign, `the new world is not the other window's save (tick ${h2.world && h2.world.state.herd.tick} vs ${b.fileTick})`);
  } else {
    want(h2.stats.loadedFrom === "reload", `loaded from "${h2.stats.loadedFrom}", not the previous build's world ("reload")`);
    want(text === b.worldText, `the new world is not the old one at the reload (tick ${h2.world && h2.world.state.herd.tick} vs ${b.tick}; save.json had tick ${b.fileTick})`);
  }
  want(h2.world && heroesOf(h2.world) === b.heroes, "the heroes differ after the reload");
  want(h1.retired === true, "the old host was not retired");
  want(globalThis[LIVE_KEY] === h2, "globalThis[Symbol.for(\"down-the-stack.live.v1\")] is not the new host");
  want(h2.lastText === H.__ctl.S.files.get(SAVE_PATH), "the new host's expected text is not save.json's");
  // a retired host does nothing, even when something still calls it
  want(h1.pump(RL.now + 5000, true) === false, "the retired host still pumps");
  want(h1.maybeSave(true, RL.now + 5000) == null, "the retired host still saves");
  want(h1.handover(H.__ctl.S.files.get(SAVE_PATH)) === null, "the retired host would hand its world over again");
  // timers and tasks: the new copies own exactly main.js's (one 1 s timer, the nextCommand loop)
  const built = RL.copies.filter((c) => c.gen === RL.gen);
  const timers = built.map((c) => c.timers.length);
  const every = built.every((c) => c.timers.length === 1 && c.timers[0].every && c.timers[0].ms === 1000);
  const tasks = built.map(pending);
  want(every, `timers per new copy ${JSON.stringify(timers)} (main.js arms one 1 s timer each)`);
  want(tasks.every((n) => n === 1), `pending tasks per new copy ${JSON.stringify(tasks)} (the nextCommand loop each; the load task finished)`);
  const released = RL.released.filter((c) => c.gen === RL.prevGen);
  const left = released.map((c) => c.pendingAtRelease);
  const extra = globalKeys().filter((k) => !RL.globals0.includes(k) && k !== "__builds");
  want(!extra.length, `new globals after the reload: ${extra.join(", ")}`);
  want(!staleCx.length, `a released build's cx was used: ${staleCx.join("; ")}`);
  const hostErrors = h2.errors.map((x) => `${x.where}: ${x.message}`);
  want(!hostErrors.length, `new host errors: ${hostErrors.join("; ")}`);
  RL.checkTick = h2.world ? h2.world.state.herd.tick : 0;
  const kept = RL.copies.filter((c) => c.gen !== RL.gen).map((c) => c.name);
  return JSON.stringify({
    gen: RL.gen, fail, from: h2.stats.loadedFrom, kept, tick: RL.checkTick, tickBefore: b.tick, fileTick: b.fileTick, unsavedTicks: b.tick - b.fileTick,
    inFlight: b.inFlight, timers, tasks, releasedPendingAtRelease: left, releasedTimersAtRelease: released.map((c) => c.timersAtRelease),
  });
};

/** Some seconds after the reload: the progress reached the disk, the old host stayed silent, every copy draws. */
drv.reloadAfter = (argJson) => {
  const { declined = false } = JSON.parse(argJson || "{}");
  const h2 = RL.host;
  const h1 = RL.prevHost;
  const b = RL.before;
  const PB = buildOf(RL.prevGen);
  const fail = [];
  const want = (ok, text) => { if (!ok) fail.push(text); };
  const file = H.__ctl.S.files.get(SAVE_PATH);
  const from = declined ? b.fileTick : b.tick; // declined: the other window's world, as loaded
  want(tickOf(file) >= from, `save.json has tick ${tickOf(file)}, behind the world the new host took (${from})`);
  want(h2.ownTexts.includes(file), "save.json does not hold a text the new host wrote");
  want(h2.world.state.herd.tick > RL.checkTick, "the world stopped after the reload");
  want(h1.stats.saves === b.saves && h1.ownTexts.length === b.own, "the retired host wrote after the reload");
  want(h1.stats.pumps === b.pumps && h1.stats.reloads === b.reloads, `the old host still pumps (${h1.stats.pumps - b.pumps}) or reloads save.json (${h1.stats.reloads - b.reloads})`);
  const writes = H.__ctl.S.calls.writes.filter((w) => w.seq > b.writes);
  const foreign = writes.filter((w) => !String(w.by || "").endsWith(`@b${RL.gen}`));
  want(!foreign.length, `writes after the reload not from the new build: ${JSON.stringify(foreign)}`);
  want(h2.stats.reloads === 0, `the new host reloaded save.json ${h2.stats.reloads}× (a write conflict)`);
  const chips = RL.copies.filter((c) => !c.last || JSON.stringify(treeOf(c.last)).indexOf("hit a snag") >= 0).map((c) => c.name);
  want(!chips.length, `copies not drawing after the reload: ${chips.join(", ")}`);
  const hostErrors = h2.errors.map((x) => `${x.where}: ${x.message}`);
  want(!hostErrors.length, `host errors: ${hostErrors.join("; ")}`);
  want(!(RL.stepErrors || []).length, `timer/render errors: ${(RL.stepErrors || []).join("; ")}`);
  want(!staleCx.length, `a released build's cx was used: ${staleCx.join("; ")}`);
  const back = RL.ticks.filter((t, i) => i > 0 && t < RL.ticks[i - 1]).length;
  want(!back, "the herd's tick went backwards across a reload");
  RL.stepErrors = [];
  return JSON.stringify({
    fail, fileTick: tickOf(file), tick: h2.world.state.herd.tick, writes: writes.length, saves: h2.stats.saves,
    retainedWorldBytes: h1.world ? PB.W.serialize(h1.world).length : 0, retainedMemo: h1.memo && h1.memo.map ? h1.memo.map.size : 0,
    shimErrs: SHIM_ERRS.splice(0), copyErrors: copyErrors.splice(0),
  });
};

globalThis.__drv = drv;
