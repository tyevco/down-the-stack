// World (ARCHITECTURE §3.4, D§2.10-2.11): create / load / serialize, the tick clock (catch-up <= 5
// ticks, offline gaps, a backwards clock, day rollover), determinism, the emitter budgets
// (D§11.7), version / dirty / major, herd trackers, and every command of ARCHITECTURE §3.5 with
// its validation errors.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as D from "../mods/down-the-stack/game/data.js";
import * as F from "../mods/down-the-stack/game/formulas.js";
import { autoOn } from "../mods/down-the-stack/game/formulas.js";
import * as Hr from "../mods/down-the-stack/game/heroes.js";
import * as I from "../mods/down-the-stack/game/items.js";
import * as W from "../mods/down-the-stack/game/world.js";
import * as A from "../mods/down-the-stack/game/agents.js";
import * as AP from "../mods/down-the-stack/game/autopilot.js";
import { encodeState, decodeState, SAVE_VERSION, crc32 } from "../mods/down-the-stack/game/save.js";

const T0 = 1_790_000_000_000;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const prog = (key = "claude") => ({ key, name: key, icon: null, tint: false, tile: null, color: null });

function ag(addr, status, seq = 1, extra = {}) {
  return Object.assign({
    address: addr, status, seq, app: "claude", program: prog(), title: "Ship it", space: "s1", space_name: "repo",
    tab: "tb1", tab_index: 1, tab_name: "main", pane: `p${addr}`, pane_name: null, pinned: false, focused: false,
  }, extra);
}

function snap(nowMs, agents = [], extra = {}) {
  return Object.assign({
    nowMs, tzOffsetMin: 0, weekday: 2, windowActive: true, focusedTerminal: null, agents, subagents: [], tabs: {}, spaces: [],
  }, extra);
}

// A scripted run: every second a snapshot from `script(i)` (an agents list).
function run(world, from, n, script) {
  let now = from;
  for (let i = 1; i <= n; i++) {
    now += 1000;
    W.tick(world, snap(now, script(i)));
  }
  return now;
}

// A world with heroes bound to t1.. (all working) after `ticks` seconds.
function busyWorld({ seed = 5, heroes = 2, ticks = 30 } = {}) {
  const w = W.createWorld({ nowMs: T0, seed });
  const agents = [];
  for (let k = 1; k <= heroes; k++) agents.push(ag(`t${k}`, "working"));
  const now = run(w, T0, ticks, () => agents);
  return { w, now, agents };
}

function fakeBoss() {
  const api = {
    calls: [],
    canChallenge(world, kind, idx, heroId) { api.calls.push(["can", kind, idx, heroId]); return { ok: true, estimate: 1, label: "Even" }; },
    estimate() { return 1.2; },
    startFight(world, kind, idx, ids) { api.calls.push(["start", kind, idx, ids]); return { kind, bossIdx: idx, heroIds: ids.slice() }; },
    stepFight() { return "running"; },
    retreat(world, ev, heroId) {
      api.calls.push(["retreat", heroId]);
      const i = world.rt.fights.findIndex((f) => (heroId == null ? f.kind !== "review" : f.heroIds.includes(heroId)));
      if (i < 0) return { ok: false, error: "No fight" };
      world.rt.fights.splice(i, 1);
      return { ok: true, msg: "Postmortem" };
    },
  };
  return api;
}

describe("create, load, serialize", () => {
  test("createWorld: an empty herd and a runtime", () => {
    const w = W.createWorld({ nowMs: T0, seed: 9 });
    assert.equal(w.state.v, SAVE_VERSION);
    assert.deepEqual(w.state.heroes, []);
    assert.equal(w.state.herd.lastMs, T0);
    assert.ok(w.rt.bind instanceof Map && w.rt.live instanceof Map && w.rt.contractors instanceof Map);
    assert.deepEqual([w.rt.tick, w.rt.version, w.rt.dirty, w.rt.readOnly], [0, 0, false, false]);
  });

  test("serialize -> loadWorld -> serialize is identical after a busy run", () => {
    const { w, now, agents } = busyWorld({ heroes: 3, ticks: 400 });
    agents[0].status = "done";
    agents[0].seq++;
    run(w, now, 20, () => agents);
    assert.ok(w.state.heroes[0].pend.length === 1);
    const t1 = W.serialize(w);
    const { world, warning } = W.loadWorld(t1, { nowMs: now });
    assert.equal(warning, null);
    assert.equal(W.serialize(world), t1);
    assert.deepEqual(world.state, decodeState(t1).state);
    assert.equal(world.rt.tick, w.state.herd.tick);
  });

  test("loadWorld mends half emoji an older build cut into seats, chest titles and journal lines", () => {
    const w = W.createWorld({ nowMs: T0, seed: 2 });
    run(w, T0, 3, () => [ag("t1", "working", 1, { space_name: "Payments platform rewrite 2026 🚀" })]);
    const h = w.state.heroes[0];
    assert.equal(h.seat, "payments platform rewrite 2026 /claude", "a new seat never ends in half an emoji");
    // what the old cut saved: a lone high surrogate at the cut
    h.seat = "payments platform rewrite 2026 \ud83d/claude";
    h.pend = [{ min: 10, fmin: 0, title: "Wire the release checklist into CI now \ud83d", at: T0, sealFactor: 1 }];
    w.state.herd.log.push([T0, "ship", h.id, "Wire the release checklist into CI now \ud83d", 1]);
    w.state.herd.log.push([T0, "ship", h.id, "Ship 🚀 it", 1]);
    const back = W.loadWorld(W.serialize(w), { nowMs: T0 + 3000 }).world;
    const b = back.state.heroes[0];
    assert.equal(b.seat, "payments platform rewrite 2026 /claude");
    assert.equal(b.pend[0].title, "Wire the release checklist into CI now");
    const texts = back.state.herd.log.slice(-2).map((e) => e[3]);
    assert.deepEqual(texts, ["Wire the release checklist into CI now", "Ship 🚀 it"], "whole emoji stay");
    for (const e of back.state.herd.log) assert.ok(String(e[3]).isWellFormed());
    // the hero still sits in its space's seat
    W.tick(back, snap(T0 + 4000, [ag("t9", "working", 1, { space_name: "Payments platform rewrite 2026 🚀", space: "s7" })]));
    assert.equal(back.rt.bind.get("t9"), b.id);
  });

  test("loadWorld drops Contractor ids from the paused boss fight (Contractors are numbered afresh)", () => {
    const w = W.createWorld({ nowMs: T0, seed: 2 });
    run(w, T0, 2, () => [ag("t1", "working")]);
    const id = w.state.heroes[0].id;
    w.state.herd.fight = { k: "b", i: 0, ids: [id, -1, -2], hl: [-2], t: 10, ph: 1, p: [[0, 100, 500]], m: {}, pool: 500, dl: 400, sq: 0 };
    const f = W.loadWorld(W.serialize(w), { nowMs: T0 + 2000 }).world.state.herd.fight;
    assert.deepEqual([f.ids, f.hl, f.n], [[id], [], 3], "the boss keeps the pool it was given for three");
  });

  test("a newer save loads read-only with a warning: no accrual, no commands", () => {
    const w = W.createWorld({ nowMs: T0, seed: 9 });
    const obj = JSON.parse(W.serialize(w));
    obj.v = SAVE_VERSION + 1;
    obj.crc = "";
    const t0 = JSON.stringify(obj);
    const text = t0.replace('"crc":""', `"crc":"${crc32(t0)}"`);
    const { world, warning } = W.loadWorld(text, { nowMs: T0 });
    assert.ok(world.rt.readOnly);
    assert.match(warning, /read-only/);
    const r = W.tick(world, snap(T0 + 1000, [ag("t1", "working")]));
    assert.equal(r.ticks, 0);
    assert.equal(world.state.herd.tick, 0);
    assert.equal(world.rt.dirty, false);
    assert.equal(W.command(world, "setting", { key: "calm", value: true }).ok, false);
  });

  test("a read-only world binds for display only: no hires, no chests, no XP", () => {
    const w0 = W.createWorld({ nowMs: T0, seed: 9 });
    const obj = JSON.parse(W.serialize(w0));
    obj.v = SAVE_VERSION + 1;
    obj.crc = "";
    const t0 = JSON.stringify(obj);
    const { world } = W.loadWorld(t0.replace('"crc":""', `"crc":"${crc32(t0)}"`), { nowMs: T0 });
    let now = T0;
    for (const [status, seq] of [["working", 1], ["done", 2], ["idle", 3]]) {
      now += 1000;
      W.tick(world, snap(now, [ag("t1", status, seq, { focused: true })]));
    }
    assert.equal(world.state.heroes.length, 0, "no hire");
    assert.equal(world.rt.bind.size, 1, "the agent shows (as a Contractor)");
    const c = world.rt.contractors.get("t1");
    assert.ok(c && c.contractor);
    assert.equal(c.xp || 0, 0);
    assert.equal(world.state.herd.seals, 0);
    assert.equal(world.rt.dirty, false);
  });

  test("corrupt text throws with a code (the host falls back to save.bak)", () => {
    assert.throws(() => W.loadWorld("{nope", { nowMs: T0 }), (e) => e.code === "parse");
    const t = W.serialize(W.createWorld({ nowMs: T0 }));
    assert.ok(t.includes('"tick":0'));
    assert.throws(() => W.loadWorld(t.replace('"tick":0', '"tick":7'), { nowMs: T0 }), (e) => e.code === "crc");
    assert.throws(() => W.loadWorld("[1,2]", { nowMs: T0 }), (e) => e.code === "shape");
  });
});

describe("the clock (D§2.10, D§2.11)", () => {
  test("whole seconds since the last tick; under half a second does nothing", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    assert.deepEqual(W.tick(w, snap(T0 + 400)), { advanced: false, ticks: 0 });
    assert.deepEqual(W.tick(w, snap(T0 + 1000)), { advanced: true, ticks: 1 });
    assert.deepEqual(W.tick(w, snap(T0 + 4400)), { advanced: true, ticks: 3 });
    assert.equal(w.state.herd.lastMs, T0 + 4000, "the sub-second remainder carries");
    assert.equal(w.state.herd.tick, 4);
    assert.equal(w.rt.tick, 4);
  });

  test("catch-up is at most 5 ticks; the rest of a short gap is dropped", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    assert.deepEqual(W.tick(w, snap(T0 + 30000)), { advanced: true, ticks: 5 });
    assert.equal(w.state.herd.lastMs, T0 + 30000);
    assert.deepEqual(W.tick(w, snap(T0 + 31000)), { advanced: true, ticks: 1 });
  });

  test("a gap over 60 s is offline: no combat, Fresh Eyes from wall-clock time (capped), lastMs resyncs", () => {
    const { w, now, agents } = busyWorld({ heroes: 1, ticks: 60 });
    const h = w.state.heroes[0];
    h.st.seals = 1;
    h.fe = 0;
    const kills = h.st.kills;
    const tick = w.state.herd.tick;
    agents.length = 0; // the app was closed: the terminal is gone on return
    const r = W.tick(w, snap(now + 2 * 3600000, agents));
    assert.deepEqual(r, { advanced: true, ticks: 0 });
    assert.equal(w.state.herd.tick, tick);
    assert.equal(h.st.kills, kills);
    assert.equal(h.fe, 30, "+0.25 min per min of 120 min");
    assert.equal(w.state.herd.lastMs, now + 2 * 3600000);
    W.tick(w, snap(now + 40 * 86400000, agents));
    assert.equal(h.fe, 60, "capped at 60 + 15 x Campfire");
    assert.deepEqual(w.rt.errors, []);
  });

  test("reopening the app after more than 24 h: an agent that outlived the app keeps its chest; a Waiting hero earns no Fresh Eyes", () => {
    // herdr's core keeps terminals while the app is closed (defaults/AGENTS.md): a task ends
    // "done" (unseen) on Friday, another agent waits for an answer, the laptop closes for 30 h
    const w = W.createWorld({ nowMs: T0, seed: 3 });
    let now = run(w, T0, 1200, (i) => [ag("t1", "working"), ag("t2", i < 120 ? "working" : "blocked", i < 120 ? 1 : 2)]);
    now = run(w, now, 10, () => [ag("t1", "done", 2), ag("t2", "blocked", 2)]);
    const [h1, h2] = w.state.heroes;
    assert.equal(h1.pend.length, 1);
    h2.st.seals = 1; // Fresh Eyes needs a first credited Seal
    h2.fe = 0;
    const text = W.serialize(w);
    const later = now + 30 * 3600000;
    const kept = [ag("t1", "done", 2), ag("t2", "blocked", 2)];
    const w2 = W.loadWorld(text, { nowMs: later }).world;
    W.tick(w2, snap(later, kept));
    const [k1, k2] = w2.state.heroes;
    assert.equal(k1.pend.length, 1, "not Unreviewed: its agent is still there, unseen");
    assert.equal(w2.state.herd.seals, 0);
    assert.equal(k2.fe, 0, "no Fresh Eyes while Waiting (D§2.9)");
    // the person looks at it: done -> idle (herdr's seen flip, same seq) pays the full 2 Seals
    W.tick(w2, snap(later + 1000, [ag("t1", "idle", 2), ag("t2", "blocked", 2)]));
    assert.equal(k1.pend.length, 0);
    assert.ok(near(w2.state.herd.seals, 2, 1e-6));
    // control: a terminal that really ended while the app was closed still opens Unreviewed
    const w3 = W.loadWorld(text, { nowMs: later }).world;
    W.tick(w3, snap(later, [ag("t2", "blocked", 2)]));
    assert.equal(w3.state.heroes[0].pend.length, 0);
    assert.equal(w3.state.herd.seals, 0);
    assert.deepEqual(w2.rt.errors, []);
    assert.deepEqual(w3.rt.errors, []);
  });

  test("an empty first listing after an app start holds the offline gap until agents appear (or 10 ticks)", () => {
    const w = W.createWorld({ nowMs: T0, seed: 3 });
    let now = run(w, T0, 1200, () => [ag("t1", "working")]);
    now = run(w, now, 10, () => [ag("t1", "done", 2)]);
    const text = W.serialize(w);
    const later = now + 30 * 3600000;
    // herdr has not published its terminals yet on the first pump: nothing expires
    const w2 = W.loadWorld(text, { nowMs: later }).world;
    W.tick(w2, snap(later, []));
    assert.equal(w2.state.heroes[0].pend.length, 1, "held");
    assert.ok(w2.rt.offlineHold);
    // the listing arrives a second later: the kept agent is live, its chest stays pending
    W.tick(w2, snap(later + 1000, [ag("t1", "done", 2)]));
    assert.equal(w2.rt.offlineHold, null);
    assert.equal(w2.state.heroes[0].pend.length, 1);
    // nobody comes back: after 10 ticks the gap is settled as usual (Unreviewed)
    const w3 = W.loadWorld(text, { nowMs: later }).world;
    W.tick(w3, snap(later, []));
    for (let i = 1; i <= 9; i++) W.tick(w3, snap(later + i * 1000, []));
    assert.equal(w3.state.heroes[0].pend.length, 1, "still held after 9 ticks");
    W.tick(w3, snap(later + 10000, []));
    assert.equal(w3.state.heroes[0].pend.length, 0, "settled: Unreviewed");
    assert.equal(w3.state.herd.seals, 0);
    assert.deepEqual(w3.rt.errors, []);
  });

  test("a restart while an offline gap is held finds the gap again: the hold is memory only, the save keeps the gap", () => {
    const HOUR = 3600000;
    const w = W.createWorld({ nowMs: T0, seed: 3 });
    let now = run(w, T0, 1200, () => [ag("t1", "working")]);
    now = run(w, now, 10, () => [ag("t1", "done", 2)]);
    now = run(w, now, 10, () => [ag("t1", "idle", 2)]); // seen: the chest opens, Seals are credited
    assert.ok(w.state.heroes[0].st.seals > 0, "Fresh Eyes accrue after the first credited Seal");
    const text = W.serialize(w);
    const L0 = w.state.herd.lastMs;
    const later = L0 + 2 * HOUR; // 2 h of Fresh Eyes: 30 min, under the 60 min cap
    const settle = (world, from) => { for (let i = 1; i <= 10; i++) W.tick(world, snap(from + i * 1000, [])); };
    // reference: the app stays open through the hold (10 empty ticks, then settled)
    const ref = W.loadWorld(text, { nowMs: later }).world;
    W.tick(ref, snap(later, []));
    assert.ok(ref.rt.offlineHold);
    settle(ref, later);
    assert.equal(ref.rt.offlineHold, null);
    const feRef = ref.state.heroes[0].fe;
    assert.ok(feRef > w.state.heroes[0].fe + 25, `the gap earned Fresh Eyes (${feRef})`);
    // the app closes 3 s into the hold (close() flushes a save) and starts again 5 s later
    const a = W.loadWorld(text, { nowMs: later }).world;
    W.tick(a, snap(later, []));
    for (let i = 1; i <= 3; i++) W.tick(a, snap(later + i * 1000, []));
    assert.ok(a.rt.offlineHold, "still held");
    assert.equal(a.state.herd.lastMs, later + 3000);
    const flushed = W.serialize(a);
    assert.equal(decodeState(flushed).state.herd.lastMs, L0 + 3000, "saved as not yet seen: the time before the gap + the 3 s stepped");
    assert.equal(W.serialize(W.loadWorld(flushed, { nowMs: later }).world), flushed, "round-trips");
    const restart = later + 8000;
    const b = W.loadWorld(flushed, { nowMs: restart }).world;
    W.tick(b, snap(restart, []));
    assert.ok(b.rt.offlineHold, "held again after the restart");
    assert.equal(b.rt.offlineHold.dtMs, restart - (L0 + 3000));
    settle(b, restart);
    assert.equal(b.rt.offlineHold, null);
    // the gap counts once: the same Fresh Eyes as the session that stayed open (+ 5 s more time)
    assert.ok(Math.abs(b.state.heroes[0].fe - feRef) < 0.05, `${b.state.heroes[0].fe} vs ${feRef}`);
    // once settled, the save writes herd.lastMs as it is (a later restart sees no gap)
    assert.equal(decodeState(W.serialize(b)).state.herd.lastMs, b.state.herd.lastMs);
    const c = W.loadWorld(W.serialize(b), { nowMs: restart + 12000 }).world;
    W.tick(c, snap(restart + 12000, []));
    assert.equal(c.rt.offlineHold, undefined, "no gap: nothing held");
    assert.ok(Math.abs(c.state.heroes[0].fe - b.state.heroes[0].fe) < 0.05);
    for (const x of [ref, a, b, c]) assert.deepEqual(x.rt.errors, []);
  });

  test("a clock that goes backwards accrues nothing until it passes the last tick again", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    W.tick(w, snap(T0 + 5000));
    const before = W.serialize(w);
    // zero steps, but the snapshot is still reconciled so the stage stays live
    assert.deepEqual(W.tick(w, snap(T0 + 2000)), { advanced: true, ticks: 0 });
    assert.deepEqual(W.tick(w, snap(T0 + 4900)), { advanced: true, ticks: 0 });
    assert.equal(W.serialize(w), before, "nothing changed");
    assert.ok(w.rt.clockBehind);
    assert.deepEqual(W.tick(w, snap(T0 + 6000)), { advanced: true, ticks: 1 });
    assert.equal(w.rt.clockBehind, false);
  });

  test("a clock behind by less than an hour still reconciles: statuses move, nothing accrues", () => {
    const { w, now, agents } = busyWorld({ heroes: 1, ticks: 20 });
    const h = w.state.heroes[0];
    const live = w.rt.live.get(h.id);
    const kills = h.st.kills;
    const tick = w.state.herd.tick;
    const lastMs = w.state.herd.lastMs;
    const v = w.rt.version;
    agents[0] = ag("t1", "blocked", 2);
    assert.deepEqual(W.tick(w, snap(now - 30 * 60000, agents)), { advanced: true, ticks: 0 });
    assert.equal(live.status, "blocked");
    assert.equal(live.state, "waiting", "the stage shows the agent waiting");
    assert.ok(w.rt.version > v);
    assert.equal(w.state.herd.tick, tick);
    assert.equal(w.state.herd.lastMs, lastMs, "accrual waits for the clock to pass the last tick");
    assert.equal(h.st.kills, kills);
    assert.deepEqual(W.tick(w, snap(lastMs + 1000, agents)), { advanced: true, ticks: 1 });
  });

  test("a clock that jumps back by more than an hour resyncs without accruing", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    W.tick(w, snap(T0 + 5000));
    const tick = w.state.herd.tick;
    assert.deepEqual(W.tick(w, snap(T0 - 2 * 3600000)), { advanced: false, ticks: 0 });
    assert.equal(w.state.herd.lastMs, T0 - 2 * 3600000);
    assert.equal(w.state.herd.tick, tick);
    assert.deepEqual(W.tick(w, snap(T0 - 2 * 3600000 + 1000)), { advanced: true, ticks: 1 });
  });

  test("the local day turns at 04:00 (tzOffsetMin) and never goes back", () => {
    // 2026-09-21 03:59 UTC = 05:59 at UTC+2 (offset -120)
    const t = Date.UTC(2026, 8, 21, 3, 59);
    assert.equal(W.localDay(t, 0), W.localDay(Date.UTC(2026, 8, 20, 12), 0));
    assert.equal(W.localDay(t + 60000, 0), W.localDay(t, 0) + 1);
    assert.equal(W.localDay(t, -120), W.localDay(t + 60000, 0));
    const w = W.createWorld({ nowMs: t, seed: 1 });
    W.tick(w, snap(t + 1000, [], { tzOffsetMin: 0 }));
    const d = w.state.herd.day;
    W.tick(w, snap(t + 2000, [], { tzOffsetMin: 300 })); // a timezone change that would go back
    assert.equal(w.state.herd.day, d, "the highest day seen");
  });
});

describe("determinism (D§12.3.12)", () => {
  test("the same snapshots give byte-identical saves and identical effects", () => {
    const script = (i) => {
      const s1 = i < 500 ? "working" : i < 520 ? "done" : "idle";
      const s2 = i % 300 < 200 ? "working" : "blocked";
      return [ag("t1", s1, i < 500 ? 1 : i < 520 ? 2 : 3), ag("t2", s2, 1 + Math.floor(i / 100) * 2 + (i % 300 < 200 ? 0 : 1)), ag("t3", "working", 1, { space: "s2", space_name: "other" })];
    };
    const a = W.createWorld({ nowMs: T0, seed: 42 });
    const b = W.createWorld({ nowMs: T0, seed: 42 });
    run(a, T0, 900, script);
    run(b, T0, 900, script);
    assert.equal(W.serialize(a), W.serialize(b));
    assert.deepEqual(a.rt.fx, b.rt.fx);
    assert.deepEqual(a.rt.errors, []);
    const c = W.createWorld({ nowMs: T0, seed: 43 });
    run(c, T0, 900, script);
    assert.notEqual(W.serialize(c), W.serialize(a), "the seed matters");
  });
});

describe("the emitter (D§11.7) and runtime flags", () => {
  test("at most 2 numbers per hero (crit > skill > basic, the rest merged), 6 per room, 12 per stage", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    w.rt.rooms = [{ id: "r1", heroIds: [1, 2, 3, 4] }, { id: "r2", heroIds: [5, 6, 7, 8] }, { id: "r3", heroIds: [9, 10] }];
    const ev = W.makeEmitter(w);
    ev.fx("num", { heroId: 1, value: 100, text: "100" });
    ev.fx("num", { heroId: 1, value: 200, text: "200", skill: true });
    ev.fx("crit", { heroId: 1, value: 900, text: "900" });
    ev.fx("num", { heroId: 1, value: 300, text: "300" });
    ev.fx("poof", { heroId: 1 });
    ev.flush();
    const mine = w.rt.fx.filter((f) => f.heroId === 1 && f.kind !== "poof");
    assert.equal(mine.length, 2);
    assert.equal(mine[0].kind, "crit");
    assert.equal(mine[1].text, "×3 600");
    assert.equal(mine[1].merged, 3);
    assert.ok(w.rt.fx.some((f) => f.kind === "poof"), "other effects pass");
    assert.ok(w.rt.fx.every((f) => /^fx:0:\d+$/.test(f.key) && f.bornTick === 0));
    // effects are stamped in place on the emitter's own copies: a caller's data object is never touched
    const data = { heroId: 2, value: 7, text: "7" };
    ev.fx("num", data);
    ev.fx("poof", data);
    ev.flush();
    assert.deepEqual(data, { heroId: 2, value: 7, text: "7" });
    const two = w.rt.fx.filter((f) => f.heroId === 2);
    assert.equal(two.length, 2);
    assert.notEqual(two[0], two[1]);
    assert.deepEqual(Object.keys(two[0]), ["kind", "heroId", "value", "text", "key", "bornTick"]);

    const w2 = W.createWorld({ nowMs: T0, seed: 1 });
    w2.rt.rooms = w.rt.rooms;
    const ev2 = W.makeEmitter(w2);
    ev2.fx("num", { heroId: 1, value: 5 });
    ev2.fx("num", { heroId: 1, value: 6 });
    ev2.fx("incoming", { heroId: 1, value: 3 });
    ev2.fx("incoming", { heroId: 1, value: 4 });
    ev2.flush();
    assert.deepEqual(w2.rt.fx.map((f) => [f.kind, f.value]), [["num", 11], ["incoming", 7]], "one outgoing + one hero-side");

    const w3 = W.createWorld({ nowMs: T0, seed: 1 });
    w3.rt.rooms = w.rt.rooms;
    const ev3 = W.makeEmitter(w3);
    for (let id = 1; id <= 10; id++) for (let k = 0; k < 2; k++) ev3.fx("num", { heroId: id, value: 10 });
    ev3.flush();
    const per = (room) => w3.rt.fx.filter((f) => room.heroIds.includes(f.heroId)).length;
    assert.equal(per(w.rt.rooms[0]), 6);
    assert.equal(per(w.rt.rooms[1]), 6);
    assert.equal(w3.rt.fx.length, 12);
    // the rooms change (a new rt.rooms array): the per-room cap follows them, not the old ones
    w3.rt.rooms = [{ id: "r1", heroIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }];
    w3.rt.fx = [];
    for (let id = 1; id <= 10; id++) for (let k = 0; k < 2; k++) ev3.fx("num", { heroId: id, value: 10 });
    ev3.flush();
    assert.equal(w3.rt.fx.length, 6, "one room: 6 numbers");
  });

  test("notes queue 3 s apart; banners last 3 ticks; fx live two ticks", () => {
    const { w, now, agents } = busyWorld({ heroes: 1, ticks: 2 });
    w.rt.notes = []; // drop the "New hire" note
    const ev = W.makeEmitter(w);
    ev.note("one");
    ev.note("two");
    ev.note("two");
    ev.banner("The herd reached frame #2", "FIXED");
    assert.equal(w.rt.notes.length, 2, "duplicates are dropped");
    assert.equal(w.rt.notes[1].showTick, w.rt.notes[0].showTick + 3);
    run(w, now, 3, () => agents);
    assert.equal(w.rt.banner, null);
    assert.ok(w.rt.notes.every((n) => n.text !== "one"));
    run(w, now + 3000, 4, () => agents);
    assert.equal(w.rt.notes.length, 0);
    assert.ok(w.rt.fx.every((f) => w.rt.tick - f.bornTick < 2));
  });

  test("effects age per tick() call: a two-step call shows all its effects at age 0 and keeps the last call's fade frame", () => {
    // herdr re-arms a 1 s timer after its callback, so now and then one pump runs 2 steps
    const { w, now, agents } = busyWorld({ heroes: 3, ticks: 40 });
    const t0 = w.rt.tick;
    const prev = w.rt.fx.filter((f) => f.bornTick === t0).map((f) => f.key);
    assert.ok(prev.length > 0, "the last call left age-0 effects");
    W.tick(w, snap(now + 2000, agents));
    const t = w.rt.tick;
    assert.equal(t, t0 + 2);
    assert.ok(w.rt.fx.every((f) => f.bornTick === t || f.bornTick === t - 1), "every effect is age 0 or 1");
    for (const k of prev) assert.equal(w.rt.fx.find((f) => f.key === k)?.bornTick, t - 1, `${k} keeps its fade frame`);
    const firstStep = w.rt.fx.filter((f) => f.key.startsWith(`fx:${t0 + 1}:`));
    assert.ok(firstStep.length > 0 && firstStep.every((f) => f.bornTick === t), "effects of the first of the two steps show at age 0");
    // D§11.7 still holds for the frame: at most 2 numbers a hero, 12 a stage
    const nums = w.rt.fx.filter((f) => f.bornTick === t && ["num", "crit", "heal", "miss", "inv", "abs", "incoming"].includes(f.kind));
    assert.ok(nums.length <= 12);
    for (const h of w.state.heroes) assert.ok(nums.filter((f) => f.heroId === h.id).length <= 2);
    // a one-step call ages exactly as before
    W.tick(w, snap(now + 3000, agents));
    assert.ok(w.rt.fx.every((f) => w.rt.tick - f.bornTick < 2));
    assert.ok(!w.rt.fx.some((f) => f.bornTick < w.rt.tick - 1));
    assert.deepEqual(w.rt.errors, []);
  });

  test("a note expiring on an idle stage bumps the version (it must not linger)", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    W.tick(w, snap(T0 + 1000));
    W.makeEmitter(w).note("Badge: Hello, World");
    let now = T0 + 1000;
    for (let i = 0; i < 2; i++) W.tick(w, snap((now += 1000)));
    const v = w.rt.version;
    W.tick(w, snap((now += 1000)));
    assert.equal(w.rt.notes.length, 0);
    assert.equal(w.rt.version, v + 1);
    W.tick(w, snap((now += 1000)));
    assert.equal(w.rt.version, v + 1, "nothing else changed");
  });

  test("version, dirty and majorAt", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    const v0 = w.rt.version;
    W.tick(w, snap(T0 + 1000, [ag("t1", "working")]));
    assert.ok(w.rt.version > v0);
    assert.equal(w.rt.dirty, true);
    const ev = W.makeEmitter(w);
    ev.major();
    assert.equal(w.rt.majorAt, T0 + 1000);
    ev.journal("ship", 1, "x", 1);
    assert.deepEqual(w.state.herd.log.at(-1), [T0 + 1000, "ship", 1, "x", 1]);
    const v1 = w.rt.version;
    W.command(w, "setting", { key: "calm", value: true }, T0 + 1500);
    assert.equal(w.rt.version, v1 + 1);
  });
});

describe("herd trackers in the tick", () => {
  test("Read-Only Friday: The Friday Deploy falls on a local Friday", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    W.tick(w, snap(T0 + 1000));
    w.state.herd.bossKills[7] = 1;
    w.state.herd.boss[7] = 1;
    W.tick(w, snap(T0 + 2000, [], { weekday: 4 }));
    assert.ok(!w.state.herd.badges.includes("read_only_friday"));
    w.state.herd.bossKills[7] = 2;
    W.tick(w, snap(T0 + 3000, [], { weekday: 5 }));
    assert.ok(w.state.herd.badges.includes("read_only_friday"));
    // credit from outside a fight gets boss.js's wording (the digest matches it, D§10.7)
    assert.ok(w.state.herd.log.some((e) => e[1] === "boss" && e[3] === `${D.BOSSES[7].name} FIXED`));
    assert.ok(w.state.herd.log.some((e) => e[1] === "boss" && e[3] === `${D.BOSSES[7].name} fixed again`));
    assert.equal(w.state.herd.bossAt[7], Math.floor((T0 + 2000) / 1000), "the first clear is dated (D§10.5)");
  });

  test("a newly opened zone takes the banked Seals; a herd-first kill raises the banner", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    W.tick(w, snap(T0 + 1000));
    w.state.herd.meter = 6;
    w.state.herd.bank = 4;
    w.state.herd.boss[0] = 1;
    w.state.herd.bossKills[0] = 1;
    w.state.herd.zone = 1;
    w.state.herd.meter = 0;
    W.tick(w, snap(T0 + 2000));
    assert.equal(w.state.herd.meter, 4);
    assert.equal(w.state.herd.bank, 0);
    assert.equal(w.rt.banner.text, "The herd reached frame #2");
    assert.ok(w.state.herd.badges.includes("zero_warnings"));
    assert.ok(w.rt.notes.some((n) => n.text === "New zone: Callback Caverns"));
  });

  test("Pair Programmer counts seconds two guild-mates quest in one room", () => {
    const { w } = busyWorld({ heroes: 2, ticks: 20 });
    assert.ok(w.state.herd.pairSec >= 15);
    const { w: apart } = (() => {
      const x = W.createWorld({ nowMs: T0, seed: 5 });
      run(x, T0, 20, () => [ag("t1", "working"), ag("t2", "working", 1, { space: "s2", space_name: "two" })]);
      return { w: x };
    })();
    assert.equal(apart.state.herd.pairSec, 0);
  });

  test("a Contractor's XP is shared: half goes to the lowest-level benched hero of its seat", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    let now = run(w, T0, 1, () => [ag("t0", "idle")]);
    const benched = w.state.heroes[0];
    w.state.herd.hired = [w.state.herd.day, 6];
    now = run(w, now, 1, () => [ag("t1", "working")]); // t0 is gone; t1 rebinds the benched hero...
    assert.equal(A.heroById(w, w.rt.bind.get("t1")), benched);
    now = run(w, now, 1, () => [ag("t1", "working"), ag("t2", "working")]); // ...and t2 must be a Contractor
    const c = A.heroById(w, w.rt.bind.get("t2"));
    assert.ok(c.contractor);
    // bench the main hero, then let the Contractor earn
    now = run(w, now, 1, () => [ag("t2", "working")]);
    assert.ok(!w.rt.live.has(benched.id));
    const total = (h) => { let t = h.xp; for (let l = 1; l < h.L; l++) t += F.need(l); return t; };
    const b0 = total(benched);
    const c0 = total(c);
    Hr.grantXP(w.state, c, 100, null);
    run(w, now, 1, () => [ag("t2", "working")]);
    const gained = total(c) - c0;
    assert.ok(gained >= 100);
    assert.ok(near(total(benched) - b0, gained / 2, 1e-6));
  });

  test("the digest dot after 30+ minutes away, cleared by digestSeen", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    W.tick(w, snap(T0 + 1000));
    w.state.herd.badges.push("hello_world"); // something new since the herd began
    W.tick(w, snap(T0 + 2000, [], { windowActive: false }));
    W.tick(w, snap(T0 + 3000, [], { windowActive: true }));
    assert.equal(w.rt.digestDot, false, "a short absence");
    W.tick(w, snap(T0 + 4000, [], { windowActive: false }));
    let now = T0 + 4000;
    for (let i = 0; i < 40; i++) { now += 50000; W.tick(w, snap(now, [], { windowActive: false })); }
    W.tick(w, snap(now + 1000, [], { windowActive: true }));
    assert.equal(w.rt.digestDot, true);
    assert.equal(W.command(w, "digestSeen", {}, now + 1500).ok, true);
    assert.equal(w.rt.digestDot, false);
    assert.equal(w.state.herd.digestAt, now + 1500);
    assert.equal(w.state.herd.digestSnap.at, now + 1500, "digestSeen records the snapshot the next digest diffs against");
  });
});

describe("bosses through the tick (real boss.js)", () => {
  // Two Lv 16 Shellmancers questing at an open door: autopilot challenges and wins.
  function doorWorld(level, n = 2, weekday = 2) {
    const w = W.createWorld({ nowMs: T0, seed: 9 });
    const ids = [];
    for (let k = 1; k <= n; k++) ids.push(`t${k}`);
    let now = run(w, T0, 1, () => ids.map((a) => ag(a, "idle")));
    for (const h of w.state.heroes) { h.L = level; h.cls = 3; h.sp = Hr.autoRanks(3, level).slice(); }
    w.state.herd.quota = { "1-1": 40, "1-2": 40, "1-3": 40 };
    w.state.herd.meter = 6;
    const agents = ids.map((a) => ag(a, "working", 2));
    const tick = (k) => { for (let i = 0; i < k; i++) { now += 1000; W.tick(w, snap(now, agents, { weekday })); } return now; };
    return { w, tick, agents, get now() { return now; } };
  }

  test("autopilot takes the open door and the herd-first kill opens the next zone", () => {
    const d = doorWorld(16);
    let startedAt = -1;
    for (let i = 0; i < 400 && (startedAt < 0 || d.w.rt.fights.length); i++) {
      d.tick(1);
      if (startedAt < 0 && d.w.rt.fights.length) startedAt = i;
    }
    const herd = d.w.state.herd;
    assert.ok(startedAt >= 0 && startedAt <= 60, "challenged at the first autopilot pass");
    assert.equal(herd.boss[0], 1);
    assert.equal(herd.zone, 1);
    assert.ok(herd.badges.includes("zero_warnings"));
    assert.ok(herd.log.some((e) => e[1] === "boss"));
    assert.deepEqual(d.w.rt.errors, []);
  });

  test("a fight saved mid-way is suspended in the save and resumes after a reload", () => {
    const d = doorWorld(13, 1);
    d.tick(90);
    assert.equal(d.w.rt.fights.length, 1);
    assert.ok(d.w.state.herd.fight);
    const text = W.serialize(d.w);
    const { world } = W.loadWorld(text, { nowMs: d.now });
    assert.equal(world.rt.fights.length, 0);
    assert.equal(W.serialize(world), text);
    let now = d.now;
    for (let i = 0; i < 8; i++) { now += 1000; W.tick(world, snap(now, d.agents)); }
    assert.equal(world.rt.fights.length, 1);
    assert.equal(world.rt.fights[0].bossIdx, 0);
    assert.deepEqual(world.rt.errors, []);
  });
});

describe("commands (ARCHITECTURE §3.5)", () => {
  function cmdWorld() {
    const { w, now, agents } = busyWorld({ heroes: 2, ticks: 5 });
    const [h1, h2] = w.state.heroes;
    return { w, now, agents, h1, h2 };
  }

  test("every §3.5 command exists; unknown names are refused", () => {
    for (const n of ["claimChest", "markSeen", "equip", "lock", "polish", "deprecate", "squash", "reroll", "learn", "autoLearn",
      "respec", "setClass", "pinMap", "challenge", "retreat", "rename", "retire", "rebind", "buy", "setting"]) {
      assert.ok(W.COMMAND_NAMES.includes(n), n);
    }
    const { w } = cmdWorld();
    assert.equal(W.command(w, "explode", {}).error, "Unknown command: explode");
    assert.equal(W.command(w, "toString", {}).ok, false);
  });

  test("claimChest / markSeen", () => {
    const { w, h1 } = cmdWorld();
    assert.equal(W.command(w, "claimChest", { heroId: 999 }).error, "No such hero");
    assert.equal(W.command(w, "claimChest", { heroId: h1.id }).error, "No chest waiting");
    h1.pend.push({ min: 20, fmin: 0, title: "t", at: T0, sealFactor: 1 });
    const r = W.command(w, "claimChest", { heroId: h1.id }, T0 + 10000);
    assert.equal(r.ok, true);
    assert.match(r.msg, /^Opened 1 chest: \+.* gold, 2\.0 Seals$/);
    assert.equal(W.command(w, "markSeen", { heroId: h1.id }).msg, "Seen");
    assert.equal(W.command(w, "markSeen", { heroId: "x" }).ok, false);
  });

  test("equip / lock / polish / deprecate", () => {
    const { w, h1 } = cmdWorld();
    const s = w.state;
    const hat = I.rollItem(h1, { ilvl: 1, source: "chest", slot: "hat", rar: 2, state: s });
    s.herd.stash.push(hat);
    assert.equal(W.command(w, "equip", { heroId: h1.id, uid: 99999 }).error, "No such item");
    assert.equal(W.command(w, "equip", { heroId: 999, uid: hat.uid }).error, "No such hero");
    const big = I.rollItem(h1, { ilvl: 80, source: "chest", slot: "boots", state: s });
    s.herd.stash.push(big);
    assert.equal(W.command(w, "equip", { heroId: h1.id, uid: big.uid }).ok, false, "level too low");
    assert.equal(W.command(w, "equip", { heroId: h1.id, uid: hat.uid }).ok, true);
    assert.equal(h1.eq[1], hat);
    assert.equal(W.command(w, "equip", { heroId: h1.id, uid: hat.uid }).error, "Already equipped");
    assert.equal(W.command(w, "lock", { uid: hat.uid }).error, "locked must be true or false");
    assert.equal(W.command(w, "lock", { uid: hat.uid, locked: true }).ok, true);
    assert.ok(hat.flags & I.FLAG_LOCKED);
    assert.equal(W.command(w, "polish", { uid: hat.uid }).ok, false, "no gold");
    s.herd.gold = 1e6;
    s.herd.snip = 1e3;
    const p = W.command(w, "polish", { uid: hat.uid });
    assert.equal(p.ok, true);
    assert.equal(hat.pol, 1);
    assert.equal(W.command(w, "polish", { uid: "nope" }).error, "No such item");
    assert.equal(W.command(w, "deprecate", { uid: hat.uid }).ok, false, "equipped items are not in the stash");
    const d = W.command(w, "deprecate", { uid: big.uid });
    assert.equal(d.ok, true);
    assert.ok(!s.herd.stash.includes(big));
  });

  test("squash / reroll need the CI Forge", () => {
    const { w, h1 } = cmdWorld();
    const s = w.state;
    const three = [0, 1, 2].map(() => I.rollItem(h1, { ilvl: 10, source: "chest", slot: "mug", rar: 1, state: s }));
    s.herd.stash.push(...three);
    assert.equal(W.command(w, "squash", { uids: [1, 2] }).error, "Pick 3 items");
    assert.match(W.command(w, "squash", { uids: three.map((x) => x.uid) }).error, /CI Forge/);
    s.herd.bld[2] = 5;
    s.herd.gold = 1e7;
    s.herd.snip = 1e4;
    const sq = W.command(w, "squash", { uids: three.map((x) => x.uid) });
    assert.equal(sq.ok, true);
    const made = s.herd.stash.at(-1);
    assert.equal(made.rar, 2);
    assert.equal(W.command(w, "reroll", { uid: made.uid, affix: -1 }).error, "No such affix");
    const before = made.aff;
    assert.equal(W.command(w, "reroll", { uid: made.uid, affix: 0 }).ok, true);
    assert.notEqual(made.aff, before);
  });

  test("learn / autoLearn / respec / setClass", () => {
    const { w, h1, h2 } = cmdWorld();
    h1.autoLearn = false;
    h1.L = 12;
    h1.cls = 3;
    h1.sp = [0, 0, 0, 0, 0, 0, 0];
    h1.spFree = 5;
    assert.equal(W.command(w, "learn", { heroId: h1.id, slot: 9 }).error, "No such skill slot");
    assert.equal(W.command(w, "learn", { heroId: h1.id, slot: "ult" }).ok, false);
    assert.equal(W.command(w, "learn", { heroId: h1.id, slot: "main" }).msg, "Rank 1");
    assert.equal(W.command(w, "learn", { heroId: h1.id, slot: 1 }).msg, "Rank 1");
    assert.equal(W.command(w, "autoLearn", { heroId: h1.id, on: "yes" }).ok, false);
    assert.equal(W.command(w, "autoLearn", { heroId: h1.id, on: true }).ok, true);
    assert.equal(h1.spFree, 0);
    const r = W.command(w, "respec", { heroId: h1.id }, T0 + 9000);
    assert.equal(r.ok, false, "a working hero pays 5 x L Snippets");
    w.state.herd.snip = 100;
    assert.equal(W.command(w, "respec", { heroId: h1.id }, T0 + 9000).msg, "Respec: -60 Snippets");
    w.state.herd.snip = 0;
    assert.equal(W.command(w, "respec", { heroId: h2.id }, T0 + 9000).ok, false, "working and no Snippets left");
    w.rt.live.get(h2.id).state = "resting";
    assert.equal(W.command(w, "respec", { heroId: h2.id }, T0 + 9000).msg, "Respec (free)");
    assert.equal(W.command(w, "respec", { heroId: h2.id }, T0 + 10000).ok, false, "free once per 24 h");
    assert.equal(W.command(w, "respec", { heroId: h2.id }, T0 + 9000 + 86400000).msg, "Respec (free)");
    assert.equal(W.command(w, "setClass", { heroId: h1.id, cls: "nope" }).error, "Unknown class");
    assert.equal(W.command(w, "setClass", { heroId: h1.id, cls: "refactorer" }).ok, true);
    assert.equal(h1.cls, 1);
    assert.equal(W.command(w, "setClass", { heroId: 999, cls: 1 }).error, "No such hero");
  });

  test("respec, setClass and autoLearn re-spend points only while auto-learn is on for the herd (and the autopilot master switch)", () => {
    for (const mode of ["on", "learn off", "master off"]) {
      const { w, h1, h2 } = cmdWorld();
      const cfg = w.state.herd.cfg;
      if (mode === "learn off") assert.equal(W.command(w, "setting", { key: "auto.learn", value: false }).ok, true);
      if (mode === "master off") assert.equal(W.command(w, "setting", { key: "auto", value: false }).ok, true);
      assert.equal(autoOn(w.state, "learn"), mode === "on");
      w.state.herd.snip = 1e6;
      const spent = (h) => h.sp.reduce((a, b) => a + b, 0);
      for (const h of [h1, h2]) Object.assign(h, { L: 30, cls: 3, rev: [1, 0], sp: Hr.autoRanks(3, 30, true).slice(), spFree: 0 });
      const total = spent(h1);
      // a paid respec: the person wants to place the points by hand
      assert.equal(W.command(w, "respec", { heroId: h1.id }, T0 + 9000).ok, true, mode);
      assert.equal(spent(h1) + h1.spFree, total, `${mode}: nothing lost`);
      assert.equal(spent(h1), mode === "on" ? total : 0, `${mode}: respec`);
      // a Career Change from Lv 20 (25 x L Snippets)
      assert.equal(W.command(w, "setClass", { heroId: h2.id, cls: "refactorer" }).ok, true, mode);
      assert.equal(spent(h2), mode === "on" ? total : 0, `${mode}: setClass`);
      // the hero's own switch turned back on: the herd's switch still rules
      h1.autoLearn = false;
      const r = W.command(w, "autoLearn", { heroId: h1.id, on: true });
      assert.equal(r.ok, true);
      assert.equal(r.msg, {
        on: "Auto-learn on", "learn off": "Auto-learn on, but it is off for the herd (Settings)", "master off": "Auto-learn on, but the Autopilot is off (Settings)",
      }[mode], `${mode}: the sheet's flash says why nothing was spent`);
      assert.equal(h1.autoLearn, true);
      assert.equal(spent(h1), mode === "on" ? total : 0, `${mode}: autoLearn on`);
      // the points wait for the herd's switch: the next autopilot pass spends them once it is on
      if (mode !== "on") {
        cfg.autopilot = true;
        cfg.auto.learn = true;
        AP.autopilot(w, W.makeEmitter(w));
        assert.equal(spent(h1), total, `${mode}: spent once the switch is back on`);
        assert.equal(spent(h2), total);
      }
    }
  });

  test("pinMap", () => {
    const { w, h1 } = cmdWorld();
    assert.equal(W.command(w, "pinMap", { heroId: h1.id, mapId: "7-7" }).error, "No such map");
    assert.equal(W.command(w, "pinMap", { heroId: h1.id, mapId: "1-2" }).error, "That map is not open yet");
    w.state.herd.quota["1-1"] = 40;
    assert.equal(W.command(w, "pinMap", { heroId: h1.id, mapId: "1-2" }).ok, true);
    assert.equal(h1.pinMap, "1-2");
    assert.equal(w.rt.live.get(h1.id).mapId, "1-2");
    assert.equal(W.command(w, "pinMap", { heroId: h1.id, mapId: null }).msg, "Map: auto");
    assert.equal(h1.pinMap, null);
    assert.equal(w.rt.live.get(h1.id).mapId, "1-1");
    // ids that name Object.prototype members find nothing (null-prototype tables), never a builtin
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      assert.equal(W.command(w, "pinMap", { heroId: h1.id, mapId: id }).error, "No such map", id);
      assert.equal(W.command(w, "setClass", { heroId: h1.id, cls: id }).error, "Unknown class", id);
      for (const table of [D.MAP_BY_ID, D.MOB_BY_ID, D.ZONE_BY_ID, D.BOSS_BY_ID, D.SKILL_BY_ID, D.CLASS_IDX, D.MAP_IDX]) assert.equal(table[id], undefined, id);
    }
  });

  test("challenge / retreat", () => {
    const { w, h1 } = cmdWorld();
    assert.equal(W.command(w, "challenge", { kind: "dragon", idx: 0 }).error, "kind must be boss, review or backlog");
    assert.equal(W.command(w, "challenge", { kind: "boss", idx: 9 }).error, "No such boss");
    w.rt.bossApi = fakeBoss();
    assert.equal(W.command(w, "challenge", { kind: "boss", idx: 1 }).error, "Nobody is working in that zone");
    const r = W.command(w, "challenge", { kind: "boss", idx: 0, heroId: h1.id });
    assert.equal(r.ok, true);
    assert.equal(r.msg, "Challenge: The Ignored Warning");
    assert.equal(w.rt.fights.length, 1);
    assert.equal(w.rt.fights[0].heroIds[0], h1.id, "the clicked hero leads");
    assert.equal(W.command(w, "challenge", { kind: "boss", idx: 0 }).error, "A boss fight is already running");
    assert.equal(W.command(w, "challenge", { kind: "review", idx: 0 }).error, "A review needs a hero");
    assert.equal(W.command(w, "retreat", {}).ok, true);
    assert.equal(w.rt.fights.length, 0);
    assert.equal(W.command(w, "retreat", {}).error, "No fight in progress");
  });

  test("rename hero and herd", () => {
    const { w, h1 } = cmdWorld();
    assert.equal(W.command(w, "rename", { heroId: h1.id, name: "  " }).ok, false);
    assert.equal(W.command(w, "rename", { heroId: h1.id, name: "x".repeat(40) }).ok, false);
    assert.equal(W.command(w, "rename", { heroId: h1.id, name: " Bit\u0007 Flip " }).ok, true);
    assert.equal(h1.name, "Bit Flip");
    assert.equal(W.command(w, "rename", { herd: true, name: "Night Shift" }).ok, true);
    assert.equal(w.state.herd.name, "Night Shift");
    assert.equal(W.command(w, "rename", { heroId: 999, name: "x" }).error, "No such hero");
  });

  test("retire", () => {
    const { w, h1, now, agents } = cmdWorld();
    assert.equal(W.command(w, "retire", { heroId: h1.id }).error, "Retirement needs Lv 30");
    h1.L = 35;
    h1.pend.push({ min: 10, fmin: 0, title: "t", at: T0, sealFactor: 1 });
    const r = W.command(w, "retire", { heroId: h1.id }, now);
    assert.equal(r.ok, true);
    assert.ok(!w.state.heroes.includes(h1));
    assert.equal(w.state.herd.fame.length, 1);
    assert.ok(near(w.state.herd.seals, 1), "its pending chest was claimed in full first");
    assert.ok(!w.rt.live.has(h1.id));
    run(w, now, 2, () => agents);
    assert.ok(w.rt.bind.has("t1"), "the agent plays on with another hero");
    assert.deepEqual(w.rt.errors, []);
  });

  test("retire takes the hero out of a paused boss fight; one nobody is left in ends as a Postmortem", () => {
    const { w, h1, h2, now } = cmdWorld();
    h1.L = 35;
    h2.L = 35;
    const herd = w.state.herd;
    const paused = () => ({ k: "b", i: 2, ids: [h1.id, h2.id], t: 10, ph: 1, p: [[0, 1000, 5000]], m: {}, pool: 5000, dl: 4000, sq: 0, hl: [h2.id] });
    herd.fight = paused();
    assert.equal(W.command(w, "retire", { heroId: h1.id }, now).ok, true);
    assert.deepEqual([herd.fight.ids, herd.fight.hl, herd.fight.n], [[h2.id], [h2.id], 2], "the pool stays sized for two");
    assert.equal(W.command(w, "retire", { heroId: h2.id }, now).ok, true);
    assert.equal(herd.fight, null, "nobody left: closed");
    assert.ok(herd.log.some((e) => e[1] === "boss" && /Postmortem/.test(e[3])), "as a Postmortem");
    assert.ok(herd.wounds["2"][0] > 0, "its Wounds are kept");
    assert.deepEqual(w.rt.errors, []);
  });

  test("retire credits the open task too (it closes into a chest the claim opens)", () => {
    const { w, now } = busyWorld({ heroes: 1, ticks: 300 });
    const h = w.state.heroes[0];
    h.L = 35;
    assert.ok(w.rt.live.get(h.id).task.workSec >= 290);
    const r = W.command(w, "retire", { heroId: h.id }, now);
    assert.equal(r.ok, true);
    assert.ok(near(w.state.herd.seals, 0.5, 0.02), `5 working minutes = 0.5 Seals (got ${w.state.herd.seals})`);
    assert.deepEqual(h.pend, []);
  });

  test("buy", () => {
    const { w } = cmdWorld();
    w.state.herd.born = w.state.herd.day - 6; // the herd's day 7: Campfire 1 is open (balance)
    assert.equal(W.command(w, "buy", { building: "spaceship" }).error, "Unknown building");
    assert.equal(W.command(w, "buy", { building: "campfire" }).error, "Not enough gold");
    w.state.herd.gold = 5000;
    const r = W.command(w, "buy", { building: "campfire" });
    assert.equal(r.ok, true);
    assert.equal(w.state.herd.bld[0], 1);
    assert.equal(W.command(w, "buy", { building: 1 }).ok, true);
  });

  test("setting", () => {
    const { w } = cmdWorld();
    const cfg = w.state.herd.cfg;
    assert.equal(W.command(w, "setting", { key: "calm", value: "on" }).ok, false);
    assert.equal(W.command(w, "setting", { key: "calm", value: true }).ok, true);
    assert.equal(cfg.calm, true);
    assert.equal(W.command(w, "setting", { key: "nums", value: "some" }).ok, false);
    assert.equal(W.command(w, "setting", { key: "nums", value: "crits" }).ok, true);
    assert.equal(cfg.nums, "crits");
    assert.equal(W.command(w, "setting", { key: "stageH", value: 10 }).ok, false);
    assert.equal(W.command(w, "setting", { key: "stageH", value: 120 }).ok, true);
    assert.equal(cfg.stageH, 120);
    assert.equal(W.command(w, "setting", { key: "auto.farm", value: false }).ok, true);
    assert.equal(cfg.auto.farm, false);
    assert.equal(W.command(w, "setting", { key: "auto.teleport", value: false }).ok, false);
    // "auto" is the autopilot master switch (D§11.15): every system stops, the per-system
    // switches keep their values for when it comes back on
    assert.equal(W.command(w, "setting", { key: "auto", value: "no" }).ok, false);
    assert.equal(W.command(w, "setting", { key: "auto", value: false }).ok, true);
    assert.equal(cfg.autopilot, false);
    assert.equal(cfg.auto.farm, false);
    assert.equal(cfg.auto.equip, true);
    assert.equal(autoOn(w.state, "equip"), false);
    assert.equal(W.command(w, "setting", { key: "auto", value: true }).ok, true);
    assert.equal(autoOn(w.state, "equip"), true);
    assert.equal(autoOn(w.state, "farm"), false);
    assert.equal(W.command(w, "setting", { key: "auto", value: false }).ok, true);
    // loot glow minimum rarity: a rarity id or index (D§11.15)
    assert.equal(cfg.glow, 0);
    assert.equal(W.command(w, "setting", { key: "glow", value: "release" }).ok, true);
    assert.equal(cfg.glow, 3);
    assert.equal(W.command(w, "setting", { key: "glow", value: 5 }).ok, true);
    assert.equal(cfg.glow, 5);
    for (const bad of [6, -1, 1.5, "mythic", "constructor", null]) assert.equal(W.command(w, "setting", { key: "glow", value: bad }).ok, false, String(bad));
    // collapse the stage while nothing works, and the host's own "I hid it" note
    assert.equal(cfg.collapse, false);
    assert.equal(W.command(w, "setting", { key: "collapse", value: true }).ok, true);
    assert.equal(W.command(w, "setting", { key: "collapsed", value: true }).ok, true);
    assert.equal(W.command(w, "setting", { key: "collapse", value: 2 }).ok, false);
    assert.deepEqual([cfg.collapse, cfg.collapsed], [true, true]);
    assert.equal(W.command(w, "setting", { key: "notify.lts", value: true }).ok, true);
    assert.equal(cfg.notify.lts, true);
    assert.equal(W.command(w, "setting", { key: "volume", value: 3 }).error, "Unknown setting volume");
    // settings survive a save
    const { world } = W.loadWorld(W.serialize(w), { nowMs: T0 });
    assert.deepEqual(world.state.herd.cfg, cfg);
  });
});
