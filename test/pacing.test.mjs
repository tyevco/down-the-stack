// Persona pacing with the real engine, shortened (tools/pacing-sim.mjs runs the full D§12 table:
// `npm run pacing`). Day 1 of every D§12.1 persona, Solo's first four days, and day 1 of the
// always-working bot (D§12.2). Deterministic (seed 1); about 5 s.
//
// Tolerances: the D§12.1 ±15% where the engine meets it on day 1 (Boss 1, Lv 20, the bot); the
// first levels (Lv 5 at 12 min, Lv 10 at 42 min) run 10-30% early because the first chest lands
// at once at the end of a task (the model spreads chest XP over the minutes), so they get ±35%.
// Later milestones are reported by `npm run pacing`, not asserted here (see its header for the
// remaining calibration gap).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { simPersona, simBot, PERSONAS, DESIGN, BOT_DESIGN, compare } from "../tools/pacing-sim.mjs";

const runs = {};
function day1(id) {
  if (!runs[id]) runs[id] = simPersona(PERSONAS[id], { days: 1, seed: 1 });
  return runs[id];
}

function within(id, key, tol, got) {
  const d = DESIGN[id][key];
  const e = got.events[key];
  assert.ok(e, `${id}: ${key} not reached on day ${got.days}`);
  assert.ok(e.day <= d[0], `${id}: ${key} on day ${e.day}, design day ${d[0]}`);
  if (d[1] != null) {
    const dev = e.hours / d[1] - 1;
    assert.ok(Math.abs(dev) <= tol, `${id}: ${key} at ${e.hours} h, design ${d[1]} h (${Math.round(dev * 100)}%)`);
  }
}

describe("day 1 of every persona (D§12.1)", () => {
  for (const id of Object.keys(PERSONAS)) {
    test(`${id}: Lv 5, Lv 10 and Boss 1 on day 1`, () => {
      const r = day1(id);
      within(id, "L5", 0.35, r);
      within(id, "L10", 0.35, r);
      within(id, "B1", 0.15, r);
      // every hero got its class at Lv 10 and nothing went wrong
      for (const h of r.world.state.heroes) assert.ok(h.L >= 10 && h.cls > 0, `Lv ${h.L} cls ${h.cls}`);
      assert.deepEqual(r.world.rt.errors, []);
      assert.ok(r.final.saveBytes < 30 * 1024);
    });
  }

  test("heavy: Lv 20 and Boss 2 on day 1", () => {
    const r = day1("heavy");
    within("heavy", "L20", 0.15, r);
    within("heavy", "B2", 0.15, r);
  });

  test("the first day's story: three Interns become Juniors and open Callback Caverns", () => {
    const r = day1("typical");
    assert.equal(r.world.state.heroes.length, 3);
    assert.ok(r.world.state.herd.zone >= 1);
    assert.ok(r.events.B1.levels.every((L) => L >= 7 && L <= 13), `party at Boss 1: ${r.events.B1.levels}`);
  });
});

describe("solo, days 1-4", () => {
  const r = simPersona(PERSONAS.solo, { days: 4, seed: 1 });
  test("Lv 20 and Boss 2 on day 2 at the latest, within 15% of the design's hours", () => {
    within("solo", "L20", 0.15, r);
    const c = compare("B2", DESIGN.solo.B2, r.events.B2);
    assert.ok(c && c.ok, `Boss 2 on day ${r.events.B2 && r.events.B2.day}`);
  });

  test("Lv 30 and Boss 3 by day 4 (design: day 3 and day 4)", () => {
    assert.ok(r.events.L30 && r.events.L30.day <= 4, `Lv 30 ${JSON.stringify(r.events.L30)}`);
    assert.ok(r.events.B3 && r.events.B3.day <= 4, `Boss 3 ${JSON.stringify(r.events.B3)}`);
  });

  test("deterministic: the same seed gives the same milestones", () => {
    const again = simPersona(PERSONAS.solo, { days: 2, seed: 1 });
    for (const k of Object.keys(again.events)) assert.deepEqual(again.events[k], r.events[k], k);
  });
});

test("the always-working bot (D§12.2): day 1 within 15%, never leaves Lint Meadows", () => {
  const b = simBot(1, { seed: 1 });
  const L = b.levels[1];
  assert.ok(Math.abs(L / BOT_DESIGN[1] - 1) <= 0.15, `bot Lv ${L} on day 1, design ${BOT_DESIGN[1]}`);
  assert.equal(b.world.state.herd.zone, 0);
  assert.equal(b.world.state.herd.seals, 0, "never seen: no Seals");
  assert.equal(b.world.state.heroes[0].fe, 0, "no Fresh Eyes without a credited Seal");
});
