// stageView(world, {width, height, nowMs}) -> StageVM (ARCHITECTURE §5; the "VM additions" at the
// top of ui/stage.js; the field-by-field spec in tools/vm-samples/stage.mjs).
//
// Pure layout of the engine's state onto the 200 px reference composition of D§11.2: header band
// 0-18, play space 18-160, ground line y = 160, nameplates at y = 164. Sprites give x = centre and
// y = feet; boxes give the left edge x and the width w. The renderer bottom-anchors the
// composition to the real block height. Every user-facing string is made here.
//
// Layout (D§11.3):
//   - One slot per live hero in herdr's own order (live.order, then rt.live insertion order).
//     Slot width w = clamp(W / N, 150, 320); spare width becomes Localhost scenery at both ends.
//     Only membership changes reflow the strip (a hero added or removed, a boss arena opening or
//     closing, the overflow fold set changing): status, focus and level never move a slot.
//   - Adjacent slots of the same space standing in the same map merge into one room.
//   - Overflow (N · 150 > W): C − 1 slots plus a 150 px camp chip at the right (96 px below a
//     600 px strip). Fold resting (and shipped-without-chest) heroes first, then supervising, then
//     working ones, lowest level first; never blocked heroes, heroes with a pending chest, focused,
//     pinned or boss participants while squeezed slots (≥ 90 px, heroes scaled down) can hold
//     them; past that, or past 30 slots on any strip (the stage's element budget), they fold too
//     (chest, pinned, focused, then blocked last). The fold set is
//     re-evaluated at once on add/remove and at most every 30 ticks otherwise, except that a folded
//     hero that becomes protected (e.g. newly blocked) is promoted at once.
//   - A boss fight adds an arena of width max(2w, what its fighters need: ≥ 56 px apart, adds,
//     boss and parts) after the slots; slots shrink to 120 px before the fighters close ranks.
//     Their home slots show a sign. When the strip is too narrow, the participants' home slots are
//     dropped before anyone is folded, and an arena still short of its need scales its contents.
//   - Inside a slot of width w: hero 0.24w (resting 0.22w with the campfire at 0.08w; a hero with
//     Forklings 0.16w, Forklings from 0.30w), pending chest clear of the face (≥ 0.42w and ≥ 34 px
//     right of the hero; behind a fighting hero), lane mobs 0.52/0.70/0.88w (0.58/0.84w if
//     w < 180).
//
// Memory (per world, in a WeakMap; nothing here changes the engine): the last VM per (rt.version,
// rt.tick, size, settings). Per strip width (up to 3 widths, so two stage copies of different
// widths keep their own): the overflow fold set (hysteresis); recently seen mob positions (a mob
// killed this tick is gone from its lane, but its poof, coin, fade-out and a Holo Rubber Duck's
// Duck Chest need the spot where it stood); the last chest spot per hero (a chest that just opened
// shows its lid for a tick). Per world: boss fights and reviews seen running (a won or lost fight
// leaves rt.fights at once, but its FIXED stamp, Postmortem card or Promotion banner stays on
// stage for 3 ticks) and boss win estimates.
//
// Pure: no herdr/gpui imports, no Date.now, no Math.random. QuickJS-safe (ES2020).

import {
  TUNING as T, ZONES, BACKLOG, MAP_BY_ID, MOB_BY_ID, BOSSES, CLASSES, PALETTE, ITEM_BASES, CLASS_COLORS,
  RARITIES, HOLO_DUCK, ELITE,
} from "../data.js";
import { fmtNum, fmtDuration, itemTier, need } from "../formulas.js";
import { careerOf } from "../heroes.js";
import { chestInfo } from "../agents.js";
import { freshEyesCapMin, doorOpen, sprintTarget, mapUnlocked } from "../herd.js";
import { heroMapId, findHero } from "../combat.js";
import { estimate as bossEstimate, canChallenge } from "../boss.js";
// One Termling look and one D§2.9 "why" line for every role: the chrome views own these helpers
// (the sidebar, nameplate and sheet draw the same hero with the same title bar and tooltip).
import { termlingColors as colorsFor, programIconOf as iconOf, whyLine, taskLabel, tellingTitle } from "./chrome.js";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const GROUND = 160;
const PLATE_Y = 164;
const SLOT_MIN = 150;
const SLOT_MAX = 320;
const SLOT_SQUEEZE = 90; //   narrowest slot when protected heroes outnumber the space (scale 0.6)
const MAX_SLOTS = 30; //     most home slots on any strip: past this even protected heroes wait in the
//                           camp chip (the renderer's ~400-element budget, D§11.9.7, holds 30 slots
//                           at its barest detail: ui/stage.js detail())
const CHIP_W = 150;
const SLOT_FOR_ARENA = 120; // slots shrink to this before the arena gives up fighter spacing
const FOLD_TICKS = 30; //     D§11.3.4: status-driven refolds at most every 30 s
const ENDED_TICKS = 3; //     a won/lost fight stays on stage for ticks 0..3 after it ends
const MEMO_TICKS = 3; //      remembered mob spots live this long
const ARENA_GAP = 56; //      fighters stand at least this far apart in the arena (stage review)
const ARENA_MIN_SCALE = 0.6; // an arena short of its need scales its contents down to this, no further

const COL = {
  working: PALETTE.working, blocked: PALETTE.blocked, done: PALETTE.done, idle: PALETTE.idle, hp: PALETTE.hp,
  xp: PALETTE.xp, heal: PALETTE.heal, cream: PALETTE.cream, fresh: PALETTE.freshEyes, coin: PALETTE.coin,
  num: "#FFFFFFD9", crit: "#FFF4D6", abs: "#9EE6FF",
};
const SIZE_PX = { S: 28, M: 40, L: 56 };
const CHEST_BODY_HALF = 20; // half a Termling's 40 px body at scale 1 (ui/termling.js)
const FACE = { questing: ">_", waiting: "o_o", shipped: "^_^", resting: "-_-", supervising: ">_", crashed: ":(" };
const WORD = { questing: "Questing", waiting: "Waiting for you", shipped: "Shipped", resting: "Resting", supervising: "Supervising", crashed: "Rebooting" };
const DOT = { questing: COL.working, crashed: COL.hp, supervising: COL.working, waiting: COL.blocked, shipped: COL.done, resting: COL.idle };
const ZONE_ABBR = ["LM", "CC", "RR", "MM", "DJ", "TK", "LC", "PP", "UD", "BL"];
const NUM_KINDS = { num: 1, crit: 1, heal: 1, miss: 1, inv: 1, abs: 1, incoming: 1 };
const CALM_DROPS = { levelup: 1, pillar: 1, skill: 1 };
const FIGHT_STATES = { questing: 1, crashed: 1, supervising: 1, waiting: 1 };
const WORKING_STATES = { questing: 1, crashed: 1, supervising: 1 };

const HAT_COLORS = ["#E86F9C", "#5FB0E8", "#8FBF5A", "#E8B84A", "#C47BE8", "#F07D5C"];

// Prop art sizes (viewBox) per zone: [prop-1, prop-2, prop-3] (art/bg/<zone>-prop-<k>.svg).
const PROP_SIZES = {
  lint_meadows: [[16, 40], [24, 16], [24, 32]],
  callback_caverns: [[24, 24], [16, 40], [16, 24]],
  regex_ruins: [[16, 48], [24, 24], [16, 20]],
  merge_marshes: [[32, 30], [20, 32], [28, 8]],
  dependency_jungle: [[24, 24], [20, 48], [28, 20]],
  threadlock_keep: [[16, 32], [28, 20], [12, 32]],
  legacy_catacombs: [[24, 28], [16, 36], [16, 16]],
  production_peaks: [[20, 40], [24, 16], [10, 36]],
  undefined_depths: [[24, 24], [16, 40], [16, 20]],
  backlog: [[16, 32], [12, 40], [24, 16]],
};

// Bosses whose fights bring adds (warning mites, callback bats, left-pad mites, pager wyverns).
const ADD_BOSSES = { ignored_warning: 1, pyramid_of_doom: 1, bloatodon: 1, friday_deploy: 1 };

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const frac = (a, b) => (b > 0 && Number.isFinite(a) ? clamp(a / b, 0, 1) : 0);
const isHex = (c) => typeof c === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c);
const hexOr = (c, d) => (isHex(c) ? c : d);
const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function mix(a, b, t) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const A = p(a);
  const B = p(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function zoneDef(zoneIdx) {
  return zoneIdx >= 0 && zoneIdx < ZONES.length ? ZONES[zoneIdx] : BACKLOG;
}

function zoneOfMap(mapId) {
  if (mapId === "backlog") return BACKLOG.n;
  const m = MAP_BY_ID[mapId];
  return m ? m.zone : 0;
}

/** "2-2 Nested Tunnels" / "The Backlog · Floor 14". */
function mapLabel(state, mapId) {
  if (mapId === "backlog") return `${BACKLOG.name} · Floor ${backlogFloor(state)}`;
  const m = MAP_BY_ID[mapId];
  return m ? `${mapId} ${m.name}` : String(mapId);
}

function backlogFloor(state) {
  const b = state.herd.backlog;
  return Math.max(1, (b && b.floor) || 1);
}

/**
 * Termling colours shared by every role that draws a hero (HeroVM.colors): hoodie by hero id, a
 * dark title bar per program (D§2.8), the face ink in the status colour. Delegates to the chrome
 * views' helper so the stage, sidebar, nameplate and sheet agree.
 */
export function termlingColors(hero, live, state) {
  const prog = live && live.program;
  return colorsFor(hero, prog && prog.key ? prog.key : live ? live.app : null, state);
}

/** herdr's program icon for the title bar, or null (the chrome views' helper). */
export function programIconOf(program) {
  return iconOf(program);
}

/**
 * The "why" line of D§2.9 from agents.whyOf numbers (live.why), e.g. "+512 XP/min = working ×1 ·
 * Fresh Eyes ×1.5 · Party +12% · Herd +23% · Shift: 3h 12m today (full rate until 4h)"; the same
 * text the sidebar and nameplate tooltips show. Empty string without numbers.
 */
export function whyText(why, level) {
  return whyLine(why, { level });
}

// ---------------------------------------------------------------------------------------------
// Memory (per world)
// ---------------------------------------------------------------------------------------------

const MEMO = new WeakMap();
const WIDTH_MEMOS = 3; // strip widths remembered per world (the least recently built one goes)

function memoOf(world) {
  let m = MEMO.get(world);
  if (!m) {
    m = { key: null, vm: null, byW: new Map(), fights: new Map(), reviews: new Map(), est: new Map() };
    MEMO.set(world, m);
  }
  return m;
}

/**
 * The memory of one strip width: its fold set (hysteresis), mob and chest spots. Spots
 * are positions on a strip of that width, so each width keeps its own: two stage copies of
 * different widths (a stage opened as a pane or tab beside the layout's) would otherwise wipe each
 * other's every tick. A new width (a resize) starts empty; old widths age out.
 */
function widthMemo(memo, W) {
  let w = memo.byW.get(W);
  if (w) {
    memo.byW.delete(W); // most recently used last
  } else {
    w = { fold: null, mobs: new Map(), chests: new Map() };
  }
  memo.byW.set(W, w);
  while (memo.byW.size > WIDTH_MEMOS) memo.byW.delete(memo.byW.keys().next().value);
  return w;
}

// ---------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------

/**
 * The stage view model (ARCHITECTURE §5 StageVM + ui/stage.js "VM additions").
 * @param {object|null} world
 * @param {{width?:number, height?:number, nowMs?:number, loading?:boolean}} [args]
 */
export function stageView(world, args = {}) {
  const a = args || {};
  const W = Number.isFinite(a.width) && a.width > 0 ? a.width : 960;
  const H = Number.isFinite(a.height) && a.height > 0 ? a.height : 200;
  if (!world || !world.state || !world.rt || a.loading || world.rt.loading) {
    return emptyVM(world, W, H, { kind: "loading", title: "Loading the stack…", text: "" });
  }
  const { state, rt } = world;
  const cfg = state.herd.cfg || {};
  const memo = memoOf(world);
  const key = `${rt.version}|${rt.tick}|${W}|${H}|${cfg.calm ? 1 : 0}|${cfg.nums || "all"}|${glowOf(cfg)}`;
  if (memo.key === key && memo.vm) return memo.vm;
  // (host.view memoises per args, so two copies of different widths still build once a version)
  const vm = build(world, memo, widthMemo(memo, W), W, H);
  memo.key = key;
  memo.vm = vm;
  return vm;
}

function emptyVM(world, W, H, empty) {
  const herd = world && world.state ? world.state.herd : null;
  const cfg = (herd && herd.cfg) || {};
  return {
    tick: world && world.rt ? world.rt.tick : 0, width: W, height: H, calm: !!cfg.calm, nums: numsOf(cfg),
    stillness: true, empty, headerNote: null, herdBanner: null, rooms: [], heroes: [], mobs: [], chests: [],
    boss: null, fx: [], signs: [], overflow: null,
  };
}

function numsOf(cfg) {
  return cfg.nums === "crits" || cfg.nums === "off" ? cfg.nums : "all";
}

/** Loot glow minimum rarity (D§11.15, herd.cfg.glow): 0 (every drop glows) to 5 (Keepsakes only). */
function glowOf(cfg) {
  const g = Math.round(Number(cfg.glow) || 0);
  return g > 0 ? Math.min(g, RARITIES.length - 1) : 0;
}

function noAgents(state) {
  const n = state.heroes.length;
  if (!n) return { kind: "no_agents", title: "Help wanted", text: "Start an agent to hire a hero. Every coding agent becomes a Termling here." };
  return {
    kind: "no_agents", title: "Everyone is off duty",
    text: `Start an agent and a Termling clocks in. ${n === 1 ? "1 hero is" : `${n} heroes are`} resting at Localhost.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

function build(world, memo, wm, W, H) {
  const { state, rt } = world;
  const herd = state.herd;
  const cfg = herd.cfg || {};
  const tick = rt.tick;
  const calm = !!cfg.calm;
  const nums = numsOf(cfg);

  // live heroes in slot order
  const ents = [];
  let k = 0;
  for (const [id, live] of rt.live) {
    const hero = findHero(world, id);
    if (!hero) continue;
    ents.push({ id, hero, live, ord: typeof live.order === "number" ? live.order : Infinity, k: k++ });
  }
  if (!ents.length) {
    const vm = emptyVM(world, W, H, noAgents(state));
    vm.headerNote = headerNote(rt);
    vm.herdBanner = herdBanner(rt);
    return vm;
  }
  ents.sort((x, y) => (x.ord - y.ord) || (x.k - y.k));
  for (const e of ents) {
    e.state = e.live.state || "resting";
    e.mapId = heroMapId(e.hero, e.live);
  }
  const byId = new Map(ents.map((e) => [e.id, e]));

  // fights: the running boss fight (or one that just ended), reviews per hero (running, or one
  // that just ended: its Promotion banner or Postmortem card stays in the slot for 3 ticks)
  const fight = pickFight(world, memo, tick);
  const reviews = new Map();
  for (const f of rt.fights) if (f.kind === "review" && f.heroIds.length) reviews.set(f.heroIds[0], f);
  const reviewEnds = pickReviewEnds(memo, rt, tick);
  // nameplate labels: first names, with an epithet initial where two live heroes share one
  const plates = plateLabels(ents);
  // fighters: participants still in the fight (D§9.5: blocked ones hold, crashed ones rejoin; done
  // and idle ones have walked out and go home, as the party row and nameplate say); all of them
  // while the arena closes
  const fighters = new Set();
  if (fight) {
    for (const id of fight.f.heroIds) {
      const e = byId.get(id);
      if (e && (fight.ended || FIGHT_STATES[e.state])) fighters.add(id);
    }
  }

  // slots, arena, overflow
  const L = layoutStrip(wm, W, ents, fight, fighters, tick);

  // per-tick fx lookups (crit faces, hit mobs, dying mobs)
  const fxs = [];
  for (const f of rt.fx) {
    const age = tick - f.bornTick;
    if (age >= 0 && age < 2) fxs.push({ f, age });
  }
  const critNow = new Set();
  const hitNow = new Set();
  const poofNow = new Set();
  for (const { f, age } of fxs) {
    if (age !== 0) continue;
    if (f.kind === "crit" && f.heroId != null) critNow.add(f.heroId);
    if ((f.kind === "num" || f.kind === "crit") && f.mobUid != null) hitNow.add(f.mobUid);
    if (f.kind === "poof" && f.mobUid != null) poofNow.add(f.mobUid);
  }

  const ctx = { world, state, rt, herd, tick, calm, nums, glow: glowOf(cfg), W, H, memo, wm, critNow, hitNow, poofNow, byId, fight, reviews, reviewEnds, plates };
  const heroes = [];
  const mobs = [];
  const chests = [];
  const signs = [];
  const heroPos = new Map(); //  heroId -> {x, head, feet}
  const mobPos = new Map(); //   mob uid -> {x, top, showHp, size, mid}
  const chestPos = new Map(); // heroId -> {x, top}

  // the rooms' heroes, before their tooltips: a pinned hero's says how to unpin it, and the room
  // header's click unpins only a room whose heroes are all pinned (pinVM; else it pins them all)
  const groups = roomGroups(L);
  ctx.headerUnpins = new Set();
  for (const g of groups) {
    const pin = pinVM(g);
    if (pin && pin.pinned) for (const id of pin.heroIds) ctx.headerUnpins.add(id);
  }

  // home slots (participants' adjacent home slots in one room share one sign, centred on them)
  let run = null; // {sign, from, to, roomOf}
  for (const s of L.slots) {
    const e = s.e;
    const inArena = fight && fighters.has(e.id) && (FIGHT_STATES[e.state] || !s.shown || fight.ended);
    if (inArena) {
      if (!s.shown) continue;
      const roomOf = `${e.mapId}|${e.live.space || ""}`;
      if (run && run.roomOf === roomOf && Math.abs(run.to - s.x) < 1) {
        run.to = s.x + L.w;
        run.sign = signVM(run.e, { x: run.from }, fight, run.to - run.from);
        signs[signs.length - 1] = run.sign;
      } else {
        run = { e, roomOf, from: s.x, to: s.x + L.w, sign: signVM(e, s, fight, L.w) };
        signs.push(run.sign);
      }
      continue;
    }
    if (s.shown) run = null;
    if (!s.shown) continue;
    slotContents(ctx, e, s, L, { heroes, mobs, chests, heroPos, mobPos, chestPos });
  }

  // the arena
  let boss = null;
  if (fight && L.arena) {
    boss = arenaContents(ctx, fight, L, fighters, { heroes, mobs, heroPos, mobPos });
  }

  // dying mobs (killed this tick: gone from their lane, faded out where they stood)
  for (const uid of poofNow) {
    if (mobPos.has(uid)) continue;
    const old = wm.mobs.get(`mob:${uid}`);
    if (!old || !old.vm || tick - old.tick > 1) continue;
    const m = Object.assign({}, old.vm, { dying: true, engaged: false, pacing: false, hit: false, showHp: false, pending: false, waiting: false });
    mobs.push(m);
    mobPos.set(uid, old.pos);
  }
  rememberMobs(wm, mobs, mobPos, tick);

  // chests that opened this tick show their lid for a tick
  openedChests(ctx, chests, chestPos, heroPos, fxs);
  rememberChests(wm, chests, tick);
  // a Holo Rubber Duck's kill: its Duck Chest pops where it stood (D§9.7, D§11.8)
  duckChests(ctx, chests, heroPos, fxs);

  const rooms = buildRooms(ctx, L, fight, groups);
  const fx = buildFx(ctx, fxs, heroPos, mobPos, chestPos, boss);

  let stillness = true;
  for (const e of ents) if (WORKING_STATES[e.state]) { stillness = false; break; }

  return {
    tick, width: W, height: H, calm, nums, stillness, empty: null,
    headerNote: headerNote(rt), herdBanner: herdBanner(rt),
    rooms, heroes, mobs, chests, boss, fx, signs,
    overflow: L.chip ? overflowVM(L) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Fights
// ---------------------------------------------------------------------------------------------

/** The boss fight to show: the running one, else one that ended ≤ 3 ticks ago (memo). */
function pickFight(world, memo, tick) {
  const rt = world.rt;
  let running = null;
  for (const f of rt.fights) if (f.kind !== "review") { running = f; break; }
  if (running) memo.fights.set(running.key, running);
  let ended = null;
  for (const [key, f] of memo.fights) {
    if (f === running) continue;
    const done = (f.result === "won" || f.result === "lost") && Number.isFinite(f.endTick) && tick - f.endTick <= ENDED_TICKS && tick >= f.endTick;
    if (!done) { memo.fights.delete(key); memo.est.delete(key); continue; }
    if (!ended || f.endTick > ended.endTick) ended = f;
  }
  if (running) return { f: running, ended: false };
  if (ended) return { f: ended, ended: true };
  return null;
}

/**
 * Reviews that ended ≤ 3 ticks ago, by hero id (memo: a won or lost review leaves rt.fights at
 * once). Reviews called off (a restart, nobody Questing) end without a result and show nothing.
 */
function pickReviewEnds(memo, rt, tick) {
  const running = new Set();
  for (const f of rt.fights) {
    if (f.kind !== "review" || !f.heroIds.length) continue;
    running.add(f);
    memo.reviews.set(f.key, f);
  }
  const out = new Map();
  for (const [key, f] of memo.reviews) {
    if (running.has(f)) continue;
    const done = (f.result === "won" || f.result === "lost") && Number.isFinite(f.endTick) && tick - f.endTick <= ENDED_TICKS && tick >= f.endTick;
    if (!done) { memo.reviews.delete(key); continue; }
    const id = f.heroIds[0];
    const prev = out.get(id);
    if (!prev || f.endTick > prev.endTick) out.set(id, f);
  }
  return out;
}

/** Pixel needs of an arena: fighters ≥ 56 px apart, room for adds, the boss and its parts. */
function arenaShape(f) {
  const id = f.id;
  const nParts = BOSS_PART_COUNT[id] || 0;
  const half = Math.ceil(nParts / 2);
  const reach = nParts ? 60 + 12 * Math.max(0, half - 1) + 16 : 60;
  const adds = ADD_BOSSES[id] ? 96 : 0;
  const n = Math.max(1, f.heroIds.length);
  // first fighter at +26, the last one 24 px left of the adds, then the boss and its parts
  return { nParts, half, reach, adds, n, need: 26 + ARENA_GAP * (n - 1) + 24 + adds + 2 * reach + 6 };
}
const BOSS_PART_COUNT = { octopus_merge: 8, deadlock_hydra: 2, monolith: 6 };

// ---------------------------------------------------------------------------------------------
// Slot layout (D§11.3)
// ---------------------------------------------------------------------------------------------

function protectedHero(e, fighters) {
  return e.state === "waiting" || (e.hero.pend && e.hero.pend.length > 0) || !!e.live.focused || !!e.live.pinned || fighters.has(e.id);
}

const FOLD_RANK = { resting: 0, shipped: 0, supervising: 1, questing: 2, crashed: 2, waiting: 9 };

/**
 * Widths for n home slots, an optional arena and a chip of width chipW (0 = none): slots and
 * arena share the rest as 1 : 2 units, and the arena takes what the slots can spare above 120 px
 * when 2w is less than its fighters need. With no home slot the arena alone takes up to 640 px.
 */
function widths(W, n, shape, chipW) {
  const avail = Math.max(0, W - chipW);
  if (!shape) return { w: n ? Math.min(SLOT_MAX, avail / n) : 0, aw: 0 };
  if (!n) return { w: 0, aw: Math.min(avail, Math.max(shape.need, Math.min(2 * SLOT_MAX, avail))) };
  let w = Math.min(SLOT_MAX, avail / (n + 2));
  let aw = 2 * w;
  if (aw < shape.need) {
    // the fighters' spacing (stage review: ≥ 56 px) wins over roomy slots, down to 120 px slots
    aw = Math.min(shape.need, Math.max(aw, avail - n * SLOT_FOR_ARENA));
    w = Math.min(SLOT_MAX, (avail - aw) / n);
  }
  // the arena never gets less than its contents can shrink to (scale 0.6): below that the fighters
  // would overlap each other and the adds, so the slots give way (and fold) instead
  const floor = Math.min(avail, ARENA_MIN_SCALE * shape.need);
  if (aw < floor) {
    aw = floor;
    w = Math.min(SLOT_MAX, (avail - aw) / n);
  }
  return { w, aw };
}

/** The camp chip is 150 px (D§11.3.4); on a narrow strip it shrinks so a slot still fits. */
const chipWidth = (W) => (W >= 600 ? CHIP_W : 96);

function layoutStrip(wm, W, ents, fight, fighters, tick) {
  const shape = fight ? arenaShape(fight.f) : null;
  const homeless = new Set(); // participants whose home slot is dropped (narrow strips)
  let folded = new Set();
  let n = ents.length;
  let dims = widths(W, n, shape, 0);
  if (dims.w < SLOT_MIN && shape && fighters.size) {
    // 1. participants fight in the arena: their home slots go first
    for (const id of fighters) homeless.add(id);
    n -= fighters.size;
    dims = widths(W, n, shape, 0);
  }
  let chipW = 0;
  if ((dims.w < SLOT_MIN || n > MAX_SLOTS) && (n > 1 || (shape && n > 0))) {
    // 2. fold into the camp chip (hysteresis: foldSet)
    const cands = ents.filter((e) => !homeless.has(e.id));
    const cw = chipWidth(W);
    folded = foldSet(wm, W, cands, fighters, shape, tick, cw);
    if (folded.size) {
      chipW = cw;
      n = cands.length - folded.size;
      dims = widths(W, n, shape, chipW);
    }
  }
  const w = n ? Math.max(SLOT_SQUEEZE * 0.67, dims.w) : 0;
  const aw = shape ? dims.aw : 0;
  const used = n * w + aw;
  const x0 = chipW ? 0 : Math.max(0, (W - used) / 2);
  const slots = [];
  let i = 0;
  for (const e of ents) {
    if (folded.has(e.id)) continue;
    const shown = !homeless.has(e.id);
    const x = shown ? x0 + i * w : null;
    if (shown) i++;
    slots.push({ e, shown, x, w });
  }
  const arena = shape ? { x: x0 + n * w, w: aw, shape, s: clamp(aw / shape.need, ARENA_MIN_SCALE, 1) } : null;
  const chipBox = chipW ? { x: used, w: Math.max(0, W - used) } : null;
  const foldedList = ents.filter((e) => folded.has(e.id));
  return { slots, w, scale: w < SLOT_MIN ? Math.max(0.6, r2(w / SLOT_MIN)) : 1, arena, chip: chipBox, folded: foldedList };
}

// Protected heroes fold only when even squeezed slots cannot hold them: chest, pinned and focused
// heroes before blocked ones, lowest level first.
const PROTECT_RANK = (e) => (e.state === "waiting" ? 3 : e.live.focused ? 2 : e.live.pinned ? 1 : 0);
/** How strongly a hero wants a slot (a folded hero whose key rose is promoted at once). */
const foldKey = (e, fighters) => (protectedHero(e, fighters) ? 10 + PROTECT_RANK(e) : 0);

/**
 * The overflow fold set with D§11.3.4 hysteresis: recomputed on membership or size changes, every
 * 30 ticks, or at once when a folded hero became protected (newly blocked, focused, a chest...).
 */
function foldSet(wm, W, cands, fighters, shape, tick, chipW) {
  const sig = `${W}|${shape ? shape.need : 0}|${cands.map((e) => e.id).join(",")}`;
  const prev = wm.fold;
  if (prev && prev.sig === sig && tick - prev.tick < FOLD_TICKS && tick >= prev.tick) {
    let ok = true;
    for (const e of cands) if (prev.set.has(e.id) && foldKey(e, fighters) > prev.keys.get(e.id)) { ok = false; break; }
    if (ok) return prev.set;
  }
  // how many slots fit next to the chip (and the arena): comfortably, or squeezed for the
  // protected heroes
  const P = cands.filter((e) => protectedHero(e, fighters)).length;
  const minShown = shape ? 0 : 1;
  let fit = minShown;
  for (let k = Math.min(cands.length - 1, MAX_SLOTS); k > minShown; k--) if (widths(W, k, shape, chipW).w >= SLOT_MIN) { fit = k; break; }
  let squeeze = minShown;
  for (let k = Math.min(P, cands.length - 1, MAX_SLOTS); k > minShown; k--) if (widths(W, k, shape, chipW).w >= SLOT_SQUEEZE) { squeeze = k; break; }
  const shown = Math.min(cands.length, Math.max(fit, squeeze));
  const free = cands.filter((e) => !protectedHero(e, fighters))
    .sort((a, b) => (FOLD_RANK[a.state] ?? 2) - (FOLD_RANK[b.state] ?? 2) || a.hero.L - b.hero.L || b.k - a.k);
  const prot = cands.filter((e) => protectedHero(e, fighters))
    .sort((a, b) => PROTECT_RANK(a) - PROTECT_RANK(b) || a.hero.L - b.hero.L || b.k - a.k);
  const order = free.concat(prot);
  const nFold = Math.max(0, cands.length - shown);
  const set = new Set(order.slice(0, nFold).map((e) => e.id));
  const keys = new Map();
  for (const e of cands) if (set.has(e.id)) keys.set(e.id, foldKey(e, fighters));
  wm.fold = { sig, tick, set, keys };
  return set;
}

function overflowVM(L) {
  const list = L.folded;
  return {
    key: "overflow", x: r1(L.chip.x), w: r1(L.chip.w), count: list.length,
    dots: list.map((e) => DOT[e.state] || COL.idle),
    tooltip: `At camp (${list.length}):\n` + list.map((e) => `${e.hero.name} · Lv ${e.hero.L} · ${(WORD[e.state] || "resting").toLowerCase()}`).join("\n"),
  };
}

// ---------------------------------------------------------------------------------------------
// One home slot: hero, Forklings, campfire, crate, chest, lane mobs (or a review opponent)
// ---------------------------------------------------------------------------------------------

function slotContents(ctx, e, s, L, out) {
  const { hero, live, state: st } = e;
  const w = s.w;
  const sx = s.x;
  const scale = L.scale;
  const forks = live.forklings || [];
  const review = ctx.reviews.get(e.id) || null;
  let hx;
  if (st === "resting") hx = sx + 0.22 * w;
  else if (forks.length && st !== "shipped") hx = sx + 0.16 * w;
  else hx = sx + 0.24 * w;
  const pend = hero.pend && hero.pend.length ? hero.pend : null;

  // chest: clear of the face (D§11.10 + stage review), behind a fighting hero
  let chestX = null;
  if (pend) {
    if (st === "shipped" || st === "resting") chestX = Math.max(sx + 0.42 * w, hx + 34 * scale);
    else {
      // behind a working hero: the 40 px ribbon (chest x ± 20) ends left of the screen (hero x − 14)
      // and the crate. A slot under ~210 px cannot keep the 28 px chest clear at the hero's usual
      // place, so there the hero steps right until the chest clears its body (but for 4 px); a hero
      // with Forklings keeps its place (its row of sub-agents starts after it)
      chestX = Math.max(sx + 14, hx - 38 * scale);
      if (!forks.length) hx = Math.max(hx, chestX + 14 + CHEST_BODY_HALF * scale - 4);
    }
  }

  // Forklings from 0.30w (after the chest when the hero sits by one), as many as fit
  const fkVMs = [];
  let extra = 0;
  if (forks.length) {
    const step = Math.max(14, 0.07 * w);
    let fx0 = Math.max(sx + 0.30 * w, hx + 26 * scale);
    if (chestX != null && chestX > hx) fx0 = Math.max(fx0, chestX + 24);
    const limit = review || !WORKING_STATES[st] && st !== "waiting" ? sx + 0.92 * w : sx + (w < 180 ? 0.46 : 0.42) * w;
    const fit = Math.max(1, Math.min(3, Math.floor((limit - fx0) / step) + 1));
    const shownForks = Math.min(forks.length, fit);
    for (let j = 0; j < shownForks; j++) fkVMs.push(forklingVM(forks[j], fx0 + j * step));
    extra = forks.length - shownForks;
  }

  const vm = heroVM(ctx, e, { x: hx, scale, slot: { x: r1(sx), w: r1(w) }, plateMax: w - 12, forklings: fkVMs, extra, inArena: false });
  if (st === "resting") vm.campfire = { x: r1(sx + 0.08 * w), y: GROUND };
  if (review && st !== "waiting") vm.tag = { text: "REVIEW", color: COL.hp };
  let lanePos = w < 180 ? [0.58, 0.84] : [0.52, 0.70, 0.88];
  // the front lane stays clear of a hero that stepped right for its chest (a large mob's half
  // width past the hero's body); the lanes behind move with it, and one pushed out of the slot goes
  const front = (hx - sx + (CHEST_BODY_HALF + SIZE_PX.L / 2) * scale + 2) / w;
  if (front > lanePos[0]) {
    const d = front - lanePos[0];
    lanePos = lanePos.map((p) => p + d).filter((p, j) => j === 0 || p * w + (SIZE_PX.L / 2) * scale <= w);
  }
  out.heroes.push(vm);
  out.heroPos.set(e.id, posOf(vm, { x: r1(sx + lanePos[0] * w), top: GROUND - 40 }));

  if (pend) {
    const c = chestVM(e, chestX, pend);
    out.chests.push(c);
    out.chestPos.set(e.id, { x: c.x, top: GROUND - 22 });
  }

  // the lane: questing / supervising / waiting / crashed heroes keep theirs (resting, shipped don't)
  if (review) {
    reviewMobs(ctx, e, review, sx, w, lanePos, scale, out);
    return;
  }
  if (!(WORKING_STATES[st] || st === "waiting")) return;
  const lane = live.lane || [];
  const ct = live.ct || 0;
  const working = WORKING_STATES[st] && !ctx.calm;
  for (let j = 0; j < lane.length && j < lanePos.length; j++) {
    const m = lane[j];
    const pos = typeof m.lanePos === "number" ? m.lanePos : j;
    if (pos >= lanePos.length) continue;
    const arriving = m.arriveTick > ct;
    const x = sx + lanePos[pos] * w + (arriving ? 14 : 0);
    const engaged = m.uid === live.engagedUid && !arriving;
    const mv = mobVM(ctx, m, x, {
      engaged, arriving, pacing: working && !engaged && !arriving, waiting: st === "waiting",
      paceAmp: Math.max(4, Math.min(12, Math.round(0.05 * w))), scale, lane: pos,
    });
    out.mobs.push(mv);
    out.mobPos.set(m.uid, mobPosOf(mv));
  }
}

function reviewMobs(ctx, e, f, sx, w, lanePos, scale, out) {
  // the opponent (a greyed hero rig, D§11.4) at the front, its Nitpicks behind it
  const body = f.parts.find((p) => p.kind === "boss");
  let j = 0;
  if (body && body.hp > 0) {
    const mv = partMob(ctx, f, body, sx + lanePos[0] * w, { engaged: true, sprite: "boss/senior_reviewer.svg", px: 56, size: "L", scale, lane: 0 });
    out.mobs.push(mv);
    out.mobPos.set(body.uid, mobPosOf(mv));
    j = 1;
  }
  for (const p of f.parts) {
    if (p.kind !== "add" || !(p.hp > 0) || j >= lanePos.length) continue;
    const mv = partMob(ctx, f, p, sx + lanePos[j] * w, { engaged: false, scale, lane: j });
    j++;
    out.mobs.push(mv);
    out.mobPos.set(p.uid, mobPosOf(mv));
  }
}

function signVM(e, s, fight, w) {
  const f = fight.f;
  // the boss HP left, as the party's "BOSS n%" chip and the tooltips count it
  const left = bossHpFrac(f);
  const pct = left > 0 ? Math.max(1, Math.ceil(left * 100)) : 0;
  let text = fight.ended ? (f.result === "won" ? `→ ${f.name} ✓` : `→ ${f.name}: Postmortem`) : `→ ${f.name} ${pct}% left`;
  if (!fight.ended && text.length * 5.4 + 12 > w - 8) text = `→ ${f.name} ${pct}%`;
  if (text.length * 5.4 + 12 > w - 8) text = fight.ended ? (f.result === "won" ? "→ FIXED ✓" : "→ Postmortem") : `→ BOSS ${pct}%`;
  return { key: `sign:${e.id}`, x: r1(s.x + 0.5 * w), text };
}

// ---------------------------------------------------------------------------------------------
// HeroVM
// ---------------------------------------------------------------------------------------------

function heroVM(ctx, e, o) {
  const { hero, live, state: st } = e;
  const { tick, state } = ctx;
  const clsId = (CLASSES[hero.cls] || CLASSES[0]).id;
  const career = careerOf(hero);
  const label = ctx.plates.get(e.id) || firstName(hero.name);
  const plateMax = Math.round(o.plateMax);
  const plateW = (t) => Math.round(t.length * 5.7 + 14);
  let plateText = `${label} ${hero.L}`;
  // a crowded arena (narrow strip, fighters < 56 px apart): names only, plates no wider than the gap
  if (o.inArena && plateW(plateText) > plateMax) plateText = label;
  const pw = clamp(plateW(plateText), Math.min(44, plateMax), plateMax);
  const crit = st === "questing" && ctx.critNow.has(e.id);
  const hpFrac = frac(live.hp, live.maxHp);
  const xpNeed = hero.L >= T.levelCap ? 0 : need(hero.L);
  const xpFrac = hero.L >= T.levelCap ? 1 : frac(hero.xp, xpNeed);
  const feCap = freshEyesCapMin(state);
  const feFrac = frac(hero.fe || 0, feCap);
  const down = live.crashedUntil > tick;
  const attacking = st === "questing" && !down && (o.inArena
    ? !!ctx.fight && !ctx.fight.ended
    : (live.engagedUid != null && (live.lane || []).some((m) => m.uid === live.engagedUid)) || !!ctx.reviews.get(e.id));
  const blockedFor = st === "waiting" && live.blockedSince != null ? Math.max(0, tick - live.blockedSince) : 0;

  // weapon and hat from the equipped items (tier tones D§11.1)
  const wpn = hero.eq && hero.eq[0];
  const wt = wpn ? itemTier(wpn.ilvl || 1) : 1;
  const hat = hero.eq && hero.eq[1];
  const ht = hat ? itemTier(hat.ilvl || 1) : 0;

  let tag = null;
  if (st === "waiting" && blockedFor >= 120) tag = { text: `! ${fmtDuration(blockedFor, { capHour: true })}`, color: COL.blocked };
  else if (st === "crashed") tag = { text: "rebooting", color: COL.idle };
  else if ((hero.fe || 0) >= 1 && !o.inArena) tag = { text: `Fresh Eyes ${fmtDuration(Math.floor(hero.fe) * 60)}`, color: COL.fresh };

  let rebootFrac = null;
  if (st === "crashed" && live.crashedUntil > tick) {
    const dur = o.inArena ? T.boss.crashRejoinTicks : T.crash.downTicks;
    rebootFrac = r2(clamp(1 - (live.crashedUntil - tick) / dur, 0, 1));
  }

  const vm = {
    key: `hero:${e.id}`, heroId: e.id, address: live.address || "", x: r1(o.x), y: GROUND, scale: o.scale,
    name: hero.name, level: hero.L, careerTitle: career.title, clsId,
    face: crit ? ">_<" : FACE[st] || ">_", state: st, focused: !!live.focused, pinned: !!live.pinned,
    attacking, opacity: st === "supervising" || st === "crashed" ? 0.6 : 1,
    hpFrac: r2(hpFrac), xpFrac: r2(xpFrac), feFrac: r2(feFrac),
    colors: termlingColors(hero, live, st),
    programIcon: programIconOf(live.program),
    weapon: { clsId, color: ITEM_BASES.weaponTierTones[wt - 1], edge: wt === 5 },
    hat: ht ? { tier: ht, color: HAT_COLORS[(hat.uid || 0) % HAT_COLORS.length] } : null,
    accessory: clsId,
    bubble: st === "waiting" && live.bubbleShown
      ? { label: `Waiting for you · ${fmtDuration(blockedFor)} · click to jump there` } : null,
    zzz: st === "resting" && tick - (live.statusSince || 0) >= 600,
    campfire: null,
    crate: st === "waiting",
    tag,
    forklings: o.forklings,
    forklingExtra: o.extra,
    tooltip: heroTooltip(ctx, e, career, o.inArena),
    nameplate: { x: r1(o.x), y: PLATE_Y, w: pw, text: plateText, hpFrac: r2(hpFrac) },
    slot: o.slot,
    rebootFrac,
    reviewEnd: o.inArena ? null : reviewEndVM(ctx, e, career),
  };
  return vm;
}

const firstName = (name) => String(name || "").split(" ")[0] || "Hero";
const NAME_GLUE = /^(the|of|a|an|and|de|von|van)$/i;

/**
 * Nameplate labels per hero id (D§3.3 names hash 64 first names per seat, so two live heroes often
 * share one): the first name, or for a shared one the first name and the initial of its epithet
 * ("Ivo S." for "Ivo of Small Commits", "Ivo O." for "Ivo Off-By-One"); initials of every epithet
 * word when those still collide, then the hero id.
 */
function plateLabels(ents) {
  const out = new Map();
  const groups = new Map();
  for (const e of ents) {
    const first = firstName(e.hero.name);
    out.set(e.id, first);
    if (!groups.has(first)) groups.set(first, []);
    groups.get(first).push(e);
  }
  for (const [first, list] of groups) {
    if (list.length < 2) continue;
    const words = (e) => String(e.hero.name || "").split(/\s+/).slice(1).filter((w) => w && !NAME_GLUE.test(w));
    const initial = (w) => (w.match(/[A-Za-z0-9]/) || [""])[0].toUpperCase();
    const ways = [
      (e) => { const ws = words(e); return ws.length ? `${initial(ws[0])}.` : ""; },
      (e) => { const ws = words(e).flatMap((w) => w.split("-")).filter(Boolean); return ws.length ? `${ws.map(initial).join("")}.` : ""; },
      (e) => `#${e.id}`,
    ];
    for (const way of ways) {
      const tags = list.map(way);
      if (tags.every(Boolean) && new Set(tags).size === tags.length) {
        list.forEach((e, i) => out.set(e.id, `${first} ${tags[i]}`));
        break;
      }
    }
  }
  return out;
}

/**
 * A review that ended ≤ 3 ticks ago, in the hero's own slot (D§11.8): won, the Promotion banner
 * ("PROMOTED" over the new career title, with confetti); lost, the Postmortem card. age 0 = about
 * to show, 1-2 shown, 3 = going (as BossVM.banner).
 */
function reviewEndVM(ctx, e, career) {
  const f = ctx.reviewEnds.get(e.id);
  if (!f) return null;
  const age = Math.max(0, ctx.tick - f.endTick);
  if (f.result === "won") return { key: `${f.key}:end`, kind: "promoted", text: "PROMOTED", sub: career.title, age };
  const pm = postmortemText(ctx.state, f);
  return { key: `${f.key}:end`, kind: "postmortem", text: pm.title, sub: pm.sub, age };
}

function heroTooltip(ctx, e, career, inArena) {
  const { hero, live, state: st } = e;
  const { tick, state } = ctx;
  const lines = [];
  lines.push(`${hero.name} · Lv ${hero.L} ${career.title}${hero.contractor ? " · Contractor" : ""}`);
  const xpPct = hero.L >= T.levelCap ? 100 : Math.floor(frac(hero.xp, need(hero.L)) * 100);
  // pinned: the room header unpins a room whose heroes are all pinned; in a mixed room its click
  // pins them all, so there the sheet's Map card is the way back to auto
  const pinned = Boolean(hero.pinMap) && hero.pinMap === e.mapId;
  const unpin = ctx.headerUnpins && ctx.headerUnpins.has(e.id) ? "click the room header to unpin" : "Auto on the Career tab's Map card unpins";
  const where = inArena && ctx.fight ? ctx.fight.f.name : `${mapLabel(state, e.mapId)}${pinned ? ` (pinned: ${unpin})` : ""}`;
  lines.push(`HP ${fmtNum(Math.max(0, live.hp || 0))}/${fmtNum(live.maxHp || 0)} · XP ${xpPct}% · ${where}`);
  const since = Math.max(0, tick - (st === "waiting" && live.blockedSince != null ? live.blockedSince : live.statusSince || 0));
  // while a task is open, the label the party and pane header give it (chrome.taskLabel): never a
  // bare program, shell or path title
  const quest = live.task ? taskLabel(live) : "";
  lines.push(`${WORD[st] || "Resting"} ${fmtDuration(since)}${quest ? ` · ${quest}` : ""}`);
  const why = whyText(live.why, hero.L);
  if (why) lines.push(why);
  if ((hero.fe || 0) >= 1) lines.push(`Fresh Eyes ${fmtDuration(Math.floor(hero.fe) * 60)} banked (×${T.freshEyes.xpMult} kill XP while questing)`);
  const forks = live.forklings || [];
  if (forks.length) lines.push(`${forks.length === 1 ? "1 Forkling" : `${forks.length} Forklings`} (sub-agents)`);
  return lines.join("\n");
}

function forklingVM(f, x) {
  const status = f.status === "working" || f.status === "blocked" ? f.status : "idle";
  const title = tellingTitle(f.title, f);
  return {
    key: `fork:${f.address}`, address: String(f.address), x: r1(x), y: GROUND,
    face: status === "working" ? ">_" : status === "blocked" ? "o_o" : "-_-", status,
    bubble: status === "blocked",
    tooltip: title ? `Sub-agent: ${title}` : "Sub-agent",
  };
}

/** Where a hero's effects go: head, feet, and the front of its lane (fallback for gone mobs). */
function posOf(vm, front) {
  const s = vm.scale || 1;
  const lift = vm.crate ? 12 : 0;
  return { x: vm.x, head: GROUND - lift - 48 * s, feet: GROUND - lift, scale: s, front: front || { x: vm.x + 56 * s, top: GROUND - 40 } };
}

// ---------------------------------------------------------------------------------------------
// MobVM
// ---------------------------------------------------------------------------------------------

function mobVM(ctx, m, x, o) {
  const def = MOB_BY_ID[m.mobId] || { name: m.mobId, size: "S", traits: [] };
  const tr = m.traits || {};
  const size = SIZE_PX[def.size] ? def.size : "S";
  let name = m.holo ? HOLO_DUCK.name : def.name;
  if (m.elite) name = `${ELITE.prefix} ${name}`;
  if (m.v2) name = `${name} ${BACKLOG.versionTag}`;
  return {
    key: `mob:${m.uid}`, mobId: m.mobId, name, x: r1(x), y: GROUND, size, px: SIZE_PX[size],
    sprite: `mob/${m.mobId}.svg`, glyph: null, glyphColor: COL.cream,
    elite: !!m.elite, holo: !!m.holo, hpFrac: r2(frac(m.hp, m.maxHp)),
    showHp: o.engaged || (m.hp < m.maxHp && !o.arriving), engaged: !!o.engaged,
    pacing: !!o.pacing, paceAmp: o.paceAmp || 12, opacity: o.arriving ? 0 : 1,
    phaser: (tr.phaser || 0) > 0 || tr.shape === "phaser",
    pending: (tr.pending || 0) > 0 && !o.arriving, growScale: r2((1 + (tr.grow || 0)) * (o.scale || 1)), dying: false,
    hit: ctx.hitNow.has(m.uid), waiting: !!o.waiting && !o.arriving, lane: o.lane || 0,
  };
}

/** A boss-fight add or review opponent drawn as a lane mob (MobVM). */
function partMob(ctx, f, p, x, o) {
  const def = MOB_BY_ID[p.art] || null;
  const size = o.size || (def && SIZE_PX[def.size] ? def.size : "S");
  return {
    key: `mob:${p.uid}`, mobId: def ? def.id : String(p.art || f.id), name: p.label || (def ? def.name : f.name),
    x: r1(x), y: GROUND, size, px: o.px || SIZE_PX[size], sprite: o.sprite || `mob/${def ? def.id : "nitpick"}.svg`,
    glyph: null, glyphColor: COL.cream, elite: false, holo: false, hpFrac: r2(frac(p.hp, p.maxHp)),
    showHp: true, engaged: !!o.engaged, pacing: false, paceAmp: 12, opacity: 1, phaser: false,
    pending: false, growScale: r2(o.scale || 1), dying: false, hit: ctx.hitNow.has(p.uid), waiting: false,
    lane: o.lane || 0,
  };
}

function mobPosOf(mv) {
  const size = Math.round(mv.px * (mv.elite ? 1.25 : 1) * (mv.growScale || 1));
  return { x: mv.x, top: GROUND - size, showHp: mv.showHp, size, mid: GROUND - size / 2 };
}

function rememberMobs(wm, mobs, mobPos, tick) {
  for (const m of mobs) {
    const uid = m.key.slice(4);
    const pos = mobPos.get(Number(uid)) || mobPos.get(uid);
    if (!pos) continue;
    const prev = wm.mobs.get(m.key);
    if (m.dying && prev) continue;
    wm.mobs.set(m.key, { vm: m, pos, tick });
  }
  // lookups by raw uid go through the key
  for (const [k, v] of wm.mobs) if (tick - v.tick > MEMO_TICKS || v.tick > tick) wm.mobs.delete(k);
  if (wm.mobs.size > 400) wm.mobs.clear();
}

// ---------------------------------------------------------------------------------------------
// Chests
// ---------------------------------------------------------------------------------------------

function chestVM(e, x, pend) {
  let best = null;
  const lines = [];
  for (const p of pend) {
    const info = chestInfo(p);
    if (!best || info.raw > best.raw) best = info;
    if (lines.length < 3) lines.push(`Shipped: ${tellingTitle(info.title, e.live) || "a task"} · ${r1(info.seals)} Seals · ${cap1(info.tier)} chest`);
  }
  if (pend.length > 3) lines.push(`…and ${pend.length - 3} more`);
  lines.push(pend.length > 1 ? "Click to open them" : "Click to open it");
  return {
    key: `chest:${e.id}`, heroId: e.id, address: e.live.address || null, x: r1(x), y: GROUND,
    tier: best ? best.tier : "wooden", count: pend.length, open: false, tooltip: lines.join("\n"),
  };
}

/** A chest that opened this tick (its gold coin fx, no mob) keeps its spot for a tick, lid open. */
function openedChests(ctx, chests, chestPos, heroPos, fxs) {
  const { wm, tick } = ctx;
  const has = new Set(chests.map((c) => c.heroId));
  for (const { f, age } of fxs) {
    if (f.kind !== "coin" || f.mobUid != null || f.roomId === "arena" || f.heroId == null || has.has(f.heroId)) continue;
    const old = wm.chests.get(f.heroId);
    if (!old || !heroPos.has(f.heroId) || tick - old.tick > 1 + age) continue;
    has.add(f.heroId);
    chests.push(Object.assign({}, old.vm, { open: true, count: 1, tooltip: "Opened" }));
    chestPos.set(f.heroId, { x: old.vm.x, top: GROUND - 22 });
  }
}

function rememberChests(wm, chests, tick) {
  for (const c of chests) if (!c.open && c.tier !== "duck") wm.chests.set(c.heroId, { vm: c, tick });
  for (const [k, v] of wm.chests) if (tick - v.tick > MEMO_TICKS || v.tick > tick) wm.chests.delete(k);
}

/**
 * D§9.7 / D§11.8 "Duck Chest pops on a kill": the loot of a Holo Rubber Duck comes out of a Duck
 * Chest where the duck stood: closed on the kill tick (age 0), lid open on the next (age 1). The
 * engine offers the item at once (no claim), so the chest is only a picture: tier "duck" never
 * claims. A duck kill is the loot fx of a mob remembered as holo (or a loot fx the engine marks:
 * holo / src "duck" / text "duck"); a duck never seen (a VM restart that tick) stands at the
 * front of the finder's lane.
 */
function duckChests(ctx, chests, heroPos, fxs) {
  const { wm, byId } = ctx;
  for (const { f, age } of fxs) {
    if (f.kind !== "loot" || f.mobUid == null || f.roomId === "arena") continue;
    const old = wm.mobs.get(`mob:${f.mobUid}`);
    const holo = !!(old && old.vm && old.vm.holo) || f.holo === true || f.src === "duck" || f.text === "duck";
    if (!holo) continue;
    const hp = f.heroId != null ? heroPos.get(f.heroId) : null;
    if (!hp || hp.closing) continue; // the finder is folded into the camp chip or off stage
    const x = old && old.pos ? old.pos.x : hp.front.x;
    const e = byId.get(f.heroId);
    const rar = RARITIES[f.rar] || null;
    chests.push({
      key: `chest:duck:${f.key}`, heroId: f.heroId, address: (e && e.live.address) || null, x: r1(x), y: GROUND,
      tier: "duck", count: 1, open: age > 0,
      tooltip: `Duck Chest from a ${HOLO_DUCK.name}${rar ? ` · ${rar.name} item` : ""} · 10× gold · Snippets`,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The boss arena (D§11.3.5, D§11.8)
// ---------------------------------------------------------------------------------------------

function bossHpFrac(f) {
  let hp = 0;
  for (const p of f.parts) if (p.kind === "boss" || p.kind === "head" || p.kind === "service") hp += Math.max(0, p.hp);
  if (f.result === "won") return 0;
  return f.pool > 0 ? clamp(hp / f.pool, 0, 1) : 0;
}

function arenaContents(ctx, fight, L, fighters, out) {
  const f = fight.f;
  const { tick, state } = ctx;
  const a = L.arena;
  const shape = a.shape;
  const ax = a.x;
  const aw = a.w;
  const z = a.s; // < 1 when the strip cannot give the arena what its fighters need
  const reach = shape.reach * z;
  const adds = shape.adds * z;
  const gap = ARENA_GAP * z;
  const bw = Math.round(112 * z);
  const bh = Math.round(96 * z);
  // boss: ~0.7 of the arena, kept clear of the right edge and of the fighters
  const minBx = ax + 26 * z + gap * (shape.n - 1) + 24 * z + adds + reach;
  const maxBx = ax + aw - reach - 6 * z;
  const bx = Math.min(maxBx, Math.max(ax + 0.7 * aw, minBx));
  const addLeft = bx - reach - 18 * z;
  const heroRight = bx - reach - adds - 24 * z;

  // fighters (participants in a fighting state; all of them while the arena closes)
  const list = [];
  for (const id of f.heroIds) {
    const e = ctx.byId.get(id);
    if (!e) continue;
    const slot = L.slots.find((s) => s.e === e);
    if (!slot) continue;
    if (!fight.ended && !FIGHT_STATES[e.state] && slot.shown) continue;
    list.push(e);
  }
  const n = list.length;
  const x0 = ax + 26 * z;
  const spRoom = n > 1 ? (heroRight - x0) / (n - 1) : 0;
  const sp = n > 1 ? clamp(spRoom, 40 * z, 72) : 0;
  const scale = r2(clamp(Math.min(z, sp > 0 && sp < ARENA_GAP ? sp / ARENA_GAP : 1), 0.6, 1));
  const front = { x: r1(bx), top: GROUND - bh };
  list.forEach((e, i) => {
    const x = x0 + i * sp;
    const vm = heroVM(ctx, e, { x, scale, slot: { x: r1(x - 28 * scale), w: Math.round(56 * scale) }, plateMax: Math.max(30, (sp || 72) - 2), forklings: [], extra: 0, inArena: true });
    out.heroes.push(vm);
    const pos = posOf(vm, front);
    // while the arena closes, the fighters' lanes already run again off stage: no lane effects here
    if (fight.ended) pos.closing = true;
    out.heroPos.set(e.id, pos);
  });

  // adds stand between the fighters and the boss
  let j = 0;
  for (const p of f.parts) {
    if (p.kind !== "add" || !(p.hp > 0) || fight.ended) continue;
    const x = addLeft - (30 * (j % 3) + 12 * Math.floor(j / 3)) * z;
    const mv = partMob(ctx, f, p, x, { engaged: false, scale: z, lane: j });
    j++;
    out.mobs.push(mv);
    out.mobPos.set(p.uid, mobPosOf(mv));
  }

  // parts (heads, tentacles, services) flank the body
  const parts = [];
  const bodyParts = f.parts.filter((p) => p.kind === "head" || p.kind === "tentacle" || p.kind === "service");
  const half = Math.max(1, shape.half);
  const room = Math.max(0, Math.min(bx - (ax + 4), ax + aw - 4 - bx) - 76 * z);
  const step = half > 1 ? Math.min(12 * z, room / (half - 1)) : 0;
  for (const p of bodyParts) {
    const i = p.ord || 0;
    const side = i < half ? -1 : 1;
    const kk = i < half ? i : i - half;
    const px = bx + side * (60 * z + step * kk);
    const py = GROUND - 4 - 9 * kk;
    parts.push({ key: `boss:${f.key}/part:${p.key}`, label: p.label, hpFrac: r2(frac(p.hp, p.maxHp)), x: r1(px), y: r1(py), active: p.hp > 0 });
    out.mobPos.set(p.uid, { x: r1(px), top: py - 32, showHp: true, size: 32, mid: py - 16 });
  }
  out.mobPos.set(`${f.key}:body`, { x: r1(bx), top: GROUND - bh, showHp: false, size: bh, mid: GROUND - bh / 2 });

  const def = BOSSES[f.bossIdx] || null;
  const hpFrac = bossHpFrac(f);
  const age = Math.max(0, tick - (f.startedTick || 0));
  let banner = null;
  if (!fight.ended && f.banner && tick - f.banner.tick <= 3 && tick >= f.banner.tick) {
    banner = { key: f.banner.key, text: f.banner.text, sub: f.banner.sub || "", age: tick - f.banner.tick, kind: "entrance" };
  } else if (fight.ended && f.result === "lost") {
    const pm = postmortemText(state, f);
    banner = { key: `${f.key}:pm`, text: pm.title, sub: pm.sub, age: Math.max(0, tick - f.endTick), kind: "postmortem" };
  }
  const stamp = fight.ended && f.result === "won" && f.stamp
    ? { key: f.stamp.key, text: f.stamp.text || "FIXED", age: Math.max(0, tick - f.stamp.tick), sprite: "fx/stamp-fixed.svg" } : null;

  return {
    key: `boss:${f.key}`, bossId: f.id, name: f.name, x: r1(bx), y: GROUND, w: bw, h: bh, sprite: `boss/${f.id}.svg`,
    hpFrac: r2(hpFrac), segments: Math.max(1, f.segments || 1), mechText: f.mechText && !fight.ended ? String(f.mechText) : null,
    phaseLabel: f.phaseLabel && !fight.ended ? f.phaseLabel : null, timerFrac: r2(f.timer > 0 ? clamp(1 - f.t / f.timer, 0, 1) : 0),
    enraged: !!f.enraged, invuln: !!f.invuln && !fight.ended, parts,
    partSprite: bodyParts.length || BOSS_PART_COUNT[f.id] ? `boss/${f.id}-part.svg` : null,
    banner, stamp, arena: { x: r1(ax), w: r1(aw) }, age: fight.ended ? 9 : age,
    tooltip: bossTooltip(ctx, f, def) + (fight.ended ? "" : "\nClick twice to retreat (a Postmortem: Wounds and Lessons are kept)"),
    // D§11.16 Retreat from the boss: the first click arms, the second (within a few ticks) runs it
    retreat: fight.ended ? null : { confirm: "Retreat? Click again", args: {} },
  };
}

function postmortemText(state, f) {
  // boss.js woundKey: "bl<floor>", "rv<review>.<heroId>" or the boss index
  const key = f.kind === "backlog" ? `bl${f.floor}` : f.kind === "review" ? `rv${f.reviewIdx}.${f.heroIds[0]}` : String(f.bossIdx);
  const w = (state.herd.wounds || {})[key];
  const wounds = Array.isArray(w) ? Math.round((w[0] || 0) * 100) : 0;
  const lessons = Math.round(Math.min(T.boss.lessonsCap, T.boss.lessonsPerFail * ((state.herd.lessons || {})[key] || 0)) * 100);
  // D§11.8 "Postmortem: 38% wounds kept · Lessons Learned +10% · retry in 10 working min",
  // split over the card's two lines
  return {
    title: `Postmortem · retry in ${Math.round(T.boss.retryWorkingSec / 60)} working min`,
    sub: `${wounds}% wounds kept · Lessons Learned +${lessons}%`,
  };
}

function bossTooltip(ctx, f, def) {
  const lines = [`${f.name} · Lv ${f.level}${f.kind === "backlog" ? ` · Backlog floor ${f.floor}` : ""}`];
  if (def && def.flavor) lines.push(def.flavor);
  if (def && def.enrage) lines.push(`Enrage at ${Math.round(T.boss.enrageAt * 100)}% of the timer: ${def.enrage.name}`);
  // f.t counts the ticks used (boss.js: one a questing tick), so the first number is what is left
  lines.push(`Timer: ${Math.max(0, f.timer - f.t)} of ${f.timer} ticks left (runs while someone is questing)`);
  let E = ctx.memo.est.get(f.key);
  if (E == null) {
    try {
      E = bossEstimate(ctx.world, f.kind, f.kind === "backlog" ? f.floor : f.bossIdx, f.heroIds, f.helpers);
    } catch (err) {
      E = 0;
    }
    if (!Number.isFinite(E)) E = 0;
    ctx.memo.est.set(f.key, E);
  }
  if (E > 0) lines.push(`Win estimate: ${E >= 1.2 ? "Favored" : E >= 0.95 ? "Even" : "Risky"} (${E.toFixed(2)})`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Rooms (D§9.2, D§11.2, D§11.3.3)
// ---------------------------------------------------------------------------------------------

/** The rooms: adjacent shown slots of one space and map (one room's heroes, {space, mapId, x, w, es}). */
function roomGroups(L) {
  const groups = [];
  for (const s of L.slots) {
    if (!s.shown) continue;
    const e = s.e;
    const space = e.live.space || "";
    const last = groups[groups.length - 1];
    if (last && last.space === space && last.mapId === e.mapId && Math.abs(last.x + last.w - s.x) < 0.5) {
      last.w += s.w;
      last.es.push(e);
      continue;
    }
    groups.push({ space, mapId: e.mapId, x: s.x, w: s.w, es: [e] });
  }
  return groups;
}

function buildRooms(ctx, L, fight, groups = roomGroups(L)) {
  const rooms = [];
  let prevZone = null;
  for (const g of groups) {
    const room = roomVM(ctx, g, L.w, prevZone);
    rooms.push(room);
    prevZone = room.zone;
  }
  if (fight && L.arena) rooms.push(arenaRoom(ctx, fight, L));
  return rooms;
}

function paletteOf(zone) {
  const p = zone.palette;
  const pal = { sky: p.sky, far: p.far, ground: p.ground, accent: p.accent };
  return { pal, bands: [0, 1, 2, 3].map((i) => mix(p.sky, p.far, i * 0.12)) };
}

function props(roomKey, zone, x, w, slotW, max) {
  const out = [];
  const sizes = PROP_SIZES[zone.id] || [[16, 32], [16, 32], [16, 32]];
  const slots = Math.max(1, Math.round(w / Math.max(1, slotW)));
  const n = Math.min(max, slots + 1);
  for (let s = 0; s < n; s++) {
    const k = (s % 3) + 1;
    const [pw, ph] = sizes[k - 1];
    const px = s === 0 ? x + 10 + pw / 2 : x + s * slotW - 8;
    if (px + pw / 2 > x + w) break;
    out.push({ key: `${roomKey}:p${s}`, sprite: `bg/${zone.id}-prop-${k}.svg`, x: r1(px), y: GROUND, w: pw, h: ph });
  }
  return out;
}

function roomVM(ctx, g, slotW, prevZone) {
  const { state, herd } = ctx;
  const zIdx = zoneOfMap(g.mapId);
  const zone = zoneDef(zIdx);
  const key = `room:${g.space || "-"}:${g.mapId}:${g.es[0].id}`;
  const { pal, bands } = paletteOf(zone);
  const map = MAP_BY_ID[g.mapId] || null;
  const backlog = g.mapId === "backlog";
  let quota = null;
  let sprint = null;
  let door = false;
  const frontier = herd.zone || 0;
  if (backlog) {
    const b = herd.backlog || { floor: 1, kills: 0 };
    quota = { have: Math.min(BACKLOG.killsPerFloor, b.kills || 0), need: BACKLOG.killsPerFloor };
  } else if (map) {
    const have = Math.min(T.quotaPerMap, (herd.quota || {})[map.id] || 0);
    const last = map.idx === zone.maps.length - 1;
    if (map.zone === frontier) {
      // the deepest open map of the frontier zone fills its quota bar; map 3 shows the Sprint meter
      const next = zone.maps[map.idx + 1];
      const deepest = !next || !mapUnlocked(state, next.id);
      if (deepest || have < T.quotaPerMap) quota = { have, need: T.quotaPerMap };
      if (last) sprint = { have: Math.floor(Math.min(herd.meter || 0, sprintTarget(zIdx))), need: sprintTarget(zIdx) };
    }
    if (last) door = doorOpen(state, zIdx);
  }
  const review = g.es.some((e) => ctx.reviews.has(e.id));
  const working = g.es.some((e) => WORKING_STATES[e.state]);
  const dusk = !working && g.es.every((e) => e.state === "resting" || e.state === "shipped");
  let title = backlog ? `${BACKLOG.name} · Floor ${backlogFloor(state)}` : map ? `${map.id} ${map.name}` : String(g.mapId);
  let shortTitle = backlog ? `BL F${backlogFloor(state)}` : `${ZONE_ABBR[zIdx] || "??"} ${g.mapId}`;
  if (review) {
    const f = ctx.reviews.get(g.es.find((e) => ctx.reviews.has(e.id)).id);
    title = `REVIEW · ${f.name}`;
    shortTitle = "REVIEW";
  }
  const lv = backlog ? "Lv 100+" : map ? `Lv ${map.levels[0]}–${map.levels[1]}` : "";
  const tip = [`${zone.name} · ${backlog ? `Floor ${backlogFloor(state)}` : map ? `${map.id} ${map.name}` : g.mapId}${lv ? ` (${lv})` : ""}`];
  if (quota) {
    tip.push(backlog ? `Floor ${quota.have}/${quota.need} kills to clear it`
      : `Quota ${quota.have}/${quota.need} kills${map && map.idx < zone.maps.length - 1 ? ` to open ${zone.maps[map.idx + 1].id}` : " for the boss door"}`);
  }
  if (sprint) tip.push(`Sprint ${sprint.have}/${sprint.need} Seals toward the boss door`);
  // The door icon is clickable only when the challenge would start (the engine refuses one while a
  // boss fight is on, during a Postmortem's retry wait, or with nobody working in the zone, and the
  // stage shows no command result): otherwise it stays a sign and the header says why.
  // (the same boss API world.command("challenge") asks: rt.bossApi when one is set, else boss.js)
  const api = ctx.rt.bossApi && typeof ctx.rt.bossApi.canChallenge === "function" ? ctx.rt.bossApi : null;
  const can = door && BOSSES[zIdx] ? (api ? api.canChallenge(ctx.world, "boss", zIdx) : canChallenge(ctx.world, "boss", zIdx)) : null;
  if (door && BOSSES[zIdx]) tip.push(`Boss door open: ${BOSSES[zIdx].name}${can && !can.ok && can.error ? ` (${can.error})` : ""}`);
  // D§11.16: a header click pins the room's heroes to this map (unpins them when all already are);
  // the door icon challenges the zone's boss
  const pin = pinVM(g);
  const mapName = g.mapId === "backlog" ? BACKLOG.name : g.mapId;
  const who = pin && pin.heroIds.length === 1 ? "this hero" : "these heroes";
  if (pin) tip.push(pin.pinned ? `Pinned: ${who} stay${pin.heroIds.length === 1 ? "s" : ""} on ${mapName} · click to unpin (back to auto map choice)` : `Click: keep ${who} on ${mapName}`);
  const challenge = can && can.ok
    ? { kind: "boss", idx: zIdx, tooltip: `${BOSSES[zIdx].name}: the boss door is open\nClick to challenge` } : null;
  const stats = [quota ? `${quota.have}/${quota.need}` : null, sprint ? `Sprint ${sprint.have}/${sprint.need}` : null].filter(Boolean).join(" · ");
  const vm = {
    key, x: r1(g.x), w: r1(g.w), zone: zone.id, mapId: g.mapId, title, shortTitle,
    palette: pal, skyBands: bands, quota, sprint, door, working, dusk, review,
    dividerLeft: prevZone !== null && prevZone !== zone.id,
    props: props(key, zone, g.x, g.w, slotW, 3),
    tooltip: tip.join("\n"),
    pin, challenge,
  };
  if (stats) vm.stats = stats;
  return vm;
}

/**
 * The room header's click (D§11.16): {heroIds, mapId} runs pinMap for each hero; mapId null
 * unpins (every hero here is already pinned to this map). Contractors (not on the roster) and
 * rooms without a real map have none.
 */
function pinVM(g) {
  if (g.mapId !== "backlog" && !MAP_BY_ID[g.mapId]) return null;
  const list = g.es.filter((e) => !e.hero.contractor && e.id > 0);
  if (!list.length) return null;
  const all = list.every((e) => e.hero.pinMap === g.mapId);
  // pinned: every hero here stays on this map (the header draws a pin; a click unpins)
  return { heroIds: list.map((e) => e.id), mapId: all ? null : g.mapId, pinned: all };
}

function arenaRoom(ctx, fight, L) {
  const f = fight.f;
  const zone = f.kind === "backlog" ? BACKLOG : zoneDef(BOSSES[f.bossIdx] ? BOSSES[f.bossIdx].zone : 0);
  const { pal, bands } = paletteOf(zone);
  const a = L.arena;
  const key = `room:arena:${f.key}`;
  const mapId = zone.id === "backlog" ? "backlog" : zone.maps[zone.maps.length - 1].id;
  return {
    key, x: r1(a.x), w: r1(a.w), zone: zone.id, mapId,
    title: `${zone.name} · ${f.name}`, shortTitle: "BOSS",
    palette: pal, skyBands: bands, quota: null, sprint: null, door: false, working: !fight.ended, dusk: false,
    review: false, dividerLeft: true, props: props(key, zone, a.x, a.w, a.w, 1),
    tooltip: `${zone.name} · boss arena\n${f.name} · Lv ${f.level}`,
    pin: null, challenge: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Header band messages
// ---------------------------------------------------------------------------------------------

function headerNote(rt) {
  const tick = rt.tick;
  for (const n of rt.notes || []) {
    if (n.showTick <= tick && tick < n.showTick + 3) return { key: n.key, text: String(n.text), color: hexOr(n.color, COL.cream) };
  }
  return null;
}

/** Herd-first boss kills only (rt.banner also carries fight entrances, shown in the arena). */
function herdBanner(rt) {
  const b = rt.banner;
  if (!b || !/^The herd reached/.test(String(b.text))) return null;
  return { key: b.key, text: b.sub ? `${b.text} · ${b.sub}` : String(b.text) };
}

// ---------------------------------------------------------------------------------------------
// Effects (ARCHITECTURE §6.2 two-tick pattern; D§11.6-11.8)
// ---------------------------------------------------------------------------------------------

function buildFx(ctx, fxs, heroPos, mobPos, chestPos, boss) {
  const { calm, nums, state } = ctx;
  const out = [];
  const stack = new Map(); // `${target}|${age}` -> numbers placed so far
  const boxes = []; //        text floats placed so far: neighbouring targets' numbers must not overlap
  const pillars = new Map();
  for (const { f, age } of fxs) {
    const kind = f.kind;
    if (NUM_KINDS[kind] && (calm || nums === "off" || (nums === "crits" && kind !== "crit"))) continue;
    if (calm && CALM_DROPS[kind]) continue;
    // loot glow minimum rarity (D§11.15): a drop below it neither glows its way to the finder nor
    // raises a pillar (a pillar's rarity is LTS or better; one without a rarity counts as LTS)
    if ((kind === "loot" && (Number(f.rar) || 0) < ctx.glow) || (kind === "pillar" && (Number.isFinite(f.rar) ? f.rar : 4) < ctx.glow)) continue;
    if (kind === "stamp") continue; // BossVM.stamp draws the FIXED stamp
    const hp = f.heroId != null ? heroPos.get(f.heroId) : null;
    if (hp && hp.closing && f.roomId !== "arena" && (NUM_KINDS[kind] || kind === "poof" || kind === "skill" || kind === "coin")) continue;
    let mp = f.mobUid != null ? mobPos.get(f.mobUid) || memoPos(ctx, f.mobUid) : null;
    // a mob we never saw (killed before the first view of this world): the front of the lane
    if (!mp && f.mobUid != null && hp) mp = { x: hp.front.x, top: hp.front.top, showHp: false, mid: hp.front.top + 20 };
    let x;
    let y;
    let dx = 0;
    let dy = 0;
    let color = COL.cream;
    let text = f.text == null ? "" : String(f.text);
    if (NUM_KINDS[kind]) {
      if (kind === "incoming") {
        if (!hp) continue;
        x = hp.x + 4; y = hp.head + 14; dx = -10; dy = 18; color = COL.hp;
      } else if (kind === "heal" && hp) {
        x = hp.x - 4; y = hp.head - 6; dy = -24; color = COL.heal;
      } else if (mp) {
        x = mp.x; y = mp.top - (mp.showHp ? 16 : 9); dx = kind === "crit" ? 6 : 4; dy = -28;
        // in the arena, numbers start below the boss HUD plate (y 17–62 on a 200 px stage)
        if (f.roomId === "arena") y = Math.max(y, ARENA_NUM_Y);
        color = kind === "crit" ? COL.crit : kind === "heal" ? COL.heal : kind === "abs" ? COL.abs : kind === "num" ? COL.num : COL.cream;
      } else if (hp) {
        x = hp.x + 12; y = hp.head - 4; dx = 6; dy = -24; color = COL.cream; // a dodge on the hero side
      } else continue;
      if (kind !== "incoming") {
        // several numbers on one target in one tick fan out instead of stacking; every target in
        // the arena (the boss and its parts stand close together) shares one fan
        const sk = `${f.roomId === "arena" ? "arena" : f.mobUid != null ? f.mobUid : `h${f.heroId}`}|${age}`;
        const n = stack.get(sk) || 0;
        stack.set(sk, n + 1);
        const fan = FAN[n % FAN.length];
        x += fan[0];
        y += fan[1];
      }
    } else {
      switch (kind) {
        case "poof":
          if (!mp) continue;
          x = mp.x; y = mp.mid; dy = -10;
          break;
        case "coin":
        case "loot": {
          const from = mp || (f.roomId === "arena" && boss ? { x: boss.x, mid: GROUND - 30 } : null) || chestPos.get(f.heroId) && { x: chestPos.get(f.heroId).x, mid: GROUND - 16 } || null;
          if (!from && !hp) continue;
          const src = from || { x: hp.x + 18, mid: GROUND - 20 };
          x = src.x; y = src.mid;
          if (hp) { dx = hp.x - x; dy = hp.head + 20 - y; } else { dy = -20; }
          color = kind === "coin" ? COL.coin : hexOr((RARITIES[f.rar] || RARITIES[0]).color, COL.cream);
          text = "";
          break;
        }
        case "skill":
          if (mp) { x = mp.x; y = mp.top - 12; } else if (hp) { x = hp.x; y = hp.head - 16; } else continue;
          dy = -18;
          color = f.value >= 0 && f.value < 7 && f.heroId != null && text !== "10x" && text !== "Rollback" ? classColor(ctx, f.heroId) : COL.cream;
          break;
        case "coffee":
          if (!hp) continue;
          x = hp.x + 16; y = hp.head - 2; dy = -14;
          break;
        case "unblocked":
          if (!hp) continue;
          x = hp.x; y = hp.head - 20; dy = -22; text = text || "Unblocked";
          break;
        case "levelup":
          if (!hp) continue;
          x = hp.x; y = GROUND; color = COL.xp; text = text || "LEVEL UP";
          break;
        case "pillar": {
          // a light column where the drop landed: beside the finder, or before the boss; several
          // in one tick stand side by side
          const r = RARITIES[f.rar] || RARITIES[4];
          const arena = f.roomId === "arena" && boss;
          if (arena) x = boss.x - boss.w / 2 - 30;
          else if (hp) x = hp.x + 26;
          else continue;
          const n = pillars.get(`${arena ? "arena" : f.heroId}|${age}`) || 0;
          pillars.set(`${arena ? "arena" : f.heroId}|${age}`, n + 1);
          x += (arena ? -52 : 52) * n;
          y = GROUND; color = hexOr(r.color, COL.cream); text = r.name;
          break;
        }
        case "ship": {
          const c = chestPos.get(f.heroId);
          if (!c && !hp) continue;
          x = c ? c.x : hp.x + 30; y = (c ? c.top : GROUND - 30) - 10; dy = -24; color = COL.done; text = text || "SHIPPED";
          break;
        }
        default:
          continue;
      }
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (TEXT_SIZE[kind]) {
      // short stages: the renderer lifts the scene by (H − 200), so floats keep below its header band
      const minY = 28 + Math.max(0, 200 - ctx.H);
      y = dodge(boxes, kind, text, x, Math.max(y, minY), age, f.roomId === "arena" ? 1 : -1, minY);
    }
    const vm = {
      key: f.key, kind, x: r1(x), y: r1(y), text, color, age,
      dx: r1(Number.isFinite(dx) ? dx : 0), dy: r1(Number.isFinite(dy) ? dy : 0), size: null,
    };
    // D§11.16: a loot pillar opens the finder's sheet on that item's compare card
    if (kind === "pillar" && f.heroId != null && f.heroId > 0 && Number.isFinite(f.value) && findHero(ctx.world, f.heroId)) {
      vm.sheet = { heroId: f.heroId, itemUid: f.value };
    }
    out.push(vm);
  }
  return out;
}

const ARENA_NUM_Y = 74;
// Font size of each text float as ui/stage.js draws it (mono: a glyph is 0.6 em wide).
const TEXT_SIZE = { num: 11, crit: 13, heal: 11, miss: 11, inv: 11, abs: 11, incoming: 9, skill: 10, unblocked: 11, ship: 11 };

/**
 * Moves a text float (centred at x, y) up (dir -1) or down (dir 1) a row at a time until its pill
 * clears every float of the same age placed before it, at most 4 rows; records its box.
 */
function dodge(boxes, kind, text, x, y, age, dir, minY) {
  const size = TEXT_SIZE[kind];
  const w = String(text).length * size * 0.6 + 8 + (kind === "crit" ? 22 : 0);
  const h = size + 5;
  const hit = (yy) => boxes.some((b) => b.age === age && Math.abs(b.x - x) < (b.w + w) / 2 + 2 && Math.abs(b.y - yy) < (b.h + h) / 2 + 1);
  let yy = y;
  if (hit(yy)) {
    // the preferred direction first, then the other one; never above minY (the header band)
    let found = null;
    for (const d of [dir, -dir]) {
      for (let i = 1; i <= 4 && found == null; i++) {
        const c = y + d * i * (h + 2);
        if (c >= minY && !hit(c)) found = c;
      }
      if (found != null) break;
    }
    if (found != null) yy = found;
  }
  boxes.push({ x, y: yy, w, h, age });
  return yy;
}
// [dx, dy] of the n-th number on one target in one tick: number pills are 16 px tall and up to
// ~56 px wide, so neighbours sit a full row apart or side by side
const FAN = [[0, 0], [-30, 17], [30, 17], [0, 34], [-30, 51], [30, 51], [0, 68]];

function memoPos(ctx, uid) {
  const m = ctx.wm.mobs.get(`mob:${uid}`);
  return m && ctx.tick - m.tick <= 2 ? m.pos : null;
}

function classColor(ctx, heroId) {
  const e = ctx.byId.get(heroId);
  const cls = e ? (CLASSES[e.hero.cls] || CLASSES[0]).id : "intern";
  return hexOr(CLASS_COLORS[cls], COL.cream);
}

/** Exposed for tests: drop a world's remembered layout state. */
export function _resetStageMemo(world) {
  if (world) MEMO.delete(world);
}

export const _internal = { arenaShape, widths, whyText, SLOT_MIN, ARENA_GAP, MAX_SLOTS };
