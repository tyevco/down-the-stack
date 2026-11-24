// GameHost (mods/mapledr/host.js) through the mock herdr runtime: one shared world per module
// graph, the 900 ms pump gate, the snapshot from herdr's live data, the save policy (expected
// text, save.bak, conflicts), corrupt and newer-version saves, checking() without IO, hot reload
// resuming from the save, the view memo, and the dialog registry.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const M = await import("../tools/mock/index.mjs");
const FX = await import("../tools/fixtures.mjs");
const { demoWorld } = await import("../mods/mapledr/game/demo.js");
const { serialize, createWorld } = await import("../mods/mapledr/game/world.js");
const { crc32 } = await import("../mods/mapledr/game/save.js");

const MAIN = path.join(M.REPO, "mods", "mapledr", "main.js");
const NOW = FX.NOW;
const DIR = `${M.APP_HOME}/data/mapledr`;
const SAVE = `${DIR}/save.json`;
const BAK = `${DIR}/save.bak`;
const BROKEN = `${DIR}/save.broken`;

let graphN = 0;
/** Mount one copy on a fresh module graph (or `graph`), with live data and seeded files. */
async function mount(props, { graph, fixture, files, checking } = {}) {
  const g = graph ?? `host-${++graphN}`;
  const fx = fixture === null ? undefined : { ...(fixture ?? {}), ...(files ? { files } : {}) };
  const mod = await M.mountMod(MAIN, { props, graph: g, fixture: fx, nowMs: fx ? NOW : undefined, checking });
  return mod;
}
const hostOf = async (mod) => (await mod.import("./host.js")).getHost();
const writes = (p) => M.calls().writeTextFile.filter((c) => c.path === p);
const reads = () => M.calls().readTextFile;

/** A valid save text of a demo world (its heroes have ids 1..n). */
function saveOf(kind, nowMs = NOW - 60000) {
  return serialize(demoWorld(kind, nowMs).world);
}
/** The same save, claiming a newer schema version (valid CRC). */
function newerSave(text) {
  const bumped = text.replace(/^\{"v":1,/, '{"v":99,').replace(/"crc":"[0-9a-f]*"/, '"crc":""');
  return bumped.replace('"crc":""', `"crc":"${crc32(bumped)}"`);
}

test("copies on one module graph share one host and one world; another graph has its own", async () => {
  M.resetState();
  const a = await mount({ role: "stage" }, { graph: "share", fixture: FX.demoFixture("first-day") });
  const b = await mount({ role: "party" }, { graph: "share", fixture: null });
  const c = await mount({ role: "hud" }, { graph: "other", fixture: null });
  const ha = await hostOf(a);
  assert.equal(a.view.host, ha);
  assert.equal(b.view.host, ha);
  assert.notEqual(c.view.host, ha);
  assert.equal(ha.loaded, true);
  assert.ok(ha.ready);
  // one load per host, however many copies
  assert.equal(reads().filter((r) => r.path === SAVE).length, 2);
  await M.tickAll(1000);
  assert.equal(ha.world.state.heroes.length, 3, "the first pump bound the three agents");
  assert.equal(a.view.host.world, b.view.host.world);
  assert.equal(c.view.host.world.state.heroes.length, 3, "the other graph's world pumped too");
  assert.notEqual(c.view.host.world, ha.world);
  for (const m of [a, b, c]) assert.deepEqual(m.errors, []);
});

test("pump: at most once per 900 ms, snapshot from herdr's live data, version and broadcast", async () => {
  M.resetState();
  const fx = FX.demoFixture("mid");
  const mod = await mount({ role: "hud" }, { fixture: fx });
  const host = await hostOf(mod);
  const runs = () => M.calls().run.filter((r) => r.name === "mapledr.tick").length;
  const v0 = host.version;
  const r0 = runs();
  assert.equal(host.pump(NOW + 1000), true);
  assert.equal(host.version, v0 + 1);
  assert.equal(runs(), r0 + 1);
  assert.equal(host.pump(NOW + 1500), false, "gated");
  assert.equal(host.pump(NOW + 1899), false, "gated");
  assert.equal(host.stats.pumps, 1);
  assert.equal(host.pump(NOW + 1900), true);
  assert.equal(host.stats.pumps, 2);
  assert.equal(host.pump(NOW + 1900), false, "gated");

  const snap = host.snapshot(NOW + 5000);
  assert.equal(snap.nowMs, NOW + 5000);
  assert.deepEqual(snap.agents.map((a) => a.address), ["t1", "t2", "t3", "t4", "t5", "t6"]);
  assert.deepEqual(Object.keys(snap.agents[0]).sort(), ["address", "app", "focused", "pane", "pane_name", "pinned", "program", "seq", "space", "space_name", "status", "tab", "tab_index", "tab_name", "title"].sort());
  assert.deepEqual(snap.subagents.map((s) => [s.address, s.parent, s.status]), [["s5a", "t5", "working"], ["s5b", "t5", "blocked"]]);
  assert.equal(snap.focusedTerminal, "t2");
  assert.equal(snap.windowActive, true);
  assert.deepEqual(snap.spaces.map((s) => s.id), ["spc_1", "spc_2"]);
  assert.ok("tab_1" in snap.tabs);
  assert.equal(snap.tzOffsetMin, new Date(NOW + 5000).getTimezoneOffset());
  assert.equal(snap.weekday, new Date(NOW + 5000).getDay());

  // pane headers and dialogs (stable = false) pump only when no stage/party/hud has lately
  assert.equal(host.pump(NOW + 2900, false), false, "a long-lived copy pumped 1 s ago");
  assert.equal(host.pump(NOW + 4900, false), true, "3 s without one: the fallback pumps");
  assert.equal(host.pump(NOW + 5900, false), true);
  assert.equal(host.pump(NOW + 6900), true);
  assert.equal(host.pump(NOW + 7900, false), false);

  // sub-agent status words from terminals(): error → blocked, done → idle; dead or listed ones skipped
  M.updateFixture({
    terminals: [
      ...fx.terminals,
      { address: "s9", parent: "t1", state: "live", status: "error", name: "lint shard", program: fx.agents[0].program },
      { address: "s10", parent: "t1", state: "live", status: "done", name: "", template: "tests", program: fx.agents[0].program },
      { address: "s11", parent: "t1", state: "dead", status: "working", name: "gone" },
      { address: "t3", parent: "t1", state: "live", status: "working", name: "kept sub-agent with a pane" },
    ],
    window: { platform: "linux", titlebar: "none", buttons: true, maximized: false, fullscreen: false, active: false, visible: true },
  });
  const s2 = host.snapshot(NOW + 6000);
  const subs = Object.fromEntries(s2.subagents.map((s) => [s.address, s]));
  assert.equal(subs.s9.status, "blocked");
  assert.equal(subs.s10.status, "idle");
  assert.equal(subs.s10.title, "tests");
  assert.equal(subs.s11, undefined);
  assert.equal(subs.t3, undefined, "an agent listed in agents() is not also a sub-agent");
  assert.equal(s2.windowActive, false);

  // a hidden window: the world still advances, but no redraw fan-out
  M.updateFixture({ window: { platform: "linux", titlebar: "none", buttons: true, maximized: false, fullscreen: false, active: false, visible: false } });
  const before = runs();
  assert.equal(host.pump(NOW + 9000), true);
  assert.equal(runs(), before);
  assert.deepEqual(mod.errors, []);
});

test("view(): null while loading, memoised per version (nowMs ignored), a throwing view is recorded", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: FX.demoFixture("mid") });
  const host = await hostOf(mod);
  host.world = (await mod.import("./game/demo.js")).demoWorld("mid", NOW).world;
  host.version++;
  const a = host.view("stage", { width: 960, height: 200, nowMs: NOW });
  const b = host.view("stage", { width: 960, height: 200, nowMs: NOW + 7 });
  assert.ok(a && Array.isArray(a.heroes));
  assert.equal(a, b, "one build per version serves every copy");
  assert.notEqual(host.view("stage", { width: 1200, height: 200, nowMs: NOW }), a, "other args, other build");
  host.version++;
  assert.notEqual(host.view("stage", { width: 960, height: 200, nowMs: NOW }), a, "a new version rebuilds");
  assert.equal(host.view("nope", {}), null);
  // a view that throws: null, counted once, surfaced once
  const n0 = host.errorCount;
  assert.equal(host.view("sheet", { heroId: 1, tab: "gear", filter: { get slot() { throw new Error("bad filter"); } } }), null);
  assert.equal(host.errorCount, n0 + 1);
  assert.ok(host.takeUnreported().some((e) => /view sheet/.test(e.where)));
  assert.deepEqual(host.takeUnreported(), []);
  // loading: no world to show
  host.placeholder = host.world;
  host.loaded = false;
  assert.equal(host.ready, false);
  assert.equal(host.view("hud", {}), null);
  assert.deepEqual(host.command("setting", { key: "calm", value: true }), { ok: false, error: "Still loading the save" });
});

test("command(): world.command at Date.now(), version++, dirty, broadcast to every copy", async () => {
  M.resetState();
  const a = await mount({ role: "stage" }, { graph: "cmd", fixture: FX.demoFixture("mid") });
  const b = await mount({ role: "hud" }, { graph: "cmd", fixture: null });
  const host = await hostOf(a);
  host.world = (await a.import("./game/demo.js")).demoWorld("mid", NOW).world;
  host.version++;
  a.render();
  b.render();
  assert.equal(a.dirty, false);
  const v = host.version;
  const r = host.command("setting", { key: "nums", value: "crits" });
  assert.equal(r.ok, true);
  assert.equal(host.world.state.herd.cfg.nums, "crits");
  assert.equal(host.version, v + 1);
  assert.equal(host.world.rt.dirty, true);
  await M.flush();
  assert.ok(a.dirty && b.dirty, "the broadcast reached both copies' nextCommand loops");
  const bad = host.command("setting", { key: "nums", value: "loud" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /nums/);
});

test("save: first create (expected null), then save.bak gets the previous text, save.json replaces it (expected = last text)", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("first-day") });
  const host = await hostOf(mod);
  assert.equal(host.stats.loadedFrom, "new");
  await M.tickAll(31000);
  let saves = writes(SAVE);
  assert.ok(saves.length >= 1, "saved within 30 s");
  assert.equal(saves[0].expected, null, "the first save creates the file");
  assert.equal(M.memfs.readText(SAVE), saves[saves.length - 1].text);
  assert.equal(host.lastText, M.memfs.readText(SAVE));
  await M.tickAll(31000);
  saves = writes(SAVE);
  assert.ok(saves.length >= 2);
  for (let i = 1; i < saves.length; i++) assert.equal(saves[i].expected, saves[i - 1].text, "expected = the exact text last written");
  const baks = writes(BAK);
  assert.ok(baks.length >= 1);
  assert.equal(baks[0].expected, null);
  assert.equal(baks[0].text, saves[0].text, "save.bak holds the previous save");
  assert.equal(M.memfs.readText(BAK), saves[saves.length - 2].text);
  // nothing is written more often than the policy allows (30 s, or 2 s after a major event)
  assert.ok(saves.length <= 8, `${saves.length} saves in 62 s`);
  assert.equal(host.world.rt.dirty, true, "ticks since the last save");
  // the last copy closing flushes
  const n = writes(SAVE).length;
  await mod.close();
  assert.equal(writes(SAVE).length, n + 1);
  assert.equal(M.memfs.readText(SAVE), host.lastText);
  assert.deepEqual(mod.errors, []);
});

test("save: a UI command is saved about 2 s later; nothing is written when nothing changed", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: {}, files: { [SAVE]: saveOf("idle") } });
  const host = await hostOf(mod);
  assert.equal(host.stats.loadedFrom, "save");
  host.command("setting", { key: "calm", value: true });
  await M.tickAll(1000);
  assert.equal(writes(SAVE).length, 0);
  await M.tickAll(2000);
  assert.equal(writes(SAVE).length, 1);
  assert.equal(JSON.parse(M.memfs.readText(SAVE)).herd !== undefined, true);
  assert.equal(writes(BAK).length, 1, "the loaded save became save.bak");
  assert.equal(M.memfs.readText(BAK), saveOf("idle"));
  // forced flush with a clean world: nothing to write
  host.world.rt.dirty = false;
  await host.flush();
  assert.equal(writes(SAVE).length, 1);
});

test("save conflict: another writer replaced save.json → its save is loaded, not clobbered", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("first-day") });
  const host = await hostOf(mod);
  await M.tickAll(31000);
  assert.ok(writes(SAVE).length >= 1);
  const theirs = saveOf("blocked");
  M.memfs.write(SAVE, theirs, { mkdirs: true });
  const before = host.world;
  await M.tickAll(31000);
  assert.notEqual(host.world, before, "reloaded");
  assert.equal(host.stats.reloads, 1);
  assert.equal(host.lastText, theirs);
  assert.equal(host.world.state.heroes.length, 5, "the other writer's herd");
  assert.equal(M.memfs.readText(SAVE), theirs, "their file was not overwritten");
  // and from now on we save over their text with the right expected value
  host.world.rt.dirty = true;
  await host.flush();
  const last = writes(SAVE).at(-1);
  assert.equal(last.expected, theirs);
  assert.equal(M.memfs.readText(SAVE), last.text);
});

test("corrupt save.json → save.bak is loaded, save.broken keeps the bad text, the bak is not overwritten with it", async () => {
  M.resetState();
  const good = saveOf("idle");
  const bad = good.slice(0, 200) + "garbage";
  const mod = await mount({ role: "hud" }, { fixture: {}, files: { [SAVE]: bad, [BAK]: good } });
  const host = await hostOf(mod);
  assert.equal(host.stats.loadedFrom, "bak");
  assert.equal(host.world.state.heroes.length, 4);
  assert.equal(M.memfs.readText(BROKEN), bad);
  assert.ok(host.errors.some((e) => e.where === "load save.json"));
  await M.tickAll(3000);
  const saves = writes(SAVE);
  assert.equal(saves.length, 1, "replaced soon after loading from the bak");
  assert.equal(saves[0].expected, bad, "expected = the corrupt text it replaces");
  assert.equal(writes(BAK).length, 0, "the good bak is not replaced by the corrupt text");
  assert.equal(M.memfs.readText(BAK), good);
  assert.deepEqual(mod.errors, [], "IO trouble is not a script error");
});

test("corrupt save and corrupt bak → a fresh world; save.broken is written once and never overwritten", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: {}, files: { [SAVE]: "{not json", [BAK]: '{"v":1,"herd":{},"crc":"00000000"}' } });
  const host = await hostOf(mod);
  assert.equal(host.stats.loadedFrom, "fresh");
  assert.equal(host.world.state.heroes.length, 0);
  assert.equal(M.memfs.readText(BROKEN), "{not json");
  await M.tickAll(3000);
  assert.equal(writes(SAVE)[0].expected, "{not json");
  assert.equal(writes(BAK).length, 0, "the corrupt text never becomes the bak");
  await M.tickAll(31000);
  assert.equal(M.memfs.readText(BAK), writes(SAVE)[0].text, "the next save backs up the first good one");
  // a second broken load (another session) keeps the first save.broken
  M.memfs.write(SAVE, "{still not json", { mkdirs: true });
  const again = await mount({ role: "hud" }, { fixture: null });
  const h2 = await hostOf(again);
  assert.equal(h2.stats.loadedFrom, "bak", "the first session's good save is the bak now");
  assert.equal(M.memfs.readText(BROKEN), "{not json");
});

test("a save from a newer version loads read-only and is never written", async () => {
  M.resetState();
  const text = newerSave(saveOf("idle"));
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("idle"), files: { [SAVE]: text } });
  const host = await hostOf(mod);
  assert.equal(host.world.rt.readOnly, true);
  assert.equal(host.world.state.heroes.length, 4);
  await M.tickAll(35000);
  const r = host.command("setting", { key: "calm", value: true });
  assert.equal(r.ok, false);
  await M.tickAll(3000);
  await mod.close();
  assert.equal(M.calls().writeTextFile.length, 0, "nothing written: not the save, the bak or a broken copy");
  assert.equal(M.memfs.readText(SAVE), text);
});

test("checking(): an in-memory world, no IO, no timers, no commands", async () => {
  M.resetState({ checking: true });
  const mod = await M.mountMod(MAIN, { checking: true, fixture: M.checkFixture(), graph: `host-${++graphN}` });
  const tree = mod.render();
  assert.ok(tree);
  const host = await hostOf(mod);
  assert.ok(host.ready);
  assert.equal(host.memoryOnly, true);
  await mod.tick(5000);
  host.world.rt.dirty = true;
  await host.flush();
  assert.equal(host.pump(Date.now() + 5000), false);
  await mod.close();
  const c = M.calls();
  assert.equal(c.readTextFile.length, 0);
  assert.equal(c.writeTextFile.length, 0);
  assert.equal(c.run.length, 0);
  assert.equal(c.openOverlay.length, 0);
  assert.deepEqual(mod.errors, []);
  assert.deepEqual(M.globalErrors(), []);
  M.setChecking(false);
});

test("hot reload wipes module state; the new host resumes from the save", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("first-day") });
  const h1 = await hostOf(mod);
  await M.tickAll(31000);
  const saved = M.memfs.readText(SAVE);
  assert.ok(saved);
  const savedTick = JSON.parse(saved).tick;
  assert.ok(savedTick > 0);
  const ids = h1.world.state.heroes.map((h) => [h.id, h.name]);
  await mod.reload();
  const h2 = await hostOf(mod);
  assert.notEqual(h2, h1, "module state is new");
  assert.equal(h2.stats.loadedFrom, "save");
  assert.equal(h2.lastText, saved);
  assert.deepEqual(h2.world.state.heroes.map((h) => [h.id, h.name]), ids);
  assert.equal(h2.world.state.herd.tick, savedTick);
  // and it keeps going: the agents rebind to the same heroes
  await M.tickAll(2000);
  assert.deepEqual([...h2.world.rt.bind.values()].sort(), ids.map((x) => x[0]).sort());
  assert.deepEqual(mod.errors, []);
});

test("a load whose task died is retried by the next copy's timer", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: {}, files: { [SAVE]: saveOf("idle") } });
  const host = await hostOf(mod);
  // pretend the read never came back (the copy that started it closed)
  host.loaded = false;
  host.placeholder = host.world;
  host.loadingSince = Date.now();
  assert.equal(host.ready, false);
  await M.tickAll(5000);
  assert.equal(host.ready, false, "still waiting");
  await M.tickAll(6000);
  assert.equal(host.ready, true, "retried after 10 s");
  assert.equal(host.world.state.heroes.length, 4);
});

test("dialog registry: one sheet and one Herd panel at a time; dialog copies register and unregister", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { graph: "dlg", fixture: FX.demoFixture("mid") });
  const host = await hostOf(mod);
  const id1 = host.openSheet(1);
  assert.equal(host.openSheet(1), id1, "the same hero's sheet is already open: no second dialog");
  const id2 = host.openSheet(2);
  assert.notEqual(id2, id1);
  assert.deepEqual(M.calls().closeOverlay.map((c) => c.id), [id1], "the other hero's sheet replaced it");
  const h1 = host.openHerd();
  assert.equal(host.openHerd(), h1);
  const h2 = host.openHerd("stash");
  assert.notEqual(h2, h1);
  assert.equal(host.toggleHerd(), null);
  assert.equal(host.overlays.herd, null);
  assert.equal(M.calls().openOverlay.length, 4);
  const spec = M.calls().openOverlay[0].spec;
  assert.deepEqual(spec, { mod: "mapledr", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 1 } });

  // a dialog opened straight by a role (openOverlay in a click handler) registers itself
  const dlg = await mount({ role: "herd", overlay: "o77", tab: "roster" }, { graph: "dlg", fixture: null });
  assert.deepEqual(host.overlays.herd, { tab: "roster", id: "o77" });
  const dup = await mount({ role: "herd", overlay: "o78" }, { graph: "dlg", fixture: null });
  assert.equal(host.overlays.herd.id, "o78");
  assert.ok(M.calls().closeOverlay.some((c) => c.id === "o77"), "a second Herd panel closes the first");
  await dup.close();
  assert.equal(host.overlays.herd, null, "closing the dialog unregisters it");
  await dlg.close();
  assert.deepEqual(dlg.errors, []);
});

test("heroForTerminal: bound agents, contractors and Forklings (their parent's hero)", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: FX.demoFixture("mid") });
  const host = await hostOf(mod);
  host.world = (await mod.import("./game/demo.js")).demoWorld("mid", NOW).world;
  host.version++;
  assert.equal(host.heroForTerminal("t2"), 2);
  assert.equal(host.heroForTerminal("s5a"), 5, "a sub-agent opens its parent's sheet");
  assert.equal(host.heroForTerminal("t99"), null);
  assert.equal(host.heroForTerminal(null), null);
});

test("debug text carries host and engine errors; error() counts and dedupes", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: {} });
  const host = await hostOf(mod);
  assert.equal(host.hasErrors(), false);
  host.error("save", new Error("disk full"));
  host.error("save", new Error("disk full"));
  host.world.rt.errors.push("stepRoom: oops");
  assert.equal(host.errorCount, 2);
  assert.equal(host.errors.length, 1);
  assert.equal(host.errors[0].count, 2);
  const t = host.debugText();
  assert.match(t, /disk full \(×2\)/);
  assert.match(t, /engine stepRoom: oops/);
  assert.ok(host.hasErrors());
  assert.deepEqual(host.takeUnreported(), [], "IO errors are not rethrown");
  createWorld; // (imported for completeness of the engine surface used by these tests)
});

test("a save whose host call never came back (its copy closed) is given up after 15 s", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("first-day") });
  const host = await hostOf(mod);
  await M.tickAll(2000);
  host.saving = new Promise(() => {}); // cancelled with its copy: never settles
  host.savingSince = Date.now();
  host.world.rt.dirty = true;
  assert.equal(host.maybeSave(true), host.saving, "still in flight");
  await M.tickAll(16000);
  const n = writes(SAVE).length;
  host.world.rt.dirty = true;
  const p = host.maybeSave(true);
  assert.ok(p && typeof p.then === "function");
  await p;
  assert.equal(writes(SAVE).length, n + 1);
  assert.ok(host.errors.some((e) => /never finished/.test(e.message)));
});

test("a clock that went back holds the world still, but a UI command is still saved ~2 s later", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("first-day") });
  const host = await hostOf(mod);
  await M.tickAll(3000);
  host.world.state.herd.lastMs = Date.now() + 600000; // the herd last ticked 10 minutes "ahead"
  const n = writes(SAVE).length;
  assert.equal(host.command("setting", { key: "calm", value: true }).ok, true);
  await M.tickAll(4000);
  assert.equal(writes(SAVE).length, n + 1);
  assert.equal(JSON.parse(M.memfs.readText(SAVE)).herd !== undefined, true);
  assert.deepEqual(mod.errors, []);
});

test("a save that keeps failing (disk full) after a major event is retried on the 30 s beat, not every second", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("first-day") });
  const host = await hostOf(mod);
  await M.tickAll(31000);
  const real = M.memfs.write.bind(M.memfs);
  M.memfs.write = (p, t, o) => { if (p === SAVE) throw new Error("disk full"); return real(p, t, o); };
  try {
    host.world.rt.majorAt = host.world.rt.nowMs;
    host.world.rt.dirty = true;
    const n = M.calls().writeTextFile.length;
    await M.tickAll(10000);
    assert.ok(M.calls().writeTextFile.length - n <= 2, `${M.calls().writeTextFile.length - n} writes in 10 s`);
    assert.ok(host.errors.some((e) => e.where === "write save.json"));
    assert.equal(host.world.rt.dirty, true, "still to be saved");
  } finally {
    M.memfs.write = real;
  }
  await M.tickAll(31000);
  assert.equal(M.memfs.readText(SAVE), host.lastText, "the disk recovered: the next beat saved");
});

test("pump prewarms the view models the copies used, so the renders after a broadcast hit the memo", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("mid") });
  const host = await hostOf(mod);
  host.world = (await mod.import("./game/demo.js")).demoWorld("mid", NOW).world;
  host.version++;
  mod.size(960, 200);
  mod.render();
  host.view("nameplate", { terminal: "t1", pane: "p_t1" });
  assert.equal(host.pump(NOW + 1000), true);
  const keys = [...host.memo.map.keys()];
  assert.equal(host.memo.hv, host.version, "built for the new version, before any render");
  assert.ok(keys.some((k) => k.startsWith("stage|")), keys.join(", "));
  assert.ok(keys.includes('nameplate|{"terminal":"t1","pane":"p_t1"}'));
  const vm = host.memo.map.get(keys.find((k) => k.startsWith("stage|"))).vm;
  assert.equal(vm.tick, host.world.rt.tick);
  await M.flush();
  mod.render();
  assert.equal(host.memo.map.get(keys.find((k) => k.startsWith("stage|"))).vm, vm, "the render reused it");

  // a splitter drag renders many widths once; only the width still shown is prewarmed after that
  for (let w = 900; w < 916; w++) { mod.size(w, 200); mod.render(); }
  await M.tickAll(1000);
  await M.tickAll(1000);
  await M.tickAll(1000);
  const stageKeys = [...host.memo.map.keys()].filter((k) => k.startsWith("stage|"));
  assert.equal(stageKeys.length, 1, stageKeys.join(", "));
  assert.match(stageKeys[0], /"width":915/);
  assert.deepEqual(mod.errors, []);
});
