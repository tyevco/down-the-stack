// Screenshots of the REAL mod over demo worlds: every block goes through main.js → host.view() →
// the role renderers (no sample view models), then into the mock herdr window (window.mjs).
//
//   node --import ./tools/mock/register.mjs tools/preview/windows.mjs [--only mid,boss] [--roles] [--out dir]
//
// Writes, at deviceScaleFactor 2:
//   out/window-<kind>.png        party sidebar + tab bar + two panes with nameplates + stage + status bar
//                                 for kinds mid, boss, late, first-day, empty, and mid-light (paper theme)
//   out/real-<kind>-<role>.png   (with --roles) the stage, party, nameplates, sheet and Herd panel alone
// `--preview` also writes the repo's showcase image (preview.png, the mid window).

import "../mock/register.mjs";
import fs from "node:fs";
import path from "node:path";
import * as M from "../mock/index.mjs";
import { renderRoles, shoot } from "./shoot.mjs";
import { composeWindow } from "./window.mjs";
import { resolveTheme } from "../mock/theme.mjs";
import { demoFixture, demoWorldOf, NOW } from "../fixtures.mjs";
import { demoWorld } from "../../mods/mapledr/game/demo.js";

const MAIN = path.join(M.REPO, "mods", "mapledr", "main.js");

export const SETS = [
  { name: "mid", kind: "mid" },
  { name: "boss", kind: "boss" },
  { name: "late", kind: "late" },
  { name: "first-day", kind: "first-day" },
  { name: "empty", kind: "empty" },
  { name: "mid-light", kind: "mid", theme: "paper" },
];

// What an agent's terminal shows, by status (the mock window's pane body).
const LINES = {
  working: [
    ["> ", "task"],
    ["", "● Read 4 files"],
    ["", "● Edited src/auth/session.ts  (+18 −9)"],
    ["", "● Running npm test -- auth"],
    ["", "    ✓ refreshes an expired token (12 ms)"],
    ["", "    ✓ keeps the session on a 503 (4 ms)"],
    ["", "✻ Thinking…"],
  ],
  blocked: [
    ["> ", "task"],
    ["", "● Ran npm run typecheck: 3 errors in src/api/types.ts"],
    ["", "  `UserId` is a number here but a string in the client."],
    ["", ""],
    ["", "  Should I widen it to string | number?"],
    ["", "  ❯ 1. Yes, widen it"],
    ["", "    2. No, convert at the boundary"],
  ],
  done: [
    ["> ", "task"],
    ["", "● Edited 3 files, ran 41 tests"],
    ["", "  All green. Ready for review."],
    ["", ""],
    ["$ ", "▌"],
  ],
  idle: [
    ["$ ", "git log --oneline -3"],
    ["", "a1c9e2f Fix flaky clock test"],
    ["", "77b03d4 Bump deps"],
    ["$ ", "▌"],
  ],
  shell: [
    ["$ ", "ls"],
    ["", "README.md  package.json  src  test"],
    ["$ ", "▌"],
  ],
};

/** The agent's terminal: its task title as the prompt, then output that fits its status. */
function linesFor(agent) {
  const body = LINES[agent.status] ?? LINES.working;
  return agent.status === "idle" ? body : [["> ", agent.title], ...body.slice(1)];
}

/** The panes a window shows: the focused agent first, then the next one (or two shell panes). */
function panesFor(kind) {
  const snap = demoWorld(kind, NOW).snapshot;
  const agents = snap.agents.slice();
  if (!agents.length) return { panes: [{ shell: true, focused: true }, { shell: true, focused: false }], extra: { shell: true } };
  const f = agents.findIndex((a) => a.address === snap.focusedTerminal);
  const first = f >= 0 ? agents[f] : agents[0];
  const rest = agents.filter((a) => a !== first);
  // Prefer a second pane whose state differs from the first, for a more telling window.
  const second = rest.find((a) => a.status !== first.status) ?? rest[0] ?? null;
  const pick = [first, second].filter(Boolean).sort((a, b) => agents.indexOf(a) - agents.indexOf(b));
  return { panes: pick.map((a) => ({ agent: a, focused: a === first })), extra: {} };
}

function fixtureFor(set, extra) {
  const base = demoFixture(set.kind, extra);
  if (!set.theme) return base;
  return { ...base, theme: set.theme, settings: { theme: set.theme, dark: false } };
}

/** Roles for one window: stage, party, hud and the panes' nameplates. */
function windowRoles(set, panes, extra) {
  const fixture = fixtureFor(set, extra);
  const world = demoWorldOf(set.kind);
  const base = { nowMs: NOW, fixture, world };
  const roles = [
    { ...base, name: "stage", props: { role: "stage" } },
    { ...base, name: "party", props: { role: "party" } },
    { ...base, name: "hud", props: { role: "hud" } },
  ];
  panes.forEach((p, i) => {
    const props = p.shell ? { role: "nameplate", pane: "p_sh", terminal: "t_sh" } : { role: "nameplate", pane: p.agent.pane, terminal: p.agent.address };
    roles.push({ ...base, name: `nameplate-${i + 1}`, props });
  });
  return roles;
}

function dialogRoles(set, heroId) {
  const fixture = fixtureFor(set, {});
  const world = demoWorldOf(set.kind);
  const base = { nowMs: NOW, fixture, world };
  const out = [{ ...base, name: "herd", props: { role: "herd", overlay: "o2" }, preview: { width: 760, height: 520 } }];
  if (heroId != null) out.unshift({ ...base, name: "sheet", props: { role: "sheet", overlay: "o1", heroId }, preview: { width: 760, height: 500 } });
  return out;
}

export async function shootSet(set, { outDir = M.OUT_DIR, withRoles = false, previewFile = null } = {}) {
  const { panes, extra } = panesFor(set.kind);
  const theme = resolveTheme(set.theme ?? "graphite");
  const paneSpec = panes.map((p) => ({
    title: p.shell ? "zsh" : p.agent.title,
    focused: p.focused,
    lines: p.shell ? LINES.shell : linesFor(p.agent),
  }));
  const layout = composeWindow({ theme, panes: paneSpec });
  const B = layout.blocks;
  const rendered = await renderRoles(MAIN, windowRoles(set, panes, extra), {
    sizeFor: (role) => {
      const k = role.props.role;
      if (k === "party") return [B.party.width, B.party.height];
      if (k === "stage") return [B.stage.width, B.stage.height];
      if (k === "hud") return [B.stage.width, 26];
      if (k === "nameplate") return [B.nameplate.width - 2, B.nameplate.height];
      return [960, 240];
    },
  });
  const problems = [];
  for (const r of rendered) for (const e of r.errors) problems.push(`${set.name}/${r.role.name}: [${e.code}] ${e.message}`);
  const tree = (n) => rendered.find((r) => r.role.name === n)?.tree ?? null;
  const win = composeWindow({
    theme, panes: paneSpec, title: `Down the Stack · ${set.name}`,
    party: tree("party"), stage: tree("stage"), hud: tree("hud"),
    nameplates: panes.map((_, i) => tree(`nameplate-${i + 1}`)),
  });
  const shots = [{ name: `window-${set.name}`, html: win.html, width: win.sizes.width, height: win.sizes.height, userFacing: true, saveHtml: true }];
  if (withRoles) {
    for (const r of rendered) {
      if (!r.tree) continue;
      shots.push({ name: `real-${set.name}-${r.role.name}`, tree: r.tree, width: r.width, height: r.height, theme, userFacing: true });
    }
    const focusedHero = (() => {
      const w = demoWorld(set.kind, NOW).world;
      const addr = panes.find((p) => p.focused && p.agent)?.agent.address;
      for (const [id, live] of w.rt.live) if (live.address === addr) return id;
      return w.state.heroes[0]?.id ?? null;
    })();
    const dialogs = await renderRoles(MAIN, dialogRoles(set, focusedHero));
    for (const r of dialogs) {
      for (const e of r.errors) problems.push(`${set.name}/${r.role.name}: [${e.code}] ${e.message}`);
      if (r.tree) shots.push({ name: `real-${set.name}-${r.role.name}`, tree: r.tree, width: r.width, height: r.height, theme, userFacing: true });
    }
  }
  const files = await shoot(shots, { outDir });
  if (previewFile) fs.copyFileSync(files[0].file, previewFile);
  return { files, problems };
}

async function cli(argv) {
  let only = null;
  let withRoles = false;
  let outDir = M.OUT_DIR;
  let preview = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") only = argv[++i].split(",");
    else if (argv[i] === "--roles") withRoles = true;
    else if (argv[i] === "--out") outDir = path.resolve(argv[++i]);
    else if (argv[i] === "--preview") preview = true;
  }
  let bad = 0;
  for (const set of SETS) {
    if (only && !only.includes(set.name)) continue;
    const previewFile = preview && set.name === "mid" ? path.join(M.REPO, "preview.png") : null;
    const { files, problems } = await shootSet(set, { outDir, withRoles, previewFile });
    for (const f of files) console.log(`wrote ${path.relative(process.cwd(), f.file)}`);
    if (previewFile) console.log(`wrote ${path.relative(process.cwd(), previewFile)}`);
    for (const p of problems) console.warn(`  ! ${p}`);
    bad += problems.length;
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  cli(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
