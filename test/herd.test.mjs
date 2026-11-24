// Herd systems (D§10): gold, Release Train, Sprint meter, buildings and their effects, herd XP
// bonus and its cap, Bug Tracker tiers and zone perks, trophies, badges, retirement, journal,
// digest, waypoints.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as D from "../mods/mapledr/game/data.js";
import * as F from "../mods/mapledr/game/formulas.js";
import * as Hr from "../mods/mapledr/game/heroes.js";
import * as I from "../mods/mapledr/game/items.js";
import * as H from "../mods/mapledr/game/herd.js";
import { newState, encodeState, saveSize } from "../mods/mapledr/game/save.js";

const T0 = 1_790_000_000_000;

function mkWorld(extra = {}) {
  const state = newState({ nowMs: T0, seed: 11 });
  Object.assign(state.herd, extra);
  return { state, rt: { tick: 0, nowMs: T0, live: new Map(), contractors: new Map(), fights: [], errors: [] } };
}

function recEv() {
  const ev = { notes: [], journals: [], fxs: [], majors: 0 };
  ev.note = (t) => ev.notes.push(t);
  ev.journal = (k, h, t, v) => ev.journals.push([k, h, t, v]);
  ev.fx = (k, d) => ev.fxs.push(Object.assign({ kind: k }, d));
  ev.major = () => { ev.majors++; };
  ev.banner = () => {};
  return ev;
}

function addHero(state, L = 1, cls = 0, extra = {}) {
  const h = Hr.newHero(state, { seat: "repo/claude", ord: state.heroes.length, nowMs: T0 });
  h.L = L;
  h.cls = cls;
  Object.assign(h, extra);
  state.heroes.push(h);
  return h;
}

describe("gold and Snippets", () => {
  test("addGold rounds and never goes negative; addSnippets likewise", () => {
    const { state } = mkWorld();
    assert.equal(H.addGold(state, 10.4), 10);
    assert.equal(H.addGold(state, -100), 0);
    assert.equal(H.addSnippets(state, 7), 7);
    assert.equal(H.addSnippets(state, -20), 0);
  });

  test("journal keeps the newest 120 lines (balance: D§13.3 says 60)", () => {
    const { state } = mkWorld();
    assert.equal(H.LOG_MAX, 120);
    for (let i = 0; i < 135; i++) H.journal(state, "ship", 1, `t${i}`, i, T0 + i);
    assert.equal(state.herd.log.length, 120);
    assert.deepEqual(state.herd.log[0], [T0 + 15, "ship", 1, "t15", 15]);
    assert.deepEqual(state.herd.log[119], [T0 + 134, "ship", 1, "t134", 134]);
  });

  test("the journal tapers to D§13.3's 60 lines past 20 heroes, so the 30-hero worst case fits 30 KB", (t) => {
    const { state } = mkWorld();
    const lens = [];
    for (const n of [1, 20, 21, 25, 30, 40]) {
      while (state.heroes.length < n) addHero(state, 50, 1 + (state.heroes.length % 5));
      lens.push(H.logMax(state));
    }
    assert.deepEqual(lens, [120, 120, 114, 90, 60, 60]);
    // a herd that grows trims its journal at the next line
    const { state: s2 } = mkWorld();
    for (let i = 0; i < 130; i++) H.journal(s2, "ship", 1, `t${i}`, i, T0 + i);
    assert.equal(s2.herd.log.length, 120);
    while (s2.heroes.length < 30) addHero(s2, 50, 1);
    H.journal(s2, "hire", 30, "Newcomer", 0, T0 + 999);
    assert.equal(s2.herd.log.length, 60);
    assert.deepEqual(s2.herd.log[59], [T0 + 999, "hire", 30, "Newcomer", 0]);
    // D§13.3's worst case at the taper's corners (as test/save.test.mjs builds it): heroes in full
    // Release gear with busy counters, 140 stash items, a full journal of 40-character lines
    const worst = (n) => {
      const { state: s } = mkWorld({ gold: 412350.25, snip: 133, zone: 2, meter: 7.4, bank: 1.5, seals: 218.6, rel: 17, day: 20781, tick: 8812345 });
      Object.assign(s.herd, {
        bld: [3, 2, 1, 2, 2, 0], quota: { "1-1": 40, "1-2": 40, "1-3": 40, "2-1": 40, "2-3": 12, "3-1": 31 },
        boss: [1, 1, 0, 0, 0, 0, 0, 0, 0], bossKills: [14, 3, 0, 0, 0, 0, 0, 0, 0], wounds: { 2: [0.38, T0 + 172800000] },
        lessons: { 2: 1 }, bt: [5210, 980, 0, 0, 0, 0, 0, 0, 0], badges: ["hello_world", "first_commit", "zero_warnings", "lucky_duck"],
        fame: [["Bram Lintwick", 1, 54, T0 - 2000000]], backlog: { floor: 3, kills: 17 }, digestAt: T0 - 10000000,
      });
      const holder = { rng: 777 };
      for (let i = 0; i < 140; i++) s.herd.stash.push(I.rollItem(holder, { ilvl: 20 + (i % 80), source: "boss", state: s, first: true }));
      for (let k = 0; k < n; k++) {
        const h = addHero(s, 14 + k * 3, 1 + (k % 5), {
          xp: 1290.5, sp: [8, 4, 1, 0, 0, 0, 0], rev: [k % 2, 0], fe: 42.5, shift: { day: 20781, min: 192.25 }, hpFrac: 0.92,
          pinMap: k === 0 ? "2-2" : null, addr: `t${k}`, lastPane: "main", lastTab: "api", spFree: 1,
        });
        h.st = { kills: 51234, tasks: 312, seals: 288.4, wh: 41.5, dodges: 12, healed: 300 };
        h.cd.unblockedUntil = 120;
        h.cd.unblockedCdUntil = 8812000;
        h.cd.boss = {};
        for (let b = 0; b < 9; b++) h.cd.boss[b] = 149400 - 4000 * b;
        for (let t = 0; t < 20; t++) Hr.recordTask(h, { minutes: 4 + t * 3, blocks: t % 2, spawned: t % 7 === 0 });
        h.pend = [{ min: 37.25, fmin: 0.75, title: "Refactor the session store adapter (#2)", at: T0 + 12345, sealFactor: 0.75 }];
        for (let si = 0; si < 6; si++) {
          const it = I.rollItem(h, { ilvl: h.L, source: "boss", slot: D.SLOTS[si], classId: h.cls, state: s, first: true });
          it.pol = Math.min(3, k);
          it.flags = 0;
          h.eq[si] = it;
        }
      }
      for (let b = 0; b < D.BOSSES.length; b++) H.noteFirstClear(s, b, T0 + b * 86400000);
      for (let i = 0; i < 200; i++) H.journal(s, "ship", 1 + (i % 3), `Fix flaky auth test number ${i} in api/`, 2.4, T0 + i * 1000);
      return s;
    };
    for (const n of [20, 25, 30]) {
      const s = worst(n);
      assert.equal(s.herd.log.length, H.logMax(s));
      const size = saveSize(encodeState(s));
      assert.ok(size.ok, `${n} heroes, ${s.herd.log.length} journal lines: ${size.bytes} B`);
      t.diagnostic(`${n} heroes, ${s.herd.log.length} journal lines: ${size.bytes} B`);
    }
    // what the taper prevents: 120 lines with 30 heroes are over the budget
    const s30 = worst(30);
    while (s30.herd.log.length < H.LOG_MAX) s30.herd.log.unshift(s30.herd.log[0].slice());
    const flat = saveSize(encodeState(s30));
    t.diagnostic(`30 heroes, ${H.LOG_MAX} journal lines: ${flat.bytes} B`);
    assert.equal(flat.ok, false);
  });
});

describe("Release Train (D§10.3)", () => {
  test("milestones and the release math", () => {
    assert.equal(F.releaseSeals(1), 8);
    assert.equal(F.releaseSeals(10), 179); // v1.0
    assert.equal(F.releaseSeals(60), 2012); // v6.0
    const w = mkWorld();
    const ev = recEv();
    assert.equal(H.addSeals(w, 7.9, ev), 0);
    assert.equal(w.state.herd.rel, 0);
    assert.equal(H.addSeals(w, 0.1, ev), 1);
    assert.equal(w.state.herd.rel, 1);
    assert.equal(ev.notes[0], "Release v0.1 shipped");
    H.addSeals(w, 179 - 8, ev);
    assert.equal(w.state.herd.rel, 10);
    assert.ok(ev.journals.some((j) => j[0] === "release" && j[2] === "Release v1.0"), "major versions are journaled");
    const info = H.releaseInfo(w.state);
    assert.equal(info.label, "v1.0");
    assert.equal(info.next, F.releaseSeals(11));
  });

  test("+0.5% XP and gold per release, up to r = 60", () => {
    const { state } = mkWorld({ rel: 17 });
    assert.ok(Math.abs(H.releaseBonus(state) - 0.085) < 1e-12);
    state.herd.rel = 75;
    assert.ok(Math.abs(H.releaseBonus(state) - 0.3) < 1e-12);
  });

  test("Seals fill the frontier Sprint meter; overflow banks up to the next target and pours in", () => {
    const w = mkWorld();
    H.addSeals(w, 4, null);
    assert.equal(w.state.herd.meter, 4);
    H.addSeals(w, 20, null); // target 6: 2 into the meter, 18 over, bank capped at the next target 10
    assert.equal(w.state.herd.meter, 6);
    assert.equal(w.state.herd.bank, 10);
    w.state.herd.zone = 1;
    w.state.herd.meter = 0;
    assert.equal(H.pourBank(w.state), 10);
    assert.equal(w.state.herd.meter, 10);
    assert.equal(w.state.herd.bank, 0);
    assert.equal(H.pourBank(w.state), 0, "idempotent");
    assert.equal(w.state.herd.seals, 24, "every credited Seal counts for the Release Train");
  });
});

describe("waypoints and the boss door (D§9.1)", () => {
  test("1-1 open at start; 40 kills open the next map; the boss opens the next zone", () => {
    const { state } = mkWorld();
    assert.ok(H.mapUnlocked(state, "1-1"));
    assert.ok(!H.mapUnlocked(state, "1-2"));
    state.herd.quota = { "1-1": 39 };
    assert.ok(!H.mapUnlocked(state, "1-2"));
    state.herd.quota["1-1"] = 40;
    assert.ok(H.mapUnlocked(state, "1-2"));
    assert.ok(!H.mapUnlocked(state, "2-1"));
    state.herd.zone = 1;
    state.herd.boss[0] = 1;
    assert.ok(H.mapUnlocked(state, "2-1"));
    assert.ok(H.mapUnlocked(state, "1-3"), "zones behind the frontier are fully open");
    assert.ok(!H.mapUnlocked(state, "backlog"));
    assert.deepEqual(H.unlockedMaps(state).map((m) => m.id), ["1-1", "1-2", "1-3", "2-1"]);
    // after the Heisenbug the herd's frontier is the Backlog (9): every map and the Backlog are open
    state.herd.zone = 9;
    state.herd.boss = new Array(9).fill(1);
    assert.equal(H.unlockedMaps(state).length, 27);
    assert.ok(H.mapUnlocked(state, "backlog"));
  });

  test("the door needs the last map's 40 kills and a full meter; beaten bosses stay open", () => {
    const { state } = mkWorld();
    state.herd.quota = { "1-1": 40, "1-2": 40, "1-3": 40 };
    state.herd.meter = 5.9;
    assert.ok(!H.doorOpen(state, 0));
    state.herd.meter = 6;
    assert.ok(H.doorOpen(state, 0));
    assert.ok(!H.doorOpen(state, 1));
    state.herd.zone = 1;
    state.herd.boss[0] = 1;
    state.herd.meter = 0;
    assert.ok(H.doorOpen(state, 0), "repeat kills need no meter");
  });
});

describe("Localhost buildings (D§10.2)", () => {
  test("cost base x 3^(n-1); max level; not enough gold", () => {
    const { state } = mkWorld({ gold: 100000, born: 100, day: 120 }); // the herd's day 21: Campfire 3 open
    assert.equal(H.nextBuildingCost(state, "campfire"), 800);
    let r = H.buy(state, "campfire");
    assert.deepEqual([r.ok, r.cost, r.level], [true, 800, 1]);
    assert.equal(H.nextBuildingCost(state, 0), 2400);
    assert.equal(state.herd.gold, 99200);
    state.herd.bld[5] = 5;
    r = H.buy(state, "war_room");
    assert.equal(r.ok, false);
    assert.equal(r.error, "Max level");
    assert.equal(H.nextBuildingCost(state, 5), null);
    state.herd.gold = 10;
    r = H.buy(state, 1);
    assert.equal(r.ok, false);
    assert.equal(r.error, "Not enough gold");
    assert.equal(H.buy(state, 99).error, "Unknown building");
    // the design's level-10 costs
    assert.equal(F.buildingCost(D.BUILDINGS[0], 10), 15746400);
    assert.equal(F.buildingCost(D.BUILDINGS[5], 5), 243000);
  });

  test("building effects", () => {
    const { state } = mkWorld();
    state.herd.bld = [10, 4, 5, 0, 3, 2];
    assert.equal(H.freshEyesCapMin(state), 210);
    assert.ok(Math.abs(H.coffeeHealBonus(state) - 0.12) < 1e-12);
    assert.ok(Math.abs(H.coffeePriceMult(state) - 0.8) < 1e-12);
    assert.ok(Math.abs(H.polishDiscount(state) - 0.2) < 1e-12);
    assert.equal(H.warRoomTicks(state), 12);
    assert.ok(Math.abs(H.docsLibraryXp(state) - 0.06) < 1e-12);
    assert.ok(H.forgeUnlocked(state, "squashMerge"));
    assert.ok(H.forgeUnlocked(state, "reroll"));
    state.herd.bld[2] = 4;
    assert.ok(!H.forgeUnlocked(state, "reroll"));
    assert.equal(I.stashCap(state), 40);
    state.herd.bld[3] = 10;
    assert.equal(I.stashCap(state), 140);
  });

  test("autoBuyPick: the cheapest level with gold >= 3x its cost", () => {
    const { state } = mkWorld({ gold: 2399, born: 100, day: 120 });
    assert.equal(H.autoBuyPick(state), -1, "800 x 3 = 2400 needed");
    state.herd.gold = 2400;
    assert.equal(H.autoBuyPick(state), 0, "Campfire and Coffee Machine tie at 800: the first wins");
    state.herd.bld[0] = 1;
    state.herd.bld[1] = 1;
    state.herd.gold = 3000;
    assert.equal(H.autoBuyPick(state), 3, "vendor/ at 1,000 is now the cheapest");
  });
});

describe("the Campfire grows with the herd (balance: one level per 6 days, docs/BALANCE.md)", () => {
  test("herdAgeDays counts from herd.born (else the oldest hero); buildingGate names the day", () => {
    const { state } = mkWorld({ gold: 1e9, born: 0, day: 500 });
    assert.equal(H.herdAgeDays(state), 1, "no birth day yet: day 1");
    state.heroes.push({ id: 1, bornDay: 490 });
    assert.equal(H.herdAgeDays(state), 11);
    state.herd.born = 495;
    assert.equal(H.herdAgeDays(state), 6);
    assert.equal(H.buildingGate(state, "campfire"), null, "level 1 opens on day 6");
    assert.equal(H.buy(state, "campfire").ok, true);
    assert.deepEqual(H.buildingGate(state, "campfire"), { level: 2, day: 12 });
    assert.equal(H.buy(state, "campfire").ok, false);
    assert.equal(H.buildingGate(state, "coffee_machine"), null, "only the Campfire waits");
    assert.equal(H.autoBuyPick(state), 1);
  });
});

describe("Bug Tracker and zone perks (D§9.2, D§10.5)", () => {
  test("tiers at 500 / 5,000 / 50,000 herd kills; elites count x4", () => {
    const { state } = mkWorld();
    for (let i = 0; i < 499; i++) H.bugTrackerKill(state, 0, false);
    assert.equal(H.zoneTier(state, 0), 0);
    assert.equal(H.bugTrackerKill(state, 0, false), 1);
    assert.equal(H.bugTrackerKill(state, 0, true), 1);
    assert.equal(state.herd.bt[0], 504);
    state.herd.bt[0] = 4999;
    assert.equal(H.bugTrackerKill(state, 0, false), 2);
    state.herd.bt[0] = 49999;
    assert.equal(H.bugTrackerKill(state, 0, false), 3);
    assert.equal(H.bugTrackerKill(state, 99, false), 0, "unknown zones are ignored");
  });

  test("zonePerk scales the perk x1, x2, x3", () => {
    const { state } = mkWorld();
    state.herd.bt = [5000, 500, 50000, 0, 0, 0, 0, 0, 0];
    const p0 = H.zonePerk(state, 0);
    assert.equal(p0.tier, 2);
    assert.equal(p0.tierName, "Reproduced");
    assert.ok(Math.abs(p0.perk.xp - 0.04) < 1e-12);
    assert.equal(p0.next, 50000);
    assert.ok(Math.abs(H.zonePerk(state, 1).perk.gold - 0.03) < 1e-12);
    assert.ok(Math.abs(H.zonePerk(state, 2).perk.crit - 0.03) < 1e-12);
    assert.equal(H.zonePerk(state, 2).next, null);
    assert.equal(H.zonePerk(state, 3).tier, 0);
  });
});

describe("herd XP bonus (D§10.4)", () => {
  test("Release Train + Docs Library + Lint Meadows tracker + Legacy", () => {
    const { state } = mkWorld({ rel: 20 });
    state.herd.bld[4] = 3;
    state.herd.bt[0] = 500;
    state.herd.fame = [["A", 1, 40, T0], ["B", 2, 35, T0]];
    const p = H.herdXpParts(state);
    assert.ok(Math.abs(p.release - 0.1) < 1e-12);
    assert.ok(Math.abs(p.docs - 0.06) < 1e-12);
    assert.ok(Math.abs(p.tracker - 0.02) < 1e-12);
    assert.ok(Math.abs(p.legacy - 0.01) < 1e-12);
    assert.ok(Math.abs(H.herdXpBonus(state) - 0.19) < 1e-12);
    assert.equal(p.capped, false);
  });

  test("capped at +60%; Legacy capped at +10%", () => {
    const { state } = mkWorld({ rel: 60 });
    state.herd.bld[4] = 10;
    state.herd.bt[0] = 50000;
    state.herd.fame = new Array(40).fill(["X", 1, 30, T0]);
    assert.ok(Math.abs(H.legacyBonus(state) - 0.1) < 1e-12);
    const p = H.herdXpParts(state);
    assert.ok(p.raw > 0.6);
    assert.equal(p.total, 0.6);
    assert.equal(H.herdXpBonus(state), 0.6);
  });

  test("Onboarding: +50% while 10+ levels behind the top hero", () => {
    const { state } = mkWorld();
    const top = addHero(state, 25);
    const low = addHero(state, 15);
    const mid = addHero(state, 16);
    assert.equal(H.onboardingBonus(state, low), 0.5);
    assert.equal(H.onboardingBonus(state, mid), 0);
    assert.equal(H.onboardingBonus(state, top), 0);
  });
});

describe("trophies", () => {
  test("+1% damage and max HP per herd-first boss kill, read by heroes.stats", () => {
    const { state } = mkWorld();
    const h = addHero(state, 20, 3);
    const before = Hr.stats(h, { herd: state.herd });
    state.herd.boss[0] = 1;
    state.herd.boss[1] = 1;
    assert.deepEqual(H.trophyBonus(state), { dmg: 0.02, hpPct: 0.02, count: 2 });
    const after = Hr.stats(h, { herd: state.herd });
    assert.ok(Math.abs(after.dmgPct - before.dmgPct - 0.02) < 1e-12);
    assert.ok(after.maxHp > before.maxHp);
  });
});

describe("badges (D§10.6)", () => {
  test("every state-derived badge", () => {
    const w = mkWorld();
    const { state } = w;
    const ev = recEv();
    assert.deepEqual(H.checkBadges(w, ev), []);
    const h = addHero(state, 12, 1);
    h.st.kills = 1;
    assert.deepEqual(H.checkBadges(w, ev), ["hello_world"]);
    assert.ok(ev.notes.includes("Badge: Hello, World"));
    H.journal(state, "ship", h.id, "Fix", 1.2, T0);
    h.st.dodges = 1000;
    h.st.healed = 10000;
    state.herd.pairSec = 3600;
    assert.deepEqual(H.checkBadges(w, ev).sort(), ["duck_whisperer", "first_commit", "not_found", "pair_programmer"]);
    for (let c = 2; c <= 5; c++) addHero(state, 10, c);
    state.herd.boss[0] = 1;
    state.herd.boss[8] = 1;
    state.herd.bt[0] = 50000;
    state.heroes[1].L = 100;
    state.herd.backlog = { floor: 25, kills: 0 };
    state.herd.ducks = 1;
    assert.deepEqual(H.checkBadges(w, ev).sort(),
      ["deep_backlog", "fully_staffed", "lucky_duck", "principal_engineer", "ten_thousand_typos", "works_when_i_dont_look", "zero_warnings"]);
    assert.deepEqual(H.checkBadges(w, ev), [], "each badge once");
  });

  test("Thundering Herd needs 8 heroes working at once", () => {
    const w = mkWorld();
    for (let i = 1; i <= 7; i++) w.rt.live.set(i, { status: "working" });
    w.rt.live.set(8, { status: "blocked" });
    assert.ok(!H.checkBadges(w, null).includes("thundering_herd"));
    w.rt.live.set(9, { status: "working" });
    assert.ok(H.checkBadges(w, null).includes("thundering_herd"));
  });

  test("Fully Staffed needs all five classes (Lv 10+); awardBadge and noteDuck", () => {
    const w = mkWorld();
    for (let c = 1; c <= 4; c++) addHero(w.state, 12, c);
    assert.ok(!H.checkBadges(w, null).includes("fully_staffed"));
    assert.equal(H.awardBadge(w, "read_only_friday", null), true);
    assert.equal(H.awardBadge(w, "read_only_friday", null), false);
    assert.equal(H.awardBadge(w, "nope", null), false);
    assert.equal(H.noteDuck(w, null), true);
    assert.equal(w.state.herd.ducks, 1);
    assert.ok(H.hasBadge(w.state, "lucky_duck"));
    const list = H.badgeList(w.state);
    assert.equal(list.length, D.BADGES.length);
    assert.equal(list.filter((b) => b.earned).length, 2);
  });
});

describe("Hall of Fame (D§3.4, D§10.7)", () => {
  test("retire needs Lv 30; gear goes to the stash; Legacy grows", () => {
    const w = mkWorld();
    const young = addHero(w.state, 29, 1);
    assert.equal(H.retire(w, young.id, T0, null).error, "Retirement needs Lv 30");
    const vet = addHero(w.state, 40, 2);
    vet.eq[1] = I.rollItem({ rng: 5 }, { ilvl: 38, source: "chest", slot: "hat", state: w.state });
    const ev = recEv();
    const r = H.retire(w, vet.id, T0 + 5, ev);
    assert.equal(r.ok, true);
    assert.deepEqual(r.entry, [vet.name, 2, 40, T0 + 5]);
    assert.ok(!w.state.heroes.includes(vet));
    assert.equal(w.state.herd.stash.length, 1, "the hat moved; the starter stick is dropped");
    assert.ok(Math.abs(H.legacyBonus(w.state) - 0.005) < 1e-12);
    assert.deepEqual(H.hallOfFame(w.state)[0], { name: vet.name, clsId: "hotfixer", clsName: "Hotfixer", level: 40, at: T0 + 5 });
    assert.ok(ev.journals.some((j) => j[0] === "retire"));
    assert.equal(H.retire(w, 999, T0, null).error, "No such hero");
  });
});

describe("digest (D§10.7)", () => {
  test("never read: one line per kill, an old save's bare-name line matched, rolled-out lines dated by the first clear or left undated", () => {
    // digestAt 0 (never marked read); The Ignored Warning killed twice: its first kill's line was
    // journaled with the bare name (older saves), the repeat rolled out; The Pyramid of Doom's
    // only line rolled out too
    const { state } = mkWorld();
    state.herd.boss[0] = state.herd.boss[1] = 1;
    state.herd.bossKills[0] = 2;
    state.herd.bossKills[1] = 1;
    H.journal(state, "boss", 0, D.BOSSES[0].name, 0, T0 + 500);
    assert.equal(H.noteFirstClear(state, 1, T0 + 9000), true);
    assert.equal(H.noteFirstClear(state, 1, T0 + 99000), false, "set once");
    assert.equal(H.firstClearMs(state, 1), T0 + 9000);
    assert.equal(H.firstClearMs(state, 2), null);
    const d = H.digest(state);
    const lines = d.bosses.map((b) => [b.text, b.at]);
    assert.deepEqual(lines.slice().sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
      [`${D.BOSSES[0].name} FIXED`, null],
      [`${D.BOSSES[0].name} fixed again`, T0 + 500],
      [`${D.BOSSES[1].name} FIXED`, T0 + 9000],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    assert.ok(d.bosses.every((b) => b.at !== 0), "never the epoch (a 'Jan 1' line)");
    // once read, undated lines fall back to the read time
    H.digestMark(state, T0 + 1000);
    state.herd.bossKills[0] = 3;
    const d2 = H.digest(state);
    assert.deepEqual(d2.bosses.map((b) => [b.text, b.at]), [[`${D.BOSSES[0].name} fixed again`, T0 + 1000]]);
  });

  test("never read: kills whose lines rolled out sort after the dated first clear and before the journal's kills", () => {
    // The Pyramid of Doom: four kills; the first clear is dated (herd.bossAt), the newest kill is
    // still in the journal, the two between rolled out (the view lists them newest first)
    const { state } = mkWorld();
    const name = D.BOSSES[1].name;
    state.herd.boss[1] = 1;
    state.herd.bossKills[1] = 4;
    H.noteFirstClear(state, 1, T0 + 1000);
    H.journal(state, "boss", 0, `${name} fixed again`, 1, T0 + 90000);
    const d = H.digest(state);
    assert.deepEqual(d.bosses.map((b) => [b.text, b.at]), [
      [`${name} FIXED`, T0 + 1000],
      [`${name} fixed again`, null],
      [`${name} fixed again`, null],
      [`${name} fixed again`, T0 + 90000],
    ]);
    // nothing dated at all: still the first clear first
    state.herd.bossAt = [];
    state.herd.log = [];
    assert.deepEqual(H.digest(state).bosses.map((b) => b.text), [`${name} FIXED`, `${name} fixed again`, `${name} fixed again`, `${name} fixed again`]);
  });

  test("levels, drops, bosses and chests since digestAt", () => {
    const { state } = mkWorld({ digestAt: T0 + 100 });
    const h = addHero(state, 5);
    H.journal(state, "level", h.id, "Lv 4", 4, T0 + 50); // before: ignored
    H.journal(state, "level", h.id, "Lv 5", 5, T0 + 200);
    H.journal(state, "level", h.id, "Lv 6", 6, T0 + 300);
    H.journal(state, "drop", h.id, "Linted Pipe", 3, T0 + 300);
    H.journal(state, "boss", 0, "The Ignored Warning", 0, T0 + 400);
    h.pend = [{ min: 30, fmin: 0, title: "x", at: T0, sealFactor: 1 }];
    const d = H.digest(state);
    assert.equal(d.levels.length, 1);
    assert.equal(d.levels[0].level, 6);
    assert.equal(d.drops.length, 1);
    assert.equal(d.bosses.length, 1);
    assert.equal(d.chestsWaiting, 1);
    assert.ok(Math.abs(d.sealsWaiting - 3) < 1e-9);
    assert.equal(d.empty, false);
    assert.equal(H.digest(state, T0 + 1000).levels.length, 0);
    assert.equal(H.digestDot({ rt: { digestDot: true } }), true);
  });

  test("snapshot-based: counts survive a journal that has rolled over (digestMark diffs)", () => {
    const { state } = mkWorld();
    const a = addHero(state, 10);
    const b = addHero(state, 20);
    H.digestMark(state, T0 + 100);
    assert.deepEqual(state.herd.digestSnap.lv, { [a.id]: 10, [b.id]: 20 });
    assert.equal(state.herd.digestAt, T0 + 100);
    assert.equal(H.digest(state).empty, true);
    // a long night: two heroes level, a boss falls twice, 9 Release drops, Seals, a badge; then 120+
    // journal lines of noise push all of it out of the 120-line journal
    a.L = 14;
    b.L = 21;
    const c = addHero(state, 3); // hired since: counts from Lv 1
    state.herd.bossKills[0] = 2;
    state.herd.boss[0] = 1;
    state.herd.drops = 9;
    state.herd.seals = 12.5;
    state.herd.badges.push("hello_world");
    H.journal(state, "drop", a.id, "Linted Pipe", 3, T0 + 300);
    for (let i = 0; i < 130; i++) H.journal(state, "deprecate", null, "noise", 1, T0 + 400 + i);
    const d = H.digest(state);
    assert.deepEqual(d.levels.map((l) => [l.heroId, l.from, l.level]).sort((x, y) => x[0] - y[0]),
      [[a.id, 10, 14], [b.id, 20, 21], [c.id, 1, 3]]);
    assert.equal(d.bosses.length, 2);
    assert.deepEqual(d.bosses.map((x) => x.text).sort(), ["The Ignored Warning FIXED", "The Ignored Warning fixed again"]);
    assert.equal(d.drops.length, 0, "the journal lost the names");
    assert.equal(d.dropsMore, 9);
    assert.equal(d.sealsShipped, 12.5);
    assert.equal(d.shippedMore, 12.5);
    assert.deepEqual(d.badges.map((x) => x.text), ["Hello, World"]);
    assert.equal(d.empty, false);
    // marking it read starts the next digest from here
    H.digestMark(state, T0 + 9000);
    assert.equal(H.digest(state).empty, true);
  });

  test("a fresh herd's digest counts from the start", () => {
    const { state } = mkWorld({ digestAt: 0 });
    const a = addHero(state, 4);
    const d = H.digest(state);
    assert.deepEqual(d.levels.map((l) => [l.heroId, l.from, l.level]), [[a.id, 1, 4]]);
  });

  test("logDrop: Release+ only; LTS raises a pillar", () => {
    const w = mkWorld();
    const ev = recEv();
    const h = addHero(w.state, 30);
    H.logDrop(w, h, { uid: 1, base: 30, ilvl: 30, rar: 2, pol: 0, aff: [], flags: 0, prop: -1 }, ev);
    assert.equal(ev.journals.length, 0);
    H.logDrop(w, h, { uid: 2, base: 30, ilvl: 30, rar: 4, pol: 0, aff: [], flags: 0, prop: 1 }, ev);
    assert.equal(ev.journals[0][0], "drop");
    assert.equal(ev.fxs[0].kind, "pillar");
    assert.equal(ev.majors, 1);
  });
});

test("items.js journal lines (stash-full deprecations) keep the same journal length as herd.js (logMax), not 60", async () => {
  const I = await import("../mods/mapledr/game/items.js");
  const D = await import("../mods/mapledr/game/demo.js");
  const { world } = D.demoWorld("late", Date.UTC(2026, 10, 24, 9, 30));
  const s = world.state;
  while (s.herd.log.length < H.logMax(s)) s.herd.log.unshift(s.herd.log[0].slice());
  const before = s.herd.log.length;
  assert.equal(before, H.logMax(s));
  assert.ok(before > 60, `${s.heroes.length} heroes keep ${before} lines`);
  // fill the stash, then offer more junk: items.js journals "Stash full: deprecated ..."
  let n = 0;
  for (let i = 0; i < 400 && n === 0; i++) {
    const it = I.rollItem(s.heroes[0], { ilvl: 90, source: "chest", slot: "hat", classId: s.heroes[0].cls, rar: 4, state: s });
    I.stashPut(s, it);
    n = s.herd.log.filter((e) => e[1] === "deprecate").length;
  }
  assert.ok(n > 0, "a deprecation was journalled");
  assert.equal(s.herd.log.length, H.logMax(s), "the journal kept its length");
});
