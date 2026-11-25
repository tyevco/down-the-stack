// ui/kit.js colour plumbing: theme colours herdr accepts in a theme override but the element
// bridge does not ("ff8800", "#ff8800 ") never reach .bg()/.text_color() (runtime-rules-4).

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const M = await import("../tools/mock/index.mjs");
const FX = await import("../tools/fixtures.mjs");
const { hex, T, C } = await import("../mods/down-the-stack/ui/kit.js");

test("hex(): trims, adds a missing '#', keeps valid lengths, else the fallback", () => {
  assert.equal(hex("#ff8800", "#000"), "#ff8800");
  assert.equal(hex("ff8800", "#000"), "#ff8800");
  assert.equal(hex(" #ff8800 ", "#000"), "#ff8800");
  assert.equal(hex("#f80", "#000"), "#f80");
  assert.equal(hex("ffffff18", "#000"), "#ffffff18");
  for (const bad of ["", "accent", "#ff88", "#ggghhh", "rgb(1,2,3)", null, undefined, 7, {}]) assert.equal(hex(bad, "#123456"), "#123456", String(bad));
});

test("T(): every token is a colour the element bridge accepts, whatever the theme map holds", () => {
  M.resetState();
  M.setFixture({ theme: { accent: "ff8800", border: "ffffff18 ", foreground: "#eeeeef", working: "nope", blocked: undefined } });
  const t = T();
  for (const [k, v] of Object.entries(t)) assert.match(v, /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, `${k}: ${v}`);
  assert.equal(t.accent, "#ff8800");
  assert.equal(t.border, "#ffffff18");
  assert.equal(t.fg, "#eeeeef");
  assert.equal(t.working, C.working, "an unusable value falls back");
});

test("roles that draw from T() keep rendering with a '#'-less theme override", async () => {
  const MAIN = path.join(M.REPO, "mods", "down-the-stack", "main.js");
  for (const props of [{ role: "party" }, { role: "hud" }, { role: "nameplate", pane: "p_sh", terminal: "t_sh" }]) {
    M.resetState();
    const fixture = { ...FX.demoFixture("mid", { shell: true }), theme: { accent: "ff8800", border: "ffffff18", foreground: "eeeeef", muted: "#a0a4ab " } };
    const mod = await M.mountMod(MAIN, { props, fixture, nowMs: FX.NOW });
    const host = (await mod.import("./host.js")).getHost();
    host.world = (await mod.import("./game/demo.js")).demoWorld("mid", FX.NOW).world;
    host.version++;
    mod.size(props.role === "hud" ? 960 : 268, props.role === "hud" ? 26 : 600);
    mod.render();
    // main.js catches a throwing render (the error chip): look at the host's record too
    assert.equal(mod.find("mdr-error-chip"), null, `${props.role}: ${host.debugText()}`);
    assert.deepEqual(host.errors.filter((e) => /render/.test(e.where)), [], props.role);
    assert.deepEqual(mod.errors, [], props.role);
  }
});

test("the stage's mdr_* tokens and the dialogs' herdr tokens go through hex() too", async () => {
  const MAIN = path.join(M.REPO, "mods", "down-the-stack", "main.js");
  const theme = { accent: "ff8800", foreground: "eeeeef", popover: "25272b", input: "ffffff24 ", solid: "nope", mdr_night_sky: "151126", mdr_night_horizon: "not a colour" };
  for (const props of [{ role: "stage" }, { role: "herd" }, { role: "sheet", heroId: 1 }]) {
    M.resetState();
    const fixture = { ...FX.demoFixture("mid", { shell: true }), theme };
    const mod = await M.mountMod(MAIN, { props, fixture, nowMs: FX.NOW });
    const host = (await mod.import("./host.js")).getHost();
    host.world = (await mod.import("./game/demo.js")).demoWorld("mid", FX.NOW).world;
    host.version++;
    mod.size(props.role === "stage" ? 960 : 760, props.role === "stage" ? 200 : 500);
    mod.render();
    assert.equal(mod.find("mdr-error-chip"), null, `${props.role}: ${host.debugText()}`);
    assert.deepEqual(host.errors.filter((e) => /render/.test(e.where)), [], props.role);
    assert.deepEqual(mod.errors, [], props.role);
  }
  const { dialogTokens } = await import("../mods/down-the-stack/ui/sheet.js");
  M.resetState();
  M.setFixture({ theme });
  const d = dialogTokens();
  assert.equal(d.popover, "#25272b");
  assert.equal(d.input, "#ffffff24");
  assert.equal(d.solid, undefined, "unusable: dialogTheme's fallback applies");
});

test("splitTail / middleCut: a name cut in the middle keeps both ends ('ceo-assi…res-2'), never half an emoji (round 4c)", async () => {
  const { splitTail, middleCut } = await import("../mods/down-the-stack/ui/kit.js");
  assert.deepEqual(splitTail("ceo-assistant-res-2"), ["ceo-assistant-", "res-2"], "a last part under 3 characters takes the one before");
  assert.deepEqual(splitTail("ceo-assistant-writer"), ["ceo-assistant-", "writer"]);
  assert.deepEqual(splitTail("ceo-assistant-lead"), ["ceo-assistant-", "lead"]);
  assert.deepEqual(splitTail("my project notes"), ["my project ", "notes"]);
  assert.deepEqual(splitTail("herdr-app"), ["herdr-", "app"]);
  assert.deepEqual(splitTail("docs"), ["docs", ""], "short: no tail");
  assert.deepEqual(splitTail("verylongsinglewordname"), ["verylongsingleword".slice(0, 16), "rdname"], "no separator: the last 6");
  assert.deepEqual(splitTail("platform-infrastructure"), ["platform-infrastr", "ucture"], "a last part over 8: the last 6");
  assert.deepEqual(splitTail("ceo-assistant-production-2"), ["ceo-assistant-produc", "tion-2"], "a short last part whose neighbour is too long: the last 6");
  const rocket = "\u{1F680}";
  for (const name of [`space${rocket}${rocket}${rocket}${rocket}`, `abcdefgh${rocket}ij`, `${rocket.repeat(9)}`, `a-b-${rocket}${rocket}`]) {
    const [h, t] = splitTail(name);
    assert.equal(h + t, name);
    assert.ok(h.isWellFormed() && t.isWellFormed(), `${JSON.stringify(name)} -> ${JSON.stringify([h, t])}`);
  }
  // the element: a head that truncates and a tail that never shrinks; the whole name on hover
  const el = M.nodeOf(middleCut("ceo-assistant-res-2", { id: "x", tooltip: true }));
  assert.equal(el.methods.find((m) => m[0] === "tooltip")?.[1][0], "ceo-assistant-res-2");
  const [head, tail] = el.children;
  assert.ok(head.methods.some((m) => m[0] === "truncate") && head.methods.some((m) => m[0] === "min_w"));
  assert.equal(head.children[0].text, "ceo-assistant-");
  assert.ok(tail.methods.some((m) => m[0] === "flex_none"));
  assert.equal(tail.children[0].text, "res-2");
  // a short name: one plain box, no tooltip
  const short = M.nodeOf(middleCut("docs", { tooltip: true }));
  assert.equal(short.children[0].text, "docs");
  assert.ok(short.methods.some((m) => m[0] === "truncate") && !short.methods.some((m) => m[0] === "tooltip"));
  // a name that surely fits its box (0.6 em a character) stays one plain box
  const fits = M.nodeOf(middleCut("ceo-assistant-res-2", { tooltip: true, room: 160, size: 11 }));
  assert.equal(fits.children[0].text, "ceo-assistant-res-2");
  assert.ok(!fits.methods.some((m) => m[0] === "tooltip"));
  assert.equal(M.nodeOf(middleCut("ceo-assistant-res-2", { room: 92, size: 11.5 })).children.length, 2, "92 px: split");
  // a head ending in a space keeps it as a no-break space (a text box drops a trailing space)
  assert.equal(M.nodeOf(middleCut("my project notes")).children[0].children[0].text, "my project ");
  // (reviewer) a roomier line takes a longer tail, as many trailing parts as fit: "…search-eng" and
  // "…billing-eng" stay apart where the default 8 leaves both "…eng"
  assert.deepEqual(splitTail("ceo-assistant-search-eng"), ["ceo-assistant-search-", "eng"]);
  assert.deepEqual(splitTail("ceo-assistant-search-eng", 12), ["ceo-assistant-", "search-eng"]);
  assert.deepEqual(splitTail("ceo-assistant-billing-eng", 12), ["ceo-assistant-", "billing-eng"]);
  assert.deepEqual(splitTail("ceo-assistant-res-2", 12), ["ceo-assistant-", "res-2"]);
  assert.deepEqual(splitTail("a-b-c-d-e-f-g-h-i-j", 12), ["a-b-c-d-", "e-f-g-h-i-j"], "the first part stays in the head");
  assert.deepEqual(splitTail("a-bcdefghijklmnop", 12), ["a-bcdefghij", "klmnop"], "no trailing parts within 12: the last 6");
  assert.equal(M.nodeOf(middleCut("ceo-assistant-billing-eng", { tail: 12 })).children[1].children[0].text, "billing-eng");
});
