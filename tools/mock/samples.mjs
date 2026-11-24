// Sample live data in herdr's exact shapes (herdr.d.ts): agents(), panes(), terminals(), spaces(),
// focused(), layout(). Fixture authors can start from sampleFixture() and edit it.

import fs from "node:fs";
import path from "node:path";
import { REPO } from "./config.mjs";

export const PROGRAMS = {
  claude: { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, tile: null, color: "#d97757", shell: false, agent: true },
  codex: { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: true, tile: null, color: "#e6e6e6", shell: false, agent: true },
  pi: { key: "pi", name: "pi", icon: "icons/pi.svg", tint: true, tile: null, color: "#9ad1ff", shell: false, agent: true },
  shell: { key: "shell", name: "zsh", icon: "icons/shell.svg", tint: true, tile: null, color: null, shell: true, agent: false },
};

/** One agent row (AgentInfo). */
export function agent(i, over = {}) {
  const program = over.program ?? PROGRAMS[["claude", "codex", "pi"][i % 3]];
  return {
    address: `t${i + 1}`, pane: `p${i + 1}`, space: "s1", space_name: "webapp", tab: "tab1", tab_index: 1, tab_name: "1",
    status: "working", app: program.key === "claude" ? "claude-code" : program.key, program,
    title: `task ${i + 1}`, pane_name: null, seq: 100 + i, pinned: false, focused: i === 0,
    ...over,
  };
}

/** The matching pane row (PaneInfo) for an agent row. */
export function paneFor(a, over = {}) {
  return {
    pane: a.pane, terminal: a.address, tab: a.tab, title: a.title, name: a.pane_name, cwd: "/mock/user/src/app", branch: "main",
    status: a.status, app: a.app, program: a.program, focused: a.focused, zoomed: false, movable: true,
    scroll: { total: 200, offset: 160, len: 40, from_bottom: 0 }, ...over,
  };
}

/** The matching terminals() row. */
export function terminalFor(a, over = {}) {
  return {
    address: a.address, argv: [a.program.key], name: a.title, template: null, parent: null, labels: {}, state: "live",
    status: a.status, report: { app: a.app }, program: a.program, selection: null, ...over,
  };
}

/**
 * A realistic window: `n` agents (statuses cycle working/blocked/done/idle) in one space and tab,
 * one live sub-agent under the first agent, the first agent focused.
 */
export function sampleFixture(n = 3, over = {}) {
  const statuses = ["working", "blocked", "done", "idle"];
  const agents = Array.from({ length: n }, (_, i) => agent(i, { status: statuses[i % 4] }));
  const panes = agents.map((a) => paneFor(a));
  const terminals = agents.map((a) => terminalFor(a));
  if (agents.length) {
    terminals.push(terminalFor(agent(90, { address: "t90", title: "sub-agent: tests", status: "working", program: PROGRAMS.claude }), { parent: agents[0].address }));
  }
  const tab = { id: "tab1", index: 1, name: "1", named: false, active: true, status: agents.length ? "blocked" : null, panes: panes.length, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: agents.length ? 0 : null };
  const spaces = [{ id: "s1", index: 1, name: "webapp", named: true, folder: "/mock/user/src/app", machine: null, branch: "main", active: true, status: tab.status, tabs: [tab] }];
  const focused = agents.length ? { space: "s1", tab: "tab1", pane: agents[0].pane, terminal: agents[0].address, shown: null, agent: null, cwd: "/mock/user/src/app", selection: null } : null;
  return { agents, panes, terminals, spaces, focused, layout: readLayout(), ...over };
}

/** layouts/Down-the-Stack.json if it exists (the shown layout), else null. */
export function readLayout(file = path.join(REPO, "layouts", "Down-the-Stack.json")) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
