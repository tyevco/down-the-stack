// game/view/chrome.js (partyView, nameplateView, hudView) against the real engine: every demo world
// (game/demo.js) plus a 30-hero herd, a herd with off-duty heroes, Contractors and remote agents.
//  1. shape: every key the sample VMs (tools/vm-samples/{party,nameplate,hud}.mjs) use exists with
//     the same type; no NaN / Infinity / undefined anywhere; colours are hex;
//  2. render: the VMs go through the real roles (ui/party.js, ui/nameplate.js, ui/hud.js) inside a
//     mocked render pass at the widths / zooms each role supports, with zero validator errors and
//     inside the element budget;
//  3. stability: ticking a demo world keeps keys and row order (rows never re-sort, D§11.11);
//  4. behaviour: grouping, agentOrder, chips, off duty, slim rows, calm, the nameplate index;
//  5. performance: view + render per call in V8, with generous bounds.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("../tools/mock/index.mjs");
const { View } = await import("gpui-kit");
const { props } = await import("herdr");
const V = await import("../mods/down-the-stack/game/view.js");
const Chrome = await import("../mods/down-the-stack/game/view/chrome.js");
const D = await import("../mods/down-the-stack/game/demo.js");
const W = await import("../mods/down-the-stack/game/world.js");
const PartyMod = await import("../mods/down-the-stack/ui/party.js");
const PlateMod = await import("../mods/down-the-stack/ui/nameplate.js");
const HudMod = await import("../mods/down-the-stack/ui/hud.js");
const PS = await import("../tools/vm-samples/party.mjs");
const NS = await import("../tools/vm-samples/nameplate.mjs");
const HS = await import("../tools/vm-samples/hud.mjs");

const NOW = Date.UTC(2026, 10, 24, 9, 30);
const DAY = 86400000;
const ROLE = { party: PartyMod, nameplate: PlateMod, hud: HudMod };
const VIEW = { party: V.partyView, nameplate: V.nameplateView, hud: V.hudView };

// ---------------------------------------------------------------------------------------------
// worlds

const worlds = new Map();
function demo(kind) {
  if (!worlds.has(kind)) worlds.set(kind, D.demoWorld(kind, NOW).world);
  return worlds.get(kind);
}

/** Ticks a demo world forward `sec` seconds through its own scripted cast. */
function advance(world, sec) {
  const now = world.state.herd.lastMs + sec * 1000;
  W.tick(world, D.demoSnapshot(world, now));
  return now;
}

/** Ends some agents' terminals (their heroes go off duty) and ticks once. */
function closeTerminals(world, addresses) {
  for (const ag of world.rt.demo.cast.agents) {
    if (!addresses.includes(ag.address)) continue;
    ag.plan = [["gone", 1e9]];
    ag.phase = 0;
    ag.left = 1e9;
    ag.status = "gone";
  }
  return advance(world, 1);
}

/**
 * A herd of n live heroes in two spaces, hired over several days (6 a day, D§3.4), the last
 * minutes of play run by the engine. extra: agents added on the last day (Contractors once the
 * daily hires are used up).
 */
function bigWorld(n, { extra = [], nowMs = NOW } = {}) {
  const plans = [
    [["working", 3000]], [["working", 400], ["blocked", 1e9]], [["working", 200], ["done", 1e9]],
    [["working", 900], ["idle", 1e9]], [["working", 1e9]],
  ];
  const progs = ["claude", "codex", "pi", "opencode", "gemini"];
  const days = Math.max(1, Math.ceil(n / 6));
  const t0 = nowMs - days * DAY;
  const ags = [];
  for (let k = 0; k < n; k++) {
    const second = k >= n / 2;
    ags.push(D.makeAgent({
      address: `t${k + 1}`, program: progs[k % progs.length], space: second ? "spc_2" : "spc_1", spaceName: second ? "infra" : "herdr-app",
      tab: `tab_${k >> 2}`, tabIndex: k >> 2, plan: plans[k % plans.length], from: t0 + Math.floor(k / 6) * DAY, pinned: k === 7, titleIdx: k,
    }));
  }
  for (const spec of extra) ags.push(D.makeAgent(Object.assign({ from: t0 + (days - 1) * DAY }, spec)));
  const cast = D.makeCast(ags, { focus: "t2" });
  const world = W.createWorld({ nowMs: t0, seed: 99 });
  D.runCast(world, cast, t0 + 1000);
  // the app reopens on each hiring day, then 5 minutes before now (offline gaps: no combat)
  const opens = [];
  for (let d = 1; d < days; d++) opens.push(t0 + d * DAY);
  opens.push(nowMs - 5 * 60000);
  for (const at of opens) {
    D.advanceCast(cast, (at - world.state.herd.lastMs) / 1000);
    W.tick(world, D.castSnapshot(cast, at));
  }
  D.runCast(world, cast, nowMs);
  world.rt.demo = { cast };
  return world;
}

let BIG = null;
const big = () => (BIG ??= bigWorld(30));

// ---------------------------------------------------------------------------------------------
// shape conformance against the sample VMs

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
// keys the samples (or the ui JSDoc) allow to be null, with the type they have otherwise
const NULLABLE = {
  address: "string", pane: "string", programIcon: "object", levelUpAge: "number", machine: "string", sprint: "object",
  terminal: "string", mapPin: "object", digestTip: "string",
};
// keys only some items carry (the fork chip's terminal, chip tooltips): checked when present
const OPTIONAL = new Set(["terminal", "tooltip"]);
const HEX_KEYS = new Set(["color", "stripe", "hoodie", "titleBar", "screen", "faceInk"]);
const isHex = (s) => typeof s === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s);

/** Every key the sample has must be in `actual` with the same type (arrays: the keys all sample items share). */
function conform(actual, sample, path, errs) {
  const ta = typeOf(actual), ts = typeOf(sample);
  const leaf = path.split(/[.[\]]/).filter(Boolean).pop();
  if (ts === "null" || ta === "null") {
    if (ta === ts) return;
    const allowed = NULLABLE[leaf];
    if (ts === "null" && allowed && ta === allowed) return;
    if (ta === "null" && allowed && ts === allowed) return;
    errs.push(`${path}: ${ta} (sample ${ts})`);
    return;
  }
  if (ta !== ts) { errs.push(`${path}: ${ta} (sample ${ts})`); return; }
  if (ts === "array") {
    const items = sample.filter((x) => x !== null && typeof x === "object" && !Array.isArray(x));
    if (!items.length) {
      if (sample.length) for (let i = 0; i < actual.length; i++) if (typeOf(actual[i]) !== typeOf(sample[0])) errs.push(`${path}[${i}]: ${typeOf(actual[i])}`);
      return;
    }
    const shared = Object.keys(items[0]).filter((k) => items.every((x) => k in x));
    const proto = {};
    for (const k of shared) proto[k] = (items.find((x) => x[k] !== null) ?? items[0])[k];
    for (let i = 0; i < actual.length; i++) conform(actual[i], proto, `${path}[${i}]`, errs);
    return;
  }
  if (ts === "object") {
    for (const k of Object.keys(sample)) {
      if (!(k in actual)) {
        if (!OPTIONAL.has(k)) errs.push(`${path}.${k}: missing`);
        continue;
      }
      conform(actual[k], sample[k], `${path}.${k}`, errs);
    }
  }
}

/** No NaN / Infinity / undefined anywhere; colour fields are hex; keys and names are strings. */
function clean(v, path, errs) {
  const t = typeOf(v);
  if (v === undefined) errs.push(`${path}: undefined`);
  else if (t === "number" && !Number.isFinite(v)) errs.push(`${path}: ${v}`);
  else if (t === "array") v.forEach((x, i) => clean(x, `${path}[${i}]`, errs));
  else if (t === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (HEX_KEYS.has(k) && x !== null && !isHex(x)) errs.push(`${path}.${k}: not hex (${x})`);
      if ((k === "key" || k === "name" || k === "tooltip" || k === "text" || k === "title") && typeof x !== "string") errs.push(`${path}.${k}: ${typeOf(x)}`);
      clean(x, `${path}.${k}`, errs);
    }
  }
}

function assertShape(vm, sample, label) {
  const errs = [];
  conform(vm, sample, label, errs);
  clean(vm, label, errs);
  assert.deepEqual(errs, [], label);
}

// the richest samples of each role (every row / chip / footer field in use)
const PARTY_SAMPLE = PS.scenarios.six;
const PLATE_SAMPLE = NS.scenarios.focused;
const HUD_SAMPLE = HS.scenarios.normal;

const liveAddresses = (world) => Array.from(world.rt.bind.keys());

test("shape: partyView / nameplateView / hudView match the sample VMs for every demo world", () => {
  for (const kind of D.DEMO_KINDS) {
    const world = demo(kind);
    for (const width of [52, 268, 420]) {
      const vm = V.partyView(world, { width, nowMs: NOW });
      assertShape(vm, PARTY_SAMPLE, `party/${kind}@${width}`);
      assert.equal(vm.compact, width < 160);
    }
    for (const t of liveAddresses(world)) {
      const live = world.rt.live.get(world.rt.bind.get(t));
      assertShape(V.nameplateView(world, { terminal: t, pane: live.pane }), PLATE_SAMPLE, `plate/${kind}/${t}`);
    }
    assertShape(V.hudView(world, { nowMs: NOW }), HUD_SAMPLE, `hud/${kind}`);
  }
});

test("shape: a 30-hero herd, off-duty heroes, Contractors and remote agents match the samples too", () => {
  const w = big();
  assert.equal(w.rt.live.size, 30);
  assertShape(V.partyView(w, { width: 268, nowMs: NOW }), PS.scenarios.crowded, "party/big");
  const mid = D.demoWorld("mid", NOW).world;
  closeTerminals(mid, ["t3", "t6"]);
  const vm = V.partyView(mid, { width: 268, nowMs: NOW + 60000 });
  assertShape(vm, PARTY_SAMPLE, "party/off-duty");
  const c = bigWorld(6, { extra: [{ address: "vps/t9", program: "claude", space: "spc_1", spaceName: "herdr-app", plan: [["working", 1e9]] }] });
  const cv = V.partyView(c, { width: 268, nowMs: NOW });
  assertShape(cv, PARTY_SAMPLE, "party/contractor");
  for (const t of liveAddresses(c)) assertShape(V.nameplateView(c, { terminal: t }), PLATE_SAMPLE, `plate/contractor/${t}`);
});

// ---------------------------------------------------------------------------------------------
// render through the real roles

/** A GameHost stand-in over a real world: view() is game/view.js, command() is world.command. */
function worldHost(world) {
  return {
    world, version: 1, views: [], commands: [], claim: () => true,
    view(kind, args) { this.views.push([kind, args]); return VIEW[kind] ? VIEW[kind](world, args) : null; },
    command(name, args) { this.commands.push([name, args]); return W.command(world, name, args, world.rt.nowMs); },
  };
}

/** herdr's PaneInfo for a live hero's terminal (what panes() reports). */
function paneOf(live, over = {}) {
  return {
    pane: live.pane, terminal: live.address, tab: live.tab, title: live.title || "✳ agent", name: null,
    cwd: "/mock/user/src/herdr-app", branch: "main", status: live.status, app: live.app,
    program: Object.assign({ shell: false, agent: true }, live.program || {}), focused: !!live.focused, zoomed: false, movable: true,
    scroll: { total: 200, offset: 160, len: 40, from_bottom: 0 }, ...over,
  };
}

async function mount(kind, world, { width = 268, height = 460, zoom = 1, theme = "graphite", roleProps = {}, fixture = {} } = {}) {
  M.resetState();
  M.resetStorage();
  const host = worldHost(world);
  const R = ROLE[kind].default;
  class Wrap extends View {
    init(_p, cx) { this.role = new R(); this.role.init(props() ?? { role: kind, ...roleProps }, cx, host); }
    render(cx) { return this.role.render(cx); }
  }
  const m = await M.mountView(Wrap, { props: { role: kind, ...roleProps }, fixture: { settings: { zoom }, theme, ...fixture }, nowMs: NOW });
  m.render();
  m.size(width * zoom, height * zoom);
  m.render();
  return { m, host };
}

// herdr's render budget is wall-clock time, and the mock flags any render over it ("budget"). Under
// load (parallel test files, a browser shooting previews) a slow render says nothing about the
// code: load only adds time, waiting for a CPU. So a view the mock flagged is rendered again, each
// render's cost taken as the lower of the mock's script time (stats.lastRenderMs, its stopwatch)
// and the process's CPU time for the whole render (no waiting; the mock's own checks and GC
// threads are in it), and the best of 5 must fit. Every other validator error counts as it is.
const isRenderBudget = (e) => e.code === "budget" && /^render took/.test(String(e.message));
/** One render's cost (ms): min(the mock's script time, CPU time of the whole render). */
function renderCost(m) {
  const c0 = process.cpuUsage();
  m.render();
  const c = process.cpuUsage(c0);
  return Math.min(m.stats.lastRenderMs, (c.user + c.system) / 1000);
}
function bestRenderMs(m, n = 5) {
  let best = Infinity;
  for (let k = 0; k < n; k++) best = Math.min(best, renderCost(m));
  return best;
}
function errorsOf(m) {
  const out = m.errors.filter((e) => !isRenderBudget(e)).map((e) => `${e.code}: ${e.message}`);
  if (m.errors.some(isRenderBudget) && m.view) {
    const best = bestRenderMs(m);
    if (best > M.BUDGET.render) out.push(`budget: the best of 5 renders took ${best.toFixed(1)} ms (herdr's budget is ${M.BUDGET.render} ms)`);
  }
  return out;
}
const badWarnings = (m) => m.warnings.filter((w) => ["duplicate-id", "many-elements", "frames-children", "transition-no-id"].includes(w.code)).map((w) => `${w.code}: ${w.message}`);
function assertClean(m, label, budget = 400) {
  assert.ok(m.tree, `${label}: render failed: ${errorsOf(m).join("; ")}`);
  assert.deepEqual(errorsOf(m), [], label);
  assert.deepEqual(badWarnings(m), [], label);
  assert.ok(m.stats.elements < budget, `${label}: ${m.stats.elements} elements`);
}
const ids = (m) => new Set(m.findAll((n) => n.id != null).map((n) => n.id));

test("render: the party role draws every demo world at rail / narrow / default / wide widths, zoom 1 and 2", async () => {
  for (const kind of D.DEMO_KINDS) {
    for (const width of [52, 200, 268, 420]) {
      for (const zoom of [1, 2]) {
        const { m } = await mount("party", demo(kind), { width, zoom, theme: zoom === 2 ? "paper" : "graphite" });
        assertClean(m, `party/${kind} w${width} z${zoom}`);
        if (width >= 160 && kind !== "empty") assert.ok(m.text().includes(demo(kind).state.heroes[0].name), `${kind}: names shown`);
      }
    }
  }
});

test("render: the nameplate role draws every live hero's pane header at 220–1400 px, zoom 1 and 2, hovered too", async () => {
  for (const kind of D.DEMO_KINDS) {
    const world = demo(kind);
    for (const t of liveAddresses(world)) {
      const live = world.rt.live.get(world.rt.bind.get(t));
      const pane = paneOf(live);
      for (const width of [220, 360, 590, 760, 1400]) {
        for (const zoom of [1, 2]) {
          const { m, host } = await mount("nameplate", world, { width, height: 34, zoom, roleProps: { pane: pane.pane, terminal: t }, fixture: { panes: [pane] } });
          const where = `plate/${kind}/${t} w${width} z${zoom}`;
          assertClean(m, where);
          assert.deepEqual(host.views.at(-1), ["nameplate", { terminal: t, pane: pane.pane }]);
          // narrow headers keep the terminal title (which task the pane is) before the level
          if (width >= 360) assert.ok(m.text().includes(`Lv ${world.state.heroes.find((h) => h.id === live.heroId)?.L ?? ""}`), where);
          else assert.ok(m.text().includes(pane.title), `${where}: the terminal title stays`);
          m.hover(`pane-head-${pane.pane}`);
          m.render();
          assertClean(m, `${where} hovered`);
        }
      }
    }
  }
});

test("render: the HUD role draws every demo world at 360–1600 px, zoom 1 and 2", async () => {
  for (const kind of D.DEMO_KINDS) {
    for (const width of [360, 520, 960, 1600]) {
      for (const zoom of [1, 2]) {
        const { m } = await mount("hud", demo(kind), { width, height: 26, zoom });
        assertClean(m, `hud/${kind} w${width} z${zoom}`);
      }
    }
  }
});

test("render: 30 live heroes use slim rows and stay well inside the element budget, off duty unfolded too", async () => {
  const w = bigWorld(30);
  closeTerminals(w, ["t29", "t30"]);
  const vm = V.partyView(w, { width: 268, nowMs: NOW });
  const rows = vm.groups.flatMap((g) => g.rows);
  assert.equal(rows.length, 30);
  assert.ok(rows.every((r) => r.slim), "28 live heroes: every row slim");
  const { m } = await mount("party", w, { width: 268, height: 820 });
  assertClean(m, "big party", 360);
  m.fire("pg-g:off");
  m.render();
  assertClean(m, "big party, off duty unfolded", 360);
  assert.ok(m.node("pr-h:29") || m.node(`pr-${vm.groups.at(-1).rows[0].key}`));
  // a dozen heroes keep the full 44 px rows
  const small = bigWorld(12);
  assert.ok(V.partyView(small, { width: 268, nowMs: NOW }).groups.every((g) => g.rows.every((r) => !r.slim)));
});

// ---------------------------------------------------------------------------------------------
// stability

test("stability: ticking demo worlds keeps group / row keys, row order and agentOrder (rows never re-sort)", async () => {
  for (const kind of ["first-day", "mid", "boss", "blocked", "late"]) {
    const world = D.demoWorld(kind, NOW).world;
    const before = V.partyView(world, { width: 268, nowMs: NOW });
    const order = (vm) => vm.groups.map((g) => `${g.key}:${g.rows.map((r) => r.key).join(",")}`).join("|");
    const statuses = new Set();
    let now = NOW;
    for (let k = 0; k < 12; k++) {
      now = advance(world, 5);
      const vm = V.partyView(world, { width: 268, nowMs: now });
      for (const g of vm.groups) for (const r of g.rows) statuses.add(`${r.key}:${r.status}`);
      assert.equal(order(vm), order(before), `${kind} after ${5 * (k + 1)} s`);
      assert.deepEqual(vm.agentOrder, before.agentOrder, kind);
      for (const g of vm.groups) for (const r of g.rows) for (const c of r.chips) assert.ok(c.key.startsWith(`c:${r.heroId}:`), c.key);
    }
    if (kind === "first-day") assert.ok(statuses.size > before.groups[0].rows.length, "statuses changed while the rows stayed put");
  }
});

test("stability: element ids survive ticks in the rendered party, nameplate and HUD", async () => {
  // party ids that belong to rows (not chips, which come and go with their state)
  const rowIds = (mm) => new Set([...ids(mm)].filter((id) => /^p[rpg]-/.test(id)));
  const cases = [
    ["party", (world) => ({}), rowIds],
    ["nameplate", (world) => {
      const pane = paneOf(world.rt.live.get(world.rt.bind.get("t1")));
      return { width: 760, height: 34, roleProps: { pane: pane.pane, terminal: "t1" }, fixture: { panes: [pane] } };
    }, ids],
    ["hud", () => ({ width: 1170, height: 26 }), ids],
  ];
  for (const [kind, opts, idsOf] of cases) {
    const world = D.demoWorld("mid", NOW).world;
    const { m } = await mount(kind, world, opts(world));
    const before = idsOf(m);
    for (let k = 0; k < 4; k++) {
      advance(world, 3);
      m.render();
      assertClean(m, `${kind} tick ${k}`);
      assert.deepEqual([...idsOf(m)].sort(), [...before].sort(), kind);
    }
  }
});

test("memo: the same world version gives the same VM object; a tick or a command gives a fresh one", () => {
  const world = D.demoWorld("mid", NOW).world;
  const a = V.partyView(world, { width: 268, nowMs: NOW });
  assert.equal(V.partyView(world, { width: 300, nowMs: NOW + 5000 }), a, "same version, same minute, both wide");
  assert.notEqual(V.partyView(world, { width: 52, nowMs: NOW }), a, "the rail is another VM");
  const p = V.nameplateView(world, { terminal: "t1" });
  assert.equal(V.nameplateView(world, { terminal: "t1", pane: "p_t1" }), p);
  const h = V.hudView(world, { nowMs: NOW });
  advance(world, 1);
  assert.notEqual(V.partyView(world, { width: 268, nowMs: NOW + 1000 }), a);
  assert.notEqual(V.nameplateView(world, { terminal: "t1" }), p);
  const h2 = V.hudView(world, { nowMs: NOW });
  assert.notEqual(h2, h);
  assert.equal(W.command(world, "setting", { key: "calm", value: true }, NOW).ok, true);
  const h3 = V.hudView(world, { nowMs: NOW });
  assert.notEqual(h3, h2);
  assert.equal(h3.calm, true);
});

// ---------------------------------------------------------------------------------------------
// behaviour

test("party: an off-duty hero's pending chest shows on the folded group and its row; near opening Unreviewed it lights the Herd dot", async () => {
  const world = D.demoWorld("mid", NOW).world;
  closeTerminals(world, ["t2", "t6"]);
  const hero = world.state.heroes.find((h) => h.id === 6);
  for (const h of world.state.heroes) if (h.id === 2) h.pend = []; // the other one off duty: none
  const DAY = 86400000;
  const now = world.state.herd.lastMs;
  // a chest shipped an hour ago: shown, no dot for it yet
  hero.pend = [{ min: 10, fmin: 0, title: "Bump deps", at: now - 3600e3, sealFactor: 1 }];
  world.rt.version++;
  const { digestDot } = await import("../mods/down-the-stack/game/herd.js");
  const dotBefore = digestDot(world);
  let vm = V.partyView(world, { width: 268, nowMs: now });
  let off = vm.groups.at(-1);
  assert.equal(off.offDuty, true);
  assert.equal(off.chests, 1, "the group counts its pending chests");
  const row = off.rows.find((r) => r.heroId === 6);
  assert.equal(row.chestPending, true);
  assert.match(row.tooltip, /opens Unreviewed in 23h/);
  assert.equal(vm.footer.digestDot, dotBefore, "not yet");
  // 21 h later (3 h before it opens Unreviewed, half value, no Seals): the Herd button's dot
  hero.pend.push({ min: 5, fmin: 0, title: "Fix it", at: now - 1800e3, sealFactor: 1 });
  hero.pend[0].at = now - 21 * 3600e3;
  world.rt.version++;
  vm = V.partyView(world, { width: 268, nowMs: now });
  off = vm.groups.at(-1);
  assert.equal(off.chests, 2);
  assert.equal(vm.footer.digestDot, true, "an off-duty chest about to open Unreviewed lights the dot");
  assert.equal(V.hudView(world, { nowMs: now }).digestDot, true, "the HUD's too");
  assert.match(off.rows.find((r) => r.heroId === 6).tooltip, /opens Unreviewed in 3h/);
  // no chests anywhere off duty: 0
  hero.pend = [];
  world.rt.version++;
  assert.equal(V.partyView(world, { width: 268, nowMs: now + DAY }).groups.at(-1).chests, 0);
});

test("the Herd dot stays lit after chests opened Unreviewed until the Digest is viewed (party footer and HUD), its tooltip says why", async () => {
  const A = await import("../mods/down-the-stack/game/agents.js");
  const world = D.demoWorld("mid", NOW).world;
  closeTerminals(world, ["t6"]);
  const hero = world.state.heroes.find((h) => h.id === 6);
  const now = world.state.herd.lastMs;
  world.rt.digestDot = false; // nothing "since you last looked" from the demo's own history
  hero.pend = [{ min: 10, fmin: 0, title: "Bump deps", at: now - 25 * 3600e3, sealFactor: 1 }, { min: 5, fmin: 0, title: "Fix it", at: now - 24.5 * 3600e3, sealFactor: 1 }];
  world.rt.version++;
  // due: the chests open Unreviewed (half value, no Seals): gone from the party, logged as a loss
  const ev = W.makeEmitter(world, { live: true });
  A.expireChests(world, hero, ev);
  world.rt.version++;
  assert.equal(hero.pend.length, 0);
  assert.ok((world.state.herd.log || []).some((e) => e[1] === "unrev" && e[2] === 6));
  assert.equal(Chrome.unseenUnreviewed(world), 2);
  const tip = "Herd panel: 2 chests opened Unreviewed (half value, no Seals): the Digest lists them";
  let vm = V.partyView(world, { width: 268, nowMs: now + 60000 });
  assert.equal(vm.footer.digestDot, true, "lit although no chest waits any more");
  assert.equal(vm.footer.digestTip, tip);
  let hud = V.hudView(world, { nowMs: now + 60000 });
  assert.equal(hud.digestDot, true);
  assert.equal(hud.digestTip, tip);
  // rendered: the party's Herd button and the HUD's say it
  const { m } = await mount("party", world);
  assert.equal(m.node("party-herd").methods.find((x) => x[0] === "tooltip")[1][0], tip);
  const h = await mount("hud", world, { width: 1200, height: 26 });
  assert.equal(h.m.node("hud-herd").methods.find((x) => x[0] === "tooltip")[1][0], tip);
  // still lit an hour later; the Digest viewed (digestSeen): off
  vm = V.partyView(world, { width: 268, nowMs: now + 3600e3 });
  assert.equal(vm.footer.digestDot, true);
  assert.equal(W.command(world, "digestSeen", {}, now + 3600e3).ok, true);
  vm = V.partyView(world, { width: 268, nowMs: now + 3600e3 });
  assert.equal(vm.footer.digestDot, false);
  assert.equal(vm.footer.digestTip, null);
  hud = V.hudView(world, { nowMs: now + 3600e3 });
  assert.equal(hud.digestDot, false);
  assert.equal(Chrome.unseenUnreviewed(world), 0);
  // a saved count, when the engine keeps one (round 4 E4), wins over the journal
  world.state.herd.unseenUnrev = 3;
  world.rt.version++;
  assert.equal(Chrome.unseenUnreviewed(world), 3);
  assert.match(V.hudView(world, { nowMs: now + 3600e3 }).digestTip, /^Herd panel: 3 chests opened Unreviewed/);
});

test("party: groups by space in herdr's order, off duty last; agentOrder = live rows top to bottom; a pin never moves a row", () => {
  const world = D.demoWorld("mid", NOW).world;
  const vm = V.partyView(world, { width: 268, nowMs: NOW });
  assert.deepEqual(vm.groups.map((g) => g.name), ["herdr-app", "api-gateway"]);
  assert.deepEqual(vm.groups.map((g) => g.rows.map((r) => r.address)), [["t1", "t2", "t3", "t4"], ["t5", "t6"]]);
  assert.deepEqual(vm.agentOrder, ["t1", "t2", "t3", "t4", "t5", "t6"]);
  assert.equal(vm.count, 6);
  assert.equal(vm.title, "The Herd");
  const t5 = vm.groups[1].rows[0];
  assert.equal(t5.pinned, true, "t5 is pinned and keeps its place");
  // pinning another one at runtime moves nothing
  world.rt.demo.cast.agents.find((a) => a.address === "t4").pinned = true;
  advance(world, 1);
  const after = V.partyView(world, { width: 268, nowMs: NOW + 1000 });
  assert.deepEqual(after.agentOrder, vm.agentOrder);
  assert.equal(after.groups[0].rows[3].pinned, true);
  // off duty: closed terminals go to one group at the bottom, without address / pane
  closeTerminals(world, ["t2", "t6"]);
  const off = V.partyView(world, { width: 268, nowMs: NOW + 120000 });
  assert.deepEqual(off.groups.map((g) => g.key), ["g:space:spc_1", "g:space:spc_2", "g:off"]);
  const offRows = off.groups.at(-1).rows;
  assert.deepEqual(offRows.map((r) => r.heroId).sort(), [2, 6]);
  for (const r of offRows) {
    assert.equal(r.address, null);
    assert.equal(r.pane, null);
    assert.equal(r.mapLabel, "Off duty");
    assert.equal(r.status, "idle");
    assert.equal(r.face, "-_-");
    assert.match(r.tooltip, /Off duty/);
  }
  assert.deepEqual(off.agentOrder, ["t1", "t3", "t4", "t5"]);
  assert.equal(off.count, 6);
  // agentOrder is the rows as drawn, even when herdr's order interleaves spaces (an orphan
  // sub-agent playing as a top-level hero comes after every agent in live.order)
  const w2 = D.demoWorld("mid", NOW).world;
  w2.rt.live.get(w2.rt.bind.get("t2")).order = 99;
  w2.rt.version++;
  const iv = V.partyView(w2, { width: 268, nowMs: NOW });
  assert.deepEqual(iv.groups.map((g) => g.rows.map((r) => r.address)), [["t1", "t3", "t4", "t2"], ["t5", "t6"]]);
  assert.deepEqual(iv.agentOrder, ["t1", "t3", "t4", "t2", "t5", "t6"]);
});

test("party: status stripes, faces and chips follow the engine (blocked clock, Forklings, chest, boss)", () => {
  const mid = V.partyView(demo("mid"), { width: 268, nowMs: NOW });
  const rows = Object.fromEntries(mid.groups.flatMap((g) => g.rows).map((r) => [r.address, r]));
  assert.equal(rows.t2.status, "blocked");
  assert.equal(rows.t2.stripe, "#F2A93B");
  assert.equal(rows.t2.face, "o_o");
  assert.ok(rows.t2.focused);
  assert.equal(rows.t1.stripe, "#4CC38A");
  assert.equal(rows.t4.stripe, "#FFD447");
  assert.equal(rows.t4.face, "^_^");
  const fork = rows.t5.chips.find((c) => c.kind === "fork");
  assert.equal(fork.text, "2");
  assert.equal(fork.terminal, "s5b", "the blocked sub-agent first");
  assert.equal(fork.color, "#F2A93B", "a waiting sub-agent turns the chip amber");
  assert.equal(rows.t5.chips[0].kind, "fork", "and makes it urgent (slim rows show two chips)");
  assert.match(fork.tooltip, /Ask about the schema \(blocked\)/);
  // the blocked clock: "!" until 120 s, then minutes, capped at "1h+"
  const blocked = V.partyView(demo("blocked"), { width: 268, nowMs: NOW });
  const texts = blocked.groups[0].rows.filter((r) => r.status === "blocked").map((r) => r.chips.find((c) => c.kind === "blocked").text);
  assert.ok(texts.every((t) => /^! (\d+m|1h\+)$/.test(t)), texts.join());
  // boss participants carry a red BOSS chip with the pool left
  const boss = V.partyView(demo("boss"), { width: 268, nowMs: NOW });
  for (const r of boss.groups[0].rows) {
    const c = r.chips.find((x) => x.kind === "boss");
    assert.ok(c, r.name);
    assert.match(c.text, /^BOSS \d{1,3}%$/);
    assert.equal(c.color, "#FF5A5F");
    assert.match(r.tooltip, /Fighting The Octopus Merge: \d+% left/);
  }
  // a pending chest: the chest chip and chestPending
  const day = V.partyView(demo("first-day"), { width: 268, nowMs: NOW });
  const withChest = day.groups[0].rows.filter((r) => r.chestPending);
  assert.ok(withChest.length > 0);
  for (const r of withChest) assert.ok(r.chips.some((c) => c.kind === "chest" && c.color === "#FFD447"));
});

test("party: a sub-agent waiting for you (a blocked Forkling) counts in 'N need you' and marks its group; a click peeks it", async () => {
  const world = D.demoWorld("mid", NOW).world;
  const id = world.rt.bind.get("t5");
  const live = world.rt.live.get(id);
  const hero = world.state.heroes.find((h) => h.id === id);
  assert.equal(live.status, "working", "the parent itself does not wait");
  const sub = live.forklings.find((x) => x.status === "blocked");
  assert.ok(sub, "the mid demo's t5 has a blocked sub-agent");
  const vm = V.partyView(world, { width: 268, nowMs: NOW });
  const row = vm.groups.flatMap((g) => g.rows).find((r) => r.heroId === id);
  assert.deepEqual(row.waitingForks, [{
    key: `wf:${sub.address}`, address: sub.address, name: `${hero.name}'s sub-agent`,
    tooltip: `A sub-agent of ${hero.name} waits for you on “Ask about the schema” · click to show it`,
  }]);
  // only waiting ones: a working sub-agent is not listed; off-duty rows have none
  assert.ok(vm.groups.flatMap((g) => g.rows).every((r) => Array.isArray(r.waitingForks)));
  assert.equal(row.waitingForks.length, live.forklings.filter((x) => x.status === "blocked").length);
  // rendered: "N need you" counts the blocked rows plus the waiting sub-agent; its group has the "!"
  const blockedRows = vm.groups.flatMap((g) => g.rows).filter((r) => !r.address ? false : r.status === "blocked").length;
  const { m, host } = await mount("party", world);
  assertClean(m, "mid");
  const chip = m.node("party-needyou");
  const text = (n) => [n.type === "text" ? n.text : "", ...n.children.map(text)].join("");
  assert.equal(text(chip), `${blockedRows + 1} ${blockedRows + 1 === 1 ? "needs" : "need"} you`);
  assert.ok(chip.methods.find((x) => x[0] === "tooltip")[1][0].includes(`${hero.name}'s sub-agent`));
  const group = vm.groups.find((g) => g.rows.includes(row));
  assert.ok(text(m.node(`pg-${group.key}`)).includes("!"));
  // the fork chip (amber) peeks it: no pane (D§2.7)
  m.fire(`pc-c:${id}:fork`);
  assert.deepEqual(M.calls().run.filter((c) => c.name === "terminal.peek").map((c) => c.args), [{ terminal: sub.address }]);
  assert.deepEqual(host.commands, []);
  // when it stops waiting, it no longer counts
  sub.status = "working";
  world.rt.version++;
  assert.deepEqual(V.partyView(world, { width: 268, nowMs: NOW }).groups.flatMap((g) => g.rows).find((r) => r.heroId === id).waitingForks, []);
});

test("every count of what needs the person agrees: the party's 'N need you', the Herd panel header and the HUD's tooltip (blocked heroes plus blocked sub-agents, owner decision 3; round 4b U2)", async () => {
  const world = D.demoWorld("mid", NOW).world;
  const pairs = [...world.rt.live.entries()];
  // one hero blocked, plus the t5 hero's blocked sub-agent, plus one more blocked sub-agent under a
  // working hero (a Contractor's counts the same way)
  const [, someLive] = pairs.find(([, l]) => l.address !== "t5" && l.status !== "blocked");
  const subParent = pairs.find(([, l]) => l.address !== "t5" && l !== someLive)[1];
  subParent.forklings = (subParent.forklings || []).concat([{ address: "t990", status: "blocked", title: "sub-agent: lint fixes", program: null }]);
  someLive.status = "blocked";
  world.rt.version++;
  // the party's chip and the Herd panel's header say one number
  const chipN = PartyMod.waitingList(V.partyView(world, { width: 268, nowMs: NOW })).length;
  assert.equal(V.herdView(world, { tab: "upgrades" }).header.waiting, `${chipN} ${chipN === 1 ? "needs" : "need"} you`, "the Herd panel header says the chip's count");
  const n = Chrome.needYou(world);
  assert.ok(n.subs >= 2 && n.heroes >= 1, JSON.stringify(n));
  const heroesBlocked = pairs.filter(([, l]) => l.address && l.status === "blocked").length;
  assert.equal(n.heroes, heroesBlocked);
  const party = V.partyView(world, { width: 268, nowMs: NOW });
  assert.equal(PartyMod.waitingList(party).length, n.n, "the party chip's list");
  const herd = V.herdView(world, { tab: "upgrades" }).header;
  assert.equal(herd.waiting, `${n.n} ${n.n === 1 ? "needs" : "need"} you`, "the Herd panel header");
  assert.ok(herd.sub.endsWith(` · ${herd.waiting}`));
  const hud = V.hudView(world, { nowMs: NOW });
  assert.equal(hud.blocked, heroesBlocked, "the HUD's blocked count stays heroes (as working and shipped are)");
  assert.equal(hud.needYou, n.n);
  // rendered: the chip and the HUD's tooltip say the same number
  const { m } = await mount("party", world);
  const text = (x) => [x.type === "text" ? x.text : "", ...x.children.map(text)].join("");
  assert.equal(text(m.node("party-needyou")), herd.waiting);
  const h = await mount("hud", world, { width: 1170, height: 26 });
  const tip = h.m.node("hud-blocked").methods.find((x) => x[0] === "tooltip")[1][0];
  assert.ok(tip.includes(herd.waiting), tip);
  // nobody waits: no count anywhere
  for (const [, l] of world.rt.live) { l.status = l.status === "blocked" ? "working" : l.status; for (const x of l.forklings || []) x.status = "working"; }
  world.rt.version++;
  assert.equal(Chrome.needYou(world).n, 0);
  assert.equal(V.herdView(world, { tab: "upgrades" }).header.waiting, null);
  assert.equal(PartyMod.waitingList(V.partyView(world, { width: 268, nowMs: NOW })).length, 0);
});

test("party / nameplate: a promotion review shows REVIEW with the review named in the tooltip", () => {
  const world = D.demoWorld("mid", NOW).world;
  world.state.heroes.find((h) => h.id === 1).rev[0] = 0;
  assert.equal(W.command(world, "challenge", { kind: "review", idx: 0, heroId: 1 }, world.rt.nowMs).ok, true);
  advance(world, 2);
  const row = V.partyView(world, { width: 268, nowMs: NOW }).groups[0].rows[0];
  const c = row.chips.find((x) => x.kind === "review");
  assert.equal(c.text, "REVIEW");
  assert.match(c.tooltip, /^Senior Review against You, Six Months Ago: \d+% left$/);
  assert.match(row.tooltip.split("\n")[1], /^Senior Review against/);
  assert.deepEqual(V.nameplateView(world, { terminal: "t1" }).chip, { text: "REVIEW", short: "REVIEW", color: "#FF5A5F" });
});

/** Scripts a demo agent's status from now on (its plan holds that status) and ticks `sec` seconds. */
function setStatus(world, address, status, sec = 3) {
  const ag = world.rt.demo.cast.agents.find((a) => a.address === address);
  ag.plan = [[status, 1e9]];
  ag.phase = 0;
  ag.left = 1e9;
  if (ag.status !== status) ag.seq++; // herdr bumps seq on every status change
  ag.status = status;
  let now = 0;
  for (let k = 0; k < sec; k++) now = advance(world, 1);
  return now;
}
const heroOf = (world, address) => world.rt.bind.get(address);
const rowOf = (vm, address) => vm.groups.flatMap((g) => g.rows).find((r) => r.address === address);

test("boss fights: a blocked participant's header says '! waiting' (it holds); walked-out done / idle ones show their own state", () => {
  // D§9.5: blocked participants hold in the arena; idle or done ones walk out (and may rejoin)
  const world = D.demoWorld("boss", NOW).world;
  const now = setStatus(world, "t2", "blocked");
  const fight = world.rt.fights.find((f) => f.kind === "boss");
  assert.ok(fight && fight.heroIds.includes(heroOf(world, "t2")), "t2 is still a participant");
  const plate = V.nameplateView(world, { terminal: "t2" });
  assert.match(plate.chip.text, /^! waiting/);
  assert.equal(plate.chip.color, "#F2A93B");
  assert.equal(plate.face, "o_o");
  const lines = plate.tooltip.split("\n");
  assert.match(lines[2], /^Waiting for you for \d+s on “Bump deps and fix types”$/, "no row click hint on the pane header");
  assert.match(lines[3], /^Fighting The Octopus Merge: \d+% left · holding until you answer$/);
  const row = rowOf(V.partyView(world, { width: 268, nowMs: now }), "t2");
  assert.deepEqual(row.chips.slice(0, 2).map((c) => c.kind), ["blocked", "boss"], "the row keeps the fight it holds in");
  assert.match(row.tooltip.split("\n")[1], /^Waiting for you for \d+s on “Bump deps and fix types” · click to jump there$/);
  assert.match(row.tooltip, /holding until you answer/);
  // the participants still fighting keep their BOSS chip
  assert.match(V.nameplateView(world, { terminal: "t1" }).chip.text, /^BOSS \d+%$/);

  // late demo: t12 (done, a chest waiting) and t13 (idle) are still listed in the fight
  const late = demo("late");
  const lf = late.rt.fights.find((f) => f.kind === "boss");
  for (const a of ["t12", "t13"]) assert.ok(lf.heroIds.includes(heroOf(late, a)), `${a} listed in the fight`);
  assert.equal(V.nameplateView(late, { terminal: "t12" }).chip.text, "shipped · chest ready");
  assert.equal(V.nameplateView(late, { terminal: "t13" }).chip.text, "resting");
  assert.match(V.nameplateView(late, { terminal: "t14" }).chip.text, /^BOSS \d+%$/, "a questing participant fights on");
  const lv = V.partyView(late, { width: 268, nowMs: NOW });
  for (const a of ["t12", "t13"]) {
    const r = rowOf(lv, a);
    assert.ok(!r.chips.some((c) => c.kind === "boss"), `${a}: walked out, no BOSS chip`);
    assert.ok(!/Fighting /.test(r.tooltip), a);
  }
  assert.ok(rowOf(lv, "t14").chips.some((c) => c.kind === "boss"));
});

test("tooltips name the task of a waiting agent (party row, its '!' chip and the pane header), status glyphs stripped", () => {
  const world = D.demoWorld("mid", NOW).world;
  // a real agent's terminal title carries its status glyph ("⏳ ...", "✳ ..."); herdr's agents list strips it
  world.rt.demo.cast.agents.find((a) => a.address === "t2").titles = ["⏳ Waiting for approval: run migrations?"];
  const now = setStatus(world, "t2", "blocked", 1);
  const row = rowOf(V.partyView(world, { width: 268, nowMs: now }), "t2");
  assert.match(row.tooltip.split("\n")[1], /^Waiting for you for .+ on “.+” · click to jump there$/);
  const title = row.tooltip.split("\n")[1].match(/on “(.+)”/)[1];
  assert.ok(!/^[⏳✳]/.test(title), title);
  assert.match(row.chips.find((c) => c.kind === "blocked").tooltip, /^Waiting for you for .+ on “.+”$/);
  assert.match(V.nameplateView(world, { terminal: "t2" }).tooltip.split("\n")[2], /^Waiting for you for .+ on “.+”$/);
  // the demo's own blocked hero (mid t2) names its task too
  const mid = rowOf(V.partyView(demo("mid"), { width: 268, nowMs: NOW }), "t2");
  assert.match(mid.tooltip.split("\n")[1], /^Waiting for you for .+ on “Bump deps and fix types” · click to jump there$/);
});

test("tellingTitle: herdr's agents-list test keeps out empty, program, terminal-id, path, prompt, shell and interpreter titles", () => {
  const who = { address: "t7", program: { key: "claude", name: "Claude Code" }, app: "claude-code" };
  const dull = ["", "   ", null, undefined, "Claude Code", "✳ Claude Code", "claude code", "claude", "CLAUDE-CODE", "t7", "zsh", "-bash",
    "⠋ fish", "cmd.exe", "powershell.exe", "node", "python3", "~/src/app", "✳ ~/src/app", "/usr/local/bin", "C:\\Users\\me",
    "me@box: ~/src", "me@box", "⏳", "[ ! ] "];
  for (const t of dull) assert.equal(Chrome.tellingTitle(t, who), "", JSON.stringify(t));
  const telling = [["✳ Fix flaky auth test", "Fix flaky auth test"], ["⏳ Waiting for approval: run migrations?", "Waiting for approval: run migrations?"],
    ["[ ! ] Bump deps", "Bump deps"], ["[web] login", "[web] login"], ["Zsh completion fixes", "Zsh completion fixes"],
    ["Node 22 upgrade", "Node 22 upgrade"], ["Claude Code review notes", "Claude Code review notes"]];
  for (const [t, want] of telling) assert.equal(Chrome.tellingTitle(t, who), want, t);
  // a Forkling record (no app) and no record at all
  assert.equal(Chrome.tellingTitle("Codex", { address: "s1", program: { key: "codex", name: "Codex" } }), "");
  assert.equal(Chrome.tellingTitle("Run the test shard", null), "Run the test shard");
});

test("waiting tooltips name the most telling label herdr gives the terminal, never a shell, program or empty title", () => {
  const world = D.demoWorld("mid", NOW).world;
  const ag = world.rt.demo.cast.agents.find((a) => a.address === "t2"); // Codex, blocked, tab "main"
  const lines = (now) => {
    const row = rowOf(V.partyView(world, { width: 268, nowMs: now }), "t2");
    return [row.tooltip.split("\n")[1], row.chips.find((c) => c.kind === "blocked").tooltip, V.nameplateView(world, { terminal: "t2" }).tooltip.split("\n")[2]];
  };
  const expectOn = (now, label, why) => {
    const [row, chip, plate] = lines(now);
    assert.match(row, label ? new RegExp(`^Waiting for you for \\S+ on “${label}” · click to jump there$`) : /^Waiting for you for \S+ · click to jump there$/, `${why}: row`);
    assert.equal(chip, row.replace(" · click to jump there", ""), `${why}: '!' chip`);
    assert.equal(plate, chip, `${why}: pane header`);
  };
  let now = advance(world, 1);
  expectOn(now, "Bump deps and fix types", "the demo's own title");
  // the title goes blank while it waits: the task's last title stays
  ag.titles = [""];
  now = advance(world, 1);
  expectOn(now, "Bump deps and fix types", "blank title");
  // the agent retitles itself after its program, a shell or a prompt: the engine keeps only telling
  // titles as the task's (agents.js), so the task's real title still names it
  for (const t of ["✳ Codex", "-zsh", "me@box: ~/src/herdr-app"]) {
    ag.titles = [t];
    now = advance(world, 1);
    expectOn(now, "Bump deps and fix types", `retitled ${JSON.stringify(t)}`);
  }
  // a new task that never had a telling title falls back to a name the person gave, as herdr's
  // agents list does: the tab ("main"), and before it the pane (herdr's own pane header shows it first)
  setStatus(world, "t2", "done", 12); // the 8-tick close debounce ends the task
  const heroId = heroOf(world, "t2");
  assert.equal(world.rt.live.get(heroId).task, null, "the old task closed");
  ag.titles = ["✳ Codex"];
  setStatus(world, "t2", "working", 2);
  assert.equal(world.rt.live.get(heroId).task.title, "", "a task opened under its program's name has no title");
  now = setStatus(world, "t2", "blocked", 1);
  expectOn(now, "main", "program-name title, a new task");
  ag.paneName = "db migrations";
  now = advance(world, 1);
  expectOn(now, "db migrations", "pane name");
  // a shell's title, the tab's automatic number, no pane name: nothing worth naming
  ag.titles = ["-zsh"];
  ag.paneName = null;
  ag.tabName = "2";
  now = advance(world, 1);
  expectOn(now, "", "shell title, unnamed tab");
  ag.titles = ["me@box: ~/src/herdr-app"];
  ag.tabName = "Codex"; // a tab named after its program says nothing either
  now = advance(world, 1);
  expectOn(now, "", "prompt title, tab named after the program");
});

test("quest, shipped and Forkling lines skip uninformative titles too", () => {
  const world = D.demoWorld("mid", NOW).world;
  const cast = world.rt.demo.cast.agents;
  const t1 = cast.find((a) => a.address === "t1"); // Claude Code, working
  t1.titles = ["claude"];
  t1.tabName = "1";
  // a task that never had a telling title (opened under its program's name)
  world.rt.live.get(heroOf(world, "t1")).task.title = "";
  const t5 = cast.find((a) => a.address === "t5"); // supervises s5a (working) and s5b (blocked)
  t5.subs[0].titles = ["Claude Code"];
  const now = advance(world, 1);
  assert.equal(world.rt.live.get(heroOf(world, "t1")).task.title, "", "the engine never takes the program's name as the task's title");
  const vm = V.partyView(world, { width: 268, nowMs: now });
  const q1 = rowOf(vm, "t1").tooltip.split("\n")[1];
  assert.match(q1, /^Questing in .+/, q1);
  assert.match(V.nameplateView(world, { terminal: "t1" }).tooltip, /\nQuesting in /);
  assert.match(rowOf(vm, "t5").tooltip, /\n2 Forklings: sub-agent \(working\), Ask about the schema \(blocked\)/);
  // a telling title still names the quest
  t1.titles = ["✳ Fix flaky auth test"];
  const later = advance(world, 1);
  assert.match(rowOf(V.partyView(world, { width: 268, nowMs: later }), "t1").tooltip.split("\n")[1], /^Quest: Fix flaky auth test \(/);
  // a chest whose task shipped under its program's name reads as the terminal's label instead
  const fd = D.demoWorld("first-day", NOW).world; // t1: done, a chest waiting
  const shippedLine = () => rowOf(V.partyView(fd, { width: 268, nowMs: NOW }), "t1").tooltip.split("\n")[1];
  assert.match(shippedLine(), /^Shipped: Add retry to webhook sender · [\d.]+ Seals · \w+ chest$/);
  const hero = fd.state.heroes.find((h) => h.id === heroOf(fd, "t1"));
  hero.pend[0].title = "Claude Code";
  fd.rt.version++;
  const line = shippedLine();
  assert.match(line, /^Shipped: .+ · [\d.]+ Seals · \w+ chest$/, line);
  assert.ok(!line.startsWith("Shipped: Claude Code"), line);
});

test("a long terminal title names the task as the Quest name does: cut to 40 characters (D§2.3)", () => {
  const world = D.demoWorld("mid", NOW).world;
  const long = "✳ Refactor the webhook sender so retries back off exponentially and log every attempt";
  const cut = "Refactor the webhook sender so retries b"; // the first 40 characters, glyph stripped
  for (const a of ["t1", "t2"]) world.rt.demo.cast.agents.find((x) => x.address === a).titles = [long];
  const now = advance(world, 1);
  const vm = V.partyView(world, { width: 268, nowMs: now });
  assert.equal(rowOf(vm, "t1").tooltip.split("\n")[1].replace(/ \(\S+\)$/, ""), `Quest: ${cut}`, "working: the Quest line");
  assert.match(rowOf(vm, "t2").tooltip.split("\n")[1], new RegExp(`^Waiting for you for \\S+ on “${cut}” · click to jump there$`), "waiting: the row");
  assert.match(V.nameplateView(world, { terminal: "t2" }).tooltip.split("\n")[2], new RegExp(`^Waiting for you for \\S+ on “${cut}”$`), "waiting: the pane header");
  // a long pane name the person gave is cut the same way, and a cut never ends in a space
  const live = { title: "zsh", task: null, address: "t9", program: { key: "codex", name: "Codex" }, paneName: "x".repeat(39) + " and more", tabName: "1" };
  assert.equal(Chrome.taskLabel(live), "x".repeat(39));
  assert.equal(Chrome.taskLabel({ ...live, paneName: "Short pane" }), "Short pane");
  // an emoji across the 40-unit cut goes whole: half a surrogate pair would make herdr's bridge
  // throw on the tooltip, and the party, stage, nameplate and sheet would render as error chips
  const rocket = "y".repeat(39) + "\u{1F680} then tag the release";
  assert.equal(Chrome.taskLabel({ ...live, paneName: rocket }), "y".repeat(39));
  assert.equal(Chrome.taskLabel({ ...live, title: `✳ ${rocket}` }), "y".repeat(39));
  assert.equal(Chrome.taskLabel({ ...live, paneName: "z".repeat(38) + "\u{1F680}!" }), "z".repeat(38) + "\u{1F680}");
});

test("program keys named like Object.prototype members get a title-bar tint (the party and the Herd roster keep rendering)", async () => {
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.ok(isHex(Chrome.titleBarOf(key)), key);
    assert.ok(isHex(Chrome.termlingColors({ id: 3 }, key, "questing").titleBar), key);
  }
  assert.equal(Chrome.titleBarOf("claude"), "#3B2A24");
  assert.equal(Chrome.statusWord("constructor"), "idle");
  assert.equal(Chrome.statusWord("blocked"), "blocked");
  // through the real engine and role: herdr's program key comes from the person's programs.json
  const world = D.demoWorld("mid", NOW).world;
  for (const ag of world.rt.demo.cast.agents.slice(0, 3)) ag.program = { ...ag.program, key: ["constructor", "__proto__", "toString"][ag.address === "t1" ? 0 : ag.address === "t2" ? 1 : 2] };
  advance(world, 5);
  const vm = V.partyView(world, { width: 268, nowMs: NOW });
  assertShape(vm, PARTY_SAMPLE, "party/proto-keys");
  const { m } = await mount("party", world);
  assertClean(m, "party with prototype-named program keys");
  assert.ok(m.text().includes(world.state.heroes[0].name));
});

test("party: tooltips carry the D§2.9 why line, quest and HP; footer strings are formatted", () => {
  const vm = V.partyView(demo("mid"), { width: 268, nowMs: NOW });
  const t1 = vm.groups[0].rows[0];
  const lines = t1.tooltip.split("\n");
  assert.match(lines[0], /^Echo the Idempotent · Lv 33 Senior Refactorer$/);
  assert.match(lines[1], /^Quest: .+ \(\d+m\)$/);
  assert.match(lines[2], /^HP [\d,]+ \/ [\d,]+ · XP \d+%/);
  assert.match(lines[3], /^\+[\d,]+ XP\/min = working ×1 · .*Shift: \d+m today \(full rate until 4h\)$/);
  // gold and Snippets depend on the balance tables and the loot rolls; check their format only
  assert.match(vm.footer.gold, /^\d{2,3}k$/);
  assert.match(vm.footer.snippets, /^\d{3}$/);
  assert.deepEqual({ ...vm.footer, gold: "*", snippets: "*" }, { gold: "*", snippets: "*", release: "v0.4", sprint: { label: "The Catastrophic Backtracker", have: 11, need: 25 }, digestDot: false, digestTip: null });
  // the Backlog: floor progress replaces the Sprint meter
  const late = V.hudView(demo("late"), { nowMs: NOW });
  assert.match(late.sprint.label, /^The Backlog, floor \d+$/);
  assert.equal(late.sprint.need, 50);
  assert.match(late.gold, /M$/);
  const empty = V.partyView(demo("empty"), { width: 268, nowMs: NOW });
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(empty.agentOrder, []);
  assert.equal(empty.footer.gold, "0");
});

/**
 * bigWorld(6) (hired yesterday) plus six agents hired today and a seventh today, "vps/t9": it plays
 * as a Contractor until the next 04:00 game day (round 4: a Contractor still playing is promoted
 * when hiring reopens, so one started yesterday is a roster hero by now).
 */
function contractorWorld() {
  const today = (k) => ({ address: `n${k + 1}`, program: "codex", space: "spc_1", spaceName: "herdr-app", plan: [["working", 1e9]], from: NOW - 30 * 60000 });
  return bigWorld(6, { extra: [...[0, 1, 2, 3, 4, 5].map(today), { address: "vps/t9", program: "claude", space: "spc_1", spaceName: "herdr-app", plan: [["working", 1e9]], from: NOW - 20 * 60000 }] });
}

test("party: a remote agent names its machine; a Contractor is tagged; names are always strings", () => {
  const c = contractorWorld();
  const vm = V.partyView(c, { width: 268, nowMs: NOW });
  const rows = vm.groups.flatMap((g) => g.rows);
  const remote = rows.find((r) => r.address === "vps/t9");
  assert.equal(remote.machine, "vps");
  assert.match(remote.tooltip, /· on vps/);
  assert.ok(remote.heroId < 0, "the 7th agent of the day plays as a Contractor");
  assert.match(remote.tooltip, /\(contractor\)/);
  assert.match(remote.tooltip, /Contractors don't get equity\./);
  assert.ok(rows.filter((r) => r.address !== "vps/t9").every((r) => r.machine === null));
  for (const g of vm.groups) {
    assert.equal(typeof g.name, "string");
    for (const r of g.rows) assert.ok(typeof r.name === "string" && r.name.length > 0);
  }
  const plate = V.nameplateView(c, { terminal: "vps/t9" });
  assert.equal(plate.contractor, true);
  assert.equal(plate.heroId, remote.heroId);
  assert.ok(vm.agentOrder.includes("vps/t9"));
});

test("a Contractor's party row, pane header and stage tooltip say when it will be hired (agents.hireOutlook)", () => {
  const c = contractorWorld();
  const id = c.rt.bind.get("vps/t9");
  assert.ok(id < 0, "a Contractor");
  const hire = "Hired at the next 04:00 game day (today: 0 of 6 hires left)";
  const row = V.partyView(c, { width: 268, nowMs: NOW }).groups.flatMap((g) => g.rows).find((r) => r.heroId === id);
  assert.deepEqual(row.tooltip.split("\n").slice(-2), ["Contractors don't get equity.", hire]);
  const plate = V.nameplateView(c, { terminal: "vps/t9" });
  assert.ok(plate.tooltip.split("\n").includes(hire), plate.tooltip);
  const hero = V.stageView(c, { width: 3200, height: 200, nowMs: NOW }).heroes.find((h) => h.heroId === id);
  assert.ok(hero, "the Contractor is on stage");
  assert.equal(hero.tooltip.split("\n").at(-1), hire);
  // a roster hero says nothing of the kind
  const other = V.partyView(c, { width: 268, nowMs: NOW }).groups.flatMap((g) => g.rows).find((r) => r.heroId > 0);
  assert.doesNotMatch(other.tooltip, /Hired|hires left/);
  // second in line, with the day's hires used: it says how many are ahead
  const c2 = contractorWorld();
  const first = [...c2.rt.contractors.values()][0];
  first.since -= 1; // longer-running: first in line
  const fake = { address: "vps/t10", program: "claude", space: "spc_1", spaceName: "herdr-app", plan: [["working", 1e9]], from: NOW - 60000 };
  c2.rt.demo.cast.agents.push(D.makeAgent(fake));
  advance(c2, 1);
  const second = c2.rt.bind.get("vps/t10");
  assert.ok(second < 0);
  const tip = V.partyView(c2, { width: 268, nowMs: NOW + 1000 }).groups.flatMap((g) => g.rows).find((r) => r.heroId === second).tooltip;
  assert.match(tip, /Hired at the next 04:00 game day · 1 ahead in line \(today: 0 of 6 hires left\)$/);
});

test("party: the level-up shimmer age and the LTS star come from this tick's effects and journal", () => {
  const world = D.demoWorld("mid", NOW).world;
  const hero = world.state.heroes[0];
  world.rt.fx.push({ key: `fx:${world.rt.tick}:99`, kind: "levelup", heroId: hero.id, bornTick: world.rt.tick, text: "LEVEL UP", value: hero.L });
  world.state.herd.log.push([world.rt.nowMs - 1000, "drop", hero.id, "Hackathon Jacket", 4]);
  world.rt.version++;
  const vm = V.partyView(world, { width: 268, nowMs: NOW });
  const r = vm.groups[0].rows.find((x) => x.heroId === hero.id);
  assert.equal(r.levelUpAge, 0);
  const star = r.chips.find((c) => c.kind === "star");
  assert.ok(star);
  assert.equal(star.color, "#FF9A2E");
  assert.match(r.tooltip, /New LTS drop: Hackathon Jacket/);
  assert.ok(vm.groups.flatMap((g) => g.rows).filter((x) => x.heroId !== hero.id).every((x) => x.levelUpAge === null));
});

test("nameplate: O(1) per pane, null for panes without a hero, chip and tooltip per D§11.12", () => {
  const world = demo("mid");
  assert.equal(V.nameplateView(world, { terminal: "nope", pane: "p9" }), null);
  assert.equal(V.nameplateView(world, { terminal: null, pane: "p9" }), null);
  assert.equal(V.nameplateView(world, { terminal: "s5a" }), null, "a sub-agent's own pane is herdr's plain header");
  assert.equal(V.nameplateView(null, { terminal: "t1" }), null);
  const t1 = V.nameplateView(world, { terminal: "t1", pane: "p_t1" });
  assert.equal(t1.heroId, 1);
  assert.equal(t1.chip.text, "fighting 3-3");
  assert.equal(t1.chip.color, "#8A8F98");
  assert.equal(t1.face, ">_");
  assert.equal(t1.status, "working");
  assert.equal(t1.contractor, false);
  const lines = t1.tooltip.split("\n");
  assert.match(lines[1], /^Power Level \d+ = Lv 33 [+−] gear \d+$/);
  assert.match(lines[2], /^Quest: /);
  assert.match(lines[3], /Shift \d+m today/);
  assert.match(lines[4], /^\+[\d,]+ XP\/min = working ×1/);
  const t2 = V.nameplateView(world, { terminal: "t2" });
  assert.match(t2.chip.text, /^! waiting/);
  assert.equal(t2.chip.color, "#F2A93B");
  assert.equal(V.nameplateView(world, { terminal: "t4" }).chip.text.startsWith("shipped"), true);
  assert.equal(V.nameplateView(world, { terminal: "t6" }).chip.text, "resting");
  assert.match(V.nameplateView(demo("boss"), { terminal: "t1" }).chip.text, /^BOSS \d+%$/);
  assert.match(V.nameplateView(demo("late"), { terminal: "t1" }).chip.text, /^fighting floor \d+$/);
  assert.equal(V.nameplateView(demo("calm"), { terminal: "t1" }).calm, true);
});

test("hud: counts by herdr status, digest dot and calm", () => {
  const vm = V.hudView(demo("mid"), { nowMs: NOW });
  assert.equal(vm.working, 3);
  assert.equal(vm.blocked, 1);
  assert.equal(vm.shipped, 1);
  assert.equal(vm.calm, false);
  assert.equal(V.hudView(demo("calm"), { nowMs: NOW }).calm, true);
  assert.equal(V.partyView(demo("calm"), { width: 268, nowMs: NOW }).calm, true);
  const blocked = V.hudView(demo("blocked"), { nowMs: NOW });
  assert.equal(blocked.blocked, 4);
  assert.equal(blocked.working, 1);
  const world = D.demoWorld("idle", NOW).world;
  world.rt.digestDot = true;
  world.rt.version++;
  assert.equal(V.hudView(world, { nowMs: NOW }).digestDot, true);
  assert.equal(V.partyView(world, { width: 268, nowMs: NOW }).footer.digestDot, true);
  assert.equal(W.command(world, "digestSeen", {}, NOW).ok, true);
  assert.equal(V.hudView(world, { nowMs: NOW }).digestDot, false);
});

test("the shared Termling helpers agree with the sample conventions", () => {
  const c = Chrome.termlingColors({ id: 1 }, "claude", "questing");
  assert.deepEqual(c, { hoodie: "#6C8CF5", titleBar: "#3B2A24", screen: "#17161F", faceInk: "#4CC38A" });
  assert.equal(Chrome.termlingColors({ id: -7 }, "unknown-agent", "waiting").faceInk, "#F2A93B");
  assert.ok(isHex(Chrome.titleBarOf("some-new-agent")));
  assert.equal(Chrome.programIconOf({ icon: "icons/pi.svg", tint: true, color: null }).color, "#ffffff");
  assert.equal(Chrome.programIconOf(null), null);
  assert.equal(Chrome.xpFracOf({ L: 100, xp: 5 }), 1);
  assert.equal(Chrome.feFracOf({ L: 100, fe: 50 }, 1), 0);
  assert.ok(Chrome.feFracOf({ L: 50, fe: 42 }, 0.3) > 0 && Chrome.feFracOf({ L: 50, fe: 42 }, 0.3) <= 0.7);
  assert.equal(Chrome.whyLine(null), "");
});

// ---------------------------------------------------------------------------------------------
// performance (V8; QuickJS is ~20-50x slower, herdr's render budget is 50 ms)
//
// Bounds that hold under load (parallel test files, a browser shooting previews). Load only adds
// time spent waiting for a CPU, so each figure is the lower of the wall clock and the process's
// CPU time (which never counts waiting, but does count GC and compiler threads), taken as the best
// of several batches after a warm-up; each batch averages a few runs, against timer granularity.
// What needs no clock (a memo hit returns the same object) is checked without one.

/** The best per-run cost (ms) of `batches` batches of `per` runs of fn, after one warm-up run. */
function bestMs(fn, { batches = 7, per = 5 } = {}) {
  fn();
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    for (let k = 0; k < per; k++) fn();
    const wall = performance.now() - t0;
    const c = process.cpuUsage(c0);
    best = Math.min(best, Math.min(wall, (c.user + c.system) / 1000) / per);
  }
  return best;
}

test("perf: view + render of a 30-hero party, a nameplate and the HUD stay small", async () => {
  const w = big();
  const { m, host } = await mount("party", w, { width: 268, height: 820 });
  // the party: a fresh world version each time (no memo); each render's cost as renderCost() takes it
  const before = host.views.length;
  let best = Infinity;
  for (let b = 0; b < 7; b++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      w.rt.version++;
      sum += renderCost(m);
    }
    best = Math.min(best, sum / 3);
  }
  assert.ok(best < 8, `party view + render ${best.toFixed(2)} ms in V8 (best batch)`);
  assert.ok(m.stats.elements < 360, `${m.stats.elements} elements`);
  assert.ok(host.views.length - before >= 21, "every render asked for the view");
  // a redraw within one version is a memo hit: the same VM, and next to free
  const args = { width: 268, nowMs: NOW };
  const vm = V.partyView(w, args);
  assert.equal(V.partyView(w, args), vm, "memo hit");
  const memo = bestMs(() => V.partyView(w, args), { per: 200 });
  assert.ok(memo < 0.05, `memo hit ${memo.toFixed(4)} ms`);
  // every pane header of 30 heroes in one version: one index build, then O(1) (and a second ask
  // for the same terminal is the same VM)
  const addrs = liveAddresses(w);
  const plates = bestMs(() => { w.rt.version++; for (const t of addrs) V.nameplateView(w, { terminal: t }); }, { per: 1 });
  assert.ok(plates < 40, `30 nameplates ${plates.toFixed(1)} ms`);
  assert.equal(V.nameplateView(w, { terminal: addrs[0] }), V.nameplateView(w, { terminal: addrs[0] }));
  const hud = bestMs(() => { w.rt.version++; V.hudView(w, { nowMs: NOW }); }, { per: 10 });
  assert.ok(hud < 2, `hud ${hud.toFixed(3)} ms`);
});

test("save trouble is never silent (D§13.1): the party and the HUD carry it as a cue, and it is not memoised away", () => {
  const world = D.demoWorld("mid", NOW).world;
  const st = {
    readOnly: false, notSaving: true, restoredFrom: "bak", title: "Not saving",
    message: "The save file can't be read (save.json), so nothing is being saved.", detail: "os error 32", since: NOW,
  };
  const p0 = V.partyView(world, { width: 268, nowMs: NOW });
  const h0 = V.hudView(world, { nowMs: NOW });
  assert.equal(p0.save, null);
  assert.equal(h0.save, null);
  const p1 = V.partyView(world, { width: 268, nowMs: NOW, save: st });
  const h1 = V.hudView(world, { nowMs: NOW, save: st });
  assert.notEqual(p1, p0, "same world version, but the save changed: a new VM");
  assert.notEqual(h1, h0);
  for (const vm of [p1, h1]) {
    assert.deepEqual(vm.save, { title: "Not saving", short: "Not saving", tooltip: `${st.message}\n(os error 32)\nClick for the Herd panel.` });
  }
  assertShape(p1, PS.scenarios.saveTrouble, "party/save");
  assertShape(h1, HS.scenarios.saveTrouble, "hud/save");
  assert.equal(V.partyView(world, { width: 268, nowMs: NOW }).save, null, "and gone again once the save is fine");
  // the short forms
  const cue = (o) => Chrome.saveCue({ message: "m", ...o });
  assert.equal(cue({ readOnly: true }).short, "Read-only");
  assert.equal(cue({ restoredFrom: "fresh" }).short, "New herd");
  assert.equal(cue({ restoredFrom: "unchecked" }).short, "Checksum");
  assert.equal(cue({ restoredFrom: "bak" }).short, "Restored");
  assert.equal(cue({ readOnly: true }).title, "Save is read-only");
  assert.equal(Chrome.saveCue(null), null);
  assert.equal(Chrome.saveCue({ message: "" }), null);
});

// Localhost, the town (docs/TOWN.md round 1, §7.4 and §14 must-avoid P3/P4): the agent-status
// surfaces keep the agent's words; the town lights no Herd dot.
test("Localhost: the party row, pane header and HUD keep the agent's words; the job only in tooltips; the town alone lights no Herd dot", () => {
  const w = D.demoWorld("idle", NOW).world;
  const rows = V.partyView(w, { width: 300, nowMs: NOW }).groups.flatMap((g) => g.rows);
  const onDuty = rows.filter((r) => /\nAt the Review Desk · /.test(r.tooltip));
  assert.ok(onDuty.length >= 2, "resting heroes on duty say where in their tooltip");
  for (const r of onDuty) {
    assert.ok(["idle", "done"].includes(r.status), `${r.name}: ${r.status}`);
    assert.ok(!/review|LGTM|desk/i.test(`${r.status} ${r.mapLabel} ${r.chips.map((c) => c.text).join(" ")}`), r.name);
    const plate = V.nameplateView(w, { terminal: r.address });
    assert.ok(["resting", "shipped", "shipped · chest ready"].includes(plate.chip.text), plate.chip.text);
    assert.match(plate.tooltip, /\nAt the Review Desk · /);
  }
  // the HUD counts the agents' states only
  const hud = V.hudView(w, { nowMs: NOW });
  assert.ok(!/review|LGTM|desk/i.test(JSON.stringify(hud)), "no town words in the HUD");
  // read the digest, then only the town has news: no Herd dot
  assert.ok(W.command(w, "digestSeen", {}, NOW).ok);
  w.state.herd.town.u[0] += 12;
  w.rt.version++;
  const party = V.partyView(w, { width: 300, nowMs: NOW + 1000 });
  assert.equal(V.hudView(w, { nowMs: NOW + 1000 }).digestDot, false);
  assert.ok(!JSON.stringify(party.footer ?? {}).includes("Localhost"));
});
