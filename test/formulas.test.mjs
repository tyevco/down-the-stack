// Content tables (D§14 fidelity and cross-references), formulas (D§5, D§6, D§8, D§10), number
// formatting (D§11.7) and the RNG.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as D from "../mods/down-the-stack/game/data.js";
import * as F from "../mods/down-the-stack/game/formulas.js";
import * as R from "../mods/down-the-stack/game/rng.js";

const close = (actual, expected, msg) => {
  const tol = Math.max(1, Math.abs(expected) * 0.01);
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected} (±${tol})`);
};

// ---------------------------------------------------------------------------------------------
// data.js
// ---------------------------------------------------------------------------------------------

function designBlocks() {
  const md = fs.readFileSync(new URL("../docs/DESIGN.md", import.meta.url), "utf8");
  const sec = md.slice(md.indexOf("## 14. Content tables"), md.indexOf("## 15."));
  const out = {};
  const re = /### (14\.\d)[^\n]*\n[\s\S]*?```json\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(sec))) out[m[1]] = JSON.parse(m[2]);
  return out;
}

// docs/BALANCE.md: every D§14 value data.js deliberately changes, as path -> [design value, data
// value]. The design side is checked against docs/DESIGN.md too, so this list, the "// balance:"
// comments in data.js and BALANCE.md cannot drift apart silently.
export const BALANCE_DEVIATIONS = {
  "bosses.5.bk": [32, 29],
  "bosses.6.bk": [32, 28],
  "tuning.gap.floor": [0.1, 0.03],
  "tuning.boss.autoAt": [1, 0.9],
  "traits.thorns.reflect": [0.08, 0.03],
  "mobs.0.atk": [1, 0.7],
  "mobs.0.xp": [1, 0.88],
  "mobs.1.atk": [1.4, 0.8],
  "mobs.1.xp": [1.2, 0.86],
  "mobs.2.atk": [0.8, 0.5],
  "mobs.2.xp": [1.4, 1.47],
  "mobs.3.xp": [0.9, 0.81],
  "mobs.4.xp": [1.1, 1.16],
  "mobs.5.xp": [1.1, 0.96],
  "mobs.6.xp": [0.6, 0.66],
  "mobs.7.xp": [1, 1.07],
  "mobs.8.xp": [1.3, 1.11],
  "mobs.9.xp": [0.9, 0.86],
  "mobs.10.xp": [1.2, 1.01],
  "mobs.11.xp": [1.6, 1.33],
  "mobs.12.xp": [0.5, 0.56],
  "mobs.13.atk": [1, 0.9],
  "mobs.13.xp": [1.2, 1.11],
  "mobs.14.thorns": [0.08, 0.03],
  "mobs.14.xp": [1.3, 1.1],
  "mobs.15.xp": [0.6, 0.64],
  "mobs.16.xp": [1, 1.02],
  "mobs.17.atk": [1.8, 1.55],
  "mobs.17.xp": [1.2, 0.92],
  "mobs.18.xp": [0.9, 0.88],
  "mobs.19.atk": [1.1, 1],
  "mobs.19.xp": [1, 0.82],
  "mobs.20.xp": [1.5, 1.24],
  "mobs.21.xp": [1.1, 1.08],
  "mobs.22.xp": [1.2, 1.09],
  "mobs.23.xp": [1.1, 0.84],
  "mobs.24.xp": [0.45, 0.54],
  "mobs.25.xp": [1, 0.97],
  "mobs.26.xp": [1.4, 1.05],
  "affixes.0.lo": [0.02, 0.01],
  "affixes.0.hi": [0.04, 0.02],
  "affixes.1.lo": [0.01, 0.005],
  "affixes.1.hi": [0.02, 0.01],
  "affixes.2.lo": [0.05, 0.025],
  "affixes.2.hi": [0.1, 0.05],
  "affixes.3.lo": [0.005, 0.0025],
  "affixes.3.hi": [0.01, 0.005],
  "affixes.6.lo": [0.01, 0.005],
  "affixes.6.hi": [0.02, 0.01],
  "affixes.7.lo": [0.03, 0.015],
  "affixes.7.hi": [0.06, 0.03],
  "affixes.8.lo": [0.03, 0.015],
  "affixes.8.hi": [0.06, 0.03],
  "affixes.9.lo": [0.01, 0.005],
  "affixes.9.hi": [0.02, 0.01],
  "affixes.10.lo": [0.03, 0.015],
  "affixes.10.hi": [0.06, 0.03],
  "affixes.11.lo": [0.02, 0.01],
  "affixes.11.hi": [0.04, 0.02],
  "affixes.14.lo": [0.02, 0.01],
  "affixes.14.hi": [0.04, 0.02],
  "affixes.15.lo": [0.04, 0.02],
  "affixes.15.hi": [0.08, 0.04],
};

// Every value in the design is present, unchanged, in data (data may add derived fields), except
// the documented balance deviations.
function assertSubset(design, data, path, seen) {
  if (design === null || typeof design !== "object") {
    const dev = BALANCE_DEVIATIONS[path];
    if (dev) {
      if (seen) seen.add(path);
      assert.deepEqual(design, dev[0], `${path}: the design value changed (update BALANCE_DEVIATIONS / docs/BALANCE.md)`);
      assert.deepEqual(data, dev[1], `${path}: data drifted from the documented balance value`);
      return;
    }
    assert.deepEqual(data, design, path);
    return;
  }
  assert.equal(Array.isArray(data), Array.isArray(design), `${path}: array-ness`);
  if (Array.isArray(design)) assert.equal(data.length, design.length, `${path}: length`);
  for (const k of Object.keys(design)) {
    assert.ok(data != null && k in data, `${path}.${k} missing`);
    assertSubset(design[k], data[k], `${path}.${k}`, seen);
  }
}

describe("data.js: D§14 transcription", () => {
  const B = designBlocks();
  test("all eight §14 blocks parse", () => assert.equal(Object.keys(B).length, 8));
  const pairs = [
    ["14.1", "tuning", D.TUNING], ["14.1", "classes", D.CLASSES], ["14.1", "careers", D.CAREERS],
    ["14.2", "slots", D.SKILLS.slots], ["14.2", "autoLearnTieOrder", D.SKILLS.autoLearnTieOrder],
    ["14.2", "skills", D.SKILLS.byClass], ["14.4", "traits", D.TRAITS], ["14.4", "elite", D.ELITE],
    ["14.4", "holo_duck", D.HOLO_DUCK], ["14.4", "mobs", D.MOBS], ["14.5", "bosses", D.BOSSES],
    ["14.5", "reviews", D.REVIEWS], ["14.6", "rarities", D.RARITIES], ["14.6", "dropWeights", D.DROP_WEIGHTS],
    ["14.6", "affixes", D.AFFIXES], ["14.6", "affixValue", D.AFFIX_VALUE], ["14.6", "properties", D.LTS_PROPS],
    ["14.6", "keepsakes", D.KEEPSAKES], ["14.8", "buildings", D.BUILDINGS], ["14.8", "stash", D.STASH],
    ["14.8", "bugTracker", D.BUG_TRACKER], ["14.8", "trophy", D.TROPHY], ["14.8", "badges", D.BADGES],
    ["14.8", "names", D.NAMES], ["14.8", "palette", D.PALETTE], ["14.8", "chestTiers", D.CHEST_TIERS],
  ];
  const seen = new Set();
  for (const [blk, key, val] of pairs) test(`${blk} ${key}`, () => assertSubset(B[blk][key], val, key, seen));
  test("every documented balance deviation is used, and data.js marks it with a balance: comment", () => {
    const src = fs.readFileSync(new URL("../mods/down-the-stack/game/data.js", import.meta.url), "utf8");
    for (const p of Object.keys(BALANCE_DEVIATIONS)) assert.ok(seen.has(p), `${p} is not a D§14 value any more`);
    assert.ok((src.match(/\/\/ balance:/g) || []).length >= 30, "data.js marks its balance changes");
    const doc = fs.readFileSync(new URL("../docs/BALANCE.md", import.meta.url), "utf8");
    for (const k of ["Gap floor", "thorns", "firstSwingDelay", "ilvlOffset", "campfireDaysPerLevel", "xpFirst", "autoAt", "Affix ranges"]) {
      assert.ok(doc.includes(k), `docs/BALANCE.md explains ${k}`);
    }
  });
  test("14.3 zones", () => assertSubset(B["14.3"], D.ZONES, "zones"));
  test("14.7 item bases", () => assertSubset(B["14.7"], D.ITEM_BASES, "itemBases"));
});

describe("data.js: cross-references", () => {
  test("ids are unique where they are keys", () => {
    for (const [name, list] of [["MOBS", D.MOBS], ["BOSSES", D.BOSSES], ["ZONES", D.ZONES], ["CLASSES", D.CLASSES],
      ["RARITIES", D.RARITIES], ["AFFIXES", D.AFFIXES], ["LTS_PROPS", D.LTS_PROPS], ["KEEPSAKES", D.KEEPSAKES],
      ["BUILDINGS", D.BUILDINGS], ["BADGES", D.BADGES], ["MAPS", D.MAPS], ["CHEST_TIERS", D.CHEST_TIERS]]) {
      const ids = list.map((x) => x.id);
      assert.equal(new Set(ids).size, ids.length, `${name} duplicate ids`);
    }
    const skillIds = Object.values(D.SKILLS.byClass).flat().map((s) => s.id);
    assert.equal(new Set(skillIds).size, skillIds.length, "skill ids");
  });

  test("`n` fields equal the array index (save ids)", () => {
    for (const list of [D.CLASSES, D.ZONES, D.BOSSES, D.RARITIES, D.AFFIXES, D.LTS_PROPS, D.KEEPSAKES, D.BUILDINGS]) {
      list.forEach((x, i) => assert.equal(x.n, i, x.id));
    }
    D.BASE_LIST.forEach((b, i) => assert.equal(b.n, i));
  });

  test("9 zones x 3 maps, levels and boss levels follow D§9.1", () => {
    assert.equal(D.ZONES.length, 9);
    assert.equal(D.MAPS.length, 27);
    D.ZONES.forEach((z, k) => {
      const b = 1 + 11 * k;
      assert.deepEqual(z.levels, [b, b + 10]);
      assert.deepEqual(z.maps.map((m) => m.levels), [[b, b + 3], [b + 4, b + 7], [b + 8, b + 10]]);
      assert.deepEqual(z.maps.map((m) => m.id), [1, 2, 3].map((j) => `${k + 1}-${j}`));
      assert.equal(D.BOSSES[z.boss].zone, k);
      assert.equal(D.BOSSES[z.boss].level, b + 11);
      assert.equal(z.sprint, D.TUNING.sprint[k]);
    });
  });

  test("every map spawn references an existing mob of that zone, weights sum to 1", () => {
    for (const m of D.MAPS) {
      let sum = 0;
      for (const [id, w] of Object.entries(m.spawn)) {
        const mob = D.MOB_BY_ID[id];
        assert.ok(mob, `${m.id} spawns unknown ${id}`);
        assert.equal(mob.zone, m.zone, `${id} zone`);
        sum += w;
      }
      assert.ok(Math.abs(sum - 1) < 1e-9, `${m.id} spawn weights`);
    }
    // each mob's home map spawns it at 75-100%
    for (const mob of D.MOBS) {
      const home = D.MAPS[mob.zone * 3 + mob.map - 1];
      assert.ok(home.spawn[mob.id] >= 0.75, `${mob.id} home map`);
    }
    assert.equal(D.MOBS.length, 27);
  });

  test("map mid levels are the D§5.9 home levels", () => {
    assert.deepEqual(D.MAPS.map((m) => m.mid),
      [2, 6, 10, 14, 18, 21, 24, 28, 32, 36, 40, 43, 46, 50, 54, 58, 62, 65, 68, 72, 76, 80, 84, 87, 90, 94, 98]);
  });

  test("mob traits exist in the trait catalogue; trait params present", () => {
    for (const mob of [...D.MOBS, ...D.ADDS]) {
      for (const t of mob.traits) assert.ok(D.TRAITS[t], `${mob.id}: trait ${t}`);
      if (mob.traits.includes("swarm")) assert.ok(mob.swarm >= 2, `${mob.id} swarm size`);
      assert.ok(D.MOB_GLYPHS[mob.id] !== undefined, `${mob.id} glyph`);
    }
  });

  test("bosses: keepsakes, adds and parts resolve", () => {
    D.BOSSES.forEach((b, i) => {
      const k = D.KEEPSAKE_BY_ID[b.keepsake];
      assert.ok(k, `${b.id} keepsake`);
      assert.equal(k.boss, i);
      assert.equal(D.ZONES[b.zone].boss, i);
      for (const mech of b.mechanics) if (mech.add) assert.ok(D.MOB_BY_ID[mech.add.id], `${b.id} add ${mech.add.name}`);
      if (b.badge) assert.ok(D.BADGE_BY_ID[b.badge], `${b.id} badge`);
    });
    for (const r of D.REVIEWS) if (r.onPhase) assert.ok(D.MOB_BY_ID[r.onPhase.add.id]);
    assert.equal(D.BOSS_PARTS.octopus_merge.length, 8);
    assert.equal(D.BOSS_PARTS.monolith.length, 6);
    for (const id of ["warning_mite", "nitpick", "holo_duck"]) assert.ok(D.MOB_BY_ID[id], id);
  });

  test("classes, careers and skills", () => {
    assert.deepEqual(D.CLASSES.map((c) => c.id), ["intern", "refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"]);
    assert.equal(D.SKILLS.byClass.intern.length, 2);
    for (const c of D.CLASSES.slice(1)) {
      const list = D.SKILLS.byClass[c.id];
      assert.equal(list.length, 7, c.id);
      assert.deepEqual(list.map((s) => s.slot), D.SKILL_SLOTS);
      for (const s of list) {
        assert.equal(s.unlock, D.SKILLS.slots[s.slotIdx].unlock);
        assert.equal(s.max, D.SKILLS.slots[s.slotIdx].max);
      }
      assert.ok(D.CLASS_COLORS[c.id]);
    }
    assert.deepEqual([...D.SKILLS.autoLearnTieOrder].sort(), [...D.SKILL_SLOTS].sort());
    const total = D.SKILLS.slots.reduce((n, s) => n + s.max, 0);
    assert.equal(total, 105); // D§6.4: 105 total skill ranks
    assert.deepEqual(D.WEAPON_TYPES, ["blade", "knives", "pipe", "manpage", "duck"]);
  });

  test("items: affix slots, LTS slots, keepsake slots, base layout", () => {
    for (const a of D.AFFIXES) for (const s of a.slots) assert.ok(D.SLOTS.includes(s), `${a.id}: ${s}`);
    for (const p of D.LTS_PROPS) assert.ok(p.slot === "any" || D.SLOTS.includes(p.slot), p.id);
    for (const k of D.KEEPSAKES) assert.ok(D.SLOTS.includes(k.slot), k.id);
    assert.equal(D.BASE_LIST.length, 51);
    assert.equal(D.BASE_LIST[0].name, "Training Stick");
    assert.equal(D.BASE_LIST[1].name, "Rusty Rename Blade");
    assert.equal(D.BASE_LIST[25].name, "The Duck Who Knew");
    assert.equal(D.BASE_LIST[26].name, "Beanie");
    assert.equal(D.BASE_LIST[50].name, "Conference Badge");
    for (const b of D.BASE_LIST.slice(1)) assert.ok(b.tier >= 1 && b.tier <= 5);
    assert.equal(D.RARITIES.length, 6);
    assert.ok(D.RARITY_BY_ID[D.CHEST_TIERS[2].floor] && D.RARITY_BY_ID[D.CHEST_TIERS[3].floor]);
    for (const k of Object.keys(D.DROP_WEIGHTS.slots)) assert.ok(D.SLOTS.includes(k));
  });

  test("names, badges, palette", () => {
    assert.equal(D.NAMES.first.length, 64);
    assert.equal(D.NAMES.epithet.length, 64);
    assert.equal(D.PALETTE.termlingTint.length, 8);
    for (const v of Object.values(D.PALETTE).flat()) assert.match(v, /^#[0-9A-Fa-f]{6}$/);
    for (const z of [...D.ZONES, D.BACKLOG]) for (const v of Object.values(z.palette)) assert.match(v, /^#[0-9A-Fa-f]{6}$/);
    assert.equal(D.BADGES.length, 14);
    assert.ok(D.ZONE_BY_ID.backlog === D.BACKLOG);
  });
});

// ---------------------------------------------------------------------------------------------
// formulas.js
// ---------------------------------------------------------------------------------------------

describe("formulas: D§5.8 reference table", () => {
  // m | refHit | mobHP | mobATK | refHP | ref DR% | mobXP | gold
  const ROWS = [
    [1, 6.5, 14, 3, 63, 35, 5, 3], [5, 8.5, 26, 4, 88, 33, 11, 9], [10, 14.1, 50, 6, 136, 35, 24, 19],
    [12, 17.2, 64, 7, 161, 35, 30, 24], [20, 37.3, 163, 15, 314, 37, 73, 56], [23, 49.7, 227, 19, 402, 38, 97, 73],
    [30, 95.9, 479, 35, 713, 40, 184, 132], [34, 139, 725, 50, 987, 41, 260, 180], [40, 241, 1330, 83, 1602, 42, 427, 282],
    [45, 379, 2183, 127, 2390, 43, 636, 402], [50, 594, 3556, 193, 3558, 45, 938, 568], [56, 1014, 6326, 318, 5718, 46, 1479, 849],
    [60, 1444, 9242, 443, 7833, 47, 1992, 1103], [67, 2666, 17798, 790, 13548, 49, 3322, 1727],
    [70, 3462, 23500, 1011, 17116, 49, 4124, 2086], [78, 6916, 48934, 1950, 31835, 51, 7284, 3425],
    [80, 8213, 58687, 2296, 37155, 51, 8384, 3871], [89, 17724, 132028, 4782, 74276, 53, 15682, 6663],
    [90, 19297, 144376, 5186, 80198, 54, 16802, 7074], [100, 44954, 350644, 11660, 172241, 56, 33290, 12774],
  ];
  for (const [m, hit, hp, atk, rhp, dr, xp, gd] of ROWS) {
    test(`m = ${m}`, () => {
      close(F.refHit(m), hit, "refHit");
      close(F.mobHP(m), hp, "mobHP");
      close(F.mobATK(m), atk, "mobATK");
      close(F.refHP(m), rhp, "refHP");
      close(F.refDR(m) * 100, dr, "refDR%");
      close(F.mobXP(m), xp, "mobXP");
      close(F.gold(m), gd, "gold");
    });
  }
});

describe("formulas: D§6.3 K / Need table", () => {
  const ROWS = [
    [1, 30, 150, 1.9, 1.9], [2, 39, 234, 2.5, 4.5], [4, 60, 600, 3.9, 11.5], [9, 138, 2898, 8.9, 45],
    [11, 182, 4914, 11.7, 1.1 * 60], [19, 457, 30162, 29.5, 3.9 * 60], [29, 1069, 180661, 69, 12.1 * 60],
    [39, 2044, 805336, 132, 29 * 60], [49, 3439, 2988491, 222, 59 * 60], [59, 5307, 9817950, 342, 106 * 60],
    [69, 7693, 29525734, 496, 177 * 60], [79, 10639, 83143785, 686, 277 * 60], [89, 14185, 222449170, 915, 412 * 60],
    [99, 18367, 571287168, 1185, 588 * 60],
  ];
  for (const [L, k, nd, rawMin, pureMin] of ROWS) {
    test(`L = ${L}`, () => {
      close(F.K(L), k, "K");
      close(F.need(L), nd, "Need");
      const raw = F.K(L) / D.TUNING.refKillsPerMin;
      assert.ok(Math.abs(raw - rawMin) <= Math.max(0.1, rawMin * 0.01), `raw minutes ${raw}`);
      let pure = 0;
      for (let l = 1; l <= L; l++) pure += F.K(l) / D.TUNING.refKillsPerMin;
      assert.ok(Math.abs(pure - pureMin) / pureMin <= 0.05, `pure time ${pure} vs ${pureMin}`);
    });
  }
});

describe("formulas: bosses and reviews (D§9.6, D§4.5)", () => {
  test("boss HP solo/trio and swings", () => {
    const want = [[1024, 2560, 7], [6356, 15890, 25], [23200, 58000, 80], [52392, 130980, 203], [189780, 474450, 509],
      [569536, 1423840, null], [1565888, 3914720, 3120], [4224896, 10562240, 7651], [14025760, 35064400, 18656]];
    D.BOSSES.forEach((b, i) => {
      const dev = BALANCE_DEVIATIONS[`bosses.${i}.bk`];
      const bk = dev ? dev[0] : b.bk; // D§9.6's HP numbers are the design Bk's
      assert.equal(F.bossHP(bk, b.level, 1), want[i][0], `${b.id} solo`);
      assert.equal(F.bossHP(bk, b.level, 3), want[i][1], `${b.id} trio`);
      if (dev) assert.equal(F.bossHP(b.bk, b.level, 1), Math.round(want[i][0] * dev[1] / dev[0]), `${b.id} balance Bk`);
      if (want[i][2] != null) assert.equal(F.bossSwing(b.ak, b.level), want[i][2], `${b.id} swing`);
    });
    // Hydra bites: 0.6 x swing = 758 per head
    assert.equal(Math.round(0.6 * F.bossSwing(1.6, 67)), 758);
  });
  test("reviews", () => {
    assert.equal(20 * F.mobHP(30), 9580);
    assert.equal(Math.round(1.3 * F.mobATK(30)), 46);
    assert.equal(26 * F.mobHP(60), 240292);
    assert.equal(Math.round(2 * F.mobATK(60)), 886);
    // Nitpick: HP 9,242, swing 222 (the design rounds 0.5 x mobATK(60); mobStats rounds once: ±1)
    const nit = F.mobStats(D.MOB_BY_ID.nitpick, 60);
    assert.equal(nit.hp, 9242);
    close(nit.atk, 222, "nitpick swing");
  });
});

describe("formulas: mobs per zone (D§5.9)", () => {
  // [mobId, home level, HP, swing, XP]
  const ROWS = [
    ["typo_sprout", 2, 17, 3, 6], ["semicolon_snail", 6, 38, 6, 16], ["unused_import", 10, 80, 5, 34],
    ["callback_bat", 14, 66, 5, 34], ["promise_wisp", 18, 143, 13, 65], ["null_pointer_frog", 21, 182, 19, 88],
    ["capture_group_goblins", 24, 152, 15, 64], ["backslash_bandit", 28, 349, 33, 154], ["greedy_glob", 32, 767, 42, 285],
    ["diff_leech", 36, 800, 59, 276], ["rebase_wraith", 40, 1330, 100, 512], ["merge_conflict_golem", 43, 2869, 96, 869],
    ["left_pad_mites", 46, 1204, 83, 344], ["transitive_vine", 50, 3556, 193, 1126], ["version_pin_porcupine", 54, 6794, 269, 1654],
    ["race_condition_rats", 58, 4208, 188, 1030], ["spinlock_top", 62, 10041, 471, 2308], ["starved_thread", 65, 16251, 1206, 3449],
    ["todo_ghost", 68, 17576, 772, 3214], ["anonymous_author", 72, 25432, 1311, 4759], ["spaghetti_mummy", 76, 65240, 1324, 9488],
    ["flaky_test_phantom", 80, 52818, 2296, 9222], ["memory_leak_slime", 84, 84265, 3183, 13306], ["pager_wyvern", 87, 99329, 2845, 15023],
    ["off_by_one_twins", 90, 64969, 3112, 7561], ["bitflip_moth", 94, 185571, 7893, 22114], ["undefined_behavior", 98, 352681, 10911, 40681],
  ];
  // a documented balance change of a multiplier scales the D§5.9 number by the same ratio
  const ratio = (id, field) => {
    const i = D.MOBS.findIndex((x) => x.id === id);
    const dev = BALANCE_DEVIATIONS[`mobs.${i}.${field}`];
    return dev ? dev[1] / dev[0] : 1;
  };
  for (const [id, m, hp, atk, xp] of ROWS) {
    test(id, () => {
      const def = D.MOB_BY_ID[id];
      const s = F.mobStats(def, m);
      close(s.hp, hp, "HP");
      // the table at the design multiplier; a documented balance multiplier through the same formula
      close(ratio(id, "atk") === 1 ? s.atk : F.mobATK(m, def.atk / ratio(id, "atk")), atk, "swing");
      close(ratio(id, "xp") === 1 ? s.xp : F.mobXP(m, def.xp / ratio(id, "xp")), xp, "XP");
      assert.equal(s.atk, F.mobATK(m, def.atk));
      assert.equal(s.xp, F.mobXP(m, def.xp));
    });
  }
  test("elite and Backlog floor multipliers", () => {
    const base = F.mobStats({}, 20);
    const el = F.mobStats({}, 20, { elite: true });
    assert.equal(el.hp, F.mobHP(20, 3));
    assert.equal(el.atk, F.mobATK(20, 1.5));
    assert.equal(el.xp, F.mobXP(20, 4));
    assert.equal(el.gold, F.gold(20, 4));
    const f10 = F.mobStats({}, 100, { floor: 10 });
    assert.equal(f10.hp, F.mobHP(100, Math.pow(1.06, 10)));
    assert.ok(base.hp < el.hp);
  });
});

describe("formulas: curves", () => {
  test("g, gap and DR caps", () => {
    assert.equal(F.g(1), 1);
    assert.equal(F.g(0), 1);
    assert.ok(Math.abs(F.g(11) - Math.pow(1.07, 10)) < 1e-12);
    assert.equal(F.gap(0), 1);
    assert.equal(F.gap(2), 1);
    assert.ok(Math.abs(F.gap(3) - 0.9) < 1e-12);
    assert.ok(Math.abs(F.gap(-3) - 1.15) < 1e-12);
    assert.ok(Math.abs(F.gap(-9) - 1.25) < 1e-12);
    assert.ok(Math.abs(F.gap(11) - 0.1) < 1e-12);
    assert.ok(Math.abs(F.gap(50) - 0.03) < 1e-12, "balance: the floor is 0.03 (design 0.1), docs/BALANCE.md");
    assert.equal(F.DR(1e9, 1), 0.75);
    assert.equal(F.DR(10, 1, 0.9), 0.75);
    assert.equal(F.DR(0, 50), 0);
  });
  test("item math", () => {
    assert.deepEqual([1, 20, 21, 40, 41, 80, 81, 100, 150].map(F.itemTier), [1, 1, 2, 2, 3, 4, 5, 5, 5]);
    assert.equal(F.reqLevel(2), 1);
    assert.equal(F.reqLevel(30), 27);
    assert.equal(F.reqLevel(150), 100); // Backlog loot (iLvl 100 + f/2) stays wearable at the cap
    assert.equal(F.weaponDmg(1, 1, 0), 6);
    assert.ok(Math.abs(F.armorPiece(2, 1, 1, 0) - 6) < 1e-12);
    assert.equal(F.itemPower(50, 1.22, 7, 2), Math.round(10 * 50 * 1.22 * 1.35 * 1.16));
    // D§8.8: a Beta at iLvl 50 from +0 to +7 costs about 198k gold and 84 Snippets
    let goldSum = 0;
    let snip = 0;
    for (let p = 0; p < 7; p++) {
      const c = F.polishCost(50, p, 0);
      goldSum += c.gold;
      snip += c.snippets;
    }
    assert.ok(Math.abs(goldSum - 198000) / 198000 < 0.01, `polish gold ${goldSum}`);
    assert.equal(snip, 84);
    assert.ok(F.polishCost(50, 0, 5).gold < F.polishCost(50, 0, 0).gold);
    assert.deepEqual(F.deprecateYield(41, 2), { snippets: 24, gold: 2 * F.gold(41) });
    assert.deepEqual(F.deprecateYield(41, 5), { snippets: 0, gold: 0 });
  });
  test("economy curves (D§10)", () => {
    close(F.buildingCost(800, 10), 15.7e6, "campfire 10");
    close(F.buildingCost(1200, 10), 23.6e6, "forge 10");
    close(F.buildingCost(1000, 10), 19.7e6, "vendor 10");
    close(F.buildingCost(1500, 10), 29.5e6, "docs 10");
    close(F.buildingCost(D.BUILDING_BY_ID.war_room, 5), 243e3, "war room 5");
    const milestones = { 1: 8, 10: 179, 20: 457, 30: 789, 40: 1164, 50: 1573, 60: 2012 };
    for (const [r, s] of Object.entries(milestones)) assert.equal(F.releaseSeals(Number(r)), s, `release ${r}`);
    assert.equal(F.releaseOf(178), 9);
    assert.equal(F.releaseOf(179), 10);
    assert.equal(F.releaseLabel(17), "v1.7");
    assert.deepEqual([0, 499, 500, 4999, 5000, 50000].map(F.trackerTier), [0, 0, 1, 1, 2, 3]);
  });
  test("seals, shift, fresh eyes, crowding, party", () => {
    assert.equal(F.rawSeals(1.4), 0);
    assert.equal(F.rawSeals(15), 1.5);
    assert.equal(F.rawSeals(500), 12);
    assert.deepEqual([0.5, 1, 2.99, 3, 5.99, 6, 12].map((s) => F.chestTierOf(s).id),
      ["wooden", "iron", "iron", "silver", "silver", "gold", "gold"]);
    assert.deepEqual([0, 239, 240, 479, 480].map(F.shiftKillMult), [1, 1, 0.5, 0.5, 0.25]);
    assert.deepEqual([0, 240, 480].map(F.shiftSealMult), [1, 0.75, 0.5]);
    assert.equal(F.freshEyesCap(10), 210);
    assert.equal(F.crowding(12), 1);
    assert.equal(F.crowding(24), 0.5);
    assert.ok(Math.abs(F.partyXp(5) - 0.18) < 1e-12);
    assert.ok(Math.abs(F.partyXp(2) - 0.12) < 1e-12);
    assert.equal(F.killXP({ m: 10, L: 10 }), F.mobXP(10));
    assert.equal(F.killXP({ m: 10, L: 10, elite: true, freshEyes: true }), F.mobXP(10) * 4 * 1.5);
    // balance: first kill / review 0.1 Need(L), repeat 0.02 (design 0.5 / 0.1), docs/BALANCE.md
    assert.equal(F.bossXP(20, true), D.TUNING.boss.xpFirst * F.need(20));
    assert.equal(F.bossXP(20, false), D.TUNING.boss.xpRepeat * F.need(20));
    assert.ok(D.TUNING.boss.xpFirst <= 0.5 && D.TUNING.boss.xpRepeat < D.TUNING.boss.xpFirst);
  });
  test("power level clamps to L-5..L+8", () => {
    assert.equal(F.powerLevel(30, F.refDPS(30)), 30);
    assert.equal(F.powerLevel(30, F.refDPS(30) * 1.07 * 1.07), 32);
    assert.equal(F.powerLevel(30, 1), 25);
    assert.equal(F.powerLevel(30, 1e12), 38);
  });
});

describe("formulas: formatting (D§11.7)", () => {
  test("fmtNum", () => {
    const cases = [[0, "0"], [7, "7"], [999, "999"], [999.4, "999"], [1000, "1.0k"], [1234, "1.2k"], [12345, "12.3k"],
      [99999, "99.9k"], [100000, "100k"], [999999, "999k"], [1e6, "1.00M"], [1234567, "1.23M"], [12345678, "12.3M"],
      [123456789, "123M"], [1.5e9, "1.50B"], [12.34e9, "12.3B"], [123e9, "123B"], [4321e9, "4321B"], [-1234, "-1.2k"]];
    for (const [n, s] of cases) assert.equal(F.fmtNum(n), s, String(n));
  });
  test("fmtDuration (seconds)", () => {
    assert.equal(F.fmtDuration(45), "45s");
    assert.equal(F.fmtDuration(120), "2m");
    assert.equal(F.fmtDuration(3599), "59m");
    assert.equal(F.fmtDuration(3900), "1h 05m");
    assert.equal(F.fmtDuration(3900, { capHour: true }), "1h+");
    assert.equal(F.fmtDuration(130, { capHour: true }), "2m");
    assert.equal(F.fmtDuration(27 * 3600), "1d 03h");
  });
});

// ---------------------------------------------------------------------------------------------
// rng.js
// ---------------------------------------------------------------------------------------------

describe("formulas: text that goes to herdr", () => {
  // herdr turns every text into UTF-8 (rquickjs from_utf8), which rejects a lone surrogate
  test("cutText never keeps half of a surrogate pair", () => {
    const rocket = "\u{1F680}";
    assert.equal(F.cutText("abcdef", 4), "abcd");
    assert.equal(F.cutText("abc", 4), "abc");
    assert.equal(F.cutText(null, 4), "");
    assert.equal(F.cutText(`abc${rocket}`, 4), "abc", "the pair straddles the cut: dropped whole");
    assert.equal(F.cutText(`ab${rocket}c`, 4), `ab${rocket}`, "a pair that ends at the cut stays");
    assert.equal(F.cutText(`${rocket}${rocket}${rocket}`, 5), `${rocket}${rocket}`);
    for (let n = 1; n < 12; n++) {
      const t = F.cutText(`x${rocket.repeat(6)}`, n);
      assert.ok(t.isWellFormed() && t.length <= n && t.length >= n - 1, `n = ${n}`);
    }
  });

  test("wellFormed replaces (or drops) lone surrogates and keeps pairs", () => {
    assert.equal(F.wellFormed("plain"), "plain");
    assert.equal(F.wellFormed("ship \u{1F680} it"), "ship \u{1F680} it");
    assert.equal(F.wellFormed("a\ud83db"), "a\ufffdb");
    assert.equal(F.wellFormed("a\ude80b"), "a\ufffdb", "a lone low surrogate too");
    assert.equal(F.wellFormed("now \ud83d", ""), "now ");
    assert.equal(F.wellFormed("\ude80\ud83d\ude80\ud83d"), "\ufffd\u{1F680}\ufffd");
    assert.equal(F.wellFormed(undefined), "");
  });
});

describe("rng", () => {
  test("xorshift32 matches Marsaglia's sequence", () => {
    assert.equal(R.xs32(2463534242), 723471715);
    assert.notEqual(R.xs32(0), 0);
  });
  test("fnv1a32 known vectors", () => {
    assert.equal(R.fnv1a32(""), 0x811c9dc5);
    assert.equal(R.fnv1a32("a"), 0xe40c292c);
    assert.equal(R.fnv1a32("foobar"), 0xbf9cf968);
    assert.equal(R.hashKey("foobar"), R.fnv1a32("foobar"));
    assert.equal(R.fnv1a32("é"), R.fnv1a32("é")); // UTF-8 bytes C3 A9
    assert.notEqual(R.fnv1a32("é"), R.fnv1a32("Ã©"));
  });
  test("helpers stay in range and are deterministic", () => {
    const a = { rng: 42 };
    const b = { rng: 42 };
    for (let i = 0; i < 2000; i++) {
      const x = R.rngNext(a);
      assert.ok(x >= 0 && x < 1);
      assert.equal(x, R.rngNext(b));
      const n = R.rngInt(a, 3, 5);
      R.rngInt(b, 3, 5);
      assert.ok(n >= 3 && n <= 5 && Number.isInteger(n));
    }
  });
  test("rngPick honours weights and skips zero weights", () => {
    const h = { rng: 7 };
    const counts = [0, 0, 0];
    for (let i = 0; i < 20000; i++) counts[R.rngPick(h, [1, 0, 3])]++;
    assert.equal(counts[1], 0);
    assert.ok(Math.abs(counts[2] / counts[0] - 3) < 0.3, String(counts));
    const keys = {};
    for (let i = 0; i < 1000; i++) {
      const k = R.rngPick(h, { a: 1, b: 1 });
      keys[k] = (keys[k] || 0) + 1;
    }
    assert.deepEqual(Object.keys(keys).sort(), ["a", "b"]);
    assert.equal(R.rngPick(h, [0, 0]), 0);
  });
});
