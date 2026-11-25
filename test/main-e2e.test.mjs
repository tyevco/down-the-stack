// Round 4's owner decisions end to end: main.js and host.js in the mock herdr runtime, every role
// mounted on one module graph (one VM, as herdr runs a window) over live data in herdr's shapes and
// the real layout, driven by the 1 s timers, clicks and commands. The areas' own tests check each
// piece with view models or a fake host; these check that the pieces meet.
//  1. A Contractor (the 7th new agent of a game day) is told when it will be hired, in the party
//     row, the pane header and the stage; at the 04:00 game day turn it is promoted to a saved hero
//     that keeps its name, level, XP, class, seat and pane, with a "Hired: … (was a contractor)" line.
//  2. The Herd panel's Stage strip switch shows and hides the stage whoever hid it, finding the
//     stage block by content; it is disabled when the layout has no stage.
//  3. A blocked sub-agent without a pane counts in "N need you", the group "!" and the rail badge;
//     clicking it runs terminal.peek.
//  5. A pane header in a 420 px split shows HP / XP bars, its terminal title cut sooner with the
//     whole title in a tooltip; none at 400 px.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const M = await import("../tools/mock/index.mjs");

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
