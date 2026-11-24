// Deterministic demo worlds and scripted agents (ARCHITECTURE §1 "demo.js"): fixtures for tests,
// tools/check.mjs, previews and screenshots, and the scripted-agent driver the end-to-end tests
// and tools/pacing-sim.mjs use.
//
//   demoWorld(kind, nowMs) -> {world, snapshot}     kinds: DEMO_KINDS
//   demoSnapshot(world, nowMs) -> Snapshot          the next snapshot of a demo world's cast
//
// Every demo world is built by the real engine: createWorld, then hero progress through engine
// calls (signature tasks, grantXP level-ups, rolled items, building purchases, boss credit the way
// boss.js records it), then a scripted run of world.tick with genuine snapshots, so rooms, lanes,
// mobs, fights, chests and effects are whatever the engine makes of them. The same (kind, nowMs)
// always gives the same world. Each build costs well under 300 ms in V8.
//
// Scripted agents (ARCHITECTURE §3.3 Snapshot):
//   makeAgent(spec)            an agent that follows a plan of [status, seconds] phases
//   makeCast(agents, opts)     agents + focus/window/timezone; castSnapshot(cast, nowMs)
//   advanceCast(cast, sec)     moves every plan forward (seq increments on each status change,
//                              except herdr's done <-> idle seen flip, which keeps the seq)
//   untilChange(cast)          seconds until the next status change anywhere in the cast
//   runCast(world, cast, toMs) drives world.tick up to toMs in steps of at most 5 s that never
//                              skip a status change
//
// Pure: no host calls, no Date.now(), no Math.random().
//
// Shipped with the mod but never loaded by it: nothing main.js reaches imports this file (it costs
// nothing at runtime). It lives here, next to the engine it drives, because tests, tools/check.mjs,
// the previews and tools/pacing-sim.mjs all build their worlds through it.

import { TUNING as T, CLASS_IDX, ZONES, MAPS, BOSSES, SLOTS, BADGES, REVIEWS, BACKLOG } from "./data.js";
import { need, polishMax } from "./formulas.js";
import { createWorld, tick, command } from "./world.js";
import { grantXP, recordTask, autoLearn, setClass, winReview } from "./heroes.js";
import { rollItem, rollKeepsake, equipItem, stashPut } from "./items.js";
import { awardBadge, addGold, addSnippets, noteFirstClear, logMax } from "./herd.js";
import { liveHeroes } from "./agents.js";

const SEC = 1000;
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------------------------
// Programs (a few rows of herdr's programs.json, as agents() reports them)
// ---------------------------------------------------------------------------------------------

/** Program records for scripted agents (herdr's Program shape). */
export const PROGRAMS = {
  claude: { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, tile: "#1c1d21", color: "#ffffff", shell: false, agent: true },
  codex: { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: false, tile: "#1c1d21", color: "#ffffff", shell: false, agent: true },
  pi: { key: "pi", name: "Pi", icon: "icons/pi.svg", tint: true, tile: "#1c1d21", color: "#ffffff", shell: false, agent: true },
  opencode: { key: "opencode", name: "OpenCode", icon: "icons/opencode.svg", tint: true, tile: "#1c1d21", color: "#ffffff", shell: false, agent: true },
  gemini: { key: "gemini", name: "Gemini", icon: "icons/gemini.svg", tint: true, tile: "#8e75b2", color: "#ffffff", shell: false, agent: true },
  cursor: { key: "cursor", name: "Cursor", icon: "icons/cursor.svg", tint: true, tile: "#1c1d21", color: "#ffffff", shell: false, agent: true },
};
const APPS = { claude: "claude-code", codex: "codex", pi: "pi", opencode: "opencode", gemini: "gemini", cursor: "cursor-agent" };

/** Quest titles the scripted agents cycle through (one per task). */
export const TITLES = [
  "Fix flaky auth test", "Refactor session store", "Add retry to webhook sender", "Bump deps and fix types",
  "Write migration for audit log", "Speed up CI cache", "Investigate memory leak", "Port settings page to tabs",
  "Document the release process", "Tidy error messages", "Split the monolith router", "Add dark mode tokens",
];

// ---------------------------------------------------------------------------------------------
// Scripted agents
// ---------------------------------------------------------------------------------------------

/**
 * A scripted agent. spec = {address, program ("claude"), app, title, titles, space ("spc_1"),
 * spaceName ("herdr-app"), tab, tabIndex, tabName, pane, paneName, pinned, focused,
 * plan: [[status, seconds], ...] (default: always working), loop (true), start (seconds into the
 * plan), from (epoch ms before which the terminal does not exist), subs: [sub-agent specs with their
 * own plan]}. A plan phase of status "gone" removes the terminal from snapshots for its duration
 * (a closed terminal; it comes back as a new one).
 */
export function makeAgent(spec = {}) {
  const pkey = spec.program || "claude";
  const prog = typeof pkey === "object" ? pkey : PROGRAMS[pkey] || Object.assign({}, PROGRAMS.claude, { key: pkey, name: pkey });
  const a = {
    scripted: true,
    address: String(spec.address || "t1"),
    program: prog,
    app: spec.app !== undefined ? spec.app : APPS[prog.key] || prog.key,
    titles: spec.titles || (spec.title ? [spec.title] : TITLES),
    titleIdx: spec.titleIdx || 0,
    space: spec.space || "spc_1",
    spaceName: spec.spaceName !== undefined ? spec.spaceName : "herdr-app",
    tab: spec.tab || "tab_1",
    tabIndex: spec.tabIndex || 0,
    tabName: spec.tabName || "main",
    pane: spec.pane || `p_${spec.address || "t1"}`,
    paneName: spec.paneName === undefined ? null : spec.paneName,
    pinned: !!spec.pinned,
    focused: !!spec.focused,
    from: spec.from || 0, // epoch ms before which the terminal does not exist yet
    plan: (spec.plan && spec.plan.length ? spec.plan : [["working", Infinity]]).map((p) => [p[0], p[1]]),
    loop: spec.loop !== false,
    phase: 0,
    left: 0,
    seq: spec.seq || 1,
    status: "idle",
    subs: [],
  };
  a.left = a.plan[0][1];
  a.status = a.plan[0][0];
  if (spec.start > 0) advanceAgent(a, spec.start, true);
  for (const s of spec.subs || []) {
    a.subs.push(makeAgent(Object.assign({ program: prog.key, space: a.space, spaceName: a.spaceName, tab: a.tab }, s)));
  }
  return a;
}

/**
 * Moves an agent's plan `sec` seconds forward. A status change increments seq as herdr does: herdr
 * bumps seq when the core's status word changes (src/model.rs set_word), but done <-> idle is its
 * seen flag (mark_seen / set_turn), so that flip keeps the seq. A new working phase after a
 * non-working one takes the next quest title.
 * @param {boolean} [quiet] (setup only) skip seq increments
 */
export function advanceAgent(a, sec, quiet) {
  let t = sec;
  while (t > 0) {
    if (!(a.left > 0) || !Number.isFinite(a.left)) {
      if (!Number.isFinite(a.left)) break;
      if (!nextPhase(a, quiet)) break;
      continue;
    }
    const d = Math.min(t, a.left);
    a.left -= d;
    t -= d;
    if (a.left <= 0 && !nextPhase(a, quiet)) break;
  }
  for (const s of a.subs) advanceAgent(s, sec, quiet);
}

function nextPhase(a, quiet) {
  let p = a.phase + 1;
  if (p >= a.plan.length) {
    if (!a.loop) { a.left = Infinity; return false; }
    p = 0;
  }
  a.phase = p;
  a.left = a.plan[p][1];
  const st = a.plan[p][0];
  if (st !== a.status) {
    if (st === "working" && a.status !== "blocked") a.titleIdx++;
    const seenFlip = (a.status === "done" && st === "idle") || (a.status === "idle" && st === "done");
    a.status = st;
    if (!quiet && !seenFlip) a.seq++;
  }
  return true;
}

/** Seconds until this agent (or one of its sub-agents) changes status (Infinity: never). */
export function agentUntilChange(a) {
  let best = Infinity;
  if (Number.isFinite(a.left)) {
    // phases of the same status in a row are no change: look ahead
    let acc = a.left;
    let p = a.phase;
    for (let k = 0; k < a.plan.length + 1; k++) {
      let q = p + 1;
      if (q >= a.plan.length) { if (!a.loop) { acc = Infinity; break; } q = 0; }
      if (a.plan[q][0] !== a.status) break;
      if (!Number.isFinite(a.plan[q][1])) { acc = Infinity; break; }
      acc += a.plan[q][1];
      p = q;
    }
    best = acc;
  }
  for (const s of a.subs) best = Math.min(best, agentUntilChange(s));
  return best;
}

/** The agent as herdr's agents() reports it (ARCHITECTURE §3.3), or null while "gone". */
export function agentInfo(a, focusedAddr) {
  if (a.status === "gone") return null;
  const title = a.titles[a.titleIdx % a.titles.length];
  return {
    address: a.address, status: a.status, seq: a.seq, app: a.app, program: a.program, title,
    space: a.space, space_name: a.spaceName, tab: a.tab, tab_index: a.tabIndex, tab_name: a.tabName,
    pane: a.pane, pane_name: a.paneName, pinned: a.pinned, focused: focusedAddr != null ? focusedAddr === a.address : a.focused,
  };
}

/**
 * A cast of scripted agents plus the window: {agents, focus (address or null), windowActive,
 * tzOffsetMin, focusPlan: [[address|null, seconds], ...] (optional, loops)}.
 */
export function makeCast(agents, opts = {}) {
  const cast = {
    agents: agents.map((a) => (a && a.scripted ? a : makeAgent(a))),
    focus: opts.focus === undefined ? null : opts.focus,
    windowActive: opts.windowActive !== false,
    tzOffsetMin: opts.tzOffsetMin || 0,
    focusPlan: opts.focusPlan || null,
    focusPhase: 0,
    focusLeft: opts.focusPlan ? opts.focusPlan[0][1] : Infinity,
  };
  if (cast.focusPlan) cast.focus = cast.focusPlan[0][0];
  return cast;
}

/** Moves every agent (and the focus plan) `sec` seconds forward. */
export function advanceCast(cast, sec) {
  for (const a of cast.agents) advanceAgent(a, sec);
  if (cast.focusPlan) {
    let t = sec;
    while (t > 0 && Number.isFinite(cast.focusLeft)) {
      const d = Math.min(t, cast.focusLeft);
      cast.focusLeft -= d;
      t -= d;
      if (cast.focusLeft <= 0) {
        cast.focusPhase = (cast.focusPhase + 1) % cast.focusPlan.length;
        cast.focus = cast.focusPlan[cast.focusPhase][0];
        cast.focusLeft = cast.focusPlan[cast.focusPhase][1];
      }
    }
  }
}

/** Seconds until anything in the cast changes (a status or the focus). */
export function untilChange(cast) {
  let best = cast.focusPlan ? cast.focusLeft : Infinity;
  for (const a of cast.agents) best = Math.min(best, agentUntilChange(a));
  return best;
}

/** Local weekday 0..6 (Sunday = 0) of an epoch time (1970-01-01 was a Thursday). */
export function weekdayOf(nowMs, tzOffsetMin = 0) {
  const days = Math.floor((nowMs - tzOffsetMin * 60000) / DAY_MS);
  return (((days + 4) % 7) + 7) % 7;
}

/** The host snapshot of a cast at nowMs (ARCHITECTURE §3.3). */
export function castSnapshot(cast, nowMs) {
  const agents = [];
  const subagents = [];
  const spaces = [];
  const seenSpace = new Set();
  const tabs = {};
  for (const a of cast.agents) {
    if (a.from > nowMs) continue;
    const info = agentInfo(a, cast.focus);
    if (!info) continue;
    agents.push(info);
    if (!seenSpace.has(a.space)) { seenSpace.add(a.space); spaces.push({ id: a.space, name: a.spaceName }); }
    if (!tabs[a.tab]) tabs[a.tab] = { working_since: null };
    for (const s of a.subs) {
      if (s.status === "gone") continue;
      const st = s.status === "done" ? "idle" : s.status; // terminals(): "done" reads as idle for sub-agents
      subagents.push({ address: s.address, parent: a.address, status: st, title: s.titles[s.titleIdx % s.titles.length], program: s.program });
    }
  }
  return {
    nowMs, tzOffsetMin: cast.tzOffsetMin, weekday: weekdayOf(nowMs, cast.tzOffsetMin), windowActive: cast.windowActive,
    focusedTerminal: cast.focus, agents, subagents, tabs, spaces,
  };
}

/**
 * Drives world.tick from the world's clock up to toMs: steps of at most `maxStep` seconds (5 = the
 * catch-up limit, so no time is dropped) that end exactly where a scripted status changes. The cast
 * moves with the clock. onTick(world, snap, res) runs after every tick call.
 * @returns {number} the new now (toMs)
 */
export function runCast(world, cast, toMs, opts = {}) {
  const maxStep = Math.max(1, Math.min(T.maxCatchUpTicks, opts.maxStep || T.maxCatchUpTicks));
  let now = world.state.herd.lastMs;
  while (now + SEC <= toMs) {
    let step = Math.min(maxStep, Math.floor((toMs - now) / SEC));
    const next = untilChange(cast);
    if (next >= 1 && next < step) step = Math.floor(next);
    if (step < 1) step = 1;
    advanceCast(cast, step);
    now += step * SEC;
    const snap = castSnapshot(cast, now);
    const res = tick(world, snap);
    if (opts.onTick) opts.onTick(world, snap, res);
  }
  return now;
}

// ---------------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------------

/**
 * A task loop: working `workMin` minutes (with an optional blocked stretch in the middle), then
 * done for `doneSec`, then idle (the person saw it) for `idleSec`.
 */
export function taskPlan(workMin, { doneSec = 40, idleSec = 50, blockedSec = 0 } = {}) {
  const w = Math.round(workMin * 60);
  const plan = [];
  if (blockedSec > 0) {
    plan.push(["working", Math.floor(w / 2)], ["blocked", blockedSec], ["working", w - Math.floor(w / 2)]);
  } else {
    plan.push(["working", w]);
  }
  if (doneSec > 0) plan.push(["done", doneSec]);
  if (idleSec > 0) plan.push(["idle", idleSec]);
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Demo worlds
// ---------------------------------------------------------------------------------------------

/** Demo world kinds. */
export const DEMO_KINDS = ["empty", "first-day", "mid", "boss", "late", "idle", "blocked", "calm"];

const SEED = 20261124;
const PROGS = ["claude", "codex", "pi", "opencode", "gemini", "cursor"];

// Signature tasks that steer the class a hero gets at Lv 10 (D§4.2).
const CLASS_TASKS = {
  refactorer: { minutes: 24, blocks: 0, spawned: false },
  hotfixer: { minutes: 4, blocks: 0, spawned: false },
  shellmancer: { minutes: 9, blocks: 0, spawned: false },
  forkbinder: { minutes: 10, blocks: 0, spawned: true },
  rubberducker: { minutes: 9, blocks: 2, spawned: false },
};

function silentEv() {
  return { fx() {}, note() {}, banner() {}, major() {}, journal() {} };
}

// Total XP from Lv 1 to Lv L.
function xpTo(L) {
  let s = 0;
  for (let l = 1; l < L; l++) s += need(l);
  return s;
}

/**
 * Brings a bound hero to level L with class `cls` the way play would: signature tasks (D§4.2),
 * then grantXP level-ups (skill points, auto-learn, class at Lv 10), reviews won when due, and a
 * kit of rolled items around its level (rarity `rar`, polish `pol`).
 */
function grow(world, hero, { L, cls, rar = 1, pol = 0, reviews = true, keepsake = -1, prov = false }) {
  const { state } = world;
  const task = CLASS_TASKS[cls] || CLASS_TASKS.shellmancer;
  // prov: fewer than the 15 qualifying tasks that lock a class, so it stays provisional (D§4.2)
  for (let k = 0, n = prov ? 9 : 16; k < n; k++) recordTask(hero, task);
  const ev = silentEv();
  if (L > hero.L) grantXP(state, hero, xpTo(L) - xpTo(hero.L) - hero.xp + Math.floor(need(L) * 0.37), ev);
  if (cls && CLASS_IDX[cls] != null && hero.cls !== CLASS_IDX[cls] && hero.L >= 10) setClass(state, hero, CLASS_IDX[cls]);
  if (reviews && hero.L >= REVIEWS[0].level) winReview(hero, 0);
  if (reviews && hero.L >= REVIEWS[1].level) winReview(hero, 1);
  autoLearn(hero);
  const ilvl = Math.max(1, hero.L - 2);
  for (let s = 0; s < SLOTS.length; s++) {
    const it = rollItem(hero, { ilvl, source: "chest", slot: SLOTS[s], classId: hero.cls, rar, state });
    it.pol = Math.min(pol, polishMax(rar));
    it.flags = 0;
    equipItem(state, hero, it);
  }
  if (keepsake >= 0) {
    const ks = rollKeepsake(hero, { bossIdx: keepsake, ilvl: BOSSES[keepsake].level, classId: hero.cls, state });
    stashPut(state, ks);
  }
  hero.st.kills += Math.round(hero.L * hero.L * 9);
  hero.st.tasks += 16;
  hero.st.seals += Math.round(hero.L * 1.6);
  hero.st.wh += hero.L * 0.9;
  return hero;
}

// The herd after `zones` boss kills (what boss.js / herd.js record on a herd-first kill): trophies,
// kill counts, quotas, the first-clear dates (a boss a day, the last one yesterday) and the
// journal lines of the kills, older than everything the cast has logged since.
function clearZones(world, zones, { kills = 2 } = {}) {
  const { state, rt } = world;
  const herd = state.herd;
  const now = rt.nowMs || herd.lastMs || 0;
  const lines = [];
  for (let z = 0; z < zones; z++) {
    herd.boss[z] = 1;
    herd.bossKills[z] = Math.max(1, kills - (z > zones - 3 ? 1 : 0));
    for (const m of ZONES[z].maps) herd.quota[m.id] = T.quotaPerMap;
    herd.bt[z] = 600 + 1900 * (zones - z);
    const at = now - (zones - z) * DAY_MS + 3600000 * (9 + (z % 5));
    noteFirstClear(state, z, at);
    lines.push([at, "boss", 0, `${BOSSES[z].name} FIXED`, z]);
    for (let k = 1; k < herd.bossKills[z]; k++) lines.push([at + k * 7200000, "boss", 0, `${BOSSES[z].name} fixed again`, z]);
  }
  lines.sort((a, b) => a[0] - b[0]);
  herd.log = lines.concat(herd.log || []).slice(-logMax(state));
  herd.zone = zones >= ZONES.length ? BACKLOG.n : zones;
  if (zones >= ZONES.length) herd.backlog = { floor: 1, kills: 0 };
  herd.meter = 0;
  // credited here, not by a fight: world.tick must not journal them again
  rt.bossSeen = herd.bossKills.slice();
}

function boundHeroes(world) {
  return liveHeroes(world).map((p) => p[0]);
}

// Runs the cast, remembers it for demoSnapshot(), returns {world, snapshot}.
function finish(world, cast, nowMs, { lead = 0 } = {}) {
  runCast(world, cast, nowMs - lead);
  if (lead > 0) runCast(world, cast, nowMs);
  world.rt.demo = { cast };
  return { world, snapshot: castSnapshot(cast, nowMs) };
}

// A world created `ago` ms before nowMs whose agents first appear in a snapshot at that moment.
function start(nowMs, ago, cast) {
  const t0 = nowMs - ago;
  const world = createWorld({ nowMs: t0, seed: SEED });
  if (cast) runCast(world, cast, t0 + SEC);
  return world;
}

function agentsFor(n, plans, { space = "spc_1", spaceName = "herdr-app", start: offs } = {}) {
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push(makeAgent({
      address: `t${k + 1}`, program: PROGS[k % PROGS.length], space, spaceName, tab: `tab_${1 + (k >> 2)}`,
      tabIndex: k >> 2, tabName: k < 4 ? "main" : "api", paneName: null, plan: plans[k % plans.length],
      start: offs ? offs[k % offs.length] : 0, titleIdx: k * 3,
    }));
  }
  return out;
}

const KINDS = {
  // A fresh herd and no agents: the empty stage (D§10.2 Localhost).
  empty(nowMs) {
    const world = createWorld({ nowMs: nowMs - 10 * SEC, seed: SEED });
    const cast = makeCast([]);
    return finish(world, cast, nowMs);
  },

  // Three agents in one repo, ~22 minutes in: Interns in Lint Meadows, one chest waiting.
  "first-day"(nowMs) {
    const plans = [taskPlan(6, { doneSec: 60, idleSec: 45 }), taskPlan(8, { doneSec: 300, idleSec: 40 }), taskPlan(5, { doneSec: 30, idleSec: 60 })];
    const cast = makeCast(agentsFor(3, plans, { start: [0, 120, 240] }));
    const world = start(nowMs, 22 * 60 * SEC, cast);
    return finish(world, cast, nowMs);
  },

  // Six heroes in zone 3 across two spaces and three maps, mixed states, effects in flight.
  mid(nowMs) {
    const plans = [
      [["working", 1800], ["done", 60]], [["working", 900], ["blocked", 120], ["working", 600]],
      [["working", 2400]], [["working", 300], ["done", 400], ["idle", 200]], [["working", 1200]], [["idle", 900], ["working", 900]],
    ];
    // t2 is blocked at nowMs (bubble up); t5, the Forkbinder, has two sub-agents (Forklings)
    const a = agentsFor(4, plans.slice(0, 4), { start: [0, 780, 0, 320] });
    const b = agentsFor(2, plans.slice(4), { space: "spc_2", spaceName: "api-gateway" }).map((x, i) => {
      x.address = `t${5 + i}`;
      x.pane = `p_t${5 + i}`;
      return x;
    });
    b[0].pinned = true;
    b[0].subs.push(
      makeAgent({ address: "s5a", program: b[0].program.key, plan: [["working", 1e9]], titles: ["Run the test shard"] }),
      makeAgent({ address: "s5b", program: b[0].program.key, plan: [["working", 120], ["blocked", 1e9]], titles: ["Ask about the schema"] }),
    );
    const cast = makeCast(a.concat(b), { focus: "t2" });
    const world = start(nowMs, 3 * 60 * SEC, cast);
    clearZones(world, 2);
    const spec = [
      { L: 33, cls: "refactorer", rar: 2, pol: 3 }, { L: 31, cls: "hotfixer", rar: 2, pol: 2 },
      { L: 30, cls: "shellmancer", rar: 2, pol: 2 }, { L: 29, cls: "rubberducker", rar: 1, pol: 3 },
      { L: 26, cls: "forkbinder", rar: 1, pol: 2 }, { L: 24, cls: "shellmancer", rar: 1, pol: 1, prov: true },
    ];
    const heroes = boundHeroes(world);
    heroes.forEach((h, i) => grow(world, h, Object.assign({ keepsake: i < 2 ? i : -1 }, spec[i])));
    const herd = world.state.herd;
    addGold(world.state, 184000);
    addSnippets(world.state, 420);
    herd.quota["3-1"] = 40;
    herd.quota["3-2"] = 17;
    herd.meter = 11.5;
    herd.bld = [2, 2, 1, 2, 1, 0];
    herd.born = herd.day - 11; // the herd's day 12 (Campfire 2 opens on day 12, herd.buildingGate)
    seedReleases(world, 64);
    for (const id of ["first_commit", "fixed_it"]) awardBadge(world, id, null);
    return finish(world, cast, nowMs);
  },

  // A boss fight in progress: The Octopus Merge (tentacle parts), a trio on level, ~25 ticks in.
  boss(nowMs) {
    const plans = [[["working", 7200]]];
    const cast = makeCast(agentsFor(3, plans), { focus: "t1" });
    const world = start(nowMs, 4 * 60 * SEC, cast);
    clearZones(world, 3);
    const herd = world.state.herd;
    for (const m of ZONES[3].maps) herd.quota[m.id] = T.quotaPerMap;
    herd.meter = T.sprint[3];
    herd.born = herd.day - 13; // the herd's day 14
    const spec = [{ L: 46, cls: "refactorer" }, { L: 45, cls: "shellmancer" }, { L: 45, cls: "rubberducker" }];
    boundHeroes(world).forEach((h, i) => grow(world, h, Object.assign({ rar: 2, pol: 4 }, spec[i])));
    seedReleases(world, 140);
    for (const h of boundHeroes(world)) h.pinMap = "4-3";
    // walk in with Auto-boss off, then challenge by hand (the door is open: 40 kills on 4-3 and a
    // full Sprint meter) so the fight is ~25 ticks old at nowMs
    const auto = herd.cfg.auto;
    auto.boss = false;
    runCast(world, cast, nowMs - 25 * SEC);
    command(world, "challenge", { kind: "boss", idx: 3 }, nowMs - 25 * SEC);
    auto.boss = true;
    return finish(world, cast, nowMs);
  },

  // Fourteen heroes (overflow), late zones and the Backlog open, a rich stash and many badges.
  // The roster grows over three days (at most 6 new heroes a day, D§3.4).
  late(nowMs) {
    const plans = [
      [["working", 3000]], [["working", 1500], ["done", 300]], [["working", 600], ["blocked", 90], ["working", 900]],
      [["idle", 600], ["working", 1200]], [["working", 2000], ["done", 120], ["idle", 200]],
    ];
    const n = 14;
    const t0 = nowMs - 2 * DAY_MS - 3 * 60 * SEC;
    const ags = agentsFor(n, plans, { start: [0, 400, 800, 1200, 1600] });
    for (let k = 0; k < n; k++) {
      if (k >= 8) { ags[k].space = "spc_2"; ags[k].spaceName = "infra"; }
      if (k === 0 || k === 9) ags[k].pinned = true;
      ags[k].from = k < 6 ? 0 : k < 12 ? t0 + DAY_MS : t0 + 2 * DAY_MS;
    }
    const cast = makeCast(ags, { focus: "t3" });
    const world = createWorld({ nowMs: t0, seed: SEED });
    runCast(world, cast, t0 + SEC);
    for (const d of [1, 2]) { // the app reopens on the next two days (offline gaps: no combat)
      advanceCast(cast, (t0 + d * DAY_MS - world.state.herd.lastMs) / SEC);
      tick(world, castSnapshot(cast, t0 + d * DAY_MS));
    }
    // the last minutes: most agents work, two wait on the person, two shipped, two rest
    const finalStatus = ["working", "working", "blocked", "working", "done", "working", "idle", "working", "working", "blocked", "working", "done", "idle", "working"];
    cast.agents.forEach((ag, k) => {
      const st = finalStatus[k % finalStatus.length];
      ag.plan = st === "working" ? [["working", 1e9]] : [["working", 30 + 8 * k], [st, 1e9]];
      ag.phase = 0;
      ag.left = ag.plan[0][1];
      if (ag.status !== "working") { ag.status = "working"; ag.seq++; }
    });
    clearZones(world, 9, { kills: 6 });
    const herd = world.state.herd;
    herd.backlog = { floor: 14, kills: 23 };
    const classes = ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"];
    boundHeroes(world).forEach((h, i) => {
      const L = i < 3 ? 100 : 97 - i * 4;
      grow(world, h, { L, cls: classes[i % classes.length], rar: i < 3 ? 4 : 3, pol: 7, keepsake: i < 9 ? i : -1 });
    });
    herd.bld = [9, 8, 7, 8, 6, 5]; // vendor/ 8: 120 stash slots
    herd.born = herd.day - 64; // a herd of two months: every Campfire level is open
    // a rich stash: drops from the late zones
    const finder = boundHeroes(world)[0];
    for (let k = 0; k < 60; k++) {
      const it = rollItem(finder, { ilvl: 70 + (k % 30), source: k % 7 === 0 ? "boss" : "chest", classId: finder.cls, state: world.state });
      if (k % 9 === 0) it.flags |= 1;
      stashPut(world.state, it);
    }
    addGold(world.state, 48000000);
    addSnippets(world.state, 26000);
    seedReleases(world, 2900);
    for (let k = 0; k < BADGES.length; k++) if (k % 4 !== 3) awardBadge(world, BADGES[k].id, null);
    return finish(world, cast, nowMs);
  },

  // Everyone resting: agents idle, campfires, Fresh Eyes filling.
  idle(nowMs) {
    const plans = [[["working", 900], ["done", 30], ["idle", 3600]], [["working", 700], ["idle", 3600]], [["working", 500], ["done", 3600]]];
    const cast = makeCast(agentsFor(4, plans, { start: [0, 60, 120] }));
    const world = start(nowMs, 30 * 60 * SEC, cast);
    clearZones(world, 1);
    boundHeroes(world).forEach((h, i) => grow(world, h, { L: 16 + i, cls: ["shellmancer", "hotfixer", "refactorer", "rubberducker"][i], rar: 1, pol: 1 }));
    return finish(world, cast, nowMs);
  },

  // Blocked-heavy: most agents waiting on the person, bubbles up, one working.
  blocked(nowMs) {
    const plans = [
      [["working", 300], ["blocked", 3600]], [["working", 420], ["blocked", 3600]], [["working", 3600]],
      [["working", 200], ["blocked", 3600]], [["working", 600], ["blocked", 3600]],
    ];
    const cast = makeCast(agentsFor(5, plans));
    const world = start(nowMs, 15 * 60 * SEC, cast);
    clearZones(world, 1);
    boundHeroes(world).forEach((h, i) => grow(world, h, { L: 18 + i, cls: ["rubberducker", "shellmancer", "hotfixer", "rubberducker", "refactorer"][i], rar: 1, pol: 1 }));
    return finish(world, cast, nowMs);
  },

  // Calm mode on (D§11.15): the "mid" herd with calm, numbers off.
  calm(nowMs) {
    const r = KINDS.mid(nowMs);
    command(r.world, "setting", { key: "calm", value: true }, nowMs);
    command(r.world, "setting", { key: "nums", value: "off" }, nowMs);
    return r;
  },
};

// Cumulative Seals as the Release Train would hold them.
function seedReleases(world, seals) {
  const herd = world.state.herd;
  herd.seals = seals;
  let r = 0;
  while (r < T.release.maxRelease && Math.round(8 * Math.pow(r + 1, 1.35)) <= seals) r++;
  herd.rel = r;
}

/**
 * A demo world of the given kind at nowMs (DEMO_KINDS), built by the real engine, plus the host
 * snapshot for that moment. Deterministic for (kind, nowMs).
 * @returns {{world, snapshot}}
 */
export function demoWorld(kind, nowMs) {
  const fn = KINDS[kind];
  if (!fn) throw new Error(`unknown demo world "${kind}" (one of ${DEMO_KINDS.join(", ")})`);
  const now = Math.floor(Number(nowMs) || 0);
  return fn(now);
}

/**
 * The next host snapshot for a demo world at nowMs: its scripted cast moved forward to nowMs (so
 * further world.tick calls keep showing genuine status changes). A world without a cast (e.g.
 * loaded from a save) gets a snapshot of its bound agents as they are.
 */
export function demoSnapshot(world, nowMs) {
  const d = world.rt && world.rt.demo;
  if (d && d.cast) {
    const last = d.at || world.state.herd.lastMs;
    const sec = Math.floor((nowMs - last) / SEC);
    if (sec > 0) advanceCast(d.cast, sec);
    d.at = last + Math.max(0, sec) * SEC;
    return castSnapshot(d.cast, nowMs);
  }
  const agents = [];
  for (const [hero, live] of liveHeroes(world)) {
    if (hero.contractor) continue;
    agents.push({
      address: live.address, status: live.status, seq: live.seq, app: live.app, program: live.program, title: live.title,
      space: live.space, space_name: live.spaceName, tab: live.tab, tab_index: 0, tab_name: live.tabName, pane: live.pane,
      pane_name: live.paneName, pinned: live.pinned, focused: live.focused,
    });
  }
  return {
    nowMs, tzOffsetMin: 0, weekday: weekdayOf(nowMs), windowActive: true, focusedTerminal: null, agents, subagents: [], tabs: {}, spaces: [],
  };
}

export const _internal = { grow, clearZones, xpTo, MAPS };
