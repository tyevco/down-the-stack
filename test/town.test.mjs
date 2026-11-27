// Localhost, the town, round 1: "The Review Desk opens" (docs/TOWN.md §2-§6, §8, §9, §12).
// The duty rule state by state; rule 3 across the 04:00 turn and an offline gap; pro rata sharing;
// the shelf's cap; LGTMs on chests opened with full value (+10% XP and gold, never Seals or items);
// the demand-gated Review Desk; ranks; Contractors (no job, but their chests are LGTM'd, and a
// promoted one keeps today's seen work); a read-only world; the Digest line and the Hall of Fame;
// determinism and hot reload. Driven through the engine's own calls (world.tick with scripted
// snapshots where time matters).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as D from "../mods/down-the-stack/game/data.js";
import * as W from "../mods/down-the-stack/game/world.js";
import * as A from "../mods/down-the-stack/game/agents.js";
import * as Hd from "../mods/down-the-stack/game/herd.js";
import * as AP from "../mods/down-the-stack/game/autopilot.js";
import * as TW from "../mods/down-the-stack/game/town.js";
import { makeWorld, makeEv } from "./helpers/engine.mjs";
import { seedTown } from "./helpers/town.mjs";

const T = D.TUNING;
const T0 = 1_790_000_000_000;
const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
// 30 s before a 04:00 game-day turn (tz 0)
const beforeTurn = () => (W.localDay(T0, 0) + 1) * DAY + 4 * HOUR - 30000;

const prog = (key = "claude") => ({ key, name: key, icon: null, tint: false, tile: null, color: null });
function ag(addr, status, extra = {}) {
  return Object.assign({
    address: addr, status, seq: 1, app: "claude", program: prog(), title: "Fix the flaky test",
    space: "s1", space_name: "herdr-app", tab: "tb1", tab_index: 1, tab_name: "main", pane: `p${addr}`,
    pane_name: null, pinned: false, focused: false,
  }, extra);
}

// a scripted herdr (test/contractors.test.mjs): seq moves when the status word changes
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
  snap() {
    return {
      nowMs: this.now, tzOffsetMin: 0, weekday: 2, windowActive: true, focusedTerminal: null,
      agents: Array.from(this.agents.values()).map((a) => Object.assign({}, a)), subagents: [], tabs: {}, spaces: [],
    };
  }
  tick(n = 1) {
    for (let i = 0; i < n; i++) { this.now += 1000; W.tick(this.w, this.snap()); }
    return this;
  }
  jump(ms) { this.now += ms; W.tick(this.w, this.snap()); return this; }
  id(addr) { return this.w.rt.bind.get(addr); }
  hero(addr) { return A.heroById(this.w, this.id(addr)); }
  get state() { return this.w.state; }
  get town() { return this.w.state.herd.town; }
  // a task of `sec` working seconds, done, then idle: the person saw it (D§2.4 rule 1)
  ship(addr, sec = 240) {
    this.set(addr, "working").tick(sec).set(addr, "done").tick(10).set(addr, "idle").tick(2);
    return this;
  }
}

/** The app closes now and starts `afterMs` later with the same terminals (herdr's core kept them). */
function restart(sim, afterMs) {
  const text = W.serialize(sim.w);
  const now = sim.now + afterMs;
  const { world } = W.loadWorld(text, { nowMs: now });
  const s2 = new Sim({ world, now });
  for (const [k, a] of sim.agents) s2.agents.set(k, Object.assign({}, a));
  return s2;
}

// a resting Lv 12 hero that has seen work today, the Review Desk at level 1
function dutyWorld(spec = {}) {
  const w = makeWorld({ heroes: [Object.assign({ L: 12, cls: "shellmancer", state: "resting" }, spec)], herd: { day: 20000, gold: 0 } });
  seedTown(w, { rd: 1 });
  return { w, hero: w.state.heroes[0], live: w.rt.live.get(w.state.heroes[0].id) };
}

describe("data: T.town and TOWN (docs/TOWN.md §9)", () => {
  test("round 1's numbers", () => {
    const t = T.town;
    assert.equal(t.on, true);
    assert.equal(t.minLevel, 10);
    assert.equal(t.gateDays, 1);
    assert.equal(t.perHour, 1);
    assert.deepEqual(t.rankAt, [0, 25, 100, 300, 1000]);
    assert.equal(t.rankRate, 0.2);
    assert.equal(t.shelfPerLevel, 10);
    assert.equal(t.lgtmBonus, 0.1, "owner decision 13.4: +10%");
    assert.deepEqual([t.desk.base, t.desk.mult, t.desk.max], [1000, 2, 10]);
    assert.deepEqual(t.uptimeAt, [100, 500, 2500, 12500, 62500]);
    assert.deepEqual(D.TOWN.ranks.map((r) => r.name), ["Drive-by", "Contributor", "Committer", "Maintainer", "Core"]);
    assert.deepEqual(D.TOWN.stations.map((s) => [s.id, s.post]), [["campfire", 1], ["review_desk", 2], ["docs_library", 3]]);
    assert.equal(Object.getPrototypeOf(D.STATION_BY_ID), null, "a lookup table is a null-prototype map");
    assert.equal(D.STATION_BY_ID.constructor, undefined);
    // BUILDINGS keep their six entries: the Review Desk's level lives in herd.town (TOWN.md §8)
    assert.equal(D.BUILDINGS.length, 6);
    assert.ok(!D.BUILDINGS.some((b) => b.id === "review_desk"));
  });

  test("the Review Desk costs 1,000 gold x2 a level: 1,023,000 for all ten", () => {
    assert.deepEqual([1, 2, 3, 10].map(TW.deskCost), [1000, 2000, 4000, 512000]);
    let sum = 0;
    for (let n = 1; n <= 10; n++) sum += TW.deskCost(n);
    assert.equal(sum, 1023000);
  });
});

describe("the duty rule, state by state (TOWN.md §2.1)", () => {
  test("shipped, resting and off duty (no terminal, the app closed) are on duty; questing, crashed, supervising and waiting fight or wait", () => {
    const { w, hero, live } = dutyWorld();
    const at = (state) => { live.state = state; return TW.onDuty(w, hero); };
    assert.equal(at("resting"), true);
    assert.equal(at("shipped"), true);
    for (const s of ["questing", "crashed", "supervising", "waiting"]) assert.equal(at(s), false, s);
    w.rt.live.delete(hero.id);
    assert.equal(TW.onDuty(w, hero), true, "off duty: its terminal is gone");
    assert.equal(TW.onDuty(w, hero, null), true);
  });

  test("Lv 10 or more; never a Contractor; a seen chest today or yesterday; the Review Desk built; not read-only; the clock not behind", () => {
    const { w, hero } = dutyWorld();
    assert.equal(TW.onDuty(w, hero), true);
    hero.L = 9;
    assert.equal(TW.onDuty(w, hero), false, "Lv 9: an Intern rests at the campfire");
    assert.equal(TW.stationOf(w, hero).reason, "intern");
    hero.L = 10;
    assert.equal(TW.onDuty(w, hero), true, "Lv 10, Junior: a job");
    hero.st.tw[1] = w.state.herd.day - 1;
    assert.equal(TW.onDuty(w, hero), true, "seen work yesterday");
    assert.equal(TW.seenDays(w.state, hero), 1);
    hero.st.tw[1] = w.state.herd.day - 2;
    assert.equal(TW.onDuty(w, hero), false, "two game days ago: rule 3 lapsed");
    assert.equal(TW.seenDays(w.state, hero), null);
    assert.deepEqual(TW.stationOf(w, hero), { id: "campfire", name: "Campfire", noun: null, reason: "unseen" });
    hero.st.tw = [5];
    assert.equal(TW.onDuty(w, hero), false, "no chest ever seen");
    hero.st.tw = [5, w.state.herd.day];
    assert.equal(TW.stationOf(w, hero).id, "review_desk");
    w.state.herd.town.rd = 0;
    assert.equal(TW.onDuty(w, hero), false, "no Review Desk: nobody is on duty");
    assert.equal(TW.stationOf(w, hero).reason, "closed");
    w.state.herd.town.rd = 1;
    w.rt.readOnly = true;
    assert.equal(TW.onDuty(w, hero), false, "read-only (B§9)");
    w.rt.readOnly = false;
    w.rt.clockBehind = true;
    assert.equal(TW.onDuty(w, hero), false, "a clock behind (D§2.10)");
    w.rt.clockBehind = false;
    hero.contractor = true;
    assert.equal(TW.onDuty(w, hero), false, "Contractors never hold jobs");
    assert.equal(TW.stationOf(w, hero).reason, "contractor");
    delete hero.contractor;
    T.town.on = false;
    try {
      assert.equal(TW.onDuty(w, hero), false, "--no-town: the build before the town");
      assert.equal(TW.stationOf(w, hero).reason, "off");
    } finally { T.town.on = true; }
    assert.equal(TW.onDuty(w, hero), true);
  });

  test("a working hero's hero never leaves the field: the town changes no state, slot, map or task", () => {
    const { w, hero, live } = dutyWorld({ state: "questing" });
    live.task = { workSec: 30 };
    const before = JSON.stringify([live.state, live.mapId, live.task, w.rt.bind.get(live.address)]);
    for (let i = 0; i < 120; i++) TW.stepTown(w);
    assert.equal(JSON.stringify([live.state, live.mapId, live.task, w.rt.bind.get(live.address)]), before);
    assert.equal(TW.jobXpOf(hero), 0, "a working hero makes nothing");
    assert.equal(TW.heroTown(w, hero).state, "working");
    assert.equal(TW.heroTown(w, hero).station, "review_desk", "its station waits for it");
  });
});

describe("production and the shelf (TOWN.md §3.2)", () => {
  test("1 LGTM a hero-hour at rank 0, into a shelf of 10 x the Review Desk's level, then nothing", () => {
    const { w, hero } = dutyWorld();
    for (let i = 0; i < 3600; i++) TW.stepTown(w);
    assert.ok(near(TW.shelfOf(w.state), 1), `${TW.shelfOf(w.state)}`);
    assert.ok(near(TW.jobXpOf(hero), 1), "job XP is what it made");
    assert.equal(w.state.herd.town.t[1] & TW.FULL, 0);
    w.state.herd.town.s[0] = 9.9999;
    TW.stepTown(w);
    assert.equal(TW.shelfOf(w.state), 10, "capped at 10 x level 1");
    assert.ok(w.state.herd.town.t[1] & TW.FULL, "FULL today");
    const xp = TW.jobXpOf(hero);
    for (let i = 0; i < 600; i++) TW.stepTown(w);
    assert.equal(TW.shelfOf(w.state), 10);
    assert.equal(TW.jobXpOf(hero), xp, "a full shelf makes nothing: no job XP from idle time");
    w.state.herd.town.rd = 3;
    assert.equal(TW.shelfCap(w.state), 30, "the building's level caps the shelf, never the staff");
    TW.stepTown(w);
    assert.ok(TW.shelfOf(w.state) > 10);
  });

  test("shared pro rata by want (rank factor), whatever the roster order", () => {
    const run = (reverse) => {
      const w = makeWorld({ heroes: [{ L: 20, state: "resting" }, { L: 20, state: "resting" }, { L: 20, state: "questing" }], herd: { day: 500 } });
      seedTown(w, { rd: 1, shelf: 9.9996, jobXp: (h, i) => (i === 1 ? 100 : 0) });
      if (reverse) w.state.heroes.reverse();
      const made = TW.stepTown(w);
      const byId = new Map(w.state.heroes.map((h) => [h.id, TW.jobXpOf(h)]));
      return { made, a: byId.get(1), b: byId.get(2) - 100, c: byId.get(3) };
    };
    const one = run(false);
    const two = run(true);
    assert.ok(near(one.made, 0.0004, 1e-9), `the room, not more: ${one.made}`);
    assert.ok(near(one.b / one.a, 1.4, 1e-9), `Committer x1.4 against Drive-by x1.0: ${one.b / one.a}`);
    assert.equal(one.c, 0, "the working hero makes nothing");
    assert.ok(near(one.a, two.a, 1e-15) && near(one.b, two.b, 1e-15), "job XP never depends on who was listed first");
    // with room for everyone, each makes its full want
    const w = makeWorld({ heroes: [{ L: 20, state: "resting" }, { L: 20, state: "shipped" }], herd: { day: 500 } });
    seedTown(w, { rd: 1, jobXp: (h, i) => (i ? 1000 : 25) });
    TW.stepTown(w);
    assert.ok(near(TW.jobXpOf(w.state.heroes[0]), 25 + 1.2 / 3600), "Contributor x1.2");
    assert.ok(near(TW.jobXpOf(w.state.heroes[1]), 1000 + 1.8 / 3600), "Core x1.8");
  });

  test("ranks: Drive-by 0, Contributor 25, Committer 100, Maintainer 300, Core 1,000; x1.0-x1.8; rank-ups wait for the Digest", () => {
    assert.deepEqual([0, 24.99, 25, 99.99, 100, 299, 300, 999, 1000, 1e6].map(TW.rankOf), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    assert.deepEqual([0, 1, 2, 3, 4].map((r) => Math.round(TW.rankFactor(r) * 10) / 10), [1, 1.2, 1.4, 1.6, 1.8]);
    assert.equal(TW.jobTitle(2), "Committer reviewer");
    const { w, hero } = dutyWorld();
    hero.st.tw[0] = 24.9999;
    TW.stepTown(w);
    assert.equal(TW.rankOf(TW.jobXpOf(hero)), 1);
    assert.deepEqual(w.state.herd.town.ru, [[hero.id, 1]]);
    hero.st.tw[0] = 99.99999;
    TW.stepTown(w);
    assert.deepEqual(w.state.herd.town.ru, [[hero.id, 2]], "one entry a hero: its newest rank");
    assert.equal(TW.heroTown(w, hero).title, "Committer reviewer");
  });
});

describe("rule 3 across the 04:00 turn and an offline gap (TOWN.md §2.2, §6.5)", () => {
  // one agent's hero at Lv 12: it ships and is seen at 03:4x on game day D0, then rests
  function setup() {
    const sim = new Sim({ now: beforeTurn() - 20 * MIN });
    sim.set("a", "idle").tick();
    const h = sim.hero("a");
    h.L = 12;
    h.cls = D.CLASS_IDX.shellmancer;
    sim.state.herd.gold = 0; // nothing for autopilot to buy
    TW.townState(sim.state).rd = 10; // a shelf of 100: the cap never binds here
    sim.ship("a");
    return { sim, h, d0: sim.state.herd.day };
  }

  test("seen at 03:45 counts through the next game day; at the 04:00 after that it lapses", () => {
    const { sim, h, d0 } = setup();
    assert.equal(TW.creditDayOf(h), d0, "the chest opened with full value: d = 0");
    assert.equal(TW.onDuty(sim.w, h), true);
    const xp0 = TW.jobXpOf(h);
    sim.tick(1200); // through 04:00: game day d0 + 1
    assert.equal(sim.state.herd.day, d0 + 1);
    assert.equal(TW.seenDays(sim.state, h), 1, "yesterday");
    assert.equal(TW.onDuty(sim.w, h), true, "the morning is never empty");
    assert.ok(near(TW.jobXpOf(h) - xp0, 1200 / 3600, 1e-6), "on duty every second of it");
    // the app stays open: jump to just before the 04:00 that ends game day d0 + 1 (an offline gap
    // settles first), then live across it
    const lapse = W.localDay(sim.now, 0) * DAY + DAY + 4 * HOUR;
    sim.jump(lapse - 20000 - sim.now);
    const xp1 = TW.jobXpOf(h);
    assert.equal(TW.onDuty(sim.w, h), true);
    sim.tick(10);
    assert.ok(TW.jobXpOf(h) > xp1, "still on duty in the last seconds of the day");
    sim.tick(20);
    assert.equal(sim.state.herd.day, d0 + 2);
    assert.equal(TW.onDuty(sim.w, h), false, "lapsed at the 04:00 turn");
    assert.equal(TW.stationOf(sim.w, h).reason, "unseen");
    assert.equal(TW.heroTown(sim.w, h).status, "Back on duty after you see its next chest");
    const xp2 = TW.jobXpOf(h);
    sim.tick(300);
    assert.equal(TW.jobXpOf(h), xp2, "nothing from idle time alone");
    // the save leaves a lapsed credit out (d >= 2) and keeps the job XP
    const o = JSON.parse(W.serialize(sim.w));
    assert.deepEqual(o.heroes[0].st[6].tw, [Math.floor(xp2)]);
    // its next seen chest puts it back on duty
    sim.ship("a");
    assert.equal(TW.onDuty(sim.w, h), true);
    assert.deepEqual(sim.w.rt.errors, []);
  });

  test("an offline gap: on duty for min(gap, the time until rule 3 lapses); a week away and an evening away make the same; a Waiting hero earns nothing", () => {
    const { sim, h, d0 } = setup();
    sim.set("b", "blocked").tick(); // a second agent, Waiting when the app closes
    const hb = sim.hero("b");
    hb.L = 12;
    hb.st.tw = [0, d0];
    const closedAt = sim.now;
    const xp0 = TW.jobXpOf(h);
    const shelf0 = TW.shelfOf(sim.state);
    const lapse = (d0 + 2) * DAY + 4 * HOUR; // the 04:00 that ends game day d0 + 1 (tz 0)
    const outcome = (afterMs) => {
      const s2 = restart(sim, afterMs);
      s2.tick();
      const h2 = s2.state.heroes.find((x) => x.id === h.id);
      const b2 = s2.state.heroes.find((x) => x.id === hb.id);
      return { xp: TW.jobXpOf(h2), b: TW.jobXpOf(b2), shelf: TW.shelfOf(s2.state), s2 };
    };
    const evening = outcome(5 * HOUR);
    assert.ok(near(evening.xp - Math.floor(xp0), 5 * 1 + 1 / 3600, 0.002), `5 h on duty: ${evening.xp - xp0}`);
    const twoDays = outcome(2 * DAY);
    const week = outcome(7 * DAY);
    const want = (lapse - closedAt) / HOUR;
    assert.ok(twoDays.xp - Math.floor(xp0) <= want + 0.01, "bounded by the lapse");
    assert.ok(near(twoDays.xp - Math.floor(xp0), want, 0.01), `${twoDays.xp - xp0} vs ${want}`);
    assert.ok(near(week.xp, twoDays.xp, 1e-9), "a week away makes what two days make");
    assert.ok(near(week.shelf, twoDays.shelf, 1e-9));
    assert.ok(week.shelf <= shelf0 + want + 0.11 && week.shelf <= TW.shelfCap(sim.state));
    assert.equal(week.b, 0, "Waiting earns nothing, as Fresh Eyes");
    // never a burst: nothing is spent and no note is raised while the gap settles
    assert.equal(week.s2.state.herd.town.u[0], sim.state.herd.town.u[0]);
    assert.ok(!week.s2.w.rt.notes.some((n) => /LGTM|Review Desk|Localhost/.test(n.text)), JSON.stringify(week.s2.w.rt.notes));
  });

  test("a chest seen as the app comes back (before the gap settles) does not reach back into the gap", () => {
    // two heroes seen at the same time; b's next task finishes while nobody looks; the app closes
    // and reopens a week later with b's terminal focused: reconcile opens b's chest (D§2.4 rule 2)
    // before applyOffline settles the gap, and that new credit did not hold while the app was closed
    const run = (lapsed) => {
      const { sim, h } = setup();
      sim.set("b", "idle").tick();
      const hb = sim.hero("b");
      hb.L = 12;
      sim.ship("b");
      sim.set("b", "working").tick(240).set("b", "done").tick(10);
      assert.equal(hb.pend.length, 1, "a chest waits for b");
      TW.townState(sim.state).rd = 1;
      sim.state.herd.town.s[0] = 0;
      if (lapsed) for (const x of [h, hb]) x.st.tw[1] = sim.state.herd.day - 5; // rule 3 long lapsed
      const xa = Math.floor(TW.jobXpOf(h));
      const xb = Math.floor(TW.jobXpOf(hb));
      const s2 = restart(sim, 7 * DAY);
      s2.set("b", "idle", { focused: true }).tick();
      const a2 = s2.state.heroes.find((x) => x.id === h.id);
      const b2 = s2.state.heroes.find((x) => x.id === hb.id);
      assert.equal(b2.pend.length, 0, "b's chest opened with full value as the app came back");
      assert.equal(TW.creditDayOf(b2), s2.state.herd.day, "seen work today");
      return { a: TW.jobXpOf(a2) - xa, b: TW.jobXpOf(b2) - xb, shelf: TW.shelfOf(s2.state), s2 };
    };
    const lapsed = run(true);
    assert.equal(lapsed.b, 0, `rule 3 had lapsed for the whole gap: no job XP (${lapsed.b})`);
    assert.equal(lapsed.a, 0);
    assert.ok(lapsed.shelf < 1, `nothing made while nobody was on duty (${lapsed.shelf})`);
    const both = run(false);
    assert.ok(both.a > 4 && near(both.a, both.b, 0.01), `the same credit when the gap began, the same share: ${both.a} / ${both.b}`);
    assert.deepEqual(both.s2.w.rt.errors, []);
  });

  test("closing the app shares the gap's room as staying open would (the heroes on duty while it filled)", () => {
    // A saw work today, B yesterday (B's rule 3 lapses at the next 04:00); room 10 at 22:00; 12 hours
    const at22 = beforeTurn() + 18 * HOUR + 30000 - 10 * MIN; // 21:50, tz 0
    const make = () => {
      const sim = new Sim({ now: at22 });
      sim.set("a", "idle").set("b", "idle").tick();
      for (const h of sim.state.heroes) { h.L = 12; h.cls = D.CLASS_IDX.shellmancer; }
      sim.state.herd.gold = 0;
      seedTown(sim.w, { rd: 1, shelf: 0, credit: false });
      sim.state.heroes[0].st.tw = [0, sim.state.herd.day];
      sim.state.heroes[1].st.tw = [0, sim.state.herd.day - 1];
      return sim;
    };
    const open = make().tick(12 * 3600);
    const closed = restart(make(), 12 * HOUR);
    closed.tick();
    const xp = (s) => s.state.heroes.map((h) => TW.jobXpOf(h));
    const [oa, ob] = xp(open);
    const [ca, cb] = xp(closed);
    assert.ok(near(oa, 5, 0.01) && near(ob, 5, 0.01), `open: both on duty while the shelf filled (${oa} / ${ob})`);
    assert.ok(near(ca, oa, 0.01) && near(cb, ob, 0.01), `closed: ${ca} / ${cb} against open ${oa} / ${ob}`);
    assert.equal(TW.shelfOf(closed.state), 10);
  });

  test("the shelf caps a gap's output, shared pro rata among the heroes on duty", () => {
    const { sim, h } = setup();
    TW.townState(sim.state).rd = 1;
    sim.state.herd.town.s[0] = 0;
    const xp0 = Math.floor(TW.jobXpOf(h));
    const s2 = restart(sim, 12 * HOUR);
    s2.tick();
    assert.equal(TW.shelfOf(s2.state), 10, "10 of the 12 it would have made");
    assert.ok(s2.state.herd.town.t[1] & TW.FULL);
    assert.ok(near(TW.jobXpOf(s2.state.heroes[0]) - xp0, 10, 0.01), "job XP from one gap is what fills the shelf's room");
  });
});

describe("LGTMs on chests opened with full value (TOWN.md §3.4)", () => {
  // a Lv 20 hero with one 30-minute chest waiting; shelf as given
  function chestWorld(shelf, { rd = 1, flags = 0 } = {}) {
    const w = makeWorld({ heroes: [{ L: 20, cls: "hotfixer", state: "resting", mapId: "2-1" }], herd: { day: 600, gold: 100 } });
    seedTown(w, { rd, shelf, flags, credit: false });
    const h = w.state.heroes[0];
    h.pend = [{ min: 30, fmin: 0, title: "Bump deps and fix types", at: T0 - 60000, sealFactor: 1 }];
    const live = w.rt.live.get(h.id);
    live.tally = { xp: 0, chestXp: 0 };
    return { w, h, live };
  }

  test("+10% on the chest's XP and gold; never its Seals or items; the coin float, today's count, Uptime and the title", () => {
    const a = chestWorld(3);
    const b = chestWorld(0);
    const eva = makeEv();
    const evb = makeEv();
    const ra = A.openChests(a.w, a.h, { reason: "click" }, eva);
    const rb = A.openChests(b.w, b.h, { reason: "click" }, evb);
    assert.ok(near(ra.xp, rb.xp * 1.1, 1e-6), `${ra.xp} vs ${rb.xp}`);
    assert.ok(near(ra.gold, rb.gold * 1.1, 1e-6));
    assert.equal(a.w.state.herd.gold - 100, Math.round(rb.gold * 1.1));
    assert.equal(ra.seals, rb.seals, "Seals unchanged");
    assert.deepEqual(ra.items.map((i) => [i.base, i.rar, i.ilvl]), rb.items.map((i) => [i.base, i.rar, i.ilvl]), "items unchanged");
    assert.equal(ra.lgtm, 1);
    assert.equal(rb.lgtm, undefined);
    assert.ok(near(a.live.tally.chestXp, b.live.tally.chestXp), "chestXp stays the chest's own XP");
    assert.ok(near(a.live.tally.lgtmXp, 0.1 * b.live.tally.chestXp, 1e-6), "the bonus in its own tally");
    assert.deepEqual(eva.fxOf("coin").map((f) => f.lgtm), [1], "the coin float: '+1.2k · LGTM'");
    assert.deepEqual(evb.fxOf("coin").map((f) => "lgtm" in f), [false], "no LGTM: the same effect as before the town");
    const town = a.w.state.herd.town;
    assert.ok(near(town.s[0], 2));
    assert.deepEqual([town.u[0], town.t[0], town.t[2]], [1, 1, 1]);
    assert.deepEqual(b.w.state.herd.town.t.slice(0, 3), [0, 0, 1], "a chest with an empty shelf counts, unboosted");
    const titles = TW.lastTitles(a.w);
    assert.equal(titles.length, 1);
    assert.equal(titles[0].title, "Bump deps and fix types");
    assert.equal(titles[0].heroId, a.h.id);
    assert.equal(TW.titleText(titles[0]), `“Bump deps and fix types” (${a.h.name.split(" ")[0]})`);
    assert.equal(TW.creditDayOf(a.h), 600, "seen work today");
  });

  test("one LGTM a chest, in opening order, while the shelf lasts; an empty shelf after a full one is DRY", () => {
    const { w, h } = chestWorld(1.5, { flags: TW.FULL });
    h.pend = [0, 1, 2].map((i) => ({ min: 20, fmin: 0, title: `Task ${i}`, at: T0 - (10 - i) * 60 * MIN, sealFactor: 1 }));
    const r = A.openChests(w, h, { reason: "seen" }, makeEv());
    assert.equal(r.opened, 3);
    assert.equal(r.lgtm, 1, "1.5 on the shelf: the first chest only");
    assert.ok(near(w.state.herd.town.s[0], 0.5));
    assert.deepEqual(TW.lastTitles(w).map((t) => t.title), ["Task 0"]);
    assert.equal(w.state.herd.town.t[1] & (TW.FULL | TW.DRY), TW.FULL | TW.DRY, "full this morning, ran dry since");
  });

  test("Unreviewed chests (nobody saw them) take no LGTM and give no seen work", () => {
    const { w, h } = chestWorld(5);
    h.pend[0].at = T0 - 2 * DAY;
    w.rt.nowMs = T0;
    const r = A.openChests(w, h, { reason: "unreviewed" }, makeEv());
    assert.equal(r.opened, 1);
    assert.equal(r.lgtm, undefined);
    assert.equal(TW.shelfOf(w.state), 5);
    assert.equal(w.state.herd.town.t[2], 0);
    assert.equal(TW.creditDayOf(h), null);
  });

  test("no Review Desk, the town off or a read-only world: chests open exactly as before the town", () => {
    for (const how of ["closed", "off", "readOnly"]) {
      const { w, h } = chestWorld(5, { rd: how === "closed" ? 0 : 1 });
      if (how === "off") T.town.on = false;
      if (how === "readOnly") w.rt.readOnly = true;
      try {
        const r = A.openChests(w, h, { reason: "click" }, makeEv());
        assert.equal(r.lgtm, undefined, how);
        assert.equal(TW.shelfOf(w.state), how === "closed" ? 5 : 5, how);
        if (how !== "closed") assert.equal(TW.creditDayOf(h), null, `${how}: no credit`);
        else assert.equal(TW.creditDayOf(h), 600, "seen work counts before the desk opens");
      } finally { T.town.on = true; }
    }
  });
});

describe("the Review Desk: manual and demand-gated (TOWN.md §5.2)", () => {
  test("level 1: autopilot buys it once a Lv 10+ hero has seen work and gold >= 3,000; the one note", () => {
    const { w, hero } = dutyWorld();
    w.state.herd.town = undefined;
    w.state.herd.gold = 2999;
    assert.equal(TW.autoDesk(w, makeEv()), null);
    w.state.herd.gold = 3000;
    hero.st.tw = [0];
    assert.equal(TW.autoDesk(w, makeEv()), null, "no seen work yet: nothing to review");
    hero.st.tw = [0, w.state.herd.day];
    hero.L = 9;
    assert.equal(TW.autoDesk(w, makeEv()), null, "Interns hold no job");
    hero.L = 10;
    const ev = makeEv();
    assert.equal(TW.autoDesk(w, ev), 1);
    assert.equal(w.state.herd.gold, 2000);
    assert.deepEqual(ev.notes, ["Localhost: the Review Desk is open"]);
    assert.deepEqual(ev.noteTag("Localhost: the Review Desk is open"), { kind: "town", short: ["Review Desk open"] });
    assert.equal(TW.autoDesk(w, makeEv()), null, "level 2 waits for demand");
    assert.deepEqual(w.state.herd.bld, [0, 0, 0, 0, 0, 0], "herd.bld untouched");
  });

  test("level n + 1 only after a game day that filled the shelf and later ran it dry, gold >= 3 x the price, one a day", () => {
    const { w } = dutyWorld();
    w.state.herd.gold = 1e6;
    const town = w.state.herd.town;
    const day = (flags) => { town.t[1] = flags; TW.dayTurn(w); return town.t[1]; };
    assert.equal(day(TW.FULL) & TW.WANT, 0, "full, never dry: no demand");
    assert.equal(TW.autoDesk(w, makeEv()), null);
    assert.equal(day(TW.DRY) & TW.WANT, 0, "dry but never full (flag 2 needs flag 1): no demand");
    town.s[0] = 0;
    // the real flags: an empty shelf turns chests away without DRY; FULL first, then DRY
    TW.takeLgtm(w, w.state.heroes[0], null);
    assert.equal(town.t[1] & TW.DRY, 0);
    town.s[0] = 10;
    TW.stepTown(w);
    town.s[0] = 0.5;
    TW.takeLgtm(w, w.state.heroes[0], null);
    assert.equal(town.t[1] & (TW.FULL | TW.DRY), TW.FULL | TW.DRY);
    TW.dayTurn(w);
    assert.ok(town.t[1] & TW.WANT, "wanted");
    assert.deepEqual([town.t[0], town.t[2]], [0, 0], "today's counters start afresh");
    assert.ok(TW.townInfo(w).want);
    w.state.herd.gold = 5999;
    assert.equal(TW.autoDesk(w, makeEv()), null, "gold < 3 x 2,000");
    w.state.herd.gold = 6000;
    const ev = makeEv();
    assert.equal(TW.autoDesk(w, ev), 2);
    assert.deepEqual(ev.notes, ["Localhost: Review Desk 2"]);
    assert.equal(w.state.herd.gold, 4000);
    assert.equal(town.t[1] & TW.WANT, 0);
    assert.equal(TW.autoDesk(w, makeEv()), null, "one level a game day");
    // the next turn without a dry shelf forgets the want
    town.t[1] = TW.FULL | TW.DRY;
    TW.dayTurn(w);
    TW.dayTurn(w);
    assert.equal(town.t[1] & TW.WANT, 0);
    town.rd = 10;
    town.t[1] = TW.FULL | TW.DRY;
    TW.dayTurn(w);
    assert.equal(town.t[1] & TW.WANT, 0, "max level");
  });

  test("loadDay: a save whose town was written on an earlier game day than the save (an older build moved it on) gets the turn it skipped, once; the same day, read-only or the town off: nothing", () => {
    const fresh = () => {
      const { w } = dutyWorld();
      w.state.herd.town.t = [5, TW.FULL | TW.DRY, 7];
      return w;
    };
    const w = fresh();
    TW.loadDay(w, 19997);
    assert.ok(w.state.herd.town.t[1] & TW.WANT, "the day that ended decides the want, as dayTurn");
    assert.deepEqual([w.state.herd.town.t[0], w.state.herd.town.t[2]], [0, 0], "today's counters start afresh");
    for (const [label, townDay, prep] of [["same day", 20000], ["no day", null], ["a later day", 20001], ["read-only", 19997, (x) => { x.rt.readOnly = true; }]]) {
      const x = fresh();
      if (prep) prep(x);
      TW.loadDay(x, townDay);
      assert.deepEqual(x.state.herd.town.t, [5, TW.FULL | TW.DRY, 7], label);
    }
    const off = fresh();
    T.town.on = false;
    try { TW.loadDay(off, 19997); } finally { T.town.on = true; }
    assert.deepEqual(off.state.herd.town.t, [5, TW.FULL | TW.DRY, 7], "the town off");
  });

  test("behind autopilot's Buildings switch (and the master switch); the six buildings' queue is unchanged", () => {
    const { w } = dutyWorld();
    w.state.herd.town = undefined;
    w.state.herd.gold = 10000;
    w.state.herd.cfg.auto.buildings = false;
    AP.autopilot(w, makeEv());
    assert.equal(TW.deskLevel(w.state), 0);
    w.state.herd.cfg.auto.buildings = true;
    w.state.herd.cfg.autopilot = false;
    AP.autopilot(w, makeEv());
    assert.equal(TW.deskLevel(w.state), 0);
    w.state.herd.cfg.autopilot = true;
    AP.autopilot(w, makeEv());
    assert.equal(TW.deskLevel(w.state), 1);
    // the buildings bought the cheapest level first (herd.autoBuyPick), the desk outside that queue
    assert.equal(w.state.herd.bld.reduce((a, b) => a + b, 0), 1);
    assert.equal(w.state.herd.gold, 10000 - 800 - 1000);
  });

  test("by hand: the buy command, like any building", () => {
    const w = W.createWorld({ nowMs: T0, seed: 2 });
    w.state.herd.gold = 1500;
    const r = W.command(w, "buy", { building: "review_desk" }, T0);
    assert.deepEqual(r, { ok: true, msg: "Review Desk 1 (-1.0k gold)" });
    assert.equal(w.state.herd.gold, 500);
    assert.equal(w.rt.notes[0].text, "Localhost: the Review Desk is open");
    assert.deepEqual(W.command(w, "buy", { building: "review_desk" }, T0), { ok: false, error: "Not enough gold" });
    w.state.herd.gold = 1e7;
    for (let n = 2; n <= 10; n++) assert.equal(W.command(w, "buy", { building: "review_desk" }, T0).ok, true);
    assert.deepEqual(W.command(w, "buy", { building: "review_desk" }, T0), { ok: false, error: "Max level" });
    assert.equal(TW.shelfCap(w.state), 100);
    assert.deepEqual(w.state.herd.bld, [0, 0, 0, 0, 0, 0]);
  });
});

describe("Contractors (TOWN.md §2.4)", () => {
  test("no job, no duty and no job XP; their chests take LGTMs; promoted, a Contractor keeps today's seen work", () => {
    const sim = new Sim({ now: beforeTurn() - 40 * MIN });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle", { space: `s${i + 2}`, space_name: `pr-review-eng-${i}` });
    sim.tick();
    sim.state.herd.gold = 0;
    seedTown(sim.w, { rd: 1, shelf: 5 });
    sim.set("c1", "working", { space: "s9", space_name: "rnd-qa" }).tick();
    const c = sim.hero("c1");
    assert.ok(c.contractor && c.id < 0, "the 7th agent of the day plays as a Contractor");
    c.L = 14;
    sim.ship("c1", 300);
    assert.equal(sim.town.u[0], 1, "its chest took an LGTM");
    const live = sim.w.rt.live.get(c.id);
    assert.ok(live.tally.lgtmXp > 0 && near(live.tally.lgtmXp, 0.1 * live.tally.chestXp, 1e-6));
    assert.equal(TW.onDuty(sim.w, c), false, "resting, but never on duty");
    assert.equal(TW.heroTown(sim.w, c).state, "contractor");
    const xp = TW.jobXpOf(c);
    sim.tick(120);
    assert.equal(TW.jobXpOf(c), xp, "no job XP");
    assert.equal(xp, 0);
    assert.equal(TW.creditDayOf(c), sim.state.herd.day, "its seen work is kept for a promotion");
    // the 04:00 turn reopens hiring: the live Contractor is promoted as itself, with yesterday's credit
    sim.tick(40 * 60);
    const h = sim.hero("c1");
    assert.ok(h && !h.contractor && h.id > 0, "promoted");
    assert.equal(TW.seenDays(sim.state, h), 1);
    assert.equal(TW.onDuty(sim.w, h), true, "on duty at once: rule 3 holds");
    assert.ok(TW.lastTitles(sim.w).some((t) => t.heroId === h.id), "its approved title follows its new id");
    assert.ok(!TW.lastTitles(sim.w).some((t) => t.heroId < 0));
    assert.deepEqual(sim.w.rt.errors, []);
  });
});

describe("a read-only world (B§9) and the town off", () => {
  test("read-only: nothing accrues, nothing is taken, nothing is bought", () => {
    const { w, hero } = dutyWorld();
    w.rt.readOnly = true;
    w.state.herd.gold = 1e6;
    w.state.herd.town.s[0] = 5;
    const before = JSON.stringify(w.state);
    assert.equal(TW.stepTown(w), 0);
    assert.equal(TW.takeLgtm(w, hero, "x"), 0);
    assert.equal(TW.settleOffline(w, 5 * HOUR).made, 0);
    assert.equal(TW.autoDesk(w, makeEv()), null);
    assert.equal(TW.buyDesk(w, makeEv()).ok, false);
    TW.markSeen(w, hero);
    assert.equal(JSON.stringify(w.state), before);
    assert.equal(TW.heroTown(w, hero).state, "paused");
  });

  test("the town off (--no-town): no duty, no buys, no bonuses, no credit", () => {
    const { w, hero } = dutyWorld();
    w.state.herd.gold = 1e6;
    T.town.on = false;
    try {
      assert.equal(TW.stepTown(w), 0);
      assert.equal(TW.takeLgtm(w, hero, null), 0);
      assert.equal(TW.autoDesk(w, makeEv()), null);
      assert.equal(TW.buyDesk(w, makeEv()).ok, false);
      assert.equal(TW.townInfo(w).chip, null);
      // a save that has a town keeps it as it is: no game-day turn, no demand
      w.state.herd.town.t = [5, TW.FULL | TW.DRY, 7];
      TW.dayTurn(w);
      assert.deepEqual(w.state.herd.town.t, [5, TW.FULL | TW.DRY, 7]);
    } finally { T.town.on = true; }
  });
});

describe("the Digest's line, the Hall of Fame and the views' data", () => {
  test("Digest: chests LGTM'd and rank-ups since it was read, Uptime; never counted in `empty` (no Herd dot for the town)", () => {
    const w = makeWorld({ heroes: [{ L: 20 }, { L: 20 }, { L: 20 }], herd: { day: 9 } });
    seedTown(w, { rd: 3, used: 520, ranks: [[1, 2], [2, 2], [3, 1]] });
    w.state.herd.digestSnap = { at: 0, lv: { 1: 20, 2: 20, 3: 20 }, bk: [], seals: 0, drops: 0, badges: [] };
    w.state.herd.town.dg = [261, 0];
    w.state.herd.digestAt = 0;
    for (const h of w.state.heroes) h.pend = [];
    const g = Hd.digest(w.state);
    assert.equal(g.empty, true, "the town alone is not news for the dot");
    const n1 = w.state.heroes[0].name.split(" ")[0];
    const n3 = w.state.heroes[2].name.split(" ")[0];
    assert.equal(g.town.text, `Localhost: 259 chests LGTM'd (+10% XP and gold) · ${n1} and 1 more reached Committer · ${n3} reached Contributor · 99% uptime (was 90%)`);
    assert.equal(g.town.lgtm, 259);
    assert.deepEqual(g.town.ranks.map((r) => [r.heroId, r.rankName]), [[1, "Committer"], [2, "Committer"], [3, "Contributor"]]);
    Hd.digestMark(w.state, 5000);
    assert.deepEqual(w.state.herd.town.dg, [520, 0], "the baseline in the town, which an older build keeps");
    assert.equal("tw" in w.state.herd.digestSnap, false);
    assert.deepEqual(w.state.herd.town.ru, []);
    assert.equal(Hd.digest(w.state).town, null, "nothing new since");
    // a herd without a town: digestMark writes nothing new (a save at zero stays as it was)
    const w2 = makeWorld({ heroes: [{ L: 3 }] });
    Hd.digestMark(w2.state, 1);
    assert.equal("tw" in w2.state.herd.digestSnap, false);
    assert.equal(w2.state.herd.town, undefined);
  });

  test("Hall of Fame: a retired hero keeps its job rank (one more number, only when it had one)", () => {
    const w = makeWorld({ heroes: [{ L: 40, state: "resting" }, { L: 35, state: "resting" }] });
    seedTown(w, { rd: 1, jobXp: (h, i) => (i ? 0 : 120) });
    const [a, b] = w.state.heroes;
    assert.equal(Hd.retire(w, a.id, T0, null).ok, true);
    assert.equal(Hd.retire(w, b.id, T0, null).ok, true);
    assert.deepEqual(w.state.herd.fame.map((e) => e.length), [5, 4]);
    assert.equal(w.state.herd.fame[0][4], 2);
    const rows = Hd.hallOfFame(w.state);
    assert.equal(rows[1].jobTitle, "Committer reviewer");
    assert.equal(rows[1].rank, 2);
    assert.equal("rank" in rows[0], false);
  });

  test("heroTown and townInfo: station, title, job line, chip and tab rows; status words stay the agent's", () => {
    const w = makeWorld({ heroes: [{ L: 20, state: "resting" }, { L: 20, state: "shipped" }, { L: 5, state: "resting" }, { L: 20, state: "questing" }], herd: { day: 50, gold: 1e5 } });
    seedTown(w, {
      rd: 7, shelf: 40.25, used: 1118, today: 206, chests: 340, jobXp: (h, i) => [112, 30, 0, 400][i],
      titles: [{ title: "Bump deps", heroId: 2, name: "Fizz the Pure", byId: 1, byName: "Rue the Lazy-Loaded" }],
    });
    w.rt.live.delete(w.state.heroes[0].id); // hero 1 is off duty: its terminal is gone
    const [h1, h2, h3, h4] = w.state.heroes;
    const t1 = TW.heroTown(w, h1);
    assert.deepEqual([t1.station, t1.onDuty, t1.state, t1.seen, t1.rank, t1.title, t1.line], ["review_desk", true, "duty", 0, 2, "Committer reviewer", "Committer reviewer · 112 / 300"]);
    assert.equal(t1.tip, "Off duty · at the Review Desk (Committer reviewer)");
    assert.equal(t1.status, "On duty: agent away (seen work today) · made 112 LGTMs · last “Bump deps” (Fizz)");
    assert.deepEqual(t1.last, { title: "Bump deps", name: "Fizz the Pure" });
    const t2 = TW.heroTown(w, h2);
    // a shipped hero on duty stays by its chest in the field (integrator, round 1: it said "At the
    // Review Desk" while it was drawn by its chest)
    assert.equal(t2.tip, "On duty for the Review Desk while its chest waits · Contributor reviewer");
    assert.equal(TW.heroTown(w, h3).station, "campfire");
    assert.equal(TW.heroTown(w, h3).status, "Gets a job at Lv 10 (Junior)");
    assert.equal(TW.heroTown(w, h4).state, "working");
    for (const t of [t1, t2]) assert.ok(!/\breviewing\b/.test(`${t.status} ${t.tip}`), "never 'reviewing' (TOWN.md §7.4)");
    const info = TW.townInfo(w);
    assert.deepEqual([info.open, info.level, info.cost, info.shelf.n, info.shelf.cap, info.today.lgtm, info.today.pct, info.onDuty, info.staff], [true, 7, 128000, 40, 70, 206, 61, 2, 3]);
    assert.deepEqual(info.chip, { lgtm: 206, text: "LGTM ×206" });
    assert.equal(info.uptime.label, "99%");
    assert.deepEqual(info.ranks, [0, 1, 1, 1, 0]);
    assert.equal(info.maintainer.heroId, h4.id);
    assert.equal(info.titles[0].text, "“Bump deps” (Fizz), by Rue");
    assert.equal(info.tips[0], "Localhost: 2 on duty (Review Desk 2) · LGTM 40/70");
    assert.equal(info.tips[1], "Last LGTM: “Bump deps” (Fizz), by Rue · 206 today (61%) · 99% uptime");
    assert.equal(info.rows.lgtm, "LGTMs 40 / 70   +10% XP and gold on chests you open · today 206 of 340 (61%)");
    // before the desk opens there is no chip
    const w0 = makeWorld({ heroes: [{ L: 20 }] });
    assert.equal(TW.townInfo(w0).chip, null);
    assert.equal(TW.townInfo(w0).open, false);
  });

  test("Uptime in nines: S = LGTMs spent (+10 a Runbook)", () => {
    assert.deepEqual([0, 99, 100, 499, 500, 2500, 12500, 62500, 1e9].map((s) => TW.uptime(s).label), ["booting", "booting", "90%", "90%", "99%", "99.9%", "99.99%", "99.999%", "99.999%"]);
    assert.equal(TW.uptime(300).frac, 0.5);
    assert.equal(TW.uptime(1e6).next, null);
  });
});

describe("determinism and hot reload (TOWN.md §9)", () => {
  // three agents ship and rest over an evening, the app open, the Review Desk bought by autopilot
  function play(reloadAt = -1) {
    let sim = new Sim({ now: T0, seed: 11 });
    for (const a of ["a", "b", "c"]) sim.set(a, "idle").tick();
    for (const h of sim.state.heroes) { h.L = 15; h.cls = D.CLASS_IDX.refactorer; }
    sim.state.herd.gold = 5000;
    for (let round = 0; round < 6; round++) {
      if (round === reloadAt) {
        const titles = TW.handoverTown(sim.w);
        const text = W.serialize(sim.w);
        const { world } = W.loadWorld(text, { nowMs: sim.now });
        TW.takeTown(world, titles);
        const s2 = new Sim({ world, now: sim.now });
        for (const [k, a] of sim.agents) s2.agents.set(k, Object.assign({}, a));
        sim = s2;
      }
      for (const a of ["a", "b", "c"]) sim.ship(a, 200 + round * 7);
      sim.tick(900);
    }
    return sim;
  }

  test("the same snapshots give the same town, byte for byte", () => {
    const a = play();
    const b = play();
    assert.equal(W.serialize(a.w), W.serialize(b.w));
    assert.ok(TW.deskLevel(a.state) >= 1, "autopilot opened the Review Desk");
    assert.ok(a.state.herd.town.u[0] > 0, "and chests took LGTMs");
    assert.deepEqual(TW.lastTitles(a.w), TW.lastTitles(b.w));
    assert.deepEqual(a.w.rt.errors, []);
  });

  // (the field itself is not reload-exact: lanes and mobs are runtime, so hero XP may differ; the
  // town's own state is saved, and only the shelf's tenth and job XP's fraction round)
  test("a hot reload keeps the town (saved: shelf, level, counters, job XP, credit days; the titles handed over)", () => {
    const a = play();
    const b = play(3);
    const ta = a.state.herd.town;
    const tb = b.state.herd.town;
    assert.equal(tb.rd, ta.rd);
    assert.deepEqual(tb.u, ta.u, "every chest took the same LGTM");
    assert.deepEqual(tb.t, ta.t);
    assert.ok(Math.abs(tb.s[0] - ta.s[0]) <= 0.1 + 1e-9, "the shelf within its saved tenth");
    a.state.heroes.forEach((h, i) => {
      const g = b.state.heroes[i];
      assert.ok(Math.abs(TW.jobXpOf(h) - TW.jobXpOf(g)) < 1, "job XP within its saved whole unit");
      assert.equal(TW.creditDayOf(g), TW.creditDayOf(h));
    });
    assert.deepEqual(TW.lastTitles(b.w).map((t) => t.title), TW.lastTitles(a.w).map((t) => t.title));
    // a cold start (no handover) starts the titles empty, as TOWN.md §7.5 says
    const { world } = W.loadWorld(W.serialize(a.w), { nowMs: a.now });
    assert.deepEqual(TW.lastTitles(world), []);
  });

  // integrator, round 1: the save rounds job XP down to whole units and the shelf to a tenth, so a
  // hot reload (host.js hands the world over as save text) lost up to 1 job XP a hero and 0.1 LGTM
  // each time; the handover now carries the exact values, and a restart still rounds down
  test("a hot reload hands over the exact shelf, job XP, who approved and the credit before the newest; a restart rounds down; a handover that does not match changes nothing", () => {
    const a = play();
    const w = a.w;
    const town = w.state.herd.town;
    // fractions the save cannot keep
    town.s[0] = Math.min(TW.shelfCap(w.state) - 0.5, 3.27);
    w.state.heroes.forEach((h, i) => { h.st.tw[0] = 24.6 + i * 0.13; });
    w.rt.town.owed.set(w.state.heroes[1].id, 0.42);
    w.rt.town.prior.set(w.state.heroes[0].id, { was: w.state.herd.day - 1, at: a.now - 1000 });
    const data = TW.handoverTown(w);
    assert.deepEqual(JSON.parse(JSON.stringify(data)), data, "plain data");
    const text = W.serialize(w);
    const cold = W.loadWorld(text, { nowMs: a.now }).world;
    assert.equal(cold.state.herd.town.s[0], 3.2, "a restart: the shelf to a tenth, rounded down");
    assert.deepEqual(cold.state.heroes.map((h) => TW.jobXpOf(h)), [24, 24, 24], "a restart: job XP whole, rounded down (Drive-by until 25)");
    const hot = W.loadWorld(text, { nowMs: a.now }).world;
    TW.takeTown(hot, data);
    assert.equal(hot.state.herd.town.s[0], town.s[0], "the exact shelf");
    assert.deepEqual(hot.state.heroes.map((h) => TW.jobXpOf(h)), w.state.heroes.map((h) => TW.jobXpOf(h)), "the exact job XP");
    assert.deepEqual([...hot.rt.town.owed], [...w.rt.town.owed], "who made the LGTMs no chest has taken yet");
    assert.deepEqual([...hot.rt.town.prior], [...w.rt.town.prior], "the credit each hero held before its newest");
    // the same next hour either way: a reload changes no outcome
    const ref = W.loadWorld(text, { nowMs: a.now }).world;
    TW.takeTown(ref, data);
    for (const x of [hot, ref]) for (let i = 0; i < 1800; i++) TW.stepTown(x);
    assert.equal(W.serialize(hot), W.serialize(ref));
    assert.equal(TW.rankOf(TW.jobXpOf(hot.state.heroes[2])), 1, "the hero at 24.86 reached Contributor");
    // a handover from another world (or another day's file) does not lift this one's numbers
    const other = W.loadWorld(text, { nowMs: a.now }).world;
    other.state.herd.town.s[0] = 1;
    other.state.heroes[0].st.tw[0] = 3;
    TW.takeTown(other, data);
    assert.equal(other.state.herd.town.s[0], 1);
    assert.equal(TW.jobXpOf(other.state.heroes[0]), 3);
    assert.equal(TW.jobXpOf(other.state.heroes[1]), 24.73, "a hero that matches takes its exact value");
    // an older build's handover (titles only) is taken as it is
    const old = W.loadWorld(text, { nowMs: a.now }).world;
    TW.takeTown(old, { titles: data.titles });
    assert.equal(old.state.herd.town.s[0], 3.2);
    assert.deepEqual(TW.lastTitles(old).map((t) => t.title), TW.lastTitles(w).map((t) => t.title));
  });
});
