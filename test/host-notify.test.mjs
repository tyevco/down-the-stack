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
  // the time zone known (as after a tick), so the milestone is queued rather than held for it
  // (world.js raiseMilestone) and only the checking() guard can keep takeMilestones from taking it
  host.world.rt.tzOffsetMin = 0;
  const { raiseMilestone } = await mod.import("./game/world.js");
  assert.equal(raiseMilestone(host.world, "boss", { title: "x", body: "" }), true);
  assert.equal(host.world.state.herd.milestones.length, 1, "queued in the world");
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

test("hot reload over a save.json another program left as garbage: the world goes on, so its kill is never posted twice", async () => {
  // Before: the new build rolled back to save.bak, where the boss was still alive, and its second
  // kill posted the same "herd-first" toast again.
  M.resetState();
  const g = `ng-${++graphN}`;
  const a = await mount({ role: "party" }, { graph: g, fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", notifyOn) } });
  const h1 = await hostOf(a);
  await M.tickAll(31000);
  await M.tickAll(31000); // save.bak now holds a save without the kill
  const i = killNextBoss(h1);
  await M.tickAll(3000);
  assert.equal(notes().length, 1);
  await M.tickAll(10000);
  M.memfs.write(SAVE, '{"v":1,"herd":{"name":"half-written');
  await M.reloadAll([a]);
  const h2 = await hostOf(a);
  await M.tickAll(1000);
  assert.equal(h2.stats.loadedFrom, "reload");
  assert.equal(h2.world.state.herd.bossKills[i], 1, "the kill is in the world that goes on");
  await M.tickAll(10000);
  assert.equal(notes().length, 1);
  assert.deepEqual(a.errors, []);
});

test("a milestone whose save hit a plain IO error (the file unchanged) is posted after the next save lands", async () => {
  M.resetState();
  const mod = await mount({ role: "party" }, { fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", notifyOn) } });
  const host = await hostOf(mod);
  await M.tickAll(1000);
  const real = M.memfs.write.bind(M.memfs);
  let failOnce = 1;
  M.memfs.write = (p, ...rest) => {
    if (p === SAVE && failOnce-- > 0) throw new Error("ENOSPC: no space left on device");
    return real(p, ...rest);
  };
  try {
    killNextBoss(host);
    await M.tickAll(1000);
    await M.tickAll(2000);
    assert.ok(failOnce <= 0, "the write failed once");
    assert.equal(host.failedWrites, 1, "a plain IO failure (conflict() answered io)");
    assert.deepEqual(notes(), [], "not posted while no save holding it is on disk");
    await M.tickAll(40000); // the 30 s beat
    assert.equal(notes().length, 1, "posted once a save that took it landed");
    assert.match(notes()[0].n.title, /: FIXED$/);
    await M.tickAll(35000);
    assert.equal(notes().length, 1);
  } finally {
    M.memfs.write = real;
  }
  assert.deepEqual(mod.errors, []);
});

test("post(): the same milestone is never posted twice, and one dated ahead of the clock is never posted", async () => {
  M.resetState();
  const mod = await mount({ role: "party" }, { fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", notifyOn) } });
  const host = await hostOf(mod);
  await M.tickAll(1000);
  const m = { n: 7, kind: "boss", at: Date.now(), title: "Twice: FIXED", body: "" };
  assert.equal(host.post([{ m, world: host.world }]), 1);
  assert.equal(host.post([{ m: { ...m }, world: host.world }]), 0, "postedKeys: never the same one twice");
  assert.equal(notes().length, 1);
  // a save made on a machine whose clock ran ahead: its queued milestone is not a fresh one
  host.world.state.herd.milestones.push({ n: 8, kind: "lts", at: Date.now() + 3 * 3600000, title: "Ahead", body: "" });
  host.world.state.herd.milestones.push({ n: 9, kind: "lts", at: Date.now() - 20 * MIN, title: "Stale", body: "" });
  await M.tickAll(5000);
  assert.deepEqual(notes().map((c) => c.n.title), ["Twice: FIXED"]);
  assert.deepEqual(host.world.state.herd.milestones, [], "both taken out of the queue");
});

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

/** Every agent of the live fixture stops (herdr says idle, seq moves on), sub-agents gone. */
const allIdle = (fx) => ({ ...fx, agents: fx.agents.map((a) => ({ ...a, status: "idle", seq: (a.seq || 0) + 1 })), terminals: (fx.terminals || []).filter((t) => !t.parent).map((t) => ({ ...t, status: "idle" })) });

for (const how of ["restart", "hot reload"]) {
  test(`collapse: a ${how} inside the minute goes on with the countdown (from when the last hero stopped)`, async () => {
    M.resetState();
    const g = `cd-${++graphN}`;
    const party = await mount({ role: "party" }, { graph: g, fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", (w) => { w.state.herd.cfg.collapse = true; }) } });
    const stage = await mount({ role: "stage" }, { graph: g, fixture: null });
    const host = await hostOf(party);
    await M.tickAll(2000);
    M.updateFixture(allIdle(M.fixture()));
    await M.tickAll(1000);
    const stopped = host.idleSince;
    assert.ok(stopped != null, "armed: the last hero stopped");
    await M.tickAll(20000);
    assert.equal(runs("layout.hide").length, 0);
    let h2;
    if (how === "restart") {
      await party.close();
      await stage.close();
      assert.equal(JSON.parse(M.memfs.readText(SAVE)).herd.cfg.idle, stopped, "the countdown's start is saved");
      const g2 = `cd-${++graphN}`;
      const p2 = await mount({ role: "party" }, { graph: g2, fixture: null });
      await mount({ role: "stage" }, { graph: g2, fixture: null });
      h2 = await hostOf(p2);
    } else {
      await M.reloadAll([party, stage]);
      h2 = await hostOf(party);
    }
    assert.notEqual(h2, host);
    await M.tickAll(Math.max(0, stopped + 64000 - M.mockNow()));
    assert.deepEqual(runs("layout.hide").map((c) => c.args), [{ id: "stage" }], "a minute after the last hero stopped, not a minute after the start");
    assert.equal(h2.world.state.herd.cfg.collapsed, true);
    assert.equal(h2.world.state.herd.cfg.idleAt, undefined, "the countdown is done");
  });
}

test("collapse: a restart long after the countdown started still gives the new session a few seconds before it hides", async () => {
  // herdr was closed inside the minute and opened again five minutes later: the countdown is over,
  // but herdr may not have reported the agents' work yet right after a start (RESUME_IDLE_MS).
  M.resetState();
  const g = `cl-${++graphN}`;
  const party = await mount({ role: "party" }, { graph: g, fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", (w) => { w.state.herd.cfg.collapse = true; }) } });
  const stage = await mount({ role: "stage" }, { graph: g, fixture: null });
  const host = await hostOf(party);
  await M.tickAll(2000);
  M.updateFixture(allIdle(M.fixture()));
  await M.tickAll(1000);
  assert.ok(host.idleSince != null, "armed: the last hero stopped");
  await M.tickAll(20000);
  await party.close();
  await stage.close();
  assert.ok(Number.isFinite(JSON.parse(M.memfs.readText(SAVE)).herd.cfg.idle), "the countdown's start is saved");
  await M.tickAll(5 * MIN); // herdr closed
  const g2 = `cl-${++graphN}`;
  const p2 = await mount({ role: "party" }, { graph: g2, fixture: null });
  await mount({ role: "stage" }, { graph: g2, fixture: null });
  const h2 = await hostOf(p2);
  await M.tickAll(8000);
  assert.ok(h2.idleSince != null, "it goes on with the saved countdown");
  assert.equal(runs("layout.hide").length, 0, "not in the first seconds of the new session");
  await M.tickAll(6000);
  assert.deepEqual(runs("layout.hide").map((c) => c.args), [{ id: "stage" }], "then it hides");
  assert.deepEqual(p2.errors, []);
});

test("collapse: a start while nothing works never starts a countdown of its own (a stage shown by hand stays)", async () => {
  M.resetState();
  const fx = allIdle(FX.demoFixture("mid"));
  const g = `cs-${++graphN}`;
  const party = await mount({ role: "party" }, { graph: g, fixture: fx, files: { [SAVE]: saveWith("mid", (w) => { w.state.herd.cfg.collapse = true; }) } });
  await mount({ role: "stage" }, { graph: g, fixture: null });
  const host = await hostOf(party);
  await M.tickAll(5 * MIN);
  assert.equal(host.idleSince, null);
  assert.equal(runs("layout.hide").length, 0, "no saved countdown: nothing to go on with");
});

test("collapse: turned on in a save another window wrote, while nothing works here, hides at once", async () => {
  M.resetState();
  const g = `ow-${++graphN}`;
  const party = await mount({ role: "party" }, { graph: g, fixture: allIdle(FX.demoFixture("mid")), files: { [SAVE]: saveWith("mid", () => {}) } });
  await mount({ role: "stage" }, { graph: g, fixture: null });
  const host = await hostOf(party);
  await M.tickAll(5000);
  assert.equal(host.world.state.herd.cfg.collapse, false);
  assert.equal(runs("layout.hide").length, 0, "collapse is off");
  // another window turned collapse on and saved; our next write conflicts and loads theirs
  M.memfs.write(SAVE, saveWith("mid", (w) => { w.state.herd.cfg.collapse = true; }), { mkdirs: true });
  host.world.rt.dirty = true;
  host.saveSoonAt = M.mockNow();
  await M.tickAll(3000);
  assert.equal(host.stats.reloads, 1, "their save was loaded");
  await M.tickAll(2000);
  assert.deepEqual(runs("layout.hide").map((c) => c.args), [{ id: "stage" }], "as when turned on here");
});

test("collapse: the note that the host hid the stage is saved within seconds (a crash must not lose it)", async () => {
  const { host, set } = await collapseRig();
  const t = M.mockNow();
  host.stageAuto(t);
  set("resting");
  host.stageAuto(t + 1000);
  host.saveSoonAt = null;
  assert.equal(host.stageAuto(t + 62000), "hidden");
  assert.ok(host.saveSoonAt != null && host.saveSoonAt <= Date.now() + 2000, `saveSoonAt ${host.saveSoonAt}`);
  assert.equal(host.world.rt.dirty, true);
});

test("collapse: a layout.hide herdr refuses is not recorded as a stage the host hid", async () => {
  const { host, party, set } = await collapseRig();
  let refuse = true;
  M.updateFixture({ runError: (name) => (refuse && name === "layout.hide" ? new Error("no such node") : null) });
  const t = M.mockNow();
  host.stageAuto(t);
  set("resting");
  host.stageAuto(t + 1000);
  assert.equal(host.stageAuto(t + 62000), null);
  assert.equal(host.world.state.herd.cfg.collapsed, false, "nothing is owed a layout.show");
  assert.ok(host.errors.some((e) => /layout\.hide/.test(e.where)), JSON.stringify(host.errors));
  refuse = false;
  set("questing");
  host.stageAuto(t + 63000);
  set("resting");
  host.stageAuto(t + 64000);
  assert.equal(host.stageAuto(t + 125000), "hidden", "the next stop of work hides it");
  assert.deepEqual(party.errors, []);
});

test("collapse, two windows on one save: a window that hid its stage shows it again although the other cleared the saved note", async () => {
  const { host, set } = await collapseRig();
  const t = M.mockNow();
  host.stageAuto(t);
  set("resting");
  host.stageAuto(t + 1000);
  assert.equal(host.stageAuto(t + 62000), "hidden");
  assert.equal(stageNode().hidden, true);
  // the other window (its own stage shown) saved a world whose note says nothing is held; this
  // window's next write conflicts and loads it
  M.memfs.write(SAVE, saveWith("mid", (w) => Object.assign(w.state.herd.cfg, { collapse: true, collapsed: false })), { mkdirs: true });
  host.world.rt.dirty = true;
  await host.maybeSave(true);
  assert.equal(host.stats.reloads, 1, "their save was loaded");
  assert.equal(host.world.state.herd.cfg.collapsed, false);
  // a hero works again here (the next pump ticks the loaded world from herdr's live data)
  assert.equal(host.pump(M.mockNow() + 5000), true);
  assert.deepEqual(runs("layout.show").map((c) => c.args), [{ id: "stage" }], "this window's stage comes back");
  assert.equal(stageNode().hidden, false);
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

// ---------------------------------------------------------------------------------------------
// the Stage strip switch (owner decision, round 4): host.stageStrip / stageInfo, <mod>.stage

test("Stage strip: shows a stage the collapse hid and takes it from the collapse; it hides again only after work next stops", async () => {
  const { host, party, set } = await collapseRig();
  const t = M.mockNow();
  host.stageAuto(t);
  set("resting");
  host.stageAuto(t + 1000);
  assert.equal(host.stageAuto(t + 62000), "hidden");
  assert.deepEqual(host.stageInfo(), { id: "stage", hidden: true, held: true });
  M.calls().run.length = 0;
  const r = host.stageStrip(true, "stage");
  assert.equal(r.ok, true);
  assert.equal(r.hidden, false);
  assert.match(r.msg, /hides it again a minute after work next stops/);
  assert.deepEqual(runs("layout.show").map((c) => c.args), [{ id: "stage" }]);
  assert.equal(stageNode().hidden, false);
  assert.equal(host.world.state.herd.cfg.collapsed, false, "nothing owed: the stage is the person's");
  assert.deepEqual(host.stageInfo(), { id: "stage", hidden: false, held: false });
  // nothing works still: not hidden again
  assert.equal(host.stageAuto(t + 63000), null);
  assert.equal(host.stageAuto(t + 300000), null);
  assert.equal(runs("layout.hide").length, 0);
  // the next stop of work
  set("questing");
  host.stageAuto(t + 301000);
  set("resting");
  host.stageAuto(t + 302000);
  assert.equal(host.stageAuto(t + 363000), "hidden");
  assert.deepEqual(party.errors, []);
});

test("Stage strip: hidden here, the collapse never shows it, even one the collapse had hidden", async () => {
  const { host, set } = await collapseRig();
  const t = M.mockNow();
  // hidden by the switch while heroes work
  const r = host.stageStrip(false);
  assert.equal(r.ok, true);
  assert.equal(r.hidden, true);
  assert.equal(r.msg, undefined, "the panel's own words");
  assert.deepEqual(runs("layout.hide").map((c) => c.args), [{ id: "stage" }]);
  set("resting");
  host.stageAuto(t + 1000);
  assert.equal(host.stageAuto(t + 62000), null, "already hidden: not the collapse's");
  set("questing");
  assert.equal(host.stageAuto(t + 63000), null);
  assert.equal(stageNode().hidden, true);
  assert.equal(runs("layout.show").length, 0);
  // the collapse hides it; the person says hide (.stage:hide) while it is hidden: no command, the hold goes
  host.stageStrip(true);
  set("resting");
  host.stageAuto(t + 64000);
  assert.equal(host.stageAuto(t + 125000), "hidden");
  assert.equal(host.world.state.herd.cfg.collapsed, true);
  M.calls().run.length = 0;
  assert.equal(host.stageStrip(false).ok, true);
  assert.equal(M.calls().run.length, 0, "already hidden");
  assert.equal(host.world.state.herd.cfg.collapsed, false);
  set("questing");
  assert.equal(host.stageAuto(t + 126000), null, "kept hidden: the person asked");
  assert.equal(stageNode().hidden, true);
});

test("Stage strip: shown while a countdown runs (the stage hidden by hand), the countdown is called off", async () => {
  const { host, set } = await collapseRig();
  const t = M.mockNow();
  host.stageAuto(t);
  herdr.run("layout.hide", { id: "stage" }); // by hand (ctrl-shift-g)
  set("resting");
  host.stageAuto(t + 1000);
  assert.ok(host.idleSince != null, "armed: the last hero stopped");
  assert.equal(host.stageStrip(true).ok, true);
  assert.equal(host.idleSince, null);
  assert.equal(host.world.state.herd.cfg.idleAt, undefined, "the saved countdown goes too");
  assert.equal(host.stageAuto(t + 62000), null, "not hidden a few seconds after the person showed it");
  assert.equal(stageNode().hidden, false);
});

test("Stage strip: the stage is found by content (any id); refused without a stage, while checking() or loading; stageInfo answers the asked state until layout() has it", async () => {
  const { host } = await collapseRig({ collapse: false });
  const layout = JSON.parse(JSON.stringify(M.fixture().layout));
  (function rename(n) { if (n.id === "stage") n.id = "dungeon"; for (const k of n.children ?? []) rename(k); })(layout);
  M.updateFixture({ layout });
  M.calls().run.length = 0;
  assert.deepEqual(host.stageInfo(), { id: "dungeon", hidden: false, held: false });
  assert.equal(host.stageStrip(undefined).hidden, true, "no show: a toggle");
  assert.deepEqual(M.calls().run.map((c) => [c.name, c.args]), [["layout.hide", { id: "dungeon" }]]);
  // herdr runs a mod's command after the callback: layout() may still show the old state
  const after = M.fixture().layout;
  M.updateFixture({ layout });
  assert.equal(host.stageInfo().hidden, true, "the state asked for, while layout() catches up");
  assert.equal(host.stageStrip().hidden, false, "a second toggle goes from the asked state");
  M.updateFixture({ layout: after });
  M.setClock(M.mockNow() + 2500);
  assert.equal(host.stageInfo().hidden, true, "then layout() again");
  // a refused command is not recorded
  M.updateFixture({ runError: (name) => (name === "layout.show" ? new Error("no node") : null) });
  const no = host.stageStrip(true);
  assert.equal(no.ok, false);
  assert.match(no.error, /refused/);
  M.updateFixture({ runError: null });
  // no stage in this layout
  M.updateFixture({ layout: { id: "root", type: "row", children: [] } });
  M.calls().run.length = 0;
  assert.equal(host.stageInfo(), null);
  assert.deepEqual(host.stageStrip(true), { ok: false, error: "This layout has no stage" });
  assert.equal(M.calls().run.length, 0);
  // checking(): never
  M.resetState();
  const chk = await mount({ role: "stage" }, { fixture: FX.demoFixture("mid"), checking: true });
  const hc = await hostOf(chk);
  assert.equal(hc.stageInfo(), null);
  assert.equal(hc.stageStrip(false).ok, false);
  assert.equal(M.calls().run.length, 0);
  // still loading: the collapse's saved note is not known yet
  M.resetState();
  let hold = true;
  const slow = await mount({ role: "party" }, { graph: `ld-${++graphN}`, fixture: { ...FX.demoFixture("mid"), readError: () => (hold ? new Error("busy") : null) } });
  const hl = await hostOf(slow);
  assert.equal(hl.ready, false);
  assert.deepEqual(hl.stageStrip(false), { ok: false, error: "Still loading the save" });
  assert.equal(runs("layout.hide").length, 0);
  hold = false;
});

test("Stage strip right after a restart (before the first pump): the collapse's saved hold is known, so showing the stage says it hides again", async () => {
  const text = saveWith("mid", (w) => Object.assign(w.state.herd.cfg, { collapse: true, collapsed: true }));
  M.resetState();
  const layout = JSON.parse(JSON.stringify(FX.demoFixture("mid").layout));
  (function hide(n) { if (n.id === "stage") n.hidden = true; for (const k of n.children ?? []) hide(k); })(layout);
  const party = await mount({ role: "party" }, { graph: `sr-${++graphN}`, fixture: { ...FX.demoFixture("mid"), layout }, files: { [SAVE]: text } });
  const host = await hostOf(party);
  assert.equal(host.ready, true);
  assert.equal(host.hidStage, null, "no stageAuto yet");
  assert.deepEqual(host.stageInfo(), { id: "stage", hidden: true, held: true }, "held: from the saved herd.cfg.collapsed");
  const r = host.stageStrip(true);
  assert.equal(r.ok, true);
  assert.match(r.msg ?? "", /hides it again a minute after work next stops/);
  assert.equal(host.world.state.herd.cfg.collapsed, false);
  assert.deepEqual(host.stageInfo(), { id: "stage", hidden: false, held: false });
  assert.deepEqual(party.errors, []);
});

test("Stage strip as a command: down-the-stack.stage toggles, .stage:show / .stage:hide set it, handled once by the copies that get it", async () => {
  const { host, party } = await collapseRig({ collapse: false });
  M.calls().run.length = 0;
  await M.sendCommand("stage");
  assert.deepEqual(M.calls().run.filter((c) => c.name.startsWith("layout.")).map((c) => [c.name, c.args]), [["layout.hide", { id: "stage" }]], "one copy acts (claim)");
  assert.equal(stageNode().hidden, true);
  await M.tickAll(400);
  await M.sendCommand("stage:hide");
  assert.equal(runs("layout.hide").length, 1, "already hidden");
  await M.tickAll(400);
  await M.sendCommand("stage:show");
  assert.deepEqual(runs("layout.show").map((c) => c.args), [{ id: "stage" }]);
  assert.equal(stageNode().hidden, false);
  // keys.json's `name:value` reaches the mod as "stage:hide" (herdr window.rs run_as)
  await M.tickAll(400);
  herdr.run("down-the-stack.stage:hide");
  await M.flush();
  assert.equal(stageNode().hidden, true);
  assert.equal(host.hotkey("stage"), "shown");
  // a command named like an Object.prototype member is no hotkey (it goes to the role)
  await M.sendCommand("constructor");
  assert.deepEqual(party.errors, []);
});

test("a command gives the engine the local time zone, so a milestone a click raises before the first tick counts at once", async () => {
  M.resetState();
  const mod = await mount({ role: "party" }, { fixture: FX.demoFixture("mid"), files: { [SAVE]: saveWith("mid", notifyOn) } });
  const host = await hostOf(mod);
  await M.tickAll(1000);
  host.world.rt.tzOffsetMin = undefined; // as right after a load, before its first tick
  assert.equal(host.command("setting", { key: "glow", value: 3 }).ok, true);
  assert.equal(host.world.rt.tzOffsetMin, new Date(Date.now()).getTimezoneOffset());
  const { raiseMilestone } = await mod.import("./game/world.js");
  raiseMilestone(host.world, "boss", { title: "x", body: "" });
  assert.equal(host.world.state.herd.milestones.length, 1, "queued, not held for the time zone");
  assert.deepEqual(host.world.rt.msHeld || [], []);
  assert.deepEqual(mod.errors, []);
});
