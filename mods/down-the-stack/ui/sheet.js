// Role "sheet": the character sheet dialog (DESIGN §11.13), 760×500. Opened with
//   openOverlay({mod:"down-the-stack", kind:"dialog", width:760, height:500, props:{role:"sheet", heroId}})
// (ui/party.js openSheet). Optional props: `tab` (open on that tab) and `focus` (an item uid: open
// on its compare card, D§11.16 loot pillar). Esc and a click outside are herdr's; the close button
// runs closeOverlay(props().overlay).
//
// Tabs: Gear (paper doll around a large Termling, compare card, shared stash with filters, Squash
// Merge), Skills (cards with ranks and next-rank numbers, SP, auto-learn, respec), Stats (derived
// stats with their formulas as tooltips, the D§2.9 "why" breakdown), Career (ladder, reviews,
// class signature and picker, map pin, rename, retire, rebind) and Journal (this hero's lines).
//
// The pure renderer is renderSheet(vm, env); the role object only keeps UI state (tab, filter,
// selection, squash picks, the last command's result) and asks host.view("sheet", {heroId, tab,
// filter}) for the VM. Every derived string comes pre-formatted in the VM (game/view.js
// sheetView); every button is an ActionVM that view.js fills (command, arguments, cost, enabled,
// why not), so this file never computes game rules. Clicking runs env.act(cmd, args) and shows the
// {ok, error, msg} result in the footer until the next action (or 5 s).
//
// This module also exports the dialog building blocks ui/herdpanel.js reuses (buttons, tabs,
// item rows/tiles, the item card, filter chips, switches).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// VIEW MODEL (ARCHITECTURE §5 leaves SheetVM to view.js + this file; this block is the contract)
//
// host.view("sheet", SheetArgs) → SheetVM | null (null only while the world loads)
/**
 * @typedef {Object} SheetArgs
 * @property {number} heroId
 * @property {"gear"|"skills"|"stats"|"career"|"journal"} tab   the tab to fill
 * @property {StashFilter} filter   the Gear tab's stash query and selection (role UI state)
 *
 * @typedef {Object} StashFilter   (also HerdArgs.filter; view.js echoes it through ChipVM.on)
 * @property {"all"|"weapon"|"hat"|"hoodie"|"mug"|"boots"|"sticker"} slot
 * @property {number} minRar        0..5: show this rarity or better
 * @property {boolean} usable       sheet: only items this hero can wear; herd: anyone on the roster
 * @property {"score"|"ip"|"new"} sort
 * @property {number|null} focus    uid whose card (with compare) to show: hovered, else selected
 * @property {number|null} [hover]  the hovered uid and the selected uid, sent apart so view.js can
 * @property {number|null} [selected]  fall back to the selection when the hovered item is gone
 * @property {number[]} squash      uids picked for Squash Merge ([] when not picking)
 *
 * ── Shared building blocks (ui/herdpanel.js uses them too) ──
 *
 * @typedef {Object} ActionVM   One button. view.js decides everything; a click runs
 *                              env.act(cmd, args) (ARCHITECTURE §3.5) and flashes the result.
 * @property {string} key       stable, unique in the VM ("equip:812", "learn:3:area")
 * @property {string} label     "Equip", "Polish to +4", "Learn"
 * @property {string} cmd       §3.5 command ("equip", "lock", "polish", "deprecate", "squash",
 *                              "reroll", "learn", "autoLearn", "respec", "setClass", "pinMap",
 *                              "challenge", "retreat", "retire", "rebind", "buy", "claimChest", ...)
 * @property {object} args      complete arguments ({heroId, uid}, {uid, affix}, ...)
 * @property {boolean} enabled  false: drawn disabled; a click does nothing
 * @property {string|null} cost    display cost ("12.4k gold · 18 Snippets"), drawn in the button
 * @property {string|null} tooltip what it does, or why it is disabled ("Needs 12.4k gold")
 * @property {"primary"|"danger"|null} [tone]   primary: solid button; danger: red text
 * @property {string|null} [confirm]  when set, the first click arms the button and shows this
 *                              text ("Retire for good?"); the second click runs it
 *
 * @typedef {Object} ItemVM     one item: a stash row or tile, a paper-doll slot
 * @property {string} key       "it:812" (stable per uid)
 * @property {number} uid
 * @property {string} name      full display name with polish ("Memoized Pipe Wand +3")
 * @property {number} rar       0..5
 * @property {string} rarColor  kit.RARITY[rar]
 * @property {string} rarName   "Beta"
 * @property {string} icon      art-relative MASK path ("gear/weapon-shellmancer.svg", "ui/slot-hat.svg")
 * @property {string} ilvl      "iLvl 52"
 * @property {string} ip        "1,234" (Item Power)
 * @property {string|null} pol  "+3" or null
 * @property {boolean} locked
 * @property {boolean} isNew    not looked at yet: a small dot
 * @property {boolean} usable   sheet: this hero can wear it; herd: someone on the roster can
 * @property {null|{text:string, good:boolean|null}} delta   score vs equipped ("+3.2%")
 * @property {boolean} squashable   may be picked for Squash Merge
 * @property {string} tooltip   one line ("Beta weapon · iLvl 52 · IP 1,234 · score +3.2%")
 *
 * @typedef {Object} CardVM     the item card: ItemVM fields plus
 * @property {string} sub       "Beta weapon · iLvl 52 · req Lv 49"
 * @property {string|null} stat base stat ("Weapon damage 412", "Armor 96"; null for stickers)
 * @property {Array<{key:string, text:string, reroll:ActionVM|null}>} affixes   "+12.4% damage"
 * @property {null|{name:string, text:string}} prop   LTS property or Keepsake unique
 * @property {string} polish    "Polish +3 of +7"
 * @property {string|null} vs   "vs Zip Hoodie +2 (equipped)"; null when nothing to compare
 * @property {Array<{key:string, label:string, text:string, good:boolean|null}>} deltas
 *                              stat deltas vs the equipped item ("Armor", "+38", true)
 * @property {null|{text:string, good:boolean|null}} score   "score +3.2%" (autopilot score D§8.7)
 * @property {string|null} owner   "Worn by Kip the Idempotent" / herd: "Best on Kip · +3.2%"
 * @property {string|null} flavor  Keepsake flavour line
 * @property {ActionVM[]} actions  equip, lock, polish, deprecate… (whatever applies, in order)
 *
 * @typedef {Object} ChipVM     a filter chip; a click merges `set` into the filter
 * @property {string} key
 * @property {string} label     "All", "Usable", "Score" (rarity chips: the rarity name)
 * @property {string|null} icon art-relative mask path, drawn instead of the label
 * @property {string|null} color   rarity chips: drawn as a dot in this colour
 * @property {boolean} on
 * @property {object} set       filter patch ({slot:"hat"}, {minRar:2}, {usable:true}, {sort:"ip"})
 * @property {string|null} tooltip
 *
 * @typedef {Object} SquashVM   Squash Merge (CI Forge 3): pick 3 items of one rarity
 * @property {boolean} available   false: the toggle is disabled and shows `reason`
 * @property {string|null} reason  "CI Forge level 3 unlocks Squash Merge"
 * @property {number[]} picked     the picks view.js accepted (cleaned echo of filter.squash)
 * @property {string} label        "2 of 3 Alpha picked" / "Pick 3 items of one rarity"
 * @property {ActionVM} action     cmd "squash", args {uids}; enabled with 3 picks; cost "1.2k gold"
 *
 * @typedef {Object} StashVM    vendor/ (shared by the herd)
 * @property {string} title     "vendor/"
 * @property {string} count     "86 / 120"
 * @property {number} fill      0..1
 * @property {boolean} full
 * @property {ItemVM[]} items   filtered and sorted; view.js caps the list (render budget)
 * @property {string|null} more "+12 more: narrow the filter" when items were cut
 * @property {string} emptyText "Nothing matches this filter."
 * @property {{slot:ChipVM[], rarity:ChipVM[], toggles:ChipVM[], sort:ChipVM[]}} filters
 *
 * ── The sheet ──
 *
 * @typedef {Object} SheetVM
 * @property {number} heroId
 * @property {string} tab       the tab this VM fills (falls back when the asked one is not offered)
 * @property {Array<{id:string, label:string, badge:string|null, tip?:string|null}>} tabs   badge: "2" (SP), "!" …;
 *                              tip: what the badge means, for the tab's tooltip ("2 skill points to spend")
 * @property {boolean} calm     no blinking face, no bob
 * @property {string|null} [missing]   the hero is gone: only this text and a close button show
 * @property {SheetHeaderVM} header
 * @property {null|{text:string, color:string, tooltip?:string|null}} note   a line under the header
 *                              ("Off duty since 14:02 · its chests wait", "Contractor: hired tomorrow at
 *                              04:00 · not on the roster until then; …"); tooltip: the whole story (the line is cut)
 * @property {GearVM|null} gear       only the shown tab's part is filled; the others are null
 * @property {SkillsVM|null} skills
 * @property {StatsVM|null} stats
 * @property {CareerVM|null} career
 * @property {JournalVM|null} journal
 *
 * @typedef {Object} SheetHeaderVM
 * @property {string} name
 * @property {string} level     "Lv 34"
 * @property {string} title     career title + class ("Senior Refactorer")
 * @property {string|null} tag  small chip after the title ("provisional", "contractor") or null
 * @property {string|null} tagTip   the chip's tooltip ("Provisional class (9 of 15 tasks) …") or null
 * @property {string|null} tagTab   a click on the chip opens this tab ("career" for "provisional",
 *                              whose class chip locks it) or null (a plain label)
 * @property {string} sub       "herdr-app · Claude Code · fighting 2-2 Nested Tunnels"
 * @property {string|null} quest   current quest (terminal title), shown in quotes
 * @property {string|null} [subTip] the hero's town job for the line's tooltip ("At the Review Desk ·
 *                              Committer reviewer · …"; never in the line itself, TOWN.md §7.4)
 * @property {"working"|"blocked"|"done"|"idle"|"off"} status   portrait face blink + stripe
 * @property {{frac:number, text:string}} hp        "1,240 / 1,602"
 * @property {{frac:number, feFrac:number, text:string, tooltip:string}} xp   "41.2%"; tooltip =
 *                              the D§2.9 why line ("+512 XP/min = working ×1 · Fresh Eyes ×1.5 …")
 * @property {{frac:number, text:string, tooltip:string}} shift   Daily Shift "3h12m of 4h"
 * @property {string|null} fe   "Fresh Eyes 38m" (the pale XP segment), null when empty
 * @property {{text:string, tooltip:string}} power   "PL 34", "Power Level 34 = Lv 31 + gear 3"
 * @property {Array<{key:string, text:string, color:string, tooltip:string}>} buffs
 * @property {object} rig       ui/termling.js renderTermling input (HeroVM subset): { colors:
 *                              {hoodie,titleBar,screen,faceInk}, face, weapon:{clsId,color,edge?}|null,
 *                              hat:null|{tier,color}, accessory: clsId, programIcon:null|{path,tint,color} }
 * @property {null|{pane:string|null, address:string}} focus   live agent: [Focus terminal]
 *
 * @typedef {Object} GearVM
 * @property {Array<{key:string, slot:string, label:string, icon:string, item:ItemVM|null}>} slots
 *                              6, in order weapon, hat, hoodie, mug, boots, sticker (icon: empty-slot mask)
 * @property {CardVM|null} card the focused item (stash or equipped), compared with the equipped one
 * @property {string} hint      card placeholder ("Pick an item to compare it with what Kip wears.")
 * @property {Array<{key:string, label:string, value:string, tooltip:string}>} summary   IP, PL, DPS, EHP
 * @property {StashVM} stash
 * @property {SquashVM|null} squash   null: hide the Squash button
 *
 * @typedef {Object} SkillVM
 * @property {string} key       "sk:main"
 * @property {string} slot      main|area|passive|buff|sig|ult|cap
 * @property {string} slotLabel "Main · Lv 1"
 * @property {string} name      "Extract Method"
 * @property {string} glyph     1–3 characters for the icon box ("ƒ", "foo", ":T")
 * @property {number} rank      @property {number} max      @property {string} rankText  "12/20"
 * @property {boolean} locked
 * @property {string|null} lockText   "Lv 30 and the Senior Review"
 * @property {string} effect    "Hit 133% of a normal hit"
 * @property {string|null} next "Next rank: 136%" (null at max)
 * @property {string|null} cd   "CD 4 ticks" / "every 6th action" / null
 * @property {ActionVM|null} learn   cmd "learn"; null when locked or maxed
 * @property {string} tooltip   the cue / long description
 *
 * @typedef {Object} SkillsVM
 * @property {{count:number, text:string, tooltip:string}} sp   text "skill points"
 * @property {{on:boolean, action:ActionVM, hint:string}} autoLearn   action: cmd "autoLearn" {heroId, on:!on}
 * @property {ActionVM} respec  cost "Free (resting)" / "170 Snippets"
 * @property {string} rules     "Free once a day while resting; otherwise 5 × level Snippets."
 * @property {Array<{key:string, title:string, levels:string, state:"done"|"current"|"next"|"locked"}>} ladder
 * @property {SkillVM[]} skills 7 (an Intern has 2)
 * @property {string|null} note "Intern points are refunded at Lv 10."
 *
 * @typedef {Object} StatsVM
 * @property {Array<{key:string, title:string, rows:Array<{key:string, label:string, value:string,
 *            sub:string|null, tooltip:string, color:string|null}>}>} groups   3 or 4 columns
 * @property {{title:string, total:string, parts:Array<{key:string, label:string, value:string,
 *            good:boolean|null, tooltip:string|null}>, notes:string[]}} why   XP/min breakdown (D§2.9)
 *
 * @typedef {Object} ReviewVM
 * @property {string} name      "Senior Review"
 * @property {"locked"|"ready"|"running"|"won"} status
 * @property {string} statusText   "Ready: You, Six Months Ago" / "Passed Nov 3" / running:
 *                              "81% left against The Senior Reviewer" (what is left first: cut at its end)
 * @property {null|{text:string, color:string}} estimate   "Favored · 1.34×"
 * @property {ActionVM|null} challenge
 *
 * @typedef {Object} CareerVM
 * @property {Array<{key:string, title:string, levels:string, state:"done"|"current"|"next"|"locked",
 *            note:string, review:ReviewVM|null}>} ladder   Intern … Principal
 * @property {{text:string, recommended:string, state:string, tasks:string}} signature
 *            text "median task 12 min · 0.8 blocks/h · 10% with sub-agents"; state "Provisional (9 of 15 tasks)"
 * @property {{note:string, options:Array<ActionVM & {clsId:string, current:boolean,
 *            recommended:boolean, color:string, lock:boolean}>}} classes   cmd "setClass"; lock: the
 *            current class is provisional and this chip locks it (setClass on the same class)
 * @property {{label:string, current:string, auto:ActionVM, zones:Array<{key:string, name:string,
 *            maps:Array<ActionVM & {on:boolean}>}>}} map   cmd "pinMap" (auto: mapId null)
 * @property {null|{name:string, zone:string, status:string, estimate:null|{text:string, color:string},
 *            challenge:ActionVM|null, fighting:boolean}} boss   the boss card of the hero's zone
 *            (challenge: Challenge / Fight again at the door, Retreat while its fight runs or is
 *            paused; fighting: that fight is on, so the card leads the tab, its Retreat in view)
 * @property {{name:string, hint:string, canRename?:boolean}} identity   rename: act("rename", {heroId, name: typed});
 *                              canRename false (Contractors) disables the button
 * @property {null|{title:string, line:string|null, frac:number, status:string, tooltip:string,
 *            onDuty:boolean}} job   the Localhost Job line (docs/TOWN.md §7.6, read-only in round 1):
 *            title "Job · Review Desk", line "Contributor reviewer · 61 / 100" (null for an Intern or
 *            a Contractor), frac toward the next rank, status why it is or is not on duty; null with
 *            the town off
 * @property {ActionVM|null} retire     null for contractors; disabled below Lv 30 (tooltip says so)
 * @property {null|{title:string, hint:string, options:Array<ActionVM & {line?:string[]}>}} rebind
 *            benched heroes only; line (round 4c): the tooltip as [before the space, the space,
 *            after it], so the space is cut in the middle (rebindLine)
 *
 * @typedef {Object} JournalVM
 * @property {Array<{key:string, when:string, icon:string, color:string, text:string,
 *            value:string|null}>} lines   newest first, ≤ 30; icon: art-relative mask path
 * @property {string} emptyText
 */
// env (renderSheet / renderHerd): { width, height, zoom, theme, host, act, ui, overlay, inputs,
//   focus, scroll } — the contract's env plus:
//   theme:   kit.T() plus herdr's popover / input / solid / solid_foreground / accent_foreground
//            tokens (dialogTokens()); a plain T() works too (fallbacks)
//   ui:      the role's mutable UI state (newUi()); handlers mutate it and cx.notify(); the role
//            turns it into the next host.view args (filterArgs()). Optional: a fresh one is used.
//   overlay: props().overlay (the closeOverlay target); inputs: { name: InputState } (rename)
//   focus:   the dialog's FocusHandle (number / arrow keys switch tabs); scroll: the stash list's
//            ScrollHandle. All optional: the renderer works from a VM alone.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, ScrollHandle } from "gpui-base";
import { closeOverlay, theme as herdrTheme } from "herdr";
import { C, T, MONO, art, zoom, alpha, kids, clamp01, hex, middleCut } from "./kit.js";
import { isLight, mix, ink, tone, track, thinBar, portrait, focusAgent, chromeCommand } from "./party.js";
import { renderTermling } from "./termling.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dialog theme and small building blocks (exported for herdpanel.js)

/** kit.T() plus the dialog tokens herdr's own dialogs use, with fallbacks. */
export function dialogTheme(base) {
  const t = { ...(base ?? T()) };
  // light or dark by the surface the dialog draws on (herdr's popover), not the background:
  // win98's background is black while its popover is #c0c0c0
  const light = typeof t.light === "boolean" ? t.light : isLight({ bg: t.popover ?? t.bg });
  t.light = light;
  t.popover = t.popover ?? mix(t.bg, "#ffffff", light ? 0 : 0.06);
  t.input = t.input ?? (light ? "#00000026" : "#ffffff24");
  t.solid = t.solid ?? t.fg;
  t.solid_fg = t.solid_foreground ?? t.bg;
  t.accent_fg = t.accent_foreground ?? t.bg;
  // Surfaces derived from the popover so they read on every theme: cards sit a step above it,
  // wells (lists, empty slots) a step below.
  t.card = mix(t.popover, light ? "#000000" : "#ffffff", light ? 0.025 : 0.035);
  t.well = mix(t.popover, "#000000", light ? 0.045 : 0.16);
  t.btn = t.raised ?? t.card;
  t.btnHover = mix(t.btn, light ? "#000000" : "#ffffff", 0.07);
  // game colours as text (ink) clear 4.5:1 on the dialog's own surfaces (light themes)
  t.inkOn = [t.popover, t.card, t.well];
  t.good = ink(C.working, t);
  t.bad = ink(C.hp, t);
  return t;
}

/**
 * The env.theme a role passes: kit.T() plus herdr's dialog tokens (read in render). Each goes
 * through kit.hex (herdr accepts "ff8800" in an override; .bg() does not); an unusable one is
 * left undefined so dialogTheme's fallback applies.
 */
export function dialogTokens() {
  const h = herdrTheme() ?? {};
  return {
    ...T(), popover: hex(h.popover), input: hex(h.input), solid: hex(h.solid), solid_foreground: hex(h.solid_foreground),
    accent_foreground: hex(h.accent_foreground),
  };
}

/** A fresh UI state for a dialog role. */
export function newUi(tab) {
  return {
    tab, size: null, armed: null, flash: null, typing: false, hover: null, selected: null,
    squashMode: false, filter: { slot: "all", minRar: 0, usable: false, sort: "score", squash: [] },
    zone: null, renaming: false,
  };
}

/**
 * The filter the role sends with host.view: hover wins over the selection for the card (`focus`);
 * hover and selection also go apart, so view.js falls back to the selection when the hovered item
 * vanished (deprecated, squashed) before the pointer left it.
 */
export function filterArgs(ui) {
  const f = ui.filter;
  return {
    slot: f.slot, minRar: f.minRar, usable: f.usable, sort: f.sort,
    focus: ui.hover ?? ui.selected ?? null, hover: ui.hover ?? null, selected: ui.selected ?? null,
    squash: ui.squashMode ? f.squash.slice() : [],
  };
}

const goodColor = (good, t) => (good === true ? t.good : good === false ? t.bad : t.muted);

/** Show a command result in the footer until the next action (or 5 s). */
export function flash(ui, r, label, cx) {
  const ok = r ? r.ok !== false : true;
  const text = (r && (r.msg || r.error)) || (ok ? `${label}: done.` : `${label}: that didn't work.`);
  const f = { ok, text: String(text) };
  ui.flash = f;
  cx.timer?.after?.(5000, (cx2) => { if (ui.flash === f) { ui.flash = null; cx2.notify(); } });
}

/** Run an ActionVM: arm first when it asks for confirmation, else env.act and flash the result. */
export function runAction(a, env, ui, cx) {
  if (!a || !a.enabled) return null;
  if (a.confirm && ui.armed !== a.key) { ui.armed = a.key; cx.notify(); return null; }
  ui.armed = null;
  const r = env.act ? env.act(a.cmd, a.args) : null;
  flash(ui, r, a.label, cx);
  if (typeof ui.after === "function") ui.after(a, r);
  cx.notify();
  return r;
}

/**
 * An ActionVM button. o: { h, px, size, grow, w, cost:false, stack } — stack: the label over
 * its cost in a fixed-width cell (the item card's 2-column grid); the cost truncates (tooltip).
 */
export function actionButton(id, a, env, ui, t, o = {}) {
  const armed = !!a.confirm && ui.armed === a.key;
  const enabled = !!a.enabled;
  const primary = a.tone === "primary" && enabled && !armed;
  const danger = a.tone === "danger" || armed;
  const fg = primary ? t.solid_fg : danger ? t.bad : t.fg;
  const showCost = Boolean(a.cost) && !armed && o.cost !== false;
  const costColor = primary ? t.solid_fg : t.muted;
  const costEl = () => (o.stack && costIcons(a.cost, costColor, t)) || div().min_w(0).truncate().text_size(o.stack ? 10 : 10.5).when(!o.stack, (e) => e.font_family(MONO))
    .when(Boolean(o.stack), (e) => e.max_w_full())
    .text_color(costColor).opacity(primary ? 0.8 : 1).child(String(a.cost));
  const label = div().min_w(0).truncate().when(Boolean(o.stack), (e) => e.max_w_full()).child(armed ? a.confirm : a.label);
  const el = (o.stack ? v_flex().justify_center().items_center().gap(0).line_height(1.2) : h_flex().gap(6).items_center().justify_center())
    .id(id).flex_none().h(o.h ?? 26).px(o.px ?? 10).rounded(6).overflow_hidden()
    .text_size(o.size ?? 12).font_medium().text_color(fg)
    .bg(primary ? t.solid : armed ? alpha(C.hp, t.light ? 0.12 : 0.16) : t.btn)
    .border(1).border_color(primary ? t.solid : armed ? alpha(C.hp, 0.5) : t.input)
    .child(label)
    .when(showCost, (e) => e.child(costEl()))
    .when(Boolean(o.w), (e) => e.w(o.w))
    .when(Boolean(o.grow), (e) => e.flex_1().min_w(0))
    .when(Boolean(a.tooltip) || (o.stack && showCost), (e) => e.tooltip([a.tooltip, o.stack ? a.cost : null].filter(Boolean).join(" · ")));
  if (!enabled) return el.opacity(0.45).cursor_default().on_click((_e, cx) => cx.stop_propagation());
  return el.cursor_pointer()
    .hover((s) => (primary ? s.opacity(0.88) : s.bg(t.btnHover)))
    .on_click((_e, cx) => { cx.stop_propagation(); runAction(a, env, ui, cx); });
}

/**
 * "1.3k gold · 4 Snippets" as coin / snippet icons with their numbers (the card's narrow buttons
 * cut the words off); null when the text has any other shape (then it is drawn as text).
 */
function costIcons(cost, color, t) {
  const parts = String(cost ?? "").split(" · ");
  const out = [];
  for (const p of parts) {
    const m = /^([0-9][0-9.,]*[kMBT]?) (gold|Snippets?)$/.exec(p);
    if (!m) return null;
    const gold = m[2] === "gold";
    out.push(h_flex().flex_none().gap(2).items_center()
      .child(svg(art(gold ? "ui/gold.svg" : "ui/snippet.svg")).w(10).h(10).flex_none().text_color(gold ? tone(C.coin, t) : color))
      .child(div().font_family(MONO).text_size(10).text_color(color).child(m[1])));
  }
  return out.length ? h_flex().gap(7).items_center().justify_center().children(out) : null;
}

/** A plain button that runs `onClick(cx)` (UI-only: toggles, rename, focus). */
export function plainButton(id, label, t, onClick, o = {}) {
  const el = h_flex().id(id).flex_none().h(o.h ?? 26).px(o.px ?? 10).gap(6).items_center().justify_center().rounded(6)
    .text_size(o.size ?? 12).font_medium().text_color(o.on ? t.accent : t.fg)
    .bg(o.on ? alpha(t.accent, 0.14) : t.btn).border(1).border_color(o.on ? alpha(t.accent, 0.5) : t.input)
    .when(Boolean(o.icon), (e) => e.child(svg(art(o.icon)).w(12).h(12).flex_none()))
    .child(div().whitespace_nowrap().child(label))
    .when(Boolean(o.tooltip), (e) => e.tooltip(String(o.tooltip)));
  if (o.disabled) return el.opacity(0.45).cursor_default().on_click((_e, cx) => cx.stop_propagation());
  return el.cursor_pointer().hover((s) => (o.on ? s.opacity(0.88) : s.bg(t.btnHover)))
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); });
}

// Hover styles and icons: herdr bakes an svg()'s colour when it builds the element, from the
// static text_color it inherits (materialize.rs, the Svg arm); a parent's hover((s) => s.text_color(..))
// is a paint-time style on the parent only and never reaches the svg. So anything that holds an
// icon hovers with its background (like herdr's own tab and panel buttons), never its text colour,
// and its icon gets an explicit colour. test/ui-panels.test.mjs walks every scenario for this.

/** A square icon button (close, focus). */
export function iconButton(id, icon, t, tip, onClick, size = 14) {
  return div().id(id).flex_none().p(5).rounded(6).cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(tip)
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .child(svg(art(icon)).w(size).h(size).text_color(t.muted));
}

/** A switch drawn from two divs. */
export function switchEl(id, on, t, tip, onClick, disabled = false) {
  const trackColor = on ? tone(t.accent, t) : alpha(t.fg.slice(0, 7), t.light ? 0.3 : 0.2);
  const el = div().id(id).relative().flex_none().w(30).h(17).rounded_full().bg(trackColor)
    .child(div().id(`${id}-knob`).absolute().top(2.5).left(on ? 15.5 : 2.5).size(12).rounded_full().bg("#ffffff").shadow_sm()
      .transition("left", { duration: 140, easing: "ease-out" }))
    .tooltip(tip);
  if (disabled) return el.opacity(0.45).on_click((_e, cx) => cx.stop_propagation());
  return el.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); });
}

/** A small rounded label. */
export function tag(text, color, t, o = {}) {
  return div().flex_none().h(o.h ?? 17).px(6).rounded(5).flex().items_center()
    .bg(alpha(color, t.light ? 0.16 : 0.18)).text_color(ink(color, t))
    .text_size(o.size ?? 10.5).font_semibold().whitespace_nowrap().child(String(text));
}

/** A dim uppercase-ish section label. */
export function sectionTitle(text, t, right) {
  return h_flex().flex_none().h(18).gap(8).items_center()
    .child(div().text_size(11).font_semibold().text_color(t.dim).child(text))
    .child(div().flex_1().h(1).bg(t.border))
    .when(Boolean(right), (e) => e.child(right));
}

/** A full-width thin bar (percentage fill). */
export function fluidBar(frac, h, color, trackColor) {
  const pct = Math.round(clamp01(frac) * 1000) / 10;
  return div().relative().w_full().h(h).flex_none().rounded(h >= 4 ? 2 : 1).bg(trackColor).overflow_hidden()
    .when(pct > 0, (e) => e.child(div().absolute().left(0).top(0).h(h).w(`${pct}%`).bg(color)));
}

/** A labelled thin bar for the header ("HP ▬▬▬▭ 1,240 / 1,602"). */
function statBar(label, w, frac, color, t, text, tip, extra) {
  return h_flex().flex_none().gap(6).items_center().tooltip(tip)
    .child(div().text_size(10).font_semibold().text_color(t.muted).child(label))
    .child(thinBar(w, 5, frac, tone(color, t), track(t), extra))
    .child(div().font_family(MONO).text_size(10.5).text_color(t.muted).whitespace_nowrap().child(text));
}

/**
 * Tab strip. tabs: [{id, label, badge, tip?}], icons: {id: maskPath}. The tooltip names the tab's
 * key ("Digest · 3 new since you last looked · key 6"): a bare "(6)" beside a badge read as a count.
 */
export function tabBar(prefix, tabs, current, t, icons, onPick) {
  return h_flex().flex_none().h(34).px(10).gap(2).items_end().border_b(1).border_color(t.border)
    .children(tabs.map((tb, i) => {
      const on = tb.id === current;
      // Inactive labels in muted (herdr's own tabs do the same; dim reads at ~2.8:1). The hover
      // is a background so the icon and the label stay one colour (see iconButton).
      const fg = on ? t.fg : t.muted;
      return h_flex().id(`${prefix}-tab-${tb.id}`).relative().h(34).px(10).gap(6).items_center().cursor_pointer().rounded_t(6)
        .text_size(12.5).font_medium().text_color(fg)
        .hover((s) => s.bg(t.hover))
        .tooltip([tb.label, tb.badge ? tb.tip : null, `key ${i + 1}`].filter(Boolean).join(" · "))
        .on_click((_e, cx) => { cx.stop_propagation(); onPick(tb.id, cx); })
        .children(kids([
          icons?.[tb.id] ? svg(art(icons[tb.id])).w(13).h(13).flex_none().text_color(fg) : null,
          div().whitespace_nowrap().child(tb.label),
          tb.badge ? div().flex_none().h(15).min_w(15).px(4).rounded_full().bg(on ? t.accent : alpha(t.accent, 0.22))
            .text_color(on ? t.accent_fg : ink(t.accent, t)).text_size(9.5).font_bold().flex().items_center().justify_center()
            .child(String(tb.badge)) : null,
          on ? div().absolute().left(8).right(8).bottom(0).h(2).rounded(1).bg(t.accent) : null,
        ]));
    }));
}

/** The footer: last command result on the left, key hints on the right. */
export function footerBar(prefix, ui, t, hint) {
  const f = ui.flash;
  return h_flex().id(`${prefix}-footer`).flex_none().h(28).px(16).gap(8).items_center().border_t(1).border_color(t.border).text_size(11.5)
    .child(f
      ? h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().size(7).flex_none().rounded_full().bg(f.ok ? tone(C.working, t) : tone(C.hp, t)))
        .child(div().min_w(0).truncate().text_color(f.ok ? t.fg : t.bad).child(f.text))
      : div().flex_1())
    .child(div().flex_none().text_size(11).text_color(t.dim).child(hint));
}

/** An item's icon (mask tinted by rarity). */
export function itemIcon(it, size, t) {
  return svg(art(it.icon)).w(size).h(size).flex_none().text_color(tone(it.rarColor, t));
}

/** A stash list row (sheet). o: { selected, picking, picked, canPick, onClick, onHover } */
export function itemRow(prefix, it, t, o) {
  const right = it.delta
    ? div().flex_none().font_family(MONO).text_size(10.5).text_color(goodColor(it.delta.good, t)).child(it.delta.text)
    : div().flex_none().font_family(MONO).text_size(10.5).text_color(t.dim).child(it.ip);
  const dim = o.picking && !it.squashable;
  return h_flex().id(`${prefix}-row-${it.key}`).h(28).flex_none().pl(6).pr(8).gap(7).rounded(6).items_center()
    .when(Boolean(o.selected), (e) => e.bg(t.selected))
    .when(dim || (!o.picking && !it.usable), (e) => e.opacity(dim ? 0.35 : 0.6))
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .tooltip(it.tooltip)
    .on_hover((on, cx) => o.onHover?.(on, cx))
    .on_click((_e, cx) => { cx.stop_propagation(); o.onClick?.(cx); })
    .children(kids([
      o.picking ? checkBox(o.picked, t) : null,
      itemIcon(it, 16, t),
      div().flex_1().min_w(0).truncate().text_size(12).text_color(ink(it.rarColor, t)).child(it.name),
      it.isNew ? div().size(6).flex_none().rounded_full().bg(t.accent) : null,
      it.locked ? svg(art("ui/lock.svg")).w(10).h(10).flex_none().text_color(t.dim) : null,
      right,
    ]));
}

function checkBox(on, t) {
  return div().size(13).flex_none().rounded(3).border(1.5).border_color(on ? t.accent : t.dim)
    .when(on, (e) => e.bg(t.accent).flex().items_center().justify_center()
      .child(div().size(5).rounded(1).bg(t.accent_fg)));
}

/** A stash grid tile (herd). o: { selected, picking, picked, onClick, onHover } */
export function itemTile(prefix, it, t, o) {
  const col = tone(it.rarColor, t);
  const dim = o.picking && !it.squashable;
  return div().id(`${prefix}-tile-${it.key}`).relative().size(44).flex_none().rounded(8)
    .bg(alpha(it.rarColor, t.light ? 0.1 : 0.12))
    .border(o.selected || o.picked ? 2 : 1.5).border_color(o.selected || o.picked ? t.accent : alpha(col, 0.75))
    .flex().items_center().justify_center()
    .when(dim || (!o.picking && !it.usable), (e) => e.opacity(dim ? 0.3 : 0.6))
    .cursor_pointer()
    .hover((s) => s.border_color(t.accent))
    .tooltip(`${it.name} · ${it.tooltip}`)
    .on_hover((on, cx) => o.onHover?.(on, cx))
    .on_click((_e, cx) => { cx.stop_propagation(); o.onClick?.(cx); })
    .children(kids([
      itemIcon(it, 24, t),
      it.pol ? div().absolute().right(3).bottom(1).font_family(MONO).text_size(9).font_bold().text_color(t.fg).child(it.pol) : null,
      it.locked ? svg(art("ui/lock.svg")).absolute().left(3).top(3).w(8).h(8).text_color(t.muted) : null,
      it.isNew ? div().absolute().right(3).top(3).size(5).rounded_full().bg(t.accent) : null,
    ]));
}

/** The filter chips (slot icons, rarity dots, toggles, sort). onSet(patch, cx). */
export function filterChips(prefix, filters, t, onSet) {
  const chip = (c) => {
    const dot = Boolean(c.color) && !c.icon;
    const fg = c.on ? t.fg : t.muted;
    const el = h_flex().id(`${prefix}-f-${c.key}`).flex_none().h(22).px(dot ? 4 : c.icon ? 5 : 6).gap(4).items_center().justify_center().rounded(5)
      .text_size(11).text_color(fg)
      .when(c.on, (e) => e.bg(t.selected))
      .cursor_pointer()
      // Icon chips hover with the background only: the svg keeps the colour it was built with.
      .hover((s) => (c.icon ? s.bg(t.hover) : s.bg(t.hover).text_color(t.fg)))
      .tooltip(c.tooltip ?? c.label)
      .on_click((_e, cx) => { cx.stop_propagation(); onSet(c.set ?? {}, cx); });
    if (c.icon) return el.child(svg(art(c.icon)).w(13).h(13).flex_none().text_color(c.on ? t.fg : t.muted));
    if (dot) return el.child(div().size(10).rounded_full().bg(tone(c.color, t)).border(c.on ? 2 : 0).border_color(t.fg));
    return el.child(div().whitespace_nowrap().child(c.label));
  };
  const sep = () => div().w(1).h(14).flex_none().bg(t.border);
  const f = filters ?? {};
  // Sort is one chip that steps to the next order (saves a row in narrow columns).
  const sorts = f.sort ?? [];
  const at = Math.max(0, sorts.findIndex((c) => c.on));
  const sortChip = sorts.length > 0 ? chip({
    ...sorts[at], key: "sort", label: `↓ ${sorts[at].label}`, icon: null, color: null, on: false,
    set: sorts[(at + 1) % sorts.length].set,
    tooltip: `${sorts[at].tooltip ?? sorts[at].label} (click: ${sorts[(at + 1) % sorts.length].label})`,
  }) : null;
  return v_flex().flex_none().gap(4)
    .child(h_flex().gap(1).items_center().children((f.slot ?? []).map(chip)))
    .child(h_flex().gap(1).items_center()
      .children((f.rarity ?? []).map(chip))
      .when((f.toggles ?? []).length > 0, (e) => e.child(sep()).children(f.toggles.map(chip)))
      .when(Boolean(sortChip), (e) => e.child(div().flex_1()).child(sortChip)));
}

/**
 * The item card (detail + compare). o: { w, prefix }. Fills its column's height: the body
 * scrolls, the action buttons stay at the bottom.
 */
export function itemCard(prefix, card, env, ui, t, o = {}) {
  const col = tone(card.rarColor, t);
  const text = ink(card.rarColor, t);
  const body = v_flex().id(`${prefix}-card-body`).flex_1().min_h(0).overflow_y_scroll().px(12).pt(9).pb(8).gap(5)
    .child(v_flex().gap(1)
      .child(div().text_size(13).font_semibold().line_height(1.25).text_color(text).child(card.name))
      .child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(card.sub)))
    .child(h_flex().h(20).gap(6).items_center()
      .child(itemIcon(card, 15, t))
      .child(tag(card.rarName, card.rarColor, t))
      .child(div().font_family(MONO).text_size(11).text_color(t.fg).whitespace_nowrap().child(`IP ${card.ip}`))
      .child(div().flex_1())
      .when(Boolean(card.score), (e) => e.child(div().flex_none().h(18).px(6).rounded(5).flex().items_center()
        .bg(alpha(card.score.good === false ? C.hp : C.working, t.light ? 0.14 : 0.16)).tooltip("Autopilot score vs the equipped item")
        .font_family(MONO).text_size(11).font_bold().text_color(goodColor(card.score.good, t)).child(card.score.text))))
    .child(h_flex().gap(8).items_center()
      .child(div().flex_none().text_size(12).font_medium().text_color(t.fg).whitespace_nowrap().child(card.stat ?? ""))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(10.5).text_color(t.dim).child(card.polish ?? "")))
    // The compare block (green / red deltas) comes before the affixes: in a 256 px card it is the
    // part that decides, so it stays visible without scrolling.
    .when(Boolean(card.vs) || (card.deltas ?? []).length > 0, (e) => e.child(compareBlock(prefix, card, t)))
    .children((card.affixes ?? []).map((a) => h_flex().id(`${prefix}-aff-${a.key}`).min_h(18).gap(6).items_center()
      .child(div().size(4).flex_none().rounded_full().bg(col))
      .child(div().flex_1().min_w(0).text_size(11.5).line_height(1.3).text_color(t.muted).child(a.text))
      .when(Boolean(a.reroll), (e) => e.child(rerollButton(`${prefix}-rr-${a.key}`, a.reroll, env, ui, t)))))
    .when(Boolean(card.prop), (e) => e.child(v_flex().gap(1).px(8).py(6).rounded(6).bg(alpha(card.rarColor, t.light ? 0.1 : 0.12))
      .child(div().text_size(11.5).font_semibold().text_color(text).child(card.prop.name))
      .child(div().text_size(11).text_color(t.muted).child(card.prop.text))))
    .when(Boolean(card.flavor), (e) => e.child(div().text_size(11).italic().text_color(t.dim).child(card.flavor)))
    .when(Boolean(card.owner), (e) => e.child(div().text_size(11).text_color(t.dim).child(card.owner)));
  const actions = card.actions ?? [];
  // Two buttons per row; each shows its cost under the label.
  const cellW = Math.floor(((o.w ?? 256) - 2 - 20 - 6) / 2);
  const stacked = actions.some((a) => a.cost);
  return v_flex().id(`${prefix}-card`).h_full().min_h(0).rounded(10).border(1).border_color(alpha(col, 0.45)).bg(t.card).overflow_hidden()
    .when(Boolean(o.w), (e) => e.w(o.w).flex_none())
    .child(div().h(3).flex_none().bg(col))
    .child(body)
    .when(actions.length > 0, (e) => e.child(h_flex().flex_none().flex_wrap().gap(6).px(10).py(7).border_t(1).border_color(t.border)
      .children(actions.map((a) => actionButton(`${prefix}-act-${a.key}`, a, env, ui, t, { h: stacked ? 32 : 26, px: 6, size: 11.5, w: cellW, stack: stacked })))));
}

function compareBlock(prefix, card, t) {
  return v_flex().id(`${prefix}-cmp`).gap(4).pb(6).border_b(1).border_color(t.border)
    .when(Boolean(card.vs), (e) => e.child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(card.vs)))
    .child(h_flex().flex_wrap().gap(4).children((card.deltas ?? []).map((d) => h_flex().id(`${prefix}-d-${d.key}`).flex_none().h(18).px(5).gap(4)
      .items_center().rounded(4).bg(t.well)
      .child(div().text_size(10.5).text_color(t.muted).whitespace_nowrap().child(d.label))
      .child(div().font_family(MONO).text_size(10.5).font_semibold().text_color(goodColor(d.good, t)).whitespace_nowrap().child(d.text)))));
}

function rerollButton(id, a, env, ui, t) {
  // Armed (ActionVM.confirm): a red "?" asks for the second click; the tooltip says what it does.
  const armed = !!a.confirm && ui.armed === a.key;
  const el = div().id(id).flex_none().size(18).rounded(4).flex().items_center().justify_center()
    .text_size(12).font_bold().text_color(armed ? t.bad : a.enabled ? t.muted : t.dim)
    .when(armed, (e) => e.bg(alpha(C.hp, t.light ? 0.12 : 0.16)))
    .tooltip([armed ? a.confirm : a.label, a.cost, a.tooltip].filter(Boolean).join(" · "))
    .child(armed ? "?" : "↻");
  if (!a.enabled) return el.opacity(0.5).on_click((_e, cx) => cx.stop_propagation());
  return el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.fg))
    .on_click((_e, cx) => { cx.stop_propagation(); runAction(a, env, ui, cx); });
}

/** Card placeholder. */
export function emptyCard(prefix, text, t, w) {
  return v_flex().id(`${prefix}-card`).h_full().rounded(10).border(1).border_color(t.border).bg(t.card)
    .when(Boolean(w), (e) => e.w(w).flex_none())
    .items_center().justify_center().px(20).gap(8)
    .child(svg(art("ui/sheet.svg")).w(22).h(22).text_color(t.dim).opacity(0.7))
    .child(div().text_size(12).text_color(t.dim).text_center().child(text));
}

/** The Squash Merge bar under a stash while picking. */
export function squashBar(prefix, sq, env, ui, t) {
  return h_flex().id(`${prefix}-squash`).flex_none().min_h(34).px(8).py(4).gap(8).items_center().rounded(8)
    .bg(alpha(t.accent, t.light ? 0.08 : 0.1)).border(1).border_color(alpha(t.accent, 0.35))
    .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.fg).child(sq.label))
    .child(actionButton(`${prefix}-squash-go`, sq.action, env, ui, t, { h: 24, px: 8, size: 11.5 }));
}

/** Toggle a uid in the squash picks (≤ 3; view.js decides which picks count). */
export function togglePick(ui, uid) {
  const list = ui.filter.squash;
  const i = list.indexOf(uid);
  if (i >= 0) list.splice(i, 1);
  else { list.push(uid); while (list.length > 3) list.shift(); }
}

/** The stash header: title, count, capacity bar and the Squash toggle. */
export function stashHeader(prefix, stash, squash, t, ui) {
  return v_flex().flex_none().gap(5)
    .child(h_flex().h(24).gap(8).items_center()
      .child(svg(art("ui/chest.svg")).w(13).h(13).flex_none().text_color(t.dim))
      .child(div().font_family(MONO).text_size(12).font_semibold().text_color(t.fg).child(stash.title))
      .child(div().font_family(MONO).text_size(11).text_color(stash.full ? t.bad : t.dim).child(stash.count))
      .child(div().flex_1())
      .when(Boolean(squash), (e) => e.child(plainButton(`${prefix}-squash-toggle`, ui.squashMode ? "Done" : "Squash", t, (cx) => {
        ui.squashMode = !ui.squashMode;
        ui.filter.squash = [];
        cx.notify();
      }, { h: 22, px: 8, size: 11, on: ui.squashMode, disabled: !squash.available,
        tooltip: squash.available ? "Squash Merge: 3 items of one rarity become 1 of the next" : squash.reason }))))
    .child(fluidBar(stash.fill, 3, stash.full ? tone(C.hp, t) : t.muted, track(t)));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The sheet

const TAB_ICONS = { gear: "ui/slot-hoodie.svg", skills: "ui/skills.svg", stats: "ui/stats.svg", career: "ui/career.svg", journal: "ui/journal.svg" };
export const SHEET_TABS = ["gear", "skills", "stats", "career", "journal"];
const SLOT_ORDER = ["weapon", "hat", "hoodie", "mug", "boots", "sticker"];

/**
 * Build the character sheet from a SheetVM (or null while loading).
 * @param {object|null} vm SheetVM (see the typedefs above)
 * @param {object} env { width, height, zoom, theme, host, act, ui, overlay, inputs }
 */
export function renderSheet(vm, env) {
  const t = dialogTheme(env.theme);
  const ui = env.ui ?? newUi("gear");
  const root = v_flex().id("sheet").size_full().min_h(0).bg(t.popover).text_size(12.5).text_color(t.fg)
    .when(Boolean(env.focus), (e) => e.track_focus(env.focus))
    .on_key_down((e, cx) => keyDown(e, cx, vm, ui))
    .on_size_change((s, cx) => {
      const z = env.zoom || 1;
      const w = Math.round(s.width / z), h = Math.round(s.height / z);
      if (!ui.size || ui.size.w !== w || ui.size.h !== h) { ui.size = { w, h }; cx.notify(); }
    });
  const close = iconButton("sh-close", "ui/close.svg", t, "Close (Esc)", () => { if (env.overlay) closeOverlay(env.overlay); });

  if (!vm || vm.missing) {
    return root
      .child(h_flex().flex_none().px(16).pt(14).pb(10).gap(8).items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Character sheet"))
        .child(close))
      .child(v_flex().flex_1().items_center().justify_center().gap(8)
        .child(svg(art("ui/sheet.svg")).w(28).h(28).text_color(t.dim))
        .child(div().text_size(12.5).text_color(t.dim).child(vm?.missing ?? "Loading the hero…")));
  }

  const width = ui.size?.w ?? env.width ?? 760;
  const body = h_flex().id(`sh-body-${vm.tab}`).flex_1().min_h(0).px(16).pt(10).pb(10).gap(14).items_start();
  let content;
  if (vm.tab === "gear" && vm.gear) content = gearTab(vm, env, ui, t, width);
  else if (vm.tab === "skills" && vm.skills) content = skillsTab(vm, env, ui, t);
  else if (vm.tab === "stats" && vm.stats) content = statsTab(vm, t);
  else if (vm.tab === "career" && vm.career) content = careerTab(vm, env, ui, t);
  else if (vm.tab === "journal" && vm.journal) content = journalTab(vm, t);
  else content = [div().text_color(t.dim).child("Nothing to show here yet.")];

  return root
    .child(header(vm, env, ui, t, close, width))
    .when(Boolean(vm.note), (e) => e.child(h_flex().id("sh-note").flex_none().mx(16).mb(6).px(10).h(24).gap(6).items_center().rounded(6)
      .bg(alpha(vm.note.color, t.light ? 0.12 : 0.14)).text_size(11.5).text_color(ink(vm.note.color, t))
      .when(Boolean(vm.note.tooltip), (x) => x.tooltip(vm.note.tooltip))
      .child(div().truncate().child(vm.note.text))))
    .child(tabBar("sh", vm.tabs ?? [], vm.tab, t, TAB_ICONS, (id, cx) => pickTab(ui, id, cx)))
    .child(body.children(content))
    .child(footerBar("sh", ui, t, `1–${(vm.tabs ?? []).length || 5} tabs · Esc closes`));
}

function pickTab(ui, id, cx) {
  if (ui.tab === id) return;
  ui.tab = id;
  ui.hover = null;
  ui.armed = null;
  LAST.sheet = id;
  cx.notify();
}

function keyDown(e, cx, vm, ui) {
  if (ui.typing || !vm || vm.missing) return;
  const tabs = (vm.tabs ?? []).map((x) => x.id);
  const k = String(e.key ?? "").toLowerCase();
  const n = Number(k);
  let next = null;
  if (Number.isInteger(n) && n >= 1 && n <= tabs.length) next = tabs[n - 1];
  else if (k === "left" || k === "arrowleft" || k === "right" || k === "arrowright") {
    const i = Math.max(0, tabs.indexOf(vm.tab));
    next = tabs[(i + (k.endsWith("left") ? tabs.length - 1 : 1)) % tabs.length];
  }
  if (!next) return;
  cx.stop_propagation();
  pickTab(ui, next, cx);
}

function header(vm, env, ui, t, close, width) {
  const h = vm.header;
  const rig = h.rig ?? {};
  const face = { colors: rig.colors, face: rig.face, status: h.status, programIcon: rig.programIcon, focused: false };
  const xpW = width >= 700 ? 120 : 90;
  const all = [];
  if (h.fe) all.push({ key: "fe", text: h.fe, color: C.fresh, tooltip: "Fresh Eyes: ×1.5 kill XP while it lasts (the pale part of the XP bar)" });
  for (const b of h.buffs ?? []) all.push(b);
  // Chips that would not fit after the bars fold into a "+n" chip (estimated text widths).
  let room = width - 32 - 56 - 152 - (xpW + 72) - 120 - 42;
  const chips = [];
  for (let i = 0; i < all.length; i++) {
    const w = 16 + String(all[i].text).length * 6;
    const rest = all.length - i - 1;
    if (w + 4 <= room - (rest > 0 ? 34 : 0)) { chips.push(all[i]); room -= w + 4; continue; }
    const more = all.slice(i);
    chips.push({ key: "more", text: `+${more.length}`, color: C.idle, tooltip: more.map((b) => b.tooltip ?? b.text).join("\n") });
    break;
  }
  return v_flex().flex_none().px(16).pt(12).pb(8).gap(6)
    .child(h_flex().gap(12).items_center()
      .child(portrait("sh-portrait", face, 44, t, { calm: vm.calm }))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().h(22).gap(8).items_center()
          .child(div().min_w(0).truncate().text_size(15).font_semibold().text_color(t.fg).child(h.name))
          .child(div().flex_none().h(18).px(6).rounded(5).bg(t.btn).font_family(MONO).text_size(11).font_semibold().text_color(t.fg)
            .flex().items_center().child(h.level))
          .child(div().flex_none().text_size(12.5).text_color(t.muted).whitespace_nowrap().child(h.title))
          .when(Boolean(h.tag), (e) => e.child(headerTag(h, ui, t))))
        .child(div().id("sh-sub").h(16).min_w(0).truncate().text_size(11.5).text_color(t.muted)
          .when(Boolean(h.subTip), (e) => e.tooltip(h.subTip))
          .child(h.quest ? `${h.sub} · “${h.quest}”` : h.sub)))
      .child(h_flex().flex_none().gap(4).items_center().self_start()
        .child(div().flex_none().h(24).px(7).rounded(6).border(1).border_color(t.input).font_family(MONO).text_size(11.5)
          .font_semibold().text_color(t.fg).flex().items_center().tooltip(h.power.tooltip).child(h.power.text))
        .when(Boolean(h.focus), (e) => e.child(plainButton("sh-focus", "Focus", t, () => {
          if (env.overlay) closeOverlay(env.overlay);
          focusAgent(h.focus.pane, h.focus.address);
        }, { h: 24, px: 7, size: 11.5, icon: "ui/zoom.svg", tooltip: "Close the sheet and focus this agent's terminal" })))
        .child(close)))
    .child(h_flex().h(18).pl(56).gap(14).items_center().overflow_hidden()
      .child(statBar("HP", 80, h.hp.frac, C.hp, t, h.hp.text, `HP ${h.hp.text}`))
      .child(statBar("XP", xpW, h.xp.frac, C.xp, t, h.xp.text, h.xp.tooltip, { frac: h.xp.feFrac, color: tone(C.fresh, t) }))
      .child(statBar("SHIFT", 48, h.shift.frac, t.muted, t, h.shift.text, h.shift.tooltip))
      .child(h_flex().flex_1().min_w(0).gap(4).items_center().overflow_hidden().children(chips.map((b) =>
        div().id(`sh-buff-${b.key}`).flex_none().h(17).px(6).rounded(5).bg(alpha(b.color, t.light ? 0.14 : 0.16))
          .text_size(10.5).font_medium().text_color(ink(b.color, t)).whitespace_nowrap().flex().items_center().tooltip(b.tooltip).child(b.text)))));
}

/**
 * The chip after the title ("provisional", "contractor", "off duty"). With header.tagTab it is a
 * link to that tab ("provisional" opens Career, where the class chip locks it); tagTip explains.
 */
function headerTag(h, ui, t) {
  const el = tag(h.tag, C.idle, t).id("sh-tag").when(Boolean(h.tagTip), (e) => e.tooltip(h.tagTip));
  if (!h.tagTab || h.tagTab === ui.tab) return el;
  return el.cursor_pointer().hover((s) => s.opacity(0.8))
    .on_click((_e, cx) => { cx.stop_propagation(); pickTab(ui, h.tagTab, cx); });
}

// ── Gear ─────────────────────────────────────────────────────────────────────────────────────

function gearTab(vm, env, ui, t, width) {
  const g = vm.gear;
  const cardW = width >= 720 ? 256 : 220;
  const card = g.card ? itemCard("sh", g.card, env, ui, t, { w: cardW }) : emptyCard("sh", g.hint, t, cardW);
  return [doll(vm, env, ui, t), card, stashColumn("sh", g.stash, g.squash, env, ui, t, false)];
}

function doll(vm, env, ui, t) {
  const g = vm.gear;
  // A note band (a fight, off duty) takes 30 px: the doll tightens its rows so it still fits.
  const tight = Boolean(vm.note);
  const W = 216, H = tight ? 206 : 226, S = 52, STEP = tight ? 70 : 78;
  const bySlot = {};
  for (const s of g.slots ?? []) bySlot[s.slot] = s;
  const box = div().id("sh-doll").relative().w(W).h(H).flex_none();
  // Floor shadow, then the Termling (scale 2) between the two slot columns.
  box.child(div().absolute().left(W / 2 - 44).top(H - 30).w(76).h(10).rounded_full().bg(alpha("#000000", t.light ? 0.1 : 0.3)));
  const rig = vm.header.rig ?? {};
  const face = typeof rig.face === "string" ? rig.face : ">_";
  // The weapon sticks out to the right, so the rig stands a little left of centre.
  const fx = W / 2 - 6;
  box.child(renderTermling({ ...rig, key: "sh-rig", scale: 1.8, opacity: 1, face, x: fx, y: H - 25 }, { zoom: env.zoom ?? 1 },
    { feetX: fx, feetY: H - 25, bob: !vm.calm, blink: !vm.calm && vm.header.status === "working" }));
  SLOT_ORDER.forEach((slot, i) => {
    const s = bySlot[slot];
    if (!s) return;
    const x = i < 3 ? 0 : W - S;
    const y = (i % 3) * STEP;
    box.child(slotBox(s, S, t, ui).absolute().left(x).top(y));
  });
  const col = v_flex().w(W).gap(tight ? 8 : 10)
    .child(box)
    .child(h_flex().w(W).flex_wrap().gap(6).children((g.summary ?? []).map((m) =>
      v_flex().id(`sh-sum-${m.key}`).w((W - 6) / 2).h(36).px(8).justify_center().rounded(7).bg(t.card).border(1).border_color(t.border)
        .tooltip(m.tooltip)
        .child(div().text_size(10).text_color(t.muted).child(m.label))
        .child(div().font_family(MONO).text_size(12.5).font_semibold().text_color(t.fg).child(m.value)))));
  // Scrolls like the stash column: with a note band (a fight, off duty) the doll and its summary
  // are taller than the body and would otherwise spill over the footer.
  return div().relative().flex_none().w(W).h_full()
    .child(v_flex().id("sh-doll-col").absolute().left(0).top(0).size_full().overflow_y_scroll().child(col));
}

function slotBox(s, S, t, ui) {
  const it = s.item;
  const sel = it && (ui.selected === it.uid);
  const col = it ? tone(it.rarColor, t) : t.dim;
  const inner = div().relative().size(S).rounded(9)
    .bg(it ? alpha(it.rarColor, t.light ? 0.1 : 0.13) : t.well)
    .border(sel ? 2 : 1.5).border_color(sel ? t.accent : it ? alpha(col, 0.85) : t.border)
    .when(!it, (e) => e.border_dashed())
    .flex().items_center().justify_center()
    .child(it ? itemIcon(it, 28, t) : svg(art(s.icon)).w(20).h(20).flex_none().text_color(t.dim).opacity(0.6))
    .when(Boolean(it?.pol), (e) => e.child(div().absolute().right(4).bottom(2).font_family(MONO).text_size(9.5).font_bold().text_color(t.fg).child(it.pol)))
    .when(Boolean(it?.locked), (e) => e.child(svg(art("ui/lock.svg")).absolute().left(4).top(4).w(9).h(9).text_color(t.muted)));
  return v_flex().id(`sh-slot-${s.slot}`).w(S).gap(2).items_center()
    .when(Boolean(it), (e) => e.cursor_pointer().on_click((_e, cx) => {
      cx.stop_propagation();
      ui.selected = ui.selected === it.uid ? null : it.uid;
      ui.hover = null;
      ui.armed = null;
      cx.notify();
    }))
    .tooltip(it ? `${s.label}: ${it.name} · ${it.tooltip}` : `${s.label}: empty`)
    .child(inner)
    .child(div().text_size(10).text_color(t.dim).child(s.label));
}

/** The stash column (list rows). Shared with the herd panel's narrow layouts. */
export function stashColumn(prefix, stash, squash, env, ui, t, tiles) {
  const picking = ui.squashMode && Boolean(squash?.available);
  const picked = new Set(squash?.picked ?? []);
  const rowOpts = (it) => ({
    selected: !picking && ui.selected === it.uid,
    picking, picked: picked.has(it.uid),
    onClick: (cx) => {
      if (picking) { if (it.squashable) togglePick(ui, it.uid); }
      else { ui.selected = ui.selected === it.uid ? null : it.uid; ui.hover = null; ui.armed = null; }
      cx.notify();
    },
    onHover: (on, cx) => {
      if (picking) return;
      if (on && ui.hover !== it.uid) { ui.hover = it.uid; cx.notify(); }
      else if (!on && ui.hover === it.uid) { ui.hover = null; cx.notify(); }
    },
  });
  const items = stash.items ?? [];
  const list = tiles
    ? h_flex().flex_wrap().gap(6).items_start().children(items.map((it) => itemTile(prefix, it, t, rowOpts(it))))
    : v_flex().gap(1).children(items.map((it) => itemRow(prefix, it, t, rowOpts(it))));
  return v_flex().id(`${prefix}-stash`).flex_1().min_w(0).h_full().min_h(0).gap(6)
    .child(stashHeader(prefix, stash, squash, t, ui))
    .child(filterChips(prefix, stash.filters, t, (patch, cx) => { Object.assign(ui.filter, patch); ui.hover = null; cx.notify(); }))
    .child(div().relative().flex_1().min_h(0).rounded(8).bg(t.well)
      .child(v_flex().id(`${prefix}-stash-list`).absolute().left(0).top(0).size_full().overflow_y_scroll()
        .when(Boolean(env.scroll), (e) => e.track_scroll(env.scroll))
        .child(v_flex().p(4)
          .child(list)
          .when(items.length === 0, (e) => e.child(div().px(8).py(14).text_size(11.5).text_color(t.dim).text_center().child(stash.emptyText)))
          .when(Boolean(stash.more), (e) => e.child(div().px(8).py(6).text_size(11).text_color(t.dim).text_center().child(stash.more))))))
    .when(picking, (e) => e.child(squashBar(prefix, squash, env, ui, t)));
}

// ── Skills ───────────────────────────────────────────────────────────────────────────────────

const LADDER_DOT = { done: "✓", current: "●", next: "○", locked: "·" };

function skillsTab(vm, env, ui, t) {
  const s = vm.skills;
  const al = s.autoLearn;
  const col = v_flex().gap(10).pr(4)
    .child(v_flex().id("sh-sp").px(12).py(10).gap(2).rounded(10).bg(t.card).border(1).border_color(s.sp.count > 0 ? alpha(t.accent, 0.5) : t.border)
      .tooltip(s.sp.tooltip)
      .child(h_flex().gap(8).items_end()
        .child(div().font_family(MONO).text_size(26).font_bold().line_height(1).text_color(s.sp.count > 0 ? ink(t.accent, t) : t.fg).child(String(s.sp.count)))
        .child(div().pb(2).text_size(12).text_color(t.muted).child(s.sp.text))))
    .child(h_flex().gap(8).items_center()
      .child(switchEl("sh-autolearn", al.on, t, al.hint, (cx) => runAction(al.action, env, ui, cx), !al.action.enabled))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(12).font_medium().child("Auto-learn"))
        .child(div().text_size(10.5).text_color(t.dim).child(al.hint))))
    // The SP note (Intern points refunded at Lv 10, a provisional class's refund) sits with the
    // respec rules it qualifies, above the ladder: at the column's foot it was out of view.
    .child(v_flex().gap(4)
      .child(actionButton("sh-respec", s.respec, env, ui, t, { grow: false }))
      .child(div().text_size(10.5).text_color(t.dim).child(s.rules))
      .when(Boolean(s.note), (e) => e.child(div().id("sh-sp-note").text_size(10.5).text_color(t.muted).child(s.note))))
    .child(sectionTitle("Career", t))
    .child(v_flex().gap(1).children((s.ladder ?? []).map((l) => h_flex().id(`sh-lad-${l.key}`).h(19).gap(7).items_center()
      .opacity(l.state === "locked" ? 0.55 : 1)
      .child(div().w(10).flex_none().text_center().text_size(11).text_color(l.state === "current" ? ink(t.accent, t) : l.state === "done" ? t.good : t.dim)
        .child(LADDER_DOT[l.state] ?? "·"))
      .child(div().flex_1().text_size(11.5).font_medium().text_color(l.state === "current" ? t.fg : t.muted).child(l.title))
      .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(l.levels)))));
  // Scrolls like the skill list: with a note band (a fight) or the Intern / provisional note, the
  // column is taller than the body and its foot ran under the footer.
  const left = div().relative().flex_none().w(210).h_full()
    .child(v_flex().id("sh-skills-l").absolute().left(0).top(0).size_full().overflow_y_scroll().child(col));
  const list = div().relative().flex_1().min_w(0).h_full()
    .child(v_flex().id("sh-skills").absolute().left(0).top(0).size_full().overflow_y_scroll()
      .child(v_flex().gap(6).pr(4).children((s.skills ?? []).map((k) => skillCard(k, env, ui, t)))));
  return [left, list];
}

function skillCard(k, env, ui, t) {
  const frac = k.max > 0 ? k.rank / k.max : 0;
  return h_flex().id(`sh-${k.key}`).flex_none().min_h(58).px(10).py(7).gap(10).items_center().rounded(9).bg(t.card).border(1).border_color(t.border)
    .tooltip(k.tooltip)
    .when(k.locked, (e) => e.opacity(0.55))
    .child(div().size(36).flex_none().rounded(8).bg(k.locked ? t.well : alpha(t.accent, t.light ? 0.12 : 0.16))
      .flex().items_center().justify_center().font_family(MONO).text_size(k.glyph && k.glyph.length > 2 ? 10.5 : 13).font_bold()
      .text_color(k.locked ? t.dim : ink(t.accent, t)).child(k.glyph || "·"))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(h_flex().gap(8).items_center()
        .child(div().min_w(0).truncate().text_size(12.5).font_semibold().child(k.name))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(k.slotLabel))
        .child(div().flex_1())
        .when(Boolean(k.cd), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(k.cd))))
      // The effect and the next rank wrap rather than cut: their numbers are the card's point
      // ("… for 88% each" was cut to "… for 8…" on the longer skills).
      .child(div().min_w(0).text_size(11.5).line_height(1.3).text_color(t.muted).child(k.locked && k.lockText ? `Unlocks at ${k.lockText}` : k.effect))
      .child(h_flex().gap(8).items_center()
        .child(thinBar(90, 4, frac, k.rank >= k.max ? tone(C.working, t) : t.accent, track(t)))
        .child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.fg).child(k.rankText))
        .when(Boolean(k.next) && !k.locked, (e) => e.child(div().flex_1().min_w(0).text_size(10.5).line_height(1.3).text_color(t.dim).child(k.next)))))
    .when(Boolean(k.learn), (e) => e.child(actionButton(`sh-learn-${k.key}`, k.learn, env, ui, t, { h: 26, px: 9, size: 12, cost: false })));
}

// ── Stats ────────────────────────────────────────────────────────────────────────────────────

function statsTab(vm, t) {
  const s = vm.stats;
  const cols = h_flex().w_full().gap(12).items_start().children((s.groups ?? []).map((g) =>
    v_flex().id(`sh-sg-${g.key}`).flex_1().min_w(0).gap(1).px(10).pt(8).pb(6).rounded(10).bg(t.card).border(1).border_color(t.border)
      .child(div().pb(3).text_size(11).font_semibold().text_color(t.dim).child(g.title))
      .children(g.rows.map((r) => h_flex().id(`sh-st-${r.key}`).h(21).gap(6).items_center().tooltip(r.tooltip)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(r.label))
        .when(Boolean(r.sub), (e) => e.child(div().flex_none().font_family(MONO).text_size(10).text_color(t.dim).child(r.sub)))
        .child(div().flex_none().font_family(MONO).text_size(12).font_semibold().text_color(r.color ? ink(r.color, t) : t.fg).child(r.value))))));
  const w = s.why;
  const why = w ? v_flex().id("sh-why").w_full().gap(6).px(12).py(9).rounded(10).bg(t.card).border(1).border_color(alpha(C.xp, 0.4))
    .child(h_flex().gap(8).items_center()
      .child(div().text_size(11).font_semibold().text_color(t.dim).child(w.title))
      .child(div().font_family(MONO).text_size(13).font_bold().text_color(ink(C.xp, t)).child(w.total)))
    .child(h_flex().flex_wrap().gap(6).children((w.parts ?? []).map((p) => h_flex().id(`sh-why-${p.key}`).h(20).px(7).gap(5).items_center().rounded(5).bg(t.well)
      .when(Boolean(p.tooltip), (e) => e.tooltip(p.tooltip))
      .child(div().text_size(11).text_color(t.muted).child(p.label))
      .child(div().font_family(MONO).text_size(11).font_semibold().text_color(goodColor(p.good, t)).child(p.value)))))
    .children((w.notes ?? []).map((n) => div().text_size(11).text_color(t.dim).child(n))) : null;
  return [div().relative().flex_1().h_full()
    .child(v_flex().id("sh-stats").absolute().left(0).top(0).size_full().overflow_y_scroll()
      .child(v_flex().gap(12).children(kids([cols, why]))))];
}

// ── Career ───────────────────────────────────────────────────────────────────────────────────

function careerTab(vm, env, ui, t) {
  const c = vm.career;
  // Scrolls like the right column: a review line, a note band (a fight, off duty) and the boss card
  // together are taller than the body and would otherwise spill over the footer. While its zone
  // boss fight runs (or is paused) the boss card leads the column: below the ladder its Retreat
  // sat under the fold, behind a scroll, at the dialog's 760 × 500.
  const boss = c.boss ? bossCard(c.boss, env, ui, t) : null;
  const first = Boolean(c.boss?.fighting);
  const left = div().relative().flex_none().w(318).h_full()
    .child(v_flex().id("sh-career-l").absolute().left(0).top(0).size_full().overflow_y_scroll()
      .child(v_flex().gap(8).pr(4).children(kids([
        first ? boss : null,
        sectionTitle("Career ladder", t),
        v_flex().gap(4).children((c.ladder ?? []).map((l) => ladderRow(l, env, ui, t))),
        first ? null : boss,
      ]))));
  const right = div().relative().flex_1().min_w(0).h_full()
    .child(v_flex().id("sh-career-r").absolute().left(0).top(0).size_full().overflow_y_scroll()
      .child(v_flex().gap(10).pr(4).children(kids([
        c.rebind ? rebindCard(c.rebind, env, ui, t) : null,
        c.job ? jobCard(c.job, t) : null,
        classCard(c, env, ui, t),
        mapCard(c.map, env, ui, t),
        identity(vm, env, ui, t),
      ]))));
  return [left, right];
}

function ladderRow(l, env, ui, t) {
  const current = l.state === "current";
  const rv = l.review;
  // The review line shows only while it means something (ready, running, or won on this tier): a
  // tier left behind keeps its ✓ (the tooltip names the review it passed), and a won review is
  // one line, so at Lv 60+ the boss card below the ladder still shows whole at 760 × 500.
  const won = rv?.status === "won";
  const showReview = rv && rv.status !== "locked" && !(won && l.state === "done");
  const rvColor = rv ? (won ? C.working : rv.status === "ready" ? C.hp : rv.status === "running" ? C.blocked : C.idle) : C.idle;
  return v_flex().id(`sh-cl-${l.key}`).px(10).py(5).gap(3).rounded(8)
    .bg(current ? alpha(t.accent, t.light ? 0.08 : 0.1) : t.card).border(1).border_color(current ? alpha(t.accent, 0.45) : rv?.status === "ready" ? alpha(C.hp, 0.45) : t.border)
    .when(l.state === "locked", (e) => e.opacity(0.6))
    .tooltip(rv ? `${l.title}: ${l.note ?? ""} · ${rv.name}: ${rv.statusText}` : `${l.title}: ${l.note ?? ""}`)
    .child(h_flex().h(20).gap(8).items_center()
      .child(div().w(12).flex_none().text_center().text_size(12).text_color(current ? ink(t.accent, t) : l.state === "done" ? t.good : t.dim)
        .child(LADDER_DOT[l.state] ?? "·"))
      .child(div().flex_none().text_size(12.5).font_semibold().child(l.title))
      .child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.dim).child(l.levels))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).text_right().child(l.note ?? "")))
    .when(Boolean(showReview) && won && !rv.challenge, (e) => e.child(h_flex().id(`sh-clr-${l.key}`).pl(20).gap(8).items_center()
      .child(div().size(7).flex_none().rounded_full().bg(tone(rvColor, t)))
      .child(div().flex_none().text_size(11.5).text_color(t.fg).child(rv.statusText))
      .child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(rv.name))))
    .when(Boolean(showReview) && !(won && !rv.challenge), (e) => e.child(h_flex().pl(20).gap(8).items_center()
      .child(div().size(7).flex_none().rounded_full().bg(tone(rvColor, t)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.fg).child(rv.statusText))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(rv.name))
          .when(Boolean(rv.estimate), (x) => x.child(div().flex_none().font_family(MONO).text_size(10.5).font_semibold().text_color(ink(rv.estimate.color, t)).child(rv.estimate.text)))))
      .when(Boolean(rv.challenge), (x) => x.child(actionButton(`sh-rv-${l.key}`, rv.challenge, env, ui, t, { h: 26, px: 10, size: 11.5, cost: false })))));
}

function panel(id, t, title, right) {
  return v_flex().id(id).px(12).py(10).gap(7).rounded(10).bg(t.card).border(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.dim).child(title))
      .when(Boolean(right), (e) => e.child(right)));
}

function classCard(c, env, ui, t) {
  const sig = c.signature;
  return panel("sh-class", t, "Class from behaviour", div().text_size(10.5).text_color(t.dim).child(sig.tasks))
    .child(div().text_size(12).text_color(t.fg).child(sig.text))
    .child(h_flex().gap(6).items_center()
      .child(div().text_size(11.5).text_color(t.muted).child("Recommended"))
      .child(div().text_size(11.5).font_semibold().child(sig.recommended))
      .child(div().flex_1())
      .child(div().text_size(10.5).text_color(t.dim).child(sig.state)))
    .child(h_flex().flex_wrap().gap(5).children((c.classes?.options ?? []).map((o) => classChip(o, env, ui, t))))
    .child(div().text_size(10.5).text_color(t.dim).child(c.classes?.note ?? ""));
}

function classChip(o, env, ui, t) {
  const on = !!o.current;
  // The current class is inert, unless it is provisional (o.lock): then a click locks it.
  const lock = on && !!o.lock;
  // A career change (or a lock) asks first (ActionVM.confirm): the armed chip shows the question.
  const armed = !!o.confirm && ui.armed === o.key;
  const fg = armed ? t.bad : on ? ink(o.color, t) : t.fg;
  const el = h_flex().id(`sh-cls-${o.key}`).flex_none().h(24).px(8).gap(5).items_center().rounded(6)
    .bg(armed ? alpha(C.hp, t.light ? 0.12 : 0.16) : on ? alpha(o.color, t.light ? 0.16 : 0.2) : t.btn)
    .border(1).border_color(armed ? alpha(C.hp, 0.5) : on ? tone(o.color, t) : t.input)
    .when(lock && !armed, (e) => e.border_dashed())
    .text_size(11.5).font_medium().text_color(fg)
    .child(div().size(7).flex_none().rounded_full().bg(tone(o.color, t)))
    .child(div().whitespace_nowrap().child(armed ? o.confirm : o.label))
    .when(Boolean(o.recommended), (e) => e.child(svg(art("ui/star.svg")).w(10).h(10).flex_none().text_color(ink(C.xp, t))))
    .when(lock && !armed, (e) => e.child(svg(art("ui/lock.svg")).w(10).h(10).flex_none().text_color(fg)))
    .when(Boolean(o.tooltip || o.cost), (e) => e.tooltip([o.tooltip, o.cost].filter(Boolean).join(" · ")));
  if ((on && !lock) || !o.enabled) return el.when(!on, (e) => e.opacity(0.45)).cursor_default().on_click((_e, cx) => cx.stop_propagation());
  return el.cursor_pointer().hover((s) => s.bg(t.btnHover)).on_click((_e, cx) => { cx.stop_propagation(); runAction(o, env, ui, cx); });
}

function bossCard(b, env, ui, t) {
  // The button (Challenge / Fight again / Retreat) sits in the card's title row, beside the short
  // "Zone boss": armed, "Retreat? (a Postmortem)" grows to the left there, under the pointer,
  // without squeezing the boss's name and status. The win estimate stands beside the button, so
  // the two are read together and stay in view when the card sits after a long ladder (an open
  // door at Lv 30+); during a fight it moves beside the status, leaving the row to the Retreat.
  const est = () => div().id("sh-boss-est").flex_none().font_family(MONO).text_size(11).font_semibold()
    .text_color(ink(b.estimate.color, t)).child(b.estimate.text);
  const estTop = Boolean(b.estimate) && !b.fighting;
  const go = b.challenge ? actionButton("sh-boss-go", b.challenge, env, ui, t, { h: 24, px: 9, size: 11.5, cost: false }) : null;
  const right = estTop || go ? h_flex().flex_none().gap(8).items_center().children(kids([estTop ? est() : null, go])) : null;
  return panel("sh-boss", t, "Zone boss", right)
    .when(Boolean(b.fighting), (e) => e.border_color(alpha(C.hp, 0.5)))
    .child(h_flex().gap(8).items_center()
      .child(svg(art("ui/boss.svg")).w(14).h(14).flex_none().text_color(ink(C.hp, t)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().id("sh-boss-name").truncate().text_size(12.5).font_semibold().child(b.name))
        .child(div().truncate().text_size(11).text_color(t.muted).child(b.zone))
        .child(h_flex().gap(8).items_center()
          .child(div().id("sh-boss-status").flex_1().min_w(0).truncate().text_size(11).text_color(t.fg).child(b.status))
          .when(Boolean(b.estimate) && !estTop, (e) => e.child(est())))));
}

/**
 * Localhost's Job line (docs/TOWN.md §7.6, round 1 read-only): the station in the title, the job
 * title and job XP on the right with a thin bar toward the next rank, and why the hero is or is not
 * on duty. Words of the job, never the agent's status (that stays "resting" in the header).
 */
function jobCard(j, t) {
  // the panel's look with a head that wraps: in a narrow sheet (a 760 px dialog at zoom 1.25 is
  // 608 px) the job title moves under "Job · Review Desk" instead of squeezing it onto three lines
  const head = h_flex().flex_wrap().justify_between().items_center().gap_x(8).gap_y(3)
    .child(div().flex_none().whitespace_nowrap().text_size(11).font_semibold().text_color(t.dim).child(j.title))
    .when(Boolean(j.line), (e) => e.child(div().id("sh-job-rank").flex_none().whitespace_nowrap().font_family(MONO).text_size(10.5).text_color(ink(C.xp, t)).child(j.line)));
  return v_flex().id("sh-job").px(12).py(10).gap(7).rounded(10).bg(t.card).border(1).border_color(t.border)
    .child(head)
    .tooltip(j.tooltip ?? j.status ?? "")
    .when(Boolean(j.line), (e) => e.child(fluidBar(j.frac, 3, ink(C.xp, t), alpha(t.fg.slice(0, 7), t.light ? 0.12 : 0.14))))
    .child(h_flex().gap(8).items_center()
      .child(div().size(7).flex_none().rounded_full().bg(j.onDuty ? tone(C.xp, t) : alpha(t.fg.slice(0, 7), 0.3)))
      .child(div().id("sh-job-status").flex_1().min_w(0).text_size(11.5).line_height(1.3).text_color(t.fg).child(j.status ?? "")));
}

function mapCard(m, env, ui, t) {
  if (!m) return null;
  return panel("sh-map", t, "Map", div().text_size(10.5).text_color(t.dim).child(m.label))
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.fg).child(m.current))
      .child(actionButton("sh-map-auto", m.auto, env, ui, t, { h: 22, px: 8, size: 11, cost: false })))
    .children((m.zones ?? []).map((z) => h_flex().id(`sh-mz-${z.key}`).gap(6).items_center()
      .child(div().w(112).flex_none().truncate().text_size(11).text_color(t.dim).child(z.name))
      .children(z.maps.map((mp) => {
        const el = div().id(`sh-mp-${mp.key}`).flex_none().h(20).px(6).rounded(5).flex().items_center()
          .font_family(MONO).text_size(10.5).text_color(mp.on ? t.accent_fg : t.fg)
          .bg(mp.on ? t.accent : t.btn).border(1).border_color(mp.on ? t.accent : t.input)
          .when(Boolean(mp.tooltip), (e) => e.tooltip(mp.tooltip))
          .child(mp.label);
        if (mp.on || !mp.enabled) return el.when(!mp.on, (e) => e.opacity(0.4)).on_click((_e, cx) => cx.stop_propagation());
        return el.cursor_pointer().hover((s) => s.bg(t.btnHover)).on_click((_e, cx) => { cx.stop_propagation(); runAction(mp, env, ui, cx); });
      }))));
}

function rebindCard(r, env, ui, t) {
  return panel("sh-rebind", t, r.title)
    .child(div().text_size(11).text_color(t.dim).child(r.hint))
    .child(v_flex().gap(4).children((r.options ?? []).map((o) => h_flex().gap(8).items_center()
      .child(rebindLine(o, t))
      .child(actionButton(`sh-rb-${o.key}`, o, env, ui, t, { h: 22, px: 8, size: 11, cost: false })))));
}

/**
 * A Rebind option's line, "Claude Code in ceo-assistant-billing-qa · “Write tests…” (contractor)"
 * (round 4c): with the view's three parts (ActionVM.line), what follows the space gives way first,
 * then the space is cut in the middle, both ends kept ("ceo-a…billing-eng"), so two agents in
 * spaces that share a start stay apart; the whole line is on the Bind button's hover. Without
 * them, the line is cut at its end as before.
 */
function rebindLine(o, t) {
  const p = Array.isArray(o.line) && o.line.length === 3 ? o.line.map((x) => String(x ?? "")) : null;
  const box = () => h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_size(11.5).text_color(t.muted);
  if (!p || !p[1]) return div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(o.tooltip ?? "");
  // (a text box drops a space at either end: no-break spaces keep "in " and " · ")
  const lead = p[0].replace(/ $/, "\u00A0");
  const rest = p[2].replace(/^ /, "\u00A0");
  return box()
    .when(Boolean(lead), (e) => e.child(div().flex_none().child(lead)))
    .child(middleCut(p[1], { tail: 12 }))
    .when(Boolean(rest), (e) => e.child(div().flex_1().min_w(0).truncate().child(rest)));
}

function identity(vm, env, ui, t) {
  const c = vm.career;
  const input = env.inputs?.name ?? null;
  const save = (cx) => {
    const name = String(input?.value?.() ?? "").trim();
    if (!name || name === c.identity.name) { flash(ui, { ok: false, msg: "Type a new name first." }, "Rename", cx); cx.notify(); return; }
    const r = env.act ? env.act("rename", { heroId: vm.heroId, name }) : null;
    flash(ui, r, "Rename", cx);
    if (!r || r.ok !== false) { ui.renaming = false; ui.typing = false; env.focus?.focus?.(); }
    cx.notify();
  };
  const row = ui.renaming && input
    ? h_flex().gap(6).items_center()
      .child(Input.new(input).flex_1().min_w(0).h(26).px(8).rounded(6).border(1).border_color(t.accent).bg(t.well).text_size(12).text_color(t.fg))
      .child(plainButton("sh-rename-save", "Save", t, save, { h: 26, px: 9, size: 11.5, on: true }))
      .child(plainButton("sh-rename-cancel", "Cancel", t, (cx) => { ui.renaming = false; ui.typing = false; env.focus?.focus?.(); cx.notify(); }, { h: 26, px: 9, size: 11.5 }))
    : h_flex().gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().child(c.identity.name))
      .child(plainButton("sh-rename", "Rename", t, (cx) => {
        if (!input) return;
        input.set_value?.(c.identity.name);
        input.set_selected_range?.({ start: 0, end: c.identity.name.length });
        input.focus?.();
        // The Input mounts on the next frame: focus it again then (shipped worktree/prompt mods).
        cx.timer?.after?.(100, () => input.focus?.());
        ui.renaming = true;
        cx.notify();
      }, { h: 24, px: 8, size: 11, disabled: !input || c.identity.canRename === false }))
      .when(Boolean(c.retire), (e) => e.child(actionButton("sh-retire", c.retire, env, ui, t, { h: 24, px: 8, size: 11, cost: false })));
  return v_flex().id("sh-identity").flex_none().gap(6).px(12).py(10).rounded(10).bg(t.card).border(1).border_color(t.border)
    .child(div().text_size(11).font_semibold().text_color(t.dim).child("Name"))
    .child(row)
    .child(div().text_size(10.5).text_color(t.dim).child(c.identity.hint));
}

// ── Journal ──────────────────────────────────────────────────────────────────────────────────

function journalTab(vm, t) {
  const j = vm.journal;
  const lines = j.lines ?? [];
  return [div().relative().flex_1().h_full().rounded(10).bg(t.well)
    .child(v_flex().id("sh-journal").absolute().left(0).top(0).size_full().overflow_y_scroll()
      .child(v_flex().p(6).gap(1)
        .children(lines.map((l) => h_flex().id(`sh-j-${l.key}`).min_h(26).px(8).gap(9).items_center().rounded(6)
          .hover((s) => s.bg(t.hover))
          .child(div().w(62).flex_none().font_family(MONO).text_size(10.5).text_color(t.dim).child(l.when))
          .child(svg(art(l.icon)).w(13).h(13).flex_none().text_color(tone(l.color, t)))
          .child(div().flex_1().min_w(0).text_size(12).text_color(t.fg).child(l.text))
          .when(Boolean(l.value), (e) => e.child(div().flex_none().font_family(MONO).text_size(11).text_color(ink(l.color, t)).child(l.value)))))
        .when(lines.length === 0, (e) => e.child(div().py(30).text_center().text_size(12).text_color(t.dim).child(j.emptyText)))))];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Role

// The last tab shown, remembered across sheets while the VM lives (module scope is shared by
// every copy; a reload forgets it, which is fine for a convenience).
const LAST = { sheet: "gear" };

export default class Sheet {
  init(props, cx, host) {
    this.props = props ?? {};
    this.host = host ?? null;
    const p = this.props;
    this.heroId = p.heroId ?? null;
    this.address = null; // the terminal it plays on (a Contractor's sheet follows its promotion)
    this.name = null;    // and its name: only a hero of that name there is the promoted Contractor
    this.ui = newUi(SHEET_TABS.includes(p.tab) ? p.tab : LAST.sheet);
    if (Number.isFinite(p.focus)) { this.ui.selected = p.focus; this.ui.tab = "gear"; }
    // After a successful equip / squash, drop selections that no longer exist.
    this.ui.after = (a, r) => {
      if (r && r.ok === false) return;
      if (a.cmd === "squash") { this.ui.squashMode = false; this.ui.filter.squash = []; }
      if (a.cmd === "deprecate" || a.cmd === "squash") { this.ui.selected = null; this.ui.hover = null; }
    };
    this.scroll = ScrollHandle.new();
    this.inputs = { name: InputState.new({ placeholder: "New name" }) };
    this.inputs.name.on("focus", (_e, cx) => { this.ui.typing = true; cx.notify(); });
    this.inputs.name.on("blur", (_e, cx) => { this.ui.typing = false; cx.notify(); });
    this.inputs.name.on("submit", (_e, cx) => {
      const name = String(this.inputs.name.value() ?? "").trim();
      if (!name || this.heroId == null) return;
      const r = this.host?.command?.("rename", { heroId: this.heroId, name });
      flash(this.ui, r, "Rename", cx);
      // Like Save: the input unmounts, so hand the keyboard back to the dialog (tab keys).
      if (!r || r.ok !== false) { this.ui.renaming = false; this.ui.typing = false; this.focus?.focus?.(); }
      cx.notify();
    });
    if (cx?.focus_handle) {
      this.focus = cx.focus_handle();
      this.focus.focus();
    }
  }

  render(cx) {
    const host = this.host;
    // a Contractor's sheet also sends its terminal and name: promoted to the roster (round 4) it
    // takes a new hero id, which the VM then carries, and the sheet follows it
    const args = { heroId: this.heroId, tab: this.ui.tab, filter: filterArgs(this.ui) };
    if (this.heroId < 0 && this.address) {
      args.address = this.address;
      if (this.name) args.name = this.name;
    }
    const vm = this.heroId == null ? null : host?.view?.("sheet", args) ?? null;
    if (vm && vm.tab && SHEET_TABS.includes(vm.tab)) this.ui.tab = vm.tab;
    if (vm && !vm.missing) {
      if (Number.isInteger(vm.heroId) && vm.heroId !== this.heroId) this.heroId = vm.heroId;
      const addr = vm.header?.focus?.address;
      if (typeof addr === "string" && addr) this.address = addr;
      const name = vm.header?.name;
      if (typeof name === "string" && name) this.name = name;
      // the host's dialog registry follows too (herdr keeps the overlay's first props): opening
      // the promoted hero's sheet then keeps this dialog instead of closing and reopening it
      if (this.props.overlay != null) host?.followSheet?.(this.props.overlay, { heroId: this.heroId, address: this.address, name: this.name });
    }
    return renderSheet(vm, {
      width: this.ui.size?.w ?? 760, height: this.ui.size?.h ?? 500, zoom: zoom(), theme: dialogTokens(), host,
      act: (name, args) => host?.command?.(name, args), ui: this.ui, overlay: this.props.overlay ?? null,
      inputs: this.inputs, focus: this.focus ?? null, scroll: this.scroll,
    });
  }

  /** Key commands that reached this copy: the sheet hotkey closes it; the others act as usual. */
  command(name) {
    if (name === "sheet") { if (this.props.overlay) closeOverlay(this.props.overlay); return true; }
    return chromeCommand(name, this.host);
  }

  close() {
    this.inputs?.name?.release?.();
  }
}

