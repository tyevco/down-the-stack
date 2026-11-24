// The host's opt-in notifications and "collapse the stage when nothing is working" (D§11.15),
// through the mock herdr runtime:
//  - a milestone the world raised is posted with notify() once a save that took it landed, never
//    before, never while checking(), never from a host a hot reload retired, never twice (hot
//    reload, two windows sharing one save), never with a stale one; a click opens the Herd panel
//    with mod.open (an app command: it works in any layout);
//  - the stage block is hidden (layout.hide) a minute after the last hero stops and shown again
//    (layout.show) when one works, on those transitions only: a stage the person shows or hides by
//    hand stays as they left it; turning the setting off, or a restart with the stage still
//    hidden, shows a stage the host hid itself.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const M = await import("../tools/mock/index.mjs");
const FX = await import("../tools/fixtures.mjs");
const { demoWorld } = await import("../mods/down-the-stack/game/demo.js");
const { serialize } = await import("../mods/down-the-stack/game/world.js");
const herdr = await import("herdr");

const MAIN = path.join(M.REPO, "mods", "down-the-stack", "main.js");
const NOW = FX.NOW;
const DIR = `${M.APP_HOME}/data/down-the-stack`;
const SAVE = `${DIR}/save.json`;
const MIN = 60000;

let graphN = 0;
async function mount(props, { graph, fixture, files, checking } = {}) {
  const g = graph ?? `notify-${++graphN}`;
  const fx = fixture === null ? undefined : { ...(fixture ?? {}), ...(files ? { files } : {}) };
  return M.mountMod(MAIN, { props, graph: g, fixture: fx, nowMs: fx ? NOW : undefined, checking });
}
const hostOf = async (mod) => (await mod.import("./host.js")).getHost();
const notes = () => M.calls().notify;
const runs = (name) => M.calls().run.filter((c) => c.name === name);
const stageNode = () => (function find(n) {
  if (!n || typeof n !== "object") return null;
  if (n.id === "stage") return n;
  for (const k of n.children ?? []) { const f = find(k); if (f) return f; }
  return null;
})(M.fixture().layout);

/** A save of a demo world with herd.cfg changed by `edit`. */
function saveWith(kind, edit) {
  const { world } = demoWorld(kind, NOW - 60000);
  edit(world);
  return serialize(world);
}
const notifyOn = (w) => Object.assign(w.state.herd.cfg.notify, { boss: true, lts: true, principal: true });
/** The first boss the herd has not beaten: credit a herd-first kill of it to the live world. */
function killNextBoss(host) {
  const herd = host.world.state.herd;
  const i = herd.bossKills.findIndex((k) => !k);
  herd.bossKills[i] = 1;
  herd.boss[i] = 1;
  return i;
}

test("a milestone is posted once the save that took it landed, with mod.open as its click", async () => {
  M.resetState();
  const mod = await mount({ role: "party" }, { fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", notifyOn) } });
  const host = await hostOf(mod);
  await M.tickAll(1000);
  assert.equal(host.stats.loadedFrom, "save");
  killNextBoss(host);
  host.pump(M.mockNow() + 1000);
  assert.equal(host.outbox.length + (host.saving ? 1 : 0) > 0, true, "taken, a save on its way");
  assert.deepEqual(notes(), [], "nothing before the save is on disk");
  await M.flush();
  assert.equal(notes().length, 1);
  const n = notes()[0].n;
  assert.match(n.title, /: FIXED$/);
  assert.match(n.body, /^The herd reached frame #/);
  assert.equal(n.level, "success");
  assert.deepEqual(n.action, { name: "mod.open", args: { name: "down-the-stack" } });
  assert.equal("sound" in n, false);
  // the save on disk holds the count and no queued milestone: a restart cannot post it again
  const disk = JSON.parse(M.memfs.readText(SAVE));
  assert.equal(disk.herd.nf[1], 1);
  assert.equal("ms" in disk.herd, false);
  await M.tickAll(5000);
  assert.equal(notes().length, 1, "once");
  assert.deepEqual(mod.errors, []);
});

test("a save that never lands (its copy went away) or loses to another writer posts nothing", async () => {
  M.resetState();
  const mod = await mount({ role: "party" }, { fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", notifyOn) } });
  const host = await hostOf(mod);
  await M.tickAll(1000);
  let hang = 1;
  M.updateFixture({ hangAfterWrite: (p) => p === SAVE && hang-- > 0 });
  killNextBoss(host);
  await M.tickAll(1000);
  assert.ok(host.saving, "the write hangs");
  await M.tickAll(5000);
  assert.deepEqual(notes(), [], "never posted without a landed save");
  // another writer: our write conflicts, their save is loaded, our milestone is dropped
  await M.tickAll(20000); // the hung write is given up
  const theirs = saveWith("mid", notifyOn);
  M.memfs.write(SAVE, theirs, { mkdirs: true });
  killNextBoss(host);
  await M.tickAll(1000);
  await M.tickAll(3000);
  assert.equal(host.stats.reloads, 1, "their save was loaded");
  assert.deepEqual(notes(), []);
});

test("checking(): no milestone is ever taken or posted", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("mid"), checking: true });
  const host = await hostOf(mod);
  assert.equal(host.memoryOnly, true);
  notifyOn(host.world);
  host.world.rt.nowMs = NOW;
  const { raiseMilestone } = await mod.import("./game/world.js");
  raiseMilestone(host.world, "boss", { title: "x", body: "" });
  assert.equal(host.takeMilestones(NOW), 0);
  assert.equal(host.post([{ m: { n: 1, kind: "boss", at: Date.now(), title: "x", body: "" }, world: host.world }]), 0);
  assert.equal(host.pump(NOW + 1000), false);
  assert.deepEqual(notes(), []);
  assert.deepEqual(mod.errors, []);
});

test("hot reload: the new build never posts what the old one did, and a retired host posts nothing", async () => {
  M.resetState();
  const a = await mount({ role: "party" }, { graph: `nr-${++graphN}`, fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", notifyOn) } });
  const h1 = await hostOf(a);
  await M.tickAll(1000);
  killNextBoss(h1);
  await M.tickAll(1000);
  assert.equal(notes().length, 1);
  await M.reloadAll([a]);
  const h2 = await hostOf(a);
  assert.notEqual(h2, h1);
  assert.equal(h2.stats.loadedFrom, "reload");
  await M.tickAll(10000);
  assert.equal(notes().length, 1, "the handed-over world has nothing queued");
  // a milestone the old host took but had not posted yet when the reload came: lost, never twice
  killNextBoss(h2);
  let hang = 1;
  M.updateFixture({ hangAfterWrite: (p) => p === SAVE && hang-- > 0 });
  await M.tickAll(1000);
  assert.ok(h2.saving);
  await M.reloadAll([a]);
  const h3 = await hostOf(a);
  assert.equal(h2.retired, true);
  assert.equal(h2.post([{ m: { n: 9, kind: "boss", at: Date.now(), title: "x", body: "" }, world: h2.world }]), 0, "a retired host never posts");
  await M.tickAll(10000);
  assert.equal(notes().length, 1);
  assert.ok(h3.world.state.herd.notified[1] >= 2, "the count went on");
  assert.deepEqual(a.errors, []);
});

for (const diverged of [false, true]) {
  test(`two windows sharing one save: the same herd-first kill is posted once (${diverged ? "their worlds differ" : "identical twins"})`, async () => {
    M.resetState();
    const text = saveWith("mid", notifyOn);
    const a = await mount({ role: "party" }, { graph: `win-a-${diverged}`, fixture: FX.demoFixture("mid"), files: { [SAVE]: text } });
    const b = await mount({ role: "party" }, { graph: `win-b-${diverged}`, fixture: null });
    const ha = await hostOf(a);
    const hb = await hostOf(b);
    assert.notEqual(ha, hb);
    await M.tickAll(1000);
    assert.equal(ha.lastText, hb.lastText, "both read the same file");
    // the mock runs both VMs on one clock, so their worlds stay byte-identical unless told apart
    if (diverged) hb.world.state.herd.gold += 1;
    const i = killNextBoss(ha);
    assert.equal(killNextBoss(hb), i);
    await M.tickAll(1000);
    await M.tickAll(3000);
    assert.equal(notes().length, 1, "one window's save landed and posted; the other's lost");
    // diverged: the loser reloads the winner's save; twins: the loser finds its own text written
    assert.equal(ha.stats.reloads + hb.stats.reloads, diverged ? 1 : 0);
    await M.tickAll(10000);
    assert.equal(notes().length, 1);
  });
}

test("the cap: at most 3 posted a local day, and the count survives a restart", async () => {
  M.resetState();
  const mod = await mount({ role: "party" }, { fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", notifyOn) } });
  const host = await hostOf(mod);
  await M.tickAll(1000);
  for (let k = 0; k < 4; k++) { killNextBoss(host); await M.tickAll(1000); }
  await M.tickAll(3000);
  assert.equal(notes().length, 3);
  // a new VM (restart) on the same file: the day's count is still 3
  const b = await mount({ role: "party" }, { graph: `restart-${++graphN}`, fixture: null });
  const h2 = await hostOf(b);
  await M.tickAll(1000);
  assert.equal(h2.world.state.herd.notified[1], 3);
  killNextBoss(h2);
  await M.tickAll(3000);
  assert.equal(notes().length, 3);
});

test("while a Herd panel is open the toast has no action (mod.open would close the one it opened)", async () => {
  M.resetState();
  const mod = await mount({ role: "party" }, { fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", notifyOn) } });
  const host = await hostOf(mod);
  await M.tickAll(1000);
  host.openHerd();
  killNextBoss(host);
  await M.tickAll(1000);
  assert.equal(notes().length, 1);
  assert.equal("action" in notes()[0].n, false);
  // stale milestones (over 10 minutes old) are dropped
  assert.equal(host.post([{ m: { n: 50, kind: "lts", at: Date.now() - 11 * MIN, title: "x", body: "" }, world: host.world }]), 0);
});

test("mod.json opens the Herd panel as mod.open's overlay (the toast's click, from any layout)", async () => {
  const fs = await import("node:fs");
  const manifest = JSON.parse(fs.readFileSync(path.join(M.REPO, "mods", "down-the-stack", "mod.json"), "utf8"));
  assert.equal(manifest.place, "none");
  assert.deepEqual(manifest.overlay, { kind: "dialog", width: 760, height: 520, props: { role: "herd", tab: "digest" } });
  // the dialog it opens registers like any Herd panel: one at a time
  M.resetState();
  const g = `mo-${++graphN}`;
  const party = await mount({ role: "party" }, { graph: g, fixture: FX.demoFixture("mid") });
  const host = await hostOf(party);
  const dlg = await mount({ role: "herd", tab: "digest", overlay: "mod-down-the-stack" }, { graph: g, fixture: null });
  assert.equal(host.overlays.herd.id, "mod-down-the-stack");
  assert.equal(host.openHerd(), "mod-down-the-stack", "the host keeps it instead of stacking another");
  assert.deepEqual(dlg.errors, []);
});

// ---------------------------------------------------------------------------------------------
// collapse the stage when nothing is working

/** party + stage on one graph, the mid world loaded, collapse on. Returns {host, set(state)}. */
async function collapseRig({ files, collapse = true } = {}) {
  M.resetState();
  const graph = `col-${++graphN}`;
  const party = await mount({ role: "party" }, { graph, fixture: FX.demoFixture("mid"), files });
  await mount({ role: "stage" }, { graph, fixture: null });
  const host = await hostOf(party);
  await M.tickAll(1000);
  if (collapse) assert.equal(host.command("setting", { key: "collapse", value: true }).ok, true);
  // live states are set by hand (no pump runs between these calls)
  const set = (state) => { for (const l of host.world.rt.live.values()) l.state = state; };
  return { host, party, set };
}

test("collapse: a minute after the last hero stops the stage hides; it comes back when one works", async () => {
  const { host, party, set } = await collapseRig();
  assert.equal(runs("layout.hide").length, 0, "something works: turning it on hides nothing");
  const t = M.mockNow();
  host.stageAuto(t);
  set("resting");
  assert.equal(host.stageAuto(t + 1000), null, "armed");
  assert.equal(host.stageAuto(t + 60000), null);
  assert.equal(host.stageAuto(t + 61000), "hidden");
  assert.deepEqual(runs("layout.hide").map((c) => c.args), [{ id: "stage" }]);
  assert.equal(stageNode().hidden, true);
  assert.equal(host.world.state.herd.cfg.collapsed, true, "saved: the host owes it a layout.show");
  assert.equal(host.stageAuto(t + 300000), null, "acts once per transition");
  set("supervising");
  assert.equal(host.stageAuto(t + 301000), "shown");
  assert.deepEqual(runs("layout.show").map((c) => c.args), [{ id: "stage" }]);
  assert.equal(stageNode().hidden, false);
  assert.equal(host.world.state.herd.cfg.collapsed, false);
  assert.deepEqual(party.errors, []);
});

test("collapse: a crashed hero (questing, between respawns) is working: the stage stays", async () => {
  const { host, set } = await collapseRig();
  const t = M.mockNow();
  host.stageAuto(t);
  set("crashed");
  assert.equal(host.stageAuto(t + 1000), null);
  assert.equal(host.stageAuto(t + 120000), null, "a crash is not 'nothing working'");
  assert.equal(runs("layout.hide").length, 0);
  set("resting");
  host.stageAuto(t + 121000);
  assert.equal(host.stageAuto(t + 182000), "hidden", "the crashed hero stopped: a minute later");
});

test("collapse acts on transitions only: a stage shown or hidden by hand stays as the person left it", async () => {
  const { host, set } = await collapseRig();
  const t = M.mockNow();
  host.stageAuto(t);
  set("resting");
  host.stageAuto(t + 1000);
  assert.equal(host.stageAuto(t + 62000), "hidden");
  // the person shows it again (ctrl-shift-g): not hidden again while nothing works
  M.calls().run.length = 0;
  herdr.run("layout.toggle", { id: "stage" });
  assert.equal(stageNode().hidden, false);
  assert.equal(host.stageAuto(t + 63000), null);
  assert.equal(host.world.state.herd.cfg.collapsed, false, "no longer the host's");
  assert.equal(host.stageAuto(t + 300000), null);
  assert.equal(runs("layout.hide").length, 0);
  // work, then the person hides it by hand: when work stops and starts again it stays hidden
  set("questing");
  host.stageAuto(t + 301000);
  herdr.run("layout.hide", { id: "stage" });
  set("resting");
  host.stageAuto(t + 302000);
  assert.equal(host.stageAuto(t + 400000), null, "already hidden by hand: not the host's");
  set("questing");
  assert.equal(host.stageAuto(t + 401000), null, "and not the host's to show");
  assert.equal(stageNode().hidden, true);
  assert.equal(runs("layout.show").length, 0);
});

test("collapse: turning it on while nothing works hides at once; turning it off shows what it hid", async () => {
  const { host, set } = await collapseRig({ collapse: false });
  set("resting");
  host.stageAuto(M.mockNow());
  assert.equal(runs("layout.hide").length, 0, "off: nothing");
  host.command("setting", { key: "collapse", value: true });
  assert.deepEqual(runs("layout.hide").map((c) => c.args), [{ id: "stage" }], "on while idle: at once");
  host.command("setting", { key: "collapse", value: false });
  assert.deepEqual(runs("layout.show").map((c) => c.args), [{ id: "stage" }], "off: the stage it hid comes back");
  assert.equal(host.world.state.herd.cfg.collapsed, false);
});

test("collapse: after a restart with the stage still hidden, the first work shows it again", async () => {
  const text = saveWith("mid", (w) => Object.assign(w.state.herd.cfg, { collapse: true, collapsed: true }));
  M.resetState();
  const layout = JSON.parse(JSON.stringify(FX.demoFixture("mid").layout));
  (function hide(n) { if (n.id === "stage") n.hidden = true; for (const k of n.children ?? []) hide(k); })(layout);
  const party = await mount({ role: "party" }, { graph: `rs-${++graphN}`, fixture: { ...FX.demoFixture("mid"), layout }, files: { [SAVE]: text } });
  const host = await hostOf(party);
  await M.tickAll(1000); // the mid herd has working heroes
  assert.deepEqual(runs("layout.show").map((c) => c.args), [{ id: "stage" }]);
  assert.equal(stageNode().hidden, false);
  assert.equal(host.world.state.herd.cfg.collapsed, false);
});

test("collapse never acts while checking(), for a read-only world, or in a layout without the stage", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("mid"), checking: true });
  const host = await hostOf(mod);
  host.world.state.herd.cfg.collapse = true;
  assert.equal(host.stageAuto(NOW), null);
  const r = await collapseRig();
  r.host.world.rt.readOnly = true;
  r.set("resting");
  r.host.stageAuto(M.mockNow());
  assert.equal(r.host.stageAuto(M.mockNow() + 120000), null);
  r.host.world.rt.readOnly = false;
  M.updateFixture({ layout: { id: "root", type: "row", children: [] } });
  r.host.stageAuto(M.mockNow() + 121000);
  assert.equal(r.host.stageAuto(M.mockNow() + 300000), null);
  assert.equal(runs("layout.hide").length, 0);
});
