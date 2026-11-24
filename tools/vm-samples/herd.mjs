// Sample HerdVMs (game/view.js herdView) for the Herd panel dialog (mods/mapledr/ui/herdpanel.js).
// They are the spec view.js has to produce and the fixtures for tests and previews: every visual
// state the renderer supports has a scenario. Shapes: the typedefs at the top of ui/herdpanel.js
// (HerdVM, BuildingVM, UpgradesVM, HerdStashVM, TrackerVM, ZoneTrackVM, BossesVM, BossRowVM,
// RosterVM, RosterRowVM, DigestVM, SettingsVM, SettingRowVM) and the shared ones in ui/sheet.js
// (ActionVM, ItemVM, CardVM, ChipVM, SquashVM, StashVM). Every string is display-ready; content
// names come from game/data.js so they match the art and the rest of the game.

import { ZONES, MOBS, BOSSES, AFFIXES } from "../../mods/mapledr/game/data.js";
import { RAR, action, item, cardOf, filters } from "./sheet.mjs";

const C = { working: "#4CC38A", blocked: "#F2A93B", done: "#FFD447", idle: "#8A8F98", hp: "#FF5A5F", xp: "#7FE9F5", fresh: "#A9B8FF" };
const ICON = {
  claude: { path: "icons/claude.svg", tint: false, color: "#ffffff" },
  codex: { path: "icons/codex.svg", tint: false, color: "#ffffff" },
  gemini: { path: "icons/gemini.svg", tint: true, color: "#ffffff" },
};
const FACE = { working: ">_", blocked: "o_o", done: "^_^", idle: "-_-", off: "-_-" };
const STRIPE = { working: C.working, blocked: C.blocked, done: C.done, idle: C.idle, off: C.idle };

const TABS = [["upgrades", "Upgrades"], ["stash", "Stash"], ["tracker", "Tracker"], ["bosses", "Bosses"], ["roster", "Roster"], ["digest", "Digest"], ["settings", "Settings"]];

function header(o = {}) {
  const sub = o.sub ?? "9 heroes · 2 working · 1 waiting for you";
  return {
    name: o.name ?? "The Herd", release: o.release ?? "v2.3",
    releaseTip: o.releaseTip ?? "Release Train: 562 Seals credited · v2.4 at 584 · +11.5% XP and gold",
    gold: o.gold ?? "212k", snippets: o.snippets ?? "312",
    // waiting: the blocked part of sub, drawn in the blocked colour (null when nobody waits)
    sub, waiting: o.waiting !== undefined ? o.waiting : (/\d+ waiting for you/.exec(sub) ?? [null])[0],
    sprint: o.sprint === undefined ? { label: "The Octopus Merge", have: 45, need: 45, text: "Sprint 45 / 45" } : o.sprint,
  };
}

function base(tab, o = {}) {
  return {
    tab, tabs: TABS.map(([id, label]) => ({ id, label, badge: id === "digest" ? (o.digestBadge === undefined ? "4" : o.digestBadge) : null })),
    calm: !!o.calm, header: header(o.header),
    // save: the save trouble band (D§13.4) from args.save; null while the save is fine
    save: o.save ?? null,
    upgrades: null, stash: null, tracker: null, bosses: null, roster: null, digest: null, settings: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Upgrades

const BLD = [
  { id: "campfire", name: "Campfire", icon: { path: "fx/campfire.svg", mask: false }, max: 10, base: 800, tooltip: "Fresh Eyes cap +15 min per level (60 → 210)",
    effect: (n) => `Fresh Eyes cap ${60 + 15 * n} min`, next: (n) => `Next: ${75 + 15 * n} min` },
  { id: "coffee_machine", name: "Coffee Machine", icon: { path: "fx/mug.svg", mask: false }, max: 10, base: 800, tooltip: "Coffee heals +3% and costs −5% per level",
    effect: (n) => `Coffee heals ${35 + 3 * n}% · price −${5 * n}%`, next: (n) => `Next: heals ${38 + 3 * n}% · −${5 * n + 5}%` },
  { id: "ci_forge", name: "CI Forge", icon: { path: "ui/gear.svg", mask: true }, max: 10, base: 1200, tooltip: "Polish gold −4% per level; level 3 unlocks Squash Merge, level 5 Reroll",
    effect: (n) => `Polish −${4 * n}%${n >= 5 ? " · Squash · Reroll" : n >= 3 ? " · Squash" : ""}`, next: (n) => `Next: −${4 * n + 4}%${n === 2 ? " · unlocks Squash Merge" : n === 4 ? " · unlocks Reroll" : ""}` },
  { id: "vendor", name: "vendor/", icon: { path: "ui/chest.svg", mask: true }, max: 10, base: 1000, tooltip: "Heavier than it looks.",
    effect: (n) => `${40 + 10 * n} stash slots`, next: (n) => `Next: ${50 + 10 * n} slots` },
  { id: "docs_library", name: "Docs Library", icon: { path: "ui/journal.svg", mask: true }, max: 10, base: 1500, tooltip: "+2% herd XP per level (inside the +60% herd cap)",
    effect: (n) => `+${2 * n}% herd XP`, next: (n) => `Next: +${2 * n + 2}%` },
  { id: "war_room", name: "War Room", icon: { path: "ui/boss.svg", mask: true }, max: 5, base: 3000, tooltip: "Boss and review timers +6 ticks per level",
    effect: (n) => `Boss timers +${6 * n} ticks`, next: (n) => `Next: +${6 * n + 6} ticks` },
];

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, "")}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "")}k` : String(n));

function upgrades(levels, gold, autoOn = true, trophies = 3) {
  return {
    buildings: BLD.map((b, i) => {
      const n = levels[i];
      const maxed = n >= b.max;
      const cost = b.base * 3 ** n;
      const ok = gold >= cost;
      return {
        key: `b:${b.id}`, id: b.id, name: b.name, icon: b.icon, level: n, max: b.max, levelText: `${n} / ${b.max}`,
        effect: b.effect(n), next: maxed ? null : b.next(n), maxed,
        buy: maxed ? null : action(`buy:${b.id}`, "Buy", "buy", { building: b.id }, { cost: `${fmt(cost)} gold`, enabled: ok, tone: ok ? "primary" : null, tooltip: ok ? `Level ${n + 1} for ${fmt(cost)} gold` : `Needs ${fmt(cost)} gold (the herd has ${fmt(gold)})` }),
        tooltip: b.tooltip,
      };
    }),
    note: `Autopilot buys the cheapest upgrade when gold ≥ 3× its cost and keeps a 20% reserve (Auto buildings: ${autoOn ? "on" : "off"}).`,
    trophies: `Trophies: +${trophies}% damage and max HP for every hero`,
  };
}

// ---------------------------------------------------------------------------------------------
// Stash (shared vendor/): the same items the sheet samples use, plus more, as a grid

function stashItems() {
  const list = [
    item(921, { slot: "weapon", cls: "refactorer", name: "Vectorized Extract Saber of Graceful Degradation", rar: 3, ilvl: 36, ip: "741", isNew: true, delta: { text: "+4.1%", good: true }, tooltip: "Release weapon (Blades) · iLvl 36 · best on Kip (+4.1%)" }),
    item(940, { slot: "weapon", cls: "hotfixer", name: "Recursive Monkey-Patch Knife of Graceful Degradation", rar: 3, ilvl: 35, ip: "702", tooltip: "Release weapon (Patch Knives) · iLvl 35 · best on Rue (+2.7%)" }),
    item(915, { slot: "hoodie", name: "Robust Fleece Vest", rar: 2, ilvl: 41, ip: "580", tooltip: "Beta hoodie · iLvl 41 · best on Fen (+1.6%)" }),
    item(950, { slot: "mug", name: "Bottomless Travel Thermos", rar: 4, ilvl: 41, ip: "897", tooltip: "LTS mug · iLvl 41 · best on Juno (+5.0%)", squashable: false }),
    item(951, { slot: "hat", name: "Hazard Cone Hat", rar: 5, ilvl: 12, ip: "235", locked: true, tooltip: "Keepsake hat · iLvl 12 · from The Ignored Warning", squashable: false }),
    item(952, { slot: "hat", name: "Curly Brace Crown", rar: 5, ilvl: 23, ip: "461", locked: true, tooltip: "Keepsake hat · iLvl 23 · from The Pyramid of Doom", squashable: false }),
  ];
  const slots = ["weapon", "hat", "hoodie", "mug", "boots", "sticker"];
  // tier-2 bases (iLvl 21–40) and only the affixes each slot can roll (D§8.3, D§14.7)
  const names = { weapon: ["Here-Doc Staff", "Manpage Grimoire", "Bathtub Duck", "Extract Saber", "Monkey-Patch Knife"], hat: ["Headphones"], hoodie: ["Zip Hoodie"], mug: ["Chipped Mug"], boots: ["Office Slippers"], sticker: ["Holo Sticker"] };
  const cls = ["shellmancer", "forkbinder", "rubberducker", "refactorer", "hotfixer"];
  const pool = (slot, kind) => AFFIXES.filter((a) => a.kind === kind && a.slots.includes(slot)).map((a) => a.name);
  for (let i = 0; i < 38; i++) {
    const slot = slots[i % 6];
    const nm = names[slot][i % names[slot].length];
    const rar = [0, 1, 1, 2, 0, 1, 2, 3][i % 8];
    const ilvl = 28 + (i * 5) % 13;
    const pre = pool(slot, "prefix");
    const suf = pool(slot, "suffix");
    const name = rar === 0 ? nm : rar === 1 ? `${pre[i % pre.length]} ${nm}` : `${pre[(i + 2) % pre.length]} ${nm} ${suf[i % suf.length]}`;
    const pol = i % 7 === 3 ? 2 : 0;
    list.push(item(960 + i, { slot, cls: slot === "weapon" ? cls[i % 5] : undefined, name: pol ? `${name} +${pol}` : name, rar, ilvl, pol,
      ip: String(Math.round(10 * ilvl * [1, 1.1, 1.22, 1.36][rar] * (1 + 0.08 * rar))), locked: i % 13 === 5, usable: i % 9 !== 4,
      isNew: i % 11 === 2, tooltip: `${["Prototype", "Alpha", "Beta", "Release"][rar]} ${slot} · iLvl ${ilvl}` }));
  }
  return list;
}

function herdStash(f = {}, o = {}) {
  const all = o.empty ? [] : stashItems();
  const slotOf = (it) => (it.icon.startsWith("gear/weapon") ? "weapon" : it.icon.replace(/^ui\/slot-|\.svg$/g, ""));
  const items = all.filter((it) => (!f.slot || f.slot === "all" || slotOf(it) === f.slot) && it.rar >= (f.minRar ?? 0) && (!f.usable || it.usable));
  const picked = (f.squash ?? []).slice();
  const focus = all.some((x) => x.uid === f.focus) ? f.focus : null; // a focus on a missing item shows no card
  let card = null;
  if (focus === 921) {
    card = cardOf(all.find((x) => x.uid === 921), {
      sub: "Release weapon · iLvl 36 · req Lv 33", stat: "Weapon damage 87",
      affixes: [
        { key: "921:0", text: "+10.4% area damage", reroll: action("reroll:921:0", "Reroll", "reroll", { uid: 921, affix: 0 }, { cost: "10.5k gold · 20 Snippets" }) },
        { key: "921:1", text: "+6.6% damage", reroll: action("reroll:921:1", "Reroll", "reroll", { uid: 921, affix: 1 }, { cost: "10.5k gold · 20 Snippets" }) },
        { key: "921:2", text: "+12.8% damage while below 50% HP", reroll: action("reroll:921:2", "Reroll", "reroll", { uid: 921, affix: 2 }, { cost: "10.5k gold · 20 Snippets" }) },
      ],
      polish: "Polish +0 of +9", owner: "Best on Kip the Idempotent · score +4.1%",
      actions: [
        action("equip:921", "Equip on Kip", "equip", { heroId: 1, uid: 921 }, { tone: "primary", tooltip: "Kip's +5 polish ports +2 to it, free" }),
        action("lock:921", "Lock", "lock", { uid: 921, locked: true }),
        action("polish:921", "Polish", "polish", { uid: 921 }, { cost: "982 gold · 2 Snippets", tooltip: "+5% weapon damage (to +1)" }),
        action("deprecate:921", "Deprecate", "deprecate", { uid: 921 }, { cost: "+40 Snippets", tone: "danger", confirm: "Deprecate it?" }),
      ],
    });
  } else if (focus === 951) {
    card = cardOf(all.find((x) => x.uid === 951), {
      sub: "Keepsake hat · iLvl 12 · req Lv 9", stat: "Armor 18",
      affixes: [{ key: "951:0", text: "+1.4% crit chance", reroll: null }, { key: "951:1", text: "+5.2% max HP", reroll: null }, { key: "951:2", text: "+1.6% XP", reroll: null }],
      prop: { name: "Hazard Cone Hat", text: "+5% crit chance, +5% XP" }, polish: "Polish +0 of +12",
      flavor: "From The Ignored Warning. Yellow since the first commit.", owner: "Nobody wears it: heroes outlevelled it",
      actions: [
        action("lock:951", "Unlock", "lock", { uid: 951, locked: false }),
        action("polish:951", "Polish", "polish", { uid: 951 }, { cost: "219 gold · 1 Snippet" }),
        action("deprecate:951", "Deprecate", "deprecate", { uid: 951 }, { enabled: false, tooltip: "Keepsakes are never deprecated" }),
      ],
    });
  }
  return {
    title: "vendor/", count: o.empty ? "0 / 40" : "86 / 120", fill: o.empty ? 0 : 86 / 120, full: false,
    items, more: null,
    emptyText: all.length === 0 ? "Nothing in vendor/ yet. Gear the autopilot keeps lands here." : "Nothing matches this filter.",
    filters: filters(f),
    card,
    hint: o.empty ? "Items you don't wear wait here, shared by every hero." : "Pick an item to see it, polish it, or hand it to the hero it suits best.",
    squash: o.empty
      ? { available: false, reason: "CI Forge level 3 unlocks Squash Merge", picked: [], label: "", action: action("squash", "Squash Merge", "squash", { uids: [] }, { enabled: false }) }
      : {
        available: true, reason: null, picked,
        label: picked.length === 0 ? "Pick 3 unlocked items of one rarity (Prototype, Alpha or Beta)." : `${picked.length} of 3 Alpha picked → 1 Beta item`,
        action: action("squash", "Squash Merge", "squash", { uids: picked }, { enabled: picked.length === 3, tone: "primary", cost: picked.length === 3 ? "3.9k gold" : null, tooltip: picked.length === 3 ? null : "Pick 3 items first" }),
      },
  };
}

// ---------------------------------------------------------------------------------------------
// Bug Tracker

const TIERS = [["triaged", "Triaged", 500], ["reproduced", "Reproduced", 5000], ["fixed", "Fixed", 50000]];
const PERK = { xp: "XP", gold: "gold", crit: "crit", hpPct: "max HP", itemFind: "item find", dmg: "damage", cdr: "cooldowns", dr: "DR", bossDmg: "boss damage" };
const KILLS = [62410, 18220, 9870, 1240, 0, 0, 0, 0, 0];
const CLEARED = ["Fixed Nov 18, 2026", "Fixed Nov 20, 2026", "Fixed Nov 23, 2026", null, null, null, null, null, null];

function perkText(z, tier) {
  const [k, v] = Object.entries(z.perk)[0];
  const sign = k === "cdr" ? "−" : "+";
  const pct = Math.round(v * 100);
  return tier > 0 ? `${sign}${pct * tier}% ${PERK[k]}${tier > 1 ? ` (×${tier})` : ""}` : `${sign}${pct}% ${PERK[k]} per tier`;
}

function tracker(selected = "merge_marshes") {
  const zones = ZONES.map((z, zi) => {
    const kills = KILLS[zi];
    const tier = TIERS.filter(([, , need]) => kills >= need).length;
    const locked = zi > 3;
    const nextNeed = TIERS[Math.min(2, tier)][2];
    return {
      key: z.id, name: locked ? "???" : z.name, num: String(zi + 1), locked, accent: z.palette.accent,
      kills: kills.toLocaleString("en-US"), tier, tierName: tier > 0 ? TIERS[tier - 1][1] : null,
      progress: tier >= 3 ? { frac: 1, text: `${kills.toLocaleString("en-US")} · Fixed` } : { frac: kills / nextNeed, text: `${kills.toLocaleString("en-US")} / ${nextNeed.toLocaleString("en-US")}` },
      perk: locked ? "" : perkText(z, tier),
      tiers: TIERS.map(([key, name, need]) => ({ key, name, need: need.toLocaleString("en-US"), reached: kills >= need })),
      mobs: MOBS.filter((m) => m.zone === zi).map((m, mi) => ({
        key: m.id, mobId: m.id, name: m.name, ticket: `#${4100 + zi * 37 + mi * 11}`,
        kills: Math.round(kills * [0.46, 0.33, 0.21][mi]).toLocaleString("en-US"), flavor: m.flavor, sprite: `mob/${m.id}.svg`, known: !locked && kills > 0,
      })),
      boss: { key: BOSSES[zi].id, name: BOSSES[zi].name, sprite: `boss/${BOSSES[zi].id}.svg`, cleared: CLEARED[zi], kills: CLEARED[zi] ? `${[14, 6, 2][zi]} kills` : "0 kills", known: !locked },
    };
  });
  return { zones, selected, totals: "91,740 bugs filed · 4 zones open · trophies +3% damage and max HP" };
}

// ---------------------------------------------------------------------------------------------
// Bosses

const ZONE_NAME = ZONES.map((z) => z.name);

function bosses(o = {}) {
  const rows = BOSSES.map((b, i) => {
    const row = {
      key: b.id, name: b.name, where: `${ZONE_NAME[b.zone]} · Lv ${b.level}`, sprite: `boss/${b.id}.svg`,
      state: "locked", stateText: "Locked", estimate: null, chips: [], firstClear: null, flavor: b.flavor, challenge: null,
    };
    if (i < 3) {
      Object.assign(row, { state: "fixed", stateText: "FIXED", firstClear: CLEARED[i].replace("Fixed", "First fixed"),
        estimate: { text: `Favored ${[4.8, 2.6, 1.31][i]}×`, color: C.working } });
      row.chips = [{ key: "kills", text: `${[14, 6, 2][i]} kills`, color: C.idle, tooltip: "Herd kills of this boss" },
        { key: "keepsake", text: ["Hazard Cone Hat", "Curly Brace Crown", "Lazy Quantifier Boots"][i], color: RAR[5], tooltip: "Its Keepsake (15% on repeat kills)" }];
      row.challenge = i === 2
        ? action(`challenge:${i}`, "Fight again", "challenge", { kind: "boss", idx: i }, { enabled: false, tooltip: "Everyone who can fight it fought it in the last 3 working hours (ready in 1h12m)" })
        : action(`challenge:${i}`, "Fight again", "challenge", { kind: "boss", idx: i }, { tooltip: "Repeat kill: loot, no Sprint meter needed" });
    } else if (i === 3) {
      if (o.fighting) {
        Object.assign(row, { state: "fighting", stateText: "Fighting", estimate: { text: "Even 1.04×", color: C.blocked } });
      } else {
        Object.assign(row, { state: "door", stateText: "Door open", estimate: { text: "Even 1.04×", color: C.blocked },
          challenge: action(`challenge:${i}`, "Challenge", "challenge", { kind: "boss", idx: i }, { tone: "primary", tooltip: "Kip, Rue and Fen are questing in Merge Marshes" }) });
      }
      row.chips = [
        { key: "wounds", text: "Wounds 31% · 41h", color: C.hp, tooltip: "It keeps 31% of its HP lost as Wounds for another 41 hours" },
        { key: "lessons", text: "Lessons +20%", color: C.working, tooltip: "Lessons Learned: +20% boss damage until it falls" },
      ];
    }
    return row;
  });
  return {
    fight: o.fighting ? {
      key: "octopus_merge", name: "The Octopus Merge", text: "Merging… 5 branches left · 41% HP · 64 ticks left · Kip, Rue, Fen",
      frac: 0.41, retreat: action("retreat", "Retreat", "retreat", {}, { tone: "danger", confirm: "Retreat? (a Postmortem)", tooltip: "End the fight as a Postmortem: Wounds and Lessons are kept" }),
    } : null,
    bosses: rows,
    backlog: { key: "backlog", title: "The Backlog", text: "Opens after The Heisenbug is fixed: endless floors, no leaderboards.", progress: { frac: 0, text: "—" }, locked: true, challenge: null },
    trophies: "Trophies: +3% damage and max HP for every hero (one per boss fixed)",
  };
}

// ---------------------------------------------------------------------------------------------
// Roster

const TINT = ["#6C8CF5", "#F07D5C", "#45C2A8", "#C47BE8", "#E8B84A", "#5FB0E8", "#E86F9C", "#8FBF5A", "#C08A3E"];
function rr(id, o) {
  const status = o.status ?? "working";
  return {
    key: `r:${id}`, heroId: id, name: o.name, level: `Lv ${o.level}`, title: o.title, status, stripe: STRIPE[status],
    where: o.where, seen: o.seen,
    portrait: { colors: { hoodie: TINT[(id - 1) % TINT.length], titleBar: "#3B2A24", screen: "#17161F", faceInk: STRIPE[status] }, face: FACE[status], programIcon: o.icon ?? ICON.claude },
    retire: o.retire ? action(`retire:${id}`, "Retire", "retire", { heroId: id }, { tone: "danger", confirm: `Retire ${o.name.split(" ")[0]}?`, tooltip: "Joins the Hall of Fame (+0.5% herd XP); gear goes to vendor/" }) : null,
  };
}

function roster() {
  return {
    count: "9 / 30 heroes · 1 hired today (6 a day)", slim: false,
    groups: [
      { key: "g:herdr-app", name: "herdr-app", rows: [
        rr(1, { name: "Kip the Idempotent", level: 34, title: "Senior Refactorer", where: "4-1 Fast-Forward Ford", seen: "working 12m" }),
        rr(2, { name: "Rue Two-Spaces", level: 31, title: "Junior Hotfixer", status: "blocked", where: "3-3 The Unparsed Gate", seen: "waiting 2m", icon: ICON.codex }),
        rr(5, { name: "Pip Tabs-Not-Spaces", level: 12, title: "Junior Shellmancer", status: "done", where: "2-1 Mouth of the Stack", seen: "shipped 4m ago" }),
      ] },
      { key: "g:billing-service", name: "billing-service", rows: [
        rr(14, { name: "Fen of Clean Diffs", level: 44, title: "Senior Hotfixer", where: "4-3 Octopus Delta", seen: "working 41m", icon: ICON.gemini }),
        rr(15, { name: "Mira the Deterministic", level: 40, title: "Senior Shellmancer", status: "idle", where: "4-2 Stash Bog", seen: "resting 25m", icon: ICON.codex }),
      ] },
      { key: "g:off", name: "Off duty", rows: [
        rr(7, { name: "Juno of the Green Build", level: 47, title: "Senior Rubberducker", status: "off", where: "off duty", seen: "seen Nov 21", retire: true }),
        rr(18, { name: "Ode to Tabs", level: 18, title: "Junior Forkbinder", status: "off", where: "off duty", seen: "seen 5d ago" }),
        rr(21, { name: "Nib the Linted", level: 3, title: "Intern", status: "off", where: "off duty", seen: "seen 2d ago" }),
        rr(22, { name: "Bram Two-Phase", level: 9, title: "Intern", status: "off", where: "off duty", seen: "seen 6d ago", icon: ICON.codex }),
      ] },
    ],
    fame: {
      title: "Hall of Fame", bonus: "Legacy +1.0% herd XP",
      rows: [
        { key: "f:1", name: "Lin the Patient", cls: "Staff Refactorer", level: "Lv 64", date: "Oct 30, 2026" },
        { key: "f:2", name: "Oskar Off-By-One", cls: "Senior Hotfixer", level: "Lv 38", date: "Nov 12, 2026" },
      ],
      more: null,
      emptyText: "Heroes retired at Lv 30+ rest here and add +0.5% herd XP each.",
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Digest

function digest(empty = false) {
  const line = (key, text, sub, color, act = null, tint = false) => ({ key, text, sub, color, tint, action: act });
  return {
    since: empty ? "Since you last looked · 6m ago" : "Since you last looked · 2h 14m ago",
    sections: empty ? [] : [
      { key: "levels", title: "Levels", icon: "ui/star.svg", lines: [
        line("lv:1", "Kip the Idempotent reached Lv 34", "Lv 32 → 34", C.xp),
        line("lv:14", "Fen of Clean Diffs reached Lv 44", "Lv 43 → 44", C.xp),
        line("lv:5", "Pip Tabs-Not-Spaces is now a Junior Shellmancer", "Lv 10 → 12", C.xp),
      ] },
      { key: "drops", title: "Release or better", icon: "ui/slot-weapon.svg", lines: [
        line("d:921", "Vectorized Extract Saber of Graceful Degradation", "Kip · Release", RAR[3], null, true),
        line("d:950", "Bottomless Travel Thermos", "Mira · LTS", RAR[4], null, true),
        line("d:940", "Recursive Monkey-Patch Knife of Graceful Degradation", "Fen · Release", RAR[3], null, true),
      ] },
      { key: "bosses", title: "Bosses", icon: "ui/boss.svg", lines: [
        line("b:2", "The Catastrophic Backtracker: FIXED", "Kip, Rue, Mira · 118 ticks", C.working),
        line("b:3", "Postmortem: The Octopus Merge held at 31%", "Wounds 48 h · Lessons +20%", C.idle),
      ] },
      { key: "chests", title: "Chests waiting", icon: "ui/chest.svg", lines: [
        line("c:5", "Pip Tabs-Not-Spaces: Iron chest · 1.8 Seals", "“Add a dark theme toggle”", C.done,
          action("claim:5", "Open", "claimChest", { heroId: 5 }, { tooltip: "Open it (counts as seen)" })),
        line("c:7", "Juno of the Green Build: Silver chest · 3.4 Seals", "off duty · opens Unreviewed in 9h", C.done,
          action("claim:7", "Open", "claimChest", { heroId: 7 }, { tooltip: "Open it now with full value" })),
      ] },
    ],
    emptyText: "Nothing new since you last looked.",
    ack: empty ? null : action("digest:ack", "Mark as read", "digestSeen", {}, { tooltip: "Clears the dot on the Herd button" }),
  };
}

// ---------------------------------------------------------------------------------------------
// Settings

function settings(cfg = {}) {
  const tog = (key, label, hint, setting, value) => ({ key, label, hint, kind: "toggle", value, options: null, setting, chrome: null });
  const auto = cfg.auto ?? {};
  const on = (k) => auto[k] ?? true;
  return {
    groups: [
      { key: "display", title: "Display", hint: null, rows: [
        tog("calm", "Calm mode", "No damage numbers, banners or blinking; the stage dims", "calm", !!cfg.calm),
        { key: "nums", label: "Damage numbers", hint: null, kind: "choice", value: cfg.nums ?? "all", options: [{ id: "all", label: "All" }, { id: "crits", label: "Crits" }, { id: "off", label: "Off" }], setting: "nums", chrome: null },
        { key: "stageH", label: "Stage height", hint: "At 64 px: nameplates, chests, bubbles and HP lines only", kind: "choice", value: cfg.stageH ?? 200,
          options: [{ id: 64, label: "64" }, { id: 120, label: "120" }, { id: 200, label: "200" }], setting: "stageH", chrome: { resize: "stage" } },
        { key: "hud", label: "HUD strip", hint: "A thin strip under the stage: gold, Sprint, who's working", kind: "toggle", value: null, options: null, setting: null, chrome: { toggle: "hud" } },
      ] },
      { key: "notify", title: "Notifications", hint: "Off by default; at most 3 a day; never a sound.", rows: [
        tog("notify.boss", "Herd-first boss kill", null, "notify.boss", !!cfg.notifyBoss),
        tog("notify.lts", "LTS or Keepsake drop", null, "notify.lts", false),
        tog("notify.principal", "A hero reaches Principal", null, "notify.principal", false),
      ] },
      { key: "autopilot", title: "Autopilot", hint: null, rows: [
        tog("auto.equip", "Auto-equip", "Equips upgrades that score +2% or better", "auto.equip", on("equip")),
        tog("auto.deprecate", "Auto-deprecate", "Salvages Prototype and Alpha drops nobody can use", "auto.deprecate", on("deprecate")),
        tog("auto.learn", "Auto-learn", "Spends skill points (each hero can opt out)", "auto.learn", on("learn")),
        tog("auto.polish", "Auto-polish", "One item a minute, keeping a 20% gold reserve", "auto.polish", on("polish")),
        tog("auto.buildings", "Buildings", "Buys the cheapest upgrade at 3× its cost", "auto.buildings", on("buildings")),
        tog("auto.maps", "Map choice", "Moves heroes to the deepest map they outfight", "auto.maps", on("maps")),
        tog("auto.boss", "Auto-boss", "Challenges when the win estimate is 100% or more", "auto.boss", on("boss")),
        tog("auto.farm", "Farm bosses", "Fights beaten bosses again at 150% or more", "auto.farm", on("farm")),
        tog("auto.calls", "Answer calls", "Heroes who beat a boss help others fight it", "auto.calls", on("calls")),
        tog("auto.career", "Career", "Takes the recommended class at Lv 10", "auto.career", on("career")),
      ] },
    ],
    herd: { name: cfg.name ?? "The Herd", hint: "Shown here and in the sidebar. Renaming is free." },
  };
}

// ---------------------------------------------------------------------------------------------

const MID_LEVELS = [4, 3, 5, 8, 4, 2];

function midVm(tab, f = {}) {
  const vm = base(tab);
  if (tab === "upgrades") vm.upgrades = upgrades(MID_LEVELS, 212000);
  if (tab === "stash") vm.stash = herdStash(f);
  if (tab === "tracker") vm.tracker = tracker();
  if (tab === "bosses") vm.bosses = bosses();
  if (tab === "roster") vm.roster = roster();
  if (tab === "digest") vm.digest = digest();
  if (tab === "settings") vm.settings = settings();
  return vm;
}

const lateHeader = { name: "Night Shift", release: "v5.8", releaseTip: "Release Train: 1,951 Seals · v5.9 at 1,967 · +29% XP and gold", gold: "48.6M", snippets: "21.4k", sub: "22 heroes · 11 working · 3 waiting for you",
  sprint: { label: "The Heisenbug", have: 214, need: 300, text: "Sprint 214 / 300" } };

export const scenarios = {
  /** host.view returned null: the world is still loading. */
  loading: null,
  /** Mid-game Localhost: some upgrades affordable, others not. */
  upgrades: midVm("upgrades"),
  /** Late game: big numbers, War Room maxed, autopilot buildings off, calm mode. */
  upgradesLate: { ...base("upgrades", { header: lateHeader, digestBadge: null, calm: true }), upgrades: upgrades([10, 9, 10, 10, 8, 5], 48.6e6, false, 8) },
  /** vendor/ with a Release weapon selected (best on Kip). */
  stash: midVm("stash", { focus: 921 }),
  /** vendor/ filtered to hats, a Keepsake selected. */
  stashKeepsake: midVm("stash", { focus: 951, slot: "hat" }),
  /** A fresh herd: nothing in vendor/, no Squash Merge yet. */
  stashEmpty: { ...base("stash", { header: { name: "The Herd", release: "v0.1", releaseTip: "Release Train: 9 Seals credited · v0.2 at 20 · +0.5% XP and gold", gold: "312", snippets: "4", sub: "1 hero · 1 working", sprint: { label: "The Ignored Warning", have: 1, need: 6, text: "Sprint 1 / 6" } }, digestBadge: null }), stash: herdStash({}, { empty: true }) },
  /** Bug Tracker: four zones open, Lint Meadows Fixed, the frontier selected. */
  tracker: midVm("tracker"),
  /** Bosses: three fixed, the frontier door open with Wounds and Lessons. */
  bosses: midVm("bosses"),
  /** A boss fight in progress (Retreat). */
  bossFight: { ...base("bosses"), bosses: bosses({ fighting: true }) },
  /** Roster: two guilds, off duty, Hall of Fame. */
  roster: midVm("roster"),
  /** Since you last looked. */
  digest: midVm("digest"),
  /** Nothing new. */
  digestEmpty: { ...base("digest", { digestBadge: null }), digest: digest(true) },
  /** Settings (herd.cfg). */
  settings: midVm("settings"),
  /** A save from a newer version, opened read-only (D§13.4): the band under the header. */
  saveReadOnly: { ...midVm("roster"), save: {
    title: "Save is read-only",
    text: "This save is from a newer version of Down the Stack, so it was opened read-only: nothing is saved until that version runs again.",
    tooltip: "Save is from a newer version (v2); opened read-only",
  } },
  /** save.json was damaged and the herd came back from save.bak (D§13.1). */
  saveRestored: { ...midVm("upgrades"), save: {
    title: "Save restored from backup",
    text: "The save file was damaged, so the herd was restored from its backup (save.bak). The damaged file was kept as save.broken.",
    tooltip: null,
  } },
};

/** The role's UI state each scenario is meant to be seen with. */
export const uiStates = {
  stash: { selected: 921 },
  stashKeepsake: { selected: 951, filter: { slot: "hat", minRar: 0, usable: false, sort: "score", squash: [] } },
  tracker: { zone: null },
};

/** Dialog width each scenario is seen at. */
export const widths = Object.fromEntries(Object.keys(scenarios).map((k) => [k, 760]));

/** The VM a fake host returns for {tab, filter} (tests and previews switch tabs with it). */
export function viewFor(name, args = {}) {
  const vm = scenarios[name];
  if (!vm) return vm;
  const tab = args.tab ?? vm.tab;
  if (tab === vm.tab && tab !== "stash") return vm;
  if (name === "stashEmpty" && tab === "stash") return { ...vm, stash: herdStash(args.filter ?? {}, { empty: true }) };
  const out = midVm(tab, args.filter ?? {});
  return { ...out, header: vm.header, calm: vm.calm, save: vm.save ?? null };
}

/** The same VM one tick later (gold moved, a bar grew): ids must stay stable. */
export function nextTick(vm) {
  if (!vm) return vm;
  const out = JSON.parse(JSON.stringify(vm));
  out.header.gold = out.header.gold.replace(/^\d+/, (m) => String(Number(m) + 1));
  if (out.bosses?.fight) out.bosses.fight.frac = Math.max(0, out.bosses.fight.frac - 0.02);
  if (out.tracker) for (const z of out.tracker.zones) if (!z.locked) z.progress.frac = Math.min(1, z.progress.frac + 0.001);
  return out;
}

// Previews of real demo worlds through game/view.js herdView and the role (see sheet.mjs):
//   node --import ./tools/mock/register.mjs tools/vm-samples/herd.mjs --views [--all] [--only kind] [--tab stash]
if (typeof process !== "undefined" && process.argv[1] && /vm-samples[\\/]herd\.mjs$/.test(process.argv[1]) && process.argv.includes("--views")) {
  import("./sheet.mjs").then((m) => m.shootDialogViews("herd", process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
}
