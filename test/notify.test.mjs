// Opt-in notifications in the engine (D§11.15): world.js raises milestones ("boss" a herd-first
// boss kill, "lts" an LTS or Keepsake drop, "principal" a hero reaching Principal) into
// herd.milestones, only while the kind is on, at most 3 a local day over all kinds (the count and
// its day are saved), and only from live play: never on the first call after a load, an offline
// gap or a clock behind. The host drains them (takeMilestones); host-notify.test.mjs covers the
// posting.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as D from "../mods/down-the-stack/game/data.js";
import * as W from "../mods/down-the-stack/game/world.js";
import * as H from "../mods/down-the-stack/game/herd.js";
import * as Hr from "../mods/down-the-stack/game/heroes.js";
import * as I from "../mods/down-the-stack/game/items.js";
import { need } from "../mods/down-the-stack/game/formulas.js";
import { encodeState, decodeState } from "../mods/down-the-stack/game/save.js";

const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
const HOUR = 3600000;
const snap = (nowMs, extra = {}) => Object.assign({
  nowMs, tzOffsetMin: 0, weekday: 2, windowActive: true, focusedTerminal: null, agents: [], subagents: [], tabs: {}, spaces: [],
}, extra);

/** A world past its first call (so ticks are live), notifications on for `kinds`. */
function liveWorld(kinds = ["boss", "lts", "principal"]) {
  const w = W.createWorld({ nowMs: T0, seed: 3 });
  for (const k of kinds) w.state.herd.cfg.notify[k] = true;
  W.tick(w, snap(T0 + 1000));
  return w;
}

/** An off-duty Lv 89 hero a hair short of Lv 90, with a chest older than a day (it opens Unreviewed). */
function almostPrincipal(w) {
  const h = Hr.newHero(w.state, { seat: "repo/claude", sid: "s1", ord: 0, nowMs: T0 });
  Object.assign(h, { L: 89, cls: 1, prov: 0, rev: [1, 1], xp: need(89) - 1e-6 });
  h.st.seals = 1;
  h.pend = [{ min: 30, fmin: 0, title: "Ship the parser", at: T0 - 25 * HOUR, sealFactor: 1 }];
  w.state.heroes.push(h);
  return h;
}

describe("raising milestones (D§11.15)", () => {
  test("off by default: nothing is raised or counted until the kind is turned on", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    assert.deepEqual(w.state.herd.cfg.notify, { boss: false, lts: false, principal: false });
    W.tick(w, snap(T0 + 1000));
    w.state.herd.bossKills[0] = 1;
    w.state.herd.boss[0] = 1;
    W.tick(w, snap(T0 + 2000));
    assert.equal(w.rt.banner.text, "The herd reached frame #2", "the kill was seen");
    assert.deepEqual(w.state.herd.milestones, []);
    assert.deepEqual(w.state.herd.notified, [0, 0, 0]);
    // on: the next herd-first kill is raised, with its words
    w.state.herd.cfg.notify.boss = true;
    w.state.herd.bossKills[1] = 1;
    w.state.herd.boss[1] = 1;
    W.tick(w, snap(T0 + 3000));
    assert.equal(w.state.herd.milestones.length, 1);
    const m = w.state.herd.milestones[0];
    assert.equal(m.kind, "boss");
    assert.equal(m.title, `${D.BOSSES[1].name}: FIXED`);
    assert.equal(m.body, `The herd reached frame #3, ${D.ZONES[2].name}.`);
    assert.equal(m.at, T0 + 3000);
    // a repeat kill is no herd-first kill
    w.state.herd.bossKills[1] = 2;
    W.tick(w, snap(T0 + 4000));
    assert.equal(w.state.herd.milestones.length, 1);
  });

  test("the last boss names the Backlog", () => {
    const w = liveWorld(["boss"]);
    w.state.herd.bossKills[8] = 1;
    W.tick(w, snap(T0 + 2000));
    assert.equal(w.state.herd.milestones[0].body, `The herd reached ${D.BACKLOG.name}.`);
  });

  test("at most 3 a local day over all kinds; the day turns at 04:00 local time (snapshot tzOffsetMin)", () => {
    const w = liveWorld();
    const rt = w.rt;
    rt.tzOffsetMin = -120; // UTC+2: T0 is 14:00 local
    rt.nowMs = T0;
    const raise = (kind) => W.raiseMilestone(w, kind, { title: kind, body: "" });
    assert.equal(raise("boss"), true);
    assert.equal(raise("lts"), true);
    assert.equal(raise("principal"), true);
    assert.equal(raise("lts"), false, "a fourth the same day");
    const day = W.localDay(T0, -120);
    assert.deepEqual(w.state.herd.notified, [day, 3, 3]);
    // 03:59 local the next day is still the same game day (D§2.9: the day turns at 04:00)
    rt.nowMs = Date.UTC(2026, 10, 25, 1, 59);
    assert.equal(raise("boss"), false);
    // in UTC the same instant would still be before 04:00 too; at 04:00 local (02:00 UTC) a new day starts
    rt.nowMs = Date.UTC(2026, 10, 25, 2, 0);
    rt.tzOffsetMin = 0;
    assert.equal(raise("boss"), false, "02:00 UTC is 02:00 local with tzOffsetMin 0: still the old day");
    rt.tzOffsetMin = -120;
    assert.equal(raise("boss"), true, "04:00 local: a new day");
    assert.deepEqual(w.state.herd.notified, [day + 1, 1, 4]);
    // a clock that went back to an earlier day keeps the later day's count (no fresh budget)
    rt.nowMs = T0;
    assert.equal(raise("lts"), true);
    assert.equal(raise("lts"), true);
    assert.equal(raise("lts"), false);
    assert.deepEqual(w.state.herd.notified, [day + 1, 3, 6]);
    // the queue keeps the last 6
    assert.equal(w.state.herd.milestones.length, 6);
    assert.deepEqual(w.state.herd.milestones.map((m) => m.n), [1, 2, 3, 4, 5, 6]);
  });

  test("a clock that ran days ahead and was put right does not keep the budget spent until that day", () => {
    const w = liveWorld();
    const rt = w.rt;
    rt.tzOffsetMin = 0;
    rt.nowMs = T0 + 30 * 24 * HOUR; // a month ahead: the day's 3 are spent
    for (let i = 0; i < 3; i++) assert.equal(W.raiseMilestone(w, "boss", { title: "x" }), true);
    assert.equal(W.raiseMilestone(w, "boss", { title: "x" }), false);
    rt.nowMs = T0; // put right
    assert.equal(W.raiseMilestone(w, "boss", { title: "y" }), true, "today counts afresh");
    assert.deepEqual(w.state.herd.notified, [W.localDay(T0, 0), 1, 4]);
  });

  test("the count, its day and the queue survive a save (a restart keeps the cap)", () => {
    const w = liveWorld();
    w.rt.nowMs = T0;
    for (let i = 0; i < 3; i++) W.raiseMilestone(w, "lts", { title: `LTS: Item ${i}`, body: "Found by Kip." });
    const back = W.loadWorld(W.serialize(w), { nowMs: T0 }).world;
    assert.deepEqual(back.state.herd.notified, w.state.herd.notified);
    assert.deepEqual(back.state.herd.milestones, w.state.herd.milestones);
    back.rt.nowMs = T0 + 1000;
    assert.equal(W.raiseMilestone(back, "boss", { title: "x" }), false, "still 3 today after the reload");
    // nothing raised: the fields are left out of the save (an old save reads them as their defaults)
    const fresh = JSON.parse(encodeState(W.createWorld({ nowMs: T0 }).state));
    assert.equal("nf" in fresh.herd, false);
    assert.equal("ms" in fresh.herd, false);
    assert.deepEqual(decodeState(encodeState(W.createWorld({ nowMs: T0 }).state)).state.herd.notified, [0, 0, 0]);
  });

  test("takeMilestones empties the queue and drops what is older than 10 minutes", () => {
    const w = liveWorld();
    w.rt.nowMs = T0 - 11 * 60000;
    W.raiseMilestone(w, "boss", { title: "old" });
    w.rt.nowMs = T0;
    W.raiseMilestone(w, "lts", { title: "new", body: "b" });
    w.rt.dirty = false;
    const got = W.takeMilestones(w, T0 + 1000);
    assert.deepEqual(got.map((m) => m.title), ["new"]);
    assert.deepEqual(got[0], { n: 2, kind: "lts", at: T0, title: "new", body: "b" });
    assert.deepEqual(w.state.herd.milestones, []);
    assert.equal(w.rt.dirty, true, "taking them is a change to save");
    assert.deepEqual(W.takeMilestones(w, T0 + 2000), []);
  });

  test("a read-only world raises nothing", () => {
    const w = liveWorld();
    w.rt.readOnly = true;
    assert.equal(W.raiseMilestone(w, "boss", { title: "x" }), false);
    assert.deepEqual(w.state.herd.milestones, []);
  });
});

describe("only live play raises milestones (no burst of stale ones after catch-up)", () => {
  test("ev.milestone does nothing on an emitter that is not live", () => {
    const w = liveWorld();
    w.rt.nowMs = T0;
    assert.equal(W.makeEmitter(w).milestone("boss", { title: "x" }), false);
    assert.equal(W.makeEmitter(w, { live: true }).milestone("boss", { title: "x" }), true);
  });

  test("an LTS or Keepsake drop is raised; a Release drop is not", () => {
    const w = liveWorld();
    w.rt.nowMs = T0;
    const hero = Hr.newHero(w.state, { seat: "repo/claude", sid: "s1", ord: 0, nowMs: T0 });
    hero.name = "Kip the Idempotent";
    const ev = W.makeEmitter(w, { live: true });
    const holder = { rng: 99 };
    const lts = I.rollItem(holder, { ilvl: 40, source: "boss", rar: 4, state: w.state });
    const rel = I.rollItem(holder, { ilvl: 40, source: "boss", rar: 3, state: w.state });
    H.logDrop(w, hero, rel, ev);
    assert.deepEqual(w.state.herd.milestones, []);
    H.logDrop(w, hero, lts, ev);
    assert.equal(w.state.herd.milestones.length, 1);
    assert.equal(w.state.herd.milestones[0].kind, "lts");
    assert.equal(w.state.herd.milestones[0].title, `LTS: ${I.itemName(lts)}`);
    assert.equal(w.state.herd.milestones[0].body, "Found by Kip the Idempotent.");
    // the same drop through a catch-up emitter: the pillar and journal line, no milestone
    H.logDrop(w, hero, lts, W.makeEmitter(w));
    assert.equal(w.state.herd.milestones.length, 1);
  });

  test("a hero reaching Principal in a live tick is raised; in an offline gap it is not", () => {
    const live = liveWorld(["principal"]);
    const h1 = almostPrincipal(live);
    live.state.herd.tick = 59; // the next step is tick 60: off-duty chests older than a day open Unreviewed
    W.tick(live, snap(T0 + 2000));
    assert.equal(h1.L, 90);
    assert.equal(live.state.herd.milestones.length, 1);
    assert.equal(live.state.herd.milestones[0].kind, "principal");
    assert.match(live.state.herd.milestones[0].title, /reached Principal$/);
    assert.match(live.state.herd.milestones[0].body, /^Principal Refactorer, Lv 90/);

    const away = liveWorld(["principal"]);
    const h2 = almostPrincipal(away);
    W.tick(away, snap(T0 + 1000 + 120000)); // a 2-minute gap: offline (D§2.10), the chest opens Unreviewed
    assert.equal(h2.L, 90, "the promotion happened");
    assert.ok(away.state.herd.log.some((e) => e[1] === "promo" && e[2] === h2.id));
    assert.deepEqual(away.state.herd.milestones, [], "but it is catch-up: no notification");
  });

  test("the first call after a load raises nothing (chests seen on reopening are catch-up)", () => {
    const w = W.createWorld({ nowMs: T0, seed: 3 });
    w.state.herd.cfg.notify.principal = true;
    const h = almostPrincipal(w);
    w.state.herd.tick = 59;
    W.tick(w, snap(T0 + 1000)); // first call: its one step is tick 60
    assert.equal(h.L, 90);
    assert.deepEqual(w.state.herd.milestones, []);
  });

  test("a herd-first kill seen on the first call is not raised; on a later call it is", () => {
    const w = W.createWorld({ nowMs: T0, seed: 1 });
    w.state.herd.cfg.notify.boss = true;
    w.rt.bossSeen = new Array(D.BOSSES.length).fill(0); // (as if the kill came within the first step)
    w.state.herd.bossKills[0] = 1;
    W.tick(w, snap(T0 + 1000));
    assert.ok(w.rt.banner, "the kill was seen");
    assert.deepEqual(w.state.herd.milestones, []);
  });

  test("after an app start whose first listing is empty, the call that settles the held gap is not live either", () => {
    const w0 = W.createWorld({ nowMs: T0 - 2 * HOUR, seed: 1 });
    w0.state.herd.cfg.notify.boss = true;
    const w = W.loadWorld(W.serialize(w0), { nowMs: T0 }).world;
    W.tick(w, snap(T0)); // first call: a 2 h gap and no agents yet: held (BALANCE §9)
    assert.ok(w.rt.offlineHold);
    const agent = { address: "t1", status: "working", seq: 1, app: "claude", program: { key: "claude", name: "claude" }, title: "x", space: "s1", space_name: "repo", tab: "tb", tab_index: 1, tab_name: "main", pane: "p1", pane_name: null, pinned: false, focused: false };
    w.state.herd.bossKills[0] = 1;
    W.tick(w, snap(T0 + 1000, { agents: [agent] })); // the first listing: the gap settles now
    assert.equal(w.rt.offlineHold, null);
    assert.ok(w.rt.banner, "the kill was seen");
    assert.deepEqual(w.state.herd.milestones, []);
    w.state.herd.bossKills[1] = 1;
    W.tick(w, snap(T0 + 2000, { agents: [agent] }));
    assert.equal(w.state.herd.milestones.length, 1, "live from the next call on");
  });

  test("a clock behind the last tick is catch-up: a chest seen then promotes but raises nothing", () => {
    const agent = (status, seq) => ({ address: "t1", status, seq, app: "claude", program: { key: "claude", name: "claude" }, title: "x", space: "s1", space_name: "repo", tab: "tb", tab_index: 1, tab_name: "main", pane: "p1", pane_name: null, pinned: false, focused: false });
    for (const behind of [true, false]) {
      const w = liveWorld(["principal"]);
      W.tick(w, snap(T0 + 2000, { agents: [agent("working", 1)] })); // hires the hero
      const h = w.state.heroes[0];
      Object.assign(h, { L: 89, cls: 1, prov: 0, rev: [1, 1], xp: need(89) - 1e-6 });
      W.tick(w, snap(T0 + 3000, { agents: [agent("done", 2)] })); // shipped: no fighting, no XP
      assert.equal(h.L, 89);
      h.pend = [{ min: 30, fmin: 0, title: "Ship it", at: T0 + 2500, sealFactor: 1 }];
      // herdr's seen flip (done -> idle, same seq) opens the chest in reconcile: its XP promotes
      W.tick(w, snap(behind ? T0 + 1500 : T0 + 4000, { agents: [agent("idle", 2)] }));
      assert.equal(w.rt.clockBehind, behind);
      assert.equal(h.L, 90, "promoted either way");
      assert.equal(w.state.herd.milestones.length, behind ? 0 : 1, behind ? "a clock behind: not live" : "a live tick raises");
    }
  });

  test("a person's command is live: a chest claimed by click can promote and raise", () => {
    const w = liveWorld(["principal"]);
    const h = almostPrincipal(w);
    h.pend[0].at = T0; // a fresh chest: it waits for the person
    const r = W.command(w, "claimChest", { heroId: h.id }, T0 + 5000);
    assert.equal(r.ok, true, r.error);
    assert.equal(h.L, 90);
    assert.equal(w.state.herd.milestones.length, 1);
  });

  test("a Contractor reaching Principal is not raised (it is never saved)", () => {
    const w = liveWorld(["principal"]);
    w.rt.nowMs = T0;
    const c = { id: -1, name: "Contractor", L: 89, cls: 1, prov: 0, rev: [1, 1], xp: need(89) - 1e-6, sp: [0, 0, 0, 0, 0, 0, 0], spFree: 0, eq: [null, null, null, null, null, null] };
    Hr.grantXP(w.state, c, 10, W.makeEmitter(w, { live: true }));
    assert.equal(c.L, 90);
    assert.deepEqual(w.state.herd.milestones, []);
  });
});
