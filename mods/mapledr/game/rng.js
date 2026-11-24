// Deterministic randomness for the engine (D§12.3.12): xorshift32 state lives in the save, one per
// hero plus one for the herd. Nothing in game/ may call Math.random().
//
// A "holder" is any object with a numeric `.rng` field (a Hero or the Herd). Every draw advances
// holder.rng in place, so reloading a save never rerolls anything.

const U32 = 4294967296; // 2^32
const FALLBACK_SEED = 0x6d2b79f5; // used when a holder's state is 0 or missing (xorshift needs != 0)

/** One xorshift32 step (shifts 13, 17, 5). `state` must be a non-zero uint32. */
export function xs32(state) {
  let x = state >>> 0 || FALLBACK_SEED;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/** Turns any number or string into a valid (non-zero uint32) RNG state. */
export function seedOf(v) {
  const s = typeof v === "string" ? fnv1a32(v) : Math.floor(Math.abs(Number(v) || 0)) >>> 0;
  return s || FALLBACK_SEED;
}

/** Uniform float in [0, 1). Advances holder.rng. */
export function rngNext(holder) {
  holder.rng = xs32(holder.rng);
  return holder.rng / U32;
}

/** Uniform integer in [lo, hi] (inclusive). */
export function rngInt(holder, lo, hi) {
  if (hi <= lo) return lo;
  return lo + Math.floor(rngNext(holder) * (hi - lo + 1));
}

/** Uniform float in [a, b). */
export function rngRange(holder, a, b) {
  return a + (b - a) * rngNext(holder);
}

/** true with probability p (always draws once, so call sites stay in lockstep). */
export function rngChance(holder, p) {
  return rngNext(holder) < p;
}

/**
 * Weighted pick. With an array of weights returns an index; with an object {key: weight}
 * returns a key (insertion order). Non-positive weights are never picked. If every weight is
 * <= 0, returns the first index/key (and still draws once).
 */
export function rngPick(holder, weights) {
  const isArr = Array.isArray(weights);
  const keys = isArr ? null : Object.keys(weights);
  const n = isArr ? weights.length : keys.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const w = isArr ? weights[i] : weights[keys[i]];
    if (w > 0) total += w;
  }
  const r = rngNext(holder) * total;
  let acc = 0;
  let last = -1;
  for (let i = 0; i < n; i++) {
    const w = isArr ? weights[i] : weights[keys[i]];
    if (!(w > 0)) continue;
    acc += w;
    last = i;
    if (r < acc) return isArr ? i : keys[i];
  }
  if (last < 0) last = 0; // nothing positive: deterministic fallback
  return isArr ? last : keys[last];
}

/** Uniform pick from a non-empty array (returns the element). */
export function rngElem(holder, list) {
  return list[rngInt(holder, 0, list.length - 1)];
}

/**
 * FNV-1a 32-bit hash of the UTF-8 bytes of `str` (standard parameters: offset 2166136261,
 * prime 16777619). Used for default hero names (D§3.3) and render jitter.
 */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    // UTF-16 -> code point (surrogate pairs), then feed its UTF-8 bytes
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) {
      h = fnvByte(h, c);
    } else if (c < 0x800) {
      h = fnvByte(h, 0xc0 | (c >> 6));
      h = fnvByte(h, 0x80 | (c & 63));
    } else if (c < 0x10000) {
      h = fnvByte(h, 0xe0 | (c >> 12));
      h = fnvByte(h, 0x80 | ((c >> 6) & 63));
      h = fnvByte(h, 0x80 | (c & 63));
    } else {
      h = fnvByte(h, 0xf0 | (c >> 18));
      h = fnvByte(h, 0x80 | ((c >> 12) & 63));
      h = fnvByte(h, 0x80 | ((c >> 6) & 63));
      h = fnvByte(h, 0x80 | (c & 63));
    }
  }
  return h >>> 0;
}

function fnvByte(h, b) {
  return Math.imul(h ^ b, 16777619) >>> 0;
}

/** Stable uint32 hash for renderers (loop period/phase jitter). Alias of fnv1a32. */
export function hashKey(str) {
  return fnv1a32(str);
}
