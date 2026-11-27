// Agents -> heroes (D§2, D§3): seat binding and rebinding, roster limits and Contractors,
// seq-gated transitions (D§2.3), tasks with the 8-tick close debounce, Commit Chests and "seen",
// Unblocked, the flap guard, Forklings, working_since credit, the Daily Shift and the signature.
// Driven through world.tick with scripted snapshots, the way the host drives it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as D from "../mods/down-the-stack/game/data.js";
import * as F from "../mods/down-the-stack/game/formulas.js";
import * as Hr from "../mods/down-the-stack/game/heroes.js";
import * as W from "../mods/down-the-stack/game/world.js";
import * as A from "../mods/down-the-stack/game/agents.js";
import * as I from "../mods/down-the-stack/game/items.js";
import * as HerdM from "../mods/down-the-stack/game/herd.js";
import * as V from "../mods/down-the-stack/game/view.js";
import { findRefs } from "./helpers/engine.mjs";

const T0 = 1_790_000_000_000; // a Tuesday-ish epoch; the local day is computed with tz 0
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const prog = (key = "claude") => ({ key, name: key, icon: null, tint: false, tile: null, color: null });

function ag(addr, status, extra = {}) {
  return Object.assign({
    address: addr, status, seq: 1, app: "claude", program: prog(), title: "Fix the flaky test",
    space: "s1", space_name: "herdr-app", tab: "tb1", tab_index: 1, tab_name: "main", pane: `p${addr}`,
    pane_name: null, pinned: false, focused: false,
  }, extra);
}

// A scripted herdr: agents keep their seq until their status word changes (then seq + 1). done <->
// idle is herdr's seen flag, not a word (src/model.rs: set_word bumps seq, mark_seen / set_turn do
// not), so that flip keeps the seq.
const seenFlip = (a, b) => (a === "done" && b === "idle") || (a === "idle" && b === "done");
class Sim {
  constructor({ seed = 3, world = null, now = T0 } = {}) {
    this.w = world || W.createWorld({ nowMs: now, seed });
    this.now = now;
    this.agents = new Map();
    this.subs = [];
    this.focus = null;
    this.active = true;
    this.tabs = {};
    this.weekday = 2;
  }
  set(addr, status, extra = {}) {
    const a = this.agents.get(addr);
    if (!a) this.agents.set(addr, ag(addr, status, extra));
    else {
      if (a.status !== status) { if (!seenFlip(a.status, status)) a.seq++; a.status = status; }
      Object.assign(a, extra);
    }
    return this;
  }
  drop(addr) { this.agents.delete(addr); return this; }
  snap() {
    return {
      nowMs: this.now, tzOffsetMin: 0, weekday: this.weekday, windowActive: this.active, focusedTerminal: this.focus,
      agents: Array.from(this.agents.values()).map((a) => Object.assign({}, a)), subagents: this.subs.map((s) => Object.assign({}, s)),
      tabs: this.tabs, spaces: [{ id: "s1", name: "herdr-app" }],
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
  live(addr) { return this.w.rt.live.get(this.id(addr)); }
  get state() { return this.w.state; }
}

function noErrors(sim) {
  assert.deepEqual(sim.w.rt.errors, []);
}

describe("seat keys and binding (D§3.1, D§3.2)", () => {
  test("seatKey: norm(space name) + program key", () => {
    assert.equal(A.seatKey("  Herdr-App ", "s1", "claude", "claude-code"), "herdr-app/claude");
    assert.equal(A.seatKey("", "S1", null, "codex"), "s1/codex");
    assert.equal(A.seatKey(null, null, null, null), "nospace/agent");
    assert.equal(A.seatKey("A".repeat(50), "s", "x", null), "a".repeat(32) + "/x");
  });

  test("a new agent gets a new Lv 1 hero: seat, space id, address, journal and a note", () => {
    const sim = new Sim().set("t1", "idle").tick();
    const h = sim.hero("t1");
    assert.ok(h);
    assert.equal(h.L, 1);
    assert.equal(h.seat, "herdr-app/claude");
    assert.equal(h.sid, "s1");
    assert.equal(h.addr, "t1");
    assert.equal(h.ord, 0);
    assert.equal(h.name, Hr.heroName("herdr-app/claude", 0));
    assert.ok(sim.state.herd.log.some((e) => e[1] === "hire" && e[2] === h.id));
    assert.ok(sim.w.rt.notes.some((n) => n.text === `New hire: ${h.name}`));
    assert.equal(sim.live("t1").state, "resting");
    noErrors(sim);
  });

  test("a second agent of the same seat gets ordinal 1; programs never pick the class", () => {
    const sim = new Sim().set("t1", "idle").set("t2", "idle", { program: prog("codex"), app: "codex" }).set("t3", "idle").tick();
    assert.equal(sim.hero("t3").ord, 1);
    assert.equal(sim.hero("t2").seat, "herdr-app/codex");
    assert.equal(sim.hero("t2").ord, 0);
    for (const a of ["t1", "t2", "t3"]) assert.equal(sim.hero(a).cls, 0);
  });

  test("terminals with neither program nor app never become heroes", () => {
    const sim = new Sim().set("t1", "working", { program: null, app: null }).tick(3);
    assert.equal(sim.state.heroes.length, 0);
    assert.equal(sim.w.rt.live.size, 0);
  });

  test("a terminal that ends goes off duty; the next terminal of the seat carries the same hero on", () => {
    const sim = new Sim().set("t1", "working").tick(5);
    const id = sim.id("t1");
    sim.drop("t1").tick();
    assert.equal(sim.w.rt.live.size, 0);
    assert.equal(sim.w.rt.bind.size, 0);
    sim.set("t7", "working").tick();
    assert.equal(sim.id("t7"), id);
    assert.equal(sim.state.heroes.length, 1);
  });

  test("rebinding picks lastPane, then lastTab, then the higher level", () => {
    const sim = new Sim().set("a", "idle", { pane_name: "api" }).set("b", "idle", { pane_name: "web", tab_name: "front" }).tick();
    const [ha, hb] = [sim.hero("a"), sim.hero("b")];
    ha.L = 9;
    sim.drop("a").drop("b").tick();
    sim.set("c", "idle", { pane_name: "web", tab_name: "front" }).tick();
    assert.equal(sim.hero("c"), hb, "same pane name wins over level");
    sim.drop("c").tick();
    sim.set("d", "idle", { pane_name: "other", tab_name: "front" }).tick();
    assert.equal(sim.hero("d"), hb, "then the tab name");
    sim.drop("d").tick();
    sim.set("e", "idle", { pane_name: "zzz", tab_name: "zzz" }).tick();
    assert.equal(sim.hero("e"), ha, "then the highest level");
  });

  test("a reload that keeps the terminal rebinds by saved address", () => {
    const sim = new Sim().set("t1", "idle", { pane_name: "x" }).set("t2", "idle", { pane_name: "y" }).tick();
    const h2 = sim.hero("t2");
    sim.hero("t1").L = 20; // the higher-level hero would win a seat pick
    const text = W.serialize(sim.w);
    const { world } = W.loadWorld(text, { nowMs: sim.now });
    const sim2 = new Sim({ world, now: sim.now });
    sim2.set("t2", "idle", { pane_name: "renamed" }).tick();
    assert.equal(sim2.hero("t2").id, h2.id);
  });

  test("a renamed space keeps its id: the hero's seat is re-keyed", () => {
    const sim = new Sim().set("t1", "idle").tick();
    const id = sim.id("t1");
    sim.drop("t1").tick();
    sim.set("t2", "idle", { space_name: "Renamed Repo" }).tick();
    assert.equal(sim.id("t2"), id);
    assert.equal(sim.hero("t2").seat, "renamed repo/claude");
  });

  test("another program started in a terminal binds like a new terminal of its own seat: the old hero keeps its seat and its unseen chest", () => {
    // herdr keeps a terminal's address while its agent exits; the terminal leaves agents() while only
    // the shell runs and comes back with the next program (D§3.1: a seat is space + program)
    const codex = { app: "codex", program: prog("codex"), title: "" };
    const sim = new Sim().set("t1", "working").tick(600).set("t1", "done").tick(10);
    const claude = sim.hero("t1");
    claude.L = 3;
    assert.equal(claude.pend.length, 1, "a chest nobody has seen");
    const seals = sim.state.herd.seals;
    sim.drop("t1").tick(3); // claude exits: the chest waits (closing is not acknowledgment, D§2.4)
    sim.set("t1", "idle", Object.assign({ seq: 1 }, codex)).tick(3);
    const other = sim.hero("t1");
    assert.notEqual(other, claude, "codex gets a hero of its own");
    assert.equal(other.seat, "herdr-app/codex");
    assert.equal(claude.seat, "herdr-app/claude", "the claude hero keeps its seat");
    assert.equal(claude.pend.length, 1, "and its chest, still unseen");
    assert.equal(sim.state.herd.seals, seals, "no Seals were credited");
    sim.set("t2", "working").tick();
    assert.equal(sim.hero("t2"), claude, "the next claude terminal carries the claude hero on");

    // a benched hero of the new program is the one that comes back
    const sim2 = new Sim().set("t1", "idle").set("t9", "idle", codex).tick(2);
    const [c1, x1] = [sim2.hero("t1"), sim2.hero("t9")];
    sim2.drop("t1").drop("t9").tick();
    sim2.set("t1", "idle", Object.assign({ seq: 1 }, codex)).tick();
    assert.equal(sim2.hero("t1"), x1, "the benched codex hero");
    assert.equal(c1.seat, "herdr-app/claude");
    assert.equal(sim2.state.heroes.length, 2, "no hire");
    noErrors(sim);
    noErrors(sim2);
  });

  test("a space name cut to 32 units never ends in half an emoji (herdr rejects a lone surrogate)", () => {
    const name = "Payments platform rewrite 2026 \u{1F680} next"; // the emoji spans units 31-32
    assert.equal(A.normSeat(name), "payments platform rewrite 2026 ");
    assert.equal(A.normSeat("x".repeat(31) + "\u{1F680}"), "x".repeat(31), "the pair is dropped whole");
    assert.equal(A.normSeat("x".repeat(30) + "\u{1F680}"), "x".repeat(30) + "\u{1F680}", "a pair that fits stays");
    const sim = new Sim().set("t1", "idle", { space_name: name }).tick();
    const h = sim.hero("t1");
    assert.equal(h.seat, "payments platform rewrite 2026 /claude");
    assert.ok(h.seat.isWellFormed());
    sim.drop("t1").tick();
    sim.set("t2", "idle", { space_name: name, space: "s2" }).tick();
    assert.equal(sim.hero("t2"), h, "the seat still matches its space");
  });
});

describe("seats on other machines (round 4)", () => {
  const remote = (extra = {}) => Object.assign({ space: "devbox/s9", space_name: "herdr-app", tab: "devbox/tb9", pane: "devbox/p9" }, extra);

  test("seatKey: a remote space adds its machine; this computer's seats are unchanged", () => {
    assert.equal(A.seatKey("Herdr-App", "s1", "claude", null), "herdr-app/claude");
    assert.equal(A.seatKey("Herdr-App", "s1", "claude", null, null), "herdr-app/claude", "byte-identical for local spaces");
    assert.equal(A.seatKey("Herdr-App", "devbox/s9", "claude", null, "devbox"), "herdr-app@devbox/claude");
    assert.equal(A.seatKey("", "devbox/s9", "claude", null, "devbox"), "s9@devbox/claude", "the id's own part, not its prefix");
    assert.equal(A.seatKey("API ", "s", "codex", null, " DevBox "), "api@devbox/codex", "the machine normalised like a space");
    assert.equal(A.seatKey("", "", null, null, "a/b"), "nospace@a-b/agent", "the program stays after the last slash");
    assert.equal(A.machineOf({ space: "devbox/s9", address: "devbox/t1" }), "devbox");
    assert.equal(A.machineOf({ space: "", address: "devbox/t1" }), "devbox", "a pane-less agent: its address");
    assert.equal(A.machineOf({ space: "s1", address: "t1" }), null);
    assert.equal(A.machineOf({ space: "s1", address: "t1", machine: "vps" }), "vps", "a machine field from the host wins");
  });

  test("same-named spaces on two machines keep their own heroes, benched ones included", () => {
    const sim = new Sim().set("t1", "idle").tick();
    const local = sim.hero("t1");
    assert.equal(local.seat, "herdr-app/claude");
    sim.drop("t1").tick();
    sim.set("devbox/t2", "idle", remote()).tick();
    const far = sim.hero("devbox/t2");
    assert.notEqual(far, local, "the benched local hero stays home");
    assert.equal(far.seat, "herdr-app@devbox/claude");
    assert.equal(far.sid, "devbox/s9");
    assert.equal(sim.live("devbox/t2").machine, "devbox");
    sim.drop("devbox/t2").tick();
    sim.set("t3", "idle").tick();
    assert.equal(sim.hero("t3"), local, "and the local agent gets the local hero back");
    sim.set("devbox/t4", "idle", remote()).tick();
    assert.equal(sim.hero("devbox/t4"), far);
    // off duty, an older chest titled after the remote space still counts as that space's name
    sim.drop("devbox/t4").tick();
    far.pend = [{ min: 30, fmin: 0, title: "herdr-app", at: sim.now - 25 * 3600000, sealFactor: 1 }];
    sim.tick(60);
    assert.equal(sim.state.herd.log.filter((e) => e[1] === "unrev").at(-1)[3], "", "not a Quest name");
    sim.set("devbox/t4", "idle", remote()).tick();
    // Rebind keeps the machine in the seat
    sim.drop("t3").tick();
    assert.equal(W.command(sim.w, "rebind", { heroId: local.id, address: "devbox/t4" }, sim.now).ok, true);
    assert.equal(local.seat, "herdr-app@devbox/claude");
    noErrors(sim);
  });

  test("an older save's remote hero (seat without its machine) never goes to a local agent; its own machine re-keys it", () => {
    const sim = new Sim();
    sim.tick();
    const old = Hr.newHero(sim.state, { seat: "herdr-app/claude", sid: "devbox/s9", ord: 0, nowMs: T0 });
    old.L = 20;
    sim.state.heroes.push(old);
    sim.set("t1", "idle").tick();
    assert.notEqual(sim.hero("t1"), old, "a local agent of the same-named space");
    sim.set("devbox/t2", "idle", remote()).tick();
    assert.equal(sim.hero("devbox/t2"), old, "its own space id");
    assert.equal(old.seat, "herdr-app@devbox/claude", "re-keyed");
    noErrors(sim);
  });
});

describe("roster limits and Contractors (D§3.4)", () => {
  test("at most 6 new heroes per local day; the 7th agent is a Contractor; the next day hires again", () => {
    const sim = new Sim();
    for (let i = 0; i < 7; i++) sim.set(`t${i}`, "idle");
    sim.tick();
    assert.equal(sim.state.heroes.length, 6);
    const c = sim.hero("t6");
    assert.ok(c.contractor);
    assert.ok(c.id < 0);
    assert.equal(sim.w.rt.contractors.get("t6"), c);
    assert.equal(c.L, 1, "max(1, median - 5)");
    assert.ok(!sim.state.heroes.some((h) => h.name === c.name), "a Contractor has a name of its own");
    const saved = JSON.parse(W.serialize(sim.w));
    assert.equal(saved.heroes.length, 6, "Contractors are not saved as heroes");
    assert.deepEqual(saved.herd.ct.map((r) => r[0]), [-c.id], "only as a slim record (round 5)");
    assert.ok(saved.heroes.every((h) => h.id > 0));
    // next local day
    sim.drop("t6").tick();
    sim.now += 86400000;
    sim.set("t8", "idle").tick();
    assert.ok(!sim.hero("t8").contractor);
    assert.equal(sim.state.heroes.length, 7);
    noErrors(sim);
  });

  test("Contractor level = median roster level - 5, Shellmancer from Lv 10, reference kit all Alpha", () => {
    const sim = new Sim();
    sim.state.herd.hired = [sim.state.herd.day, 6];
    for (let i = 0; i < 3; i++) {
      const h = Hr.newHero(sim.state, { seat: "x/y", ord: i, nowMs: T0 });
      h.L = [20, 30, 40][i];
      sim.state.heroes.push(h);
    }
    sim.tick(); // sets herd.day
    sim.state.herd.hired = [sim.state.herd.day, 6];
    sim.set("t1", "working").tick();
    const c = sim.hero("t1");
    assert.ok(c.contractor);
    assert.equal(c.L, 25);
    assert.equal(c.cls, D.CLASS_IDX.shellmancer);
    assert.equal(c.eq.length, 6);
    assert.ok(c.eq.every((it) => it.rar === 1 && it.ilvl === 23 && it.aff.length === 1 && it.uid < 0));
    assert.ok(Hr.stats(c, { herd: sim.state.herd }).hasWeapon);
  });

  test("a full roster frees the least-recently-seen hero below Lv 10 (gear to the stash); Lv 10+ is never deleted", () => {
    const sim = new Sim();
    sim.tick();
    for (let i = 0; i < 30; i++) {
      const h = Hr.newHero(sim.state, { seat: "old/agent", ord: i, nowMs: T0 });
      h.L = i === 4 || i === 9 ? 5 : 12;
      h.seenAt = T0 - 86400000 + i * 1000; // off duty since yesterday: past the off-duty grace
      h.eq[1] = { uid: 9000 + i, base: D.BASE_LIST.findIndex((b) => b.slot === "hat" && b.tier === 1), ilvl: 5, rar: 2, pol: 0, aff: [[0, 50], [4, 50]], flags: 0, prop: -1 };
      sim.state.heroes.push(h);
    }
    const victim = sim.state.heroes[4];
    // the victim was the last one in a paused boss fight: it leaves with the hero (a Postmortem)
    sim.state.herd.fight = { k: "b", i: 0, ids: [victim.id], t: 10, ph: 1, p: [[0, 100, 500]], m: {}, pool: 500, dl: 100, sq: 0 };
    sim.set("n1", "idle").tick();
    assert.equal(sim.state.heroes.length, 30);
    assert.ok(!sim.state.heroes.includes(victim));
    assert.equal(sim.state.herd.fight, null, "the paused fight it was alone in closed");
    assert.ok(sim.state.herd.log.some((e) => e[1] === "boss" && /Postmortem/.test(e[3])));
    assert.ok(!sim.hero("n1").contractor);
    assert.ok(sim.state.herd.stash.some((it) => it.uid === 9004), "the Beta hat went to the stash");
    assert.ok(sim.state.herd.log.some((e) => e[1] === "leave" && e[2] === victim.id));
    sim.state.heroes[9].L = 12; // the other low hero
    sim.set("n2", "idle").tick();
    assert.ok(sim.state.heroes.length === 30);
    const second = sim.hero("n2");
    assert.ok(!second.contractor, "the second low hero made room");
    sim.set("n3", "idle").tick();
    assert.ok(sim.hero("n3").contractor, "everyone left is Lv 10+: Contractor");
    noErrors(sim);
  });
});

// Owner decision (round 4, "promote only"): a Contractor whose agent is still live joins the
// roster when hiring reopens (the 04:00 game day turn) or a roster slot frees, longest-running
// first, within the day's hires and the rules for a new hire.
describe("Contractor promotion (round 4)", () => {
  const DAY = 86400000;
  // 30 s before a 04:00 game day turn (tz 0)
  const beforeTurn = () => (W.localDay(T0, 0) + 1) * DAY + 4 * 3600000 - 30000;

  test("the 04:00 day turn promotes 6 of 7 live Contractors, longest-running first, before a newcomer", () => {
    const sim = new Sim({ now: beforeTurn() - 600000 });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle");
    sim.tick();
    // 7 Contractors arrive one after another (addresses in reverse, so the line is not the address order)
    for (let i = 6; i >= 0; i--) sim.set(`c${i}`, "idle").tick(); // resting: no XP while the clock runs
    const cs = [6, 5, 4, 3, 2, 1, 0].map((i) => sim.hero(`c${i}`));
    assert.ok(cs.every((c) => c.contractor && c.id < 0));
    assert.equal(sim.state.heroes.length, 6);
    cs[0].L = 14; cs[0].xp = 123; cs[0].cls = D.CLASS_IDX.hotfixer;
    const keep = { name: cs[0].name, L: 14, xp: 123, cls: D.CLASS_IDX.hotfixer, kit: cs[0].eq.map((it) => [it.base, it.ilvl, it.rar, JSON.stringify(it.aff)]) };
    const before = A.hireOutlook(sim.w, cs[0]);
    assert.equal(before.when, "day");
    assert.equal(before.hiresLeft, 0);
    assert.equal(before.position, 0);
    assert.equal(before.atMs, beforeTurn() + 30000, "the next 04:00");
    assert.match(before.text, /next 04:00 game day.*today: 0 of 6 hires left/);
    assert.equal(A.hireOutlook(sim.w, cs[6]).when, "day");
    assert.equal(A.hireOutlook(sim.w, cs[6]).days, 2, "the 7th in line waits a second day");
    assert.equal(A.hireOutlook(sim.w, sim.hero("h0")), null, "a roster hero has no outlook");
    while (sim.now < beforeTurn()) sim.tick(); // still the same game day: nobody is hired
    assert.equal(sim.state.heroes.length, 6);
    // the turn: a newcomer arrives in the same second
    sim.set("n1", "idle").tick(31);
    assert.equal(sim.state.heroes.length, 12);
    assert.equal(A.hiredToday(sim.state), 6);
    for (const i of [6, 5, 4, 3, 2, 1]) {
      const h = sim.hero(`c${i}`);
      assert.ok(!h.contractor && h.id > 0, `c${i} promoted`);
      assert.equal(sim.w.rt.contractors.has(`c${i}`), false);
    }
    assert.ok(sim.hero("c0").contractor, "the 7th Contractor waits for the next day");
    assert.ok(sim.hero("n1").contractor, "the newcomer does not take a Contractor's hire");
    const p = sim.hero("c6");
    assert.equal(p, cs[0], "the same hero object carries on");
    assert.equal(p.name, keep.name);
    assert.equal(p.L, 14);
    assert.equal(p.xp, 123);
    assert.equal(p.cls, keep.cls);
    assert.equal(p.addr, "c6", "it keeps its terminal");
    assert.equal(sim.live("c6").heroId, p.id);
    assert.equal(sim.live("c6").contractor, false);
    assert.equal(p.seat, "herdr-app/claude");
    assert.deepEqual(p.eq.map((it) => [it.base, it.ilvl, it.rar, JSON.stringify(it.aff)]), keep.kit, "the same kit");
    assert.ok(p.eq.every((it) => it.uid > 0), "real items with saved uids");
    assert.equal(new Set(p.eq.map((it) => it.uid)).size, 6);
    const line = sim.state.herd.log.find((e) => e[1] === "hired" && e[2] === p.id);
    assert.ok(line, "journal line");
    assert.equal(line[3], `Hired: ${keep.name} (was a contractor)`);
    assert.equal(line[4], 14);
    assert.equal(line[5], keep.name);
    assert.equal(sim.state.herd.log.filter((e) => e[1] === "hire").length, 6, "no Lv 1 hire line for a promotion");
    // the next ticks change nothing (one promotion each)
    sim.tick(5);
    assert.equal(sim.state.heroes.length, 12);
    assert.equal(sim.state.herd.log.filter((e) => e[1] === "hired").length, 6);
    noErrors(sim);
  });

  test("a retire frees a slot: the longest-running Contractor joins at once; Lv 10+ rosters never make room", () => {
    const sim = new Sim();
    sim.tick();
    for (let i = 0; i < 30; i++) {
      const h = Hr.newHero(sim.state, { seat: "old/agent", ord: i, nowMs: T0 });
      h.L = i === 0 ? 31 : 12;
      sim.state.heroes.push(h);
    }
    sim.set("t1", "working").tick();
    sim.set("t2", "working").tick();
    const c = sim.hero("t1");
    assert.ok(c.contractor && sim.hero("t2").contractor);
    const o = A.hireOutlook(sim.w, c);
    assert.equal(o.when, "slot");
    assert.equal(o.room, 0);
    assert.equal(o.hiresLeft, 6);
    assert.match(o.text, /when a roster slot frees/);
    assert.equal(A.hireOutlook(sim.w, sim.hero("t2")).position, 1);
    // a day turn does not help a full roster of Lv 10+ heroes
    sim.jump(86400000);
    sim.tick(3);
    assert.ok(sim.hero("t1").contractor && sim.hero("t2").contractor);
    assert.equal(sim.state.heroes.length, 30);
    const veteran = sim.state.heroes[0];
    const r = W.command(sim.w, "retire", { heroId: veteran.id }, sim.now);
    assert.equal(r.ok, true);
    assert.match(r.msg, /a contractor joined the roster/);
    assert.equal(sim.hero("t1"), c);
    assert.ok(!c.contractor && c.id > 0, "promoted by the command itself");
    assert.ok(sim.w.rt.notes.some((n) => n.text === `Hired: ${c.name} (was a contractor)`), "a header note tells the person");
    assert.ok(sim.state.heroes.includes(c));
    assert.equal(sim.state.heroes.length, 30);
    assert.ok(sim.hero("t2").contractor, "one slot, one hire");
    // the journal: the retiree is named on its line even though it left the roster
    const ret = sim.state.herd.log.find((e) => e[1] === "retire" && e[2] === veteran.id);
    assert.equal(ret[5], veteran.name);
    sim.tick(3);
    assert.ok(sim.hero("t2").contractor);
    noErrors(sim);
  });

  test("a hero below Lv 10 off duty on a full roster lets the Contractor in once its off-duty grace runs out", () => {
    const sim = new Sim();
    sim.tick();
    for (let i = 0; i < 29; i++) {
      const h = Hr.newHero(sim.state, { seat: "old/agent", ord: i, nowMs: T0 });
      h.L = 12;
      sim.state.heroes.push(h);
    }
    sim.set("low", "idle").tick(); // the 30th hero, Lv 1, playing
    const low = sim.hero("low");
    assert.ok(!low.contractor);
    sim.set("t1", "idle").tick();
    const c = sim.hero("t1");
    assert.ok(c.contractor, "the low hero is playing: no room");
    assert.equal(A.hireOutlook(sim.w, c).when, "slot");
    sim.drop("low").tick();
    const offAt = sim.now;
    // within its off-duty grace (round 4b: 15 min of world time) it is never let go: its agent may
    // be restarting. The Contractor is told when it will be hired, if the agent does not come back
    assert.equal(D.TUNING.roster.offDutyGraceMin, 15);
    assert.ok(A.inOffDutyGrace(sim.w, low));
    const o = A.hireOutlook(sim.w, c);
    assert.equal(o.when, "grace");
    assert.equal(o.atMs, offAt + 15 * 60000);
    assert.equal(o.room, 1);
    assert.equal(o.graced, 1);
    assert.match(o.text, /^Hired in about 15 min, once a hero below Lv 10 has been off duty for 15 min \(unless its agent comes back\)/);
    while (sim.now < offAt + 15 * 60000 - 1000) sim.tick();
    assert.ok(sim.state.heroes.includes(low), "kept through its grace");
    assert.ok(c.contractor);
    assert.match(A.hireOutlook(sim.w, c).text, /^Hired in about 1 min/);
    assert.ok(!sim.state.herd.log.some((e) => e[1] === "leave"));
    while (sim.now < offAt + 15 * 60000) sim.tick();
    assert.ok(!A.inOffDutyGrace(sim.w, low));
    assert.ok(!sim.state.heroes.includes(low), "let go to make room once the grace has run out");
    assert.ok(!c.contractor, "the waiting Contractor is promoted at that reconcile");
    assert.ok(sim.state.herd.log.some((e) => e[1] === "leave" && e[2] === low.id && e[5] === low.name));
    noErrors(sim);
  });

  test("a pane replaced within one snapshot keeps its hero while a Contractor waits (D§3.2 step 2 before a hire)", () => {
    // reconcile's step 1 takes ended terminals off duty first so that a replacement in the same
    // snapshot can take over their hero; a waiting Contractor must not let that hero go first
    const sim = new Sim();
    sim.tick();
    for (let i = 0; i < 29; i++) {
      const h = Hr.newHero(sim.state, { seat: "old/agent", ord: i, nowMs: T0 });
      h.L = 12;
      sim.state.heroes.push(h);
    }
    sim.set("low", "idle", { pane_name: "main" }).tick();
    const low = sim.hero("low");
    low.L = 5;
    sim.set("c1", "idle", { program: prog("codex"), app: "codex" }).tick();
    const c = sim.hero("c1");
    assert.ok(c.contractor, "a full roster: the newcomer waits as a Contractor");
    assert.equal(A.hiredToday(sim.state), 1, "hires are left today");
    sim.drop("low").set("low2", "idle", { pane_name: "main" }).tick();
    assert.equal(sim.hero("low2"), low, "the replacement terminal takes its hero back");
    assert.ok(sim.state.heroes.includes(low));
    assert.ok(!sim.state.herd.log.some((e) => e[1] === "leave"), "nobody let go");
    assert.ok(sim.hero("c1").contractor, "no room: the Contractor keeps waiting");
    sim.tick(3);
    assert.equal(sim.hero("low2"), low);
    assert.ok(sim.hero("c1").contractor);
    noErrors(sim);
  });

  test("a promoted hero survives save and load (level, XP, class, kit) and is never promoted twice", () => {
    const sim = new Sim({ now: beforeTurn() - 60000 });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle");
    sim.tick();
    sim.set("c1", "idle", { tab_name: "api", pane_name: "left" }).tick();
    const c = sim.hero("c1");
    c.L = 22; c.xp = 456; c.cls = D.CLASS_IDX.refactorer; c.sp = Hr.autoRanks(c.cls, 22, true);
    sim.tick(90);
    assert.ok(!c.contractor);
    const id = c.id;
    const kit = JSON.stringify(c.eq);
    const hired = A.hiredToday(sim.state);
    assert.equal(hired, 1);
    // a save and a reload (hot reload or a restart): the agent is still there
    const text = W.serialize(sim.w);
    const { world } = W.loadWorld(text, { nowMs: sim.now });
    const h = world.state.heroes.find((x) => x.id === id);
    assert.ok(h, "saved");
    assert.equal(h.name, c.name);
    assert.equal(h.L, 22);
    assert.equal(h.xp, 456);
    assert.equal(h.cls, D.CLASS_IDX.refactorer);
    assert.equal(JSON.stringify(h.eq), kit, "the kit, item for item");
    assert.equal(h.addr, "c1");
    assert.equal(h.lastTab, "api");
    assert.equal(h.lastPane, "left");
    assert.ok(!("contractor" in h) && !("since" in h));
    const sim2 = new Sim({ world, now: sim.now });
    for (const [k, a] of sim.agents) sim2.agents.set(k, Object.assign({}, a));
    sim2.tick(3);
    assert.equal(sim2.hero("c1"), h, "the same terminal binds its hero again");
    assert.equal(world.rt.contractors.size, 0);
    assert.equal(world.state.heroes.length, 7);
    assert.equal(A.hiredToday(world.state), 1, "no second hire");
    assert.equal(world.state.herd.log.filter((e) => e[1] === "hired").length, 1);
    assert.equal(world.state.herd.log.filter((e) => e[1] === "hire").length, 6);
    noErrors(sim2);
  });

  test("a promoted Contractor's fight and journal lines follow it; a read-only world never promotes", () => {
    const sim = new Sim({ now: beforeTurn() - 60000 });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle");
    sim.tick();
    sim.set("c1", "working").tick();
    const c = sim.hero("c1");
    const old = c.id;
    sim.state.herd.log.push([sim.now, "ship", old, "Fix it", 1, c.name]);
    sim.w.rt.fights.push({ kind: "boss", heroIds: [3, old], helpers: [old], result: null });
    sim.state.herd.fight = { k: "b", i: 0, ids: [old, 2], hl: [old], t: 1, ph: 1, p: [], m: {}, pool: 1, dl: 0, sq: 0 };
    sim.w.rt.readOnly = true;
    sim.tick(90);
    assert.ok(c.contractor, "read-only: never hired");
    assert.equal(A.hireOutlook(sim.w, c).when, "never");
    assert.equal(A.promoteContractors(sim.w, null), 0);
    sim.w.rt.readOnly = false;
    sim.state.herd.hired = [sim.state.herd.day, 5]; // one hire left today
    assert.equal(A.promoteContractors(sim.w, null), 1);
    assert.ok(c.id > 0);
    assert.deepEqual(sim.w.rt.fights[0].heroIds, [3, c.id]);
    assert.deepEqual(sim.w.rt.fights[0].helpers, [c.id]);
    assert.deepEqual(sim.state.herd.fight.ids, [c.id, 2]);
    assert.deepEqual(sim.state.herd.fight.hl, [c.id]);
    assert.ok(sim.state.herd.log.some((e) => e[1] === "ship" && e[2] === c.id && e[3] === "Fix it"));
    assert.ok(!sim.state.herd.log.some((e) => e[2] === old));
  });
});

// Round 4b: a hero looks the same for life (a promotion keeps its colours); a hero whose agent is
// restarting is never let go to make room (the off-duty grace, and the terminals of a snapshot take
// their heroes back before anything is let go); a promotion leaves no trace of the Contractor id.
describe("round 4b: looks for life, the off-duty grace, promotions leave no Contractor id", () => {
  const DAY = 86400000;
  const MIN = 60000;
  const beforeTurn = () => (W.localDay(T0, 0) + 1) * DAY + 4 * 3600000 - 30000;
  // what the stage, the party and the sheet draw for a terminal's hero: hoodie and hat colours
  const looks = (sim, addr) => {
    const id = sim.id(addr);
    const st = V.stageView(sim.w, { width: 3200, nowMs: sim.now }).heroes.find((h) => h.address === addr);
    const row = V.partyView(sim.w, { width: 268, nowMs: sim.now }).groups.flatMap((g) => g.rows).find((r) => r.address === addr);
    const rig = V.sheetView(sim.w, { heroId: id, nowMs: sim.now }).header.rig;
    return { stage: [st.colors.hoodie, st.hat ? st.hat.color : null], party: row.colors.hoodie, sheet: [rig.colors.hoodie, rig.hat ? rig.hat.color : null] };
  };
  // a full roster: 29 heroes of Lv 12 off duty since yesterday (never let go) and room for one more
  const fullRoster = (sim, n = 29) => {
    for (let i = 0; i < n; i++) {
      const h = Hr.newHero(sim.state, { seat: "old/agent", ord: i, nowMs: T0 - DAY });
      h.L = 12;
      sim.state.heroes.push(h);
    }
  };

  test("a promoted Contractor keeps its hoodie and hat on the stage, in the party and on its sheet", () => {
    const sim = new Sim({ now: beforeTurn() - 600000 });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle");
    sim.tick();
    const cs = [0, 1, 2, 3, 4, 5].map((i) => `c${i}`);
    for (const addr of cs) sim.set(addr, "idle").tick();
    assert.ok(cs.every((addr) => sim.hero(addr).contractor));
    const before = new Map(cs.map((addr) => [addr, looks(sim, addr)]));
    for (const [addr, l] of before) assert.match(String(l.stage[1]), /^#[0-9A-F]{6}$/i, `${addr}: a Contractor's hat (a negative uid) has a colour`);
    for (const [addr, l] of before) {
      assert.ok(D.PALETTE.termlingTint.includes(l.party), `${addr} hoodie`);
      assert.ok(D.PALETTE.hatTint.includes(l.stage[1]), `${addr}: one of the hat tints`);
      assert.deepEqual(l.stage, [l.party, l.stage[1]]);
      assert.deepEqual(l.sheet, l.stage, "the sheet's rig is the stage's");
    }
    while (sim.now < beforeTurn() + 31000) sim.tick(); // the 04:00 turn is 30 s after beforeTurn()
    for (const addr of cs) {
      const h = sim.hero(addr);
      assert.ok(!h.contractor && h.id > 0, `${addr} promoted`);
      assert.deepEqual(looks(sim, addr), before.get(addr), `${addr} (${h.name}) looks as it did`);
    }
    // and after a save and a reload (hero.look and the hat's uid are saved)
    const { world } = W.loadWorld(W.serialize(sim.w), { nowMs: sim.now });
    const sim2 = new Sim({ world, now: sim.now });
    for (const [k, a] of sim.agents) sim2.agents.set(k, Object.assign({}, a));
    sim2.tick(2);
    for (const addr of cs) assert.deepEqual(looks(sim2, addr), before.get(addr), `${addr} after a reload`);
    noErrors(sim2);
  });

  test("restarting an agent (pane closes, a new terminal there 3 s later) keeps its hero while Contractors wait", () => {
    const sim = new Sim();
    sim.tick();
    fullRoster(sim);
    sim.set("low", "working", { pane: "pane-low" }).tick(); // the 30th hero, Lv 1, playing
    const low = sim.hero("low");
    sim.state.herd.hired = [sim.state.herd.day, 6]; // no hires left today: the newcomers wait
    sim.set("t1", "working", { program: prog("codex"), app: "codex" }).tick();
    sim.set("t2", "working", { program: prog("codex"), app: "codex" }).tick();
    assert.ok(sim.hero("t1").contractor && sim.hero("t2").contractor);
    sim.state.herd.hired = [sim.state.herd.day, 0]; // the 04:00 turn: hires reopen, the roster is full
    sim.tick(2);
    assert.ok(sim.hero("t1").contractor, "no room: everyone is Lv 10+ or playing");
    // the person restarts low's agent
    sim.drop("low").tick(3);
    assert.ok(sim.state.heroes.includes(low), "not let go while its agent restarts");
    assert.ok(sim.hero("t1").contractor && sim.hero("t2").contractor);
    sim.set("low2", "working", { pane: "pane-low" }).tick();
    assert.equal(sim.hero("low2"), low, "the new terminal takes its hero back");
    assert.ok(!sim.state.herd.log.some((e) => e[1] === "leave"), "nobody let go");
    assert.ok(!sim.state.herd.log.some((e) => e[1] === "hired"), "nobody hired");
    assert.equal(A.hireOutlook(sim.w, sim.hero("t1")).when, "slot");
    sim.tick(20 * 60); // and it stays (bound heroes are never let go)
    assert.equal(sim.hero("low2"), low);
    assert.ok(sim.hero("t1").contractor);
    noErrors(sim);
  });

  test("a relaunched agent takes back its own hero (the one whose terminal ended in that pane), not the seat's main hero", () => {
    const sim = new Sim();
    sim.tick();
    const main = Hr.newHero(sim.state, { seat: "herdr-app/claude", sid: "s1", ord: 0, nowMs: T0 - DAY });
    main.L = 15; // the seat's "main" hero, off duty since yesterday
    sim.state.heroes.push(main);
    sim.set("b1", "working", { pane: "pane-b" }).tick();
    const mine = sim.hero("b1");
    assert.equal(mine, main, "a new terminal of the seat takes its main hero (D§3.2)");
    sim.set("c1", "working", { pane: "pane-c" }).tick();
    const other = sim.hero("c1");
    assert.notEqual(other, main);
    // c1's agent restarts: its terminal ends, a new one opens in the same pane 3 s later
    sim.drop("c1").tick(3);
    sim.drop("b1").tick(); // and b1 stops too: main is free again, and of a higher level
    sim.set("c2", "working", { pane: "pane-c" }).tick();
    assert.equal(sim.hero("c2"), other, "its own hero, not the higher-level main one");
    sim.set("n1", "working", { pane: "pane-n" }).tick();
    assert.equal(sim.hero("n1"), main, "a terminal in another pane: the main hero, as before");
    noErrors(sim);
  });

  test("a newcomer on a full roster during the grace waits as a Contractor and is hired when the grace runs out", () => {
    const sim = new Sim();
    sim.tick();
    fullRoster(sim);
    sim.set("low", "working").tick();
    const low = sim.hero("low");
    assert.equal(A.hiredToday(sim.state), 1);
    sim.drop("low").tick();
    const offAt = sim.now;
    sim.tick(60);
    sim.set("n1", "working", { program: prog("codex"), app: "codex" }).tick();
    const n1 = sim.hero("n1");
    assert.ok(n1.contractor, "low is within its grace: no room yet");
    assert.ok(sim.state.heroes.includes(low));
    const o = A.hireOutlook(sim.w, n1);
    assert.equal(o.when, "grace");
    assert.equal(o.atMs, offAt + 15 * MIN);
    assert.match(o.text, /^Hired in about 14 min/);
    while (sim.now < offAt + 15 * MIN) sim.tick();
    assert.ok(!sim.state.heroes.includes(low), "let go once its grace has run out");
    assert.ok(!n1.contractor && n1.id > 0, "the waiting newcomer is hired at that reconcile");
    assert.equal(A.hiredToday(sim.state), 2);
    noErrors(sim);
  });

  test("the terminals of one snapshot take their heroes back before a newcomer in it makes room", () => {
    // a new terminal listed before a returning one (an app start lists every terminal at once):
    // the returning terminal's hero is never the one let go for the newcomer
    const sim = new Sim();
    fullRoster(sim, 28);
    const mk = (addr, L, seenAt) => {
      const h = Hr.newHero(sim.state, { seat: "herdr-app/claude", sid: "s1", ord: sim.state.heroes.length, nowMs: seenAt });
      h.L = L;
      h.addr = addr;
      sim.state.heroes.push(h);
      return h;
    };
    const mine = mk("a1", 5, T0 - DAY); // off duty since yesterday: past any grace
    const other = mk("a9", 4, T0 - DAY + 1000);
    sim.set("n1", "working", { program: prog("codex"), app: "codex" }).set("a1", "working").tick();
    assert.equal(sim.hero("a1"), mine, "its own terminal takes it back (fast rebind)");
    assert.ok(sim.state.heroes.includes(mine));
    assert.ok(!sim.state.heroes.includes(other), "the newcomer made room with the other hero below Lv 10");
    assert.ok(!sim.hero("n1").contractor);
    noErrors(sim);
  });

  test("an app restart: a terminal of the same seat listed first (it played a Contractor) never takes another terminal's own hero", () => {
    // day one: the six hires go to h0..h4 and t1; t0, of t1's seat, plays as a Contractor
    const sim = new Sim();
    for (let i = 0; i < 5; i++) sim.set(`h${i}`, "working", { space: `s${i + 2}`, space_name: `sp${i}` });
    sim.set("t1", "working").tick();
    sim.set("t0", "working").tick(30);
    const mine = sim.hero("t1");
    assert.ok(sim.hero("t0").contractor);
    assert.equal(mine.seat, "herdr-app/claude");
    // the app starts again 5 minutes later; herdr lists t0 (an earlier pane of the same space) first
    const now = sim.now + 5 * MIN;
    const { world } = W.loadWorld(W.serialize(sim.w), { nowMs: now });
    const sim2 = new Sim({ world, now });
    sim2.agents = new Map([["t0", sim.agents.get("t0")], ["t1", sim.agents.get("t1")]]);
    for (const [addr, a] of sim.agents) if (addr[0] === "h") sim2.agents.set(addr, a);
    sim2.tick();
    assert.equal(sim2.hero("t1").id, mine.id, "t1 takes its own hero back (fast rebind), whatever the listing order");
    assert.ok(sim2.live("t1").fast);
    assert.ok(sim2.hero("t0").contractor, "t0 plays as a Contractor again (the day's hires are used up)");
    noErrors(sim2);
  });

  test("an app restart: a hero still on duty when the app closed has its grace from the start; one off duty longer has not", () => {
    const sim = new Sim();
    sim.tick();
    fullRoster(sim, 28);
    sim.set("old5", "working").tick();
    const old5 = sim.hero("old5");
    old5.L = 5;
    sim.drop("old5").tick();
    sim.jump(20 * MIN); // old5 off duty for 20 min of world time
    sim.set("low", "working", { space: "s2", space_name: "api" }).tick(2); // another seat than old5's
    const low = sim.hero("low");
    low.L = 5;
    assert.equal(sim.state.heroes.length, 30);
    // the app closes; it starts again the next game day (hires reopen), 9 hours later
    const text = W.serialize(sim.w);
    const { world } = W.loadWorld(text, { nowMs: sim.now + 9 * 3600000 });
    const sim2 = new Sim({ world, now: sim.now + 9 * 3600000 });
    // the first listing has two newcomers; low's terminal is listed 5 s later
    sim2.set("n1", "working", { program: prog("codex"), app: "codex" }).set("n2", "working", { program: prog("codex"), app: "codex" }).tick();
    const S = world.state;
    assert.ok(!S.heroes.some((h) => h.id === old5.id), "off duty for 20 min before the close: let go for n1");
    assert.ok(!sim2.hero("n1").contractor);
    assert.ok(sim2.hero("n2").contractor, "low was on duty when the app closed: within its grace");
    assert.ok(S.heroes.some((h) => h.id === low.id));
    sim2.tick(4);
    sim2.set("low", "working", { space: "s2", space_name: "api" }).tick();
    assert.equal(sim2.hero("low").id, low.id, "its terminal takes it back");
    assert.ok(sim2.hero("n2").contractor);
    noErrors(sim2);
  });

  test("a promotion leaves no trace of the Contractor id anywhere in the world", () => {
    const sim = new Sim({ now: beforeTurn() - 20 * MIN });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "working", { space: `s${i}`, space_name: `sp${i}` });
    sim.tick();
    sim.w.rt.contractorSeq = 7776; // an id no other number in the world shares
    sim.subs = [{ address: "c1.sub", parent: "c1", status: "working", title: "a sub-task", program: "claude" }];
    sim.set("c1", "working", { program: prog("codex"), app: "codex", space: "s1", space_name: "sp1" }).tick(90);
    const c = sim.hero("c1");
    const old = c.id;
    assert.equal(old, -7777);
    assert.equal(sim.live("c1").forklings.length, 1);
    assert.ok(findRefs(sim.w, old).length > 0, "the probe sees the id while it is a Contractor");
    // what a Contractor can hold under its id: review Wounds and Lessons Learned, a drop waiting in
    // the inbox, fights (running and paused), journal lines
    const H = sim.state.herd;
    const woundUntil = sim.now + DAY;
    H.wounds[`rv0.${old}`] = [0.3, woundUntil, 600];
    H.lessons = Object.assign(H.lessons || {}, { [`rv0.${old}`]: 1 });
    H.inbox = [[old, { uid: 0, base: 0, ilvl: 1, rar: 0, pol: 0, aff: [], flags: 0, prop: -1 }]];
    sim.w.rt.fights.push({ kind: "review", reviewIdx: 0, heroIds: [old], helpers: [], parts: [], result: null });
    H.fight = { k: "b", i: 0, ids: [old, 2], hl: [old], t: 1, ph: 1, p: [], m: {}, pool: 1, dl: 0, sq: 0 };
    H.log.push([sim.now, "ship", old, "Port the CLI", 1, c.name]);
    // the turn: promoted by the reconcile (the room, its effects, the actors' room ids...)
    sim.now = beforeTurn() + 29000;
    sim.w.rt.nowMs = sim.now;
    H.day = W.localDay(sim.now + 1000, 0);
    assert.equal(A.promoteContractors(sim.w, null), 1);
    assert.ok(c.id > 0);
    assert.deepEqual(findRefs(sim.w, old), [], "right after the promotion");
    assert.deepEqual(H.wounds[`rv0.${c.id}`], [0.3, woundUntil, 600], "its review Wounds follow it");
    assert.equal(H.lessons[`rv0.${c.id}`], 1, "its Lessons Learned follow it");
    assert.equal(H.inbox[0][0], c.id, "its drop is offered with it as the finder");
    assert.deepEqual(sim.w.rt.fights.at(-1).heroIds, [c.id]);
    assert.deepEqual(H.fight.ids, [c.id, 2]);
    sim.w.rt.fights.pop();
    H.fight = null;
    sim.tick(5);
    assert.deepEqual(findRefs(sim.w, old), [], "and after the next ticks");
    assert.equal(sim.live("c1").forklings.length, 1, "its Forkling stays with it");
    // a tick-driven promotion (the 04:00 turn inside world.tick) too
    const sim2 = new Sim({ now: beforeTurn() - 20 * MIN });
    for (let i = 0; i < 6; i++) sim2.set(`h${i}`, "working", { space: `s${i}`, space_name: `sp${i}` });
    sim2.tick();
    sim2.w.rt.contractorSeq = 7776;
    sim2.set("c1", "working", { program: prog("codex"), app: "codex", space: "s1", space_name: "sp1" }).tick(60);
    sim2.state.herd.wounds[`rv1.${-7777}`] = [0.2, sim2.now + DAY, 0];
    while (sim2.now < beforeTurn() + 32000) sim2.tick();
    const c2 = sim2.hero("c1");
    assert.ok(!c2.contractor);
    assert.deepEqual(findRefs(sim2.w, -7777), []);
    assert.ok(sim2.state.herd.wounds[`rv1.${c2.id}`]);
    noErrors(sim);
    noErrors(sim2);
  });

  test("a save holding a Contractor's review Wounds or inbox drop loads without them pointing at a new Contractor", () => {
    const sim = new Sim().set("t1", "idle").tick();
    const H = sim.state.herd;
    H.wounds["rv0.-3"] = [0.3, sim.now + DAY, 600];
    H.wounds["rv0.1"] = [0.2, sim.now + DAY, 600];
    H.wounds["2"] = [0.1, sim.now + DAY, 0];
    H.lessons = { "rv1.-3": 2, "rv1.1": 1 };
    H.inbox = [[-3, { uid: 0, base: 0, ilvl: 1, rar: 0, pol: 0, aff: [], flags: 0, prop: -1 }]];
    const { world } = W.loadWorld(W.serialize(sim.w), { nowMs: sim.now });
    const H2 = world.state.herd;
    assert.deepEqual(Object.keys(H2.wounds).sort(), ["2", "rv0.1"]);
    assert.deepEqual(H2.lessons, { "rv1.1": 1 });
    assert.equal(H2.inbox[0][0], 0, "no finder");
  });

  test("hire notes say who they are about (kind, heroId, name); the 04:00 turn's six hires leave the note queue room for a note raised meanwhile (round 4b integrator)", () => {
    const sim = new Sim({ now: beforeTurn() - 600000 });
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle");
    sim.tick();
    const cs = [0, 1, 2, 3, 4, 5].map((i) => `c${i}`);
    for (const addr of cs) sim.set(addr, "idle").tick();
    while (sim.w.rt.notes.length) sim.tick(); // the six "New hire" notes have shown
    const tickBefore = sim.w.rt.tick;
    while (!sim.w.rt.notes.length && sim.now < beforeTurn() + 60000) sim.tick();
    const hires = sim.w.rt.notes.filter((n) => /^Hired: /.test(n.text));
    assert.equal(hires.length, 6, "a note for every promotion");
    assert.ok(sim.w.rt.tick > tickBefore);
    for (const n of hires) {
      const h = sim.state.heroes.find((x) => x.id === n.heroId);
      assert.ok(h && !h.contractor, `${n.text}: tagged with its roster id`);
      assert.deepEqual([n.kind, n.name, n.promoted], ["hire", h.name, true]);
      assert.equal(n.text, `Hired: ${h.name} (was a contractor)`);
      // round 4c: short forms without the epithet, for a strip with no room for the whole name
      const f = h.name.split(" ")[0];
      assert.deepEqual(n.short, [`Hired: ${f} (was a contractor)`, `Hired ${f}`]);
    }
    // a note raised while the six queue (6 x 3 s): it still shows, after them
    const ev = W.makeEmitter(sim.w, { live: true });
    ev.note("Release v0.2 shipped");
    const later = sim.w.rt.notes.find((n) => n.text === "Release v0.2 shipped");
    assert.ok(later, "not dropped: the hires after the tick's first do not fill the queue");
    assert.equal(later.showTick, hires[5].showTick + 3, "after the hires");
    const seen = [];
    for (let k = 0; k < 24; k++) {
      sim.w.rt.version++;
      const n = V.stageView(sim.w, { width: 1600, height: 200, nowMs: sim.now }).headerNote;
      if (n && seen[seen.length - 1] !== n.text) seen.push(n.text);
      sim.tick();
    }
    assert.equal(seen.length, 2, seen.join(" | "));
    assert.match(seen[0], /^Hired 6 contractors: /);
    assert.equal(seen[1], "Release v0.2 shipped");
    // a single hire's note is about its hero even when another hero has the same name
    while (sim.w.rt.notes.length) sim.tick();
    sim.state.herd.hired = [sim.state.herd.day, 5];
    sim.set("n1", "idle").tick();
    const newbie = sim.hero("n1");
    assert.ok(newbie && !newbie.contractor);
    sim.hero("h0").name = newbie.name;
    sim.w.rt.version++;
    const one = V.stageView(sim.w, { width: 1600, height: 200, nowMs: sim.now }).headerNote;
    assert.equal(one.text, `New hire: ${newbie.name}`);
    assert.equal(one.heroId, newbie.id, "the tag, not the (shared) name");
    assert.deepEqual(one.short, [`New hire: ${newbie.name.split(" ")[0]}`], "its short form drops the epithet (round 4c)");
    noErrors(sim);
  });
});

describe("journal lines name their hero (round 4)", () => {
  test("a Contractor's and a let-go hero's lines keep their names for the Digest; a reload keeps the names, not the ids", () => {
    const sim = new Sim();
    sim.state.herd.digestAt = 0;
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle");
    sim.tick();
    sim.set("c1", "working", { title: "Port the CLI" }).tick(200).set("c1", "idle").tick(10);
    const c = sim.w.rt.contractors.get("c1");
    assert.ok(c && c.contractor);
    const ship = sim.state.herd.log.find((e) => e[1] === "ship" && e[2] === c.id);
    assert.equal(ship[5], c.name);
    const H = sim.state.herd;
    let d = await_digest(sim);
    assert.equal(d.shipped.find((x) => x.text === "Port the CLI").name, c.name, "the Digest names the Contractor");
    sim.drop("c1").tick(); // the Contractor's agent leaves: it is gone for good
    assert.equal(A.heroById(sim.w, c.id), null);
    assert.equal(await_digest(sim).shipped.find((x) => x.text === "Port the CLI").name, c.name, "still named");
    // an evicted hero's Unreviewed chest names it
    const low = sim.state.heroes[0];
    sim.drop("h0").tick();
    low.pend = [{ min: 20, fmin: 0, title: "Old task", at: sim.now, sealFactor: 1 }];
    low.seenAt -= 16 * 60000; // off duty past its grace (round 4b)
    while (sim.state.heroes.length < 30) {
      const h = Hr.newHero(sim.state, { seat: "x/y", ord: sim.state.heroes.length, nowMs: sim.now });
      h.L = 12;
      sim.state.heroes.push(h);
    }
    H.hired = [H.day, 0];
    sim.set("n1", "idle", { program: prog("codex"), app: "codex" }).tick(); // another seat: no free hero of its own
    assert.ok(!sim.state.heroes.includes(low), "let go to make room");
    d = await_digest(sim);
    const u = d.unreviewed.find((x) => x.text === "Old task");
    assert.equal(u.name, low.name, "the Digest names the hero that left");
    assert.ok(sim.state.herd.log.some((e) => e[1] === "leave" && e[5] === low.name));
    // a reload: the Contractor's id was this session's only; its lines keep the name
    const { world } = W.loadWorld(W.serialize(sim.w), { nowMs: sim.now });
    const line = world.state.herd.log.find((e) => e[1] === "ship" && e[3] === "Port the CLI");
    assert.equal(line[2], 0, "no stale Contractor id");
    assert.equal(line[5], c.name);
    assert.ok(!world.state.herd.log.some((e) => e[2] < 0));
    const H2 = W.loadWorld(W.serialize(sim.w), { nowMs: sim.now }).world;
    assert.equal(HerdM.digest(H2.state).shipped.find((x) => x.text === "Port the CLI").name, c.name);
    noErrors(sim);
  });

  test("lineName: the roster's name now, else the stored one, else null (an older save's line)", () => {
    const sim = new Sim().set("t1", "idle").tick();
    const h = sim.hero("t1");
    const state = sim.state;
    assert.equal(HerdM.lineName(state, [0, "ship", h.id, "x", 1]), h.name, "an older line: the roster has it");
    h.name = "Renamed";
    assert.equal(HerdM.lineName(state, [0, "ship", h.id, "x", 1, "Old name"]), "Renamed", "a rename shows");
    assert.equal(HerdM.lineName(state, [0, "ship", 999, "x", 1, "Gone"]), "Gone");
    assert.equal(HerdM.lineName(state, [0, "ship", -3, "x", 1, "Contractor"]), "Contractor");
    assert.equal(HerdM.lineName(state, [0, "ship", 999, "x", 1]), null);
    assert.equal(HerdM.lineName(state, [0, "ship", 999, "x", 1, 7]), null, "a stray value is no name");
  });
});

describe("chests lost Unreviewed stay in sight (round 4)", () => {
  test("a header note at the moment a chest opens Unreviewed; the Herd dot stays lit until the Digest is viewed", () => {
    const sim = new Sim().set("t1", "working").set("t2", "working", { program: prog("codex"), app: "codex" }).tick(600);
    const h = sim.hero("t1");
    sim.drop("t1").tick(2); // off duty with its chest
    assert.equal(h.pend.length, 1);
    assert.equal(HerdM.unseenLosses(sim.state), 0);
    assert.equal(HerdM.digestDot(sim.w), false);
    h.pend[0].at = sim.now - 24 * 3600000 - 1000; // a day later (the person stays, the other hero works)
    let noted = null;
    for (let i = 0; i < 61 && !noted; i++) {
      sim.tick();
      noted = sim.w.rt.notes.find((n) => /opened Unreviewed/.test(n.text));
    }
    assert.ok(noted, "a header note at the moment of the loss");
    assert.equal(noted.text, `${h.name}: a chest opened Unreviewed (half value)`);
    // round 4c: about that hero (by the camp when it has no room), with short forms that keep the
    // point and drop the epithet
    const first = h.name.split(" ")[0];
    assert.equal(noted.heroId, h.id);
    assert.deepEqual(noted.short, [`${first}: a chest opened Unreviewed (half value)`, `${first}: chest opened Unreviewed`, `${first}: chest Unreviewed`]);
    assert.equal(h.pend.length, 0);
    assert.equal(HerdM.unseenLosses(sim.state), 1);
    assert.equal(HerdM.digestDot(sim.w), true, "the dot lights at the loss, not dark");
    assert.equal(sim.w.rt.digestDot, false, "(the away dot is not what lights it)");
    sim.tick(600);
    assert.equal(HerdM.digestDot(sim.w), true, "still lit");
    // saved: a reload keeps the count
    const { world } = W.loadWorld(W.serialize(sim.w), { nowMs: sim.now });
    assert.equal(HerdM.unseenLosses(world.state), 1);
    assert.equal(HerdM.digestDot(world), true);
    // the Digest viewed: lossesSeen (the digest keeps its lines until marked read)
    const r = W.command(sim.w, "lossesSeen", {}, sim.now);
    assert.equal(r.ok, true);
    assert.equal(r.msg, "1 Unreviewed chest seen");
    assert.equal(HerdM.unseenLosses(sim.state), 0);
    assert.equal(HerdM.digestDot(sim.w), false);
    assert.equal(HerdM.digest(sim.state).unreviewed.length, 1);
    // a Contractor leaving with a chest: told and counted too; "Mark as read" (digestSeen) clears it
    for (let i = 0; i < 6; i++) sim.set(`h${i}`, "idle");
    sim.tick();
    sim.set("c1", "idle", { program: prog("pi"), app: "pi" }).tick();
    const c = sim.hero("c1");
    assert.ok(c.contractor);
    c.pend = [{ min: 12, fmin: 0, title: "Spike", at: sim.now, sealFactor: 1 }, { min: 30, fmin: 0, title: "Spike 2", at: sim.now, sealFactor: 1 }];
    sim.drop("c1").tick();
    const two = sim.w.rt.notes.find((n) => n.text === `${c.name}: 2 chests opened Unreviewed (half value)`);
    assert.ok(two);
    const cf = c.name.split(" ")[0];
    assert.deepEqual(two.short, [`${cf}: 2 chests opened Unreviewed (half value)`, `${cf}: 2 chests opened Unreviewed`, `${cf}: chests Unreviewed`], "round 4c");
    assert.equal(HerdM.unseenLosses(sim.state), 2);
    assert.equal(HerdM.digest(sim.state).unseenLosses, 2);
    assert.equal(W.command(sim.w, "digestSeen", {}, sim.now).ok, true);
    assert.equal(HerdM.unseenLosses(sim.state), 0);
    assert.equal(HerdM.digestDot(sim.w), false);
    noErrors(sim);
  });

  test("a save from before the count counts the journal's Unreviewed lines since the last read", () => {
    const sim = new Sim().set("t1", "idle").tick();
    const st = sim.state;
    st.herd.digestAt = sim.now - 5000;
    st.herd.log.push([sim.now - 9000, "unrev", 1, "old", 3], [sim.now - 1000, "unrev", 1, "", 2], [sim.now - 500, "ship", 1, "x", 1]);
    delete st.herd.unseenUnrev;
    assert.equal(HerdM.unseenLosses(st), 2);
    st.herd.unseenUnrev = 0;
    assert.equal(HerdM.unseenLosses(st), 0, "a saved count wins");
  });
});

function await_digest(sim) {
  return HerdM.digest(sim.state);
}

describe("seq gating (D§2.3, D§2.10)", () => {
  test("status is re-read only when seq changes", () => {
    const sim = new Sim().set("t1", "working").tick(3);
    const a = sim.agents.get("t1");
    a.status = "blocked"; // same seq: ignored
    sim.tick(2);
    assert.equal(sim.live("t1").status, "working");
    a.seq++;
    sim.tick();
    assert.equal(sim.live("t1").status, "blocked");
    assert.equal(sim.live("t1").state, "waiting");
  });

  test("herdr's seen flip keeps the seq: done -> idle opens the chest as seen and the hero rests", () => {
    // herdr bumps seq only on a new status word (src/model.rs set_word); done vs idle is the seen
    // flag (mark_seen when the person looks, set_turn from another client), so seq stays put
    const sim = new Sim().set("t1", "working").tick(600).set("t1", "done").tick(8);
    const a = sim.agents.get("t1");
    const h = sim.hero("t1");
    const seq = a.seq;
    assert.equal(h.pend.length, 1);
    assert.equal(sim.live("t1").state, "shipped");
    sim.set("t1", "idle").tick();
    assert.equal(a.seq, seq, "the Sim models herdr: no seq bump");
    assert.equal(sim.live("t1").status, "idle");
    assert.equal(sim.live("t1").state, "resting");
    assert.equal(h.pend.length, 0, "opened as seen (D§2.3 done -> idle), not by focus");
    assert.ok(near(sim.state.herd.seals, 1, 1e-6), "full value: 1 Seal");
    assert.ok(sim.state.herd.log.some((e) => e[1] === "ship" && e[2] === h.id));
    // another client marks the turn unread: idle -> done, still the same seq
    sim.set("t1", "done").tick();
    assert.equal(a.seq, seq);
    assert.equal(sim.live("t1").status, "done");
    assert.equal(sim.live("t1").state, "shipped");
    assert.equal(A.isSeenFlip("done", "idle"), true);
    assert.equal(A.isSeenFlip("idle", "done"), true);
    assert.equal(A.isSeenFlip("working", "idle"), false);
    assert.equal(A.isSeenFlip("blocked", "working"), false);
    noErrors(sim);
  });

  test("unknown statuses count as idle", () => {
    const sim = new Sim().set("t1", "starting").tick();
    assert.equal(sim.live("t1").status, "idle");
    assert.equal(A.normStatus("weird"), "idle");
  });
});

describe("tasks and the 8-tick close (D§2.3)", () => {
  test("working opens a task; done held 8 ticks closes it into a pending chest", () => {
    const sim = new Sim().set("t1", "working").tick(120);
    assert.equal(sim.live("t1").task.workSec, 120);
    sim.set("t1", "done").tick(7);
    assert.ok(sim.live("t1").task, "still open after 7 ticks");
    assert.equal(sim.live("t1").task.closeCountdown, 1);
    sim.tick();
    assert.equal(sim.live("t1").task, null);
    const h = sim.hero("t1");
    assert.equal(h.pend.length, 1);
    assert.ok(near(h.pend[0].min, 2));
    assert.equal(h.pend[0].title, "Fix the flaky test");
    assert.equal(sim.live("t1").state, "shipped");
    noErrors(sim);
  });

  test("a task keeps the last title that names its work: program, shell, path, prompt or blank retitles never replace it", () => {
    // herdr's agents list judges titles the same way (defaults/mods/agents/main.js title()); an agent
    // that retitles itself "Claude Code" or "zsh" must not rename the task its chest records
    const sim = new Sim().set("t1", "working", { title: "✳ Fix the flaky test" }).tick(120);
    assert.equal(sim.live("t1").task.title, "Fix the flaky test", "the status glyph is stripped");
    for (const t of ["claude", "Claude", "✳ claude", "t1", "zsh", "-bash", "node", "~/src/app", "me@box: ~/src", "⏳", "", null]) {
      sim.set("t1", "working", { title: t }).tick(2);
      assert.equal(sim.live("t1").task.title, "Fix the flaky test", JSON.stringify(t));
      assert.equal(sim.live("t1").title, t == null ? "" : String(t), "the live record mirrors the raw title");
    }
    sim.set("t1", "working", { title: "⠋ Refactor the webhook sender so retries back off exponentially" }).tick(2);
    assert.equal(sim.live("t1").task.title, "Refactor the webhook sender so retries b", "a telling retitle wins, cut to 40 characters (D§2.3)");
    sim.set("t1", "working", { title: "Refactor the webhook sender, so retries back off" }).tick(2);
    assert.equal(sim.live("t1").task.title, "Refactor the webhook sender, so retries", "a cut that ends on a space is trimmed");
    sim.set("t1", "working", { title: "Refactor the webhook sender so  retries" }).tick(2);
    sim.set("t1", "working", { title: "zsh" }).tick(2);
    sim.set("t1", "done").tick(8);
    const h = sim.hero("t1");
    assert.equal(h.pend.length, 1);
    assert.equal(h.pend[0].title, "Refactor the webhook sender so  retries", "the chest records the task's last telling title");
    // a task opened under its program's name has no title
    sim.set("t1", "working", { title: "Claude" }).tick(120);
    assert.equal(sim.live("t1").task.title, "");
    // a chest from an older save that recorded a shell name journals as "Commit"
    h.pend.push({ min: 120, fmin: 0, title: "zsh", at: sim.now, sealFactor: 1 });
    A.openChests(sim.w, h, { reason: "click" }, null);
    const ships = sim.state.herd.log.filter((e) => e && e[1] === "ship").map((e) => e[3]);
    assert.deepEqual(ships.slice(-2), ["Refactor the webhook sender so  retries", "Commit"]);
    noErrors(sim);
  });

  test("a title that only repeats the agent's space, tab or pane name tells nothing (round 4)", () => {
    // Claude Code titles its terminal after the folder, and herdr names the space after it too
    const who = { address: "t1", program: { key: "claude", name: "Claude Code" }, app: "claude-code", spaceName: "ref-client", tabName: "api", paneName: "left" };
    assert.equal(A.tellingTitle("ref-client", who), "");
    assert.equal(A.tellingTitle("✳ Ref-Client  ", who), "", "trimmed, any case, after the status glyph");
    assert.equal(A.questName("⠋ ref-client", who), "");
    assert.equal(A.questName("API", who), "", "the tab's name");
    assert.equal(A.questName("✳ left", who), "", "the pane's name");
    assert.equal(A.tellingTitle("✳ API", who), "");
    assert.equal(A.tellingTitle("Fix ref-client login", who), "Fix ref-client login", "more than the name tells");
    // the person's own name for the pane or tab, asked about as itself (chrome.taskLabel's fallback)
    assert.equal(A.tellingTitle("left", who), "left");
    assert.equal(A.tellingTitle("api", who), "api");
    assert.equal(A.tellingTitle("2", Object.assign({}, who, { tabName: "2" })), "", "a tab's bare position is no name");
    assert.equal(A.questName("left", who), "", "the engine never takes a place name for a task");
    // the answer depends on the places: the cache must not hand one place's answer to another
    for (let round = 0; round < 2; round++) {
      assert.equal(A.tellingTitle("rnd-qa", Object.assign({}, who, { spaceName: "rnd-qa" })), "");
      assert.equal(A.tellingTitle("rnd-qa", Object.assign({}, who, { spaceName: "web" })), "rnd-qa");
      assert.equal(A.tellingTitle("api", Object.assign({}, who, { tabName: "web" })), "api");
      assert.equal(A.tellingTitle("✳ api", who), "");
      assert.equal(A.tellingTitle("✳ api", Object.assign({}, who, { tabName: "main" })), "api");
      assert.equal(A.questName("left", Object.assign({}, who, { paneName: null })), "left");
    }
  });

  test("an agent titled after its space: its task, chest and journal never carry the space's name", () => {
    const sim = new Sim().set("t1", "working", { title: "✳ herdr-app" }).tick(200);
    assert.equal(sim.live("t1").task.title, "", "the space's name is no Quest name");
    sim.set("t1", "working", { title: "Fix the flaky test" }).tick();
    assert.equal(sim.live("t1").task.title, "Fix the flaky test");
    sim.set("t1", "working", { title: "herdr-app" }).tick(); // back to the folder name: the task keeps its title
    assert.equal(sim.live("t1").task.title, "Fix the flaky test");
    sim.set("t1", "idle").tick(10); // watched: opens once the 8-tick close has run
    const ship = sim.state.herd.log.filter((e) => e[1] === "ship").at(-1);
    assert.equal(ship[3], "Fix the flaky test");
    // a task that only ever had the space's name: the journal says "Commit"
    sim.set("t1", "working", { title: "herdr-app" }).tick(200).set("t1", "idle").tick(10);
    assert.equal(sim.state.herd.log.filter((e) => e[1] === "ship").at(-1)[3], "Commit");
    // an older chest that recorded the space's name (an earlier build), opened while off duty
    const h = sim.hero("t1");
    sim.drop("t1").tick();
    h.pend = [{ min: 30, fmin: 0, title: "herdr-app", at: sim.now - 25 * 3600000, sealFactor: 1 }];
    sim.tick(60);
    const unrev = sim.state.herd.log.filter((e) => e[1] === "unrev").at(-1);
    assert.equal(unrev[3], "", "off duty: the hero's last space still counts");
    noErrors(sim);
  });

  test("tellingTitle remembers its answers per title and terminal, never across programs or terminals", () => {
    const codex = { address: "t1", program: { key: "codex", name: "Codex" }, app: "codex" };
    const codex2 = { address: "t2", program: { key: "codex", name: "Codex" }, app: "codex" };
    const claude = { address: "t2", program: { key: "claude", name: "Claude Code" }, app: "claude-code" };
    for (let round = 0; round < 2; round++) { // the second round answers from the cache
      assert.equal(A.tellingTitle("✳ Codex", codex), "");
      assert.equal(A.tellingTitle("✳ Codex", claude), "Codex");
      assert.equal(A.tellingTitle("t1", codex), "");
      assert.equal(A.tellingTitle("t1", claude), "t1");
      // the same program in another terminal: only the address tells them apart
      assert.equal(A.tellingTitle("t1", codex2), "t1", "another terminal's id is a title like any other");
      assert.equal(A.tellingTitle("t2", codex2), "");
      assert.equal(A.tellingTitle("Claude Code", null), "Claude Code");
      assert.equal(A.tellingTitle("Claude Code", claude), "");
    }
    // past its size the cache starts afresh; answers stay the same
    for (let i = 0; i < 1200; i++) {
      assert.equal(A.tellingTitle(`⠋ Task ${i}`, codex), `Task ${i}`);
      assert.ok(A._internal.tellingCacheSize() <= A._internal.TELLING_MAX, "the cache stays bounded");
    }
    assert.ok(A._internal.tellingCacheSize() > 0);
    assert.equal(A.tellingTitle("✳ Codex", codex), "");
    assert.equal(A.tellingTitle("", codex), "");
    assert.equal(A.tellingTitle(null, codex), "");
  });

  test("flipping back to working inside the 8 ticks continues the same task", () => {
    const sim = new Sim().set("t1", "working").tick(120);
    const task = sim.live("t1").task;
    sim.set("t1", "done").tick(5).set("t1", "working").tick(60);
    assert.equal(sim.live("t1").task, task);
    sim.set("t1", "done").tick(8);
    assert.equal(sim.hero("t1").pend.length, 1);
    assert.ok(near(sim.hero("t1").pend[0].min, 3));
  });

  test("under 1.5 minutes no chest drops", () => {
    const sim = new Sim().set("t1", "working").tick(80).set("t1", "done").tick(8);
    assert.equal(sim.live("t1").task, null);
    assert.equal(sim.hero("t1").pend.length, 0);
    assert.equal(sim.hero("t1").sig.n, 0);
  });

  test("blocked time never counts and blocked never closes a task", () => {
    const sim = new Sim().set("t1", "working").tick(60).set("t1", "blocked").tick(300);
    const task = sim.live("t1").task;
    assert.equal(task.workSec, 60);
    assert.equal(task.blockedSec, 300);
    assert.equal(task.blocks, 1);
    sim.set("t1", "working").tick(60).set("t1", "done").tick(8);
    assert.ok(near(sim.hero("t1").pend[0].min, 2));
  });

  test("blocked -> done held 8 ticks closes the task; blocked -> idle closes and opens at once", () => {
    const done = new Sim().set("t1", "working").tick(120).set("t1", "blocked").tick(30).set("t1", "done").tick(7);
    assert.ok(done.live("t1").task);
    done.tick();
    assert.equal(done.live("t1").task, null);
    assert.equal(done.hero("t1").pend.length, 1);
    const idle = new Sim().set("t1", "working").tick(120).set("t1", "blocked").tick(30).set("t1", "idle").tick(8);
    assert.equal(idle.live("t1").task, null);
    assert.equal(idle.hero("t1").pend.length, 0);
    assert.ok(near(idle.state.herd.seals, 0.2, 1e-6), "watched: credited at once");
  });

  test("idle -> working opens a fresh task", () => {
    const sim = new Sim().set("t1", "idle").tick(3).set("t1", "working").tick(2);
    assert.equal(sim.live("t1").task.workSec, 2);
    assert.equal(sim.live("t1").state, "questing");
  });

  test("the bubble shows after 2 blocked ticks", () => {
    const sim = new Sim().set("t1", "working").tick(3).set("t1", "blocked").tick();
    assert.equal(sim.live("t1").bubbleShown, false);
    sim.tick();
    assert.equal(sim.live("t1").bubbleShown, true);
  });

  test("a Quest name cut to 40 units never ends in half an emoji (herdr rejects a lone surrogate)", () => {
    // the emoji starts at unit 39: a plain cut would keep its high surrogate alone
    const sim = new Sim().set("t1", "working", { title: "✳ Wire the release checklist into CI now \u{1F680} and tag it" }).tick(120);
    const title = sim.live("t1").task.title;
    assert.equal(title, "Wire the release checklist into CI now");
    sim.set("t1", "done").tick(8);
    const h = sim.hero("t1");
    assert.equal(h.pend[0].title, "Wire the release checklist into CI now", "the chest records the whole characters");
    assert.equal(A.questName("Fix the login flow for the mobile apps \u{1F680} and more", null), "Fix the login flow for the mobile apps");
    assert.equal(A.questName("Fix the login flow for the mobile app \u{1F680} and more", null), "Fix the login flow for the mobile app \u{1F680}", "a pair that fits stays");
    for (let k = 30; k < 45; k++) {
      const t = A.questName("x".repeat(k) + "\u{1F680}".repeat(10), null);
      assert.ok(t.isWellFormed() && t.length <= 40, `emoji from unit ${k}`);
    }
    noErrors(sim);
  });

  test("closing records the task on the class signature", () => {
    const sim = new Sim().set("t1", "working").tick(240).set("t1", "done").tick(8);
    const h = sim.hero("t1");
    assert.equal(h.sig.n, 1);
    assert.equal(h.sig.tm[0], 4);
    assert.equal(h.st.tasks, 1);
  });

  test("a provisional class switch asks autopilot for a class weapon at once (the old one is off-class)", () => {
    const sim = new Sim().set("t1", "working").tick(30);
    const h = sim.hero("t1");
    const live = sim.live("t1");
    // a Lv 12 provisional Refactorer (long tasks) whose last tasks were 3-minute ones
    h.L = 12;
    h.cls = D.CLASS_IDX.refactorer;
    h.prov = 1;
    h.sig = { tm: [3, 3, 3, 3, 3], tb: [0, 0, 0, 0, 0], ts: [0, 0, 0, 0, 0], blocks: 0, workMin: 15, subTasks: 0, n: 5 };
    sim.w.rt.apGear.clear();
    live.task.workSec = 180;
    sim.w.rt.notes = [];
    A.closeTask(sim.w, h, live, "done", W.makeEmitter(sim.w));
    assert.equal(h.cls, D.CLASS_IDX.hotfixer, "switched for free (D§4.2)");
    assert.ok(sim.w.rt.apGear.has(h.id), "the targeted equip sweep runs this tick");
    // its note is about that hero; its short forms drop the epithet, then "provisional" (round 4c)
    const n = sim.w.rt.notes.find((x) => x.text === `${h.name}: provisional Hotfixer`);
    const f = h.name.split(" ")[0];
    assert.equal(n.heroId, h.id);
    assert.deepEqual(n.short, [`${f}: provisional Hotfixer`, `${f}: Hotfixer`]);
  });

  test("a provisional switch re-spends the refunded points only while the herd's auto-learn is on (and the autopilot master switch)", () => {
    for (const mode of ["on", "learn off", "master off", "hero off"]) {
      const sim = new Sim().set("t1", "working").tick(30);
      const h = sim.hero("t1");
      const live = sim.live("t1");
      Object.assign(h, { L: 12, cls: D.CLASS_IDX.refactorer, prov: 1, sp: [0, 0, 0, 0, 0, 0, 0], spFree: 11 });
      h.sig = { tm: [3, 3, 3, 3, 3], tb: [0, 0, 0, 0, 0], ts: [0, 0, 0, 0, 0], blocks: 0, workMin: 15, subTasks: 0, n: 5 };
      const cfg = sim.state.herd.cfg;
      if (mode === "learn off") cfg.auto.learn = false;
      if (mode === "master off") cfg.autopilot = false;
      if (mode === "hero off") h.autoLearn = false;
      live.task.workSec = 180;
      A.closeTask(sim.w, h, live, "done", null);
      assert.equal(h.cls, D.CLASS_IDX.hotfixer, `${mode}: switched`);
      const spent = h.sp.reduce((a, b) => a + b, 0);
      assert.equal(spent + h.spFree, 11, `${mode}: nothing lost`);
      assert.equal(spent, mode === "on" ? 11 : 0, `${mode}: ${mode === "on" ? "re-spent at once" : "the points wait for the person"}`);
      sim.tick(70); // an autopilot pass: it spends nothing while a switch is off either
      assert.equal(h.sp.reduce((a, b) => a + b, 0), mode === "on" ? 11 : 0, `${mode}: after an autopilot pass`);
      noErrors(sim);
    }
  });
});

describe("Commit Chests and seen (D§2.4)", () => {
  test("done -> idle opens every pending chest: Seals, gold, XP, items, journal, First Commit", () => {
    const sim = new Sim().set("t1", "working").tick(600).set("t1", "done").tick(8);
    const h = sim.hero("t1");
    assert.equal(h.pend.length, 1);
    const xp0 = h.xp + F.need(1) * (h.L > 1 ? 1 : 0);
    const gold0 = sim.state.herd.gold;
    sim.set("t1", "idle").tick();
    assert.equal(h.pend.length, 0);
    assert.ok(near(sim.state.herd.seals, 1, 1e-6), "10 working minutes = 1 Seal");
    assert.ok(near(h.st.seals, 1, 1e-6));
    assert.ok(sim.state.herd.gold > gold0);
    assert.ok(h.xp !== xp0 || h.L > 1);
    assert.ok(sim.state.herd.log.some((e) => e[1] === "ship" && e[2] === h.id && e[3] === "Fix the flaky test" && e[4] === 1));
    assert.ok(sim.state.herd.badges.includes("first_commit"));
    assert.ok(near(sim.state.herd.meter, 1, 1e-6), "Seals fill the Sprint meter");
    noErrors(sim);
  });

  test("chest items wait in herd.inbox (saved) and are offered one per tick, oldest first", () => {
    const sim = new Sim().set("t1", "working").tick(10);
    const h = sim.hero("t1");
    h.pend = [{ min: 120, fmin: 0, title: "big", at: sim.now, sealFactor: 1 }];
    const r = A.openChests(sim.w, h, { reason: "click" });
    assert.equal(r.items.length, 12);
    const inbox = sim.state.herd.inbox;
    assert.equal(inbox.length, 12, "rolled and logged at once, offered later");
    assert.deepEqual(inbox.map((x) => x[0]), new Array(12).fill(h.id));
    const first = inbox[0][1];
    const text = W.serialize(sim.w);
    assert.ok(text.includes(String(first.uid)), "queued items are in the save");
    for (let k = 11; k >= 0; k--) {
      sim.tick();
      assert.equal((sim.state.herd.inbox || []).length, k);
    }
    assert.equal(sim.state.herd.inbox, undefined);
    const where = (it) => h.eq.some((x) => x && x.uid === it.uid) || sim.state.herd.stash.some((x) => x.uid === it.uid);
    const kept = r.items.filter(where).length;
    assert.ok(kept >= 0 && kept <= 12);
    noErrors(sim);
  });

  test("a queued chest item with ids from another content generation is repaired before it is offered", () => {
    const sim = new Sim().set("t1", "working").tick(10);
    const h = sim.hero("t1");
    const bad = { uid: 4000, base: 4242, ilvl: 5, rar: 9, pol: 0, aff: [[77, 50]], flags: 0, prop: 99 };
    sim.state.herd.inbox = [[h.id, bad]];
    sim.tick();
    assert.equal(sim.state.herd.inbox, undefined);
    assert.deepEqual([bad.base, bad.rar, bad.prop, bad.aff], [0, 4, 1, [[0, 50]]]);
    const where = h.eq.includes(bad) || sim.state.herd.stash.includes(bad);
    assert.ok(where, "offered: worn or stashed");
    assert.doesNotThrow(() => I.itemName(bad));
    noErrors(sim);
  });

  test("working -> idle (also across a seq gap) closes and opens at once: the person watched", () => {
    const sim = new Sim().set("t1", "working").tick(300);
    const a = sim.agents.get("t1");
    a.status = "idle";
    a.seq += 3; // several changes we never saw
    sim.tick(8);
    assert.equal(sim.hero("t1").pend.length, 0);
    assert.ok(near(sim.state.herd.seals, 0.5, 1e-6));
  });

  test("focusing the terminal opens pending chests, but only while the window is active", () => {
    const sim = new Sim().set("t1", "working").tick(200).set("t1", "done").tick(8);
    sim.active = false;
    sim.focus = "t1";
    sim.tick();
    assert.equal(sim.hero("t1").pend.length, 1);
    sim.active = true;
    sim.tick();
    assert.equal(sim.hero("t1").pend.length, 0);
    assert.ok(sim.state.herd.seals > 0);
  });

  test("done -> working opens a new task; the old chest stays pending", () => {
    const sim = new Sim().set("t1", "working").tick(200).set("t1", "done").tick(8).set("t1", "working").tick(30);
    assert.equal(sim.hero("t1").pend.length, 1);
    assert.equal(sim.live("t1").task.workSec, 30);
  });

  test("chests merge within 5 minutes; Seals are linear (4 x 10 min = 1 x 40 min)", () => {
    const four = new Sim();
    four.set("t1", "working");
    for (let i = 0; i < 4; i++) four.set("t1", "working").tick(600).set("t1", "done").tick(8);
    assert.equal(four.hero("t1").pend.length, 4, "10-minute tasks are more than 5 minutes apart");
    const merged = new Sim().set("t1", "working").tick(120).set("t1", "done").tick(8).set("t1", "working").tick(120).set("t1", "done").tick(8);
    assert.equal(merged.hero("t1").pend.length, 1);
    assert.ok(near(merged.hero("t1").pend[0].min, 4));
    const one = new Sim().set("t1", "working").tick(2400).set("t1", "done").tick(8);
    four.set("t1", "idle").tick();
    one.set("t1", "idle").tick();
    assert.ok(near(four.state.herd.seals, 4, 1e-6));
    assert.ok(near(one.state.herd.seals, 4, 1e-6));
    assert.equal(A.chestInfo({ min: 40, sealFactor: 1 }).tier, "silver");
    assert.equal(A.chestInfo({ min: 61, sealFactor: 1 }).tier, "gold");
    assert.equal(A.chestInfo({ min: 5, sealFactor: 1 }).tier, "wooden");
  });

  test("the 120-minute cap is per task; merged chests never lose Seals", () => {
    const long = new Sim().set("t1", "working").tick(150 * 60).set("t1", "done").tick(8);
    const h = long.hero("t1");
    assert.ok(near(h.pend[0].min, 120), "a 150-minute task counts 120 minutes");
    assert.equal(A.chestInfo(h.pend[0]).raw, 12);
    // a 20-chest backlog merges new chests into the last one: their Seals add up past 12
    for (let i = 0; i < 19; i++) h.pend.unshift({ min: 120, fmin: 0, title: "old", at: T0 - 86400000 * (i + 1), sealFactor: 1 });
    long.set("t1", "working").tick(30 * 60).set("t1", "done").tick(8);
    assert.equal(h.pend.length, 20);
    assert.ok(near(h.pend[19].min, 150));
    long.set("t1", "idle").tick();
    assert.ok(near(long.state.herd.seals, 20 * 12 + 3, 1e-6));
  });

  test("a terminal that ends closes its task into a pending chest; after 24 h it opens Unreviewed", async () => {
    const sim = new Sim().set("t1", "working").tick(600);
    const h = sim.hero("t1");
    sim.drop("t1").tick();
    assert.equal(h.pend.length, 1);
    assert.ok(near(h.pend[0].min, 10));
    sim.jump(23 * 3600000);
    assert.equal(h.pend.length, 1, "not yet");
    const gold0 = sim.state.herd.gold;
    sim.jump(2 * 3600000);
    assert.equal(h.pend.length, 0);
    assert.equal(sim.state.herd.seals, 0, "Unreviewed chests give no Seals");
    assert.ok(sim.state.herd.gold > gold0, "half gold");
    assert.ok(!sim.state.herd.log.some((e) => e[1] === "ship"));
    // where the chest went: one journal line, and the digest lists it
    const lines = sim.state.herd.log.filter((e) => e[1] === "unrev");
    assert.equal(lines.length, 1, "one 'opened Unreviewed' journal line");
    assert.equal(lines[0][2], h.id);
    assert.equal(lines[0][3], "Fix the flaky test", "it names the task");
    assert.equal(lines[0][4], 1, "the count");
    const dg = (await import("../mods/down-the-stack/game/herd.js")).digest(sim.state, 0);
    assert.equal(dg.unreviewed.length, 1);
    assert.equal(dg.empty, false);
    noErrors(sim);
  });

  test("a pane closed inside the 8-tick close after working -> idle still opens its chest: the person watched", () => {
    const watched = new Sim().set("t1", "working").tick(600).set("t1", "idle").tick(3);
    const h = watched.hero("t1");
    assert.equal(h.pend.length, 0);
    watched.drop("t1").tick();
    assert.equal(h.pend.length, 0, "no pending chest left on an off-duty hero");
    assert.ok(near(watched.state.herd.seals, 1, 1e-6), "1 Seal, as if it had stayed open 8 ticks");
    // a finish nobody saw (done) or a waiting agent still leaves a pending chest
    const unseen = new Sim().set("t1", "working").tick(600).set("t1", "done").tick(3);
    const hu = unseen.hero("t1");
    unseen.drop("t1").tick();
    assert.equal(hu.pend.length, 1);
    assert.equal(unseen.state.herd.seals, 0);
    const waiting = new Sim().set("t1", "working").tick(600).set("t1", "blocked").tick(3);
    const hw = waiting.hero("t1");
    waiting.drop("t1").tick();
    assert.equal(hw.pend.length, 1);
    noErrors(watched);
  });

  test("an off-duty hero's chest is claimed in full by a click (claimChest)", () => {
    const sim = new Sim().set("t1", "working").tick(600);
    const h = sim.hero("t1");
    sim.drop("t1").tick();
    const r = W.command(sim.w, "claimChest", { heroId: h.id }, sim.now);
    assert.equal(r.ok, true);
    assert.ok(near(sim.state.herd.seals, 1, 1e-6));
  });
});

describe("Unblocked (D§2.6)", () => {
  const buff = (live) => (live.buffs || []).find((b) => b.id === "unblocked");

  test("blocked >= 10 s with >= 60 s of work in the task grants Unblocked; cooldown 300 Questing ticks", () => {
    const sim = new Sim().set("t1", "working").tick(61).set("t1", "blocked").tick(10).set("t1", "working").tick();
    const live = sim.live("t1");
    const h = sim.hero("t1");
    const b = buff(live);
    assert.ok(b, "Unblocked buff");
    assert.equal(b.dmg, 0.15);
    assert.equal(b.xp, 0.15);
    assert.ok(A.unblockedActive(h, sim.w.rt.tick));
    assert.ok(sim.w.rt.fx.some((f) => f.kind === "unblocked" && f.heroId === h.id && f.text === "Unblocked"));
    const until = h.cd.unblockedUntil;
    sim.set("t1", "blocked").tick(20);
    assert.equal(h.cd.unblockedUntil, until + 20, "frozen while not Questing");
    sim.set("t1", "working").tick();
    assert.equal(h.cd.unblockedUntil, until + 20, "no second grant inside the cooldown");
  });

  test("blocked time is wall-clock time: an offline gap counts towards Unblocked and the blocked clock", () => {
    // 15 minutes blocked while the laptop slept (no ticks): the views' clock reads 15 min, and
    // resuming grants Unblocked (D§2.6 "≥ 10 s blocked")
    const sim = new Sim().set("t1", "working").tick(120).set("t1", "blocked").tick(2);
    sim.jump(15 * 60000);
    const live = sim.live("t1");
    const t = sim.w.rt.tick;
    // seen blocked at the snapshot 1 s after the last working one: 901 s of wall-clock time since
    assert.equal(t - live.blockedSince, 15 * 60 + 1, "tick - blockedSince is real seconds");
    assert.equal(A.blockedSec(sim.w, live), 15 * 60 + 1);
    assert.ok(live.bubbleShown);
    sim.set("t1", "working").tick();
    assert.ok(buff(sim.live("t1")), "Unblocked after the gap");
    // the gap and the resume in the same snapshot: the transition reads the wall clock
    const same = new Sim().set("t1", "working").tick(120).set("t1", "blocked").tick(2);
    same.set("t1", "working");
    same.jump(5 * 60000);
    assert.ok(buff(same.live("t1")), "Unblocked when the answer came during the gap");
    // a catch-up that drops seconds (a 30 s stall runs 5 ticks) keeps the clock on real time too
    const stall = new Sim().set("t1", "working").tick(120).set("t1", "blocked").tick(2);
    stall.jump(30000);
    assert.equal(stall.w.rt.tick - stall.live("t1").blockedSince, 31);
    noErrors(sim);
  });

  test("no Unblocked after a short block or early in a task", () => {
    const shortBlock = new Sim().set("t1", "working").tick(61).set("t1", "blocked").tick(9).set("t1", "working").tick();
    assert.ok(!buff(shortBlock.live("t1")));
    const early = new Sim().set("t1", "working").tick(30).set("t1", "blocked").tick(30).set("t1", "working").tick();
    assert.ok(!buff(early.live("t1")));
  });
});

describe("flap guard (D§2.5)", () => {
  test("more than 6 changes in 60 s pause chest drops for 5 minutes; the task keeps its minutes and closes later", () => {
    const sim = new Sim().set("t1", "working").tick(120);
    for (let i = 0; i < 7; i++) sim.set("t1", i % 2 ? "working" : "done").tick();
    const live = sim.live("t1");
    assert.ok(A.flapPaused(live, sim.w.rt.tick));
    sim.set("t1", "done").tick(20);
    assert.ok(live.task, "held open while paused");
    assert.equal(sim.hero("t1").pend.length, 0);
    sim.tick(300);
    assert.equal(live.task, null);
    assert.equal(sim.hero("t1").pend.length, 1);
    assert.ok(sim.hero("t1").pend[0].min > 2);
  });
});

describe("Forklings (D§2.7)", () => {
  test("sub-agents attach to their root (parent chain), mark the task, and add 0.25 x their minutes", () => {
    const sim = new Sim().set("t1", "working").tick(2);
    sim.subs = [
      { address: "k1", parent: "t1", status: "working", title: "sub", program: prog() },
      { address: "k2", parent: "k1", status: "error", title: "subsub", program: prog() },
    ];
    sim.tick(120);
    const live = sim.live("t1");
    assert.deepEqual(live.forklings.map((f) => [f.address, f.status]), [["k1", "working"], ["k2", "blocked"]]);
    assert.equal(live.task.spawned, true);
    assert.ok(near(live.task.forkMin, 0.5, 1e-6), "one working Forkling: 0.25 x 2 minutes");
    assert.equal(sim.state.heroes.length, 1, "sub-agents never get their own hero");
    // parent idle, a Forkling working: Supervising, and the task stays open until it settles
    sim.set("t1", "idle").tick();
    assert.equal(live.state, "supervising");
    sim.subs = [];
    sim.tick();
    assert.equal(live.forklings.length, 0);
    assert.equal(live.state, "resting");
  });

  test("an orphan joins the most recently seen hero of its program; with none it plays top-level", () => {
    const sim = new Sim().set("t1", "working").tick();
    sim.subs = [{ address: "o1", parent: "gone", status: "working", title: "", program: prog() }];
    sim.tick();
    assert.equal(sim.live("t1").forklings.length, 1);
    const lone = new Sim();
    lone.subs = [{ address: "o2", parent: "gone", status: "working", title: "", program: prog("pi") }];
    lone.tick(3);
    assert.equal(lone.state.heroes.length, 1);
    assert.equal(lone.hero("o2").seat, "nospace/pi");
    assert.equal(lone.live("o2").state, "questing");
    lone.subs = [];
    lone.tick();
    assert.equal(lone.w.rt.live.size, 0);
    noErrors(lone);
  });

  test("a kept sub-agent listed in agents() with a parent is a Forkling too", () => {
    const sim = new Sim().set("t1", "working").set("t2", "working", { parent: "t1" }).tick(3);
    assert.equal(sim.state.heroes.length, 1);
    assert.equal(sim.live("t1").forklings[0].address, "t2");
  });
});

describe("first sight, shift and the why tooltip", () => {
  test("tab.working_since credits min(now - since, 10 min) for Seals only", () => {
    const sim = new Sim();
    sim.tabs = { tb1: { working_since: T0 - 30 * 60000 } };
    sim.set("t1", "working").tick();
    const task = sim.live("t1").task;
    assert.equal(task.creditSec, 600);
    assert.equal(task.workSec, 1);
    sim.set("t1", "done").tick(8);
    assert.ok(near(sim.hero("t1").pend[0].min, 10 + 1 / 60, 1e-6));
  });

  test("Daily Shift: minutes accrue per working tick, Seals weigh 0.75 past 4 h, the day resets", () => {
    const sim = new Sim().set("t1", "working").tick(60);
    const h = sim.hero("t1");
    assert.ok(near(h.shift.min, 1, 1e-6));
    assert.equal(h.shift.day, sim.state.herd.day);
    h.shift.min = 240;
    sim.tick(600).set("t1", "done").tick(8);
    const p = h.pend[0];
    assert.ok(near(p.sealFactor, (60 + 600 * 0.75) / 660, 1e-6));
    const day = sim.state.herd.day;
    sim.jump(24 * 3600000);
    assert.equal(sim.state.herd.day, day + 1);
    sim.set("t1", "working").tick(2);
    assert.equal(h.shift.day, day + 1);
    assert.ok(h.shift.min < 0.1);
  });

  test("heroState precedence: Waiting > Questing > Supervising > Shipped > Resting", () => {
    const L = (status, forklings = [], crashedUntil = 0) => ({ status, forklings, crashedUntil, nowTick: 10 });
    const fw = [{ status: "working" }];
    assert.equal(A.heroState(L("blocked", fw)), "waiting");
    assert.equal(A.heroState(L("working", fw)), "questing");
    assert.equal(A.heroState(L("working", [], 20)), "crashed");
    assert.equal(A.heroState(L("done", fw)), "supervising");
    assert.equal(A.heroState(L("done")), "shipped");
    assert.equal(A.heroState(L("idle")), "resting");
  });

  test("live.why carries the numbers of the D§2.9 tooltip", () => {
    const sim = new Sim().set("t1", "working").tick(5);
    const why = sim.live("t1").why;
    assert.equal(why.state, "questing");
    assert.equal(why.working, 1);
    assert.equal(why.freshEyes, 1);
    assert.ok(why.xpPerMin > 0);
    assert.equal(why.shiftBand, 0);
    assert.equal(why.nextBandMin, 240);
    assert.equal(why.flapPaused, false);
    assert.equal(why.pending, 0);
  });

  test("live.why's party, banner and crowding counts (kept for the tick) match a fresh scan", async () => {
    const { makeWorld, makeEv } = await import("./helpers/engine.mjs");
    const w = makeWorld({ heroes: [
      { cls: "refactorer", L: 10 }, { cls: "hotfixer", L: 10 }, { cls: "shellmancer", L: 10 },
      { cls: "forkbinder", L: 10, mapId: "1-2" }, { cls: "rubberducker", L: 10, space: "s2" },
    ] });
    const pairs = A.liveHeroes(w);
    const [h1, l1] = pairs[0];
    const [h2, l2] = pairs[1];
    const [, l3] = pairs[2];
    w.rt.tick = 10;
    for (const [, l] of pairs) l.nowTick = 10;
    const fresh = (h, l) => { w.rt.whyRooms = null; return A.whyOf(w, h, l); };
    const keys = (y) => [y.party, y.banner, y.crowding, y.xpPerMin];
    const before = A.whyOf(w, h1, l1);
    const kept = w.rt.whyRooms;
    assert.ok(kept, "the counts are kept for the tick");
    assert.deepEqual(keys(A.whyOf(w, h1, l1)), keys(fresh(h1, l1)));
    assert.ok(before.party > 0, "two room mates questing");
    // a mate stops (its stepStatus on the same tick): the next hero's numbers follow at once
    A.whyOf(w, h1, l1);
    l2.status = "blocked";
    A.stepStatus(w, h2, l2, makeEv());
    assert.equal(l2.state, "waiting");
    const after = A.whyOf(w, h1, l1);
    assert.ok(after.party < before.party, "one mate fewer");
    assert.deepEqual(keys(after), keys(fresh(h1, l1)));
    // a pin changes outside the status loop (reconcile): counted again on the next tick
    l3.pinned = true;
    w.rt.tick = 11;
    assert.equal(A.whyOf(w, h1, l1).banner, D.TUNING.party.banner);
    assert.deepEqual(keys(A.whyOf(w, h1, l1)), keys(fresh(h1, l1)));
    for (const [h, l] of pairs) assert.deepEqual(A.whyOf(w, h, l), fresh(h, l), h.name);
  });

  test("live.why reports the level gap as combat.kill applies it: none in the Backlog (D§9.8)", async () => {
    const { makeWorld } = await import("./helpers/engine.mjs");
    // the Backlog's mobs are level 100 and heroes stop at Lv 100, so the clamp binds only past the
    // cap (a hand-edited save); the test keeps whyOf in step with combat.kill all the same
    const w = makeWorld({ heroes: [{ cls: "refactorer", L: 100, mapId: "1-1" }, { cls: "refactorer", L: 106 }] });
    const [[h1, l1], [h2, l2]] = A.liveHeroes(w);
    l2.mapId = D.BACKLOG.id;
    l2.floor = 1;
    const low = A.whyOf(w, h1, l1);
    assert.ok(low.gap < 1, `1-1 is far below Lv 100: ×${low.gap}`);
    const bl = A.whyOf(w, h2, l2);
    assert.equal(bl.gap, 1, "the Backlog has no gap penalty");
    assert.ok(bl.xpPerMin > 0);
    assert.equal(bl.xpPerMin, Math.round(D.TUNING.refKillsPerMin * F.mobXP(D.BACKLOG.level) * (1 + bl.xpPct) * bl.freshEyes * bl.shiftKill * bl.crowding * bl.working));
  });

  test("live.why refreshes every 5 ticks, heroes taking turns (a fifth of the herd a tick), and at once on a state change", async () => {
    const { makeWorld, makeEv } = await import("./helpers/engine.mjs");
    const w = makeWorld({ heroes: Array.from({ length: 10 }, (_, i) => ({ cls: "refactorer", L: 10 + i })) });
    const pairs = A.liveHeroes(w);
    const ev = makeEv();
    const step = (tick) => {
      w.rt.tick = tick;
      const before = pairs.map(([, l]) => l.why);
      for (const [h, l] of pairs) A.stepStatus(w, h, l, ev);
      return pairs.filter(([, l], i) => l.why !== before[i]).map(([h]) => h.id);
    };
    assert.equal(step(100).length, 10, "first sight: every hero");
    const seen = new Map();
    for (let t = 101; t <= 105; t++) {
      const ids = step(t);
      assert.equal(ids.length, 2, `tick ${t}: ${ids}`);
      for (const id of ids) {
        assert.equal((t + id) % 5, 0);
        seen.set(id, (seen.get(id) || 0) + 1);
      }
    }
    assert.deepEqual([...seen.values()], new Array(10).fill(1), "each hero once in 5 ticks");
    // a state change refreshes that hero on the spot
    const [h, l] = pairs.find(([x]) => (106 + x.id) % 5 !== 0);
    l.status = "blocked";
    assert.ok(step(106).includes(h.id));
    assert.equal(l.why.state, "waiting");
  });

  test("pinned, focused, program, title and space are mirrored on the live record", () => {
    const sim = new Sim().set("t1", "idle", { pinned: true, title: "Write docs", tab_name: "docs" });
    sim.focus = "t1";
    sim.tick();
    const live = sim.live("t1");
    assert.equal(live.pinned, true);
    assert.equal(live.focused, true);
    assert.equal(live.title, "Write docs");
    assert.equal(live.program.key, "claude");
    assert.equal(live.space, "s1");
    assert.equal(live.tabName, "docs");
    assert.equal(sim.hero("t1").lastTab, "docs");
  });
});

describe("Rebind (D§3.2)", () => {
  test("moves a live agent and its task onto a benched hero", () => {
    const sim = new Sim().set("t1", "working").set("t2", "idle", { program: prog("codex"), app: "codex" }).tick(30);
    const benched = sim.hero("t2");
    sim.drop("t2").tick();
    const before = sim.hero("t1");
    const task = sim.live("t1").task;
    const r = W.command(sim.w, "rebind", { heroId: benched.id, address: "t1" }, sim.now);
    assert.equal(r.ok, true);
    assert.equal(sim.hero("t1"), benched);
    assert.equal(sim.live("t1").task, task);
    assert.equal(benched.addr, "t1");
    assert.ok(!sim.w.rt.live.has(before.id));
    sim.tick(5);
    assert.equal(sim.hero("t1"), benched, "stays bound");
    assert.equal(W.command(sim.w, "rebind", { heroId: benched.id, address: "t1" }).ok, false);
    assert.equal(W.command(sim.w, "rebind", { heroId: before.id, address: "nope" }).error, "No live agent at that address");
    noErrors(sim);
  });
});
