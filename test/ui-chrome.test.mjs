// Tests for the three chrome roles that live in herdr's own UI: party (sidebar), nameplate (pane
// header) and hud (strip). Every sample scenario (tools/vm-samples/*.mjs) renders through the
// strict mock at several widths, zoom 1 and 2, in a dark and a light theme, with zero validator
// errors; handlers fire the herdr commands / engine commands the contract names; the next tick's
// VM keeps every id.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const M = await import("../tools/mock/index.mjs");
const G = await import("../tools/mock/gates.mjs");
const { View, div } = await import("gpui-kit");
const { props } = await import("herdr");
const PartyMod = await import("../mods/down-the-stack/ui/party.js");
const PlateMod = await import("../mods/down-the-stack/ui/nameplate.js");
const HudMod = await import("../mods/down-the-stack/ui/hud.js");
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
// herdr's render budget is wall-clock time, and the mock flags any render over it ("budget"). Under
// load (parallel test files, a browser shooting previews) a slow render says nothing about the
// code: load only adds time, waiting for a CPU. So a view the mock flagged is rendered again, each
// render's cost taken as the lower of the mock's script time (stats.lastRenderMs, its stopwatch)
// and the process's CPU time for the whole render (no waiting; the mock's own checks and GC
// threads are in it), and the best of 5 must fit. Every other validator error counts as it is.
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

test("a render the mock timed over herdr's budget once (load) is judged by its best of 5; a slow one still fails", async () => {
  // busy until both this process's CPU time and the wall clock have run `ms`, under any load (the
  // CPU time alone can pass `ms` early: it counts V8's helper threads too, whose time lands in
  // steps; the panels tests saw that flake, test/view-panels.test.mjs)
  const spin = (ms) => {
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    for (let c = { user: 0, system: 0 }; (c.user + c.system) / 1000 < ms || performance.now() - t0 < ms; c = process.cpuUsage(c0)) { /* busy */ }
  };
  M.resetState();
  let n = 0;
  const once = await M.mountView(class extends View { render() { if (n++ === 0) spin(80); return div().child("x"); } }, { props: {} });
  once.render();
  assert.ok(once.errors.some(isRenderBudget), "the mock flagged the slow render");
  assert.deepEqual(errorsOf(once), [], "a one-off: the best of 5 fits");
  M.resetState();
  const always = await M.mountView(class extends View { render() { spin(80); return div().child("x"); } }, { props: {} });
  always.render();
  assert.match(errorsOf(always).join(), /^budget: the best of 5 renders took \d+\.\d ms/, "a render that is always slow still fails");
});

// ---------------------------------------------------------------------------------------------
// party behaviour (herdr's agents list + the game)

test("party: setAgentOrder(vm.agentOrder) on render, like herdr's agents list; none while loading", async () => {
  const { m } = await mount("party", P.scenarios.six);
  const last = M.calls().setAgentOrder.at(-1);
  assert.deepEqual(last.addresses, P.scenarios.six.agentOrder);
  assert.deepEqual(errorsOf(m), []);
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
  assert.deepEqual(errorsOf(m), []);
});

test("party: a row without a pane id focuses the pane showing its terminal, else peeks it (never 'no such pane')", async () => {
  const vm = P.nextTick(P.scenarios.one);
  const r = vm.groups[0].rows[0];
  r.pane = null;
  // a pane shows the terminal: pane.focus {terminal}
  let { m } = await mount("party", vm, { fixture: { panes: [{ ...N.panes.focused, pane: "p77", terminal: r.address }] } });
  m.fire(`pr-${r.key}`);
  assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ terminal: r.address }]);
  assert.equal(runs("terminal.peek").length, 0);
  // no pane shows it (an orphan sub-agent playing as a hero): herdr would answer pane.focus
  // {terminal} with "no such pane" (window.rs pane.focus), so it opens in herdr's peek, as the
  // agents list opens a paneless sub-agent
  ({ m } = await mount("party", vm, { fixture: { panes: [] } }));
  m.fire(`pr-${r.key}`);
  assert.equal(runs("pane.focus").length, 0);
  assert.deepEqual(runs("terminal.peek").map((c) => c.args), [{ terminal: r.address }]);
  // the sheet's Focus button goes through the same helper
  M.resetState();
  PartyMod.focusAgent(null, "t42");
  assert.deepEqual(M.calls().run.map((c) => [c.name, c.args]), [["terminal.peek", { terminal: "t42" }]]);
  M.resetState();
  PartyMod.focusAgent("p9", "t42");
  assert.deepEqual(M.calls().run.map((c) => [c.name, c.args]), [["pane.focus", { pane: "p9" }]]);
  M.resetState();
  PartyMod.focusAgent(null, null);
  assert.deepEqual(M.calls().run, []);
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
  for (const s of sheets) assert.deepEqual(s, { mod: "down-the-stack", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 3 } });
  assert.equal(runs("pane.focus").length, 0, "portrait / button clicks stop propagation");
});

test("party: the chest chip claims the chest without focusing", async () => {
  const { m, host } = await mount("party", P.scenarios.six);
  m.fire("pc-c:3:chest");
  assert.deepEqual(host.commands, [["claimChest", { heroId: 3 }]]);
  assert.equal(runs("pane.focus").length, 0);
});

test("party: space names that share a start are cut in the middle in the group headers ('ceo-assi…res-2') where they may not fit, the whole name on hover (round 4c)", async () => {
  const textOf = (n) => (n.type === "text" ? n.text : n.children.map(textOf).join(""));
  const names = ["ceo-assistant-res-2", "ceo-assistant-writer"];
  const groups = P.scenarios.six.groups.map((g, i) => (g.offDuty ? g : { ...g, name: names[i] ?? g.name }));
  for (const width of [200, 268]) {
    const { m } = await mount("party", { ...P.scenarios.six, groups }, { width });
    const tails = [];
    for (const g of groups.filter((x) => !x.offDuty)) {
      const n = m.node(`pg-${g.key}-name`);
      assert.equal(textOf(n), g.name, `${width}: the whole name`);
      const tip = n.methods.find((x) => x[0] === "tooltip")?.[1][0] ?? null;
      if (width === 268) {
        // 19 or 20 characters at 11 px fit a 268 px sidebar's header: one plain box, as before
        assert.equal(n.children[0].type, "text");
        assert.equal(tip, null);
        continue;
      }
      // a 200 px sidebar: a head that gives way and a tail that stays whole, the name on hover
      const [head, tail] = n.children;
      assert.ok(head.has("truncate") && head.has("min_w"), "the head gives way");
      assert.ok(tail.has("flex_none"), "the tail stays whole");
      tails.push(tail.children[0].text);
      assert.equal(tip, g.name);
    }
    if (width === 200) assert.deepEqual(tails, ["res-2", "writer"], "the two headers end apart");
    assert.deepEqual(m.errors, []);
  }
});

test("party: a folded off-duty group shows its pending chests (gold chest and count); none without", async () => {
  const textOf = (n) => (n.type === "text" ? n.text : n.children.map(textOf).join(""));
  const isIn = (n, root) => { for (let e = n; e; e = e.parent) if (e === root) return true; return false; };
  const groups = P.scenarios.six.groups.map((g) => (g.offDuty ? { ...g, chests: 3 } : g));
  const { m } = await mount("party", { ...P.scenarios.six, groups });
  assert.equal(m.node("pr-h:8"), null, "folded");
  const cue = m.node("pg-g:off-chests");
  assert.ok(cue, "the folded header carries the chests");
  assert.equal(cue.parent.id, "pg-g:off");
  assert.ok(m.findAll((n) => n.src === "mods/down-the-stack/art/ui/chest.svg" && isIn(n, cue)).length === 1, "a chest icon");
  assert.ok(textOf(cue).includes("×3"));
  assert.match(cue.methods.find((x) => x[0] === "tooltip")[1][0], /3 chests wait off duty: unfold to open them/);
  // unfolded: the rows show their own chests, the header none
  m.fire("pg-g:off");
  m.render();
  assert.equal(m.node("pg-g:off-chests"), null);
  // an old PartyVM without `chests` counts the rows with a chest pending
  const older = P.scenarios.six.groups.map((g) => { const { chests, ...rest } = g; return rest; });
  const { m: m2 } = await mount("party", { ...P.scenarios.six, groups: older });
  assert.ok(m2.node("pg-g:off-chests"), "Lumi's chest");
  // nothing pending: no cue
  const none = P.scenarios.six.groups.map((g) => (g.offDuty ? { ...g, chests: 0, rows: g.rows.map((r) => ({ ...r, chestPending: false })) } : g));
  const { m: m3 } = await mount("party", { ...P.scenarios.six, groups: none });
  assert.equal(m3.node("pg-g:off-chests"), null);
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

test("party: hover shows the pin toggle (terminal.pin); rows never move, so the hover stays", async () => {
  const { m } = await mount("party", P.scenarios.six);
  assert.equal(m.node("pn-h:1"), null);
  m.hover("pr-h:1");
  m.render();
  assert.ok(m.node("pn-h:1"));
  const tip = (id) => m.node(id).methods.find((x) => x[0] === "tooltip")?.[1][0];
  assert.equal(tip("pn-h:1"), "Unpin terminal");
  m.fire("pn-h:1");
  assert.deepEqual(runs("terminal.pin").map((c) => c.args), [{ terminal: "t1", pinned: false }]);
  assert.equal(runs("pane.focus").length, 0);
  m.render();
  assert.ok(m.node("pn-h:1"), "the row keeps its place and its hover");
  m.hover("pr-h:2");
  m.render();
  assert.match(tip("pn-h:2"), /^Pin terminal/);
});

test("party: the Forkling chip shows its sub-agent (peek, or its pane once kept) without focusing the row", async () => {
  // a paneless sub-agent: herdr's peek (agent.focus would show nothing: the layout has no agent block)
  const { m, host } = await mount("party", P.scenarios.six);
  m.fire("pc-c:1:fork");
  assert.deepEqual(runs("terminal.peek").map((c) => c.args), [{ terminal: "t1.2" }]);
  assert.equal(runs("agent.focus").length, 0);
  assert.equal(runs("pane.focus").length, 0);
  assert.deepEqual(host.commands, []);
  assert.deepEqual(errorsOf(m), []);
  // a kept sub-agent (terminal.keep gave it a pane): its pane, as the agents list does
  const kept = await mount("party", P.scenarios.six, { fixture: { panes: [{ ...N.panes.focused, pane: "p12", terminal: "t1.2" }] } });
  kept.m.fire("pc-c:1:fork");
  assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ terminal: "t1.2" }]);
  assert.equal(runs("terminal.peek").length, 0);
  assert.deepEqual(kept.host.commands, []);
});

/** Concatenated text under a node (its own subtree). */
function textUnder(n) {
  if (!n) return "";
  return [n.type === "text" ? n.text : "", ...n.children.map(textUnder)].filter(Boolean).join(" ");
}

test("party: blocked heroes stand out without re-sorting: 'N need you' jumps to the next one; '!' on its group and the rail", async () => {
  const { m, host } = await mount("party", P.scenarios.six);
  assert.ok(m.node("party-needyou"));
  assert.equal(textUnder(m.node("party-needyou")), "1 needs you");
  assert.match(m.node("party-needyou").methods.find((x) => x[0] === "tooltip")[1][0], /^Waiting for you: Rue Two-Spaces\nClick to jump to Rue Two-Spaces$/);
  m.fire("party-needyou");
  assert.deepEqual(host.commands, [["markSeen", { heroId: 2 }]]);
  assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ pane: "p2" }]);
  // the group with a blocked row carries herdr's "!" badge, unfolded too; a working group has none
  assert.ok(textUnder(m.node("pg-g:s1")).includes("!"));
  assert.ok(!textUnder(m.node("pg-g:s2")).includes("!"));
  m.fire("pg-g:s1");
  m.render();
  assert.ok(textUnder(m.node("pg-g:s1")).includes("!"), "folded too");
  // five blocked, the focused one (Rue, 11) among them: a click walks on to the next one
  const b = await mount("party", P.scenarios.blocked);
  assert.equal(textUnder(b.m.node("party-needyou")), "5 need you");
  b.m.fire("party-needyou");
  assert.deepEqual(runs("pane.focus").at(-1).args, { pane: "p12" });
  // a narrow sidebar says "! 5"
  const narrow = await mount("party", P.scenarios.blocked, { width: 200 });
  assert.equal(textUnder(narrow.m.node("party-needyou")), "! 5");
  assertClean(narrow.m, "narrow blocked");
  // nobody blocked: no chip
  const one = await mount("party", P.scenarios.one);
  assert.equal(one.m.node("party-needyou"), null);
  // the rail: a "!" badge on the blocked hero's portrait (herdr's rail marks it so too)
  const rail = await mount("party", P.scenarios.rail, { width: 52 });
  assert.ok(textUnder(rail.m.node("pp-h:2")).includes("!"), textUnder(rail.m.node("pp-h:2")));
  assert.ok(!textUnder(rail.m.node("pp-h:1")).includes("!"));
  assertClean(rail.m, "rail");
});

test("party: a waiting sub-agent counts in 'N need you', puts '!' on its group and the rail portrait, and a click peeks it", async () => {
  const vm = P.scenarios.forkWaits;
  const { m, host, view } = await mount("party", vm);
  assertClean(m, "forkWaits");
  // Rue (blocked) and Pax's pane-less sub-agent (Pax itself is working)
  assert.equal(textUnder(m.node("party-needyou")), "2 need you");
  const tip = () => m.node("party-needyou").methods.find((x) => x[0] === "tooltip")[1][0];
  assert.equal(tip(), "Waiting for you: Rue Two-Spaces, Pax the Rebased's sub-agent\nClick to jump to Rue Two-Spaces");
  // api-gateway has no blocked row: its "!" is the sub-agent's
  assert.ok(textUnder(m.node("pg-g:s2")).includes("!"));
  // the walk: Rue (her pane, marked seen), then the sub-agent (herdr's peek: it has no pane)
  m.fire("party-needyou");
  assert.deepEqual(host.commands, [["markSeen", { heroId: 2 }]]);
  assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ pane: "p2" }]);
  const rueFocused = structuredClone(vm);
  for (const r of rueFocused.groups.flatMap((g) => g.rows)) r.focused = r.heroId === 2;
  host.vm = rueFocused;
  m.render();
  assert.match(tip(), /Click to jump to Pax the Rebased's sub-agent$/);
  m.fire("party-needyou");
  assert.deepEqual(runs("terminal.peek").map((c) => c.args), [{ terminal: "t5.1" }]);
  assert.equal(runs("pane.focus").length, 1, "a peek, never 'no such pane'");
  assert.equal(host.commands.length, 1);
  // the peek leaves the focus on Rue: the next click goes on (back to Rue), never stuck on the sub-agent
  m.render();
  assert.match(tip(), /Click to jump to Rue Two-Spaces$/);
  m.fire("party-needyou");
  assert.deepEqual(runs("pane.focus").at(-1).args, { pane: "p2" });
  // the amber fork chip peeks the waiting one too
  m.fire("pc-c:5:fork");
  assert.deepEqual(runs("terminal.peek").at(-1).args, { terminal: "t5.1" });
  assert.ok(view);
  // the rail: the "!" badge on Pax's portrait; its click peeks the sub-agent, the row's click focuses Pax
  const rail = await mount("party", P.scenarios.forkRail, { width: 52 });
  assertClean(rail.m, "forkRail");
  assert.ok(textUnder(rail.m.node("pp-h:5")).includes("!"));
  assert.match(rail.m.node("pb-h:5").methods.find((x) => x[0] === "tooltip")[1][0], /^A sub-agent of Pax the Rebased waits for you on “Ask about the schema” · click to show it$/);
  rail.m.fire("pb-h:5");
  assert.deepEqual(runs("terminal.peek").map((c) => c.args), [{ terminal: "t5.1" }]);
  assert.deepEqual(rail.host.commands, [], "the badge does not also click the row");
  rail.m.fire("pr-h:5");
  assert.deepEqual(runs("pane.focus").at(-1).args, { pane: "p5" });
  // a kept sub-agent (it has a pane): the badge shows its pane, as the agents list does
  const kept = await mount("party", P.scenarios.forkRail, { width: 52, fixture: { panes: [{ ...N.panes.focused, pane: "p51", terminal: "t5.1" }] } });
  kept.m.fire("pb-h:5");
  assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ terminal: "t5.1" }]);
  // older VMs (no waitingForks): only blocked rows count, as before
  const old = structuredClone(vm);
  for (const r of old.groups.flatMap((g) => g.rows)) delete r.waitingForks;
  const o = await mount("party", old);
  assert.equal(textUnder(o.m.node("party-needyou")), "1 needs you");
  assert.ok(!textUnder(o.m.node("pg-g:s2")).includes("!"));
});

test("party: 'N need you' walks on past a blocked agent without a pane (herdr's peek leaves the focus where it was)", async () => {
  // Rue's agent has no pane: a click peeks it (showTerminal), so the focus stays on Kip, and the
  // next click must go on to Pax's sub-agent instead of showing Rue again
  const vm = structuredClone(P.scenarios.forkWaits);
  const rue = vm.groups.flatMap((g) => g.rows).find((r) => r.heroId === 2);
  rue.pane = null;
  const { m, host } = await mount("party", vm, { fixture: { panes: [] } });
  const tip = () => m.node("party-needyou").methods.find((x) => x[0] === "tooltip")[1][0];
  assert.match(tip(), /Click to jump to Rue Two-Spaces$/);
  m.fire("party-needyou");
  assert.deepEqual(host.commands, [["markSeen", { heroId: 2 }]]);
  assert.deepEqual(runs("terminal.peek").map((c) => c.args), [{ terminal: String(rue.address) }]);
  m.render();
  assert.match(tip(), /Click to jump to Pax the Rebased's sub-agent$/);
  m.fire("party-needyou");
  assert.deepEqual(runs("terminal.peek").map((c) => c.args), [{ terminal: String(rue.address) }, { terminal: "t5.1" }]);
  m.render();
  assert.match(tip(), /Click to jump to Rue Two-Spaces$/);
});

test("party: a hero pinned to its map shows a map-pin glyph beside the level, always in view (narrow, hovered, slim), its reason as tooltip", async () => {
  const six = P.scenarios.six;
  const ori = six.groups.flatMap((g) => g.rows).find((r) => r.mapPin);
  assert.ok(ori, "the six sample has a map-pinned row");
  for (const width of [160, 200, 268, 420]) {
    const { m } = await mount("party", six, { width });
    assertClean(m, `six @${width}`);
    const pin = m.node(`pm-${ori.key}`);
    assert.ok(pin, `@${width}: the glyph`);
    assert.equal(pin.methods.find((x) => x[0] === "tooltip")[1][0], ori.mapPin.tooltip);
    // on line 1 with the name and the level (line 2's career · map truncates first)
    const line1 = pin.parent;
    assert.ok(textUnder(line1).includes(String(ori.name)) && textUnder(line1).includes(`Lv ${ori.level}`), textUnder(line1));
    assert.ok(!m.text().includes("(pinned)"));
    m.hover(`pr-${ori.key}`);
    m.render();
    assert.ok(m.node(`pm-${ori.key}`) && m.node(`pn-${ori.key}`), `@${width} hovered: the glyph and the row buttons`);
  }
  // rows without a pin draw none
  const { m } = await mount("party", six);
  assert.equal(m.findAll((n) => typeof n.id === "string" && n.id.startsWith("pm-")).length, 1);
  // slim rows: the glyph stays and slimFit leaves it room (the level drops first, then a chip)
  const crowded = P.scenarios.crowded;
  const pinned = crowded.groups.flatMap((g) => g.rows).filter((r) => r.mapPin);
  assert.ok(pinned.length >= 2);
  for (const width of [160, 268]) {
    const c = await mount("party", crowded, { width });
    assertClean(c.m, `crowded @${width}`);
    for (const r of pinned) assert.ok(c.m.node(`pm-${r.key}`), `${r.key} @${width}`);
  }
  const r = { key: "h:9", heroId: 9, address: "t9", level: 57, machine: null, chips: [{ key: "c:9:boss", kind: "boss", text: "BOSS 23%", color: "#FF5A5F" }] };
  assert.deepEqual(PartyMod.slimFit(r, 210, false), { chips: 1, level: true });
  assert.deepEqual(PartyMod.slimFit({ ...r, mapPin: { tooltip: "x" } }, 210, false), { chips: 1, level: false }, "the pin's 14 px come off the level first");
});

test("blocked cues read on light chrome, win98's too (light chrome under a black background): one family with the stripe", async () => {
  // herdr's win98 theme as settings.rs resolve() gives it: its palette (background #ffffff, as
  // paper's) derives the chrome, then its colors overrides: background and foreground black
  const WIN98 = M.resolveTheme("paper", {
    background: "#000000", foreground: "#000000", surface: "#c0c0c0", popover: "#c0c0c0", raised: "#dfdfdf", hover: "#dfdfdf",
    border: "#808080", input: "#ffffff", muted: "#404040", dim: "#808080", accent: "#000080", accent_foreground: "#ffffff",
  });
  const lastBg = (n) => n.methods.filter((x) => x[0] === "bg").at(-1)?.[1][0];
  const lastFg = (n) => n.methods.filter((x) => x[0] === "text_color").at(-1)?.[1][0];
  for (const [label, theme] of [["paper", "paper"], ["win98", WIN98], ["graphite", "graphite"]]) {
    const th = typeof theme === "string" ? M.resolveTheme(theme) : theme;
    const chrome = th.chrome;
    const light = label !== "graphite";
    const { m } = await mount("party", P.scenarios.six, { theme });
    const stripe = PartyMod.stripeColor("#F2A93B", "blocked", { bg: th.background, chrome, hover: th.hover, selected: th.selected });
    // "N need you" and the row's "!" chip: text on their amber tint over the chrome
    const need = m.node("party-needyou");
    const bang = m.findAll((n) => typeof n.id === "string" && n.id.startsWith("pc-") && textUnder(n).startsWith("!"))[0];
    assert.ok(need && bang, label);
    for (const [what, n] of [["need you", need], ["! chip", bang]]) {
      const fg = lastFg(n);
      const under = COL.over(lastBg(n), chrome);
      assert.ok(COL.ratio(fg, under) >= 4.5, `${label} ${what}: ${fg} on ${under}: ${COL.ratio(fg, under).toFixed(2)}:1`);
      if (light) assert.equal(fg.toLowerCase(), stripe.toLowerCase(), `${label} ${what}: the stripe's family (${fg} vs ${stripe})`);
      else assert.equal(fg.toUpperCase(), "#F2A93B", `${label} ${what}: the design amber on dark chrome`);
    }
    // the rail's "!" badge clears 3:1 against the chrome, its "!" 4.5:1 on the badge
    const rail = await mount("party", P.scenarios.rail, { width: 52, theme });
    const badge = rail.m.node("pb-h:2");
    assert.ok(badge, `${label}: the rail badge`);
    assert.ok(COL.ratio(lastBg(badge), chrome) >= 3, `${label} rail badge ${lastBg(badge)} on ${chrome}: ${COL.ratio(lastBg(badge), chrome).toFixed(2)}:1`);
    assert.ok(COL.ratio(lastFg(badge), lastBg(badge)) >= 4.5, `${label} rail "!" ${lastFg(badge)} on ${lastBg(badge)}`);
  }
  // win98 is light by its chrome, as herdr classes it by its palette (themes(): light)
  assert.equal(PartyMod.isLight(PartyMod.onChrome({ bg: WIN98.background, chrome: WIN98.chrome })), true);
  assert.equal(PartyMod.isLight({ bg: WIN98.background }), false, "its background alone says dark");
});

test("chrome buttons hover with a background: no hover text colour where an svg icon keeps its built colour in herdr", async () => {
  // herdr's materialize sets an svg's colour from the static text colour when it builds the
  // element (svg elements get no hover styles), so a hover text_color never reaches the icon
  const svgUnder = (n) => n.type === "svg" || n.children.some(svgUnder);
  const offenders = (m) => m.findAll((n) => (n.state.hover ?? []).some((x) => x[0] === "text_color") && svgUnder(n)).map((n) => n.id ?? n.type);
  for (const theme of THEMES) {
    const party = await mount("party", P.scenarios.six, { theme });
    party.m.hover("pr-h:1");
    party.m.render();
    assert.ok(party.m.node("ps-h:1"));
    assert.deepEqual(offenders(party.m), [], `party ${theme}`);
    const slim = await mount("party", P.scenarios.crowded, { theme });
    slim.m.hover("pr-h:31");
    slim.m.render();
    assert.deepEqual(offenders(slim.m), [], `slim ${theme}`);
    const rail = await mount("party", P.scenarios.rail, { width: 52, theme });
    assert.deepEqual(offenders(rail.m), [], `rail ${theme}`);
    for (const vm of [N.scenarios.focused, null]) {
      const plate = await mount("nameplate", vm, { ...plateOpts("focused"), theme });
      plate.m.hover("pane-head-p1");
      plate.m.render();
      assert.ok(plate.m.node("ph-x-p1"));
      assert.deepEqual(offenders(plate.m), [], `nameplate ${theme}`);
    }
    const hud = await mount("hud", H.scenarios.normal, { width: 1170, height: 26, theme });
    assert.deepEqual(offenders(hud.m), [], `hud ${theme}`);
    // the icon + label buttons lift their background instead, so icon and label stay together
    for (const [m, id] of [[party.m, "party-herd"], [hud.m, "hud-herd"]]) {
      const hover = m.node(id).state.hover;
      assert.deepEqual(hover.map((x) => x[0]), ["bg"], id);
      const raised = M.resolveTheme(theme).raised;
      assert.notEqual(hover[0][1][0], raised, `${id}: the hover differs from the raised colour`);
    }
  }
  // lift(): lighter than raised on dark themes, darker on light ones (t.hover would darken a raised button)
  const lum = (h) => [1, 3, 5].reduce((a, i) => a + parseInt(h.slice(i, i + 2), 16), 0);
  const dark = { bg: "#17191d", raised: "#2c2e31", fg: "#eeeeef", hover: "#ffffff17" };
  const light = { bg: "#ffffff", raised: "#f6f6f6", fg: "#1b1b1e", hover: "#00000012" };
  assert.ok(lum(PartyMod.lift(dark)) > lum(dark.raised));
  assert.ok(lum(PartyMod.lift(light)) < lum(light.raised));
});

// Colour science for the status-mark tests, computed here independently of ui/party.js: WCAG
// contrast, OKLab (Ottosson) and the Machado-Oliveira-Fernandes (2009) severity-1 CVD simulation.
const COL = (() => {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const linRgb = (h) => rgb(h).map(lin);
  const lum = (h) => { const [r, g, b] = linRgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  /** "#rrggbb[aa]" over an opaque "#rrggbb". */
  const over = (fg, bg) => {
    const a = fg.length === 9 ? parseInt(fg.slice(7, 9), 16) / 255 : 1;
    const f = rgb(fg.slice(0, 7)), b = rgb(bg);
    return "#" + f.map((v, i) => Math.round((v * a + b[i] * (1 - a)) * 255).toString(16).padStart(2, "0")).join("");
  };
  const lab = ([r, g, b]) => {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const MACHADO = {
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  };
  const sim = (h, kind) => { const c = linRgb(h); return MACHADO[kind].map((row) => Math.max(0, Math.min(1, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))); };
  /** OKLab distance ×100; kind: undefined (normal vision), "protan" or "deutan". */
  const dE = (a, b, kind) => { const p = lab(kind ? sim(a, kind) : linRgb(a)), q = lab(kind ? sim(b, kind) : linRgb(b)); return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  /** [L, C, h°] in OKLCH. */
  const lch = (h) => { const [L, a, b] = lab(linRgb(h)); return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360]; };
  return { ratio, over, dE, lch };
})();
const DESIGN = { working: "#4CC38A", blocked: "#F2A93B", done: "#FFD447", idle: "#8A8F98" }; // D§11.1
const STATUS = Object.keys(DESIGN);

/** The stripes for a herdr theme token map, and the three backgrounds a party row shows. */
function marksOn(th) {
  const t = { bg: th.background, chrome: th.chrome, hover: th.hover, selected: th.selected, fg: th.foreground };
  const bgs = { chrome: th.chrome, hover: COL.over(th.hover, th.chrome), selected: COL.over(th.selected, th.chrome) };
  return { t, bgs, s: Object.fromEntries(STATUS.map((k) => [k, PartyMod.stripeColor(DESIGN[k], k, t)])) };
}

test("status marks (D§11.1): every status clears 3:1 on every row background and stays distinct, light and dark", async () => {
  for (const name of ["paper", "graphite", "ink", "moss"]) {
    const th = M.resolveTheme(name);
    const light = name === "paper";
    const { bgs, s } = marksOn(th);
    for (const k of STATUS) {
      assert.match(s[k], /^#[0-9a-fA-F]{6}$/, `${name} ${k}`);
      for (const [where, bg] of Object.entries(bgs)) {
        const r = COL.ratio(s[k], bg);
        assert.ok(r >= 3, `${name} ${k} ${s[k]} on the ${where} row ${bg}: ${r.toFixed(2)}:1`);
      }
    }
    // distinct: OKLab ×100 ≥ 15 with normal vision for every pair, ≥ 6 under protan / deutan (the
    // floor a mark may use when the status is also said another way: the face, "!", "N need you")
    for (let i = 0; i < STATUS.length; i++) {
      for (let j = i + 1; j < STATUS.length; j++) {
        const [a, b] = [STATUS[i], STATUS[j]];
        const n = COL.dE(s[a], s[b]);
        const cvd = Math.min(COL.dE(s[a], s[b], "protan"), COL.dE(s[a], s[b], "deutan"));
        assert.ok(n >= 15, `${name} ${a} ${s[a]} vs ${b} ${s[b]}: ΔE ${n.toFixed(1)}`);
        assert.ok(cvd >= 6, `${name} ${a} vs ${b} under CVD: ΔE ${cvd.toFixed(1)}`);
      }
    }
    if (light) {
      // not muddy: the coloured steps keep their chroma; blocked stays orange (never toward the
      // HP red, D§11.1), done stays gold, and blocked is the darker of the two
      for (const k of ["working", "blocked", "done"]) assert.ok(COL.lch(s[k])[1] >= 0.1, `${k} ${s[k]} chroma ${COL.lch(s[k])[1].toFixed(3)}`);
      const hb = COL.lch(s.blocked)[2], hd = COL.lch(s.done)[2];
      assert.ok(hb >= 40 && hb <= 75, `blocked hue ${hb.toFixed(0)}`);
      assert.ok(hd >= 75 && hd <= 100, `done hue ${hd.toFixed(0)}`);
      assert.ok(COL.lch(s.blocked)[0] < COL.lch(s.done)[0]);
      // the steps they replace (the design colours mixed with black) failed both rules
      assert.ok(COL.ratio("#9e832c", bgs.selected) < 3 && COL.dE("#855d20", "#9e832c") < 15, "the old light done / blocked");
    } else {
      for (const k of ["working", "done", "idle"]) assert.equal(s[k], DESIGN[k], `${name}: the design's ${k}`);
      assert.ok(COL.dE(DESIGN.blocked, DESIGN.done) < 15, "the design's amber is too close to its gold for a 3 px mark");
    }
  }
});

test("status marks follow the row's chrome, not the theme background, and clear 3:1 on any theme's tints", () => {
  const check = (t, label) => {
    const bgs = [t.chrome, COL.over(t.hover, t.chrome), COL.over(t.selected, t.chrome)];
    for (const k of STATUS) {
      const c = PartyMod.stripeColor(DESIGN[k], k, t);
      for (const bg of bgs) assert.ok(COL.ratio(c, bg) >= 3, `${label} ${k} ${c} on ${bg}: ${COL.ratio(c, bg).toFixed(2)}`);
    }
  };
  // herdr's win98 theme overrides the background to black but not the chrome, which stays light
  const win98 = M.resolveTheme("paper", { background: "#000000", foreground: "#000000", hover: "#dfdfdf" });
  const w = { bg: win98.background, chrome: win98.chrome, hover: win98.hover, selected: win98.selected };
  check(w, "win98");
  assert.equal(PartyMod.stripeColor(DESIGN.done, "done", w), marksOn(M.resolveTheme("paper")).s.done, "the light steps");
  // a person's theme whose tints would leave a step under 3:1: the mark deepens (light) or
  // lightens (dark) just enough
  check({ bg: "#c4c4c4", chrome: "#b8b8b8", hover: "#0000000c", selected: "#00000012" }, "grey light");
  check({ bg: "#3a3a3a", chrome: "#404040", hover: "#ffffff0e", selected: "#ffffff17" }, "grey dark");
  const idle = PartyMod.stripeColor(DESIGN.idle, "idle", { bg: "#3a3a3a", chrome: "#404040", hover: "#ffffff0e", selected: "#ffffff17" });
  assert.notEqual(idle, DESIGN.idle, "lightened on a mid-grey dark chrome");
  // a theme colour given as "#rgb" (herdr hands theme colours on verbatim; kit.hex keeps "#rgb"):
  // a light "#eee" chrome is light, and gets the light steps
  const short = { bg: "#fff", chrome: "#eee", hover: "#0000000c", selected: "#00000012", fg: "#111" };
  check({ ...short, chrome: "#eeeeee" }, "#rgb chrome");
  assert.equal(PartyMod.stripeColor(DESIGN.done, "done", short), PartyMod.stripeColor(DESIGN.done, "done", { ...short, chrome: "#eeeeee" }));
  assert.ok(PartyMod.isLight(short), "a \"#fff\" background is light");
  // the marks are cached by every input: the same chrome with a heavier selected tint gets its own,
  // deeper step
  const plain = { bg: "#b8b8b8", chrome: "#b8b8b8", hover: "#00000000", selected: "#00000000" };
  const heavy = { ...plain, selected: "#00000040" };
  check(plain, "plain grey");
  check(heavy, "grey, heavy selected tint");
  assert.notEqual(PartyMod.stripeColor(DESIGN.done, "done", plain), PartyMod.stripeColor(DESIGN.done, "done", heavy));
  // unknown statuses (never from game/view: statusWord maps them to idle) still clear 3:1
  check({ ...w }, "win98 again");
  assert.match(PartyMod.stripeColor("#F2A93B", "constructor", w), /^#[0-9a-f]{6}$/);
});

test("status marks: the party's stripes, a folded group's dot and the HUD's count dots use them", async () => {
  for (const name of ["paper", "graphite"]) {
    const { s } = marksOn(M.resolveTheme(name));
    const { m } = await mount("party", P.scenarios.six, { theme: name });
    const stripes = m.findAll((n) => n.methods.some((x) => x[0] === "w" && x[1][0] === 3) && n.methods.some((x) => x[0] === "bg"))
      .map((n) => n.methods.findLast((x) => x[0] === "bg")[1][0]);
    assert.deepEqual(new Set(stripes), new Set(STATUS.map((k) => s[k])), `${name}: one stripe colour per status`);
    const hud = await mount("hud", H.scenarios.normal, { width: 1170, height: 26, theme: name });
    for (const [id, k] of [["hud-working", "working"], ["hud-blocked", "blocked"], ["hud-shipped", "done"]]) {
      const dot = hud.m.node(id).children.find((n) => n.methods.some((x) => x[0] === "rounded_full"));
      assert.equal(dot.methods.findLast((x) => x[0] === "bg")[1][0], s[k], `${name} ${id}`);
    }
  }
});

test("party / nameplate contrast: secondary text uses the muted token", async () => {
  for (const name of ["paper", "graphite"]) {
    const th = M.resolveTheme(name);
    const { m } = await mount("party", P.scenarios.six, { theme: name });
    const colorOf = (text) => m.findAll((n) => n.type === "text" && n.text === text)[0]?.parent.methods.findLast((x) => x[0] === "text_color")?.[1][0];
    assert.equal(colorOf("Junior Refactorer · 2-2 Nested Tunnels"), th.muted, `${name}: row line 2`);
    assert.equal(colorOf("7/10"), th.muted, `${name}: Sprint numbers`);
    const plate = await mount("nameplate", N.scenarios.focused, { ...plateOpts("focused"), theme: name });
    const label = plate.m.findAll((n) => n.type === "text" && n.text === "HP")[0];
    assert.equal(label.parent.methods.findLast((x) => x[0] === "text_color")[1][0], th.muted, `${name}: HP label`);
  }
});

test("party: slim rows (RowVM.slim) keep 30 heroes far under the element budget and behave like rows", async () => {
  const vm = P.scenarios.crowded;
  const { m, host } = await mount("party", vm);
  assertClean(m, "crowded");
  assert.ok(m.stats.elements < 360, `${m.stats.elements} elements`);
  const row = m.node("pr-h:31");
  assert.ok(row.methods.some((x) => x[0] === "h" && x[1][0] === 28), "28 px");
  assert.ok(m.text().includes("vps"), "a remote agent names its machine");
  m.fire("pr-h:33");
  assert.deepEqual(host.commands.at(-1), ["markSeen", { heroId: 33 }]);
  assert.deepEqual(runs("pane.focus").at(-1).args, { pane: "p33" });
  m.fire("pp-h:33");
  assert.deepEqual(overlays().at(-1).props, { role: "sheet", heroId: 33 });
  m.hover("pr-h:31");
  m.render();
  assert.ok(m.node("pn-h:31") && m.node("ps-h:31"));
  // unfolding off duty stays in budget
  m.fire("pg-g:off");
  m.render();
  assertClean(m, "crowded + off duty");
});

test("party: a narrow sidebar drops chips (then the level) instead of pushing a row past its edge", async () => {
  // Measured in Chromium at 160 px before this: a slim row with "BOSS 23%" ran 9 px past the
  // sidebar (13 px hovered, clipping the pin button) and its name collapsed to nothing; a full row
  // with "! 2m" and "BOSS 78%" ran 14 px past it.
  const chip = (kind, text) => ({ key: `c:9:${kind}`, kind, text, color: "#FF5A5F" });
  const boss = { key: "h:9", heroId: 9, address: "t9", level: 57, machine: null, chips: [chip("boss", "BOSS 23%")] };
  assert.deepEqual(PartyMod.slimFit(boss, 268, false), { chips: 1, level: true }, "the default width keeps everything");
  assert.deepEqual(PartyMod.slimFit(boss, 230, false), { chips: 1, level: true });
  assert.deepEqual(PartyMod.slimFit(boss, 180, false), { chips: 1, level: false }, "the level goes first");
  assert.deepEqual(PartyMod.slimFit(boss, 160, false), { chips: 0, level: true }, "then the chip; the level comes back");
  assert.deepEqual(PartyMod.slimFit(boss, 160, true), { chips: 0, level: false }, "hovered: the sheet and pin buttons stay whole");
  const waiting = { ...boss, level: 100, chips: [chip("blocked", "! 2m"), chip("boss", "BOSS 23%")] };
  assert.deepEqual(PartyMod.slimFit(waiting, 160, false), { chips: 1, level: false }, "the urgent chip outlasts the level");
  assert.equal(PartyMod.chipsThatFit(waiting.chips, 77, 4), 1, "a full row's text column at 160 px");
  assert.equal(PartyMod.chipsThatFit(waiting.chips, 185, 4), 2, "and at 268 px");
  // every sample row keeps all its chips and its level at the default width and at 230 px
  for (const width of [268, 230]) {
    for (const [name, vm] of Object.entries(P.scenarios)) {
      for (const g of vm?.groups ?? []) {
        for (const r of g.rows) {
          const where = `${name} ${r.key} @${width}`;
          if (r.slim) assert.deepEqual(PartyMod.slimFit(r, width, false), { chips: Math.min(2, r.chips.length), level: true }, where);
          else assert.equal(PartyMod.chipsThatFit(r.chips, Math.max(64, width - 83), 4), r.chips.length, where);
        }
      }
    }
  }
  // rendered: at 160 px the slim row drops the chip and keeps its level; a full row keeps "!" only
  const vm = structuredClone(P.scenarios.crowded);
  const slim = vm.groups.flatMap((g) => g.rows).find((r) => r.chips.some((c) => c.kind === "boss"));
  assert.ok(slim, "the crowded sample has a slim row with a BOSS chip");
  const narrow = await mount("party", vm, { width: 160 });
  assertClean(narrow.m, "crowded @160");
  assert.equal(narrow.m.node(`pc-c:${slim.heroId}:boss`), null);
  assert.ok(narrow.m.text().includes(`Lv ${slim.level}`));
  const wide = await mount("party", vm, { width: 268 });
  assert.ok(wide.m.node(`pc-c:${slim.heroId}:boss`));
  const six = structuredClone(P.scenarios.six);
  const rue = six.groups.flatMap((g) => g.rows).find((r) => r.chips.some((c) => c.kind === "blocked"));
  rue.chips.push({ key: `c:${rue.heroId}:boss`, kind: "boss", text: "BOSS 78%", color: "#FF5A5F" });
  const full = await mount("party", six, { width: 160 });
  assertClean(full.m, "six @160");
  assert.ok(full.m.node(`pc-c:${rue.heroId}:blocked`) && !full.m.node(`pc-c:${rue.heroId}:boss`));
  assert.ok((await mount("party", six, { width: 268 })).m.node(`pc-c:${rue.heroId}:boss`));
});

test("save trouble (D§13.1): the party footer, the rail and the HUD show a cue that opens the Herd panel", async () => {
  const herd = { mod: "down-the-stack", kind: "dialog", width: 760, height: 520, props: { role: "herd" } };
  const party = await mount("party", P.scenarios.saveTrouble);
  const cue = party.m.node("party-save");
  assert.ok(cue);
  assert.ok(party.m.text().includes("Not saving"));
  assert.match(cue.methods.find((x) => x[0] === "tooltip")[1][0], /nothing is being saved/);
  party.m.fire("party-save");
  assert.deepEqual(overlays(), [herd]);
  const cueText = [];
  M.walkLive(cue, (n) => { if (n.type === "text") cueText.push(n.text); });
  assert.deepEqual(cueText, ["Not saving", "Herd panel ›"]);
  assert.ok(!cueText.join("").includes("!"), "never a \"!\" (D§11.1 reserves it for an agent waiting)");
  assert.equal((await mount("party", P.scenarios.six)).m.node("party-save"), null, "nothing while the save is fine");
  const rail = await mount("party", P.scenarios.saveRail, { width: 52 });
  assert.ok(rail.m.node("party-save"));
  rail.m.fire("party-save");
  assert.deepEqual(overlays(), [herd]);
  const hud = await mount("hud", H.scenarios.saveTrouble, { width: 1170, height: 26 });
  assert.ok(hud.m.node("hud-save"));
  assert.ok(hud.m.text().includes("Save restored from backup"));
  hud.m.fire("hud-save");
  assert.deepEqual(overlays(), [herd], "one panel: the click stops at the pill");
  const narrow = await mount("hud", H.scenarios.saveTrouble, { width: 640, height: 26 });
  assert.ok(narrow.m.text().includes("Restored") && !narrow.m.text().includes("from backup"), "the short form when narrow");
  for (const m of [party.m, rail.m, hud.m, narrow.m]) assert.deepEqual(errorsOf(m), []);
});

test("party: footer Herd and settings buttons open the Herd panel (760×520); calm toggles the setting", async () => {
  const { m, host } = await mount("party", P.scenarios.six);
  m.fire("party-herd");
  m.fire("party-settings");
  assert.deepEqual(overlays(), [
    { mod: "down-the-stack", kind: "dialog", width: 760, height: 520, props: { role: "herd" } },
    { mod: "down-the-stack", kind: "dialog", width: 760, height: 520, props: { role: "herd", tab: "settings" } },
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
    assert.deepEqual(errorsOf(m), []);
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
  assert.deepEqual(errorsOf(r.m), []);
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
  assert.ok(svgs.includes("mods/down-the-stack/art/ui/unzoom.svg"));
  assert.ok(!svgs.includes("mods/down-the-stack/art/ui/zoom.svg"));
});

test("nameplate: the hero part focuses its pane (once) and opens the character sheet", async () => {
  const { m } = await mount("nameplate", N.scenarios.blocked, plateOpts("blocked"));
  m.fire("np-hero-p2");
  assert.deepEqual(overlays(), [{ mod: "down-the-stack", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 2 } }]);
  assert.deepEqual(runs("pane.focus").map((c) => c.args), [{ pane: "p2" }]);
  const focusedPane = await mount("nameplate", N.scenarios.focused, plateOpts("focused"));
  focusedPane.m.fire("np-hero-p1");
  assert.equal(runs("pane.focus").length, 0, "an already focused pane is not focused again");
  assert.deepEqual(overlays().map((s) => s.props), [{ role: "sheet", heroId: 1 }]);
});

test("nameplate: shows the hero and herdr's own terminal title; narrow panes keep the title, the face and the chip", async () => {
  const wide = await mount("nameplate", N.scenarios.focused, plateOpts("focused"));
  const text = wide.m.text();
  for (const s of ["Kip the Idempotent", "Lv 14", "Junior Refactorer", "✳ Fix flaky auth test", "fighting 2-2"]) assert.ok(text.includes(s), s);
  // 220 px: which task this pane is still shows (herdr's own header shows it at any width)
  const narrow = await mount("nameplate", N.scenarios.narrow, plateOpts("narrow"));
  const t2 = narrow.m.text();
  assert.ok(t2.includes("✳ Fix flaky auth test") && t2.includes("fighting 2-2"), t2);
  assert.ok(!t2.includes("Kip the Idempotent"), "the hero's name goes first");
  assert.ok(!t2.includes("Lv 14"), "and the level before the title");
  assert.ok(narrow.m.findAll((n) => n.type === "image" && n.src === "icons/claude.svg").length === 1, "the program icon stays");
  // 320 px: room for the level too
  const mid = await mount("nameplate", N.scenarios.narrow, plateOpts("narrow", { width: 320 }));
  assert.ok(mid.m.text().includes("Lv 14") && mid.m.text().includes("Fix flaky"), mid.m.text());
  // 180 px: the face and the chip's short form
  const micro = await mount("nameplate", N.scenarios.micro, plateOpts("micro"));
  const t3 = micro.m.text();
  assert.ok(t3.includes("! 2m") && !t3.includes("waiting"), t3);
  assert.ok(t3.includes("o_o"));
  assert.ok(!t3.includes("Rue") && !t3.includes("Lv 11"));
  const contractor = await mount("nameplate", N.scenarios.contractor, plateOpts("contractor"));
  assert.ok(contractor.m.text().includes("(contractor)"));
});

test("nameplate: plan() drops the full bars and the career so the terminal title keeps its room", () => {
  const vm = N.scenarios.long;
  const wide = PlateMod.plan(vm, 1400, false, "short title");
  assert.ok(wide.career && wide.bars && !wide.compact && !wide.tiny);
  // 760 px and a long title: the whole title does not fit beside the full bars, so the compact
  // ones show (a split, owner decision round 4) and the title truncates (its tooltip has it all)
  const mid = PlateMod.plan(vm, 760, false, N.panes.long.title);
  assert.ok(mid.bars && mid.compact, JSON.stringify(mid));
  // a short title fits beside the full ones
  const short = PlateMod.plan(vm, 760, false, "Fix flaky auth test");
  assert.ok(short.bars && !short.compact);
  const small = PlateMod.plan(vm, 400, false, N.panes.long.title);
  assert.ok(!small.bars && !small.tiny, JSON.stringify(small));
  const tiny = PlateMod.plan(vm, 220, true, N.panes.long.title);
  assert.ok(tiny.tiny && !tiny.chip, "hovered tiny header gives the chip's room to the buttons");
});

test("nameplate: the full bars never cost the title its room, the compact ones keep its floor; equal panes match whatever the name or status; a retitle does not flicker them", () => {
  const est = (s, px) => String(s ?? "").length * px;
  const titles = ["Bump deps and fix types in the router", "Fix flaky auth test", "Split the router", "Add dark mode", "zsh", ""];
  const heroes = [
    ["Pim Null-Safe", "! waiting", "!"], ["Echo the Idempotent", "fighting 3-3", "3-3"], ["Tamsin the Composable", "fighting 1-1", "1-1"],
    ["Tamsin the Composable", "BOSS 94%", "BOSS 94%"], ["Xan", "! waiting 59m", "! 59m"], ["Rue", "shipped · chest ready", "shipped"],
    ["Tamsin of the Long Uptime", "supervising 2 Forklings", "supervising"],
  ];
  const base = 138; // padding, icon, face, "Lv 88", the hero's gaps, the centre's gaps and divider
  const BARS = { full: 11 + 3 + 48 + 6 + 11 + 3 + 64 + 8, compact: 11 + 3 + 28 + 6 + 11 + 3 + 36 + 8 };
  for (let W = 400; W <= 1000; W += 10) {
    for (const title of titles) {
      const plans = heroes.map(([name, text, short]) => PlateMod.plan({ ...N.scenarios.long, name, careerTitle: "", chip: { text, short, color: "#8A8F98" } }, W, false, title));
      // the same width and title: the same decision for every name and status chip (round 3's
      // bug: 'Echo' had none beside 'Pim' with them; 'fighting 1-1' → 'BOSS 94%' toggled them)
      assert.equal(new Set(plans.map((p) => `${p.bars}/${p.compact}`)).size, 1, `${W} px "${title}": ${plans.map((p) => `${p.bars}/${p.compact}`)}`);
      // a split shows them: the compact bars from 420 px whatever the title (owner decision round 4)
      assert.equal(plans[0].bars, W >= 420, `${W} px "${title}"`);
      for (const [i, [name, text, short]] of heroes.entries()) {
        const p = plans[i];
        if (!p.bars) continue;
        const chipW = p.chip ? est(p.short ? short : text, 5.4) + 20 : 0;
        const nameW = Math.min(est(name, 7.2), p.nameMax);
        const room = W - (base + nameW + chipW + (p.compact ? BARS.compact : BARS.full));
        // full bars leave the whole title its room (names up to 170 px, chips up to 100 px);
        // compact ones leave it at least 40 px (it truncates sooner; its tooltip has it all)
        if (!p.compact && est(name, 7.2) <= 170 && est(text, 5.4) + 20 <= 100) assert.ok(room >= Math.min(est(title, 6.2), 220) - 0.01, `${W} px ${name}: title "${title}" cut beside the full bars`);
        if (p.compact) assert.ok(room >= 40 - 0.01, `${W} px ${name} (${p.short ? short : text}, name ${Math.round(nameW)}): ${Math.round(room)} px for the title beside the compact bars`);
        // beside compact bars the chip takes its short form only when its full text would cost the title
        if (p.compact && !p.short) assert.ok(W - (base + Math.min(est(name, 7.2), 72) + est(text, 5.4) + 20 + BARS.compact) >= 100 - 0.01);
      }
    }
  }
  // hysteresis: full bars shown stay through a slightly longer title, and give way to the compact
  // ones when it clearly needs the room
  const vm = N.scenarios.long;
  const W = 700;
  const fits = "x".repeat(Math.floor((W - (base + 170 + 100 + BARS.full)) / 6.2));
  const kind = (p) => (p.bars ? (p.compact ? "compact" : "full") : "none");
  assert.equal(kind(PlateMod.plan(vm, W, false, fits)), "full");
  const longer = fits + "xx";
  assert.equal(kind(PlateMod.plan(vm, W, false, longer, "", false)), "compact", "off: a title that does not fit beside the full bars gets the compact ones");
  assert.equal(kind(PlateMod.plan(vm, W, false, longer, "", "full")), "full", "on: a retitle 2 characters longer keeps them");
  assert.equal(kind(PlateMod.plan(vm, W, false, longer, "", true)), "full", "(prevBars true means full, as round 3 passed it)");
  assert.equal(kind(PlateMod.plan(vm, W, false, fits + "x".repeat(6), "", "full")), "compact", "and they go when it is clearly longer");
  // the compact bars at the split's edge: from 420 px, and once shown down to 396 (24 px)
  const t = N.panes.long.title;
  assert.equal(kind(PlateMod.plan(vm, 419, false, t)), "none");
  assert.equal(kind(PlateMod.plan(vm, 420, false, t)), "compact");
  assert.equal(kind(PlateMod.plan(vm, 396, false, t, "", "compact")), "compact", "a drag 24 px narrower keeps them");
  assert.equal(kind(PlateMod.plan(vm, 395, false, t, "", "compact")), "none");
  // a hover never toggles them
  for (const W2 of [420, 520, 700, 900]) for (const t2 of titles) assert.equal(kind(PlateMod.plan(vm, W2, true, t2)), kind(PlateMod.plan(vm, W2, false, t2)), `${W2} "${t2}"`);
});

test("nameplate: below 360 px plan() keeps the terminal title, drops the level before it, and goes short below 200", () => {
  const kip = N.scenarios.focused, title = N.panes.focused.title;
  for (const W of [210, 260, 300, 340, 359]) {
    const p = PlateMod.plan(kip, W, false, title);
    assert.ok(p.tiny && p.icon && p.title && p.chip && !p.name && !p.short, `${W}: ${JSON.stringify(p)}`);
    assert.ok(!p.career && !p.contractor && !p.bars && !p.folder);
  }
  assert.equal(PlateMod.plan(kip, 260, false, title).level, false, "the title keeps its room first");
  assert.equal(PlateMod.plan(kip, 340, false, title).level, true);
  assert.equal(PlateMod.plan(kip, 340, false, "").title, false, "no title: nothing to show");
  const micro = PlateMod.plan(N.scenarios.micro, 180, false, title);
  assert.ok(micro.micro && micro.short && micro.chip && !micro.icon && !micro.level, JSON.stringify(micro));
  const big = PlateMod.plan(kip, 360, false, title);
  assert.ok(!big.tiny && big.name && big.level && big.icon && big.title && !big.short);
});

test("nameplate: hovered, the chip (then the name) makes way so the pane buttons stay inside the header, bars or not", () => {
  // Measured in Chromium: without this, close (and zoom) were clipped at 360–440 px when hovered.
  const long = N.scenarios.long, title = N.panes.long.title;
  for (const W of [360, 400, 440]) assert.equal(PlateMod.plan(long, W, true, title).chip, false, `long hovered ${W}`);
  assert.equal(PlateMod.plan(long, 400, false, title).chip, true, "not hovered: the chip stays");
  assert.equal(PlateMod.plan(long, 760, true, title).chip, true, "wide and hovered: room for both");
  assert.equal(PlateMod.plan(N.scenarios.blocked, 410, true, N.panes.blocked.title).chip, true, "no bars at 410: room for the chip");
  // every hovered header's fixed parts fit: the hero (its name at nameMax), the bars, the chip and
  // the four buttons (the title takes what is left, down to nothing)
  const est = (s, px) => String(s ?? "").length * px;
  const BARS = { full: 154, compact: 106 };
  for (const [name, vm] of Object.entries(N.scenarios)) {
    if (!vm) continue;
    for (let W = 360; W <= 1000; W += 4) {
      for (const prev of [false, "compact", "full"]) {
        const p = PlateMod.plan(vm, W, true, N.panes[name]?.title ?? "", "", prev);
        const chipW = p.chip ? est(p.short ? vm.chip.short ?? vm.chip.text : vm.chip.text, 5.4) + 20 : 0;
        const used = 138 + Math.min(est(vm.name, 7.2), p.nameMax) + chipW + (p.bars ? BARS[p.compact ? "compact" : "full"] : 0) + 112
          + (p.career ? est(vm.careerTitle, 5.6) + 6 : 0) + (p.contractor ? 78 : 0);
        assert.ok(used <= W + 0.01, `${name} @${W} (prev ${prev}): ${Math.round(used)} px`);
      }
    }
  }
});

test("nameplate: HP / XP bars in a split (owner decision round 4): compact from about 420 px, the title truncating sooner, its whole text in a tooltip", async () => {
  const bars = (m, pane) => m.node(`np-bars-${pane}`);
  const barWidths = (n) => n.children.flatMap((g) => g.children).filter((x) => x.type !== "text" && x.methods.some((y) => y[0] === "rounded"))
    .map((x) => x.methods.find((y) => y[0] === "w")[1][0]);
  for (const name of ["focused", "long", "blocked", "contractor", "shipped"]) {
    const pane = N.panes[name];
    for (const W of [420, 600, 1200]) {
      const { m } = await mount("nameplate", N.scenarios[name], plateOpts(name, { width: W }));
      assertClean(m, `${name} @${W}`);
      const b = bars(m, pane.pane);
      assert.ok(b, `${name} @${W}: the bars`);
      const p = PlateMod.plan(N.scenarios[name], W, false, pane.name || pane.title);
      assert.deepEqual(barWidths(b), p.compact ? [28, 36] : [48, 64], `${name} @${W}`);
      // the terminal title keeps its text (it truncates) and says all of it on hover
      const title = m.findAll((n) => n.type !== "text" && n.methods.some((x) => x[0] === "tooltip" && x[1][0] === (pane.name || pane.title)));
      assert.equal(title.length, 1, `${name} @${W}: the title's tooltip`);
    }
    // a narrower split: none below 420 px (the title keeps what is left)
    const { m } = await mount("nameplate", N.scenarios[name], plateOpts(name, { width: 400 }));
    assert.equal(bars(m, pane.pane), null, `${name} @400`);
  }
  // 1200 px with a short title: the full bars
  const wide = await mount("nameplate", N.scenarios.focused, plateOpts("focused", { width: 1200 }));
  assert.deepEqual(barWidths(bars(wide.m, N.panes.focused.pane)), [48, 64]);
  // a narrow header (below 360 px) keeps the title's tooltip too
  const narrow = await mount("nameplate", N.scenarios.narrow, plateOpts("narrow", { width: 300 }));
  assert.ok(narrow.m.findAll((n) => n.type !== "text" && n.methods.some((x) => x[0] === "tooltip" && x[1][0] === N.panes.narrow.title)).length === 1);
});

/** Mount a pane header the way herdr does: the first frame renders before any size is reported. */
async function mountPlate(name, vm = N.scenarios[name]) {
  M.resetState();
  M.resetStorage();
  const host = fakeHost("nameplate", vm);
  const pane = N.panes[name];
  const roleProps = { role: "nameplate", pane: pane.pane, terminal: pane.terminal };
  class Wrap extends View {
    init(_p, cx) { this.role = new PlateMod.default(); this.role.init(props() ?? roleProps, cx, host); }
    render(cx) { return this.role.render(cx); }
  }
  const m = await M.mountView(Wrap, { props: roleProps, fixture: { settings: { zoom: 1 }, theme: "graphite", panes: [pane] }, nowMs: NOW });
  m.render();
  return { m, host, pane };
}

test("nameplate: no bars before herdr reports the header's width; a header first measured under 420 px shows none; only bars a measured 420 px+ header showed are kept (round 4b U1)", async () => {
  // herdr reports a size after laying the header out (gpui-shell SizeObserver, in prepaint), so a
  // copy's first frame has none; it used to be planned at a 600 px default, bars included
  for (const name of ["focused", "long", "blocked", "contractor", "boss", "shipped"]) {
    const { m, pane } = await mountPlate(name);
    const bars = () => m.node(`np-bars-${pane.pane}`);
    assert.equal(bars(), null, `${name}: the first frame (no width yet) shows no bars`);
    assert.ok(m.node(`np-chip-${pane.pane}`), `${name}: the chip shows`);
    const at = (w) => { m.size(w, 34); m.render(); m.render(); return bars() != null; };
    assert.equal(at(400), false, `${name}: first measured at 400 px`);
    assert.equal(at(410), false, `${name}: 410 px`);
    assert.equal(at(420), true, `${name}: 420 px`);
    assert.equal(at(400), true, `${name}: shown at 420, kept at 400 (hysteresis)`);
    assert.equal(at(395), false, `${name}: 395 px`);
    assert.equal(at(400), false, `${name}: dropped at 395, not back at 400`);
  }
  // a fresh copy first measured at 420 px shows them
  const { m, pane } = await mountPlate("focused");
  m.size(420, 34);
  m.render();
  assert.ok(m.node(`np-bars-${pane.pane}`));
  // plan(): unmeasured, never
  for (const W of [420, 600, 1200]) assert.equal(PlateMod.plan(N.scenarios.focused, W, false, "t", "", "full", { measured: false }).bars, false, `${W}`);
});

test("nameplate: the chip outranks the bars: a chip that would not fit beside them takes their place (round 4b U1)", () => {
  const wide = { ...N.scenarios.focused, chip: { text: "x".repeat(30), color: "#8A8F98" } };
  for (const W of [396, 420, 460]) {
    for (const prev of [false, "compact"]) {
      const p = PlateMod.plan(wide, W, false, N.panes.focused.title, "", prev);
      assert.equal(p.bars, false, `${W} prev ${prev}`);
      assert.equal(p.chip, true, `${W} prev ${prev}`);
    }
  }
  // the chips this game shows keep the bars from 420 px
  for (const name of ["focused", "long", "blocked", "contractor", "boss", "shipped"]) {
    assert.equal(PlateMod.plan(N.scenarios[name], 420, false, N.panes[name].title).bars, true, name);
  }
});

test("layout: a pane header's chip is never clipped, at any width, measured or not; bars show whole or not at all (round 4b U1)", async (t) => {
  let pw;
  try { pw = (await import("node:module")).createRequire(import.meta.url)("playwright"); } catch { return G.skipGate(t, "pane headers in Chromium", "Playwright is not installed"); }
  const { newContext, blockHtml, documentHtml } = await import("../tools/preview/render.mjs");
  const { resolveTheme } = await import("../tools/mock/theme.mjs");
  const widths = [];
  for (let W = 120; W <= 1400; W += W < 480 ? 8 : 40) widths.push(W);
  const cases = [];
  const chips = {
    supervising: { text: "supervising 12 Forklings", short: "supervising", color: "#8A8F98" },
    rebooting: { text: "rebooting", short: "rebooting", color: "#FF5A5F" },
    waiting: { text: "! waiting 59m", short: "! 59m", color: "#F2A93B" },
  };
  const variants = Object.entries(N.scenarios).filter(([, vm]) => vm).map(([name, vm]) => [name, name, vm])
    .concat(Object.entries(chips).map(([k, chip]) => [`long+${k}`, "long", { ...N.scenarios.long, chip }]));
  for (const [label, paneName, vm] of variants) {
    // measured, narrowing from 1400 px (the hysteresis keeps bars), then widening from 120 px
    const { m, pane } = await mountPlate(paneName, vm);
    const seq = widths.slice().reverse().concat(widths);
    seq.forEach((W, i) => {
      m.size(W, 34);
      m.render();
      cases.push({ label: `${label} measured @${W} (${i < widths.length ? "narrowing" : "widening"})`, tree: m.tree, W, pane: pane.pane, chips: [vm.chip.text, vm.chip.short ?? vm.chip.text] });
    });
    // the first frame of a fresh copy, laid out at its real width
    const fresh = await mountPlate(paneName, vm);
    for (const W of widths) cases.push({ label: `${label} first frame @${W}`, tree: fresh.m.tree, W, pane: pane.pane, first: true, chips: [vm.chip.text, vm.chip.short ?? vm.chip.text] });
  }
  const ctx = newContext({ zoom: 1, theme: resolveTheme("graphite") });
  const body = cases.map((c, i) => `<div data-case="${i}" style="width:${c.W}px;height:34px;margin-bottom:2px">${blockHtml(c.tree, ctx, { width: c.W, height: 34 })}</div>`).join("");
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.setContent(documentHtml({ body, ctx, title: "plates" }).replace(/html,body\{width:[^}]*\}/, ""), { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready);
    const bad = await page.evaluate((cases) => {
      const out = [];
      const whole = (el, box) => { const r = el.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5; };
      // the visible box: the header's own box, clipped by every clipping ancestor up to it
      const visible = (el, stop) => {
        const r = el.getBoundingClientRect();
        let left = r.left, right = r.right;
        for (let e = el.parentElement; e && e !== stop.parentElement; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if (cs.overflowX === "visible") continue;
          const p = e.getBoundingClientRect();
          const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
          left = Math.max(left, p.left + bl); right = Math.min(right, p.right - br);
        }
        return { left, right, width: r.width, rl: r.left, rr: r.right };
      };
      cases.forEach((c, i) => {
        const wrap = document.querySelector(`[data-case="${i}"]`);
        const head = wrap.querySelector(`[data-id="pane-head-${c.pane}"]`);
        // (found by its text in a build that gave the chip no id)
        const chip = wrap.querySelector(`[data-id="np-chip-${c.pane}"]`)
          ?? [...head.children].reverse().find((e) => c.chips.includes(e.textContent.trim()));
        const bars = wrap.querySelector(`[data-id="np-bars-${c.pane}"]`);
        if (!head) { out.push(`${c.label}: no header`); return; }
        const hb = head.getBoundingClientRect();
        if (!chip) { out.push(`${c.label}: no chip`); return; }
        const v = visible(chip, head);
        if (v.left > v.rl + 0.5 || v.right < v.rr - 0.5 || !whole(chip, hb)) out.push(`${c.label}: the chip is clipped (${Math.round(v.right - v.left)} of ${Math.round(v.width)} px shown)`);
        // its text is whole too, except in a first frame narrower than the chip alone
        const txt = chip.firstElementChild;
        if (txt && txt.scrollWidth > txt.clientWidth + 0.5 && !(c.first && c.W < 160)) out.push(`${c.label}: the chip's text is cut ("${txt.textContent}")`);
        if (bars) {
          const b = visible(bars, head);
          if (b.left > b.rl + 0.5 || b.right < b.rr - 0.5) out.push(`${c.label}: the bars are cut (${Math.round(Math.max(0, b.right - b.left))} of ${Math.round(b.width)} px shown)`);
        }
      });
      return out;
    }, cases.map((c) => ({ label: c.label, pane: c.pane, W: c.W, first: !!c.first, chips: c.chips })));
    assert.deepEqual(bad, []);
  } finally {
    await browser.close();
  }
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
  assert.deepEqual(errorsOf(gone.m), []);
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
  assert.deepEqual(overlays(), [{ mod: "down-the-stack", kind: "dialog", width: 760, height: 520, props: { role: "herd" } }]);
  const text = m.text();
  for (const s of ["48.2k", "133", "v2.3", "Pyramid of Doom", "7/10", "working", "blocked", "shipped"]) assert.ok(text.includes(s), s);
  const narrow = await mount("hud", H.scenarios.normal, { width: 400, height: 26 });
  assert.ok(!narrow.m.text().includes("working"), "narrow strips drop the words");
  assert.ok(!narrow.m.text().includes("Pyramid"), "and the sprint");
});

test("hud: the sprint shows only when the fixed parts leave it room (it never paints over the counts)", () => {
  const big = { gold: "41.3M", snippets: "26.1k", release: "v7.8", sprint: { label: "The Backlog, floor 14", have: 23, need: 50 }, working: 8, blocked: 2, shipped: 2, digestDot: false };
  assert.deepEqual(HudMod.hudFit(big, 420), { words: false, sprint: false, sprintLabel: false, saveLabel: null });
  assert.deepEqual(HudMod.hudFit(big, 640), { words: false, sprint: true, sprintLabel: true, saveLabel: null });
  assert.deepEqual(HudMod.hudFit(big, 1170), { words: true, sprint: true, sprintLabel: true, saveLabel: null });
  // save trouble takes room first: its title with the words, its short form without; the sprint's
  // label gives way, then the sprint
  const saving = { ...big, save: { title: "Save didn't load: new herd", short: "New herd", tooltip: "…" } };
  assert.deepEqual(HudMod.hudFit(saving, 640), { words: false, sprint: true, sprintLabel: false, saveLabel: "New herd" });
  assert.deepEqual(HudMod.hudFit(saving, 560), { words: false, sprint: false, sprintLabel: false, saveLabel: "New herd" });
  assert.deepEqual(HudMod.hudFit(saving, 1170), { words: true, sprint: true, sprintLabel: true, saveLabel: "Save didn't load: new herd" });
  assert.equal(HudMod.hudFit(H.scenarios.normal, 520).sprint, true);
  assert.equal(HudMod.hudFit(H.scenarios.zeros, 1170).sprint, false, "no sprint, nothing to fit");
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
// key commands (down-the-stack.sheet / .herd / .calm reach whichever copy claims them)

test("every chrome role answers down-the-stack.sheet / herd / calm the same way", async () => {
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

test("down-the-stack.calm reads calm from the cheap HUD view, never a whole party", async () => {
  const { m, host } = await mount("party", P.scenarios.six, { extra: { hud: { ...H.scenarios.normal, calm: true } } });
  host.views.length = 0;
  assert.equal(m.view.role.command("calm"), true);
  assert.deepEqual(host.views.map((v) => v[0]), ["hud"]);
  assert.deepEqual(host.commands.at(-1), ["setting", { key: "calm", value: false }]);
});
