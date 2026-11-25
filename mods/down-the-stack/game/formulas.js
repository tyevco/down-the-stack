// Pure math of the game: the reference kit (D§5.2), mob formulas (D§5.8), XP curve (D§6), item
// math (D§8), economy curves (D§10) and number formatting (D§11.7). No state, no RNG.
//
// Every curve reads its constants from data.js TUNING so a rebalance is a data change.

import { TUNING as T, CHEST_TIERS, RARITIES, ELITE, BUG_TRACKER, TIER_COUNT } from "./data.js";

const LN_G = Math.log(T.g);

// ---------------------------------------------------------------------------------------------
// Journal length (D§13.3; balance, docs/BALANCE.md §10). Here, not in herd.js, because both
// herd.js and items.js write journal lines (and herd.js imports items.js).
// ---------------------------------------------------------------------------------------------

// D§13.3 caps the journal at 60 lines; balance: up to 120, so a hero's Journal tab keeps about
// D§11.13's 30 lines in a typical herd (60 lines were 55-180 minutes of a four-agent herd, 12-17
// lines a hero). A line is ~38 B in a typical save and up to ~60 B, so the extra lines taper off
// past 20 heroes (logMax): D§13.3's worst case (30 heroes in full gear, 140 stash items) keeps its
// 60 lines and stays inside 30 KB.
export const LOG_MAX = 120;
const LOG_MIN = 60; //         D§13.3
const LOG_TAPER_FROM = 20; //  heroes; 6 lines fewer for each hero past it
const LOG_TAPER_STEP = 6;

/** The journal length for this roster (D§13.3, balance): 120 lines up to 20 heroes, 60 from 30. */
export function logMax(state) {
  const n = state && Array.isArray(state.heroes) ? state.heroes.length : 0;
  return Math.max(LOG_MIN, Math.min(LOG_MAX, LOG_MAX - LOG_TAPER_STEP * (n - LOG_TAPER_FROM)));
}

/**
 * Is an autopilot system on (D§11.15)? `key` is one of herd.cfg.auto's switches (equip, deprecate,
 * learn, polish, buildings, maps, boss, farm, calls, career). The master switch herd.cfg.autopilot
 * turns every system off without touching the per-system switches, which come back as they were.
 * Missing values count as on (a fresh herd runs on autopilot).
 */
export function autoOn(state, key) {
  const cfg = state && state.herd && state.herd.cfg;
  if (!cfg) return true;
  if (cfg.autopilot === false) return false;
  return !(cfg.auto && cfg.auto[key] === false);
}

// ---------------------------------------------------------------------------------------------
// Core curve and reference kit (D§5.1, D§5.2)
// ---------------------------------------------------------------------------------------------

/** g(x) = 1.07^(x - 1), for x >= 1 (smaller x is clamped to 1). */
export function g(x) {
  return Math.pow(T.g, Math.max(1, x) - 1);
}

/** Reference item level iRef(L) = max(1, L - 2). */
export function iRef(L) {
  return Math.max(1, L - T.ref.iOffset);
}

/** Reference crit chance at level L (includes the reference gear crit 0.05% per level). */
export function critRef(L) {
  const R = T.ref;
  const keen = 4 + R.keen * (L - 1);
  return Math.min(T.critCap, T.critBase + R.critPerKeen * keen + R.critPerL * L);
}

/** Expected Main hit of the reference hero at level L (crit averaged in). */
export function refHit(L) {
  const R = T.ref;
  const i = iRef(L);
  const might = 4 + R.might * (L - 1);
  return T.weaponBase * g(i) * (1 + R.rarityPerL * L) * (1 + R.polishPerL * L) * (1 + might / 100) *
    (1 + R.dmgPerL * L) * (1 + 0.5 * critRef(L));
}

/** Max HP of the reference hero at level L. */
export function refHP(L) {
  const R = T.ref;
  const grit = 4 + R.grit * (L - 1);
  return T.hpBase * g(L) * (1 + grit / 100) * (1 + R.hpPerL * L);
}

/** Total armor of the reference hero at level L. */
export function refArmor(L) {
  const R = T.ref;
  return R.armorK * g(iRef(L)) * (1 + R.rarityPerL * L) * (1 + R.polishPerL * L) * (1 + R.armorPerL * L);
}

/**
 * Damage reduction against an attacker of level m: min(0.75, A / (A + 25 g(m)) + flat).
 * @param {number} armor total armor  @param {number} m attacker level  @param {number} [flat] flat DR%
 */
export function DR(armor, m, flat = 0) {
  const a = Math.max(0, armor || 0);
  return Math.max(0, Math.min(T.drCap, a / (a + T.drConst * g(m)) + (flat || 0)));
}

/** DR of the reference hero against an on-level attacker. */
export function refDR(m) {
  return DR(refArmor(m), m);
}

/** Single-target damage per tick of an on-level reference hero: mobHP(L) / 3. */
export function refDPS(L) {
  return mobHP(L) / 3;
}

// ---------------------------------------------------------------------------------------------
// Mobs (D§5.8)
// ---------------------------------------------------------------------------------------------

/** mobHP(m) = round((1.6 + 0.62 sqrt(m)) * refHit(m) * hpMult). */
export function mobHP(m, hpMult = 1) {
  const [a, b] = T.mobHpFactor;
  return Math.round((a + b * Math.sqrt(m)) * refHit(m) * hpMult);
}

/** mobATK(m) = round(0.03 * refHP(m) / (1 - refDR(m)) * atkMult), per swing. */
export function mobATK(m, atkMult = 1) {
  return Math.round(T.mobSwingPctOfRefHp * refHP(m) / (1 - refDR(m)) * atkMult);
}

/** mobXP(m) = round((4 + m) * 1.06^(m - 1) * xpMult). */
export function mobXP(m, xpMult = 1) {
  const [a, b] = T.xpBase;
  return Math.round((a + m) * Math.pow(b, m - 1) * xpMult);
}

/** gold(m) = round((2 + m) * 1.05^(m - 1) * goldMult). */
export function gold(m, goldMult = 1) {
  const [a, b] = T.goldBase;
  return Math.round((a + m) * Math.pow(b, m - 1) * goldMult);
}

/**
 * Final stats of one lane entity at a level.
 * @param {{hp?:number, atk?:number, xp?:number, gold?:number}} mobDef multipliers (data MOBS/ADDS entry)
 * @param {number} level
 * @param {{elite?:boolean, bossMult?:number|{hp?,atk?,xp?,gold?}, floor?:number}} [opts]
 *   elite: Smelly elite (HP x3, ATK x1.5, XP x4, gold x4);
 *   bossMult: extra multipliers (a number scales HP only), e.g. a boss's Bk/Ak or an add's factor;
 *   floor: Backlog floor f (HP x1.06^f, ATK x1.05^f, XP x1.03^f; D§9.8).
 * @returns {{hp:number, atk:number, xp:number, gold:number}}
 */
export function mobStats(mobDef, level, opts = {}) {
  const d = mobDef || {};
  let hp = d.hp ?? 1;
  let atk = d.atk ?? 1;
  let xp = d.xp ?? 1;
  let gd = d.gold ?? 1;
  if (opts.elite) {
    hp *= ELITE.hp; atk *= ELITE.atk; xp *= ELITE.xp; gd *= ELITE.gold;
  }
  const bm = opts.bossMult;
  if (typeof bm === "number") hp *= bm;
  else if (bm) {
    hp *= bm.hp ?? 1; atk *= bm.atk ?? 1; xp *= bm.xp ?? 1; gd *= bm.gold ?? 1;
  }
  const f = opts.floor || 0;
  if (f > 0) {
    hp *= Math.pow(1.06, f); atk *= Math.pow(1.05, f); xp *= Math.pow(1.03, f);
  }
  return { hp: mobHP(level, hp), atk: mobATK(level, atk), xp: mobXP(level, xp), gold: gold(level, gd) };
}

/** Boss HP for n participants at the start: round(Bk * mobHP(Lb) * (1 + 0.75 (n - 1))) (D§9.5). */
export function bossHP(bk, Lb, n = 1) {
  return Math.round(bk * mobHP(Lb) * (1 + T.boss.partyHpPerExtra * (Math.max(1, n) - 1)));
}

/** Boss basic swing: round(Ak * mobATK(Lb)) (D§9.5). */
export function bossSwing(ak, Lb) {
  return Math.round(ak * mobATK(Lb));
}

// ---------------------------------------------------------------------------------------------
// XP (D§6)
// ---------------------------------------------------------------------------------------------

/** On-level kills needed for level L -> L+1: round(22 + 8L + 0.18 L^2.5). */
export function K(L) {
  const [a, b, c, e] = T.kOfL;
  return Math.round(a + b * L + c * Math.pow(L, e));
}

/** XP needed for level L -> L+1: mobXP(L) * K(L). */
export function need(L) {
  return mobXP(L) * K(L);
}

/**
 * Level-gap XP modifier, d = heroLevel - mobLevel:
 * mobs above you up to +25%; 0..2 below no change; then -10% per level, floor 10%.
 */
export function gap(d) {
  const G = T.gap;
  if (d < 0) return 1 + G.bonusPerLevelBelow * Math.min(G.bonusCapLevels, -d);
  if (d <= G.freeAbove) return 1;
  return Math.max(G.floor, 1 - G.lossPerLevel * (d - G.freeAbove));
}

/**
 * Kill XP (D§6.2). All percent bonuses are fractions; xpPct is ΣXP% (gear, party, banner, ...).
 * @param {{m:number, L:number, xpMult?:number, elite?:boolean, xpPct?:number, freshEyes?:boolean,
 *          shiftKill?:number, crowding?:number}} a
 */
export function killXP(a) {
  return mobXP(a.m, a.xpMult ?? 1) * (a.elite ? ELITE.xp : 1) * gap(a.L - a.m) * (1 + (a.xpPct || 0)) *
    (a.freshEyes ? T.freshEyes.xpMult : 1) * (a.shiftKill ?? 1) * (a.crowding ?? 1);
}

/** Chest XP = seals * 45 * mobXP(mapMid) * (1 + ΣXP%) (no Fresh Eyes). */
export function chestXP(seals, mapMid, xpPct = 0) {
  return seals * T.seals.chestXpPerSeal * mobXP(mapMid) * (1 + xpPct);
}

/** Chest gold = seals * 20 * gold(mapMid). */
export function chestGold(seals, mapMid) {
  return seals * T.seals.chestGoldPerSeal * gold(mapMid);
}

/**
 * Boss XP: T.boss.xpFirst x Need(L) on a hero's first kill of a boss (and per review won), T.boss.xpRepeat x
 * Need(L) on repeats (balance: 0.1 / 0.02; D§6.2 says 0.5 / 0.1, docs/BALANCE.md).
 */
export function bossXP(L, first) {
  const B = T.boss;
  return (first ? B.xpFirst ?? 0.5 : B.xpRepeat ?? 0.1) * need(Math.min(L, T.levelCap - 1));
}

/** Crowding multiplier on kill rewards: min(1, 12 / heroes Questing at once). */
export function crowding(questing) {
  return questing > T.crowdingAt ? T.crowdingAt / questing : 1;
}

/** Party XP bonus: +6% per other Questing member in the room, max +18%. */
export function partyXp(otherQuesting) {
  return Math.min(T.party.cap, T.party.perMember * Math.max(0, otherQuesting));
}

// ---------------------------------------------------------------------------------------------
// Tasks, Seals, Daily Shift, Fresh Eyes (D§2.4, D§2.9)
// ---------------------------------------------------------------------------------------------

/** rawSeals(m) = 0 under 1.5 working minutes, else min(m, 120) / 10. */
export function rawSeals(minutes) {
  const S = T.seals;
  if (!(minutes >= S.minMinutes)) return 0;
  return Math.min(minutes, S.capMinutes) * S.perMinute;
}

/** Commit Chest tier entry (data CHEST_TIERS) for a rawSeals value. */
export function chestTierOf(raw) {
  let tier = CHEST_TIERS[0];
  for (const t of CHEST_TIERS) if (raw >= t.minSeals) tier = t;
  return tier;
}

/** Daily Shift band for working minutes today: 0 (0-4 h), 1 (4-8 h), 2 (8 h+). */
export function shiftBand(minutesToday) {
  const [a, b] = T.shift.bandsMin;
  return minutesToday >= b ? 2 : minutesToday >= a ? 1 : 0;
}

/** Kill XP / gold / drop multiplier for the Daily Shift. */
export function shiftKillMult(minutesToday) {
  return T.shift.kill[shiftBand(minutesToday)];
}

/** Seals and chest gold/XP multiplier for the Daily Shift. */
export function shiftSealMult(minutesToday) {
  return T.shift.seal[shiftBand(minutesToday)];
}

/** Fresh Eyes cap in minutes: 60 + 15 * Campfire level. */
export function freshEyesCap(campfireLevel = 0) {
  return T.freshEyes.capBaseMin + T.freshEyes.capPerCampfire * (campfireLevel || 0);
}

// ---------------------------------------------------------------------------------------------
// Items (D§8)
// ---------------------------------------------------------------------------------------------

/** Item tier t = clamp(ceil(i / 20), 1, 5). */
export function itemTier(i) {
  return Math.min(TIER_COUNT, Math.max(1, Math.ceil(i / 20)));
}

/**
 * Required hero level for item level i: max(1, i - 3), capped at the level cap.
 * design gap: Backlog loot (D§9.8) has item level 100 + floor(f / 2), so without the cap every
 * item above iLvl 103 would need a level no hero can reach.
 */
export function reqLevel(i) {
  return Math.min(T.levelCap, Math.max(1, i - 3));
}

/** WeaponDmg = 6 g(i) R (1 + 0.05 p). */
export function weaponDmg(i, R = 1, p = 0) {
  return T.weaponBase * g(i) * R * (1 + T.polish.perLevel * p);
}

/** Damage with no weapon equipped: 3 g(L). */
export function bareHandDmg(L) {
  return (T.weaponBase / 2) * g(L);
}

/** ArmorPiece = 3 K_slot g(i) R (1 + 0.05 p). */
export function armorPiece(slotK, i, R = 1, p = 0) {
  return T.armorBase * slotK * g(i) * R * (1 + T.polish.perLevel * p);
}

/** Item Power = round(10 i R (1 + 0.05 p) (1 + 0.08 affixCount)). */
export function itemPower(i, R, p = 0, affixCount = 0) {
  return Math.round(10 * i * R * (1 + T.polish.perLevel * p) * (1 + 0.08 * affixCount));
}

/**
 * Cost of polishing an item from +p to +p+1 (always succeeds):
 * gold round(100 g(i) (p+1)^1.6 (1 - 0.04 CI Forge level)), Snippets (p+1) t.
 */
export function polishCost(i, p, forgeLevel = 0) {
  const P = T.polish;
  return {
    gold: Math.round(P.goldBase * g(i) * Math.pow(p + 1, P.exp) * (1 - P.forgeDiscount * (forgeLevel || 0))),
    snippets: (p + 1) * itemTier(i),
  };
}

/** Max polish level of a rarity index. */
export function polishMax(rar) {
  return (RARITIES[rar] || RARITIES[0]).polishMax;
}

/** Deprecate yield: Snippets = yield(rarity) * t, gold = 2 gold(i). Keepsakes yield nothing. */
export function deprecateYield(i, rar) {
  const y = (RARITIES[rar] || RARITIES[0]).deprecate;
  if (y == null) return { snippets: 0, gold: 0 };
  return { snippets: y * itemTier(i), gold: 2 * gold(i) };
}

// ---------------------------------------------------------------------------------------------
// Herd economy (D§10)
// ---------------------------------------------------------------------------------------------

/**
 * Gold cost of building level n: base * 3^(n - 1).
 * @param {number|{base:number}} base a base cost or a BUILDINGS entry
 */
export function buildingCost(base, n) {
  const b = typeof base === "number" ? base : base.base;
  return Math.round(b * Math.pow(T.buildingCostGrowth, n - 1));
}

/** Cumulative credited Seals needed to reach release r: round(8 r^1.35). */
export function releaseSeals(r) {
  const [a, e] = T.release.seals;
  return r <= 0 ? 0 : Math.round(a * Math.pow(r, e));
}

/** Highest release reached with `seals` cumulative Seals (uncapped; bonuses stop at 60). */
export function releaseOf(seals) {
  let r = 0;
  while (releaseSeals(r + 1) <= seals) r++;
  return r;
}

/** Release label v{floor(r/10)}.{r mod 10}. */
export function releaseLabel(r) {
  return `v${Math.floor(r / 10)}.${r % 10}`;
}

/** Coffee price per cup: 2 gold(L), -5% per Coffee Machine level. */
export function coffeePrice(L, machineLevel = 0) {
  return T.coffee.priceGoldMult * gold(L) * (1 - 0.05 * (machineLevel || 0));
}

/** Bug Tracker tier for a zone's (elite-weighted) kills: 0 none, 1 Triaged, 2 Reproduced, 3 Fixed. */
export function trackerTier(kills) {
  const tiers = BUG_TRACKER.tiers;
  let t = 0;
  for (let i = 0; i < tiers.length; i++) if (kills >= tiers[i].kills) t = i + 1;
  return t;
}

/** Power Level (D§5.7): L + clamp(round(ln(DPS_est / refDPS(L)) / ln 1.07), -5, +8). */
export function powerLevel(L, dpsEst) {
  if (!(dpsEst > 0)) return L - 5;
  const d = Math.round(Math.log(dpsEst / refDPS(L)) / LN_G);
  return L + Math.max(-5, Math.min(8, d));
}

// ---------------------------------------------------------------------------------------------
// Number formatting (D§11.7)
// ---------------------------------------------------------------------------------------------

function trunc(x, digits) {
  const f = Math.pow(10, digits);
  return (Math.floor(x * f + 1e-9) / f).toFixed(digits);
}

/**
 * Compact number: < 1,000 exact; 1.0k-99.9k; 100k-999k; 1.00M, 10.0M, 100M; then 1.00B, 10.0B, 100B, 1234B.
 * Truncates (never rounds up into the next unit).
 */
export function fmtNum(n) {
  if (!Number.isFinite(n)) return "0";
  const neg = n < 0;
  let a = Math.abs(n);
  if (a < 1000) a = Math.round(a);
  let s;
  if (a < 1e3) s = String(a);
  else if (a < 1e5) s = trunc(a / 1e3, 1) + "k";
  else if (a < 1e6) s = Math.floor(a / 1e3) + "k";
  else if (a < 1e7) s = trunc(a / 1e6, 2) + "M";
  else if (a < 1e8) s = trunc(a / 1e6, 1) + "M";
  else if (a < 1e9) s = Math.floor(a / 1e6) + "M";
  else if (a < 1e10) s = trunc(a / 1e9, 2) + "B";
  else if (a < 1e11) s = trunc(a / 1e9, 1) + "B";
  else s = Math.floor(a / 1e9) + "B";
  return neg && s !== "0" ? "-" + s : s;
}

/**
 * Duration from SECONDS: "45s", "2m", "1h 05m", "2d 03h". With {capHour:true} anything from one
 * hour up reads "1h+" (the blocked clock tag, D§11.10).
 */
export function fmtDuration(sec, opts = {}) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (opts.capHour) return "1h+";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 24) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, "0")}h`;
}

// ---------------------------------------------------------------------------------------------
// Text that goes to herdr
// ---------------------------------------------------------------------------------------------

// A surrogate pair, or a surrogate on its own (half of an emoji). Without the u flag a regex
// matches UTF-16 units, so one pattern finds both.
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;
const ANY_SURROGATE = /[\uD800-\uDFFF]/;

/**
 * `s` cut to at most `n` UTF-16 units, never through the middle of a character: a cut that would
 * keep only the first half of a surrogate pair (an emoji) stops before it. herdr turns every text
 * a mod hands it into UTF-8 (rquickjs from_utf8), which rejects a lone surrogate: the call throws
 * and the whole role renders as its error chip.
 */
export function cutText(s, n) {
  const t = String(s ?? "");
  if (t.length <= n) return t;
  const c = t.charCodeAt(n - 1);
  return t.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/**
 * `s` with every lone surrogate (half of an emoji) replaced by `repl` (default U+FFFD, the
 * replacement character; "" drops it); well-formed text comes back as it is. A regex rather than
 * String.prototype.toWellFormed, which an older QuickJS lacks.
 */
export function wellFormed(s, repl = "�") {
  const t = String(s ?? "");
  if (!ANY_SURROGATE.test(t)) return t;
  return t.replace(SURROGATES, (m) => (m.length === 2 ? m : repl));
}
