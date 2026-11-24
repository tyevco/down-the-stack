// Persona pacing with the real engine (D§12.1, D§12.2), shortened where it has to be: tools/
// pacing-sim.mjs runs the full table (`npm run pacing`, about 80 s) and the sustain sweep with real
// autopilot gear (`npm run pacing -- --sweep`). Deterministic (seed 1), about 40 s:
//   - day 1 of every persona: Lv 5, Lv 10 and Boss 1 within ±15% (D§12.1's exact model hours,
//     pacing-sim DESIGN);
//   - Typical and Casual to Lv 100 and Boss 9: every D§12.1 milestone within ±15% (days ±15% or
//     one day for bosses after day 1);
//   - Solo and Heavy to Boss 3: every milestone up to there;
//   - the always-working bot (D§12.2) on days 1 and 7;
//   - real autopilot gear (recorded during the Typical run) in the sustain sweep: 0 crashes, at
//     most 3 cups per on-level hour on every map x class, kill pace around the reference kit's.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  simPersona, simBot, PERSONAS, DESIGN, BOT_DESIGN, compare, gearRecorder, sweep, SWEEP_TARGET,
} from "../tools/pacing-sim.mjs";

const ORDER = ["L5", "L10", "B1", "L20", "B2", "L30", "B3", "B4", "L50", "B5", "L60", "B6", "B7", "B8", "L90", "B9", "L100"];

// every milestone of the persona up to `last` (inclusive): within ±15% (compare())
function assertMilestones(id, r, last) {
  const off = [];
  for (const k of ORDER) {
    const c = compare(k, DESIGN[id][k], r.events[k]);
    if (!c || !c.ok) off.push(`${k}: ${r.events[k] ? `day ${r.events[k].day} (${r.events[k].hours} h)` : "not reached"} vs ${JSON.stringify(DESIGN[id][k])}`);
    if (k === last) break;
  }
  assert.deepEqual(off, [], `${id}: milestones more than 15% off D§12.1`);
}

const runs = {};
function day1(id) {
  if (!runs[id]) runs[id] = simPersona(PERSONAS[id], { days: 1, seed: 1 });
  return runs[id];
}

describe("day 1 of every persona (D§12.1)", () => {
  for (const id of Object.keys(PERSONAS)) {
    test(`${id}: Lv 5, Lv 10 and Boss 1 on day 1, within 15%`, () => {
      const r = day1(id);
      assertMilestones(id, r, "B1");
      for (const k of ["L5", "L10", "B1"]) assert.equal(r.events[k].day, 1, k);
      // every hero got its class at Lv 10 and nothing went wrong
      for (const h of r.world.state.heroes) assert.ok(h.L >= 10 && h.cls > 0, `Lv ${h.L} cls ${h.cls}`);
      assert.deepEqual(r.world.rt.errors, []);
      assert.ok(r.final.saveBytes < 30 * 1024);
    });
  }

  test("the first day's story: three Interns become Juniors and open Callback Caverns", () => {
    const r = day1("typical");
    assert.equal(r.world.state.heroes.length, 3);
    assert.ok(r.world.state.herd.zone >= 1);
    assert.ok(r.events.B1.levels.every((L) => L >= 7 && L <= 13), `party at Boss 1: ${r.events.B1.levels}`);
  });
});

describe("whole games: Typical and Casual to Lv 100 and the Heisenbug (D§12.1)", () => {
  const rec = gearRecorder();
  const typical = simPersona(PERSONAS.typical, { seed: 1, until: ["B9", "L100"], onTick: rec.onTick });
  const casual = simPersona(PERSONAS.casual, { seed: 1, until: ["B9", "L100"] });

  test("Typical: every milestone within 15%", () => assertMilestones("typical", typical, "L100"));
  test("Casual: every milestone within 15%", () => assertMilestones("casual", casual, "L100"));

  test("deterministic: the same seed gives the same milestones", () => {
    const again = simPersona(PERSONAS.typical, { days: 2, seed: 1 });
    for (const k of Object.keys(again.events)) assert.deepEqual(again.events[k], typical.events[k], k);
  });

  test("real autopilot gear (Typical's): no crashes, at most 3 cups an hour, kill pace near the reference kit", () => {
    const rows = sweep({ kits: ["auto"], ticks: 3600, seed: 1, gear: rec.done() });
    const bad = rows.filter((r) => r.crashesH > 0 || r.cupsH > SWEEP_TARGET.cups);
    assert.deepEqual(bad.map((r) => `${r.mapId} ${r.cls}: ${r.crashesH} crashes ${r.cupsH} cups`), []);
    const [lo, hi] = SWEEP_TARGET.auto;
    const pace = rows.filter((r) => r.xkpm < lo || r.xkpm > hi);
    assert.deepEqual(pace.map((r) => `${r.mapId} ${r.cls}: ${r.xkpm.toFixed(1)}`), []);
    const mean = rows.reduce((a, r) => a + r.xkpm, 0) / rows.length;
    assert.ok(mean >= 14.5 && mean <= 17.5, `mean ${mean.toFixed(1)} kills/min (reference kit: ~16)`);
  });
});

describe("Solo and Heavy to Boss 3 (D§12.1)", () => {
  for (const id of ["solo", "heavy"]) {
    test(`${id}: every milestone up to Boss 3 within 15%`, () => {
      const r = simPersona(PERSONAS[id], { seed: 1, until: ["B3"] });
      assertMilestones(id, r, "B3");
      assert.deepEqual(r.world.rt.errors, []);
    });
  }
});

test("the always-working bot (D§12.2): days 1 and 7 within tolerance, never leaves Lint Meadows", () => {
  const b = simBot(7, { seed: 1 });
  for (const d of [1, 7]) {
    const L = b.levels[d];
    const D = BOT_DESIGN[d];
    assert.ok(Math.abs(L - D) <= Math.max(1, Math.round(D * 0.15)), `bot Lv ${L} on day ${d}, design ${D}`);
  }
  assert.equal(b.world.state.herd.zone, 0);
  assert.equal(b.world.state.herd.seals, 0, "never seen: no Seals");
  assert.equal(b.world.state.heroes[0].fe, 0, "no Fresh Eyes without a credited Seal");
});
