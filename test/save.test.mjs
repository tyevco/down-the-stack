// Save format (D§13): CRC32, byte-identical round trip, corruption, migrations, fallbacks, size.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import fs from "node:fs";
import * as D from "../mods/down-the-stack/game/data.js";
import * as F from "../mods/down-the-stack/game/formulas.js";
import * as H from "../mods/down-the-stack/game/heroes.js";
import * as I from "../mods/down-the-stack/game/items.js";
import * as W from "../mods/down-the-stack/game/world.js";
import { encodeState, decodeState, crc32, newState, saveSize, migrations, SAVE_VERSION } from "../mods/down-the-stack/game/save.js";

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
    h.cd.boss = { 1: 149400 }; // working seconds at the last kill (boss.js: hero.st.wh)
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
    // shared strings table: seats, space ids, pane/tab names, then pending-chest titles and the
    // journal's repeated kinds and texts (D§13.3: titles and journal strings are written once)
    assert.deepEqual(obj.str, ["herdr-app/claude", "spc_19", "main", "api", "Fix flaky auth test", "ship"]);
    assert.equal(obj.heroes[0].s, 0);
    assert.equal(obj.heroes[0].pd[0][1], 4); // the title by its index
    assert.equal(obj.herd.log.d[0][1], 5); //   the kind by its index
    assert.equal(obj.herd.log.d[0][3], "Fix flaky auth test number 0 in api/"); // used once: inline
  });

  test("boss repeat cooldowns: beaten bosses and seconds left survive (bitmask + pairs)", () => {
    const state = populated(1);
    const h = state.heroes[0];
    const now = Math.round(h.st.wh * 3600);
    const cd = D.TUNING.boss.repeatCooldownWorkingSec;
    h.cd.boss = { 0: now - 5 * cd, 3: now - 1200, 8: now - cd };
    const t1 = encodeState(state);
    assert.deepEqual(JSON.parse(t1).heroes[0].cd.b, [(1 << 0) | (1 << 3) | (1 << 8), 3, cd - 1200]);
    const back = decodeState(t1).state.heroes[0].cd.boss;
    assert.deepEqual(Object.keys(back).sort(), ["0", "3", "8"]);
    assert.equal(back[3], now - 1200); //                  still cooling: exact
    for (const k of [0, 8]) assert.ok(now - back[k] >= cd); // ready again: "beaten", cooldown over
    assert.equal(encodeState(decodeState(t1).state), t1);
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

describe("text around the JSON", () => {
  test("a final newline, CRLF, surrounding spaces or a BOM are not corruption", () => {
    const text = encodeState(populated(3));
    for (const t of [text + "\n", text + "\r\n", "  " + text + "\n\n", "\ufeff" + text, "\ufeff" + text + "\n"]) {
      const r = decodeState(t);
      assert.equal(encodeState(r.state), text, JSON.stringify(t.slice(-3)));
      assert.equal(r.warning, null);
    }
  });

  test("an edit inside the JSON still fails the checksum", () => {
    const text = encodeState(populated(3));
    const edited = text.replace('"gold":412350.25', '"gold":412351.25');
    assert.notEqual(edited, text);
    assert.throws(() => decodeState(edited + "\n"), (e) => e.code === "crc");
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
      // every boss beaten, three still on their repeat cooldown (marks in working seconds,
      // boss.js: hero.st.wh x 3600 at the kill)
      h.cd.boss = {};
      for (let b = 0; b < 9; b++) h.cd.boss[b] = Math.round(h.st.wh * 3600) - 4000 * b;
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

  test("a burst of chest items waiting in herd.inbox is stored compact and round-trips", (t) => {
    // D§13.2: up to 20 pending chests per hero; opening a day's chests can queue ~1,000+ items
    // for the 1-per-tick drain (agents.js queueDrop / drainInbox).
    const s = populated(30, { stash: 140, log: 60, full: true });
    const bare = saveSize(encodeState(s)).bytes;
    const items = s.heroes.flatMap((h) => h.eq.filter(Boolean));
    s.herd.inbox = [];
    for (let k = 0; k < 1000; k++) s.herd.inbox.push([1 + (k % 30), { ...items[k % items.length], uid: 500000 + k }]);
    const text = encodeState(s);
    const per = (saveSize(text).bytes - bare) / 1000;
    t.diagnostic(`inbox of 1000 items: ${per.toFixed(1)} B per item`);
    assert.ok(per < 45, `${per.toFixed(1)} B per inbox item (readable objects took ~90)`);
    assert.ok(JSON.parse(text).herd.ib, "under herd.ib, not the readable extras");
    assert.equal(JSON.parse(text).herd.x?.inbox, undefined);
    const back = decodeState(text).state;
    assert.equal(back.herd.inbox.length, 1000);
    assert.deepEqual(back.herd.inbox[7], [s.herd.inbox[7][0], { ...s.herd.inbox[7][1] }]);
    assert.equal(encodeState(back), text, "byte-identical");
    // an empty inbox is absent, as the engine leaves it
    delete s.herd.inbox;
    assert.equal("inbox" in decodeState(encodeState(s)).state.herd, false);
  });

  test("an inbox of an unknown shape stays on the readable extras path, and an old save's readable inbox still loads", () => {
    const s = populated(2);
    s.herd.inbox = [[1, { odd: true }], "not an entry"];
    const text = encodeState(s);
    assert.deepEqual(JSON.parse(text).herd.x.inbox, s.herd.inbox);
    assert.deepEqual(decodeState(text).state.herd.inbox, s.herd.inbox);
  });

  test("pending-chest titles and journal strings are written once (the string table): 30 heroes × 20 chests", (t) => {
    // platform-save-6: titles were inline, so a 30-hero herd left alone for ~11 hours crossed 30 KB
    // (stress30 measured 31.9 KB at 40,000 s). An agent's tasks share few titles.
    const s = populated(30, { stash: 140, log: 60, full: true });
    const titles = ["Refactor the session store adapter (#2)", "Bump deps and fix the types", "Investigate the memory leak in the worker"];
    for (const h of s.heroes) {
      h.pend = [];
      for (let k = 0; k < 20; k++) h.pend.push({ min: 25, fmin: 0, title: titles[(h.id + k) % 3], at: 1795000000000 - k * 1800000, sealFactor: 0.75 });
    }
    const text = encodeState(s);
    const obj = JSON.parse(text);
    for (const ttl of titles) assert.equal(text.split(JSON.stringify(ttl)).length - 1, 1, `${ttl} written once`);
    assert.ok(obj.heroes.every((h) => h.pd.every((r) => typeof r[1] === "number")));
    const back = decodeState(text).state;
    assert.deepEqual(back.heroes.map((h) => h.pend.map((p) => p.title)), s.heroes.map((h) => h.pend.map((p) => p.title)));
    assert.equal(encodeState(back), text, "byte-identical");
    const size = saveSize(text);
    t.diagnostic(`30 heroes × 20 pending chests (600), 140 stash items, 60 journal lines: ${size.bytes} B`);
    assert.ok(size.bytes < 48 * 1024, `${size.bytes} B (≈ 61 KB with titles inline)`);
  });

  test("text slots: a string in the table is its index, null stays null, any other value is boxed", () => {
    const s = populated(2);
    s.heroes[0].pend = [{ min: 5, fmin: 0, title: null, at: 1794999000000, sealFactor: 1 }];
    s.herd.log.push([1795000100000, "note", 0, 42, 0], [1795000200000, "note", 0, { odd: 1 }, 0]);
    const text = encodeState(s);
    const back = decodeState(text).state;
    assert.equal(back.heroes[0].pend[0].title, null);
    assert.deepEqual(back.herd.log.slice(-2).map((e) => e[3]), [42, { odd: 1 }], "never read back as table indices");
    assert.deepEqual(JSON.parse(text).herd.log.d.slice(-2).map((r) => r[3]), [[42], [{ odd: 1 }]]);
    assert.equal(encodeState(back), text);
  });

  test("the D§11.15 settings: defaults are left out of the save; changes round-trip", () => {
    const s = populated(1);
    const plain = JSON.parse(encodeState(s)).herd.cfg;
    for (const k of ["ap", "glow", "col", "held", "autopilot", "collapse", "collapsed"]) assert.equal(k in plain, false, k);
    Object.assign(s.herd.cfg, { autopilot: false, glow: 4, collapse: true, collapsed: true });
    const text = encodeState(s);
    assert.deepEqual(JSON.parse(text).herd.cfg, { ...plain, ap: 0, glow: 4, col: 1, held: 1 });
    const cfg = decodeState(text).state.herd.cfg;
    assert.deepEqual([cfg.autopilot, cfg.glow, cfg.collapse, cfg.collapsed], [false, 4, true, true]);
    assert.equal(encodeState(decodeState(text).state), text);
    // an out-of-range glow from a hand-edited save is clamped
    const edited = JSON.parse(text);
    edited.herd.cfg.glow = 9;
    assert.equal(decodeState(resign(edited)).state.herd.cfg.glow, 5);
  });

  test("the host's collapse countdown start (cfg.idleAt) is saved only while one runs, and round-trips", () => {
    const s = populated(1);
    const plain = JSON.parse(encodeState(s)).herd.cfg;
    assert.equal("idle" in plain, false);
    assert.equal("idleAt" in decodeState(encodeState(s)).state.herd.cfg, false, "absent: no countdown (older saves too)");
    s.herd.cfg.idleAt = 1794999940123;
    const text = encodeState(s);
    assert.deepEqual(JSON.parse(text).herd.cfg, { ...plain, idle: 1794999940123 });
    const back = decodeState(text).state;
    assert.equal(back.herd.cfg.idleAt, 1794999940123);
    assert.equal(encodeState(back), text, "byte-identical");
    delete back.herd.cfg.idleAt;
    assert.deepEqual(JSON.parse(encodeState(back)).herd.cfg, plain, "cleared: gone from the save");
  });

  test("saveSize counts UTF-8 bytes", () => {
    assert.equal(saveSize("abc").bytes, 3);
    assert.equal(saveSize("é").bytes, 2);
    assert.equal(saveSize("€").bytes, 3);
    assert.equal(saveSize("😀").bytes, 4);
  });
});

describe("every save this branch has written loads (SAVE_VERSION stays 1)", () => {
  // test/fixtures/saves: texts written by the engine of each commit that changed the save format
  // (990aa93 the first save.js; 4f9a1a0 = 4082db1's save.js; 2d2583c before the string table held
  // pending-chest titles and journal strings), demo worlds of the time, one with shared titles.
  const DIR = new URL("./fixtures/saves/", import.meta.url);
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

  test("the fixtures cover every format", () => {
    assert.deepEqual(files.map((f) => f.split("-")[0]).filter((c, i, a) => a.indexOf(c) === i), ["2d2583c", "4082db1", "4f9a1a0", "990aa93"]);
  });

  for (const f of files) {
    test(`${f}: loads with its checksum, keeps every title and journal line, ticks, and saves in the new form`, () => {
      const text = fs.readFileSync(new URL(f, DIR), "utf8");
      const raw = JSON.parse(text);
      assert.equal(raw.v, 1);
      const { state, warning, readOnly } = decodeState(text);
      assert.equal(readOnly, false);
      assert.equal(warning, null, String(warning));
      assert.equal(state.heroes.length, raw.heroes.length);
      // inline strings (the old form) read back as they were
      raw.heroes.forEach((h, i) => {
        assert.equal(state.heroes[i].name, h.n);
        assert.deepEqual(state.heroes[i].pend.map((p) => p.title), (h.pd ?? []).map((r) => r[1]));
      });
      const rawLog = Array.isArray(raw.herd.log) ? raw.herd.log : raw.herd.log?.d ?? [];
      assert.deepEqual(state.herd.log.map((e) => [e[1], e[3]]), rawLog.map((r) => [r[1], r[3]]));
      // the world runs on it, and the new form round-trips byte for byte
      const { world } = W.loadWorld(text, { nowMs: state.herd.lastMs });
      for (let k = 1; k <= 5; k++) W.tick(world, { nowMs: state.herd.lastMs + k * 1000, tzOffsetMin: 0, weekday: 2, windowActive: true, focusedTerminal: null, agents: [], subagents: [], tabs: {}, spaces: [] });
      assert.deepEqual(world.rt.errors, []);
      const t2 = encodeState(state);
      assert.equal(encodeState(decodeState(t2).state), t2);
      assert.ok(saveSize(t2).bytes <= saveSize(text).bytes + 64, `${saveSize(t2).bytes} vs ${saveSize(text).bytes}`);
      if (f.includes("pend")) assert.ok(saveSize(t2).bytes < saveSize(text).bytes - 1000, "shared titles are written once now");
    });
  }
});
