// Tests for the three chrome roles that live in herdr's own UI: party (sidebar), nameplate (pane
// header) and hud (strip). Every sample scenario (tools/vm-samples/*.mjs) renders through the
// strict mock at several widths, zoom 1 and 2, in a dark and a light theme, with zero validator
// errors; handlers fire the herdr commands / engine commands the contract names; the next tick's
// VM keeps every id.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("../tools/mock/index.mjs");
const { View } = await import("gpui-kit");
const { props } = await import("herdr");
const PartyMod = await import("../mods/mapledr/ui/party.js");
const PlateMod = await import("../mods/mapledr/ui/nameplate.js");
const HudMod = await import("../mods/mapledr/ui/hud.js");
const P = await import("../tools/vm-samples/party.mjs");
const N = await import("../tools/vm-samples/nameplate.mjs");
const H = await import("../tools/vm-samples/hud.mjs");

const NOW = Date.UTC(2026, 10, 24, 9, 30);
const THEMES = ["graphite", "paper"];
const ROLE = { party: PartyMod, nameplate: PlateMod, hud: HudMod };

/** A fake GameHost: view() answers the role's kind with `vm`; command() records. */
function fakeHost(kind, vm, extra = {}) {
  return {
    world: null, version: 1, vm, views: [], commands: [],
    view(k, args) { this.views.push([k, args]); return k === kind ? this.vm : (extra[k] ?? null); },
    command(name, args) { this.commands.push([name, args]); return { ok: true }; },
    claim: () => true,
  };
}

/**
 * Mount a role the way main.js does (role object inside a View), render, report a size, render.
 * Returns { m, host, view }.
 */
async function mount(kind, vm, { width = 268, height = 460, zoom = 1, theme = "graphite", roleProps = {}, fixture = {}, extra } = {}) {
  M.resetState();
  M.resetStorage();
  const host = fakeHost(kind, vm, extra);
  const R = ROLE[kind].default;
  class Wrap extends View {
    init(_p, cx) { this.role = new R(); this.role.init(props() ?? { role: kind, ...roleProps }, cx, host); }
    render(cx) { return this.role.render(cx); }
  }
  const m = await M.mountView(Wrap, { props: { role: kind, ...roleProps }, fixture: { settings: { zoom }, theme, ...fixture }, nowMs: NOW });
  m.render();
  m.size(width * zoom, height * zoom);
  m.render();
  return { m, host, view: m.view };
}

const ids = (m) => new Set(m.findAll((n) => n.id != null).map((n) => n.id));
const runs = (name) => M.calls().run.filter((c) => c.name === name);
const overlays = () => M.calls().openOverlay.map((c) => c.spec);
const has = (m, method) => m.findAll((n) => n.methods.some((x) => x[0] === method)).length > 0;
const errorsOf = (m) => m.errors.map((e) => `${e.code}: ${e.message}`);
const dupes = (m) => m.warnings.filter((w) => w.code === "duplicate-id" || w.code === "many-elements").map((w) => w.message);

function assertClean(m, label) {
  assert.ok(m.tree, `${label}: render failed: ${errorsOf(m).join("; ")}`);
  assert.deepEqual(errorsOf(m), [], label);
  assert.deepEqual(dupes(m), [], label);
  assert.ok(m.stats.elements < 400, `${label}: ${m.stats.elements} elements`);
}

const plateOpts = (name, over = {}) => {
  const p = { ...N.panes[name], ...(over.pane ?? {}) };
  return { width: over.width ?? N.widths[name], height: 34, roleProps: { pane: p.pane, terminal: p.terminal }, fixture: { panes: [p], ...(over.fixture ?? {}) }, ...over.opts };
};

// ---------------------------------------------------------------------------------------------
// every scenario renders clean

test("party: every scenario × widths × zoom 1/2 × dark/light renders with zero validator errors", async () => {
  for (const [name, vm] of Object.entries(P.scenarios)) {
    for (const width of [P.widths[name], 52, 200, 268, 420]) {
      for (const zoom of [1, 2]) {
        for (const theme of THEMES) {
          const { m } = await mount("party", vm, { width, zoom, theme });
          assertClean(m, `party/${name} w${width} z${zoom} ${theme}`);
        }
      }
    }
  }
});

test("nameplate: every scenario × widths × zoom 1/2 × dark/light renders with zero validator errors", async () => {
  for (const name of Object.keys(N.scenarios)) {
    for (const width of [N.widths[name], 220, 360, 480, 760, 1400]) {
      for (const zoom of [1, 2]) {
        for (const theme of THEMES) {
          const { m } = await mount("nameplate", N.scenarios[name], { ...plateOpts(name, { width }), zoom, theme });
          assertClean(m, `nameplate/${name} w${width} z${zoom} ${theme}`);
          m.hover(`pane-head-${N.panes[name].pane}`);
          m.render();
          assertClean(m, `nameplate/${name} hovered w${width} z${zoom} ${theme}`);
        }
      }
    }
  }
});

test("hud: every scenario × widths × zoom 1/2 × dark/light renders with zero validator errors", async () => {
  for (const [name, vm] of Object.entries(H.scenarios)) {
    for (const width of [H.widths[name], 360, 520, 960, 1600]) {
      for (const zoom of [1, 2]) {
        for (const theme of THEMES) {
          const { m } = await mount("hud", vm, { width, height: 26, zoom, theme });
          assertClean(m, `hud/${name} w${width} z${zoom} ${theme}`);
        }
      }
    }
  }
});

test("the pure renderers build a tree from a VM inside a plain render pass", async () => {
  const t0 = () => ({ width: 268, height: 460, zoom: 1, host: null, act: () => ({ ok: true }) });
  const cases = [
    () => PartyMod.renderParty(P.scenarios.six, t0()),
    () => PartyMod.renderParty(null, t0()),
    () => PlateMod.renderNameplate(N.scenarios.focused, { ...t0(), width: 760, pane: N.panes.focused, bottom: false, home: "/mock/user" }),
    () => PlateMod.renderNameplate(null, { ...t0(), width: 590, pane: N.panes.shell, bottom: true, home: "/mock/user" }),
    () => PlateMod.renderNameplate(N.scenarios.focused, { ...t0(), pane: null }),
    () => HudMod.renderHud(H.scenarios.normal, { ...t0(), width: 1170 }),
  ];
  for (const fn of cases) {
    M.resetState();
    const m = await M.mountView(class extends View { render() { return fn(); } }, { props: {} });
    m.render();
    assertClean(m, fn.toString());
  }
});

// ---------------------------------------------------------------------------------------------
// party behaviour (herdr's agents list + the game)

test("party: setAgentOrder(vm.agentOrder) on render, like herdr's agents list; none while loading", async () => {
  const { m } = await mount("party", P.scenarios.six);
  const last = M.calls().setAgentOrder.at(-1);
  assert.deepEqual(last.addresses, P.scenarios.six.agentOrder);
  assert.ok(m.ok);
  await mount("party", null);
  assert.equal(M.calls().setAgentOrder.length, 0);
});

test("party: asks host.view('party', {width, nowMs}) with the measured width", async () => {
  const { host } = await mount("party", P.scenarios.six, { width: 230, zoom: 2 });
  const [kind, args] = host.views.at(-1);
  assert.equal(kind, "party");
  assert.equal(args.width, 230);
  assert.equal(args.nowMs, NOW);
});

test("party: clicking a row marks it seen and focuses its pane (pane.focus, as herdr does)", async () => {
  const { m, host } = await mount("party", P.scenarios.six);
  m.fire("pr-h:2");
  assert.deepEqual(host.commands, [["markSeen", { heroId: 2 }]]);
  assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ pane: "p2" }]);
  assert.ok(m.ok, errorsOf(m).join());
});

test("party: a row without a pane id focuses by terminal", async () => {
  const vm = P.nextTick(P.scenarios.one);
  vm.groups[0].rows[0].pane = null;
  const { m } = await mount("party", vm);
  m.fire(`pr-${vm.groups[0].rows[0].key}`);
  assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ terminal: vm.groups[0].rows[0].address }]);
});

test("party: right-click, the portrait and the hover sheet button open the character sheet (760×500)", async () => {
  const { m } = await mount("party", P.scenarios.six);
  m.fire("pr-h:3", { button: "right" }, "mouse_down");
  m.fire("pp-h:3");
  m.hover("pr-h:3");
  m.render();
  m.fire("ps-h:3");
  const sheets = overlays();
  assert.equal(sheets.length, 3);
  for (const s of sheets) assert.deepEqual(s, { mod: "mapledr", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 3 } });
  assert.equal(runs("pane.focus").length, 0, "portrait / button clicks stop propagation");
});

test("party: the chest chip claims the chest without focusing", async () => {
  const { m, host } = await mount("party", P.scenarios.six);
  m.fire("pc-c:3:chest");
  assert.deepEqual(host.commands, [["claimChest", { heroId: 3 }]]);
  assert.equal(runs("pane.focus").length, 0);
});

test("party: the off-duty group starts folded; its header unfolds it; off-duty rows open the sheet", async () => {
  const { m, host } = await mount("party", P.scenarios.six);
  assert.equal(m.node("pr-h:7"), null);
  assert.ok(m.text().includes("Off duty"));
  m.fire("pg-g:off");
  m.render();
  assert.ok(m.node("pr-h:7"));
  m.fire("pr-h:7");
  assert.deepEqual(overlays().at(-1).props, { role: "sheet", heroId: 7 });
  assert.equal(runs("pane.focus").length, 0);
  assert.deepEqual(host.commands, []);
  // a space group folds too
  m.fire("pg-g:s1");
  m.render();
  assert.equal(m.node("pr-h:1"), null);
  assert.ok(m.node("pr-h:4"));
});

test("party: hover shows the pin toggle (terminal.pin), which clears the hover", async () => {
  const { m } = await mount("party", P.scenarios.six);
  assert.equal(m.node("pn-h:1"), null);
  m.hover("pr-h:1");
  m.render();
  assert.ok(m.node("pn-h:1"));
  m.fire("pn-h:1");
  assert.deepEqual(runs("terminal.pin").map((c) => c.args), [{ terminal: "t1", pinned: false }]);
  assert.equal(runs("pane.focus").length, 0);
  m.render();
  assert.equal(m.node("pn-h:1"), null);
});

test("party: footer Herd and settings buttons open the Herd panel (760×520); calm toggles the setting", async () => {
  const { m, host } = await mount("party", P.scenarios.six);
  m.fire("party-herd");
  m.fire("party-settings");
  assert.deepEqual(overlays(), [
    { mod: "mapledr", kind: "dialog", width: 760, height: 520, props: { role: "herd" } },
    { mod: "mapledr", kind: "dialog", width: 760, height: 520, props: { role: "herd", tab: "settings" } },
  ]);
  m.fire("party-calm");
  assert.deepEqual(host.commands, [["setting", { key: "calm", value: true }]]);
});

test("party: rail mode (vm.compact or < 160 px) shows live heroes only, and » unfolds the sidebar", async () => {
  for (const [vm, width] of [[P.scenarios.rail, 52], [P.scenarios.six, 120]]) {
    const layout = M.readLayout();
    layout.children[0].size = { px: 52 };
    const { m } = await mount("party", vm, { width, fixture: { layout, shared: { "sidebar.width": 300 } } });
    assert.ok(m.node("pr-h:1"));
    assert.equal(m.node("pr-h:7"), null, "off duty stays in the wide view");
    assert.equal(m.node("pg-g:s1"), null, "no group headers on the rail");
    assert.ok(!m.text().includes("Kip the Idempotent"), "no names on the rail");
    m.fire("pr-h:1");
    assert.deepEqual(runs("pane.focus").at(-1).args, { pane: "p1" });
    m.fire("party-unfold");
    assert.deepEqual(runs("layout.resize").at(-1).args, { id: "sidebar", px: 300 });
    assert.ok(m.ok, errorsOf(m).join());
  }
});

test("party: » on a wide sidebar folds it to the rail (76 px on macOS, 44 elsewhere)", async () => {
  const layout = M.readLayout();
  for (const [platform, px] of [["macos", 76], ["linux", 44]]) {
    const { m } = await mount("party", P.scenarios.rail, { width: 52, fixture: { layout, window: { platform, active: true, visible: true } } });
    m.fire("party-unfold");
    assert.deepEqual(runs("layout.resize").at(-1).args, { id: "sidebar", px });
    assert.deepEqual(M.calls().setShared.find((c) => c.key === "sidebar.width").value, 268);
  }
});

test("party: working faces blink unless calm; the level-up shimmer plays once and never in calm", async () => {
  const six = await mount("party", P.scenarios.six);
  assert.ok(has(six.m, "frames"));
  assert.ok(six.m.node("pl-h:5"));
  const calm = await mount("party", P.scenarios.calm);
  assert.ok(!has(calm.m, "frames"));
  assert.ok(!has(calm.m, "loop"));
  assert.equal(calm.m.node("pl-h:5"), null);
});

test("party: the next tick's VM keeps every id (stable keys)", async () => {
  for (const [name, vm] of Object.entries(P.scenarios)) {
    const { m, host } = await mount("party", vm, { width: P.widths[name] });
    const before = ids(m);
    host.vm = P.nextTick(vm);
    m.view.role.ui.size = { w: P.widths[name], h: 460 };
    m.render();
    assert.deepEqual([...ids(m)].sort(), [...before].sort(), name);
  }
});

test("party: renders the loading and empty states", async () => {
  const loading = await mount("party", null);
  assert.ok(loading.m.text().includes("Loading"));
  const empty = await mount("party", P.scenarios.empty);
  assert.ok(empty.m.text().includes("No heroes yet"));
  assert.ok(empty.m.node("party-herd"));
});

// ---------------------------------------------------------------------------------------------
// nameplate behaviour (herdr's pane header + the hero)

test("nameplate: asks host.view('nameplate', {terminal, pane}); a mod pane never asks", async () => {
  const { host } = await mount("nameplate", N.scenarios.focused, plateOpts("focused"));
  assert.deepEqual(host.views.at(-1), ["nameplate", { terminal: "t1", pane: "p1" }]);
  const modPane = { pane: "p50", terminal: null, mod: "files", tab: "tab1", title: "files", name: null, focused: false, zoomed: false };
  const r = await mount("nameplate", N.scenarios.focused, { width: 590, height: 34, roleProps: { pane: "p50", terminal: null }, fixture: { panes: [modPane] } });
  assert.equal(r.host.views.length, 0);
  assert.ok(r.m.text().includes("files"));
  assert.ok(r.m.ok);
});

test("nameplate: a null VM is exactly herdr's plain pane header", async () => {
  const shell = await mount("nameplate", null, plateOpts("shell"));
  assert.match(shell.m.text(), /zsh.*~\/src\/herdr-app/);
  assert.ok(!shell.m.text().includes("Lv"));
  // an agent pane while loading: program name, folder and herdr's status visuals
  const loading = await mount("nameplate", null, plateOpts("loading"));
  assert.match(loading.m.text(), /Claude Code/);
  assert.ok(has(loading.m, "frames"), "working spinner");
  const blocked = await mount("nameplate", null, plateOpts("blocked"));
  assert.ok(blocked.m.text().includes("Needs you"));
});

test("nameplate: click focuses the pane; hover buttons split / zoom / close and stop propagation", async () => {
  for (const vm of [N.scenarios.focused, null]) {
    const { m } = await mount("nameplate", vm, plateOpts("focused"));
    m.fire("pane-head-p1");
    assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ pane: "p1" }]);
    assert.equal(m.node("ph-r-p1"), null, "buttons only while hovered");
    m.hover("pane-head-p1");
    m.render();
    for (const id of ["ph-r-p1", "ph-d-p1", "ph-z-p1", "ph-x-p1"]) m.fire(id);
    assert.deepEqual(M.calls().run.slice(1).map((c) => [c.name, c.args]), [
      ["pane.split", { direction: "right", pane: "p1" }],
      ["pane.split", { direction: "down", pane: "p1" }],
      ["pane.zoom", { pane: "p1" }],
      ["pane.close", { pane: "p1" }],
    ]);
    assert.equal(runs("pane.focus").length, 1);
    m.hover("pane-head-p1", false);
    m.render();
    assert.equal(m.node("ph-r-p1"), null);
  }
});

test("nameplate: a zoomed pane shows the unzoom button", async () => {
  const { m } = await mount("nameplate", N.scenarios.focused, plateOpts("focused", { pane: { zoomed: true } }));
  m.hover("pane-head-p1");
  m.render();
  const svgs = m.findAll((n) => n.type === "svg").map((n) => n.src);
  assert.ok(svgs.includes("mods/mapledr/art/ui/unzoom.svg"));
  assert.ok(!svgs.includes("mods/mapledr/art/ui/zoom.svg"));
});

test("nameplate: the hero part focuses its pane (once) and opens the character sheet", async () => {
  const { m } = await mount("nameplate", N.scenarios.blocked, plateOpts("blocked"));
  m.fire("np-hero-p2");
  assert.deepEqual(overlays(), [{ mod: "mapledr", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 2 } }]);
  assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ pane: "p2" }]);
  const focusedPane = await mount("nameplate", N.scenarios.focused, plateOpts("focused"));
  focusedPane.m.fire("np-hero-p1");
  assert.equal(runs("pane.focus").length, 0, "an already focused pane is not focused again");
  assert.deepEqual(overlays().map((s) => s.props), [{ role: "sheet", heroId: 1 }]);
});

test("nameplate: shows the hero and herdr's own terminal title; narrow panes keep face, level and chip", async () => {
  const wide = await mount("nameplate", N.scenarios.focused, plateOpts("focused"));
  const text = wide.m.text();
  for (const s of ["Kip the Idempotent", "Lv 14", "Junior Refactorer", "✳ Fix flaky auth test", "fighting 2-2"]) assert.ok(text.includes(s), s);
  const narrow = await mount("nameplate", N.scenarios.narrow, plateOpts("narrow"));
  const t2 = narrow.m.text();
  assert.ok(t2.includes("Lv 14") && t2.includes("fighting 2-2"));
  assert.ok(!t2.includes("Kip the Idempotent") && !t2.includes("Fix flaky"));
  const contractor = await mount("nameplate", N.scenarios.contractor, plateOpts("contractor"));
  assert.ok(contractor.m.text().includes("(contractor)"));
});

test("nameplate: plan() drops career, then bars, so the terminal title keeps its room", () => {
  const vm = N.scenarios.long;
  const wide = PlateMod.plan(vm, 1400, false, "short title");
  assert.ok(wide.career && wide.bars && !wide.tiny);
  const mid = PlateMod.plan(vm, 760, false, N.panes.long.title);
  assert.ok(!mid.career && mid.bars, JSON.stringify(mid));
  const small = PlateMod.plan(vm, 400, false, N.panes.long.title);
  assert.ok(!small.bars && !small.tiny, JSON.stringify(small));
  const tiny = PlateMod.plan(vm, 220, true, N.panes.long.title);
  assert.ok(tiny.tiny && !tiny.chip, "hovered tiny header gives the chip's room to the buttons");
});

test("nameplate: hovered, the chip makes way so the pane buttons stay inside the header", () => {
  // Measured in Chromium: without this, close (and zoom) were clipped at 360–440 px when hovered.
  const long = N.scenarios.long, title = N.panes.long.title;
  for (const W of [360, 400, 440]) assert.equal(PlateMod.plan(long, W, true, title).chip, false, `long hovered ${W}`);
  assert.equal(PlateMod.plan(long, 400, false, title).chip, true, "not hovered: the chip stays");
  assert.equal(PlateMod.plan(long, 760, true, title).chip, true, "wide and hovered: room for both");
  assert.equal(PlateMod.plan(N.scenarios.blocked, 420, true, N.panes.blocked.title).chip, true);
});

test("party: the footer drops release, then the Herd label, then Snippets, so Herd never leaves the sidebar", async () => {
  const six = P.scenarios.six.footer, big = P.scenarios.blocked.footer;
  assert.deepEqual(PartyMod.footerFit(six, 268), { release: true, label: true, snippets: true });
  assert.deepEqual(PartyMod.footerFit(big, 268), { release: false, label: true, snippets: true });
  assert.deepEqual(PartyMod.footerFit(big, 210), { release: false, label: false, snippets: true });
  assert.deepEqual(PartyMod.footerFit(big, 160), { release: false, label: false, snippets: false });
  // At D§11.11's 240 px the button is still there, labelled or not.
  const { m } = await mount("party", P.scenarios.blocked, { width: 240 });
  assert.ok(m.node("party-herd"));
  assert.ok(!m.text().includes("v5.0"));
});

test("nameplate: the border faces the terminal (bottom header → top border)", async () => {
  const layout = M.readLayout();
  const frame = layout.children[1].children[1].children[0].content.pane;
  frame.header.position = "bottom";
  const { m } = await mount("nameplate", N.scenarios.focused, plateOpts("focused", { fixture: { layout } }));
  const root = m.node("pane-head-p1");
  assert.ok(root.methods.some((x) => x[0] === "border_t"));
  assert.ok(!root.methods.some((x) => x[0] === "border_b"));
});

test("nameplate: a missing pane renders an empty div; calm stops the face blinking", async () => {
  const gone = await mount("nameplate", N.scenarios.focused, { width: 590, height: 34, roleProps: { pane: "p404", terminal: "t404" }, fixture: { panes: [] } });
  assert.ok(gone.m.ok);
  assert.equal(gone.m.text(), "");
  const calm = await mount("nameplate", N.scenarios.calm, plateOpts("calm"));
  assert.ok(!has(calm.m, "frames"));
  const working = await mount("nameplate", N.scenarios.focused, plateOpts("focused"));
  assert.ok(has(working.m, "frames"));
});

test("nameplate: the next tick's VM keeps every id", async () => {
  for (const name of Object.keys(N.scenarios)) {
    const { m, host } = await mount("nameplate", N.scenarios[name], plateOpts(name));
    const before = ids(m);
    host.vm = N.nextTick(N.scenarios[name]);
    m.render();
    assert.deepEqual([...ids(m)].sort(), [...before].sort(), name);
  }
});

// ---------------------------------------------------------------------------------------------
// hud behaviour

test("hud: a click anywhere opens the Herd panel; counts carry status colours", async () => {
  const { m } = await mount("hud", H.scenarios.normal, { width: 1170, height: 26 });
  m.fire("hud-working");
  assert.deepEqual(overlays(), [{ mod: "mapledr", kind: "dialog", width: 760, height: 520, props: { role: "herd" } }]);
  const text = m.text();
  for (const s of ["48.2k", "133", "v2.3", "Pyramid of Doom", "7/10", "working", "blocked", "shipped"]) assert.ok(text.includes(s), s);
  const narrow = await mount("hud", H.scenarios.normal, { width: 400, height: 26 });
  assert.ok(!narrow.m.text().includes("working"), "narrow strips drop the words");
  assert.ok(!narrow.m.text().includes("Pyramid"), "and the sprint");
});

test("hud: loading and zeros render; the next tick keeps every id", async () => {
  const loading = await mount("hud", null, { width: 1170, height: 26 });
  assert.ok(loading.m.text().includes("loading"));
  for (const [name, vm] of Object.entries(H.scenarios)) {
    const { m, host } = await mount("hud", vm, { width: H.widths[name], height: 26 });
    const before = ids(m);
    host.vm = H.nextTick(vm);
    m.render();
    assert.deepEqual([...ids(m)].sort(), [...before].sort(), name);
  }
});

// ---------------------------------------------------------------------------------------------
// key commands (mapledr.sheet / .herd / .calm reach whichever copy claims them)

test("every chrome role answers mapledr.sheet / herd / calm the same way", async () => {
  for (const kind of ["party", "nameplate", "hud"]) {
    const vm = { party: P.scenarios.six, nameplate: N.scenarios.focused, hud: H.scenarios.normal }[kind];
    const extra = { nameplate: { ...N.scenarios.focused, heroId: 1 }, party: P.scenarios.six };
    const { m, host } = await mount(kind, vm, {
      ...(kind === "nameplate" ? plateOpts("focused") : {}),
      extra,
      fixture: { focused: { space: "s1", tab: "tab1", pane: "p1", terminal: "t1", agent: "t1" }, ...(kind === "nameplate" ? { panes: [N.panes.focused] } : {}) },
    });
    const role = m.view.role;
    assert.equal(role.command("herd"), true);
    assert.equal(role.command("sheet"), true);
    assert.equal(role.command("calm"), true);
    assert.equal(role.command("nope"), false);
    assert.deepEqual(overlays().map((s) => s.props), [{ role: "herd" }, { role: "sheet", heroId: 1 }], kind);
    assert.deepEqual(host.commands.at(-1), ["setting", { key: "calm", value: true }], kind);
  }
});
