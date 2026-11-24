// Autopilot (D§5.7, D§7.1, D§8.7-8.8, D§9.5, D§10.2): map choice (level cap, pins, crash rule,
// convergence, hysteresis, Backlog), drop offers and auto-deprecate, stash sweeps, polish,
// buildings, auto-learn, boss / farm / review challenges, and every cfg.auto switch.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as D from "../mods/down-the-stack/game/data.js";
import * as F from "../mods/down-the-stack/game/formulas.js";
import * as Hr from "../mods/down-the-stack/game/heroes.js";
import * as I from "../mods/down-the-stack/game/items.js";
import * as AP from "../mods/down-the-stack/game/autopilot.js";
import * as H from "../mods/down-the-stack/game/herd.js";
import { makeWorld, addHero, makeEv, T0 } from "./helpers/engine.mjs";

function item(state, slot, ilvl, rar = 0, extra = {}) {
  const t = F.itemTier(ilvl);
  const base = slot === "weapon" ? I.baseIdFor("weapon", t, extra.type) : I.baseIdFor(slot, t, slot);
  return { uid: state.herd.nextUid++, base, ilvl, rar, pol: extra.pol ?? 0, aff: extra.aff ?? [], flags: extra.flags ?? 0, prop: -1 };
}

function openMaps(state, ...ids) {
  for (const id of ids) state.herd.quota[id] = 40;
}

// A fake boss API (world.rt.bossApi seam) that records calls.
function fakeBoss({ ok = true, est = 1.2 } = {}) {
  const api = {
    calls: [],
    canChallenge(world, kind, idx, heroId) { api.calls.push(["can", kind, idx, heroId]); return { ok: typeof ok === "function" ? ok(kind, idx) : ok, estimate: 0, label: "Even" }; },
    estimate(world, kind, idx, ids) { api.calls.push(["est", kind, idx, ids.slice()]); return typeof est === "function" ? est(kind, idx) : est; },
    startFight(world, kind, idx, ids) { api.calls.push(["start", kind, idx, ids.slice()]); return { kind, bossIdx: idx, heroIds: ids.slice() }; },
    stepFight() { return "running"; },
  };
  return api;
}

describe("map choice (D§5.7)", () => {
  test("a Lv 1 hero stays on 1-1 however high its Power Level reads", () => {
    const w = makeWorld({ heroes: [{ cls: "intern", L: 1 }] });
    openMaps(w.state, "1-1", "1-2");
    const h = w.state.heroes[0];
    assert.ok(Hr.stats(h, { herd: w.state.herd }).pl > 3, "PL reads high at Lv 1");
    assert.equal(AP.chooseMap(w, h, w.rt.live.get(h.id)), "1-1");
  });

  test("the deepest open map with mid <= min(PL, L + 2) + 1; locked maps are skipped", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 9 }] });
    const h = w.state.heroes[0];
    const live = w.rt.live.get(h.id);
    assert.equal(AP.chooseMap(w, h, live), "1-1", "only 1-1 is open");
    openMaps(w.state, "1-1");
    assert.equal(AP.chooseMap(w, h, live), "1-2");
    openMaps(w.state, "1-2");
    assert.equal(AP.chooseMap(w, h, live), "1-3", "mid 10 <= 11");
    h.L = 6;
    assert.equal(AP.chooseMap(w, h, live), "1-2", "mid 10 > min(PL, 8) + 1");
  });

  test("a pin wins when its map is open", () => {
    const w = makeWorld({ heroes: [{ cls: "intern", L: 1 }] });
    const h = w.state.heroes[0];
    h.pinMap = "1-3";
    assert.equal(AP.chooseMap(w, h, null), "1-1", "a locked pin is ignored");
    openMaps(w.state, "1-1", "1-2");
    assert.equal(AP.chooseMap(w, h, null), "1-3");
  });

  test("crash history: a recent crash caps PL at L; combat's dropMap caps the map", () => {
    const w = makeWorld({ heroes: [{ cls: "refactorer", L: 12 }] });
    openMaps(w.state, "1-1", "1-2");
    const h = w.state.heroes[0];
    const live = w.rt.live.get(h.id);
    live.mapId = "1-3";
    assert.equal(AP.chooseMap(w, h, live), "1-3");
    live.dropMap = { mapId: "1-2", untilMs: w.rt.nowMs + 1000 };
    assert.equal(AP.chooseMap(w, h, live), "1-2");
    live.dropMap.untilMs = w.rt.nowMs;
    assert.equal(AP.chooseMap(w, h, live), "1-3", "expired");
    h.L = 9; // PL > L at this level with the reference kit
    live.mapId = "1-1";
    const free = AP.chooseMap(w, h, live);
    live.crashes = [w.rt.tick];
    assert.equal(AP.recentCrashes(live, w.rt.tick), 1);
    const capped = AP.chooseMap(w, h, live);
    assert.ok(D.MAP_BY_ID[capped].n <= D.MAP_BY_ID[free].n);
    assert.ok(D.MAP_BY_ID[capped].mid <= h.L + 1);
  });

  test("hysteresis: one map deeper stays while its mid <= eff + 2", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 7 }] });
    openMaps(w.state, "1-1", "1-2");
    const h = w.state.heroes[0];
    const live = w.rt.live.get(h.id);
    live.mapId = "1-1";
    const choice = AP.chooseMap(w, h, live);
    assert.equal(choice, "1-2");
    live.mapId = "1-3"; // mid 10 <= min(PL, 9) + 2 when PL >= 8
    const pl = Hr.stats(h, { herd: w.state.herd }).pl;
    assert.equal(AP.chooseMap(w, h, live), Math.min(pl, 9) + 2 >= 10 ? "1-3" : "1-2");
  });

  test("convergence: a hero moves down to a guild-mate's choice exactly one map below", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 10, space: "s1" }, { cls: "intern", L: 6, space: "s1" }, { cls: "intern", L: 1, space: "s2" }] });
    openMaps(w.state, "1-1", "1-2");
    const [a, b] = w.state.heroes;
    const la = w.rt.live.get(a.id);
    const lb = w.rt.live.get(b.id);
    assert.equal(AP.chooseMap(w, b, lb), "1-2");
    assert.equal(AP.chooseMap(w, a, la), "1-2", "pulled down one map to its guild-mate");
    b.L = 1; // now two maps below: no pull
    assert.equal(AP.chooseMap(w, a, la), "1-3");
    b.L = 6;
    lb.space = "s9"; // another guild
    assert.equal(AP.chooseMap(w, a, la), "1-3");
    lb.space = "s1";
    a.pinMap = "1-3";
    assert.equal(AP.chooseMap(w, a, la), "1-3", "a pinned hero never converges");
  });

  test("two equal guild-mates do not hold each other back", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 9, mapId: "1-1" }, { cls: "shellmancer", L: 9, mapId: "1-1" }] });
    openMaps(w.state, "1-1", "1-2");
    AP.autopilot(w, makeEv());
    for (const live of w.rt.live.values()) assert.equal(live.mapId, "1-3");
  });

  test("Lv 100 heroes go to the Backlog once it is open", () => {
    const w = makeWorld({ heroes: [{ cls: "hotfixer", L: 100 }] });
    const h = w.state.heroes[0];
    const live = w.rt.live.get(h.id);
    assert.notEqual(AP.chooseMap(w, h, live), "backlog");
    w.state.herd.boss[8] = 1;
    w.state.herd.zone = 9;
    assert.equal(AP.chooseMap(w, h, live), "backlog");
    assert.equal(live.floor, 1, "at most one past the herd's cleared floor");
    w.state.herd.backlog = { floor: 40, kills: 0 };
    live.mapId = AP.chooseMap(w, h, live);
    assert.ok(live.floor >= 1);
    const lv = AP.mapLevels(w, h, live);
    assert.equal(lv.mid, 100);
    assert.equal(lv.top, 100 + Math.floor(live.floor / 2));
  });
});

describe("gear (D§8.7, D§8.8)", () => {
  test("a drop goes to the finder when it is an upgrade; the old item goes to the stash", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 20 }] });
    const h = w.state.heroes[0];
    const old = h.eq[0];
    const it = item(w.state, "weapon", 30, 3, { type: "pipe" });
    h.L = 30;
    const r = AP.offerDrop(w, h, it, makeEv());
    assert.equal(r.heroId, h.id);
    assert.equal(h.eq[0], it);
    assert.ok(w.state.herd.stash.includes(old));
  });

  test("a weapon the finder can't wield goes to a hero who can", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 20 }, { cls: "refactorer", L: 20 }] });
    const [s, r] = w.state.heroes;
    const blade = item(w.state, "weapon", 22, 3, { type: "blade" });
    const res = AP.offerDrop(w, s, blade, makeEv());
    assert.equal(res.heroId, r.id);
    assert.equal(r.eq[0], blade);
  });

  test("auto-deprecate: a Prototype nobody wants is salvaged; a Beta is kept; switches respected", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 40 }] });
    const h = w.state.heroes[0];
    const junk = item(w.state, "hat", 5, 0);
    const snip = w.state.herd.snip;
    const r1 = AP.offerDrop(w, h, junk, makeEv());
    assert.equal(r1.kept, false);
    assert.equal(r1.deprecated, junk);
    assert.ok(w.state.herd.snip > snip);
    assert.ok(!w.state.herd.stash.includes(junk));
    const beta = item(w.state, "hat", 5, 2, { aff: [[0, 10], [4, 10]] });
    assert.equal(AP.offerDrop(w, h, beta, makeEv()).kept, true);
    assert.ok(w.state.herd.stash.includes(beta));
    w.state.herd.cfg.auto.deprecate = false;
    const junk2 = item(w.state, "hat", 5, 0);
    assert.equal(AP.offerDrop(w, h, junk2, makeEv()).kept, true);
    w.state.herd.cfg.auto.equip = false;
    const great = item(w.state, "weapon", 45, 4, { type: "pipe" });
    AP.offerDrop(w, h, great, makeEv());
    assert.notEqual(h.eq[0], great, "auto-equip off");
    assert.ok(w.state.herd.stash.includes(great));
  });

  test("sweepHero equips the best usable stash item per slot", () => {
    const w = makeWorld({ heroes: [{ cls: "hotfixer", L: 30 }] });
    const h = w.state.heroes[0];
    const good = item(w.state, "weapon", 30, 2, { type: "knives" });
    const better = item(w.state, "weapon", 31, 3, { type: "knives", aff: [[0, 99], [1, 99], [2, 99]] });
    const tooHigh = item(w.state, "weapon", 60, 4, { type: "knives" });
    const wrong = item(w.state, "weapon", 31, 4, { type: "pipe" });
    w.state.herd.stash.push(good, better, tooHigh, wrong);
    assert.equal(AP.sweepHero(w, h), 1);
    assert.equal(h.eq[0], better);
    assert.ok(w.rt.apGear.has(h.id));
  });

  test("sweepChunk offers a slice of the stash to the roster", () => {
    const w = makeWorld({ heroes: [{ cls: "hotfixer", L: 30 }] });
    const h = w.state.heroes[0];
    for (let i = 0; i < 20; i++) w.state.herd.stash.push(item(w.state, "boots", 3, 0));
    const up = item(w.state, "weapon", 32, 3, { type: "knives" });
    w.state.herd.stash.push(up);
    let n = 0;
    for (let k = 0; k < 3 && h.eq[0] !== up; k++) n += AP.sweepChunk(w);
    assert.equal(h.eq[0], up);
    assert.ok(n >= 1);
  });

  test("autoPolish: one item per pass, lowest polish first, only with 5x gold and 2x Snippets", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 20 }] });
    const h = w.state.heroes[0];
    for (const it of h.eq) if (it) it.pol = 2;
    h.eq[3].pol = 0;
    w.state.herd.gold = 10;
    w.state.herd.snip = 0;
    assert.equal(AP.autoPolish(w), null);
    w.state.herd.gold = 1e9;
    w.state.herd.snip = 1e6;
    const r = AP.autoPolish(w);
    assert.equal(r.uid, h.eq[3].uid);
    assert.equal(h.eq[3].pol, 1);
  });

  test("autoPolish never spends on a weapon of another class's type (swung as a Training Stick)", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 20 }] });
    const h = w.state.heroes[0];
    w.state.herd.gold = 1e9;
    w.state.herd.snip = 1e6;
    for (const it of h.eq) if (it) it.pol = 2; // AP.polishTarget at Lv 20
    // a provisional class switch left a Refactorer's blade in hand
    h.eq[0] = item(w.state, "weapon", 20, 2, { type: "blade" });
    assert.equal(I.canEquip(h, h.eq[0], { ignoreLevel: true }), false);
    assert.equal(Hr.stats(h, {}).offClassWeapon, true);
    assert.equal(AP.polishTarget(h, h.eq[0]), 0);
    const gold = w.state.herd.gold;
    assert.equal(AP.autoPolish(w), null, "nothing else is below its target");
    assert.equal(h.eq[0].pol, 0);
    assert.equal(w.state.herd.gold, gold, "no gold spent");
    // the hero's own gear is still polished (the blade is the lowest, but skipped)
    h.eq[2].pol = 1;
    assert.deepEqual(AP.autoPolish(w), { heroId: h.id, uid: h.eq[2].uid });
    assert.equal(h.eq[2].pol, 2);
    assert.equal(h.eq[0].pol, 0);
    // a weapon of its own type is polished as before
    h.eq[0] = item(w.state, "weapon", 20, 2, { type: "pipe" });
    assert.equal(AP.polishTarget(h, h.eq[0]), 2);
    assert.deepEqual(AP.autoPolish(w), { heroId: h.id, uid: h.eq[0].uid });
    assert.equal(h.eq[0].pol, 1);
  });

  test("autoBuild buys the cheapest affordable building", () => {
    const w = makeWorld({ heroes: [] });
    w.state.herd.gold = 2500;
    w.state.herd.born = 100;
    w.state.herd.day = 105; // the herd's day 6: Campfire 1 is open (balance: one level per 6 days)
    const ev = makeEv();
    assert.equal(AP.autoBuild(w, ev), 0);
    assert.equal(w.state.herd.bld[0], 1);
    assert.equal(w.state.herd.gold, 1700);
    assert.equal(ev.notes[0], "Localhost: Campfire 1");
    assert.equal(AP.autoBuild(w, ev), null);
  });

  test("the Campfire waits for the herd's age (balance: one level per 6 days, the D§12.1 Fresh Eyes cap)", () => {
    const w = makeWorld({ heroes: [] });
    w.state.herd.gold = 1e9;
    w.state.herd.born = 100;
    w.state.herd.day = 100; // day 1: no Campfire yet, the Coffee Machine (same price) goes first
    assert.equal(AP.autoBuild(w, makeEv()), 1);
    assert.equal(w.state.herd.bld[0], 0);
    assert.match(H.buy(w.state, 0).error, /day 6/);
    w.state.herd.day = 111; // day 12: two levels
    assert.equal(H.buy(w.state, 0).ok, true);
    assert.equal(H.buy(w.state, 0).ok, true);
    assert.equal(H.buy(w.state, 0).ok, false);
    assert.equal(H.freshEyesCapMin(w.state), 90);
  });
});

describe("the pass and its switches", () => {
  test("auto-learn spends free skill points; the switch turns it off", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 15, ranks: [0, 0, 0, 0, 0, 0, 0] }] });
    const h = w.state.heroes[0];
    h.spFree = 14;
    w.state.herd.cfg.auto.learn = false;
    AP.autopilot(w, makeEv());
    assert.equal(h.spFree, 14);
    w.state.herd.cfg.auto.learn = true;
    AP.autopilot(w, makeEv());
    assert.equal(h.spFree, 0);
  });

  test("map choice off keeps heroes where they stand (a pin still applies)", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 9, mapId: "1-1" }] });
    openMaps(w.state, "1-1", "1-2");
    w.state.herd.cfg.auto.maps = false;
    AP.autopilot(w, makeEv());
    const h = w.state.heroes[0];
    const live = w.rt.live.get(h.id);
    assert.equal(live.mapId, "1-1");
    h.pinMap = "1-2";
    AP.autopilot(w, makeEv());
    assert.equal(live.mapId, "1-2");
  });

  test("the master switch (herd.cfg.autopilot, D§11.15) stops every system and keeps their own switches", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 15, mapId: "1-1", ranks: [0, 0, 0, 0, 0, 0, 0] }] });
    openMaps(w.state, "1-1", "1-2", "1-3");
    const h = w.state.heroes[0];
    const live = w.rt.live.get(h.id);
    h.spFree = 14;
    w.state.herd.gold = 1e6;
    w.state.herd.cfg.autopilot = false;
    AP.autopilot(w, makeEv());
    assert.equal(h.spFree, 14, "no auto-learn");
    assert.equal(live.mapId, "1-1", "no map choice");
    assert.deepEqual(w.state.herd.bld, [0, 0, 0, 0, 0, 0], "no buildings");
    const great = item(w.state, "weapon", 15, 4, { type: "pipe" });
    AP.offerDrop(w, h, great, makeEv());
    assert.notEqual(h.eq[0], great, "no auto-equip");
    const junk = item(w.state, "hat", 5, 0);
    assert.equal(AP.offerDrop(w, h, junk, makeEv()).kept, true, "no auto-deprecate");
    assert.ok(Object.values(w.state.herd.cfg.auto).every((v) => v === true), "the systems' own switches are untouched");
    // back on: every system runs again as its own switch says
    w.state.herd.cfg.autopilot = true;
    w.state.herd.cfg.auto.buildings = false;
    AP.autopilot(w, makeEv());
    assert.equal(h.spFree, 0);
    assert.notEqual(live.mapId, "1-1");
    assert.deepEqual(w.state.herd.bld, [0, 0, 0, 0, 0, 0], "buildings still off by their own switch");
    assert.equal(F.autoOn(w.state, "learn"), true);
    assert.equal(F.autoOn(w.state, "buildings"), false);
    assert.equal(F.autoOn({ herd: { cfg: { autopilot: false } } }, "learn"), false);
    assert.equal(F.autoOn({ herd: {} }, "learn"), true, "a herd without settings runs on autopilot");
  });

  test("a targeted pass (heroIds) touches only those heroes and skips the herd systems", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 9, mapId: "1-1" }, { cls: "shellmancer", L: 9, mapId: "1-1", space: "s2" }] });
    openMaps(w.state, "1-1", "1-2");
    w.state.herd.gold = 1e6;
    const [a, b] = w.state.heroes;
    AP.autopilot(w, makeEv(), { heroIds: [a.id] });
    assert.equal(w.rt.live.get(a.id).mapId, "1-3");
    assert.equal(w.rt.live.get(b.id).mapId, "1-1");
    assert.deepEqual(w.state.herd.bld, [0, 0, 0, 0, 0, 0], "no buildings on a targeted pass");
  });
});

describe("bosses and reviews (D§9.5, D§4.5)", () => {
  function zoneOneReady(w) {
    w.state.herd.quota = { "1-1": 40, "1-2": 40, "1-3": 40 };
    w.state.herd.meter = 6;
  }

  test("participants: Questing heroes in the zone by Power Level, max 6, then helpers", () => {
    const specs = [];
    for (let i = 0; i < 7; i++) specs.push({ cls: "shellmancer", L: 5 + i, mapId: "1-3" });
    specs.push({ cls: "hotfixer", L: 30, mapId: "2-1" });
    specs.push({ cls: "hotfixer", L: 30, mapId: "1-1", state: "waiting" });
    const w = makeWorld({ heroes: specs });
    const ids = AP.bossParticipants(w, 0);
    assert.equal(ids.length, 6);
    const pls = ids.map((id) => Hr.stats(w.state.heroes.find((h) => h.id === id), { herd: w.state.herd }).pl);
    for (let i = 1; i < pls.length; i++) assert.ok(pls[i - 1] >= pls[i]);
    const helper = w.state.heroes[7];
    const few = makeWorld({ heroes: [{ cls: "shellmancer", L: 9, mapId: "1-3" }, { cls: "hotfixer", L: 30, mapId: "2-1" }] });
    assert.equal(AP.bossParticipants(few, 0).length, 1, "no helper who has not beaten the boss");
    few.state.heroes[1].cd.boss = { 0: T0 };
    assert.equal(AP.bossParticipants(few, 0).length, 2, "Answer calls");
    assert.equal(AP.bossParticipants(few, 0, { calls: false }).length, 1);
    assert.ok(helper);
  });

  test("auto-boss challenges the frontier boss when the door is open and E >= autoAt (balance: 0.9, design 1.0)", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 11, mapId: "1-3" }] });
    const at = D.TUNING.boss.autoAt;
    w.rt.bossApi = fakeBoss({ est: at - 0.01 });
    zoneOneReady(w);
    assert.deepEqual(AP.autoChallenge(w, makeEv()), []);
    w.rt.bossApi = fakeBoss({ est: at });
    const started = AP.autoChallenge(w, makeEv());
    assert.equal(started.length, 1);
    assert.equal(w.rt.fights.length, 1);
    assert.deepEqual(w.rt.bossApi.calls.find((c) => c[0] === "start"), ["start", "boss", 0, [w.state.heroes[0].id]]);
    assert.deepEqual(AP.autoChallenge(w, makeEv()), [], "one boss fight at a time");
  });

  test("the door must be open; the switch turns auto-boss off", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 11, mapId: "1-3" }] });
    w.rt.bossApi = fakeBoss({ est: 5 });
    assert.deepEqual(AP.autoChallenge(w, makeEv()), [], "door closed");
    zoneOneReady(w);
    w.state.herd.cfg.auto.boss = false;
    assert.deepEqual(AP.autoChallenge(w, makeEv()), []);
  });

  test("farm bosses: beaten bosses when E >= 1.5", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 14, mapId: "1-3" }] });
    w.state.herd.boss[0] = 1;
    w.state.herd.zone = 1;
    w.rt.bossApi = fakeBoss({ est: 1.4 });
    assert.deepEqual(AP.autoChallenge(w, makeEv()), []);
    w.rt.bossApi = fakeBoss({ est: 1.5 });
    assert.equal(AP.autoChallenge(w, makeEv()).length, 1);
    w.rt.fights = [];
    w.state.herd.cfg.auto.farm = false;
    assert.deepEqual(AP.autoChallenge(w, makeEv()), []);
  });

  test("the Backlog: a boss floor with its 50 kills is challenged by auto-boss (D§9.8)", () => {
    const w = makeWorld({ heroes: [{ cls: "hotfixer", L: 100, mapId: "backlog" }] });
    w.state.herd.boss.fill(1);
    w.state.herd.zone = D.BACKLOG.n;
    w.state.herd.backlog = { floor: 10, kills: 49 };
    const id = w.state.heroes[0].id;
    const api = fakeBoss({ est: 1.2 });
    // boss.js picks the heroes standing in the Backlog itself
    api.canChallenge = (world, kind, idx) => { api.calls.push(["can", kind, idx]); return { ok: true, estimate: 1.2, label: "Even", heroIds: [id] }; };
    w.rt.bossApi = api;
    assert.deepEqual(AP.autoChallenge(w, makeEv()), [], "not before the floor's 50 kills (farming needs E >= 1.5)");
    w.state.herd.backlog.kills = 50;
    const started = AP.autoChallenge(w, makeEv());
    assert.deepEqual(started.map((f) => [f.kind, f.bossIdx, f.heroIds]), [["backlog", 10, [id]]]);
    w.rt.fights = [];
    w.state.herd.backlog = { floor: 11, kills: 50 };
    assert.deepEqual(AP.autoChallenge(w, makeEv()), [], "only every 10th floor has a boss");
    w.state.herd.backlog = { floor: 20, kills: 50 };
    w.state.herd.cfg.auto.boss = false;
    assert.deepEqual(AP.autoChallenge(w, makeEv()), [], "the auto-boss switch");
  });

  test("reviews: a Questing hero at Lv 30 takes the Senior Review, at Lv 60 the Staff Review", () => {
    const w = makeWorld({ heroes: [{ cls: "hotfixer", L: 30, rev: [0, 0] }, { cls: "hotfixer", L: 61, rev: [1, 0] }, { cls: "hotfixer", L: 45, rev: [1, 0] }] });
    w.rt.bossApi = fakeBoss({ est: 1.1, ok: (kind) => kind === "review" });
    const started = AP.autoChallenge(w, makeEv());
    assert.deepEqual(started.map((f) => [f.kind, f.bossIdx]), [["review", 0], ["review", 1]]);
    const cans = w.rt.bossApi.calls.filter((c) => c[0] === "can" && c[1] === "review");
    assert.deepEqual(cans.map((c) => c[3]), [w.state.heroes[0].id, w.state.heroes[1].id], "the hero id goes to canChallenge");
    const w2 = makeWorld({ heroes: [{ cls: "hotfixer", L: 30, rev: [0, 0] }] });
    w2.rt.bossApi = fakeBoss({ est: 1.1 });
    w2.state.herd.cfg.auto.career = false;
    assert.deepEqual(AP.autoChallenge(w2, makeEv()), []);
  });
});
