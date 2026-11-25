// ui/stage.js + ui/termling.js: every sample StageVM (tools/vm-samples/stage.mjs) rendered through
// the strict herdr mock at several widths and zooms, the click wiring, id stability across ticks,
// and the motion rules (calm, stillness, zoom-scaled loops).

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("../tools/mock/index.mjs");
const { View } = await import("gpui-kit");
const { SCENARIOS, makeScenario, scenarios } = await import("../tools/vm-samples/stage.mjs");
const stageMod = await import("../mods/down-the-stack/ui/stage.js");
const Stage = stageMod.default;
const { renderTermling, renderForkling, shade, termlingCost } = await import("../mods/down-the-stack/ui/termling.js");
const { _budget: B } = stageMod;

const WIDTHS = [360, 960, 1600, 2400];
const WIDE = [2800, 3200, 3600, 4000];
const ZOOMS = [1, 2];
// Wall-clock bounds: herdr's real budget with PERF=1; under a loaded CI machine only a generous
// bound (a hang or a runaway loop), and the measured numbers always go to the test output.
const PERF = process.env.PERF === "1";
const RENDER_MS = PERF ? 50 : 500;

/** A fake GameHost per the UI role contract; `ref.vm` is what host.view() returns. */
function fakeHost(ref, extra = {}) {
  const log = { views: [], commands: [] };
  return {
    log, world: null, version: 1, claim: () => true,
    view: (kind, args) => { log.views.push({ kind, args }); return ref.vm; },
    command: (name, args) => { log.commands.push({ name, args }); return { ok: true }; },
    ...extra,
  };
}

/** panes() rows for the given terminals (a hero's agent has a pane; a sub-agent usually not). */
const panesFor = (terminals) => terminals.map((t, i) => ({
  pane: `p${i + 1}`, terminal: t, tab: "tab1", title: t, name: null, cwd: null, branch: null, status: "working",
  app: "claude-code", program: M.PROGRAMS?.claude ?? null, focused: false, zoomed: false, movable: true, scroll: null,
}));

/**
 * Mount the Stage role in a View (as main.js will), report its size, render. By default every
 * hero's terminal has a pane (as herdr agents do) and Forklings have none; `panes` overrides.
 */
async function mountStage(vm, { width = vm?.width ?? 960, height = vm?.height ?? 200, zoom = 1, theme = "graphite", panes, host: hostExtra } = {}) {
  M.resetState();
  const terms = panes ?? (vm?.heroes ?? []).map((h) => h.address).filter(Boolean);
  M.setFixture({ theme, settings: { zoom }, layout: M.readLayout(), panes: panesFor(terms) });
  const ref = { vm };
  const host = fakeHost(ref, hostExtra);
  class Wrap extends View {
    init(_p, cx) { this.stage = new Stage(); this.stage.init({ role: "stage" }, cx, host); }
    render(cx) { return this.stage.render(cx); }
  }
  const mod = await M.mountView(Wrap, { props: { role: "stage" } });
  mod.render();
  mod.size(width * zoom, height * zoom);
  mod.render();
  return { mod, host, ref, stage: mod.view.stage };
}

// The mock's "budget" errors (a render over 50 ms, a handler over 500 ms, each timed as the lower
// of wall and CPU time, tools/mock/state.mjs stopwatch()) count only with PERF=1: a loaded machine
// can still stretch a 5 ms V8 render's CPU time past them (the numbers are printed).
const problems = (mod) => [
  ...mod.errors.filter((e) => PERF || e.code !== "budget").map((e) => `${e.code}: ${e.message}`),
  ...mod.warnings.filter((w) => ["duplicate-id", "many-elements", "transition-no-id", "loop-replaced", "tooltip-on-image", "frames-children"].includes(w.code)).map((w) => `${w.code}: ${w.message}`),
];
const methodsOf = (node, name) => node.methods.filter((m) => m[0] === name).map((m) => m[1]);
const ids = (mod) => new Set(mod.findAll((n) => n.id != null).map((n) => n.id));
const ANIM = new Set(["loop", "transition", "frames", "spring"]);
/** Nodes that animate (D§11.9.7 counts them: ~150 per stage render). */
const animated = (mod) => mod.findAll((n) => n.type !== "text" && n.methods.some((m) => ANIM.has(m[0]))).length;
/** The detail level the role's last render held (ui/stage.js detail(); 0 = full detail). */
const levelOf = (stage) => stage.ui?.detail?.level ?? 0;

/** Every status cue the VM asks for is drawn: heroes, plates, "!" bubbles, chests (D§11.9.7 ladder). */
function statusKept(mod, vm, where) {
  const compact = (vm.height ?? 200) < 100;
  for (const h of vm.heroes) {
    if (!compact) assert.ok(mod.node(h.key), `${where}: hero ${h.key}`);
    if (h.nameplate) assert.ok(mod.node(`${h.key}/plate`), `${where}: plate ${h.key}`);
    if (h.bubble) assert.ok(mod.node(`${h.key}/bubble`), `${where}: "!" of ${h.key}`);
  }
  for (const c of vm.chests) assert.ok(mod.node(c.key), `${where}: chest ${c.key}`);
  if (vm.overflow) assert.ok(mod.node(vm.overflow.key), `${where}: camp chip`);
}

test("every scenario renders cleanly at every width and zoom, under the element budget", async (t) => {
  let worst = { ms: 0, at: "" };
  for (const name of SCENARIOS) {
    for (const width of WIDTHS) {
      const vm = makeScenario(name, { width });
      for (const zoom of ZOOMS) {
        const { mod } = await mountStage(vm, { width, zoom });
        const where = `${name} @${width}px ×${zoom}`;
        assert.deepEqual(problems(mod), [], where);
        assert.ok(mod.tree, `${where}: no tree`);
        assert.equal(mod.tree.id, "stage", where);
        assert.ok(mod.stats.elements < 400, `${where}: ${mod.stats.elements} elements`);
        assert.ok(animated(mod) <= 150, `${where}: ${animated(mod)} animated`);
        if (mod.stats.maxRenderMs > worst.ms) worst = { ms: mod.stats.maxRenderMs, at: where };
        assert.ok(mod.stats.maxRenderMs < RENDER_MS, `${where}: render ${mod.stats.maxRenderMs.toFixed(1)} ms`);
      }
    }
  }
  t.diagnostic(`slowest V8 render: ${worst.ms.toFixed(1)} ms (${worst.at}); bound ${RENDER_MS} ms${PERF ? " (PERF=1)" : ""}`);
});

test("budget: every scenario on a 2800–4000 px stage holds ~400 elements and ~150 animated, status kept", async (t) => {
  const seen = [];
  for (const name of SCENARIOS) {
    for (const width of WIDE) {
      const vm = makeScenario(name, { width });
      const { mod, stage } = await mountStage(vm, { width });
      const where = `${name} @${width}px`;
      assert.deepEqual(problems(mod), [], where);
      assert.ok(mod.stats.elements <= 400, `${where}: ${mod.stats.elements} elements`);
      assert.ok(animated(mod) <= 150, `${where}: ${animated(mod)} animated`);
      if (!vm.empty) statusKept(mod, vm, where);
      if (name === "throng" || name === "squeeze") seen.push(`${where}: ${vm.heroes.length} slots, level ${levelOf(stage)}, ${mod.stats.elements} el, ${animated(mod)} animated`);
    }
  }
  for (const line of seen) t.diagnostic(line);
  // the ultrawide crowds really need the ladder: they would be ~2× over at full detail
  for (const name of ["throng", "squeeze"]) {
    const vm = makeScenario(name, { width: 4000 });
    const full = B.sceneCost(vm, vm.rooms, vm.heroes, { W: 4000, H: 200, vm }, B.atLevel(0));
    assert.ok(full.el > 600, `${name}: ${full.el} elements at full detail`);
  }
});

test("twelve heroes on a 2400 px stage stay under 400 elements, also in the light theme", async () => {
  const vm = scenarios["late-wide"];
  assert.equal(vm.heroes.length, 12);
  assert.equal(vm.overflow, null);
  for (const theme of ["graphite", "paper"]) {
    const { mod } = await mountStage(vm, { theme });
    assert.deepEqual(problems(mod), []);
    assert.ok(mod.stats.elements < 400, `${mod.stats.elements} elements`);
  }
});

test("the root reports its logical size to host.view (window px ÷ zoom)", async () => {
  const vm = scenarios.midgame;
  const { mod, host } = await mountStage(vm, { width: 1600, height: 200, zoom: 2 });
  const last = host.log.views[host.log.views.length - 1];
  assert.equal(last.kind, "stage");
  assert.equal(last.args.width, 1600);
  assert.equal(last.args.height, 200);
  assert.equal(typeof last.args.nowMs, "number");
  // the same size again does not re-render
  const renders = mod.stats.renders;
  mod.size(3200, 400);
  await mod.flush();
  assert.equal(mod.copy.dirty, false);
  assert.equal(mod.stats.renders, renders);
});

const lastRun = () => { const c = M.calls().run.at(-1); return c ? { name: c.name, args: c.args } : null; };

test("clicks: hero shows its pane (pane.focus) + marks seen, double-click and nameplate open the sheet", async () => {
  const { mod, host } = await mountStage(scenarios.midgame);
  const kip = scenarios.midgame.heroes.find((h) => h.heroId === 1);
  let r = mod.fire(kip.key);
  assert.ok(r.stopped);
  assert.deepEqual(host.log.commands.at(-1), { name: "markSeen", args: { heroId: 1 } });
  // herdr's agent.focus shows nothing without an agent block (the layout has none): pane.focus
  assert.deepEqual(lastRun(), { name: "pane.focus", args: { terminal: kip.address } });

  r = mod.fire(kip.key, { click_count: 2 });
  const sheet = M.calls().openOverlay.at(-1).spec;
  assert.deepEqual(sheet, { mod: "down-the-stack", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 1 } });

  const before = M.calls().openOverlay.length;
  mod.fire(`${kip.key}/plate`);
  assert.equal(M.calls().openOverlay.length, before + 1);
  assert.deepEqual(M.calls().openOverlay.at(-1).spec.props, { role: "sheet", heroId: 1 });
  assert.deepEqual(problems(mod), []);
});

test("clicks: the blocked bubble shows its pane, a paneless forkling is peeked, a chest is claimed", async () => {
  const vm = scenarios.midgame;
  const { mod, host } = await mountStage(vm);
  const rue = vm.heroes.find((h) => h.bubble);
  const n = host.log.commands.length;
  const r = mod.fire(`${rue.key}/bubble`);
  assert.ok(r.stopped, "the bubble must not fall through to the hero");
  assert.deepEqual(lastRun(), { name: "pane.focus", args: { terminal: rue.address } });
  assert.equal(host.log.commands.length, n, "the bubble only shows the terminal");

  // a sub-agent has no pane: herdr's peek shows it, as the agents list does (agent.focus would
  // only record a shown agent that no block of this layout draws)
  const pax = vm.heroes.find((h) => h.forklings.length);
  for (const fk of pax.forklings) {
    assert.ok(mod.fire(fk.key).stopped);
    assert.deepEqual(lastRun(), { name: "terminal.peek", args: { terminal: fk.address } });
  }
  const fk = pax.forklings[0];
  assert.equal(mod.node(fk.key).methods.find((m) => m[0] === "tooltip")?.[1][0], fk.tooltip);

  const chest = vm.chests[0];
  mod.fire(chest.key);
  assert.deepEqual(host.log.commands.at(-1), { name: "claimChest", args: { heroId: chest.heroId } });
  assert.deepEqual(lastRun(), { name: "pane.focus", args: { terminal: chest.address } });
  assert.equal(M.calls().run.filter((c) => c.name === "agent.focus").length, 0, "agent.focus never runs");
  assert.deepEqual(problems(mod), []);
});

test("clicks: a hero without a pane (an orphan sub-agent's pseudo-hero) is peeked, body, bubble and chest", async () => {
  const vm = scenarios.midgame;
  const { mod, host } = await mountStage(vm, { panes: [] });
  const kip = vm.heroes.find((h) => h.heroId === 1);
  mod.fire(kip.key);
  assert.deepEqual(lastRun(), { name: "terminal.peek", args: { terminal: kip.address } });
  assert.deepEqual(host.log.commands.at(-1), { name: "markSeen", args: { heroId: 1 } });
  const rue = vm.heroes.find((h) => h.bubble);
  mod.fire(`${rue.key}/bubble`);
  assert.deepEqual(lastRun(), { name: "terminal.peek", args: { terminal: rue.address } });
  const chest = vm.chests[0];
  mod.fire(chest.key);
  assert.deepEqual(lastRun(), { name: "terminal.peek", args: { terminal: chest.address } });
  assert.deepEqual(host.log.commands.at(-1), { name: "claimChest", args: { heroId: chest.heroId } });
});

test("a Duck Chest pops where the duck stood: no SHIPPED ribbon, no claim; it opens next tick", async () => {
  const vm = scenarios["first-day"];
  const duck = vm.chests.find((c) => c.tier === "duck");
  assert.ok(duck && !duck.open);
  const { mod, host, ref } = await mountStage(vm);
  const art = (re) => mod.findAll((n) => typeof n.src === "string" && re.test(n.src));
  assert.ok(mod.node(duck.key));
  assert.equal(art(/fx\/chest-duck\.svg$/).length, 1, "closed duck chest art");
  assert.equal(art(/fx\/ribbon\.svg$/).length, 0, "no SHIPPED ribbon on a Duck Chest (first-day has no Commit Chest)");
  const n = host.log.commands.length;
  const r = mod.fire(duck.key);
  assert.equal(r.called, 0, "a Duck Chest has no click (its item is already given)");
  assert.equal(host.log.commands.length, n);
  ref.vm = makeScenario("first-day", { tick: 1 });
  mod.render();
  assert.equal(art(/fx\/chest-duck-open\.svg$/).length, 1, "lid open at age 1");
  ref.vm = makeScenario("first-day", { tick: 2 });
  mod.render();
  assert.equal(mod.node(duck.key), null, "gone after two ticks");
  assert.deepEqual(problems(mod), []);
});

test("hover text comes from the VM: hero, boss, room header, chest, overflow", async () => {
  const tip = (mod, id) => mod.node(id)?.methods.find((m) => m[0] === "tooltip")?.[1][0];
  let { mod } = await mountStage(scenarios.boss);
  const b = scenarios.boss.boss;
  assert.equal(tip(mod, b.key), b.tooltip);
  const room = scenarios.boss.rooms[0];
  assert.equal(tip(mod, `${room.key}/hdr`), room.tooltip);
  ({ mod } = await mountStage(scenarios.midgame));
  const h = scenarios.midgame.heroes[0];
  assert.equal(tip(mod, h.key), h.tooltip);
  assert.equal(tip(mod, scenarios.midgame.chests[0].key), scenarios.midgame.chests[0].tooltip);
  ({ mod } = await mountStage(scenarios.late));
  assert.ok(scenarios.late.overflow);
  assert.equal(tip(mod, "overflow"), scenarios.late.overflow.tooltip);
});

test("the next tick's VM reuses the same ids (transitions keep their state)", async () => {
  for (const name of SCENARIOS) {
    const vm0 = makeScenario(name);
    const vm1 = makeScenario(name, { tick: 1 });
    const { mod, ref, stage } = await mountStage(vm0);
    const before = ids(mod);
    ref.vm = vm1;
    mod.render();
    const after = ids(mod);
    assert.deepEqual(problems(mod), [], name);
    const compact = (vm0.height ?? 200) < 100; // compact shows no sprites, only plates and chests
    // a crowded stage keeps the front of each lane only (its detail level, held across the ticks)
    const lanes = B.atLevel(levelOf(stage)).mobLanes;
    const stable = [
      ...vm1.rooms.map((r) => r.key), ...vm1.chests.map((c) => c.key),
      ...vm1.heroes.filter((h) => h.nameplate).map((h) => `${h.key}/plate`),
      ...(compact ? [] : [...vm1.heroes.map((h) => h.key), ...vm1.mobs.filter((m) => (m.lane ?? 0) < lanes).map((m) => m.key), ...(vm1.boss ? [vm1.boss.key] : [])]),
    ];
    for (const k of stable) {
      assert.ok(before.has(k), `${name}: ${k} missing at tick 0`);
      assert.ok(after.has(k), `${name}: ${k} missing at tick 1`);
    }
    // age-0 effects are still there at tick 1 (same id), faded out and moved by (dx, dy): those the
    // budget keeps at tick 1 (a crowded stage keeps status floats, then the newest)
    const kept1 = new Set(stageMod.stageDetail(vm1, vm1.rooms, vm1.heroes, { W: vm1.width, H: vm1.height ?? 200, vm: vm1 }).fxKept.map((f) => f.key));
    for (const f of compact ? [] : vm0.fx.filter((x) => x.age === 0 && x.kind !== "levelup" && x.kind !== "pillar" && x.kind !== "stamp")) {
      if (!kept1.has(f.key)) continue;
      if (vm0.calm || (["num", "crit", "heal", "miss", "inv", "abs", "incoming"].includes(f.kind) && vm0.nums === "off")) continue;
      const f1 = vm1.fx.find((x) => x.key === f.key);
      assert.ok(f1 && f1.age === 1, `${name}: ${f.key} should be age 1 next tick`);
      const node = mod.node(f.key);
      assert.ok(node, `${name}: fx ${f.key} not rendered at age 1`);
      assert.equal(methodsOf(node, "opacity").at(-1)[0], 0, `${name}: ${f.key} fades at age 1`);
      assert.ok(methodsOf(node, "transition").some((a) => a[0] === "top"), `${name}: ${f.key} animates top`);
    }
  }
});

test("a hit mob dips to 0.55 opacity; a dying mob fades out (0) and is gone next tick", async () => {
  const vm = scenarios.midgame;
  const { mod, ref } = await mountStage(vm);
  const dying = vm.mobs.find((m) => m.dying);
  assert.ok(dying);
  assert.equal(methodsOf(mod.node(dying.key), "opacity").at(-1)[0], 0);
  const hit = scenarios["first-day"].mobs.find((m) => m.hit && !m.dying);
  ref.vm = scenarios["first-day"];
  mod.render();
  assert.equal(methodsOf(mod.node(hit.key), "opacity").at(-1)[0], 0.55);
  ref.vm = makeScenario("midgame", { tick: 1 });
  mod.render();
  assert.equal(mod.node(dying.key), null);
});

test("calm mode: no loops, no frames, no damage numbers, 60% stage", async () => {
  const vm = scenarios.calm;
  const { mod } = await mountStage(vm);
  assert.equal(mod.findAll((n) => methodsOf(n, "loop").length > 0).length, 0);
  assert.equal(mod.findAll((n) => methodsOf(n, "frames").length > 0).length, 0);
  for (const f of vm.fx) if (["num", "crit", "incoming", "miss", "inv", "pillar", "levelup", "skill"].includes(f.kind)) assert.equal(mod.node(f.key), null, f.key);
  assert.equal(methodsOf(mod.node("stage-scene"), "opacity").at(-1)[0], 0.6);
  // bubbles and chests stay (D§11.15): drawn over the dimmed scene, not inside it, so the reserved
  // blocked cue keeps its white
  const opacityChain = (n) => { let o = 1; for (let p = n; p; p = p.parent) { const op = methodsOf(p, "opacity").at(-1); if (op) o *= op[0]; } return o; };
  const bub = mod.node(`${vm.heroes.find((h) => h.bubble).key}/bubble`);
  assert.ok(bub);
  assert.equal(opacityChain(bub), 1, "the '!' bubble is not dimmed");
  const chest = mod.node(vm.chests[0].key);
  assert.ok(chest);
  assert.equal(opacityChain(chest), 1, "the chest is not dimmed");
  const fkBubbles = mod.findAll((n) => n.src === "mods/down-the-stack/art/fx/bubble.svg" && methodsOf(n, "w").at(-1)?.[0] === 9);
  assert.ok(fkBubbles.length >= 1, "the blocked forkling's small bubble");
  for (const n of fkBubbles) assert.equal(opacityChain(n), 1, "the forkling's bubble is not dimmed");
  // a hero is (60 %)
  assert.equal(opacityChain(mod.node(vm.heroes[0].key)) <= 0.6 + 1e-9, true);
  // outside calm the bubble stays in the scene, under the plates and effects
  const { mod: m2 } = await mountStage(scenarios.midgame);
  let p = m2.node(`${vm.heroes.find((h) => h.bubble).key}/bubble`).parent;
  assert.equal(p.id, "stage-scene");
  p = mod.node(`${vm.heroes.find((h) => h.bubble).key}/bubble`).parent;
  assert.equal(p.id, "stage");
  assert.deepEqual(problems(mod), []);
});

test("clicks: a room header pins the room's heroes (unpins when all are), the boss door challenges", async () => {
  const vm = scenarios.midgame;
  const { mod, host } = await mountStage(vm);
  const room = vm.rooms.find((r) => r.pin && r.pin.heroIds.length > 1);
  assert.ok(room, "a merged room with several heroes");
  const n = host.log.commands.length;
  assert.ok(mod.fire(`${room.key}/hdr`).stopped);
  assert.deepEqual(host.log.commands.slice(n), room.pin.heroIds.map((heroId) => ({ name: "pinMap", args: { heroId, mapId: room.mapId } })));
  const door = vm.rooms.find((r) => r.door && r.challenge);
  assert.ok(door);
  const m = host.log.commands.length;
  assert.ok(mod.fire(`${door.key}/door`).stopped, "the door's click does not also pin");
  assert.deepEqual(host.log.commands.slice(m), [{ name: "challenge", args: { kind: "boss", idx: door.challenge.idx } }]);
  assert.equal(mod.node(`${door.key}/door`).methods.find((x) => x[0] === "tooltip")?.[1][0], door.challenge.tooltip);
  // a room whose heroes are all pinned here unpins them
  const pinned = scenarios.promoted.rooms.find((r) => r.pin && r.pin.mapId === null);
  assert.ok(pinned);
  const { mod: m2, host: h2 } = await mountStage(scenarios.promoted);
  m2.fire(`${pinned.key}/hdr`);
  assert.deepEqual(h2.log.commands.at(-1), { name: "pinMap", args: { heroId: pinned.pin.heroIds.at(-1), mapId: null } });
  // the pinned room's header shows its pin (head and needle) before the title; the others none
  const mark = m2.node(`${pinned.key}/pin`);
  assert.ok(mark, "a pinned room draws its pin");
  assert.equal(mark.parent.id, `${pinned.key}/hdr`);
  assert.equal(mark.parent.children.indexOf(mark), 0, "before the title");
  assert.equal(mark.children.length, 1, "two elements: head and needle");
  for (const r of scenarios.promoted.rooms) if (r !== pinned) assert.equal(m2.node(`${r.key}/pin`), null, r.key);
  assert.equal(mod.findAll((n) => typeof n.id === "string" && n.id.endsWith("/pin")).length, 0, "midgame: nothing pinned");
  // the arena's header is not a pin target
  const { mod: m3, host: h3 } = await mountStage(scenarios.boss);
  const arena = scenarios.boss.rooms.find((r) => r.key.startsWith("room:arena:"));
  assert.equal(m3.fire(`${arena.key}/hdr`).called, 0);
  assert.equal(h3.log.commands.length, 0);
});

test("clicks: the boss retreats only on a second click within 4 ticks (the sheet's confirm pattern)", async () => {
  const vm = scenarios.boss;
  const b = vm.boss;
  assert.ok(b.retreat);
  const { mod, host, ref } = await mountStage(vm);
  assert.ok(mod.fire(b.key).stopped);
  assert.equal(host.log.commands.length, 0, "the first click only arms");
  assert.equal(mod.copy.dirty, true, "the click asks for a render (cx.notify)");
  mod.render();
  const pill = mod.node(`${b.key}/armed`);
  assert.ok(pill, "the armed question shows over the boss");
  assert.equal(mod.text().includes(b.retreat.confirm), true);
  mod.fire(b.key);
  assert.deepEqual(host.log.commands.at(-1), { name: "retreat", args: {} });
  mod.render();
  assert.equal(mod.node(`${b.key}/armed`), null, "disarmed after retreating");
  // an armed click lapses after 4 ticks: the next click arms again
  mod.fire(b.key);
  ref.vm = makeScenario("boss", { tick: 5 });
  mod.render();
  assert.equal(mod.node(`${b.key}/armed`), null);
  const n = host.log.commands.length;
  mod.fire(b.key);
  assert.equal(host.log.commands.length, n, "a stale arm does not retreat");
  // a double-click (GPUI: on_click with click_count 1, then 2) only arms; a later single click retreats
  {
    const { mod: md, host: hd } = await mountStage(vm);
    assert.ok(md.fire(b.key, { click_count: 1 }).stopped);
    md.render();
    assert.ok(md.fire(b.key, { click_count: 2 }).stopped, "the second click of a double-click falls through to nothing");
    assert.equal(hd.log.commands.length, 0, "a double-click on the boss never retreats");
    md.render();
    assert.ok(md.node(`${b.key}/armed`), "still armed: the question shows");
    md.fire(b.key, { click_count: 1 });
    assert.deepEqual(hd.log.commands, [{ name: "retreat", args: {} }]);
  }
  // a won fight (stamp) has no Retreat
  const { mod: m2, host: h2 } = await mountStage(scenarios["boss-won"]);
  assert.equal(scenarios["boss-won"].boss.retreat, null);
  assert.equal(m2.fire(scenarios["boss-won"].boss.key).called, 0);
  assert.equal(h2.log.commands.length, 0);
  assert.deepEqual(problems(mod), []);
});

test("clicks: a loot pillar opens the finder's sheet on that item (through the host's registry)", async () => {
  const vm = scenarios["boss-won"];
  const pillar = vm.fx.find((f) => f.kind === "pillar" && f.sheet);
  assert.ok(pillar);
  let { mod } = await mountStage(vm);
  assert.ok(mod.fire(`${pillar.key}/hit`).stopped);
  assert.deepEqual(M.calls().openOverlay.at(-1).spec.props, { role: "sheet", heroId: pillar.sheet.heroId, focus: pillar.sheet.itemUid });
  assert.equal(mod.fire(pillar.key).called, 0, "the light column itself has no handler");
  const opened = [];
  ({ mod } = await mountStage(vm, { host: { openSheet: (heroId, opts) => { opened.push([heroId, opts]); return "ov1"; } } }));
  const before = M.calls().openOverlay.length;
  mod.fire(`${pillar.key}/hit`);
  assert.deepEqual(opened, [[pillar.sheet.heroId, { focus: pillar.sheet.itemUid }]]);
  assert.equal(M.calls().openOverlay.length, before, "the host opens it (one sheet at a time)");
});

test("a loot pillar on a short stage (120 px) starts below the header band, its rarity name on screen", async () => {
  for (const height of [200, 120]) {
    const vm = makeScenario("boss-won", { height });
    const p = vm.fx.find((f) => f.kind === "pillar");
    const { mod } = await mountStage(vm, { height });
    const ground = height - 200 + 160;
    for (const id of [p.key, `${p.key}/hit`]) {
      const n = mod.node(id);
      const top = methodsOf(n, "top").at(-1)[0];
      const h = methodsOf(n, "h").at(-1)[0];
      assert.ok(top >= 18 && Math.abs(top + h - ground) < 0.01, `${id} @${height}: ${top}..${top + h}, ground ${ground}`);
    }
    const label = methodsOf(mod.node(`${p.key}/t`), "top").at(-1)[0];
    assert.ok(label >= 18 && label + 14 <= ground, `label @${height}: ${label}`);
    if (height === 200) assert.equal(label + 7, 30, "its middle unchanged on a 200 px stage");
  }
});

test("a loot pillar's rarity name sits on a dark plate, painted over the damage numbers", async () => {
  const { contrast } = await import("../mods/down-the-stack/ui/party.js");
  for (const height of [200, 120]) {
    const vm = makeScenario("boss-won", { height });
    const p = vm.fx.find((f) => f.kind === "pillar");
    // a damage number rising through the column, at the label's height
    vm.fx = [...vm.fx, { key: "fx:n:over", kind: "num", x: p.x, y: 20 - (height - 200) + 2, text: "1.2k", color: null, age: 0, dx: 0, dy: -28, size: 11 }];
    const { mod } = await mountStage(vm, { height });
    const label = mod.node(`${p.key}/t`);
    const bg = methodsOf(label, "bg").at(-1)?.[0];
    assert.match(String(bg), /^#0B0A12[0-9A-Fa-f]{2}$/, `@${height}: the stage's dark plate (${bg})`);
    assert.ok(parseInt(bg.slice(7, 9), 16) / 255 >= 0.8, "nearly opaque");
    // the rarity colour on that plate, over the lightest zone sky, reads (it was 1.4–1.6:1 bare)
    const plate = (sky) => { const a = parseInt(bg.slice(7, 9), 16) / 255; return "#" + [1, 3, 5].map((i) => Math.round(parseInt(sky.slice(i, i + 2), 16) * (1 - a) + parseInt(bg.slice(i, i + 2), 16) * a).toString(16).padStart(2, "0")).join(""); };
    const fg = methodsOf(label, "text_color").at(-1)[0];
    for (const sky of ["#f6ca8c", "#dcd7a9", "#dccecb", "#ffffff"]) assert.ok(contrast(fg.slice(0, 7), plate(sky)) >= 4.5, `${fg} on ${plate(sky)}`);
    // painted after the number (later siblings paint on top)
    const kids = mod.node("stage-scene").children.map((c) => c.id);
    assert.ok(kids.indexOf(`${p.key}/t`) > kids.indexOf("fx:n:over"), `@${height}: label over the number`);
    assert.ok(kids.indexOf(p.key) < kids.indexOf("fx:n:over"), "the light column stays under it");
  }
});

test("the level-up column pulses at most once a second and starts below the header band on short stages", async () => {
  for (const height of [200, 120]) {
    const vm = makeScenario("midgame", { height });
    const h = vm.heroes[0];
    vm.fx = [...vm.fx, { key: "fx:lvl:1", kind: "levelup", x: h.x, y: 160 - 48, text: "LEVEL UP", color: null, age: 0 }];
    const { mod } = await mountStage(vm, { height });
    const col = mod.node("fx:lvl:1");
    assert.ok(col, `@${height}`);
    // herdr's loop period is one whole there-and-back (materialize.rs apply_loops): ≥ 1000 ms is ≤ 1 Hz
    for (const [name, args] of col.methods) if (name === "loop") assert.ok(args[3] >= 1000, `period ${args[3]}`);
    assert.ok(col.methods.some((m) => m[0] === "loop"), "it still pulses");
    const top = methodsOf(col, "top").at(-1)[0];
    const hh = methodsOf(col, "h").at(-1)[0];
    assert.ok(top >= 18, `@${height}: column top ${top} below the 18 px header band`);
    assert.ok(Math.abs(top + hh - (height - 200 + 160)) < 0.01, `@${height}: down to the ground`);
    assert.ok(methodsOf(mod.node("fx:lvl:1/t"), "top").at(-1)[0] >= 18, "its label too");
  }
});

/**
 * GPUI's click dispatch over the last render: every element under (x, y) with an on_click, the
 * topmost (last painted) first, until one stops propagation (gpui window.rs dispatch_mouse_event:
 * bubble phase in reverse paint order; herdr-notes gpui-api.md §2.8). Absolute boxes only.
 */
function clickAt(mod, x, y) {
  const hits = [];
  const walk = (n, ox, oy) => {
    if (n.type === "text") return;
    const v = (name) => { const m = methodsOf(n, name).at(-1); return m && typeof m[0] === "number" ? m[0] : null; };
    const abs = n.methods.some((m) => m[0] === "absolute");
    const left = abs ? ox + (v("left") ?? 0) : ox;
    const top = abs ? oy + (v("top") ?? 0) : oy;
    const w = v("w"), h = v("h");
    if (abs && w != null && h != null && (n.handlers.on_click ?? []).length && x >= left && x < left + w && y >= top && y < top + h) hits.push(n);
    for (const c of n.children) walk(c, left, top);
  };
  walk(mod.live, 0, 0);
  const fired = [];
  for (const n of hits.reverse()) {
    const r = mod.fire(n, undefined);
    fired.push(n.id);
    if (r.stopped) break;
  }
  return fired;
}

test("clicks: the finder standing in its loot pillar's light gets its own clicks (the pillar takes the rest)", async () => {
  // throng: the pillar stands where game/view/stage.js puts one, 26 px right of its finder, so
  // its 48 px column covers the finder's right half for both ticks it lives
  const vm = scenarios.throng;
  const pillar = vm.fx.find((f) => f.kind === "pillar" && f.sheet);
  const finder = vm.heroes.find((h) => h.heroId === pillar.sheet.heroId);
  assert.ok(pillar && finder);
  const { mod, host, ref } = await mountStage(vm);
  for (const tick of [0, 1]) {
    ref.vm = makeScenario("throng", { tick });
    mod.render();
    const p = ref.vm.fx.find((f) => f.key === pillar.key);
    assert.ok(p && mod.node(p.key), `tick ${tick}: the pillar is drawn`);
    const body = mod.node(finder.key);
    const [bl, bt, bw, bh] = ["left", "top", "w", "h"].map((k) => methodsOf(body, k).at(-1)[0]);
    const x = p.x - 24 + 4; // inside the column and inside the hero
    assert.ok(x > bl && x < bl + bw, `tick ${tick}: the column covers the hero (${x} in ${bl}..${bl + bw})`);
    const n = host.log.commands.length;
    const fired = clickAt(mod, x, bt + bh / 2);
    assert.equal(fired[0], finder.key, `tick ${tick}: ${fired.join(" → ")}`);
    assert.deepEqual(host.log.commands.slice(n), [{ name: "markSeen", args: { heroId: finder.heroId } }]);
    assert.deepEqual(lastRun(), { name: "pane.focus", args: { terminal: finder.address } });
    // the rest of the column (above the head) opens the sheet on the item
    const before = M.calls().openOverlay.length;
    assert.deepEqual(clickAt(mod, p.x, bt - 30), [`${p.key}/hit`], `tick ${tick}: above the head`);
    assert.equal(M.calls().openOverlay.length, before + 1);
    assert.deepEqual(M.calls().openOverlay.at(-1).spec.props, { role: "sheet", heroId: finder.heroId, focus: p.sheet.itemUid });
  }
  assert.deepEqual(problems(mod), []);
});

test("review end: the Promotion banner (12 confetti) and the Postmortem card in their slots; calm keeps the card", async () => {
  const vm = scenarios.promoted;
  const promo = vm.heroes.find((h) => h.reviewEnd?.kind === "promoted");
  const pm = vm.heroes.find((h) => h.reviewEnd?.kind === "postmortem");
  assert.ok(promo && pm);
  const { mod, ref } = await mountStage(vm);
  assert.deepEqual(problems(mod), []);
  const banner = mod.node(promo.reviewEnd.key);
  assert.ok(banner);
  assert.ok(mod.text().includes("PROMOTED") && mod.text().includes(promo.careerTitle));
  const left = methodsOf(banner, "left").at(-1)[0];
  const w = methodsOf(banner, "w").at(-1)[0];
  assert.ok(left >= promo.slot.x - 0.5 && left + w <= promo.slot.x + promo.slot.w + 0.5, "inside the hero's slot");
  assert.equal(methodsOf(banner, "opacity").at(-1)[0], 1);
  const confetti = mod.findAll((n) => typeof n.id === "string" && n.id.startsWith(`${promo.reviewEnd.key}/c`));
  assert.equal(confetti.length, 12);
  assert.ok(mod.node(pm.reviewEnd.key));
  assert.ok(mod.text().includes(pm.reviewEnd.text));
  // age 3: fading out (same ids, opacity 0); then gone
  ref.vm = makeScenario("promoted", { tick: 2 });
  mod.render();
  assert.equal(methodsOf(mod.node(promo.reviewEnd.key), "opacity").at(-1)[0], 0);
  ref.vm = makeScenario("promoted", { tick: 3 });
  mod.render();
  assert.equal(mod.node(promo.reviewEnd.key), null);
  // calm: no banners (D§11.15), the Postmortem card stays
  const calm = { ...vm, calm: true };
  const { mod: m2 } = await mountStage(calm);
  assert.equal(m2.node(promo.reviewEnd.key), null);
  assert.ok(m2.node(pm.reviewEnd.key));
});

test("header notes stay inside the header band (D§11.15): truncated into a header, or not shown", async () => {
  const note = { key: "note:1", text: "Localhost: Docs Library 8", color: "#FFF4D6" };
  for (const name of ["late", "midgame", "boss", "crowd", "narrow"]) {
    for (const height of [120, 200]) {
      for (const width of [360, 960, 1600]) {
        const vm = { ...makeScenario(name, { width, height }), headerNote: note };
        const { mod } = await mountStage(vm, { width, height });
        const n = mod.node(note.key);
        if (!n) continue;
        const where = `${name} ${width}×${height}`;
        assert.equal(methodsOf(n, "top").at(-1)[0], 1, `${where}: in the band`);
        const l = methodsOf(n, "left").at(-1)[0];
        const w = methodsOf(n, "w").at(-1)[0];
        assert.ok(w >= 60 || w >= String(note.text).length * 6, `${where}: ${w} px`);
        // never over a room title: right of the header's contents, inside one room, or in the
        // Localhost scenery beside the rooms (no title there)
        const room = vm.rooms.find((r) => l >= r.x - 0.5 && l + w <= r.x + r.w + 0.5);
        const scenery = !vm.rooms.some((r) => l < r.x + r.w - 0.5 && l + w > r.x + 0.5) && (!vm.overflow || l + w <= vm.overflow.x + 0.5);
        assert.ok(room || scenery, `${where}: inside one room's header or the scenery`);
        if (room && vm.boss && height < 160) assert.ok(!room.key.startsWith("room:arena:"), `${where}: not over the slim boss HUD`);
      }
    }
  }
  // the regression: 120 px late at 1200 never draws the pill down at y 21 over the heads
  const vm = { ...makeScenario("late", { height: 120 }), headerNote: note };
  const { mod } = await mountStage(vm, { height: 120 });
  const n = mod.node(note.key);
  assert.ok(!n || methodsOf(n, "top").at(-1)[0] === 1);
});

test("a lone hero's header note uses the scenery beside its slot instead of truncating (the first hire)", async () => {
  // the first hire: one hero, its slot at the 320 px clamp in the middle of a 1171 px stage
  const base = makeScenario("first-day", { width: 1171, height: 200 });
  const r = { ...base.rooms[0], x: 425.5, w: 320 };
  const h = { ...base.heroes[0], x: r.x + 160 };
  Object.assign(base, { rooms: [r], heroes: [h], chests: [], mobs: (base.mobs ?? []).slice(0, 1).map((m) => ({ ...m, x: h.x + 56 })), fx: [], signs: [] });
  assert.ok(r.x > 200 && base.width - (r.x + r.w) > 200, "scenery on both sides");
  const note = { key: "note:hire", text: "New hire: Tamsin the Composable", color: "#FFF4D6" };
  const { mod } = await mountStage({ ...base, headerNote: note }, { width: 1171 });
  const n = mod.node(note.key);
  assert.ok(n, "shown");
  const l = methodsOf(n, "left").at(-1)[0];
  const w = methodsOf(n, "w").at(-1)[0];
  assert.ok(w >= note.text.length * 6 + 24 - 0.5, `whole: ${w} px`);
  assert.ok(l + w <= r.x + 0.5 || l >= r.x + r.w - 0.5, "beside the room, not over its title");
  assert.ok(Math.abs(l + w - (r.x - 4)) < 0.5 || Math.abs(l - (r.x + r.w + 4)) < 0.5, "next to the slot");
});

test("stillness: only campfire glows and blocked bubbles move", async () => {
  const vm = scenarios["all-idle"];
  assert.equal(vm.stillness, true);
  const { mod } = await mountStage(vm);
  const looping = mod.findAll((n) => methodsOf(n, "loop").length > 0);
  assert.ok(looping.length > 0, "campfires still flicker");
  for (const n of looping) {
    const [prop] = methodsOf(n, "loop")[0];
    const bubble = typeof n.id === "string" && n.id.endsWith("/bubble");
    assert.ok((prop === "opacity" && n.type === "div" && !n.id) || (bubble && prop === "top"), `unexpected loop on ${n.type}#${n.id} (${prop})`);
  }
  // "nothing else moves" (D§11.3.6): the resting heroes' zzz is static text, not frames()
  assert.ok(vm.heroes.some((h) => h.zzz));
  assert.equal(mod.findAll((n) => methodsOf(n, "frames").length > 0).length, 0);
});

test("budget: many supervisors fold forklings (blocked kept) and old effects to stay under 400", async () => {
  const vm = JSON.parse(JSON.stringify(scenarios.crowd));
  const donor = scenarios.midgame.heroes.find((h) => h.forklings.length);
  vm.heroes.forEach((h, i) => {
    if (i % 3 === 0) {
      h.state = "supervising";
      h.forklings = donor.forklings.map((f, j) => ({ ...f, key: `fk:${i}:${j}`, x: h.x + 14 + j * 10 }));
      h.forklingExtra = 1;
    }
    if (i % 5 === 1) { h.state = "waiting"; h.bubble = { label: "Waiting for you" }; h.crate = true; h.tag = { text: "! 3m", color: "#F2A93B" }; }
  });
  const { mod } = await mountStage(vm);
  assert.deepEqual(problems(mod), []);
  assert.ok(mod.stats.elements < 400, `${mod.stats.elements} elements`);
  const sup = vm.heroes.find((h) => h.forklings.length);
  const blocked = sup.forklings.find((f) => f.bubble);
  assert.ok(mod.node(blocked.key), "the blocked forkling stays");
  for (const f of sup.forklings) if (f !== blocked) assert.equal(mod.node(f.key), null, f.key);
  assert.ok(mod.text().includes(`+${sup.forklingExtra + sup.forklings.length - 1}`));
});

test("a short stage (120 px) keeps the entrance banner under the boss HUD", async () => {
  const vm = makeScenario("boss", { height: 120 });
  const { mod } = await mountStage(vm, { height: 120 });
  assert.deepEqual(problems(mod), []);
  const banner = mod.node(vm.boss.banner.key);
  assert.ok(methodsOf(banner, "top").at(-1)[0] >= 60);
});

test("loop px are multiplied by zoom (herdr does not scale them)", async () => {
  const vm = scenarios.midgame;
  const kip = vm.heroes.find((h) => h.attacking);
  for (const zoom of ZOOMS) {
    const { mod } = await mountStage(vm, { zoom });
    const node = mod.node(kip.key);
    const left = methodsOf(node, "left").at(-1)[0];
    const [prop, from, to] = methodsOf(node, "loop")[0];
    assert.equal(prop, "left");
    assert.ok(Math.abs(from - left * zoom) < 1e-6, `from ${from} vs ${left}×${zoom}`);
    assert.ok(Math.abs(to - (left + 6) * zoom) < 1e-6);
    const pacing = vm.mobs.find((m) => m.pacing && !m.dying);
    const [, pf, pt] = methodsOf(mod.node(pacing.key), "loop")[0];
    assert.ok(Math.abs(Math.abs(pt - pf) - 2 * pacing.paceAmp * zoom) < 1e-6);
  }
});

test("the face blinks (frames) only while questing; other states show their glyph", async () => {
  let { mod } = await mountStage(scenarios["first-day"]);
  const framed = mod.findAll((n) => methodsOf(n, "frames").length > 0).map((n) => methodsOf(n, "frames")[0]);
  // frames args as recorded: [ms, ...list]
  assert.equal(framed.filter((a) => a[0] === 530 && a[1] === ">_" && a[2] === "> ").length, 2, "both questing heroes blink");
  ({ mod } = await mountStage(scenarios.midgame));
  // midgame: the only questing hero lands a crit (">_<", static); nobody else blinks
  assert.equal(mod.findAll((n) => methodsOf(n, "frames").some((a) => a[1] === ">_")).length, 0);
  const text = mod.text();
  for (const face of ["o_o", "-_-", "^_^", ":(", ">_<"]) assert.ok(text.includes(face), face);
});

test("empty states: no VM yet, loading, and no agents (the help-wanted sign)", async () => {
  let { mod } = await mountStage(null, { width: 960, height: 200 });
  assert.deepEqual(problems(mod), []);
  assert.ok(mod.node("stage-sign"));
  ({ mod } = await mountStage(scenarios.empty));
  assert.deepEqual(problems(mod), []);
  assert.ok(mod.text().includes(scenarios.empty.empty.title));
  assert.ok(mod.text().includes(scenarios.empty.empty.text));
  ({ mod } = await mountStage(scenarios.loading));
  assert.ok(mod.text().includes(scenarios.loading.empty.title));
  for (const zoom of ZOOMS) {
    ({ mod } = await mountStage(makeScenario("empty", { width: 360, height: 64 }), { zoom }));
    assert.deepEqual(problems(mod), []);
  }
});

test("compact (64 px): only plates, chests, bubbles and HP lines", async () => {
  const vm = scenarios.compact;
  const { mod } = await mountStage(vm);
  assert.deepEqual(problems(mod), []);
  for (const h of vm.heroes) {
    assert.equal(mod.node(h.key), null, `${h.key} sprite hidden`);
    assert.ok(mod.node(`${h.key}/plate`), `${h.key} plate shown`);
  }
  for (const m of vm.mobs) assert.equal(mod.node(m.key), null);
  assert.ok(mod.node(vm.chests[0].key));
  assert.ok(mod.node(`${vm.heroes.find((h) => h.bubble).key}/bubble`));
});

test("boss: entrance by age (hidden low at 0, risen at 1, HP fills at 2) and the stamp", async () => {
  const base = scenarios.boss;
  const at = (age) => ({ ...base, boss: { ...base.boss, age } });
  const { mod, ref } = await mountStage(at(0));
  const top0 = methodsOf(mod.node(base.boss.key), "top").at(-1)[0];
  assert.equal(methodsOf(mod.node(base.boss.key), "opacity").at(-1)[0], 0);
  ref.vm = at(1); mod.render();
  const top1 = methodsOf(mod.node(base.boss.key), "top").at(-1)[0];
  assert.equal(top0 - top1, 40);
  assert.equal(methodsOf(mod.node(`${base.boss.key}/hpfill`), "w").at(-1)[0], 0);
  ref.vm = at(2); mod.render();
  assert.ok(methodsOf(mod.node(`${base.boss.key}/hpfill`), "w").at(-1)[0] > 0);
  for (const p of base.boss.parts) assert.ok(mod.node(p.key), p.key);
  // won: FIXED stamp down at age ≥ 1, HUD gone
  const won = scenarios["boss-won"];
  ref.vm = won; mod.render();
  const st = mod.node(won.boss.stamp.key);
  assert.ok(st);
  assert.equal(methodsOf(st, "w").at(-1)[0], 80);
  assert.equal(mod.node(`${won.boss.key}/hud`), null);
  assert.deepEqual(problems(mod), []);
});

test("role commands: sheet for the focused agent's hero, herd panel, calm toggle", async () => {
  const vm = scenarios.midgame;
  const { stage, host } = await mountStage(vm);
  M.updateFixture({ focused: { terminal: "t2" } });
  stage.command("sheet");
  assert.deepEqual(M.calls().openOverlay.at(-1).spec.props, { role: "sheet", heroId: 2 });
  stage.command("herd");
  assert.deepEqual(M.calls().openOverlay.at(-1).spec, { mod: "down-the-stack", kind: "dialog", width: 760, height: 520, props: { role: "herd" } });
  stage.command("calm");
  assert.deepEqual(host.log.commands.at(-1), { name: "setting", args: { key: "calm", value: true } });
});

test("termling: tier-5 weapons get the cyan edge; tinted icons are masks; forkling is 3 elements", async () => {
  M.resetState();
  const h = { ...scenarios.late.heroes[0] };
  let edge = null, iconType = null, forkCount = 0;
  class T extends View {
    render() {
      const el = renderTermling({ ...h, weapon: { ...h.weapon, edge: true }, programIcon: { path: "icons/codex.svg", tint: true, color: "#E6E6E6" } }, { zoom: 1 });
      const fk = renderForkling({ key: "fork:x", address: "x", x: 50, y: 160, face: ">_", status: "working" }, h, { zoom: 1 });
      const tiny = renderForkling({ key: "fork:y", address: "y", x: 70, y: 160, face: "o_o", status: "blocked" }, h, { zoom: 1 }, { tiny: true });
      return el.child(fk).child(tiny);
    }
  }
  const mod = await M.mountView(T, {});
  mod.render();
  assert.deepEqual(problems(mod), []);
  edge = mod.findAll((n) => n.type === "svg" && /-edge\.svg$/.test(n.src));
  iconType = mod.findAll((n) => n.src === "icons/codex.svg")[0]?.type;
  const fkNode = mod.node("fork:x");
  const walk = (n) => (n.type === "text" ? 0 : 1) + n.children.reduce((a, c) => a + walk(c), 0);
  forkCount = walk(fkNode);
  assert.equal(edge.length, 1);
  assert.equal(iconType, "svg");
  assert.equal(forkCount, 3);
  const tinyFork = mod.node("fork:y");
  assert.equal(walk(tinyFork), 1, "a tiny Forkling is one element");
  assert.equal(methodsOf(tinyFork, "text_color").at(-1)[0], "#F2A93B", "its blocked face stays amber");
  assert.equal(shade("#808080", -0.5), "#404040");
  assert.equal(shade("#000000", 0.5), "#808080");
});

test("the estimate that picks the detail level counts elements and animated nodes exactly", async () => {
  const { stageDetail } = stageMod;
  const off = [];
  const levels = new Set();
  for (const name of SCENARIOS) {
    // swamped: 2400 / 2600 / 2800+ px reach the last three levels (lean marks, dim in the room, fork counters)
    for (const width of [...WIDTHS, ...WIDE, ...(name === "swamped" ? [2600] : [])]) {
      for (const height of name === "midgame" || name === "squeeze" || name === "swamped" ? [200, 120, 64] : [undefined]) {
        const vm = makeScenario(name, { width, height });
        if (vm.empty) continue;
        const H = vm.height ?? 200;
        const { mod, stage } = await mountStage(vm, { width, height: H });
        const d = stageDetail(vm, vm.rooms, vm.heroes, { compact: H < 100, W: width, H, vm });
        assert.equal(d.level, levelOf(stage), `${name} @${width}×${H}: a fresh render picks the same level`);
        levels.add(d.level);
        // a header note that finds no header with room is not drawn: the estimate may count it
        const slack = vm.headerNote ? 1 : 0;
        const de = d.estimate - mod.stats.elements;
        const da = d.animated - animated(mod);
        if (de < 0 || de > slack || da !== 0) off.push(`${name} @${width}×${H} (level ${d.level}): estimate ${d.estimate}/${d.animated} vs ${mod.stats.elements}/${animated(mod)}`);
      }
    }
  }
  assert.deepEqual(off, []);
  // the samples reach the coarse levels too, the last three (swamped) included
  for (const k of [10, 11, 12, 13, B.levels() - 2, B.levels() - 1, B.levels()]) assert.ok(levels.has(k), `level ${k} is exercised by a sample`);
  // the crowd needs the lean levels; a dozen heroes at 2400 px keep everything but the ground tiles
  const crowd = scenarios.crowd;
  const dc = stageDetail(crowd, crowd.rooms, crowd.heroes, { compact: false, W: crowd.width, vm: crowd });
  assert.equal(dc.groundTiles, false);
  assert.equal(dc.tinyRig, false);
  const wide = scenarios["late-wide"];
  const dw = stageDetail(wide, wide.rooms, wide.heroes, { compact: false, W: wide.width, vm: wide });
  assert.ok(dw.level <= 1, `late-wide: level ${dw.level}`);
  assert.deepEqual([dw.farTiles, dw.leanRig, dw.still], [true, false, false]);
});

test("the last levels merge status into fewer elements and never drop it (swamped: lean marks, dim in the room, fork counters)", async () => {
  const { stageDetail } = stageMod;
  const seen = new Set();
  for (const width of [2400, 2600, 3200]) {
    const vm = makeScenario("swamped", { width });
    const { mod, stage } = await mountStage(vm, { width });
    const L = levelOf(stage);
    const d = B.atLevel(L);
    seen.add(L);
    const where = `swamped @${width} (level ${L})`;
    assert.ok(L >= 15, where);
    assert.deepEqual(problems(mod), [], where);
    assert.ok(mod.stats.elements <= 400 && animated(mod) <= 150, `${where}: ${mod.stats.elements} / ${animated(mod)}`);
    statusKept(mod, vm, where);
    const kidsOf = (n) => n.children.filter((c) => c.type !== "text");
    const textOf = (n) => n.children.filter((c) => c.type === "text").map((c) => c.text).join("");
    for (const h of vm.heroes) {
      // the "!" bubble: one drawn element (no art child), still a click target with the label
      if (h.bubble) {
        const b = mod.node(`${h.key}/bubble`);
        assert.equal(kidsOf(b).length, 0, `${where}: ${h.key} bubble is one element`);
        assert.equal(textOf(b), "!");
        assert.ok((b.handlers.on_click ?? []).length && methodsOf(b, "tooltip").length, `${where}: ${h.key} bubble click + tooltip`);
      }
      // the reboot bar: one element, the done part a cream left border
      if (h.state === "crashed") {
        const r = mod.node(`${h.key}/reboot`);
        assert.equal(kidsOf(r).length, 0);
        assert.equal(methodsOf(r, "border_l").at(-1)[0], Math.round(28 * h.rebootFrac));
      }
    }
    // chests: the SHIPPED ribbon and the "×n" are one label that still reads over the hero in front
    const closed = vm.chests.filter((c) => !c.open && c.tier !== "duck");
    const labels = mod.findAll((n) => n.type !== "text" && textOf(n).startsWith("SHIPPED ×")).map(textOf).sort();
    assert.deepEqual(labels, closed.filter((c) => c.count > 1).map((c) => `SHIPPED ×${c.count}`).sort(), `${where}: labels`);
    const ribbons = mod.findAll((n) => n.src === "mods/down-the-stack/art/fx/ribbon.svg").length;
    assert.equal(ribbons, closed.filter((c) => !(c.count > 1)).length, `${where}: ribbons`);
    assert.equal(mod.findAll((n) => n.type !== "text" && /^×\d/.test(textOf(n))).length, 0, `${where}: no separate count badges`);
    // painted after the heroes (over the one standing in front of its chest)
    const heroKeys = new Set(vm.heroes.map((h) => h.key));
    const order = mod.findAll((n) => heroKeys.has(n.id) || (n.type !== "text" && textOf(n).startsWith("SHIPPED ×"))).map((n) => (heroKeys.has(n.id) ? "hero" : "label"));
    assert.ok(order.lastIndexOf("hero") < order.indexOf("label"), `${where}: labels over the heroes`);
    // dim in the room: a blocked hero alone in its room has no overlay element, the room is darker
    const overlays = mod.findAll((n) => methodsOf(n, "bg").at(-1)?.[0] === "#00000033").length;
    const waiting = vm.heroes.filter((h) => h.state === "waiting" && h.slot);
    const alone = waiting.filter((h) => vm.rooms.some((r) => Math.abs(r.x - h.slot.x) < 0.6 && Math.abs(r.w - h.slot.w) < 0.6));
    assert.ok(alone.length > 0);
    assert.equal(overlays, d.dimInRoom ? waiting.length - alone.length : waiting.length, `${where}: overlays`);
    if (d.dimInRoom) {
      for (const h of alone) {
        const r = vm.rooms.find((x) => Math.abs(x.x - h.slot.x) < 0.6);
        const bg = methodsOf(mod.node(r.key), "bg").at(-1)[0];
        const lum = (c) => [1, 3, 5].reduce((a, i) => a + parseInt(c.slice(i, i + 2), 16), 0);
        assert.ok(/^#[0-9a-f]{6}$/i.test(bg) && lum(bg) < lum(r.skyBands[0]), `${where}: ${r.key} dimmed (${bg} vs ${r.skyBands[0]})`);
      }
    }
    // fork counters: no Forkling bodies, one "+n" per hero with sub-agents, amber "!" when one is blocked
    const withForks = vm.heroes.filter((h) => h.forklings.length);
    assert.ok(withForks.length > 0);
    for (const h of withForks) {
      const fkDrawn = h.forklings.filter((f) => mod.node(f.key)).length;
      const counter = mod.node(`${h.key}/forks`);
      if (!d.forkCounter) { assert.ok(fkDrawn >= 1 && !counter, `${where}: ${h.key} Forklings drawn`); continue; }
      assert.equal(fkDrawn, 0, `${where}: ${h.key} no Forkling bodies`);
      const n = h.forklings.length + h.forklingExtra;
      const blocked = h.forklings.find((f) => f.bubble);
      assert.equal(textOf(counter), blocked ? `+${n} !` : `+${n}`);
      // clear of the hero's 40 px body at its scale (it overlapped it by 2-4 px)
      const cl = methodsOf(counter, "left").at(-1)[0];
      assert.ok(cl >= h.x + 20 * (h.scale ?? 1) || cl + methodsOf(counter, "w").at(-1)[0] >= width - 1.5, `${where}: ${h.key} counter at ${cl}, body to ${h.x + 20 * (h.scale ?? 1)}`);
      assert.equal(methodsOf(counter, "text_color").at(-1)[0], blocked ? "#F2A93B" : methodsOf(counter, "text_color").at(-1)[0]);
      assert.ok(mod.fire(counter).stopped);
      assert.deepEqual(lastRun(), { name: "terminal.peek", args: { terminal: (blocked ?? h.forklings[0]).address } });
    }
    // and the estimate still counts it all exactly
    const de = stageDetail(vm, vm.rooms, vm.heroes, { W: width, H: 200, vm });
    assert.deepEqual([de.level, de.estimate, de.animated], [L, mod.stats.elements, animated(mod)], where);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [15, 16, 17]);
});

test("the detail level holds against a mob or two (hysteresis) and steps back only with room to spare", async () => {
  const { stageDetail } = stageMod;
  const W = 2800;
  const vmA = makeScenario("throng", { width: W });
  const ctx = (vm, ui) => ({ W, H: 200, vm, ui });
  const ui = {};
  const L = stageDetail(vmA, vmA.rooms, vmA.heroes, ctx(vmA, ui)).level;
  assert.ok(L >= 2, `throng @${W}: level ${L}`);
  const finer = (vm) => B.sceneCost(vm, vm.rooms, vm.heroes, ctx(vm), B.atLevel(L - 1));
  const fits = (c, m) => c.el + B.FX_RESERVE.el + m.el <= B.BUDGET && c.an + B.FX_RESERVE.an + m.an <= B.ANIM_BUDGET;
  // drop lane mobs one by one: first the finer level fits, but without MARGIN to spare...
  const mobs = vmA.mobs.slice();
  const less = () => ({ ...vmA, mobs: mobs.slice() });
  while (mobs.length && !fits(finer(less()), { el: 0, an: 0 })) mobs.pop();
  const vmB = less();
  assert.ok(fits(finer(vmB), { el: 0, an: 0 }) && !fits(finer(vmB), B.MARGIN), "a state just inside the finer level");
  assert.equal(stageDetail(vmB, vmB.rooms, vmB.heroes, ctx(vmB)).level, L - 1, "a fresh render would step back");
  assert.equal(stageDetail(vmB, vmB.rooms, vmB.heroes, ctx(vmB, ui)).level, L, "the held level stays");
  // ...then with room to spare it steps back
  while (mobs.length && !fits(finer(less()), B.MARGIN)) mobs.pop();
  const vmC = less();
  assert.equal(stageDetail(vmC, vmC.rooms, vmC.heroes, ctx(vmC, ui)).level, L - 1);
  // another size decides afresh
  assert.equal(stageDetail(vmA, vmA.rooms, vmA.heroes, { ...ctx(vmA, ui), W: W + 1 }).level, L);
  // and the role keeps it across its own renders
  const { mod, ref, stage } = await mountStage(vmA);
  assert.equal(levelOf(stage), L);
  ref.vm = vmB;
  mod.render();
  assert.equal(levelOf(stage), L);
  assert.ok(mod.stats.elements <= 400);
});

test("termling: the rig's cost function matches what it builds, full, lean, small and tiny", async () => {
  M.resetState();
  const heroes = SCENARIOS.flatMap((n) => makeScenario(n).heroes);
  const modes = [{}, { lean: true }, { lean: true, small: true }, { tiny: true }, { blink: true }, { tiny: true, blink: true }];
  const off = [];
  class T extends View {
    render() {
      const root = div().id("root");
      heroes.forEach((h, i) => modes.forEach((o, k) => root.child(renderTermling({ ...h, key: `h${i}.${k}` }, { zoom: 1 }, o))));
      return root;
    }
  }
  const { div } = await import("gpui-kit");
  const mod = await M.mountView(T, {});
  mod.render();
  assert.deepEqual(problems(mod).filter((p) => !p.startsWith("many-elements")), []); // every rig of every sample at once
  const walk = (n) => (n.type === "text" ? [0, 0] : n.children.reduce((a, c) => { const [e, x] = walk(c); return [a[0] + e, a[1] + x]; }, [1, n.methods.some((m) => ANIM.has(m[0])) ? 1 : 0]));
  heroes.forEach((h, i) => modes.forEach((o, k) => {
    const [el, an] = walk(mod.node(`h${i}.${k}`));
    const c = termlingCost(h, o);
    if (c.el !== el || c.an !== an) off.push(`${h.key} ${JSON.stringify(o)}: cost ${c.el}/${c.an}, built ${el}/${an}`);
  }));
  assert.deepEqual(off, []);
  // the tiny rig is one element that still shows the face in its status ink, framed by the hoodie
  const wi = heroes.findIndex((x) => x.state === "waiting");
  const h = heroes[wi];
  const tiny = mod.node(`h${wi}.3`);
  assert.equal(tiny.children.filter((c) => c.type !== "text").length, 0);
  assert.equal(tiny.children.find((c) => c.type === "text")?.text, h.face);
  assert.equal(methodsOf(tiny, "text_color").at(-1)[0], h.colors.faceInk);
  assert.equal(methodsOf(tiny, "border_color").at(-1)[0], h.colors.hoodie);
});
