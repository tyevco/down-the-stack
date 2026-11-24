// Agents -> heroes (D§2, D§3): snapshot reconcile (seat binding and rebinding, roster limits and
// Contractors, seq-gated status transitions, Forklings from sub-agents, "seen" via focus), the
// per-tick task model (8-tick close debounce, Seals, Commit Chests and their merging, Daily Shift,
// Fresh Eyes drain, Unblocked, flap guard, class-signature recording) and chest opening.
//
// Runtime state lives in world.rt (never saved): rt.bind address -> heroId, rt.live heroId -> Live,
// rt.contractors address -> Hero (Contractors have negative ids). Everything that must survive a
// restart is on the saved Hero (pending chests, shift, Fresh Eyes, cooldowns, signature).
//
// Timing conventions (all in ticks of herd.tick == rt.tick, one per simulated second):
//   hero.cd.unblockedUntil / unblockedCdUntil are absolute ticks that are pushed forward on every
//   tick the hero is not Questing, so Unblocked and its cooldown only run down while Questing
//   (D§2.6): "active" is cd.unblockedUntil > tick (see unblockedActive()).
//   live.task.closeCountdown counts the 8 ticks of D§2.3; live.flapUntil the 300-tick flap pause.
//
// Pure: no host calls, no Date.now(), no Math.random().

import { TUNING as T, CLASSES, CLASS_IDX, MAP_BY_ID, SLOTS, AFFIX_IDX, BACKLOG, KEEPSAKE_IDX } from "./data.js";
import {
  chestTierOf, shiftSealMult, shiftKillMult, shiftBand, chestGold, chestXP, mobXP, gap as gapMult,
  crowding as crowdingMult, partyXp, iRef, itemTier, polishMax,
} from "./formulas.js";
import { newHero, stats, grantXP, recordTask, autoRanks, careerOf } from "./heroes.js";
import { rollChest, baseIdFor, stashAdd, repairItem } from "./items.js";
import { seedOf } from "./rng.js";
import {
  addGold, addSeals, herdXpBonus, freshEyesCapMin, onboardingBonus, awardBadge, logDrop, journal as herdJournal,
} from "./herd.js";
import { chooseMap, mapLevels, offerDrop } from "./autopilot.js";
import { heroCtx, addBuff, unblockedTicks } from "./combat.js";

const S = T.seals;
const INBOX_PER_TICK = 1; // chest items offered per world.tick (queueDrop)
const CLOSE_TICKS = T.taskCloseTicks; // 8
const TITLE_MAX = 40;
const NORM_MAX = 32;
const STATUSES = { working: 1, blocked: 1, done: 1, idle: 1 };
const FOCUS_SEEN = "focus";

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Unknown statuses count as idle (D§2.10). */
export function normStatus(s) {
  return STATUSES[s] ? s : "idle";
}

/** norm() of D§3.1: lowercase, trimmed, at most 32 characters. */
export function normSeat(s) {
  return String(s == null ? "" : s).trim().toLowerCase().slice(0, NORM_MAX);
}

/** Seat key (D§3.1): norm(space.name || space.id || "nospace") + "/" + (program.key || app || "agent"). */
export function seatKey(spaceName, spaceId, programKey, app) {
  const sp = normSeat(spaceName) || normSeat(spaceId) || "nospace";
  return `${sp}/${programKey || app || "agent"}`;
}

function seatProgram(seat) {
  const s = String(seat || "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function agentSeat(a) {
  return seatKey(a.space_name, a.space, a.program && a.program.key, a.app);
}

/** Terminals with neither program nor app never become heroes (D§2.10). */
function hasProgram(a) {
  return !!((a.program && a.program.key) || a.app);
}

function trimTitle(t) {
  const s = String(t == null ? "" : t).trim();
  return s.length > TITLE_MAX ? s.slice(0, TITLE_MAX) : s;
}

function ensureRt(rt) {
  if (!rt.bind) rt.bind = new Map();
  if (!rt.live) rt.live = new Map();
  if (!rt.contractors) rt.contractors = new Map();
  if (!rt.orphans) rt.orphans = new Map();
  if (rt.contractorSeq == null) rt.contractorSeq = 0;
  if (rt.tick == null) rt.tick = 0;
}

/** A hero by id: roster heroes (id > 0) or live Contractors (id < 0). */
export function heroById(world, id) {
  if (id == null) return null;
  if (id < 0) {
    for (const c of (world.rt && world.rt.contractors ? world.rt.contractors.values() : [])) if (c.id === id) return c;
    return null;
  }
  for (const h of world.state.heroes) if (h.id === id) return h;
  return null;
}

/** Every live hero with its Live in a stable order: roster order, then Contractors by id. */
export function liveHeroes(world) {
  const rt = world.rt;
  const out = [];
  if (!rt || !rt.live || !rt.live.size) return out;
  for (const h of world.state.heroes) {
    const live = rt.live.get(h.id);
    if (live) out.push([h, live]);
  }
  const cs = Array.from(rt.contractors.values()).sort((a, b) => b.id - a.id);
  for (const c of cs) {
    const live = rt.live.get(c.id);
    if (live) out.push([c, live]);
  }
  return out;
}

// The same stats ctx combat uses for the hero (one heroes.stats cache entry per hero).
function statsCtx(world, hero) {
  return heroCtx(world, hero);
}

/** Is Unblocked active on this hero right now (D§2.6)? */
export function unblockedActive(hero, tick) {
  return !!(hero && hero.cd && hero.cd.unblockedUntil > tick);
}

/** Questing ticks of Unblocked left (0 when inactive). */
export function unblockedLeft(hero, tick) {
  return unblockedActive(hero, tick) ? hero.cd.unblockedUntil - tick : 0;
}

// ---------------------------------------------------------------------------------------------
// Hero state (D§2.2)
// ---------------------------------------------------------------------------------------------

/** Forklings that count (the first N attached; extra ones are a "+n" tag and do nothing). */
export function countedForklings(live) {
  const n = live.forkCount || T.forkling.counted;
  return (live.forklings || []).slice(0, n);
}

/** Number of counted Forklings working right now. */
export function workingForklings(live) {
  let n = 0;
  for (const f of countedForklings(live)) if (f.status === "working") n++;
  return n;
}

/**
 * The hero's state from its live status (D§2.2 precedence Waiting > Questing > Supervising >
 * Shipped > Resting); "crashed" while Questing during a crash (live.crashedUntil > tick).
 * @param {object} live  @param {number} [tick] defaults to the tick of the last stepStatus/reconcile
 */
export function heroState(live, tick) {
  if (!live) return "resting";
  const t = tick ?? live.nowTick ?? 0;
  const s = live.status;
  if (s === "blocked") return "waiting";
  if (s === "working") return live.crashedUntil > t ? "crashed" : "questing";
  if (workingForklings(live) > 0) return "supervising";
  if (s === "done") return "shipped";
  return "resting";
}

// ---------------------------------------------------------------------------------------------
// Live objects
// ---------------------------------------------------------------------------------------------

function newLive(world, hero, a, tick) {
  const st = stats(hero, statsCtx(world, hero));
  return {
    heroId: hero.id, address: a.address, contractor: !!hero.contractor,
    status: normStatus(a.status), seq: a.seq, statusSince: tick, prevStatus: null, state: "resting",
    focused: false, pinned: false, program: null, app: null, title: "", space: "", spaceName: "", tab: "",
    tabName: "", pane: "", paneName: null,
    task: null, blockedSince: null, blockedAtMs: null, blockedTicks: 0, bubbleShown: false,
    forklings: [], forkCount: st.forklingCount || T.forkling.counted, spawnPending: false,
    flap: [], flapUntil: 0,
    hp: Math.max(1, Math.round(st.maxHp * (hero.hpFrac > 0 ? hero.hpFrac : 1))), maxHp: st.maxHp,
    buffs: [], cds: {}, actionCount: 0, bisect: { target: null, stacks: 0 }, crashedUntil: 0, lastCupTick: -999,
    mapId: null, floor: 0, lane: [], engagedUid: null, statsCache: null, crashes: [],
    order: 0, boundTick: tick, nowTick: tick, why: null,
  };
}

function updateLiveFields(world, live, a, snap) {
  live.address = a.address;
  live.pinned = !!a.pinned;
  const ft = snap.focusedTerminal;
  live.focused = ft != null ? ft === a.address : !!a.focused;
  live.program = a.program || null;
  live.app = a.app || null;
  live.title = a.title == null ? "" : String(a.title);
  live.space = a.space || "";
  live.spaceName = a.space_name || "";
  live.tab = a.tab || "";
  live.tabName = a.tab_name == null ? "" : String(a.tab_name);
  live.pane = a.pane || "";
  live.paneName = a.pane_name == null ? null : String(a.pane_name);
  if (live.task) {
    const t = trimTitle(a.title);
    if (t) live.task.title = t;
  }
}

function newTask(live, tick) {
  return {
    openTick: tick, workSec: 0, blockedSec: 0, sealAcc: 0, creditSec: 0, creditSeal: 0, forkMin: 0, forkSeal: 0,
    spawned: !!live.spawnPending, blocks: 0, closeCountdown: null, title: trimTitle(live.title),
  };
}

function openTask(live, tick) {
  live.task = newTask(live, tick);
  live.spawnPending = false;
  return live.task;
}

// ---------------------------------------------------------------------------------------------
// Binding (D§3.1 - D§3.4)
// ---------------------------------------------------------------------------------------------

function isBound(world, heroId) {
  return world.rt.live.has(heroId);
}

function lowestFreeOrd(state, seat) {
  const used = new Set();
  for (const h of state.heroes) if (h.seat === seat) used.add(h.ord);
  let o = 0;
  while (used.has(o)) o++;
  return o;
}

/** Heroes created on the herd's current local day (D§3.4: at most 6). */
export function hiredToday(state) {
  const herd = state.herd;
  const h = herd.hired;
  return Array.isArray(h) && h[0] === herd.day ? h[1] || 0 : 0;
}

function noteHire(state) {
  const herd = state.herd;
  const n = hiredToday(state) + 1;
  herd.hired = [herd.day, n];
}

function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// One fixed Alpha affix per slot for the Contractor reference kit (D§3.4 "all Alpha").
const KIT_AFFIX = { weapon: "memo", hat: "typed", hoodie: "robust", mug: "typed", boots: "idem", sticker: "memo" };

/**
 * A Contractor (D§3.4): never saved, Level = max(1, median roster level - 5), reference kit at that
 * level (all Alpha, polish about L/10), class from the agent's signature if known, else Shellmancer
 * (Interns below Lv 10, where no class exists yet). Built on a scratch herd so the saved counters
 * (hero ids, item uids, the herd RNG) are untouched; ids are negative.
 */
export function makeContractor(world, a, seat, nowMs) {
  const { state, rt } = world;
  ensureRt(rt);
  const L = Math.max(1, Math.round(median(state.heroes.map((h) => h.L))) - T.roster.contractorLevelsBelowMedian);
  const scratch = { herd: { nextHeroId: 1, nextUid: 1, rng: seedOf(`${a.address}#contractor`), day: state.herd.day }, heroes: [] };
  rt.contractorSeq++;
  // an ordinal no roster hero uses, so the default name is the Contractor's own
  const h = newHero(scratch, { seat, sid: a.space || null, ord: 1000 + rt.contractorSeq, nowMs });
  h.id = -rt.contractorSeq;
  h.contractor = true;
  h.L = L;
  h.cls = L >= 10 ? CLASS_IDX.shellmancer : 0;
  h.prov = 0;
  h.rev = [L >= 30 ? 1 : 0, L >= 60 ? 1 : 0];
  h.sp = autoRanks(h.cls, L, true);
  h.spFree = 0;
  h.autoLearn = true;
  const i = iRef(L);
  const t = itemTier(i);
  const weaponType = CLASSES[h.cls].weapon;
  h.eq = SLOTS.map((slot, s) => ({
    uid: -(rt.contractorSeq * 10 + s + 1),
    base: baseIdFor(slot, t, slot === "weapon" ? weaponType : slot),
    ilvl: i, rar: 1, pol: Math.min(polishMax(1), Math.round(L / 10)),
    aff: [[AFFIX_IDX[KIT_AFFIX[slot]], 50]], flags: 0, prop: -1,
  }));
  return h;
}

/**
 * Removes a roster hero to make room (D§3.4): its gear goes to the stash (auto-deprecate applies),
 * pending chests open Unreviewed for the herd (gold and items; no Seals, no XP: the hero leaves).
 */
function evictHero(world, hero, ev) {
  const state = world.state;
  openChests(world, hero, { reason: "unreviewed", all: true, noXp: true }, ev);
  const idx = state.heroes.indexOf(hero);
  if (idx >= 0) state.heroes.splice(idx, 1);
  for (let s = 0; s < hero.eq.length; s++) {
    const it = hero.eq[s];
    hero.eq[s] = null;
    if (it && !(it.base === 0 && it.rar === 0)) stashAdd(state, it);
  }
  emitJournal(world, ev, "leave", hero.id, hero.name, hero.L);
}

function emitJournal(world, ev, kind, heroId, text, value) {
  if (ev && typeof ev.journal === "function") ev.journal(kind, heroId, text, value);
  else herdJournal(world.state, kind, heroId, text, value, world.rt && world.rt.nowMs);
}

/** Picks a free hero for a new terminal (D§3.2 step 2), or null. */
function pickFreeHero(world, a, seat) {
  const state = world.state;
  const prog = seatProgram(seat);
  let best = null;
  let bestKey = null;
  for (const h of state.heroes) {
    if (isBound(world, h.id)) continue;
    const sameSeat = h.seat === seat;
    // a renamed space keeps its id: re-key heroes whose space id and program match (D§3.1)
    const rekey = !sameSeat && h.sid && a.space && h.sid === a.space && seatProgram(h.seat) === prog;
    if (!sameSeat && !rekey) continue;
    const key = [
      a.pane_name != null && h.lastPane === a.pane_name ? 1 : 0,
      a.tab_name != null && h.lastTab === String(a.tab_name) ? 1 : 0,
      h.L, h.seenAt || 0, -h.id,
    ];
    if (!best || cmpKey(key, bestKey) > 0) {
      best = h;
      bestKey = key;
    }
  }
  return best;
}

function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

/**
 * Binds a new terminal to a hero (D§3.2): fast rebind by saved address, then a free hero of the
 * seat, else a new hero (roster < 30 and < 6 created today; a full roster first frees the
 * least-recently-seen unbound hero below Lv 10), else a Contractor.
 * @returns {number} the hero id
 */
function bindAgent(world, a, snap, ev) {
  const { state, rt } = world;
  const now = snap.nowMs;
  const seat = agentSeat(a);
  let hero = null;
  let fast = false;
  for (const h of state.heroes) {
    if (h.addr === a.address && !isBound(world, h.id) && (h.seat === seat || (h.sid && h.sid === a.space))) {
      hero = h;
      fast = true;
      break;
    }
  }
  if (!hero) hero = pickFreeHero(world, a, seat);
  // a read-only world (a save from a newer version, never written back) binds for display only:
  // no hires (a new agent plays as an unsaved Contractor), no chests, no XP (world.tick runs no steps)
  if (!hero && !rt.readOnly) {
    const R = T.roster;
    if (hiredToday(state) < R.newPerDay) {
      if (state.heroes.length >= R.max) {
        let victim = null;
        for (const h of state.heroes) {
          if (isBound(world, h.id) || h.L >= 10) continue;
          if (!victim || (h.seenAt || 0) < (victim.seenAt || 0) || ((h.seenAt || 0) === (victim.seenAt || 0) && h.id < victim.id)) victim = h;
        }
        if (victim) evictHero(world, victim, ev);
      }
      if (state.heroes.length < R.max) {
        hero = newHero(state, { seat, sid: a.space || null, ord: lowestFreeOrd(state, seat), nowMs: now });
        state.heroes.push(hero);
        noteHire(state);
        emitJournal(world, ev, "hire", hero.id, hero.name, 1);
        if (ev) ev.note?.(`New hire: ${hero.name}`);
      }
    }
  }
  let contractor = false;
  if (!hero) {
    hero = makeContractor(world, a, seat, now);
    rt.contractors.set(a.address, hero);
    contractor = true;
  }
  if (!contractor) {
    hero.seat = seat;
    if (a.space) hero.sid = a.space;
    hero.addr = a.address;
    if (a.pane_name != null) hero.lastPane = String(a.pane_name);
    if (a.tab_name != null) hero.lastTab = String(a.tab_name);
    hero.seenAt = now;
  }
  const live = newLive(world, hero, a, rt.tick);
  live.fast = fast;
  if (hero.cd && hero.cd.unblockedUntil > rt.tick) {
    addBuff(live, "unblocked", hero.cd.unblockedUntil - rt.tick, { dmg: T.unblocked.dmg, xp: T.unblocked.xp });
  }
  rt.bind.set(a.address, hero.id);
  rt.live.set(hero.id, live);
  rt.roomsDirty = true;
  updateLiveFields(world, live, a, snap);
  live.mapId = chooseMap(world, hero, live);
  return hero.id;
}

/**
 * First sight of a terminal (or of a terminal that was rebound): an agent that is already working
 * opens a task, crediting min(now - tab.working_since, 10 min) for Seals only (D§2.8). An idle
 * terminal that is the very one the hero last carried (fast rebind) means its earlier "done" was
 * seen while we were away: pending chests open (the seq-gap rule of D§2.3).
 */
function firstSight(world, hero, live, a, snap, ev) {
  const tick = world.rt.tick;
  const s = live.status;
  live.state = heroState(live, tick);
  if (s === "working") {
    const task = openTask(live, tick);
    const ws = workingSince(snap, a);
    if (ws != null) {
      const sec = Math.max(0, Math.min(600, Math.floor((snap.nowMs - ws) / 1000)));
      task.creditSec = sec;
      task.creditSeal = (sec / 60) * shiftSealMult(hero.shift ? hero.shift.min : 0);
    }
  } else if (s === "blocked") {
    live.blockedSince = tick;
    live.blockedAtMs = world.rt.nowMs;
  } else if (s === "idle" && live.fast && hero.pend && hero.pend.length && !world.rt.readOnly) {
    openChests(world, hero, { reason: "seen" }, ev);
  }
}

function workingSince(snap, a) {
  const tabs = snap.tabs || {};
  const t = a.tab != null ? tabs[a.tab] : null;
  let ws = t && t.working_since;
  if (!(typeof ws === "number" && Number.isFinite(ws) && ws > 0)) return null;
  if (ws < 1e11) ws *= 1000; // seconds -> ms (herdr reports ms; be tolerant)
  return ws <= snap.nowMs ? ws : null;
}

/**
 * Takes a hero off duty (terminal gone, D§2.2): an open task of >= 1.5 minutes closes into a
 * pending chest (closing a terminal is not acknowledgment); HP fraction is kept. Contractors
 * vanish; their pending chests open Unreviewed for the herd at once (nobody can claim them later).
 */
function goOffDuty(world, address, heroId, ev) {
  const { rt } = world;
  const hero = heroById(world, heroId);
  const live = rt.live.get(heroId);
  rt.bind.delete(address);
  rt.live.delete(heroId);
  rt.roomsDirty = true;
  if (!hero) return;
  // an agent that went working -> idle was watched finishing (herdr reports idle after a working
  // spell only while the person looks, D§2.3): its task closes "watched" even when the pane closes
  // inside the 8-tick debounce; anything else (done, blocked, still working) stays a pending chest
  if (live && live.task && !rt.readOnly) {
    closeTask(world, hero, live, live.status === "idle" && !flapPaused(live, rt.tick) ? "watched" : "ended", ev);
  }
  if (live && live.maxHp > 0 && live.hp != null) hero.hpFrac = Math.max(0.05, Math.min(1, live.hp / live.maxHp));
  hero.seenAt = rt.nowMs;
  if (hero.contractor) {
    if (!rt.readOnly) openChests(world, hero, { reason: "unreviewed", all: true, noXp: true }, ev);
    rt.contractors.delete(address);
  }
}

/** Unbinds a hero's terminal (retire, rebind); the agent rebinds on the next reconcile. */
export function unbindHero(world, heroId, ev) {
  const rt = world.rt;
  ensureRt(rt);
  const live = rt.live.get(heroId);
  if (!live) return false;
  goOffDuty(world, live.address, heroId, ev);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Transitions (D§2.3)
// ---------------------------------------------------------------------------------------------

function recordFlap(live, tick) {
  const F = T.flap;
  live.flap.push(tick);
  while (live.flap.length && live.flap[0] <= tick - F.windowSec) live.flap.shift();
  if (live.flap.length > F.changes) live.flapUntil = tick + F.suppressSec;
}

/** Is the flap guard holding chest drops and celebrations for this live hero? */
export function flapPaused(live, tick) {
  return !!live && live.flapUntil > tick;
}

/**
 * Seconds the live hero has been Waiting (D§2.6 "≥ 10 s blocked", the D§11.10 "! 2m" clock): the
 * larger of the herd ticks since it blocked and the wall-clock time since (an offline gap or a
 * dropped catch-up advances no ticks, but the person was still not answering). 0 when its blocked
 * spell is over (transition clears blockedSince when it leaves blocked).
 */
export function blockedSec(world, live) {
  if (!live) return 0;
  const tick = world.rt.tick;
  const byTick = live.blockedSince != null ? tick - live.blockedSince : live.blockedTicks || 0;
  const byClock = live.blockedAtMs != null && world.rt.nowMs >= live.blockedAtMs
    ? Math.floor((world.rt.nowMs - live.blockedAtMs) / 1000) : 0;
  return Math.max(0, byTick, byClock);
}

/**
 * Keeps the tick-based blocked clock on wall-clock time (world.tick, after its steps): an offline
 * gap or a catch-up that dropped seconds moves blockedSince back (and blockedTicks up), so
 * `tick - blockedSince` (the views' "! 15m" tag and bubble) counts real seconds.
 */
export function syncClocks(world) {
  const rt = world.rt;
  if (!rt || !rt.live || !rt.live.size) return;
  for (const live of rt.live.values()) {
    if (live.status !== "blocked" || live.blockedSince == null || live.blockedAtMs == null) continue;
    const real = blockedSec(world, live);
    if (rt.tick - live.blockedSince < real) live.blockedSince = rt.tick - real;
    if ((live.blockedTicks || 0) < real) {
      live.blockedTicks = real;
      live.bubbleShown = real >= T.bubbleDelayTicks;
    }
  }
}

/**
 * herdr's done <-> idle flip that keeps the agent's seq: herdr bumps seq only when the core's status
 * word changes (model.rs set_word), while "done" vs "idle" is the seen flag (mark_seen when the person
 * looks, set_turn when another client marks it seen or unread). So a finished agent the person then
 * looks at reports idle with the same seq.
 */
export function isSeenFlip(from, to) {
  return (from === "done" && to === "idle") || (from === "idle" && to === "done");
}

/**
 * Applies one seq-gated status change from -> to (D§2.3). Gaps in seq need nothing special: only
 * the previous and current statuses are known, and working -> idle already means "watched".
 */
export function transition(world, hero, live, to, ev) {
  const tick = world.rt.tick;
  const from = live.status;
  to = normStatus(to);
  if (from === to) return;
  recordFlap(live, tick);
  live.prevStatus = from;
  live.status = to;
  live.statusSince = tick;
  let task = live.task;

  if (to === "working") {
    if (from === "blocked") {
      const blocked = blockedSec(world, live);
      if (task && blocked >= T.unblocked.minBlockedSec && task.workSec >= T.unblocked.minTaskSec && !world.rt.readOnly) grantUnblocked(world, hero, live, ev);
    }
    if (task) task.closeCountdown = null; // continue the same task (resume, or back inside the 8 ticks)
    else task = openTask(live, tick);
    live.blockedSince = null;
    live.blockedAtMs = null;
    live.blockedTicks = 0;
    live.bubbleShown = false;
  } else if (to === "blocked") {
    if (task) {
      if (from === "working") task.blocks++;
      task.closeCountdown = null; // blocked never closes a task
    }
    live.blockedSince = tick;
    live.blockedAtMs = world.rt.nowMs;
    live.blockedTicks = 0;
    live.bubbleShown = false;
  } else {
    // done or idle: the task closes once this has held for 8 ticks
    if (task && task.closeCountdown == null) task.closeCountdown = CLOSE_TICKS;
    live.blockedSince = null;
    live.blockedAtMs = null;
    live.blockedTicks = 0;
    live.bubbleShown = false;
    if (from === "done" && to === "idle" && !world.rt.readOnly) openChests(world, hero, { reason: "seen" }, ev);
  }
  live.state = heroState(live, tick);
}

/**
 * Unblocked (D§2.6): +15% damage and kill XP for 120 Questing ticks (x2 with a Rubberducker in
 * the room, +60 with a Rubber-Stamped sticker: combat.unblockedTicks), cooldown 300 Questing ticks.
 * The effect is a combat buff on the hero's combat clock (live.ct); hero.cd mirrors it in herd
 * ticks (pushed forward while not Questing) so it survives a restart and the tooltip can show it.
 */
function grantUnblocked(world, hero, live, ev) {
  const tick = world.rt.tick;
  const U = T.unblocked;
  if (!hero.cd) hero.cd = { unblockedUntil: 0, unblockedCdUntil: 0, boss: {} };
  if (hero.cd.unblockedCdUntil > tick) return false;
  const ticks = unblockedTicks(world, hero, live);
  addBuff(live, "unblocked", ticks, { dmg: U.dmg, xp: U.xp });
  hero.cd.unblockedUntil = tick + ticks;
  hero.cd.unblockedCdUntil = tick + U.cooldownTicks;
  if (ev) ev.fx?.("unblocked", { heroId: hero.id, text: "Unblocked" });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Forklings (D§2.7)
// ---------------------------------------------------------------------------------------------

function subStatus(s) {
  if (s === "error") return "blocked";
  if (s === "done") return "idle";
  return normStatus(s);
}

/**
 * Attaches sub-agents to their root hero (walking the parent chain up to 5 steps). An orphan whose
 * root is unknown attaches to the most recently seen live hero of the same program; with none it
 * is returned as a top-level pseudo-agent. Newly attached Forklings mark the parent's task as
 * "spawned a sub-agent" (or the next task, if none is open).
 */
function attachForklings(world, subs, ev) {
  const { rt } = world;
  if (!subs.length) {
    for (const live of rt.live.values()) if (live.forklings.length) live.forklings = [];
    return [];
  }
  const parentOf = new Map();
  for (const s of subs) if (s.parent != null) parentOf.set(s.address, String(s.parent));
  const next = new Map(); // heroId -> [forkling]
  const orphans = [];
  for (const s of subs) {
    let addr = s.parent != null ? String(s.parent) : null;
    let heroId = null;
    for (let step = 0; step < 5 && addr != null; step++) {
      if (rt.bind.has(addr)) { heroId = rt.bind.get(addr); break; }
      addr = parentOf.has(addr) ? parentOf.get(addr) : null;
    }
    if (heroId == null) heroId = orphanHome(world, s);
    if (heroId == null) { orphans.push(s); continue; }
    if (!next.has(heroId)) next.set(heroId, []);
    next.get(heroId).push({ address: s.address, status: subStatus(s.status), title: s.title == null ? "" : String(s.title), program: s.program || null });
  }
  for (const [heroId, live] of rt.live) {
    const list = next.get(heroId) || [];
    const prev = live.forklings || [];
    const prevAddr = new Set(prev.map((f) => f.address));
    const byAddr = new Map(list.map((f) => [f.address, f]));
    // keep the attach order: known ones first (so "counted" stays stable), new ones appended
    const merged = [];
    for (const f of prev) if (byAddr.has(f.address)) merged.push(Object.assign(f, byAddr.get(f.address)));
    let attached = false;
    for (const f of list) if (!prevAddr.has(f.address)) { merged.push(Object.assign({ since: rt.tick }, f)); attached = true; }
    live.forklings = merged;
    if (attached) {
      if (live.task) live.task.spawned = true;
      else live.spawnPending = true;
    }
  }
  return orphans;
}

function orphanHome(world, s) {
  const prog = (s.program && s.program.key) || null;
  if (!prog) return null;
  let best = null;
  let bestKey = null;
  for (const [h, l] of liveHeroes(world)) {
    if (seatProgram(h.seat) !== prog || world.rt.orphans.has(l.address)) continue; // never a pseudo-agent
    const key = [h.seenAt || 0, l.boundTick || 0, -Math.abs(h.id)];
    if (!best || cmpKey(key, bestKey) > 0) { best = h; bestKey = key; }
  }
  return best ? best.id : null;
}

// An orphan with no home plays as a top-level agent (D§2.7). Sub-agents carry no seq, so a
// synthetic one counts their status changes.
function orphanAsAgent(world, s) {
  const rt = world.rt;
  const status = subStatus(s.status);
  let o = rt.orphans.get(s.address);
  if (!o) { o = { status, seq: 1 }; rt.orphans.set(s.address, o); }
  else if (o.status !== status) { o.status = status; o.seq++; }
  return {
    address: s.address, status, seq: o.seq, app: null, program: s.program || null, title: s.title || "",
    space: "", space_name: "", tab: "", tab_index: 0, tab_name: "", pane: "", pane_name: null, pinned: false, focused: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Reconcile (once per snapshot)
// ---------------------------------------------------------------------------------------------

/**
 * Reconciles world.rt with a host snapshot (D§2.11 step "reconcile"): unbinds terminals that are
 * gone (off duty), binds new ones (D§3.2), applies seq-gated status changes (D§2.3), attaches
 * Forklings (D§2.7), refreshes focus/pinned/space/program/title (D§2.8) and opens pending chests
 * of a focused terminal while the window is active ("seen", D§2.4).
 */
export function reconcile(world, snap, ev) {
  const { state, rt } = world;
  ensureRt(rt);
  const now = snap.nowMs ?? rt.nowMs;
  const tops = [];
  const subs = [];
  const seenAddr = new Set();
  for (const a of snap.agents || []) {
    if (!a || a.address == null || seenAddr.has(a.address)) continue;
    seenAddr.add(a.address);
    if (a.parent != null) subs.push({ address: a.address, parent: a.parent, status: a.status, title: a.title, program: a.program });
    else if (hasProgram(a)) tops.push(a);
  }
  for (const s of snap.subagents || []) {
    if (!s || s.address == null || seenAddr.has(s.address)) continue;
    seenAddr.add(s.address);
    subs.push(s);
  }

  // 1. terminals that ended go off duty first, so a replacement in the same snapshot can take
  //    over their hero. An orphan already playing as a top-level agent stays one while it lives;
  //    a top-level agent that now reports a parent becomes a Forkling (its hero goes off duty).
  const topAddr = new Set(tops.map((a) => a.address));
  const subAddr = new Set(subs.map((s) => s.address));
  const gone = [];
  for (const [addr, id] of rt.bind) {
    if (topAddr.has(addr)) continue;
    if (rt.orphans.has(addr) && subAddr.has(addr)) continue;
    gone.push([addr, id]);
  }
  for (const [addr, id] of gone) {
    goOffDuty(world, addr, id, ev);
    rt.orphans.delete(addr);
  }
  for (const addr of Array.from(rt.orphans.keys())) if (!subAddr.has(addr)) rt.orphans.delete(addr);

  // 2. top-level agents: bind, refresh, seq-gated status
  processTops(world, tops, snap, ev);

  // 3. sub-agents -> Forklings; homeless orphans play as top-level pseudo-agents
  const keepTop = subs.filter((s) => rt.orphans.has(s.address) && rt.bind.has(s.address));
  const forkSubs = subs.filter((s) => !(rt.orphans.has(s.address) && rt.bind.has(s.address)));
  const homeless = attachForklings(world, forkSubs, ev);
  const pseudo = keepTop.concat(homeless.filter((s) => hasProgram({ program: s.program })));
  if (pseudo.length) processTops(world, pseudo.map((s) => orphanAsAgent(world, s)), snap, ev, tops.length);

  // 4. seen via focus (D§2.4 rule 2), seenAt, state
  const active = snap.windowActive !== false;
  for (const [hero, live] of liveHeroes(world)) {
    live.nowTick = rt.tick;
    if (live.forklings.length) live.forkCount = stats(hero, statsCtx(world, hero)).forklingCount || T.forkling.counted;
    live.state = heroState(live, rt.tick);
    if (!hero.contractor) hero.seenAt = now;
    if (active && live.focused && hero.pend && hero.pend.length && !rt.readOnly) openChests(world, hero, { reason: FOCUS_SEEN }, ev);
  }
  return state;
}

function processTops(world, tops, snap, ev, order0 = 0) {
  const { state, rt } = world;
  for (let k = 0; k < tops.length; k++) {
    const a = tops[k];
    let id = rt.bind.get(a.address);
    const first = id == null;
    if (first) id = bindAgent(world, a, snap, ev);
    const hero = heroById(world, id);
    const live = rt.live.get(id);
    if (!hero || !live) continue;
    updateLiveFields(world, live, a, snap);
    live.order = order0 + k; // snapshot (space, tab, pane) order: stable stage slots
    if (!hero.contractor) {
      if (a.pane_name != null) hero.lastPane = String(a.pane_name);
      if (a.tab_name != null) hero.lastTab = String(a.tab_name);
      // a space renamed while the agent runs: same space id and program -> re-key the seat (D§3.1)
      const seat = agentSeat(a);
      if (hero.seat !== seat && a.space && hero.sid === a.space && seatProgram(hero.seat) === seatProgram(seat)) hero.seat = seat;
      if (a.space && hero.sid !== a.space) hero.sid = a.space;
    }
    if (first) {
      live.seq = a.seq;
      firstSight(world, hero, live, a, snap, ev);
    } else if (a.seq !== live.seq || isSeenFlip(live.status, normStatus(a.status))) {
      // seq-gated (D§2.3), except herdr's seen flip, which keeps the seq (isSeenFlip)
      live.seq = a.seq;
      transition(world, hero, live, a.status, ev);
    }
  }
  return state;
}

// ---------------------------------------------------------------------------------------------
// Per tick (D§2.2, D§2.3)
// ---------------------------------------------------------------------------------------------

function shiftToday(world, hero) {
  const day = world.state.herd.day || 0;
  if (!hero.shift || hero.shift.day !== day) hero.shift = { day, min: 0 };
  return hero.shift;
}

// Unblocked and its cooldown only run down while Questing: push them forward otherwise.
function freezeUnblocked(hero, tick) {
  const cd = hero.cd;
  if (!cd) return;
  if (cd.unblockedUntil > tick) cd.unblockedUntil++;
  if (cd.unblockedCdUntil > tick) cd.unblockedCdUntil++;
}

/**
 * One tick of a live hero's status (D§2.2, D§2.3): task minutes and Seal weighting while working,
 * blocked time and the bubble while waiting, the 8-tick close countdown (held by the flap guard),
 * Forkling Seal credit, Daily Shift minutes (Supervising counts half), the Unblocked mirror clock
 * and the "why" tooltip data. (Fresh Eyes drains in combat.stepRoom and accrues in
 * combat.restTick; offline accrual is accrueFreshEyes.)
 */
export function stepStatus(world, hero, live, ev) {
  const { rt } = world;
  const tick = rt.tick;
  live.nowTick = tick;
  const state = heroState(live, tick);
  live.state = state;
  const shift = shiftToday(world, hero);
  const status = live.status;
  let task = live.task;

  if (status === "working") {
    if (!task) task = openTask(live, tick);
    const factor = shiftSealMult(shift.min);
    task.workSec++;
    task.sealAcc += factor / 60;
    task.closeCountdown = null;
    shift.min += 1 / 60;
    if (!hero.st) hero.st = { kills: 0, tasks: 0, seals: 0, wh: 0, dodges: 0, healed: 0 };
    hero.st.wh = (hero.st.wh || 0) + 1 / 3600;
    // (Fresh Eyes drains in combat.stepRoom while the hero fights, D§2.9)
  } else {
    freezeUnblocked(hero, tick);
    if (state === "supervising") shift.min += 0.5 / 60;
    if (status === "blocked") {
      live.blockedTicks = (live.blockedTicks || 0) + 1;
      live.bubbleShown = live.blockedTicks >= T.bubbleDelayTicks;
      if (task) task.blockedSec++;
    }
  }

  // Forklings: 0.25 x their working minutes into the open task (or the side-quest bucket); they
  // wait while the parent waits
  if (status !== "blocked") {
    const n = workingForklings(live);
    if (n > 0) {
      const credit = (n * S.forklingMinuteCredit) / 60;
      const factor = shiftSealMult(shift.min);
      if (task) {
        task.forkMin += credit;
        task.forkSeal += credit * factor;
      } else {
        hero.fq = (hero.fq || 0) + credit * factor;
      }
    }
  }

  // the 8-tick close debounce (D§2.3), held while the flap guard pauses chest drops (D§2.5)
  task = live.task;
  if (task && task.closeCountdown != null && (status === "done" || status === "idle")) {
    if (task.closeCountdown > 0) task.closeCountdown--;
    if (task.closeCountdown <= 0 && !flapPaused(live, tick)) closeTask(world, hero, live, status === "idle" ? "watched" : "done", ev);
  }

  // the tooltip numbers move slowly: refresh every 5 ticks and on a state change
  if (!live.why || live.why.state !== live.state || tick % 5 === 0) live.why = whyOf(world, hero, live);
}

/**
 * Closes the live task (D§2.3): records the class signature, and with >= 1.5 working minutes (after
 * Forkling credit) drops a pending Commit Chest, merged into one created < 5 minutes ago. Closed
 * straight from working to idle ("watched"), the chest opens at once.
 * @param {"done"|"watched"|"ended"} reason
 * @returns {null|object} the pending chest entry
 */
export function closeTask(world, hero, live, reason, ev) {
  const task = live.task;
  live.task = null;
  if (!task) return null;
  const workMin = task.workSec / 60;
  const rec = recordTask(hero, { minutes: workMin, blocks: task.blocks, spawned: task.spawned });
  if (rec.switched) {
    // the free switch (D§4.2) can leave a weapon of the old class's type in hand: the targeted
    // autopilot sweep looks for a class weapon this very tick (as the manual setClass does)
    if (world.rt && world.rt.apGear) world.rt.apGear.add(hero.id);
    if (ev) {
      const c = CLASSES[hero.cls];
      ev.note?.(`${hero.name}: provisional ${c.name}`);
      emitJournal(world, ev, "class", hero.id, c.name, hero.cls);
    }
  }
  let min = workMin + task.creditSec / 60 + task.forkMin;
  let fmin = task.forkMin;
  let sealW = task.sealAcc + task.creditSeal + task.forkSeal;
  if (!(min >= S.minMinutes)) return null;
  if (hero.fq > 0) { // the side-quest bucket joins this chest
    min += hero.fq;
    fmin += hero.fq;
    sealW += hero.fq;
  }
  delete hero.fq;
  // the 120-minute cap is per task (D§2.4): the pending entry stores capped minutes, so merged
  // chests can add up past 12 Seals without losing any ("pending Seals are never capped")
  const factor = min > 0 ? sealW / min : 1;
  min = Math.min(min, S.capMinutes);
  fmin = Math.min(fmin, min);
  if (!hero.st) hero.st = { kills: 0, tasks: 0, seals: 0, wh: 0, dodges: 0, healed: 0 };
  hero.st.tasks = (hero.st.tasks || 0) + 1;
  const now = world.rt.nowMs;
  const p = addPending(hero, { min, fmin, title: task.title || null, at: now, sealFactor: factor });
  if (reason === "watched") {
    openChests(world, hero, { reason: "watched" }, ev);
  } else if (ev && !(reason === "ended")) {
    const raw = chestRaw(p);
    ev.fx?.("ship", { heroId: hero.id, text: "SHIPPED", value: Math.round(raw * 10) / 10, tier: chestTierOf(raw).id });
  }
  return p;
}

/**
 * rawSeals of a pending chest (D§2.4): its minutes are already capped per task (and at least 1.5),
 * so a merged chest is the plain sum: 1 Seal per 10 minutes, never capped as a whole.
 */
export function chestRaw(p) {
  return p && p.min >= S.minMinutes ? p.min * S.perMinute : 0;
}

/**
 * Adds a pending chest, merging into the newest one if it was created less than 5 minutes ago
 * (minutes add, the tier follows), or when 20 are already waiting (D§2.4, D§13.2).
 */
export function addPending(hero, c) {
  if (!hero.pend) hero.pend = [];
  const last = hero.pend[hero.pend.length - 1];
  if (last && (c.at - (last.at || 0) < S.mergeWindowSec * 1000 || hero.pend.length >= 20)) {
    const total = last.min + c.min;
    last.sealFactor = total > 0 ? ((last.sealFactor ?? 1) * last.min + c.sealFactor * c.min) / total : 1;
    last.min = total;
    last.fmin = (last.fmin || 0) + (c.fmin || 0);
    if (c.title) last.title = c.title;
    return last;
  }
  const p = { min: c.min, fmin: c.fmin || 0, title: c.title ?? null, at: c.at, sealFactor: c.sealFactor ?? 1 };
  hero.pend.push(p);
  return p;
}

// ---------------------------------------------------------------------------------------------
// Commit Chests (D§2.4)
// ---------------------------------------------------------------------------------------------

/** Pending chest numbers for tooltips: {raw, seals, tier, items} (items: expected count). */
export function chestInfo(p) {
  const raw = chestRaw(p);
  const tier = chestTierOf(raw);
  return { raw, seals: raw * (p.sealFactor ?? 1), tier: tier.id, color: tier.color, items: raw, title: p.title || "" };
}

/**
 * Opens pending chests (D§2.4). reason: "seen" (done -> idle), "focus", "click", "watched" (closed
 * working -> idle) open everything at full value; "unreviewed" opens chests older than 24 h (all
 * with opts.all) at half gold and XP, floor(raw/2) items and no Seals.
 * Gold: seals x 20 x gold(mapMid); XP: seals x 45 x mobXP(mapMid) x (1 + ΣXP%), no Fresh Eyes;
 * items: rawSeals (never reduced by the Daily Shift), offered to the roster (autopilot equip) then
 * the stash; Seals feed the Release Train and the Sprint meter.
 * @returns {{opened:number, seals:number, gold:number, xp:number, items:Array}}
 */
export function openChests(world, hero, opts = {}, ev) {
  const { state, rt } = world;
  const out = { opened: 0, seals: 0, gold: 0, xp: 0, items: [] };
  if (!hero || !hero.pend || !hero.pend.length) return out;
  const reason = opts.reason || "click";
  const unreviewed = reason === "unreviewed";
  const now = rt ? rt.nowMs : state.herd.lastMs;
  let open = hero.pend;
  if (unreviewed && !opts.all) open = hero.pend.filter((p) => now - (p.at || 0) >= S.unreviewedAfterSec * 1000);
  if (!open.length) return out;
  hero.pend = unreviewed && !opts.all ? hero.pend.filter((p) => !open.includes(p)) : [];

  const live = rt && rt.live ? rt.live.get(hero.id) : null;
  const lv = mapLevels(world, hero, live);
  const st = stats(hero, statsCtx(world, hero));
  const xpPct = (st.xpPct || 0) + herdXpBonus(state) + onboardingBonus(state, hero);
  const roster = state.heroes.includes(hero);
  for (const p of open) {
    const raw = chestRaw(p);
    const sf = p.sealFactor ?? 1;
    const seals = unreviewed ? 0 : raw * sf;
    const g = unreviewed ? 0.5 * chestGold(raw * sf, lv.mid) : chestGold(seals, lv.mid);
    const xp = unreviewed ? 0.5 * chestXP(raw * sf, lv.mid, xpPct) : chestXP(seals, lv.mid, xpPct);
    const items = rollChest(hero, { raw, mapTop: lv.top, classId: hero.cls, itemFind: st.itemFind, state, unreviewed });
    addGold(state, g);
    out.gold += g;
    if (seals > 0) {
      addSeals(world, seals, ev);
      hero.st.seals = (hero.st.seals || 0) + seals;
      out.seals += seals;
    }
    if (xp > 0 && (roster || hero.contractor) && !opts.noXp) {
      const r = grantXP(state, hero, xp, ev);
      if (r.levels > 0 && live) live.hp = live.maxHp;
      if (live && live.tally) live.tally.chestXp = (live.tally.chestXp || 0) + xp;
      out.xp += xp;
    }
    for (const it of items) {
      queueDrop(state, roster ? hero : null, it);
      logDrop(world, hero, it, ev);
      out.items.push(it);
      if (ev) ev.fx?.("loot", { heroId: hero.id, rar: it.rar, value: it.uid });
    }
    out.opened++;
    if (!unreviewed) {
      const title = p.title || "Commit";
      emitJournal(world, ev, "ship", hero.id, title, Math.round(seals * 10) / 10);
    }
  }
  if (ev) {
    if (out.gold > 0) ev.fx?.("coin", { heroId: hero.id, value: Math.round(out.gold) });
    ev.major?.();
  }
  if (!unreviewed && out.opened) awardBadge(world, "first_commit", ev);
  return out;
}

/**
 * Chest items wait in herd.inbox ([finderId, item] pairs, saved) and are offered to the roster one
 * per world.tick (drainInbox): offering one item scores up to 6 heroes (autopilot.offerDrop, ~0.1-3
 * ms in V8 with 30 heroes, 20-50x that in QuickJS), so a big merged chest offered at once could
 * blow herdr's 500 ms callback budget. The items are rolled (and logged) when the chest opens.
 */
export function queueDrop(state, finder, item) {
  const herd = state.herd;
  if (!Array.isArray(herd.inbox)) herd.inbox = [];
  herd.inbox.push([finder ? finder.id : 0, item]);
}

/** Offers up to `max` queued chest items (oldest first): finder first, then the roster (D§8.7). */
export function drainInbox(world, ev, max = INBOX_PER_TICK) {
  const herd = world.state.herd;
  const q = herd.inbox;
  if (!Array.isArray(q) || !q.length) return 0;
  let n = 0;
  while (q.length && n < max) {
    const entry = q.shift();
    n++;
    if (!Array.isArray(entry)) continue;
    const [id, item] = entry;
    if (!item || typeof item !== "object") continue;
    // ids a save may carry from another content generation (a mod downgrade): the stash codec's
    // fallbacks, so the item is safe to name, score and stash
    repairItem(item);
    const finder = id > 0 ? world.state.heroes.find((h) => h.id === id) || null : null;
    offerDrop(world, finder, item, ev);
  }
  if (!q.length) delete herd.inbox;
  return n;
}

/** Off-duty pending chests older than 24 h open Unreviewed (D§2.4). */
export function expireChests(world, hero, ev) {
  if (!hero.pend || !hero.pend.length || world.rt.live.has(hero.id)) return null;
  const now = world.rt.nowMs;
  if (!hero.pend.some((p) => now - (p.at || 0) >= S.unreviewedAfterSec * 1000)) return null;
  return openChests(world, hero, { reason: "unreviewed" }, ev);
}

/** "Seen" by a click on the hero, its chest or its sidebar row (D§2.4 rule 3). */
export function markSeen(world, heroId, ev) {
  const hero = heroById(world, heroId);
  if (!hero) return null;
  return openChests(world, hero, { reason: "click" }, ev);
}

// ---------------------------------------------------------------------------------------------
// Fresh Eyes (D§2.9 rule 3)
// ---------------------------------------------------------------------------------------------

/**
 * Fresh Eyes accrual for `minutes` of not Questing (off duty or app closed; combat.restTick covers
 * live Shipped/Resting heroes): +0.25 min per min (+50% with the Weekend Pass), capped at
 * 60 + 15 x Campfire, only after the hero's first credited Seal.
 */
export function accrueFreshEyes(world, hero, minutes) {
  if (!(minutes > 0) || !(hero.st && hero.st.seals > 0)) return 0;
  const cap = freshEyesCapMin(world.state);
  const before = hero.fe || 0;
  if (before >= cap) return 0;
  const st = stats(hero, statsCtx(world, hero));
  const ks = st.keepsakes && st.keepsakes.weekend_pass;
  const mult = 1 + (ks ? ks.freshEyesAccrual || 0 : 0);
  hero.fe = Math.min(cap, before + minutes * T.freshEyes.accruePerMin * mult);
  return hero.fe - before;
}

// ---------------------------------------------------------------------------------------------
// Rebind (D§3.2: the sheet's "Rebind")
// ---------------------------------------------------------------------------------------------

/**
 * Moves a live agent onto a benched roster hero of any seat. The agent's live state (status,
 * open task, Forklings, map) moves with it; the previous hero goes off duty without a task.
 * @returns {{ok:boolean, error?:string, msg?:string}}
 */
export function rebind(world, heroId, address, ev) {
  const { state, rt } = world;
  ensureRt(rt);
  const target = state.heroes.find((h) => h.id === heroId);
  if (!target) return { ok: false, error: "No such hero" };
  if (rt.live.has(heroId)) return { ok: false, error: "That hero is already playing" };
  const fromId = rt.bind.get(address);
  if (fromId == null) return { ok: false, error: "No live agent at that address" };
  const live = rt.live.get(fromId);
  const from = heroById(world, fromId);
  rt.live.delete(fromId);
  if (from) {
    if (live.maxHp > 0 && live.hp != null) from.hpFrac = Math.max(0.05, Math.min(1, live.hp / live.maxHp));
    from.seenAt = rt.nowMs;
    if (from.contractor) {
      openChests(world, from, { reason: "unreviewed", all: true, noXp: true }, ev);
      rt.contractors.delete(address);
    } else if (from.addr === address) {
      from.addr = null;
    }
  }
  const seat = seatKey(live.spaceName, live.space, live.program && live.program.key, live.app);
  target.seat = seat;
  if (live.space) target.sid = live.space;
  target.addr = address;
  if (live.paneName != null) target.lastPane = live.paneName;
  if (live.tabName) target.lastTab = live.tabName;
  target.seenAt = rt.nowMs;
  live.heroId = target.id;
  live.contractor = false;
  const st = stats(target, statsCtx(world, target));
  live.maxHp = st.maxHp;
  live.hp = Math.max(1, Math.round(st.maxHp * (target.hpFrac > 0 ? target.hpFrac : 1)));
  live.forkCount = st.forklingCount || T.forkling.counted;
  live.lane = [];
  live.engagedUid = null;
  live.mapId = chooseMap(world, target, live);
  rt.live.set(target.id, live);
  rt.bind.set(address, target.id);
  rt.roomsDirty = true;
  return { ok: true, msg: `${target.name} now plays this agent` };
}

// ---------------------------------------------------------------------------------------------
// The "why" tooltip (D§2.9): numbers only; view.js formats them
// ---------------------------------------------------------------------------------------------

/**
 * Everything the XP-bar "why" tooltip shows, as numbers: estimated XP per minute and each factor
 * (working rate, Fresh Eyes, party, banner, herd, Unblocked, onboarding, gear, crowding) plus the
 * Daily Shift (minutes today, band, multipliers, the next band boundary) and whether the flap guard
 * is pausing chests.
 */
export function whyOf(world, hero, live) {
  const { state, rt } = world;
  const tick = rt.tick;
  const st = stats(hero, statsCtx(world, hero));
  const state0 = live ? live.state : "off";
  const questing = state0 === "questing" || state0 === "crashed";
  const supervising = state0 === "supervising";
  const working = questing ? 1 : supervising ? 0.5 : 0;
  let party = 0;
  let banner = 0;
  let questingNow = 0;
  if (live) {
    let others = 0;
    for (const [h, l] of liveHeroes(world)) {
      const q = l.state === "questing" || l.state === "crashed" || l.state === "supervising";
      if (q) questingNow++;
      if (l.space !== live.space || l.mapId !== live.mapId) continue;
      if (l.pinned && q) banner = T.party.banner;
      if (h !== hero && q) others++;
    }
    party = partyXp(others);
  }
  // the herd bonus is the same for every hero: once per tick
  if (rt._whyHerd == null || rt._whyHerd.tick !== tick) rt._whyHerd = { tick, v: herdXpBonus(state) };
  const herd = rt._whyHerd.v;
  const unblocked = unblockedActive(hero, tick) ? T.unblocked.xp : 0;
  const onboarding = onboardingBonus(state, hero);
  const gear = st.xpPct || 0;
  const fe = questing && hero.fe > 0 ? T.freshEyes.xpMult : 1;
  const shiftMin = hero.shift ? hero.shift.min : 0;
  const band = shiftBand(shiftMin);
  const crowd = crowdingMult(questingNow);
  const lv = mapLevels(world, hero, live);
  const xpPct = gear + party + banner + unblocked + onboarding + herd;
  const perKill = mobXP(lv.mid) * gapMult(hero.L - lv.mid) * (1 + xpPct) * fe * shiftKillMult(shiftMin) * crowd;
  const bands = T.shift.bandsMin;
  return {
    state: state0, xpPerMin: Math.round(T.refKillsPerMin * perKill * working), working, freshEyes: fe,
    feMin: hero.fe || 0, feCap: freshEyesCapMin(state), party, banner, herd, unblocked,
    unblockedLeft: unblockedLeft(hero, tick), onboarding, gear, crowding: crowd, xpPct,
    shiftMin, shiftBand: band, shiftKill: shiftKillMult(shiftMin), shiftSeal: shiftSealMult(shiftMin),
    nextBandMin: band < bands.length ? bands[band] : null,
    flapPaused: flapPaused(live, tick), pending: hero.pend ? hero.pend.length : 0, mapId: lv.id,
    career: careerOf(hero).title,
  };
}

/** Is a keepsake idx (KEEPSAKE_IDX) equipped by the hero? */
export function wears(hero, keepsakeId) {
  const k = KEEPSAKE_IDX[keepsakeId];
  return (hero.eq || []).some((it) => it && it.rar === 5 && it.prop === k);
}

/** Backlog descriptor re-export for convenience (map id "backlog"). */
export const BACKLOG_ID = BACKLOG.id;

/** Map entry for an id ("backlog" -> null). */
export function mapOf(id) {
  return MAP_BY_ID[id] || null;
}
