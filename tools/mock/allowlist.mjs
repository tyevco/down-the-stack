// The element-method allowlist (tools/api-allowlist.json, derived from herdr's source) split into
// the groups the mock dispatches on. Precedence mirrors herdr's prelude, where later definitions
// overwrite earlier ones: prelude methods > generic behaviors > parametric styles > nullary styles.

import fs from "node:fs";
import path from "node:path";
import { TOOLS_DIR } from "./config.mjs";

const raw = JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, "api-allowlist.json"), "utf8"));
const g = raw.element_method_groups;

export const ALLOW = raw;
export const ELEMENT_METHODS = new Set(raw.element_methods);
/** name → grammar type string from the allowlist (e.g. "Length", "Color"). */
export const PARAM_STYLES = new Map(Object.entries(g.param_styles));
export const NULLARY_STYLES = new Set([
  ...g.nullary_styles_gpui_reflected,
  ...g.nullary_styles_gpui_base_reflected,
  ...g.nullary_styles_hand_bound,
]);
export const BEHAVIORS = new Set(g.behaviors_generic);
export const PRELUDE = new Set(g.prelude_methods);
export const KIT_EXPORTS = raw.kit_exports;
export const BASE_EXPORTS = raw.base_exports;
export const FPS_EXPORTS = raw.fps_exports;

/** "prelude" | "behavior" | "param" | "nullary" | null (unknown). */
export function methodKind(name) {
  if (!ELEMENT_METHODS.has(name)) return null;
  if (PRELUDE.has(name)) return "prelude";
  if (BEHAVIORS.has(name)) return "behavior";
  if (PARAM_STYLES.has(name)) return "param";
  if (NULLARY_STYLES.has(name)) return "nullary";
  return "behavior";
}

/** Style names only (what herdr's `style::suggest` searches). */
const STYLE_NAMES = [...new Set([...NULLARY_STYLES, ...PARAM_STYLES.keys()])].sort();

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    cur[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = Math.min(prev[j] + (a[i] !== b[j] ? 1 : 0), prev[j + 1] + 1, cur[j] + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** herdr's "did you mean" (within 2 edits, or a third of the name for long names). */
export function suggest(name) {
  const budget = Math.max(2, Math.floor(name.length / 3));
  let best = null;
  for (const c of STYLE_NAMES) {
    if (Math.abs(c.length - name.length) > budget) continue;
    const d = editDistance(name, c);
    if (d <= budget && (!best || d < best[0])) best = [d, c];
  }
  return best ? best[1] : null;
}

/** herdr's unknown_method() message (quickjs/mod.rs:10620). */
export function unknownMethodMessage(name) {
  const s = suggest(name);
  if (s) return `unknown element method \`${name}\` (did you mean \`${s}\`?)`;
  return `unknown element method \`${name}\`; it is neither a style method nor one of child, children, when, on_click, on_change, disabled, selected, checked, overflow_scroll, overflow_x_scroll, overflow_y_scroll, overflow_scrollbar, overflow_x_scrollbar, overflow_y_scrollbar`;
}
