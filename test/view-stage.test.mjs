// game/view/stage.js (stageView): the real demo worlds (game/demo.js) mapped to StageVMs.
// (1) shape conformance against the sample VMs (tools/vm-samples/stage.mjs, the spec), no
// NaN/Infinity/undefined, hex colours, unique keys; (2) every VM through the real renderer
// (ui/stage.js) at the widths/zooms/heights the role supports with zero validator errors and under
// the element budget; (3) stability while the world ticks (keys, slots, two-tick fx, status
// changes never move slots, overflow hysteresis) and the layout rules (arena spacing, chest clear
// of the face, campfire/forkling spots); (4) V8 timing of view + render.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("../tools/mock/index.mjs");
const { View } = await import("gpui-kit");
const { SCENARIOS, makeScenario } = await import("../tools/vm-samples/stage.mjs");
const Stage = (await import("../mods/down-the-stack/ui/stage.js")).default;
const { renderStage } = await import("../mods/down-the-stack/ui/stage.js");
const { stageView } = await import("../mods/down-the-stack/game/view.js");
const { _resetStageMemo, whyText } = await import("../mods/down-the-stack/game/view/stage.js");
const { demoWorld, demoSnapshot, DEMO_KINDS } = await import("../mods/down-the-stack/game/demo.js");
const { tick, command, createWorld } = await import("../mods/down-the-stack/game/world.js");
const { careerOf } = await import("../mods/down-the-stack/game/heroes.js");
const { canChallenge } = await import("../mods/down-the-stack/game/boss.js");
const { BOSSES, ZONES } = await import("../mods/down-the-stack/game/data.js");

const NOW = Date.UTC(2026, 10, 24, 9, 30, 0);
const WIDTHS = [360, 960, 1600, 2400];
const WIDE = [2800, 3200, 3600, 4000];
const ZOOMS = [1, 2];
// Wall-clock bounds: the strict ones only with PERF=1 (a loaded machine stretches V8 timings many
// times over); otherwise generous bounds that still catch a runaway loop. The measured numbers
// always go to the test output.
const PERF = process.env.PERF === "1";
const RENDER_MS = PERF ? 50 : 500;
const ANIM = new Set(["loop", "transition", "frames", "spring"]);
const animatedIn = (mod) => mod.findAll((n) => n.type !== "text" && n.methods.some((m) => ANIM.has(m[0]))).length;

// Demo worlds are deterministic per (kind, nowMs); build each once and clone by rebuilding when a
// test mutates one.
const WORLDS = new Map();
function world(kind) {
  if (!WORLDS.has(kind)) WORLDS.set(kind, demoWorld(kind, NOW).world);
  return WORLDS.get(kind);
}
const fresh = (kind) => demoWorld(kind, NOW).world;

/** Advance a demo world by one second through its scripted cast. */
function step(w, nowRef) {
  nowRef.now += 1000;
  tick(w, demoSnapshot(w, nowRef.now));
}

// ---------------------------------------------------------------------------------------------
// (1) Shape: a schema learned from every sample VM
// ---------------------------------------------------------------------------------------------

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const newNode = () => ({ types: new Set(), objs: 0, keys: null, items: null });

function learn(node, v) {
  node.types.add(typeOf(v));
  if (Array.isArray(v)) {
    if (!node.items) node.items = newNode();
    for (const x of v) learn(node.items, x);
  } else if (v && typeof v === "object") {
    node.objs++;
    if (!node.keys) node.keys = new Map();
    for (const [k, x] of Object.entries(v)) {
      if (!node.keys.has(k)) node.keys.set(k, { n: 0, node: newNode() });
      const e = node.keys.get(k);
      e.n++;
      learn(e.node, x);
    }
  }
}

const SCHEMA = newNode();
for (const name of SCENARIOS) {
  for (const o of [{}, { tick: 1 }, { tick: 2 }, { width: 360 }, { width: 2400 }]) learn(SCHEMA, makeScenario(name, o));
}

// Nullable per the JSDoc of ARCHITECTURE §5 / ui/stage.js even where a sample never shows null.
const NULLABLE = new Set([
  "empty", "headerNote", "herdBanner", "boss", "overflow", "rooms[].quota", "rooms[].sprint",
  "heroes[].programIcon", "heroes[].hat", "heroes[].bubble", "heroes[].campfire", "heroes[].tag",
  "heroes[].rebootFrac", "mobs[].glyph", "chests[].address", "boss.banner", "boss.stamp",
  "boss.partSprite", "boss.mechText", "boss.phaseLabel", "fx[].color", "fx[].size",
  "rooms[].pin", "rooms[].challenge", "boss.retreat", "heroes[].reviewEnd", "mobs[].heroId",
]);

function conform(v, node, path, errs) {
  const t = typeOf(v);
  if (v === undefined) { errs.push(`${path}: undefined`); return; }
  if (t === "number" && !Number.isFinite(v)) { errs.push(`${path}: ${v}`); return; }
  if (!node.types.has(t)) {
    if (!(t === "null" && NULLABLE.has(path))) errs.push(`${path}: ${t} (samples: ${[...node.types].join("|")})`);
    return;
  }
  if (t === "array") {
    if (node.items) v.forEach((x) => conform(x, node.items, `${path}[]`, errs));
  } else if (t === "object") {
    for (const [k, e] of node.keys || []) {
      if (e.n === node.objs && !(k in v)) errs.push(`${path ? `${path}.` : ""}${k}: missing`);
    }
    for (const [k, x] of Object.entries(v)) {
      const e = node.keys && node.keys.get(k);
      if (!e) { errs.push(`${path ? `${path}.` : ""}${k}: not in the samples`); continue; }
      conform(x, e.node, `${path ? `${path}.` : ""}${k}`, errs);
    }
  }
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_KEY = /^(color|glyphColor|hoodie|titleBar|screen|faceInk|sky|far|ground|accent)$/;

/** Colours are hex, keys are unique strings, nothing is NaN/undefined anywhere. */
function hygiene(vm) {
  const errs = [];
  const keys = new Map();
  const walk = (v, path, key) => {
    if (v === undefined) { errs.push(`${path}: undefined`); return; }
    if (typeof v === "number" && !Number.isFinite(v)) errs.push(`${path}: ${v}`);
    if (typeof v === "string" && (COLOR_KEY.test(key) || /skyBands|dots/.test(path)) && !HEX.test(v)) errs.push(`${path}: colour ${v}`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
    else if (v && typeof v === "object") {
      if ("key" in v) {
        if (typeof v.key !== "string" || !v.key) errs.push(`${path}.key: ${v.key}`);
        else if (keys.has(v.key)) errs.push(`${path}.key: duplicate ${v.key} (also ${keys.get(v.key)})`);
        else keys.set(v.key, path);
      }
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, k);
    }
  };
  walk(vm, "vm", "");
  return errs;
}

test("shape: every demo world at every width/height conforms to the sample VMs", () => {
  for (const kind of DEMO_KINDS) {
    const w = world(kind);
    for (const width of WIDTHS) {
      for (const height of [200, 120, 64]) {
        const vm = stageView(w, { width, height, nowMs: NOW });
        const errs = [];
        conform(vm, SCHEMA, "", errs);
        errs.push(...hygiene(vm));
        assert.deepEqual(errs, [], `${kind} @${width}×${height}`);
        assert.equal(vm.width, width);
        assert.equal(vm.height, height);
      }
    }
  }
});

test("shape: a world mid-fight, after a win and after a Postmortem also conforms", () => {
  const ref = { now: NOW };
  const w = fresh("boss");
  const seen = [];
  stageView(w, { width: 1200, height: 200, nowMs: ref.now });
  // force the win: the body at 1 HP, every tentacle cut
  const f = w.rt.fights[0];
  for (const p of f.parts) p.hp = p.kind === "boss" ? 1 : 0;
  for (let k = 0; k < 6; k++) {
    step(w, ref);
    seen.push(stageView(w, { width: 1200, height: 200, nowMs: ref.now }));
  }
  const lost = fresh("boss");
  stageView(lost, { width: 1200, height: 200, nowMs: NOW });
  const r = command(lost, "retreat", {}, NOW + 500);
  assert.ok(r.ok, r.error);
  const ref2 = { now: NOW };
  for (let k = 0; k < 5; k++) {
    step(lost, ref2);
    seen.push(stageView(lost, { width: 1200, height: 200, nowMs: ref2.now }));
  }
  for (const vm of seen) {
    const errs = [];
    conform(vm, SCHEMA, "", errs);
    errs.push(...hygiene(vm));
    assert.deepEqual(errs, [], `tick ${vm.tick}`);
  }
  // the win: a FIXED stamp (age 0 then down), the arena closes after 3 ticks
  const stamped = seen.slice(0, 6).filter((vm) => vm.boss && vm.boss.stamp);
  assert.ok(stamped.length >= 3, "the FIXED stamp stays on stage");
  assert.equal(stamped[0].boss.stamp.age, 0);
  assert.ok(stamped.at(-1).boss.stamp.age >= 1);
  assert.equal(stamped[0].boss.stamp.sprite, "fx/stamp-fixed.svg");
  assert.equal(seen[5].boss, null, "the arena closed");
  assert.ok(seen.slice(0, 6).some((vm) => vm.herdBanner), "herd-first kill banner");
  // the Postmortem card
  const pm = seen.slice(6).filter((vm) => vm.boss && vm.boss.banner && vm.boss.banner.kind === "postmortem");
  assert.ok(pm.length >= 2, "postmortem card shown");
  assert.equal(pm[0].boss.banner.text, "Postmortem · retry in 10 working min");
  assert.match(pm[0].boss.banner.sub, /^\d+% wounds kept · Lessons Learned \+\d+%$/);
  assert.equal(seen.at(-1).boss, null);
});

test("empty and loading states", () => {
  const vm = stageView(world("empty"), { width: 960, height: 200, nowMs: NOW });
  assert.equal(vm.empty.kind, "no_agents");
  assert.match(vm.empty.title, /Help wanted/);
  assert.match(vm.empty.text, /hire a hero/);
  assert.equal(vm.stillness, true);
  assert.deepEqual([vm.rooms.length, vm.heroes.length, vm.fx.length], [0, 0, 0]);
  const loading = stageView(null, { width: 960, height: 200 });
  assert.equal(loading.empty.kind, "loading");
  const errs = [];
  conform(loading, SCHEMA, "", errs);
  assert.deepEqual(errs, []);
  // a herd whose heroes are all off duty says so
  const w = fresh("idle");
  w.rt.live.clear();
  w.rt.version++;
  const off = stageView(w, { width: 960, height: 200, nowMs: NOW });
  assert.equal(off.empty.kind, "no_agents");
  assert.match(off.empty.text, /4 heroes are resting/);
});

// ---------------------------------------------------------------------------------------------
// (2) Render through ui/stage.js
// ---------------------------------------------------------------------------------------------

/** panes() rows: every hero's terminal has a pane (herdr agents do), Forklings have none. */
const panesOf = (vm) => vm.heroes.filter((h) => h.address).map((h, i) => ({
  pane: `p${i + 1}`, terminal: h.address, tab: "tab1", title: h.name, name: null, cwd: null, branch: null, status: "working",
  app: "claude-code", program: null, focused: false, zoomed: false, movable: true, scroll: null,
}));

async function mountStage(vm, { width = vm.width, height = vm.height, zoom = 1 } = {}) {
  M.resetState();
  M.setFixture({ theme: "graphite", settings: { zoom }, layout: M.readLayout(), panes: panesOf(vm) });
  const ref = { vm };
  const log = { commands: [] };
  const host = {
    world: null, version: 1, claim: () => true, view: () => ref.vm,
    command: (name, args) => { log.commands.push({ name, args }); return { ok: true }; },
  };
  class Wrap extends View {
    init(_p, cx) { this.stage = new Stage(); this.stage.init({ role: "stage" }, cx, host); }
    render(cx) { return this.stage.render(cx); }
  }
  const mod = await M.mountView(Wrap, { props: { role: "stage" } });
  mod.render();
  mod.size(width * zoom, height * zoom);
  mod.render();
  return { mod, ref, log, stage: mod.view.stage };
}

// The mock's "budget" errors (a render over 50 ms, a handler over 500 ms, each timed as the lower
// of wall and CPU time, tools/mock/state.mjs stopwatch()) count only with PERF=1: a loaded machine
// can still stretch a 5 ms V8 render's CPU time past them (the numbers are printed).
const problems = (mod) => [
  ...mod.errors.filter((e) => PERF || e.code !== "budget").map((e) => `${e.code}: ${e.message}`),
  ...mod.warnings.filter((w) => ["duplicate-id", "many-elements", "transition-no-id", "loop-replaced", "tooltip-on-image", "frames-children"].includes(w.code)).map((w) => `${w.code}: ${w.message}`),
];

test("render: every demo world renders cleanly at every width, zoom and height", async (t) => {
  let worst = { ms: 0, at: "" };
  for (const kind of DEMO_KINDS) {
    const w = world(kind);
    for (const width of [...WIDTHS, ...WIDE]) {
      for (const height of width === 960 ? [200, 120, 64] : [200]) {
        const vm = stageView(w, { width, height, nowMs: NOW });
        for (const zoom of width > 2400 ? [1] : ZOOMS) {
          const { mod } = await mountStage(vm, { zoom });
          const where = `${kind} @${width}×${height} ×${zoom}`;
          assert.deepEqual(problems(mod), [], where);
          assert.equal(mod.tree.id, "stage", where);
          assert.ok(mod.stats.elements <= 400, `${where}: ${mod.stats.elements} elements`);
          assert.ok(animatedIn(mod) <= 150, `${where}: ${animatedIn(mod)} animated`);
          if (mod.stats.maxRenderMs > worst.ms) worst = { ms: mod.stats.maxRenderMs, at: where };
          assert.ok(mod.stats.maxRenderMs < RENDER_MS, `${where}: ${mod.stats.maxRenderMs.toFixed(1)} ms`);
        }
      }
    }
  }
  t.diagnostic(`slowest V8 render: ${worst.ms.toFixed(1)} ms (${worst.at}); bound ${RENDER_MS} ms${PERF ? " (PERF=1)" : ""}`);
});

test("render: twelve working heroes on 2400 px stay within 400 elements", async () => {
  const w = fresh("late");
  // twelve of the fourteen stay on stage (the arena closes: no fight)
  w.rt.fights.length = 0;
  for (const id of [13, 14]) w.rt.live.delete(id);
  w.rt.version++;
  const vm = stageView(w, { width: 2400, height: 200, nowMs: NOW });
  assert.equal(vm.heroes.length, 12);
  assert.equal(vm.overflow, null);
  const { mod } = await mountStage(vm);
  assert.deepEqual(problems(mod), []);
  assert.ok(mod.stats.elements <= 400, `${mod.stats.elements} elements`);
});

test("render: the stage's clicks reach the engine with the VM's ids", async () => {
  const vm = stageView(world("mid"), { width: 1200, height: 200, nowMs: NOW });
  const { mod, log } = await mountStage(vm);
  const last = () => { const c = M.calls().run.at(-1); return { name: c.name, args: c.args }; };
  const pim = vm.heroes.find((h) => h.state === "waiting");
  mod.fire(pim.key);
  assert.deepEqual(log.commands.at(-1), { name: "markSeen", args: { heroId: pim.heroId } });
  assert.deepEqual(last(), { name: "pane.focus", args: { terminal: pim.address } });
  mod.fire(`${pim.key}/bubble`);
  assert.deepEqual(last(), { name: "pane.focus", args: { terminal: pim.address } });
  // Forklings (sub-agents, no pane): herdr's peek, as its agents list opens them
  const moss = vm.heroes.find((h) => h.forklings.length);
  for (const fk of moss.forklings) {
    mod.fire(fk.key);
    assert.deepEqual(last(), { name: "terminal.peek", args: { terminal: fk.address } });
  }
  assert.ok(moss.forklings.some((f) => f.bubble), "the blocked one too");
  assert.equal(M.calls().run.filter((c) => c.name === "agent.focus").length, 0);
  // the room header pins its heroes; the boss door (when open) challenges
  const room = vm.rooms.find((r) => r.pin);
  mod.fire(`${room.key}/hdr`);
  assert.deepEqual(log.commands.slice(-room.pin.heroIds.length), room.pin.heroIds.map((heroId) => ({ name: "pinMap", args: { heroId, mapId: room.pin.mapId } })));
  assert.deepEqual(problems(mod), []);
});

test("ui/stage command('sheet') does nothing without a focused hero", async () => {
  const vm = stageView(world("idle"), { width: 1200, height: 200, nowMs: NOW });
  assert.ok(vm.heroes.every((h) => !h.focused));
  const { stage } = await mountStage(vm);
  M.updateFixture({ focused: null });
  const before = M.calls().openOverlay.length;
  assert.equal(stage.command("sheet"), false);
  assert.equal(M.calls().openOverlay.length, before);
  M.updateFixture({ focused: { terminal: vm.heroes[2].address } });
  assert.equal(stage.command("sheet"), true);
  assert.deepEqual(M.calls().openOverlay.at(-1).spec.props, { role: "sheet", heroId: vm.heroes[2].heroId });
});

// ---------------------------------------------------------------------------------------------
// (3) Stability and layout rules
// ---------------------------------------------------------------------------------------------

const slotMap = (vm) => new Map(vm.heroes.map((h) => [h.heroId, `${h.slot.x}/${h.slot.w}`]));
const layoutSig = (vm) => `${vm.heroes.map((h) => h.heroId).sort().join(",")}|${vm.overflow ? vm.overflow.tooltip : ""}|${vm.boss ? vm.boss.key : ""}`;

test("stability: keys and slots hold while the worlds tick; fx live for two ticks", () => {
  for (const kind of ["first-day", "mid", "boss", "late", "blocked", "idle"]) {
    const w = fresh(kind);
    const ref = { now: NOW };
    let prev = stageView(w, { width: 1200, height: 200, nowMs: ref.now });
    for (let k = 0; k < 12; k++) {
      step(w, ref);
      const vm = stageView(w, { width: 1200, height: 200, nowMs: ref.now });
      assert.equal(vm.tick, prev.tick + 1, kind);
      for (const f of vm.fx) assert.ok(f.age === 0 || f.age === 1, `${kind}: fx age ${f.age}`);
      if (layoutSig(vm) === layoutSig(prev)) {
        // same membership: the same rooms, and status/focus/level never moved a slot
        assert.deepEqual(vm.rooms.map((r) => r.key), prev.rooms.map((r) => r.key), `${kind} tick ${k}: rooms`);
        const a = slotMap(prev);
        for (const [id, s] of slotMap(vm)) assert.equal(s, a.get(id), `${kind} tick ${k}: hero ${id} slot moved`);
      }
      // an effect born last tick is still there (same key, age 1) while its hero is on stage
      const shown = new Set(vm.heroes.map((h) => h.heroId));
      const now = new Map(vm.fx.map((f) => [f.key, f]));
      for (const f of prev.fx) {
        if (f.age !== 0) continue;
        const src = w.rt.fx.find((x) => x.key === f.key);
        if (!src || (src.heroId != null && !shown.has(src.heroId))) continue;
        assert.ok(now.has(f.key) && now.get(f.key).age === 1, `${kind}: ${f.key} (${f.kind}) should be age 1`);
      }
      prev = vm;
    }
  }
});

test("stability: a status change or a focus change never moves a slot", () => {
  const w = fresh("mid");
  const before = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  const snap = demoSnapshot(w, NOW + 1000);
  for (const a of snap.agents) {
    if (a.address === "t1") { a.status = "blocked"; a.seq += 7; }
    if (a.address === "t3") { a.status = "done"; a.seq += 7; }
  }
  snap.focusedTerminal = "t4";
  tick(w, snap);
  const after = stageView(w, { width: 1200, height: 200, nowMs: NOW + 1000 });
  assert.equal(after.heroes.find((h) => h.address === "t1").state, "waiting");
  assert.equal(after.heroes.find((h) => h.address === "t4").focused, true);
  assert.deepEqual([...slotMap(after)], [...slotMap(before)]);
  assert.deepEqual(after.rooms.map((r) => [r.key, r.x, r.w]), before.rooms.map((r) => [r.key, r.x, r.w]));
});

test("layout: slot widths follow D§11.3 and rooms merge by space and map", () => {
  for (const kind of ["first-day", "mid", "idle", "blocked"]) {
    for (const width of [960, 1200, 2400]) {
      const vm = stageView(world(kind), { width, height: 200, nowMs: NOW });
      const n = world(kind).rt.live.size;
      if (n * 150 > width) continue;
      const w = Math.min(320, width / n);
      for (const h of vm.heroes) assert.ok(Math.abs(h.slot.w - w) < 0.2, `${kind}@${width}: slot ${h.slot.w} vs ${w}`);
      // spare width split at both ends; rooms tile the slots without gaps
      const xs = vm.rooms.map((r) => [r.x, r.x + r.w]);
      assert.ok(Math.abs(xs[0][0] - (width - n * w) / 2) < 0.2);
      for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i][0] - xs[i - 1][1]) < 0.2);
      for (const r of vm.rooms) assert.equal(r.skyBands.length, 4);
    }
  }
});

test("layout: positions inside a slot (stage review notes)", () => {
  const checks = { resting: 0, shipped: 0, supervising: 0, forks: 0 };
  for (const kind of DEMO_KINDS) {
    for (const width of [960, 1200, 2400]) {
      const vm = stageView(world(kind), { width, height: 200, nowMs: NOW });
      for (const h of vm.heroes) {
        if (!h.slot || h.slot.w < 150) continue;
        const rel = (x) => (x - h.slot.x) / h.slot.w;
        if (h.state === "resting" && h.campfire) {
          assert.ok(Math.abs(rel(h.x) - 0.22) < 0.01 && Math.abs(rel(h.campfire.x) - 0.08) < 0.01, `${kind}: resting ${rel(h.x)}`);
          checks.resting++;
        }
        if (h.forklings.length) {
          assert.ok(Math.abs(rel(h.x) - 0.16) < 0.01, `${kind}: hero with forklings at ${rel(h.x)}`);
          for (const f of h.forklings) assert.ok(rel(f.x) >= 0.299, `${kind}: forkling at ${rel(f.x)}`);
          checks.forks++;
        }
        const c = vm.chests.find((x) => x.heroId === h.heroId && !x.open);
        if (c && (h.state === "shipped" || h.state === "resting")) {
          // the SHIPPED ribbon (40 px over the chest's left edge − 6) stays clear of the face
          const ribbonLeft = c.x - 14 - 6;
          assert.ok(ribbonLeft >= h.x + 14 * h.scale, `${kind}@${width}: ribbon ${ribbonLeft} over the face at ${h.x}`);
          assert.ok(rel(c.x) >= 0.419, `${kind}: chest at ${rel(c.x)}`);
          checks.shipped++;
        }
      }
    }
  }
  assert.ok(checks.resting && checks.shipped && checks.forks, JSON.stringify(checks));
});

/**
 * A demo world with a boss fight running. The "late" world's fight comes from autopilot (Auto-boss)
 * and so from the balance numbers; when it did not happen, four questing heroes take on the
 * Bloatodon by hand so the four-fighter arena is still covered.
 */
const FIGHT_WORLDS = new Map();
async function fightWorld(kind) {
  if (FIGHT_WORLDS.has(kind)) return FIGHT_WORLDS.get(kind);
  const w = fresh(kind);
  if (!w.rt.fights.some((f) => f.kind !== "review")) {
    const { startFight } = await import("../mods/down-the-stack/game/boss.js");
    const { BOSSES } = await import("../mods/down-the-stack/game/data.js");
    const ids = [...w.rt.live].filter(([, l]) => l.state === "questing").map(([id]) => id).slice(0, 4);
    const silent = { fx() {}, note() {}, banner() {}, major() {}, journal() {} };
    startFight(w, "boss", BOSSES.findIndex((b) => b.id === "bloatodon"), ids, silent);
    w.rt.version++;
  }
  FIGHT_WORLDS.set(kind, w);
  return w;
}

test("layout: the boss arena keeps fighters ≥ 56 px apart, shows no BOSS tag, signs the home slots", async () => {
  for (const kind of ["boss", "late"]) {
    const fw = await fightWorld(kind);
    for (const width of [960, 1200, 1600, 2400]) {
      const vm = stageView(fw, { width, height: 200, nowMs: NOW });
      assert.ok(vm.boss, `${kind}@${width}: no arena`);
      const a = vm.boss.arena;
      const inside = vm.heroes.filter((h) => h.x >= a.x && h.x <= a.x + a.w).sort((p, q) => p.x - q.x);
      // D§9.5: participants that went done / idle walked out (late: Sol shipped, Wynn resting);
      // the ones still questing, supervising, crashed or blocked (holding) stay in the arena
      const fight = fw.rt.fights.find((f) => f.kind !== "review");
      const staying = fight.heroIds.filter((id) => ["questing", "supervising", "crashed", "waiting"].includes(fw.rt.live.get(id)?.state));
      assert.ok(inside.length >= Math.min(3, staying.length) && inside.length >= 2, `${kind}@${width}: ${inside.length} fighters`);
      for (const h of inside) assert.ok(staying.includes(h.heroId), `${kind}@${width}: ${h.name} walked out but fights`);
      for (let i = 1; i < inside.length; i++) assert.ok(inside[i].x - inside[i - 1].x >= 55.9, `${kind}@${width}: fighters ${inside[i].x - inside[i - 1].x} px apart`);
      for (const h of inside) assert.ok(!(h.tag && /BOSS/.test(h.tag.text)), `${kind}: BOSS tag in the arena`);
      // the boss and its parts stay inside the arena, right of the fighters
      assert.ok(vm.boss.x - vm.boss.w / 2 > inside.at(-1).x + 20, `${kind}@${width}: boss overlaps the fighters`);
      assert.ok(vm.boss.x + vm.boss.w / 2 <= a.x + a.w + 0.5);
      for (const p of vm.boss.parts) assert.ok(p.x - 16 >= a.x && p.x + 16 <= a.x + a.w + 0.5, `${kind}: part ${p.key} outside`);
      for (const s of vm.signs) assert.match(s.text, /^→ /);
      assert.ok(vm.rooms.at(-1).key.startsWith("room:arena:"));
      assert.equal(vm.rooms.at(-1).dividerLeft, true);
    }
  }
  const vm = stageView(world("boss"), { width: 1200, height: 200, nowMs: NOW });
  // the trio's adjacent home slots in one room share one sign; it counts the boss HP left like the
  // party's "BOSS n%" chip
  assert.equal(vm.signs.length, 1);
  assert.match(vm.signs[0].text, /^→ The Octopus Merge \d+% left$/);
  assert.equal(vm.boss.parts.length, 8);
  assert.equal(vm.boss.partSprite, "boss/octopus_merge-part.svg");
  assert.match(vm.boss.tooltip, /Win estimate: (Favored|Even|Risky) \(\d\.\d\d\)/);
});

test("overflow: protected heroes stay, the chip counts the rest, refolds wait up to 30 ticks", () => {
  for (const width of [960, 1200, 1600]) {
    const w = world("late");
    const vm = stageView(w, { width, height: 200, nowMs: NOW });
    assert.ok(vm.overflow, `late@${width}`);
    const shown = new Set(vm.heroes.map((h) => h.heroId));
    assert.equal(shown.size + vm.overflow.count, w.rt.live.size);
    assert.equal(vm.overflow.dots.length, vm.overflow.count);
    for (const [id, live] of w.rt.live) {
      const hero = w.state.heroes.find((h) => h.id === id);
      // a fight participant is protected while it is still in the fight (D§9.5: done / idle walk out)
      const inFight = ["questing", "supervising", "crashed", "waiting"].includes(live.state) && w.rt.fights.some((f) => f.heroIds.includes(id));
      const prot = live.state === "waiting" || live.focused || live.pinned || (hero.pend && hero.pend.length) || inFight;
      if (prot) assert.ok(shown.has(id), `late@${width}: protected hero ${id} folded`);
    }
    assert.ok(vm.overflow.x + vm.overflow.w <= width + 0.5);
    assert.ok(vm.overflow.w >= 150);
  }
  // hysteresis: a status change of a folded hero does not refold at once; a newly blocked one
  // is promoted at once
  const w = fresh("late");
  const vm0 = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  const folded = [...w.rt.live.keys()].filter((id) => !vm0.heroes.some((h) => h.heroId === id));
  const target = folded.find((id) => w.rt.live.get(id).state === "questing");
  const addr = w.rt.live.get(target).address;
  const snap = demoSnapshot(w, NOW + 1000);
  snap.agents.find((a) => a.address === addr).status = "blocked";
  snap.agents.find((a) => a.address === addr).seq += 9;
  tick(w, snap);
  const vm1 = stageView(w, { width: 1200, height: 200, nowMs: NOW + 1000 });
  assert.ok(vm1.heroes.some((h) => h.heroId === target), "the newly blocked hero is promoted at once");
  // someone else went to camp, or (when the protected heroes need squeezed slots) the promoted
  // hero squeezed in: never more than one more slot
  assert.ok(vm1.heroes.length - vm0.heroes.length <= 1 && vm1.heroes.length >= vm0.heroes.length, `${vm0.heroes.length} -> ${vm1.heroes.length}`);
  assert.ok(vm1.overflow && vm1.overflow.x + vm1.overflow.w <= 1200.5, "the camp chip still fits");
});

test("overflow: the camp chip's tooltip names at most 12 heroes, most relevant first (waiting, chest, working, resting), then 'and N more'", async () => {
  const G = {
    Demo: await import("../mods/down-the-stack/game/demo.js"), W: await import("../mods/down-the-stack/game/world.js"),
    liveHeroes: (await import("../mods/down-the-stack/game/agents.js")).liveHeroes, ...(await import("../mods/down-the-stack/game/herd.js")),
  };
  const { findHero } = await import("../mods/down-the-stack/game/combat.js");
  const { world: w } = stressWorld(G, NOW, 60);
  // 20 waiting (more than squeezed slots hold at 1600 px, so some wait at camp), 10 with a chest,
  // the rest resting or questing in turn
  let i = 0;
  const kind = new Map();
  for (const [id, live] of w.rt.live) {
    const k = i++;
    live.focused = false; live.pinned = false;
    findHero(w, id).pend = [];
    if (k % 3 === 0 && k < 60) { live.state = "waiting"; live.bubbleShown = true; live.blockedSince = w.rt.tick - 300; kind.set(id, 0); } else if (k % 6 === 1) {
      live.state = "resting"; findHero(w, id).pend = [{ min: 30, fmin: 0, title: "Bump deps", at: NOW - 60000, sealFactor: 1 }]; kind.set(id, 1);
    } else if (k % 2) { live.state = "questing"; kind.set(id, 2); } else { live.state = "resting"; kind.set(id, 3); }
  }
  w.rt.version++;
  const vm = stageView(w, { width: 1600, height: 200, nowMs: NOW });
  const folded = [...w.rt.live.keys()].filter((id) => !vm.heroes.some((h) => h.heroId === id));
  assert.equal(vm.overflow.count, folded.length);
  assert.ok(folded.length > 20, `${folded.length} at camp`);
  assert.ok(folded.some((id) => kind.get(id) === 0), "some waiting heroes are at camp");
  const lines = vm.overflow.tooltip.split("\n");
  assert.equal(lines[0], `At camp (${folded.length}):`);
  assert.equal(lines.length, 1 + 12 + 1, vm.overflow.tooltip);
  // the twelve named: most relevant first
  const byName = new Map(folded.map((id) => [findHero(w, id).name, id]));
  const ranks = lines.slice(1, 13).map((l) => kind.get(byName.get(l.split(" · ")[0])));
  assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b), `ranks ${ranks}`);
  const waitingAtCamp = folded.filter((id) => kind.get(id) === 0).length;
  assert.equal(ranks.filter((r) => r === 0).length, Math.min(12, waitingAtCamp), "every waiting hero at camp is named first");
  for (const l of lines.slice(1, 13)) {
    const r = kind.get(byName.get(l.split(" · ")[0]));
    assert.match(l, r === 0 ? / · waiting for you$/ : r === 1 ? / · chest waiting$/ : r === 2 ? / · questing$/ : / · resting$/, l);
  }
  // the rest, counted by kind
  const rest = folded.filter((id) => !lines.slice(1, 13).some((l) => byName.get(l.split(" · ")[0]) === id));
  const count = (r) => rest.filter((id) => kind.get(id) === r).length;
  const parts = [[0, "waiting"], [1, "with a chest"], [2, "working"], [3, "resting"]].filter(([r]) => count(r)).map(([r, word]) => `${count(r)} ${word}`);
  assert.equal(lines[13], `…and ${folded.length - 12} more (${parts.join(", ")})`);
  // the dots follow the same order: a waiting hero's amber comes first (the chip draws ten)
  assert.equal(vm.overflow.dots.length, folded.length);
  assert.equal(vm.overflow.dots[0], "#F2A93B");
  // a small camp lists everyone, and no "more" line
  const late = stageView(world("late"), { width: 1200, height: 200, nowMs: NOW });
  const ll = late.overflow.tooltip.split("\n");
  assert.equal(ll.length, 1 + late.overflow.count);
  assert.ok(!ll.some((l) => l.startsWith("…and")));
});

test("cues: bubbles, crates, tags, zzz, campfires, chests and why tooltips come from the engine", () => {
  const vm = stageView(world("blocked"), { width: 1200, height: 200, nowMs: NOW });
  const waiting = vm.heroes.filter((h) => h.state === "waiting");
  assert.ok(waiting.length >= 3);
  for (const h of waiting) {
    assert.equal(h.face, "o_o");
    assert.equal(h.crate, true);
    assert.match(h.bubble.label, /^Waiting for you · \d+[smh]/);
    assert.match(h.tag.text, /^! (\d+m|1h\+)$/);
    assert.equal(h.tag.color, "#F2A93B");
  }
  for (const m of vm.mobs) if (waiting.some((h) => m.x > h.slot.x && m.x < h.slot.x + h.slot.w)) assert.equal(m.pacing, false);
  const idle = stageView(world("idle"), { width: 1200, height: 200, nowMs: NOW });
  assert.equal(idle.stillness, true);
  assert.ok(idle.rooms.every((r) => r.dusk && !r.working));
  assert.ok(idle.heroes.filter((h) => h.state === "resting").every((h) => h.campfire && h.face === "-_-"));
  assert.ok(idle.chests.length && idle.chests[0].tooltip.startsWith("Shipped: "));
  const mid = stageView(world("mid"), { width: 1200, height: 200, nowMs: NOW });
  const q = mid.heroes.find((h) => h.state === "questing");
  assert.match(q.tooltip, /XP\/min = working ×1/);
  assert.match(q.tooltip, /Shift: \d+m today \(full rate until 4h\)/);
  assert.match(whyText({ state: "questing", working: 1, xpPerMin: 512, freshEyes: 1.5, party: 0.12, banner: 0, herd: 0.23, unblocked: 0.15, onboarding: 0, gear: 0, crowding: 1, shiftMin: 192, shiftBand: 0, nextBandMin: 240 }),
    /^\+512 XP\/min = working ×1 · Fresh Eyes ×1\.5 · Party \+12% · Herd \+23% · Unblocked \+15% · Shift: 3h 12m today \(full rate until 4h\)$/);
  const room = mid.rooms.find((r) => r.quota);
  assert.match(room.stats, /^\d+\/40 · Sprint \d+\/25$/);
  assert.match(room.tooltip, /Quota \d+\/40 kills/);
});

test("settings: calm drops numbers and celebrations; nums 'crits' keeps only crits", () => {
  const calm = stageView(world("calm"), { width: 1200, height: 200, nowMs: NOW });
  assert.equal(calm.calm, true);
  assert.equal(calm.nums, "off");
  assert.ok(calm.fx.every((f) => !["num", "crit", "heal", "miss", "inv", "abs", "incoming", "levelup", "pillar", "skill"].includes(f.kind)));
  const w = fresh("mid");
  command(w, "setting", { key: "nums", value: "crits" }, NOW);
  const vm = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  assert.equal(vm.nums, "crits");
  assert.ok(vm.fx.every((f) => !["num", "heal", "miss", "inv", "abs", "incoming"].includes(f.kind)));
});

test("settings: loot glow minimum rarity hides the loot glows and pillars below it (D§11.15)", () => {
  const w = fresh("mid");
  const rt = w.rt;
  const ids = [...rt.live.keys()].filter((id) => id > 0).slice(0, 6);
  ids.forEach((heroId, i) => rt.fx.push({ kind: "loot", heroId, rar: i, text: "", value: 0, key: `fx:${rt.tick}:loot${i}`, bornTick: rt.tick }));
  rt.fx.push({ kind: "pillar", heroId: ids[0], rar: 4, text: "LTS", value: 0, key: `fx:${rt.tick}:p4`, bornTick: rt.tick });
  rt.fx.push({ kind: "pillar", heroId: ids[1], rar: 5, text: "Keepsake", value: 0, key: `fx:${rt.tick}:p5`, bornTick: rt.tick });
  rt.version++;
  const shown = (vm) => vm.fx.filter((f) => f.kind === "loot" || f.kind === "pillar").map((f) => f.key.split(":")[2]).sort();
  const at = (glow) => {
    if (glow != null) assert.equal(command(w, "setting", { key: "glow", value: glow }, NOW).ok, true);
    return shown(stageView(w, { width: 1600, height: 200, nowMs: NOW }));
  };
  // the default keeps today's behaviour: every drop glows, LTS and Keepsake raise pillars
  assert.deepEqual(at(null), ["loot0", "loot1", "loot2", "loot3", "loot4", "loot5", "p4", "p5"]);
  assert.deepEqual(at("release"), ["loot3", "loot4", "loot5", "p4", "p5"]);
  assert.deepEqual(at("keepsake"), ["loot5", "p5"]);
  assert.deepEqual(at(0), ["loot0", "loot1", "loot2", "loot3", "loot4", "loot5", "p4", "p5"]);
});

test("memo: the same version and size return the same VM; a new tick builds a new one", () => {
  const w = fresh("mid");
  const a = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  assert.equal(stageView(w, { width: 1200, height: 200, nowMs: NOW + 300 }), a);
  assert.notEqual(stageView(w, { width: 960, height: 200, nowMs: NOW }), a);
  const ref = { now: NOW };
  step(w, ref);
  assert.notEqual(stageView(w, { width: 1200, height: 200, nowMs: ref.now }), a);
  // a brand-new world needs no memory to render
  const blank = createWorld({ nowMs: NOW });
  assert.equal(stageView(blank, { width: 640, height: 200, nowMs: NOW }).empty.kind, "no_agents");
});

test("memo: two stage copies of different widths keep their own mob, chest and fold memory", () => {
  // a second stage (a pane, tab or overlay with props {role:"stage"}) builds every world version
  // at its own width too: the layout's copy must see exactly what it sees alone
  for (const [kind, N] of [["first-day", 240], ["mid", 80], ["late", 60]]) {
    const alone = fresh(kind);
    const both = fresh(kind);
    const driver = fresh(kind);
    let now = NOW;
    const acc = { dying: 0, opened: 0 };
    for (let i = 0; i < N; i++) {
      now += 1000;
      const snap = demoSnapshot(driver, now);
      tick(alone, snap);
      tick(both, snap);
      const a = stageView(alone, { width: 960, height: 200, nowMs: now });
      const b = stageView(both, { width: 960, height: 200, nowMs: now });
      stageView(both, { width: 1500, height: 120, nowMs: now }); // the other copy
      assert.equal(JSON.stringify(b), JSON.stringify(a), `${kind} tick ${i}`);
      acc.dying += a.mobs.filter((m) => m.dying).length;
      acc.opened += a.chests.filter((c) => c.open).length;
    }
    assert.ok(acc.dying > 0, `${kind}: some kills fade out (${JSON.stringify(acc)})`);
    if (kind === "first-day") assert.ok(acc.opened > 0, `${kind}: an opened chest shows its lid`);
  }
  // more widths than remembered: the least recently built goes, the strip still builds
  const w = fresh("mid");
  for (const width of [700, 800, 900, 1000, 1100]) assert.ok(stageView(w, { width, height: 200, nowMs: NOW }).heroes.length);
});

test("names: two live heroes sharing a first name get an epithet initial on their plates", () => {
  const vm = stageView(world("late"), { width: 2880, height: 200, nowMs: NOW });
  const ivos = vm.heroes.filter((h) => h.name.startsWith("Ivo "));
  assert.equal(ivos.length, 2, "the late demo has two Ivos");
  const label = (h) => h.nameplate.text.replace(/ \d+$/, "");
  assert.deepEqual(ivos.map((h) => h.nameplate.text).sort(), ivos.map((h) => `${label(h)} ${h.level}`).sort());
  assert.notEqual(label(ivos[0]), label(ivos[1]));
  for (const h of ivos) assert.match(label(h), /^Ivo [A-Z]\.$/);
  const byName = Object.fromEntries(ivos.map((h) => [h.name, label(h)]));
  if (byName["Ivo of Small Commits"]) assert.equal(byName["Ivo of Small Commits"], "Ivo S.");
  if (byName["Ivo Off-By-One"]) assert.equal(byName["Ivo Off-By-One"], "Ivo O.");
  // everyone else keeps the bare first name
  for (const h of vm.heroes) if (!h.name.startsWith("Ivo ")) assert.equal(label(h), h.name.split(" ")[0], h.name);
  // all plates on the strip read differently
  const labels = vm.heroes.map(label);
  assert.equal(new Set(labels).size, labels.length);
  // same initial too: all epithet initials, then the hero id
  const w = fresh("mid");
  const live = [...w.rt.live.keys()].map((id) => w.state.heroes.find((h) => h.id === id)).filter(Boolean);
  live[0].name = "Kip the Tested";
  live[1].name = "Kip the Typed";
  live[2].name = "Kip";
  w.rt.version++;
  const vm2 = stageView(w, { width: 2400, height: 200, nowMs: NOW });
  const kips = vm2.heroes.filter((h) => h.name.startsWith("Kip")).map(label);
  assert.equal(kips.length, 3);
  assert.equal(new Set(kips).size, 3, kips.join(" | "));
  for (const k of kips) assert.match(k, /^Kip #\d+$/);
});

test("Duck Chest: a Holo Rubber Duck's kill pops a Duck Chest where it stood, open the next tick", async () => {
  const COMBAT = await import("../mods/down-the-stack/game/combat.js");
  const { MOB_BY_ID } = await import("../mods/down-the-stack/game/data.js");
  const w = fresh("first-day");
  const ref = { now: NOW };
  const view = () => stageView(w, { width: 960, height: 200, nowMs: ref.now });
  view();
  const live = [...w.rt.live.values()].find((l) => l.state === "questing" && (l.lane || []).length);
  assert.ok(live, "a questing hero with a lane");
  const m = COMBAT._internal.makeMob(w.rt, MOB_BY_ID.holo_duck, 3, { arriveTick: live.ct, holo: true });
  m.hp = 1;
  live.lane.unshift(m);
  live.engagedUid = m.uid;
  m.engaged = true;
  w.rt.version++;
  const seen = view().mobs.find((x) => x.key === `mob:${m.uid}`);
  assert.ok(seen && seen.holo, "the duck is on stage");
  const ducks0 = w.state.herd.ducks || 0;
  let born = null;
  const frames = [];
  for (let i = 0; i < 6; i++) {
    step(w, ref);
    const vm = view();
    const d = vm.chests.filter((c) => c.tier === "duck");
    if (born == null && (w.state.herd.ducks || 0) > ducks0) born = i;
    if (born != null) frames.push(d.map((c) => ({ open: c.open, x: c.x, heroId: c.heroId })));
    if (born != null && frames.length >= 3) break;
  }
  assert.ok(born != null, "the duck died");
  assert.deepEqual(frames.map((f) => f.map((c) => c.open)), [[false], [true], []], JSON.stringify(frames));
  assert.equal(frames[0][0].x, seen.x, "where the duck stood");
  assert.equal(frames[0][0].heroId, live.heroId);
  // its key, tooltip and shape conform; it is no Commit Chest (nothing pending to claim)
  const hero = w.state.heroes.find((h) => h.id === live.heroId);
  assert.equal((hero.pend || []).length, 0);
});

test("review end: a won review leaves the Promotion banner in the slot for 3 ticks, a lost one the card", async () => {
  for (const outcome of ["won", "lost"]) {
    const w = fresh("boss");
    let now = NOW;
    command(w, "retreat", {}, now);
    const h = w.state.heroes.find((x) => x.L >= 30 && w.rt.live.get(x.id)?.state === "questing");
    assert.ok(h, "a Lv 30+ questing hero");
    h.rev = [0, 0];
    const r = command(w, "challenge", { kind: "review", idx: 0, heroId: h.id }, now);
    assert.equal(r.ok, true, JSON.stringify(r));
    const f = w.rt.fights.find((x) => x.kind === "review");
    const view = () => stageView(w, { width: 1200, height: 200, nowMs: now });
    view();
    if (outcome === "won") for (const p of f.parts) p.hp = p.kind === "boss" ? 1 : 0;
    else command(w, "retreat", { heroId: h.id }, now);
    const ends = [];
    for (let i = 0; i < 8 && ends.length < 5; i++) {
      if (i > 0 || outcome === "won") { now += 1000; tick(w, demoSnapshot(w, now)); }
      if (w.rt.fights.includes(f)) continue;
      const vm = view();
      const hv = vm.heroes.find((x) => x.heroId === h.id);
      ends.push(hv ? hv.reviewEnd : "gone");
      const errs = [];
      conform(vm, SCHEMA, "", errs);
      errs.push(...hygiene(vm));
      assert.deepEqual(errs, [], `${outcome} tick ${i}`);
    }
    assert.equal(f.result, outcome);
    const shown = ends.filter(Boolean);
    assert.ok(shown.length >= 3 && shown.length <= 4, `${outcome}: ${JSON.stringify(ends)}`);
    assert.equal(ends.at(-1), null, "then gone");
    for (const e of shown) {
      if (outcome === "won") assert.deepEqual([e.kind, e.text, e.sub], ["promoted", "PROMOTED", careerOf(h).title]);
      else { assert.equal(e.kind, "postmortem"); assert.match(e.text, /^Postmortem/); assert.match(e.sub, /wounds kept/); }
    }
    assert.deepEqual(shown.map((e) => e.age), shown.map((_, i) => shown[0].age + i), "age counts up");
  }
});

test("a map pin shows wherever the map is named (header, hero tooltip, party row); the level gap shows when it binds", async () => {
  const { partyView, sheetView } = await import("../mods/down-the-stack/game/view.js");
  const { gap } = await import("../mods/down-the-stack/game/formulas.js");
  const { MAP_BY_ID } = await import("../mods/down-the-stack/game/data.js");
  const w = fresh("mid");
  const ref = { now: NOW };
  const echo = w.state.heroes.find((h) => h.id === 1);
  assert.ok(echo.L >= 30 && w.rt.live.get(1).state === "questing");
  // before: the 1-1 room (if any) is not pinned, and no why names a level gap
  let vm = stageView(w, { width: 1600, height: 200, nowMs: ref.now });
  assert.ok(vm.rooms.every((r) => !r.pin || r.pin.pinned === false));
  assert.ok(vm.heroes.every((h) => !/levels? below/.test(h.tooltip) && !/\(pinned/.test(h.tooltip)));
  // one click on a header pins; autopilot moves the hero there on the next ticks
  assert.equal(command(w, "pinMap", { heroId: 1, mapId: "1-1" }, ref.now).ok, true);
  for (let i = 0; i < 4; i++) step(w, ref);
  assert.equal(w.rt.live.get(1).mapId, "1-1");
  vm = stageView(w, { width: 1600, height: 200, nowMs: ref.now });
  const room = vm.rooms.find((r) => r.mapId === "1-1");
  assert.deepEqual(room.pin, { heroIds: [1], mapId: null, pinned: true }, "the header knows it is pinned (and unpins)");
  assert.match(room.tooltip, /Pinned: this hero stays on 1-1 · click to unpin/);
  const hv = vm.heroes.find((h) => h.heroId === 1);
  assert.match(hv.tooltip, /1-1 Squiggle Path \(pinned: click the room header to unpin\)/);
  // the level gap (D§6.2): ×gap(L − mid) on every why line, and in the sheet's XP breakdown
  const mult = Math.round(gap(Math.round(echo.L - MAP_BY_ID["1-1"].mid)) * 100) / 100;
  assert.ok(mult < 1);
  const part = `1-1 is ${Math.round(echo.L - MAP_BY_ID["1-1"].mid)} levels below: ×${mult}`;
  assert.ok(hv.tooltip.includes(part), hv.tooltip);
  const row = partyView(w, { width: 268, nowMs: ref.now }).groups.flatMap((g) => g.rows).find((r) => r.heroId === 1);
  // the party row: the map stays plain on line 2 (a "(pinned)" there was cut off at the default
  // sidebar width); the pin is RowVM.mapPin, a glyph beside the level with its reason as tooltip
  assert.equal(row.mapLabel, "1-1 Squiggle Path");
  assert.deepEqual(row.mapPin, { tooltip: "Pinned to 1-1 Squiggle Path: the autopilot keeps it on this map (Auto on the Career tab's Map card unpins it)" });
  assert.ok(row.tooltip.split("\n").includes(row.mapPin.tooltip), row.tooltip);
  assert.ok(row.tooltip.includes(part), row.tooltip);
  const filter = { slot: "all", minRar: 0, usable: false, sort: "score", focus: null, squash: [] };
  const gp = sheetView(w, { heroId: 1, tab: "stats", filter }).stats.why.parts.find((p) => p.key === "gap");
  assert.equal(gp.value, `×${mult}`);
  assert.equal(gp.good, false);
  // a hero on a map near its level names no gap and no pin
  const other = vm.heroes.find((h) => h.heroId !== 1 && /XP\/min/.test(h.tooltip));
  assert.ok(other && !/levels? below/.test(other.tooltip) && !/\(pinned/.test(other.tooltip), other?.tooltip);
  // unpinned: the marks go
  assert.equal(command(w, "pinMap", { heroId: 1, mapId: null }, ref.now).ok, true);
  w.rt.version++;
  vm = stageView(w, { width: 1600, height: 200, nowMs: ref.now });
  assert.ok(vm.rooms.every((r) => !r.pin || r.pin.pinned === false));
  assert.doesNotMatch(vm.heroes.find((h) => h.heroId === 1).tooltip, /\(pinned/);
  assert.equal(partyView(w, { width: 268, nowMs: ref.now }).groups.flatMap((g) => g.rows).find((r) => r.heroId === 1).mapPin, null);
});

test("a pinned hero in a mixed room is told the sheet's Map card unpins it (the header's click would pin the whole room)", () => {
  const w = fresh("mid");
  let vm = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  const room = vm.rooms.find((r) => r.pin && r.pin.heroIds.length >= 2);
  assert.ok(room, "a room with two heroes or more");
  const [first, ...rest] = room.pin.heroIds;
  assert.equal(command(w, "pinMap", { heroId: first, mapId: room.mapId }, NOW).ok, true);
  w.rt.version++;
  vm = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  const mixed = vm.rooms.find((r) => r.mapId === room.mapId && r.pin && r.pin.heroIds.includes(first));
  assert.equal(mixed.pin.pinned, false);
  assert.equal(mixed.pin.mapId, room.mapId, "the header's click pins everyone here");
  const tip = (id) => vm.heroes.find((h) => h.heroId === id).tooltip;
  assert.match(tip(first), /\(pinned: Auto on the Career tab's Map card unpins\)/);
  assert.doesNotMatch(tip(first), /click the room header to unpin/);
  for (const id of rest) assert.doesNotMatch(tip(id), /\(pinned/);
  // the whole room pinned: the header's click unpins, and the tooltips say so
  for (const id of rest) assert.equal(command(w, "pinMap", { heroId: id, mapId: room.mapId }, NOW).ok, true);
  w.rt.version++;
  vm = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  for (const id of room.pin.heroIds) assert.match(tip(id), /\(pinned: click the room header to unpin\)/);
});

test("clicks in the VM: room pin, boss door challenge, boss retreat and loot pillar targets", () => {
  // pin: every hero of a room pinned here → the header unpins
  const w = fresh("mid");
  let vm = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  const room = vm.rooms.find((r) => r.pin && r.pin.heroIds.length);
  assert.equal(room.pin.mapId, room.mapId);
  for (const id of room.pin.heroIds) assert.equal(command(w, "pinMap", { heroId: id, mapId: room.mapId }, NOW).ok, true);
  w.rt.version++;
  vm = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  const again = vm.rooms.find((r) => r.key === room.key) || vm.rooms.find((r) => r.mapId === room.mapId);
  assert.equal(again.pin.mapId, null, "all pinned: the click unpins");
  assert.match(again.tooltip, /auto map choice/);
  assert.equal(again.pin.pinned, true);
  // the boss door: a click target only where the challenge would start (the stage shows no command
  // result, so a door the engine refuses stays a sign and its header says why)
  let refused = 0;
  for (const kind of DEMO_KINDS) {
    const v = stageView(world(kind), { width: 1600, height: 200, nowMs: NOW });
    for (const r of v.rooms) {
      if (!r.door) { assert.equal(r.challenge, null, `${kind} ${r.key}`); continue; }
      const can = canChallenge(world(kind), "boss", BOSSES.findIndex((b) => ZONES[b.zone]?.id === r.zone));
      if (can.ok) assert.ok(r.challenge && r.challenge.kind === "boss" && Number.isInteger(r.challenge.idx), `${kind} ${r.key}`);
      else {
        refused++;
        assert.equal(r.challenge, null, `${kind} ${r.key}: ${can.error}`);
        assert.ok(r.tooltip.includes(can.error), `${kind} ${r.key}: the header says why`);
      }
    }
    for (const r of v.rooms) if (r.key.startsWith("room:arena:")) assert.equal(r.pin, null);
    if (v.boss) assert.equal(Boolean(v.boss.retreat), !v.boss.stamp && !v.boss.banner?.kind?.startsWith("post"), kind);
  }
  assert.ok(refused >= 1, "a demo world shows an open door while another boss fight is on");
  // the late demo: the Monolith's door is open while the Bloatodon fight runs (a sign, "A boss
  // fight is on"); after a Retreat it challenges, and that click starts the fight
  const wl = fresh("late");
  let vl = stageView(wl, { width: 2400, height: 200, nowMs: NOW });
  const doorRoom = vl.rooms.find((r) => r.door && /A boss fight is on/.test(r.tooltip));
  assert.ok(doorRoom && doorRoom.challenge === null, "late: an open door while another boss fight is on");
  assert.equal(command(wl, "retreat", {}, NOW).ok, true);
  wl.rt.version++;
  vl = stageView(wl, { width: 2400, height: 200, nowMs: NOW });
  const reopened = vl.rooms.find((r) => r.door && r.mapId === doorRoom.mapId);
  assert.ok(reopened && reopened.challenge, "no fight on: the door challenges");
  assert.doesNotMatch(reopened.tooltip, /A boss fight is on/);
  assert.equal(command(wl, "challenge", { kind: reopened.challenge.kind, idx: reopened.challenge.idx }, NOW).ok, true);
  // a loot pillar knows the finder's sheet and the item
  const w2 = fresh("mid");
  const hero = w2.state.heroes.find((h) => w2.rt.live.has(h.id));
  w2.rt.fx.push({ key: `fx:${w2.rt.tick}:999`, kind: "pillar", heroId: hero.id, roomId: null, rar: 4, value: 4242, text: "LTS", bornTick: w2.rt.tick });
  w2.rt.version++;
  const p = stageView(w2, { width: 1200, height: 200, nowMs: NOW }).fx.find((f) => f.kind === "pillar");
  assert.ok(p);
  assert.deepEqual(p.sheet, { heroId: hero.id, itemUid: 4242 });
});

// ---------------------------------------------------------------------------------------------
// (4) Performance (V8; QuickJS is ~20-50x slower, the render budget there is 50 ms)
// ---------------------------------------------------------------------------------------------

test("perf: view and view + render stay fast for the biggest demo world", async (t) => {
  const w = world("late");
  const env = { width: 2400, height: 200, zoom: 1, theme: {}, host: null, act: () => {} };
  let viewMs = 0;
  let allMs = 0;
  const N = 20;
  // a pass inside a mocked render (renderStage builds elements)
  M.resetState();
  let vm = null;
  class P extends View {
    render() {
      _resetStageMemo(w);
      const t0 = performance.now();
      vm = stageView(w, { width: 2400, height: 200, nowMs: NOW });
      const t1 = performance.now();
      const el = renderStage(vm, env);
      const t2 = performance.now();
      viewMs += t1 - t0;
      allMs += t2 - t0;
      return el;
    }
  }
  const mod = await M.mountView(P, {});
  for (let i = 0; i < N; i++) mod.render();
  assert.deepEqual(problems(mod), []);
  // strict with PERF=1; under load only a hang fails (×10)
  const k = PERF ? 1 : 10;
  t.diagnostic(`stageView ${(viewMs / N).toFixed(2)} ms, view + render ${(allMs / N).toFixed(2)} ms (bounds ${8 * k} / ${25 * k} ms${PERF ? ", PERF=1" : ""})`);
  assert.ok(viewMs / N < 8 * k, `stageView ${(viewMs / N).toFixed(2)} ms`);
  assert.ok(allMs / N < 25 * k, `view + render ${(allMs / N).toFixed(2)} ms`);
});

test("a Staff Review's Nitpicks stand in lanes 1..n behind the opponent's lane 0 (a crowded stage culls them by lane)", async () => {
  const { startFight } = await import("../mods/down-the-stack/game/boss.js");
  const w = fresh("late");
  const silent = { fx() {}, note() {}, banner() {}, major() {}, journal() {} };
  const busy = new Set(w.rt.fights.flatMap((f) => f.heroIds));
  const live = [...w.rt.live.values()].find((l) => l.state === "questing" && !busy.has(l.heroId) && w.state.heroes.find((h) => h.id === l.heroId).L >= 60);
  const hero = w.state.heroes.find((h) => h.id === live.heroId);
  hero.rev = [1, 0];
  const f = startFight(w, "review", 1, [hero.id], silent);
  assert.ok(f && f.kind === "review");
  // past the first third of its HP the Reviewer calls two Nitpicks (boss.js staff_review)
  f.parts.find((p) => p.kind === "boss").hp = Math.round(f.pool * 0.6);
  step(w, { now: NOW });
  assert.equal(f.parts.filter((p) => p.kind === "add" && p.hp > 0).length, 2, "two Nitpicks");
  let seen = 0;
  for (const width of [1200, 2400, 4000]) {
    const vm = stageView(w, { width, height: 200, nowMs: NOW + 1000 });
    const mine = vm.mobs.filter((m) => m.key.startsWith(`mob:${f.key}:`));
    const opp = mine.find((m) => m.key.endsWith(":body"));
    assert.ok(opp, `@${width}: the opponent`);
    assert.equal(opp.lane, 0, `@${width}: the opponent at the front`);
    const adds = mine.filter((m) => m !== opp);
    assert.ok(adds.length >= 1, `@${width}: a Nitpick shows`);
    assert.deepEqual(adds.map((m) => m.lane), adds.map((_, i) => i + 1), `@${width}: Nitpicks in lanes 1..n`);
    seen += adds.length;
  }
  assert.ok(seen >= 3);
});

test("cues: a promotion review in the hero's own slot, a crash, a supervisor", async () => {
  const { startFight } = await import("../mods/down-the-stack/game/boss.js");
  const w = fresh("mid");
  const silent = { fx() {}, note() {}, banner() {}, major() {}, journal() {} };
  // Echo (Lv 33, questing) takes the Senior Review in its own slot
  const echo = w.state.heroes.find((h) => h.L >= 30);
  const f = startFight(w, "review", 0, [echo.id], silent);
  assert.ok(f && f.kind === "review");
  // Jax crashes; Zed (resting) supervises a working sub-agent
  const jax = [...w.rt.live.values()].find((l) => l.state === "questing" && l.heroId !== echo.id);
  jax.crashedUntil = w.rt.tick + 3;
  jax.state = "crashed";
  const zed = [...w.rt.live.values()].find((l) => l.state === "resting");
  zed.forklings = [{ address: "sub9", status: "working", title: "Run the linter", program: null }];
  zed.state = "supervising";
  w.rt.version++;
  const vm = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  const errs = [];
  conform(vm, SCHEMA, "", errs);
  errs.push(...hygiene(vm));
  assert.deepEqual(errs, []);
  const he = vm.heroes.find((h) => h.heroId === echo.id);
  assert.deepEqual(he.tag, { text: "REVIEW", color: "#FF5A5F" });
  assert.equal(he.attacking, true);
  const room = vm.rooms.find((r) => he.x >= r.x && he.x < r.x + r.w);
  assert.equal(room.review, true);
  assert.match(room.title, /^REVIEW · /);
  const opp = vm.mobs.find((m) => m.sprite === "boss/senior_reviewer.svg");
  assert.ok(opp && opp.x > he.slot.x && opp.x < he.slot.x + he.slot.w, "the opponent stands in the hero's slot");
  assert.equal(vm.boss, null, "a review opens no arena");
  const hj = vm.heroes.find((h) => h.heroId === jax.heroId);
  assert.equal(hj.face, ":(");
  assert.equal(hj.opacity, 0.6);
  assert.ok(hj.rebootFrac >= 0 && hj.rebootFrac <= 1);
  assert.deepEqual(hj.tag, { text: "rebooting", color: "#8A8F98" });
  const hz = vm.heroes.find((h) => h.heroId === zed.heroId);
  assert.equal(hz.opacity, 0.6);
  assert.equal(Math.round(((hz.x - hz.slot.x) / hz.slot.w) * 100), 16);
  assert.equal(hz.forklings[0].tooltip, "Sub-agent: Run the linter");
  assert.ok((hz.forklings[0].x - hz.slot.x) / hz.slot.w >= 0.299);
  const { mod } = await mountStage(vm);
  assert.deepEqual(problems(mod), []);
});

// ---------------------------------------------------------------------------------------------
// Assembly: text floats never overlap each other, and stay below the header band
// ---------------------------------------------------------------------------------------------

test("fx: text floats of one tick never overlap, also on short stages, and stay below the header band", async () => {
  const SIZE = { num: 11, crit: 13, heal: 11, miss: 11, inv: 11, abs: 11, incoming: 9, skill: 10, unblocked: 11, ship: 11 };
  let seen = 0;
  for (const kind of ["mid", "boss", "late", "first-day"]) {
    const w = kind === "boss" || kind === "late" ? await fightWorld(kind) : fresh(kind);
    const ref = { now: NOW };
    for (let i = 0; i < 12; i++) {
      step(w, ref);
      for (const height of [200, 120]) {
        const vm = stageView(w, { width: 1200, height, nowMs: ref.now });
        const boxes = vm.fx.filter((f) => SIZE[f.kind] && f.kind !== "incoming").map((f) => ({
          f, w: String(f.text).length * SIZE[f.kind] * 0.6 + 8 + (f.kind === "crit" ? 22 : 0), h: SIZE[f.kind] + 5,
        }));
        seen += boxes.length;
        for (const b of boxes) assert.ok(b.f.y >= 28 + (200 - height) - 0.01, `${kind}@${height}: ${b.f.kind} "${b.f.text}" at y ${b.f.y}`);
        for (let a = 0; a < boxes.length; a++) {
          for (let c = a + 1; c < boxes.length; c++) {
            const p = boxes[a], q = boxes[c];
            if (p.f.age !== q.f.age) continue;
            const overlap = Math.abs(p.f.x - q.f.x) < (p.w + q.w) / 2 && Math.abs(p.f.y - q.f.y) < (p.h + q.h) / 2;
            if (overlap) assert.fail(`${kind}@${height} tick ${i}: "${p.f.text}" and "${q.f.text}" overlap`);
          }
        }
      }
    }
  }
  assert.ok(seen > 20, `only ${seen} floats seen`);
});

// ---------------------------------------------------------------------------------------------
// (5) The element and animation budget on ultrawide stages (D§11.9.7: ~400 elements, ~150
//     animated): 30 to 60 heroes, the tools/qjs "stress30" recipe
// ---------------------------------------------------------------------------------------------

/**
 * tools/qjs/driver.js stressWorld for n agents (30 hired over five days; past the roster, and past
 * a day's six hires, Contractors): three spaces, every sixth agent with three sub-agents, high
 * levels and rare gear, the late zones open; `boss` starts a zone boss fight. G holds the game
 * modules (the mod's own graph when mounted through main.js, so the host runs the same code).
 */
function stressWorld(G, nowMs, n, { boss = false } = {}) {
  const { Demo, W, liveHeroes, addGold, addSnippets } = G;
  const SEC = 1000, DAY = 24 * 3600 * SEC;
  const t0 = nowMs - 5 * DAY - 10 * 60 * SEC;
  const plans = [[["working", 3000]], [["working", 1500], ["done", 300]], [["working", 600], ["blocked", 90], ["working", 900]], [["idle", 600], ["working", 1200]], [["working", 2000], ["done", 120], ["idle", 200]]];
  const progs = ["claude", "codex", "pi", "opencode"];
  const ags = [];
  for (let k = 0; k < n; k++) {
    const sp = k % 3;
    const subs = k % 6 === 0 ? [0, 1, 2].map((j) => ({ address: `t${k + 1}s${j}`, plan: [["working", 400 + 50 * j], ["done", 60]], title: `sub ${j}` })) : [];
    ags.push(Demo.makeAgent({
      address: `t${k + 1}`, program: progs[k % progs.length], space: `spc_${sp + 1}`, spaceName: ["herdr-app", "infra", "api-gateway"][sp],
      tab: `tab_${sp}_${k >> 3}`, tabIndex: k >> 3, tabName: `t${k >> 3}`, plan: plans[k % plans.length], start: (k * 137) % 1500, titleIdx: k,
      from: t0 + Math.floor(Math.min(k, 29) / 6) * DAY, subs,
    }));
  }
  const cast = Demo.makeCast(ags, { focus: "t3" });
  const world = W.createWorld({ nowMs: t0, seed: 7 });
  Demo.runCast(world, cast, t0 + SEC);
  for (let d = 1; d <= 5; d++) {
    Demo.advanceCast(cast, (t0 + d * DAY - world.state.herd.lastMs) / SEC);
    W.tick(world, Demo.castSnapshot(cast, t0 + d * DAY));
  }
  Demo._internal.clearZones(world, 8, { kills: 4 });
  const classes = ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"];
  liveHeroes(world).map((p) => p[0]).filter((h) => h.id > 0)
    .forEach((h, i) => Demo._internal.grow(world, h, { L: 95 - (i % 10) * 3, cls: classes[i % classes.length], rar: i % 3 === 0 ? 4 : 3, pol: 6, keepsake: i < 9 ? i : -1 }));
  addGold(world.state, 9e7);
  addSnippets(world.state, 40000);
  if (boss) {
    Demo.runCast(world, cast, nowMs - 30 * SEC);
    world.rt.demo = { cast };
    assert.equal(W.command(world, "challenge", { kind: "boss", idx: 7 }, nowMs - 30 * SEC).ok, true, "the stress world's boss fight starts");
  }
  Demo.runCast(world, cast, nowMs);
  world.rt.demo = { cast };
  return { world, snapshot: Demo.castSnapshot(cast, nowMs) };
}

/** Every status cue the VM asks for is drawn (the ladder never hides status). */
function statusKept(mod, vm, where) {
  for (const h of vm.heroes) {
    if ((vm.height ?? 200) >= 100) assert.ok(mod.node(h.key), `${where}: hero ${h.key}`);
    if (h.nameplate) assert.ok(mod.node(`${h.key}/plate`), `${where}: plate ${h.key}`);
    if (h.bubble) assert.ok(mod.node(`${h.key}/bubble`), `${where}: "!" of ${h.key}`);
    if (h.tag?.text) assert.ok(mod.text().includes(h.tag.text), `${where}: tag ${h.tag.text}`);
  }
  for (const c of vm.chests) assert.ok(mod.node(c.key), `${where}: chest ${c.key}`);
  if (vm.overflow) assert.ok(mod.node(vm.overflow.key), `${where}: camp chip`);
}

test("budget: 30 and 60 heroes through main.js on 2800–4000 px stages hold ~400 elements and ~150 animated", async (t) => {
  const FX = await import("../tools/fixtures.mjs");
  const MAIN = new URL("../mods/down-the-stack/main.js", import.meta.url).pathname;
  for (const [n, boss] of [[30, false], [60, false], [60, true]]) {
    M.resetState();
    const mod = await M.mountMod(MAIN, { props: { role: "stage" }, fixture: FX.demoFixture("late"), nowMs: FX.NOW });
    const host = (await mod.import("./host.js")).getHost();
    await M.tickAll(1500);
    const G = {
      Demo: await mod.import("./game/demo.js"), W: await mod.import("./game/world.js"),
      liveHeroes: (await mod.import("./game/agents.js")).liveHeroes, ...(await mod.import("./game/herd.js")),
    };
    const { world, snapshot } = stressWorld(G, FX.NOW, n, { boss });
    M.setFixture(FX.liveFromSnapshot(snapshot));
    host.world = world;
    const live = world.rt.live.size;
    assert.ok(live >= n, `${n} agents → ${live} live heroes (Contractors past the roster)`);
    for (const width of WIDE) {
      mod.size(width, 200);
      let el = 0, an = 0, slots = 0;
      for (let s = 0; s < 3; s++) {
        await M.tickAll(1000);
        mod.render();
        const where = `${n}${boss ? "+boss" : ""} @${width}px tick ${s}`;
        el = Math.max(el, mod.stats.elements);
        an = Math.max(an, animatedIn(mod));
        assert.ok(mod.stats.elements <= 400, `${where}: ${mod.stats.elements} elements`);
        assert.ok(animatedIn(mod) <= 150, `${where}: ${animatedIn(mod)} animated`);
        const vm = host.view("stage", { width, height: 200, nowMs: M.mockNow() });
        slots = vm.heroes.length;
        statusKept(mod, vm, where);
      }
      t.diagnostic(`${n} heroes${boss ? " + boss" : ""} @${width}px: ${slots} slots, max ${el} elements, ${an} animated, render max ${mod.stats.maxRenderMs.toFixed(1)} ms`);
    }
    assert.deepEqual(problems(mod), []);
  }
});

test("budget: most of 60 heroes blocked or holding chests: 30 slots at most, every '!' and chest drawn within budget", async (t) => {
  const G = {
    Demo: await import("../mods/down-the-stack/game/demo.js"), W: await import("../mods/down-the-stack/game/world.js"),
    liveHeroes: (await import("../mods/down-the-stack/game/agents.js")).liveHeroes, ...(await import("../mods/down-the-stack/game/herd.js")),
  };
  const { findHero } = await import("../mods/down-the-stack/game/combat.js");
  const { MAX_SLOTS } = (await import("../mods/down-the-stack/game/view/stage.js"))._internal;
  const { world: w } = stressWorld(G, NOW, 60);
  // a quarter blocked, half holding two chests each (resting or still questing), a quarter free
  let i = 0;
  const blocked = new Set();
  for (const [id, live] of w.rt.live) {
    const k = i++ % 4;
    if (k === 0) { live.state = "waiting"; live.bubbleShown = true; live.blockedSince = w.rt.tick - 300; blocked.add(id); } else if (k < 3) {
      findHero(w, id).pend = [{ min: 30, fmin: 0, title: "Bump deps", at: NOW - 60000, sealFactor: 1 }, { min: 12, fmin: 0, title: "Fix it", at: NOW - 30000, sealFactor: 1 }];
      if (k === 1) live.state = "resting";
    }
  }
  w.rt.version++;
  assert.equal(MAX_SLOTS, 30);
  for (const width of [1600, ...WIDE]) {
    for (const height of [200, 120, 64]) {
      const vm = stageView(w, { width, height, nowMs: NOW });
      const where = `@${width}×${height}`;
      assert.ok(vm.heroes.length <= MAX_SLOTS, `${where}: ${vm.heroes.length} slots`);
      for (const h of vm.heroes) assert.ok(h.slot.w >= 90 - 0.01, `${where}: a ${h.slot.w} px slot`);
      // blocked heroes fold last: with 15 of them every one keeps its slot from 1600 px up
      for (const id of blocked) assert.ok(vm.heroes.some((h) => h.heroId === id), `${where}: blocked hero ${id} folded`);
      assert.equal(vm.heroes.length + vm.overflow.count, w.rt.live.size);
      const { mod, stage } = await mountStage(vm, { width, height });
      assert.deepEqual(problems(mod), [], where);
      assert.ok(mod.stats.elements <= 400, `${where}: ${mod.stats.elements} elements`);
      assert.ok(animatedIn(mod) <= 150, `${where}: ${animatedIn(mod)} animated`);
      statusKept(mod, vm, where);
      if (height === 200) t.diagnostic(`${where}: ${vm.heroes.length} slots (${vm.heroes[0].slot.w} px), ${vm.overflow.count} at camp, level ${stage.ui.detail?.level}, ${mod.stats.elements} elements, ${animatedIn(mod)} animated`);
    }
  }
  // 30 slots at 4000 px: the squeeze stops at the slot cap, not at 90 px
  const vm = stageView(w, { width: 4000, height: 200, nowMs: NOW });
  assert.equal(vm.heroes.length, MAX_SLOTS);
  assert.ok(vm.heroes[0].slot.w > 120);
  // 60 heroes on 6000 px: 100 px each is under SLOT_MIN, so this folds by width (the cap's own
  // guard is the next test's, with 31-40 heroes that would all fit)
  const vw = stageView(w, { width: 6000, height: 200, nowMs: NOW });
  assert.equal(vw.heroes.length, MAX_SLOTS);
  assert.equal(vw.overflow.count, w.rt.live.size - MAX_SLOTS);
  assert.ok(vw.overflow.x + vw.overflow.w <= 6000.5);
});

/** A lane mob's drawn box (ui/stage.js mob(): px × 1.25 elite × growScale), widened by its pacing swing. */
function mobReach(m) {
  const size = Math.round(m.px * (m.elite ? 1.25 : 1) * (m.growScale || 1));
  const swing = m.pacing ? m.paceAmp : 0;
  return [m.x - size / 2 - swing, m.x + size / 2 + swing];
}

/** The mob's body and swing stay inside its own hero's slot. */
function assertInSlot(m, h, where) {
  const [lo, hi] = mobReach(m);
  assert.ok(lo >= h.slot.x - 0.01 && hi <= h.slot.x + h.slot.w + 0.01,
    `${where}: ${m.key} (${m.px} px${m.elite ? " elite" : ""} × ${m.growScale}${m.pacing ? `, pacing ±${m.paceAmp}` : ""}) spans ${lo.toFixed(1)}..${hi.toFixed(1)}, outside its slot ${h.slot.x}..${h.slot.x + h.slot.w}`);
}

test("layout: every lane mob names its hero (MobVM.heroId) and stays inside that hero's slot, body and pacing swing, at every width", async () => {
  const G = {
    Demo: await import("../mods/down-the-stack/game/demo.js"), W: await import("../mods/down-the-stack/game/world.js"),
    liveHeroes: (await import("../mods/down-the-stack/game/agents.js")).liveHeroes, ...(await import("../mods/down-the-stack/game/herd.js")),
  };
  const { findHero } = await import("../mods/down-the-stack/game/combat.js");
  const worlds = DEMO_KINDS.map((k) => [k, world(k)]);
  // a stressed herd: chests (the hero steps right), large and elite mobs at the back of the lane
  const { world: sw } = stressWorld(G, NOW, 30);
  let i = 0;
  for (const [id, live] of sw.rt.live) {
    if (i % 3 === 0) findHero(sw, id).pend = [{ min: 30, fmin: 0, title: "Bump deps", at: NOW - 60000, sealFactor: 1 }];
    for (const m of live.lane || []) if (i % 2) m.elite = true;
    i++;
  }
  sw.rt.version++;
  worlds.push(["stress", sw]);
  let checked = 0;
  for (const [kind, w] of worlds) {
    for (const width of [360, 960, 1600, 2400, 2700, 3600, 4500]) {
      const vm = stageView(w, { width, height: 200, nowMs: NOW });
      for (const m of vm.mobs) {
        const where = `${kind} @${width}`;
        if (m.heroId == null) {
          // only a boss fight's adds stand outside any slot (in the arena)
          assert.ok(vm.boss && m.x >= vm.boss.arena.x && m.x <= vm.boss.arena.x + vm.boss.arena.w, `${where}: ${m.key} names no hero`);
          continue;
        }
        const h = vm.heroes.find((x) => x.heroId === m.heroId);
        assert.ok(h, `${where}: ${m.key} names hero ${m.heroId}, not on stage`);
        assertInSlot(m, h, where);
        checked++;
      }
    }
  }
  assert.ok(checked > 300, `checked ${checked}`);
});

test("layout: in a squeezed slot a working hero's chest stays clear of its body, and the front mob of the hero", async () => {
  const G = {
    Demo: await import("../mods/down-the-stack/game/demo.js"), W: await import("../mods/down-the-stack/game/world.js"),
    liveHeroes: (await import("../mods/down-the-stack/game/agents.js")).liveHeroes, ...(await import("../mods/down-the-stack/game/herd.js")),
  };
  const { findHero } = await import("../mods/down-the-stack/game/combat.js");
  const { world: w } = stressWorld(G, NOW, 30);
  let i = 0;
  for (const [id, live] of w.rt.live) {
    findHero(w, id).pend = [{ min: 30, fmin: 0, title: "Bump deps", at: NOW - 60000, sealFactor: 1 }];
    if (i++ % 2) { live.state = "waiting"; live.bubbleShown = true; live.blockedSince = w.rt.tick - 300; }
    live.forklings = [];
  }
  w.rt.version++;
  let checked = 0;
  let mobsChecked = 0;
  for (const width of [2700, 3600, 4500, 6000]) {
    const vm = stageView(w, { width, height: 200, nowMs: NOW });
    for (const h of vm.heroes) {
      if (h.state !== "questing" && h.state !== "waiting") continue;
      const c = vm.chests.find((x) => x.heroId === h.heroId);
      if (!c) continue;
      const where = `@${width} hero ${h.heroId} in a ${h.slot.w} px slot`;
      const body = [h.x - 20 * h.scale, h.x + 20 * h.scale];
      assert.ok(c.x - 14 >= h.slot.x - 0.5, `${where}: chest inside the slot`);
      assert.ok(c.x + 14 <= body[0] + 4 + 0.01, `${where}: chest ${c.x - 14}..${c.x + 14} under the body ${body[0]}..${body[1]}`);
      // each mob names the hero whose lane it stands in (MobVM.heroId): judged against its own
      // slot, a mob pushed into a neighbouring slot cannot pass as that slot's
      const own = vm.mobs.filter((m) => m.heroId === h.heroId);
      const front = own.find((m) => m.lane === 0);
      // (a mob that grows, D§7 traits, may still reach in: its base size at the slot's scale clears)
      if (front) assert.ok(front.x - (front.px * h.scale) / 2 >= body[1] - 0.01, `${where}: front mob at ${front.x} (${front.px} px × ${front.growScale}, ${front.size}) over the body ..${body[1]} (hero at ${h.x}, scale ${h.scale}, slot ${h.slot.x})`);
      // the hero stepping right never pushes a mob of its lanes out of its slot: every one of its
      // mobs keeps its whole drawn body, and its pacing swing, inside the slot (the true bound)
      for (const m of own) assertInSlot(m, h, where);
      mobsChecked += own.length;
      checked++;
    }
  }
  assert.ok(checked >= 40, `checked ${checked}`);
  assert.ok(mobsChecked >= 60, `${mobsChecked} mobs checked against their own slots`);
});

test("budget: 31-40 heroes, all protected, past 4650 px (where 31+ slots of 150 px fit): the 30-slot cap holds, within budget", async (t) => {
  const G = {
    Demo: await import("../mods/down-the-stack/game/demo.js"), W: await import("../mods/down-the-stack/game/world.js"),
    liveHeroes: (await import("../mods/down-the-stack/game/agents.js")).liveHeroes, ...(await import("../mods/down-the-stack/game/herd.js")),
  };
  const { findHero } = await import("../mods/down-the-stack/game/combat.js");
  const { MAX_SLOTS, SLOT_MIN } = (await import("../mods/down-the-stack/game/view/stage.js"))._internal;
  for (const n of [31, 35, 40]) {
    const { world: w } = stressWorld(G, NOW, n);
    // every hero blocked with a chest waiting: all protected, nothing folds for its status
    for (const [id, live] of w.rt.live) {
      live.state = "waiting"; live.bubbleShown = true; live.blockedSince = w.rt.tick - 300;
      findHero(w, id).pend = [{ min: 30, fmin: 0, title: "Bump deps", at: NOW - 60000, sealFactor: 1 }];
    }
    w.rt.version++;
    for (const width of new Set([Math.ceil((n * SLOT_MIN) / 100) * 100, 6000])) {
      const where = `${n} heroes @${width}`;
      assert.ok(width / w.rt.live.size >= SLOT_MIN, `${where}: every hero would fit by width alone`);
      const vm = stageView(w, { width, height: 200, nowMs: NOW });
      assert.equal(vm.heroes.length, MAX_SLOTS, `${where}: ${vm.heroes.length} slots`);
      assert.equal(vm.overflow.count, w.rt.live.size - MAX_SLOTS, `${where}: the rest at camp`);
      const { mod, stage } = await mountStage(vm, { width, height: 200 });
      assert.deepEqual(problems(mod), [], where);
      assert.ok(mod.stats.elements <= 400, `${where}: ${mod.stats.elements} elements`);
      assert.ok(animatedIn(mod) <= 150, `${where}: ${animatedIn(mod)} animated`);
      statusKept(mod, vm, where);
      t.diagnostic(`${where}: ${vm.heroes.length} slots, ${vm.overflow.count} at camp, level ${stage.ui.detail?.level}, ${mod.stats.elements} elements, ${animatedIn(mod)} animated`);
    }
  }
});

test("budget: every room pinned (30 map pins) on a swamped strip stays within 400 elements; the pins go with the bare rooms' stats", async (t) => {
  const G = {
    Demo: await import("../mods/down-the-stack/game/demo.js"), W: await import("../mods/down-the-stack/game/world.js"),
    liveHeroes: (await import("../mods/down-the-stack/game/agents.js")).liveHeroes, ...(await import("../mods/down-the-stack/game/herd.js")),
  };
  const { findHero } = await import("../mods/down-the-stack/game/combat.js");
  const pend = () => [{ min: 30, fmin: 0, title: "Bump deps", at: NOW - 60000, sealFactor: 1 }];
  const forks = (id) => [0, 1, 2].map((j) => ({ address: `pin${id}s${j}`, status: j === 0 ? "blocked" : "working", title: `sub ${j}`, since: 0 }));
  for (const n of [30, 40]) {
    for (const withForks of [false, true]) {
      const { world: w } = stressWorld(G, NOW, n);
      for (const [id, live] of w.rt.live) {
        live.state = "waiting"; live.bubbleShown = true; live.blockedSince = w.rt.tick - 300;
        if (withForks) live.forklings = forks(id);
        const hero = findHero(w, id);
        hero.pend = pend();
        if (id > 0) hero.pinMap = live.mapId; // each room's header clicked: every room pinned
      }
      w.rt.version++;
      for (const width of [3200, 4650]) {
        const where = `${n} heroes${withForks ? " + Forklings" : ""} @${width}`;
        const vm = stageView(w, { width, height: 200, nowMs: NOW });
        assert.ok(vm.rooms.filter((r) => r.pin && r.pin.pinned).length >= 25, `${where}: the rooms are pinned`);
        const { mod, stage } = await mountStage(vm, { width, height: 200 });
        assert.deepEqual(problems(mod), [], where);
        assert.ok(mod.stats.elements <= 400, `${where}: ${mod.stats.elements} elements`);
        const level = stage.ui.detail?.level ?? 0;
        const pins = vm.rooms.filter((r) => mod.node(`${r.key}/pin`)).length;
        if (level >= 10) assert.equal(pins, 0, `${where}: bare rooms (level ${level}) draw no pins`);
        t.diagnostic(`${where}: level ${level}, ${mod.stats.elements} elements, ${pins} pins drawn`);
      }
    }
  }
  // a calmer strip keeps its pins
  const w = fresh("mid");
  for (const [id, live] of w.rt.live) if (id > 0) findHero(w, id).pinMap = live.mapId;
  w.rt.version++;
  const vm = stageView(w, { width: 1600, height: 200, nowMs: NOW });
  const { mod, stage } = await mountStage(vm, { width: 1600, height: 200 });
  assert.ok((stage.ui.detail?.level ?? 0) < 10);
  const pinned = vm.rooms.filter((r) => r.pin && r.pin.pinned);
  assert.ok(pinned.length >= 2);
  for (const r of pinned) assert.ok(mod.node(`${r.key}/pin`), `${r.key}: its pin`);
});

test("budget: a long day's herd (every slot holding status at once) holds ~400 elements and ~150 animated from 360 to 4000 px, every '!' and chest drawn", async (t) => {
  const G = {
    Demo: await import("../mods/down-the-stack/game/demo.js"), W: await import("../mods/down-the-stack/game/world.js"),
    liveHeroes: (await import("../mods/down-the-stack/game/agents.js")).liveHeroes, ...(await import("../mods/down-the-stack/game/herd.js")),
  };
  const { findHero } = await import("../mods/down-the-stack/game/combat.js");
  const pend = () => [{ min: 30, fmin: 0, title: "Bump deps", at: NOW - 60000, sealFactor: 1 }, { min: 12, fmin: 0, title: "Fix it", at: NOW - 30000, sealFactor: 1 }];
  const forks = (id, blocked) => [0, 1, 2].map((j) => ({ address: `day${id}s${j}`, status: blocked && j === 0 ? "blocked" : "working", title: `sub ${j}`, since: 0 }));
  // chests pile up over a day left running (D§13 as built: 121 pending for 30 heroes after 40,000 s),
  // then lunch: everyone asks for permission; sub-agents wait too; some crash in hard zones
  const RECIPES = {
    lunch: (w, id, live, k) => { live.state = "waiting"; live.bubbleShown = true; live.blockedSince = w.rt.tick - 300; if (k % 2 === 0) findHero(w, id).pend = pend(); },
    "blocked+chests": (w, id, live) => { live.state = "waiting"; live.bubbleShown = true; live.blockedSince = w.rt.tick - 300; findHero(w, id).pend = pend(); },
    "blocked+chests+sub-agents": (w, id, live) => { live.state = "waiting"; live.bubbleShown = true; live.blockedSince = w.rt.tick - 300; findHero(w, id).pend = pend(); live.forklings = forks(id, true); },
    "crashed+chests": (w, id, live) => { live.state = "crashed"; live.crashedUntil = w.rt.tick + 3; findHero(w, id).pend = pend(); },
  };
  const levels = new Set();
  for (const [n, boss] of [[30, false], [60, false], [60, true]]) {
    for (const [name, recipe] of Object.entries(RECIPES)) {
      const { world: w } = stressWorld(G, NOW, n, { boss });
      const fighters = new Set(w.rt.fights.flatMap((f) => f.heroIds ?? []));
      let k = 0;
      for (const [id, live] of w.rt.live) if (!fighters.has(id)) recipe(w, id, live, k++);
      w.rt.version++;
      let worst = { el: 0, an: 0, level: 0 };
      for (const width of [360, 1600, 2400, ...WIDE]) {
        for (const height of [200, 120]) {
          const vm = stageView(w, { width, height, nowMs: NOW });
          const where = `${n}${boss ? "+boss" : ""} ${name} @${width}×${height}`;
          const { mod, stage } = await mountStage(vm, { width, height });
          assert.deepEqual(problems(mod), [], where);
          const an = animatedIn(mod);
          assert.ok(mod.stats.elements <= 400, `${where}: ${mod.stats.elements} elements`);
          assert.ok(an <= 150, `${where}: ${an} animated`);
          statusKept(mod, vm, where);
          // a blocked sub-agent keeps its "!": its Forkling's bubble, or its hero's counter
          for (const h of vm.heroes) {
            if (!h.forklings.some((f) => f.bubble)) continue;
            const c = mod.node(`${h.key}/forks`);
            const text = c ? c.children.filter((x) => x.type === "text").map((x) => x.text).join("") : "";
            assert.ok(c ? text.includes("!") : h.forklings.some((f) => f.bubble && mod.node(f.key)), `${where}: ${h.key} blocked sub-agent`);
          }
          const level = stage.ui.detail?.level ?? 0;
          levels.add(level);
          if (mod.stats.elements > worst.el) worst = { el: mod.stats.elements, an, level, at: `${width}×${height}` };
        }
      }
      t.diagnostic(`${n}${boss ? " + boss" : ""} ${name}: max ${worst.el} elements (${worst.an} animated, level ${worst.level}) at ${worst.at}`);
    }
  }
  // these states need the last levels (merged marks, dim in the room, fork counters)
  for (const k of [15, 16, 17]) assert.ok(levels.has(k), `level ${k} reached (${[...levels].sort((a, b) => a - b)})`);
});

test("clicks: the finder of a loot pillar keeps its own click where the pillar's light covers it", async () => {
  const w = fresh("mid");
  const live = [...w.rt.live.values()].find((l) => l.state === "questing");
  w.rt.fx.push({ key: `fx:${w.rt.tick}:998`, kind: "pillar", heroId: live.heroId, roomId: null, rar: 5, value: 4243, text: "Keepsake", bornTick: w.rt.tick });
  w.rt.version++;
  const vm = stageView(w, { width: 1200, height: 200, nowMs: NOW });
  const p = vm.fx.find((f) => f.kind === "pillar");
  const h = vm.heroes.find((x) => x.heroId === live.heroId);
  assert.ok(p && h && p.sheet);
  const { mod, log } = await mountStage(vm);
  // the click target lies under the hero (painted earlier), the light column over it has no handler
  const order = mod.findAll((n) => n.id === `${p.key}/hit` || n.id === h.key || n.id === p.key).map((n) => n.id);
  assert.deepEqual(order, [`${p.key}/hit`, h.key, p.key], "paint order: hit target, hero, light column");
  assert.equal(mod.fire(p.key).called, 0);
  assert.ok(Math.abs(p.x - 24 - h.x) < 18, "the column's left edge is inside the hero's body (26 px right of its centre)");
  mod.fire(h.key);
  assert.deepEqual(log.commands.at(-1), { name: "markSeen", args: { heroId: h.heroId } });
  mod.fire(`${p.key}/hit`);
  assert.deepEqual(M.calls().openOverlay.at(-1).spec.props, { role: "sheet", heroId: h.heroId, focus: 4243 });
});

test("tooltips: the stage names a terminal's work as the party does (hero, Forkling, chest), never a bare program, shell or prompt title", () => {
  const w = fresh("mid");
  const cast = w.rt.demo.cast.agents;
  const t1 = cast.find((a) => a.address === "t1"); // Claude Code, working, "Fix flaky auth test"
  const id1 = w.rt.bind.get("t1");
  const nowRef = { now: NOW };
  const vm = () => stageView(w, { width: 1600, height: 200, nowMs: nowRef.now });
  const questOf = () => vm().heroes.find((h) => h.heroId === id1).tooltip.split("\n")[2];
  step(w, nowRef);
  assert.match(questOf(), /^Questing \S+ · Fix flaky auth test$/);
  // a task with no telling title and a program-name live title: a pane name the person gave,
  // else no label (the old tooltip printed the task's raw title)
  w.rt.live.get(id1).task.title = "";
  t1.titles = ["✳ claude"];
  t1.tabName = "1";
  step(w, nowRef);
  assert.match(questOf(), /^Questing \S+$/);
  t1.paneName = "auth fixes";
  step(w, nowRef);
  assert.match(questOf(), /^Questing \S+ · auth fixes$/);
  // a Forkling titled after its program is just a "Sub-agent"; a telling title, glyph stripped, names it
  const t5 = cast.find((a) => a.address === "t5");
  t5.subs[0].titles = ["Claude Code"];
  t5.subs[1].titles = ["⏳ Ask about the schema"];
  step(w, nowRef);
  const forks = vm().heroes.find((h) => h.heroId === w.rt.bind.get("t5")).forklings;
  assert.deepEqual(forks.map((f) => f.tooltip).sort(), ["Sub-agent", "Sub-agent: Ask about the schema"]);
  // a chest from an older save that recorded a shell name reads "a task"
  const fd = fresh("first-day");
  const hero = fd.state.heroes.find((h) => h.id === fd.rt.bind.get("t1"));
  hero.pend[0].title = "zsh";
  fd.rt.version++;
  const chest = stageView(fd, { width: 1600, height: 200, nowMs: NOW }).chests.find((c) => c.heroId === hero.id);
  assert.match(chest.tooltip.split("\n")[0], /^Shipped: a task · /);
});

// ---------------------------------------------------------------------------------------------
// round 4b U3: the hires of one tick are one header note
// ---------------------------------------------------------------------------------------------

test("header note: the hires of one tick (the 04:00 game day turn) are one note, 'Hired 6 contractors: Zed, Coda and 4 more', every hire's line in its tooltip, for the time the queue gave them (round 4b U3)", async () => {
  const { makeEmitter } = await import("../mods/down-the-stack/game/world.js");
  const { journal } = await import("../mods/down-the-stack/game/herd.js");
  const w = fresh("mid");
  const ref = { now: w.state.herd.lastMs };
  // the demo's own notes first (and no autopilot buying buildings meanwhile)
  w.state.herd.cfg.autopilot = false;
  for (let k = 0; k < 120 && w.rt.notes.length; k++) step(w, ref);
  assert.equal(w.rt.notes.length, 0);
  const heroes = w.state.heroes.slice(0, 6);
  assert.equal(heroes.length, 6);
  // what agents.promoteContractors does for each hire: a "hired" journal line and a header note
  const hireAll = (list, { queued = 0 } = {}) => {
    const ev = makeEmitter(w, { live: true });
    for (let i = 0; i < queued; i++) ev.note(`Badge: Something ${i}`);
    for (const h of list) {
      const text = `Hired: ${h.name} (was a contractor)`;
      journal(w.state, "hired", h.id, text, h.L, w.rt.nowMs, h.name);
      ev.note(text);
    }
    w.rt.version++;
  };
  hireAll(heroes);
  const first = (n) => n.split(" ")[0];
  const seen = [];
  for (let k = 0; k < 20; k++) {
    const vm = stageView(w, { width: 1600, height: 200 });
    seen.push(vm.headerNote);
    step(w, ref);
  }
  const merged = seen[0];
  assert.ok(merged, "shown at once");
  assert.equal(merged.text, `Hired 6 contractors: ${first(heroes[0].name)}, ${first(heroes[1].name)} and 4 more`);
  assert.equal(merged.tooltip, heroes.map((h) => `Hired: ${h.name} (was a contractor)`).join("\n"));
  assert.equal(merged.heroId, null, "herd-wide");
  assert.deepEqual(merged.short, ["Hired 6 contractors"], "its short form, for a strip with no room for the names (round 4b integrator; a list of forms since round 4c)");
  // one note, the same key and text, while any of its hires' 3 s slots runs (6 × 3 s)
  const shown = seen.filter((n) => n && n.key === merged.key);
  assert.ok(shown.length >= 17 && shown.length <= 18, `${shown.length} ticks`);
  assert.ok(shown.every((n) => n.text === merged.text && n.tooltip === merged.tooltip));
  assert.ok(seen.every((n) => !n || n.key === merged.key), "no single hire note in between");
  // the queue had room for five: the journal still gives all six
  hireAll(heroes, { queued: 1 });
  let vm = null;
  for (let k = 0; k < 6 && !(vm && vm.headerNote && /^Hired/.test(vm.headerNote.text)); k++) { step(w, ref); vm = stageView(w, { width: 1600, height: 200 }); }
  assert.match(vm.headerNote.text, /^Hired 6 contractors: /);
  // one hire alone: its own line, about that hero (the stage puts it over the hero's room)
  for (let k = 0; k < 40 || (w.rt.notes.length && k < 400); k++) step(w, ref);
  hireAll([heroes[2]]);
  const one = stageView(w, { width: 1600, height: 200 }).headerNote;
  assert.equal(one.text, `Hired: ${heroes[2].name} (was a contractor)`);
  assert.equal(one.heroId, heroes[2].id);
  // two and three read whole
  for (let k = 0; k < 40 || (w.rt.notes.length && k < 400); k++) step(w, ref);
  hireAll(heroes.slice(0, 3));
  assert.equal(stageView(w, { width: 1600, height: 200 }).headerNote.text, `Hired 3 contractors: ${first(heroes[0].name)}, ${first(heroes[1].name)} and ${first(heroes[2].name)}`);
});
