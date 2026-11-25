// Sample SheetVMs (game/view.js sheetView) for the character sheet dialog (mods/down-the-stack/ui/sheet.js).
// They are the spec view.js has to produce and the fixtures for tests and previews: every visual
// state the renderer supports has a scenario. Shapes: the typedefs at the top of ui/sheet.js
// (SheetVM, SheetHeaderVM, GearVM, ItemVM, CardVM, ActionVM, ChipVM, SquashVM, StashVM,
// SkillsVM, SkillVM, StatsVM, CareerVM, ReviewVM, JournalVM). Every string is display-ready.
//
// `uiStates[name]` is the role's UI state a scenario is meant to be seen with (selection, squash
// picking); `widths` the dialog width; `nextTick(vm)` the same VM a tick later (ids stay stable).

import { AFFIXES } from "../../mods/down-the-stack/game/data.js";

export const RAR = ["#A0A4AB", "#5BD16A", "#4EA3FF", "#B36BFF", "#FF9A2E", "#FF7AA8"];
export const RAR_NAME = ["Prototype", "Alpha", "Beta", "Release", "LTS", "Keepsake"];
const C = { working: "#4CC38A", blocked: "#F2A93B", done: "#FFD447", idle: "#8A8F98", hp: "#FF5A5F", xp: "#7FE9F5", fresh: "#A9B8FF" };
const CLS = { intern: "#A0A4AB", refactorer: "#6C8CF5", hotfixer: "#F07D5C", shellmancer: "#45C2A8", forkbinder: "#C47BE8", rubberducker: "#C08A3E" };
const ICON = {
  claude: { path: "icons/claude.svg", tint: false, color: "#ffffff" },
  codex: { path: "icons/codex.svg", tint: false, color: "#ffffff" },
  gemini: { path: "icons/gemini.svg", tint: true, color: "#ffffff" },
};
const SLOTS = ["weapon", "hat", "hoodie", "mug", "boots", "sticker"];
const SLOT_LABEL = { weapon: "Weapon", hat: "Hat", hoodie: "Hoodie", mug: "Mug", boots: "Boots", sticker: "Sticker" };

// ---------------------------------------------------------------------------------------------
// builders

/** An ActionVM. */
export function action(key, label, cmd, args, o = {}) {
  return { key, label, cmd, args, enabled: o.enabled ?? true, cost: o.cost ?? null, tooltip: o.tooltip ?? null, tone: o.tone ?? null, confirm: o.confirm ?? null };
}

/** An ItemVM. icon defaults to the slot mask (weapons: the class weapon mask). */
export function item(uid, o) {
  const icon = o.icon ?? (o.slot === "weapon" ? `gear/weapon-${o.cls ?? "intern"}.svg` : `ui/slot-${o.slot}.svg`);
  const delta = o.delta === undefined ? null : o.delta;
  return {
    key: `it:${uid}`, uid, name: o.name, rar: o.rar, rarColor: RAR[o.rar], rarName: RAR_NAME[o.rar], icon,
    ilvl: `iLvl ${o.ilvl}`, ip: o.ip, pol: o.pol ? `+${o.pol}` : null, locked: !!o.locked, isNew: !!o.isNew,
    usable: o.usable ?? true, delta, squashable: o.squashable ?? (o.rar <= 2 && !o.locked),
    tooltip: o.tooltip ?? `${RAR_NAME[o.rar]} ${SLOT_LABEL[o.slot].toLowerCase()} · iLvl ${o.ilvl} · IP ${o.ip}${delta ? ` · score ${delta.text}` : ""}`,
  };
}

/** A CardVM from an ItemVM. */
export function cardOf(it, o) {
  return {
    ...it,
    sub: o.sub, stat: o.stat ?? null, affixes: o.affixes ?? [], prop: o.prop ?? null, polish: o.polish,
    vs: o.vs ?? null, deltas: o.deltas ?? [], score: o.score ?? null, owner: o.owner ?? null, flavor: o.flavor ?? null,
    actions: o.actions ?? [],
  };
}

const good = (text) => ({ text, good: true });
const bad = (text) => ({ text, good: false });

/** The stash filter chips, echoing a filter. */
export function filters(f = {}) {
  const slot = f.slot ?? "all", minRar = f.minRar ?? 0, usable = !!f.usable, sort = f.sort ?? "score";
  return {
    slot: [{ key: "slot-all", label: "All", icon: null, color: null, on: slot === "all", set: { slot: "all" }, tooltip: "Every slot" }]
      .concat(SLOTS.map((s) => ({ key: `slot-${s}`, label: SLOT_LABEL[s], icon: `ui/slot-${s}.svg`, color: null, on: slot === s, set: { slot: s }, tooltip: SLOT_LABEL[s] }))),
    rarity: RAR.map((c, i) => ({ key: `rar-${i}`, label: RAR_NAME[i], icon: null, color: c, on: minRar === i, set: { minRar: i }, tooltip: i === 0 ? "Any rarity" : `${RAR_NAME[i]} or better` })),
    toggles: [{ key: "usable", label: "Usable", icon: null, color: null, on: usable, set: { usable: !usable }, tooltip: usable ? "Showing what this hero can wear" : "Only what this hero can wear" }],
    sort: [["score", "Score", "Best upgrade first"], ["ip", "IP", "Highest Item Power first"], ["new", "New", "Newest first"]]
      .map(([id, label, tip]) => ({ key: `sort-${id}`, label, icon: null, color: null, on: sort === id, set: { sort: id }, tooltip: `Sort: ${tip}` })),
  };
}

// tip: what a badge counts, for the tab's tooltip ("Skills · 1 skill point to spend · key 2")
const BADGE_TIP = { skills: (b) => `${b} skill ${b === "1" ? "point" : "points"} to spend`, career: () => "a promotion review is ready" };
function tabs(badges = {}) {
  return [["gear", "Gear"], ["skills", "Skills"], ["stats", "Stats"], ["career", "Career"], ["journal", "Journal"]]
    .map(([id, label]) => ({ id, label, badge: badges[id] ?? null, tip: badges[id] && BADGE_TIP[id] ? BADGE_TIP[id](badges[id]) : null }));
}

function slotsOf(items, heroId) {
  return SLOTS.map((s) => ({ key: `slot:${heroId}:${s}`, slot: s, label: SLOT_LABEL[s], icon: `ui/slot-${s}.svg`, item: items[s] ?? null }));
}

const base = (heroId, tab, header, o = {}) => ({
  heroId, tab, tabs: tabs(o.badges), calm: !!o.calm, header, note: o.note ?? null,
  gear: null, skills: null, stats: null, career: null, journal: null,
});

// ---------------------------------------------------------------------------------------------
// Kip the Idempotent: Lv 34 Senior Refactorer, mid-game (zone 4), full gear, CI Forge 5

const KIP = 1;
const kipHeader = {
  name: "Kip the Idempotent", level: "Lv 34", title: "Senior Refactorer", tag: null, tagTip: null, tagTab: null,
  sub: "herdr-app · Claude Code · fighting 4-1 Fast-Forward Ford", quest: "Fix flaky auth test",
  status: "working",
  hp: { frac: 0.82, text: "1,402 / 1,710" },
  xp: { frac: 0.412, feFrac: 0.08, text: "41.2%", tooltip: "+3,412 XP/min = working ×1 · Fresh Eyes ×1.5 · Party +12% · Herd +23% · Shift: 1h48m today (full rate until 4h)" },
  shift: { frac: 0.45, text: "1h48m", tooltip: "Daily Shift: 1h48m worked today. Full rewards until 4h, then half until 8h. Resets at 04:00." },
  fe: "Fresh Eyes 38m",
  power: { text: "PL 36", tooltip: "Power Level 36 = Lv 34 + gear 2: fights like a Lv 36" },
  buffs: [
    { key: "code_review", text: "Code Review 6s", color: "#7FE9F5", tooltip: "Code Review: +10% damage; room allies take −7.5% damage (6 ticks left)" },
    { key: "unblocked", text: "Unblocked", color: C.working, tooltip: "Unblocked: +15% damage and kill XP (84 Questing ticks left)" },
  ],
  rig: {
    colors: { hoodie: "#6C8CF5", titleBar: "#3B2A24", screen: "#17161F", faceInk: C.working },
    face: ">_", weapon: { clsId: "refactorer", color: "#9AA3AD" }, hat: { tier: 2, color: "#4EA3FF" },
    accessory: "refactorer", programIcon: ICON.claude,
  },
  focus: { pane: "p1", address: "t1" },
};

const kipEq = {
  weapon: item(801, { slot: "weapon", cls: "refactorer", name: "Memoized Extract Saber +5", rar: 2, ilvl: 35, ip: "619", pol: 5, locked: true, squashable: false }),
  hat: item(802, { slot: "hat", name: "Headphones of the Green Build +3", rar: 2, ilvl: 33, ip: "537", pol: 3, squashable: false }),
  hoodie: item(803, { slot: "hoodie", name: "Typed Zip Hoodie of Uptime +4", rar: 3, ilvl: 36, ip: "728", pol: 4, squashable: false }),
  mug: item(804, { slot: "mug", name: "Chipped Mug of Caching +2", rar: 1, ilvl: 31, ip: "405", pol: 2, squashable: false }),
  boots: item(805, { slot: "boots", name: "Lazy Quantifier Boots +2", rar: 5, ilvl: 34, ip: "839", pol: 2, locked: true, squashable: false }),
  sticker: item(806, { slot: "sticker", name: "Rubber-Stamped Holo Sticker", rar: 4, ilvl: 32, ip: "642", squashable: false }),
};

function kipStash(f) {
  const all = [
    item(921, { slot: "weapon", cls: "refactorer", name: "Vectorized Extract Saber of Graceful Degradation", rar: 3, ilvl: 36, ip: "741", delta: good("+4.1%"), isNew: true }),
    item(915, { slot: "hoodie", name: "Robust Fleece Vest", rar: 2, ilvl: 41, ip: "580", delta: good("+1.6%"), usable: false, tooltip: "Beta hoodie · iLvl 41 · req Lv 38 · IP 580" }),
    item(931, { slot: "hat", name: "Linted Headphones", rar: 2, ilvl: 34, ip: "498", delta: bad("−0.8%") }),
    item(907, { slot: "mug", name: "Chipped Mug of Hot Reload", rar: 1, ilvl: 33, ip: "399", delta: bad("−1.1%") }),
    item(905, { slot: "boots", name: "Async Office Slippers", rar: 1, ilvl: 32, ip: "380", delta: bad("−6.4%") }),
    item(912, { slot: "sticker", name: "Optimized Holo Sticker", rar: 1, ilvl: 30, ip: "356", delta: bad("−9.0%") }),
    item(940, { slot: "weapon", cls: "hotfixer", name: "Recursive Monkey-Patch Knife of Graceful Degradation", rar: 3, ilvl: 35, ip: "702", usable: false, tooltip: "Release weapon (Patch Knives) · iLvl 35 · a Hotfixer's" }),
    item(941, { slot: "weapon", cls: "shellmancer", name: "Memoized Here-Doc Staff", rar: 2, ilvl: 34, ip: "546", usable: false, tooltip: "Beta weapon (Pipes) · iLvl 34 · a Shellmancer's" }),
    item(942, { slot: "weapon", cls: "rubberducker", name: "Memoized Bathtub Duck", rar: 1, ilvl: 33, ip: "421", usable: false, tooltip: "Alpha weapon (Ducks) · iLvl 33 · a Rubberducker's" }),
    item(908, { slot: "hoodie", name: "Zip Hoodie of Idempotence", rar: 1, ilvl: 31, ip: "394", delta: bad("−7.7%") }),
    item(909, { slot: "hat", name: "Headphones", rar: 0, ilvl: 33, ip: "330", delta: bad("−4.2%") }),
    item(910, { slot: "boots", name: "Office Slippers", rar: 0, ilvl: 34, ip: "340", delta: bad("−5.9%") }),
    item(911, { slot: "mug", name: "Chipped Mug", rar: 0, ilvl: 32, ip: "320", delta: bad("−2.3%") }),
    item(913, { slot: "boots", name: "Typed Office Slippers", rar: 1, ilvl: 35, ip: "415", delta: bad("−5.2%") }),
    item(914, { slot: "sticker", name: "Holo Sticker of Tab Completion", rar: 1, ilvl: 22, ip: "261", delta: bad("−11.4%") }),
    item(916, { slot: "hat", name: "Thinking Cap", rar: 0, ilvl: 41, ip: "410", usable: false, delta: null, tooltip: "Prototype hat · iLvl 41 · req Lv 38" }),
    item(917, { slot: "mug", name: "Chipped Mug of Uptime", rar: 1, ilvl: 29, ip: "355", delta: bad("−3.0%"), locked: true, squashable: false }),
    item(918, { slot: "hoodie", name: "Swag Tee", rar: 0, ilvl: 18, ip: "180", delta: bad("−12.8%") }),
  ];
  return stash(all, f, { count: "86 / 120", fill: 86 / 120 });
}

/** Filter + sort a list the way view.js would (only used to keep the samples consistent). */
function stash(all, f = {}, o = {}) {
  const slotOf = (it) => (it.icon.startsWith("gear/weapon") ? "weapon" : it.icon.replace(/^ui\/slot-|\.svg$/g, ""));
  let items = all.filter((it) => (!f.slot || f.slot === "all" || slotOf(it) === f.slot) && it.rar >= (f.minRar ?? 0) && (!f.usable || it.usable));
  if ((f.sort ?? "score") === "ip") items = items.slice().sort((a, b) => Number(b.ip.replace(/,/g, "")) - Number(a.ip.replace(/,/g, "")));
  return {
    title: "vendor/", count: o.count ?? `${all.length} / 40`, fill: o.fill ?? all.length / 40, full: !!o.full,
    items, more: o.more ?? null,
    emptyText: all.length === 0 ? "Nothing in vendor/ yet. Gear the autopilot keeps lands here." : "Nothing matches this filter.",
    filters: filters(f),
  };
}

function kipCard(focus) {
  if (focus === 921) {
    const it = kipStash().items.find((x) => x.uid === 921);
    return cardOf(it, {
      sub: "Release weapon · iLvl 36 · req Lv 33", stat: "Weapon damage 87",
      affixes: [
        { key: "921:0", text: "+10.4% area damage", reroll: action("reroll:921:0", "Reroll", "reroll", { uid: 921, affix: 0 }, { cost: "10.5k gold · 20 Snippets", tooltip: "Rerolls the affix's type and value" }) },
        { key: "921:1", text: "+6.6% damage", reroll: action("reroll:921:1", "Reroll", "reroll", { uid: 921, affix: 1 }, { cost: "10.5k gold · 20 Snippets", tooltip: "Rerolls the affix's type and value" }) },
        { key: "921:2", text: "+12.8% damage while below 50% HP", reroll: action("reroll:921:2", "Reroll", "reroll", { uid: 921, affix: 2 }, { cost: "10.5k gold · 20 Snippets", tooltip: "Rerolls the affix's type and value" }) },
      ],
      polish: "Polish +0 of +9",
      vs: "vs Memoized Extract Saber +5 (equipped)",
      deltas: [
        { key: "wd", label: "Weapon damage", text: "+9.1", good: true },
        { key: "dmg", label: "Damage", text: "−1.4%", good: false },
        { key: "area", label: "Area damage", text: "+10.4%", good: true },
        { key: "low", label: "Below 50% HP", text: "+12.8%", good: true },
        { key: "ip", label: "Item Power", text: "+122", good: true },
      ],
      score: good("+4.1%"),
      actions: [
        action("equip:921", "Equip", "equip", { heroId: KIP, uid: 921 }, { tone: "primary", tooltip: "Your +5 polish ports +2 to it, free" }),
        action("lock:921", "Lock", "lock", { uid: 921, locked: true }, { tooltip: "Locked items are never replaced or deprecated" }),
        action("polish:921", "Polish", "polish", { uid: 921 }, { cost: "982 gold · 2 Snippets", tooltip: "+5% weapon damage (to +1)" }),
        action("deprecate:921", "Deprecate", "deprecate", { uid: 921 }, { cost: "+40 Snippets", tone: "danger", confirm: "Deprecate it?", tooltip: "Salvage for 40 Snippets and 418 gold" }),
      ],
    });
  }
  if (focus === 803) {
    return cardOf(kipEq.hoodie, {
      sub: "Release hoodie · iLvl 36 · req Lv 33", stat: "Armor 164",
      affixes: [
        { key: "803:0", text: "+13.2% armor", reroll: action("reroll:803:0", "Reroll", "reroll", { uid: 803, affix: 0 }, { cost: "10.5k gold · 20 Snippets" }) },
        { key: "803:1", text: "+0.17% max HP regen per tick", reroll: action("reroll:803:1", "Reroll", "reroll", { uid: 803, affix: 1 }, { cost: "10.5k gold · 20 Snippets" }) },
        { key: "803:2", text: "−3.1% damage taken", reroll: action("reroll:803:2", "Reroll", "reroll", { uid: 803, affix: 2 }, { cost: "10.5k gold · 20 Snippets" }) },
      ],
      polish: "Polish +4 of +9", owner: "Worn by Kip the Idempotent",
      actions: [
        action("lock:803", "Lock", "lock", { uid: 803, locked: true }),
        action("polish:803", "Polish", "polish", { uid: 803 }, { cost: "13.4k gold · 10 Snippets", tooltip: "+5% armor (to +5)" }),
      ],
    });
  }
  return null;
}

function kipGear(f = {}) {
  return {
    slots: slotsOf(kipEq, KIP),
    card: kipCard(f.focus ?? null),
    hint: "Pick an item to compare it with what Kip wears.",
    summary: [
      { key: "ip", label: "Item Power", value: "3,770", tooltip: "Sum of the six equipped items' Item Power" },
      { key: "pl", label: "Power Level", value: "36", tooltip: "Power Level 36 = Lv 34 + gear 2" },
      { key: "dps", label: "DPS (est.)", value: "1,104", tooltip: "Mean single-target damage per tick from a 60-tick dry run" },
      { key: "ehp", label: "EHP", value: "9,612", tooltip: "EHP = Max HP / (1 − DR) / (1 − dodge) against an on-level mob" },
    ],
    stash: kipStash(f),
    squash: squashOf(f.squash ?? [], { 905: "Alpha", 907: "Alpha", 908: "Alpha", 913: "Alpha" }),
  };
}

function squashOf(picked, rarOf) {
  const n = picked.length;
  const r = n ? rarOf[picked[0]] ?? "Alpha" : null;
  return {
    available: true, reason: null, picked: picked.slice(),
    label: n === 0 ? "Pick 3 unlocked items of one rarity (Prototype, Alpha or Beta)." : `${n} of 3 ${r} picked → 1 ${r === "Alpha" ? "Beta" : r === "Beta" ? "Release" : "Alpha"} item`,
    action: action("squash", "Squash Merge", "squash", { uids: picked.slice() }, { enabled: n === 3, cost: n === 3 ? "4.1k gold" : null, tone: "primary", tooltip: n === 3 ? "3 items become 1 random item of the next rarity at their average item level" : "Pick 3 items first" }),
  };
}

function kipSkills() {
  const learn = (slot, o = {}) => action(`learn:${KIP}:${slot}`, "+1", "learn", { heroId: KIP, slot }, { tooltip: o.tooltip ?? "Spend 1 skill point", enabled: o.enabled ?? true });
  const sk = (slot, o) => ({
    key: `sk:${slot}`, slot, slotLabel: o.slotLabel, name: o.name, glyph: o.glyph, rank: o.rank, max: o.max, rankText: `${o.rank}/${o.max}`,
    locked: !!o.locked, lockText: o.lockText ?? null, effect: o.effect, next: o.next ?? null, cd: o.cd ?? null,
    learn: o.learn === undefined ? null : o.learn, tooltip: o.tooltip,
  });
  return {
    sp: { count: 1, text: "skill point to spend", tooltip: "1 point per level from Lv 2, +1 per review won. Auto-learn spends it within a minute." },
    autoLearn: { on: true, action: action("autolearn", "Auto-learn", "autoLearn", { heroId: KIP, on: false }), hint: "Spends points on the lowest-ranked skill" },
    respec: action("respec", "Respec", "respec", { heroId: KIP }, { cost: "170 Snippets", confirm: "Respec for 170 Snippets?", tooltip: "Refunds every skill point" }),
    rules: "Free once a day while resting; otherwise 5 × level Snippets.",
    ladder: [
      { key: "intern", title: "Intern", levels: "1–9", state: "done" },
      { key: "junior", title: "Junior", levels: "10–29", state: "done" },
      { key: "senior", title: "Senior", levels: "30–59", state: "current" },
      { key: "staff", title: "Staff", levels: "60–89", state: "locked" },
      { key: "principal", title: "Principal", levels: "90–100", state: "locked" },
    ],
    skills: [
      sk("main", { slotLabel: "Main · Lv 1", name: "Extract Method", glyph: "ƒ()", rank: 9, max: 20, effect: "Hit for 124% of a normal hit", next: "Next rank: 127%", learn: learn("main"), tooltip: "White crescent slash" }),
      sk("area", { slotLabel: "Area · Lv 5", name: "Rename Symbol", glyph: "foo", rank: 7, max: 15, effect: "Up to 3 lane mobs for 88% each", next: "Next rank: 91% each", cd: "CD 4 ticks", learn: learn("area"), tooltip: "Blade whirl; letters foo turn into bar and scatter" }),
      sk("passive", { slotLabel: "Passive · Lv 10", name: "Strong Typing", glyph: ":T", rank: 6, max: 15, effect: "+12% max HP and +6% damage reduction", next: "Next rank: +14% max HP, +7% DR", learn: learn("passive"), tooltip: "Faint :T glyphs on the body" }),
      sk("buff", { slotLabel: "Buff · Lv 20", name: "Code Review", glyph: "LG", rank: 6, max: 15, effect: "10 ticks: +10% damage; room allies take −7.5% damage", next: "Next rank: −8% damage taken", cd: "CD 30 ticks", learn: learn("buff"), tooltip: "Magnifying-glass halo" }),
      sk("sig", { slotLabel: "Signature · Lv 30", name: "Big Picture", glyph: "▦", rank: 5, max: 15, effect: "Every 6th action: slam for 232%, half of it to the lane", next: "Next rank: 240% (needs Lv 35)", cd: "every 6th action", learn: learn("sig", { enabled: false, tooltip: "Rank 6 needs Lv 35" }), tooltip: "Blueprint grid flashes across the slot floor" }),
      sk("ult", { slotLabel: "Ultimate · Lv 60", name: "The Big Rewrite", glyph: "rw", rank: 0, max: 15, locked: true, lockText: "Lv 60 and the Staff Review", effect: "500% to every lane mob", cd: "CD 45 ticks", tooltip: "Scaffolding rises for 2 ticks, then a white wipe" }),
      sk("cap", { slotLabel: "Capstone · Lv 90", name: "Clean Architecture", glyph: "{}", rank: 0, max: 10, locked: true, lockText: "Lv 90", effect: "+2% damage and +1% DR per rank", tooltip: "Silver trim on the scarf" }),
    ],
    note: null,
  };
}

function kipStats() {
  const row = (key, label, value, tooltip, sub = null, color = null) => ({ key, label, value, sub, tooltip, color });
  return {
    groups: [
      { key: "primary", title: "Primary", rows: [
        row("might", "MIGHT", "82", "4 + 2.2 × (Lv − 1) + gear: +1% damage each", "+5"),
        row("grit", "GRIT", "85", "4 + 2.3 × (Lv − 1) + gear: +1% max HP each", "+5"),
        row("keen", "KEEN", "21", "4 + 0.5 × (Lv − 1) + gear: +0.15% crit each", "+1"),
        row("luck", "LUCK", "4", "4 + 0 × (Lv − 1) + gear: +0.4% item find, +0.5% gold each"),
        row("pl", "Power Level", "36", "PL = Lv + clamp(round(ln(DPS_est / refDPS) / ln 1.07), −5, +8)", "+2"),
      ] },
      { key: "offense", title: "Offense", rows: [
        row("wd", "Weapon damage", "78", "6 · g(iLvl) · rarity · (1 + 0.05 · polish)"),
        row("hit", "Main hit", "186", "Weapon damage × (1 + MIGHT/100) × skill × (1 + damage %)"),
        row("dmg", "Damage bonus", "+36%", "Affixes, buffs, trophies (+3%), Unblocked", null, C.working),
        row("crit", "Crit chance", "8.2%", "0.05 + 0.0015 × KEEN + gear, cap 50%"),
        row("critx", "Crit damage", "×1.50", "1.5 + crit-damage affixes"),
        row("cdr", "Cooldowns", "−4%", "Hot Reload affixes and Keepsakes, cap 40%"),
        row("dps", "DPS (est.)", "1,104", "Mean damage per tick from a 60-tick dry run of the rotation"),
      ] },
      { key: "defense", title: "Defense", rows: [
        row("hp", "Max HP", "1,710", "60 · g(Lv) · (1 + GRIT/100) · (1 + HP %), Clean Hands +10%"),
        row("armor", "Armor", "412", "Σ armor pieces × (1 + armor %)"),
        row("dr", "Damage reduction", "41%", "Armor / (Armor + 25 · g(m)) vs an on-level mob, cap 75%"),
        row("dodge", "Dodge", "0%", "Gear and skills, cap 30%"),
        row("regen", "Regen", "0.67%/tick", "0.5% engaged + Uptime affixes"),
        row("ehp", "EHP", "9,612", "Max HP / (1 − DR) / (1 − dodge)"),
        row("coffee", "Coffee", "18 / 20 cups", "Drunk below 45% HP; heals 41% (Coffee Machine 2)"),
      ] },
      { key: "loot", title: "Rewards", rows: [
        row("if", "Item find", "+11.6%", "0.4% × LUCK + gear + herd, cap 150%"),
        row("gold", "Gold", "+13%", "0.5% × LUCK + gear + Callback Caverns tracker"),
        row("xpb", "XP bonus", "+35%", "Gear + party + herd bonus (Release Train, Docs Library, tracker)"),
        row("fe", "Fresh Eyes", "38 min", "×1.5 kill XP; refills 1 min per 4 while not working; cap 105 min"),
        row("shift", "Shift today", "1h48m", "Full rewards until 4h, half until 8h, a quarter after"),
      ] },
    ],
    why: {
      title: "XP per minute right now", total: "+3,412 XP/min",
      parts: [
        { key: "work", label: "working", value: "×1", good: null, tooltip: "Questing: full kill rewards" },
        { key: "fe", label: "Fresh Eyes", value: "×1.5", good: true, tooltip: "38 min left" },
        { key: "party", label: "Party", value: "+12%", good: true, tooltip: "2 guild-mates questing in the room" },
        { key: "herd", label: "Herd", value: "+23%", good: true, tooltip: "Release Train v2.3 +11.5%, Docs Library 4 +8%, Lint Meadows tracker +4%" },
        { key: "unblocked", label: "Unblocked", value: "+15%", good: true, tooltip: "84 ticks left" },
        { key: "gear", label: "Gear", value: "+2%", good: true, tooltip: "of the Green Build" },
        { key: "shift", label: "Shift", value: "×1", good: null, tooltip: "1h48m today" },
      ],
      notes: [
        "Daily Shift: full rate until 4h today (1h48m so far), then half until 8h.",
        "Fresh Eyes refills while Kip is not working: 1 minute per 4, up to 105 minutes.",
      ],
    },
  };
}

function kipJournal() {
  const L = (key, when, icon, color, text, value = null) => ({ key: `j:${key}`, when, icon, color, text, value });
  return {
    lines: [
      L(118, "09:41", "ui/chest.svg", C.done, "Shipped “Fix flaky auth test”: Iron chest", "2.4 Seals"),
      L(117, "09:40", "ui/slot-weapon.svg", RAR[3], "Found Vectorized Extract Saber of Graceful Degradation (Release)"),
      L(116, "09:12", "ui/star.svg", C.xp, "Reached Lv 34", "Lv 34"),
      L(115, "08:55", "ui/chest.svg", C.done, "Shipped “Bump deps and regenerate lockfile”: Wooden chest", "0.6 Seals"),
      L(114, "08:31", "ui/slot-boots.svg", RAR[5], "Equipped Lazy Quantifier Boots (Keepsake)"),
      L(113, "08:30", "ui/boss.svg", C.hp, "The Catastrophic Backtracker: FIXED in 118 ticks with Rue and Ada", "+12% XP"),
      L(112, "Yesterday", "ui/career.svg", C.xp, "Promoted: Senior Refactorer (passed the Senior Review)", "+1 SP"),
      L(111, "Yesterday", "ui/star.svg", C.xp, "Reached Lv 33", "Lv 33"),
      L(110, "Yesterday", "ui/chest.svg", C.done, "Shipped “Refactor session middleware”: Silver chest", "3.8 Seals"),
      L(109, "Yesterday", "ui/slot-hoodie.svg", RAR[3], "Found Typed Zip Hoodie of Uptime (Release)"),
      L(108, "Nov 22", "ui/boss.svg", C.idle, "Postmortem: The Catastrophic Backtracker held at 12% (Wounds kept 48 h)", "+10% boss dmg"),
      L(107, "Nov 22", "ui/star.svg", C.xp, "Reached Lv 32", "Lv 32"),
      L(106, "Nov 22", "ui/chest.svg", C.done, "Shipped “Add retries to the webhook client”: Iron chest", "1.7 Seals"),
      L(105, "Nov 21", "ui/slot-sticker.svg", RAR[4], "Found Rubber-Stamped Holo Sticker (LTS)"),
      L(104, "Nov 21", "ui/star.svg", C.xp, "Reached Lv 31", "Lv 31"),
      L(103, "Nov 20", "ui/career.svg", C.xp, "Senior Review won: You, Six Months Ago, in 74 ticks"),
      L(102, "Nov 20", "ui/chest.svg", C.done, "Shipped “Split the auth module”: Gold chest", "7.1 Seals"),
    ],
    emptyText: "Nothing yet: levels, shipped quests, notable drops and bosses show up here.",
  };
}

// ---------------------------------------------------------------------------------------------
// Rue Two-Spaces: Lv 31 Junior Hotfixer with the Senior Review ready (Career tab)

const RUE = 2;
const rueHeader = {
  name: "Rue Two-Spaces", level: "Lv 31", title: "Junior Hotfixer", tag: null, tagTip: null, tagTab: null,
  sub: "herdr-app · Codex · fighting 3-3 The Unparsed Gate", quest: "Speed up the test runner",
  status: "blocked",
  hp: { frac: 1, text: "1,021 / 1,021" },
  xp: { frac: 0.18, feFrac: 0, text: "18.0%", tooltip: "Waiting for you: no XP while blocked (it never costs anything)" },
  shift: { frac: 0.71, text: "2h50m", tooltip: "Daily Shift: 2h50m worked today. Full rewards until 4h, then half until 8h." },
  fe: null,
  power: { text: "PL 33", tooltip: "Power Level 33 = Lv 31 + gear 2" },
  buffs: [],
  rig: {
    colors: { hoodie: "#F07D5C", titleBar: "#3A3F4B", screen: "#17161F", faceInk: C.blocked },
    face: "o_o", weapon: { clsId: "hotfixer", color: "#9AA3AD" }, hat: { tier: 2, color: "#5BD16A" },
    accessory: "hotfixer", programIcon: ICON.codex,
  },
  focus: { pane: "p2", address: "t2" },
};

function rueCareer() {
  const cls = (id, label, o = {}) => ({
    ...action(`cls:${id}`, label, "setClass", { heroId: RUE, cls: id }, {
      enabled: o.enabled ?? true, cost: o.current ? null : "775 Snippets", confirm: o.current ? null : `Change to ${label} for 775 Snippets?`,
      tooltip: o.tooltip ?? (o.current ? "Rue's class" : `Career change to ${label}: refunds every skill point`),
    }),
    clsId: id, current: !!o.current, recommended: !!o.recommended, color: CLS[id], lock: false,
  });
  const map = (id, name, o = {}) => ({
    ...action(`map:${id}`, id, "pinMap", { heroId: RUE, mapId: id }, { enabled: o.enabled ?? true, tooltip: `${id} ${name}${o.levels ? ` (Lv ${o.levels})` : ""}` }),
    on: !!o.on,
  });
  return {
    ladder: [
      { key: "intern", title: "Intern", levels: "1–9", state: "done", note: "Hello, World · printf()", review: null },
      { key: "junior", title: "Junior", levels: "10–29", state: "current", note: "Main · Area · Passive · Buff", review: null },
      { key: "senior", title: "Senior", levels: "30–59", state: "next", note: "Signature skill, +1 SP", review: {
        name: "Senior Review", status: "ready", statusText: "Ready: You, Six Months Ago",
        estimate: { text: "Favored 1.42×", color: C.working },
        challenge: action("review:senior", "Challenge", "challenge", { kind: "review", idx: 0, heroId: RUE }, { tone: "primary", tooltip: "Starts the trial in Rue's own slot (its timer runs only while Rue works)" }),
      } },
      { key: "staff", title: "Staff", levels: "60–89", state: "locked", note: "Ultimate, +1 SP", review: {
        name: "Staff Review", status: "locked", statusText: "At Lv 60", estimate: null, challenge: null,
      } },
      { key: "principal", title: "Principal", levels: "90–100", state: "locked", note: "Capstone passive", review: null },
    ],
    signature: { text: "median task 4 min · 0.6 blocks/h · 5% with sub-agents", recommended: "Hotfixer", state: "Locked at 15 tasks", tasks: "20 tasks on record" },
    classes: {
      note: "From Lv 20 a career change costs 25 × level Snippets and refunds every skill point.",
      options: [
        cls("refactorer", "Refactorer"), cls("hotfixer", "Hotfixer", { current: true, recommended: true }), cls("shellmancer", "Shellmancer"),
        cls("forkbinder", "Forkbinder"), cls("rubberducker", "Rubberducker"),
      ],
    },
    map: {
      label: "Pinned", current: "Stay here: 3-3 The Unparsed Gate (Lv 31–33)",
      auto: action("map:auto", "Auto", "pinMap", { heroId: RUE, mapId: null }, { tooltip: "Let autopilot pick the deepest map Rue outfights" }),
      zones: [
        { key: "lint_meadows", name: "Lint Meadows", maps: [map("1-1", "Squiggle Path", { levels: "1–4" }), map("1-2", "Whitespace Fields", { levels: "5–8" }), map("1-3", "Warning Gate", { levels: "9–11" })] },
        { key: "callback_caverns", name: "Callback Caverns", maps: [map("2-1", "Mouth of the Stack", { levels: "12–15" }), map("2-2", "Nested Tunnels", { levels: "16–19" }), map("2-3", "Pyramid Steps", { levels: "20–22" })] },
        { key: "regex_ruins", name: "Regex Ruins", maps: [map("3-1", "Anchor Steps", { levels: "23–26" }), map("3-2", "Quantifier Colonnade", { levels: "27–30" }), map("3-3", "The Unparsed Gate", { levels: "31–33", on: true })] },
        { key: "merge_marshes", name: "Merge Marshes", maps: [map("4-1", "Fast-Forward Ford", { levels: "34–37" }), map("4-2", "Stash Bog", { levels: "38–41", enabled: false }), map("4-3", "Octopus Delta", { levels: "42–44", enabled: false })] },
      ],
    },
    boss: {
      name: "The Octopus Merge", zone: "Merge Marshes · Lv 45", status: "Sprint 18 / 45",
      estimate: { text: "Risky 0.61×", color: C.hp }, challenge: null, fighting: false,
    },
    identity: { name: "Rue Two-Spaces", hint: "Renaming is free. Badges unlock extra epithets." },
    retire: action("retire", "Retire", "retire", { heroId: RUE }, { tone: "danger", confirm: "Retire Rue for good?", tooltip: "Rue joins the Hall of Fame (+0.5% herd XP). Its gear goes to vendor/." }),
    rebind: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Nib the Linted: Lv 3 Intern, first day, few items (Gear tab, nothing selected)

const NIB = 21;
const WREN = -3; // a Contractor (negative ids: never saved) wearing Nib's first-day kit
const nibHeader = {
  name: "Nib the Linted", level: "Lv 3", title: "Intern", tag: null, tagTip: null, tagTab: null,
  sub: "herdr-app · Claude Code · fighting 1-1 Squiggle Path", quest: "Set up the project",
  status: "working",
  hp: { frac: 0.9, text: "62 / 69" },
  xp: { frac: 0.62, feFrac: 0, text: "62.0%", tooltip: "+48 XP/min = working ×1 · Onboarding +0% · Shift: 6m today (full rate until 4h)" },
  shift: { frac: 0.025, text: "6m", tooltip: "Daily Shift: 6m worked today. Full rewards until 4h." },
  fe: null,
  power: { text: "PL 4", tooltip: "Power Level 4 = Lv 3 + gear 1" },
  buffs: [],
  rig: {
    colors: { hoodie: "#45C2A8", titleBar: "#3B2A24", screen: "#17161F", faceInk: C.working },
    face: ">_", weapon: { clsId: "intern", color: "#8B6B4A" }, hat: null, accessory: "intern", programIcon: ICON.claude,
  },
  focus: { pane: "p21", address: "t21" },
};

function nibGear(f = {}) {
  const eq = {
    weapon: item(1, { slot: "weapon", cls: "intern", name: "Training Stick", rar: 0, ilvl: 1, ip: "10", squashable: false }),
    hoodie: item(4, { slot: "hoodie", name: "Swag Tee", rar: 0, ilvl: 2, ip: "20", squashable: false }),
  };
  const all = [
    item(7, { slot: "mug", name: "Paper Cup of Caching", rar: 1, ilvl: 4, ip: "48", delta: good("+2.6%"), isNew: true }),
    item(6, { slot: "hat", name: "Beanie", rar: 0, ilvl: 3, ip: "30", delta: good("+1.8%") }),
    item(5, { slot: "weapon", cls: "hotfixer", name: "Patch Shiv", rar: 0, ilvl: 3, ip: "30", usable: false, tooltip: "Prototype weapon (Patch Knives) · iLvl 3 · waits for a Hotfixer" }),
  ];
  return {
    slots: slotsOf(eq, NIB),
    card: null,
    hint: "Pick an item to compare it with what Nib wears. Autopilot equips upgrades on its own.",
    summary: [
      { key: "ip", label: "Item Power", value: "30", tooltip: "Sum of the equipped items' Item Power" },
      { key: "pl", label: "Power Level", value: "4", tooltip: "Power Level 4 = Lv 3 + gear 1" },
      { key: "dps", label: "DPS (est.)", value: "7.1", tooltip: "Mean single-target damage per tick" },
      { key: "ehp", label: "EHP", value: "104", tooltip: "Max HP / (1 − DR) / (1 − dodge)" },
    ],
    stash: stash(all, f, { count: "3 / 40", fill: 3 / 40 }),
    squash: { available: false, reason: "CI Forge level 3 unlocks Squash Merge", picked: [], label: "", action: action("squash", "Squash Merge", "squash", { uids: [] }, { enabled: false }) },
  };
}

// ---------------------------------------------------------------------------------------------
// Ada Null-Safe: Lv 100 Principal Shellmancer, endgame gear, big stash, an LTS on the card

const ADA = 3;
const adaHeader = {
  name: "Ada Null-Safe", level: "Lv 100", title: "Principal Shellmancer", tag: null, tagTip: null, tagTab: null,
  sub: "billing-service · Gemini CLI · Backlog floor 31", quest: "Migrate invoices to the new ledger",
  status: "working",
  hp: { frac: 0.64, text: "118,402 / 185,006" },
  xp: { frac: 1, feFrac: 0, text: "MAX", tooltip: "Maintenance mode: every 1% of Need(99) earned becomes 1 Snippet (+212 Snippets so far)" },
  shift: { frac: 0.92, text: "3h41m", tooltip: "Daily Shift: 3h41m worked today. Full rewards until 4h." },
  fe: "Fresh Eyes 2h10m",
  power: { text: "PL 108", tooltip: "Power Level 108 = Lv 100 + gear 8 (capped)" },
  buffs: [{ key: "sudo", text: "Sudo 5s", color: "#45C2A8", tooltip: "Sudo: +28% damage (5 ticks left)" }],
  rig: {
    colors: { hoodie: "#C47BE8", titleBar: "#3D3357", screen: "#17161F", faceInk: C.working },
    face: ">_", weapon: { clsId: "shellmancer", color: "#2E2E3A", edge: true }, hat: { tier: 5, color: RAR[5] },
    accessory: "shellmancer", programIcon: ICON.gemini,
  },
  focus: { pane: "p3", address: "t3" },
};

function adaGear(f = {}) {
  const eq = {
    weapon: item(2001, { slot: "weapon", cls: "shellmancer", name: "Mutex Twinfang +12", rar: 5, ilvl: 100, ip: "6,431", pol: 12, locked: true, squashable: false }),
    hat: item(2002, { slot: "hat", name: "Uncertainty Lens +12", rar: 5, ilvl: 100, ip: "6,431", pol: 12, locked: true, squashable: false }),
    hoodie: item(2003, { slot: "hoodie", name: "Infinite-Pocket Parka of Prod +10", rar: 4, ilvl: 104, ip: "5,898", pol: 10, squashable: false }),
    mug: item(2004, { slot: "mug", name: "Lockfile Mug +12", rar: 5, ilvl: 100, ip: "6,431", pol: 12, locked: true, squashable: false }),
    // "Treads of Uptime" is the tier-5 boots base (not an "of Uptime" suffix, which boots never roll)
    boots: item(2005, { slot: "boots", name: "Typed Treads of Uptime +7", rar: 2, ilvl: 106, ip: "4,520", pol: 7, squashable: false }),
    sticker: item(2006, { slot: "sticker", name: "Microservice Badge +12", rar: 5, ilvl: 100, ip: "6,431", pol: 12, locked: true, squashable: false }),
  };
  const names = [
    ["weapon", "Staff of Pure Functions", "shellmancer"], ["hat", "Crown of Inbox Zero"], ["hoodie", "Parka of Prod"], ["mug", "Obsidian Pour-Over"],
    ["boots", "Treads of Uptime"], ["sticker", "Conference Badge"], ["weapon", "The Midnight Patch", "hotfixer"], ["weapon", "The Init Scripture", "forkbinder"],
    ["weapon", "The Clean Slate", "refactorer"], ["weapon", "The Duck Who Knew", "rubberducker"],
  ];
  // affixes a slot can roll (D§8.3), so every generated name is one items.itemName could produce
  const pool = (slot, kind) => AFFIXES.filter((a) => a.kind === kind && a.slots.includes(slot)).map((a) => a.name);
  const all = [
    item(2101, { slot: "weapon", cls: "shellmancer", name: "Ten-X Keys Staff of Pure Functions", rar: 4, ilvl: 108, ip: "6,104", delta: bad("−2.2%"), isNew: true, squashable: false }),
  ];
  for (let i = 0; i < 38; i++) {
    const [slot, b, cls] = names[i % names.length];
    const rar = [2, 3, 1, 2, 3, 2, 4, 1][i % 8];
    const ilvl = 100 + (i * 7) % 16;
    const usable = !cls || cls === "shellmancer";
    const pre = pool(slot, "prefix");
    const suf = pool(slot, "suffix");
    const nm = rar === 1 ? `${pre[i % pre.length]} ${b}` : rar === 4 ? `Hot-Reloading ${b}` : `${pre[(i + 3) % pre.length]} ${b} ${suf[i % suf.length]}`;
    all.push(item(2110 + i, { slot, cls, name: nm, rar, ilvl, ip: (Math.round(10 * ilvl * [1, 1.1, 1.22, 1.36, 1.52][rar] * (1 + 0.08 * [0, 1, 2, 3, 4][rar]))).toLocaleString("en-US"),
      usable, delta: usable ? bad(`−${(3 + (i * 13) % 40 / 4).toFixed(1)}%`) : null, locked: i % 11 === 4 }));
  }
  const lts = all[0];
  const rr = (k) => action(`reroll:2101:${k}`, "Reroll", "reroll", { uid: 2101, affix: k }, { cost: "638k gold · 50 Snippets", tooltip: "Rerolls the affix's type and value" });
  return {
    slots: slotsOf(eq, ADA),
    card: f.focus === 2101 ? cardOf(lts, {
      sub: "LTS weapon · iLvl 108 · req Lv 100", stat: "Weapon damage 14,102",
      affixes: [
        { key: "2101:0", text: "+18.4% damage", reroll: rr(0) },
        { key: "2101:1", text: "+9.0% crit chance", reroll: rr(1) },
        { key: "2101:2", text: "+4.6% extra-action chance", reroll: rr(2) },
      ],
      prop: { name: "Ten-X Keys", text: "Every 10th action deals ×10 damage (a “10x” pops)." },
      polish: "Polish +0 of +10", vs: "vs Mutex Twinfang +12 (equipped)",
      deltas: [
        { key: "wd", label: "Weapon damage", text: "+1,288", good: true },
        { key: "dmg", label: "Damage", text: "+18.4%", good: true },
        { key: "boss", label: "Boss damage", text: "−25%", good: false },
        { key: "crit", label: "Crit chance", text: "+9.0%", good: true },
        { key: "ip", label: "Item Power", text: "−327", good: false },
      ],
      score: bad("−2.2%"),
      actions: [
        action("equip:2101", "Equip", "equip", { heroId: ADA, uid: 2101 }, { tooltip: "Mutex Twinfang is locked: unlock it first", enabled: false }),
        action("lock:2101", "Lock", "lock", { uid: 2101, locked: true }),
        action("polish:2101", "Polish", "polish", { uid: 2101 }, { cost: "79.3k gold · 5 Snippets", tooltip: "+5% weapon damage (to +1)" }),
        action("deprecate:2101", "Deprecate", "deprecate", { uid: 2101 }, { cost: "+200 Snippets", tone: "danger", confirm: "Deprecate this LTS?", tooltip: "Salvage for 200 Snippets and 25.5k gold" }),
      ],
    }) : null,
    hint: "Pick an item to compare it with what Ada wears.",
    summary: [
      { key: "ip", label: "Item Power", value: "36,512", tooltip: "Sum of the six equipped items' Item Power" },
      { key: "pl", label: "Power Level", value: "108", tooltip: "Power Level 108 = Lv 100 + gear 8" },
      { key: "dps", label: "DPS (est.)", value: "1.92M", tooltip: "Mean single-target damage per tick" },
      { key: "ehp", label: "EHP", value: "702k", tooltip: "Max HP / (1 − DR) / (1 − dodge)" },
    ],
    stash: stash(all, f, { count: "139 / 140", fill: 139 / 140, full: true, more: f.slot && f.slot !== "all" ? null : "+100 more: narrow the filter" }),
    squash: squashOf(f.squash ?? [], {}),
  };
}

function adaSkills() {
  const s = kipSkills();
  const sk = (slot, name, glyph, rank, max, effect, slotLabel, cd = null) => ({
    key: `sk:${slot}`, slot, slotLabel, name, glyph, rank, max, rankText: `${rank}/${max}`, locked: false, lockText: null,
    effect, next: rank >= max ? null : `Next rank: ${effect.replace(/\d+%/, (m) => `${parseInt(m, 10) + 4}%`)}`, cd,
    learn: rank >= max ? null : action(`learn:${ADA}:${slot}`, "+1", "learn", { heroId: ADA, slot }, { enabled: false, tooltip: "No skill points to spend" }), tooltip: name,
  });
  return {
    ...s,
    sp: { count: 0, text: "skill points to spend", tooltip: "101 points from levels and reviews; 105 ranks in all, so choices still matter." },
    autoLearn: { on: false, action: action("autolearn", "Auto-learn", "autoLearn", { heroId: ADA, on: true }), hint: "Off: you spend points yourself" },
    respec: action("respec", "Respec", "respec", { heroId: ADA }, { cost: "500 Snippets", enabled: true, confirm: "Respec for 500 Snippets?" }),
    ladder: s.ladder.map((l) => ({ ...l, state: l.key === "principal" ? "current" : "done" })),
    skills: [
      sk("main", "Echo Bolt", ">", 20, 20, "Ranged hit for 157% of a normal hit", "Main · Lv 1"),
      sk("area", "Pipe Chain", "|", 15, 15, "Chains through up to 4 mobs for 107% each", "Area · Lv 5", "CD 4 ticks"),
      sk("passive", "Tab Completion", "⇥", 11, 15, "11% chance per action of a free extra Echo Bolt", "Passive · Lv 10"),
      sk("buff", "Sudo", "#", 15, 15, "8 ticks: +28% damage", "Buff · Lv 20", "CD 30 ticks"),
      sk("sig", "Cron Job", "@", 15, 15, "Every 6th action: Cron Bolt for 312%, half to the lane", "Signature · Lv 30", "every 6th action"),
      sk("ult", "Midnight Batch", "***", 15, 15, "3 meteors, each hits every lane mob for 136%", "Ultimate · Lv 60", "CD 50 ticks"),
      sk("cap", "Root Access", "~#", 10, 10, "+20% damage; ignores 20% of boss DR and shields", "Capstone · Lv 90"),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Juno of the Green Build: off duty (benched) Senior Rubberducker, Career tab with Rebind

const JUNO = 7;
const junoHeader = {
  name: "Juno of the Green Build", level: "Lv 47", title: "Senior Rubberducker", tag: "off duty", tagTip: null, tagTab: null,
  sub: "docs-site · Claude Code · last seen Nov 21", quest: null,
  status: "off",
  hp: { frac: 1, text: "2,904 / 2,904" },
  xp: { frac: 0.55, feFrac: 0.1, text: "55.0%", tooltip: "Off duty: Fresh Eyes builds up (1 min per 4, wall clock)" },
  shift: { frac: 0, text: "0m", tooltip: "Daily Shift: nothing worked today." },
  fe: "Fresh Eyes 1h45m",
  power: { text: "PL 48", tooltip: "Power Level 48 = Lv 47 + gear 1" },
  buffs: [],
  rig: {
    colors: { hoodie: "#C08A3E", titleBar: "#3B2A24", screen: "#17161F", faceInk: C.idle },
    face: "-_-", weapon: { clsId: "rubberducker", color: "#5FB3A8" }, hat: { tier: 3, color: RAR[3] }, accessory: "rubberducker", programIcon: ICON.claude,
  },
  focus: null,
};

function junoCareer() {
  const c = rueCareer();
  return {
    ...c,
    ladder: c.ladder.map((l) => (l.key === "senior" ? { ...l, state: "current", review: { name: "Senior Review", status: "won", statusText: "Passed Nov 9 in 81 ticks", estimate: null, challenge: null } }
      : l.key === "junior" ? { ...l, state: "done" } : l)),
    signature: { text: "median task 9 min · 2.6 blocks/h · 0% with sub-agents", recommended: "Rubberducker", state: "Locked at 15 tasks", tasks: "20 tasks on record" },
    classes: {
      note: c.classes.note,
      options: c.classes.options.map((o) => ({ ...o, key: o.key, args: { heroId: JUNO, cls: o.clsId }, current: o.clsId === "rubberducker", recommended: o.clsId === "rubberducker",
        cost: o.clsId === "rubberducker" ? null : "1,175 Snippets", enabled: false, tooltip: o.clsId === "rubberducker" ? "Juno's class" : "Needs 1,175 Snippets (the herd has 312)" })),
    },
    map: {
      label: "Auto", current: "Auto: 5-1 Lockfile Clearing (Lv 45–48)",
      auto: action("map:auto", "Auto", "pinMap", { heroId: JUNO, mapId: null }, { enabled: false, tooltip: "Already on auto" }),
      zones: c.map.zones.map((z) => ({ ...z, maps: z.maps.map((m) => ({ ...m, args: { heroId: JUNO, mapId: m.args.mapId }, on: false, enabled: true })) })),
    },
    boss: null,
    identity: { name: "Juno of the Green Build", hint: "Renaming is free. Badges unlock extra epithets." },
    retire: action("retire", "Retire", "retire", { heroId: JUNO }, { tone: "danger", confirm: "Retire Juno for good?", tooltip: "Juno joins the Hall of Fame (+0.5% herd XP). Its gear goes to vendor/." }),
    rebind: {
      title: "Rebind a live agent",
      hint: "Move an agent that plays as a new hero or a contractor onto Juno. Its current hero goes off duty.",
      options: [
        action("rebind:t9", "Bind", "rebind", { heroId: JUNO, address: "t9" }, { tooltip: "Claude Code in docs-site · “Write the changelog” (Lv 4 Intern)" }),
        action("rebind:t12", "Bind", "rebind", { heroId: JUNO, address: "t12" }, { tooltip: "Codex in herdr-app · “Fix the release script” (contractor)" }),
      ],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pip the Unmerged: Lv 14 Junior Hotfixer with a provisional class (the header tag opens Career,
// whose current class chip locks it) while the zone boss fight runs (the boss card: Retreat)

const PIP = 5;
const PIP_PROV = "Provisional class (9 of 15 tasks): Pip's behaviour can still switch it. Lock it with its class chip on the Career tab.";
const pipHeader = {
  ...rueHeader,
  name: "Pip the Unmerged", level: "Lv 14", title: "Junior Hotfixer", tag: "provisional", tagTip: PIP_PROV, tagTab: "career",
  sub: "herdr-app · Codex · fighting The Pyramid of Doom", quest: "Untangle the retry callbacks", status: "working",
  power: { text: "PL 15", tooltip: "Power Level 15 = Lv 14 + gear 1" },
  focus: { pane: "p5", address: "t5" },
};

function pipCareer() {
  const c = rueCareer();
  const cls = (id, label) => {
    const current = id === "hotfixer";
    return {
      ...action(`cls:${id}`, label, "setClass", { heroId: PIP, cls: id }, current
        ? { confirm: "Lock Hotfixer?", tooltip: "Lock Hotfixer now (free). Provisional class (9 of 15 tasks): until then behaviour can still switch it." }
        : { tooltip: `Switch to ${label} for free (locks it)` }),
      clsId: id, current, recommended: current, color: CLS[id], lock: current,
    };
  };
  return {
    ...c,
    ladder: c.ladder.map((l) => (l.key === "senior" ? { ...l, review: { name: "Senior Review", status: "locked", statusText: "At Lv 30", estimate: null, challenge: null } } : l)),
    signature: { text: "median task 3 min · 0.4 blocks/h · 0% with sub-agents", recommended: "Hotfixer", state: "Provisional (9 of 15 tasks)", tasks: "9 tasks on record" },
    classes: {
      note: "Any class, free, before Lv 20 (this also locks it).",
      options: [cls("refactorer", "Refactorer"), cls("hotfixer", "Hotfixer"), cls("shellmancer", "Shellmancer"), cls("forkbinder", "Forkbinder"), cls("rubberducker", "Rubberducker")],
    },
    map: { ...c.map, zones: c.map.zones.slice(0, 2).map((z) => ({ ...z, maps: z.maps.map((m) => ({ ...m, args: { heroId: PIP, mapId: m.args.mapId }, on: m.label === "2-3" })) })),
      current: "Stay here: 2-3 Pyramid Steps (Lv 20–22)", auto: action("map:auto", "Auto", "pinMap", { heroId: PIP, mapId: null }, { tooltip: "Let autopilot pick the deepest map Pip outfights" }) },
    boss: {
      name: "The Pyramid of Doom", zone: "Callback Caverns · Lv 23", status: "Fighting: 81% left", estimate: null,
      challenge: action("retreat:boss:1", "Retreat", "retreat", {}, { tone: "danger", confirm: "Retreat? (a Postmortem)", tooltip: "End the fight as a Postmortem: Wounds and Lessons are kept" }),
      fighting: true,
    },
    identity: { name: "Pip the Unmerged", hint: "Renaming is free. Badges unlock extra epithets." },
    retire: action("retire", "Retire", "retire", { heroId: PIP }, { enabled: false, tooltip: "Retiring opens at Lv 30" }),
    rebind: null,
  };
}

// ---------------------------------------------------------------------------------------------

const kipVm = (tab, f = {}) => {
  const vm = base(KIP, tab, kipHeader, { badges: { skills: "1" } });
  if (tab === "gear") vm.gear = kipGear(f);
  if (tab === "skills") vm.skills = kipSkills();
  if (tab === "stats") vm.stats = kipStats();
  if (tab === "journal") vm.journal = kipJournal();
  return vm;
};

export const scenarios = {
  /** host.view returned null: the world is still loading. */
  loading: null,
  /** The hero is gone (deleted from the roster while the sheet was open). */
  missing: { heroId: 99, tab: "gear", tabs: tabs(), calm: false, missing: "This hero has left the roster.", header: null, note: null, gear: null, skills: null, stats: null, career: null, journal: null },
  /** Mid-game, full gear, a Release weapon selected in the stash (compare card with rerolls). */
  gear: kipVm("gear", { focus: 921 }),
  /** Picking items for Squash Merge (two Alpha items picked). */
  gearSquash: kipVm("gear", { squash: [905, 907] }),
  /** An equipped item selected on the paper doll. */
  gearEquipped: kipVm("gear", { focus: 803, slot: "hoodie" }),
  /** Skills: one point to spend, two locked tiers. */
  skills: kipVm("skills"),
  /** Derived stats with formulas and the XP "why". */
  stats: kipVm("stats"),
  /** Career with the Senior Review ready, a pinned map and a boss card. */
  career: { ...base(RUE, "career", rueHeader, { badges: { career: "1" } }), career: rueCareer() },
  /** The hero's journal. */
  journal: kipVm("journal"),
  /** First day: a Lv 3 Intern with a few items, nothing selected. */
  intern: { ...base(NIB, "gear", nibHeader), gear: nibGear() },
  /** Lv 100 Principal: endgame gear, a full stash, an LTS on the card. */
  principal: { ...base(ADA, "gear", adaHeader), gear: adaGear({ focus: 2101 }) },
  /** Lv 100 Principal skills: everything unlocked, auto-learn off, calm mode. */
  principalSkills: { ...base(ADA, "skills", adaHeader, { calm: true }), skills: adaSkills() },
  /** A provisional class (the header tag links to Career, the class chip locks it) during a zone boss fight (Retreat). */
  provisional: { ...base(PIP, "career", pipHeader), career: pipCareer() },
  /** The same hero on the Gear tab: the "provisional" tag is a link to Career. */
  provisionalGear: { ...base(PIP, "gear", pipHeader), gear: kipGear() },
  /**
   * A Contractor (owner decision, round 4: promoted when hiring reopens): the banner says when it
   * joins the roster, its tooltip the whole story; the tag explains itself.
   */
  contractor: { ...base(WREN, "gear", { ...nibHeader, name: "Wren Monorepo-Raised", level: "Lv 6", tag: "contractor",
    tagTip: "Contractor: Hired at the next 04:00 game day · 2 ahead in line (today: 0 of 6 hires left). When hired it keeps its name, level, XP and class, and its kit becomes saved Alpha gear.",
    sub: "ref-client · Claude Code · fighting 1-2 Whitespace Fields", quest: null, focus: { pane: "p33", address: "t33" } }, {
    note: {
      text: "Contractor: hired tomorrow at 04:00 · not saved until then; its kills and chests still pay the herd", color: C.idle,
      tooltip: "Hired at the next 04:00 game day · 2 ahead in line (today: 0 of 6 hires left). When hired it keeps its name, level, XP and class, and its kit becomes saved Alpha gear. Contractors don't get equity.",
    },
  }), gear: nibGear() },
  /** An off-duty (benched) hero: Career with Rebind, no Focus button. */
  benched: { ...base(JUNO, "career", junoHeader, { note: { text: "Off duty since Nov 21 · Fresh Eyes keeps building · pending chests wait", color: C.idle } }), career: junoCareer() },
};

/** The role's UI state each scenario is meant to be seen with. */
export const uiStates = {
  gear: { selected: 921 },
  gearSquash: { squashMode: true, filter: { slot: "all", minRar: 0, usable: false, sort: "score", squash: [905, 907] } },
  gearEquipped: { selected: 803, filter: { slot: "hoodie", minRar: 0, usable: false, sort: "score", squash: [] } },
  principal: { selected: 2101 },
};

/** Dialog width each scenario is seen at. */
export const widths = Object.fromEntries(Object.keys(scenarios).map((k) => [k, 760]));

/**
 * The VM a fake host returns for {tab, filter}: the scenario's hero on the asked tab (tests and
 * previews use it to switch tabs and filters like view.js would).
 */
export function viewFor(name, args = {}) {
  const vm = scenarios[name];
  if (!vm || vm.missing) return vm;
  const tab = args.tab ?? vm.tab;
  const f = args.filter ?? {};
  if (vm.heroId === KIP) return kipVm(tab, f);
  if (tab === vm.tab && tab !== "gear") return vm;
  const out = { ...vm, tab, gear: null, skills: null, stats: null, career: null, journal: null };
  if (tab === "gear") out.gear = vm.heroId === ADA ? adaGear(f) : vm.heroId === NIB || vm.heroId === WREN ? nibGear(f) : kipGear(f);
  else if (tab === "skills") out.skills = vm.heroId === ADA ? adaSkills() : kipSkills();
  else if (tab === "stats") out.stats = kipStats();
  else if (tab === "career") out.career = vm.heroId === JUNO ? junoCareer() : vm.heroId === PIP ? pipCareer() : rueCareer();
  else if (tab === "journal") out.journal = kipJournal();
  return out;
}

/** The same VM one tick later (bars moved, a buff ticked): ids must stay stable. */
export function nextTick(vm) {
  if (!vm || vm.missing) return vm;
  const out = JSON.parse(JSON.stringify(vm));
  out.header.hp.frac = Math.max(0, out.header.hp.frac - 0.02);
  out.header.xp.frac = Math.min(1, out.header.xp.frac + 0.003);
  for (const b of out.header.buffs) b.text = b.text.replace(/(\d+)s$/, (m, n) => `${Math.max(1, n - 1)}s`);
  if (out.gear) for (const it of out.gear.stash.items) if (it.delta) it.delta.text = it.delta.text.replace(/\.\d/, ".0");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Previews of real demo worlds (game/demo.js) through game/view.js and the dialog roles:
//   node --import ./tools/mock/register.mjs tools/vm-samples/sheet.mjs --views [--all] [--only kind] [--tab gear]
//   node --import ./tools/mock/register.mjs tools/vm-samples/herd.mjs --views  [--all] [--only kind] [--tab stash]
// → out/view-sheet-<kind>-<tab>.png / out/view-herd-<kind>-<tab>.png (deviceScaleFactor 2).

const VIEW_SHOTS = {
  sheet: [["mid", "gear"], ["mid", "skills"], ["mid", "stats"], ["mid", "career"], ["mid", "journal"], ["late", "gear"], ["late", "skills"],
    ["late", "career"], ["first-day", "gear"], ["first-day", "career"], ["boss", "career"], ["blocked", "stats"], ["empty", "gear"]],
  herd: [["mid", "upgrades"], ["mid", "stash"], ["mid", "tracker"], ["mid", "bosses"], ["mid", "roster"], ["mid", "digest"], ["mid", "settings"],
    ["late", "upgrades"], ["late", "stash"], ["late", "tracker"], ["late", "bosses"], ["late", "roster"], ["late", "digest"], ["boss", "bosses"],
    ["first-day", "stash"], ["first-day", "digest"], ["empty", "upgrades"]],
};

/** Render real demo worlds through sheetView / herdView and the role, then screenshot them. */
export async function shootDialogViews(role, argv = []) {
  const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const only = arg("--only", null);
  const onlyTab = arg("--tab", null);
  const M = await import("../mock/index.mjs");
  const { View } = await import("gpui-kit");
  const { shoot } = await import("../preview/shoot.mjs");
  const { demoWorld, DEMO_KINDS } = await import("../../mods/down-the-stack/game/demo.js");
  const V = await import("../../mods/down-the-stack/game/view.js");
  const Role = (await import(role === "sheet" ? "../../mods/down-the-stack/ui/sheet.js" : "../../mods/down-the-stack/ui/herdpanel.js")).default;
  const tabs = role === "sheet" ? ["gear", "skills", "stats", "career", "journal"] : ["upgrades", "stash", "tracker", "bosses", "roster", "digest", "settings"];
  const list = argv.includes("--all") ? DEMO_KINDS.flatMap((k) => tabs.map((t) => [k, t])) : VIEW_SHOTS[role];
  const now = Date.UTC(2026, 10, 24, 9, 30, 0);
  const [W, H] = role === "sheet" ? [760, 500] : [760, 520];
  const worlds = new Map();
  const shots = [];
  for (const [kind, tab] of list) {
    if ((only && kind !== only) || (onlyTab && tab !== onlyTab)) continue;
    if (!worlds.has(kind)) worlds.set(kind, demoWorld(kind, now).world);
    const world = worlds.get(kind);
    const herd = world.state.herd;
    const hero = world.state.heroes[0];
    // something to compare: the best-scoring stash item, else the hero's weapon
    const sel = (herd.stash.find((it) => it.rar >= 3) || herd.stash[0] || (hero && hero.eq.find(Boolean)) || {}).uid ?? null;
    M.resetState();
    M.setFixture({ theme: "graphite" });
    const host = {
      world, version: 1, claim: () => true, command: () => ({ ok: true }),
      view: (k, a) => (k === "sheet" ? V.sheetView(world, a) : k === "herd" ? V.herdView(world, a) : null),
    };
    const props = role === "sheet" ? { role, overlay: "o1", heroId: hero ? hero.id : 1, tab } : { role, overlay: "o2", tab };
    class Wrap extends View {
      init(_p, cx) {
        this.r = new Role();
        this.r.init(props, cx, host);
        this.r.ui.tab = tab;
        this.r.ui.selected = sel;
      }
      render(cx) { return this.r.render(cx); }
    }
    const mod = await M.mountView(Wrap, { props, nowMs: now });
    mod.render();
    mod.size(W, H);
    mod.render();
    for (const e of mod.errors) console.warn(`  ! ${kind}/${tab}: [${e.code}] ${e.message}`);
    const name = `view-${role}-${kind}-${tab}`;
    console.log(`${name}: ${mod.stats.elements} elements, ${mod.stats.lastRenderMs.toFixed(1)} ms`);
    shots.push({ name, tree: mod.tree, width: W, height: H, userFacing: true, theme: M.resolveTheme("graphite") });
  }
  const files = await shoot(shots);
  const { relative } = await import("node:path");
  for (const f of files) console.log(`wrote ${relative(process.cwd(), f.file)}`);
}

if (typeof process !== "undefined" && process.argv[1] && /vm-samples[\\/]sheet\.mjs$/.test(process.argv[1]) && process.argv.includes("--views")) {
  shootDialogViews("sheet", process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
