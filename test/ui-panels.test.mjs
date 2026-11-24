// Tests for the two dialog roles: the character sheet (ui/sheet.js) and the Herd panel
// (ui/herdpanel.js). Every sample scenario (tools/vm-samples/{sheet,herd}.mjs) renders through the
// strict mock at several widths, zoom 1 and 2, in a dark and a light theme, with zero validator
// errors; every button fires the ARCHITECTURE §3.5 command (or herdr command) its VM names; the
// role asks host.view with the args the contract names; the next tick's VM keeps every id.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("../tools/mock/index.mjs");
const { View } = await import("gpui-kit");
const SheetMod = await import("../mods/mapledr/ui/sheet.js");
const HerdMod = await import("../mods/mapledr/ui/herdpanel.js");
const S = await import("../tools/vm-samples/sheet.mjs");
const H = await import("../tools/vm-samples/herd.mjs");

const NOW = Date.UTC(2026, 10, 24, 9, 30);
const THEMES = ["graphite", "paper"];
const KIND = { sheet: { mod: SheetMod, samples: S, height: 500 }, herd: { mod: HerdMod, samples: H, height: 520 } };

/**
 * A fake GameHost: view() answers like view.js would for the scenario (switching tabs and filters
 * through the samples' viewFor); command() records and answers `result`.
 */
function fakeHost(kind, name, { result = { ok: true }, vm } = {}) {
  const samples = KIND[kind].samples;
  return {
    world: null, version: 1, views: [], commands: [], result,
    view(k, args) {
      this.views.push([k, JSON.parse(JSON.stringify(args))]);
      if (k !== kind) return null;
      return vm !== undefined ? vm : samples.viewFor(name, args);
    },
    command(n, args) { this.commands.push([n, JSON.parse(JSON.stringify(args))]); return this.result; },
    claim: () => true,
  };
}

/** Mount a dialog role the way main.js does (a role object inside a View), sized, rendered. */
async function mount(kind, name, { width = 760, zoom = 1, theme = "graphite", ui, props: extraProps = {}, fixture = {}, host: hostOpts } = {}) {
  M.resetState();
  M.resetStorage();
  const { mod, samples, height } = KIND[kind];
  const vm = samples.scenarios[name];
  const host = fakeHost(kind, name, hostOpts);
  const props = kind === "sheet"
    ? { role: "sheet", heroId: vm?.heroId ?? 1, overlay: "o1", tab: vm?.tab, ...extraProps }
    : { role: "herd", overlay: "o2", tab: vm?.tab, ...extraProps };
  const uiState = ui ?? samples.uiStates?.[name] ?? {};
  const R = mod.default;
  class Wrap extends View {
    init(_p, cx) {
      this.role = new R();
      this.role.init(props, cx, host);
      Object.assign(this.role.ui, JSON.parse(JSON.stringify(uiState)));
    }
    render(cx) { return this.role.render(cx); }
  }
  const m = await M.mountView(Wrap, { props, fixture: { settings: { zoom }, theme, ...fixture }, nowMs: NOW });
  m.render();
  m.size(width * zoom, height * zoom);
  m.render();
  return { m, host, role: m.view.role };
}

const ids = (m) => new Set(m.findAll((n) => n.id != null).map((n) => n.id));
const runs = (name) => M.calls().run.filter((c) => c.name === name);
const errorsOf = (m) => m.errors.map((e) => `${e.code}: ${e.message}`);
const has = (m, method) => m.findAll((n) => n.methods.some((x) => x[0] === method)).length > 0;
const lastView = (host) => host.views.at(-1)[1];

function assertClean(m, label) {
  assert.ok(m.tree, `${label}: render failed: ${errorsOf(m).join("; ")}`);
  assert.deepEqual(errorsOf(m), [], label);
  const dupes = m.warnings.filter((w) => w.code === "duplicate-id" || w.code === "transition-no-id").map((w) => w.message);
  assert.deepEqual(dupes, [], label);
  // Dialogs are not the stage, but they redraw with the window: keep them lean.
  assert.ok(m.stats.elements < 500, `${label}: ${m.stats.elements} elements`);
}

/** Fire, then render (handlers notify; the harness re-renders explicitly). */
function click(m, id, ev, kind) {
  m.fire(id, ev, kind);
  m.render();
}

// ---------------------------------------------------------------------------------------------
// every scenario renders clean

for (const kind of ["sheet", "herd"]) {
  test(`${kind}: every scenario × widths × zoom 1/2 × dark/light renders with zero validator errors`, async () => {
    const { samples } = KIND[kind];
    for (const name of Object.keys(samples.scenarios)) {
      for (const width of [samples.widths[name], 640, 1000]) {
        for (const zoom of [1, 2]) {
          for (const theme of THEMES) {
            const { m } = await mount(kind, name, { width, zoom, theme });
            assertClean(m, `${kind}/${name} w${width} z${zoom} ${theme}`);
          }
        }
      }
    }
  });

  test(`${kind}: the next tick's VM keeps every id (stable keys)`, async () => {
    const { samples } = KIND[kind];
    for (const name of Object.keys(samples.scenarios)) {
      const { m, role } = await mount(kind, name);
      const before = ids(m);
      const fake = role.host;
      role.host = { ...fake, view: (k, a) => samples.nextTick(samples.viewFor(name, a)) };
      m.render();
      assert.deepEqual([...ids(m)].sort(), [...before].sort(), name);
      assert.ok(m.ok, `${name}: ${errorsOf(m).join("; ")}`);
    }
  });
}

test("the pure renderers build a tree from a VM inside a plain render pass", async () => {
  const env = (w, h) => ({ width: w, height: h, zoom: 1, host: null, act: () => ({ ok: true }) });
  const cases = [
    () => SheetMod.renderSheet(S.scenarios.gear, env(760, 500)),
    () => SheetMod.renderSheet(S.scenarios.career, env(760, 500)),
    () => SheetMod.renderSheet(null, env(760, 500)),
    () => SheetMod.renderSheet(S.scenarios.missing, env(760, 500)),
    () => HerdMod.renderHerd(H.scenarios.upgrades, env(760, 520)),
    () => HerdMod.renderHerd(H.scenarios.settings, env(760, 520)),
    () => HerdMod.renderHerd(null, env(760, 520)),
  ];
  for (const fn of cases) {
    M.resetState();
    const m = await M.mountView(class extends View { render() { return fn(); } }, { props: {} });
    m.render();
    assertClean(m, fn.toString());
  }
});

test("loading, missing hero, and herdr-app check (props null) render quiet placeholders", async () => {
  const loading = await mount("sheet", "loading");
  assert.ok(loading.m.text().includes("Loading the hero"));
  const gone = await mount("sheet", "missing");
  assert.ok(gone.m.text().includes("left the roster"));
  const herd = await mount("herd", "loading");
  assert.ok(herd.m.text().includes("Loading the herd"));
  // `herdr-app check`: checking, props() null, init(undefined)
  for (const kind of ["sheet", "herd"]) {
    M.resetState();
    M.setChecking(true);
    const R = KIND[kind].mod.default;
    const host = fakeHost(kind, "loading");
    class Wrap extends View {
      init(_p, cx) { this.role = new R(); this.role.init(null, cx, host); }
      render(cx) { return this.role.render(cx); }
    }
    const m = await M.mountView(Wrap, { props: null });
    m.render();
    assert.ok(m.tree, `${kind}: ${errorsOf(m).join("; ")}`);
    assert.deepEqual(errorsOf(m), [], kind);
    M.setChecking(false);
  }
});

// ---------------------------------------------------------------------------------------------
// sheet behaviour

test("sheet: asks host.view('sheet', {heroId, tab, filter}) and opens on props.tab", async () => {
  const { host } = await mount("sheet", "skills");
  const [kind, args] = host.views.at(-1);
  assert.equal(kind, "sheet");
  assert.deepEqual(Object.keys(args).sort(), ["filter", "heroId", "tab"]);
  assert.equal(args.heroId, 1);
  assert.equal(args.tab, "skills");
  assert.deepEqual(Object.keys(args.filter).sort(), ["focus", "minRar", "slot", "sort", "squash", "usable"]);
});

test("sheet: tabs switch by click, by number key and by arrow; the VM for the new tab is asked for", async () => {
  const { m, host } = await mount("sheet", "gear");
  click(m, "sh-tab-skills");
  assert.equal(lastView(host).tab, "skills");
  assert.ok(m.text().includes("Extract Method"));
  click(m, "sheet", "3", "key_down");
  assert.equal(lastView(host).tab, "stats");
  assert.ok(m.text().includes("Damage reduction"));
  click(m, "sheet", "right", "key_down");
  assert.equal(lastView(host).tab, "career");
  click(m, "sheet", "left", "key_down");
  assert.equal(lastView(host).tab, "stats");
  assert.ok(m.ok, errorsOf(m).join("; "));
});

test("sheet: the close button closes this overlay; Focus closes it and focuses the agent's pane", async () => {
  const a = await mount("sheet", "gear");
  click(a.m, "sh-close");
  assert.deepEqual(M.calls().closeOverlay.map((c) => c.id), ["o1"]);
  const b = await mount("sheet", "gear");
  click(b.m, "sh-focus");
  assert.deepEqual(M.calls().closeOverlay.map((c) => c.id), ["o1"]);
  assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ pane: "p1" }]);
  const benched = await mount("sheet", "benched");
  assert.equal(benched.m.node("sh-focus"), null, "an off-duty hero has no terminal to focus");
});

test("sheet gear: stash rows select / hover the card; slots select equipped items; filters patch the query", async () => {
  const { m, host, role } = await mount("sheet", "gear", { ui: {} });
  assert.equal(lastView(host).filter.focus, null);
  assert.ok(m.text().includes("Pick an item"));
  click(m, "sh-row-it:921");
  assert.equal(lastView(host).filter.focus, 921);
  assert.ok(m.text().includes("Vectorized Extract Saber of Graceful Degradation"));
  assert.ok(m.text().includes("+4.1%"));
  // hover previews another item, leaving restores the selection
  m.hover("sh-row-it:931");
  m.render();
  assert.equal(lastView(host).filter.focus, 931);
  m.hover("sh-row-it:931", false);
  m.render();
  assert.equal(lastView(host).filter.focus, 921);
  // a paper-doll slot selects the equipped item
  click(m, "sh-slot-hoodie");
  assert.equal(role.ui.selected, 803);
  assert.equal(lastView(host).filter.focus, 803);
  // filter chips merge their patch; sort is one cycling chip
  click(m, "sh-f-slot-hat");
  assert.equal(lastView(host).filter.slot, "hat");
  click(m, "sh-f-rar-2");
  assert.equal(lastView(host).filter.minRar, 2);
  click(m, "sh-f-usable");
  assert.equal(lastView(host).filter.usable, true);
  click(m, "sh-f-sort");
  assert.equal(lastView(host).filter.sort, "ip");
  assert.ok(m.ok, errorsOf(m).join("; "));
});

test("sheet gear: card actions run their commands; confirm arms first; disabled ones do nothing; results flash", async () => {
  const { m, host } = await mount("sheet", "gear");
  click(m, "sh-act-equip:921");
  assert.deepEqual(host.commands, [["equip", { heroId: 1, uid: 921 }]]);
  assert.ok(m.text().includes("Equip: done."));
  click(m, "sh-act-lock:921");
  click(m, "sh-act-polish:921");
  assert.deepEqual(host.commands.slice(1), [["lock", { uid: 921, locked: true }], ["polish", { uid: 921 }]]);
  // reroll one affix
  click(m, "sh-rr-921:1");
  assert.deepEqual(host.commands.at(-1), ["reroll", { uid: 921, affix: 1 }]);
  // deprecate asks first; once done, the selection (now gone) is dropped
  click(m, "sh-act-deprecate:921");
  assert.equal(host.commands.length, 4);
  assert.ok(m.text().includes("Deprecate it?"));
  click(m, "sh-act-deprecate:921");
  assert.deepEqual(host.commands.at(-1), ["deprecate", { uid: 921 }]);
  assert.equal(lastView(host).filter.focus, null);
  // a disabled action (the principal's locked weapon blocks Equip) does nothing
  const p = await mount("sheet", "principal");
  click(p.m, "sh-act-equip:2101");
  assert.deepEqual(p.host.commands, []);
  // an engine refusal shows its message
  const r = await mount("sheet", "gear", { host: { result: { ok: false, error: "Needs 982 gold" } } });
  click(r.m, "sh-act-polish:921");
  assert.ok(r.m.text().includes("Needs 982 gold"));
  assert.ok(m.ok && p.m.ok && r.m.ok);
});

test("sheet gear: Squash Merge picks squashable items and sends the VM's uids", async () => {
  const { m, host, role } = await mount("sheet", "gear", { ui: {} });
  click(m, "sh-squash-toggle");
  assert.equal(role.ui.squashMode, true);
  click(m, "sh-row-it:905");
  click(m, "sh-row-it:907");
  click(m, "sh-row-it:921"); // a Release: not squashable, ignored
  assert.deepEqual(lastView(host).filter.squash, [905, 907]);
  assert.ok(m.text().includes("2 of 3 Alpha picked"));
  click(m, "sh-squash-go");
  assert.deepEqual(host.commands, [], "needs 3 picks");
  click(m, "sh-row-it:908");
  assert.deepEqual(lastView(host).filter.squash, [905, 907, 908]);
  click(m, "sh-squash-go");
  assert.deepEqual(host.commands, [["squash", { uids: [905, 907, 908] }]]);
  assert.equal(role.ui.squashMode, false, "a successful squash leaves picking mode");
  assert.deepEqual(lastView(host).filter.squash, []);
  // without CI Forge 3 the toggle is disabled
  const nib = await mount("sheet", "intern");
  click(nib.m, "sh-squash-toggle");
  assert.equal(nib.role.ui.squashMode, false);
});

test("sheet skills: learn, auto-learn and respec (with confirm)", async () => {
  const { m, host } = await mount("sheet", "skills");
  click(m, "sh-learn-sk:main");
  click(m, "sh-learn-sk:sig"); // disabled: needs Lv 35
  click(m, "sh-autolearn");
  click(m, "sh-respec");
  click(m, "sh-respec");
  assert.deepEqual(host.commands, [
    ["learn", { heroId: 1, slot: "main" }],
    ["autoLearn", { heroId: 1, on: false }],
    ["respec", { heroId: 1 }],
  ]);
  assert.equal(m.node("sh-learn-sk:ult"), null, "locked skills have no learn button");
});

test("sheet career: review challenge, class change, map pin / auto, rename and retire", async () => {
  const { m, host, role } = await mount("sheet", "career");
  click(m, "sh-rv-senior");
  click(m, "sh-cls-cls:shellmancer");
  assert.ok(m.text().includes("Change to Shellmancer for 775 Snippets?"), "an armed class chip shows its question");
  click(m, "sh-cls-cls:shellmancer");
  click(m, "sh-cls-cls:hotfixer"); // the current class: inert
  click(m, "sh-mp-map:2-2");
  click(m, "sh-mp-map:4-2"); // not unlocked: inert
  click(m, "sh-map-auto");
  click(m, "sh-retire");
  click(m, "sh-retire");
  assert.deepEqual(host.commands, [
    ["challenge", { kind: "review", idx: 0, heroId: 2 }],
    ["setClass", { heroId: 2, cls: "shellmancer" }],
    ["pinMap", { heroId: 2, mapId: "2-2" }],
    ["pinMap", { heroId: 2, mapId: null }],
    ["retire", { heroId: 2 }],
  ]);
  // rename: the button fills the input with the name; Save sends what was typed
  click(m, "sh-rename");
  assert.equal(role.ui.renaming, true);
  assert.equal(role.inputs.name.value(), "Rue Two-Spaces");
  role.inputs.name.set_value("Rue the Unflaky");
  click(m, "sh-rename-save");
  assert.deepEqual(host.commands.at(-1), ["rename", { heroId: 2, name: "Rue the Unflaky" }]);
  assert.equal(role.ui.renaming, false);
  assert.ok(m.ok, errorsOf(m).join("; "));
});

test("sheet career (benched): Rebind moves a live agent onto the hero", async () => {
  const { m, host } = await mount("sheet", "benched");
  click(m, "sh-rb-rebind:t9");
  assert.deepEqual(host.commands, [["rebind", { heroId: 7, address: "t9" }]]);
  assert.ok(m.text().includes("Off duty since"));
});

test("sheet: the doll's Termling blinks and bobs unless calm; calm stops every loop", async () => {
  const gear = await mount("sheet", "gear");
  assert.ok(has(gear.m, "frames"), "working face blinks");
  assert.ok(has(gear.m, "loop"), "the rig bobs");
  assert.ok(gear.m.node("sh-rig"));
  const calm = await mount("sheet", "principalSkills");
  assert.ok(!has(calm.m, "frames") && !has(calm.m, "loop"));
  const benched = await mount("sheet", "benched");
  assert.ok(!has(benched.m, "frames"), "an off-duty face does not blink");
});

test("sheet: mapledr.sheet closes the sheet; herd and calm act like the chrome roles", async () => {
  const { role, host } = await mount("sheet", "gear");
  assert.equal(role.command("sheet"), true);
  assert.deepEqual(M.calls().closeOverlay.map((c) => c.id), ["o1"]);
  assert.equal(role.command("herd"), true);
  assert.deepEqual(M.calls().openOverlay.map((c) => c.spec), [{ mod: "mapledr", kind: "dialog", width: 760, height: 520, props: { role: "herd" } }]);
  assert.equal(role.command("calm"), true);
  assert.equal(host.commands.at(-1)[0], "setting");
  assert.equal(role.command("nope"), false);
});

test("sheet: props.focus opens on that item's card (loot pillar)", async () => {
  const { host } = await mount("sheet", "gear", { ui: {}, props: { focus: 921, tab: "journal" } });
  assert.equal(lastView(host).tab, "gear");
  assert.equal(lastView(host).filter.focus, 921);
});

// ---------------------------------------------------------------------------------------------
// herd behaviour

test("herd: asks host.view('herd', {tab, filter}); tabs switch by click and key", async () => {
  const { m, host } = await mount("herd", "upgrades");
  const [kind, args] = host.views.at(-1);
  assert.equal(kind, "herd");
  assert.deepEqual(Object.keys(args).sort(), ["filter", "tab"]);
  assert.equal(args.tab, "upgrades");
  click(m, "hd-tab-bosses");
  assert.equal(lastView(host).tab, "bosses");
  assert.ok(m.text().includes("The Octopus Merge"));
  click(m, "herd", "7", "key_down");
  assert.equal(lastView(host).tab, "settings");
  click(m, "hd-close");
  assert.deepEqual(M.calls().closeOverlay.map((c) => c.id), ["o2"]);
});

test("herd upgrades: Buy runs buy {building}; an unaffordable one does nothing", async () => {
  const { m, host } = await mount("herd", "upgrades");
  click(m, "hd-buy-b:coffee_machine");
  click(m, "hd-buy-b:vendor");
  assert.deepEqual(host.commands, [["buy", { building: "coffee_machine" }]]);
  const late = await mount("herd", "upgradesLate");
  assert.equal(late.m.node("hd-buy-b:war_room"), null, "a maxed building has no Buy");
  assert.ok(late.m.text().includes("MAX"));
});

test("herd stash: tiles select the card; equip on the best hero; Keepsakes can't be deprecated", async () => {
  const { m, host } = await mount("herd", "stash", { ui: {} });
  click(m, "hd-tile-it:921");
  assert.equal(lastView(host).filter.focus, 921);
  assert.ok(m.text().includes("Best on Kip"));
  click(m, "hd-act-equip:921");
  assert.deepEqual(host.commands, [["equip", { heroId: 1, uid: 921 }]]);
  click(m, "hd-f-slot-hat");
  assert.equal(lastView(host).filter.slot, "hat");
  const ks = await mount("herd", "stashKeepsake");
  click(ks.m, "hd-act-deprecate:951");
  click(ks.m, "hd-act-lock:951");
  assert.deepEqual(ks.host.commands, [["lock", { uid: 951, locked: false }]]);
  const empty = await mount("herd", "stashEmpty");
  assert.ok(empty.m.text().includes("Nothing in vendor/ yet"));
});

test("herd tracker: a zone row shows its reports", async () => {
  const { m, role } = await mount("herd", "tracker");
  assert.ok(m.text().includes("Diff Leech"), "the frontier zone first");
  click(m, "hd-z-lint_meadows");
  assert.equal(role.ui.zone, "lint_meadows");
  assert.ok(m.text().includes("Typo Sprout"));
  assert.ok(m.text().includes("Fixed Nov 18, 2026"));
  click(m, "hd-z-threadlock_keep");
  assert.ok(m.text().includes("No reports yet."));
});

test("herd bosses: Challenge and (confirmed) Retreat", async () => {
  const { m, host } = await mount("herd", "bosses");
  click(m, "hd-ch-octopus_merge");
  click(m, "hd-ch-catastrophic_backtracker"); // on cooldown: disabled
  assert.deepEqual(host.commands, [["challenge", { kind: "boss", idx: 3 }]]);
  assert.equal(m.node("hd-ch-bloatodon"), null);
  const f = await mount("herd", "bossFight");
  click(f.m, "hd-retreat");
  assert.deepEqual(f.host.commands, []);
  click(f.m, "hd-retreat");
  assert.deepEqual(f.host.commands, [["retreat", {}]]);
});

test("herd roster: Sheet opens the hero's sheet; Retire confirms first", async () => {
  const { m, host } = await mount("herd", "roster");
  click(m, "hd-sheet-r:2");
  assert.deepEqual(M.calls().openOverlay.map((c) => c.spec), [{ mod: "mapledr", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 2 } }]);
  click(m, "hd-ret-r:7");
  click(m, "hd-ret-r:7");
  assert.deepEqual(host.commands, [["retire", { heroId: 7 }]]);
  assert.ok(m.text().includes("Hall of Fame") && m.text().includes("Lin the Patient"));
});

test("herd digest: claim chests and mark as read; the empty digest says so", async () => {
  const { m, host } = await mount("herd", "digest");
  click(m, "hd-da-c:5");
  click(m, "hd-ack");
  assert.deepEqual(host.commands, [["claimChest", { heroId: 5 }], ["digestSeen", {}]]);
  const empty = await mount("herd", "digestEmpty");
  assert.ok(empty.m.text().includes("Nothing new since you last looked."));
});

test("herd settings: herd.cfg switches, choices, stage height (layout.resize), HUD (layout.toggle), rename", async () => {
  const layout = M.readLayout();
  const { m, host, role } = await mount("herd", "settings", { fixture: { layout } });
  click(m, "hd-sw-calm");
  click(m, "hd-opt-nums-crits");
  click(m, "hd-opt-nums-all"); // already on: inert
  click(m, "hd-sw-auto.equip");
  click(m, "hd-sw-notify.boss");
  click(m, "hd-opt-stageH-120");
  assert.deepEqual(host.commands, [
    ["setting", { key: "calm", value: true }],
    ["setting", { key: "nums", value: "crits" }],
    ["setting", { key: "auto.equip", value: false }],
    ["setting", { key: "notify.boss", value: true }],
    ["setting", { key: "stageH", value: 120 }],
  ]);
  assert.deepEqual(runs("layout.resize").map((c) => c.args), [{ id: "stage", px: 120 }]);
  click(m, "hd-sw-hud");
  assert.deepEqual(runs("layout.toggle").map((c) => c.args), [{ id: "hud" }]);
  assert.ok(m.text().includes("HUD strip shown."));
  // rename the herd
  click(m, "hd-rename");
  role.inputs.herdName.set_value("Night Shift");
  click(m, "hd-rename-save");
  assert.deepEqual(host.commands.at(-1), ["rename", { herd: true, name: "Night Shift" }]);
  assert.ok(m.ok, errorsOf(m).join("; "));
  // no hud block in the layout: the switch is disabled
  const bare = await mount("herd", "settings");
  click(bare.m, "hd-sw-hud");
  assert.equal(runs("layout.toggle").length, 0);
});

test("herd: mapledr.herd closes the panel; sheet and calm act like the chrome roles", async () => {
  const { role } = await mount("herd", "upgrades");
  assert.equal(role.command("herd"), true);
  assert.deepEqual(M.calls().closeOverlay.map((c) => c.id), ["o2"]);
  assert.equal(role.command("calm"), true);
  assert.equal(role.command("nope"), false);
});

test("herd: props.tab opens that tab (the sidebar's settings button)", async () => {
  const { host } = await mount("herd", "upgrades", { props: { tab: "settings" } });
  assert.equal(lastView(host).tab, "settings");
});
