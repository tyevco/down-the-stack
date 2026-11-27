// The world: createWorld / loadWorld / serialize / tick / command (ARCHITECTURE §3.4, D§2.11).
//
// World = { state (saved, save.js), rt (runtime, rebuilt from snapshots) }. tick() is the pure 1 Hz
// pipeline of D§2.11: clock handling (catch-up <= 5 ticks, offline gaps, a backwards clock), day
// rollover, reconcile, then per simulated tick: statuses, off-duty heroes, rooms, fights, rest,
// herd trackers, badges and autopilot. A per-tick emitter `ev` collects effects and enforces the
// D§11.7 number budgets; rt.version moves when anything visible changed and rt.dirty / majorAt
// drive the host's save policy (save every 30 s while dirty, 2 s after a major event).
//
// command() is the only way the UI changes the world (ARCHITECTURE §3.5): every command validates
// its arguments and answers {ok, error?, msg?}.
//
// Pure: everything depends on (state, snapshots, nowMs) only.

import {
  TUNING as T, BOSSES, ZONES, BUILDINGS, BUILDING_IDX, CLASSES, MAP_BY_ID, REVIEWS, SKILL_SLOTS, BACKLOG, RARITIES, RARITY_IDX,
} from "./data.js";
import { need, fmtNum, autoOn, wellFormed } from "./formulas.js";
import { newState, encodeState, decodeState } from "./save.js";
import { grantXP, learn as learnSkill, autoLearn, respec as respecHero, setClass as setHeroClass } from "./heroes.js";
import {
  findItem, equipItem, setLocked, polish as polishItem, deprecate as deprecateItem, squash as squashItems,
  reroll as rerollItem, itemName,
} from "./items.js";
import * as A from "./agents.js";
import * as H from "./herd.js";
import * as AP from "./autopilot.js";
import * as C from "./combat.js";

const DAY_MS = 86400000;
const RESYNC_MS = 3600000; //     a clock that jumps back more than 1 h resyncs (no accrual for the gap)
const OFFLINE_CAP_MS = 30 * DAY_MS; // Fresh Eyes from wall-clock time is capped at 30 days (D§12.3.11)
const NOTE_TICKS = 3; //          header notes show for 3 s each (D§11.15)
const NOTE_QUEUE = 6;
const BANNER_TICKS = Math.round(T.fx.bannerMaxMs / T.tickMs);
const FX_PER_TICK = 60; //        non-number effects per tick (render budget guard)
const NUM_KINDS = { num: 1, crit: 1, heal: 1, miss: 1, inv: 1, abs: 1, incoming: 1 };
const HERO_SIDE = { incoming: 1, heal: 1 };
const AUTO_KEYS = ["equip", "deprecate", "learn", "polish", "buildings", "maps", "boss", "farm", "calls", "career"];
const NOTIFY_KEYS = ["boss", "lts", "principal"];
const NAME_MAX = 32;
// Opt-in notifications (D§11.15): at most 3 a local day over all kinds; raised only by live ticks
// and commands; drained by the host (takeMilestones), which drops anything older than 10 minutes.
export const MILESTONE_PER_DAY = 3;
const MILESTONE_QUEUE = 6;
export const MILESTONE_TTL_MS = 10 * 60000;
const OFFLINE_HOLD_TICKS = 10; // an offline gap waits at most this long for the first agent listing

// ---------------------------------------------------------------------------------------------
// Creation, load, save
// ---------------------------------------------------------------------------------------------

function newRt(nowMs, tick) {
  return {
    tick: tick || 0, nowMs: nowMs || 0, version: 0,
    bind: new Map(), live: new Map(), contractors: new Map(), orphans: new Map(),
    rooms: [], fights: [], fx: [], notes: [], banner: null,
    dirty: false, majorAt: 0, lastSaveMs: nowMs || 0, errors: [],
    readOnly: false, digestDot: false, windowActive: true, inactiveSince: null, clockBehind: false,
    roomsDirty: true, contractorSeq: 0, apCursor: 0, apPolish: 0, apSig: new Map(), apGear: new Set(),
    cxp: new Map(), bossSeen: null, zoneSeen: null, fxSeq: 0,
  };
}

/** A fresh world (D§13: empty herd, no heroes). */
export function createWorld({ nowMs = 0, seed = 1 } = {}) {
  const state = newState({ nowMs, seed });
  return { state, rt: newRt(nowMs, state.herd.tick) };
}

/**
 * Loads a save text. Corrupt text throws (decodeState's Error with .code parse|shape|crc; the host
 * then tries save.bak). A save from a newer schema version loads read-only: it ticks for display
 * but never accrues, never takes commands and must not be written back (rt.readOnly).
 * @returns {{world, warning:null|string}}
 */
export function loadWorld(text, { nowMs = 0 } = {}) {
  const { state, warning, readOnly } = decodeState(text);
  const world = { state, rt: newRt(nowMs, state.herd.tick) };
  world.rt.readOnly = !!readOnly;
  // the world time the save was written at: the time until the first reconcile (the app closed) is
  // not counted in a hero's off-duty grace (agents.inOffDutyGrace, round 4b)
  world.rt.loadedLastMs = Number.isFinite(state.herd.lastMs) ? state.herd.lastMs : null;
  repairLoaded(state);
  // Contractor records (round 5): new Contractors are numbered after them, and the loaded ones hold
  // their hires for a reconnect window (agents.reconnectOpen) while herdr lists their terminals
  const recs = Array.isArray(state.herd.contractors) ? state.herd.contractors : [];
  for (const r of recs) if (r.seq > world.rt.contractorSeq) world.rt.contractorSeq = r.seq;
  world.rt.recWait = new Set(readOnly ? [] : recs.map((r) => r.seq));
  return { world, warning: warning || null };
}

// Mends what an older build could save wrong (in memory; the next save writes it back):
// - a seat or task title cut through an emoji ends in a lone surrogate, which herdr rejects
//   wherever the text is shown (agents.js now cuts with cutText). The seat drops the half
//   character as normSeat now does, so its hero still matches the space; a title also loses the
//   space before it (questName's trimEnd).
// - Contractor ids in the paused boss fight, the journal, review Wounds / Lessons Learned and the
//   chest inbox: a Contractor's session-keyed state does not outlive the session (round 5: its slim
//   record keeps its number, but a new Contractor or one whose record has gone could take an id
//   seen in an older save), so a saved negative id would seat an unrelated Contractor (a journal
//   line keeps its stored name, and hero id 0).
function repairLoaded(state) {
  const mend = (v) => {
    if (typeof v !== "string") return v;
    const t = wellFormed(v, "");
    return t === v ? v : t.trimEnd();
  };
  for (const h of state.heroes || []) {
    if (typeof h.seat === "string") h.seat = wellFormed(h.seat, "");
    for (const p of h.pend || []) if (p && typeof p.title === "string") p.title = mend(p.title);
  }
  for (const e of state.herd.log || []) {
    if (!Array.isArray(e)) continue;
    if (typeof e[3] === "string") e[3] = mend(e[3]);
    // a Contractor's line: its id was that session's only (a new Contractor would take it and its
    // sheet would list these lines); the line keeps the name it stored (herd.lineName)
    if (e[2] < 0) e[2] = 0;
  }
  const f = state.herd.fight;
  if (f && Array.isArray(f.ids) && f.ids.some((id) => !(id > 0))) {
    const n = f.n || f.ids.length; // the boss's HP pool was sized for every participant
    f.ids = f.ids.filter((id) => id > 0);
    if (Array.isArray(f.hl)) f.hl = f.hl.filter((id) => id > 0);
    if (n !== f.ids.length) f.n = n;
  }
  // the same for a Contractor's review Wounds / Lessons Learned ("rv<review>.<negative id>": a new
  // Contractor would inherit them) and for a chest drop it found that waits in the inbox (no finder)
  for (const kind of ["wounds", "lessons"]) {
    const m = state.herd[kind];
    if (!m || typeof m !== "object") continue;
    for (const key of Object.keys(m)) if (key[0] === "r" && Number(key.slice(key.indexOf(".") + 1)) < 0) delete m[key];
  }
  for (const e of Array.isArray(state.herd.inbox) ? state.herd.inbox : []) if (Array.isArray(e) && e[0] < 0) e[0] = 0;
  // a Contractor record's seat is mended like a hero's (round 5)
  for (const r of Array.isArray(state.herd.contractors) ? state.herd.contractors : []) if (typeof r.seat === "string") r.seat = wellFormed(r.seat, "");
}

/**
 * The save text of the world (compact JSON with a CRC, D§13).
 *
 * An offline gap held for the first agent listing (rt.offlineHold, see tick) lives in memory only,
 * while herd.lastMs has already moved past it. So while one is held the save is written as if the
 * gap were not seen yet: its lastMs is herd.lastMs minus the held gap (the time before the gap
 * plus the seconds stepped since). A restart or a hot reload during the hold (the app closed
 * within ~10 s of its start: close() flushes a save; a crash after a command's 2 s save; the
 * handover text) then finds the same gap again and holds or settles it, instead of losing its
 * Fresh Eyes (D§2.9 rule 3: up to 30 days of it) and the Herd button's "since you last looked" dot
 * (D§10.7). Nothing is counted twice: the call that settles the gap clears the hold, and every
 * later save writes herd.lastMs as it is. Every other saved time is stored relative to lastMs
 * (save.js) and decodes to the same absolute time.
 *
 * Round 5: the save also holds every live Contractor's slim record, beside the records of those
 * whose agent is away (agents.contractorRecords; nothing on a read-only world beyond what it
 * loaded). world.state itself keeps only the latter (herd.contractors).
 */
export function serialize(world) {
  const { state, rt } = world;
  if (!state.herd) return encodeState(state);
  const hold = rt && rt.offlineHold;
  let herd = state.herd;
  // the live Contractors' records with those whose agent is away (round 5, agents.contractorRecords)
  const recs = rt ? A.contractorRecords(world) : null;
  if (recs && recs !== state.herd.contractors) herd = Object.assign({}, herd, { contractors: recs });
  if (hold && hold.dtMs > 0) herd = Object.assign({}, herd, { lastMs: (state.herd.lastMs || 0) - hold.dtMs });
  return encodeState(herd === state.herd ? state : Object.assign({}, state, { herd }));
}

/** Local day number with the 04:00 reset (D§2.9): days since 1970 at 04:00 local time. */
export function localDay(nowMs, tzOffsetMin = 0) {
  const local = nowMs - (Number(tzOffsetMin) || 0) * 60000;
  return Math.floor((local - T.shift.resetHourLocal * 3600000) / DAY_MS);
}

// ---------------------------------------------------------------------------------------------
// The per-tick emitter (ARCHITECTURE §3.4) with the D§11.7 budgets
// ---------------------------------------------------------------------------------------------

function errorOf(world, where, e) {
  const rt = world.rt;
  rt.errors.push(`${where}: ${e && e.message ? e.message : e}`);
  if (rt.errors.length > 20) rt.errors.shift();
}

function guard(world, where, fn) {
  try {
    return fn();
  } catch (e) {
    errorOf(world, where, e);
    return null;
  }
}

/**
 * Queues a header note (D§11.15: one at a time, NOTE_TICKS each, at most NOTE_QUEUE waiting).
 * tag (optional, round 4b): what the note is about, for the stage (view/stage.js headerNote):
 * {kind: "hire", heroId, name, promoted} for a hire (agents.js), {heroId} for a note about one hero
 * (its room); `short` (round 4c, any note): shorter forms, longest first, that keep its point (the
 * event, a hero's first name) for the stage to show whole where the text does not fit ("Tamsin:
 * chest opened Unreviewed"; the whole text goes in the tooltip). The hires of one tick (six at the
 * 04:00 game day turn) are one note on the stage, so every hire after a tick's first is queued
 * without counting against NOTE_QUEUE (`extra`): a note raised meanwhile still shows, after them.
 */
function pushNote(rt, text, color, tag) {
  const t = String(text);
  const q = rt.notes;
  const last = q[q.length - 1];
  if (last && last.text === t) return;
  const kind = tag && typeof tag.kind === "string" ? tag.kind : null;
  const extra = kind === "hire" && q.some((n) => n.kind === "hire" && n.bornTick === rt.tick);
  if (!extra && q.filter((n) => !n.extra).length >= NOTE_QUEUE) return;
  const showTick = last ? Math.max(rt.tick, last.showTick + NOTE_TICKS) : rt.tick;
  const n = { key: `note:${rt.tick}:${q.length}:${t.length}`, text: t, color: color || null, bornTick: rt.tick, showTick };
  if (kind) n.kind = kind;
  if (tag && Number.isFinite(tag.heroId)) n.heroId = tag.heroId;
  if (tag && typeof tag.name === "string") n.name = tag.name;
  if (tag && tag.promoted) n.promoted = true;
  const short = tag ? shortForms(tag.short, t) : null;
  if (short) n.short = short;
  if (extra) n.extra = true;
  q.push(n);
}

/** A note tag's short forms as a list of strings, longest first, none equal to the text; null if none. */
function shortForms(short, text) {
  const list = (Array.isArray(short) ? short : short == null ? [] : [short]).map((x) => String(x)).filter((x) => x && x !== text);
  return list.length ? list : null;
}

function prio(f) {
  if (f.kind === "crit") return 4;
  if (f.skill) return 3;
  if (f.kind === "num") return 2;
  if (f.kind === "heal") return 2;
  return 1;
}

// Merges several numbers into one ("×3 1.2k"), keeping the best one's kind and target.
function mergeNums(list) {
  if (list.length === 1) return list[0];
  const best = list[0];
  let sum = 0;
  let any = false;
  for (const f of list) if (typeof f.value === "number" && f.value > 0) { sum += f.value; any = true; }
  return Object.assign({}, best, { value: sum, merged: list.length, text: `×${list.length} ${any ? fmtNum(sum) : best.text || ""}`.trim() });
}

// heroId -> room id over rt.rooms, kept while rt.rooms is the same array (combat.buildRooms
// returns its cached array, never edited, until the rooms change): the budgets below need it on
// every tick with effects.
function roomsOf(rt) {
  const rooms = rt.rooms || [];
  const c = rt.roomOf;
  if (c && c.rooms === rooms) return c.map;
  const map = new Map();
  for (const r of rooms) for (const id of r.heroIds || []) map.set(id, r.id);
  rt.roomOf = { rooms, map };
  return map;
}

/**
 * D§11.7: at most 2 numbers per hero per tick (priority crit > skill > basic; the rest merge into
 * one), at most 6 per room and 12 per stage. Hero-side numbers (incoming, heals) get their own
 * slot when both kinds are present. Other effects pass (capped at FX_PER_TICK).
 */
function budget(world, list) {
  const rt = world.rt;
  const F = T.fx;
  const nums = [];
  const other = [];
  for (const f of list) (NUM_KINDS[f.kind] ? nums : other).push(f);
  const byHero = new Map();
  for (const f of nums) {
    const k = f.heroId == null ? "_" : f.heroId;
    if (!byHero.has(k)) byHero.set(k, []);
    byHero.get(k).push(f);
  }
  const kept = [];
  const order = (a, b) => prio(b) - prio(a);
  for (const arr of byHero.values()) {
    if (arr.length <= F.numbersPerHero) { kept.push(...arr); continue; }
    const out = arr.filter((f) => !HERO_SIDE[f.kind]).sort(order);
    const inc = arr.filter((f) => HERO_SIDE[f.kind]).sort(order);
    if (out.length && inc.length) {
      kept.push(mergeNums(out), mergeNums(inc));
    } else {
      const l = out.length ? out : inc;
      kept.push(l[0], mergeNums(l.slice(1)));
    }
  }
  const roomOf = roomsOf(rt);
  kept.sort(order);
  const perRoom = new Map();
  const final = [];
  for (const f of kept) {
    if (final.length >= F.numbersPerStage) break;
    const room = f.roomId ?? roomOf.get(f.heroId) ?? "_";
    const n = perRoom.get(room) || 0;
    if (n >= F.numbersPerRoom) continue;
    perRoom.set(room, n + 1);
    final.push(f);
  }
  return final.concat(other.slice(0, FX_PER_TICK));
}

/**
 * The emitter world.tick and world.command pass to every engine module:
 * {fx(kind, data), note(text, color, tag?), banner(text, sub), major(), journal(kind, heroId, text, value, name?),
 * milestone(kind, {title, body})}. fx are buffered per tick and flushed through budget() into rt.fx
 * with keys "fx:<tick>:<n>". `live` (opts.live) lets milestones through: world.tick sets it for the
 * steps and reconcile of a call that is neither the VM's first, the one that settles an offline gap
 * held for the first agent listing, an offline gap nor a clock behind, and turns it off while an
 * offline gap is settled; commands are live.
 */
export function makeEmitter(world, { live = false } = {}) {
  const { state, rt } = world;
  let pending = [];
  const ev = {
    visible: false,
    /** Milestones count only while true: a live tick (or a command), never an app start, an offline gap or a clock behind. */
    live: !!live,
    fx(kind, data) {
      if (pending.length < 400) pending.push(Object.assign({ kind: String(kind) }, data || {}));
    },
    note(text, color, tag) {
      pushNote(rt, text, color, tag);
      ev.visible = true;
    },
    banner(text, sub) {
      rt.banner = { key: `banner:${rt.tick}`, text: String(text), sub: sub == null ? null : String(sub), bornTick: rt.tick };
      ev.visible = true;
    },
    major() {
      rt.majorAt = rt.nowMs;
      rt.dirty = !rt.readOnly;
      ev.visible = true;
    },
    journal(kind, heroId, text, value, name) {
      // the hero's name goes into the line (a Contractor or a hero let go is not there to ask
      // later); callers pass it when the hero has already left the roster
      let who = name;
      if (who == null && heroId) {
        const h = A.heroById(world, heroId);
        who = h ? h.name : undefined;
      }
      H.journal(state, kind, heroId, text, value, rt.nowMs, who);
    },
    /** An opt-in notification milestone (D§11.15): kind boss | lts | principal; data {title, body}. */
    milestone(kind, data) {
      if (!ev.live) return false;
      return raiseMilestone(world, kind, data);
    },
    /** Moves this tick's buffered effects into rt.fx (budgeted, keyed). */
    flush() {
      if (!pending.length) return;
      const list = budget(world, pending);
      pending = [];
      if (rt.fxTick !== rt.tick) { rt.fxTick = rt.tick; rt.fxSeq = 0; }
      // every entry is this emitter's own object (fx() copies the caller's data; mergeNums makes
      // new ones), so it is stamped in place: the same fields and order as a copy, one allocation
      // less per effect (~100 a tick with 30 heroes)
      for (const fx of list) {
        fx.key = `fx:${rt.tick}:${rt.fxSeq++}`;
        fx.bornTick = rt.tick;
        if (fx.text == null) fx.text = "";
        if (fx.value == null) fx.value = 0;
        rt.fx.push(fx);
      }
      ev.visible = true;
    },
  };
  return ev;
}

// ---------------------------------------------------------------------------------------------
// Notification milestones (D§11.15)
// ---------------------------------------------------------------------------------------------

/**
 * Raises an opt-in notification milestone: kind "boss" (a herd-first boss kill), "lts" (an LTS
 * or Keepsake drop) or "principal" (a hero reaches Principal). Only when herd.cfg.notify[kind] is
 * on and fewer than MILESTONE_PER_DAY were raised this local day (the D§2.9 day: 04:00 local, from
 * rt.nowMs and the last snapshot's rt.tzOffsetMin). The count and its day are saved
 * (herd.notified = [day, count, seq]), so the cap holds across restarts; a clock that went back to
 * the day before keeps the later day's count (more than a day back counts afresh). The milestone
 * waits in herd.milestones (saved, at most MILESTONE_QUEUE) until the host drains it
 * (takeMilestones). Callers go through ev.milestone, which lets only live play through. Returns
 * true when queued (or held for the time zone, below).
 *
 * The time zone comes with the snapshots (tick) or a command (command's tzOffsetMin). A milestone
 * raised before either (a click within a second of a load or a hot reload) waits in rt.msHeld
 * until the first tick tells the time zone, then counts toward its own local day: dated by the
 * UTC day, an evening west of UTC would spend the next game day's budget.
 */
export function raiseMilestone(world, kind, data) {
  const { state, rt } = world;
  const herd = state.herd;
  const notify = (herd.cfg && herd.cfg.notify) || {};
  if (!NOTIFY_KEYS.includes(kind) || notify[kind] !== true || rt.readOnly) return false;
  if (!Number.isFinite(rt.tzOffsetMin)) {
    if (!Array.isArray(rt.msHeld)) rt.msHeld = [];
    if (rt.msHeld.length >= MILESTONE_QUEUE) return false;
    rt.msHeld.push({ kind, data, at: rt.nowMs });
    return true;
  }
  return queueMilestone(world, kind, data, rt.nowMs);
}

// Counts a milestone toward the local day of `at` and queues it (raiseMilestone).
function queueMilestone(world, kind, data, at) {
  const { state, rt } = world;
  const herd = state.herd;
  const day = localDay(at, rt.tzOffsetMin);
  const nf = Array.isArray(herd.notified) ? herd.notified : [0, 0, 0];
  let [nDay, count, seq] = [Number(nf[0]) || 0, Number(nf[1]) || 0, Number(nf[2]) || 0];
  // a new day starts afresh; so does a clock more than a day behind the counted day (it was set
  // far ahead and put right: the budget must not stay spent until that day comes)
  if (day > nDay || day < nDay - 1) { nDay = day; count = 0; }
  if (count >= MILESTONE_PER_DAY) return false;
  count++;
  seq++;
  herd.notified = [nDay, count, seq];
  const d = data || {};
  if (!Array.isArray(herd.milestones)) herd.milestones = [];
  herd.milestones.push({ n: seq, kind, at, title: String(d.title || ""), body: d.body == null ? "" : String(d.body) });
  if (herd.milestones.length > MILESTONE_QUEUE) herd.milestones.splice(0, herd.milestones.length - MILESTONE_QUEUE);
  rt.dirty = true;
  rt.majorAt = rt.nowMs; // saved soon: the host posts a milestone only once a save holds it (host.js)
  return true;
}

// The milestones raised before the time zone was known (raiseMilestone), counted now that it is
// (a snapshot without one counts them by the UTC day, as before).
function releaseHeld(world) {
  const { rt } = world;
  const held = rt.msHeld;
  if (!Array.isArray(held) || !held.length) return;
  rt.msHeld = [];
  if (rt.readOnly) return;
  for (const m of held) queueMilestone(world, m.kind, m.data, m.at);
}

/**
 * Drains the milestones waiting for the host (herd.milestones): returns the ones raised within
 * MILESTONE_TTL_MS of nowMs, oldest first, and empties the queue (older ones are dropped: a
 * notification about something long past is noise). Marks the world dirty when it took any.
 * @returns {Array<{n:number, kind:string, at:number, title:string, body:string}>}
 */
export function takeMilestones(world, nowMs) {
  const herd = world.state.herd;
  const q = Array.isArray(herd.milestones) ? herd.milestones : [];
  if (!q.length) return [];
  herd.milestones = [];
  if (!world.rt.readOnly) world.rt.dirty = true;
  const now = Number.isFinite(nowMs) ? nowMs : world.rt.nowMs;
  return q.filter((m) => m && typeof m === "object" && Number.isFinite(m.at) && now - m.at <= MILESTONE_TTL_MS && m.at - now <= MILESTONE_TTL_MS)
    .map((m) => ({ n: Number(m.n) || 0, kind: String(m.kind), at: m.at, title: String(m.title || ""), body: String(m.body || "") }));
}

// ---------------------------------------------------------------------------------------------
// tick (D§2.11)
// ---------------------------------------------------------------------------------------------

function bindKey(rt) {
  let s = "";
  for (const [addr, id] of rt.bind) s += `${addr}=${id};`;
  return s;
}

/**
 * Advances the world to snapshot.nowMs (D§2.11). ticks = elapsed whole seconds since the last tick
 * (rounded), at most 5 per call (the rest of a longer gap is dropped); a gap over 60 s is offline:
 * no combat, Fresh Eyes accrues from wall-clock time (capped at 30 days), Unreviewed chests open
 * (settled after the snapshot is reconciled, see applyOffline).
 * A clock that went backwards accrues nothing until it passes the last tick time again (a jump of
 * more than an hour resyncs instead). Day rollover (Daily Shift) uses snapshot.tzOffsetMin and
 * keeps the highest local day seen.
 * @returns {{advanced:boolean, ticks:number}}
 */
export function tick(world, snap) {
  const { state, rt } = world;
  const herd = state.herd;
  const s = snap || {};
  const now = Number(s.nowMs);
  if (!Number.isFinite(now)) return { advanced: false, ticks: 0 };
  rt.nowMs = now;
  // the local time zone, for the views' dates and clock times (game/view/panels.js) and the
  // notification day; milestones a command raised before it was known count now
  if (Number.isFinite(s.tzOffsetMin)) rt.tzOffsetMin = s.tzOffsetMin;
  releaseHeld(world);
  const dt = now - (herd.lastMs || 0);
  // a clock behind the last tick: nothing accrues until it passes it again, but the snapshot is
  // still reconciled (zero steps) so statuses, bindings and chests seen stay live on the stage; a
  // jump back of more than an hour resyncs instead (lastMs follows the clock, no accrual)
  const behind = dt < 0;
  rt.clockBehind = behind;
  if (behind && -dt > RESYNC_MS && !rt.readOnly) {
    herd.lastMs = now;
    rt.dirty = true;
    return { advanced: false, ticks: 0 };
  }
  const offline = !behind && dt > T.offlineGapSec * 1000;
  let steps = behind || offline ? 0 : Math.min(T.maxCatchUpTicks, Math.round(dt / T.tickMs));
  if (!behind && !offline && steps <= 0) return { advanced: false, ticks: 0 };
  if (rt.readOnly) steps = 0;

  const firstCall = !rt.started; //     the first tick of this VM (an app start or a reload)
  rt.started = true;
  // the call that settles an offline gap held for the first agent listing (below)
  const settlesHold = !offline && !!rt.offlineHold && (hasAgents(s) || rt.tick + steps >= rt.offlineHold.untilTick);
  // Notification milestones come from live play only (D§11.15): the first call after a load, or
  // the one that settles a held gap (chests opened as seen on reopening), an offline gap and a
  // clock behind are catch-up, never a burst of stale notifications.
  const ev = makeEmitter(world, { live: !firstCall && !settlesHold && !offline && !behind && !rt.readOnly });
  const versionBefore = rt.version;
  const bindBefore = bindKey(rt);
  const tick0 = rt.tick; //            effects are aged per call (settleFx)
  const fxBefore = rt.fx.length;
  if (rt.bossSeen == null) rt.bossSeen = (herd.bossKills || []).slice();
  if (rt.zoneSeen == null) rt.zoneSeen = herd.zone || 0;

  if (!rt.readOnly && !behind) {
    const day = localDay(now, s.tzOffsetMin);
    if (day > (herd.day || 0)) herd.day = day; // the Daily Shift resets lazily per hero (agents.shiftToday)
    // the herd's first day (herd.herdAgeDays); a save from before herd.born counts from its oldest hero
    if (!(herd.born > 0)) herd.born = (herd.day || day) - H.herdAgeDays(state) + 1;
    herd.lastMs = offline || steps >= T.maxCatchUpTicks ? now : herd.lastMs + steps * T.tickMs;
  }
  trackWindow(world, s, offline ? dt : 0);

  guard(world, "reconcile", () => A.reconcile(world, s, ev));
  ev.flush();
  // An offline gap is settled after reconcile, so heroes whose agents outlived the app (herdr's
  // core keeps terminals while the app is closed) are live again: their chests are not
  // off-duty chests (D§2.4) and a Waiting hero earns no Fresh Eyes (D§2.9). The first listing
  // after an app start can still be empty (herdr publishes terminals as its window tends them):
  // then the gap waits for the first snapshot with agents, or OFFLINE_HOLD_TICKS ticks. The hold
  // is memory only; serialize() writes a held gap as not yet seen, so a restart or a hot reload
  // during it finds the gap again.
  if (!rt.readOnly && !behind) {
    const live = ev.live;
    ev.live = false; // settling an offline gap is catch-up (no milestones)
    if (offline) {
      if (firstCall && !hasAgents(s)) rt.offlineHold = { dtMs: dt, untilTick: rt.tick + OFFLINE_HOLD_TICKS };
      else applyOffline(world, dt, ev);
    } else if (rt.offlineHold && (hasAgents(s) || rt.tick + steps >= rt.offlineHold.untilTick)) {
      const held = rt.offlineHold;
      rt.offlineHold = null;
      applyOffline(world, held.dtMs, ev);
    }
    ev.live = live;
    ev.flush();
  }
  for (let k = 0; k < steps; k++) stepOnce(world, s, ev);
  // chest items wait in herd.inbox and one is offered per callback, however many steps ran
  if (steps > 0 && state.herd.inbox) {
    guard(world, "drainInbox", () => A.drainInbox(world, ev));
    ev.flush();
  }

  // the tick-based blocked clocks follow the wall clock (offline gaps, dropped catch-up seconds)
  if (!rt.readOnly) guard(world, "syncClocks", () => A.syncClocks(world));

  // expire effects, notes and the banner (an expiry is a visible change too: on an idle stage a
  // note or banner must not linger until the next minute's version bump)
  const shown = rt.fx.length + rt.notes.length + (rt.banner ? 1 : 0);
  settleFx(world, tick0, fxBefore);
  rt.notes = rt.notes.filter((n) => n.showTick + NOTE_TICKS > rt.tick);
  if (rt.banner && rt.tick - rt.banner.bornTick >= BANNER_TICKS) rt.banner = null;
  const expired = rt.fx.length + rt.notes.length + (rt.banner ? 1 : 0) !== shown;

  const visible = ev.visible || expired || steps > 0 && (rt.live.size > 0 || rt.fights.length > 0 || herd.tick % 60 < steps) ||
    offline || behind && rt.live.size > 0 || bindKey(rt) !== bindBefore;
  if (visible && rt.version === versionBefore) rt.version++;
  if (!rt.readOnly) rt.dirty = true;
  return { advanced: true, ticks: steps };
}

function hasAgents(snap) {
  return (Array.isArray(snap.agents) && snap.agents.length > 0) || (Array.isArray(snap.subagents) && snap.subagents.length > 0);
}

/**
 * Ages effects per world.tick call, not per step (the views show age 0 = born this frame, 1 = its
 * fade frame, from rt.tick - bornTick): herdr re-arms a 1 s timer after its callback, so a pump now
 * and then runs 2 steps, and an effect born in the first of them would first render at age 1
 * (invisible), while the previous call's effects would vanish without their fade. So this call's
 * effects are stamped with the final tick, the previous call's with the one before, older ones go.
 * When several steps ran, this call's numbers keep the D§11.7 per-frame budgets (2 a hero, 6 a room,
 * 12 a stage; the newest step first).
 */
function settleFx(world, tick0, nBefore) {
  const rt = world.rt;
  if (rt.tick === tick0) { // no step: nothing ages (effects of a reconcile or a command are age 0)
    rt.fx = rt.fx.filter((f) => rt.tick - f.bornTick < 2);
    return;
  }
  const prev = [];
  for (let i = 0; i < nBefore && i < rt.fx.length; i++) {
    const f = rt.fx[i];
    if (f.bornTick >= tick0) { f.bornTick = rt.tick - 1; prev.push(f); }
  }
  let cur = rt.fx.slice(nBefore);
  if (rt.tick - tick0 > 1 && cur.length) cur = frameBudget(world, cur);
  for (const f of cur) f.bornTick = rt.tick;
  rt.fx = prev.concat(cur);
}

// D§11.7's number caps over several steps' effects (budget() already capped each step), the newest
// first; other effects are kept (at most FX_PER_TICK). Keeps the original order.
function frameBudget(world, list) {
  const F = T.fx;
  const roomOf = roomsOf(world.rt);
  const keep = new Set();
  const perHero = new Map();
  const perRoom = new Map();
  let nums = 0;
  let other = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const f = list[i];
    if (!NUM_KINDS[f.kind]) {
      if (other < FX_PER_TICK) { keep.add(f); other++; }
      continue;
    }
    const h = f.heroId == null ? "_" : f.heroId;
    const room = f.roomId ?? roomOf.get(f.heroId) ?? "_";
    if (nums >= F.numbersPerStage || (perHero.get(h) || 0) >= F.numbersPerHero || (perRoom.get(room) || 0) >= F.numbersPerRoom) continue;
    perHero.set(h, (perHero.get(h) || 0) + 1);
    perRoom.set(room, (perRoom.get(room) || 0) + 1);
    nums++;
    keep.add(f);
  }
  return list.filter((f) => keep.has(f));
}

// One simulated second (D§2.11 "repeat steps").
function stepOnce(world, snap, ev) {
  const { state, rt } = world;
  const herd = state.herd;
  rt.tick = ++herd.tick;
  const tickNo = rt.tick;
  const pairs = A.liveHeroes(world);

  for (const [hero, live] of pairs) guard(world, "stepStatus", () => A.stepStatus(world, hero, live, ev));

  // off duty (D§2.2): Fresh Eyes from wall-clock time; chests older than 24 h open Unreviewed
  for (const hero of state.heroes) {
    if (rt.live.has(hero.id)) continue;
    if (hero.fe < H.freshEyesCapMin(state) && hero.st && hero.st.seals > 0) A.accrueFreshEyes(world, hero, 1 / 60);
    if (tickNo % 60 === 0 && hero.pend && hero.pend.length && !rt.offlineHold) guard(world, "expireChests", () => A.expireChests(world, hero, ev));
  }

  // lanes, fights, rest (combat.js / boss.js)
  rt.rooms = guard(world, "buildRooms", () => C.buildRooms(world)) || [];
  rt.roomsDirty = false;
  for (const room of rt.rooms) {
    if (!roomActive(rt, room)) continue;
    guard(world, "stepRoom", () => C.stepRoom(world, room, ev));
  }
  const api = AP.bossApi(world);
  // a suspended boss fight (herd.fight, e.g. after a reload) comes back once a participant works
  if (herd.fight && tickNo % 5 === 0 && typeof api.resumeFight === "function" && !rt.fights.some((f) => f.kind !== "review")) {
    const f = guard(world, "resumeFight", () => api.resumeFight(world, ev));
    if (f && !rt.fights.includes(f)) rt.fights.push(f);
  }
  for (const f of rt.fights.slice()) {
    const r = guard(world, "stepFight", () => api.stepFight(world, f, ev));
    if (r && r !== "running") {
      const at = rt.fights.indexOf(f);
      if (at >= 0) rt.fights.splice(at, 1);
    }
  }
  for (const [hero, live] of pairs) {
    if (!rt.live.has(hero.id)) continue;
    if (live.state === "shipped" || live.state === "resting") guard(world, "restTick", () => C.restTick(world, hero, live));
  }

  // herd trackers
  trackPairs(world);
  contractorXp(world, ev);
  bossKills(world, snap, ev);
  if (tickNo % 10 === 0) guard(world, "checkBadges", () => H.checkBadges(world, ev));

  // autopilot: every 60 ticks the whole herd, otherwise heroes whose level, gear or crashes changed
  if (tickNo % 60 === 0) {
    guard(world, "autopilot", () => AP.autopilot(world, ev));
    changedHeroes(world); // refresh signatures
  } else {
    const ids = changedHeroes(world);
    if (ids.length) guard(world, "autopilot", () => AP.autopilot(world, ev, { heroIds: ids }));
  }
  ev.flush();
}

function roomActive(rt, room) {
  for (const id of room.heroIds || []) {
    const live = rt.live.get(id);
    if (live && (live.state === "questing" || live.state === "supervising" || live.state === "crashed")) return true;
  }
  return false;
}

// Level, gear (uids and polish), free skill points and crash count, hashed per hero.
function heroSig(hero, live) {
  let s = hero.L * 131 + (hero.spFree || 0);
  for (const it of hero.eq || []) s = (Math.imul(s, 31) + (it ? it.uid * 17 + it.pol : 7)) | 0;
  if (live) s = (Math.imul(s, 31) + (live.crashes ? live.crashes.length : 0) * 7919 + (live.mapId ? 1 : 0)) | 0;
  return s;
}

function changedHeroes(world) {
  const { state, rt } = world;
  const out = [];
  const check = (hero, live) => {
    const sig = heroSig(hero, live);
    const prev = rt.apSig.get(hero.id);
    // first sight (a load, a new hero) only records: the 60-tick pass covers it, so a reload
    // never runs a targeted sweep for every hero at once
    if ((prev !== undefined && prev !== sig) || rt.apGear.has(hero.id)) out.push(hero.id);
    rt.apSig.set(hero.id, sig);
  };
  for (const hero of state.heroes) check(hero, rt.live.get(hero.id));
  for (const c of rt.contractors.values()) check(c, rt.live.get(c.id));
  rt.apGear.clear();
  if (rt.apSig.size > state.heroes.length + rt.contractors.size + 8) {
    const keep = new Set(state.heroes.map((h) => h.id).concat(Array.from(rt.contractors.values()).map((c) => c.id)));
    for (const id of Array.from(rt.apSig.keys())) if (!keep.has(id)) rt.apSig.delete(id);
  }
  return out;
}

// Pair Programmer (D§10.6): seconds during which two guild-mates quest in the same room.
function trackPairs(world) {
  const { state, rt } = world;
  if (H.hasBadge(state, "pair_programmer")) return;
  const seen = new Set();
  for (const [id, live] of rt.live) {
    if (id < 0 || live.state !== "questing") continue;
    const k = `${live.space}|${live.mapId}`;
    if (seen.has(k)) {
      state.herd.pairSec = (state.herd.pairSec || 0) + 1;
      return;
    }
    seen.add(k);
  }
}

// Total XP ever earned at a level (for Contractor XP sharing).
function xpTotalDelta(L0, xp0, L1, xp1) {
  let d = xp1 - xp0;
  for (let l = L0; l < L1; l++) d += need(l);
  return d;
}

/**
 * Contractors (D§3.4): half of the XP a Contractor earns also goes to the lowest-level off-duty
 * hero of its seat, if any.
 */
function contractorXp(world, ev) {
  const { state, rt } = world;
  if (!rt.contractors.size) {
    if (rt.cxp.size) rt.cxp.clear();
    return;
  }
  for (const c of rt.contractors.values()) {
    const prev = rt.cxp.get(c.id);
    rt.cxp.set(c.id, { L: c.L, xp: c.xp });
    if (!prev) continue;
    const gained = xpTotalDelta(prev.L, prev.xp, c.L, c.xp);
    if (!(gained > 0)) continue;
    let best = null;
    for (const h of state.heroes) {
      if (h.seat !== c.seat || rt.live.has(h.id)) continue;
      if (!best || h.L < best.L || (h.L === best.L && h.id < best.id)) best = h;
    }
    if (best) grantXP(state, best, gained / 2, ev);
  }
}

/**
 * Boss kills, however they happened (boss.js credits them): Read-Only Friday when The Friday
 * Deploy falls on a local Friday (D§9.6), a journal line if boss.js wrote none, the herd-first
 * banner, and banked Sprint Seals pouring into a newly opened zone (D§9.1).
 */
function bossKills(world, snap, ev) {
  const { state, rt } = world;
  const herd = state.herd;
  const kills = herd.bossKills || [];
  const seen = rt.bossSeen || [];
  for (let i = 0; i < kills.length; i++) {
    if (!((kills[i] || 0) > (seen[i] || 0))) continue;
    const first = !(seen[i] > 0);
    const b = BOSSES[i];
    if (i === 7 && snap.weekday === 5) H.awardBadge(world, "read_only_friday", ev);
    // boss.js journals "<name> FIXED" / "<name> fixed again" with the kill; credit from elsewhere
    // (a save, a test, the demo) gets the same line, and the first clear its date (D§10.5)
    const text = `${b.name} ${first ? "FIXED" : "fixed again"}`;
    const logged = (herd.log || []).some((e) => e[1] === "boss" && e[0] === rt.nowMs && (e[3] === `${b.name} FIXED` || e[3] === `${b.name} fixed again`));
    if (!logged) ev.journal("boss", 0, text, i);
    if (first) H.noteFirstClear(state, i, rt.nowMs);
    if (first && !rt.banner) ev.banner(`The herd reached frame #${Math.min(ZONES.length, i + 2)}`, `${b.name}: FIXED`);
    if (first) {
      const next = ZONES[i + 1];
      // the kill's Keepsake rides on this toast (boss.js winFight raises none of its own then)
      const ks = rt.firstKeepsake && rt.firstKeepsake.i === i ? ` Keepsake: ${rt.firstKeepsake.name}.` : "";
      ev.milestone("boss", {
        title: `${b.name}: FIXED`,
        body: `${next ? `The herd reached frame #${i + 2}, ${next.name}.` : `The herd reached ${BACKLOG.name}.`}${ks}`,
      });
    }
    ev.major();
  }
  rt.firstKeepsake = null;
  let changed = kills.some((k, i) => (k || 0) !== (seen[i] || 0));
  rt.bossSeen = kills.slice();
  const z = herd.zone || 0;
  if (z > rt.zoneSeen) {
    H.pourBank(state);
    const zone = z < ZONES.length ? ZONES[z] : BACKLOG;
    ev.note(`New zone: ${zone.name}`, null, { short: `${zone.name} open` });
    ev.journal("zone", 0, zone.name, z);
    changed = true;
  }
  rt.zoneSeen = z;
  if (changed) H.checkBadges(world, ev);
}

/**
 * An offline gap (D§2.10): no combat; heroes that were not Waiting accrue Fresh Eyes for the
 * wall-clock time (capped at 30 days); off-duty chests older than 24 h open Unreviewed; a running
 * fight is suspended when boss.js offers it. Runs after reconcile (world.tick), so "Waiting" and
 * "off duty" are what the snapshot says now: an agent that outlived the app is live again.
 */
function applyOffline(world, dtMs, ev) {
  const { state, rt } = world;
  const minutes = Math.min(dtMs, OFFLINE_CAP_MS) / 60000;
  for (const hero of state.heroes) {
    const live = rt.live.get(hero.id);
    if (live && live.status === "blocked") continue;
    A.accrueFreshEyes(world, hero, minutes);
    guard(world, "expireChests", () => A.expireChests(world, hero, ev));
  }
  const api = AP.bossApi(world);
  if (typeof api.suspendFight === "function") {
    for (const f of rt.fights.slice()) guard(world, "suspendFight", () => api.suspendFight(world, f, ev));
  }
  rt.digestPending = true;
}

// "Since you last looked" (D§10.7): the Herd button's dot after 30+ minutes away.
function trackWindow(world, snap, gapMs) {
  const { state, rt } = world;
  const active = snap.windowActive !== false;
  let back = gapMs >= H.DIGEST_AWAY;
  if (!active && rt.windowActive) rt.inactiveSince = rt.nowMs;
  if (active && !rt.windowActive && rt.inactiveSince != null && rt.nowMs - rt.inactiveSince >= H.DIGEST_AWAY) back = true;
  if (active) rt.inactiveSince = null;
  rt.windowActive = active;
  if (back && !H.digest(state).empty) rt.digestDot = true;
}

// ---------------------------------------------------------------------------------------------
// Commands (ARCHITECTURE §3.5)
// ---------------------------------------------------------------------------------------------

const fail = (error) => ({ ok: false, error });

function rosterHero(world, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return world.state.heroes.find((h) => h.id === n) || null;
}

function anyHero(world, id) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  return A.heroById(world, n);
}

function uidOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanName(v) {
  if (typeof v !== "string") return null;
  // control characters never belong in a name
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!s || s.length > NAME_MAX) return null;
  return s;
}

function asBool(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  return null;
}

function heroResting(world, hero) {
  const live = world.rt.live.get(hero.id);
  return !live || live.state === "resting" || live.state === "shipped";
}

const COMMANDS = {
  claimChest(world, a, now, ev) {
    const hero = anyHero(world, a.heroId);
    if (!hero) return fail("No such hero");
    if (!hero.pend || !hero.pend.length) return fail("No chest waiting");
    const r = A.openChests(world, hero, { reason: "click" }, ev);
    return { ok: true, msg: `Opened ${r.opened} chest${r.opened === 1 ? "" : "s"}: +${fmtNum(r.gold)} gold, ${r.seals.toFixed(1)} Seals` };
  },

  markSeen(world, a, now, ev) {
    const hero = anyHero(world, a.heroId);
    if (!hero) return fail("No such hero");
    const r = A.openChests(world, hero, { reason: "click" }, ev);
    return { ok: true, msg: r.opened ? `Opened ${r.opened} chest${r.opened === 1 ? "" : "s"}` : "Seen" };
  },

  equip(world, a) {
    const hero = rosterHero(world, a.heroId);
    if (!hero) return fail("No such hero");
    const uid = uidOf(a.uid);
    if (uid == null) return fail("No such item");
    const f = findItem(world.state, uid);
    if (!f) return fail("No such item");
    if (f.where === "hero" && f.hero === hero) return fail("Already equipped");
    const r = equipItem(world.state, hero, f.item);
    if (!r.ok) return fail(r.error || "Can't equip that");
    world.rt.apGear.add(hero.id);
    return { ok: true, msg: `Equipped ${itemName(f.item)}${r.ported ? ` (+${r.ported} polish ported)` : ""}` };
  },

  lock(world, a) {
    const uid = uidOf(a.uid);
    const locked = asBool(a.locked);
    if (uid == null) return fail("No such item");
    if (locked == null) return fail("locked must be true or false");
    const r = setLocked(world.state, uid, locked);
    return r.ok ? { ok: true, msg: locked ? "Locked" : "Unlocked" } : fail(r.error);
  },

  polish(world, a) {
    const uid = uidOf(a.uid);
    if (uid == null) return fail("No such item");
    const r = polishItem(world.state, uid);
    if (!r.ok) return fail(r.error);
    const f = findItem(world.state, uid);
    if (f && f.hero) world.rt.apGear.add(f.hero.id);
    return { ok: true, msg: `Polished: -${fmtNum(r.cost.gold)} gold, -${r.cost.snippets} Snippets` };
  },

  deprecate(world, a) {
    const uid = uidOf(a.uid);
    if (uid == null) return fail("No such item");
    const r = deprecateItem(world.state, uid);
    return r.ok ? { ok: true, msg: `+${r.snippets} Snippets, +${fmtNum(r.gold)} gold` } : fail(r.error);
  },

  squash(world, a) {
    if (!Array.isArray(a.uids) || a.uids.length !== 3 || a.uids.some((u) => uidOf(u) == null)) return fail("Pick 3 items");
    const r = squashItems(world.state, a.uids.map(Number));
    return r.ok ? { ok: true, msg: `Squashed into ${itemName(r.item)}` } : fail(r.error);
  },

  reroll(world, a) {
    const uid = uidOf(a.uid);
    const pos = Number(a.affix);
    if (uid == null) return fail("No such item");
    if (!Number.isInteger(pos) || pos < 0) return fail("No such affix");
    const r = rerollItem(world.state, uid, pos);
    if (!r.ok) return fail(r.error);
    const f = findItem(world.state, uid);
    if (f && f.hero) world.rt.apGear.add(f.hero.id);
    return { ok: true, msg: "Rerolled" };
  },

  learn(world, a) {
    const hero = rosterHero(world, a.heroId);
    if (!hero) return fail("No such hero");
    const slot = typeof a.slot === "string" ? SKILL_SLOTS.indexOf(a.slot) : Number(a.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= SKILL_SLOTS.length) return fail("No such skill slot");
    const r = learnSkill(hero, slot);
    return r.ok ? { ok: true, msg: `Rank ${r.rank}` } : fail(r.error);
  },

  autoLearn(world, a) {
    const hero = rosterHero(world, a.heroId);
    if (!hero) return fail("No such hero");
    const on = asBool(a.on);
    if (on == null) return fail("on must be true or false");
    hero.autoLearn = on;
    // the herd's switch rules over the hero's: with auto-learn off for the herd (or the autopilot
    // master switch off) the points wait, and the next autopilot pass spends them once it is on;
    // the message says so (the sheet flashes it), so turning it on is never a silent no-op
    const herdOn = autoOn(world.state, "learn");
    if (on && herdOn) autoLearn(hero);
    if (!on) return { ok: true, msg: "Auto-learn off" };
    if (herdOn) return { ok: true, msg: "Auto-learn on" };
    const master = !(world.state.herd.cfg && world.state.herd.cfg.autopilot === false);
    return { ok: true, msg: master ? "Auto-learn on, but it is off for the herd (Settings)" : "Auto-learn on, but the Autopilot is off (Settings)" };
  },

  respec(world, a, now) {
    const hero = rosterHero(world, a.heroId);
    if (!hero) return fail("No such hero");
    const r = respecHero(hero, now, { resting: heroResting(world, hero), herd: world.state.herd });
    if (!r.ok) return fail(r.error);
    return { ok: true, msg: r.free ? "Respec (free)" : `Respec: -${r.cost} Snippets` };
  },

  setClass(world, a) {
    const hero = rosterHero(world, a.heroId);
    if (!hero) return fail("No such hero");
    const cls = typeof a.cls === "string" ? a.cls : Number(a.cls);
    const r = setHeroClass(world.state, hero, cls);
    if (!r.ok) return fail(r.error);
    world.rt.apGear.add(hero.id); // a new class may need a new weapon
    return { ok: true, msg: r.msg || `${CLASSES[hero.cls].name}${r.cost ? ` (-${r.cost} Snippets)` : ""}` };
  },

  pinMap(world, a) {
    const hero = rosterHero(world, a.heroId);
    if (!hero) return fail("No such hero");
    const id = a.mapId;
    if (id != null && !(MAP_BY_ID[id] || id === BACKLOG.id)) return fail("No such map");
    if (id != null && !H.mapUnlocked(world.state, id)) return fail("That map is not open yet");
    hero.pinMap = id == null ? null : id;
    const live = world.rt.live.get(hero.id);
    if (live) AP.moveTo(world, hero, live, AP.chooseMap(world, hero, live));
    return { ok: true, msg: id == null ? "Map: auto" : `Staying on ${id}` };
  },

  challenge(world, a, now, ev) {
    const kind = a.kind;
    const idx = Number(a.idx);
    // "backlog" (idx = the boss floor, D§9.8) goes beyond the ARCHITECTURE §3.5 table
    if (kind !== "boss" && kind !== "review" && kind !== "backlog") return fail("kind must be boss, review or backlog");
    const max = kind === "boss" ? BOSSES.length : kind === "review" ? REVIEWS.length : Infinity;
    if (!Number.isInteger(idx) || idx < 0 || idx >= max) return fail(`No such ${kind}`);
    const api = AP.bossApi(world);
    if (typeof api.canChallenge !== "function" || typeof api.startFight !== "function") return fail("Bosses are not available");
    const rt = world.rt;
    let ids;
    if (kind === "review") {
      const hero = rosterHero(world, a.heroId);
      if (!hero) return fail("A review needs a hero");
      const live = rt.live.get(hero.id);
      if (!live || live.state !== "questing") return fail(`${hero.name} must be working`);
      if (rt.fights.some((f) => (f.heroIds || []).includes(hero.id))) return fail(`${hero.name} is already in a fight`);
      ids = [hero.id];
    } else if (kind === "backlog") {
      if (rt.fights.some((f) => f.kind !== "review")) return fail("A boss fight is already running");
      ids = []; // boss.js picks the heroes standing in the Backlog
    } else {
      if (rt.fights.some((f) => f.kind !== "review")) return fail("A boss fight is already running");
      ids = AP.bossParticipants(world, idx);
      if (a.heroId != null) {
        const n = Number(a.heroId);
        if (ids.includes(n)) ids = [n].concat(ids.filter((x) => x !== n));
      }
      if (!ids.length) return fail("Nobody is working in that zone");
    }
    const c = kind === "review" ? api.canChallenge(world, kind, idx, ids[0]) : api.canChallenge(world, kind, idx);
    if (!c || !c.ok) return fail((c && (c.error || c.label)) || "Can't challenge now");
    if (kind !== "review" && Array.isArray(c.heroIds) && c.heroIds.length) {
      // boss.js picked the participants (helpers included); the clicked hero leads if it is one
      ids = c.heroIds.slice();
      const n = Number(a.heroId);
      if (a.heroId != null && ids.includes(n)) ids = [n].concat(ids.filter((x) => x !== n));
    }
    if (!ids.length) return fail("Nobody is working in the Backlog");
    const f = api.startFight(world, kind, idx, ids, ev);
    if (!f) return fail("Can't challenge now");
    if (!rt.fights.includes(f)) rt.fights.push(f);
    const name = kind === "boss" ? BOSSES[idx].name : kind === "review" ? REVIEWS[idx].opponent : f.name || `Backlog floor ${idx}`;
    return { ok: true, msg: `Challenge: ${name}` };
  },

  retreat(world, a, now, ev) {
    const rt = world.rt;
    const heroId = a.heroId == null ? null : Number(a.heroId);
    const f = heroId != null ? rt.fights.find((x) => (x.heroIds || []).includes(heroId)) : rt.fights.find((x) => x.kind !== "review");
    // a boss fight paused in herd.fight (D§9.5) can be ended too (boss.retreat closes it)
    if (!f && !(heroId == null && world.state.herd.fight)) return fail("No fight in progress");
    const api = AP.bossApi(world);
    if (typeof api.retreat !== "function") return fail("Bosses are not available");
    // boss.retreat(world, ev, heroId): ends the boss fight (no heroId) or that hero's fight
    const r = api.retreat(world, ev, heroId);
    if (r && r.ok === false) return fail(r.error || "No fight in progress");
    const at = f ? rt.fights.indexOf(f) : -1;
    if (at >= 0) rt.fights.splice(at, 1);
    return { ok: true, msg: (r && r.msg) || "Postmortem" };
  },

  rename(world, a) {
    const name = cleanName(a.name);
    if (!name) return fail(`A name is 1-${NAME_MAX} characters`);
    if (a.herd) {
      world.state.herd.name = name;
      return { ok: true, msg: `The herd is now ${name}` };
    }
    const hero = rosterHero(world, a.heroId);
    if (!hero) return fail("No such hero");
    hero.name = name;
    return { ok: true, msg: `Renamed to ${name}` };
  },

  retire(world, a, now, ev) {
    const hero = rosterHero(world, a.heroId);
    if (!hero) return fail("No such hero");
    if (hero.L < 30) return fail("Retirement needs Lv 30");
    if (world.rt.fights.some((f) => (f.heroIds || []).includes(hero.id))) return fail(`${hero.name} is in a fight`);
    // unbind first: an open task closes into a pending chest, which the claim below then opens
    // (the person is looking: full value) instead of leaving with the retiree
    A.unbindHero(world, hero.id, ev);
    A.openChests(world, hero, { reason: "click" }, ev);
    const r = H.retire(world, hero.id, now, ev);
    if (!r.ok) return fail(r.error);
    // a paused boss fight (herd.fight) loses this participant; one nobody is left in closes as a
    // Postmortem (Wounds kept) instead of waiting for a hero who never comes back
    const api = AP.bossApi(world);
    if (typeof api.leaveSavedFight === "function") api.leaveSavedFight(world, hero.id, ev);
    // the freed slot goes to the longest-running Contractor at once, if the day has a hire left
    const hired = A.promoteContractors(world, ev);
    return { ok: true, msg: hired ? `${r.msg}; a contractor joined the roster` : r.msg };
  },

  rebind(world, a, now, ev) {
    if (typeof a.address !== "string" || !a.address) return fail("No live agent at that address");
    const n = Number(a.heroId);
    if (!Number.isInteger(n) || n <= 0) return fail("No such hero");
    const r = A.rebind(world, n, a.address, ev);
    return r.ok ? { ok: true, msg: r.msg } : fail(r.error);
  },

  buy(world, a, now, ev) {
    const b = a.building;
    const i = typeof b === "string" ? BUILDING_IDX[b] : Number(b);
    if (!(Number.isInteger(i) && BUILDINGS[i])) return fail("Unknown building");
    const r = H.buy(world.state, i);
    if (!r.ok) return fail(r.error);
    ev.note(`Localhost: ${BUILDINGS[i].name} ${r.level}`, null, { short: `${BUILDINGS[i].name} ${r.level}` });
    return { ok: true, msg: `${BUILDINGS[i].name} ${r.level} (-${fmtNum(r.cost)} gold)` };
  },

  setting(world, a) {
    const cfg = world.state.herd.cfg;
    const key = String(a.key || "");
    const v = a.value;
    if (key === "calm") {
      const b = asBool(v);
      if (b == null) return fail("calm must be true or false");
      cfg.calm = b;
    } else if (key === "nums") {
      if (!["all", "crits", "off"].includes(v)) return fail("nums must be all, crits or off");
      cfg.nums = v;
    } else if (key === "stageH") {
      const n = Number(v);
      if (!(Number.isFinite(n) && n >= 64 && n <= 420)) return fail("stageH must be 64-420");
      cfg.stageH = Math.round(n);
    } else if (key === "auto") {
      // the autopilot master switch (D§11.15): every system stops; the per-system switches keep
      // their values for when it comes back on (formulas.autoOn)
      const b = asBool(v);
      if (b == null) return fail("auto must be true or false");
      cfg.autopilot = b;
    } else if (key === "glow") {
      // loot glow minimum rarity (D§11.15): a rarity id or index; loot glows and pillars below it
      // are not drawn (0, Prototype: every drop glows)
      const i = typeof v === "string" ? RARITY_IDX[v] : typeof v === "number" ? v : NaN;
      if (!(Number.isInteger(i) && i >= 0 && i < RARITIES.length)) return fail("glow must be a rarity");
      cfg.glow = i;
    } else if (key === "collapse" || key === "collapsed") {
      // collapse: the setting (D§11.15); collapsed: the host's note that it hid the stage itself
      // and owes the layout a layout.show (host.js stageAuto)
      const b = asBool(v);
      if (b == null) return fail(`${key} must be true or false`);
      cfg[key] = b;
    } else if (key.startsWith("auto.") && AUTO_KEYS.includes(key.slice(5))) {
      const b = asBool(v);
      if (b == null) return fail(`${key} must be true or false`);
      cfg.auto[key.slice(5)] = b;
    } else if (key.startsWith("notify.") && NOTIFY_KEYS.includes(key.slice(7))) {
      const b = asBool(v);
      if (b == null) return fail(`${key} must be true or false`);
      cfg.notify[key.slice(7)] = b;
    } else {
      return fail(`Unknown setting ${key}`);
    }
    return { ok: true, msg: "Saved" };
  },

  // not in ARCHITECTURE §3.5: the Herd panel's Digest tab clears the dot (D§10.7)
  digestSeen(world, a, now) {
    H.digestMark(world.state, now); // herd.digestAt = now, plus the snapshot the next digest diffs against
    world.rt.digestDot = false;
    world.state.herd.unseenUnrev = 0;
    return { ok: true };
  },

  // round 4: the Digest was viewed (its tab shown): chests opened Unreviewed are seen, so the Herd
  // dot no longer stands for them (H.unseenLosses); the digest itself keeps its lines until marked read
  lossesSeen(world) {
    const had = H.unseenLosses(world.state);
    world.state.herd.unseenUnrev = 0;
    return { ok: true, msg: had ? `${had} Unreviewed chest${had === 1 ? "" : "s"} seen` : "Seen" };
  },
};

/** Command names (ARCHITECTURE §3.5, plus digestSeen and lossesSeen). */
export const COMMAND_NAMES = Object.keys(COMMANDS);

/**
 * Runs one UI command (ARCHITECTURE §3.5). Every command validates its arguments; a read-only
 * world refuses them all. Success bumps rt.version and marks the world dirty. `tzOffsetMin`
 * (optional): the local time zone as the snapshots give it, for a milestone the command raises.
 * @returns {{ok:boolean, error?:string, msg?:string}}
 */
export function command(world, name, args, nowMs, tzOffsetMin) {
  const rt = world.rt;
  const fn = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : null;
  if (!fn) return fail(`Unknown command: ${name}`);
  if (rt.readOnly) return fail("This save is read-only (it was made by a newer version)");
  const now = Number.isFinite(nowMs) ? nowMs : rt.nowMs;
  if (Number.isFinite(nowMs)) rt.nowMs = nowMs;
  // the host's local time zone (new Date(nowMs).getTimezoneOffset()): a milestone raised by a
  // command before the first tick then counts toward the local day at once (raiseMilestone)
  if (Number.isFinite(tzOffsetMin)) rt.tzOffsetMin = tzOffsetMin;
  const ev = makeEmitter(world, { live: true }); // a person's own action is live play
  let res;
  try {
    res = fn(world, args && typeof args === "object" ? args : {}, now, ev) || fail("No result");
  } catch (e) {
    errorOf(world, `command ${name}`, e);
    return fail(`Internal error: ${e && e.message ? e.message : e}`);
  }
  ev.flush();
  if (res.ok) {
    rt.version++;
    rt.dirty = true;
  }
  return res;
}
