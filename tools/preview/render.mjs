// Recorded element tree (tools/mock serialize()) → standalone HTML/CSS.
//
// A stand-in for herdr's renderer, good for layout and art review, not pixel-exact:
//  - GPUI semantics where they differ from the web: div is display:block + position:relative,
//    nothing is flex until .flex(); box-sizing border-box; borders draw only with border_color;
//    numbers are px × zoom; nullary ramps are rem (13 px × zoom); border_N is raw px;
//    loop() px values are NOT zoom-scaled (as in herdr).
//  - image() → <img> (object-fit contain, inlined as a data URI). An SVG image is rasterised once
//    at 2× its intrinsic size, as herdr does (gpui img.rs → svg_renderer render_single_frame(1.0)
//    × SMOOTH_SVG_SCALE_FACTOR 2): drawn bigger than that it blurs, here too. svg() → a div masked
//    by the SVG and filled with the text color fixed when the tree was built (herdr fixes it then:
//    a parent's :hover colour does not reach the icon); loop → CSS keyframes (alternate, period/2); transition → CSS
//    transition; frames → a small script cycling the text on a shared clock; tooltip → title;
//    hover/active → :hover/:active rules; spin → CSS rotation.
// Methods the preview cannot map are listed in an HTML comment (and in ctx.unmapped).

import fs from "node:fs";
import { resolveAsset } from "../mock/config.mjs";
import { resolveTheme } from "../mock/theme.mjs";
import { BEHAVIORS } from "../mock/allowlist.mjs";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Shared state for one HTML document (several trees may share it). */
export function newContext({ zoom = 1, theme = resolveTheme("graphite"), remPx = 13 } = {}) {
  return { zoom, theme, rem: remPx * zoom, css: [], unmapped: new Set(), seq: 0, missing: new Set(), usesFrames: false, usesRaster: false, color: null };
}

// ---------------------------------------------------------------------------------------------
// assets

const assetCache = new Map();
function dataUri(src) {
  if (assetCache.has(src)) return assetCache.get(src);
  let uri = null;
  const r = resolveAsset(src);
  if (r.real) {
    try {
      const buf = fs.readFileSync(r.real);
      const ext = r.real.split(".").pop().toLowerCase();
      const mime = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] ?? "application/octet-stream";
      uri = `data:${mime};base64,${buf.toString("base64")}`;
    } catch { uri = null; }
  }
  assetCache.set(src, uri);
  return uri;
}

/** An SVG file's intrinsic size (its width/height attributes, else its viewBox), or null. */
const intrinsicCache = new Map();
function svgIntrinsic(src) {
  if (intrinsicCache.has(src)) return intrinsicCache.get(src);
  let out = null;
  const r = resolveAsset(src);
  if (r.real && r.real.toLowerCase().endsWith(".svg")) {
    try {
      const head = /<svg\b[^>]*>/i.exec(fs.readFileSync(r.real, "utf8"))?.[0] ?? "";
      const attr = (n) => { const m = new RegExp(`\\s${n}\\s*=\\s*["']\\s*([0-9.]+)(px)?\\s*["']`, "i").exec(head); return m ? Number(m[1]) : null; };
      let w = attr("width");
      let h = attr("height");
      const vb = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(head);
      if ((w == null || h == null) && vb) { w = w ?? Number(vb[1]); h = h ?? Number(vb[2]); }
      if (w > 0 && h > 0) out = { w, h };
    } catch { out = null; }
  }
  intrinsicCache.set(src, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// lengths

const REM_STEPS = /^(\d+)(p5)?$/;
const FRACTIONS = { "1_2": 50, "1_3": 33.3333, "2_3": 66.6667, "1_4": 25, "2_4": 50, "3_4": 75, "1_5": 20, "2_5": 40, "3_5": 60, "4_5": 80, "1_6": 16.6667, "5_6": 83.3333, "1_12": 8.3333 };

function len(ctx, v) {
  if (typeof v === "number") return `${round(v * ctx.zoom)}px`;
  const t = String(v).trim();
  if (t === "auto") return "auto";
  if (t.endsWith("%")) return `${parseFloat(t)}%`;
  if (t.endsWith("rem")) return `${round(parseFloat(t) * ctx.rem)}px`;
  if (t.endsWith("px")) return `${round(parseFloat(t) * ctx.zoom)}px`;
  return null;
}
const round = (n) => Math.round(n * 100) / 100;

/** A ramp suffix (p_4 → "4", w_full → "full", left_neg_2 → neg "2") → CSS length. */
function rampLen(ctx, suffix) {
  let neg = false;
  if (suffix.startsWith("neg_")) { neg = true; suffix = suffix.slice(4); }
  let v = null;
  const m = REM_STEPS.exec(suffix);
  if (m) v = `${round(((Number(m[1]) + (m[2] ? 0.5 : 0)) / 4) * ctx.rem)}px`;
  else if (suffix === "px") v = "1px";
  else if (suffix === "full") v = "100%";
  else if (FRACTIONS[suffix] != null) v = `${FRACTIONS[suffix]}%`;
  else if (suffix === "auto") v = "auto";
  if (v == null) return null;
  return neg && v !== "auto" ? `calc(-1 * ${v})` : v;
}

// box-model prefixes → CSS properties
const BOX = {
  w: ["width"], h: ["height"], size: ["width", "height"],
  min_w: ["min-width"], min_h: ["min-height"], min_size: ["min-width", "min-height"],
  max_w: ["max-width"], max_h: ["max-height"], max_size: ["max-width", "max-height"],
  m: ["margin"], mt: ["margin-top"], mb: ["margin-bottom"], ml: ["margin-left"], mr: ["margin-right"], mx: ["margin-left", "margin-right"], my: ["margin-top", "margin-bottom"],
  p: ["padding"], pt: ["padding-top"], pb: ["padding-bottom"], pl: ["padding-left"], pr: ["padding-right"], px: ["padding-left", "padding-right"], py: ["padding-top", "padding-bottom"],
  inset: ["top", "right", "bottom", "left"], top: ["top"], bottom: ["bottom"], left: ["left"], right: ["right"],
  gap: ["gap"], gap_x: ["column-gap"], gap_y: ["row-gap"], flex_basis: ["flex-basis"],
};
const BOX_PREFIXES = Object.keys(BOX).sort((a, b) => b.length - a.length);

const RADIUS = { none: "0px", xs: 0.125, sm: 0.25, md: 0.375, lg: 0.5, xl: 0.75, "2xl": 1, "3xl": 1.5, full: "9999px" };
const CORNERS = {
  rounded: ["border-radius"], rounded_t: ["border-top-left-radius", "border-top-right-radius"], rounded_b: ["border-bottom-left-radius", "border-bottom-right-radius"],
  rounded_l: ["border-top-left-radius", "border-bottom-left-radius"], rounded_r: ["border-top-right-radius", "border-bottom-right-radius"],
  rounded_tl: ["border-top-left-radius"], rounded_tr: ["border-top-right-radius"], rounded_bl: ["border-bottom-left-radius"], rounded_br: ["border-bottom-right-radius"],
};
const BORDERS = {
  border: ["border-width"], border_t: ["border-top-width"], border_b: ["border-bottom-width"], border_l: ["border-left-width"], border_r: ["border-right-width"],
  border_x: ["border-left-width", "border-right-width"], border_y: ["border-top-width", "border-bottom-width"],
};
const SHADOWS = {
  shadow_none: "none",
  shadow_2xs: "0 1px 0 0 rgba(0,0,0,.05)",
  shadow_xs: "0 1px 2px 0 rgba(0,0,0,.05)",
  shadow_sm: "0 1px 3px 0 rgba(0,0,0,.1), 0 1px 2px -1px rgba(0,0,0,.1)",
  shadow_md: "0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1)",
  shadow_lg: "0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)",
  shadow_xl: "0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1)",
  shadow_2xl: "0 25px 50px -12px rgba(0,0,0,.25)",
};
const TEXT_SIZES = { text_xs: 0.75, text_sm: 0.875, text_base: 1, text_lg: 1.125, text_xl: 1.25, text_2xl: 1.5, text_3xl: 1.875 };
const WEIGHTS = { font_thin: 100, font_extralight: 200, font_light: 300, font_normal: 400, font_medium: 500, font_semibold: 600, font_bold: 700, font_extrabold: 800, font_black: 900 };
const FLAT = {
  flex: { display: "flex" }, block: { display: "block" }, grid: { display: "grid" }, hidden: { display: "none" },
  visible: { visibility: "visible" }, invisible: { visibility: "hidden" },
  relative: { position: "relative" }, absolute: { position: "absolute" },
  flex_row: { "flex-direction": "row" }, flex_row_reverse: { "flex-direction": "row-reverse" }, flex_col: { "flex-direction": "column" }, flex_col_reverse: { "flex-direction": "column-reverse" },
  flex_wrap: { "flex-wrap": "wrap" }, flex_wrap_reverse: { "flex-wrap": "wrap-reverse" }, flex_nowrap: { "flex-wrap": "nowrap" },
  flex_1: { flex: "1 1 0%" }, flex_auto: { flex: "1 1 auto" }, flex_initial: { flex: "0 1 auto" }, flex_none: { flex: "none" },
  flex_grow_0: { "flex-grow": "0" }, flex_grow_1: { "flex-grow": "1" }, flex_grow: { "flex-grow": "1" }, flex_shrink_0: { "flex-shrink": "0" }, flex_shrink_1: { "flex-shrink": "1" }, flex_shrink: { "flex-shrink": "1" },
  items_start: { "align-items": "flex-start" }, items_end: { "align-items": "flex-end" }, items_center: { "align-items": "center" }, items_baseline: { "align-items": "baseline" }, items_stretch: { "align-items": "stretch" },
  justify_start: { "justify-content": "flex-start" }, justify_end: { "justify-content": "flex-end" }, justify_center: { "justify-content": "center" }, justify_between: { "justify-content": "space-between" }, justify_around: { "justify-content": "space-around" }, justify_evenly: { "justify-content": "space-evenly" },
  content_normal: { "align-content": "normal" }, content_center: { "align-content": "center" }, content_start: { "align-content": "flex-start" }, content_end: { "align-content": "flex-end" }, content_between: { "align-content": "space-between" }, content_around: { "align-content": "space-around" }, content_evenly: { "align-content": "space-evenly" }, content_stretch: { "align-content": "stretch" },
  self_start: { "align-self": "flex-start" }, self_end: { "align-self": "flex-end" }, self_flex_start: { "align-self": "flex-start" }, self_flex_end: { "align-self": "flex-end" }, self_center: { "align-self": "center" }, self_baseline: { "align-self": "baseline" }, self_stretch: { "align-self": "stretch" },
  overflow_hidden: { overflow: "hidden" }, overflow_x_hidden: { "overflow-x": "hidden" }, overflow_y_hidden: { "overflow-y": "hidden" },
  overflow_scroll: { overflow: "auto" }, overflow_x_scroll: { "overflow-x": "auto" }, overflow_y_scroll: { "overflow-y": "auto" },
  overflow_scrollbar: { overflow: "auto" }, overflow_x_scrollbar: { "overflow-x": "auto" }, overflow_y_scrollbar: { "overflow-y": "auto" },
  aspect_square: { "aspect-ratio": "1 / 1" },
  text_left: { "text-align": "left" }, text_center: { "text-align": "center" }, text_right: { "text-align": "right" },
  italic: { "font-style": "italic" }, not_italic: { "font-style": "normal" },
  underline: { "text-decoration-line": "underline" }, line_through: { "text-decoration-line": "line-through" }, text_decoration_none: { "text-decoration-line": "none" },
  text_decoration_solid: { "text-decoration-style": "solid" }, text_decoration_wavy: { "text-decoration-style": "wavy" },
  whitespace_normal: { "white-space": "pre-wrap" }, whitespace_nowrap: { "white-space": "pre" },
  truncate: { overflow: "hidden", "white-space": "pre", "text-overflow": "ellipsis", "--trunc": "1" },
  text_ellipsis: { "text-overflow": "ellipsis", "--trunc": "1" }, text_ellipsis_start: { "text-overflow": "ellipsis", "--trunc": "1" }, text_ellipsis_middle: { "text-overflow": "ellipsis", "--trunc": "1" },
  border_dashed: { "border-style": "dashed" },
  h_flex: { display: "flex", "flex-direction": "row", "align-items": "center" }, v_flex: { display: "flex", "flex-direction": "column" },
  col_start_auto: {}, col_end_auto: {}, col_span_full: { "grid-column": "1 / -1" }, row_start_auto: {}, row_end_auto: {}, row_span_full: { "grid-row": "1 / -1" },
};
const IGNORED_NULLARY = /^debug_/;
const CURSORS = {
  cursor_default: "default", cursor_pointer: "pointer", cursor_text: "text", cursor_move: "move", cursor_not_allowed: "not-allowed", cursor_context_menu: "context-menu",
  cursor_crosshair: "crosshair", cursor_vertical_text: "vertical-text", cursor_alias: "alias", cursor_copy: "copy", cursor_no_drop: "no-drop", cursor_grab: "grab",
  cursor_grabbing: "grabbing", cursor_ew_resize: "ew-resize", cursor_ns_resize: "ns-resize", cursor_nesw_resize: "nesw-resize", cursor_nwse_resize: "nwse-resize",
  cursor_col_resize: "col-resize", cursor_row_resize: "row-resize", cursor_n_resize: "n-resize", cursor_e_resize: "e-resize", cursor_s_resize: "s-resize", cursor_w_resize: "w-resize",
};
// Non-visual prelude methods (structure, slots, handles, component config).
const NON_VISUAL = new Set(["child", "children", "map", "when", "content", "trigger", "input", "decrement_button", "increment_button", "image", "fallback", "header", "footer", "panel",
  "track_focus", "track_scroll", "content_focus_handle", "axis", "mode", "anchor", "mouse_button", "scroll_size", "frame_budget", "open_delay", "close_delay", "size_range", "drag_paths",
  "select_tab", "close_panel", "toggle_zoom", "drag_tab", "drop_tab", "toggle_dock", "resize_dock", "focus", "range_style", "cell_style", "cell_active_style", "caret_style",
  "spring", "panel_size", "panel_visible", "__mock_list_truncated"]);

/** Apply one recorded method to a style map. Returns false if the preview cannot map it. */
function applyMethod(ctx, st, name, args) {
  if (FLAT[name]) { Object.assign(st, FLAT[name]); return true; }
  if (CURSORS[name]) { st.cursor = CURSORS[name]; return true; }
  if (SHADOWS[name]) { st["box-shadow"] = SHADOWS[name]; return true; }
  if (TEXT_SIZES[name]) { st["font-size"] = `${round(TEXT_SIZES[name] * ctx.rem)}px`; return true; }
  if (WEIGHTS[name]) { st["font-weight"] = String(WEIGHTS[name]); return true; }
  if (IGNORED_NULLARY.test(name)) return true;
  const a = args[0];
  switch (name) {
    case "bg": st["background-color"] = a; return true;
    case "text_color": st.color = a; return true;
    case "text_bg": st["--tbg"] = a; return true;
    case "border_color": st["border-color"] = a; return true;
    case "text_size": st["font-size"] = len(ctx, a); return true;
    case "font_family": st["font-family"] = fontStack(a); return true;
    case "font_weight": st["font-weight"] = String(a); return true;
    case "line_height": st["line-height"] = typeof a === "number" ? String(a) : len(ctx, a); return true;
    case "opacity": st.opacity = String(Math.max(0, Math.min(1, a))); return true;
    case "flex_grow": st["flex-grow"] = String(a); return true;
    case "flex_shrink": st["flex-shrink"] = String(a); return true;
    case "tooltip": return true; // → title attribute
    default: break;
  }
  if (BOX[name]) { const v = len(ctx, a); for (const p of BOX[name]) st[p] = v; return true; }
  if (CORNERS[name]) { const v = len(ctx, a); for (const p of CORNERS[name]) st[p] = v; return true; }
  if (BORDERS[name]) { const v = typeof a === "number" ? `${round(a * ctx.zoom)}px` : len(ctx, a); for (const p of BORDERS[name]) st[p] = v; return true; }
  // corner presets: rounded_md, rounded_t_lg, ...
  const corner = /^(rounded(?:_(?:t|b|l|r|tl|tr|bl|br))?)_(none|xs|sm|md|lg|xl|2xl|3xl|full)$/.exec(name);
  if (corner) {
    const r = RADIUS[corner[2]];
    const v = typeof r === "string" ? r : `${round(r * ctx.rem)}px`;
    for (const p of CORNERS[corner[1]]) st[p] = v;
    return true;
  }
  // border presets: border_2, border_t_1 (raw px, not zoom-scaled)
  const deco = /^text_decoration_(\d+)$/.exec(name);
  if (deco) { st["text-decoration-thickness"] = `${deco[1]}px`; return true; }
  const border = /^(border(?:_(?:t|b|l|r|x|y))?)_(\d+)$/.exec(name);
  if (border) { for (const p of BORDERS[border[1]]) st[p] = `${border[2]}px`; return true; }
  // box ramps: p_4, w_full, left_neg_2, size_8, gap_x_2, min_w_0 ...
  for (const prefix of BOX_PREFIXES) {
    if (name.startsWith(prefix + "_")) {
      const v = rampLen(ctx, name.slice(prefix.length + 1));
      if (v == null) continue;
      for (const p of BOX[prefix]) st[p] = v;
      return true;
    }
  }
  if (name.startsWith("on_") || BEHAVIORS.has(name) || NON_VISUAL.has(name)) return true;
  return false;
}

function fontStack(name) {
  const n = String(name);
  const mono = /mono|code|courier/i.test(n);
  return `"${n.replace(/"/g, "")}", ${mono ? '"DejaVu Sans Mono", monospace' : '"Inter", "DejaVu Sans", sans-serif'}`;
}

const cssText = (st) => Object.entries(st).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}:${v}`).join(";");

// ---------------------------------------------------------------------------------------------
// motion

const MOTION_CSS = { opacity: "opacity", width: "width", height: "height", left: "left", top: "top" };

function loopAnimation(ctx, [prop, from, to, period, easing]) {
  const name = `lp${++ctx.seq}`;
  // herdr writes loop lengths as raw px (not zoom-scaled); opacity is clamped.
  const v = (x) => (prop === "opacity" ? String(Math.max(0, Math.min(1, x))) : `${x}px`);
  ctx.css.push(`@keyframes ${name}{from{${MOTION_CSS[prop]}:${v(from)}}to{${MOTION_CSS[prop]}:${v(to)}}}`);
  return `${name} ${period / 2}ms ${easing} 0s infinite alternate`;
}

// ---------------------------------------------------------------------------------------------
// tree → HTML

const BASE_TYPES = {
  h_flex: { display: "flex", "flex-direction": "row", "align-items": "center" },
  v_flex: { display: "flex", "flex-direction": "column" },
  list: { display: "flex", "flex-direction": "column", overflow: "hidden" },
  uniform_list: { display: "flex", "flex-direction": "column", overflow: "hidden" },
  v_virtual_list: { display: "flex", "flex-direction": "column", overflow: "hidden" },
  h_virtual_list: { display: "flex", "flex-direction": "row", overflow: "hidden" },
};

/** Render one serialised tree into an HTML fragment (styles inline; keyframes into ctx.css). */
export function treeFragment(tree, ctx) {
  if (!tree) return "";
  if (tree.type === "text") return `<span class="t">${esc(tree.text)}</span>`;
  if (tree.type === "view") return `<div class="e" style="display:contents">${(tree.children ?? []).map((c) => treeFragment(c, ctx)).join("")}</div>`;

  const st = { ...(BASE_TYPES[tree.type] ?? {}) };
  const anims = [];
  const transitions = [];
  let frames = null;
  let spin = null;
  let title = null;
  let classes = ["e"];
  for (const [name, args] of tree.methods ?? []) {
    if (name === "loop") { anims.push(loopAnimation(ctx, args)); continue; }
    if (name === "transition") { const [prop, dur, delay, easing] = args; transitions.push(`${MOTION_CSS[prop]} ${dur}ms ${easing} ${delay}ms`); continue; }
    if (name === "frames") { const [ms, ...list] = args; frames = { ms, list }; continue; }
    if (name === "spin") { spin = args[0]; continue; }
    if (name === "tooltip") title = args[0];
    if (name === "hover" || name === "active") continue;
    if (!applyMethod(ctx, st, name, args)) ctx.unmapped.add(name);
  }
  // state styles → :hover / :active rules (!important beats the inline style)
  for (const [state, list] of Object.entries(tree.state ?? {})) {
    if (state !== "hover" && state !== "active") { for (const [n] of list) ctx.unmapped.add(`${state}:${n}`); continue; }
    const s = {};
    for (const [n, a] of list) if (!applyMethod(ctx, s, n, a)) ctx.unmapped.add(`${state}:${n}`);
    const cls = `st${++ctx.seq}`;
    classes.push(cls);
    ctx.css.push(`.${cls}:${state}{${Object.entries(s).map(([k, v]) => `${k}:${v} !important`).join(";")}}`);
  }
  if (spin) {
    const name = "spin";
    if (!ctx.css.includes("@keyframes spin{to{transform:rotate(360deg)}}")) ctx.css.push("@keyframes spin{to{transform:rotate(360deg)}}");
    anims.push(`${name} ${spin}ms linear infinite`);
  }
  if (anims.length) st.animation = anims.join(",");
  if (transitions.length) st.transition = transitions.join(",");
  if (st["--trunc"]) { classes.push("trunc"); delete st["--trunc"]; }

  const attrs = (extra = "") => `class="${classes.join(" ")}"${tree.id != null ? ` data-id="${esc(tree.id)}"` : ""}${title != null ? ` title="${esc(title)}"` : ""} style="${esc(cssText(st))}"${extra}`;

  if (tree.type === "image" || tree.type === "AvatarImage") {
    const uri = tree.src ? dataUri(tree.src) : null;
    if (!uri) { ctx.missing.add(tree.src); return `<div ${attrs()}></div>`; }
    st["object-fit"] = "contain";
    const size = svgIntrinsic(tree.src);
    if (size) ctx.usesRaster = true;
    return `<img ${attrs(size ? ` data-raster="${Math.round(size.w * 2)}x${Math.round(size.h * 2)}"` : "")} src="${uri}" alt="">`;
  }
  if (tree.type === "svg") {
    const uri = tree.src ? dataUri(tree.src) : null;
    if (!uri) { ctx.missing.add(tree.src); return `<div ${attrs()}></div>`; }
    st["background-color"] = st.color ?? ctx.color ?? ctx.theme?.foreground ?? "currentColor";
    const mask = `url("${uri}") center / contain no-repeat`;
    st["-webkit-mask"] = mask;
    st.mask = mask;
    return `<div ${attrs()}></div>`;
  }
  if (tree.type === "path" && tree.path) return `<div ${attrs()}>${pathSvg(tree.path, ctx)}</div>`;

  let inner;
  const inherited = ctx.color;
  if (st.color) ctx.color = st.color;
  if (frames) {
    ctx.usesFrames = true;
    inner = `<span class="t" data-frames="${esc(JSON.stringify(frames.list))}" data-ms="${frames.ms}">${esc(frames.list[0])}</span>`;
  } else {
    const kids = (tree.children ?? []).map((c) => treeFragment(c, ctx));
    // anchored surfaces show their trigger only; their content opens on interaction
    for (const [slot, sub] of Object.entries(tree.slots ?? {})) if (slot !== "content") kids.unshift(treeFragment(sub, ctx));
    inner = kids.join("");
  }
  ctx.color = inherited;
  return `<div ${attrs()}>${inner}</div>`;
}

function pathSvg(p, ctx) {
  const pct = p.commands.some((c) => c.slice(1).some((x) => typeof x === "string"));
  const num = (x) => (typeof x === "string" ? parseFloat(x) : x * (pct ? 1 : ctx.zoom));
  const d = p.commands.map(([cmd, ...a]) => {
    switch (cmd) {
      case "move_to": return `M${num(a[0])} ${num(a[1])}`;
      case "line_to": return `L${num(a[0])} ${num(a[1])}`;
      case "curve_to": return `Q${num(a[2])} ${num(a[3])} ${num(a[0])} ${num(a[1])}`;
      case "cubic_bezier_to": return `C${num(a[2])} ${num(a[3])} ${num(a[4])} ${num(a[5])} ${num(a[0])} ${num(a[1])}`;
      case "arc_to": return `A${num(a[0])} ${num(a[1])} ${a[2]} ${a[3] ? 1 : 0} ${a[4] ? 1 : 0} ${num(a[5])} ${num(a[6])}`;
      case "close": return "Z";
      default: return "";
    }
  }).join(" ");
  const id = `g${++ctx.seq}`;
  let fill = "#000";
  let defs = "";
  const v = p.paint.values;
  if (p.paint.kind === "solid") fill = v[0];
  else if (p.paint.kind === "linear-gradient") {
    const angle = Number(v[0]);
    const rad = ((angle - 90) * Math.PI) / 180;
    const x = Math.cos(rad) / 2, y = Math.sin(rad) / 2;
    defs = `<defs><linearGradient id="${id}" x1="${0.5 - x}" y1="${0.5 - y}" x2="${0.5 + x}" y2="${0.5 + y}"><stop offset="${v[2]}" stop-color="${v[1]}"/><stop offset="${v[4]}" stop-color="${v[3]}"/></linearGradient></defs>`;
    fill = `url(#${id})`;
  } else ctx.unmapped.add(`paint_path:${p.paint.kind}`);
  const box = pct ? ` viewBox="0 0 100 100" preserveAspectRatio="none"` : "";
  const paint = p.fill ? `fill="${fill}"` : `fill="none" stroke="${fill}" stroke-width="${p.width * ctx.zoom}"`;
  return `<svg width="100%" height="100%"${box} style="position:absolute;inset:0;overflow:visible" opacity="${p.paint.opacity}">${defs}<path d="${d}" ${paint}/></svg>`;
}

// ---------------------------------------------------------------------------------------------
// documents

/** Base CSS for a preview document. */
export function baseCss(ctx) {
  const t = ctx.theme;
  return [
    "*{box-sizing:border-box;margin:0;padding:0;border:0 solid transparent}",
    `html,body{background:${t.canvas ?? t.background};color:${t.foreground};font-family:"Inter","DejaVu Sans",sans-serif;font-size:${ctx.rem}px;line-height:1.45;-webkit-font-smoothing:antialiased}`,
    ".e{position:relative;display:block;flex-shrink:1}",
    ".t{display:block;background-color:var(--tbg,transparent)}",
    ".trunc>.t{overflow:hidden;text-overflow:ellipsis;white-space:pre}",
    // mod text keeps newlines and wraps (GPUI); only inside blocks, so template whitespace stays inert
    ".block{position:relative;overflow:hidden;white-space:pre-wrap}",
  ].join("\n");
}

// SVG images as herdr draws them: one bitmap at 2× the file's intrinsic size, scaled to the box.
// window.__previewReady settles once every one is swapped in (shoot() waits for it).
const RASTER_JS = `<script>window.__previewReady=Promise.all([...document.querySelectorAll("img[data-raster]")].map((el)=>new Promise((done)=>{const [w,h]=el.dataset.raster.split("x").map(Number);const im=new Image();im.onload=()=>{try{const c=document.createElement("canvas");c.width=w;c.height=h;c.getContext("2d").drawImage(im,0,0,w,h);el.onload=()=>done();el.onerror=()=>done();el.src=c.toDataURL("image/png");}catch(e){done();}};im.onerror=()=>done();im.src=el.src;})));</script>`;

const FRAMES_JS = `<script>(()=>{const els=[...document.querySelectorAll("[data-frames]")];if(!els.length)return;const t0=Date.now();const step=()=>{const now=Date.now()-t0;for(const el of els){const l=JSON.parse(el.dataset.frames);el.textContent=l[Math.floor(now/Number(el.dataset.ms))%l.length];}};step();setInterval(step,16);})();</script>`;

/** Wrap body HTML in a standalone document. */
export function documentHtml({ body, ctx, title = "preview", width, height, background }) {
  const unmapped = [...ctx.unmapped].sort();
  const missing = [...ctx.missing].filter(Boolean).sort();
  const sizeCss = width && height ? `html,body{width:${width}px;height:${height}px;overflow:hidden}` : "";
  const bgCss = background ? `html,body{background:${background}}` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
${baseCss(ctx)}
${sizeCss}${bgCss}
${ctx.css.join("\n")}
</style></head>
<body>
${body}
${ctx.usesFrames ? FRAMES_JS : ""}
${ctx.usesRaster ? RASTER_JS : ""}
<!-- preview: unmapped methods: ${unmapped.length ? esc(unmapped.join(", ")) : "none"} -->
<!-- preview: missing assets: ${missing.length ? esc(missing.join(", ")) : "none"} -->
</body></html>
`;
}

/** A block of the given size (logical px × zoom) holding one tree. */
export function blockHtml(tree, ctx, { width, height, background } = {}) {
  const st = { width: width != null ? `${width}px` : "100%", height: height != null ? `${height}px` : "100%" };
  if (background) st.background = background;
  return `<div class="block" style="${cssText(st)}">${treeFragment(tree, ctx)}</div>`;
}

/**
 * One tree → a standalone HTML page of exactly width × height (the block size in window px).
 * Options: { width, height, zoom, theme, title, background }.
 */
export function treeToHtml(tree, { width = 960, height = 240, zoom = 1, theme, title, background } = {}) {
  const ctx = newContext({ zoom, theme });
  const body = blockHtml(tree, ctx, { width, height, background });
  return documentHtml({ body, ctx, title: title ?? tree?.id ?? "preview", width, height });
}

/** The unmapped method names in a tree (for tests and reports). */
export function unmappedMethods(tree, opts = {}) {
  const ctx = newContext(opts);
  treeFragment(tree, ctx);
  return [...ctx.unmapped].sort();
}
