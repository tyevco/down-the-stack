// Combat: rooms, lanes, kill pace, numbers adding up, every trait, the rotation and skill effect
// types, coffee and crashes, rest, quotas and the Backlog, determinism and cost.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as D from "../mods/down-the-stack/game/data.js";
import * as F from "../mods/down-the-stack/game/formulas.js";
import * as H from "../mods/down-the-stack/game/heroes.js";
import * as C from "../mods/down-the-stack/game/combat.js";
import { encodeState } from "../mods/down-the-stack/game/save.js";
import { makeWorld, makeEv, stepWorld, heroOf, liveOf } from "./helpers/engine.mjs";
import { within } from "./helpers/perf.mjs";
import { fullRefKit, sweep, SWEEP_CLASSES } from "../tools/pacing-sim.mjs";

const CLS5 = ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"];
const { makeMob } = C._internal;

// A synthetic on-level map (levels L-1..L+1 of plain Typo Sprouts, multipliers 1), like the
// reference simulator's generic mobs (tools/reference-sim/combat4.py). Test-process only.
function testMap(L, spawn = { typo_sprout: 1 }) {
  const id = `t-${L}-${Object.keys(spawn).join("+")}`;
  if (!D.MAP_BY_ID[id]) {
    D.MAP_BY_ID[id] = { n: 0, id, zone: 0, idx: 0, name: "test", levels: [Math.max(1, L - 1), L + 1], spawn, mid: L, top: L + 1 };
  }
  return id;
}

// Fills a hero's lane with hand-made, already arrived mobs (the lane is full, so nothing spawns).
function setLane(w, heroId, mobs) {
  const live = liveOf(w, heroId);
  live._laneMap = live.mapId;
  live.lane = mobs.map((spec, i) => {
    const def = D.MOB_BY_ID[spec.id || "typo_sprout"];
    const m = makeMob(w.rt, def, spec.level || heroOf(w, heroId).L, { arriveTick: 0, elite: !!spec.elite, hp: spec.hp, atk: spec.atk, half: spec.half });
    m.lanePos = i;
    if (spec.traits) Object.assign(m.traits, spec.traits);
    return m;
  });
  return live.lane;
}

// Steps while pinning the hero's level (XP keeps flowing but no level-ups change the numbers).
function farm(w, ev, ticks, pin = true) {
  for (let t = 0; t < ticks; t++) {
    stepWorld(w, ev, 1);
    if (pin) for (const h of w.state.heroes) { h.xp = 0; }
  }
}

// live.tally is created by combat on a hero's first lane tick
const ZERO = { dealt: 0, kills: 0, xp: 0, gold: 0, taken: 0, healed: 0, actions: 0, cups: 0, crashes: 0 };
function tal(live) {
  return live.tally || ZERO;
}

function sum(list, f = (x) => x) {
  let s = 0;
  for (const x of list) s += f(x);
  return s;
}

describe("rooms (D§11.3)", () => {
  test("slots follow live.order; adjacent same-space same-map heroes share a room", () => {
    const w = makeWorld({
      heroes: [
        { mapId: "1-1", space: "a", order: 0 }, { mapId: "1-1", space: "a", order: 1 },
        { mapId: "1-2", space: "a", order: 2 }, { mapId: "1-1", space: "a", order: 3 },
        { mapId: "1-1", space: "b", order: 4 },
      ],
    });
    const rooms = C.buildRooms(w);
    assert.deepEqual(rooms.map((r) => r.heroIds), [[1, 2], [3], [4], [5]]);
    assert.deepEqual(rooms.map((r) => r.mapId), ["1-1", "1-2", "1-1", "1-1"]);
    assert.deepEqual(rooms.map((r) => r.spaceId), ["a", "a", "a", "b"]);
    assert.equal(rooms[0].zone, 0);
    assert.equal(new Set(rooms.map((r) => r.id)).size, rooms.length);
  });

  test("order comes from live.order, not insertion; rooms are cached until membership changes", () => {
    const w = makeWorld({ heroes: [{ order: 5 }, { order: 1 }, { order: 3, mapId: "1-2" }] });
    const a = C.buildRooms(w);
    assert.deepEqual(a.map((r) => r.heroIds), [[2], [3], [1]]);
    liveOf(w, 1).state = "resting"; // status changes never reflow
    assert.equal(C.buildRooms(w), a);
    liveOf(w, 3).mapId = "1-1";
    const b = C.buildRooms(w);
    assert.notEqual(b, a);
    assert.deepEqual(b.map((r) => r.heroIds), [[2, 3, 1]]);
    assert.equal(b[0].id, "room:s1:1-1:2");
  });

  test("backlog rooms are zone 9", () => {
    const w = makeWorld({ heroes: [{ L: 100, cls: "hotfixer", mapId: "backlog" }] });
    assert.equal(C.buildRooms(w)[0].zone, D.BACKLOG.n);
  });
});

describe("kill pace (D§5.5: 14-19 kills/min on-level, reference kit)", () => {
  // tools/reference-sim/combat4.py with the final mob formulas (rf = 1.6 + 0.62 sqrt(m), C_HP 1,
  // C_ATK 0.03, walk regen 2%), 7200 ticks, seed L*7. Its Intern skips printf() at Lv 5.
  const REF = {
    20: [14.8, 15.6, 15.3, 15.2, 15.0], 40: [16.4, 14.7, 17.5, 16.1, 16.5],
    60: [17.4, 14.9, 18.0, 16.4, 16.9], 90: [17.1, 14.5, 18.0, 16.1, 16.4],
  };
  const TICKS = 1800;
  function kpm(cls, L, seed) {
    const w = makeWorld({ seed, heroes: [{ cls, L, mapId: testMap(L), kit: "none" }] });
    fullRefKit(w.state, heroOf(w, 1)); // D§5.2 complete (the affix ranges were halved: docs/BALANCE.md)
    farm(w, null, TICKS);
    const live = liveOf(w, 1);
    return { kpm: live.tally.kills / (TICKS / 60), crashes: live.tally.crashes, cups: live.tally.cups };
  }
  test("Intern at Lv 5", () => {
    const r = [kpm("intern", 5, 11), kpm("intern", 5, 12)];
    const k = (r[0].kpm + r[1].kpm) / 2;
    assert.ok(k >= 14 && k <= 19, `intern L5 ${k.toFixed(1)} kills/min`);
    assert.equal(r[0].crashes + r[1].crashes, 0);
  });
  for (const L of [20, 40, 60, 90]) {
    test(`every class at Lv ${L}, within 15% of the reference simulator`, () => {
      CLS5.forEach((cls, i) => {
        const r = [kpm(cls, L, L * 7 + i), kpm(cls, L, L * 7 + i + 100)];
        const k = (r[0].kpm + r[1].kpm) / 2;
        assert.ok(k >= 14 && k <= 19, `${cls} L${L}: ${k.toFixed(1)} kills/min`);
        assert.ok(Math.abs(k / REF[L][i] - 1) <= 0.15, `${cls} L${L}: ${k.toFixed(1)} vs reference ${REF[L][i]}`);
        assert.equal(r[0].crashes + r[1].crashes, 0, `${cls} L${L} crashed on level`);
        assert.ok(r[0].cups <= 10, `${cls} L${L} drank ${r[0].cups} cups in 30 min`);
      });
    });
  }
});

describe("sustain sweep: every real map x class at on-level, reference kit (D§4.3, D§5.5, D§5.6)", () => {
  // tools/pacing-sim.mjs sweep: one working hour per case (Backlog: the floor autopilot picks);
  // kill pace counted in on-level kills (kill XP / (mobXP(map mid) x gap)), so swarm halves and
  // tanky mobs count by what they pay; `npm run pacing -- --sweep` prints the table and also runs
  // real autopilot gear
  const rows = sweep({ kits: ["ref"], ticks: 3600, seed: 1 });
  test("133 cases: 27 maps x 5 classes, the Intern on zone 1, the Backlog", () => {
    assert.equal(rows.length, 27 * 5 - 2 * 5 + 3 + 5);
    assert.deepEqual([...new Set(rows.map((r) => r.cls))].sort(), ["intern", ...SWEEP_CLASSES].sort());
  });
  test("0 crashes and at most 3 cups per on-level hour", () => {
    const bad = rows.filter((r) => r.crashesH > 0 || r.cupsH > 3);
    assert.deepEqual(bad.map((r) => `${r.mapId} ${r.cls}: ${r.crashesH} crashes ${r.cupsH} cups`), []);
  });
  test("14-19 on-level kills a minute", () => {
    const bad = rows.filter((r) => r.xkpm < 14 || r.xkpm > 19);
    assert.deepEqual(bad.map((r) => `${r.mapId} ${r.cls}: ${r.xkpm.toFixed(1)}`), []);
    const mean = rows.reduce((a, r) => a + r.xkpm, 0) / rows.length;
    assert.ok(mean >= 15 && mean <= 17, `mean ${mean.toFixed(2)} (D§5.5: about 15.5)`);
  });
});

describe("numbers add up", () => {
  test("HP removed == damage dealt; one coin and one poof per kill; gold and XP match", () => {
    const w = makeWorld({ seed: 4, heroes: [{ cls: "shellmancer", L: 30, mapId: testMap(30) }] });
    w.state.herd.cfg.auto.deprecate = false;
    w.state.herd.cfg.auto.equip = false;
    const h = heroOf(w, 1);
    const live = liveOf(w, 1);
    const ev = makeEv();
    const seen = new Map();
    const gold0 = w.state.herd.gold;
    const xp0 = h.xp;
    const L0 = h.L;
    for (let t = 0; t < 900; t++) {
      for (const m of live.lane) seen.set(m.uid, m);
      stepWorld(w, ev, 1);
      for (const m of live.lane) seen.set(m.uid, m);
    }
    const removed = sum(seen.values(), (m) => m.maxHp - Math.max(0, m.hp));
    assert.equal(live.tally.dealt, removed);
    const kills = live.tally.kills;
    assert.ok(kills > 150, `kills ${kills}`);
    assert.equal(ev.fxOf("coin").length, kills);
    assert.equal(ev.fxOf("poof").length, kills);
    assert.equal(h.st.kills, kills);
    // gold: every coin's value lands in the herd (no stash salvage: auto-deprecate off; drops go
    // to the stash, which pays nothing)
    assert.equal(w.state.herd.gold - gold0, sum(ev.fxOf("coin"), (f) => f.value));
    // XP: what the levels consumed plus what is left equals what the kills granted
    let used = 0;
    for (let L = L0; L < h.L; L++) used += F.need(L);
    assert.ok(Math.abs(used + h.xp - xp0 - live.tally.xp) < 1e-6 * Math.max(1, live.tally.xp));
  });

  test("at most 2 outgoing numbers and 1 incoming per hero per tick; fx carry ids", () => {
    const w = makeWorld({ seed: 9, heroes: [{ cls: "forkbinder", L: 70, mapId: testMap(70) }, { cls: "rubberducker", L: 70, mapId: testMap(70) }] });
    liveOf(w, 1).forklings = [{ status: "working" }, { status: "working" }, { status: "working" }];
    const ev = makeEv();
    for (let t = 0; t < 300; t++) {
      ev.clear();
      stepWorld(w, ev, 1);
      for (const id of [1, 2]) {
        const out = ev.fxs.filter((f) => f.heroId === id && (f.kind === "num" || f.kind === "crit"));
        const inc = ev.fxs.filter((f) => f.heroId === id && f.kind === "incoming");
        assert.ok(out.length <= 2, `tick ${t}: ${out.length} numbers`);
        assert.ok(inc.length <= 1);
        for (const f of out) assert.ok(f.mobUid != null && f.roomId && f.text);
      }
    }
  });
});

describe("lane rules (D§5.5)", () => {
  test("spawn at the right edge, arrive next tick, advance step engages, first swing the tick after the first landed hit", () => {
    const w = makeWorld({ seed: 2, heroes: [{ cls: "refactorer", L: 20, mapId: testMap(20) }] });
    const live = liveOf(w, 1);
    const ev = makeEv();
    stepWorld(w, ev, 1); // ct 1: spawn (arrives at ct 2), advance with nothing to engage
    assert.equal(live.lane.length, 1);
    assert.equal(live.lane[0].arriveTick, 2);
    assert.equal(live.engagedUid, null);
    stepWorld(w, ev, 1); // ct 2: second spawn; advance step engages the first mob
    assert.equal(live.lane.length, 2);
    assert.equal(live.engagedUid, live.lane[0].uid);
    assert.equal(live.tally.actions, 0);
    const hp = live.lane[0].hp;
    stepWorld(w, ev, 1); // ct 3: first action lands; the mob reels (balance: T.lane.firstSwingDelay)
    assert.equal(live.tally.actions, 1);
    assert.ok(live.lane.length === 3 || live.lane[0].hp < hp);
    const tgt = () => live.lane.find((m) => m.uid === live.engagedUid);
    if (tgt()) {
      assert.equal(tgt().traits.swing, 0, "no swing on the first hit");
      assert.equal(tgt().swingTick, 3 + D.TUNING.lane.firstSwingDelay);
      stepWorld(w, ev, 1); // ct 4: first swing
      if (tgt()) assert.equal(tgt().traits.swing, 4);
    }
  });

  test("a hit that does not land (403 pending, 404 phaser) does not start the swing timer", () => {
    const w = makeWorld({ seed: 3, heroes: [{ cls: "refactorer", L: 20, mapId: "1-1" }] });
    const live = liveOf(w, 1);
    const lane = setLane(w, 1, [{ hp: 1e9, atk: 50, traits: { phaser: 1 } }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    live.engagedUid = lane[0].uid;
    stepWorld(w, null, 6);
    assert.equal(lane[0].swingTick, 0);
    assert.equal(tal(live).taken, 0, "a mob nobody has touched yet does not swing");
    lane[0].traits.phaser = 0;
    stepWorld(w, null, 3);
    assert.ok(lane[0].swingTick > 0 && tal(live).taken > 0);
  });

  test("slow mobs swing every 3rd tick, fast every tick, others every 2nd", () => {
    for (const [id, every] of [["semicolon_sloth", 3], ["callback_bat", 1], ["typo_sprout", 2]]) {
      const w = makeWorld({ seed: 5, heroes: [{ cls: "refactorer", L: 40, mapId: "1-1" }] });
      const live = liveOf(w, 1);
      setLane(w, 1, [{ id, hp: 1e9, atk: 10 }, { id, hp: 1e9 }, { id, hp: 1e9 }]);
      const swings = [];
      for (let t = 0; t < 13; t++) {
        stepWorld(w, null, 1);
        if (live.lane[0].traits.swing === live.ct) swings.push(live.ct);
      }
      const gaps = swings.slice(1).map((x, i) => x - swings[i]);
      assert.ok(gaps.length >= 3 && gaps.every((g) => g === every), `${id}: ${swings}`);
    }
  });

  test("Waiting heroes are frozen: no clock, no HP change, no cooldowns", () => {
    const w = makeWorld({ seed: 1, heroes: [{ cls: "hotfixer", L: 30, mapId: testMap(30) }] });
    stepWorld(w, null, 20);
    const live = liveOf(w, 1);
    live.state = "waiting";
    live.hp = live.maxHp * 0.6;
    const snap = JSON.stringify([live.ct, live.hp, live.cds, live.buffs, live.lane.map((m) => [m.hp, m.swingTick])]);
    stepWorld(w, null, 30);
    assert.equal(JSON.stringify([live.ct, live.hp, live.cds, live.buffs, live.lane.map((m) => [m.hp, m.swingTick])]), snap);
  });

  test("Supervising heroes act every 2nd tick; working Forklings hit every tick", () => {
    const w = makeWorld({ seed: 3, heroes: [{ cls: "forkbinder", L: 40, mapId: "1-1", state: "supervising" }] });
    const live = liveOf(w, 1);
    live.forklings = [{ status: "working" }, { status: "idle" }];
    setLane(w, 1, [{ hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    liveOf(w, 1).engagedUid = live.lane[0].uid;
    const ev = makeEv();
    const hits = [];
    for (let t = 0; t < 20; t++) {
      const a = tal(live).actions;
      const d = tal(live).dealt;
      stepWorld(w, ev, 1);
      hits.push([live.tally.actions - a, live.tally.dealt - d > 0]);
    }
    assert.equal(sum(hits, (x) => x[0]), 10);
    assert.ok(hits.every((x) => x[1]), "Forklings hit every tick");
  });

  test("a map change empties the lane (the hero walks to the new map)", () => {
    const w = makeWorld({ seed: 1, heroes: [{ L: 3, mapId: "1-1" }] });
    stepWorld(w, null, 5);
    const live = liveOf(w, 1);
    assert.ok(live.lane.length > 0);
    live.mapId = "1-2";
    stepWorld(w, null, 1);
    assert.ok(live.lane.every((m) => m.mobId !== "typo_sprout" || m.level >= 5));
    assert.ok(live.lane.length <= 1);
  });
});

describe("traits (D§9.4)", () => {
  function lab(cls, ids, opts = {}) {
    const w = makeWorld({ seed: opts.seed || 7, heroes: [{ cls, L: opts.L || 40, mapId: "1-1" }] });
    const lane = setLane(w, 1, ids.map((x) => (typeof x === "string" ? { id: x, hp: 1e9 } : x)));
    liveOf(w, 1).engagedUid = lane[0].uid;
    return { w, live: liveOf(w, 1), hero: heroOf(w, 1), lane, ev: makeEv() };
  }

  test("phaser: about p of hero hits miss with a 404 on the mob", () => {
    // a Lv 20 Refactorer puts exactly one roll a tick on its target (Main, or Area through it)
    const { w, lane, ev } = lab("refactorer", [{ id: "spinlock_top", hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }], { L: 20 });
    let misses = 0;
    for (let t = 0; t < 800; t++) {
      const hp = lane[0].hp;
      stepWorld(w, ev, 1);
      if (lane[0].hp === hp) misses++;
    }
    const p = misses / 800;
    assert.ok(Math.abs(p - 0.25) < 0.05, `miss rate ${p}`);
    assert.ok(ev.fxOf("miss").some((f) => f.mobUid === lane[0].uid && f.text === "404"));
  });

  test("clumsy: its swings miss (404 at the hero); the Bitflip Moth heals the hero instead", () => {
    const a = lab("refactorer", [{ id: "null_pointer_frog", hp: 1e9, traits: { clumsy: 1 } }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    stepWorld(a.w, a.ev, 40);
    assert.equal(a.live.tally.taken, 0);
    assert.ok(a.ev.fxs.some((f) => f.kind === "miss" && f.heroId === 1 && f.mobUid == null));
    const b = lab("refactorer", [{ id: "bitflip_moth", hp: 1e9, traits: { clumsy: 1, phaser: 0 } }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }], { L: 94 });
    b.live.hp = b.live.maxHp * 0.6;
    stepWorld(b.w, b.ev, 6);
    assert.ok(b.ev.fxOf("heal", 1).length > 0);
    assert.ok(b.live.hp > b.live.maxHp * 0.6);
  });

  test("pending: invulnerable (403) for its first 2 ticks in the lane, engaged or not (balance: D§9.4 says engaged)", () => {
    const { w, lane, ev } = lab("hotfixer", [{ id: "promise_wisp", hp: 1e6, atk: 0 }, { id: "promise_wisp", hp: 1e6, atk: 0 }, { hp: 1e9, atk: 0 }]);
    const hp0 = lane[0].hp;
    stepWorld(w, ev, 1);
    stepWorld(w, ev, 1);
    assert.equal(lane[0].hp, hp0);
    assert.equal(lane[1].hp, hp0, "a queued Wisp is still pending too");
    assert.ok(ev.fxOf("inv").some((f) => f.mobUid === lane[0].uid && f.text === "403"));
    assert.equal(lane[1].traits.pending, 0, "and it resolved while it waited");
    stepWorld(w, ev, 1);
    assert.ok(lane[0].hp < hp0);
  });

  test("leech: heals a share of the damage it deals", () => {
    // every hero hit phases through (phaser 1), so the leech's HP moves only by its own heals
    const { w, lane, live } = lab("rubberducker", [{ id: "diff_leech", hp: 1e6, atk: 50 }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    stepWorld(w, null, 1); // a first hit lands: the swing timer starts (combat: first landed hit)
    lane[0].traits.phaser = 1;
    lane[0].hp = 5e5;
    let healed = 0;
    for (let t = 0; t < 10; t++) {
      const taken = tal(live).taken;
      stepWorld(w, null, 1);
      const dt = tal(live).taken - taken;
      if (dt > 0) healed += Math.round(dt * 0.2);
    }
    assert.ok(healed > 0);
    assert.equal(lane[0].hp, 5e5 + healed);
    assert.ok(lane[0].traits.sipAt > 0);
  });

  test("reviver: once, back at 40% HP with a retry cue; the second death is the one kill", () => {
    const { w, lane, live, ev } = lab("refactorer", [{ id: "rebase_wraith", hp: 30, atk: 0, traits: { reviver: 1 } }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    const wraith = lane[0];
    stepWorld(w, ev, 1);
    assert.ok(wraith.traits.revived);
    assert.equal(wraith.hp, Math.round(0.4 * 30));
    assert.equal(live.tally.kills, 0);
    assert.ok(ev.fxs.some((f) => f.kind === "skill" && f.text === "retry" && f.mobUid === wraith.uid));
    stepWorld(w, ev, 3);
    assert.equal(live.tally.kills, 1);
    assert.ok(!live.lane.includes(wraith));
  });

  test("splitter: the Golem splits into HEAD and incoming at 30% HP and 30% XP each", () => {
    const { w, live, ev } = lab("refactorer", [{ id: "merge_conflict_golem", hp: 1000, atk: 0 }, { hp: 1e9, atk: 0 }]);
    const golem = live.lane[0];
    golem.hp = 1;
    live.lane.length = 1; // room for both halves
    stepWorld(w, ev, 1);
    const halves = live.lane.filter((m) => m.traits.half);
    assert.deepEqual(halves.map((m) => m.traits.half).sort(), ["HEAD", "incoming"]);
    for (const m of halves) {
      assert.equal(m.maxHp, 300);
      assert.ok(Math.abs(m.xp - golem.xp * 0.3) < 1e-9);
      assert.equal(m.traits.splitter, false);
      assert.ok(m.arriveTick <= live.ct);
    }
  });

  test("grower: +3% max and current HP per tick alive, at most +60%", () => {
    const { w, lane } = lab("refactorer", [{ hp: 1e9, atk: 0 }, { id: "memory_leak_slime", hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    const slime = lane[1];
    stepWorld(w, null, 5);
    assert.equal(slime.maxHp, 1e9 + 5 * 3e7);
    stepWorld(w, null, 30);
    assert.equal(slime.maxHp, 1.6e9);
    assert.ok(Math.abs(slime.traits.grow - 0.6) < 1e-9);
  });

  test("thorns: melee heroes take a share of their damage back; ranged classes and summoners are immune", () => {
    const melee = lab("refactorer", [{ id: "version_pin_porcupine", hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    stepWorld(melee.w, null, 4);
    assert.ok(melee.live.tally.taken > 0);
    for (const cls of ["shellmancer", "forkbinder"]) {
      const imm = lab(cls, [{ id: "version_pin_porcupine", hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
      stepWorld(imm.w, null, 4);
      assert.equal(imm.live.tally.taken, 0, cls);
    }
  });

  test("thorns go through DR and damage-taken modifiers, at most capPerTick of max HP a tick (D§9.4, balance)", () => {
    const { w, live, hero } = lab("hotfixer", [{ id: "version_pin_porcupine", hp: 1e12, atk: 0 }, { hp: 1e12, atk: 0 }, { hp: 1e12, atk: 0 }], { L: 54 });
    const per = [];
    let dealt = 0;
    for (let t = 0; t < 12; t++) {
      const taken = tal(live).taken;
      const d0 = tal(live).dealt;
      live.hp = live.maxHp; // no coffee, no crash in the way
      stepWorld(w, null, 1);
      per.push(tal(live).taken - taken);
      dealt += tal(live).dealt - d0;
    }
    const cap = Math.round(D.TRAITS.thorns.capPerTick * live.maxHp);
    assert.ok(per.every((x) => x <= cap), `per tick ${per} > cap ${cap}`);
    const p = D.MOB_BY_ID.version_pin_porcupine.thorns;
    assert.ok(per.reduce((a, x) => a + x, 0) < p * dealt * 0.9, "reflect is reduced by DR");
    // Stealth Commit (untargetable) also stops the spikes
    const st = lab("hotfixer", [{ id: "version_pin_porcupine", hp: 1e12, atk: 0 }, { hp: 1e12, atk: 0 }, { hp: 1e12, atk: 0 }], { L: 54 });
    C.addBuff(st.live, "stealth_commit", 50, { crit: true, untargetable: true });
    stepWorld(st.w, null, 5);
    assert.equal(tal(st.live).taken, 0);
    assert.ok(hero.st.dodges >= 0);
  });

  test("a dodged thorns reflection is no dodged attack: no 404 Not Found count, no Zero Downtime heal", () => {
    // Zero Downtime (the Hotfixer capstone) heals 1% max HP per dodge; a certain dodge (dodge 1)
    const mk = () => ({
      live: { hp: 500, maxHp: 1000, crashedUntil: 0 }, st: { dodge: 1, armor: 0, drFlat: 0, dmgTaken: 0, dr: () => 0 },
      hero: { rng: 12345, st: { dodges: 0 } }, untargetable: false, sv: { 6: { usable: true, onDodgeHealPct: 0.01 } },
      armorMul: 1, buffDmgTaken: 0,
    });
    const swing = mk();
    assert.equal(C.hitHero(swing, 100, 10), 0);
    assert.equal(swing.hero.st.dodges, 1, "a dodged swing counts");
    assert.equal(swing.live.hp, 510, "and heals");
    const reflect = mk();
    assert.equal(C.hitHero(reflect, 100, 10, D.TRAITS.thorns.capPerTick, true), 0);
    assert.equal(reflect.dodged, true, "still a 404 on screen");
    assert.equal(reflect.hero.st.dodges, 0, "not counted");
    assert.equal(reflect.live.hp, 500, "no heal");
    assert.equal(reflect.hero.rng === swing.hero.rng, true, "the same roll either way");
  });

  test("summons and Forklings never trigger thorns", () => {
    const { w, live, lane } = lab("refactorer", [{ id: "version_pin_porcupine", hp: 1e12, atk: 0 }, { hp: 1e12, atk: 0 }, { hp: 1e12, atk: 0 }], { L: 54 });
    live.state = "supervising";
    live.status = "idle";
    live.forklings = [{ address: "f1", status: "working" }, { address: "f2", status: "working" }];
    const hp0 = lane[0].hp;
    // odd ticks of a Supervising hero: only Forklings hit
    stepWorld(w, null, 1);
    assert.ok(lane[0].hp < hp0, "the Forklings hit");
    assert.equal(tal(live).taken, 0, "and nobody was pricked");
  });

  test("ranged: also swings from the second lane position every 3rd tick", () => {
    const { w, lane, live } = lab("refactorer", [{ hp: 1e9, atk: 0 }, { id: "anonymous_author", hp: 1e9, atk: 40 }, { hp: 1e9, atk: 0 }]);
    const shots = [];
    for (let t = 0; t < 12; t++) {
      stepWorld(w, null, 1);
      if (lane[1].traits.shotAt === live.ct) shots.push(live.ct);
    }
    assert.ok(shots.length >= 3);
    assert.ok(shots.slice(1).every((x, i) => x - shots[i] === 3), String(shots));
  });

  test("shapeshifter: every 5 ticks copies a trait (never swarm or splitter)", () => {
    const { w, lane } = lab("refactorer", [{ hp: 1e9, atk: 0 }, { id: "undefined_behavior", hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }], { seed: 21 });
    const shapes = new Set();
    for (let t = 0; t < 200; t++) {
      stepWorld(w, null, 1);
      const s = lane[1].traits;
      if (s.shape) shapes.add(s.shape);
      if (s.shapeAt) assert.equal(s.shapeAt % 5, 0);
    }
    assert.ok(shapes.size >= 6, [...shapes].join());
    assert.ok(!shapes.has("swarm") && !shapes.has("splitter"));
  });

  test("swarm: one spawn group of N members, each its own lane slot", () => {
    const w = makeWorld({ seed: 6, heroes: [{ cls: "shellmancer", L: 90, mapId: "9-1" }] });
    stepWorld(w, null, 1);
    const lane = liveOf(w, 1).lane;
    assert.equal(lane.length, 3);
    assert.ok(lane.every((m) => m.mobId === "off_by_one_twins"));
    assert.equal(new Set(lane.map((m) => m.uid)).size, 3);
  });

  test("tanky / elite / holo duck stats", () => {
    const w = makeWorld({});
    const tank = makeMob(w.rt, D.MOB_BY_ID.unused_import, 10, { arriveTick: 0 });
    assert.equal(tank.maxHp, F.mobHP(10, 1.6));
    const elite = makeMob(w.rt, D.MOB_BY_ID.typo_sprout, 10, { arriveTick: 0, elite: true });
    assert.equal(elite.maxHp, F.mobHP(10, 3));
    assert.equal(elite.atk, F.mobATK(10, D.MOB_BY_ID.typo_sprout.atk * 1.5));
    const duck = makeMob(w.rt, D.MOB_BY_ID.holo_duck, 10, { arriveTick: 0, holo: true });
    assert.equal(duck.maxHp, F.mobHP(10, 4));
    assert.equal(duck.atk, 0);
  });

  test("Holo Rubber Duck: waddles off 20 ticks after arriving; a kill pays a Duck Chest and Lucky Duck", () => {
    const a = lab("refactorer", [{ id: "holo_duck", hp: 1e9 }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    a.lane[0].holo = true;
    stepWorld(a.w, a.ev, 19);
    assert.ok(a.live.lane.some((m) => m.holo));
    stepWorld(a.w, a.ev, 1);
    assert.ok(!a.live.lane.some((m) => m.holo));
    assert.equal(a.live.tally.taken, 0);
    const b = lab("refactorer", [{ id: "holo_duck", hp: 5 }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    b.lane[0].holo = true;
    const snip = b.w.state.herd.snip;
    stepWorld(b.w, b.ev, 2);
    assert.equal(b.hero.st.ducks, 1);
    assert.ok(b.w.state.herd.badges.includes("lucky_duck"));
    assert.equal(b.ev.fxOf("loot").length, 1);
    assert.equal(b.ev.fxOf("loot")[0].holo, true, "the loot fx is marked: the stage draws a Duck Chest (D§11.8)");
    assert.ok(b.w.state.herd.snip >= snip + 5 * F.itemTier(40));
  });
});

describe("rotation and skills (D§7)", () => {
  function arena(cls, L, n = 3, opts = {}) {
    const w = makeWorld({ seed: opts.seed || 3, heroes: (opts.party || [{ cls, L, mapId: "1-1" }]) });
    for (const live of w.rt.live.values()) {
      const lane = setLane(w, w.rt.bind.get(live.address), Array.from({ length: n }, () => ({ hp: 1e9, atk: opts.atk ?? 0 })));
      live.engagedUid = lane[0].uid;
    }
    return { w, ev: makeEv() };
  }

  test("every class casts its Ultimate, Signature, Area and Buff with 3 mobs in the lane", () => {
    for (const cls of CLS5) {
      const { w, ev } = arena(cls, 90);
      stepWorld(w, ev, 90);
      const live = liveOf(w, 1);
      const sv = H.skillValue(heroOf(w, 1), 5);
      const floats = ev.fxOf("skill").map((f) => f.text);
      assert.ok(floats.includes(sv.name), `${cls}: no ${sv.name}`);
      assert.ok(live.cds.ult > 0 && live.cds.area > 0, `${cls} cds ${JSON.stringify(live.cds)}`);
      const sig = H.skillValue(heroOf(w, 1), 4);
      if (sig.type === "proc") assert.ok(floats.includes(sig.name), `${cls}: no ${sig.name}`);
      const buff = H.skillValue(heroOf(w, 1), 3);
      if (buff.type === "buff") assert.ok(live.cds.buff > 0, `${cls}: buff never cast`);
    }
  });

  test("Ultimate waits for a boss, 2+ targets or an elite; Area needs 2+ targets", () => {
    const one = arena("refactorer", 90, 1);
    liveOf(one.w, 1).lane.length = 1;
    // a 1-mob lane refills by spawn: keep removing extras before they arrive
    for (let t = 0; t < 30; t++) { stepWorld(one.w, one.ev, 1); liveOf(one.w, 1).lane.length = 1; }
    assert.ok(!(liveOf(one.w, 1).cds.ult > 0));
    assert.ok(!(liveOf(one.w, 1).cds.area > 0));
    const elite = arena("refactorer", 90, 1);
    liveOf(elite.w, 1).lane[0].elite = true;
    for (let t = 0; t < 3; t++) { stepWorld(elite.w, elite.ev, 1); liveOf(elite.w, 1).lane.length = 1; }
    assert.ok(liveOf(elite.w, 1).cds.ult > 0);
  });

  test("Hotfixer: Cherry-Pick fires on a single target and executes non-bosses below 15%", () => {
    const { w, ev } = arena("hotfixer", 40, 3);
    const live = liveOf(w, 1);
    const low = live.lane[2];
    low.hp = 1.2e8; // 12% of 1e9: far more than one hit, but under the 15% line
    stepWorld(w, ev, 1);
    assert.equal(low.hp, 0);
    assert.ok(!live.lane.includes(low));
    assert.equal(tal(live).kills, 1);
    assert.ok(live.cds.area > 0);
  });

  test("Hotfixer: Bisect stacks on the same target and resets on a new one", () => {
    const { w } = arena("hotfixer", 60, 3);
    const live = liveOf(w, 1);
    stepWorld(w, null, 6);
    assert.equal(live.bisect.target, live.engagedUid);
    assert.equal(live.bisect.stacks, 5);
    stepWorld(w, null, 20);
    assert.equal(live.bisect.stacks, 5 + Math.floor(H.skillValue(heroOf(w, 1), 4).effRank / 3));
  });

  test("Stealth Commit: every hit crits and mobs cannot hit you", () => {
    const { w, ev } = arena("hotfixer", 40, 3, { atk: 100 });
    stepWorld(w, ev, 1);
    const live = liveOf(w, 1);
    assert.ok(C.hasBuff(live, "stealth_commit"));
    const taken = live.tally.taken;
    ev.clear();
    stepWorld(w, ev, 3);
    assert.equal(live.tally.taken, taken);
    assert.ok(ev.fxs.filter((f) => f.heroId === 1 && (f.kind === "num" || f.kind === "crit")).every((f) => f.kind === "crit"));
  });

  test("Forkbinder: Forklings feed damage (20% of Main each, up to the counted number)", () => {
    const dealt = (n) => {
      const { w } = arena("forkbinder", 40, 3, { seed: 12 });
      liveOf(w, 1).forklings = Array.from({ length: n }, () => ({ status: "working" }));
      stepWorld(w, null, 200);
      return liveOf(w, 1).tally.dealt;
    };
    const d0 = dealt(0);
    const d3 = dealt(3);
    const d9 = dealt(9);
    assert.ok(d3 > d0 * 1.25, `${d0} -> ${d3}`);
    const counted = H.stats(heroOf(makeWorld({ heroes: [{ cls: "forkbinder", L: 40 }] }), 1), {}).forklingCount;
    assert.ok(counted >= 3 && counted <= 6);
    assert.ok(d9 > d3 || counted === 3);
  });

  test("Rubberducker: heals the lowest ally below 85%, Pair Programming buffs the lowest-level ally", () => {
    const { w, ev } = arena(null, 0, 3, {
      party: [{ cls: "rubberducker", L: 40, mapId: "1-1" }, { cls: "refactorer", L: 35, mapId: "1-1" }, { cls: "hotfixer", L: 38, mapId: "1-1" }],
    });
    liveOf(w, 2).hp = liveOf(w, 2).maxHp * 0.5;
    stepWorld(w, ev, 1);
    assert.ok(ev.fxOf("heal", 2).length >= 1);
    assert.ok(heroOf(w, 1).st.healed > 0);
    assert.ok(C.hasBuff(liveOf(w, 2), "pair_programming"));
    assert.ok(!C.hasBuff(liveOf(w, 3), "pair_programming"));
  });

  test("Retrospective revives crashed room allies and heals the room", () => {
    const { w, ev } = arena(null, 0, 3, {
      party: [{ cls: "rubberducker", L: 80, mapId: "1-1" }, { cls: "refactorer", L: 80, mapId: "1-1" }],
    });
    const ally = liveOf(w, 2);
    ally.hp = 0;
    ally.crashedUntil = 999;
    stepWorld(w, ev, 1);
    assert.equal(ally.crashedUntil, 0);
    assert.equal(Math.round(ally.hp), Math.round(ally.maxHp));
    assert.ok(C.hasBuff(ally, "retrospective"));
  });

  test("Code Review lowers the room's damage taken; auras reach the whole room once", () => {
    const { w } = arena(null, 0, 3, {
      party: [{ cls: "refactorer", L: 40, mapId: "1-1" }, { cls: "shellmancer", L: 40, mapId: "1-1" }],
      atk: 50,
    });
    stepWorld(w, null, 1);
    assert.ok(C.hasBuff(liveOf(w, 2), "code_review_room"));
    const duck = makeWorld({ heroes: [{ cls: "rubberducker", L: 50, mapId: "1-1" }, { cls: "hotfixer", L: 50, mapId: "1-1" }] });
    stepWorld(duck, null, 1);
    const r = H.effectiveRank(heroOf(duck, 1), 2);
    assert.ok(Math.abs(liveOf(duck, 2)._sctx.roomBonuses.xp - 0.01 * r) < 1e-12);
    assert.ok(Math.abs(liveOf(duck, 1)._sctx.roomBonuses.dmg - 0.005 * r) < 1e-12);
  });

  test("Unblocked (a live buff) adds +15% damage and XP; Good Listener doubles its length", () => {
    const w = makeWorld({ heroes: [{ cls: "rubberducker", L: 40, mapId: "1-1" }, { cls: "hotfixer", L: 40, mapId: "1-1" }] });
    w.rt.rooms = C.buildRooms(w);
    assert.equal(C.unblockedTicks(w, heroOf(w, 2), liveOf(w, 2)), 240);
    const solo = makeWorld({ heroes: [{ cls: "hotfixer", L: 40, mapId: "1-1" }] });
    solo.rt.rooms = C.buildRooms(solo);
    assert.equal(C.unblockedTicks(solo, heroOf(solo, 1), liveOf(solo, 1)), 120);
    const live = liveOf(solo, 1);
    stepWorld(solo, null, 1);
    const x0 = live._act.xpPct;
    const d0 = live._act.dmgPct;
    C.addBuff(live, "unblocked", 120);
    stepWorld(solo, null, 1);
    assert.ok(Math.abs(live._act.xpPct - x0 - 0.15) < 1e-9);
    assert.ok(live._act.dmgPct - d0 >= 0.15 - 1e-9);
  });

  test("a Contractor earns its own kill XP (world.js passes half of it to its seat)", () => {
    const w = makeWorld({ seed: 4, heroes: [{ cls: "shellmancer", L: 20, mapId: testMap(20) }, { cls: "shellmancer", L: 12 }] });
    const c = heroOf(w, 1);
    const benched = heroOf(w, 2);
    w.state.heroes.splice(w.state.heroes.indexOf(c), 1);
    c.contractor = true;
    w.rt.contractors.set(liveOf(w, 1).address, c);
    w.rt.live.delete(2);
    const xp0 = benched.xp;
    stepWorld(w, null, 120);
    assert.ok(liveOf(w, 1).tally.kills > 0);
    assert.ok(c.xp > 0 || c.L > 20, "the Contractor's own XP");
    assert.equal(benched.xp, xp0, "no direct share from combat");
  });
});

describe("coffee, crashes, rest (D§5.6, D§2.2)", () => {
  test("coffee below 45% HP, not within 5 ticks of the last cup; 35% heal", () => {
    const w = makeWorld({ seed: 2, heroes: [{ cls: "refactorer", L: 30, mapId: "1-1" }] });
    const lane = setLane(w, 1, [{ hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    const live = liveOf(w, 1);
    live.engagedUid = lane[0].uid;
    const h = heroOf(w, 1);
    const ev = makeEv();
    live.hp = live.maxHp * 0.3;
    stepWorld(w, ev, 1);
    assert.equal(h.cups, 19);
    assert.equal(ev.fxOf("coffee").length, 1);
    assert.ok(live.hp >= live.maxHp * 0.65 - 1);
    live.hp = live.maxHp * 0.3;
    stepWorld(w, ev, 3);
    assert.equal(h.cups, 19, "no cup within 5 ticks");
    stepWorld(w, ev, 2);
    assert.equal(h.cups, 18);
  });

  test("crash at 0 HP: down 5 ticks, back at 50%, buffs reset; 3 crashes in 10 minutes drop a map", () => {
    const w = makeWorld({ seed: 2, heroes: [{ cls: "refactorer", L: 30, mapId: "1-2" }] });
    const lane = setLane(w, 1, [{ hp: 1e9, atk: 1e6 }, { hp: 1e9, atk: 0 }, { hp: 1e9, atk: 0 }]);
    const live = liveOf(w, 1);
    const h = heroOf(w, 1);
    live.engagedUid = lane[0].uid;
    lane[0].swingTick = 1; // swings on the hero's first tick
    h.cups = 0;
    stepWorld(w, null, 1);
    assert.ok(live.crashedUntil > 0);
    assert.equal(live.hp, 0);
    assert.equal(live.buffs.length, 0);
    assert.equal(live.engagedUid, null);
    const until = live.crashedUntil;
    assert.equal(until - w.rt.tick, 5, "crashedUntil is in world ticks");
    stepWorld(w, null, 4);
    assert.ok(live.crashedUntil > 0);
    stepWorld(w, null, 1);
    assert.equal(live.crashedUntil, 0);
    assert.equal(live.hp, live.maxHp * 0.5);
    for (let k = 0; k < 2; k++) {
      live.hp = 1;
      live.lane[0].swingTick = live.ct + 1;
      live.engagedUid = live.lane[0].uid;
      for (let t = 0; t < 8 && !live.dropMap; t++) stepWorld(w, null, 1);
    }
    assert.ok(live.dropMap, "dropped a map");
    assert.equal(live.dropMap.mapId, "1-1");
    assert.equal(live.mapId, "1-1");
  });

  test("restTick: 5% regen, a cup per 30 ticks (paid), Fresh Eyes only after a first Seal, capped", () => {
    const w = makeWorld({ heroes: [{ cls: "shellmancer", L: 20, mapId: "1-1", state: "resting" }] });
    const h = heroOf(w, 1);
    const live = liveOf(w, 1);
    live.hp = live.maxHp * 0.5;
    h.cups = 10;
    w.state.herd.gold = 1e6;
    C.restTick(w, h, live);
    assert.ok(Math.abs(live.hp - live.maxHp * 0.55) < 1e-6);
    for (let t = 1; t < 30; t++) C.restTick(w, h, live);
    assert.equal(h.cups, 11);
    assert.ok(w.state.herd.gold < 1e6);
    assert.equal(h.fe, 0, "no Fresh Eyes before the first Seal");
    h.st.seals = 1;
    for (let t = 0; t < 240; t++) C.restTick(w, h, live);
    assert.ok(Math.abs(h.fe - 1) < 1e-9, `fe ${h.fe}`); // 0.25 min per minute
    h.fe = 59.999;
    for (let t = 0; t < 600; t++) C.restTick(w, h, live);
    assert.equal(h.fe, 60);
    live.state = "waiting";
    live.hp = 1;
    C.restTick(w, h, live);
    assert.equal(live.hp, 1, "Waiting is frozen");
  });

  test("Fresh Eyes drains 1 min per working minute and gives x1.5 kill XP", () => {
    const run = (fe) => {
      const w = makeWorld({ seed: 8, heroes: [{ cls: "hotfixer", L: 30, mapId: testMap(30) }] });
      heroOf(w, 1).fe = fe;
      farm(w, null, 600);
      return { xp: liveOf(w, 1).tally.xp, kills: liveOf(w, 1).tally.kills, fe: heroOf(w, 1).fe };
    };
    const a = run(0);
    const b = run(30);
    assert.ok(Math.abs(b.fe - 20) < 1e-6);
    assert.ok(Math.abs(b.xp / b.kills / (a.xp / a.kills) - 1.5) < 0.15);
  });
});

describe("world progress (D§9.1, D§9.8, D§10.5)", () => {
  test("40 herd kills on a map open the next map (note + journal); Bug Tracker counts kills", () => {
    const w = makeWorld({ seed: 3, heroes: [{ cls: "shellmancer", L: 12, mapId: "1-2" }] });
    const ev = makeEv();
    for (let t = 0; t < 600 && (w.state.herd.quota["1-2"] || 0) < 40; t++) stepWorld(w, ev, 1);
    assert.equal(w.state.herd.quota["1-2"], 40);
    assert.ok(ev.notes.some((n) => n.startsWith("1-2 cleared")));
    stepWorld(w, ev, 60);
    assert.equal(w.state.herd.quota["1-2"], 40, "quota stops at 40");
    assert.ok(w.state.herd.bt[0] >= 40);
  });

  test("Backlog: level-100 mobs with floor multipliers; 50 kills clear a floor; boss floors wait", () => {
    const w = makeWorld({ seed: 5, heroes: [{ cls: "hotfixer", L: 100, mapId: "backlog" }] });
    w.state.herd.backlog = { floor: 8, kills: 0 };
    stepWorld(w, null, 2);
    const m = liveOf(w, 1).lane[0];
    assert.equal(m.level, 100);
    assert.ok(m.v2);
    for (let t = 0; t < 4000 && w.state.herd.backlog.floor < 10; t++) stepWorld(w, null, 1);
    assert.equal(w.state.herd.backlog.floor, 10);
    for (let t = 0; t < 600; t++) stepWorld(w, null, 1);
    assert.equal(w.state.herd.backlog.floor, 10);
    assert.equal(w.state.herd.backlog.kills, 50);
  });
});

describe("determinism and cost", () => {
  function run(seed) {
    const w = makeWorld({
      seed, heroes: [
        { cls: "refactorer", L: 44, mapId: "4-3" }, { cls: "rubberducker", L: 42, mapId: "4-3" },
        { cls: "forkbinder", L: 40, mapId: "4-2", space: "s2" },
      ],
    });
    liveOf(w, 3).forklings = [{ status: "working" }];
    const ev = makeEv();
    stepWorld(w, ev, 600);
    return { text: encodeState(w.state).replace(/"crc":"[0-9a-f]+"/, ""), fx: JSON.stringify(ev.fxs), tally: JSON.stringify([...w.rt.live.values()].map((l) => l.tally)) };
  }
  test("same seed -> identical state, fx and tallies; another seed differs", () => {
    const a = run(77);
    const b = run(77);
    assert.equal(a.text, b.text);
    assert.equal(a.fx, b.fx);
    assert.equal(a.tally, b.tally);
    assert.notEqual(run(78).text, a.text);
  });

  test("stepRoom for 8 heroes stays well under 1 ms (V8)", (t) => {
    const heroes = [];
    for (let i = 0; i < 8; i++) heroes.push({ cls: CLS5[i % 5], L: 45 + i, mapId: "5-2" });
    const w = makeWorld({ seed: 3, heroes });
    liveOf(w, 4).forklings = [{ status: "working" }, { status: "working" }];
    const ev = { fx() {}, note() {}, banner() {}, major() {}, journal() {} };
    stepWorld(w, ev, 300);
    const N = 2000;
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < N; k++) {
      w.rt.tick++;
      w.rt.nowMs += 1000;
      for (const r of C.buildRooms(w)) C.stepRoom(w, r, ev);
    }
    // 0.4 ms a tick with PERF=1, 4 ms otherwise (test/helpers/perf.mjs)
    within(t, Number(process.hrtime.bigint() - t0) / N / 1e6, 0.4, "stepRoom per tick");
  });
});

