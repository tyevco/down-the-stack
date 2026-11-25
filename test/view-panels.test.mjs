// game/view/panels.js (sheetView, herdView) against the real engine: every demo world (game/demo.js)
// plus a 30-hero herd with a long Hall of Fame and Contractors.
//  1. shape: every key the sample VMs (tools/vm-samples/{sheet,herd}.mjs) use exists with the same
//     type (null where the ui typedefs allow it); no NaN / Infinity / undefined; colours are hex;
//  2. render: the VMs go through the real roles (ui/sheet.js, ui/herdpanel.js) inside a mocked render
//     pass, every tab, at 640 / 760 / 1000 px, zoom 1 and 2, with zero validator errors and inside
//     the dialog element budget (< 500; the 30-hero roster < 450);
//  3. stability: ticking a demo world keeps item, row and boss ids;
//  4. rules: every enabled ActionVM is accepted by world.command; focus falls back from a vanished
//     hover to the selection; caps (stash 48, digest 8, Hall of Fame 10); Squash picks; the samples
//     obey the item rules (names, tiers, affix slots, required levels);
//  5. performance: view + render per call in V8, with generous bounds.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("../tools/mock/index.mjs");
const { View } = await import("gpui-kit");
const V = await import("../mods/down-the-stack/game/view.js");
const P = await import("../mods/down-the-stack/game/view/panels.js");
const D = await import("../mods/down-the-stack/game/demo.js");
const W = await import("../mods/down-the-stack/game/world.js");
const I = await import("../mods/down-the-stack/game/items.js");
const DATA = await import("../mods/down-the-stack/game/data.js");
const F = await import("../mods/down-the-stack/game/formulas.js");
const Herd = await import("../mods/down-the-stack/game/herd.js");
const SheetMod = await import("../mods/down-the-stack/ui/sheet.js");
const HerdMod = await import("../mods/down-the-stack/ui/herdpanel.js");
const S = await import("../tools/vm-samples/sheet.mjs");
const H = await import("../tools/vm-samples/herd.mjs");
const G = await import("../tools/mock/gates.mjs");

const NOW = Date.UTC(2026, 10, 24, 9, 30);
const DAY = 86400000;
const SHEET_TABS = ["gear", "skills", "stats", "career", "journal"];
const HERD_TABS = ["upgrades", "stash", "tracker", "bosses", "roster", "digest", "settings"];
const D_RARITY_COLORS = ["#A0A4AB", "#5BD16A", "#4EA3FF", "#B36BFF", "#FF9A2E", "#FF7AA8"];
const FILTER = { slot: "all", minRar: 0, usable: false, sort: "score", focus: null, squash: [] };

// ---------------------------------------------------------------------------------------------
// worlds

const worlds = new Map();
function demo(kind) {
  if (!worlds.has(kind)) worlds.set(kind, D.demoWorld(kind, NOW).world);
  return worlds.get(kind);
}

function advance(world, sec) {
  const now = world.state.herd.lastMs + sec * 1000;
  W.tick(world, D.demoSnapshot(world, now));
  return now;
}

/** A herd of n live heroes in two spaces, hired over several days (6 a day); extra agents last. */
function bigWorld(n, { extra = [] } = {}) {
  const plans = [
    [["working", 3000]], [["working", 400], ["blocked", 1e9]], [["working", 200], ["done", 1e9]],
    [["working", 900], ["idle", 1e9]], [["working", 1e9]],
  ];
  const progs = ["claude", "codex", "pi", "opencode", "gemini"];
  const days = Math.max(1, Math.ceil(n / 6));
  const t0 = NOW - days * DAY;
  const ags = [];
  for (let k = 0; k < n; k++) {
    const second = k >= n / 2;
    ags.push(D.makeAgent({
      address: `t${k + 1}`, program: progs[k % progs.length], space: second ? "spc_2" : "spc_1", spaceName: second ? "infra" : "herdr-app",
      tab: `tab_${k >> 2}`, tabIndex: k >> 2, plan: plans[k % plans.length], from: t0 + Math.floor(k / 6) * DAY, titleIdx: k,
    }));
  }
  for (const spec of extra) ags.push(D.makeAgent(Object.assign({ from: t0 + (days - 1) * DAY }, spec)));
  const cast = D.makeCast(ags, { focus: "t2" });
  const world = W.createWorld({ nowMs: t0, seed: 99 });
  D.runCast(world, cast, t0 + 1000);
  const opens = [];
  for (let d = 1; d < days; d++) opens.push(t0 + d * DAY);
  opens.push(NOW - 5 * 60000);
  for (const at of opens) {
    D.advanceCast(cast, (at - world.state.herd.lastMs) / 1000);
    W.tick(world, D.castSnapshot(cast, at));
  }
  D.runCast(world, cast, NOW);
  world.rt.demo = { cast };
  return world;
}

/**
 * Six heroes hired today, then the `extra` agents: Contractors until hiring reopens (owner
 * decision, round 4: promoted at the 04:00 game day turn, or when a roster slot frees). Every agent
 * starts after 04:00 today, so none has been promoted by NOW.
 */
function sameDayWorld(extra, { heroes = 6, spaces = 1 } = {}) {
  const t0 = NOW - 2 * 3600000; // 07:30 UTC, the game day turned at 04:00
  const ags = [];
  for (let k = 0; k < heroes; k++) {
    const sp = k % spaces;
    ags.push(D.makeAgent({
      address: `t${k + 1}`, program: "claude", space: `spc_${sp + 1}`, spaceName: sp ? `space-${sp + 1}` : "herdr-app",
      tab: `tab_${k}`, tabIndex: k, plan: [["working", 1e9]], from: t0, titleIdx: k,
    }));
  }
  extra.forEach((spec, i) => ags.push(D.makeAgent(Object.assign({ from: t0 + (i + 1) * 60000, plan: [["working", 1e9]] }, spec))));
  const cast = D.makeCast(ags, { focus: "t2" });
  const world = W.createWorld({ nowMs: t0, seed: 99 });
  D.runCast(world, cast, NOW);
  world.rt.demo = { cast };
  return world;
}

let BIG = null;
/** 30 heroes, every one Lv 30+ (retire buttons everywhere), 14 Hall of Fame entries. */
function big() {
  if (BIG) return BIG;
  const w = bigWorld(30);
  const { grow } = D._internal;
  w.state.heroes.forEach((h, i) => grow(w, h, { L: 30 + (i % 20), cls: ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"][i % 5], rar: 2, pol: 2 }));
  for (let k = 0; k < 14; k++) w.state.herd.fame.push([`Retiree ${k}`, 1 + (k % 5), 30 + k, NOW - (k + 1) * DAY]);
  w.rt.version++;
  BIG = w;
  return w;
}

const heroIdsOf = (world, n = 4) => world.state.heroes.slice(0, n).map((h) => h.id);
const anyItemUid = (world) => (world.state.herd.stash[0] || world.state.heroes.flatMap((h) => h.eq).find(Boolean) || {}).uid ?? null;

// ---------------------------------------------------------------------------------------------
// shape conformance against the sample VMs

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
// keys the ui typedefs allow to be null, with the type they have otherwise
const NULLABLE = {
  note: ["object", "string"], good: "boolean", tag: "string", tagTip: "string", tagTab: "string", waiting: "string", quest: "string", fe: "string", focus: "object", weapon: "object", hat: "object",
  programIcon: "object", card: "object", squash: "object", delta: "object", pol: "string", cost: "string", tooltip: "string",
  tone: "string", confirm: "string", reroll: "object", prop: "object", vs: "string", score: "object", owner: "string",
  flavor: "string", learn: "object", lockText: "string", next: "string", cd: "string", sub: "string", color: "string",
  estimate: "object", challenge: "object", review: "object", boss: "object", retire: "object", rebind: "object",
  stat: "string", more: "string", reason: "string", buy: "object", trophies: "string", fight: "object", firstClear: "string",
  tierName: "string", cleared: "string", sprint: "object", ack: "object", hint: "string", setting: "string", chrome: "object",
  options: "array", action: "object", badge: "string", missing: "string", header: "object", item: "object", icon: "string",
  gear: "object", skills: "object", stats: "object", career: "object", journal: "object",
  upgrades: "object", stash: "object", tracker: "object", bosses: "object", roster: "object", digest: "object", settings: "object",
  // round 4: a tab's badge meaning, a roster row's space (no header) and a Contractor's hire, the digest's seen command
  tip: "string", space: "string", hire: "object", seen: "object",
};
// settings values / option ids / chrome hooks, filter patches and command args differ per item
const ANY = new Set(["value", "id", "chrome", "set", "args"]);
const HEX_KEYS = new Set(["color", "rarColor", "stripe", "accent", "hoodie", "titleBar", "screen", "faceInk"]);
const isHex = (s) => typeof s === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s);

function conform(actual, sample, path, errs) {
  const leaf = path.split(/[.[\]]/).filter(Boolean).pop();
  if (ANY.has(leaf)) return;
  const ta = typeOf(actual), ts = typeOf(sample);
  if (ts === "null" || ta === "null") {
    if (ta === ts) return;
    const allowed = [].concat(NULLABLE[leaf] || []);
    if (allowed.includes(ta) || allowed.includes(ts)) return;
    errs.push(`${path}: ${ta} (sample ${ts})`);
    return;
  }
  if (ta !== ts) { errs.push(`${path}: ${ta} (sample ${ts})`); return; }
  if (ts === "array") {
    const items = sample.filter((x) => x !== null && typeof x === "object" && !Array.isArray(x));
    if (!items.length) {
      if (sample.length) for (let i = 0; i < actual.length; i++) if (typeOf(actual[i]) !== typeOf(sample[0])) errs.push(`${path}[${i}]: ${typeOf(actual[i])}`);
      return;
    }
    const shared = Object.keys(items[0]).filter((k) => items.every((x) => k in x));
    const proto = {};
    for (const k of shared) proto[k] = (items.find((x) => x[k] !== null) ?? items[0])[k];
    for (let i = 0; i < actual.length; i++) conform(actual[i], proto, `${path}[${i}]`, errs);
    return;
  }
  if (ts === "object") {
    for (const k of Object.keys(sample)) {
      if (!(k in actual)) { errs.push(`${path}.${k}: missing`); continue; }
      conform(actual[k], sample[k], `${path}.${k}`, errs);
    }
  }
}

function clean(v, path, errs) {
  const t = typeOf(v);
  if (v === undefined) errs.push(`${path}: undefined`);
  else if (t === "number" && !Number.isFinite(v)) errs.push(`${path}: ${v}`);
  else if (t === "array") v.forEach((x, i) => clean(x, `${path}[${i}]`, errs));
  else if (t === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (HEX_KEYS.has(k) && x !== null && !isHex(x)) errs.push(`${path}.${k}: not hex (${x})`);
      if ((k === "key" || k === "label" || k === "name" || k === "text" || k === "title") && typeof x !== "string") errs.push(`${path}.${k}: ${typeOf(x)}`);
      if (typeof x === "string" && /\bundefined\b|\bNaN\b|\[object/.test(x)) errs.push(`${path}.${k}: "${x}"`);
      clean(x, `${path}.${k}`, errs);
    }
  }
}

function assertShape(vm, sample, label) {
  const errs = [];
  conform(vm, sample, label, errs);
  clean(vm, label, errs);
  assert.deepEqual(errs, [], label);
}

/** Keys unique within each list of keyed things (ids are built from them). */
function assertUniqueKeys(vm, label) {
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      const keys = v.filter((x) => x && typeof x === "object" && typeof x.key === "string").map((x) => x.key);
      assert.equal(new Set(keys).size, keys.length, `${label} ${path}: duplicate keys ${keys.join(",")}`);
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(vm, "");
}

const SHEET_SAMPLE = {
  gear: S.scenarios.gear, skills: S.scenarios.skills, stats: S.scenarios.stats, career: S.scenarios.career, journal: S.scenarios.journal,
};
const HERD_SAMPLE = {
  upgrades: H.scenarios.upgrades, stash: H.scenarios.stash, tracker: H.scenarios.tracker, bosses: H.scenarios.bossFight,
  roster: H.scenarios.roster, digest: H.scenarios.digest, settings: H.scenarios.settings,
};

test("shape: sheetView matches the sample VMs for every demo world, hero and tab (with and without a card)", () => {
  for (const kind of D.DEMO_KINDS) {
    const world = demo(kind);
    const focus = anyItemUid(world);
    for (const heroId of heroIdsOf(world)) {
      for (const tab of SHEET_TABS) {
        const vm = V.sheetView(world, { heroId, tab, filter: FILTER });
        assertShape(vm, SHEET_SAMPLE[tab], `sheet/${kind}/${heroId}/${tab}`);
        assertUniqueKeys(vm, `sheet/${kind}/${heroId}/${tab}`);
        assert.equal(vm.tab, tab);
        for (const t of SHEET_TABS) if (t !== tab) assert.equal(vm[t], null, `${tab}: only the shown tab is filled`);
        if (tab === "career" && vm.career.rebind) assertShape(vm.career.rebind, S.scenarios.benched.career.rebind, `rebind/${kind}/${heroId}`);
      }
      // the card: a stash item, then each equipped item
      for (const uid of [focus].concat(world.state.heroes.find((h) => h.id === heroId).eq.filter(Boolean).map((it) => it.uid))) {
        if (uid == null) continue;
        const vm = V.sheetView(world, { heroId, tab: "gear", filter: { ...FILTER, focus: uid } });
        assert.ok(vm.gear.card, `${kind}/${heroId}: card for ${uid}`);
        assertShape(vm.gear.card, S.scenarios.gear.gear.card, `card/${kind}/${heroId}/${uid}`);
      }
    }
  }
  const missing = V.sheetView(demo("mid"), { heroId: 999, tab: "career", filter: FILTER });
  assertShape(missing, S.scenarios.missing, "missing");
  assert.equal(missing.missing, "This hero has left the roster.");
  assert.equal(V.sheetView(null, { heroId: 1 }), null);
});

test("shape: herdView matches the sample VMs for every demo world and tab (focused stash card too)", () => {
  for (const kind of D.DEMO_KINDS) {
    const world = demo(kind);
    for (const tab of HERD_TABS) {
      const vm = V.herdView(world, { tab, filter: FILTER });
      assertShape(vm, HERD_SAMPLE[tab], `herd/${kind}/${tab}`);
      assertUniqueKeys(vm, `herd/${kind}/${tab}`);
      for (const t of HERD_TABS) if (t !== tab) assert.equal(vm[t], null);
    }
    const uid = anyItemUid(world);
    if (uid != null) {
      const vm = V.herdView(world, { tab: "stash", filter: { ...FILTER, focus: uid } });
      assert.ok(vm.stash.card, kind);
      assertShape(vm.stash.card, H.scenarios.stash.stash.card, `herd card/${kind}`);
    }
  }
  assert.equal(V.herdView(null, { tab: "upgrades" }), null);
});

test("shape: a 30-hero herd, Contractors and a paused / running boss fight match the samples too", () => {
  const w = big();
  for (const tab of HERD_TABS) assertShape(V.herdView(w, { tab, filter: FILTER }), HERD_SAMPLE[tab], `big/${tab}`);
  const c = sameDayWorld([{ address: "vps/t9", program: "claude", space: "spc_1", spaceName: "herdr-app", plan: [["working", 1e9]] }]);
  const contractor = Array.from(c.rt.contractors.values())[0];
  assert.ok(contractor, "the 7th hire of the day is a Contractor");
  for (const tab of SHEET_TABS) {
    const vm = V.sheetView(c, { heroId: contractor.id, tab, filter: { ...FILTER, focus: contractor.eq[0].uid } });
    assertShape(vm, SHEET_SAMPLE[tab], `contractor/${tab}`);
    assert.equal(vm.header.tag, "contractor");
    if (tab === "gear") {
      assert.ok(vm.gear.card, "a Contractor's own kit has a card");
      assert.equal(vm.gear.card.owner, `Worn by ${contractor.name}`);
      assert.equal(vm.gear.card.actions.some((a) => a.cmd === "equip" && a.enabled), false);
      const other = c.state.herd.stash[0];
      if (other) {
        const card = V.sheetView(c, { heroId: contractor.id, tab, filter: { ...FILTER, focus: other.uid } }).gear.card;
        const eq = card.actions.find((a) => a.cmd === "equip");
        assert.equal(eq.enabled, false);
        assert.equal(eq.tooltip, "Contractors can't take gear from vendor/");
      }
    }
    if (tab === "career") assert.equal(vm.career.retire, null);
    // a Contractor is not in the saved state (negative hero id and item uids): world.command refuses
    // everything on it but claimChest / markSeen, so no other button may be enabled
    for (const a of actionsOf(vm)) {
      if (!a.enabled) continue;
      const r = W.command(c, a.cmd, a.args, NOW);
      assert.equal(r.ok, true, `contractor/${tab} ${a.key} ${a.cmd} ${JSON.stringify(a.args)}: ${r.error}`);
    }
  }
  const boss = demo("boss");
  const bv = V.herdView(boss, { tab: "bosses", filter: FILTER }).bosses;
  assert.ok(bv.fight, "the boss demo has a fight running");
  assert.equal(bv.fight.retreat.cmd, "retreat");
  assert.equal(bv.bosses[3].state, "fighting");
});

// ---------------------------------------------------------------------------------------------
// render through the real roles

function worldHost(world) {
  return {
    world, version: 1, views: [], commands: [], claim: () => true,
    view(kind, args) { this.views.push([kind, args]); return kind === "sheet" ? V.sheetView(world, args) : kind === "herd" ? V.herdView(world, args) : null; },
    command(name, args) { this.commands.push([name, args]); return W.command(world, name, args, world.rt.nowMs); },
  };
}

const ROLE = { sheet: SheetMod, herd: HerdMod };
async function mount(kind, world, { width = 760, zoom = 1, theme = "graphite", props = {}, ui = {} } = {}) {
  M.resetState();
  M.resetStorage();
  const host = worldHost(world);
  const R = ROLE[kind].default;
  const p = kind === "sheet" ? { role: "sheet", overlay: "o1", ...props } : { role: "herd", overlay: "o2", ...props };
  class Wrap extends View {
    init(_p, cx) {
      this.role = new R();
      this.role.init(p, cx, host);
      Object.assign(this.role.ui, ui);
    }
    render(cx) { return this.role.render(cx); }
  }
  const m = await M.mountView(Wrap, { props: p, fixture: { settings: { zoom }, theme }, nowMs: NOW });
  m.render();
  m.size(width * zoom, (kind === "sheet" ? 500 : 520) * zoom);
  m.render();
  return { m, host, role: m.view.role };
}

// herdr's render budget is wall-clock time, and the mock flags any render over it ("budget"). Under
// load (parallel test files, a browser shooting previews) a slow render says nothing about the
// code: load only adds time, waiting for a CPU. So a view the mock flagged is rendered again, each
// render's cost taken as the lower of the mock's script time (its stopwatch, itself the lower of
// wall and CPU time) and the process's CPU time for the whole render (no waiting; the mock's own
// checks and GC threads are in it), and the best of 5 must fit. Every other validator error counts
// as it is. (As in test/ui-chrome.test.mjs.)
const isRenderBudget = (e) => e.code === "budget" && /^render took/.test(String(e.message));
/** One render's cost (ms): min(the mock's script time, CPU time of the whole render). */
function renderCost(m) {
  const c0 = process.cpuUsage();
  m.render();
  const c = process.cpuUsage(c0);
  return Math.min(m.stats.lastRenderMs, (c.user + c.system) / 1000);
}
function bestRenderMs(m, n = 5) {
  let best = Infinity;
  for (let k = 0; k < n; k++) best = Math.min(best, renderCost(m));
  return best;
}
function errorsOf(m) {
  const out = m.errors.filter((e) => !isRenderBudget(e)).map((e) => `${e.code}: ${e.message}`);
  if (m.errors.some(isRenderBudget) && m.view) {
    const best = bestRenderMs(m);
    if (best > M.BUDGET.render) out.push(`budget: the best of 5 renders took ${best.toFixed(1)} ms (herdr's budget is ${M.BUDGET.render} ms)`);
  }
  return out;
}
function assertClean(m, label, budget = 500) {
  assert.ok(m.tree, `${label}: render failed: ${errorsOf(m).join("; ")}`);
  assert.deepEqual(errorsOf(m), [], label);
  const dupes = m.warnings.filter((w) => w.code === "duplicate-id" || w.code === "transition-no-id").map((w) => w.message);
  assert.deepEqual(dupes, [], label);
  assert.ok(m.stats.elements < budget, `${label}: ${m.stats.elements} elements`);
}
const ids = (m) => new Set(m.findAll((n) => n.id != null).map((n) => n.id));

test("render: the sheet draws every tab of every demo hero at 640 / 760 / 1000 px, zoom 1 and 2", async () => {
  for (const kind of D.DEMO_KINDS) {
    const world = demo(kind);
    const uid = anyItemUid(world);
    for (const heroId of heroIdsOf(world, 2)) {
      for (const [width, zoom] of [[760, 1], [640, 2], [1000, 1]]) {
        const { m, role } = await mount("sheet", world, { width, zoom, theme: zoom === 2 ? "paper" : "graphite", props: { heroId }, ui: { selected: uid } });
        for (const tab of SHEET_TABS) {
          role.ui.tab = tab;
          m.render();
          assertClean(m, `sheet/${kind}/${heroId}/${tab} w${width} z${zoom}`);
          assert.ok(m.text().includes(world.state.heroes.find((h) => h.id === heroId).name), `${kind}/${tab}: the name shows`);
        }
      }
    }
  }
  // a missing hero and the empty world
  const { m } = await mount("sheet", demo("empty"), { props: { heroId: 1 } });
  assertClean(m, "sheet/missing");
  assert.ok(m.text().includes("left the roster"));
});

test("render: the Herd panel draws every tab of every demo world at 640 / 760 / 1000 px, zoom 1 and 2", async () => {
  for (const kind of D.DEMO_KINDS) {
    const world = demo(kind);
    const uid = anyItemUid(world);
    for (const [width, zoom] of [[760, 1], [640, 2], [1000, 1]]) {
      const { m, role } = await mount("herd", world, { width, zoom, theme: zoom === 2 ? "paper" : "graphite", ui: { selected: uid } });
      for (const tab of HERD_TABS) {
        role.ui.tab = tab;
        m.render();
        assertClean(m, `herd/${kind}/${tab} w${width} z${zoom}`);
      }
    }
  }
});

test("render: a full late-game stash stays inside the budget while picking for Squash Merge, every row locked and new", async () => {
  const world = D.demoWorld("late", NOW).world;
  for (const it of world.state.herd.stash) it.flags |= I.FLAG_LOCKED | I.FLAG_NEW;
  world.rt.version++;
  const picks = world.state.herd.stash.slice(0, 2).map((it) => it.uid);
  for (const it of world.state.herd.stash.slice(0, 2)) it.flags &= ~I.FLAG_LOCKED;
  const hero = world.state.heroes[0];
  const s = await mount("sheet", world, { props: { heroId: hero.id, tab: "gear" }, ui: { selected: picks[0], squashMode: true, filter: { slot: "all", minRar: 0, usable: false, sort: "score", squash: picks } } });
  assertClean(s.m, "sheet gear, picking, all locked + new");
  const h = await mount("herd", world, { props: { tab: "stash" }, ui: { selected: picks[0], squashMode: true, filter: { slot: "all", minRar: 0, usable: false, sort: "score", squash: picks } } });
  assertClean(h.m, "herd stash, picking, all locked + new");
});

test("render: 30 heroes use slim roster rows (+ a capped Hall of Fame) and stay under 450 elements", async () => {
  const w = big();
  const vm = V.herdView(w, { tab: "roster", filter: FILTER }).roster;
  assert.equal(vm.slim, true);
  assert.equal(vm.groups.reduce((n, g) => n + g.rows.length, 0), 30);
  assert.ok(vm.groups.flatMap((g) => g.rows).every((r) => r.retire && r.retire.cmd === "retire"), "Lv 30+: a Retire on every row");
  assert.equal(vm.fame.rows.length, 10);
  assert.equal(vm.fame.more, "+4 more");
  const { m, role } = await mount("herd", w, { props: { tab: "roster" } });
  assertClean(m, "big roster", 450);
  // the slim Retire still asks first, then runs
  const rid = `hd-ret-${vm.groups[0].rows[0].key}`;
  m.fire(rid);
  m.render();
  assert.ok(m.text().includes("Sure?"));
  assert.equal(role.host.commands.length, 0);
  // a small herd keeps the full rows
  assert.equal(V.herdView(demo("mid"), { tab: "roster", filter: FILTER }).roster.slim, false);
});

// ---------------------------------------------------------------------------------------------
// layout in Chromium (tools/preview's HTML: herdr's renderer is not available here, the preview is
// its stand-in, good for layout): what the person must see is in view at the dialog's own size

/**
 * Lays a mounted dialog out in Chromium and reports: `spills` (visible text, after clipping by its
 * scrolling / clipping ancestors, that runs under the footer or out of the dialog), `cut` (text
 * cut with an ellipsis, by its nearest id) and `buttons` (each asked id: in view without
 * scrolling, i.e. whole inside every clipping ancestor and above the footer).
 */
async function layoutOf(page, m, { width = 760, height, theme = "graphite", buttons = [] } = {}) {
  const { treeToHtml } = await import("../tools/preview/render.mjs");
  const { resolveTheme } = await import("../tools/mock/theme.mjs");
  await page.setViewportSize({ width, height });
  await page.setContent(treeToHtml(m.tree, { width, height, zoom: 1, theme: resolveTheme(theme) }), { waitUntil: "load" });
  await page.evaluate(() => document.fonts?.ready);
  return page.evaluate((ids) => {
    const root = document.querySelector('[data-id="sheet"],[data-id="herd"]');
    const footer = document.querySelector('[data-id="sh-footer"],[data-id="hd-footer"]');
    const rr = root.getBoundingClientRect();
    const fr = footer.getBoundingClientRect();
    const idOf = (el) => { for (let e = el; e; e = e.parentElement) if (e.dataset && e.dataset.id) return e.dataset.id; return "?"; };
    const clip = (el) => {
      const r = el.getBoundingClientRect();
      let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
      for (let e = el.parentElement; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
        const p = e.getBoundingClientRect();
        x0 = Math.max(x0, p.left); y0 = Math.max(y0, p.top); x1 = Math.min(x1, p.right); y1 = Math.min(y1, p.bottom);
      }
      return { r, x0, y0, x1, y1, empty: x1 - x0 < 1 || y1 - y0 < 1 };
    };
    const spills = [];
    const cut = [];
    for (const el of root.querySelectorAll("*")) {
      const text = (el.textContent || "").trim();
      if (getComputedStyle(el).textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth && text) cut.push(`${idOf(el)}: ${text}`);
      if (footer.contains(el) || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const c = clip(el);
      if (c.empty) continue;
      if (c.y1 > fr.top + 0.5) spills.push(`${idOf(el)}: "${text.slice(0, 50)}" runs under the footer`);
      else if (c.x1 > rr.right + 0.5 || c.y1 > rr.bottom + 0.5) spills.push(`${idOf(el)}: "${text.slice(0, 50)}" leaves the dialog`);
    }
    const shown = {};
    for (const id of ids) {
      const el = document.querySelector(`[data-id="${id}"]`);
      if (!el) { shown[id] = null; continue; }
      const c = clip(el);
      shown[id] = { text: el.textContent.trim(), inView: !c.empty && c.y1 - c.y0 >= c.r.height - 0.5 && c.x1 - c.x0 >= c.r.width - 0.5 && c.r.bottom <= fr.top + 0.5 };
    }
    return { spills, cut, buttons: shown };
  }, buttons);
}

test("layout: the career boss card's Retreat is in view at 760 × 500 during a fight (armed too); the Herd panel's fight banner too", async (t) => {
  let pw;
  try { pw = (await import("node:module")).createRequire(import.meta.url)("playwright"); } catch { return G.skipGate(t, "the career boss card's Retreat in Chromium", "Playwright is not installed"); }
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    let checked = 0;
    for (const kind of ["boss", "late"]) {
      const world = D.demoWorld(kind, NOW).world;
      const fight = world.rt.fights.find((f) => f.kind === "boss");
      assert.ok(fight, `${kind}: a zone boss fight runs`);
      for (const heroId of fight.heroIds) {
        const { m, role } = await mount("sheet", world, { props: { heroId, tab: "career" } });
        const boss = V.sheetView(world, { heroId, tab: "career", filter: FILTER }).career.boss;
        if (!boss || !boss.fighting) continue; // a helper from another zone: its card is its own zone's
        assert.equal(boss.challenge.cmd, "retreat");
        for (const armed of [null, boss.challenge.key]) {
          role.ui.armed = armed;
          m.render();
          assertClean(m, `${kind}/${heroId} career`);
          const L = await layoutOf(page, m, { height: 500, buttons: ["sh-boss-go"] });
          const b = L.buttons["sh-boss-go"];
          assert.ok(b && b.inView, `${kind}/${heroId}${armed ? " armed" : ""}: Retreat in view (${JSON.stringify(b)})`);
          assert.equal(b.text, armed ? "Retreat? (a Postmortem)" : "Retreat");
          assert.deepEqual(L.spills, [], `${kind}/${heroId} career`);
          // armed, the question takes the title row's room: the boss's name and status stay whole
          assert.deepEqual(L.cut.filter((c) => c.startsWith("sh-boss")), [], `${kind}/${heroId}${armed ? " armed" : ""}: boss card lines whole`);
          checked++;
        }
      }
      // the Herd panel: the banner over the boss list, with and without the save band (D§13.4)
      for (const save of [null, { readOnly: true, title: "Save is read-only", message: "This save is from a newer version of Down the Stack, so it was opened read-only." }]) {
        const h = await mount("herd", world, { props: { tab: "bosses" } });
        if (save) {
          const view = h.host.view;
          h.host.view = function (k, args) { return view.call(this, k, { ...args, save }); };
          world.rt.version++;
        }
        for (const armed of [null, "retreat"]) {
          h.role.ui.armed = armed;
          h.m.render();
          assertClean(h.m, `${kind} herd bosses`);
          if (save) assert.ok(h.m.node("hd-save"), "the save band shows");
          const L = await layoutOf(page, h.m, { height: 520, buttons: ["hd-retreat"] });
          assert.ok(L.buttons["hd-retreat"]?.inView, `${kind} herd${save ? " + save band" : ""}${armed ? " armed" : ""}: Retreat in view`);
          assert.deepEqual(L.spills, [], `${kind} herd bosses`);
        }
      }
    }
    assert.ok(checked >= 2 * 4, `fight participants checked: ${checked / 2}`);
    // no fight: the card sits after the ladder; its Challenge / Fight again and the win estimate
    // (D§11.13 "boss card with win estimate label and [Challenge]") share its title row, in view
    // for every hero of every demo world, and for a Lv 33 hero whose zone door just opened
    const door = D.demoWorld("mid", NOW).world;
    door.state.herd.quota["3-3"] = DATA.TUNING.quotaPerMap;
    door.state.herd.meter = Herd.sprintTarget(2);
    door.rt.version++;
    let cards = 0;
    for (const [kind, world] of [["mid+door", door], ...D.DEMO_KINDS.map((k) => [k, D.demoWorld(k, NOW).world])]) {
      for (const h of world.state.heroes) {
        const boss = V.sheetView(world, { heroId: h.id, tab: "career", filter: FILTER }).career.boss;
        if (!boss || boss.fighting || (!boss.challenge && !boss.estimate)) continue;
        if (kind === "mid+door" && h.id === 1) assert.deepEqual([boss.status, boss.challenge?.label, boss.challenge?.enabled, Boolean(boss.estimate)], ["Door open", "Challenge", true, true]);
        const { m } = await mount("sheet", world, { props: { heroId: h.id, tab: "career" } });
        assertClean(m, `${kind}/${h.id} career`);
        const want = [boss.challenge ? "sh-boss-go" : null, boss.estimate ? "sh-boss-est" : null].filter(Boolean);
        const L = await layoutOf(page, m, { height: 500, buttons: want });
        for (const id of want) assert.ok(L.buttons[id]?.inView, `${kind}/${h.id} (Lv ${h.L}): ${id} in view (${JSON.stringify(L.buttons[id])})`);
        cards++;
      }
    }
    t.diagnostic(`boss cards out of a fight checked: ${cards}`);
    assert.ok(cards >= 10, `cards checked: ${cards}`);
    // a career review (also a boss fight, in the hero's own slot): its Retreat on the ladder row
    const rv = D.demoWorld("late", NOW).world;
    const echo = rv.state.heroes.find((h) => h.id === 1);
    echo.rev = [1, 0];
    rv.rt.version++;
    const rung = V.sheetView(rv, { heroId: 1, tab: "career", filter: FILTER }).career.ladder.find((l) => l.key === "staff");
    assert.equal(W.command(rv, rung.review.challenge.cmd, rung.review.challenge.args, NOW).ok, true);
    rv.rt.version++;
    const { m: rm, role: rr } = await mount("sheet", rv, { props: { heroId: 1, tab: "career" } });
    const running = V.sheetView(rv, { heroId: 1, tab: "career", filter: FILTER }).career.ladder.find((l) => l.key === "staff").review;
    assert.equal(running.challenge.cmd, "retreat");
    for (const armed of [null, running.challenge.key]) {
      rr.ui.armed = armed;
      rm.render();
      assertClean(rm, `review${armed ? " armed" : ""}`);
      const L = await layoutOf(page, rm, { height: 500, buttons: ["sh-rv-staff"] });
      assert.ok(L.buttons["sh-rv-staff"]?.inView, `review${armed ? " armed" : ""}: Retreat in view`);
      assert.deepEqual(L.spills, [], "review career");
    }
  } finally {
    await browser.close();
  }
});

test("layout: outside a fight a Lv 60+ hero's career boss card shows whole (name, status, button, estimate) at 760 × 500", async (t) => {
  let pw;
  try { pw = (await import("node:module")).createRequire(import.meta.url)("playwright"); } catch { return G.skipGate(t, "a Lv 60+ career boss card in Chromium", "Playwright is not installed"); }
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    let cards = 0;
    for (const kind of D.DEMO_KINDS) {
      const world = D.demoWorld(kind, NOW).world;
      for (const h of world.state.heroes) {
        if (h.L < 60) continue;
        const boss = V.sheetView(world, { heroId: h.id, tab: "career", filter: FILTER }).career.boss;
        if (!boss || boss.fighting) continue;
        const { m } = await mount("sheet", world, { props: { heroId: h.id, tab: "career" } });
        const want = ["sh-boss-name", "sh-boss-status", boss.challenge ? "sh-boss-go" : null, boss.estimate ? "sh-boss-est" : null].filter(Boolean);
        const L = await layoutOf(page, m, { height: 500, buttons: want });
        for (const id of want) assert.ok(L.buttons[id]?.inView, `${kind}/${h.id} (Lv ${h.L}): ${id} in view (${JSON.stringify(L.buttons[id])})`);
        assert.deepEqual(L.spills, [], `${kind}/${h.id} career`);
        cards++;
      }
    }
    t.diagnostic(`Lv 60+ boss cards checked: ${cards}`);
    assert.ok(cards >= 3, `cards checked: ${cards}`);
  } finally {
    await browser.close();
  }
});

test("layout: no tab of either dialog runs under its footer; skill effects, zone names and building effects stay whole", async (t) => {
  let pw;
  try { pw = (await import("node:module")).createRequire(import.meta.url)("playwright"); } catch { return G.skipGate(t, "every dialog tab's layout in Chromium", "Playwright is not installed"); }
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    // the sheets that once ran under the footer: an Intern (its SP note), a provisional class (its
    // note), heroes in a fight (the note band), and a long-skilled Forkbinder / Rubberducker
    const cases = [["first-day", [1]], ["mid", null], ["boss", null], ["late", [1, 12, 13]], ["blocked", [5]]];
    for (const [kind, only] of cases) {
      const world = D.demoWorld(kind, NOW).world;
      const ids = only ?? world.state.heroes.map((h) => h.id);
      for (const heroId of ids) {
        const { m, role } = await mount("sheet", world, { props: { heroId, tab: "gear" } });
        for (const tab of SHEET_TABS) {
          role.ui.tab = tab;
          m.render();
          const L = await layoutOf(page, m, { height: 500 });
          assert.deepEqual(L.spills, [], `sheet/${kind}/${heroId}/${tab}`);
          if (tab === "skills") assert.deepEqual(L.cut.filter((c) => c.startsWith("sh-sk:")), [], `sheet/${kind}/${heroId}: skill cards whole`);
        }
      }
      const h = await mount("herd", world, { props: { tab: "upgrades" } });
      for (const tab of HERD_TABS) {
        h.role.ui.tab = tab;
        h.m.render();
        const L = await layoutOf(page, h.m, { height: 520 });
        assert.deepEqual(L.spills, [], `herd/${kind}/${tab}`);
        if (tab === "upgrades") assert.deepEqual(L.cut.filter((c) => c.startsWith("hd-b:")), [], `herd/${kind}: building lines whole`);
        if (tab === "tracker") assert.deepEqual(L.cut.filter((c) => c.startsWith("hd-z-")), [], `herd/${kind}: zone names whole`);
      }
    }
  } finally {
    await browser.close();
  }
});

// ---------------------------------------------------------------------------------------------
// stability

test("stability: ticking demo worlds keeps item, slot, row and boss ids (sheet gear, herd stash / bosses / tracker / roster)", async () => {
  for (const kind of ["first-day", "mid", "boss", "late"]) {
    const world = D.demoWorld(kind, NOW).world;
    const heroId = world.state.heroes[0].id;
    const keep = (m, re) => new Set([...ids(m)].filter((id) => re.test(id)));
    const sheet = await mount("sheet", world, { props: { heroId, tab: "gear" } });
    const sheetIds = keep(sheet.m, /^sh-(slot|tab|sum)-/);
    const rowIds = keep(sheet.m, /^sh-row-/);
    for (let k = 0; k < 3; k++) {
      advance(world, 2);
      sheet.m.render();
      assertClean(sheet.m, `${kind} sheet tick ${k}`);
      assert.deepEqual([...keep(sheet.m, /^sh-(slot|tab|sum)-/)].sort(), [...sheetIds].sort(), `${kind} sheet ids`);
      // rows keep their ids (a new drop may add one; none is renamed)
      const rows = keep(sheet.m, /^sh-row-/);
      for (const id of rowIds) assert.ok(rows.has(id) || world.state.herd.stash.length !== rowIds.size, `${kind}: ${id} kept`);
    }
    const herd = await mount("herd", world, { props: { tab: "bosses" } });
    const herdIds = {};
    for (const tab of ["bosses", "tracker", "roster", "stash"]) {
      herd.role.ui.tab = tab;
      herd.m.render();
      herdIds[tab] = keep(herd.m, /^hd-(b|z|r|tile|tab|bc|m)-|^hd-r:/);
    }
    for (let k = 0; k < 3; k++) {
      advance(world, 2);
      for (const tab of ["bosses", "tracker", "roster", "stash"]) {
        herd.role.ui.tab = tab;
        herd.m.render();
        assertClean(herd.m, `${kind} herd/${tab} tick ${k}`);
        const now = keep(herd.m, /^hd-(b|z|r|tile|tab|bc|m)-|^hd-r:/);
        if (tab === "stash") continue; // drops may arrive; checked by key below
        if (tab === "bosses") {
          // chips come and go with Wounds; rows stay
          const rows = (s) => [...s].filter((id) => /^hd-b-/.test(id)).sort();
          assert.deepEqual(rows(now), rows(herdIds[tab]), `${kind} boss rows`);
          continue;
        }
        assert.deepEqual([...now].sort(), [...herdIds[tab]].sort(), `${kind} herd/${tab} ids`);
      }
    }
  }
});

test("settings (D§11.15): loot glow, collapse the stage, and the autopilot master switch over its systems", () => {
  const world = D.demoWorld("mid", NOW).world;
  const rows = () => {
    const st = V.herdView(world, { tab: "settings", filter: FILTER }).settings;
    return Object.fromEntries(st.groups.flatMap((g) => g.rows.map((r) => [r.key, Object.assign({ group: g.key }, r)])));
  };
  let r = rows();
  assert.equal(r.glow.group, "display");
  assert.equal(r.glow.kind, "choice");
  assert.equal(r.glow.value, 0, "every drop glows by default");
  assert.deepEqual(r.glow.options.map((o) => o.label), ["All", "Alpha", "Beta", "Release", "LTS", "Keepsake"]);
  assert.deepEqual(r.glow.options.map((o) => o.color), D_RARITY_COLORS);
  assert.equal(r.glow.wide, true);
  assert.equal(r.collapse.group, "display");
  assert.equal(r.collapse.value, false, "off by default");
  const auto = V.herdView(world, { tab: "settings", filter: FILTER }).settings.groups.find((g) => g.key === "autopilot").rows;
  assert.equal(auto[0].key, "auto", "the master switch is the first row");
  assert.equal(auto[0].setting, "auto");
  assert.equal(auto[0].value, true);
  assert.ok(auto.slice(1).every((x) => x.setting.startsWith("auto.") && !x.inactive));
  // off: the systems keep their values and show as inactive
  assert.equal(W.command(world, "setting", { key: "auto.farm", value: false }, NOW).ok, true);
  assert.equal(W.command(world, "setting", { key: "auto", value: false }, NOW).ok, true);
  assert.equal(W.command(world, "setting", { key: "glow", value: "lts" }, NOW).ok, true);
  assert.equal(W.command(world, "setting", { key: "collapse", value: true }, NOW).ok, true);
  r = rows();
  assert.equal(r.auto.value, false);
  for (const k of ["auto.equip", "auto.deprecate", "auto.learn", "auto.polish", "auto.buildings", "auto.maps", "auto.boss", "auto.farm", "auto.calls", "auto.career"]) {
    assert.equal(r[k].inactive, true, k);
    assert.match(r[k].tooltip, /Autopilot is off/);
  }
  assert.equal(r["auto.equip"].value, true, "kept for later");
  assert.equal(r["auto.farm"].value, false);
  assert.equal(r.glow.value, 4);
  assert.equal(r.collapse.value, true);
  // the Upgrades tab says autopilot buildings are off too
  assert.match(V.herdView(world, { tab: "upgrades", filter: FILTER }).upgrades.note, /Auto buildings: off/);
});

test("settings: each autopilot switch says what it does (auto.career gates only the promotion reviews; thresholds from TUNING)", () => {
  const world = D.demoWorld("mid", NOW).world;
  const auto = Object.fromEntries(V.herdView(world, { tab: "settings", filter: FILTER }).settings.groups
    .find((g) => g.key === "autopilot").rows.map((r) => [r.key, r]));
  // autopilot.autoChallenge reads auto.career for the Senior / Staff Reviews only; the Lv 10 class
  // and its provisional switches ignore it (heroes.js), so the row must not promise a class
  const career = auto["auto.career"];
  assert.equal(career.setting, "auto.career");
  assert.equal(career.label, "Promotion reviews");
  assert.doesNotMatch(`${career.label} ${career.hint}`, /class|Lv 10/i);
  assert.match(career.hint, /Senior and Staff Reviews/);
  // the thresholds are the engine's (T.boss.autoAt / farmAt), in the percent the boss cards show
  const pct = (x) => `${Math.round(x * 100)}%`;
  assert.ok(career.hint.includes(`${pct(DATA.TUNING.boss.autoAt)} or more`), career.hint);
  assert.ok(auto["auto.boss"].hint.includes(`${pct(DATA.TUNING.boss.autoAt)} or more`), auto["auto.boss"].hint);
  assert.ok(auto["auto.farm"].hint.includes(`${pct(DATA.TUNING.boss.farmAt)} or more`), auto["auto.farm"].hint);
});

test("memo: the same world version and args give the same VM; a tick or a command gives a fresh one", () => {
  const world = D.demoWorld("mid", NOW).world;
  const a = V.sheetView(world, { heroId: 1, tab: "gear", filter: FILTER });
  assert.equal(V.sheetView(world, { heroId: 1, tab: "gear", filter: { ...FILTER } }), a);
  assert.notEqual(V.sheetView(world, { heroId: 1, tab: "gear", filter: { ...FILTER, slot: "hat" } }), a);
  const h = V.herdView(world, { tab: "upgrades", filter: FILTER });
  assert.equal(V.herdView(world, { tab: "upgrades", filter: { ...FILTER, slot: "hat" } }), h, "the filter only matters on the Stash tab");
  advance(world, 1);
  assert.notEqual(V.sheetView(world, { heroId: 1, tab: "gear", filter: FILTER }), a);
  const h2 = V.herdView(world, { tab: "settings", filter: FILTER });
  assert.equal(W.command(world, "setting", { key: "calm", value: true }, NOW).ok, true);
  const h3 = V.herdView(world, { tab: "settings", filter: FILTER });
  assert.notEqual(h3, h2);
  assert.equal(h3.calm, true);
  assert.equal(h3.settings.groups[0].rows[0].value, true);
});

// ---------------------------------------------------------------------------------------------
// rules

/** Every enabled action of a VM, depth-first. */
function actionsOf(vm) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (typeof v.cmd === "string" && typeof v.enabled === "boolean" && v.args) out.push(v);
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(vm);
  return out;
}

test("rules: every enabled action is accepted by world.command (a fresh world per action)", () => {
  const cases = [];
  for (const kind of ["mid", "late", "first-day", "boss", "idle"]) {
    const world = D.demoWorld(kind, NOW).world;
    const vms = [];
    for (const heroId of heroIdsOf(world, 3)) {
      const uid = world.state.herd.stash[0]?.uid ?? null;
      for (const tab of SHEET_TABS) vms.push(["sheet", { heroId, tab, filter: { ...FILTER, focus: tab === "gear" ? uid : null } }]);
      const eq = world.state.heroes.find((h) => h.id === heroId).eq.find(Boolean);
      if (eq) vms.push(["sheet", { heroId, tab: "gear", filter: { ...FILTER, focus: eq.uid } }]);
    }
    for (const tab of HERD_TABS) vms.push(["herd", { tab, filter: { ...FILTER, focus: world.state.herd.stash[0]?.uid ?? null } }]);
    const seen = new Set();
    for (const [k, args] of vms) {
      const vm = k === "sheet" ? V.sheetView(world, args) : V.herdView(world, args);
      for (const a of actionsOf(vm)) {
        if (!a.enabled) continue;
        const sig = `${a.cmd}:${a.label}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        cases.push({ kind, view: k, args, key: a.key });
      }
    }
  }
  const cmds = new Set();
  for (const c of cases) {
    const world = D.demoWorld(c.kind, NOW).world;
    const vm = c.view === "sheet" ? V.sheetView(world, c.args) : V.herdView(world, c.args);
    const a = actionsOf(vm).find((x) => x.key === c.key);
    assert.ok(a && a.enabled, `${c.kind} ${c.key}`);
    const r = W.command(world, a.cmd, a.args, NOW);
    assert.equal(r.ok, true, `${c.kind} ${c.view} ${a.key} ${a.cmd} ${JSON.stringify(a.args)}: ${r.error}`);
    cmds.add(a.cmd);
  }
  for (const want of ["equip", "lock", "polish", "deprecate", "autoLearn", "setClass", "pinMap", "buy", "digestSeen", "retire", "respec", "claimChest"]) {
    assert.ok(cmds.has(want), `covered: ${want} (${[...cmds].join(", ")})`);
  }
  // settings rows are not ActionVMs: each row's key and every value it offers is a valid setting
  const world = D.demoWorld("mid", NOW).world;
  for (const g of V.herdView(world, { tab: "settings", filter: FILTER }).settings.groups) {
    for (const r of g.rows) {
      if (!r.setting) continue;
      const values = r.kind === "choice" ? r.options.map((o) => o.id) : [!r.value, r.value];
      for (const v of values) assert.equal(W.command(world, "setting", { key: r.setting, value: v }, NOW).ok, true, `${r.setting}=${v}`);
    }
  }
});

test("rules: disabled actions say why; equip respects class, level and a locked slot; polish shows its cost", () => {
  const world = D.demoWorld("late", NOW).world;
  const hero = world.state.heroes[0];
  // a weapon of another class
  const other = world.state.herd.stash.find((it) => I.slotOf(it) === "weapon" && !I.canEquip(hero, it, { ignoreLevel: true }));
  if (other) {
    const card = V.sheetView(world, { heroId: hero.id, tab: "gear", filter: { ...FILTER, focus: other.uid } }).gear.card;
    const eq = card.actions.find((a) => a.cmd === "equip");
    assert.equal(eq.enabled, false);
    assert.match(eq.tooltip, /^Only a /);
    assert.equal(card.deltas.length, 0);
    assert.equal(card.usable, false);
  }
  // a locked slot blocks a manual equip
  const fit = world.state.herd.stash.find((it) => I.canEquip(hero, it));
  assert.ok(fit, "the late stash has something the hero can wear");
  const slotItem = hero.eq[I.slotIdxOf(fit)];
  slotItem.flags |= I.FLAG_LOCKED;
  world.rt.version++;
  const card = V.sheetView(world, { heroId: hero.id, tab: "gear", filter: { ...FILTER, focus: fit.uid } }).gear.card;
  const eq = card.actions.find((a) => a.cmd === "equip");
  assert.equal(eq.enabled, false);
  assert.match(eq.tooltip, /is locked: unlock it first/);
  assert.match(card.vs, /^vs .* \(equipped\)$/);
  assert.ok(card.deltas.length > 0 && card.deltas.length <= 6);
  assert.ok(card.score && /^[+−]\d+\.\d%$/.test(card.score.text), card.score && card.score.text);
  const pol = card.actions.find((a) => a.cmd === "polish");
  const cost = I.nextPolishCost(world.state, fit);
  if (cost) assert.equal(pol.cost, `${F.fmtNum(cost.gold)} gold · ${cost.snippets} ${cost.snippets === 1 ? "Snippet" : "Snippets"}`);
  // a too-high item level
  const lvl = I.rollItem(world.state.herd, { ilvl: hero.L + 20, source: "chest", slot: "hat", rar: 2, state: world.state });
  world.state.herd.stash.push(lvl);
  world.rt.version++;
  if (F.reqLevel(lvl.ilvl) > hero.L) {
    const c2 = V.sheetView(world, { heroId: hero.id, tab: "gear", filter: { ...FILTER, focus: lvl.uid } }).gear.card;
    assert.match(c2.actions.find((a) => a.cmd === "equip").tooltip, /^Needs Lv \d+/);
  }
  // Keepsakes are never deprecated
  const ks = world.state.herd.stash.find((it) => it.rar === 5);
  if (ks) {
    const c3 = V.herdView(world, { tab: "stash", filter: { ...FILTER, focus: ks.uid } }).stash.card;
    const dep = c3.actions.find((a) => a.cmd === "deprecate");
    assert.equal(dep.enabled, false);
    assert.equal(dep.tooltip, "Keepsakes are never deprecated");
    assert.ok(c3.prop && c3.prop.name && c3.flavor);
  }
});

test("rules: the card falls back from a vanished hovered item to the selection", () => {
  const world = D.demoWorld("late", NOW).world;
  const hero = world.state.heroes[0];
  const [a, b] = world.state.herd.stash.filter((it) => !(it.flags & I.FLAG_LOCKED) && it.rar < 5);
  const f = { ...FILTER, focus: a.uid, hover: a.uid, selected: b.uid };
  assert.equal(V.sheetView(world, { heroId: hero.id, tab: "gear", filter: f }).gear.card.uid, a.uid);
  assert.equal(W.command(world, "deprecate", { uid: a.uid }, NOW).ok, true);
  assert.equal(V.sheetView(world, { heroId: hero.id, tab: "gear", filter: f }).gear.card.uid, b.uid, "hovered item gone: the selection shows");
  assert.equal(V.herdView(world, { tab: "stash", filter: f }).stash.card.uid, b.uid);
  assert.equal(V.sheetView(world, { heroId: hero.id, tab: "gear", filter: { ...f, selected: null } }).gear.card, null);
});

test("rules: lists are capped (stash 32 rows / 48 tiles + more, digest 8 per section, journal 30) and sorted as asked", () => {
  const world = D.demoWorld("late", NOW).world;
  const hero = world.state.heroes[0];
  assert.ok(world.state.herd.stash.length > 48);
  const g = V.sheetView(world, { heroId: hero.id, tab: "gear", filter: FILTER }).gear;
  assert.equal(g.stash.items.length, 32);
  assert.equal(g.stash.more, `+${world.state.herd.stash.length - 32} more: narrow the filter`);
  assert.equal(g.stash.count, `${world.state.herd.stash.length} / ${I.stashCap(world.state)}`);
  // score sort: scored (wearable) items first, best first
  const scored = g.stash.items.filter((x) => x.delta);
  const vals = scored.map((x) => Number(x.delta.text.replace("−", "-").replace("%", "")));
  assert.deepEqual(vals, vals.slice().sort((x, y) => y - x));
  assert.ok(g.stash.items.slice(0, scored.length).every((x) => x.delta), "scored items come first");
  // scores are priced 16 per view (QuickJS budget); a few ticks later every wearable item has one
  const fit = world.state.herd.stash.filter((it) => I.canEquip(hero, it, { ignoreLevel: true })).length;
  for (let k = 0; k < Math.ceil(fit / 16) + 1; k++) {
    world.rt.version++;
    V.sheetView(world, { heroId: hero.id, tab: "gear", filter: { ...FILTER, slot: "all", minRar: 0 } });
  }
  world.rt.version++;
  const all = V.sheetView(world, { heroId: hero.id, tab: "gear", filter: FILTER }).gear.stash.items;
  const want = all.filter((x) => world.state.herd.stash.some((it) => it.uid === x.uid && I.canEquip(hero, it, { ignoreLevel: true })));
  assert.ok(want.every((x) => x.delta), "every wearable item priced after a few ticks");
  // IP sort and filters
  const ip = V.sheetView(world, { heroId: hero.id, tab: "gear", filter: { ...FILTER, sort: "ip", slot: "hat", minRar: 2 } }).gear.stash;
  const ips = ip.items.map((x) => Number(x.ip.replace(/,/g, "")));
  assert.deepEqual(ips, ips.slice().sort((x, y) => y - x));
  assert.ok(ip.items.every((x) => x.rar >= 2 && x.icon === "ui/slot-hat.svg"));
  assert.equal(ip.filters.slot.find((c) => c.on).key, "slot-hat");
  assert.equal(ip.filters.rarity.find((c) => c.on).key, "rar-2");
  assert.equal(ip.filters.sort.find((c) => c.on).key, "sort-ip");
  // usable: only what the hero can wear
  const us = V.sheetView(world, { heroId: hero.id, tab: "gear", filter: { ...FILTER, usable: true } }).gear.stash;
  assert.ok(us.items.every((x) => x.usable));
  // the herd grid caps too
  assert.equal(V.herdView(world, { tab: "stash", filter: FILTER }).stash.items.length, 48);
  // digest sections: at most 8 lines (the 8th says how many more)
  const d = V.herdView(big(), { tab: "digest", filter: FILTER }).digest;
  for (const s of d.sections) assert.ok(s.lines.length <= 8, `${s.key}: ${s.lines.length}`);
  // journal
  const j = V.sheetView(world, { heroId: hero.id, tab: "journal", filter: FILTER }).journal;
  assert.ok(j.lines.length <= 30);
});

test("rules: Squash Merge needs CI Forge 3 and accepts only 3 unlocked stash items of one rarity", () => {
  const first = D.demoWorld("first-day", NOW).world;
  const sq0 = V.herdView(first, { tab: "stash", filter: FILTER }).stash.squash;
  assert.equal(sq0.available, false);
  assert.match(sq0.reason, /CI Forge level 3/);
  const world = D.demoWorld("late", NOW).world;
  const herd = world.state.herd;
  const mk = (rar, locked) => {
    const it = I.rollItem(herd, { ilvl: 80, source: "chest", slot: "hat", rar, state: world.state });
    if (locked) it.flags |= I.FLAG_LOCKED;
    herd.stash.push(it);
    return it.uid;
  };
  const a = mk(1), b = mk(1), lockedOne = mk(1, true), beta = mk(2), c = mk(1);
  world.rt.version++;
  const sq = V.herdView(world, { tab: "stash", filter: { ...FILTER, squash: [a, lockedOne, beta, b] } }).stash.squash;
  assert.deepEqual(sq.picked, [a, b], "a locked item and another rarity are refused");
  const items = V.herdView(world, { tab: "stash", filter: { ...FILTER, squash: [a, b] } }).stash.items;
  assert.equal(items.find((x) => x.uid === lockedOne)?.squashable ?? false, false);
  assert.equal(items.find((x) => x.uid === beta)?.squashable ?? false, false, "another rarity than the picks");
  assert.equal(sq.action.enabled, false);
  const sq3 = V.sheetView(world, { heroId: world.state.heroes[0].id, tab: "gear", filter: { ...FILTER, squash: [a, b, c] } }).gear.squash;
  assert.deepEqual(sq3.picked, [a, b, c]);
  assert.equal(sq3.label, "3 of 3 Alpha picked → 1 Beta item");
  assert.equal(sq3.action.enabled, true);
  assert.match(sq3.action.cost, / gold$/);
  assert.equal(W.command(world, sq3.action.cmd, sq3.action.args, NOW).ok, true);
});

test("rules: skills, career, stats and journal read the engine (ranks, gates, reviews, signature, why)", () => {
  const world = D.demoWorld("mid", NOW).world;
  for (const hero of world.state.heroes) {
    const sk = V.sheetView(world, { heroId: hero.id, tab: "skills", filter: FILTER }).skills;
    assert.equal(sk.skills.length, 7);
    assert.equal(sk.sp.count, hero.spFree);
    for (const s of sk.skills) {
      assert.equal(s.rankText, `${s.rank}/${s.max}`);
      if (s.locked) assert.equal(s.learn, null);
      if (s.rank >= s.max) assert.equal(s.learn, null);
      assert.ok(s.effect.length > 4 && !/undefined|NaN/.test(s.effect), s.effect);
    }
    const ca = V.sheetView(world, { heroId: hero.id, tab: "career", filter: FILTER }).career;
    assert.equal(ca.ladder.length, 5);
    assert.equal(ca.ladder.filter((l) => l.state === "current").length, 1);
    assert.equal(ca.classes.options.length, 5);
    assert.equal(ca.classes.options.filter((o) => o.current).length, 1);
    assert.match(ca.signature.text, /median task \d+ min · \d+\.\d blocks\/h · \d+% with sub-agents/);
    if (hero.L >= 20) assert.ok(ca.classes.options.filter((o) => !o.current).every((o) => /Snippets$/.test(o.cost)));
    const stv = V.sheetView(world, { heroId: hero.id, tab: "stats", filter: FILTER }).stats;
    assert.equal(stv.groups.length, 4);
    assert.match(stv.why.total, /XP\/min$/);
  }
  // a Lv 30 Junior has the Senior Review ready (badge on the Career tab)
  const ready = world.state.heroes.find((h) => h.L >= 30 && !h.rev[0]);
  if (ready) {
    const vm = V.sheetView(world, { heroId: ready.id, tab: "career", filter: FILTER });
    assert.equal(vm.tabs.find((t) => t.id === "career").badge, "!");
    assert.equal(vm.career.ladder[2].review.status, "ready");
  }
  // the first-day Interns: classes picked for Lv 10, no Snippet costs
  const fd = demo("first-day");
  const ca = V.sheetView(fd, { heroId: fd.state.heroes[0].id, tab: "career", filter: FILTER }).career;
  assert.match(ca.classes.note, /Lv 10/);
  assert.ok(ca.classes.options.every((o) => o.cost === null && o.enabled));
  // the journal shows the hero's own lines, newest first
  const j = V.sheetView(fd, { heroId: fd.state.heroes[0].id, tab: "journal", filter: FILTER }).journal;
  const own = fd.state.herd.log.filter((e) => e[2] === fd.state.heroes[0].id);
  assert.equal(j.lines.length, Math.min(30, own.length));
});

test("rules: the bosses, tracker and upgrades tabs follow the herd (doors, Sprint, Backlog, perks, building costs)", () => {
  const mid = demo("mid");
  const b = V.herdView(mid, { tab: "bosses", filter: FILTER }).bosses;
  assert.deepEqual(b.bosses.map((x) => x.state).slice(0, 4), ["fixed", "fixed", "sprint", "locked"]);
  assert.match(b.bosses[2].stateText, /^Map 3-3: \d+ \/ 40 kills$/);
  assert.equal(b.bosses[3].name, "???");
  assert.equal(b.backlog.locked, true);
  const late = demo("late");
  const lb = V.herdView(late, { tab: "bosses", filter: FILTER }).bosses;
  assert.ok(lb.bosses.every((x) => x.state === "fixed" || x.state === "fighting"), "late: every boss beaten (one being farmed)");
  if (lb.fight) assert.ok(lb.bosses.filter((x) => x.challenge).every((x) => !x.challenge.enabled && x.challenge.tooltip === "A boss fight is on"));
  assert.equal(lb.backlog.locked, false);
  assert.match(lb.backlog.text, /^Floor 14 · next boss on floor 20/);
  assert.equal(lb.backlog.progress.text, "23 / 50 kills");
  const tr = V.herdView(mid, { tab: "tracker", filter: FILTER }).tracker;
  assert.equal(tr.zones.length, 9);
  assert.equal(tr.selected, "regex_ruins");
  assert.equal(tr.zones[0].mobs.length, 3);
  assert.ok(tr.zones.slice(3).every((z) => z.locked && z.name === "???"));
  const up = V.herdView(mid, { tab: "upgrades", filter: FILTER }).upgrades;
  assert.equal(up.buildings.length, 6);
  for (const bv of up.buildings) {
    const def = DATA.BUILDINGS.find((x) => x.id === bv.id);
    if (bv.buy) assert.equal(bv.buy.cost, `${F.fmtNum(F.buildingCost(def, bv.level + 1))} gold`);
    assert.equal(bv.levelText, `${bv.level} / ${def.max}`);
  }
});

// ---------------------------------------------------------------------------------------------
// the samples obey the item rules (they are the spec)

const ARMOR = DATA.ITEM_BASES.armor;
const WEAPONS = DATA.ITEM_BASES.weapons;
const CLS_WEAPON = Object.fromEntries(DATA.CLASSES.map((c) => [c.id, c.weapon]));

/** Is `name` one items.itemName could give an item of this slot / class / rarity / iLvl / polish? */
function nameProblem(it, slot, cls) {
  const m = /^(.*?)(?: \+(\d+))?$/.exec(it.name);
  const name = m[1];
  const pol = Number(m[2] || 0);
  if (it.pol && it.pol !== `+${pol}`) return `polish ${it.pol} vs name +${pol}`;
  if (pol > F.polishMax(it.rar)) return `+${pol} over the ${DATA.RARITIES[it.rar].name} max ${F.polishMax(it.rar)}`;
  const ilvl = Number(it.ilvl.replace(/^iLvl /, ""));
  const t = F.itemTier(ilvl);
  if (it.rar === 5) return DATA.KEEPSAKES.some((k) => k.name === name && (k.slot === slot || (k.slot === "weapon" && slot === "weapon"))) ? null : `not a ${slot} Keepsake`;
  const base = slot === "weapon"
    ? (cls === "intern" || !cls ? "Training Stick" : WEAPONS[CLS_WEAPON[cls]][t - 1])
    : ARMOR[slot][t - 1];
  if (it.rar === 0) return name === base ? null : `Prototype should be "${base}"`;
  if (it.rar === 4) return DATA.LTS_PROPS.some((p) => (p.slot === slot || p.slot === "any") && name === `${p.name} ${base}`) ? null : `LTS should be "[property] ${base}"`;
  const at = name.indexOf(base);
  if (at < 0) return `base should be "${base}" (tier ${t})`;
  const pre = name.slice(0, at).trim();
  const suf = name.slice(at + base.length).trim();
  const ok = (n, kind) => !n || DATA.AFFIXES.some((a) => a.name === n && a.kind === kind && a.slots.includes(slot));
  if (!ok(pre, "prefix")) return `"${pre}" is not a ${slot} prefix`;
  if (!ok(suf, "suffix")) return `"${suf}" is not a ${slot} suffix`;
  if (it.rar === 1) return pre && suf ? "an Alpha names one affix" : !pre && !suf ? "an Alpha names its affix" : null;
  // Beta / Release: [first prefix] Base [first suffix]; with no suffix every affix is a prefix (and vice versa)
  const n = DATA.RARITIES[it.rar].affixes + (slot === "sticker" ? 1 : 0);
  const pres = DATA.AFFIXES.filter((a) => a.kind === "prefix" && a.slots.includes(slot)).length;
  const sufs = DATA.AFFIXES.filter((a) => a.kind === "suffix" && a.slots.includes(slot)).length;
  if (!suf && n > pres) return `${n} affixes cannot all be ${slot} prefixes`;
  if (!pre && n > sufs) return `${n} affixes cannot all be ${slot} suffixes`;
  return null;
}

function sampleItems(vm, heroL) {
  const out = [];
  const g = vm && (vm.gear || vm.stash);
  if (!g) return out;
  for (const s of g.slots || []) if (s.item) out.push([s.item, s.slot]);
  for (const it of (g.stash || g).items || []) out.push([it, null]);
  if (g.card) out.push([g.card, null]);
  return out.map(([it, slot]) => {
    const sl = slot || (it.icon.startsWith("gear/weapon-") ? "weapon" : it.icon.replace(/^ui\/slot-|\.svg$/g, ""));
    const cls = sl === "weapon" ? it.icon.replace(/^gear\/weapon-|\.svg$/g, "") : null;
    return { it, slot: sl, cls, heroL };
  });
}

test("rules: a provisional class: the header tag links to Career, whose current class chip locks it (setClass, free)", () => {
  const world = D.demoWorld("mid", NOW).world;
  const hero = world.state.heroes.find((h) => h.cls > 0 && world.rt.live.has(h.id));
  hero.prov = 1;
  world.rt.version++;
  const vm = V.sheetView(world, { heroId: hero.id, tab: "career", filter: FILTER });
  assertShape(vm, S.scenarios.provisional, "provisional");
  assert.equal(vm.header.tag, "provisional");
  assert.equal(vm.header.tagTab, "career");
  assert.match(vm.header.tagTip, /^Provisional class \(\d+ of \d+ tasks\): .* Lock it with its class chip on the Career tab\.$/);
  const cur = vm.career.classes.options.find((o) => o.current);
  assert.equal(cur.lock, true);
  assert.equal(cur.enabled, true);
  assert.equal(cur.confirm, `Lock ${cur.label}?`);
  assert.match(cur.tooltip, /^Lock \w+ now \(free\)\. Provisional class/);
  assert.ok(vm.career.classes.options.every((o) => o.lock === (o === cur)));
  const r = W.command(world, cur.cmd, cur.args, NOW);
  assert.equal(r.ok, true, r.error);
  assert.equal(hero.prov, 0, "the same class locks it");
  const after = V.sheetView(world, { heroId: hero.id, tab: "career", filter: FILTER });
  assert.equal(after.header.tag, null);
  assert.equal(after.header.tagTab, null);
  assert.equal(after.header.tagTip, null);
  assert.ok(after.career.classes.options.every((o) => o.lock === false));
  // a locked class in an untouched world: no tag, no link
  const plain = V.sheetView(demo("mid"), { heroId: demo("mid").state.heroes[0].id, tab: "gear", filter: FILTER }).header;
  assert.equal(plain.tagTab, null);
  assert.equal(plain.tagTip, null);
});

test("rules: the career boss card offers Retreat while its zone boss fight runs or is paused (D§11.16)", () => {
  for (const paused of [false, true]) {
    const world = D.demoWorld("boss", NOW).world;
    if (paused) {
      // a suspended fight lives only in herd.fight (D§9.5)
      assert.ok(world.state.herd.fight, "the running fight is mirrored in herd.fight");
      world.rt.fights = world.rt.fights.filter((f) => f.kind !== "boss");
      world.rt.version++;
    }
    const heroId = world.state.heroes[0].id;
    const b = V.sheetView(world, { heroId, tab: "career", filter: FILTER }).career.boss;
    assert.match(b.status, paused ? /^Fight paused$/ : /^Fighting: \d+% left$/);
    assert.equal(b.challenge.cmd, "retreat");
    assert.deepEqual(b.challenge.args, {});
    assert.equal(b.challenge.tone, "danger");
    assert.equal(b.challenge.confirm, "Retreat? (a Postmortem)");
    assert.equal(b.challenge.enabled, true);
    assert.equal(b.fighting, true, "the card leads the Career tab while the fight is on");
    const r = W.command(world, b.challenge.cmd, b.challenge.args, NOW);
    assert.equal(r.ok, true, r.error);
    const after = V.sheetView(world, { heroId, tab: "career", filter: FILTER }).career.boss;
    assert.doesNotMatch(after.status, /^Fight/);
    assert.notEqual(after.challenge?.cmd, "retreat");
    assert.equal(after.fighting, false, "back after the ladder");
  }
  // no fight anywhere: every hero's card is in its place after the ladder
  for (const kind of ["mid", "first-day", "blocked"]) {
    const world = demo(kind);
    for (const h of world.state.heroes) {
      const b = V.sheetView(world, { heroId: h.id, tab: "career", filter: FILTER }).career.boss;
      if (b) assert.equal(b.fighting, false, `${kind}/${h.id}`);
    }
  }
});

test("rules: a locked zone's tracker row says Locked (not 0 / 500); the empty roster says how a hero comes; the CI Forge line fits; a never-read digest has no \"last looked\"", () => {
  const tr = V.herdView(demo("mid"), { tab: "tracker", filter: FILTER }).tracker;
  for (const z of tr.zones) {
    if (z.locked) assert.deepEqual(z.progress, { frac: 0, text: "Locked" }, z.key);
    else assert.match(z.progress.text, /^[\d,]+ (\/ [\d,]+|· Fixed)$/, z.key);
  }
  assert.ok(tr.zones.some((z) => z.locked) && tr.zones.some((z) => !z.locked));
  const empty = V.herdView(demo("empty"), { tab: "roster", filter: FILTER }).roster;
  assert.deepEqual(empty.groups, []);
  assert.equal(empty.emptyText, "No heroes yet. Start an agent to hire one: every coding agent becomes a Termling.");
  assert.equal(typeof V.herdView(demo("mid"), { tab: "roster", filter: FILTER }).roster.emptyText, "string");
  // the CI Forge: "Polish −N%" with what it unlocked, like the sample (the tooltip names the gold)
  const forge = (kind) => V.herdView(demo(kind), { tab: "upgrades", filter: FILTER }).upgrades.buildings.find((b) => b.id === "ci_forge");
  assert.match(forge("late").effect, /^Polish −\d+% · Squash · Reroll$/);
  assert.match(forge("mid").effect, /^Polish −\d+%$/);
  assert.match(forge("late").tooltip, /^Polish gold −4% per level/);
  // an empty digest: "since you last looked" only once someone has
  const d0 = V.herdView(demo("empty"), { tab: "digest", filter: FILTER }).digest;
  assert.deepEqual([d0.since, d0.sections.length], ["Since the herd began", 0]);
  assert.equal(d0.emptyText, "Nothing yet: levels, big drops, bosses and shipped tasks land here.");
  const looked = D.demoWorld("mid", NOW).world;
  assert.equal(W.command(looked, "digestSeen", {}, NOW).ok, true);
  const d1 = V.herdView(looked, { tab: "digest", filter: FILTER, nowMs: NOW }).digest;
  assert.match(d1.since, /^Since you last looked/);
  assert.equal(d1.emptyText, "Nothing new since you last looked.");
});

test("rules: a running review's line starts with what is left (beside its Retreat, armed or not, the line is cut at its end)", () => {
  const world = D.demoWorld("late", NOW).world;
  world.state.heroes.find((h) => h.id === 1).rev = [1, 0];
  world.rt.version++;
  const rung = () => V.sheetView(world, { heroId: 1, tab: "career", filter: FILTER }).career.ladder.find((l) => l.key === "staff").review;
  assert.equal(rung().challenge.cmd, "challenge");
  assert.equal(W.command(world, "challenge", rung().challenge.args, NOW).ok, true);
  world.rt.version++;
  const r = rung();
  assert.equal(r.status, "running");
  assert.match(r.statusText, /^\d+% left against \S/);
  assert.equal(r.challenge.cmd, "retreat");
});

test("rules: the Herd header gives the blocked count apart (waiting) so the panel can colour it", () => {
  let some = 0, none = 0;
  for (const kind of D.DEMO_KINDS) {
    const h = V.herdView(demo(kind), { tab: "upgrades", filter: FILTER }).header;
    if (/waiting for you/.test(h.sub)) {
      some++;
      assert.match(h.waiting, /^\d+ waiting for you$/, kind);
      assert.ok(h.sub.endsWith(` · ${h.waiting}`), kind);
    } else {
      none++;
      assert.equal(h.waiting, null, kind);
    }
  }
  assert.ok(some > 0 && none > 0, `both cases covered (${some} / ${none})`);
});

test("rules: the item-score cache keeps only live heroes (Contractor churn does not grow it)", () => {
  const { world, snapshot } = D.demoWorld("mid", NOW);
  let now = NOW;
  const hired = [];
  for (let i = 1; i <= 12; i++) {
    // an agent past today's roster becomes a Contractor (a fresh negative id each time); its gear
    // sheet prices items; then it leaves
    const ag = { ...snapshot.agents[0], address: `tc${i}`, pane: `p_tc${i}`, seq: 700 + i, focused: false };
    now += 1000;
    W.tick(world, { ...snapshot, nowMs: now, agents: [...snapshot.agents, ag] });
    const id = world.rt.bind.get(`tc${i}`);
    assert.ok(id < 0, "a Contractor");
    hired.push(id);
    assert.ok(V.sheetView(world, { heroId: id, tab: "gear", filter: FILTER, nowMs: now }).gear.stash.items.length > 0);
    now += 1000;
    W.tick(world, { ...snapshot, nowMs: now, agents: snapshot.agents });
  }
  assert.equal(new Set(hired).size, hired.length);
  assert.equal(world.rt.contractors.size, 0, "every Contractor left");
  const roster = new Set(world.state.heroes.map((h) => h.id));
  let cached = P._scoreCacheIds();
  assert.ok(cached.length <= 1, `at most the last Contractor stays until the next entry: ${cached}`);
  for (const h of world.state.heroes) V.sheetView(world, { heroId: h.id, tab: "gear", filter: FILTER, nowMs: now });
  cached = P._scoreCacheIds();
  assert.ok(cached.every((id) => roster.has(id)), `only roster heroes: ${cached}`);
  assert.ok(cached.length <= roster.size);
});

test("samples: every sample item is one the engine could make (name, tier base, affix slots, polish, required level)", () => {
  const problems = [];
  const views = [];
  for (const name of Object.keys(S.scenarios)) {
    const vm = S.scenarios[name];
    if (!vm || vm.missing) continue;
    // Rue's, Pip's and Juno's samples borrow Kip's gear for the Gear tab (viewFor): no level check there
    const L = vm.heroId === 2 || vm.heroId === 5 || vm.heroId === 7 ? null : Number(String(vm.header.level).replace(/^Lv /, ""));
    for (const f of [{}, { focus: 921 }, { focus: 803 }, { focus: 2101 }]) views.push([`sheet/${name}`, S.viewFor(name, { tab: "gear", filter: f }), L]);
  }
  for (const name of Object.keys(H.scenarios)) for (const f of [{}, { focus: 921 }, { focus: 951 }]) views.push([`herd/${name}`, H.viewFor(name, { tab: "stash", filter: f }), null]);
  for (const [where, vm, L] of views) {
    for (const { it, slot, cls, heroL } of sampleItems(vm, L)) {
      const p = nameProblem(it, slot, cls);
      if (p) problems.push(`${where} ${it.uid} "${it.name}": ${p}`);
      if (heroL != null && where.startsWith("sheet") && it.usable === true) {
        const req = F.reqLevel(Number(it.ilvl.replace(/^iLvl /, "")));
        if (req > heroL) problems.push(`${where} ${it.uid} "${it.name}": usable at Lv ${heroL} but needs Lv ${req}`);
      }
      if (it.sub) {
        const req = F.reqLevel(Number(it.ilvl.replace(/^iLvl /, "")));
        if (!it.sub.endsWith(`req Lv ${req}`)) problems.push(`${where} card ${it.uid}: sub "${it.sub}" (req Lv ${req})`);
      }
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

// ---------------------------------------------------------------------------------------------
// performance

// Bounds that hold under load (parallel test files, a browser shooting previews). Load only adds
// time spent waiting for a CPU, so each figure is the lower of the wall clock and the process's
// CPU time (which never counts waiting, but does count GC and compiler threads), taken as the best
// of several batches after a warm-up; each batch averages a few runs, against timer granularity.
// (The same recipe as test/view-chrome.test.mjs.)

/** The best per-run cost (ms) of `batches` batches of `per` runs of fn, after one warm-up run. */
function bestMs(fn, { batches = 7, per = 5 } = {}) {
  fn();
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    for (let k = 0; k < per; k++) fn();
    const wall = performance.now() - t0;
    const c = process.cpuUsage(c0);
    best = Math.min(best, Math.min(wall, (c.user + c.system) / 1000) / per);
  }
  return best;
}

test("perf: bestMs and renderCost ignore time spent waiting for a CPU, never work done", async () => {
  // busy until both this process's CPU time and the wall clock have run `ms`: no measure may come
  // in under it. (The CPU time alone is not enough: it counts V8's helper threads too, whose time
  // lands in steps, so it can pass `ms` before the loop has run that long; that made this flaky.)
  const spin = (ms) => {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    for (let c = { user: 0, system: 0 }; (c.user + c.system) / 1000 < ms || performance.now() - t0 < ms; c = process.cpuUsage(c0)) { /* busy */ }
  };
  const busy = bestMs(() => spin(4), { batches: 3, per: 2 });
  assert.ok(busy >= 4 - 0.01, `CPU work counts: ${busy.toFixed(2)} ms per spin(4)`);
  // a wait (another process holding the CPU looks the same from here: wall time, no CPU time);
  // helper threads can add some CPU time to a window, so the best of a few windows is taken
  const wait = (ms) => { const t = performance.now(); while (performance.now() - t < ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); };
  const idle = bestMs(() => wait(30), { batches: 4, per: 1 });
  assert.ok(idle < 15, `waiting does not count: ${idle.toFixed(2)} ms per wait(30)`);
  const world = demo("mid");
  const { m, role } = await mount("sheet", world, { props: { heroId: world.state.heroes[0].id, tab: "career" } });
  role.host.view = ((view) => function (kind, args) { wait(60); return view.call(this, kind, args); })(role.host.view);
  world.rt.version++;
  const waited = bestRenderMs(m, 3);
  assert.ok(waited < M.BUDGET.render, `a render that only waited (60 ms) fits the budget: ${waited.toFixed(2)} ms`);
  assert.deepEqual(errorsOf(m), [], "and no budget error is left (the mock's stopwatch, or errorsOf's best of 5)");
});

test("perf: view + render per call stays well inside the 50 ms render budget in V8 (QuickJS is ~30× slower)", async (t) => {
  const world = D.demoWorld("late", NOW).world;
  const heroId = world.state.heroes[0].id;
  // cold views: memo and the per-version index reset by a new world version each time, the card
  // on another stash item each run
  const tabs = [["sheet", "gear"], ["sheet", "skills"], ["sheet", "career"], ["sheet", "stats"], ["herd", "stash"], ["herd", "bosses"], ["herd", "roster"], ["herd", "tracker"], ["herd", "digest"]];
  const stash = world.state.herd.stash;
  const cold = [];
  for (const [k, tab] of tabs) {
    let i = 0;
    const ms = bestMs(() => {
      world.rt.version++;
      P._resetPanelsMemo();
      const filter = { ...FILTER, focus: stash[i++ % stash.length].uid };
      if (k === "sheet") V.sheetView(world, { heroId, tab, filter });
      else V.herdView(world, { tab, filter });
    }, { batches: 5, per: 3 });
    cold.push(`${k}/${tab} ${ms.toFixed(2)}`);
    assert.ok(ms < 8, `${k}/${tab}: ${ms.toFixed(2)} ms per cold view (best batch)`);
  }
  t.diagnostic(`cold views (ms, best batch; bound 8): ${cold.join(", ")}`);
  // view + render through the role: every tab, a fresh world version per render, each render's
  // cost as renderCost() takes it, the best of 5; the worst tab must fit
  let worst = 0;
  const { m, role } = await mount("sheet", world, { props: { heroId, tab: "gear" }, ui: { selected: stash[0].uid } });
  for (const tab of SHEET_TABS) {
    role.ui.tab = tab;
    let best = Infinity;
    for (let b = 0; b < 5; b++) {
      world.rt.version++;
      best = Math.min(best, renderCost(m));
    }
    worst = Math.max(worst, best);
    assertClean(m, `perf sheet/${tab}`);
  }
  const h = await mount("herd", world, { ui: { selected: stash[0].uid } });
  for (const tab of HERD_TABS) {
    h.role.ui.tab = tab;
    let best = Infinity;
    for (let b = 0; b < 5; b++) {
      world.rt.version++;
      best = Math.min(best, renderCost(h.m));
    }
    worst = Math.max(worst, best);
    assertClean(h.m, `perf herd/${tab}`);
  }
  t.diagnostic(`worst view + render: ${worst.toFixed(2)} ms (best of 5 per tab; bound 40)`);
  assert.ok(worst < 40, `worst view + render ${worst.toFixed(1)} ms (best of 5 per tab)`);
});

test("rules: args.save (host.saveStatus()) becomes the Herd panel's save band (D§13.4); none while the save is fine", () => {
  const world = demo("mid");
  assert.equal(V.herdView(world, { tab: "roster", filter: FILTER }).save, null);
  const st = {
    readOnly: true, notSaving: false, restoredFrom: null, title: "Save is read-only",
    message: "This save is from a newer version of Down the Stack, so it was opened read-only.",
    detail: "Save is from a newer version (v2); opened read-only", since: NOW,
  };
  for (const tab of HERD_TABS) {
    const vm = V.herdView(world, { tab, filter: FILTER, save: st });
    assert.deepEqual(vm.save, { title: st.title, text: st.message, tooltip: st.detail }, tab);
    assertShape(vm, { ...HERD_SAMPLE[tab], save: H.scenarios.saveReadOnly.save }, `save/${tab}`);
  }
  // the memo keys on it: the band goes away with the trouble, without a world change
  assert.equal(V.herdView(world, { tab: "roster", filter: FILTER }).save, null);
  // a status without a title (an older host) still reads
  assert.equal(V.herdView(world, { tab: "roster", filter: FILTER, save: { notSaving: true, message: "x" } }).save.title, "Not saving");
});

test("rules: digest lines without a date read \"earlier\" (never Jan 1); first clears come from herd.bossAt", () => {
  const world = demo("mid");
  const herd = world.state.herd;
  // a kill the journal no longer has, before the digest was ever read: herd.digest gives at null
  herd.digestAt = 0;
  herd.digestSnap = null;
  herd.log = herd.log.filter((e) => e[1] !== "boss");
  herd.bossKills[0] = (herd.bossKills[0] || 0) + 1;
  world.rt.version++;
  const d = V.herdView(world, { tab: "digest", filter: FILTER }).digest;
  const lines = d.sections.flatMap((s) => s.lines);
  assert.ok(lines.length > 0);
  for (const l of lines) assert.doesNotMatch(String(l.sub ?? ""), /^Jan 1$/, l.text);
  assert.ok(lines.some((l) => l.sub === "earlier"), "an undated kill says so");
  // the bosses tab: the first-clear date survives the journal (herd.bossAt)
  const at = DATA.BOSSES.findIndex((_, bi) => herd.boss[bi]);
  assert.ok(at >= 0);
  const row = V.herdView(world, { tab: "bosses", filter: FILTER }).bosses.bosses.find((r) => r.key === DATA.BOSSES[at].id);
  assert.match(String(row.firstClear), /^First fixed \w+ \d+$/);
});

test("rules: the sheet names a terminal's work as the party does, never a bare program, shell or prompt title (quest line, Bind tooltips)", () => {
  const world = D.demoWorld("mid", NOW).world;
  const cast = world.rt.demo.cast.agents;
  const t1 = cast.find((a) => a.address === "t1"); // Claude Code, working, "Fix flaky auth test"
  const h1 = world.rt.bind.get("t1");
  const quest = () => V.sheetView(world, { heroId: h1, tab: "gear", filter: FILTER }).header.quest;
  advance(world, 1);
  assert.equal(quest(), "Fix flaky auth test");
  // the agent retitles itself after its program: the task's title still names the work
  t1.titles = ["✳ claude"];
  advance(world, 1);
  assert.equal(quest(), "Fix flaky auth test");
  // a task with no telling title (opened under its program's name): a pane name the person gave,
  // else nothing (the old line printed the raw "✳ claude")
  world.rt.live.get(h1).task.title = "";
  t1.tabName = "1";
  advance(world, 1);
  assert.equal(quest(), null);
  t1.paneName = "auth fixes";
  advance(world, 1);
  assert.equal(quest(), "auth fixes");
  // the Career tab's Bind buttons on an off-duty hero name each live agent's work the same way
  const t3 = cast.find((a) => a.address === "t3");
  const h3 = world.rt.bind.get("t3");
  Object.assign(t3, { plan: [["gone", 1e9]], phase: 0, left: 1e9, status: "gone" });
  t1.paneName = null;
  t1.tabName = "Claude Code"; // a tab named after its program tells nothing either
  advance(world, 1);
  const rebind = V.sheetView(world, { heroId: h3, tab: "career", filter: FILTER }).career.rebind;
  assert.ok(rebind && rebind.options.length, "the off-duty hero can bind a live agent");
  const tip = rebind.options.find((o) => o.args.address === "t1").tooltip;
  assert.doesNotMatch(tip, /“/, tip);
  assert.doesNotMatch(tip, /claude”/i, tip);
  world.rt.live.get(h1).task.title = "Fix flaky auth test";
  advance(world, 1);
  const tip2 = V.sheetView(world, { heroId: h3, tab: "career", filter: FILTER }).career.rebind.options.find((o) => o.args.address === "t1").tooltip;
  assert.match(tip2, /· “Fix flaky auth test” \(/, tip2);
  // the digest's "Chests waiting" line quotes a chest's task, never a shell name an older save kept
  const fd = D.demoWorld("first-day", NOW).world;
  const hero = fd.state.heroes.find((h) => h.id === fd.rt.bind.get("t1"));
  const waiting = () => V.herdView(fd, { tab: "digest", filter: FILTER }).digest.sections.find((x) => x.key === "chests").lines.find((l) => l.key === `c:${hero.id}`);
  assert.equal(waiting().sub, "“Add retry to webhook sender”");
  hero.pend[0].title = "zsh";
  fd.rt.version++;
  assert.equal(waiting().sub, null);
});

test("rules: a chest that opened Unreviewed reads in the hero's journal and the digest (where the chest went)", () => {
  const world = D.demoWorld("first-day", NOW).world;
  const hero = world.state.heroes[0];
  Herd.journal(world.state, "unrev", hero.id, "Add retry to webhook sender", 1, NOW - 60000);
  Herd.journal(world.state, "unrev", hero.id, "", 3, NOW - 30000);
  world.rt.version++;
  const j = V.sheetView(world, { heroId: hero.id, tab: "journal", filter: FILTER }).journal.lines.map((l) => l.text);
  assert.ok(j.includes("Chest opened Unreviewed: “Add retry to webhook sender” (half value, no Seals)"), j.join(" | "));
  assert.ok(j.includes("3 chests opened Unreviewed (half value, no Seals)"), j.join(" | "));
  const d = V.herdView(world, { tab: "digest", filter: FILTER }).digest;
  const sec = d.sections.find((x) => x.key === "unreviewed");
  assert.ok(sec, "an 'Opened Unreviewed' section");
  assert.equal(sec.title, "Opened Unreviewed");
  const first = hero.name.split(" ")[0];
  assert.deepEqual(sec.lines.map((l) => [l.text, l.sub]), [
    [`${first}: 3 chests opened Unreviewed`, "half value, no Seals · 09:29"],
    [`${first}'s chest opened Unreviewed: “Add retry to webhook sender”`, "half value, no Seals · 09:29"],
  ]);
});

test("rules (round 4): the digest leads with Opened Unreviewed (losses before gains), each line with its time; viewing it sees the losses", () => {
  const world = D.demoWorld("mid", NOW).world;
  const hero = world.state.heroes[0];
  const first = hero.name.split(" ")[0];
  // a night's work since the last read: levels and shipped tasks (the demo), then two losses
  Herd.journal(world.state, "unrev", hero.id, "", 2, NOW - 26 * 3600000);
  Herd.journal(world.state, "unrev", hero.id, "Bump the lockfile", 1, NOW - 3 * 3600000);
  world.state.herd.unseenUnrev = 3;
  world.rt.version++;
  const d = V.herdView(world, { tab: "digest", filter: FILTER }).digest;
  assert.ok(d.sections.length >= 2, "the demo digest has gains too");
  assert.equal(d.sections[0].key, "unreviewed", `losses first: ${d.sections.map((x) => x.key).join(", ")}`);
  const lines = d.sections[0].lines.map((l) => [l.text, l.sub]);
  assert.deepEqual(lines.slice(0, 2), [
    [`${first}'s chest opened Unreviewed: “Bump the lockfile”`, "half value, no Seals · 06:30"],
    [`${first}: 2 chests opened Unreviewed`, "half value, no Seals · Yesterday"],
  ]);
  // the Herd dot stands for unseen losses until the Digest is viewed: the VM names the command
  assert.equal(d.unseen, 3);
  assert.equal(d.seen.cmd, "lossesSeen");
  assert.deepEqual(d.seen.args, {});
  const r = W.command(world, d.seen.cmd, d.seen.args, NOW);
  assert.equal(r.ok, true, r.error);
  assert.equal(Herd.unseenLosses(world.state), 0);
  const after = V.herdView(world, { tab: "digest", filter: FILTER }).digest;
  assert.equal(after.unseen, 0);
  assert.equal(after.seen, null);
  assert.equal(after.sections[0].key, "unreviewed", "seeing the losses keeps their lines until Mark as read");
});

test("rules: with auto-learn off for the herd (or the autopilot off), the sheet and the party never promise that points get spent", () => {
  const world = D.demoWorld("mid", NOW).world;
  const hero = world.state.heroes.find((h) => h.cls > 0 && world.rt.live.has(h.id));
  hero.autoLearn = true;
  hero.spFree = 3;
  const skills = () => V.sheetView(world, { heroId: hero.id, tab: "skills", filter: FILTER }).skills;
  const star = () => {
    const vm = V.partyView(world, {});
    for (const g of vm.groups) for (const r of g.rows || []) if (r.heroId === hero.id) return (r.chips || []).find((c) => c.kind === "star" && /skill point/.test(c.tooltip || ""));
    return undefined;
  };
  world.rt.version++;
  assert.match(skills().sp.tooltip, /Auto-learn spends them within a minute/);
  assert.equal(skills().autoLearn.hint, "Spends points on the lowest-ranked skill");
  assert.equal(star(), undefined, "auto-learn on everywhere: no unspent-points star");
  for (const off of [(c) => { c.auto = Object.assign({}, c.auto, { learn: false }); }, (c) => { c.autopilot = false; }]) {
    const cfg = world.state.herd.cfg = Object.assign({}, world.state.herd.cfg, { auto: Object.assign({}, world.state.herd.cfg.auto) });
    off(cfg);
    world.rt.version++;
    const s = skills();
    assert.doesNotMatch(s.sp.tooltip, /spends them within a minute/);
    assert.match(s.sp.tooltip, /off in Settings, so they wait/);
    assert.equal(s.autoLearn.on, true, "the hero's own switch still reads on");
    assert.match(s.autoLearn.hint, /^Waits/);
    if (s.respec.enabled !== false && s.respec.tooltip) assert.doesNotMatch(s.respec.tooltip, /re-spends/);
    assert.ok(star(), "the party row shows the unspent-points star");
    world.state.herd.cfg = Object.assign({}, cfg, { autopilot: true, auto: Object.assign({}, cfg.auto, { learn: true }) });
  }
});

// ---------------------------------------------------------------------------------------------
// round 4 (the owner's screenshots in real herdr)

test("rules (round 4, P6): with the Autopilot off the skills hint says the Autopilot is off, not auto-learn", () => {
  const world = D.demoWorld("mid", NOW).world;
  const hero = world.state.heroes.find((h) => h.cls > 0 && world.rt.live.has(h.id));
  hero.autoLearn = true;
  hero.spFree = 2;
  const skills = () => V.sheetView(world, { heroId: hero.id, tab: "skills", filter: FILTER }).skills;
  world.state.herd.cfg = Object.assign({}, world.state.herd.cfg, { autopilot: false, auto: Object.assign({}, world.state.herd.cfg.auto, { learn: true }) });
  world.rt.version++;
  assert.equal(skills().autoLearn.hint, "Waits: the Autopilot is off in Settings");
  assert.match(skills().sp.tooltip, /The Autopilot is off in Settings, so they wait\./);
  assert.doesNotMatch(skills().autoLearn.hint + skills().sp.tooltip, /auto-learn is off/i);
  // the herd's own auto-learn switch off (the Autopilot on): that switch is named
  world.state.herd.cfg = Object.assign({}, world.state.herd.cfg, { autopilot: true, auto: Object.assign({}, world.state.herd.cfg.auto, { learn: false }) });
  world.rt.version++;
  assert.equal(skills().autoLearn.hint, "Waits: auto-learn is off in Settings");
});

test("rules (round 4, P3): no on-screen string promises a visual the game does not draw (career trims, skill cues)", () => {
  const cues = [];
  for (const list of Object.values(DATA.SKILLS.byClass)) for (const d of list) if (d.cue && d.cue !== "none") cues.push([d.id, d.cue]);
  const drawn = new Set(["works_on_my_machine"]); // every dodge shows "404" (combat FX.miss)
  const bad = cues.filter(([id]) => !drawn.has(id)).map(([, c]) => c);
  assert.ok(bad.length > 20, "the data's cues are art direction");
  const strings = [];
  const walk = (v) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  const worlds = D.DEMO_KINDS.map(demo).concat([big()]);
  const classes = new Set();
  for (const world of worlds) {
    for (const h of world.state.heroes) {
      classes.add(h.cls);
      for (const tab of ["skills", "career"]) walk(V.sheetView(world, { heroId: h.id, tab, filter: FILTER }));
    }
  }
  assert.equal(classes.size, DATA.CLASSES.length, "every class's skills are drawn somewhere");
  const text = strings.join("\n");
  for (const c of bad) assert.ok(!text.includes(c), `a tooltip promises "${c}"`);
  assert.doesNotMatch(text, /silver trim|title-bar trim|lanyard|\bcape\b/i);
  const principal = V.sheetView(demo("mid"), { heroId: demo("mid").state.heroes[0].id, tab: "career", filter: FILTER }).career.ladder[4];
  assert.equal(principal.note, "Capstone passive");
  // the one cue the stage does draw may stay (it explains the "404" numbers)
  assert.ok(text.includes("Dodged hits show 404") || !worlds.some((w) => w.state.heroes.some((h) => h.cls === 0)), "the 404 cue stays");
});

test("rules (round 4, P2): tab tooltips say what a badge counts (the number beside a label is its key, not a count)", () => {
  const world = demo("mid");
  const hero = world.state.heroes.find((h) => world.rt.live.has(h.id));
  hero.spFree = 2;
  world.rt.version++;
  const tabs = V.sheetView(world, { heroId: hero.id, tab: "gear", filter: FILTER }).tabs;
  const sk = tabs.find((x) => x.id === "skills");
  assert.equal(sk.badge, "2");
  assert.equal(sk.tip, "2 skill points to spend");
  assert.equal(tabs.find((x) => x.id === "gear").tip, null);
  const h = V.herdView(world, { tab: "roster", filter: FILTER }).tabs.find((x) => x.id === "digest");
  if (h.badge) assert.match(h.tip, h.badge === "•" ? /something new/ : new RegExp(`^${h.badge === "9+" ? "more than 9" : h.badge} new since you last looked$`));
  hero.spFree = 0;
  world.rt.version++;
});

test("rules (round 4, P1): a Contractor's banner, tag and roster row say when it joins the roster", () => {
  const world = sameDayWorld([
    { address: "t7", program: "claude", space: "spc_9", spaceName: "ref-client" },
    { address: "t8", program: "codex", space: "spc_9", spaceName: "ref-client" },
  ]);
  const cs = Array.from(world.rt.contractors.values());
  assert.equal(cs.length, 2, "the 7th and 8th agents of the day are Contractors");
  const first = cs.reduce((a, b) => (a.since <= b.since ? a : b));
  // the day's six hires are spent: the next 04:00 game day reopens hiring (tomorrow, NOW being 09:30 UTC)
  const sheet = V.sheetView(world, { heroId: first.id, tab: "gear", filter: FILTER });
  assert.match(sheet.note.text, /^Contractor: hired tomorrow at 04:00 · not saved until then; its kills and chests still pay the herd$/);
  assert.match(sheet.note.tooltip, /^Hired at the next 04:00 game day/);
  assert.match(sheet.note.tooltip, /keeps its name, level, XP and class, and its kit becomes saved Alpha gear\. Contractors don't get equity\.$/);
  assert.match(sheet.header.tagTip, /^Contractor: Hired at the next 04:00 game day/);
  const roster = V.herdView(world, { tab: "roster", filter: FILTER }).roster;
  assert.match(roster.count, / · 2 contractors, the next hired tomorrow at 04:00$/);
  const rows = roster.groups.flatMap((g) => g.rows);
  for (const c of cs) {
    const row = rows.find((r) => r.heroId === c.id);
    assert.ok(row, `a roster row for ${c.name}`);
    assert.equal(row.hire.text, "Hired tomorrow 04:00");
    assert.match(row.hire.tooltip, /04:00 game day/);
  }
  assert.match(rows.find((r) => r.heroId !== first.id && r.hire).hire.tooltip, /1 ahead in line/);
  for (const r of rows) if (r.heroId > 0) assert.equal(r.hire, null, "roster heroes have no hire line");
  // a full roster with nobody below Lv 10 to let go: hired when a slot frees
  const proto = world.state.heroes[0];
  for (let i = 0; i < 24; i++) world.state.heroes.push(Object.assign(JSON.parse(JSON.stringify(proto)), { id: 500 + i, L: 40, seat: `bench-${i}/claude`, name: `Bench ${i}` }));
  world.rt.version++;
  const full = V.sheetView(world, { heroId: first.id, tab: "gear", filter: FILTER });
  assert.match(full.note.text, /^Contractor: hired when a roster slot frees · /);
  assert.equal(V.herdView(world, { tab: "roster", filter: FILTER }).roster.groups.flatMap((g) => g.rows).find((r) => r.heroId === first.id).hire.text, "Hired when a slot frees");
  // a read-only save hires nobody: said plainly, and the tooltip's sentences stay apart
  world.rt.readOnly = true;
  world.rt.version++;
  const ro = V.sheetView(world, { heroId: first.id, tab: "gear", filter: FILTER });
  assert.match(ro.note.text, /^Contractor: never hired here: this save is read-only · its kills and chests still pay the herd$/);
  assert.match(ro.note.tooltip, /read-only\. Contractors don't get equity\.$/);
  assert.match(V.herdView(world, { tab: "roster", filter: FILTER }).roster.count, / · 2 contractors, none hired here: this save is read-only$/);
  world.rt.readOnly = false;
  world.rt.version++;
});

test("rules (round 4, P1): a Contractor's sheet follows it onto the roster when it is hired (its terminal), and its journal says so", () => {
  const world = sameDayWorld([{ address: "t7", program: "claude", space: "spc_9", spaceName: "ref-client" }]);
  const c = Array.from(world.rt.contractors.values())[0];
  const oldId = c.id; // promotion gives the same object a roster id
  const before = V.sheetView(world, { heroId: oldId, tab: "journal", filter: FILTER, address: "t7" });
  assert.equal(before.heroId, oldId);
  assert.equal(before.header.focus.address, "t7");
  // past the next 04:00: hiring reopens and the Contractor is promoted
  D.runCast(world, world.rt.demo.cast, NOW + 20 * 3600000);
  assert.equal(world.rt.contractors.size, 0, "promoted");
  const hero = world.state.heroes.find((h) => h.name === c.name);
  assert.ok(hero && hero.id > 0);
  const gone = V.sheetView(world, { heroId: oldId, tab: "journal", filter: FILTER });
  assert.equal(gone.missing, "This hero has left the roster.", "without its terminal the old id finds nobody");
  const after = V.sheetView(world, { heroId: oldId, tab: "journal", filter: FILTER, address: "t7", name: c.name });
  assert.equal(after.missing ?? null, null);
  assert.equal(after.heroId, hero.id);
  // another hero playing in that terminal (the Contractor left, another agent started there) is not
  // the Contractor: its sheet says it left rather than showing someone else
  const other = V.sheetView(world, { heroId: oldId, tab: "journal", filter: FILTER, address: "t7", name: `${c.name} the Second` });
  assert.equal(other.missing, "This hero has left the roster.");
  assert.equal(after.header.tag === "contractor", false);
  assert.ok(after.journal.lines.some((l) => l.text === `Hired: ${c.name} (was a contractor)` && l.icon === "ui/herd.svg"), after.journal.lines.map((l) => l.text).join(" | "));
});

/** n heroes spread over spaces: spaceOf(k) names hero k's space. */
function spacesWorld(n, spaceOf) {
  const t0 = NOW - 6 * DAY;
  const ags = [];
  for (let k = 0; k < n; k++) {
    const sp = spaceOf(k);
    ags.push(D.makeAgent({
      address: `t${k + 1}`, program: ["claude", "codex", "pi"][k % 3], space: `spc_${sp}`, spaceName: `project-${sp}`,
      tab: `tab_${k}`, tabIndex: k, plan: [["working", 1e9]], from: t0 + Math.floor(k / 6) * DAY, titleIdx: k,
    }));
  }
  const cast = D.makeCast(ags, { focus: "t1" });
  const world = W.createWorld({ nowMs: t0, seed: 7 });
  // as bigWorld: one tick as each day's six arrive, then the last minutes played out (playing the
  // six days second by second took ~43 s per world)
  D.runCast(world, cast, t0 + 1000);
  const opens = [];
  for (let d = 1; d * 6 < n; d++) opens.push(t0 + d * DAY);
  opens.push(NOW - 5 * 60000);
  for (const at of opens) {
    D.advanceCast(cast, (at - world.state.herd.lastMs) / 1000);
    W.tick(world, D.castSnapshot(cast, at));
  }
  D.runCast(world, cast, NOW);
  world.rt.demo = { cast };
  return world;
}

test("rules (round 4, P4): a space with one hero gets no header; its row names the space (30 heroes in 25 spaces)", () => {
  // spaces 1-5 hold two heroes each, spaces 6-25 one each
  const world = spacesWorld(30, (k) => (k < 10 ? 1 + (k >> 1) : k - 4));
  assert.equal(world.state.heroes.length, 30);
  const r = V.herdView(world, { tab: "roster", filter: FILTER }).roster;
  assert.equal(r.slim, true);
  const [one, ...rest] = r.groups;
  assert.equal(one.inline, true, "the one-hero spaces come first, without a header");
  assert.equal(one.rows.length, 20);
  for (const row of one.rows) assert.match(row.space, /^project-\d+$/);
  assert.equal(new Set(one.rows.map((x) => x.space)).size, 20);
  const headed = rest.filter((g) => g.key !== "g:off");
  assert.equal(headed.length, 5);
  for (const g of headed) {
    assert.equal(g.inline, false);
    assert.equal(g.rows.length, 2);
    for (const row of g.rows) assert.equal(row.space, null, "a row under its space's header does not repeat it");
  }
  // one line per hero: 30 rows and 5 headers, against 30 rows and 25 headers before
  const headers = r.groups.filter((g) => !g.inline).length;
  assert.equal(headers + r.groups.reduce((n, g) => n + g.rows.length, 0), 35);
});

test("rules (round 4, P8): the sheet header never quotes a title that only repeats the space it names", () => {
  const world = sameDayWorld([], { heroes: 2 });
  const [h1, h2] = world.state.heroes;
  const l1 = world.rt.live.get(h1.id);
  const l2 = world.rt.live.get(h2.id);
  // Claude Code titles its terminal after the folder, which herdr names the space after (5.png)
  l1.spaceName = "ref-client";
  l1.title = "ref-client";
  if (l1.task) l1.task.title = "";
  l1.tabName = "1";
  l1.paneName = null;
  // a tab named after its space
  l2.spaceName = "ref-client";
  l2.title = "Claude Code";
  if (l2.task) l2.task.title = "";
  l2.tabName = "Ref-Client";
  l2.paneName = null;
  world.rt.version++;
  for (const h of [h1, h2]) {
    const head = V.sheetView(world, { heroId: h.id, tab: "gear", filter: FILTER }).header;
    assert.match(head.sub, /^ref-client · /);
    assert.equal(head.quest, null, `${h.name}: “${head.quest}” repeats the space`);
  }
  // a tab with a name of its own still reads
  l2.tabName = "release notes";
  world.rt.version++;
  assert.equal(V.sheetView(world, { heroId: h2.id, tab: "gear", filter: FILTER }).header.quest, "release notes");
});

test("render (round 4, P4, P1): 30 heroes in 25 spaces, then 6 heroes and 24 Contractors, draw one line per hero inside the budget", async () => {
  const w = spacesWorld(30, (k) => (k < 10 ? 1 + (k >> 1) : k - 4));
  const { m } = await mount("herd", w, { props: { tab: "roster" } });
  assertClean(m, "30 heroes in 25 spaces", 450);
  // 5 space headers and the Hall of Fame's; 20 rows naming their space
  const titled = m.findAll((n) => n.type === "text" && /^project-\d+ · 2$/.test(n.text));
  assert.equal(titled.length, 5);
  assert.equal(m.findAll((n) => typeof n.id === "string" && n.id.startsWith("hd-sp-")).length, 20);
  // the owner's herd: six heroes hired today, the rest Contractors, one or two per space
  const extra = [];
  for (let k = 0; k < 24; k++) extra.push({ address: `c${k + 1}`, program: ["claude", "codex"][k % 2], space: `spc_${10 + (k >> 1)}`, spaceName: `repo-${10 + (k >> 1)}` });
  const c = sameDayWorld(extra, { heroes: 6, spaces: 6 });
  assert.equal(c.rt.contractors.size, 24);
  const vm = V.herdView(c, { tab: "roster", filter: FILTER }).roster;
  assert.match(vm.count, /^6 \/ 30 heroes · 6 hired today \(6 a day\) · 24 contractors, the next hired tomorrow at 04:00$/);
  const rows = vm.groups.flatMap((g) => g.rows);
  assert.equal(rows.filter((r) => r.hire).length, 24);
  // six a day: the first six tomorrow, the next six the day after
  assert.equal(rows.filter((r) => r.hire && r.hire.text === "Hired tomorrow 04:00").length, 6);
  assert.equal(rows.filter((r) => r.hire && r.hire.text === "Hired Nov 26 04:00").length, 6);
  const h = await mount("herd", c, { props: { tab: "roster" } });
  assertClean(h.m, "6 heroes + 24 contractors", 450);
});
