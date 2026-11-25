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
import { fmtNum, fmtDuration, need, K, gap as gapMult, cutText, autoOn } from "../formulas.js";
import { careerOf, stats, lookOf } from "../heroes.js";
import { liveHeroes, chestInfo, unblockedActive, unblockedLeft, tellingTitle } from "../agents.js";
// agents.hireOutlook (round 4, owner decision "promote only") is read through the namespace, so a
// build without it still loads (a missing named import is a link error) and the line is left out
import * as Agents from "../agents.js";
// herd.unseenLosses (round 4, item E4) the same way
import * as Herd from "../herd.js";
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

/** A live hero whose agent waits for the person (herdr's "blocked" status, on a terminal). */
export function heroWaits(live) {
  return !!live && live.address != null && str(live.address) !== "" && statusWord(live.status) === "blocked";
}

/** A hero's sub-agent (a Forkling, D§2.7) that waits for the person. */
export function forkWaits(x) {
  return !!x && x.status === "blocked" && x.address != null && str(x.address) !== "";
}

let NEED = null;

/**
 * How many things wait for the person (owner decision 3, round 4): every live hero whose agent is
 * blocked (Contractors too) plus every blocked sub-agent of a live hero, as herdr's agents list
 * ranks a parent by its most urgent sub-agent. The one count every "need you" says: the party's
 * "N need you" (ui/party.js waitingList walks the rows by these same two tests), the Herd panel's
 * header and the HUD's blocked tooltip. {n, heroes, subs}; cached per world version.
 */
export function needYou(world) {
  const rt = world && world.rt;
  if (!rt) return { n: 0, heroes: 0, subs: 0 };
  if (NEED && NEED.rt === rt && NEED.version === rt.version) return NEED.out;
  let heroes = 0;
  let subs = 0;
  for (const [, live] of liveHeroes(world)) {
    if (heroWaits(live)) heroes++;
    for (const x of live.forklings || []) if (forkWaits(x)) subs++;
  }
  const out = { n: heroes + subs, heroes, subs };
  NEED = { rt, version: rt.version, out };
  return out;
}

/** "3 need you" / "1 needs you" (herdr's status bar words; the party's chip says the same). */
export function needYouText(n) {
  return `${n} ${n === 1 ? "needs" : "need"} you`;
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
  // the hoodie is the hero's look for life (heroes.lookOf): by id, or the tint a promoted
  // Contractor kept (round 4b)
  return {
    hoodie: PALETTE.termlingTint[lookOf(hero)],
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
/**
 * The level-gap XP factor (D§6.2) on the why's map for a hero of `level`, when it binds (below
 * ×1): {mapId, below, mult}; else null. Autopilot keeps heroes on maps near their level, so it
 * binds mainly under a manual map pin (the room header's click); the Backlog has none (D§9.8).
 */
export function gapPart(why, level) {
  if (!why || !Number.isFinite(level) || !why.mapId || why.mapId === BACKLOG.id) return null;
  const st = why.state;
  if (st !== "questing" && st !== "crashed" && st !== "supervising") return null;
  const m = Object.prototype.hasOwnProperty.call(MAP_BY_ID, why.mapId) ? MAP_BY_ID[why.mapId] : null;
  if (!m || !Number.isFinite(m.mid)) return null;
  const below = Math.round(level - m.mid);
  const g = gapMult(below);
  if (!(g < 1)) return null;
  return { mapId: m.id, below, mult: Math.round(g * 100) / 100 };
}

/** "1-1 is 9 levels below: ×0.03" (the why line's and the sheet's level-gap part). */
export function gapText(gp) {
  return `${gp.mapId} is ${gp.below} ${gp.below === 1 ? "level" : "levels"} below: ×${gp.mult}`;
}

/** Is the hero pinned to the map its live copy is on (the room header's click, D§11.16)? */
export function mapPinned(hero, live) {
  return Boolean(hero && live && hero.pinMap && hero.pinMap === live.mapId);
}

/** opts: shift (default true), level (the hero's: adds the level-gap part when it binds). */
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
  const gp = gapPart(why, opts.level);
  if (gp) parts.push(gapText(gp));
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

/**
 * Chests that opened Unreviewed (D§2.4: 24 h unopened, half value, no Seals) since the person last
 * viewed the Digest: a loss they may not have seen, so the Herd button's dot stays lit until they
 * do (round 4). Counted from the journal's "unrev" lines (value: the chests) newer than
 * herd.digestAt, which the Digest's digestSeen command moves on. The engine's saved count
 * (herd.unseenLosses: herd.unseenUnrev, cleared by digestSeen / lossesSeen) is used when the build
 * has it; the journal count is the fallback (it keeps its newest 60-120 lines, so a very busy
 * absence may undercount).
 */
export function unseenUnreviewed(world) {
  const herd = world && world.state && world.state.herd;
  if (!herd) return 0;
  if (typeof Herd.unseenLosses === "function") return Herd.unseenLosses(world.state);
  if (Number.isFinite(herd.unseenUnrev)) return Math.max(0, Math.floor(herd.unseenUnrev));
  const since = num(herd.digestAt);
  let n = 0;
  for (const e of herd.log || []) {
    if (!Array.isArray(e) || e[1] !== "unrev" || !(num(e[0]) > since)) continue;
    n += Math.max(1, Math.floor(num(e[4], 1)));
  }
  return n;
}

/**
 * The Herd button's dot and its tooltip (party footer and HUD): the digest's own dot (back after
 * 30 min away), chests opened Unreviewed not yet seen in the Digest, or an off-duty chest within
 * 4 h of opening Unreviewed (`expiring`, from the caller). digestTip: null for the plain "something
 * new" wording.
 */
function digestCue(world, expiring) {
  const lost = unseenUnreviewed(world);
  const dot = digestDot(world) || lost > 0 || !!expiring;
  let tip = null;
  if (lost > 0) tip = `Herd panel: ${lost} ${plural(lost, "chest")} opened Unreviewed (half value, no Seals): the Digest lists ${lost === 1 ? "it" : "them"}`;
  else if (expiring) tip = "Herd panel: a chest off duty opens Unreviewed within 4 h: the Digest lists it with an Open button";
  return { dot, tip, lost };
}

function footerOf(world, idx, expiring) {
  const herd = world.state.herd;
  const cue = digestCue(world, expiring);
  return {
    gold: fmtNum(num(herd.gold)),
    snippets: fmtNum(num(herd.snip)),
    release: str(releaseInfo(world.state).label, "v0.0"),
    sprint: idx.sprint ? Object.assign({}, idx.sprint) : null,
    digestDot: cue.dot,
    digestTip: cue.tip,
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
    // agents.stepStatus refreshes live.why every 5 ticks, heroes taking turns by id (null only
    // until a new hero's first tick)
    why: live ? live.why || null : null,
  };
}

// D§2.3: the Quest name is the terminal title cut to 40 characters (agents.js TITLE_MAX).
const QUEST_NAME_MAX = 40;

// tellingTitle (herdr's agents-list test) lives in the engine, which keeps only telling titles
// as a task's title (agents.js); the views use it for live titles, chests and Forklings.
export { tellingTitle };

/**
 * What the tooltips call a terminal's work: the most telling label herdr gives it. The live title
 * when it tells something (tellingTitle, herdr's agents-list test), else the title the task last
 * had; where neither tells anything, a name the person gave, as that list falls back to one: the
 * pane's (pane.rename; herdr's own pane header shows it first), else the tab's (tab_name, unless
 * it is the automatic number). Unlike the list, a telling title beats a named tab: the line names
 * the task, not the place. "" when nothing tells: the line leaves the name out rather than print
 * "zsh" or "Claude Code". At most 40 characters, as the Quest name is (D§2.3; agents.js
 * TITLE_MAX): a terminal title can run to a whole command line.
 */
export function taskLabel(live) {
  const title = tellingTitle(live.title, live) || tellingTitle(live.task && live.task.title, live);
  // a name the person typed is shown as typed (the test only keeps out "zsh", "Claude Code", ...)
  const named = (v) => { const s = str(v).trim(); return s && tellingTitle(s, live) ? s : ""; };
  const label = title || named(live.paneName) || (/^\d+$/.test(str(live.tabName).trim()) ? "" : named(live.tabName));
  // cutText: never half an emoji (herdr's bridge refuses a lone surrogate, and the role would
  // render as its error chip)
  return label.length > QUEST_NAME_MAX ? cutText(label, QUEST_NAME_MAX).trimEnd() : label;
}

/** "Waiting for you for 2m on “Bump deps and fix types”". */
function waitLine(live, f) {
  const title = taskLabel(live);
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
  const title = taskLabel(live);
  switch (f.state) {
    case "waiting": return `${waitLine(live, f)}${opts.row ? " · click to jump there" : ""}`;
    case "crashed": return `Rebooting: back in ${Math.max(1, num(live.crashedUntil) - rt.tick)}s`;
    case "supervising": {
      const n = (live.forklings || []).filter((x) => x.status === "working").length;
      return `Supervising ${n} ${plural(n, "Forkling")}`;
    }
    case "shipped":
      // the chest keeps the title its task had when it shipped (agents.js), which may be a bare
      // program or shell name too
      if (f.chest) return `Shipped: ${tellingTitle(f.chest.title, live) || title || "Commit"} · ${f.chest.seals.toFixed(1)} Seals · ${f.chest.tier} chest`;
      return `Shipped${title ? `: ${title}` : ""}`;
    case "resting": return "Resting at the campfire";
    default:
      if (task && title) return `Quest: ${title} (${fmtDuration(num(task.workSec))})`;
      return `Questing in ${mapLabelOf(world, live) || "the Stack"}`;
  }
}

function forkLine(live) {
  const list = live.forklings || [];
  if (!list.length) return "";
  const shown = list.slice(0, 3).map((x) => `${tellingTitle(x.title, x) || "sub-agent"} (${x.status})`);
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

/**
 * When a Contractor joins the roster (agents.hireOutlook, owner decision round 4: "promote only"):
 * "Hired at the next 04:00 game day (today: 0 of 6 hires left)"; "" for a roster hero, or a build
 * without hireOutlook. Shared with the stage's hero tooltip (view/stage.js).
 */
export function hireLine(world, hero) {
  if (!hero || !hero.contractor || typeof Agents.hireOutlook !== "function") return "";
  const o = Agents.hireOutlook(world, hero);
  return o && typeof o.text === "string" ? o.text : "";
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
  } else if (hero.spFree > 0 && !(hero.autoLearn !== false && autoOn(world.state, "learn"))) {
    // points nobody spends: the hero's auto-learn is off, or the herd's (or the autopilot's)
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
  const why = whyLine(f.why, { level: hero.L });
  if (why) lines.push(why);
  if (unblockedActive(hero, world.rt.tick)) lines.push(unblockedLine(hero, world.rt.tick));
  if (f.chest && f.state !== "shipped") lines.push(`${f.chest.n} ${plural(f.chest.n, "chest")} waiting: click the chest to open`);
  else if (f.chest) lines.push("Click the chest to open it");
  const drop = idx.drops.get(hero.id);
  if (drop) lines.push(`New ${(RARITIES[drop.rar] || RARITIES[4]).name} drop: ${drop.text}`);
  const pin = mapPinOf(world, hero, live);
  if (pin) lines.push(pin.tooltip);
  const forks = forkLine(live);
  if (forks) lines.push(forks);
  if (hero.contractor) {
    lines.push("Contractors don't get equity.");
    const hire = hireLine(world, hero);
    if (hire) lines.push(hire);
  }
  return lines.join("\n");
}

/**
 * RowVM.mapPin: the hero is pinned to the map it is on (the stage's room header click, D§11.16):
 * the party draws a map-pin glyph beside the level, always in view (a "(pinned)" after the map on
 * line 2 was cut off at the default sidebar width), and its tooltip says what it means.
 */
function mapPinOf(world, hero, live) {
  if (!mapPinned(hero, live)) return null;
  return { tooltip: `Pinned to ${mapLabelOf(world, live)}: the autopilot keeps it on this map (Auto on the Career tab's Map card unpins it)` };
}

/**
 * RowVM.waitingForks: the hero's sub-agents (Forklings, D§2.7) waiting for the person, in herdr's
 * order. They count in the party's "N need you", its group "!" and the rail's "!" badge, as
 * herdr's agents list ranks a parent by its most urgent sub-agent; a click shows the one waiting
 * (its pane when it has one, else herdr's peek: ui/party.js showTerminal). name: how "N need you"
 * lists it; tooltip: the rail badge's hover.
 */
function waitingForksOf(hero, live) {
  const out = [];
  for (const x of live.forklings || []) {
    if (!forkWaits(x)) continue;
    const title = tellingTitle(x.title, x);
    out.push({
      key: `wf:${x.address}`, address: str(x.address), name: `${str(hero.name, "Termling")}'s sub-agent`,
      tooltip: `A sub-agent of ${str(hero.name, "Termling")} waits for you${title ? ` on “${title}”` : ""} · click to show it`,
    });
  }
  return out;
}

function liveRow(world, idx, hero, live, slim) {
  const f = heroFacts(world, idx, hero, live);
  const programKey = live.program && live.program.key ? live.program.key : live.app;
  const lu = idx.levelUp.get(hero.id);
  const machine = machineOf(live.address);
  return {
    key: `h:${hero.id}`, heroId: hero.id, address: str(live.address), pane: live.pane ? str(live.pane) : null,
    name: str(hero.name, "Termling"), level: hero.L, careerTitle: f.career.title, clsName: f.career.clsName,
    mapLabel: mapLabelOf(world, live), mapPin: mapPinOf(world, hero, live), status: f.status, stripe: STATUS_COLOR[f.status] || COL.idle,
    face: faceOf(f.state), programIcon: programIconOf(live.program), focused: !!live.focused, pinned: !!live.pinned,
    hpFrac: f.hpFrac, xpFrac: f.xpFrac, feFrac: f.feFrac,
    chips: liveChips(world, idx, hero, live, f), tooltip: rowTooltip(world, idx, hero, live, f),
    chestPending: !!f.chest, colors: termlingColors(hero, programKey, f.state),
    levelUpAge: lu === 0 || lu === 1 ? lu : null, slim: !!slim, machine, waitingForks: waitingForksOf(hero, live),
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
    const left = unreviewedLeftMs(hero, nowMs);
    if (left != null) lines.push(left > 0 ? `Unopened, it opens Unreviewed in ${fmtDuration(left / 1000)} (half value, no Seals)` : "It opens Unreviewed soon (half value, no Seals)");
    chips.push(chip(hero.id, "chest", f.chest.n > 1 ? `×${f.chest.n}` : "", COL.done,
      { tooltip: `${f.chest.n} ${plural(f.chest.n, "chest")} waiting · click to open` }));
  }
  lines.push("Click to open the character sheet");
  return {
    key: `h:${hero.id}`, heroId: hero.id, address: null, pane: null,
    name: str(hero.name, "Termling"), level: hero.L, careerTitle: f.career.title, clsName: f.career.clsName,
    mapLabel: "Off duty", mapPin: null, status: "idle", stripe: COL.idle, face: faceOf("off"),
    programIcon: programIconOf(idx.programs.get(key) || shippedProgram(key)), focused: false, pinned: false,
    hpFrac: f.hpFrac, xpFrac: f.xpFrac, feFrac: f.feFrac, chips, tooltip: lines.join("\n"),
    chestPending: !!f.chest, colors: termlingColors(hero, key, "off"), levelUpAge: null, slim: !!slim, machine: null,
    waitingForks: [],
  };
}

/**
 * How long until an off-duty hero's oldest pending chest opens Unreviewed (D§2.4: 24 h, half
 * value, no Seals), in ms (≤ 0: due), or null with none.
 */
function unreviewedLeftMs(hero, nowMs) {
  let oldest = Infinity;
  for (const p of hero.pend || []) oldest = Math.min(oldest, num(p.at, Infinity));
  if (!Number.isFinite(oldest) || !Number.isFinite(nowMs)) return null;
  return T.seals.unreviewedAfterSec * 1000 - (nowMs - oldest);
}

/** An off-duty chest this close to opening Unreviewed lights the Herd button's dot (its Digest). */
const EXPIRY_CUE_MS = 4 * 3600 * 1000;

let PARTY = null;

/**
 * Save trouble (host.saveStatus(), passed as args.save; D§13.1: never silent, even with the stage
 * hidden) as the party's and the HUD's cue: {title, short, tooltip}, or null while the save is
 * fine. title: the stage notice's label ("Not saving"); short: a narrow form; a click on the cue
 * opens the Herd panel, whose band says the rest (D§13.4).
 */
export function saveCue(st) {
  if (!st || typeof st !== "object" || typeof st.message !== "string" || !st.message) return null;
  const title = typeof st.title === "string" && st.title ? st.title
    : st.readOnly ? "Save is read-only" : st.notSaving ? "Not saving" : "Save restored";
  const short = st.readOnly ? "Read-only" : st.notSaving ? "Not saving"
    : st.restoredFrom === "fresh" ? "New herd" : st.restoredFrom === "unchecked" ? "Checksum" : "Restored";
  const detail = typeof st.detail === "string" && st.detail ? `\n(${st.detail})` : "";
  return { title, short, tooltip: `${st.message}${detail}\nClick for the Herd panel.` };
}

/**
 * The party sidebar (D§11.11): live heroes grouped by space in herdr's order, then the off-duty
 * group; footer (gold, Snippets, release, Sprint, digest dot); agentOrder for setAgentOrder().
 * @param {object} world
 * @param {{width?:number, nowMs?:number, save?:object|null}} args  save: host.saveStatus() (saveCue)
 * @returns {object|null} PartyVM (ARCHITECTURE §5 + ui/party.js additions)
 */
export function partyView(world, args = {}) {
  if (!world || !world.state || !world.rt) return null;
  const rt = world.rt;
  const compact = num(args.width, 268) < RAIL_PX;
  const nowMs = Number.isFinite(args.nowMs) ? args.nowMs : num(rt.nowMs);
  const minute = Math.floor(nowMs / 60000);
  const save = saveCue(args.save);
  const saveKey = save ? JSON.stringify(save) : "";
  const m = PARTY;
  if (m && m.rt === rt && m.version === rt.version && m.compact === compact && m.minute === minute && m.saveKey === saveKey) return m.vm;

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
  // the off-duty group starts folded: it carries its pending chests (the folded header shows them,
  // D§2.4 "one click still claims it fully"), and one near opening Unreviewed lights the Herd dot
  let offChests = 0;
  let expiring = false;
  if (off.length) {
    for (const h of off) {
      const n = (h.pend || []).length;
      if (!n) continue;
      offChests += n;
      const left = unreviewedLeftMs(h, nowMs);
      if (left != null && left <= EXPIRY_CUE_MS) expiring = true;
    }
    groups.push({ key: "g:off", name: "Off duty", offDuty: true, chests: offChests, rows: off.map((h) => offDutyRow(world, idx, h, nowMs, slimOff)) });
  }
  const herd = world.state.herd;
  const footer = footerOf(world, idx, expiring);
  const vm = {
    compact, title: str(herd.name).trim() || "The Herd", count: liveN + off.length, version: num(rt.version),
    calm: !!(herd.cfg && herd.cfg.calm), groups, footer, agentOrder, save,
  };
  PARTY = { rt, version: rt.version, compact, minute, saveKey, vm };
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
    lines.push(whyLine(f.why, { shift: false, level: hero.L }));
  }
  const buffs = buffLine(live);
  if (buffs) lines.push(buffs);
  const forks = forkLine(live);
  if (forks) lines.push(forks);
  if (f.chest) lines.push(`${f.chest.n} ${plural(f.chest.n, "chest")} waiting · ${f.chest.seals.toFixed(1)} Seals`);
  if (hero.contractor) {
    lines.push("Contractors don't get equity.");
    const hire = hireLine(world, hero);
    if (hire) lines.push(hire);
  }
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
 * @param {{nowMs?:number, save?:object|null}} args  save: host.saveStatus() (saveCue)
 * @returns {object|null} HudVM (ARCHITECTURE §5 + ui/hud.js additions)
 */
export function hudView(world, args = {}) {
  if (!world || !world.state || !world.rt) return null;
  const rt = world.rt;
  const save = saveCue(args && args.save);
  const saveKey = save ? JSON.stringify(save) : "";
  const nowMs = Number.isFinite(args && args.nowMs) ? args.nowMs : num(rt.nowMs);
  const minute = Math.floor(nowMs / 60000);
  if (HUD && HUD.rt === rt && HUD.version === rt.version && HUD.saveKey === saveKey && HUD.minute === minute) return HUD.vm;
  const idx = indexOf(world);
  const herd = world.state.herd;
  // as the party's Herd button: an off-duty chest near opening Unreviewed lights the dot
  let expiring = false;
  for (const h of world.state.heroes) {
    if (rt.live && rt.live.has(h.id)) continue;
    const left = unreviewedLeftMs(h, nowMs);
    if (left != null && left <= EXPIRY_CUE_MS) { expiring = true; break; }
  }
  const f = footerOf(world, idx, expiring);
  const vm = {
    gold: f.gold, snippets: f.snippets, release: f.release, sprint: f.sprint,
    working: idx.counts.working, blocked: idx.counts.blocked, shipped: idx.counts.done, needYou: needYou(world).n, digestDot: f.digestDot,
    digestTip: f.digestTip, calm: !!(herd.cfg && herd.cfg.calm), save,
  };
  HUD = { rt, version: rt.version, saveKey, minute, vm };
  return vm;
}
