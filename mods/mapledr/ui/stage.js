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
//   - Every `sprite` is a path relative to mods/mapledr/art/ (e.g. "mob/typo_sprout.svg").
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
 * @property {Array<{key, address, x, y, face, status, bubble, tooltip?:string}>} forklings
 *           tooltip: the sub-agent's title (hover, D§11.16).
 *   Faces/colours are final: the renderer shows `face` as given (">_" blinks while questing).
 *   When `crate` is true the renderer draws the crate at (x, y) and lifts the Termling 12 px.
 *
 * @typedef {object} MobVMAdditions
 * @property {number} px       Base sprite size (28/40/56); drawn size = px × (elite ? 1.25 : 1) × growScale.
 * @property {boolean} [hit]   Took damage this tick: opacity dips to 0.55 (ARCHITECTURE §9.2).
 * @property {boolean} [waiting]  Queued behind a blocked hero: shows a "…" bubble (D§11.10).
 *   phaser → opacity flicker loop 1 → 0.6 (1.2 s); pending → "…" ring; dying → fades out.
 *
 * @typedef {object} ChestVMAdditions
 * @property {string|null} address  Terminal to focus after claiming (D§11.16).
 *   tier: "wooden"|"iron"|"silver"|"gold"|"duck"; count > 1 shows "×n"; unopened chests carry
 *   the SHIPPED ribbon and a sparkle.
 *
 * @typedef {object} BossVMAdditions
 * @property {number} age      Ticks since the fight started (entrance: 0 dim + hidden, 1 rise,
 *           2 HP bar fills).
 * @property {string} [tooltip]  Mechanics summary and win estimate (hover).
 * @property {string|null} [partSprite]  Part art (e.g. "boss/octopus_merge-part.svg"); null draws
 *           parts as small labelled bars (e.g. the Pyramid's layers).
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
 */
// ---------------------------------------------------------------------------------------------

import { div, svg, image } from "gpui-kit";
import { run, openOverlay, focused, theme as herdrTheme } from "herdr";
import { art, C, MONO, T, zoom, alpha, jitter, kids, clamp01 } from "./kit.js";
import { renderTermling, renderForkling, programIcon } from "./termling.js";

const REF_H = 200;           // the reference composition height (D§11.2)
const GROUND = 160;          // ground line in the reference composition
const COMPACT_H = 100;       // below this the stage shows only plates, chests, bubbles, HP lines
const NIGHT = { sky: "#151126", horizon: "#2E2545", ground: "#100D1C", line: "#3B2F5C" };
const INK = "#0B0A12";       // pill / plate backgrounds
const CREAM = C.cream;
const WOOD = { board: "#7A5232", edge: "#3E2716", post: "#5A3A22" };
const CHEST_H = { duck: 28 };
const NUMBERS = new Set(["num", "crit", "heal", "miss", "inv", "abs", "incoming"]);
const TWO_TICK = new Set(["num", "crit", "heal", "miss", "inv", "abs", "incoming", "poof", "coin", "loot", "skill", "coffee", "unblocked", "ship"]);
const BOBBING = new Set(["questing", "supervising", "shipped"]);

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const r2 = (n) => Math.round(n * 100) / 100;
/** Width of a monospace label (JetBrains Mono advances ≈ 0.6 em). */
const monoW = (text, size) => Math.ceil(String(text).length * size * 0.6);
/** List items whose x (and `also`) are finite numbers. */
const placed = (list, also) => (Array.isArray(list) ? list.filter((e) => e && Number.isFinite(e.x) && (!also || Number.isFinite(e[also]))) : []);
/** Keep a box of width w inside the stage horizontally. */
const clampX = (left, w, ctx) => Math.max(1, Math.min(ctx.W - w - 1, left));

const SHEET = (heroId) => ({ mod: "mapledr", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId } });
const HERD = () => ({ mod: "mapledr", kind: "dialog", width: 760, height: 520, props: { role: "herd" } });

// ---------------------------------------------------------------------------------------------
// The role object

export default class Stage {
  init(props, _cx, host) {
    this.props = props ?? {};
    this.host = host ?? null;
    this.size = null; // logical {width, height}, from on_size_change
  }

  /** env for renderStage; theme = T() plus the layout's mdr_* tokens (herdr merges them into theme()). */
  env(width, height) {
    const host = this.host;
    const th = T();
    const raw = herdrTheme() ?? {};
    for (const k of Object.keys(raw)) if (k.startsWith("mdr_")) th[k] = raw[k];
    return { width, height, zoom: zoom(), theme: th, host, act: (name, args) => host?.command?.(name, args) };
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
      const term = focused()?.terminal ?? null;
      const heroes = vm?.heroes ?? [];
      const hero = heroes.find((h) => term && h.address === term) ?? heroes.find((h) => h.focused) ?? heroes[0];
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
 * env = { width, height, zoom, theme: T() (+ mdr_* tokens), host, act(name, args) }.
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
  scene.children(kids([
    backdrop(rooms, ctx),
    ...rooms.map((r) => room(r, ctx)),
    vm.boss ? arenaDim(vm.boss, ctx) : null,
  ]));
  if (!ctx.compact) {
    for (const s of vm.signs ?? []) scene.children(sign(s, ctx));
  }
  for (const c of vm.chests ?? []) scene.child(chest(c, ctx));
  if (!ctx.compact) {
    for (const h of heroes) if (h.campfire) scene.children(campfire(h.key, h.campfire, ctx));
    for (const h of heroes) if (h.crate) scene.child(image(art("fx/crate.svg")).absolute().left(r2(h.x - 12)).top(r2(ctx.oy + h.y - 16)).w(24).h(16));
    for (const m of vm.mobs ?? []) scene.children(mob(m, ctx));
  }
  // Blocked: a translucent overlay over the slot (ARCHITECTURE §9.3), under the hero and bubble.
  // It starts below the header band so a room header is never half-dimmed.
  const slotTop = ctx.compact ? 0 : 18;
  for (const h of heroes) {
    if (h.state === "waiting" && h.slot) scene.child(div().absolute().left(h.slot.x).top(slotTop).w(h.slot.w).h(H - slotTop).bg(C.overlay));
  }
  if (!ctx.compact) {
    if (vm.boss) scene.children(boss(vm.boss, ctx));
    for (const h of heroes) {
      if (h.focused) scene.child(div().absolute().left(r2(h.x - 17)).top(r2(ctx.oy + h.y - 2)).w(34).h(4).rounded(2).bg(alpha(CREAM, 0.45)));
      scene.children(hero(h, ctx));
    }
  }
  for (const c of vm.chests ?? []) scene.children(chestMarks(c, ctx));
  if (!ctx.compact) {
    for (const h of heroes) {
      if (h.bubble) scene.child(bubble(h, ctx));
      if (h.zzz) scene.child(zzz(h, ctx));
    }
  } else {
    for (const h of heroes) if (h.bubble) scene.child(bubble(h, ctx));
  }
  for (const h of heroes) scene.children(plate(h, ctx));
  if (!ctx.compact) {
    for (const f of fxOrder(vm.fx, ctx.fxCap)) scene.children(fx(f, ctx));
    if (vm.boss) scene.children(bossOverlays(vm.boss, ctx));
  }
  if (vm.headerNote && !ctx.compact) scene.child(headerNote(vm.headerNote, ctx));
  if (vm.herdBanner && !calm && !ctx.compact) scene.children(herdBanner(vm.herdBanner, ctx));
  if (vm.overflow) scene.child(overflowChip(vm.overflow, ctx));
  return root.child(scene);
}

// ---------------------------------------------------------------------------------------------
// Element budget (D§11.9.7, ARCHITECTURE §7.4: about 400 elements per stage render)

const BUDGET = 392;

/**
 * Estimate this render's element count (it tracks the real count within a few elements) and pick
 * the detail that keeps it under the budget. Entities always render; scenery gives way first, in
 * order: ground tiles (the band keeps its colour and accent line), extra props (one per room),
 * far silhouettes, then the lean rig (no title-bar dots) and one-element mob HP bars, and as a
 * last resort one Forkling per hero (the rest join its "+n"; blocked ones are kept) and fewer
 * effects (the oldest go first). A dozen
 * heroes on a 2400 px stage keep full detail; 16 fighting heroes with a full effects tick fit.
 */
function detail(vm, rooms, heroes, ctx) {
  const out = { groundTiles: true, maxProps: 3, farTiles: true, leanRig: false, leanBars: false, maxForks: Infinity, fxCap: FX_CAP };
  if (ctx.compact) return { ...out, farTiles: false };
  let est = 3;
  const covered = rooms.reduce((a, r) => a + num(r.w, 0), 0) + num(vm.overflow?.w, 0);
  if (covered < ctx.W - 1) est += 3 + Math.min(14, Math.floor((ctx.W - covered) / 60) + 2); // Localhost ends
  let ground = 0, far = 0, props = 0, bars = 0;
  for (const r of rooms) {
    const w = num(r.w, 0);
    const g = Math.ceil(w / 32), f = Math.ceil((w + 48) / 160), p = Math.min(3, (r.props ?? []).length);
    ground += g; far += f + 1; props += Math.max(0, p - 1);
    est += 5 + g + f + 1 + p + (r.door ? 2 : 0) + (r.quota ? 2 : 0) + (r.stats || r.quota ? 1 : 0) + (r.dusk ? 1 : 0) + (r.dividerLeft ? 1 : 0);
  }
  for (const h of heroes) {
    est += 13 + (h.programIcon ? 0 : -1) + (h.hat ? 0 : -1) + (h.weapon?.edge ? 1 : 0) + (h.tag?.text ? 1 : 0)
      + (h.bubble ? 2 : 0) + (h.campfire ? 2 : 0) + (h.crate ? 1 : 0) + (h.zzz ? 1 : 0) + (h.focused ? 1 : 0)
      + (h.state === "waiting" && h.slot ? 1 : 0) + (h.state === "crashed" && Number.isFinite(h.rebootFrac) ? 2 : 0)
      + (h.forklings ?? []).reduce((a, f) => a + forkCost(f), 0) + (h.forklingExtra > 0 ? 1 : 0);
  }
  for (const m of vm.mobs ?? []) {
    if (m.dying) { est += 1; continue; }
    est += 1 + (m.showHp ? 2 : 0) + (m.elite ? 1 : 0) + (m.holo ? 1 : 0) + (m.glyph ? 1 : 0) + (m.pending || m.waiting ? 1 : 0);
    if (m.showHp) bars += 1;
  }
  for (const c of vm.chests ?? []) est += 2 + (c.open ? 0 : 2) + (num(c.count, 1) > 1 ? 1 : 0);
  const fxs = fxOrder(vm.fx);
  for (const f of fxs) est += fxCost(f);
  est += (vm.signs ?? []).length * 2 + (vm.headerNote ? 1 : 0) + (vm.herdBanner ? 3 : 0);
  if (vm.boss) est += 14 + num(vm.boss.segments, 1) + (vm.boss.parts ?? []).length * 4 + (vm.boss.banner ? 5 : 0) + (vm.boss.stamp ? 1 : 0);
  if (vm.overflow) est += 6 + Math.min(10, (vm.overflow.dots ?? []).length);
  if (est > BUDGET) { out.groundTiles = false; est -= ground; }
  if (est > BUDGET) { out.maxProps = 1; est -= props; }
  if (est > BUDGET) { out.farTiles = false; est -= far; }
  if (est > BUDGET) { out.leanRig = true; est -= heroes.length * 2; }
  if (est > BUDGET) { out.leanBars = true; est -= bars; }
  if (est > BUDGET) {
    // Last resort (many supervisors): one Forkling per hero, the rest folded into its "+n".
    out.maxForks = 1;
    for (const h of heroes) {
      const all = h.forklings ?? [];
      if (all.length <= 1) continue;
      const sum = (list) => list.reduce((a, f) => a + forkCost(f), 0);
      est -= sum(all) - sum(keptForklings(all, 1));
      if (!(h.forklingExtra > 0)) est += 1;
    }
  }
  if (est > BUDGET && fxs.length > 8) {
    // Then drop the oldest effects (age-1 fades go first), keeping at least 8.
    const byAge = fxs.slice().sort((a, b) => num(a.age, 0) - num(b.age, 0));
    let cap = byAge.length;
    while (est > BUDGET && cap > 8) est -= fxCost(byAge[--cap]);
    out.fxCap = cap;
  }
  out.estimate = est;
  return out;
}

/** Elements one effect costs (crits add a starburst; columns add their label). */
const fxCost = (f) => (f.kind === "crit" || f.kind === "levelup" || f.kind === "pillar" ? 2 : 1);

/** Elements one Forkling costs (renderForkling's 3, plus its small bubble). */
const forkCost = (f) => 3 + (f?.bubble ? 1 : 0);

/** The Forklings drawn when at most `max` fit: blocked ones (with a bubble) first, order kept. */
function keptForklings(all, max) {
  if (all.length <= max) return all;
  return [...all.filter((f) => f?.bubble), ...all.filter((f) => !f?.bubble)].slice(0, max);
}

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
  const bands = Array.isArray(r.skyBands) && r.skyBands.length >= 4 ? r.skyBands : [pal.sky, pal.sky, pal.sky, pal.sky];
  const zone = r.zone ?? "lint_meadows";
  const gy = oy + GROUND;
  const el = div().id(r.key).absolute().left(r.x).top(0).w(w).h(H).overflow_hidden().bg(bands[0] ?? NIGHT.sky)
    .transition("left", { duration: 900, easing: "ease-out" }).transition("width", { duration: 900, easing: "ease-out" });
  if (!ctx.compact) {
    // Bands 1 and 2 are one div: its 35 px top border is band 1, its background band 2.
    el.child(div().absolute().left(0).top(r2(oy + 53)).w(w).h(71).border_t(35).border_color(bands[1] ?? bands[0]).bg(bands[2] ?? bands[0]));
    el.child(div().absolute().left(0).top(r2(oy + 123)).w(w).h(Math.max(1, GROUND - 123)).bg(bands[3] ?? bands[0]));
    // Far silhouettes at 50 % opacity; a slow ±16 px drift while the room is working (§6.1).
    const far = div().absolute().left(-16).top(r2(oy + 40)).w(w + 48).h(100).opacity(0.5);
    if (r.working && ctx.motion) far.loop("left", { from: -32 * z, to: 0, period: jitter(r.key, 20000, 397), easing: "ease-in-out" });
    if (ctx.farTiles) {
      for (let x = 0; x < w + 48; x += 160) far.child(image(art(`bg/${zone}-far.svg`)).absolute().left(x).top(0).w(160).h(100));
      el.child(far);
    }
    for (const p of (r.props ?? []).slice(0, ctx.maxProps)) {
      el.child(image(art(p.sprite)).absolute().left(r2(p.x - r.x - p.w / 2)).top(r2(oy + p.y - p.h)).w(p.w).h(p.h));
    }
    if (r.door) el.child(image(art("fx/door.svg")).absolute().left(r2(w - 30)).top(r2(gy - 40)).w(24).h(40));
  }
  // Ground band: its 2 px top border is the accent line; the tiles are its children (below it).
  const ground = div().absolute().left(0).top(r2(gy)).w(w).h(Math.max(42, H - gy)).bg(pal.ground ?? NIGHT.ground)
    .border_t(2).border_color(pal.accent ?? NIGHT.line);
  if (ctx.groundTiles) for (let x = 0; x < w; x += 32) ground.child(image(art(`bg/${zone}-ground.svg`)).absolute().left(x).top(0).w(32).h(40));
  el.child(ground);
  if (r.dusk) el.child(div().absolute().left(0).top(0).w(w).h(H).bg("#1A123047"));
  if (r.dividerLeft) el.child(div().absolute().left(0).top(0).w(2).h(H).bg("#0B0A12CC"));
  if (!ctx.compact) el.child(roomHeader(r, w, ctx));
  return el;
}

/** Header band (y 0–18): map title, quota bar, stats, boss-door icon. Pinned to the top. */
function roomHeader(r, w, ctx) {
  // Fit: full title, else the short one ("CC 2-2"), else drop the Sprint part of the stats.
  const hasQuota = Boolean(r.quota && num(r.quota.need, 0) > 0);
  let stats = typeof r.stats === "string" ? r.stats : hasQuota ? `${r.quota.have}/${r.quota.need}` : "";
  const bw = w < 220 ? 24 : 36;
  const space = (st) => w - 14 - (hasQuota ? bw + 5 : 0) - (st ? monoW(st, 9.5) + 5 : 0) - (r.door ? 16 : 0);
  const textW = (t) => String(t ?? "").length * 10.5 * 0.56;  // the UI font averages ≈ 0.56 em
  let title = r.title ?? "";
  if (textW(title) > space(stats)) title = r.shortTitle ?? title;
  if (textW(title) > space(stats) && stats.includes(" · ")) stats = stats.slice(0, stats.indexOf(" · "));
  const strip = div().id(`${r.key}/hdr`).absolute().left(0).top(0).w(w).h(18).flex().items_center().gap(5).pl(r.dividerLeft ? 7 : 6).pr(5)
    .overflow_hidden().whitespace_nowrap().text_size(10.5).font_weight(600).text_color(CREAM)
    .bg(r.review ? "#5A1620D9" : "#0D0B1AA6");
  // Rooms of the same zone have no divider; a hairline still separates their headers.
  if (!r.dividerLeft && num(r.x, 0) > 0.5) strip.border_l(1).border_color("#FFFFFF24");
  if (r.tooltip) strip.tooltip(r.tooltip);
  strip.child(String(title));
  if (hasQuota) {
    strip.child(div().flex_none().relative().w(bw).h(3).rounded(1).bg("#FFFFFF2E")
      .child(div().absolute().left(0).top(0).h(3).w(Math.round(bw * clamp01(r.quota.have / r.quota.need))).bg(C.working)));
  }
  if (stats) strip.child(div().flex_none().text_size(9.5).font_weight(400).font_family(MONO).text_color(alpha(CREAM, 0.8)).child(stats));
  if (r.door) strip.child(svg(art("ui/boss.svg")).flex_none().w(11).h(11).text_color(C.hp));
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
  const el = div().id(c.key).absolute().left(left).top(top).w(28).h(h).cursor_pointer()
    .transition("left", { duration: 900, easing: "ease-out" })
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (c.address) run("agent.focus", { terminal: c.address });
      ctx.act("claimChest", { heroId: c.heroId });
    });
  if (c.tooltip) el.tooltip(c.tooltip);
  el.child(image(art(`fx/chest-${tier}${c.open ? "-open" : ""}.svg`)).absolute().left(0).top(0).w(28).h(h));
  return el;
}

/** What must read over the hero standing next to the chest: SHIPPED ribbon, sparkle, "×n". */
function chestMarks(c, ctx) {
  const tier = c.tier ?? "wooden";
  const h = CHEST_H[tier] ?? 22;
  const left = c.x - 14;
  const top = ctx.compact ? Math.max(1, ctx.oy + c.y - h) : ctx.oy + c.y - h;
  const out = [];
  if (!c.open && !ctx.compact) {
    out.push(image(art("fx/ribbon.svg")).absolute().left(r2(left - 6)).top(r2(top - 13)).w(40).h(10));
    const spark = svg(art("fx/starburst.svg")).absolute().left(r2(left + 23)).top(r2(top - 3)).w(9).h(9).text_color(CREAM).opacity(0.85);
    if (ctx.motion) spark.loop("opacity", { from: 0.15, to: 1, period: jitter(c.key, 1800, 53), easing: "ease-in-out" });
    out.push(spark);
  }
  if (num(c.count, 1) > 1) {
    out.push(div().absolute().left(r2(left + 18)).top(r2(top + h - 9)).h(11).px(3).rounded(5).bg(INK).border(1).border_color(alpha(CREAM, 0.35))
      .flex().items_center().text_size(8).font_family(MONO).font_weight(700).text_color(CREAM).whitespace_nowrap().child(`×${c.count}`));
  }
  return out;
}

/** Campfire: a glow that flickers (allowed in stillness, not in calm) under the fire sprite. */
function campfire(key, f, ctx) {
  const glow = div().absolute().left(r2(f.x - 16)).top(r2(ctx.oy + f.y - 12)).w(32).h(12).rounded(6).bg("#FFB34766").opacity(0.7);
  if (!ctx.calm) glow.loop("opacity", { from: 0.35, to: 0.9, period: jitter(key, 620, 29), easing: "ease-in-out" });
  return [glow, image(art("fx/campfire.svg")).absolute().left(r2(f.x - 12)).top(r2(ctx.oy + f.y - 24)).w(24).h(24)];
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
  const lift = h.crate ? 12 : 0;
  const feetY = ctx.oy + h.y - lift;
  const out = [];
  const body = renderTermling(h, ctx.env, {
    feetX: h.x, feetY,
    lunge: ctx.motion && h.attacking,
    bob: ctx.motion && !h.attacking && BOBBING.has(h.state),
    blink: !ctx.calm && h.state === "questing",
    lean: ctx.leanRig,
  }).cursor_pointer().on_click((e, cx) => {
    cx.stop_propagation();
    if (num(e?.click_count, 1) >= 2) { openOverlay(SHEET(h.heroId)); return; }
    if (h.address) run("agent.focus", { terminal: h.address });
    ctx.act("markSeen", { heroId: h.heroId });
  });
  if (h.tooltip) body.tooltip(h.tooltip);
  out.push(body);
  if (h.state === "crashed" && Number.isFinite(h.rebootFrac)) {
    out.push(div().absolute().left(r2(h.x - 14)).top(r2(feetY - 56)).w(28).h(3).rounded(1).bg("#0B0A12B3")
      .child(div().id(`${h.key}/reboot`).absolute().left(0).top(0).h(3).w(Math.round(28 * clamp01(h.rebootFrac))).bg(CREAM)
        .transition("width", { duration: 900, easing: "linear" })));
  }
  const allForks = h.forklings ?? [];
  const fks = keptForklings(allForks, num(ctx.maxForks, Infinity));
  const extra = Math.max(0, num(h.forklingExtra, 0)) + (allForks.length - fks.length);
  for (const fk of fks) {
    const el = renderForkling(fk, h, ctx.env, { feetY: ctx.oy + fk.y, bob: ctx.motion && fk.status === "working" })
      .cursor_pointer()
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (fk.address) run("agent.focus", { terminal: fk.address });
      });
    if (fk.tooltip) el.tooltip(fk.tooltip);
    out.push(el);
    if (fk.bubble) out.push(image(art("fx/bubble.svg")).absolute().left(r2(fk.x + 3)).top(r2(ctx.oy + fk.y - 36)).w(9).h(10));
  }
  if (extra > 0 && fks.length) {
    const last = fks[fks.length - 1];
    out.push(div().absolute().left(r2(last.x + 10)).top(r2(ctx.oy + last.y - 11)).w(18).h(10)
      .text_size(8).font_family(MONO).font_weight(700).text_color(alpha(CREAM, 0.85)).child(`+${extra}`));
  }
  return out;
}

/** The "!" bubble (blocked only): 18×20 art in a 32×32 hit area; bobs 3 px; click focuses. */
function bubble(h, ctx) {
  let left, top;
  if (ctx.compact) {
    const p = h.nameplate ?? { x: h.x, w: 60, y: 164 };
    left = p.x - p.w / 2 - 30;
    top = ctx.oy + p.y - 8;
  } else {
    left = h.x - 16;
    top = ctx.oy + h.y - (h.crate ? 12 : 0) - 76;
  }
  left = r2(clampX(left, 32, ctx)); top = r2(Math.max(0, top));
  const el = div().id(`${h.key}/bubble`).absolute().left(left).top(top).w(32).h(32).cursor_pointer()
    .on_click((_e, cx) => {
      cx.stop_propagation();
      if (h.address) run("agent.focus", { terminal: h.address });
    })
    .child(image(art("fx/bubble.svg")).absolute().left(7).top(6).w(18).h(20));
  if (h.bubble?.label) el.tooltip(String(h.bubble.label));
  if (!ctx.calm) el.loop("top", { from: top * ctx.z, to: (top - 3) * ctx.z, period: jitter(h.key, 1400, 31), easing: "ease-in-out" });
  return el;
}

function zzz(h, ctx) {
  const el = div().absolute().left(r2(h.x + 10)).top(r2(ctx.oy + h.y - 60)).w(26).h(12)
    .text_size(10).font_family(MONO).font_weight(700).text_color(alpha(CREAM, 0.85)).whitespace_nowrap();
  // Static in calm and in stillness (D§11.3.6 "All idle: … nothing else moves").
  return ctx.motion ? el.frames(["z", "zz", "zzz", ""], 700) : el.child("zz");
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
    out.push(div().id(`${h.key}/plate`).absolute().left(left).top(top).w(pw).h(16).rounded(4)
      .bg(alpha(INK, 0.82)).border(1).border_color(h.focused ? alpha(CREAM, 0.9) : "#FFFFFF24")
      .flex().items_center().justify_center().px(3).pb(3).truncate()
      .text_size(9.5).line_height(1).font_family(MONO).font_weight(h.focused ? 700 : 500).text_color(CREAM)
      .cursor_pointer().transition("left", { duration: 900, easing: "ease-out" })
      .on_click((_e, cx) => { cx.stop_propagation(); openOverlay(SHEET(h.heroId)); })
      .child(String(p.text ?? h.name ?? ""))
      .child(div().id(`${h.key}/hp`).absolute().left(3).top(11).h(2).rounded(1)
        .w(Math.max(0, Math.round((pw - 8) * clamp01(p.hpFrac ?? h.hpFrac)))).bg(C.hp)
        .transition("width", { duration: 400 })));
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

// ---------------------------------------------------------------------------------------------
// Boss

function boss(b, ctx) {
  const { oy } = ctx;
  const age = num(b.age, 9);
  const w = num(b.w, 112), h = num(b.h, 96);
  const out = [];
  // Sprite: hidden 40 px low at age 0, rises at age 1 (D§11.8 entrance).
  const rise = age === 0 ? 40 : 0;
  const op = age === 0 ? 0 : b.stamp ? 0.4 : b.invuln ? 0.72 : 1;
  const sprite = div().id(b.key).absolute().left(r2(b.x - w / 2)).top(r2(oy + b.y - h + rise)).w(w).h(h).opacity(op)
    .transition("top", { duration: 900, easing: "ease-out" }).transition("opacity", { duration: 600 })
    .child(image(art(b.sprite ?? `boss/${b.bossId}.svg`)).absolute().left(0).top(0).w(w).h(h));
  if (b.tooltip) sprite.tooltip(b.tooltip);
  out.push(sprite);
  for (const p of b.parts ?? []) out.push(part(b, p, ctx));
  if (!b.stamp && b.arena) out.push(bossHud(b, ctx));
  return out;
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
  const el = div().id(`${b.key}/hud`).absolute().left(left).top(top).w(hw).flex().flex_col().gap(2).child(row).child(hp);
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
    const cx = b.x, cy = ctx.oy + b.y - num(b.h, 96) / 2;
    const el = st.sprite === null
      ? div().id(st.key).absolute().border(3).border_color(C.hp).rounded(3).flex().items_center().justify_center()
        .text_size(down ? 16 : 30).font_weight(900).text_color(C.hp).whitespace_nowrap().child(String(st.text ?? ""))
      : image(art(st.sprite ?? "fx/stamp-fixed.svg")).id(st.key).absolute();
    out.push(el.left(r2(cx - sw / 2)).top(r2(cy - sh / 2)).w(sw).h(sh).opacity(down ? 1 : 0)
      .transition("left", { duration: 300, easing: "ease-in" }).transition("top", { duration: 300, easing: "ease-in" })
      .transition("width", { duration: 300, easing: "ease-in" }).transition("height", { duration: 300, easing: "ease-in" })
      .transition("opacity", { duration: 150 }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Effects (two-tick pattern, ARCHITECTURE §6.2)

const FX_CAP = 28;   // D§11.7 allows 12 numbers per tick; two ticks of them plus a few others
const FX_LAYER = { levelup: 0, pillar: 0, stamp: 1, poof: 2, coin: 3, loot: 3, coffee: 3 };

/** Newest first under the cap, then painted back to front: columns, poofs, pickups, text. */
function fxOrder(list, cap = FX_CAP) {
  const all = Array.isArray(list) ? list.slice() : [];
  const kept = all.length > cap ? all.sort((a, b) => num(a.age, 0) - num(b.age, 0)).slice(0, cap) : all;
  return kept.sort((a, b) => num(FX_LAYER[a.kind], 4) - num(FX_LAYER[b.kind], 4));
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
  const out = [];
  if (k === "crit") {
    out.push(move(svg(art("fx/starburst.svg")).id(`${f.key}/burst`).absolute().left(r2(x - tw / 2 - 11)).top(r2(y - 9)).w(18).h(18).text_color("#FFB347")));
  }
  const color = f.color ?? (k === "heal" ? "#6BE38A" : k === "incoming" ? C.hp : k === "num" ? "#FFFFFFD9" : CREAM);
  out.push(move(div().id(f.key).absolute().left(r2(x - tw / 2)).top(r2(y - th / 2)).w(tw).h(th).rounded(3)
    .bg(alpha(INK, k === "crit" ? 0.7 : 0.55)).flex().items_center().justify_center()
    .text_size(size).line_height(1).font_family(MONO).font_weight(k === "num" ? 600 : 800).text_color(color)
    .whitespace_nowrap().child(text)));
  return out;
}

/** Level-up: a cyan light column and "LEVEL UP" text (age 0..1, DESIGN §11.8). */
function levelUp(f, ctx) {
  const { oy } = ctx;
  const col = div().id(f.key).absolute().left(r2(f.x - 9)).top(r2(oy + 30)).w(18).h(GROUND - 30).rounded(9)
    .bg(alpha(C.xp, 0.55)).opacity(0.7);
  if (ctx.motion) col.loop("opacity", { from: 0.3, to: 0.9, period: 400, easing: "ease-in-out" });
  const age = num(f.age, 0);
  const label = div().id(`${f.key}/t`).absolute().left(r2(f.x - 34)).top(r2(oy + f.y - (age >= 1 ? 92 : 72))).w(68).h(12)
    .flex().justify_center().text_size(10).line_height(1).font_family(MONO).font_weight(800).text_color(C.xp)
    .whitespace_nowrap().opacity(age >= 2 ? 0 : 1)
    .transition("top", { duration: 900, easing: "ease-out" }).transition("opacity", { duration: 600 })
    .child(String(f.text ?? ""));
  return [col, label];
}

/** LTS / Keepsake light pillar: 48 px column in the rarity colour with the rarity name. */
function lootPillar(f, ctx) {
  const { oy } = ctx;
  const c = f.color ?? "#FF9A2E";
  return [
    div().id(f.key).absolute().left(r2(f.x - 24)).top(r2(oy + 20)).w(48).h(GROUND - 20).rounded(6).bg(alpha(c, 0.28))
      .opacity(num(f.age, 0) >= 3 ? 0 : 1).transition("opacity", { duration: 600 }),
    div().id(`${f.key}/t`).absolute().left(r2(f.x - 40)).top(r2(oy + 24)).w(80).h(12).flex().justify_center()
      .text_size(9.5).line_height(1).font_family(MONO).font_weight(800).text_color(c).whitespace_nowrap()
      .opacity(num(f.age, 0) >= 3 ? 0 : 1).transition("opacity", { duration: 600 }).child(String(f.text ?? "")),
  ];
}

// ---------------------------------------------------------------------------------------------
// Header band messages, overflow chip, empty states

function headerNote(n, ctx) {
  const text = String(n.text ?? "");
  const bw = Math.min(ctx.W - 16, monoW(text, 10) + 24);
  return div().id(n.key).absolute().left(r2(ctx.W / 2 - bw / 2)).top(1).w(bw).h(16).rounded(8)
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
  const dots = (o.dots ?? []).slice(0, 10);
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
