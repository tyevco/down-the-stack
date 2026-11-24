# tools/mock — a Node stand-in for herdr's mod runtime

We cannot run herdr-app here, so this folder fakes the parts a mod touches, **strictly**: where herdr
throws, the mock throws (same wording); where herdr silently misbehaves (a `false` child, an unsized
image, a missing file), the mock records an error. Built from herdr's source; see
`docs/herdr-notes/gpui-api.md` and `runtime.md`. ARCHITECTURE §7 is the contract.

## Commands

```sh
npm run check                 # = node --import ./tools/mock/register.mjs tools/check.mjs
npm run preview               # = ... tools/preview/shoot.mjs   → out/*.png (+ .html)
npm run windows -- --roles    # = ... tools/preview/windows.mjs → out/window-<kind>.png (real demo
                              #   worlds through host.view and the renderers, 2×), out/real-*.png;
                              #   --preview also writes preview.png (the mid window), --only mid,boss
node --test test/mock.test.mjs
```

`check.mjs` lints the mod, runs the real `herdr-app check` path (checking, `props()` null, empty
lists), then every role in `tools/fixtures.mjs` at widths 360/960/1600 × zoom 1/2 with 3 s of timers
(widths/heights are logical block sizes; `on_size_change` gets them × zoom, as herdr reports window px).
The lint also refuses top-level `await`. With a layout in the fixture, its root `colors` (`mdr_*`)
join `theme()`, as in herdr. Every render of a `stage` role, timers' renders included, must stay within
400 elements and 150 animated nodes (`loop` / `transition` / `frames` / `spring`; D§11.9.7), or the
role fails with `stage-budget` (the mock itself only warns above 400 elements, for any role); the
per-role line prints the stage's maxima.
Flags: `--role stage`, `--widths 960`, `--zooms 1`, `--json`, `--quiet`, `--main`, `--fixtures`.
Exit 0 = pass, 1 = errors, 2 = `main.js` or the fixtures module is missing.

## Fixtures (`tools/fixtures.mjs`, owned by integration)

```js
import { demoFixture, demoWorldOf, NOW } from "./fixtures.mjs";
export const roles = [
  // live data = herdr's shapes built from demoWorld("mid", NOW).snapshot (agents, panes, terminals,
  // spaces, focused, layout), so the 1 s pump keeps every hero bound and nameplates find theirs
  { name: "stage-mid", props: { role: "stage" }, nowMs: NOW, fixture: demoFixture("mid"),
    world: async ({ nowMs, mod }) => (await mod.import("./game/demo.js")).demoWorld("mid", nowMs).world },
    // = demoWorldOf("mid"); put on getHost().world before render; mod.import() loads from the mod's own module graph
  { name: "nameplate-agent", props: { role: "nameplate", pane: "p_t1", terminal: "t1" }, fixture: demoFixture("mid"), world: demoWorldOf("mid") },
  { name: "sheet-gear", props: { role: "sheet", overlay: "o1", heroId: 1, tab: "gear" }, widths: [760], ... },
];
```

The real file covers the stage × every demo kind, a 3200 px stage (`stage-late-3200`), the 30-hero
herd with a boss fight (`stressWorld`, kind `stress30`: `tools/qjs/stress30.js`, the recipe `npm run qjs` builds too: the
stage at 960/1600/3200 px, the party, the Herd panel's roster), party (full, crowded, empty, rail),
nameplates (agent panes, a Contractor, a shell pane, a mod pane, a hero pane while the save loads),
the HUD, sheets (several heroes and tabs, a Contractor) and every Herd panel tab.
`liveFromSnapshot(snap, extra)` turns any demo snapshot into live data. Fixtures are lazy getters,
cached per demo kind.

Role fields: `name`, `props`, `kind` (the world: a demo kind or `stress30`; `npm run qjs` builds the
same one), `fixture` (live data, below), `world` (object or function),
`setup({ mod, host, mock })`, `height`, `widths`, `zooms`, `nowMs`, `preview: {width, height}`.
Fixture fields: `agents panes terminals spaces focused layout window placement machines theme
settings fonts keys knownAgents props nowMs`, `files: { "/mock/home/data/down-the-stack/save.json": text }`
(seeds the in-memory FS), `shared: {key: value}`, `exec: (cmd, args, opts) => result`.
`theme` may be a preset name or a partial map over graphite; `settings` merges over herdr's defaults.

## Using it in tests

Mod files import bare `"gpui-kit"`, `"herdr"`, … so register the hooks first, then load mod code
with **dynamic** `import()` (static imports resolve before `register` runs):

```js
import "../tools/mock/register.mjs";
const M = await import("../tools/mock/index.mjs");
const { div } = await import("gpui-kit");

M.resetState();                                         // fixture, copies, FS, clock, calls
const mod = await M.mountMod("mods/down-the-stack/main.js", { props: { role: "stage" }, fixture: M.sampleFixture(3), nowMs: 0 });
const tree = mod.render();            // serialisable tree, or null if render threw (see mod.errors)
mod.size(960, 210);                   // on_size_change on the root (window px; mods divide by zoom)
await mod.tick(1000);                 // run due timers on the manual clock; re-renders if notified
mod.fire("hero-1");                   // on_click on .id("hero-1"), bubbling; (e, cx) like herdr
mod.fire("x", { button: "left" }, "mouse_down"); mod.hover("x"); await mod.command("sheet");
M.calls().run;                        // recorded run()/openOverlay()/notify()/setAgentOrder()/...
mod.errors; mod.warnings; mod.stats;  // [{level, code, message, phase, copy}], render ms, nodes
```

- `mountView(Class, opts)` mounts a View class without a file (handy for renderer unit tests).
- Copies share module scope only when mounted with the same `graph` key (herdr has one VM; the
  default gives each mount a fresh module graph, like a VM restart). `mod.import("./host.js")`
  loads another file from the same graph. `M.reloadAll([a, b, ...])` = hot reload as herdr does it
  (one new module scope for every copy of the VM, new instances, old tasks and timers cancelled,
  no `close()`); `mod.reload()` reloads one copy alone; `mod.close()`. `globalThis[Symbol.for(
  "<mod>.…")]` is per VM: it survives a reload, not a fresh graph (another window or a restart).
- `mod.hide()` / `mod.hide(false)`: a hidden copy (a hidden block) keeps its timers but does not
  render and gets no `<mod>.<command>`; with no shown copy, `run("<mod>.x")` is an error
  (`no-mod-copy`: herdr shows a "<mod>.x failed" toast) and lands in `M.calls().toasts`.
- `run("layout.toggle" | "layout.show" | "layout.hide" | "layout.resize", {id, ...})` acts on the
  fixture's `layout` like herdr (`window.rs` dispatch): it sets the node's `hidden` (or `size`) on a
  copy of the layout (the test's own object is untouched), hides or shows the mounted copies of a
  mod block there, and re-renders the copies that read `layout()`. A node the layout lacks is a
  `bad-command` error and a "<cmd> failed" toast.
- IO trouble: fixture `readError(absPath)` → an Error (or text) rejects that read;
  `hangAfterWrite(absPath)` → true lands that write but never settles its promise (the calling
  copy went away mid-write).
- `setFixture()` replaces live data, `updateFixture()` merges (marks copies that read those keys
  dirty), `setChecking(true)` = `herdr-app check` behaviour, `setClock(ms)` freezes `Date.now()`.
  `Date.now()` follows the mock clock (`tick` advances it); `new Date()` stays real time.
- `appHome()` is `/mock/home`, `home()` is `/mock/user`; `readTextFile`/`writeTextFile` and
  `fs/promises` (for files under `mods/`) share an in-memory FS (`M.memfs`). Reads under
  `/mock/home/mods/down-the-stack/...` fall through to the repo, read-only.
- Asset paths (`image()`/`svg()`) resolve like herdr's (relative to the app home):
  `mods/down-the-stack/...` → this repo, `icons/...` → herdr's shipped icons; `setAssetRoot()` adds more.

## What is enforced

Thrown, as herdr does (error `code` in parentheses): unknown element method (`unknown-method`, with
"did you mean"); bad color (`bad-color`: only `#rgb|#rrggbb|#rrggbbaa`) on `bg text_color text_bg
border_color` and in state styles; bad length (`bad-length`: `auto` refused by `p* gap*`, `%`/`auto`
by `border* rounded* text_size`); non-string `.id()` / `.tooltip()`; objects as arguments;
`.child(null|undefined)` (`null-child`); one element under two parents (`reused-element`); an element
from a previous render (`expired-element`); any call on an element that already has a parent
(`reused-element`: herdr's `AlreadyParented`; build an element fully, then attach it); motion policy (`bad-motion`: property in opacity|width|
height|left|top, loop period ≥ 100, frames ≥ 16 ms, spin ≥ 100, easing names); `when()` returning
nothing; `cx.notify()` / `focus_handle()` / `cx.new()` / `FocusHandle.focus()` and creating state
(`InputState`/`TextareaState`/`EditorState`/`SliderState`/`OtpState`/`CalendarState`.new,
`ScrollHandle.new`, `VirtualListScrollHandle.new`) during render or a list's item renderer
(`notify-in-render`, `not-in-render`); a kept call-scoped cx (`stale-cx`); `run()` with unknown or mistyped arguments;
`setTimeout`/`setInterval`/`structuredClone` called from mod code (`forbidden-global`); `fs/promises`
outside granted roots (`fs-denied`, narrowed during check); imports herdr lacks (`node:*`, JSON).

Recorded as errors (herdr would not throw, but it is a bug): `.child(true|false)` (`boolean-child`),
`image()`/`svg()` without both w and h (`image-size`), missing/unmapped/`..`/URL asset
(`missing-image`), NaN/Infinity lengths (`non-finite`), `spin()` on a non-svg (`spin-not-svg`),
unknown command name or missing required argument in `run()` (`bad-command`), any host call at
module top level (`top-level-herdr`), handlers on `image()`/`svg()` (`handler-on-image`: herdr drops them), `notify()` while checking (`notify-in-check`) or with a `sound` field (`sound`), `writeTextFile` while checking (`write-in-check`) or under
`mods/` (`write-under-mods`), `setShared` in render, throwing handlers/timers/tasks, budgets (render
50 ms, init/event/timer 500 ms, module 500 ms: herdr evaluates a mod inside the load's Task scope,
which gets the event budget, close 250 ms). A callback's time is the lower of its wall time and the
process's CPU time over it (`stopwatch()` in `state.mjs`; `stats.lastRenderWallMs` keeps the wall
time): a machine busy with other work (parallel test files, a browser taking previews) adds wall
time but no CPU time, so it cannot push a callback over a budget, while real work counts in both.

Warnings: duplicate `.id()` in one render, transition without `.id()`, `frames()` with children,
non-style calls in `hover()`, args to nullary styles, a second loop on one property, `playSound`,
SVG files using `<text>`, render > 10 ms or module evaluation > 150 ms under V8 (QuickJS is
slower), > 400 elements per render.

Scroll handles have herdr's surface only: `offset()`, `content_size()`, `viewport_size()`,
`scroll_to_item()`, `release()`, plus `scroll_to_bottom()` on a `VirtualListScrollHandle`.

Not modelled: layout/paint, real QuickJS speed, frozen built-in prototypes (check.mjs lints for
literal writes to them; `npm run qjs` runs the mod in QuickJS-ng with herdr's sandbox prelude,
frozen prototypes included), private `#fields`/static blocks (linted).

`herdr.d.ts` and `herdr-commands.md` are verbatim copies from herdr-app 0.1.17 and parts of
`elements.mjs` are ported from gpui-kit, all Apache-2.0: see `NOTICE` and `LICENSE-APACHE-2.0`.

## Files

`register.mjs`/`hooks.mjs` (module mapping) · `herdr.mjs` · `gpui-kit.mjs`, `gpui.mjs`,
`gpui-base.mjs`, `gpui-fps.mjs`, `gpui-shell.mjs`, `gpui-component.mjs` · `elements.mjs` (builder +
validator + tree) · `validate.mjs` (argument grammar) · `view.mjs` (View, cx, timers) ·
`harness.mjs` (mount/render/tick/fire) · `state.mjs` (fixture, clock, sink) · `memfs.mjs`,
`fs-promises.mjs` · `theme.mjs` (herdr presets) · `samples.mjs` (sample live data) ·
`index.mjs` (public API) · `sample/mods/mockdemo` (a tiny valid mod). Preview: `tools/preview/`
(`render.mjs` tree → HTML, `window.mjs` mock herdr window, `shoot.mjs` Playwright PNGs).
