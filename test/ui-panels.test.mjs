// Tests for the two dialog roles: the character sheet (ui/sheet.js) and the Herd panel
// (ui/herdpanel.js). Every sample scenario (tools/vm-samples/{sheet,herd}.mjs) renders through the
// strict mock at several widths, zoom 1 and 2, in a dark and a light theme, with zero validator
// errors; every button fires the ARCHITECTURE §3.5 command (or herdr command) its VM names; the
// role asks host.view with the args the contract names; the next tick's VM keeps every id.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("../tools/mock/index.mjs");
const { View, div, svg } = await import("gpui-kit");
const SheetMod = await import("../mods/down-the-stack/ui/sheet.js");
const HerdMod = await import("../mods/down-the-stack/ui/herdpanel.js");
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
/** m.ok without the wall clock: no validator error, a render over the budget judged as above. */
const clean = (...ms) => ms.every((m) => errorsOf(m).length === 0);
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
      assert.deepEqual(errorsOf(m), [], name);
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

test("a dialog render the mock timed over herdr's budget once (load) is judged by its best of 5; one always slow still fails", async () => {
  // busy until both this process's CPU time and the wall clock have run `ms`, under any load (the
  // CPU time alone can pass `ms` early: it counts V8's helper threads too, whose time lands in steps)
  const spin = (ms) => {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    for (let c = { user: 0, system: 0 }; (c.user + c.system) / 1000 < ms || performance.now() - t0 < ms; c = process.cpuUsage(c0)) { /* busy */ }
  };
  const env = { width: 760, height: 500, zoom: 1, host: null, act: () => ({ ok: true }) };
  M.resetState();
  let n = 0;
  const once = await M.mountView(class extends View { render() { if (n++ === 0) spin(80); return SheetMod.renderSheet(S.scenarios.career, env); } }, { props: {} });
  once.render();
  assert.ok(once.errors.some(isRenderBudget), "the mock flagged the slow render");
  assert.deepEqual(errorsOf(once), [], "a one-off: the best of 5 fits");
  assert.ok(clean(once));
  M.resetState();
  const always = await M.mountView(class extends View { render() { spin(80); return HerdMod.renderHerd(H.scenarios.bossFight, { ...env, height: 520 }); } }, { props: {} });
  always.render();
  assert.match(errorsOf(always).join(), /^budget: the best of 5 renders took \d+\.\d ms/, "a render that is always slow still fails");
  assert.equal(clean(always), false);
  // another validator error is never excused
  M.resetState();
  const bad = await M.mountView(class extends View { render() { spin(80); return div().child(null); } }, { props: {} });
  bad.render();
  assert.ok(errorsOf(bad).some((e) => !/^budget/.test(e)), errorsOf(bad).join("; "));
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
  assert.deepEqual(Object.keys(args.filter).sort(), ["focus", "hover", "minRar", "selected", "slot", "sort", "squash", "usable"]);
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
  assert.deepEqual(errorsOf(m), []);
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
  assert.deepEqual(errorsOf(m), []);
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
  assert.ok(clean(m, p.m, r.m), [m, p.m, r.m].flatMap(errorsOf).join("; "));
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
  assert.deepEqual(errorsOf(m), []);
});

test("sheet career (benched): Rebind moves a live agent onto the hero", async () => {
  const { m, host } = await mount("sheet", "benched");
  click(m, "sh-rb-rebind:t9");
  assert.deepEqual(host.commands, [["rebind", { heroId: 7, address: "t9" }]]);
  assert.ok(m.text().includes("Off duty since"));
});

test("round 4c (reviewer): the sheet's Rebind lines cut the space in the middle, so two agents in spaces that share a start stay apart; the rest of the line gives way first", async () => {
  const joined = (n) => (n.type === "text" ? n.text : n.children.map(joined).join(""));
  const base = S.scenarios.benched;
  const opt = (addr, prog, space, rest) => ({ ...base.career.rebind.options[0], key: `rebind:${addr}`, args: { heroId: 7, address: addr }, tooltip: `${prog} in ${space}${rest}`, line: [`${prog} in `, space, rest] });
  const options = [
    opt("t21", "Claude Code", "ceo-assistant-search-eng", " · “Tune BM25 weights” (contractor)"),
    opt("t22", "Claude Code", "ceo-assistant-billing-eng", " · “Reconcile invoices” (contractor)"),
    opt("t23", "Pi", "docs", " (contractor)"),
  ];
  const vm = { ...base, career: { ...base.career, rebind: { ...base.career.rebind, options } } };
  const rowsOf = (m) => m.findAll((n) => n.children.some((c) => typeof c.id === "string" && c.id.startsWith("sh-rb-rebind:")));
  for (const width of [640, 760]) {
    const { m, host } = await mount("sheet", "benched", { width, host: { vm } });
    const rows = rowsOf(m);
    assert.equal(rows.length, 3, `${width}: one line per option`);
    const tails = [];
    rows.forEach((row, i) => {
      const line = row.children[0];
      assert.equal(joined(line).replace(/\u00A0/g, " "), options[i].tooltip, `${width}: the whole line, in parts`);
      const [lead, space, rest] = line.children;
      assert.ok(lead.has("flex_none") && rest.has("flex_1") && rest.has("truncate"), `${width}: what follows the space gives way first`);
      if (options[i].line[1] === "docs") { assert.equal(space.children[0].text, "docs"); return; }
      const [head, tail] = space.children;
      assert.ok(head.has("truncate") && head.has("min_w") && tail.has("flex_none"), `${width}: the space's head gives way, its tail stays whole`);
      assert.equal(head.children[0].text, "ceo-assistant-");
      tails.push(tail.children[0].text);
    });
    assert.deepEqual(tails, ["search-eng", "billing-eng"], `${width}: the two lines end apart`);
    click(m, "sh-rb-rebind:t22");
    assert.deepEqual(host.commands, [["rebind", { heroId: 7, address: "t22" }]]);
    assert.deepEqual(errorsOf(m), []);
  }
  // a view without the parts (an older sample): the line is cut at its end, as before
  const { m } = await mount("sheet", "benched", { host: { vm: { ...base, career: { ...base.career, rebind: { ...base.career.rebind, options: [{ ...options[0], line: undefined }] } } } } });
  const line = rowsOf(m)[0].children[0];
  assert.equal(line.children[0].text, options[0].tooltip);
  assert.ok(line.has("truncate"));
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

test("sheet: down-the-stack.sheet closes the sheet; herd and calm act like the chrome roles", async () => {
  const { role, host } = await mount("sheet", "gear");
  assert.equal(role.command("sheet"), true);
  assert.deepEqual(M.calls().closeOverlay.map((c) => c.id), ["o1"]);
  assert.equal(role.command("herd"), true);
  assert.deepEqual(M.calls().openOverlay.map((c) => c.spec), [{ mod: "down-the-stack", kind: "dialog", width: 760, height: 520, props: { role: "herd" } }]);
  assert.equal(role.command("calm"), true);
  assert.equal(host.commands.at(-1)[0], "setting");
  assert.equal(role.command("nope"), false);
});

test("sheet: props.focus opens on that item's card (loot pillar)", async () => {
  const { host } = await mount("sheet", "gear", { ui: {}, props: { focus: 921, tab: "journal" } });
  assert.equal(lastView(host).tab, "gear");
  assert.equal(lastView(host).filter.focus, 921);
});

test("sheet: the provisional tag opens Career; the current class chip locks it (asks first); the boss card retreats", async () => {
  const { m, host } = await mount("sheet", "provisionalGear");
  const tagNode = m.node("sh-tag");
  assert.ok(tagNode, "the header tag");
  assert.ok(tagNode.last("tooltip")[0].startsWith("Provisional class (9 of 15 tasks)"));
  click(m, "sh-tag");
  assert.equal(lastView(host).tab, "career", "the tag is a link to Career");
  assert.deepEqual(host.commands, []);
  // on Career the tag is a plain label
  assert.equal(m.node("sh-tag").handlers.on_click, undefined);
  // the provisional current class: dashed, with a lock icon; first click arms, second locks
  const chip = m.node("sh-cls-cls:hotfixer");
  assert.ok(chip.has("border_dashed"));
  assert.ok(m.findAll((n) => n.type === "svg" && n.src.endsWith("ui/lock.svg") && n.parent === chip).length === 1);
  click(m, "sh-cls-cls:hotfixer");
  assert.ok(m.text().includes("Lock Hotfixer?"));
  assert.deepEqual(host.commands, []);
  click(m, "sh-cls-cls:hotfixer");
  assert.deepEqual(host.commands, [["setClass", { heroId: 5, cls: "hotfixer" }]]);
  // the zone boss fight runs: the boss card's button is a (confirmed) Retreat
  assert.ok(m.text().includes("Fighting: 81% left"));
  click(m, "sh-boss-go");
  assert.ok(m.text().includes("Retreat? (a Postmortem)"));
  click(m, "sh-boss-go");
  assert.deepEqual(host.commands.at(-1), ["retreat", {}]);
  // a locked current class stays inert; other tags (off duty) are plain labels
  const rue = await mount("sheet", "career");
  assert.equal(rue.m.node("sh-tag"), null);
  click(rue.m, "sh-cls-cls:hotfixer");
  assert.deepEqual(rue.host.commands, []);
  const benched = await mount("sheet", "benched");
  assert.equal(benched.m.node("sh-tag").handlers.on_click, undefined);
  assert.ok(clean(m, rue.m, benched.m), [m, rue.m, benched.m].flatMap(errorsOf).join("; "));
});

test("sheet career: during its zone boss fight the boss card leads the column, its Retreat in the card's title row", async () => {
  /** The left column's blocks, in order, as their ids (or "ladder" / "title"). */
  const order = (m) => {
    const col = m.node("sh-career-l").children[0].children;
    return col.map((n) => n.id ?? (n.children.some((c) => typeof c.id === "string" && c.id.startsWith("sh-cl-")) ? "ladder" : "title"));
  };
  const f = await mount("sheet", "provisional");
  assert.equal(f.m.node("sh-boss") != null, true);
  assert.deepEqual(order(f.m), ["sh-boss", "title", "ladder"], "fighting: the card first");
  // the button is in the card's title row (beside "Zone boss"), not beside the name and status
  const card = f.m.node("sh-boss");
  /** Is n inside the card's title row? */
  const inTitle = (m, n) => { const row = m.node("sh-boss").children[0]; for (let p = n?.parent; p; p = p.parent) if (p === row) return true; return false; };
  assert.ok(inTitle(f.m, f.m.node("sh-boss-go")), "Retreat in the title row");
  assert.ok(card.children[0].children.some((c) => c.type !== "text" && c.children.some((x) => x.type === "text" && x.text === "Zone boss")));
  assert.ok(card.has("border_color") && card.last("border_color")[0] !== card.methods.find((x) => x[0] === "border_color")[1][0], "a fight tints the card's border");
  // armed: the question replaces the label where it stands
  click(f.m, "sh-boss-go");
  assert.ok(inTitle(f.m, f.m.node("sh-boss-go")));
  assert.ok(f.m.text().includes("Retreat? (a Postmortem)"));
  // no fight: after the ladder, as before; the estimate in the title row (with the button when
  // there is one), so it stays in view when a long ladder pushes the card down
  const c = await mount("sheet", "career");
  assert.deepEqual(order(c.m), ["title", "ladder", "sh-boss"], "no fight: the card after the ladder");
  assert.equal(c.m.node("sh-boss-go"), null, "Rue's door is shut: no button");
  assert.ok(inTitle(c.m, c.m.node("sh-boss-est")), "the estimate in the title row");
  assert.equal(c.m.node("sh-boss-est").children[0].text, "Risky 0.61×");
  const pipBoss = S.scenarios.provisional.career.boss;
  const vmOf = (boss) => ({ ...S.scenarios.career, career: { ...S.scenarios.career.career, boss } });
  // an open door: estimate, then Challenge, both in the title row
  const challenge = S.action("challenge:3", "Challenge", "challenge", { kind: "boss", idx: 3 }, { tone: "primary", tooltip: "Rue fights" });
  const door = await mount("sheet", "career", { host: { vm: vmOf({ ...S.scenarios.career.career.boss, status: "Door open", challenge }) } });
  const row = door.m.node("sh-boss").children[0];
  const right = row.children.at(-1);
  assert.deepEqual(right.children.map((n) => n.id), ["sh-boss-est", "sh-boss-go"], "estimate, then Challenge");
  // a fight with an estimate: the estimate goes beside the status, the title row is the Retreat's
  const fe = await mount("sheet", "career", { host: { vm: vmOf({ ...pipBoss, estimate: { text: "Even 1.02×", color: "#F2B84B" } }) } });
  click(fe.m, "sh-boss-go");
  assert.ok(fe.m.text().includes("Retreat? (a Postmortem)"));
  assert.equal(inTitle(fe.m, fe.m.node("sh-boss-est")), false, "fighting: the estimate beside the status");
  const status = fe.m.findAll((n) => n.type === "text" && n.text === pipBoss.status)[0];
  assert.equal(fe.m.node("sh-boss-est").parent, status.parent.parent, "on the status line");
  assert.deepEqual([...errorsOf(f.m), ...errorsOf(c.m), ...errorsOf(door.m), ...errorsOf(fe.m)], []);
});

test("sheet skills: the left column scrolls, and the SP note sits with the respec rules above the ladder", async () => {
  const note = "Intern points are refunded at Lv 10, when the class arrives.";
  const vm = { ...S.scenarios.skills, skills: { ...S.scenarios.skills.skills, note } };
  const { m } = await mount("sheet", "skills", { host: { vm } });
  assertClean(m, "skills + note");
  const col = m.node("sh-skills-l");
  assert.ok(col && col.has("overflow_y_scroll"), "the column scrolls (it ran under the footer)");
  const noteEl = m.node("sh-sp-note");
  assert.ok(noteEl, "the note");
  assert.equal(noteEl.parent, m.node("sh-respec").parent, "with the respec button and its rules");
  const blocks = col.children[0].children;
  const at = (pred) => blocks.findIndex(pred);
  assert.ok(at((n) => n === noteEl.parent) < at((n) => n.children.some((c) => typeof c.id === "string" && c.id.startsWith("sh-lad-"))), "above the ladder");
  // the effect and next-rank lines wrap instead of cutting their numbers
  const card = m.node("sh-sk:area");
  const lines = m.findAll((n) => n.type === "text" && (n.text === S.scenarios.skills.skills.skills.find((k) => k.key === "sk:area").effect));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].parent.has("truncate"), false, "the effect wraps");
  assert.ok(card);
});

// ---------------------------------------------------------------------------------------------
// hover and icons, contrast

/**
 * svg() icons under an element that hovers its text colour. herdr gives an svg its colour once,
 * from the static text_color it inherits when it builds the element (materialize.rs, the Svg arm);
 * the parent's hover((s) => s.text_color(..)) never reaches it, so the icon would not follow the
 * label. An element on the way with its own static text_color stops the walk (its text does not
 * follow the hover either).
 */
function hoverIconMisses(m) {
  const out = [];
  const walk = (n, root) => {
    for (const c of [...n.children, ...Object.values(n.slots)]) {
      if (c.type === "svg") { out.push(`${root.id ?? root.type} → ${c.src}`); continue; }
      if (c.type === "text" || c.has("text_color")) continue;
      walk(c, root);
    }
  };
  for (const n of m.findAll((x) => (x.state.hover ?? []).some(([k]) => k === "text_color"))) walk(n, n);
  return out;
}

test("icons: no svg sits under a hover text_color (herdr would not recolour it); every scenario of both dialogs", async () => {
  // the check itself catches the pattern
  M.resetState();
  const probe = await M.mountView(class extends View {
    render() {
      return div().id("probe").hover((s) => s.text_color("#ffffff")).child(div().child(svg("mods/down-the-stack/art/ui/close.svg").w(12).h(12)));
    }
  }, { props: {} });
  probe.render();
  assert.deepEqual(hoverIconMisses(probe), ["probe → mods/down-the-stack/art/ui/close.svg"]);
  for (const kind of ["sheet", "herd"]) {
    const { samples } = KIND[kind];
    for (const name of Object.keys(samples.scenarios)) {
      for (const theme of THEMES) {
        const { m } = await mount(kind, name, { theme });
        assert.deepEqual(hoverIconMisses(m), [], `${kind}/${name} ${theme}`);
      }
    }
  }
});

test("tabs, icon buttons and slot chips hover with their background; icons carry the label's colour", async () => {
  for (const [kind, name, prefix] of [["sheet", "gear", "sh"], ["herd", "stash", "hd"]]) {
    for (const theme of THEMES) {
      const { m, host } = await mount(kind, name, { theme });
      const t = SheetMod.dialogTheme(SheetMod.dialogTokens());
      const tabs = m.findAll((n) => typeof n.id === "string" && n.id.startsWith(`${prefix}-tab-`));
      assert.ok(tabs.length >= 5);
      const current = lastView(host).tab;
      for (const tb of tabs) {
        const on = tb.id === `${prefix}-tab-${current}`;
        assert.equal(tb.last("text_color")[0], on ? t.fg : t.muted, `${kind} ${tb.id} label colour (muted when inactive)`);
        assert.deepEqual(tb.state.hover.map(([k]) => k), ["bg"], `${kind} ${tb.id} hovers its background`);
        const icon = tb.children.find((c) => c.type === "svg");
        assert.equal(icon.last("text_color")[0], tb.last("text_color")[0], `${kind} ${tb.id} icon = label colour`);
      }
      for (const id of [`${prefix}-close`, `${prefix}-f-slot-hat`]) {
        const n = m.node(id);
        assert.ok(n, id);
        assert.deepEqual(n.state.hover.map(([k]) => k), ["bg"], `${id} hovers its background`);
        assert.ok(n.children.find((c) => c.type === "svg").has("text_color"), `${id} icon has its own colour`);
      }
      // label chips still brighten their text on hover
      assert.ok(m.node(`${prefix}-f-usable`).state.hover.some(([k]) => k === "text_color"));
    }
  }
});

test("herd header: the counts in muted, the waiting part in the blocked colour; the sheet's status line in muted", async () => {
  const { ink } = await import("../mods/down-the-stack/ui/party.js");
  const { C } = await import("../mods/down-the-stack/ui/kit.js");
  for (const theme of THEMES) {
    const { m } = await mount("herd", "upgrades", { theme });
    const t = SheetMod.dialogTheme(SheetMod.dialogTokens());
    const textNode = (s) => m.findAll((n) => n.type === "text" && n.text === s)[0]?.parent ?? null;
    const counts = textNode("9 heroes · 2 working ·");
    const waiting = textNode("1 needs you");
    assert.ok(counts && waiting, theme);
    assert.equal(waiting.last("text_color")[0], ink(C.blocked, t), theme);
    assert.equal(counts.parent.last("text_color")[0], t.muted, theme);
    // nobody waiting: one muted line
    const quiet = await mount("herd", "stashEmpty", { theme });
    const line = quiet.m.findAll((n) => n.type === "text" && n.text === "1 hero · 1 working")[0]?.parent;
    assert.equal(line.last("text_color")[0], t.muted, theme);
    const sheet = await mount("sheet", "gear", { theme });
    const sub = sheet.m.findAll((n) => n.type === "text" && n.text.startsWith("herdr-app · Claude Code"))[0]?.parent;
    assert.equal(sub.last("text_color")[0], t.muted, theme);
  }
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

test("herd tracker: a locked zone's number reads on its well (dim ink), an open zone's dark ink on its accent", async () => {
  for (const theme of THEMES) {
    const { m } = await mount("herd", "tracker", { theme });
    const t = SheetMod.dialogTheme(SheetMod.dialogTokens());
    const numOf = (key) => m.node(`hd-z-${key}`).children[0].children[0];
    assert.equal(numOf("lint_meadows").last("text_color")[0], "#16141F", theme);
    const locked = numOf("threadlock_keep");
    assert.equal(locked.last("bg")[0], t.well, theme);
    assert.equal(locked.last("text_color")[0], t.dim, `${theme}: not the dark ink on the dark well`);
    assert.ok(m.findAll((n) => n.type === "text" && n.text === "Locked").length >= 1, "a locked row says Locked");
  }
});

test("herd roster: with nobody on it the roster says how a hero comes (its emptyText); a roster with heroes does not", async () => {
  const { m } = await mount("herd", "rosterEmpty");
  assertClean(m, "rosterEmpty");
  const line = m.node("hd-roster-empty");
  assert.ok(line, "the empty line");
  assert.ok(m.text().includes("No heroes yet. Start an agent to hire one"));
  assert.ok(m.text().includes("Heroes retired at Lv 30+ rest here"), "the Hall of Fame's own empty line stays");
  const full = await mount("herd", "roster");
  assert.equal(full.m.node("hd-roster-empty"), null);
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

test("herd bosses: the fighting boss's row is revealed (scroll_to_item on the list's direct child) once per fight and tab visit", async () => {
  const { m, role } = await mount("herd", "bossFight");
  const asked = [];
  role.bossScroll = { __handle: role.bossScroll.__handle, scroll_to_item: (i) => asked.push(i), release() {} };
  role.ui.bossShown = undefined;
  m.render();
  const list = m.node("hd-bosses");
  assert.ok(list.has("track_scroll"), "the boss list tracks the handle");
  assert.deepEqual(asked, [3], "the fourth boss fights");
  assert.equal(list.children[3].id, "hd-b-octopus_merge", "the index is the row's place among the list's direct children");
  m.render();
  assert.deepEqual(asked, [3], "once: the person may scroll away");
  role.ui.tab = "upgrades";
  m.render();
  role.ui.tab = "bosses";
  m.render();
  assert.deepEqual(asked, [3, 3], "again on coming back to the tab");
  assert.deepEqual(errorsOf(m), []);
  // no fight: nothing to reveal
  const calm = await mount("herd", "bosses");
  const none = [];
  calm.role.bossScroll = { __handle: calm.role.bossScroll.__handle, scroll_to_item: (i) => none.push(i), release() {} };
  calm.role.ui.bossShown = undefined;
  calm.m.render();
  assert.deepEqual(none, []);
});

test("herd roster: Sheet opens the hero's sheet; Retire confirms first", async () => {
  const { m, host } = await mount("herd", "roster");
  click(m, "hd-sheet-r:2");
  assert.deepEqual(M.calls().openOverlay.map((c) => c.spec), [{ mod: "down-the-stack", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 2 } }]);
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
  assert.deepEqual(errorsOf(m), []);
  // no hud block in the layout: the switch is disabled
  const bare = await mount("herd", "settings");
  click(bare.m, "hd-sw-hud");
  assert.equal(runs("layout.toggle").length, 0);
});

// herdr's win98 theme as settings.rs resolve() gives it: derived from its palette (background
// #ffffff, like paper's), then its colors overrides: a black background under a light popover and chrome
const WIN98 = {
  background: "#000000", foreground: "#000000", surface: "#c0c0c0", popover: "#c0c0c0", raised: "#dfdfdf", hover: "#dfdfdf",
  border: "#808080", input: "#ffffff", muted: "#404040", dim: "#808080", accent: "#000080", accent_foreground: "#ffffff",
  ring: "#000000", working: "#808000", blocked: "#ff0000", done: "#0000ff", idle: "#808080", unknown: "#808080",
};

test("herd settings: the loot-glow rarity names read at 4.5:1 on their control (paper, graphite, win98); the picked one by weight", async () => {
  const { contrast, over } = await import("../mods/down-the-stack/ui/party.js");
  for (const theme of [...THEMES, M.resolveTheme("paper", WIN98)]) {
    const label = typeof theme === "string" ? theme : "win98";
    const { m } = await mount("herd", "settingsOff", { theme });
    const t = SheetMod.dialogTheme(SheetMod.dialogTokens());
    for (let id = 1; id <= 5; id++) {
      const opt = m.node(`hd-opt-glow-${id}`);
      const fg = opt.last("text_color")[0];
      assert.match(fg, /^#[0-9a-fA-F]{6}$/, `${label} ${id}: full strength, no alpha (${fg})`);
      const picked = id === 3;
      const under = picked ? over(t.btn, t.well) : t.well;
      const r = contrast(fg, under);
      assert.ok(r >= 4.5, `${label} rarity ${id} ${fg} on ${under}: ${r.toFixed(2)}:1`);
      assert.equal(opt.has("font_bold"), picked, `${label} ${id}: the picked one is bold`);
    }
  }
});

test("win98 (black background, light popover): the dialogs take light-theme ink; the waiting cue reads", async () => {
  const { contrast, over, ink } = await import("../mods/down-the-stack/ui/party.js");
  const { C } = await import("../mods/down-the-stack/ui/kit.js");
  const theme = M.resolveTheme("paper", WIN98);
  const { m } = await mount("herd", "upgrades", { theme });
  const t = SheetMod.dialogTheme(SheetMod.dialogTokens());
  assert.equal(t.light, true, "light by its popover, as herdr classes win98 by its palette");
  assert.equal(t.popover, "#c0c0c0");
  const waiting = m.findAll((n) => n.type === "text" && n.text === "1 needs you")[0]?.parent;
  const fg = waiting.last("text_color")[0];
  assert.equal(fg, ink(C.blocked, t));
  assert.ok(contrast(fg, t.popover) >= 4.5, `"1 needs you" ${fg} on ${t.popover}: ${contrast(fg, t.popover).toFixed(2)}:1`);
  // the rename field is not black on black (it sat on the theme background)
  const rename = await mount("herd", "settings", { theme, ui: { renaming: true } });
  const field = rename.m.findAll((n) => n.type === "input" || (n.has("border_color") && n.has("text_color") && n.last("border_color")[0] === t.accent))[0];
  if (field && field.has("bg")) assert.ok(contrast(t.fg, over(field.last("bg")[0], t.popover)) >= 4.5, "the rename field's text reads");
  // a dark theme is untouched: graphite keeps the raw game colours
  await mount("herd", "upgrades", { theme: "graphite" });
  assert.equal(SheetMod.dialogTheme(SheetMod.dialogTokens()).light, false);
  assert.equal(ink(C.blocked, SheetMod.dialogTheme(SheetMod.dialogTokens())), C.blocked);
});

test("herd settings: Stage height finds the stage by its content; no stage in the layout → disabled, no layout.resize", async () => {
  const block = (id, role, extra = {}) => ({ id, type: "block", size: { px: 200 }, content: { mod: "down-the-stack", props: { role } }, ...extra });
  const tree = (...children) => ({ id: "root", type: "column", children: [{ id: "panes", type: "block", content: { builtin: "panes" } }, ...children] });
  // herdr's own main layout has no stage (the panel opens there from a toast's mod.open): the
  // choice is disabled and nothing runs (herdr would toast "layout.resize failed")
  const none = await mount("herd", "settings", { fixture: { layout: tree() } });
  click(none.m, "hd-opt-stageH-120");
  assert.deepEqual(none.host.commands, []);
  assert.equal(runs("layout.resize").length, 0);
  assert.equal(M.calls().toasts.length, 0);
  const ch = none.m.node("hd-choice-stageH");
  assert.equal(ch.methods.find((x) => x[0] === "tooltip")?.[1][0], "This layout has no stage");
  assert.ok(ch.methods.some((x) => x[0] === "opacity"), "dimmed like the HUD switch");
  assert.deepEqual(errorsOf(none.m), []);
  // a cloned layout whose stage block has another id: that id
  const other = await mount("herd", "settings", { fixture: { layout: tree(block("arena", "stage"), block("strip", "hud", { hidden: true })) } });
  click(other.m, "hd-opt-stageH-120");
  click(other.m, "hd-sw-hud");
  assert.deepEqual(other.host.commands, [["setting", { key: "stageH", value: 120 }]]);
  assert.deepEqual(runs("layout.resize").map((c) => c.args), [{ id: "arena", px: 120 }]);
  assert.deepEqual(runs("layout.toggle").map((c) => c.args), [{ id: "strip" }]);
  assert.deepEqual(errorsOf(other.m), []);
  // a hidden (collapsed) stage takes the height and the flash says so
  const hidden = await mount("herd", "settings", { fixture: { layout: tree(block("stage", "stage", { hidden: true })) } });
  click(hidden.m, "hd-opt-stageH-64");
  assert.deepEqual(runs("layout.resize").map((c) => c.args), [{ id: "stage", px: 64 }]);
  assert.match(hidden.m.text(), /The stage is hidden now; it opens at this height\./);
  // another mod's stage-role block is not ours
  const foreign = await mount("herd", "settings", { fixture: { layout: tree({ ...block("stage2", "stage"), content: { mod: "elsewhere", props: { role: "stage" } } }) } });
  click(foreign.m, "hd-opt-stageH-120");
  assert.equal(runs("layout.resize").length, 0);
});

test("herd settings (D§11.15): loot glow, collapse the stage, the autopilot master switch; inactive systems do nothing", async () => {
  const { m, host } = await mount("herd", "settingsOff");
  // the six rarities, each in its colour; the current one picked (on its button, lightened just
  // enough to clear 4.5:1 there: the same hue)
  const { mix } = await import("../mods/down-the-stack/ui/party.js");
  for (const [id, color] of [[0, "#A0A4AB"], [3, "#B36BFF"], [5, "#FF7AA8"]]) {
    const opt = m.node(`hd-opt-glow-${id}`);
    assert.ok(opt, `option ${id}`);
    const tc = opt.methods.find((x) => x[0] === "text_color")[1][0];
    const ok = [0, 0.05, 0.1, 0.15].some((k) => mix(color, "#ffffff", k).toUpperCase() === tc.toUpperCase());
    assert.ok(ok, `${id}: ${tc}`);
    if (id !== 3) assert.equal(tc.toUpperCase(), color, `${id}: unpicked, the rarity colour itself`);
  }
  click(m, "hd-opt-glow-3"); // already picked: inert
  click(m, "hd-opt-glow-5");
  click(m, "hd-sw-collapse");
  click(m, "hd-sw-auto.equip"); // inactive while autopilot is off
  click(m, "hd-sw-auto.farm");
  click(m, "hd-sw-auto");
  assert.deepEqual(host.commands, [
    ["setting", { key: "glow", value: 5 }],
    ["setting", { key: "collapse", value: false }],
    ["setting", { key: "auto", value: true }],
  ]);
  assert.ok(m.node("hd-set-auto.equip").methods.some((x) => x[0] === "opacity"), "inactive rows are dimmed");
  assert.match(m.node("hd-set-auto.equip").methods.find((x) => x[0] === "tooltip")[1][0], /Autopilot is off/);
  const on = await mount("herd", "settings");
  assert.equal(on.m.node("hd-set-auto.equip").methods.some((x) => x[0] === "opacity"), false);
  click(on.m, "hd-sw-auto.equip");
  click(on.m, "hd-sw-collapse");
  assert.deepEqual(on.host.commands, [["setting", { key: "auto.equip", value: false }], ["setting", { key: "collapse", value: true }]]);
  assert.ok(clean(m, on.m), errorsOf(m).concat(errorsOf(on.m)).join("; "));
});

test("herd: down-the-stack.herd closes the panel; sheet and calm act like the chrome roles", async () => {
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

test("herd: a save in trouble shows the band under the header (D§13.4), with the full text in its tooltip", async () => {
  for (const theme of THEMES) {
    const { m } = await mount("herd", "saveReadOnly", { theme });
    assertClean(m, `saveReadOnly ${theme}`);
    const band = m.node("hd-save");
    assert.ok(band, theme);
    assert.ok(m.findAll((n) => n.type === "text" && n.text === "Save is read-only").length === 1, theme);
    assert.match(band.last("tooltip")[0], /newer version/);
    // the tabs still switch with the band shown, and it stays
    m.fire("hd-tab-stash");
    m.render();
    assert.ok(m.node("hd-save"), `${theme}: the band stays on another tab`);
  }
  const fine = await mount("herd", "upgrades");
  assert.equal(fine.m.node("hd-save"), null, "no band while the save is fine");
});

// ---------------------------------------------------------------------------------------------
// round 4 (the owner's screenshots in real herdr)

const tipOf = (m, id) => m.node(id)?.last("tooltip")?.[0] ?? null;

test("round 4 (P2): a tab's tooltip names its key, and what its badge counts (\"Digest (6)\" read as six new)", async () => {
  const s = await mount("sheet", "gear"); // Kip: one skill point
  assert.equal(tipOf(s.m, "sh-tab-gear"), "Gear · key 1");
  assert.equal(tipOf(s.m, "sh-tab-skills"), "Skills · 1 skill point to spend · key 2");
  assert.equal(tipOf(s.m, "sh-tab-journal"), "Journal · key 5");
  const h = await mount("herd", "roster");
  assert.equal(tipOf(h.m, "hd-tab-upgrades"), "Upgrades · key 1");
  assert.equal(tipOf(h.m, "hd-tab-digest"), "Digest · 4 new since you last looked · key 6");
  assert.equal(tipOf(h.m, "hd-tab-settings"), "Settings · key 7");
  for (const m of [s.m, h.m]) {
    for (const n of m.findAll((x) => typeof x.id === "string" && /-tab-/.test(x.id))) assert.doesNotMatch(n.last("tooltip")[0], /\(\d+\)/, n.id);
  }
});

test("round 4 (P1): the sheet's contractor banner says when it is hired (its tooltip the whole story); the tag too", async () => {
  const { m } = await mount("sheet", "contractor");
  const vm = S.scenarios.contractor;
  assert.ok(m.text().includes("Contractor: hired tomorrow at 04:00 · not saved until then"));
  assert.equal(tipOf(m, "sh-note"), vm.note.tooltip);
  assert.equal(tipOf(m, "sh-tag"), vm.header.tagTip);
  assertClean(m, "contractor");
});

test("round 4 (P1): a Contractor's sheet sends its terminal and follows the hero id it is hired under", async () => {
  const { m, host } = await mount("sheet", "contractor");
  m.render();
  assert.deepEqual([lastView(host).heroId, lastView(host).address, lastView(host).name], [-3, "t33", "Wren Monorepo-Raised"]);
  // hired: the VM for that terminal carries the new roster id; the sheet asks for that id from now on
  const hired = { ...S.scenarios.contractor, heroId: 9, note: null, header: { ...S.scenarios.contractor.header, tag: null, tagTip: null } };
  host.view = function view(k, args) { this.views.push([k, JSON.parse(JSON.stringify(args))]); return hired; };
  m.render();
  m.render();
  assert.equal(lastView(host).heroId, 9);
  assert.equal("address" in lastView(host) || "name" in lastView(host), false, "a roster hero is asked for by id alone");
  assert.equal(m.text().includes("Contractor:"), false);
});

test("round 4 (P4, P1): a space with one hero has no header line, its row names the space; a Contractor's row says when it is hired", async () => {
  for (const slim of [false, true]) {
    const base = H.scenarios.roster;
    const vm = { ...base, roster: { ...base.roster, slim } };
    const { m } = await mount("herd", "roster", { host: { vm } });
    const text = m.text();
    // (a space name that may not fit is drawn as a head and a tail since round 4c)
    const joined = (n) => (n.type === "text" ? n.text : n.children.map(joined).join(""));
    assert.equal(text.includes("One hero per space"), false, `${slim}: the one-hero block has no header`);
    assert.ok(text.includes("herdr-app · 3") && text.includes("Off duty · 4"), `${slim}: spaces with two or more keep theirs`);
    assert.equal(joined(m.node("hd-sp-r:9")), "docs-site");
    assert.equal(joined(m.node("hd-sp-r:-1")), "ref-client");
    assert.equal(m.node("hd-sp-r:1"), null, "a row under its space's header does not repeat it");
    assert.equal(m.node("hd-hire-r:-1").children[0].text, "Hired tomorrow 04:00");
    assert.match(tipOf(m, "hd-hire-r:-1"), /^Hired at the next 04:00 game day/);
    assert.equal(m.node("hd-hire-r:9"), null);
    assert.ok(text.includes("1 contractor, the next hired tomorrow at 04:00"));
    if (slim) assert.match(tipOf(m, "hd-r:-1"), /^ref-client · Wren Monorepo-Raised \(contractor\) · .* · Hired at the next 04:00 game day/);
    assertClean(m, `roster slim=${slim}`);
  }
});

test("round 4c: space names that share a start are cut in the middle in the Roster ('ceo-assi…res-2'), the whole name on hover, so two rows stay apart", async () => {
  const joined = (n) => (n.type === "text" ? n.text : n.children.map(joined).join(""));
  const base = H.scenarios.roster;
  const [one, ...rest] = base.roster.groups;
  const [a, b] = one.rows;
  // a space whose header does not fit a 640 px dialog (a long folder name)
  const long = "ceo-assistant-lead-platform-infrastructure-migration-for-the-north-america-west-region-and-the-eu-backup";
  for (const slim of [true, false]) {
    for (const width of [640, 760]) {
      const groups = [
        { ...one, rows: [{ ...a, space: "ceo-assistant-res-2" }, { ...b, space: "ceo-assistant-writer" }] },
        { ...rest[0], key: "g:long", name: long },
        ...rest.slice(1),
      ];
      const vm = { ...base, roster: { ...base.roster, slim, groups } };
      const { m } = await mount("herd", "roster", { width, host: { vm } });
      const where = `slim ${slim} at ${width}`;
      const tails = [];
      for (const [row, name] of [[a, "ceo-assistant-res-2"], [b, "ceo-assistant-writer"]]) {
        const cell = m.node(`hd-sp-${row.key}`);
        assert.equal(joined(cell), name, `${where}: the whole name`);
        if (!slim) {
          // a wide row's 160 px space cell has room for it: one plain box, as before
          assert.equal(cell.children[0].type, "text", where);
          continue;
        }
        // a slim row's 92 / 118 px column: a head that gives way and a tail that stays whole
        const [head, tail] = cell.children;
        assert.ok(head.has("truncate") && head.has("min_w"), `${where}: the head gives way`);
        assert.ok(tail.has("flex_none") && !tail.has("truncate"), `${where}: the tail stays whole`);
        assert.equal(head.children[0].text, "ceo-assistant-");
        tails.push(tail.children[0].text);
        // the whole name on hover: the slim row's own tooltip starts with it
        assert.ok(tipOf(m, `hd-${row.key}`).startsWith(`${name} · `), where);
      }
      if (slim) assert.deepEqual(tails, ["res-2", "writer"], `${where}: the two rows end apart`);
      // a space's header too long for the dialog: cut in the middle, its whole name on hover, its
      // count whole; a short one stays one text ("herdr-app · 3" above)
      const gt = m.node("hd-gt-g:long");
      assert.ok(gt, `${where}: split`);
      assert.equal(joined(gt), long);
      assert.equal(tipOf(m, "hd-gt-g:long"), long);
      assert.ok(gt.children[1].has("flex_none"));
      assert.equal(joined(gt.parent).replace(/\u00A0/g, " "), `${long} · ${rest[0].rows.length}`);
      assertClean(m, where);
    }
  }
});

test("round 4 (P4, P1): a Contractor's hire moment shrinks rather than push a row's fixed cells out; a narrow dialog narrows the slim columns", async () => {
  const base = H.scenarios.roster;
  const vm = { ...base, roster: { ...base.roster, slim: true } };
  for (const width of [640, 760]) {
    const { m } = await mount("herd", "roster", { width, host: { vm } });
    // a flex_none hire beside fixed name / level / seen / Retire / Sheet cells overflows a 640 px
    // dialog: the Sheet button leaves the row. It shrinks (truncated); title · where gives way first
    const hire = m.node("hd-hire-r:-1");
    assert.equal(hire.has("flex_none"), false, `${width}: the hire text never refuses to shrink`);
    assert.deepEqual(hire.last("min_w"), [0]);
    assert.ok(hire.has("truncate"));
    // title · where and seen share what is left (round 4b: one basis-0 cell, so they give way before
    // the hire moment does: title first, then seen)
    const rest = hire.parent.children[hire.parent.children.indexOf(hire) + 1];
    assert.ok(rest.has("flex_1") && rest.has("min_w"), "title · where and seen take what is left");
    const [title, seen] = rest.children;
    assert.ok(title.has("flex_1") && title.has("truncate"), "title · where gives way first");
    assert.ok(!seen.has("flex_none") && seen.has("truncate") && seen.has("text_right"), "then seen, cut");
    // the space column: 118 px, 92 below 720 px (the name column 170 / 140)
    assert.deepEqual(m.node("hd-sp-r:9").last("w"), [width < 720 ? 92 : 118]);
    assertClean(m, `roster slim at ${width}`);
  }
  // wide rows: the space and the hire shrink too
  const wide = await mount("herd", "roster", { width: 640 });
  assert.equal(wide.m.node("hd-sp-r:-1").has("flex_none"), false);
  assert.equal(wide.m.node("hd-hire-r:-1").has("flex_none"), false);
});

test("round 4 (P5): the Digest on screen sees its losses: lossesSeen once, from a timer (never in render), only on that tab", async () => {
  const d = await mount("herd", "digest");
  assert.deepEqual(d.host.commands, [], "nothing runs in render");
  await d.m.tick(1000);
  assert.deepEqual(d.host.commands, [["lossesSeen", {}]]);
  await d.m.tick(3000);
  assert.deepEqual(d.host.commands, [["lossesSeen", {}]], "once per unseen count (a refused one is not asked again every second)");
  // the sections lead with the losses
  const first = d.m.findAll((n) => typeof n.id === "string" && n.id.startsWith("hd-ds-"))[0];
  assert.equal(first.id, "hd-ds-unreviewed");
  // another tab: nothing
  const r = await mount("herd", "roster");
  await r.m.tick(2000);
  assert.deepEqual(r.host.commands, []);
  // nothing unseen: nothing
  const e = await mount("herd", "digestEmpty");
  await e.m.tick(2000);
  assert.deepEqual(e.host.commands, []);
});

test("round 4 (P7): the Stage strip switch shows or hides the stage found by content, whoever hid it; disabled without a stage", async () => {
  const block = (id, role, extra = {}) => ({ id, type: "block", size: { px: 200 }, content: { mod: "down-the-stack", props: { role } }, ...extra });
  const tree = (...children) => ({ id: "root", type: "column", children: [{ id: "panes", type: "block", content: { builtin: "panes" } }, ...children] });
  // hidden (by herdr's .state from an earlier install, say), under another id: the switch reads off
  const hidden = await mount("herd", "settings", { fixture: { layout: tree(block("arena", "stage", { hidden: true })) } });
  assert.equal(tipOf(hidden.m, "hd-sw-stage"), "Show the stage strip");
  click(hidden.m, "hd-sw-stage");
  assert.deepEqual(runs("layout.show").map((c) => c.args), [{ id: "arena" }]);
  assert.deepEqual(hidden.host.commands, [], "no herd.cfg change: the layout holds it");
  assert.ok(hidden.m.text().includes("Stage strip shown."));
  assert.equal(tipOf(hidden.m, "hd-sw-stage"), "Hide the stage strip");
  assert.deepEqual(errorsOf(hidden.m), []);
  // shown: hides it
  const shown = await mount("herd", "settings", { fixture: { layout: tree(block("stage", "stage")) } });
  assert.equal(tipOf(shown.m, "hd-sw-stage"), "Hide the stage strip");
  click(shown.m, "hd-sw-stage");
  assert.deepEqual(runs("layout.hide").map((c) => c.args), [{ id: "stage" }]);
  // a host that owns the stage's collapse acts for the switch (host.stageStrip), and its answer flashes
  const owned = await mount("herd", "settings", { fixture: { layout: tree(block("stage", "stage", { hidden: true })) } });
  const asked = [];
  owned.host.stageStrip = (show, id) => { asked.push([show, id]); return { ok: true, msg: "Stage shown (the collapse lets it be)." }; };
  click(owned.m, "hd-sw-stage");
  assert.deepEqual(asked, [[true, "stage"]]);
  assert.equal(runs("layout.show").length, 0, "the host runs it");
  assert.ok(owned.m.text().includes("Stage shown (the collapse lets it be)."));
  // no stage in this layout (herdr's main layout, from a toast's mod.open): disabled, says why
  const none = await mount("herd", "settings", { fixture: { layout: tree(block("hud", "hud")) } });
  assert.equal(tipOf(none.m, "hd-sw-stage"), "This layout has no stage");
  assert.ok(none.m.text().includes("This layout has no stage"), "the row's hint says why");
  click(none.m, "hd-sw-stage");
  assert.equal(runs("layout.show").length + runs("layout.hide").length + runs("layout.toggle").length, 0);
  assert.deepEqual(errorsOf(none.m), []);
  // its place: beside the HUD strip switch
  const rows = none.m.findAll((n) => typeof n.id === "string" && n.id.startsWith("hd-set-")).map((n) => n.id);
  assert.equal(rows.indexOf("hd-set-hud") - rows.indexOf("hd-set-stage"), 1);
});

test("round 4 (P7): a host that keeps the stage's state (stageInfo) is believed over layout() (herdr runs run() after the click)", async () => {
  const block = (id, role, extra = {}) => ({ id, type: "block", size: { px: 200 }, content: { mod: "down-the-stack", props: { role } }, ...extra });
  const layout = { id: "root", type: "column", children: [{ id: "panes", type: "block", content: { builtin: "panes" } }, block("arena", "stage")] };
  const { m, host } = await mount("herd", "settings", { fixture: { layout } });
  assert.equal(tipOf(m, "hd-sw-stage"), "Hide the stage strip");
  // the host has just hidden it; layout() has not caught up yet
  host.stageInfo = () => ({ id: "arena", hidden: true, held: false });
  host.stageStrip = (show, id) => ({ ok: true, id, hidden: !show });
  m.render();
  assert.equal(tipOf(m, "hd-sw-stage"), "Show the stage strip");
  click(m, "hd-sw-stage");
  assert.ok(m.text().includes("Stage strip shown."));
  // the stage height row acts on that node too
  click(m, "hd-opt-stageH-120");
  assert.deepEqual(runs("layout.resize").map((c) => c.args), [{ id: "arena", px: 120 }]);
  host.stageInfo = () => null;
  m.render();
  assert.equal(tipOf(m, "hd-sw-stage"), "This layout has no stage");
});
