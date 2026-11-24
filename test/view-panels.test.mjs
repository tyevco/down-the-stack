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
const V = await import("../mods/mapledr/game/view.js");
const P = await import("../mods/mapledr/game/view/panels.js");
const D = await import("../mods/mapledr/game/demo.js");
const W = await import("../mods/mapledr/game/world.js");
const I = await import("../mods/mapledr/game/items.js");
const DATA = await import("../mods/mapledr/game/data.js");
const F = await import("../mods/mapledr/game/formulas.js");
const SheetMod = await import("../mods/mapledr/ui/sheet.js");
const HerdMod = await import("../mods/mapledr/ui/herdpanel.js");
const S = await import("../tools/vm-samples/sheet.mjs");
const H = await import("../tools/vm-samples/herd.mjs");

const NOW = Date.UTC(2026, 10, 24, 9, 30);
const DAY = 86400000;
const SHEET_TABS = ["gear", "skills", "stats", "career", "journal"];
const HERD_TABS = ["upgrades", "stash", "tracker", "bosses", "roster", "digest", "settings"];
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
  const c = bigWorld(6, { extra: [{ address: "vps/t9", program: "claude", space: "spc_1", spaceName: "herdr-app", plan: [["working", 1e9]] }] });
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

const errorsOf = (m) => m.errors.map((e) => `${e.code}: ${e.message}`);
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
    const r = W.command(world, b.challenge.cmd, b.challenge.args, NOW);
    assert.equal(r.ok, true, r.error);
    const after = V.sheetView(world, { heroId, tab: "career", filter: FILTER }).career.boss;
    assert.doesNotMatch(after.status, /^Fight/);
    assert.notEqual(after.challenge?.cmd, "retreat");
  }
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

test("perf: view + render per call stays well inside the 50 ms render budget in V8 (QuickJS is ~30× slower)", async () => {
  const world = D.demoWorld("late", NOW).world;
  const heroId = world.state.heroes[0].id;
  // cold views: memo and score caches reset by a new world version each time
  const tabs = [["sheet", "gear"], ["sheet", "skills"], ["sheet", "career"], ["sheet", "stats"], ["herd", "stash"], ["herd", "bosses"], ["herd", "roster"], ["herd", "tracker"], ["herd", "digest"]];
  const viewMs = {};
  for (const [k, tab] of tabs) {
    const t0 = performance.now();
    const n = 5;
    for (let i = 0; i < n; i++) {
      world.rt.version++;
      P._resetPanelsMemo();
      if (k === "sheet") V.sheetView(world, { heroId, tab, filter: { ...FILTER, focus: world.state.herd.stash[i].uid } });
      else V.herdView(world, { tab, filter: { ...FILTER, focus: world.state.herd.stash[i].uid } });
    }
    viewMs[`${k}/${tab}`] = (performance.now() - t0) / n;
  }
  for (const [k, ms] of Object.entries(viewMs)) assert.ok(ms < 8, `${k}: ${ms.toFixed(2)} ms per cold view`);
  // view + render through the role
  const { m, role } = await mount("sheet", world, { props: { heroId, tab: "gear" }, ui: { selected: world.state.herd.stash[0].uid } });
  let worst = 0;
  for (const tab of SHEET_TABS) {
    role.ui.tab = tab;
    world.rt.version++;
    const t0 = performance.now();
    m.render();
    worst = Math.max(worst, performance.now() - t0);
    assertClean(m, `perf sheet/${tab}`);
  }
  const h = await mount("herd", world, { ui: { selected: world.state.herd.stash[0].uid } });
  for (const tab of HERD_TABS) {
    h.role.ui.tab = tab;
    world.rt.version++;
    const t0 = performance.now();
    h.m.render();
    worst = Math.max(worst, performance.now() - t0);
  }
  assert.ok(worst < 40, `worst view + render ${worst.toFixed(1)} ms`);
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
