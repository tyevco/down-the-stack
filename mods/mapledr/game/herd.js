// Account-wide systems (D§10): gold, Seals and the Release Train, the Sprint meter and map
// waypoints (D§9.1), Localhost buildings and their effects (D§10.2), the herd XP bonus (D§10.4),
// the Bug Tracker and its zone perks (D§9.2, D§10.5), trophies, badges (D§10.6), the Hall of Fame
// with Legacy (D§3.4), the journal and the "since you last looked" digest (D§10.7).
//
// The §3.4 contract exports (addGold, addSeals, buy, herdXpBonus, journal, checkBadges,
// bugTrackerKill) keep their signatures; everything else here is a helper other modules read.
// Pure: no host calls, no Date.now(), no Math.random().

import {
  TUNING as T, BUILDINGS, BUILDING_IDX, BUG_TRACKER, ZONES, MAPS, MAP_BY_ID, BADGES, BADGE_BY_ID, BOSSES,
  CLASSES, TROPHY, BACKLOG, RARITIES, KEEPSAKES,
} from "./data.js";
import { buildingCost, releaseOf, releaseSeals, releaseLabel, trackerTier, freshEyesCap } from "./formulas.js";
import { stashPut, itemName } from "./items.js";

const LOG_MAX = 60;
const CAMPFIRE = BUILDING_IDX.campfire;
const COFFEE = BUILDING_IDX.coffee_machine;
const FORGE = BUILDING_IDX.ci_forge;
const DOCS = BUILDING_IDX.docs_library;
const WAR_ROOM = BUILDING_IDX.war_room;
const LEGACY_PER = 0.005; // D§3.4: +0.5% herd XP per retiree
const LEGACY_CAP = 0.1; //   max +10%
const RETIRE_LEVEL = 30;
const DIGEST_AWAY_MS = 30 * 60000; // D§10.7: the dot appears after 30 minutes away
const PAIR_BADGE_SEC = 3600; //       Pair Programmer: 60 working minutes in a shared room

// ---------------------------------------------------------------------------------------------
// Gold, Snippets, journal
// ---------------------------------------------------------------------------------------------

/** Add gold (rounded, never negative). Returns the new total. */
export function addGold(state, n) {
  const herd = state.herd;
  herd.gold = Math.max(0, Math.round((herd.gold || 0) + (Number(n) || 0)));
  return herd.gold;
}

/** Add Snippets (rounded, never negative). Returns the new total. */
export function addSnippets(state, n) {
  const herd = state.herd;
  herd.snip = Math.max(0, Math.round((herd.snip || 0) + (Number(n) || 0)));
  return herd.snip;
}

/**
 * Append a journal line [at, kind, heroId, text, value]; keeps the newest 60 (D§13.3).
 * Kinds used by the engine: ship, level, promo, drop, boss, badge, release, hire, leave, retire,
 * deprecate, zone, map, class.
 */
export function journal(state, kind, heroId, text, value, nowMs) {
  const herd = state.herd;
  if (!herd.log) herd.log = [];
  const log = herd.log;
  log.push([nowMs ?? herd.lastMs ?? 0, String(kind), heroId ?? 0, String(text ?? ""), value ?? 0]);
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
}

// ---------------------------------------------------------------------------------------------
// Release Train (D§10.3) and the Sprint meter (D§9.1)
// ---------------------------------------------------------------------------------------------

/** XP and gold bonus from the Release Train: +0.5% per release, up to r = 60 (+30%). */
export function releaseBonus(state) {
  return T.release.bonusPer * Math.min(T.release.maxRelease, state.herd.rel || 0);
}

/**
 * Release Train numbers for the UI: current release r, its label, cumulative Seals, the Seals
 * the next release needs and progress (0..1) towards it.
 */
export function releaseInfo(state) {
  const herd = state.herd;
  const r = herd.rel || 0;
  const lo = releaseSeals(r);
  const hi = releaseSeals(r + 1);
  const seals = herd.seals || 0;
  return {
    r, label: releaseLabel(r), seals, next: hi, prev: lo,
    progress: hi > lo ? Math.max(0, Math.min(1, (seals - lo) / (hi - lo))) : 1,
    bonus: releaseBonus(state), capped: r >= T.release.maxRelease,
  };
}

/** Sprint meter target (Seals) of a zone index; 0 for the Backlog or beyond. */
export function sprintTarget(zone) {
  return zone >= 0 && zone < T.sprint.length ? T.sprint[zone] : 0;
}

/**
 * Credit Seals (from opened chests): the Release Train (D§10.3) and the frontier zone's Sprint
 * meter (D§9.1). Seals beyond the meter's target bank, up to the next zone's target, and pour in
 * when that zone opens (pourBank). Emits a header note per release and a journal line on major
 * versions (vX.0). Returns the number of releases shipped.
 */
export function addSeals(world, n, ev) {
  const state = world.state || world;
  const herd = state.herd;
  const add = Math.max(0, Number(n) || 0);
  if (!add) return 0;
  const before = herd.rel || 0;
  herd.seals = (herd.seals || 0) + add;
  herd.rel = releaseOf(herd.seals);

  // Sprint meter of the frontier zone; overflow banks (capped at the next zone's target)
  const target = sprintTarget(herd.zone);
  if (target > 0) {
    const meter = herd.meter || 0;
    const room = Math.max(0, target - meter);
    const into = Math.min(room, add);
    herd.meter = meter + into;
    const over = add - into;
    if (over > 0) herd.bank = Math.min(sprintTarget(herd.zone + 1), (herd.bank || 0) + over);
  }

  const shipped = herd.rel - before;
  if (shipped > 0 && ev) {
    const label = releaseLabel(herd.rel);
    ev.note?.(`Release ${label} shipped`);
    if (Math.floor(herd.rel / 10) > Math.floor(before / 10)) {
      ev.journal?.("release", 0, `Release ${label}`, herd.rel);
      ev.major?.();
    }
  }
  return shipped;
}

/**
 * Moves banked Seals into a freshly opened frontier zone's meter (D§9.1 "pours in when that zone
 * opens"). Idempotent: does nothing while the bank is empty.
 */
export function pourBank(state) {
  const herd = state.herd;
  const bank = herd.bank || 0;
  if (!(bank > 0)) return 0;
  const target = sprintTarget(herd.zone);
  const into = target > 0 ? Math.min(bank, Math.max(0, target - (herd.meter || 0))) : 0;
  herd.meter = (herd.meter || 0) + into;
  herd.bank = 0; // the bank only ever holds the next zone's share
  return into;
}

// ---------------------------------------------------------------------------------------------
// Map waypoints and the boss door (D§9.1)
// ---------------------------------------------------------------------------------------------

/** Kills a map needs before the next map of its zone opens (40). */
export function quotaNeed() {
  return T.quotaPerMap;
}

/**
 * Is a map open for the herd? Map 1-1 is open at start; map j > 1 of a zone opens after 40 herd
 * kills on map j - 1; map 1 of zone k + 1 opens with the herd's first kill of zone k's boss (the
 * frontier zone index herd.zone). "backlog" opens after the Heisenbug.
 */
export function mapUnlocked(state, mapOrId) {
  const herd = state.herd;
  if (mapOrId === "backlog" || (mapOrId && mapOrId.id === "backlog")) return backlogOpen(state);
  const m = typeof mapOrId === "string" ? MAP_BY_ID[mapOrId] : mapOrId;
  if (!m) return false;
  const frontier = Math.min(herd.zone || 0, ZONES.length - 1);
  if (m.zone > frontier) return false;
  if (m.idx === 0) return true;
  const prev = MAPS[m.n - 1];
  if (((herd.quota || {})[prev.id] || 0) >= T.quotaPerMap) return true;
  // zones behind the frontier (the Backlog counts as zone 9) were cleared: all their maps are open
  return m.zone < (herd.zone || 0) && (herd.boss || [])[m.zone] > 0;
}

/** Every open map, shallowest first. */
export function unlockedMaps(state) {
  return MAPS.filter((m) => mapUnlocked(state, m));
}

/** The Backlog opens after the herd's first Heisenbug kill (D§9.8). */
export function backlogOpen(state) {
  const herd = state.herd;
  return (herd.zone || 0) >= BACKLOG.n || ((herd.boss || [])[BOSSES.length - 1] || 0) > 0;
}

/**
 * Is a zone's boss door open? The zone's last map has its 40 kills and its Sprint meter is full
 * (frontier zone), or the boss has already been beaten (repeat kills need no meter).
 */
export function doorOpen(state, zone) {
  const herd = state.herd;
  if (!(zone >= 0 && zone < ZONES.length)) return false;
  if (((herd.boss || [])[zone] || 0) > 0) return true;
  if (zone !== (herd.zone || 0)) return false;
  const last = ZONES[zone].maps[ZONES[zone].maps.length - 1];
  return ((herd.quota || {})[last.id] || 0) >= T.quotaPerMap && (herd.meter || 0) >= sprintTarget(zone) - 1e-9;
}

// ---------------------------------------------------------------------------------------------
// Localhost buildings (D§10.2)
// ---------------------------------------------------------------------------------------------

function bIndex(b) {
  if (typeof b === "number") return b;
  const i = BUILDING_IDX[b];
  return i == null ? -1 : i;
}

/** Current level of a building (index or id). */
export function buildingLevel(state, b) {
  return ((state.herd.bld || [])[bIndex(b)] || 0);
}

/** Gold cost of the next level of a building, or null at max. */
export function nextBuildingCost(state, b) {
  const i = bIndex(b);
  const def = BUILDINGS[i];
  if (!def) return null;
  const lvl = buildingLevel(state, i);
  return lvl >= def.max ? null : buildingCost(def, lvl + 1);
}

/** Buy one level of building bIdx (index or id). Returns {ok, cost, level?, error?}. */
export function buy(state, bIdx) {
  const i = bIndex(bIdx);
  const def = BUILDINGS[i];
  if (!def) return { ok: false, error: "Unknown building" };
  if (!state.herd.bld) state.herd.bld = new Array(BUILDINGS.length).fill(0);
  const lvl = state.herd.bld[i] || 0;
  if (lvl >= def.max) return { ok: false, error: "Max level" };
  const cost = buildingCost(def, lvl + 1);
  if ((state.herd.gold || 0) < cost) return { ok: false, cost, error: "Not enough gold" };
  state.herd.gold -= cost;
  state.herd.bld[i] = lvl + 1;
  return { ok: true, cost, level: lvl + 1 };
}

/**
 * The building autopilot would buy now (D§10.2): the cheapest next level with gold >= 3x its cost
 * that keeps a 20% gold reserve. Returns the index or -1.
 */
export function autoBuyPick(state) {
  const gold = state.herd.gold || 0;
  let best = -1;
  let bestCost = Infinity;
  for (let i = 0; i < BUILDINGS.length; i++) {
    const c = nextBuildingCost(state, i);
    if (c == null || c >= bestCost) continue;
    if (gold < T.buildingAutoBuyAt * c || gold - c < T.goldReserve * gold) continue;
    best = i;
    bestCost = c;
  }
  return best;
}

/** Fresh Eyes cap in minutes: 60 + 15 x Campfire level (60 -> 210). */
export function freshEyesCapMin(state) {
  return freshEyesCap(buildingLevel(state, CAMPFIRE));
}

/** Coffee heal bonus from the Coffee Machine: +3% max HP per level (heroes.stats applies it too). */
export function coffeeHealBonus(state) {
  return BUILDINGS[COFFEE].perLevel.coffeeHeal * buildingLevel(state, COFFEE);
}

/** Coffee price multiplier: 1 - 5% per Coffee Machine level. */
export function coffeePriceMult(state) {
  return 1 + BUILDINGS[COFFEE].perLevel.coffeePrice * buildingLevel(state, COFFEE);
}

/** Polish gold discount from the CI Forge: 4% per level (items.polish applies it). */
export function polishDiscount(state) {
  return -BUILDINGS[FORGE].perLevel.polishGold * buildingLevel(state, FORGE);
}

/** Does the CI Forge unlock this feature ("squashMerge" at 3, "reroll" at 5)? */
export function forgeUnlocked(state, feature) {
  const u = BUILDINGS[FORGE].unlocks;
  for (const k of Object.keys(u)) if (u[k] === feature) return buildingLevel(state, FORGE) >= Number(k);
  return false;
}

/** Extra boss and review timer ticks from the War Room: +6 per level. */
export function warRoomTicks(state) {
  return BUILDINGS[WAR_ROOM].perLevel.bossTimerTicks * buildingLevel(state, WAR_ROOM);
}

/** Herd XP from the Docs Library: +2% per level. */
export function docsLibraryXp(state) {
  return BUILDINGS[DOCS].perLevel.herdXp * buildingLevel(state, DOCS);
}

// ---------------------------------------------------------------------------------------------
// Bug Tracker (D§10.5) and zone perks (D§9.2)
// ---------------------------------------------------------------------------------------------

/** Count a kill in the zone's Bug Tracker (elites x4). Returns the zone's tier (0..3). */
export function bugTrackerKill(state, zone, elite) {
  const herd = state.herd;
  if (!herd.bt) herd.bt = new Array(ZONES.length).fill(0);
  const bt = herd.bt;
  if (!(zone >= 0 && zone < ZONES.length)) return 0;
  bt[zone] = (bt[zone] || 0) + (elite ? BUG_TRACKER.eliteWeight : 1);
  return trackerTier(bt[zone]);
}

/** Bug Tracker tier of a zone: 0 none, 1 Triaged, 2 Reproduced, 3 Fixed. */
export function zoneTier(state, zone) {
  return trackerTier(((state.herd.bt || [])[zone]) || 0);
}

/**
 * A zone's Bug Tracker perk at its current tier (D§9.2: the perk applies x1, x2, x3).
 * @returns {{tier:number, tierName:string|null, kills:number, next:number|null, perk:object}}
 *   perk holds the scaled values, e.g. {xp: 0.04} for Lint Meadows at Reproduced.
 */
export function zonePerk(state, zone) {
  const z = ZONES[zone];
  const kills = ((state.herd.bt || [])[zone]) || 0;
  const tier = trackerTier(kills);
  const perk = {};
  if (z) for (const k of Object.keys(z.perk)) perk[k] = z.perk[k] * tier;
  const tiers = BUG_TRACKER.tiers;
  return {
    tier, tierName: tier > 0 ? tiers[tier - 1].name : null, kills,
    next: tier < tiers.length ? tiers[tier].kills : null, perk,
  };
}

// ---------------------------------------------------------------------------------------------
// Trophies, Legacy, herd XP (D§10.4, D§10.5, D§3.4)
// ---------------------------------------------------------------------------------------------

/** Number of bosses the herd has beaten at least once (each is a trophy). */
export function trophies(state) {
  let n = 0;
  for (const x of state.herd.boss || []) if (x) n++;
  return n;
}

/** Trophy bonus for every hero: +1% damage and +1% max HP per trophy (heroes.stats applies it). */
export function trophyBonus(state) {
  const n = trophies(state);
  return { dmg: TROPHY.dmg * n, hpPct: TROPHY.hpPct * n, count: n };
}

/** Legacy: +0.5% herd XP per Hall of Fame entry, max +10%. */
export function legacyBonus(state) {
  return Math.min(LEGACY_CAP, LEGACY_PER * ((state.herd.fame || []).length));
}

/**
 * The parts of the herd XP bonus (D§10.4): Release Train (<= 30%), Docs Library (<= 20%), Lint
 * Meadows tracker perk (<= 6%) and Legacy (<= 10%), with the total capped at +60%.
 */
export function herdXpParts(state) {
  const release = releaseBonus(state);
  const docs = docsLibraryXp(state);
  let tracker = 0;
  for (let z = 0; z < ZONES.length; z++) tracker += zonePerk(state, z).perk.xp || 0;
  const legacy = legacyBonus(state);
  const raw = release + docs + tracker + legacy;
  return { release, docs, tracker, legacy, raw, total: Math.min(T.herdXpCap, raw), capped: raw > T.herdXpCap };
}

/** Herd XP bonus as a fraction (D§10.4), capped at +60%. */
export function herdXpBonus(state) {
  return herdXpParts(state).total;
}

/** Highest level on the roster. */
export function topLevel(state) {
  let top = 1;
  for (const h of state.heroes || []) if (h.L > top) top = h.L;
  return top;
}

/**
 * Onboarding (D§3.4): +50% XP (additive, outside the herd cap) while the hero's level is at most
 * the herd's top level - 10 (the "new hire lanyard").
 */
export function onboardingBonus(state, hero) {
  return hero && hero.L <= topLevel(state) - T.onboarding.levelsBehind ? T.onboarding.xp : 0;
}

// ---------------------------------------------------------------------------------------------
// Badges (D§10.6)
// ---------------------------------------------------------------------------------------------

/** Has the herd earned this badge? */
export function hasBadge(state, id) {
  return (state.herd.badges || []).includes(id);
}

/**
 * Awards a badge once (journal line, header note, major event). Unknown ids are ignored.
 * @returns {boolean} true when newly awarded
 */
export function awardBadge(world, id, ev) {
  const state = world.state || world;
  const def = BADGE_BY_ID[id];
  if (!def || hasBadge(state, id)) return false;
  if (!state.herd.badges) state.herd.badges = [];
  state.herd.badges.push(id);
  if (ev) {
    ev.note?.(`Badge: ${def.name}`);
    ev.journal?.("badge", 0, def.name, BADGES.indexOf(def));
    ev.major?.();
  } else {
    journal(state, "badge", 0, def.name, BADGES.indexOf(def));
  }
  return true;
}

function sumHeroStat(state, key) {
  let n = 0;
  for (const h of state.heroes || []) n += (h.st && h.st[key]) || 0;
  return n;
}

/**
 * Awards every badge whose condition now holds (D§10.6). State-derived conditions are checked
 * here; two need a moment and are awarded where it happens: Read-Only Friday (world.js, on a
 * Friday Deploy kill on a local Friday) and First Commit (agents.openChests; also derived here
 * from the journal). Live conditions read world.rt (Thundering Herd: 8 heroes working at once).
 * Cheap enough to run every tick. Returns the ids awarded now.
 */
export function checkBadges(world, ev) {
  const state = world.state || world;
  const herd = state.herd;
  const rt = world.rt || null;
  const got = [];
  const award = (id) => { if (awardBadge(world, id, ev)) got.push(id); };
  const has = (id) => hasBadge(state, id);

  if (!has("hello_world") && (sumHeroStat(state, "kills") > 0 || (herd.bt || []).some((k) => k > 0))) award("hello_world");
  if (!has("first_commit") && (herd.log || []).some((e) => e[1] === "ship")) award("first_commit");
  if (!has("not_found") && sumHeroStat(state, "dodges") >= 1000) award("not_found");
  if (!has("duck_whisperer") && sumHeroStat(state, "healed") >= 10000) award("duck_whisperer");
  if (!has("pair_programmer") && (herd.pairSec || 0) >= PAIR_BADGE_SEC) award("pair_programmer");
  if (!has("thundering_herd") && rt && rt.live) {
    let working = 0;
    for (const live of rt.live.values()) if (live.status === "working") working++;
    if (working >= 8) award("thundering_herd");
  }
  if (!has("fully_staffed")) {
    const seen = new Set();
    for (const h of state.heroes || []) if (h.cls > 0 && h.L >= 10) seen.add(h.cls);
    if (seen.size >= CLASSES.length - 1) award("fully_staffed");
  }
  if (!has("zero_warnings") && ((herd.boss || [])[0] || 0) > 0) award("zero_warnings");
  if (!has("works_when_i_dont_look") && ((herd.boss || [])[8] || 0) > 0) award("works_when_i_dont_look");
  if (!has("ten_thousand_typos") && zoneTier(state, 0) >= BUG_TRACKER.tiers.length) award("ten_thousand_typos");
  if (!has("principal_engineer") && (state.heroes || []).some((h) => h.L >= T.levelCap)) award("principal_engineer");
  if (!has("deep_backlog") && ((herd.backlog && herd.backlog.floor) || 0) >= BACKLOG.badgeFloor) award("deep_backlog");
  if (!has("lucky_duck") && ((herd.ducks || 0) > 0 || sumHeroStat(state, "ducks") > 0)) award("lucky_duck");
  return got;
}

/**
 * Records a Holo Rubber Duck kill (Lucky Duck badge). combat.js may call this; checkBadges also
 * reads herd.ducks / hero.st.ducks.
 */
export function noteDuck(world, ev) {
  const state = world.state || world;
  state.herd.ducks = (state.herd.ducks || 0) + 1;
  return awardBadge(world, "lucky_duck", ev);
}

/** Badge list for the Herd panel: [{id, name, earned}]. */
export function badgeList(state) {
  return BADGES.map((b) => ({ id: b.id, name: b.name, earned: hasBadge(state, b.id) }));
}

// ---------------------------------------------------------------------------------------------
// Hall of Fame and retirement (D§3.4, D§10.7)
// ---------------------------------------------------------------------------------------------

/**
 * Retires a roster hero of Lv 30+ to the Hall of Fame ([name, class, level, dateMs]); its gear
 * moves to the stash (a full stash deprecates its lowest-IP unlocked item, D§8.8). The caller
 * (world.command) unbinds the hero's terminal and credits its pending chests first.
 * @returns {{ok:boolean, error?:string, entry?:Array}}
 */
export function retire(world, heroId, nowMs, ev) {
  const state = world.state || world;
  const idx = (state.heroes || []).findIndex((h) => h.id === heroId);
  if (idx < 0) return { ok: false, error: "No such hero" };
  const hero = state.heroes[idx];
  if (hero.L < RETIRE_LEVEL) return { ok: false, error: `Retirement needs Lv ${RETIRE_LEVEL}` };
  state.heroes.splice(idx, 1);
  for (let s = 0; s < (hero.eq || []).length; s++) {
    const it = hero.eq[s];
    if (!it) continue;
    hero.eq[s] = null;
    if (it.base === 0 && it.rar === 0) continue; // the starter Training Stick is not worth a slot
    stashPut(state, it);
  }
  if (!state.herd.fame) state.herd.fame = [];
  const entry = [hero.name, hero.cls, hero.L, nowMs ?? state.herd.lastMs ?? 0];
  state.herd.fame.push(entry);
  const msg = `${hero.name} retired to the Hall of Fame`;
  if (ev) {
    ev.journal?.("retire", hero.id, hero.name, hero.L);
    ev.note?.(msg);
    ev.major?.();
  } else {
    journal(state, "retire", hero.id, hero.name, hero.L, nowMs);
  }
  return { ok: true, entry, msg };
}

/** Hall of Fame rows for the UI: [{name, clsId, clsName, level, at}], newest first. */
export function hallOfFame(state) {
  return (state.herd.fame || []).map((e) => {
    const c = CLASSES[e[1]] || CLASSES[0];
    return { name: String(e[0]), clsId: c.id, clsName: c.name, level: e[2] || 1, at: e[3] || 0 };
  }).reverse();
}

// ---------------------------------------------------------------------------------------------
// Digest: "since you last looked" (D§10.7)
// ---------------------------------------------------------------------------------------------

/** Should the Herd button show its dot? (rt.digestDot is set by world.js after 30 min away.) */
export function digestDot(world) {
  return !!(world && world.rt && world.rt.digestDot);
}

/** Minimum time away before the digest dot appears (ms). */
export const DIGEST_AWAY = DIGEST_AWAY_MS;

/**
 * The Digest tab's data: what happened since herd.digestAt (the last time the person opened it):
 * levels gained, Release-or-better drops, bosses beaten, chests shipped, plus chests waiting now.
 * @returns {{since:number, levels:Array, drops:Array, bosses:Array, shipped:Array, badges:Array,
 *            chestsWaiting:number, sealsWaiting:number, empty:boolean}}
 */
export function digest(state, sinceMs) {
  const herd = state.herd;
  const since = sinceMs ?? herd.digestAt ?? 0;
  const out = { since, levels: [], drops: [], bosses: [], shipped: [], badges: [], chestsWaiting: 0, sealsWaiting: 0, empty: true };
  const byHero = new Map((state.heroes || []).map((h) => [h.id, h]));
  // levels: one row per hero (the highest level reached since)
  const lv = new Map();
  for (const e of herd.log || []) {
    if (!(e[0] > since)) continue;
    const [at, kind, heroId, text, value] = e;
    const name = byHero.has(heroId) ? byHero.get(heroId).name : null;
    if (kind === "level") lv.set(heroId, { heroId, name, level: value, at });
    else if (kind === "drop") out.drops.push({ heroId, name, text, rar: value, at });
    else if (kind === "boss") out.bosses.push({ text, value, at });
    else if (kind === "ship") out.shipped.push({ heroId, name, text, seals: value, at });
    else if (kind === "badge") out.badges.push({ text, at });
  }
  out.levels = Array.from(lv.values());
  for (const h of state.heroes || []) {
    for (const p of h.pend || []) {
      out.chestsWaiting++;
      // pending minutes are capped per task when the chest drops (agents.chestRaw)
      out.sealsWaiting += p.min >= T.seals.minMinutes ? p.min * T.seals.perMinute * (p.sealFactor ?? 1) : 0;
    }
  }
  out.empty = !out.levels.length && !out.drops.length && !out.bosses.length && !out.shipped.length && !out.badges.length && !out.chestsWaiting;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------------------------

/** Is a drop worth a journal line / header note (Release or better, D§11.15)? */
export function notableDrop(item) {
  return !!item && item.rar >= 3;
}

/** Journal + note for a notable drop (Release, LTS, Keepsake). */
export function logDrop(world, hero, item, ev) {
  if (!notableDrop(item)) return;
  const r = RARITIES[item.rar] || RARITIES[0];
  const name = itemName(item);
  if (ev) {
    ev.journal?.("drop", hero ? hero.id : 0, name, item.rar);
    ev.note?.(`${r.name}: ${name}`, r.color);
    if (item.rar >= 4) {
      ev.fx?.("pillar", { heroId: hero ? hero.id : undefined, text: r.name, rar: item.rar, value: item.uid });
      ev.major?.();
    }
  } else {
    journal(world.state || world, "drop", hero ? hero.id : 0, name, item.rar);
  }
}

/** Keepsake ids the herd owns (stash or equipped). */
export function keepsakesOwned(state) {
  const out = new Set();
  const look = (it) => { if (it && it.rar === 5 && KEEPSAKES[it.prop]) out.add(KEEPSAKES[it.prop].id); };
  for (const it of state.herd.stash || []) look(it);
  for (const h of state.heroes || []) for (const it of h.eq || []) look(it);
  return out;
}
