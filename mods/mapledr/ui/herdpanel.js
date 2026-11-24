// Role "herd": the Herd panel dialog (DESIGN §11.14, §11.15, §10), 760×520. Opened with
//   openOverlay({mod:"mapledr", kind:"dialog", width:760, height:520, props:{role:"herd", tab?}})
// (ui/party.js openHerd). Esc and a click outside are herdr's; the close button runs
// closeOverlay(props().overlay).
//
// Tabs: Upgrades (Localhost buildings), Stash (vendor/ grid with filters, the item card and
// Squash Merge), Tracker (Bug Tracker per zone: tiers, perks, mob bug reports, boss first clears),
// Bosses (the nine bosses and the Backlog: status, win estimate, Wounds / Lessons / cooldowns,
// Challenge / Retreat), Roster (every hero, Hall of Fame), Digest ("since you last looked") and
// Settings (herd.cfg: calm, damage numbers, stage height, every auto.* switch, notifications,
// the HUD strip, the herd's name).
//
// The pure renderer is renderHerd(vm, env); the role keeps UI state (tab, stash filter and
// selection, squash picks, tracker zone, last command result) and asks host.view("herd",
// {tab, filter}) for the VM. Like the sheet, every string comes from game/view.js herdView and
// every button is an ActionVM (see the shared typedefs in ui/sheet.js); herdr chrome (the HUD
// toggle, the stage height) runs run("layout.toggle" | "layout.resize") from handlers.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// VIEW MODEL (ARCHITECTURE §5 leaves HerdVM to view.js + this file; this block is the contract)
//
// host.view("herd", HerdArgs) → HerdVM | null (null only while the world loads)
/**
 * @typedef {Object} HerdArgs
 * @property {"upgrades"|"stash"|"tracker"|"bosses"|"roster"|"digest"|"settings"} tab
 * @property {import("./sheet.js").StashFilter} filter   the Stash tab's query and selection
 *           (ARCHITECTURE §5 lists herdView(world, {tab}); `filter` is this file's addition)
 *
 * @typedef {Object} HerdVM
 * @property {string} tab       the tab this VM fills
 * @property {Array<{id:string, label:string, badge:string|null}>} tabs   digest badge "3" / "•"
 * @property {boolean} calm
 * @property {{name:string, release:string, releaseTip:string, gold:string, snippets:string,
 *            sub:string, sprint:null|{label:string, have:number, need:number, text:string}}} header
 *            release "v2.3"; releaseTip "Release Train: 412 Seals · v2.4 at 431 (+0.5% XP and gold each)";
 *            sub "12 heroes · 5 working · 1 waiting for you"; sprint.text "Sprint 18 / 45"
 * @property {UpgradesVM|null} upgrades   only the shown tab's part is filled; the others are null
 * @property {HerdStashVM|null} stash
 * @property {TrackerVM|null} tracker
 * @property {BossesVM|null} bosses
 * @property {RosterVM|null} roster
 * @property {DigestVM|null} digest
 * @property {SettingsVM|null} settings
 *
 * @typedef {Object} BuildingVM
 * @property {string} key       "b:campfire"
 * @property {string} id        building id (campfire, coffee_machine, ci_forge, vendor, docs_library, war_room)
 * @property {string} name      "Campfire"
 * @property {{path:string, mask:boolean}} icon   art-relative; mask → tinted svg(), else image()
 * @property {number} level     @property {number} max
 * @property {string} levelText "4 / 10"
 * @property {string} effect    now: "Fresh Eyes cap 120 min"
 * @property {string|null} next next level: "→ 135 min · Squash Merge at 3"; null when maxed
 * @property {boolean} maxed
 * @property {ActionVM|null} buy   cmd "buy" {building}; label "Buy", cost "64.8k gold"; null when maxed
 * @property {string} tooltip   "Heavier than it looks." (flavour / rules)
 *
 * @typedef {Object} UpgradesVM
 * @property {BuildingVM[]} buildings   6, in D§10.2 order
 * @property {string} note      "Autopilot buys the cheapest upgrade when gold ≥ 3× its cost (Auto buildings: on)."
 * @property {string|null} trophies   "Trophies: +3% damage and max HP for every hero"
 *
 * @typedef {Object} HerdStashVM   StashVM (ui/sheet.js) plus
 * @property {CardVM|null} card    the focused item; owner = "Best on Kip · score +3.2%", its
 *                                 actions may include an equip on that hero
 * @property {string} hint         card placeholder
 * @property {SquashVM|null} squash
 *
 * @typedef {Object} ZoneTrackVM
 * @property {string} key       zone id
 * @property {string} name      "Lint Meadows" (locked: "???")
 * @property {string} num       "1"
 * @property {boolean} locked
 * @property {string} accent    zone accent colour (hex)
 * @property {string} kills     "12,480"
 * @property {number} tier      0..3
 * @property {string|null} tierName   "Reproduced"
 * @property {{frac:number, text:string}} progress   to the next tier: "12,480 / 50,000"
 * @property {string} perk      "+4% XP (×2)"; locked: ""
 * @property {Array<{key:string, name:string, need:string, reached:boolean}>} tiers   Triaged/Reproduced/Fixed
 * @property {Array<{key:string, mobId:string, name:string, ticket:string, kills:string,
 *            flavor:string, sprite:string, known:boolean}>} mobs   sprite: art-relative ("mob/typo_sprout.svg")
 * @property {{key:string, name:string, sprite:string, cleared:string|null, kills:string, known:boolean}} boss
 *            cleared "Fixed Nov 2, 2026" or null
 *
 * @typedef {Object} TrackerVM
 * @property {ZoneTrackVM[]} zones   9
 * @property {string} selected  the zone shown first (the frontier)
 * @property {string} totals    "84,210 bugs filed · 4 zones Triaged · trophies +3%"
 *
 * @typedef {Object} BossRowVM
 * @property {string} key       boss id
 * @property {string} name      "The Ignored Warning"
 * @property {string} where     "Lint Meadows · Lv 12"
 * @property {string} sprite    art-relative ("boss/ignored_warning.svg", 112×96)
 * @property {"fixed"|"door"|"sprint"|"locked"|"fighting"} state
 * @property {string} stateText "FIXED" / "Door open" / "Sprint 7 / 10" / "Locked" / "Fighting"
 * @property {null|{text:string, color:string}} estimate   "Favored 1.34×"
 * @property {Array<{key:string, text:string, color:string, tooltip:string}>} chips   Wounds, Lessons, cooldown, Keepsake
 * @property {string|null} firstClear   "First fixed Nov 2"
 * @property {string} flavor
 * @property {ActionVM|null} challenge  cmd "challenge" {kind:"boss", idx}
 *
 * @typedef {Object} BossesVM
 * @property {null|{key:string, name:string, text:string, frac:number, retreat:ActionVM}} fight
 *            the fight in progress: text "Phase 2 · 41% HP · 64 ticks left · 3 heroes"; frac = boss HP
 * @property {BossRowVM[]} bosses   9
 * @property {null|{key:string, title:string, text:string, progress:{frac:number, text:string},
 *            locked:boolean}} backlog   "The Backlog", "Floor 12 · deepest 14", "31 / 50 kills"
 * @property {string|null} trophies   "Trophies: +3% damage and max HP"
 *
 * @typedef {Object} RosterRowVM
 * @property {string} key       "r:1"
 * @property {number} heroId
 * @property {string} name      @property {string} level   "Lv 34"
 * @property {string} title     "Senior Refactorer"
 * @property {"working"|"blocked"|"done"|"idle"|"off"} status
 * @property {string} stripe    status colour (hex)
 * @property {string} where     "4-1 Fast-Forward Ford" / "off duty"
 * @property {string} seen      "working 12m" / "seen 3d ago"
 * @property {{colors:object, face:string, programIcon:object|null}} portrait   party.js portrait input
 * @property {ActionVM|null} retire   Lv 30+ only (others null)
 *
 * @typedef {Object} RosterVM
 * @property {string} count     "12 / 30 heroes · 2 hired today (6 a day)"
 * @property {Array<{key:string, name:string, rows:RosterRowVM[]}>} groups   live guilds, then "Off duty"
 * @property {{title:string, bonus:string, rows:Array<{key:string, name:string, cls:string,
 *            level:string, date:string}>, emptyText:string}} fame
 *
 * @typedef {Object} DigestVM
 * @property {string} since     "Since you last looked · 2h 14m ago"
 * @property {Array<{key:string, title:string, icon:string, lines:Array<{key:string, text:string,
 *            sub:string|null, color:string, tint:boolean, action:ActionVM|null}>}>} sections
 *            Levels, Drops (Release+), Bosses, Chests waiting (action: claimChest {heroId});
 *            color: the line's dot; tint: the text in that colour too (item names in rarity colour)
 * @property {string} emptyText "Nothing new since you last looked."
 * @property {ActionVM|null} ack   "Mark as read" (clears the sidebar dot). §3.5 has no digest
 *                              command yet: the samples use cmd "digestSeen" {} (herd.digestAt = now)
 *
 * @typedef {Object} SettingRowVM
 * @property {string} key
 * @property {string} label     "Calm mode"
 * @property {string|null} hint "No damage numbers, banners or blinking; the stage dims"
 * @property {"toggle"|"choice"} kind
 * @property {boolean|string|number|null} value   null for the HUD row (the layout knows)
 * @property {Array<{id:string|number, label:string}>|null} options   choice rows
 * @property {string|null} setting   herd.cfg key for act("setting", {key, value}) ("calm",
 *                              "nums", "stageH", "auto.equip", "notify.boss", ...); null: chrome only
 * @property {null|{toggle:string}|{resize:string}} chrome   {toggle:"hud"} → run("layout.toggle",
 *                              {id}); {resize:"stage"} → also run("layout.resize", {id, px})
 *
 * @typedef {Object} SettingsVM
 * @property {Array<{key:string, title:string, hint:string|null, rows:SettingRowVM[]}>} groups
 *            display, notify (left column), autopilot (right column)
 * @property {{name:string, hint:string}} herd   rename: act("rename", {herd:true, name: typed})
 */
// env (renderHerd): as renderSheet's, plus chrome: { hud: boolean|null } (is the layout's "hud"
// block shown; null when the layout has none) and inputs: { herdName: InputState }.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, ScrollHandle } from "gpui-base";
import { run, closeOverlay, layout } from "herdr";
import { C, MONO, art, zoom, alpha, kids } from "./kit.js";
import { ink, tone, portrait, openSheet, chromeCommand } from "./party.js";
import {
  dialogTheme, dialogTokens, newUi, filterArgs, flash, actionButton, plainButton, iconButton, switchEl, tag,
  sectionTitle, fluidBar, tabBar, footerBar, itemCard, emptyCard, stashColumn,
} from "./sheet.js";

export const HERD_TABS = ["upgrades", "stash", "tracker", "bosses", "roster", "digest", "settings"];
const TAB_ICONS = {
  upgrades: "ui/star.svg", stash: "ui/chest.svg", tracker: "ui/sheet.svg", bosses: "ui/boss.svg",
  roster: "ui/herd.svg", digest: "ui/journal.svg", settings: "ui/gear.svg",
};
const STAGE_PX = { min: 64, max: 420 };
const STATE_COLOR = { fixed: C.working, door: C.hp, sprint: C.blocked, fighting: C.hp, locked: C.idle };

/**
 * Build the Herd panel from a HerdVM (or null while loading).
 * @param {object|null} vm HerdVM (see the typedefs above)
 * @param {object} env { width, height, zoom, theme, host, act, ui, overlay, inputs, chrome }
 */
export function renderHerd(vm, env) {
  const t = dialogTheme(env.theme);
  const ui = env.ui ?? newUi("upgrades");
  const root = v_flex().id("herd").size_full().min_h(0).bg(t.popover).text_size(12.5).text_color(t.fg)
    .when(Boolean(env.focus), (e) => e.track_focus(env.focus))
    .on_key_down((e, cx) => keyDown(e, cx, vm, ui))
    .on_size_change((s, cx) => {
      const z = env.zoom || 1;
      const w = Math.round(s.width / z), h = Math.round(s.height / z);
      if (!ui.size || ui.size.w !== w || ui.size.h !== h) { ui.size = { w, h }; cx.notify(); }
    });
  const close = iconButton("hd-close", "ui/close.svg", t, "Close (Esc)", () => { if (env.overlay) closeOverlay(env.overlay); });
  if (!vm) {
    return root
      .child(h_flex().flex_none().px(16).pt(14).pb(10).gap(8).items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Localhost"))
        .child(close))
      .child(v_flex().flex_1().items_center().justify_center().gap(8)
        .child(svg(art("ui/herd.svg")).w(28).h(28).text_color(t.dim))
        .child(div().text_size(12.5).text_color(t.dim).child("Loading the herd…")));
  }
  const width = ui.size?.w ?? env.width ?? 760;
  let content;
  if (vm.tab === "upgrades" && vm.upgrades) content = upgradesTab(vm.upgrades, env, ui, t, width);
  else if (vm.tab === "stash" && vm.stash) content = stashTab(vm.stash, env, ui, t, width);
  else if (vm.tab === "tracker" && vm.tracker) content = trackerTab(vm.tracker, ui, t);
  else if (vm.tab === "bosses" && vm.bosses) content = bossesTab(vm.bosses, env, ui, t);
  else if (vm.tab === "roster" && vm.roster) content = rosterTab(vm.roster, env, ui, t, vm.calm);
  else if (vm.tab === "digest" && vm.digest) content = digestTab(vm.digest, env, ui, t);
  else if (vm.tab === "settings" && vm.settings) content = settingsTab(vm.settings, env, ui, t);
  else content = [div().text_color(t.dim).child("Nothing to show here yet.")];
  return root
    .child(header(vm, t, close))
    .child(tabBar("hd", vm.tabs ?? [], vm.tab, t, TAB_ICONS, (id, cx) => pickTab(ui, id, cx)))
    .child(h_flex().id(`hd-body-${vm.tab}`).flex_1().min_h(0).px(16).pt(10).pb(10).gap(14).items_start().children(content))
    .child(footerBar("hd", ui, t, `1–${(vm.tabs ?? []).length || 7} tabs · Esc closes`));
}

function pickTab(ui, id, cx) {
  if (ui.tab === id) return;
  ui.tab = id;
  ui.hover = null;
  ui.armed = null;
  LAST.herd = id;
  cx.notify();
}

function keyDown(e, cx, vm, ui) {
  if (ui.typing || !vm) return;
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

function money(icon, color, value, t, tip) {
  return h_flex().flex_none().h(24).px(8).gap(5).items_center().rounded(6).bg(t.card).border(1).border_color(t.border).tooltip(tip)
    .child(svg(art(icon)).w(12).h(12).flex_none().text_color(color))
    .child(div().font_family(MONO).text_size(11.5).font_semibold().text_color(t.fg).child(String(value)));
}

function header(vm, t, close) {
  const h = vm.header;
  const sp = h.sprint;
  return h_flex().flex_none().px(16).pt(12).pb(10).gap(12).items_center()
    .child(div().size(40).flex_none().rounded(10).bg(alpha(t.accent, t.light ? 0.14 : 0.18)).flex().items_center().justify_center()
      .child(svg(art("ui/herd.svg")).w(22).h(22).text_color(ink(t.accent, t))))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(h_flex().h(22).gap(8).items_center()
        .child(div().min_w(0).truncate().text_size(15).font_semibold().child(h.name))
        .child(div().flex_none().h(18).px(6).rounded(5).bg(t.btn).font_family(MONO).text_size(11).font_semibold()
          .flex().items_center().tooltip(h.releaseTip).child(h.release))
        .child(div().flex_none().text_size(12).text_color(t.dim).child("Localhost")))
      .child(h_flex().h(16).gap(10).items_center()
        .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(h.sub))
        .when(Boolean(sp), (e) => e.child(h_flex().flex_none().gap(6).items_center().tooltip(`Sprint meter: ${sp.label} ${sp.have}/${sp.need}`)
          .child(div().w(56).child(fluidBar(sp.need > 0 ? sp.have / sp.need : 0, 4, t.accent, alpha(t.fg.slice(0, 7), 0.12))))
          .child(div().font_family(MONO).text_size(10.5).text_color(t.muted).whitespace_nowrap().child(sp.text))))))
    .child(money("ui/gold.svg", tone(C.coin, t), h.gold, t, "Gold (shared by the herd)"))
    .child(money("ui/snippet.svg", t.muted, h.snippets, t, "Snippets (from deprecated gear)"))
    .child(close);
}

// ── Upgrades ─────────────────────────────────────────────────────────────────────────────────

function upgradesTab(u, env, ui, t, width) {
  const colW = Math.floor((Math.max(560, width) - 32 - 12) / 2);
  return [v_flex().w_full().h_full().gap(10)
    .child(h_flex().flex_wrap().gap(12).children((u.buildings ?? []).map((b) => buildingCard(b, env, ui, t, colW))))
    .child(div().flex_1())
    .child(h_flex().gap(10).items_center()
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child(u.note ?? ""))
      .when(Boolean(u.trophies), (e) => e.child(div().flex_none().text_size(11).text_color(t.muted).child(u.trophies))))];
}

function buildingCard(b, env, ui, t, w) {
  const icon = b.icon?.mask
    ? svg(art(b.icon.path)).w(24).h(24).flex_none().text_color(ink(t.accent, t))
    : image(art(b.icon?.path ?? "fx/campfire.svg")).w(26).h(26).flex_none();
  return h_flex().id(`hd-${b.key}`).w(w).h(96).flex_none().px(12).gap(12).items_center().rounded(10).bg(t.card).border(1).border_color(t.border)
    .tooltip(b.tooltip)
    .child(div().size(44).flex_none().rounded(10).bg(t.well).flex().items_center().justify_center().child(icon))
    .child(v_flex().flex_1().min_w(0).gap(3)
      .child(h_flex().gap(8).items_center()
        .child(div().min_w(0).truncate().text_size(13).font_semibold().child(b.name))
        .child(div().flex_none().font_family(MONO).text_size(11).text_color(b.maxed ? t.good : t.muted).child(b.levelText)))
      .child(pips(b.level, b.max, t))
      .child(div().min_w(0).truncate().text_size(11.5).text_color(t.fg).child(b.effect))
      .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(b.next ?? "Maxed out")))
    .child(b.buy
      ? actionButton(`hd-buy-${b.key}`, b.buy, env, ui, t, { h: 38, px: 8, size: 12, w: 92, stack: true })
      : div().w(92).flex_none().text_center().text_size(11).font_semibold().text_color(t.good).child("MAX"));
}

function pips(level, max, t) {
  const n = Math.max(1, max | 0);
  const w = n > 5 ? 9 : 18;
  const out = [];
  for (let i = 0; i < n; i++) out.push(div().w(w).h(4).flex_none().rounded(1).bg(i < level ? tone(t.accent, t) : alpha(t.fg.slice(0, 7), t.light ? 0.12 : 0.14)));
  return h_flex().gap(2).items_center().children(out);
}

// ── Stash ────────────────────────────────────────────────────────────────────────────────────

function stashTab(s, env, ui, t, width) {
  const cardW = width >= 720 ? 256 : 220;
  const card = s.card ? itemCard("hd", s.card, env, ui, t, { w: cardW }) : emptyCard("hd", s.hint ?? "", t, cardW);
  return [stashColumn("hd", s, s.squash, env, ui, t, true), card];
}

// ── Tracker ──────────────────────────────────────────────────────────────────────────────────

function trackerTab(tr, ui, t) {
  const zones = tr.zones ?? [];
  const sel = zones.find((z) => z.key === ui.zone) ?? zones.find((z) => z.key === tr.selected) ?? zones[0];
  const list = div().relative().w(238).flex_none().h_full()
    .child(v_flex().id("hd-zones").absolute().left(0).top(0).size_full().overflow_y_scroll()
      .child(v_flex().gap(4).pr(4).children(zones.map((z) => zoneRow(z, z === sel, ui, t)))));
  return [list, sel ? zoneDetail(sel, tr, t) : div()];
}

// Tier colours stay off the rarity palette (rarity colours mean loot, D§11.1): the theme accent
// while a zone climbs, green once it is Fixed.
const tierColor = (i, t) => (i >= 3 ? C.working : i <= 0 ? C.idle : t.accent);

function zoneRow(z, on, ui, t) {
  return v_flex().id(`hd-z-${z.key}`).flex_none().px(10).py(7).gap(4).rounded(8)
    .bg(on ? t.selected : t.card).border(1).border_color(on ? alpha(t.accent, 0.5) : t.border)
    .when(z.locked, (e) => e.opacity(0.5))
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => { cx.stop_propagation(); ui.zone = z.key; cx.notify(); })
    .child(h_flex().gap(7).items_center()
      .child(div().size(16).flex_none().rounded(4).bg(z.locked ? t.well : alpha(z.accent, 0.85)).flex().items_center().justify_center()
        .font_family(MONO).text_size(9.5).font_bold().text_color("#16141F").child(z.num))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().child(z.name))
      .when(Boolean(z.tierName), (e) => e.child(tag(z.tierName, tierColor(z.tier, t), t, { h: 15, size: 9.5 }))))
    .child(fluidBar(z.progress.frac, 3, tone(tierColor(z.tier + 1, t), t), alpha(t.fg.slice(0, 7), t.light ? 0.1 : 0.12)))
    .child(h_flex().gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(10.5).text_color(t.dim).child(z.progress.text))
      .child(div().flex_none().text_size(10.5).text_color(t.muted).child(z.perk)));
}

function zoneDetail(z, tr, t) {
  return div().relative().flex_1().min_w(0).h_full()
    .child(v_flex().id(`hd-zd-${z.key}`).absolute().left(0).top(0).size_full().overflow_y_scroll()
      .child(v_flex().gap(10).pr(4)
        .child(h_flex().gap(10).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(z.name))
          .child(div().flex_none().font_family(MONO).text_size(11).text_color(t.muted).child(`${z.kills} filed`)))
        .child(h_flex().gap(6).items_center().children((z.tiers ?? []).map((x, i) => h_flex().id(`hd-t-${z.key}-${x.key}`).flex_1().h(34).px(9).gap(6).items_center()
          .rounded(8).bg(x.reached ? alpha(tierColor(i + 1, t).slice(0, 7), t.light ? 0.12 : 0.14) : t.well)
          .border(1).border_color(x.reached ? alpha(tierColor(i + 1, t).slice(0, 7), 0.55) : t.border)
          .child(div().flex_none().text_size(12).text_color(x.reached ? t.good : t.dim).child(x.reached ? "✓" : "○"))
          .child(v_flex().min_w(0)
            .child(div().text_size(11.5).font_semibold().text_color(x.reached ? ink(tierColor(i + 1, t), t) : t.muted).child(x.name))
            .child(div().font_family(MONO).text_size(10).text_color(t.dim).child(x.need))))))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().child(fluidBar(z.progress.frac, 5, tone(tierColor(z.tier + 1, t), t), alpha(t.fg.slice(0, 7), t.light ? 0.1 : 0.12))))
          .child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.dim).child(z.progress.text)))
        .child(div().text_size(11.5).text_color(t.muted).child(z.locked ? "Beat the previous zone's boss to open this frame of the Stack." : `Perk: ${z.perk}`))
        .child(sectionTitle("Bug reports", t))
        .child(h_flex().gap(8).items_start().children((z.mobs ?? []).map((m) => mobReport(m, t))))
        .children(kids([bossReport(z.boss, t)]))
        .child(div().text_size(10.5).text_color(t.dim).child(tr.totals ?? ""))));
}

function mobReport(m, t) {
  return v_flex().id(`hd-m-${m.key}`).flex_1().min_w(0).p(9).gap(4).rounded(9).bg(t.card).border(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().size(40).flex_none().rounded(8).bg(t.well).flex().items_center().justify_center()
        .child(image(art(m.sprite)).w(34).h(34).opacity(m.known ? 1 : 0.15)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(m.ticket))
        .child(div().font_family(MONO).text_size(10.5).text_color(t.muted).child(m.known ? `${m.kills} closed` : "not seen yet"))))
    .child(div().text_size(12).font_semibold().line_height(1.25).child(m.known ? m.name : "???"))
    .child(div().text_size(11).italic().text_color(t.dim).child(m.known ? m.flavor : "No reports yet."));
}

function bossReport(b, t) {
  if (!b) return null;
  return h_flex().id(`hd-br-${b.key}`).px(10).py(8).gap(12).items_center().rounded(9).bg(t.card).border(1).border_color(b.cleared ? alpha(C.working, 0.45) : t.border)
    .child(div().w(70).h(60).flex_none().rounded(8).bg(t.well).flex().items_center().justify_center()
      .child(image(art(b.sprite)).w(62).h(53).opacity(b.known ? 1 : 0.15)))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().text_size(10.5).text_color(t.dim).child("Zone boss"))
      .child(div().min_w(0).truncate().text_size(13).font_semibold().child(b.known ? b.name : "???"))
      .child(div().text_size(11).text_color(b.cleared ? t.good : t.dim).child(b.cleared ?? "Not fixed yet")))
    .child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.muted).child(b.kills));
}

// ── Bosses ───────────────────────────────────────────────────────────────────────────────────

function bossesTab(bv, env, ui, t) {
  const f = bv.fight;
  const rows = (bv.bosses ?? []).map((b) => bossRow(b, env, ui, t));
  const bl = bv.backlog;
  return [v_flex().w_full().h_full().gap(8)
    .when(Boolean(f), (e) => e.child(h_flex().id(`hd-fight-${f.key}`).flex_none().px(12).py(8).gap(12).items_center().rounded(9)
      .bg(alpha(C.hp, t.light ? 0.08 : 0.12)).border(1).border_color(alpha(C.hp, 0.45))
      .child(svg(art("ui/boss.svg")).w(16).h(16).flex_none().text_color(ink(C.hp, t)))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().text_size(12.5).font_semibold().child(f.name))
          .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(f.text)))
        .child(fluidBar(f.frac, 5, tone(C.hp, t), alpha(t.fg.slice(0, 7), 0.12))))
      .child(actionButton("hd-retreat", f.retreat, env, ui, t, { h: 26, px: 10, size: 12, cost: false }))))
    .child(div().relative().flex_1().min_h(0)
      .child(v_flex().id("hd-bosses").absolute().left(0).top(0).size_full().overflow_y_scroll()
        .child(v_flex().gap(5).pr(4).children(rows)
          .when(Boolean(bl), (e) => e.child(h_flex().id(`hd-${bl.key}`).flex_none().h(52).px(12).gap(12).items_center().rounded(9)
            .bg(t.card).border(1).border_color(t.border).when(bl.locked, (x) => x.opacity(0.55))
            .child(div().w(64).flex_none().text_center().font_family(MONO).text_size(18).font_bold().text_color(ink(C.fresh, t)).child("∞"))
            .child(v_flex().flex_1().min_w(0)
              .child(div().text_size(12.5).font_semibold().child(bl.title))
              .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(bl.text)))
            .child(div().w(120).flex_none().child(fluidBar(bl.progress.frac, 4, tone(C.fresh, t), alpha(t.fg.slice(0, 7), 0.12))))
            .child(div().w(70).flex_none().text_right().font_family(MONO).text_size(10.5).text_color(t.muted).child(bl.progress.text)))))))
    .when(Boolean(bv.trophies), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(bv.trophies)))];
}

function bossRow(b, env, ui, t) {
  const col = STATE_COLOR[b.state] ?? C.idle;
  const locked = b.state === "locked";
  return h_flex().id(`hd-b-${b.key}`).flex_none().h(64).pl(6).pr(12).gap(10).items_center().rounded(9).bg(t.card)
    .border(1).border_color(b.state === "door" || b.state === "fighting" ? alpha(C.hp, 0.5) : t.border)
    .tooltip(b.flavor)
    .child(div().w(64).h(55).flex_none().flex().items_center().justify_center()
      .child(image(art(b.sprite)).w(64).h(55).opacity(locked ? 0.2 : 1)))
    .child(v_flex().flex_1().min_w(0).gap(3)
      .child(h_flex().gap(8).items_center()
        .child(div().min_w(0).truncate().text_size(12.5).font_semibold().text_color(locked ? t.muted : t.fg).child(b.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(b.where)))
      .child(h_flex().gap(5).items_center().overflow_hidden()
        .child(tag(b.stateText, col, t, { h: 16, size: 10 }))
        .children((b.chips ?? []).map((c) => div().id(`hd-bc-${b.key}-${c.key}`).flex_none().h(16).px(5).rounded(4).flex().items_center()
          .bg(t.well).text_size(10).text_color(ink(c.color, t)).whitespace_nowrap().tooltip(c.tooltip).child(c.text)))
        .when(Boolean(b.firstClear), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).whitespace_nowrap().child(b.firstClear)))))
    .when(Boolean(b.estimate), (e) => e.child(div().flex_none().font_family(MONO).text_size(11).font_semibold().text_color(ink(b.estimate.color, t)).child(b.estimate.text)))
    .when(Boolean(b.challenge), (e) => e.child(actionButton(`hd-ch-${b.key}`, b.challenge, env, ui, t, { h: 26, px: 10, size: 12, cost: false })));
}

// ── Roster ───────────────────────────────────────────────────────────────────────────────────

function rosterTab(r, env, ui, t, calm) {
  const fame = r.fame;
  const body = v_flex().gap(4).pr(4);
  for (const g of r.groups ?? []) {
    body.child(sectionTitle(`${g.name} · ${g.rows.length}`, t));
    body.children(g.rows.map((row) => rosterRow(row, env, ui, t, calm)));
  }
  body.child(div().h(6))
    .child(sectionTitle(fame.title, t, div().text_size(10.5).text_color(t.muted).child(fame.bonus)))
    .children((fame.rows ?? []).map((f) => h_flex().id(`hd-f-${f.key}`).h(26).px(10).gap(10).items_center().rounded(6)
      .child(svg(art("ui/star.svg")).w(11).h(11).flex_none().text_color(tone(C.coin, t)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().child(f.name))
      .child(div().flex_none().text_size(11).text_color(t.muted).child(f.cls))
      .child(div().w(52).flex_none().font_family(MONO).text_size(11).text_color(t.fg).text_right().child(f.level))
      .child(div().w(84).flex_none().text_size(11).text_color(t.dim).text_right().child(f.date))))
    .when((fame.rows ?? []).length === 0, (e) => e.child(div().px(10).py(6).text_size(11.5).text_color(t.dim).child(fame.emptyText)));
  return [v_flex().w_full().h_full().gap(8)
    .child(div().flex_none().text_size(11.5).text_color(t.muted).child(r.count))
    .child(div().relative().flex_1().min_h(0)
      .child(v_flex().id("hd-roster").absolute().left(0).top(0).size_full().overflow_y_scroll().child(body)))];
}

function rosterRow(row, env, ui, t, calm) {
  const off = row.status === "off";
  return h_flex().id(`hd-${row.key}`).flex_none().h(42).pl(4).pr(8).gap(9).items_center().rounded(8)
    .hover((s) => s.bg(t.hover))
    .child(div().w(3).h(28).flex_none().rounded(2).bg(tone(row.stripe, t)))
    .child(div().when(off, (e) => e.opacity(0.65))
      .child(portrait(`hd-p-${row.key}`, { ...row.portrait, status: off ? "idle" : row.status, focused: false }, 28, t, { calm })))
    .child(v_flex().flex_1().min_w(0)
      .child(h_flex().gap(8).items_center()
        .child(div().min_w(0).truncate().text_size(12.5).font_medium().text_color(off ? t.muted : t.fg).child(row.name))
        .child(div().flex_none().font_family(MONO).text_size(10.5).text_color(t.muted).child(row.level)))
      .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${row.title} · ${row.where}`)))
    .child(div().w(110).flex_none().text_right().text_size(11).text_color(t.dim).child(row.seen))
    // Retire sits in a fixed-width cell so every row's Sheet button lines up.
    .child(h_flex().w(64).flex_none().justify_end()
      .when(Boolean(row.retire), (e) => e.child(actionButton(`hd-ret-${row.key}`, row.retire, env, ui, t, { h: 24, px: 8, size: 11, cost: false }))))
    .child(plainButton(`hd-sheet-${row.key}`, "Sheet", t, () => openSheet(row.heroId), { h: 24, px: 8, size: 11, icon: "ui/sheet.svg", tooltip: `Open ${row.name}'s character sheet` }));
}

// ── Digest ───────────────────────────────────────────────────────────────────────────────────

function digestTab(d, env, ui, t) {
  const sections = d.sections ?? [];
  const empty = sections.every((s) => (s.lines ?? []).length === 0);
  const head = h_flex().flex_none().gap(10).items_center()
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(d.since))
    .when(Boolean(d.ack), (e) => e.child(actionButton("hd-ack", d.ack, env, ui, t, { h: 24, px: 9, size: 11.5, cost: false })));
  if (empty) {
    return [v_flex().w_full().h_full().gap(8).child(head)
      .child(v_flex().flex_1().items_center().justify_center().gap(8)
        .child(svg(art("ui/calm.svg")).w(26).h(26).text_color(t.dim))
        .child(div().text_size(12.5).text_color(t.dim).child(d.emptyText)))];
  }
  const body = v_flex().gap(10).pr(4);
  for (const s of sections) {
    if (!(s.lines ?? []).length) continue;
    body.child(v_flex().id(`hd-ds-${s.key}`).gap(2).px(12).py(9).rounded(10).bg(t.card).border(1).border_color(t.border)
      .child(h_flex().h(20).gap(7).items_center()
        .child(svg(art(s.icon)).w(13).h(13).flex_none().text_color(t.muted))
        .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(s.title))
        .child(div().font_family(MONO).text_size(10.5).text_color(t.dim).child(String(s.lines.length))))
      .children(s.lines.map((l) => h_flex().id(`hd-dl-${l.key}`).min_h(24).gap(8).items_center()
        .child(div().size(6).flex_none().rounded_full().bg(tone(l.color, t)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(l.tint ? ink(l.color, t) : t.fg).child(l.text))
        .when(Boolean(l.sub), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(l.sub)))
        .when(Boolean(l.action), (e) => e.child(actionButton(`hd-da-${l.key}`, l.action, env, ui, t, { h: 22, px: 8, size: 11, cost: false }))))));
  }
  return [v_flex().w_full().h_full().gap(8).child(head)
    .child(div().relative().flex_1().min_h(0)
      .child(v_flex().id("hd-digest").absolute().left(0).top(0).size_full().overflow_y_scroll().child(body)))];
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────

function settingsTab(st, env, ui, t) {
  const groups = st.groups ?? [];
  const auto = groups.filter((g) => g.key === "autopilot");
  const rest = groups.filter((g) => g.key !== "autopilot");
  const col = (id, list, extra) => div().relative().flex_1().min_w(0).h_full()
    .child(v_flex().id(id).absolute().left(0).top(0).size_full().overflow_y_scroll()
      .child(v_flex().gap(4).pr(4)
        .children(list.flatMap((g) => kids([sectionTitle(g.title, t),
          g.hint ? div().px(4).text_size(10.5).text_color(t.dim).child(g.hint) : null,
          ...g.rows.map((r) => settingRow(r, env, ui, t))])))
        .children(extra ? [extra] : [])));
  return [col("hd-set-l", rest, herdName(st.herd, env, ui, t)), col("hd-set-r", auto, null)];
}

function setValue(row, value, env, ui, cx) {
  let r = null;
  if (row.setting) r = env.act ? env.act("setting", { key: row.setting, value }) : null;
  if (row.chrome?.resize && (!r || r.ok !== false)) {
    const px = Math.max(STAGE_PX.min, Math.min(STAGE_PX.max, Number(value) || STAGE_PX.min));
    run("layout.resize", { id: row.chrome.resize, px });
  }
  flash(ui, r ?? { ok: true, msg: `${row.label}: ${value === true ? "on" : value === false ? "off" : String(value)}.` }, row.label, cx);
  ui.armed = null;
  cx.notify();
}

function settingRow(row, env, ui, t) {
  let control;
  if (row.kind === "choice") {
    control = h_flex().flex_none().h(24).p(2).gap(2).items_center().rounded(7).bg(t.well).border(1).border_color(t.border)
      .children((row.options ?? []).map((o) => {
        const on = o.id === row.value;
        return div().id(`hd-opt-${row.key}-${o.id}`).h(18).px(8).rounded(5).flex().items_center()
          .text_size(11).font_medium().text_color(on ? t.fg : t.dim).when(on, (e) => e.bg(t.btn))
          .cursor_pointer().hover((s) => s.text_color(t.fg))
          .on_click((_e, cx) => { cx.stop_propagation(); if (!on) setValue(row, o.id, env, ui, cx); })
          .child(o.label);
      }));
  } else if (row.chrome?.toggle) {
    const shown = env.chrome?.hud ?? null;
    control = switchEl(`hd-sw-${row.key}`, shown === true, t, shown == null ? "This layout has no HUD strip" : shown ? "Hide the HUD strip" : "Show the HUD strip", (cx) => {
      run("layout.toggle", { id: row.chrome.toggle });
      if (env.chrome) env.chrome.hud = !shown;
      flash(ui, { ok: true, msg: shown ? "HUD strip hidden." : "HUD strip shown." }, row.label, cx);
      cx.notify();
    }, shown == null);
  } else {
    const on = row.value === true;
    control = switchEl(`hd-sw-${row.key}`, on, t, row.hint ?? row.label, (cx) => setValue(row, !on, env, ui, cx));
  }
  return h_flex().id(`hd-set-${row.key}`).flex_none().min_h(36).px(4).gap(10).items_center()
    .child(v_flex().flex_1().min_w(0)
      .child(div().text_size(12.5).text_color(t.fg).child(row.label))
      .when(Boolean(row.hint), (e) => e.child(div().text_size(10.5).text_color(t.dim).child(row.hint))))
    .child(control);
}

function herdName(h, env, ui, t) {
  if (!h) return null;
  const input = env.inputs?.herdName ?? null;
  const save = (cx) => {
    const name = String(input?.value?.() ?? "").trim();
    if (!name || name === h.name) { flash(ui, { ok: false, msg: "Type a new name first." }, "Rename", cx); cx.notify(); return; }
    const r = env.act ? env.act("rename", { herd: true, name }) : null;
    flash(ui, r, "Rename", cx);
    if (!r || r.ok !== false) { ui.renaming = false; ui.typing = false; env.focus?.focus?.(); }
    cx.notify();
  };
  return v_flex().id("hd-herdname").gap(6).mt(6)
    .child(sectionTitle("Herd", t))
    .child(ui.renaming && input
      ? h_flex().gap(6).items_center()
        .child(Input.new(input).flex_1().min_w(0).h(26).px(8).rounded(6).border(1).border_color(t.accent).bg(t.bg).text_size(12).text_color(t.fg))
        .child(plainButton("hd-rename-save", "Save", t, save, { h: 26, px: 9, size: 11.5, on: true }))
        .child(plainButton("hd-rename-cancel", "Cancel", t, (cx) => { ui.renaming = false; ui.typing = false; env.focus?.focus?.(); cx.notify(); }, { h: 26, px: 9, size: 11.5 }))
      : h_flex().gap(8).items_center().px(4)
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().child(h.name))
        .child(plainButton("hd-rename", "Rename", t, (cx) => {
          if (!input) return;
          input.set_value?.(h.name);
          input.set_selected_range?.({ start: 0, end: h.name.length });
          input.focus?.();
          // The Input mounts on the next frame: focus it again then (shipped worktree/prompt mods).
          cx.timer?.after?.(100, () => input.focus?.());
          ui.renaming = true;
          cx.notify();
        }, { h: 24, px: 8, size: 11, disabled: !input })))
    .child(div().px(4).text_size(10.5).text_color(t.dim).child(h.hint));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Role

const LAST = { herd: "upgrades" };

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

/** Is the layout's "hud" block shown? null when the layout has none. */
export function hudShown() {
  const n = findNode(layout(), "hud");
  return n ? !n.hidden : null;
}

export default class HerdPanel {
  init(props, cx, host) {
    this.props = props ?? {};
    this.host = host ?? null;
    this.ui = newUi(HERD_TABS.includes(this.props.tab) ? this.props.tab : LAST.herd);
    this.ui.after = (a, r) => {
      if (r && r.ok === false) return;
      if (a.cmd === "squash") { this.ui.squashMode = false; this.ui.filter.squash = []; }
      if (a.cmd === "deprecate" || a.cmd === "squash" || a.cmd === "equip") { this.ui.selected = null; this.ui.hover = null; }
    };
    this.scroll = ScrollHandle.new();
    this.inputs = { herdName: InputState.new({ placeholder: "The herd's name" }) };
    this.inputs.herdName.on("focus", (_e, cx) => { this.ui.typing = true; cx.notify(); });
    this.inputs.herdName.on("blur", (_e, cx) => { this.ui.typing = false; cx.notify(); });
    this.inputs.herdName.on("submit", (_e, cx) => {
      const name = String(this.inputs.herdName.value() ?? "").trim();
      if (!name) return;
      const r = this.host?.command?.("rename", { herd: true, name });
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
    const vm = host?.view?.("herd", { tab: this.ui.tab, filter: filterArgs(this.ui) }) ?? null;
    if (vm && vm.tab && HERD_TABS.includes(vm.tab)) this.ui.tab = vm.tab;
    return renderHerd(vm, {
      width: this.ui.size?.w ?? 760, height: this.ui.size?.h ?? 520, zoom: zoom(), theme: dialogTokens(), host,
      act: (name, args) => host?.command?.(name, args), ui: this.ui, overlay: this.props.overlay ?? null,
      inputs: this.inputs, focus: this.focus ?? null, scroll: this.scroll,
      chrome: { hud: vm && vm.tab === "settings" ? hudShown() : null },
    });
  }

  /** Key commands that reached this copy: the herd hotkey closes the panel; the others as usual. */
  command(name) {
    if (name === "herd") { if (this.props.overlay) closeOverlay(this.props.overlay); return true; }
    return chromeCommand(name, this.host);
  }

  close() {
    this.inputs?.herdName?.release?.();
  }
}

