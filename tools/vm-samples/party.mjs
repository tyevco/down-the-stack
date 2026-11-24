// Sample PartyVMs (ARCHITECTURE §5 partyView) for the party sidebar role (mods/mapledr/ui/party.js).
// They are the spec game/view.js has to produce and the fixtures for tests and previews:
// every visual state the renderer supports has a scenario. Ids and keys are stable strings.
//
// Shapes: PartyVM / RowVM as in ARCHITECTURE §5, plus the "VM additions" documented at the top of
// ui/party.js (RowVM.pane, RowVM.colors, RowVM.levelUpAge, RowVM.slim, RowVM.machine; chip.tooltip
// and the fork chip's terminal; footer values are display strings).

const C = { working: "#4CC38A", blocked: "#F2A93B", done: "#FFD447", idle: "#8A8F98", hp: "#FF5A5F", xp: "#7FE9F5", fresh: "#A9B8FF", lts: "#FF9A2E" };

// Program icons as the app's program table describes them (herdr defaults/programs.json).
const ICON = {
  claude: { path: "icons/claude.svg", tint: false, color: "#ffffff" },
  codex: { path: "icons/codex.svg", tint: false, color: "#ffffff" },
  pi: { path: "icons/pi.svg", tint: true, color: "#ffffff" },
  gemini: { path: "icons/gemini.svg", tint: true, color: "#ffffff" },
  opencode: { path: "icons/opencode.svg", tint: true, color: "#ffffff" },
};

// Termling colours (HeroVM.colors shape, the same convention as tools/vm-samples/stage.mjs):
// hoodie from PALETTE.termlingTint by hero, a dark title bar per program, the face ink in the
// status colour.
const TINT = ["#6C8CF5", "#F07D5C", "#45C2A8", "#C47BE8", "#E8B84A", "#5FB0E8", "#E86F9C", "#8FBF5A"];
const BAR = { "icons/claude.svg": "#3B2A24", "icons/codex.svg": "#3A3F4B", "icons/pi.svg": "#2F5D8C", "icons/gemini.svg": "#3D3357", "icons/opencode.svg": "#2E3A36" };
const colorsFor = (id, icon, status) => ({
  hoodie: TINT[(id - 1) % TINT.length],
  titleBar: BAR[icon?.path] ?? "#33384A",
  screen: "#17161F",
  faceInk: { working: C.working, blocked: C.blocked, done: C.done, idle: C.idle }[status] ?? C.idle,
});

const STRIPE = { working: C.working, blocked: C.blocked, done: C.done, idle: C.idle };
const FACE = { working: ">_", blocked: "o_o", done: "^_^", idle: "-_-" };

/** One RowVM with realistic defaults. */
function row(id, o) {
  const status = o.status ?? "working";
  return {
    key: `h:${id}`,
    heroId: id,
    address: o.address === undefined ? `t${id}` : o.address,
    pane: o.pane === undefined ? `p${id}` : o.pane,
    name: o.name,
    level: o.level,
    careerTitle: o.careerTitle,
    clsName: o.clsName,
    mapLabel: o.mapLabel ?? "",
    status,
    stripe: o.stripe ?? STRIPE[status] ?? C.idle,
    face: o.face ?? FACE[status] ?? "-_-",
    programIcon: o.programIcon === undefined ? ICON.claude : o.programIcon,
    focused: !!o.focused,
    pinned: !!o.pinned,
    hpFrac: o.hpFrac ?? 1,
    xpFrac: o.xpFrac ?? 0.3,
    feFrac: o.feFrac ?? 0,
    chips: o.chips ?? [],
    tooltip: o.tooltip ?? `${o.name} · Lv ${o.level} ${o.careerTitle}`,
    chestPending: !!o.chestPending,
    colors: o.colors ?? colorsFor(id, o.programIcon === undefined ? ICON.claude : o.programIcon, status),
    levelUpAge: o.levelUpAge ?? null,
    slim: !!o.slim,
    machine: o.machine ?? null,
  };
}

const chip = (id, kind, text, color, extra) => ({ key: `c:${id}:${kind}`, kind, text, color, ...extra });
// The Forkling count: a click shows the first blocked (else working) sub-agent (agent.focus).
const forkChip = (id, n, terminal) => chip(id, "fork", String(n), C.idle, { terminal, tooltip: `${n} Forklings · click to jump to one` });

const FOOTER = { gold: "48.2k", snippets: "133", release: "v2.3", sprint: { label: "Pyramid of Doom", have: 7, need: 10 }, digestDot: true };

// ---------------------------------------------------------------------------------------------
// heroes

const kip = row(1, {
  name: "Kip the Idempotent", level: 14, careerTitle: "Junior Refactorer", clsName: "Refactorer",
  mapLabel: "2-2 Nested Tunnels", status: "working", focused: true, pinned: true,
  hpFrac: 0.82, xpFrac: 0.46, feFrac: 0.14,
  chips: [forkChip(1, 2, "t1.2")],
  tooltip: "Kip the Idempotent · Lv 14 Junior Refactorer\nQuest: Fix flaky auth test (12m)\nHP 1,204 / 1,468 · XP 46% · Fresh Eyes 42m\n+512 XP/min = working ×1 · Fresh Eyes ×1.5 · Party +12% · Herd +23%",
});
const rue = row(2, {
  name: "Rue Two-Spaces", level: 11, careerTitle: "Junior Rubberducker", clsName: "Rubberducker",
  mapLabel: "1-3 Warning Gate", status: "blocked", programIcon: ICON.codex,
  hpFrac: 0.64, xpFrac: 0.71,
  chips: [chip(2, "blocked", "! 2m", C.blocked)],
  tooltip: "Rue Two-Spaces · Lv 11 Junior Rubberducker\nWaiting for you for 2m · click to jump there",
});
const ada = row(3, {
  name: "Ada Null-Safe", level: 17, careerTitle: "Junior Hotfixer", clsName: "Hotfixer",
  mapLabel: "2-2 Nested Tunnels", status: "done", programIcon: ICON.claude, chestPending: true,
  hpFrac: 1, xpFrac: 0.22, feFrac: 0.3,
  chips: [chip(3, "chest", "", C.done)],
  tooltip: "Ada Null-Safe · Lv 17 Junior Hotfixer\nShipped: Add retry to webhook sender · 2.4 Seals · Iron chest\nClick the chest to open it",
});
const juno = row(4, {
  name: "Juno of the Green Build", level: 31, careerTitle: "Senior Shellmancer", clsName: "Shellmancer",
  mapLabel: "3-1 Anchor Steps", status: "working", programIcon: ICON.pi,
  hpFrac: 0.41, xpFrac: 0.88,
  chips: [chip(4, "boss", "BOSS 41%", C.hp)],
  tooltip: "Juno of the Green Build · Lv 31 Senior Shellmancer\nFighting the Pyramid of Doom: 41% left",
});
const pax = row(5, {
  name: "Pax the Rebased", level: 9, careerTitle: "Intern", clsName: "Intern",
  mapLabel: "1-2 Whitespace Fields", status: "working", programIcon: ICON.gemini,
  hpFrac: 0.95, xpFrac: 0.12, levelUpAge: 0,
  chips: [chip(5, "unblocked", "", C.working), chip(5, "star", "", C.lts)],
  tooltip: "Pax the Rebased · Lv 9 Intern\nUnblocked: +15% damage and XP for 1m 40s\nNew LTS drop: Hackathon Jacket",
});
const ori = row(6, {
  name: "Ori Semicolon-Sworn", level: 22, careerTitle: "Junior Forkbinder", clsName: "Forkbinder",
  mapLabel: "2-3 Pyramid Steps", status: "idle", programIcon: ICON.opencode,
  hpFrac: 1, xpFrac: 0.57, feFrac: 0.25,
  tooltip: "Ori Semicolon-Sworn · Lv 22 Junior Forkbinder\nResting at the campfire · Fresh Eyes 52m",
});

// Off duty: no live agent (address/pane null); click opens the sheet.
const offDuty = (id, o) => row(id, { status: "idle", address: null, pane: null, focused: false, stripe: C.idle, face: "-_-", ...o });
const zed = offDuty(7, { name: "Zed Off-By-One", level: 27, careerTitle: "Junior Hotfixer", clsName: "Hotfixer", mapLabel: "Off duty", hpFrac: 1, xpFrac: 0.4, feFrac: 0.6, programIcon: ICON.codex, tooltip: "Zed Off-By-One · Lv 27 Junior Hotfixer\nOff duty since yesterday · Fresh Eyes 3h 30m" });
const lumi = offDuty(8, { name: "Lumi the Cached", level: 12, careerTitle: "Junior Shellmancer", clsName: "Shellmancer", mapLabel: "Off duty", hpFrac: 1, xpFrac: 0.8, feFrac: 0.2, chestPending: true, chips: [chip(8, "chest", "", C.done)], tooltip: "Lumi the Cached · Lv 12 Junior Shellmancer\nOff duty · a chest is waiting: click it to open it" });
const brin = offDuty(9, { name: "Brin Tab-Born", level: 5, careerTitle: "Intern", clsName: "Intern", mapLabel: "Off duty", hpFrac: 1, xpFrac: 0.1, programIcon: ICON.pi });

function party(groups, over = {}) {
  const rows = groups.flatMap((g) => g.rows);
  return {
    compact: false,
    title: "Party",
    count: rows.length,
    version: 412,
    calm: false,
    groups,
    footer: { ...FOOTER },
    agentOrder: rows.filter((r) => r.address).map((r) => r.address),
    ...over,
  };
}

const sixGroups = () => [
  { key: "g:s1", name: "herdr-app", offDuty: false, rows: [kip, rue, ada] },
  { key: "g:s2", name: "mapledr", offDuty: false, rows: [juno, pax, ori] },
  { key: "g:off", name: "Off duty", offDuty: true, rows: [zed, lumi, brin] },
];

// ---------------------------------------------------------------------------------------------
// blocked-heavy: most of the party waits for the person

const blockedRow = (id, o) => row(id, { status: "blocked", face: "o_o", ...o });
const blockedGroups = () => [
  {
    key: "g:s1", name: "herdr-app", offDuty: false, rows: [
      blockedRow(11, { name: "Rue Two-Spaces", level: 11, careerTitle: "Junior Rubberducker", clsName: "Rubberducker", mapLabel: "1-3 Warning Gate", programIcon: ICON.codex, hpFrac: 0.6, xpFrac: 0.7, chips: [chip(11, "blocked", "! 14m", C.blocked)], focused: true }),
      blockedRow(12, { name: "Tess the Squashed", level: 19, careerTitle: "Junior Refactorer", clsName: "Refactorer", mapLabel: "2-3 Pyramid Steps", hpFrac: 0.35, xpFrac: 0.4, chips: [chip(12, "blocked", "! 1h+", C.blocked), forkChip(12, 3, "t12.1")] }),
      blockedRow(13, { name: "Coda Hot-Reloaded", level: 8, careerTitle: "Intern", clsName: "Intern", mapLabel: "1-2 Whitespace Fields", programIcon: ICON.pi, hpFrac: 0.9, xpFrac: 0.55, chips: [chip(13, "blocked", "! 5m", C.blocked)] }),
    ],
  },
  {
    key: "g:s3", name: "billing-service", offDuty: false, rows: [
      blockedRow(14, { name: "Fen of Clean Diffs", level: 44, careerTitle: "Senior Hotfixer", clsName: "Hotfixer", mapLabel: "4-2 Stash Bog", programIcon: ICON.claude, hpFrac: 0.12, xpFrac: 0.33, chips: [chip(14, "blocked", "! 38m", C.blocked), chip(14, "chest", "×2", C.done)], chestPending: true }),
      row(15, { name: "Mira the Deterministic", level: 52, careerTitle: "Senior Shellmancer", clsName: "Shellmancer", mapLabel: "4-3 Octopus Delta", status: "working", programIcon: ICON.codex, hpFrac: 0.7, xpFrac: 0.64, feFrac: 0.1, chips: [chip(15, "review", "REVIEW", C.hp)] }),
      blockedRow(16, { name: "Quill Zero-Indexed", level: 60, careerTitle: "Staff Forkbinder", clsName: "Forkbinder", mapLabel: "5-1 Lockfile Clearing", programIcon: ICON.gemini, hpFrac: 0.5, xpFrac: 0.05, chips: [chip(16, "blocked", "! 3m", C.blocked)], pinned: true }),
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// crowded: 30 live heroes (game/view switches to slim rows above 12 live rows)

const PROGS = [ICON.claude, ICON.codex, ICON.pi, ICON.gemini, ICON.opencode];
const CLS = [["Refactorer", "Junior Refactorer"], ["Hotfixer", "Senior Hotfixer"], ["Shellmancer", "Staff Shellmancer"], ["Forkbinder", "Junior Forkbinder"], ["Rubberducker", "Senior Rubberducker"]];
const STATUS_CYCLE = ["working", "working", "blocked", "working", "done", "idle", "working"];
function crowdedGroups() {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const id = 31 + i;
    const status = STATUS_CYCLE[i % STATUS_CYCLE.length];
    const [clsName, careerTitle] = CLS[i % CLS.length];
    const chips = [];
    if (status === "blocked") chips.push(chip(id, "blocked", i % 2 ? "! 12m" : "!", C.blocked));
    if (status === "done") chips.push(chip(id, "chest", i % 3 ? "" : "×2", C.done));
    if (i % 9 === 4) chips.push(chip(id, "boss", "BOSS 63%", C.hp));
    if (i % 11 === 3) chips.push(forkChip(id, 2, `t${id}.1`));
    rows.push(row(id, {
      name: `Hero ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? i : ""} the ${["Idempotent", "Rebased", "Linted", "Cached", "Deterministic"][i % 5]}`,
      level: 20 + ((i * 7) % 70), careerTitle, clsName, mapLabel: `${1 + (i % 9)}-${1 + (i % 3)} Somewhere`, status,
      programIcon: PROGS[i % PROGS.length], focused: i === 5, pinned: i === 0 || i === 17,
      hpFrac: 1 - (i % 5) * 0.15, xpFrac: ((i * 13) % 100) / 100, feFrac: i % 4 === 0 ? 0.1 : 0,
      chips, chestPending: status === "done", slim: true, machine: i === 8 ? "vps" : null, levelUpAge: i === 2 ? 0 : null,
    }));
  }
  return [
    { key: "g:s1", name: "herdr-app", offDuty: false, rows: rows.slice(0, 16) },
    { key: "g:s3", name: "billing-service", offDuty: false, rows: rows.slice(16) },
    { key: "g:off", name: "Off duty", offDuty: true, rows: [zed, lumi, brin].map((r) => ({ ...r, slim: true })) },
  ];
}

// ---------------------------------------------------------------------------------------------

export const scenarios = {
  /** host.view returned null: the world is still loading. */
  loading: null,
  /** No agent has reported a status yet. */
  empty: party([], { count: 0, agentOrder: [], footer: { gold: "0", snippets: "0", release: "v0.1", sprint: null, digestDot: false } }),
  /** First day: one hero in one guild. */
  one: party([{ key: "g:s1", name: "mapledr", offDuty: false, rows: [row(21, { name: "Nib the Linted", level: 3, careerTitle: "Intern", clsName: "Intern", mapLabel: "1-1 Squiggle Path", status: "working", focused: true, hpFrac: 0.9, xpFrac: 0.62 })] }],
    { footer: { gold: "312", snippets: "4", release: "v0.1", sprint: { label: "Lint Meadows boss", have: 1, need: 6 }, digestDot: false } }),
  /** Six heroes in two guilds plus a collapsed off-duty group (statuses, chips, focus, pin, level-up). */
  six: party(sixGroups()),
  /** Most of the party is blocked. */
  blocked: party(blockedGroups(), { footer: { gold: "1.24M", snippets: "2.1k", release: "v5.0", sprint: { label: "The Octopus Merge", have: 3, need: 12 }, digestDot: true } }),
  /** The sidebar rail (width 52): portraits and stripes only. */
  rail: party(sixGroups(), { compact: true }),
  /** Calm mode: no blinking faces, no shimmer. */
  calm: party(sixGroups(), { calm: true }),
  /** 30 live heroes: slim 28 px rows (and a remote agent's machine label). */
  crowded: party(crowdedGroups(), { footer: { gold: "9.81M", snippets: "12.4k", release: "v4.7", sprint: { label: "Bloatodon, the Heaviest Object", have: 41, need: 70 }, digestDot: false } }),
};

/** Block width (logical px) each scenario is meant to be seen at. */
export const widths = { loading: 268, empty: 268, one: 268, six: 268, blocked: 268, rail: 52, calm: 268, crowded: 268 };

/** The same VM one tick later (bars moved, a chip changed): ids must stay stable. */
export function nextTick(vm) {
  if (!vm) return vm;
  const out = JSON.parse(JSON.stringify(vm));
  out.version += 1;
  for (const g of out.groups) {
    for (const r of g.rows) {
      r.xpFrac = Math.min(1, r.xpFrac + 0.01);
      r.hpFrac = Math.max(0, r.hpFrac - 0.02);
      if (r.levelUpAge === 0) r.levelUpAge = 1;
      for (const c of r.chips) if (c.kind === "blocked") c.text = c.text.replace(/\d+m/, (m) => `${parseInt(m, 10) + 1}m`);
    }
  }
  return out;
}
