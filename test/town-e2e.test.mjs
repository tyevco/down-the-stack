// Localhost, the town (docs/TOWN.md round 1, "The Review Desk opens") end to end: main.js and
// host.js in the mock herdr runtime, the stage and party mounted on one module graph over live data
// in herdr's shapes, through one owner-like day. 32 Claude agents in the owner's 25 spaces
// (TOWN.md §3.3), 30 saved heroes (the 30th an Intern) and two agents playing Contractors; each
// agent works 15-45-minute tasks from 08:00-09:00 to 19:00-21:00, half with a short block, and its
// result is seen 3-30 minutes after it is done (done → idle, D§2.4 rule 1). Between the checks the
// world is pumped by the host itself (host.pump over herdr's live data, 5 s a pump, as the 1 s
// timer would) without rendering; each check renders the copies with the mock's timers.
//   1. Heroes go on duty when their agents rest (a resting hero on duty sits at the Review Desk
//      in its slot) and are back in the field the tick their agent works; the agent-status
//      surfaces keep the agent's words.
//   2. The Review Desk opens by autopilot once a Lv 10+ hero's work was seen (one header note) and
//      buys a level only on demand: never during a day with gold to spare, the morning after a day
//      whose shelf filled and ran dry, at most one a game day, never during an offline settle.
//   3. LGTMs fill the shelf and are spent on the chests the person opens: the coin float reads
//      "+n · LGTM", the Localhost chip counts them, the tab names the approved titles.
//   4. A Contractor promoted mid-day (an Intern's terminal closed for 15 minutes) keeps the
//      credit of the chest it shipped as a Contractor and goes on duty when it rests.
//   5. herdr closed overnight and opened in the morning: the gap settles bounded by the shelf's
//      room, nothing is spent, told or notified while it settles; one Localhost card in the Digest.
//   6. A hot reload keeps the town: the shelf, the counters, job XP and the last approved titles.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const M = await import("../tools/mock/index.mjs");

const MAIN = path.join(M.REPO, "mods", "down-the-stack", "main.js");
const SAVE = `${M.APP_HOME}/data/down-the-stack/save.json`;
const MIN = 60000;
const HOUR = 3600000;
const STEP = 5000; // a fast-forward pump: 5 ticks (T.maxCatchUpTicks), as a timer that fired late
const STAGE_W = 4000; // the owner's widest strip: 25 slots, the rest in the Localhost chip

let graphN = 0;
const tipOf = (n) => n?.methods.find((x) => x[0] === "tooltip")?.[1][0] ?? null;
const tips = (m) => m.findAll((n) => tipOf(n) != null).map(tipOf);

// ---------------------------------------------------------------------------------------------
// The cast: 32 agents in the owner's 25 spaces, deterministic plans (no RNG: a fixed hash)
// ---------------------------------------------------------------------------------------------

// the owner's 25 spaces and how many agents each holds (TOWN.md §3.3; tools/pacing-sim.mjs OWNER_SPACES)
const OWNER_SPACES = [
  ["ceo-assistant-res-2", 1], ["ceo-assistant-writer", 1], ["ceo-assistant-lead", 2], ["pr-review-eng-1", 1],
  ["pr-review-eng-2", 1], ["pr-review-qa", 1], ["pr-review-lead", 1], ["rnd-qa", 2], ["rnd-eng-1", 1], ["rnd-eng-2", 1],
  ["rnd-lead", 1], ["mobile-qa", 1], ["mobile-eng", 2], ["mobile-lead", 1], ["docs", 2], ["infra", 2], ["ref-client", 1],
  ["gks", 1], ["claude-extended", 1], ["qa", 1], ["quiet-front", 1], ["ai-apps-vp", 1], ["ai-platform-vp", 1],
  ["hitch-ops", 2], ["herdr-teams", 2],
];
const TITLES = [
  "Fix flaky auth test", "Bump deps and fix types", "Add retry to upload", "Port settings page to tabs",
  "Split the monolith router", "Write migration for audit log", "Tidy error messages", "Investigate memory leak",
  "Add webhook signing", "Cache the search index",
];
const SPACE_OF = [];
for (const [name, n] of OWNER_SPACES) for (let j = 0; j < n; j++) SPACE_OF.push(name);
const NAMES = OWNER_SPACES.map(([name]) => name);
assert.equal(SPACE_OF.length, 32);
assert.equal(NAMES.length, 25);

const day0 = (() => {
  const d = new Date(Date.UTC(2026, 10, 24, 12, 0));
  d.setHours(0, 0, 0, 0); // local midnight of day 1
  return d.getTime();
})();
const at = (day, h, m = 0) => day0 + (day - 1) * 24 * HOUR + h * HOUR + m * MIN;

/**
 * Agent i's statuses as [fromMs, status, title] from `startMs` until `endMs` (then idle, seen);
 * with `seenMs` its last result waits unseen (done) until then; `lunch` [from, to]: no task starts
 * in it.
 */
function planOf(i, startMs, endMs, seenMs, lunch) {
  const out = [];
  let t = startMs;
  for (let k = 0; t < endMs; k++) {
    // lunch: no task starts in it (the last result was seen before; the agent sits idle)
    if (lunch && t >= lunch[0] && t < lunch[1]) t = lunch[1];
    const title = TITLES[(i * 3 + k) % TITLES.length];
    const work = (15 + ((i * 7 + k * 13) % 31)) * MIN;
    if ((i + k) % 2 === 0) {
      const block = (1 + ((i + k * 5) % 6)) * MIN;
      out.push([t, "working", title]); t += work / 2;
      out.push([t, "blocked", title]); t += block;
      out.push([t, "working", title]); t += work / 2;
    } else {
      out.push([t, "working", title]); t += work;
    }
    out.push([t, "done", title]); t += (3 + ((i * 11 + k * 7) % 28)) * MIN;
    out.push([t, "idle", title]); t += (1 + ((i * 3 + k) % 8)) * MIN;
  }
  if (seenMs != null && out.length >= 2 && out[out.length - 2][1] === "done") out[out.length - 1][0] = Math.max(out[out.length - 1][0], seenMs);
  return out;
}

function statusIn(plan, t, before) {
  let s = before;
  for (const e of plan) {
    if (e[0] > t) break;
    s = e;
  }
  return s;
}

const SPACES = NAMES.map((name, k) => ({
  id: `s${k + 1}`, index: k + 1, name, named: true, folder: `/mock/user/src/${name}`, machine: null, branch: "main", active: k === 0, status: null,
  tabs: [{ id: `tab${k + 1}`, index: 1, name, named: true, active: true, status: null, panes: 2, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: null }],
}));

function agentRow(i, status, title, seq = 100 + i) {
  const name = SPACE_OF[i];
  const k = NAMES.indexOf(name);
  return M.agent(i, {
    program: M.PROGRAMS.claude, app: "claude-code", space: `s${k + 1}`, space_name: name, tab: `tab${k + 1}`, tab_name: name,
    status, title, seq, focused: false,
  });
}

/** The cast's live data at `t` (herdr's agents, panes and terminals). */
class Cast {
  constructor() {
    // day 1: 08:00-09:00 to 19:00-21:00 with a lunch, every fourth agent's last result seen at 21:28 (the person
    // catches up before closing herdr); the last two keep going past herdr's close (night owls)
    // lunch from 11:50 to 13:30: no new tasks (the Localhost shelf fills while nothing ships)
    this.plans = Array.from({ length: 32 }, (_, i) => planOf(i, at(1, 8, (i * 17) % 60), i >= 30 ? at(2, 1) : at(1, 19, (i * 23) % 120), i % 4 === 1 ? at(1, 21, 28) : null, [at(1, 11, 50), at(1, 13, 30)]));
    this.plans[29] = []; // t30, the Intern (Lv 6): its agent sits idle until its terminal closes
    this.forced = new Map(); // address → status (a check's own move)
    this.closed = new Set(); // addresses whose terminal is gone
    this.last = null;
    this.prev = new Map(); // address → {status, seq}
  }
  /** Day 2 from 08:45: the agents left done overnight are seen first, then work again. */
  morning(left) {
    this.plans = this.plans.map((p, i) => {
      const start = at(2, 8, 45 + ((i * 7) % 40));
      const was = left[i];
      return [[at(1, 21, 30), was, TITLES[i % TITLES.length]], ...(was === "done" ? [[start - MIN, "idle", TITLES[i % TITLES.length]]] : []), ...planOf(i + 5, start, at(2, 20))];
    });
  }
  rows(t) {
    const out = [];
    for (let i = 0; i < 32; i++) {
      const addr = `t${i + 1}`;
      if (this.closed.has(addr)) continue;
      const e = statusIn(this.plans[i], t, [0, "idle", TITLES[i % TITLES.length]]);
      const status = this.forced.get(addr) ?? e[1];
      // herdr bumps an agent's seq when its word changes; done <-> idle is the seen flag (same seq)
      const was = this.prev.get(addr);
      if (was && was.status !== status && !(["done", "idle"].includes(was.status) && ["done", "idle"].includes(status))) was.seq++;
      const seq = was ? was.seq : 100 + i;
      this.prev.set(addr, { status, seq });
      out.push(agentRow(i, status, e[2], seq));
    }
    return out;
  }
  fixture(t) {
    const list = this.rows(t);
    return { ...M.sampleFixture(0), agents: list, panes: list.map((a) => M.paneFor(a)), terminals: list.map((a) => M.terminalFor(a)), spaces: SPACES, focused: null };
  }
  /** Puts the cast's statuses at `t` into herdr's live data (only when one changed). */
  apply(t) {
    const list = this.rows(t);
    const sig = list.map((a) => `${a.address}:${a.status}:${a.title}`).join("|");
    if (sig === this.last) return;
    this.last = sig;
    M.updateFixture({ agents: list, panes: list.map((a) => M.paneFor(a)), terminals: list.map((a) => M.terminalFor(a)) });
  }
  statusOf(addr, t) {
    const i = Number(addr.slice(1)) - 1;
    return this.forced.get(addr) ?? statusIn(this.plans[i], t, [0, "idle"])[1];
  }
}

// ---------------------------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------------------------

async function mount(fixture, nowMs) {
  const g = `town-e2e-${++graphN}`;
  const stage = await M.mountMod(MAIN, { props: { role: "stage" }, graph: g, fixture, nowMs });
  const party = await M.mountMod(MAIN, { props: { role: "party" }, graph: g });
  const host = (await stage.import("./host.js")).getHost();
  const TW = await stage.import("./game/town.js");
  const A = await stage.import("./game/agents.js");
  await M.tickAll(1000);
  await M.tickAll(1000);
  assert.equal(host.ready, true);
  stage.size(STAGE_W, 200); stage.render();
  party.size(268, 900); party.render();
  return { stage, party, host, TW, A, graph: g };
}

/**
 * Every town note seen on the stage's queue, by key (notes expire after a few seconds): the town's
 * own (kind "town") and anything about LGTMs, ranks or the shelf (the six buildings' level notes
 * "Localhost: CI Forge 2" are the buildings' own, as before the town).
 */
function watchNotes(r, seen) {
  for (const n of r.host.world.rt.notes) if (n.kind === "town" || /Review Desk|LGTM|reviewer|Contributor|Committer|Maintainer|shelf/.test(n.text)) seen.set(n.key, n.text);
}

/**
 * Pumps the world to `toMs` the way the 1 s timer does (host.pump over herdr's live data, 5 s at a
 * time), the cast's statuses applied before each pump; `each` runs after every pump.
 */
async function run(r, cast, toMs, each) {
  while (M.mockNow() < toMs) {
    M.clock.offset += Math.min(STEP, toMs - M.mockNow());
    cast.apply(M.mockNow());
    r.host.pump(M.mockNow(), true);
    // the host's saves are async host calls: let them run, as herdr's event loop would
    await M.flush(1);
    if (each && each() === true) break;
  }
  await M.flush();
}

/** One real second: the copies' timers fire (the host pumps) and they render. */
async function second(r, cast) {
  cast.apply(M.mockNow() + 1000);
  await M.tickAll(1000);
  r.stage.render();
  r.party.render();
}

const stageVM = (r, w = STAGE_W) => r.host.view("stage", { width: w, height: 200, nowMs: M.mockNow() });
const partyRow = (r, addr) => r.host.view("party", { width: 268, nowMs: M.mockNow() }).groups.flatMap((g) => g.rows).find((x) => x.address === addr);
const live = (r, addr) => {
  for (const [id, l] of r.host.world.rt.live) if (l.address === addr) return { id, l };
  return null;
};
const heroOf = (r, addr) => {
  const x = live(r, addr);
  return x ? r.A.heroById(r.host.world, x.id) : null;
};
const roster = (r) => r.host.world.state.heroes;
const town = (r) => r.host.world.state.herd.town;
const onDutyIds = (r) => roster(r).filter((h) => r.TW.onDuty(r.host.world, h)).map((h) => h.id);
const jobSum = (r) => roster(r).reduce((s, h) => s + r.TW.jobXpOf(h), 0);

/** The save: 30 heroes at the seats of t1 … t30 (t30 an Intern, Lv 6), 2M gold, no town yet. */
async function writeSave(start) {
  const W = await import("../mods/down-the-stack/game/world.js");
  const Hr = await import("../mods/down-the-stack/game/heroes.js");
  const A = await import("../mods/down-the-stack/game/agents.js");
  const w0 = W.createWorld({ nowMs: start - MIN, seed: 11 });
  const tz = new Date(start).getTimezoneOffset();
  w0.state.herd.day = W.localDay(start, tz);
  w0.state.herd.born = w0.state.herd.day - 20;
  w0.state.herd.hired = [w0.state.herd.day, 0];
  w0.state.herd.gold = 2e6;
  for (let i = 0; i < 30; i++) {
    const a = agentRow(i, "idle", "x");
    const h = Hr.newHero(w0.state, { seat: A.seatKey(a.space_name, a.space, a.program.key, a.app), sid: a.space, ord: 0, nowMs: start - MIN });
    h.L = i === 29 ? 6 : 12 + i;
    h.addr = a.address;
    w0.state.heroes.push(h);
  }
  M.memfs.write(SAVE, W.serialize(w0), { mkdirs: true });
}

// ---------------------------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------------------------

const ctx = {};

test("Localhost day 1 (32 agents, 25 spaces): the Review Desk opens by autopilot, heroes go on duty when their agents rest and are back in the field the tick their agent works", async () => {
  M.resetState();
  const start = at(1, 7, 55);
  await writeSave(start);
  const cast = new Cast();
  const r = await mount(cast.fixture(start), start);
  ctx.cast = cast;
  ctx.r = r;
  const { TW } = r;
  const world = () => r.host.world;
  assert.equal(roster(r).length, 30, "the 30 saved heroes");
  assert.equal(world().rt.live.size, 32, "every agent plays");
  const cAddr = ["t31", "t32"];
  assert.ok(cAddr.every((x) => world().rt.contractors.has(x)), "t31 and t32 play Contractors (the roster is full)");
  for (const x of cAddr) Object.assign(world().rt.contractors.get(x), { L: 24, xp: 1000 });

  // before any work is seen: no Review Desk, every resting hero at its campfire, the camp chip
  assert.equal(TW.deskLevel(world().state), 0);
  let vm = stageVM(r);
  const resting = vm.heroes.filter((h) => h.state === "resting");
  assert.ok(resting.length >= 20, `resting heroes in slots: ${resting.length}`);
  assert.ok(resting.every((h) => h.campfire && h.campfire.station === "campfire"), "campfires only");
  assert.ok(vm.overflow && vm.overflow.town === null, "the camp chip as it always was");
  assert.ok(!r.stage.text().includes("LGTM"));
  const tab0 = r.host.view("herd", { tab: "upgrades", nowMs: M.mockNow() });
  assert.equal(tab0.tabs[0].label, "Localhost");

  // the morning: the first results are seen; autopilot opens the Review Desk within its 60-tick
  // pass after a Lv 10+ hero's chest was seen with full value (2M gold: 3 x 1,000 is there)
  const notes = new Map();
  let firstSeen = null;
  let openedAt = null;
  await run(r, cast, at(1, 11), () => {
    watchNotes(r, notes);
    if (firstSeen == null && roster(r).some((h) => h.L >= 10 && TW.creditDayOf(h) != null)) firstSeen = M.mockNow();
    if (openedAt == null && TW.deskLevel(world().state) >= 1) { openedAt = M.mockNow(); return true; }
    return false;
  });
  assert.ok(firstSeen != null && openedAt != null, "a chest was seen and the Review Desk opened before 11:00");
  assert.ok(openedAt - firstSeen <= 60 * 1000 + STEP, `opened ${(openedAt - firstSeen) / 1000} s after the first seen chest of a Lv 10+ hero`);
  assert.equal(TW.deskLevel(world().state), 1);
  await second(r, cast);
  watchNotes(r, notes);
  assert.deepEqual([...notes.values()], ["Localhost: the Review Desk is open"], "one header note, herd-wide");
  const desk1 = r.host.view("herd", { tab: "upgrades", nowMs: M.mockNow() }).upgrades.town.desk;
  assert.deepEqual([desk1.name, desk1.level, desk1.effect], ["Review Desk", 1, "Shelf 10 · 29 reviewers"], "the Localhost tab's Review Desk card");

  // the Contractors: a chest of theirs seen as a Contractor credits the duty rule (it holds no job)
  const cSeen = new Map();
  const deskMax = { day1: 1 };
  let flags = 0;
  const watchDay = () => {
    watchNotes(r, notes);
    deskMax.day1 = Math.max(deskMax.day1, TW.deskLevel(world().state));
    flags |= town(r) ? town(r).t[1] : 0;
    for (const x of cAddr) {
      const c = world().rt.contractors.get(x);
      if (c && !cSeen.has(x) && TW.creditDayOf(c) != null) cSeen.set(x, { id: c.id, day: TW.creditDayOf(c), name: c.name });
    }
    return false;
  };

  // an Intern keeps the campfire: t30 (Lv 6) rests at it while the desk is open; a Contractor holds
  // no job, though a chest of its seen today counts for the duty rule once it is hired
  await run(r, cast, at(1, 10, 55), watchDay);
  const intern = heroOf(r, "t30");
  assert.ok(intern && intern.L < 10);
  assert.equal(TW.stationOf(world(), intern).reason, "intern");
  assert.equal(TW.heroTown(world(), intern).status, "Gets a job at Lv 10 (Junior)");
  const internVM = stageVM(r).heroes.find((h) => h.heroId === intern.id);
  if (internVM) assert.equal(internVM.campfire && internVM.campfire.station, "campfire", "the Intern's slot keeps the campfire");
  for (const x of cAddr) {
    const c = world().rt.contractors.get(x);
    assert.equal(TW.stationOf(world(), c).reason, "contractor");
    assert.equal(TW.onDuty(world(), c), false);
  }

  // 11:00 the Intern's terminal closes; after its 15-minute grace a Contractor takes the slot
  cast.closed.add("t30");
  let promoted = null;
  await run(r, cast, at(1, 12), () => {
    watchDay();
    for (const x of cAddr) {
      const h = roster(r).find((k) => k.addr === x && k.id > 0);
      if (h && !promoted) promoted = { addr: x, hero: h, at: M.mockNow() };
    }
    return false;
  });
  assert.ok(promoted, "a Contractor was promoted mid-day");
  assert.ok(promoted.at > at(1, 11) && promoted.at <= at(1, 11, 17), `promoted at ${new Date(promoted.at).toTimeString()}`);
  ctx.promoted = promoted;
  const was = cSeen.get(promoted.addr);
  assert.ok(was, `${promoted.addr}: a chest of its was seen while it was a Contractor`);
  assert.equal(TW.creditDayOf(promoted.hero), world().state.herd.day, "promotion keeps today's credit");
  assert.ok(TW.jobXpOf(promoted.hero) < 1, "and its job XP starts at 0");

  // the promoted Contractor goes on duty the moment its agent rests (its Contractor chest counts)
  let restedOnDuty = null;
  await run(r, cast, at(1, 13, 10), () => {
    watchDay();
    const l = world().rt.live.get(promoted.hero.id);
    if (l && (l.state === "resting" || l.state === "shipped")) {
      restedOnDuty = { duty: TW.onDuty(world(), promoted.hero), station: TW.stationOf(world(), promoted.hero).id, state: l.state };
      return true;
    }
    return false;
  });
  assert.ok(restedOnDuty, "the promoted hero rested before 13:10");
  assert.deepEqual([restedOnDuty.duty, restedOnDuty.station], [true, "review_desk"], JSON.stringify(restedOnDuty));

  // lunch (11:50-13:30): a hero on duty at its desk in its slot; the tick its agent works it is
  // back in the field
  if (M.mockNow() < at(1, 12, 40)) await run(r, cast, at(1, 12, 40), watchDay);
  let pick = null;
  for (let tries = 0; tries < 20 && !pick; tries++) {
    vm = stageVM(r);
    for (const h of vm.heroes) {
      if (h.state !== "resting" || !h.campfire || h.campfire.station !== "review_desk") continue;
      if (cast.statusOf(h.address, M.mockNow() + 2 * MIN) === "idle") { pick = h; break; }
    }
    if (!pick) await run(r, cast, M.mockNow() + MIN, watchDay);
  }
  assert.ok(pick, "a resting hero sits at the Review Desk in its slot");
  const addr = pick.address;
  const hero = heroOf(r, addr);
  assert.equal(TW.onDuty(world(), hero), true);
  await second(r, cast);
  // the status surfaces keep the agent's own words (TOWN.md §7.4); the job only in tooltips
  const row = partyRow(r, addr);
  assert.equal(row.status, "idle", "the party row says the agent's word");
  assert.ok(!/review|LGTM|desk/i.test(`${row.status} ${row.mapLabel} ${row.chips.map((c) => c.text).join(" ")}`), JSON.stringify(row.chips));
  assert.match(row.tooltip, /\nAt the Review Desk · /);
  assert.ok(tips(r.stage).some((t) => t.includes(hero.name) && /\nAt the Review Desk · /.test(t)), "the stage hero's tooltip says where");
  const dutyBefore = onDutyIds(r).length;
  cast.forced.set(addr, "working");
  await second(r, cast);
  const l = world().rt.live.get(hero.id);
  assert.equal(l.state, "questing", "the tick its agent works, it fights");
  assert.equal(TW.onDuty(world(), hero), false);
  assert.equal(TW.heroTown(world(), hero).state, "working");
  const back = stageVM(r).heroes.find((h) => h.heroId === hero.id);
  assert.ok(back && back.state === "questing" && back.campfire === null, "drawn in the field, no desk");
  assert.equal(onDutyIds(r).length, dutyBefore - 1);
  assert.ok(!/\nAt the Review Desk/.test(partyRow(r, addr).tooltip), "no town line while it works");
  // its agent rests again: on duty again (seen work today)
  cast.forced.delete(addr);
  for (let i = 0; i < 15 && world().rt.live.get(hero.id).state !== "resting"; i++) await second(r, cast);
  assert.equal(world().rt.live.get(hero.id).state, "resting");
  assert.equal(TW.onDuty(world(), hero), true);

  // the rest of the day, to herdr's close at 21:30
  ctx.watchDay = watchDay;
  ctx.notes = notes;
  ctx.deskMax = deskMax;
  ctx.flagsOf = () => flags;
  for (const m of [r.stage, r.party]) assert.deepEqual(m.errors, []);
});

test("Localhost day 1: LGTMs fill and are spent on the chests the person opens (\"· LGTM\" floats); the chip counts them; the tab names the titles; the desk buys no level without demand", async () => {
  const { r, cast } = ctx;
  assert.ok(r, "day 1 ran");
  const { TW } = r;
  const world = () => r.host.world;
  // lunch filled the shelf (nothing shipped while the heroes on duty reviewed)
  await run(r, cast, at(1, 13, 30), ctx.watchDay);
  assert.ok(town(r).t[1] & TW.FULL, "the shelf filled over lunch");
  assert.ok(TW.shelfOf(world().state) >= TW.shelfCap(world().state) - 2, `the shelf after lunch: ${TW.shelfOf(world().state)}`);
  // the first result after lunch: a shipped hero in its slot, its agent done; the person sees it
  let pick = null;
  for (let tries = 0; tries < 60 && !pick; tries++) {
    if (TW.shelfOf(world().state) >= 2) {
      for (const h of stageVM(r).heroes) {
        if (h.state !== "shipped" || cast.statusOf(h.address, M.mockNow()) !== "done") continue;
        const hero = heroOf(r, h.address);
        if (hero && hero.id > 0 && hero.pend && hero.pend.length) { pick = h; break; }
      }
    }
    if (!pick) await run(r, cast, M.mockNow() + 30000, ctx.watchDay);
  }
  assert.ok(pick, "a shipped hero with a chest while the shelf holds LGTMs");
  const hero = heroOf(r, pick.address);
  const used0 = town(r).u[0];
  const shelf0 = TW.shelfOf(world().state);
  const lgtmXp0 = world().rt.live.get(hero.id).tally.lgtmXp || 0;
  cast.forced.set(pick.address, "idle");
  await second(r, cast);
  assert.ok(!(hero.pend && hero.pend.length), "its chest opened");
  assert.ok(town(r).u[0] >= used0 + 1, "it took an LGTM");
  assert.ok(TW.shelfOf(world().state) <= shelf0 - 1 + 0.01, `the shelf went ${shelf0} → ${TW.shelfOf(world().state)}`);
  assert.ok((world().rt.live.get(hero.id).tally.lgtmXp || 0) > lgtmXp0, "+10% chest XP (live.tally.lgtmXp)");
  const fx = stageVM(r).fx.filter((f) => /^\+[\d.,]+k? · LGTM$/.test(f.text || ""));
  assert.ok(fx.length >= 1, `the coin float reads "+n · LGTM": ${JSON.stringify(stageVM(r).fx.map((f) => f.text))}`);
  assert.ok(r.stage.text().includes("· LGTM"), "drawn on the stage");
  const titles = TW.lastTitles(world());
  assert.ok(titles.length >= 1 && titles[0].heroId === hero.id, "the newest approved title is its chest's");
  cast.forced.delete(pick.address);

  // to 18:00: the chip's count grows all day
  await run(r, cast, at(1, 18), ctx.watchDay);
  await second(r, cast);
  const t = town(r);
  const vm = stageVM(r);
  assert.ok(vm.overflow && vm.overflow.town, "the Localhost chip");
  assert.equal(vm.overflow.town.text, `LGTM ×${t.t[0]}`);
  assert.ok(t.t[0] >= 20, `LGTMs today by 18:00: ${t.t[0]}`);
  assert.ok(r.stage.text().includes(`LGTM ×${t.t[0]}`), "drawn in the chip");
  assert.match(vm.overflow.tooltip, /\nLocalhost: \d+ on duty \(Review Desk \d+\) · LGTM \d+\/10\n/);
  assert.match(vm.overflow.tooltip, /\nvendor\/: 1 contractor · /);
  const tab = r.host.view("herd", { tab: "upgrades", nowMs: M.mockNow() }).upgrades.town;
  assert.ok(tab && TITLES.some((x) => JSON.stringify(tab.titles).includes(x)), `the tab names the approved titles: ${JSON.stringify(tab && tab.titles)}`);

  // to 21:30: the shelf filled and ran dry, but autopilot buys no level the same day (2M gold)
  await run(r, cast, at(1, 21, 30), ctx.watchDay);
  assert.equal(ctx.deskMax.day1, 1, "no second level on day 1");
  assert.ok((ctx.flagsOf() & TW.FULL) && (ctx.flagsOf() & TW.DRY), "the shelf was full and later ran dry");
  assert.ok(world().state.herd.gold > 1e6, "with gold to spare");
  assert.deepEqual([...ctx.notes.values()], ["Localhost: the Review Desk is open"], "the only town note of the day");
  assert.deepEqual(M.calls().notify, [], "no notifications");
  assert.equal(M.calls().toasts.length, 0, "no toasts");
  for (const m of [r.stage, r.party]) assert.deepEqual(m.errors, []);
});

test("Localhost overnight: herdr closed at 21:30 and opened at 08:40; the gap settles within the shelf's room, nothing spent or told; the demand rule buys one level; one Localhost card in the Digest", async () => {
  const { r, cast } = ctx;
  assert.ok(r, "day 1 ran");
  const { TW } = r;
  // the person reads the Digest and herdr closes
  assert.ok(r.host.command("digestSeen", {}).ok !== false);
  await second(r, cast);
  await r.host.flush();
  const w1 = r.host.world;
  // what the save keeps (TOWN.md §8): job XP in whole units, the shelf to a tenth, both rounded down
  const close = {
    shelf: Math.floor(TW.shelfOf(w1.state) * 10 + 1e-9) / 10, cap: TW.shelfCap(w1.state), used: town(r).u[0], day: w1.state.herd.day,
    jobs: roster(r).reduce((s, h) => s + Math.floor(TW.jobXpOf(h) + 1e-9), 0),
  };
  const disk = JSON.parse(M.memfs.readText(SAVE));
  assert.ok(disk.herd.x && disk.herd.x.town && disk.herd.x.town.rd === 1, `the save holds the town: ${JSON.stringify(disk.herd.x && disk.herd.x.town)}`);
  const left = Array.from({ length: 32 }, (_, i) => {
    const s = cast.statusOf(`t${i + 1}`, M.mockNow());
    return s === "idle" ? "idle" : "done"; // what was open at the close finished overnight, unseen
  });
  for (const m of M.mounted()) await m.close();

  // 08:40: herdr opens; its core kept the terminals
  M.resetState();
  const reopen = at(2, 8, 40);
  cast.morning(left);
  cast.forced.clear();
  cast.last = null;
  M.memfs.write(SAVE, JSON.stringify(disk), { mkdirs: true });
  const r2 = await mount(cast.fixture(reopen), reopen);
  ctx.r = r2;
  const w2 = () => r2.host.world;
  assert.equal(w2().state.herd.day, close.day + 1, "a new game day");
  const made = jobSum(r2) - close.jobs;
  const shelf = TW.shelfOf(w2().state);
  const room = close.cap - close.shelf;
  assert.ok(room >= 3, `the shelf had room at the close: ${close.shelf}/${close.cap}`);
  // bounded: the gap made what filled the shelf's room at the close, never more (the 30 heroes on
  // duty overnight would have made about 300 LGTMs in 11 hours); a tick or two of the day after
  assert.ok(Math.abs(made - room) < 0.1, `job XP of the gap ${made.toFixed(2)} = the room ${room.toFixed(2)}`);
  assert.ok(Math.abs(shelf - close.cap) < 0.1, `the night filled the shelf: ${shelf}/${close.cap}`);
  // nothing spent, told or notified while it settled
  assert.equal(town(r2).u[0], close.used, "no LGTM spent by the settle");
  assert.ok(!w2().rt.fx.some((f) => f.lgtm), "no LGTM float at the reopen");
  assert.ok(!w2().rt.notes.some((n) => /LGTM|rank|Contributor|Committer/.test(n.text)), JSON.stringify(w2().rt.notes.map((n) => n.text)));
  assert.deepEqual(M.calls().notify, [], "no notifications");
  assert.equal(M.calls().toasts.length, 0, "no toasts");

  // the demand rule: day 1 filled the shelf and ran it dry, so autopilot buys level 2 on its pass
  const notes = new Map();
  const levels = new Set();
  await run(r2, cast, reopen + 2 * MIN, () => { watchNotes(r2, notes); levels.add(TW.deskLevel(w2().state)); });
  assert.equal(TW.deskLevel(w2().state), 2, "level 2 the morning after a day whose shelf filled and ran dry");
  assert.deepEqual([...notes.values()], ["Localhost: Review Desk 2"]);

  // the first results of the morning are seen: the night's LGTMs pay "· LGTM"
  let lgtmFloat = false;
  await run(r2, cast, at(2, 9, 30), () => {
    watchNotes(r2, notes);
    levels.add(TW.deskLevel(w2().state));
    if (w2().rt.fx.some((f) => f.kind === "coin" && f.lgtm > 0)) lgtmFloat = true;
  });
  assert.ok(lgtmFloat, "a coin float with an LGTM this morning");
  assert.ok(town(r2).u[0] > close.used, "LGTMs spent this morning");
  await second(r2, cast);
  const dg = r2.host.view("herd", { tab: "digest", nowMs: M.mockNow() }).digest;
  const cards = dg.sections.filter((s) => s.key === "town");
  assert.equal(cards.length, 1, "one Localhost card");
  assert.match(cards[0].lines[0].text, /^\d+ chests? LGTM'd \(\+10% XP and gold\)$/);
  assert.equal(cards[0].lines[0].text.split(" ")[0], String(town(r2).u[0] - close.used), "counted since the Digest was read");
  assert.ok(cards[0].lines.length <= 2);
  ctx.levels2 = levels;
  ctx.notes2 = notes;
  assert.deepEqual(M.calls().notify, [], "no notifications");
  for (const m of [r2.stage, r2.party]) assert.deepEqual(m.errors, []);
});

test("Localhost: a hot reload keeps the town (shelf, counters, job XP, ranks, the last approved titles); the desk stays at one level a game day", async () => {
  const r = ctx.r;
  const cast = ctx.cast;
  assert.ok(r && ctx.levels2, "the morning ran");
  const { TW } = r;
  const w = r.host.world;
  const before = {
    town: JSON.parse(JSON.stringify(w.state.herd.town)),
    jobs: roster(r).map((h) => [h.id, TW.jobXpOf(h), TW.creditDayOf(h)]),
    titles: TW.lastTitles(w),
    duty: onDutyIds(r),
    tab: r.host.view("herd", { tab: "upgrades", nowMs: M.mockNow() }).upgrades.town,
  };
  assert.ok(before.titles.length >= 1, "titles to keep");
  await M.reloadAll(M.mounted());
  const host2 = (await r.stage.import("./host.js")).getHost();
  assert.notEqual(host2, r.host, "a new build's host");
  const TW2 = await r.stage.import("./game/town.js");
  const r2 = { ...r, host: host2, TW: TW2 };
  const w2 = host2.world;
  assert.notEqual(w2, w, "the next build's world");
  assert.deepEqual(w2.state.herd.town, before.town, "the town's saved numbers, the shelf's fraction too");
  assert.deepEqual(roster(r2).map((h) => [h.id, TW2.jobXpOf(h), TW2.creditDayOf(h)]), before.jobs, "job XP (with its fraction) and credit days");
  assert.deepEqual(TW2.lastTitles(w2), before.titles, "the last approved titles");
  const tab2 = host2.view("herd", { tab: "upgrades", nowMs: M.mockNow() }).upgrades.town;
  assert.deepEqual([tab2.titles, tab2.shelf, tab2.desk], [before.tab.titles, before.tab.shelf, before.tab.desk], "the Localhost tab's titles, shelf and desk read the same");
  // the next build's first tick lists herdr's agents again (until then no hero has a Live); an
  // agent whose status changes in that second is left out of the comparison
  const now = M.mockNow();
  const changed = new Set(Array.from({ length: 32 }, (_, i) => `t${i + 1}`).filter((a) => cast.statusOf(a, now) !== cast.statusOf(a, now + 1000)));
  await second(r2, cast);
  const same = (ids) => ids.filter((id) => !changed.has(r.A.heroById(w2, id)?.addr));
  assert.deepEqual(same(onDutyIds(r2)), same(before.duty), "the same heroes on duty");
  // the day goes on: no second level the same game day, whatever the gold
  ctx.r = r2;
  await run(r2, cast, at(2, 11), () => { watchNotes(r2, ctx.notes2); ctx.levels2.add(TW2.deskLevel(w2.state)); });
  assert.deepEqual([...ctx.levels2].filter((x) => x > 2), [], "at most one level a game day");
  assert.deepEqual([...ctx.notes2.values()], ["Localhost: Review Desk 2"]);
  await second(r2, cast);
  for (const m of [r2.stage, r2.party]) assert.deepEqual(m.errors, []);
});
