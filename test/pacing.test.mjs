// Persona pacing with the real engine (D§12.1, D§12.2), shortened where it has to be: tools/
// pacing-sim.mjs runs the full table (`npm run pacing`, about 80 s) and the sustain sweep with real
// autopilot gear (`npm run pacing -- --sweep`). Deterministic (seed 1), about 40 s:
//   - day 1 of every persona: Lv 5, Lv 10 and Boss 1 within ±15% (D§12.1's exact model hours,
//     pacing-sim DESIGN);
//   - Typical and Casual to Lv 100 and Boss 9: every D§12.1 milestone within ±15% (days ±15% or
//     one day for bosses after day 1);
//   - Solo and Heavy to Boss 3: every milestone up to there;
//   - the always-working bot (D§12.2) on days 1 and 7;
//   - real autopilot gear (recorded during the Typical run without the town, as harvestGear does) in
//     the sustain sweep: 0 crashes, at most 3 cups per on-level hour on every map x class, kill pace
//     around the reference kit's;
//   - Localhost (docs/TOWN.md §6.3): the town runs by default; without it (--no-town, TUNING.town.on
//     false) the engine is the build before the town (9cd00cd's milestones, save size, kills a minute
//     and bot, recorded below); the sweep and the bot are the same with and without it; the town's
//     share of XP is above 0 from day 2 and at most 3%, and its gates hold on seed 1.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import {
  simPersona, simBot, PERSONAS, DESIGN, BOT_DESIGN, compare, gearRecorder, sweep, SWEEP_TARGET, sweepCases, sweepCase,
  townGates, withTown, TOWN_GATES,
} from "../tools/pacing-sim.mjs";
import * as W from "../mods/down-the-stack/game/world.js";
import { TUNING as T } from "../mods/down-the-stack/game/data.js";

// The build before the town (9cd00cd, the last commit before Localhost), seed 1: the Typical
// persona's milestones [day, hours], final save size and levels; one sustain-sweep slice (reference
// kit, 900 ticks: [map, class, level, on-level kills a minute, cups an hour]); the bot's first week.
// Recorded with 9cd00cd's own tools/pacing-sim.mjs (scratch golden.mjs of town round 1).
const BEFORE_TOWN = {"typical": {"events": {"L5": [1, 0.17], "B1": [1, 0.57], "L10": [1, 0.6], "L20": [2, 2.45], "B2": [2, 2.73], "L30": [4, 7], "B3": [4, 7.97], "B4": [9, 17.27], "L50": [15, 28.26], "B5": [18, 35.14], "L60": [25, 49.08], "B6": [30, 59.5], "B7": [45, 89.35], "B8": [67, 132.01], "L90": [73, 144.17], "B9": [95, 187.99], "L100": [100, 198.48]}, "saveBytes": 14098, "days": 100, "levels": [100, 99, 99]}, "sweep": [["1-3", "intern", 9, 14.381216931216933, 0], ["1-3", "hotfixer", 10, 17.614722222222206, 0], ["1-3", "rubberducker", 10, 15.70013888888888, 0], ["3-2", "hotfixer", 28, 16.22738095238095, 0], ["3-2", "rubberducker", 28, 14.605151515151544, 0], ["6-1", "hotfixer", 58, 14.695987186954012, 0], ["6-1", "rubberducker", 58, 15.536227916909358, 0], ["backlog", "hotfixer", 100, 15.169046560528692, 0], ["backlog", "rubberducker", 100, 14.987458095524183, 0]], "bot": {"levels": {"1": 21, "2": 22, "3": 22, "4": 23, "5": 23, "6": 23, "7": 24}, "save": 5389}};

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
  // simulated in before() hooks, not while the file's tests are collected: a filtered run
  // (--test-name-pattern) skips them, and a throw is reported against this suite
  const rec = gearRecorder();
  let typical;
  let casual;
  let noTown;
  before(() => { typical = simPersona(PERSONAS.typical, { seed: 1, until: ["B9", "L100"] }); });
  before(() => { casual = simPersona(PERSONAS.casual, { seed: 1, until: ["B9", "L100"] }); });
  // the town's baseline and the sweep's gear (harvestGear harvests without the town)
  before(() => { noTown = simPersona(PERSONAS.typical, { seed: 1, until: ["B9", "L100"], onTick: rec.onTick, town: false }); });

  test("Typical: every milestone within 15%", () => assertMilestones("typical", typical, "L100"));
  test("Casual: every milestone within 15%", () => assertMilestones("casual", casual, "L100"));

  test("--no-town is the build before the town: 9cd00cd's milestones, save size and levels", () => {
    const events = {};
    for (const [k, v] of Object.entries(noTown.events)) events[k] = [v.day, v.hours];
    assert.deepEqual(events, BEFORE_TOWN.typical.events);
    assert.equal(noTown.final.saveBytes, BEFORE_TOWN.typical.saveBytes);
    assert.deepEqual(noTown.final.levels, BEFORE_TOWN.typical.levels);
    assert.equal(noTown.days, BEFORE_TOWN.typical.days);
    assert.equal(noTown.town, undefined, "no town tally without the town");
    assert.equal(T.town.on, true, "the switch is put back after the run");
    const text = W.serialize(noTown.world);
    assert.ok(!/"town"|"tw"/.test(text), "nothing of the town in its save");
  });

  test("Localhost in the Typical run: above 0 and at most 3% of all XP; its gates hold against --no-town", () => {
    const t = typical.town;
    assert.ok(t.share > 0 && t.share <= TOWN_GATES.share, `town share ${t.share}`);
    assert.ok(t.coverage > 0.9, `LGTM coverage ${t.coverage}`);
    assert.ok(t.rd >= 1 && t.rd <= 10);
    assert.ok(t.ranks.slice(1).some((n) => n > 0), "ranks rose");
    const g = townGates("typical", typical, noTown);
    assert.deepEqual([g.left, g.worse], [[], []], "no milestone leaves ±15% or gets further off");
    assert.ok(g.shift != null && g.shift >= TOWN_GATES.meanShift, `Lv 20-100 hours ${g.shift}`);
    assert.equal(g.bad, 0);
  });

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

describe("the town by day 2; the sweep and the bot never meet it (docs/TOWN.md §6.1.6, §6.3)", () => {
  test("day 1 is the same with and without the town; by day 2 the town's share of XP is above 0 and at most 3%", () => {
    const d1 = simPersona(PERSONAS.typical, { days: 1, seed: 1 });
    const d1n = simPersona(PERSONAS.typical, { days: 1, seed: 1, town: false });
    assert.deepEqual(d1.events, d1n.events, "the day-1 milestones never move");
    const d2 = simPersona(PERSONAS.typical, { days: 2, seed: 1 });
    assert.ok(d2.town.share > 0 && d2.town.share <= TOWN_GATES.share, `day 2 share ${d2.town.share}`);
    assert.ok(d2.town.lgtm > 0, "the night filled the shelf; the morning's chests took LGTMs");
  });

  test("the sweep: the same kills a minute with and without the town, and as before the town", () => {
    const cases = sweepCases({ maps: ["1-3", "3-2", "6-1", "backlog"], classes: ["hotfixer", "rubberducker"] });
    const run = (town) => withTown(town, () => cases.map((c) => sweepCase(Object.assign({}, c, { kit: "ref", ticks: 900, seed: 1 }))));
    const on = run(true);
    const off = run(false);
    assert.deepEqual(on, off);
    assert.deepEqual(on.map((r) => [r.mapId, r.cls, r.L, r.xkpm, r.cupsH]), BEFORE_TOWN.sweep);
  });

  test("the bot: byte for byte the same with and without the town, and as before the town", () => {
    const on = simBot(7, { seed: 1 });
    const off = simBot(7, { seed: 1, town: false });
    assert.deepEqual(on.levels, off.levels);
    const text = W.serialize(on.world);
    assert.equal(text, W.serialize(off.world), "the same save");
    assert.deepEqual(on.levels, BEFORE_TOWN.bot.levels);
    assert.equal(text.length, BEFORE_TOWN.bot.save);
    assert.equal(on.world.state.herd.town, undefined, "never seen: no Review Desk");
  });
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

test("the CLI: --json carries the verdicts and the same exit code as the text output; a bad argument exits 2", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const sim = fileURLToPath(new URL("../tools/pacing-sim.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [sim, ...args], { encoding: "utf8" });
  const j = run("--persona", "bot", "--quick", "--json", "--no-ref");
  assert.equal(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout);
  assert.equal(out.bad, 0);
  assert.deepEqual(out.bot.verdicts.map((v) => [v.day, v.verdict]), [[1, "ok"]]);
  // --no-town: the same bot; a persona's JSON carries the town and its gates only with the town
  const n = run("--persona", "bot", "--quick", "--json", "--no-ref", "--no-town");
  assert.equal(n.status, 0, n.stderr);
  assert.deepEqual(JSON.parse(n.stdout).bot.levels, out.bot.levels);
  const tp = JSON.parse(run("--persona", "casual", "--quick", "--json", "--no-ref").stdout);
  assert.ok(tp.personas.casual.town && tp.personas.casual.gates && tp.personas.casual.base);
  const np = JSON.parse(run("--persona", "casual", "--quick", "--json", "--no-ref", "--no-town").stdout);
  assert.deepEqual(Object.keys(np.personas.casual), ["events", "days", "ticks", "ms", "final", "bad", "verdicts"], "the output before the town");
  assert.deepEqual(np.personas.casual.events, tp.personas.casual.base.events);
  for (const bad of [["--persnoa", "bot"], ["--persona", "nobody"], ["--days", "x"], ["--seeds", "x"]]) {
    const r = run(...bad);
    assert.equal(r.status, 2, `${bad.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /usage: node tools\/pacing-sim\.mjs/);
  }
});
