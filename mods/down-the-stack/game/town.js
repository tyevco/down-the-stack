// Localhost, the town (docs/TOWN.md; round 1: "The Review Desk opens").
//
// A roster hero of Lv 10 or more is on duty in town while its agent is shipped, resting or off
// duty (the app closed included), as long as a chest of its was opened with full value on this game
// day or the one before (TOWN.md §2.1). On-duty heroes make LGTMs (1 a hero-hour x their rank's
// factor) into one shelf of 10 x the Review Desk's level, shared pro rata; every chest opened with
// full value takes one LGTM for +10% on its XP and gold (§3.4). Job XP is what a hero made (§4); the
// Review Desk's levels are bought by hand or, behind autopilot's "Buildings" switch, when the shelf
// filled up and still ran dry on the game day before (§5.2); Uptime counts the LGTMs spent (§5.3).
// Round 1 has one station: every on-duty hero is at the Review Desk (no Docs Library, Runbooks or
// role words yet; stationOf / jobStation are shaped so round 2 adds them without a save change).
//
// A hero working, crashed, supervising or waiting always stays in the field: the town never moves a
// fighter, a slot, a task, a Seal, a fight or a chest's "seen" (§2.3).
//
// Saved (save.js, TOWN.md §8; every field an extras key, SAVE_VERSION 1):
//   hero.st.tw = [jobXp, creditDay?]   jobXp with its fraction (written whole); creditDay the game
//                                      day (herd.day) of its last chest opened with full value,
//                                      written as d = day - creditDay (0 or 1), left out at 2 or more
//   herd.town  = {s: [lgtm, runbooks], rd: Review Desk level, u: [lgtmUsed, runbooksUsed] (lifetime),
//                 t: [today's LGTMs, flags, today's full-value chests], ru: [[heroId, rank], ...],
//                 dg: [lgtmUsed, runbooksUsed] when the Digest was read (herd.digestMark)}
//                flags: FULL the shelf was full today, DRY it ran dry after that, WANT a level is
//                wanted (the day before was FULL and DRY; autopilot buys it, autoDesk); written
//                with d, the game day of the save, which the credits' d count back from (an older
//                build keeps it, so credits it carried for days stay lapsed; save.js, loadDay)
//   Hall of Fame entries: [name, cls, L, at, rank?] (herd.retire)
// Runtime only (world.rt.town, never saved): the job-station cache, the last approved titles and
// the LGTMs each hero made that no chest has taken yet (who approved the next one).
//
// Pure and deterministic: no RNG, no Date.now(), no host calls. Production in roster order (hero
// id order) with pro rata sharing, so job XP never depends on who was listed first; LGTMs in the
// order agents.openChests opens chests.

import { TUNING, TOWN, STATION_BY_ID } from "./data.js";
import { cutText, shortName, fmtNum } from "./formulas.js";

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const OFFLINE_CAP_MS = 30 * DAY_MS; // as Fresh Eyes (world.js, D§12.3.11)
const EPS = 1e-9;
const TITLE_MAX = 40;

/** herd.town.t[1] flags (TOWN.md §8). */
export const FULL = 1;
export const DRY = 2;
export const WANT = 4;

// TUNING.town is read at call time: tools/pacing-sim.mjs --no-town sets TUNING.town.on = false
const TT = () => TUNING.town;

/** Is the town part of the engine (TUNING.town.on; false is the build before the town)? */
export function townOn() {
  return TT().on !== false;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * herd.town as the engine keeps it: {s: [lgtm, runbooks], rd, u: [lgtmUsed, runbooksUsed],
 * t: [today, flags, chestsToday], ru: [[heroId, rank], ...]}, every field present (an older save,
 * a hand-edited one or a fresh herd get the defaults). `create` false: null when the herd has none.
 */
export function townState(state, create = true) {
  const herd = state && state.herd;
  if (!herd) return null;
  let t = herd.town;
  if (!t || typeof t !== "object" || Array.isArray(t)) {
    if (!create) return null;
    t = herd.town = {};
  }
  if (!Array.isArray(t.s)) t.s = [0, 0];
  if (!Array.isArray(t.u)) t.u = [0, 0];
  if (!Array.isArray(t.t)) t.t = [0, 0, 0];
  if (!Array.isArray(t.ru)) t.ru = [];
  while (t.s.length < 2) t.s.push(0);
  while (t.u.length < 2) t.u.push(0);
  while (t.t.length < 3) t.t.push(0);
  t.s[0] = Math.max(0, num(t.s[0]));
  t.s[1] = Math.max(0, num(t.s[1]));
  t.rd = Math.max(0, Math.min(TT().desk.max, Math.floor(num(t.rd))));
  return t;
}

// read-only view of herd.town (never creates it); numbers default to 0
function peek(state) {
  const t = state && state.herd && state.herd.town;
  return t && typeof t === "object" && !Array.isArray(t) ? t : null;
}
const at = (list, i) => (Array.isArray(list) ? num(list[i]) : 0);

/** The Review Desk's level (0: not built). */
export function deskLevel(state) {
  const t = peek(state);
  return t ? Math.max(0, Math.min(TT().desk.max, Math.floor(num(t.rd)))) : 0;
}

/** The LGTM shelf's cap: 10 x the Review Desk's level (TOWN.md §3.2). */
export function shelfCap(state) {
  return TT().shelfPerLevel * deskLevel(state);
}

/** LGTMs on the shelf now (with the fraction). */
export function shelfOf(state) {
  return at(peek(state) && peek(state).s, 0);
}

/** Gold price of Review Desk level n: base x mult^(n - 1) (1k, 2k, 4k ... 512k). */
export function deskCost(level) {
  const d = TT().desk;
  return Math.round(d.base * Math.pow(d.mult, Math.max(0, level - 1)));
}

/** The price of the Review Desk's next level, or null at its max. */
export function nextDeskCost(state) {
  const lvl = deskLevel(state);
  return lvl >= TT().desk.max ? null : deskCost(lvl + 1);
}

/** A rank (0 Drive-by .. 4 Core) from job XP (TUNING.town.rankAt). */
export function rankOf(jobXp) {
  const steps = TT().rankAt;
  let r = 0;
  for (let i = 0; i < steps.length; i++) if (jobXp + EPS >= steps[i]) r = i;
  return r;
}

/** Output factor of a rank: 1 + 0.2 x rank (x1.0 .. x1.8). */
export function rankFactor(rank) {
  return 1 + TT().rankRate * rank;
}

/** A hero's job XP (LGTMs it made; memory keeps the fraction, the save the whole units). */
export function jobXpOf(hero) {
  const tw = hero && hero.st && hero.st.tw;
  return Array.isArray(tw) ? Math.max(0, num(tw[0])) : 0;
}

/** The game day (herd.day) of the hero's last chest opened with full value, or null. */
export function creditDayOf(hero) {
  const tw = hero && hero.st && hero.st.tw;
  return Array.isArray(tw) && tw.length > 1 && typeof tw[1] === "number" && Number.isFinite(tw[1]) ? tw[1] : null;
}

/**
 * Game days since the hero's last chest opened with full value while that still counts for rule 3
 * (0 today, 1 yesterday, up to TUNING.town.gateDays), else null.
 */
export function seenDays(state, hero) {
  const c = creditDayOf(hero);
  if (c == null) return null;
  const d = Math.max(0, ((state && state.herd && state.herd.day) || 0) - c);
  return d <= TT().gateDays ? d : null;
}

function twOf(hero) {
  if (!hero.st) hero.st = { kills: 0, tasks: 0, seals: 0, wh: 0, dodges: 0, healed: 0 };
  let tw = hero.st.tw;
  if (!Array.isArray(tw)) tw = hero.st.tw = [0];
  if (tw.length < 1) tw.push(0);
  return tw;
}

/**
 * A chest of the hero's opened with full value (agents.openChests, the credited-Seal path): rule 3
 * holds for this game day and the next (d = 0). Roster heroes and Contractors alike: a promoted
 * Contractor keeps today's credit (agents.promote keeps the same hero object). Nothing with the
 * town off or on a read-only world.
 */
export function markSeen(world, hero) {
  if (!townOn() || !hero || (world.rt && world.rt.readOnly)) return;
  const tw = twOf(hero);
  const day = (world.state.herd.day) || 0;
  const was = creditDayOf(hero);
  // the credit it held before this game day's first one, and when it changed (runtime): an offline
  // gap settles after reconcile, which may already have opened a chest of the hero's as the app came
  // back (settleOffline counts the credit the hero had when the gap began)
  if (was !== day) rtTown(world).prior.set(hero.id, { was, at: world.rt ? num(world.rt.nowMs) : 0 });
  tw[1] = day;
}

// ---------------------------------------------------------------------------------------------
// Runtime (world.rt.town, never saved)
// ---------------------------------------------------------------------------------------------

// {jobs: the station cache, owed: LGTMs made and not yet taken (by hero id), titles: the last
// approved, prior: a hero's credit day before its newest one and when that changed (settleOffline)}
function rtTown(world) {
  const rt = world.rt || (world.rt = {});
  let r = rt.town;
  if (!r) r = rt.town = { jobs: new Map(), owed: new Map(), titles: [], prior: new Map() };
  if (!r.prior) r.prior = new Map();
  return r;
}

// ---------------------------------------------------------------------------------------------
// Where a hero works (TOWN.md §3.3; round 1: the Review Desk)
// ---------------------------------------------------------------------------------------------

const station = (id) => STATION_BY_ID[id];

// What jobStation's pick depends on (round 2: the seat, tab and pane names, class and override).
function jobKey(hero) {
  const x = hero.post == null ? "" : hero.post;
  return `${hero.cls}|${hero.seat}|${hero.lastTab}|${hero.lastPane}|${x}`;
}

// The pick itself (round 1: the Review Desk for everyone).
function pickJob(hero) {
  void hero;
  const s = station("review_desk");
  return { id: s.id, name: s.name, noun: s.noun, reason: "auto", word: null, from: null };
}

/**
 * The station a hero works at when it is on duty, whatever its state now (the Job card's head):
 * {id, name, noun, reason, word, from}. Round 1: the Review Desk for everyone, reason "auto".
 * Round 2 adds, in this order, the sheet's override (reason "post"), the role words of the space,
 * tab or pane name ("word", with `word` and `from`) and the class ("class"); the Campfire gates are
 * stationOf's. Derived, never saved: refreshStations (the 60-tick autopilot pass) caches it per
 * hero in world.rt.town.jobs by what it depends on (its seat, tab, pane, class and override); a
 * lookup uses the cache while the key still matches and otherwise computes it without storing,
 * so the views never write the world.
 */
export function jobStation(world, hero) {
  const r = world.rt && world.rt.town;
  const hit = r ? r.jobs.get(hero.id) : null;
  if (hit && hit.key === jobKey(hero)) return hit.job;
  return pickJob(hero);
}

/**
 * The 60-tick pass (autopilot): refreshes the job-station cache of the roster heroes of Lv 10+,
 * forgets the cache and the runtime counts of heroes no longer in the herd, and drops their
 * waiting rank-ups (a retired hero's) from herd.town.ru.
 */
export function refreshStations(world) {
  if (!townOn()) return;
  const t = peek(world.state);
  if (!t && !(world.rt && world.rt.town)) return;
  const r = rtTown(world);
  const keep = new Set();
  for (const h of world.state.heroes) {
    keep.add(h.id);
    if (!(h.L >= TT().minLevel)) continue;
    const key = jobKey(h);
    const hit = r.jobs.get(h.id);
    if (!hit || hit.key !== key) r.jobs.set(h.id, { key, job: pickJob(h) });
  }
  for (const id of Array.from(r.jobs.keys())) if (!keep.has(id)) r.jobs.delete(id);
  for (const id of Array.from(r.owed.keys())) if (!keep.has(id)) r.owed.delete(id);
  if (world.rt.contractors) for (const c of world.rt.contractors.values()) if (c) keep.add(c.id);
  for (const id of Array.from(r.prior.keys())) if (!keep.has(id)) r.prior.delete(id);
  if (t && Array.isArray(t.ru) && t.ru.length && !(world.rt && world.rt.readOnly) && t.ru.some((e) => !Array.isArray(e) || !keep.has(e[0]))) {
    t.ru = t.ru.filter((e) => Array.isArray(e) && keep.has(e[0]));
  }
}

/** A promoted Contractor's new id (agents.promote): the approved titles that name it follow it. */
export function renameHero(world, oldId, newId) {
  const r = world.rt && world.rt.town;
  if (!r) return;
  for (const e of r.titles) {
    if (e.heroId === oldId) e.heroId = newId;
    if (e.byId === oldId) e.byId = newId;
  }
  if (r.prior && r.prior.has(oldId)) {
    r.prior.set(newId, r.prior.get(oldId));
    r.prior.delete(oldId);
  }
}

/**
 * Where the hero is when it is not fighting (TOWN.md §3.3), first match wins:
 * the Campfire with the town off ("off"), for a Contractor ("contractor": never on the roster,
 * no job), for Lv 1-9 ("intern"), with no Review Desk ("closed") or with rule 3 lapsed ("unseen": no
 * chest of its seen with full value today or yesterday); else its job station (jobStation, round 1
 * the Review Desk). It does not look at the agent's state: whether the hero is on duty right now
 * is onDuty's.
 * @returns {{id:string, name:string, noun:null|string, reason:string}}
 */
export function stationOf(world, hero) {
  const fire = (reason) => ({ id: "campfire", name: station("campfire").name, noun: null, reason });
  if (!townOn()) return fire("off");
  if (!hero || hero.contractor || !(hero.id > 0)) return fire("contractor");
  if (!(hero.L >= TT().minLevel)) return fire("intern");
  if (!(deskLevel(world.state) >= 1)) return fire("closed");
  if (seenDays(world.state, hero) == null) return fire("unseen");
  const j = jobStation(world, hero);
  return { id: j.id, name: j.name, noun: j.noun, reason: j.reason };
}

const RESTS = Object.assign(Object.create(null), { shipped: 1, resting: 1 });

/**
 * The duty rule, exactly (TOWN.md §2.1): a roster hero (never a Contractor) of Lv 10 or more whose
 * agent is shipped, resting or off duty (no Live: its terminal gone, or the app closed), with a
 * chest of its opened with full value on this game day or the one before, while the Review Desk is
 * built, the world is not read-only and the clock is not behind. Questing, crashed, supervising
 * and waiting heroes never are. `live` defaults to the hero's Live in world.rt.
 */
export function onDuty(world, hero, live) {
  if (!townOn() || !hero || hero.contractor || !(hero.id > 0)) return false;
  if (!(hero.L >= TT().minLevel)) return false;
  const rt = world.rt;
  if (rt && (rt.readOnly || rt.clockBehind)) return false;
  if (!(deskLevel(world.state) >= 1)) return false;
  const l = live === undefined ? (rt && rt.live ? rt.live.get(hero.id) : null) : live;
  if (l && !RESTS[l.state]) return false;
  return seenDays(world.state, hero) != null;
}

// ---------------------------------------------------------------------------------------------
// Production (TOWN.md §3.2)
// ---------------------------------------------------------------------------------------------

// Shares the shelf's room among [hero, want] pairs pro rata (TOWN.md §3.2): each gets want x
// min(1, room / total wanted). Job XP grows by what each made (rank-ups recorded for the Digest);
// rt.town.owed keeps who made what for the next LGTMs' "by". Returns the LGTMs made.
function share(world, town, heroes, wants, n, room) {
  let total = 0;
  for (let i = 0; i < n; i++) total += wants[i];
  if (!(total > 0) || !(room > EPS)) return 0;
  const f = total > room ? room / total : 1;
  const r = rtTown(world);
  let made = 0;
  for (let i = 0; i < n; i++) {
    const h = heroes[i];
    const add = wants[i] * f;
    if (!(add > 0)) continue;
    const tw = twOf(h);
    const before = rankOf(num(tw[0]));
    tw[0] = num(tw[0]) + add;
    const after = rankOf(tw[0]);
    if (after > before) rankUp(town, h.id, after);
    r.owed.set(h.id, (r.owed.get(h.id) || 0) + add);
    made += add;
  }
  const cap = TT().shelfPerLevel * town.rd;
  town.s[0] = Math.min(cap, town.s[0] + made);
  if (town.s[0] >= cap - EPS) {
    town.s[0] = cap;
    town.t[1] |= FULL;
  }
  return made;
}

// A rank-up since the Digest was read (herd.town.ru): one entry a hero, its newest rank.
function rankUp(town, heroId, rank) {
  for (const e of town.ru) if (Array.isArray(e) && e[0] === heroId) { e[1] = rank; return; }
  town.ru.push([heroId, rank]);
}

/**
 * One simulated second of the town (world.stepOnce, after rest and the off-duty loop): every
 * on-duty hero (onDuty) wants perHour / 3600 x its rank factor LGTMs; the shelf's room is shared
 * pro rata. A full shelf makes nothing (and sets FULL). Nothing with the town off, no Review Desk,
 * a read-only world or a clock behind.
 * @returns {number} LGTMs made this step
 */
export function stepTown(world) {
  if (!townOn()) return 0;
  const { state, rt } = world;
  if (rt && (rt.readOnly || rt.clockBehind)) return 0;
  const t0 = peek(state);
  if (!t0 || !(num(t0.rd) >= 1)) return 0;
  const town = townState(state);
  const cap = TT().shelfPerLevel * town.rd;
  if (town.s[0] >= cap - EPS) {
    town.s[0] = Math.min(town.s[0], cap);
    town.t[1] |= FULL;
    return 0;
  }
  // onDuty's rule, inlined for the per-step pass (the town on, the desk built, the world neither
  // read-only nor behind were checked above): one pass over the roster, a few compares a hero
  const per = TT().perHour / 3600;
  const min = TT().minLevel;
  const gate = TT().gateDays;
  const day = state.herd.day || 0;
  const live = rt && rt.live;
  let n = 0;
  for (const h of state.heroes) {
    if (!(h.L >= min) || h.contractor) continue;
    const tw = h.st && h.st.tw;
    const c = tw && tw.length > 1 ? tw[1] : null;
    if (typeof c !== "number" || !(day - c <= gate)) continue;
    const l = live ? live.get(h.id) : null;
    if (l && !RESTS[l.state]) continue;
    HEROES[n] = h;
    WANTS[n] = per * rankFactor(rankOf(num(tw[0])));
    n++;
  }
  const made = n ? share(world, town, HEROES, WANTS, n, cap - town.s[0]) : 0;
  for (let i = 0; i < n; i++) HEROES[i] = null;
  return made;
}
// stepTown's scratch lists (reused every step; emptied after each use)
const HEROES = [];
const WANTS = [];

/** Start of game day `day` (04:00 local, D§2.9) in epoch ms. */
export function dayStartMs(day, tzOffsetMin) {
  return day * DAY_MS + TUNING.shift.resetHourLocal * HOUR_MS + (Number(tzOffsetMin) || 0) * 60000;
}

/**
 * An offline gap (world.applyOffline, after reconcile; TOWN.md §6.5): every roster hero of Lv 10+
 * that is not Waiting was on duty for min(gap, the time until its rule 3 lapsed), clamped to 30
 * days, by the credit it held when the gap began (a chest seen as the app came back does not reach
 * back into the gap); the shelf's room is shared pro rata as ticking the gap would have shared it
 * (the heroes on duty while it filled). Bounded twice: rule 3
 * lapses within gateDays + 1 game days of the last seen chest, and the shelf holds at most 10 x the
 * Review Desk's level; nothing is spent here (the shelf empties one chest at a time as the day
 * goes), and nothing is told (no note: the Digest's line says it).
 * @returns {{made:number, heroes:number}}
 */
export function settleOffline(world, dtMs) {
  const out = { made: 0, heroes: 0 };
  if (!townOn() || !(dtMs > 0)) return out;
  const { state, rt } = world;
  if (rt && (rt.readOnly || rt.clockBehind)) return out;
  const t0 = peek(state);
  if (!t0 || !(num(t0.rd) >= 1)) return out;
  const town = townState(state);
  const cap = TT().shelfPerLevel * town.rd;
  const room = cap - town.s[0];
  if (!(room > EPS)) {
    town.t[1] |= FULL;
    return out;
  }
  const now = rt ? rt.nowMs : state.herd.lastMs;
  const start = now - dtMs;
  const tz = rt && Number.isFinite(rt.tzOffsetMin) ? rt.tzOffsetMin : 0;
  const per = TT().perHour / HOUR_MS;
  const gap = Math.min(dtMs, OFFLINE_CAP_MS);
  const prior = rt && rt.town && rt.town.prior;
  const list = [];
  for (const h of state.heroes) {
    if (!(h.id > 0) || !(h.L >= TT().minLevel)) continue;
    const live = rt && rt.live ? rt.live.get(h.id) : null;
    if (live && live.status === "blocked") continue; // Waiting earns nothing, as Fresh Eyes
    let c = creditDayOf(h);
    // a credit newer than the gap (a chest opened as the app came back, in the reconcile before
    // this settle) did not hold while the app was closed: the gap counts the one it had then
    const p = prior ? prior.get(h.id) : null;
    if (p && p.at > start) c = p.was;
    if (c == null) continue;
    const ms = Math.min(gap, dayStartMs(c + TT().gateDays + 1, tz) - start);
    if (!(ms > 0)) continue;
    list.push({ h, ms, rate: per * rankFactor(rankOf(jobXpOf(h))) });
  }
  out.heroes = list.length;
  if (!list.length) return out;
  // as if the gap had been ticked (stepTown: each second's room shared pro rata among the heroes on
  // duty then): the heroes leave duty one by one as rule 3 lapses (stable by roster order), so the
  // shelf's room goes to whoever was on duty while it filled, never by how long each could have been
  const n = list.length;
  const order = list.map((e, i) => i).sort((a, b) => list[a].ms - list[b].ms || a - b);
  const made = new Array(n).fill(0);
  let left = room;
  let rate = 0;
  for (const e of list) rate += e.rate;
  let t = 0;
  for (let k = 0; k < n && left > EPS && rate > 0; k++) {
    const end = list[order[k]].ms;
    const span = end - t;
    if (span > 0) {
      const f = Math.min(1, left / (rate * span));
      for (let i = 0; i < n; i++) if (list[i].ms > t) made[i] += list[i].rate * span * f;
      left -= rate * span * f;
      t = end;
    }
    rate -= list[order[k]].rate;
  }
  const heroes = [];
  const wants = [];
  for (let i = 0; i < n; i++) if (made[i] > 0) { heroes.push(list[i].h); wants.push(made[i]); }
  out.made = heroes.length ? share(world, town, heroes, wants, heroes.length, room) : 0;
  return out;
}

/**
 * The 04:00 game-day turn (world.tick, when herd.day moves on; before reconcile): the demand rule
 * reads the day that ended (WANT when its shelf was FULL and later ran DRY, TOWN.md §5.2), and
 * today's counters start afresh (FULL again if the shelf is full now). Rule 3 ages by itself: a
 * hero's credit day stays, and seenDays counts from the new day (a credit 2 days old is left out of
 * the save).
 */
export function dayTurn(world) {
  if (!townOn()) return;
  const t0 = peek(world.state);
  if (!t0) return;
  const town = townState(world.state);
  const f = town.t[1] | 0;
  const want = (f & FULL) && (f & DRY) && town.rd >= 1 && town.rd < TT().desk.max ? WANT : 0;
  const cap = TT().shelfPerLevel * town.rd;
  town.t = [0, want | (town.rd >= 1 && town.s[0] >= cap - EPS ? FULL : 0), 0];
}

/**
 * A loaded save's town (world.loadWorld): townDay is the game day its town was written on
 * (save.js: herd.x.town.d, decodeState's townDay). A build without the town that opened the save on
 * a later game day and saved it moved herd.day on and kept the town as it was, so the game-day turn
 * it skipped runs now, once, as after any gap of several days (today's counters start afresh, the
 * day that ended decides WANT). Credits need nothing here: save.js counts them back from townDay,
 * so they read as that many days old.
 */
export function loadDay(world, townDay) {
  if (!townOn() || (world.rt && world.rt.readOnly)) return;
  if (typeof townDay === "number" && townDay > 0 && townDay < num(world.state.herd.day)) dayTurn(world);
}

// ---------------------------------------------------------------------------------------------
// LGTMs (TOWN.md §3.4)
// ---------------------------------------------------------------------------------------------

/**
 * A chest opened with full value (agents.openChests, one call per chest, in its order; roster
 * heroes and Contractors alike): with an LGTM on the shelf it takes one and returns the bonus
 * (TUNING.town.lgtmBonus, 0.10) for its XP and gold; with the shelf empty it opens as today (0), and
 * a shelf that was full today has now run DRY (the demand rule). Counts today's chests and LGTMs and
 * the lifetime LGTMs (Uptime, the Digest); keeps the title for the Localhost tab (runtime only).
 * @param {string|null} title the chest's telling title (agents.judgeCached), null if none
 * @returns {number} the bonus fraction (0 when no LGTM was taken)
 */
export function takeLgtm(world, hero, title) {
  if (!townOn() || !hero) return 0;
  const { state, rt } = world;
  if (rt && rt.readOnly) return 0;
  const t0 = peek(state);
  if (!t0 || !(num(t0.rd) >= 1)) return 0;
  const town = townState(state);
  town.t[2] = num(town.t[2]) + 1;
  if (!(town.s[0] >= 1 - EPS)) {
    if (town.t[1] & FULL) town.t[1] |= DRY;
    return 0;
  }
  town.s[0] = Math.max(0, town.s[0] - 1);
  town.u[0] = num(town.u[0]) + 1;
  town.t[0] = num(town.t[0]) + 1;
  const by = reviewerFor(world, hero);
  const r = rtTown(world);
  r.titles.unshift({
    title: title ? cutText(String(title), TITLE_MAX) : null, heroId: hero.id, name: hero.name || "",
    byId: by ? by.id : null, byName: by ? by.name : null, at: rt ? rt.nowMs : 0,
  });
  if (r.titles.length > TT().titlesKept) r.titles.length = TT().titlesKept;
  return TT().lgtmBonus;
}

// Who approved it (the Localhost tab's "by Rue"): the hero with the most LGTMs made that no chest
// has taken yet (rt.town.owed; ties: the lower id), another hero than the chest's own when there is
// one; after a restart (nothing owed) the top-ranked hero on duty or credited (most job XP).
function reviewerFor(world, hero) {
  const r = rtTown(world);
  const roster = world.state.heroes;
  let best = null;
  let bestOwed = -1;
  let own = null;
  for (const h of roster) {
    const o = r.owed.get(h.id) || 0;
    if (!(o > EPS)) continue;
    if (h === hero) { own = h; continue; }
    if (o > bestOwed + EPS) { best = h; bestOwed = o; }
  }
  if (!best && own) best = own;
  if (best) {
    r.owed.set(best.id, Math.max(0, (r.owed.get(best.id) || 0) - 1));
    return best;
  }
  for (const h of roster) {
    if (h === hero || !(h.L >= TT().minLevel) || seenDays(world.state, h) == null) continue;
    if (!best || jobXpOf(h) > jobXpOf(best) + EPS) best = h;
  }
  return best;
}

/** The last approved titles, newest first (runtime only): [{title, heroId, name, byId, byName, at}]. */
export function lastTitles(world) {
  const r = world.rt && world.rt.town;
  return r ? r.titles.slice() : [];
}

/**
 * Hot reload (host.js): what the next build's world needs beyond the save text, as plain data;
 * takeTown puts it back. The world crosses a hot reload as save text (host.handover serializes
 * it), which keeps job XP in whole units and the shelf to a tenth (TOWN.md §8), so the exact
 * values go along and a hot reload changes no outcome (a restart may still lose up to 1 job XP a
 * hero and 0.1 LGTM, both rounded down). With them the runtime part: the last approved titles,
 * the LGTMs each hero made that no chest has taken yet (who approved the next one) and the credit
 * each hero held before its newest one (settleOffline).
 * {titles, shelf: exact LGTMs or null, jobs: [[heroId, jobXp]], owed: [[heroId, n]], prior: [[heroId, was, at]]}
 */
export function handoverTown(world) {
  const r = world.rt && world.rt.town;
  const t = peek(world.state);
  const jobs = [];
  for (const h of world.state.heroes) {
    const tw = h && h.st && h.st.tw;
    if (Array.isArray(tw) && num(tw[0]) > 0) jobs.push([h.id, num(tw[0])]);
  }
  const owed = [];
  const prior = [];
  if (r) {
    for (const [id, n] of r.owed) if (n > EPS) owed.push([id, n]);
    if (r.prior) for (const [id, p] of r.prior) if (p) prior.push([id, p.was == null ? null : num(p.was), num(p.at)]);
  }
  return { titles: lastTitles(world), shelf: t && Array.isArray(t.s) ? num(t.s[0]) : null, jobs, owed, prior };
}

/**
 * Puts handoverTown's data back into a world (a hot reload's new build, decoded from the very text
 * the old one handed over). An exact value replaces the decoded one only where they agree (the
 * same number rounded down as the save rounds it), so a handover that does not match this world
 * changes nothing; the shelf never passes its cap. Data from an older build (titles only) is taken
 * as it is.
 */
export function takeTown(world, data) {
  if (!data || typeof data !== "object") return;
  const r = rtTown(world);
  if (Array.isArray(data.titles)) {
    r.titles = data.titles.filter((x) => x && typeof x === "object").slice(0, TT().titlesKept).map((x) => ({
      title: typeof x.title === "string" ? cutText(x.title, TITLE_MAX) : null, heroId: num(x.heroId), name: String(x.name || ""),
      byId: x.byId == null ? null : num(x.byId), byName: x.byName == null ? null : String(x.byName), at: num(x.at),
    }));
  }
  const t = peek(world.state);
  if (t && Array.isArray(t.s) && typeof data.shelf === "number" && Number.isFinite(data.shelf)) {
    const was = num(t.s[0]);
    const x = Math.min(shelfCap(world.state), data.shelf);
    if (x >= was - EPS && x < was + 0.1 - EPS) t.s[0] = Math.max(was, x);
  }
  const byId = new Map();
  for (const h of world.state.heroes) if (h) byId.set(h.id, h);
  const pairs = (list) => (Array.isArray(list) ? list.filter((e) => Array.isArray(e) && byId.has(e[0])) : []);
  for (const e of pairs(data.jobs)) {
    const h = byId.get(e[0]);
    const x = num(e[1]);
    const tw = h.st && h.st.tw;
    if (!Array.isArray(tw)) {
      // under 1 job XP with no credit to keep: the save wrote nothing for it
      if (x > EPS && x < 1 - EPS) twOf(h)[0] = x;
      continue;
    }
    const was = num(tw[0]);
    if (x >= was - EPS && x < was + 1 - EPS) tw[0] = Math.max(was, x);
  }
  for (const e of pairs(data.owed)) if (num(e[1]) > EPS) r.owed.set(e[0], num(e[1]));
  for (const e of pairs(data.prior)) r.prior.set(e[0], { was: e[1] == null ? null : num(e[1]), at: num(e[2]) });
}

// ---------------------------------------------------------------------------------------------
// The Review Desk (TOWN.md §5.2)
// ---------------------------------------------------------------------------------------------

/**
 * Buys one level of the Review Desk (the person's click, the command buy("review_desk"), or
 * autoDesk): its price in gold, the shelf grows by 10. Level 1 raises the herd's one note
 * "Localhost: the Review Desk is open"; later levels the same note any building's level gets.
 * @returns {{ok:boolean, cost?:number, level?:number, error?:string}}
 */
export function buyDesk(world, ev) {
  if (!townOn()) return { ok: false, error: "Localhost is closed" };
  const { state, rt } = world;
  if (rt && rt.readOnly) return { ok: false, error: "This save is read-only" };
  const lvl = deskLevel(state);
  if (lvl >= TT().desk.max) return { ok: false, error: "Max level" };
  const cost = deskCost(lvl + 1);
  if ((state.herd.gold || 0) < cost) return { ok: false, cost, error: "Not enough gold" };
  const town = townState(state);
  state.herd.gold = Math.max(0, Math.round((state.herd.gold || 0) - cost));
  town.rd = lvl + 1;
  town.t[1] &= ~WANT;
  if (ev) {
    if (town.rd === 1) ev.note?.("Localhost: the Review Desk is open", null, { kind: "town", short: ["Review Desk open"] });
    else ev.note?.(`Localhost: Review Desk ${town.rd}`, null, { kind: "town", short: `Review Desk ${town.rd}` });
    ev.major?.();
  }
  return { ok: true, cost, level: town.rd };
}

/**
 * Autopilot's Review Desk (the 60-tick pass, behind the "Buildings" switch; outside herd.autoBuyPick's
 * cheapest-first queue): level 1 once a roster hero of Lv 10+ has seen work (rule 3) and gold >= 3 x
 * 1,000; level n + 1 only when the game day before filled the shelf and still ran it dry (WANT, set
 * at the 04:00 turn; at most one level a game day) and gold >= 3 x its price.
 * @returns {null|number} the level bought
 */
export function autoDesk(world, ev) {
  if (!townOn()) return null;
  const { state, rt } = world;
  if (rt && rt.readOnly) return null;
  const lvl = deskLevel(state);
  if (lvl >= TT().desk.max) return null;
  if (lvl === 0) {
    if (!state.heroes.some((h) => h.L >= TT().minLevel && seenDays(state, h) != null)) return null;
  } else {
    const t = peek(state);
    if (!(at(t && t.t, 1) & WANT)) return null;
  }
  const cost = deskCost(lvl + 1);
  if ((state.herd.gold || 0) < TT().desk.autoAt * cost) return null;
  const r = buyDesk(world, ev);
  return r.ok ? r.level : null;
}

// ---------------------------------------------------------------------------------------------
// Uptime (TOWN.md §5.3)
// ---------------------------------------------------------------------------------------------

/** Localhost's served count S = LGTMs spent + 10 x Runbooks spent (lifetime). */
export function servedOf(state) {
  const t = peek(state);
  return t ? at(t.u, 0) + TT().runbookUptime * at(t.u, 1) : 0;
}

/**
 * Uptime in nines from S (a number, or a state whose served count to use): {s, step (0 booting ..
 * 5 five nines), label ("booting", "90%" .. "99.999%"), next (S of the next step or null), prev (S of
 * this step), frac (0..1 toward the next), unlock (this step's cosmetic, TOWN.uptime)}.
 */
export function uptime(sOrState) {
  const s = typeof sOrState === "number" ? Math.max(0, sOrState) : servedOf(sOrState);
  const steps = TT().uptimeAt;
  let step = 0;
  while (step < steps.length && s >= steps[step]) step++;
  const prev = step > 0 ? steps[step - 1] : 0;
  const next = step < steps.length ? steps[step] : null;
  const u = step > 0 ? TOWN.uptime[step - 1] : null;
  return {
    s, step, label: u ? u.label : TOWN.booting, next, prev, frac: next == null ? 1 : Math.max(0, Math.min(1, (s - prev) / (next - prev))),
    unlock: u ? u.unlock : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The Digest's Localhost line (TOWN.md §7.7) and the Hall of Fame
// ---------------------------------------------------------------------------------------------

/**
 * herd.digestMark's town part: the lifetime counters the next Digest counts from (herd.town.dg, in
 * the town so an older build's digestMark, which writes herd.digestSnap anew, keeps it) and no
 * rank-ups waiting.
 */
export function markDigest(state) {
  const t = peek(state);
  if (!t) return;
  t.dg = [at(t.u, 0), at(t.u, 1)];
  if (Array.isArray(t.ru) && t.ru.length) t.ru = [];
}

/**
 * The Digest's one Localhost line (herd.digest().town), counted from the lifetime counters against
 * herd.town.dg (markDigest): {lgtm, runbooks, ranks: [{heroId, name, rank, rankName}], uptime, was,
 * text}, or null when the town has nothing to tell. Never counted in the digest's `empty` (no Herd
 * dot for the town).
 */
export function digestTown(state) {
  const t = peek(state);
  if (!t) return null;
  const was = Array.isArray(t.dg) ? t.dg : [0, 0];
  const lgtm = Math.max(0, at(t.u, 0) - num(was[0]));
  const runbooks = Math.max(0, at(t.u, 1) - num(was[1]));
  const byId = new Map(state.heroes.map((h) => [h.id, h]));
  const ranks = [];
  for (const e of Array.isArray(t.ru) ? t.ru : []) {
    if (!Array.isArray(e)) continue;
    const h = byId.get(e[0]);
    const rank = Math.max(0, Math.min(TOWN.ranks.length - 1, Math.floor(num(e[1]))));
    if (h && rank > 0) ranks.push({ heroId: h.id, name: h.name, rank, rankName: TOWN.ranks[rank].name });
  }
  if (!lgtm && !runbooks && !ranks.length) return null;
  ranks.sort((a, b) => b.rank - a.rank || a.heroId - b.heroId);
  const up = uptime(state);
  const before = uptime(num(was[0]) + TT().runbookUptime * num(was[1]));
  const parts = [];
  if (lgtm) parts.push(`${fmtNum(lgtm)} chest${lgtm === 1 ? "" : "s"} LGTM'd (+${Math.round(TT().lgtmBonus * 100)}% XP and gold)`);
  if (runbooks) parts.push(`${runbooks} runbook${runbooks === 1 ? "" : "s"} used`);
  const groups = [];
  for (const r of ranks) {
    const g = groups.find((x) => x.rank === r.rank);
    if (g) g.n++;
    else groups.push({ rank: r.rank, rankName: r.rankName, first: shortName(r.name), n: 1 });
  }
  for (const g of groups.slice(0, 2)) parts.push(`${g.first}${g.n > 1 ? ` and ${g.n - 1} more` : ""} reached ${g.rankName}`);
  const rest = groups.slice(2).reduce((s, g) => s + g.n, 0);
  if (rest) parts.push(`${rest} more rank-up${rest === 1 ? "" : "s"}`);
  if (up.step > 0) parts.push(`${up.label} uptime${before.step > 0 && before.step !== up.step ? ` (was ${before.label})` : ""}`);
  return { lgtm, runbooks, ranks, uptime: up, was: before, text: `Localhost: ${parts.join(" · ")}` };
}

/** The rank a retiring hero takes to the Hall of Fame (herd.retire; 0 is left out of the entry). */
export function fameRank(hero) {
  return rankOf(jobXpOf(hero));
}

/** A job title: "Committer reviewer" (rank name and the station's noun). */
export function jobTitle(rank, noun = station("review_desk").noun) {
  const r = TOWN.ranks[Math.max(0, Math.min(TOWN.ranks.length - 1, rank | 0))];
  return noun ? `${r.name} ${noun}` : r.name;
}

// ---------------------------------------------------------------------------------------------
// View-facing data (game/view/*; computed on demand, cheap: one pass over the roster)
// ---------------------------------------------------------------------------------------------

const q = (s) => `“${s}”`;

/** One approved title as the views write it: "“Bump deps” (Fizz)", ", by Rue" with `by`. */
export function titleText(e, by = false) {
  if (!e) return "";
  const what = e.title ? q(e.title) : "a commit";
  return `${what} (${shortName(e.name)})${by && e.byName ? `, by ${shortName(e.byName)}` : ""}`;
}

/**
 * A hero's town data (stage, sheet, tooltips): {station, stationName, job, jobName, reason, onDuty,
 * state, seen, jobXp, rank, rankName, title, nextAt, made, last, line, status, tip}.
 *   station   where it is when not fighting ("review_desk" | "campfire", stationOf): a resting,
 *             on-duty hero's slot shows this station's prop instead of the campfire
 *   job       its job station (jobStation): the Job card's head, "Job · Review Desk"
 *   state     "duty" (on duty now), "working" (questing, crashed or supervising: it fights),
 *             "waiting", "intern", "contractor", "closed" (no Review Desk), "unseen" (rule 3), "off"
 *             (the town off), "paused" (a read-only world or a clock behind)
 *   seen      game days since its last chest seen with full value while rule 3 holds (0, 1) or null
 *   jobXp     whole job XP; rank 0..4; title "Committer reviewer"; nextAt the next rank's job XP or null
 *   last      the newest approved title it reviewed this session ({title, name}) or null
 *   line      "Committer reviewer · 112 / 300"; status (the Job card's second line); tip (tooltip)
 * Never an agent-status word: the views keep "resting" / "shipped" / "! waiting" on the status
 * surfaces and put this in secondary text and tooltips (TOWN.md §7.4).
 */
export function heroTown(world, hero, live) {
  const l = live === undefined ? (world.rt && world.rt.live ? world.rt.live.get(hero.id) : null) : live;
  const st = stationOf(world, hero);
  const job = jobStation(world, hero);
  const xp = Math.floor(jobXpOf(hero) + EPS);
  const rank = rankOf(jobXpOf(hero));
  const rankAt = TT().rankAt;
  const nextAt = rank + 1 < rankAt.length ? rankAt[rank + 1] : null;
  const duty = onDuty(world, hero, l);
  const seen = seenDays(world.state, hero);
  let state;
  if (!townOn()) state = "off";
  else if (hero.contractor || !(hero.id > 0)) state = "contractor";
  else if (!(hero.L >= TT().minLevel)) state = "intern";
  else if (!(deskLevel(world.state) >= 1)) state = "closed";
  else if (world.rt && (world.rt.readOnly || world.rt.clockBehind)) state = "paused";
  else if (l && l.state === "waiting") state = "waiting";
  else if (l && !RESTS[l.state]) state = "working";
  else if (seen == null) state = "unseen";
  else state = duty ? "duty" : "unseen";
  let last = null;
  for (const e of lastTitles(world)) if (e.byId === hero.id) { last = { title: e.title, name: e.name }; break; }
  const title = jobTitle(rank, job.noun);
  const line = `${title} · ${fmtNum(xp)}${nextAt != null ? ` / ${fmtNum(nextAt)}` : ""}`;
  const where = `the ${job.name}`;
  const lastText = last ? ` · last ${titleText(last)}` : "";
  const seenText = seen === 0 ? "seen work today" : "seen work yesterday";
  const doing = !l ? "agent away" : l.state === "shipped" ? "shipped" : "resting";
  let status;
  let tip;
  if (state === "off") { status = null; tip = null; }
  else if (state === "contractor") { status = "Contractors don't hold jobs"; tip = null; }
  else if (state === "intern") { status = `Gets a job at Lv ${TT().minLevel} (Junior)`; tip = null; }
  else if (state === "closed") { status = "No Review Desk yet: Localhost opens with its first level"; tip = null; }
  else if (state === "paused") { status = "Localhost is paused"; tip = null; }
  else if (state === "waiting") { status = `Not on duty while its agent needs you · ${title}`; tip = null; }
  else if (state === "working") { status = `Working: at ${where} when its agent rests · ${title}`; tip = null; }
  else if (state === "unseen") { status = "Back on duty after you see its next chest"; tip = status; }
  else {
    status = `On duty: ${doing} (${seenText}) · made ${fmtNum(xp)} LGTM${xp === 1 ? "" : "s"}${lastText}`;
    // a shipped hero stays by its chest in the field (gold still means done, TOWN.md §2.1)
    const lastTip = last ? ` · last LGTM ${titleText(last)}` : "";
    tip = !l ? `Off duty · at ${where} (${title})` : l.state === "shipped" ? `On duty for ${where} while its chest waits · ${title}${lastTip}` : `At ${where} · ${title}${lastTip}`;
  }
  return {
    station: st.id, stationName: st.name, job: job.id, jobName: job.name, reason: st.reason, onDuty: duty, state, seen,
    jobXp: xp, rank, rankName: TOWN.ranks[rank].name, title, nextAt, made: xp, last, line, status, tip,
  };
}

/**
 * The town for the chip, the Localhost tab and their tooltips: {on, open, level, max, cost, canBuy,
 * want, shelf: {n, exact, cap}, today: {lgtm, chests, pct}, bonusPct, used, uptime, onDuty, staff,
 * maintainer, ranks, titles, chip, tips, rows}.
 *   open      the Review Desk is built (level >= 1); cost: its next level's price (null at max);
 *             want: autopilot will buy that level (the day before filled and drained the shelf)
 *   shelf     LGTMs on the shelf (n whole, exact) of cap (10 x level)
 *   today     LGTMs given today (the chip's "LGTM ×206"), chests opened with full value today and
 *             the share of them LGTM'd (pct, null before any)
 *   onDuty    heroes on duty now; staff: roster heroes of Lv 10+ (the reviewers); maintainer: the
 *             top-ranked of them ({heroId, name, rank, rankName, title}) or null; ranks: how many
 *             staff hold each rank (index 0..4)
 *   titles    the last five approved ({title, heroId, name, byId, byName, at}, newest first) with
 *             `text` ("“Bump deps” (Fizz), by Rue")
 *   chip      {lgtm, text: "LGTM ×206"} (null before the Review Desk opens)
 *   tips      the chip tooltip's town lines; rows: the Localhost tab's lines (header, lgtm, titles,
 *             desk), as text the views may use or rebuild from the fields
 */
export function townInfo(world) {
  const { state } = world;
  const on = townOn();
  const level = deskLevel(state);
  const max = TT().desk.max;
  const cost = nextDeskCost(state);
  const t = peek(state);
  const exact = shelfOf(state);
  const cap = shelfCap(state);
  const lgtm = at(t && t.t, 0);
  const chests = at(t && t.t, 2);
  const want = !!(at(t && t.t, 1) & WANT) && level >= 1 && level < max;
  let onDutyN = 0;
  let staff = 0;
  const ranks = [0, 0, 0, 0, 0];
  let top = null;
  for (const h of state.heroes) {
    if (!(h.L >= TT().minLevel)) continue;
    staff++;
    const xp = jobXpOf(h);
    const r = rankOf(xp);
    ranks[r]++;
    if (!top || r > top.rank || (r === top.rank && xp > top.xp + EPS)) top = { hero: h, rank: r, xp };
    if (onDuty(world, h)) onDutyN++;
  }
  const up = uptime(state);
  const titles = lastTitles(world).map((e) => Object.assign({ text: titleText(e, true) }, e));
  const pct = chests > 0 ? Math.round((100 * lgtm) / chests) : null;
  const maintainer = top && top.rank > 0 ? {
    heroId: top.hero.id, name: top.hero.name, rank: top.rank, rankName: TOWN.ranks[top.rank].name, title: jobTitle(top.rank),
  } : null;
  const chip = on && level >= 1 ? { lgtm, text: `LGTM ×${fmtNum(lgtm)}` } : null;
  const shelfText = `LGTM ${Math.floor(exact + EPS)}/${cap}`;
  const tips = on && level >= 1 ? [
    `Localhost: ${onDutyN} on duty (Review Desk ${onDutyN}) · ${shelfText}`,
    `${titles.length ? `Last LGTM: ${titles[0].text} · ` : ""}${fmtNum(lgtm)} today${pct != null ? ` (${pct}%)` : ""} · ${up.step ? `${up.label} uptime` : "uptime booting"}`,
  ] : [];
  const deskName = station("review_desk").name;
  const rows = on ? {
    header: `Localhost  ${up.step ? `${up.label} uptime` : "uptime booting"} · ${onDutyN} on duty${level >= 1 ? ` (${deskName} ${onDutyN})` : ""}`,
    lgtm: level >= 1 ? `LGTMs ${Math.floor(exact + EPS)} / ${cap}   +${Math.round(TT().lgtmBonus * 100)}% XP and gold on chests you open · today ${fmtNum(lgtm)}${chests ? ` of ${fmtNum(chests)} (${pct}%)` : ""}` : null,
    titles: titles.length ? `Last approved: ${titles.map((e) => titleText(e)).join(" · ")}` : null,
    desk: level >= 1
      ? `${deskName} Lv ${level} · ${staff} reviewer${staff === 1 ? "" : "s"}${maintainer ? ` · maintainer ${shortName(maintainer.name)}` : ""}${cost != null ? ` · ${want ? "next level when you can pay" : "next level when the shelf fills and runs dry"} · ${fmtNum(cost)} gold` : " · max level"}`
      : `${deskName}: opens Localhost · ${fmtNum(cost)} gold`,
  } : null;
  return {
    on, open: on && level >= 1, level, max, cost, canBuy: on && cost != null && (state.herd.gold || 0) >= cost, want,
    shelf: { n: Math.floor(exact + EPS), exact, cap }, today: { lgtm, chests, pct }, bonusPct: Math.round(TT().lgtmBonus * 100),
    used: at(t && t.u, 0), uptime: up, onDuty: onDutyN, staff, maintainer, ranks, titles, chip, tips, rows,
  };
}
