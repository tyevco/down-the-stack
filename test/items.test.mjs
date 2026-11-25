// Items: rolling for every source, affix rules, naming, IP, stats, equip score, stash rules,
// deprecate, polish (+ port), Squash Merge, Reroll.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as D from "../mods/down-the-stack/game/data.js";
import * as F from "../mods/down-the-stack/game/formulas.js";
import * as H from "../mods/down-the-stack/game/heroes.js";
import * as I from "../mods/down-the-stack/game/items.js";
import { newState } from "../mods/down-the-stack/game/save.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const A = D.AFFIX_IDX;

function world(heroes = []) {
  const state = newState({ seed: 77 });
  for (const [cls, L] of heroes) {
    const h = H.newHero(state, { seat: "repo/agent", ord: state.heroes.length });
    h.cls = D.CLASS_IDX[cls];
    h.L = L;
    state.heroes.push(h);
  }
  return state;
}

function mkItem(state, slot, ilvl, rar = 0, extra = {}) {
  return I.newItem(state, { base: I.baseIdFor(slot, F.itemTier(ilvl), extra.type ?? slot), ilvl, rar, ...extra });
}

describe("rollItem: shape and affix rules", () => {
  test("every source, slot pools, no duplicates, counts, rolls", () => {
    const state = world();
    const holder = { rng: 12345 };
    const sources = ["kill", "elite", "chest", "duck", "boss", "review"];
    for (let i = 0; i < 3000; i++) {
      const source = sources[i % sources.length];
      const it = I.rollItem(holder, { ilvl: 1 + (i % 110), source, classId: i % 6, itemFind: (i % 4) * 0.5, first: i % 2 === 0, state });
      const b = D.BASE_LIST[it.base];
      const slot = b.slot;
      assert.ok(b, "base exists");
      if (b.n !== 0) assert.equal(b.tier, F.itemTier(it.ilvl), "base tier follows ilvl");
      assert.ok(it.rar >= 0 && it.rar <= 4);
      const want = D.RARITIES[it.rar].affixes + (slot === "sticker" ? 1 : 0);
      assert.equal(it.aff.length, want, `affix count ${D.RARITIES[it.rar].id} ${slot}`);
      const ids = it.aff.map((a) => a[0]);
      assert.equal(new Set(ids).size, ids.length, "no duplicate affix");
      for (const [a, roll] of it.aff) {
        assert.ok(D.AFFIXES[a].slots.includes(slot), `${D.AFFIXES[a].id} not allowed on ${slot}`);
        assert.ok(Number.isInteger(roll) && roll >= 0 && roll <= 99);
      }
      if (it.rar === 4) assert.ok(["any", slot].includes(D.LTS_PROPS[it.prop].slot), "LTS property slot");
      else assert.equal(it.prop, -1);
      assert.equal(it.flags, I.FLAG_NEW);
      assert.equal(it.pol, 0);
      if (source === "review") assert.equal(it.rar, 3);
      if (source === "duck") assert.ok(it.rar >= 2);
      if (source === "boss") assert.ok(it.rar >= (i % 2 === 0 ? 3 : 2));
    }
    assert.equal(state.herd.nextUid, 3001);
  });

  test("uids: from state, from a herd holder, else 0", () => {
    const state = world();
    assert.equal(I.rollItem({ rng: 1 }, { ilvl: 5, source: "kill", state }).uid, 1);
    assert.equal(I.rollItem(state.herd, { ilvl: 5, source: "kill" }).uid, 2);
    assert.equal(I.rollItem({ rng: 1 }, { ilvl: 5, source: "kill" }).uid, 0);
  });

  test("deterministic for the same RNG state", () => {
    const a = I.rollItem({ rng: 999 }, { ilvl: 40, source: "chest", classId: "hotfixer" });
    const b = I.rollItem({ rng: 999 }, { ilvl: 40, source: "chest", classId: "hotfixer" });
    assert.deepEqual(a, b);
  });

  test("kill rarity weights, item find and elites", () => {
    const h = { rng: 4242 };
    const n = 40000;
    const count = (opts) => {
      const c = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) c[I.rollItem(h, { ilvl: 10, source: "kill", ...opts }).rar]++;
      return c.map((x) => x / n);
    };
    const base = count({});
    assert.ok(Math.abs(base[0] - 0.64) < 0.015, `prototype ${base[0]}`);
    assert.ok(Math.abs(base[2] - 0.08) < 0.01, `beta ${base[2]}`);
    const found = count({ itemFind: 5 }); // capped at +150%
    assert.ok(Math.abs(found[2] / found[0] - (8 * 2.5) / 64) < 0.04, "item find x2.5 on Beta");
    const elite = count({ source: "elite" });
    assert.ok(elite[2] > base[2] * 1.6, "elites double Beta+");
    assert.equal(elite[5], 0);
  });

  test("slot odds and class weapons (70% own class; Interns get the stick)", () => {
    const h = { rng: 31337 };
    const n = 20000;
    let weapons = 0;
    let own = 0;
    let sticks = 0;
    for (let i = 0; i < n; i++) {
      const it = I.rollItem(h, { ilvl: 30, source: "kill", classId: "refactorer" });
      const b = D.BASE_LIST[it.base];
      if (b.slot === "weapon") {
        weapons++;
        if (b.type === "blade") own++;
      }
      const it2 = I.rollItem(h, { ilvl: 5, source: "kill", classId: "intern", slot: "weapon" });
      if (it2.base === 0) sticks++;
    }
    assert.ok(Math.abs(weapons / n - 20 / 100) < 0.015, `weapon share ${weapons / n}`);
    assert.ok(Math.abs(own / weapons - 0.7) < 0.03, `own class ${own / weapons}`);
    assert.ok(Math.abs(sticks / n - 0.7) < 0.02, `sticks ${sticks / n}`);
    const rev = I.rollItem(h, { ilvl: 30, source: "review", classId: "hotfixer", slot: "weapon" });
    assert.equal(D.BASE_LIST[rev.base].type, "knives");
    assert.equal(rev.rar, 3);
  });

  test("chest tiers: Silver guarantees Alpha+, Gold Beta+; unreviewed halves", () => {
    for (let s = 0; s < 300; s++) {
      const h = { rng: 1000 + s };
      const silver = I.rollChest(h, { raw: 3.5, mapTop: 20 });
      assert.ok(silver.length === 3 || silver.length === 4);
      assert.ok(silver.some((x) => x.rar >= 1));
      const gold = I.rollChest(h, { raw: 7, mapTop: 20 });
      assert.equal(gold.length, 7);
      assert.ok(gold.some((x) => x.rar >= 2));
      // map top + U{0,1,2}, lowered by the balance offset (T.loot.ilvlOffset at level 20)
      const off = I.lootOffset(20);
      for (const it of gold) assert.ok(it.ilvl >= 20 + off && it.ilvl <= 22 + off, `${it.ilvl}`);
      assert.equal(I.rollChest(h, { raw: 7, mapTop: 20, unreviewed: true }).length, 3);
    }
  });

  test("keepsakes: fixed slot and property, class-adaptive weapon", () => {
    for (let b = 0; b < 9; b++) {
      const k = I.rollKeepsake({ rng: 5 + b }, { bossIdx: b, ilvl: D.BOSSES[b].level, classId: "hotfixer" });
      assert.equal(k.rar, 5);
      assert.equal(D.KEEPSAKES[k.prop].boss, b);
      assert.equal(I.slotOf(k), D.KEEPSAKES[k.prop].slot);
      assert.equal(k.aff.length, 3 + (I.slotOf(k) === "sticker" ? 1 : 0));
      assert.equal(I.itemName(k), D.KEEPSAKES[k.prop].name);
    }
    const fang = I.rollKeepsake({ rng: 1 }, { bossIdx: 5, ilvl: 67, classId: "hotfixer" });
    const state = world([["refactorer", 70]]);
    assert.equal(I.canEquip(state.heroes[0], fang), true);
  });
});

describe("item numbers and names (D§8.3, D§8.7)", () => {
  test("affix values: (lo + (hi - lo) roll / 99) t, 0.1 pp", () => {
    // balance: the offensive / economy ranges are halved (Memoized 1-2%, Async 0.25-0.5%), the
    // defensive ones keep D§8.3 (Idempotence 1-2%): docs/BALANCE.md
    assert.equal(I.affixValue(A.memo, 0, 1), 0.01);
    assert.equal(I.affixValue(A.memo, 99, 1), 0.02);
    assert.equal(I.affixValue(A.memo, 49, 3), 0.045); // 4.48% -> 4.5%
    assert.equal(I.affixValue(A.idem, 99, 2), -0.04);
    assert.equal(I.affixValue(A.async, 50, 5), 0.019); // 1.88% -> 1.9%
  });

  test("itemStats", () => {
    const state = world();
    const w = mkItem(state, "weapon", 50, 2, { type: "pipe", pol: 3, aff: [[A.memo, 99], [A.vec, 0]] });
    const s = I.itemStats(w);
    assert.ok(near(s.weaponDmg, 6 * F.g(50) * 1.22 * 1.15));
    assert.equal(s.armor, 0);
    assert.deepEqual(s.affixes, { memo: 0.06, vec: 0.045 });
    assert.deepEqual(s.stats, { dmg: 0.06, areaDmg: 0.045 });
    const mug = I.itemStats(mkItem(state, "mug", 45, 0));
    assert.ok(near(mug.armor, 3 * 0.8 * F.g(45)));
    assert.ok(near(mug.coffeeHeal, 0.06));
    const lts = I.itemStats(mkItem(state, "hoodie", 30, 4, { prop: D.LTS_IDX.pockets }));
    assert.deepEqual(lts.prop, { kind: "lts", id: "pockets", name: "Infinite-Pocket", effect: { itemFind: 0.2 } });
  });

  test("Item Power", () => {
    const state = world();
    const it = mkItem(state, "hat", 50, 2, { pol: 7, aff: [[A.memo, 1], [A.green, 2]] });
    assert.equal(I.itemIP(it), Math.round(10 * 50 * 1.22 * 1.35 * 1.16));
  });

  test("names", () => {
    const state = world();
    const w = (rar, aff, extra = {}) => I.itemName(mkItem(state, "weapon", 10, rar, { type: "pipe", aff, ...extra }));
    assert.equal(w(0, []), "Pipe Wand");
    assert.equal(w(1, [[A.memo, 5]]), "Memoized Pipe Wand");
    assert.equal(w(1, [[A.cache, 5]]), "Pipe Wand of Caching");
    assert.equal(w(2, [[A.vec, 5], [A.grace, 9]]), "Vectorized Pipe Wand of Graceful Degradation");
    assert.equal(w(3, [[A.grace, 5], [A.memo, 50], [A.blame, 90]]), "Memoized Pipe Wand of Graceful Degradation");
    assert.equal(w(3, [[A.memo, 10], [A.blame, 90], [A.opt, 40]]), "Blameless Pipe Wand"); // strongest prefix
    assert.equal(w(2, [[A.memo, 10], [A.vec, 50]], { pol: 4 }), "Vectorized Pipe Wand +4");
    assert.equal(I.itemName(mkItem(state, "hoodie", 30, 4, { prop: D.LTS_IDX.flag, aff: [[A.typed, 1]] })), "Feature-Flagged Zip Hoodie");
    assert.equal(I.itemName(mkItem(state, "hat", 12, 5, { prop: 0, pol: 2 })), "Hazard Cone Hat +2");
    assert.equal(I.itemName(mkItem(state, "weapon", 3, 0, { type: "stick" })), "Training Stick");
  });

  test("names: a base that already ends in 'of ...' takes no suffix (never 'Treads of Uptime of Caching')", () => {
    const state = world();
    const it = (slot, ilvl, rar, aff, extra = {}) => I.itemName(mkItem(state, slot, ilvl, rar, { aff, ...extra }));
    // the D§14.7 bases with "of": tier-5 hat, hoodie, boots and pipe, the tier-3 duck
    assert.equal(it("boots", 90, 1, [[A.cache, 5]]), "Treads of Uptime", "an Alpha whose one affix is a suffix: the plain base");
    assert.equal(it("boots", 90, 2, [[A.typed, 5], [A.cache, 5]]), "Typed Treads of Uptime");
    assert.equal(it("hoodie", 90, 3, [[A.idem, 5], [A.uptime, 9]]), "Parka of Prod", "suffixes only: the plain base");
    assert.equal(it("hat", 90, 3, [[A.memo, 10], [A.blame, 90], [A.hot, 40]]), "Blameless Crown of Inbox Zero", "the strongest prefix");
    assert.equal(it("weapon", 90, 2, [[A.vec, 5], [A.grace, 9]], { type: "pipe" }), "Vectorized Staff of Pure Functions");
    assert.equal(it("weapon", 50, 1, [[A.grace, 9]], { type: "duck" }), "Duck of Insight");
    assert.equal(it("weapon", 90, 1, [[A.memo, 9]], { type: "pipe", pol: 3 }), "Memoized Staff of Pure Functions +3");
    // other bases keep their suffix
    assert.equal(it("boots", 70, 2, [[A.typed, 5], [A.cache, 5]]), "Typed Commute Boots of Caching");
    for (const b of D.BASE_LIST) {
      if (!b || !/ of /.test(b.name)) continue;
      for (const a of D.AFFIXES) {
        if (a.kind !== "suffix") continue;
        const n = I.itemName({ uid: 1, base: b.n, ilvl: 90, rar: 2, pol: 0, aff: [[A[a.id], 50]], flags: 0, prop: -1 });
        assert.equal((n.match(/ of /g) || []).length, 1, n);
      }
    }
  });

  test("canEquip: level, class weapons, stick, armor", () => {
    const state = world([["hotfixer", 20], ["intern", 5]]);
    const [hot, intern] = state.heroes;
    assert.equal(I.canEquip(hot, mkItem(state, "weapon", 23, 0, { type: "knives" })), true);
    assert.equal(I.canEquip(hot, mkItem(state, "weapon", 24, 0, { type: "knives" })), false); // req 21
    assert.equal(I.canEquip(hot, mkItem(state, "weapon", 20, 0, { type: "blade" })), false);
    assert.equal(I.canEquip(hot, mkItem(state, "weapon", 20, 0, { type: "stick" })), true);
    assert.equal(I.canEquip(intern, mkItem(state, "weapon", 5, 0, { type: "pipe" })), false);
    assert.equal(I.canEquip(intern, mkItem(state, "boots", 5, 0)), true);
    assert.equal(I.canEquip(intern, mkItem(state, "boots", 50, 0), { ignoreLevel: true }), true);
  });
});

describe("autopilot equip (D§8.7)", () => {
  test("equips exactly when score >= +2%", () => {
    const state = world([["refactorer", 30]]);
    const h = state.heroes[0];
    h.sp = H.autoRanks("refactorer", 30);
    h.rev = [1, 0];
    h.eq[0] = mkItem(state, "weapon", 28, 1, { type: "blade" });
    let yes = 0;
    let no = 0;
    for (let i = 20; i <= 33; i++) {
      for (const pol of [0, 1, 2]) {
        const cand = mkItem(state, "weapon", i, 1, { type: "blade", pol });
        const score = I.scoreDelta(h, cand, 0, { herd: state.herd });
        const before = h.eq[0];
        const r = I.autoEquip(state, h, cand, { herd: state.herd });
        assert.equal(r.equipped, score >= 0.02, `ilvl ${i} +${pol}: score ${score}`);
        if (r.equipped) {
          yes++;
          assert.equal(r.replaced, before);
          assert.equal(h.eq[0], cand);
        } else no++;
      }
    }
    assert.ok(yes > 0 && no > 0);
  });

  test("a usable item fills an empty slot; locked gear is never replaced; class mismatch refused", () => {
    const state = world([["shellmancer", 20]]);
    const h = state.heroes[0];
    const sticker = mkItem(state, "sticker", 18, 0, { aff: [[A.green, 50]] });
    assert.equal(I.autoEquip(state, h, sticker).equipped, true);
    h.eq[1] = mkItem(state, "hat", 2, 0, { flags: I.FLAG_LOCKED });
    assert.equal(I.autoEquip(state, h, mkItem(state, "hat", 20, 3)).equipped, false);
    assert.equal(I.autoEquip(state, h, mkItem(state, "weapon", 20, 3, { type: "blade" })).equipped, false);
  });

  test("port polish: floor(old / 2) moves, capped at the new max; the old item goes to the stash", () => {
    const state = world([["refactorer", 40]]);
    const h = state.heroes[0];
    const old = mkItem(state, "hoodie", 30, 2, { pol: 7 });
    h.eq[2] = old;
    const neu = mkItem(state, "hoodie", 38, 0, { pol: 1 });
    const r = I.equipItem(state, h, neu);
    assert.equal(r.ported, 2); // floor(7/2) = 3, but a Prototype maxes at +3
    assert.equal(neu.pol, 3);
    assert.equal(old.pol, 5);
    assert.equal(state.herd.stash[0], old);
    assert.equal(neu.flags & I.FLAG_NEW, 0);
    // equipping from the stash removes it from the stash
    const r2 = I.equipItem(state, h, old);
    assert.equal(r2.ok, true);
    assert.equal(state.herd.stash.includes(old), false);
    assert.equal(state.herd.stash.includes(neu), true);
  });

  test("equipping an item worn by another hero moves it (never two owners)", () => {
    const state = world([["refactorer", 40], ["shellmancer", 40]]);
    const [a, b] = state.heroes;
    const hat = mkItem(state, "hat", 30, 1);
    I.equipItem(state, a, hat);
    assert.equal(I.equipItem(state, b, hat).ok, true);
    assert.equal(a.eq[1], null);
    assert.equal(b.eq[1], hat);
  });

  test("equipItem never replaces a locked item, nor takes a locked one off another hero (D§8.7)", () => {
    const state = world([["refactorer", 40], ["shellmancer", 40]]);
    const [a, b] = state.heroes;
    const locked = mkItem(state, "hat", 30, 2, { flags: I.FLAG_LOCKED });
    a.eq[1] = locked;
    const beanie = mkItem(state, "hat", 5, 0);
    state.herd.stash.push(beanie);
    const r = I.equipItem(state, a, beanie);
    assert.equal(r.ok, false);
    assert.match(r.error, /is locked: unlock it first/);
    assert.equal(a.eq[1], locked);
    assert.ok(state.herd.stash.includes(beanie), "nothing moved");
    const r2 = I.equipItem(state, b, locked);
    assert.equal(r2.ok, false);
    assert.match(r2.error, /locked/);
    assert.equal(a.eq[1], locked);
    // unlocked, both work
    locked.flags &= ~I.FLAG_LOCKED;
    assert.equal(I.equipItem(state, b, locked).ok, true);
    assert.equal(a.eq[1], null);
    // a locked item from the stash can be worn (the lock keeps it, it does not pin it to the stash)
    const pin = mkItem(state, "sticker", 20, 1, { flags: I.FLAG_LOCKED });
    state.herd.stash.push(pin);
    assert.equal(I.equipItem(state, a, pin).ok, true);
  });

  test("repairItem applies the save codec's fallbacks to an item from another content generation", () => {
    const bad = { uid: 9, base: 4242, ilvl: 0, rar: 9, pol: -2, aff: [[77, 50], [A.memo, 140], [A.memo, 3], "x"], flags: 0, prop: 99 };
    assert.equal(I.repairItem(bad), true);
    assert.deepEqual(bad, { uid: 9, base: 0, ilvl: 1, rar: 4, pol: 0, aff: [[0, 50]], flags: 0, prop: 1 });
    assert.doesNotThrow(() => I.itemName(bad));
    const lts = { uid: 10, base: 3, ilvl: 20, rar: 4, pol: 0, aff: [], flags: 0, prop: 99 };
    I.repairItem(lts);
    assert.equal(lts.prop, 1);
    const ok = { uid: 11, base: 3, ilvl: 20, rar: 2, pol: 1, aff: [[A.memo, 10]], flags: 2, prop: -1 };
    const aff = ok.aff;
    assert.equal(I.repairItem(ok), false);
    assert.equal(ok.aff, aff, "a valid item is untouched (same aff array)");
  });

  test("offerItem: finder first, then the roster, else the stash", () => {
    const state = world([["hotfixer", 20], ["refactorer", 20]]);
    const [hot, ref] = state.heroes;
    const blade = mkItem(state, "weapon", 20, 2, { type: "blade" });
    const r = I.offerItem(state, hot, blade, { herd: state.herd });
    assert.equal(r.heroId, ref.id);
    const hat = mkItem(state, "hat", 20, 1);
    assert.equal(I.offerItem(state, hot, hat).heroId, hot.id);
    // a Contractor (not in the roster) never keeps gear: it goes to roster heroes instead
    const contractor = { ...hot, id: 999, eq: [null, null, null, null, null, null] };
    assert.equal(I.offerItem(state, contractor, mkItem(state, "boots", 20, 1)).heroId, hot.id);
    const duckBeta = mkItem(state, "weapon", 20, 2, { type: "duck" });
    const s = I.offerItem(state, hot, duckBeta);
    assert.deepEqual([s.heroId, s.kept], [null, true]);
    assert.ok(state.herd.stash.includes(duckBeta));
  });
});

describe("stash, deprecate (D§8.8)", () => {
  test("auto-deprecate: Prototype/Alpha nobody wants goes at once; Beta+ is kept", () => {
    const state = world([["hotfixer", 30]]);
    const h = state.heroes[0];
    h.eq[1] = mkItem(state, "hat", 30, 3);
    const junk = mkItem(state, "hat", 5, 0);
    const r = I.stashAdd(state, junk);
    assert.deepEqual([r.kept, r.deprecated], [false, junk]);
    assert.equal(state.herd.snip, 2);
    assert.equal(state.herd.gold, 2 * F.gold(5));
    assert.equal(I.stashAdd(state, mkItem(state, "hat", 5, 2)).kept, true);
    // an Alpha weapon of a class nobody plays: deprecated; with auto-deprecate off: kept
    assert.equal(I.stashAdd(state, mkItem(state, "weapon", 5, 1, { type: "duck" })).kept, false);
    state.herd.cfg.auto.deprecate = false;
    assert.equal(I.stashAdd(state, mkItem(state, "weapon", 5, 1, { type: "duck" })).kept, true);
  });

  test("full stash: lowest-IP unlocked non-Keepsake item is deprecated", () => {
    const state = world();
    const cap = I.stashCap(state);
    assert.equal(cap, 40);
    state.herd.bld[D.BUILDING_IDX.vendor] = 10;
    assert.equal(I.stashCap(state), 140);
    state.herd.bld[D.BUILDING_IDX.vendor] = 0;
    const low = mkItem(state, "boots", 3, 0, { flags: I.FLAG_LOCKED });
    const keep = mkItem(state, "hat", 2, 5, { prop: 0 });
    state.herd.stash.push(low, keep);
    for (let i = 0; i < 38; i++) state.herd.stash.push(mkItem(state, "mug", 20 + i, 2));
    const victim = state.herd.stash[2]; // lowest unlocked non-Keepsake IP
    const r = I.stashPut(state, mkItem(state, "mug", 60, 2));
    assert.deepEqual([r.kept, r.deprecated], [true, victim]);
    assert.equal(state.herd.stash.length, 40);
    assert.ok(state.herd.stash.includes(low) && state.herd.stash.includes(keep));
    assert.match(state.herd.log.at(-1)[3], /Stash full/);
    // a new item that is itself the lowest goes instead
    const tiny = mkItem(state, "mug", 1, 0);
    assert.deepEqual(I.stashPut(state, tiny), { kept: false, deprecated: tiny });
  });

  test("deprecate yields, locks and Keepsakes", () => {
    const state = world();
    const it = mkItem(state, "boots", 45, 3);
    const locked = mkItem(state, "boots", 45, 3, { flags: I.FLAG_LOCKED });
    const ks = mkItem(state, "hat", 12, 5, { prop: 0 });
    state.herd.stash.push(it, locked, ks);
    assert.deepEqual(I.deprecate(state, it.uid), { ok: true, snippets: 20 * 3, gold: 2 * F.gold(45) });
    assert.equal(I.deprecate(state, locked.uid).ok, false);
    assert.equal(I.deprecate(state, ks.uid).ok, false);
    assert.equal(I.deprecate(state, 99999).ok, false);
    assert.equal(I.setLocked(state, locked.uid, false).ok, true);
    assert.equal(I.deprecate(state, locked.uid).ok, true);
  });
});

describe("drop helpers", () => {
  test("kill drop chance, review rewards", () => {
    assert.ok(Math.abs(I.killDropChance({}) - 0.004) < 1e-12);
    assert.ok(Math.abs(I.killDropChance({ itemFind: 9, shiftKill: 0.5 }) - 0.004 * 2.5 * 0.5) < 1e-12);
    assert.equal(I.killDropChance({ elite: true }), 0.2);
    const state = world();
    const senior = I.rollReviewReward({ rng: 3 }, { reviewIdx: 0, L: 30, classId: "forkbinder", state });
    assert.deepEqual([I.slotOf(senior), D.BASE_LIST[senior.base].type, senior.rar, senior.ilvl], ["weapon", "manpage", 3, 30]);
    const staff = I.rollReviewReward({ rng: 3 }, { reviewIdx: 1, L: 60, classId: "forkbinder", state });
    assert.deepEqual([I.slotOf(staff), staff.rar, staff.aff.length], ["sticker", 3, 4]);
  });
});

describe("hat tints (round 4b)", () => {
  test("hatToneOf: uid mod 6 as the stage has drawn saved hats; a Contractor's negative uid has one too", () => {
    const n = D.PALETTE.hatTint.length;
    assert.equal(n, 6);
    for (let uid = 0; uid <= 60; uid++) assert.equal(I.hatToneOf(uid), uid % n, `uid ${uid}`);
    for (let uid = -60; uid < 0; uid++) {
      const t = I.hatToneOf(uid);
      assert.ok(Number.isInteger(t) && t >= 0 && t < n, `uid ${uid}: ${t}`);
      assert.equal((t - uid) % n, 0, "the same class mod 6");
    }
    assert.equal(I.hatToneOf(undefined), 0);
  });

  test("skipUidsToTone: the next uid has the tone, at most 5 uids skipped; nothing skipped when it already has it", () => {
    for (let start = 1; start <= 12; start++) {
      for (let tone = 0; tone < 6; tone++) {
        const state = newState({ seed: 1 });
        state.herd.nextUid = start;
        I.skipUidsToTone(state, tone);
        const uid = I.allocUid(state);
        assert.equal(I.hatToneOf(uid), tone);
        assert.ok(uid >= start && uid - start <= 5);
        if (I.hatToneOf(start) === tone) assert.equal(uid, start);
      }
    }
    const fresh = newState({ seed: 1 });
    delete fresh.herd.nextUid;
    I.skipUidsToTone(fresh, 3);
    assert.equal(I.allocUid(fresh), 3);
  });
});

describe("polish, squash, reroll (D§8.8)", () => {
  test("polish always succeeds, costs the formula, stops at the rarity max", () => {
    const state = world([["hotfixer", 50]]);
    const it = mkItem(state, "hat", 50, 2);
    state.heroes[0].eq[1] = it; // equipped items can be polished
    state.herd.gold = 1e7;
    state.herd.snip = 1000;
    let gold = 0;
    let snip = 0;
    for (let p = 0; p < 7; p++) {
      const r = I.polish(state, it.uid);
      assert.equal(r.ok, true);
      gold += r.cost.gold;
      snip += r.cost.snippets;
    }
    assert.equal(it.pol, 7);
    assert.ok(Math.abs(gold - 198000) / 198000 < 0.01, `~198k gold: ${gold}`);
    assert.equal(snip, 84);
    assert.equal(I.polish(state, it.uid).ok, false); // Beta max +7
    const fresh = mkItem(state, "boots", 50, 2);
    const c = I.nextPolishCost(state, fresh);
    state.herd.gold = 5 * c.gold;
    state.herd.snip = 2 * c.snippets;
    assert.equal(I.autoPolishOk(state, fresh), true);
    state.herd.snip -= 1;
    assert.equal(I.autoPolishOk(state, fresh), false);
    assert.equal(I.nextPolishCost(state, it), null);
    const poor = world();
    const x = mkItem(poor, "hat", 10, 0);
    poor.herd.stash.push(x);
    assert.equal(I.polish(poor, x.uid).ok, false);
    assert.equal(x.pol, 0);
  });

  test("Squash Merge: CI Forge 3, three of a rarity -> one of the next at the average level", () => {
    const state = world();
    const its = [10, 20, 31].map((l) => mkItem(state, "mug", l, 1));
    state.herd.stash.push(...its);
    state.herd.gold = 1e6;
    assert.equal(I.squash(state, its.map((x) => x.uid)).ok, false); // no forge
    state.herd.bld[D.BUILDING_IDX.ci_forge] = 3;
    const r = I.squash(state, its.map((x) => x.uid));
    assert.equal(r.ok, true);
    assert.equal(r.item.rar, 2);
    assert.equal(r.item.ilvl, 20);
    assert.equal(r.cost, 20 * F.gold(20));
    assert.equal(state.herd.stash.length, 1);
    const mixed = [mkItem(state, "mug", 5, 0), mkItem(state, "mug", 5, 1), mkItem(state, "mug", 5, 0)];
    state.herd.stash.push(...mixed);
    assert.equal(I.squash(state, mixed.map((x) => x.uid)).ok, false);
    const rel = [1, 2, 3].map(() => mkItem(state, "mug", 5, 3));
    state.herd.stash.push(...rel);
    assert.equal(I.squash(state, rel.map((x) => x.uid)).ok, false); // Release can't be squashed
  });

  test("Reroll: CI Forge 5, one affix, never a duplicate, not Keepsakes", () => {
    const state = world();
    const it = mkItem(state, "boots", 50, 3, { aff: [[A.async, 10], [A.typed, 20], [A.cache, 30]] });
    const ks = mkItem(state, "boots", 34, 5, { prop: 2, aff: [[A.async, 1]] });
    state.herd.stash.push(it, ks);
    state.herd.gold = 1e7;
    state.herd.snip = 1000;
    assert.equal(I.reroll(state, it.uid, 0).ok, false);
    state.herd.bld[D.BUILDING_IDX.ci_forge] = 5;
    for (let k = 0; k < 30; k++) {
      const r = I.reroll(state, it.uid, 1);
      assert.equal(r.ok, true);
      const ids = it.aff.map((a) => a[0]);
      assert.equal(new Set(ids).size, 3);
      assert.ok(D.AFFIXES[it.aff[1][0]].slots.includes("boots"));
      assert.deepEqual([it.aff[0], it.aff[2]], [[A.async, 10], [A.cache, 30]]);
      assert.deepEqual(r.cost, { gold: 50 * F.gold(50), snippets: 30 });
    }
    assert.equal(I.reroll(state, ks.uid, 0).ok, false);
    assert.equal(I.reroll(state, it.uid, 5).ok, false);
  });
});
