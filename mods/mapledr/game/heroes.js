// Heroes: creation and default names (D§3.3), derived stats (D§5.3) with DPS_est / Power Level
// (D§5.7), XP and level-ups (D§6.4), the career ladder (D§4.1), class from behaviour (D§4.2) and
// skills (D§7.1: ranks, gates, auto-learn, respec). The rotation itself lives in combat.js; this
// module only runs a deterministic expected-value dry run of it for DPS_est.
//
// Pure: no host calls, no Date.now(), no Math.random().

import {
  TUNING as T, CLASSES, CAREERS, SKILLS, SKILL_SLOTS, NAMES, ZONES, TROPHY, BUILDINGS, BUILDING_IDX, CLASS_IDX,
  RARITIES,
} from "./data.js";
import { g, DR, need, bareHandDmg, weaponDmg, powerLevel, trackerTier } from "./formulas.js";
import { fnv1a32, rngNext, seedOf } from "./rng.js";
import { itemStats, newItem, canEquip, FLAG_STARTER } from "./items.js";

const N_SLOTS = 6;
const N_SKILLS = SKILL_SLOTS.length; // 7
const SLOT_MAIN = 0;
const REVIEW_GATE = { seniorReview: 0, staffReview: 1 };

// ---------------------------------------------------------------------------------------------
// Creation and names
// ---------------------------------------------------------------------------------------------

/**
 * Default name from the seat and ordinal (D§3.3): h = FNV1a32(seat + "#" + ordinal);
 * first[h % 64] + " " + epithet[(h >>> 8) % 64].
 */
export function heroName(seat, ord) {
  const h = fnv1a32(`${seat}#${ord}`);
  const first = NAMES.first[h % NAMES.first.length];
  const epithet = NAMES.epithet[(h >>> 8) % NAMES.epithet.length];
  return `${first} ${epithet}`;
}

/**
 * A new Lv 1 Intern for a seat (ARCHITECTURE §3.2 Hero shape). Allocates state.herd.nextHeroId and
 * an item uid for the starter Training Stick (design gap: a Prototype at item level 1 that grows
 * with its Intern, see growStarter).
 * The hero's RNG is seeded from its seat/ordinal/id mixed with one draw of the herd RNG.
 */
export function newHero(state, { seat = "nospace/agent", sid = null, ord = 0, nowMs = 0 } = {}) {
  const herd = state.herd;
  if (!(herd.nextHeroId >= 1)) herd.nextHeroId = 1;
  const id = herd.nextHeroId++;
  const mix = Math.floor(rngNext(herd) * 4294967296);
  const hero = {
    id, seat, sid, ord, name: heroName(seat, ord),
    cls: 0, prov: 0, L: 1, xp: 0, sp: new Array(N_SKILLS).fill(0), spFree: 0, autoLearn: true,
    rev: [0, 0], eq: new Array(N_SLOTS).fill(null), pinMap: null, fe: 0,
    shift: { day: herd.day || 0, min: 0 }, cups: T.coffee.carry, hpFrac: 1,
    sig: { tm: [], tb: [], ts: [], blocks: 0, workMin: 0, subTasks: 0, n: 0 },
    pend: [], cd: { unblockedUntil: 0, unblockedCdUntil: 0, boss: {}, respecAt: null },
    addr: null, lastPane: null, lastTab: null, seenAt: nowMs,
    st: { kills: 0, tasks: 0, seals: 0, wh: 0, dodges: 0, healed: 0 },
    rng: seedOf((fnv1a32(`${seat}#${ord}#${id}`) ^ mix) >>> 0),
    bornDay: herd.day || 0, pref: null,
  };
  hero.eq[0] = newItem(state, { base: 0, ilvl: 1, rar: 0, flags: FLAG_STARTER });
  return hero;
}

/**
 * The starter Training Stick grows with its hero (design gap, found by tools/pacing-sim.mjs): while
 * the hero still holds it, its item level follows the reference kit, iRef(L) = max(1, L - 2)
 * (D§5.2). Without this an Intern's Power Level sinks to L - 5 by Lv 8 (weapons are 14% of early
 * drops), autopilot keeps it on map 1-1 and the first day runs far behind D§12.1 (three Lv 9
 * Interns at map 1-3 by minute 36). It keeps growing after Lv 10 until the first class weapon
 * replaces it (drops land at iRef since balance's T.loot.ilvlOffset, so a Junior with a frozen
 * iLvl-8 stick lagged its level by 3-5 and stayed in Lint Meadows past Lv 14). The item object is
 * replaced (same uid), never mutated, so stats caches see the change.
 */
function growStarter(hero) {
  const it = hero.eq && hero.eq[0];
  if (!it || !(it.flags & FLAG_STARTER) || it.base !== 0) return;
  const i = Math.max(1, hero.L - 2);
  if (i > it.ilvl) hero.eq[0] = Object.assign({}, it, { ilvl: i, aff: it.aff.slice() });
}

// ---------------------------------------------------------------------------------------------
// Careers (D§4.1)
// ---------------------------------------------------------------------------------------------

function clsDef(hero) {
  return CLASSES[hero.cls] || CLASSES[0];
}

/**
 * Career title tier: 0 Intern, 1 Junior (Lv 10, class), 2 Senior (Lv 30 + Senior Review),
 * 3 Staff (Lv 60 + Staff Review), 4 Principal (Lv 90, no fight).
 * @returns {{title:string, tier:number, tierTitle:string, clsName:string}} e.g. "Junior Refactorer"
 */
export function careerOf(hero) {
  const L = hero.L;
  const rev = hero.rev || [0, 0];
  let tier = 0;
  if (hero.cls > 0 && L >= CAREERS[1].from) tier = 1;
  if (tier >= 1 && L >= CAREERS[2].from && rev[0]) tier = 2;
  if (tier >= 1 && L >= CAREERS[3].from && rev[1]) tier = 3;
  if (tier >= 1 && L >= CAREERS[4].from) tier = 4;
  const c = clsDef(hero);
  const tierTitle = CAREERS[tier].title;
  return { title: tier === 0 ? tierTitle : `${tierTitle} ${c.name}`, tier, tierTitle, clsName: c.name };
}

// ---------------------------------------------------------------------------------------------
// Skills (D§7.1)
// ---------------------------------------------------------------------------------------------

/** The class's skill defs in slot order (Interns: Hello, World and printf() only). */
export function skillDefs(hero) {
  return SKILLS.byClass[clsDef(hero).id] || SKILLS.byClass.intern;
}

function defAt(hero, slotIdx) {
  for (const d of skillDefs(hero)) if (d.slotIdx === slotIdx) return d;
  return null;
}

function toSlotIdx(slot) {
  return typeof slot === "number" ? slot : SKILL_SLOTS.indexOf(slot);
}

/** Level and review gate of a skill slot (rank aside). */
export function slotUnlocked(hero, slot) {
  const d = defAt(hero, toSlotIdx(slot));
  if (!d) return false;
  if (hero.L < d.unlock) return false;
  if (d.needs != null && !(hero.rev || [])[REVIEW_GATE[d.needs]]) return false;
  return true;
}

/** Can one more rank be bought? Rank r requires L >= unlock + (r - 1). */
export function canLearn(hero, slot) {
  const si = toSlotIdx(slot);
  const d = defAt(hero, si);
  if (!d || !slotUnlocked(hero, si)) return false;
  const r = hero.sp[si] || 0;
  if (r >= d.max) return false;
  return hero.L >= d.unlock + r * T.skills.rankGate;
}

/** Spend 1 SP on a slot. */
export function learn(hero, slot) {
  const si = toSlotIdx(slot);
  if (!(hero.spFree > 0)) return { ok: false, error: "No skill points" };
  if (!canLearn(hero, si)) return { ok: false, error: "Not learnable yet" };
  hero.sp[si] = (hero.sp[si] || 0) + 1;
  hero.spFree--;
  return { ok: true, rank: hero.sp[si] };
}

/**
 * Auto-learn (D§7.1): each free point goes to the eligible skill with the lowest rank/max ratio;
 * ties: Ultimate, Signature, Main, Area, Capstone, Passive, Buff. Respects hero.autoLearn unless
 * opts.force. Returns the number of points spent.
 */
export function autoLearn(hero, opts = {}) {
  if (!opts.force && hero.autoLearn === false) return 0;
  const tie = SKILLS.autoLearnTieOrder;
  let spent = 0;
  while (hero.spFree > 0) {
    let best = null;
    let bestKey = null;
    for (const d of skillDefs(hero)) {
      if (!canLearn(hero, d.slotIdx)) continue;
      const ratio = (hero.sp[d.slotIdx] || 0) / d.max;
      const t = tie.indexOf(d.slot);
      if (best === null || ratio < bestKey[0] - 1e-12 || (Math.abs(ratio - bestKey[0]) <= 1e-12 && t < bestKey[1])) {
        best = d;
        bestKey = [ratio, t];
      }
    }
    if (!best) break;
    hero.sp[best.slotIdx]++;
    hero.spFree--;
    spent++;
  }
  return spent;
}

/** Skill points a hero has earned: one per level from Lv 2, plus one per review won (max 101). */
export function totalSP(hero) {
  const rev = hero.rev || [0, 0];
  return Math.max(0, hero.L - 1) + (rev[0] ? 1 : 0) + (rev[1] ? 1 : 0);
}

function refundAll(hero) {
  let n = 0;
  for (let i = 0; i < N_SKILLS; i++) {
    n += hero.sp[i] || 0;
    hero.sp[i] = 0;
  }
  hero.spFree = (hero.spFree || 0) + n;
  return n;
}

/**
 * Respec (D§7.1): free once per 24 h while Resting, otherwise 5 x L Snippets from the herd.
 * @param {object} hero @param {number} nowMs
 * @param {{resting?:boolean, herd?:object}} [opts] herd is needed for a paid respec
 * @returns {{ok:boolean, free?:boolean, cost?:number, error?:string}}
 */
export function respec(hero, nowMs, opts = {}) {
  const last = hero.cd && hero.cd.respecAt;
  const free = !!opts.resting && (last == null || nowMs - last >= 86400000);
  let cost = 0;
  if (!free) {
    cost = T.skills.respecSnippetsPerLevel * hero.L;
    const herd = opts.herd;
    if (!herd) return { ok: false, error: "Respec costs Snippets" };
    if ((herd.snip || 0) < cost) return { ok: false, error: `Needs ${cost} Snippets`, cost };
    herd.snip -= cost;
  } else {
    if (!hero.cd) hero.cd = {};
    hero.cd.respecAt = nowMs;
  }
  refundAll(hero);
  autoLearn(hero);
  return { ok: true, free, cost };
}

/** Records a won review (0 Senior, 1 Staff): +1 SP, unlocks the gated slot. Idempotent. */
export function winReview(hero, idx) {
  if (!hero.rev) hero.rev = [0, 0];
  if (hero.rev[idx]) return false;
  hero.rev[idx] = 1;
  hero.spFree = (hero.spFree || 0) + 1;
  return true;
}

/**
 * Ranks an auto-learning hero of class `cls` would have at level L (point by point, level by
 * level, reviews won at 30 / 60 when `reviews`). Used for Contractors and as a test oracle.
 */
export function autoRanks(cls, L, reviews = true) {
  const h = { cls: typeof cls === "number" ? cls : CLASS_IDX[cls], L: 1, rev: [0, 0], sp: new Array(N_SKILLS).fill(0), spFree: 0, autoLearn: true };
  for (let lv = 2; lv <= L; lv++) {
    h.L = lv;
    h.spFree++;
    if (reviews && lv === CAREERS[2].from) winReview(h, 0);
    if (reviews && lv === CAREERS[3].from) winReview(h, 1);
    autoLearn(h);
  }
  return h.sp;
}

// Resolves "A + B (rank - 1)" pairs, "floor(rank/k)" terms, per-rank tables and counts.
function evalRankTerm(expr, rank) {
  const m = /floor\(rank\/(\d+)\)/.exec(expr);
  return m ? Math.floor(rank / Number(m[1])) : 0;
}

function resolveEff(obj, rank) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v)) {
      if (k === "countedAtRanks") {
        out[k] = v.slice();
        out.countedBonus = v.filter((r) => rank >= r).length;
      } else if (k === "count") {
        out[k] = rank >= (obj.secondAtRank ?? Infinity) ? v[1] : v[0];
      } else if (v.length === 2 && typeof v[0] === "number" && typeof v[1] === "string") {
        out[k] = v[0] + evalRankTerm(v[1], rank);
      } else if (v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") {
        out[k] = v[0] + v[1] * (rank - 1);
      } else {
        out[k] = v.slice();
      }
    } else if (v && typeof v === "object") {
      if (k === "perRank" || k === "perRankPerSummon") {
        const o = {};
        for (const kk of Object.keys(v)) o[kk] = v[kk] * rank;
        out[k] = o;
      } else {
        out[k] = resolveEff(v, rank);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Resolved effects are pure functions of (skill, effective rank): cache them (read-only).
const effCache = new Map();
function resolvedEff(d, effRank) {
  const key = `${d.id}|${effRank}`;
  let eff = effCache.get(key);
  if (!eff) {
    eff = resolveEff(d.eff, Math.max(1, effRank));
    if (effRank === 0 && eff.perRank) for (const k of Object.keys(eff.perRank)) eff.perRank[k] = 0;
    effCache.set(key, eff);
  }
  return eff;
}

/** Cooldown in whole ticks after CDR (rounded up; D§7.1). */
function cdTicks(baseCd, cdr) {
  return baseCd > 0 ? Math.max(1, Math.ceil(baseCd * (1 - (cdr || 0)) - 1e-9)) : 0;
}

/**
 * Effective rank of a slot: learned rank (Main counts as at least rank 1 from Lv 1), 0 when the
 * slot is locked, plus Keepsake rank bonuses (Curly Brace Crown: +1 Main and Area, may exceed max).
 */
export function effectiveRank(hero, slot, st) {
  const si = toSlotIdx(slot);
  if (!slotUnlocked(hero, si)) return 0;
  const r = hero.sp[si] || 0;
  let base = si === SLOT_MAIN ? Math.max(1, r) : r;
  const bonus = st && st.rankBonus ? st.rankBonus[SKILL_SLOTS[si]] || 0 : 0;
  if (bonus > 0) base += bonus;
  return base;
}

/**
 * Rank-resolved numbers of one skill slot. `st` is the hero's stats (for CDR and rank bonuses);
 * when omitted, stats(hero, ctx of the hero's last stats() call) is used.
 * @returns {null|{def, slot, slotIdx, rank, effRank, max, unlocked, usable, type, cd, baseCd, ...eff}}
 *   every field of the skill's `eff` is resolved at effRank: coef/heal/pctOfMain/roomDmg/self.dmg
 *   are numbers, ticks/maxStacks include their floor(rank/k) term, count honours secondAtRank,
 *   perRank tables are multiplied by the rank. cd = ceil(baseCd x (1 - CDR)) ticks.
 */
export function skillValue(hero, slot, st) {
  const si = toSlotIdx(slot);
  const d = defAt(hero, si);
  if (!d) return null;
  const s = st || stats(hero, lastCtx(hero));
  const unlocked = slotUnlocked(hero, si);
  const effRank = effectiveRank(hero, si, s);
  // a fresh deep copy, so callers may keep or change it without touching the cache
  const eff = resolveEff(d.eff, Math.max(1, effRank));
  if (effRank === 0 && eff.perRank) for (const k of Object.keys(eff.perRank)) eff.perRank[k] = 0;
  const baseCd = d.cd || 0;
  const cd = cdTicks(baseCd, s.cdr);
  return Object.assign(eff, {
    def: d, id: d.id, name: d.name, slot: d.slot, slotIdx: si, rank: hero.sp[si] || 0, effRank,
    max: d.max, unlocked, usable: effRank > 0, cd, baseCd, anyTime: !!d.anyTime,
  });
}

// ---------------------------------------------------------------------------------------------
// Derived stats (D§5.3) with caching
// ---------------------------------------------------------------------------------------------

const AFFIX_STATS = ["dmg", "crit", "critDmg", "extraAct", "armorPct", "hpPct", "repeatHit", "areaDmg",
  "bossDmg", "xp", "gold", "itemFind", "regenPct", "dmgTaken", "cdr", "dmgBelowHalfHp", "dodge"];

// Three caches, each validated by comparing everything its result depends on (numbers and object
// identities, no string keys, so a cache hit is cheap):
//   statsCache: hero -> final stats;  baseCache: hero -> gear-independent part;  itemCache: item -> itemStats
// Items are compared by identity plus polish and their `aff` array identity: code that changes
// affixes must replace item.aff (items.reroll does), never edit it in place.
const statsCache = new WeakMap();
const baseCache = new WeakMap();
const itemCache = new WeakMap();
const CM = BUILDING_IDX.coffee_machine;

function sameList(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Inputs of the gear-independent part: level, class, reviews, ranks, herd bonuses, ctx bonuses.
function baseSig(hero, ctx) {
  const rev = hero.rev || [];
  const sig = [hero.L, hero.cls, rev[0] || 0, rev[1] || 0];
  for (let i = 0; i < N_SKILLS; i++) sig.push(hero.sp[i] || 0);
  const herd = ctx.herd;
  if (herd) {
    let trophies = 0;
    for (const x of herd.boss || []) if (x) trophies++;
    let bt = 0;
    for (const k of herd.bt || []) bt = bt * 4 + trackerTier(k || 0);
    sig.push(1, trophies, bt, herd.rel || 0, (herd.bld || [])[CM] || 0);
  } else {
    sig.push(0, 0, 0, 0, 0);
  }
  const rb = ctx.roomBonuses;
  if (rb) sig.push(1, rb.dmg || 0, rb.dr || 0, rb.xp || 0, rb.dmgTaken || 0);
  else sig.push(0, 0, 0, 0, 0);
  sig.push(ctx.roomAllies || 0, ctx.freshEyes ? 1 : 0, ctx.workingForklings || 0);
  return sig;
}

function eqSig(eq) {
  const sig = [];
  for (let s = 0; s < N_SLOTS; s++) {
    const it = eq && eq[s];
    sig.push(it || 0, it ? it.pol : 0, it ? it.aff : 0);
  }
  return sig;
}

// Item numbers, cached by item identity and content.
function cachedItemStats(it) {
  const hit = itemCache.get(it);
  if (hit && hit.pol === it.pol && hit.aff === it.aff && hit.base === it.base && hit.ilvl === it.ilvl &&
      hit.rar === it.rar && hit.prop === it.prop) return hit.is;
  const is = itemStats(it);
  itemCache.set(it, { pol: it.pol, aff: it.aff, base: it.base, ilvl: it.ilvl, rar: it.rar, prop: it.prop, is });
  return is;
}

/**
 * Derived stats of a hero (D§5.3, buff-free). Cached per hero; recomputed when the level, class,
 * reviews, skill ranks, equipment (items, polish, affixes), herd bonuses (trophies, Bug Tracker
 * tiers, release, Coffee Machine) or ctx bonuses change. Treat the result as read-only.
 *
 * @param {object} hero
 * @param {{herd?:object, roomBonuses?:{dmg?,dr?,xp?,dmgTaken?}, roomAllies?:number,
 *          freshEyes?:boolean, workingForklings?:number}} [ctx]
 *   roomBonuses: room auras from allies (Rubber Duck Debugging, Psychological Safety ...). When it
 *   is omitted, the hero's own auras are applied to itself ("self included"); when given, it must
 *   already contain them. roomAllies: other heroes in the room (Microservice Badge).
 */
export function stats(hero, ctx) {
  const c = ctx || {};
  const b = baseSig(hero, c);
  const e = eqSig(hero.eq);
  const hit = statsCache.get(hero);
  if (hit && sameList(hit.b, b) && sameList(hit.e, e)) return hit.st;
  const st = combine(hero, heroBase(hero, c, b), hero.eq || [], c);
  statsCache.set(hero, { b, e, st, ctx: c });
  return st;
}

// The ctx of the hero's last stats() call, so helpers called without stats (skillValue) price
// the hero with the same herd/room inputs instead of a bare {} (which would also evict the cache).
function lastCtx(hero) {
  const hit = statsCache.get(hero);
  return hit ? hit.ctx : {};
}

/** Drops a hero's cached stats (only needed after editing an item's affixes in place). */
export function invalidateStats(hero) {
  statsCache.delete(hero);
  baseCache.delete(hero);
}

/**
 * Uncached final stats. `eq` (default hero.eq) lets items.scoreDelta price hypothetical
 * equipment; the gear-independent part still comes from the hero's cache.
 */
export function computeStats(hero, ctx, eq = hero.eq) {
  const c = ctx || {};
  return combine(hero, heroBase(hero, c), eq || [], c);
}

function heroBase(hero, ctx, sig = baseSig(hero, ctx)) {
  const hit = baseCache.get(hero);
  if (hit && sameList(hit.sig, sig)) return hit.base;
  const base = computeBase(hero, ctx);
  baseCache.set(hero, { sig, base });
  return base;
}

// Everything that does not depend on equipment: primary stats, class innate, passive/aura skills,
// herd trophies and Bug Tracker perks, Release Train gold, Coffee Machine, room auras.
function computeBase(hero, ctx) {
  const L = hero.L;
  const c = clsDef(hero);
  const gr = c.growth;
  const inn = c.innate || {};
  const b = {
    c, inn,
    might: 4 + gr.might * (L - 1), grit: 4 + gr.grit * (L - 1), keen: 4 + gr.keen * (L - 1), luck: 4 + gr.luck * (L - 1),
    dmg: 0, hpPct: inn.hpPct || 0, drFlat: 0, crit: inn.crit || 0, critDmg: 0, dodge: 0, cdr: 0, itemFind: 0,
    goldPct: 0, xpPct: 0, bossDmg: 0, areaTargets: inn.areaTargets || 0,
    forklingPct: inn.forklingPct || T.forkling.pctOfMain, forklingCount: T.forkling.counted,
    ignoreBossDr: 0, freeMainChance: 0, critBase: inn.critMult || T.critMult, coffeeHeal: T.coffee.heal,
  };

  // passive / aura / capstone skills (per-rank tables from data)
  const auraSelf = !ctx.roomBonuses;
  let supervisorPerSummon = 0;
  let daemon = false;
  for (const d of skillDefs(hero)) {
    const r = hero.sp[d.slotIdx] || 0;
    if (r <= 0 || !slotUnlocked(hero, d.slotIdx)) continue;
    const e = d.eff;
    if (e.type === "summon" && d.slot === "buff") daemon = true;
    if (e.type !== "passive" && e.type !== "aura") continue;
    const pr = e.perRank || {};
    for (const k of Object.keys(pr)) {
      const v = pr[k] * r;
      if (k === "hpPct") b.hpPct += v;
      else if (k === "dr") b.drFlat += v;
      else if (k === "dmg") b.dmg += v;
      else if (k === "dodge") b.dodge += v;
      else if (k === "critDmg") b.critDmg += v;
      else if (k === "forklingPct") b.forklingPct += v;
      else if (k === "ignoreBossDr") b.ignoreBossDr += v;
      else if (k === "freeMainChance") b.freeMainChance += v;
      else if (auraSelf && k === "roomDmg") b.dmg += v;
      else if (auraSelf && k === "roomXp") b.xpPct += v;
      else if (auraSelf && k === "roomDr") b.drFlat += v;
    }
    if (e.countedAtRanks) b.forklingCount += e.countedAtRanks.filter((x) => r >= x).length;
    if (e.perRankPerSummon) supervisorPerSummon = (e.perRankPerSummon.dmg || 0) * r;
  }
  if (supervisorPerSummon > 0) {
    const summons = Math.min(7, (daemon ? 1 : 0) + Math.min(b.forklingCount, ctx.workingForklings || 0));
    b.dmg += supervisorPerSummon * summons;
  }

  // herd: trophies, Bug Tracker perks, Release Train, Coffee Machine (D§10)
  const herd = ctx.herd;
  if (herd) {
    let trophies = 0;
    for (const x of herd.boss || []) if (x) trophies++;
    b.dmg += TROPHY.dmg * trophies;
    b.hpPct += TROPHY.hpPct * trophies;
    const bt = herd.bt || [];
    for (let z = 0; z < ZONES.length; z++) {
      const tier = trackerTier(bt[z] || 0);
      if (!tier) continue;
      const p = ZONES[z].perk;
      if (p.gold) b.goldPct += p.gold * tier;
      if (p.crit) b.crit += p.crit * tier;
      if (p.hpPct) b.hpPct += p.hpPct * tier;
      if (p.itemFind) b.itemFind += p.itemFind * tier;
      if (p.dmg) b.dmg += p.dmg * tier;
      if (p.cdr) b.cdr += p.cdr * tier;
      if (p.dr) b.drFlat += p.dr * tier;
      if (p.bossDmg) b.bossDmg += p.bossDmg * tier;
      // p.xp is herd XP (herd.js herdXpBonus), not a hero stat
    }
    b.goldPct += T.release.bonusPer * Math.min(T.release.maxRelease, herd.rel || 0);
    const cm = BUILDING_IDX.coffee_machine;
    b.coffeeHeal += BUILDINGS[cm].perLevel.coffeeHeal * ((herd.bld || [])[cm] || 0);
  }

  // room auras supplied by combat
  const rb = ctx.roomBonuses;
  if (rb) {
    b.dmg += rb.dmg || 0;
    b.drFlat += rb.dr || 0;
    b.xpPct += rb.xp || 0;
  }
  return b;
}

// Adds the equipment to the base and applies the D§5.3 caps.
function combine(hero, b, eq, ctx) {
  const L = hero.L;
  const a = {};
  for (const s of AFFIX_STATS) a[s] = 0;
  let weapon = 0;
  let hasWeapon = false;
  let offClass = false; // the weapon is another class's type (swung as a Training Stick)
  let armorSum = 0;
  let coffeeHeal = b.coffeeHeal;
  const lts = {};
  const keepsakes = {};
  const props = [];
  for (let s = 0; s < N_SLOTS; s++) {
    const it = eq[s];
    if (!it) continue;
    // A weapon of another class's type (left in hand by a provisional class switch or a Career
    // Change, D§4.2) is swung like a Training Stick of its item level until autopilot or the person
    // replaces it: no rarity, polish, affixes or property (weapons are class-typed, D§8.1). Bare
    // hands (3 g(L)) would halve a hero's damage for a free switch (docs/BALANCE.md §4).
    if (s === 0 && !canEquip(hero, it, { ignoreLevel: true })) {
      weapon = weaponDmg(it.ilvl || 1, RARITIES[0].mult, 0);
      hasWeapon = true;
      offClass = true;
      continue;
    }
    const is = cachedItemStats(it);
    if (is.slot === "weapon") {
      weapon = is.weaponDmg;
      hasWeapon = true;
    }
    armorSum += is.armor;
    coffeeHeal += is.coffeeHeal;
    for (const k of Object.keys(is.stats)) a[k] += is.stats[k];
    if (is.prop) {
      props.push(is.prop);
      if (is.prop.kind === "lts") lts[is.prop.id] = is.prop.effect;
      else keepsakes[is.prop.id] = is.prop.effect;
    }
  }

  let dmg = b.dmg + a.dmg;
  let hpPct = b.hpPct + a.hpPct;
  let crit = b.crit + a.crit;
  let cdr = b.cdr + a.cdr;
  let itemFind = b.itemFind + a.itemFind;
  let xpPct = b.xpPct + a.xp;
  let bossDmg = b.bossDmg + a.bossDmg;
  let areaTargets = b.areaTargets;
  const rankBonus = {};

  // Keepsakes and LTS properties with static effects (D§8.4, D§8.5)
  for (const id of Object.keys(keepsakes)) {
    const e = keepsakes[id];
    if (e.crit) crit += e.crit;
    if (e.xp) xpPct += e.xp;
    if (e.cdr) cdr += e.cdr;
    if (e.hpPct) hpPct += e.hpPct;
    if (e.coffeeHeal) coffeeHeal += e.coffeeHeal;
    if (e.bossDmg) bossDmg += e.bossDmg;
    if (e.areaTargets) areaTargets += e.areaTargets;
    if (e.rankBonus) for (const k of Object.keys(e.rankBonus)) rankBonus[k] = (rankBonus[k] || 0) + e.rankBonus[k];
    if (e.dmgPerRoomAlly) dmg += Math.min(e.cap, e.dmgPerRoomAlly * (ctx.roomAllies || 0));
    if (e.dmgWhileFreshEyes && ctx.freshEyes) dmg += e.dmgWhileFreshEyes;
  }
  if (lts.pockets) itemFind += lts.pockets.itemFind;

  const might = b.might;
  const drFlat = b.drFlat;
  const armor = armorSum * (1 + a.armorPct);
  const st = {
    L, cls: hero.cls, clsId: b.c.id,
    might, grit: b.grit, keen: b.keen, luck: b.luck,
    weaponDmg: hasWeapon ? weapon : bareHandDmg(L), hasWeapon, offClassWeapon: offClass,
    maxHp: Math.round(T.hpBase * g(L) * (1 + b.grit / 100) * (1 + hpPct)), hpPct,
    armor, armorPct: a.armorPct, drFlat,
    crit: Math.min(T.critCap, T.critBase + 0.0015 * b.keen + crit),
    critMult: b.critBase + b.critDmg + a.critDmg,
    dodge: Math.min(T.dodgeCap, b.dodge + a.dodge),
    cdr: Math.min(T.cdrCap, cdr),
    extraAct: Math.min(T.extraActCap, a.extraAct),
    itemFind: Math.min(T.itemFindCap, 0.004 * b.luck + itemFind),
    goldPct: 0.005 * b.luck + b.goldPct + a.gold,
    xpPct, dmgPct: dmg, bossDmg, areaDmg: a.areaDmg, repeatHit: a.repeatHit, regenPct: a.regenPct,
    dmgTaken: a.dmgTaken, dmgBelowHalfHp: a.dmgBelowHalfHp, coffeeHeal,
    areaTargets, rankBonus, forklingPct: b.forklingPct, forklingCount: b.forklingCount,
    ignoreBossDr: b.ignoreBossDr, freeMainChance: b.freeMainChance,
    bossFront: !!b.inn.bossFront, roomUnblockedMult: b.inn.roomUnblockedMult || 1,
    lts, keepsakes, props,
    /** DR against an attacker of level m. */
    dr(m) { return DR(armor, m, drFlat); },
  };
  st.mainCoef = mainCoefOf(hero, st);
  st.mainHit = st.weaponDmg * (1 + might / 100) * st.mainCoef * (1 + dmg);
  st.dpsEst = dpsEstimate(hero, st);
  st.ehp = st.maxHp / (1 - st.dr(L)) / (1 - st.dodge);
  st.pl = powerLevel(L, st.dpsEst);
  return st;
}

function mainCoefOf(hero, st) {
  const d = defAt(hero, SLOT_MAIN);
  if (!d) return 1;
  const e = resolvedEff(d, effectiveRank(hero, SLOT_MAIN, st));
  return (e.coef || 1) * (e.hits || 1) + (e.bonusHit || 0);
}

// ---------------------------------------------------------------------------------------------
// DPS_est (D§5.7): a deterministic 60-tick expected-value dry run of the rotation (D§7.1) against
// a single boss-like dummy (so Ultimates fire; area skills need 2+ targets and only the
// "any time" ones fire). Forklings are not counted. The run is reduced to coefficient sums per
// (area?, always-crit?) bucket, cached by everything that changes the schedule, so pricing a
// hypothetical item only re-applies the multipliers.
// ---------------------------------------------------------------------------------------------

const DRY_TICKS = 60;
const dryCache = new Map();

function dryRun(hero, st) {
  const tenx = st.lts.tenx ? st.lts.tenx.everyNthAction : 0;
  const tenxMult = st.lts.tenx ? st.lts.tenx.dmgMult : 1;
  // "Hot-Reloading" (a 15% chance a skill does not go on cooldown) is approximated by 15% shorter
  // cooldowns, since the dry run works with expected values.
  const reload = st.lts.reload ? st.lts.reload.noCooldownChance : 0;
  const ranks = [];
  const cds = [];
  let key = `${clsDef(hero).id}|${tenx}|${reload}`;
  for (let i = 0; i < N_SKILLS; i++) {
    const d = defAt(hero, i);
    ranks.push(d ? effectiveRank(hero, i, st) : 0);
    cds.push(d ? cdTicks(d.cd || 0, st.cdr) : 0);
    key += ranks[i] > 0 ? `|${ranks[i]}.${cds[i]}` : "|-";
  }
  const hit = dryCache.get(key);
  if (hit) return hit;
  // per-slot resolved effects (shared, read-only) plus the schedule numbers
  const sv = [];
  for (let i = 0; i < N_SKILLS; i++) {
    const d = defAt(hero, i);
    sv.push(d ? Object.assign({}, resolvedEff(d, ranks[i]), { usable: ranks[i] > 0, cd: cds[i], anyTime: !!d.anyTime }) : null);
  }

  // buckets: [normal, alwaysCrit, areaNormal, areaCrit] x [sum coef, sum coef * extraDmg]
  const B = [[0, 0], [0, 0], [0, 0], [0, 0]];
  const E = [[0, 0], [0, 0]]; // Main repeated by the Async extra action: [normal, crit]
  const use = (s) => s && s.usable;
  const cdOf = (s) => (reload && s.cd > 0 ? Math.max(1, Math.round(s.cd * (1 - reload))) : s.cd);
  const main = sv[0];
  const mainCoef = main ? (main.coef || 1) : 1;
  let buffUntil = -1;
  let buffDmg = 0;
  let buffCrit = false;
  let retroUntil = -1;
  let retroDmg = 0;
  let actions = 0;
  const ready = { area: 0, buff: 0, ult: 0 };
  const add = (coef, area, crit, extra) => {
    const b = B[(area ? 2 : 0) + (crit ? 1 : 0)];
    b[0] += coef;
    b[1] += coef * extra;
  };
  const multiTarget = (t) => t === "lane" || t === "randomLane" || (typeof t === "number" && t > 1);

  for (let t = 0; t < DRY_TICKS; t++) {
    // free actions: buff / summon casts when ready
    const buff = sv[3];
    if (use(buff) && buff.type === "buff" && t >= ready.buff) {
      buffUntil = t + (buff.ticks || 0) - 1;
      buffDmg = (buff.self && buff.self.dmg) || 0;
      buffCrit = !!(buff.self && buff.self.alwaysCrit);
      ready.buff = t + cdOf(buff);
    }
    const sig = sv[4];
    const extra = (t <= buffUntil ? buffDmg : 0) + (t <= retroUntil ? retroDmg : 0);
    // Bisect stacks add to Main hits only (combat.js F_MAIN), as in combat4.py
    const mainExtra = extra + (use(sig) && sig.type === "stacks" ? (sig.perStack.dmg || 0) * Math.min(t, sig.maxStacks || 0) : 0);
    const crit = t <= buffUntil && buffCrit;
    actions++;
    const mult = tenx && actions % tenx === 0 ? tenxMult : 1;

    const ult = sv[5];
    if (use(ult) && t >= ready.ult) {
      ready.ult = t + cdOf(ult);
      if (ult.type === "hit") {
        add((ult.coef || 0) * (ult.hits || 1) * mult, multiTarget(ult.targets), crit || !!ult.alwaysCrit, extra);
      } else if (ult.type === "roomRestore") {
        retroUntil = t + (ult.buffTicks || 0) - 1;
        retroDmg = ult.roomDmg || 0;
      }
    } else if (use(sig) && sig.type === "proc" && actions % sig.everyActions === 0) {
      add((sig.coef || 0) * mult, multiTarget(sig.targets), crit, extra);
    } else if (use(sv[1]) && sv[1].anyTime && sv[1].type === "hit" && t >= ready.area) {
      ready.area = t + cdOf(sv[1]);
      add((sv[1].coef || 0) * (sv[1].hits || 1) * mult, false, crit, extra);
    } else {
      add((mainCoef * ((main && main.hits) || 1) + ((main && main.bonusHit) || 0)) * mult, false, crit, mainExtra);
    }
    // the Async extra action repeats Main at the end of the tick (scaled by extraAct later)
    const eb = E[crit ? 1 : 0];
    eb[0] += mainCoef * ((main && main.hits) || 1);
    eb[1] += mainCoef * ((main && main.hits) || 1) * mainExtra;
    // passive procs and summons
    if (use(sv[2]) && sv[2].perRank && sv[2].perRank.freeMainChance) add(mainCoef * sv[2].perRank.freeMainChance, false, crit, mainExtra);
    if (use(buff) && buff.type === "summon") add(mainCoef * (buff.pctOfMain || 0), false, crit, extra);
    if (use(sig) && sig.type === "summon") add(mainCoef * (sig.pctOfMain || 0) * (sig.count || 1), false, crit, extra);
  }
  const res = { B, E };
  if (dryCache.size > 2000) dryCache.clear();
  dryCache.set(key, res);
  return res;
}

function dpsEstimate(hero, st) {
  const { B, E } = dryRun(hero, st);
  const semi = st.lts.semi ? 1 + st.lts.semi.critRepeatChance : 1;
  const critN = 1 + st.crit * (st.critMult * semi - 1);
  const critA = st.critMult * semi;
  let D = st.dmgPct;
  if (st.lts.flag) D += st.lts.flag.dmg / 2; // alternates damage / armor every 60 ticks
  const sum = (b, area) => b[0] * (1 + D + (area ? st.areaDmg : 0)) + b[1];
  let total = sum(B[0], false) * critN + sum(B[1], false) * critA + sum(B[2], true) * critN + sum(B[3], true) * critA;
  total += st.extraAct * (sum(E[0], false) * critN + sum(E[1], false) * critA);
  let global = st.weaponDmg * (1 + st.might / 100) * (1 + 0.5 * st.repeatHit);
  const lens = st.keepsakes.uncertainty_lens;
  if (lens) global *= 1 + lens.doubleCountChance;
  return (global * total) / DRY_TICKS;
}

// ---------------------------------------------------------------------------------------------
// XP and level-ups (D§6.4)
// ---------------------------------------------------------------------------------------------

function emitNote(ev, text, color) {
  if (ev && typeof ev.note === "function") ev.note(text, color);
}

function emitJournal(ev, kind, heroId, text, value) {
  if (ev && typeof ev.journal === "function") ev.journal(kind, heroId, text, value);
}

/**
 * Adds XP (already multiplied by every bonus) and applies level-ups: full heal (hero.hpFrac = 1;
 * callers reset live HP when result.levels > 0), +1 SP per level from Lv 2, class assignment at
 * Lv 10 (D§4.2, Intern SP refunded), "maintenance mode" at Lv 100 (every 1% of Need(99) -> 1
 * Snippet for the herd). Emits ev.fx("levelup", {heroId, value: L}), ev.note on promotions,
 * ev.major(), and ev.journal?.(kind, heroId, text, value) when the emitter provides it.
 * @returns {{levels:number, heal:boolean, snippets:number, promoted:null|string}}
 */
export function grantXP(state, hero, amount, ev) {
  const res = { levels: 0, heal: false, snippets: 0, promoted: null };
  if (!(amount > 0)) return res;
  const cap = T.levelCap;
  hero.xp = (hero.xp || 0) + amount;
  while (hero.L < cap && hero.xp >= need(hero.L)) {
    hero.xp -= need(hero.L);
    const before = careerOf(hero).tier;
    hero.L++;
    hero.spFree = (hero.spFree || 0) + 1;
    res.levels++;
    growStarter(hero);
    if (hero.L === CAREERS[1].from && hero.cls === 0) assignClass(hero);
    if (ev && typeof ev.fx === "function") ev.fx("levelup", { heroId: hero.id, value: hero.L, text: "LEVEL UP" });
    const after = careerOf(hero);
    if (after.tier > before) {
      res.promoted = after.title;
      emitNote(ev, `Promoted: ${after.title}`);
      emitJournal(ev, "promo", hero.id, after.title, hero.L);
    }
  }
  if (hero.L >= cap) {
    const per = 0.01 * need(cap - 1);
    const n = Math.floor(hero.xp / per + 1e-9); // tolerate float dust from the subtraction above
    if (n > 0) {
      hero.xp = Math.max(0, hero.xp - n * per);
      if (state && state.herd) state.herd.snip = (state.herd.snip || 0) + n;
      res.snippets = n;
    }
  }
  if (res.levels > 0) {
    hero.hpFrac = 1;
    res.heal = true;
    emitJournal(ev, "level", hero.id, `Lv ${hero.L}`, hero.L);
    if (ev && typeof ev.major === "function") ev.major();
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Class from behaviour (D§4.2)
// ---------------------------------------------------------------------------------------------

function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function sum(list) {
  let n = 0;
  for (const x of list || []) n += x || 0;
  return n;
}

/**
 * The hero's live signature over its last 20 qualifying tasks and the class it recommends
 * (first matching rule: >= 25% tasks with a sub-agent -> Forkbinder; >= 2 blocks per working
 * hour -> Rubberducker; median >= 15 min -> Refactorer; median <= 5 min -> Hotfixer; else
 * Shellmancer). With no tasks on record the recommendation is Shellmancer.
 * @returns {{recommended:string, recommendedIdx:number, median:number, bph:number, sub:number,
 *            n:number, window:number}}
 */
export function classSignature(hero) {
  const sig = hero.sig || {};
  const tm = sig.tm || [];
  const w = tm.length;
  const workMin = w ? sum(tm) : sig.workMin || 0;
  const blocks = sig.tb && sig.tb.length ? sum(sig.tb) : sig.blocks || 0;
  const subs = sig.ts && sig.ts.length ? sum(sig.ts) : sig.subTasks || 0;
  const med = median(tm);
  const bph = workMin > 0 ? blocks / (workMin / 60) : 0;
  const sub = w ? subs / w : 0;
  const v = { medianTaskMin: med, blocksPerWorkingHour: bph, subAgentShare: sub };
  let rec = CLASS_IDX.shellmancer;
  if (w > 0) {
    const ordered = CLASSES.filter((c) => c.signature).sort((x, y) => x.signature.priority - y.signature.priority);
    for (const c of ordered) {
      const s = c.signature;
      if (s.rule === "default") { rec = c.n; break; }
      const x = v[s.rule];
      if ((s.op === ">=" && x >= s.value) || (s.op === "<=" && x <= s.value)) { rec = c.n; break; }
    }
  }
  return { recommended: CLASSES[rec].id, recommendedIdx: rec, median: med, bph, sub, n: sig.n || 0, window: w };
}

function assignClass(hero) {
  const sig = classSignature(hero);
  const pref = hero.pref;
  const cls = pref != null && pref > 0 && CLASSES[pref] ? pref : sig.recommendedIdx;
  hero.cls = cls;
  hero.prov = pref != null || sig.n >= T.skills.classLockTasks ? 0 : 1;
  hero.pref = null;
  refundAll(hero); // Intern skill points are refunded at Lv 10
}

/**
 * Records a closed task on the signature window (D§4.2). Only tasks of 1.5 min or more qualify.
 * While the class is provisional (Lv 10+, fewer than 15 qualifying tasks), the class is
 * re-evaluated and switches for free (skill points refunded; auto-learn re-spends them); the
 * 15th qualifying task locks it.
 * @param {{minutes:number, blocks?:number, spawned?:boolean}} task
 * @returns {{qualifying:boolean, switched:boolean, locked:boolean, cls:number}}
 */
export function recordTask(hero, task) {
  const out = { qualifying: false, switched: false, locked: false, cls: hero.cls };
  const min = task.minutes || 0;
  if (!(min >= T.seals.minMinutes)) return out;
  out.qualifying = true;
  const sig = hero.sig || (hero.sig = { tm: [], tb: [], ts: [], blocks: 0, workMin: 0, subTasks: 0, n: 0 });
  if (!sig.tm) sig.tm = [];
  if (!sig.tb) sig.tb = [];
  if (!sig.ts) sig.ts = [];
  sig.tm.push(Math.round(min * 2) / 2); // half-minute precision is plenty for medians (and keeps saves small)
  sig.tb.push(task.blocks || 0);
  sig.ts.push(task.spawned ? 1 : 0);
  while (sig.tm.length > 20) { sig.tm.shift(); sig.tb.shift(); sig.ts.shift(); }
  sig.workMin = sum(sig.tm);
  sig.blocks = sum(sig.tb);
  sig.subTasks = sum(sig.ts);
  sig.n = (sig.n || 0) + 1;
  if (hero.L >= CAREERS[1].from && hero.cls > 0 && hero.prov) {
    const rec = classSignature(hero).recommendedIdx;
    if (rec !== hero.cls) {
      hero.cls = rec;
      refundAll(hero);
      autoLearn(hero);
      out.switched = true;
    }
    if (sig.n >= T.skills.classLockTasks) {
      hero.prov = 0;
      out.locked = true;
    }
  }
  out.cls = hero.cls;
  return out;
}

/**
 * Person override / Career Change (D§4.2): any class, free, before Lv 20 (locks it; before Lv 10
 * it is remembered and applied, locked, at Lv 10). From Lv 20 a change costs 25 x L Snippets and
 * refunds all skill points. Choosing the current class just locks it.
 * @returns {{ok:boolean, cost?:number, error?:string, msg?:string}}
 */
export function setClass(state, hero, cls) {
  const idx = typeof cls === "number" ? cls : CLASS_IDX[cls];
  if (!(idx >= 1 && idx < CLASSES.length)) return { ok: false, error: "Unknown class" };
  if (hero.L < CAREERS[1].from) {
    hero.pref = idx;
    return { ok: true, cost: 0, msg: `${CLASSES[idx].name} at Lv 10` };
  }
  if (idx === hero.cls) {
    hero.prov = 0;
    return { ok: true, cost: 0, msg: "Class locked" };
  }
  let cost = 0;
  if (hero.L >= T.skills.classFreeUntilLevel) {
    cost = T.skills.careerChangeSnippetsPerLevel * hero.L;
    const herd = state && state.herd;
    if (!herd || (herd.snip || 0) < cost) return { ok: false, cost, error: `Needs ${cost} Snippets` };
    herd.snip -= cost;
  }
  hero.cls = idx;
  hero.prov = 0;
  refundAll(hero);
  autoLearn(hero);
  return { ok: true, cost };
}

/** The weapon type ("blade", "knives", ..., "stick" for Interns) the hero's class wields. */
export function weaponTypeOf(hero) {
  return clsDef(hero).weapon;
}
