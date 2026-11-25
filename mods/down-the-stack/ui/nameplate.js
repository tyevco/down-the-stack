// Role "nameplate": the pane header (DESIGN §11.12). It replaces herdr's shipped pane header
// (defaults/mods/pane) in the Down-the-Stack layout, so it keeps all of that mod's behaviour:
//  - finds its pane with panes().find(p => p.pane === props().pane); renders div() if absent;
//  - click: pane.focus; on hover, the split right / split down / zoom (unzoom) / close buttons,
//    each stopping propagation so the click doesn't also focus;
//  - a border on the side facing the terminal (bottom border for a top header, top border for a
//    bottom one, read from the layout's pane frame); the focus ring itself is the frame's.
// For an agent pane with a hero (host.view("nameplate", {terminal, pane}) returns a PlateVM) it
// shows the hero's nameplate: program icon, the Termling's screen with its live face, name, level,
// career title, a contractor tag, then herdr's own terminal title and folder (its text unchanged;
// it truncates, its whole text in its tooltip), 48 px HP and 64 px XP bars (with the Fresh Eyes
// segment; 28 / 36 px in a split, down to about 420 px) and the status chip. Clicking the hero part
// focuses the pane and opens the character sheet. Narrow
// panes drop optional parts (see plan()); below 360 px the hero's name goes and the terminal title
// stays next to the program icon and the face ("Lv 14" only while the title keeps its room), so
// the header still says which task the pane is, as herdr's own header does at any width; below
// 200 px only the face and the chip's short form remain. With a null VM (not an agent pane, or
// the world still loading) it is exactly herdr's plain header.
//
// VM additions (beyond ARCHITECTURE §5 PlateVM; game/view.js supplies them):
/**
 * @typedef {Object} PlateAdditions
 * @property {string} face           the Termling's face glyph (">_", "o_o", "^_^", "-_-", ":(", ">_<")
 * @property {string} status         herdr's status word: "working"|"blocked"|"done"|"idle" (the
 *                                   face blinks while working, unless calm)
 * @property {{hoodie:string, titleBar:string, screen:string, faceInk:string}} colors  HeroVM.colors
 * @property {boolean} calm          calm mode (no blinking face)
 * PlateVM.programIcon is {path, tint, color} or null (null: the pane's own program icon is used).
 * PlateVM.chip.color is a game colour (grey / red / amber / gold per D§11.12); PlateVM.chip.short
 * (optional) is the chip's text on a very narrow header (e.g. "!" for "! waiting").
 *
 * env (renderNameplate): { width, height, zoom, theme: T(), host, act, pane: PaneInfo|null,
 *   bottom: boolean (header under the terminal), home: string|null (to shorten the folder),
 *   ui?: { hovered:boolean, size:{w,h}|null, bars?:false|"full"|"compact" } } — ui is mutated by
 *   handlers (bars: the last plan's, for its hysteresis), then cx.notify().
 */

import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, run, home, layout } from "herdr";
import { T, MONO, art, zoom, alpha, kids } from "./kit.js";
import { ink, track, tone, thinBar, programGlyph, openSheet, chromeCommand } from "./party.js";

/**
 * Width tiers (logical px): the compact HP/XP bars from `bars` (a split pane), the full ones from
 * `fullBars` when the whole title fits beside them too; below `name` the hero's name, career and
 * folder go (icon, face, terminal title, chip; "Lv N" while the title has room); below `micro`
 * only the face and the short chip.
 */
export const TIERS = { bars: 420, fullBars: 480, name: 360, micro: 200 };
/** The terminal title keeps at least this much room before optional parts show (see plan()). */
const MIN_TITLE = 100;
const TITLE_WANT = 220;
const NAME_MAX = 170;
/** A name truncates no further than this (hovered, to 40, so the pane buttons stay inside). */
const NAME_FLOOR = 72;
/** The full bars' test reserves this for the status chip (its common widest forms, "! waiting 59m"). */
const CHIP_RESERVE = 100;
/** The compact bars' test reserves this for the chip's short form ("! 59m", "BOSS 41%", "2-2"). */
const CHIP_SHORT_RESERVE = 64;
/** Beside the compact bars the terminal title keeps at least this (it truncates; its tooltip has it all). */
const TITLE_FLOOR = 40;
/** Bars already shown stay until the title's room falls this far under what it wants. */
const BARS_HYSTERESIS = 24;
/** The bars' widths: full, and compact (a split pane, owner decision round 4). */
export const BAR_PX = { full: { hp: 48, xp: 64 }, compact: { hp: 28, xp: 36 } };
// label "HP" 11 + gap 3 + bar, gap 6, label "XP" 11 + gap 3 + bar, gap before them 8
const barsCost = (b) => 11 + 3 + b.hp + 6 + 11 + 3 + b.xp + 8;
/** Width estimates per character: the bold / medium hero name, the chip, the terminal title. */
const NAME_PX = 7.2;

// herdr's own text spinner (peek / worktree mods), so no other mod's asset is needed.
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Match the first visible tab frame, including the active child of a stack (as the pane mod does).
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter((child) => !child.hidden);
    children = [visible.find((child) => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

/** herdr's Program {icon, tint} glyph, as the pane mod draws it. */
function herdrIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).w(size).h(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd, h) {
  if (!cwd) return "";
  if (!h) return cwd;
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// The pane mod's hover buttons (split right, split down, zoom, close), with our own icons.
function buttons(t, p) {
  const pane = p.pane;
  // A background hover only: herdr fixes an svg's colour when it builds the element (herdr's own
  // pane header asks for a hover text colour that never reaches its icons either).
  const button = (id, icon, command, args, tip) => div().id(id).flex_none().p(3).rounded(4).text_color(t.dim).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(tip)
    .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
    .child(svg(art(`ui/${icon}.svg`)).w(14).h(14));
  return [
    button(`ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }, "Split right"),
    button(`ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }, "Split down"),
    button(`ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }, p.zoomed ? "Show all panes" : "Zoom"),
    button(`ph-x-${pane}`, "close", "pane.close", { pane }, "Close"),
  ];
}

/** The header's frame: full size, background, the border facing the terminal, hover + click. */
function frame(env, t, ui) {
  const p = env.pane;
  return h_flex().id(`pane-head-${p.pane}`).size_full().px(10).gap(8).items_center().overflow_hidden()
    .bg(t.bg)
    .when(!!env.bottom, (el) => el.border_t(1))
    .when(!env.bottom, (el) => el.border_b(1))
    .border_color(t.border)
    .text_size(12)
    .on_size_change((s, cx) => {
      const z = env.zoom || 1;
      const w = Math.round(s.width / z), h = Math.round(s.height / z);
      if (!ui.size || ui.size.w !== w || ui.size.h !== h) { ui.size = { w, h }; cx.notify(); }
    })
    .on_hover((hovered, cx) => { ui.hovered = hovered; cx.notify(); })
    .on_click(() => run("pane.focus", { pane: p.pane }));
}

/** Exactly herdr's plain pane header (defaults/mods/pane): icon, name, folder, status, buttons. */
function plainHeader(env, t, ui) {
  const p = env.pane;
  const name = p.name || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
  const pic = herdrIcon(p.program, 14, t.dim);
  const st = p.status;
  return frame(env, t, ui).children(kids([
    pic,
    div().flex_none().truncate().max_w(260).font_medium().text_color(t.fg).child(name),
    div().flex_1().min_w(0).truncate().text_color(t.dim).child(folder(p.cwd, env.home)),
    st === "working" ? div().flex_none().w(12).text_size(12).text_color(t.working).frames(SPIN, 90) : null,
    st === "blocked" ? div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(alpha(t.blocked, 0.15))
      .text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you") : null,
    st === "done" ? div().size(7).flex_none().rounded(4).bg(t.done) : null,
    ...(ui.hovered ? buttons(t, p) : []),
  ]));
}

/** The Termling's screen: hoodie-coloured frame around the face glyph. */
function faceScreen(vm, t) {
  const col = vm.colors ?? { hoodie: "#6C8CF5", screen: "#17161F", faceInk: "#8A8F98" };
  const face = String(vm.face ?? "-_-");
  // Only the plain ">_" face blinks, as on the stage's rig.
  const blink = !vm.calm && vm.status === "working" && face === ">_";
  const glyph = div().text_size(10).font_family(MONO).font_bold().line_height(1).text_color(col.faceInk);
  return h_flex().flex_none().h(18).min_w(28).px(4).rounded(5).bg(col.screen).border(2).border_color(col.hoodie).justify_center()
    .child(blink ? glyph.frames([">_", "> "], 530) : glyph.child(face));
}

/**
 * What fits in a hero header of width W (logical px). herdr's own terminal title keeps its text
 * (D§11.12) and truncates, its whole text in its tooltip; the HP/XP bars come in two sizes:
 *  - full (48 / 64 px): from TIERS.fullBars when the whole title (its estimated width, up to
 *    TITLE_WANT) fits beside them, judged with the name at NAME_MAX and the chip at CHIP_RESERVE;
 *  - compact (28 / 36 px), otherwise (a split, owner decision round 4): from about TIERS.bars,
 *    where the title still keeps TITLE_FLOOR with the name at NAME_FLOOR and the chip in its short
 *    form (CHIP_SHORT_RESERVE). The title truncates sooner instead.
 * Both are judged on the pane's width and title alone, whatever the name and the status chip are
 * now, so equal panes with equal titles match and a status change never moves the title; a hover
 * never toggles them. Bars already shown (`prevBars`: true or "full", or "compact") stay until the
 * title's room falls BARS_HYSTERESIS under what they need, so a retitle (or a drag across the
 * threshold) does not flicker them. Beside compact bars the chip takes its short form when its
 * full text would leave the title under MIN_TITLE. Then career title and contractor tag drop while
 * the title has less room than it wants; then the name truncates (to NAME_FLOOR). The folder shows
 * when there is room left after the whole title. Text widths are estimated per character (Geist /
 * JetBrains Mono at these sizes). Below TIERS.name see tinyPlan(). Hovered, the chip makes way for
 * the pane buttons when they would not fit otherwise, and then the name (down to 40 px).
 */
export function plan(vm, W, hovered, title = "", folderText = "", prevBars = false) {
  const est = (s, px) => String(s ?? "").length * px;
  if (W < TIERS.name) return tinyPlan(vm, W, hovered, title);
  const buttonsW = hovered ? 4 * 20 + 4 * 8 : 0;
  const nameW = Math.min(est(vm.name, NAME_PX), NAME_MAX);
  // padding 20, program icon 14, face 28, "Lv 88" 32, the hero's gaps 24, gap to the centre 8,
  // divider + its gap 9, the gap before the centre's spacer 8 (optional parts carry their own gap
  // in `cost`); estimates err low: the title truncates gracefully when they are short of the real
  // widths (measured in Chromium at 420 px: the title gets about 6 px less than planned).
  const base = 20 + 14 + 28 + 32 + 24 + 8 + 9 + 8 - 5;
  const want = Math.max(MIN_TITLE, Math.min(est(title, 6.2), TITLE_WANT));
  // the bars: the pane's width and the title's only (not the name, the chip or the hover)
  const wasFull = prevBars === true || prevBars === "full";
  const full = W >= TIERS.fullBars && W - (base + NAME_MAX + CHIP_RESERVE + barsCost(BAR_PX.full)) >= want - (wasFull ? BARS_HYSTERESIS : 0);
  const compact = !full && W - (base + NAME_FLOOR + CHIP_SHORT_RESERVE + barsCost(BAR_PX.compact)) >= TITLE_FLOOR - (prevBars ? BARS_HYSTERESIS : 0);
  const barsW = full ? barsCost(BAR_PX.full) : compact ? barsCost(BAR_PX.compact) : 0;
  // the chip: its full text; beside compact bars its short form when the full one would cost the
  // title its MIN_TITLE (with the name at its floor). Hovered, herdr's pane buttons must stay
  // reachable (they come last, so overflow clips them first): the chip gives them its room when
  // the hero (name at its floor), the bars, the chip and the buttons would not fit.
  const chipText = (shortForm) => (shortForm ? vm.chip.short ?? vm.chip.text : vm.chip.text);
  let short = false;
  let chipW = vm.chip ? est(chipText(false), 5.4) + 12 + 8 : 0;
  if (compact && chipW && W - (base + Math.min(nameW, NAME_FLOOR) + chipW + barsW) < MIN_TITLE) {
    short = true;
    chipW = est(chipText(true), 5.4) + 12 + 8;
  }
  if (hovered && chipW && W - (base + Math.min(nameW, NAME_FLOOR) + chipW + buttonsW + barsW) < 0) chipW = 0;
  const cost = {
    career: vm.careerTitle ? est(vm.careerTitle, 5.6) + 6 : 0,
    contractor: vm.contractor ? 78 : 0,
  };
  const on = { career: !!vm.careerTitle, contractor: !!vm.contractor };
  const used = () => base + nameW + chipW + buttonsW + barsW + Object.keys(on).reduce((a, k) => a + (on[k] ? cost[k] : 0), 0);
  for (const k of ["career", "contractor"]) if (on[k] && W - used() < want) on[k] = false;
  const spare = W - used();
  let nameMax = spare >= MIN_TITLE ? NAME_MAX : Math.max(NAME_FLOOR, nameW - (MIN_TITLE - spare));
  // beside compact bars a chip wider than its reserve ("supervising") would eat the title's
  // floor: the name gives way first (to 48 px); hovered and still short of room (the buttons
  // beside the bars in a split), it gives way to 40 px
  const titleRoom = () => W - (used() - nameW + Math.min(nameW, nameMax));
  if (compact && titleRoom() < TITLE_FLOOR) nameMax = Math.max(48, Math.min(nameW, nameMax) - (TITLE_FLOOR - titleRoom()));
  if (hovered && titleRoom() < 0) nameMax = Math.max(40, Math.min(nameW, nameMax) + titleRoom());
  const folder = !!folderText && spare - est(title, 6.2) >= Math.min(est(folderText, 6.2), 220) + 8;
  return {
    tiny: false, micro: false, icon: true, name: true, level: true, title: true, short: short && chipW > 0,
    career: on.career, contractor: on.contractor, bars: full || compact, compact, nameMax, folder, chip: chipW > 0,
  };
}

/**
 * A header narrower than TIERS.name. The terminal title is the real information (which task this
 * pane is), so it stays, truncating, after the program icon and the face; the hero's name, career
 * and folder go, and "Lv N" shows only while the title keeps MIN_TITLE (or its whole width, if
 * shorter). Below TIERS.micro: the face and the chip's short form ("!" for "! waiting"), plus the
 * title only if 48 px are left. Hovered, the chip gives its room to the pane buttons.
 */
function tinyPlan(vm, W, hovered, title) {
  const est = (s, px) => String(s ?? "").length * px;
  const micro = W < TIERS.micro;
  const chipText = vm.chip ? (micro ? vm.chip.short ?? vm.chip.text : vm.chip.text) : "";
  const chipW = vm.chip && !hovered ? est(chipText, 5.4) + 12 + 8 : 0;
  const buttonsW = hovered ? 4 * 20 + 4 * 8 : 0;
  // padding 20, face 28, gap to the centre 8; the program icon and its gap 20
  const used = 20 + 28 + 8 + (micro ? 0 : 20) + chipW + buttonsW;
  const levelW = 32 + 6;
  const want = Math.min(est(title, 6.2), MIN_TITLE);
  const spare = W - used;
  const level = !micro && spare - levelW >= want;
  return {
    tiny: true, micro, icon: !micro, name: false, level, title: !!title && (!micro || spare >= 48), short: micro,
    career: false, contractor: false, bars: false, compact: false, nameMax: 0, folder: false, chip: chipW > 0,
  };
}

function heroHeader(vm, env, t, ui) {
  const p = env.pane;
  const W = ui.size?.w ?? env.width ?? 600;
  const hovered = !!ui.hovered;
  const title = p.name || p.title || "";
  const fit = plan(vm, W, hovered, title, folder(p.cwd, env.home), ui.bars ?? false);
  // the hysteresis remembers measured headers only: a first render at the 600 px default would
  // otherwise keep the bars in a 400 px pane
  if (ui.size) ui.bars = fit.bars ? (fit.compact ? "compact" : "full") : false;
  const pic = vm.programIcon ? programGlyph(vm.programIcon, 14, t.dim) : herdrIcon(p.program, 14, t.dim);

  const hero = h_flex().id(`np-hero-${p.pane}`).flex_none().h(26).px(4).ml(-4).gap(6).items_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(String(vm.tooltip ?? vm.name ?? ""))
    // A header click still focuses its pane (first, so the sheet opens over the focused pane).
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (!p.focused) run("pane.focus", { pane: p.pane });
      openSheet(vm.heroId);
    })
    .children(kids([
      fit.icon ? pic : null,
      faceScreen(vm, t),
      fit.name ? div().min_w(0).max_w(fit.nameMax).truncate().text_color(t.fg)
        .when(!!p.focused, (el) => el.font_semibold()).when(!p.focused, (el) => el.font_medium()).child(String(vm.name ?? "")) : null,
      fit.level ? div().flex_none().font_family(MONO).text_size(11).text_color(t.muted).child(`Lv ${vm.level}`) : null,
      fit.career ? div().flex_none().text_size(11.5).text_color(t.dim).child(String(vm.careerTitle)) : null,
      fit.contractor ? div().flex_none().text_size(11).italic().text_color(t.dim).child("(contractor)") : null,
    ]));

  const centre = fit.tiny
    // a narrow header keeps the terminal title (which task this is), truncating; the whole of it
    // is its tooltip
    ? div().flex_1().min_w(0).truncate().text_color(t.muted).when(fit.title && Boolean(title), (el) => el.tooltip(title)).child(fit.title ? title : "")
    // overflow_hidden: until on_size_change reports the real width the plan may be for a wider
    // header; the centre then clips its title and folder instead of painting over the chip
    : h_flex().flex_1().min_w(0).gap(8).items_center().overflow_hidden()
      .child(div().flex_none().w(1).h(14).bg(t.border))
      .child(div().min_w(0).truncate().text_color(t.muted).when(Boolean(title), (el) => el.tooltip(title)).child(title))
      .when(fit.folder, (el) => el.child(div().flex_none().max_w(220).truncate().text_color(t.dim).child(folder(p.cwd, env.home))))
      .child(div().flex_1());

  const bw = fit.compact ? BAR_PX.compact : BAR_PX.full;
  const bars = fit.bars
    ? h_flex().id(`np-bars-${p.pane}`).flex_none().gap(6).items_center()
      .child(h_flex().flex_none().gap(3).items_center()
        .child(div().text_size(9).font_family(MONO).text_color(t.muted).child("HP"))
        .child(thinBar(bw.hp, 4, vm.hpFrac, tone("#FF5A5F", t), track(t))))
      .child(h_flex().flex_none().gap(3).items_center()
        .child(div().text_size(9).font_family(MONO).text_color(t.muted).child("XP"))
        .child(thinBar(bw.xp, 4, vm.xpFrac, tone("#7FE9F5", t), track(t), { frac: vm.feFrac, color: tone("#A9B8FF", t) })))
    : null;

  const chip = fit.chip
    ? div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(alpha(vm.chip.color, 0.16))
      .text_size(10.5).font_semibold().text_color(ink(vm.chip.color, t)).whitespace_nowrap()
      .child(String((fit.short ? vm.chip.short ?? vm.chip.text : vm.chip.text) ?? ""))
    : null;

  return frame(env, t, ui).children(kids([hero, centre, bars, chip, ...(hovered ? buttons(t, p) : [])]));
}

/**
 * Build the pane header from a PlateVM (or null: herdr's plain header) and the pane's PaneInfo.
 * @param {object|null} vm PlateVM (ARCHITECTURE §5 + additions above)
 * @param {object} env see the typedef above; env.pane null → an empty div (the pane is gone)
 */
export function renderNameplate(vm, env) {
  const t = env.theme ?? T();
  const ui = env.ui ?? { hovered: false, size: null };
  if (!env.pane) return div();
  return vm ? heroHeader(vm, env, t, ui) : plainHeader(env, t, ui);
}

export default class Nameplate {
  init(props, cx, host) {
    this.props = props ?? {};
    this.host = host ?? null;
    this.ui = { hovered: false, size: null };
  }

  render(cx) {
    const pid = this.props.pane ?? null;
    const p = pid ? panes().find((x) => x.pane === pid) ?? null : null;
    const terminal = p?.terminal ?? this.props.terminal ?? null;
    // Mod panes (terminal null) never carry a hero.
    const vm = p && p.terminal ? this.host?.view?.("nameplate", { terminal, pane: p.pane }) ?? null : null;
    const host = this.host;
    return renderNameplate(vm, {
      width: this.ui.size?.w ?? 600, height: 34, zoom: zoom(), theme: T(), host,
      act: (name, args) => host?.command?.(name, args),
      pane: p, bottom: paneFrame(layout())?.header?.position === "bottom", home: home(), ui: this.ui,
    });
  }

  command(name) {
    return chromeCommand(name, this.host);
  }
}
