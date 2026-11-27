// Round 4's owner decisions end to end: main.js and host.js in the mock herdr runtime, every role
// mounted on one module graph (one VM, as herdr runs a window) over live data in herdr's shapes and
// the real layout, driven by the 1 s timers, clicks and commands. The areas' own tests check each
// piece with view models or a fake host; these check that the pieces meet.
//  1. A Contractor (the 7th new agent of a game day) is told when it will be hired, in the party
//     row, the pane header and the stage; at the 04:00 game day turn it is promoted to a saved hero
//     that keeps its name, level, XP, class, seat and pane, with a "Hired: … (was a contractor)" line.
//     Its open character sheet follows it to the roster id without closing (round 4b).
//  2. The Herd panel's Stage strip switch shows and hides the stage whoever hid it, finding the
//     stage block by content; it is disabled when the layout has no stage.
//  3. A blocked sub-agent without a pane counts in "N need you", the group "!" and the rail badge;
//     clicking it runs terminal.peek. Repeated clicks on "N need you" walk the list without
//     showing one twice running, with herdr's focus emulated (round 4b).
//  5. A pane header in a 420 px split shows HP / XP bars, its terminal title cut sooner with the
//     whole title in a tooltip; none at 400 px. A fresh header shows no bars before herdr reports
//     its width, and its chip is never clipped (round 4b U1).
// Round 4b also: a promoted Contractor keeps its look (R1); restarting an agent on a full roster
// keeps its hero, and a hero off duty makes room only after its 15-minute grace (R2); the hires of
// the 04:00 turn are one header note by the camp (U3). Round 4c: an off-duty hero's note shows its
// short form whole by the camp, never over another hero's room.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const M = await import("../tools/mock/index.mjs");
const G = await import("../tools/mock/gates.mjs");

const MAIN = path.join(M.REPO, "mods", "down-the-stack", "main.js");
const SAVE = `${M.APP_HOME}/data/down-the-stack/save.json`;

let graphN = 0;
const hostOf = async (mod) => (await mod.import("./host.js")).getHost();
const runs = (name) => M.calls().run.filter((c) => c.name === name);
const tipOf = (n) => n?.methods.find((x) => x[0] === "tooltip")?.[1][0] ?? null;
function textUnder(n) {
  if (!n) return "";
  return [n.type === "text" ? n.text : "", ...n.children.map(textUnder)].filter(Boolean).join(" ");
}
/** Every tooltip in a copy's tree. */
const tips = (m) => m.findAll((n) => tipOf(n) != null).map(tipOf);
/** The layout node with this id, as herdr's layout() would show it now. */
function nodeOf(id, root = M.fixture().layout) {
  if (!root || typeof root !== "object") return null;
  if (root.id === id) return root;
  for (const k of root.children ?? []) { const f = nodeOf(id, k); if (f) return f; }
  return null;
}
/** The live data of a window with `n` working agents in one space, each with its pane. */
function liveOf(n, over = {}) {
  const fx = M.sampleFixture(n);
  for (const a of fx.agents) a.status = "working";
  for (const p of fx.panes) p.status = "working";
  for (const t of fx.terminals) if (t.parent == null) t.status = "working";
  return { ...fx, ...over };
}
/** Every hex colour a node and its subtree are drawn with (bg, border and text colours). */
function coloursUnder(n, out = new Set()) {
  if (!n) return out;
  for (const [m, a] of n.methods ?? []) if (/^(bg|border_color|text_color)$/.test(m) && typeof a[0] === "string") out.add(a[0].toUpperCase());
  for (const k of n.children ?? []) coloursUnder(k, out);
  return out;
}
/** A terminal's agent, pane and terminal leave herdr's lists (its pane closed). */
function closeTerminal(addr) {
  const fx = M.fixture();
  const gone = fx.agents.find((a) => a.address === addr);
  M.updateFixture({
    agents: fx.agents.filter((a) => a.address !== addr), panes: fx.panes.filter((p) => p.terminal !== addr),
    terminals: fx.terminals.filter((t) => t.address !== addr && t.parent !== addr),
  });
  return gone;
}
/** A new terminal (a new address) opens in `pane` with this agent's program and place. */
function openTerminal(like, addr, pane) {
  const fx = M.fixture();
  const a = { ...like, address: addr, pane, seq: like.seq + 5000, status: "working" };
  M.updateFixture({ agents: [...fx.agents, a], panes: [...fx.panes, M.paneFor(a)], terminals: [...fx.terminals, M.terminalFor(a)] });
  return a;
}
const DAY = 86400000;

/**
 * Mount roles on one graph (the first one sets the live data and the clock), let the save load and
 * the first ticks run, then give each copy its size (a copy still loading draws no sized root).
 */
async function rig(roles, fixture, nowMs) {
  const g = `e2e-${++graphN}`;
  const out = {};
  let first = true;
  for (const [key, props] of roles) {
    out[key] = await M.mountMod(MAIN, { props, graph: g, fixture: first ? fixture : undefined, nowMs: first ? nowMs : undefined });
    first = false;
  }
  out.host = await hostOf(out[roles[0][0]]);
  out.graph = g;
  await M.tickAll(1000);
  await M.tickAll(1000);
  assert.equal(out.host.ready, true);
  for (const [key, , w, h] of roles) if (w) { out[key].size(w, h); out[key].render(); }
  return out;
}

test("decision 1: the 7th new agent of a game day plays as a Contractor, told when it is hired; at 04:00 it is promoted, keeping its name, level, XP, class and pane", async () => {
  M.resetState();
  const d = new Date(Date.UTC(2026, 10, 24, 12, 0));
  d.setHours(3, 56, 0, 0); // local time: four minutes before the game day turns
  const start = d.getTime();
  const fx = liveOf(7);
  const r = await rig([
    ["stage", { role: "stage" }, 1600, 210],
    ["party", { role: "party" }, 268, 900],
    ["plate", { role: "nameplate", pane: "p7", terminal: "t7" }, 900, 34],
  ], fx, start);
  const { host } = r;
  const heroes = host.world.state.heroes;
  assert.equal(heroes.length, 6, "six new heroes a game day, the first day included");
  const row = host.view("party", { width: 268, nowMs: M.mockNow() }).groups.flatMap((g) => g.rows).find((x) => x.address === "t7");
  assert.ok(row && row.heroId < 0, "t7's hero is a Contractor (negative id)");
  const name = row.name;
  // told when: the party row, the pane header and the stage hero say the same engine sentence
  for (const m of [r.party, r.plate, r.stage]) m.render();
  const when = /Hired at the next 04:00 game day \(today: 0 of 6 hires left\)/;
  assert.ok(tips(r.party).some((t) => t.includes(name) && when.test(t)), tips(r.party).filter((t) => t.includes(name)).join("\n---\n"));
  assert.ok(tips(r.plate).some((t) => when.test(t)), tips(r.plate).join("\n---\n"));
  assert.ok(tips(r.stage).some((t) => t.includes(name) && when.test(t)), "the stage hero's tooltip");
  // it levels meanwhile (the herd's median minus three, then its own fights): all of it carries over
  const c = host.world.rt.contractors.get("t7");
  Object.assign(c, { L: 12, xp: 345, cls: 2 });
  const kit = c.eq.map((it) => it && { base: it.base, ilvl: it.ilvl, rar: it.rar });
  assert.ok(c.eq.every((it) => it && it.uid < 0), "a Contractor's reference kit is not saved gear");
  // the game day turns at 04:00 local: hiring reopens and the Contractor is hired first
  for (let i = 0; i < 4 * 60 + 5; i++) await M.tickAll(1000);
  const hero = host.world.state.heroes.find((h) => h.name === name);
  assert.ok(hero, "promoted to a saved hero");
  assert.ok(hero.id > 0);
  assert.equal(host.world.state.heroes.length, 7);
  const bound = host.view("party", { width: 268, nowMs: M.mockNow() }).groups.flatMap((g) => g.rows).find((x) => x.address === "t7");
  assert.equal(bound.heroId, hero.id, "the same terminal, now bound to the saved hero");
  assert.equal(bound.name, name);
  assert.deepEqual([hero.L, hero.xp >= 345, hero.cls], [12, true, 2], "level, XP and class kept");
  assert.deepEqual(hero.eq.map((it) => it && { base: it.base, ilvl: it.ilvl, rar: it.rar }), kit, "the same kit");
  assert.ok(hero.eq.every((it) => it && it.uid > 0), "now real saved items (Alpha)");
  assert.equal(hero.addr, "t7");
  const line = host.world.state.herd.log.find((e) => e[1] === "hired");
  assert.ok(line, "a journal line of kind hired");
  assert.equal(line[3], `Hired: ${name} (was a contractor)`);
  // its kit is saved gear now, and the pane header no longer says contractor
  r.plate.render();
  assert.ok(!tips(r.plate).some((t) => /contractor/i.test(t)), tips(r.plate).join("\n---\n"));
  await M.tickAll(31000);
  await host.flush();
  const disk = M.memfs.readText(SAVE);
  assert.ok(disk && disk.includes(name), "the promoted hero is in save.json");
  for (const m of [r.stage, r.party, r.plate]) assert.deepEqual(m.errors, []);
});

test("decision 1: a Contractor's open character sheet follows its promotion to the roster hero without closing; opening that hero's sheet keeps the dialog (round 4b U5)", async () => {
  M.resetState();
  const d = new Date(Date.UTC(2026, 10, 24, 12, 0));
  d.setHours(3, 56, 0, 0);
  const r = await rig([
    ["stage", { role: "stage" }, 1600, 210],
    ["party", { role: "party" }, 268, 900],
    ["plate", { role: "nameplate", pane: "p7", terminal: "t7" }, 900, 34],
  ], liveOf(7), d.getTime());
  const { host } = r;
  const c = host.world.rt.contractors.get("t7");
  assert.ok(c && c.id < 0, "t7 plays a Contractor");
  // its sheet, opened from its pane header (the hero part's click)
  r.plate.render();
  r.plate.fire("np-hero-p7");
  const opened = M.calls().openOverlay.filter((x) => x.spec?.props?.role === "sheet");
  assert.equal(opened.length, 1);
  assert.equal(opened[0].spec.props.heroId, c.id);
  const sheet = await M.mountMod(MAIN, { props: { ...opened[0].spec.props, overlay: opened[0].id }, graph: r.graph });
  sheet.size(760, 500);
  sheet.render();
  assert.ok(sheet.text().includes(c.name), "the Contractor's sheet");
  const overlays = () => [M.calls().openOverlay.length, M.calls().closeOverlay.length];
  const before = overlays();
  // the game day turns at 04:00: the Contractor is hired with a roster id
  for (let i = 0; i < 4 * 60 + 5; i++) await M.tickAll(1000);
  const hero = host.world.state.heroes.find((h) => h.name === c.name);
  assert.ok(hero && hero.id > 0, "promoted");
  sheet.render();
  assert.ok(sheet.text().includes(hero.name) && !/left the roster/.test(sheet.text()), "the open sheet shows the promoted hero");
  assert.deepEqual(overlays(), before, "the dialog was neither closed nor opened again");
  assert.equal(host.overlays.sheet.heroId, hero.id, "the host's dialog registry follows it");
  // opening the promoted hero's sheet (its pane header, its party row) keeps the open dialog
  r.plate.render();
  r.plate.fire("np-hero-p7");
  assert.deepEqual(overlays(), before, "the header click keeps the dialog");
  const { openSheet } = await sheet.import("./ui/party.js");
  openSheet(hero.id);
  assert.deepEqual(overlays(), before, "so does any openSheet for that hero");
  // another hero's sheet still replaces it
  openSheet(host.world.state.heroes[0].id);
  assert.equal(M.calls().closeOverlay.length, before[1] + 1);
  for (const m of [r.stage, r.party, r.plate, sheet]) assert.deepEqual(m.errors, []);
});

test("decision 1 (round 4b R1): a Contractor promoted at 04:00 keeps its hoodie and hat in the party, its pane header and the stage, and after a restart", async () => {
  M.resetState();
  const d = new Date(Date.UTC(2026, 10, 24, 12, 0));
  d.setHours(3, 56, 0, 0);
  const roles = [
    ["stage", { role: "stage" }, 1600, 210],
    ["party", { role: "party" }, 268, 900],
    ["plate", { role: "nameplate", pane: "p7", terminal: "t7" }, 900, 34],
  ];
  const r = await rig(roles, liveOf(7), d.getTime());
  const c = r.host.world.rt.contractors.get("t7");
  assert.ok(c && c.id < 0, "t7 plays a Contractor");
  // what each copy draws for t7's hero: the view models' colours, and the rendered elements carry them
  const look = (rr) => {
    const { host } = rr;
    const now = M.mockNow();
    const id = host.world.rt.bind.get("t7");
    const st = host.view("stage", { width: 1600, height: 210, nowMs: now }).heroes.find((h) => h.address === "t7");
    const row = host.view("party", { width: 268, nowMs: now }).groups.flatMap((g) => g.rows).find((x) => x.address === "t7");
    const plate = host.view("nameplate", { terminal: "t7", pane: "p7" });
    for (const k of ["stage", "party", "plate"]) rr[k].render();
    const drawn = {
      stage: coloursUnder(rr.stage.node(st.key)), party: coloursUnder(rr.party.node(`pr-${row.key}`)), plate: coloursUnder(rr.plate.node("np-hero-p7")),
    };
    const hoodie = st.colors.hoodie.toUpperCase();
    const hat = st.hat ? st.hat.color.toUpperCase() : null;
    assert.ok(hat, "a hat");
    assert.ok(drawn.stage.has(hoodie) && drawn.stage.has(hat), `the stage draws ${hoodie} / ${hat}: ${[...drawn.stage]}`);
    assert.ok(drawn.party.has(hoodie), `the party row draws ${hoodie}: ${[...drawn.party]}`);
    assert.ok(drawn.plate.has(hoodie), `the pane header draws ${hoodie}: ${[...drawn.plate]}`);
    return { id, hoodie, hat, party: row.colors.hoodie.toUpperCase(), plate: plate.colors.hoodie.toUpperCase() };
  };
  const before = look(r);
  assert.deepEqual([before.party, before.plate], [before.hoodie, before.hoodie], "one hoodie everywhere");
  for (let i = 0; i < 4 * 60 + 5; i++) await M.tickAll(1000);
  const after = look(r);
  assert.ok(after.id > 0, "promoted");
  assert.deepEqual({ ...after, id: 0 }, { ...before, id: 0 }, "the same look after its promotion");
  // a restart (a new VM loads the save): the promoted hero keeps it
  await M.tickAll(31000);
  await r.host.flush();
  for (const m of M.mounted()) await m.close();
  const r2 = await rig(roles, undefined, undefined);
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  const again = look(r2);
  assert.equal(again.id, after.id, "the same hero on t7");
  assert.deepEqual({ ...again, id: 0 }, { ...before, id: 0 }, "and the same look after a restart");
  for (const m of [r2.stage, r2.party, r2.plate]) assert.deepEqual(m.errors, []);
});

test("round 4b R2: restarting an agent on a full roster keeps its hero while Contractors wait; a hero off duty makes room for one only after 15 minutes", async () => {
  M.resetState();
  const start = Date.UTC(2026, 10, 24, 12, 0);
  // the save: 29 heroes of Lv 12 last seen yesterday on another seat (Lv 10+: never let go)
  const W = await import("../mods/down-the-stack/game/world.js");
  const Hr = await import("../mods/down-the-stack/game/heroes.js");
  const w0 = W.createWorld({ nowMs: start - DAY, seed: 5 });
  for (let i = 0; i < 29; i++) {
    const h = Hr.newHero(w0.state, { seat: "bench/claude", ord: i, nowMs: start - DAY });
    h.L = 12;
    w0.state.heroes.push(h);
  }
  M.memfs.write(SAVE, W.serialize(w0), { mkdirs: true });
  const r = await rig([["party", { role: "party" }, 268, 900], ["stage", { role: "stage" }, 1600, 210]], liveOf(3), start);
  const { host } = r;
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  const world = () => host.world;
  assert.equal(world().state.heroes.length, 30, "t1 is the 30th hero");
  const mine = world().state.heroes.find((h) => h.id === world().rt.bind.get("t1"));
  assert.ok(mine && mine.L < 10);
  assert.ok(world().rt.contractors.has("t2") && world().rt.contractors.has("t3"), "t2 and t3 wait as Contractors: the roster is full");
  const hireTip = (addr) => {
    r.party.render();
    const name = world().rt.contractors.get(addr)?.name;
    return tips(r.party).find((t) => name && t.includes(name) && /Hired|hired/.test(t)) ?? "";
  };
  assert.match(hireTip("t2"), /Hired when a roster slot frees \(a retire, or a hero below Lv 10 off duty for 15 min\)/);
  // the person restarts t1's agent: its pane's terminal ends, a new one opens in the same pane 3 s later
  const was = closeTerminal("t1");
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  assert.ok(world().state.heroes.includes(mine), "not let go while its agent restarts");
  openTerminal(was, "t99", was.pane);
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  assert.equal(world().rt.bind.get("t99"), mine.id, "the new terminal plays its hero again");
  assert.ok(world().rt.contractors.has("t2") && world().rt.contractors.has("t3"), "the Contractors still wait");
  assert.ok(!world().state.herd.log.some((e) => e[1] === "leave" || e[1] === "hired"), "nobody let go, nobody hired");
  r.party.render();
  assert.ok(r.party.text().includes(mine.name.split(" ")[0]), "the party shows it");
  // the agent stops for good: its hero makes room once it has been off duty for 15 minutes
  closeTerminal("t99");
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  assert.match(hireTip("t2"), /Hired in about 15 min, once a hero below Lv 10 has been off duty for 15 min \(unless its agent comes back\)/);
  for (let i = 0; i < 14 * 60; i++) await M.tickAll(1000);
  assert.ok(world().rt.contractors.has("t2"), "still in its grace after 14 minutes");
  assert.ok(world().state.heroes.includes(mine));
  for (let i = 0; i < 70; i++) await M.tickAll(1000);
  assert.ok(!world().state.heroes.includes(mine), "let go after 15 minutes");
  const t2 = world().state.heroes.find((h) => h.id === world().rt.bind.get("t2"));
  assert.ok(t2 && t2.id > 0 && !t2.contractor, "t2 joined the roster");
  assert.ok(world().rt.contractors.has("t3"), "one slot, one hire");
  const leave = world().state.herd.log.find((e) => e[1] === "leave");
  assert.equal(leave?.[5], mine.name, "the journal names the hero let go");
  for (const m of [r.party, r.stage]) assert.deepEqual(m.errors, []);
});

test("decision 2: the Herd panel's Stage strip switch shows and hides the stage whoever hid it, found by content; disabled without a stage", async () => {
  M.resetState();
  const fx = liveOf(2);
  const r = await rig([["party", { role: "party" }, 268, 600], ["stage", { role: "stage" }, 960, 210], ["herd", { role: "herd", overlay: "o-herd", tab: "settings" }, 760, 520]], fx, Date.UTC(2026, 10, 24, 12, 0));
  const sw = () => r.herd.node("hd-sw-stage");
  assert.ok(sw(), "the switch is on the Settings tab");
  const row = r.herd.text();
  assert.ok(row.indexOf("Stage strip") >= 0 && row.indexOf("Stage strip") < row.indexOf("HUD strip"), "beside (before) the HUD strip switch");
  assert.equal(tipOf(sw()), "Hide the stage strip");
  // hide: herdr's layout.hide on the stage block; the stage copy stops drawing
  r.herd.fire("hd-sw-stage");
  await M.flush();
  assert.deepEqual(runs("layout.hide").map((x) => x.args), [{ id: "stage" }]);
  assert.equal(nodeOf("stage").hidden, true);
  await M.tickAll(1000);
  r.herd.render();
  assert.equal(tipOf(sw()), "Show the stage strip");
  // hidden by hand elsewhere (keys, herdr-app do, an earlier install's .state): shown all the same
  await M.tickAll(1000);
  r.herd.fire("hd-sw-stage");
  await M.flush();
  assert.deepEqual(runs("layout.show").map((x) => x.args), [{ id: "stage" }]);
  assert.equal(nodeOf("stage").hidden, false);
  M.calls().run.length = 0;
  const herdr = await import("herdr");
  herdr.run("layout.hide", { id: "stage" });
  await M.tickAll(3000);
  r.herd.render();
  assert.equal(tipOf(sw()), "Show the stage strip");
  r.herd.fire("hd-sw-stage");
  await M.flush();
  assert.equal(nodeOf("stage").hidden, false, "a stage the host did not hide comes back");
  // the collapse never takes it back: still shown a minute after nothing works
  M.updateFixture({ agents: M.fixture().agents.map((a) => ({ ...a, status: "idle" })) });
  for (let i = 0; i < 70; i++) await M.tickAll(1000);
  assert.equal(nodeOf("stage").hidden, false);
  // found by content: a layout whose stage block has another id
  M.resetState();
  const lay = structuredClone(liveOf(1).layout);
  const st = nodeOf("stage", lay);
  st.id = "game-strip";
  const r2 = await rig([["herd", { role: "herd", overlay: "o-herd", tab: "settings" }, 760, 520]], { ...liveOf(1), layout: lay }, Date.UTC(2026, 10, 24, 12, 0));
  r2.herd.fire("hd-sw-stage");
  await M.flush();
  assert.deepEqual(runs("layout.hide").map((x) => x.args), [{ id: "game-strip" }]);
  // no stage in the layout: disabled, says why, runs nothing
  M.resetState();
  const bare = structuredClone(liveOf(1).layout);
  (function cut(n) { if (n && n.children) { n.children = n.children.filter((k) => !(k && k.id === "stage")); n.children.forEach(cut); } })(bare);
  const r3 = await rig([["herd", { role: "herd", overlay: "o-herd", tab: "settings" }, 760, 520]], { ...liveOf(1), layout: bare }, Date.UTC(2026, 10, 24, 12, 0));
  assert.equal(tipOf(r3.herd.node("hd-sw-stage")), "This layout has no stage");
  M.calls().run.length = 0;
  r3.herd.fire("hd-sw-stage");
  await M.flush();
  assert.deepEqual(M.calls().run.filter((x) => x.name.startsWith("layout.")), []);
  for (const m of [r.party, r.stage, r.herd, r2.herd, r3.herd]) assert.deepEqual(m.errors, []);
});

test("decision 3: a blocked sub-agent without a pane counts in 'N need you', the group '!' and the rail badge; a click peeks it", async () => {
  M.resetState();
  const fx = liveOf(3);
  // t90 is t1's sub-agent (terminals() parent), not in agents(), no pane; herdr's raw word "blocked"
  const sub = fx.terminals.find((t) => t.address === "t90");
  sub.status = "blocked";
  const r = await rig([["party", { role: "party" }, 268, 600], ["rail", { role: "party" }, 52, 600], ["stage", { role: "stage" }, 960, 210]], fx, Date.UTC(2026, 10, 24, 12, 0));
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  r.party.render();
  const chip = r.party.node("party-needyou");
  assert.ok(chip, "the chip shows with no blocked hero");
  assert.equal(textUnder(chip), "1 needs you");
  assert.match(tipOf(chip), /sub-agent/);
  const group = r.party.findAll((n) => typeof n.id === "string" && n.id.startsWith("pg-"))[0];
  assert.ok(textUnder(group).includes("!"), "the group's '!'");
  r.party.fire("party-needyou");
  assert.deepEqual(runs("terminal.peek").map((x) => x.args), [{ terminal: "t90" }]);
  assert.deepEqual(runs("pane.focus"), [], "herdr's peek, never 'no such pane'");
  // the 44 px rail: a '!' badge on the parent's portrait; its click peeks the sub-agent
  r.rail.render();
  const hero = r.host.world.state.heroes.find((h) => h.addr === "t1");
  const badge = r.rail.node(`pb-h:${hero.id}`);
  assert.ok(badge, "the rail badge");
  assert.match(tipOf(badge), /sub-agent .* waits for you/);
  r.rail.fire(`pb-h:${hero.id}`);
  assert.deepEqual(runs("terminal.peek").map((x) => x.args), [{ terminal: "t90" }, { terminal: "t90" }]);
  assert.deepEqual(runs("pane.focus"), [], "the badge does not also click the row");
  // the sub-agent answered: nothing waits
  M.updateFixture({ terminals: M.fixture().terminals.map((t) => (t.address === "t90" ? { ...t, status: "working" } : t)) });
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  r.party.render();
  assert.equal(r.party.node("party-needyou"), null);
  for (const m of [r.party, r.rail, r.stage]) assert.deepEqual(m.errors, []);
});

test("decision 3: the 'N need you' walk never shows one twice running, before or after herdr's next broadcast (herdr's focus emulated: pane.focus moves it, terminal.peek does not; round 4b U4)", async () => {
  M.resetState();
  const fx = liveOf(4);
  // t2 is blocked (a hero with its pane); t90 (t1's sub-agent) and t91 (t3's) are blocked, no pane
  const a2 = fx.agents.find((a) => a.address === "t2");
  a2.status = "blocked";
  a2.seq += 1000;
  fx.panes.find((p) => p.terminal === "t2").status = "blocked";
  fx.terminals.find((t) => t.address === "t2").status = "blocked";
  fx.terminals.find((t) => t.address === "t90").status = "blocked";
  const t91 = structuredClone(fx.terminals.find((t) => t.address === "t90"));
  Object.assign(t91, { address: "t91", parent: "t3", title: "sub-agent: lint fixes", status: "blocked" });
  fx.terminals.push(t91);
  const r = await rig([["party", { role: "party" }, 268, 600], ["stage", { role: "stage" }, 960, 210]], fx, Date.UTC(2026, 10, 24, 12, 0));
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  r.party.render();
  assert.equal(textUnder(r.party.node("party-needyou")), "3 need you");
  // herdr: pane.focus moves focused() (the world sees it at its next snapshot); a peek does not
  const herdrFocus = (c) => {
    if (!c || c.name !== "pane.focus") return;
    const ag = M.fixture().agents.find((a) => a.pane === c.args.pane);
    M.updateFixture({
      focused: { ...M.fixture().focused, pane: ag.pane, terminal: ag.address, space: ag.space, tab: ag.tab },
      agents: M.fixture().agents.map((a) => ({ ...a, focused: a.address === ag.address })),
      panes: M.fixture().panes.map((p) => ({ ...p, focused: p.pane === ag.pane })),
    });
  };
  const click = () => {
    M.calls().run.length = 0;
    r.party.fire("party-needyou");
    // herdr draws a copy that asked for it (cx.notify) before the next click lands
    if (r.party.copy.dirty) r.party.render();
    const c = M.calls().run.find((x) => x.name === "pane.focus" || x.name === "terminal.peek");
    herdrFocus(c);
    return c ? `${c.name} ${c.args.pane ?? c.args.terminal}` : "nothing";
  };
  // three clicks before any broadcast: three different ones
  const quick = [click(), click(), click()];
  assert.equal(new Set(quick).size, 3, quick.join(" | "));
  assert.deepEqual(quick.slice().sort(), ["pane.focus p2", "terminal.peek t90", "terminal.peek t91"]);
  // the walk goes on once the world has seen the focus its own click moved: no repeat at the seam
  const seq = quick.slice();
  for (let k = 0; k < 6; k++) {
    await M.tickAll(1000);
    await M.tickAll(1000);
    r.party.render();
    seq.push(click());
  }
  for (let k = 1; k < seq.length; k++) assert.notEqual(seq[k], seq[k - 1], seq.join(" | "));
  // a full lap shows each of the three once
  for (let k = 0; k + 3 <= seq.length; k += 3) assert.equal(new Set(seq.slice(k, k + 3)).size, 3, seq.join(" | "));
  // the person focuses another row by hand: the walk starts after it
  herdrFocus({ name: "pane.focus", args: { pane: fx.agents.find((a) => a.address === "t4").pane } });
  await M.tickAll(1000);
  await M.tickAll(1000);
  r.party.render();
  assert.equal(click(), "terminal.peek t90", "after t4 the list wraps to its first entry");
  for (const m of [r.party, r.stage]) assert.deepEqual(m.errors, []);
});

test("decision 5: a pane header in a 420 px split shows compact HP / XP bars and cuts herdr's title sooner, its whole text in a tooltip; none at 400 px", async () => {
  M.resetState();
  const fx = liveOf(2);
  const title = "Fix the flaky payment webhook retries before the release";
  fx.agents[0].title = title;
  fx.panes[0].title = title;
  const bars = (m) => m.node("np-bars-p1");
  const widths = (n) => n.children.flatMap((g) => g.children).filter((x) => x.type !== "text" && x.methods.some((y) => y[0] === "rounded")).map((x) => x.methods.find((y) => y[0] === "w")[1][0]);
  const r = await rig([["stage", { role: "stage" }, 960, 210], ["p420", { role: "nameplate", pane: "p1", terminal: "t1" }, 420, 34], ["p1200", { role: "nameplate", pane: "p1", terminal: "t1" }, 1200, 34], ["p400", { role: "nameplate", pane: "p1", terminal: "t1" }, 400, 34]], fx, Date.UTC(2026, 10, 24, 12, 0));
  for (const k of ["p420", "p1200", "p400"]) { r[k].render(); assert.deepEqual(r[k].errors, [], k); }
  assert.deepEqual(widths(bars(r.p420)), [28, 36], "compact bars in a 420 px split");
  assert.deepEqual(widths(bars(r.p1200)), [48, 64], "full bars in a wide pane");
  assert.equal(bars(r.p400), null, "below 420 px the title keeps the room");
  for (const k of ["p420", "p1200", "p400"]) assert.ok(tips(r[k]).includes(title), `${k}: the whole title on hover`);
  // the bars hold when the title changes (hysteresis, width-only)
  M.updateFixture({ panes: M.fixture().panes.map((p) => (p.pane === "p1" ? { ...p, title: "x" } : p)) });
  await M.tickAll(1000);
  r.p420.render();
  assert.deepEqual(widths(bars(r.p420)), [28, 36]);
});

/**
 * Lays recorded pane-header trees out in Chromium (the preview's HTML) and returns what is wrong:
 * a chip clipped by the header or its group, or its text cut. null when Playwright is missing.
 */
async function chipProblems(frames) {
  let pw;
  try { pw = (await import("node:module")).createRequire(import.meta.url)("playwright"); } catch { return null; }
  const { newContext, blockHtml, documentHtml } = await import("../tools/preview/render.mjs");
  const ctx = newContext({ zoom: 1, theme: M.resolveTheme("graphite") });
  const body = frames.map((f, i) => `<div data-case="${i}" style="width:${f.W}px;height:34px;margin-bottom:2px">${blockHtml(f.tree, ctx, { width: f.W, height: 34 })}</div>`).join("");
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1500, height: 600 });
    await page.setContent(documentHtml({ body, ctx, title: "plates" }).replace(/html,body\{width:[^}]*\}/, ""), { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready);
    return await page.evaluate((frames) => {
      const out = [];
      frames.forEach((f, i) => {
        const wrap = document.querySelector(`[data-case="${i}"]`);
        const head = wrap.querySelector(`[data-id="pane-head-${f.pane}"]`);
        const chip = wrap.querySelector(`[data-id="np-chip-${f.pane}"]`) ?? (head && [...head.children].reverse().find((e) => e.textContent.trim() === f.chip));
        if (!head || !chip) { out.push(`${f.label}: no ${head ? "chip" : "header"}`); return; }
        const r = chip.getBoundingClientRect();
        let left = r.left, right = r.right;
        for (let e = chip.parentElement; e && e !== head.parentElement; e = e.parentElement) {
          const cs = getComputedStyle(e);
          if (cs.overflowX === "visible") continue;
          const p = e.getBoundingClientRect();
          left = Math.max(left, p.left + (parseFloat(cs.borderLeftWidth) || 0));
          right = Math.min(right, p.right - (parseFloat(cs.borderRightWidth) || 0));
        }
        if (left > r.left + 0.5 || right < r.right - 0.5) out.push(`${f.label}: the chip is clipped (${Math.round(Math.max(0, right - left))} of ${Math.round(r.width)} px shown)`);
        const txt = chip.firstElementChild ?? chip;
        if (txt.scrollWidth > txt.clientWidth + 0.5) out.push(`${f.label}: the chip's text is cut`);
      });
      return out;
    }, frames.map((f) => ({ label: f.label, W: f.W, pane: f.pane, chip: f.chip })));
  } finally {
    await browser.close();
  }
}

test("decision 5 (round 4b U1): a fresh pane header draws no bars before herdr reports its width; then none at 400 px and compact bars at 420 px, its chip whole in every frame", async (t) => {
  M.resetState();
  const fx = liveOf(2);
  const title = "Fix the flaky payment webhook retries before the release";
  fx.agents[0].title = title;
  fx.panes[0].title = title;
  const r = await rig([["stage", { role: "stage" }, 960, 210]], fx, Date.UTC(2026, 10, 24, 12, 0));
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  const vm = r.host.view("nameplate", { terminal: "t1", pane: "p1" });
  assert.ok(vm.chip && vm.chip.text, "a status chip");
  const bars = (m) => m.node("np-bars-p1");
  const widths = (n) => n.children.flatMap((g) => g.children).filter((x) => x.type !== "text" && x.methods.some((y) => y[0] === "rounded")).map((x) => x.methods.find((y) => y[0] === "w")[1][0]);
  const frames = [];
  for (const W of [400, 420]) {
    // herdr mounts the header copy, lays its first frame out, and only then reports its width
    // (gpui-shell SizeObserver): the mock keeps a size given before that frame until it is drawn
    const m = await M.mountMod(MAIN, { props: { role: "nameplate", pane: "p1", terminal: "t1" }, graph: r.graph });
    m.size(W, 34);
    m.render();
    assert.equal(bars(m), null, `${W}: no bars in the first frame (no width yet)`);
    assert.ok(m.node("np-chip-p1"), `${W}: the chip in the first frame`);
    frames.push({ label: `fresh ${W} first frame`, W, tree: m.tree, pane: "p1", chip: vm.chip.text });
    assert.equal(m.dirty, true, `${W}: herdr's size report asks for a redraw`);
    await M.tickAll(1000);
    m.render();
    if (W === 400) assert.equal(bars(m), null, "400 px: the title keeps the room");
    else assert.deepEqual(widths(bars(m)), [28, 36], "420 px: compact bars once measured");
    assert.ok(m.node("np-chip-p1"), `${W}: the chip`);
    assert.ok(tips(m).includes(title), `${W}: the whole title on hover`);
    frames.push({ label: `fresh ${W} measured`, W, tree: m.tree, pane: "p1", chip: vm.chip.text });
    assert.deepEqual(m.errors, []);
  }
  const bad = await chipProblems(frames);
  if (bad == null) return G.skipGate(t, "pane headers in Chromium", "Playwright is not installed");
  assert.deepEqual(bad, []);
});

test("round 4b U3: the six hires of the 04:00 turn are one header note at the stage's right end, whole, every hire's line in its tooltip, for 18 s", async () => {
  M.resetState();
  const d = new Date(Date.UTC(2026, 10, 24, 12, 0));
  d.setHours(3, 58, 0, 0);
  const r = await rig([["stage", { role: "stage" }, 1600, 210], ["party", { role: "party" }, 268, 900]], liveOf(12), d.getTime());
  const { host } = r;
  const waiting = Array.from(host.world.rt.contractors.values()).map((c) => c.name);
  assert.equal(waiting.length, 6, "six Contractors wait for the 04:00 turn");
  const notes = () => r.stage.findAll((n) => typeof n.id === "string" && n.id.startsWith("note:"));
  let k = 0;
  while (!host.world.state.herd.log.some((e) => e[1] === "hired") && k++ < 200) await M.tickAll(1000);
  r.stage.render();
  const [note] = notes();
  assert.ok(note, "a header note at the turn");
  const first = (n) => n.split(" ")[0];
  const hired = host.world.state.herd.log.filter((e) => e[1] === "hired").map((e) => e[5]);
  assert.deepEqual(hired.slice().sort(), waiting.slice().sort(), "all six promoted");
  assert.equal(textUnder(note), `Hired 6 contractors: ${first(hired[0])}, ${first(hired[1])} and 4 more`, "one note, whole");
  assert.equal(tipOf(note), hired.map((n) => `Hired: ${n} (was a contractor)`).join("\n"), "every hire's own line on hover");
  const num = (m) => note.methods.find((x) => x[0] === m)[1][0];
  assert.ok(num("left") + num("w") >= 1600 - 8, `at the right end (${num("left")} + ${num("w")})`);
  // the same note while its six 3 s slots run
  const keys = [];
  for (let i = 0; i < 20; i++) {
    await M.tickAll(1000);
    r.stage.render();
    keys.push(notes()[0]?.id ?? null);
  }
  assert.ok(keys.slice(0, 16).every((x) => x === note.id), keys.join(" | "));
  assert.equal(keys[19], null, "gone once its time has run");
  for (const m of [r.stage, r.party]) assert.deepEqual(m.errors, []);
});

test("round 4c: an off-duty hero's 'chest opened Unreviewed' note shows its short form whole by the camp, never over another hero's room, its whole text on hover", async () => {
  M.resetState();
  const d = new Date(Date.UTC(2026, 10, 24, 12, 0));
  d.setHours(14, 0, 0, 0);
  // twelve agents, each in a space of its own (as the owner's window): a room each, a crowded strip
  const fx = liveOf(12);
  const tab = fx.spaces[0].tabs[0];
  fx.spaces = fx.agents.map((a, i) => ({ ...fx.spaces[0], id: `s${i + 1}`, index: i + 1, name: `team-${i + 1}`, active: i === 0, tabs: [{ ...tab, id: `tab${i + 1}`, panes: 1 }] }));
  fx.agents = fx.agents.map((a, i) => ({ ...a, space: `s${i + 1}`, space_name: `team-${i + 1}`, tab: `tab${i + 1}` }));
  fx.panes = fx.agents.map((a) => ({ ...M.paneFor(a), status: "working" }));
  fx.terminals = fx.agents.map((a) => ({ ...M.terminalFor(a), status: "working" }));
  const r = await rig([["stage", { role: "stage" }, 600, 200], ["party", { role: "party" }, 268, 900]], fx, d.getTime());
  const { host } = r;
  for (let i = 0; i < 60; i++) await M.tickAll(1000);
  const h = host.world.state.heroes.find((x) => x.addr === "t3");
  assert.ok(h, "t3 plays a hero");
  h.name = "Tamsin the Composable";
  closeTerminal("t3");
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  assert.equal(host.world.rt.live.has(h.id), false, "off duty");
  while (host.world.rt.notes.length) await M.tickAll(1000);
  // its chest has waited a day unclaimed: it opens Unreviewed at the next tick
  h.pend = [{ min: 12, fmin: 0, title: "Spike", at: M.mockNow() - DAY - 1000, sealFactor: 1 }];
  const full = "Tamsin the Composable: a chest opened Unreviewed (half value)";
  let note = null;
  for (let i = 0; i < 70 && !note; i++) {
    await M.tickAll(1000);
    r.stage.render();
    note = r.stage.findAll((n) => typeof n.id === "string" && n.id.startsWith("note:")).find((n) => tipOf(n) === full) ?? null;
  }
  assert.ok(note, "the note shows, its whole text on hover");
  // the 600 px strip has room by the camp for "Tamsin: chest Unreviewed", not for the longer forms
  assert.equal(textUnder(note), "Tamsin: chest Unreviewed");
  const num = (m) => note.methods.find((x) => x[0] === m)[1][0];
  const vm = host.view("stage", { width: 600, height: 200, nowMs: M.mockNow() });
  assert.ok(vm.overflow, "a camp");
  assert.ok(Math.abs(num("left") + num("w") - 596) < 0.6, `at the strip's right end, by the camp (${num("left")} + ${num("w")})`);
  // never over another hero's room header: at most the free end of the last room's, past its title
  const last = vm.rooms.reduce((m, x) => (x.x + x.w > m.x + m.w ? x : m));
  for (const room of vm.rooms) if (room !== last) assert.ok(num("left") >= room.x + room.w - 0.5, `clear of ${room.key}`);
  for (const m of [r.stage, r.party]) assert.deepEqual(m.errors, []);
});

// Round 5 (owner decision: "save a slim Contractor record"): the owner's window, 32 agents across
// 25 spaces with 26 saved heroes; the day's six hires are used, so six agents play Contractors and
// level. herdr is closed before 04:00 and opened after it (its core keeps the terminals: the same
// addresses come back), herdr listing a newcomer and two Contractors first and the other four three
// snapshots later. The Contractors come back as themselves and four are hired at their levels (the
// roster's four free slots), longest-running first; the newcomer never takes one of their hires.
// The owner's window before the close, shared by the round 5 tests: 26 saved heroes, the day's hires
// used, the six other agents levelled as Contractors; herdr flushes and closes at about 03:41.
async function contractorsClosedAcross0400() {
  M.resetState();
  const W = await import("../mods/down-the-stack/game/world.js");
  const Hr = await import("../mods/down-the-stack/game/heroes.js");
  const A = await import("../mods/down-the-stack/game/agents.js");
  const d = new Date(Date.UTC(2026, 10, 24, 12, 0));
  d.setHours(3, 40, 0, 0); // local time: twenty minutes before the game day turns
  const start = d.getTime();
  const tz = new Date(start).getTimezoneOffset();
  const NAMES = [
    "ceo-assistant-res-2", "ceo-assistant-writer", "ceo-assistant-search-eng", "ceo-assistant-billing-eng", "pr-review-eng-1",
    "pr-review-eng-2", "pr-review-eng-3", "rnd-qa", "mobile-qa", "docs", "infra", "web-app", "api", "billing", "search",
    "ml-eval", "data-pipe", "design-sys", "release", "security", "perf", "onboarding", "growth", "support", "ops",
  ];
  // agent i lives in space i mod 25 with M.agent's program (claude, codex, pi by turns)
  const agentOf = (i) => M.agent(i, { space: `s${(i % 25) + 1}`, space_name: NAMES[i % 25], tab: `tab${(i % 25) + 1}`, status: "working", focused: false });
  const tab = M.sampleFixture(1).spaces[0].tabs[0];
  const spaces = NAMES.map((name, k) => ({ ...M.sampleFixture(1).spaces[0], id: `s${k + 1}`, index: k + 1, name, active: k === 0, tabs: [{ ...tab, id: `tab${k + 1}`, panes: 2 }] }));
  const fxOf = (list) => ({
    ...M.sampleFixture(0), agents: list, panes: list.map((a) => M.paneFor(a)), terminals: list.map((a) => M.terminalFor(a)), spaces, focused: null,
  });
  const all = Array.from({ length: 32 }, (_, i) => agentOf(i));
  // the save: 26 heroes, each on duty in its agent's terminal; the day's six hires used
  const w0 = W.createWorld({ nowMs: start - 60000, seed: 9 });
  w0.state.herd.day = W.localDay(start, tz);
  w0.state.herd.hired = [w0.state.herd.day, 6];
  for (let i = 0; i < 26; i++) {
    const a = all[i];
    const h = Hr.newHero(w0.state, { seat: A.seatKey(a.space_name, a.space, a.program.key, a.app), sid: a.space, ord: 0, nowMs: start - 60000 });
    h.L = 12 + i;
    h.addr = a.address;
    w0.state.heroes.push(h);
  }
  M.memfs.write(SAVE, W.serialize(w0), { mkdirs: true });
  const roles = [["stage", { role: "stage" }, 1600, 210], ["party", { role: "party" }, 268, 900]];
  const r = await rig(roles, fxOf(all), start);
  const world = () => r.host.world;
  assert.equal(world().state.heroes.length, 26);
  assert.equal(world().rt.live.size, 32, "every agent plays");
  const cAddr = all.slice(26).map((a) => a.address); // t27 … t32
  assert.ok(cAddr.every((x) => world().rt.contractors.has(x)), "the six past the day's hires play as Contractors");
  // they level meanwhile; each its own level, XP and class
  const was = new Map();
  cAddr.forEach((addr, k) => {
    const c = world().rt.contractors.get(addr);
    Object.assign(c, { L: 20 + k * 3, xp: 1000 + k, cls: 1 + (k % 5) });
    c.sp = Hr.autoRanks(c.cls, c.L, c.rev);
  });
  const rowOf = (rr, addr) => rr.host.view("party", { width: 268, nowMs: M.mockNow() }).groups.flatMap((g) => g.rows).find((x) => x.address === addr);
  // herdr closes at about 03:41 (its last save), and opens at 04:10: a new game day
  for (let i = 0; i < 9; i++) await M.tickAll(1000);
  await M.tickAll(31000);
  await r.host.flush();
  for (const addr of cAddr) {
    const c = world().rt.contractors.get(addr);
    assert.ok(c.L >= 20, "levelled");
    was.set(addr, { name: c.name, L: c.L, xp: Math.floor(c.xp), cls: c.cls, hoodie: rowOf(r, addr).colors.hoodie });
  }
  const disk = JSON.parse(M.memfs.readText(SAVE));
  assert.equal(disk.herd.ct.length, 6, "the save holds the six Contractors' records");
  for (const row of disk.herd.ct) assert.ok(JSON.stringify(row).length <= 62, `a slim record: ${JSON.stringify(row)}`);
  for (const m of M.mounted()) await m.close();
  const reopen = new Date(start);
  reopen.setHours(4, 10, 0, 0);
  return { A, all, agentOf, fxOf, roles, rowOf, cAddr, was, reopen };
}

test("round 5: 32 agents, herdr closed across 04:00 and opened again: the Contractors come back as themselves and are hired at their levels; a newcomer listed first takes none of their hires", async () => {
  const { A, all, agentOf, fxOf, roles, rowOf, cAddr, was, reopen } = await contractorsClosedAcross0400();
  // herdr lists a newcomer (an agent started while it was closed) and two Contractors first
  const newcomer = agentOf(32); // t33, rnd-qa / pi: a seat with no hero and no record
  M.setFixture(fxOf([newcomer, ...all.slice(0, 28)]));
  const r2 = await rig(roles, undefined, reopen.getTime());
  const world2 = () => r2.host.world;
  const tip = (addr) => {
    r2.party.render();
    const name = rowOf(r2, addr)?.name;
    return tips(r2.party).find((t) => name && t.includes(name) && /Hired|hired/.test(t)) ?? "";
  };
  assert.equal(world2().state.heroes.length, 28, "the two Contractors listed first are hired at once");
  for (const addr of ["t27", "t28"]) {
    const h = world2().state.heroes.find((x) => x.addr === addr);
    const w = was.get(addr);
    assert.ok(h && h.id > 0, `${addr} hired`);
    assert.deepEqual([h.name, h.L, h.cls], [w.name, w.L, w.cls], `${addr}: the same Contractor, at its level`);
    assert.ok(h.xp >= w.xp && h.xp < w.xp + 100, `${addr}: its XP (${h.xp} from ${w.xp})`);
  }
  assert.ok(world2().rt.contractors.has("t33"), "the newcomer waits as a Contractor: the four free hires are held");
  assert.match(tip("t33"), /Hired in about \d+ s, unless 4 contractors from before the restart come back first · 4 ahead in line \(today: 4 of 6 hires left\)/);
  // the other four are listed three snapshots later
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  M.setFixture(fxOf([newcomer, ...all]));
  for (let i = 0; i < 3; i++) await M.tickAll(1000);
  const S = world2().state;
  assert.equal(S.heroes.length, 30, "the roster is full");
  assert.equal(A.hiredToday(S), 4, "four hires, all to the Contractors");
  for (const addr of cAddr) {
    const w = was.get(addr);
    const row = rowOf(r2, addr);
    const hero = A.heroById(world2(), row.heroId);
    assert.deepEqual([hero.name, hero.L, hero.cls], [w.name, w.L, w.cls], `${addr} is the same Contractor`);
    assert.ok(hero.xp >= w.xp && hero.xp < w.xp + 100, `${addr}: its XP (${hero.xp} from ${w.xp})`);
    assert.equal(row.colors.hoodie, w.hoodie, `${addr} keeps its hoodie`);
    const hired = addr <= "t30";
    assert.equal(hero.id > 0, hired, `${addr} ${hired ? "hired (longest-running first)" : "waits for a slot"}`);
    if (hired) {
      const line = S.herd.log.find((e) => e[1] === "hired" && e[2] === hero.id);
      assert.equal(line?.[4], w.L, `${addr}: "Hired: ${w.name} (was a contractor)" at Lv ${w.L}`);
    }
  }
  assert.ok(!S.herd.log.some((e) => e[1] === "hire" && e[0] >= reopen.getTime()), "no Lv 1 hire");
  assert.match(tip("t31"), /Hired when a roster slot frees \(a retire, or a hero below Lv 10 off duty for 15 min\) \(today: 2 of 6 hires left\)/);
  assert.match(tip("t33"), /Hired when a roster slot frees .* · 2 ahead in line/);
  const roster = r2.host.view("herd", { tab: "roster", nowMs: M.mockNow() }).roster;
  assert.match(roster.count, /^30 \/ 30 heroes · 4 hired today \(6 a day\) · 3 contractors, the next hired when a roster slot frees$/);
  // the next save holds the three waiting Contractors' records, and nothing else
  await M.tickAll(31000);
  await r2.host.flush();
  const disk2 = JSON.parse(M.memfs.readText(SAVE));
  assert.equal(disk2.herd.ct.length, 3);
  for (const m of [r2.stage, r2.party]) assert.deepEqual(m.errors, []);
});

// The usual app start: herdr lists every terminal in its first snapshot, here with the newcomer
// last. Every record is claimed before the newcomer binds (none is held for it), so it must stand
// behind the Contractors back from their records: they are hired at the reconcile's end (step 2b).
test("round 5: herdr opened after 04:00 listing every terminal at once, a newcomer last: the four hires go to the Contractors at their levels, none to the newcomer", async () => {
  const { A, all, agentOf, fxOf, roles, rowOf, cAddr, was, reopen } = await contractorsClosedAcross0400();
  const newcomer = agentOf(32);
  // herdr's order is by space: the six Contractors' terminals among the others, the newcomer last
  const order = [...all.slice(26), ...all.slice(0, 26)].sort((x, y) => Number(x.space.slice(1)) - Number(y.space.slice(1)));
  M.setFixture(fxOf([...order, newcomer]));
  const r2 = await rig(roles, undefined, reopen.getTime());
  const S = r2.host.world.state;
  assert.equal(S.heroes.length, 30, "the roster is full");
  assert.equal(A.hiredToday(S), 4, "four hires");
  assert.ok(!S.herd.log.some((e) => e[1] === "hire" && e[0] >= reopen.getTime()), "no Lv 1 hire: the newcomer took none");
  assert.ok(r2.host.world.rt.contractors.has("t33"), "the newcomer waits as a Contractor");
  for (const addr of cAddr) {
    const w = was.get(addr);
    const row = rowOf(r2, addr);
    const hero = A.heroById(r2.host.world, row.heroId);
    assert.deepEqual([hero.name, hero.L, hero.cls], [w.name, w.L, w.cls], `${addr} is the same Contractor`);
    assert.equal(row.colors.hoodie, w.hoodie, `${addr} keeps its hoodie`);
    assert.equal(hero.id > 0, addr <= "t30", `${addr} ${addr <= "t30" ? "hired (longest-running first)" : "waits for a slot"}`);
  }
  for (const m of [r2.stage, r2.party]) assert.deepEqual(m.errors, []);
});
