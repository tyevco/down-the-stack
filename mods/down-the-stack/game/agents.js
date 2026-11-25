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
  crowding as crowdingMult, partyXp, iRef, itemTier, polishMax, autoOn, cutText,
} from "./formulas.js";
import { newHero, stats, grantXP, recordTask, autoRanks, careerOf, lookOf } from "./heroes.js";
import { rollChest, baseIdFor, stashAdd, repairItem, newItem, hatToneOf, skipUidsToTone } from "./items.js";
import { seedOf } from "./rng.js";
import {
  addGold, addSeals, herdXpBonus, freshEyesCapMin, onboardingBonus, awardBadge, logDrop, journal as herdJournal,
  unseenLosses,
} from "./herd.js";
import { chooseMap, mapLevels, offerDrop, bossApi } from "./autopilot.js";
import { heroCtx, addBuff, unblockedTicks, renameHero as renameInCombat } from "./combat.js";

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

/**
 * norm() of D§3.1: lowercase, trimmed, at most 32 UTF-16 units (cutText: never half an emoji, which
 * herdr would reject wherever the seat is shown).
 */
export function normSeat(s) {
  return cutText(String(s == null ? "" : s).trim().toLowerCase(), NORM_MAX);
}

/**
 * Seat key (D§3.1): norm(space.name || space.id || "nospace") + "/" + (program.key || app ||
 * "agent"). A space on another machine (round 4) adds "@" + norm(machine) to the space part, so
 * same-named spaces on two machines keep their own seats and benched heroes; this computer's seats
 * are unchanged (machine null), so older saves keep their heroes.
 */
export function seatKey(spaceName, spaceId, programKey, app, machine) {
  const m = machine == null ? "" : normSeat(String(machine).replace(/\//g, "-"));
  // a remote space id carries its machine ("devbox/s…"): only its own part names the space
  let id = spaceId == null ? "" : String(spaceId);
  if (m && machine && id.startsWith(`${machine}/`)) id = id.slice(String(machine).length + 1);
  const sp = normSeat(spaceName) || normSeat(id) || "nospace";
  return `${sp}${m ? `@${m}` : ""}/${programKey || app || "agent"}`;
}

/**
 * The machine an agent lives on, or null for this computer. herdr qualifies a remote space's id,
 * and its terminals' addresses, as "<machine>/<id>" (src/mirror.rs qualify; herdr.d.ts: "Remote
 * space/tab/pane ids have a machine/ prefix"); local ids never hold a "/" (model.rs fresh_id). A
 * snapshot field `machine` (from spaces()[].machine) wins when the host passes one.
 */
export function machineOf(a) {
  if (!a) return null;
  if (typeof a.machine === "string" && a.machine) return a.machine;
  for (const v of [a.space, a.address]) {
    const s = v == null ? "" : String(v);
    const i = s.lastIndexOf("/");
    if (i > 0) return s.slice(0, i);
  }
  return null;
}

// the machine part of a saved space id (hero.sid), or null for this computer's
function sidMachine(sid) {
  const s = sid == null ? "" : String(sid);
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : null;
}

function seatProgram(seat) {
  const s = String(seat || "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function agentSeat(a) {
  return seatKey(a.space_name, a.space, a.program && a.program.key, a.app, machineOf(a));
}

/** Terminals with neither program nor app never become heroes (D§2.10). */
function hasProgram(a) {
  return !!((a.program && a.program.key) || a.app);
}

// What an agent puts before its title: a status glyph or spinner and the separator after it
// ("✳ Fix flaky auth test", "⠋ - Thinking", Codex's "[ ! ] "). herdr's agents list strips the same
// (defaults/mods/agents/main.js clean()); its regex, so titles read alike in both.
const TITLE_MARK = /^(?:\[ [!.] \] |[✋⏳]\uFE0F?(?=\s)|(?!(?:\p{Emoji}\uFE0F|[#*]\u20E3))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u;

// herdr's shells and interpreters (defaults/programs.json "shells" and "interpreters"): a terminal
// titled after one of them names the process, not the work ("zsh", "-bash", "node", "cmd.exe").
const PROCESS_NAMES = {
  zsh: 1, bash: 1, fish: 1, sh: 1, dash: 1, nu: 1, pwsh: 1, powershell: 1, cmd: 1, elvish: 1, xonsh: 1, tcsh: 1,
  csh: 1, ksh: 1, ion: 1, node: 1, bun: 1, bunx: 1, deno: 1, python: 1, python3: 1, npx: 1, pnpm: 1, yarn: 1,
  uv: 1, uvx: 1, ruby: 1, bundle: 1, env: 1, sudo: 1, nice: 1, time: 1, watch: 1, nodemon: 1,
};
const ownKey = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);

/**
 * A terminal title as a name for its work, or "" when it says nothing about it. herdr's agents
 * list test (defaults/mods/agents/main.js title(): "telling"): the status glyph stripped, not
 * empty, not the terminal's id, not the program's name or key, not a path, no "@" (a shell's
 * user@host prompt). Also not one of herdr's shell or interpreter names, nor the agent's app id,
 * nor marks alone (no letter or digit), nor a repeat of the agent's space, tab or pane name
 * (round 4: Claude Code titles its terminal after the folder, which herdr also names the space
 * after; compared trimmed, case-insensitive, without a leading status glyph).
 * A string that is exactly the pane's or the tab's own name (as the person typed it; not a tab's
 * bare position) passes: that is the person's name for the place, which chrome.taskLabel falls
 * back to, shown as typed. questName (the engine's task and chest titles) has no such exception.
 * who: {address, program: {key, name}, app, spaceName?, tabName?, paneName?} (a live hero, a
 * Forkling record or a hero's last place), or null.
 */
export function tellingTitle(raw, who) {
  return judgeCached(raw, who, false);
}

// the regexes cost ~20 µs a call in QuickJS and every view asks again each tick: remember the
// answer per (title, terminal, program, app, places, strictness); a pure function, so the cache
// never changes a result
function judgeCached(raw, who, strict) {
  const s = raw == null ? "" : String(raw);
  if (!s) return "";
  const w = who || {};
  const prog = w.program || {};
  const key = `${strict ? 1 : 0}${s}\u0000${w.address}\u0000${prog.name}\u0000${prog.key}\u0000${w.app}\u0000${w.spaceName}\u0000${w.tabName}\u0000${w.paneName}`;
  const hit = TELLING.get(key);
  if (hit !== undefined) return hit;
  if (TELLING.size >= TELLING_MAX) TELLING.clear();
  const out = judgeTitle(s, w, prog, strict);
  TELLING.set(key, out);
  return out;
}
const TELLING = new Map();
const TELLING_MAX = 512;
/** For tests: the size of tellingTitle's answer cache (bounded by TELLING_MAX). */
export const _internal = { tellingCacheSize: () => TELLING.size, TELLING_MAX };

// a place name as a title compares: no leading status glyph, trimmed, lower case
const placeKey = (v) => (v == null ? "" : String(v).replace(TITLE_MARK, "").trim().toLowerCase());

function judgeTitle(s, w, prog, strict) {
  const live = s.replace(TITLE_MARK, "").trim();
  if (!/[\p{L}\p{N}]/u.test(live)) return ""; // empty, or only marks ("⏳", "…")
  // TITLE_MARK would strip a path's leading ~ or /: test the title with only its status glyph gone
  if (/^[~/]|^[A-Za-z]:\\/.test(s.replace(/^[^\p{L}\p{N}~/]+/u, "")) || live.includes("@")) return "";
  const low = live.toLowerCase();
  for (const v of [w.address, prog.name, prog.key, w.app]) if (v != null && low === String(v).toLowerCase()) return "";
  if (ownKey(PROCESS_NAMES, low.replace(/\.exe$/, ""))) return "";
  // the person's own name for the pane or tab, asked about as itself (chrome.taskLabel's fallback)
  const t = s.trim();
  const own = !strict && ((w.paneName != null && t === String(w.paneName).trim()) ||
    (w.tabName != null && t === String(w.tabName).trim() && !/^\d+$/.test(t)));
  if (!own) for (const v of [w.spaceName, w.tabName, w.paneName]) if (v != null && low === placeKey(v) && low) return "";
  return live;
}

/**
 * The Quest name a title gives a task (D§2.3): the telling title (status glyph stripped), cut to
 * 40 UTF-16 units without splitting an emoji (cutText); "" when the title names the program,
 * shell, a path, the agent's space, tab or pane, or nothing at all.
 */
export function questName(raw, who) {
  const s = judgeCached(raw, who, true);
  return s.length > TITLE_MAX ? cutText(s, TITLE_MAX).trimEnd() : s;
}

/** Where an off-duty hero last played, as tellingTitle's `who` (no terminal; its seat's program). */
function lastPlace(hero) {
  const seat = String(hero.seat || "");
  const i = seat.lastIndexOf("/");
  let space = i >= 0 ? seat.slice(0, i) : "";
  // a seat on another machine ends its space part with "@machine" (seatKey): the name is before it
  const m = sidMachine(hero.sid);
  const tail = m ? `@${normSeat(m.replace(/\//g, "-"))}` : "";
  if (tail && space.endsWith(tail)) space = space.slice(0, -tail.length);
  return {
    address: hero.addr, program: { key: i >= 0 ? seat.slice(i + 1) : seat }, app: null,
    spaceName: space, tabName: hero.lastTab, paneName: hero.lastPane,
  };
}

function ensureRt(rt) {
  if (!rt.bind) rt.bind = new Map();
  if (!rt.live) rt.live = new Map();
  if (!rt.contractors) rt.contractors = new Map();
  if (!rt.orphans) rt.orphans = new Map();
  if (!rt.offPane) rt.offPane = new Map(); // heroId -> the pane its terminal ended in (this session)
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
    focused: false, pinned: false, program: null, app: null, title: "", space: "", spaceName: "", machine: null, tab: "",
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
  const title = a.title == null ? "" : String(a.title);
  const retitled = title !== live.title;
  live.title = title;
  live.space = a.space || "";
  live.spaceName = a.space_name || "";
  live.machine = machineOf(a); // null: this computer (seats, rebind)
  live.tab = a.tab || "";
  live.tabName = a.tab_name == null ? "" : String(a.tab_name);
  live.pane = a.pane || "";
  live.paneName = a.pane_name == null ? null : String(a.pane_name);
  if (live.task && retitled) {
    // the task keeps the last title that names its work: an agent that retitles itself after its
    // program or shell ("Codex", "zsh") or clears its title keeps the task's real one, which the
    // tooltips fall back to and its chest records (a task opened since took the title then: newTask)
    const t = questName(title, live);
    if (t) live.task.title = t;
  }
}

function newTask(live, tick) {
  return {
    openTick: tick, workSec: 0, blockedSec: 0, sealAcc: 0, creditSec: 0, creditSeal: 0, forkMin: 0, forkSeal: 0,
    spawned: !!live.spawnPending, blocks: 0, closeCountdown: null, title: questName(live.title, live),
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

const HAT_SLOT = SLOTS.indexOf("hat");

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
  h.since = nowMs; // its place in the hiring line (promoteContractors: longest-running first)
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
 * It leaves a paused boss fight too (boss.leaveSavedFight).
 */
function evictHero(world, hero, ev) {
  const state = world.state;
  openChests(world, hero, { reason: "unreviewed", all: true, noXp: true }, ev);
  const idx = state.heroes.indexOf(hero);
  if (idx >= 0) state.heroes.splice(idx, 1);
  const api = bossApi(world);
  if (typeof api.leaveSavedFight === "function") api.leaveSavedFight(world, hero.id, ev);
  for (let s = 0; s < hero.eq.length; s++) {
    const it = hero.eq[s];
    hero.eq[s] = null;
    if (it && !(it.base === 0 && it.rar === 0)) stashAdd(state, it);
  }
  emitJournal(world, ev, "leave", hero.id, hero.name, hero.L, hero.name);
}

// name: the hero's, when it may no longer be found by id (it has just left the roster)
function emitJournal(world, ev, kind, heroId, text, value, name) {
  if (ev && typeof ev.journal === "function") ev.journal(kind, heroId, text, value, name);
  else {
    const h = name == null && heroId ? heroById(world, heroId) : null;
    herdJournal(world.state, kind, heroId, text, value, world.rt && world.rt.nowMs, name ?? (h ? h.name : undefined));
  }
}

/** The off-duty grace (T.roster.offDutyGraceMin) in ms. */
const graceMs = () => Math.max(0, (T.roster.offDutyGraceMin || 0) * 60000);

/**
 * When an unbound hero's off-duty grace started, in world time (round 4b): its seenAt (the moment
 * its terminal ended, D§2.2; a bound hero's is refreshed every reconcile). The time the app was
 * closed is not world time: a hero not seen since the loaded save (rt.loadedLastMs, world.loadWorld)
 * counts from its seenAt moved on by that gap, so a hero still on duty when the app closed (herdr's
 * core keeps its terminal, which may be listed a few snapshots after the start) has its whole grace
 * after this world's first reconcile (rt.startMs).
 */
function offDutySince(world, h) {
  const rt = world.rt;
  const seen = h.seenAt || 0;
  const last = rt.loadedLastMs;
  // a hero seen in this world has seenAt >= startMs (reconcile step 4, goOffDuty)
  if (Number.isFinite(last) && rt.startMs > last && seen < rt.startMs) return seen + (rt.startMs - last);
  return seen;
}

/**
 * True while an unbound hero is within its off-duty grace (round 4b): it went off duty less than
 * T.roster.offDutyGraceMin ago (world time, offDutySince), so it is never let go to make room. A
 * restarted agent (its pane closes, a new terminal opens there) takes it back meanwhile.
 */
export function inOffDutyGrace(world, h) {
  const ms = graceMs();
  return ms > 0 && !!h && (world.rt.nowMs || 0) - offDutySince(world, h) < ms;
}

/** When an unbound hero's off-duty grace ends (ms), or 0 when it has none left. */
export function offDutyGraceEnds(world, h) {
  return inOffDutyGrace(world, h) ? offDutySince(world, h) + graceMs() : 0;
}

/**
 * The hero a full roster lets go for a new hire (D§3.4): the least-recently-seen unbound hero below
 * Lv 10 whose off-duty grace has run out (inOffDutyGrace), or null. spare: hero ids never let go
 * this time (heroes the terminals of this very snapshot are taking back: reconcile step 1a).
 */
function rosterVictim(world, spare) {
  let victim = null;
  for (const h of world.state.heroes) {
    if (isBound(world, h.id) || h.L >= 10 || (spare && spare.has(h.id)) || inOffDutyGrace(world, h)) continue;
    if (!victim || (h.seenAt || 0) < (victim.seenAt || 0) || ((h.seenAt || 0) === (victim.seenAt || 0) && h.id < victim.id)) victim = h;
  }
  return victim;
}

/**
 * Room for one more roster hero under D§3.4's rules for a new hire: a free slot, else the
 * least-recently-seen unbound hero below Lv 10 past its off-duty grace leaves (evictHero). False
 * when every hero left is Lv 10+, playing, in its grace or spared. (The day's hire count is the
 * caller's: hiredToday.)
 */
function makeRoom(world, ev, spare) {
  const state = world.state;
  if (state.heroes.length < T.roster.max) return true;
  const victim = rosterVictim(world, spare);
  if (victim) evictHero(world, victim, ev);
  return state.heroes.length < T.roster.max;
}

// ---------------------------------------------------------------------------------------------
// Contractor promotion (owner decision, round 4: "promote only")
// ---------------------------------------------------------------------------------------------

/** Live Contractors in hiring order: longest-running first (since, then the order they arrived). */
function contractorLine(world) {
  const rt = world.rt;
  if (!rt.contractors || !rt.contractors.size) return [];
  const out = [];
  for (const [addr, c] of rt.contractors) if (rt.live.has(c.id)) out.push([addr, c]);
  out.sort((x, y) => ((x[1].since || 0) - (y[1].since || 0)) || (y[1].id - x[1].id));
  return out;
}

/**
 * Promotes live Contractors to saved heroes while the day has hires left and the roster has room
 * under the rules for a new hire (D§3.2 step 3, D§3.4): longest-running first. Runs at every
 * reconcile before new terminals bind (so a Contractor never loses its turn to a newcomer), which
 * covers both moments hiring reopens: the 04:00 game day turn (hiredToday() starts at 0 again) and
 * a roster slot freeing (a retire: world.js also calls it at once; a hero let go, or a hero below
 * Lv 10 going off duty while the roster is full, once its off-duty grace has run out). A read-only
 * world never hires. spare (optional Set of hero ids): heroes never let go this time; reconcile
 * passes the heroes its new terminals are taking back (step 1a).
 * @returns {number} Contractors promoted
 */
export function promoteContractors(world, ev, spare) {
  const { state, rt } = world;
  ensureRt(rt);
  if (!rt.contractors.size || rt.readOnly) return 0;
  let n = 0;
  for (const [addr, c] of contractorLine(world)) {
    if (hiredToday(state) >= T.roster.newPerDay) break;
    if (!makeRoom(world, ev, spare)) break;
    promote(world, addr, c, ev);
    n++;
  }
  return n;
}

const remapIds = (list, from, to) => {
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length; i++) if (list[i] === from) list[i] = to;
};

/**
 * A Contractor becomes a saved roster hero: it keeps its name, level, XP, class, skills, stats,
 * pending chests, seat and terminal; its reference kit becomes real saved Alpha items (new uids);
 * it takes a roster id (the negative Contractor id is rewritten wherever this session holds it:
 * the binding, its live state, fights, the journal) and one of the day's hires. Journal: "hired"
 * "Hired: <name> (was a contractor)" (value: its level).
 */
function promote(world, address, c, ev) {
  const { state, rt } = world;
  const herd = state.herd;
  const oldId = c.id;
  const live = rt.live.get(oldId);
  if (!(herd.nextHeroId >= 1)) herd.nextHeroId = 1;
  // its look stays its own for life (round 4b): the hoodie tint it had as a Contractor (from its
  // Contractor id) is kept as hero.look, and its hat (whose tint follows the uid) gets a saved uid
  // of the same tint
  const look = lookOf(c);
  const id = herd.nextHeroId++;
  c.id = id;
  c.look = look;
  delete c.contractor;
  delete c.since;
  c.ord = lowestFreeOrd(state, c.seat);
  c.eq = c.eq.map((it, s) => {
    if (!it) return null;
    if (s === HAT_SLOT) skipUidsToTone(state, hatToneOf(it.uid));
    return newItem(state, it);
  });
  c.addr = address;
  if (live) {
    if (live.space) c.sid = live.space;
    if (live.paneName != null) c.lastPane = String(live.paneName);
    if (live.tabName) c.lastTab = live.tabName;
  }
  c.seenAt = rt.nowMs;
  state.heroes.push(c);
  noteHire(state);
  rt.contractors.delete(address);
  rt.bind.set(address, id);
  if (live) {
    rt.live.delete(oldId);
    live.heroId = id;
    live.contractor = false;
    live.why = null;
    rt.live.set(id, live);
  }
  // everything this session keys by the Contractor id follows it (round 4b): rooms, effects and
  // per-tick sets (combat), fights, the paused fight and review Wounds / Lessons Learned (boss),
  // its journal lines, chest drops waiting in the inbox; the per-Contractor XP and autopilot
  // signatures start afresh
  if (rt.cxp) rt.cxp.delete(oldId);
  if (rt.apSig) rt.apSig.delete(oldId);
  renameInCombat(world, oldId, id);
  const api = bossApi(world);
  if (typeof api.renameHero === "function") api.renameHero(world, oldId, id);
  else {
    for (const f of rt.fights || []) { remapIds(f.heroIds, oldId, id); remapIds(f.helpers, oldId, id); }
    if (herd.fight) { remapIds(herd.fight.ids, oldId, id); remapIds(herd.fight.hl, oldId, id); }
  }
  for (const e of herd.log || []) if (Array.isArray(e) && e[2] === oldId) e[2] = id;
  for (const e of Array.isArray(herd.inbox) ? herd.inbox : []) if (Array.isArray(e) && e[0] === oldId) e[0] = id;
  // the digest counts levels from the last read: a promoted hero starts at the level it joined with
  if (herd.digestSnap && herd.digestSnap.lv && typeof herd.digestSnap.lv === "object") herd.digestSnap.lv[id] = c.L;
  rt.roomsDirty = true;
  rt.whyRooms = null;
  const text = `Hired: ${c.name} (was a contractor)`;
  emitJournal(world, ev, "hired", id, text, c.L);
  if (ev) {
    // tagged (round 4b): the stage merges the hires of one tick into one note (view/stage.js)
    ev.note?.(text, null, { kind: "hire", heroId: id, name: c.name, promoted: true });
    ev.major?.();
  }
  return c;
}

/**
 * When a Contractor will be hired (owner decision, round 4), for the views: its place in the
 * hiring line (0 = next), the day's hires (left of perDay), the roster's room for new hires (free
 * slots plus unbound heroes below Lv 10; `graced` of them are still within their off-duty grace,
 * round 4b, and make room only when it runs out) and the moment: "soon" (at the next reconcile),
 * "grace" (when a hero's off-duty grace runs out at atMs, unless its agent comes back for it),
 * "day" (the 04:00 game day turn at atMs; days = which turn, 1 = the next), "slot" (when a roster
 * slot frees), "never" (a read-only save). text: one sentence for a tooltip or the sheet.
 * @returns {null|{when:string, position:number, ahead:number, hiresLeft:number, perDay:number,
 *   room:number, graced:number, atMs:number|null, days:number, text:string}} null for a roster hero
 */
export function hireOutlook(world, heroOrId) {
  const { state, rt } = world;
  const hero = typeof heroOrId === "object" && heroOrId ? heroOrId : heroById(world, heroOrId);
  if (!hero || !hero.contractor || !rt) return null;
  const R = T.roster;
  // the line and the room are the same for every Contractor of a render (the party, the stage and
  // the sheet ask for each of up to ~30): computed once per tick and roster shape
  const key = `${rt.tick}|${rt.nowMs}|${rt.contractors ? rt.contractors.size : 0}|${rt.contractorSeq}|${state.heroes.length}|${rt.live ? rt.live.size : 0}|${hiredToday(state)}`;
  let c = rt._hireLine;
  if (!c || c.key !== key) {
    let r = Math.max(0, R.max - state.heroes.length);
    const ends = []; // when each graced hero's grace runs out, soonest first
    for (const h of state.heroes) {
      if (isBound(world, h.id) || h.L >= 10) continue;
      const end = offDutyGraceEnds(world, h);
      if (end) ends.push(end);
      else r++;
    }
    ends.sort((x, y) => x - y);
    c = rt._hireLine = { key, line: contractorLine(world).map((e) => e[1]), room: r, ends };
  }
  let position = c.line.indexOf(hero);
  if (position < 0) position = c.line.length;
  const hiresLeft = Math.max(0, R.newPerDay - hiredToday(state));
  const roomNow = c.room;
  const room = roomNow + c.ends.length;
  const left = `today: ${hiresLeft} of ${R.newPerDay} hires left`;
  const ahead = position ? ` · ${position} ahead in line` : "";
  const out = { when: "slot", position, ahead: position, hiresLeft, perDay: R.newPerDay, room, graced: c.ends.length, atMs: null, days: 0, text: "" };
  if (rt.readOnly) {
    out.when = "never";
    out.text = "Not hired: this save is read-only";
  } else if (position < Math.min(hiresLeft, roomNow)) {
    out.when = "soon";
    out.text = `Joins the roster in a moment (${left})`;
  } else if (position < Math.min(hiresLeft, room)) {
    out.when = "grace";
    out.atMs = c.ends[position - roomNow];
    const min = Math.max(1, Math.ceil((out.atMs - (rt.nowMs || 0)) / 60000));
    out.text = `Hired in about ${min} min, once a hero below Lv 10 has been off duty for ${R.offDutyGraceMin} min (unless its agent comes back)${ahead} (${left})`;
  } else if (position < room) {
    out.when = "day";
    out.days = Math.floor((position - hiresLeft) / R.newPerDay) + 1;
    const tz = Number.isFinite(rt.tzOffsetMin) ? rt.tzOffsetMin : 0;
    out.atMs = ((state.herd.day || 0) + out.days) * 86400000 + T.shift.resetHourLocal * 3600000 + tz * 60000;
    out.text = `${out.days > 1 ? `Hired in ${out.days} game days (04:00)` : "Hired at the next 04:00 game day"}${ahead} (${left})`;
  } else {
    out.text = `Hired when a roster slot frees (a retire, or a hero below Lv 10 off duty for ${R.offDutyGraceMin} min)${ahead} (${left})`;
  }
  return out;
}

/** Picks a free hero for a new terminal (D§3.2 step 2), or null. taken: hero ids already claimed. */
function pickFreeHero(world, a, seat, taken) {
  const { state, rt } = world;
  ensureRt(rt);
  const prog = seatProgram(seat);
  let best = null;
  let bestKey = null;
  const machine = machineOf(a);
  for (const h of state.heroes) {
    if (isBound(world, h.id) || (taken && taken.has(h.id))) continue;
    // a hero last seen on another machine never crosses over, even under an older save's seat
    // without the machine (it is re-keyed when its own machine's agent comes back: below)
    if (h.sid && sidMachine(h.sid) !== machine && a.space) continue;
    const sameSeat = h.seat === seat;
    // a renamed space keeps its id: re-key heroes whose space id and program match (D§3.1)
    const rekey = !sameSeat && h.sid && a.space && h.sid === a.space && seatProgram(h.seat) === prog;
    if (!sameSeat && !rekey) continue;
    const key = [
      // round 4b: the hero whose terminal ended in this very pane (an agent restarted there: its
      // own hero, before the seat's "main" hero), then D§3.2's order
      a.pane && rt.offPane.get(h.id) === a.pane ? 1 : 0,
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
 * A new terminal's own saved hero (D§3.2 step 1, fast rebind): the unbound hero whose saved address
 * is this terminal's, or null. taken: hero ids already claimed by other terminals of the snapshot.
 */
function ownHeroFor(world, a, seat, taken) {
  for (const h of world.state.heroes) {
    // the hero's own terminal: its seat, or its space (renamed meanwhile) with the same program. A
    // terminal outlives the agent in it, so another program started in it is a new terminal of its
    // own seat (D§3.1), as in pickFreeHero: it never takes over this hero, its seat or its chests
    if (h.addr === a.address && !isBound(world, h.id) && !(taken && taken.has(h.id)) &&
        (h.seat === seat || (h.sid && h.sid === a.space && seatProgram(h.seat) === seatProgram(seat)))) {
      return h;
    }
  }
  return null;
}

/**
 * The saved hero a new terminal takes (D§3.2 steps 1-2): its own hero by saved address (fast
 * rebind), else a free hero of its seat; {hero, fast} or null. taken: hero ids already claimed by
 * other terminals of the same snapshot.
 */
function savedHeroFor(world, a, seat, taken) {
  const own = ownHeroFor(world, a, seat, taken);
  if (own) return { hero: own, fast: true };
  const h = pickFreeHero(world, a, seat, taken);
  return h ? { hero: h, fast: false } : null;
}

/**
 * Binds a new terminal to a hero (D§3.2): fast rebind by saved address, then a free hero of the
 * seat, else a new hero (roster < 30 and < 6 created today; a full roster first frees the
 * least-recently-seen unbound hero below Lv 10 past its off-duty grace), else a Contractor.
 * claims (reconcile step 1a): address -> {hero, fast} the terminals of this snapshot take back;
 * spare: those heroes' ids, which no other terminal takes and no hire lets go.
 * @returns {number} the hero id
 */
function bindAgent(world, a, snap, ev, claims, spare) {
  const { state, rt } = world;
  const now = snap.nowMs;
  const seat = agentSeat(a);
  const claim = claims && claims.get(a.address);
  const own = claim && state.heroes.includes(claim.hero) && !isBound(world, claim.hero.id) ? claim : null;
  const found = own || savedHeroFor(world, a, seat, spare);
  let hero = found ? found.hero : null;
  const fast = !!(found && found.fast);
  // a read-only world (a save from a newer version, never written back) binds for display only:
  // no hires (a new agent plays as an unsaved Contractor), no chests, no XP (world.tick runs no steps)
  if (!hero && !rt.readOnly && hiredToday(state) < T.roster.newPerDay && makeRoom(world, ev, spare)) {
    hero = newHero(state, { seat, sid: a.space || null, ord: lowestFreeOrd(state, seat), nowMs: now });
    state.heroes.push(hero);
    noteHire(state);
    emitJournal(world, ev, "hire", hero.id, hero.name, 1);
    if (ev) ev.note?.(`New hire: ${hero.name}`, null, { kind: "hire", heroId: hero.id, name: hero.name });
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
  if (rt.offPane) rt.offPane.delete(hero.id);
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
  if (live && live.pane && !hero.contractor && rt.offPane) rt.offPane.set(heroId, live.pane);
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
    const prev = live.forklings || [];
    // no Forklings before or now (most heroes): nothing to merge, nothing to allocate
    if (!prev.length && !next.has(heroId)) { if (!live.forklings) live.forklings = prev; continue; }
    const list = next.get(heroId) || [];
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
  if (rt.startMs == null && Number.isFinite(now)) rt.startMs = now; // offDutySince: this world's first reconcile
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

  // 1a. a new terminal with a saved hero to take (its own, by address, or a free hero of its seat:
  //     a restarted agent's new terminal in the same pane) claims it now, before anything below may
  //     let a hero go to make room (round 4b). Every terminal's own hero is claimed first, so a
  //     terminal of the same seat listed before it (an app start lists them all at once: one that
  //     played a Contractor has no saved hero) never takes it; free heroes follow snapshot order,
  //     as binding does in 2.
  let claims = null;
  let spare = null;
  const claim = (a, found) => {
    if (!claims) { claims = new Map(); spare = new Set(); }
    claims.set(a.address, found);
    spare.add(found.hero.id);
  };
  for (const a of tops) {
    if (rt.bind.has(a.address)) continue;
    const own = ownHeroFor(world, a, agentSeat(a), spare);
    if (own) claim(a, { hero: own, fast: true });
  }
  for (const a of tops) {
    if (rt.bind.has(a.address) || (claims && claims.has(a.address))) continue;
    const h = pickFreeHero(world, a, agentSeat(a), spare);
    if (h) claim(a, { hero: h, fast: false });
  }

  // 1b. Contractors still playing join the roster while hiring is open (the 04:00 game day turn,
  //     a slot that freed), before any newcomer below can take the day's hires. A hero claimed in
  //     1a is never let go for it, nor one within its off-duty grace (inOffDutyGrace)
  if (rt.contractors.size) promoteContractors(world, ev, spare);

  // 2. top-level agents: bind, refresh, seq-gated status
  processTops(world, tops, snap, ev, 0, claims, spare);

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

function processTops(world, tops, snap, ev, order0 = 0, claims = null, spare = null) {
  const { state, rt } = world;
  for (let k = 0; k < tops.length; k++) {
    const a = tops[k];
    let id = rt.bind.get(a.address);
    const first = id == null;
    if (first) id = bindAgent(world, a, snap, ev, claims, spare);
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
  if (live.state !== state && rt.whyRooms) rt.whyRooms = null; // whyOf's room counts change
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

  // the tooltip numbers move slowly: refresh every 5 ticks and on a state change. Heroes take turns
  // (by id), so a big herd refreshes a fifth of its tooltips on each tick instead of all of them
  // on every 5th (30 heroes: ~1.3 ms of a QuickJS tick, the slowest fifth of the ticks)
  if (!live.why || live.why.state !== live.state || (tick + hero.id) % 5 === 0) live.why = whyOf(world, hero, live);
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
  // a provisional switch refunds every skill point; they are re-spent at once only while the
  // herd's auto-learn is on (with it off, they wait for the person, D§11.15 "Off stops every system")
  const rec = recordTask(hero, { minutes: workMin, blocks: task.blocks, spawned: task.spawned }, { learn: autoOn(world.state, "learn") });
  if (rec.switched) {
    // the free switch (D§4.2) can leave a weapon of the old class's type in hand: the targeted
    // autopilot sweep looks for a class weapon this very tick (as the manual setClass does)
    if (world.rt && world.rt.apGear) world.rt.apGear.add(hero.id);
    if (ev) {
      const c = CLASSES[hero.cls];
      ev.note?.(`${hero.name}: provisional ${c.name}`, null, { heroId: hero.id });
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
  const where = live || lastPlace(hero); // whose place names a chest title must not merely repeat
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
      // a chest from an older save may carry a program or shell name, or its space's name, as its title
      const title = judgeCached(p.title, where, true) || "Commit";
      emitJournal(world, ev, "ship", hero.id, title, Math.round(seals * 10) / 10);
    }
  }
  if (unreviewed && out.opened) {
    // one journal line for the batch, so the person learns where the chest went (the sheet's
    // journal and the Herd digest): its task when one chest opened, the count in the value
    const title = out.opened === 1 ? judgeCached(open[0].title, where, true) || "" : "";
    // the loss is told at once (a header note) and stays counted (saved, herd.unseenUnrev) until
    // the person views the Digest: the Herd dot reads it (herd.unseenLosses / digestDot; round 4)
    const unseen = unseenLosses(state);
    emitJournal(world, ev, "unrev", hero.id, title, out.opened);
    state.herd.unseenUnrev = unseen + out.opened;
    if (ev) ev.note?.(`${hero.name}: ${out.opened === 1 ? "a chest" : `${out.opened} chests`} opened Unreviewed (half value)`, null, { heroId: hero.id });
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
  const seat = seatKey(live.spaceName, live.space, live.program && live.program.key, live.app, machineOf(live));
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

const whyQuests = (l) => l.state === "questing" || l.state === "crashed" || l.state === "supervising";

/**
 * whyOf's party numbers for every room (space and map) at once: {questing, by: Map(space ->
 * Map(mapId -> {q, banner}))}, q = heroes questing (or crashed, or supervising) there, banner = one
 * of them pinned. One pass over the herd, kept in rt.whyRooms for the tick and shared by the
 * heroes refreshed on it (a scan of the herd per hero, O(heroes²), cost ~3 ms with 30 heroes in
 * QuickJS). stepStatus drops it when a hero's state changes, so every count is the one a fresh
 * scan would find; space, map and pin change only outside the status loop (reconcile, autopilot),
 * on another tick.
 */
function whyRooms(world) {
  const rt = world.rt;
  const c = rt.whyRooms;
  if (c && c.tick === rt.tick && c.n === rt.live.size) return c;
  const out = { tick: rt.tick, n: rt.live.size, questing: 0, by: new Map() };
  // every live hero as liveHeroes() lists them (roster heroes, then Contractors), without the list
  for (const h of world.state.heroes) whyCount(out, rt.live.get(h.id));
  for (const c of rt.contractors.values()) whyCount(out, rt.live.get(c.id));
  rt.whyRooms = out;
  return out;
}

function whyCount(out, l) {
  if (!l || !whyQuests(l)) return;
  out.questing++;
  let maps = out.by.get(l.space);
  if (!maps) out.by.set(l.space, (maps = new Map()));
  const r = maps.get(l.mapId);
  if (r) { r.q++; if (l.pinned) r.banner = true; }
  else maps.set(l.mapId, { q: 1, banner: !!l.pinned });
}

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
    const rooms = whyRooms(world);
    const maps = rooms.by.get(live.space);
    const room = maps && maps.get(live.mapId);
    questingNow = rooms.questing;
    // the others questing in the hero's room (itself counted there only when it is in rt.live)
    const self = whyQuests(live) && rt.live.get(hero.id) === live ? 1 : 0;
    if (room && room.banner) banner = T.party.banner;
    party = partyXp(room ? room.q - self : 0);
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
  // the level gap as combat.kill applies it: none below ×1 in the Backlog (D§9.8)
  let gp = gapMult(hero.L - lv.mid);
  if (lv.id === BACKLOG.id && gp < 1) gp = 1;
  const perKill = mobXP(lv.mid) * gp * (1 + xpPct) * fe * shiftKillMult(shiftMin) * crowd;
  const bands = T.shift.bandsMin;
  return {
    state: state0, xpPerMin: Math.round(T.refKillsPerMin * perKill * working), working, freshEyes: fe,
    feMin: hero.fe || 0, feCap: freshEyesCapMin(state), party, banner, herd, unblocked,
    unblockedLeft: unblockedLeft(hero, tick), onboarding, gear, crowding: crowd, xpPct,
    shiftMin, shiftBand: band, shiftKill: shiftKillMult(shiftMin), shiftSeal: shiftSealMult(shiftMin),
    nextBandMin: band < bands.length ? bands[band] : null,
    flapPaused: flapPaused(live, tick), pending: hero.pend ? hero.pend.length : 0, mapId: lv.id, gap: gp,
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
