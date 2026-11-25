// Shared engine fixtures for tests (combat, boss, world, view...). Pure Node ESM; no herdr mocks
// needed (game/ never imports herdr). Other test files may import this read-only: keep the API
// below stable.
//
//   makeWorld({heroes, nowMs, seed, herd}) -> world {state, rt}   (state from save.newState)
//   addHero(world, spec)                   -> {hero, live}         (also binds a Live in rt.live)
//   makeLive(hero, overrides)              -> Live (ARCHITECTURE §3.2), not registered anywhere
//   makeEv()                               -> recording emitter {fx, note, banner, major, journal, calls, ...}
//   refKit(state, hero, opts)              -> equips the D§5.2 reference kit on a hero
//   stepWorld(world, ev, n)                -> runs n engine steps (rooms, fights, rest) like world.tick
//   heroOf(world, id) / liveOf(world, id)
//   findRefs(root, id)                     -> paths where a hero id is still referenced (round 4b)
//
// Hero spec (addHero / makeWorld heroes[]): {cls ("intern" | id | index, default intern),
//   L (1), mapId ("1-1"), state ("questing" | "waiting" | "shipped" | "resting" | "supervising"),
//   space ("s1"), kit ("ref" | "none", default "ref"), rev ([L>=30, L>=60] as 0|1), ranks ("auto"
//   | array of 7), live ({...Live overrides}), hero ({...Hero overrides}), order (slot order)}.

import { newState } from "../../mods/down-the-stack/game/save.js";
import { newHero, autoRanks, stats } from "../../mods/down-the-stack/game/heroes.js";
import { baseIdFor } from "../../mods/down-the-stack/game/items.js";
import { CLASSES, CLASS_IDX, RARITIES, AFFIX_IDX, TUNING as T } from "../../mods/down-the-stack/game/data.js";
import { itemTier, iRef } from "../../mods/down-the-stack/game/formulas.js";
import * as Combat from "../../mods/down-the-stack/game/combat.js";
import * as Boss from "../../mods/down-the-stack/game/boss.js";

export const T0 = 1_790_000_000_000; // a fixed epoch for tests (2026)

const STATUS_OF = { questing: "working", supervising: "idle", waiting: "blocked", shipped: "done", resting: "idle" };

/** A world {state, rt} with heroes built from specs (see the header). */
export function makeWorld({ heroes = [], nowMs = T0, seed = 1, herd = {} } = {}) {
  const state = newState({ nowMs, seed });
  Object.assign(state.herd, herd);
  const rt = {
    tick: 0, nowMs, version: 0,
    bind: new Map(), live: new Map(), contractors: new Map(),
    rooms: [], fights: [], fx: [], notes: [], banner: null,
    dirty: false, majorAt: 0, lastSaveMs: nowMs, errors: [],
  };
  const world = { state, rt };
  heroes.forEach((spec, i) => addHero(world, Object.assign({ order: i }, spec)));
  return world;
}

function clsIndex(cls) {
  if (cls == null) return 0;
  if (typeof cls === "number") return cls;
  const i = CLASS_IDX[cls];
  if (i == null) throw new Error(`unknown class ${cls}`);
  return i;
}

/** Creates a roster hero from a spec, equips its kit, learns its skills and binds a Live. */
export function addHero(world, spec = {}) {
  const { state, rt } = world;
  const ord = state.heroes.length;
  const hero = newHero(state, { seat: spec.seat || "repo/claude", sid: spec.space || "s1", ord, nowMs: rt.nowMs });
  const L = spec.L || 1;
  hero.L = L;
  hero.cls = clsIndex(spec.cls);
  hero.prov = 0;
  hero.rev = spec.rev ? spec.rev.slice() : [L >= 30 ? 1 : 0, L >= 60 ? 1 : 0];
  if (Array.isArray(spec.ranks)) hero.sp = spec.ranks.slice();
  else hero.sp = autoRanks(hero.cls, L, true).slice();
  hero.spFree = 0;
  if (spec.hero) Object.assign(hero, spec.hero);
  state.heroes.push(hero);
  if ((spec.kit || "ref") === "ref") refKit(state, hero, spec.kitOpts);
  const st = stats(hero, { herd: state.herd });
  const live = makeLive(hero, Object.assign({
    address: spec.address || `t${hero.id}`,
    state: spec.state || "questing",
    space: spec.space || "s1",
    mapId: spec.mapId || "1-1",
    order: spec.order ?? ord,
    maxHp: st.maxHp,
    hp: st.maxHp * (hero.hpFrac ?? 1),
  }, spec.live || {}));
  rt.live.set(hero.id, live);
  rt.bind.set(live.address, hero.id);
  return { hero, live };
}

/** A Live record (ARCHITECTURE §3.2) for a hero with sensible defaults; not registered. */
export function makeLive(hero, overrides = {}) {
  const state = overrides.state || "questing";
  const live = {
    address: `t${hero.id}`, status: STATUS_OF[state] || "working", seq: 1, statusSince: 0, state,
    focused: false, pinned: false,
    program: { key: "claude", name: "Claude", icon: null, tint: false, tile: null, color: null },
    app: "claude", title: "", space: "s1", spaceName: "repo", tab: "tab1", tabName: "main", pane: `p${hero.id}`,
    paneName: "", task: null, blockedSince: 0, bubbleShown: false, forklings: [], flap: [],
    hp: 0, maxHp: 0, buffs: [], cds: {}, actionCount: 0, bisect: { target: null, stacks: 0 },
    crashedUntil: 0, lastCupTick: -999, mapId: "1-1", lane: [], engagedUid: null, statsCache: null, crashes: [],
    order: 0,
  };
  return Object.assign(live, overrides);
}

/**
 * A recording emitter with the shape world.tick passes down ({fx, note, banner, major, journal}).
 * Every call lands in `calls` as {type, ...}; fx also in `fxs` as {kind, ...data}. No budgets.
 */
export function makeEv() {
  const ev = {
    calls: [], fxs: [], notes: [], banners: [], journals: [], majors: 0,
    fx(kind, data = {}) {
      const f = Object.assign({ kind }, data);
      ev.calls.push(Object.assign({ type: "fx" }, f));
      ev.fxs.push(f);
    },
    // (tag: what the note is about and its short forms, round 4b / 4c; world.pushNote)
    note(text, color, tag) { ev.calls.push({ type: "note", text, color, tag }); ev.notes.push(text); },
    /** The tag of the first note whose text passes `test` (a RegExp or a string to match exactly). */
    noteTag(test) {
      const c = ev.calls.find((x) => x.type === "note" && (test instanceof RegExp ? test.test(x.text) : x.text === test));
      return c ? c.tag : undefined;
    },
    banner(text, sub) { ev.calls.push({ type: "banner", text, sub }); ev.banners.push({ text, sub }); },
    major() { ev.calls.push({ type: "major" }); ev.majors++; },
    journal(kind, heroId, text, value) {
      ev.calls.push({ type: "journal", kind, heroId, text, value });
      ev.journals.push([kind, heroId, text, value]);
    },
    /** fx of one kind (optionally of one hero). */
    fxOf(kind, heroId) { return ev.fxs.filter((f) => f.kind === kind && (heroId == null || f.heroId === heroId)); },
    /** Forget everything recorded so far. */
    clear() {
      ev.calls.length = 0; ev.fxs.length = 0; ev.notes.length = 0; ev.banners.length = 0; ev.journals.length = 0;
      ev.majors = 0;
    },
  };
  return ev;
}

// Roll 0..99 that makes an affix worth `want` at tier t, or -1 when the affix can't get near it.
function rollFor(affixId, want, t) {
  const a = { memo: [0.02, 0.04], lint: [0.01, 0.02], robust: [0.03, 0.06], typed: [0.04, 0.08] }[affixId];
  const lo = a[0] * t;
  const hi = a[1] * t;
  if (want < 0.75 * lo) return -1;
  return Math.max(0, Math.min(99, Math.round(((want - lo) / (hi - lo)) * 99)));
}

/**
 * Equips the D§5.2 reference kit: every slot at iRef(L) = max(1, L - 2) with rarity x polish equal
 * to R_ref x P_ref (polish may be fractional: it is a fixture), damage affix ~0.003 L on the
 * weapon, crit ~0.0005 L on the hat, max HP ~0.003 L on the hoodie and armor ~0.002 L on the boots
 * (each only when an affix can roll that low). Interns get a Training Stick at that level.
 * @param {{rar?:number, uidBase?:number}} [opts]
 */
export function refKit(state, hero, opts = {}) {
  const L = hero.L;
  const i = iRef(L);
  const t = itemTier(i);
  const R = T.ref;
  const target = (1 + R.rarityPerL * L) * (1 + R.polishPerL * L);
  const rar = opts.rar ?? (L < 10 ? 0 : L < 25 ? 1 : L < 45 ? 2 : 3);
  const pol = Math.max(0, (target / RARITIES[rar].mult - 1) / T.polish.perLevel);
  const cls = CLASSES[hero.cls] || CLASSES[0];
  const mk = (slot, aff) => {
    const base = slot === "weapon" ? (hero.cls === 0 ? 0 : baseIdFor("weapon", t, cls.weapon)) : baseIdFor(slot, t, slot);
    const herd = state.herd;
    if (!(herd.nextUid >= 1)) herd.nextUid = 1;
    return { uid: herd.nextUid++, base, ilvl: i, rar, pol, aff, flags: 0, prop: -1 };
  };
  const one = (id, want) => {
    const r = rollFor(id, want, t);
    return r < 0 ? [] : [[AFFIX_IDX[id], r]];
  };
  hero.eq = [
    mk("weapon", one("memo", R.dmgPerL * L)),
    mk("hat", one("lint", R.critPerL * L)),
    mk("hoodie", one("robust", R.hpPerL * L)),
    mk("mug", []),
    mk("boots", one("typed", R.armorPerL * L)),
    null,
  ];
  return hero.eq;
}

/** Roster hero (or contractor) by id. */
export function heroOf(world, id) {
  for (const h of world.state.heroes) if (h.id === id) return h;
  for (const h of world.rt.contractors.values()) if (h.id === id) return h;
  return null;
}

/** Live record of a hero id. */
export function liveOf(world, id) {
  return world.rt.live.get(id) || null;
}

/**
 * Runs n engine steps the way world.tick's inner loop does (D§2.11): advance the clock, rebuild
 * rooms, stepRoom every room, stepFight every fight (finished fights are removed), restTick every
 * shipped/resting hero. Returns the results of finished fights [{fight, result}].
 */
export function stepWorld(world, ev, n = 1) {
  const { rt, state } = world;
  const done = [];
  for (let k = 0; k < n; k++) {
    rt.tick++;
    rt.nowMs += T.tickMs;
    state.herd.tick = rt.tick;
    state.herd.lastMs = rt.nowMs;
    rt.rooms = Combat.buildRooms(world);
    for (const room of rt.rooms) Combat.stepRoom(world, room, ev);
    for (const f of rt.fights.slice()) {
      const r = Boss.stepFight(world, f, ev);
      if (r !== "running") {
        done.push({ fight: f, result: r });
        const at = rt.fights.indexOf(f);
        if (at >= 0) rt.fights.splice(at, 1);
      }
    }
    for (const [id, live] of rt.live) {
      if (live.state === "shipped" || live.state === "resting") Combat.restTick(world, heroOf(world, id), live);
    }
  }
  return done;
}

/**
 * Every place a hero id is still referenced in a value graph (a world, its state and rt): the id as
 * a number anywhere (values, array items, Map keys, Set members) and as a token in a string or an
 * object key ("rv0.-7", "room:s1:1-1:-7"; a token: not part of a longer number). Returns the paths
 * found, e.g. ["world.state.herd.wounds.rv0.-7 (key)"]. Pick an id no other number shares.
 */
export function findRefs(root, id, rootName = "world") {
  const hits = [];
  const seen = new Set();
  const re = new RegExp(`(^|[^0-9])${String(id).replace("-", "\\-")}($|[^0-9])`);
  const isRef = (v) => v === id || (typeof v === "string" && re.test(v));
  const walk = (v, path) => {
    if (isRef(v)) { hits.push(typeof v === "string" ? `${path} = ${JSON.stringify(v)}` : path); return; }
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Map) {
      for (const [k, x] of v) {
        if (isRef(k)) hits.push(`${path}<key ${String(k)}>`);
        walk(x, `${path}<${String(k)}>`);
      }
      return;
    }
    if (v instanceof Set) {
      for (const x of v) walk(x, `${path}{}`);
      return;
    }
    for (const k of Object.keys(v)) {
      if (isRef(k)) hits.push(`${path}.${k} (key)`);
      walk(v[k], `${path}.${k}`);
    }
  };
  walk(root, rootName);
  return hits;
}
