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
const Stage = (await import("../mods/mapledr/ui/stage.js")).default;
const { renderStage } = await import("../mods/mapledr/ui/stage.js");
const { stageView } = await import("../mods/mapledr/game/view.js");
const { _resetStageMemo, whyText } = await import("../mods/mapledr/game/view/stage.js");
const { demoWorld, demoSnapshot, DEMO_KINDS } = await import("../mods/mapledr/game/demo.js");
const { tick, command, createWorld } = await import("../mods/mapledr/game/world.js");

const NOW = Date.UTC(2026, 10, 24, 9, 30, 0);
const WIDTHS = [360, 960, 1600, 2400];
const ZOOMS = [1, 2];

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

async function mountStage(vm, { width = vm.width, height = vm.height, zoom = 1 } = {}) {
  M.resetState();
  M.setFixture({ theme: "graphite", settings: { zoom }, layout: M.readLayout() });
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

const problems = (mod) => [
  ...mod.errors.map((e) => `${e.code}: ${e.message}`),
  ...mod.warnings.filter((w) => ["duplicate-id", "many-elements", "transition-no-id", "loop-replaced", "tooltip-on-image", "frames-children"].includes(w.code)).map((w) => `${w.code}: ${w.message}`),
];

test("render: every demo world renders cleanly at every width, zoom and height", async () => {
  for (const kind of DEMO_KINDS) {
    const w = world(kind);
    for (const width of WIDTHS) {
      for (const height of width === 960 ? [200, 120, 64] : [200]) {
        const vm = stageView(w, { width, height, nowMs: NOW });
        for (const zoom of ZOOMS) {
          const { mod } = await mountStage(vm, { zoom });
          const where = `${kind} @${width}×${height} ×${zoom}`;
          assert.deepEqual(problems(mod), [], where);
          assert.equal(mod.tree.id, "stage", where);
          assert.ok(mod.stats.elements <= 400, `${where}: ${mod.stats.elements} elements`);
          assert.ok(mod.stats.lastRenderMs < 50, `${where}: ${mod.stats.lastRenderMs.toFixed(1)} ms`);
        }
      }
    }
  }
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
  const pim = vm.heroes.find((h) => h.state === "waiting");
  mod.fire(pim.key);
  assert.deepEqual(log.commands.at(-1), { name: "markSeen", args: { heroId: pim.heroId } });
  assert.deepEqual(M.calls().run.at(-1).args, { terminal: pim.address });
  mod.fire(`${pim.key}/bubble`);
  assert.deepEqual(M.calls().run.at(-1).args, { terminal: pim.address });
  const moss = vm.heroes.find((h) => h.forklings.length);
  mod.fire(moss.forklings[0].key);
  assert.deepEqual(M.calls().run.at(-1).args, { terminal: moss.forklings[0].address });
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
    const { startFight } = await import("../mods/mapledr/game/boss.js");
    const { BOSSES } = await import("../mods/mapledr/game/data.js");
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
      assert.ok(inside.length >= 3, `${kind}@${width}: ${inside.length} fighters`);
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
      const prot = live.state === "waiting" || live.focused || live.pinned || (hero.pend && hero.pend.length) || w.rt.fights.some((f) => f.heroIds.includes(id));
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
  assert.equal(vm1.heroes.length, vm0.heroes.length, "someone else went to camp");
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

// ---------------------------------------------------------------------------------------------
// (4) Performance (V8; QuickJS is ~20-50x slower, the render budget there is 50 ms)
// ---------------------------------------------------------------------------------------------

test("perf: view and view + render stay fast for the biggest demo world", async () => {
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
  assert.deepEqual(mod.errors.map((e) => e.message), []);
  assert.ok(viewMs / N < 8, `stageView ${(viewMs / N).toFixed(2)} ms`);
  assert.ok(allMs / N < 25, `view + render ${(allMs / N).toFixed(2)} ms`);
});

test("cues: a promotion review in the hero's own slot, a crash, a supervisor", async () => {
  const { startFight } = await import("../mods/mapledr/game/boss.js");
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
