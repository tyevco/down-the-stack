// Boss fights and promotion reviews (D§9.5, D§9.6, D§4.5, D§9.8 boss floors): participants and
// Answer-calls helpers, the encounter loop with every mechanic primitive (spawnAdd, burstAdds,
// layers + await/resolve, burstCheck, shieldParts, grow, twinHeads + balanceCheck, split/mesh,
// clock, stance, pulse, observed), timers (War Room), enrage, invulnerability windows, crashes,
// suspension, Postmortems (Wounds, Lessons Learned, retry gate), the win estimate and rewards.
//
// Contract exports (ARCHITECTURE §3.4): canChallenge, startFight, stepFight, estimate. Also:
// resumeFight, suspendFight, retreat, participants, fightOf, packFight/unpackFight.
//
// Fight (ARCHITECTURE §3.2) = { key, kind: "boss"|"review"|"backlog", bossIdx, reviewIdx, id, name,
//   level, zone, floor, heroIds, helpers, n, parts: [Part], phase, phaseLabel, mechText, t, timer,
//   enraged, invuln, segments, mech: {...}, startedTick, idle, dealt, lessons, banner, stamp, result }
// Part = { uid, key, code, ord, label, art, kind: "boss"|"head"|"tentacle"|"service"|"add", hp,
//   maxHp, atk, every, next }  (uid is the fx mobUid of hits on that part; art: mob/boss art id)
// A running boss fight is mirrored into herd.fight in a compact form every tick (packFight), so a
// save taken at any moment holds it as a suspended fight (D§13.1); loadWorld leaves rt.fights
// empty and resumeFight() brings it back when a participant works again. Reviews are short and
// per hero: they are not saved (a review cut short by a restart simply starts over later).
//
// Clocks: the fight timer (fight.t) advances only on ticks where at least one participant is
// Questing (D§9.5). Heroes use their own combat clock (live.ct) for cooldowns, buffs and crashes,
// exactly as in lanes (combat.js).
//
// Pure: RNG through rng.js holders (heroes for their own hits, the herd for boss decisions).

import {
  TUNING as T, BOSSES, REVIEWS, ZONES, MOB_BY_ID, BOSS_PARTS, BACKLOG, TRAITS, KEEPSAKES, BUILDING_IDX,
} from "./data.js";
import { mobHP, mobATK, bossHP, bossSwing, refDPS, gold as goldOf, itemTier, bossXP, gap, fmtNum, coffeePrice } from "./formulas.js";
import { rngNext, rngInt } from "./rng.js";
import { stats, grantXP, winReview, careerOf } from "./heroes.js";
import { rollItem, rollKeepsake, rollReviewReward, stashPut, itemName } from "./items.js";
import * as Herd from "./herd.js";
import {
  findHero, heroCtx, heroMapId, actorFor, prepare, act, summons, flush, hitHero, pctHit, upkeep, reboot, auraRanks, FX,
  isActive, offerDrop, drainFreshEyes,
} from "./combat.js";

const B = T.boss;
const ADD_KINDS = ["warning_mite", "callback_bat", "left_pad_mites", "pager_wyvern", "nitpick"];
const CODE_BODY = 0;
const CODE_HEAD = 1;
const CODE_TENTACLE = 2;
const CODE_SERVICE = 3;
const CODE_ADD = 10;
// design gap: D§4.5 gives the reviews no mechanic factor for the win estimate; the Senior Review
// has only a cosmetic bubble, the Staff Review a Nitpick shield (like the bosses' 0.75-0.85).
const REVIEW_MECH = [0.95, 0.8];
const BACKLOG_ZONE = BACKLOG.n;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function nowMs(world) {
  return world.rt.nowMs || world.state.herd.lastMs || 0;
}

function note(ev, text, color) {
  if (ev && typeof ev.note === "function") ev.note(text, color);
}
function jot(world, ev, kind, heroId, text, value) {
  if (ev && typeof ev.journal === "function") ev.journal(kind, heroId, text, value);
  else Herd.journal(world.state, kind, heroId, text, value, nowMs(world));
}
function major(ev) {
  if (ev && typeof ev.major === "function") ev.major();
}
function fx(ev, kind, data) {
  if (ev && typeof ev.fx === "function") ev.fx(kind, data);
}

function zoneOf(mapId) {
  if (mapId === "backlog") return BACKLOG_ZONE;
  const m = /^(\d)-\d$/.exec(mapId || "");
  return m ? Number(m[1]) - 1 : 0;
}

/** The fight a hero takes part in (boss, backlog boss or review), or null. */
export function fightOf(world, heroId) {
  for (const f of world.rt.fights || []) if (f.heroIds.indexOf(heroId) >= 0) return f;
  return null;
}

function questingNow(live) {
  return !!live && (live.state === "questing" || live.state === "crashed");
}

function bossFightRunning(world) {
  for (const f of world.rt.fights || []) if (f.kind !== "review") return f;
  return null;
}

function warRoom(state) {
  if (typeof Herd.warRoomTicks === "function") return Herd.warRoomTicks(state);
  return B.warRoomTicks * ((state.herd.bld || [])[BUILDING_IDX.war_room] || 0);
}

function workSec(hero) {
  return Math.round(((hero.st && hero.st.wh) || 0) * 3600);
}

function woundKey(kind, idx, heroId) {
  return kind === "review" ? `rv${idx}.${heroId}` : kind === "backlog" ? `bl${idx}` : String(idx);
}

function woundsOf(world, key) {
  const w = (world.state.herd.wounds || {})[key];
  if (!Array.isArray(w)) return { frac: 0, retry: 0 };
  const active = !(w[1] > 0) || nowMs(world) < w[1];
  return { frac: active ? w[0] || 0 : 0, retry: w[2] || 0 };
}

function lessonsOf(world, key) {
  const n = (world.state.herd.lessons || {})[key] || 0;
  return Math.min(B.lessonsCap, B.lessonsPerFail * n);
}

function swingEveryOf(id) {
  const def = MOB_BY_ID[id];
  if (!def || !def.traits) return 2;
  if (def.traits.indexOf("fast") >= 0) return TRAITS.fast.swingEvery;
  if (def.traits.indexOf("slow") >= 0) return TRAITS.slow.swingEvery;
  return 2;
}

// Encounter definition for (kind, idx): name, level, HP and swing multipliers, timer, mech factor.
function encounter(kind, idx) {
  if (kind === "review") {
    const r = REVIEWS[idx];
    if (!r) return null;
    return {
      kind, idx, id: r.id, name: r.opponent, level: r.level, zone: -1, def: r, review: r,
      timer: r.timer, mech: REVIEW_MECH[idx] || 0.85, hpMult: 1, atkMult: 1, floor: 0,
    };
  }
  if (kind === "backlog") {
    const f = idx;
    if (!(f >= BACKLOG.bossEvery) || f % BACKLOG.bossEvery !== 0) return null;
    const bi = ((f / BACKLOG.bossEvery) - 1) % BOSSES.length;
    const d = BOSSES[bi];
    return {
      kind, idx: f, bossIdx: bi, id: d.id, name: `${d.name} ${BACKLOG.versionTag}`, level: BACKLOG.level, zone: BACKLOG_ZONE,
      def: d, timer: d.timer, mech: d.mech, hpMult: Math.pow(BACKLOG.perFloor.hp, f), atkMult: Math.pow(BACKLOG.perFloor.atk, f), floor: f,
    };
  }
  const d = BOSSES[idx];
  if (!d) return null;
  return { kind: "boss", idx, bossIdx: idx, id: d.id, name: d.name, level: d.level, zone: d.zone, def: d, timer: d.timer, mech: d.mech, hpMult: 1, atkMult: 1, floor: 0 };
}

// Max HP of the encounter's main pool for n participants (bodies; parts and adds come on top).
function poolHP(enc, n) {
  if (enc.kind === "review") return Math.round(enc.review.hpMobs * mobHP(enc.level));
  return Math.round(bossHP(enc.def.bk, enc.level, n) * enc.hpMult);
}

// ---------------------------------------------------------------------------------------------
// Participants (D§9.5)
// ---------------------------------------------------------------------------------------------

function canRepeat(hero, idx) {
  const last = hero.cd && hero.cd.boss ? hero.cd.boss[idx] : undefined;
  return last == null || workSec(hero) - last >= B.repeatCooldownWorkingSec;
}

/**
 * Participants for a boss (D§9.5): up to 6 Questing heroes standing in the boss's zone (any
 * space), highest Power Level first, plus Answer-calls helpers (setting auto.calls): Questing
 * heroes anywhere who already beat this boss and have PL >= Lb. Repeat kills: once per 3 working
 * hours per hero. Backlog boss floors: Questing heroes in the Backlog. Heroes already in a fight
 * are never picked.
 * @returns {{heroIds:number[], helpers:number[]}}
 */
export function participants(world, kind, idx) {
  const enc = encounter(kind === "review" ? "boss" : kind, idx);
  const out = { heroIds: [], helpers: [] };
  if (!enc) return out;
  const { state, rt } = world;
  const repeat = kind === "boss" && ((state.herd.boss || [])[idx] || 0) > 0;
  const calls = !(state.herd.cfg && state.herd.cfg.auto && state.herd.cfg.auto.calls === false);
  const zone = [];
  const help = [];
  for (const [id, live] of rt.live) {
    if (!questingNow(live) || fightOf(world, id)) continue;
    const hero = findHero(world, id);
    if (!hero) continue;
    if (repeat && !canRepeat(hero, idx)) continue;
    const pl = stats(hero, heroCtx(world, hero)).pl;
    const z = zoneOf(heroMapId(hero, live));
    if (z === enc.zone) zone.push({ id, pl });
    else if (kind === "boss" && calls && hero.cd && hero.cd.boss && hero.cd.boss[idx] != null && pl >= enc.level) help.push({ id, pl });
  }
  zone.sort((a, b) => b.pl - a.pl || a.id - b.id);
  help.sort((a, b) => b.pl - a.pl || a.id - b.id);
  for (const p of zone) if (out.heroIds.length < B.maxParticipants) out.heroIds.push(p.id);
  for (const p of help) {
    if (out.heroIds.length >= B.maxParticipants) break;
    out.heroIds.push(p.id);
    out.helpers.push(p.id);
  }
  return out;
}

// The review candidate: the given hero, else the highest-level eligible Questing hero.
function reviewHero(world, idx, heroId) {
  const r = REVIEWS[idx];
  if (!r) return null;
  const ok = (hero, live) => hero && questingNow(live) && hero.cls > 0 && hero.L >= r.level &&
    !(hero.rev || [])[idx] && (idx === 0 || (hero.rev || [])[0]) && !fightOf(world, hero.id);
  if (heroId != null) {
    const hero = findHero(world, heroId);
    return ok(hero, world.rt.live.get(heroId)) ? hero : null;
  }
  let best = null;
  for (const [id, live] of world.rt.live) {
    const hero = findHero(world, id);
    if (ok(hero, live) && (!best || hero.L > best.L)) best = hero;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Estimate and challenge (D§9.5)
// ---------------------------------------------------------------------------------------------

/**
 * Win estimate E = Σ min(DPS_est·(1 + Boss%), cap) · (1 + Lessons) · 0.85 · timer · mech /
 * (bossHP(n) − Wounds). Helpers (Answer calls) are capped at refDPS(Lb + 3). For kind "review"
 * idx is the review index and heroIds its single hero. For kind "backlog" idx is the floor.
 */
export function estimate(world, kind, idx, heroIds, helpers) {
  const enc = encounter(kind, idx);
  if (!enc || !heroIds || !heroIds.length) return 0;
  const state = world.state;
  const n = heroIds.length;
  const help = helpers || [];
  let dps = 0;
  for (const id of heroIds) {
    const hero = findHero(world, id);
    if (!hero) continue;
    const st = stats(hero, heroCtx(world, hero));
    let d = st.dpsEst * (1 + st.bossDmg);
    if (help.indexOf(id) >= 0) d = Math.min(d, refDPS(enc.level + B.helperCapLevels));
    dps += d;
  }
  const key = woundKey(kind, idx, heroIds[0]);
  const hp = poolHP(enc, n) * (1 - woundsOf(world, key).frac);
  const timer = enc.timer + warRoom(state);
  return hp > 0 ? (dps * (1 + lessonsOf(world, key)) * B.estimateMargin * timer * enc.mech) / hp : 0;
}

function labelOf(E) {
  return E >= 1.2 ? "Favored" : E >= 0.95 ? "Even" : "Risky";
}

function doorOpen(world, zone) {
  if (typeof Herd.doorOpen === "function") return Herd.doorOpen(world.state, zone);
  const herd = world.state.herd;
  if ((herd.boss || [])[zone] > 0) return true;
  if (zone !== herd.zone) return false;
  const last = ZONES[zone].maps[2].id;
  return ((herd.quota || {})[last] || 0) >= T.quotaPerMap && (herd.meter || 0) >= T.sprint[zone];
}

/**
 * Can a fight start now? Boss: the door is open (D§9.1), no other boss fight runs, the retry gate
 * after a Postmortem has passed and someone is Questing in the zone. Review (idx = review index,
 * optional heroId): an eligible Questing hero of the level that has not won it. Backlog (idx =
 * floor): a boss floor with its 50 kills and heroes in the Backlog.
 * @returns {{ok:boolean, estimate:number, label:string, heroIds:number[], helpers:number[], error?:string}}
 */
export function canChallenge(world, kind, idx, heroId) {
  const fail = (error) => ({ ok: false, estimate: 0, label: "Risky", heroIds: [], helpers: [], error });
  const herd = world.state.herd;
  if (kind === "review") {
    const r = REVIEWS[idx];
    if (!r) return fail("No such review");
    const hero = reviewHero(world, idx, heroId);
    if (!hero) return fail(`Needs a Questing Lv ${r.level} hero`);
    const w = woundsOf(world, woundKey(kind, idx, hero.id));
    if (w.retry > 0) return fail(`Retry in ${Math.ceil(w.retry / 60)} working min`);
    const E = estimate(world, kind, idx, [hero.id]);
    return { ok: true, estimate: E, label: labelOf(E), heroIds: [hero.id], helpers: [] };
  }
  const enc = encounter(kind, idx);
  if (!enc) return fail("No such boss");
  if (bossFightRunning(world)) return fail("A boss fight is on");
  if (kind === "backlog") {
    const b = herd.backlog || {};
    if (b.floor !== idx || (b.kills || 0) < BACKLOG.killsPerFloor) return fail("Floor not cleared yet");
  } else if (!doorOpen(world, enc.zone)) {
    return fail("The door is closed");
  }
  const w = woundsOf(world, woundKey(kind, idx));
  if (w.retry > 0) return fail(`Retry in ${Math.ceil(w.retry / 60)} working min`);
  const p = participants(world, kind, idx);
  if (!p.heroIds.length) return fail(`Nobody is working in ${enc.zone >= 0 && ZONES[enc.zone] ? ZONES[enc.zone].name : "the Backlog"}`);
  const E = estimate(world, kind, idx, p.heroIds, p.helpers);
  return { ok: true, estimate: E, label: labelOf(E), heroIds: p.heroIds, helpers: p.helpers };
}

// ---------------------------------------------------------------------------------------------
// Building fights
// ---------------------------------------------------------------------------------------------

function partMeta(fight, code, ord) {
  const enc = fight._enc;
  const id = enc.id;
  if (code >= CODE_ADD) {
    const addId = ADD_KINDS[code - CODE_ADD];
    const def = MOB_BY_ID[addId];
    return { key: `add${ord}`, label: def ? def.name : addId, art: addId, kind: "add" };
  }
  if (code === CODE_HEAD) return { key: `head${ord}`, label: BOSS_PARTS.deadlock_hydra[ord], art: `${id}-part`, kind: "head" };
  if (code === CODE_TENTACLE) return { key: `arm${ord}`, label: BOSS_PARTS.octopus_merge[ord], art: `${id}-part`, kind: "tentacle" };
  if (code === CODE_SERVICE) return { key: `svc${ord}`, label: BOSS_PARTS.monolith[ord], art: `${id}-part`, kind: "service" };
  return { key: "body", label: fight.name, art: enc.kind === "review" ? enc.review.art || null : id, kind: "boss" };
}

function newPart(fight, code, ord, hp, extra) {
  const m = partMeta(fight, code, ord);
  const p = {
    uid: `${fight.key}:${m.key}`, key: m.key, code, ord, label: m.label, art: m.art, kind: m.kind,
    hp, maxHp: hp, atk: 0, every: 0, next: 0,
  };
  if (extra) Object.assign(p, extra);
  return p;
}

// Adds an add (a boss minion) to the fight: HP mobHP(Lb) x hp, swing mobATK(Lb) x atk.
function spawnAdd(fight, addDef, count) {
  const code = CODE_ADD + ADD_KINDS.indexOf(addDef.id);
  const hp = Math.max(1, Math.round(mobHP(fight.level, addDef.hp) * fight._enc.hpMult));
  const atk = Math.round(mobATK(fight.level, addDef.atk) * fight._enc.atkMult);
  const every = swingEveryOf(addDef.id);
  for (let i = 0; i < count; i++) {
    fight.addSeq = (fight.addSeq || 0) + 1;
    fight.parts.push(newPart(fight, code, fight.addSeq, hp, { atk, every, next: fight.t + 1 }));
  }
}

function aliveAdds(fight) {
  let n = 0;
  for (const p of fight.parts) if (p.kind === "add" && p.hp > 0) n++;
  return n;
}

// Fraction of the main pool left (all non-add parts except tentacles).
function poolFrac(fight) {
  let hp = 0;
  for (const p of fight.parts) if (p.kind === "boss" || p.kind === "head" || p.kind === "service") hp += Math.max(0, p.hp);
  return fight.pool > 0 ? hp / fight.pool : 0;
}

function setupParts(fight, woundFrac) {
  const enc = fight._enc;
  const pool = poolHP(enc, fight.n);
  fight.pool = pool;
  const left = (x) => Math.max(1, Math.round(x * (1 - woundFrac)));
  const id = enc.id;
  if (enc.kind !== "review" && id === "deadlock_hydra") {
    const half = Math.round(pool / 2);
    fight.parts.push(newPart(fight, CODE_HEAD, 0, half), newPart(fight, CODE_HEAD, 1, half));
    for (const p of fight.parts) p.hp = left(p.maxHp);
  } else {
    const body = newPart(fight, CODE_BODY, 0, pool);
    body.hp = left(pool);
    fight.parts.push(body);
    if (enc.kind !== "review" && id === "octopus_merge") {
      const mech = enc.def.mechanics[0];
      const arm = Math.round(pool * mech.partHpPctOfBody);
      for (let i = 0; i < mech.parts; i++) fight.parts.push(newPart(fight, CODE_TENTACLE, i, arm));
    }
  }
}

function newFight(world, enc, heroIds, helpers) {
  const rt = world.rt;
  const fight = {
    key: `fight:${rt.tick}:${enc.kind}:${enc.idx}`, kind: enc.kind,
    bossIdx: enc.kind === "review" ? -1 : enc.bossIdx, reviewIdx: enc.kind === "review" ? enc.idx : -1,
    id: enc.id, name: enc.name, level: enc.level, zone: enc.zone, floor: enc.floor,
    heroIds: heroIds.slice(), helpers: (helpers || []).slice(), n: heroIds.length,
    parts: [], phase: 1, phaseLabel: "", mechText: "", t: 0, timer: enc.timer + warRoom(world.state),
    enraged: false, invuln: false, segments: 1, mech: {}, startedTick: rt.tick, idle: 0, dealt: 0,
    lessons: 0, banner: null, stamp: null, result: null, addSeq: 0, pool: 0,
    swing: 0, swingEvery: B.swingEvery,
  };
  Object.defineProperty(fight, "_enc", { value: enc, enumerable: false, writable: true });
  Object.defineProperty(fight, "_herd", { value: world.state.herd, enumerable: false, writable: true });
  return fight;
}

function initFight(world, fight) {
  const enc = fight._enc;
  const key = woundKey(fight.kind, enc.idx, fight.heroIds[0]);
  fight.lessons = lessonsOf(world, key);
  if (enc.kind === "review") {
    fight.swing = Math.round(enc.review.ak * mobATK(enc.level));
    fight.swingEvery = enc.review.swingEvery;
    fight.segments = enc.review.phases ? enc.review.phases.length : 1;
    fight.phaseLabel = enc.review.phases ? enc.review.phases[0] : "";
  } else {
    fight.swing = Math.round(bossSwing(enc.def.ak, enc.level) * enc.atkMult);
  }
  const kit = kitOf(fight);
  if (kit.init) kit.init(world, fight);
}

/**
 * Starts a fight (or resumes the suspended one of the same boss). heroIds: the participants
 * (null: picked by participants() / the review hero). Coffee is refilled before every fight
 * (D§5.6). The fight is pushed on rt.fights and, for bosses, mirrored into herd.fight.
 * @returns {object|null} Fight
 */
export function startFight(world, kind, idx, heroIds, ev) {
  const { state, rt } = world;
  const saved = state.herd.fight;
  if (kind !== "review" && saved && !bossFightRunning(world)) {
    if (savedMatches(saved, kind, idx)) return resumeFight(world, ev, heroIds && heroIds.length ? heroIds : null);
    // another boss's paused fight closes as a Postmortem (its Wounds are kept: nothing is lost)
    abandonSaved(world, ev);
  }
  const enc = encounter(kind, idx);
  if (!enc) return null;
  let ids = heroIds && heroIds.length ? heroIds.slice() : null;
  let helpers = [];
  if (!ids) {
    if (kind === "review") {
      const hero = reviewHero(world, idx, null);
      ids = hero ? [hero.id] : [];
    } else {
      const p = participants(world, kind, idx);
      ids = p.heroIds;
      helpers = p.helpers;
    }
  } else if (kind === "boss") {
    const p = participants(world, kind, idx);
    helpers = ids.filter((id) => p.helpers.indexOf(id) >= 0);
  }
  ids = ids.filter((id) => findHero(world, id) && !fightOf(world, id));
  if (!ids.length) return null;
  const fight = newFight(world, enc, ids, helpers);
  const key = woundKey(kind, enc.idx, ids[0]);
  setupParts(fight, woundsOf(world, key).frac);
  initFight(world, fight);
  for (const id of ids) {
    const hero = findHero(world, id);
    refillCoffee(world, hero);
    const live = rt.live.get(id);
    if (live) {
      live.crashedUntil = 0;
      if (!(live.hp > 0)) live.hp = (live.maxHp || 1) * T.crash.returnHp;
    }
  }
  rt.fights.push(fight);
  if (rt._cg && rt._cg.fighting) for (const id of ids) rt._cg.fighting.add(id);
  fight.banner = { key: `${fight.key}:in`, text: fight.name, sub: enc.kind === "review" ? enc.review.id === "senior_review" ? "Senior Review" : "Staff Review" : enc.def.flavor, tick: rt.tick };
  if (kind !== "review") state.herd.fight = packFight(fight);
  if (kind === "review") {
    const hero = findHero(world, ids[0]);
    note(ev, `REVIEW: ${hero.name} vs ${fight.name}`);
  } else {
    if (ev && typeof ev.banner === "function") ev.banner(fight.name, fight.banner.sub);
  }
  major(ev);
  return fight;
}

// ---------------------------------------------------------------------------------------------
// Suspend / resume (D§9.5, D§13.1)
// ---------------------------------------------------------------------------------------------

function savedMatches(saved, kind, idx) {
  return saved && ((kind === "boss" && saved.k === "b" && saved.i === idx) || (kind === "backlog" && saved.k === "x" && saved.f === idx));
}

/** Compact, JSON-safe form of a boss fight for herd.fight (D§13.2 "suspended fight"). */
export function packFight(f) {
  const p = [];
  for (const part of f.parts) {
    const row = [part.code, Math.round(part.hp), Math.round(part.maxHp)];
    if (part.kind === "add") row.push(part.next, part.atk);
    p.push(row);
  }
  const out = {
    k: f.kind === "backlog" ? "x" : "b", i: f.bossIdx, ids: f.heroIds.slice(), t: f.t, ph: f.phase, p,
    m: Object.assign({}, f.mech), pool: Math.round(f.pool), dl: Math.round(f.dealt), sq: f.addSeq,
  };
  if (f.kind === "backlog") out.f = f.floor;
  if (f.helpers.length) out.hl = f.helpers.slice();
  if (f.n !== f.heroIds.length) out.n = f.n;
  if (f.enraged) out.en = 1;
  if (f.invuln) out.iv = 1;
  if (f.idle) out.idle = f.idle;
  // the phase label is not always re-derived by the kit's tick (Monolith phase 3, Friday Deploy,
  // Heisenbug stance), so a resumed fight would show its opening label
  if (f.phaseLabel) out.pl = f.phaseLabel;
  return out;
}

/** Rebuilds a Fight from its packed form (inverse of packFight). */
export function unpackFight(world, s) {
  if (!s || (s.k !== "b" && s.k !== "x")) return null;
  const enc = s.k === "x" ? encounter("backlog", s.f) : encounter("boss", s.i);
  if (!enc) return null;
  const ids = Array.isArray(s.ids) ? s.ids.slice() : [];
  const fight = newFight(world, enc, ids, Array.isArray(s.hl) ? s.hl : []);
  fight.key = `fight:${world.rt.tick}:${enc.kind}:${enc.idx}`;
  fight.n = s.n || ids.length;
  fight.t = s.t || 0;
  fight.phase = s.ph || 1;
  fight.enraged = !!s.en;
  fight.idle = 0;
  fight.dealt = s.dl || 0;
  fight.addSeq = s.sq || 0;
  fight.pool = s.pool || poolHP(enc, fight.n);
  initFight(world, fight);
  fight.mech = Object.assign(fight.mech, s.m || {});
  if (typeof s.pl === "string") fight.phaseLabel = s.pl;
  fight.invuln = !!s.iv;
  fight.parts = [];
  const counts = {};
  let addOrd = 0;
  for (const row of s.p || []) {
    const code = row[0];
    // adds keep unique ordinals below the saved add sequence; body parts count per kind
    const ord = code >= CODE_ADD ? ++addOrd : (counts[code] = (counts[code] ?? -1) + 1);
    const part = newPart(fight, code, ord, row[2]);
    part.hp = row[1];
    if (code >= CODE_ADD) {
      part.next = row[3] || 0;
      part.atk = row[4] || 0;
      part.every = swingEveryOf(ADD_KINDS[code - CODE_ADD]);
    }
    fight.parts.push(part);
  }
  if (fight.addSeq < addOrd) fight.addSeq = addOrd;
  return fight;
}

/**
 * Resumes the suspended fight in herd.fight once one of its participants works in the fight's zone
 * again (D§9.5), or with the given heroIds (a Challenge: any of them Questing). Participants that
 * left the roster drop out, and so does one now Questing in another zone (a pinned map elsewhere is
 * never pulled in). Answer-calls helpers joined from anywhere, so a saved helper Questing anywhere
 * counts (repeat-kill fights are mostly helpers). Questing heroes standing in the zone may take the
 * empty seats, then helpers. Returns the fight (pushed on rt.fights) or null.
 */
export function resumeFight(world, ev, heroIds) {
  const { state, rt } = world;
  const s = state.herd.fight;
  if (!s || bossFightRunning(world)) return null;
  const fight = unpackFight(world, s);
  if (!fight) { state.herd.fight = null; return null; }
  const explicit = !!(heroIds && heroIds.length);
  const want = explicit ? heroIds : fight.heroIds;
  let ids = want.filter((id) => findHero(world, id) && !fightOf(world, id));
  const inZone = (id) => {
    const live = rt.live.get(id);
    return questingNow(live) && zoneOf(heroMapId(findHero(world, id), live)) === fight.zone;
  };
  const helpers = new Set(fight.helpers);
  const wakes = (id) => inZone(id) || (helpers.has(id) && questingNow(rt.live.get(id)));
  if (!explicit) {
    ids = ids.filter((id) => !questingNow(rt.live.get(id)) || wakes(id));
    fight.helpers = fight.helpers.filter((id) => ids.indexOf(id) >= 0);
  }
  let p = null;
  if (!explicit && !ids.some(wakes)) {
    // anyone else working in the zone takes the empty seats
    p = participants(world, fight.kind, fight.kind === "backlog" ? fight.floor : fight.bossIdx);
    for (const id of p.heroIds) if (ids.indexOf(id) < 0 && ids.length < B.maxParticipants && inZone(id)) ids.push(id);
  }
  ids = ids.filter((id) => findHero(world, id));
  const any = explicit ? ids.some((id) => questingNow(rt.live.get(id))) : ids.some(wakes);
  if (!any) return null;
  // the fight is back: Answer-calls helpers may fill what is left (D§9.5)
  if (p) {
    for (const id of p.helpers) {
      if (ids.indexOf(id) >= 0 || ids.length >= B.maxParticipants) continue;
      ids.push(id);
      fight.helpers.push(id);
    }
  }
  fight.heroIds = ids;
  for (const id of ids) refillCoffee(world, findHero(world, id));
  rt.fights.push(fight);
  if (rt._cg && rt._cg.fighting) for (const id of ids) rt._cg.fighting.add(id);
  fight.banner = { key: `${fight.key}:in`, text: fight.name, sub: "Back to it", tick: rt.tick };
  state.herd.fight = packFight(fight);
  if (ev && typeof ev.banner === "function") ev.banner(fight.name, "Back to it");
  return fight;
}

/**
 * Suspends a running fight at once (world.tick on an offline gap: "the app closes", D§9.5). A boss
 * or Backlog boss fight is saved into herd.fight (HP, phase, timer) and comes back through
 * resumeFight() once a participant works again; a review is simply called off (never a loss).
 * @returns {"suspended"|null}
 */
export function suspendFight(world, fight, ev) {
  if (!fight || fight.result || world.rt.fights.indexOf(fight) < 0) return null;
  return endFight(world, fight, "suspended", ev);
}

// Turns the paused fight in herd.fight into a Postmortem.
function abandonSaved(world, ev) {
  const f = unpackFight(world, world.state.herd.fight);
  world.state.herd.fight = null;
  if (f) endFight(world, f, "lost", ev);
}

// Coffee is refilled before every fight (D§5.6), at the usual price per cup (as far as the herd's
// gold goes: a broke herd still gets its coffee).
function refillCoffee(world, hero) {
  const missing = T.coffee.carry - (hero.cups || 0);
  if (missing <= 0) return;
  const herd = world.state.herd;
  const price = coffeePrice(hero.L, (herd.bld || [])[BUILDING_IDX.coffee_machine] || 0) * missing;
  Herd.addGold(world.state, -Math.min(price, herd.gold || 0));
  hero.cups = T.coffee.carry;
}

function removeFight(world, fight) {
  const list = world.rt.fights;
  const i = list.indexOf(fight);
  if (i >= 0) list.splice(i, 1);
  const g = world.rt._cg;
  if (g && g.fighting) for (const id of fight.heroIds) g.fighting.delete(id);
}

/**
 * Ends a fight as a Postmortem (the `retreat` command): the given hero's fight (boss or review),
 * else the running boss fight, else the paused one in herd.fight.
 */
export function retreat(world, ev, heroId) {
  for (const f of world.rt.fights.slice()) {
    if (heroId != null ? f.heroIds.indexOf(heroId) < 0 : f.kind === "review") continue;
    endFight(world, f, "lost", ev);
    return { ok: true, msg: "Postmortem" };
  }
  if (heroId == null && world.state.herd.fight) {
    abandonSaved(world, ev);
    return { ok: true, msg: "Postmortem" };
  }
  return { ok: false, error: "No fight" };
}

// ---------------------------------------------------------------------------------------------
// Boss kits: one set of mechanic hooks per encounter
//   init(world, fight)       extra state in fight.mech
//   target(fight)            single-target part (adds first when kit.addsFirst or the boss is invulnerable)
//   order(fight, out)        area order of the boss parts
//   mod(fight, C, part, amt, flags) -> amt   damage modifiers on boss parts
//   after(fight, part, dealt)                bookkeeping per hit
//   tick(world, fight, A, n, ev)              mechanics after the heroes act (A: actors)
//   hold(fight) -> boolean                   burst window (heroes hold Ultimate and Buff)
//   dmg(fight) -> extra damage fraction of the boss's own attacks
//   basic(fight) -> boolean                  does the boss make its basic attack
// ---------------------------------------------------------------------------------------------

const F_AREA = 1;
const SINGLE = (flags) => (flags & F_AREA) === 0;

function body(fight) {
  for (const p of fight.parts) if (p.kind === "boss") return p;
  return null;
}

function ignoreOf(C) {
  return Math.min(1, C.st.ignoreBossDr || 0);
}

const GENERIC = {
  target: (fight) => body(fight),
  order(fight, out) { for (const p of fight.parts) if (p.kind !== "add" && p.hp > 0) out.push(p); },
  mod: (fight, C, part, amt) => amt,
  after() {},
  tick() {},
  hold: () => false,
  dmg: () => 0,
  basic: () => true,
};

const KITS = {
  // 1. The Ignored Warning: "+1 warning" mites (+10% boss damage each), then "Promoted to Error"
  ignored_warning: {
    addsFirst: true,
    init(world, f) { f.mech = { p2: 0, angry: 0 }; f.phaseLabel = ""; },
    mod(fight, C, part, amt) {
      if (fight.mech.p2 && !fight.mech.angry) { invHit(C, part); return 0; }
      return amt;
    },
    tick(world, f, A, n, ev) {
      const [m1, m2] = f._enc.def.mechanics;
      const hp = poolFrac(f);
      if (!f.mech.p2 && hp < m1.to) {
        f.mech.p2 = 1;
        f.phase = 2;
        f.phaseLabel = m2.label;
        spawnAdd(f, m2.add, m2.count);
        note(ev, `${f.name}: ${m2.label}`);
      } else if (!f.mech.p2 && f.t % m1.every === 0 && aliveAdds(f) < m1.maxAlive) {
        spawnAdd(f, m1.add, 1);
        f.mech.warnAt = f.t;
      }
      if (f.mech.p2 && !f.mech.angry && aliveAdds(f) < m2.invulnWhileAddsAtLeast) f.mech.angry = 1;
      f.invuln = !!(f.mech.p2 && !f.mech.angry);
      // "+1 warning" stays up for 3 ticks after a mite joins (like a header note), then the count
      const fresh = !f.mech.p2 && f.mech.warnAt != null && f.t - f.mech.warnAt < 3;
      f.mechText = f.mech.p2 ? (f.invuln ? `Promoted to Error: ${aliveAdds(f)} mites` : "Error")
        : fresh ? `+1 warning (${aliveAdds(f)})` : `${999 + aliveAdds(f)}+ warnings`;
    },
    dmg(f) {
      const [m1, m2] = f._enc.def.mechanics;
      return f.mech.p2 ? (f.mech.angry ? m2.dmgAfter : 0) : m1.bossDmgPerAdd * aliveAdds(f);
    },
  },

  // 2. The Pyramid of Doom: 3 layers (overkill wasted); each break: await (6 ticks 403, 3 bats),
  //    then resolve() hits everyone for 20% (5% if the bats are dead); the last layer hits 30% harder
  pyramid_of_doom: {
    init(world, f) {
      const b = body(f);
      const lost = b ? 1 - b.hp / b.maxHp : 0;
      f.mech = { layer: Math.min(2, Math.floor(lost * 3 + 1e-9)), wait: 0, brk: 0 };
      f.segments = 3;
    },
    mod(f, C, part, amt) {
      if (part.kind !== "boss") return amt;
      if (f.mech.wait > 0) { invHit(C, part); return 0; }
      if (f.mech.layer < 2) {
        const floor = Math.round(part.maxHp * (2 - f.mech.layer) / 3);
        const room = part.hp - floor;
        if (room <= 0) { invHit(C, part); return 0; }
        if (amt >= room) { f.mech.brk = 1; return room; } // overkill on a layer is wasted
      }
      return amt;
    },
    tick(world, f, A, n, ev) {
      const [, brk] = f._enc.def.mechanics;
      if (f.mech.brk) {
        f.mech.brk = 0;
        f.mech.layer++;
        f.mech.wait = brk.invulnTicks;
        f.phase = f.mech.layer + 1;
        spawnAdd(f, brk.add, brk.add.count);
        f.phaseLabel = brk.label;
      } else if (f.mech.wait > 0) {
        f.mech.wait--;
        if (f.mech.wait === 0) {
          const pct = aliveAdds(f) === 0 ? brk.then.ifAddsDead : brk.then.hitAllPctMaxHp;
          for (let i = 0; i < n; i++) pctHit(A[i], pct, f.level);
          f.phaseLabel = brk.then.label;
          note(ev, `${f.name}: resolve() ${Math.round(pct * 100)}%`);
        }
      }
      f.invuln = f.mech.wait > 0;
      f.mechText = f.mech.wait > 0 ? `await... ${f.mech.wait}` : `layer ${f.mech.layer + 1}/3`;
    },
    dmg(f) { return f.mech.layer >= 2 ? f._enc.def.mechanics[2].dmg : 0; },
  },

  // 3. The Catastrophic Backtracker: every 25 ticks (18 below 30%) "Trying again..." for 5 ticks;
  //    5% of max HP during it Anchors it (3 ticks stunned, +20% taken), else it heals 50% of the
  //    damage it took in the previous 15 ticks
  catastrophic_backtracker: {
    init(world, f) {
      const m = f._enc.def.mechanics[0];
      f.mech = { next: m.every, tel: 0, got: 0, stun: 0, anch: 0, cur: 0, hist: new Array(m.fail.windowTicks).fill(0), hi: 0, tries: 0 };
    },
    mod(f, C, part, amt) { return f.mech.anch > 0 ? amt * (1 + f._enc.def.mechanics[0].success.dmgTaken) : amt; },
    after(f, part, dealt) { if (part.kind === "boss") { f.mech.cur += dealt; if (f.mech.tel > 0) f.mech.got += dealt; } },
    // burst window (D§7.1): hold through the tick the telegraph starts on (d = 0): kit.tick opens
    // it after the heroes act, so damage only counts from the next tick on
    hold(f) { const d = f.mech.next - f.t; return f.mech.tel === 0 && d >= 0 && d <= 4; },
    tick(world, f, A, n, ev) {
      const m = f._enc.def.mechanics[0];
      const me = f.mech;
      me.hist[me.hi] = me.cur;
      me.hi = (me.hi + 1) % me.hist.length;
      me.cur = 0;
      if (me.stun > 0) me.stun--;
      if (me.anch > 0) me.anch--;
      const b = body(f);
      if (me.tel > 0) {
        me.tel--;
        if (me.tel === 0) {
          if (me.got >= m.needPctMaxHp * b.maxHp) {
            me.stun = m.success.stunTicks;
            me.anch = m.success.stunTicks;
            f.phaseLabel = m.success.label;
          } else {
            let sum = 0;
            for (const x of me.hist) sum += x;
            const heal = Math.round(sum * m.fail.healPctOfDamageLast);
            b.hp = Math.min(b.maxHp, b.hp + heal);
            f.phaseLabel = "backtracked";
            if (heal > 0) fx(ev, FX.heal, { mobUid: b.uid, roomId: "arena", value: heal, text: `+${fmtNum(heal)}` });
          }
        }
      } else if (f.t >= me.next) {
        // a telegraph every 25 ticks (18 below 30%), start to start
        me.tel = m.telegraphTicks;
        me.got = 0;
        me.tries++;
        me.next = f.t + (poolFrac(f) < 0.3 ? m.everyBelow30 : m.every);
        f.phaseLabel = m.label;
      }
      f.mechText = me.tel > 0 ? `${m.label} ${"(a+)".repeat(Math.min(4, me.tries))}+$` : me.stun > 0 ? m.success.label : "";
    },
    basic(f) { return f.mech.stun === 0; },
  },

  // 4. The Octopus Merge: 8 tentacles shield the body (-75% while 4+ live), regrow after 20 ticks
  //    (12 below 40%), slap a random hero every 4 ticks for 0.3 swing.
  //    design reading: cut tentacles regrow one at a time (one every 20 / 12 ticks). With a timer
  //    per tentacle, 8 x 5% of the body regrowing every 20 ticks outpaces any solo hero (and a trio)
  //    and the fight could never be won, against D§9.5's 80-140 ticks and mech factor 0.75.
  octopus_merge: {
    init(world, f) { f.mech = { regrowAt: 0 }; },
    target(f) {
      const b = body(f);
      if (tentacles(f) < f._enc.def.mechanics[0].shieldWhileAtLeast) return b;
      let lo = null;
      for (const p of f.parts) if (p.kind === "tentacle" && p.hp > 0 && (!lo || p.hp < lo.hp)) lo = p;
      return lo || b;
    },
    order(f, out) {
      const b = body(f);
      if (b && b.hp > 0) out.push(b);
      for (const p of f.parts) if (p.kind === "tentacle" && p.hp > 0) out.push(p);
    },
    mod(f, C, part, amt) {
      const m = f._enc.def.mechanics[0];
      if (part.kind === "boss" && tentacles(f) >= m.shieldWhileAtLeast) return amt * (1 + m.bodyDmgTaken * (1 - ignoreOf(C)));
      return amt;
    },
    tick(world, f, A, n, ev) {
      const m = f._enc.def.mechanics[0];
      const below = poolFrac(f) < 0.4;
      const period = below ? m.regrowTicksBelow40 : m.regrowTicks;
      let cut = null;
      let ncut = 0;
      for (const p of f.parts) {
        if (p.kind !== "tentacle") continue;
        if (p.hp <= 0) {
          p.hp = 0;
          ncut++;
          if (!cut) cut = p;
        } else if (n > 0 && f.t % m.partAttack.every === p.ord % m.partAttack.every) {
          const C = A[rngInt(world.state.herd, 0, n - 1)];
          bossHit(f, C, f.swing * m.partAttack.pctOfSwing);
        }
      }
      if (!ncut) f.mech.regrowAt = 0;
      else if (!f.mech.regrowAt) f.mech.regrowAt = f.t + period;
      else if (f.t >= f.mech.regrowAt) {
        cut.hp = cut.maxHp;
        f.mech.regrowAt = ncut > 1 ? f.t + period : 0;
      }
      const k = tentacles(f);
      f.invuln = false;
      f.mechText = k >= m.shieldWhileAtLeast ? m.label.replace("{n}", String(k)) : below ? "Fast-forward" : `${k} ${k === 1 ? "branch" : "branches"} left`;
    },
  },

  // 5. Bloatodon: installs a dependency every 12 ticks (+4% max HP, 4% heal), 3 Left-Pad Mites every
  //    30 ticks (+5% DR each, max 20%); enrages at 10 deps
  bloatodon: {
    init(world, f) { f.mech = { deps: 0, base: f.pool }; },
    mod(f, C, part, amt) {
      if (part.kind !== "boss") return amt;
      const m = f._enc.def.mechanics[1];
      const dr = Math.min(m.drCap, m.drPerAdd * aliveAdds(f)) * (1 - ignoreOf(C));
      return amt * (1 - dr);
    },
    tick(world, f, A, n, ev) {
      const [grow, adds, cap] = f._enc.def.mechanics;
      const b = body(f);
      if (f.t % grow.every === 0 && f.mech.deps < cap.counter) {
        // +4% max HP (of the starting pool; the raised cap starts empty) and a 4% heal of what it
        // has left. design reading: a 4%-of-max heal every 12 ticks out-heals a third of an
        // on-level hero's damage and no solo class but the Hotfixer could finish in 180 ticks
        // (D§9.5 expects 80-140 and mech 0.8). Installing stops at "Install complete" (10 deps).
        f.mech.deps++;
        const add = Math.round(f.mech.base * grow.maxHpPct);
        b.maxHp += add;
        b.hp = Math.min(b.maxHp, b.hp + Math.round(b.hp * grow.healPct));
        f.pool += add;
      }
      if (f.t % adds.every === 0) spawnAdd(f, adds.add, adds.add.count);
      if (!f.enraged && f.mech.deps >= cap.counter) enrage(f, ev);
      f.mechText = grow.counter.replace("{n}", String(f.mech.deps));
    },
  },

  // 6. The Deadlock Hydra: Mutex and Semaphore. Single-target hits go to the head with the higher
  //    HP%; more than 10 points apart, the lower one waits (403) until the gap is 5. Every 40 ticks
  //    a 3-tick "Deadlock" check: within 5 points it is Resolved (4 ticks stunned, +25% taken),
  //    else the party waits 3 ticks. Each head bites every 3 ticks (2 enraged) for 0.6 swing.
  deadlock_hydra: {
    init(world, f) {
      const m = f._enc.def.mechanics[1];
      f.mech = { next: m.every, tel: 0, stun: 0, res: 0, wait: 0, low: -1 };
      f.segments = 2;
    },
    target(f) {
      let best = null;
      for (const p of f.parts) if (p.kind === "head" && p.hp > 0 && (!best || p.hp / p.maxHp > best.hp / best.maxHp)) best = p;
      return best;
    },
    mod(f, C, part, amt) {
      if (part.kind !== "head") return amt;
      if (f.mech.low === part.ord) { invHit(C, part); return 0; }
      return f.mech.res > 0 ? amt * (1 + f._enc.def.mechanics[1].success.dmgTaken) : amt;
    },
    hold(f) { const d = f.mech.next - f.t; return f.mech.tel === 0 && d >= 0 && d <= 4; },
    tick(world, f, A, n, ev) {
      const [heads, chk] = f._enc.def.mechanics;
      const me = f.mech;
      if (me.stun > 0) me.stun--;
      if (me.res > 0) me.res--;
      if (me.wait > 0) me.wait--;
      const h = f.parts.filter((p) => p.kind === "head");
      const pa = Math.max(0, h[0].hp) / h[0].maxHp * 100;
      const pb = Math.max(0, h[1].hp) / h[1].maxHp * 100;
      const gapPts = Math.abs(pa - pb);
      const lower = pa < pb ? 0 : 1;
      if (h[0].hp > 0 && h[1].hp > 0) {
        if (me.low < 0 && gapPts > heads.waitingGapPts) me.low = lower;
        else if (me.low >= 0 && gapPts <= heads.resumeGapPts) me.low = -1;
      } else {
        me.low = -1;
      }
      if (me.tel > 0) {
        me.tel--;
        if (me.tel === 0) {
          if (gapPts <= chk.withinPts) {
            me.stun = chk.success.stunTicks;
            me.res = chk.success.stunTicks;
            f.phaseLabel = chk.success.label;
          } else {
            me.wait = chk.fail.partyWaitTicks;
            f.phaseLabel = "Deadlocked";
          }
        }
      } else if (f.t >= me.next) {
        // a 3-tick telegraph every 40 ticks, start to start
        me.tel = chk.telegraphTicks;
        me.next = f.t + chk.every;
        f.phaseLabel = chk.label;
      }
      // bites
      const every = f.enraged ? f._enc.def.enrage.biteEvery : heads.biteEvery;
      if (me.stun === 0) {
        for (const p of h) {
          if (p.hp <= 0 || n === 0) continue;
          if (f.t % every === p.ord % every) bossHit(f, frontOf(A, n), f.swing * heads.bitePctOfSwing);
        }
      }
      f.invuln = false;
      f.mechText = me.tel > 0 ? `Deadlock in ${me.tel}` : `${heads.heads[0]} ${Math.round(pa)}% · ${heads.heads[1]} ${Math.round(pb)}%`;
    },
    basic: () => false,
    waiting(f) { return f.mech.wait > 0; },
  },

  // 7. The Monolith: Tightly Coupled (-25% single target, Slam every 4 ticks for 0.8 swing to all),
  //    then Decompose at 60% into 6 Microservices that heal each other (Service Mesh), attack a
  //    random hero every 5 ticks; the last one is a Distributed Monolith (+100%, every 2 ticks)
  monolith: {
    init(world, f) { f.mech = { split: 0, last: 0 }; f.phaseLabel = f._enc.def.mechanics[0].label; },
    target(f) {
      if (!f.mech.split) return body(f);
      let lo = null;
      for (const p of f.parts) if (p.kind === "service" && p.hp > 0 && (!lo || p.hp < lo.hp)) lo = p;
      return lo;
    },
    order(f, out) {
      if (!f.mech.split) { const b = body(f); if (b && b.hp > 0) out.push(b); return; }
      const s = f.parts.filter((p) => p.kind === "service" && p.hp > 0).sort((a, b) => a.hp - b.hp);
      for (const p of s) out.push(p);
    },
    mod(f, C, part, amt, flags) {
      const p1 = f._enc.def.mechanics[0];
      if (!f.mech.split && part.kind === "boss" && SINGLE(flags)) return amt * (1 + p1.singleTargetDmgTaken * (1 - ignoreOf(C)));
      return amt;
    },
    tick(world, f, A, n, ev) {
      const [p1, p2, p3] = f._enc.def.mechanics;
      if (!f.mech.split) {
        const b = body(f);
        if (b.hp / b.maxHp < p1.to) {
          // Decompose: 6 services share the remaining pool
          f.mech.split = 1;
          f.phase = 2;
          f.phaseLabel = p2.label;
          const each = Math.max(1, Math.round(b.hp / p2.split));
          b.hp = 0;
          for (let i = 0; i < p2.split; i++) {
            const s = newPart(f, CODE_SERVICE, i, each);
            f.parts.push(s);
          }
          note(ev, `${f.name}: ${p2.label}`);
        } else if (f.t % p1.slam.every === 0) {
          for (let i = 0; i < n; i++) bossHit(f, A[i], f.swing * p1.slam.pctOfSwing);
        }
      } else {
        const alive = f.parts.filter((p) => p.kind === "service" && p.hp > 0);
        if (alive.length > 1) {
          for (const s of alive) s.hp = Math.min(s.maxHp, s.hp + Math.round((alive.length - 1) * p2.meshHealPctPerOtherPerTick * s.maxHp));
          for (const s of alive) {
            if (n > 0 && f.t % p2.partAttack.every === s.ord % p2.partAttack.every) {
              bossHit(f, A[rngInt(world.state.herd, 0, n - 1)], f.swing * p2.partAttack.pctOfSwing);
            }
          }
        } else if (alive.length === 1) {
          if (!f.mech.last) { f.mech.last = 1; f.phase = 3; f.phaseLabel = p3.label; note(ev, `${f.name}: ${p3.label}`); }
          if (n > 0 && f.t % p3.swingEvery === 0) bossHit(f, frontOf(A, n), f.swing);
        }
        f.mechText = alive.length > 1 ? `Service Mesh: ${alive.length} services` : p3.label;
      }
    },
    basic: () => false,
    dmg(f) { return f.mech.last ? f._enc.def.mechanics[2].dmg : 0; },
  },

  // 8. The Friday Deploy: the 4:55 -> 5:00 PM clock (30 ticks) ends in Outage Breath (30% max HP,
  //    DR at half value; 45% enraged); 66-33%: 2 Pager Wyverns every 25 ticks (+25% clock speed
  //    each); below 33%: Long Weekend (20-tick clock, "Ship It" +25% party damage)
  friday_deploy: {
    init(world, f) { f.mech = { clock: 0, wyv: 0 }; f.phaseLabel = ""; },
    tick(world, f, A, n, ev) {
      const [clock, p2, p3] = f._enc.def.mechanics;
      const hp = poolFrac(f);
      const phase = hp < p3.from ? 3 : hp < p2.from ? 2 : 1;
      if (phase !== f.phase) {
        f.phase = phase;
        f.phaseLabel = phase === 3 ? p3.label : p2.label;
        if (phase === 2) f.mech.wyv = f.t;
        note(ev, `${f.name}: ${f.phaseLabel}`);
      }
      if (phase === 2 && f.t > f.mech.wyv && (f.t - f.mech.wyv) % p2.every === 0) spawnAdd(f, p2.add, p2.add.count);
      const len = phase === 3 ? p3.clockTicks : clock.ticks;
      f.mech.clock += 1 + p2.clockSpeedPerAdd * aliveAdds(f);
      if (f.mech.clock >= len) {
        f.mech.clock = 0;
        const pct = f.enraged ? f._enc.def.enrage.outagePct : clock.onZero.hitAllPctMaxHp;
        for (let i = 0; i < n; i++) pctHit(A[i], pct, f.level, clock.onZero.drFactor);
        note(ev, clock.onZero.name); // never "!": it is reserved for blocked agents (D§11.1)
      }
      const min = Math.min(59, 55 + Math.floor((f.mech.clock / len) * 5));
      f.mechText = `${min === 60 ? "5:00" : `4:${min}`} PM`;
    },
    party(f) { return f.phase === 3 ? f._enc.def.mechanics[2].partyDmg : 0; },
  },

  // 9. The Heisenbug: every 20 ticks (10 enraged) teleports and swaps Position (single x1.5, area
  //    x0.5) / Momentum (area x1.5, single x0.5); Wavefunction pulse every 30 ticks (15% max HP);
  //    being observed (a participant's terminal focused) delays the next teleport by 5 ticks
  heisenbug: {
    init(world, f) { f.mech = { stance: 0, next: f._enc.def.mechanics[0].every, seen: 0 }; f.phaseLabel = f._enc.def.mechanics[0].states[0].name; },
    mod(f, C, part, amt, flags) {
      if (part.kind !== "boss") return amt;
      const s = f._enc.def.mechanics[0].states[f.mech.stance];
      return amt * (SINGLE(flags) ? s.singleTargetMult : s.areaMult);
    },
    tick(world, f, A, n, ev) {
      const [stance, pulse, obs] = f._enc.def.mechanics;
      let observed = false;
      for (let i = 0; i < n; i++) if (A[i].live.focused) { observed = true; break; }
      f.mech.observed = observed ? 1 : 0;
      if (observed && !f.mech.seen) { f.mech.seen = 1; f.mech.next += obs.delayNextStanceTicks; }
      if (f.t >= f.mech.next) {
        f.mech.stance = 1 - f.mech.stance;
        f.mech.next = f.t + (f.enraged ? f._enc.def.enrage.stanceEvery : stance.every);
        f.mech.seen = 0;
        f.phaseLabel = stance.states[f.mech.stance].name;
      }
      if (f.t % pulse.every === 0) for (let i = 0; i < n; i++) pctHit(A[i], pulse.hitAllPctMaxHp, f.level);
      f.mechText = `${stance.states[f.mech.stance].name}${observed ? " (observed)" : ""}`;
    },
  },

  // Senior Review: "You, Six Months Ago"; a bubble at 50%
  senior_review: {
    init(world, f) { f.mech = { said: 0 }; },
    tick(world, f, A, n, ev) {
      const r = f._enc.review;
      if (!f.mech.said && poolFrac(f) <= r.bubbleAt) {
        f.mech.said = 1;
        f.mechText = r.bubble;
        note(ev, `"${r.bubble}"`);
      }
    },
  },

  // Staff Review: "The Senior Reviewer" in 3 phases; each phase change brings 2 Nitpicks, and the
  // Reviewer takes -50% damage while any Nitpick lives
  staff_review: {
    addsFirst: true,
    init(world, f) { f.mech = {}; },
    mod(f, C, part, amt) {
      if (part.kind === "boss" && aliveAdds(f) > 0) return amt * (1 + f._enc.review.onPhase.dmgTakenWhileAdds * (1 - ignoreOf(C)));
      return amt;
    },
    tick(world, f, A, n, ev) {
      const r = f._enc.review;
      const k = r.phases.length;
      const phase = Math.min(k, 1 + Math.floor((1 - poolFrac(f)) * k + 1e-9));
      if (phase > f.phase) {
        f.phase = phase;
        f.phaseLabel = r.phases[phase - 1];
        spawnAdd(f, r.onPhase.add, r.onPhase.add.count);
      }
      f.mechText = aliveAdds(f) > 0 ? `${aliveAdds(f)} nitpicks` : f.phaseLabel;
    },
  },
};

function kitOf(fight) {
  const k = fight._kit;
  if (k) return k;
  const own = KITS[fight.id] || {};
  const kit = Object.assign({}, GENERIC, own);
  Object.defineProperty(fight, "_kit", { value: kit, enumerable: false, writable: true });
  return kit;
}

function tentacles(f) {
  let k = 0;
  for (const p of f.parts) if (p.kind === "tentacle" && p.hp > 0) k++;
  return k;
}

function invHit(C, part) {
  if (C.invUid === null) C.invUid = part.uid;
}

function enrage(f, ev) {
  if (f.enraged) return;
  f.enraged = true;
  const e = f._enc.def && f._enc.def.enrage;
  const name = e ? e.name : "Out of patience";
  f.phaseLabel = name;
  note(ev, `${f.name}: ${name}`, "#FF5A5F");
}

// ---------------------------------------------------------------------------------------------
// The encounter loop
// ---------------------------------------------------------------------------------------------

// The arena combat.js hits through. Area order: adds (live ones), then the kit's part order.
function arenaOf(fight) {
  let a = fight._arena;
  if (!a) {
    const kit = kitOf(fight);
    a = {
      boss: true, list: [], count: 0, main: null, anyElite: false,
      mod(C, part, amt, flags) {
        if (part.kind === "add") return amt;
        const v = kit.mod(fight, C, part, amt, flags);
        return v > 0 ? Math.max(1, Math.round(v)) : 0;
      },
      after(C, part, dealt, flags) {
        if (part.kind !== "add" && part.kind !== "tentacle") fight.dealt += dealt;
        kit.after(fight, part, dealt, flags);
      },
      invulnerable: (part) => part.kind !== "add" && fight.invuln,
    };
    Object.defineProperty(fight, "_arena", { value: a, enumerable: false, writable: true });
  }
  const kit = kitOf(fight);
  const list = a.list;
  list.length = 0;
  let mainAdd = null;
  for (const p of fight.parts) {
    if (p.kind !== "add" || p.hp <= 0) continue;
    list.push(p);
    if (!mainAdd || p.hp < mainAdd.hp) mainAdd = p;
  }
  kit.order(fight, list);
  a.count = list.length;
  const t = kit.target(fight);
  // single-target hits go to the boss's own target; adds come first when they shield it or the
  // boss is invulnerable (Warning Mites, Nitpicks), else area skills deal with them
  const bossOk = t && t.hp > 0 && !fight.invuln;
  a.main = (kit.addsFirst || !bossOk) && mainAdd ? mainAdd : bossOk ? t : list[0] || null;
  return a;
}

function frontOf(A, n) {
  let best = null;
  for (let i = 0; i < n; i++) {
    const C = A[i];
    if (C.live.crashedUntil > 0) continue;
    if (!best) { best = C; continue; }
    const bf = best.st.bossFront;
    const cf = C.st.bossFront;
    if (cf && !bf) best = C;
    else if (cf === bf && C.live.maxHp > best.live.maxHp) best = C;
  }
  return best;
}

// A boss or part swing at a hero (dodgeable, DR against the boss level), with the boss's damage mods.
function bossHit(f, C, base) {
  if (!C) return 0;
  const kit = kitOf(f);
  let enr = 0;
  if (f.enraged) {
    // the named enrage's damage (+50% unless it changes something else); reviews use the rule
    const e = f._enc.def && f._enc.def.enrage;
    enr = e ? e.dmg || 0 : B.enrageDmg;
  }
  const raw = base * (1 + kit.dmg(f) + enr) * (0.9 + 0.2 * rngNext(f._herd));
  return hitHero(C, raw, f.level);
}

const ACTORS = [];
const INFO = { duck: 0, safety: 0, allies: 0, partyOthers: 0, banner: false, forklings: undefined };

/**
 * One tick of a fight (D§9.5). Blocked participants hold (no damage dealt or taken); idle/done
 * ones have walked out (they may rejoin); when nobody is Questing the timer stands still, and
 * after 10 minutes of that the fight is suspended into herd.fight. Otherwise: timer, enrage at
 * 80%, heroes act (rotation against adds and parts, burst-window holds, helper damage caps),
 * mechanics, boss/part/add attacks on the front hero, regen/coffee/crashes (rejoin after 10
 * ticks), win/loss. A finished or suspended fight is removed from rt.fights.
 * @returns {"running"|"won"|"lost"|"suspended"}
 */
export function stepFight(world, fight, ev) {
  if (fight.result) return fight.result;
  const { state, rt } = world;
  const kit = kitOf(fight);
  // who is here
  let n = 0;
  let questing = 0;
  for (const id of fight.heroIds) {
    const live = rt.live.get(id);
    if (!live || !isActive(live)) continue;
    const hero = findHero(world, id);
    if (!hero) continue;
    ACTORS[n++] = actorFor(world, hero, live, ev, "arena");
    if (questingNow(live)) questing++;
  }
  if (!questing) {
    for (let i = 0; i < n; i++) ACTORS[i] = null;
    fight.idle++;
    // nobody Questing for 10 minutes: a boss fight is suspended into the save; a review is
    // simply called off (no Postmortem: walking away is never a loss)
    if (fight.idle >= B.suspendAfterSec) return endFight(world, fight, "suspended", ev);
    if (fight.kind !== "review") state.herd.fight = packFight(fight);
    return "running";
  }
  fight.idle = 0;
  fight.t++;
  if (!fight.enraged && fight.t >= Math.floor(B.enrageAt * fight.timer)) enrage(fight, ev);
  // price the participants (auras among them, like a room)
  const info = auraRanks(ACTORS, n, INFO);
  info.allies = n - 1;
  const party = kit.party ? kit.party(fight) : 0;
  for (let i = 0; i < n; i++) {
    const C = ACTORS[i];
    C.mates = ACTORS;
    C.nm = n;
    C.live.ct++;
    C.ct = C.live.ct;
    C.extraPct = party;
    prepare(C, info);
    C.bossPct = C.st.bossDmg + fight.lessons;
    C.capLeft = fight.helpers.indexOf(C.hero.id) >= 0 ? refDPS(fight.level + B.helperCapLevels) : Infinity;
  }
  // heroes act
  const hold = kit.hold(fight);
  const waiting = kit.waiting ? kit.waiting(fight) : false;
  for (let i = 0; i < n; i++) {
    const C = ACTORS[i];
    if (C.live.crashedUntil > 0) { reboot(C); continue; }
    if (waiting) continue;
    const acts = questingNow(C.live) || C.ct % 2 === 0;
    C.arena = arenaOf(fight);
    if (!C.arena.main) continue;
    C.hold = hold;
    C.bisectUid = null;
    C.bisectPct = 0;
    const bis = C.sv[4];
    if (acts && bis && bis.usable && bis.type === "stacks") {
      const b = C.live.bisect;
      const uid = C.arena.main.uid;
      if (b.target === uid) b.stacks = Math.min(bis.maxStacks, b.stacks + 1);
      else { b.target = uid; b.stacks = 0; }
      C.bisectUid = uid;
      C.bisectPct = b.stacks * bis.perStack.dmg;
    }
    if (acts) act(C);
    summons(C, acts);
  }
  // Fresh Eyes drains while a participant fights, as in a lane (D§2.2: Questing, 1 min per minute)
  for (let i = 0; i < n; i++) drainFreshEyes(ACTORS[i]);
  // won?
  if (!bossAlive(fight)) {
    for (let i = 0; i < n; i++) flush(ACTORS[i]);
    for (let i = 0; i < n; i++) ACTORS[i] = null;
    return endFight(world, fight, "won", ev);
  }
  // mechanics, then attacks
  const alive = [];
  for (let i = 0; i < n; i++) if (!(ACTORS[i].live.crashedUntil > 0)) alive.push(ACTORS[i]);
  kit.tick(world, fight, alive, alive.length, ev);
  if (fight.parts.some((p) => p.kind === "add" && p.hp <= 0)) fight.parts = fight.parts.filter((p) => !(p.kind === "add" && p.hp <= 0));
  const front = frontOf(ACTORS, n);
  if (front && kit.basic(fight) && fight.t % fight.swingEvery === 0) bossHit(fight, front, fight.swing);
  if (front) {
    for (const p of fight.parts) {
      if (p.kind !== "add" || p.hp <= 0 || !(p.atk > 0)) continue;
      if (fight.t >= p.next) {
        const C = frontOf(ACTORS, n);
        if (C) hitHero(C, p.atk * (0.9 + 0.2 * rngNext(state.herd)), fight.level);
        p.next = fight.t + p.every;
      }
    }
  }
  // upkeep
  let up = 0;
  for (let i = 0; i < n; i++) {
    const C = ACTORS[i];
    if (!(C.live.crashedUntil > 0)) upkeep(C, T.regen.engaged, B.crashRejoinTicks);
    if (!(C.live.crashedUntil > 0)) up++;
    flush(C);
  }
  for (let i = 0; i < n; i++) ACTORS[i] = null;
  if (!up) return endFight(world, fight, "lost", ev);
  if (fight.t >= fight.timer) return endFight(world, fight, "lost", ev);
  if (fight.kind !== "review") state.herd.fight = packFight(fight);
  return "running";
}

function bossAlive(f) {
  for (const p of f.parts) if ((p.kind === "boss" || p.kind === "head" || p.kind === "service") && p.hp > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Endings: rewards, Postmortems, suspension
// ---------------------------------------------------------------------------------------------

function endFight(world, fight, result, ev) {
  const { state, rt } = world;
  fight.result = result;
  removeFight(world, fight);
  if (result === "suspended") {
    if (fight.kind !== "review") {
      state.herd.fight = packFight(fight);
      note(ev, `${fight.name}: fight paused until someone works in the zone`);
    }
    return result;
  }
  if (fight.kind !== "review") state.herd.fight = null;
  if (result === "won") winFight(world, fight, ev);
  else postmortem(world, fight, ev);
  fight.endTick = rt.tick;
  return result;
}

function postmortem(world, fight, ev) {
  const herd = world.state.herd;
  const key = woundKey(fight.kind, fight.kind === "review" ? fight.reviewIdx : fight.kind === "backlog" ? fight.floor : fight.bossIdx, fight.heroIds[0]);
  if (!herd.wounds) herd.wounds = {};
  if (!herd.lessons) herd.lessons = {};
  const prev = woundsOf(world, key).frac;
  const dealtFrac = fight.pool > 0 ? Math.min(1, fight.dealt / fight.pool) : 0;
  const frac = Math.min(0.9, prev + B.woundsKeep * dealtFrac);
  herd.wounds[key] = [Math.round(frac * 1e4) / 1e4, nowMs(world) + B.woundsSec * 1000, B.retryWorkingSec];
  herd.lessons[key] = Math.min(Math.round(B.lessonsCap / B.lessonsPerFail), (herd.lessons[key] || 0) + 1);
  const lessons = Math.round(lessonsOf(world, key) * 100);
  const text = `Postmortem: ${Math.round(frac * 100)}% wounds kept · Lessons Learned +${lessons}% · retry in ${Math.round(B.retryWorkingSec / 60)} working min`;
  fight.stamp = { key: `${fight.key}:pm`, text: "POSTMORTEM", tick: world.rt.tick };
  note(ev, text);
  jot(world, ev, "boss", fight.heroIds[0], `${fight.name}: Postmortem`, Math.round(frac * 100));
  major(ev);
}

function rewardItem(world, hero, item, ev) {
  offerDrop(world, hero, item, ev);
  fx(ev, FX.loot, { heroId: hero.id, roomId: "arena", rar: item.rar, value: item.uid, text: "" });
  if (typeof Herd.logDrop === "function") Herd.logDrop(world, hero, item, ev);
}

function addSnip(state, n) {
  if (typeof Herd.addSnippets === "function") Herd.addSnippets(state, n);
  else state.herd.snip = (state.herd.snip || 0) + n;
}

function winFight(world, fight, ev) {
  const { state, rt } = world;
  const herd = state.herd;
  fight.stamp = { key: `${fight.key}:fixed`, text: "FIXED", tick: rt.tick };
  fx(ev, FX.stamp, { roomId: "arena", text: "FIXED", value: fight.kind === "review" ? fight.reviewIdx : fight.bossIdx });
  if (fight.kind === "review") return winReviewFight(world, fight, ev);
  const idx = fight.bossIdx;
  const Lb = fight.level;
  const t = itemTier(Lb);
  const first = fight.kind === "boss" && !((herd.boss || [])[idx] > 0);
  const heroes = fight.heroIds.map((id) => findHero(world, id)).filter(Boolean);
  // Keepsake: herd-first kill always, repeats 15% (D§8.6); it goes to the stash
  if (fight.kind === "boss" && (first || rngNext(herd) < 0.15)) {
    const finder = heroes[0];
    const ks = rollKeepsake(herd, { bossIdx: idx, ilvl: Lb, classId: finder ? finder.cls : null, state });
    stashPut(state, ks);
    fx(ev, FX.pillar, { heroId: finder ? finder.id : undefined, roomId: "arena", rar: 5, value: ks.uid, text: KEEPSAKES[ks.prop] ? KEEPSAKES[ks.prop].name : itemName(ks) });
    jot(world, ev, "drop", finder ? finder.id : 0, itemName(ks), 5);
  }
  const w = first ? 60 : 30;
  const sn = (first ? 10 : 5) * t;
  for (const hero of heroes) {
    const st = stats(hero, heroCtx(world, hero));
    const killedBefore = hero.cd && hero.cd.boss && hero.cd.boss[idx] != null;
    if (fight.kind === "boss") {
      if (!hero.cd) hero.cd = { boss: {} };
      if (!hero.cd.boss) hero.cd.boss = {};
      hero.cd.boss[idx] = workSec(hero);
    }
    Herd.addGold(state, w * goldOf(Lb));
    addSnip(state, sn);
    rewardItem(world, hero, rollItem(hero, { ilvl: Lb, source: "boss", first, classId: hero.cls, itemFind: st.itemFind, state }), ev);
    // boss XP follows the level gap like kill XP (D§12.3.4: out-levelled content falls to 10%), so
    // farming long-beaten bosses (D§9.5 repeat kills) cannot outpace on-level work; the Backlog
    // has no gap penalty (D§9.8)
    const gp = fight.kind === "backlog" ? 1 : gap(hero.L - Lb);
    const xp = bossXP(hero.L, !killedBefore) * gp;
    grantXP(state, hero, xp, ev);
    const live = rt.live.get(hero.id);
    if (live && live.tally) live.tally.bossXp = (live.tally.bossXp || 0) + xp;
    if (live) live.hp = live.maxHp;
  }
  if (fight.kind === "backlog") {
    const b = herd.backlog || (herd.backlog = { floor: fight.floor, kills: 0 });
    if (b.floor === fight.floor) { b.floor++; b.kills = 0; }
    delete (herd.wounds || {})[woundKey("backlog", fight.floor)];
    delete (herd.lessons || {})[woundKey("backlog", fight.floor)];
    note(ev, `${fight.name} FIXED · Backlog floor ${b.floor}`);
    jot(world, ev, "boss", heroes[0] ? heroes[0].id : 0, fight.name, fight.floor);
    major(ev);
    return;
  }
  herd.bossKills[idx] = (herd.bossKills[idx] || 0) + 1;
  delete (herd.wounds || {})[String(idx)];
  delete (herd.lessons || {})[String(idx)];
  if (first) {
    herd.boss[idx] = 1; // trophy: +1% damage and max HP for everyone (heroes.stats)
    Herd.noteFirstClear(state, idx, nowMs(world));
    const next = BOSSES[idx].zone + 1;
    if (next >= ZONES.length) {
      herd.zone = Math.max(herd.zone || 0, BACKLOG_ZONE);
      if (!herd.backlog || !(herd.backlog.floor >= 1)) herd.backlog = { floor: 1, kills: 0 };
      if (ev && typeof ev.banner === "function") ev.banner("The herd reached The Backlog", "Endless floors below the Stack");
    } else if (next > (herd.zone || 0)) {
      herd.zone = next;
      herd.meter = 0;
      if (typeof Herd.pourBank === "function") Herd.pourBank(state);
      if (ev && typeof ev.banner === "function") ev.banner(`The herd reached frame #${next + 1}`, ZONES[next].name);
    }
    jot(world, ev, "boss", heroes[0] ? heroes[0].id : 0, `${fight.name} FIXED`, idx);
  } else {
    jot(world, ev, "boss", heroes[0] ? heroes[0].id : 0, `${fight.name} fixed again`, idx);
  }
  note(ev, `${fight.name}: FIXED`);
  major(ev);
}

function winReviewFight(world, fight, ev) {
  const { state, rt } = world;
  const hero = findHero(world, fight.heroIds[0]);
  if (!hero) return;
  const idx = fight.reviewIdx;
  const key = woundKey("review", idx, hero.id);
  delete (state.herd.wounds || {})[key];
  delete (state.herd.lessons || {})[key];
  if (!winReview(hero, idx)) return;
  const item = rollReviewReward(hero, { reviewIdx: idx, L: hero.L, classId: hero.cls, state });
  rewardItem(world, hero, item, ev);
  const rxp = bossXP(hero.L, true);
  grantXP(state, hero, rxp, ev);
  const live = rt.live.get(hero.id);
  if (live && live.tally) live.tally.reviewXp = (live.tally.reviewXp || 0) + rxp;
  if (live) live.hp = live.maxHp;
  const title = careerOf(hero).title;
  note(ev, `PROMOTED: ${title}`);
  jot(world, ev, "promo", hero.id, title, hero.L);
  major(ev);
}

// Re-exports for tests.
export const _internal = { KITS, encounter, poolHP, arenaOf, frontOf, woundKey };
