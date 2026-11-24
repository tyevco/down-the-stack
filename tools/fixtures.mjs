// Role fixtures for tools/check.mjs and tools/preview/shoot.mjs (ARCHITECTURE §7.2, tools/mock/README.md).
//
//   export const roles = [{ name, props, nowMs, kind, fixture, world?, setup?, widths?, height?, preview? }]
//
// Every world is a demo world (game/demo.js, built by the real engine; `kind` names it) or the
// 30-hero herd (`stressWorld`, kind "stress30"), loaded through `mod.import("./game/...")`, i.e.
// from the same module graph as the mod's host.js. The live
// data (agents, panes, terminals, spaces, focused) is herdr's shape built from that demo's own
// snapshot (`demoFixture(kind)`), so the 1 s pump keeps every hero bound and nameplates find their
// heroes. Fixtures are built lazily (a getter) and cached per kind: importing this module is cheap.
//
// Order matters to the preview: its composed window takes the first stage, party and hud roles and
// the first three nameplates that name a terminal.

import * as DemoNS from "../mods/down-the-stack/game/demo.js";
import * as WorldNS from "../mods/down-the-stack/game/world.js";
import { liveHeroes } from "../mods/down-the-stack/game/agents.js";
import { rollItem, stashPut } from "../mods/down-the-stack/game/items.js";
import { addGold, addSnippets } from "../mods/down-the-stack/game/herd.js";
import { paneFor, terminalFor, readLayout, PROGRAMS as MOCK_PROGRAMS } from "./mock/samples.mjs";
import { stressWorld as stressRecipe } from "./qjs/stress30.js";

const { demoWorld, DEMO_KINDS, PROGRAMS: DEMO_PROGRAMS } = DemoNS;

/** The fixed clock every role runs at (a Tuesday morning, as tools/check.mjs uses). */
export const NOW = Date.UTC(2026, 10, 24, 9, 30, 0);

const CWD = { spc_1: "/mock/user/src/herdr-app", spc_2: "/mock/user/src/api-gateway" };
const cwdOf = (space) => CWD[space] ?? `/mock/user/src/${space}`;

/** The agent a contractor fixture adds to the "mid" herd (its roster is full for the day). */
export const CONTRACTOR = {
  address: "t7", pane: "p_t7", space: "spc_1", space_name: "herdr-app", tab: "tab_1", tab_index: 0, tab_name: "main",
  status: "working", app: "codex", program: DEMO_PROGRAMS.codex, title: "Hotfix the login redirect", pane_name: null,
  seq: 700, pinned: false, focused: false,
};

/** A plain shell pane (not an agent) and a mod pane, for the nameplate's plain header. */
const SHELL = { pane: "p_sh", terminal: "t_sh", title: "zsh", program: MOCK_PROGRAMS.shell };
const MODPANE = { pane: "p_mod", terminal: null, mod: "files", title: "Files" };

/**
 * herdr live data (tools/mock/samples.mjs shapes) for a demo snapshot.
 * extra: { agents: [AgentInfo], shell: boolean, modPane: boolean }
 */
export function liveFromSnapshot(snap, extra = {}) {
  const rows = [...(snap?.agents ?? []), ...(extra.agents ?? [])].map((a) => ({ ...a }));
  const focus = snap?.focusedTerminal ?? null;
  for (const a of rows) a.focused = focus != null && a.address === focus;
  const agents = rows;
  const panes = agents.map((a) => paneFor(a, { cwd: cwdOf(a.space), branch: "main" }));
  const terminals = agents.map((a) => terminalFor(a));
  for (const s of snap?.subagents ?? []) {
    terminals.push({
      address: s.address, argv: [s.program?.key ?? "agent"], name: s.title, template: null, parent: s.parent, labels: {},
      state: "live", status: s.status, report: { app: s.program?.key ?? null }, program: s.program ?? null, selection: null,
    });
  }
  // spaces in first-seen order, each with the tabs its agents use
  const spaceOrder = [];
  const bySpace = new Map();
  for (const sp of snap?.spaces ?? []) {
    if (!bySpace.has(sp.id)) { bySpace.set(sp.id, { id: sp.id, name: sp.name, tabs: new Map() }); spaceOrder.push(sp.id); }
  }
  for (const a of agents) {
    if (!bySpace.has(a.space)) { bySpace.set(a.space, { id: a.space, name: a.space_name, tabs: new Map() }); spaceOrder.push(a.space); }
    const sp = bySpace.get(a.space);
    if (!sp.tabs.has(a.tab)) sp.tabs.set(a.tab, { id: a.tab, name: a.tab_name, agents: [] });
    sp.tabs.get(a.tab).agents.push(a);
  }
  const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
  const worst = (list) => list.reduce((m, a) => (RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m, null);
  const focusedAgent = agents.find((a) => a.focused) ?? null;
  const spaces = spaceOrder.map((id, i) => {
    const sp = bySpace.get(id);
    const tabs = [...sp.tabs.values()].map((t, k) => ({
      id: t.id, index: k + 1, name: t.name ?? String(k + 1), named: t.name != null, active: focusedAgent ? focusedAgent.tab === t.id : k === 0,
      status: worst(t.agents), panes: t.agents.length, zoomed: false, settled: false, settled_at: null, changed_at: null,
      working_since: snap?.tabs?.[t.id]?.working_since ?? null,
    }));
    return {
      id, index: i + 1, name: sp.name, named: true, folder: cwdOf(id), machine: null, branch: "main",
      active: focusedAgent ? focusedAgent.space === id : i === 0, status: worst(tabs.map((t) => ({ status: t.status }))), tabs,
    };
  });
  if (extra.shell) {
    const tab = spaces[0]?.tabs[0]?.id ?? "tab_1";
    panes.push({
      pane: SHELL.pane, terminal: SHELL.terminal, tab, title: SHELL.title, name: null, cwd: cwdOf(spaces[0]?.id ?? "spc_1"), branch: "main",
      status: null, app: null, program: SHELL.program, focused: false, zoomed: false, movable: true,
      scroll: { total: 200, offset: 160, len: 40, from_bottom: 0 },
    });
    terminals.push({ address: SHELL.terminal, argv: ["zsh"], name: "zsh", template: null, parent: null, labels: {}, state: "live", status: "idle", report: null, program: SHELL.program, selection: null });
  }
  if (extra.modPane) {
    panes.push({
      pane: MODPANE.pane, terminal: null, mod: MODPANE.mod, tab: spaces[0]?.tabs[0]?.id ?? "tab_1", title: MODPANE.title, name: null,
      cwd: null, branch: null, status: null, app: null, program: null, focused: false, zoomed: false, movable: true, scroll: null,
    });
  }
  const focused = focusedAgent
    ? { space: focusedAgent.space, tab: focusedAgent.tab, pane: focusedAgent.pane, terminal: focusedAgent.address, shown: null, agent: null, cwd: cwdOf(focusedAgent.space), selection: null }
    : null;
  return { agents, panes, terminals, spaces, focused, layout: readLayout(), nowMs: NOW };
}

const demoCache = new Map();
/** The demo world of a kind at NOW (cached; only for deriving live data and ids). */
function demo(kind) {
  if (!demoCache.has(kind)) demoCache.set(kind, demoWorld(kind, NOW));
  return demoCache.get(kind);
}

const fixtureCache = new Map();
/** Live data matching demoWorld(kind, NOW).snapshot (cached per kind and variant). */
export function demoFixture(kind, extra = {}) {
  const key = `${kind}|${JSON.stringify(extra)}`;
  if (!fixtureCache.has(key)) fixtureCache.set(key, liveFromSnapshot(demo(kind).snapshot, extra));
  return fixtureCache.get(key);
}

/** A world builder for check.mjs: the demo world from the mod's own module graph. */
export function demoWorldOf(kind) {
  return async ({ nowMs, mod }) => (await mod.import("./game/demo.js")).demoWorld(kind, nowMs ?? NOW).world;
}

/** The "mid" herd with one more agent than its roster can hire today: t7 plays a Contractor. */
async function contractorWorld({ nowMs, mod }) {
  const D = await mod.import("./game/demo.js");
  const W = await mod.import("./game/world.js");
  const now = nowMs ?? NOW;
  const { world, snapshot } = D.demoWorld("mid", now);
  W.tick(world, { ...snapshot, nowMs: now + 1000, agents: [...snapshot.agents, { ...CONTRACTOR }] });
  return world;
}

// ---------------------------------------------------------------------------------------------
// The 30-hero herd: the roster maximum (TUNING.roster.max 30), the stage's element and animation
// budget's hardest case (D§11.9.7, ARCHITECTURE §6.1). One recipe (tools/qjs/stress30.js) for this
// module and for npm run qjs's "stress30" (its roles phase runs these roles on that world in QuickJS).

/**
 * 30 agents hired over five days (6 a day) in three spaces, every sixth with three sub-agents
 * (Forklings), high levels and rare gear, a full stash, the late zones open, and a zone boss fight
 * started 30 s before `nowMs`. `G` holds the game modules of one module graph
 * ({ Demo, W, liveHeroes, rollItem, stashPut, addGold, addSnippets }). Returns { world, snapshot, challenge }.
 */
export function stressWorld(G, nowMs = NOW) {
  return stressRecipe(G, nowMs);
}

let stressCache = null;
/** Live data for the 30-hero herd at NOW (built once, from this module's own game imports). */
export function stressFixture() {
  if (!stressCache) {
    const { snapshot } = stressWorld({ Demo: DemoNS, W: WorldNS, liveHeroes, rollItem, stashPut, addGold, addSnippets }, NOW);
    stressCache = liveFromSnapshot(snapshot);
  }
  return stressCache;
}

/** A world builder for check.mjs: the 30-hero herd from the mod's own module graph. */
async function stressWorldOf({ nowMs, mod }) {
  const G = {
    Demo: await mod.import("./game/demo.js"), W: await mod.import("./game/world.js"),
    liveHeroes: (await mod.import("./game/agents.js")).liveHeroes, ...(await mod.import("./game/items.js")), ...(await mod.import("./game/herd.js")),
  };
  return stressWorld(G, nowMs ?? NOW).world;
}

/** A role on the 30-hero herd (lazy fixture). */
function onStress(name, props, more = {}) {
  const role = { name, props, nowMs: NOW, kind: "stress30", get fixture() { return stressFixture(); }, world: stressWorldOf };
  for (const k of ["widths", "zooms", "height", "preview", "setup"]) if (more[k] !== undefined) role[k] = more[k];
  return role;
}

/** Hero ids of a demo world, in roster order. */
export function heroIds(kind) {
  return demo(kind).world.state.heroes.map((h) => h.id);
}

/** A role on a demo world (lazy fixture). */
function onDemo(name, kind, props, more = {}) {
  const extra = more.extra ?? {};
  const role = {
    name, props, nowMs: NOW, kind,
    get fixture() { return demoFixture(kind, extra); },
    world: more.world ?? demoWorldOf(kind),
  };
  for (const k of ["widths", "zooms", "height", "preview", "setup"]) if (more[k] !== undefined) role[k] = more[k];
  return role;
}

const STAGE_ORDER = ["mid", ...DEMO_KINDS.filter((k) => k !== "mid")];
const DIALOG = { widths: [760] };

export const roles = [
  // stage × every demo world (the first one is the preview's)
  ...STAGE_ORDER.map((kind) => onDemo(`stage-${kind}`, kind, { role: "stage" })),
  // the stage's element and animation budget (D§11.9.7: ~400 elements, ~150 animated per render;
  // check.mjs fails a stage render over either): an ultrawide stage, and the 30-hero herd with a
  // boss fight at every width up to ultrawide
  onDemo("stage-late-3200", "late", { role: "stage" }, { widths: [3200], preview: { width: 3200, height: 200 } }),
  onStress("stage-30", { role: "stage" }, { widths: [960, 1600, 3200], preview: { width: 1600, height: 200 } }),

  // party sidebar: full, crowded, empty, and the rail (< 160 px)
  onDemo("party-mid", "mid", { role: "party" }, { widths: [248, 320], preview: { width: 248, height: 820 } }),
  onDemo("party-late", "late", { role: "party" }, { widths: [248, 360] }),
  onDemo("party-empty", "empty", { role: "party" }, { widths: [248] }),
  onDemo("party-rail", "mid", { role: "party" }, { widths: [44, 120] }),
  onStress("party-30", { role: "party" }, { widths: [248], preview: { width: 248, height: 820 } }),

  // pane headers: agents (the first three feed the preview window), a contractor, a shell pane,
  // a mod pane, and a hero pane while the save is still loading
  onDemo("nameplate-agent", "mid", { role: "nameplate", pane: "p_t1", terminal: "t1" }, { widths: [300, 700, 1200] }),
  onDemo("nameplate-blocked", "mid", { role: "nameplate", pane: "p_t2", terminal: "t2" }, { widths: [700] }),
  onDemo("nameplate-forkbinder", "mid", { role: "nameplate", pane: "p_t5", terminal: "t5" }, { widths: [700] }),
  onDemo("nameplate-contractor", "mid", { role: "nameplate", pane: CONTRACTOR.pane, terminal: CONTRACTOR.address }, {
    widths: [300, 700], extra: { agents: [CONTRACTOR] }, world: contractorWorld,
  }),
  onDemo("nameplate-shell", "mid", { role: "nameplate", pane: SHELL.pane, terminal: SHELL.terminal }, { widths: [300, 700], extra: { shell: true } }),
  onDemo("nameplate-modpane", "mid", { role: "nameplate", pane: MODPANE.pane, terminal: null }, { widths: [700], extra: { modPane: true } }),
  {
    name: "nameplate-loading", props: { role: "nameplate", pane: "p_t1", terminal: "t1" }, nowMs: NOW, widths: [300, 700],
    get fixture() { return demoFixture("mid"); },
    // the save read never came back yet: the host shows no world (view() → null) until it retries
    setup: ({ host }) => {
      if (!host) return;
      host.loaded = false;
      host.placeholder = host.world;
      host.loadingSince = Date.now();
    },
  },

  // the optional HUD strip
  onDemo("hud", "mid", { role: "hud" }, { widths: [960, 1600] }),
  onDemo("hud-empty", "empty", { role: "hud" }, { widths: [960] }),

  // character sheets: several heroes and every tab
  onDemo("sheet-gear", "mid", { role: "sheet", overlay: "o1", heroId: 1, tab: "gear" }, DIALOG),
  onDemo("sheet-skills", "mid", { role: "sheet", overlay: "o1", heroId: 2, tab: "skills" }, DIALOG),
  onDemo("sheet-stats", "boss", { role: "sheet", overlay: "o1", heroId: 1, tab: "stats" }, DIALOG),
  onDemo("sheet-career", "late", { role: "sheet", overlay: "o1", heroId: 4, tab: "career" }, DIALOG),
  onDemo("sheet-journal", "first-day", { role: "sheet", overlay: "o1", heroId: 1, tab: "journal" }, DIALOG),
  onDemo("sheet-contractor", "mid", { role: "sheet", overlay: "o1", heroId: -1, tab: "gear" }, {
    ...DIALOG, extra: { agents: [CONTRACTOR] }, world: contractorWorld,
  }),

  // the Herd panel: every tab
  onDemo("herd-upgrades", "mid", { role: "herd", overlay: "o2", tab: "upgrades" }, DIALOG),
  onDemo("herd-stash", "late", { role: "herd", overlay: "o2", tab: "stash" }, DIALOG),
  onDemo("herd-tracker", "late", { role: "herd", overlay: "o2", tab: "tracker" }, DIALOG),
  onDemo("herd-bosses", "boss", { role: "herd", overlay: "o2", tab: "bosses" }, DIALOG),
  onDemo("herd-roster", "late", { role: "herd", overlay: "o2", tab: "roster" }, DIALOG),
  onStress("herd-roster-30", { role: "herd", overlay: "o2", tab: "roster" }, DIALOG),
  onDemo("herd-digest", "mid", { role: "herd", overlay: "o2", tab: "digest" }, DIALOG),
  onDemo("herd-settings", "calm", { role: "herd", overlay: "o2", tab: "settings" }, DIALOG),
  // the D§11.15 settings in use: autopilot off (its systems inactive), loot glows from Release,
  // the stage collapsing while nothing works, one notification on
  onDemo("herd-settings-off", "mid", { role: "herd", overlay: "o2", tab: "settings" }, {
    ...DIALOG, setup: cfgSetup({ autopilot: false, glow: 3, collapse: true, notify: { boss: true } }),
  }),

  // loot on the stage (D§11.15 "loot glow minimum rarity"): one drop of every rarity and an LTS
  // pillar, as shown by default (every glow) and from Release up
  onDemo("stage-loot", "mid", { role: "stage" }, { widths: [960], world: lootWorld(0), setup: freeze }),
  onDemo("stage-loot-release", "mid", { role: "stage" }, { widths: [960], world: lootWorld(3), setup: freeze }),

  // save trouble the player is told about (host.saveStatus → args.save, the stage's notice;
  // D§13.1, D§13.4): a newer version's save (read-only), a restore from save.bak, and a
  // save.json that cannot be read (so nothing is saved)
  onDemo("stage-save-readonly", "mid", { role: "stage" }, { setup: saveTrouble("readonly") }),
  onDemo("stage-save-notsaving", "mid", { role: "stage" }, { setup: saveTrouble("unreadable") }),
  onDemo("herd-save-readonly", "mid", { role: "herd", overlay: "o2", tab: "upgrades" }, { ...DIALOG, setup: saveTrouble("readonly") }),
  onDemo("herd-save-restored", "mid", { role: "herd", overlay: "o2", tab: "roster" }, { ...DIALOG, setup: saveTrouble("restored") }),
  onDemo("hud-save-unreadable", "mid", { role: "hud" }, { widths: [960], setup: saveTrouble("unreadable") }),
  onDemo("hud-save-restored", "mid", { role: "hud" }, { widths: [560], setup: saveTrouble("restored"), preview: { width: 560, height: 26 } }),
  onDemo("party-save-notsaving", "mid", { role: "party" }, { widths: [248], setup: saveTrouble("unreadable") }),
  onDemo("party-save-rail", "mid", { role: "party" }, { widths: [44], setup: saveTrouble("readonly"), preview: { width: 44, height: 820 } }),
];

/** A role setup that sets herd.cfg values (merged one level deep). */
function cfgSetup(values) {
  return ({ host }) => {
    if (!host || !host.world) return;
    const cfg = host.world.state.herd.cfg;
    for (const [k, v] of Object.entries(values)) cfg[k] = v && typeof v === "object" ? { ...cfg[k], ...v } : v;
    host.world.rt.version++;
    host.version++;
  };
}

/**
 * The "mid" world with this tick's loot on its stage: a drop of each rarity (Prototype to
 * Keepsake) leaving the front mob of six heroes' lanes, and an LTS light pillar beside the first
 * hero; herd.cfg.glow = `glow` (the loot glow minimum rarity). Use with `freeze`: the next tick
 * would age the drops away.
 */
function lootWorld(glow) {
  return async ({ nowMs, mod }) => {
    const D = await mod.import("./game/demo.js");
    const { world } = D.demoWorld("mid", nowMs ?? NOW);
    const rt = world.rt;
    world.state.herd.cfg.glow = glow;
    const ids = [...rt.live.keys()].filter((id) => id > 0);
    ids.slice(0, 6).forEach((heroId, i) => {
      const lane = rt.live.get(heroId).lane || [];
      rt.fx.push({ kind: "loot", heroId, mobUid: lane[0] ? lane[0].uid : undefined, rar: i, text: "", value: 0, key: `fx:${rt.tick}:loot${i}`, bornTick: rt.tick });
    });
    if (ids.length) rt.fx.push({ kind: "pillar", heroId: ids[0], rar: 4, text: "LTS", value: 0, key: `fx:${rt.tick}:pillar`, bornTick: rt.tick });
    rt.version++;
    return world;
  };
}

/** A role setup that stops the host's pump (the preview and check tick 2-3 s): the world stays as built. */
function freeze({ host }) {
  if (host) host.retired = true;
}

/** A role setup that puts the host's save into one kind of trouble (see host.saveStatus()). */
function saveTrouble(kind) {
  return ({ host }) => {
    if (!host || !host.world) return;
    if (kind === "readonly") {
      host.world.rt.readOnly = true;
      host.stats.warning = "Save is from a newer version (v2); opened read-only";
    } else if (kind === "restored") {
      host.stats.loadedFrom = "bak";
    } else if (kind === "unreadable") {
      host.ioBlocked = true;
      host.stats.loadedFrom = "bak";
      host.lastSaveMs = Date.now(); // the next re-read is 30 s away, after the check
    }
    host.version++;
  };
}

export default roles;
