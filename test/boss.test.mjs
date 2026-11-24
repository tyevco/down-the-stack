// Bosses and reviews: solo on-level durations against D§9.5 / D§4.5, every mechanic primitive,
// Postmortems, suspension round trips, rewards, the estimate, participants and determinism.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as D from "../mods/mapledr/game/data.js";
import * as F from "../mods/mapledr/game/formulas.js";
import * as H from "../mods/mapledr/game/heroes.js";
import * as Bo from "../mods/mapledr/game/boss.js";
import { encodeState, decodeState } from "../mods/mapledr/game/save.js";
import { makeWorld as baseMakeWorld, addHero, makeEv, stepWorld, heroOf, liveOf } from "./helpers/engine.mjs";
import { fullRefKit } from "../tools/pacing-sim.mjs";

// Heroes wear the complete D§5.2 reference kit (the helper's kit carries the reference damage, HP
// and armor bonuses in one affix each, which the halved affix ranges can no longer hold: docs/BALANCE.md)
function makeWorld(opts = {}) {
  const w = baseMakeWorld(opts);
  (opts.heroes || []).forEach((spec, i) => { if ((spec.kit || "ref") === "ref") fullRefKit(w.state, w.state.heroes[i]); });
  return w;
}

const CLS5 = ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"];
const { KITS, arenaOf } = Bo._internal;

function map3(zone) {
  return D.ZONES[zone].maps[2].id;
}

function openDoor(w, zone) {
  const herd = w.state.herd;
  herd.zone = zone;
  herd.quota[map3(zone)] = 40;
  herd.meter = D.TUNING.sprint[zone];
  for (let z = 0; z < zone; z++) herd.boss[z] = 1;
}

// A solo fight: hero of class/level standing in the boss zone's last map.
function solo(b, cls, L, seed = 1, extra = {}) {
  const zone = D.BOSSES[b].zone;
  const w = makeWorld({ seed, heroes: [Object.assign({ cls, L, mapId: map3(zone) }, extra)] });
  const ev = makeEv();
  const f = Bo.startFight(w, "boss", b, [1], ev);
  return { w, ev, f, hero: heroOf(w, 1), live: liveOf(w, 1) };
}

function finish(w, ev, max = 400) {
  for (let t = 0; t < max; t++) {
    const done = stepWorld(w, ev, 1);
    if (done.length) return done[0].result;
  }
  return "running";
}

const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;

describe("solo on-level fights land in the D§9.5 / D§4.5 ranges (+-25%)", () => {
  test("The Ignored Warning: an Intern at Lv 9 wins in 66-93 ticks (+-25%)", () => {
    const ts = [1, 2, 3].map((s) => {
      const r = solo(0, "intern", 9, s);
      assert.equal(finish(r.w, r.ev), "won");
      assert.equal(r.live.tally.crashes, 0);
      return r.f.t;
    });
    const t = mean(ts);
    assert.ok(t >= 66 * 0.75 && t <= 93 * 1.25, `t ${t}`);
  });

  for (let b = 1; b < 9; b++) {
    test(`${D.BOSSES[b].name}: every class wins solo on level in 80-140 ticks (+-25%)`, () => {
      for (const cls of CLS5) {
        const ts = [1, 2].map((s) => {
          const r = solo(b, cls, D.BOSSES[b].level, s * 13 + b);
          const res = finish(r.w, r.ev);
          assert.equal(res, "won", `${cls} vs ${D.BOSSES[b].id}: ${res} at ${r.f.t}`);
          assert.ok(20 - r.hero.cups <= 20);
          return r.f.t;
        });
        const t = mean(ts);
        assert.ok(t >= 80 * 0.75 && t <= 140 * 1.25, `${cls} vs ${D.BOSSES[b].id}: ${t} ticks`);
      }
    });
  }

  test("The Heisenbug: Hotfixer ~86 and Shellmancer ~136 ticks (+-25%)", () => {
    for (const [cls, want] of [["hotfixer", 86], ["shellmancer", 136]]) {
      const t = mean([3, 4, 5].map((s) => { const r = solo(8, cls, 100, s); finish(r.w, r.ev); return r.f.t; }));
      assert.ok(Math.abs(t / want - 1) <= 0.25, `${cls}: ${t}`);
    }
  });

  test("Senior Review ~60-80 ticks and Staff Review ~110-150 ticks on level (class mean, +-25%)", () => {
    for (const [ri, L, lo, hi] of [[0, 30, 60, 80], [1, 60, 110, 150]]) {
      const ts = CLS5.map((cls, i) => {
        const w = makeWorld({ seed: 40 + i, heroes: [{ cls, L, mapId: "3-2", rev: ri === 1 ? [1, 0] : [0, 0] }] });
        const ev = makeEv();
        const f = Bo.startFight(w, "review", ri, [1], ev);
        assert.equal(finish(w, ev), "won", `${cls} review ${ri}`);
        return f.t;
      });
      const t = mean(ts);
      assert.ok(t >= lo * 0.75 && t <= hi * 1.25, `review ${ri}: ${ts}`);
    }
  });
});

describe("reviews (D§4.5)", () => {
  test("winning the Senior Review promotes: rev, +1 SP, a Release class weapon, review XP", () => {
    const w = makeWorld({ seed: 2, heroes: [{ cls: "hotfixer", L: 30, mapId: "3-2", rev: [0, 0] }] });
    const h = heroOf(w, 1);
    const ev = makeEv();
    const c = Bo.canChallenge(w, "review", 0);
    assert.ok(c.ok, c.error);
    assert.deepEqual(c.heroIds, [1]);
    assert.ok(c.estimate >= 1, `E ${c.estimate}`);
    const sp = h.spFree;
    const uid = w.state.herd.nextUid;
    Bo.startFight(w, "review", 0, null, ev);
    assert.ok(ev.notes.some((n) => n.startsWith("REVIEW")));
    assert.equal(finish(w, ev), "won");
    assert.equal(h.rev[0], 1);
    assert.ok(h.spFree >= sp + 1 || h.sp.reduce((a, x) => a + x, 0) > 0);
    const item = [...w.state.herd.stash, ...h.eq].find((it) => it && it.uid >= uid && it.rar === 3);
    assert.ok(item, "Release reward");
    assert.equal(D.BASE_LIST[item.base].type, "knives");
    assert.ok(ev.notes.some((n) => n === `PROMOTED: ${H.careerOf(h).title}`));
    assert.equal(H.careerOf(h).tierTitle, "Senior");
    assert.equal(Bo.canChallenge(w, "review", 0).ok, false, "already won");
  });

  test("review eligibility: level, class, Senior before Staff, Questing", () => {
    const w = makeWorld({ heroes: [{ cls: "refactorer", L: 29, mapId: "3-1" }, { cls: "refactorer", L: 64, mapId: "6-2", rev: [0, 0] }] });
    assert.equal(Bo.canChallenge(w, "review", 0, 1).ok, false);
    assert.equal(Bo.canChallenge(w, "review", 1, 2).ok, false, "Staff needs the Senior Review first");
    assert.equal(Bo.canChallenge(w, "review", 0, 2).ok, true);
    liveOf(w, 2).state = "resting";
    assert.equal(Bo.canChallenge(w, "review", 0, 2).ok, false);
  });

  test("Staff Review: 3 phases, 2 Nitpicks at each change, -50% damage taken while one lives", () => {
    const w = makeWorld({ seed: 2, heroes: [{ cls: "refactorer", L: 60, mapId: "6-2", rev: [1, 0] }] });
    const ev = makeEv();
    const f = Bo.startFight(w, "review", 1, [1], ev);
    const body = f.parts[0];
    assert.equal(body.maxHp, 26 * F.mobHP(60));
    assert.equal(f.swing, Math.round(2 * F.mobATK(60)));
    assert.equal(f.swingEvery, 3);
    body.hp = Math.round(body.maxHp * 0.6);
    stepWorld(w, ev, 1);
    assert.equal(f.phase, 2);
    assert.equal(f.phaseLabel, "blocking:");
    const nits = f.parts.filter((p) => p.kind === "add");
    assert.equal(nits.length, 2);
    assert.equal(nits[0].maxHp, F.mobHP(60));
    const C = liveOf(w, 1)._act;
    assert.equal(KITS.staff_review.mod(f, C, body, 1000), 500);
  });
});

describe("mechanic primitives (D§9.6)", () => {
  test("spawnAdd + burstAdds: Warning Mites every 20 ticks (max 3, +10% damage each), then Promoted to Error", () => {
    const { w, ev, f } = solo(0, "refactorer", 40, 1);
    const body = f.parts[0];
    body.hp = body.maxHp = 1e9; // keep phase 1 going
    f.pool = 1e9;
    for (let t = 0; t < 19; t++) stepWorld(w, ev, 1);
    assert.equal(f.parts.filter((p) => p.kind === "add").length, 0);
    assert.equal(f.mechText, "999+ warnings");
    stepWorld(w, ev, 1);
    const mites = f.parts.filter((p) => p.kind === "add");
    assert.ok(mites.length === 1 || f.dealt > 0);
    assert.equal(KITS.ignored_warning.dmg(f), 0.1 * mites.length);
    // "+1 warning" stays up for 3 ticks (it was overwritten in the same tick), then the count
    if (mites.length) {
      assert.match(f.mechText, /^\+1 warning/);
      stepWorld(w, ev, 2);
      assert.match(f.mechText, /^\+1 warning/);
      stepWorld(w, ev, 1);
      assert.match(f.mechText, /warnings$/);
    }
    // phase 2
    body.hp = Math.round(body.maxHp * 0.49);
    stepWorld(w, ev, 1);
    assert.equal(f.mech.p2, 1);
    assert.equal(f.phaseLabel, "Promoted to Error");
    assert.ok(f.parts.filter((p) => p.kind === "add").length >= 2);
    assert.ok(f.invuln);
    const C = liveOf(w, 1)._act;
    assert.equal(arenaOf(f).mod(C, body, 1000, 0), 0);
    for (const p of f.parts) if (p.kind === "add") p.hp = 0;
    stepWorld(w, ev, 1);
    assert.equal(f.invuln, false);
    assert.equal(KITS.ignored_warning.dmg(f), 0.3);
  });

  test("layers: overkill is wasted at each third; await (6 ticks 403, 3 bats); resolve() 20% or 5%", () => {
    const { w, ev, f, live } = solo(1, "hotfixer", 60, 1);
    const body = f.parts[0];
    assert.equal(f.segments, 3);
    const floor1 = Math.round(body.maxHp * 2 / 3);
    body.hp = floor1 + 5;
    stepWorld(w, ev, 1);
    assert.equal(body.hp, floor1);
    assert.equal(f.mech.layer, 1);
    assert.equal(f.mech.wait, 6);
    assert.equal(f.parts.filter((p) => p.kind === "add").length, 3);
    assert.ok(f.invuln);
    for (let t = 0; t < 5; t++) stepWorld(w, ev, 1);
    assert.equal(body.hp, floor1, "invulnerable during await");
    for (const p of f.parts) if (p.kind === "add") p.hp = 0;
    const hp = live.hp;
    ev.clear();
    stepWorld(w, ev, 1);
    assert.equal(f.phaseLabel, "resolve()");
    assert.ok(ev.notes.some((n) => n.includes("resolve() 5%")));
    assert.ok(live.hp < hp + live.maxHp * 0.01);
    assert.equal(KITS.pyramid_of_doom.dmg(f), 0);
    f.mech.layer = 2;
    assert.equal(KITS.pyramid_of_doom.dmg(f), 0.3);
  });

  test("burstCheck: telegraph every 25 ticks; enough damage Anchors it (stun, +20%), else it heals; heroes hold", () => {
    const strong = solo(2, "hotfixer", 60, 1);
    const sf = strong.f;
    sf.parts[0].hp = sf.parts[0].maxHp = sf.pool = 1e7;
    for (let t = 0; t < 20; t++) stepWorld(strong.w, strong.ev, 1);
    assert.equal(KITS.catastrophic_backtracker.hold(sf), false);
    stepWorld(strong.w, strong.ev, 1);
    assert.equal(sf.t, 21);
    assert.equal(KITS.catastrophic_backtracker.hold(sf), true);
    // still held on the tick the telegraph opens (kit.tick opens it after the heroes act), so the
    // burst lands inside the counted window
    assert.equal(KITS.catastrophic_backtracker.hold({ t: 25, mech: { next: 25, tel: 0 } }), true);
    assert.equal(KITS.catastrophic_backtracker.hold({ t: 26, mech: { next: 50, tel: 5 } }), false);
    for (let t = 0; t < 4; t++) stepWorld(strong.w, strong.ev, 1);
    assert.equal(sf.mech.tel, 5);
    assert.equal(sf.phaseLabel, "Trying again...");
    sf.mech.got = 0;
    for (let t = 0; t < 5; t++) stepWorld(strong.w, strong.ev, 1);
    assert.ok(sf.mech.got >= 0.05 * 1e7 || sf.phaseLabel === "backtracked");
    // a weak hero cannot anchor it: it heals half of what it took in 15 ticks
    const weak = solo(2, "intern", 9, 2);
    const wf = weak.f;
    wf.swing = 0; // keep the Intern standing
    for (let t = 0; t < 29; t++) stepWorld(weak.w, weak.ev, 1);
    assert.equal(wf.mech.next, 25 + 25, "start to start");
    const before = wf.parts[0].hp;
    let hist = 0;
    for (const x of wf.mech.hist) hist += x;
    stepWorld(weak.w, weak.ev, 1);
    assert.equal(wf.phaseLabel, "backtracked");
    assert.ok(hist > 0);
    assert.ok(wf.parts[0].hp > before - 100, `${before} -> ${wf.parts[0].hp}`);
  });

  test("shieldParts: 8 tentacles; body -75% while 4+ live; single target picks the lowest tentacle; one regrows at a time", () => {
    const { w, ev, f, live } = solo(3, "refactorer", 45, 1);
    const body = f.parts[0];
    const arms = f.parts.filter((p) => p.kind === "tentacle");
    assert.equal(arms.length, 8);
    assert.equal(arms[0].maxHp, Math.round(body.maxHp * 0.05));
    assert.deepEqual(arms.map((p) => p.label), D.BOSS_PARTS.octopus_merge);
    stepWorld(w, ev, 1);
    const C = live._act;
    assert.equal(KITS.octopus_merge.mod(f, C, body, 1000), 250);
    arms[3].hp = 5;
    assert.equal(arenaOf(f).main, arms[3]);
    for (const p of arms.slice(0, 5)) p.hp = 0;
    assert.equal(arenaOf(f).main, body);
    assert.equal(KITS.octopus_merge.mod(f, C, body, 1000), 1000);
    // the regrow queue, in isolation (no heroes): one tentacle every 20 ticks
    const kit = KITS.octopus_merge;
    f.mech.regrowAt = 0;
    f.t = 100;
    kit.tick(w, f, [], 0, ev);
    assert.equal(f.mech.regrowAt, 120);
    for (f.t = 101; f.t < 120; f.t++) kit.tick(w, f, [], 0, ev);
    assert.equal(arms.filter((p) => p.hp > 0).length, 3);
    kit.tick(w, f, [], 0, ev);
    assert.equal(arms.filter((p) => p.hp > 0).length, 4);
    assert.equal(arms[0].hp, arms[0].maxHp);
    assert.equal(f.mech.regrowAt, 140);
    body.hp = Math.round(body.maxHp * 0.39); // Fast-forward: every 12 ticks below 40%
    for (f.t = 121; f.t <= 140; f.t++) kit.tick(w, f, [], 0, ev);
    assert.equal(f.mech.regrowAt, 152);
  });

  test("grow + spawnAdd: Bloatodon installs every 12 ticks (+4% max HP), Left-Pad Mites every 30 (+5% DR), Install complete at 10", () => {
    const { w, ev, f, live } = solo(4, "rubberducker", 70, 1);
    const body = f.parts[0];
    body.hp = body.maxHp = f.pool = f.mech.base = 1e9;
    for (let t = 0; t < 12; t++) stepWorld(w, ev, 1);
    assert.equal(f.mech.deps, 1);
    assert.equal(body.maxHp, 1e9 * 1.04);
    assert.equal(f.mechText, "+1 deps");
    for (let t = 0; t < 18; t++) stepWorld(w, ev, 1);
    const mites = f.parts.filter((p) => p.kind === "add");
    assert.equal(mites.length, 3);
    assert.equal(mites[0].maxHp, F.mobHP(56, 0.5));
    const C = live._act;
    assert.equal(KITS.bloatodon.mod(f, C, body, 1000), 850);
    f.mech.deps = 9;
    f.t = 119;
    stepWorld(w, ev, 1);
    assert.equal(f.mech.deps, 10);
    assert.ok(f.enraged);
    assert.ok(ev.notes.some((n) => n.includes("Install complete")));
  });

  test("twinHeads + balanceCheck: Lock Contention, Waiting head (403), Deadlock Resolved or the party waits", () => {
    const { w, ev, f, live } = solo(5, "shellmancer", 67, 1);
    const [mutex, sema] = f.parts;
    assert.equal(mutex.label, "Mutex");
    assert.equal(sema.label, "Semaphore");
    assert.equal(mutex.maxHp + sema.maxHp, f.pool + (f.pool % 2 ? 1 : 0));
    // tougher heads, so the fight outlasts the two checks this test needs
    for (const p of [mutex, sema]) { p.maxHp *= 20; p.hp = p.maxHp; }
    mutex.hp = Math.round(mutex.maxHp * 0.8);
    assert.equal(arenaOf(f).main, sema);
    stepWorld(w, ev, 1);
    assert.equal(f.mech.low, 0, "Mutex waits: 20 points behind");
    assert.equal(KITS.deadlock_hydra.mod(f, live._act, mutex, 1000), 0);
    sema.hp = Math.round(sema.maxHp * 0.82);
    stepWorld(w, ev, 1);
    assert.equal(f.mech.low, -1);
    // the check at tick 40: balanced -> Resolved
    for (let i = 0; i < 100 && f.t < 40 && !f.result; i++) stepWorld(w, ev, 1);
    assert.equal(f.mech.tel, 3);
    mutex.hp = Math.round(mutex.maxHp * 0.5);
    sema.hp = Math.round(sema.maxHp * 0.5);
    for (let t = 0; t < 3; t++) stepWorld(w, ev, 1);
    assert.equal(f.phaseLabel, "Resolved");
    assert.ok(f.mech.stun > 0);
    assert.ok(KITS.deadlock_hydra.mod(f, live._act, sema, 1000) === 1250);
    // the next check unbalanced -> the party waits 3 ticks (no actions)
    for (let i = 0; i < 100 && f.t < 80 && !f.result; i++) stepWorld(w, ev, 1);
    mutex.hp = Math.round(mutex.maxHp * 0.3);
    sema.hp = Math.round(sema.maxHp * 0.4);
    f.mech.low = -1;
    for (let t = 0; t < 3; t++) { stepWorld(w, ev, 1); f.mech.low = -1; mutex.hp = Math.round(mutex.maxHp * 0.3); sema.hp = Math.round(sema.maxHp * 0.4); }
    assert.equal(f.mech.wait, 3);
    const a = live.tally.actions;
    stepWorld(w, ev, 1);
    assert.equal(live.tally.actions, a);
  });

  test("split + mesh: the Monolith decomposes at 60% into 6 Microservices that heal each other", () => {
    const { w, ev, f, live } = solo(6, "hotfixer", 78, 1);
    const body = f.parts[0];
    stepWorld(w, ev, 1);
    assert.equal(KITS.monolith.mod(f, live._act, body, 1000, 0), 750);
    assert.equal(KITS.monolith.mod(f, live._act, body, 1000, 1), 1000);
    body.hp = Math.round(body.maxHp * 0.59);
    const left = body.hp;
    stepWorld(w, ev, 1);
    const svc = f.parts.filter((p) => p.kind === "service");
    assert.equal(svc.length, 6);
    assert.deepEqual(svc.map((p) => p.label), D.BOSS_PARTS.monolith);
    assert.ok(svc[0].maxHp * 6 <= left + 6 && svc[0].maxHp * 6 > left * 0.9, "the services share what is left");
    assert.equal(f.phaseLabel, "Decompose");
    svc[1].hp = svc[1].maxHp - 10000;
    for (const p of svc) if (p !== svc[1]) p.hp = p.maxHp;
    const target = arenaOf(f).main;
    assert.equal(target, svc[1]);
    // Service Mesh, in isolation: each service heals every other by 0.25% of its max HP per tick
    svc[2].hp -= 50000;
    const hurt = svc[2].hp;
    f.t++;
    KITS.monolith.tick(w, f, [], 0, ev);
    assert.equal(svc[2].hp, hurt + Math.round(5 * 0.0025 * svc[2].maxHp));
    for (const p of svc.slice(1)) p.hp = 0;
    stepWorld(w, ev, 1);
    assert.equal(f.phase, 3);
    assert.equal(f.phaseLabel, "Distributed Monolith");
    assert.equal(KITS.monolith.dmg(f), 1);
  });

  test("clock: Outage Breath every 30 ticks (DR at half), Pager Wyverns speed it up, Long Weekend", () => {
    const { w, ev, f, live } = solo(7, "refactorer", 89, 1);
    const body = f.parts[0];
    body.hp = body.maxHp = f.pool = 1e10;
    live.hp = live.maxHp;
    for (let t = 0; t < 29; t++) stepWorld(w, ev, 1);
    const hp = live.hp;
    ev.clear();
    stepWorld(w, ev, 1);
    assert.equal(f.mech.clock, 0);
    assert.ok(ev.notes.includes("Outage Breath"));
    assert.ok(live.hp < hp, "breath hurts");
    body.hp = Math.round(body.maxHp * 0.5);
    stepWorld(w, ev, 1);
    assert.equal(f.phase, 2);
    for (let t = 0; t < 25; t++) stepWorld(w, ev, 1);
    const wy = f.parts.filter((p) => p.kind === "add");
    assert.ok(wy.length >= 1 && wy.every((p) => p.art === "pager_wyvern"));
    body.hp = Math.round(body.maxHp * 0.3);
    stepWorld(w, ev, 1);
    assert.equal(f.phaseLabel, "Long Weekend");
    assert.equal(KITS.friday_deploy.party(f), 0.25);
    assert.ok(/^4:5\d PM$/.test(f.mechText), f.mechText);
  });

  test("stance + pulse + observed: Position/Momentum every 20 ticks, a pulse every 30, looking delays a teleport by 5", () => {
    const { w, ev, f, live } = solo(8, "hotfixer", 100, 1);
    const body = f.parts[0];
    body.hp = body.maxHp = f.pool = 1e12;
    stepWorld(w, ev, 1);
    const C = live._act;
    assert.equal(KITS.heisenbug.mod(f, C, body, 1000, 0), 1500);
    assert.equal(KITS.heisenbug.mod(f, C, body, 1000, 1), 500);
    for (let i = 0; i < 400 && f.t < 20 && !f.result; i++) stepWorld(w, ev, 1);
    assert.equal(f.mech.stance, 1);
    assert.equal(f.phaseLabel, "Momentum");
    live.focused = true;
    stepWorld(w, ev, 1);
    assert.equal(f.mech.next, 20 + 20 + 5);
    for (let i = 0; i < 400 && f.t < 30 && !f.result; i++) stepWorld(w, ev, 1);
    assert.ok(live.tally.taken > 0);
    for (let i = 0; i < 400 && f.t < 45 && !f.result; i++) stepWorld(w, ev, 1);
    assert.equal(f.mech.stance, 0);
  });

  test("timer, War Room and enrage at 80%; the timer only runs while someone is Questing", () => {
    const w = makeWorld({ seed: 1, heroes: [{ cls: "refactorer", L: 78, mapId: "7-3" }] });
    w.state.herd.bld[D.BUILDING_IDX.war_room] = 2;
    const ev = makeEv();
    const f = Bo.startFight(w, "boss", 6, [1], ev);
    assert.equal(f.timer, 180 + 12);
    f.parts[0].hp = f.parts[0].maxHp = f.pool = 1e12;
    liveOf(w, 1).state = "waiting";
    stepWorld(w, ev, 10);
    assert.equal(f.t, 0, "a blocked participant holds");
    liveOf(w, 1).state = "questing";
    for (let i = 0; i < 400 && f.t < Math.floor(0.8 * 192) - 1 && !f.result; i++) stepWorld(w, ev, 1);
    assert.equal(f.enraged, false);
    stepWorld(w, ev, 1);
    assert.equal(f.enraged, true);
    heroOf(w, 1).cups = 99;
    assert.equal(finish(w, ev), "lost");
    assert.equal(f.t, 192);
  });
});

describe("Fresh Eyes in fights (D§2.2, D§2.9)", () => {
  test("the pool drains 1 minute per working minute in a boss fight too", () => {
    const { w, ev, hero } = solo(2, "shellmancer", 34, 3);
    hero.fe = 30;
    stepWorld(w, ev, 60);
    assert.ok(Math.abs(hero.fe - 29) < 1e-9, `fe ${hero.fe}`);
  });
});

describe("Postmortem, Wounds, Lessons, retry (D§9.5)", () => {
  test("a loss keeps 50% of the damage as Wounds, +10% Lessons, a 10-minute retry gate; a win clears them", () => {
    const w = makeWorld({ seed: 3, heroes: [{ cls: "refactorer", L: 44, mapId: "4-3" }] });
    openDoor(w, 3);
    const ev = makeEv();
    const f = Bo.startFight(w, "boss", 3, [1], ev);
    const pool = f.pool;
    heroOf(w, 1).cups = 999;
    f.t = f.timer - 20;
    f.enraged = true;
    assert.equal(finish(w, ev), "lost");
    const wd = w.state.herd.wounds["3"];
    assert.ok(Math.abs(wd[0] - Math.round(0.5 * f.dealt / pool * 1e4) / 1e4) < 1e-9);
    assert.equal(wd[2], 600);
    assert.equal(w.state.herd.lessons["3"], 1);
    assert.equal(w.state.herd.fight, null);
    assert.ok(ev.notes.some((n) => n.startsWith("Postmortem:")));
    const c = Bo.canChallenge(w, "boss", 3);
    assert.equal(c.ok, false);
    assert.match(c.error, /Retry in 10 working min/);
    stepWorld(w, ev, 599);
    assert.equal(Bo.canChallenge(w, "boss", 3).ok, false);
    stepWorld(w, ev, 1);
    assert.equal(Bo.canChallenge(w, "boss", 3).ok, true);
    const g = Bo.startFight(w, "boss", 3, [1], ev);
    assert.equal(g.parts[0].hp, Math.max(1, Math.round(g.parts[0].maxHp * (1 - wd[0]))));
    assert.ok(Math.abs(g.lessons - 0.1) < 1e-12);
    stepWorld(w, ev, 1);
    assert.ok(Math.abs(liveOf(w, 1)._act.bossPct - (liveOf(w, 1)._act.st.bossDmg + 0.1)) < 1e-12);
    g.parts.forEach((p) => { if (p.kind === "boss") p.hp = 1; });
    assert.equal(finish(w, ev), "won");
    assert.equal(w.state.herd.wounds["3"], undefined);
    assert.equal(w.state.herd.lessons["3"], undefined);
  });

  test("a crashed hero rejoins after 10 ticks at 50%; everyone crashed is a loss", () => {
    const { w, ev, f, live, hero } = solo(7, "refactorer", 89, 1);
    f.parts[0].hp = f.parts[0].maxHp = f.pool = 1e12;
    const mate = addHero(w, { cls: "hotfixer", L: 89, mapId: "8-3" });
    f.heroIds.push(mate.hero.id);
    hero.cups = 0;
    live.hp = 1; // the Refactorer stands in front: the next swing crashes it
    let crashed = 0;
    for (let t = 0; t < 4 && !crashed; t++) { stepWorld(w, ev, 1); if (live.crashedUntil > 0) crashed = w.rt.tick; }
    assert.ok(crashed, "crashed");
    assert.equal(live.crashedUntil - crashed, 10);
    stepWorld(w, ev, 9);
    assert.ok(live.crashedUntil > 0);
    stepWorld(w, ev, 1);
    assert.equal(live.crashedUntil, 0);
    assert.ok(live.hp >= live.maxHp * 0.3, "back at 50% (minus this tick's swing)");
    assert.ok(f.result === null);
    // alone and out of coffee: one crash ends it as a Postmortem
    const s = solo(7, "hotfixer", 70, 2);
    s.hero.cups = 0;
    s.live.hp = 1;
    assert.equal(finish(s.w, s.ev, 10), "lost");
    assert.ok(s.ev.notes.some((n) => n.startsWith("Postmortem")));
  });
});

describe("suspend and resume (D§9.5, D§13.1)", () => {
  test("nobody Questing for 10 minutes suspends the fight into herd.fight; a save round trip resumes it", () => {
    const { w, ev, f } = solo(3, "shellmancer", 45, 9);
    stepWorld(w, ev, 30);
    assert.deepEqual(w.state.herd.fight.ids, [1]);
    liveOf(w, 1).state = "resting";
    stepWorld(w, ev, 599);
    assert.equal(w.rt.fights.length, 1);
    const done = stepWorld(w, ev, 1);
    assert.equal(done[0].result, "suspended");
    assert.equal(w.rt.fights.length, 0);
    const saved = w.state.herd.fight;
    assert.equal(saved.t, f.t);
    assert.equal(saved.p.length, f.parts.length);
    // save, load, rebuild a live world around the same hero
    const { state } = decodeState(encodeState(w.state));
    const w2 = makeWorld({ seed: 1 });
    w2.state = state;
    const live = { ...liveOf(w, 1), state: "questing", lane: [], _act: undefined, _sctx: undefined, _arena: undefined, buffs: [], cds: {}, tally: undefined };
    w2.rt.live.set(1, live);
    w2.rt.bind.set(live.address, 1);
    const g = Bo.resumeFight(w2, ev);
    assert.ok(g);
    assert.equal(g.t, f.t);
    assert.deepEqual(g.parts.map((p) => [p.key, p.hp, p.maxHp]), f.parts.map((p) => [p.key, p.hp, p.maxHp]));
    assert.equal(g.mech.regrowAt, f.mech.regrowAt);
    assert.equal(finish(w2, ev), "won");
    assert.equal(w2.state.herd.fight, null);
    assert.equal(w2.state.herd.boss[3], 1);
  });

  test("herd.fight mirrors a running fight every tick and stays small", () => {
    const { w, ev, f } = solo(6, "rubberducker", 78, 2);
    for (let t = 0; t < 120; t++) {
      stepWorld(w, ev, 1);
      if (f.result) break;
      assert.equal(w.state.herd.fight.t, f.t);
    }
    assert.ok(JSON.stringify(Bo.packFight(f)).length < 600);
  });

  test("startFight on a boss with a suspended fight resumes it instead of starting over", () => {
    const { w, ev, f } = solo(5, "refactorer", 67, 3);
    stepWorld(w, ev, 15);
    liveOf(w, 1).state = "idle";
    liveOf(w, 1).state = "resting";
    stepWorld(w, ev, 600);
    assert.ok(w.state.herd.fight);
    liveOf(w, 1).state = "questing";
    const g = Bo.startFight(w, "boss", 5, null, ev);
    assert.equal(g.t, f.t);
  });
});

describe("rewards (D§8.6, D§9.5)", () => {
  test("a herd-first kill: trophy, next zone, Keepsake to the stash, items, gold, Snippets, boss XP, banner", () => {
    const w = makeWorld({ seed: 4, heroes: [{ cls: "shellmancer", L: 12, mapId: "1-3" }, { cls: "hotfixer", L: 12, mapId: "1-3" }] });
    openDoor(w, 0);
    const ev = makeEv();
    const herd = w.state.herd;
    herd.bank = 4;
    const gold0 = herd.gold;
    const snip0 = herd.snip;
    const xp0 = heroOf(w, 1).xp;
    const f = Bo.startFight(w, "boss", 0, null, ev);
    assert.equal(f.heroIds.length, 2);
    assert.equal(f.pool, F.bossHP(16, 12, 2));
    assert.equal(finish(w, ev), "won");
    assert.equal(herd.boss[0], 1);
    assert.equal(herd.bossKills[0], 1);
    assert.equal(herd.zone, 1);
    assert.equal(herd.meter, 4, "the bank poured into the new zone's meter");
    const ks = herd.stash.find((it) => it.rar === 5);
    assert.ok(ks);
    assert.equal(D.KEEPSAKES[ks.prop].id, "hazard_cone_hat");
    assert.ok(ev.banners.some((b) => b.text === "The herd reached frame #2"));
    assert.ok(ev.fxOf("stamp").length === 1);
    assert.ok(herd.gold - gold0 >= 2 * 60 * F.gold(12));
    assert.ok(herd.snip - snip0 >= 2 * 10 * F.itemTier(12));
    const h = heroOf(w, 1);
    assert.ok(h.cd.boss[0] != null);
    assert.ok(h.L > 12 || h.xp - xp0 >= F.bossXP(12, true) - 1);
  });

  test("repeat kills: xpRepeat x Need XP x level gap (balance: 0.02, design 0.1), once per 3 working hours per hero, no meter needed", () => {
    const w = makeWorld({ seed: 4, heroes: [{ cls: "shellmancer", L: 30, mapId: "1-3" }] });
    openDoor(w, 1);
    const h = heroOf(w, 1);
    h.cd.boss = { 0: 0 };
    h.st.wh = 2;
    assert.equal(Bo.participants(w, "boss", 0).heroIds.length, 0, "cooldown");
    h.st.wh = 3;
    assert.deepEqual(Bo.participants(w, "boss", 0).heroIds, [1]);
    const ev = makeEv();
    const L = h.L;
    const xp0 = h.xp;
    Bo.startFight(w, "boss", 0, null, ev);
    assert.equal(finish(w, ev), "won");
    assert.equal(w.state.herd.bossKills[0], 1);
    // boss XP follows the level gap like kill XP: a Lv 30 hero farming the Lv 12 boss gets the gap
    // floor of the repeat XP (integration fix: farming long-beaten bosses outpaced on-level work)
    assert.ok(h.L > L || Math.abs(h.xp - xp0 - F.bossXP(L, false) * F.gap(L - 12)) < 1);
    assert.equal(F.gap(L - 12), D.TUNING.gap.floor);
    assert.equal(h.cd.boss[0], 3 * 3600);
  });

  test("a Backlog boss floor: boss ((f/10)-1) mod 9 at Lv 100 with floor multipliers; a win opens the next floor", () => {
    const w = makeWorld({ seed: 5, heroes: [{ cls: "hotfixer", L: 100, mapId: "backlog" }] });
    w.state.herd.zone = 9;
    w.state.herd.backlog = { floor: 10, kills: 50 };
    const c = Bo.canChallenge(w, "backlog", 10);
    assert.ok(c.ok, c.error);
    const ev = makeEv();
    const f = Bo.startFight(w, "backlog", 10, null, ev);
    assert.equal(f.id, "ignored_warning");
    assert.equal(f.name, "The Ignored Warning v2");
    assert.equal(f.pool, Math.round(F.bossHP(16, 100, 1) * Math.pow(1.06, 10)));
    assert.equal(finish(w, ev), "won");
    assert.deepEqual(w.state.herd.backlog, { floor: 11, kills: 0 });
  });
});

describe("challenge, estimate, participants (D§9.5)", () => {
  test("the door must be open; one boss fight at a time; labels follow the estimate", () => {
    const w = makeWorld({ seed: 1, heroes: [{ cls: "hotfixer", L: 34, mapId: "3-3" }] });
    assert.equal(Bo.canChallenge(w, "boss", 2).ok, false);
    openDoor(w, 2);
    const c = Bo.canChallenge(w, "boss", 2);
    assert.ok(c.ok);
    assert.equal(c.label, c.estimate >= 1.2 ? "Favored" : c.estimate >= 0.95 ? "Even" : "Risky");
    Bo.startFight(w, "boss", 2, null, makeEv());
    assert.equal(Bo.canChallenge(w, "boss", 2).ok, false);
  });

  test("estimate = Σ min(DPS_est (1 + Boss%), cap) (1 + Lessons) 0.85 timer mech / (HP - Wounds)", () => {
    const w = makeWorld({ seed: 1, heroes: [{ cls: "refactorer", L: 45, mapId: "4-3" }, { cls: "hotfixer", L: 47, mapId: "4-3" }] });
    const st1 = H.stats(heroOf(w, 1), { herd: w.state.herd });
    const st2 = H.stats(heroOf(w, 2), { herd: w.state.herd });
    const hp = F.bossHP(D.BOSSES[3].bk, 45, 2);
    const want = (st1.dpsEst * (1 + st1.bossDmg) + st2.dpsEst * (1 + st2.bossDmg)) * 0.85 * 180 * 0.75 / hp;
    assert.ok(Math.abs(Bo.estimate(w, "boss", 3, [1, 2]) - want) < 1e-9);
    w.state.herd.lessons["3"] = 2;
    w.state.herd.wounds["3"] = [0.2, w.rt.nowMs + 1e6, 0];
    const want2 = want * 1.2 / 0.8;
    assert.ok(Math.abs(Bo.estimate(w, "boss", 3, [1, 2]) - want2) < 1e-9);
    // a helper is capped at refDPS(Lb + 3)
    const capped = Bo.estimate(w, "boss", 3, [1, 2], [2]);
    assert.ok(capped <= want2 + 1e-9);
  });

  test("participants: zone heroes by Power Level (max 6), then Answer-calls helpers who beat it with PL >= Lb", () => {
    const specs = [];
    for (let i = 0; i < 7; i++) specs.push({ cls: CLS5[i % 5], L: 40 + i, mapId: "4-3" });
    specs.push({ cls: "hotfixer", L: 60, mapId: "6-1", hero: { cd: { boss: { 3: 0 }, unblockedUntil: 0, unblockedCdUntil: 0 } } });
    const w = makeWorld({ heroes: specs });
    const p = Bo.participants(w, "boss", 3);
    assert.equal(p.heroIds.length, 6);
    const pls = p.heroIds.map((id) => H.stats(heroOf(w, id), { herd: w.state.herd }).pl);
    assert.deepEqual(pls, pls.slice().sort((a, b) => b - a));
    assert.deepEqual(p.helpers, []);
    const w2 = makeWorld({ heroes: [specs[0], specs[7]] });
    w2.state.herd.boss[3] = 1;
    heroOf(w2, 1).cd.boss = {};
    heroOf(w2, 2).st.wh = 4; // its own repeat cooldown (3 working hours) has passed
    const p2 = Bo.participants(w2, "boss", 3);
    assert.deepEqual(p2.heroIds, [1, 2]);
    assert.deepEqual(p2.helpers, [2]);
  });

  test("a helper's damage is capped at refDPS(Lb + 3) per tick", () => {
    const w = makeWorld({ seed: 2, heroes: [{ cls: "hotfixer", L: 34, mapId: "3-3" }, { cls: "hotfixer", L: 100, mapId: "9-3" }] });
    openDoor(w, 2);
    w.state.herd.boss[2] = 1;
    heroOf(w, 2).cd.boss = { 2: 0 };
    heroOf(w, 2).st.wh = 10;
    heroOf(w, 1).cd.boss = {};
    const ev = makeEv();
    const f = Bo.startFight(w, "boss", 2, null, ev);
    assert.deepEqual(f.helpers, [2]);
    f.parts[0].hp = f.parts[0].maxHp = f.pool = 1e12;
    const cap = F.refDPS(37);
    for (let t = 0; t < 30; t++) {
      const d = liveOf(w, 2).tally ? liveOf(w, 2).tally.dealt : 0;
      stepWorld(w, ev, 1);
      assert.ok(liveOf(w, 2).tally.dealt - d <= cap + 1, `tick ${t}`);
    }
  });
});

describe("determinism", () => {
  test("same seed, same fight: identical ticks, HP and hero RNG", () => {
    const run = (seed) => {
      const r = solo(6, "forkbinder", 78, seed);
      liveOf(r.w, 1).forklings = [{ status: "working" }];
      const res = finish(r.w, r.ev);
      return JSON.stringify([res, r.f.t, r.hero.rng, r.live.hp, r.f.dealt, r.w.state.herd.rng]);
    };
    assert.equal(run(31), run(31));
    assert.notEqual(run(31), run(32));
  });
});

describe("retreat and paused fights", () => {
  test("retreat ends the running fight as a Postmortem; a paused fight of another boss closes when a new one starts", () => {
    const { w, ev, f } = solo(4, "shellmancer", 56, 5);
    stepWorld(w, ev, 10);
    assert.deepEqual(Bo.retreat(w, ev), { ok: true, msg: "Postmortem" });
    assert.equal(f.result, "lost");
    assert.equal(w.rt.fights.length, 0);
    assert.equal(w.state.herd.fight, null);
    assert.equal(w.state.herd.lessons["4"], 1);
    assert.equal(Bo.retreat(w, ev).ok, false);
    // pause a Monolith fight, then start the Hydra: the Monolith becomes a Postmortem
    const g = Bo.startFight(w, "boss", 6, [1], ev);
    stepWorld(w, ev, 5);
    liveOf(w, 1).state = "resting";
    stepWorld(w, ev, 600);
    assert.equal(g.result, "suspended");
    assert.equal(w.state.herd.fight.i, 6);
    liveOf(w, 1).state = "questing";
    const h = Bo.startFight(w, "boss", 5, [1], ev);
    assert.equal(h.bossIdx, 5);
    assert.equal(w.state.herd.lessons["6"], 1);
    assert.equal(w.state.herd.fight.i, 5);
  });
});
