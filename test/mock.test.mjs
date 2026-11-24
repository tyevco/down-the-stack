// Tests for the mock herdr runtime (tools/mock), the check (tools/check.mjs) and the preview.
// Each class of mistake the validator exists to catch has a test, plus a tiny valid mod end to end.

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const M = await import("../tools/mock/index.mjs");
const { div, svg, image, View } = await import("gpui-kit");
const { h_flex, Button } = await import("gpui-base");
const herdr = await import("herdr");
const { treeToHtml, unmappedMethods } = await import("../tools/preview/render.mjs");
const { runCheck } = await import("../tools/check.mjs");

const DEMO = path.join(M.REPO, "tools", "mock", "sample", "mods", "mockdemo", "main.js");
const HERO = "mods/mockdemo/art/hero.svg";
M.setAssetRoot("mods/mockdemo", path.dirname(DEMO));

/** Mount a throwaway View whose render is `fn(cx, view)`; render once. */
async function renderWith(fn, opts = {}) {
  M.resetState();
  class T extends View {
    init(p, cx) { this.n = 0; opts.init?.(cx, this); }
    render(cx) { this.n++; return fn(cx, this); }
  }
  const mod = await M.mountView(T, { props: { role: "test" }, ...opts });
  const tree = mod.render();
  return { mod, tree };
}

const codes = (mod) => mod.errors.map((e) => e.code);

/** A temporary mod folder (under a "mods/" path, so it counts as mod code). */
function tempMod(name, source) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mdr-mock-")), "mods", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main.js"), source);
  return path.join(dir, "main.js");
}

// ---------------------------------------------------------------------------------------------
// module surfaces

test("mock modules export exactly herdr's names", async () => {
  const dts = fs.readFileSync(path.join(M.REPO, "tools", "mock", "herdr.d.ts"), "utf8");
  const names = [...dts.matchAll(/export function (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(herdr).sort(), names);
  const allow = JSON.parse(fs.readFileSync(path.join(M.REPO, "tools", "api-allowlist.json"), "utf8"));
  assert.deepEqual(Object.keys(await import("gpui-kit")).sort(), [...allow.kit_exports].sort());
  assert.deepEqual(Object.keys(await import("gpui")).sort(), [...allow.gpui_alias_exports].sort());
  assert.deepEqual(Object.keys(await import("gpui-base")).sort(), [...allow.base_exports].sort());
});

test("default theme carries every herdr token as hex", () => {
  const t = herdr.theme();
  for (const k of ["background", "surface", "canvas", "chrome", "popover", "raised", "hover", "selected", "border", "input", "foreground", "muted", "dim", "accent", "accent_foreground", "solid", "solid_foreground", "selection", "working", "blocked", "done", "idle", "unknown", "ansi0", "ansi15"]) {
    assert.match(t[k], /^#[0-9a-f]{6}([0-9a-f]{2})?$/, k);
  }
  assert.equal(t.background, "#17191d"); // graphite
});

// ---------------------------------------------------------------------------------------------
// element validation

test("unknown element method throws a TypeError naming it", async () => {
  const { mod, tree } = await renderWith(() => div().p_4x());
  assert.equal(tree, null);
  assert.deepEqual(codes(mod), ["unknown-method"]);
  assert.match(mod.errors[0].message, /unknown element method `p_4x` \(did you mean `p_4`\?\)/);
  assert.throws(() => div().z_index(3), (e) => e instanceof TypeError && /z_index/.test(e.message));
});

test("colors must be #rgb/#rrggbb/#rrggbbaa", async () => {
  for (const ok of ["#abc", "#aabbcc", "#AABBCC80"]) assert.doesNotThrow(() => div().bg(ok).text_color(ok).border_color(ok).text_bg(ok));
  for (const bad of ["surface", "#12345", "rgb(1,2,3)", 0xffffff, "#ggg"]) {
    assert.throws(() => div().bg(bad), (e) => e.code === "bad-color", String(bad));
  }
  const { mod } = await renderWith(() => div().bg("surface"));
  assert.deepEqual(codes(mod), ["bad-color"]);
});

test("length grammar: auto, %, units per method family", () => {
  assert.doesNotThrow(() => div().w(10).h("50%").min_w("auto").left("1.5rem").top("-4px").m("auto"));
  assert.throws(() => div().p("auto"), (e) => e.code === "bad-length");
  assert.throws(() => div().gap("auto"), (e) => e.code === "bad-length");
  assert.throws(() => div().rounded("50%"), (e) => e.code === "bad-length");
  assert.throws(() => div().border("auto"), (e) => e.code === "bad-length");
  assert.throws(() => div().text_size("10%"), (e) => e.code === "bad-length");
  assert.throws(() => div().w("12em"), (e) => e.code === "bad-length");
  assert.throws(() => div().w(), /expects at least 1 argument/);
  assert.throws(() => div().font_weight(950), /between 100 and 900/);
  assert.throws(() => div().bg(div()), /unsupported argument type|not a color/);
});

test(".id() must be a string; tooltip a string", () => {
  assert.throws(() => div().id(3), (e) => e.code === "bad-id");
  assert.throws(() => div().tooltip(div()), TypeError);
  assert.doesNotThrow(() => div().id("x").tooltip("hi"));
});

test(".child(null|undefined) throws; .child(false) is an error but renders", async () => {
  let r = await renderWith(() => div().child(null));
  assert.deepEqual(codes(r.mod), ["null-child"]);
  r = await renderWith(() => div().children([div(), undefined]));
  assert.deepEqual(codes(r.mod), ["null-child"]);
  r = await renderWith(() => div().child("ok").child(false));
  assert.notEqual(r.tree, null, "herdr renders the word, so the render succeeds");
  assert.deepEqual(codes(r.mod), ["boolean-child"]);
  assert.equal(r.tree.text, "okfalse");
});

test("one element under two parents throws", async () => {
  const { mod } = await renderWith(() => {
    const shared = div();
    return div().child(shared).child(div().child(shared));
  });
  assert.deepEqual(codes(mod), ["reused-element"]);
  assert.throws(() => { const a = div(); a.child(a); }, (e) => e.code === "self-parent");
});

test("an element kept from a previous render is expired", async () => {
  const { mod, tree } = await renderWith((cx, view) => {
    if (!view.kept) view.kept = div().child("cached");
    return div().child(view.kept);
  });
  assert.notEqual(tree, null, "first render is fine");
  assert.equal(mod.render(), null, "second render reuses the element");
  assert.deepEqual(codes(mod), ["expired-element"]);
});

test("image()/svg() need both w and h", async () => {
  let r = await renderWith(() => div().child(image(HERO).w(24)));
  assert.deepEqual(codes(r.mod), ["image-size"]);
  r = await renderWith(() => div().child(svg(HERO).text_color("#fff")));
  assert.deepEqual(codes(r.mod), ["image-size"]);
  r = await renderWith(() => div().child(image(HERO).w(24).h(24)).child(svg(HERO).size(12)).child(image(HERO).size_full()));
  assert.deepEqual(r.mod.errors, []);
});

test("missing or unmapped image files are errors", async () => {
  let r = await renderWith(() => image("mods/mockdemo/art/nope.svg").size(10));
  assert.deepEqual(codes(r.mod), ["missing-image"]);
  r = await renderWith(() => image("/etc/passwd").size(10));
  assert.deepEqual(codes(r.mod), ["missing-image"]);
  r = await renderWith(() => image("mods/mockdemo/../x.svg").size(10));
  assert.deepEqual(codes(r.mod), ["missing-image"]);
});

test("motion policies", () => {
  assert.doesNotThrow(() => div().id("a").loop("top", { from: 0, to: 4, period: 100 }).transition("left", 900).transition("opacity", { duration: 300, delay: 10, easing: "linear" }).frames(["a", "b"], 16));
  assert.throws(() => div().loop("top", { from: 0, to: 4, period: 99 }), RangeError);
  assert.throws(() => div().loop("color", { from: 0, to: 1 }), (e) => e.code === "bad-motion");
  assert.throws(() => div().loop("top", { from: "0px", to: 4 }), (e) => e.code === "bad-motion");
  assert.throws(() => div().loop("top", { from: 0, to: 4, easing: "bounce" }), (e) => e.code === "bad-motion");
  assert.throws(() => div().transition("transform", 100), (e) => e.code === "bad-motion");
  assert.throws(() => div().frames(["a"], 15), RangeError);
  assert.throws(() => div().frames([], 100), (e) => e.code === "bad-motion");
  assert.throws(() => svg(HERO).spin(50), RangeError);
});

test("handlers on image()/svg() are dropped (an error), not fired", async () => {
  const hits = [];
  const { mod } = await renderWith(() => div().id("wrap").on_click(() => hits.push("wrap")).child(image(HERO).id("img").size(10).on_click(() => hits.push("img"))));
  assert.deepEqual(codes(mod), ["handler-on-image"]);
  mod.fire("img");
  assert.deepEqual(hits, ["wrap"]);
});

test("spin on a non-svg element is an error", async () => {
  const { mod } = await renderWith(() => div().spin(900));
  assert.deepEqual(codes(mod), ["spin-not-svg"]);
});

test("when() must return the element; hover collects styles only", async () => {
  assert.throws(() => div().when(true, () => {}), /when\(\.\.\.\) must return the element/);
  const { mod, tree } = await renderWith(() => div().id("b").hover((s) => s.bg("#335").on_click(() => {})));
  assert.deepEqual(tree.state.hover, [["bg", ["#335"]]]);
  assert.deepEqual(mod.warnings.map((w) => w.code), ["state-non-style"]);
  assert.throws(() => div().hover((s) => s.bg("blue")), (e) => e.code === "bad-color");
});

// ---------------------------------------------------------------------------------------------
// cx and lifecycle

test("cx.notify() during render throws", async () => {
  const { mod, tree } = await renderWith((cx) => { cx.notify(); return div(); });
  assert.equal(tree, null);
  assert.deepEqual(codes(mod), ["notify-in-render"]);
});

test("a kept cx is stale after its call returns", async () => {
  let kept;
  const { mod } = await renderWith((cx) => div().id("btn").on_click((e, cx) => { kept = cx; }));
  mod.fire("btn");
  assert.throws(() => kept.notify(), (e) => e.code === "stale-cx");
});

test("focus_handle / cx.new are refused in render", async () => {
  const { mod } = await renderWith((cx) => { cx.focus_handle(); return div(); });
  assert.deepEqual(codes(mod), ["not-in-render"]);
});

test("timers run on the manual clock; Date.now follows it", async () => {
  const start = Date.UTC(2026, 0, 1);
  const seen = [];
  const { mod } = await renderWith((cx, v) => div().child(`t${v.ticks ?? 0}`), {
    nowMs: start,
    init: (cx, v) => {
      v.ticks = 0;
      cx.timer.every(1000, (cx) => { v.ticks++; seen.push(Date.now() - start); cx.notify(); });
      cx.timer.after(2500, () => seen.push("after"));
    },
  });
  const r = await mod.tick(3000);
  assert.equal(r.fired, 4);
  assert.deepEqual(seen, [1000, 2000, "after", 3000]);
  assert.equal(mod.tree.text, "t3");
  assert.equal(Date.now(), start + 3000);
});

test("events bubble until stop_propagation; disabled blocks clicks", async () => {
  const hits = [];
  const { mod } = await renderWith(() =>
    div().id("outer").on_click(() => hits.push("outer")).child(
      div().id("inner").on_click((e, cx) => { hits.push("inner"); if (e.click_count > 1) cx.stop_propagation(); }),
    ).child(Button.new("off").disabled(true).on_click(() => hits.push("off"))),
  );
  mod.fire("inner");
  mod.fire("inner", { click_count: 2 });
  mod.fire("off");
  // A disabled button takes no click, but the click still reaches the parent's hitbox.
  assert.deepEqual(hits, ["inner", "outer", "inner", "outer"]);
});

// ---------------------------------------------------------------------------------------------
// herdr host calls

test("run() validates command names and arguments", async () => {
  M.resetState();
  const mod = await M.mountView(class extends View { render() { return div(); } }, { props: {} });
  await mod.flush();
  assert.throws(() => herdr.run("agent.focus", { terminl: "t1" }), /unknown argument\(s\): terminl; valid arguments: terminal/);
  assert.throws(() => herdr.run("pane.focus", { pane: 3 }), /must be a string/);
  herdr.run("agent.focuss", { terminal: "t1" });
  herdr.run("agent.focus", {});
  herdr.run("layout.resize", { id: "stage", px: 240 });
  herdr.run("app.zoom_in");
  assert.deepEqual(mod.errors.map((e) => e.code), ["bad-command", "bad-command"]);
  assert.match(mod.errors[0].message, /agent\.focuss.*unknown command/);
  assert.match(mod.errors[1].message, /`terminal` is missing/);
  assert.equal(M.calls().run.length, 6);
});

test("writeTextFile uses expected-text semantics; readTextFile reads it back", async () => {
  M.resetState();
  const p = `${herdr.appHome()}/data/mapledr/save.json`;
  assert.equal(await herdr.readTextFile(p), null);
  await herdr.writeTextFile(p, "{}", null);
  await assert.rejects(herdr.writeTextFile(p, "{\"a\":1}", null), /already exists/);
  await assert.rejects(herdr.writeTextFile(p, "{\"a\":1}", "stale"), /changed outside Herdr/);
  await herdr.writeTextFile(p, "{\"a\":1}", "{}");
  assert.equal(await herdr.readTextFile(p), "{\"a\":1}");
});

test("top-level host calls, setTimeout and check-mode fs denials are caught", async () => {
  M.resetState();
  let mod = await M.mountMod(tempMod("toplevel", `
    import { View, div } from "gpui-kit";
    import { appHome } from "herdr";
    const HOME = appHome();
    export default class X extends View { render() { return div().child(HOME); } }
  `));
  assert.ok(mod.errors.some((e) => e.code === "top-level-herdr"), JSON.stringify(mod.errors));

  M.resetState();
  mod = await M.mountMod(tempMod("timeout", `
    import { View, div } from "gpui-kit";
    export default class X extends View { init() { setTimeout(() => {}, 10); } render() { return div(); } }
  `));
  assert.ok(mod.errors.some((e) => e.code === "forbidden-global"), JSON.stringify(mod.errors));

  M.resetState({ checking: true });
  mod = await M.mountMod(tempMod("fsdeny", `
    import { View, div } from "gpui-kit";
    import { appHome } from "herdr";
    import * as fs from "fs/promises";
    export default class X extends View { init() { fs.readFile(appHome() + "/data/other/save.json", "utf8"); } render() { return div(); } }
  `), { checking: true });
  assert.ok(mod.errors.some((e) => e.code === "fs-denied"), JSON.stringify(mod.errors));
  M.setChecking(false);
});

// ---------------------------------------------------------------------------------------------
// a valid mod end to end

test("the sample mod passes the real-check path (checking, props null)", async () => {
  M.resetState({ checking: true });
  const mod = await M.mountMod(DEMO, { checking: true, fixture: M.checkFixture() });
  const tree = mod.render();
  assert.deepEqual(mod.errors, []);
  assert.equal(tree.text, "Mock demo");
  assert.equal(herdr.props(), null);
  assert.deepEqual(herdr.agents(), []);
  M.setChecking(false);
});

test("the sample mod renders, ticks, takes clicks and commands", async () => {
  M.resetState();
  const mod = await M.mountMod(DEMO, { props: { role: "stage" }, fixture: M.sampleFixture(3), nowMs: Date.UTC(2026, 10, 24) });
  const tree = mod.render();
  assert.deepEqual(mod.errors, []);
  assert.deepEqual(mod.warnings, []);
  assert.equal(tree.id, "root");
  assert.ok(mod.stats.lastRenderMs < 50);
  assert.equal(mod.size(1600, 210), 1);
  await mod.tick(2000);
  assert.match(mod.text(), /ticks 2 · width 1600/);
  mod.fire("row-t2");
  assert.deepEqual(M.calls().run.at(-1), { name: "agent.focus", args: { terminal: "t2" }, copy: mod.copy.label });
  herdr.run("mockdemo.ping"); // "<mod>.<command>" reaches every shown copy's nextCommand()
  await mod.tick(1);
  assert.match(mod.text(), /· ping/);
  assert.ok(mod.find("clicked"));
  await mod.close();
  assert.equal(mod.copy.alive, false);
});

test("copies mounted on one graph share module scope; props stay per copy", async () => {
  M.resetState();
  const src = tempMod("shared", `
    import { View, div } from "gpui-kit";
    import { props } from "herdr";
    let count = 0;
    export default class X extends View { init() { count++; this.role = props()?.role; } render() { return div().child(this.role + ":" + count); } }
  `);
  const a = await M.mountMod(src, { props: { role: "stage" }, graph: "one" });
  const b = await M.mountMod(src, { props: { role: "party" }, graph: "one" });
  const c = await M.mountMod(src, { props: { role: "hud" } });
  assert.equal(a.render().text, "stage:2");
  assert.equal(b.render().text, "party:2");
  assert.equal(c.render().text, "hud:1");
});

// ---------------------------------------------------------------------------------------------
// check and preview

test("runCheck passes the sample mod and reports missing inputs", async () => {
  const fx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mdr-fx-")), "fixtures.mjs");
  fs.writeFileSync(fx, `
    import { sampleFixture } from ${JSON.stringify(path.join(M.REPO, "tools", "mock", "samples.mjs"))};
    export const roles = [{ name: "stage", props: { role: "stage" }, fixture: sampleFixture(4) }, { name: "empty", props: { role: "party" } }];
  `);
  const res = await runCheck({ main: DEMO, fixtures: fx, widths: [360, 960], zooms: [1, 2] });
  assert.equal(res.exitCode, 0, JSON.stringify(res.errors, null, 1));
  assert.equal(res.roles.length, 2);
  assert.ok(res.roles[0].renders > 10);
  const missing = await runCheck({ main: path.join(os.tmpdir(), "nope", "main.js") });
  assert.equal(missing.exitCode, 2);
});

test("runCheck lint flags QuickJS-incompatible code", async () => {
  const main = tempMod("linty", `
    import { View, div } from "gpui-kit";
    import helper from "./helper";
    // setTimeout( in a comment is fine
    export default class X extends View { #secret = 1; render() { const s = "eval("; return div().child(String(structuredClone({}))); } }
  `);
  const res = await runCheck({ main, fixtures: path.join(os.tmpdir(), "none.mjs") });
  const lint = res.lint.map((l) => l.message).join("\n");
  assert.match(lint, /\.js extension/);
  assert.match(lint, /structuredClone/);
  assert.match(lint, /private #fields/);
  assert.doesNotMatch(lint, /setTimeout|eval/);
  assert.equal(res.exitCode, 1);
});

test("lint: top-level await, nested templates and regex literals", async () => {
  const main = tempMod("tla", [
    'import { View, div } from "gpui-kit";',
    'const data = await Promise.resolve(1);',
    'const f = async () => await Promise.resolve(2);',
    'const re = /["`]/g;',
    'const label = (a, b) => `${a ? `${b}#x;` : "eval("} done`;',
    'export default class X extends View { async init() { await null; } render() { return div().child(label(1, 2) + re.source + data); } }',
  ].join("\n"));
  const res = await runCheck({ main, fixtures: path.join(os.tmpdir(), "none.mjs") });
  const lint = res.lint.map((l) => l.message);
  assert.equal(lint.length, 1, lint.join("\n"));
  assert.match(lint[0], /main\.js:2: await at module top level/);
});

test("layout colors join theme(); zoom-2 sizes reach the mod as window px", async () => {
  M.resetState();
  M.setFixture({ layout: { colors: { mdr_gold: "#e3b04b", accent: "#123456" } } });
  assert.equal(herdr.theme().mdr_gold, "#e3b04b");
  assert.equal(herdr.theme().accent, "#123456");
  M.setFixture({ layout: { colors: { mdr_gold: "#e3b04b" } }, theme: { mdr_gold: "#000000" } });
  assert.equal(herdr.theme().mdr_gold, "#000000", "an explicit fixture theme wins");
  M.resetState();
  assert.equal(herdr.theme().mdr_gold, undefined);

  const seen = [];
  const main = tempMod("zoomsize", `
    import { View, div } from "gpui-kit";
    import { settings } from "herdr";
    export default class X extends View {
      render() {
        const z = settings().zoom;
        return div().id("root").on_size_change((s, cx) => { globalThis.__mdrSizes.push([z, s.width / z, s.height / z]); });
      }
    }
  `);
  globalThis.__mdrSizes = seen;
  const fx = path.join(path.dirname(main), "fixtures.mjs");
  fs.writeFileSync(fx, 'export const roles = [{ name: "s", props: { role: "stage" } }];');
  const res = await runCheck({ main, fixtures: fx, widths: [960], zooms: [1, 2] });
  assert.equal(res.exitCode, 0, JSON.stringify(res.errors));
  assert.deepEqual(seen, [[1, 960, 200], [2, 960, 200]]);
  delete globalThis.__mdrSizes;
});

test("NaN lengths and opacity are errors; out-of-range opacity is a warning", async () => {
  const { mod } = await renderWith(() => div().opacity(NaN).w(NaN).child(div().opacity(1.5)));
  assert.deepEqual(codes(mod), ["non-finite", "non-finite"]);
  assert.deepEqual(mod.warnings.map((w) => w.code), ["opacity-range"]);
});

test("preview maps a recorded tree to HTML", async () => {
  M.resetState();
  const mod = await M.mountMod(DEMO, { props: { role: "stage" }, fixture: M.sampleFixture(2) });
  const tree = mod.render();
  const html = treeToHtml(tree, { width: 960, height: 210 });
  assert.match(html, /<img [^>]*src="data:image\/svg\+xml;base64,/);
  assert.match(html, /mask:url\(&quot;data:image\/svg\+xml/);
  assert.match(html, /@keyframes lp\d+\{from\{top:0px\}to\{top:-2px\}\}/);
  assert.match(html, /animation:lp\d+ 600ms ease-in-out 0s infinite alternate/);
  assert.match(html, /data-frames="\[&quot;&gt;_&quot;,&quot;&gt; &quot;\]"/);
  assert.match(html, /preview: unmapped methods: none/);
  assert.deepEqual(unmappedMethods({ type: "div", methods: [["bogus_style", []], ["p", [4]]], children: [] }), ["bogus_style"]);
});

test("preview screenshots with Playwright", async (t) => {
  let pw;
  try { pw = createRequire(import.meta.url)("playwright"); } catch { return t.skip("playwright not installed"); }
  const { shoot } = await import("../tools/preview/shoot.mjs");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdr-shot-"));
  M.resetState();
  const { tree } = await renderWith(() => h_flex().size_full().bg("#203040").p(8).gap(6).child(image(HERO).w(24).h(24)).child(div().text_color("#ffffff").child("hello")));
  const [shot] = await shoot([{ name: "tiny", tree, width: 200, height: 40, userFacing: true }], { outDir });
  const png = fs.readFileSync(shot.file);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 400, "deviceScaleFactor 2 for user-facing shots");
});
