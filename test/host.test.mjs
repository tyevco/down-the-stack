// GameHost (mods/down-the-stack/host.js) through the mock herdr runtime: one shared world per module
// graph, the 900 ms pump gate, the snapshot from herdr's live data, the save policy (expected
// text, save.bak, conflicts, our own writes landing unanswered, flush on close), corrupt,
// checksum-only and newer-version saves, unreadable saves, the save status shown to the player,
// checking() without IO, hot reload taking the previous build's world over, the broadcast only
// while a copy is shown, the view memo, the dialog registry, and mod.clone.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const M = await import("../tools/mock/index.mjs");
const FX = await import("../tools/fixtures.mjs");
const { demoWorld } = await import("../mods/down-the-stack/game/demo.js");
const { serialize, createWorld } = await import("../mods/down-the-stack/game/world.js");
const { crc32 } = await import("../mods/down-the-stack/game/save.js");

const MAIN = path.join(M.REPO, "mods", "down-the-stack", "main.js");
const NOW = FX.NOW;
const DIR = `${M.APP_HOME}/data/down-the-stack`;
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
  const runs = () => M.calls().run.filter((r) => r.name === "down-the-stack.tick").length;
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
  assert.deepEqual(Object.keys(snap.agents[0]).sort(), ["address", "app", "focused", "pane", "pane_name", "parent", "pinned", "program", "seq", "space", "space_name", "status", "tab", "tab_index", "tab_name", "title"].sort());
  assert.equal(snap.agents[0].parent, null);
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

/** Every save.broken* file: name → text. */
const names = () => M.memfs.readdir(DIR).map((e) => e[0]);
const brokenFiles = () => Object.fromEntries(names().filter((n) => n.startsWith("save.broken")).map((n) => [n, M.memfs.readText(`${DIR}/${n}`)]));

test("corrupt save and corrupt bak → a fresh world; both texts kept aside, an earlier save.broken never overwritten", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: {}, files: { [SAVE]: "{not json", [BAK]: '{"v":1,"herd":' } });
  const host = await hostOf(mod);
  assert.equal(host.stats.loadedFrom, "fresh");
  assert.equal(host.world.state.heroes.length, 0);
  assert.equal(M.memfs.readText(BROKEN), "{not json");
  // the bad bak is kept too: the second save after this one rotates over save.bak
  assert.deepEqual(Object.values(brokenFiles()).sort(), ["{not json", '{"v":1,"herd":'].sort());
  await M.tickAll(3000);
  assert.equal(writes(SAVE)[0].expected, "{not json");
  assert.equal(writes(BAK).length, 0, "the corrupt text never becomes the bak");
  await M.tickAll(31000);
  assert.equal(M.memfs.readText(BAK), writes(SAVE)[0].text, "the next save backs up the first good one");
  const st = host.saveStatus();
  assert.equal(st.restoredFrom, "fresh");
  assert.match(st.message, /new herd started/);
  // a second broken load (another session) keeps the first save.broken and adds its own
  M.memfs.write(SAVE, "{still not json", { mkdirs: true });
  const again = await mount({ role: "hud" }, { fixture: null });
  const h2 = await hostOf(again);
  assert.equal(h2.stats.loadedFrom, "bak", "the first session's good save is the bak now");
  assert.equal(M.memfs.readText(BROKEN), "{not json");
  assert.ok(Object.values(brokenFiles()).includes("{still not json"), JSON.stringify(Object.keys(brokenFiles())));
  for (const w of M.calls().writeTextFile.filter((c) => c.path.startsWith(BROKEN))) assert.equal(w.expected, null, "kept-aside files are only ever created");
});

// Kept-aside copies are bounded (round 4): one save.broken / save.unsaved per incident would pile up,
// so a kind keeps its first incident and the newest three (-1..-3). herdr's mod API has no listing
// or removal call without exec, and the mod runs no programs: the three rotate by overwriting the
// oldest, each write checked against the text just read.
const keptWrites = (stem) => M.calls().writeTextFile.filter((c) => c.path === stem || c.path.startsWith(`${stem}-`));

test("kept-aside copies: save.broken first, then -1..-3; once full the oldest of the three is dropped; no program runs; other files untouched", async () => {
  M.resetState();
  const good = saveOf("idle");
  const others = { [`${BROKEN}-1700000000000`]: "an earlier build's copy", [`${DIR}/store-1.json`]: "{}" };
  let mod = await mount({ role: "hud" }, { fixture: {}, files: { [SAVE]: "{incident 1", [BAK]: good, ...others } });
  let host = await hostOf(mod);
  assert.equal(host.stats.loadedFrom, "bak");
  assert.equal(M.memfs.readText(BROKEN), "{incident 1");
  const incident = async (k) => {
    M.memfs.write(SAVE, `{incident ${k}`, { mkdirs: true });
    M.setClock(M.mockNow() + 1000);
    mod = await mount({ role: "hud" }, { fixture: null });
    host = await hostOf(mod);
    assert.equal(host.stats.loadedFrom, "bak", `incident ${k}`);
  };
  await incident(2);
  await incident(3);
  await incident(4);
  assert.deepEqual(brokenFiles(), {
    "save.broken": "{incident 1", "save.broken-1": "{incident 2", "save.broken-2": "{incident 3", "save.broken-3": "{incident 4",
    "save.broken-1700000000000": "an earlier build's copy",
  });
  for (const w of keptWrites(BROKEN)) assert.equal(w.expected, null, `${w.path}: created while there is room`);
  await incident(5);
  await incident(6);
  assert.deepEqual(brokenFiles(), {
    "save.broken": "{incident 1", "save.broken-1": "{incident 4", "save.broken-2": "{incident 5", "save.broken-3": "{incident 6",
    "save.broken-1700000000000": "an earlier build's copy",
  }, "the first incident and the newest three");
  assert.match(host.saveStatus().message, /kept as save\.broken-3\./, "the notice names the file the text went to");
  // every overwrite expected the text it read: nothing another session wrote meanwhile is lost
  for (const w of keptWrites(BROKEN).filter((c) => c.expected !== null)) assert.match(w.expected, /^\{incident [2-5]$/, w.path);
  assert.equal(M.memfs.readText(`${DIR}/store-1.json`), "{}");
  assert.equal(M.calls().exec.length, 0, "no program runs");
  // a text already kept (under any of the four names) is not written again
  const before = keptWrites(BROKEN).length;
  M.memfs.write(SAVE, "{incident 5", { mkdirs: true });
  mod = await mount({ role: "hud" }, { fixture: null });
  host = await hostOf(mod);
  assert.equal(keptWrites(BROKEN).length, before);
  assert.match(host.saveStatus().message, /kept as save\.broken-2\./);
  assert.deepEqual(mod.errors, []);
});

test("kept-aside copies: save.unsaved rotates the same way; a copy that cannot be read is never written over; nothing while checking()", async () => {
  M.resetState();
  const UNSAVED = `${DIR}/save.unsaved`;
  const unreadable = new Set([`${UNSAVED}-2`]);
  const files = { [SAVE]: saveOf("idle"), [UNSAVED]: "first", [`${UNSAVED}-1`]: "u1", [`${UNSAVED}-2`]: "u2 (unreadable)" };
  let mod = await mount({ role: "hud" }, { fixture: { readError: (p) => (unreadable.has(p) ? new Error("EACCES") : null) }, files });
  let host = await hostOf(mod);
  assert.equal(await host.keepAside("world a", UNSAVED), `${UNSAVED}-3`, "the free name, skipping the one it cannot read");
  assert.equal(await host.keepAside("world a", UNSAVED), null, "each text once a session");
  // full, and one of the three unreadable: nothing is written over, the trouble is logged
  const n = keptWrites(UNSAVED).length;
  assert.equal(await host.keepAside("world b", UNSAVED), null);
  assert.equal(keptWrites(UNSAVED).length, n);
  assert.equal(M.memfs.readText(`${UNSAVED}-2`), "u2 (unreadable)");
  assert.ok(host.errors.some((e) => e.where === "keep a damaged save"), JSON.stringify(host.errors));
  // readable again: the oldest of the three goes
  unreadable.clear();
  assert.equal(await host.keepAside("world c", UNSAVED), `${UNSAVED}-3`);
  assert.deepEqual(names().filter((x) => x.startsWith("save.unsaved")).sort().map((x) => [x, M.memfs.readText(`${DIR}/${x}`)]), [
    ["save.unsaved", "first"], ["save.unsaved-1", "u2 (unreadable)"], ["save.unsaved-2", "world a"], ["save.unsaved-3", "world c"],
  ]);
  assert.equal(M.calls().exec.length, 0);
  assert.deepEqual(mod.errors, [], "logged, not a script error");
  // checking(): the host never keeps anything aside
  M.resetState();
  mod = await mount({ role: "hud" }, { fixture: {}, checking: true });
  host = await hostOf(mod);
  assert.equal(await host.keepAside("x", UNSAVED), null);
  assert.equal(M.calls().readTextFile.length + M.calls().writeTextFile.length + M.calls().exec.length, 0);
  M.setChecking(false);
});

test("save.json missing but save.bak there: the herd comes back from the bak, never a new herd that rotates over it", async () => {
  M.resetState();
  const good = saveOf("idle");
  const mod = await mount({ role: "hud" }, { fixture: {}, files: { [BAK]: good } });
  const host = await hostOf(mod);
  assert.equal(host.stats.loadedFrom, "bak");
  assert.equal(host.world.state.heroes.length, 4);
  assert.equal(host.saveStatus().message, "The save file was missing, so the herd was restored from its backup (save.bak).");
  await M.tickAll(3000);
  assert.equal(writes(SAVE)[0].expected, null, "save.json is created again");
  assert.equal(writes(BAK).length, 0);
  await M.tickAll(31000);
  const again = await mount({ role: "hud" }, { fixture: null });
  const h2 = await hostOf(again);
  assert.equal(h2.stats.loadedFrom, "save");
  assert.equal(h2.world.state.heroes.length, 4);
  assert.deepEqual(mod.errors, []);
});

test("the restore notice says what was found and what it was kept as, nothing more", async () => {
  // a damaged save.json and no bak: no backup was damaged, one file was kept
  M.resetState();
  let mod = await mount({ role: "hud" }, { fixture: {}, files: { [SAVE]: "{not json" } });
  let st = (await hostOf(mod)).saveStatus();
  assert.equal(st.restoredFrom, "fresh");
  assert.equal(st.message, "The save file was damaged and there was no backup, so a new herd started. The damaged file was kept as save.broken.");
  // an earlier incident's save.broken stays: the notice names the file the text really went to
  M.resetState();
  mod = await mount({ role: "hud" }, { fixture: {}, files: { [SAVE]: "{not json", [BAK]: saveOf("idle"), [BROKEN]: "an old incident" } });
  st = (await hostOf(mod)).saveStatus();
  const kept = Object.keys(brokenFiles()).find((n) => n !== "save.broken");
  assert.ok(kept, JSON.stringify(Object.keys(brokenFiles())));
  assert.equal(st.message, `The save file was damaged, so the herd was restored from its backup (save.bak). The damaged file was kept as ${kept}.`);
  assert.equal(M.memfs.readText(BROKEN), "an old incident");
  // an unreadable save.json is not called damaged, and nothing is said to be kept
  M.resetState();
  const fixture = { readError: (p) => (p === SAVE ? new Error("os error 32") : null) };
  mod = await mount({ role: "hud" }, { fixture, files: { [SAVE]: saveOf("idle"), [BAK]: saveOf("idle", NOW - 120000) } });
  const host = await hostOf(mod);
  await M.tickAll(11000);
  assert.equal(host.stats.loadedFrom, "bak");
  assert.doesNotMatch(host.saveStatus().message, /damaged|kept as/);
  assert.match(host.saveStatus().message, /couldn't be read, so the herd was restored from its backup/);
});

test("the stage notice's label names the kind of trouble (a checksum load is not a restore from the backup)", async () => {
  const edited = saveOf("late").replace(/"gold":(\d)/, (m, d) => `"gold":${(Number(d) + 1) % 10}`);
  const labels = {};
  for (const [name, files] of [["unchecked", { [SAVE]: edited }], ["bak", { [SAVE]: "{not json", [BAK]: saveOf("idle") }], ["fresh", { [SAVE]: "{not json" }]]) {
    M.resetState();
    const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("idle"), files });
    assert.equal((await hostOf(mod)).stats.loadedFrom, name);
    mod.size(960, 200);
    mod.render();
    const notice = mod.node("mdr-save-notice");
    assert.ok(notice, name);
    const parts = [];
    M.walkLive(notice, (n) => { if (n.type === "text") parts.push(n.text); });
    labels[name] = parts.join(" ");
  }
  assert.match(labels.unchecked, /checksum/);
  assert.doesNotMatch(labels.unchecked, /backup/);
  assert.match(labels.bak, /restored from backup/);
  assert.match(labels.fresh, /new herd/);
});

test("a herd whose only fault is its checksum (both files) loads anyway instead of a new herd", async () => {
  M.resetState();
  const good = saveOf("late");
  // a one-digit edit of the gold (an editor, a stray byte): JSON and shape fine, CRC wrong
  const edited = good.replace(/"gold":(\d)/, (m, d) => `"gold":${(Number(d) + 1) % 10}`);
  assert.notEqual(edited, good);
  const mod = await mount({ role: "hud" }, { fixture: {}, files: { [SAVE]: edited, [BAK]: edited + "x" } });
  const host = await hostOf(mod);
  assert.equal(host.stats.loadedFrom, "unchecked");
  assert.equal(host.world.state.heroes.length, demoWorld("late", NOW - 60000).world.state.heroes.length, "the herd, not a new one");
  assert.equal(M.memfs.readText(BROKEN), edited, "the original text is kept");
  assert.match(host.saveStatus().message, /checksum/);
  assert.doesNotMatch(host.saveStatus().message, /backup/, "not restored from the backup");
  await M.tickAll(3000);
  assert.equal(writes(SAVE).length, 1, "replaced (re-signed) soon after");
  assert.equal(host.lastGood, true);
  await M.tickAll(31000);
  const again = await mount({ role: "hud" }, { fixture: null });
  assert.equal((await hostOf(again)).stats.loadedFrom, "save", "the next session loads it normally");
});

test("a save with an editor's final newline (or a BOM) loads as the save", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: {}, files: { [SAVE]: "\ufeff" + saveOf("idle") + "\n" } });
  const host = await hostOf(mod);
  assert.equal(host.stats.loadedFrom, "save");
  assert.equal(host.world.state.heroes.length, 4);
  assert.equal(host.saveStatus(), null);
  assert.deepEqual(brokenFiles(), {});
});

test("a save from a newer version loads read-only and is never written", async () => {
  M.resetState();
  const text = newerSave(saveOf("idle"));
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("idle"), files: { [SAVE]: text } });
  const host = await hostOf(mod);
  assert.equal(host.world.rt.readOnly, true);
  assert.equal(host.world.state.heroes.length, 4);
  // the player is told (D§13.4): the save status, the views' args.save, the stage notice
  const st = host.saveStatus();
  assert.equal(st.readOnly, true);
  assert.match(st.message, /newer version/);
  assert.ok(host.hasErrors(), "the debug dot shows too");
  assert.deepEqual(host.viewArgs("herd", { tab: "roster" }).save, st);
  assert.equal(st.title, "Save is read-only");
  assert.deepEqual(host.view("herd", { tab: "roster" }).save, { title: st.title, text: st.message, tooltip: st.detail }, "the Herd panel's band (D§13.4)");
  assert.deepEqual(host.viewArgs("hud", {}).save, st);
  assert.equal(host.viewArgs("nameplate", { terminal: "t1" }).save, undefined);
  mod.size(960, 200);
  mod.render();
  assert.ok(mod.node("mdr-save-notice"), "the stage shows a save notice");
  assert.match(mod.find("mdr-save-notice").methods.find((m) => m[0] === "tooltip")[1][0], /read-only/);
  mod.fire("mdr-save-notice");
  await M.flush();
  mod.render();
  assert.equal(mod.node("mdr-save-notice"), null, "dismissed by a click");
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

test("hot reload: the new build takes the previous build's world over (no rollback to the last save)", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("first-day") });
  const h1 = await hostOf(mod);
  await M.tickAll(31000);
  const saved = M.memfs.readText(SAVE);
  assert.ok(saved);
  const savedTick = JSON.parse(saved).tick;
  assert.ok(savedTick > 0);
  await M.tickAll(20000); // progress the file does not have yet
  const liveTick = h1.world.state.herd.tick;
  assert.ok(liveTick > savedTick + 10, `${liveTick} vs ${savedTick}`);
  const ids = h1.world.state.heroes.map((h) => [h.id, h.name]);
  await mod.reload();
  const h2 = await hostOf(mod);
  assert.notEqual(h2, h1, "module state is new");
  assert.equal(h2.stats.loadedFrom, "reload");
  assert.equal(h2.lastText, M.memfs.readText(SAVE), "the expected text is the file's");
  assert.deepEqual(h2.world.state.heroes.map((h) => [h.id, h.name]), ids);
  assert.ok(h2.world.state.herd.tick >= liveTick, `tick ${h2.world.state.herd.tick} < ${liveTick}: rolled back`);
  assert.equal(h1.retired, true, "the old host never writes again");
  // the progress reaches the disk soon, and the agents rebind to the same heroes
  await M.tickAll(3000);
  assert.ok(JSON.parse(M.memfs.readText(SAVE)).tick >= liveTick);
  assert.deepEqual([...h2.world.rt.bind.values()].sort(), ids.map((x) => x[0]).sort());
  assert.deepEqual(mod.errors, []);
});

test("hot reload: a save the retired host still has in flight stands down (a copy whose reload failed keeps its build)", async () => {
  // herdr keeps an old instance running when its reload fails (watch.rs reload returns before the
  // release), so a write that instance's pump started is answered after the next build took the
  // world over. Its save.json write would land over the new host's expected text, and the new host
  // would reload it as someone else's save (npm run qjs, phase reload, build 5).
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("first-day") });
  const host = await hostOf(mod);
  await M.tickAll(31000);
  const onDisk = M.memfs.readText(SAVE);
  assert.ok(onDisk && host.lastGood, "a save landed (the next one writes save.bak first)");
  await M.tickAll(3000);
  host.world.rt.dirty = true;
  const saves = host.stats.saves;
  const p = host.maybeSave(true);
  assert.ok(p && host.saving === p, "in flight: at its save.bak write");
  host.retire(); // the next build's load took the world over meanwhile
  assert.equal(host.saving, null);
  assert.equal(await p, false, "it stands down when its write is answered");
  assert.equal(M.memfs.readText(SAVE), onDisk, "save.json is untouched");
  assert.equal(host.lastText, onDisk);
  assert.equal(host.stats.saves, saves);
  assert.equal(host.maybeSave(true), null, "and it never starts another");
  await M.tickAll(5000);
  assert.equal(M.memfs.readText(SAVE), onDisk);
  assert.deepEqual(mod.errors, []);
});

test("hot reload: the previous build's host is retired even when it declines the handover (a copy whose reload failed still runs it)", async () => {
  // It declines when save.json is no longer its own text (another window wrote it). The new host
  // loads the file; the old one, kept alive by a copy whose reload failed (watch.rs reload), must
  // not go on pumping and saving: two writers in one VM fight over save.json (conflicts, reloads).
  M.resetState();
  const a = await mount({ role: "stage" }, { graph: "decline", fixture: FX.demoFixture("mid") });
  const b = await mount({ role: "party" }, { graph: "decline", fixture: null });
  const h1 = await hostOf(a);
  await M.tickAll(31000);
  assert.ok(h1.lastText && M.memfs.readText(SAVE) === h1.lastText, "a save landed");
  const theirs = saveOf("late", Date.now());
  M.memfs.write(SAVE, theirs); // another window saved meanwhile
  await M.reloadAll([a]); // b's new instance failed: b keeps build 1 and its host
  const h2 = await hostOf(a);
  assert.notEqual(h2, h1);
  assert.equal(b.view.host, h1, "the copy that kept its build still holds the old host");
  assert.equal(h2.stats.loadedFrom, "save", "declined: the file is another window's, so it is loaded");
  assert.equal(h2.lastText, theirs);
  assert.equal(h1.retired, true, "retired all the same");
  const w0 = writes(SAVE).length;
  const [pumps, saves] = [h1.stats.pumps, h1.stats.saves];
  await M.tickAll(70000); // b's timer still calls h1 every second
  assert.equal(h1.stats.pumps, pumps, "the old host no longer pumps");
  assert.equal(h1.stats.saves, saves, "nor saves");
  assert.equal(h1.stats.reloads, 0);
  const after = writes(SAVE).slice(w0);
  assert.ok(after.length >= 2 && after.every((w) => w.copy === a.copy.label), JSON.stringify(after.map((w) => w.copy)));
  assert.equal(h2.stats.reloads, 0, "no write conflict");
  assert.equal(M.memfs.readText(SAVE), h2.lastText);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("hot reload: a host retired while it is still loading never finishes the load nor registers", async () => {
  M.resetState();
  let fails = 1;
  const fixture = { ...FX.demoFixture("mid"), readError: (p) => (p === SAVE && fails-- > 0 ? new Error("os error 32") : null) };
  const mod = await mount({ role: "stage" }, { graph: "retire-loading", fixture });
  const host = await hostOf(mod);
  assert.equal(host.ready, false, "still loading: the read is retried after 1 s");
  host.retire(); // the next build took over meanwhile
  await M.tickAll(15000); // past the read retry and the 10 s stuck-load retry
  assert.equal(host.loaded, false);
  assert.equal(host.ready, false);
  assert.notEqual(globalThis[Symbol.for("down-the-stack.live.v1")], host, "never registered for a later build");
  assert.equal(writes(SAVE).length, 0);
  assert.deepEqual(mod.errors, []);
});

test("hot reload of every copy: one new module scope and one new host for all of them", async () => {
  M.resetState();
  const a = await mount({ role: "stage" }, { graph: "hr", fixture: FX.demoFixture("mid") });
  const b = await mount({ role: "party" }, { graph: "hr", fixture: null });
  const c = await mount({ role: "nameplate", pane: "p_t1", terminal: "t1" }, { graph: "hr", fixture: null });
  const h1 = await hostOf(a);
  await M.tickAll(5000);
  const tick = h1.world.state.herd.tick;
  await M.reloadAll([a, b, c]);
  const h2 = await hostOf(a);
  assert.notEqual(h2, h1);
  assert.equal(await hostOf(b), h2);
  assert.equal(await hostOf(c), h2);
  assert.equal(a.view.host, h2);
  assert.equal(c.view.host, h2);
  assert.equal(h2.stats.loadedFrom, "reload");
  assert.ok(h2.world.state.herd.tick >= tick);
  // the old builds' timers are gone from the clock: one 1 s timer per copy remains
  assert.equal(M.clock.timers.length, 3);
  await M.tickAll(3000);
  for (const m of [a, b, c]) assert.deepEqual(m.errors, []);
});

test("hot reload hands over a world whose load finished after its mount (a retried read), another VM mounted meanwhile", async () => {
  M.resetState();
  let fails = 1;
  const fixture = { ...FX.demoFixture("mid"), readError: (p) => (p === SAVE && fails-- > 0 ? new Error("os error 32") : null) };
  const a = await mount({ role: "stage" }, { graph: "late-a", fixture });
  const h1 = await hostOf(a);
  assert.equal(h1.ready, false, "still loading: the read is retried after 1 s");
  await M.tickAll(3000);
  assert.equal(h1.stats.loadedFrom, "new");
  const b = await mount({ role: "stage" }, { graph: "late-b", fixture: null }); // another window
  const hb = await hostOf(b);
  await M.tickAll(5000);
  await M.reloadAll([a]);
  const h2 = await hostOf(a);
  assert.notEqual(h2, h1);
  assert.equal(h2.stats.loadedFrom, "reload", "the late registration belongs to its own VM");
  assert.equal(h1.retired, true);
  assert.equal(hb.retired, false, "the other window's host is not touched");
});

/** A stage and a party on one VM whose world saved twice (save.bak holds the first save). */
async function reloadRig(kind = "mid", files) {
  M.resetState();
  const g = `rl-${++graphN}`;
  const a = await mount({ role: "stage" }, { graph: g, fixture: FX.demoFixture(kind), files });
  const b = await mount({ role: "party" }, { graph: g, fixture: null });
  const h1 = await hostOf(a);
  await M.tickAll(31000);
  await M.tickAll(31000);
  assert.ok(M.memfs.readText(BAK) && M.memfs.readText(SAVE) === h1.lastText, "two saves landed");
  await M.tickAll(20000); // progress the file does not have yet
  return { a, b, h1 };
}
const diskTick = (p) => { try { return JSON.parse(M.memfs.readText(p)).tick; } catch (e) { return null; } };

test("hot reload over a save.json another program left as garbage: the world goes on, the garbage is kept aside", async () => {
  const { a, b, h1 } = await reloadRig();
  const liveTick = h1.world.state.herd.tick;
  const bakText = M.memfs.readText(BAK);
  assert.ok(diskTick(BAK) < liveTick);
  const garbage = '{"v":1,"herd":{"name":"half-written';
  M.memfs.write(SAVE, garbage);
  await M.reloadAll([a, b]);
  const h2 = await hostOf(a);
  assert.equal(h2.stats.loadedFrom, "reload", "no rollback to save.bak");
  assert.ok(h2.world.state.herd.tick >= liveTick, `${h2.world.state.herd.tick} < ${liveTick}`);
  assert.equal(h1.retired, true);
  assert.equal(M.memfs.readText(BROKEN), garbage, "the garbage is kept aside");
  assert.equal(h2.lastText, garbage);
  assert.equal(h2.lastGood, false, "the garbage never becomes the bak");
  await M.tickAll(3000);
  assert.ok(diskTick(SAVE) >= liveTick, "the world is on disk again, over the garbage");
  assert.equal(writes(SAVE).at(-1).expected, garbage);
  assert.equal(M.memfs.readText(BAK), bakText, "save.bak untouched by the garbage");
  assert.equal(h2.saveStatus(), null, "nothing was restored: nothing to tell");
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("hot reload while save.json cannot be read: the world goes on, never written over, saved once it reads", async () => {
  const { a, b, h1 } = await reloadRig();
  const liveTick = h1.world.state.herd.tick;
  const onDisk = M.memfs.readText(SAVE);
  let busy = true;
  M.updateFixture({ readError: (p) => (busy && p === SAVE ? new Error("EBUSY: held by a sync tool") : null) });
  await M.reloadAll([a, b]);
  await M.tickAll(11000); // the load reads again after 1, 3 and 6 s
  const h2 = await hostOf(a);
  assert.equal(h2.stats.loadedFrom, "reload", "no rollback to save.bak");
  assert.ok(h2.world.state.herd.tick >= liveTick);
  assert.equal(h2.ioBlocked, true);
  assert.equal(h2.saveStatus().notSaving, true, "the player is told it is not saving");
  await M.tickAll(40000);
  assert.equal(M.memfs.readText(SAVE), onDisk, "never written while it cannot be read");
  busy = false;
  await M.tickAll(31000);
  await M.tickAll(3000);
  assert.equal(h2.ioBlocked, false);
  assert.ok(diskTick(SAVE) > liveTick, "this world, not the bak's, is saved over it");
  assert.equal(names().filter((n) => n.startsWith("save.unsaved")).length, 0, "its own file: nothing to keep aside");
  assert.equal(h2.saveStatus(), null);
});

test("hot reload as save.json reads again after the previous build never could: recoverRead's rule", async () => {
  // A herd that started fresh (nothing loaded): the file's herd comes back and this session's
  // world is kept aside as save.unsaved. A herd restored from the bak: that world goes on.
  for (const withBak of [false, true]) {
    M.resetState();
    let busy = true;
    const json = saveOf("mid");
    const files = { [SAVE]: json };
    if (withBak) files[BAK] = saveOf("first-day");
    const g = `rr-${++graphN}`;
    const a = await mount({ role: "stage" }, { graph: g, fixture: { ...FX.demoFixture("mid"), readError: (p) => (busy && p === SAVE ? new Error("EACCES") : null) }, files });
    const h1 = await hostOf(a);
    await M.tickAll(12000);
    assert.equal(h1.stats.loadedFrom, withBak ? "bak" : "fresh");
    assert.equal(h1.ioBlocked, true);
    h1.world.state.herd.name = "This session's herd"; // a marker of this session's world
    busy = false;
    await M.reloadAll([a]);
    await M.tickAll(3000);
    const h2 = await hostOf(a);
    const unsaved = names().filter((n) => n.startsWith("save.unsaved"));
    if (withBak) {
      assert.equal(h2.stats.loadedFrom, "reload", "restored from the bak: this world goes on");
      assert.equal(h2.world.state.herd.name, "This session's herd");
      assert.equal(h2.ioBlocked, false);
      assert.equal(unsaved.length, 0);
      assert.equal(M.memfs.readText(BAK), json, "the file it could not read became the bak");
      assert.equal(h2.saveStatus().restoredFrom, "bak", "still told it was restored");
    } else {
      assert.equal(h2.stats.loadedFrom, "save", "the herd in the file comes back");
      assert.equal(h2.world.state.heroes.length, 6);
      assert.equal(unsaved.length, 1, names().join(", "));
      assert.equal(JSON.parse(M.memfs.readText(`${DIR}/${unsaved[0]}`)).herd.name, "This session's herd", "this session's world is kept aside");
      assert.notEqual(h2.world.state.herd.name, "This session's herd");
    }
    assert.equal(h1.retired, true);
    assert.deepEqual(a.errors, []);
  }
});

test("hot reloads while save.json is briefly unreadable and then reads again as this world's own save: it goes on", async () => {
  // A new herd (both files damaged) that has saved since: its own save.json must never be taken
  // for a herd it never had, even though the herd started fresh and a reload saw the file unreadable.
  M.resetState();
  const files = { [SAVE]: "{not json", [BAK]: "{also not json" };
  const g = `own-${++graphN}`;
  const a = await mount({ role: "stage" }, { graph: g, fixture: FX.demoFixture("mid"), files });
  const h1 = await hostOf(a);
  await M.tickAll(3000);
  assert.equal(h1.stats.loadedFrom, "fresh");
  await M.tickAll(31000);
  const own = M.memfs.readText(SAVE);
  assert.equal(own, h1.lastText, "the new herd is on disk");
  h1.world.state.herd.name = "This session's herd";
  let busy = true;
  M.updateFixture({ readError: (p) => (busy && p === SAVE ? new Error("EBUSY") : null) });
  await M.reloadAll([a]);
  await M.tickAll(11000);
  const h2 = await hostOf(a);
  assert.equal(h2.ioBlocked, true);
  busy = false;
  await M.reloadAll([a]);
  await M.tickAll(2000);
  const h3 = await hostOf(a);
  assert.equal(h3.stats.loadedFrom, "reload");
  assert.equal(h3.world.state.herd.name, "This session's herd");
  assert.equal(h3.ioBlocked, false);
  assert.equal(names().filter((n) => n.startsWith("save.unsaved")).length, 0);
  assert.equal(h3.saveStatus().restoredFrom, "fresh", "still told the herd started fresh");
  assert.deepEqual(a.errors, []);
});

test("a hot reload while save.json is briefly unreadable, then it reads again on the 30 s beat as this world's own save: no rollback", async () => {
  // The same new herd, but no second reload: recoverRead() finds the text it wrote itself (handed
  // over with the world), not a herd this session never had, so nothing is kept aside or rolled back.
  M.resetState();
  const files = { [SAVE]: "{not json", [BAK]: "{also not json" };
  const g = `own30-${++graphN}`;
  const a = await mount({ role: "stage" }, { graph: g, fixture: FX.demoFixture("mid"), files });
  const h1 = await hostOf(a);
  await M.tickAll(3000);
  assert.equal(h1.stats.loadedFrom, "fresh");
  await M.tickAll(31000);
  const own = M.memfs.readText(SAVE);
  assert.equal(own, h1.lastText, "the new herd is on disk");
  h1.world.state.herd.name = "This session's herd"; // progress the file does not have yet
  let busy = true;
  M.updateFixture({ readError: (p) => (busy && p === SAVE ? new Error("EBUSY") : null) });
  await M.reloadAll([a]);
  await M.tickAll(11000);
  const h2 = await hostOf(a);
  assert.equal(h2.stats.loadedFrom, "reload");
  assert.equal(h2.ioBlocked, true);
  busy = false;
  await M.tickAll(31000); // the 30 s beat reads it again: its own text
  await M.tickAll(3000);
  assert.equal(h2.ioBlocked, false);
  assert.equal(h2.world.state.herd.name, "This session's herd", "this world goes on");
  assert.equal(names().filter((n) => n.startsWith("save.unsaved")).length, 0, names().join(", "));
  assert.equal(JSON.parse(M.memfs.readText(SAVE)).herd.name, "This session's herd", "and is saved over its own file");
  assert.equal(h2.saveStatus().restoredFrom, "fresh", "still told the herd started fresh");
  assert.deepEqual(a.errors, []);
});

test("hot reload keeps the save-trouble cue: a world restored from the bak still says so", async () => {
  M.resetState();
  const good = saveOf("mid");
  const files = { [SAVE]: good.replace(/"crc":"[0-9a-f]+"/, '"crc":"00000000"'), [BAK]: good };
  const g = `cue-${++graphN}`;
  const a = await mount({ role: "stage" }, { graph: g, fixture: FX.demoFixture("mid"), files });
  const b = await mount({ role: "party" }, { graph: g, fixture: null });
  const h1 = await hostOf(a);
  await M.tickAll(1000);
  const st1 = h1.saveStatus();
  assert.equal(st1.restoredFrom, "bak");
  h1.saveNoticeSeen = st1.message; // the player dismissed the stage notice
  h1.failedWrites = 1;
  await M.reloadAll([a, b]);
  await M.tickAll(1000);
  const h2 = await hostOf(a);
  assert.equal(h2.stats.loadedFrom, "reload");
  const st2 = h2.saveStatus();
  assert.ok(st2, "the same world goes on, so does what the player was told");
  assert.equal(st2.restoredFrom, "bak");
  assert.equal(st2.message, st1.message);
  assert.equal(st2.since, st1.since);
  assert.equal(h2.view("party", { width: 260 }).save?.title, st1.title, "the party cue");
  assert.equal(h2.saveNoticeSeen, st1.message, "a dismissed notice stays dismissed");
  assert.equal(h2.failedWrites, 1, "failing writes keep counting");
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("hot reload while the old host is still loading, next to a copy whose reload failed: one host", async () => {
  // The old host registers as soon as it starts loading, so the next build finds it, retires it
  // (its load never finishes) and loads the file; the copy that kept the old build calls a retired
  // host from then on.
  M.resetState();
  let fails = 1;
  const fixture = { ...FX.demoFixture("mid"), readError: (p) => (p === SAVE && fails-- > 0 ? new Error("os error 32") : null) };
  const g = `still-${++graphN}`;
  const a = await mount({ role: "stage" }, { graph: g, fixture, files: { [SAVE]: saveOf("mid") } });
  const b = await mount({ role: "party" }, { graph: g, fixture: null });
  const h1 = await hostOf(a);
  assert.equal(h1.loaded, false, "still loading: its read is retried after 1 s");
  await M.reloadAll([a]); // b's new instance failed: b keeps build 1
  const h2 = await hostOf(a);
  assert.notEqual(h2, h1);
  assert.equal(b.view.host, h1);
  await M.tickAll(1000);
  assert.equal(h2.stats.loadedFrom, "save");
  assert.equal(h1.retired, true, "the old host is retired although it never finished loading");
  await M.tickAll(70000); // b's timer still calls h1 every second (its load would restart after 10 s)
  assert.equal(h1.loaded, false, "it never loads");
  assert.equal(h1.stats.pumps, 0);
  assert.ok(writes(SAVE).length >= 2 && writes(SAVE).every((w) => w.copy === a.copy.label), JSON.stringify(writes(SAVE).map((w) => w.copy)));
  assert.equal(h2.stats.reloads, 0, "no write conflict");
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("back-to-back hot reloads (the next build lands before the last one loaded): no rollback, one host", async () => {
  M.resetState();
  const g = `b2b-${++graphN}`;
  const a = await mount({ role: "stage" }, { graph: g, fixture: FX.demoFixture("mid") });
  const h1 = await hostOf(a);
  await M.tickAll(31000);
  await M.tickAll(10000);
  const liveTick = h1.world.state.herd.tick;
  let fails = 1;
  M.updateFixture({ readError: (p) => (p === SAVE && fails-- > 0 ? new Error("os error 32") : null) });
  await M.reloadAll([a]); // build 2: its read fails once, so it is still loading
  const h2 = await hostOf(a);
  assert.equal(h2.loaded, false);
  await M.reloadAll([a]); // build 3
  const h3 = await hostOf(a);
  await M.tickAll(2000);
  assert.equal(h3.stats.loadedFrom, "reload", "build 1 handed its world to build 3");
  assert.ok(h3.world.state.herd.tick >= liveTick);
  assert.equal(h1.retired, true);
  assert.equal(h2.retired, true);
  assert.equal(h2.loaded, false);
  assert.equal(h3.pred, null, "the earlier builds can go");
});

test("a new VM (or another window) never takes another VM's world: it loads the file", async () => {
  M.resetState();
  const a = await mount({ role: "stage" }, { graph: "vm-a", fixture: FX.demoFixture("mid") });
  const ha = await hostOf(a);
  await M.tickAll(2000);
  const b = await mount({ role: "stage" }, { graph: "vm-b", fixture: null });
  const hb = await hostOf(b);
  assert.notEqual(hb.world, ha.world);
  assert.equal(hb.stats.loadedFrom, ha.lastText == null ? "new" : "save");
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

test("a sub-agent kept in a pane (listed in agents()) stays its parent's Forkling (D§2.7)", async () => {
  M.resetState();
  const P = M.PROGRAMS.claude;
  const agent = (address, seq) => M.agent(seq, { address, pane: `p_${address}`, status: "working", seq, program: P, title: `task ${address}` });
  const t1 = agent("t1", 1);
  const t2 = agent("t2", 2);
  const fixture = {
    agents: [t1, t2],
    terminals: [M.terminalFor(t1), { ...M.terminalFor(t2), parent: "t1" }],
  };
  const mod = await mount({ role: "stage" }, { fixture });
  const host = await hostOf(mod);
  const snap = host.snapshot(Date.now());
  assert.deepEqual(snap.agents.map((a) => [a.address, a.parent]), [["t1", null], ["t2", "t1"]]);
  await M.tickAll(3000);
  assert.equal(host.world.state.heroes.length, 1, "one hero, not two");
  const hero = host.world.state.heroes[0];
  assert.equal(host.heroForTerminal("t1"), hero.id);
  assert.equal(host.heroForTerminal("t2"), hero.id, "t2 is a Forkling of t1's hero");
  assert.deepEqual(mod.errors, []);
});

test("tab ids that name Object.prototype members (a herdr.tab label) neither throw nor vanish", async () => {
  M.resetState();
  const fx = FX.demoFixture("mid");
  const tabs = ["constructor", "__proto__", "toString", "hasOwnProperty"].map((id, i) => ({ ...fx.spaces[0].tabs[0], id, index: 10 + i, working_since: 1000 + i }));
  const mod = await mount({ role: "hud" }, { fixture: { ...fx, spaces: [{ ...fx.spaces[0], tabs: [...fx.spaces[0].tabs, ...tabs] }, ...fx.spaces.slice(1)] } });
  const host = await hostOf(mod);
  const snap = host.snapshot(NOW);
  assert.equal(Object.getPrototypeOf(snap.tabs), null, "no prototype: assigning such a key cannot hit a frozen Object.prototype (herdr freezes it)");
  for (const [i, t] of tabs.entries()) {
    assert.ok(Object.prototype.hasOwnProperty.call(snap.tabs, t.id), t.id);
    assert.equal(snap.tabs[t.id].working_since, 1000 + i);
  }
  assert.equal(host.pump(NOW + 1000), true);
  assert.deepEqual(mod.errors, []);
});

test("broadcast: only while a copy can be shown (herdr toasts \"down-the-stack.tick failed\" when none listens)", async () => {
  M.resetState();
  const fx = FX.demoFixture("mid");
  const stage = await mount({ role: "stage" }, { graph: "bc", fixture: fx });
  const party = await mount({ role: "party" }, { graph: "bc", fixture: null });
  const host = await hostOf(stage);
  const runs = () => M.calls().run.filter((r) => r.name === "down-the-stack.tick").length;
  await M.tickAll(3000);
  const n0 = runs();
  assert.ok(n0 >= 2, "broadcasts while shown");
  // the sidebar and the stage hidden (ctrl-shift-b, ctrl-shift-g) and no tab open
  const lay = JSON.parse(JSON.stringify(fx.layout));
  const hide = (n) => { if (n.id === "sidebar" || n.id === "stage") n.hidden = true; for (const k of n.children ?? []) hide(k); };
  hide(lay);
  M.updateFixture({ layout: lay, focused: null });
  stage.hide();
  party.hide();
  await M.tickAll(10000);
  assert.equal(runs(), n0, "no broadcast without a shown copy");
  assert.deepEqual(M.calls().toasts, []);
  assert.ok(host.world.rt.tick > 0, "the world still advanced");
  // with a pane open, the pane headers are shown copies
  M.updateFixture({ focused: fx.focused });
  assert.equal(host.mayBeShown(), true);
  M.updateFixture({ focused: null });
  // a copy shown again draws, and the broadcasts resume
  M.updateFixture({ layout: fx.layout });
  stage.hide(false);
  party.hide(false);
  await M.tickAll(3000);
  assert.ok(runs() > n0);
  assert.deepEqual(M.calls().toasts, []);
  for (const m of [stage, party]) assert.deepEqual(m.errors, []);
});

test("mayBeShown follows herdr's visibility: a stack shows its active visible child, floats and stack headers count", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: { focused: null } });
  const host = await hostOf(mod);
  const block = (id, content, extra = {}) => ({ id, type: "block", content, ...extra });
  const ours = { mod: "down-the-stack", props: { role: "stage" } };
  const shown = (layout) => { M.updateFixture({ layout }); return host.mayBeShown(); };
  // the active child hidden: herdr shows the first visible child instead (layout.rs active_child)
  assert.equal(shown({ id: "r", type: "stack", active: "a", children: [block("a", { mod: "files" }, { hidden: true }), block("b", ours)] }), true);
  assert.equal(shown({ id: "r", type: "stack", active: "a", children: [block("a", { mod: "files" }), block("b", ours)] }), false);
  // a block floating over a shown node, unless the float is hidden
  assert.equal(shown({ id: "r", type: "column", children: [block("t", { mod: "tabs" })], floating: [{ id: "f", content: ours }] }), true);
  assert.equal(shown({ id: "r", type: "column", children: [block("t", { mod: "tabs" })], floating: [{ id: "f", content: ours, hidden: true }] }), false);
  // a stack's header block shows with its stack
  assert.equal(shown({ id: "r", type: "stack", header: { content: ours }, children: [block("a", { mod: "files" })] }), true);
  assert.equal(shown({ id: "r", type: "stack", hidden: true, header: { content: ours }, children: [block("a", { mod: "files" })] }), false);
  // a layout that never names this mod: true (the copies are somewhere this does not know)
  assert.equal(shown({ id: "r", type: "column", children: [block("t", { mod: "tabs" })] }), true);
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
  assert.deepEqual(spec, { mod: "down-the-stack", kind: "dialog", width: 760, height: 500, props: { role: "sheet", heroId: 1 } });

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

test("a throwing view builder is told apart from loading (viewError)", async () => {
  M.resetState();
  const mod = await mount({ role: "hud" }, { fixture: FX.demoFixture("mid") });
  const host = await hostOf(mod);
  host.world = (await mod.import("./game/demo.js")).demoWorld("mid", NOW).world;
  host.version++;
  assert.equal(host.viewError("sheet"), null);
  assert.equal(host.view("sheet", { heroId: 1, filter: { get slot() { throw new Error("bad filter"); } } }), null);
  assert.equal(host.viewError("sheet"), "bad filter");
  assert.ok(host.view("sheet", { heroId: 1 }));
  assert.equal(host.viewError("sheet"), null, "cleared by the next good build");
  assert.equal(host.view("constructor", {}), null, "only the six view kinds");
  assert.equal(host.view("toString", {}), null);
});

test("mod.clone: the clone's host names its own mod (overlays, <mod>.tick, the save folder)", async () => {
  // clone_mod_at (herdr src/mods.rs:247-257) rewrites these text forms in every file, nothing else
  const from = "down-the-stack";
  const to = "down-the-stack-copy";
  const rewrite = (text) => {
    let t = text.replaceAll(`mods/${from}/`, `mods/${to}/`).replaceAll(`"mods/${from}"`, `"mods/${to}"`).replaceAll(`'mods/${from}'`, `'mods/${to}'`);
    for (const key of ["mod", '"mod"', "'mod'"]) for (const space of ["", " "]) for (const q of ['"', "'"]) {
      t = t.replaceAll(`${key}:${space}${q}${from}${q}`, `${key}:${space}${q}${to}${q}`);
    }
    return t;
  };
  const src = path.join(M.REPO, "mods", from);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdr-clone-"));
  const dst = path.join(dir, to);
  const copy = (a, b) => {
    fs.mkdirSync(b, { recursive: true });
    for (const e of fs.readdirSync(a, { withFileTypes: true })) {
      if (e.isDirectory()) copy(path.join(a, e.name), path.join(b, e.name));
      else if (/\.(js|json)$/.test(e.name)) fs.writeFileSync(path.join(b, e.name), rewrite(fs.readFileSync(path.join(a, e.name), "utf8")));
    }
  };
  try {
    copy(src, dst);
    for (const rel of ["host.js", "ui/kit.js"]) {
      const code = fs.readFileSync(path.join(dst, rel), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      assert.doesNotMatch(code, /["']down-the-stack["']|["']mods\/down-the-stack["'/]/, `${rel} still names the original mod`);
    }
    M.resetState();
    const mod = await M.mountMod(path.join(dst, "main.js"), { props: { role: "stage" }, fixture: FX.demoFixture("mid"), nowMs: NOW, name: to });
    const H = await mod.import("./host.js");
    assert.equal(H.MOD, to);
    const host = H.getHost();
    assert.equal(host.paths().dir, `${M.APP_HOME}/data/${to}`, "its own save");
    mod.render();
    await M.tickAll(2000);
    assert.ok(M.calls().run.some((r) => r.name === `${to}.tick`));
    assert.ok(!M.calls().run.some((r) => r.name === `${from}.tick`));
    host.openSheet(1);
    assert.equal(M.calls().openOverlay.at(-1).spec.mod, to);
    await mod.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("our own save that landed while its promise never came back is not mistaken for another writer's", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("first-day") });
  const host = await hostOf(mod);
  await M.tickAll(31000);
  assert.ok(writes(SAVE).length >= 1);
  // the next save.json write lands on disk but its promise never settles (its copy went away)
  let hang = 1;
  M.updateFixture({ hangAfterWrite: (p) => p === SAVE && hang-- > 0 });
  host.world.rt.dirty = true;
  const p = host.maybeSave(true);
  await M.flush();
  const landed = M.memfs.readText(SAVE);
  assert.notEqual(landed, host.lastText, "landed, unanswered");
  assert.equal(host.saving, p);
  await M.tickAll(16000); // given up after 15 s, then saved again with the stale expected text
  await M.tickAll(31000);
  assert.equal(host.stats.reloads, 0, "no reload of our own text");
  assert.equal(host.lastText, M.memfs.readText(SAVE));
  assert.notEqual(host.lastText, landed, "saved over it");
  assert.ok(host.world.state.herd.tick > JSON.parse(landed).tick, "the world was not rolled back");
});

test("flush on close never waits for a save started earlier (on quit it may never finish)", async () => {
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("first-day") });
  const host = await hostOf(mod);
  await M.tickAll(31000);
  await M.tickAll(31000); // a save.bak exists now
  const before = M.memfs.readText(SAVE);
  // the next save's save.bak write lands but never settles: the save.json write never starts
  let hang = 1;
  M.updateFixture({ hangAfterWrite: (p) => p === BAK && hang-- > 0 });
  host.world.rt.dirty = true;
  host.maybeSave(true);
  await M.flush();
  assert.ok(host.saving);
  assert.equal(M.memfs.readText(SAVE), before, "save.json not written yet");
  const baks = writes(BAK).length;
  const done = await Promise.race([host.flush().then(() => true), M.flush(20).then(() => false)]);
  assert.equal(done, true, "flush finished without the earlier save");
  assert.notEqual(M.memfs.readText(SAVE), before, "the final save was written");
  assert.equal(writes(SAVE).at(-1).expected, before);
  assert.equal(writes(BAK).length, baks, "no save.bak step in the final save");
  assert.equal(host.lastText, M.memfs.readText(SAVE));
});

test("a save.json that fails to read once is read again before the host decides", async () => {
  M.resetState();
  let fails = 1;
  const fixture = { readError: (p) => (p === SAVE && fails-- > 0 ? new Error("os error 32: the file is being used by another process") : null) };
  const mod = await mount({ role: "hud" }, { fixture, files: { [SAVE]: saveOf("idle"), [BAK]: saveOf("first-day") } });
  const host = await hostOf(mod);
  assert.equal(host.ready, false, "still loading: it tries again in a second");
  await M.tickAll(1500);
  assert.equal(host.stats.loadedFrom, "save");
  assert.equal(host.ioBlocked, false);
  assert.equal(host.world.state.heroes.length, 4);
  host.command("setting", { key: "calm", value: true });
  await M.tickAll(3000);
  assert.equal(writes(SAVE).length, 1, "saving works");
});

test("an unreadable save.json: run from the bak, tell the player, read it again on the 30 s beat, then save", async () => {
  M.resetState();
  let unreadable = true;
  const fixture = { readError: (p) => (p === SAVE && unreadable ? new Error("os error 32") : null) };
  const json = saveOf("idle");
  const mod = await mount({ role: "stage" }, { fixture: { ...FX.demoFixture("idle"), ...fixture }, files: { [SAVE]: json, [BAK]: saveOf("idle", NOW - 120000) } });
  const host = await hostOf(mod);
  await M.tickAll(11000); // three more reads (1 s, 3 s, 6 s apart)
  assert.equal(host.stats.loadedFrom, "bak");
  assert.equal(host.ioBlocked, true);
  assert.equal(host.saveStatus().notSaving, true);
  assert.match(host.saveStatus().message, /can't be read/);
  host.command("setting", { key: "calm", value: true });
  await M.tickAll(31000);
  assert.equal(writes(SAVE).length, 0, "never writes over what it cannot read");
  unreadable = false;
  await M.tickAll(31000);
  assert.equal(host.ioBlocked, false, "it reads again");
  await M.tickAll(3000);
  assert.ok(writes(SAVE).length >= 1, "saving resumed");
  assert.equal(writes(SAVE)[0].expected, json);
  assert.equal(M.memfs.readText(BAK), json, "the file's text became the bak");
  assert.equal(JSON.parse(M.memfs.readText(SAVE)).herd.cfg.calm, 1, "the command made while blocked is saved");
  assert.equal(host.saveStatus()?.notSaving ?? false, false);
});

test("an unreadable save.json and no bak: once it reads, the herd comes back and this session is kept aside", async () => {
  M.resetState();
  let unreadable = true;
  const json = saveOf("idle");
  const mod = await mount({ role: "hud" }, { fixture: { readError: (p) => (p === SAVE && unreadable ? new Error("os error 5") : null) }, files: { [SAVE]: json } });
  const host = await hostOf(mod);
  await M.tickAll(11000);
  assert.equal(host.stats.loadedFrom, "fresh");
  assert.equal(host.world.state.heroes.length, 0);
  unreadable = false;
  await M.tickAll(31000);
  assert.equal(host.world.state.heroes.length, 4, "the herd is back");
  assert.equal(host.stats.loadedFrom, "save");
  const kept = names().filter((n) => n.startsWith("save.unsaved"));
  assert.equal(kept.length, 1, names().join(", "));
  assert.ok(writes(SAVE).every((w) => w.expected === json || w.expected === writes(SAVE)[0].text), "the herd's file is only written over knowingly");
  assert.equal(writes(SAVE).length ? writes(SAVE)[0].expected : json, json);
});

test("a save from a newer version that could not be read at start is never written once it reads (D§13.4)", async () => {
  M.resetState();
  const text = newerSave(saveOf("idle"));
  let busy = 6; // unreadable for the load's reads (1 + 3 retries), then fine
  const mod = await mount({ role: "hud" }, { fixture: { ...FX.demoFixture("idle"), readError: (p) => (p === SAVE && busy-- > 0 ? new Error("EBUSY") : null) }, files: { [SAVE]: text } });
  const host = await hostOf(mod);
  await M.tickAll(12000);
  assert.equal(host.stats.loadedFrom, "fresh");
  assert.equal(host.ioBlocked, true);
  host.world.state.herd.name = "This session's herd"; // a marker of this session's world
  await M.tickAll(31000); // the 30 s beat reads it again: a newer version's save
  await M.tickAll(35000);
  await M.tickAll(35000);
  assert.equal(M.memfs.readText(SAVE), text, "never written over");
  assert.equal(M.memfs.readText(BAK), undefined, "never rotated into save.bak either");
  assert.equal(writes(SAVE).length, 0);
  assert.equal(host.world.rt.readOnly, true, "the newer herd is open read-only, as at a start");
  assert.equal(host.world.state.heroes.length, 4);
  assert.equal(host.saveStatus().readOnly, true, "and the player is told");
  const kept = names().filter((n) => n.startsWith("save.unsaved"));
  assert.equal(kept.length, 1, names().join(", "));
  assert.equal(JSON.parse(M.memfs.readText(`${DIR}/${kept[0]}`)).herd.name, "This session's herd", "this session's world is kept aside");
  assert.deepEqual(mod.errors, []);
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

test("a frame drawing more views than the memo keeps drops pane headers first: stage, party and HUD stay prewarmed", async () => {
  // herdr draws a header copy for every pane on screen; past the memo's size the whole map used to
  // go mid-frame, so the stage, party and HUD were never prewarmed and rebuilt in their renders.
  M.resetState();
  const mod = await mount({ role: "stage" }, { fixture: FX.demoFixture("mid") });
  const host = await hostOf(mod);
  host.world = (await mod.import("./game/demo.js")).demoWorld("mid", NOW).world;
  host.version++;
  const frame = () => {
    host.view("stage", { width: 960, height: 200 });
    host.view("party", { width: 260 });
    host.view("hud", { width: 960 });
    for (let i = 0; i < 90; i++) host.view("nameplate", { terminal: `t${i}`, pane: `p_${i}` });
  };
  frame();
  assert.ok(host.memo.map.size <= 64, `bounded: ${host.memo.map.size}`);
  const kinds = new Set([...host.memo.map.values()].map((e) => e.kind));
  for (const k of ["stage", "party", "hud"]) assert.ok(kinds.has(k), `${k} kept through the frame`);
  assert.equal(host.pump(NOW + 1000), true);
  const built = [...host.memo.map.values()].filter((e) => e.kind !== "nameplate").map((e) => e.kind).sort();
  assert.deepEqual(built, ["hud", "party", "stage"], "the pump prewarmed them for the next frame");
  const vm = host.memo.map.get('stage|{"width":960,"height":200}').vm;
  assert.equal(host.view("stage", { width: 960, height: 200 }), vm, "the render after the broadcast hits the memo");
  assert.deepEqual(mod.errors, []);
});
