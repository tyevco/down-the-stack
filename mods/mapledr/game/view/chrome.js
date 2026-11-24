// View models for the three chrome roles that live in herdr's own UI (ARCHITECTURE §5):
//   partyView(world, {width, nowMs})       -> PartyVM   (ui/party.js, D§11.11)
//   nameplateView(world, {terminal, pane}) -> PlateVM|null (ui/nameplate.js, D§11.12)
//   hudView(world, {nowMs})                -> HudVM     (ui/hud.js)
// Shapes: ARCHITECTURE §5 + the "VM additions" JSDoc at the top of each ui module; the field-by-field
// spec is tools/vm-samples/{party,nameplate,hud}.mjs. Every user-facing string is made here.
//
// Decisions:
//  - Party order is herdr's own order (agents(): space, tab, pane = live.order), grouped by space in
//    the order spaces first appear. Status, focus, pin and level never move a row (D§11.11); in
//    particular a pinned agent does NOT jump to the top here (its pin is the banner on its back and
//    the portrait dot). agentOrder lists the live rows' addresses in exactly this order, so
//    agent.next / agent.prev / agent.select walk the party top to bottom. Off-duty heroes (no live
//    terminal) collapse into one group at the bottom, in stable seat / ordinal / id order.
//  - Crowded parties render slim rows: RowVM.slim is true for live rows when more than SLIM_AT live
//    rows exist (or more than SLIM_AT - 4 in a herd of over 2 × SLIM_AT), and for off-duty rows
//    when live + off-duty rows exceed SLIM_AT (unfolding the off-duty group then stays within the
//    element budget). party.js draws a slim row as one 28 px
//    line with about a third of the elements of a full row.
//  - Durations come from world ticks (blocked clock, quest minutes) or from nowMs rounded down to
//    the minute (off duty since ...), so a VM is a pure function of (world version, compact,
//    minute) and is memoised on exactly that: every redraw of the window within a tick (hover,
//    another copy's notify) reuses it. nameplateView memoises per terminal per world version and
//    finds its hero through a terminal -> [hero, live] index rebuilt once per version (O(1) per
//    pane header). hudView also carries `calm`, so a key command can read it without building a
//    party (ui/party.js chromeCommand).
//  - A boss participant shows its fight only while it is in it (D§9.5): fighting, holding while
//    blocked, or rebooting. A done or idle one has walked out (boss.js keeps it in heroIds until it
//    leaves the roster). The pane header's chip puts the hero's own state first ("! waiting",
//    "rebooting"); only a fighting hero's reads "BOSS 41%".
//
// Pure: no herdr / gpui imports, no Date.now(), no Math.random(); never mutates the world.

import { TUNING as T, PALETTE, MAP_BY_ID, BOSSES, REVIEWS, RARITIES, SKILL_BY_ID, BACKLOG } from "../data.js";
import { fmtNum, fmtDuration, need, K } from "../formulas.js";
import { careerOf, stats } from "../heroes.js";
import { liveHeroes, chestInfo, unblockedActive, unblockedLeft } from "../agents.js";
import { releaseInfo, sprintTarget, digestDot, freshEyesCapMin } from "../herd.js";
import { heroCtx } from "../combat.js";
import { fnv1a32 } from "../rng.js";

/** More live rows than this and the party switches to slim rows. */
export const SLIM_AT = 12;
/** The sidebar rail (herdr's sidebar mods switch at this width). */
const RAIL_PX = 160;
/** The blocked clock tag starts counting after 120 s (D§11.10). */
const CLOCK_AFTER_SEC = 120;
/** A row's star for a new LTS or Keepsake drop lasts 60 s (D§11.8). */
const STAR_MS = 60000;
const MAX_CHIPS = 4;

const COL = {
  working: PALETTE.working, blocked: PALETTE.blocked, done: PALETTE.done, idle: PALETTE.idle,
  hp: PALETTE.hp, xp: PALETTE.xp, fresh: PALETTE.freshEyes,
};
const STATUS_COLOR = { working: COL.working, blocked: COL.blocked, done: COL.done, idle: COL.idle };
const STATUSES = { working: 1, blocked: 1, done: 1, idle: 1 };
// Lookups keyed by strings from herdr (status words, program keys) go through own(): a key named
// like an Object.prototype member ("constructor", "toString", "__proto__") must not hit it.
const own = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
// D§9.5: a boss participant that goes idle or done walks out of the fight (it may rejoin); a
// blocked one holds in the arena and a crashed one rejoins, so those two still show the fight.
const WALKED_OUT = { shipped: 1, resting: 1, off: 1 };
const FIGHTING = { questing: 1, supervising: 1 };

// Termling look per hero state (D§11.1 faces; the face ink is the status colour).
const FACE = { questing: ">_", waiting: "o_o", shipped: "^_^", resting: "-_-", supervising: ">_", crashed: ":(", off: "-_-" };
const INK = {
  questing: COL.working, waiting: COL.blocked, shipped: COL.done, resting: COL.idle, supervising: COL.working,
  crashed: COL.hp, off: COL.idle,
};
const SCREEN = "#17161F";
// Title-bar tints (D§2.8: an 8-colour palette, unknown program keys hashed into it). Dark, so both
// full-colour and white tinted program icons read on them.
const TITLE_BARS = ["#3B2A24", "#3A3F4B", "#2F5D8C", "#3D3357", "#2E3A36", "#4A3A22", "#24404A", "#45303C"];
const TITLE_BAR_OF = { claude: 0, codex: 1, pi: 2, gemini: 3, opencode: 4, cursor: 5, copilot: 6, amp: 7 };

// herdr's shipped agent programs (defaults/programs.json): icon and tint, for off-duty heroes whose
// program no live agent shows right now (live Program records always win: users can edit theirs).
const TINTED = 1;
const AGENT_ICONS = {
  claude: 0, codex: 0, pi: TINTED, pig: 0, opencode: TINTED, cursor: TINTED, copilot: TINTED, amp: 0, grok: TINTED,
  "dsh-tui": TINTED, goose: TINTED, antigravity: 0, kimi: 0, kiro: 0, hermes: TINTED, mastracode: TINTED, qoder: TINTED,
  muse: TINTED, crush: 0, "command-code": TINTED, "prime-agent": TINTED, gemini: TINTED, ollama: TINTED, omp: TINTED,
  agent: TINTED,
};

const isHex = (s) => typeof s === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s);
const str = (v, dflt = "") => (v == null ? dflt : String(v));
const num = (v, dflt = 0) => (Number.isFinite(v) ? v : dflt);
const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const pct = (x) => `${Math.round(num(x) * 100)}%`;
const plural = (n, one, many) => (n === 1 ? one : many || `${one}s`);

/** 1,204 for numbers below a million, else the compact D§11.7 form. */
function fmtInt(n) {
  const v = Math.round(num(n));
  if (Math.abs(v) >= 1e6) return fmtNum(v);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Minutes as "42m" / "3h 12m" ("0m" under one minute). */
function fmtMin(min) {
  const m = Math.floor(num(min));
  return m < 1 ? "0m" : fmtDuration(m * 60);
}

// ---------------------------------------------------------------------------------------------
// Small shared helpers (exported so the stage and panel views can draw the same Termling and bars)
// ---------------------------------------------------------------------------------------------

/** herdr's status word, unknown statuses as idle (D§2.10). */
export function statusWord(s) {
  return own(STATUSES, s) ? s : "idle";
}

/** ProgramIcon {path, tint, color} from herdr's Program record, or null. */
export function programIconOf(program) {
  if (!program || typeof program.icon !== "string" || !program.icon) return null;
  return { path: program.icon, tint: !!program.tint, color: isHex(program.color) ? program.color : "#ffffff" };
}

/** Title-bar tint for a program key (D§2.8); always one of TITLE_BARS (or the neutral bar). */
export function titleBarOf(programKey) {
  if (!programKey) return "#33384A";
  const key = String(programKey);
  const i = own(TITLE_BAR_OF, key) ? TITLE_BAR_OF[key] : fnv1a32(key) % TITLE_BARS.length;
  return TITLE_BARS[i] || "#33384A";
}

/** HeroVM.colors for a hero in a state ("questing" ... "crashed", or "off" for off duty). */
export function termlingColors(hero, programKey, state) {
  const tints = PALETTE.termlingTint;
  const id = Math.abs(Math.round(num(hero && hero.id, 1)));
  return {
    hoodie: tints[(((id - 1) % tints.length) + tints.length) % tints.length],
    titleBar: titleBarOf(programKey),
    screen: SCREEN,
    faceInk: INK[state] || COL.idle,
  };
}

/** The Termling's face glyph for a state. */
export function faceOf(state) {
  return FACE[state] || "-_-";
}

/** XP bar fill (1 at the level cap). */
export function xpFracOf(hero) {
  if (!hero || hero.L >= T.levelCap) return 1;
  const n = need(hero.L);
  return n > 0 ? clamp01(num(hero.xp) / n) : 0;
}

/**
 * The Fresh Eyes segment after the XP fill: the share of this level the pool will still add as
 * bonus XP at on-level pace (pool minutes x the extra x0.5 x 15.5 kills per minute / K(L) kills
 * per level), never past the end of the bar.
 */
export function feFracOf(hero, xpFrac) {
  const fe = num(hero && hero.fe);
  if (!(fe > 0) || hero.L >= T.levelCap) return 0;
  const k = K(hero.L);
  const share = k > 0 ? (fe * (T.freshEyes.xpMult - 1) * T.refKillsPerMin) / k : 0;
  return Math.max(0, Math.min(1 - clamp01(xpFrac), share));
}

function shiftText(why) {
  const band = why.shiftBand || 0;
  const next = why.nextBandMin;
  const until = next != null ? `${Math.round(next / 60)}h` : "the 04:00 reset";
  const what = band === 0 ? "full rate" : `kill rewards ×${why.shiftKill}`;
  return `${fmtMin(why.shiftMin)} today (${what} until ${until})`;
}

/**
 * The D§2.9 "why" line from agents.whyOf numbers, e.g. "+512 XP/min = working ×1 · Fresh Eyes ×1.5
 * · Party +12% · Herd +23% · Shift: 3h 12m today (full rate until 4h)". opts.shift false leaves the
 * Shift part out (the nameplate shows it on its own line).
 */
export function whyLine(why, opts = {}) {
  if (!why) return "";
  const shift = opts.shift !== false;
  const st = why.state;
  if (st === "waiting") return "Waiting for you: no XP while blocked (it never costs anything)";
  if (st === "shipped" || st === "resting" || st === "off") {
    const base = st === "off" ? "Off duty" : st === "shipped" ? "Shipped" : "Resting";
    const fe = why.feMin >= why.feCap && why.feCap > 0 ? `Fresh Eyes full (${fmtMin(why.feCap)})` : "Fresh Eyes builds up (1 min per 4)";
    return `${base}: no XP, ${fe}${shift && st !== "off" ? ` · Shift: ${shiftText(why)}` : ""}`;
  }
  const parts = [`working ×${why.working}`];
  if (why.freshEyes > 1) parts.push(`Fresh Eyes ×${why.freshEyes}`);
  if (why.party > 0) parts.push(`Party +${pct(why.party)}`);
  if (why.banner > 0) parts.push(`Banner +${pct(why.banner)}`);
  if (why.herd > 0) parts.push(`Herd +${pct(why.herd)}`);
  if (why.unblocked > 0) parts.push(`Unblocked +${pct(why.unblocked)}`);
  if (why.onboarding > 0) parts.push(`Onboarding +${pct(why.onboarding)}`);
  if (why.gear > 0) parts.push(`Gear +${pct(why.gear)}`);
  if (why.crowding < 1) parts.push(`Crowding ×${Math.round(why.crowding * 100) / 100}`);
  if (shift) parts.push(`Shift: ${shiftText(why)}`);
  if (why.flapPaused) parts.push("chests paused (the status is flapping)");
  return `+${fmtInt(why.xpPerMin)} XP/min = ${parts.join(" · ")}`;
}

// ---------------------------------------------------------------------------------------------
// Per-version index: what every chrome view needs, built once per world version
// ---------------------------------------------------------------------------------------------

let INDEX = null;

function buildIndex(world) {
  const rt = world.rt;
  const herd = world.state.herd;
  const pairs = liveHeroes(world);
  const byAddr = new Map();
  const programs = new Map(); // program key -> Program, for off-duty portraits
  for (const p of pairs) {
    byAddr.set(p[1].address, p);
    const prog = p[1].program;
    if (prog && prog.key && !programs.has(prog.key)) programs.set(prog.key, prog);
  }
  // live rows in herdr's own order (stable: status never moves them)
  const ordered = pairs.slice().sort((a, b) => num(a[1].order) - num(b[1].order) || a[0].id - b[0].id);
  const fights = new Map();
  for (const f of rt.fights || []) {
    for (const id of (f.heroIds || []).concat(f.helpers || [])) if (!fights.has(id)) fights.set(id, f);
  }
  const levelUp = new Map();
  for (const f of rt.fx || []) {
    if (f.kind !== "levelup" || f.heroId == null) continue;
    const age = rt.tick - num(f.bornTick, rt.tick);
    if (age >= 0 && age <= 1 && !(levelUp.get(f.heroId) <= age)) levelUp.set(f.heroId, age);
  }
  const drops = new Map(); // heroId -> newest LTS / Keepsake drop of the last 60 s
  const log = herd.log || [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (!e || !(rt.nowMs - num(e[0]) <= STAR_MS)) break;
    if (e[1] === "drop" && e[4] >= 4 && e[2] && !drops.has(e[2])) drops.set(e[2], { text: str(e[3]), rar: e[4] });
  }
  const counts = { working: 0, blocked: 0, done: 0 };
  for (const [, live] of pairs) {
    const s = statusWord(live.status);
    if (s in counts) counts[s]++;
  }
  return { rt, version: rt.version, pairs: ordered, byAddr, programs, fights, levelUp, drops, counts, sprint: sprintOf(world) };
}

function indexOf(world) {
  const rt = world.rt;
  if (!INDEX || INDEX.rt !== rt || INDEX.version !== rt.version) INDEX = buildIndex(world);
  return INDEX;
}

/** Sprint meter of the frontier zone (or Backlog floor progress): {label, have, need} | null. */
function sprintOf(world) {
  const herd = world.state.herd;
  const zone = num(herd.zone);
  const target = sprintTarget(zone);
  if (target > 0) {
    const boss = BOSSES[zone];
    const have = Math.min(target, Math.floor(num(herd.meter) + 1e-9));
    return { label: boss ? boss.name : `Zone ${zone + 1} boss`, have, need: target };
  }
  if (zone >= BACKLOG.n && herd.backlog) {
    const floor = Math.max(1, num(herd.backlog.floor, 1));
    const need = BACKLOG.killsPerFloor;
    return { label: `The Backlog, floor ${floor}`, have: Math.min(need, Math.floor(num(herd.backlog.kills))), need };
  }
  return null;
}

function footerOf(world, idx) {
  const herd = world.state.herd;
  return {
    gold: fmtNum(num(herd.gold)),
    snippets: fmtNum(num(herd.snip)),
    release: str(releaseInfo(world.state).label, "v0.0"),
    sprint: idx.sprint ? Object.assign({}, idx.sprint) : null,
    digestDot: digestDot(world),
  };
}

// ---------------------------------------------------------------------------------------------
// One hero: the facts every chrome view reads
// ---------------------------------------------------------------------------------------------

function mapLabelOf(world, live) {
  const id = live && live.mapId;
  if (!id) return "";
  if (id === BACKLOG.id) {
    const f = num(live.floor) || num(world.state.herd.backlog && world.state.herd.backlog.floor, 1);
    return `Backlog floor ${Math.max(1, f)}`;
  }
  const m = MAP_BY_ID[id];
  return m ? `${m.id} ${m.name}` : str(id);
}

function shortMap(world, live) {
  const id = live && live.mapId;
  if (!id) return "";
  if (id === BACKLOG.id) return `floor ${Math.max(1, num(live.floor) || num(world.state.herd.backlog && world.state.herd.backlog.floor, 1))}`;
  return str(id);
}

/** Boss pool left, 0..1 (body, heads and services; tentacles and adds do not count). */
function fightLeft(f) {
  let hp = 0;
  let max = 0;
  for (const p of f.parts || []) {
    if (p.kind !== "boss" && p.kind !== "head" && p.kind !== "service") continue;
    hp += Math.max(0, num(p.hp));
    max += Math.max(0, num(p.maxHp));
  }
  const pool = num(f.pool) > 0 ? f.pool : max;
  return pool > 0 ? clamp01(hp / pool) : 0;
}

/** "Fighting The Octopus Merge: 41% left" / "Senior Review against You, Six Months Ago: 41% left". */
function fightLine(f) {
  if (f.kind === "review") {
    const r = REVIEWS[f.reviewIdx];
    const title = r && r.reward && r.reward.title ? `${r.reward.title} Review` : "Promotion review";
    return `${title} against ${str(f.name, "the reviewer")}: ${leftPct(f)}% left`;
  }
  return `Fighting ${str(f.name, "the boss")}: ${leftPct(f)}% left`;
}

const leftPct = (f) => {
  const l = fightLeft(f);
  return l > 0 ? Math.max(1, Math.ceil(l * 100)) : 0;
};

function machineOf(address) {
  const a = str(address);
  const i = a.indexOf("/");
  return i > 0 ? a.slice(0, i) : null;
}

function blockedSec(rt, live) {
  if (live.blockedSince != null) return Math.max(0, rt.tick - live.blockedSince);
  return num(live.blockedTicks);
}

function chestSummary(hero) {
  const pend = hero.pend || [];
  if (!pend.length) return null;
  let seals = 0;
  let best = null;
  let title = "";
  for (const p of pend) {
    const c = chestInfo(p);
    seals += c.seals;
    if (!best || c.raw > best.raw) best = c;
    if (c.title) title = c.title;
  }
  const tier = best ? best.tier.charAt(0).toUpperCase() + best.tier.slice(1) : "Wooden";
  return { n: pend.length, seals, tier, title };
}

/** Everything about one live hero that rows, plates and tooltips share. */
function heroFacts(world, idx, hero, live) {
  const rt = world.rt;
  const state = live ? live.state || "resting" : "off";
  const career = careerOf(hero);
  const xpFrac = xpFracOf(hero);
  const listed = idx.fights.get(hero.id) || null;
  // boss.js keeps a participant in heroIds after it walks out; the chrome shows the fight only
  // while the hero is in it (fighting, holding while blocked, or rebooting)
  const fight = listed && !WALKED_OUT[state] ? listed : null;
  return {
    state, career, xpFrac, feFrac: feFracOf(hero, xpFrac), fight,
    status: live ? statusWord(live.status) : "idle",
    hpFrac: live ? (num(live.maxHp) > 0 ? clamp01(num(live.hp) / live.maxHp) : 1) : clamp01(num(hero.hpFrac, 1)),
    blocked: live && state === "waiting" ? blockedSec(rt, live) : 0,
    chest: chestSummary(hero),
    // agents.stepStatus refreshes live.why every 5 ticks (null only until a new hero's first tick)
    why: live ? live.why || null : null,
  };
}

// What an agent puts before its title: a status glyph or spinner and the separator after it
// ("✳ Fix flaky auth test", "⠋ - Thinking", Codex's "[ ! ] "). herdr's agents list strips the same
// (defaults/mods/agents/main.js clean()); its regex, so titles read alike in both.
const TITLE_MARK = /^(?:\[ [!.] \] |[✋⏳]\uFE0F?(?=\s)|(?!(?:\p{Emoji}\uFE0F|[#*]\u20E3))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u;

/** The terminal's task as the tooltips name it: the engine's quest title, else the terminal title. */
function taskTitle(live) {
  const task = live.task;
  const raw = task && task.title ? str(task.title) : str(live.title);
  return raw.replace(TITLE_MARK, "").trim() || raw.trim();
}

/** "Waiting for you for 2m on “Bump deps and fix types”". */
function waitLine(live, f) {
  const title = taskTitle(live);
  return `Waiting for you for ${fmtDuration(f.blocked)}${title ? ` on “${title}”` : ""}`;
}

/** A blocked or crashed participant's fight (it holds, or rejoins after the reboot; D§9.5). */
function holdLine(f) {
  if (!f.fight || FIGHTING[f.state]) return "";
  return `${fightLine(f.fight)} · ${f.state === "waiting" ? "holding until you answer" : "rejoins after the reboot"}`;
}

/** The quest line; opts.row adds the party row's click hint to the waiting line. */
function questLine(world, hero, live, f, opts = {}) {
  const rt = world.rt;
  const fight = f.fight;
  if (fight && FIGHTING[f.state]) return fightLine(fight);
  const task = live.task;
  const title = taskTitle(live);
  switch (f.state) {
    case "waiting": return `${waitLine(live, f)}${opts.row ? " · click to jump there" : ""}`;
    case "crashed": return `Rebooting: back in ${Math.max(1, num(live.crashedUntil) - rt.tick)}s`;
    case "supervising": {
      const n = (live.forklings || []).filter((x) => x.status === "working").length;
      return `Supervising ${n} ${plural(n, "Forkling")}`;
    }
    case "shipped":
      if (f.chest) return `Shipped: ${f.chest.title || title || "Commit"} · ${f.chest.seals.toFixed(1)} Seals · ${f.chest.tier} chest`;
      return `Shipped${title ? `: ${title}` : ""}`;
    case "resting": return "Resting at the campfire";
    default:
      if (task && task.title) return `Quest: ${title} (${fmtDuration(num(task.workSec))})`;
      return `Questing in ${mapLabelOf(world, live) || "the Stack"}`;
  }
}

function forkLine(live) {
  const list = live.forklings || [];
  if (!list.length) return "";
  const shown = list.slice(0, 3).map((x) => `${x.title ? x.title : "sub-agent"} (${x.status})`);
  const more = list.length > 3 ? ` +${list.length - 3}` : "";
  return `${list.length} ${plural(list.length, "Forkling")}: ${shown.join(", ")}${more}`;
}

/** The sub-agent a Forkling chip jumps to: the first blocked one, else the first working, else the first. */
function forkTarget(live) {
  const list = live.forklings || [];
  return (list.find((x) => x.status === "blocked") || list.find((x) => x.status === "working") || list[0] || {}).address || null;
}

function buffLine(live) {
  const ct = num(live.ct);
  const parts = [];
  for (const b of live.buffs || []) {
    if (!(b.until > ct)) continue;
    const name = b.id === "unblocked" ? "Unblocked" : SKILL_BY_ID[b.id] ? SKILL_BY_ID[b.id].name
      : str(b.id).replace(/_room$/, "").replace(/_/g, " ");
    parts.push(`${name} ${fmtDuration(b.until - ct)}`);
  }
  return parts.length ? `Buffs: ${parts.join(" · ")}` : "";
}

function headLine(hero, f, live) {
  const contractor = hero.contractor ? " (contractor)" : "";
  const machine = live ? machineOf(live.address) : null;
  return `${str(hero.name, "Termling")}${contractor} · Lv ${hero.L} ${f.career.title}${machine ? ` · on ${machine}` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Party (D§11.11)
// ---------------------------------------------------------------------------------------------

function unblockedLine(hero, tick) {
  const U = T.unblocked;
  const what = U.dmg === U.xp ? `+${pct(U.dmg)} damage and XP` : `+${pct(U.dmg)} damage, +${pct(U.xp)} XP`;
  return `Unblocked: ${what} for ${fmtDuration(unblockedLeft(hero, tick))} of questing`;
}

const chip = (heroId, kind, text, color, extra) => Object.assign({ key: `c:${heroId}:${kind}`, kind, text, color }, extra || {});

function liveChips(world, idx, hero, live, f) {
  const rt = world.rt;
  const urgent = [];
  const rest = [];
  if (f.state === "waiting") {
    const t = f.blocked >= CLOCK_AFTER_SEC ? `! ${fmtDuration(f.blocked, { capHour: true })}` : "!";
    urgent.push(chip(hero.id, "blocked", t, COL.blocked, { tooltip: waitLine(live, f) }));
  } else if (f.state === "crashed") {
    urgent.push(chip(hero.id, "crashed", "rebooting", COL.hp, { tooltip: "Crashed at 0 HP: back in a few seconds" }));
  }
  if (f.fight) { // fighting, or holding / rebooting in the arena (walked-out heroes have none)
    const review = f.fight.kind === "review";
    urgent.push(chip(hero.id, review ? "review" : "boss", review ? "REVIEW" : `BOSS ${leftPct(f.fight)}%`, COL.hp,
      { tooltip: fightLine(f.fight) }));
  }
  if (f.chest) {
    rest.push(chip(hero.id, "chest", f.chest.n > 1 ? `×${f.chest.n}` : "", COL.done,
      { tooltip: `${f.chest.n} ${plural(f.chest.n, "chest")} waiting · ${f.chest.seals.toFixed(1)} Seals · click to open` }));
  }
  if (unblockedActive(hero, rt.tick)) {
    rest.push(chip(hero.id, "unblocked", "", COL.working, { tooltip: unblockedLine(hero, rt.tick) }));
  }
  const drop = idx.drops.get(hero.id);
  if (drop) {
    const r = RARITIES[drop.rar] || RARITIES[4];
    rest.push(chip(hero.id, "star", "", r.color, { tooltip: `New ${r.name} drop: ${drop.text}` }));
  } else if (hero.spFree > 0 && !hero.autoLearn) {
    rest.push(chip(hero.id, "star", "", COL.xp, { tooltip: `${hero.spFree} skill ${plural(hero.spFree, "point")} to spend (character sheet)` }));
  }
  const forks = live.forklings || [];
  if (forks.length) {
    const target = forkTarget(live);
    const waits = forks.some((x) => x.status === "blocked");
    // A sub-agent waiting for the person is news (herdr's agents list ranks a parent by its most
    // urgent sub-agent): the chip turns amber and joins the urgent chips (slim rows show only two);
    // ui/party.js draws a non-grey fork chip in its colour.
    (waits ? urgent : rest).push(chip(hero.id, "fork", String(forks.length), waits ? COL.blocked : COL.idle, {
      terminal: target,
      tooltip: `${forkLine(live)}${target ? ` · click to show ${waits ? "the one waiting for you" : "it"}` : ""}`,
    }));
  }
  return urgent.concat(rest).slice(0, MAX_CHIPS);
}

function rowTooltip(world, idx, hero, live, f) {
  const lines = [headLine(hero, f, live), questLine(world, hero, live, f, { row: true })];
  const hold = holdLine(f);
  if (hold) lines.push(hold);
  const xp = hero.L >= T.levelCap ? "XP MAX" : `XP ${Math.floor(f.xpFrac * 100)}%`;
  lines.push(`HP ${fmtInt(live.hp)} / ${fmtInt(live.maxHp)} · ${xp}${hero.fe >= 1 ? ` · Fresh Eyes ${fmtMin(hero.fe)}` : ""}`);
  const why = whyLine(f.why);
  if (why) lines.push(why);
  if (unblockedActive(hero, world.rt.tick)) lines.push(unblockedLine(hero, world.rt.tick));
  if (f.chest && f.state !== "shipped") lines.push(`${f.chest.n} ${plural(f.chest.n, "chest")} waiting: click the chest to open`);
  else if (f.chest) lines.push("Click the chest to open it");
  const drop = idx.drops.get(hero.id);
  if (drop) lines.push(`New ${(RARITIES[drop.rar] || RARITIES[4]).name} drop: ${drop.text}`);
  const forks = forkLine(live);
  if (forks) lines.push(forks);
  if (hero.contractor) lines.push("Contractors don't get equity.");
  return lines.join("\n");
}

function liveRow(world, idx, hero, live, slim) {
  const f = heroFacts(world, idx, hero, live);
  const programKey = live.program && live.program.key ? live.program.key : live.app;
  const lu = idx.levelUp.get(hero.id);
  const machine = machineOf(live.address);
  return {
    key: `h:${hero.id}`, heroId: hero.id, address: str(live.address), pane: live.pane ? str(live.pane) : null,
    name: str(hero.name, "Termling"), level: hero.L, careerTitle: f.career.title, clsName: f.career.clsName,
    mapLabel: mapLabelOf(world, live), status: f.status, stripe: STATUS_COLOR[f.status] || COL.idle,
    face: faceOf(f.state), programIcon: programIconOf(live.program), focused: !!live.focused, pinned: !!live.pinned,
    hpFrac: f.hpFrac, xpFrac: f.xpFrac, feFrac: f.feFrac,
    chips: liveChips(world, idx, hero, live, f), tooltip: rowTooltip(world, idx, hero, live, f),
    chestPending: !!f.chest, colors: termlingColors(hero, programKey, f.state),
    levelUpAge: lu === 0 || lu === 1 ? lu : null, slim: !!slim, machine,
  };
}

function seatProgram(seat) {
  const s = str(seat);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function shippedProgram(key) {
  if (!Object.prototype.hasOwnProperty.call(AGENT_ICONS, key)) return null;
  return { key, icon: `icons/${key}.svg`, tint: AGENT_ICONS[key] === TINTED, color: "#ffffff" };
}

/** What resting off duty does for Fresh Eyes (agents.accrueFreshEyes): builds, is full, or waits. */
function offDutyFreshEyes(world, hero) {
  if (!(hero.st && hero.st.seals > 0)) return "Fresh Eyes starts building after this hero's first shipped chest";
  if (num(hero.fe) >= freshEyesCapMin(world.state)) return "Fresh Eyes is full";
  return "Fresh Eyes builds up while off duty (1 min per 4)";
}

function offDutyRow(world, idx, hero, nowMs, slim) {
  const f = heroFacts(world, idx, hero, null);
  const key = seatProgram(hero.seat);
  const since = num(hero.seenAt) > 0 && nowMs > hero.seenAt ? fmtDuration((nowMs - hero.seenAt) / 1000) : null;
  const xp = hero.L >= T.levelCap ? "XP MAX" : `XP ${Math.floor(f.xpFrac * 100)}%`;
  const lines = [
    headLine(hero, f, null),
    `Off duty${since ? ` for ${since}` : ""}${hero.fe >= 1 ? ` · Fresh Eyes ${fmtMin(hero.fe)}` : ""}`,
    `${xp} · ${offDutyFreshEyes(world, hero)}`,
  ];
  const chips = [];
  if (f.chest) {
    lines.push(`${f.chest.n} ${plural(f.chest.n, "chest")} waiting (${f.chest.seals.toFixed(1)} Seals): click the chest to open`);
    chips.push(chip(hero.id, "chest", f.chest.n > 1 ? `×${f.chest.n}` : "", COL.done,
      { tooltip: `${f.chest.n} ${plural(f.chest.n, "chest")} waiting · click to open` }));
  }
  lines.push("Click to open the character sheet");
  return {
    key: `h:${hero.id}`, heroId: hero.id, address: null, pane: null,
    name: str(hero.name, "Termling"), level: hero.L, careerTitle: f.career.title, clsName: f.career.clsName,
    mapLabel: "Off duty", status: "idle", stripe: COL.idle, face: faceOf("off"),
    programIcon: programIconOf(idx.programs.get(key) || shippedProgram(key)), focused: false, pinned: false,
    hpFrac: f.hpFrac, xpFrac: f.xpFrac, feFrac: f.feFrac, chips, tooltip: lines.join("\n"),
    chestPending: !!f.chest, colors: termlingColors(hero, key, "off"), levelUpAge: null, slim: !!slim, machine: null,
  };
}

let PARTY = null;

/**
 * The party sidebar (D§11.11): live heroes grouped by space in herdr's order, then the off-duty
 * group; footer (gold, Snippets, release, Sprint, digest dot); agentOrder for setAgentOrder().
 * @param {object} world
 * @param {{width?:number, nowMs?:number}} args
 * @returns {object|null} PartyVM (ARCHITECTURE §5 + ui/party.js additions)
 */
export function partyView(world, args = {}) {
  if (!world || !world.state || !world.rt) return null;
  const rt = world.rt;
  const compact = num(args.width, 268) < RAIL_PX;
  const nowMs = Number.isFinite(args.nowMs) ? args.nowMs : num(rt.nowMs);
  const minute = Math.floor(nowMs / 60000);
  const m = PARTY;
  if (m && m.rt === rt && m.version === rt.version && m.compact === compact && m.minute === minute) return m.vm;

  const idx = indexOf(world);
  const off = world.state.heroes.filter((h) => !rt.live || !rt.live.has(h.id));
  off.sort((a, b) => (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0) || num(a.ord) - num(b.ord) || a.id - b.id);
  const liveN = idx.pairs.length;
  // live rows also go slim in a big herd with many off-duty heroes (12 full rows plus 18 slim
  // ones came to ~403 elements with the off-duty group unfolded)
  const slimLive = liveN > SLIM_AT || (liveN > SLIM_AT - 4 && liveN + off.length > 2 * SLIM_AT);
  const slimOff = liveN + off.length > SLIM_AT;

  const groups = [];
  const byKey = new Map();
  for (const [hero, live] of idx.pairs) {
    const sp = str(live.space);
    const key = `g:space:${sp}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, name: str(live.spaceName).trim() || sp || "Other agents", offDuty: false, rows: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(liveRow(world, idx, hero, live, slimLive));
  }
  // agentOrder follows the rows as drawn (group by group). live.order is herdr's order only for
  // agents(); an orphan sub-agent playing as a top-level hero comes after all of them even when its
  // space's group is drawn earlier, so pushing in idx.pairs order would desync agent.next / .prev.
  const agentOrder = [];
  for (const g of groups) for (const r of g.rows) if (r.address) agentOrder.push(r.address);
  if (off.length) {
    groups.push({ key: "g:off", name: "Off duty", offDuty: true, rows: off.map((h) => offDutyRow(world, idx, h, nowMs, slimOff)) });
  }
  const herd = world.state.herd;
  const vm = {
    compact, title: str(herd.name).trim() || "The Herd", count: liveN + off.length, version: num(rt.version),
    calm: !!(herd.cfg && herd.cfg.calm), groups, footer: footerOf(world, idx), agentOrder,
  };
  PARTY = { rt, version: rt.version, compact, minute, vm };
  return vm;
}

// ---------------------------------------------------------------------------------------------
// Pane header nameplate (D§11.12)
// ---------------------------------------------------------------------------------------------

let PLATES = { rt: null, version: -1, map: new Map() };

/**
 * The nameplate's status chip (D§11.12): {text, short, color}. `short` is the form a very narrow
 * header shows. The hero's own state comes first: a blocked boss participant reads "! waiting" (it
 * holds in the arena), a crashed one "rebooting"; only a fighting one shows "BOSS 41%".
 */
function plateChip(world, hero, live, f) {
  if (f.fight && FIGHTING[f.state]) {
    const text = f.fight.kind === "review" ? "REVIEW" : `BOSS ${leftPct(f.fight)}%`;
    return { text, short: text, color: COL.hp };
  }
  switch (f.state) {
    case "waiting": {
      const clock = f.blocked >= CLOCK_AFTER_SEC ? fmtDuration(f.blocked, { capHour: true }) : "";
      return { text: clock ? `! waiting ${clock}` : "! waiting", short: clock ? `! ${clock}` : "!", color: COL.blocked };
    }
    case "shipped": return { text: f.chest ? "shipped · chest ready" : "shipped", short: "shipped", color: COL.done };
    case "resting": return { text: "resting", short: "resting", color: COL.idle };
    case "crashed": return { text: "rebooting", short: "rebooting", color: COL.hp };
    case "supervising": {
      const n = (live.forklings || []).filter((x) => x.status === "working").length;
      return { text: `supervising ${n} ${plural(n, "Forkling")}`, short: "supervising", color: COL.idle };
    }
    default: {
      const where = shortMap(world, live);
      return { text: where ? `fighting ${where}` : "fighting", short: where || "fighting", color: COL.idle };
    }
  }
}

function plateTooltip(world, hero, live, f) {
  const lines = [headLine(hero, f, live)];
  const st = stats(hero, heroCtx(world, hero));
  const gear = Math.round(num(st.pl, hero.L)) - hero.L;
  lines.push(`Power Level ${hero.L + gear} = Lv ${hero.L} ${gear < 0 ? "−" : "+"} gear ${Math.abs(gear)}`);
  lines.push(questLine(world, hero, live, f));
  const hold = holdLine(f);
  if (hold) lines.push(hold);
  if (f.why) {
    const fe = hero.fe >= 1 ? `Fresh Eyes ${fmtMin(hero.fe)}` : "No Fresh Eyes yet";
    lines.push(`${fe} · Shift ${shiftText(f.why)}`);
    lines.push(whyLine(f.why, { shift: false }));
  }
  const buffs = buffLine(live);
  if (buffs) lines.push(buffs);
  const forks = forkLine(live);
  if (forks) lines.push(forks);
  if (f.chest) lines.push(`${f.chest.n} ${plural(f.chest.n, "chest")} waiting · ${f.chest.seals.toFixed(1)} Seals`);
  if (hero.contractor) lines.push("Contractors don't get equity.");
  lines.push("Click for the character sheet");
  return lines.join("\n");
}

function buildPlate(world, idx, hero, live) {
  const f = heroFacts(world, idx, hero, live);
  const programKey = live.program && live.program.key ? live.program.key : live.app;
  return {
    heroId: hero.id, name: str(hero.name, "Termling"), level: hero.L, careerTitle: f.career.title, clsName: f.career.clsName,
    programIcon: programIconOf(live.program), hpFrac: f.hpFrac, xpFrac: f.xpFrac, feFrac: f.feFrac,
    chip: plateChip(world, hero, live, f), tooltip: plateTooltip(world, hero, live, f), contractor: !!hero.contractor,
    face: faceOf(f.state), status: f.status, colors: termlingColors(hero, programKey, f.state),
    calm: !!(world.state.herd.cfg && world.state.herd.cfg.calm),
  };
}

/**
 * The pane header of an agent's terminal (D§11.12), or null when no hero plays that terminal (a
 * shell, a mod pane, a sub-agent's own pane): the header is then herdr's plain one.
 * @param {object} world
 * @param {{terminal:string|null, pane?:string|null}} args
 * @returns {object|null} PlateVM (ARCHITECTURE §5 + ui/nameplate.js additions)
 */
export function nameplateView(world, args = {}) {
  if (!world || !world.state || !world.rt) return null;
  const terminal = args.terminal;
  if (terminal == null || terminal === "") return null;
  const rt = world.rt;
  if (PLATES.rt !== rt || PLATES.version !== rt.version) PLATES = { rt, version: rt.version, map: new Map() };
  const key = String(terminal);
  if (PLATES.map.has(key)) return PLATES.map.get(key);
  const idx = indexOf(world);
  const pair = idx.byAddr.get(key);
  const vm = pair ? buildPlate(world, idx, pair[0], pair[1]) : null;
  PLATES.map.set(key, vm);
  return vm;
}

// ---------------------------------------------------------------------------------------------
// HUD strip
// ---------------------------------------------------------------------------------------------

let HUD = null;

/**
 * The HUD strip: gold, Snippets, release, Sprint, working / blocked / shipped counts (herdr status
 * words; shipped = done, not yet seen), the digest dot and calm mode.
 * @param {object} world
 * @param {{nowMs?:number}} args
 * @returns {object|null} HudVM (ARCHITECTURE §5 + ui/hud.js additions)
 */
export function hudView(world, args = {}) {
  if (!world || !world.state || !world.rt) return null;
  const rt = world.rt;
  if (HUD && HUD.rt === rt && HUD.version === rt.version) return HUD.vm;
  const idx = indexOf(world);
  const f = footerOf(world, idx);
  const herd = world.state.herd;
  const vm = {
    gold: f.gold, snippets: f.snippets, release: f.release, sprint: f.sprint,
    working: idx.counts.working, blocked: idx.counts.blocked, shipped: idx.counts.done, digestDot: f.digestDot,
    calm: !!(herd.cfg && herd.cfg.calm),
  };
  HUD = { rt, version: rt.version, vm };
  return vm;
}
