// main.js (the role dispatcher and lifecycle) through the mock herdr runtime: roles, the shared
// world across copies, the 1 s pump + broadcast reaching every copy, the stale guard, key commands
// claimed once and handled centrally (sheet / herd / calm toggle exactly one thing), overlay
// registration, the render guard's error chip, and close() flushing the save on the last copy.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const M = await import("../tools/mock/index.mjs");
const FX = await import("../tools/fixtures.mjs");

const MAIN = path.join(M.REPO, "mods", "down-the-stack", "main.js");
const NOW = FX.NOW;
const SAVE = `${M.APP_HOME}/data/down-the-stack/save.json`;
const ROLE_FILES = { stage: "ui/stage.js", party: "ui/party.js", nameplate: "ui/nameplate.js", hud: "ui/hud.js", sheet: "ui/sheet.js", herd: "ui/herdpanel.js" };

let graphN = 0;
async function mount(props, { graph, fixture } = {}) {
  return M.mountMod(MAIN, { props, graph: graph ?? `main-${++graphN}`, fixture: fixture === null ? undefined : fixture ?? {}, nowMs: fixture === null ? undefined : NOW });
}
const hostOf = async (mod) => (await mod.import("./host.js")).getHost();
/** Put a demo world on the host (as tools/check.mjs does) and re-render everything once. */
async function useDemo(mod, kind) {
  const host = await hostOf(mod);
  host.world = (await mod.import("./game/demo.js")).demoWorld(kind, NOW).world;
  host.version++;
  for (const h of M.mounted()) h.render();
  return host;
}
const opened = () => M.calls().openOverlay;
const closed = () => M.calls().closeOverlay;

test("each role gets its class; unknown and missing roles render a quiet placeholder", async () => {
  M.resetState();
  const g = "roles";
  const fx = { ...FX.demoFixture("mid") };
  for (const [role, file] of Object.entries(ROLE_FILES)) {
    const props = role === "nameplate" ? { role, pane: "p_t1", terminal: "t1" }
      : role === "sheet" ? { role, overlay: "o1", heroId: 1 } : role === "herd" ? { role, overlay: "o2" } : { role };
    const mod = await mount(props, { graph: g, fixture: role === "stage" ? fx : null });
    const Cls = (await mod.import(`./${file}`)).default;
    assert.ok(mod.view.role instanceof Cls, `${role} → ${file}`);
    assert.ok(mod.render(), `${role} renders`);
    assert.deepEqual(mod.errors, [], role);
  }
  const odd = await mount({ role: "minimap" }, { graph: g, fixture: null });
  assert.equal(odd.view.role, null);
  odd.render();
  assert.match(odd.text(), /no role "minimap"/);
  const none = await mount(null, { graph: g, fixture: null });
  none.render();
  assert.equal(none.text(), "Down the Stack");
});

test("herdr-app check path: props null, checking, one render, no timers or IO", async () => {
  M.resetState({ checking: true });
  const mod = await M.mountMod(MAIN, { checking: true, fixture: M.checkFixture(), graph: `main-${++graphN}` });
  const tree = mod.render();
  assert.ok(tree);
  assert.equal(M.state.copies[0].tasks.size, 0, "no timer, no nextCommand loop");
  assert.equal(M.calls().readTextFile.length, 0);
  assert.deepEqual(mod.errors, []);
  M.setChecking(false);
});

test("two copies share one world: the 1 s timers pump it once a second and the broadcast re-renders both", async () => {
  M.resetState();
  const stage = await mount({ role: "stage" }, { graph: "pump", fixture: FX.demoFixture("mid") });
  const party = await mount({ role: "party" }, { graph: "pump", fixture: null });
  const host = await useDemo(stage, "mid");
  assert.equal(party.view.host, host);
  const r0 = [stage.stats.renders, party.stats.renders];
  const tick0 = host.world.state.herd.tick;
  const ticks = () => M.calls().run.filter((r) => r.name === "down-the-stack.tick").length;
  const b0 = ticks();
  for (let i = 0; i < 5; i++) await M.tickAll(1000);
  assert.equal(host.world.state.herd.tick - tick0, 5, "five ticks in five seconds, not ten");
  assert.equal(host.stats.pumps, 5);
  assert.equal(ticks() - b0, 5);
  assert.equal(stage.stats.renders - r0[0], 5, "one re-render per broadcast");
  assert.equal(party.stats.renders - r0[1], 5);
  assert.equal(stage.view.seen, host.version);
  assert.equal(party.view.seen, host.version);
  assert.deepEqual([...stage.errors, ...party.errors], []);
});

test("stale guard: a copy that missed a version re-renders by itself within ~2 s", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: {} }); // no agents: most pumps change nothing visible
  const host = await hostOf(mod);
  mod.render();
  await M.tickAll(3000);
  const r0 = mod.stats.renders;
  host.version++; // e.g. a change whose broadcast this copy never saw
  await M.tickAll(1000);
  assert.equal(mod.stats.renders, r0, "not yet");
  await M.tickAll(2000);
  assert.equal(mod.stats.renders, r0 + 1, "caught up once");
  assert.equal(mod.view.seen, host.version);
  await M.tickAll(3000);
  assert.equal(mod.stats.renders, r0 + 1, "and then stays quiet");
});

test("key commands reach every copy but are handled once: herd toggles exactly one dialog", async () => {
  M.resetState();
  const g = "keys";
  const stage = await mount({ role: "stage" }, { graph: g, fixture: FX.demoFixture("mid") });
  await mount({ role: "party" }, { graph: g, fixture: null });
  await mount({ role: "nameplate", pane: "p_t1", terminal: "t1" }, { graph: g, fixture: null });
  const host = await useDemo(stage, "mid");

  await M.sendCommand("herd");
  assert.equal(opened().length, 1, "one Herd panel, not one per copy");
  assert.deepEqual(opened()[0].spec.props, { role: "herd" });
  const id = opened()[0].id;
  // herdr loads the dialog's copy; it registers its overlay
  const dlg = await mount({ role: "herd", overlay: id }, { graph: g, fixture: null });
  assert.equal(host.overlays.herd.id, id);

  await M.sendCommand("herd"); // within 300 ms of the first press: the same keystroke's echo
  assert.equal(closed().length, 0);
  await M.tickAll(400);
  await M.sendCommand("herd"); // a second press (the dialog copy hears it too)
  assert.equal(opened().length, 1);
  assert.deepEqual(closed().map((c) => c.id), [id], "closed exactly once");
  await dlg.close(); // herdr closes the copy
  assert.equal(host.overlays.herd, null);

  await M.tickAll(400);
  await M.sendCommand("herd");
  assert.equal(opened().length, 2, "a third press opens it again");
  for (const h of M.mounted()) assert.deepEqual(h.errors, [], h.copy.label);
});

test("sheet key: the focused agent's hero, then closes it; no focused hero → the roster", async () => {
  M.resetState();
  const g = "sheetkey";
  const stage = await mount({ role: "stage" }, { graph: g, fixture: FX.demoFixture("mid") }); // focus: t2
  await mount({ role: "party" }, { graph: g, fixture: null });
  const host = await useDemo(stage, "mid");

  await M.sendCommand("sheet");
  assert.equal(opened().length, 1);
  assert.deepEqual(opened()[0].spec, { mod: "down-the-stack", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 2 } });
  const id = opened()[0].id;
  const dlg = await mount({ role: "sheet", overlay: id, heroId: 2 }, { graph: g, fixture: null });
  assert.equal(host.overlays.sheet.id, id);

  await M.tickAll(400);
  await M.sendCommand("sheet");
  assert.deepEqual(closed().map((c) => c.id), [id]);
  assert.equal(opened().length, 1);
  await dlg.close();

  // a sub-agent's pane focused: its parent's sheet
  M.updateFixture({ focused: { space: "spc_2", tab: "tab_1", pane: null, terminal: "s5a", shown: null, agent: null, cwd: null, selection: null } });
  await M.tickAll(400);
  await M.sendCommand("sheet");
  assert.equal(opened().at(-1).spec.props.heroId, 5);
  host.closeDialog("sheet");

  // nothing focused: the Herd panel's roster
  M.updateFixture({ focused: null });
  await M.tickAll(400);
  await M.sendCommand("sheet");
  assert.deepEqual(opened().at(-1).spec.props, { role: "herd", tab: "roster" });
});

test("calm key flips calm mode once, however many copies hear it", async () => {
  M.resetState();
  const g = "calm";
  const stage = await mount({ role: "stage" }, { graph: g, fixture: FX.demoFixture("mid") });
  await mount({ role: "party" }, { graph: g, fixture: null });
  await mount({ role: "hud" }, { graph: g, fixture: null });
  const host = await useDemo(stage, "mid");
  assert.equal(host.world.state.herd.cfg.calm, false);
  await M.sendCommand("calm");
  assert.equal(host.world.state.herd.cfg.calm, true);
  await M.tickAll(400);
  await M.sendCommand("calm");
  assert.equal(host.world.state.herd.cfg.calm, false);
  for (const h of M.mounted()) assert.deepEqual(h.errors, [], h.copy.label);
});

test("other commands go to the role's own handler", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: {} });
  const seen = [];
  mod.view.role.command = (name) => { seen.push(name); return true; };
  await mod.command("focus");
  await mod.command("tick");
  await mod.command("sheet");
  await mod.command("stage:show");
  // a command named like an Object.prototype member is no hotkey (HOTKEYS is read as own keys)
  await mod.command("constructor");
  await mod.command("toString");
  assert.deepEqual(seen, ["focus", "constructor", "toString"], "tick re-renders only; sheet/herd/calm/stage are central");
});

test("a throwing role render shows the error chip, keeps herdr's chrome alive, and is logged once", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: FX.demoFixture("mid") });
  await useDemo(mod, "mid");
  mod.view.role.render = () => { throw new Error("boom"); };
  const tree = mod.render();
  assert.ok(tree, "render did not throw");
  assert.ok(mod.find("mdr-error-chip"));
  assert.match(mod.text(), /hud view hit a snag/);
  const tip = mod.find("mdr-error-chip").methods.find((m) => m[0] === "tooltip")[1][0];
  assert.match(tip, /hud render: boom/);
  assert.deepEqual(mod.errors, [], "nothing escaped the render");
  await M.tickAll(3000);
  mod.render();
  const errs = mod.errors.filter((e) => /boom/.test(e.message));
  assert.equal(errs.length, 1, "rethrown once from the timer (herdr logs it)");
  assert.match(errs[0].message, /hud render failed: boom/);
  const host = await hostOf(mod);
  assert.ok(host.errors.find((e) => e.where === "hud render").count >= 2);

  // the stage shows a debug dot (tooltip only) while errors exist
  const stage = await mount({ role: "stage" }, { graph: undefined, fixture: null });
  (await hostOf(stage)).error("save", new Error("disk full"));
  stage.render();
  const dot = stage.find("mdr-debug");
  assert.ok(dot);
  assert.match(dot.methods.find((m) => m[0] === "tooltip")[1][0], /disk full/);
});

test("a throwing view builder shows the error chip, not an endless loading state; the party lists herdr's agents plainly", async () => {
  M.resetState();
  const g = "viewerr";
  const fx = FX.demoFixture("mid");
  const party = await mount({ role: "party" }, { graph: g, fixture: fx });
  const stage = await mount({ role: "stage" }, { graph: g, fixture: null });
  const plate = await mount({ role: "nameplate", pane: "p_t1", terminal: "t1" }, { graph: g, fixture: null });
  const host = await useDemo(party, "mid");
  const real = host.view.bind(host);
  host.view = (kind, args) => {
    if (kind === "party" || kind === "stage" || kind === "nameplate") {
      host.viewErrors[kind] = `simulated ${kind} bug`;
      return null; // what host.view answers after a throw
    }
    return real(kind, args);
  };
  party.size(248, 600);
  party.render();
  assert.doesNotMatch(party.text(), /Loading/);
  assert.match(party.text(), /party view hit a snag/);
  const rows = party.findAll((n) => typeof n.id === "string" && n.id.startsWith("mdr-plain-") && n.id !== "mdr-plain-party");
  assert.equal(rows.length, fx.agents.length, "herdr's agents, plainly");
  party.fire(rows[1].id);
  assert.deepEqual(M.calls().run.at(-1), { name: "pane.focus", args: { terminal: fx.agents[1].address }, copy: party.copy.label });
  stage.size(960, 200);
  stage.render();
  assert.ok(stage.find("mdr-error-chip"));
  assert.match(stage.text(), /stage view hit a snag/);
  plate.render();
  assert.equal(plate.find("mdr-error-chip"), null, "a pane header falls back to herdr's plain header instead");
  // fixed: the roles draw again
  host.view = real;
  delete host.viewErrors.party;
  delete host.viewErrors.stage;
  party.render();
  stage.render();
  assert.equal(party.find("mdr-plain-party"), null);
  assert.equal(stage.find("mdr-error-chip"), null);
  for (const m of [party, stage, plate]) assert.deepEqual(m.errors, []);
});

test("close(): role cleanup, overlay unregistered, the save flushed only by the last copy", async () => {
  M.resetState();
  const g = "close";
  const a = await mount({ role: "stage" }, { graph: g, fixture: FX.demoFixture("first-day") });
  const b = await mount({ role: "sheet", overlay: "o9", heroId: 1 }, { graph: g, fixture: null });
  const host = await hostOf(a);
  assert.equal(host.overlays.sheet.id, "o9");
  let released = 0;
  const rel = b.view.role.close.bind(b.view.role);
  b.view.role.close = (cx) => { released++; return rel(cx); };
  await M.tickAll(3000);
  host.world.rt.dirty = true;
  const n = M.calls().writeTextFile.filter((c) => c.path === SAVE).length;
  await b.close();
  assert.equal(released, 1);
  assert.equal(host.overlays.sheet, null);
  assert.equal(M.calls().writeTextFile.filter((c) => c.path === SAVE).length, n, "not the last copy: no flush");
  await a.close();
  assert.equal(M.calls().writeTextFile.filter((c) => c.path === SAVE).length, n + 1, "the last copy flushed");
  assert.equal(M.memfs.readText(SAVE), host.lastText);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("save trouble reaches the party and the HUD through the host (the role fixtures render differently)", async () => {
  const { renderRoles } = await import("../tools/preview/shoot.mjs");
  const byName = Object.fromEntries(FX.roles.map((r) => [r.name, r]));
  const out = await renderRoles(MAIN, ["hud", "hud-save-unreadable", "party-mid", "party-save-notsaving"].map((n) => byName[n]));
  const has = (r, id) => JSON.stringify(r.tree).includes(`"${id}"`);
  const [hud, hudSave, party, partySave] = out;
  for (const r of out) assert.deepEqual(r.errors, [], r.role.name);
  assert.equal(has(hud, "hud-save"), false);
  assert.equal(has(hudSave, "hud-save"), true);
  assert.notEqual(JSON.stringify(hudSave.tree), JSON.stringify(hud.tree));
  assert.equal(has(party, "party-save"), false);
  assert.equal(has(partySave, "party-save"), true);
  assert.ok(JSON.stringify(partySave.tree).includes("Not saving"));
});
