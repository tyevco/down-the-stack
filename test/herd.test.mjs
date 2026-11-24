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
import { newState } from "../mods/mapledr/game/save.js";

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

  test("journal keeps the newest 60 lines", () => {
    const { state } = mkWorld();
    for (let i = 0; i < 75; i++) H.journal(state, "ship", 1, `t${i}`, i, T0 + i);
    assert.equal(state.herd.log.length, 60);
    assert.deepEqual(state.herd.log[0], [T0 + 15, "ship", 1, "t15", 15]);
    assert.deepEqual(state.herd.log[59], [T0 + 74, "ship", 1, "t74", 74]);
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
    const { state } = mkWorld({ gold: 100000 });
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
    const { state } = mkWorld({ gold: 2399 });
    assert.equal(H.autoBuyPick(state), -1, "800 x 3 = 2400 needed");
    state.herd.gold = 2400;
    assert.equal(H.autoBuyPick(state), 0, "Campfire and Coffee Machine tie at 800: the first wins");
    state.herd.bld[0] = 1;
    state.herd.bld[1] = 1;
    state.herd.gold = 3000;
    assert.equal(H.autoBuyPick(state), 3, "vendor/ at 1,000 is now the cheapest");
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
