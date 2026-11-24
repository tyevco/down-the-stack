// Demo worlds (game/demo.js): every kind is built by the real engine, is deterministic for a given
// nowMs, cheap enough for check runs (< 300 ms in V8), shows what its name promises, and keeps
// ticking cleanly with demoSnapshot(). Also the scripted-agent helpers the e2e tests rely on.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as W from "../mods/mapledr/game/world.js";
import * as Dm from "../mods/mapledr/game/demo.js";
import { saveSize } from "../mods/mapledr/game/save.js";
import { MAP_BY_ID, BOSSES } from "../mods/mapledr/game/data.js";

const NOW = 1_790_000_000_000;
const SNAP_KEYS = ["nowMs", "tzOffsetMin", "weekday", "windowActive", "focusedTerminal", "agents", "subagents", "tabs", "spaces"];
const AGENT_KEYS = ["address", "status", "seq", "app", "program", "title", "space", "space_name", "tab", "tab_index", "tab_name", "pane", "pane_name", "pinned", "focused"];

const built = new Map();
let warm = false;
function demo(kind) {
  // the first build in a process pays V8's warm-up (parsing, the JIT): time warm builds only
  if (!warm) { warm = true; Dm.demoWorld("first-day", NOW - 86400000); }
  if (!built.has(kind)) {
    const t = performance.now();
    const r = Dm.demoWorld(kind, NOW);
    built.set(kind, Object.assign(r, { ms: performance.now() - t }));
  }
  return built.get(kind);
}
const states = (w) => [...w.rt.live.values()].map((l) => l.state);
const count = (list, x) => list.filter((s) => s === x).length;

describe("every kind", () => {
  for (const kind of Dm.DEMO_KINDS) {
    test(`${kind}: built by the engine, valid snapshot, clean, under budget`, () => {
      const { world, snapshot, ms } = demo(kind);
      assert.ok(ms < 300, `${kind} took ${ms.toFixed(0)} ms`);
      assert.deepEqual(world.rt.errors, []);
      assert.equal(world.rt.nowMs, NOW);
      assert.equal(world.state.herd.lastMs, NOW);
      assert.deepEqual(Object.keys(snapshot).sort(), SNAP_KEYS.slice().sort());
      assert.equal(snapshot.nowMs, NOW);
      for (const a of snapshot.agents) assert.deepEqual(Object.keys(a).sort(), AGENT_KEYS.slice().sort());
      // the bound agents are exactly the snapshot's agents
      assert.deepEqual([...world.rt.bind.keys()].sort(), snapshot.agents.map((a) => a.address).sort());
      const text = W.serialize(world);
      assert.ok(saveSize(text).ok);
      assert.equal(W.serialize(W.loadWorld(text, { nowMs: NOW }).world), text, "round-trips");
    });
  }

  test("deterministic for a given nowMs (and different for another)", () => {
    for (const kind of ["first-day", "mid", "boss", "late"]) {
      const a = Dm.demoWorld(kind, NOW);
      const b = Dm.demoWorld(kind, NOW);
      assert.equal(W.serialize(a.world), W.serialize(b.world), kind);
      assert.deepEqual(a.world.rt.fx, b.world.rt.fx, kind);
      assert.deepEqual(a.snapshot, b.snapshot, kind);
    }
    assert.notEqual(W.serialize(Dm.demoWorld("first-day", NOW + 37000).world), W.serialize(demo("first-day").world));
  });

  test("unknown kinds throw", () => {
    assert.throws(() => Dm.demoWorld("nope", NOW), /unknown demo world/);
  });
});

describe("what each kind shows", () => {
  test("empty: a fresh herd, no agents", () => {
    const { world, snapshot } = demo("empty");
    assert.equal(world.state.heroes.length, 0);
    assert.equal(snapshot.agents.length, 0);
    assert.equal(world.rt.live.size, 0);
  });

  test("first-day: three Interns in Lint Meadows, a party room, chests flowing", () => {
    const { world } = demo("first-day");
    const hs = world.state.heroes;
    assert.equal(hs.length, 3);
    for (const h of hs) assert.ok(h.L >= 3 && h.L < 10 && h.cls === 0, `Lv ${h.L} cls ${h.cls}`);
    for (const l of world.rt.live.values()) assert.equal(MAP_BY_ID[l.mapId].zone, 0);
    assert.ok(world.state.herd.log.some((e) => e[1] === "ship"), "a chest was opened");
    assert.ok(world.rt.rooms.length >= 1 && world.rt.rooms.length <= 3);
  });

  test("mid: six heroes, two spaces, several rooms, mixed states, Forklings, effects in flight", () => {
    const { world } = demo("mid");
    assert.equal(world.state.heroes.length, 6);
    const st = states(world);
    assert.ok(count(st, "questing") >= 3);
    assert.ok(st.includes("waiting") && st.includes("resting") && st.includes("shipped"), st.join());
    assert.equal(new Set([...world.rt.live.values()].map((l) => l.space)).size, 2);
    assert.ok(world.rt.rooms.length >= 3);
    assert.ok(world.rt.fx.length > 0, "effects in flight");
    assert.ok([...world.rt.live.values()].some((l) => l.forklings.length === 2), "Forklings");
    assert.ok(world.state.herd.zone === 2 && world.state.herd.boss[1] === 1);
    assert.ok([...world.rt.live.values()].some((l) => l.bubbleShown), "a blocked bubble");
  });

  test("boss: an active boss fight with parts and a running timer", () => {
    const { world } = demo("boss");
    assert.equal(world.rt.fights.length, 1);
    const f = world.rt.fights[0];
    assert.equal(f.kind, "boss");
    assert.equal(BOSSES[f.bossIdx].id, "octopus_merge");
    assert.ok(f.parts.length > 1, "tentacles");
    assert.ok(f.t >= 20 && f.t < f.timer, `t ${f.t} / ${f.timer}`);
    assert.equal(f.heroIds.length, 3);
    assert.ok(world.state.herd.fight, "mirrored into the save");
  });

  test("late: 14 heroes (overflow), late zones and the Backlog, a rich stash, many badges", () => {
    const { world } = demo("late");
    assert.ok(world.state.heroes.length >= 12);
    assert.equal(world.rt.live.size, world.state.heroes.length);
    assert.equal(world.state.herd.zone, 9);
    assert.ok([...world.rt.live.values()].some((l) => l.mapId === "backlog"), "someone in the Backlog");
    assert.ok([...world.rt.live.values()].some((l) => MAP_BY_ID[l.mapId] && MAP_BY_ID[l.mapId].zone >= 6));
    assert.ok(world.state.herd.stash.length >= 50);
    assert.ok(world.state.herd.badges.length >= 10);
    const st = states(world);
    assert.ok(count(st, "questing") >= 8 && st.includes("waiting") && st.includes("shipped") && st.includes("resting"), st.join());
  });

  test("idle: nobody questing", () => {
    const st = states(demo("idle").world);
    assert.ok(st.length >= 3);
    for (const s of st) assert.ok(s === "resting" || s === "shipped", s);
  });

  test("blocked: most heroes waiting, bubbles up", () => {
    const { world } = demo("blocked");
    const st = states(world);
    assert.ok(count(st, "waiting") >= 3 && count(st, "waiting") > st.length / 2, st.join());
    assert.ok([...world.rt.live.values()].filter((l) => l.state === "waiting").every((l) => l.bubbleShown));
  });

  test("calm: calm mode on, numbers off", () => {
    const { world } = demo("calm");
    assert.equal(world.state.herd.cfg.calm, true);
    assert.equal(world.state.herd.cfg.nums, "off");
  });
});

describe("demoSnapshot", () => {
  test("continues the scripted cast: statuses keep changing, the world keeps ticking", () => {
    const { world } = Dm.demoWorld("mid", NOW);
    const seq0 = Dm.demoSnapshot(world, NOW).agents.map((a) => a.seq);
    let t = NOW;
    for (let i = 0; i < 400; i++) {
      t += 1000;
      const r = W.tick(world, Dm.demoSnapshot(world, t));
      assert.equal(r.ticks, 1);
    }
    const seq1 = Dm.demoSnapshot(world, t).agents.map((a) => a.seq);
    assert.ok(seq1.some((s, i) => s > seq0[i]), "some status changed");
    assert.deepEqual(world.rt.errors, []);
  });

  test("a world without a cast (loaded from a save) gets a snapshot of its bound agents", () => {
    const { world } = demo("blocked");
    const loaded = W.loadWorld(W.serialize(world), { nowMs: NOW }).world;
    const empty = Dm.demoSnapshot(loaded, NOW + 1000);
    assert.equal(empty.agents.length, 0, "nothing bound yet after a load");
    const snap = Dm.demoSnapshot(world, NOW + 1000);
    const w2 = W.loadWorld(W.serialize(world), { nowMs: NOW }).world;
    W.tick(w2, snap);
    delete w2.rt.demo;
    const again = Dm.demoSnapshot(w2, NOW + 2000);
    assert.deepEqual(again.agents.map((a) => a.address).sort(), snap.agents.map((a) => a.address).sort());
  });
});

describe("scripted agents", () => {
  test("plans loop, seq increments on every status change but herdr's seen flip, titles advance per task", () => {
    const a = Dm.makeAgent({ address: "x", plan: Dm.taskPlan(1, { doneSec: 10, idleSec: 5 }) });
    assert.equal(a.status, "working");
    const t0 = Dm.agentInfo(a).title;
    Dm.advanceAgent(a, 60);
    assert.deepEqual([a.status, a.seq], ["done", 2]);
    Dm.advanceAgent(a, 10);
    // done -> idle is herdr's seen flag (model.rs mark_seen), not a new status word: same seq
    assert.deepEqual([a.status, a.seq], ["idle", 2]);
    Dm.advanceAgent(a, 5);
    assert.deepEqual([a.status, a.seq], ["working", 3]);
    assert.notEqual(Dm.agentInfo(a).title, t0);
    assert.equal(Dm.agentUntilChange(a), 60);
  });

  test("runCast never skips a status change and never drops time", () => {
    const w = W.createWorld({ nowMs: NOW, seed: 1 });
    const cast = Dm.makeCast([{ address: "t1", plan: [["working", 7], ["blocked", 3], ["working", 1e9]] }]);
    const seen = [];
    const end = Dm.runCast(w, cast, NOW + 30000, { onTick: (world, snap, res) => seen.push([snap.agents[0].status, res.ticks]) });
    assert.equal(end, NOW + 30000);
    assert.equal(w.state.herd.tick, 30);
    assert.ok(seen.some(([s]) => s === "blocked"));
    assert.ok(seen.every(([, n]) => n >= 1 && n <= 5));
  });

  test("sub-agents and gone terminals", () => {
    const cast = Dm.makeCast([{ address: "p", plan: [["working", 1e9]], subs: [{ address: "c", plan: [["gone", 5], ["working", 10], ["done", 1e9]] }] }]);
    assert.equal(Dm.castSnapshot(cast, NOW).subagents.length, 0);
    Dm.advanceCast(cast, 6);
    assert.deepEqual(Dm.castSnapshot(cast, NOW).subagents.map((s) => [s.address, s.parent, s.status]), [["c", "p", "working"]]);
    Dm.advanceCast(cast, 10);
    assert.equal(Dm.castSnapshot(cast, NOW).subagents[0].status, "idle", "sub-agent 'done' reads as idle");
  });

  test("weekday follows the timezone (1970-01-01 was a Thursday)", () => {
    assert.equal(Dm.weekdayOf(0), 4);
    assert.equal(Dm.weekdayOf(Date.UTC(2026, 10, 24)), 2);
    assert.equal(Dm.weekdayOf(Date.UTC(2026, 10, 24, 1), 120), 1);
  });
});
