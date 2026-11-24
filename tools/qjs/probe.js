// Built-in behaviour probes, evaluated as a global script in QuickJS-ng (run.mjs, after herdr's
// sandbox prelude) and in V8 (probe-node.mjs). The value of the last expression is the result.
(() => {
  const P = {};
  const t = (name, fn) => {
    try {
      const v = fn();
      P[name] = v === undefined ? "undefined" : typeof v === "number" && !Number.isFinite(v) ? String(v) : v;
    } catch (e) {
      P[name] = "THROWS " + (e && e.name);
    }
  };

  // --- globals / newer built-ins
  for (const g of ["Intl", "structuredClone", "queueMicrotask", "TextEncoder", "TextDecoder", "WeakRef", "FinalizationRegistry", "atob", "btoa", "URL", "performance", "SharedArrayBuffer", "Atomics", "BigInt", "Proxy", "Reflect", "Iterator", "AggregateError", "escape"]) {
    t(`typeof ${g}`, () => typeof globalThis[g]);
  }
  t("Array.prototype.at", () => [1, 2, 3].at(-1));
  t("String.prototype.at", () => "abc".at(-1));
  t("replaceAll", () => "a-b-c".replaceAll("-", "+"));
  t("findLast", () => [1, 2, 3].findLast((x) => x < 3));
  t("findLastIndex", () => [1, 2, 3].findLastIndex((x) => x < 3));
  t("toSorted", () => [3, 1, 2].toSorted().join());
  t("toReversed", () => [3, 1, 2].toReversed().join());
  t("with", () => [3, 1, 2].with(0, 9).join());
  t("Object.groupBy", () => JSON.stringify(Object.groupBy([1, 2, 3], (x) => (x % 2 ? "odd" : "even"))));
  t("Map.groupBy", () => Map.groupBy([1, 2, 3], (x) => x % 2).size);
  t("Object.hasOwn", () => Object.hasOwn({ a: 1 }, "a"));
  t("Object.fromEntries", () => JSON.stringify(Object.fromEntries([["a", 1]])));
  t("flat/flatMap", () => [[1], [2, [3]]].flat(2).join() + "|" + [1, 2].flatMap((x) => [x, x]).join());
  t("Promise.withResolvers", () => typeof Promise.withResolvers);
  t("Set.union", () => (typeof Set.prototype.union === "function" ? new Set([1]).union(new Set([2])).size : "absent"));
  t("String.isWellFormed", () => "a\ud800".isWellFormed());
  t("Array.fromAsync", () => typeof Array.fromAsync);
  t("Error.cause", () => new Error("x", { cause: 1 }).cause);
  t("matchAll", () => Array.from("a1b2".matchAll(/\d/g)).map((m) => m[0]).join());

  // --- Intl / locale (QuickJS-ng has no Intl: toLocaleString falls back to toString)
  t("num.toLocaleString()", () => (1234567.891).toLocaleString());
  t("num.toLocaleString(en-US)", () => (1234.5).toLocaleString("en-US"));
  t("num.toLocaleString(opts)", () => (0.256).toLocaleString("en-US", { style: "percent" }));
  t("date.toLocaleString", () => new Date(Date.UTC(2026, 10, 24, 9, 30)).toLocaleString("en-US", { timeZone: "UTC" }));
  t("date.toLocaleDateString", () => new Date(Date.UTC(2026, 10, 24)).toLocaleDateString("en-US", { timeZone: "UTC" }));
  t("localeCompare", () => ["b", "a", "C", "ä"].sort((x, y) => x.localeCompare(y)).join());
  t("localeCompare(numeric)", () => "a10".localeCompare("a9", undefined, { numeric: true }));
  t("toLocaleUpperCase", () => "i".toLocaleUpperCase("tr"));

  // --- regex
  t("lookbehind", () => /(?<=\$)\d+/.exec("cost $42")[0]);
  t("neg lookbehind", () => "a1 b2".replace(/(?<!a)\d/g, "#"));
  t("named groups", () => /(?<y>\d{4})/.exec("in 2026").groups.y);
  t("dotAll s", () => /a.b/s.test("a\nb"));
  t("unicode prop", () => /\p{Lu}/u.test("Á"));
  t("sticky y", () => { const r = /a/y; r.lastIndex = 1; return r.test("ba"); });
  t("indices d", () => JSON.stringify(/b/d.exec("ab").indices[0]));
  t("v flag", () => new RegExp("[\\p{L}--[a-z]]", "v").test("A"));
  t("thousands regex", () => String(1234567).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  t("ctrl strip", () => "a\u0001b\u007fc".replace(/[\u0000-\u001f\u007f]/g, ""));

  // --- JSON
  t("JSON -0", () => JSON.stringify({ a: -0 }));
  t("JSON 1e21", () => JSON.stringify([1e21, 1e-7, 0.1 + 0.2, 5e-324, 1.7976931348623157e308]));
  t("JSON lone surrogate", () => JSON.stringify("\ud800"));
  t("JSON u2028", () => JSON.stringify(" "));
  t("JSON __proto__ key", () => { const o = JSON.parse('{"__proto__":{"x":1}}'); return [Object.keys(o).join(), Object.getPrototypeOf(o) === Object.prototype, o.x === undefined]; });
  t("JSON key order", () => JSON.stringify({ b: 1, 2: 1, a: 1, 1: 1, "-1": 1, "01": 1 }));
  t("JSON undefined/fn", () => JSON.stringify({ k: undefined, f() {}, s: Symbol("x"), n: null, arr: [undefined, () => 1] }));
  t("JSON NaN", () => JSON.stringify([NaN, Infinity, -Infinity]));
  t("JSON bigint parse", () => JSON.parse("12345678901234567890"));
  t("JSON Map", () => JSON.stringify(new Map([[1, 2]])));
  t("JSON indent", () => JSON.stringify({ a: [1] }, null, 1));
  t("JSON replacer drop", () => JSON.stringify({ nowMs: 1, w: 2, o: { nowMs: 3 } }, (k, v) => (k === "nowMs" ? undefined : v)));
  t("JSON parse dup", () => JSON.parse('{"a":1,"a":2}').a);
  t("JSON deep", () => { let o = []; for (let i = 0; i < 300; i++) o = [o]; return JSON.stringify(o).length; });

  // --- numbers
  const fixed = [[0.1, 20], [1.005, 2], [1.45, 1], [8.345, 2], [2.5, 0], [-1.5, 0], [-0.5, 0], [1e21, 2], [123.456, 1], [0.000001, 7], [1234.5678, 3], [99.995, 2], [0.045, 2], [1.255, 2], [10.235, 2]];
  t("toFixed", () => fixed.map(([x, d]) => x.toFixed(d)).join(" "));
  t("toPrecision", () => [1234.5678.toPrecision(6), (0.00001234).toPrecision(2), (1e21).toPrecision(3), (123).toPrecision(2)].join(" "));
  t("toExponential", () => [(123456).toExponential(2), (0).toExponential(), (1.5e-10).toExponential(3)].join(" "));
  t("toString edge", () => [1e21, 1e-7, 123456789012345680000, 0.000001, -0, 2 ** 53, 0.1 + 0.2, 1 / 3, 5e-324].map(String).join(" "));
  t("radix", () => [(255).toString(16), (0.5).toString(36), (35.99).toString(36), (-255).toString(2), (1e21).toString(36), (1295).toString(36), (0.1).toString(3)].join(" "));
  t("parse", () => [Number("0x1f"), parseInt("08"), parseInt("1e3"), parseFloat("1e3x"), Number(""), Number(" 12 "), Number("1_000"), parseInt("zz", 36), Number("0b101"), +"Infinity"].map(String).join(" "));
  t("Math.round", () => [-0.5, 0.5, 2.5, -2.5, 0.49999999999999994, 4503599627370495.5].map((x) => String(Math.round(x))).join(" "));
  t("Math misc", () => [Math.cbrt(27), Math.hypot(3, 4), Math.log10(1000), Math.log2(8), Math.expm1(1e-10), Math.sinh(1), Math.sign(-0), Math.trunc(-4.7), Math.fround(5.5), Math.clz32(1)].map(String).join(" "));
  t("Math.max empty", () => [Math.max(), Math.min(), Math.max(NaN, 1), Math.max(-0, 0)].map(String).join(" "));
  t("imul", () => [Math.imul(0x01000193, 0x811c9dc5), Math.imul(-1, 8)].join(" "));
  t("bit ops", () => [(0xffffffff ^ 0) >>> 0, ~~4294967295.5, 1 << 31, -1 >>> 0].join(" "));

  // libm: the exact pow / log patterns the engine uses (game/formulas.js, game/demo.js)
  const powPoints = [];
  const pow = [];
  for (let x = 1; x <= 300; x++) {
    pow.push(Math.pow(1.07, x - 1), Math.pow(1.06, x - 1), Math.pow(1.05, x - 1), Math.pow(1.03, x), Math.pow(x, 2.5), Math.pow(x + 1, 1.35), Math.pow(x, 1.5), Math.pow(36, (x % 8) + 1), Math.log(x), Math.log(x + 0.5), Math.sqrt(x), Math.exp(x / 30));
  }
  for (let x = 0.25; x < 120; x += 0.25) pow.push(Math.pow(1.07, x), Math.pow(x, 2.5), Math.pow(x, 0.5), Math.log(x));
  t("libm values", () => pow.length);
  t("libm digest", () => {
    let h = 0x811c9dc5;
    const s = pow.map(String).join(",");
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  });
  t("libm list", () => pow.map(String));

  // --- sort
  t("sort stable", () => {
    const a = [];
    for (let i = 0; i < 2000; i++) a.push({ k: i % 7, i });
    a.sort((x, y) => x.k - y.k);
    for (let i = 1; i < a.length; i++) if (a[i - 1].k === a[i].k && a[i - 1].i > a[i].i) return false;
    return true;
  });
  t("sort stable short", () => { const a = [3, 1, 2, 1, 3, 2].map((k, i) => ({ k, i })); a.sort((x, y) => x.k - y.k); return a.map((x) => x.i).join(); });
  t("sort default numbers", () => [10, 9, 1, 100, -1].sort().join());
  t("sort boolean cmp", () => { const a = [5, 1, 4, 2, 3, 9, 0, 8, 7, 6, 11, 15, 13, 12, 14, 10]; return a.slice().sort((x, y) => x > y).join(); });
  t("sort NaN cmp", () => [3, 1, 2, 5, 4].sort(() => NaN).join());
  t("sort undefined holes", () => JSON.stringify([3, undefined, 1, , 2].sort()));
  t("sort inconsistent", () => { const a = []; for (let i = 0; i < 40; i++) a.push((i * 37) % 23); return a.sort((x, y) => (x % 3) - (y % 5)).join(); });

  // --- Date
  t("Date.parse ISO date", () => Date.parse("2026-11-24"));
  t("Date.parse ISO local", () => Date.parse("2026-11-24T09:30:00") - Date.parse("2026-11-24T09:30:00Z"));
  t("Date.parse english", () => Date.parse("Nov 24, 2026"));
  t("Date.parse rfc", () => Date.parse("Tue, 24 Nov 2026 09:30:00 GMT"));
  t("Date.parse bad", () => String(Date.parse("not a date")));
  t("Date toISOString", () => new Date(Date.UTC(2026, 10, 24, 9, 30)).toISOString());
  t("Date toString", () => new Date(Date.UTC(2026, 10, 24, 9, 30)).toUTCString());
  t("Date range", () => [String(new Date(8.64e15 + 1).getTime()), new Date(-1).getUTCFullYear()].join(" "));
  t("Date tz", () => new Date(Date.UTC(2026, 10, 24)).getTimezoneOffset());
  t("Date UTC getters", () => { const d = new Date(Date.UTC(2026, 10, 24, 9, 30) - 300 * 60000); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCDay()].join(); });

  // --- strings
  t("case", () => ["ß".toUpperCase(), "İ".toLowerCase().length, "ǅ".toLowerCase()].join(" "));
  t("padStart", () => ["x".padStart(5, "ab"), "abc".padStart(2), "7".padStart(2, "0")].join("|"));
  t("surrogates", () => [String.fromCodePoint(0x1f600).length, [..."😀a"].length, "😀".split("").length, "a😀".slice(0, 2).length].join());
  t("substr", () => "abcdef".substr(-2, 1));
  t("trim", () => " ﻿ x  ".trim().length);
  t("normalize", () => "é".normalize("NFC").length);
  t("String(sym)", () => String(Symbol("x")));
  t("template", () => `${-0} ${[1, [2, 3]]} ${{}} ${null}`);

  // --- objects
  t("key order", () => Object.keys({ b: 1, a: 1, 1: 1, 0: 1, "-1": 1 }).join());
  t("for-in proto", () => { const o = Object.create({ inh: 1 }); o.own = 1; const k = []; for (const x in o) k.push(x); return k.join(); });
  t("Map order", () => { const m = new Map(); m.set("b", 1); m.set("a", 2); m.delete("b"); m.set("b", 3); return Array.from(m.keys()).join(); });
  t("frozen proto assign", () => { "use strict"; const o = {}; try { o.toString = () => "x"; return "assigned"; } catch (e) { return "THROWS " + e.name; } });
  t("frozen array assign", () => { "use strict"; const a = []; try { a.map = 1; return "assigned"; } catch (e) { return "THROWS " + e.name; } });
  t("Object.assign onto toString", () => { try { return typeof Object.assign({}, { toString: 1 }).toString; } catch (e) { return "THROWS " + e.name; } });
  t("spread toString", () => typeof { ...{ toString: 1 } }.toString);
  t("dict __proto__", () => { const d = {}; d["__proto__"] = 5; return [Object.keys(d).length, typeof Object.getPrototypeOf(d)].join(); });
  t("dict constructor", () => { "use strict"; const d = {}; try { d["constructor"] = 5; return "ok"; } catch (e) { return "THROWS " + e.name; } });

  // --- arrays
  t("array misc", () => [Array.from({ length: 3 }, (_, i) => i).join(), [, 1].includes(undefined), [NaN].includes(NaN), [NaN].indexOf(NaN), Array(3).fill(0).join()].join("|"));
  t("reduce empty", () => [].reduce((a, b) => a + b));
  t("array big", () => { const a = new Array(100000).fill(1); return a.length; });
  t("splice", () => { const a = [1, 2, 3, 4]; a.splice(-2, 1); return a.join(); });

  // --- errors / functions
  t("Function ctor", () => typeof Function("return 1"));
  t("eval", () => typeof globalThis.eval);
  t("setTimeout", () => setTimeout(() => {}, 1));
  t("fn.name", () => [(function foo() {}).name, (() => {}).name, class Bar {}.name].join());
  t("toString fn", () => (function (a) { return a; }).toString().length > 0);
  t("recursion 1000", () => { const f = (n) => (n ? 1 + f(n - 1) : 0); return f(1000); });
  return P;
})();
