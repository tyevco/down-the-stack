// End to end: world.tick with the real engine (agents, combat, boss, herd, autopilot, save) driven by
// scripted host snapshots (ARCHITECTURE §3.3) over simulated hours: 1-6 agents cycling working /
// blocked / done / idle with seq increments, focus changes, sub-agents (Forklings), a terminal that
// closes and comes back, a second space, offline gaps and app restarts (save -> load). Checks sane
// progress, no NaN / undefined anywhere in the state, determinism, reload determinism, save budget.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as W from "../mods/down-the-stack/game/world.js";
import * as Dm from "../mods/down-the-stack/game/demo.js";
import { saveSize } from "../mods/down-the-stack/game/save.js";
import { TUNING as T, BOSSES } from "../mods/down-the-stack/game/data.js";
import { within } from "./helpers/perf.mjs";

const T0 = 1_790_000_000_000; // a Tuesday, 2026-09-21 13:46 UTC
const MIN = 60;

/**
 * Six scripted agents with different habits (built fresh for every run, so two runs see the same
 * script): 10-minute tasks seen at once; long tasks with blocked stretches; a parent with two
 * sub-agents; quick 3-minute tasks left "done" until a focus click; another space whose tasks close
 * straight to idle; a terminal that closes for a while and reopens.
 */
function cast(n = 6) {
  const specs = [
    { address: "t1", program: "claude", plan: Dm.taskPlan(10, { doneSec: 40, idleSec: 50 }) },
    { address: "t2", program: "codex", plan: Dm.taskPlan(14, { doneSec: 30, idleSec: 90, blockedSec: 45 }) },
    {
      address: "t3", program: "claude", plan: Dm.taskPlan(20, { doneSec: 20, idleSec: 120 }),
      // sub-agent terminals come and go (each appearance is a "spawned a sub-agent" for the task)
      subs: [
        { address: "s3a", plan: [["gone", 200], ["working", 300], ["idle", 40], ["gone", 780]] },
        { address: "s3b", plan: [["gone", 420], ["working", 420], ["blocked", 60], ["gone", 420]] },
      ],
    },
    { address: "t4", program: "pi", plan: Dm.taskPlan(3, { doneSec: 600, idleSec: 0 }) },
    { address: "t5", program: "opencode", space: "spc_2", spaceName: "api-gateway", plan: [["working", 15 * MIN], ["idle", 100]] },
    { address: "t6", program: "gemini", plan: [["working", 25 * MIN], ["done", 60], ["gone", 8 * MIN], ["idle", 30]] },
  ];
  return Dm.makeCast(specs.slice(0, n).map((s, i) => Object.assign({ start: i * 37, tab: `tab_${1 + (i >> 1)}` }, s)), {
    // the person glances at terminals now and then (focus counts as "seen", D§2.4)
    focusPlan: [[null, 400], ["t4", 5], [null, 300], ["t2", 20], [null, 500], ["t6", 10]],
  });
}

function run(n, seconds, { seed = 11, from = T0, world = null, c = null } = {}) {
  const w = world || W.createWorld({ nowMs: from, seed });
  const cs = c || cast(n);
  const now = Dm.runCast(w, cs, w.state.herd.lastMs + seconds * 1000);
  return { w, cast: cs, now };
}

/** Paths in `root` holding NaN, +-Infinity or undefined (skips "_" scratch keys; Maps and Sets too). */
function badValues(root, { allowInfinity = false } = {}) {
  const out = [];
  const seen = new WeakSet();
  const walk = (v, path) => {
    if (out.length > 20) return;
    if (v === undefined) { out.push(`${path} = undefined`); return; }
    if (typeof v === "number") {
      if (Number.isNaN(v) || (!allowInfinity && !Number.isFinite(v))) out.push(`${path} = ${v}`);
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (v instanceof Map) { for (const [k, x] of v) walk(x, `${path}<${k}>`); return; }
    if (v instanceof Set) { let i = 0; for (const x of v) walk(x, `${path}{${i++}}`); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    for (const k of Object.keys(v)) {
      if (k[0] === "_" || k === "statsCache") continue;
      walk(v[k], `${path}.${k}`);
    }
  };
  walk(root, "");
  return out;
}

function assertClean(w, label = "") {
  assert.deepEqual(w.rt.errors, [], `${label} rt.errors`);
  assert.deepEqual(badValues(w.state), [], `${label} state has bad values`);
  // runtime: Live records, rooms, fights, effects (Infinity is allowed there, e.g. open-ended timers)
  assert.deepEqual(badValues({ live: w.rt.live, rooms: w.rt.rooms, fights: w.rt.fights, fx: w.rt.fx }, { allowInfinity: true }), [], `${label} rt has bad values`);
}

function shipped(w) {
  return w.state.herd.log.filter((e) => e[1] === "ship").length;
}

describe("a working session with six agents (3 simulated hours)", () => {
  // one long run shared by the assertions below (about a second of CPU)
  const samples = [];
  const { w, now } = (() => {
    const w0 = W.createWorld({ nowMs: T0, seed: 11 });
    const c = cast(6);
    let t = T0;
    for (let h = 0; h < 6; h++) {
      t = Dm.runCast(w0, c, t + 30 * MIN * 1000);
      samples.push({ t, L: w0.state.heroes.map((x) => x.L), kills: w0.state.heroes.reduce((s, x) => s + x.st.kills, 0), gold: w0.state.herd.gold });
    }
    return { w: w0, now: t };
  })();
  const heroes = w.state.heroes;

  test("every agent became a hero (sub-agents are Forklings, not heroes)", () => {
    assert.equal(heroes.length, 6);
    assert.deepEqual([...w.rt.bind.keys()].sort(), ["t1", "t2", "t3", "t4", "t5", "t6"].filter((a) => w.rt.bind.has(a)).sort());
    assert.ok(!heroes.some((h) => /^s3/.test(h.addr || "")), "a sub-agent got a hero");
    assert.equal(new Set(heroes.map((h) => h.id)).size, 6);
  });

  test("sane progress: levels, kills, gold, Seals, tasks, chests opened, zones", () => {
    for (const h of heroes) {
      assert.ok(h.L >= 10, `${h.name} is only Lv ${h.L}`);
      assert.ok(h.L <= 40, `${h.name} is Lv ${h.L} after 3 h`);
      assert.ok(h.st.kills > 200, `${h.name} kills ${h.st.kills}`);
      assert.ok(h.st.tasks >= 3, `${h.name} tasks ${h.st.tasks}`);
      assert.ok(h.cls > 0, `${h.name} has no class at Lv ${h.L}`);
    }
    const herd = w.state.herd;
    assert.ok(herd.gold > 0 && herd.seals > 10, `gold ${herd.gold} seals ${herd.seals}`);
    assert.ok(herd.rel >= 1, "no release shipped");
    assert.ok(shipped(w) >= 10, `only ${shipped(w)} chests opened`);
    assert.ok(herd.zone >= 1 && herd.boss[0] === 1, `boss 1 not beaten (zone ${herd.zone})`);
    // progress is monotone and keeps moving every half hour
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i].kills > samples[i - 1].kills);
      assert.ok(samples[i].L.every((L, k) => L >= (samples[i - 1].L[k] || 0)));
    }
  });

  test("classes follow behaviour (D§4.2): sub-agents -> Forkbinder, blocks -> Rubberducker", () => {
    const byAddr = (a) => heroes.find((h) => h.addr === a || w.rt.bind.get(a) === h.id);
    assert.equal(byAddr("t3").cls, 4, "t3 spawns sub-agents: Forkbinder");
    assert.equal(byAddr("t2").cls, 5, "t2 blocks twice an hour or more: Rubberducker");
    assert.equal(byAddr("t4").cls, 2, "t4 runs 3-minute tasks: Hotfixer");
  });

  test("seen chests open; a chest left 'done' waits until focus (D§2.4)", () => {
    // t1 / t2 / t3 go done -> idle: nothing waits longer than one task
    for (const a of ["t1", "t2", "t3", "t5"]) {
      const h = heroes.find((x) => w.rt.bind.get(a) === x.id);
      assert.ok(h.pend.length <= 1, `${a} has ${h.pend.length} chests waiting`);
    }
    // t4 sits "done" between 3-minute tasks; only the focus plan opens its chests
    const t4 = heroes.find((x) => w.rt.bind.get("t4") === x.id);
    assert.ok(t4.st.seals > 0, "t4's chests were opened by focus");
  });

  test("no NaN / undefined anywhere; no engine errors", () => assertClean(w));

  test("the save stays under budget and round-trips byte-identically", () => {
    const text = W.serialize(w);
    assert.ok(saveSize(text).ok, `save ${saveSize(text).bytes} B`);
    assert.ok(text.length < 15 * 1024, `six heroes: ${text.length} B`);
    const { world, warning } = W.loadWorld(text, { nowMs: now });
    assert.equal(warning, null);
    assert.equal(W.serialize(world), text);
  });
});

describe("effects (ARCHITECTURE §3.2 Fx, §5 FxVM kinds)", () => {
  test("every effect has a known kind, a unique key, its tick, and a hero or room; budgets hold", () => {
    const KINDS = new Set(["num", "crit", "heal", "miss", "inv", "abs", "incoming", "poof", "coin", "loot", "levelup", "skill", "coffee", "unblocked", "stamp", "pillar", "ship"]);
    const NUMS = new Set(["num", "crit", "heal", "miss", "inv", "abs", "incoming"]);
    const w = W.createWorld({ nowMs: T0, seed: 13 });
    const seen = new Map();
    const keys = new Set();
    Dm.runCast(w, cast(6), T0 + 25 * MIN * 1000, {
      onTick: (world) => {
        const fresh = world.rt.fx.filter((f) => f.bornTick === world.rt.tick);
        let nums = 0;
        const perHero = new Map();
        for (const f of fresh) {
          assert.ok(KINDS.has(f.kind), `unknown fx kind ${f.kind}`);
          assert.ok(!keys.has(f.key), `duplicate key ${f.key}`);
          keys.add(f.key);
          assert.ok(f.heroId != null || f.roomId != null, `${f.kind} has neither hero nor room`);
          assert.equal(typeof f.text, "string");
          assert.ok(Number.isFinite(f.value), `${f.kind} value ${f.value}`);
          seen.set(f.kind, (seen.get(f.kind) || 0) + 1);
          if (NUMS.has(f.kind)) {
            nums++;
            perHero.set(f.heroId, (perHero.get(f.heroId) || 0) + 1);
          }
        }
        // D§11.7 for the last simulated step (catch-up steps each flush on their own)
        assert.ok(nums <= 12 * 5, `${nums} numbers`);
      },
    });
    for (const k of ["num", "poof", "coin", "levelup", "ship", "incoming"]) assert.ok(seen.get(k) > 0, `no ${k} effect in 25 minutes`);
  });
});

describe("determinism (D§12.3.12)", () => {
  test("two runs of the same script give byte-identical saves and the same effects", () => {
    const a = run(4, 40 * MIN, { seed: 3 });
    const b = run(4, 40 * MIN, { seed: 3 });
    assert.equal(W.serialize(a.w), W.serialize(b.w));
    assert.deepEqual(a.w.rt.fx, b.w.rt.fx);
    assert.equal(a.w.rt.version, b.w.rt.version);
    const c = run(4, 40 * MIN, { seed: 4 });
    assert.notEqual(W.serialize(c.w), W.serialize(a.w), "the seed matters");
  });

  test("a save loaded twice continues identically; the reload keeps every saved number", () => {
    const { w, now } = run(5, 35 * MIN, { seed: 8 });
    const text = W.serialize(w);
    const elapsed = (now - T0) / 1000;
    // the same script, positioned at the save moment, for each copy
    const castAt = () => { const c = cast(5); Dm.advanceCast(c, elapsed); return c; };
    const a = W.loadWorld(text, { nowMs: now }).world;
    const b = W.loadWorld(text, { nowMs: now }).world;
    assert.equal(W.serialize(a), text);
    const ca = castAt();
    const cb = castAt();
    Dm.runCast(a, ca, now + 25 * MIN * 1000);
    Dm.runCast(b, cb, now + 25 * MIN * 1000);
    assert.equal(W.serialize(a), W.serialize(b));
    assertClean(a, "reloaded");
    // the continuous world and the reloaded one agree on the saved progress at the save moment and
    // stay close afterwards (lanes, cooldowns and mob HP are not saved, D§13.1)
    Dm.runCast(w, cast5At(elapsed), now + 25 * MIN * 1000);
    const La = a.state.heroes.map((h) => h.L);
    const Lw = w.state.heroes.map((h) => h.L);
    assert.equal(La.length, Lw.length);
    for (let i = 0; i < La.length; i++) assert.ok(Math.abs(La[i] - Lw[i]) <= 2, `hero ${i}: Lv ${La[i]} vs ${Lw[i]}`);
  });
});

// the continuous world's own cast was advanced by runCast; rebuild an identical one at `elapsed`
function cast5At(elapsed) {
  const c = cast(5);
  Dm.advanceCast(c, elapsed);
  return c;
}

describe("days, nights and restarts", () => {
  test("two days with the app closed overnight: Fresh Eyes, Daily Shift reset, rebinding after a restart", () => {
    const { w, now } = run(3, 90 * MIN, { seed: 21 });
    const ids = w.state.heroes.map((h) => h.id);
    const L1 = w.state.heroes.map((h) => h.L);
    for (const h of w.state.heroes) assert.ok(h.shift.min > 60, `shift minutes ${h.shift.min}`);
    // close the app: save, then the next morning load and reopen with the same terminals (idle)
    const text = W.serialize(w);
    const next = now + 20 * 3600 * 1000;
    const { world } = W.loadWorld(text, { nowMs: next });
    const c = cast(3);
    for (const a of c.agents) { a.plan = [["idle", 60], ...Dm.taskPlan(10)]; a.phase = 0; a.left = 60; a.status = "idle"; a.seq += 5; }
    W.tick(world, Dm.castSnapshot(c, next));
    const fe0 = world.state.heroes.map((h) => h.fe);
    assert.deepEqual(world.state.heroes.map((h) => h.id), ids, "same heroes");
    assert.deepEqual([...world.rt.bind.values()].sort(), ids.slice().sort(), "terminals rebound to their heroes");
    for (const h of world.state.heroes) {
      // a full pool after a night (60 min + 15 per Campfire level)
      assert.ok(h.fe >= 60, `${h.name}: Fresh Eyes ${h.fe} after a night`);
    }
    const end = Dm.runCast(world, c, next + 30 * MIN * 1000);
    world.state.heroes.forEach((h, i) => {
      assert.ok(h.shift.day === world.state.herd.day && h.shift.min < 30, `shift reset: day ${h.shift.day} min ${h.shift.min}`);
      assert.ok(h.fe < fe0[i] - 15, `Fresh Eyes drains while Questing (${fe0[i]} -> ${h.fe})`);
    });
    assert.ok(world.state.heroes.some((h, i) => h.L > L1[i]), "day two progresses");
    assertClean(world, "day two");
    assert.ok(end > next);
  });

  test("a terminal that closes goes off duty and its hero comes back when the seat reopens", () => {
    // t6 works 25 min, is done 1 min, then its terminal is gone for 8 min
    const { w } = run(6, 26 * MIN + 30, { seed: 5 });
    const t6 = w.state.heroes.find((h) => h.addr === "t6");
    assert.ok(t6, "t6 had a hero");
    assert.ok(!w.rt.live.has(t6.id), "off duty while the terminal is gone");
    assert.ok(t6.pend.length >= 1, "its done chest waits (closing is not seen)");
    const c = cast(6);
    Dm.advanceCast(c, 26 * MIN + 30);
    Dm.runCast(w, c, w.state.herd.lastMs + 9 * MIN * 1000);
    assert.ok(w.rt.live.has(t6.id), "the seat's hero is back");
    assert.equal(w.state.heroes.length, 6, "no new hero for a reopened seat");
    assertClean(w);
  });

  test("a boss fight survives an offline gap and a restart (suspended into the save, resumed by work)", () => {
    const { world: w0 } = Dm.demoWorld("boss", T0 + 3600 * 1000);
    assert.equal(w0.rt.fights.length, 1);
    const f0 = w0.rt.fights[0];
    const hp0 = f0.parts.reduce((s, p) => s + Math.max(0, p.hp), 0);
    const t = w0.state.herd.lastMs;
    // the laptop sleeps for 10 minutes: the fight is suspended into herd.fight
    const snap = Dm.demoSnapshot(w0, t + 10 * MIN * 1000);
    W.tick(w0, snap);
    assert.equal(w0.rt.fights.length, 0, "suspended");
    assert.ok(w0.state.herd.fight && w0.state.herd.fight.i === 3, "saved as herd.fight");
    // restart: load the save; the participants work again -> the fight comes back where it was
    const text = W.serialize(w0);
    const { world } = W.loadWorld(text, { nowMs: t + 10 * MIN * 1000 });
    const c = w0.rt.demo.cast;
    Dm.runCast(world, c, world.state.herd.lastMs + 6 * 1000);
    assert.equal(world.rt.fights.length, 1, "resumed");
    const f1 = world.rt.fights[0];
    assert.equal(f1.bossIdx, 3);
    assert.ok(f1.t >= f0.t, "timer kept");
    const hp1 = f1.parts.reduce((s, p) => s + Math.max(0, p.hp), 0);
    assert.ok(hp1 <= hp0 * 1.05, "boss HP kept");
    Dm.runCast(world, c, world.state.herd.lastMs + 240 * 1000);
    assert.equal(world.rt.fights.length, 0, "the fight ended");
    assert.ok(world.state.herd.boss[3] === 1 || Object.keys(world.state.herd.wounds).length > 0, "won, or a Postmortem with Wounds");
    assertClean(world, "after the fight");
  });

  test("retreat ends a paused fight too (Postmortem, Wounds kept)", () => {
    const { world: w } = Dm.demoWorld("boss", T0);
    W.tick(w, Dm.demoSnapshot(w, w.state.herd.lastMs + 5 * MIN * 1000)); // offline: suspended
    assert.ok(w.state.herd.fight);
    const r = W.command(w, "retreat", {}, w.state.herd.lastMs);
    assert.equal(r.ok, true, r.error);
    assert.equal(w.state.herd.fight, null);
    assert.ok(w.state.herd.wounds["3"], "Wounds kept");
    assert.equal(W.command(w, "retreat", {}, w.state.herd.lastMs).ok, false);
  });
});

describe("scale", () => {
  test("twelve agents across two spaces for 20 minutes: crowding, rooms, no errors", () => {
    const specs = [];
    for (let k = 0; k < 12; k++) {
      specs.push({
        address: `t${k + 1}`, program: ["claude", "codex", "pi", "opencode"][k % 4], space: k < 7 ? "spc_1" : "spc_2",
        spaceName: k < 7 ? "herdr-app" : "infra", plan: Dm.taskPlan(4 + (k % 5) * 3, { blockedSec: k % 3 === 0 ? 30 : 0 }), start: k * 23,
      });
    }
    const w = W.createWorld({ nowMs: T0, seed: 2 });
    // six heroes a day (D§3.4): the other six play as unsaved Contractors
    Dm.runCast(w, Dm.makeCast(specs), T0 + 20 * MIN * 1000);
    assert.equal(w.state.heroes.length, 6);
    assert.equal(w.rt.contractors.size, 6);
    assert.equal(w.rt.live.size, 12);
    assert.ok(w.rt.rooms.length >= 2);
    for (const c of w.rt.contractors.values()) assert.ok(c.id < 0 && c.st.kills > 0, "Contractors fight too");
    assertClean(w);
    assert.ok(!W.serialize(w).includes('"Contractor'), "Contractors are never saved");
  });

  test("every demo world keeps ticking cleanly for a minute", () => {
    for (const kind of Dm.DEMO_KINDS) {
      const { world } = Dm.demoWorld(kind, T0);
      let t = world.state.herd.lastMs;
      for (let i = 0; i < 60; i++) {
        t += 1000;
        W.tick(world, Dm.demoSnapshot(world, t));
      }
      assertClean(world, kind);
    }
  });
});

test("sanity: boss table and tuning the test relies on", () => {
  assert.equal(BOSSES[3].id, "octopus_merge");
  assert.equal(T.maxCatchUpTicks, 5);
});

// ---------------------------------------------------------------------------------------------
// Integration fixes found by these runs and tools/pacing-sim.mjs (each pinned by a unit check)
// ---------------------------------------------------------------------------------------------

describe("integration fixes", async () => {
  const { makeWorld, makeEv } = await import("./helpers/engine.mjs");
  const AP = await import("../mods/down-the-stack/game/autopilot.js");
  const Hr = await import("../mods/down-the-stack/game/heroes.js");
  const I = await import("../mods/down-the-stack/game/items.js");
  const F = await import("../mods/down-the-stack/game/formulas.js");
  const Bo = await import("../mods/down-the-stack/game/boss.js");
  const D = await import("../mods/down-the-stack/game/data.js");

  const weapon = (state, cls, ilvl, rar, pol = 0, aff = 3) => ({
    uid: state.herd.nextUid++, base: I.baseIdFor("weapon", F.itemTier(ilvl), D.CLASSES[D.CLASS_IDX[cls]].weapon), ilvl, rar, pol,
    aff: [[0, 50], [1, 50], [2, 50]].slice(0, aff), flags: 0, prop: -1,
  });

  test("autopilot's pre-filter follows stats, not Item Power: an iLvl 90 Release replaces an iLvl 67 +12 Keepsake", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 93 }] });
    const h = w.state.heroes[0];
    const ks = weapon(w.state, "shellmancer", 67, 5, 12);
    ks.prop = D.KEEPSAKES.findIndex((k) => k.slot === "weapon");
    I.equipItem(w.state, h, ks);
    const rel = weapon(w.state, "shellmancer", 90, 3);
    assert.ok(I.itemIP(rel) < 0.8 * I.itemIP(ks), "IP alone would have skipped it");
    assert.ok(AP.gearScale(rel, 6) > 2 * AP.gearScale(ks));
    const r = AP.offerDrop(w, h, rel, makeEv());
    assert.equal(r.heroId, h.id);
    assert.equal(h.eq[0], rel);
  });

  test("map choice is class-neutral: every class in the reference kit fights on its level", () => {
    for (const cls of ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"]) {
      const w = makeWorld({ heroes: [{ cls, L: 9 + 11 * 3, mapId: "1-1" }] }); // Lv 42: zone 4 maps are 34-44
      w.state.herd.zone = 3;
      for (const z of [0, 1, 2]) w.state.herd.boss[z] = 1;
      for (const id of ["4-1", "4-2"]) w.state.herd.quota[id] = 40;
      const h = w.state.heroes[0];
      assert.equal(AP.gearLag(h, Hr.stats(h, { herd: w.state.herd })), 0, cls);
      assert.equal(AP.chooseMap(w, h, w.rt.live.get(h.id)), "4-3", `${cls} (PL ${Hr.stats(h, { herd: w.state.herd }).pl})`);
    }
  });

  test("a lagging weapon does not move the map choice (balance: drops land at iRef; the crash rule steps down)", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 42 }] });
    w.state.herd.zone = 3;
    for (const z of [0, 1, 2]) w.state.herd.boss[z] = 1;
    for (const id of ["4-1", "4-2"]) w.state.herd.quota[id] = 40;
    const h = w.state.heroes[0];
    const live = w.rt.live.get(h.id);
    h.eq[0] = weapon(w.state, "shellmancer", 20, 0);
    assert.equal(AP.gearLag(h, Hr.stats(h, { herd: w.state.herd })), 5);
    assert.equal(AP.chooseMap(w, h, live), "4-3", "mid 43 <= Lv 42 + 1");
    live.crashes = [w.rt.tick];
    assert.equal(AP.chooseMap(w, h, live), "4-2", "after a crash: at most its level");
  });

  test("convergence never pulls a hero to a map far under its level (a lagging mate cannot stall the guild)", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 65, space: "s1" }, { cls: "shellmancer", L: 57, space: "s1" }] });
    w.state.herd.zone = 5;
    for (let z = 0; z < 5; z++) w.state.herd.boss[z] = 1;
    w.state.herd.quota["6-1"] = 40;
    const [a, b] = w.state.heroes;
    assert.equal(AP.chooseMap(w, b, w.rt.live.get(b.id)), "6-1");
    assert.equal(AP.chooseMap(w, a, w.rt.live.get(a.id)), "6-2", "6-1 (mid 57.5) is 7.5 levels under Lv 65");
    a.L = 61; // 6-1 is now 3.5 under: the guild stays together (D§2.8)
    assert.equal(AP.chooseMap(w, a, w.rt.live.get(a.id)), "6-1");
  });

  test("a new hero's Training Stick grows with its hero (iRef = L - 2) until a class weapon replaces it", () => {
    const w = makeWorld({ heroes: [{ cls: "intern", L: 1, kit: "none" }] });
    const h = w.state.heroes[0];
    const stick = h.eq[0];
    assert.ok(stick.flags & I.FLAG_STARTER);
    Hr.grantXP(w.state, h, 1e5, makeEv());
    assert.ok(h.L >= 10, `Lv ${h.L}`);
    assert.equal(h.eq[0].uid, stick.uid, "same item");
    assert.equal(h.eq[0].ilvl, h.L - 2, "iRef(L)");
    Hr.grantXP(w.state, h, 1e7, makeEv());
    assert.equal(h.eq[0].uid, stick.uid);
    assert.equal(h.eq[0].ilvl, h.L - 2, "still growing past Lv 10 while it is held (drops land at iRef: docs/BALANCE.md)");
  });

  test("boss XP follows the level gap: a long-beaten boss gives the gap floor", () => {
    assert.equal(F.gap(60 - 12), 0.03); // balance: floor 0.03 (design 0.1)
    assert.equal(F.gap(12 - 12), 1);
  });

  test("autopilot leaves a paused frontier fight alone; the frontier boss may replace a paused farm fight", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 30, mapId: "3-3" }] });
    const api = { calls: [], canChallenge: (wd, kind, idx) => { api.calls.push([kind, idx]); return { ok: true, estimate: 2, heroIds: [w.state.heroes[0].id] }; }, startFight: () => null };
    w.rt.bossApi = api;
    const herd = w.state.herd;
    herd.zone = 2;
    herd.boss[0] = 1;
    herd.boss[1] = 1;
    herd.quota["3-3"] = 40;
    herd.meter = 100;
    herd.fight = { k: "b", i: 2, ids: [1], t: 50, p: [] }; // paused frontier fight
    AP.autoChallenge(w, makeEv());
    assert.deepEqual(api.calls.filter((c) => c[0] === "boss"), [], "nothing may start");
    herd.fight = { k: "b", i: 1, ids: [1], t: 50, p: [] }; // paused farm fight
    AP.autoChallenge(w, makeEv());
    assert.deepEqual(api.calls.filter((c) => c[0] === "boss"), [["boss", 2]], "only the frontier boss");
  });

  test("boss.suspendFight: an offline gap saves a boss fight and calls off a review", () => {
    const { world } = Dm.demoWorld("boss", T0);
    const f = world.rt.fights[0];
    assert.equal(Bo.suspendFight(world, f, makeEv()), "suspended");
    assert.equal(world.rt.fights.length, 0);
    assert.equal(world.state.herd.fight.i, 3);
    assert.equal(Bo.suspendFight(world, f, makeEv()), null, "only a running fight");
  });

  test("a big chest with a 30-hero roster scores a bounded number of heroes per item", (tc) => {
    const w = makeWorld({ heroes: Array.from({ length: 30 }, (_, i) => ({ cls: "shellmancer", L: 40 + (i % 3), mapId: "4-1" })) });
    const finder = w.state.heroes[5];
    const it = weapon(w.state, "shellmancer", 44, 3);
    const t = performance.now();
    for (let k = 0; k < 20; k++) AP.offerDrop(w, finder, Object.assign({}, it, { uid: w.state.herd.nextUid++ }), makeEv());
    within(tc, performance.now() - t, 150, "20 offers");
    assert.equal(finder.eq[0].ilvl, 44, "the finder still gets the first upgrade");
  });
});

// Wall-clock bounds: the strict ones with PERF=1 only (test/helpers/perf.mjs: other test files run
// in parallel, and a loaded machine stretches V8 timings); otherwise 10x, which only a hang fails.
describe("tick cost (V8; QuickJS is 20-50x slower)", () => {
  test("30 heroes and a 240-item merged chest: one item offered a tick, the tick stays cheap", (tc) => {
    const specs = Array.from({ length: 30 }, (_, k) => ({ address: `t${k + 1}`, plan: [["working", 1e9]], space: `spc_${1 + (k % 3)}` }));
    const w = W.createWorld({ nowMs: T0, seed: 3 });
    const c = Dm.makeCast(specs);
    Dm.runCast(w, c, T0 + 1200 * 1000);
    const h = w.state.heroes[0];
    h.pend = [{ min: 2400, fmin: 0, title: "a day of work", at: w.rt.nowMs, sealFactor: 1 }];
    const t0 = performance.now();
    assert.equal(W.command(w, "claimChest", { heroId: h.id }, w.rt.nowMs).ok, true);
    const claimMs = performance.now() - t0;
    assert.equal(w.state.herd.inbox.length, 240, "rolled at once, offered later");
    const times = [];
    let t = w.state.herd.lastMs;
    for (let i = 0; i < 240; i++) {
      t += 1000;
      Dm.advanceCast(c, 1);
      const before = w.state.herd.inbox ? w.state.herd.inbox.length : 0;
      const s = Dm.castSnapshot(c, t);
      const a = performance.now();
      W.tick(w, s);
      times.push(performance.now() - a);
      const after = w.state.herd.inbox ? w.state.herd.inbox.length : 0;
      assert.ok(before - after <= 1, "one offer a tick");
    }
    assert.equal(w.state.herd.inbox, undefined, "drained");
    times.sort((x, y) => x - y);
    const p99 = times[Math.floor(times.length * 0.99)];
    // quiet machine: claim ~3 ms, median ~0.4, p99 ~2-3 ms
    within(tc, claimMs, 100, "claim");
    within(tc, times[times.length >> 1], 3, "tick median");
    within(tc, p99, 15, "tick p99");
    assertClean(w);
  });

  test("8 questing heroes: median under 2 ms per tick and per 5-tick catch-up", (tc) => {
    const specs = Array.from({ length: 8 }, (_, k) => ({ address: `t${k + 1}`, plan: [["working", 1e9]], space: `spc_${1 + (k % 2)}` }));
    const w = W.createWorld({ nowMs: T0, seed: 3 });
    const c = Dm.makeCast(specs);
    Dm.runCast(w, c, T0 + 600 * 1000); // warm up: levels, maps, lanes
    const one = [];
    let t = w.state.herd.lastMs;
    for (let i = 0; i < 300; i++) {
      t += 1000;
      Dm.advanceCast(c, 1);
      const s = Dm.castSnapshot(c, t);
      const t0 = performance.now();
      W.tick(w, s);
      one.push(performance.now() - t0);
    }
    const five = [];
    for (let i = 0; i < 60; i++) {
      t += 5000;
      Dm.advanceCast(c, 5);
      const s = Dm.castSnapshot(c, t);
      const t0 = performance.now();
      W.tick(w, s);
      five.push(performance.now() - t0);
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    within(tc, med(one), 2, "tick median");
    within(tc, med(five), 2 * 5, "5-tick catch-up median");
    assertClean(w);
  });
});
