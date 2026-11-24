// Autopilot (D§5.7, D§7.1, D§8.7, D§8.8, D§9.5, D§10.2): everything the game does for you, each
// behind its herd.cfg.auto.* switch (equip, deprecate, learn, polish, buildings, maps, boss, farm,
// calls, career).
//
//   autopilot(world, ev)                      every 60 ticks: the whole herd
//   autopilot(world, ev, {heroIds:[...]})     on a hero's level / gear / crash change: that hero only
//
// Cost control: a herd-wide pass looks at a slice of the stash only (STASH_CHUNK items, resuming
// where the last pass stopped), and every equip candidate is pre-filtered by class, level and Item
// Power before the (expensive) score is computed, so a pass stays cheap even in QuickJS.
//
// Pure: no host calls, no Date.now(), no Math.random().

import { TUNING as T, MAPS, MAP_BY_ID, ZONES, BOSSES, BUILDINGS, BACKLOG, REVIEWS, RARITIES } from "./data.js";
import { stats, autoLearn } from "./heroes.js";
import {
  canEquip, slotIdxOf, isUpgrade, autoEquip, equipItem, scoreDelta, stashPut, deprecate, polish,
  autoPolishOk, FLAG_LOCKED,
} from "./items.js";
import { mapUnlocked, backlogOpen, doorOpen, autoBuyPick, buy, buildingLevel } from "./herd.js";
import { polishMax, g, weaponDmg, iRef, refHP, refDR } from "./formulas.js";
import { heroCtx } from "./combat.js";
import * as B from "./boss.js";

const MAX_LAG = 5; //       gearLag() reports at most 5 levels
const CONVERGE_BELOW = 4; // convergence never takes a hero to a map whose mid is more than 4 under its level
const PREFILTER = 0.8; //   items under 80% of the equipped item's gear scale are never scored
const STASH_CHUNK = 12; //  stash items looked at per herd-wide pass
const PER_SLOT = 3; //      largest-scale candidates scored per slot when one hero is swept
const SCORE_BUDGET = 40; // autopilot scores (stats dry runs) per herd-wide sweep
const OFFER_SCORES = 6; //  heroes a fresh drop is scored for (finder first, then by scale gain)

function autoCfg(state) {
  const a = (state.herd.cfg && state.herd.cfg.auto) || {};
  const on = (k) => a[k] !== false;
  return {
    equip: on("equip"), deprecate: on("deprecate"), learn: on("learn"), polish: on("polish"),
    buildings: on("buildings"), maps: on("maps"), boss: on("boss"), farm: on("farm"), calls: on("calls"),
    career: on("career"),
  };
}

// Every price of a hero uses combat's ctx for it (live heroes: their room ctx), so heroes.stats
// keeps one cache entry per hero instead of recomputing between contexts.
function ctxFn(world) {
  return (hero) => heroCtx(world, hero);
}

function heroOf(world, id) {
  if (id < 0) {
    for (const c of world.rt.contractors ? world.rt.contractors.values() : []) if (c.id === id) return c;
    return null;
  }
  for (const h of world.state.heroes) if (h.id === id) return h;
  return null;
}

function errorOf(world, where, e) {
  const rt = world.rt;
  if (!rt) return;
  if (!rt.errors) rt.errors = [];
  rt.errors.push(`${where}: ${e && e.message ? e.message : e}`);
  if (rt.errors.length > 20) rt.errors.shift();
}

// ---------------------------------------------------------------------------------------------
// Map choice (D§5.7, D§2.8 convergence, D§5.6 crash rule, D§9.8 Backlog)
// ---------------------------------------------------------------------------------------------

/** Crashes within the last 10 minutes (live.crashes holds crash ticks, kept by combat). */
export function recentCrashes(live, tick) {
  if (!live || !live.crashes) return 0;
  const from = tick - T.crash.dropMapAfter[1];
  let n = 0;
  for (const t of live.crashes) if (t > from) n++;
  return n;
}

/**
 * Deepest Backlog floor for a hero (D§9.8): effective level 100 + ln(1.06^f)/ln(1.07) <= PL + 1,
 * at most the herd's current floor (herd.backlog.floor is the deepest floor reached: combat.js
 * opens the next one after 50 kills there, boss.js after a boss floor falls).
 */
export function backlogFloor(world, hero) {
  const st = stats(hero, heroCtx(world, hero));
  const lim = ((st.pl + 1 - BACKLOG.level) * Math.log(T.g)) / Math.log(BACKLOG.perFloor.hp);
  // balance: and no deeper than the hero can stand: floor f hits 1.05^f harder, so its EHP over the
  // reference hero's (D§5.2) buys ln(EHP / refEHP) / ln(1.05) floors, plus the on-level one. Power
  // Level alone sent single-target classes (Hotfixer PL ~ L + 8, the least HP) to floor 10 to
  // drink 20 cups an hour and crash (tools/pacing-sim.mjs --sweep)
  const refEhp = refHP(BACKLOG.level) / (1 - refDR(BACKLOG.level));
  const byEhp = 1 + Math.log(Math.max(1e-9, st.ehp) / refEhp) / Math.log(BACKLOG.perFloor.atk);
  const herdFloor = Math.max(1, (world.state.herd.backlog && world.state.herd.backlog.floor) || 1);
  return Math.max(1, Math.min(herdFloor, Math.floor(Math.min(lim, byEhp) + 1e-9)));
}

/**
 * Levels by which a hero's weapon lags the reference weapon of its level (D§5.2: iRef(L), R_ref,
 * polish L/10), 0..5. Class-neutral, unlike Power Level: PL measures the class's own DPS, which
 * puts a Refactorer or Forkbinder in the reference kit 3-4 levels under its level and a Hotfixer
 * 3-6 over (see map choice below).
 */
export function gearLag(hero, st) {
  const L = hero.L;
  const R = T.ref;
  const ref = weaponDmg(iRef(L), 1 + R.rarityPerL * L, (R.polishPerL * L) / T.polish.perLevel);
  const have = st.weaponDmg > 0 ? st.weaponDmg : 1e-9;
  // whole levels only: a weapon a fraction of a level behind (an unpolished Prototype at iRef, the
  // reference kit's rarity and polish being fractional) does not hold its hero back a map
  const lag = Math.floor(Math.log(ref / have) / Math.log(T.g) + 1e-9);
  return Math.max(0, Math.min(MAX_LAG, lag));
}

// A hero's own map choice as a MAPS index (-1 = the Backlog): the pin, the Backlog at Lv 100, else
// the deepest open map with mid <= eff + 1 where eff = L (L - 1 at most after a
// recent crash), and never deeper than combat's crash-rule map (live.dropMap) while it holds. No
// guild convergence.
//
// Deviation from D§5.7 ("mid <= PL + 1"), found with tools/pacing-sim.mjs: Power Level measures
// the class's own single-target DPS, so with the same gear it sits 3-4 levels under L for a
// Refactorer or Forkbinder and 3-6 over for a Hotfixer (gearLag's comment). By PL, tanks and
// summoners farmed 3 levels low (gap penalty) and dragged their guild down through convergence,
// while over-geared heroes climbed above their level and outpaced D§12.1 by 30-40%. The pacing
// model behind D§12.1 fights on level; gear shows as kill speed. Power Level still sets Backlog
// floors, boss estimates and the sheet's "fights like" line.
// balance: a weapon lagging the reference kit no longer moves the hero down (it did, up to 2
// levels): drops land at the reference item level now (items.dropIlvl), a lagging weapon is common,
// and one-agent herds sat a map low for days, missing the quota on the zone's last map that opens
// the boss door. An under-geared hero that crashes still steps down (the crash rule, D§5.6).
function ownChoice(world, hero, live) {
  const { state } = world;
  const rt = world.rt || {};
  if (hero.pinMap && mapUnlocked(state, hero.pinMap)) return hero.pinMap === BACKLOG.id ? -1 : MAP_BY_ID[hero.pinMap].n;
  if (hero.L >= T.levelCap && backlogOpen(state)) return -1;
  let eff = hero.L;
  if (live && recentCrashes(live, rt.tick || 0) > 0) eff = Math.min(eff, hero.L - 1);
  let idx = 0;
  for (const m of MAPS) if (m.mid <= eff + 1 && mapUnlocked(state, m)) idx = m.n;
  // hysteresis: a hero one map deeper than its choice stays while that map's mid <= eff + 2, so a
  // crash hovering at a boundary does not move it back and forth (and reset its lane)
  const cur = live && MAP_BY_ID[live.mapId];
  if (cur && cur.n === idx + 1 && cur.mid <= eff + 2 && mapUnlocked(state, cur)) idx = cur.n;
  const drop = live && live.dropMap;
  if (drop && (rt.nowMs || 0) < drop.untilMs && MAP_BY_ID[drop.mapId]) idx = Math.min(idx, MAP_BY_ID[drop.mapId].n);
  return idx;
}

/**
 * Autopilot map choice for a hero (D§5.7, see ownChoice for the level-based rule): its own choice
 * (the manual pin if open; Lv 100 heroes go to the Backlog once it is open; otherwise the deepest
 * open map whose mid level <= L + 1, at most L after a crash in the last 10
 * minutes; never deeper than the crash rule's map while combat's live.dropMap holds, D§5.6), then
 * guild convergence (D§2.8): the hero moves down to a guild-mate's map when that is exactly one
 * map below its own choice and its mid is at most 4 levels under the hero (a one-map step is 3-4
 * levels; a hero far above that map would farm at a heavy gap penalty to keep a lagging mate
 * company, and a guild held there stops feeding the frontier map's quota: seen in
 * tools/pacing-sim.mjs as a 10-day stall). Mates count with their own choice, not where they
 * stand, so two equal mates never hold each other back. A pinned hero never converges.
 * @param {object} [live] the hero's Live (convergence and crashes need it; off-duty heroes have none)
 * @param {Map} [cache] heroId -> own choice, shared by the calls of one autopilot pass
 * @returns {string} map id ("1-1" ... "9-3" or "backlog")
 */
export function chooseMap(world, hero, live, cache) {
  const rt = world.rt || {};
  const own = (h, l) => {
    if (!cache) return ownChoice(world, h, l);
    let v = cache.get(h.id);
    if (v == null) { v = ownChoice(world, h, l); cache.set(h.id, v); }
    return v;
  };
  let idx = own(hero, live);
  if (idx < 0) {
    if (live) live.floor = backlogFloor(world, hero);
    return BACKLOG.id;
  }
  const pinned = hero.pinMap && mapUnlocked(world.state, hero.pinMap);
  if (!pinned && live && live.space && rt.live) {
    for (const [id, l] of rt.live) {
      if (l === live || l.space !== live.space) continue;
      const mate = heroOf(world, id);
      if (!mate) continue;
      if (own(mate, l) === idx - 1 && MAPS[idx - 1].mid >= hero.L - CONVERGE_BELOW) { idx -= 1; break; }
    }
  }
  return MAPS[idx].id;
}

/**
 * Levels of the map a hero fights on (its live map, else where autopilot would put it):
 * {id, mid, top, zone}. The Backlog uses level-100 formulas and loot level 100 + floor(f / 2).
 */
export function mapLevels(world, hero, live) {
  const id = (live && live.mapId) || chooseMap(world, hero, null);
  if (id === BACKLOG.id) {
    const f = (live && live.floor) || backlogFloor(world, hero);
    return { id, mid: BACKLOG.level, top: BACKLOG.lootIlvl.base + Math.floor(f * BACKLOG.lootIlvl.perFloor), zone: BACKLOG.n };
  }
  const m = MAP_BY_ID[id] || MAPS[0];
  return { id: m.id, mid: m.mid, top: m.top, zone: m.zone };
}

/** Moves a live hero to another map (its lane resets; rooms are rebuilt). */
export function moveTo(world, hero, live, mapId) {
  if (!live || live.mapId === mapId) return false;
  live.mapId = mapId;
  live.lane = [];
  live.engagedUid = null;
  if (world.rt) world.rt.roomsDirty = true;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Gear (D§8.7, D§8.8)
// ---------------------------------------------------------------------------------------------

/**
 * An item's stat scale for the cheap pre-filter: the base stat of formulas.weaponDmg / armorPiece
 * (g(iLvl) x R x polish) with the affix count as in Item Power. Not Item Power itself: IP (D§8.7, a
 * tooltip number) is linear in item level while stats grow 7% per level, so by IP a +12 Keepsake
 * at iLvl 67 "beats" a Release at iLvl 90 that deals 2.3x its damage, and an IP pre-filter kept
 * late heroes in long-outgrown gear (Power Level sank to L - 5; found by tools/pacing-sim.mjs).
 * `port`: polish levels the item would inherit from the one it replaces (items.equipItem).
 */
export function gearScale(item, port = 0) {
  const r = RARITIES[item.rar] || RARITIES[0];
  const pol = Math.min(polishMax(item.rar), item.pol + port);
  return g(item.ilvl) * r.mult * (1 + T.polish.perLevel * pol) * (1 + 0.08 * item.aff.length);
}

// Cheap pre-filter before the autopilot score: usable, the slot is not locked, and the item's
// gear scale (with the polish it would inherit) is at least 80% of what is worn (a weapon of
// another class's type counts as nothing worn). Returns the scale gain (new / worn; Infinity for an
// empty or unusable slot) or 0 when the item is no candidate.
function candidateGain(hero, item, ignoreLevel) {
  if (!hero || hero.contractor || !hero.eq) return 0;
  if (!canEquip(hero, item, { ignoreLevel })) return 0;
  const si = slotIdxOf(item);
  const cur = hero.eq[si];
  if (!cur) return Infinity;
  if (cur.uid === item.uid) return 0;
  if (cur.flags & FLAG_LOCKED) return 0;
  if (!canEquip(hero, cur, { ignoreLevel: true })) return Infinity;
  const gain = gearScale(item, Math.floor(cur.pol * T.polish.portShare)) / gearScale(cur);
  return gain >= PREFILTER ? gain : 0;
}

function candidate(hero, item, ignoreLevel) {
  return candidateGain(hero, item, ignoreLevel) > 0;
}

// The heroes an item is scored for, best first: the finder (when a candidate), then the others by
// scale gain, at most OFFER_SCORES in all. Scoring is a stats dry run per hero; with 30 heroes a
// 12-Seal chest otherwise cost ~10 ms in V8 (~0.3 s in QuickJS). Items nobody takes go to the
// stash, where the 60-tick sweep and level-up sweeps offer them again.
function offerOrder(state, finder, item, ignoreLevel) {
  const scored = [];
  let first = null;
  for (const h of state.heroes) {
    const gain = candidateGain(h, item, ignoreLevel);
    if (!(gain > 0)) continue;
    if (h === finder) first = h;
    else scored.push([gain, h]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].id - b[1].id);
  const out = first ? [first] : [];
  for (const [, h] of scored) {
    if (out.length >= OFFER_SCORES) break;
    out.push(h);
  }
  return out;
}

/**
 * Offers a fresh drop (D§8.7): the finder first, then the roster heroes it helps most (at most
 * OFFER_SCORES scored), equipped at score >= +2% (auto-equip). Otherwise it goes to the stash;
 * with auto-deprecate a Prototype or Alpha item that is no upgrade for anyone (class aside from
 * level) is deprecated at once (D§8.8). Same rules as items.offerItem, with the cheap pre-filter
 * in front of every score.
 * @param {object|null} finder roster hero (null for Contractors and herd drops)
 * @returns {{heroId:number|null, kept:boolean, deprecated:object|null, replaced:object|null}}
 */
export function offerDrop(world, finder, item, ev) {
  const state = world.state;
  const auto = autoCfg(state);
  const ctx = ctxFn(world);
  const declined = new Set(); // heroes whose score already said no (level aside, the score is the same)
  if (auto.equip) {
    for (const h of offerOrder(state, finder, item, false)) {
      const r = autoEquip(state, h, item, ctx);
      if (r.equipped) {
        gearChanged(world, h);
        return { heroId: h.id, kept: true, deprecated: null, replaced: r.replaced };
      }
      declined.add(h);
    }
  }
  if (auto.deprecate && item.rar <= 1 && !(item.flags & FLAG_LOCKED) && !wantedByAnyone(state, item, ctx, declined)) {
    state.herd.stash.push(item);
    deprecate(state, item.uid);
    return { heroId: null, kept: false, deprecated: item, replaced: null };
  }
  const s = stashPut(state, item);
  return { heroId: null, kept: s.kept, deprecated: s.deprecated, replaced: null };
}

function wantedByAnyone(state, item, ctx, declined) {
  for (const h of offerOrder(state, null, item, true)) {
    if (declined && declined.has(h)) continue;
    if (isUpgrade(h, item, ctx(h), { ignoreLevel: true })) return true;
  }
  return false;
}

function gearChanged(world, hero) {
  const rt = world.rt;
  if (!rt) return;
  if (!rt.apGear) rt.apGear = new Set();
  rt.apGear.add(hero.id);
}

/**
 * Equips the best stash upgrade per slot for one hero (on level-up or gear change): per slot, the
 * PER_SLOT largest-scale pre-filtered items are scored and the best one is equipped if it clears the
 * +2% threshold. Returns the number of items equipped.
 */
export function sweepHero(world, hero) {
  const state = world.state;
  if (!hero || hero.contractor) return 0;
  const ctx = heroCtx(world, hero);
  const bySlot = [[], [], [], [], [], []];
  for (const it of state.herd.stash) if (candidate(hero, it, false)) bySlot[slotIdxOf(it)].push(it);
  let n = 0;
  for (let s = 0; s < bySlot.length; s++) {
    const list = bySlot[s];
    if (!list.length) continue;
    list.sort((a, b) => gearScale(b) - gearScale(a) || a.uid - b.uid);
    let best = null;
    let bestScore = -Infinity;
    for (const it of list.slice(0, PER_SLOT)) {
      const sc = scoreDelta(hero, it, s, ctx);
      if (sc > bestScore) { best = it; bestScore = sc; }
    }
    if (best && isUpgrade(hero, best, ctx)) {
      const r = equipItem(state, hero, best);
      if (r.ok) n++;
    }
  }
  if (n) gearChanged(world, hero);
  return n;
}

/**
 * The herd-wide stash sweep (D§8.7 "every 60 ticks"), STASH_CHUNK items per pass starting at
 * rt.apCursor: each item is offered to the roster (pre-filtered), first taker wins. At most
 * SCORE_BUDGET scores per pass; items already offered to an unchanged roster are skipped.
 */
export function sweepChunk(world) {
  const { state, rt } = world;
  const stash = state.herd.stash;
  if (!stash.length || !state.heroes.length) return 0;
  const ctx = ctxFn(world);
  // an item already offered to this very roster (same levels, gear, classes) is skipped
  const ver = rosterVersion(state);
  if (!rt.apSeen || rt.apSeen.ver !== ver) rt.apSeen = { ver, uids: new Set() };
  const seen = rt.apSeen.uids;
  const start = (rt.apCursor || 0) % stash.length;
  const count = Math.min(STASH_CHUNK, stash.length);
  const items = [];
  for (let k = 0; k < count; k++) items.push(stash[(start + k) % stash.length]);
  let budget = SCORE_BUDGET;
  let n = 0;
  let done = 0;
  for (const it of items) {
    if (budget <= 0) break; // resume at this item next pass
    done++;
    if (!stash.includes(it) || seen.has(it.uid)) continue;
    seen.add(it.uid);
    for (const h of state.heroes) {
      if (!candidate(h, it, false)) continue;
      budget--;
      const r = autoEquip(state, h, it, ctx);
      if (r.equipped) { n++; gearChanged(world, h); break; }
      if (budget <= 0) break;
    }
  }
  rt.apCursor = start + done;
  return n;
}

// A number that changes whenever a roster hero's level, class, ranks or gear (uids, polish, affix
// arrays) changes: stash offers already rejected by the same roster need no second look.
function rosterVersion(state) {
  let v = state.heroes.length;
  for (const h of state.heroes) {
    v = (Math.imul(v, 31) + h.id * 7 + h.L * 131 + h.cls) | 0;
    for (const r of h.sp || []) v = (Math.imul(v, 17) + r) | 0;
    for (const it of h.eq || []) v = (Math.imul(v, 31) + (it ? it.uid * 13 + it.pol + it.aff.length : 1)) | 0;
  }
  return v;
}

/**
 * How far autopilot polishes an equipped item: the reference kit's polish for the wearer's level
 * (D§5.2: P_ref = 1 + 0.005 L, p = L / 10, rounded up), at most the rarity's max. balance: D§8.8
 * polishes everything to the rarity's max (gold is never short, so every worn item sat at +7..+10
 * by Lv 25 and autopilot gear ran 1.4-2x the reference kit); see docs/BALANCE.md.
 */
export function polishTarget(hero, item) {
  return Math.min(polishMax(item.rar), Math.ceil((hero.L || 1) / 10));
}

/**
 * Autopilot polish (D§8.8): one equipped item of one hero per pass, round-robin over the roster,
 * lowest polish first, when gold >= 5x and Snippets >= 2x its cost (never below a 20% reserve).
 */
export function autoPolish(world) {
  const { state, rt } = world;
  const n = state.heroes.length;
  if (!n) return null;
  const start = (rt.apPolish || 0) % n;
  rt.apPolish = start + 1;
  for (let k = 0; k < n; k++) {
    const hero = state.heroes[(start + k) % n];
    let pick = null;
    for (const it of hero.eq) {
      if (!it || it.pol >= polishTarget(hero, it)) continue;
      if (!pick || it.pol < pick.pol) pick = it;
    }
    if (!pick) continue;
    if (!autoPolishOk(state, pick)) return null;
    const r = polish(state, pick.uid);
    if (r.ok) gearChanged(world, hero);
    return r.ok ? { heroId: hero.id, uid: pick.uid } : null;
  }
  return null;
}

/** Autopilot building purchase (D§10.2): the cheapest affordable level with gold >= 3x its cost. */
export function autoBuild(world, ev) {
  const state = world.state;
  const i = autoBuyPick(state);
  if (i < 0) return null;
  const r = buy(state, i);
  if (r.ok && ev) ev.note?.(`Localhost: ${BUILDINGS[i].name} ${buildingLevel(state, i)}`);
  return r.ok ? i : null;
}

// ---------------------------------------------------------------------------------------------
// Bosses and reviews (D§9.5, D§4.5)
// ---------------------------------------------------------------------------------------------

/**
 * The boss API autopilot and world.command use: boss.js, or world.rt.bossApi when set (a test seam:
 * an object with canChallenge / estimate / startFight / stepFight / retreat).
 */
export function bossApi(world) {
  return (world.rt && world.rt.bossApi) || B;
}

function busyHeroes(world) {
  const busy = new Set();
  for (const f of world.rt.fights || []) for (const id of f.heroIds || []) busy.add(id);
  return busy;
}

function isQuesting(live) {
  return !!live && live.state === "questing";
}

/**
 * Participants for a boss fight (D§9.5): up to 6 Questing heroes standing in the zone, highest
 * Power Level first, then (with "Answer calls") Questing heroes elsewhere who already beat this
 * boss and have PL >= the boss level, up to 6 in all.
 */
export function bossParticipants(world, zone, opts = {}) {
  const { state, rt } = world;
  const busy = opts.busy || busyHeroes(world);
  const inZone = [];
  const helpers = [];
  const Lb = BOSSES[zone] ? BOSSES[zone].level : 0;
  for (const [id, live] of rt.live || []) {
    if (busy.has(id) || !isQuesting(live)) continue;
    const hero = heroOf(world, id);
    if (!hero) continue;
    const m = MAP_BY_ID[live.mapId];
    const pl = stats(hero, heroCtx(world, hero)).pl;
    if (m && m.zone === zone) inZone.push([pl, id]);
    else if (opts.calls !== false && hero.cd && hero.cd.boss && hero.cd.boss[zone] != null && pl >= Lb) helpers.push([pl, id]);
  }
  const by = (a, b) => b[0] - a[0] || a[1] - b[1];
  inZone.sort(by);
  helpers.sort(by);
  const max = T.boss.maxParticipants;
  return inZone.concat(helpers).slice(0, max).map((x) => x[1]);
}

// Starts a fight when boss.js allows it and the win estimate clears `threshold`. boss.js's
// canChallenge picks the participants itself (heroIds, helpers) and prices them with helpers
// capped (D§9.5); `ids` (an array, or a function computing it) is the fallback for a boss API
// that does not.
function tryFight(world, ev, kind, idx, ids, threshold) {
  const rt = world.rt;
  const api = bossApi(world);
  if (typeof api.canChallenge !== "function" || typeof api.startFight !== "function") return null;
  try {
    const c = kind === "review" ? api.canChallenge(world, kind, idx, ids[0]) : api.canChallenge(world, kind, idx);
    if (!c || !c.ok) return null;
    let e;
    if (Array.isArray(c.heroIds) && c.heroIds.length) {
      ids = c.heroIds;
      e = c.estimate;
    } else {
      if (typeof ids === "function") ids = ids();
      if (!ids.length) return null;
      e = typeof api.estimate === "function" ? api.estimate(world, kind, idx, ids) : c.estimate;
    }
    if (!(e >= threshold)) return null;
    const f = api.startFight(world, kind, idx, ids, ev);
    if (f && !rt.fights.includes(f)) rt.fights.push(f);
    return f || null;
  } catch (e) {
    errorOf(world, `autopilot ${kind} ${idx}`, e);
    return null;
  }
}

/**
 * Boss and review challenges (D§9.5, D§4.5): the frontier boss when its door is open and the win
 * estimate >= 1.0 ("Auto-boss"); beaten bosses when >= 1.5 ("Farm bosses"); a cleared Backlog
 * boss floor when >= 1.0 ("Auto-boss", D§9.8); a Questing hero's
 * Senior / Staff Review when >= 1.0 ("career"). One boss fight at a time; heroes already
 * fighting are left alone.
 */
export function autoChallenge(world, ev, auto = autoCfg(world.state)) {
  const { state, rt } = world;
  if (!rt.fights) rt.fights = [];
  const herd = state.herd;
  const started = [];
  // One boss fight at a time. A paused fight (herd.fight) waits for someone to work in its zone
  // again (world.tick resumes it, D§9.5); starting another boss would make boss.js close it as a
  // Postmortem, so only the frontier boss may displace a paused repeat (farm) fight, and a paused
  // frontier or Backlog fight blocks everything else.
  const paused = herd.fight;
  const pausedFarm = !!paused && paused.k === "b" && herd.boss[paused.i] > 0;
  const bossFight = rt.fights.some((f) => f.kind !== "review") || (!!paused && !pausedFarm);
  if (!bossFight) {
    const z = herd.zone || 0;
    if (auto.boss && z < ZONES.length && !(herd.boss[z] > 0) && doorOpen(state, z)) {
      const f = tryFight(world, ev, "boss", z, () => bossParticipants(world, z, { calls: auto.calls }), T.boss.autoAt);
      if (f) started.push(f);
    }
    if (!started.length && auto.farm && !paused) {
      for (let k = Math.min(z, ZONES.length - 1); k >= 0; k--) {
        if (!(herd.boss[k] > 0)) continue;
        const f = tryFight(world, ev, "boss", k, () => bossParticipants(world, k, { calls: auto.calls }), T.boss.farmAt);
        if (f) { started.push(f); break; }
      }
    }
    // the Backlog (D§9.8): every 10th floor waits for its boss once its 50 kills are in; nothing
    // else starts that fight (boss.js picks the heroes standing in the Backlog)
    const bl = herd.backlog;
    if (!started.length && !paused && auto.boss && bl && bl.floor > 0 && bl.floor % BACKLOG.bossEvery === 0 &&
        (bl.kills || 0) >= BACKLOG.killsPerFloor && backlogOpen(state)) {
      const f = tryFight(world, ev, "backlog", bl.floor, [], T.boss.autoAt);
      if (f) started.push(f);
    }
  }
  if (auto.career) {
    const busy = busyHeroes(world);
    for (const [id, live] of rt.live || []) {
      if (id < 0 || busy.has(id) || !isQuesting(live)) continue;
      const hero = heroOf(world, id);
      if (!hero) continue;
      const rev = hero.rev || [0, 0];
      let idx = -1;
      if (!rev[0] && hero.L >= REVIEWS[0].level) idx = 0;
      else if (rev[0] && !rev[1] && hero.L >= REVIEWS[1].level) idx = 1;
      if (idx < 0) continue;
      const f = tryFight(world, ev, "review", idx, [id], T.boss.autoAt);
      if (f) { started.push(f); busy.add(id); }
    }
  }
  return started;
}

// ---------------------------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------------------------

/**
 * One autopilot pass. Without opts.heroIds (every 60 ticks): auto-learn, a stash sweep chunk, map
 * choice for every live hero, one polish, one building, boss/review challenges. With
 * opts.heroIds (a level, gear or crash change): auto-learn, a full stash sweep and map choice for
 * those heroes only. Every system respects its herd.cfg.auto.* switch; a pinned map is honoured
 * even with map choice off, and a hero without a map always gets one.
 */
export function autopilot(world, ev, opts = {}) {
  const { state, rt } = world;
  const auto = autoCfg(state);
  const ids = opts.heroIds ? new Set(opts.heroIds) : null;
  const busy = busyHeroes(world);

  for (const hero of state.heroes) {
    if (ids && !ids.has(hero.id)) continue;
    if (auto.learn && hero.spFree > 0) autoLearn(hero);
    if (auto.equip && ids) sweepHero(world, hero);
  }
  if (auto.equip && !ids) sweepChunk(world);

  const choices = new Map();
  for (const [id, live] of rt.live || []) {
    if (ids && !ids.has(id)) continue;
    const hero = heroOf(world, id);
    if (!hero || busy.has(id)) continue;
    if (!auto.maps && live.mapId && !(hero.pinMap && hero.pinMap !== live.mapId)) continue;
    moveTo(world, hero, live, chooseMap(world, hero, live, choices));
  }
  if (ids) return;

  if (auto.polish) autoPolish(world);
  if (auto.buildings) autoBuild(world, ev);
  autoChallenge(world, ev, auto);
}
