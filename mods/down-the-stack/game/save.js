// Save format (D§13): world.state <-> one compact JSON text with a CRC32.
//
//   encodeState(state) -> text        decodeState(text) -> {state, warning, readOnly}
//   crc32(str) -> "xxxxxxxx"          newState({nowMs, seed}) -> a fresh world.state
//
// Readable state keys map to short compact keys (D§13.2 shape, shortened further to meet the
// 30 KB budget of D§13.3). Items become arrays
//   [uid, baseId, iLvl, rarity, polish, [affixId, roll, affixId, roll, ...], flags, propertyId]
// with trailing defaults left out (uid kept so references survive a reload, written as the
// difference from the previous item's uid in its list; affixes stored explicitly, never
// regenerated). Strings used more than once go into a top-level string table "str" and are
// written as their index: seats, space ids and pane/tab names shared by several heroes,
// pending-chest titles (an agent's tasks often share a title, and every hero can hold 20 chests)
// and the journal's kinds and texts. A save from before the table held titles and journal strings
// writes them inline; both read back the same. Journal timestamps are deltas between entries; hero
// seen, pending-chest and boss-cooldown times and digestAt are relative to the top-level lastMs.
// Missing fields encode as their default and fields equal to their default are left out, so
// encode(decode(encode(s))) is byte-identical to encode(s).
// Fields this file does not know (added by other engine modules) are kept: they are written under
// "x" of their object with their readable names and restored on load. Keys starting with "_" are
// runtime-only and never saved. Non-integer numbers are stored with 6 decimals (integers, RNG
// states and timestamps exactly).
//
// herd.inbox (chest items waiting to be offered) uses the stash's item rows under herd.ib.
//
// Corrupt input throws an Error with .code "parse" | "shape" | "crc" (the host then tries
// save.bak, D§13.1); a byte-order mark or whitespace around the JSON is not corruption. A save
// from a newer schema version loads read-only (result.readOnly).

import {
  GEN, BADGES, BADGE_IDX, MAPS, MAP_BY_ID, BASE_LIST, AFFIXES, LTS_PROPS, KEEPSAKES, CLASSES, SLOTS, ZONES, BUILDINGS,
  BOSSES, TUNING as T,
} from "./data.js";
import { itemTier } from "./formulas.js";
import { seedOf } from "./rng.js";
import { baseIdFor } from "./items.js";

/** Current schema version. migrations[v] upgrades a compact save from v to v + 1. */
export const SAVE_VERSION = 1;

/** Pure functions save_v -> save_v+1 on the compact object; [0] lifts unversioned saves to v1. */
export const migrations = [
  (s) => s, // v0 (no "v") -> v1: identity
];

const AUTO_KEYS = ["equip", "deprecate", "learn", "polish", "buildings", "maps", "boss", "farm", "calls", "career"];
const NOTIFY_KEYS = ["boss", "lts", "principal"];
const NUMS = ["off", "crits", "all"];
const SIZE_BUDGET = 30 * 1024;

/**
 * Test seam (test/save.test.mjs): olderBuild true reads and writes the town's fields (docs/TOWN.md
 * §8: herd extras "town", st extras "tw") as plain extras, exactly as a build before the town did,
 * so the tests can show such a build keeps them through a load and a save.
 */
export const _compat = { olderBuild: false };

// ---------------------------------------------------------------------------------------------
// CRC32 (IEEE, over UTF-8 bytes) and base64
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crcByte(crc, b) {
  return CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
}

/** CRC32 of the UTF-8 bytes of `str`, as 8 lowercase hex digits. */
export function crc32(str) {
  let crc = 0xffffffff;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) crc = crcByte(crc, c);
    else if (c < 0x800) {
      crc = crcByte(crc, 0xc0 | (c >> 6));
      crc = crcByte(crc, 0x80 | (c & 63));
    } else if (c < 0x10000) {
      crc = crcByte(crc, 0xe0 | (c >> 12));
      crc = crcByte(crc, 0x80 | ((c >> 6) & 63));
      crc = crcByte(crc, 0x80 | (c & 63));
    } else {
      crc = crcByte(crc, 0xf0 | (c >> 18));
      crc = crcByte(crc, 0x80 | ((c >> 12) & 63));
      crc = crcByte(crc, 0x80 | ((c >> 6) & 63));
      crc = crcByte(crc, 0x80 | (c & 63));
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64encode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

function b64decode(str) {
  const s = String(str || "").replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = [];
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1] || "A") << 12) |
      ((s[i + 2] ? B64.indexOf(s[i + 2]) : 0) << 6) | (s[i + 3] ? B64.indexOf(s[i + 3]) : 0);
    bytes.push((n >> 16) & 255);
    if (s[i + 2]) bytes.push((n >> 8) & 255);
    if (s[i + 3]) bytes.push(n & 255);
  }
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------

const zeros = (n) => new Array(n).fill(0);

function defaultCfg() {
  const auto = {};
  for (const k of AUTO_KEYS) auto[k] = true;
  const notify = {};
  for (const k of NOTIFY_KEYS) notify[k] = false;
  // autopilot: the master switch over auto.* (formulas.autoOn); glow: loot glow minimum rarity
  // (0 = every drop glows); collapse: hide the stage while nothing works; collapsed: the host hid
  // it itself and owes a layout.show (host.js stageAuto). D§11.15.
  return { auto, calm: false, stageH: 200, nums: "all", notify, autopilot: true, glow: 0, collapse: false, collapsed: false };
}

/** A fresh Herd (ARCHITECTURE §3.2) with every field at its default. */
export function defaultHerd({ nowMs = 0, seed = 1 } = {}) {
  return {
    name: "The Herd", gold: 0, snip: 0, bld: zeros(BUILDINGS.length), zone: 0, quota: {}, meter: 0, bank: 0,
    seals: 0, rel: 0, boss: zeros(BOSSES.length), bossKills: zeros(BOSSES.length), fight: null, wounds: {},
    lessons: {}, bt: zeros(ZONES.length), badges: [], stash: [], fame: [], backlog: { floor: 0, kills: 0 },
    digestAt: 0, cfg: defaultCfg(), log: [], nextUid: 1, nextHeroId: 1, rng: seedOf(seed), day: 0,
    lastMs: nowMs, tick: 0,
    // agents.js / herd.js: heroes hired today [day, n] (D§3.4), Pair Programmer seconds and Holo
    // Rubber Duck kills (D§10.6)
    hired: [0, 0], pairSec: 0, ducks: 0,
    // world.js: opt-in notifications (D§11.15): [local day, raised that day, last sequence number]
    // and the milestones raised but not yet taken by the host
    notified: [0, 0, 0], milestones: [],
    // agents.js (round 5): slim Contractor records whose agent is away (agents.contractorRecords;
    // world.serialize adds the live Contractors' records when it writes the save)
    contractors: [],
  };
}

/** A fresh world.state: { v, gen, herd, heroes: [] }. */
export function newState({ nowMs = 0, seed = 1 } = {}) {
  return { v: SAVE_VERSION, gen: GEN, herd: defaultHerd({ nowMs, seed }), heroes: [] };
}

// ---------------------------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------------------------

/** Compact number: integers exact, others to 6 decimals; non-finite -> 0. */
function q(x) {
  if (typeof x !== "number") return x;
  if (!Number.isFinite(x)) return 0;
  if (Number.isInteger(x)) return x === 0 ? 0 : x;
  if (Math.abs(x) >= 1e9) return Math.round(x);
  const r = Math.round(x * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

/** JSON-safe deep copy with compact numbers; drops undefined, functions and "_" keys. */
function qDeep(v) {
  if (typeof v === "number") return q(v);
  if (v === null || typeof v !== "object") return typeof v === "function" || v === undefined ? null : v;
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : qDeep(x)));
  const o = {};
  for (const k of Object.keys(v)) {
    if (k[0] === "_" || v[k] === undefined || typeof v[k] === "function") continue;
    o[k] = qDeep(v[k]);
  }
  return o;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const numOr = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const strOr = (v, d) => (typeof v === "string" ? v : v == null ? d : String(v));

function intList(v, n) {
  const out = zeros(n);
  if (Array.isArray(v)) for (let i = 0; i < n; i++) out[i] = q(numOr(v[i], 0));
  return out;
}

// Fixed-length number lists are written without their trailing zeros ([8, 4, 1] for [8, 4, 1, 0, 0, 0, 0]).
function trimZeros(list) {
  let n = list.length;
  while (n > 0 && list[n - 1] === 0) n--;
  return list.slice(0, n);
}

// A field: [readableKey, compactKey, codec].
// Codec = { enc(v, ctx) -> compact, dec(c, ctx) -> readable, def() -> readable default }.
const C = {
  num: (d) => ({ enc: (v) => q(numOr(v, d)), dec: (c) => numOr(c, d), def: () => d }),
  str: (d) => ({ enc: (v) => strOr(v, d), dec: (c) => strOr(c, d), def: () => d }),
  bool: (d) => ({ enc: (v) => (v ? 1 : 0), dec: (c) => !!c, def: () => d }),
  flag: (d) => ({ enc: (v) => (v ? 1 : 0), dec: (c) => (c ? 1 : 0), def: () => d }),
  ints: (n) => ({ enc: (v) => trimZeros(intList(v, n)), dec: (c) => intList(c, n), def: () => zeros(n) }),
  // times stored relative to the save's lastMs (lossless for any unit; short for recent epoch ms)
  time: (d) => ({
    dyn: true,
    enc: (v, ctx) => q(numOr(v, d) - ((ctx && ctx.base) || 0)),
    dec: (c, ctx) => numOr(c, 0) + ((ctx && ctx.base) || 0),
    def: () => d,
  }),
  // strings shared by several heroes (seat, space id) go to the top-level table "str" (by index)
  strRef: () => ({
    enc: (v, ctx) => {
      if (typeof v === "string") return ctx && ctx.strIdx && ctx.strIdx.has(v) ? ctx.strIdx.get(v) : v;
      return v == null ? null : [qDeep(v)];
    },
    dec: (c, ctx) => decText(c, ctx), // the same reading as a free-text slot's (below)
    def: () => null,
  }),
  json: (d) => ({ enc: (v) => qDeep(v), dec: (c) => (c === undefined ? d() : c), def: d }),
};

// A free-text string slot (a pending chest's title, a journal kind or text): a string in the
// table is its index, any other string itself, null stays null, any other value is boxed ([v]) so
// it never reads back as an index. Saves from before the table held these slots wrote strings
// and null only, which read back unchanged.
function encText(v, ctx) {
  if (v == null) return null;
  if (typeof v === "string") return ctx && ctx.strIdx && ctx.strIdx.has(v) ? ctx.strIdx.get(v) : v;
  return [qDeep(v)];
}
function decText(c, ctx) {
  if (typeof c === "number") return ctx && ctx.table && typeof ctx.table[c] === "string" ? ctx.table[c] : "";
  return Array.isArray(c) ? c[0] : c;
}

// Encoded default of each codec, as JSON, so fields equal to their default can be left out
// (decoding restores the default, so re-encoding leaves them out again: still byte-identical).
const defaultJson = new Map();
function encodedDefault(codec, ctx) {
  if (codec.dyn) return JSON.stringify(codec.enc(codec.def(), ctx));
  if (!defaultJson.has(codec)) defaultJson.set(codec, JSON.stringify(codec.enc(codec.def())));
  return defaultJson.get(codec);
}

// xCodecs (optional Map readableKey -> {enc, dec}): extras keys with an encoding of their own
// (herd.town, docs/TOWN.md §8); enc returning undefined leaves the key out (a town at zero)
function encFields(src, fields, ctx, extrasKey = "x", xCodecs = null) {
  const out = {};
  const known = new Set();
  for (const [rk, ck, codec] of fields) {
    known.add(rk);
    const v = src[rk] === undefined ? codec.def() : src[rk];
    const c = codec.enc(v, ctx);
    if (JSON.stringify(c) !== encodedDefault(codec, ctx)) out[ck] = c;
  }
  const x = {};
  let any = false;
  for (const k of Object.keys(src)) {
    if (known.has(k) || k[0] === "_" || src[k] === undefined || typeof src[k] === "function") continue;
    const xc = xCodecs && !_compat.olderBuild ? xCodecs.get(k) : null;
    const c = xc ? xc.enc(src[k], ctx) : qDeep(src[k]);
    if (c === undefined) continue;
    x[k] = c;
    any = true;
  }
  if (any) out[extrasKey] = x;
  return out;
}

function decFields(obj, fields, ctx, extrasKey = "x", xCodecs = null) {
  const out = {};
  const o = isObj(obj) ? obj : {};
  for (const [rk, ck, codec] of fields) out[rk] = o[ck] === undefined ? codec.def() : codec.dec(o[ck], ctx);
  if (isObj(o[extrasKey])) {
    for (const k of Object.keys(o[extrasKey])) {
      if (k in out) continue;
      const xc = xCodecs && !_compat.olderBuild ? xCodecs.get(k) : null;
      out[k] = xc ? xc.dec(o[extrasKey][k], ctx) : o[extrasKey][k];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

// Affixes are stored explicitly as a flat list of pairs: [id0, roll0, id1, roll1, ...].
function flatAffixes(aff) {
  const out = [];
  for (const a of aff || []) out.push(q(a[0]), q(a[1]));
  return out;
}

// Item: [uid, base, iLvl, rarity, polish, [affix pairs], flags, property], trailing defaults
// (property -1, flags 0, no affixes, polish 0, Prototype) left out.
const ITEM_TAIL_DEFAULTS = [null, null, null, 0, 0, "[]", 0, -1];
function encItem(it) {
  const row = [
    q(it.uid || 0), q(it.base), q(it.ilvl), q(it.rar), q(it.pol), flatAffixes(it.aff),
    q(it.flags || 0), it.prop == null ? -1 : q(it.prop),
  ];
  let n = row.length;
  while (n > 3) {
    const d = ITEM_TAIL_DEFAULTS[n - 1];
    const v = row[n - 1];
    if (d === "[]" ? v.length === 0 : v === d) n--;
    else break;
  }
  return row.slice(0, n);
}

// Item lists (stash, equipment) store each uid as the difference from the previous item's uid in
// the list (empty equipment slots are 0 and skipped), which keeps growing uids short.
function encItemList(items) {
  let prev = 0;
  return items.map((it) => {
    if (!it) return 0;
    const row = encItem(it);
    const uid = row[0];
    row[0] = q(uid - prev);
    prev = uid;
    return row;
  });
}

function decItemList(rows, ctx, slotOf, weaponType) {
  let prev = 0;
  return rows.map((r, i) => {
    if (!Array.isArray(r) || !r.length) return null;
    const a = r.slice();
    a[0] = prev + numOr(a[0], 0);
    prev = a[0];
    return decItem(a, ctx, slotOf(i), weaponType);
  });
}

/**
 * Decodes one compact item with D§13.4 fallbacks: unknown base -> the slot's tier base (stash
 * items, whose slot is unknown: the Training Stick); unknown affix -> memo with the same roll
 * (dropped if that would duplicate); unknown LTS property -> Feature-Flagged; unknown Keepsake ->
 * an LTS Feature-Flagged item.
 * @param {string|null} slotHint slot name when decoding an equipped item
 * @param {string} weaponType the wearer's weapon type for weapon fallbacks
 */
function decItem(a, ctx, slotHint, weaponType) {
  if (!Array.isArray(a)) return null;
  let [uid, base, ilvl, rar, pol, aff, flags, prop] = a;
  ilvl = Math.max(1, numOr(ilvl, 1));
  rar = Math.min(5, Math.max(0, numOr(rar, 0)));
  base = numOr(base, 0);
  if (!BASE_LIST[base] || (slotHint && BASE_LIST[base].slot !== slotHint)) {
    ctx.fallbacks++;
    base = slotHint ? baseIdFor(slotHint, itemTier(ilvl), slotHint === "weapon" ? weaponType : slotHint) : 0;
  }
  const seen = new Set();
  const outAff = [];
  const list = Array.isArray(aff) ? aff : [];
  // flat pairs, or [[id, roll], ...] as in the D§13.2 example, are both accepted
  const pairs = list.length && Array.isArray(list[0]) ? list : list.reduce((acc, x, i) => (i % 2 ? acc : acc.concat([[x, list[i + 1]]])), []);
  for (const x of pairs) {
    if (!Array.isArray(x)) continue;
    let id = numOr(x[0], 0);
    if (!AFFIXES[id]) { ctx.fallbacks++; id = 0; }
    if (seen.has(id)) continue;
    seen.add(id);
    outAff.push([id, Math.min(99, Math.max(0, numOr(x[1], 0)))]);
  }
  prop = numOr(prop, -1);
  if (rar === 5 && !KEEPSAKES[prop]) { ctx.fallbacks++; rar = 4; prop = 1; }
  if (rar === 4 && !LTS_PROPS[prop]) { ctx.fallbacks++; prop = 1; }
  if (rar < 4) prop = -1;
  return { uid: numOr(uid, 0), base, ilvl, rar, pol: Math.max(0, numOr(pol, 0)), aff: outAff, flags: numOr(flags, 0), prop };
}

// ---------------------------------------------------------------------------------------------
// Herd
// ---------------------------------------------------------------------------------------------

const quotaCodec = {
  // {mapId: kills} -> [[k1, k2, k3] per zone from zone 0 to the last zone with a quota];
  // keys that are not map ids are kept: {"r": rows, "x": {key: value}}
  enc(v) {
    const rows = [];
    const x = {};
    let extra = false;
    for (const id of Object.keys(v || {})) {
      const m = MAP_BY_ID[id];
      if (!m) {
        x[id] = qDeep(v[id]);
        extra = true;
        continue;
      }
      const k = q(numOr(v[id], 0));
      if (!k) continue;
      while (rows.length <= m.zone) rows.push([0, 0, 0]);
      rows[m.zone][m.idx] = k;
    }
    return extra ? { r: rows, x } : rows;
  },
  dec(c) {
    const out = {};
    const rows = Array.isArray(c) ? c : isObj(c) && Array.isArray(c.r) ? c.r : [];
    rows.forEach((row, z) => {
      if (!Array.isArray(row)) return;
      for (let j = 0; j < 3; j++) {
        const m = MAPS[z * 3 + j];
        const k = numOr(row[j], 0);
        if (m && k) out[m.id] = k;
      }
    });
    if (isObj(c) && isObj(c.x)) Object.assign(out, c.x);
    return out;
  },
  def: () => ({}),
};

const badgesCodec = {
  enc(v) {
    const bytes = zeros(Math.ceil(BADGES.length / 8));
    for (const id of v || []) {
      const i = BADGE_IDX[id];
      if (i != null) bytes[i >> 3] |= 1 << (i & 7);
    }
    return b64encode(bytes);
  },
  dec(c) {
    const bytes = b64decode(c);
    const out = [];
    BADGES.forEach((b, i) => { if ((bytes[i >> 3] || 0) & (1 << (i & 7))) out.push(b.id); });
    return out;
  },
  def: () => [],
};

const stashCodec = {
  enc: (v) => encItemList((v || []).filter(Boolean)),
  dec: (c, ctx) => decItemList(Array.isArray(c) ? c : [], ctx, () => null, "stick").filter(Boolean),
  def: () => [],
};

// herd.inbox (agents.js queueDrop: [finderId, item] pairs waiting for the 1-per-tick drain) can hold
// thousands of chest items after a burst, so it is stored compact like the stash: {f: [finder ids],
// i: [item rows]} under "ib". Entries of any other shape keep the whole inbox on the readable
// extras path ("x"), as before, so nothing is lost if the engine changes the entry format.
function compactInbox(v) {
  if (!Array.isArray(v) || !v.length) return null;
  for (const e of v) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "number" || !isObj(e[1]) || typeof e[1].base !== "number") return null;
  }
  return { f: v.map((e) => q(e[0])), i: encItemList(v.map((e) => e[1])) };
}
function expandInbox(c, ctx) {
  if (!isObj(c) || !Array.isArray(c.f) || !Array.isArray(c.i)) return null;
  const items = decItemList(c.i, ctx, () => null, "stick");
  const out = [];
  for (let k = 0; k < items.length; k++) if (items[k]) out.push([numOr(c.f[k], 0), items[k]]);
  return out;
}

const backlogCodec = {
  enc: (v) => [q(numOr(v && v.floor, 0)), q(numOr(v && v.kills, 0))],
  dec: (c) => ({ floor: numOr(Array.isArray(c) ? c[0] : 0, 0), kills: numOr(Array.isArray(c) ? c[1] : 0, 0) }),
  def: () => ({ floor: 0, kills: 0 }),
};

function bits(obj, keys) {
  let n = 0;
  keys.forEach((k, i) => { if (obj && obj[k]) n |= 1 << i; });
  return n;
}

function unbits(n, keys) {
  const o = {};
  keys.forEach((k, i) => { o[k] = !!(n & (1 << i)); });
  return o;
}

// cfg keys the codec writes itself (readable / compact); any other key is kept as it is
const CFG_KNOWN = ["auto", "calm", "stageH", "nums", "notify", "autoX", "notifyX", "autopilot", "glow", "collapse", "collapsed", "idleAt"];
const CFG_COMPACT = ["autoX", "notifyX", "ap", "col", "held", "idle"];
const cfgCodec = {
  enc(v) {
    const d = defaultCfg();
    const c = Object.assign({}, d, v || {});
    const auto = Object.assign({}, d.auto, c.auto || {});
    const notify = Object.assign({}, d.notify, c.notify || {});
    const out = {
      auto: bits(auto, AUTO_KEYS), calm: c.calm ? 1 : 0, stageH: q(numOr(c.stageH, 200)),
      nums: Math.max(0, NUMS.indexOf(c.nums)), notify: bits(notify, NOTIFY_KEYS),
    };
    // D§11.15 settings added later: written only when they differ from their default
    if (c.autopilot === false) out.ap = 0;
    const glow = Math.round(numOr(c.glow, 0));
    if (glow > 0) out.glow = glow;
    if (c.collapse) out.col = 1;
    if (c.collapsed) out.held = 1;
    // the host's note of when nothing started working (host.js stageAuto): a restart inside the
    // collapse countdown goes on with it; absent while something works
    if (Number.isFinite(c.idleAt)) out.idle = Math.round(c.idleAt);
    const ax = {};
    for (const k of Object.keys(auto)) if (!AUTO_KEYS.includes(k)) ax[k] = qDeep(auto[k]);
    if (Object.keys(ax).length) out.autoX = ax;
    const nx = {};
    for (const k of Object.keys(notify)) if (!NOTIFY_KEYS.includes(k)) nx[k] = qDeep(notify[k]);
    if (Object.keys(nx).length) out.notifyX = nx;
    for (const k of Object.keys(c)) {
      if (CFG_KNOWN.includes(k) || k[0] === "_") continue;
      if (c[k] !== undefined) out[k] = qDeep(c[k]);
    }
    return out;
  },
  dec(c) {
    const o = isObj(c) ? c : {};
    const out = {
      auto: Object.assign(unbits(numOr(o.auto, 0), AUTO_KEYS), isObj(o.autoX) ? o.autoX : {}),
      calm: !!o.calm, stageH: numOr(o.stageH, 200), nums: NUMS[numOr(o.nums, 2)] || "all",
      notify: Object.assign(unbits(numOr(o.notify, 0), NOTIFY_KEYS), isObj(o.notifyX) ? o.notifyX : {}),
      autopilot: o.ap !== 0, glow: Math.max(0, Math.min(5, Math.round(numOr(o.glow, 0)))), collapse: !!o.col, collapsed: !!o.held,
    };
    if (Number.isFinite(o.idle)) out.idleAt = o.idle;
    for (const k of Object.keys(o)) if (!(k in out) && !CFG_COMPACT.includes(k)) out[k] = o[k];
    return out;
  },
  def: defaultCfg,
};

// Journal [[at, kind, heroId, text, value, name?], ...]: timestamps stored as deltas {"d": rows};
// kind, text and the hero's name (row[5], round 4: herd.journal) go through the string table
// (encText); a row written with its name inline reads back the same.
const logRowsOk = (list) => list.every((e) => Array.isArray(e) && typeof e[0] === "number" && Number.isFinite(e[0]));
const logCodec = {
  enc(v, ctx) {
    const list = Array.isArray(v) ? v : [];
    if (!logRowsOk(list)) return qDeep(list);
    let prev = 0;
    return {
      d: list.map((e) => {
        const row = qDeep(e);
        row[0] = q(e[0] - prev);
        prev = e[0];
        if (row.length > 1) row[1] = encText(e[1], ctx);
        if (row.length > 3) row[3] = encText(e[3], ctx);
        if (row.length > 5) row[5] = encText(e[5], ctx);
        return row;
      }),
    };
  },
  dec(c, ctx) {
    if (Array.isArray(c)) return c;
    if (!isObj(c) || !Array.isArray(c.d)) return [];
    let at = 0;
    return c.d.map((r) => {
      const e = Array.isArray(r) ? r.slice() : [0];
      at += numOr(e[0], 0);
      e[0] = at;
      if (e.length > 1) e[1] = decText(e[1], ctx);
      if (e.length > 3) e[3] = decText(e[3], ctx);
      if (e.length > 5) e[5] = decText(e[5], ctx);
      return e;
    });
  },
  def: () => [],
};

// Contractor records (round 5, agents.contractorRecords): a Contractor kept slim, so it comes back
// as itself after a restart (D§3.4). Readable {seq, seat, L, xp, cls, prov, rev, since, day, tag,
// sig?, name?, ...}; written as one row each:
//   [seq, seat, L, xp, k, since, tag, day?, extras?]
// seq: the Contractor's number (its id is -seq; its default name, hoodie and hat follow from it);
// seat through the string table (strRef); xp to the whole point; k = class | provisional << 3 |
// Senior review << 4 | Staff review << 5; since in minutes relative to lastMs (its place in the
// hiring line; a tie goes to the lower number, which came first); tag: agents.tagOf of its
// terminal's address (5 characters at most); day: the game day it was last seen,
// relative to the top-level day (left out when 0 and nothing follows); extras {sg: the signature
// window as sigCodec writes it (only an Intern's or a provisional class needs one), n: a name that
// differs from the default, other readable fields as they are}. A row that does not read (no
// number, no seat) is dropped; an unknown class falls back as a hero's does.
const CT_KEYS = ["seq", "seat", "L", "xp", "cls", "prov", "rev", "since", "day", "tag", "sig", "name"];
const contractorsCodec = {
  enc(v, ctx) {
    const base = (ctx && ctx.base) || 0;
    const day = (ctx && ctx.day) || 0;
    return (Array.isArray(v) ? v : []).filter(isObj).map((r) => {
      const seat = typeof r.seat === "string" && ctx && ctx.strIdx && ctx.strIdx.has(r.seat) ? ctx.strIdx.get(r.seat) : strOr(r.seat, "");
      const rev = Array.isArray(r.rev) ? r.rev : [0, 0];
      const k = (Math.max(0, Math.min(7, Math.round(numOr(r.cls, 0))))) | (r.prov ? 8 : 0) | (rev[0] ? 16 : 0) | (rev[1] ? 32 : 0);
      const row = [
        q(numOr(r.seq, 0)), seat, q(Math.round(numOr(r.L, 1))), Math.max(0, Math.floor(numOr(r.xp, 0))), k,
        Math.round((numOr(r.since, base) - base) / 60000), r.tag == null ? "" : String(r.tag),
      ];
      const x = {};
      let any = false;
      if (r.sig) { x.sg = sigCodec.enc(r.sig); any = true; }
      if (typeof r.name === "string") { x.n = r.name; any = true; }
      for (const key of Object.keys(r)) {
        if (CT_KEYS.includes(key) || key[0] === "_" || r[key] === undefined || typeof r[key] === "function") continue;
        x[key] = qDeep(r[key]);
        any = true;
      }
      const dd = q(Math.round(numOr(r.day, day) - day));
      if (dd || any) row.push(dd);
      if (any) row.push(x);
      return row;
    });
  },
  dec(c, ctx) {
    const base = (ctx && ctx.base) || 0;
    const day = (ctx && ctx.day) || 0;
    const out = [];
    const seen = new Set();
    for (const row of Array.isArray(c) ? c : []) {
      if (!Array.isArray(row) || row.length < 7) continue;
      const seq = numOr(row[0], 0);
      const seat = decText(row[1], ctx);
      if (!(Number.isInteger(seq) && seq >= 1) || seen.has(seq) || typeof seat !== "string" || !seat) continue;
      seen.add(seq);
      const L = Math.max(1, Math.min(T.levelCap, Math.round(numOr(row[2], 1))));
      const k = Math.max(0, Math.round(numOr(row[4], 0)));
      let cls = k & 7;
      if (!CLASSES[cls]) {
        if (ctx) ctx.fallbacks++;
        cls = L >= 10 ? 3 : 0; // as a hero's unknown class (clsCodec)
      }
      const r = {
        seq, seat, L, xp: Math.max(0, numOr(row[3], 0)), cls, prov: k & 8 ? 1 : 0, rev: [k & 16 ? 1 : 0, k & 32 ? 1 : 0],
        since: base + numOr(row[5], 0) * 60000, day: day + numOr(row[7], 0), tag: typeof row[6] === "string" ? row[6] : "",
      };
      const x = isObj(row[8]) ? row[8] : null;
      if (x) {
        if (x.sg !== undefined) r.sig = sigCodec.dec(x.sg);
        if (typeof x.n === "string") r.name = x.n;
        for (const key of Object.keys(x)) if (key !== "sg" && key !== "n" && !(key in r)) r[key] = x[key];
      }
      out.push(r);
    }
    return out;
  },
  def: () => [],
};

// Localhost, the town (docs/TOWN.md §8): herd.town is an extras key ("x": {"town": ...}), so an
// older build keeps it as it is when it loads and saves (SAVE_VERSION stays 1). Readable and compact
// share one shape, {s: [lgtm, runbooks], rd, u: [lgtmUsed, runbooksUsed], t: [today, flags,
// chestsToday], ru: [[heroId, rank], ...], dg: [lgtmUsed, runbooksUsed] when the Digest was last
// read}; written with the shelf to one decimal (rounded down, so a reload never lifts it), every
// other number whole, trailing zeros and empty fields left out, and nothing at all for a town at
// zero (a save without one is byte-identical to before). Keys this file does not know are kept.
// The written town starts with d: the game day it was written on (herd.day), also written when the
// town is at zero but a hero's credit is (ctx.twStamp). Heroes' credits (st extras tw) count from it
// and so do today's counters: an older build keeps d as it was while its saves move the top-level
// day on, so a credit it carried for days reads as lapsed, not as today's (decTw), and the town's
// game-day turn it skipped runs when the save is loaded (world.loadWorld). d is not kept in memory
// (decodeState returns it as townDay); a save without it counts from its own day.
const TOWN_KEYS = ["d", "s", "rd", "u", "t", "ru", "dg"];
const tenth = (x) => Math.floor(numOr(x, 0) * 10 + 1e-6) / 10;
const whole = (x) => Math.max(0, Math.round(numOr(x, 0)));
const townCodec = {
  enc(v, ctx) {
    if (!isObj(v)) return v === undefined ? undefined : qDeep(v);
    const out = {};
    const s = trimZeros([tenth(Array.isArray(v.s) ? v.s[0] : 0), tenth(Array.isArray(v.s) ? v.s[1] : 0)].map(q));
    if (s.length) out.s = s;
    const rd = whole(v.rd);
    if (rd) out.rd = rd;
    const u = trimZeros([whole(Array.isArray(v.u) ? v.u[0] : 0), whole(Array.isArray(v.u) ? v.u[1] : 0)]);
    if (u.length) out.u = u;
    const t = trimZeros([0, 1, 2].map((i) => whole(Array.isArray(v.t) ? v.t[i] : 0)));
    if (t.length) out.t = t;
    const ru = (Array.isArray(v.ru) ? v.ru : []).filter((e) => Array.isArray(e) && Number.isFinite(e[0])).map((e) => [q(e[0]), whole(e[1])]);
    if (ru.length) out.ru = ru;
    const dg = trimZeros([whole(Array.isArray(v.dg) ? v.dg[0] : 0), whole(Array.isArray(v.dg) ? v.dg[1] : 0)]);
    if (dg.length) out.dg = dg;
    for (const k of Object.keys(v)) if (!TOWN_KEYS.includes(k) && k[0] !== "_" && v[k] !== undefined) out[k] = qDeep(v[k]);
    if (!Object.keys(out).length && !(ctx && ctx.twStamp)) return undefined;
    return Object.assign({ d: q((ctx && ctx.day) || 0) }, out);
  },
  dec(c, ctx) {
    if (!isObj(c)) return c;
    const list = (a, n) => { const o = zeros(n); if (Array.isArray(a)) for (let i = 0; i < n; i++) o[i] = numOr(a[i], 0); return o; };
    const out = {
      s: list(c.s, 2), rd: numOr(c.rd, 0), u: list(c.u, 2), t: list(c.t, 3),
      ru: (Array.isArray(c.ru) ? c.ru : []).filter((e) => Array.isArray(e) && Number.isFinite(e[0])).map((e) => [e[0], numOr(e[1], 0)]),
      dg: list(c.dg, 2),
    };
    if (ctx && typeof c.d === "number" && Number.isFinite(c.d)) ctx.townDay = c.d;
    for (const k of Object.keys(c)) if (!(k in out) && k !== "d") out[k] = c[k];
    return out;
  },
};
const HERD_X = new Map([["town", townCodec]]);

const HERD_FIELDS = [
  ["name", "name", C.str("The Herd")],
  ["gold", "gold", C.num(0)],
  ["snip", "snip", C.num(0)],
  ["bld", "bld", C.ints(BUILDINGS.length)],
  ["zone", "zone", C.num(0)],
  ["quota", "quota", quotaCodec],
  ["meter", "meter", C.num(0)],
  ["bank", "bank", C.num(0)],
  ["seals", "seals", C.num(0)],
  ["rel", "rel", C.num(0)],
  ["boss", "boss", C.ints(BOSSES.length)],
  ["bossKills", "bossKills", C.ints(BOSSES.length)],
  ["fight", "fight", C.json(() => null)],
  ["wounds", "wounds", C.json(() => ({}))],
  ["lessons", "lessons", C.json(() => ({}))],
  ["bt", "bt", C.ints(ZONES.length)],
  ["badges", "badges", badgesCodec],
  ["stash", "stash", stashCodec],
  ["fame", "fame", C.json(() => [])],
  ["backlog", "backlog", backlogCodec],
  ["digestAt", "digestAt", C.time(0)],
  ["cfg", "cfg", cfgCodec],
  ["log", "log", logCodec],
  ["nextUid", "uid", C.num(1)],
  ["nextHeroId", "hid", C.num(1)],
  ["rng", "rng", C.num(seedOf(1))],
  ["hired", "hi", C.ints(2)],
  ["pairSec", "pp", C.num(0)],
  ["ducks", "dk", C.num(0)],
  ["notified", "nf", C.ints(3)],
  ["milestones", "ms", C.json(() => [])],
  ["contractors", "ct", contractorsCodec],
];
// lastMs, tick and day live at the top level of the file (D§13.2).
const HERD_TOP = ["lastMs", "tick", "day"];

// ---------------------------------------------------------------------------------------------
// Heroes
// ---------------------------------------------------------------------------------------------

// Signature window (heroes.recordTask): {tm, tb, ts, blocks, workMin, subTasks, n}, packed into
// one base-36 string "w" with 3 chars per task: task minutes x 2 (2 chars, so half-minute
// precision, capped at 647.5 min) and blocks x 2 + spawned (1 char, blocks capped at 17). The
// window sums are written only when they differ from the sums of the arrays (e.g. a module that
// keeps only the scalars). The caps only affect the class signature (median, blocks per hour).
const SIG_KEYS = ["tm", "tb", "ts", "blocks", "workMin", "subTasks", "n"];
const sumOf = (a) => { let n = 0; for (const x of a) n += numOr(x, 0); return n; };
const b36 = (n, width) => Math.max(0, Math.min(Math.pow(36, width) - 1, Math.round(n))).toString(36).padStart(width, "0");
const sigCodec = {
  enc(v) {
    const s = v || {};
    const tm = Array.isArray(s.tm) ? s.tm : [];
    const tb = Array.isArray(s.tb) ? s.tb : [];
    const ts = Array.isArray(s.ts) ? s.ts : [];
    const len = Math.max(tm.length, tb.length, ts.length);
    const out = {};
    let w = "";
    for (let i = 0; i < len; i++) w += b36(numOr(tm[i], 0) * 2, 2) + b36(Math.min(17, numOr(tb[i], 0)) * 2 + (ts[i] ? 1 : 0), 1);
    if (w) out.w = w;
    // what decoding will give back, to decide whether the scalars must be written
    const back = sigCodec.dec(out);
    const b = q(numOr(s.blocks, 0));
    const wm = q(numOr(s.workMin, 0));
    const su = q(numOr(s.subTasks, 0));
    if (b !== q(back.blocks)) out.b = b;
    if (wm !== q(back.workMin)) out.m = wm;
    if (su !== q(back.subTasks)) out.s = su;
    if (numOr(s.n, 0)) out.n = q(numOr(s.n, 0));
    const x = {};
    for (const k of Object.keys(s)) if (!SIG_KEYS.includes(k) && k[0] !== "_" && s[k] !== undefined) x[k] = qDeep(s[k]);
    if (Object.keys(x).length) out.x = x;
    return out;
  },
  dec(c) {
    const o = isObj(c) ? c : {};
    const tm = [];
    const tb = [];
    const ts = [];
    const w = typeof o.w === "string" ? o.w : "";
    for (let i = 0; i + 3 <= w.length; i += 3) {
      tm.push((parseInt(w.slice(i, i + 2), 36) || 0) / 2);
      const n = parseInt(w[i + 2], 36) || 0;
      tb.push(n >> 1);
      ts.push(n & 1);
    }
    const out = {
      tm, tb, ts, blocks: numOr(o.b, sumOf(tb)), workMin: numOr(o.m, sumOf(tm)), subTasks: numOr(o.s, sumOf(ts)), n: numOr(o.n, 0),
    };
    if (isObj(o.x)) for (const k of Object.keys(o.x)) if (!(k in out)) out[k] = o.x[k];
    return out;
  },
  def: () => ({ tm: [], tb: [], ts: [], blocks: 0, workMin: 0, subTasks: 0, n: 0 }),
};

// Per-boss repeat cooldowns. boss.js keeps hero.cd.boss = {bossIdx: the hero's working seconds
// (hero.st.wh x 3600) at its last kill}; only "beaten" and "cooldown seconds left" matter, so the
// save stores a bitmask of beaten bosses, followed by [idx, secondsLeft] pairs for the bosses still
// cooling down: 511 (all nine beaten, none cooling) or [511, 3, 9000]. Decoding rebuilds the
// working-second marks from the hero's saved st.wh, so a round trip is byte-identical.
// (Absolute working seconds for 9 bosses x 30 heroes would not fit the 30 KB budget, D§13.3.)
const BOSS_CD_SEC = T.boss.repeatCooldownWorkingSec;
const bossCdCodec = {
  enc(v, ctx) {
    const now = (ctx && ctx.workSec) || 0;
    let mask = 0;
    const pairs = [];
    for (const k of Object.keys(isObj(v) ? v : {})) {
      const i = Number(k);
      if (!(Number.isInteger(i) && i >= 0 && i < 30) || typeof v[k] !== "number") continue;
      mask |= 1 << i;
      const left = Math.round(BOSS_CD_SEC - (now - numOr(v[k], 0)));
      if (left > 0) pairs.push(i, Math.min(left, BOSS_CD_SEC));
    }
    return pairs.length ? [mask].concat(pairs) : mask;
  },
  dec(c, ctx) {
    const now = (ctx && ctx.workSec) || 0;
    const o = {};
    const mask = Array.isArray(c) ? numOr(c[0], 0) : numOr(c, 0);
    for (let i = 0; i < 30; i++) if (mask & (1 << i)) o[i] = now - BOSS_CD_SEC;
    if (Array.isArray(c)) for (let j = 1; j + 1 < c.length; j += 2) if ((mask >> c[j]) & 1) o[c[j]] = now - (BOSS_CD_SEC - numOr(c[j + 1], 0));
    return o;
  },
  def: () => ({}),
};

const CD_FIELDS = [
  ["unblockedUntil", "unb", C.num(0)],
  ["unblockedCdUntil", "unbCd", C.num(0)],
  ["boss", "b", bossCdCodec],
  ["respecAt", "rs", C.json(() => null)],
];
const cdCodec = {
  enc: (v, ctx) => encFields(v || {}, CD_FIELDS, ctx),
  dec: (c, ctx) => decFields(c, CD_FIELDS, ctx),
  def: () => ({ unblockedUntil: 0, unblockedCdUntil: 0, boss: {}, respecAt: null }),
};

// Pending chest: {min, fmin, title, at, sealFactor, ...} -> [min, title, at - lastMs, fmin, sealFactor, extras?]
const PEND_KEYS = ["min", "fmin", "title", "at", "sealFactor"];
const pendCodec = {
  dyn: true,
  enc: (v, ctx) => (v || []).map((p) => {
    if (!isObj(p)) return { raw: qDeep(p) };
    const base = (ctx && ctx.base) || 0;
    const row = [q(numOr(p.min, 0)), encText(p.title == null ? null : String(p.title), ctx), q(numOr(p.at, 0) - base), q(numOr(p.fmin, 0)), qDeep(p.sealFactor ?? 1)];
    const x = {};
    let any = false;
    for (const k of Object.keys(p)) {
      if (PEND_KEYS.includes(k) || k[0] === "_" || p[k] === undefined) continue;
      x[k] = qDeep(p[k]);
      any = true;
    }
    if (any) row.push(x);
    else {
      // trailing defaults are left out: sealFactor 1, then Forkling minutes 0
      if (row[4] === 1) {
        row.pop();
        if (row[3] === 0) row.pop();
      }
    }
    return row;
  }),
  dec: (c, ctx) => (Array.isArray(c) ? c : []).map((r) => {
    if (!Array.isArray(r)) return isObj(r) && "raw" in r ? r.raw : r;
    const at = numOr(r[2], 0) + ((ctx && ctx.base) || 0);
    const t = decText(r[1], ctx);
    const p = { min: numOr(r[0], 0), fmin: numOr(r[3], 0), title: t == null ? null : String(t), at, sealFactor: r[4] ?? 1 };
    if (isObj(r[5])) Object.assign(p, r[5]);
    return p;
  }),
  def: () => [],
};

// Localhost (docs/TOWN.md §8): st.tw = [jobXp, creditDay?] in memory (job XP with its fraction;
// the game day of the hero's last chest opened with full value) is written in the st row's extras as
// [jobXp, d]: job XP in whole units (rounded down, so a reload never lifts a rank), d = the save's
// day - creditDay while the duty rule still counts it (0 or 1), left out at 2 or more; nothing for a
// hero with neither. An older build keeps the extras as they are, and the town's d (townCodec) as it
// was: d counts back from that day when the save has it (ctx.townDay), else from the save's day.
function twDays(v, day) {
  const c = Array.isArray(v) && v.length > 1 && typeof v[1] === "number" && Number.isFinite(v[1]) ? v[1] : null;
  return c == null ? null : Math.max(0, Math.round(day - c));
}
function encTw(v, ctx) {
  if (!Array.isArray(v)) return v === undefined ? null : qDeep(v);
  const jx = Math.max(0, Math.floor(numOr(v[0], 0) + 1e-9));
  const d = twDays(v, (ctx && ctx.day) || 0);
  const out = [jx];
  const rest = v.slice(2).map((x) => qDeep(x));
  if (d != null && d <= T.town.gateDays) out.push(d);
  else if (rest.length) out.push(null);
  if (rest.length) out.push(...rest);
  return out.length > 1 || jx > 0 ? out : null;
}
function decTw(c, ctx) {
  if (!Array.isArray(c)) return c;
  const out = [Math.max(0, numOr(c[0], 0))];
  const day = ctx && typeof ctx.townDay === "number" ? ctx.townDay : (ctx && ctx.day) || 0;
  if (typeof c[1] === "number" && Number.isFinite(c[1])) out.push(day - c[1]);
  else if (c.length > 2) out.push(null);
  for (let i = 2; i < c.length; i++) out.push(c[i]);
  return out;
}

// Lifetime counters {kills, tasks, seals, wh, dodges, healed, ...} -> [6 numbers, extras?]
const STAT_KEYS = ["kills", "tasks", "seals", "wh", "dodges", "healed"];
const statCodec = {
  enc(v, ctx) {
    const s = isObj(v) ? v : {};
    const row = STAT_KEYS.map((k) => q(numOr(s[k], 0)));
    const x = {};
    for (const k of Object.keys(s)) {
      if (STAT_KEYS.includes(k) || k[0] === "_" || s[k] === undefined) continue;
      if (k === "tw" && !_compat.olderBuild) {
        const tw = encTw(s.tw, ctx);
        if (tw != null) x.tw = tw;
        continue;
      }
      x[k] = qDeep(s[k]);
    }
    if (Object.keys(x).length) row.push(x);
    return row;
  },
  dec(c, ctx) {
    const r = Array.isArray(c) ? c : [];
    const out = {};
    STAT_KEYS.forEach((k, i) => { out[k] = numOr(r[i], 0); });
    if (isObj(r[6])) for (const k of Object.keys(r[6])) if (!(k in out)) out[k] = k === "tw" && !_compat.olderBuild ? decTw(r[6][k], ctx) : r[6][k];
    return out;
  },
  def: () => ({ kills: 0, tasks: 0, seals: 0, wh: 0, dodges: 0, healed: 0 }),
};

const shiftCodec = {
  enc: (v) => [q(numOr(v && v.day, 0)), q(numOr(v && v.min, 0))],
  dec: (c) => ({ day: numOr(Array.isArray(c) ? c[0] : 0, 0), min: numOr(Array.isArray(c) ? c[1] : 0, 0) }),
  def: () => ({ day: 0, min: 0 }),
};

function eqCodec() {
  return {
    enc: (v) => {
      const list = [];
      for (let s = 0; s < SLOTS.length; s++) list.push(v && v[s] ? v[s] : null);
      return encItemList(list);
    },
    dec: (c, ctx) => {
      const list = (Array.isArray(c) ? c : []).slice(0, SLOTS.length);
      const out = decItemList(list, ctx, (i) => SLOTS[i], ctx.weaponType);
      while (out.length < SLOTS.length) out.push(null);
      return out;
    },
    def: () => new Array(SLOTS.length).fill(null),
  };
}

const clsCodec = {
  enc: (v) => q(numOr(v, 0)),
  dec: (c, ctx) => {
    const n = numOr(c, 0);
    if (CLASSES[n]) return n;
    ctx.fallbacks++;
    return ctx.level >= 10 ? 3 : 0; // unknown class: Shellmancer (the default), Intern below Lv 10
  },
  def: () => 0,
};

const mapCodec = {
  enc: (v) => (v == null ? null : String(v)),
  dec: (c, ctx) => {
    if (c == null) return null;
    if (MAP_BY_ID[c] || c === "backlog") return c;
    ctx.fallbacks++;
    return null;
  },
  def: () => null,
};

// Hero keys are short: a herd of 30 heroes in full gear must fit in 30 KB (D§13.3).
const HERO_FIELDS = [
  ["id", "id", C.num(0)],
  ["seat", "s", C.strRef()],
  ["sid", "sid", C.strRef()],
  ["ord", "o", C.num(0)],
  ["name", "n", C.str("")],
  ["cls", "c", clsCodec],
  ["prov", "pv", C.flag(0)],
  ["L", "L", C.num(1)],
  ["xp", "xp", C.num(0)],
  ["sp", "sp", C.ints(7)],
  ["spFree", "sf", C.num(0)],
  ["autoLearn", "au", C.bool(true)],
  ["rev", "rv", C.ints(2)],
  ["eq", "eq", eqCodec()],
  ["pinMap", "m", mapCodec],
  ["fe", "fe", C.num(0)],
  ["shift", "sh", shiftCodec],
  ["cups", "cu", C.num(T.coffee.carry)],
  ["hpFrac", "hp", C.num(1)],
  ["sig", "sg", sigCodec],
  ["pend", "pd", pendCodec],
  ["cd", "cd", cdCodec],
  ["addr", "a", C.json(() => null)],
  ["lastPane", "lp", C.strRef()],
  ["lastTab", "lt", C.strRef()],
  ["seenAt", "se", C.time(0)],
  ["st", "st", statCodec],
  ["rng", "r", C.num(seedOf(1))],
  ["bornDay", "bd", C.num(0)],
  ["pref", "pf", C.json(() => null)],
  // (not here: `look`, a promoted Contractor's hoodie tint, heroes.lookOf, round 4b. It is written
  // with the hero's extras, "x": {"look": n}, so an older build that loads the save keeps it)
];

// A hero's working seconds as boss.js counts them (Math.round(st.wh x 3600)).
function heroWorkSec(st) {
  return Math.round(numOr(st && st.wh, 0) * 3600);
}

function decHero(o, ctx) {
  const L = numOr(isObj(o) ? o.L : 1, 1);
  const cls = numOr(isObj(o) ? o.c : 0, 0);
  const sub = {
    fallbacks: 0, level: L, weaponType: (CLASSES[cls] || CLASSES[L >= 10 ? 3 : 0]).weapon, table: ctx.table, base: ctx.base,
    workSec: heroWorkSec(statCodec.dec(isObj(o) ? o.st : null, ctx)), day: ctx.day, townDay: ctx.townDay,
  };
  const h = decFields(o, HERO_FIELDS, sub);
  ctx.fallbacks += sub.fallbacks;
  return h;
}

// ---------------------------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------------------------

/** Serialises world.state to the compact save text (with CRC). */
export function encodeState(state) {
  const herd = state.herd || {};
  const top = {
    v: SAVE_VERSION,
    gen: GEN,
    t: Math.floor(numOr(herd.lastMs, 0) / 1000),
    lastMs: q(numOr(herd.lastMs, 0)),
    tick: q(numOr(herd.tick, 0)),
    day: q(numOr(herd.day, 0)),
    crc: "",
    str: undefined,
    herd: null,
    heroes: null,
  };
  const herdSrc = {};
  for (const k of Object.keys(herd)) if (!HERD_TOP.includes(k)) herdSrc[k] = herd[k];
  const inbox = compactInbox(herd.inbox);
  if (inbox) delete herdSrc.inbox;
  const heroes = state.heroes || [];
  // strings used more than once go into a table, in order of first use: seats, space ids and
  // pane/tab names of the heroes, then pending-chest titles, then the journal's kinds and texts
  const counts = new Map();
  const use = (v) => { if (typeof v === "string") counts.set(v, (counts.get(v) || 0) + 1); };
  for (const h of heroes) for (const v of [h.seat, h.sid, h.lastPane, h.lastTab]) use(v);
  for (const h of heroes) for (const p of Array.isArray(h.pend) ? h.pend : []) if (isObj(p) && p.title != null) use(String(p.title));
  const log = Array.isArray(herd.log) ? herd.log : [];
  if (logRowsOk(log)) for (const e of log) { use(e[1]); use(e[3]); use(e[5]); }
  // Contractor records' seats (round 5): usually a seat a saved hero has too
  for (const r of Array.isArray(herd.contractors) ? herd.contractors : []) if (isObj(r)) use(r.seat);
  const table = [];
  const strIdx = new Map();
  for (const [str, n] of counts) if (n > 1) { strIdx.set(str, table.length); table.push(str); }
  // Localhost (docs/TOWN.md §8): the town carries the day its heroes' credits count from, written
  // even with the town at zero when a credit is (townCodec)
  const twStamp = !_compat.olderBuild && heroes.some((h) => {
    const d = isObj(h) && isObj(h.st) ? twDays(h.st.tw, top.day) : null;
    return d != null && d <= T.town.gateDays;
  });
  if (twStamp && herdSrc.town == null) herdSrc.town = {};
  const ctx = { strIdx, base: top.lastMs, day: top.day, twStamp };
  top.herd = encFields(herdSrc, HERD_FIELDS, ctx, "x", HERD_X);
  if (inbox) top.herd.ib = inbox;
  top.heroes = heroes.map((h) => encFields(h, HERO_FIELDS, Object.assign({}, ctx, { workSec: heroWorkSec(h.st) })));
  if (table.length) top.str = table;
  const x = {};
  let any = false;
  for (const k of Object.keys(state)) {
    if (["v", "gen", "herd", "heroes", "readOnly", "str"].includes(k) || k[0] === "_" || state[k] === undefined) continue;
    x[k] = qDeep(state[k]);
    any = true;
  }
  if (any) top.x = x;
  const text0 = JSON.stringify(top);
  return text0.replace('"crc":""', `"crc":"${crc32(text0)}"`);
}

function saveError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Parses a save text back into world.state.
 * @param {string} text
 * @param {{ignoreCrc?:boolean}} [opts]
 * @returns {{state:object, warning:null|string, readOnly:boolean, townDay:null|number}} townDay: the
 *   game day the save's town was written on (herd.x.town.d, docs/TOWN.md §8), null without one
 * @throws Error with .code "parse" (not JSON), "shape" (not a save) or "crc" (checksum mismatch)
 */
export function decodeState(text, opts = {}) {
  if (typeof text !== "string") throw saveError("parse", "Save is not text");
  // A byte-order mark or surrounding whitespace (an editor's "insert final newline") is not
  // corruption: the CRC covers the JSON text itself, which encodeState writes without either.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.trim();
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw saveError("parse", `Save is not valid JSON: ${e.message}`);
  }
  if (!isObj(obj) || !isObj(obj.herd)) throw saveError("shape", "Save has no herd");
  const warnings = [];
  const m = /"crc":"([0-9a-fA-F]*)"/.exec(text);
  if (m && m[1]) {
    const want = crc32(text.replace(m[0], '"crc":""'));
    if (want !== m[1].toLowerCase() && !opts.ignoreCrc) throw saveError("crc", `Save checksum mismatch (${m[1]} != ${want})`);
  } else {
    warnings.push("Save had no checksum");
  }

  let readOnly = false;
  let v = numOr(obj.v, 0);
  if (!(Number.isInteger(v) && v >= 0)) throw saveError("shape", `Save has a bad version (${obj.v})`);
  if (v > SAVE_VERSION) {
    readOnly = true;
    warnings.push(`Save is from a newer version (v${v}); opened read-only`);
  } else {
    for (; v < SAVE_VERSION; v++) obj = migrations[v](obj);
  }
  if (numOr(obj.gen, GEN) > GEN) warnings.push(`Save uses newer content (gen ${obj.gen}); unknown ids were replaced`);

  const ctx = { fallbacks: 0, table: Array.isArray(obj.str) ? obj.str : [], base: numOr(obj.lastMs, 0), day: numOr(obj.day, 0) };
  const herd = decFields(obj.herd, HERD_FIELDS, ctx, "x", HERD_X);
  delete herd.ib; // (an extras key only if a save put "ib" under herd.x)
  // Localhost: the town's Digest baseline lives in herd.town.dg, which an older build keeps (its
  // digestMark writes digestSnap anew); a town save from before that kept it in digestSnap.tw
  if (!_compat.olderBuild && isObj(herd.town) && isObj(herd.digestSnap) && "tw" in herd.digestSnap) {
    const tw = herd.digestSnap.tw;
    const dg = Array.isArray(herd.town.dg) ? herd.town.dg : [];
    if (Array.isArray(tw) && !(dg[0] || dg[1])) herd.town.dg = [0, 1].map((i) => Math.max(0, numOr(tw[i], 0)));
    delete herd.digestSnap.tw;
  }
  const inbox = expandInbox(obj.herd.ib, ctx);
  if (inbox && inbox.length) herd.inbox = inbox;
  herd.lastMs = numOr(obj.lastMs, 0);
  herd.tick = numOr(obj.tick, 0);
  herd.day = numOr(obj.day, 0);
  if (!(herd.zone >= 0 && herd.zone <= ZONES.length)) { herd.zone = 0; ctx.fallbacks++; }
  const heroes = (Array.isArray(obj.heroes) ? obj.heroes : []).filter(isObj).map((o) => decHero(o, ctx));
  const state = { v: SAVE_VERSION, gen: GEN, herd, heroes };
  if (isObj(obj.x)) for (const k of Object.keys(obj.x)) if (!(k in state)) state[k] = obj.x[k];
  if (ctx.fallbacks) warnings.push(`${ctx.fallbacks} unknown id(s) replaced with fallbacks`);
  return { state, warning: warnings.length ? warnings.join("; ") : null, readOnly, townDay: typeof ctx.townDay === "number" ? ctx.townDay : null };
}

/** Byte length of a save text in UTF-8 and whether it fits the D§13.3 budget (30 KB). */
export function saveSize(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // a surrogate pair is 4 UTF-8 bytes: count 4 for the high half and 0 for the low half
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : c >= 0xdc00 && c <= 0xdfff ? 0 : 3;
  }
  return { bytes: n, budget: SIZE_BUDGET, ok: n <= SIZE_BUDGET };
}
