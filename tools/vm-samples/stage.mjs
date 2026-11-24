// Sample StageVMs for ui/stage.js: preview fixtures, test inputs and the spec game/view.js must
// produce (ARCHITECTURE §5 StageVM + the "VM additions" documented at the top of ui/stage.js).
//
//   import { scenarios, makeScenario, SCENARIOS } from "./tools/vm-samples/stage.mjs";
//   scenarios.midgame                         // the StageVM at its natural size
//   makeScenario("midgame", { tick: 1 })      // the next tick (fx age +1, dying mobs gone)
//   makeScenario("late", { width: 2400 })     // the same world laid out for another width
//
// CLI (screenshots of every scenario through the mock + tools/preview, deviceScaleFactor 2):
//   node --import ./tools/mock/register.mjs tools/vm-samples/stage.mjs --shoot [--only name]
//   → out/ui-stage-<scenario>.png (+ "-light" variants in herdr's paper theme)
//   node --import ./tools/mock/register.mjs tools/vm-samples/stage.mjs --views [--only kind] [--widths 1200,360]
//   → out/view-stage-<kind>.png: the real demo worlds through game/view.js stageView
//
// Layout follows D§11.2/11.3 exactly as view.js should: slot w = clamp(W / N, 150, 320) with the
// spare width split at both ends; overflow when N·150 > W (C − 1 slots + a 150 px camp chip);
// a boss fight appends a 2w arena at the right end (fighters ≥ 56 px apart, no BOSS tag inside
// it). Inside a slot of width w: hero at 0.24w (resting 0.22w with the campfire at 0.08w;
// supervising 0.16w with Forklings from 0.30w), a shipped hero's chest at ≥ 0.42w (the SHIPPED
// ribbon clear of the face), lane mobs at 0.52/0.70/0.88w (0.58/0.84w when w < 180).
// Ground line y = 160, nameplates y = 164.
// Sprites: x = centre, y = feet. Boxes: x = left edge.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZONES, BACKLOG, MOB_BY_ID, BOSS_BY_ID, BOSS_PARTS, PALETTE, ITEM_BASES, CLASS_COLORS, RARITIES } from "../../mods/mapledr/game/data.js";

const TICK0 = 51840;                 // an arbitrary "now" tick; fx keys are fx:<tick>:<n>
const COL = {
  working: "#4CC38A", blocked: "#F2A93B", done: "#FFD447", idle: "#8A8F98", hp: "#FF5A5F",
  xp: "#7FE9F5", heal: "#6BE38A", cream: "#FFF4D6", white: "#FFFFFF",
};
const PROGRAMS = {
  // title bars contrast with the icon drawn on them (claude's icon is full-colour orange)
  claude: { path: "icons/claude.svg", tint: false, color: "#D97757", bar: "#3B2A24" },
  codex: { path: "icons/codex.svg", tint: true, color: "#E6E6E6", bar: "#3A3F4B" },
  pi: { path: "icons/pi.svg", tint: true, color: "#9AD1FF", bar: "#2F5D8C" },
};
const HAT_COLORS = ["#E86F9C", "#5FB0E8", "#8FBF5A", "#E8B84A", "#C47BE8", "#F07D5C"];
const SIZE_PX = { S: 28, M: 40, L: 56 };
const ZONE_ABBR = ["LM", "CC", "RR", "MM", "DJ", "TK", "LC", "PP", "UD", "BL"];
const STATE_FACE = { questing: ">_", waiting: "o_o", shipped: "^_^", resting: "-_-", supervising: ">_", crashed: ":(" };
const STATE_INK = { questing: COL.working, waiting: COL.blocked, shipped: COL.done, resting: COL.idle, supervising: COL.working, crashed: COL.hp };
const STATE_WORD = { questing: "Questing", waiting: "Waiting for you", shipped: "Shipped", resting: "Resting", supervising: "Supervising", crashed: "Rebooting" };

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round = (n) => Math.round(n * 10) / 10;

function mix(a, b, t) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("").toUpperCase();
}
const zoneOf = (mapId) => (mapId === "backlog" ? BACKLOG : ZONES[Number(mapId.split("-")[0]) - 1]);
const mapOf = (mapId) => (mapId === "backlog" ? { id: "backlog", name: "Floor 31" } : zoneOf(mapId).maps[Number(mapId.split("-")[1]) - 1]);
const skyBands = (pal) => [0, 1, 2, 3].map((i) => mix(pal.sky, pal.far, i * 0.12));

/** D§11.3: slot width, slot lefts, and the overflow chip / boss arena boxes. */
function slotLayout(width, n, { arena = false } = {}) {
  const units = n + (arena ? 2 : 0);
  if (n * 150 + (arena ? 300 : 0) > width && !arena) {
    const C = Math.max(1, Math.floor(width / 150));
    const shown = Math.max(1, C - 1);
    const w = clamp((width - 150) / shown, 150, 320);
    const xs = Array.from({ length: shown }, (_, i) => i * w);
    return { w, xs, shown, chip: { x: shown * w, w: width - shown * w }, arena: null };
  }
  const w = clamp(width / Math.max(1, units), 150, 320);
  const used = units * w;
  const x0 = Math.max(0, (width - used) / 2);
  const xs = Array.from({ length: n }, (_, i) => x0 + i * w);
  return { w, xs, shown: n, chip: null, arena: arena ? { x: x0 + n * w, w: 2 * w } : null };
}

// ---------------------------------------------------------------------------------------------
// Builders: one "world description" → StageVM at a given width/height/tick.

/**
 * spec = { width, height, calm, nums, note, herdBanner, heroes: [HeroSpec], fx: [FxSpec],
 *          boss: BossSpec|null, frontier: {mapId, quota, sprint, door} }
 * HeroSpec = { id, name, level, cls, career, state, map, space, program, tier, hat, focused,
 *              pinned, attacking, hp, xp, fe, mobs:[MobSpec], chest:{tier,count,open}, forks:n,
 *              blockedFor:"2m", quest, crit, fight:boolean, fresh:"42m", pinMap:boolean,
 *              duck:{lane, rar, age} (a Holo Rubber Duck killed in the lane: its Duck Chest),
 *              reviewEnd:{kind:"promoted"|"postmortem", age} (a review that just ended) }
 */
function build(spec, { width, height, tick = 0 } = {}) {
  width = width ?? spec.width ?? 1200;
  height = height ?? spec.height ?? 200;
  const now = TICK0 + tick;
  const all = spec.heroes;
  // Overflow: fold idle first, then supervising, then working (lowest level first); never fold
  // blocked, done-with-chest, focused, pinned or boss participants (D§11.3.4).
  let L = slotLayout(width, all.length, { arena: Boolean(spec.boss) });
  let shownHeroes = all;
  let folded = [];
  if (L.chip) {
    const protectedH = (h) => h.state === "waiting" || (h.chest && !h.chest.open) || h.focused || h.pinned || h.fight;
    const rank = { resting: 0, supervising: 1, questing: 2, shipped: 3, crashed: 2, waiting: 9 };
    const order = all.filter((h) => !protectedH(h)).sort((a, b) => rank[a.state] - rank[b.state] || a.level - b.level);
    const fold = new Set(order.slice(0, Math.max(0, all.length - L.shown)).map((h) => h.id));
    shownHeroes = all.filter((h) => !fold.has(h.id));
    folded = all.filter((h) => fold.has(h.id));
    if (shownHeroes.length > L.shown) {
      // More protected heroes than slots: squeeze the slots below 150 px (heroes scale down).
      const sw = Math.min(320, (width - 150) / shownHeroes.length);
      L = { ...L, w: sw, shown: shownHeroes.length, xs: shownHeroes.map((_, i) => i * sw), chip: { x: shownHeroes.length * sw, w: width - shownHeroes.length * sw } };
    }
    if (!folded.length) L = { ...L, chip: null };
  }
  const w = L.w;
  const scale = w < 150 ? Math.max(0.6, Math.round((w / 150) * 100) / 100) : 1;
  const narrowLane = w < 180;
  const lanePos = narrowLane ? [0.58, 0.84] : [0.52, 0.70, 0.88];

  const heroes = [], mobs = [], chests = [], signs = [];
  shownHeroes.forEach((h, i) => {
    const sx = L.xs[i];
    const inArena = Boolean(spec.boss && h.fight);
    let hx = sx + 0.24 * w;
    let hy = 160;
    if (inArena) {
      const a = L.arena;
      const k = spec.heroes.filter((q) => q.fight).indexOf(h);
      hx = a.x + a.w * (0.07 + 0.14 * k);
      signs.push({ key: `sign:${h.id}`, x: round(sx + 0.5 * w), text: spec.boss.sign });
    } else if (h.state === "resting") hx = sx + 0.22 * w;
    else if (h.state === "supervising") hx = sx + 0.16 * w;
    const prog = PROGRAMS[h.program ?? "claude"];
    const hoodie = PALETTE.termlingTint[(h.id - 1) % PALETTE.termlingTint.length];
    const crit = h.crit && h.state === "questing";
    const first = h.name.split(" ")[0];
    const plateText = `${first} ${h.level}`;
    const pw = clamp(plateText.length * 5.7 + 14, 44, w - 12);
    const map = mapOf(h.map);
    const zone = zoneOf(h.map);
    const tag = h.state === "waiting" && h.blockedFor ? { text: `! ${h.blockedFor}`, color: COL.blocked }
      : inArena ? null // the arena itself says BOSS (stage review)
        : h.fresh ? { text: `Fresh Eyes ${h.fresh}`, color: "#A9B8FF" }
          : h.state === "crashed" ? { text: "rebooting", color: COL.idle }
            : null;
    const forklings = [];
    for (let f = 0; f < Math.min(3, h.forks ?? 0); f++) {
      forklings.push({
        key: `fork:t${h.id}.${f + 1}`, address: `t${h.id}.${f + 1}`, x: round(sx + 0.3 * w + f * Math.max(14, 0.07 * w)), y: 160,
        face: f === 2 && h.forkBlocked ? "o_o" : ">_", status: f === 2 && h.forkBlocked ? "blocked" : "working",
        bubble: Boolean(f === 2 && h.forkBlocked), tooltip: ["sub-agent: run the test suite", "sub-agent: grep call sites", "sub-agent: draft the migration"][f],
      });
    }
    const tier = h.tier ?? 1;
    heroes.push({
      key: `hero:${h.id}`, heroId: h.id, address: `t${h.id}`, x: round(hx), y: hy, scale,
      name: h.name, level: h.level, careerTitle: h.career, clsId: h.cls,
      face: crit ? ">_<" : STATE_FACE[h.state], state: h.state, focused: Boolean(h.focused), pinned: Boolean(h.pinned),
      attacking: Boolean(h.attacking && (h.state === "questing")), opacity: h.state === "supervising" || h.state === "crashed" ? 0.6 : 1,
      hpFrac: h.hp ?? 1, xpFrac: h.xp ?? 0.4, feFrac: h.fe ?? 0,
      colors: { hoodie, titleBar: prog.bar, screen: "#17161F", faceInk: STATE_INK[h.state] },
      programIcon: { path: prog.path, tint: prog.tint, color: prog.color },
      weapon: { clsId: h.cls, color: ITEM_BASES.weaponTierTones[tier - 1], edge: tier === 5 },
      hat: h.hat ? { tier: h.hat, color: HAT_COLORS[(h.id + h.hat) % HAT_COLORS.length] } : null,
      accessory: h.cls,
      bubble: h.state === "waiting" ? { label: `Waiting for you · ${h.blockedFor ?? "now"} · click to jump there` } : null,
      zzz: h.state === "resting" && Boolean(h.zzz),
      campfire: h.state === "resting" ? { x: round(sx + 0.08 * w), y: 160 } : null,
      crate: h.state === "waiting",
      tag, forklings, forklingExtra: Math.max(0, (h.forks ?? 0) - 3),
      tooltip: `${h.name} · Lv ${h.level} ${h.career}\nHP ${Math.round((h.hp ?? 1) * 100)}% · XP ${Math.round((h.xp ?? 0.4) * 100)}% · ${h.map} ${map.name}\n${STATE_WORD[h.state]} ${h.since ?? "4m"}${h.quest ? ` · ${h.quest}` : ""}`,
      nameplate: { x: round(hx), y: 164, w: Math.round(pw), text: plateText, hpFrac: h.hp ?? 1 },
      slot: { x: round(sx), w: round(w) },
      rebootFrac: h.state === "crashed" ? (h.reboot ?? 0.4) : null,
      // a review that ended ≤ 3 ticks ago: the Promotion banner or the Postmortem card (D§11.8)
      reviewEnd: h.reviewEnd && !inArena && (h.reviewEnd.age ?? 0) + tick <= 3 ? {
        key: `fight:${TICK0 - 300}:review:${h.id}:end`, kind: h.reviewEnd.kind, age: (h.reviewEnd.age ?? 0) + tick,
        text: h.reviewEnd.kind === "promoted" ? "PROMOTED" : "Postmortem · retry in 10 working min",
        sub: h.reviewEnd.kind === "promoted" ? h.career : "38% wounds kept · Lessons Learned +10%",
      } : null,
    });
    // A Holo Rubber Duck killed in this lane: its Duck Chest pops where it stood (closed at age 0,
    // lid open at age 1), a picture only (the item is already given).
    if (h.duck && (h.duck.age ?? 0) + tick <= 1) {
      const lp = lanePos[Math.min(h.duck.lane ?? 0, lanePos.length - 1)];
      chests.push({
        key: `chest:duck:fx:${TICK0 - (h.duck.age ?? 0)}:d${h.id}`, heroId: h.id, address: `t${h.id}`, x: round(sx + lp * w), y: 160,
        tier: "duck", count: 1, open: (h.duck.age ?? 0) + tick > 0,
        tooltip: `Duck Chest from a Holo Rubber Duck · ${RARITIES[h.duck.rar ?? 3].name} item · 10× gold · Snippets`,
      });
    }
    // Lane mobs (questing / supervising / waiting heroes keep their lane; resting/shipped don't).
    if (!inArena && (h.mobs ?? []).length) {
      h.mobs.slice(0, lanePos.length).forEach((m, j) => {
        if (m.dyingAt != null && tick > m.dyingAt) return; // gone after its poof tick
        const def = MOB_BY_ID[m.id];
        const working = h.state === "questing" || h.state === "supervising";
        mobs.push({
          key: `mob:${h.id}${String(j + 1).padStart(2, "0")}${m.uid ?? ""}`, mobId: m.id, name: def.name,
          x: round(sx + lanePos[j] * w + (m.dx ?? 0)), y: 160, size: def.size, px: SIZE_PX[def.size],
          sprite: `mob/${m.id}.svg`, glyph: null, glyphColor: COL.cream,
          elite: Boolean(m.elite), holo: m.id === "holo_duck", hpFrac: m.hp ?? 1,
          showHp: j === 0 && working, engaged: j === 0 && working && h.attacking !== false,
          pacing: j > 0 && working && !spec.calm, paceAmp: 12, opacity: 1,
          phaser: (def.traits ?? []).includes("phaser"), pending: Boolean(m.pending),
          growScale: m.grow ?? 1, dying: m.dyingAt != null && tick === m.dyingAt, hit: Boolean(m.hit && tick === 0),
          waiting: h.state === "waiting",
        });
      });
    }
    if (h.chest) {
      chests.push({
        key: `chest:${h.id}`, heroId: h.id, address: `t${h.id}`, x: round(Math.max(sx + 0.42 * w, hx + 34)), y: 160,
        tier: h.chest.tier, count: h.chest.count ?? 1, open: Boolean(h.chest.open),
        tooltip: `Shipped: ${h.quest ?? "a task"} · ${h.chest.seals ?? "2.4"} Seals · ${h.chest.tier[0].toUpperCase()}${h.chest.tier.slice(1)} chest\nClick to open it`,
      });
    }
  });

  // Rooms: adjacent slots of the same space in the same map merge; zone changes get a divider.
  const rooms = [];
  shownHeroes.forEach((h, i) => {
    const sx = L.xs[i];
    const last = rooms[rooms.length - 1];
    if (last && last._space === h.space && last.mapId === h.map && Math.abs(last.x + last.w - sx) < 0.5) {
      last.w += w; last._heroes.push(h); return;
    }
    rooms.push({ _space: h.space, _heroes: [h], x: sx, w, mapId: h.map });
  });
  if (L.arena) rooms.push({ _space: "arena", _heroes: spec.heroes.filter((h) => h.fight), x: L.arena.x, w: L.arena.w, mapId: spec.boss.map, _arena: true });
  const fr = spec.frontier ?? {};
  let prevZone = null;
  const roomVMs = rooms.map((r) => {
    const zone = zoneOf(r.mapId);
    const map = mapOf(r.mapId);
    const pal = { sky: zone.palette.sky, far: zone.palette.far, ground: zone.palette.ground, accent: zone.palette.accent };
    const frontier = fr.mapId === r.mapId && !r._arena;
    const quota = frontier && fr.quota ? { have: fr.quota[0], need: fr.quota[1] } : null;
    const sprint = frontier && fr.sprint ? { have: fr.sprint[0], need: fr.sprint[1] } : null;
    const working = r._heroes.some((h) => h.state === "questing" || h.state === "supervising");
    const stats = [quota ? `${quota.have}/${quota.need}` : null, sprint ? `Sprint ${sprint.have}/${sprint.need}` : null].filter(Boolean).join(" · ");
    const props = [];
    const pk = (k) => `bg/${zone.id}-prop-${k}.svg`;
    const propSize = PROP_SIZES[zone.id] ?? [[16, 40], [24, 16], [24, 32]];
    const slots = Math.max(1, Math.round(r.w / w));
    for (let s = 0; s < Math.min(3, slots + 1); s++) {
      const k = (s % 3) + 1;
      const [pw2, ph] = propSize[k - 1];
      const px = s === 0 ? r.x + 10 + pw2 / 2 : r.x + s * w - 8;
      props.push({ key: `${r.mapId}:p${s}`, sprite: pk(k), x: round(px), y: 160, w: pw2, h: ph });
    }
    const vm = {
      key: r._arena ? `room:arena:${spec.boss.id}` : `room:${r._space}/${r.mapId}/${r._heroes[0].id}`,
      x: round(r.x), w: round(r.w), zone: zone.id, mapId: r.mapId,
      title: r._arena ? `${zone.name} · ${BOSS_BY_ID[spec.boss.id].name}` : r.mapId === "backlog" ? `The Backlog · ${map.name}` : `${r.mapId} ${map.name}`,
      shortTitle: r._arena ? "BOSS" : r.mapId === "backlog" ? "BL F31" : `${ZONE_ABBR[zone.n]} ${r.mapId}`,
      palette: pal, skyBands: skyBands(pal), quota, sprint, door: Boolean(frontier && fr.door),
      working, dusk: !working && r._heroes.every((h) => h.state === "resting" || h.state === "shipped"),
      review: false, dividerLeft: prevZone !== null && prevZone !== zone.id, props,
      tooltip: `${zone.name} · ${r.mapId === "backlog" ? map.name : `${r.mapId} ${map.name}`} (Lv ${zone.levels ? `${map.levels?.[0] ?? zone.levels[0]}–${map.levels?.[1] ?? zone.levels[1]}` : "100+"})` +
        (quota ? `\nQuota ${quota.have}/${quota.need} kills to open the next map` : "") + (sprint ? `\nSprint ${sprint.have}/${sprint.need} toward the boss door` : ""),
      // D§11.16 header click: pin the room's heroes here (unpin when all already are); the door
      // icon challenges the zone's boss, only while no boss fight is on (the engine refuses one)
      pin: r._arena ? null : { heroIds: r._heroes.map((h) => h.id), mapId: r._heroes.every((h) => h.pinMap) ? null : r.mapId },
      challenge: !r._arena && frontier && fr.door && !spec.boss ? { kind: "boss", idx: zone.n ?? 0, tooltip: `${zone.name} boss: the boss door is open\nClick to challenge` } : null,
    };
    if (stats) vm.stats = stats; // optional: absent (not undefined) when there is nothing to count
    prevZone = zone.id;
    return vm;
  });

  // Fx: born at tick b → age = tick − b. Two-tick kinds vanish at age 2; multi-tick stay ≤ 2.
  const TWO = new Set(["num", "crit", "heal", "miss", "inv", "abs", "incoming", "poof", "coin", "loot", "skill", "coffee", "unblocked", "ship"]);
  const fx = [];
  (spec.fx ?? []).forEach((f, n) => {
    const age = tick - (f.born ?? 0);
    if (age < 0 || (TWO.has(f.kind) && age >= 2) || age > 2) return;
    const owner = heroes.find((h) => h.heroId === f.hero);
    if (!owner) return;
    const ownerMob = mobs.find((m) => m.key.startsWith(`mob:${f.hero}`));
    const mobTop = ownerMob ? 160 - Math.round(ownerMob.px * (ownerMob.elite ? 1.25 : 1) * ownerMob.growScale) : 0;
    const base = f.at === "mob" && ownerMob ? { x: ownerMob.x, y: mobTop - (ownerMob.showHp ? 16 : 9) } : { x: owner.x, y: 160 - 58 };
    const vm = {
      key: `fx:${TICK0 + (f.born ?? 0)}:${n}`, kind: f.kind, x: round(base.x + (f.ox ?? 0)), y: round(base.y + (f.oy ?? 0)),
      text: f.text ?? "", color: f.color ?? null, age, dx: f.dx ?? 0, dy: f.dy ?? -28, size: f.size ?? null,
    };
    // a loot pillar opens the finder's sheet on that item (D§11.16)
    if (f.kind === "pillar") vm.sheet = { heroId: f.hero, itemUid: 9000 + n };
    fx.push(vm);
  });

  let boss = null;
  if (spec.boss) {
    const b = spec.boss;
    const a = L.arena;
    const def = BOSS_BY_ID[b.id];
    const age = (b.age ?? 0) + tick;
    const bx = a.x + a.w * 0.7, by = 160;
    const labels = BOSS_PARTS[b.id] ?? [];
    // Parts hug the boss: half on each side, stepping out and up (view.js owns this layout).
    const half = Math.ceil((b.parts ?? []).length / 2);
    const parts = (b.parts ?? []).map((p, i) => {
      const side = i < half ? -1 : 1;
      const k = i < half ? i : i - half;
      return {
        key: `boss:${b.id}/part:${i}`, label: labels[i] ?? `part ${i + 1}`, hpFrac: p,
        x: round(bx + side * (64 + 12 * k)), y: round(by - 4 - 9 * k), active: p > 0,
      };
    });
    boss = {
      key: `boss:${b.id}`, bossId: b.id, name: def.name, x: round(bx), y: by, w: 112, h: 96, sprite: `boss/${b.id}.svg`,
      hpFrac: b.hp, segments: b.segments ?? 10, mechText: b.mech ?? null, phaseLabel: b.phase ?? null,
      timerFrac: b.timer, enraged: Boolean(b.enraged), invuln: Boolean(b.invuln), parts,
      partSprite: labels.length && b.id !== "pyramid_of_doom" ? `boss/${b.id}-part.svg` : null,
      banner: b.banner && age <= 3 ? { key: `banner:${b.id}:${TICK0 - (b.age ?? 0)}`, text: def.name, sub: def.flavor, age, kind: "entrance" } : null,
      stamp: b.stamp ? { key: `stamp:${b.id}`, text: "FIXED", age: (b.stampAge ?? 0) + tick, sprite: "fx/stamp-fixed.svg" } : null,
      arena: { x: round(a.x), w: round(a.w) }, age,
      tooltip: `${def.name} · Lv ${def.level}\n${b.tip ?? "Shield of 8 branches: break 5 to expose the body"}\nWin estimate: ${b.estimate ?? "Even (1.08)"}` +
        (b.stamp ? "" : "\nClick twice to retreat (a Postmortem: Wounds and Lessons are kept)"),
      // D§11.16 Retreat: the first click arms, the second runs it (null once the fight is over)
      retreat: b.stamp ? null : { confirm: "Retreat? Click again", args: {} },
    };
  }

  const anyQuesting = shownHeroes.some((h) => h.state === "questing" || h.state === "supervising");
  return {
    tick: now, width, height, calm: Boolean(spec.calm), nums: spec.nums ?? "all", stillness: !anyQuesting,
    empty: null,
    headerNote: spec.note && tick === 0 ? { key: `note:${TICK0}`, text: spec.note[0], color: spec.note[1] ?? COL.cream } : null,
    herdBanner: spec.herdBanner ? { key: `herd:${TICK0}`, text: spec.herdBanner } : null,
    rooms: roomVMs, heroes, mobs, chests, boss, fx, signs,
    overflow: L.chip ? {
      key: "overflow", x: round(L.chip.x), w: round(L.chip.w), count: folded.length,
      dots: folded.map((h) => ({ questing: COL.working, supervising: COL.working, resting: COL.idle, shipped: COL.done, crashed: COL.hp, waiting: COL.blocked })[h.state]),
      tooltip: `At camp (${folded.length}):\n` + folded.map((h) => `${h.name} · Lv ${h.level} · ${STATE_WORD[h.state].toLowerCase()}`).join("\n"),
    } : null,
  };
}

// prop art sizes (viewBox) per zone: [prop-1, prop-2, prop-3]
const PROP_SIZES = {};
const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "mods", "mapledr", "art", "bg");
for (const z of [...ZONES.map((z) => z.id), "backlog"]) {
  PROP_SIZES[z] = [1, 2, 3].map((k) => {
    try {
      const m = /viewBox="0 0 (\d+) (\d+)"/.exec(fs.readFileSync(path.join(ART, `${z}-prop-${k}.svg`), "utf8"));
      return m ? [Number(m[1]), Number(m[2])] : [16, 32];
    } catch { return [16, 32]; }
  });
}

// ---------------------------------------------------------------------------------------------
// The worlds

const kip = (o = {}) => ({ id: 1, name: "Kip the Idempotent", level: 14, cls: "refactorer", career: "Junior Refactorer", program: "claude", space: "s1", tier: 2, hat: 2, ...o });

const SPECS = {
  "first-day": {
    width: 1200,
    note: ["New hire: Nib Two-Spaces", COL.cream],
    frontier: { mapId: "1-1", quota: [12, 40] },
    heroes: [
      { id: 1, name: "Kip the Idempotent", level: 3, cls: "intern", career: "Intern", program: "claude", space: "s1", map: "1-1", state: "questing", attacking: true, focused: true, hp: 0.86, xp: 0.62, tier: 1, quest: "add a README badge",
        mobs: [{ id: "typo_sprout", hp: 0.45, hit: true }, { id: "typo_sprout" }, { id: "typo_sprout" }] },
      { id: 2, name: "Nib Two-Spaces", level: 1, cls: "intern", career: "Intern", program: "codex", space: "s1", map: "1-1", state: "questing", attacking: true, hp: 1, xp: 0.05, tier: 1, quest: "rename the config loader",
        mobs: [{ id: "typo_sprout", hp: 0.8 }, { id: "typo_sprout" }], duck: { lane: 2, rar: 2, age: 0 } },
    ],
    fx: [
      { hero: 1, kind: "num", at: "mob", text: "7", born: 0, dx: 4 },
      { hero: 1, kind: "num", at: "mob", text: "6", born: -1, ox: -6, dx: 3 },
      { hero: 2, kind: "num", at: "mob", text: "5", born: 0, dx: -3 },
      { hero: 1, kind: "coin", at: "mob", born: 0, ox: 10, oy: 30, dx: -60, dy: 10 },
    ],
  },
  midgame: {
    width: 1200,
    frontier: { mapId: "2-3", quota: [31, 40], sprint: [4, 10], door: true },
    heroes: [
      { id: 5, name: "Juno of Small Commits", level: 11, cls: "shellmancer", career: "Junior Shellmancer", program: "pi", space: "s1", map: "1-3", state: "resting", hp: 1, xp: 0.35, fe: 0.2, fresh: "42m", zzz: true, tier: 1, hat: 1 },
      { id: 6, name: "Pax the Cached", level: 13, cls: "forkbinder", career: "Junior Forkbinder", program: "claude", space: "s1", map: "1-3", state: "supervising", hp: 0.9, xp: 0.5, forks: 4, forkBlocked: true, tier: 2,
        mobs: [{ id: "unused_import", hp: 0.6 }, { id: "semicolon_snail" }, { id: "unused_import" }], quest: "migrate the test runner" },
      kip({ map: "2-2", state: "questing", attacking: true, focused: true, hp: 0.72, xp: 0.91, quest: "fix flaky auth test", crit: true,
        mobs: [{ id: "promise_wisp", hp: 0.3, hit: true, dyingAt: 0 }, { id: "promise_wisp", pending: true }, { id: "callback_bat", elite: true }] }),
      { id: 2, name: "Rue Two-Spaces", level: 15, cls: "rubberducker", career: "Junior Rubberducker", program: "codex", space: "s1", map: "2-2", state: "waiting", blockedFor: "2m", hp: 0.95, xp: 0.2, tier: 2, hat: 3,
        mobs: [{ id: "promise_wisp", hp: 0.8 }, { id: "callback_bat" }], quest: "should I bump the lockfile?" },
      { id: 3, name: "Ada Null-Safe", level: 17, cls: "hotfixer", career: "Junior Hotfixer", program: "claude", space: "s2", map: "2-3", state: "shipped", hp: 1, xp: 0.66, tier: 3, hat: 4,
        chest: { tier: "silver", count: 2, seals: "3.6" }, quest: "patch the session cookie" },
      { id: 4, name: "Moss the Rebased", level: 16, cls: "refactorer", career: "Junior Refactorer", program: "pi", space: "s2", map: "2-3", state: "crashed", hp: 0, xp: 0.4, reboot: 0.6, tier: 2,
        mobs: [{ id: "null_pointer_frog", hp: 0.55 }, { id: "promise_wisp" }] },
    ],
    fx: [
      { hero: 1, kind: "crit", at: "mob", text: "212", born: 0, dx: 6, oy: -4 },
      { hero: 1, kind: "num", at: "mob", text: "88", born: -1, ox: 8, dx: 4 },
      { hero: 1, kind: "poof", at: "mob", born: 0, dy: -10 },
      { hero: 1, kind: "levelup", text: "LEVEL UP", born: 0 },
      { hero: 1, kind: "incoming", text: "31", born: 0, ox: 4, oy: 14, dx: -10, dy: 18 },
      { hero: 6, kind: "skill", text: "Spawn Worker", born: 0, oy: -14, color: CLASS_COLORS.forkbinder },
      { hero: 6, kind: "num", at: "mob", text: "64", born: 0, dx: 3 },
      { hero: 6, kind: "miss", at: "mob", text: "404", born: -1, ox: -10, dx: -3 },
      { hero: 3, kind: "loot", born: 0, ox: 34, oy: 40, color: RARITIES[2].color, dx: -30, dy: 20 },
      { hero: 4, kind: "inv", at: "mob", text: "403", born: 0 },
    ],
  },
  boss: {
    width: 1200,
    frontier: { mapId: "4-3", quota: [40, 40], sprint: [45, 45], door: true },
    boss: { id: "octopus_merge", map: "4-3", age: 1, banner: true, hp: 0.82, timer: 0.93, segments: 8, mech: "Merging… 6 branches left", phase: "shielded",
      parts: [1, 0.7, 0, 1, 0.4, 0, 1, 0.9], pct: 18, sign: "→ The Octopus Merge 18%", invuln: true },
    heroes: [
      { id: 11, name: "Tess the Linted", level: 46, cls: "refactorer", career: "Senior Refactorer", program: "claude", space: "s1", map: "4-3", state: "questing", attacking: true, fight: true, hp: 0.8, tier: 3, hat: 4, focused: true },
      { id: 12, name: "Ori Fast-Forward", level: 44, cls: "shellmancer", career: "Senior Shellmancer", program: "codex", space: "s1", map: "4-3", state: "questing", attacking: true, fight: true, hp: 0.64, tier: 3, hat: 3 },
      { id: 13, name: "Lumi the Patient", level: 45, cls: "rubberducker", career: "Senior Rubberducker", program: "pi", space: "s1", map: "4-3", state: "questing", attacking: true, fight: true, hp: 0.92, tier: 3, hat: 2 },
      { id: 14, name: "Brin of Clean Diffs", level: 41, cls: "hotfixer", career: "Senior Hotfixer", program: "claude", space: "s2", map: "4-2", state: "questing", attacking: true, hp: 0.77, tier: 3,
        mobs: [{ id: "rebase_wraith", hp: 0.5, hit: true }, { id: "diff_leech" }, { id: "rebase_wraith" }] },
    ],
    fx: [
      { hero: 11, kind: "num", text: "1.4k", born: 0, ox: 150, oy: -10, dx: 5 },
      { hero: 12, kind: "abs", text: "409", born: 0, ox: 140, oy: 10 },
      { hero: 13, kind: "heal", text: "+220", born: 0, oy: -8, color: COL.heal },
      { hero: 14, kind: "num", at: "mob", text: "640", born: 0, dx: 4 },
    ],
  },
  "boss-enraged": {
    width: 1200,
    frontier: { mapId: "2-3", quota: [40, 40], sprint: [10, 10], door: true },
    boss: { id: "pyramid_of_doom", map: "2-3", age: 150, hp: 0.21, timer: 0.14, segments: 3, enraged: true, mech: "Layer 3 of 3 · resolve() in 4", phase: "ENRAGED",
      pct: 79, sign: "→ The Pyramid of Doom 79%", tip: "Three brace layers; each break summons Callback Bats" },
    heroes: [
      { id: 21, name: "Dex Zero-Indexed", level: 23, cls: "hotfixer", career: "Junior Hotfixer", program: "claude", space: "s1", map: "2-3", state: "questing", attacking: true, fight: true, hp: 0.35, tier: 2, hat: 2 },
      { id: 22, name: "Cleo the Typed", level: 22, cls: "shellmancer", career: "Junior Shellmancer", program: "codex", space: "s1", map: "2-3", state: "waiting", blockedFor: "now", fight: true, hp: 0.6, tier: 2 },
      { id: 23, name: "Gus the Pure", level: 24, cls: "refactorer", career: "Junior Refactorer", program: "pi", space: "s1", map: "2-3", state: "questing", attacking: true, fight: true, hp: 0.12, tier: 2, hat: 1 },
    ],
    fx: [
      { hero: 21, kind: "crit", text: "2.1k", born: 0, ox: 230, oy: 0, dx: 6 },
      { hero: 23, kind: "incoming", text: "180", born: 0, ox: 4, oy: 18, dx: -10, dy: 18 },
    ],
  },
  "boss-won": {
    width: 1200,
    herdBanner: "The herd reached frame #2 · Callback Caverns",
    frontier: { mapId: "1-3", quota: [40, 40], sprint: [6, 6], door: false },
    boss: { id: "ignored_warning", map: "1-3", age: 61, hp: 0, timer: 0.4, segments: 10, stamp: true, stampAge: 1, pct: 100, sign: "→ The Ignored Warning ✓" },
    heroes: [
      { id: 31, name: "Hana the Unflaky", level: 12, cls: "shellmancer", career: "Junior Shellmancer", program: "claude", space: "s1", map: "1-3", state: "questing", fight: true, hp: 0.55, tier: 1, hat: 1, focused: true },
      { id: 32, name: "Ilo the Annotated", level: 11, cls: "intern", career: "Intern", program: "pi", space: "s1", map: "1-3", state: "questing", fight: true, hp: 0.8, tier: 1 },
    ],
    fx: [
      { hero: 31, kind: "pillar", text: "Keepsake", color: RARITIES[5].color, born: -1, ox: 200 },
      { hero: 32, kind: "loot", born: 0, ox: 200, oy: 60, color: RARITIES[4].color, dx: -150, dy: 30 },
      { hero: 31, kind: "coin", born: 0, ox: 220, oy: 70, dx: -170, dy: 20 },
    ],
  },
  late: {
    width: 1200,
    frontier: { mapId: "backlog" },
    heroes: [
      ...[
        ["Wren the Vectorized", 99, "hotfixer", "Principal Hotfixer", "backlog", "questing"],
        ["Sable Kernel-Kissed", 97, "shellmancer", "Staff Shellmancer", "backlog", "questing"],
        ["Rook the Graceful", 92, "refactorer", "Principal Refactorer", "9-2", "waiting"],
        ["Vela the Stateless", 90, "forkbinder", "Principal Forkbinder", "9-2", "supervising"],
        ["Otto Lint-Free", 88, "rubberducker", "Staff Rubberducker", "8-3", "shipped"],
        ["Mae the Bisected", 86, "hotfixer", "Staff Hotfixer", "8-3", "questing"],
        ["Zed of Good Defaults", 84, "shellmancer", "Staff Shellmancer", "8-2", "resting"],
        ["Fen the Readable", 83, "refactorer", "Staff Refactorer", "8-2", "questing"],
        ["Quin the Compiled", 81, "rubberducker", "Staff Rubberducker", "8-1", "resting"],
        ["Ivo the Tested", 80, "forkbinder", "Staff Forkbinder", "8-1", "supervising"],
        ["Elm the Minimal", 79, "rubberducker", "Staff Rubberducker", "8-1", "questing"],
        ["Hux the Portable", 78, "hotfixer", "Staff Hotfixer", "8-1", "resting"],
        ["Nox of the Last Mile", 78, "shellmancer", "Staff Shellmancer", "8-1", "questing"],
        ["Pim Once-Deployed", 77, "refactorer", "Staff Refactorer", "8-1", "resting"],
      ].map(([name, level, cls, career, map, state], i) => {
        const id = 41 + i;
        const mm = map === "backlog" ? ["warning_mite", "nitpick", "holo_duck"] : Object.keys(mapOf(map).spawn);
        const lane = state === "questing" || state === "supervising" || state === "waiting"
          ? [{ id: mm[0], hp: 0.5 + (i % 3) * 0.15, hit: i % 2 === 0, elite: i === 7 }, { id: mm[1] ?? mm[0] }, { id: mm[2] ?? mm[0], grow: i === 5 ? 1.3 : 1 }] : [];
        return {
          id, name, level, cls, career, program: ["claude", "codex", "pi"][i % 3], space: i < 4 ? "s1" : "s2",
          map, state, attacking: state === "questing", hp: 0.6 + (i % 4) * 0.1, xp: (i * 0.13) % 1, tier: i < 3 ? 5 : 4, hat: i < 3 ? 5 : 4,
          blockedFor: state === "waiting" ? "12m" : undefined, chest: state === "shipped" ? { tier: "gold", seals: "7.2" } : null,
          forks: state === "supervising" ? 2 : 0, focused: i === 1, mobs: lane, zzz: state === "resting" && i % 2 === 0,
        };
      }),
    ],
    fx: [
      { hero: 41, kind: "crit", at: "mob", text: "48.2k", born: 0, dx: 6 },
      { hero: 42, kind: "num", at: "mob", text: "21.7k", born: 0, dx: 4 },
      { hero: 42, kind: "num", at: "mob", text: "19.9k", born: -1, ox: 6, dx: 4 },
      { hero: 46, kind: "num", at: "mob", text: "×3 31k", born: 0, dx: 4 },
      { hero: 41, kind: "pillar", text: "LTS", color: RARITIES[4].color, born: 0, ox: 40 },
    ],
  },
};
SPECS["late-wide"] = { ...SPECS.late, width: 2400, heroes: SPECS.late.heroes.slice(0, 12) };
// Stress: the most heroes a 2400 px stage shows (16 slots of 150 px), all fighting, with a full
// effects budget (12 numbers this tick + 12 fading from the last). Scenery thins out to fit.
SPECS.crowd = {
  width: 2400,
  frontier: { mapId: "6-2", quota: [18, 40], door: false },
  heroes: Array.from({ length: 16 }, (_, i) => {
    const map = ["5-3", "6-1", "6-2", "6-2"][i % 4];
    const mm = Object.keys(mapOf(map).spawn);
    return {
      id: 61 + i, name: `${["Alba", "Bix", "Cove", "Dot", "Elm", "Fizz", "Glen", "Hux", "Ines", "Jove", "Kit", "Lyle", "Mae", "Nox", "Oona", "Perl"][i]} the Async`,
      level: 52 + i, cls: ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"][i % 5], career: "Senior Shellmancer",
      program: ["claude", "codex", "pi"][i % 3], space: `s${1 + (i >> 2)}`, map, state: i === 5 ? "waiting" : "questing", attacking: i !== 5,
      blockedFor: i === 5 ? "3m" : undefined, hp: 0.5 + (i % 5) * 0.1, tier: 4, hat: 1 + (i % 5), focused: i === 2,
      mobs: [{ id: mm[0], hp: 0.4 + (i % 3) * 0.2, hit: true, elite: i % 7 === 0 }, { id: mm[1] ?? mm[0] }],
    };
  }),
  fx: Array.from({ length: 24 }, (_, i) => ({ hero: 61 + (i % 16), kind: i % 6 === 0 ? "crit" : "num", at: "mob", text: String(800 + i * 37), born: i < 12 ? 0 : -1, dx: 4 })),
};
SPECS.calm = { ...SPECS.midgame, calm: true };
SPECS["all-idle"] = {
  width: 1200,
  frontier: { mapId: "2-3", quota: [31, 40], sprint: [4, 10], door: true },
  heroes: SPECS.midgame.heroes.map((h) => ({
    ...h, state: h.id === 3 || h.id === 2 ? "shipped" : "resting", attacking: false, forks: 0, mobs: [], zzz: h.id % 2 === 0, fresh: h.id === 2 ? "1h 10m" : h.fresh,
    hp: 1, chest: h.id === 3 ? { tier: "gold", seals: "6.1" } : h.id === 2 ? { tier: "iron", seals: "1.0" } : null,
  })),
  fx: [],
};
SPECS.narrow = {
  width: 360,
  frontier: { mapId: "2-2", quota: [12, 40] },
  heroes: [
    kip({ map: "2-2", state: "questing", attacking: true, focused: true, hp: 0.72, quest: "fix flaky auth test",
      mobs: [{ id: "promise_wisp", hp: 0.4, hit: true }, { id: "callback_bat" }] }),
    { id: 2, name: "Rue Two-Spaces", level: 15, cls: "rubberducker", career: "Junior Rubberducker", program: "codex", space: "s1", map: "2-2", state: "waiting", blockedFor: "5m", tier: 2, hat: 3, mobs: [{ id: "callback_bat" }] },
  ],
  fx: [{ hero: 1, kind: "num", at: "mob", text: "88", born: 0, dx: 4 }],
};
// A review just ended in two slots (D§11.8): a Promotion banner with confetti and a Postmortem
// card; the third hero's room is pinned (its header click unpins).
const marsh = (map) => Object.keys(mapOf(map).spawn);
SPECS.promoted = {
  width: 1200,
  note: ["PROMOTED: Senior Shellmancer", COL.xp],
  frontier: { mapId: "4-2", quota: [22, 40] },
  heroes: [
    { id: 71, name: "Sol the Benchmarked", level: 30, cls: "shellmancer", career: "Senior Shellmancer", program: "claude", space: "s1", map: "4-1", state: "questing", attacking: true, hp: 1, xp: 0.02, tier: 3, hat: 2,
      reviewEnd: { kind: "promoted", age: 1 }, mobs: [{ id: marsh("4-1")[0], hp: 0.7 }, { id: marsh("4-1")[1] ?? marsh("4-1")[0] }] },
    { id: 72, name: "Ines of Gentle Reviews", level: 31, cls: "hotfixer", career: "Junior Hotfixer", program: "codex", space: "s1", map: "4-1", state: "questing", attacking: true, hp: 0.45, xp: 0.3, tier: 3,
      reviewEnd: { kind: "postmortem", age: 1 }, mobs: [{ id: marsh("4-1")[0], hp: 0.9 }] },
    { id: 73, name: "Ivo of Small Commits", level: 33, cls: "refactorer", career: "Senior Refactorer", program: "pi", space: "s2", map: "4-2", state: "questing", attacking: true, hp: 0.8, xp: 0.5, tier: 3, hat: 3, pinMap: true,
      mobs: [{ id: marsh("4-2")[0], hp: 0.5, hit: true }, { id: marsh("4-2")[1] ?? marsh("4-2")[0] }] },
  ],
  fx: [{ hero: 73, kind: "num", at: "mob", text: "612", born: 0, dx: 4 }],
};
SPECS.compact = { ...SPECS.midgame, height: 64 };
SPECS.tall = { ...SPECS.midgame, height: 320 };

const EMPTY = {
  empty: { width: 1200, empty: { kind: "no_agents", title: "Help wanted", text: "Start an agent to hire a hero. Every coding agent becomes a Termling here." } },
  loading: { width: 1200, empty: { kind: "loading", title: "Loading the stack…", text: "" } },
};

/** Every scenario name, in preview order. */
export const SCENARIOS = ["empty", "loading", "first-day", "midgame", "boss", "boss-enraged", "boss-won", "late", "late-wide", "crowd", "calm", "all-idle", "narrow", "promoted", "compact", "tall"];

/** Build one scenario's StageVM. opts: { width, height, tick } (tick 1 = the next tick). */
export function makeScenario(name, opts = {}) {
  if (EMPTY[name]) {
    const e = EMPTY[name];
    return {
      tick: TICK0 + (opts.tick ?? 0), width: opts.width ?? e.width, height: opts.height ?? 200, calm: false, nums: "all",
      stillness: true, empty: { ...e.empty }, headerNote: null, herdBanner: null, rooms: [], heroes: [], mobs: [],
      chests: [], boss: null, fx: [], signs: [], overflow: null,
    };
  }
  const spec = SPECS[name];
  if (!spec) throw new Error(`unknown stage scenario "${name}"`);
  return build(spec, opts);
}

/** { name: StageVM } at each scenario's natural size, tick 0. */
export const scenarios = Object.fromEntries(SCENARIOS.map((n) => [n, makeScenario(n)]));

// ---------------------------------------------------------------------------------------------
// CLI: screenshots

async function shootAll(argv) {
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
  const M = await import("../mock/index.mjs");
  const { View } = await import("gpui-kit");
  const { shoot } = await import("../preview/shoot.mjs");
  const Stage = (await import("../../mods/mapledr/ui/stage.js")).default;
  const shots = [];
  const variants = [];
  for (const n of SCENARIOS) {
    if (only && n !== only) continue;
    variants.push({ name: n, theme: "graphite" });
    if (["midgame", "empty", "boss"].includes(n)) variants.push({ name: n, theme: "paper", suffix: "-light" });
  }
  for (const v of variants) {
    const vm = makeScenario(v.name);
    M.resetState();
    M.setFixture({ theme: v.theme, layout: M.readLayout() });
    const host = { world: null, version: 1, view: () => vm, command: () => ({ ok: true }), claim: () => true };
    class Wrap extends View {
      init(p, cx) { this.s = new Stage(); this.s.init({ role: "stage" }, cx, host); }
      render(cx) { return this.s.render(cx); }
    }
    const mod = await M.mountView(Wrap, { props: { role: "stage" } });
    mod.render();
    mod.size(vm.width, vm.height);
    mod.render();
    for (const e of mod.errors) console.warn(`  ! ${v.name}: [${e.code}] ${e.message}`);
    console.log(`${v.name}${v.suffix ?? ""}: ${mod.stats.elements} elements, ${mod.stats.lastRenderMs.toFixed(1)} ms`);
    shots.push({ name: `ui-stage-${v.name}${v.suffix ?? ""}`, tree: mod.tree, width: vm.width, height: vm.height, userFacing: true, theme: M.resolveTheme(v.theme) });
  }
  const files = await shoot(shots);
  for (const f of files) console.log(`wrote ${path.relative(process.cwd(), f.file)}`);
}

/**
 * Real demo worlds (game/demo.js) through game/view.js stageView and the renderer:
 * out/view-stage-<kind>[-<width>].png. `--only kind`, `--widths 1200,360`, `--ticks n` (advance the
 * world n ticks with demoSnapshot first, so remembered mob spots and fade-outs are exercised).
 */
async function shootViews(argv) {
  const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const only = arg("--only", null);
  const widths = String(arg("--widths", "1200")).split(",").map(Number);
  const ticks = Number(arg("--ticks", "2"));
  const height = Number(arg("--height", "200"));
  const M = await import("../mock/index.mjs");
  const { View } = await import("gpui-kit");
  const { shoot } = await import("../preview/shoot.mjs");
  const { demoWorld, demoSnapshot, DEMO_KINDS } = await import("../../mods/mapledr/game/demo.js");
  const { tick } = await import("../../mods/mapledr/game/world.js");
  const { stageView } = await import("../../mods/mapledr/game/view.js");
  const Stage = (await import("../../mods/mapledr/ui/stage.js")).default;
  const now0 = Date.UTC(2026, 10, 24, 9, 30, 0);
  const shots = [];
  for (const kind of DEMO_KINDS) {
    if (only && kind !== only) continue;
    for (const width of widths) {
      const { world } = demoWorld(kind, now0);
      let now = now0;
      stageView(world, { width, height, nowMs: now });
      for (let k = 0; k < ticks; k++) {
        now += 1000;
        tick(world, demoSnapshot(world, now));
        stageView(world, { width, height, nowMs: now });
      }
      const vm = stageView(world, { width, height, nowMs: now });
      M.resetState();
      M.setFixture({ theme: "graphite", layout: M.readLayout() });
      const host = { world, version: 1, view: () => vm, command: () => ({ ok: true }), claim: () => true };
      class Wrap extends View {
        init(p, cx) { this.s = new Stage(); this.s.init({ role: "stage" }, cx, host); }
        render(cx) { return this.s.render(cx); }
      }
      const mod = await M.mountView(Wrap, { props: { role: "stage" } });
      mod.render();
      mod.size(width, height);
      mod.render();
      for (const e of mod.errors) console.warn(`  ! ${kind}@${width}: [${e.code}] ${e.message}`);
      const name = `view-stage-${kind}${widths.length > 1 || width !== 1200 ? `-${width}` : ""}${height !== 200 ? `-h${height}` : ""}`;
      console.log(`${name}: ${mod.stats.elements} elements, ${mod.stats.lastRenderMs.toFixed(1)} ms`);
      shots.push({ name, tree: mod.tree, width, height, userFacing: true, theme: M.resolveTheme("graphite") });
    }
  }
  const files = await shoot(shots);
  for (const f of files) console.log(`wrote ${path.relative(process.cwd(), f.file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--shoot")) shootAll(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
  else if (process.argv.includes("--views")) shootViews(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
