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
const G = await import("../tools/mock/gates.mjs");

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

test("the sample programs are herdr's records (programs.json through programs.rs shown())", (t) => {
  // A wrong `tint` draws a full-colour icon as a one-colour mask: codex's white tile filled solid.
  const file = path.join(G.HERDR_SRC, "defaults", "programs.json");
  if (!fs.existsSync(file)) return G.skipGate(t, "the mock's sample programs against herdr's programs.json", G.herdrMissing());
  const table = JSON.parse(fs.readFileSync(file, "utf8")).programs;
  for (const [key, p] of Object.entries(M.PROGRAMS)) {
    const e = table[key];
    assert.ok(e, `${key}: not in herdr's programs.json`);
    assert.equal(p.key, key);
    assert.equal(p.name, p.shell ? p.name : e.name, `${key}: name`); // a shell is named after itself (zsh)
    assert.equal(p.icon, e.icon ?? null, `${key}: icon`);
    assert.equal(p.tint, e.tint ?? true, `${key}: tint`);
    assert.equal(p.tile, e.tile ?? null, `${key}: tile`);
    assert.equal(p.color, e.color ?? null, `${key}: color`);
    assert.equal(p.shell, key === "shell", `${key}: shell`);
    assert.equal(p.agent, key !== "shell", `${key}: agent`);
  }
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

test("a string with an unpaired surrogate (an emoji cut in half) throws wherever it crosses into herdr", async () => {
  // rquickjs String::to_string runs str::from_utf8 over the string's bytes: half a pair is not UTF-8.
  const cut = "Ship it now \ud83d"; // "🚀".slice(0, 1)
  const low = "\ude80 then";
  for (const s of [cut, low]) {
    assert.throws(() => div().tooltip(s), (e) => e.code === "bad-string" && /unpaired/.test(e.message));
    assert.throws(() => div().id(s), (e) => e.code === "bad-string");
    assert.throws(() => div().child(s), (e) => e.code === "bad-string");
    assert.throws(() => div().children(["ok", s]), (e) => e.code === "bad-string");
  }
  assert.doesNotThrow(() => div().id("ship-🚀").tooltip("Ship it now 🚀").child("🚀 rocket").child("✳ done"));
  const r = await renderWith(() => div().child(cut.slice(0, -1) + "…").tooltip("fine 👍"));
  assert.deepEqual(codes(r.mod), []);
  const bad = await renderWith(() => div().child(cut));
  assert.equal(bad.tree, null, "a render that throws draws nothing");
  assert.deepEqual(codes(bad.mod), ["bad-string"]);
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

test("no call on an element once it has a parent (herdr: AlreadyParented); a slot's element still takes styles", async () => {
  M.resetState();
  const p = div();
  const a = div();
  p.child(a);
  for (const call of [() => a.w(10), () => a.child(div()), () => a.on_click(() => {}), () => a.id("late"), () => a.hover((s) => s.bg("#000"))]) {
    assert.throws(call, (e) => e.code === "reused-element" && e instanceof TypeError, String(call));
  }
  const kids = div();
  div().children([kids]);
  assert.throws(() => kids.p(2), (e) => e.code === "reused-element");
  // the right order is fine, and so is styling an element given to a slot (herdr claims it)
  const b = div().w(10).child(div());
  div().child(b);
  const { Popover } = await import("gpui-base");
  const content = div();
  Popover.new("pop").trigger(div()).content(content);
  content.p(4).bg("#123456");
  // the Down the Stack roles never do it: every render tree builds bottom-up
  const { mod } = await renderWith(() => { const row = div(); const out = div().child(row); row.p(4); return out; });
  assert.deepEqual(codes(mod), ["reused-element"]);
});

test("state handles have herdr's surface and are refused while rendering", async () => {
  M.resetState();
  const { ScrollHandle, VirtualListScrollHandle, InputState, TextareaState, EditorState, SliderState, OtpState, CalendarState } = await import("gpui-base");
  const sh = ScrollHandle.new();
  assert.deepEqual(Object.keys(sh).sort(), ["__handle", "content_size", "offset", "release", "scroll_to_item", "viewport_size"]);
  assert.deepEqual(Object.keys(VirtualListScrollHandle.new()).sort(), ["__handle", "content_size", "offset", "release", "scroll_to_bottom", "scroll_to_item", "viewport_size"]);
  assert.deepEqual(sh.content_size(), { width: 0, height: 0 });
  for (const make of [() => ScrollHandle.new(), () => VirtualListScrollHandle.new(), () => InputState.new({}), () => TextareaState.new({}), () => EditorState.new({}), () => SliderState.new({}), () => OtpState.new(4), () => CalendarState.new()]) {
    const { mod } = await renderWith(() => { make(); return div(); });
    assert.deepEqual(codes(mod), ["not-in-render"], String(make));
  }
  // FocusHandle.focus() is a mutation herdr refuses in render; fine in init and handlers
  const { mod } = await renderWith((cx, view) => { view.fh.focus(); return div(); }, { init: (cx, view) => { view.fh = cx.focus_handle(); view.fh.focus(); } });
  assert.deepEqual(codes(mod), ["not-in-render"]);
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

test("<mod>.<command> reaches shown copies only; none shown is herdr's error toast", async () => {
  M.resetState();
  const src = tempMod("shown", `
    import { View, div } from "gpui-kit";
    import { nextCommand, checking } from "herdr";
    export default class X extends View {
      init(p, cx) { this.got = []; if (checking()) return; cx.spawn(async (t) => { for (;;) { this.got.push(await nextCommand()); t.notify(); } }); }
      render() { return div().child(this.got.join(",")); }
    }
  `);
  const a = await M.mountMod(src, { props: {}, graph: "s", name: "shown" });
  const b = await M.mountMod(src, { props: {}, graph: "s", name: "shown" });
  b.hide();
  herdr.run("shown.tick");
  await M.flush();
  assert.deepEqual(a.view.got, ["tick"]);
  assert.deepEqual(b.view.got, [], "a hidden copy keeps running but gets no command");
  assert.deepEqual(M.calls().toasts, []);
  a.hide();
  herdr.run("shown.tick");
  await M.flush();
  assert.deepEqual(M.calls().toasts.map((t) => t.title), ["shown.tick failed"]);
  assert.ok(M.globalErrors().some((e) => e.code === "no-mod-copy") || a.errors.some((e) => e.code === "no-mod-copy") || b.errors.some((e) => e.code === "no-mod-copy"));
  // a hidden copy is not drawn by tickAll; shown again, it is
  b.hide(false);
  const r = b.copy.renders;
  await M.tickAll(10);
  assert.equal(b.copy.renders, r + 1);
  assert.equal(a.copy.renders, 0);
});

test("IO trouble hooks: readError rejects a read, hangAfterWrite lands a write that never settles", async () => {
  M.resetState();
  const f = `${M.APP_HOME}/data/x/a.txt`;
  M.setFixture({ readError: (p) => (p === f ? "os error 32" : null), hangAfterWrite: (p) => p === f });
  const mod = await M.mountView(class extends View { render() { return div(); } }, { props: {} });
  await mod.flush();
  await assert.rejects(herdr.readTextFile(f), /os error 32/);
  let settled = false;
  herdr.writeTextFile(f, "landed", null).then(() => { settled = true; }, () => { settled = true; });
  await M.flush();
  assert.equal(M.memfs.readText(f), "landed");
  assert.equal(settled, false);
});

test("exec: the machine's ls and rm run on the mock file system; a fixture's exec replaces them; a bad timeout throws as herdr's does", async () => {
  M.resetState();
  const dir = `${M.APP_HOME}/data/x`;
  M.memfs.write(`${dir}/b.txt`, "b", { mkdirs: true });
  M.memfs.write(`${dir}/a.txt`, "a", { mkdirs: true });
  const mod = await M.mountView(class extends View { render() { return div(); } }, { props: {} });
  await mod.flush();
  assert.deepEqual(await herdr.exec("ls", ["-1", "--", dir]), { code: 0, stdout: "a.txt\nb.txt\n", stderr: "" });
  const gone = await herdr.exec("ls", ["-1", "--", `${dir}/nope`]);
  assert.equal(gone.code, 2);
  assert.match(gone.stderr, /No such file/);
  assert.deepEqual(await herdr.exec("rm", ["-f", "--", `${dir}/a.txt`, `${dir}/missing`], { timeout: 5000 }), { code: 0, stdout: "", stderr: "" });
  assert.equal(M.memfs.readText(`${dir}/a.txt`), undefined);
  assert.equal((await herdr.exec("rm", ["--", `${dir}/missing`])).code, 1, "without -f a missing file fails");
  assert.deepEqual(await herdr.exec("git", ["status"]), { code: 0, stdout: "", stderr: "" }, "anything else: no output");
  assert.throws(() => herdr.exec("ls", [dir], { timeout: 0 }), /positive number of milliseconds/);
  M.updateFixture({ exec: (command) => { throw new Error(`cannot run ${command}: program not found`); } });
  await assert.rejects(herdr.exec("ls", [dir]), /cannot run ls/);
  assert.equal(M.calls().exec.length, 7);
});

test("gates: HERDR_SRC comes from the environment; a gate that cannot run prints one line and skips, or fails with STRICT_GATES=1", async () => {
  const { spawnSync } = await import("node:child_process");
  const cfg = path.join(M.REPO, "tools", "mock", "config.mjs");
  const src = (env) => spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(cfg)}).then((m) => console.log(m.HERDR_SRC))`], { encoding: "utf8", env: { ...process.env, ...env } }).stdout.trim();
  assert.equal(src({ HERDR_SRC: "/elsewhere/herdr-app" }), "/elsewhere/herdr-app");
  // (NODE_TEST_CONTEXT would make a child `node --test` report to this runner instead of printing)
  const { HERDR_SRC: _drop, NODE_TEST_CONTEXT: _ctx, STRICT_GATES: _strict, ...rest } = process.env;
  assert.equal(spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(cfg)}).then((m) => console.log(m.HERDR_SRC))`], { encoding: "utf8", env: rest }).stdout.trim(), path.resolve(M.REPO, "..", "herdrdev", "herdr-app"), "a herdrdev/herdr-app checkout next to the repo by default");
  // a test file whose gate cannot run (a herdr source that is not there)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdr-gate-"));
  const file = path.join(dir, "gate.test.mjs");
  fs.writeFileSync(file, `import { test } from "node:test";
import { skipGate, herdrSource, herdrMissing } from ${JSON.stringify(path.join(M.REPO, "tools", "mock", "gates.mjs"))};
test("a herdr gate", (t) => { if (!herdrSource()) return skipGate(t, "a herdr gate", herdrMissing()); });
`);
  const run = (env) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], { encoding: "utf8", env: { ...rest, HERDR_SRC: path.join(dir, "no-herdr"), ...env } });
  const lax = run({});
  assert.equal(lax.status, 0, lax.stdout + lax.stderr);
  const said = lax.stdout.split("\n").filter((l) => l.includes("SKIPPED GATE: a herdr gate"));
  assert.ok(said.some((l) => l.includes(`herdr 0.1.17 source not found at ${path.join(dir, "no-herdr")}; set HERDR_SRC`) && l.includes("STRICT_GATES=1")), lax.stdout);
  assert.match(lax.stdout, /# skipped 1/);
  const strict = run({ STRICT_GATES: "1" });
  assert.equal(strict.status, 1, strict.stdout);
  assert.match(strict.stdout, /SKIPPED GATE: a herdr gate .*STRICT_GATES=1 makes a skipped gate a failure/);
  assert.match(strict.stdout, /# fail 1/);
  // and with the source there, the gate runs
  assert.equal(run({ HERDR_SRC: G.HERDR_SRC }).stdout.includes("SKIPPED GATE"), !G.herdrSource());
});

test("timers let go of closed copies; reloadAll gives every copy one new module scope", async () => {
  M.resetState();
  const src = tempMod("reloadall", `
    import { View, div } from "gpui-kit";
    import { checking } from "herdr";
    export const SCOPE = {};
    export default class X extends View {
      init(p, cx) { if (!checking()) cx.timer.every(1000, () => {}); }
      render() { return div(); }
    }
  `);
  const mods = [];
  for (let i = 0; i < 20; i++) mods.push(await M.mountMod(src, { props: {}, graph: "r" }));
  assert.equal(M.clock.timers.length, 20);
  for (const m of mods.slice(2)) await m.close();
  assert.equal(M.clock.timers.length, 2, "closed copies' timers are dropped, not kept as cancelled");
  const [a, b] = mods;
  const s0 = (await a.import("./main.js")).SCOPE;
  await M.reloadAll([a, b]);
  const sa = (await a.import("./main.js")).SCOPE;
  const sb = (await b.import("./main.js")).SCOPE;
  assert.notEqual(sa, s0, "re-evaluated");
  assert.equal(sa, sb, "one module scope for both copies");
  assert.equal(M.clock.timers.length, 2, "the old builds' timers are gone, the new ones run");
  await M.tickAll(3000);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test("per-VM globals: a load that spans another VM's reload reads and writes its own VM's (herdr: one VM per window)", async () => {
  // A copy's task sleeps, then reads globalThis[Symbol.for("<mod>.…")]: meanwhile another VM
  // reloads. In herdr the two VMs never share globalThis; the read must see this VM's value.
  M.resetState();
  const src = tempMod("vmglobals", `
    import { View, div } from "gpui-kit";
    import { props, checking } from "herdr";
    const KEY = Symbol.for("vmglobals.live.v1");
    export default class X extends View {
      init(p, cx) {
        const me = props()?.who;
        this.before = globalThis[KEY] ?? null;
        if (!checking()) cx.spawn(async (tcx) => {
          await tcx.sleep(1000);
          this.late = globalThis[KEY] ?? null;
          globalThis[KEY] = me + "-late";
        });
        if (props()?.write) globalThis[KEY] = me;
      }
      render() { return div(); }
    }
  `);
  const a = await M.mountMod(src, { props: { who: "A", write: true }, graph: "vm-a" });
  assert.equal(a.view.before, null, "a new VM has none");
  const b = await M.mountMod(src, { props: { who: "B" }, graph: "vm-b" });
  assert.equal(b.view.before, null, "nor does another window's VM");
  await M.reloadAll([a]); // window A's VM is entered while B's task sleeps
  assert.equal(a.view.before, "A", "a reload keeps its VM's globals");
  await M.tickAll(2000);
  assert.equal(b.view.late, null, "B's continuation never sees A's value");
  assert.equal(a.view.late, "A", "A's own continuation does");
  const a2 = await M.mountMod(src, { props: { who: "A2" }, graph: "vm-a" });
  assert.equal(a2.view.before, "A-late", "a write from A's task stays A's");
  const b2 = await M.mountMod(src, { props: { who: "B2" }, graph: "vm-b" });
  assert.equal(b2.view.before, "B-late", "and B's late write is B's");
  assert.equal(Object.getOwnPropertySymbols(globalThis).includes(Symbol.for("vmglobals.live.v1")), false, "never an own global");
  M.resetState();
  const c = await M.mountMod(src, { props: { who: "C" }, graph: "vm-a" });
  assert.equal(c.view.before, null, "a reset forgets every VM's");
  assert.deepEqual([...a.errors, ...b.errors, ...a2.errors, ...b2.errors, ...c.errors], []);
});

// Budgets under load: npm test runs files in parallel, and other work (a browser taking previews)
// can hold the CPU. Waiting for a CPU must never put a callback over herdr's budget; work must.
/** Busy until both `ms` of this process's CPU time and `ms` of wall time have passed (work, under any load). */
function spin(ms) {
  const c0 = process.cpuUsage();
  const t = performance.now();
  for (let c = { user: 0, system: 0 }; (c.user + c.system) / 1000 < ms || performance.now() - t < ms; c = process.cpuUsage(c0)) { /* busy */ }
}
/** Blocked for `ms` of wall time without using a CPU (what another process holding the CPU looks like from here). */
function wait(ms) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const t = performance.now();
  while (performance.now() - t < ms) Atomics.wait(cell, 0, 0, Math.max(1, ms - (performance.now() - t)));
}

test("budgets: the stopwatch counts work, not time spent waiting for a CPU", () => {
  const a = M.stopwatch();
  spin(30);
  assert.ok(a.ms() >= 30, `CPU work counts (${a.ms().toFixed(1)} ms)`);
  const b = M.stopwatch();
  wait(60);
  assert.ok(b.wall() >= 59, "the wall clock moved");
  assert.ok(b.ms() < 20, `waiting does not count (${b.ms().toFixed(1)} ms)`);
});

test("budgets: a render that waits past 50 ms is not over budget; one that works past it is", async () => {
  const slow = await renderWith(() => { wait(80); return div().child("x"); });
  assert.deepEqual(codes(slow.mod), [], "waiting only");
  assert.ok(slow.mod.stats.lastRenderWallMs >= 79 && slow.mod.stats.lastRenderMs < M.BUDGET.render, JSON.stringify(slow.mod.stats));
  assert.equal(slow.mod.warnings.filter((w) => w.code === "slow-render").length, 0);
  const busy = await renderWith(() => { spin(80); return div().child("x"); });
  assert.deepEqual(codes(busy.mod), ["budget"]);
  assert.match(busy.mod.errors[0].message, /^render took \d+\.\d ms \(herdr's budget is 50 ms\)/);
});

test("budgets: a timer callback or a handler that waits past 500 ms is not over budget", async () => {
  const { mod } = await renderWith(() => div().id("b").on_click(() => wait(520)).child("b"), {
    init: (cx) => cx.timer.every(1000, () => wait(520)),
  });
  await mod.tick(1000);
  mod.fire("b");
  assert.deepEqual(mod.errors, []);
  const busy = await renderWith(() => div().id("b").on_click(() => spin(520)).child("b"));
  busy.mod.fire("b");
  assert.deepEqual(codes(busy.mod), ["budget"]);
  assert.match(busy.mod.errors[0].message, /^on_click handler took \d+\.\d ms \(budget 500 ms\)/);
});

test("module evaluation: herdr's budget is 500 ms (the load runs in a Task scope)", () => {
  assert.equal(M.BUDGET.module, 500);
  assert.ok(M.BUDGET.moduleWarn < M.BUDGET.module);
});

test("writeTextFile uses expected-text semantics; readTextFile reads it back", async () => {
  M.resetState();
  const p = `${herdr.appHome()}/data/down-the-stack/save.json`;
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
  // --role that names no fixture and no role checks nothing: never a pass
  const typo = await runCheck({ main: DEMO, fixtures: fx, role: "stagee", widths: [360], zooms: [1] });
  assert.equal(typo.roles.length, 0);
  assert.equal(typo.exitCode, 2);
  assert.match(typo.missing.join(" "), /a role named "stagee" \(a role: stage, party/);
  const one = await runCheck({ main: DEMO, fixtures: fx, role: "party", widths: [360], zooms: [1] });
  assert.equal(one.exitCode, 0);
  assert.deepEqual(one.roles.map((r) => r.name), ["empty"]);
});

test("check's command line refuses an argument it does not know, or one without its value (exit 2)", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (...args) => spawnSync(process.execPath, ["--import", path.join(M.REPO, "tools", "mock", "register.mjs"), path.join(M.REPO, "tools", "check.mjs"), ...args], { encoding: "utf8", timeout: 60000 });
  for (const args of [["--bogus-flag"], ["--rol", "party"], ["--role"], ["--widths", "wide"], ["--zooms", "--json"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage: /);
  }
  assert.equal(run("--help").status, 0);
});

test("npm run qjs refuses an argument it does not know, or one without its value (exit 2), before it runs anything", async (t) => {
  const { spawnSync } = await import("node:child_process");
  try { await import("quickjs-emscripten"); } catch { return G.skipGate(t, "npm run qjs usage errors", "the QuickJS-ng devDependencies are not installed: npm install"); }
  const run = (...args) => spawnSync(process.execPath, [path.join(M.REPO, "tools", "qjs", "run.mjs"), ...args], { encoding: "utf8", timeout: 60000 });
  for (const args of [["--stict"], ["--only"], ["--ticks", "--strict"], ["--seconds", "x"], ["--only", "nope"], ["lint"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
  }
});

test("runCheck: a stage render over 400 elements or 150 animated nodes fails its role; other roles only warn", async () => {
  // a mod whose tree grows with its width: 50 plain boxes, 450 at 2000+ px, and 160 of them
  // looping at 3000+ px (the stage's budget, D§11.9.7); at 960 px, 420 from its second timer tick
  const main = tempMod("budgety", `
    import { View, div } from "gpui-kit";
    import { settings } from "herdr";
    export default class X extends View {
      init(p, cx) { this.w = 960; this.t = 0; cx.timer.every(1000, (tcx) => { this.t++; tcx.notify(); }); }
      render() {
        const n = this.w >= 2000 ? 450 : this.t >= 2 ? 420 : 50;
        const anim = this.w >= 3000 ? 160 : 0;
        const kids = [];
        for (let i = 0; i < n; i++) {
          const d = div().id("b" + i).w(4).h(4);
          kids.push(i < anim ? d.loop("opacity", { from: 0.5, to: 1, period: 900 }) : d);
        }
        return div().id("root").size_full().on_size_change((s, cx) => { this.w = s.width / settings().zoom; cx.notify(); }).children(kids);
      }
    }
  `);
  const fx = path.join(path.dirname(main), "fixtures.mjs");
  fs.writeFileSync(fx, 'export const roles = [{ name: "stage", props: { role: "stage" }, widths: [960, 2400, 3200] }, { name: "party", props: { role: "party" }, widths: [3200] }];');
  const res = await runCheck({ main, fixtures: fx, zooms: [1] });
  assert.equal(res.exitCode, 1);
  const [stage, party] = res.roles;
  const budget = stage.errors.filter((e) => e.code === "stage-budget");
  assert.deepEqual(budget.map((e) => `${e.ctx}: ${e.message}`), [
    "zoom 1 width 960: tick 2: a stage render built 421 elements at 960×200 window px (budget 400, D§11.9.7)",
    "zoom 1 width 2400: size+render: a stage render built 451 elements at 2400×200 window px (budget 400, D§11.9.7)",
    "zoom 1 width 3200: size+render: a stage render built 451 elements at 3200×200 window px (budget 400, D§11.9.7)",
    "zoom 1 width 3200: size+render: a stage render animates 160 nodes at 3200×200 window px (budget 150, D§11.9.7)",
  ], "each distinct overflow once, renders from timers included");
  assert.deepEqual(stage.stage, { elements: 451, animated: 160 });
  assert.deepEqual(party.errors, [], "the budget is the stage's");
  assert.ok(party.warnings.some((w) => w.code === "many-elements"));
});

test("the check's fixtures include an ultrawide stage and the 30-hero herd (with a boss fight)", async () => {
  const FX = await import("../tools/fixtures.mjs");
  const stages = FX.roles.filter((r) => r.props?.role === "stage");
  assert.ok(stages.some((r) => r.kind === "late" && r.widths?.includes(3200)), "a 3200 px stage on the largest demo herd");
  const thirty = stages.find((r) => r.kind === "stress30");
  assert.ok(thirty && [960, 1600, 3200].every((w) => thirty.widths.includes(w)), "the 30-hero stage at 960 to 3200 px");
  assert.ok(FX.roles.some((r) => r.kind === "stress30" && r.props.role === "party"));
  const live = FX.stressFixture();
  assert.equal(live.agents.length, 30);
  assert.equal(live.terminals.filter((t) => t.parent).length, 15, "every sixth agent has three sub-agents");
  const G = {
    Demo: await import("../mods/down-the-stack/game/demo.js"), W: await import("../mods/down-the-stack/game/world.js"),
    liveHeroes: (await import("../mods/down-the-stack/game/agents.js")).liveHeroes,
    ...(await import("../mods/down-the-stack/game/items.js")), ...(await import("../mods/down-the-stack/game/herd.js")),
  };
  const { world, snapshot } = FX.stressWorld(G, FX.NOW);
  assert.equal(world.state.heroes.length, 30);
  assert.equal(world.rt.live.size, 30, "every hero is bound to a live agent");
  assert.ok(world.rt.fights.length >= 1, "a zone boss fight runs");
  assert.deepEqual(snapshot.agents.map((a) => a.address), live.agents.map((a) => a.address), "the live data is the world's own");
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

test("preview: svg() keeps the colour it was built with; SVG images are rasterised at 2× intrinsic size", () => {
  const tree = {
    type: "div", methods: [["text_color", ["#ff0000"]]], state: { hover: [["text_color", ["#00ff00"]]] }, slots: {},
    children: [
      { type: "svg", src: HERO, methods: [["w", [10]], ["h", [10]]], children: [], state: {}, slots: {} },
      { type: "image", src: HERO, methods: [["w", [300]], ["h", [300]]], children: [], state: {}, slots: {} },
    ],
  };
  const html = treeToHtml(tree, { width: 320, height: 320 });
  assert.match(html, /background-color:#ff0000/, "a fixed fill, not currentColor (a parent's :hover must not recolour it)");
  assert.doesNotMatch(html, /background-color:currentColor/);
  assert.match(html, /<img [^>]*data-raster="\d+x\d+"/);
  assert.match(html, /window\.__previewReady=/);
});

test("preview screenshots with Playwright", async (t) => {
  let pw;
  try { pw = createRequire(import.meta.url)("playwright"); } catch { return G.skipGate(t, "preview screenshots", "Playwright is not installed"); }
  const { shoot } = await import("../tools/preview/shoot.mjs");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdr-shot-"));
  M.resetState();
  const { tree } = await renderWith(() => h_flex().size_full().bg("#203040").p(8).gap(6).child(image(HERO).w(24).h(24)).child(div().text_color("#ffffff").child("hello")));
  const [shot] = await shoot([{ name: "tiny", tree, width: 200, height: 40, userFacing: true }], { outDir });
  const png = fs.readFileSync(shot.file);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 400, "deviceScaleFactor 2 for user-facing shots");
});

test("layout.toggle / .show / .hide / .resize act on the fixture's layout like herdr (window.rs), copy on write", async () => {
  M.resetState();
  const layout = { id: "root", type: "row", children: [
    { id: "stage", type: "block", size: { px: 200 }, content: { mod: "laymod", props: { role: "stage" } } },
    { id: "side", type: "block", size: { px: 268 } },
  ] };
  const src = tempMod("laymod", `
    import { View, div } from "gpui-kit";
    import { layout } from "herdr";
    export default class X extends View { render() { const s = layout()?.children?.[0]; return div().child(s && s.hidden ? "hidden" : "shown"); } }
  `);
  const mod = await M.mountMod(src, { props: { role: "stage" }, fixture: { layout } });
  mod.render();
  herdr.run("layout.hide", { id: "stage" });
  assert.equal(M.fixture().layout.children[0].hidden, true);
  assert.equal(layout.children[0].hidden, undefined, "the test's own object is untouched");
  assert.equal(mod.copy.hidden, true, "the mod block's copy is hidden with it");
  herdr.run("layout.toggle", { id: "stage" });
  assert.equal(M.fixture().layout.children[0].hidden, false);
  assert.equal(mod.copy.hidden, false);
  assert.equal(mod.copy.dirty, true, "a copy that reads layout() re-renders");
  mod.render();
  assert.ok(mod.text().includes("shown"));
  herdr.run("layout.resize", { id: "side", px: 44 });
  assert.deepEqual(M.fixture().layout.children[1].size, { px: 44 });
  // a node the shown layout lacks: herdr fails the command with a toast
  herdr.run("layout.show", { id: "hud" });
  assert.ok(mod.errors.some((e) => e.code === "bad-command" && /no node "hud"/.test(e.message)));
  assert.deepEqual(M.calls().toasts.map((t) => t.title), ["layout.show failed"]);
});

test("notify(): recorded with its action checked; reported while checking() or with a sound", async () => {
  M.resetState();
  const mod = await M.mountView(class extends View { render() { return div(); } }, { props: {} });
  await mod.flush();
  herdr.notify({ title: "The Deadlock Hydra: FIXED", body: "x", level: "success", action: { name: "mod.open", args: { name: "down-the-stack" } } });
  assert.equal(M.calls().notify.length, 1);
  assert.throws(() => herdr.notify({ title: "x", action: { name: "mod.open", args: { nam: "y" } } }), /unknown argument/);
  assert.throws(() => herdr.notify({ title: "x", level: "loud" }), /level must be/);
  herdr.notify({ title: "x", sound: "ding" });
  M.setChecking(true);
  herdr.notify({ title: "y" });
  M.setChecking(false);
  assert.deepEqual(mod.errors.map((e) => e.code), ["sound", "notify-in-check"]);
});
