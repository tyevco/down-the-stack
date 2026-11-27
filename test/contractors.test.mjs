// Round 5 (owner decision: "save a slim Contractor record"): a Contractor is kept as a slim record
// (save.js "ct": its number, seat, level, XP, class, place in the hiring line, the game day it was
// last seen and a tag of its terminal's address), so an app closed across the 04:00 game day brings
// a waiting Contractor back as itself and promotes it at its level. After a load the records hold
// their hires for a short reconnect window; they are dropped after 7 game days unclaimed and capped
// at the roster's size; a read-only world neither claims nor writes them.
// Driven through world.tick with scripted snapshots and world.serialize / loadWorld, the way the
// host drives a restart (the agents' terminals outlive the app: herdr's core keeps them).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as D from "../mods/down-the-stack/game/data.js";
import * as Hr from "../mods/down-the-stack/game/heroes.js";
import * as W from "../mods/down-the-stack/game/world.js";
import * as A from "../mods/down-the-stack/game/agents.js";
import * as V from "../mods/down-the-stack/game/view.js";
import { crc32, decodeState, encodeState, saveSize } from "../mods/down-the-stack/game/save.js";

const T0 = 1_790_000_000_000;
const DAY = 86400000;
const MIN = 60000;
// 30 s before a 04:00 game day turn (tz 0)
const beforeTurn = () => (W.localDay(T0, 0) + 1) * DAY + 4 * 3600000 - 30000;

const prog = (key = "claude") => ({ key, name: key, icon: null, tint: false, tile: null, color: null });
function ag(addr, status, extra = {}) {
  return Object.assign({
    address: addr, status, seq: 1, app: "claude", program: prog(), title: "Fix the flaky test",
    space: "s1", space_name: "herdr-app", tab: "tb1", tab_index: 1, tab_name: "main", pane: `p${addr}`,
    pane_name: null, pinned: false, focused: false,
  }, extra);
}

// the scripted herdr of test/agents.test.mjs: seq moves when the status word changes
class Sim {
  constructor({ seed = 3, world = null, now = T0 } = {}) {
    this.w = world || W.createWorld({ nowMs: now, seed });
    this.now = now;
    this.agents = new Map();
  }
  set(addr, status, extra = {}) {
    const a = this.agents.get(addr);
    if (!a) this.agents.set(addr, ag(addr, status, extra));
    else {
      if (a.status !== status) { a.seq++; a.status = status; }
      Object.assign(a, extra);
    }
    return this;
  }
  drop(addr) { this.agents.delete(addr); return this; }
  snap() {
    return {
      nowMs: this.now, tzOffsetMin: 0, weekday: 2, windowActive: true, focusedTerminal: null,
      agents: Array.from(this.agents.values()).map((a) => Object.assign({}, a)), subagents: [], tabs: {}, spaces: [],
    };
  }
  tick(n = 1) {
    for (let i = 0; i < n; i++) {
      this.now += 1000;
      W.tick(this.w, this.snap());
    }
    return this;
  }
  jump(ms) { this.now += ms; W.tick(this.w, this.snap()); return this; }
  id(addr) { return this.w.rt.bind.get(addr); }
  hero(addr) { return A.heroById(this.w, this.id(addr)); }
  get state() { return this.w.state; }
}
const noErrors = (sim) => assert.deepEqual(sim.w.rt.errors, []);

/** The app closes now (its last save) and starts again `afterMs` later with the same terminals. */
function restart(sim, afterMs, { agents = null } = {}) {
  const text = W.serialize(sim.w);
  const now = sim.now + afterMs;
  const { world } = W.loadWorld(text, { nowMs: now });
  const sim2 = new Sim({ world, now });
  for (const [k, a] of agents || sim.agents) sim2.agents.set(k, Object.assign({}, a));
  return { sim2, text };
}

// what the stage, the party and the sheet draw for a terminal's hero: hoodie and hat colours
function looks(sim, addr) {
  const id = sim.id(addr);
  const st = V.stageView(sim.w, { width: 3200, nowMs: sim.now }).heroes.find((h) => h.address === addr);
  const row = V.partyView(sim.w, { width: 268, nowMs: sim.now }).groups.flatMap((g) => g.rows).find((r) => r.address === addr);
  const rig = V.sheetView(sim.w, { heroId: id, nowMs: sim.now }).header.rig;
  return { stage: [st.colors.hoodie, st.hat ? st.hat.color : null], party: row.colors.hoodie, sheet: [rig.colors.hoodie, rig.hat ? rig.hat.color : null] };
}

// heroes of the roster off duty since yesterday at Lv 12 (never let go to make room)
function bench(sim, n, seat = "old/agent") {
  for (let i = 0; i < n; i++) {
    const h = Hr.newHero(sim.state, { seat, ord: i, nowMs: T0 - DAY });
    h.L = 12;
    sim.state.heroes.push(h);
  }
}

describe("round 5: a Contractor comes back as itself after a restart", () => {
  test("an app closed across 04:00: the waiting Contractor is promoted at its level, with its name, XP, class and look", () => {
    const sim = new Sim({ now: beforeTurn() - 20 * MIN });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle", { space: `s${i + 2}`, space_name: `pr-review-eng-${i}` });
    sim.tick();
    sim.set("c1", "working", { space: "s9", space_name: "rnd-qa" }).tick(30);
    const c = sim.hero("c1");
    assert.ok(c.contractor && c.id < 0, "the 7th agent of the day plays as a Contractor");
    // it levelled meanwhile and found its class
    c.L = 23; c.xp = 4567.8; c.cls = D.CLASS_IDX.hotfixer; c.sp = Hr.autoRanks(c.cls, 23, true);
    assert.equal(A.hireOutlook(sim.w, c).when, "day");
    sim.tick(60); // it fights on
    const was = { name: c.name, id: c.id, xp: Math.floor(c.xp), look: looks(sim, "c1") };
    assert.ok(was.xp > 4567);
    // the app closes before 04:00 and opens ten minutes after it: a new game day
    const { sim2, text } = restart(sim, beforeTurn() + 10 * MIN - sim.now);
    assert.ok(JSON.parse(text).herd.ct, "the save holds its record");
    sim2.tick();
    const h = sim2.hero("c1");
    assert.ok(h && !h.contractor && h.id > 0, "promoted at once: hiring reopened at 04:00");
    assert.equal(h.name, was.name);
    assert.equal(h.L, 23, "at its level, not a new Lv 1 hire");
    assert.equal(h.xp, was.xp, "its XP (to the whole point)");
    assert.equal(h.cls, D.CLASS_IDX.hotfixer);
    assert.equal(h.addr, "c1");
    assert.deepEqual(looks(sim2, "c1"), was.look, "the same hoodie and hat");
    assert.equal(h.look, Hr.lookOf({ id: was.id }), "its look is saved with it as for any promotion");
    const W2 = sim2.w.state;
    assert.equal(A.hiredToday(W2), 1);
    assert.equal(W2.heroes.length, 7);
    const line = W2.herd.log.find((e) => e[1] === "hired" && e[2] === h.id);
    assert.equal(line[3], `Hired: ${was.name} (was a contractor)`);
    assert.equal(line[4], 23, "hired at its level");
    assert.ok(!W2.herd.log.some((e) => e[1] === "hire" && e[0] > sim.now), "no Lv 1 hire after the restart");
    assert.deepEqual(W2.herd.contractors, [], "its record is spent");
    assert.equal(JSON.parse(W.serialize(sim2.w)).herd.ct, undefined, "and gone from the save");
    // and after another restart it is a saved hero like any other
    const { sim2: sim3 } = restart(sim2, 5 * MIN);
    sim3.tick();
    assert.equal(sim3.hero("c1").id, h.id);
    assert.deepEqual(looks(sim3, "c1"), was.look);
    noErrors(sim2);
    noErrors(sim3);
  });

  test("a hot reload or a restart on the same game day: the Contractor carries on as itself, its place in line kept", () => {
    const sim = new Sim({ now: T0 });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle");
    sim.tick();
    sim.set("c1", "working").tick(5);
    sim.set("c2", "working").tick(5);
    const [c1, c2] = [sim.hero("c1"), sim.hero("c2")];
    c1.L = 9; c1.xp = 77; c2.L = 4;
    // an Intern keeps its signature window: its class at Lv 10 comes from it (D§4.2)
    c1.sig = { tm: [3, 4, 2, 3], tb: [0, 0, 0, 0], ts: [0, 0, 0, 0], blocks: 0, workMin: 12, subTasks: 0, n: 4 };
    const before = [A.hireOutlook(sim.w, c1).position, A.hireOutlook(sim.w, c2).position];
    assert.deepEqual(before, [0, 1]);
    // the listing after the reload has c2 first
    const order = new Map([["c2", sim.agents.get("c2")], ["c1", sim.agents.get("c1")]]);
    for (const [k, a] of sim.agents) if (k[0] === "h") order.set(k, a);
    const { sim2 } = restart(sim, 2000, { agents: order });
    sim2.tick();
    const [r1, r2] = [sim2.hero("c1"), sim2.hero("c2")];
    assert.ok(r1.contractor && r2.contractor, "no hires left today: still Contractors");
    assert.deepEqual([r1.id, r1.name, r1.L, r1.xp, r2.id, r2.name, r2.L], [c1.id, c1.name, 9, 77, c2.id, c2.name, 4]);
    assert.deepEqual(r1.sig.tm, [3, 4, 2, 3], "the Intern's signature window");
    assert.deepEqual([A.hireOutlook(sim2.w, r1).position, A.hireOutlook(sim2.w, r2).position], [0, 1], "the longest-running is still first in line");
    assert.ok(Math.abs(r1.since - c1.since) <= 30000, "its place in line, to the minute");
    // a new Contractor is numbered after them (its default name, hoodie and hat are its own)
    sim2.set("c3", "working", { space: "s7", space_name: "docs" }).tick();
    assert.ok(sim2.hero("c3").id < Math.min(r1.id, r2.id));
    noErrors(sim2);
  });

  test("two Contractors in one seat: each terminal takes back its own; new terminals take the higher level first", () => {
    const sim = new Sim({ now: T0 });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle", { space: `s${i + 2}`, space_name: `infra-${i}` });
    sim.tick();
    sim.set("a1", "working", { space: "s1", space_name: "mobile-qa" }).tick();
    sim.set("a2", "working", { space: "s1", space_name: "mobile-qa" }).tick();
    const [c1, c2] = [sim.hero("a1"), sim.hero("a2")];
    assert.equal(c1.seat, c2.seat, "one seat");
    c1.L = 14; c2.L = 20;
    // the same terminals come back, listed the other way round
    const order = new Map([["a2", sim.agents.get("a2")], ["a1", sim.agents.get("a1")]]);
    for (const [k, a] of sim.agents) if (k[0] === "h") order.set(k, a);
    const { sim2 } = restart(sim, 3000, { agents: order });
    sim2.tick();
    assert.deepEqual([sim2.hero("a1").name, sim2.hero("a1").L], [c1.name, 14], "a1 is its own Contractor (by its terminal)");
    assert.deepEqual([sim2.hero("a2").name, sim2.hero("a2").L], [c2.name, 20]);
    // herdr gives both agents new terminals (its core restarted): by seat, the higher level first
    const fresh = new Map();
    for (const [k, a] of sim2.agents) if (k[0] === "h") fresh.set(k, a);
    fresh.set("n1", ag("n1", "working", { space: "s1", space_name: "mobile-qa" }));
    fresh.set("n2", ag("n2", "working", { space: "s1", space_name: "mobile-qa" }));
    const { sim2: sim3 } = restart(sim2, 3000, { agents: fresh });
    sim3.tick();
    assert.deepEqual([sim3.hero("n1").name, sim3.hero("n1").L], [c2.name, 20], "the first listed takes the Lv 20 record");
    assert.deepEqual([sim3.hero("n2").name, sim3.hero("n2").L], [c1.name, 14]);
    assert.equal(sim3.w.rt.contractors.size, 2);
    assert.deepEqual(sim3.state.herd.contractors, []);
    noErrors(sim3);
  });

  test("a saved hero of the seat comes first: a terminal plays it, and the Contractor's record waits", () => {
    const sim = new Sim({ now: T0 });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle", { space: `s${i + 2}`, space_name: `docs-${i}` });
    sim.tick();
    sim.set("c1", "working", { space: "s2", space_name: "docs-0" }).tick(); // h0's seat
    const c = sim.hero("c1");
    assert.ok(c.contractor);
    sim.drop("h0").drop("c1").tick();
    assert.equal(sim.state.herd.contractors.length, 1, "its terminal ended: kept as a record");
    sim.set("x1", "working", { space: "s2", space_name: "docs-0" }).tick();
    assert.ok(!sim.hero("x1").contractor, "D§3.2: the seat's free saved hero");
    assert.equal(sim.state.herd.contractors.length, 1, "the record waits");
    sim.set("x2", "working", { space: "s2", space_name: "docs-0" }).tick();
    assert.equal(sim.hero("x2").name, c.name, "the next terminal of the seat is the Contractor again");
    assert.equal(sim.hero("x2").id, c.id);
    assert.deepEqual(sim.state.herd.contractors, []);
    noErrors(sim);
  });
});

describe("round 5: after a load, a newcomer never takes a returning Contractor's hire", () => {
  // a full day of hires used; 29 heroes on the roster; c1 waits as a Contractor for the 30th slot
  function waiting() {
    const sim = new Sim({ now: beforeTurn() - 20 * MIN });
    sim.tick();
    bench(sim, 29);
    sim.state.herd.hired = [sim.state.herd.day, 6];
    sim.set("c1", "working", { space: "s5", space_name: "ceo-assistant-res-2" }).tick(30);
    const c = sim.hero("c1");
    assert.ok(c.contractor);
    c.L = 31; c.xp = 1200; c.cls = D.CLASS_IDX.refactorer; c.rev = [1, 0];
    return { sim, c };
  }

  test("a newcomer listed before the returning Contractor does not take its hire", () => {
    const { sim, c } = waiting();
    // the app opens after 04:00 (six hires, one free slot); herdr lists a newcomer first and c1's
    // terminal three snapshots later
    const { sim2 } = restart(sim, 30 * MIN, { agents: new Map() });
    sim2.set("n1", "working", { program: prog("codex"), app: "codex", space: "s8", space_name: "rnd-qa" }).tick();
    const n1 = sim2.hero("n1");
    assert.ok(n1.contractor, "the newcomer waits: the slot is held for the Contractor the save holds");
    assert.equal(sim2.state.heroes.length, 29);
    const o = A.hireOutlook(sim2.w, n1);
    assert.equal(o.when, "reconnect");
    assert.equal(o.held, 1);
    assert.match(o.text, /^Hired in about 60 s, unless a contractor from before the restart comes back first · 1 ahead in line \(today: 6 of 6 hires left\)$/);
    sim2.tick(2);
    assert.ok(sim2.hero("n1").contractor);
    sim2.set("c1", "working", { space: "s5", space_name: "ceo-assistant-res-2" }).tick();
    const h = sim2.hero("c1");
    assert.ok(h && !h.contractor && h.id > 0, "the Contractor is hired as soon as it is listed");
    assert.deepEqual([h.name, h.L, h.xp, h.cls], [c.name, 31, 1200, D.CLASS_IDX.refactorer]);
    assert.deepEqual(h.rev, [1, 0], "its review record");
    assert.equal(Hr.careerOf(h).title, Hr.careerOf(c).title);
    assert.ok(sim2.hero("n1").contractor, "the roster is full: the newcomer waits for a slot");
    assert.equal(A.hireOutlook(sim2.w, sim2.hero("n1")).when, "slot");
    assert.equal(sim2.state.heroes.length, 30);
    assert.ok(!sim2.state.herd.log.some((e) => e[1] === "hire"), "no Lv 1 hire");
    noErrors(sim2);
  });

  test("in one snapshot too: a newcomer listed first stands behind the Contractor it lists after it", () => {
    const { sim, c } = waiting();
    const order = new Map([["n1", ag("n1", "working", { program: prog("codex"), app: "codex", space: "s8", space_name: "rnd-qa" })], ["c1", sim.agents.get("c1")]]);
    const { sim2 } = restart(sim, 30 * MIN, { agents: order });
    // past the reconnect window: only the snapshot's own order matters
    if (sim2.w.rt.recWait) sim2.w.rt.recWait.clear();
    sim2.tick();
    assert.equal(sim2.hero("c1").name, c.name);
    assert.ok(!sim2.hero("c1").contractor, "the Contractor takes the slot");
    assert.ok(sim2.hero("n1").contractor);
    noErrors(sim2);
  });

  test("in one snapshot, a newcomer listed after every returning Contractor does not take its hire either", () => {
    // every record is claimed by a terminal listed before the newcomer: none is held when the
    // newcomer binds, so it must stand behind the Contractors back from their records (step 2b)
    for (const clearWait of [false, true]) {
      const { sim, c } = waiting();
      const order = new Map([["c1", sim.agents.get("c1")], ["n1", ag("n1", "working", { program: prog("codex"), app: "codex", space: "s8", space_name: "rnd-qa" })]]);
      const { sim2 } = restart(sim, 30 * MIN, { agents: order });
      if (clearWait) sim2.w.rt.recWait.clear();
      sim2.tick();
      const h = sim2.hero("c1");
      assert.ok(h && !h.contractor && h.id > 0, "the Contractor takes the last slot");
      assert.deepEqual([h.name, h.L], [c.name, 31]);
      assert.ok(sim2.hero("n1").contractor, "the newcomer waits for a slot");
      assert.equal(sim2.state.heroes.length, 30);
      assert.ok(!sim2.state.herd.log.some((e) => e[1] === "hire"), "no Lv 1 hire");
      noErrors(sim2);
    }
  });

  test("a record whose agent never returns: its hire waits out the reconnect window, then goes to the next in line; the record stays for 7 game days", () => {
    const { sim, c } = waiting();
    const { sim2 } = restart(sim, 30 * MIN, { agents: new Map() });
    sim2.set("n1", "working", { program: prog("codex"), app: "codex", space: "s8", space_name: "rnd-qa" }).tick();
    const n1 = sim2.hero("n1");
    const opened = sim2.w.rt.startMs;
    assert.ok(n1.contractor);
    while (sim2.now < opened + 59000) sim2.tick();
    assert.ok(n1.contractor, "held for the whole window (60 s)");
    assert.match(A.hireOutlook(sim2.w, n1).text, /^Hired in about 1 s, unless/);
    while (sim2.now < opened + 61000) sim2.tick();
    assert.ok(!n1.contractor && n1.id > 0, "the window ends: the next in line is hired");
    assert.equal(A.hiredToday(sim2.state), 1);
    // the absent Contractor is still remembered (off duty), and named in the Roster's count
    assert.deepEqual(sim2.state.herd.contractors.map((r) => [r.seq, r.L]), [[-c.id, 31]]);
    const roster = V.herdView(sim2.w, { tab: "roster", nowMs: sim2.now }).roster;
    assert.match(roster.count, /· 1 contractor off duty$/);
    // its agent comes back four game days later: the same Contractor (the roster is full: it waits)
    const { sim2: sim3 } = restart(sim2, 4 * DAY, { agents: sim2.agents });
    sim3.set("c1", "working", { space: "s5", space_name: "ceo-assistant-res-2" }).tick();
    const back = sim3.hero("c1");
    assert.ok(back.contractor);
    assert.deepEqual([back.name, back.L, back.id], [c.name, 31, c.id]);
    sim3.drop("c1").tick();
    assert.equal(sim3.state.herd.contractors.length, 1, "kept again when its terminal ends");
    // seven game days without its agent: dropped
    for (let d = 1; d <= 6; d++) sim3.jump(DAY);
    assert.equal(sim3.state.herd.contractors.length, 1, "still kept on the 6th game day");
    sim3.jump(DAY);
    assert.deepEqual(sim3.state.herd.contractors, [], "dropped on the 7th");
    assert.equal(JSON.parse(W.serialize(sim3.w)).herd.ct, undefined);
    noErrors(sim2);
    noErrors(sim3);
  });
});

describe("round 5: the records are bounded, slim, and never written by a read-only world", () => {
  test("records expire after 7 game days and are capped at the roster's size, live Contractors first, the oldest unclaimed going first", () => {
    const sim = new Sim({ now: T0 });
    sim.tick();
    bench(sim, 24); // with the day's six hires a full roster of Lv 10+: the Contractors stay
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle");
    sim.tick();
    for (let i = 0; i < 3; i++) sim.set(`c${i}`, "working", { space: `s${i + 10}`, space_name: `live-${i}` }).tick();
    assert.equal(sim.w.rt.contractors.size, 3);
    const day = sim.state.herd.day;
    // 30 records of agents away, last seen 0..6 game days ago (numbered after the live ones)
    const recs = [];
    for (let k = 0; k < 30; k++) {
      recs.push({ seq: 100 + k, seat: `away-${k}/claude`, L: 10 + k, xp: 5, cls: 3, prov: 0, rev: [0, 0], since: T0 - k * MIN, day: day - (k % 7), tag: "" });
    }
    sim.state.herd.contractors = recs.slice();
    sim.tick();
    const kept = sim.state.herd.contractors;
    assert.equal(kept.length, 27, "30 in all with the 3 live ones");
    const dropped = recs.filter((r) => !kept.includes(r)).map((r) => r.seq);
    assert.deepEqual(dropped.sort(), [106, 113, 120], "the least recently seen (6 days ago), lowest numbers first");
    const saved = JSON.parse(W.serialize(sim.w)).herd.ct;
    assert.equal(saved.length, 30);
    assert.deepEqual(saved.slice(0, 3).map((r) => r[0]), [1, 2, 3], "the live Contractors first, in hiring order");
    // 7 game days on, the records seen 0 days ago are 7 days old: all gone, the live ones stay
    for (let d = 0; d < 7; d++) sim.jump(DAY);
    assert.deepEqual(sim.state.herd.contractors, []);
    assert.equal(JSON.parse(W.serialize(sim.w)).herd.ct.length, 3, "live Contractors are always written");
    noErrors(sim);
  });

  test("a read-only world (a newer save) never claims or writes a record", () => {
    const sim = new Sim({ now: T0 });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle");
    sim.tick();
    sim.set("c1", "working").tick(3);
    const c = sim.hero("c1");
    c.L = 17;
    const raw = JSON.parse(W.serialize(sim.w));
    assert.equal(raw.herd.ct.length, 1);
    raw.v = 2;
    raw.crc = "";
    const t0 = JSON.stringify(raw);
    const text = t0.replace('"crc":""', `"crc":"${crc32(t0)}"`);
    const { world } = W.loadWorld(text, { nowMs: sim.now + 5000 });
    assert.equal(world.rt.readOnly, true);
    const sim2 = new Sim({ world, now: sim.now + 5000 });
    for (const [k, a] of sim.agents) sim2.agents.set(k, Object.assign({}, a));
    sim2.tick(3);
    const shown = sim2.hero("c1");
    assert.ok(shown.contractor, "c1 plays for display only");
    assert.notEqual(shown.L, 17, "its record is not claimed on a read-only world");
    assert.equal(A.hireOutlook(sim2.w, shown).when, "never");
    assert.deepEqual(world.state.herd.contractors.map((r) => r.L), [17], "the loaded record is left as it was");
    sim2.drop("c1").tick();
    assert.equal(world.state.herd.contractors.length, 1, "no record kept for a display-only Contractor");
    const again = JSON.parse(W.serialize(world));
    assert.deepEqual(again.herd.ct, raw.herd.ct, "what it would write holds the loaded records only");
    noErrors(sim2);
  });

  test("save size: about 40-60 bytes a record (seat in the string table or inline); an Intern's signature adds its window", (t) => {
    const sim = new Sim({ now: T0 });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle", { space: `s${i}`, space_name: ["ceo-assistant-res-2", "pr-review-eng-1", "rnd-qa", "mobile-qa", "docs", "infra"][i] });
    sim.tick();
    const plain = W.serialize(sim.w);
    const herdDay = sim.state.herd.day;
    const rec = (k, seat, extra = {}) => Object.assign({
      seq: 41 + k, seat, L: 45 + k, xp: 312345 + k, cls: 3, prov: 0, rev: [1, 0], since: sim.now - 3 * DAY + k * 60000, day: herdDay, tag: (100000 + k * 7919).toString(36),
    }, extra);
    const bytesFor = (list) => {
      const w = sim.w;
      const keep = w.state.herd.contractors;
      w.state.herd.contractors = list;
      const t = W.serialize(w);
      w.state.herd.contractors = keep;
      return (saveSize(t).bytes - saveSize(plain).bytes) / list.length;
    };
    // seats a saved hero has too (the usual case: the space's first agent was hired)
    const shared = bytesFor(Array.from({ length: 10 }, (_, k) => rec(k, ["ceo-assistant-res-2/claude", "rnd-qa/claude"][k % 2])));
    // seats of their own (a space whose every agent is a Contractor), as long as the owner's spaces
    const own = bytesFor(Array.from({ length: 10 }, (_, k) => rec(k, `ceo-assistant-res-${k}/claude`)));
    assert.ok(shared <= 42, `${shared} B a record with a shared seat`);
    assert.ok(own <= 62, `${own} B a record with a seat of its own`);
    // an Intern (its class comes from its signature at Lv 10) writes its window, 3 characters a task
    const sig = { tm: Array.from({ length: 20 }, (_, k) => 4 + k), tb: new Array(20).fill(0), ts: new Array(20).fill(0), blocks: 0, workMin: 0, subTasks: 0, n: 20 };
    sig.workMin = sig.tm.reduce((a, b) => a + b, 0);
    const intern = bytesFor([rec(0, "rnd-qa/claude", { L: 8, cls: 0, rev: [0, 0], sig })]);
    assert.ok(intern <= 130, `${intern} B for an Intern with 20 tasks`);
    // and every record round-trips (encode -> decode -> encode is byte-identical)
    sim.state.herd.contractors = [rec(0, "rnd-qa/claude"), rec(1, "a/b", { L: 8, cls: 0, rev: [0, 0], sig, day: herdDay - 3 })];
    const text = encodeState(sim.state);
    const back = decodeState(text).state;
    assert.equal(encodeState(back), text);
    assert.deepEqual(back.herd.contractors[1].sig.tm, sig.tm);
    assert.equal(back.herd.contractors[1].day, herdDay - 3);
    assert.equal(back.herd.contractors[0].xp, 312345);
    t.diagnostic(`a record: ${shared} B with a shared seat, ${own} B with a seat of its own, ${intern} B for an Intern with 20 tasks`);
  });

  test("a save written with records (test/fixtures/saves/r5-contractors.json) brings its Contractors back", () => {
    const text = fs.readFileSync(new URL("./fixtures/saves/r5-contractors.json", import.meta.url), "utf8");
    const { world, warning } = W.loadWorld(text, { nowMs: JSON.parse(text).lastMs + 60000 });
    assert.equal(warning, null);
    const recs = world.state.herd.contractors;
    assert.deepEqual(recs.map((r) => [r.seq, r.seat, r.L, r.cls]), [[1, "rnd-qa/claude", 27, 2], [2, "mobile-qa/claude", 8, 0], [3, "ceo-assistant-res-2/claude", 33, 4]]);
    assert.deepEqual(recs[1].sig.tm, [3, 4.5, 2, 6], "the Intern's signature window");
    assert.deepEqual(recs[2].rev, [1, 0]);
    assert.equal(world.rt.contractorSeq, 3);
    assert.equal(encodeState(decodeState(text).state), text, "it round-trips byte for byte");
    // its two live agents come back (same terminals), on the same game day: Contractors again
    const sim = new Sim({ world, now: JSON.parse(text).lastMs + 60000 });
    sim.set("r5c1", "working", { space: "s_r5a", space_name: "rnd-qa" }).set("r5c2", "working", { space: "s_r5b", space_name: "mobile-qa" }).tick();
    assert.deepEqual([sim.hero("r5c1").id, sim.hero("r5c1").L, sim.hero("r5c2").id, sim.hero("r5c2").L], [-1, 27, -2, 8]);
    assert.deepEqual(world.state.herd.contractors.map((r) => r.seq), [3], "the third waits for its agent");
    noErrors(sim);
  });

  test("a save from before the records loads with none, and saves as it did", () => {
    const sim = new Sim({ now: T0 });
    for (let i = 0; i < 3; i++) sim.set(`h${i}`, "idle");
    sim.tick(2);
    const text = W.serialize(sim.w);
    assert.ok(!text.includes('"ct"'), "nothing written without Contractors");
    const { world } = W.loadWorld(text, { nowMs: sim.now });
    assert.deepEqual(world.state.herd.contractors, []);
    assert.equal(world.rt.contractorSeq, 0);
    assert.equal(W.serialize(world), text);
  });
});
