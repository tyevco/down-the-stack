// ui/stage.js + ui/termling.js: every sample StageVM (tools/vm-samples/stage.mjs) rendered through
// the strict herdr mock at several widths and zooms, the click wiring, id stability across ticks,
// and the motion rules (calm, stillness, zoom-scaled loops).

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("../tools/mock/index.mjs");
const { View } = await import("gpui-kit");
const { SCENARIOS, makeScenario, scenarios } = await import("../tools/vm-samples/stage.mjs");
const stageMod = await import("../mods/mapledr/ui/stage.js");
const Stage = stageMod.default;
const { renderTermling, renderForkling, shade } = await import("../mods/mapledr/ui/termling.js");

const WIDTHS = [360, 960, 1600, 2400];
const ZOOMS = [1, 2];

/** A fake GameHost per the UI role contract; `ref.vm` is what host.view() returns. */
function fakeHost(ref) {
  const log = { views: [], commands: [] };
  return {
    log, world: null, version: 1, claim: () => true,
    view: (kind, args) => { log.views.push({ kind, args }); return ref.vm; },
    command: (name, args) => { log.commands.push({ name, args }); return { ok: true }; },
  };
}

/** Mount the Stage role in a View (as main.js will), report its size, render. */
async function mountStage(vm, { width = vm?.width ?? 960, height = vm?.height ?? 200, zoom = 1, theme = "graphite" } = {}) {
  M.resetState();
  M.setFixture({ theme, settings: { zoom }, layout: M.readLayout() });
  const ref = { vm };
  const host = fakeHost(ref);
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

const problems = (mod) => [
  ...mod.errors.map((e) => `${e.code}: ${e.message}`),
  ...mod.warnings.filter((w) => ["duplicate-id", "many-elements", "transition-no-id", "loop-replaced", "tooltip-on-image", "frames-children"].includes(w.code)).map((w) => `${w.code}: ${w.message}`),
];
const methodsOf = (node, name) => node.methods.filter((m) => m[0] === name).map((m) => m[1]);
const ids = (mod) => new Set(mod.findAll((n) => n.id != null).map((n) => n.id));

test("every scenario renders cleanly at every width and zoom, under the element budget", async () => {
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
        assert.ok(mod.stats.lastRenderMs < 50, `${where}: render ${mod.stats.lastRenderMs.toFixed(1)} ms`);
      }
    }
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

test("clicks: hero focuses + marks seen, double-click and nameplate open the sheet", async () => {
  const { mod, host } = await mountStage(scenarios.midgame);
  const kip = scenarios.midgame.heroes.find((h) => h.heroId === 1);
  let r = mod.fire(kip.key);
  assert.ok(r.stopped);
  assert.deepEqual(host.log.commands.at(-1), { name: "markSeen", args: { heroId: 1 } });
  assert.deepEqual(M.calls().run.at(-1).name, "agent.focus");
  assert.deepEqual(M.calls().run.at(-1).args, { terminal: kip.address });

  r = mod.fire(kip.key, { click_count: 2 });
  const sheet = M.calls().openOverlay.at(-1).spec;
  assert.deepEqual(sheet, { mod: "mapledr", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 1 } });

  const before = M.calls().openOverlay.length;
  mod.fire(`${kip.key}/plate`);
  assert.equal(M.calls().openOverlay.length, before + 1);
  assert.deepEqual(M.calls().openOverlay.at(-1).spec.props, { role: "sheet", heroId: 1 });
  assert.deepEqual(problems(mod), []);
});

test("clicks: the blocked bubble and a forkling focus their terminals; a chest is claimed", async () => {
  const vm = scenarios.midgame;
  const { mod, host } = await mountStage(vm);
  const rue = vm.heroes.find((h) => h.bubble);
  const n = host.log.commands.length;
  const r = mod.fire(`${rue.key}/bubble`);
  assert.ok(r.stopped, "the bubble must not fall through to the hero");
  assert.deepEqual(M.calls().run.at(-1), { name: "agent.focus", args: { terminal: rue.address }, copy: M.calls().run.at(-1).copy });
  assert.equal(host.log.commands.length, n, "the bubble only focuses");

  const pax = vm.heroes.find((h) => h.forklings.length);
  const fk = pax.forklings[0];
  mod.fire(fk.key);
  assert.deepEqual(M.calls().run.at(-1).args, { terminal: fk.address });
  assert.equal(mod.node(fk.key).methods.find((m) => m[0] === "tooltip")?.[1][0], fk.tooltip);

  const chest = vm.chests[0];
  mod.fire(chest.key);
  assert.deepEqual(host.log.commands.at(-1), { name: "claimChest", args: { heroId: chest.heroId } });
  assert.deepEqual(M.calls().run.at(-1).args, { terminal: chest.address });
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
    const { mod, ref } = await mountStage(vm0);
    const before = ids(mod);
    ref.vm = vm1;
    mod.render();
    const after = ids(mod);
    assert.deepEqual(problems(mod), [], name);
    const compact = (vm0.height ?? 200) < 100; // compact shows no sprites, only plates and chests
    const stable = [
      ...vm1.rooms.map((r) => r.key), ...vm1.chests.map((c) => c.key),
      ...vm1.heroes.filter((h) => h.nameplate).map((h) => `${h.key}/plate`),
      ...(compact ? [] : [...vm1.heroes.map((h) => h.key), ...vm1.mobs.map((m) => m.key), ...(vm1.boss ? [vm1.boss.key] : [])]),
    ];
    for (const k of stable) {
      assert.ok(before.has(k), `${name}: ${k} missing at tick 0`);
      assert.ok(after.has(k), `${name}: ${k} missing at tick 1`);
    }
    // age-0 effects are still there at tick 1 (same id), faded out and moved by (dx, dy)
    for (const f of compact ? [] : vm0.fx.filter((x) => x.age === 0 && x.kind !== "levelup" && x.kind !== "pillar" && x.kind !== "stamp")) {
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
  // bubbles and chests stay
  assert.ok(mod.node(`${vm.heroes.find((h) => h.bubble).key}/bubble`));
  assert.ok(mod.node(vm.chests[0].key));
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
  assert.deepEqual(M.calls().openOverlay.at(-1).spec, { mod: "mapledr", kind: "dialog", width: 760, height: 520, props: { role: "herd" } });
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
      return el.child(fk);
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
  assert.equal(shade("#808080", -0.5), "#404040");
  assert.equal(shade("#000000", 0.5), "#808080");
});

test("the element estimate that picks scenery detail tracks the real count", async () => {
  const { stageDetail } = stageMod;
  for (const name of SCENARIOS) {
    for (const width of WIDTHS) {
      const vm = makeScenario(name, { width });
      if (vm.empty || vm.height < 100) continue;
      const { mod } = await mountStage(vm, { width });
      const d = stageDetail(vm, vm.rooms, vm.heroes, { compact: false, W: width });
      assert.ok(Math.abs(d.estimate - mod.stats.elements) <= 30, `${name} @${width}: estimate ${Math.round(d.estimate)} vs ${mod.stats.elements}`);
    }
  }
  // the crowd needs the lean levels; a dozen heroes at 2400 px keep full detail
  const crowd = scenarios.crowd;
  const dc = stageDetail(crowd, crowd.rooms, crowd.heroes, { compact: false, W: crowd.width });
  assert.equal(dc.groundTiles, false);
  const wide = scenarios["late-wide"];
  const dw = stageDetail(wide, wide.rooms, wide.heroes, { compact: false, W: wide.width });
  assert.deepEqual([dw.groundTiles, dw.farTiles, dw.leanRig], [true, true, false]);
});
