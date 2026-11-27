#!/usr/bin/env node
// Persona pacing with the REAL engine (ARCHITECTURE §7.4, D§12): `npm run pacing`.
//
// Each persona of D§12.1 plays day after day through world.tick with scripted host snapshots
// (game/demo.js casts): its agents work their hours a day in tasks of the persona's length (each
// task: working, ~45 s done, then idle = seen), the app closes overnight (an offline gap: Fresh Eyes,
// Daily Shift reset) and every morning the world is reloaded from its own save, as herdr would. All
// autopilot defaults are on. Milestones (first hero to reach a level, the herd's first kill of each
// boss) are recorded with the day and the working hours per hero, and printed next to D§12.1 and
// tools/reference-sim/pacing4.py (run with python3 when available). The always-working bot of
// D§12.2 runs too (days 1, 7 and 30 by default; --long adds 90).
//
//   node tools/pacing-sim.mjs [--persona casual|solo|typical|heavy|bot|all] [--days N] [--long]
//                             [--quick] [--json] [--no-ref] [--seed N]
//
// --quick: day 1 only for every persona. Exit code 1 when a milestone is more than 15% off the
// design (D§12.1 hours, or days for bosses past day 1; pacing4.py's unrounded hours, see DESIGN),
// in --json mode too (its output carries each verdict and "bad"); 2 on an unknown argument.
//
//   node tools/pacing-sim.mjs --sweep [--seed N] [--json]
//   node tools/pacing-sim.mjs [--no-town] [--seeds 1-4] [--persona big]
//
// Localhost, the town (docs/TOWN.md §6.3, docs/BALANCE.md §14) is part of the engine, so it runs by
// default. Each persona then plays twice on the same seed, with the town and without it (the
// baseline, TUNING.town.on = false), and prints a "Localhost:" line (its share of all XP, LGTM
// coverage, the Review Desk, ranks, Uptime) with its gates; exit code 1 when a persona's town share
// passes 3% of its XP, a milestone within ±15% of D§12.1 without the town leaves it with the town (or
// one already off gets further off), or the mean of the Lv 20-100 milestones' hours moves more than
// 6% earlier than without the town. --no-town is the build before the town: TUNING.town.on = false,
// no baseline, no town lines (the same output as before the town apart from the wall-clock seconds).
// --seeds 1-4 (or 1,2,3,4) runs several seeds and ends with a summary table (BALANCE.md §14).
// --persona big: the owner model (docs/TOWN.md Appendix A: 32 agents in 25 spaces, herdr open
// overnight, 7 days; informational, left out of "all"): who is on duty by hour, coverage by day, the
// town share, the Review Desk and the save size with and without the town's fields; exit code 1
// when the town share passes 4% or the town's own save bytes 0.8 KB. The sweep and the bot never
// meet the town (no chest, no seen work: never on duty) and print the same with and without it; the
// sweep's real autopilot gear is harvested without the town, so it is the same gear either way.
//
// The sustain sweep (D§4.3, D§5.5, D§5.6): every real map x class at on-level for one working hour,
// with the complete D§5.2 reference kit (fullRefKit) and with real autopilot gear (the typical
// persona's, harvestGear / autoKit); kill pace in on-level kills a minute. Targets SWEEP_TARGET; exit
// code 1 when a case misses.
//
// Engine fixes this simulator found (integration pass): Interns stuck on map 1-1 with an iLvl-1
// Training Stick; autopilot's Item Power pre-filter keeping late heroes in outgrown Keepsakes;
// repeat boss kills worth 0.1 Need(L) whatever the boss level (now x gap); class-biased map choice
// by Power Level and guild convergence stalling the frontier for days.
//
// Balance pass (docs/BALANCE.md): every persona ran 25-35% ahead of D§12.1 after Lv 30 and the bot
// reached Lv 36 by day 30 (design 28): autopilot gear dealt 1.4-2x the reference kit, Fresh Eyes
// covered whole sessions once the Campfire was bought, boss and review XP added 10-25%, an
// out-levelled bot one-shot three mobs a tick. Drop item levels, affix ranges, autopilot polish,
// the Campfire's pace, boss XP and the gap floor were re-tuned, the mob XP multipliers re-fitted to
// the measured pace; all milestones now land within the ±15%.

import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import * as W from "../mods/down-the-stack/game/world.js";
import * as Dm from "../mods/down-the-stack/game/demo.js";
import * as I from "../mods/down-the-stack/game/items.js";
import * as AP from "../mods/down-the-stack/game/autopilot.js";
import { stats as heroStats, computeStats } from "../mods/down-the-stack/game/heroes.js";
import { mobXP, gap, refDPS, polishMax, itemTier, fmtNum } from "../mods/down-the-stack/game/formulas.js";
import { TUNING as T, BOSSES, MAPS, MAP_BY_ID, SLOTS, BACKLOG, AFFIXES, AFFIX_IDX, CLASSES, TOWN } from "../mods/down-the-stack/game/data.js";
import * as H from "../test/helpers/engine.mjs";
import * as TW from "../mods/down-the-stack/game/town.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60;
const HOUR = 3600;
const DAY_MS = 86400000;
// 2026-09-21 00:00 UTC (a Monday); sessions start at 09:00 local (tzOffsetMin 0)
const EPOCH = Date.UTC(2026, 8, 21);
const SESSION_START_H = 9;
const DONE_SEC = 45; // a task's "done" stretch before the person looks (then idle = seen)
const SEEN_SEC = 45; // idle after seeing the result, before the next task starts
// agent k starts k x LEAD task lengths into the session (D§12.1's model runs a herd's heroes in
// lockstep; 5% keeps their tasks from ending on the same tick without a 5-agent herd's first hero
// waiting a quarter hour for its last guild-mate to catch up, guild convergence, D§2.8)
const LEAD = 0.05;

/** D§12.1 personas. */
export const PERSONAS = {
  casual: { name: "Casual", agents: 1, hours: 1.5, taskMin: 8, days: 170 },
  solo: { name: "Solo", agents: 1, hours: 3, taskMin: 12, days: 95 },
  typical: { name: "Typical", agents: 3, hours: 2, taskMin: 10, days: 115 },
  heavy: { name: "Heavy", agents: 5, hours: 5, taskMin: 15, days: 56 },
};

const LEVELS = [5, 10, 20, 30, 50, 60, 90, 100];

/**
 * D§12.1 targets: [day, working hours per hero] (hours null where the table gives none). D§12.1
 * prints the hours of tools/reference-sim/pacing4.py rounded to 0.1 h (or whole minutes: "12 min"
 * is 0.2 h); these are its unrounded values, so a 0.05 h rounding does not eat a third of the
 * ±15% on the first milestones (typical Lv 5 is 11 min, not 12; Boss 1 for three or five agents
 * 34 and 33 min, not "36 min"). Days are D§12.1's.
 */
export const DESIGN = {
  casual: { L5: [1, 0.2], L10: [1, 0.733], B1: [1, 1.017], L20: [2, 2.8], B2: [3], L30: [6, 7.883], B3: [7], B4: [14], L50: [21, 30.983], B5: [25], L60: [35, 51.767], B6: [42], B7: [67], B8: [100], L90: [116, 172.55], B9: [146], L100: [161, 240.917] },
  solo: { L5: [1, 0.2], L10: [1, 0.733], B1: [1, 1.017], L20: [2, 3.133], B2: [2], L30: [3, 8.783], B3: [4], B4: [8], L50: [12, 35.817], B5: [15], L60: [20, 59.533], B6: [24], B7: [38], B8: [55], L90: [62, 184.717], B9: [77], L100: [85, 252.667] },
  typical: { L5: [1, 0.183], L10: [1, 0.667], B1: [1, 0.567], L20: [2, 2.667], B2: [2], L30: [4, 7.583], B3: [5], B4: [10], L50: [16, 30.133], B5: [18], L60: [25, 49.15], B6: [29], B7: [46], B8: [67], L90: [77, 153.6], B9: [98], L100: [108, 214.883] },
  heavy: { L5: [1, 0.183], L10: [1, 0.633], B1: [1, 0.553], L20: [1, 2.767], B2: [1], L30: [2, 8.267], B3: [2], B4: [5], L50: [7, 34.817], B5: [9], L60: [12, 57.217], B6: [14], B7: [22], B8: [33], L90: [38, 186.05], B9: [48], L100: [52, 258.783] },
};

/** D§12.2: the always-working bot's level by day. */
export const BOT_DESIGN = { 1: 19, 7: 23, 30: 28, 90: 33, 365: 42 };

const TOL = 0.15;
const TOWN_RANKS = TOWN.ranks.map((r) => r.name);

// ---------------------------------------------------------------------------------------------
// One persona
// ---------------------------------------------------------------------------------------------

// The day's plan for agent k: idle until its start, then tasks until the day's working minutes are
// done (the last task is shorter), then idle for the rest of the session.
function dayPlan(p, k) {
  const plan = [];
  const lead = Math.round(k * LEAD * p.taskMin * MIN); // agents of a herd do not start in lockstep
  if (lead > 0) plan.push(["idle", lead]);
  let left = Math.round(p.hours * HOUR);
  while (left > 0) {
    const w = Math.min(left, p.taskMin * MIN);
    left -= w;
    plan.push(["working", w], ["done", DONE_SEC], ["idle", SEEN_SEC]);
  }
  plan.push(["idle", Infinity]);
  return plan;
}

function sessionSec(p, k) {
  const tasks = Math.ceil((p.hours * HOUR) / (p.taskMin * MIN));
  return Math.round(k * LEAD * p.taskMin * MIN) + Math.round(p.hours * HOUR) + tasks * (DONE_SEC + SEEN_SEC);
}

function castFor(p, day, seqs) {
  const agents = [];
  for (let k = 0; k < p.agents; k++) {
    agents.push(Dm.makeAgent({
      address: `t${k + 1}`, program: "claude", space: "spc_1", spaceName: "herdr-app", tab: "tab_1", tabIndex: 0,
      tabName: "main", pane: `p_t${k + 1}`, plan: dayPlan(p, k), loop: false, seq: seqs[k] || 1, titleIdx: day * 7 + k,
    }));
  }
  return Dm.makeCast(agents);
}

/**
 * Runs fn with TUNING.town.on set to `town` (true / false; null or undefined: as it is), restoring
 * it afterwards (the town reads it at call time, docs/TOWN.md §6.3 --no-town).
 */
export function withTown(town, fn) {
  const prev = T.town.on;
  if (town != null) T.town.on = !!town;
  try {
    return fn();
  } finally {
    T.town.on = prev;
  }
}

/**
 * The town's numbers over a run (docs/TOWN.md §6.2): XP by source from the engine's own tallies
 * (live.tally: kills, chests, bosses, reviews and the LGTM bonus), chests opened with full value while
 * the Review Desk was open (herd.town.t[2] by day). tick(world) after every world.tick; done(world)
 * -> {share, xp, chests, lgtm, coverage, rd, rdGold, ranks, uptime, jobXp}.
 */
export function townTracker() {
  const last = new WeakMap();
  const xp = { kill: 0, chest: 0, boss: 0, review: 0, lgtm: 0 };
  let chests = 0;
  let prevT2 = 0;
  return {
    xp,
    tick(w) {
      for (const live of w.rt.live.values()) {
        const t = live.tally;
        if (!t) continue;
        const cur = [t.xp || 0, t.chestXp || 0, t.bossXp || 0, t.reviewXp || 0, t.lgtmXp || 0];
        const l = last.get(live) || [0, 0, 0, 0, 0];
        xp.kill += cur[0] - l[0];
        xp.chest += cur[1] - l[1];
        xp.boss += cur[2] - l[2];
        xp.review += cur[3] - l[3];
        xp.lgtm += cur[4] - l[4];
        last.set(live, cur);
      }
      const town = w.state.herd.town;
      const t2 = town && Array.isArray(town.t) ? town.t[2] || 0 : 0;
      chests += t2 >= prevT2 ? t2 - prevT2 : t2; // the 04:00 turn starts the day's count afresh
      prevT2 = t2;
    },
    done(w) {
      const all = xp.kill + xp.chest + xp.boss + xp.review + xp.lgtm;
      const town = w.state.herd.town;
      const lgtm = town && Array.isArray(town.u) ? town.u[0] || 0 : 0;
      const rd = TW.deskLevel(w.state);
      let rdGold = 0;
      for (let n = 1; n <= rd; n++) rdGold += TW.deskCost(n);
      const ranks = [0, 0, 0, 0, 0];
      for (const h of w.state.heroes) if (h.L >= T.town.minLevel) ranks[TW.rankOf(TW.jobXpOf(h))]++;
      return {
        share: all > 0 ? xp.lgtm / all : 0, xp: Object.assign({}, xp), chests, lgtm, coverage: chests > 0 ? lgtm / chests : 0, rd, rdGold, ranks,
        uptime: TW.uptime(w.state).label, jobXp: w.state.heroes.map((h) => Math.floor(TW.jobXpOf(h))),
      };
    },
  };
}

/**
 * Plays a persona with the real engine. Returns {events: {L5: {day, hours}, B1: {...}, ...},
 * days, ticks, ms, final: {levels, zone, ...}, town?}. town (when the town ran): townTracker's summary.
 * @param {object} p a PERSONAS entry (or {agents, hours, taskMin})
 * @param {{days?:number, seed?:number, reload?:boolean, until?:string[], log?:Function,
 *          onTick?:Function, town?:boolean}} [opts] log(day, world, events) after each day;
 *          onTick(world, snap, res); town: TUNING.town.on for this run (default: as it is)
 */
export function simPersona(p, opts = {}) {
  return withTown(opts.town, () => playPersona(p, opts));
}

function playPersona(p, opts) {
  const days = opts.days || p.days;
  const reload = opts.reload !== false;
  const until = opts.until || null;
  const t0 = performance.now();
  let world = W.createWorld({ nowMs: EPOCH + SESSION_START_H * HOUR * 1000 - 60000, seed: opts.seed || 1 });
  const tw = T.town.on !== false ? townTracker() : null;
  const events = {};
  const seqs = [];
  let ticks = 0;
  // Level milestones: the first hero to reach the level, with its own working hours; boss kills:
  // the herd's mean working hours per hero (D§12.1 "working hours per hero").
  const note = (key, day, hero) => {
    if (events[key]) return;
    const heroes = world.state.heroes;
    const wh = hero ? hero.st.wh || 0 : heroes.length ? heroes.reduce((s, h) => s + (h.st.wh || 0), 0) / heroes.length : 0;
    events[key] = { day, hours: Math.round(wh * 100) / 100, levels: heroes.map((h) => h.L) };
  };
  const check = (day) => {
    let top = null;
    for (const h of world.state.heroes) if (!top || h.L > top.L || (h.L === top.L && h.st.wh < top.st.wh)) top = h;
    if (top) for (const L of LEVELS) if (top.L >= L) note(`L${L}`, day, top);
    const boss = world.state.herd.boss;
    for (let i = 0; i < BOSSES.length; i++) if (boss[i] > 0) note(`B${i + 1}`, day, null);
  };
  let day = 1;
  for (; day <= days; day++) {
    const start = EPOCH + (day - 1) * DAY_MS + SESSION_START_H * HOUR * 1000;
    if (day > 1 && reload) {
      // the app was closed overnight: herdr reloads the mod, which loads its own save
      world = W.loadWorld(W.serialize(world), { nowMs: start }).world;
    }
    const cast = castFor(p, day, seqs);
    let end = start;
    for (let k = 0; k < p.agents; k++) end = Math.max(end, start + (sessionSec(p, k) + 120) * 1000);
    // the first snapshot of the day (after the night: an offline gap)
    W.tick(world, Dm.castSnapshot(cast, start));
    let now = start;
    while (now < end) {
      const to = Math.min(end, now + 5 * MIN * 1000);
      now = Dm.runCast(world, cast, to, { onTick: (w, s, r) => { ticks += r.ticks; if (tw) tw.tick(w); if (opts.onTick) opts.onTick(w, s, r); check(day); } });
    }
    cast.agents.forEach((a, k) => { seqs[k] = a.seq + 1; });
    if (world.rt.errors.length) throw new Error(`engine errors on day ${day}: ${world.rt.errors.join("; ")}`);
    if (opts.log) opts.log(day, world, events);
    if (until && until.every((k) => events[k])) break;
  }
  const heroes = world.state.heroes;
  const res = {
    events, days: Math.min(day, days), ticks, ms: Math.round(performance.now() - t0),
    final: {
      levels: heroes.map((h) => h.L), classes: heroes.map((h) => h.cls), zone: world.state.herd.zone, rel: world.state.herd.rel,
      gold: world.state.herd.gold, wh: heroes.map((h) => Math.round(h.st.wh * 10) / 10), bld: world.state.herd.bld.slice(),
      saveBytes: W.serialize(world).length,
    },
    world,
  };
  if (tw) res.town = tw.done(world);
  return res;
}

// ---------------------------------------------------------------------------------------------
// The always-working bot (D§12.2)
// ---------------------------------------------------------------------------------------------

/**
 * One agent that never stops working and is never looked at, for `days` days (the app stays
 * open). Returns {levels: {[day]: L}, ms}.
 */
export function simBot(days, opts = {}) {
  return withTown(opts.town, () => playBot(days, opts));
}

function playBot(days, opts) {
  const t0 = performance.now();
  const start = EPOCH + SESSION_START_H * HOUR * 1000;
  const world = W.createWorld({ nowMs: start - 1000, seed: opts.seed || 1 });
  const cast = Dm.makeCast([{ address: "bot", program: "claude", plan: [["working", Infinity]] }]);
  const levels = {};
  for (let d = 1; d <= days; d++) {
    Dm.runCast(world, cast, start + d * DAY_MS);
    levels[d] = world.state.heroes[0].L;
    if (opts.log) opts.log(d, world);
  }
  if (world.rt.errors.length) throw new Error(`bot: engine errors: ${world.rt.errors.join("; ")}`);
  return { levels, ms: Math.round(performance.now() - t0), world };
}

// ---------------------------------------------------------------------------------------------
// Sustain sweep (D§4.3, D§5.5, D§5.6): every real map x every class at on-level
// ---------------------------------------------------------------------------------------------

export const SWEEP_CLASSES = ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"];

/**
 * The sweep's cases: every map at its mid level (L = map mid) for the five classes (maps whose mid
 * is under Lv 10 for the Intern instead; map 1-3 for both: the Intern at Lv 9), plus the Backlog at
 * Lv 100 on the floor autopilot picks for the hero's Power Level (floor 0; D§9.8) or on `floors`.
 * With opts.classes / opts.maps the list is filtered.
 * @returns {Array<{mapId:string, L:number, cls:string, floor:number}>}
 */
export function sweepCases(opts = {}) {
  const out = [];
  const classes = opts.classes || SWEEP_CLASSES;
  for (const m of MAPS) {
    if (opts.maps && !opts.maps.includes(m.id)) continue;
    if (m.mid < 10 || m.id === "1-3") out.push({ mapId: m.id, L: Math.min(9, m.mid), cls: "intern", floor: 0 });
    if (m.mid >= 10) for (const cls of classes) out.push({ mapId: m.id, L: m.mid, cls, floor: 0 });
  }
  if (!opts.maps || opts.maps.includes("backlog")) {
    for (const f of opts.floors || [0]) for (const cls of classes) out.push({ mapId: "backlog", L: 100, cls, floor: f });
  }
  return out;
}

/**
 * The D§5.2 reference kit, complete: test/helpers/engine.mjs refKit (every slot at iRef(L) with
 * rarity x polish = R_ref x P_ref) with the reference damage (D_ref = 0.003 L), max HP (0.003 L),
 * armor (0.002 L) and crit (0.0005 L) spread over Memoized / Robust / Typed / Linted affixes of
 * several slots (a Sticker included): since the affix ranges were halved (docs/BALANCE.md) one
 * affix can no longer carry a whole reference bonus. A fixture: rolls may be fractional.
 */
export function fullRefKit(state, hero) {
  H.refKit(state, hero);
  const L = hero.L;
  const eq = hero.eq;
  const R = T.ref;
  if (!eq[5] && eq[1]) {
    eq[5] = { uid: state.herd.nextUid++, base: I.baseIdFor("sticker", itemTier(eq[1].ilvl), "sticker"), ilvl: eq[1].ilvl, rar: eq[1].rar, pol: 0, aff: [], flags: 0, prop: -1 };
  }
  // tops an affix up to `want` in total over the given slots (one per item, never twice on one)
  const topUp = (id, want, slots) => {
    const k = AFFIX_IDX[id];
    const a = AFFIXES[k];
    let left = want;
    for (const s of slots) {
      const it = eq[s];
      if (!it || !a.slots.includes(SLOTS[s])) continue;
      const t = itemTier(it.ilvl);
      const j = it.aff.findIndex((x) => x[0] === k);
      if (j >= 0) { left -= I.affixValue(k, it.aff[j][1], t); continue; }
      if (left <= 1e-9) continue;
      const lo = a.lo * t;
      const hi = a.hi * t;
      const v = Math.min(hi, left);
      it.aff = it.aff.concat([[k, ((v - lo) / (hi - lo)) * 99]]); // a fixture: the roll may fall under 0
      left -= v;
    }
  };
  topUp("memo", R.dmgPerL * L, [0, 3, 1, 5]);
  topUp("robust", R.hpPerL * L, [2, 1, 3, 5]);
  topUp("typed", R.armorPerL * L, [4, 1, 2, 3]);
  topUp("lint", R.critPerL * L, [1, 0, 5]);
  return eq;
}

/** The deepest real map an on-level hero of level L farms (autopilot: mid <= L + 1). */
function mapForLevel(L) {
  let m = MAPS[0];
  for (const x of MAPS) if (x.mid <= L + 1) m = x;
  return m;
}

/**
 * Records real autopilot gear during a persona run: pass rec.onTick as simPersona's onTick (or call
 * it from yours), then rec.done() prices every record against the complete reference kit of the
 * same hero (fullRefKit) and returns [{L, cls, eq, dps, ehp}] (each hero's equipment when it first
 * reached a level; dps / ehp over the reference kit).
 */
export function gearRecorder() {
  const out = [];
  const seen = new Set();
  return {
    onTick(w) {
      for (const h of w.state.heroes) {
        const k = `${h.id}:${h.L}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ L: h.L, cls: h.cls, sp: h.sp.slice(), rev: (h.rev || [0, 0]).slice(), eq: JSON.parse(JSON.stringify(h.eq)) });
      }
    },
    done() {
      for (const g of out) {
        if (g.dps != null) continue;
        const w = H.makeWorld({ heroes: [{ cls: g.cls, L: g.L, kit: "none", ranks: g.sp, rev: g.rev }] });
        const hero = w.state.heroes[0];
        const ctx = { herd: w.state.herd };
        hero.eq = g.eq.map((it) => it && Object.assign({}, it, { aff: it.aff.map((a) => a.slice()) }));
        const real = computeStats(hero, ctx);
        fullRefKit(w.state, hero);
        const ref = computeStats(hero, ctx);
        g.dps = real.dpsEst / ref.dpsEst;
        g.ehp = real.ehp / ref.ehp;
      }
      return out;
    },
  };
}

/**
 * Real autopilot gear by level (gearRecorder) from one persona (default: typical, three agents
 * sharing one stash, the D§12.1 "typical user") played to Lv 100 with every autopilot default on,
 * without the town (docs/TOWN.md §6.3: the sweep prints the same with and without it; the town
 * changes when drops are rolled, not the gear's rules). Cached per persona; about 20 s in V8.
 * @returns {Array<{L:number, eq:Array, dps:number, ehp:number}>}
 */
const GEAR = new Map();
export function harvestGear(id = "typical") {
  if (GEAR.has(id)) return GEAR.get(id);
  const rec = gearRecorder();
  simPersona(PERSONAS[id], { seed: 1, until: ["L100"], onTick: rec.onTick, town: false });
  const out = rec.done();
  GEAR.set(id, out);
  return out;
}

/**
 * "Autopilot-like" gear for a hero (the sweep's second kit): of the gear real autopilot heroes wore
 * within 2 levels of this hero's level (harvestGear), the kit with the median DPS over the
 * reference kit, the weapon re-based to the hero's class weapon type at the same tier (the rest of
 * a kit fits every class). Real loot spreads 0.5-2x the reference kit; the median is the
 * "autopilot hero" of D§5.2.
 */
export function autoKit(world, hero, { persona = "typical", gear = null } = {}) {
  const all = gear || harvestGear(persona);
  let pool = [];
  for (let d = 2; d <= 10 && !pool.length; d += 2) pool = all.filter((g) => Math.abs(g.L - hero.L) <= d && (hero.L >= 10) === (g.L >= 10));
  pool.sort((a, b) => a.dps - b.dps);
  const pick = pool[(pool.length - 1) >> 1];
  const eq = (pick ? pick.eq : []).map((it) => (it ? Object.assign({}, it, { uid: world.state.herd.nextUid++, aff: it.aff.map((a) => a.slice()), flags: it.flags & ~2 }) : null));
  while (eq.length < SLOTS.length) eq.push(null);
  const w = eq[0];
  if (w && w.base !== 0 && hero.cls > 0) {
    const b = I.baseOf(w);
    w.base = I.baseIdFor("weapon", b.tier || itemTier(w.ilvl), CLASSES[hero.cls].weapon);
  }
  if (hero.cls === 0) eq[0] = { uid: world.state.herd.nextUid++, base: 0, ilvl: Math.max(1, hero.L - 2), rar: 0, pol: 0, aff: [], flags: 4, prop: -1 };
  hero.eq = eq;
  return eq;
}

/**
 * One sweep case: a lone hero of class `cls` at level L (ranks by auto-learn, reviews passed) in
 * map `mapId` (Backlog floor `floor`), farming for `ticks` with its level and map pinned. The herd
 * holds the trophies of the zones before this one; no buildings, no Fresh Eyes, no party.
 * kit "ref" (D§5.2 reference kit) or "auto" (autoKit).
 * @returns {{mapId, cls, L, floor, kit, kpm, xkpm, cupsH, crashesH, minHpFrac, dps}}
 *   kpm kills per minute; xkpm on-level kill equivalents per minute (kill XP / (mobXP(mid) x gap));
 *   cupsH / crashesH per working hour.
 */
export function sweepCase({ mapId, L, cls, floor = 0, kit = "ref", ticks = 3600, seed = 1, gear = null }) {
  const map = MAP_BY_ID[mapId];
  const zone = map ? map.zone : BOSSES.length;
  const boss = BOSSES.map((_, i) => (i < zone ? 1 : 0));
  const w = H.makeWorld({ seed, herd: { boss, bossKills: boss.slice(), zone }, heroes: [{ cls, L, mapId, kit: "none" }] });
  const hero = w.state.heroes[0];
  const live = w.rt.live.get(hero.id);
  // the kit under test stays on: drops go to the stash, nothing is auto-equipped
  w.state.herd.cfg.auto.equip = false;
  if (mapId === "backlog") {
    w.state.herd.backlog = { floor: floor > 0 ? floor : 999, kills: 0 };
  }
  if (kit === "ref") fullRefKit(w.state, hero);
  else autoKit(w, hero, { gear });
  if (mapId === "backlog") {
    // on-level: the deepest floor whose effective level is <= PL + 1 (autopilot.backlogFloor)
    if (!(floor > 0)) floor = AP.backlogFloor(w, hero);
    w.state.herd.backlog.floor = floor;
    live.floor = floor;
  }
  const st0 = heroStats(hero, { herd: w.state.herd });
  live.maxHp = st0.maxHp;
  live.hp = st0.maxHp;
  let minHp = 1;
  for (let t = 0; t < ticks; t++) {
    H.stepWorld(w, null, 1);
    hero.xp = 0;
    if (live.mapId !== mapId) { live.mapId = mapId; live.dropMap = null; }
    if (live.maxHp > 0 && !(live.crashedUntil > 0)) minHp = Math.min(minHp, live.hp / live.maxHp);
  }
  const tl = live.tally;
  const min = ticks / 60;
  const mid = map ? map.mid : BACKLOG.level;
  const xpPct = live._act ? live._act.xpPct : 0;
  const unit = mobXP(mid) * (mapId === "backlog" ? 1 : gap(L - mid)) * (1 + xpPct);
  return {
    mapId, cls, L, floor, kit, kpm: tl.kills / min, xkpm: tl.xp / unit / min,
    cupsH: (tl.cups * 3600) / ticks, crashesH: (tl.crashes * 3600) / ticks, minHpFrac: minHp,
    dps: heroStats(hero, { herd: w.state.herd }).dpsEst / refDPS(L),
  };
}

/**
 * Runs sweepCase over sweepCases(opts) for each kit in opts.kits (default ["ref", "auto"]);
 * opts.gear: recorded gear for the "auto" kit (gearRecorder), else harvestGear("typical").
 */
export function sweep(opts = {}) {
  const rows = [];
  for (const kit of opts.kits || ["ref", "auto"]) {
    for (const c of sweepCases(opts)) rows.push(sweepCase(Object.assign({}, c, { kit, ticks: opts.ticks || 3600, seed: opts.seed || 1, gear: opts.gear || null })));
  }
  return rows;
}

/** Sweep targets (D§4.3, D§5.5, D§5.6): per on-level hour 0 crashes, <= 3 cups; kills/min as below. */
// With real autopilot gear the kill pace follows the gear's own swings (0.5-2x the reference kit:
// a Keepsake or LTS weapon, a stretch without a class weapon), so its band is wider; its mean is
// the reference kit's.
export const SWEEP_TARGET = { crashes: 0, cups: 3, ref: [14, 19], auto: [10, 25] };

/** The rows of a sweep that miss SWEEP_TARGET (kill pace by kit). */
export function sweepMisses(rows) {
  return rows.filter((r) => {
    const [lo, hi] = SWEEP_TARGET[r.kit] || SWEEP_TARGET.ref;
    return r.crashesH > SWEEP_TARGET.crashes || r.cupsH > SWEEP_TARGET.cups || r.xkpm < lo || r.xkpm > hi;
  });
}

function printSweep(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.kit.padEnd(4)} ${r.mapId === "backlog" ? `BL f${r.floor}` : r.mapId.padEnd(5)} Lv ${String(r.L).padStart(3)}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  console.log("\n== Sustain sweep: one on-level working hour per map x class (kills/min in on-level kills · cups/h · crashes/h)");
  for (const [k, rs] of by) {
    console.log(`${k}  ${rs.map((r) => `${r.cls.slice(0, 4)} ${r.xkpm.toFixed(1).padStart(4)} c${String(Math.round(r.cupsH)).padStart(2)} x${Math.round(r.crashesH)}`).join(" | ")}`);
  }
  for (const kit of [...new Set(rows.map((r) => r.kit))]) {
    const rs = rows.filter((r) => r.kit === kit);
    const mean = rs.reduce((a, r) => a + r.xkpm, 0) / rs.length;
    const miss = sweepMisses(rs);
    const [lo, hi] = SWEEP_TARGET[kit] || SWEEP_TARGET.ref;
    console.log(`${kit}: ${rs.length} cases, mean ${mean.toFixed(1)} kills/min, ${rs.filter((r) => r.crashesH > 0).length} with crashes, ${rs.filter((r) => r.cupsH > 3).length} over 3 cups/h, ${miss.length} off target (kills ${lo}-${hi})`);
  }
}

// ---------------------------------------------------------------------------------------------
// The owner model (docs/TOWN.md Appendix A): --persona big
// ---------------------------------------------------------------------------------------------

/** The owner's 25 spaces and how many agents work in each (32 in all; screenshots 1 and 4). */
export const OWNER_SPACES = [
  ["ceo-assistant-res-2", 1], ["ceo-assistant-writer", 1], ["ceo-assistant-lead", 2], ["pr-review-eng-1", 1],
  ["pr-review-eng-2", 1], ["pr-review-qa", 1], ["pr-review-lead", 1], ["rnd-qa", 2], ["rnd-eng-1", 1], ["rnd-eng-2", 1],
  ["rnd-lead", 1], ["mobile-qa", 1], ["mobile-eng", 2], ["mobile-lead", 1], ["docs", 2], ["infra", 2], ["ref-client", 1],
  ["gks", 1], ["claude-extended", 1], ["qa", 1], ["quiet-front", 1], ["ai-apps-vp", 1], ["ai-platform-vp", 1],
  ["hitch-ops", 2], ["herdr-teams", 2],
];

/**
 * The owner's herd (docs/TOWN.md Appendix A): 32 Claude agents in 25 spaces, herdr open for `days`
 * days from 04:00 of day 1. Each agent starts between 08:00 and 09:30 and stops between 19:00 and
 * 21:00 (the last `owls` work until about 02:00) in 15-45-minute tasks (owls up to 90 after 20:00),
 * half with a 1-6-minute block; a done stretch of 3-30 minutes by day and 30-240 at night before the
 * result is seen, then 1-8 minutes idle. The plans come from a fixed xorshift (seed 12345), so the
 * run is deterministic. Returns {world, town (townTracker's summary), hourly (the last day: average
 * heroes fighting / waiting / shipped / on duty / at the campfire and the shelf, by hour), days
 * (coverage by game day: [{day, lgtm, chests, rd}]), ms}.
 */
export function simOwner(days = 7, opts = {}) {
  return withTown(opts.town, () => playOwner(days, opts.owls ?? 6));
}

function playOwner(DAYS, OWLS) {
  const t0 = performance.now();
  let seed = 12345;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const between = (a, b) => a + (b - a) * rnd();
  const planFor = (owl) => {
    const plan = [];
    let t = 0;
    const push = (st, sec) => { sec = Math.max(1, Math.round(sec)); plan.push([st, sec]); t += sec; };
    for (let d = 0; d < DAYS; d++) {
      const dayStart = d * 86400;
      const on = dayStart + 8 * HOUR + between(0, 90 * MIN);
      const off = dayStart + (owl ? 26 * HOUR : 19 * HOUR + between(0, 120 * MIN));
      if (on > t) push("idle", on - t);
      while (t < off) {
        const work = between(15, owl && t > dayStart + 20 * HOUR ? 90 : 45) * MIN;
        if (rnd() < 0.5) { push("working", work / 2); push("blocked", between(1, 6) * MIN); push("working", work / 2); } else push("working", work);
        const night = t > dayStart + 20 * HOUR;
        push("done", night ? between(30, 240) * MIN : between(3, 30) * MIN);
        push("idle", between(1, 8) * MIN);
      }
    }
    plan.push(["idle", Infinity]);
    return plan;
  };
  const agents = [];
  let k = 0;
  for (const [name, n] of OWNER_SPACES) {
    for (let j = 0; j < n; j++) {
      k++;
      agents.push(Dm.makeAgent({
        address: `t${k}`, program: "claude", space: `spc_${name}`, spaceName: name, tab: `tab_${k}`, tabIndex: j,
        tabName: name, pane: `p_t${k}`, plan: planFor(k > 32 - OWLS), loop: false, titleIdx: k * 3,
      }));
    }
  }
  const cast = Dm.makeCast(agents);
  const start = EPOCH + 4 * HOUR * 1000; // 04:00 of day 1 (the game day turns)
  const world = W.createWorld({ nowMs: start - 1000, seed: 7 });
  Dm.advanceCast(cast, 4 * HOUR);
  const tw = T.town.on !== false ? townTracker() : null;
  const hourly = [];
  for (let h = 0; h < 24; h++) hourly.push({ hour: h, n: 0, fighting: 0, waiting: 0, shipped: 0, onDuty: 0, campfire: 0, shelf: 0, cap: 0 });
  const daysOut = [];
  let prev = null;
  const lastDay = EPOCH + (DAYS - 1) * DAY_MS;
  Dm.runCast(world, cast, start + DAYS * DAY_MS - 4 * HOUR * 1000, {
    onTick(w, snap, r) {
      if (tw) tw.tick(w);
      const town = w.state.herd.town;
      const tt = town && Array.isArray(town.t) ? town.t : [0, 0, 0];
      const day = w.state.herd.day;
      if (prev && day !== prev.day) daysOut.push({ day: daysOut.length + 1, lgtm: prev.lgtm, chests: prev.chests, rd: prev.rd });
      prev = { day, lgtm: tt[0] || 0, chests: tt[2] || 0, rd: TW.deskLevel(w.state) };
      if (snap.nowMs < lastDay) return;
      const b = hourly[Math.floor((snap.nowMs - lastDay) / (HOUR * 1000)) % 24];
      const n = r.ticks || 1;
      b.n += n;
      b.shelf += n * TW.shelfOf(w.state);
      b.cap += n * TW.shelfCap(w.state);
      for (const h of w.state.heroes) {
        const live = w.rt.live.get(h.id);
        const st = live ? live.state : "off";
        if (st === "questing" || st === "crashed" || st === "supervising") b.fighting += n;
        else if (st === "waiting") b.waiting += n;
        else {
          if (st === "shipped") b.shipped += n;
          if (TW.onDuty(w, h, live || null)) b.onDuty += n;
          else b.campfire += n;
        }
      }
    },
  });
  if (prev) daysOut.push({ day: daysOut.length + 1, lgtm: prev.lgtm, chests: prev.chests, rd: prev.rd, partial: true });
  for (const b of hourly) for (const key of ["fighting", "waiting", "shipped", "onDuty", "campfire", "shelf", "cap"]) b[key] = b.n ? Math.round((10 * b[key]) / b.n) / 10 : 0;
  if (world.rt.errors.length) throw new Error(`owner model: engine errors: ${world.rt.errors.join("; ")}`);
  return { world, town: tw ? tw.done(world) : null, hourly, days: daysOut, ms: Math.round(performance.now() - t0), saves: townSaveBytes(world) };
}

/**
 * The save with and without the town's own fields (docs/TOWN.md §8: herd.town with its day and the
 * Digest's baseline, every hero's st.tw, a Hall of Fame entry's rank): {bytes, without, town} in
 * UTF-8 bytes, both written from the same loaded copy of the world.
 */
export function townSaveBytes(world) {
  const text = W.serialize(world);
  const a = W.loadWorld(text, { nowMs: world.rt.nowMs }).world;
  const withTown = W.serialize(a);
  delete a.state.herd.town;
  for (const h of a.state.heroes) if (h.st) delete h.st.tw;
  for (const e of a.state.herd.fame || []) if (Array.isArray(e) && e.length > 4) e.length = 4;
  const without = W.serialize(a);
  const size = (t) => Buffer.byteLength(t, "utf8");
  return { bytes: size(withTown), without: size(without), town: size(withTown) - size(without) };
}

/** --persona big's gates (docs/TOWN.md §6.3): the town's share of all XP and its own save bytes. */
export const OWNER_GATES = { share: 0.04, townBytes: 0.8 * 1024 };

// ---------------------------------------------------------------------------------------------
// The town's gates (docs/TOWN.md §6.3)
// ---------------------------------------------------------------------------------------------

/** Town gates: the share of all XP (personas), the mean Lv 20-100 hours shift against --no-town. */
export const TOWN_GATES = { share: 0.03, meanShift: -0.06 };
const LEVEL_KEYS = ["L20", "L30", "L50", "L60", "L90", "L100"];

/**
 * The town's verdicts for one persona and seed: res (with the town) against base (the same seed
 * without it). {share, shareOk, left: [milestones within ±15% without the town and off with it],
 * worse: [milestones off either way, further off with the town], shift (mean of the Lv 20-100
 * hours' relative change, null when none compare), shiftOk, bad (failed gates)}.
 */
export function townGates(id, res, base) {
  const out = { share: res.town ? res.town.share : 0, shareOk: true, left: [], worse: [], shift: null, shiftOk: true, bad: 0 };
  out.shareOk = out.share <= TOWN_GATES.share;
  for (const k of ORDER) {
    const d = DESIGN[id][k];
    if (!d) continue;
    const skip = (r) => !r.events[k] && r.days < d[0];
    if (skip(res) || skip(base)) continue;
    const c0 = compare(k, d, base.events[k]);
    const c1 = compare(k, d, res.events[k]);
    if (c0.ok && !c1.ok) out.left.push(k);
    else if (!c0.ok && !c1.ok && Math.abs(c1.dev) > Math.abs(c0.dev)) out.worse.push(k);
  }
  let sum = 0;
  let n = 0;
  for (const k of LEVEL_KEYS) {
    const a = base.events[k];
    const b = res.events[k];
    if (a && b && a.hours > 0) { sum += b.hours / a.hours - 1; n++; }
  }
  if (n) out.shift = sum / n;
  out.shiftOk = out.shift == null || out.shift >= TOWN_GATES.meanShift;
  out.bad = (out.shareOk ? 0 : 1) + out.left.length + out.worse.length + (out.shiftOk ? 0 : 1);
  return out;
}

const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const signPct = (x) => `${x >= 0 ? "+" : "\u2212"}${Math.abs(100 * x).toFixed(1)}%`;

/** The persona's "Localhost:" line (docs/TOWN.md §6.3). */
export function townLine(t) {
  const all = t.xp.kill + t.xp.chest + t.xp.boss + t.xp.review + t.xp.lgtm || 1;
  const ranks = t.ranks.map((n, i) => (n && i > 0 ? `${TOWN_RANKS[i]} \u00D7${n}` : null)).filter(Boolean);
  return `Localhost: ${pct(t.share, 2)} of XP (kills ${pct(t.xp.kill / all)} · chests ${pct(t.xp.chest / all)} · bosses and reviews ${pct((t.xp.boss + t.xp.review) / all)}) · LGTM coverage ${pct(t.coverage, 0)} (${t.lgtm} of ${t.chests} chests) · Review Desk ${t.rd} (${fmtNum(t.rdGold)} gold) · ranks ${ranks.length ? ranks.join(", ") : "none yet"} · Uptime ${t.uptime}`;
}

function gateLine(g) {
  const ms = g.left.length || g.worse.length
    ? `OFF: ${g.left.map((k) => `${k} leaves ±15%`).concat(g.worse.map((k) => `${k} further off`)).join(", ")}`
    : "none leaves ±15% ok";
  return `town gates: share ${pct(g.share, 2)} ≤ ${pct(TOWN_GATES.share, 0)} ${g.shareOk ? "ok" : "OFF"} · milestones ${ms} · Lv 20-100 hours ${g.shift == null ? "n/a" : signPct(g.shift)} vs --no-town (no more than ${pct(-TOWN_GATES.meanShift, 0)} earlier) ${g.shiftOk ? "ok" : "OFF"}`;
}

// ---------------------------------------------------------------------------------------------
// The reference model (tools/reference-sim/pacing4.py)
// ---------------------------------------------------------------------------------------------

/** Runs pacing4.py and parses its milestones: {casual: {L5: {day, hours}, B1: {...}}, ...}, or null. */
export function referenceModel() {
  const dir = path.join(HERE, "reference-sim");
  let out;
  try {
    out = execFileSync("python3", ["pacing4.py"], { cwd: dir, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const ref = {};
  let cur = null;
  for (const line of out.split("\n")) {
    const h = /^== (\w+):/.exec(line);
    if (h) { cur = h[1].toLowerCase(); ref[cur] = {}; continue; }
    const m = /^\s+([LB]\d+)\s+day\s+(\d+)\s+\(([\d.]+)/.exec(line);
    if (m && cur) ref[cur][m[1]] = { day: Number(m[2]), hours: Number(m[3]) };
    const b = /^bot day (\d+) Lv (\d+)/.exec(line);
    if (b) { (ref.bot || (ref.bot = {}))[b[1]] = Number(b[2]); }
  }
  return ref;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const ORDER = ["L5", "L10", "B1", "L20", "B2", "L30", "B3", "B4", "L50", "B5", "L60", "B6", "B7", "B8", "L90", "B9", "L100"];

/**
 * Compares one milestone with D§12.1: hours when the design gives them (Lv milestones and Boss 1),
 * else days (bosses after day 1). Returns {ok, dev} with dev the relative deviation, or null when
 * the sim did not reach it.
 */
export function compare(key, design, got) {
  if (!design) return null;
  if (!got) return { ok: false, dev: Infinity, missing: true };
  if (design[1] != null) {
    const dev = got.hours / design[1] - 1;
    return { ok: Math.abs(dev) <= TOL, dev, unit: "h" };
  }
  // day granularity: a milestone on "day N" means during day N's session; ±15% of the day number,
  // and never less than one day of slack either way
  const dev = (got.day - design[0]) / design[0];
  return { ok: Math.abs(dev) <= TOL || Math.abs(got.day - design[0]) <= 1, dev, unit: "d" };
}

function fmtH(h) {
  if (h == null) return "";
  return h < 1.5 ? `${Math.round(h * 60)} min` : `${Math.round(h * 10) / 10} h`;
}

function table(id, res, ref, base) {
  const design = DESIGN[id];
  const rows = [];
  let bad = 0;
  const devText = (c) => (c && Number.isFinite(c.dev) ? `${c.dev >= 0 ? "+" : ""}${Math.round(c.dev * 100)}%${c.unit === "d" ? " d" : ""}` : "");
  for (const k of ORDER) {
    if (!design[k] && !res.events[k]) continue;
    const d = design[k];
    const g = res.events[k];
    const r = ref && ref[id] ? ref[id][k] : null;
    const c = compare(k, d, g);
    if (c && !c.ok && !(c.missing && res.days < (d ? d[0] : 0))) bad++;
    const row = [
      k.replace(/^L/, "Lv ").replace(/^B/, "Boss "),
      d ? `day ${d[0]}${d[1] != null ? ` (${fmtH(d[1])})` : ""}` : "",
      r ? `day ${r.day} (${fmtH(r.hours)})` : "",
      g ? `day ${g.day} (${fmtH(g.hours)})` : res.days < (d ? d[0] : Infinity) ? "(not simulated)" : "not reached",
      devText(c),
      c ? (c.ok ? "ok" : c.missing && res.days < d[0] ? "" : "OFF") : "",
    ];
    if (base) {
      // the town's baseline: the same seed without the town (docs/TOWN.md §6.3)
      const b = base.events[k];
      const cb = compare(k, d, b);
      row.push(b ? `day ${b.day} (${fmtH(b.hours)})` : base.days < (d ? d[0] : Infinity) ? "(not simulated)" : "not reached", devText(cb));
    }
    rows.push(row);
  }
  return { rows, bad };
}

function printTable(title, head, rows) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ");
  console.log(`\n${title}`);
  console.log(line(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(line(r));
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

class UsageError extends Error {}
const USAGE = "usage: node tools/pacing-sim.mjs [--persona casual|solo|typical|heavy|bot|all|big] [--days N] [--long] [--quick] [--json] [--no-ref] [--seed N] [--seeds 1-4] [--no-town] [--sweep]";

function parseSeeds(v) {
  const m = /^(\d+)-(\d+)$/.exec(String(v || ""));
  const list = m ? [] : String(v || "").split(",").map(Number);
  if (m) for (let n = Number(m[1]); n <= Number(m[2]); n++) list.push(n);
  if (!list.length || list.some((n) => !Number.isInteger(n) || n < 1)) throw new UsageError("--seeds needs a range (1-4) or a list (1,2,3,4)");
  return list;
}

function parseArgs(argv) {
  const o = { persona: "all", days: null, long: false, quick: false, json: false, ref: true, seed: 1, sweep: false, town: true, seeds: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--persona") o.persona = argv[++i];
    else if (a === "--days") o.days = Number(argv[++i]);
    else if (a === "--long") o.long = true;
    else if (a === "--quick") o.quick = true;
    else if (a === "--json") o.json = true;
    else if (a === "--no-ref") o.ref = false;
    else if (a === "--seed") o.seed = Number(argv[++i]);
    else if (a === "--seeds") o.seeds = parseSeeds(argv[++i]);
    else if (a === "--no-town") o.town = false;
    else if (a === "--sweep") o.sweep = true;
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (o.persona !== "all" && o.persona !== "bot" && o.persona !== "big" && !Object.prototype.hasOwnProperty.call(PERSONAS, o.persona)) throw new UsageError(`unknown persona ${o.persona}`);
  if (o.days != null && !(o.days > 0)) throw new UsageError("--days needs a positive number");
  if (!Number.isFinite(o.seed)) throw new UsageError("--seed needs a number");
  return o;
}

// --persona big (docs/TOWN.md §6.3.6): the owner model, informational, with its two gates
function runOwner(o) {
  const days = o.days || 7;
  const r = simOwner(days);
  const t = r.town;
  const g = t ? { share: t.share, shareOk: t.share <= OWNER_GATES.share, townBytes: r.saves.town, bytesOk: r.saves.town <= OWNER_GATES.townBytes } : null;
  const bad = g ? (g.shareOk ? 0 : 1) + (g.bytesOk ? 0 : 1) : 0;
  if (o.json) {
    console.log(JSON.stringify({ owner: { days, ms: r.ms, town: t, hourly: r.hourly, coverage: r.days, saves: r.saves, gates: g, levels: r.world.state.heroes.map((h) => h.L) }, bad }, null, 1));
    process.exitCode = bad ? 1 : 0;
    return;
  }
  const heroes = r.world.state.heroes;
  console.log(`\n== The owner model (docs/TOWN.md Appendix A): 32 agents in 25 spaces, herdr open — ${days} day(s) simulated in ${(r.ms / 1000).toFixed(1)} s`);
  console.log(`   roster ${heroes.length} heroes, Lv ${Math.min(...heroes.map((h) => h.L))}-${Math.max(...heroes.map((h) => h.L))} · zone ${r.world.state.herd.zone} · buildings ${r.world.state.herd.bld.join(",")}`);
  if (t) {
    printTable(`   on duty by hour, day ${days} (averages over the hour)`, ["hour", "fighting", "waiting", "shipped", "on duty", "campfire", "LGTM shelf"],
      r.hourly.map((b) => [`${String(b.hour).padStart(2, "0")}:00`, b.fighting, b.waiting, b.shipped, b.onDuty, b.campfire, `${b.shelf} / ${b.cap}`]));
    console.log(`\n   coverage by game day: ${r.days.map((d) => `day ${d.day} ${d.lgtm}/${d.chests} (${d.chests ? Math.round((100 * d.lgtm) / d.chests) : 0}%, desk ${d.rd})${d.partial ? " so far" : ""}`).join(" · ")}`);
    console.log(`   ${townLine(t)}`);
  }
  console.log(`   save ${r.saves.bytes} B, without the town's fields ${r.saves.without} B: the town's own ${r.saves.town} B`);
  if (g) console.log(`   owner gates: town share ${pct(g.share, 2)} ≤ ${pct(OWNER_GATES.share, 0)} ${g.shareOk ? "ok" : "OFF"} · the town's save bytes ${g.townBytes} ≤ ${OWNER_GATES.townBytes} ${g.bytesOk ? "ok" : "OFF"}`);
  process.exitCode = bad ? 1 : 0;
}

// One seed: every persona of `ids` (with the town: and its baseline without it), then the bot.
function runSeed(o, seed, ids, ref, summary) {
  const out = { personas: {}, bot: null };
  let bad = 0;
  const town = T.town.on !== false;
  const multi = !!o.seeds;
  for (const id of ids) {
    const p = PERSONAS[id];
    const days = o.quick ? 1 : o.days || p.days;
    const res = simPersona(p, { days, seed, until: ["B9", "L100"] });
    // the town's baseline (docs/TOWN.md §6.3): the same seed without the town
    const base = town ? simPersona(p, { days, seed, until: ["B9", "L100"], town: false }) : null;
    // the verdicts count in every output mode (--json too), so the exit code always tells
    const t = table(id, res, ref, base);
    const gates = base ? townGates(id, res, base) : null;
    // with the town, a milestone off D§12.1 counts when it is off only with the town or further
    // off than without it (a seed that already misses must not miss by more); the town's own
    // gates (share, mean shift) add to it
    bad += gates ? gates.bad : t.bad;
    out.personas[id] = {
      events: res.events, days: res.days, ticks: res.ticks, ms: res.ms, final: res.final, bad: gates ? gates.bad : t.bad,
      verdicts: t.rows.map((r) => ({ milestone: r[0], design: r[1], engine: r[3], dev: r[4], verdict: r[5] || null })),
    };
    if (gates) Object.assign(out.personas[id], { town: res.town, gates, base: { events: base.events, days: base.days, ms: base.ms, final: base.final, offs: t.bad } });
    if (gates && summary) summary.push({ id, seed, res, base, gates, offTown: t.rows.filter((r) => r[5] === "OFF").length });
    if (!o.json) {
      const head = ["milestone", "design D§12.1", "pacing4.py", "real engine", "dev", ""];
      if (base) head.push("no town", "dev");
      printTable(
        `== ${p.name}: ${p.agents} agent(s) x ${p.hours} h/day, ${p.taskMin}-min tasks — ${res.days} day(s) simulated in ${(res.ms / 1000).toFixed(1)} s (${res.ticks} ticks)${multi ? ` · seed ${seed}` : ""}`,
        head, t.rows,
      );
      console.log(`   final: Lv ${res.final.levels.join(", ")} · zone ${res.final.zone} · release ${res.final.rel} · working h/hero ${res.final.wh.join(", ")} · save ${res.final.saveBytes} B`);
      if (gates) {
        console.log(`   ${townLine(res.town)}`);
        console.log(`   ${gateLine(gates)}${t.bad && !(gates.left.length + gates.worse.length) ? ` (${t.bad} off D§12.1 without the town too, no further off)` : ""} · without the town: save ${base.final.saveBytes} B, ${(base.ms / 1000).toFixed(1)} s`);
      }
    }
  }
  if (o.persona === "all" || o.persona === "bot") {
    const want = o.quick ? [1] : o.long ? [1, 7, 30, 90] : [1, 7, 30];
    const res = simBot(Math.max(...want), { seed });
    const rows = want.map((d) => {
      const L = res.levels[d];
      const D = BOT_DESIGN[d];
      const ok = Math.abs(L - D) <= Math.max(1, Math.round(D * TOL));
      if (!ok) bad++;
      return [`day ${d}`, `Lv ${D}`, ref && ref.bot ? `Lv ${ref.bot[d] ?? ""}` : "", `Lv ${L}`, ok ? "ok" : "OFF"];
    });
    out.bot = { levels: res.levels, ms: res.ms, verdicts: want.map((d, i) => ({ day: d, design: BOT_DESIGN[d], engine: res.levels[d], verdict: rows[i][4] })) };
    if (!o.json) {
      printTable(`== Bot (D§12.2): always working, never seen — ${(res.ms / 1000).toFixed(1)} s${multi ? ` · seed ${seed}` : ""}`, ["when", "design", "pacing4.py", "real engine", ""], rows);
    }
  }
  out.bad = bad;
  return out;
}

// The town's summary over the seeds run (docs/BALANCE.md §14)
function printSummary(summary) {
  const rows = summary.map(({ id, seed, res, base, gates, offTown }) => {
    const t = res.town;
    // the worst of the milestones D§12.1 gives hours for (the bosses after day 1 compare by day, with
    // a day of slack either way)
    let worst = null;
    for (const k of ORDER) {
      const c = compare(k, DESIGN[id][k], res.events[k]);
      if (c && c.unit === "h" && Number.isFinite(c.dev) && (!worst || Math.abs(c.dev) > Math.abs(worst.dev))) worst = { k, dev: c.dev, unit: c.unit, base: compare(k, DESIGN[id][k], base.events[k]) };
    }
    const offBase = ORDER.filter((k) => { const c = compare(k, DESIGN[id][k], base.events[k]); return c && !c.ok && !(c.missing && base.days < DESIGN[id][k][0]); }).length;
    const dv = (c) => (c && Number.isFinite(c.dev) ? `${c.dev >= 0 ? "+" : ""}${(100 * c.dev).toFixed(1)}%${c.unit === "d" ? " d" : ""}` : "n/a");
    return [
      PERSONAS[id].name, seed, pct(t.share, 2), pct(t.coverage, 0), `${t.rd} (${fmtNum(t.rdGold)})`,
      t.ranks.map((n, i) => (n && i ? `${TOWN_RANKS[i].slice(0, 4)} ${n}` : "")).filter(Boolean).join(" ") || "-", t.uptime,
      gates.shift == null ? "n/a" : signPct(gates.shift),
      worst ? `${worst.k} ${dv(worst)} (${dv(worst.base)})` : "",
      `${offTown} (${offBase})`, gates.bad ? "OFF" : "ok",
    ];
  });
  printTable("== Localhost over the seeds (docs/BALANCE.md §14): with the town against the same seed without it",
    ["persona", "seed", "town share", "coverage", "Review Desk (gold)", "ranks", "uptime", "Lv 20-100 h", "worst hours milestone (no town)", "off (no town)", "gates"], rows);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  // the build before the town (docs/TOWN.md §6.3): no duty, no buys, no bonuses
  if (!o.town) T.town.on = false;
  if (o.sweep) {
    // every real map x class at on-level for a full hour, the D§5.2 reference kit and real
    // autopilot gear (the typical persona's, harvestGear)
    const rows = sweep({ kits: ["ref", "auto"], ticks: 3600, seed: o.seed });
    if (o.json) console.log(JSON.stringify(rows, null, 1));
    else printSweep(rows);
    process.exitCode = sweepMisses(rows).length ? 1 : 0;
    return;
  }
  if (o.persona === "big") return runOwner(o);
  const ids = o.persona === "all" ? Object.keys(PERSONAS) : o.persona === "bot" ? [] : [o.persona];
  for (const id of ids) if (!PERSONAS[id]) throw new Error(`unknown persona ${id}`);
  const ref = o.ref ? referenceModel() : null;
  if (o.ref && !ref && !o.json) console.log("(python3 not available: reference model column left empty)");
  const seeds = o.seeds || [o.seed];
  const summary = [];
  const runs = seeds.map((seed) => ({ seed, out: runSeed(o, seed, ids, ref, summary) }));
  const bad = runs.reduce((n, r) => n + r.out.bad, 0);
  if (!o.json && o.seeds && summary.length) printSummary(summary);
  if (o.json) {
    const out = o.seeds ? { seeds, runs: runs.map((r) => Object.assign({ seed: r.seed }, r.out)), bad } : runs[0].out;
    console.log(JSON.stringify(out, null, 1));
  } else if (T.town.on !== false && ids.length) console.log(bad ? `\n${bad} milestone(s) or town gate(s) off.` : `\nAll milestones within ${TOL * 100}% of the design; the town's gates hold.`);
  else console.log(bad ? `\n${bad} milestone(s) more than ${TOL * 100}% off the design.` : `\nAll milestones within ${TOL * 100}% of the design.`);
  process.exitCode = bad ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    if (e instanceof UsageError) console.error(`${e.message}\n${USAGE}`);
    else console.error(e);
    process.exitCode = 2;
  });
}
