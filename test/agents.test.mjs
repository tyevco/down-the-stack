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
    assert.equal(saved.heroes.length, 6, "Contractors are never saved");
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
      h.seenAt = T0 + i * 1000;
      h.eq[1] = { uid: 9000 + i, base: D.BASE_LIST.findIndex((b) => b.slot === "hat" && b.tier === 1), ilvl: 5, rar: 2, pol: 0, aff: [[0, 50], [4, 50]], flags: 0, prop: -1 };
      sim.state.heroes.push(h);
    }
    const victim = sim.state.heroes[4];
    sim.set("n1", "idle").tick();
    assert.equal(sim.state.heroes.length, 30);
    assert.ok(!sim.state.heroes.includes(victim));
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

  test("tellingTitle remembers its answers per title and terminal, never across programs or terminals", () => {
    const codex = { address: "t1", program: { key: "codex", name: "Codex" }, app: "codex" };
    const claude = { address: "t2", program: { key: "claude", name: "Claude Code" }, app: "claude-code" };
    for (let round = 0; round < 2; round++) { // the second round answers from the cache
      assert.equal(A.tellingTitle("✳ Codex", codex), "");
      assert.equal(A.tellingTitle("✳ Codex", claude), "Codex");
      assert.equal(A.tellingTitle("t1", codex), "");
      assert.equal(A.tellingTitle("t1", claude), "t1");
      assert.equal(A.tellingTitle("Claude Code", null), "Claude Code");
      assert.equal(A.tellingTitle("Claude Code", claude), "");
    }
    // past its size the cache starts afresh; answers stay the same
    for (let i = 0; i < 1200; i++) assert.equal(A.tellingTitle(`⠋ Task ${i}`, codex), `Task ${i}`);
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
    A.closeTask(sim.w, h, live, "done", null);
    assert.equal(h.cls, D.CLASS_IDX.hotfixer, "switched for free (D§4.2)");
    assert.ok(sim.w.rt.apGear.has(h.id), "the targeted equip sweep runs this tick");
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

  test("a terminal that ends closes its task into a pending chest; after 24 h it opens Unreviewed", () => {
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
