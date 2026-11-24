// ui/kit.js colour plumbing: theme colours herdr accepts in a theme override but the element
// bridge does not ("ff8800", "#ff8800 ") never reach .bg()/.text_color() (runtime-rules-4).

import "../tools/mock/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const M = await import("../tools/mock/index.mjs");
const FX = await import("../tools/fixtures.mjs");
const { hex, T, C } = await import("../mods/mapledr/ui/kit.js");

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
  const MAIN = path.join(M.REPO, "mods", "mapledr", "main.js");
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
  const MAIN = path.join(M.REPO, "mods", "mapledr", "main.js");
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
  const { dialogTokens } = await import("../mods/mapledr/ui/sheet.js");
  M.resetState();
  M.setFixture({ theme });
  const d = dialogTokens();
  assert.equal(d.popover, "#25272b");
  assert.equal(d.input, "#ffffff24");
  assert.equal(d.solid, undefined, "unusable: dialogTheme's fallback applies");
});
