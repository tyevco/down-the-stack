// Save format (D§13): CRC32, byte-identical round trip, corruption, migrations, fallbacks, size.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import * as D from "../mods/mapledr/game/data.js";
import * as F from "../mods/mapledr/game/formulas.js";
import * as H from "../mods/mapledr/game/heroes.js";
import * as I from "../mods/mapledr/game/items.js";
import { encodeState, decodeState, crc32, newState, saveSize, migrations, SAVE_VERSION } from "../mods/mapledr/game/save.js";

// Re-sign a parsed save object after editing it (the CRC covers the text with crc = "").
function resign(obj) {
  obj.crc = "";
  const t0 = JSON.stringify(obj);
  return t0.replace('"crc":""', `"crc":"${crc32(t0)}"`);
}

function populated(nHeroes = 4, { stash = 12, log = 8, full = false } = {}) {
  const state = newState({ nowMs: 1795000000123, seed: 2463534242 });
  const herd = state.herd;
  Object.assign(herd, {
    name: "Night Shift", gold: 412350.25, snip: 133, zone: 2, meter: 7.4, bank: 1.5, seals: 218.6, rel: 17,
    day: 20781, tick: 8812345,
  });
  herd.bld = [3, 2, 1, 2, 2, 0];
  herd.quota = { "1-1": 40, "1-2": 40, "1-3": 40, "2-1": 40, "2-3": 12, "3-1": 31 };
  herd.boss = [1, 1, 0, 0, 0, 0, 0, 0, 0];
  herd.bossKills = [14, 3, 0, 0, 0, 0, 0, 0, 0];
  herd.wounds = { 2: [0.38, 1795172800000] };
  herd.lessons = { 2: 1 };
  herd.bt = [5210, 980, 0, 0, 0, 0, 0, 0, 0];
  herd.badges = ["hello_world", "first_commit", "zero_warnings", "lucky_duck"];
  herd.fame = [["Bram Lintwick", 1, 54, 1793000000000]];
  herd.backlog = { floor: 3, kills: 17 };
  herd.digestAt = 1794990000000;
  herd.cfg.auto.farm = false;
  herd.cfg.nums = "crits";
  herd.cfg.notify.lts = true;
  herd.fight = { b: 2, hp: [12000.5], phase: 1, t: 40, ids: [1, 2] };
  const holder = { rng: 777 };
  for (let i = 0; i < stash; i++) {
    herd.stash.push(I.rollItem(holder, { ilvl: 20 + (i % 80), source: full ? "boss" : "chest", state, first: true }));
  }
  for (let i = 0; i < log; i++) {
    herd.log.push([1795000000000 + i * 1000, "ship", 1 + (i % 3), `Fix flaky auth test number ${i} in api/`, 2.4]);
  }
  for (let k = 0; k < nHeroes; k++) {
    const h = H.newHero(state, { seat: `herdr-app/claude`, sid: "spc_19", ord: k, nowMs: 1795000000000 });
    h.cls = 1 + (k % 5);
    h.L = 14 + k * 3;
    h.xp = 1290.5;
    h.sp = [8, 4, 1, 0, 0, 0, 0];
    h.rev = [k % 2, 0];
    h.fe = 42.5;
    h.shift = { day: 20781, min: 192.25 };
    h.hpFrac = 0.92;
    h.pinMap = k === 0 ? "2-2" : null;
    h.addr = `t${k}`;
    h.lastPane = "main";
    h.lastTab = "api";
    h.st = { kills: 51234, tasks: 312, seals: 288.4, wh: 41.5, dodges: 12, healed: 300 };
    h.cd.unblockedUntil = 120;
    h.cd.boss = { 1: 1794990000000 };
    for (let t = 0; t < (full ? 20 : 5); t++) H.recordTask(h, { minutes: 4 + t * 3, blocks: t % 2, spawned: t % 7 === 0 });
    h.pend = [{ min: 24, fmin: 1.5, title: "Fix flaky auth test", at: 1794999000000, sealFactor: 1 }];
    for (let s = 0; s < 6; s++) {
      const slot = D.SLOTS[s];
      const it = I.rollItem(h, { ilvl: h.L, source: full ? "boss" : "chest", slot, classId: h.cls, state, first: true });
      it.pol = Math.min(3, k);
      it.flags = 0; // equipping clears "new"
      h.eq[s] = it;
    }
    state.heroes.push(h);
  }
  return state;
}

describe("crc32", () => {
  test("standard check values", () => {
    assert.equal(crc32("123456789"), "cbf43926");
    assert.equal(crc32(""), "00000000");
    assert.equal(crc32("The quick brown fox jumps over the lazy dog"), "414fa339");
  });
  test("matches zlib over UTF-8 bytes", () => {
    for (const str of ["é", "Kip the Idempotent", "→∅ 😀 ünïcödé", '{"crc":""}']) {
      assert.equal(crc32(str), (zlib.crc32(Buffer.from(str, "utf8")) >>> 0).toString(16).padStart(8, "0"), str);
    }
  });
});

describe("round trip", () => {
  test("encode -> decode -> encode is byte-identical, state deep-equal", () => {
    const state = populated(6);
    const t1 = encodeState(state);
    const { state: s2, warning, readOnly } = decodeState(t1);
    assert.equal(warning, null);
    assert.equal(readOnly, false);
    const t2 = encodeState(s2);
    assert.equal(t2, t1);
    assert.deepEqual(s2, state);
    const obj = JSON.parse(t1);
    assert.equal(obj.v, SAVE_VERSION);
    assert.equal(obj.gen, D.GEN);
    assert.equal(obj.t, 1795000000);
    assert.match(obj.crc, /^[0-9a-f]{8}$/);
    assert.deepEqual(obj.herd.quota, [[40, 40, 40], [40, 0, 12], [31, 0, 0]]);
    assert.equal(typeof obj.herd.badges, "string");
    assert.equal(obj.heroes[0].n, state.heroes[0].name);
    assert.equal(obj.heroes[0].eq.length, 6);
    assert.equal(obj.heroes[0].eq[0][0], state.heroes[0].eq[0].uid); // [uid, base, ...]
    assert.equal(obj.heroes[0].eq[0][5].length, 2 * state.heroes[0].eq[0].aff.length); // flat affix pairs
    assert.deepEqual(obj.str, ["herdr-app/claude", "spc_19", "main", "api"]); // shared strings table
    assert.equal(obj.heroes[0].s, 0);
  });

  test("a fresh state and an empty herd round-trip", () => {
    const s = newState({ nowMs: 5, seed: 3 });
    const t = encodeState(s);
    assert.equal(encodeState(decodeState(t).state), t);
    assert.deepEqual(decodeState(t).state, s);
  });

  test("missing fields are written as defaults, so the second encode is identical", () => {
    const s = newState({ seed: 3 });
    s.heroes.push({ id: 9, seat: "a/b", L: 3, sp: [1], eq: [] });
    delete s.herd.cfg;
    const t1 = encodeState(s);
    const t2 = encodeState(decodeState(t1).state);
    assert.equal(t2, t1);
    const h = decodeState(t1).state.heroes[0];
    assert.deepEqual(h.sp, [1, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(h.eq, [null, null, null, null, null, null]);
    assert.equal(h.autoLearn, true);
  });

  test("unknown fields survive; runtime '_' fields and floats are compacted", () => {
    const s = populated(2);
    s.heroes[0].wave = { phase: 3, list: [1, 2] };
    s.heroes[0]._cache = { big: true };
    s.herd.trophyRoom = ["a", "b"];
    s.herd.cfg.lootGlow = 2;
    s.herd.cfg.auto.master = true;
    s.meta = { note: "hi" };
    s.heroes[1].hpFrac = 0.123456789;
    s.heroes[1].pend[0].tier = "iron";
    s.herd.quota.backlog = 12;
    const t1 = encodeState(s);
    const { state } = decodeState(t1);
    assert.deepEqual(state.heroes[0].wave, { phase: 3, list: [1, 2] });
    assert.equal("_cache" in state.heroes[0], false);
    assert.deepEqual(state.herd.trophyRoom, ["a", "b"]);
    assert.equal(state.herd.cfg.lootGlow, 2);
    assert.equal(state.herd.cfg.auto.master, true);
    assert.deepEqual(state.meta, { note: "hi" });
    assert.equal(state.heroes[1].hpFrac, 0.123457);
    assert.equal(state.heroes[1].pend[0].tier, "iron");
    assert.equal(state.herd.quota.backlog, 12);
    assert.equal(state.herd.quota["2-3"], 12);
    assert.equal(encodeState(state), t1);
  });
});

describe("corruption and versions", () => {
  test("CRC mismatch throws code crc; ignoreCrc loads anyway", () => {
    const t = encodeState(populated(2));
    const bad = t.replace('"gold":412350.25', '"gold":912350.25');
    assert.notEqual(bad, t);
    assert.throws(() => decodeState(bad), (e) => e.code === "crc");
    assert.equal(decodeState(bad, { ignoreCrc: true }).state.herd.gold, 912350.25);
  });

  test("parse and shape errors", () => {
    assert.throws(() => decodeState("{not json"), (e) => e.code === "parse");
    assert.throws(() => decodeState(encodeState(populated(1)).slice(0, -20)), (e) => e.code === "parse");
    assert.throws(() => decodeState("[1,2]"), (e) => e.code === "shape");
    assert.throws(() => decodeState('{"v":1}'), (e) => e.code === "shape");
  });

  test("migrations: unversioned saves go through the v0 -> v1 step; newer saves are read-only", () => {
    assert.equal(migrations.length, SAVE_VERSION);
    const obj = JSON.parse(encodeState(populated(1)));
    delete obj.v;
    const old = decodeState(resign(obj));
    assert.equal(old.readOnly, false);
    assert.equal(old.state.v, SAVE_VERSION);
    const noCrc = JSON.parse(encodeState(populated(1)));
    delete noCrc.crc;
    assert.match(decodeState(JSON.stringify(noCrc)).warning, /no checksum/);
    const newer = JSON.parse(encodeState(populated(1)));
    newer.v = SAVE_VERSION + 1;
    const r = decodeState(resign(newer));
    assert.equal(r.readOnly, true);
    assert.match(r.warning, /newer version/);
  });

  test("unknown content ids fall back (D§13.4)", () => {
    const obj = JSON.parse(encodeState(populated(1)));
    const hero = obj.heroes[0];
    hero.L = 20;
    hero.c = 42; // unknown class
    hero.m = "x-9"; // unknown map
    hero.eq[1] = [5000, 999, 30, 2, 0, [99, 55, 4, 10]]; // unknown base and affix on the hat slot
    hero.eq[2] = [5001, 32, 30, 5, 0, [[4, 10]], 0, 77]; // unknown keepsake (nested pairs also accepted)
    hero.eq[3] = [5002, 37, 30, 4, 0, [4, 10], 0, 88]; // unknown LTS property
    obj.herd.stash.push([5003, 12345, 10, 0, 0, [0, 3, 77, 3]]); // unknown base and duplicate memo
    obj.gen = D.GEN + 1;
    const { state, warning } = decodeState(resign(obj));
    const h = state.heroes[0];
    assert.equal(h.cls, 3);
    assert.equal(h.pinMap, null);
    assert.equal(D.BASE_LIST[h.eq[1].base].slot, "hat");
    assert.equal(D.BASE_LIST[h.eq[1].base].tier, F.itemTier(30));
    assert.deepEqual(h.eq[1].aff, [[0, 55], [4, 10]]);
    assert.deepEqual([h.eq[2].rar, h.eq[2].prop], [4, 1]);
    assert.deepEqual([h.eq[3].rar, h.eq[3].prop], [4, 1]);
    const st = state.herd.stash.at(-1);
    assert.equal(st.base, 0);
    assert.deepEqual(st.aff, [[0, 3]]);
    assert.match(warning, /unknown id/);
    assert.match(warning, /newer content/);
    assert.ok(I.itemName(h.eq[1]).length > 0);
  });
});

describe("size budget (D§13.3)", () => {
  test("30 heroes in full gear, 140 stash items, 60 log entries fit in 30 KB", (t) => {
    // D§13.3 worst case: every hero in full Release/LTS gear with busy counters, a full signature
    // window and a pending chest with a 40-character quest name; 40-character journal lines.
    const s = populated(30, { stash: 140, log: 60, full: true });
    for (const h of s.heroes) {
      h.pend = [{ min: 37.25, fmin: 0.75, title: "Refactor the session store adapter (#2)", at: 1795000012345, sealFactor: 0.75 }];
      h.cd.unblockedCdUntil = 8812000;
      h.spFree = 1;
      for (const it of h.eq) assert.ok(it.aff.length >= 3);
    }
    const text = encodeState(s);
    const size = saveSize(text);
    assert.ok(size.ok, `save is ${size.bytes} bytes`);
    assert.ok(size.bytes <= 30 * 1024);
    // a typical herd of 6 heroes is well under 10 KB
    const typical = saveSize(encodeState(populated(6, { stash: 40, log: 30 })));
    assert.ok(typical.bytes < 10 * 1024, `typical ${typical.bytes}`);
    t.diagnostic(`worst case ${size.bytes} B; typical 6-hero herd ${typical.bytes} B`);
    assert.equal(encodeState(decodeState(text).state), text);
  });

  test("saveSize counts UTF-8 bytes", () => {
    assert.equal(saveSize("abc").bytes, 3);
    assert.equal(saveSize("é").bytes, 2);
    assert.equal(saveSize("€").bytes, 3);
    assert.equal(saveSize("😀").bytes, 4);
  });
});
