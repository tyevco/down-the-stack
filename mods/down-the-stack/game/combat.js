// Combat (D§5.4-5.6, D§7, D§9.1, D§9.4, D§9.7, D§9.8, D§11.3, D§11.7): rooms and slots, lanes,
// spawns, the per-class rotation and every skill effect type (hit, proc, stacks, buff, summon,
// aura, healOrHit, roomRestore), the 14 mob traits, coffee and crashes, kill rewards (XP, gold,
// Snippets, drops, Bug Tracker, map quotas, the Backlog) and fx emission.
//
// Contract exports (ARCHITECTURE §3.4): buildRooms, stepRoom, restTick. The rest is a small
// internal API shared with boss.js (actors, the rotation, hero damage and upkeep) plus helpers for
// other modules (heroCtx, unblockedTicks, heroMapId, findHero).
//
// Clocks. Every hero has its own combat clock live.ct (ticks it spent Questing or Supervising, in
// a lane or a fight). Cooldowns (live.cds), buffs (live.buffs[].until, exclusive), coffee
// (live.lastCupTick) and every mob timer (arriveTick, swingTick) are in that hero's ct, so a
// Waiting hero is frozen for free (D§2.2): nothing advances its clock. The one exception is
// live.crashedUntil, in world ticks (rt.tick) so agents/view can read it: a hero is down while
// live.crashedUntil > 0 (reset to 0 when it reboots). live.state "crashed" counts as Questing.
// Live fields added here (runtime only): ct, _act, _sctx, _arena, _laneMap, refill, rollbackCt,
// advanceTick, floor?, dropMap, tally.
//
// Fx (ARCHITECTURE §5): every number is merged per hero and tick to at most two outgoing numbers
// (the action, then everything else: procs, summons, Forklings) plus one incoming number (or a
// "404" dodge); misses ("404") and invulnerable hits ("403") show only when the action dealt
// nothing. Room (6) and stage (12) number budgets are left to the tick's emitter (D§11.7).
// Every fx carries heroId and roomId; hits carry mobUid (a lane mob uid, or a boss part uid).
//
// Pure: RNG only through rng.js holders (the hero's own RNG), no Date.now(), no host calls.

import {
  TUNING as T, CLASS_IDX, CLASS_BY_ID, MAPS, MAP_BY_ID, MOB_BY_ID, MOBS, TRAITS, ELITE, BACKLOG, ZONES, SKILL_BY_ID, BUILDING_IDX,
} from "./data.js";
import {
  mobStats, gap, DR, gold as goldOf, itemTier, fmtNum, crowding, partyXp, freshEyesCap, coffeePrice, shiftKillMult,
} from "./formulas.js";
import { rngNext, rngInt, rngPick } from "./rng.js";
import { stats, skillValue, grantXP, effectiveRank } from "./heroes.js";
import { rollItem, killDropChance, offerItem, dropIlvl } from "./items.js";
import * as Herd from "./herd.js";
import * as Auto from "./autopilot.js"; // offerDrop only, looked up at call time (an import cycle is fine)

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const LANE = T.lane.size;
const SWING_DELAY = T.lane.firstSwingDelay || 0; // ticks between the first landed hit and the first swing
const ELITE_P = 1 / T.lane.eliteOneIn;
const DUCK_P = 1 / T.lane.duckOneIn;
const S_MAIN = 0;
const S_AREA = 1;
const S_BUFF = 3;
const S_SIG = 4;
const S_ULT = 5;
const S_PASSIVE = 2;
const S_CAP = 6;
const RUBBER = CLASS_IDX.rubberducker;
const DUCK_AURA = SKILL_BY_ID.rubber_duck_debugging.eff.perRank; // {roomXp, roomDmg}
const SAFETY_AURA = SKILL_BY_ID.psychological_safety.eff; //      {perRank:{roomDr}, rebootFasterTicksPer2Ranks}
const CAMPFIRE = BUILDING_IDX.campfire;
const COFFEE_MACHINE = BUILDING_IDX.coffee_machine;
const BACKLOG_ZONE = BACKLOG.n;

// hit flags
const F_AREA = 1; //    an area hit (Vectorized applies; Heisenbug area multiplier)
const F_CRIT = 2; //    always crits
const F_PRIMARY = 4; // part of the tick's action (first number); else merged into the second
const F_NOPROC = 8; //  no Recursive / Optional Semicolon repeat (the repeat itself)
const F_MAIN = 16; //   a Main attack hit (Bisect stacks apply)
const F_SUMMON = 32; // a summon or Forkling hit (never triggers thorns)

// Shapeshifter pool (D§9.4: any trait but swarm and splitter; copying itself would be a no-op).
const SHIFT_POOL = Object.keys(TRAITS).filter((k) => !TRAITS.shapeshifter.exclude.includes(k) && k !== "shapeshifter");

/** Fx kinds the engine emits (ARCHITECTURE §5 FxVM). */
export const FX = {
  num: "num", crit: "crit", heal: "heal", miss: "miss", inv: "inv", abs: "abs", incoming: "incoming", poof: "poof",
  coin: "coin", loot: "loot", levelup: "levelup", skill: "skill", coffee: "coffee", unblocked: "unblocked",
  stamp: "stamp", pillar: "pillar", ship: "ship",
};

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

/** A roster hero or a Contractor (rt.contractors) by id, or null. */
export function findHero(world, id) {
  const hs = world.state.heroes;
  for (let i = 0; i < hs.length; i++) if (hs[i].id === id) return hs[i];
  const cs = world.rt && world.rt.contractors;
  if (cs) for (const h of cs.values()) if (h.id === id) return h;
  return null;
}

function inRoster(world, hero) {
  const hs = world.state.heroes;
  for (let i = 0; i < hs.length; i++) if (hs[i] === hero) return true;
  return false;
}

/** The map a live hero stands in: live.mapId (autopilot), else its pin, else 1-1. */
export function heroMapId(hero, live) {
  return (live && live.mapId) || (hero && hero.pinMap) || "1-1";
}

function zoneOfMap(mapId) {
  if (mapId === "backlog") return BACKLOG_ZONE;
  const m = MAP_BY_ID[mapId];
  return m ? m.zone : 0;
}

// Per-map spawn tables as parallel arrays (rngPick on an array returns an index; no key lists).
const spawnCache = new Map();
function spawnTable(map) {
  let s = spawnCache.get(map.id);
  if (!s) {
    const ids = Object.keys(map.spawn);
    s = { ids, w: ids.map((k) => map.spawn[k]) };
    spawnCache.set(map.id, s);
  }
  return s;
}

/**
 * The stats ctx combat uses for a hero (ARCHITECTURE §3.4 heroes.stats ctx). Other modules that
 * price a live hero (view, autopilot) should pass this same object so heroes.stats keeps one cache
 * entry per hero instead of thrashing between contexts. Off-stage heroes get {herd}.
 */
export function heroCtx(world, hero) {
  const live = world.rt && world.rt.live ? world.rt.live.get(hero.id) : null;
  return (live && live._sctx) || { herd: world.state.herd };
}

/**
 * Unblocked duration for a hero (D§2.6): 120 Questing ticks, x2 when a Rubberducker stands in its
 * room (Good Listener, D§4.3), +60 with a Rubber-Stamped sticker (D§8.4). agents.js grants
 * Unblocked as a buff on the hero's combat clock: addBuff(live, "unblocked", unblockedTicks(...)).
 */
export function unblockedTicks(world, hero) {
  let ticks = T.unblocked.ticks;
  const rooms = (world.rt && world.rt.rooms) || [];
  for (const room of rooms) {
    if (!room.heroIds.includes(hero.id)) continue;
    for (const id of room.heroIds) {
      const h = findHero(world, id);
      if (h && h.cls === RUBBER) { ticks *= 2; break; }
    }
    break;
  }
  const st = stats(hero, heroCtx(world, hero));
  if (st.lts.stamp) ticks += st.lts.stamp.unblockedExtraTicks;
  return ticks;
}

/** Adds (or refreshes) a timed buff on a live hero; `ticks` counts the hero's combat clock. */
export function addBuff(live, id, ticks, fields) {
  const until = (live.ct || 0) + ticks;
  const list = live.buffs || (live.buffs = []);
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      const b = list[i];
      b.until = Math.max(b.until, until);
      if (fields) Object.assign(b, fields);
      return b;
    }
  }
  const b = Object.assign({ id, until, dmg: 0, dmgTaken: 0, xp: 0, crit: false, untargetable: false }, fields || {});
  list.push(b);
  return b;
}

/** Does a live hero take combat ticks (Questing, Supervising, or Questing while crashed)? */
export function isActive(live) {
  const s = live.state;
  return s === "questing" || s === "supervising" || s === "crashed";
}

function isQuesting(live) {
  return live.state === "questing" || live.state === "crashed";
}

/** Is a buff active on a live hero? */
export function hasBuff(live, id) {
  const ct = live.ct || 0;
  for (const b of live.buffs || []) if (b.id === id && b.until > ct) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Rooms and slots (D§11.3)
// ---------------------------------------------------------------------------------------------

const ROOM_ENT = [];

/**
 * Slots and rooms (D§11.3). Every live hero has one slot, in herdr's own order: live.order (the
 * snapshot's agent index, set by agents.js), ties and missing orders in rt.live insertion order.
 * Adjacent slots of the same space standing in the same map merge into one room. Rooms are
 * cached: the same array (and Room objects) comes back until a hero is added or removed, changes
 * space or changes map. Room ids are stable while the room's first hero stays.
 * @returns {Array<{id:string, mapId:string, zone:number, heroIds:number[], spaceId:string|null}>}
 */
export function buildRooms(world) {
  const rt = world.rt;
  let n = 0;
  let k = 0;
  for (const [id, live] of rt.live) {
    const e = ROOM_ENT[n] || (ROOM_ENT[n] = { id: 0, live: null, ord: 0, k: 0, map: "" });
    e.id = id;
    e.live = live;
    e.ord = typeof live.order === "number" ? live.order : Infinity;
    e.k = k++;
    e.map = live.mapId || null;
    n++;
  }
  const ents = ROOM_ENT.slice(0, n);
  ents.sort((a, b) => (a.ord - b.ord) || (a.k - b.k));
  let sig = "";
  for (const e of ents) {
    if (!e.map) e.map = heroMapId(findHero(world, e.id), e.live);
    sig += `${e.id}|${e.live.space ?? ""}|${e.map};`;
  }
  const cache = rt._roomCache;
  if (cache && cache.sig === sig) return cache.rooms;
  const rooms = [];
  let cur = null;
  for (const e of ents) {
    const space = e.live.space ?? null;
    if (cur && cur.spaceId === space && cur.mapId === e.map) {
      cur.heroIds.push(e.id);
    } else {
      cur = { id: `room:${space ?? "-"}:${e.map}:${e.id}`, mapId: e.map, zone: zoneOfMap(e.map), heroIds: [e.id], spaceId: space };
      rooms.push(cur);
    }
  }
  rt._roomCache = { sig, rooms };
  return rooms;
}

/**
 * A hero changes id (a Contractor promoted to the roster, agents.promote): its rooms (heroIds, and a
 * room id named after it as the room's first hero) keep their objects and cached signature, so the
 * lanes carry on; its effects, the actors' room ids and this tick's fight participants follow it.
 * world.js's heroId -> room index (rt.roomOf) is dropped and rebuilt from rt.rooms.
 */
export function renameHero(world, from, to) {
  const rt = world.rt;
  const tail = `:${from}`;
  const roomIds = new Map();
  const rename = (rooms) => {
    for (const room of rooms || []) {
      const ids = room.heroIds || [];
      for (let i = 0; i < ids.length; i++) if (ids[i] === from) ids[i] = to;
      if (typeof room.id === "string" && room.id.endsWith(tail)) {
        const id = `${room.id.slice(0, room.id.length - tail.length)}:${to}`;
        roomIds.set(room.id, id);
        room.id = id;
      }
    }
  };
  rename(rt.rooms);
  const cache = rt._roomCache;
  if (cache) {
    if (cache.rooms !== rt.rooms) rename(cache.rooms);
    const head = `${from}|`;
    cache.sig = String(cache.sig).split(";").map((e) => (e.startsWith(head) ? `${to}|${e.slice(head.length)}` : e)).join(";");
  }
  rt.roomOf = null;
  for (const f of rt.fx || []) {
    if (f.heroId === from) f.heroId = to;
    if (roomIds.has(f.roomId)) f.roomId = roomIds.get(f.roomId);
  }
  for (const live of rt.live ? rt.live.values() : []) {
    const C = live._act;
    if (C && roomIds.has(C.roomId)) C.roomId = roomIds.get(C.roomId);
  }
  const g = rt._cg;
  if (g && g.fighting && g.fighting.delete(from)) g.fighting.add(to);
  if (rt.apGear && rt.apGear.delete(from)) rt.apGear.add(to);
}

// ---------------------------------------------------------------------------------------------
// Per-tick globals (crowding, herd XP, top level, fight participants, boss retry gates)
// ---------------------------------------------------------------------------------------------

function tickGlobals(world) {
  const rt = world.rt;
  let g = rt._cg;
  if (!g) g = rt._cg = { tick: NaN, questing: 0, crowd: 1, herdXp: 0, top: 1, fighting: new Set() };
  if (g.tick === rt.tick) return g;
  g.tick = rt.tick;
  const state = world.state;
  let q = 0;
  for (const live of rt.live.values()) if (isQuesting(live)) q++;
  g.questing = q;
  g.crowd = crowding(q);
  g.herdXp = Herd.herdXpBonus(state);
  let top = 1;
  for (const h of state.heroes) if (h.L > top) top = h.L;
  g.top = top;
  g.fighting.clear();
  for (const f of rt.fights || []) for (const id of f.heroIds) g.fighting.add(id);
  workGates(world);
  return g;
}

/**
 * Postmortem retry gates (D§9.5: retry after 10 more working minutes in the zone; reviews: of the
 * hero). herd.wounds[key] = [woundFrac, untilMs, retrySecLeft]; key = boss index, "bl<floor>" for
 * a Backlog boss floor, or "rv<review>.<heroId>" for a review. Expired wounds are dropped.
 */
function workGates(world) {
  const herd = world.state.herd;
  const w = herd.wounds;
  if (!w) return;
  const keys = Object.keys(w);
  if (!keys.length) return;
  const rt = world.rt;
  for (const key of keys) {
    const e = w[key];
    if (!Array.isArray(e)) continue;
    if (e[1] > 0 && rt.nowMs >= e[1] && !(e[2] > 0)) { delete w[key]; continue; }
    if (!(e[2] > 0)) continue;
    let working = false;
    if (key[0] === "r") {
      const heroId = Number(key.slice(key.indexOf(".") + 1));
      const live = rt.live.get(heroId);
      working = !!live && isQuesting(live);
    } else {
      const zone = key[0] === "b" ? BACKLOG_ZONE : Number(key); // "bl<floor>": a Backlog boss floor
      for (const live of rt.live.values()) {
        if (isQuesting(live) && zoneOfMap(live.mapId || "1-1") === zone) { working = true; break; }
      }
    }
    if (working) e[2] = Math.max(0, e[2] - T.tickMs / 1000);
    if (!(e[2] > 0) && e[1] > 0 && rt.nowMs >= e[1]) delete w[key];
  }
}

// ---------------------------------------------------------------------------------------------
// Actors: one reusable scratch record per live hero
// ---------------------------------------------------------------------------------------------

function newActor() {
  return {
    world: null, state: null, rt: null, hero: null, live: null, ev: null, roomId: null, st: null, sv: null,
    arena: null, mates: null, nm: 0, g: null, ct: 0,
    base: 0, dmgPct: 0, extraPct: 0, bossPct: 0, buffDmgTaken: 0, alwaysCrit: false, untargetable: false,
    armorMul: 1, xpPct: 0, buffXp: 0, melee: true, mult: 1, hold: false, capLeft: Infinity, rebootFaster: 0,
    bisectUid: null, bisectPct: 0, lastAmt: 0, lastCrit: false,
    n1amt: 0, n1c: 0, n1crit: false, n1uid: null, n2amt: 0, n2c: 0, n2crit: false, n2uid: null,
    missUid: null, invUid: null, inc: 0, dodged: false, reflect: 0, reflectLvl: 0, dealt: 0, leveled: false, heals: 0,
    skillName: null,
  };
}

/**
 * The reusable actor of a live hero (internal API for boss.js). Resets the per-tick accumulators.
 * @param {string|null} roomId fx roomId ("arena" for fights)
 */
export function actorFor(world, hero, live, ev, roomId) {
  let C = live._act;
  if (!C) C = live._act = newActor();
  C.world = world;
  C.state = world.state;
  C.rt = world.rt;
  C.hero = hero;
  C.live = live;
  C.ev = ev;
  C.roomId = roomId;
  C.g = tickGlobals(world);
  C.n1amt = 0; C.n1c = 0; C.n1crit = false; C.n1uid = null;
  C.n2amt = 0; C.n2c = 0; C.n2crit = false; C.n2uid = null;
  C.missUid = null; C.invUid = null; C.inc = 0; C.dodged = false; C.reflect = 0; C.reflectLvl = 0; C.dealt = 0;
  C.leveled = false; C.heals = 0; C.capLeft = Infinity; C.hold = false; C.mult = 1;
  C.extraPct = 0; C.bossPct = 0; C.skillName = null;
  if (!live.cds) live.cds = {};
  if (!live.buffs) live.buffs = [];
  if (!live.bisect) live.bisect = { target: null, stacks: 0 };
  if (!live.lane) live.lane = [];
  if (!live.crashes) live.crashes = [];
  if (!live.tally) live.tally = { dealt: 0, kills: 0, xp: 0, gold: 0, taken: 0, healed: 0, actions: 0, cups: 0, crashes: 0 };
  if (!(live.ct >= 0)) live.ct = 0;
  if (!hero.st) hero.st = { kills: 0, tasks: 0, seals: 0, wh: 0, dodges: 0, healed: 0 };
  return C;
}

// Rank-resolved skill values per hero, recomputed when its stats object changes.
const skillCache = new WeakMap();
/** The hero's 7 skill values (heroes.skillValue, null for missing slots), cached per stats object. */
export function skillsOf(hero, st) {
  const hit = skillCache.get(hero);
  if (hit && hit.st === st) return hit.sv;
  const sv = [];
  for (let i = 0; i < 7; i++) sv.push(skillValue(hero, i, st));
  skillCache.set(hero, { st, sv });
  return sv;
}

/**
 * Prices an actor for this tick (internal API for boss.js): stats with the room's auras and
 * context, skill values, ΣDmg% from buffs/Unblocked/LTS, XP bonuses, max HP sync.
 * @param {{duck:number, safety:number, allies:number, partyOthers:number, banner:boolean,
 *          forklings?:number}} room room aura ranks and counts
 */
export function prepare(C, room) {
  const { hero, live, state } = C;
  let ctx = live._sctx;
  if (!ctx) ctx = live._sctx = { herd: state.herd, roomBonuses: { dmg: 0, dr: 0, xp: 0 }, roomAllies: 0, freshEyes: false, workingForklings: 0 };
  ctx.herd = state.herd;
  ctx.roomBonuses.dmg = DUCK_AURA.roomDmg * room.duck;
  ctx.roomBonuses.xp = DUCK_AURA.roomXp * room.duck;
  ctx.roomBonuses.dr = SAFETY_AURA.perRank.roomDr * room.safety;
  ctx.roomAllies = room.allies;
  ctx.freshEyes = (hero.fe || 0) > 0;
  ctx.workingForklings = room.forklings ?? workingForklings(live);
  const st = stats(hero, ctx);
  C.st = st;
  C.sv = skillsOf(hero, st);
  C.base = st.weaponDmg * (1 + st.might / 100);
  // melee: thorns prick the hero (D§9.4). Ranged Main attacks are immune, and so is the summoner,
  // whose hits are its imps (summons and Forklings never trigger thorns)
  C.melee = !(C.sv[S_MAIN] && C.sv[S_MAIN].ranged) && !(C.st.clsId && CLASS_BY_ID[C.st.clsId] && CLASS_BY_ID[C.st.clsId].role === "summoner");
  C.rebootFaster = Math.floor(room.safety / 2) * SAFETY_AURA.rebootFasterTicksPer2Ranks;
  syncHp(C);
  scanBuffs(C);
  const g = C.g;
  C.xpPct = st.xpPct + partyXp(room.partyOthers) + (room.banner ? T.party.banner : 0) + C.buffXp + g.herdXp +
    (hero.L <= g.top - T.onboarding.levelsBehind ? T.onboarding.xp : 0);
  return C;
}

function workingForklings(live) {
  const fl = live.forklings;
  if (!fl || !fl.length) return 0;
  let n = 0;
  for (let i = 0; i < fl.length; i++) if (fl[i] && fl[i].status === "working") n++;
  return n;
}

/** Keeps live.hp/maxHp in step with stats (scales HP when max HP changes; first sight: hero.hpFrac). */
export function syncHp(C) {
  const { live, hero, st } = C;
  const max = st.maxHp;
  if (!(live.maxHp > 0)) {
    // first sight: the saved HP fraction (a hero saved while crashed comes back at 50%)
    const frac = hero.hpFrac ?? 1;
    live.maxHp = max;
    live.hp = max * (frac > 0 ? frac : T.crash.returnHp);
  } else if (live.maxHp !== max) {
    live.hp = (live.hp / live.maxHp) * max;
    live.maxHp = max;
  }
  if (!(live.hp <= live.maxHp)) live.hp = live.maxHp;
}

// Sums active buffs (drops expired ones in place) and the per-tick damage modifiers.
function scanBuffs(C) {
  const { live, st } = C;
  const ct = live.ct;
  const list = live.buffs;
  let dmg = 0;
  let taken = 0;
  let xp = 0;
  let crit = false;
  let untargetable = false;
  let j = 0;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!(b.until > ct)) continue;
    list[j++] = b;
    if (b.id === "unblocked") {
      dmg += b.dmg || T.unblocked.dmg;
      xp += b.xp || T.unblocked.xp;
    } else {
      dmg += b.dmg || 0;
      xp += b.xp || 0;
    }
    taken += b.dmgTaken || 0;
    if (b.crit) crit = true;
    if (b.untargetable) untargetable = true;
  }
  list.length = j;
  C.buffXp = xp;
  C.buffDmgTaken = taken;
  C.alwaysCrit = crit;
  C.untargetable = untargetable;
  C.armorMul = 1;
  // Feature-Flagged (D§8.4): +25% damage and +25% armor alternate every 60 ticks
  const flag = st.lts.flag;
  if (flag) {
    if (Math.floor(ct / flag.alternateEveryTicks) % 2 === 0) dmg += flag.dmg;
    else C.armorMul = 1 + flag.armorPct;
  }
  if (st.dmgBelowHalfHp > 0 && live.hp < 0.5 * live.maxHp) dmg += st.dmgBelowHalfHp;
  C.dmgPct = st.dmgPct + dmg + C.extraPct;
}

// ---------------------------------------------------------------------------------------------
// Numbers and fx
// ---------------------------------------------------------------------------------------------

function fx(C, kind, data) {
  const ev = C.ev;
  if (ev && typeof ev.fx === "function") ev.fx(kind, data);
}

function record(C, uid, amt, crit, flags) {
  if (flags & F_PRIMARY) {
    C.n1amt += amt;
    C.n1c++;
    if (crit) C.n1crit = true;
    if (C.n1uid === null) C.n1uid = uid;
  } else {
    C.n2amt += amt;
    C.n2c++;
    if (crit) C.n2crit = true;
    if (C.n2uid === null) C.n2uid = uid;
  }
}

function numText(amt, count) {
  return count > 1 ? `×${count} ${fmtNum(amt)}` : fmtNum(amt);
}

/**
 * Emits the hero's merged numbers for this tick (internal API for boss.js): the action, the rest,
 * then one incoming number (or a dodge "404").
 */
export function flush(C) {
  const heroId = C.hero.id;
  const roomId = C.roomId;
  if (C.n1c > 0) {
    fx(C, C.n1crit ? FX.crit : FX.num, { heroId, mobUid: C.n1uid, roomId, value: C.n1amt, text: numText(C.n1amt, C.n1c), skill: C.skillName });
  } else if (C.missUid !== null) {
    fx(C, FX.miss, { heroId, mobUid: C.missUid, roomId, value: 0, text: "404" });
  } else if (C.invUid !== null) {
    fx(C, FX.inv, { heroId, mobUid: C.invUid, roomId, value: 0, text: "403" });
  }
  if (C.n2c > 0) {
    fx(C, C.n2crit ? FX.crit : FX.num, { heroId, mobUid: C.n2uid, roomId, value: C.n2amt, text: numText(C.n2amt, C.n2c) });
  }
  if (C.inc > 0) fx(C, FX.incoming, { heroId, roomId, value: C.inc, text: fmtNum(C.inc) });
  else if (C.dodged) fx(C, FX.miss, { heroId, roomId, value: 0, text: "404" });
  C.hero.hpFrac = C.live.maxHp > 0 ? Math.max(0, Math.min(1, C.live.hp / C.live.maxHp)) : 1;
}

// ---------------------------------------------------------------------------------------------
// Dealing damage
// ---------------------------------------------------------------------------------------------

// Applies an already rolled amount to one target. Lane targets: phaser misses ("404"), pending
// invulnerability ("403"), thorns. Fight targets: the arena's own modifiers (arena.mod) and
// bookkeeping (arena.after). Returns the HP actually removed.
function apply(C, ent, amt, flags, crit) {
  if (!ent || ent.hp <= 0) return 0;
  const arena = C.arena;
  if (arena.boss) {
    amt = arena.mod(C, ent, amt, flags);
    if (!(amt > 0)) return 0;
  } else {
    const tr = ent.traits;
    const ph = phaserChance(ent);
    if (ph > 0 && rngNext(C.hero) < ph) {
      if (C.missUid === null) C.missUid = ent.uid;
      return 0;
    }
    if (tr.pending > 0) {
      if (C.invUid === null) C.invUid = ent.uid;
      return 0;
    }
  }
  if (amt > C.capLeft) amt = Math.max(0, Math.round(C.capLeft));
  if (!(amt > 0)) return 0;
  const before = ent.hp;
  ent.hp -= amt;
  const dealt = amt < before ? amt : before;
  C.capLeft -= amt;
  C.dealt += dealt;
  C.live.tally.dealt += dealt;
  if (arena.boss) arena.after(C, ent, dealt, flags);
  else {
    if (dealt > 0) ent.hitCt = C.ct; // the swing timer starts on the first hit that lands (laneTick)
    // thorns (D§9.4): the hero's own melee hits only; summons and Forklings never prick themselves
    if (C.melee && !(flags & F_SUMMON) && thornsOf(ent) > 0) {
      C.reflect += dealt * thornsOf(ent);
      if (ent.level > C.reflectLvl) C.reflectLvl = ent.level;
    }
  }
  record(C, ent.uid, amt, crit, flags);
  return dealt;
}

/**
 * Rolls one hit (D§5.4): WeaponDmg (1 + MIGHT/100) coef (1 + ΣDmg%) (crit ? CritMult : 1)
 * U(0.92, 1.08), at least 1, rounded; then applies it. Ten-X Keys, the Uncertainty Lens, Optional
 * Semicolon and Recursive hits are handled here. Returns the HP removed; C.lastAmt holds the roll.
 */
function deal(C, ent, coef, flags) {
  if (!ent || ent.hp <= 0) { C.lastAmt = 0; return 0; }
  const hero = C.hero;
  const st = C.st;
  let pct = C.dmgPct;
  if (flags & F_AREA) pct += st.areaDmg;
  if (C.arena.boss) pct += C.bossPct;
  if ((flags & F_MAIN) !== 0 && C.bisectUid !== null && ent.uid === C.bisectUid) pct += C.bisectPct;
  const crit = (flags & F_CRIT) !== 0 || C.alwaysCrit || rngNext(hero) < st.crit;
  let amt = C.base * coef * (1 + pct) * (crit ? st.critMult : 1) * (0.92 + 0.16 * rngNext(hero)) * C.mult;
  const lens = st.keepsakes.uncertainty_lens;
  if (lens && rngNext(hero) < lens.doubleCountChance) amt *= 2;
  amt = Math.max(1, Math.round(amt));
  C.lastAmt = amt;
  C.lastCrit = crit;
  let dealt = apply(C, ent, amt, flags, crit);
  if (!(flags & F_NOPROC) && dealt > 0) {
    const semi = st.lts.semi;
    if (crit && semi && rngNext(hero) < semi.critRepeatChance) dealt += apply(C, ent, amt, flags | F_NOPROC, true);
    if (st.repeatHit > 0 && rngNext(hero) < st.repeatHit) dealt += apply(C, ent, Math.max(1, Math.round(amt * 0.5)), flags | F_NOPROC, crit);
  }
  return dealt;
}

// ---------------------------------------------------------------------------------------------
// The rotation (D§7.1)
// ---------------------------------------------------------------------------------------------

function ready(live, key, ct) {
  return !(live.cds[key] > ct);
}

// Puts a skill on cooldown (Hot-Reloading: 15% chance it doesn't go on cooldown).
function cooldown(C, key, sk) {
  const reload = C.st.lts.reload;
  if (reload && rngNext(C.hero) < reload.noCooldownChance) return;
  C.live.cds[key] = C.ct + sk.cd;
}

function floatSkill(C, sk) {
  C.skillName = sk.name;
  fx(C, FX.skill, { heroId: C.hero.id, roomId: C.roomId, text: sk.name, value: sk.slotIdx });
}

/**
 * One action of the rotation (internal API for boss.js), against C.arena: buff cast (free), then
 * (1) Ultimate if ready and (boss, >= 2 targets or an elite); (2) a due Signature proc; (3) Area
 * if ready and >= 2 targets (Cherry-Pick any time; Explain It Out Loud heals whenever someone is
 * below 85%); (4) Main. Then free procs: Tab Completion, Async extra action. C.hold holds the
 * Ultimate and Buff (burst window, D§7.1).
 */
export function act(C) {
  const { live, sv, st, arena, hero } = C;
  const ct = C.ct;
  if (!C.hold) castBuff(C);
  live.actionCount = (live.actionCount || 0) + 1;
  live.tally.actions++;
  const ac = live.actionCount;
  const tenx = st.lts.tenx;
  C.mult = tenx && ac % tenx.everyNthAction === 0 ? tenx.dmgMult : 1;
  if (C.mult > 1) fx(C, FX.skill, { heroId: hero.id, roomId: C.roomId, text: "10x", value: 10 });
  const ult = sv[S_ULT];
  const sig = sv[S_SIG];
  const area = sv[S_AREA];
  if (ult && ult.usable && !C.hold && ready(live, "ult", ct) && (arena.boss || arena.count >= 2 || arena.anyElite)) {
    doUlt(C, ult);
  } else if (sig && sig.usable && sig.type === "proc" && ac % sig.everyActions === 0) {
    doProc(C, sig);
  } else if (area && area.usable && ready(live, "area", ct) && areaWanted(C, area)) {
    doArea(C, area);
  } else {
    doMain(C, F_PRIMARY);
  }
  C.mult = 1;
  if (st.freeMainChance > 0 && rngNext(hero) < st.freeMainChance) doMain(C, 0);
  if (st.extraAct > 0 && rngNext(hero) < st.extraAct) doMain(C, 0);
}

function areaWanted(C, area) {
  if (area.anyTime) return C.arena.count >= 1;
  if (area.type === "healOrHit") return !!healTarget(C, area.healBelow) || C.arena.count >= 2;
  return C.arena.count >= 2;
}

function castBuff(C) {
  const { live, sv, ct } = C;
  const b = sv[S_BUFF];
  if (!b || !b.usable || b.type !== "buff" || !ready(live, "buff", ct)) return;
  const self = b.self || {};
  if (!hasBuff(live, b.id)) C.dmgPct += self.dmg || 0;
  addBuff(live, b.id, b.ticks, { dmg: self.dmg || 0, crit: !!self.alwaysCrit, untargetable: !!self.untargetable });
  if (self.alwaysCrit) C.alwaysCrit = true;
  if (self.untargetable) C.untargetable = true;
  if (b.room && b.room.dmgTaken) {
    // Code Review: the room (self included) takes less damage for the buff's duration
    for (let i = 0; i < C.nm; i++) {
      const M = C.mates[i];
      if (!hasBuff(M.live, "code_review_room")) M.buffDmgTaken += b.room.dmgTaken;
      addBuff(M.live, "code_review_room", b.ticks, { dmgTaken: b.room.dmgTaken });
    }
  }
  if (b.ally === "lowestLevel") {
    // Pair Programming: also the lowest-level room ally
    let best = null;
    for (let i = 0; i < C.nm; i++) {
      const M = C.mates[i];
      if (M === C || isDown(M.live)) continue;
      if (!best || M.hero.L < best.hero.L) best = M;
    }
    if (best) {
      if (!hasBuff(best.live, b.id)) best.dmgPct += self.dmg || 0;
      addBuff(best.live, b.id, b.ticks, { dmg: self.dmg || 0 });
    }
  }
  cooldown(C, "buff", b);
}

function doMain(C, flags) {
  const m = C.sv[S_MAIN];
  const tgt = C.arena.main;
  if (!m || !tgt) return;
  const hits = m.hits || 1;
  for (let i = 0; i < hits; i++) deal(C, tgt, m.coef, flags | F_MAIN);
  if (m.bonusHit) deal(C, tgt, m.bonusHit, flags | F_MAIN);
  // Infinite Scroll (D§8.4): the Main attack also hits the next target for 50%
  const scroll = C.st.lts.scroll;
  if (scroll && C.arena.count > 1) {
    const next = nextTarget(C.arena, tgt);
    if (next) deal(C, next, m.coef * hits * scroll.mainHitsNext, flags);
  }
}

function nextTarget(arena, tgt) {
  const list = arena.list;
  for (let i = 0; i < arena.count; i++) if (list[i] !== tgt && list[i].hp > 0) return list[i];
  return null;
}

function doArea(C, sk) {
  const arena = C.arena;
  if (sk.type === "healOrHit") {
    const M = healTarget(C, sk.healBelow);
    if (M) {
      healActor(C, M, sk.heal * M.live.maxHp);
      cooldown(C, "area", sk);
      return;
    }
    hitN(C, sk.coef, (sk.targets || 3) + C.st.areaTargets);
  } else if (sk.targets === "lowestHp") {
    // Cherry-Pick: blink to the lowest-HP target; finishes a non-boss below 15% HP
    let lo = null;
    for (let i = 0; i < arena.count; i++) {
      const e = arena.list[i];
      if (e.hp > 0 && (!lo || e.hp < lo.hp)) lo = e;
    }
    if (!lo) return doMain(C, F_PRIMARY);
    deal(C, lo, sk.coef, F_PRIMARY);
    const canExecute = !arena.boss || lo.kind === "add" || !!sk.executeBoss;
    if (canExecute && lo.hp > 0 && lo.hp < sk.executeBelow * lo.maxHp && !isShielded(C, lo)) {
      apply(C, lo, lo.hp, F_PRIMARY | F_NOPROC, false);
    }
  } else {
    hitN(C, sk.coef, (typeof sk.targets === "number" ? sk.targets : 3) + C.st.areaTargets);
  }
  cooldown(C, "area", sk);
}

function isShielded(C, ent) {
  return C.arena.boss && C.arena.invulnerable ? C.arena.invulnerable(ent) : false;
}

// Hits the first n live targets (front first) as one area action.
function hitN(C, coef, n) {
  const arena = C.arena;
  let k = 0;
  for (let i = 0; i < arena.count && k < n; i++) {
    const e = arena.list[i];
    if (e.hp <= 0) continue;
    deal(C, e, coef, F_AREA | F_PRIMARY);
    k++;
  }
}

function hitAll(C, coef) {
  const arena = C.arena;
  for (let i = 0; i < arena.count; i++) {
    const e = arena.list[i];
    if (e.hp > 0) deal(C, e, coef, F_AREA | F_PRIMARY);
  }
}

function doProc(C, sk) {
  floatSkill(C, sk);
  const arena = C.arena;
  if (sk.targets === "lane") {
    hitAll(C, sk.coef);
    return;
  }
  const tgt = arena.main;
  if (!tgt) return;
  deal(C, tgt, sk.coef, F_PRIMARY);
  const splash = sk.splash || 0;
  if (splash > 0 && C.lastAmt > 0) {
    const amt = Math.max(1, Math.round(C.lastAmt * splash));
    for (let i = 0; i < arena.count; i++) {
      const e = arena.list[i];
      if (e !== tgt && e.hp > 0) apply(C, e, amt, F_AREA | F_PRIMARY, C.lastCrit);
    }
  }
}

function doUlt(C, sk) {
  floatSkill(C, sk);
  const arena = C.arena;
  if (sk.type === "roomRestore") {
    // Retrospective: revive crashed room allies, heal the room fully, room damage buff
    for (let i = 0; i < C.nm; i++) {
      const M = C.mates[i];
      if (M.live.crashedUntil > 0) {
        M.live.crashedUntil = 0;
        M.live.hp = M.live.maxHp;
      }
      const missing = M.live.maxHp - M.live.hp;
      if (missing > 0) healActor(C, M, missing);
      if (!hasBuff(M.live, sk.id)) M.dmgPct += sk.roomDmg;
      addBuff(M.live, sk.id, sk.buffTicks, { dmg: sk.roomDmg });
    }
    cooldown(C, "ult", sk);
    doMain(C, F_PRIMARY);
    return;
  }
  const hits = sk.hits || 1;
  if (sk.targets === "lane") {
    for (let h = 0; h < hits; h++) hitAll(C, sk.coef);
  } else if (sk.targets === "randomLane") {
    for (let h = 0; h < hits; h++) {
      if (!arena.count) break;
      const e = arena.list[rngInt(C.hero, 0, arena.count - 1)];
      deal(C, e, sk.coef, F_AREA | F_PRIMARY);
    }
  } else {
    const tgt = arena.main;
    const fl = F_PRIMARY | (sk.alwaysCrit ? F_CRIT : 0);
    for (let h = 0; h < hits; h++) deal(C, tgt, sk.coef, fl);
  }
  cooldown(C, "ult", sk);
}

/**
 * Free hits that happen every tick while engaged (internal API for boss.js): the Cron Sprite
 * (Daemonize), Ducklings and counted working Forklings, all on the main target. `heroActs` is
 * false on a Supervising hero's off tick (its own summons wait; Forklings still hit).
 */
export function summons(C, heroActs) {
  const { sv, st, live, arena } = C;
  const tgt = arena.main;
  if (!tgt) return;
  const main = sv[S_MAIN];
  const mainCoef = main ? main.coef : 1;
  if (heroActs) {
    const daemon = sv[S_BUFF];
    if (daemon && daemon.usable && daemon.type === "summon") deal(C, tgt, mainCoef * daemon.pctOfMain, F_SUMMON);
    const ducks = sv[S_SIG];
    if (ducks && ducks.usable && ducks.type === "summon") {
      const n = ducks.count || 1;
      for (let i = 0; i < n; i++) deal(C, tgt, mainCoef * ducks.pctOfMain, F_SUMMON);
    }
  }
  const n = Math.min(st.forklingCount, workingForklings(live));
  if (n > 0) deal(C, tgt, n * st.forklingPct * st.mainCoef, F_SUMMON);
}

// ---------------------------------------------------------------------------------------------
// Heals, hero damage, crashes, upkeep
// ---------------------------------------------------------------------------------------------

function isDown(live) {
  return live.crashedUntil > 0;
}

function healTarget(C, below) {
  let best = null;
  let bestFrac = below;
  for (let i = 0; i < C.nm; i++) {
    const M = C.mates[i];
    const l = M.live;
    if (isDown(l) || !(l.maxHp > 0)) continue;
    const f = l.hp / l.maxHp;
    if (f < bestFrac) { best = M; bestFrac = f; }
  }
  return best;
}

/** Heals another actor's hero (green "+N"); counts toward the healer's Rubber Duck Whisperer total. */
export function healActor(C, M, amount) {
  const l = M.live;
  const amt = Math.min(Math.round(amount), Math.max(0, Math.round(l.maxHp - l.hp)));
  if (!(amt > 0)) return 0;
  l.hp += amt;
  C.hero.st.healed = (C.hero.st.healed || 0) + amt;
  C.live.tally.healed += amt;
  fx(C, FX.heal, { heroId: M.hero.id, roomId: C.roomId, value: amt, text: `+${fmtNum(amt)}` });
  return amt;
}

function damageTaken(C, taken) {
  const live = C.live;
  live.hp -= taken;
  C.inc += taken;
  live.tally.taken += taken;
  if (live.hp <= 0) {
    // Rollback (D§8.4): a lethal hit leaves 60% HP instead, once per 120 ticks
    const rb = C.st.lts.rollback;
    if (rb && !(live.rollbackCt > C.ct)) {
      live.hp = rb.lethalLeavesHp * live.maxHp;
      live.rollbackCt = C.ct + rb.cooldownTicks;
      fx(C, FX.skill, { heroId: C.hero.id, roomId: C.roomId, text: "Rollback", value: 0 });
    }
  }
  return taken;
}

/**
 * A swing at the hero (internal API for boss.js; D§5.4 incoming): dodge ("404"), Stealth Commit,
 * DR against the attacker's level (Feature-Flagged armor phase included), room aura and
 * Idempotence. `raw` already holds atk x atkMult x U(0.9, 1.1). Returns the damage taken.
 * `reflect`: a thorns reflection (D§9.4) rolls dodge like a swing, but a dodged reflection is no
 * dodged attack: it neither counts towards 404 Not Found nor heals through Zero Downtime.
 */
export function hitHero(C, raw, level, capFrac, reflect = false) {
  const { live, st, hero } = C;
  if (isDown(live) || !(raw > 0)) return 0;
  if (C.untargetable) { C.dodged = true; return 0; }
  if (st.dodge > 0 && rngNext(hero) < st.dodge) {
    C.dodged = true;
    if (reflect) return 0;
    hero.st.dodges = (hero.st.dodges || 0) + 1;
    const zd = C.sv[S_CAP];
    if (zd && zd.usable && zd.onDodgeHealPct) live.hp = Math.min(live.maxHp, live.hp + zd.onDodgeHealPct * live.maxHp);
    return 0;
  }
  const dr = C.armorMul !== 1 ? DR(st.armor * C.armorMul, level, st.drFlat) : st.dr(level);
  let taken = Math.max(1, Math.round(raw * (1 - dr) * (1 + C.buffDmgTaken) * (1 + st.dmgTaken)));
  if (capFrac > 0) taken = Math.max(1, Math.min(taken, Math.round(capFrac * live.maxHp)));
  return damageTaken(C, taken);
}

/**
 * A hit for a share of max HP (boss area mechanics; internal API for boss.js). Reduced by flat DR
 * and room auras only (the D§9.5 simulation), or by `drFactor` x full DR when given (Outage
 * Breath: DR at half value). Never dodged.
 */
export function pctHit(C, pct, level, drFactor) {
  const { live, st } = C;
  if (isDown(live)) return 0;
  const dr = drFactor != null ? drFactor * (C.armorMul !== 1 ? DR(st.armor * C.armorMul, level, st.drFlat) : st.dr(level)) : st.drFlat;
  const taken = Math.max(1, Math.round(pct * live.maxHp * (1 - Math.min(T.drCap, dr)) * (1 + C.buffDmgTaken)));
  return damageTaken(C, taken);
}

/**
 * Crashes a hero (D§5.6; internal API for boss.js): down for `ticks` (Psychological Safety
 * shortens it), buffs and Bisect reset, lane disengaged, crash logged for the 3-in-10-minutes rule.
 */
export function crashHero(C, ticks) {
  const live = C.live;
  live.hp = 0;
  live.crashedUntil = C.rt.tick + Math.max(1, ticks - C.rebootFaster);
  live.buffs.length = 0;
  live.bisect.target = null;
  live.bisect.stacks = 0;
  live.tally.crashes++;
  if (live.engagedUid !== null && live.engagedUid !== undefined) {
    for (const m of live.lane) if (m.uid === live.engagedUid) m.engaged = false;
    live.engagedUid = null;
  }
  C.alwaysCrit = false;
  C.untargetable = false;
}

/** Back on its feet at 50% HP once the crash timer ran out (true when rebooted this tick). */
export function reboot(C) {
  const live = C.live;
  if (!(live.crashedUntil > 0) || C.rt.tick < live.crashedUntil) return false;
  live.crashedUntil = 0;
  live.hp = Math.max(live.hp, T.crash.returnHp * live.maxHp);
  return true;
}

/**
 * End-of-tick upkeep (internal API for boss.js): regen (+ Uptime), coffee (D§5.6: below 45% HP,
 * no cup in the last 5 ticks), Bottomless refills, crash at 0 HP. Returns true if the hero crashed.
 */
export function upkeep(C, regen, crashTicks) {
  const { live, st, hero } = C;
  if (isDown(live)) return false;
  if (live.hp > 0) live.hp = Math.min(live.maxHp, live.hp + (regen + (st.regenPct || 0)) * live.maxHp);
  const mug = st.lts.mug;
  if (mug && C.ct % mug.refillTicksWhileQuesting === 0 && hero.cups < T.coffee.carry) hero.cups++;
  if (live.hp > 0 && live.hp < T.coffee.threshold * live.maxHp && C.ct - (live.lastCupTick ?? -999) >= T.coffee.cooldown &&
      (hero.cups > 0 || mug)) {
    live.hp = Math.min(live.maxHp, live.hp + st.coffeeHeal * live.maxHp);
    if (!mug) hero.cups--;
    live.lastCupTick = C.ct;
    live.tally.cups++;
    fx(C, FX.coffee, { heroId: hero.id, roomId: C.roomId, value: hero.cups, text: "" });
  }
  if (live.hp <= 0) {
    crashHero(C, crashTicks);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Mobs and traits (D§9.4)
// ---------------------------------------------------------------------------------------------

function hasTrait(def, id) {
  return !!def.traits && def.traits.indexOf(id) >= 0;
}

function nextMobUid(rt) {
  rt.mobUid = (rt.mobUid || 0) + 1;
  return rt.mobUid;
}

function baseEvery(tr) {
  return tr.fast ? TRAITS.fast.swingEvery : tr.slow ? TRAITS.slow.swingEvery : 2;
}

/**
 * A lane mob (ARCHITECTURE §3.2 Mob) with its runtime trait state in mob.traits:
 * {fast, slow, phaser, clumsy, clumsyHeals, pending, leech, reviver, revived, splitter, grower,
 *  grow, thorns, ranged, shifter, shape, shapeAt, half, sipAt, shotAt, retryAt, swing}.
 */
function makeMob(rt, def, level, opts) {
  const s = mobStats(def, level, { elite: opts.elite, floor: opts.floor || 0 });
  const hp = opts.hp ?? s.hp;
  const tr = {
    fast: hasTrait(def, "fast"), slow: hasTrait(def, "slow"),
    phaser: hasTrait(def, "phaser") ? def.phaser ?? TRAITS.phaser.missChance : 0,
    clumsy: hasTrait(def, "clumsy") ? def.clumsy ?? TRAITS.clumsy.selfMissChance : 0,
    clumsyHeals: !!def.clumsyHealsHero,
    pending: hasTrait(def, "pending") ? TRAITS.pending.invulnTicks : 0,
    leech: hasTrait(def, "leech") ? def.leech ?? TRAITS.leech.healPct : 0,
    reviver: hasTrait(def, "reviver") ? def.reviver ?? TRAITS.reviver.chance : 0, revived: false,
    splitter: hasTrait(def, "splitter") && !opts.half,
    grower: hasTrait(def, "grower"), grow: 0,
    thorns: hasTrait(def, "thorns") ? def.thorns ?? TRAITS.thorns.reflect : 0,
    ranged: hasTrait(def, "ranged"),
    shifter: hasTrait(def, "shapeshifter"), shape: null, shapeAt: 0,
    half: opts.half || null, sipAt: 0, shotAt: 0, retryAt: 0, swing: 0,
  };
  return {
    uid: nextMobUid(rt), mobId: def.id, level, hp, maxHp: hp, baseHp: hp,
    atk: opts.atk ?? s.atk, xp: opts.xp ?? s.xp, gold: opts.gold ?? s.gold,
    elite: !!opts.elite, holo: !!opts.holo, v2: (opts.floor || 0) > 0,
    arriveTick: opts.arriveTick, engaged: false, swingTick: 0, swingEvery: baseEvery(tr), rangedTick: 0, hitCt: -1,
    lanePos: 0, traits: tr,
  };
}

function phaserChance(m) {
  const tr = m.traits;
  return tr.phaser || (tr.shape === "phaser" ? TRAITS.phaser.missChance : 0);
}
function clumsyChance(m) {
  const tr = m.traits;
  return tr.clumsy || (tr.shape === "clumsy" ? TRAITS.clumsy.selfMissChance : 0);
}
function leechOf(m) {
  const tr = m.traits;
  return tr.leech || (tr.shape === "leech" ? TRAITS.leech.healPct : 0);
}
function thornsOf(m) {
  const tr = m.traits;
  return tr.thorns || (tr.shape === "thorns" ? TRAITS.thorns.reflect : 0);
}
function reviverOf(m) {
  const tr = m.traits;
  return tr.reviver || (tr.shape === "reviver" ? TRAITS.reviver.chance : 0);
}

// Spawns one group into the lane (D§5.5 step 1; D§9.1 mix; 1 in 80 Smelly; 1 in 20,000 duck).
function spawn(C, room, map) {
  const { hero, live, rt } = C;
  const lane = live.lane;
  const free = LANE - lane.length;
  if (free <= 0) return;
  const arriveTick = C.ct + 1;
  const backlog = room.zone === BACKLOG_ZONE;
  let level;
  if (backlog) level = BACKLOG.level;
  else level = rngInt(hero, map.levels[0], map.levels[1]);
  const floor = backlog ? backlogFloor(C) : 0;
  if (rngNext(hero) < DUCK_P) {
    const m = makeMob(rt, MOB_BY_ID.holo_duck, level, { arriveTick, holo: true, floor });
    lane.push(m);
    return;
  }
  let def;
  if (backlog) def = MOBS[rngInt(hero, 0, MOBS.length - 1)];
  else {
    const tab = spawnTable(map);
    def = MOB_BY_ID[tab.ids[rngPick(hero, tab.w)]];
  }
  const elite = rngNext(hero) < ELITE_P;
  const n = Math.min(free, hasTrait(def, "swarm") ? def.swarm || TRAITS.swarm.count : 1);
  for (let i = 0; i < n; i++) lane.push(makeMob(rt, def, level, { arriveTick, elite, floor }));
}

function backlogFloor(C) {
  const herd = C.state.herd;
  const top = Math.max(1, (herd.backlog && herd.backlog.floor) || 1);
  const f = C.live.floor;
  return f >= 1 ? Math.min(top, f) : top;
}

// Per-tick mob upkeep: grower, shapeshifter, the duck leaving, lane positions.
function mobUpkeep(C) {
  const lane = C.live.lane;
  const ct = C.ct;
  let j = 0;
  for (let i = 0; i < lane.length; i++) {
    const m = lane[i];
    const tr = m.traits;
    if (m.holo && m.arriveTick <= ct && ct - m.arriveTick >= MOB_BY_ID.holo_duck.leaveAfterTicks) {
      if (C.live.engagedUid === m.uid) C.live.engagedUid = null;
      continue; // waddles off the right edge
    }
    if (m.arriveTick <= ct && m.hp > 0) {
      if ((tr.grower || tr.shape === "grower") && tr.grow < TRAITS.grower.cap - 1e-9) {
        const add = Math.round(m.baseHp * TRAITS.grower.perTick);
        tr.grow = Math.min(TRAITS.grower.cap, tr.grow + TRAITS.grower.perTick);
        m.maxHp += add;
        m.hp += add;
      }
      if (tr.shifter && (ct - m.arriveTick) > 0 && (ct - m.arriveTick) % TRAITS.shapeshifter.everyTicks === 0) {
        const shape = SHIFT_POOL[rngInt(C.hero, 0, SHIFT_POOL.length - 1)];
        tr.shape = shape;
        tr.shapeAt = ct;
        m.swingEvery = shape === "fast" ? TRAITS.fast.swingEvery : shape === "slow" ? TRAITS.slow.swingEvery : baseEvery(tr);
        if (shape === "pending") tr.pending = TRAITS.pending.invulnTicks;
        if (shape === "reviver") tr.revived = false;
      }
    }
    lane[j++] = m;
  }
  lane.length = j;
  for (let i = 0; i < lane.length; i++) lane[i].lanePos = i;
}

// One mob swing at the hero (clumsy, leech, thorns handled here).
function mobSwing(C, m) {
  const { hero, live } = C;
  if (!(m.atk > 0)) return;
  const tr = m.traits;
  tr.swing = C.ct;
  const raw = m.atk * (0.9 + 0.2 * rngNext(hero));
  const cl = clumsyChance(m);
  if (cl > 0 && rngNext(hero) < cl) {
    if (tr.clumsyHeals) {
      // Bitflip Moth: the flipped bit heals the hero for the swing's amount
      const amt = Math.min(Math.round(raw), Math.max(0, Math.round(live.maxHp - live.hp)));
      if (amt > 0) {
        live.hp += amt;
        fx(C, FX.heal, { heroId: hero.id, mobUid: m.uid, roomId: C.roomId, value: amt, text: `+${fmtNum(amt)}` });
      }
    } else {
      C.dodged = true;
    }
    return;
  }
  const taken = hitHero(C, raw, m.level);
  const lp = leechOf(m);
  if (taken > 0 && lp > 0) {
    m.hp = Math.min(m.maxHp, m.hp + Math.round(taken * lp));
    tr.sipAt = C.ct;
  }
}

// ---------------------------------------------------------------------------------------------
// Kills and rewards (D§6.2, D§8.6, D§9.1, D§9.7, D§9.8, D§10.5)
// ---------------------------------------------------------------------------------------------

// A Contractor (D§3.4) earns its own XP like anyone else; world.js (contractorXp) passes half of
// every Contractor's XP gain, whatever its source, to the lowest-level off-duty hero of its seat.
function grantKillXP(C, xp) {
  const { state, hero, live, ev } = C;
  live.tally.xp += xp;
  const r = grantXP(state, hero, xp, ev);
  if (r.levels > 0) C.leveled = true;
}

function addSnip(state, n) {
  if (typeof Herd.addSnippets === "function") Herd.addSnippets(state, n);
  else state.herd.snip = (state.herd.snip || 0) + n;
}

/**
 * Offers a fresh drop (D§8.7): autopilot.offerDrop when present (it pre-filters candidates before
 * the costly score and tells autopilot whose gear changed), else items.offerItem. Contractors are
 * never offered gear (the roster is). Internal API for boss.js.
 */
export function offerDrop(world, hero, item, ev) {
  const finder = hero && inRoster(world, hero) ? hero : null;
  if (typeof Auto.offerDrop === "function") return Auto.offerDrop(world, finder, item, ev);
  return offerItem(world.state, finder, item, (h) => heroCtx(world, h));
}

function offer(C, item, mob) {
  const { world, hero } = C;
  offerDrop(world, hero, item, C.ev);
  const d = { heroId: hero.id, mobUid: mob ? mob.uid : null, roomId: C.roomId, rar: item.rar, value: item.uid, text: "" };
  if (mob && mob.holo) d.holo = true; // the stage shows a Duck Chest for it (D§11.8), even for a duck it never drew
  fx(C, FX.loot, d);
  if (typeof Herd.logDrop === "function") Herd.logDrop(world, hero, item, C.ev);
}

function kill(C, m, room, map) {
  const { state, hero, live, st, g } = C;
  hero.st.kills = (hero.st.kills || 0) + 1;
  live.tally.kills++;
  const shift = shiftKillMult(hero.shift ? hero.shift.min || 0 : 0);
  const crowd = g.crowd;
  // XP (D§6.2); the Backlog has no gap penalty (D§9.8)
  let gp = gap(hero.L - m.level);
  if (room.zone === BACKLOG_ZONE && gp < 1) gp = 1;
  const fe = (hero.fe || 0) > 0 ? T.freshEyes.xpMult : 1;
  const xp = m.xp * gp * (1 + C.xpPct) * fe * shift * crowd;
  // gold (D§8.6)
  const gd = Math.round(m.gold * (1 + st.goldPct) * shift * crowd);
  if (gd > 0) Herd.addGold(state, gd);
  live.tally.gold += gd;
  fx(C, FX.poof, { heroId: hero.id, mobUid: m.uid, roomId: C.roomId, value: 0, text: "" });
  fx(C, FX.coin, { heroId: hero.id, mobUid: m.uid, roomId: C.roomId, value: gd, text: "" });
  const t = itemTier(m.level);
  if (m.holo) {
    // Holo Rubber Duck (D§9.7): a Duck Chest with one item, 10 x gold(m), 5t Snippets
    Herd.addGold(state, 10 * goldOf(m.level));
    addSnip(state, 5 * t);
    hero.st.ducks = (hero.st.ducks || 0) + 1;
    if (typeof Herd.noteDuck === "function") Herd.noteDuck(C.world, C.ev);
    offer(C, rollItem(hero, { ilvl: dropIlvl(hero, "duck", m.level), source: "duck", classId: hero.cls, itemFind: st.itemFind, state }), m);
  } else {
    if (m.elite) {
      if (rngNext(hero) < ELITE.snippetChance) addSnip(state, 3 * t);
    } else if (rngNext(hero) < 0.03) {
      addSnip(state, t);
    }
    const p = killDropChance({ elite: m.elite, itemFind: st.itemFind, shiftKill: shift }) * crowd;
    if (rngNext(hero) < p) {
      const lvl = room.zone === BACKLOG_ZONE ? BACKLOG.lootIlvl.base + Math.floor(BACKLOG.lootIlvl.perFloor * backlogFloor(C)) : m.level;
      const src = m.elite ? "elite" : "kill";
      offer(C, rollItem(hero, { ilvl: dropIlvl(hero, src, lvl), source: src, classId: hero.cls, itemFind: st.itemFind, state }), m);
    }
  }
  // Bug Tracker (D§10.5), map quotas (D§9.1), Backlog floors (D§9.8)
  if (room.zone < ZONES.length) Herd.bugTrackerKill(state, room.zone, m.elite);
  if (map) countQuota(C, map);
  else if (room.zone === BACKLOG_ZONE) countBacklog(C);
  // Garbage-Collected (D§8.4): each kill heals 2% max HP
  const gc = st.lts.gc;
  if (gc && live.hp > 0) live.hp = Math.min(live.maxHp, live.hp + gc.healPerKillPct * live.maxHp);
  grantKillXP(C, xp);
}

function countQuota(C, map) {
  const herd = C.state.herd;
  if (!herd.quota) herd.quota = {};
  const k = herd.quota[map.id] || 0;
  if (k >= T.quotaPerMap) return;
  herd.quota[map.id] = k + 1;
  if (k + 1 === T.quotaPerMap) {
    const ev = C.ev;
    const next = MAPS[map.n + 1];
    const text = next && next.zone === map.zone ? `${map.id} cleared: ${next.id} ${next.name} open` : `${map.id} cleared`;
    if (ev) {
      if (typeof ev.note === "function") ev.note(text);
      if (typeof ev.journal === "function") ev.journal("map", C.hero.id, text, map.n);
      if (typeof ev.major === "function") ev.major();
    }
  }
}

function countBacklog(C) {
  const herd = C.state.herd;
  const b = herd.backlog || (herd.backlog = { floor: 1, kills: 0 });
  if (!(b.floor >= 1)) b.floor = 1;
  if (backlogFloor(C) !== b.floor) return;
  if (b.kills < BACKLOG.killsPerFloor) b.kills++;
  // every 10th floor waits for its boss (boss.js, kind "backlog")
  if (b.kills >= BACKLOG.killsPerFloor && b.floor % BACKLOG.bossEvery !== 0) {
    b.floor++;
    b.kills = 0;
    const ev = C.ev;
    if (ev && typeof ev.note === "function") ev.note(`Backlog floor ${b.floor}`);
  }
}

// Death pass: revivers, kills, splitter halves; keeps the lane compact.
function deaths(C, room, map) {
  const { live, rt, hero } = C;
  const lane = live.lane;
  let any = false;
  for (let i = 0; i < lane.length; i++) if (lane[i].hp <= 0) { any = true; break; }
  if (!any) return;
  let j = 0;
  let halves = null;
  for (let i = 0; i < lane.length; i++) {
    const m = lane[i];
    if (m.hp > 0) { lane[j++] = m; continue; }
    const tr = m.traits;
    const rv = reviverOf(m);
    if (rv > 0 && !tr.revived && rngNext(hero) < rv) {
      // reviver (D§9.4): once, back at 40% HP; the eventual death is the one kill
      tr.revived = true;
      tr.retryAt = C.ct;
      m.hp = Math.max(1, Math.round(TRAITS.reviver.hp * m.maxHp));
      fx(C, FX.skill, { heroId: hero.id, mobUid: m.uid, roomId: C.roomId, text: "retry", value: 0 });
      lane[j++] = m;
      continue;
    }
    kill(C, m, room, map);
    if (live.engagedUid === m.uid) live.engagedUid = null;
    if (tr.splitter) (halves || (halves = [])).push(m);
  }
  lane.length = j;
  if (halves) {
    for (const m of halves) {
      // splitter (D§9.4): 2 halves at 30% HP and 30% XP each; with one free slot, one half
      // carries both shares, so HP and XP add up the same
      const free = LANE - lane.length;
      if (free <= 0) break;
      const n = Math.min(TRAITS.splitter.halves, free);
      const share = TRAITS.splitter.hpPct * (TRAITS.splitter.halves / n);
      const def = MOB_BY_ID[m.mobId];
      for (let k = 0; k < n; k++) {
        const hp = Math.max(1, Math.round(m.maxHp * share));
        const h = makeMob(rt, def, m.level, {
          arriveTick: C.ct, elite: m.elite, hp, atk: m.atk,
          xp: m.xp * TRAITS.splitter.xpPct * (TRAITS.splitter.halves / n), gold: Math.round(m.gold * share),
          half: k === 0 ? "HEAD" : "incoming",
        });
        h.v2 = m.v2;
        lane.unshift(h);
      }
    }
  }
  for (let i = 0; i < lane.length; i++) lane[i].lanePos = i;
}

// ---------------------------------------------------------------------------------------------
// Lane tick (D§5.5)
// ---------------------------------------------------------------------------------------------

function laneArena(C) {
  const live = C.live;
  let a = live._arena;
  if (!a) a = live._arena = { boss: false, list: [], count: 0, main: null, anyElite: false };
  const lane = live.lane;
  const ct = C.ct;
  let n = 0;
  let elite = false;
  let main = null;
  for (let i = 0; i < lane.length; i++) {
    const m = lane[i];
    if (m.arriveTick > ct || m.hp <= 0) continue;
    a.list[n++] = m;
    if (m.elite) elite = true;
    if (m.uid === live.engagedUid) main = m;
  }
  a.list.length = n;
  a.count = n;
  a.main = main;
  a.anyElite = elite;
  return a;
}

function laneTick(C, room, map, acts) {
  const { live } = C;
  const lane = live.lane;
  if (live._laneMap !== room.mapId) {
    // a new map (autopilot, crash rule, pin): the hero walks out; a fresh lane forms
    lane.length = 0;
    live.engagedUid = null;
    live._laneMap = room.mapId;
  }
  spawn(C, room, map);
  mobUpkeep(C);
  if (live.crashedUntil > 0) {
    reboot(C);
    flush(C);
    return;
  }
  let arena = laneArena(C);
  C.arena = arena;
  if (!arena.main) {
    live.engagedUid = null;
    if (acts) {
      // advance step: walk forward, regen 2%, engage the front arrived mob; no attack
      live.hp = Math.min(live.maxHp, live.hp + T.regen.advance * live.maxHp);
      live.advanceTick = C.rt.tick;
      if (arena.count > 0) {
        const m = arena.list[0];
        m.engaged = true;
        live.engagedUid = m.uid;
        live.bisect.target = null;
        live.bisect.stacks = 0;
      }
    }
    tickPending(arena);
    drainFreshEyes(C);
    flush(C);
    return;
  }
  const tgt = arena.main;
  // Bisect (Hotfixer Signature): +5% damage per consecutive tick on the same target
  const bis = C.sv[S_SIG];
  if (acts && bis && bis.usable && bis.type === "stacks") {
    const b = live.bisect;
    if (b.target === tgt.uid) b.stacks = Math.min(bis.maxStacks, b.stacks + 1);
    else { b.target = tgt.uid; b.stacks = 0; }
    C.bisectUid = tgt.uid;
    C.bisectPct = b.stacks * bis.perStack.dmg;
  } else {
    C.bisectUid = null;
    C.bisectPct = 0;
  }
  if (acts) act(C);
  summons(C, acts);
  // mob swings: the engaged mob on the tick the first hit lands on it (a 403 or a 404 does not
  // count), then every 2nd tick (fast 1, slow 3)
  if (tgt.swingTick === 0 && tgt.hitCt === C.ct) tgt.swingTick = C.ct + SWING_DELAY;
  if (tgt.hp > 0 && tgt.swingTick > 0 && C.ct >= tgt.swingTick && !tgt.holo) {
    mobSwing(C, tgt);
    tgt.swingTick = C.ct + tgt.swingEvery;
  }
  // ranged mobs also swing from the second lane position every 3rd tick
  for (let i = 0; i < arena.count; i++) {
    const m = arena.list[i];
    if (m === tgt || m.hp <= 0 || m.lanePos !== TRAITS.ranged.fromSlot - 1) continue;
    if (!(m.traits.ranged || m.traits.shape === "ranged")) continue;
    if (!(m.rangedTick > 0)) m.rangedTick = C.ct + TRAITS.ranged.swingEvery;
    if (C.ct >= m.rangedTick) {
      m.traits.shotAt = C.ct;
      mobSwing(C, m);
      m.rangedTick = C.ct + TRAITS.ranged.swingEvery;
    }
  }
  // thorns reflect a share of what the hero's own melee hits dealt to spiked mobs this tick, as one
  // hit through dodge, Stealth Commit, DR and damage-taken modifiers, capped per tick (D§9.4)
  if (C.reflect > 0) hitHero(C, C.reflect, C.reflectLvl, TRAITS.thorns.capPerTick, true);
  tickPending(arena);
  deaths(C, room, map);
  upkeep(C, T.regen.engaged, T.crash.downTicks);
  if (live.crashedUntil > 0) crashRule(C, room);
  drainFreshEyes(C);
  flush(C);
}

// pending (D§9.4): a Promise resolves on its own, counting its first ticks in the lane from arrival,
// engaged or not, at the end of each lane tick (balance: D§9.4 counts engaged ticks only, so every
// queued Wisp also swallowed the area hits and 2 more ticks once engaged: map 2-2 ran at 10 kills
// a minute whatever the class; docs/BALANCE.md)
function tickPending(arena) {
  for (let i = 0; i < arena.count; i++) {
    const m = arena.list[i];
    if (m.traits.pending > 0) m.traits.pending--;
  }
}

/** Fresh Eyes drains 1 minute per working minute (D§2.9), in a lane or a fight (internal API for boss.js). */
export function drainFreshEyes(C) {
  const h = C.hero;
  if (h.fe > 0) h.fe = Math.max(0, h.fe - 1 / 60);
}

// D§5.6 crash rule: 3 crashes within 10 minutes drop the hero one map for 30 minutes.
// live.dropMap = {mapId, untilMs} tells autopilot to keep the hero at or below that map.
function crashRule(C, room) {
  const { live, rt } = C;
  const [count, windowSec] = T.crash.dropMapAfter;
  const list = live.crashes;
  list.push(rt.tick);
  let j = 0;
  for (let i = 0; i < list.length; i++) if (rt.tick - list[i] < windowSec) list[j++] = list[i];
  list.length = j;
  if (list.length < count) return;
  list.length = 0;
  const m = MAP_BY_ID[room.mapId];
  if (!m || m.n === 0) return;
  const down = MAPS[m.n - 1];
  live.dropMap = { mapId: down.id, untilMs: rt.nowMs + T.crash.dropMapForSec * 1000 };
  if (live.mapId) live.mapId = down.id;
  const ev = C.ev;
  if (ev && typeof ev.note === "function") ev.note(`${C.hero.name} fell back to ${down.id}`, null, { heroId: C.hero.id });
}

// Room scratch (actors of the room's fighting heroes), reused between calls.
const ROOM_ACTORS = [];
const ROOM_INFO = { duck: 0, safety: 0, allies: 0, partyOthers: 0, banner: false, forklings: undefined };

/**
 * Aura ranks of a set of actors (internal API for boss.js): the highest Rubber Duck Debugging and
 * Psychological Safety ranks among active Rubberduckers (D§7.7: highest-ranked only).
 */
export function auraRanks(actors, n, out) {
  let duck = 0;
  let safety = 0;
  for (let i = 0; i < n; i++) {
    const h = actors[i].hero;
    if (h.cls !== RUBBER) continue;
    const r = effectiveRank(h, S_PASSIVE);
    const s = effectiveRank(h, S_CAP);
    if (r > duck) duck = r;
    if (s > safety) safety = s;
  }
  out.duck = duck;
  out.safety = safety;
  return out;
}

/**
 * One lane tick for every Questing / Supervising hero of a room (D§5.5): spawn, advance or act
 * (rotation, buffs, summons, Forklings), mob swings and traits, deaths and rewards, regen,
 * coffee, crashes, Fresh Eyes drain, numbers. Heroes in a boss fight or review, Waiting heroes
 * and resting ones are skipped (their clocks do not move). Supervising heroes act on every 2nd
 * tick of their clock; their Forklings hit every tick.
 */
export function stepRoom(world, room, ev) {
  const g = tickGlobals(world);
  const rt = world.rt;
  const map = MAP_BY_ID[room.mapId] || null;
  if (!map && room.zone !== BACKLOG_ZONE) return;
  let n = 0;
  let questing = 0;
  let banner = false;
  for (let i = 0; i < room.heroIds.length; i++) {
    const id = room.heroIds[i];
    const live = rt.live.get(id);
    if (!live) continue;
    if (live.pinned) banner = true;
    if (!isActive(live)) continue;
    if (g.fighting.has(id)) continue;
    const hero = findHero(world, id);
    if (!hero) continue;
    ROOM_ACTORS[n++] = actorFor(world, hero, live, ev, room.id);
    if (isQuesting(live)) questing++;
  }
  if (!n) return;
  const info = auraRanks(ROOM_ACTORS, n, ROOM_INFO);
  info.allies = n - 1;
  info.banner = banner;
  info.forklings = undefined;
  for (let i = 0; i < n; i++) {
    const C = ROOM_ACTORS[i];
    C.mates = ROOM_ACTORS;
    C.nm = n;
    C.live.ct++;
    C.ct = C.live.ct;
    info.partyOthers = questing - (isQuesting(C.live) ? 1 : 0);
    prepare(C, info);
  }
  for (let i = 0; i < n; i++) {
    const C = ROOM_ACTORS[i];
    const acts = isQuesting(C.live) || C.ct % 2 === 0;
    laneTick(C, room, map, acts);
    if (C.leveled) {
      // level-up: full heal at the new max HP
      C.st = stats(C.hero, C.live._sctx);
      syncHp(C);
      C.live.hp = C.live.maxHp;
      C.hero.hpFrac = 1;
    }
  }
  for (let i = 0; i < n; i++) ROOM_ACTORS[i] = null;
}

// ---------------------------------------------------------------------------------------------
// Rest (D§2.2: Shipped / Resting; D§2.9 Fresh Eyes)
// ---------------------------------------------------------------------------------------------

/**
 * One tick of rest for a hero that is not Questing (Shipped, Resting): regen 5% max HP, coffee
 * refill 1 cup per 30 ticks (2 x gold(L) a cup, -5% per Coffee Machine level, paid by the herd
 * as far as it can), a crash ends at once, Fresh Eyes +0.25 minutes per minute (Weekend Pass
 * +50%) up to 60 + 15 x Campfire minutes, only after the hero's first credited Seal. With
 * live == null (off duty) only Fresh Eyes accrues. Waiting heroes are frozen: no-op.
 */
export function restTick(world, hero, live) {
  if (!hero) return;
  if (live && live.state !== "shipped" && live.state !== "resting") return;
  const state = world.state;
  const herd = state.herd;
  const st = stats(hero, live && live._sctx ? live._sctx : heroCtx(world, hero));
  if (live) {
    if (!(live.maxHp > 0)) { live.maxHp = st.maxHp; live.hp = st.maxHp * (hero.hpFrac ?? 1); }
    else if (live.maxHp !== st.maxHp) { live.hp = (live.hp / live.maxHp) * st.maxHp; live.maxHp = st.maxHp; }
    if (live.crashedUntil > 0) {
      live.crashedUntil = 0;
      live.hp = Math.max(live.hp, T.crash.returnHp * live.maxHp);
    }
    live.hp = Math.min(live.maxHp, live.hp + T.regen.resting * live.maxHp);
    hero.hpFrac = live.maxHp > 0 ? live.hp / live.maxHp : 1;
    live.refill = (live.refill || 0) + 1;
    if (live.refill >= T.coffee.refillTicks) {
      live.refill = 0;
      if (hero.cups < T.coffee.carry) {
        hero.cups++;
        const price = coffeePrice(hero.L, (herd.bld || [])[COFFEE_MACHINE] || 0);
        Herd.addGold(state, -Math.min(price, herd.gold || 0));
      }
    }
  }
  if ((hero.st && hero.st.seals) > 0) {
    const cap = freshEyesCap((herd.bld || [])[CAMPFIRE] || 0);
    const wp = st.keepsakes.weekend_pass;
    const rate = (T.freshEyes.accruePerMin / 60) * (1 + (wp ? wp.freshEyesAccrual : 0));
    if ((hero.fe || 0) < cap) hero.fe = Math.min(cap, (hero.fe || 0) + rate);
  }
}

// Re-exports for tests and tools.
export const _internal = { makeMob, laneArena, deaths, spawn, mobSwing, F_AREA, F_PRIMARY, F_CRIT, apply, deal };
