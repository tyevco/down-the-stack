// View models for the two dialogs (ARCHITECTURE §5, D§11.13, D§11.14):
//   sheetView(world, {heroId, tab, filter}) -> SheetVM   (ui/sheet.js, the character sheet)
//   herdView(world, {tab, filter})          -> HerdVM    (ui/herdpanel.js, the Herd panel)
// Shapes: the typedefs at the top of ui/sheet.js (SheetVM, ItemVM, CardVM, ActionVM, ...) and
// ui/herdpanel.js (HerdVM, ...); the field-by-field spec is tools/vm-samples/{sheet,herd}.mjs.
// Every user-facing string is made here, and every button is an ActionVM whose label, cost,
// enabled state, reason and confirm text follow the engine's own rules (items.js, heroes.js,
// herd.js, boss.js, world.js commands), so a click never surprises.
//
// Decisions:
//  - Only the shown tab is built; the others are null (as the typedef says).
//  - The focused item (the compare card) is filter.hover when that item still exists, else
//    filter.selected, else filter.focus (older roles send only `focus`). A hovered item that was
//    deprecated or squashed therefore falls back to the selection instead of an empty card.
//  - Item scores (the autopilot score D§8.7 of putting an item on a hero) are cached per
//    (hero stats object, item uid + polish + affix identity): heroes.stats returns the same object
//    until the hero's level, class, ranks, gear or herd bonuses change, so a sheet re-renders without
//    re-pricing the stash. The Herd panel scores the roster ("best on X") only for the focused card;
//    its tiles only ask "can anyone wear it", from a per-version roster summary (O(1) per item).
//  - Lists are capped for the render budget: the stash at 32 rows in the sheet and 48 tiles in the
//    Herd panel ("+n more: narrow the filter"),
//    digest sections at 8 lines (+n more), the Hall of Fame at 10 rows (+n more), the journal at 30.
//  - A manual equip is refused (disabled, with the reason) when the slot holds a locked item:
//    "Locked items are never replaced" (D§8.7) holds for the person's clicks too.
//  - Per-mob kill counts are not stored by the engine (herd.bt counts kills per zone), so a bug
//    report shows the zone's kills split by the maps' spawn weights, marked "~".
//  - First-clear dates come from herd.bossAt (Herd.firstClearMs, never rolls out), else from the
//    journal's "FIXED" line for saves made before bossAt existed; a clear neither knows reads "Fixed".
//  - Digest lines with no date (herd.digest gives at null for kills it only knows from the counters)
//    read "earlier", never a date made from 0.
//  - Dates and clock times use args.tzOffsetMin, else world.rt.tzOffsetMin, else UTC; "now" is
//    args.nowMs, else world.rt.nowMs (the last tick's clock).
//  - VMs are memoised per (world version, args, minute): every redraw of the window within a tick
//    reuses them.
//
// Pure: no herdr / gpui imports, no Date.now(), no Math.random(); never mutates the world.

import {
  TUNING as T, CLASSES, CAREERS, ZONES, MOBS, BOSSES, REVIEWS, RARITIES, AFFIXES, LTS_PROPS,
  KEEPSAKES, BUILDINGS, BUILDING_IDX, BUG_TRACKER, BACKLOG, PALETTE, SLOTS, CLASS_COLORS, ITEM_BASES, MAP_BY_ID,
  SKILL_BY_ID, TROPHY,
} from "../data.js";
import { fmtNum, fmtDuration, itemTier, reqLevel, polishMax, deprecateYield, buildingCost, freshEyesCap, gold as goldOf, autoOn } from "../formulas.js";
import {
  itemName, itemStats, itemIP, canEquip, scoreDelta, nextPolishCost, findItem, stashCap, baseOf, slotIdxOf,
  affixValue, FLAG_LOCKED, FLAG_NEW,
} from "../items.js";
import { stats, computeStats, careerOf, classSignature, skillDefs, skillValue, canLearn, slotUnlocked } from "../heroes.js";
import { liveHeroes, heroById, chestInfo, unblockedActive, unblockedLeft, hiredToday } from "../agents.js";
import * as Herd from "../herd.js";
import { bossApi } from "../autopilot.js";
import { heroCtx } from "../combat.js";
import { fnv1a32 } from "../rng.js";
import { statusWord, programIconOf, termlingColors, faceOf, xpFracOf, feFracOf, whyLine, taskLabel, tellingTitle, gapPart, gapText } from "./chrome.js";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const COL = {
  working: PALETTE.working, blocked: PALETTE.blocked, done: PALETTE.done, idle: PALETTE.idle, hp: PALETTE.hp,
  xp: PALETTE.xp, fresh: PALETTE.freshEyes, coin: PALETTE.coin, heal: PALETTE.heal,
};
const STATUS_COLOR = { working: COL.working, blocked: COL.blocked, done: COL.done, idle: COL.idle, off: COL.idle };
const SHEET_TABS = [["gear", "Gear"], ["skills", "Skills"], ["stats", "Stats"], ["career", "Career"], ["journal", "Journal"]];
const HERD_TABS = [
  ["upgrades", "Upgrades"], ["stash", "Stash"], ["tracker", "Tracker"], ["bosses", "Bosses"], ["roster", "Roster"],
  ["digest", "Digest"], ["settings", "Settings"],
];
const SLOT_LABEL = { weapon: "Weapon", hat: "Hat", hoodie: "Hoodie", mug: "Mug", boots: "Boots", sticker: "Sticker" };
const WEAPON_NAME = { stick: "Training Stick", blade: "Blades", knives: "Patch Knives", pipe: "Pipes", manpage: "Manpages", duck: "Ducks" };
const STASH_ROWS = { sheet: 32, herd: 48 }; // sheet rows cost ~7 elements (8 while picking), herd tiles ~4
const DIGEST_LINES = 8;
const FAME_ROWS = 10;
const JOURNAL_LINES = 30;
const ROSTER_SLIM_AT = 12; // more heroes than this: slim one-line roster rows
const RETIRE_LEVEL = 30;
const LEGACY_PER = 0.005;
const DAY_MS = 86400000;
const MINUS = "−";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RESPEC_FREE_MS = DAY_MS;
// The stage's hat tints (game/view/stage.js), so the sheet's rig wears the same hat colour.
const HAT_COLORS = ["#E86F9C", "#5FB0E8", "#8FBF5A", "#E8B84A", "#C47BE8", "#F07D5C"];
const FORGE = BUILDING_IDX.ci_forge;
const FORGE_SQUASH = Number(Object.keys(BUILDINGS[FORGE].unlocks).find((k) => BUILDINGS[FORGE].unlocks[k] === "squashMerge"));
const FORGE_REROLL = Number(Object.keys(BUILDINGS[FORGE].unlocks).find((k) => BUILDINGS[FORGE].unlocks[k] === "reroll"));
const R_LTS = 4;
const R_KEEPSAKE = 5;
const SQUASH_MAX_RAR = 2; // Prototype, Alpha or Beta (items.squash)

// herdr's shipped agent programs (display names), for off-duty heroes whose terminal is gone.
const PROGRAM_NAMES = {
  claude: "Claude Code", codex: "Codex", gemini: "Gemini", pi: "Pi", opencode: "OpenCode", cursor: "Cursor",
  copilot: "Copilot", amp: "Amp", grok: "Grok", goose: "Goose", kimi: "Kimi", kiro: "Kiro", crush: "Crush",
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const str = (v, d = "") => (v == null ? d : String(v));
const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const r2 = (x) => Math.round(num(x) * 100) / 100;
const plural = (n, one, many) => (n === 1 ? one : many || `${one}s`);
const firstName = (h) => str(h && h.name, "Termling").split(" ")[0] || "Termling";
const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** 1,204 below a million, else the compact D§11.7 form. */
function fmtInt(n) {
  const v = Math.round(num(n));
  if (Math.abs(v) >= 1e6) return fmtNum(v);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return v < 0 ? `${MINUS}${s}` : s;
}

/** A fraction as a percentage: 0.104 -> "10.4%"; opts.sign adds +/−; opts.digits (default 1). */
function pct(v, opts = {}) {
  const x = num(v) * 100;
  if (Math.abs(x) < 0.005) return "0%";
  const d = opts.digits ?? (Math.abs(x) > 0 && Math.abs(x) < 0.1 ? 2 : 1);
  let s = Math.abs(x).toFixed(d);
  if (opts.trim) s = s.replace(/\.0+$/, "");
  const sign = opts.sign ? (x < 0 ? MINUS : "+") : x < 0 ? MINUS : "";
  return `${sign}${s}%`;
}

/** Whole-percent form for bonuses: 0.12 -> "+12%". */
const pctI = (v) => `${num(v) < 0 ? MINUS : "+"}${Math.abs(Math.round(num(v) * 100))}%`;

/** Minutes as "42m" / "3h 12m" ("0m" under a minute). */
function fmtMin(min) {
  const m = Math.floor(num(min));
  return m < 1 ? "0m" : fmtDuration(m * 60);
}

function goldText(g) {
  return `${fmtNum(Math.round(num(g)))} gold`;
}

function snipText(n) {
  const v = Math.round(num(n));
  return `${fmtNum(v)} ${plural(v, "Snippet")}`;
}

/** "Needs 12.4k gold (the herd has 3.1k)" for a cost the herd cannot pay, else null. */
function shortfall(herd, goldCost, snipCost) {
  const g = num(herd.gold);
  const s = num(herd.snip);
  if (goldCost > 0 && g < goldCost) return `Needs ${goldText(goldCost)} (the herd has ${fmtNum(g)})`;
  if (snipCost > 0 && s < snipCost) return `Needs ${snipText(snipCost)} (the herd has ${fmtNum(s)})`;
  return null;
}

function costText(goldCost, snipCost) {
  const parts = [];
  if (goldCost > 0) parts.push(goldText(goldCost));
  if (snipCost > 0) parts.push(snipText(snipCost));
  return parts.length ? parts.join(" · ") : null;
}

/** An ActionVM (ui/sheet.js). */
function action(key, label, cmd, args, o = {}) {
  return {
    key, label, cmd, args, enabled: o.enabled ?? true, cost: o.cost ?? null, tooltip: o.tooltip ?? null,
    tone: o.tone ?? null, confirm: o.confirm ?? null,
  };
}

/** A disabled ActionVM that only explains. */
function disabled(key, label, cmd, args, tooltip, o = {}) {
  return action(key, label, cmd, args, Object.assign({}, o, { enabled: false, tooltip }));
}

// ---------------------------------------------------------------------------------------------
// Time and dates (pure: UTC arithmetic after the time-zone offset)
// ---------------------------------------------------------------------------------------------

function clockOf(world, args) {
  const rt = world.rt;
  return {
    now: Number.isFinite(args.nowMs) ? args.nowMs : num(rt.nowMs, num(world.state.herd.lastMs)),
    tz: Number.isFinite(args.tzOffsetMin) ? args.tzOffsetMin : num(rt.tzOffsetMin),
  };
}

function local(ms, tz) {
  const d = new Date(num(ms) - num(tz) * 60000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), day: Math.floor((num(ms) - num(tz) * 60000) / DAY_MS) };
}

/** "Nov 2, 2026" (year) or "Nov 2". */
function fmtDate(ms, tz, year = true) {
  const p = local(ms, tz);
  return `${MONTHS[p.m]} ${p.d}${year ? `, ${p.y}` : ""}`;
}

/** Journal time: "09:41" today, "Yesterday", "Nov 22" before. */
function fmtWhen(ms, clock) {
  const p = local(ms, clock.tz);
  const today = local(clock.now, clock.tz).day;
  if (p.day === today) return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
  if (p.day === today - 1) return "Yesterday";
  return `${MONTHS[p.m]} ${p.d}`;
}

/** fmtWhen for a digest line that may have no date (at null or 0): "earlier", never "Jan 1". */
function whenOrEarlier(ms, clock) {
  return num(ms) > 0 ? fmtWhen(ms, clock) : "earlier";
}

/** "3d 02h ago" / "12m ago" / "just now". */
function ago(ms, now) {
  const sec = (num(now) - num(ms)) / 1000;
  return sec < 60 ? "just now" : `${fmtDuration(sec)} ago`;
}

// ---------------------------------------------------------------------------------------------
// World lookups (one index per world version)
// ---------------------------------------------------------------------------------------------

let INDEX = null;

function buildIndex(world) {
  const rt = world.rt;
  const state = world.state;
  const pairs = liveHeroes(world).slice().sort((a, b) => num(a[1].order) - num(b[1].order) || a[0].id - b[0].id);
  const liveOf = new Map();
  for (const [h, l] of pairs) liveOf.set(h.id, l);
  const fights = new Map();
  for (const f of rt.fights || []) for (const id of (f.heroIds || []).concat(f.helpers || [])) if (!fights.has(id)) fights.set(id, f);
  // who can wear what: the highest level on the roster, overall and per weapon type
  let maxL = 0;
  const maxByType = {};
  for (const h of state.heroes) {
    maxL = Math.max(maxL, h.L);
    const type = (CLASSES[h.cls] || CLASSES[0]).weapon;
    maxByType[type] = Math.max(maxByType[type] || 0, h.L);
  }
  const counts = { working: 0, blocked: 0, done: 0, idle: 0 };
  for (const [, l] of pairs) counts[statusWord(l.status)]++;
  // first clears: herd.bossAt (Herd.firstClearMs, kept for good), else the journal's "<boss> FIXED"
  // lines (value = boss index) of saves made before bossAt existed; the earlier of the two wins
  const cleared = {};
  for (const e of state.herd.log || []) {
    if (e && e[1] === "boss" && /FIXED$/.test(str(e[3])) && Number.isInteger(e[4]) && cleared[e[4]] == null && num(e[0]) > 0) cleared[e[4]] = e[0];
  }
  for (let bi = 0; bi < BOSSES.length; bi++) {
    const at = Herd.firstClearMs(state, bi);
    if (at != null && !(cleared[bi] <= at)) cleared[bi] = at;
  }
  return { rt, version: rt.version, pairs, liveOf, fights, maxL, maxByType, counts, cleared };
}

function indexOf(world) {
  const rt = world.rt;
  if (!INDEX || INDEX.rt !== rt || INDEX.version !== rt.version || INDEX.state !== world.state) {
    INDEX = buildIndex(world);
    INDEX.state = world.state;
  }
  return INDEX;
}

function ctxOf(world, hero) {
  return heroCtx(world, hero);
}

function statsOf(world, hero) {
  return stats(hero, ctxOf(world, hero));
}

const inRoster = (world, hero) => !!hero && hero.id > 0 && world.state.heroes.includes(hero);

/** Boss pool left 0..1 (body, heads and services; tentacles and adds do not count). */
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

const leftPct = (f) => {
  const l = fightLeft(f);
  return l > 0 ? Math.max(1, Math.ceil(l * 100)) : 0;
};

function reviewTitle(idx) {
  const r = REVIEWS[idx];
  return r && r.reward ? `${r.reward.title} Review` : "Promotion review";
}

function fightLine(f) {
  if (f.kind === "review") return `${reviewTitle(f.reviewIdx)} against ${str(f.name, "the reviewer")}: ${leftPct(f)}% left`;
  return `Fighting ${str(f.name, "the boss")}: ${leftPct(f)}% left`;
}

function mapLabel(world, mapId, live) {
  if (!mapId) return "";
  if (mapId === BACKLOG.id) {
    const f = num(live && live.floor) || num(world.state.herd.backlog && world.state.herd.backlog.floor, 1);
    return `Backlog floor ${Math.max(1, f)}`;
  }
  const m = MAP_BY_ID[mapId];
  return m ? `${m.id} ${m.name}` : str(mapId);
}

function mapLevels(m) {
  return m ? `Lv ${m.levels[0]}–${m.levels[1]}` : "";
}

function zoneOfMap(mapId) {
  if (mapId === BACKLOG.id) return BACKLOG.n;
  const m = MAP_BY_ID[mapId];
  return m ? m.zone : -1;
}

function seatParts(seat) {
  const s = str(seat);
  const i = s.lastIndexOf("/");
  return i >= 0 ? { space: s.slice(0, i), program: s.slice(i + 1) } : { space: "", program: s };
}

function programName(key, program) {
  if (program && program.name) return str(program.name);
  if (PROGRAM_NAMES[key]) return PROGRAM_NAMES[key];
  return key ? cap1(key) : "Agent";
}

function heroState(live) {
  return live ? live.state || "resting" : "off";
}

function blockedSec(rt, live) {
  if (live && live.blockedSince != null) return Math.max(0, num(rt.tick) - num(live.blockedSince));
  return 0;
}

function shiftMinToday(world, hero) {
  const sh = hero.shift;
  if (!sh) return 0;
  return sh.day === world.state.herd.day ? num(sh.min) : 0;
}

function pendingSummary(hero) {
  const pend = hero.pend || [];
  if (!pend.length) return null;
  let seals = 0;
  let best = null;
  let title = "";
  let oldest = Infinity;
  for (const p of pend) {
    const c = chestInfo(p);
    seals += c.seals;
    if (!best || c.raw > best.raw) best = c;
    const named = tellingTitle(c.title, null); // a chest from an older save may carry a shell name
    if (named) title = named;
    oldest = Math.min(oldest, num(p.at, Infinity));
  }
  return { n: pend.length, seals, tier: cap1(best ? best.tier : "wooden"), title, oldest };
}

// ---------------------------------------------------------------------------------------------
// Items: names, stats, text
// ---------------------------------------------------------------------------------------------

const rarOf = (item) => RARITIES[item.rar] || RARITIES[0];

function itemIcon(item) {
  const b = baseOf(item);
  if (b.slot === "weapon") return `gear/weapon-${b.cls || "intern"}.svg`;
  return `ui/slot-${b.slot}.svg`;
}

/** "Release weapon (Blades)" / "Beta hoodie". */
function kindText(item, withType = true) {
  const b = baseOf(item);
  const t = b.slot === "weapon" && withType ? ` (${WEAPON_NAME[b.type] || "Weapon"})` : "";
  return `${rarOf(item).name} ${b.slot}${t}`;
}

const AFFIX_WORD = {
  dmg: "damage", crit: "crit chance", critDmg: "crit damage", extraAct: "extra-action chance", armorPct: "armor",
  hpPct: "max HP", repeatHit: "chance a hit repeats at 50%", areaDmg: "area damage", bossDmg: "boss damage", xp: "XP",
  gold: "gold", itemFind: "item find", regenPct: "max HP regen per tick", dmgTaken: "damage taken", cdr: "cooldowns",
  dmgBelowHalfHp: "damage while below 50% HP", dodge: "dodge",
};

function affixText(ai, roll, tier) {
  const a = AFFIXES[ai] || AFFIXES[0];
  const v = affixValue(ai, roll, tier);
  if (a.stat === "cdr") return `${MINUS}${pct(v).replace(MINUS, "")} cooldowns`;
  return `${pct(v, { sign: true })} ${AFFIX_WORD[a.stat] || a.stat}`;
}

const PROP_TEXT = {
  tenx: (e) => `Every ${e.everyNthAction}th action deals ×${e.dmgMult} damage (a “10x” pops).`,
  flag: (e) => `Every ${e.alternateEveryTicks} ticks switches between ${pctI(e.dmg)} damage and ${pctI(e.armorPct)} armor.`,
  rollback: (e) => `A lethal hit leaves you at ${Math.round(e.lethalLeavesHp * 100)}% HP instead; once per ${e.cooldownTicks} ticks.`,
  scroll: (e) => `The Main attack also hits the next lane mob for ${Math.round(e.mainHitsNext * 100)}%.`,
  reload: (e) => `${Math.round(e.noCooldownChance * 100)}% chance a skill does not go on cooldown.`,
  gc: (e) => `Each kill heals ${Math.round(e.healPerKillPct * 100)}% max HP.`,
  semi: (e) => `Crits have a ${Math.round(e.critRepeatChance * 100)}% chance to strike again.`,
  mug: (e) => `Coffee is free and refills 1 cup per ${e.refillTicksWhileQuesting} ticks even while Questing.`,
  pockets: (e) => `${pctI(e.itemFind)} item find.`,
  stamp: (e) => `Unblocked lasts ${e.unblockedExtraTicks} ticks longer.`,
  hazard_cone_hat: (e) => `${pctI(e.crit)} crit chance, ${pctI(e.xp)} XP.`,
  curly_brace_crown: (e) => `+${e.rankBonus.main} rank to Main and Area (can exceed max).`,
  lazy_quantifier_boots: (e) => `${MINUS}${Math.round(e.cdr * 100)}% cooldowns.`,
  octo_hoodie: (e) => `Area skills hit +${e.areaTargets} target.`,
  lockfile_mug: (e) => `${pctI(e.hpPct)} max HP; coffee heals ${pctI(e.coffeeHeal)}.`,
  mutex_twinfang: (e) => `${pctI(e.bossDmg)} boss damage. Takes the wearer's weapon type.`,
  microservice_badge: (e) => `${pctI(e.dmgPerRoomAlly)} damage per other hero in the room (max ${pctI(e.cap)}).`,
  weekend_pass: (e) => `${pctI(e.freshEyesAccrual)} Fresh Eyes build-up; ${pctI(e.dmgWhileFreshEyes)} damage while Fresh Eyes is active.`,
  uncertainty_lens: (e) => `Each hit has a ${Math.round(e.doubleCountChance * 100)}% chance to count twice.`,
};

function propOf(item) {
  if (item.rar === R_LTS && LTS_PROPS[item.prop]) {
    const p = LTS_PROPS[item.prop];
    return { name: p.name, text: PROP_TEXT[p.id] ? PROP_TEXT[p.id](p.effect) : "" };
  }
  if (item.rar === R_KEEPSAKE && KEEPSAKES[item.prop]) {
    const k = KEEPSAKES[item.prop];
    return { name: k.name, text: PROP_TEXT[k.id] ? PROP_TEXT[k.id](k.effect) : "" };
  }
  return null;
}

/** Can anyone on the roster wear it (level included)? From the per-version roster summary. */
function anyoneCanWear(idx, item) {
  const b = baseOf(item);
  const req = reqLevel(item.ilvl);
  const ks = item.rar === R_KEEPSAKE && KEEPSAKES[item.prop] && KEEPSAKES[item.prop].classAdaptive;
  if (b.slot !== "weapon" || b.anyClass || ks) return idx.maxL >= req;
  return (idx.maxByType[b.type] || 0) >= req;
}

// ---------------------------------------------------------------------------------------------
// Item scores (D§8.7), cached per hero stats object and item content
// ---------------------------------------------------------------------------------------------

// Per hero: the scores priced against its current stats object (`cur`) and the ones from its
// previous stats object (`prev`, used while `cur` fills up). Keyed by hero id; a reloaded world
// (other hero objects) starts afresh. Each new entry first drops the entries of heroes that are
// gone (retired, a departed Contractor: every hire gets a fresh negative id, a reloaded world), so
// the cache stays bounded by the roster plus the live Contractors (pruneScores).
const SCORES = new Map();
/** New scores priced per stash list (one scoreDelta is ~0.5 ms in QuickJS; 140 items would not fit). */
const SCORE_BUDGET = 16;

const fresh = (hit, item) => hit && hit[0] === item && hit[1] === item.pol && hit[2] === item.aff;

/**
 * A scorer for one hero: get(item, force) is the autopilot score (fraction, D§8.7) of putting
 * `item` on the hero (0 for the item it wears). Cached per (hero stats object, item); at most
 * SCORE_BUDGET new prices per scorer unless forced (the focused card always is). Past the budget an
 * item reads its score from the hero's previous stats (stale by one level-up or gear change) or
 * null, and the next call (the next tick) prices it: the stash list settles within a few ticks.
 */
function scorer(world, hero) {
  const ctx = ctxOf(world, hero);
  const st = stats(hero, ctx);
  let e = SCORES.get(hero.id);
  if (!e || e.hero !== hero) {
    pruneScores(world);
    e = { hero, st, cur: new Map(), prev: null };
    SCORES.set(hero.id, e);
  } else if (e.st !== st) {
    e.prev = e.cur;
    e.cur = new Map();
    e.st = st;
  }
  let budget = SCORE_BUDGET;
  return {
    get(item, force) {
      const hit = e.cur.get(item.uid);
      if (fresh(hit, item)) return hit[3];
      if (budget > 0 || force) {
        budget--;
        const si = slotIdxOf(item);
        const v = hero.eq[si] === item ? 0 : scoreDelta(hero, item, si, ctx);
        const sc = Number.isFinite(v) ? v : 0;
        e.cur.set(item.uid, [item, item.pol, item.aff, sc]);
        return sc;
      }
      const old = e.prev ? e.prev.get(item.uid) : null;
      return fresh(old, item) ? old[3] : null;
    },
  };
}

/** The score of one item on one hero, always priced (cards, equip buttons, "best on"). */
function scoreOf(world, hero, item) {
  return scorer(world, hero).get(item, true);
}

function scoreVM(s) {
  const x = Math.round(num(s) * 1000) / 10;
  const good = x > 0 ? true : x < 0 ? false : null;
  return { text: `${x < 0 ? MINUS : "+"}${Math.abs(x).toFixed(1)}%`, good };
}

// stat deltas of the compare block: [key, label, read(st), kind]
const DELTAS = [
  ["wd", "Weapon damage", (s) => s.weaponDmg, "abs"],
  ["armor", "Armor", (s) => s.armor, "abs"],
  ["dps", "DPS", (s) => s.dpsEst, "rel"],
  ["ehp", "EHP", (s) => s.ehp, "rel"],
  ["dmg", "Damage", (s) => s.dmgPct, "pct"],
  ["hp", "Max HP", (s) => s.maxHp, "abs"],
  ["crit", "Crit chance", (s) => s.crit, "pct"],
  ["critx", "Crit damage", (s) => s.critMult, "pct"],
  ["area", "Area damage", (s) => s.areaDmg, "pct"],
  ["boss", "Boss damage", (s) => s.bossDmg, "pct"],
  ["low", "Below 50% HP", (s) => s.dmgBelowHalfHp, "pct"],
  ["cdr", "Cooldowns", (s) => -s.cdr, "pctInv"],
  ["dodge", "Dodge", (s) => s.dodge, "pct"],
  ["taken", "Damage taken", (s) => s.dmgTaken, "pctLow"],
  ["xact", "Extra action", (s) => s.extraAct, "pct"],
  ["rep", "Repeat hits", (s) => s.repeatHit, "pct"],
  ["regen", "Regen", (s) => s.regenPct, "pct"],
  ["xp", "XP", (s) => s.xpPct, "pct"],
  ["gold", "Gold", (s) => s.goldPct, "pct"],
  ["if", "Item find", (s) => s.itemFind, "pct"],
];
const MAX_DELTAS = 5;

/** Stat deltas of wearing `item` instead of what `hero` wears in its slot (plus Item Power). */
function statDeltas(world, hero, item) {
  const ctx = ctxOf(world, hero);
  const cur = stats(hero, ctx);
  const si = slotIdxOf(item);
  const eq = hero.eq.slice();
  eq[si] = item;
  const alt = computeStats(hero, ctx, eq);
  const out = [];
  for (const [key, label, read, kind] of DELTAS) {
    if (out.length >= MAX_DELTAS) break;
    const a = num(read(cur));
    const b = num(read(alt));
    let text = null;
    let good = null;
    if (kind === "abs") {
      const d = b - a;
      if (Math.abs(d) < 0.05) continue;
      text = Math.abs(d) >= 10 ? `${d < 0 ? MINUS : "+"}${fmtInt(Math.abs(d))}` : `${d < 0 ? MINUS : "+"}${Math.abs(d).toFixed(1)}`;
      good = d > 0;
    } else if (kind === "rel") {
      if (!(a > 0)) continue;
      const d = b / a - 1;
      if (Math.abs(d) < 0.0005) continue;
      text = pct(d, { sign: true });
      good = d > 0;
    } else {
      const d = b - a;
      if (Math.abs(d) < 0.0005) continue;
      text = pct(d, { sign: true });
      good = kind === "pctLow" || kind === "pctInv" ? d < 0 : d > 0;
    }
    out.push({ key, label, text, good });
  }
  const old = hero.eq[si];
  const dip = itemIP(item) - (old ? itemIP(old) : 0);
  if (dip !== 0) out.push({ key: "ip", label: "Item Power", text: `${dip < 0 ? MINUS : "+"}${fmtInt(Math.abs(dip))}`, good: dip > 0 });
  return out;
}

// ---------------------------------------------------------------------------------------------
// ItemVM, CardVM and the item actions
// ---------------------------------------------------------------------------------------------

function itemTooltip(item, extra) {
  const parts = [kindText(item), `iLvl ${item.ilvl}`, `req Lv ${reqLevel(item.ilvl)}`, `IP ${fmtInt(itemIP(item))}`];
  if (extra) parts.push(extra);
  return parts.join(" · ");
}

/** ItemVM (ui/sheet.js). o: { usable, delta, squashable, note } */
function itemVM(item, o = {}) {
  const r = rarOf(item);
  return {
    key: `it:${item.uid}`, uid: item.uid, name: itemName(item), rar: item.rar, rarColor: r.color, rarName: r.name,
    icon: itemIcon(item), ilvl: `iLvl ${item.ilvl}`, ip: fmtInt(itemIP(item)), pol: item.pol > 0 ? `+${item.pol}` : null,
    locked: !!(item.flags & FLAG_LOCKED), isNew: !!(item.flags & FLAG_NEW), usable: o.usable !== false,
    delta: o.delta || null, squashable: !!o.squashable,
    tooltip: itemTooltip(item, o.note || (o.delta ? `score ${o.delta.text}` : null)),
  };
}

function statWord(item) {
  const slot = baseOf(item).slot;
  return slot === "weapon" ? "weapon damage" : slot === "sticker" ? "Item Power" : "armor";
}

function polishAction(world, item) {
  const herd = world.state.herd;
  const c = nextPolishCost(world.state, item);
  const key = `polish:${item.uid}`;
  if (!c) return disabled(key, "Polished", "polish", { uid: item.uid }, `Fully polished: +${polishMax(item.rar)} is the ${rarOf(item).name} maximum`);
  const short = shortfall(herd, c.gold, c.snippets);
  return action(key, "Polish", "polish", { uid: item.uid }, {
    cost: costText(c.gold, c.snippets), enabled: !short,
    tooltip: short || `+5% ${statWord(item)} (to +${item.pol + 1}); always succeeds`,
  });
}

function lockAction(item) {
  const locked = !!(item.flags & FLAG_LOCKED);
  return action(`lock:${item.uid}`, locked ? "Unlock" : "Lock", "lock", { uid: item.uid, locked: !locked }, {
    tooltip: locked ? "Lets autopilot replace, deprecate or squash it again" : "Locked items are never replaced, deprecated or squashed",
  });
}

function deprecateAction(item) {
  const key = `deprecate:${item.uid}`;
  const args = { uid: item.uid };
  if (item.rar === R_KEEPSAKE) return disabled(key, "Deprecate", "deprecate", args, "Keepsakes are never deprecated");
  if (item.flags & FLAG_LOCKED) return disabled(key, "Deprecate", "deprecate", args, "Locked: unlock it first");
  const y = deprecateYield(item.ilvl, item.rar);
  return action(key, "Deprecate", "deprecate", args, {
    cost: `+${snipText(y.snippets)}`, tone: "danger", confirm: item.rar >= 3 ? `Deprecate this ${rarOf(item).name}?` : "Deprecate it?",
    tooltip: `Salvage for ${snipText(y.snippets)} and ${goldText(y.gold)}`,
  });
}

function rerollAction(world, item, i) {
  if (item.rar < 1 || item.rar === R_KEEPSAKE) return null;
  if (Herd.buildingLevel(world.state, FORGE) < FORGE_REROLL) return null;
  const t = itemTier(item.ilvl);
  const g = 50 * goldOf(item.ilvl);
  const s = 10 * t;
  const short = shortfall(world.state.herd, g, s);
  return action(`reroll:${item.uid}:${i}`, "Reroll", "reroll", { uid: item.uid, affix: i }, {
    cost: costText(g, s), enabled: !short, confirm: "Reroll this affix?",
    tooltip: short || "Rerolls the affix's type and value (never a duplicate)",
  });
}

/**
 * The equip button for putting `item` on `hero`, or null when it already wears it. label: the
 * button text. Disabled with the reason when the hero cannot take it now.
 */
function equipAction(world, hero, item, wearer, label) {
  if (!hero || wearer === hero) return null;
  const key = `equip:${item.uid}`;
  const args = { heroId: hero.id, uid: item.uid };
  const first = firstName(hero);
  if (!inRoster(world, hero)) return disabled(key, label, "equip", args, "Contractors can't take gear from vendor/");
  if (!canEquip(hero, item, { ignoreLevel: true })) {
    const b = baseOf(item);
    return disabled(key, label, "equip", args, `Only a ${classOfWeapon(b.type)} can wield ${WEAPON_NAME[b.type] || "it"}`);
  }
  const req = reqLevel(item.ilvl);
  if (hero.L < req) return disabled(key, label, "equip", args, `Needs Lv ${req} (${first} is Lv ${hero.L})`);
  const cur = hero.eq[slotIdxOf(item)];
  if (cur && cur.flags & FLAG_LOCKED) return disabled(key, label, "equip", args, `${itemName(cur)} is locked: unlock it first`);
  const port = cur ? Math.max(0, Math.min(Math.floor(cur.pol / 2), polishMax(item.rar) - item.pol)) : 0;
  let tip = cur ? `${itemName(cur)} goes to vendor/` : `Fills ${first}'s empty ${baseOf(item).slot} slot`;
  if (port > 0) tip = `${first}'s +${cur.pol} polish ports +${port} to it, free; ${itemName(cur)} goes to vendor/`;
  if (wearer) tip = `Takes it from ${firstName(wearer)}. ${tip}`;
  const s = cur ? scoreOf(world, hero, item) : 0;
  if (s < -0.0005) tip = `A downgrade for ${first} (score ${scoreVM(s).text}). ${tip}`;
  return action(key, label, "equip", args, { tone: s >= -0.0005 ? "primary" : null, tooltip: tip });
}

function classOfWeapon(type) {
  const c = CLASSES.find((x) => x.weapon === type);
  return c ? c.name : "hero of another class";
}

/**
 * CardVM for one item. o: { target: the hero to compare with (sheet: the sheet's hero; herd: the
 * best hero) or null, mode: "sheet"|"herd", best: {hero, score}|null }
 */
function cardVM(world, idx, found, o) {
  const item = found.item;
  const wearer = found.where === "hero" ? found.hero : null;
  const inStash = found.where === "stash";
  const target = o.target || null;
  const b = baseOf(item);
  const is = itemStats(item);
  let usable = true;
  if (o.mode === "sheet") usable = !!target && canEquip(target, item);
  else usable = anyoneCanWear(idx, item);

  let vs = null;
  let deltas = [];
  let score = null;
  if (target && wearer !== target) {
    if (!canEquip(target, item, { ignoreLevel: true })) {
      vs = `A ${classOfWeapon(b.type)} weapon (${WEAPON_NAME[b.type] || "class-typed"})`;
    } else {
      const cur = target.eq[slotIdxOf(item)];
      const whose = o.mode === "herd" ? `${firstName(target)}'s ` : "";
      vs = cur ? `vs ${whose}${itemName(cur)} (equipped)` : `vs ${whose}empty ${b.slot} slot`;
      deltas = statDeltas(world, target, item);
      score = scoreVM(o.best ? o.best.score : scoreOf(world, target, item));
    }
  }
  const delta = score && o.mode === "sheet" ? score : null;
  const base = itemVM(item, { usable, delta, squashable: false });
  const t = itemTier(item.ilvl);

  let stat = null;
  if (b.slot === "weapon") stat = `Weapon damage ${fmtInt(is.weaponDmg)}`;
  else if (b.slot !== "sticker") stat = `Armor ${fmtInt(is.armor)}${is.coffeeHeal > 0 ? ` · coffee ${pctI(is.coffeeHeal)}` : ""}`;

  let owner = null;
  if (wearer) owner = `Worn by ${wearer.name}`;
  else if (o.mode === "herd") {
    if (o.best && o.best.score < -0.0005) owner = `An upgrade for nobody · least loss on ${o.best.hero.name} (score ${scoreVM(o.best.score).text})`;
    else if (o.best) owner = `Best on ${o.best.hero.name} · score ${scoreVM(o.best.score).text}`;
    else owner = idx.maxL > 0 ? "Nobody on the roster can wear it yet" : "No heroes yet";
  }
  let flavor = null;
  if (item.rar === R_KEEPSAKE && KEEPSAKES[item.prop]) {
    const boss = BOSSES[KEEPSAKES[item.prop].boss];
    if (boss) flavor = `From ${boss.name}. ${boss.flavor}`;
  }

  const actions = [];
  const label = o.mode === "herd" && target ? `Equip on ${firstName(target)}` : "Equip";
  const eq = target ? equipAction(world, target, item, wearer, label) : null;
  if (eq) actions.push(eq);
  // A Contractor's kit (negative uids, agents.makeContractor) is not in the saved state: world.command
  // refuses lock / polish / reroll on it ("No such item"), so the buttons only explain.
  const kit = !(item.uid > 0);
  if (kit) {
    const why = "A contractor's kit is not saved: it leaves with the contractor";
    actions.push(disabled(`lock:${item.uid}`, "Lock", "lock", { uid: item.uid, locked: true }, why));
    actions.push(disabled(`polish:${item.uid}`, "Polish", "polish", { uid: item.uid }, why));
  } else {
    actions.push(lockAction(item));
    actions.push(polishAction(world, item));
  }
  if (inStash) actions.push(deprecateAction(item));

  return Object.assign(base, {
    sub: `${rarOf(item).name} ${b.slot} · iLvl ${item.ilvl} · req Lv ${reqLevel(item.ilvl)}`,
    stat,
    affixes: item.aff.map((a, i) => ({ key: `${item.uid}:${i}`, text: affixText(a[0], a[1], t), reroll: kit ? null : rerollAction(world, item, i) })),
    prop: propOf(item),
    polish: `Polish +${item.pol} of +${polishMax(item.rar)}`,
    vs, deltas, score, owner, flavor, actions,
  });
}

/**
 * The focused item: hover when it still exists, else the selection, else `focus`. A Contractor's
 * kit is not in the saved state (agents.makeContractor), so the sheet's own hero is searched too.
 */
function focusedItem(world, f, hero) {
  for (const uid of [f.hover, f.selected, f.focus]) {
    if (!Number.isInteger(uid)) continue;
    const found = findItem(world.state, uid);
    if (found) return found;
    if (hero && hero.contractor) {
      const s = hero.eq.findIndex((it) => it && it.uid === uid);
      if (s >= 0) return { item: hero.eq[s], where: "hero", hero, slot: s, index: s };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Stash: filter, sort, chips, Squash Merge
// ---------------------------------------------------------------------------------------------

const SORTS = ["score", "ip", "new"];

function intOrNull(v) {
  const n = Number(v);
  return v != null && Number.isInteger(n) ? n : null;
}

/** A clean StashFilter from whatever the role sent. */
function normFilter(f) {
  const x = f && typeof f === "object" ? f : {};
  const slot = SLOTS.includes(x.slot) ? x.slot : "all";
  const minRar = Math.max(0, Math.min(RARITIES.length - 1, Math.floor(num(Number(x.minRar)))));
  const sort = SORTS.includes(x.sort) ? x.sort : "score";
  const squash = Array.isArray(x.squash) ? x.squash.map(intOrNull).filter((u) => u != null).slice(0, 6) : [];
  return {
    slot, minRar, usable: !!x.usable, sort, focus: intOrNull(x.focus), hover: intOrNull(x.hover), selected: intOrNull(x.selected),
    squash,
  };
}

function filterChips(f, mode) {
  const herd = mode === "herd";
  const sortDefs = herd
    ? [["score", "Best", "Usable, rarest and strongest first"], ["ip", "IP", "Highest Item Power first"], ["new", "New", "Newest first"]]
    : [["score", "Score", "Best upgrade first"], ["ip", "IP", "Highest Item Power first"], ["new", "New", "Newest first"]];
  return {
    slot: [{ key: "slot-all", label: "All", icon: null, color: null, on: f.slot === "all", set: { slot: "all" }, tooltip: "Every slot" }]
      .concat(SLOTS.map((s) => ({ key: `slot-${s}`, label: SLOT_LABEL[s], icon: `ui/slot-${s}.svg`, color: null, on: f.slot === s, set: { slot: s }, tooltip: SLOT_LABEL[s] }))),
    rarity: RARITIES.map((r, i) => ({
      key: `rar-${i}`, label: r.name, icon: null, color: r.color, on: f.minRar === i, set: { minRar: i },
      tooltip: i === 0 ? "Any rarity" : `${r.name} or better`,
    })),
    toggles: [{
      key: "usable", label: "Usable", icon: null, color: null, on: f.usable, set: { usable: !f.usable },
      tooltip: herd
        ? (f.usable ? "Showing what someone on the roster can wear" : "Only what someone on the roster can wear")
        : (f.usable ? "Showing what this hero can wear" : "Only what this hero can wear"),
    }],
    sort: sortDefs.map(([id, label, tip]) => ({ key: `sort-${id}`, label, icon: null, color: null, on: f.sort === id, set: { sort: id }, tooltip: `Sort: ${tip}` })),
  };
}

/** Squash Merge picks view.js accepts: in the stash, unlocked, Prototype–Beta, one rarity, ≤ 3. */
function cleanPicks(world, uids) {
  const out = [];
  let rar = null;
  const items = [];
  for (const uid of uids) {
    if (out.includes(uid)) continue;
    const f = findItem(world.state, uid);
    if (!f || f.where !== "stash") continue;
    const it = f.item;
    if (it.flags & FLAG_LOCKED || it.rar > SQUASH_MAX_RAR) continue;
    if (rar != null && it.rar !== rar) continue;
    rar = it.rar;
    out.push(uid);
    items.push(it);
    if (out.length >= 3) break;
  }
  return { uids: out, rar, items };
}

function squashVM(world, f) {
  const herd = world.state.herd;
  const off = () => ({
    available: false, reason: `CI Forge level ${FORGE_SQUASH} unlocks Squash Merge`, picked: [], label: "",
    action: disabled("squash", "Squash Merge", "squash", { uids: [] }, `CI Forge level ${FORGE_SQUASH} unlocks Squash Merge`),
  });
  if (Herd.buildingLevel(world.state, FORGE) < FORGE_SQUASH) return { vm: off(), rar: null, picked: [] };
  const p = cleanPicks(world, f.squash);
  const n = p.uids.length;
  let label = "Pick 3 unlocked items of one rarity (Prototype, Alpha or Beta).";
  if (n > 0) label = `${n} of 3 ${RARITIES[p.rar].name} picked → 1 ${RARITIES[p.rar + 1].name} item`;
  let act;
  if (n < 3) {
    act = disabled("squash", "Squash Merge", "squash", { uids: p.uids.slice() }, `Pick ${3 - n} more`, { tone: "primary" });
  } else {
    const ilvl = Math.round((p.items[0].ilvl + p.items[1].ilvl + p.items[2].ilvl) / 3);
    const cost = 20 * goldOf(ilvl);
    const short = shortfall(herd, cost, 0);
    act = action("squash", "Squash Merge", "squash", { uids: p.uids.slice() }, {
      cost: goldText(cost), enabled: !short, tone: "primary",
      tooltip: short || `3 items become 1 random ${RARITIES[p.rar + 1].name} item at iLvl ${ilvl}`,
    });
  }
  return { vm: { available: true, reason: null, picked: p.uids.slice(), label, action: act }, rar: p.rar, picked: p.uids };
}

const isSquashable = (item, rar) => !(item.flags & FLAG_LOCKED) && item.rar <= SQUASH_MAX_RAR && (rar == null || item.rar === rar);

/**
 * StashVM rows for a filter. mode "sheet": usable and score for `hero`; "herd": usable by anyone.
 * Returns {vm, squash}.
 */
function stashVM(world, idx, f, mode, hero) {
  const state = world.state;
  const all = state.herd.stash || [];
  const cap = stashCap(state);
  const sq = squashVM(world, f);
  const usableOf = mode === "sheet"
    ? (it) => !!hero && canEquip(hero, it)
    : (it) => anyoneCanWear(idx, it);
  const rows = [];
  const sc = mode === "sheet" && hero ? scorer(world, hero) : null;
  for (const it of all) {
    if (f.slot !== "all" && baseOf(it).slot !== f.slot) continue;
    if (it.rar < f.minRar) continue;
    const usable = usableOf(it);
    if (f.usable && !usable) continue;
    rows.push({ it, usable, score: null, ip: itemIP(it), fit: !!sc && canEquip(hero, it, { ignoreLevel: true }) });
  }
  if (sc) {
    // price the strongest items first, so a partly priced list still leads with the likely upgrades
    const order = rows.filter((r) => r.fit).sort((a, b) => b.ip - a.ip || b.it.uid - a.it.uid);
    for (const r of order) r.score = sc.get(r.it, false);
  }
  if (f.sort === "ip") rows.sort((a, b) => b.ip - a.ip || b.it.uid - a.it.uid);
  else if (f.sort === "new") rows.sort((a, b) => b.it.uid - a.it.uid);
  else if (mode === "sheet") {
    rows.sort((a, b) => (b.score != null) - (a.score != null) || num(b.score) - num(a.score) || b.ip - a.ip || b.it.uid - a.it.uid);
  } else {
    rows.sort((a, b) => b.usable - a.usable || b.it.rar - a.it.rar || b.ip - a.ip || b.it.uid - a.it.uid);
  }
  const shown = rows.slice(0, STASH_ROWS[mode]);
  const items = shown.map((r) => {
    let note = null;
    if (!r.usable) {
      if (mode === "herd") note = "nobody on the roster can wear it yet";
      else if (hero && !canEquip(hero, r.it, { ignoreLevel: true })) note = `a ${classOfWeapon(baseOf(r.it).type)}'s`;
      else note = `${firstName(hero)} needs Lv ${reqLevel(r.it.ilvl)}`;
    }
    const delta = r.score != null ? scoreVM(r.score) : null;
    return itemVM(r.it, { usable: r.usable, delta, squashable: isSquashable(r.it, sq.rar), note: note || (delta ? `score ${delta.text}` : null) });
  });
  const more = rows.length > shown.length ? `+${rows.length - shown.length} more: narrow the filter` : null;
  return {
    vm: {
      title: "vendor/", count: `${all.length} / ${cap}`, fill: cap > 0 ? clamp01(all.length / cap) : 0, full: all.length >= cap,
      items, more,
      emptyText: all.length === 0 ? "Nothing in vendor/ yet. Gear the autopilot keeps lands here." : "Nothing matches this filter.",
      filters: filterChips(f, mode),
    },
    squash: sq.vm,
  };
}

// ---------------------------------------------------------------------------------------------
// The sheet: header
// ---------------------------------------------------------------------------------------------

function rigOf(hero, live, state) {
  const clsId = (CLASSES[hero.cls] || CLASSES[0]).id;
  const programKey = live ? (live.program && live.program.key) || live.app : seatParts(hero.seat).program;
  const wpn = hero.eq && hero.eq[0];
  const wt = wpn ? itemTier(wpn.ilvl || 1) : 0;
  const hat = hero.eq && hero.eq[1];
  const ht = hat ? itemTier(hat.ilvl || 1) : 0;
  return {
    colors: termlingColors(hero, programKey, state),
    face: faceOf(state),
    weapon: wpn ? { clsId, color: ITEM_BASES.weaponTierTones[wt - 1], edge: wt === 5 } : null,
    hat: ht ? { tier: ht, color: HAT_COLORS[(hat.uid || 0) % HAT_COLORS.length] } : null,
    accessory: clsId,
    programIcon: live ? programIconOf(live.program) : programIconOf(shippedProgram(programKey)),
  };
}

const TINTED_ICONS = { pi: 1, opencode: 1, cursor: 1, copilot: 1, gemini: 1, grok: 1, goose: 1, agent: 1 };
const KNOWN_ICONS = { claude: 1, codex: 1, pi: 1, opencode: 1, gemini: 1, cursor: 1, copilot: 1, amp: 1, grok: 1, goose: 1, kimi: 1, kiro: 1, crush: 1 };

function shippedProgram(key) {
  if (!key || !KNOWN_ICONS[key]) return null;
  return { key, icon: `icons/${key}.svg`, tint: !!TINTED_ICONS[key], color: "#ffffff" };
}

function activityOf(world, idx, hero, live) {
  const rt = world.rt;
  const fight = idx.fights.get(hero.id);
  if (fight) return fight.kind === "review" ? `in the ${reviewTitle(fight.reviewIdx)}` : `fighting ${str(fight.name, "a boss")}`;
  const st = heroState(live);
  switch (st) {
    case "crashed": return "rebooting";
    case "waiting": return `waiting for you ${fmtDuration(blockedSec(rt, live))}`;
    case "supervising": {
      const n = (live.forklings || []).filter((x) => x.status === "working").length;
      return `supervising ${n} ${plural(n, "Forkling")}`;
    }
    case "shipped": return hero.pend && hero.pend.length ? "shipped · chest waiting" : "shipped";
    case "resting": return "resting at the campfire";
    default: {
      const where = mapLabel(world, live.mapId, live);
      return where ? `fighting ${where}` : "questing";
    }
  }
}

function buffChips(world, hero, live) {
  const rt = world.rt;
  const out = [];
  const seen = new Set();
  if (live) {
    const ct = num(live.ct);
    for (const b of live.buffs || []) {
      if (!(num(b.until) > ct) || seen.has(b.id)) continue;
      seen.add(b.id);
      const left = Math.max(1, Math.round(b.until - ct));
      const room = /_room$/.test(str(b.id));
      const sk = SKILL_BY_ID[str(b.id).replace(/_room$/, "")];
      const name = b.id === "unblocked" ? "Unblocked" : sk ? sk.name : cap1(str(b.id).replace(/_/g, " "));
      const fx = [];
      if (b.dmg) fx.push(`${pctI(b.dmg)} damage`);
      if (b.dmgTaken) fx.push(`${pctI(b.dmgTaken)} damage taken`);
      if (b.xp) fx.push(`${pctI(b.xp)} XP`);
      if (b.crit) fx.push("every hit crits");
      if (b.untargetable) fx.push("untargetable");
      const color = b.id === "unblocked" ? COL.working : sk ? CLASS_COLORS[sk.cls] || COL.xp : COL.xp;
      out.push({
        key: str(b.id), text: `${name} ${left}s`, color,
        tooltip: `${name}${room ? " (from an ally)" : ""}: ${fx.length ? fx.join(", ") : "active"} (${left} ${plural(left, "tick")} left)`,
      });
    }
  }
  if (!seen.has("unblocked") && unblockedActive(hero, num(rt.tick))) {
    const left = unblockedLeft(hero, num(rt.tick));
    const U = T.unblocked;
    out.push({ key: "unblocked", text: "Unblocked", color: COL.working, tooltip: `Unblocked: ${pctI(U.dmg)} damage and ${pctI(U.xp)} kill XP (${left} Questing ${plural(left, "tick")} left)` });
  }
  if (Herd.onboardingBonus(world.state, hero) > 0) {
    out.push({ key: "onboarding", text: "New hire", color: COL.fresh, tooltip: `Onboarding: ${pctI(T.onboarding.xp)} XP while ${firstName(hero)} is ${T.onboarding.levelsBehind}+ levels behind the herd's top hero` });
  }
  return out.slice(0, 6);
}

function xpTooltip(world, hero, live) {
  if (hero.L >= T.levelCap) return "Maintenance mode: every 1% of a level's XP becomes 1 Snippet for the herd";
  if (!live) {
    const cap = Herd.freshEyesCapMin(world.state);
    const started = num(hero.st && hero.st.seals) > 0;
    return `Off duty: no XP. Fresh Eyes builds up (1 min per 4, up to ${cap} min)${started ? "" : ` once ${firstName(hero)} has shipped a chest`}`;
  }
  const w = whyLine(live.why || null, { level: hero.L });
  return w || "Working out the XP rate…";
}

function shiftVM(world, hero) {
  const min = shiftMinToday(world, hero);
  const [b1, b2] = T.shift.bandsMin;
  const text = fmtMin(min);
  let tip = `Daily Shift: ${text} worked today. Full rewards until ${b1 / 60}h, then half until ${b2 / 60}h, a quarter after. Resets at 0${T.shift.resetHourLocal}:00.`;
  if (min <= 0) tip = `Daily Shift: nothing worked today. Full rewards for the first ${b1 / 60}h. Resets at 0${T.shift.resetHourLocal}:00.`;
  return { frac: r2(clamp01(min / b1)), text, tooltip: tip };
}

function powerVM(st, hero) {
  const pl = Math.round(num(st.pl, hero.L));
  const gear = pl - hero.L;
  return {
    text: `PL ${pl}`,
    tooltip: `Power Level ${pl} = Lv ${hero.L} ${gear < 0 ? MINUS : "+"} gear ${Math.abs(gear)}: fights like a Lv ${pl}`,
  };
}

function headerVM(world, idx, hero, live, st, clock) {
  const rt = world.rt;
  const state = heroState(live);
  const career = careerOf(hero);
  const seat = seatParts(hero.seat);
  const programKey = live ? (live.program && live.program.key) || live.app : seat.program;
  const space = live ? str(live.spaceName).trim() || str(live.space) || seat.space : seat.space;
  const prog = programName(programKey, live && live.program);
  const where = live ? activityOf(world, idx, hero, live) : `last seen ${fmtWhen(num(hero.seenAt, clock.now), clock)}`;
  const sub = [space || "no space", prog, where].join(" · ");
  // the label the party and pane header use (chrome.taskLabel): never a bare program or shell title
  const quest = live ? taskLabel(live) || null : null;
  const maxHp = live && num(live.maxHp) > 0 ? live.maxHp : num(st.maxHp, 1);
  const hp = live && num(live.maxHp) > 0 ? num(live.hp) : maxHp * clamp01(num(hero.hpFrac, 1));
  const xpFrac = xpFracOf(hero);
  let tag = null, tagTip = null, tagTab = null;
  if (hero.contractor) tag = "contractor";
  else if (!live) tag = "off duty";
  else if (hero.cls > 0 && hero.prov) {
    // D§4.2: behaviour may still switch the class until it locks; the person can lock it now (the
    // Career tab's class chip; the tag links there).
    tag = "provisional";
    tagTip = `${provisionalText(hero)}: ${firstName(hero)}'s behaviour can still switch it. Lock it with its class chip on the Career tab.`;
    tagTab = "career";
  }
  return {
    name: str(hero.name, "Termling"), level: `Lv ${hero.L}`, title: career.title, tag, tagTip, tagTab, sub, quest,
    status: live ? statusWord(live.status) : "off",
    hp: { frac: r2(clamp01(hp / maxHp)), text: `${fmtInt(hp)} / ${fmtInt(maxHp)}` },
    xp: {
      frac: r2(xpFrac), feFrac: r2(feFracOf(hero, xpFrac)), text: hero.L >= T.levelCap ? "MAX" : `${(Math.floor(xpFrac * 1000) / 10).toFixed(1)}%`,
      tooltip: xpTooltip(world, hero, live),
    },
    shift: shiftVM(world, hero),
    fe: num(hero.fe) >= 1 ? `Fresh Eyes ${fmtMin(hero.fe)}` : null,
    power: powerVM(st, hero),
    buffs: buffChips(world, hero, live),
    rig: rigOf(hero, live, state),
    focus: live && live.address ? { pane: live.pane ? str(live.pane) : null, address: str(live.address) } : null,
  };
}

function noteVM(world, idx, hero, live, clock) {
  if (hero.contractor) return { text: "Contractor: not saved · its kills and chests still pay the herd · Contractors don't get equity.", color: COL.idle };
  const fight = idx.fights.get(hero.id);
  if (fight) return { text: fightLine(fight), color: COL.hp };
  if (!live) {
    const pend = hero.pend && hero.pend.length;
    return {
      text: `Off duty since ${fmtWhen(num(hero.seenAt, clock.now), clock)} · Fresh Eyes keeps building${pend ? ` · ${pend} ${plural(pend, "chest")} ${pend === 1 ? "waits" : "wait"}` : ""}`,
      color: COL.idle,
    };
  }
  if (heroState(live) === "crashed") return { text: `Rebooting: back in ${Math.max(1, num(live.crashedUntil) - num(world.rt.tick))}s`, color: COL.hp };
  return null;
}

// ---------------------------------------------------------------------------------------------
// The sheet: gear tab
// ---------------------------------------------------------------------------------------------

function gearVM(world, idx, hero, st, f) {
  const slots = SLOTS.map((s, i) => {
    const it = hero.eq[i];
    return {
      key: `slot:${hero.id}:${s}`, slot: s, label: SLOT_LABEL[s], icon: `ui/slot-${s}.svg`,
      item: it ? itemVM(it, { usable: true, squashable: false, note: `worn by ${firstName(hero)}` }) : null,
    };
  });
  const found = focusedItem(world, f, hero);
  const card = found ? cardVM(world, idx, found, { target: hero, mode: "sheet" }) : null;
  let ipSum = 0;
  for (const it of hero.eq) if (it) ipSum += itemIP(it);
  const pl = powerVM(st, hero);
  const s = stashVM(world, idx, f, "sheet", hero);
  return {
    slots, card,
    hint: `Pick an item to compare it with what ${firstName(hero)} wears. Autopilot equips upgrades of +2% or better on its own.`,
    summary: [
      { key: "ip", label: "Item Power", value: fmtInt(ipSum), tooltip: "Sum of the equipped items' Item Power" },
      { key: "pl", label: "Power Level", value: String(Math.round(num(st.pl, hero.L))), tooltip: pl.tooltip.replace(/: fights.*$/, "") },
      { key: "dps", label: "DPS (est.)", value: fmtNum(num(st.dpsEst)), tooltip: "Mean single-target damage per tick from a 60-tick dry run of the rotation" },
      { key: "ehp", label: "EHP", value: fmtNum(num(st.ehp)), tooltip: "EHP = Max HP / (1 − DR) / (1 − dodge) against an on-level mob" },
    ],
    stash: s.vm,
    squash: s.squash,
  };
}

// ---------------------------------------------------------------------------------------------
// The sheet: skills tab
// ---------------------------------------------------------------------------------------------

const SLOT_NAME = { main: "Main", area: "Area", passive: "Passive", buff: "Buff", sig: "Signature", ult: "Ultimate", cap: "Capstone" };
const GLYPH = {
  hello_world: "hi", printf: "%d",
  extract_method: "ƒ()", rename_symbol: "foo", strong_typing: ":T", code_review: "LG", big_picture: "▦", big_rewrite: "rw", clean_architecture: "{}",
  quick_patch: "//", cherry_pick: "cp", works_on_my_machine: "404", stealth_commit: "~", bisect: "½", push_to_main: "->", zero_downtime: "0s",
  echo_bolt: ">", pipe_chain: "|", tab_completion: "⇥", sudo: "#", cron_job: "@", midnight_batch: "***", root_access: "~#",
  spawn_process: "&", background_jobs: "&&", process_pool: "pp", daemonize: "d", thundering_herd: ">>>", fork_bomb: "fb", supervisor_tree: "tr",
  quack: "Q", explain_it_out_loud: "...", rubber_duck_debugging: "dk", pair_programming: "{ }", ducklings: "dd", retrospective: "rt", psychological_safety: "ps",
};

function targetsText(t) {
  if (t === "lane") return "every lane mob";
  if (t === "randomLane") return "random lane mobs";
  if (t === "lowestHp") return "the weakest mob";
  if (typeof t === "number" && t > 1) return `up to ${t} lane mobs`;
  return "one mob";
}

/** Skill numbers: one decimal when it matters ("7.5%", "124%"). */
const P0 = (v) => `${Math.round(num(v) * 1000) / 10}%`;
const P1 = (v) => `${num(v) < 0 ? MINUS : "+"}${Math.abs(Math.round(num(v) * 1000) / 10)}%`;

/** The headline number of a skill at a rank (for "Next rank: …"). */
function skillKeyNumber(v) {
  switch (v.type) {
    case "hit": return `${P0(v.coef)}${(v.hits || 1) > 1 ? ` ×${v.hits}` : ""}${v.targets === "lane" || (typeof v.targets === "number" && v.targets > 1) ? " each" : ""}`;
    case "proc": return P0(v.coef);
    case "buff": return v.self && v.self.dmg ? `${P1(v.self.dmg)} damage${v.room && v.room.dmgTaken ? `, allies ${P1(v.room.dmgTaken)} taken` : ""}` : `${v.ticks} ticks`;
    case "stacks": return `${v.maxStacks} stacks`;
    case "summon": return `${P0(v.pctOfMain)} of Main${(v.count || 1) > 1 ? ` ×${v.count}` : ""}`;
    case "healOrHit": return `heal ${P0(v.heal)}, hit ${P0(v.coef)}`;
    case "roomRestore": return `${P1(v.roomDmg)} room damage`;
    default: return passiveText(v) || "—";
  }
}

const PASSIVE_WORD = {
  hpPct: (x) => `${P1(x)} max HP`, dr: (x) => `${P1(x)} DR`, dodge: (x) => `${P1(x)} dodge`, critDmg: (x) => `${P1(x)} crit damage`,
  dmg: (x) => `${P1(x)} damage`, forklingPct: (x) => `Forklings ${P1(x)} of Main`, freeMainChance: (x) => `${P0(x)} chance of a free extra Main`,
  ignoreBossDr: (x) => `ignores ${P0(x)} of boss DR`, roomXp: (x) => `${P1(x)} XP for the room`, roomDmg: (x) => `${P1(x)} damage for the room`,
  roomDr: (x) => `${P1(x)} DR for the room`,
};

function passiveText(v) {
  const parts = [];
  const pr = v.perRank || {};
  for (const k of Object.keys(pr)) if (PASSIVE_WORD[k]) parts.push(PASSIVE_WORD[k](pr[k]));
  if (v.countedBonus) parts.push(`+${v.countedBonus} counted ${plural(v.countedBonus, "Forkling")}`);
  if (v.perRankPerSummon) parts.push(`${P1(v.perRankPerSummon.dmg || 0)} damage per summon (max ${v.maxSummons || 7})`);
  return parts.join(", ");
}

function skillEffect(v) {
  switch (v.type) {
    case "hit": {
      const hits = v.hits || 1;
      const multi = v.targets === "lane" || (typeof v.targets === "number" && v.targets > 1);
      let s = hits > 1
        ? `${hits} hits of ${P0(v.coef)} on ${targetsText(v.targets)}`
        : multi ? `${cap1(targetsText(v.targets))} for ${P0(v.coef)} each` : `Hit ${targetsText(v.targets)} for ${P0(v.coef)} of a normal hit`;
      if (v.bonusHit) s += ` + ${P0(v.bonusHit)} nip`;
      if (v.alwaysCrit) s += ", always crits";
      if (v.executeBelow) s += `; finishes mobs below ${P0(v.executeBelow)} HP`;
      return s;
    }
    case "proc": return `Every ${v.everyActions}th action: ${P0(v.coef)} to ${targetsText(v.targets)}${v.splash ? `, ${P0(v.splash)} of it to the lane` : ""}`;
    case "buff": {
      const fx = [];
      if (v.self && v.self.dmg) fx.push(`${P1(v.self.dmg)} damage`);
      if (v.self && v.self.alwaysCrit) fx.push("every hit crits");
      if (v.self && v.self.untargetable) fx.push("untargetable");
      if (v.room && v.room.dmgTaken) fx.push(`room allies take ${P1(v.room.dmgTaken)} damage`);
      if (v.ally) fx.push("shared with the lowest-level ally");
      return `${v.ticks} ticks: ${fx.join("; ") || "a boost"}`;
    }
    case "stacks": return `${P1(v.perStack && v.perStack.dmg)} damage per hit on one target, up to ${v.maxStacks} stacks`;
    case "summon": {
      const n = v.count || 1;
      return `${n} ${plural(n, "summon")} ${n > 1 ? "hit" : "hits"} for ${P0(v.pctOfMain)} of Main every tick`;
    }
    case "healOrHit": return `Heals allies below ${P0(v.healBelow)} HP by ${P0(v.heal)}, else hits ${targetsText(v.targets)} for ${P0(v.coef)} each`;
    case "roomRestore": return `Revives and fully heals the room, then ${v.buffTicks} ticks of ${P1(v.roomDmg)} damage`;
    default: return passiveText(v) || cap1(str(v.type, "passive"));
  }
}

/** skillValue at a given learned rank (a shallow copy of the hero with that rank). */
function valueAt(hero, si, rank, st) {
  const sp = hero.sp.slice();
  sp[si] = rank;
  return skillValue(Object.assign({}, hero, { sp }), si, st);
}

function skillVM(world, hero, d, st, roster) {
  const si = d.slotIdx;
  const rank = num(hero.sp[si]);
  const unlocked = slotUnlocked(hero, si);
  const shownRank = Math.max(1, rank);
  const v = valueAt(hero, si, shownRank, st) || { type: "passive" };
  const lockText = d.needs ? `Lv ${d.unlock} and the ${d.needs === "seniorReview" ? "Senior" : "Staff"} Review` : `Lv ${d.unlock}`;
  let next = null;
  if (rank < d.max) {
    const v2 = valueAt(hero, si, rank + 1, st);
    const gate = d.unlock + rank * T.skills.rankGate;
    next = `${rank === 0 ? "Rank 1" : "Next rank"}: ${v2 ? skillKeyNumber(v2) : "—"}${hero.L < gate ? ` (needs Lv ${gate})` : ""}`;
  }
  let cd = null;
  if (v.type === "proc" && v.everyActions) cd = `every ${v.everyActions}th action`;
  else if (num(v.cd) > 0) cd = `CD ${v.cd} ticks`;
  else if (v.type === "summon") cd = "every tick";
  let learn = null;
  if (unlocked && rank < d.max) {
    const key = `learn:${hero.id}:${d.slot}`;
    const args = { heroId: hero.id, slot: d.slot };
    const gate = d.unlock + rank * T.skills.rankGate;
    if (!roster) learn = disabled(key, "+1", "learn", args, "Contractors learn on their own");
    else if (!(num(hero.spFree) > 0)) learn = disabled(key, "+1", "learn", args, "No skill points to spend");
    else if (!canLearn(hero, si)) learn = disabled(key, "+1", "learn", args, `Rank ${rank + 1} needs Lv ${gate}`);
    else learn = action(key, "+1", "learn", args, { tooltip: `Spend 1 skill point: rank ${rank + 1}` });
  }
  return {
    key: `sk:${d.slot}`, slot: d.slot, slotLabel: `${SLOT_NAME[d.slot] || cap1(d.slot)} · Lv ${d.unlock}`, name: d.name,
    glyph: GLYPH[d.id] || d.name.slice(0, 2), rank, max: d.max, rankText: `${rank}/${d.max}`,
    locked: !unlocked, lockText: unlocked ? null : lockText,
    effect: skillEffect(v), next, cd, learn,
    tooltip: `${d.name}: ${skillEffect(v)}${d.cue && d.cue !== "none" ? ` · ${d.cue}` : ""}`,
  };
}

function ladderOf(hero) {
  const tier = careerOf(hero).tier;
  return CAREERS.map((c, i) => ({
    key: c.title.toLowerCase(), title: c.title, levels: `${c.from}–${c.to}`,
    state: i < tier ? "done" : i === tier ? "current" : i === tier + 1 ? "next" : "locked",
  }));
}

function respecAction(world, hero, live, clock, roster) {
  const args = { heroId: hero.id };
  if (!roster) return disabled("respec", "Respec", "respec", args, "Contractors keep their kit");
  let spent = 0;
  for (const r of hero.sp) spent += num(r);
  if (spent <= 0) return disabled("respec", "Respec", "respec", args, "No skill points spent yet: nothing to refund");
  const resting = !live || live.state === "resting" || live.state === "shipped";
  const last = hero.cd && hero.cd.respecAt;
  const free = resting && (last == null || clock.now - last >= RESPEC_FREE_MS);
  // the herd's switch (and the autopilot master switch) rules over the hero's (heroes.respec)
  const after = hero.autoLearn !== false && autoOn(world.state, "learn") ? "; auto-learn re-spends them" : "";
  if (free) return action("respec", "Respec", "respec", args, { cost: "Free (resting)", confirm: "Respec for free?", tooltip: `Refunds every skill point${after}` });
  const cost = T.skills.respecSnippetsPerLevel * hero.L;
  const short = shortfall(world.state.herd, 0, cost);
  return action("respec", "Respec", "respec", args, {
    cost: snipText(cost), enabled: !short, confirm: `Respec for ${snipText(cost)}?`,
    tooltip: short || `Refunds every skill point${after}${resting ? "" : ". Free once a day while resting"}`,
  });
}

function skillsVM(world, hero, live, st, clock) {
  const roster = inRoster(world, hero);
  const sp = num(hero.spFree);
  const on = hero.autoLearn !== false;
  // points are spent only while auto-learn is on for the herd too (Settings, and the autopilot
  // master switch): the hero's own switch alone spends nothing (world.js autoLearn)
  const spends = on && autoOn(world.state, "learn");
  const autoKey = "autolearn";
  const autoAct = roster
    ? action(autoKey, "Auto-learn", "autoLearn", { heroId: hero.id, on: !on }, { tooltip: on ? "Turn auto-learn off" : "Turn auto-learn on" })
    : disabled(autoKey, "Auto-learn", "autoLearn", { heroId: hero.id, on: !on }, "Contractors learn on their own");
  let note = null;
  if (hero.cls === 0) note = `Intern points are refunded at Lv ${CAREERS[1].from}, when the class arrives.`;
  else if (hero.prov) note = `Provisional class: if it changes, every point is refunded${spends ? " and re-spent" : ""}.`;
  return {
    sp: {
      count: sp, text: `skill ${plural(sp, "point")} to spend`,
      tooltip: `1 point per level from Lv 2, +1 per review won.${spends ? " Auto-learn spends them within a minute." : on ? " Auto-learn is off in Settings, so they wait." : ""}`,
    },
    autoLearn: { on, action: autoAct, hint: spends ? "Spends points on the lowest-ranked skill" : on ? "Waits: auto-learn is off in Settings" : "Off: you spend points yourself" },
    respec: respecAction(world, hero, live, clock, roster),
    rules: `Free once a day while resting; otherwise ${T.skills.respecSnippetsPerLevel} × level Snippets.`,
    ladder: ladderOf(hero),
    skills: skillDefs(hero).map((d) => skillVM(world, hero, d, st, roster)),
    note,
  };
}

// ---------------------------------------------------------------------------------------------
// The sheet: stats tab
// ---------------------------------------------------------------------------------------------

function statsVM(world, hero, live, st) {
  const c = CLASSES[hero.cls] || CLASSES[0];
  const g = c.growth;
  const row = (key, label, value, tooltip, sub = null, color = null) => ({ key, label, value, sub, tooltip, color });
  const pl = Math.round(num(st.pl, hero.L));
  const gear = pl - hero.L;
  const herdXp = Herd.herdXpBonus(world.state);
  const onboarding = Herd.onboardingBonus(world.state, hero);
  const feCap = Herd.freshEyesCapMin(world.state);
  const minToday = shiftMinToday(world, hero);
  const L = hero.L;
  const engagedRegen = T.regen.engaged + num(st.regenPct);
  const groups = [
    { key: "primary", title: "Primary", rows: [
      row("might", "MIGHT", fmtInt(st.might), `4 + ${g.might} × (Lv − 1): +1% damage each`),
      row("grit", "GRIT", fmtInt(st.grit), `4 + ${g.grit} × (Lv − 1): +1% max HP each`),
      row("keen", "KEEN", fmtInt(st.keen), `4 + ${g.keen} × (Lv − 1): +0.15% crit each`),
      row("luck", "LUCK", fmtInt(st.luck), `4 + ${g.luck} × (Lv − 1): +0.4% item find, +0.5% gold each`),
      row("pl", "Power Level", String(pl), `PL = Lv + clamp(round(ln(DPS_est / refDPS) / ln 1.07), −5, +8): gear ${gear < 0 ? MINUS : "+"}${Math.abs(gear)}`, gear ? `${gear < 0 ? MINUS : "+"}${Math.abs(gear)}` : null),
    ] },
    { key: "offense", title: "Offense", rows: [
      row("wd", "Weapon damage", fmtInt(st.weaponDmg), st.offClassWeapon ? "Another class's weapon: swung like a Training Stick, 6 · g(iLvl) (no rarity, polish or affixes)" : st.hasWeapon ? "6 · g(iLvl) · rarity · (1 + 0.05 · polish)" : "Bare hands: 3 · g(Lv)"),
      row("hit", "Main hit", fmtInt(st.mainHit), "Weapon damage × (1 + MIGHT/100) × skill × (1 + damage %)"),
      row("dmg", "Damage bonus", pct(st.dmgPct, { sign: true }), "Affixes, skills, trophies and Bug Tracker perks", null, num(st.dmgPct) > 0 ? COL.working : null),
      row("crit", "Crit chance", pct(st.crit), `0.05 + 0.0015 × KEEN + gear, cap ${P0(T.critCap)}`),
      row("critx", "Crit damage", `×${num(st.critMult).toFixed(2)}`, `${num(c.innate && c.innate.critMult, T.critMult)} + crit-damage affixes`),
      row("cdr", "Cooldowns", num(st.cdr) > 0 ? `${MINUS}${pct(st.cdr)}` : "0%", `Hot Reload affixes, Keepsakes and perks, cap ${P0(T.cdrCap)}`),
      row("xact", "Extra action", pct(st.extraAct), `Async affixes: a chance to repeat Main, cap ${P0(T.extraActCap)}`),
      row("boss", "Boss damage", pct(st.bossDmg, { sign: true }), "Blameless affixes, Keepsakes and perks"),
      row("dps", "DPS (est.)", fmtNum(num(st.dpsEst)), "Mean single-target damage per tick from a 60-tick dry run of the rotation"),
    ] },
    { key: "defense", title: "Defense", rows: [
      row("hp", "Max HP", fmtInt(st.maxHp), `${T.hpBase} · g(Lv) · (1 + GRIT/100) · (1 + HP %)${c.innate && c.innate.hpPct ? `, ${c.innate.name} ${pctI(c.innate.hpPct)}` : ""}`),
      row("armor", "Armor", fmtInt(st.armor), "Σ armor pieces × (1 + armor %)"),
      row("dr", "Damage reduction", pct(typeof st.dr === "function" ? st.dr(L) : 0, { digits: 0 }), `Armor / (Armor + 25 · g(m)) vs an on-level mob, cap ${P0(T.drCap)}`),
      row("dodge", "Dodge", pct(st.dodge), `Gear and skills, cap ${P0(T.dodgeCap)}`),
      row("regen", "Regen", `${pct(engagedRegen, { digits: 2, trim: false })}/tick`, `${pct(T.regen.engaged)} engaged + Uptime affixes; ${pct(T.regen.resting, { digits: 0 })} resting`),
      row("ehp", "EHP", fmtNum(num(st.ehp)), "Max HP / (1 − DR) / (1 − dodge)"),
      row("coffee", "Coffee", `${Math.round(num(hero.cups))} / ${T.coffee.carry} cups`, `Drunk below ${P0(T.coffee.threshold)} HP; heals ${P0(st.coffeeHeal)}`),
    ] },
    { key: "loot", title: "Rewards", rows: [
      row("if", "Item find", pct(st.itemFind, { sign: true }), `0.4% × LUCK + gear + herd, cap ${P0(T.itemFindCap)}`),
      row("gold", "Gold", pct(st.goldPct, { sign: true }), "0.5% × LUCK + gear + Release Train + Callback Caverns tracker"),
      row("xpb", "XP bonus", pct(num(st.xpPct) + herdXp + onboarding, { sign: true }),
        `Gear ${pctI(st.xpPct)} + herd ${pctI(herdXp)}${onboarding ? ` + onboarding ${pctI(onboarding)}` : ""} (herd: Release Train, Docs Library, tracker, Legacy; cap ${P0(T.herdXpCap)})`),
      row("fe", "Fresh Eyes", `${Math.floor(num(hero.fe))} / ${feCap} min`, `×${T.freshEyes.xpMult} kill XP while Questing; refills 1 min per 4 while not working`),
      row("shift", "Shift today", fmtMin(minToday), `Full rewards until ${T.shift.bandsMin[0] / 60}h, half until ${T.shift.bandsMin[1] / 60}h, a quarter after`),
    ] },
  ];
  return { groups, why: whyVM(world, hero, live) };
}

function whyVM(world, hero, live) {
  const why = live ? live.why || null : null;
  const notes = [];
  const feCap = Herd.freshEyesCapMin(world.state);
  const [b1, b2] = T.shift.bandsMin;
  if (!why) {
    notes.push(live ? "The XP rate appears after the next tick." : `Off duty: Fresh Eyes refills 1 minute per 4, up to ${feCap} minutes.`);
    return {
      title: "XP per minute right now", total: "0 XP/min",
      parts: [{ key: "state", label: live ? "Starting" : "Off duty", value: "×0", good: null, tooltip: live ? null : "No XP while off duty" }],
      notes,
    };
  }
  const parts = [];
  const st = why.state;
  const label = st === "waiting" ? "waiting" : st === "supervising" ? "supervising" : st === "questing" || st === "crashed" ? "working" : st;
  parts.push({ key: "work", label, value: `×${why.working}`, good: why.working >= 1 ? null : false, tooltip: st === "waiting" ? "Waiting for you: no XP while blocked (never a penalty)" : st === "supervising" ? "Supervising sub-agents: half rate" : "Questing: full kill rewards" });
  if (why.freshEyes > 1) parts.push({ key: "fe", label: "Fresh Eyes", value: `×${why.freshEyes}`, good: true, tooltip: `${fmtMin(why.feMin)} left` });
  if (why.party > 0) parts.push({ key: "party", label: "Party", value: pctI(why.party), good: true, tooltip: "Guild-mates questing in the same room" });
  if (why.banner > 0) parts.push({ key: "banner", label: "Banner", value: pctI(why.banner), good: true, tooltip: "A pinned agent questing in the room" });
  if (why.herd > 0) {
    const hp = Herd.herdXpParts(world.state);
    parts.push({ key: "herd", label: "Herd", value: pctI(why.herd), good: true, tooltip: `Release Train ${pctI(hp.release)}, Docs Library ${pctI(hp.docs)}, tracker ${pctI(hp.tracker)}, Legacy ${pctI(hp.legacy)}${hp.capped ? ` (capped at ${pctI(T.herdXpCap)})` : ""}` });
  }
  if (why.unblocked > 0) parts.push({ key: "unblocked", label: "Unblocked", value: pctI(why.unblocked), good: true, tooltip: `${why.unblockedLeft} Questing ticks left` });
  if (why.onboarding > 0) parts.push({ key: "onboarding", label: "Onboarding", value: pctI(why.onboarding), good: true, tooltip: "A new hire 10+ levels behind the herd's top hero" });
  if (why.gear > 0) parts.push({ key: "gear", label: "Gear", value: pctI(why.gear), good: true, tooltip: "XP affixes and Keepsakes" });
  // the level gap (D§6.2) binds mainly under a manual map pin: autopilot keeps heroes near their level
  const gp = gapPart(why, hero.L);
  if (gp) {
    const G = T.gap;
    parts.push({ key: "gap", label: "Level gap", value: `×${gp.mult}`, good: false,
      tooltip: `${gapText(gp)} (kill XP −${Math.round(G.lossPerLevel * 100)}% a level past ${G.freeAbove}, down to ×${G.floor})${hero.pinMap === gp.mapId ? `; pinned to ${gp.mapId}: Auto on the Career tab's Map card unpins` : ""}` });
  }
  if (why.crowding < 1) parts.push({ key: "crowd", label: "Crowding", value: `×${Math.round(why.crowding * 100) / 100}`, good: false, tooltip: `More than ${T.crowdingAt} heroes questing at once` });
  parts.push({ key: "shift", label: "Shift", value: `×${why.shiftKill}`, good: why.shiftKill < 1 ? false : null, tooltip: `${fmtMin(why.shiftMin)} worked today` });
  notes.push(why.shiftBand === 0
    ? `Daily Shift: full rate until ${b1 / 60}h today (${fmtMin(why.shiftMin)} so far), then half until ${b2 / 60}h.`
    : `Daily Shift: ${fmtMin(why.shiftMin)} today, kill rewards ×${why.shiftKill}${why.nextBandMin != null ? ` until ${why.nextBandMin / 60}h` : " until the 04:00 reset"}.`);
  notes.push(`Fresh Eyes refills while ${firstName(hero)} is not working: 1 minute per 4, up to ${feCap} minutes.`);
  if (why.flapPaused) notes.push("Chests are paused: the agent's status is flapping.");
  return { title: "XP per minute right now", total: `+${fmtInt(why.xpPerMin)} XP/min`, parts, notes };
}

// ---------------------------------------------------------------------------------------------
// The sheet: career tab
// ---------------------------------------------------------------------------------------------

const LADDER_NOTE = ["Hello, World · printf()", "Main · Area · Passive · Buff", "Signature skill, +1 SP", "Ultimate, +1 SP", "Capstone, silver trim"];

function estimateVM(E) {
  const e = num(E);
  if (!(e > 0)) return null;
  const label = e >= 1.2 ? "Favored" : e >= 0.95 ? "Even" : "Risky";
  const color = e >= 1.2 ? COL.working : e >= 0.95 ? COL.blocked : COL.hp;
  // floored, not rounded: 0.949 reads "Risky 0.94×", never "Risky 0.95×" (Even starts at 0.95)
  return { text: `${label} ${(Math.floor(e * 100 + 1e-9) / 100).toFixed(2)}×`, color };
}

function reviewVM(world, idx, hero, live, ri, clock) {
  const r = REVIEWS[ri];
  const api = bossApi(world);
  const rev = hero.rev || [0, 0];
  const name = reviewTitle(ri);
  if (rev[ri]) {
    let when = null;
    const promo = (world.state.herd.log || []).find((e) => e && e[1] === "promo" && e[2] === hero.id && str(e[3]).startsWith(r.reward.title));
    if (promo) when = fmtDate(promo[0], clock.tz, false);
    return { name, status: "won", statusText: when ? `Passed ${when}` : "Passed", estimate: null, challenge: null };
  }
  const fight = idx.fights.get(hero.id);
  if (fight && fight.kind === "review" && fight.reviewIdx === ri) {
    return {
      // the number first: beside the row's Retreat (armed, "Retreat? (a Postmortem)") the line is
      // cut, and "In progress against The Senior R…" lost what is left
      name, status: "running", statusText: `${leftPct(fight)}% left against ${r.opponent}`, estimate: null,
      challenge: action(`retreat:review:${ri}`, "Retreat", "retreat", { heroId: hero.id }, { tone: "danger", confirm: "Retreat? (a Postmortem)", tooltip: "End the review as a Postmortem: Wounds and Lessons are kept" }),
    };
  }
  const eligible = hero.cls > 0 && hero.L >= r.level && (ri === 0 || rev[0]);
  if (!eligible) {
    const why = hero.cls === 0 ? `At Lv ${r.level} (with a class)` : hero.L < r.level ? `At Lv ${r.level}` : "After the Senior Review";
    return { name, status: "locked", statusText: why, estimate: null, challenge: null };
  }
  const E = typeof api.estimate === "function" ? api.estimate(world, "review", ri, [hero.id]) : 0;
  const key = `review:${ri}`;
  const args = { kind: "review", idx: ri, heroId: hero.id };
  let challenge;
  if (!inRoster(world, hero)) challenge = disabled(key, "Challenge", "challenge", args, "Contractors don't take reviews");
  else if (!live || live.state !== "questing") challenge = disabled(key, "Challenge", "challenge", args, `${firstName(hero)} must be working: the trial runs in its own slot`);
  else {
    const c = typeof api.canChallenge === "function" ? api.canChallenge(world, "review", ri, hero.id) : { ok: false, error: "Reviews are not available" };
    challenge = c && c.ok
      ? action(key, "Challenge", "challenge", args, { tone: "primary", tooltip: `Starts the trial in ${firstName(hero)}'s own slot (its timer runs only while ${firstName(hero)} works)` })
      : disabled(key, "Challenge", "challenge", args, (c && (c.error || c.label)) || "Can't challenge now");
  }
  const auto = autoOn(world.state, "boss");
  return {
    name, status: "ready", statusText: `Ready: ${r.opponent}${auto ? " · autopilot starts it at 1.00×" : ""}`,
    estimate: estimateVM(E), challenge,
  };
}

function signatureVM(hero) {
  const s = classSignature(hero);
  const rec = (CLASSES[s.recommendedIdx] || CLASSES[3]).name;
  const n = num(s.n);
  const text = s.window > 0
    ? `median task ${Math.round(s.median)} min · ${(Math.round(s.bph * 10) / 10).toFixed(1)} blocks/h · ${Math.round(s.sub * 100)}% with sub-agents`
    : "No qualifying tasks yet (1.5 min or longer)";
  let state;
  const lockN = T.skills.classLockTasks;
  if (hero.cls === 0) state = hero.pref != null && CLASSES[hero.pref] ? `Your pick at Lv ${CAREERS[1].from}: ${CLASSES[hero.pref].name}` : `Class arrives at Lv ${CAREERS[1].from}`;
  else if (hero.prov) state = `Provisional (${Math.min(n, lockN)} of ${lockN} tasks)`;
  else state = n >= lockN ? `Locked at ${lockN} tasks` : "Locked by you";
  return { text, recommended: rec, state, tasks: `${n} ${plural(n, "task")} on record` };
}

/** "Provisional class (9 of 15 tasks)": how far a provisional class is from locking itself. */
function provisionalText(hero) {
  const lockN = T.skills.classLockTasks;
  return `Provisional class (${Math.min(num(classSignature(hero).n), lockN)} of ${lockN} tasks)`;
}

function classesVM(world, hero) {
  const L = hero.L;
  const roster = inRoster(world, hero);
  const freeUntil = T.skills.classFreeUntilLevel;
  const rec = classSignature(hero).recommendedIdx;
  const costN = L >= freeUntil ? T.skills.careerChangeSnippetsPerLevel * L : 0;
  let note;
  if (L < CAREERS[1].from) note = `Pick a class now: it is applied, locked, at Lv ${CAREERS[1].from}. Free.`;
  else if (L < freeUntil) note = `Any class, free, before Lv ${freeUntil} (this also locks it).`;
  else note = `From Lv ${freeUntil} a career change costs ${T.skills.careerChangeSnippetsPerLevel} × level Snippets and refunds every skill point.`;
  const options = CLASSES.slice(1).map((c) => {
    const current = L >= CAREERS[1].from ? hero.cls === c.n : hero.pref === c.n;
    const key = `cls:${c.id}`;
    const args = { heroId: hero.id, cls: c.id };
    // A provisional current class: its chip locks it (setClass on the same class, free; heroes.js).
    const lock = !!(roster && current && hero.prov && L >= CAREERS[1].from);
    let a;
    if (!roster) a = disabled(key, c.name, "setClass", args, current ? `${firstName(hero)}'s class (contractors keep the class they came with)` : "Contractors keep the class they came with");
    else if (lock) {
      a = action(key, c.name, "setClass", args, {
        confirm: `Lock ${c.name}?`,
        tooltip: `Lock ${c.name} now (free). ${provisionalText(hero)}: until then behaviour can still switch it.`,
      });
    } else if (current) a = action(key, c.name, "setClass", args, { tooltip: L >= CAREERS[1].from ? `${firstName(hero)}'s class` : "Your pick for Lv 10" });
    else if (costN > 0) {
      const short = shortfall(world.state.herd, 0, costN);
      a = action(key, c.name, "setClass", args, {
        cost: snipText(costN), enabled: !short, confirm: `Change to ${c.name} for ${snipText(costN)}?`,
        tooltip: short || `Career change to ${c.name}: refunds every skill point`,
      });
    } else {
      a = action(key, c.name, "setClass", args, {
        tooltip: L < CAREERS[1].from ? `Become a ${c.name} at Lv ${CAREERS[1].from}` : `Switch to ${c.name} for free (locks it)`,
      });
    }
    return Object.assign(a, { clsId: c.id, current: !!current, recommended: c.n === rec, color: CLASS_COLORS[c.id] || COL.idle, lock });
  });
  return { note, options };
}

function mapVM(world, hero, live) {
  const state = world.state;
  const roster = inRoster(world, hero);
  const pinned = hero.pinMap || null;
  const curId = (live && live.mapId) || pinned;
  const curMap = MAP_BY_ID[curId];
  const curText = curId ? `${mapLabel(world, curId, live)}${curMap ? ` (${mapLevels(curMap)})` : ""}` : "nowhere yet";
  const autoArgs = { heroId: hero.id, mapId: null };
  const auto = !roster ? disabled("map:auto", "Auto", "pinMap", autoArgs, "Contractors go where autopilot sends them")
    : pinned ? action("map:auto", "Auto", "pinMap", autoArgs, { tooltip: `Let autopilot pick the deepest map ${firstName(hero)} outfights` })
      : disabled("map:auto", "Auto", "pinMap", autoArgs, "Already on auto");
  const frontier = Math.min(num(state.herd.zone), ZONES.length - 1);
  const zones = [];
  for (let z = 0; z <= Math.min(ZONES.length - 1, frontier + 1); z++) {
    const zone = ZONES[z];
    zones.push({
      key: zone.id, name: zone.name,
      maps: zone.maps.map((m) => {
        const mp = MAP_BY_ID[m.id];
        const open = Herd.mapUnlocked(state, m.id);
        const args = { heroId: hero.id, mapId: m.id };
        const tip = `${m.id} ${m.name} (${mapLevels(mp)})`;
        const a = !roster ? disabled(`map:${m.id}`, m.id, "pinMap", args, tip)
          : open ? action(`map:${m.id}`, m.id, "pinMap", args, { tooltip: `Stay on ${tip}` })
            : disabled(`map:${m.id}`, m.id, "pinMap", args, `${tip}: not open yet`);
        return Object.assign(a, { on: pinned === m.id });
      }),
    });
  }
  if (Herd.backlogOpen(state)) {
    const args = { heroId: hero.id, mapId: BACKLOG.id };
    const a = roster ? action(`map:${BACKLOG.id}`, "∞", "pinMap", args, { tooltip: "Stay in The Backlog (endless floors)" })
      : disabled(`map:${BACKLOG.id}`, "∞", "pinMap", args, "The Backlog");
    zones.push({ key: BACKLOG.id, name: BACKLOG.name, maps: [Object.assign(a, { on: pinned === BACKLOG.id })] });
  }
  return { label: pinned ? "Pinned" : "Auto", current: pinned ? `Stay here: ${curText}` : `Auto: ${curText}`, auto, zones };
}

/** The boss row facts every boss card shares (sheet career card, Herd panel rows). */
function bossFacts(world, idx, bi) {
  const state = world.state;
  const herd = state.herd;
  const b = BOSSES[bi];
  const api = bossApi(world);
  const fixed = num((herd.boss || [])[bi]) > 0;
  const frontier = num(herd.zone);
  const door = Herd.doorOpen(state, b.zone);
  let fighting = null;
  for (const f of world.rt.fights || []) if (f.kind === "boss" && f.bossIdx === bi) fighting = f;
  const paused = !fighting && herd.fight && herd.fight.k === "b" && herd.fight.i === bi ? herd.fight : null;
  const c = typeof api.canChallenge === "function" ? api.canChallenge(world, "boss", bi) : { ok: false, error: "Bosses are not available" };
  let E = c && c.ok ? c.estimate : 0;
  if (!(E > 0) && b.zone <= frontier && typeof api.participants === "function" && typeof api.estimate === "function") {
    const p = api.participants(world, "boss", bi);
    if (p && p.heroIds && p.heroIds.length) E = api.estimate(world, "boss", bi, p.heroIds, p.helpers);
  }
  let state0;
  if (fighting || paused) state0 = "fighting";
  else if (fixed) state0 = "fixed";
  else if (b.zone > frontier) state0 = "locked";
  else if (door) state0 = "door";
  else state0 = "sprint";
  return { b, fixed, door, fighting, paused, c, E, state: state0 };
}

function sprintText(world, zone) {
  const herd = world.state.herd;
  const last = ZONES[zone].maps[ZONES[zone].maps.length - 1];
  const q = num((herd.quota || {})[last.id]);
  if (q < T.quotaPerMap) return `Map ${last.id}: ${Math.floor(q)} / ${T.quotaPerMap} kills`;
  const need = Herd.sprintTarget(zone);
  return `Sprint ${Math.min(need, Math.floor(num(herd.meter) + 1e-9))} / ${need}`;
}

function challengeAction(world, bi, facts, label, heroId) {
  const key = `challenge:${bi}`;
  const args = { kind: "boss", idx: bi };
  if (heroId != null) args.heroId = heroId;
  if (facts.c && facts.c.ok) {
    const names = (facts.c.heroIds || []).map((id) => {
      const h = heroById(world, id);
      return h ? firstName(h) : null;
    }).filter(Boolean);
    const who = names.length ? `${names.join(", ")} ${names.length === 1 ? "fights" : "fight"}` : "The heroes in the zone fight";
    return action(key, label, "challenge", args, { tone: facts.fixed ? null : "primary", tooltip: facts.fixed ? `Repeat kill: loot, no Sprint meter needed. ${who}` : who });
  }
  return disabled(key, label, "challenge", args, (facts.c && (facts.c.error || facts.c.label)) || "Can't challenge now");
}

function careerBossVM(world, idx, hero, live) {
  const mapId = (live && live.mapId) || hero.pinMap;
  const zone = zoneOfMap(mapId);
  if (!(zone >= 0 && zone < BOSSES.length)) return null;
  const bi = BOSSES.findIndex((b) => b.zone === zone);
  if (bi < 0) return null;
  const f = bossFacts(world, idx, bi);
  const b = f.b;
  let status;
  if (f.state === "fighting") status = f.fighting ? `Fighting: ${leftPct(f.fighting)}% left` : "Fight paused";
  else if (f.fixed) status = `FIXED · ${num(world.state.herd.bossKills[bi])} ${plural(num(world.state.herd.bossKills[bi]), "kill")}`;
  else if (f.door) status = "Door open";
  else status = sprintText(world, b.zone);
  let challenge = null;
  if (f.state === "door" || f.state === "fixed") challenge = challengeAction(world, bi, f, f.fixed ? "Fight again" : "Challenge", inRoster(world, hero) ? hero.id : null);
  // D§11.16 "boss card: Challenge / Retreat": the zone boss fight (running or paused) can be ended
  // here too, like the Herd panel's fight banner (retreat {} ends the one non-review fight).
  else if (f.state === "fighting") challenge = retreatAction(`retreat:boss:${bi}`);
  // fighting: the sheet draws the card first in the Career tab, so its Retreat is in view
  return { name: b.name, zone: `${ZONES[b.zone].name} · Lv ${b.level}`, status, estimate: estimateVM(f.E), challenge, fighting: f.state === "fighting" };
}

function rebindVM(world, idx, hero) {
  if (!inRoster(world, hero) || idx.liveOf.has(hero.id)) return null;
  const cands = [];
  for (const [h, l] of idx.pairs) {
    if (!l.address) continue;
    cands.push({ h, l, rank: h.contractor ? 0 : 1 });
  }
  cands.sort((a, b) => a.rank - b.rank || a.h.L - b.h.L || a.h.id - b.h.id);
  const options = cands.slice(0, 6).map(({ h, l }) => {
    const prog = programName((l.program && l.program.key) || l.app, l.program);
    const space = str(l.spaceName).trim() || str(l.space) || "no space";
    const title = taskLabel(l);
    const who = h.contractor ? "contractor" : `${h.name}, Lv ${h.L} ${careerOf(h).title}`;
    return action(`rebind:${l.address}`, "Bind", "rebind", { heroId: hero.id, address: str(l.address) }, {
      confirm: "Bind here?",
      tooltip: `${prog} in ${space}${title ? ` · “${title}”` : ""} (${who})`,
    });
  });
  return {
    title: "Rebind a live agent",
    hint: options.length
      ? `Move a live agent onto ${firstName(hero)}. The hero it plays now goes off duty (a contractor simply leaves).`
      : "No live agents right now: start one, then bind it here.",
    options,
  };
}

function careerVM(world, idx, hero, live, clock) {
  const roster = inRoster(world, hero);
  const tier = careerOf(hero).tier;
  const ladder = CAREERS.map((c, i) => ({
    key: c.title.toLowerCase(), title: c.title, levels: `${c.from}–${c.to}`,
    state: i < tier ? "done" : i === tier ? "current" : i === tier + 1 ? "next" : "locked",
    note: LADDER_NOTE[i] || "",
    review: i === 2 ? reviewVM(world, idx, hero, live, 0, clock) : i === 3 ? reviewVM(world, idx, hero, live, 1, clock) : null,
  }));
  let retire = null;
  if (roster) {
    const args = { heroId: hero.id };
    const first = firstName(hero);
    if (hero.L < RETIRE_LEVEL) retire = disabled("retire", "Retire", "retire", args, `Retirement needs Lv ${RETIRE_LEVEL} (${first} is Lv ${hero.L})`, { tone: "danger" });
    else if (idx.fights.has(hero.id)) retire = disabled("retire", "Retire", "retire", args, `${first} is in a fight`, { tone: "danger" });
    else {
      retire = action("retire", "Retire", "retire", args, {
        tone: "danger", confirm: `Retire ${first} for good?`,
        tooltip: `${first} joins the Hall of Fame (${pct(LEGACY_PER, { sign: true })} herd XP; Legacy caps at +10%). Its gear goes to vendor/.`,
      });
    }
  }
  return {
    ladder, signature: signatureVM(hero), classes: classesVM(world, hero), map: mapVM(world, hero, live),
    boss: careerBossVM(world, idx, hero, live),
    identity: { name: str(hero.name), canRename: !!roster, hint: roster ? "Renaming is free (1–32 characters)." : "Contractors are not saved: a new name would not stick." },
    retire, rebind: rebindVM(world, idx, hero),
  };
}

// ---------------------------------------------------------------------------------------------
// The sheet: journal tab
// ---------------------------------------------------------------------------------------------

// boss journal lines: "<name> FIXED", "<name> fixed again", "<name>: Postmortem" (value: wounds %),
// a Backlog boss name (value: floor), or a bare boss name (world.js: a kill it saw first)
function bossLine(text, value) {
  if (/Postmortem$/.test(text)) return `${text}: ${num(value)}% wounds kept`;
  if (/(FIXED|fixed again)$/.test(text)) return text;
  if (BOSSES.some((b) => b.name === text)) return `${text}: FIXED`;
  if (text.endsWith(BACKLOG.versionTag)) return `${text} FIXED · Backlog floor ${num(value)}`;
  return text;
}

// chests that opened Unreviewed (agents.openChests): value the count, text the task when one
function unrevLine(text, value) {
  const n = Math.max(1, num(value, 1));
  return n > 1 ? `${n} chests opened Unreviewed (half value, no Seals)` : `Chest opened Unreviewed${text ? `: “${text}”` : ""} (half value, no Seals)`;
}

function journalLine(e, clock) {
  const [at, kind, , text0, value] = e;
  const text = str(text0);
  let icon = "ui/journal.svg";
  let color = COL.idle;
  let line = text;
  let val = null;
  switch (kind) {
    case "ship":
      icon = "ui/chest.svg"; color = COL.done; line = `Shipped “${text || "Commit"}”`;
      val = num(value) > 0 ? `${(Math.round(num(value) * 10) / 10).toFixed(1)} Seals` : null;
      break;
    case "level": icon = "ui/star.svg"; color = COL.xp; line = `Reached Lv ${num(value)}`; break;
    case "promo": icon = "ui/career.svg"; color = COL.xp; line = `Promoted: ${text}`; break;
    case "drop": {
      const r = RARITIES[num(value)] || RARITIES[3];
      icon = "ui/star.svg"; color = r.color; line = `Found ${text} (${r.name})`;
      break;
    }
    case "boss":
      icon = "ui/boss.svg"; color = /Postmortem/.test(text) ? COL.idle : COL.working;
      line = bossLine(text, value);
      break;
    case "retire": icon = "ui/star.svg"; color = COL.coin; line = `Retired to the Hall of Fame at Lv ${num(value)}`; break;
    case "hire": icon = "ui/herd.svg"; color = COL.working; line = "Joined the herd as a Lv 1 Intern"; break;
    case "leave": icon = "ui/herd.svg"; color = COL.idle; line = `Left the roster at Lv ${num(value)}`; break;
    case "class": icon = "ui/career.svg"; color = COL.xp; line = `Provisional class: ${text}`; break;
    case "unrev": icon = "ui/chest.svg"; color = COL.idle; line = unrevLine(text, value); break;
    case "map": icon = "ui/star.svg"; color = COL.working; break;
    case "deprecate": icon = "ui/snippet.svg"; color = COL.idle; break;
    default: break;
  }
  return { key: `j:${at}:${kind}:${fnv1a32(text) % 100000}`, when: fmtWhen(at, clock), icon, color, text: line || cap1(str(kind)), value: val };
}

function journalVM(world, hero, clock) {
  const log = world.state.herd.log || [];
  const lines = [];
  const seen = new Set();
  for (let i = log.length - 1; i >= 0 && lines.length < JOURNAL_LINES; i--) {
    const e = log[i];
    if (!e || e[2] !== hero.id) continue;
    const l = journalLine(e, clock);
    let k = l.key;
    let n = 1;
    while (seen.has(k)) k = `${l.key}:${n++}`;
    seen.add(k);
    l.key = k;
    lines.push(l);
  }
  return { lines, emptyText: "Nothing yet: levels, shipped quests, notable drops and bosses show up here." };
}

// ---------------------------------------------------------------------------------------------
// sheetView
// ---------------------------------------------------------------------------------------------

function sheetTabs(world, idx, hero, live) {
  const sp = num(hero.spFree);
  let career = null;
  const rev = hero.rev || [0, 0];
  for (let ri = 0; ri < REVIEWS.length && inRoster(world, hero); ri++) {
    const r = REVIEWS[ri];
    if (!rev[ri] && hero.cls > 0 && hero.L >= r.level && (ri === 0 || rev[0])) career = "!";
  }
  return SHEET_TABS.map(([id, label]) => ({ id, label, badge: id === "skills" && sp > 0 ? String(sp) : id === "career" ? career : null }));
}

let SHEET_MEMO = null;

/**
 * The character sheet (D§11.13).
 * @param {object} world
 * @param {{heroId:number, tab?:string, filter?:object, nowMs?:number, tzOffsetMin?:number}} args
 * @returns {object|null} SheetVM (ui/sheet.js typedefs); null while the world loads
 */
export function sheetView(world, args = {}) {
  if (!world || !world.state || !world.rt) return null;
  const a = args && typeof args === "object" ? args : {};
  const clock = clockOf(world, a);
  const heroId = Number(a.heroId);
  const tabIds = SHEET_TABS.map((t) => t[0]);
  const tab = tabIds.includes(a.tab) ? a.tab : "gear";
  const f = normFilter(a.filter);
  const rt = world.rt;
  const key = JSON.stringify([heroId, tab, f, Math.floor(clock.now / 60000), clock.tz]);
  const m = SHEET_MEMO;
  if (m && m.rt === rt && m.state === world.state && m.version === rt.version && m.key === key) return m.vm;

  const vm = buildSheet(world, heroId, tab, f, clock);
  SHEET_MEMO = { rt, state: world.state, version: rt.version, key, vm };
  return vm;
}

function buildSheet(world, heroId, tab, f, clock) {
  const calm = !!(world.state.herd.cfg && world.state.herd.cfg.calm);
  const hero = Number.isInteger(heroId) ? heroById(world, heroId) : null;
  if (!hero) {
    return {
      heroId: Number.isFinite(heroId) ? heroId : 0, tab, tabs: SHEET_TABS.map(([id, label]) => ({ id, label, badge: null })), calm,
      missing: "This hero has left the roster.", header: null, note: null,
      gear: null, skills: null, stats: null, career: null, journal: null,
    };
  }
  const idx = indexOf(world);
  const live = world.rt.live ? world.rt.live.get(hero.id) || null : null;
  const st = statsOf(world, hero);
  const vm = {
    heroId: hero.id, tab, tabs: sheetTabs(world, idx, hero, live), calm,
    header: headerVM(world, idx, hero, live, st, clock), note: noteVM(world, idx, hero, live, clock),
    gear: null, skills: null, stats: null, career: null, journal: null,
  };
  if (tab === "gear") vm.gear = gearVM(world, idx, hero, st, f);
  else if (tab === "skills") vm.skills = skillsVM(world, hero, live, st, clock);
  else if (tab === "stats") vm.stats = statsVM(world, hero, live, st);
  else if (tab === "career") vm.career = careerVM(world, idx, hero, live, clock);
  else vm.journal = journalVM(world, hero, clock);
  return vm;
}

// ---------------------------------------------------------------------------------------------
// Herd panel: header, upgrades
// ---------------------------------------------------------------------------------------------

function sprintVM(world) {
  const herd = world.state.herd;
  const zone = num(herd.zone);
  const target = Herd.sprintTarget(zone);
  if (target > 0 && BOSSES[zone]) {
    const have = Math.min(target, Math.floor(num(herd.meter) + 1e-9));
    return { label: BOSSES[zone].name, have, need: target, text: `Sprint ${have} / ${target}` };
  }
  if (Herd.backlogOpen(world.state) && herd.backlog) {
    const need = BACKLOG.killsPerFloor;
    const have = Math.min(need, Math.floor(num(herd.backlog.kills)));
    return { label: `The Backlog, floor ${Math.max(1, num(herd.backlog.floor, 1))}`, have, need, text: `Floor ${Math.max(1, num(herd.backlog.floor, 1))}: ${have} / ${need}` };
  }
  return null;
}

function herdHeader(world, idx) {
  const state = world.state;
  const herd = state.herd;
  const rel = Herd.releaseInfo(state);
  const n = state.heroes.length;
  const contractors = idx.pairs.filter((p) => p[0].contractor).length;
  const parts = [`${n} ${plural(n, "hero", "heroes")}`];
  if (contractors) parts.push(`${contractors} ${plural(contractors, "contractor")}`);
  parts.push(`${idx.counts.working} working`);
  // The blocked count also goes apart (`waiting`): the panel draws it in the blocked colour.
  const waiting = idx.counts.blocked ? `${idx.counts.blocked} waiting for you` : null;
  if (waiting) parts.push(waiting);
  const nextLabel = `v${Math.floor((rel.r + 1) / 10)}.${(rel.r + 1) % 10}`;
  const next = rel.capped ? `${nextLabel} at ${fmtInt(rel.next)} (bonuses stop at +${Math.round(T.release.bonusPer * T.release.maxRelease * 100)}%)` : `${nextLabel} at ${fmtInt(rel.next)}`;
  return {
    name: str(herd.name).trim() || "The Herd", release: rel.label,
    releaseTip: `Release Train: ${fmtInt(rel.seals)} Seals credited · ${next} · ${pct(rel.bonus, { sign: true })} XP and gold`,
    gold: fmtNum(num(herd.gold)), snippets: fmtNum(num(herd.snip)), sub: parts.join(" · "), waiting, sprint: sprintVM(world),
  };
}

const BUILDING_ICON = {
  campfire: { path: "fx/campfire.svg", mask: false }, coffee_machine: { path: "fx/mug.svg", mask: false },
  ci_forge: { path: "ui/gear.svg", mask: true }, vendor: { path: "ui/chest.svg", mask: true },
  docs_library: { path: "ui/journal.svg", mask: true }, war_room: { path: "ui/boss.svg", mask: true },
};

function buildingText(b, n) {
  const pl = b.perLevel;
  // buildings with no base effect read "Not built yet" rather than "−0%" / "+0 ticks"
  if (n <= 0 && (b.id === "ci_forge" || b.id === "docs_library" || b.id === "war_room")) return "Not built yet";
  switch (b.id) {
    case "campfire": return `Fresh Eyes cap ${freshEyesCap(n)} min`;
    case "coffee_machine": return `Coffee heals ${Math.round((T.coffee.heal + pl.coffeeHeal * n) * 100)}%${n > 0 ? ` · price ${MINUS}${Math.round(-pl.coffeePrice * n * 100)}%` : ""}`;
    case "ci_forge": {
      const u = [];
      if (n >= FORGE_SQUASH) u.push("Squash");
      if (n >= FORGE_REROLL) u.push("Reroll");
      // "Polish −32% · Squash · Reroll", as the sample has it: with "gold" in it the late card's
      // line no longer fit at 760 px (the tooltip says it is the polish gold)
      return `Polish ${MINUS}${Math.round(-pl.polishGold * n * 100)}%${u.length ? ` · ${u.join(" · ")}` : ""}`;
    }
    case "vendor": return `${Math.min(140, 40 + pl.stashSlots * n)} stash slots`;
    case "docs_library": return `+${Math.round(pl.herdXp * n * 100)}% herd XP`;
    case "war_room": return `Boss timers +${pl.bossTimerTicks * n} ticks`;
    default: return `Level ${n}`;
  }
}

function buildingNext(b, n) {
  const pl = b.perLevel;
  const m = n + 1;
  switch (b.id) {
    case "campfire": return `Next: ${freshEyesCap(m)} min`;
    case "coffee_machine": return `Next: heals ${Math.round((T.coffee.heal + pl.coffeeHeal * m) * 100)}% · ${MINUS}${Math.round(-pl.coffeePrice * m * 100)}%`;
    case "ci_forge": return `Next: ${MINUS}${Math.round(-pl.polishGold * m * 100)}%${m === FORGE_SQUASH ? " · Squash Merge" : m === FORGE_REROLL ? " · Reroll" : ""}`;
    case "vendor": return `Next: ${Math.min(140, 40 + pl.stashSlots * m)} slots`;
    case "docs_library": return `Next: +${Math.round(pl.herdXp * m * 100)}%`;
    case "war_room": return `Next: +${pl.bossTimerTicks * m} ticks`;
    default: return `Next: level ${m}`;
  }
}

const BUILDING_TIP = {
  campfire: "Fresh Eyes cap +15 min per level (60 → 210): ×1.5 kill XP after a break",
  coffee_machine: "Coffee heals +3% and costs 5% less per level",
  ci_forge: `Polish gold −4% per level; level ${FORGE_SQUASH} unlocks Squash Merge, level ${FORGE_REROLL} Reroll`,
  vendor: "Heavier than it looks.",
  docs_library: "+2% herd XP per level (inside the +60% herd cap)",
  war_room: "Boss and review timers +6 ticks per level",
};

function upgradesVM(world) {
  const state = world.state;
  const herd = state.herd;
  const gold = num(herd.gold);
  const buildings = BUILDINGS.map((b, i) => {
    const n = Herd.buildingLevel(state, i);
    const maxed = n >= b.max;
    let buy = null;
    // herd.buy refuses a level that opens later (the Campfire grows with the herd's days of play)
    const gate = !maxed && typeof Herd.buildingGate === "function" ? Herd.buildingGate(state, i) : null;
    if (!maxed) {
      const cost = buildingCost(b, n + 1);
      const ok = gold >= cost && !gate;
      let tip = `Level ${n + 1} for ${goldText(cost)}`;
      if (gate) {
        const age = typeof Herd.herdAgeDays === "function" ? Herd.herdAgeDays(state) : null;
        tip = `${b.name} ${gate.level} opens on the herd's day ${gate.day}${age != null ? ` (day ${age} now)` : ""}`;
      } else if (!ok) tip = `Needs ${goldText(cost)} (the herd has ${fmtNum(gold)})`;
      buy = action(`buy:${b.id}`, "Buy", "buy", { building: b.id }, { cost: goldText(cost), enabled: ok, tone: ok ? "primary" : null, tooltip: tip });
    }
    return {
      key: `b:${b.id}`, id: b.id, name: b.name, icon: BUILDING_ICON[b.id] || { path: "ui/star.svg", mask: true },
      level: n, max: b.max, levelText: `${n} / ${b.max}`, effect: buildingText(b, n), next: maxed ? null : `${buildingNext(b, n)}${gate ? ` · opens on day ${gate.day}` : ""}`,
      maxed, buy, tooltip: BUILDING_TIP[b.id] || b.name,
    };
  });
  const auto = autoOn(state, "buildings");
  const tr = Herd.trophies(state);
  return {
    buildings,
    note: `Autopilot buys the cheapest upgrade when gold ≥ ${T.buildingAutoBuyAt}× its cost and keeps a ${Math.round(T.goldReserve * 100)}% reserve (Auto buildings: ${auto ? "on" : "off"}).`,
    trophies: tr > 0 ? `Trophies: ${pctI(TROPHY.dmg * tr)} damage and max HP for every hero` : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Herd panel: stash
// ---------------------------------------------------------------------------------------------

/** The roster hero the focused item suits best (score), among those who can wear it now. */
function bestHero(world, item, budget = Infinity) {
  let best = null;
  let left = budget;
  for (const h of world.state.heroes) {
    if (!canEquip(h, item)) continue;
    if (h.eq[slotIdxOf(item)] === item) continue;
    let s = cachedScore(world, h, item);
    if (s == null) {
      if (left <= 0) continue; // priced on a later call (the next tick)
      left--;
      s = scoreOf(world, h, item);
    }
    if (!best || s > best.score + 1e-12) best = { hero: h, score: s };
  }
  return best;
}

/**
 * Drop the cached scores of heroes no longer in this world: an entry stays only while its hero
 * object is the roster hero or the live Contractor with that id. Runs when an entry is created
 * (rare: a hero's first priced item, a reload), O(roster + cache).
 */
function pruneScores(world) {
  if (!SCORES.size) return;
  const live = new Map();
  for (const h of world.state.heroes || []) live.set(h.id, h);
  const cs = world.rt && world.rt.contractors;
  if (cs) for (const c of cs.values()) live.set(c.id, c);
  for (const [id, e] of SCORES) if (live.get(id) !== e.hero) SCORES.delete(id);
}

/** A score already priced for the hero's current stats, or null (never prices). */
function cachedScore(world, hero, item) {
  const e = SCORES.get(hero.id);
  if (!e || e.hero !== hero) return null;
  if (e.st !== stats(hero, ctxOf(world, hero))) return null;
  const hit = e.cur.get(item.uid);
  return fresh(hit, item) ? hit[3] : null;
}

// "Best on" for a merely hovered Herd tile prices at most this many new heroes per view call
// (a score is ~0.5 ms in QuickJS; 30 heroes would eat the render budget); a selected item is
// always priced for everyone.
const BEST_HOVER_BUDGET = 8;

function herdStashVM(world, idx, f) {
  const s = stashVM(world, idx, f, "herd", null);
  const found = focusedItem(world, f);
  let card = null;
  if (found) {
    const wearer = found.where === "hero" ? found.hero : null;
    const hovered = Number.isInteger(f.hover) && found.item.uid === f.hover && f.selected !== f.hover && f.focus !== f.hover;
    const best = wearer ? null : bestHero(world, found.item, hovered ? BEST_HOVER_BUDGET : Infinity);
    card = cardVM(world, idx, found, { target: wearer ? null : best ? best.hero : null, mode: "herd", best });
  }
  const empty = (world.state.herd.stash || []).length === 0;
  return Object.assign(s.vm, {
    card,
    hint: empty ? "Items you don't wear wait here, shared by every hero." : "Pick an item to see it, polish it, or hand it to the hero it suits best.",
    squash: s.squash,
  });
}

// ---------------------------------------------------------------------------------------------
// Herd panel: Bug Tracker
// ---------------------------------------------------------------------------------------------

const PERK_WORD = { xp: "XP", gold: "gold", crit: "crit", hpPct: "max HP", itemFind: "item find", dmg: "damage", cdr: "cooldowns", dr: "DR", bossDmg: "boss damage" };

function perkText(zone, tier) {
  const k = Object.keys(zone.perk)[0];
  if (!k) return "";
  const v = zone.perk[k];
  const sign = k === "cdr" ? MINUS : "+";
  const p = Math.round(v * 100 * 10) / 10;
  return tier > 0 ? `${sign}${Math.round(p * tier * 10) / 10}% ${PERK_WORD[k] || k}${tier > 1 ? ` (×${tier})` : ""}` : `${sign}${p}% ${PERK_WORD[k] || k} per tier`;
}

// each mob's share of a zone's kills: the spawn weights of the zone's maps, the maps weighted alike
const MOB_SHARE = (() => {
  const out = {};
  for (const z of ZONES) {
    for (const m of z.maps) for (const id of Object.keys(m.spawn)) out[id] = (out[id] || 0) + m.spawn[id] / z.maps.length;
  }
  return out;
})();

function trackerVM(world, idx, clock) {
  const state = world.state;
  const herd = state.herd;
  const frontier = Math.min(num(herd.zone), ZONES.length - 1);
  const tiers = BUG_TRACKER.tiers;
  let total = 0;
  let triaged = 0;
  const zones = ZONES.map((z, zi) => {
    const zp = Herd.zonePerk(state, zi);
    const kills = num(zp.kills);
    total += kills;
    if (zp.tier > 0) triaged++;
    const locked = zi > frontier && !(num((herd.boss || [])[zi]) > 0);
    const nextNeed = zp.tier < tiers.length ? tiers[zp.tier].kills : tiers[tiers.length - 1].kills;
    const bi = BOSSES.findIndex((b) => b.zone === zi);
    const boss = BOSSES[bi];
    const clearedAt = idx.cleared[bi];
    const fixed = num((herd.boss || [])[bi]) > 0;
    return {
      key: z.id, name: locked ? "???" : z.name, num: String(zi + 1), locked, accent: z.palette.accent,
      kills: fmtInt(kills), tier: zp.tier, tierName: zp.tierName,
      // a locked zone has no kills to count yet: its row says so rather than "0 / 500"
      progress: locked ? { frac: 0, text: "Locked" }
        : zp.tier >= tiers.length ? { frac: 1, text: `${fmtInt(kills)} · Fixed` } : { frac: r2(clamp01(kills / nextNeed)), text: `${fmtInt(kills)} / ${fmtInt(nextNeed)}` },
      perk: locked ? "" : perkText(z, zp.tier),
      tiers: tiers.map((t) => ({ key: t.name.toLowerCase(), name: t.name, need: fmtInt(t.kills), reached: kills >= t.kills })),
      mobs: MOBS.filter((m) => m.zone === zi).map((m) => {
        const est = Math.round(kills * (MOB_SHARE[m.id] || 0));
        return {
          key: m.id, mobId: m.id, name: m.name, ticket: `#${4000 + (fnv1a32(m.id) % 5000)}`,
          kills: est > 0 ? `~${fmtInt(est)}` : "0", flavor: m.flavor, sprite: `mob/${m.id}.svg`, known: !locked && kills > 0,
        };
      }),
      boss: boss ? {
        key: boss.id, name: boss.name, sprite: `boss/${boss.id}.svg`,
        cleared: fixed ? (clearedAt != null ? `Fixed ${fmtDate(clearedAt, clock.tz)}` : "Fixed") : null,
        kills: `${num((herd.bossKills || [])[bi])} ${plural(num((herd.bossKills || [])[bi]), "kill")}`, known: !locked,
      } : { key: `boss:${z.id}`, name: "???", sprite: "boss/ignored_warning.svg", cleared: null, kills: "0 kills", known: false },
    };
  });
  const open = zones.filter((z) => !z.locked).length;
  const tr = Herd.trophies(state);
  return {
    zones, selected: ZONES[frontier].id,
    totals: `${fmtInt(total)} bugs filed · ${open} ${plural(open, "zone")} open · ${triaged} Triaged or better${tr ? ` · trophies ${pctI(TROPHY.dmg * tr)} damage and max HP` : ""}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Herd panel: bosses
// ---------------------------------------------------------------------------------------------

function woundsChips(world, bi, clock) {
  const herd = world.state.herd;
  const out = [];
  const w = (herd.wounds || {})[String(bi)];
  if (Array.isArray(w) && num(w[0]) > 0 && (!(num(w[1]) > 0) || clock.now < w[1])) {
    const left = num(w[1]) > 0 ? fmtDuration((w[1] - clock.now) / 1000) : null;
    out.push({ key: "wounds", text: `Wounds ${Math.round(w[0] * 100)}%${left ? ` · ${left}` : ""}`, color: COL.hp, tooltip: `It keeps ${Math.round(w[0] * 100)}% of its HP lost as Wounds${left ? ` for another ${left}` : ""}` });
  }
  if (Array.isArray(w) && num(w[2]) > 0) {
    out.push({ key: "retry", text: `Retry in ${Math.ceil(w[2] / 60)}m`, color: COL.idle, tooltip: `After a Postmortem the door reopens after ${Math.ceil(w[2] / 60)} more working minutes` });
  }
  const l = num((herd.lessons || {})[String(bi)]);
  if (l > 0) {
    const v = Math.min(T.boss.lessonsCap, T.boss.lessonsPerFail * l);
    out.push({ key: "lessons", text: `Lessons ${pctI(v)}`, color: COL.working, tooltip: `Lessons Learned: ${pctI(v)} damage against it until it falls` });
  }
  return out;
}

function bossRowVM(world, idx, bi, clock) {
  const herd = world.state.herd;
  const f = bossFacts(world, idx, bi);
  const b = f.b;
  const chips = [];
  if (f.fixed) {
    const k = num((herd.bossKills || [])[bi]);
    chips.push({ key: "kills", text: `${k} ${plural(k, "kill")}`, color: COL.idle, tooltip: "Herd kills of this boss" });
  }
  for (const c of woundsChips(world, bi, clock)) chips.push(c);
  const ks = KEEPSAKES.find((k) => k.boss === bi);
  if (f.fixed && ks) {
    const owned = Herd.keepsakesOwned(world.state).has(ks.id);
    chips.push({ key: "keepsake", text: ks.name, color: RARITIES[R_KEEPSAKE].color, tooltip: `Its Keepsake (${owned ? "the herd has it" : "15% on repeat kills"}): ${PROP_TEXT[ks.id] ? PROP_TEXT[ks.id](ks.effect) : ""}` });
  }
  let stateText;
  switch (f.state) {
    case "fixed": stateText = "FIXED"; break;
    case "door": stateText = "Door open"; break;
    case "fighting": stateText = f.paused ? "Paused" : "Fighting"; break;
    case "locked": stateText = "Locked"; break;
    default: stateText = sprintText(world, b.zone);
  }
  let challenge = null;
  if (f.state === "fixed") challenge = challengeAction(world, bi, f, "Fight again", null);
  else if (f.state === "door") challenge = challengeAction(world, bi, f, "Challenge", null);
  const cleared = idx.cleared[bi];
  return {
    key: b.id, name: f.state === "locked" ? "???" : b.name, where: `${f.state === "locked" ? "???" : ZONES[b.zone].name} · Lv ${b.level}`,
    sprite: `boss/${b.id}.svg`, state: f.state, stateText,
    estimate: f.state === "locked" ? null : estimateVM(f.E), chips: chips.slice(0, 4),
    firstClear: f.fixed && cleared != null ? `First fixed ${fmtDate(cleared, clock.tz, false)}` : null,
    flavor: f.state === "locked" ? "Beat the previous zone's boss to see it." : b.flavor,
    challenge,
  };
}

/** Retreat from the herd's boss / Backlog fight (world.retreat with {}), asked first. */
function retreatAction(key) {
  return action(key, "Retreat", "retreat", {}, { tone: "danger", confirm: "Retreat? (a Postmortem)", tooltip: "End the fight as a Postmortem: Wounds and Lessons are kept" });
}

function fightBannerVM(world) {
  const rt = world.rt;
  const herd = world.state.herd;
  let f = null;
  for (const x of rt.fights || []) if (x.kind !== "review") { f = x; break; }
  const retreat = retreatAction("retreat");
  if (f) {
    const names = (f.heroIds || []).map((id) => {
      const h = heroById(world, id);
      return h ? firstName(h) : null;
    }).filter(Boolean);
    const left = Math.max(0, num(f.timer) - num(f.t));
    const parts = [];
    if (f.phaseLabel) parts.push(str(f.phaseLabel));
    if (f.mechText) parts.push(str(f.mechText));
    parts.push(`${leftPct(f)}% HP`);
    parts.push(`${left} ${plural(left, "tick")} left`);
    if (names.length) parts.push(names.join(", "));
    return { key: str(f.key, `fight:${f.bossIdx}`), name: str(f.name, "Boss"), text: parts.join(" · "), frac: r2(fightLeft(f)), retreat };
  }
  if (herd.fight && (herd.fight.k === "b" || herd.fight.k === "x")) {
    const s = herd.fight;
    const boss = BOSSES[s.i];
    let hp = 0;
    for (const p of s.p || []) if (p[0] < 10 && p[0] !== 2) hp += num(p[1]);
    const frac = num(s.pool) > 0 ? clamp01(hp / s.pool) : 0;
    return {
      key: `paused:${s.k}:${s.i}`, name: boss ? (s.k === "x" ? `${boss.name} ${BACKLOG.versionTag}` : boss.name) : "Boss",
      text: `Paused until someone works in the zone · ${Math.max(1, Math.ceil(frac * 100))}% HP`, frac: r2(frac), retreat,
    };
  }
  return null;
}

function backlogVM(world) {
  const state = world.state;
  const herd = state.herd;
  const open = Herd.backlogOpen(state);
  if (!open) {
    return { key: "backlog", title: BACKLOG.name, text: "Opens after The Heisenbug is fixed: endless floors, no leaderboards.", progress: { frac: 0, text: "—" }, locked: true, challenge: null };
  }
  const b = herd.backlog || { floor: 1, kills: 0 };
  const floor = Math.max(1, num(b.floor, 1));
  const need = BACKLOG.killsPerFloor;
  const kills = Math.min(need, Math.floor(num(b.kills)));
  const bossFloor = floor % BACKLOG.bossEvery === 0;
  let challenge = null;
  if (bossFloor) {
    const api = bossApi(world);
    const c = typeof api.canChallenge === "function" ? api.canChallenge(world, "backlog", floor) : { ok: false, error: "Bosses are not available" };
    const args = { kind: "backlog", idx: floor };
    challenge = c && c.ok
      ? action(`challenge:backlog:${floor}`, "Challenge", "challenge", args, { tone: "primary", tooltip: `Floor ${floor} boss: ${estimateVM(c.estimate) ? estimateVM(c.estimate).text : ""}`.trim() })
      : disabled(`challenge:backlog:${floor}`, "Challenge", "challenge", args, (c && (c.error || c.label)) || "Can't challenge now");
  }
  const nextBoss = Math.ceil(floor / BACKLOG.bossEvery) * BACKLOG.bossEvery;
  return {
    key: "backlog", title: BACKLOG.name,
    text: `Floor ${floor}${bossFloor ? " · a boss floor" : ` · next boss on floor ${nextBoss}`} · mobs ×${Math.pow(BACKLOG.perFloor.hp, floor).toFixed(2)} HP`,
    progress: { frac: r2(clamp01(kills / need)), text: `${kills} / ${need} kills` }, locked: false, challenge,
  };
}

function bossesVM(world, idx, clock) {
  const tr = Herd.trophies(world.state);
  return {
    fight: fightBannerVM(world),
    bosses: BOSSES.map((b, i) => bossRowVM(world, idx, i, clock)),
    backlog: backlogVM(world),
    trophies: tr > 0 ? `Trophies: ${pctI(TROPHY.dmg * tr)} damage and max HP for every hero (one per boss fixed)` : "Trophies: each boss's first kill gives every hero +1% damage and max HP",
  };
}

// ---------------------------------------------------------------------------------------------
// Herd panel: roster and Hall of Fame
// ---------------------------------------------------------------------------------------------

function seenText(world, hero, live, clock) {
  const rt = world.rt;
  if (!live) return num(hero.seenAt) > 0 ? `seen ${ago(hero.seenAt, clock.now)}` : "never seen";
  const since = Math.max(0, num(rt.tick) - num(live.statusSince, rt.tick));
  const d = fmtDuration(since);
  switch (heroState(live)) {
    case "waiting": return `waiting ${fmtDuration(blockedSec(rt, live))}`;
    case "shipped": return `shipped ${d} ago`;
    case "resting": return `resting ${d}`;
    case "crashed": return "rebooting";
    case "supervising": return `supervising ${d}`;
    default: return `working ${d}`;
  }
}

function rosterRow(world, idx, hero, live, clock) {
  const state = heroState(live);
  const status = live ? statusWord(live.status) : "off";
  const career = careerOf(hero);
  const programKey = live ? (live.program && live.program.key) || live.app : seatParts(hero.seat).program;
  let retire = null;
  if (inRoster(world, hero) && hero.L >= RETIRE_LEVEL) {
    const first = firstName(hero);
    retire = idx.fights.has(hero.id)
      ? disabled(`retire:${hero.id}`, "Retire", "retire", { heroId: hero.id }, `${first} is in a fight`, { tone: "danger" })
      : action(`retire:${hero.id}`, "Retire", "retire", { heroId: hero.id }, {
        tone: "danger", confirm: `Retire ${first}?`, tooltip: "Joins the Hall of Fame (+0.5% herd XP); its gear goes to vendor/",
      });
  }
  return {
    key: `r:${hero.id}`, heroId: hero.id, name: `${str(hero.name, "Termling")}${hero.contractor ? " (contractor)" : ""}`, level: `Lv ${hero.L}`,
    title: career.title, status, stripe: STATUS_COLOR[status] || COL.idle,
    where: live ? mapLabel(world, live.mapId, live) || "the Stack" : "off duty",
    seen: seenText(world, hero, live, clock),
    portrait: {
      colors: termlingColors(hero, programKey, live ? state : "off"), face: faceOf(live ? state : "off"),
      programIcon: live ? programIconOf(live.program) : programIconOf(shippedProgram(programKey)),
    },
    retire,
  };
}

function rosterVM(world, idx, clock) {
  const state = world.state;
  const groups = [];
  const byKey = new Map();
  for (const [hero, live] of idx.pairs) {
    const sp = str(live.space);
    const key = `g:${sp || "none"}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, name: str(live.spaceName).trim() || sp || "Other agents", rows: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.rows.push(rosterRow(world, idx, hero, live, clock));
  }
  const off = state.heroes.filter((h) => !idx.liveOf.has(h.id));
  off.sort((a, b) => (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0) || num(a.ord) - num(b.ord) || a.id - b.id);
  if (off.length) groups.push({ key: "g:off", name: "Off duty", rows: off.map((h) => rosterRow(world, idx, h, null, clock)) });
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const fame = Herd.hallOfFame(state);
  const legacy = Herd.legacyBonus(state);
  const hired = hiredToday(state);
  return {
    count: `${state.heroes.length} / ${T.roster.max} heroes · ${hired} hired today (${T.roster.newPerDay} a day)`,
    slim: total > ROSTER_SLIM_AT,
    groups,
    emptyText: "No heroes yet. Start an agent to hire one: every coding agent becomes a Termling.",
    fame: {
      title: "Hall of Fame", bonus: `Legacy ${pct(legacy, { sign: true })} herd XP`,
      rows: fame.slice(0, FAME_ROWS).map((e, i) => ({
        key: `f:${fame.length - i}`, name: e.name, cls: e.clsName,
        level: `Lv ${e.level}`, date: e.at > 0 ? fmtDate(e.at, clock.tz) : "",
      })),
      more: fame.length > FAME_ROWS ? `+${fame.length - FAME_ROWS} more` : null,
      emptyText: `Heroes retired at Lv ${RETIRE_LEVEL}+ rest here and add +0.5% herd XP each.`,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Herd panel: digest
// ---------------------------------------------------------------------------------------------

function capLines(key, lines) {
  if (lines.length <= DIGEST_LINES) return lines;
  const out = lines.slice(0, DIGEST_LINES - 1);
  out.push({ key: `${key}:more`, text: `+${lines.length - out.length} more`, sub: null, color: COL.idle, tint: false, action: null });
  return out;
}

function digestVM(world, clock) {
  const state = world.state;
  const herd = state.herd;
  const d = Herd.digest(state);
  const since = num(herd.digestAt);
  const byId = new Map(state.heroes.map((h) => [h.id, h]));
  const line = (key, text, sub, color, act = null, tint = false) => ({ key, text, sub, color, tint, action: act });
  // the first level each hero reached since (to show "Lv 32 → 34")
  const firstLv = new Map();
  for (const e of herd.log || []) if (e && e[0] > since && e[1] === "level" && !firstLv.has(e[2])) firstLv.set(e[2], num(e[4]));
  const levels = d.levels.slice().sort((a, b) => b.at - a.at).map((l) => {
    const name = l.name || (byId.get(l.heroId) || {}).name || "A hero";
    const from = Math.max(1, num(firstLv.get(l.heroId), l.level) - 1);
    return line(`lv:${l.heroId}`, `${name} reached Lv ${l.level}`, from < l.level ? `Lv ${from} → ${l.level}` : null, COL.xp);
  });
  // keys from the entry itself (time, hero, text), never its position: a new line must not rename
  // the older ones (ARCHITECTURE §5)
  const used = new Set();
  const keyOf = (pre, x) => {
    const base = `${pre}:${num(x.at)}:${num(x.heroId)}:${fnv1a32(str(x.text)) % 100000}`;
    let k = base;
    for (let n = 1; used.has(k); n++) k = `${base}:${n}`;
    used.add(k);
    return k;
  };
  const drops = d.drops.slice().reverse().map((x) => {
    const r = RARITIES[num(x.rar)] || RARITIES[3];
    const who = x.name ? firstName({ name: x.name }) : "vendor/";
    return line(keyOf("d", x), str(x.text), `${who} · ${r.name}`, r.color, null, true);
  });
  const bosses = d.bosses.slice().reverse().map((x) => {
    const fixed = !/Postmortem/.test(str(x.text));
    return line(keyOf("b", x), bossLine(str(x.text), x.value), whenOrEarlier(x.at, clock), fixed ? COL.working : COL.idle);
  });
  const shipped = d.shipped.slice().reverse().map((x) => line(
    keyOf("s", x), `${x.name ? firstName({ name: x.name }) : "A hero"} shipped “${str(x.text) || "Commit"}”`,
    num(x.seals) > 0 ? `${(Math.round(num(x.seals) * 10) / 10).toFixed(1)} Seals` : null, COL.done,
  ));
  // chests that opened Unreviewed (off duty 24 h, or the hero left): where the chest went
  const unreviewed = (d.unreviewed || []).slice().reverse().map((x) => {
    const who = x.name ? firstName({ name: x.name }) : "A hero";
    const n = Math.max(1, num(x.n, 1));
    const text = n > 1 ? `${who}: ${n} chests opened Unreviewed` : `${who}'s chest opened Unreviewed`;
    return line(keyOf("u", x), text, `${n === 1 && str(x.text) ? `“${str(x.text)}” · ` : ""}half value, no Seals`, COL.idle);
  });
  const badges = d.badges.slice().reverse().map((x) => line(keyOf("bd", x), `Badge: ${str(x.text)}`, whenOrEarlier(x.at, clock), COL.xp));
  const chests = [];
  for (const h of state.heroes) {
    const p = pendingSummary(h);
    if (!p) continue;
    const live = world.rt.live && world.rt.live.has(h.id);
    let sub = p.title ? `“${p.title}”` : null;
    if (!live && Number.isFinite(p.oldest)) {
      const leftMs = T.seals.unreviewedAfterSec * 1000 - (clock.now - p.oldest);
      sub = leftMs > 0 ? `off duty · opens Unreviewed in ${fmtDuration(leftMs / 1000)}` : "off duty · opens Unreviewed soon";
    }
    chests.push(line(`c:${h.id}`, `${h.name}: ${p.n > 1 ? `${p.n} chests` : `${p.tier} chest`} · ${p.seals.toFixed(1)} Seals`, sub, COL.done,
      action(`claim:${h.id}`, "Open", "claimChest", { heroId: h.id }, { tooltip: live ? "Open it (counts as seen)" : "Open it now with full value" })));
  }
  const sections = [];
  const add = (key, title, icon, lines) => { if (lines.length) sections.push({ key, title, icon, lines: capLines(key, lines) }); };
  add("levels", "Levels", "ui/star.svg", levels);
  add("drops", "Release or better", "ui/slot-weapon.svg", drops);
  add("bosses", "Bosses", "ui/boss.svg", bosses);
  add("shipped", "Shipped", "ui/chest.svg", shipped);
  add("unreviewed", "Opened Unreviewed", "ui/chest.svg", unreviewed);
  add("badges", "Badges", "ui/star.svg", badges);
  add("chests", "Chests waiting", "ui/chest.svg", chests);
  const dot = !!world.rt.digestDot;
  const empty = sections.length === 0;
  return {
    since: since > 0 ? `Since you last looked · ${ago(since, clock.now)}` : "Since the herd began",
    sections,
    // a herd never looked at has no "last looked" (its header says "Since the herd began")
    emptyText: since > 0 ? "Nothing new since you last looked." : "Nothing yet: levels, big drops, bosses and shipped tasks land here.",
    ack: !empty || dot ? action("digest:ack", "Mark as read", "digestSeen", {}, { tooltip: "Clears the dot on the Herd button; the next digest starts now" }) : null,
  };
}

function digestBadge(world) {
  const d = Herd.digest(world.state);
  if (d.empty) return world.rt.digestDot ? "•" : null;
  const n = d.levels.length + d.drops.length + d.bosses.length + d.badges.length + (d.unreviewed || []).length + d.chestsWaiting;
  if (n <= 0) return "•";
  return n > 9 ? "9+" : String(n);
}

// ---------------------------------------------------------------------------------------------
// Herd panel: settings
// ---------------------------------------------------------------------------------------------

/** A win-estimate threshold as the boss cards show estimates: 0.9 → "90%". */
const atPct = (x) => `${Math.round(num(x, 1) * 100)}%`;

function settingsVM(world) {
  const herd = world.state.herd;
  const cfg = herd.cfg || {};
  const auto = cfg.auto || {};
  const notify = cfg.notify || {};
  const tog = (key, label, hint, setting, value) => ({ key, label, hint, kind: "toggle", value: !!value, options: null, setting, chrome: null });
  // the master switch (D§11.15): off stops every system; their own switches keep their values and
  // show as inactive until it is back on
  const master = cfg.autopilot !== false;
  const sys = (key, label, hint) => Object.assign(tog(`auto.${key}`, label, hint, `auto.${key}`, auto[key] !== false),
    master ? {} : { inactive: true, tooltip: "Autopilot is off: turn it on above to use this" });
  const glow = Math.max(0, Math.min(RARITIES.length - 1, Math.round(num(cfg.glow, 0))));
  // the nearest offered height (the layout can be resized to any 64–420 px)
  const stageH = [64, 120, 200].reduce((best, h) => (Math.abs(h - num(cfg.stageH, 200)) < Math.abs(best - num(cfg.stageH, 200)) ? h : best), 200);
  return {
    groups: [
      { key: "display", title: "Display", hint: null, rows: [
        tog("calm", "Calm mode", "No damage numbers, banners or blinking; the stage dims", "calm", cfg.calm),
        { key: "nums", label: "Damage numbers", hint: null, kind: "choice", value: ["all", "crits", "off"].includes(cfg.nums) ? cfg.nums : "all",
          options: [{ id: "all", label: "All" }, { id: "crits", label: "Crits" }, { id: "off", label: "Off" }], setting: "nums", chrome: null },
        // six options: the control takes its own line (wide)
        { key: "glow", label: "Loot glow minimum rarity", hint: "Drops below it neither glow on their way to the hero nor raise a pillar", kind: "choice", value: glow,
          options: RARITIES.map((r, i) => ({ id: i, label: i === 0 ? "All" : r.name, color: r.color })), setting: "glow", chrome: null, wide: true },
        { key: "stageH", label: "Stage height", hint: "At 64 px: nameplates, chests, bubbles and HP lines only", kind: "choice", value: stageH,
          options: [{ id: 64, label: "64" }, { id: 120, label: "120" }, { id: 200, label: "200" }], setting: "stageH", chrome: { resize: "stage" } },
        { key: "hud", label: "HUD strip", hint: "A thin strip under the stage: gold, Sprint, who's working", kind: "toggle", value: null, options: null, setting: null, chrome: { toggle: "hud" } },
        tog("collapse", "Collapse the stage when nothing works", "Hides it a minute after the last hero stops; it comes back when one works", "collapse", cfg.collapse),
      ] },
      { key: "notify", title: "Notifications", hint: "Off by default; at most 3 a day; never a sound.", rows: [
        tog("notify.boss", "Herd-first boss kill", null, "notify.boss", notify.boss),
        tog("notify.lts", "LTS or Keepsake drop", null, "notify.lts", notify.lts),
        tog("notify.principal", "A hero reaches Principal", null, "notify.principal", notify.principal),
      ] },
      { key: "autopilot", title: "Autopilot", hint: null, rows: [
        tog("auto", "Autopilot", master ? "Every system below; turning it off keeps their switches" : "Off: nothing below runs; the switches keep their values", "auto", master),
        sys("equip", "Auto-equip", "Equips upgrades that score +2% or better"),
        sys("deprecate", "Auto-deprecate", "Salvages Prototype and Alpha drops nobody can use"),
        sys("learn", "Auto-learn", "Spends skill points (each hero can opt out)"),
        sys("polish", "Auto-polish", "One item a minute, keeping a 20% gold reserve"),
        sys("buildings", "Buildings", "Buys the cheapest upgrade at 3× its cost"),
        sys("maps", "Map choice", "Moves heroes to the deepest map they outfight"),
        sys("boss", "Auto-boss", `Challenges when the win estimate is ${atPct(T.boss.autoAt)} or more`),
        sys("farm", "Farm bosses", `Fights beaten bosses again at ${atPct(T.boss.farmAt)} or more`),
        sys("calls", "Answer calls", "Heroes who beat a boss help others fight it"),
        // auto.career gates only the promotion reviews (autopilot.autoChallenge); the Lv 10 class
        // and its provisional switches follow the hero's work whatever this says (D§4.2)
        sys("career", "Promotion reviews", `Starts a hero's Senior and Staff Reviews at ${atPct(T.boss.autoAt)} or more`),
      ] },
    ],
    herd: { name: str(herd.name).trim() || "The Herd", hint: "Shown here and in the sidebar. Renaming is free." },
  };
}

// ---------------------------------------------------------------------------------------------
// herdView
// ---------------------------------------------------------------------------------------------

let HERD_MEMO = null;

/**
 * The Herd panel (D§11.14).
 * @param {object} world
 * @param {{tab?:string, filter?:object, nowMs?:number, tzOffsetMin?:number, save?:object|null}} args
 *   save: host.saveStatus() while the save is in trouble (the band under the header, D§13.4)
 * @returns {object|null} HerdVM (ui/herdpanel.js typedefs); null while the world loads
 */
export function herdView(world, args = {}) {
  if (!world || !world.state || !world.rt) return null;
  const a = args && typeof args === "object" ? args : {};
  const clock = clockOf(world, a);
  const tabIds = HERD_TABS.map((t) => t[0]);
  const tab = tabIds.includes(a.tab) ? a.tab : "upgrades";
  const f = normFilter(a.filter);
  const rt = world.rt;
  const save = saveVM(a.save);
  const key = JSON.stringify([tab, tab === "stash" ? f : null, Math.floor(clock.now / 60000), clock.tz, save]);
  const m = HERD_MEMO;
  if (m && m.rt === rt && m.state === world.state && m.version === rt.version && m.key === key) return m.vm;
  const vm = buildHerd(world, tab, f, clock);
  vm.save = save;
  HERD_MEMO = { rt, state: world.state, version: rt.version, key, vm };
  return vm;
}

/**
 * D§13.4 / D§13.1: the save trouble the host passes as args.save (host.saveStatus()) as the Herd
 * panel's band: {title, text, tooltip}, or null while the save is fine.
 */
function saveVM(st) {
  if (!st || typeof st !== "object" || typeof st.message !== "string" || !st.message) return null;
  const title = typeof st.title === "string" && st.title ? st.title
    : st.readOnly ? "Save is read-only" : st.notSaving ? "Not saving" : "Save restored";
  return { title, text: st.message, tooltip: st.detail ? String(st.detail) : null };
}

function buildHerd(world, tab, f, clock) {
  const idx = indexOf(world);
  const badge = digestBadge(world);
  const vm = {
    tab, tabs: HERD_TABS.map(([id, label]) => ({ id, label, badge: id === "digest" ? badge : null })),
    calm: !!(world.state.herd.cfg && world.state.herd.cfg.calm), header: herdHeader(world, idx),
    save: null, upgrades: null, stash: null, tracker: null, bosses: null, roster: null, digest: null, settings: null,
  };
  if (tab === "upgrades") vm.upgrades = upgradesVM(world);
  else if (tab === "stash") vm.stash = herdStashVM(world, idx, f);
  else if (tab === "tracker") vm.tracker = trackerVM(world, idx, clock);
  else if (tab === "bosses") vm.bosses = bossesVM(world, idx, clock);
  else if (tab === "roster") vm.roster = rosterVM(world, idx, clock);
  else if (tab === "digest") vm.digest = digestVM(world, clock);
  else vm.settings = settingsVM(world);
  return vm;
}

/** Test hook: the hero ids the item-score cache holds (pruneScores keeps it to live heroes). */
export function _scoreCacheIds() {
  return Array.from(SCORES.keys());
}

/** Test hook: forget the memoised VMs and the per-version index. */
export function _resetPanelsMemo() {
  SHEET_MEMO = null;
  HERD_MEMO = null;
  INDEX = null;
}
