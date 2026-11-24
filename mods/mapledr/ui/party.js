// Role "party": the left-sidebar party list (DESIGN §11.11). It replaces herdr's shipped agents
// list (defaults/mods/agents) in the mapledr layout, so it keeps that list's behaviour:
//  - setAgentOrder(order) in render, so agent.next / agent.prev / agent.select follow the party;
//  - click a row: pane.focus on the agent's pane (plus act("markSeen") so a pending chest counts
//    as seen); hover / selected (focused) styling from the theme; foldable groups;
//  - a hover pin toggle (terminal.pin) like the agents list's;
//  - the rail when the sidebar is narrower than 160 px, with the "»" button that unfolds it
//    (workspace-chrome hides its own toggle on the macOS rail and relies on this one).
// Game additions: 44 px hero rows (status stripe, mini Termling portrait with its program icon,
// name + level, career title + map, HP / XP / Fresh Eyes bars, chips), an off-duty group
// (collapsed, dimmed), and a footer (gold, Snippets, release, Sprint meter, Herd button with the
// digest dot). Right-click a row, click its portrait or its hover sheet button: character sheet.
//
// Chrome follows herdr's theme tokens (kit.T()); game colours appear only where they mean
// something (stripe, bars, chips), deepened on light themes so they stay readable (ink/tone).
//
// The pure renderer is renderParty(vm, env). It only lays out the view model; herdr chrome
// commands (pane.focus, terminal.pin, overlays, layout.resize) run in handlers, never in render.
//
// VM additions (beyond ARCHITECTURE §5; game/view.js supplies them):
/**
 * @typedef {Object} PartyRowAdditions
 * @property {string|null} pane      herdr pane id of the agent (pane.focus target, as the agents
 *                                   list uses); null when off duty. Falls back to {terminal: address}.
 * @property {{hoodie:string, titleBar:string, screen:string, faceInk:string}} colors
 *                                   Termling colours for the portrait (same shape as HeroVM.colors).
 * @property {null|0|1} levelUpAge   0 on the tick the hero levelled up, 1 on the next, else null:
 *                                   the row shimmers cyan once (D§11.8). Ignored in calm mode.
 * @property {boolean} [slim]        a crowded party (game/view decides: more than 12 live rows):
 *                                   one 28 px line (stripe, face screen, name, up to 2 chips, level,
 *                                   a 2 px XP line) with about a third of a full row's elements.
 * @property {string|null} [machine] the machine of a remote agent ("vps" for "vps/t7"), shown as a
 *                                   small dim label like herdr's agents list; null when local.
 * RowVM.status is herdr's status word ("working"|"blocked"|"done"|"idle"); RowVM.chips kinds the
 * renderer knows: "blocked" | "boss" | "review" (text pills), "chest" (icon, click claims; text
 * e.g. "×2" optional), "fork" (icon + count; chip.terminal = the sub-agent a click shows with
 * agent.focus), "star" (icon), "unblocked" (spark icon); any other kind (e.g. "crashed") renders as
 * a text pill in its colour. chip.tooltip (optional string) is the chip's hover text.
 * Rows never move on status, focus or pin changes (D§11.11): a pinned agent keeps its place here
 * (its pin shows as the portrait dot and the stage banner).
 *
 * @typedef {Object} PartyFooterAdditions
 * gold, snippets and release are display strings ("48.2k", "133", "v2.3"); numbers are shown
 * with String(). sprint: null | { label, have, need } (have/need numbers, shown "7/10").
 * digestDot: boolean (something new in the Herd panel's digest).
 *
 * env (renderParty): { width, height, zoom, theme: T(), host, act, ui? } where ui is the role's
 * mutable UI state { toggled:Set<groupKey>, hovered:string|null, size:{w,h}|null }; renderers
 * mutate it from handlers and call cx.notify(). Optional: a fresh state is used when absent.
 */

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, setAgentOrder, openOverlay, layout, focused, shared, setShared, window as herdrWindow } from "herdr";
import { C, T, MONO, art, zoom, alpha, kids, clamp01 } from "./kit.js";

// ---------------------------------------------------------------------------------------------
// Shared chrome helpers (also used by nameplate.js and hud.js)

/** The rail: herdr's sidebar mods switch at this width (agents, spaces, workspace-chrome). */
export const RAIL_PX = 160;

const hex6 = (s) => (typeof s === "string" && /^#[0-9a-fA-F]{6}/.test(s) ? s.slice(1, 7) : null);

/** True when the theme's background is light (paper and friends). */
export function isLight(t) {
  const h = hex6(t?.bg);
  if (!h) return false;
  const n = parseInt(h, 16);
  const ch = (s) => ((n >> s) & 255) / 255;
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0) > 0.5;
}

/** Mix two #rrggbb colours (k = share of b). */
export function mix(a, b, k) {
  const x = hex6(a), y = hex6(b);
  if (!x || !y) return a;
  const p = parseInt(x, 16), q = parseInt(y, 16);
  let out = "#";
  for (const s of [16, 8, 0]) {
    const v = Math.round(((p >> s) & 255) * (1 - k) + ((q >> s) & 255) * k);
    out += v.toString(16).padStart(2, "0");
  }
  return out;
}

/** A game colour as text on herdr's chrome: as is on dark themes, deepened on light ones. */
export function ink(color, t) {
  return isLight(t) ? mix(color, "#000000", 0.45) : color;
}

/** A game colour as a shape (bar fill, stripe): slightly deepened on light themes. */
export function tone(color, t) {
  return isLight(t) ? mix(color, "#000000", 0.18) : color;
}

/** Bar track: the foreground at low alpha reads on both light and dark chrome. */
export function track(t) {
  return alpha(hex6(t.fg) ? `#${hex6(t.fg)}` : "#808080", isLight(t) ? 0.1 : 0.12);
}

/** A program icon (ProgramIcon {path, tint, color}): one-colour glyph tinted, else a picture. */
export function programGlyph(icon, size, color) {
  if (!icon?.path) return null;
  return icon.tint
    ? svg(icon.path).w(size).h(size).flex_none().text_color(color)
    : image(icon.path).w(size).h(size).flex_none();
}

/** A thin bar; extra = { frac, color } is a second segment after the fill (Fresh Eyes). */
export function thinBar(w, h, frac, color, trackColor, extra) {
  const f = clamp01(frac);
  const fill = Math.round(w * f);
  const el = div().relative().w(w).h(h).flex_none().rounded(h >= 4 ? 2 : 1).bg(trackColor).overflow_hidden();
  const parts = [];
  if (fill > 0) parts.push(div().absolute().left(0).top(0).h(h).w(fill).bg(color));
  if (extra && extra.frac > 0) {
    const ew = Math.max(0, Math.min(w - fill, Math.round(w * clamp01(extra.frac))));
    if (ew > 0) parts.push(div().absolute().left(fill).top(0).h(h).w(ew).bg(extra.color));
  }
  return el.children(parts);
}

/** A chip as the sidebar / nameplate shows it. onClick (optional) gets (event, cx). */
export function chipEl(c, t, id, { height = 15, onClick } = {}) {
  const col = ink(c.color, t);
  const text = c.text ? String(c.text) : "";
  // The Forkling count is chrome-grey unless the view colours it (amber: a sub-agent waits for you).
  const quiet = c.kind === "fork" && (!c.color || String(c.color).toUpperCase() === C.idle.toUpperCase());
  const iconChip = (file, size) => {
    // Icons are shapes: only slightly deepened on light themes; their text is ink.
    const el = h_flex().id(id).flex_none().h(height).gap(2).items_center()
      .child(svg(art(file)).w(size).h(size).flex_none().text_color(quiet ? t.muted : tone(c.color, t)));
    return text ? el.child(div().text_size(10).font_family(MONO).text_color(quiet ? t.muted : col).child(text)) : el;
  };
  let el;
  if (c.kind === "chest") el = iconChip("ui/chest.svg", 12);
  else if (c.kind === "fork") el = iconChip("ui/fork.svg", 11);
  else if (c.kind === "star") el = iconChip("ui/star.svg", 11);
  else if (c.kind === "unblocked") el = iconChip("fx/starburst.svg", 12);
  else {
    el = div().id(id).flex_none().h(height).px(5).rounded(4).flex().items_center()
      .bg(alpha(c.color, isLight(t) ? 0.2 : 0.16)).text_size(10).font_semibold().text_color(col).child(text);
  }
  if (onClick) el = el.cursor_pointer().rounded(4).hover((s) => s.bg(t.hover)).on_click(onClick);
  if (typeof c.tooltip === "string" && c.tooltip) el = el.tooltip(c.tooltip);
  else if (onClick && c.kind === "chest") el = el.tooltip("Open the chest");
  return el;
}

/** The mini Termling portrait (head crop): hoodie frame, title bar, screen with the live face. */
export function portrait(id, r, size, t, { calm = false, pinned = false } = {}) {
  const col = r.colors ?? DEFAULT_COLORS;
  const S = size;
  const inner = S - 3; // inside the 1.5 px border
  const bar = Math.max(4, Math.round(S * 0.19));
  const face = String(r.face ?? "-_-");
  // A working hero's cursor blinks (ARCHITECTURE §6.2), on a dedicated leaf: frames() replaces
  // the children. Same rule as the stage's rig: only the plain ">_" face blinks.
  const blink = !calm && r.status === "working" && face === ">_";
  const faceEl = div().text_size(S >= 30 ? 10 : 9).font_family(MONO).font_bold().line_height(1).text_color(col.faceInk);
  const head = div().absolute().left(0).top(0).size(S).rounded(Math.round(S * 0.22)).bg(col.hoodie)
    .border(1.5).border_color(r.focused ? t.accent : "#00000048")
    .child(div().absolute().left(2).top(2).w(inner - 4).h(bar).rounded(2).bg(col.titleBar))
    .child(h_flex().absolute().left(2).top(bar + 3).w(inner - 4).h(inner - bar - 5).rounded(2).bg(col.screen).justify_center()
      .child(blink ? faceEl.frames([">_", "> "], 530) : faceEl.child(face)));
  const box = div().id(id).relative().size(S + 4).flex_none().child(head);
  const badge = programGlyph(r.programIcon, S >= 30 ? 9 : 8, r.programIcon?.color ?? "#ffffff");
  if (badge) {
    const b = S >= 30 ? 14 : 12;
    box.child(h_flex().absolute().left(S + 4 - b).top(S + 4 - b).size(b).rounded(4).bg("#1c1d21")
      .border(1.5).border_color(t.chrome).justify_center().child(badge));
  }
  if (pinned) box.child(div().absolute().left(S - 6).top(-1).size(8).rounded_full().bg(t.accent).border(1.5).border_color(t.chrome));
  return box;
}

const DEFAULT_COLORS = { hoodie: "#6C8CF5", titleBar: "#33384A", screen: "#17161F", faceInk: "#8A8F98" };

// ---------------------------------------------------------------------------------------------
// Herdr chrome commands (handlers only)

// The GameHost's dialog registry (main.js hands it over from init): with it, a click on the hero
// whose sheet is already open keeps that sheet instead of opening a second one that the registry
// then closes (a flicker). Without it (role tests, a renderer alone) the dialogs open directly.
let dialogs = null;
/** main.js: route openSheet/openHerd through host.openSheet/openHerd (one dialog of each kind). */
export function useDialogs(host) {
  dialogs = host && typeof host.openSheet === "function" && typeof host.openHerd === "function" ? host : null;
}

/** The character sheet dialog for one hero (ARCHITECTURE §4). */
export function openSheet(heroId) {
  if (dialogs) return dialogs.openSheet(heroId);
  return openOverlay({ mod: "mapledr", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId } });
}

/** The Herd panel dialog; `tab` (optional) asks it to open on that tab (e.g. "settings"). */
export function openHerd(tab) {
  if (dialogs) return dialogs.openHerd(tab);
  return openOverlay({ mod: "mapledr", kind: "dialog", width: 760, height: 520, props: tab ? { role: "herd", tab } : { role: "herd" } });
}

/** Focus an agent's pane the way herdr's agents list does. */
export function focusAgent(pane, address) {
  if (pane) run("pane.focus", { pane });
  else if (address) run("pane.focus", { terminal: address });
}

/**
 * Key commands that reached this copy (mapledr.sheet / .herd / .calm). Every chrome role answers
 * them the same way, so whichever copy claims the command handles it. Returns true if handled.
 */
export function chromeCommand(name, host) {
  if (name === "herd") { openHerd(); return true; }
  if (name === "sheet") {
    const f = focused();
    const vm = f?.terminal ? host?.view?.("nameplate", { terminal: f.terminal, pane: f.pane ?? null }) : null;
    if (vm && vm.heroId != null) openSheet(vm.heroId);
    else openHerd("roster");
    return true;
  }
  if (name === "calm") {
    // HudVM carries calm and is the cheapest view (memoised per world version; no rows).
    const vm = host?.view?.("hud", { nowMs: Date.now() });
    host?.command?.("setting", { key: "calm", value: !(vm?.calm ?? false) });
    return true;
  }
  return false;
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** The sidebar's width from the layout (what herdr's sidebar mods go by), or null. */
export function sidebarPx() {
  const px = findNode(layout(), "sidebar")?.size?.px;
  return typeof px === "number" ? px : null;
}

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
// Same as herdr's agents list and workspace-chrome, which read the same shared keys.
function toggleSidebar() {
  const width = sidebarPx();
  const narrow = (width ?? Infinity) < RAIL_PX;
  if (!narrow) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow);
  run("layout.resize", { id: "sidebar", px: narrow ? (shared("sidebar.width") ?? 268) : herdrWindow()?.platform === "macos" ? 76 : 44 });
}

// ---------------------------------------------------------------------------------------------
// Pure renderer

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

/**
 * Build the party sidebar from a PartyVM (or null while loading).
 * @param {object|null} vm PartyVM (ARCHITECTURE §5 + additions above)
 * @param {{width:number, height:number, zoom:number, theme:object, host:object, act:Function, ui?:object}} env
 */
export function renderParty(vm, env) {
  const t = env.theme ?? T();
  const ui = env.ui ?? { toggled: new Set(), hovered: null, size: null };
  const width = env.width ?? 268;
  const compact = !!vm?.compact || width < RAIL_PX;
  const root = v_flex().id("party").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
    .on_size_change((s, cx) => {
      const z = env.zoom || 1;
      const w = Math.round(s.width / z), h = Math.round(s.height / z);
      if (!ui.size || ui.size.w !== w || ui.size.h !== h) { ui.size = { w, h }; cx.notify(); }
    });

  if (!vm) {
    return root.when(!compact, (el) => el.child(header(t, null, env)))
      .child(div().px(compact ? 0 : 16).pt(compact ? 12 : 0).text_size(12).text_color(t.dim).when(compact, (el) => el.text_center()).child(compact ? "…" : "Loading the party…"));
  }

  const rows = [];
  if (compact) {
    // The rail lists live agents only (like herdr's rail); off-duty heroes wait in the wide view.
    for (const g of vm.groups) if (!g.offDuty) for (const r of g.rows) rows.push(railRow(r, g, vm, env, t));
  } else {
    for (const g of vm.groups) {
      const folded = g.offDuty !== ui.toggled.has(g.key); // off duty starts folded
      rows.push(groupHeader(g, folded, ui, t));
      if (!folded) for (const r of g.rows) rows.push(r.slim ? slimRow(r, g, vm, env, ui, t, width) : heroRow(r, g, vm, env, ui, t, width));
    }
  }
  const empty = vm.groups.every((g) => g.rows.length === 0);

  return root
    .when(!compact, (el) => el.child(header(t, vm, env)))
    .when(empty && !compact, (el) => el.child(div().px(16).pb(8).text_size(12).text_color(t.dim)
      .child("No heroes yet. Every coding agent that reports its status joins the party as a Termling.")))
    .child(v_flex().id("party-list").flex_1().min_h(0).px(compact ? 0 : 8).pt(compact ? 6 : 0).pb(4).overflow_y_scrollbar().children(rows))
    .child(compact ? railFooter(vm, env, t) : footer(vm, env, t, width));
}

function header(t, vm, env) {
  const calm = !!vm?.calm;
  return h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().gap(6)
    .child(div().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.dim).child(String(vm?.title ?? "Party")))
    .when(Boolean(vm), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(String(vm.count))))
    .child(div().flex_1())
    .when(Boolean(vm), (el) => el.child(div().id("party-calm").p(2).rounded(4).cursor_pointer()
      .text_color(calm ? t.accent : t.dim)
      .hover((s) => s.bg(t.hover).text_color(calm ? t.accent : t.fg))
      .tooltip(calm ? "Calm mode is on: click to turn it off" : "Calm mode: no damage numbers, banners or blinking")
      .on_click((_e, cx) => { cx.stop_propagation(); env.act?.("setting", { key: "calm", value: !calm }); })
      .child(svg(art("ui/calm.svg")).w(14).h(14))));
}

function groupHeader(g, folded, ui, t) {
  const top = g.rows.reduce((m, r) => ((RANK[r.status] ?? 0) > (RANK[m] ?? 0) ? r.status : m), null);
  const dot = folded && !g.offDuty && top && top !== "idle";
  return h_flex().id(`pg-${g.key}`).px(8).pt(8).h(30).flex_none().gap(6).items_center()
    .text_size(11).font_medium().text_color(t.dim).cursor_pointer()
    .hover((s) => s.text_color(t.fg))
    .on_click((_e, cx) => {
      if (ui.toggled.has(g.key)) ui.toggled.delete(g.key);
      else ui.toggled.add(g.key);
      cx.notify();
    })
    .child(div().min_w(0).truncate().child(String(g.name ?? "")))
    .when(folded || g.offDuty, (el) => el.child(div().flex_none().child(String(g.rows.length))))
    .child(div().flex_1())
    .when(dot, (el) => el.child(div().size(7).flex_none().rounded_full().bg(tone(statusColor(top), t))))
    .child(div().flex_none().w(10).text_size(10).text_center().child(folded ? "▸" : "▾"));
}

function statusColor(status) {
  return { working: C.working, blocked: C.blocked, done: C.done, idle: C.idle }[status] ?? C.idle;
}

/** Click a row: count it as seen, then focus the agent (off duty: open the sheet). */
function clickRow(r, env) {
  return (_e, cx) => {
    if (!r.address) { openSheet(r.heroId); return; }
    env.act?.("markSeen", { heroId: r.heroId });
    focusAgent(r.pane, r.address);
  };
}

function heroRow(r, g, vm, env, ui, t, width) {
  const hovered = ui.hovered === r.key;
  const dimName = r.status === "idle" && !r.focused;
  // Inner width of the text column: list px 8×2, row pl 4 / pr 8, stripe 3, portrait 36, gaps 2×8.
  const mid = Math.max(64, Math.round(width - 16 - 12 - 3 - 36 - 16));
  const hpW = Math.round(mid * 0.36);
  const xpW = mid - hpW - 4;
  const shimmer = !vm.calm && (r.levelUpAge === 0 || r.levelUpAge === 1);
  const sub = [r.careerTitle, r.mapLabel].filter(Boolean).join(" · ");

  const right = hovered ? rowButtons(r, t) : levelText(r, t);
  const chips = rowChips(r, env, t, r.chips.length);

  return h_flex().id(`pr-${r.key}`).relative().h(44).flex_none().pl(4).pr(8).gap(8).items_center().rounded(8)
    .when(r.focused, (el) => el.bg(t.selected))
    .when(g.offDuty, (el) => el.opacity(0.62))
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(String(r.tooltip ?? r.name ?? ""))
    .on_hover((on, cx) => {
      if (on) ui.hovered = r.key;
      else if (ui.hovered === r.key) ui.hovered = null;
      cx.notify();
    })
    .on_click(clickRow(r, env))
    .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openSheet(r.heroId); })
    .children(kids([
      shimmer ? div().id(`pl-${r.key}`).absolute().left(0).top(0).size_full().rounded(8).bg(alpha(C.xp, isLight(t) ? 0.3 : 0.2))
        .opacity(r.levelUpAge === 0 ? 1 : 0).transition("opacity", { duration: 800, easing: "ease-out" }) : null,
      div().w(3).h(30).flex_none().rounded(2).bg(tone(r.stripe, t)),
      portrait(`pp-${r.key}`, r, 32, t, { calm: vm.calm, pinned: r.pinned })
        .cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); openSheet(r.heroId); }),
      v_flex().flex_1().min_w(0)
        .child(h_flex().h(16).gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(dimName ? t.muted : t.fg).child(String(r.name ?? "")))
          .when(Boolean(r.machine), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(String(r.machine))))
          .child(right))
        .child(h_flex().h(15).gap(4).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(sub))
          .children(chips))
        .child(h_flex().mt(3).gap(4).items_center()
          .child(thinBar(hpW, 3, r.hpFrac, tone(C.hp, t), track(t)))
          .child(thinBar(xpW, 3, r.xpFrac, tone(C.xp, t), track(t), { frac: r.feFrac, color: tone(C.fresh, t) }))),
    ]));
}

/** The hovered row's buttons: character sheet, and pin / unpin for a live agent (terminal.pin). */
function rowButtons(r, t) {
  return h_flex().flex_none().gap(2).items_center()
    .child(rowButton(`ps-${r.key}`, t, "Character sheet", (_e, cx) => { cx.stop_propagation(); openSheet(r.heroId); },
      svg(art("ui/sheet.svg")).w(13).h(13)))
    // The party never re-sorts (D§11.11), so a pin does not move the row: it plants the hero's
    // banner (+5% XP for its room) and pins the terminal in herdr's other agent lists.
    .when(Boolean(r.address), (el) => el.child(rowButton(`pn-${r.key}`, t,
      r.pinned ? "Unpin terminal" : "Pin terminal: its hero carries a banner (+5% XP for its room)", (_e, cx) => {
        cx.stop_propagation();
        run("terminal.pin", { terminal: r.address, pinned: !r.pinned });
      }, pinGlyph(r.pinned ? t.accent : t.dim))));
}

function levelText(r, t) {
  return div().flex_none().text_size(10.5).font_family(MONO).text_color(t.muted).child(`Lv ${r.level}`);
}

/**
 * A row's chips (at most `max`): the chest claims it, the Forkling count shows the first blocked
 * (else working) sub-agent with agent.focus, as herdr's agents list does for its sub-agent rows.
 */
function rowChips(r, env, t, max, opts) {
  const list = (r.chips ?? []).slice(0, max);
  return list.map((c) => {
    let onClick = null;
    if (c.kind === "chest") onClick = (_e, cx) => { cx.stop_propagation(); env.act?.("claimChest", { heroId: r.heroId }); };
    else if (c.kind === "fork" && c.terminal) onClick = (_e, cx) => { cx.stop_propagation(); run("agent.focus", { terminal: String(c.terminal) }); };
    return chipEl(c, t, `pc-${c.key}`, onClick ? { ...opts, onClick } : { ...opts });
  });
}

/**
 * A slim row (RowVM.slim: a crowded party): one 28 px line with the status stripe, the face screen
 * (click: sheet; a pinned agent's dot on its corner), name, machine, up to two chips and the level
 * (hover: the row buttons), and a 2 px XP bar along the bottom. About 10 elements instead of 24, so
 * 30 heroes stay well inside the render budget.
 */
const XP_LEFT = 4 + 3 + 6 + 28 + 6; // row pl, stripe, gap, face screen, gap

function slimRow(r, g, vm, env, ui, t, width) {
  const hovered = ui.hovered === r.key;
  const dimName = r.status === "idle" && !r.focused;
  const col = r.colors ?? DEFAULT_COLORS;
  const face = String(r.face ?? "-_-");
  const blink = !vm.calm && r.status === "working" && face === ">_";
  const shimmer = !vm.calm && (r.levelUpAge === 0 || r.levelUpAge === 1);
  // the XP line spans the text column: list px 8×2, row pl 4 / pr 8, stripe 3, face 28, gaps 2×6
  const lineW = Math.max(40, Math.round(width - 16 - 12 - 3 - 28 - 12));
  const xpW = Math.round(lineW * clamp01(r.xpFrac));
  const screen = div().id(`pp-${r.key}`).flex_none().w(28).h(18).rounded(4).bg(col.screen)
    .border(1.5).border_color(r.focused ? t.accent : col.hoodie)
    .flex().items_center().justify_center()
    .text_size(9).font_family(MONO).font_bold().line_height(1).text_color(col.faceInk)
    .cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); openSheet(r.heroId); });
  return h_flex().id(`pr-${r.key}`).relative().h(28).flex_none().pl(4).pr(8).gap(6).items_center().rounded(6)
    .when(r.focused, (el) => el.bg(t.selected))
    .when(g.offDuty, (el) => el.opacity(0.62))
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(String(r.tooltip ?? r.name ?? ""))
    .on_hover((on, cx) => {
      if (on) ui.hovered = r.key;
      else if (ui.hovered === r.key) ui.hovered = null;
      cx.notify();
    })
    .on_click(clickRow(r, env))
    .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openSheet(r.heroId); })
    .children(kids([
      shimmer ? div().id(`pl-${r.key}`).absolute().left(0).top(0).size_full().rounded(6).bg(alpha(C.xp, isLight(t) ? 0.3 : 0.2))
        .opacity(r.levelUpAge === 0 ? 1 : 0).transition("opacity", { duration: 800, easing: "ease-out" }) : null,
      div().w(3).h(18).flex_none().rounded(2).bg(tone(r.stripe, t)),
      blink ? screen.frames([">_", "> "], 530) : screen.child(face),
      div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(dimName ? t.muted : t.fg).child(String(r.name ?? "")),
      r.machine ? div().flex_none().text_size(10).text_color(t.dim).child(String(r.machine)) : null,
      ...rowChips(r, env, t, 2, { height: 14 }),
      hovered ? rowButtons(r, t) : levelText(r, t),
      r.pinned ? div().absolute().left(4 + 3 + 6 + 28 - 5).top(3).size(7).rounded_full().bg(t.accent).border(1.5).border_color(t.chrome) : null,
      // the XP bar: a faint track with the fill on top, so it never reads as an underline
      div().absolute().left(XP_LEFT).bottom(2).h(2).w(lineW).rounded(1).bg(track(t))
        .when(xpW > 0, (el) => el.child(div().absolute().left(0).top(0).h(2).w(xpW).rounded(1).bg(tone(C.xp, t)))),
    ]));
}

function rowButton(id, t, tip, onClick, glyph) {
  return div().id(id).flex_none().p(2).rounded(4).text_color(t.dim).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.fg))
    .tooltip(tip)
    .on_click(onClick)
    .child(glyph);
}

/** A 13 px push pin drawn from two divs (no shared icon for it in our art). */
function pinGlyph(color) {
  return div().relative().size(13)
    .child(div().absolute().left(3.5).top(1).size(6).rounded_full().bg(color))
    .child(div().absolute().left(5.75).top(6).w(1.5).h(6).rounded(1).bg(color));
}

function railRow(r, g, vm, env, t) {
  return h_flex().id(`pr-${r.key}`).relative().h(40).flex_none().mx(2).rounded(8).justify_center()
    .when(r.focused, (el) => el.bg(t.selected))
    .when(g.offDuty, (el) => el.opacity(0.62))
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(String(r.tooltip ?? r.name ?? ""))
    .on_click(clickRow(r, env))
    .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openSheet(r.heroId); })
    .child(div().absolute().left(1).top(8).w(3).h(24).rounded(2).bg(tone(r.stripe, t)))
    .child(portrait(`pp-${r.key}`, r, 28, t, { calm: vm.calm, pinned: r.pinned }));
}

function stat(icon, color, value, t, tip) {
  return h_flex().flex_none().gap(4).items_center().tooltip(tip)
    .child(svg(art(icon)).w(12).h(12).flex_none().text_color(color))
    .child(div().font_family(MONO).text_size(11).text_color(t.fg).child(String(value)));
}

function herdButton(vm, t, compact) {
  const dot = !!vm.footer?.digestDot;
  return h_flex().id("party-herd").relative().flex_none().h(24).px(compact ? 0 : 8).gap(5).items_center().justify_center()
    .when(compact, (el) => el.w(32))
    .rounded(6).bg(t.raised).text_color(t.muted).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.fg))
    .tooltip(dot ? "Herd panel: something new in the digest" : "Herd panel: upgrades, stash, bosses, roster")
    .on_click((_e, cx) => { cx.stop_propagation(); openHerd(); })
    .child(svg(art("ui/herd.svg")).w(13).h(13).flex_none())
    .when(!compact, (el) => el.child(div().text_size(11.5).font_medium().child("Herd")))
    .when(dot, (el) => el.child(div().absolute().top(3).right(3).size(6).rounded_full().bg(t.accent)));
}

/**
 * What fits in the footer's first row at this sidebar width. Every item there is flex_none, so
 * without this the Herd button is pushed past the edge (clipped) below ~270 px. Widths are
 * estimated (JetBrains Mono 11 px: 0.6 em = 6.6 px a character; icon 12 + gap 4; gear 21; Herd 61 or 32
 * icon-only; gaps 10; padding 24). Optional parts drop in order: release, Herd label, Snippets.
 */
export function footerFit(f, width) {
  const est = (v) => String(v ?? "").length * 6.6;
  const stat = (v) => 16 + est(v);
  const on = { release: Boolean(f.release), label: true, snippets: true };
  const need = () => {
    const items = [stat(f.gold ?? 0), on.snippets ? stat(f.snippets ?? 0) : null, on.release ? est(f.release) : null, 0, 21, on.label ? 61 : 32]
      .filter((w) => w !== null);
    return 24 + items.reduce((a, w) => a + w, 0) + 10 * (items.length - 1);
  };
  for (const k of ["release", "label", "snippets"]) if (on[k] && need() > width) on[k] = false;
  return on;
}

function footer(vm, env, t, width) {
  const f = vm.footer ?? {};
  const sp = f.sprint;
  const fit = footerFit(f, width);
  return v_flex().flex_none().px(12).pt(8).pb(10).gap(7).border_t(1).border_color(t.border)
    .child(h_flex().h(24).gap(10).items_center()
      .child(stat("ui/gold.svg", tone(C.coin, t), f.gold ?? 0, t, "Gold"))
      .when(fit.snippets, (el) => el.child(stat("ui/snippet.svg", t.muted, f.snippets ?? 0, t, "Snippets")))
      .when(fit.release, (el) => el.child(div().flex_none().text_size(11).font_family(MONO).text_color(t.dim)
        .tooltip("Release Train: the herd's version").child(String(f.release))))
      .child(div().flex_1())
      .child(div().id("party-settings").flex_none().p(4).rounded(6).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.fg))
        .tooltip("Settings")
        .on_click((_e, cx) => { cx.stop_propagation(); openHerd("settings"); })
        .child(svg(art("ui/gear.svg")).w(13).h(13)))
      .child(herdButton(vm, t, !fit.label)))
    .when(Boolean(sp), (el) => el.child(h_flex().h(14).gap(6).items_center().text_size(11)
      .tooltip(`Sprint: ${sp.label} ${sp.have}/${sp.need}`)
      .child(div().flex_none().text_color(t.dim).child("Sprint"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(sp.label))
      .child(thinBar(44, 4, sp.need > 0 ? sp.have / sp.need : 0, t.accent, track(t)))
      .child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.dim).child(`${sp.have}/${sp.need}`))));
}

function railFooter(vm, env, t) {
  return v_flex().flex_none().pt(6).gap(2).items_center().border_t(1).border_color(t.border)
    .child(herdButton(vm, t, true))
    // On the macOS rail the traffic lights fill workspace-chrome's row: this » unfolds the sidebar.
    .child(h_flex().h(28).items_center().justify_center()
      .child(div().id("party-unfold").text_size(13).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.fg))
        .tooltip("Unfold the sidebar")
        .on_click((_e, cx) => { cx.stop_propagation(); toggleSidebar(); })
        .child("»")));
}

// ---------------------------------------------------------------------------------------------
// Role

export default class Party {
  init(props, cx, host) {
    this.props = props ?? {};
    this.host = host ?? null;
    this.ui = { toggled: new Set(), hovered: null, size: null };
  }

  /** Logical width: measured, else the layout's sidebar width, else herdr's default 268. */
  width() {
    return this.ui.size?.w ?? sidebarPx() ?? 268;
  }

  render(cx) {
    const host = this.host;
    const width = this.width();
    const vm = host?.view?.("party", { width, nowMs: Date.now() }) ?? null;
    // Like herdr's agents list: the shown order drives agent.next / agent.prev / agent.select.
    if (vm && Array.isArray(vm.agentOrder)) setAgentOrder(vm.agentOrder);
    return renderParty(vm, {
      width, height: this.ui.size?.h ?? 460, zoom: zoom(), theme: T(), host,
      act: (name, args) => host?.command?.(name, args), ui: this.ui,
    });
  }

  command(name) {
    return chromeCommand(name, this.host);
  }
}
