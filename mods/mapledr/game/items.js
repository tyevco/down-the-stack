// Gear (D§8): item generation for every drop source, naming, Item Power, item stats, the
// autopilot equip score, the shared stash ("vendor/") with auto-deprecate, deprecate, polish
// (+ port polish), Squash Merge and Reroll.
//
// Item = { uid, base, ilvl, rar, pol, aff: [[affixIdx, roll 0..99], ...], flags, prop }
//   rar 0..5 (4 LTS: prop = LTS property idx; 5 Keepsake: prop = keepsake idx; else prop = -1)
//   flags: 1 locked, 2 new. uid comes from state.herd.nextUid.
//   base, ilvl, rar and prop never change after creation; pol changes by polish; `aff` is
//   replaced as a whole on reroll (never edited in place: heroes.stats caches compare identity).
//
// Pure: RNG through rng.js holders only.

import {
  TUNING as T, CLASSES, RARITIES, AFFIXES, LTS_PROPS, KEEPSAKES, ITEM_BASES, BASE_LIST, SLOTS, DROP_WEIGHTS,
  WEAPON_TYPES, STASH, BUILDING_IDX, BUILDINGS, RARITY_IDX, CLASS_IDX, REVIEWS, ELITE,
} from "./data.js";
import {
  itemTier, reqLevel, weaponDmg, armorPiece, itemPower, polishCost as polishCostOf, polishMax, deprecateYield,
  gold, chestTierOf,
} from "./formulas.js";
import { rngNext, rngInt, rngPick, rngElem } from "./rng.js";
import { stats, computeStats } from "./heroes.js";

export const FLAG_LOCKED = 1;
export const FLAG_NEW = 2;
const R_LTS = 4;
const R_KEEPSAKE = 5;
const EQUIP_THRESHOLD = 0.02; // D§8.7: equip if score >= +2%
const FORGE = BUILDING_IDX.ci_forge;
const FORGE_SQUASH = Number(Object.keys(BUILDINGS[FORGE].unlocks).find((k) => BUILDINGS[FORGE].unlocks[k] === "squashMerge"));
const FORGE_REROLL = Number(Object.keys(BUILDINGS[FORGE].unlocks).find((k) => BUILDINGS[FORGE].unlocks[k] === "reroll"));

// ---------------------------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------------------------

/** Base def of an item (unknown ids fall back to the Training Stick). */
export function baseOf(item) {
  return BASE_LIST[item.base] || BASE_LIST[0];
}

/** Slot name of an item ("weapon" ... "sticker"). */
export function slotOf(item) {
  return baseOf(item).slot;
}

/** Slot index (hero.eq position) of an item. */
export function slotIdxOf(item) {
  return SLOTS.indexOf(slotOf(item));
}

/** Base id for a slot, tier and (weapons) weapon type. */
export function baseIdFor(slot, tier, type) {
  const t = Math.min(5, Math.max(1, tier));
  if (slot === "weapon") {
    const k = WEAPON_TYPES.indexOf(type);
    if (k < 0) return 0; // the Training Stick (any tier)
    return 1 + k * 5 + (t - 1);
  }
  const s = SLOTS.indexOf(slot);
  return 1 + WEAPON_TYPES.length * 5 + (s - 1) * 5 + (t - 1);
}

/** Allocates the next item uid from state.herd.nextUid (or a herd-like holder). */
export function allocUid(stateOrHerd) {
  const herd = stateOrHerd && stateOrHerd.herd ? stateOrHerd.herd : stateOrHerd;
  if (!herd) return 0;
  if (!(herd.nextUid >= 1)) herd.nextUid = 1;
  return herd.nextUid++;
}

/** Builds an item with a fresh uid. Fields default to a Prototype with no affixes. */
export function newItem(state, f) {
  return {
    uid: allocUid(state),
    base: f.base ?? 0, ilvl: f.ilvl ?? 1, rar: f.rar ?? 0, pol: f.pol ?? 0,
    aff: f.aff ? f.aff.map((a) => [a[0], a[1]]) : [], flags: f.flags ?? 0, prop: f.prop ?? -1,
  };
}

/** Deep copy of an item (same uid). */
export function cloneItem(item) {
  return { ...item, aff: item.aff.map((a) => [a[0], a[1]]) };
}

/** Required hero level (max(1, i - 3)). */
export function itemReqLevel(item) {
  return reqLevel(item.ilvl);
}

/** Item Power (D§8.7). */
export function itemIP(item) {
  return itemPower(item.ilvl, (RARITIES[item.rar] || RARITIES[0]).mult, item.pol, item.aff.length);
}

/**
 * Can this hero wear the item? Level >= max(1, i - 3); weapons must match the class's weapon
 * type, except the Training Stick (any class) and class-adaptive Keepsakes (Mutex Twinfang).
 */
export function canEquip(hero, item, opts = {}) {
  if (!opts.ignoreLevel && hero.L < itemReqLevel(item)) return false;
  const b = baseOf(item);
  if (b.slot !== "weapon" || b.anyClass) return true;
  if (item.rar === R_KEEPSAKE && KEEPSAKES[item.prop] && KEEPSAKES[item.prop].classAdaptive) return true;
  return b.type === (CLASSES[hero.cls] || CLASSES[0]).weapon;
}

// ---------------------------------------------------------------------------------------------
// Stats and names
// ---------------------------------------------------------------------------------------------

/**
 * Affix value (D§8.3): (lo + (hi - lo) * roll / 99) * t, as a fraction, rounded to 0.1 percentage
 * points.
 */
export function affixValue(affixIdx, roll, tier) {
  const a = AFFIXES[affixIdx] || AFFIXES[0];
  const pct = (a.lo + (a.hi - a.lo) * roll / 99) * tier * 100;
  return Math.round(pct * 10) / 1000;
}

/**
 * Item numbers: weaponDmg (weapons), armor (ArmorPiece), affixes by affix id ({memo: 0.05}),
 * stats by stat name ({dmg: 0.05}), coffeeHeal (Mug: +2% x t) and prop
 * ({kind: "lts"|"keepsake", id, name, effect} or null).
 */
export function itemStats(item) {
  const b = baseOf(item);
  const t = itemTier(item.ilvl);
  const R = (RARITIES[item.rar] || RARITIES[0]).mult;
  const affixes = {};
  const st = {};
  for (const [ai, roll] of item.aff) {
    const a = AFFIXES[ai] || AFFIXES[0];
    const v = affixValue(ai, roll, t);
    affixes[a.id] = (affixes[a.id] || 0) + v;
    st[a.stat] = (st[a.stat] || 0) + v;
  }
  let prop = null;
  if (item.rar === R_LTS && LTS_PROPS[item.prop]) {
    const p = LTS_PROPS[item.prop];
    prop = { kind: "lts", id: p.id, name: p.name, effect: p.effect };
  } else if (item.rar === R_KEEPSAKE && KEEPSAKES[item.prop]) {
    const k = KEEPSAKES[item.prop];
    prop = { kind: "keepsake", id: k.id, name: k.name, effect: k.effect };
  }
  return {
    slot: b.slot, tier: t,
    weaponDmg: b.slot === "weapon" ? weaponDmg(item.ilvl, R, item.pol) : 0,
    armor: armorPiece(ITEM_BASES.slotK[b.slot] || 0, item.ilvl, R, item.pol),
    coffeeHeal: b.slot === "mug" ? 0.02 * t : 0,
    affixes, stats: st, prop,
  };
}

/**
 * Display name (D§8.3): Prototype "Base"; Alpha "Prefix Base" or "Base of Suffix"; Beta/Release
 * "[first prefix] Base [first suffix]", or the strongest (highest-roll) prefix when there is no
 * suffix; LTS "[Property] Base"; Keepsakes their fixed name; polish appends " +N".
 */
export function itemName(item) {
  const b = baseOf(item);
  let name = b.name;
  if (item.rar === R_KEEPSAKE) {
    name = (KEEPSAKES[item.prop] || {}).name || b.name;
  } else if (item.rar === R_LTS) {
    const p = LTS_PROPS[item.prop];
    name = p ? `${p.name} ${b.name}` : b.name;
  } else if (item.rar === 1 && item.aff.length) {
    const a = AFFIXES[item.aff[0][0]] || AFFIXES[0];
    name = a.kind === "prefix" ? `${a.name} ${b.name}` : `${b.name} ${a.name}`;
  } else if (item.rar >= 2 && item.aff.length) {
    const pre = item.aff.filter((x) => (AFFIXES[x[0]] || AFFIXES[0]).kind === "prefix");
    const suf = item.aff.filter((x) => (AFFIXES[x[0]] || AFFIXES[0]).kind === "suffix");
    if (suf.length) {
      name = (pre.length ? `${AFFIXES[pre[0][0]].name} ` : "") + `${b.name} ${AFFIXES[suf[0][0]].name}`;
    } else {
      let best = pre[0];
      for (const x of pre) if (x[1] > best[1]) best = x;
      name = `${AFFIXES[best[0]].name} ${b.name}`;
    }
  }
  return item.pol > 0 ? `${name} +${item.pol}` : name;
}

// ---------------------------------------------------------------------------------------------
// Rolling items (D§8.6)
// ---------------------------------------------------------------------------------------------

function classIdx(c) {
  if (c == null) return -1;
  return typeof c === "number" ? c : CLASS_IDX[c] ?? -1;
}

function rarityWeights(opts) {
  const src = opts.source;
  const w = [0, 0, 0, 0, 0, 0];
  if (src === "duck" || src === "boss") {
    const table = src === "duck" ? DROP_WEIGHTS.duckChest : opts.first ? DROP_WEIGHTS.bossFirst : DROP_WEIGHTS.bossRepeat;
    for (const id of Object.keys(table)) if (RARITY_IDX[id] != null) w[RARITY_IDX[id]] = table[id];
  } else {
    const chest = src === "chest";
    RARITIES.forEach((r, i) => { w[i] = chest ? r.wChest : r.wKill; });
    // Item find multiplies Beta, Release and LTS weights (capped +150%); elites double them again.
    const IF = Math.min(T.itemFindCap, Math.max(0, opts.itemFind || 0));
    for (const id of DROP_WEIGHTS.itemFindAffects) {
      const i = RARITY_IDX[id];
      w[i] *= 1 + IF;
      if (src === "elite") w[i] *= 2;
    }
  }
  const minRar = opts.minRar || 0;
  for (let i = 0; i < minRar; i++) w[i] = 0;
  if (!w.some((x) => x > 0)) w[Math.min(R_LTS, minRar)] = 1;
  return w;
}

function pickAffixes(holder, slot, count) {
  const pool = [];
  AFFIXES.forEach((a, i) => { if (a.slots.includes(slot)) pool.push(i); });
  const out = [];
  for (let k = 0; k < count && pool.length; k++) {
    const j = rngInt(holder, 0, pool.length - 1);
    out.push([pool[j], rngInt(holder, 0, 99)]);
    pool.splice(j, 1);
  }
  return out;
}

function pickWeaponType(holder, cls, own) {
  const ownType = cls >= 0 ? CLASSES[cls].weapon : null;
  if (own && ownType) return ownType;
  if (ownType && rngNext(holder) < DROP_WEIGHTS.weaponOwnClass) return ownType;
  const others = WEAPON_TYPES.filter((t) => t !== ownType);
  return rngElem(holder, others);
}

/**
 * Rolls one item.
 * @param {object} holder RNG holder (the finder hero, or the herd for shared rolls)
 * @param {{ilvl:number, source:"kill"|"elite"|"chest"|"duck"|"boss"|"review"|"squash",
 *          slot?:string|number, classId?:string|number, minRar?:number, rar?:number,
 *          itemFind?:number, first?:boolean, state?:object}} opts
 *   rar forces a rarity (reviews: Release; squash: next rarity); minRar floors it (chest tier
 *   guarantees); first selects the boss first-kill table; state supplies the uid (else
 *   holder.nextUid when the holder is the herd, else uid 0). A weapon matches classId 70% of the
 *   time (Interns: the Training Stick), always for a review.
 * @returns {object} Item (flag "new" set)
 */
export function rollItem(holder, opts) {
  const ilvl = Math.max(1, Math.round(opts.ilvl || 1));
  const t = itemTier(ilvl);
  const cls = classIdx(opts.classId);
  let rar;
  if (opts.rar != null) rar = opts.rar;
  else if (opts.source === "review") rar = RARITY_IDX.release;
  else rar = rngPick(holder, rarityWeights(opts));
  let slot = opts.slot;
  if (typeof slot === "number") slot = SLOTS[slot];
  if (!slot) slot = rngPick(holder, DROP_WEIGHTS.slots);
  const type = slot === "weapon" ? pickWeaponType(holder, cls, opts.source === "review") : slot;
  const base = baseIdFor(slot, t, type);
  const count = (RARITIES[rar] || RARITIES[0]).affixes + (slot === "sticker" ? 1 : 0);
  const aff = pickAffixes(holder, slot, count);
  let prop = -1;
  if (rar === R_LTS) {
    const pool = [];
    LTS_PROPS.forEach((p, i) => { if (p.slot === slot || p.slot === "any") pool.push(i); });
    prop = rngElem(holder, pool);
  }
  const uidSrc = opts.state || (holder && holder.nextUid != null ? holder : null);
  return { uid: allocUid(uidSrc), base, ilvl, rar, pol: 0, aff, flags: FLAG_NEW, prop };
}

/**
 * A boss Keepsake (D§8.5): fixed name and slot, boss level, 3 random affixes (+1 on stickers) and
 * its unique property. The class-adaptive weapon takes the finder's weapon type as its base.
 */
export function rollKeepsake(holder, { bossIdx, ilvl, classId, state } = {}) {
  const kIdx = KEEPSAKES.findIndex((k) => k.boss === bossIdx);
  const k = KEEPSAKES[kIdx];
  const lvl = Math.max(1, Math.round(ilvl || 1));
  const t = itemTier(lvl);
  const cls = classIdx(classId);
  const type = k.slot === "weapon" ? (cls > 0 ? CLASSES[cls].weapon : WEAPON_TYPES[0]) : k.slot;
  const aff = pickAffixes(holder, k.slot, RARITIES[R_KEEPSAKE].affixes + (k.slot === "sticker" ? 1 : 0));
  const uidSrc = state || (holder && holder.nextUid != null ? holder : null);
  return { uid: allocUid(uidSrc), base: baseIdFor(k.slot, t, type), ilvl: lvl, rar: R_KEEPSAKE, pol: 0, aff, flags: FLAG_NEW, prop: kIdx };
}

/** Item level for a drop source (D§8.6): kill/elite m + U{0,1}; chest map top + U{0,1,2}; duck m + 2; boss/review as given. */
export function dropIlvl(holder, source, level) {
  if (source === "kill" || source === "elite") return level + rngInt(holder, 0, 1);
  if (source === "chest") return level + rngInt(holder, 0, 2);
  if (source === "duck") return level + 2;
  return level;
}

/**
 * Chance that a kill drops an item (D§8.6): normal 0.4% x (1 + IF) x shiftKill; Smelly elite 20%
 * (x shiftKill: the Daily Shift scales kill drops).
 */
export function killDropChance({ elite = false, itemFind = 0, shiftKill = 1 } = {}) {
  if (elite) return ELITE.itemChance * shiftKill;
  return DROP_WEIGHTS.killItemChance * (1 + Math.min(T.itemFindCap, Math.max(0, itemFind))) * shiftKill;
}

/** The reward item of a won review (D§4.5): Senior a Release class weapon, Staff a Release Sticker, at the hero's level. */
export function rollReviewReward(holder, { reviewIdx, L, classId, state } = {}) {
  const r = REVIEWS[reviewIdx].reward.item;
  return rollItem(holder, { ilvl: L, source: "review", slot: r.slot, rar: r.rarity, classId, state });
}

/** Items in a Commit Chest: floor(rawSeals) + 1 more with probability frac(rawSeals). */
export function chestItemCount(holder, raw) {
  const n = Math.floor(raw);
  return n + (rngNext(holder) < raw - n ? 1 : 0);
}

/**
 * Rolls the items of a Commit Chest (D§2.4, D§8.6). Silver guarantees one Alpha+, Gold one Beta+
 * (the first item carries the guarantee). Unreviewed chests hold floor(rawSeals / 2) items and no
 * guarantee.
 * @param {{raw:number, mapTop:number, classId?, itemFind?:number, state?:object, unreviewed?:boolean}} o
 */
export function rollChest(holder, o) {
  const count = o.unreviewed ? Math.floor(o.raw / 2) : chestItemCount(holder, o.raw);
  const tier = chestTierOf(o.raw);
  const floor = !o.unreviewed && tier.floor ? RARITY_IDX[tier.floor] : 0;
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push(rollItem(holder, {
      ilvl: dropIlvl(holder, "chest", o.mapTop), source: "chest", classId: o.classId, itemFind: o.itemFind,
      minRar: i === 0 ? floor : 0, state: o.state,
    }));
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Autopilot equip (D§8.7)
// ---------------------------------------------------------------------------------------------

function ctxOf(ctx, hero, state) {
  if (typeof ctx === "function") return ctx(hero) || {};
  return ctx || (state ? { herd: state.herd } : {});
}

/**
 * Autopilot score of putting `item` into `slotIdx`: wD * ΔDPS_est% + wE * ΔEHP% with
 * EHP = MaxHP / (1 - DR(L)) / (1 - Dodge) and the class weights (D§4.3). Fractions (0.02 = +2%).
 */
export function scoreDelta(hero, item, slotIdx, ctx = {}) {
  const si = slotIdx ?? slotIdxOf(item);
  const cur = stats(hero, ctx);
  const eq = hero.eq.slice();
  eq[si] = item;
  const alt = computeStats(hero, ctx, eq);
  const w = (CLASSES[hero.cls] || CLASSES[0]).weights;
  const dD = cur.dpsEst > 0 ? alt.dpsEst / cur.dpsEst - 1 : 0;
  const dE = cur.ehp > 0 ? alt.ehp / cur.ehp - 1 : 0;
  return w.dps * dD + w.ehp * dE;
}

/** Is the item worth equipping for this hero? (score >= +2%; design gap: any usable item fills an empty slot). */
export function isUpgrade(hero, item, ctx, opts = {}) {
  if (!canEquip(hero, item, opts)) return false;
  const si = slotIdxOf(item);
  const cur = hero.eq[si];
  if (cur && cur.uid === item.uid) return false;
  if (cur && cur.flags & FLAG_LOCKED) return false;
  const s = scoreDelta(hero, item, si, ctx);
  return cur ? s >= EQUIP_THRESHOLD : s >= 0;
}

/**
 * Equips an item (from the stash or a fresh drop) on a hero: ports floor(old polish / 2) levels to
 * the new item (up to its max), clears its "new" flag and puts the replaced item into the stash.
 * @returns {{ok:boolean, replaced:object|null, ported:number, error?:string}}
 */
export function equipItem(state, hero, item) {
  if (!canEquip(hero, item)) return { ok: false, replaced: null, ported: 0, error: "Can't use this" };
  const si = slotIdxOf(item);
  const old = hero.eq[si];
  if (old && old.uid === item.uid) return { ok: true, replaced: null, ported: 0 };
  removeFromStash(state, item.uid);
  // an item worn by another hero moves: one item object never has two owners
  for (const h of state.heroes || []) {
    if (h === hero || !h.eq) continue;
    const k = h.eq.indexOf(item);
    if (k >= 0) h.eq[k] = null;
  }
  let ported = 0;
  if (old) {
    ported = Math.max(0, Math.min(Math.floor(old.pol / 2), polishMax(item.rar) - item.pol));
    item.pol += ported;
    old.pol -= ported;
  }
  item.flags &= ~FLAG_NEW;
  hero.eq[si] = item;
  if (old) stashPut(state, old);
  return { ok: true, replaced: old || null, ported };
}

/**
 * Autopilot equip for one hero (D§8.7): equips if the item is usable, the slot is not locked and
 * the score is >= +2% (any usable item fills an empty slot).
 * @returns {{equipped:boolean, replaced:object|null}}
 */
export function autoEquip(state, hero, item, ctx) {
  const c = ctxOf(ctx, hero, state);
  if (!isUpgrade(hero, item, c)) return { equipped: false, replaced: null };
  const r = equipItem(state, hero, item);
  return { equipped: r.ok, replaced: r.replaced };
}

/**
 * Offers a new drop: the finder first, then every roster hero who can use it (when auto-equip
 * is on); otherwise it goes to the stash (with auto-deprecate). A finder that is not in the roster
 * (a Contractor, never saved) is not offered gear.
 * @param ctx a stats ctx, or a function hero -> ctx
 * @returns {{heroId:number|null, replaced:object|null, kept:boolean, deprecated:object|null}}
 */
export function offerItem(state, finder, item, ctx) {
  const auto = (state.herd.cfg && state.herd.cfg.auto) || {};
  if (auto.equip !== false) {
    const inRoster = finder && state.heroes.includes(finder);
    const order = inRoster ? [finder].concat(state.heroes.filter((h) => h !== finder)) : state.heroes;
    for (const h of order) {
      const r = autoEquip(state, h, item, ctx);
      if (r.equipped) return { heroId: h.id, replaced: r.replaced, kept: true, deprecated: null };
    }
  }
  const s = stashAdd(state, item, { ctx });
  return { heroId: null, replaced: null, kept: s.kept, deprecated: s.deprecated };
}

// ---------------------------------------------------------------------------------------------
// Stash ("vendor/", D§8.8)
// ---------------------------------------------------------------------------------------------

/** Stash capacity: 40 + 10 per vendor/ level, max 140. */
export function stashCap(state) {
  const lvl = (state.herd.bld || [])[BUILDING_IDX.vendor] || 0;
  return Math.min(STASH.max, STASH.base + BUILDINGS[BUILDING_IDX.vendor].perLevel.stashSlots * lvl);
}

/** Finds an item anywhere: {item, where: "stash"|"hero", index, hero?, slot?} or null. */
export function findItem(state, uid) {
  const stash = state.herd.stash;
  for (let i = 0; i < stash.length; i++) if (stash[i].uid === uid) return { item: stash[i], where: "stash", index: i };
  for (const h of state.heroes) {
    for (let s = 0; s < h.eq.length; s++) {
      const it = h.eq[s];
      if (it && it.uid === uid) return { item: it, where: "hero", hero: h, slot: s, index: s };
    }
  }
  return null;
}

function removeFromStash(state, uid) {
  const stash = state.herd.stash;
  const i = stash.findIndex((x) => x.uid === uid);
  if (i >= 0) stash.splice(i, 1);
  return i >= 0;
}

function journal(state, kind, heroId, text, value) {
  // Same entry shape as herd.js journal(): [at, kind, heroId, text, value], newest last, max 60.
  const herd = state.herd;
  if (!herd.log) herd.log = [];
  herd.log.push([herd.lastMs || 0, kind, heroId, text, value]);
  while (herd.log.length > 60) herd.log.shift();
}

function salvage(state, item) {
  const y = deprecateYield(item.ilvl, item.rar);
  state.herd.snip = (state.herd.snip || 0) + y.snippets;
  state.herd.gold = (state.herd.gold || 0) + y.gold;
  return y;
}

function deprecatable(item) {
  return !(item.flags & FLAG_LOCKED) && item.rar !== R_KEEPSAKE;
}

/**
 * Puts an item into the stash without the auto-deprecate check (replaced gear, squash results).
 * When full, the lowest-IP unlocked non-Keepsake item (possibly this one) is deprecated and logged.
 * @returns {{kept:boolean, deprecated:object|null}}
 */
export function stashPut(state, item) {
  const stash = state.herd.stash;
  let deprecated = null;
  if (stash.length >= stashCap(state)) {
    let worst = deprecatable(item) ? item : null;
    let worstIP = worst ? itemIP(item) : Infinity;
    for (const x of stash) {
      if (!deprecatable(x)) continue;
      const ip = itemIP(x);
      if (ip < worstIP) { worst = x; worstIP = ip; }
    }
    if (worst) {
      salvage(state, worst);
      journal(state, "deprecate", null, `Stash full: deprecated ${itemName(worst)}`, worstIP);
      deprecated = worst;
      if (worst === item) return { kept: false, deprecated };
      removeFromStash(state, worst.uid);
    }
  }
  stash.push(item);
  return { kept: true, deprecated };
}

/** Would any roster hero (of the right class, level aside) take this item as an upgrade? */
export function isUpgradeForAnyone(state, item, ctx) {
  for (const h of state.heroes) if (isUpgrade(h, item, ctxOf(ctx, h, state), { ignoreLevel: true })) return true;
  return false;
}

/**
 * Adds a new item to the stash (D§8.8). With auto-deprecate on, a new Prototype or Alpha item that
 * is no upgrade for any roster hero is deprecated at once (Beta+ is kept). Full stash: see stashPut.
 * @param {{ctx?, autoDeprecate?:boolean}} [opts]
 * @returns {{kept:boolean, deprecated:object|null}}
 */
export function stashAdd(state, item, opts = {}) {
  const auto = (state.herd.cfg && state.herd.cfg.auto) || {};
  const autoDep = opts.autoDeprecate ?? auto.deprecate !== false;
  if (autoDep && item.rar <= RARITY_IDX.alpha && deprecatable(item) && !isUpgradeForAnyone(state, item, opts.ctx)) {
    salvage(state, item);
    return { kept: false, deprecated: item };
  }
  return stashPut(state, item);
}

/**
 * Deprecate (salvage) a stash item: Snippets = yield(rarity) x t, plus 2 x gold(i).
 * Locked items and Keepsakes cannot be deprecated.
 */
export function deprecate(state, uid) {
  const f = findItem(state, uid);
  if (!f || f.where !== "stash") return { ok: false, snippets: 0, gold: 0, error: "Not in the stash" };
  if (!deprecatable(f.item)) return { ok: false, snippets: 0, gold: 0, error: f.item.rar === R_KEEPSAKE ? "Keepsakes are forever" : "Locked" };
  removeFromStash(state, uid);
  const y = salvage(state, f.item);
  return { ok: true, snippets: y.snippets, gold: y.gold };
}

/** Lock or unlock an item (stash or equipped). */
export function setLocked(state, uid, locked) {
  const f = findItem(state, uid);
  if (!f) return { ok: false, error: "No such item" };
  if (locked) f.item.flags |= FLAG_LOCKED;
  else f.item.flags &= ~FLAG_LOCKED;
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Polish, Squash Merge, Reroll (D§8.8)
// ---------------------------------------------------------------------------------------------

/** Cost of the next polish level of an item, or null at max: {gold, snippets}. */
export function nextPolishCost(state, item) {
  if (item.pol >= polishMax(item.rar)) return null;
  return polishCostOf(item.ilvl, item.pol, (state.herd.bld || [])[FORGE] || 0);
}

/**
 * Autopilot polish rule (D§8.8): only when gold >= 5x and Snippets >= 2x the next level's cost
 * (which also keeps more than the 20% gold reserve).
 */
export function autoPolishOk(state, item) {
  const c = nextPolishCost(state, item);
  if (!c) return false;
  const herd = state.herd;
  const gold = herd.gold || 0;
  return gold >= 5 * c.gold && (herd.snip || 0) >= 2 * c.snippets && gold - c.gold >= T.goldReserve * gold;
}

/** Polish one level (always succeeds): +5% base stat, up to the rarity's max. */
export function polish(state, uid) {
  const f = findItem(state, uid);
  if (!f) return { ok: false, cost: null, error: "No such item" };
  const cost = nextPolishCost(state, f.item);
  if (!cost) return { ok: false, cost: null, error: "Fully polished" };
  const herd = state.herd;
  if ((herd.gold || 0) < cost.gold || (herd.snip || 0) < cost.snippets) return { ok: false, cost, error: "Not enough gold or Snippets" };
  herd.gold -= cost.gold;
  herd.snip -= cost.snippets;
  f.item.pol++;
  return { ok: true, cost };
}

/**
 * Squash Merge (CI Forge 3): 3 unlocked stash items of the same rarity (Prototype, Alpha or Beta)
 * become 1 random item of the next rarity at their average item level. Costs 20 x gold(i).
 * Rolled with the herd RNG.
 */
export function squash(state, uids) {
  const herd = state.herd;
  if (((herd.bld || [])[FORGE] || 0) < FORGE_SQUASH) return { ok: false, item: null, error: `Needs CI Forge ${FORGE_SQUASH}` };
  const ids = Array.from(new Set(uids || []));
  if (ids.length !== 3) return { ok: false, item: null, error: "Pick 3 items" };
  const items = [];
  for (const uid of ids) {
    const f = findItem(state, uid);
    if (!f || f.where !== "stash") return { ok: false, item: null, error: "Items must be in the stash" };
    if (f.item.flags & FLAG_LOCKED) return { ok: false, item: null, error: "Locked items can't be merged" };
    items.push(f.item);
  }
  const rar = items[0].rar;
  if (!items.every((x) => x.rar === rar) || rar > RARITY_IDX.beta) return { ok: false, item: null, error: "3 items of one rarity (Prototype, Alpha or Beta)" };
  const ilvl = Math.round((items[0].ilvl + items[1].ilvl + items[2].ilvl) / 3);
  const cost = 20 * gold(ilvl);
  if ((herd.gold || 0) < cost) return { ok: false, item: null, cost, error: "Not enough gold" };
  herd.gold -= cost;
  for (const x of items) removeFromStash(state, x.uid);
  const item = rollItem(herd, { ilvl, source: "squash", rar: rar + 1, state });
  stashPut(state, item);
  return { ok: true, item, cost };
}

/**
 * Reroll (CI Forge 5): rerolls one affix (type and value) of an Alpha+ non-Keepsake item. The new
 * affix never duplicates another affix on the item. Costs 50 x gold(i) + 10t Snippets.
 * @param {number} affixPos index into item.aff
 */
export function reroll(state, uid, affixPos) {
  const herd = state.herd;
  if (((herd.bld || [])[FORGE] || 0) < FORGE_REROLL) return { ok: false, error: `Needs CI Forge ${FORGE_REROLL}` };
  const f = findItem(state, uid);
  if (!f) return { ok: false, error: "No such item" };
  const it = f.item;
  if (it.rar < RARITY_IDX.alpha || it.rar === R_KEEPSAKE) return { ok: false, error: "Alpha or better, not a Keepsake" };
  if (!(affixPos >= 0 && affixPos < it.aff.length)) return { ok: false, error: "No such affix" };
  const t = itemTier(it.ilvl);
  const cost = { gold: 50 * gold(it.ilvl), snippets: 10 * t };
  if ((herd.gold || 0) < cost.gold || (herd.snip || 0) < cost.snippets) return { ok: false, cost, error: "Not enough gold or Snippets" };
  const slot = slotOf(it);
  const others = new Set(it.aff.filter((_, i) => i !== affixPos).map((a) => a[0]));
  const pool = [];
  AFFIXES.forEach((a, i) => { if (a.slots.includes(slot) && !others.has(i)) pool.push(i); });
  if (!pool.length) return { ok: false, error: "No other affix fits" };
  herd.gold -= cost.gold;
  herd.snip -= cost.snippets;
  const next = [rngElem(herd, pool), rngInt(herd, 0, 99)];
  it.aff = it.aff.map((x, i) => (i === affixPos ? next : x)); // replaced, not edited: stats caches compare identity
  return { ok: true, cost, affix: it.aff[affixPos] };
}
