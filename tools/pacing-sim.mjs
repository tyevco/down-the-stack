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
// --quick: day 1 only for every persona (what test/pacing.test.mjs checks). Exit code 1 when a
// milestone is more than 15% off the design (D§12.1 hours, or days for bosses past day 1).
//
// Engine fixes this simulator found (integration pass): Interns stuck on map 1-1 with an iLvl-1
// Training Stick (Boss 1 at +190% on day 1: the starter stick now grows with its Intern);
// autopilot's Item Power pre-filter kept late heroes in long-outgrown Keepsakes (Power Level fell
// to L - 5, Boss 8/9 walls); repeat boss kills gave 0.1 Need(L) XP whatever the boss level (now
// x gap); class-biased map choice by Power Level (tanks 3-4 levels low, Hotfixers above) and guild
// convergence stalling the frontier for days.
//
// Known gap (a design calibration, not an engine bug): from Lv 30 on, every persona runs about
// 25-35% ahead of D§12.1 (Lv 100 in ~165-180 working hours instead of 215-259); the bot reaches
// Lv 36 instead of 28 by day 30. The model behind D§12.1 assumes 15.5 kills/min with the D§5.2
// reference kit and no boss XP; the engine measures 19-27 kills/min because autopilot gear runs
// 1.4-2x the reference kit's damage (chest loot at map top + 0-2 vs iRef = L - 2, damage affixes
// ~2x D_ref, polish to the rarity's max vs L/10), the classes' own on-level pace is 15-18 (D§4.3),
// Fresh Eyes stays on all session once the Campfire is bought (the model grows its cap by day/6),
// boss first-kill / review / farm XP adds 10-25% a day, and an out-levelled bot one-shots three
// mobs a tick (~50 kills/min at the 10% gap floor).

import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import * as W from "../mods/mapledr/game/world.js";
import * as Dm from "../mods/mapledr/game/demo.js";
import { TUNING as T, BOSSES } from "../mods/mapledr/game/data.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60;
const HOUR = 3600;
const DAY_MS = 86400000;
// 2026-09-21 00:00 UTC (a Monday); sessions start at 09:00 local (tzOffsetMin 0)
const EPOCH = Date.UTC(2026, 8, 21);
const SESSION_START_H = 9;
const DONE_SEC = 45; // a task's "done" stretch before the person looks (then idle = seen)
const SEEN_SEC = 45; // idle after seeing the result, before the next task starts

/** D§12.1 personas. */
export const PERSONAS = {
  casual: { name: "Casual", agents: 1, hours: 1.5, taskMin: 8, days: 170 },
  solo: { name: "Solo", agents: 1, hours: 3, taskMin: 12, days: 95 },
  typical: { name: "Typical", agents: 3, hours: 2, taskMin: 10, days: 115 },
  heavy: { name: "Heavy", agents: 5, hours: 5, taskMin: 15, days: 56 },
};

const LEVELS = [5, 10, 20, 30, 50, 60, 90, 100];

/**
 * D§12.1 targets: [day, working hours per hero] (hours null where the table gives none). Lv 5 and
 * Lv 10 are "12 min" / "42 min" (36 min heavy); Boss 1 "1.0 h" (casual, solo) or "36 min".
 */
export const DESIGN = {
  casual: { L5: [1, 0.2], L10: [1, 0.7], B1: [1, 1.0], L20: [2, 2.8], B2: [3], L30: [6, 7.9], B3: [7], B4: [14], L50: [21, 31], B5: [25], L60: [35, 52], B6: [42], B7: [67], B8: [100], L90: [116, 173], B9: [146], L100: [161, 241] },
  solo: { L5: [1, 0.2], L10: [1, 0.7], B1: [1, 1.0], L20: [2, 3.1], B2: [2], L30: [3, 8.8], B3: [4], B4: [8], L50: [12, 36], B5: [15], L60: [20, 60], B6: [24], B7: [38], B8: [55], L90: [62, 185], B9: [77], L100: [85, 253] },
  typical: { L5: [1, 0.2], L10: [1, 0.7], B1: [1, 0.6], L20: [2, 2.7], B2: [2], L30: [4, 7.6], B3: [5], B4: [10], L50: [16, 30], B5: [18], L60: [25, 49], B6: [29], B7: [46], B8: [67], L90: [77, 154], B9: [98], L100: [108, 215] },
  heavy: { L5: [1, 0.2], L10: [1, 0.6], B1: [1, 0.6], L20: [1, 2.8], B2: [1], L30: [2, 8.3], B3: [2], B4: [5], L50: [7, 35], B5: [9], L60: [12, 57], B6: [14], B7: [22], B8: [33], L90: [38, 186], B9: [48], L100: [52, 259] },
};

/** D§12.2: the always-working bot's level by day. */
export const BOT_DESIGN = { 1: 19, 7: 23, 30: 28, 90: 33, 365: 42 };

const TOL = 0.15;

// ---------------------------------------------------------------------------------------------
// One persona
// ---------------------------------------------------------------------------------------------

// The day's plan for agent k: idle until its start, then tasks until the day's working minutes are
// done (the last task is shorter), then idle for the rest of the session.
function dayPlan(p, k) {
  const plan = [];
  const lead = Math.round(k * 0.15 * p.taskMin * MIN); // agents of a herd do not start in lockstep
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
  return Math.round(k * 0.15 * p.taskMin * MIN) + Math.round(p.hours * HOUR) + tasks * (DONE_SEC + SEEN_SEC);
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
 * Plays a persona with the real engine. Returns {events: {L5: {day, hours}, B1: {...}, ...},
 * days, ticks, ms, final: {levels, zone, ...}}.
 * @param {object} p a PERSONAS entry (or {agents, hours, taskMin})
 * @param {{days?:number, seed?:number, reload?:boolean, until?:string[], log?:Function,
 *          onTick?:Function}} [opts] log(day, world, events) after each day; onTick(world, snap, res)
 */
export function simPersona(p, opts = {}) {
  const days = opts.days || p.days;
  const reload = opts.reload !== false;
  const until = opts.until || null;
  const t0 = performance.now();
  let world = W.createWorld({ nowMs: EPOCH + SESSION_START_H * HOUR * 1000 - 60000, seed: opts.seed || 1 });
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
      now = Dm.runCast(world, cast, to, { onTick: (w, s, r) => { ticks += r.ticks; if (opts.onTick) opts.onTick(w, s, r); check(day); } });
    }
    cast.agents.forEach((a, k) => { seqs[k] = a.seq + 1; });
    if (world.rt.errors.length) throw new Error(`engine errors on day ${day}: ${world.rt.errors.join("; ")}`);
    if (opts.log) opts.log(day, world, events);
    if (until && until.every((k) => events[k])) break;
  }
  const heroes = world.state.heroes;
  return {
    events, days: Math.min(day, days), ticks, ms: Math.round(performance.now() - t0),
    final: {
      levels: heroes.map((h) => h.L), classes: heroes.map((h) => h.cls), zone: world.state.herd.zone, rel: world.state.herd.rel,
      gold: world.state.herd.gold, wh: heroes.map((h) => Math.round(h.st.wh * 10) / 10), bld: world.state.herd.bld.slice(),
      saveBytes: W.serialize(world).length,
    },
    world,
  };
}

// ---------------------------------------------------------------------------------------------
// The always-working bot (D§12.2)
// ---------------------------------------------------------------------------------------------

/**
 * One agent that never stops working and is never looked at, for `days` days (the app stays
 * open). Returns {levels: {[day]: L}, ms}.
 */
export function simBot(days, opts = {}) {
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

function table(id, res, ref) {
  const design = DESIGN[id];
  const rows = [];
  let bad = 0;
  for (const k of ORDER) {
    if (!design[k] && !res.events[k]) continue;
    const d = design[k];
    const g = res.events[k];
    const r = ref && ref[id] ? ref[id][k] : null;
    const c = compare(k, d, g);
    if (c && !c.ok && !(c.missing && res.days < (d ? d[0] : 0))) bad++;
    rows.push([
      k.replace(/^L/, "Lv ").replace(/^B/, "Boss "),
      d ? `day ${d[0]}${d[1] != null ? ` (${fmtH(d[1])})` : ""}` : "",
      r ? `day ${r.day} (${fmtH(r.hours)})` : "",
      g ? `day ${g.day} (${fmtH(g.hours)})` : res.days < (d ? d[0] : Infinity) ? "(not simulated)" : "not reached",
      c && Number.isFinite(c.dev) ? `${c.dev >= 0 ? "+" : ""}${Math.round(c.dev * 100)}%${c.unit === "d" ? " d" : ""}` : "",
      c ? (c.ok ? "ok" : c.missing && res.days < d[0] ? "" : "OFF") : "",
    ]);
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

function parseArgs(argv) {
  const o = { persona: "all", days: null, long: false, quick: false, json: false, ref: true, seed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--persona") o.persona = argv[++i];
    else if (a === "--days") o.days = Number(argv[++i]);
    else if (a === "--long") o.long = true;
    else if (a === "--quick") o.quick = true;
    else if (a === "--json") o.json = true;
    else if (a === "--no-ref") o.ref = false;
    else if (a === "--seed") o.seed = Number(argv[++i]);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const ids = o.persona === "all" ? Object.keys(PERSONAS) : o.persona === "bot" ? [] : [o.persona];
  for (const id of ids) if (!PERSONAS[id]) throw new Error(`unknown persona ${id}`);
  const ref = o.ref ? referenceModel() : null;
  if (o.ref && !ref && !o.json) console.log("(python3 not available: reference model column left empty)");
  const out = { personas: {}, bot: null };
  let bad = 0;
  for (const id of ids) {
    const p = PERSONAS[id];
    const days = o.quick ? 1 : o.days || p.days;
    const res = simPersona(p, { days, seed: o.seed, until: ["B9", "L100"] });
    out.personas[id] = { events: res.events, days: res.days, ticks: res.ticks, ms: res.ms, final: res.final };
    if (!o.json) {
      const t = table(id, res, ref);
      bad += t.bad;
      printTable(
        `== ${p.name}: ${p.agents} agent(s) x ${p.hours} h/day, ${p.taskMin}-min tasks — ${res.days} day(s) simulated in ${(res.ms / 1000).toFixed(1)} s (${res.ticks} ticks)`,
        ["milestone", "design D§12.1", "pacing4.py", "real engine", "dev", ""], t.rows,
      );
      console.log(`   final: Lv ${res.final.levels.join(", ")} · zone ${res.final.zone} · release ${res.final.rel} · working h/hero ${res.final.wh.join(", ")} · save ${res.final.saveBytes} B`);
    }
  }
  if (o.persona === "all" || o.persona === "bot") {
    const want = o.quick ? [1] : o.long ? [1, 7, 30, 90] : [1, 7, 30];
    const res = simBot(Math.max(...want), { seed: o.seed });
    out.bot = { levels: res.levels, ms: res.ms };
    if (!o.json) {
      const rows = want.map((d) => {
        const L = res.levels[d];
        const D = BOT_DESIGN[d];
        const ok = Math.abs(L - D) <= Math.max(1, Math.round(D * TOL));
        if (!ok) bad++;
        return [`day ${d}`, `Lv ${D}`, ref && ref.bot ? `Lv ${ref.bot[d] ?? ""}` : "", `Lv ${L}`, ok ? "ok" : "OFF"];
      });
      printTable(`== Bot (D§12.2): always working, never seen — ${(res.ms / 1000).toFixed(1)} s`, ["when", "design", "pacing4.py", "real engine", ""], rows);
    }
  }
  if (o.json) console.log(JSON.stringify(out, null, 1));
  else console.log(bad ? `\n${bad} milestone(s) more than ${TOL * 100}% off the design.` : `\nAll milestones within ${TOL * 100}% of the design.`);
  process.exitCode = bad ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 2; });
}
