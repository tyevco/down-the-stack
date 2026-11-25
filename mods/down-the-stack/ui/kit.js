// Shared UI helpers for every role. Renderers consume view models from game/view.js and use
// these helpers for the common bits. Keep this file dependency-light: no game state here.
//
// Rules (docs/ARCHITECTURE.md §2): colors are hex strings only; never pass null/false children;
// image()/svg() always get both w and h; loop px values are multiplied by zoom().

import { div, image, svg } from "gpui-kit";
import { settings, theme } from "herdr";

// One constant for every asset path, so `mod.clone` can rewrite it.
export const ASSETS = "mods/down-the-stack";
export const art = (rel) => `${ASSETS}/art/${rel}`;

// Reserved meaning colours (DESIGN §11.1). Gold is only "done"; "!" only blocked.
export const C = {
  done: "#FFD447",
  xp: "#7FE9F5",
  hp: "#FF5A5F",
  fresh: "#A9B8FF",
  working: "#4CC38A",
  blocked: "#F2A93B",
  idle: "#8A8F98",
  coin: "#C89B3C",
  white: "#FFFFFF",
  ink: "#16141F",
  shadow: "#00000066",
  overlay: "#00000033",
  cream: "#FFF4D6",
};

export const RARITY = ["#A0A4AB", "#5BD16A", "#4EA3FF", "#B36BFF", "#FF9A2E", "#FF7AA8"];

export const MONO = "JetBrains Mono";

export function zoom() {
  const z = Number(settings()?.zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * A colour value elements accept ("#rgb", "#rrggbb", "#rrggbbaa"), or `d`. herdr's settings take
 * "ff8800" or "#ff8800 " in a theme override (it trims and strips "#") and theme() hands that on
 * verbatim, but .bg()/.text_color() throw on it: trim, add the "#", else use the fallback.
 */
export function hex(v, d) {
  if (typeof v !== "string") return d;
  let s = v.trim();
  if (s && s[0] !== "#") s = "#" + s;
  return HEX.test(s) ? s : d;
}

// Theme colours with safe fallbacks (theme() is graphite during `herdr-app check`).
export function T() {
  const t = theme() ?? {};
  return {
    bg: hex(t.background, "#1b1d22"),
    chrome: hex(t.chrome, "#15171b"),
    surface: hex(t.surface, "#202329"),
    raised: hex(t.raised, "#2a2e36"),
    hover: hex(t.hover, "#ffffff14"),
    selected: hex(t.selected, "#ffffff1f"),
    border: hex(t.border, "#ffffff1a"),
    fg: hex(t.foreground, "#e6e6e6"),
    muted: hex(t.muted, "#a0a4ab"),
    dim: hex(t.dim, "#6b7079"),
    accent: hex(t.accent, "#7fa7ff"),
    working: hex(t.working, C.working),
    blocked: hex(t.blocked, C.blocked),
    done: hex(t.done, C.done),
    idle: hex(t.idle, C.idle),
  };
}

// "#rrggbb" + alpha (0..1) → "#rrggbbaa". Leaves 8-digit inputs alone.
export function alpha(hex, a) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const v = Math.max(0, Math.min(255, Math.round(a * 255)));
  return hex + v.toString(16).padStart(2, "0");
}

// Deterministic per-key jitter for loop periods, so equal loops don't move in lockstep.
export function jitter(key, base, step = 37, spread = 9) {
  let h = 2166136261;
  const s = String(key);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return base + (h % spread) * step;
}

// Children helper: drops null/undefined/false so `.children()` never sees them.
export function kids(list) {
  return list.filter((c) => c !== null && c !== undefined && c !== false);
}

// Full-colour image with explicit size.
export function pic(rel, w, h) {
  return image(art(rel)).w(w).h(h).flex_none();
}

// One-colour mask tinted by `color`.
export function mask(rel, w, h, color) {
  return svg(art(rel)).w(w).h(h).flex_none().text_color(color);
}

// A thin progress bar. frac 0..1; extra = optional second segment (e.g. Fresh Eyes) after the fill.
export function bar(id, w, h, frac, color, track, extra) {
  const f = clamp01(frac);
  const el = div().id(id).relative().w(w).h(h).rounded(h >= 4 ? 2 : 1).bg(track ?? "#00000055").overflow_hidden()
    .child(div().absolute().left(0).top(0).h(h).w(Math.round(w * f)).bg(color));
  if (extra && extra.frac > 0) {
    const x = Math.round(w * f);
    const ew = Math.max(0, Math.min(w - x, Math.round(w * extra.frac)));
    if (ew > 0) el.child(div().absolute().left(x).top(0).h(h).w(ew).bg(extra.color));
  }
  return el;
}

// A small rounded label.
export function pill(id, text, fg, bg, size = 10) {
  return div().id(id).flex_none().px(5).py(1).rounded(8).bg(bg).text_color(fg).text_size(size)
    .font_family(MONO).child(String(text));
}

// Stops a press from reaching window_drag blocks / parents (win98 kit's own()).
export function own(el) {
  return el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
}

/**
 * A name split for a cut in the middle (round 4c): [head, tail], head + tail === the name. The tail
 * is the name's trailing parts after a separator (- _ . / : or a space), as many as fit in `max`
 * characters ("res-2" of "ceo-assistant-res-2"; with max 12, "search-eng" of
 * "ceo-assistant-search-eng"); the first part always stays in the head. A tail under 3 characters
 * ("2") or none within `max` gives way to the name's last 6. It never splits a surrogate pair (half
 * an emoji: herdr refuses a lone surrogate in any text). A name of `max` characters or fewer has
 * no tail: [name, ""].
 */
export function splitTail(s, max = 8) {
  const t = String(s ?? "");
  if (t.length <= max) return [t, ""];
  const SEP = /[-_./: ]/;
  let at = -1;
  for (let i = t.length - 2; i > 0; i--) {
    if (!SEP.test(t[i])) continue;
    if (t.length - (i + 1) > max) break;
    at = i + 1;
  }
  if (at < 0 || t.length - at < 3) at = t.length - 6;
  const c = t.charCodeAt(at);
  if (c >= 0xdc00 && c <= 0xdfff) at -= 1;
  return [t.slice(0, at), t.slice(at)];
}

/**
 * A name that is cut in the middle when its box is too narrow (round 4c): the head shrinks with
 * "…" while the tail (splitTail) stays whole, "ceo-assi…res-2", so names that share a start (two
 * spaces "ceo-assistant-…") stay apart. The caller sizes the box (w, flex) and sets the text style
 * on it. o.room / o.size (px): the box's width and font size; a name that surely fits (0.6 em a
 * character, wider than the UI font's) stays one plain box, as does a name with no tail: three
 * elements only where a cut may come. o.tail: the tail's most characters (splitTail's max, 8; a
 * roomier line takes more, so "…search-eng" and "…billing-eng" stay apart). o.tooltip puts the
 * whole name on hover when it is split (a row whose own tooltip names it passes false).
 */
export function middleCut(text, o = {}) {
  const t = String(text ?? "");
  const fits = Number.isFinite(o.room) && Number.isFinite(o.size) && t.length * o.size * 0.6 <= o.room;
  const [head, tail] = fits ? [t, ""] : splitTail(t, Number.isFinite(o.tail) ? o.tail : 8);
  const el = div();
  if (o.id) el.id(o.id);
  if (o.tooltip && tail) el.tooltip(t);
  if (!tail) return el.min_w(0).truncate().child(t);
  // a head ending in a space keeps it (text boxes drop a trailing space)
  const h = /\s$/.test(head) ? `${head.slice(0, -1)}\u00A0` : head;
  return el.flex().flex_row().min_w(0).overflow_hidden().whitespace_nowrap()
    .child(div().min_w(0).truncate().child(h))
    .child(div().flex_none().child(tail));
}

export function clamp01(x) {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}
