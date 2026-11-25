// Role "hud": the optional 26 px strip under the stage (hidden by default in the layout). One
// glance at the herd: gold, Snippets, release version, the frontier Sprint meter, and how many
// heroes are working / blocked / shipped (status colours, D§11.1), plus the Herd button with the
// digest dot. A click anywhere on it opens the Herd panel.
//
// VM additions (beyond ARCHITECTURE §5 HudVM; game/view.js supplies them):
/**
 * @typedef {Object} HudAdditions
 * gold, snippets and release are display strings ("48.2k", "133", "v2.3"; numbers are shown with
 * String()). sprint: null | { label, have, need } (as PartyVM.footer.sprint). working, blocked,
 * shipped: integers (shipped = done, not yet seen): heroes by herdr status, blocked heroes only (owner
 * decision 3). needYou: integer, the party's "N need you" (blocked heroes plus blocked sub-agents,
 * game/view needYou): the blocked count's tooltip names it when sub-agents wait too.
 * digestDot: boolean; digestTip: null | string
 * (why the dot is lit, as the party's Herd button says it: chests opened Unreviewed not yet seen
 * in the Digest, or an off-duty chest about to; the Herd button's tooltip). calm: boolean (calm mode;
 * the strip ignores it, but key commands read it from here: the cheapest view, see chromeCommand).
 * save: null | { title, short, tooltip } (game/view saveCue): save trouble shows as an amber pill
 * before the Herd button (its short form below the words tier); a click opens the Herd panel.
 *
 * env (renderHud): { width, height, zoom, theme: T(), host, act, ui?: { size:{w,h}|null } }.
 */

import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { C, T, MONO, art, zoom, kids } from "./kit.js";
import { tone, track, thinBar, lift, stripeColor, openHerd, chromeCommand, saveCueEl, onChrome } from "./party.js";

/** Width tiers (logical px): the words go first, then the sprint label, then the sprint. */
export const HUD_TIERS = { words: 720, sprintLabel: 560, sprint: 420 };

/**
 * What fits in a strip of width W: the tiers above, and the sprint (label first) only when the
 * fixed parts leave it room. Its bar and "have/need" never shrink, so without this a long gold /
 * Snippets / release text pushed the sprint over the counts (seen at 420 px with "41.3M").
 * Widths are estimated: JetBrains Mono 11 px = 6.6 px a character, icon 12 + gap 4, counts dot 7 +
 * gap 5 (+ word), Herd button 62, gaps 14, padding 24.
 */
export function hudFit(vm, W) {
  const est = (v) => String(v ?? "").length * 6.6;
  const words = W >= HUD_TIERS.words;
  const count = (n, label) => 12 + est(n ?? 0) + (words ? 5 + label.length * 6 : 0);
  // the save pill (padding 16, dot 6 + gap 6, Inter 11 px ≈ 6 px a character): its title with
  // the words, else its short form
  const saveLabel = vm.save ? String((words ? vm.save.title : vm.save.short) ?? vm.save.title ?? "") : null;
  const fixed = [16 + est(vm.gold), 16 + est(vm.snippets), vm.release ? est(vm.release) : null,
    count(vm.working, "working"), count(vm.blocked, "blocked"), count(vm.shipped, "shipped"), 62,
    saveLabel != null ? 28 + saveLabel.length * 6 : null].filter((w) => w !== null);
  const used = 24 + fixed.reduce((a, w) => a + w, 0) + 14 * fixed.length; // + one gap for the spacer
  const sp = vm.sprint;
  const core = sp ? 38 + 6 + 56 + 6 + est(`${sp.have}/${sp.need}`) + 14 : 0;
  const sprint = !!sp && W >= HUD_TIERS.sprint && W - used >= core;
  const sprintLabel = sprint && W >= HUD_TIERS.sprintLabel && W - used >= core + 6 + 48;
  return { words, sprint, sprintLabel, saveLabel };
}

// A count's dot is a status mark, in the party stripe's colour for the theme (party.js stripeColor).
function count(id, n, label, status, color, t, words, tip) {
  const zero = !n;
  return h_flex().id(id).flex_none().gap(5).items_center().tooltip(tip ?? `${n} ${label}`)
    .child(div().size(7).flex_none().rounded_full().bg(zero ? t.dim : stripeColor(color, status, t)).when(zero, (el) => el.opacity(0.5)))
    .child(div().font_family(MONO).text_size(11).text_color(zero ? t.dim : t.fg).child(String(n ?? 0)))
    .when(words, (el) => el.child(div().text_size(11).text_color(t.dim).child(label)));
}

/**
 * The blocked count is heroes (as working and shipped are); when sub-agents wait too, its tooltip
 * gives the party's "N need you", which counts them (owner decision 3).
 */
function blockedTip(vm) {
  const n = Number(vm.blocked) || 0;
  const all = Number(vm.needYou);
  const heroes = `${n} ${n === 1 ? "hero" : "heroes"} blocked`;
  if (!Number.isFinite(all) || all <= n) return heroes;
  const subs = all - n;
  return `${heroes}\n${all} ${all === 1 ? "needs" : "need"} you, counting ${subs} waiting ${subs === 1 ? "sub-agent" : "sub-agents"}`;
}

function stat(icon, color, value, t, tip) {
  return h_flex().flex_none().gap(4).items_center().tooltip(tip)
    .child(svg(art(icon)).w(12).h(12).flex_none().text_color(color))
    .child(div().font_family(MONO).text_size(11).text_color(t.fg).child(String(value ?? 0)));
}

/**
 * Build the HUD strip from a HudVM (or null while loading).
 * @param {object|null} vm HudVM (ARCHITECTURE §5 + additions above)
 * @param {object} env see the typedef above
 */
export function renderHud(vm, env) {
  const t = onChrome(env.theme ?? T());
  const ui = env.ui ?? { size: null };
  const W = ui.size?.w ?? env.width ?? 960;
  const root = h_flex().id("hud").size_full().px(12).gap(14).items_center().overflow_hidden()
    .bg(t.chrome).border_t(1).border_color(t.border).text_size(11).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip("Open the Herd panel")
    .on_size_change((s, cx) => {
      const z = env.zoom || 1;
      const w = Math.round(s.width / z), h = Math.round(s.height / z);
      if (!ui.size || ui.size.w !== w || ui.size.h !== h) { ui.size = { w, h }; cx.notify(); }
    })
    .on_click((_e, cx) => { cx.stop_propagation(); openHerd(); });
  if (!vm) return root.child(div().text_color(t.dim).child("Down the Stack · loading…"));

  const sp = vm.sprint;
  const fit = hudFit(vm, W);
  const words = fit.words;
  const dot = !!vm.digestDot;
  return root.children(kids([
    stat("ui/gold.svg", tone(C.coin, t), vm.gold, t, "Gold"),
    stat("ui/snippet.svg", t.muted, vm.snippets, t, "Snippets"),
    vm.release ? div().flex_none().font_family(MONO).text_color(t.dim).tooltip("Release Train: the herd's version").child(String(vm.release)) : null,
    sp && fit.sprint
      ? h_flex().flex_shrink_1().min_w(0).overflow_hidden().gap(6).items_center().tooltip(`Sprint: ${sp.label} ${sp.have}/${sp.need}`)
        .child(div().flex_none().text_color(t.dim).child("Sprint"))
        .when(fit.sprintLabel, (el) => el.child(div().min_w(0).truncate().text_color(t.muted).child(String(sp.label ?? ""))))
        .child(thinBar(56, 4, sp.need > 0 ? sp.have / sp.need : 0, t.accent, track(t)))
        .child(div().flex_none().font_family(MONO).text_color(t.dim).child(`${sp.have}/${sp.need}`))
      : null,
    div().flex_1(),
    count("hud-working", vm.working, "working", "working", C.working, t, words),
    count("hud-blocked", vm.blocked, "blocked", "blocked", C.blocked, t, words, blockedTip(vm)),
    count("hud-shipped", vm.shipped, "shipped", "done", C.done, t, words),
    vm.save ? saveCueEl("hud-save", vm.save, t, { h: 20, size: 11, label: fit.saveLabel }) : null,
    // A background hover, so the icon and its label change together: herdr fixes an svg's colour
    // when it builds the element, and a hover text colour would brighten only the label.
    h_flex().id("hud-herd").relative().flex_none().h(20).px(7).gap(5).items_center().rounded(5).bg(t.raised).text_color(t.muted)
      .hover((s) => s.bg(lift(t)))
      .when(dot && Boolean(vm.digestTip), (el) => el.tooltip(String(vm.digestTip)))
      .child(svg(art("ui/herd.svg")).w(12).h(12).flex_none())
      .child(div().text_size(11).font_medium().child("Herd"))
      .when(dot, (el) => el.child(div().absolute().top(2).right(2).size(5).rounded_full().bg(t.accent))),
  ]));
}

export default class Hud {
  init(props, cx, host) {
    this.props = props ?? {};
    this.host = host ?? null;
    this.ui = { size: null };
  }

  render(cx) {
    const host = this.host;
    const vm = host?.view?.("hud", { nowMs: Date.now() }) ?? null;
    return renderHud(vm, {
      width: this.ui.size?.w ?? 960, height: 26, zoom: zoom(), theme: T(), host,
      act: (name, args) => host?.command?.(name, args), ui: this.ui,
    });
  }

  command(name) {
    return chromeCommand(name, this.host);
  }
}
