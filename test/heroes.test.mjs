// Heroes: names, creation, derived stats, XP/levels, careers, class signature, skills.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as D from "../mods/down-the-stack/game/data.js";
import * as F from "../mods/down-the-stack/game/formulas.js";
import * as H from "../mods/down-the-stack/game/heroes.js";
import * as I from "../mods/down-the-stack/game/items.js";
import { fnv1a32 } from "../mods/down-the-stack/game/rng.js";
import { newState } from "../mods/down-the-stack/game/save.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

function mk(cls = 0, L = 1, extra = {}) {
  const state = newState({ nowMs: 0, seed: 99 });
  const h = H.newHero(state, { seat: "repo/claude", ord: 0, nowMs: 0 });
  h.cls = typeof cls === "number" ? cls : D.CLASS_IDX[cls];
  h.L = L;
  Object.assign(h, extra);
  state.heroes.push(h);
  return { state, h };
}

function item(slot, ilvl, rar = 0, extra = {}) {
  const t = F.itemTier(ilvl);
  return { uid: extra.uid ?? 1000 + ilvl, base: I.baseIdFor(slot, t, extra.type ?? slot), ilvl, rar, pol: extra.pol ?? 0, aff: extra.aff ?? [], flags: 0, prop: extra.prop ?? -1 };
}

// The reference simulator's auto-learn (tools/reference-sim/combat4.py ranks()), as an oracle.
function simRanks(L) {
  const UNLOCK = [1, 5, 10, 20, 30, 60, 90];
  const MAXR = [20, 15, 15, 15, 15, 15, 10];
  const TIE = [5, 4, 0, 1, 6, 2, 3];
  const r = [0, 0, 0, 0, 0, 0, 0];
  for (let lv = 2; lv <= L; lv++) {
    const pts = 1 + (lv === 30 ? 1 : 0) + (lv === 60 ? 1 : 0);
    for (let p = 0; p < pts; p++) {
      let best = null;
      for (let i = 0; i < 7; i++) {
        if (lv < UNLOCK[i] || r[i] >= MAXR[i] || lv < UNLOCK[i] + r[i]) continue;
        const key = [r[i] / MAXR[i], TIE.indexOf(i)];
        if (!best || key[0] < best[0][0] || (key[0] === best[0][0] && key[1] < best[0][1])) best = [key, i];
      }
      if (best) r[best[1]]++;
    }
  }
  return r;
}

describe("names and creation", () => {
  test("heroName follows D§3.3", () => {
    const h = fnv1a32("herdr-app/claude#0");
    assert.equal(H.heroName("herdr-app/claude", 0), `${D.NAMES.first[h % 64]} ${D.NAMES.epithet[(h >>> 8) % 64]}`);
    assert.equal(H.heroName("herdr-app/claude", 0), H.heroName("herdr-app/claude", 0));
    const names = new Set();
    for (let o = 0; o < 20; o++) names.add(H.heroName("herdr-app/claude", o));
    assert.ok(names.size >= 15);
  });

  test("newHero: Lv 1 Intern with a starter stick, ids from the herd", () => {
    const state = newState({ seed: 5 });
    const a = H.newHero(state, { seat: "s/x", ord: 0, nowMs: 123 });
    const b = H.newHero(state, { seat: "s/x", ord: 1, nowMs: 456 });
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    assert.equal(state.herd.nextHeroId, 3);
    assert.equal(a.L, 1);
    assert.equal(a.cls, 0);
    assert.equal(a.sp.length, 7);
    assert.equal(a.eq.length, 6);
    assert.equal(a.eq[0].base, 0);
    assert.equal(a.eq[0].uid, 1);
    assert.equal(b.eq[0].uid, 2);
    assert.equal(state.herd.nextUid, 3);
    assert.notEqual(a.rng, b.rng);
    assert.ok(a.rng > 0);
    assert.equal(a.cups, 20);
    assert.equal(a.seenAt, 123);
    // deterministic given the same herd seed
    const s2 = newState({ seed: 5 });
    assert.deepEqual(H.newHero(s2, { seat: "s/x", ord: 0, nowMs: 123 }), a);
  });
});

describe("a hero's look (round 4b)", () => {
  test("lookOf: the hoodie tint by id as every build drew it, a Contractor's too; hero.look when set", () => {
    const n = D.PALETTE.termlingTint.length;
    assert.equal(n, 8);
    // the formula every saved hero has been drawn with: (|id| - 1) mod 8 (view/chrome.js since round 1)
    for (let id = -40; id <= 80; id++) assert.equal(H.lookOf({ id }), (((Math.abs(id) - 1) % n) + n) % n, `id ${id}`);
    assert.equal(H.lookOf(null), 0);
    assert.equal(H.lookOf({}), 0);
    assert.equal(H.lookOf({ id: 7, look: 2 }), 2, "a promoted Contractor keeps the tint it had");
    assert.equal(H.lookOf({ id: 7, look: 10 }), 2);
    assert.equal(H.lookOf({ id: 7, look: -1 }), 6, "no look: by id");
    assert.equal(H.lookOf({ id: 7, look: 1.5 }), 6);
    const state = newState({ seed: 5 });
    assert.ok(!("look" in H.newHero(state, { seat: "s/x", ord: 0 })), "a hired hero has no stored look");
  });
});

describe("stats (D§5.3)", () => {
  test("Lv 1 Intern with the stick", () => {
    const { h } = mk();
    const st = H.stats(h);
    assert.equal(st.might, 4);
    assert.equal(st.weaponDmg, 6);
    assert.equal(st.maxHp, Math.round(60 * 1.04));
    assert.ok(near(st.crit, 0.05 + 0.0015 * 4));
    assert.equal(st.critMult, 1.5);
    assert.equal(st.armor, 0);
    assert.ok(near(st.itemFind, 0.004 * 4));
    assert.ok(near(st.goldPct, 0.005 * 4));
    assert.ok(st.dpsEst > 0 && st.ehp > 0);
  });

  test("growth, innates and gear", () => {
    const { h } = mk("refactorer", 20);
    h.eq[1] = item("hat", 18, 0);
    h.eq[2] = item("hoodie", 18, 0);
    const st = H.stats(h);
    assert.ok(near(st.grit, 4 + 2.3 * 19));
    assert.equal(st.maxHp, Math.round(60 * F.g(20) * (1 + st.grit / 100) * 1.1)); // Clean Hands +10%
    assert.ok(near(st.armor, F.armorPiece(1, 18) + F.armorPiece(2, 18)));
    assert.ok(near(st.dr(20), F.DR(st.armor, 20)));
    const hot = mk("hotfixer", 20).h;
    const hs = H.stats(hot);
    assert.equal(hs.critMult, 1.6);
    assert.ok(near(hs.crit, 0.05 + 0.0015 * (4 + 1.6 * 19) + 0.05));
    assert.equal(H.stats(mk("shellmancer", 20).h).areaTargets, 1);
    assert.equal(H.stats(mk("forkbinder", 20).h).forklingPct, 0.2);
  });

  test("no weapon: 3 g(L)", () => {
    const { h } = mk(0, 5);
    h.eq[0] = null;
    assert.ok(near(H.stats(h).weaponDmg, 3 * F.g(5)));
  });

  test("affix stats, caps and keepsakes", () => {
    const { h } = mk("hotfixer", 90, { rev: [1, 1] });
    // stickers/hats stuffed with crit: crit caps at 50%
    h.eq[1] = item("hat", 100, 5, { prop: D.KEEPSAKE_IDX.hazard_cone_hat, aff: [[D.AFFIX_IDX.lint, 99], [D.AFFIX_IDX.hot, 99]] }); // +5% crit
    h.eq[0] = item("weapon", 100, 3, { type: "knives", uid: 9999, aff: [[D.AFFIX_IDX.lint, 99], [D.AFFIX_IDX.memo, 0]] });
    h.eq[5] = item("sticker", 100, 3, { aff: [[D.AFFIX_IDX.lint, 99], [D.AFFIX_IDX.opt, 99], [D.AFFIX_IDX.hot, 99]] });
    h.eq[4] = { ...item("boots", 100, 5, { prop: D.KEEPSAKE_IDX.lazy_quantifier_boots }), aff: [] };
    const st = H.stats(h);
    assert.equal(st.crit, 0.5);
    assert.ok(near(st.cdr, 0.32)); // 2 x 10% + 12% (balance: Hot Reload halved), under the 40% cap
    assert.ok(near(st.critMult, 1.6 + 0.25)); // Optimized 5% x t5 (balance: halved from 10%)
    assert.ok(st.keepsakes.lazy_quantifier_boots);
  });

  test("herd trophies, Bug Tracker perks, release train", () => {
    const { state, h } = mk("shellmancer", 30);
    const base = H.stats(h, { herd: state.herd });
    state.herd.boss[0] = 1;
    state.herd.boss[1] = 1;
    state.herd.bt[5] = 5000; // Threadlock Keep: +2% damage per tier (tier 2)
    state.herd.bt[3] = 500; // Merge Marshes: +2% max HP (tier 1)
    state.herd.rel = 10;
    const st = H.stats(h, { herd: state.herd });
    assert.ok(near(st.dmgPct - base.dmgPct, 0.02 + 0.04));
    assert.ok(near(st.hpPct - base.hpPct, 0.02 + 0.02));
    assert.ok(near(st.goldPct - base.goldPct, 0.05));
  });

  test("cache: same object until an input changes", () => {
    const { h } = mk("refactorer", 15);
    const a = H.stats(h);
    assert.equal(H.stats(h), a);
    h.L = 16;
    const b = H.stats(h);
    assert.notEqual(b, a);
    assert.equal(H.stats(h), b);
    h.eq[0].pol = 2;
    assert.notEqual(H.stats(h), b);
    const c = H.stats(h);
    h.sp[0] = 3;
    assert.notEqual(H.stats(h), c);
  });

  test("cache: two heroes in turn keep their own entries; every herd and room input still counts", () => {
    // stats() checks its cache with scratch signatures (no allocation on a hit) and remembers the
    // last Bug Tracker kill counts: neither may leak one hero's or one call's inputs into another
    const { state, h } = mk("refactorer", 15);
    const g = H.newHero(state, { seat: "repo/codex", ord: 0, nowMs: 0 });
    g.cls = D.CLASS_IDX.hotfixer;
    g.L = 22;
    const ctx = { herd: state.herd, roomBonuses: { dmg: 0, dr: 0, xp: 0 }, roomAllies: 0, freshEyes: false, workingForklings: 0 };
    const a = H.stats(h, ctx);
    const b = H.stats(g, ctx);
    assert.notEqual(a, b);
    assert.equal(H.stats(h, ctx), a, "hero A's entry survives a call for hero B");
    assert.equal(H.stats(g, ctx), b);
    // kills inside a Bug Tracker tier change nothing; crossing a tier recomputes
    state.herd.bt[5] = 4000;
    const t1 = H.stats(h, ctx);
    state.herd.bt[5] = 4500;
    assert.equal(H.stats(h, ctx), t1, "same tier: cache hit");
    state.herd.bt[5] = 5000;
    const t2 = H.stats(h, ctx);
    assert.notEqual(t2, t1, "next tier: recomputed");
    assert.ok(near(t2.dmgPct - t1.dmgPct, 0.02));
    assert.ok(near(H.stats(g, ctx).dmgPct - b.dmgPct, 0.04), "the other hero sees the tiers too (two)");
    // room inputs
    ctx.roomBonuses.dmg = 0.1;
    const r = H.stats(h, ctx);
    assert.notEqual(r, t2);
    assert.ok(near(r.dmgPct - t2.dmgPct, 0.1));
    ctx.roomAllies = 2;
    assert.notEqual(H.stats(h, ctx), r);
    // the same results as a fresh computation
    for (const x of [h, g]) assert.deepEqual(JSON.stringify(H.stats(x, ctx)), JSON.stringify(H.computeStats(x, ctx)));
  });

  test("DPS_est / EHP respond to gear; Power Level stays within L-5..L+8", () => {
    const { h } = mk("refactorer", 40, { rev: [1, 0] });
    h.sp = H.autoRanks("refactorer", 40);
    h.eq[0] = item("weapon", 38, 2, { type: "blade" });
    const a = H.stats(h);
    h.eq[0] = item("weapon", 45, 2, { type: "blade", uid: 7 });
    h.eq[2] = item("hoodie", 40, 2);
    const b = H.stats(h);
    assert.ok(b.dpsEst > a.dpsEst);
    assert.ok(b.ehp > a.ehp);
    assert.ok(b.pl >= 35 && b.pl <= 48);
    for (const cls of ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"]) {
      for (const L of [10, 30, 60, 100]) {
        const x = mk(cls, L, { rev: [L >= 30 ? 1 : 0, L >= 60 ? 1 : 0] }).h;
        x.sp = H.autoRanks(cls, L);
        const st = H.stats(x);
        assert.ok(st.pl >= L - 5 && st.pl <= L + 8, `${cls} ${L}: ${st.pl}`);
      }
    }
  });
});

describe("XP and level-ups (D§6.4)", () => {
  test("level-ups give SP from Lv 2 and a full heal", () => {
    const { state, h } = mk();
    const fx = [];
    let majors = 0;
    const ev = { fx: (k, d) => fx.push([k, d]), note() {}, banner() {}, major: () => majors++ };
    h.hpFrac = 0.3;
    const r = H.grantXP(state, h, F.need(1) + F.need(2) + 5, ev);
    assert.equal(r.levels, 2);
    assert.equal(h.L, 3);
    assert.equal(h.spFree, 2);
    assert.equal(h.xp, 5);
    assert.equal(h.hpFrac, 1);
    assert.deepEqual(fx.map((x) => x[0]), ["levelup", "levelup"]);
    assert.equal(majors, 1);
    assert.equal(H.grantXP(state, h, 1, ev).levels, 0);
    assert.equal(H.grantXP(state, h, -5, ev).levels, 0);
  });

  test("Lv 10: class from the signature, provisional, Intern SP refunded", () => {
    const { state, h } = mk(0, 9);
    h.sp[0] = 5;
    h.sp[1] = 3;
    h.spFree = 0;
    for (let i = 0; i < 6; i++) H.recordTask(h, { minutes: 25 });
    const notes = [];
    const r = H.grantXP(state, h, F.need(9), { note: (t) => notes.push(t) });
    assert.equal(h.L, 10);
    assert.equal(D.CLASSES[h.cls].id, "refactorer");
    assert.equal(h.prov, 1);
    assert.deepEqual(h.sp, [0, 0, 0, 0, 0, 0, 0]);
    assert.equal(h.spFree, 9);
    assert.equal(r.promoted, "Junior Refactorer");
    assert.deepEqual(notes, ["Promoted: Junior Refactorer"]);
  });

  test("Lv 100 maintenance: every 1% of Need(99) becomes a Snippet", () => {
    const { state, h } = mk("shellmancer", 100);
    const per = 0.01 * F.need(99);
    const r = H.grantXP(state, h, 2.5 * per, null);
    assert.equal(r.snippets, 2);
    assert.equal(state.herd.snip, 2);
    assert.equal(h.L, 100);
    assert.ok(near(h.xp, 0.5 * per, 1e-6));
  });

  test("reaching Lv 100 from 99 converts the overflow", () => {
    const { state, h } = mk("shellmancer", 99);
    H.grantXP(state, h, F.need(99) + 0.01 * F.need(99) * 3, null);
    assert.equal(h.L, 100);
    assert.equal(state.herd.snip, 3);
  });
});

describe("careers (D§4.1)", () => {
  test("titles follow levels and reviews", () => {
    assert.equal(H.careerOf(mk(0, 5).h).title, "Intern");
    assert.equal(H.careerOf(mk("refactorer", 12).h).title, "Junior Refactorer");
    assert.equal(H.careerOf(mk("hotfixer", 35).h).title, "Junior Hotfixer");
    assert.equal(H.careerOf(mk("hotfixer", 35, { rev: [1, 0] }).h).title, "Senior Hotfixer");
    assert.equal(H.careerOf(mk("hotfixer", 65, { rev: [1, 0] }).h).title, "Senior Hotfixer");
    assert.equal(H.careerOf(mk("shellmancer", 65, { rev: [1, 1] }).h).tier, 3);
    assert.equal(H.careerOf(mk("rubberducker", 92, { rev: [1, 1] }).h).title, "Principal Rubberducker");
  });
});

describe("class from behaviour (D§4.2)", () => {
  const sigOf = (tasks) => {
    const { h } = mk(0, 5);
    for (const t of tasks) H.recordTask(h, t);
    return H.classSignature(h);
  };
  test("rules in order", () => {
    assert.equal(sigOf([]).recommended, "shellmancer");
    assert.equal(sigOf([{ minutes: 20 }, { minutes: 30 }, { minutes: 16 }]).recommended, "refactorer");
    assert.equal(sigOf([{ minutes: 3 }, { minutes: 4 }, { minutes: 2 }]).recommended, "hotfixer");
    assert.equal(sigOf([{ minutes: 10 }, { minutes: 8 }, { minutes: 12 }]).recommended, "shellmancer");
    // 2+ blocks per working hour beats a long median
    assert.equal(sigOf([{ minutes: 30, blocks: 1 }, { minutes: 30, blocks: 1 }]).recommended, "rubberducker");
    // 25%+ tasks with a sub-agent beats everything
    assert.equal(sigOf([{ minutes: 30, blocks: 5, spawned: true }, { minutes: 3 }, { minutes: 3 }, { minutes: 3 }]).recommended, "forkbinder");
    const s = sigOf([{ minutes: 10, blocks: 1 }, { minutes: 20 }]);
    assert.equal(s.median, 15);
    assert.ok(near(s.bph, 2));
    assert.equal(s.n, 2);
  });
  test("short tasks do not qualify; window keeps the last 20", () => {
    const { h } = mk(0, 5);
    assert.equal(H.recordTask(h, { minutes: 1.4 }).qualifying, false);
    for (let i = 0; i < 25; i++) H.recordTask(h, { minutes: i < 5 ? 100 : 3 });
    assert.equal(h.sig.tm.length, 20);
    assert.equal(h.sig.n, 25);
    assert.equal(H.classSignature(h).recommended, "hotfixer");
  });
  test("provisional class switches for free until 15 tasks, then locks", () => {
    const { h } = mk(0, 9);
    const { state } = mk();
    h.spFree = 8; // earned on the way to Lv 9
    H.recordTask(h, { minutes: 30 });
    H.grantXP(state, h, F.need(9), null);
    assert.equal(D.CLASSES[h.cls].id, "refactorer");
    assert.equal(h.prov, 1);
    H.autoLearn(h);
    let switched = false;
    for (let i = 0; i < 13; i++) switched = H.recordTask(h, { minutes: 3 }).switched || switched;
    assert.ok(switched);
    assert.equal(D.CLASSES[h.cls].id, "hotfixer");
    assert.equal(h.sig.n, 14);
    assert.equal(h.prov, 1);
    assert.equal(h.sp.reduce((a, b) => a + b, 0) + h.spFree, H.totalSP(h));
    const r = H.recordTask(h, { minutes: 3 });
    assert.equal(r.locked, true);
    assert.equal(h.prov, 0);
    for (let i = 0; i < 20; i++) H.recordTask(h, { minutes: 40 });
    assert.equal(D.CLASSES[h.cls].id, "hotfixer"); // locked
  });

  test("a weapon of the old class swings like a Training Stick of its item level after a class switch; a usable one is an upgrade", () => {
    const { state, h } = mk("shellmancer", 25);
    h.eq[0] = item("weapon", 24, 2, { type: "pipe" });
    const before = H.stats(h, { herd: state.herd });
    assert.equal(before.hasWeapon, true);
    assert.equal(before.offClassWeapon, false);
    state.herd.snip = 10000; // a Career Change from Lv 20 costs 25 x L Snippets
    assert.equal(H.setClass(state, h, "refactorer").ok, true);
    const st = H.stats(h, { herd: state.herd });
    // no rarity, polish, affixes or class bonus: 6 g(24), not bare hands (3 g(25))
    assert.equal(st.hasWeapon, true);
    assert.equal(st.offClassWeapon, true, "the sheet's Weapon damage tooltip says so");
    assert.ok(near(st.weaponDmg, F.weaponDmg(24, 1, 0)));
    assert.ok(st.weaponDmg > F.bareHandDmg(25) && st.weaponDmg < before.weaponDmg);
    assert.equal(I.isUpgrade(h, item("weapon", 24, 0, { type: "blade", uid: 7 }), { herd: state.herd }), true);
  });

  test("skillValue without stats reuses the last stats ctx (herd CDR perks)", () => {
    const { state, h } = mk("refactorer", 30, { rev: [1, 0] });
    h.sp = [5, 3, 2, 4, 1, 0, 0];
    state.herd.bt[6] = 50000; // Legacy Catacombs Fixed: -6% cooldowns
    const st = H.stats(h, { herd: state.herd });
    assert.equal(H.skillValue(h, "buff").cd, Math.ceil(30 * 0.94));
    assert.equal(H.stats(h, { herd: state.herd }), st); // cache not evicted
  });
  test("person override and Career Change cost", () => {
    const young = mk(0, 5);
    assert.equal(H.setClass(young.state, young.h, "forkbinder").ok, true);
    H.grantXP(young.state, young.h, [5, 6, 7, 8, 9].reduce((n, l) => n + F.need(l), 0), null);
    assert.equal(D.CLASSES[young.h.cls].id, "forkbinder");
    assert.equal(young.h.prov, 0);

    const mid = mk("shellmancer", 15, { prov: 1 });
    assert.deepEqual(H.setClass(mid.state, mid.h, "hotfixer"), { ok: true, cost: 0 });
    assert.equal(mid.h.prov, 0);

    const old = mk("shellmancer", 40);
    old.h.sp = H.autoRanks("shellmancer", 40);
    assert.equal(H.setClass(old.state, old.h, "refactorer").ok, false);
    old.state.herd.snip = 1000;
    const r = H.setClass(old.state, old.h, "refactorer");
    assert.equal(r.ok, true);
    assert.equal(r.cost, 1000);
    assert.equal(old.state.herd.snip, 0);
    assert.equal(H.setClass(old.state, old.h, "intern").ok, false);
  });
});

describe("skills (D§7)", () => {
  test("rank gate L >= unlock + rank - 1, review gates", () => {
    const { h } = mk("refactorer", 6);
    h.spFree = 10;
    assert.equal(H.learn(h, "area").ok, true); // rank 1 at Lv 5+
    assert.equal(H.learn(h, "area").ok, true); // rank 2 at Lv 6
    assert.equal(H.learn(h, "area").ok, false); // rank 3 needs Lv 7
    assert.equal(H.learn(h, "passive").ok, false); // unlocks at 10
    const s = mk("refactorer", 35).h;
    s.spFree = 5;
    assert.equal(H.canLearn(s, "sig"), false);
    s.rev = [1, 0];
    assert.equal(H.canLearn(s, "sig"), true);
    const m = mk("refactorer", 70, { rev: [1, 0] }).h;
    assert.equal(H.canLearn(m, "ult"), false);
    assert.equal(H.winReview(m, 1), true);
    assert.equal(H.winReview(m, 1), false);
    assert.equal(m.spFree, 1);
    assert.equal(H.canLearn(m, "ult"), true);
    const none = mk("refactorer", 50).h;
    assert.deepEqual(H.learn(none, "main"), { ok: false, error: "No skill points" });
  });

  test("auto-learn reproduces the reference simulator at every level", () => {
    for (const cls of ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"]) {
      for (const L of [10, 11, 20, 29, 30, 31, 45, 59, 60, 61, 75, 89, 90, 95, 100]) {
        assert.deepEqual(H.autoRanks(cls, L), simRanks(L), `${cls} L${L}`);
      }
    }
    const r100 = H.autoRanks("shellmancer", 100);
    assert.equal(r100.reduce((a, b) => a + b, 0), 101);
  });

  test("auto-learn respects the flag; Intern skills; refund at Lv 10", () => {
    const { h } = mk(0, 9);
    h.spFree = 8;
    h.autoLearn = false;
    assert.equal(H.autoLearn(h), 0);
    assert.equal(H.autoLearn(h, { force: true }), 8);
    assert.deepEqual(h.sp.slice(0, 2), [5, 3]);
    assert.ok(h.sp[0] <= 8 && h.sp[1] <= 5);
  });

  test("respec: free once a day while resting, else 5 x L Snippets", () => {
    const { state, h } = mk("hotfixer", 30, { rev: [1, 0] });
    h.sp = H.autoRanks("hotfixer", 30);
    const day = 86400000;
    assert.equal(H.respec(h, 1000, { resting: true }).free, true);
    assert.equal(h.sp.reduce((a, b) => a + b, 0) + h.spFree, 30);
    assert.equal(H.respec(h, 2000, { resting: true }).ok, false); // not free again, no herd
    state.herd.snip = 200;
    const r = H.respec(h, 2000, { resting: true, herd: state.herd });
    assert.deepEqual([r.ok, r.free, r.cost, state.herd.snip], [true, false, 150, 50]);
    assert.equal(H.respec(h, 1000 + day, { resting: true }).free, true);
  });

  test("respec, setClass and a provisional switch re-spend only while the herd's auto-learn is on", () => {
    const spent = (h) => h.sp.reduce((a, b) => a + b, 0);
    for (const off of [{ auto: { learn: false } }, { autopilot: false }]) {
      const { state, h } = mk("hotfixer", 30, { rev: [1, 0] });
      Object.assign(state.herd.cfg, off, off.auto ? { auto: Object.assign({}, state.herd.cfg.auto, off.auto) } : {});
      assert.equal(F.autoOn(state, "learn"), false);
      h.sp = H.autoRanks("hotfixer", 30);
      assert.equal(H.respec(h, 1000, { resting: true, herd: state.herd }).ok, true);
      assert.deepEqual([spent(h), h.spFree], [0, 30], "respec: the points wait for the person");
      h.sp = H.autoRanks("hotfixer", 30);
      h.spFree = 0;
      state.herd.snip = 1e6;
      assert.equal(H.setClass(state, h, "refactorer").ok, true);
      assert.deepEqual([spent(h), h.spFree], [0, 30], "setClass: the points wait");
      // recordTask: the caller (agents.closeTask) passes the herd's switch
      const p = mk("refactorer", 12, { prov: 1, spFree: 11, sp: [0, 0, 0, 0, 0, 0, 0] }).h;
      let r = null;
      for (let i = 0; i < 6 && !(r && r.switched); i++) r = H.recordTask(p, { minutes: 3 }, { learn: false });
      assert.equal(r.switched, true);
      assert.deepEqual([spent(p), p.spFree], [0, 11], "a provisional switch: the points wait");
    }
    // on (the default): re-spent at once, as before
    const { state, h } = mk("hotfixer", 30, { rev: [1, 0] });
    h.sp = H.autoRanks("hotfixer", 30);
    H.respec(h, 1000, { resting: true, herd: state.herd });
    assert.deepEqual([spent(h), h.spFree], [30, 0]);
  });

  test("skillValue resolves rank numbers and cooldowns", () => {
    const { h } = mk("refactorer", 40, { rev: [1, 0] });
    h.sp = [5, 3, 2, 4, 2, 0, 0];
    const st = H.stats(h);
    assert.ok(near(H.skillValue(h, "main", st).coef, 1.12));
    assert.ok(near(H.skillValue(h, "area", st).coef, 0.76));
    const cr = H.skillValue(h, "buff", st);
    assert.equal(cr.ticks, 10);
    assert.ok(near(cr.self.dmg, 0.1));
    assert.ok(near(cr.room.dmgTaken, -0.05 - 0.005 * 3));
    assert.equal(cr.cd, 30);
    assert.deepEqual(H.skillValue(h, "passive", st).perRank, { hpPct: 0.04, dr: 0.02 });
    assert.equal(H.skillValue(h, "ult", st).usable, false);

    const hot = mk("hotfixer", 40, { rev: [1, 0] }).h;
    hot.sp = [1, 1, 1, 10, 9, 0, 0];
    hot.eq[4] = { ...item("boots", 40, 5, { prop: D.KEEPSAKE_IDX.lazy_quantifier_boots }) };
    const hs = H.stats(hot);
    assert.equal(H.skillValue(hot, "buff", hs).ticks, 7); // 5 + floor(10/5)
    assert.equal(H.skillValue(hot, "sig", hs).maxStacks, 8); // 5 + floor(9/3)
    assert.equal(H.skillValue(hot, "buff", hs).cd, Math.ceil(30 * (1 - 0.12))); // CDR rounds up
    assert.equal(H.skillValue(hot, "area", hs).cd, 4);

    const duck = mk("rubberducker", 40, { rev: [1, 0] }).h;
    duck.sp = [1, 3, 1, 3, 7, 0, 0];
    assert.equal(H.skillValue(duck, "sig").count, 1);
    duck.sp[4] = 8;
    assert.equal(H.skillValue(duck, "sig").count, 2);
    assert.ok(near(H.skillValue(duck, "area").heal, 0.09));
    assert.ok(near(H.skillValue(duck, "buff").self.dmg, 0.13));

    const fork = mk("forkbinder", 40, { rev: [1, 0] }).h;
    fork.sp = [1, 1, 10, 1, 1, 0, 0];
    assert.equal(H.skillValue(fork, "passive").countedBonus, 2);
    assert.equal(H.stats(fork).forklingCount, 5);
    assert.ok(near(H.stats(fork).forklingPct, 0.3));
  });

  test("Main counts as rank 1 from Lv 1; Curly Brace Crown adds a rank", () => {
    const { h } = mk(0, 1);
    assert.equal(H.effectiveRank(h, "main"), 1);
    assert.ok(near(H.skillValue(h, "main").coef, 1));
    const r = mk("shellmancer", 20).h;
    r.sp[0] = 4;
    r.eq[1] = item("hat", 23, 5, { prop: D.KEEPSAKE_IDX.curly_brace_crown });
    const st = H.stats(r);
    assert.equal(H.effectiveRank(r, "main", st), 5);
    assert.equal(H.effectiveRank(r, "area", st), 1);
  });
});
