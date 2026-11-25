// Role "stage": the dungeon strip under the terminals (DESIGN §11.1–11.10, §11.16; ARCHITECTURE §6).
//
// `renderStage(vm, env)` is a pure layout of a StageVM (game/view.js): every position, colour,
// string and state comes from the VM; this file only places elements, picks motion recipes and
// wires clicks. The default-export class is the role object main.js drives.
//
// ---------------------------------------------------------------------------------------------
// Coordinate conventions (what view.js must supply)
//   - Logical px at zoom 1, relative to the stage root. The vertical layout is the 200 px
//     reference composition of D§11.2: header band 0–18, play space 18–160, ground line y = 160,
//     nameplates at y 164, status tags at y 182. The renderer bottom-anchors it to the real block
//     height: drawn y = y + (height − 200); room headers, the herd banner and header notes stay
//     pinned to the top. Below 100 px tall the stage is "compact" (D§11.15 "at 64 only
//     nameplates, chests, bubbles and HP lines").
//   - Boxes (rooms, overflow chip, arena, HeroVM.slot) give the LEFT edge x and width w.
//   - Sprites (heroes, forklings, mobs, chests, campfires, props, boss, boss parts) give x = the
//     horizontal CENTRE and y = the FEET (bottom edge): top = y − height.
//   - Nameplates: x = centre, y = top of the pill. Fx: x = centre, y = vertical centre.
//   - Every `sprite` is a path relative to mods/down-the-stack/art/ (e.g. "mob/typo_sprout.svg").
//     programIcon.path is herdr's app-home-relative icon path (e.g. "icons/claude.svg").
//   - The boss arena is an ordinary rooms[] entry (its zone's background and header); BossVM.arena
//     only tells the renderer where to dim, and where the HUD and banners go.
//   - Colours are final hex: e.g. HeroVM.colors.titleBar must contrast with the program icon drawn
//     on it (Claude's icon is full-colour orange); faceInk carries the status colour.
//   - The renderer never derives strings: titles, stats, tags, plates, tooltips and fx text are
//     shown as given (it only formats counts: "×n" on chests, "+n" for forklings and the camp).
//
// VM additions (fields this renderer reads beyond ARCHITECTURE §5; view.js supplies them):
/**
 * @typedef {object} StageVMAdditions
 * @property {Array<{key:string, x:number, text:string}>} [signs]  Boss-fight signs left in the
 *           participants' home slots ("→ The Pyramid of Doom 41%"), x = centre (D§11.3.5).
 *
 * @typedef {object} RoomVMAdditions
 * @property {string} [tooltip]  Room header hover: zone, map, quota, Sprint meter (D§11.16).
 * @property {{heroIds:number[], mapId:string|null, pinned?:boolean}|null} [pin]  Header click
 *           (D§11.16): pinMap {heroId, mapId} for each hero (mapId null unpins); null: the header
 *           is not clickable. pinned: every hero here is pinned to this map (the header draws a
 *           pin before the title, 2 elements, but not on bare rooms; the tooltip says a click unpins).
 * @property {{kind:string, idx:number, tooltip?:string}|null} [challenge]  Boss-door click
 *           (D§11.16): the `challenge` command {kind, idx}; null: the door is only a sign (also
 *           while the engine would refuse the challenge: a boss fight on, a retry wait, nobody
 *           working in the zone; the room tooltip says why).
 * @property {string} [stats]    Header numbers after the quota bar, e.g. "31/40 · Sprint 4/6";
 *           shown as given (the part after " · " is dropped when the header cannot fit it; the
 *           title falls back to `shortTitle` first).
 *           When absent the renderer shows quota "have/need" only.
 *
 * @typedef {object} HeroVMAdditions
 * @property {{x:number, w:number}} [slot]  The hero's slot box; a waiting hero's slot gets the
 *           #00000033 overlay (ARCHITECTURE §9.3).
 * @property {{clsId:string, color:string, edge?:boolean}} weapon  edge: tier-5 cyan rim mask.
 * @property {number|null} [rebootFrac]  0..1 progress of the "Rebooting…" bar while crashed.
 * @property {{key, kind:"promoted"|"postmortem", text, sub, age}|null} [reviewEnd]  A review that
 *           just ended, in the hero's slot (D§11.8): the Promotion banner (confetti) or the
 *           Postmortem card. age 0 = about to show, 1–2 shown, ≥ 3 going. Calm keeps only the card.
 * @property {Array<{key, address, x, y, face, status, bubble, tooltip?:string}>} forklings
 *           tooltip: the sub-agent's title (hover, D§11.16).
 *   Faces/colours are final: the renderer shows `face` as given (">_" blinks while questing).
 *   When `crate` is true the renderer draws the crate at (x, y) and lifts the Termling 12 px.
 *
 * @typedef {object} MobVMAdditions
 * @property {number} px       Base sprite size (28/40/56); drawn size = px × (elite ? 1.25 : 1) × growScale.
 * @property {number} [lane]   0 = the front of its lane (or a boss's first add); a crowded stage
 *           draws only the front mobs, then none (detail(), D§11.9.7).
 * @property {boolean} [hit]   Took damage this tick: opacity dips to 0.55 (ARCHITECTURE §9.2).
 * @property {boolean} [waiting]  Queued behind a blocked hero: shows a "…" bubble (D§11.10).
 *   phaser → opacity flicker loop 1 → 0.6 (1.2 s); pending → "…" ring; dying → fades out.
 *
 * @typedef {object} ChestVMAdditions
 * @property {string|null} address  Terminal to show after claiming (D§11.16).
 *   tier: "wooden"|"iron"|"silver"|"gold" (a Commit Chest) | "duck" (a Holo Rubber Duck's Duck
 *   Chest, D§9.7: a picture of the kill, its item already given); count > 1 shows "×n"; unopened
 *   chests sparkle, unopened Commit Chests carry the SHIPPED ribbon and claim on click.
 *
 * @typedef {object} BossVMAdditions
 * @property {number} age      Ticks since the fight started (entrance: 0 dim + hidden, 1 rise,
 *           2 HP bar fills).
 * @property {string} [tooltip]  Mechanics summary and win estimate (hover).
 * @property {string|null} [partSprite]  Part art (e.g. "boss/octopus_merge-part.svg"); null draws
 *           parts as small labelled bars (e.g. the Pyramid's layers).
 * @property {{confirm:string, args?:object}|null} [retreat]  D§11.16 Retreat on the boss: the first
 *           click arms (shows `confirm` over the boss), a second one within 4 ticks runs `retreat`.
 * @property {{key, text, sub, age, kind?:"entrance"|"postmortem"}|null} banner
 *           age 0 = about to slide in, 1–2 shown, ≥ 3 sliding out (view.js drops it after 3).
 * @property {{key, text, age, sprite?:string|null}|null} stamp  age 0 = about to slam, ≥ 1 down.
 *           sprite defaults to "fx/stamp-fixed.svg"; null draws `text` as a red text stamp.
 *
 * @typedef {object} OverflowVMAdditions
 * @property {string} [label]  Chip label (default "+count").
 *
 * FxVM: x/y = centre at age 0; age 1 is drawn at (x + dx, y + dy) fading out (two-tick
 * pattern). levelup/pillar/stamp are multi-tick: shown statically while the VM keeps them.
 * A pillar's optional `sheet: {heroId, itemUid}` makes it a click target (D§11.16): the sheet
 * opens on that item's compare card. The target is a transparent box painted under everything
 * that takes clicks (`pillarHit`), so a hero, chest or bubble in the light keeps its own click.
 *
 * Clicks that show a terminal (hero, "!" bubble, chest, Forkling) use party.js showTerminal, as
 * herdr's agents list does: pane.focus when the terminal has a pane, else terminal.peek
 * (agent.focus shows nothing without a pane here: the layout has no agent block).
 */
// ---------------------------------------------------------------------------------------------

import { div, svg, image } from "gpui-kit";
import { openOverlay, focused, theme as herdrTheme } from "herdr";
import { art, C, MONO, T, zoom, alpha, jitter, kids, clamp01, hex } from "./kit.js";
import { renderTermling, renderForkling, programIcon, termlingCost, forklingCost } from "./termling.js";
import { openSheet, showTerminal } from "./party.js";

const REF_H = 200;           // the reference composition height (D§11.2)
const GROUND = 160;          // ground line in the reference composition
const COMPACT_H = 100;       // below this the stage shows only plates, chests, bubbles, HP lines
const NIGHT = { sky: "#151126", horizon: "#2E2545", ground: "#100D1C", line: "#3B2F5C" };
const INK = "#0B0A12";       // pill / plate backgrounds
const CREAM = C.cream;
const WOOD = { board: "#7A5232", edge: "#3E2716", post: "#5A3A22" };
const CHEST_H = { duck: 28 };
const DUSK = "#1A123047";     // the idle rooms' dusk tint (D§11.10)
const NUMBERS = new Set(["num", "crit", "heal", "miss", "inv", "abs", "incoming"]);
const TWO_TICK = new Set(["num", "crit", "heal", "miss", "inv", "abs", "incoming", "poof", "coin", "loot", "skill", "coffee", "unblocked", "ship"]);
const BOBBING = new Set(["questing", "supervising", "shipped"]);

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const r2 = (n) => Math.round(n * 100) / 100;
/** `top` (#rrggbbaa) composited over `base` (#rrggbb): an opaque #rrggbb. Other inputs: base. */
function over(base, top) {
  if (!/^#[0-9a-fA-F]{6}$/.test(String(base)) || !/^#[0-9a-fA-F]{8}$/.test(String(top))) return base;
  const ch = (c, i) => parseInt(c.slice(i, i + 2), 16);
  const a = ch(top, 7) / 255;
  return "#" + [1, 3, 5].map((i) => Math.round(ch(base, i) * (1 - a) + ch(top, i) * a).toString(16).padStart(2, "0")).join("");
}
/** Width of a monospace label (JetBrains Mono advances ≈ 0.6 em). */
const monoW = (text, size) => Math.ceil(String(text).length * size * 0.6);
/** List items whose x (and `also`) are finite numbers. */
const placed = (list, also) => (Array.isArray(list) ? list.filter((e) => e && Number.isFinite(e.x) && (!also || Number.isFinite(e[also]))) : []);
/** Keep a box of width w inside the stage horizontally. */
const clampX = (left, w, ctx) => Math.max(1, Math.min(ctx.W - w - 1, left));

const SHEET = (heroId) => ({ mod: "down-the-stack", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId } });

/** The sheet on one item's compare card (props.focus): through the host's one-sheet registry. */
function openSheetOn(heroId, itemUid, ctx) {
  const host = ctx.env?.host;
  const opts = Number.isFinite(itemUid) ? { focus: itemUid } : {};
  if (host && typeof host.openSheet === "function") return host.openSheet(heroId, opts);
  const spec = SHEET(heroId);
  return openOverlay({ ...spec, props: { ...spec.props, ...opts } });
}
const HERD = () => ({ mod: "down-the-stack", kind: "dialog", width: 760, height: 520, props: { role: "herd" } });

// ---------------------------------------------------------------------------------------------
// The role object

export default class Stage {
  init(props, _cx, host) {
    this.props = props ?? {};
    this.host = host ?? null;
    this.size = null; // logical {width, height}, from on_size_change
    // armed: a boss Retreat armed by a first click {key, tick}; detail: the detail level held for
    // a stage size {W, H, level} (detail(): hysteresis)
    this.ui = { armed: null, detail: null };
  }

  /** env for renderStage; theme = T() plus the layout's mdr_* tokens (herdr merges them into theme()). */
  env(width, height) {
    const host = this.host;
    const th = T();
    const raw = herdrTheme() ?? {};
    // kit.hex: a hand-edited "151126" (herdr accepts it) would make .bg() throw; unusable → the built-in colour
    for (const k of Object.keys(raw)) if (k.startsWith("mdr_")) { const v = hex(raw[k]); if (v) th[k] = v; }
    return { width, height, zoom: zoom(), theme: th, host, ui: this.ui, act: (name, args) => host?.command?.(name, args) };
  }

  viewModel(width, height) {
    return this.host?.view ? this.host.view("stage", { width, height, nowMs: Date.now() }) : null;
  }

  render(_cx) {
    const width = this.size?.width ?? 960;
    const height = this.size?.height ?? REF_H;
    const vm = this.viewModel(width, height);
    return renderStage(vm, this.env(width, height)).on_size_change((s, cx) => {
      const z = zoom();
      const w = num(s?.width, 0) / z;
      const h = num(s?.height, 0) / z;
      if (w <= 0 || h <= 0) return;
      if (this.size && Math.abs(this.size.width - w) < 0.5 && Math.abs(this.size.height - h) < 0.5) return;
      this.size = { width: w, height: h };
      cx.notify();
    });
  }

  /** UI commands that reached this copy (main.js claims them first). */
  command(name, _cx) {
    const width = this.size?.width ?? 960;
    const height = this.size?.height ?? REF_H;
    if (name === "herd") { openOverlay(HERD()); return true; }
    const vm = this.viewModel(width, height);
    if (name === "sheet") {
      // the focused agent's hero only: with no focused hero the key does nothing (no guessing)
      const term = focused()?.terminal ?? null;
      const heroes = vm?.heroes ?? [];
      const hero = heroes.find((h) => term && h.address === term) ?? heroes.find((h) => h.focused) ?? null;
      if (hero) openOverlay(SHEET(hero.heroId));
      return Boolean(hero);
    }
    if (name === "calm") {
      this.host?.command?.("setting", { key: "calm", value: !vm?.calm });
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Pure renderer

/**
 * Build the stage tree from a StageVM (or null while the world loads).
 * env = { width, height, zoom, theme: T() (+ mdr_* tokens), host, act(name, args), ui? } where ui
 * is the role's mutable UI state ({armed}: a boss Retreat armed by a first click; {detail}: the
 * detail level held for this size, which detail() writes back); optional (without it every render
 * picks its level afresh).
 */
export function renderStage(model, env = {}) {
  const th = env.theme ?? {};
  const night = {
    sky: th.mdr_night_sky ?? NIGHT.sky,
    horizon: th.mdr_night_horizon ?? NIGHT.horizon,
    ground: NIGHT.ground,
    line: NIGHT.line,
  };
  const W = num(env.width, num(model?.width, 960));
  const H = num(env.height, num(model?.height, REF_H));
  const z = num(env.zoom, 1);
  const calm = Boolean(model?.calm);
  const ctx = {
    vm: model, env, W, H, z, calm, night,
    oy: H - REF_H,
    compact: H < COMPACT_H,
    motion: !calm && !model?.stillness,  // loops allowed at all (stillness keeps only fires + bubbles)
    act: (name, args) => env.act?.(name, args),
    ui: env.ui ?? { armed: null },
    // calm dims the scene to 60 %, but "bubbles and chests stay" (D§11.15): they go on top of it
    keep: calm ? [] : null,
  };
  const root = div().id("stage").relative().size_full().overflow_hidden().bg(night.sky);
  if (!model) return root.child(localhost(null, ctx));
  if (model.empty) return root.child(localhost(model.empty, ctx));

  const scene = div().id("stage-scene").absolute().left(0).top(0).w(W).h(H).opacity(calm ? 0.6 : 1);
  // Entities that cannot be placed (non-finite x/y) are skipped rather than drawn at NaN.
  const rooms = placed(model.rooms, "w");
  const heroes = placed(model.heroes, "y");
  const vm = { ...model, chests: placed(model.chests, "y"), mobs: placed(model.mobs, "y"), fx: placed(model.fx, "y"), signs: placed(model.signs) };
  ctx.vm = vm;
  Object.assign(ctx, detail(vm, rooms, heroes, ctx));
  ctx.dimmed = ctx.dimInRoom ? dimmedRooms(rooms, heroes) : null;
  scene.children(kids([
    backdrop(rooms, ctx),
    ...rooms.map((r) => room(r, ctx)),
    vm.boss ? arenaDim(vm.boss, ctx) : null,
  ]));
  // A loot pillar's click target lies under everything that takes clicks (its light column is
  // painted over the scene later, with no handler): a click on the finder, a chest or a bubble
  // standing in the column reaches them, the rest of the column opens the sheet.
  for (const f of ctx.fxKept) if (f.kind === "pillar" && pillarSheet(f)) scene.child(pillarHit(f, ctx));
  if (!ctx.compact) {
    for (const s of vm.signs ?? []) scene.children(sign(s, ctx));
  }
  for (const c of vm.chests ?? []) put(scene, chest(c, ctx), ctx);
  if (!ctx.compact) {
    for (const h of heroes) if (h.campfire) scene.children(campfire(h.key, h.campfire, ctx));
    for (const h of heroes) if (crated(h, ctx)) scene.child(image(art("fx/crate.svg")).absolute().left(r2(h.x - 12)).top(r2(ctx.oy + h.y - 16)).w(24).h(16));
    for (const m of vm.mobs ?? []) if (mobShown(m, ctx)) scene.children(mob(m, ctx));
  }
  // Blocked: a translucent overlay over the slot (ARCHITECTURE §9.3), under the hero and bubble.
  // It starts below the header band so a room header is never half-dimmed.
  const slotTop = ctx.compact ? 0 : 18;
  for (const h of heroes) {
    if (h.state === "waiting" && h.slot && !ctx.dimmed?.heroes.has(h.key)) scene.child(div().absolute().left(h.slot.x).top(slotTop).w(h.slot.w).h(H - slotTop).bg(C.overlay));
  }
  if (!ctx.compact) {
    if (vm.boss) scene.children(boss(vm.boss, ctx));
    for (const h of heroes) {
      if (h.focused) scene.child(div().absolute().left(r2(h.x - 17)).top(r2(ctx.oy + h.y - 2)).w(34).h(4).rounded(2).bg(alpha(CREAM, 0.45)));
      scene.children(hero(h, ctx));
    }
  }
  for (const c of vm.chests ?? []) for (const el of chestMarks(c, ctx)) put(scene, el, ctx);
  if (!ctx.compact) {
    for (const h of heroes) {
      if (h.bubble) put(scene, bubble(h, ctx), ctx);
      if (h.zzz) scene.child(zzz(h, ctx));
    }
  } else {
    for (const h of heroes) if (h.bubble) put(scene, bubble(h, ctx), ctx);
  }
  for (const h of heroes) scene.children(plate(h, ctx));
  if (!ctx.compact) {
    for (const h of heroes) if (h.reviewEnd) scene.children(reviewEnd(h, ctx));
    for (const f of paintOrder(ctx.fxKept)) scene.children(fx(f, ctx));
    for (const f of ctx.fxKept) if (f.kind === "pillar") scene.children(pillarLabel(f, ctx));
    if (vm.boss) scene.children(bossOverlays(vm.boss, ctx));
  }
  const note = vm.headerNote && !ctx.compact ? headerNote(vm.headerNote, ctx, rooms) : null;
  if (note) scene.child(note);
  if (vm.herdBanner && !calm && !ctx.compact) scene.children(herdBanner(vm.herdBanner, ctx));
  if (vm.overflow) scene.child(overflowChip(vm.overflow, ctx));
  root.child(scene);
  if (ctx.keep) root.children(ctx.keep);
  return root;
}

/** A blocked hero sits on its crate (not at the bare level: it stands, its bubble and tag stay). */
const crated = (h, ctx) => Boolean(h.crate) && !ctx.bare;

/** Into the scene, or (calm) onto the full-opacity layer over it (D§11.15 bubbles and chests). */
function put(scene, el, ctx) {
  if (ctx.keep) ctx.keep.push(el);
  else scene.child(el);
}

// ---------------------------------------------------------------------------------------------
// Element budget (D§11.9.7: about 400 stage elements and 150 animated ones per render)

const BUDGET = 392;      //  elements (the mock warns above 400, ARCHITECTURE §7.4)
const ANIM_BUDGET = 146; // nodes with a loop, transition or frames
// Kept free for this tick's effects whatever the scene costs, so the scene's detail does not
// swing with the number of damage numbers: about one tick's worth (D§11.7 allows 12 per stage).
const FX_RESERVE = { el: 24, an: 24 };
// A coarser level held from an earlier render steps back only when the finer one fits with this
// much to spare: a mob dying or arriving never flips the heroes between rigs every second.
const MARGIN = { el: 12, an: 6 };

/**
 * The detail ladder, coarsest last. Level k applies the first k rungs. Every rung keeps status:
 * heroes (their face, status ink and opacity), nameplates with their HP lines, status tags, the
 * "!" bubbles, slot overlays, chests and the camp chip always render.
 *   1-3  scenery: ground tiles (the band keeps its colour and accent line), extra props (one per
 *        room), far silhouettes;
 *   4-5  the lean rig (no title-bar dots or pin banner) and one-element mob HP bars;
 *   6    still: reflow tweens (rooms, plates, HP lines, chests, reboot bars), the cursor blink,
 *        chest sparkles and the zzz cycle stop (movement and bobbing stay);
 *   7    one Forkling per hero (the rest join its "+n"; a blocked one is kept);
 *   8    plain rooms: one sky colour, no props;
 *   9    one mob per lane (the front one);
 *   10   bare rooms: the ground band is the room's bottom border, the dusk tint mixed into its
 *        colours, no zone divider; headers show only the title (quota and Sprint stay in the
 *        header's tooltip);
 *   11   the small rig: body, title bar, screen and weapon (no limbs, icon, accessory or hat);
 *   12   the tiny rig: each Termling (and Forkling) is one element, a little terminal window in
 *        its hoodie colour with the face;
 *   13   no lane mobs (nor a boss's adds);
 *   14   bare marks: no crates (a blocked hero stands, its bubble and tag stay), chest sparkles or
 *        campfire glow;
 *   15   lean marks (merged, nothing hidden): the "!" bubble is one drawn element, the reboot bar
 *        one element, and a chest's SHIPPED ribbon and "×n" one drawn label (it still reads over
 *        a hero standing in front of the chest);
 *   16   a blocked slot that is a room of its own has its dim mixed into the room's colours (no
 *        overlay element);
 *   17   Forklings fold into one counter per hero ("+n", amber with "!" while one is blocked; a
 *        click shows that sub-agent's terminal, else the first one's).
 * Levels 15-17 matter only when every slot holds status at once (a long day's herd: most heroes
 * blocked or crashed with chests waiting, sub-agents, a boss fight).
 * Effects then get what the budget has left (at least FX_RESERVE until the last rung): status
 * floats ("Unblocked", "+Ship XP") first, then pillars and level-ups, then the newest numbers.
 */
const RUNGS = [
  (d) => { d.groundTiles = false; },
  (d) => { d.maxProps = 1; },
  (d) => { d.farTiles = false; },
  (d) => { d.leanRig = true; },
  (d) => { d.leanBars = true; },
  (d) => { d.still = true; },
  (d) => { d.maxForks = 1; },
  (d) => { d.plainRooms = true; },
  (d) => { d.mobLanes = 1; },
  (d) => { d.bareRooms = true; },
  (d) => { d.smallRig = true; },
  (d) => { d.tinyRig = true; },
  (d) => { d.mobLanes = 0; },
  (d) => { d.bare = true; },
  (d) => { d.leanMarks = true; },
  (d) => { d.dimInRoom = true; },
  (d) => { d.forkCounter = true; },
];

const fullDetail = () => ({
  level: 0, groundTiles: true, maxProps: 3, farTiles: true, leanRig: false, leanBars: false, still: false,
  maxForks: Infinity, plainRooms: false, mobLanes: Infinity, bareRooms: false, smallRig: false, tinyRig: false, bare: false,
  leanMarks: false, dimInRoom: false, forkCounter: false,
});

function atLevel(k) {
  const d = fullDetail();
  for (let i = 0; i < k && i < RUNGS.length; i++) RUNGS[i](d);
  d.level = Math.min(k, RUNGS.length);
  return d;
}

/**
 * Pick this render's detail: the finest level whose scene (everything but effects) leaves
 * FX_RESERVE free, then as many effects as the rest holds. The estimate counts elements and
 * animated nodes exactly as the builders below make them (test: "the estimate ... tracks").
 * ctx.ui.detail remembers the level per stage size (hysteresis, MARGIN); without a ui object
 * (previews, tests) every render decides afresh.
 */
function detail(vm, rooms, heroes, ctx) {
  const fits = (c, m) => c.el + FX_RESERVE.el + m.el <= BUDGET && c.an + FX_RESERVE.an + m.an <= ANIM_BUDGET;
  const none = { el: 0, an: 0 };
  const memo = [];
  const cost = (k) => memo[k] || (memo[k] = sceneCost(vm, rooms, heroes, ctx, atLevel(k)));
  // every rung only removes, so the cost falls with the level: the first level that fits is found
  // by bisection (a few passes over the entities, not one per rung)
  let need = 0;
  if (!fits(cost(0), none)) {
    let lo = 0, hi = RUNGS.length;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(cost(mid), none)) hi = mid; else lo = mid; }
    need = hi;
  }
  let level = need;
  const ui = ctx.ui;
  const prev = ui && ui.detail && ui.detail.W === ctx.W && ui.detail.H === ctx.H ? ui.detail.level : 0;
  if (prev > need) {
    level = prev;
    for (let k = need; k < prev; k++) if (fits(cost(k), MARGIN)) { level = k; break; }
  }
  const c = cost(level);
  if (ui && typeof ui === "object") ui.detail = { W: ctx.W, H: ctx.H, level };
  const d = atLevel(level);
  // effects: the longest prefix of the ranked list that the rest of the budget holds
  const ranked = rankedFx(vm.fx, ctx, vm);
  const motion = ctx.motion ?? (!(ctx.calm ?? vm.calm) && !vm.stillness);
  let el = c.el, an = c.an, n = 0;
  for (const f of ranked) {
    if (n >= FX_CAP) break;
    const fc = fxCost(f, motion);
    if (el + fc.el > BUDGET || an + fc.an > ANIM_BUDGET) break;
    el += fc.el; an += fc.an; n++;
  }
  d.fxKept = ranked.slice(0, n);
  d.estimate = el;
  d.animated = an;
  return d;
}

/** Elements and animated nodes of everything but the effects at detail d. */
function sceneCost(vm, rooms, heroes, ctx, d) {
  const compact = Boolean(ctx.compact);
  const W = num(ctx.W, 960);
  const H = num(ctx.H, REF_H);
  const calm = Boolean(ctx.calm ?? vm.calm);
  const motion = ctx.motion ?? (!calm && !vm.stillness);
  let el = 2, an = 0; // the root and the scene
  // Localhost scenery at the spare ends
  const covered = rooms.reduce((a, r) => a + num(r.w, 0), 0) + num(vm.overflow?.w, 0);
  if (covered < W - 1) {
    el += 2 + (compact ? 0 : 1);
    if (!compact && rooms.length) {
      const lo = Math.min(...rooms.map((r) => num(r.x, 0)));
      const hi = Math.max(...rooms.map((r) => num(r.x, 0) + num(r.w, 0)));
      for (const span of [lo, (vm.overflow ? num(vm.overflow.x, W) : W) - hi]) {
        if (span < 40) continue;
        el += Math.min(6, Math.floor(span / 60)) + (span >= 60 ? 1 : 0);
      }
    }
  }
  for (const r of rooms) {
    const w = num(r.w, 0);
    el += 1 + (d.bareRooms ? 0 : (r.dusk ? 1 : 0) + (r.dividerLeft ? 1 : 0));
    if (!d.still) an++;
    if (!d.bareRooms) el += 1 + (d.groundTiles ? Math.ceil(w / 32) : 0);
    if (compact) continue;
    if (!d.plainRooms) el += 2 + Math.min(d.maxProps, (r.props ?? []).length);
    if (d.farTiles) { el += 1 + Math.ceil((w + 48) / 160); if (r.working && motion) an++; }
    const hf = headerFit(r, w, d.bareRooms);
    el += 1 + (hf.hasQuota ? 2 : 0) + (hf.stats ? 1 : 0) + (hf.pin ? 2 : 0);
    if (r.door) el += 1 + (r.challenge ? 2 : 1);
  }
  const b = vm.boss;
  if (b && b.arena) { el++; an++; }
  const dimmed = d.dimInRoom ? dimmedRooms(rooms, heroes) : null;
  for (const h of heroes) {
    if (h.state === "waiting" && h.slot && !(dimmed && dimmed.heroes.has(h.key))) el++;
    if (h.bubble) { el += d.leanMarks ? 1 : 2; if (!calm) an++; }
    if (h.nameplate) { el += 2; if (!d.still) an += 2; }
    if (h.tag?.text) el++;
    if (compact) continue;
    if (h.campfire) { el += d.bare ? 1 : 2; if (!d.bare && !calm) an++; }
    if (h.crate && !d.bare) el++;
    if (h.focused) el++;
    const rig = termlingCost(h, { lean: d.leanRig, small: d.smallRig, tiny: d.tinyRig, blink: !calm && !d.still && h.state === "questing" });
    el += rig.el; an += rig.an;
    if (h.state === "crashed" && Number.isFinite(h.rebootFrac)) { el += d.leanMarks ? 1 : 2; if (!d.still && !d.leanMarks) an++; }
    const all = h.forklings ?? [];
    if (d.forkCounter) {
      if (all.length) el++;
    } else {
      const fks = keptForklings(all, d.maxForks);
      for (const f of fks) { const fc = forklingCost({ tiny: d.tinyRig }); el += fc.el + (f?.bubble ? 1 : 0); an += fc.an; }
      if (fks.length && Math.max(0, num(h.forklingExtra, 0)) + (all.length - fks.length) > 0) el++;
    }
    if (h.zzz) { el++; if (motion && !d.still) an++; }
    if (reviewEndShown(h, { compact, calm })) {
      const e = h.reviewEnd;
      const confetti = e.kind === "promoted" ? CONFETTI_N : 0; // each falls with its own tween
      el += 1 + (e.text ? 1 : 0) + (e.sub ? 1 : 0) + confetti;
      an += 1 + confetti;
    }
  }
  if (!compact) {
    for (const m of vm.mobs ?? []) {
      if (!mobShown(m, d)) continue;
      el++; an++;
      if (m.dying) continue;
      if (m.showHp) { el += d.leanBars ? 1 : 2; if (!d.leanBars) an++; }
      el += (m.elite ? 1 : 0) + (m.holo ? 1 : 0) + (m.glyph ? 1 : 0) + (m.pending || m.waiting ? 1 : 0);
    }
  }
  for (const ch of vm.chests ?? []) {
    el += 2;
    if (!d.still) an++;
    if (!ch.open && !compact) {
      if ((ch.tier ?? "wooden") !== "duck") el++;
      if (!d.bare) { el++; if (motion && !d.still) an++; }
    }
    if (num(ch.count, 1) > 1 && !shippedLabel(ch, { leanMarks: d.leanMarks, compact })) el++;
  }
  if (!compact) {
    el += (vm.signs ?? []).length * 2 + (vm.headerNote ? 1 : 0) + (vm.herdBanner && !calm ? 4 : 0);
    if (b) {
      el += 2; an++;
      for (const p of b.parts ?? []) { el += 3 + (b.partSprite !== null || p.label ? 1 : 0); an += 2; }
      if (!b.stamp && b.arena) {
        const segs = Math.max(1, Math.min(12, Math.round(num(b.segments, 1)))) - 1;
        if (H < SLIM_HUD_H) el += 4 + segs + (b.mechText ?? b.phaseLabel ? 1 : 0);
        else {
          el += 5 + segs + (b.phaseLabel || b.invuln ? 1 + (b.invuln ? 1 : 0) : 0) + (Number.isFinite(b.timerFrac) ? 2 : 0) + (b.mechText ? 1 : 0);
          if (Number.isFinite(b.timerFrac)) an++;
        }
        an++;
      }
      const bn = b.banner;
      if (bn && (!calm || bn.kind === "postmortem")) { el += 2 + (bn.sub ? 1 : 0) + (bn.kind === "postmortem" ? 0 : 2); an++; }
      if (b.stamp) { el++; an++; }
      if (b.retreat && armed(b, ctx)) el++;
    }
  }
  const o = vm.overflow;
  if (o) {
    const n = Math.max(0, Math.round(num(o.count, 0)));
    const w = num(o.w, 150);
    el += 4 + (compact ? 0 : 1 + Math.min(3, Math.max(1, n)));
    el += Math.min((o.dots ?? []).length, Math.max(1, Math.min(10, Math.floor((w - 12) / 9))));
  }
  return { el, an };
}

/** A room's own sky and ground colours (before any tint). */
function roomBase(r) {
  const pal = r.palette ?? {};
  const bands = Array.isArray(r.skyBands) && r.skyBands.length >= 4 ? r.skyBands : [pal.sky, pal.sky, pal.sky, pal.sky];
  return { bands, sky: bands[0] ?? NIGHT.sky, ground: pal.ground ?? NIGHT.ground };
}
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * Detail "dim in the room": the blocked heroes whose slot is a room of its own (same box), and
 * those rooms, whose colours can take the slot's dim (opaque #rrggbb: over() mixes them).
 */
function dimmedRooms(rooms, heroes) {
  const out = { rooms: new Set(), heroes: new Set() };
  for (const h of heroes) {
    if (h.state !== "waiting" || !h.slot) continue;
    const r = rooms.find((x) => Math.abs(num(x.x, 0) - num(h.slot.x, NaN)) < 0.6 && Math.abs(num(x.w, 0) - num(h.slot.w, NaN)) < 0.6);
    if (!r) continue;
    const base = roomBase(r);
    if (!HEX6.test(String(base.sky)) || !HEX6.test(String(base.ground))) continue;
    out.rooms.add(r.key);
    out.heroes.add(h.key);
  }
  return out;
}

/** A mob drawn at detail d: lane mobs from the front, as many lanes deep as the level allows. */
const mobShown = (m, d) => num(m.lane, 0) < num(d.mobLanes, Infinity);

/** Elements and animated nodes one effect costs as fx() draws it (a pillar adds its hit target). */
function fxCost(f, motion) {
  const k = f.kind;
  if (k === "crit") return { el: 2, an: 2 };
  if (k === "levelup") return { el: 2, an: motion ? 2 : 1 };
  if (k === "pillar") return { el: 2 + (pillarSheet(f) ? 1 : 0), an: 2 };
  if (k === "stamp") return { el: 1, an: 0 };
  return { el: 1, an: 1 };
}

/** The Forklings drawn when at most `max` fit: blocked ones (with a bubble) first, order kept. */
function keptForklings(all, max) {
  if (all.length <= max) return all;
  return [...all.filter((f) => f?.bubble), ...all.filter((f) => !f?.bubble)].slice(0, max);
}

/** Drawn at all (fx() returns nothing for these): two-tick kinds past age 1, numbers the settings hide, calm. */
function fxShown(f, calm, nums) {
  const k = f.kind;
  if (TWO_TICK.has(k) && num(f.age, 0) >= 2) return false;
  if (NUMBERS.has(k) && (calm || nums === "off" || (nums === "crits" && k !== "crit"))) return false;
  return !(calm && (k === "pillar" || k === "levelup" || k === "skill"));
}

/** Effects in the order they keep their place when the budget is short (none on a compact stage). */
const FX_KEEP = { unblocked: 0, ship: 0, pillar: 1, levelup: 1, stamp: 1 };
function rankedFx(list, ctx, vm) {
  if (ctx.compact || !Array.isArray(list)) return [];
  const calm = Boolean(ctx.calm ?? vm.calm);
  return list.filter((f) => f && fxShown(f, calm, vm.nums ?? "all"))
    .sort((a, b) => num(FX_KEEP[a.kind], 2) - num(FX_KEEP[b.kind], 2) || num(a.age, 0) - num(b.age, 0));
}

/** A loot pillar's sheet target (D§11.16), or null. */
const pillarSheet = (f) => (f.sheet && f.sheet.heroId != null ? f.sheet : null);

// ---------------------------------------------------------------------------------------------
// Backgrounds

/** Localhost scenery at the spare ends (night horizon + ground), only when rooms leave a gap. */
function backdrop(rooms, ctx) {
  const covered = rooms.reduce((a, r) => a + num(r.w, 0), 0) + num(ctx.vm.overflow?.w, 0);
  if (covered >= ctx.W - 1) return null;
  const { oy, W, H, night } = ctx;
  const gy = oy + GROUND;
  const el = div().absolute().left(0).top(0).w(W).h(H);
  if (!ctx.compact) el.child(div().absolute().left(0).top(r2(oy + 104)).w(W).h(56).bg(night.horizon));
  el.child(div().absolute().left(0).top(r2(gy)).w(W).h(Math.max(40, H - gy)).bg(night.ground).border_t(2).border_color(night.line));
  if (!ctx.compact && rooms.length) {
    // A few stars and a tent in each spare end.
    const lo = Math.min(...rooms.map((r) => num(r.x, 0)));
    const hi = Math.max(...rooms.map((r) => num(r.x, 0) + num(r.w, 0)));
    const ends = [[0, lo, "l"], [hi, ctx.vm.overflow ? num(ctx.vm.overflow.x, W) : W, "r"]];
    for (const [a, b, side] of ends) {
      const span = b - a;
      if (span < 40) continue;
      const n = Math.min(6, Math.floor(span / 60));
      for (let i = 0; i < n; i++) {
        const sx = a + ((i + 0.5) * span) / n + (jitter(`${side}${i}`, 0, 1, 21) - 10);
        const sy = oy + 14 + jitter(`${side}y${i}`, 0, 1, 70);
        el.child(div().absolute().left(r2(sx)).top(r2(sy)).w(2).h(2).bg(alpha(CREAM, i % 2 ? 0.5 : 0.85)));
      }
      if (span >= 60) el.child(image(art("fx/tent.svg")).absolute().left(r2((a + b) / 2 - 8)).top(r2(gy - 14)).w(16).h(14));
    }
  }
  return el;
}

/** One room: sky bands → far tiles → props → ground → accent line → dusk → divider → header. */
function room(r, ctx) {
  const { oy, H, z } = ctx;
  const w = num(r.w, 0);
  const pal = r.palette ?? {};
  const { bands, sky, ground: groundCol } = roomBase(r);
  const zone = r.zone ?? "lint_meadows";
  const gy = oy + GROUND;
  // bare rooms: the ground band is the room's own bottom border (no accent line, no tiles) and
  // the dusk tint is mixed into both colours (no overlay element); so is a blocked slot's dim when
  // the room is that slot (detail "dim in the room")
  const dim = Boolean(ctx.dimmed && ctx.dimmed.rooms.has(r.key));
  const tint = (c) => {
    let out = ctx.bareRooms && r.dusk ? over(c, DUSK) : c;
    if (dim) out = over(out, C.overlay);
    return out;
  };
  const el = div().id(r.key).absolute().left(r.x).top(0).w(w).h(H).overflow_hidden().bg(tint(sky));
  if (!ctx.still) el.transition("left", { duration: 900, easing: "ease-out" }).transition("width", { duration: 900, easing: "ease-out" });
  if (ctx.bareRooms) el.border_b(r2(Math.max(1, H - gy))).border_color(tint(groundCol));
  if (!ctx.compact && !ctx.plainRooms) {
    // Bands 1 and 2 are one div: its 35 px top border is band 1, its background band 2.
    el.child(div().absolute().left(0).top(r2(oy + 53)).w(w).h(71).border_t(35).border_color(bands[1] ?? bands[0]).bg(bands[2] ?? bands[0]));
    el.child(div().absolute().left(0).top(r2(oy + 123)).w(w).h(Math.max(1, GROUND - 123)).bg(bands[3] ?? bands[0]));
  }
  if (!ctx.compact) {
    // Far silhouettes at 50 % opacity; a slow ±16 px drift while the room is working (§6.1).
    const far = div().absolute().left(-16).top(r2(oy + 40)).w(w + 48).h(100).opacity(0.5);
    if (r.working && ctx.motion) far.loop("left", { from: -32 * z, to: 0, period: jitter(r.key, 20000, 397), easing: "ease-in-out" });
    if (ctx.farTiles) {
      for (let x = 0; x < w + 48; x += 160) far.child(image(art(`bg/${zone}-far.svg`)).absolute().left(x).top(0).w(160).h(100));
      el.child(far);
    }
    for (const p of ctx.plainRooms ? [] : (r.props ?? []).slice(0, ctx.maxProps)) {
      el.child(image(art(p.sprite)).absolute().left(r2(p.x - r.x - p.w / 2)).top(r2(oy + p.y - p.h)).w(p.w).h(p.h));
    }
    if (r.door) el.child(image(art("fx/door.svg")).absolute().left(r2(w - 30)).top(r2(gy - 40)).w(24).h(40));
  }
  // Ground band: its 2 px top border is the accent line; the tiles are its children (below it).
  if (!ctx.bareRooms) {
    const ground = div().absolute().left(0).top(r2(gy)).w(w).h(Math.max(42, H - gy)).bg(pal.ground ?? NIGHT.ground)
      .border_t(2).border_color(pal.accent ?? NIGHT.line);
    if (ctx.groundTiles) for (let x = 0; x < w; x += 32) ground.child(image(art(`bg/${zone}-ground.svg`)).absolute().left(x).top(0).w(32).h(40));
    el.child(ground);
  }
  if (r.dusk && !ctx.bareRooms) el.child(div().absolute().left(0).top(0).w(w).h(H).bg(DUSK));
  // bare rooms keep no zone divider (the skies differ; the header keeps its hairline)
  if (r.dividerLeft && !ctx.bareRooms) el.child(div().absolute().left(0).top(0).w(2).h(H).bg("#0B0A12CC"));
  if (!ctx.compact) el.child(roomHeader(r, w, ctx));
  return el;
}

/**
 * What a room header shows at width w: full title, else the short one ("CC 2-2"), else the stats
 * without their Sprint part; `used` is the px the header's contents take from its left edge. A
 * bare header (detail level "bare rooms") shows the title only: quota and Sprint stay in its
 * tooltip.
 */
function headerFit(r, w, bare = false) {
  const hasQuota = !bare && Boolean(r.quota && num(r.quota.need, 0) > 0);
  let stats = bare ? "" : typeof r.stats === "string" ? r.stats : hasQuota ? `${r.quota.have}/${r.quota.need}` : "";
  const bw = w < 220 ? 24 : 36;
  const doorW = r.door ? (r.challenge ? 19 : 16) : 0;
  // the map pin goes with the stats on bare rooms: the last rungs then cost what they did before
  // pins were drawn (30 pinned rooms are 60 elements), and the header's tooltip still says so
  const pin = !bare && pinnedRoom(r);
  const pinW = pin ? PIN_W + 5 : 0;
  const space = (st) => w - 14 - (hasQuota ? bw + 5 : 0) - (st ? monoW(st, 9.5) + 5 : 0) - doorW - pinW;
  const textW = (t) => String(t ?? "").length * 10.5 * 0.56;  // the UI font averages ≈ 0.56 em
  let title = r.title ?? "";
  if (textW(title) > space(stats)) title = r.shortTitle ?? title;
  if (textW(title) > space(stats) && stats.includes(" · ")) stats = stats.slice(0, stats.indexOf(" · "));
  const used = (r.dividerLeft ? 7 : 6) + pinW + textW(title) + (hasQuota ? bw + 5 : 0) + (stats ? monoW(stats, 9.5) + 5 : 0) + doorW + 5;
  return { hasQuota, stats, bw, title, pin, used: Math.min(w, used) };
}

/** Every hero in the room is pinned to its map (RoomVM.pin.pinned: the header click unpins). */
const pinnedRoom = (r) => Boolean(r.pin && r.pin.pinned && Array.isArray(r.pin.heroIds) && r.pin.heroIds.length);
const PIN_W = 6;

/**
 * The map pin before a pinned room's title (D§11.16: the header click pins the room's heroes to
 * its map; autopilot's map choice then leaves them there): a cream head on a needle, two elements.
 */
function pinMark(r) {
  return div().id(`${r.key}/pin`).flex_none().relative().size(PIN_W).mb(4).rounded_full().bg(CREAM)
    .child(div().absolute().left(2.25).top(5).w(1.5).h(5).rounded(1).bg(CREAM));
}

/** Header band (y 0–18): map title, quota bar, stats, boss-door icon. Pinned to the top. */
function roomHeader(r, w, ctx) {
  const { hasQuota, bw, title, stats, pin: pinShown } = headerFit(r, w, ctx.bareRooms);
  const divider = r.dividerLeft && !ctx.bareRooms;
  const strip = div().id(`${r.key}/hdr`).absolute().left(0).top(0).w(w).h(18).flex().items_center().gap(5).pl(divider ? 7 : 6).pr(5)
    .overflow_hidden().whitespace_nowrap().text_size(10.5).font_weight(600).text_color(CREAM)
    .bg(r.review ? "#5A1620D9" : "#0D0B1AA6");
  // Rooms of the same zone have no divider; a hairline still separates their headers.
  if (!divider && num(r.x, 0) > 0.5) strip.border_l(1).border_color("#FFFFFF24");
  if (r.tooltip) strip.tooltip(r.tooltip);
  // D§11.16: pin (or unpin) the map for the heroes in the room
  const pin = r.pin;
  if (pin && Array.isArray(pin.heroIds) && pin.heroIds.length) {
    strip.cursor_pointer().on_click((_e, cx) => {
      cx.stop_propagation();
      for (const heroId of pin.heroIds) ctx.act("pinMap", { heroId, mapId: pin.mapId ?? null });
    });
  }
  if (pinShown) strip.child(pinMark(r));
  strip.child(String(title));
  if (hasQuota) {
    strip.child(div().flex_none().relative().w(bw).h(3).rounded(1).bg("#FFFFFF2E")
      .child(div().absolute().left(0).top(0).h(3).w(Math.round(bw * clamp01(r.quota.have / r.quota.need))).bg(C.working)));
  }
  if (stats) strip.child(div().flex_none().text_size(9.5).font_weight(400).font_family(MONO).text_color(alpha(CREAM, 0.8)).child(stats));
  if (r.door) {
    const icon = svg(art("ui/boss.svg")).w(11).h(11).text_color(C.hp);
    const ch = r.challenge;
    if (ch) {
      // the boss door challenges the zone's boss (D§11.16); its own hit box, over the header's
      const door = div().id(`${r.key}/door`).flex_none().flex().items_center().justify_center().w(14).h(16).cursor_pointer()
        .on_click((_e, cx) => { cx.stop_propagation(); ctx.act("challenge", { kind: ch.kind, idx: ch.idx }); })
        .child(icon);
      if (ch.tooltip) door.tooltip(String(ch.tooltip));
      strip.child(door);
    } else strip.child(icon.flex_none());
  }
  return strip;
}

/** The boss arena dims at the entrance and tints red when enraged (painted under the fighters). */
function arenaDim(b, ctx) {
  if (!b.arena) return null;
  const age = num(b.age, 9);
  const op = b.stamp ? 0 : age <= 1 ? 0.55 : 0.2;
  return div().id(`${b.key}/dim`).absolute().left(b.arena.x).top(0).w(b.arena.w).h(ctx.H)
    .bg(b.enraged ? "#4A0A14" : "#000000").opacity(op).transition("opacity", { duration: 700 });
}

// ---------------------------------------------------------------------------------------------
// Props of the scene

function sign(s, ctx) {
  const bw = monoW(s.text, 9) + 12;
  const gy = ctx.oy + GROUND;
  return [
    div().absolute().left(r2(s.x - 1.5)).top(r2(gy - 22)).w(3).h(22).bg(WOOD.post),
    div().id(s.key).absolute().left(r2(clampX(s.x - bw / 2, bw, ctx))).top(r2(gy - 38)).w(bw).h(15).rounded(2).bg(WOOD.board)
      .border(1).border_color(WOOD.edge).flex().items_center().justify_center()
      .text_size(9).font_family(MONO).text_color(CREAM).whitespace_nowrap().child(String(s.text)),
  ];
}

function chest(c, ctx) {
  const tier = c.tier ?? "wooden";
  const h = CHEST_H[tier] ?? 22;
  const left = r2(c.x - 14);
  const top = r2(ctx.compact ? Math.max(1, ctx.oy + c.y - h) : ctx.oy + c.y - h);
  const el = div().id(c.key).absolute().left(left).top(top).w(28).h(h);
  if (!ctx.still) el.transition("left", { duration: 900, easing: "ease-out" });
  // Only a closed Commit Chest claims: an opened one and a Duck Chest (its item is already given)
  // are pictures, and a click on them falls through to whatever stands behind.
  if (claimable(c)) {
    el.cursor_pointer().on_click((_e, cx) => {
      cx.stop_propagation();
      if (c.address) showTerminal(c.address);
      ctx.act("claimChest", { heroId: c.heroId });
    });
  }
  if (c.tooltip) el.tooltip(c.tooltip);
  el.child(image(art(`fx/chest-${tier}${c.open ? "-open" : ""}.svg`)).absolute().left(0).top(0).w(28).h(h));
  return el;
}

const claimable = (c) => !c.open && c.tier !== "duck";
/** Lean marks: a closed chest's SHIPPED ribbon and its "×n" drawn as one label (chestMarks). */
const shippedLabel = (c, d) => Boolean(d.leanMarks && !d.compact && !c.open && (c.tier ?? "wooden") !== "duck" && num(c.count, 1) > 1);

/**
 * What must read over the hero standing next to the chest: SHIPPED ribbon, sparkle, "×n". Lean
 * marks: the ribbon and the "×n" are one drawn label ("SHIPPED ×2") where the ribbon was.
 */
function chestMarks(c, ctx) {
  const tier = c.tier ?? "wooden";
  const h = CHEST_H[tier] ?? 22;
  const left = c.x - 14;
  const top = ctx.compact ? Math.max(1, ctx.oy + c.y - h) : ctx.oy + c.y - h;
  const out = [];
  const merged = shippedLabel(c, ctx);
  if (!c.open && !ctx.compact) {
    if (merged) {
      const text = `SHIPPED ×${c.count}`;
      const lw = monoW(text, 7) + 6;
      out.push(div().absolute().left(r2(clampX(left - 6, lw, ctx))).top(r2(top - 13)).w(lw).h(10).rounded(2).bg(C.done)
        .border(1).border_color("#1B1726").flex().items_center().justify_center()
        .text_size(7).line_height(1).font_family(MONO).font_weight(800).text_color("#1B1726").whitespace_nowrap().child(text));
    } else if (tier !== "duck") out.push(image(art("fx/ribbon.svg")).absolute().left(r2(left - 6)).top(r2(top - 13)).w(40).h(10));
    if (!ctx.bare) {
      const spark = svg(art("fx/starburst.svg")).absolute().left(r2(left + 23)).top(r2(top - 3)).w(9).h(9).text_color(CREAM).opacity(0.85);
      if (ctx.motion && !ctx.still) spark.loop("opacity", { from: 0.15, to: 1, period: jitter(c.key, 1800, 53), easing: "ease-in-out" });
      out.push(spark);
    }
  }
  if (num(c.count, 1) > 1 && !merged) {
    out.push(div().absolute().left(r2(left + 18)).top(r2(top + h - 9)).h(11).px(3).rounded(5).bg(INK).border(1).border_color(alpha(CREAM, 0.35))
      .flex().items_center().text_size(8).font_family(MONO).font_weight(700).text_color(CREAM).whitespace_nowrap().child(`×${c.count}`));
  }
  return out;
}

/** Campfire: a glow that flickers (allowed in stillness, not in calm) under the fire sprite. */
function campfire(key, f, ctx) {
  const fire = image(art("fx/campfire.svg")).absolute().left(r2(f.x - 12)).top(r2(ctx.oy + f.y - 24)).w(24).h(24);
  if (ctx.bare) return [fire];
  const glow = div().absolute().left(r2(f.x - 16)).top(r2(ctx.oy + f.y - 12)).w(32).h(12).rounded(6).bg("#FFB34766").opacity(0.7);
  if (!ctx.calm) glow.loop("opacity", { from: 0.35, to: 0.9, period: jitter(key, 620, 29), easing: "ease-in-out" });
  return [glow, fire];
}

function mob(m, ctx) {
  const { oy, z } = ctx;
  const size = Math.round(num(m.px, 28) * (m.elite ? 1.25 : 1) * num(m.growScale, 1));
  const left = r2(m.x - size / 2);
  const top = r2(oy + m.y - size);
  const op = m.dying ? 0 : m.hit ? 0.55 : num(m.opacity, 1);
  const el = image(art(m.sprite ?? `mob/${m.mobId}.svg`)).id(m.key).absolute().left(left).top(top).w(size).h(size)
    .opacity(op)
    .transition("left", { duration: 900, easing: "ease-out" })
    .transition("opacity", { duration: m.dying ? 450 : 250 })
    .transition("width", { duration: 600 }).transition("height", { duration: 600 }).transition("top", { duration: 600 });
  if (ctx.motion && !m.dying) {
    if (m.engaged) el.loop("left", { from: left * z, to: (left - 4) * z, period: 1000, easing: "ease-in-out" });
    else if (m.pacing) {
      const amp = num(m.paceAmp, 12);
      el.loop("left", { from: (left - amp) * z, to: (left + amp) * z, period: jitter(m.key, 3200, 37), easing: "ease-in-out" });
    }
    if (m.phaser && !m.hit) el.loop("opacity", { from: 1, to: 0.6, period: 1200, easing: "ease-in-out" });
  }
  const out = [el];
  if (m.dying) return out;
  let above = top;
  if (m.showHp) {
    const bw = Math.max(16, Math.round(size * 0.7));
    above = top - 6;
    if (ctx.leanBars) {
      // One element: the red fill is the background, the missing HP its right border (no tween).
      out.push(div().absolute().left(r2(m.x - bw / 2)).top(r2(above)).w(bw).h(3).bg(C.hp)
        .border_r(Math.round(bw * (1 - clamp01(m.hpFrac)))).border_color("#0B0A12"));
    } else {
      out.push(div().absolute().left(r2(m.x - bw / 2)).top(r2(above)).w(bw).h(3).rounded(1).bg("#0B0A12B3")
        .child(div().id(`${m.key}/hp`).absolute().left(0).top(0).h(3).w(Math.round(bw * clamp01(m.hpFrac))).bg(C.hp)
          .transition("width", { duration: 300 })));
    }
  }
  if (m.elite) {
    above -= 12;
    out.push(image(art("fx/stink.svg")).absolute().left(r2(m.x - 8)).top(r2(above)).w(16).h(12));
  }
  if (m.holo) {
    out.push(svg(art("fx/starburst.svg")).absolute().left(r2(m.x + size / 2 - 7)).top(r2(top - 3)).w(9).h(9).text_color("#FF9CC2"));
  }
  if (m.glyph) {
    out.push(div().absolute().left(r2(m.x - 30)).top(r2(top + size / 2 - 6)).w(60).h(12).flex().justify_center()
      .text_size(9).font_family(MONO).font_weight(700).text_color(m.glyphColor ?? CREAM).whitespace_nowrap().child(String(m.glyph)));
  }
  if (m.pending || m.waiting) {
    out.push(div().absolute().left(r2(m.x - 9)).top(r2(above - 12)).w(18).h(10).rounded(5).bg(alpha(CREAM, 0.9))
      .flex().items_center().justify_center().text_size(9).line_height(1).font_weight(700).text_color(INK).child("…"));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Heroes

function hero(h, ctx) {
  const lift = crated(h, ctx) ? 12 : 0;
  const feetY = ctx.oy + h.y - lift;
  const out = [];
  const body = renderTermling(h, ctx.env, {
    feetX: h.x, feetY,
    lunge: ctx.motion && h.attacking,
    bob: ctx.motion && !h.attacking && BOBBING.has(h.state),
    blink: !ctx.calm && !ctx.still && h.state === "questing",
    lean: ctx.leanRig,
    small: ctx.smallRig,
    tiny: ctx.tinyRig,
  }).cursor_pointer().on_click((e, cx) => {
    cx.stop_propagation();
    if (num(e?.click_count, 1) >= 2) { openSheet(h.heroId); return; }
    if (h.address) showTerminal(h.address);
    ctx.act("markSeen", { heroId: h.heroId });
  });
  if (h.tooltip) body.tooltip(h.tooltip);
  out.push(body);
  if (h.state === "crashed" && Number.isFinite(h.rebootFrac)) {
    const done = Math.round(28 * clamp01(h.rebootFrac));
    if (ctx.leanMarks) {
      // one element: the track, its done part a cream left border (no tween)
      out.push(div().id(`${h.key}/reboot`).absolute().left(r2(h.x - 14)).top(r2(feetY - 56)).w(28).h(3).bg("#0B0A12B3")
        .border_l(done).border_color(CREAM));
    } else {
      const fill = div().id(`${h.key}/reboot`).absolute().left(0).top(0).h(3).w(done).bg(CREAM);
      if (!ctx.still) fill.transition("width", { duration: 900, easing: "linear" });
      out.push(div().absolute().left(r2(h.x - 14)).top(r2(feetY - 56)).w(28).h(3).rounded(1).bg("#0B0A12B3").child(fill));
    }
  }
  const allForks = h.forklings ?? [];
  if (ctx.forkCounter) {
    // the Forklings fold into one counter (a blocked one keeps its "!" and its click)
    if (allForks.length) {
      const el = forkCounter(h, allForks, ctx);
      if (ctx.keep && allForks.some((f) => f?.bubble)) ctx.keep.push(el);
      else out.push(el);
    }
    return out;
  }
  const fks = keptForklings(allForks, num(ctx.maxForks, Infinity));
  const extra = Math.max(0, num(h.forklingExtra, 0)) + (allForks.length - fks.length);
  for (const fk of fks) {
    const el = renderForkling(fk, h, ctx.env, { feetY: ctx.oy + fk.y, bob: ctx.motion && fk.status === "working", tiny: ctx.tinyRig })
      .cursor_pointer()
      .on_click((_e, cx) => {
        cx.stop_propagation();
        // a sub-agent rarely has a pane: herdr's peek shows it (D§11.16, as the agents list does)
        if (fk.address) showTerminal(fk.address);
      });
    if (fk.tooltip) el.tooltip(fk.tooltip);
    out.push(el);
    if (fk.bubble) {
      const b = image(art("fx/bubble.svg")).absolute().left(r2(fk.x + 3)).top(r2(ctx.oy + fk.y - 36)).w(9).h(10);
      if (ctx.keep) ctx.keep.push(b);
      else out.push(b);
    }
  }
  if (extra > 0 && fks.length) {
    const last = fks[fks.length - 1];
    out.push(div().absolute().left(r2(last.x + 10)).top(r2(ctx.oy + last.y - 11)).w(18).h(10)
      .text_size(8).font_family(MONO).font_weight(700).text_color(alpha(CREAM, 0.85)).child(`+${extra}`));
  }
  return out;
}

/**
 * Detail level "Forklings fold into a counter": "+n" (every sub-agent) where the first Forkling
 * stands, amber with "!" while one is blocked; a click shows the blocked one's terminal (else the
 * first one's), the tooltip lists them.
 */
function forkCounter(h, all, ctx) {
  const n = all.length + Math.max(0, num(h.forklingExtra, 0));
  const blocked = all.find((f) => f?.bubble) ?? null;
  const target = blocked ?? all[0];
  const text = blocked ? `+${n} !` : `+${n}`;
  const w = monoW(text, 8) + 8;
  const tips = all.slice(0, 3).map((f) => String(f?.tooltip ?? "Sub-agent"));
  if (n > tips.length) tips.push(`…and ${n - tips.length} more`);
  // where the first Forkling stands, but clear of the hero's 40 px body (at the slot's scale)
  const left = Math.max(num(all[0]?.x, h.x + 20) - 8, h.x + 20 * num(h.scale, 1) + 1);
  return div().id(`${h.key}/forks`).absolute().left(r2(clampX(left, w, ctx))).top(r2(ctx.oy + num(all[0]?.y, h.y) - 16))
    .w(w).h(11).rounded(3).bg(alpha(INK, 0.7)).flex().items_center().justify_center()
    .text_size(8).line_height(1).font_family(MONO).font_weight(700).text_color(blocked ? C.blocked : alpha(CREAM, 0.85))
    .whitespace_nowrap().cursor_pointer()
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (target?.address) showTerminal(target.address);
    })
    .tooltip(tips.join("\n"))
    .child(text);
}

/**
 * The "!" bubble (blocked only): 18×20 art in a 32×32 hit area; bobs 3 px; click shows the
 * terminal. Lean marks: one element, the bubble drawn (white, dark outline, "!") where the art was.
 */
function bubble(h, ctx) {
  let left, top;
  if (ctx.compact) {
    const p = h.nameplate ?? { x: h.x, w: 60, y: 164 };
    left = p.x - p.w / 2 - 30;
    top = ctx.oy + p.y - 8;
  } else {
    left = h.x - 16;
    top = ctx.oy + h.y - (crated(h, ctx) ? 12 : 0) - 76;
    // short stages: no room above the head without covering the room header, so beside it
    if (top < 13) { top = 13; left = h.x + 12; }
  }
  left = r2(clampX(left, 32, ctx)); top = r2(Math.max(0, top));
  const lean = Boolean(ctx.leanMarks);
  if (lean) { left = r2(left + 6); top = r2(top + 6); }
  const el = div().id(`${h.key}/bubble`).absolute().left(left).top(top).w(lean ? 20 : 32).h(lean ? 20 : 32).cursor_pointer()
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (h.address) showTerminal(h.address);
    });
  if (lean) {
    el.rounded(5).bg(C.white).border(2).border_color("#1B1B1F").flex().items_center().justify_center()
      .text_size(13).line_height(1).font_family(MONO).font_weight(800).text_color("#1B1B1F").child("!");
  } else {
    el.child(image(art("fx/bubble.svg")).absolute().left(7).top(6).w(18).h(20));
  }
  if (h.bubble?.label) el.tooltip(String(h.bubble.label));
  if (!ctx.calm) el.loop("top", { from: top * ctx.z, to: (top - 3) * ctx.z, period: jitter(h.key, 1400, 31), easing: "ease-in-out" });
  return el;
}

function zzz(h, ctx) {
  const el = div().absolute().left(r2(h.x + 10)).top(r2(ctx.oy + h.y - 60)).w(26).h(12)
    .text_size(10).font_family(MONO).font_weight(700).text_color(alpha(CREAM, 0.85)).whitespace_nowrap();
  // Static in calm and in stillness (D§11.3.6 "All idle: … nothing else moves"), and on a still stage.
  return ctx.motion && !ctx.still ? el.frames(["z", "zz", "zzz", ""], 700) : el.child("zz");
}

/** Nameplate pill (y 164–179) with the 2 px HP line; click opens the sheet. Then the status tag. */
function plate(h, ctx) {
  const p = h.nameplate;
  const out = [];
  if (p) {
    const pw = Math.max(36, num(p.w, 60));
    const left = r2(clampX(p.x - pw / 2, pw, ctx));
    const top = r2(ctx.oy + num(p.y, 164));
    // Text sits in the top 11 px (bottom padding), the HP line under it: 2 elements per plate.
    const hp = div().id(`${h.key}/hp`).absolute().left(3).top(11).h(2).rounded(1)
      .w(Math.max(0, Math.round((pw - 8) * clamp01(p.hpFrac ?? h.hpFrac)))).bg(C.hp);
    const pill = div().id(`${h.key}/plate`).absolute().left(left).top(top).w(pw).h(16).rounded(4)
      .bg(alpha(INK, 0.82)).border(1).border_color(h.focused ? alpha(CREAM, 0.9) : "#FFFFFF24")
      .flex().items_center().justify_center().px(3).pb(3).truncate()
      .text_size(9.5).line_height(1).font_family(MONO).font_weight(h.focused ? 700 : 500).text_color(CREAM)
      .cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); openSheet(h.heroId); });
    if (!ctx.still) { pill.transition("left", { duration: 900, easing: "ease-out" }); hp.transition("width", { duration: 400 }); }
    out.push(pill.child(String(p.text ?? h.name ?? "")).child(hp));
  }
  if (h.tag?.text) {
    const tw = monoW(h.tag.text, 9) + 10;
    const top = ctx.compact ? Math.min(ctx.H - 13, ctx.oy + 182) : ctx.oy + 182;
    out.push(div().absolute().left(r2(clampX(h.x - tw / 2, tw, ctx))).top(r2(top)).w(tw).h(12).rounded(3).bg(alpha(INK, 0.7))
      .flex().items_center().justify_center().text_size(9).line_height(1).font_family(MONO).font_weight(700)
      .text_color(h.tag.color ?? CREAM).whitespace_nowrap().child(String(h.tag.text)));
  }
  return out;
}

/** A review's end in the hero's slot (D§11.8): the Promotion banner with confetti, or the card. */
// No reserved meaning colours (gold is only "done", orange only blocked): XP cyan and rarity tones.
const CONFETTI = ["#7FE9F5", "#4EA3FF", "#B36BFF", "#FF7AA8", "#FFF4D6", "#A9B8FF"];
const CONFETTI_N = 12;

function reviewEndShown(h, ctx) {
  const e = h.reviewEnd;
  return Boolean(e && h.slot && !ctx.compact && (!ctx.calm || e.kind === "postmortem"));
}

function reviewEnd(h, ctx) {
  if (!reviewEndShown(h, ctx)) return [];
  const e = h.reviewEnd;
  const pm = e.kind === "postmortem";
  const sw = num(h.slot.w, 150);
  const bw = Math.max(80, Math.min(260, sw - 10));
  const base = num(h.slot.x, 0) + sw / 2 - bw / 2;
  const age = num(e.age, 1);
  const shown = age >= 1 && age < 3;
  // across the slot above the heads; on short stages just under the header band
  const top = Math.max(20, ctx.oy + 34);
  const bh = e.sub ? 34 : 22;
  const el = div().id(e.key).absolute().left(r2(clampX(base, bw, ctx))).top(r2(top + (age === 0 ? -10 : age >= 3 ? 10 : 0))).w(bw).h(bh)
    .opacity(shown ? 1 : 0).transition("top", { duration: 450, easing: "ease-out" }).transition("opacity", { duration: 450 })
    .flex().flex_col().items_center().justify_center().gap(2).px(8);
  if (pm) el.bg("#1A1726F2").rounded(6).border(1).border_color("#FFFFFF33");
  else el.bg("#16121FF2").rounded(2).border_t(2).border_b(2).border_color(C.xp);
  if (e.text) {
    el.child(div().max_w(bw - 16).truncate().text_size(pm ? 11 : 12).line_height(1).font_weight(800)
      .text_color(pm ? CREAM : C.xp).child(String(e.text)));
  }
  if (e.sub) el.child(div().max_w(bw - 16).truncate().text_size(9.5).line_height(1).text_color(alpha(CREAM, 0.8)).child(String(e.sub)));
  const out = [el];
  if (!pm) {
    // 12 confetti squares fall from the banner (age 1 → 2) and fade out
    for (let i = 0; i < CONFETTI_N; i++) {
      const cx0 = base + 6 + (jitter(`${e.key}c${i}`, 0, 1, 997) / 997) * (bw - 12);
      const fall = 18 + jitter(`${e.key}f${i}`, 0, 1, 23);
      const y = top + bh / 2 + (age <= 0 ? 0 : age === 1 ? fall : fall * 2.2);
      out.push(div().id(`${e.key}/c${i}`).absolute().left(r2(cx0)).top(r2(y)).w(4).h(4).bg(CONFETTI[i % CONFETTI.length])
        .opacity(age === 1 ? 1 : age === 2 ? 0.6 : 0)
        .transition("top", { duration: 900, easing: "ease-in" }).transition("opacity", { duration: 900 }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Boss

function boss(b, ctx) {
  const { oy } = ctx;
  const age = num(b.age, 9);
  const k = bossScale(b, ctx);
  const w = r2(num(b.w, 112) * k), h = r2(num(b.h, 96) * k);
  const out = [];
  // Sprite: hidden 40 px low at age 0, rises at age 1 (D§11.8 entrance).
  const rise = age === 0 ? 40 : 0;
  const op = age === 0 ? 0 : b.stamp ? 0.4 : b.invuln ? 0.72 : 1;
  const sprite = div().id(b.key).absolute().left(r2(b.x - w / 2)).top(r2(oy + b.y - h + rise)).w(w).h(h).opacity(op)
    .transition("top", { duration: 900, easing: "ease-out" }).transition("opacity", { duration: 600 })
    .child(image(art(b.sprite ?? `boss/${b.bossId}.svg`)).absolute().left(0).top(0).w(w).h(h));
  if (b.tooltip) sprite.tooltip(b.tooltip);
  const retreat = b.retreat;
  if (retreat) {
    // D§11.16 Retreat on the boss, with the sheet's confirm pattern: arm, then click again. GPUI
    // fires on_click for each click of a double-click (click_count 1, then 2): only a fresh single
    // click confirms, so a double-click on the boss arms and never retreats on its own.
    sprite.cursor_pointer().on_click((e, cx) => {
      cx.stop_propagation();
      if (num(e?.click_count, 1) >= 2) return;
      const ui = ctx.ui;
      if (armed(b, ctx)) {
        ui.armed = null;
        ctx.act("retreat", retreat.args ?? {});
      } else ui.armed = { key: b.key, tick: num(ctx.vm.tick, 0) };
      cx.notify();
    });
  }
  out.push(sprite);
  for (const p of b.parts ?? []) out.push(part(b, p, ctx));
  if (!b.stamp && b.arena) out.push(ctx.H < SLIM_HUD_H ? bossHudSlim(b, ctx) : bossHud(b, ctx));
  return out;
}

/** The armed Retreat question (red pill) over the boss's lower body, painted over everything. */
function armedPill(b, ctx) {
  const text = String(b.retreat?.confirm ?? "");
  const pw = monoW(text, 10) + 16;
  const top = Math.max(20, ctx.oy + num(b.y, GROUND) - 44);
  return div().id(`${b.key}/armed`).absolute().left(r2(clampX(b.x - pw / 2, pw, ctx))).top(r2(top)).w(pw).h(18).rounded(9)
    .bg("#5A1620F2").border(1).border_color(C.hp).flex().items_center().justify_center()
    .text_size(10).line_height(1).font_family(MONO).font_weight(800).text_color(CREAM).whitespace_nowrap().child(text);
}

/** Ticks a first click on the boss keeps Retreat armed. */
const ARM_TICKS = 4;

/** This boss's Retreat is armed (a first click less than ARM_TICKS ticks ago). */
function armed(b, ctx) {
  const a = ctx.ui?.armed;
  if (!a || a.key !== b.key) return false;
  const dt = num(ctx.vm?.tick, 0) - num(a.tick, 0);
  return dt >= 0 && dt <= ARM_TICKS;
}

/** Below this stage height the boss HUD moves into the arena's header band (one 16 px row). */
const SLIM_HUD_H = 160;

/** The boss sprite shrinks (to 0.55 at most) to fit between the header band and the ground. */
function bossScale(b, ctx) {
  const h = num(b.h, 96);
  const room = GROUND + ctx.oy - 20;
  return h > room ? Math.max(0.55, room / h) : 1;
}

/** Short stages: name, HP bar and mechanic text in one row over the arena's header band. */
function bossHudSlim(b, ctx) {
  const a = b.arena;
  const age = num(b.age, 9);
  const w = Math.max(80, num(a.w, 240) - 8);
  const nameW = Math.min(150, Math.round(w * 0.36));
  const mech = String(b.mechText ?? b.phaseLabel ?? "");
  let mechW = mech ? Math.min(monoW(mech, 9) + 2, Math.round(w * 0.3)) : 0;
  let barW = w - 12 - nameW - 12 - (mechW ? mechW + 6 : 0);
  if (barW < 40 && mechW) { barW += mechW + 6; mechW = 0; }
  barW = Math.max(20, barW);
  const fill = age <= 1 ? 0 : Math.round(barW * clamp01(b.hpFrac));
  const segs = Math.max(1, Math.min(12, Math.round(num(b.segments, 1))));
  const bar = div().relative().flex_none().w(barW).h(5).rounded(2).bg("#FFFFFF24").overflow_hidden()
    .child(div().id(`${b.key}/hpfill`).absolute().left(0).top(0).h(5).w(fill).bg(b.invuln ? "#9AA3AD" : C.hp)
      .transition("width", { duration: age <= 2 ? 800 : 400, easing: "ease-out" }));
  for (let i = 1; i < segs; i++) bar.child(div().absolute().left(Math.round((i * barW) / segs)).top(0).w(1).h(5).bg(INK));
  const el = div().id(`${b.key}/hud`).absolute().left(r2(num(a.x, 0) + 4)).top(1).w(w).h(16).rounded(3).bg("#17142A")
    .flex().items_center().gap(6).px(6)
    .child(div().flex_none().w(nameW).truncate().text_size(10).line_height(1).font_weight(700)
      .text_color(b.enraged ? "#FF8A8D" : CREAM).child(String(b.name ?? "")))
    .child(bar);
  if (mechW) {
    el.child(div().flex_none().w(mechW).truncate().text_size(9).line_height(1).font_family(MONO)
      .text_color(b.enraged ? C.hp : alpha(CREAM, 0.85)).child(mech));
  }
  return el;
}

function part(b, p, ctx) {
  const top = r2(ctx.oy + p.y - (b.partSprite === null ? 10 : 32));
  const el = div().id(p.key).absolute().left(r2(p.x - 16)).top(top).w(32).h(b.partSprite === null ? 10 : 36)
    .opacity(p.active === false ? 0.35 : 1).transition("opacity", { duration: 400 });
  if (p.label) el.tooltip(String(p.label));
  if (b.partSprite !== null) {
    el.child(image(art(b.partSprite ?? `boss/${b.bossId}-part.svg`)).absolute().left(0).top(0).w(32).h(32));
  }
  const ty = b.partSprite === null ? 6 : 33;
  if (b.partSprite === null && p.label) {
    el.child(div().absolute().left(-8).top(-4).w(48).h(9).flex().justify_center().text_size(8).line_height(1)
      .font_family(MONO).text_color(alpha(CREAM, 0.85)).whitespace_nowrap().child(String(p.label)));
  }
  el.child(div().absolute().left(4).top(ty).w(24).h(3).rounded(1).bg("#0B0A12CC")
    .child(div().id(`${p.key}/hp`).absolute().left(0).top(0).h(3).w(Math.round(24 * clamp01(p.hpFrac))).bg(C.hp)
      .transition("width", { duration: 300 })));
  return el;
}

/** Name + phase, segmented HP bar (fills at age 2), timer line, one-line mechanic text. */
function bossHud(b, ctx) {
  const a = b.arena;
  const age = num(b.age, 9);
  const hw = Math.max(120, Math.min(240, a.w - 32));
  const left = r2(a.x + a.w / 2 - hw / 2);
  const top = r2(Math.max(20, ctx.oy + 20));
  const segs = Math.max(1, Math.min(12, Math.round(num(b.segments, 1))));
  const fill = age <= 1 ? 0 : Math.round(hw * clamp01(b.hpFrac));
  const hp = div().relative().w(hw).h(6).rounded(2).bg("#0B0A12D9").overflow_hidden()
    .child(div().id(`${b.key}/hpfill`).absolute().left(0).top(0).h(6).w(fill).bg(b.invuln ? "#9AA3AD" : C.hp)
      .transition("width", { duration: age <= 2 ? 800 : 400, easing: "ease-out" }));
  for (let i = 1; i < segs; i++) hp.child(div().absolute().left(Math.round((i * hw) / segs)).top(0).w(1).h(6).bg(INK));
  const row = div().flex().items_center().justify_between().gap(6).h(12)
    .child(div().flex_1().min_w(0).truncate().text_size(10).line_height(1).font_weight(700).text_color(b.enraged ? "#FF8A8D" : CREAM)
      .child(String(b.name ?? "")));
  if (b.phaseLabel || b.invuln) {
    const tag = div().flex_none().flex().items_center().gap(3).text_size(9).line_height(1).font_family(MONO).font_weight(700)
      .text_color(b.enraged ? C.hp : alpha(CREAM, 0.85)).whitespace_nowrap();
    if (b.invuln) tag.child(svg(art("ui/lock.svg")).w(9).h(9).text_color(alpha(CREAM, 0.85)));
    if (b.phaseLabel) tag.child(String(b.phaseLabel));
    row.child(tag);
  }
  // A dark plate behind the HUD keeps the name and mechanic readable on pale skies and over the
  // sprite on short stages.
  const el = div().id(`${b.key}/hud`).absolute().left(r2(left - 6)).top(r2(top - 3)).w(hw + 12).px(6).py(3).rounded(4)
    .bg("#0B0A12B8").flex().flex_col().gap(2).child(row).child(hp);
  if (Number.isFinite(b.timerFrac)) {
    el.child(div().relative().w(hw).h(2).bg("#0B0A1299")
      .child(div().id(`${b.key}/timer`).absolute().left(0).top(0).h(2).w(Math.round(hw * clamp01(b.timerFrac)))
        .bg(b.enraged ? C.hp : alpha(CREAM, 0.7)).transition("width", { duration: 900, easing: "linear" })));
  }
  if (b.mechText) {
    el.child(div().h(12).flex().justify_center().truncate().text_size(9.5).line_height(1).font_family(MONO)
      .text_color(alpha(CREAM, 0.9)).child(String(b.mechText)));
  }
  return el;
}

/** Entrance / Postmortem banner and the FIXED stamp (painted over the fighters and fx). */
function bossOverlays(b, ctx) {
  const out = [];
  const a = b.arena ?? { x: b.x - 120, w: 240 };
  const bn = b.banner;
  if (bn && (!ctx.calm || bn.kind === "postmortem")) {
    const pm = bn.kind === "postmortem";
    const bw = Math.max(160, Math.min(300, a.w - 24));
    const base = a.x + a.w / 2 - bw / 2;
    const age = num(bn.age, 1);
    const shift = age === 0 ? -24 : age >= 3 ? 24 : 0;
    // Below the boss HUD (top ≥ 20, ≤ 38 tall) on short stages (D§11.15 height 120).
    const el = div().id(bn.key).absolute().left(r2(base + shift)).top(r2(Math.max(ctx.oy + 70, 62))).w(bw).h(pm ? 40 : 36)
      .opacity(age === 0 || age >= 3 ? 0 : 1)
      .transition("left", { duration: 450, easing: "ease-out" }).transition("opacity", { duration: 450 })
      .bg(pm ? "#1A1726F2" : "#16121FF2").rounded(pm ? 6 : 2).flex().flex_col().items_center().justify_center().gap(2).px(10);
    if (pm) el.border(1).border_color("#FFFFFF33");
    else el.border_t(2).border_b(2).border_color(C.hp);
    el.child(div().max_w(bw - 28).truncate().text_size(12).line_height(1).font_weight(700).text_color(CREAM).child(String(bn.text ?? "")));
    if (bn.sub) el.child(div().max_w(bw - 28).truncate().text_size(9.5).line_height(1).text_color(alpha(CREAM, 0.75)).child(String(bn.sub)));
    if (!pm) {
      el.child(image(art("fx/banner.svg")).absolute().left(-5).top(7).w(12).h(18));
      el.child(image(art("fx/banner.svg")).absolute().left(bw - 7).top(7).w(12).h(18));
    }
    out.push(el);
  }
  const st = b.stamp;
  if (st) {
    const down = num(st.age, 1) >= 1;
    const sw = down ? 80 : 160, sh = down ? 28 : 56;
    const cx = b.x, cy = ctx.oy + b.y - (num(b.h, 96) * bossScale(b, ctx)) / 2;
    const el = st.sprite === null
      ? div().id(st.key).absolute().border(3).border_color(C.hp).rounded(3).flex().items_center().justify_center()
        .text_size(down ? 16 : 30).font_weight(900).text_color(C.hp).whitespace_nowrap().child(String(st.text ?? ""))
      : image(art(st.sprite ?? "fx/stamp-fixed.svg")).id(st.key).absolute();
    out.push(el.left(r2(cx - sw / 2)).top(r2(cy - sh / 2)).w(sw).h(sh).opacity(down ? 1 : 0)
      .transition("left", { duration: 300, easing: "ease-in" }).transition("top", { duration: 300, easing: "ease-in" })
      .transition("width", { duration: 300, easing: "ease-in" }).transition("height", { duration: 300, easing: "ease-in" })
      .transition("opacity", { duration: 150 }));
  }
  if (b.retreat && armed(b, ctx)) out.push(armedPill(b, ctx));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Effects (two-tick pattern, ARCHITECTURE §6.2)

const FX_CAP = 28;   // D§11.7 allows 12 numbers per tick; two ticks of them plus a few others
const FX_LAYER = { levelup: 0, pillar: 0, stamp: 1, poof: 2, coin: 3, loot: 3, coffee: 3 };

/** The kept effects (detail() picks them) painted back to front: columns, poofs, pickups, text. */
function paintOrder(list) {
  return list.slice().sort((a, b) => num(FX_LAYER[a.kind], 4) - num(FX_LAYER[b.kind], 4));
}

function fx(f, ctx) {
  const k = f.kind;
  const age = num(f.age, 0);
  if (TWO_TICK.has(k) && age >= 2) return [];
  if (NUMBERS.has(k)) {
    const mode = ctx.vm.nums ?? "all";
    if (ctx.calm || mode === "off" || (mode === "crits" && k !== "crit")) return [];
  }
  if (ctx.calm && (k === "pillar" || k === "levelup" || k === "skill")) return [];
  const { oy } = ctx;
  const later = age >= 1 && TWO_TICK.has(k);
  const x = f.x + (later ? num(f.dx, 0) : 0);
  const y = oy + f.y + (later ? num(f.dy, -28) : 0);
  const op = later ? 0 : 1;
  const move = (el) => el.opacity(op)
    .transition("left", { duration: 900, easing: "ease-out" }).transition("top", { duration: 900, easing: "ease-out" })
    .transition("opacity", { duration: 900, easing: "ease-in" });

  switch (k) {
    case "poof": return [move(image(art("fx/poof.svg")).id(f.key).absolute().left(r2(x - 12)).top(r2(y - 12)).w(24).h(24))];
    case "coin": return [move(image(art("fx/coin.svg")).id(f.key).absolute().left(r2(x - 3)).top(r2(y - 3)).w(6).h(6))];
    case "loot": return [move(svg(art("fx/loot.svg")).id(f.key).absolute().left(r2(x - 5)).top(r2(y - 5)).w(10).h(10).text_color(f.color ?? C.white))];
    case "coffee": return [move(image(art("fx/mug.svg")).id(f.key).absolute().left(r2(x - 6)).top(r2(y - 6)).w(12).h(12))];
    case "stamp": return [image(art("fx/stamp-fixed.svg")).id(f.key).absolute().left(r2(f.x - 40)).top(r2(oy + f.y - 14)).w(80).h(28)];
    case "levelup": return levelUp(f, ctx);
    case "pillar": return lootPillar(f, ctx);
    default: break;
  }
  // Text floats: numbers, HTTP jokes, skill names, Unblocked, +Ship XP.
  const size = num(f.size, k === "crit" ? 13 : k === "incoming" ? 9 : k === "skill" ? 10 : 11);
  const text = String(f.text ?? "");
  const tw = monoW(text, size) + 8;
  const th = Math.ceil(size + 5);
  // short stages lift the scene into the header band: floats stay below it (they still fade)
  const yy = Math.max(y, 20 + th / 2);
  const out = [];
  if (k === "crit") {
    out.push(move(svg(art("fx/starburst.svg")).id(`${f.key}/burst`).absolute().left(r2(x - tw / 2 - 11)).top(r2(yy - 9)).w(18).h(18).text_color("#FFB347")));
  }
  const color = f.color ?? (k === "heal" ? "#6BE38A" : k === "incoming" ? C.hp : k === "num" ? "#FFFFFFD9" : CREAM);
  out.push(move(div().id(f.key).absolute().left(r2(x - tw / 2)).top(r2(yy - th / 2)).w(tw).h(th).rounded(3)
    .bg(alpha(INK, k === "crit" ? 0.7 : 0.55)).flex().items_center().justify_center()
    .text_size(size).line_height(1).font_family(MONO).font_weight(k === "num" ? 600 : 800).text_color(color)
    .whitespace_nowrap().child(text)));
  return out;
}

/** Level-up: a cyan light column and "LEVEL UP" text (age 0..1, DESIGN §11.8). */
function levelUp(f, ctx) {
  const { oy } = ctx;
  // on short stages the column starts below the header band (as a loot pillar's does)
  const top = Math.max(18, oy + 30);
  const col = div().id(f.key).absolute().left(r2(f.x - 9)).top(r2(top)).w(18).h(r2(Math.max(1, oy + GROUND - top))).rounded(9)
    .bg(alpha(C.xp, 0.55)).opacity(0.7);
  // one slow pulse over the column's 1.6 s: a loop's period is a whole there-and-back
  // (materialize.rs apply_loops), and nothing on the stage flashes faster than 1 Hz (D§11.1)
  if (ctx.motion) col.loop("opacity", { from: 0.3, to: 0.9, period: 1600, easing: "ease-in-out" });
  const age = num(f.age, 0);
  const label = div().id(`${f.key}/t`).absolute().left(r2(f.x - 34)).top(r2(Math.max(20, oy + f.y - (age >= 1 ? 92 : 72)))).w(68).h(12)
    .flex().justify_center().text_size(10).line_height(1).font_family(MONO).font_weight(800).text_color(C.xp)
    .whitespace_nowrap().opacity(age >= 2 ? 0 : 1)
    .transition("top", { duration: 900, easing: "ease-out" }).transition("opacity", { duration: 600 })
    .child(String(f.text ?? ""));
  return [col, label];
}

/**
 * LTS / Keepsake light pillar: 48 px column in the rarity colour. Painted over the scene but with
 * no handler: its click (the sheet) is pillarHit's, under the heroes. Its rarity name is
 * pillarLabel's, painted after every other effect.
 */
function lootPillar(f, ctx) {
  const { oy } = ctx;
  const c = f.color ?? "#FF9A2E";
  // on short stages the column starts below the header band (as its click target does)
  const top = Math.max(18, oy + 20);
  const col = div().id(f.key).absolute().left(r2(f.x - 24)).top(r2(top)).w(48).h(r2(Math.max(1, oy + GROUND - top))).rounded(6).bg(alpha(c, 0.28))
    .opacity(num(f.age, 0) >= 3 ? 0 : 1).transition("opacity", { duration: 600 });
  return [col];
}

/**
 * A pillar's rarity name, in the rarity colour on the dark plate the stage's other labels use (the
 * raw colour over a light zone's sky read at 1.4–1.6:1), painted over the effects so a damage
 * number rising through the column never hides it (short stages put both near the header band).
 */
function pillarLabel(f, ctx) {
  if (ctx.calm || f.kind !== "pillar") return [];
  const c = f.color ?? "#FF9A2E";
  const text = String(f.text ?? "");
  const top = Math.max(18, ctx.oy + 20);
  const w = Math.min(96, monoW(text, 9.5) + 10);
  return [div().id(`${f.key}/t`).absolute().left(r2(clampX(f.x - w / 2, w, ctx))).top(r2(top + 3)).w(w).h(14).rounded(4)
    .bg(alpha(INK, 0.85)).flex().items_center().justify_center()
    .text_size(9.5).line_height(1).font_family(MONO).font_weight(800).text_color(c).whitespace_nowrap()
    .opacity(num(f.age, 0) >= 3 ? 0 : 1).transition("opacity", { duration: 600 }).child(text)];
}

/**
 * A pillar's click target (D§11.16: the finder's sheet on that item's compare card): the column's
 * box below the header band, transparent, painted under every element that takes clicks, so the
 * finder standing in its light, a chest or a "!" bubble keeps its own click.
 */
function pillarHit(f, ctx) {
  const sh = pillarSheet(f);
  const top = Math.max(18, ctx.oy + 20);
  return div().id(`${f.key}/hit`).absolute().left(r2(f.x - 24)).top(r2(top)).w(48).h(r2(Math.max(1, ctx.oy + GROUND - top)))
    .cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); openSheetOn(sh.heroId, sh.itemUid, ctx); });
}

// ---------------------------------------------------------------------------------------------
// Header band messages, overflow chip, empty states

/** Narrowest header note worth showing (truncated with an ellipsis below its full width). */
const NOTE_MIN_W = 60;

/**
 * The ≤ 3 s header note (D§11.15: "text only, inside the header band"). It never covers a room
 * title and never leaves the band (below it, on short stages, are heads and "!" bubbles): it sits
 * right-aligned in the header of the room with the most free header space, truncated when that
 * space is narrower than the text, and is not shown when no header has NOTE_MIN_W px to spare.
 * The boss arena's header holds the slim boss HUD on short stages, so it takes no note there.
 */
function headerNote(n, ctx, rooms) {
  const text = String(n.text ?? "");
  const want = Math.min(ctx.W - 16, monoW(text, 10) + 24);
  const arena = ctx.vm.boss?.arena ?? null;
  let best = null;
  for (const r of rooms) {
    const w = num(r.w, 0);
    if (arena && ctx.H < SLIM_HUD_H && num(r.x, 0) + w > num(arena.x, 0) + 1 && num(r.x, 0) < num(arena.x, 0) + num(arena.w, 0) - 1) continue;
    const free = w - headerFit(r, w, ctx.bareRooms).used - 8;
    if (!best || free > best.free) best = { free, right: num(r.x, 0) + w - 4 };
  }
  // the Localhost scenery at either end of the strip (backdrop()) has an empty header band too:
  // a lone hero's 320 px slot on a wide stage leaves hundreds of px there. A note in it sits
  // beside the rooms (right-aligned on the left end, left-aligned on the right end).
  if (rooms.length) {
    const lo = Math.min(...rooms.map((r) => num(r.x, 0)));
    const hi = Math.max(...rooms.map((r) => num(r.x, 0) + num(r.w, 0)));
    const end = ctx.vm.overflow ? num(ctx.vm.overflow.x, ctx.W) : ctx.W;
    for (const [a, b, side] of [[0, lo, "l"], [hi, end, "r"]]) {
      const free = b - a - 8;
      if (free > 0 && (!best || free > best.free)) best = { free, right: side === "l" ? b - 4 : null, left: side === "r" ? a + 4 : null };
    }
  }
  if (!best || best.free < Math.min(want, NOTE_MIN_W)) return null;
  const bw = Math.min(want, best.free);
  const left = best.left != null ? best.left : best.right - bw;
  const top = 1;
  return div().id(n.key).absolute().left(r2(clampX(left, bw, ctx))).top(top).w(r2(bw)).h(16).rounded(8)
    .bg("#0B0A12EB").border(1).border_color(alpha(n.color ?? CREAM, 0.55))
    .flex().items_center().justify_center().px(8).truncate()
    .text_size(10).line_height(1).font_weight(700).text_color(n.color ?? CREAM).child(text);
}

/** Herd-first boss kill: the only stage-wide moment, an 18 px band across the header (D§11.8). */
function herdBanner(b, ctx) {
  return [div().id(b.key).absolute().left(0).top(0).w(ctx.W).h(18).bg("#2A1B4A").border_b(1).border_color(alpha(CREAM, 0.4))
    .flex().items_center().justify_center().gap(8)
    .child(image(art("fx/banner.svg")).w(8).h(12))
    .child(div().truncate().text_size(11).line_height(1).font_weight(800).text_color(CREAM).child(String(b.text ?? "")))
    .child(image(art("fx/banner.svg")).w(8).h(12))];
}

/** "+n" camp chip at the right end: tents with status dots; hover lists the folded heroes. */
function overflowChip(o, ctx) {
  const { oy, H, night } = ctx;
  const w = num(o.w, 150);
  const gy = oy + GROUND;
  const el = div().id(o.key).absolute().left(o.x).top(0).w(w).h(H).overflow_hidden().bg(night.sky)
    .border_l(2).border_color(INK);
  if (o.tooltip) el.tooltip(String(o.tooltip));
  if (!ctx.compact) el.child(div().absolute().left(0).top(r2(oy + 104)).w(w).h(56).bg(night.horizon));
  el.child(div().absolute().left(0).top(r2(gy)).w(w).h(Math.max(40, H - gy)).bg(night.ground));
  el.child(div().absolute().left(0).top(r2(gy)).w(w).h(2).bg(night.line));
  const n = Math.max(0, Math.round(num(o.count, 0)));
  if (!ctx.compact) {
    const tents = Math.min(3, Math.max(1, n));
    for (let i = 0; i < tents; i++) {
      const tx = w / 2 + (i - (tents - 1) / 2) * 30 - 8;
      el.child(image(art("fx/tent.svg")).absolute().left(r2(tx)).top(r2(gy - 14)).w(16).h(14));
    }
  }
  const label = o.label ?? `+${n}`;
  const lw = monoW(label, 13) + 16;
  el.child(div().absolute().left(r2(w / 2 - lw / 2)).top(r2(ctx.compact ? Math.max(2, gy - 22) : oy + 88)).w(lw).h(20).rounded(10)
    .bg("#0B0A12CC").border(1).border_color(alpha(CREAM, 0.3)).flex().items_center().justify_center()
    .text_size(13).line_height(1).font_family(MONO).font_weight(800).text_color(CREAM).child(label));
  const dots = (o.dots ?? []).slice(0, Math.max(1, Math.min(10, Math.floor((w - 12) / 9))));
  const dy = ctx.compact ? gy + 6 : oy + 116;
  dots.forEach((c, i) => {
    const dx = w / 2 + (i - (dots.length - 1) / 2) * 9 - 3;
    el.child(div().absolute().left(r2(dx)).top(r2(dy)).w(6).h(6).rounded(3).bg(c));
  });
  return el;
}

/**
 * Localhost at night (D§10.2, §11.3.6): the no-agents and loading states. `empty` is the VM's
 * {kind, title, text}; null = the world itself is still loading (no VM yet).
 */
function localhost(empty, ctx) {
  const { W, H, oy, night } = ctx;
  const gy = oy + GROUND;
  const compact = ctx.compact;
  const loading = !empty || empty.kind === "loading";
  const el = div().id("stage-localhost").absolute().left(0).top(0).w(W).h(H);
  // Sky: two night bands and a few stars; a moon on the right.
  el.child(div().absolute().left(0).top(r2(oy + 104)).w(W).h(56).bg(night.horizon));
  if (!compact) {
    el.child(div().absolute().left(0).top(r2(oy + 72)).w(W).h(32).bg(alpha(night.horizon, 0.5)));
    const stars = Math.min(14, Math.floor(W / 90));
    for (let i = 0; i < stars; i++) {
      const sx = (jitter(`star${i}`, 0, 1, 997) / 997) * (W - 8) + 4;
      const sy = oy + 10 + (jitter(`sky${i}`, 0, 1, 61));
      el.child(div().absolute().left(r2(sx)).top(r2(sy)).w(2).h(2).bg(alpha(CREAM, i % 3 ? 0.55 : 0.9)));
    }
    if (W > 420) el.child(div().absolute().left(r2(W - 70)).top(r2(oy + 22)).w(14).h(14).rounded(7).bg("#F3EBD3"));
  }
  el.child(div().absolute().left(0).top(r2(gy)).w(W).h(Math.max(40, H - gy)).bg(night.ground).border_t(2).border_color(night.line));
  // The sign (title + text from the VM; three dots while there is no VM yet). The text wraps
  // to two lines on a narrow stage.
  const textW = String(empty?.text ?? "").length * 10 * 0.54;
  const bw = compact ? Math.max(120, W - 32) : Math.max(Math.min(W - 32, 180), Math.min(W - 32, 440, textW + 32));
  const lines = !compact && textW > bw - 24 ? 2 : 1;
  const bh = compact ? Math.min(34, H - 8) : empty?.text ? 26 + lines * 13 : 28;
  const bx = W / 2 - bw / 2;
  const by = compact ? Math.max(4, (H - bh) / 2) : gy - 22 - bh;
  if (!compact) {
    el.child(div().absolute().left(r2(bx + 18)).top(r2(gy - 24)).w(4).h(24).bg(WOOD.post));
    el.child(div().absolute().left(r2(bx + bw - 22)).top(r2(gy - 24)).w(4).h(24).bg(WOOD.post));
  }
  const board = div().id("stage-sign").absolute().left(r2(bx)).top(r2(by)).w(bw).h(bh).rounded(3)
    .bg(WOOD.board).border(2).border_color(WOOD.edge).flex().flex_col().items_center().justify_center().gap(3).px(10);
  if (!empty) {
    board.child(ctx.calm ? div().text_size(14).font_weight(800).text_color(CREAM).child("···")
      : div().text_size(14).font_weight(800).text_color(CREAM).frames(["·", "··", "···"], 450));
  } else {
    board.child(div().max_w(bw - 20).truncate().text_size(12).line_height(1.1).font_weight(800).text_color(CREAM).child(String(empty.title ?? "")));
    if (empty.text) {
      const t = div().max_w(bw - 20).text_size(10).line_height(1.25).text_center().text_color(alpha(CREAM, 0.82));
      board.child((lines > 1 ? t.whitespace_normal() : t.truncate()).child(String(empty.text)));
    }
  }
  el.child(board);
  if (!compact) {
    // Campfire left of the sign (dim while loading), tents and the dark portal on the right.
    const fx0 = bx - 44;
    if (fx0 > 16) el.children(campfire("stage-fire", { x: fx0, y: GROUND }, { ...ctx, calm: ctx.calm || loading }));
    const tx = bx + bw + 26;
    if (tx + 16 < W - 8) el.child(image(art("fx/tent.svg")).absolute().left(r2(tx)).top(r2(gy - 14)).w(16).h(14));
    if (tx + 46 < W - 8) el.child(image(art("fx/tent.svg")).absolute().left(r2(tx + 24)).top(r2(gy - 14)).w(16).h(14));
    const px = bx + bw + 82;
    if (px + 32 < W - 8) el.child(image(art("fx/portal.svg")).absolute().left(r2(px)).top(r2(gy - 48)).w(32).h(48).opacity(loading ? 0.35 : 0.6));
  }
  return el;
}

// Small re-exports for tests and other renderers.
export { programIcon, detail as stageDetail };
/** Tests: the scene cost (no effects) at each ladder level. */
export const _budget = { BUDGET, ANIM_BUDGET, FX_RESERVE, MARGIN, levels: () => RUNGS.length, sceneCost, atLevel };
