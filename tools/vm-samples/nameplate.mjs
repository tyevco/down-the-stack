// Sample PlateVMs (ARCHITECTURE §5 nameplateView) for the pane header role
// (mods/mapledr/ui/nameplate.js), plus the herdr side each scenario is seen with: the pane's
// PaneInfo (what panes() returns for props().pane) and the header width. `scenarios` is the spec
// game/view.js has to produce; `panes` / `widths` are the herdr fixture for tests and previews.
//
// Shapes: PlateVM as in ARCHITECTURE §5, plus the "VM additions" at the top of ui/nameplate.js
// (face, status, colors, calm, chip.short). A null VM means "no hero here": herdr's plain pane header.

const ICON = {
  claude: { path: "icons/claude.svg", tint: false, color: "#ffffff" },
  codex: { path: "icons/codex.svg", tint: false, color: "#ffffff" },
  pi: { path: "icons/pi.svg", tint: true, color: "#ffffff" },
};
const PROGRAM = {
  claude: { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, tile: "#1c1d21", color: "#ffffff", shell: false, agent: true },
  codex: { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: false, tile: "#1c1d21", color: "#ffffff", shell: false, agent: true },
  pi: { key: "pi", name: "Pi", icon: "icons/pi.svg", tint: true, tile: "#1c1d21", color: "#ffffff", shell: false, agent: true },
  shell: { key: "shell", name: "zsh", icon: "icons/shell.svg", tint: true, tile: null, color: null, shell: true, agent: false },
};

// Same colour convention as the party / stage samples (hoodie tint, program title bar, status ink).
const colors = (hoodie, bar, ink) => ({ hoodie, titleBar: bar, screen: "#17161F", faceInk: ink });
const REFACTORER = colors("#6C8CF5", "#3B2A24", "#4CC38A");
const RUBBERDUCKER = colors("#F07D5C", "#3A3F4B", "#F2A93B");
const SHELLMANCER = colors("#C47BE8", "#2F5D8C", "#4CC38A");

const kip = {
  heroId: 1, name: "Kip the Idempotent", level: 14, careerTitle: "Junior Refactorer", clsName: "Refactorer",
  programIcon: ICON.claude, hpFrac: 0.82, xpFrac: 0.46, feFrac: 0.14,
  chip: { text: "fighting 2-2", short: "2-2", color: "#8A8F98" },
  tooltip: "Kip the Idempotent · Lv 14 Junior Refactorer\nPower Level 16 = Lv 14 + gear 2\nQuest: Fix flaky auth test (12m)\nFresh Eyes 42m · Shift 3h12m today (full rate until 4h)\n+512 XP/min = working ×1 · Fresh Eyes ×1.5 · Party +12% · Herd +23%",
  contractor: false,
  face: ">_", status: "working", colors: REFACTORER, calm: false,
};

const pane = (id, o = {}) => ({
  pane: `p${id}`, terminal: `t${id}`, tab: "tab1", title: "✳ Fix flaky auth test", name: null,
  cwd: "/mock/user/src/herdr-app", branch: "main", status: "working", app: "claude-code", program: PROGRAM.claude,
  focused: true, zoomed: false, movable: true, scroll: { total: 200, offset: 160, len: 40, from_bottom: 0 }, ...o,
});

export const scenarios = {
  /** A working agent pane, focused. */
  focused: kip,
  /** The same hero, pane not focused (name not bold). */
  unfocused: { ...kip },
  /** Blocked: amber chip, face o_o. */
  blocked: {
    ...kip, heroId: 2, name: "Rue Two-Spaces", level: 11, careerTitle: "Junior Rubberducker", clsName: "Rubberducker",
    programIcon: ICON.codex, hpFrac: 0.64, xpFrac: 0.71, feFrac: 0, face: "o_o", status: "blocked", colors: RUBBERDUCKER,
    chip: { text: "! waiting 2m", short: "! 2m", color: "#F2A93B" },
    tooltip: "Rue Two-Spaces · Lv 11 Junior Rubberducker\nWaiting for you for 2m on “Waiting for approval: run migrations?”",
  },
  /** Shipped with a chest waiting (gold chip). */
  shipped: {
    ...kip, heroId: 3, name: "Ada Null-Safe", level: 17, careerTitle: "Junior Hotfixer", clsName: "Hotfixer",
    hpFrac: 1, xpFrac: 0.22, feFrac: 0.3, face: "^_^", status: "done",
    colors: colors("#45C2A8", "#3B2A24", "#FFD447"),
    chip: { text: "shipped · chest ready", short: "shipped", color: "#FFD447" }, tooltip: "Ada Null-Safe · Lv 17 Junior Hotfixer\nShipped: Add retry to webhook sender · 2.4 Seals · Iron chest",
  },
  /** In a boss fight (red chip). */
  boss: {
    ...kip, heroId: 4, name: "Juno of the Green Build", level: 31, careerTitle: "Senior Shellmancer", clsName: "Shellmancer",
    programIcon: ICON.pi, hpFrac: 0.41, xpFrac: 0.88, feFrac: 0, colors: SHELLMANCER,
    chip: { text: "BOSS 41%", short: "BOSS 41%", color: "#FF5A5F" }, tooltip: "Juno of the Green Build · Lv 31 Senior Shellmancer\nFighting the Pyramid of Doom: 41% left",
  },
  /** A Contractor (roster full): not saved, tagged. */
  contractor: {
    ...kip, heroId: -7, name: "Vik the Patient", level: 26, careerTitle: "Junior Shellmancer", clsName: "Shellmancer",
    programIcon: ICON.claude, hpFrac: 0.9, xpFrac: 0.1, feFrac: 0, colors: SHELLMANCER, contractor: true,
    chip: { text: "fighting 3-1", short: "3-1", color: "#8A8F98" }, tooltip: "Vik the Patient (contractor) · Lv 26 Junior Shellmancer\nContractors don't get equity.",
  },
  /** Not an agent pane (a plain shell): herdr's plain header. */
  shell: null,
  /** An agent pane while the world is still loading: herdr's plain header with the agent status. */
  loading: null,
  /** Long hero name and a long terminal title: both truncate. */
  long: {
    ...kip, heroId: 5, name: "Tamsin of the Long Uptime and Many Branches", level: 88, careerTitle: "Staff Refactorer", clsName: "Refactorer",
    chip: { text: "supervising 2 Forklings", short: "supervising", color: "#8A8F98" }, face: ">_", status: "working",
  },
  /** A narrow pane (220 px): program icon, face, the terminal title (truncating) and the chip. */
  narrow: { ...kip },
  /** A very narrow pane (180 px), blocked: the face and the chip's short form ("! 2m"). */
  micro: {
    ...kip, heroId: 2, name: "Rue Two-Spaces", level: 11, face: "o_o", status: "blocked", colors: RUBBERDUCKER,
    chip: { text: "! waiting 2m", short: "! 2m", color: "#F2A93B" },
  },
  /** Calm mode: the face does not blink. */
  calm: { ...kip, calm: true },
};

export const panes = {
  focused: pane(1),
  unfocused: pane(1, { focused: false }),
  blocked: pane(2, { title: "⏳ Waiting for approval: run migrations?", status: "blocked", app: "codex", program: PROGRAM.codex, focused: false }),
  shipped: pane(3, { title: "✳ Add retry to webhook sender", status: "done", focused: false }),
  boss: pane(4, { title: "π refactor billing proration", status: "working", app: "pi", program: PROGRAM.pi, focused: false, cwd: "/mock/user/src/billing" }),
  contractor: pane(5, { title: "✳ Update dependency lockfile", focused: false }),
  shell: pane(6, { title: "~/src/herdr-app", status: null, app: null, program: PROGRAM.shell, focused: false }),
  loading: pane(7, { title: "✳ Investigate slow CI", status: "working", focused: true }),
  long: pane(8, { title: "✳ Migrate every remaining callback-style handler in the legacy payments module to async/await and update the tests", cwd: "/mock/user/src/payments-platform/services/legacy-adapter", focused: true }),
  narrow: pane(9, { focused: true }),
  micro: pane(11, { title: "⏳ Waiting for approval: run migrations?", status: "blocked", focused: false }),
  calm: pane(10),
};

/** Header width (logical px) each scenario is seen at. */
export const widths = { focused: 760, unfocused: 760, blocked: 590, shipped: 590, boss: 590, contractor: 760, shell: 590, loading: 590, long: 760, narrow: 220, micro: 180, calm: 590 };

/** One tick later: bars moved; ids must stay stable. */
export function nextTick(vm) {
  if (!vm) return vm;
  return { ...vm, hpFrac: Math.max(0, vm.hpFrac - 0.03), xpFrac: Math.min(1, vm.xpFrac + 0.01) };
}
