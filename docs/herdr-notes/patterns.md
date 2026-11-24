# Shipped-mod patterns for the herdr idle-RPG mod

Source-only digest of the mods shipped in herdr-app master (~0.1.17).
All paths below are relative to `/home/user/herdrdev/herdr-app/defaults/`
unless they start with `src/` (herdr-app Rust) or `vendor/` (herdr-app/vendor).
Runtime JS lives in `vendor/gpui-kit/crates/shell/src/engine/quickjs/mod.rs` (cited as `quickjs/mod.rs`); `materialize.rs` = `vendor/gpui-kit/crates/shell/src/materialize.rs`; `scheduler.rs` = `vendor/gpui-kit/crates/shell/src/engine/quickjs/scheduler.rs`.
"SNIPPET (ours)" = code written for our game from the shipped patterns, not shipped code.
UNCONFIRMED = could not prove from source.

Companion file: `used-methods.txt` (every element-builder method used in shipped JS, one per line).

---

## 0. One-screen cheat sheet

| Need | Shipped idiom | Where |
|---|---|---|
| List agents | `agents()` -> `{address, pane, space, space_name, tab, tab_index, tab_name, status, app, program, title, pane_name, seq, pinned, focused}` | `herdr.d.ts:177-203` |
| Status values | `"working" \| "blocked" \| "done" \| "idle"` (sub-agents from `terminals()` also `"error"`) | `herdr.d.ts:101`, `mods/agents/main.js:57-61` |
| Status color | `theme()[status]` -> `t.working/t.blocked/t.done/t.idle` | `mods/agents/main.js:213` |
| Working spinner | `svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)` | `mods/agents/main.js:214` |
| Text spinner | `div().frames(["⠋","⠙",...], 90)` | `mods/peek/main.js:11,85` |
| Blink/pulse | `.loop("opacity", { from: 0, to: 1, period: 900 })` | `mods/win98/taskbar.js:420` |
| Bob up/down | `.relative().loop("top", { from: 0, to: u(-5), period: 800 })` | `mods/win98/clippy.js:72-75` |
| Program icon | `p.tint ? svg(p.icon).size(n).text_color(c) : image(p.icon).w(n).h(n)` | `mods/agents/main.js:79-82` |
| Go to agent | `run("agent.focus", { terminal: a.address })` or `run("pane.focus", { pane: a.pane })` | `mods/win98/taskbar.js:411`, `mods/agents/main.js:364` |
| Nav order | `setAgentOrder(list.map(a => a.address))` in render | `mods/agents/main.js:249` |
| Pane header finds itself | `panes().find(p => p.pane === props()?.pane)` | `mods/pane/main.js:41-43` |
| Floating mod side | `placement()?.edge` | `mods/win98/clippy.js:41` |
| Cross-role state | win98: `shared("win98.x")` / `setShared("win98.x", v)` (persisted, re-renders every mod). **For our game (critic):** module-scope variables are already shared live by every copy of the mod (runtime.md §1, Critic verification Q1); use `shared` only for rare persisted signals | `mods/win98/kit.js:418-427`, `herdr.d.ts:495-499` |
| Floating window | `openOverlay({ mod, kind: "window", frame: "none", key, props })` | `mods/win98/taskbar.js:186` |
| Timer | `this.t = cx.timer.every(ms, (cx) => {...; cx.notify(); })`, `this.t.cancel()` | `mods/win98/mines.js:33,64-68` |
| Sound | `playSound("mods/<mod>/sounds/x.mp3")` behind a mute check | `mods/win98/kit.js:407-413` |
| Clicks inside a draggable thing | `own(el)` = `el.on_mouse_down("left", (_e, cx) => cx.stop_propagation())` | `mods/win98/kit.js:139-142` |

---

## 1. Reading `agents()` — status, color, animation, icons, focus, order, sub-agents, pinned

### 1.1 Data shape and semantics
- `agents(): AgentInfo[]` — "Terminals whose program reports a status (agents), in space, tab, pane order. Live." (`herdr.d.ts:202-203`). Fields `herdr.d.ts:177-200`. `seq`: "Higher = changed more recently" (`:195-196`). `pinned` via `terminal.pin` (`:197-198`). `focused` (`:199`).
- `Status = "working" | "blocked" | "done" | "idle"` (`herdr.d.ts:101`). `done` = "finished while you weren't looking; it becomes idle once you look (here or on another Herdr client)" (`herdr.d.ts:185-187`, `AGENTS.md:158-161`).
- Urgency order used everywhere: blocked > done > working > idle (`AGENTS.md:160-161`, `herdr.d.ts:147`). Shipped rank table:
  ```js
  // mods/agents/main.js:53
  const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
  ```
- Mods re-render automatically when agents/spaces/terminals/focus/theme/shared change — "Don't poll those" (`AGENTS.md:1054-1057`).
- Every host read copies the whole list into JS: read once per render (`mods/agents/main.js:287`, `mods/spaces/main.js:23`).

### 1.2 "done" vs "idle" (important for XP/loot triggers)
The agents mod treats done and idle as the same state for "time since change", because looking at an agent turns done into idle:
```js
// mods/agents/main.js:98-113
// Stamps agents whose state changed. Done and idle count as one: looking at a
// finished agent turns done into idle, and looking isn't the agent doing anything.
track(list, now) {
  let dirty = false;
  for (const a of list) {
    const s = a.status === "done" ? "idle" : a.status;
    if (this.changed[a.address]?.s === s) continue;
    this.changed[a.address] = { s, at: now };
    dirty = true;
  }
  if (!dirty) return;
  const listed = new Set(list.map((a) => a.address));
  for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
  localStorage.setItem("changed", JSON.stringify(this.changed));
}
```
It is loaded in `init` with defensive parsing (`mods/agents/main.js:88-90`) and re-rendered every 30 s for the "3m" labels: `cx.timer.every(30000, (cx) => cx.notify())` (`:95`).
Game implication: a "working -> done/idle" transition = a finished turn (reward); `done` may flip to `idle` at any time without the agent doing work, so never reward the done->idle flip.

### 1.3 Visual per status (agents list)
```js
// mods/agents/main.js:211-220
status(t, a, compact = false) {
  const color = t[a.status] ?? t.dim;
  if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
  if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
  // Idle: a ring; done: a dot.
  if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
}
```
Same vocabulary in the pane header (`mods/pane/main.js:84-86`), tabs (`mods/tabs/main.js:122-123`), picker (`mods/picker/main.js:121-122`).
Text glyphs (peek): `working: SPIN frames, idle: "○", other status: "●", none: "·"` and words `{ working: "working", blocked: "needs you", done: "finished", idle: "idle" }` (`mods/peek/main.js:11,17,75,85,88`).
win98 uses badges instead: `working -> "hourglass"` (opacity loop 0.35..1, 1400 ms), `blocked -> "warn-badge"` (opacity loop 0..1, 900 ms), `done -> "check-badge"` (`mods/win98/taskbar.js:283,305,404,420`; `mods/win98/desktop.js:56,76`).

The spinner asset (`mods/workspace-chrome/spinner.svg`): a 24x24 `stroke="currentColor"` ring (opacity .24) plus a quarter arc — so `text_color()` tints it and `.spin(900)` rotates it.

### 1.4 Program icons (tint vs image)
`Program` = `{ key, name, icon, tint, tile, color, shell, agent }`; "Draw icon with svg(icon) in a color when tint (a one-color glyph), else image(icon). tile/color: a colored tile with the glyph on it" (`herdr.d.ts:159-175`). Icon paths are home-relative, e.g. `"icons/claude.svg"` (`herdr.d.ts:168`).
```js
// mods/agents/main.js:78-82 (same in mods/pane/main.js:27-30, mods/peek/main.js:13-16)
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}
// used as: .when(Boolean(pic), el => el.child(pic))   (never .child(null): see §9)
```
win98's tile variant (good for a character "portrait"):
```js
// mods/win98/kit.js:211-225
export function programIcon(u, program, size = 16) {
  if (!program || program.shell || program.key === "shell" || !program.icon) return icon(u, "dos", size);
  if (program.tint) {
    return div().flex_none().w(u(size)).h(u(size)).bg(program.tile ?? C.navy)
      .flex().items_center().justify_center()
      .child(svg(program.icon).w(u(size - 4)).h(u(size - 4)).text_color(program.color ?? C.white));
  }
  return image(program.icon).flex_none().w(u(size)).h(u(size));
}
```
Fallback names: `a.program?.name ?? a.app ?? "Agent"` (`mods/win98/taskbar.js:410`, `mods/win98/clippy.js:44`).

### 1.5 Focusing an agent
- `run("agent.focus", { terminal: a.address })` — "(sub-agents too)" (`herdr.d.ts:86`); used by win98 tray (`mods/win98/taskbar.js:411`), Clippy (`mods/win98/clippy.js:52`), task manager (`mods/win98/dialog.js:515`).
- `run("pane.focus", { pane: a.pane })` — agents list rows (`mods/agents/main.js:320,364`).
- Sub-agent row: `this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : run("terminal.peek", { terminal: k.address })` (`mods/agents/main.js:169-171,202`).
- Peek bar's keep/go: `run(home ? "pane.focus" : "terminal.keep", { terminal })` (`mods/peek/main.js:95`).
- Currently shown agent: `focused()?.agent` (`mods/agents/main.js:231`).

### 1.6 Navigation order
```js
// mods/agents/main.js:245-249
if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
const pinned = list.filter((a) => a.pinned);
const rest = list.filter((a) => !a.pinned);
list = [...pinned, ...rest];
setAgentOrder(list.map((a) => a.address));
```
`setAgentOrder` sets order for `agent.next/prev/select` (`herdr.d.ts:247-251`, `AGENTS.md:174-178`). Only ONE mod should call it (the last call wins). If our party sidebar replaces the agents mod, call it there; otherwise leave it alone.

### 1.7 Sub-agents / parent from `terminals()`
`terminals()` = every core terminal (`address, argv, name, template, parent, labels, state, status (plain word), report, program, ...`) (`herdr.d.ts:253-260`). Sub-agents are terminals started by an agent via `hc run`; `parent` = starter's address (`AGENTS.md:162-167`). A sub-agent without a pane is NOT in `agents()`; a kept one (with a pane) is.
```js
// mods/agents/main.js:54-61
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  if (listed.has(k.address)) return listed.get(k.address);
  const s = k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
// mods/agents/main.js:173-183 — live descendants, depth first
tree(all, addr, lead = []) {
  const kids = all.filter((k) => k.parent === addr && k.state === "live");
  return kids.flatMap((k, i) => {
    const last = i === kids.length - 1;
    return [{ t: k, lines: [...lead, last ? "└" : "├"] }, ...this.tree(all, k.address, [...lead, last ? "" : "│"])];
  });
}
```
Name fallback for kids: `k.name || k.template || k.program?.name || k.address` (`mods/agents/main.js:207`). Parent urgency = max(own rank, kids' ranks with done->idle) (`:242-243`). Game idea: sub-agents = summons/pets of their parent character.
Remote agents: address contains `/` (`"vps/t7"`), machine = prefix (`mods/agents/main.js:306-307`).

### 1.8 Pinned
- `a.pinned` (`herdr.d.ts:197-198`); toggle `run("terminal.pin", { terminal: a.address, pinned: !a.pinned })` (`mods/agents/main.js:338`); the label `terminals()[i].labels["herdr.pinned"]` (`:122`).
- After a click that moves the row, clear hover state yourself: "The row moves away from under the pointer, and no hover-out comes." (`mods/agents/main.js:339-341`).

### 1.9 "Agent needs you" news (Clippy)
```js
// mods/win98/clippy.js:29-35
news() {
  const list = agents()
    .filter((a) => (a.status === "blocked" || a.status === "done") && !a.focused)
    .filter((a) => !this.dismissed.has(`${a.address}:${a.status}`))
    .sort((a, b) => (a.status === "blocked") - (b.status === "blocked") || a.seq - b.seq);
  return list.pop() ?? null;   // blocked first, then most recent
}
// dismissed keys are cleaned once the agent left that status: clippy.js:64-68
```

---

## 2. Pane header mods

### 2.1 Layout config and props
```json
// layouts/main.json:111-131 (pane frame with header)
"pane": { "gap": 8, "radius": 10, "background": "background", "lone": true,
  "border": { "width": 1, "color": "border" }, "focus": { "width": 1, "color": "accent" },
  "header": { "content": { "mod": "pane" }, "height": 30, "position": "top", "reveal": "always" } }
```
- Header struct: `reveal` "always" (default) | "hover"; `height` px, **default 30**; `position` "top" (default) | "bottom" (`src/layout.rs:259-270`). `reveal: "hover"` draws it over the terminal so the terminal never resizes (`AGENTS.md:420-422`).
- Heights shipped: main 30 (`layouts/main.json:128`), terminals 38 (`layouts/terminals.json:38`), win98 `25.714` in JSON, re-fitted at runtime to `18 * scale / zoom` (`layouts/win98.json:37`, `mods/win98/kit.js:465-467`).
- The header mod gets `props().pane` and `props().terminal`, one copy per pane (`AGENTS.md:410-412`, `mods/pane/main.js:5`). Header height is a "click" (person-adjustable) field (`AGENTS.md:225-226`, `src/layout_sync.rs:324-340`).
- The root must fill the slot: `h_flex().size_full()` (`mods/pane/main.js:68-70`) / `div().size_full().flex().flex_col()` (`mods/win98/window.js:54`). Everything (icon 14, text 12, badge h 18) must fit the header height; the pane mod uses `.px(10).gap(8).items_center().text_size(12)` and an 18 px badge for a 30 px header.
- AGENTS.md calls `pane` "an example pane header, not used by the default layouts" (`AGENTS.md:954-955`) but `layouts/main.json:126` does use it. Trust the JSON.

### 2.2 Finding its pane and reading facts
```js
// mods/pane/main.js:41-43, 59-67
me() { return panes().find((p) => p.pane === props()?.pane); }
render(cx) {
  const t = theme();
  const p = this.me();
  if (!p) return div();
  const name = p.name || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
  const st = p.status;            // Status | null
  const pane = p.pane;
  const bottom = paneFrame(layout())?.header?.position === "bottom";
```
`PaneInfo` = `{ pane, terminal (null for mod panes), mod?, tab, title, name, cwd, branch, status, app, program, focused, zoomed, movable, scroll? }` (`herdr.d.ts:217-241`). For a mod pane only pane/mod/tab/title/name/focused/zoomed are set (`:219-220`); win98 handles it: `p.mod ? icon(u, "programs", 16) : programIcon(...)` (`mods/win98/window.js:44`).
To map a pane to its agent: `agents().find(a => a.pane === p.pane)` (agent has `pane`, `herdr.d.ts:179`) or `a.address === p.terminal`. SNIPPET-level inference; shipped header mods only use `p.status`.

### 2.3 Frame position from `layout()`
```js
// mods/pane/main.js:11-25 — first visible tab frame, including a stack's active child
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) { const frame = paneFrame(child); if (frame) return frame; }
  return null;
}
// used: .when(bottom, el => el.border_t(1)).when(!bottom, el => el.border_b(1))   (pane/main.js:75-76)
```
Generic finder used by several mods: `find(layout(), "sidebar")?.size?.px` (`mods/agents/main.js:7-17`).

### 2.4 Pane commands from the header
```js
// mods/pane/main.js:45-57, 87-91
button(t, id, icon, command, args) {
  return div().id(id).p(3).rounded(4).text_color(t.dim)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
    .child(svg(`mods/pane/${icon}.svg`).size(14));
}
.on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })   // buttons only while hovered
.on_click(() => run("pane.focus", { pane }))
.when(this.hovered, el => el
  .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
  .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
  .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
  .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
```
win98 window title bar: min = `run("tab.settle", { id: p.tab })`, max/restore = `pane.zoom {pane}`, close = `pane.close {pane}`, click = `pane.focus`, double-click = `pane.zoom`, right-click = window menu (`mods/win98/window.js:28-53`). Ids include the pane id so copies don't collide (`pw-${id}`, `ph-r-${pane}`).
Active/inactive look: `const active = Boolean(p?.focused)` -> blue vs gray gradient (`mods/win98/window.js:26`, `mods/win98/kit.js:265`).

---

## 3. win98 `kit.js` — the shared drawing kit (one mod, many roles)

### 3.1 Roles dispatch
```js
// mods/win98/main.js:23-36
const ROLES = { taskbar: Taskbar, desktop: Desktop, window: PaneWindow, menu: Menu, dialog: Dialog, mines: Mines, sol: Sol, clippy: Clippy };
export default class Win98 extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    const R = ROLES[pr.role];
    this.role = R ? new R() : null;
    this.role?.init?.(pr, cx);
  }
  render(cx) {
    if (!this.role) return div().child(`win98: no role "${props()?.role}"`);
    return this.role.render(cx);
  }
}
```
Role classes are plain classes (not `View`), with `init(p, cx)` / `render(cx)`. `close(cx)` is NOT forwarded (win98 has no cleanup). Layout gives each block `content: { mod: "win98", props: { role: "..." } }` (`layouts/win98.json:12-16,30-34,64-68,78-83`). `mod.json` is `{ "place": "none" }` (`mods/win98/mod.json`) — "none: only where a layout or another mod puts it" (`AGENTS.md:934-936`).
Module code is shared by all copies of the mod (all roles) (`AGENTS.md:1058-1060`) — so `kit.js` constants are shared; instance state stays in role instances.

### 3.2 Pixel units: `scale()`, `unit()`, zoom
```js
// mods/win98/kit.js:40-51
export function scale() { const k = shared("win98.scale"); return k === 2 ? 2 : 1; }
export function unit() {
  const z = Number(settings()?.zoom) || 1;
  const k = scale() / z;
  const u = (n) => n * k;
  u.k = k;
  return u;
}
```
- Builder lengths are "px as designed at zoom 1"; Herdr multiplies them by zoom (`AGENTS.md:750-751`). `u(n) = n*scale/zoom` cancels zoom, so one art pixel is exactly `scale` device-independent window px at any zoom (`kit.js:4-6`).
- Event positions/bounds and `on_size_change` are WINDOW px (zoomed): "divide them by settings().zoom before mixing them with these" (`AGENTS.md:1122-1123`). Solitaire converts pointer to art px by dividing by `scale()` only: `{ x: (e.position.x - b.x) / scale(), y: (e.position.y - b.y) / scale() }` (`mods/win98/sol.js:101-104`).
- Overlay `width/height` are layout px (kit divides by zoom: `(w * k) / zoom()`), `at` is window px (`kit.js:356-371`, `herdr.d.ts:436-440`).
- `fitLayout()` keeps layout bar sizes whole art pixels: resizes `taskbar` (28) and `desktop` (84) blocks via `run("layout.resize", { id, px })`, pane header height `want(18)`, pane border `want(3)`, font size, then `run("layout.set", { layout: l })` (`kit.js:441-479`); called from the taskbar render only when zoom/scale changed, inside `cx.spawn` (`mods/win98/taskbar.js:446-454`). `layout.set` on a shipped layout only accepts click/look fields (`herdr.d.ts:88`).

### 3.3 `root()` and fonts
```js
// mods/win98/kit.js:34-36, 77-80
export const FONT = "Pixelated MS Sans Serif";
export const DOS = "PxPlus IBM VGA 8x16";
export const ASSETS = "mods/win98";
export function root(u, el) {
  return el.font_family(FONT).text_size(u(11)).line_height(`${u(13)}px`).text_color(C.text);
}
```
- Every role wraps its top element in `root(u, ...)` (e.g. `taskbar.js:488`, `clippy.js:83`, `mines.js:195`).
- `line_height` takes a CSS-like string `"13px"` (`kit.js:79`, `frame/welcome/main.js:132` uses `"20px"`).
- Fonts: drop `.ttf/.otf/.ttc` files into `mods/<mod>/fonts/`; Herdr loads `fonts/` and every `mods/*/fonts/` at start and again when the look is applied (`src/settings.rs:846-874`, `src/main.rs:193`, `src/window.rs:953-956`). Use them by family name with `.font_family(...)`, or in the layout root: `"font"` (terminals) / `"ui_font"` (mods) (`layouts/win98.json:92-94`). win98 ships `fonts/PixelatedMSSansSerif-Regular.ttf`, `-Bold.ttf`, `PxPlus_IBM_VGA_8x16.ttf` plus licenses.
- Labels with access keys: `label("&File")` underlines F (`kit.js:55-71`); bold via `.font_weight(700)`.

### 3.4 Assets: images, icons, ASSETS constant
- Paths are relative to `~/.config/herdr-app`: `image("mods/<name>/logo.svg")` full color, `svg("mods/<name>/icon.svg")` tinted by text color (`AGENTS.md:948-951`). Saving an asset updates every mod showing it (`AGENTS.md:950-951`).
- Keep ONE prefix constant (`ASSETS = "mods/win98"`, `kit.js:36`) — `mod.clone` "rewrite[s] their own asset prefixes" (`herdr.d.ts:91`).
- Icon size variants by file suffix: `>=24 -> name.svg`, `>=12 -> name-sm.svg`, else `name-xs.svg` (`kit.js:204-208`):
  ```js
  export function icon(u, name, size = 16) {
    const file = size >= 24 ? name : size >= 12 ? `${name}-sm` : `${name}-xs`;
    return image(`${ASSETS}/icons/${file}.svg`).flex_none().w(u(size)).h(u(size));
  }
  ```
- Sprite-sheet-by-filename: cards `image(\`mods/win98/img/sol-${file}.svg\`)` with `file = up ? \`${selected ? "select-" : ""}${suit}-${rank}\` : \`back-${deck}\`` (`sol.js:141-144`), mines art `image(\`${ASSETS}/icons/mines-${name}.svg\`)` (`mines.js:11-13`). PNGs work too: `image(\`${ASSETS}/img/banner${scale() === 2 ? "@2x" : ""}.png\`)` (`menu.js:206`), splash `img/splash.png` full-bleed (`dialog.js:136`), clippy `img/clippy.svg` 64x80 (`clippy.js:81`).
- Layout background image: `l.background = { image: \`${ASSETS}/img/clouds.png\`, fit: "cover" }` then `run("layout.set", { layout: l })` (`dialog.js:919-925`).
- Gradients/dither via path painting (global `window`, NOT `herdr`'s `window()`):
  ```js
  // mods/win98/kit.js:8, 190-200
  import { div, svg, image, PathBuilder, Background } from "gpui-kit";
  import { ..., window as appWindow } from "herdr";            // keep the global `window` usable
  const RECT = () => PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();
  export function gradient(from, to, angle = 90) {
    return window.paint_path(RECT(), Background.linear_gradient(angle, from, to)).absolute().top(0).left(0).size_full();
  }
  export function dither(u, color = C.hi) {
    return window.paint_path(RECT(), Background.checkerboard(color, Math.max(1, u(1) * (Number(settings()?.zoom) || 1)))).absolute().top(0).left(0).size_full();
  }
  ```
  `globalThis.window = { ..., paint_path, localStorage, viewport_size, ... }` (`quickjs/mod.rs:6942-6990`). Parent must be `.relative()`; win98 also marks the siblings painted over the layer `.relative()` (`kit.js:257-277`, `taskbar.js:284-309`) — reason UNCONFIRMED, follow the convention.

### 3.5 Bevels and buttons
- `bevel(u, kind, content, { id, press, bg, pad, center, shift })`, kinds `raised | pressed | window | field | well | bump | dent | thin | flat` (`kit.js:84-137`). Pressed look uses `.active((s) => ...)` state styles and needs `id` (`kit.js:117-130`).
- `button(u, id, content, onClick, { w, h, default, toggled, disabled, bold, pad, tooltip, onDown, onRight, minW, bg })` (`kit.js:144-174`). It always stops left mouse-down propagation (`:164-167`) so it works inside draggable windows/floats.
- `win(u, { id, title, icon, active, controls: [[kind, fn, tooltip]], menu, body, status, w, h })` builds a whole window (`kit.js:291-308`); `titleBar` (`:241-289`); `control(u, id, "min"|"max"|"restore"|"close"|"help", fn, tip)` (`:229-239`); `field`, `well`, `etch`, `grip` (`:176-186, 310-318`).

### 3.6 `own()` — keeping presses from dragging
```js
// mods/win98/kit.js:139-142
/** A press of a control in a window_drag bar, or a float, is the control's. */
export function own(el) {
  return el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
}
```
Needed because: `kind: "window"` overlays are "dragged by any press the mod doesn't stop" (`herdr.d.ts:420-424`); floating blocks start a drag on left mouse-down (`src/window/floats.rs:211`); `"window_drag": true` blocks drag the OS window (`layouts/win98.json:21,87`). Used on tray icons, quick launch, Clippy, game bodies, menu bars (`taskbar.js:383,405,432,438`; `clippy.js:69,115`; `mines.js:139,193`; `sol.js:147,158,176,225`).

### 3.7 Sounds: `sfx()` / `playSound`
```js
// mods/win98/kit.js:406-413
export function sfx(name) {
  if (settings()?.sounds?.enabled === false) return;
  if (shared("win98.mute") === true) return;
  try { playSound(`${ASSETS}/sounds/${name}.mp3`); } catch {}
}
```
`playSound(sound)`: `"done"`/`"blocked"` (attention sounds) or an MP3 path, absolute or relative to `~/.config/herdr-app` (`herdr.d.ts:51-53`). Shipped sounds: start, startup, shutdown, menu, ding, chord, clippy, recycle, tada, mines-boom (`mods/win98/sounds/`). Triggers: open Start menu (`taskbar.js:271`), right-click desktop (`desktop.js:123`), dialogs (`dialog.js:63-64`), win/lose (`mines.js:80,102`, `sol.js:112`), clippy click (`clippy.js:78`). Respect both the app setting and our own mute key.

### 3.8 Cross-role state: `shared("win98.*")`
`shared(key)` is persisted and visible to every mod; `setShared` re-renders every mod (`herdr.d.ts:495-499`). Keys used by win98:

| key | meaning | written in |
|---|---|---|
| `win98.scale` | 1 or 2 (Small/Large fonts) | `taskbar.js:163-165`, `dialog.js:635-636` |
| `win98.apps` | `{ mines: "open"\|"min", sol: ... }` | `kit.js:418-427` |
| `win98.mute` | sounds off | `taskbar.js:433`, `dialog.js:627` |
| `win98.start` | open Start menu overlay id | `taskbar.js:266-274`, `menu.js:47,64,219` |
| `win98.menus` | open submenu chain `[{id, parents}]` | `menu.js:10-21,35` |
| `win98.menu.owner` | which menu-bar label shows pressed | `menu.js:31,52` |
| `win98.boot`, `win98.init` | timestamps for boot/chime throttling | `taskbar.js:111-120` |
| `win98.mines` | options + best times | `mines.js:26,32` |
| `win98.mines.req`, `win98.sol.req` | `{ cmd, t: Date.now() }` command mailbox | `mines.js:131`, `sol.js:10` |
| `win98.sol.draw/scoring/deck` | options | `sol.js:162` |
| `win98.clippy`, `win98.welcome`, `win98.run`, `win98.desktop` | misc prefs/history | `dialog.js:225,628,866,920` |

Command-mailbox pattern (menu popup -> game window; they're different copies):
```js
// mods/win98/mines.js:131 (writer, a menu item act)
act: { shared: ["win98.mines.req", { cmd, t: Date.now() }] }
// mods/win98/mines.js:28, 180-182 (reader)
init() { ...; this.req = shared("win98.mines.req")?.t; }           // ignore requests older than this copy
render(cx) {
  const req = shared("win98.mines.req");
  if (req && req.t !== this.req) { this.req = req.t; this.request(req.cmd); }
```
Sol comments the same: "A request from before this copy started was already handled." (`sol.js:16-17`).

### 3.9 Overlays: windows, menus, dialogs
- Game windows, one per open app, keyed so they reopen where dragged (`taskbar.js:178-193`):
  ```js
  syncGames() {
    this.wins ??= {};
    const open = apps();
    for (const k of Object.keys(GAMES)) {
      if (open[k] && !this.wins[k]) {
        this.wins[k] = openOverlay({ mod: "win98", kind: "window", frame: "none", key: k, props: { role: k } });
      } else if (!open[k] && this.wins[k]) { closeOverlay(this.wins[k]); delete this.wins[k]; }
    }
  }
  ```
  No width/height -> "as big as its content" (`herdr.d.ts:419-424`). Minimized = window stays open, the role renders `div()` (`mines.js:183`, `sol.js:174`). No `keep: true` here; `keep` (with `key`) would reopen it next start (`herdr.d.ts:433-435`). "A layout switch closes windows" (`herdr.d.ts:424`).
- Menus: `openOverlay({ mod: "win98", kind: "popup", frame: "none", width: (w*k)/zoom(), height: (h*k)/zoom(), at: {x, y}, props: { role: "menu", items, parents, start, owner } })` (`kit.js:356-371`). Popup height: "A popup is as tall as its items; height is only the most." (`mods/spaces/main.js:296`).
- Dialog windows: `openOverlay({ mod: "win98", kind: "window", frame: "none", width: (w*k)/zoom(), props: { role: "dialog", kind, ...p } })` (`kit.js:375-386`).
- Full-window modal screen (boot/shutdown): `openOverlay({ mod: "win98", kind: "dialog", frame: "none", modal: true, width: 1, height: 1, props: {...} })` — `<= 1` = share of the window (`taskbar.js:118`, `dialog.js:239-241`, `herdr.d.ts:436`).
- Modal option dialog with Herdr's frame: `openOverlay({ mod: "win98", kind: "dialog", modal: true, width: unit()(340), props: { role: "sol", dialog: kind } })` (`sol.js:129-131`).
- Every overlay mod closes itself: `closeOverlay(props().overlay)` (`dialog.js:77-79`, `herdr.d.ts:443-448`).
- Generic action dispatcher used by menus/icons: `perform({ run: [cmd, args], dialog, app, shared: [key, value], url, sound })` (`kit.js:388-400`).
- Menu-escape trick (app's Esc would close the overlay before `on_key_down`): bind a key in our own context (`menu.js:36-40, 214-215`):
  ```js
  cx.bind_keys([{ keystroke: "escape", action: "win98_menu_escape", context: "Win98Menu" }]);
  // render: v_flex().id("menu").key_context("Win98Menu").on_action("win98_menu_escape", () => this.escape()).track_focus(this.focus)
  ```
- Click-outside: `.on_mouse_down_out((_e, cx) => ...)` (`menu.js:218-221`, `mines.js:194`).

### 3.10 Keys into the mod
`nextCommand()` loop in ONE role (taskbar) (`taskbar.js:89-99`):
```js
cx.spawn(async (cx) => {
  for (;;) {
    const c = await nextCommand();
    try { this.command(c); } catch (e) { console.log(`win98 taskbar: ${c} failed: ${e}`); }
    cx.notify();
  }
});
```
`<mod>.<command>` is delivered to EVERY shown copy of that mod (`src/mods.rs:785-798`), so if several roles listen, filter by role. Bindings go in `keys.json` under `"layout:<name>"` (`AGENTS.md:548-553`); README claims `layout:win98` keys (`mods/win98/README.md`) but they are not in `defaults/keys.json` (UNCONFIRMED where they're installed).

---

## 4. Games inside win98: Mines and Solitaire

### 4.1 State
- All game state is instance fields on the role object; options/best times persisted through `shared` (`mines.js:25-32`, `sol.js:14-21,162`).
- Mines: `this.cells = Array.from({ length: cols*rows }, () => ({ mine, n, open, mark }))`, `this.state = "ready"|"playing"|"lost"|"won"` (`mines.js:34-42`).
- Solitaire: `this.g = { stock, waste, tab, home, score }`; undo = deep copy `JSON.parse(JSON.stringify(g))` (`sol.js:11,30,48`).

### 4.2 Timers and cancel
```js
// mines.js:33, 63-68
stop() { this.timer?.cancel(); this.timer = null; }
this.timer = cx.timer.every(1000, (cx) => {
  this.seconds = Math.min(999, Math.floor((Date.now() - this.started) / 1000));   // wall-clock, not tick count
  if (this.seconds === 999) this.stop();
  cx.notify();
});
// sol.js:35-47
stop() { this.clock?.cancel(); this.clock = null; this.anim?.cancel(); this.anim = null; }
begin(cx) {
  if (this.won || this.clock) return;
  this.running = true;
  this.clock = cx.timer.every(1000, cx => { this.seconds++; if (this.scoring && this.seconds % 10 === 0) this.g.score -= 2; cx.notify(); });
}
```
- Handle = `{ cancel(), is_done() }` (`vendor/gpui-kit/crates/shell/src/engine/quickjs/scheduler.rs:722-730`). `every` waits `ms` after each callback (loop of `timer(delay).await`, `scheduler.rs:684-716`), so it drifts; use `Date.now()` deltas for game time (mines does).
- `cx.timer.after(ms, (cx) => ...)` one-shot (`taskbar.js:77-80`, `dialog.js:89-108`). Minute-aligned clock: `cx.timer.after(60000 - (Date.now() % 60000) + 50, (cx) => { tick(cx); cx.timer.every(60000, tick); })` (`taskbar.js:77-80`).
- `cx.sleep(ms)` exists for async loops (`mods/changes/main.js`, `quickjs/mod.rs:7076-7079`).
- Pause when hidden: Sol stops its clock when minimized and restarts in render: `if (apps().sol !== "open") { this.stop(); ...; return div(); }` / `if (this.running && !this.won && !this.clock) this.begin(cx);` (`sol.js:174-175`). App-level: check `window()?.visible` in the timer and restart from render (`AGENTS.md:1093-1097`).
- The one high-rate loop shipped: Solitaire's victory bounce, `cx.timer.every(33, ...)` (~30 fps) with `cx.notify()`, self-cancels when 52 cards launched or `frame > 5200`, trail capped at 300 elements (`sol.js:110-128`). Everything else animates natively (§6).

### 4.3 Random
`Math.random()`: Fisher-Yates partial shuffle for mines (first click excluded with neighbors) (`mines.js:53-61`), full shuffle for cards (`sol.js:25-29`), random tip (`clippy.js:77`), card velocity (`sol.js:118`). No seeded RNG is shipped.

### 4.4 Input handling
- Left/right/middle: `.on_mouse_down("left"|"right"|"middle", (e, cx) => ...)`, `.on_mouse_up("middle", ...)`, `.on_click((e, cx) => ...)` with `e.click_count >= 2` for double-click (`mines.js:163-177`, `sol.js:207`).
- Pressed-cell feedback: set `this.held` on mouse-down, clear on hover-out `.on_hover((hovered, cx) => { if (!hovered && this.held === i) {...} })` and on `.on_mouse_down_out` (`mines.js:163-164,194`).
- Event fields: `button`, `click_count`, `position {x,y}` (window px), `local_position {x,y}` and `bounds {x,y,width,height}` (window px; undefined before first paint), `modifiers {shift, control, alt, platform, function}` (`quickjs/mod.rs:9921-10005`). Keys: `e.key` ("down", "enter", "escape", "backspace", letters), `e.key_char`, `e.modifiers` (`quickjs/mod.rs:4616-4620`; `dialog.js:154-183`). Wheel: `e.delta {x,y}`, `e.delta_lines`, `e.touch_phase` (`quickjs/mod.rs:4447-4480`; `mods/tabs/main.js:43-60`).
- Keyboard focus: `this.focus = cx.focus_handle(); this.focus.focus();` in init, `.track_focus(this.focus).on_key_down((e, cx) => ...)` (`menu.js:27-28,216-217`). Overlays opening during startup may lose focus: refocus with `cx.timer.after(600, () => this.handle.focus())` (`frame/welcome/main.js:47-49`, `mods/help/main.js:30`).
- Always `cx.stop_propagation()` in handlers that should not reach parents/drag (`mines.js:163`, `sol.js:90`).

### 4.5 Drag and drop (Solitaire)
```js
// sol.js:89-100 press
down(loc, e, cx) {
  cx.stop_propagation();
  ...
  this.press = { loc, x: e.position.x, y: e.position.y, dx: (e.local_position?.x ?? 0) / scale(), dy: (e.local_position?.y ?? 0) / scale() };
  cx.notify();
}
// sol.js:184-199 on the table element
const table = div().id("sol-table").relative().w(u(W)).h(u(H)).flex_none().bg("#008000").overflow_hidden()
  .on_hover((hovered, cx) => { if (!hovered && this.press) { this.press = this.drag = null; cx.notify(); } })
  .on_mouse_move((e, cx) => {
    if (!this.press) return;
    const p = this.point(e);                       // e.bounds = table's bounds
    if (this.drag || Math.abs(e.position.x - this.press.x) + Math.abs(e.position.y - this.press.y) > 4) {
      this.drag = { x: p.x - this.press.dx, y: p.y - this.press.dy }; this.pick = null; cx.notify();
    }
  }).on_mouse_up("left", (e, cx) => {
    if (!this.press) return;
    const from = this.press.loc;
    if (this.drag) { const p = this.point(e), to = this.target(p.x, p.y); if (to) this.move(from, to, cx); this.pick = null; }
    else this.pick = this.pick && JSON.stringify(this.pick) === JSON.stringify(from) ? null : from;   // click-to-select
    this.press = this.drag = null; cx.notify();
  });
```
Drop target = hit test in art coordinates (`sol.js:105-109`). Dragged cards are skipped in the normal pass and redrawn at the drag position last so they paint on top (`sol.js:203,223`). Space reordering in the sidebar uses the same press/over/up trio with an accent insertion line (`mods/spaces/main.js:467-495`). External file drops: `.on_drop((e, cx) => e.paths)` (`AGENTS.md:1130-1132`).

### 4.6 Absolute-positioned rendering
```js
// sol.js:200, 205, 224
const spot = (x, y) => div().absolute().left(u(x)).top(u(y)).w(u(CW)).h(u(CH)).border(u(1)).border_color("#004000").rounded(u(3));
table.child(this.card(u, c, up, selected).absolute().left(u(x)).top(u(y)).id(`sol-${loc.type}-${loc.i}-${loc.n}`) ...);
for (const f of this.trails) table.child(this.card(u, f.c).absolute().left(u(f.x)).top(u(f.y)));
```
Container: `.relative().w(..).h(..).overflow_hidden()`; children `.absolute().left().top()`; later children paint on top. Builder `child()` mutates and returns `this`, so `table.child(...)` without reassign works (`quickjs/mod.rs:5893-5896`). Seven-segment counter = 7 absolute divs per digit (`mines.js:15-22`). Clock hands = dots along an angle because "GPUI can't rotate a div" (`dialog.js:927-958`).

### 4.7 Performance notes
- "Every redraw of a mod redraws the whole window" (`AGENTS.md:1084-1085`). Timers only for data, "only as often as what they show changes" (`AGENTS.md:1091-1093`).
- Element counts: Mines expert = 480 cells x ~3 divs; Sol trails capped at 300 (`sol.js:123`); bounded animation (`sol.js:125`).
- Do heavy/slow work in `cx.spawn` + `exec` (`AGENTS.md:1066-1067`); `fitLayout` runs only on change (`taskbar.js:448-454`).
- `setShared` re-renders every mod: don't call it per tick (§9).

---

## 5. Floating blocks (Clippy)

Layout (`layouts/win98.json:61-73`):
```json
"floating": [ { "id": "clippy", "content": { "mod": "win98", "props": { "role": "clippy" } }, "edge": "left", "align": "end" } ]
```
- Fields `id, content, edge (top|right|bottom|left), align (start|center|end), peek?, hidden` (`src/layout.rs:60-77`). Sits 12 px in from the node edge (`src/window/floats.rs:13`), sizes to content; render nothing (`div()`) to hide (`AGENTS.md:434-438`, `clippy.js:38`). Draggable anywhere; springs to nearest edge/third and is saved (`AGENTS.md:436-438`).
- Herdr ALWAYS draws the frame around a non-empty float: popover bg, 1 px border (accent while dragged), radius 12, shadow, 5 px pad top/bottom (`src/window/floats.rs:183-206`, `shadow_lg` at `:204`; `AGENTS.md:446-449`). No `frame: "none"` for floats (UNCONFIRMED that none exists; not in `Float` struct).
- `peek: n` (side edges) = drawer showing n px until hovered (`AGENTS.md:440-444`, `floats.rs:161-163`).
- `placement()` -> `{ edge, align, vertical, hovered, dragging } | null` (`herdr.d.ts:330-339`). Clippy mirrors for side: `const right = placement()?.edge !== "left"; ... .map((el) => (right ? el.items_end() : el.items_start()))` (`clippy.js:41,88`). AGENTS.md: lay out vertically when `vertical`, mirror on the right edge (`AGENTS.md:449-452`).
- Bobbing while there's news: `.relative().when(Boolean(a), (el) => el.loop("top", { from: 0, to: u(-5), period: 800 }))` (`clippy.js:69-76`).
- Balloon = plain `v_flex` above the character with `.bg(C.tip).border(u(1)).rounded(u(8))`, text split into lines, actions are `own(h_flex().id(...).on_click(...))` rows (`clippy.js:94-131`). Actions mutate state and call `cx.notify()` (`clippy.js:121-124`).
- Must `own()` the clickable parts: a press on a float starts a drag (`floats.rs:211`).

---

## 6. Animation idioms (every shipped call)

Rule: "Animate natively, never with a timer" (`AGENTS.md:1084-1093`). Native animations run on a shared clock, never re-enter the script, and stop when not drawn (`quickjs/mod.rs:6119-6122`).

### 6.1 `.spin(ms)` — 7 calls, all `svg(spinner).spin(900)`
- `mods/agents/main.js:214`, `mods/tabs/main.js:122`, `mods/pane/main.js:84`, `mods/picker/main.js:121`, `mods/machine-add/main.js:253`, `frame/settings/main.js:670,731`.
- Signature: `spin(ms = 1000)`, `ms >= 100` else RangeError (`quickjs/mod.rs:6159-6165`). Comment: "an svg turning once every ms" — only used on `svg(...)`.

### 6.2 `.frames(list, ms)` — 2 calls
- `mods/peek/main.js:85`: `div().w(12).flex_none().text_color(t[st] ?? t.dim).when(st === "working", (el) => el.frames(SPIN, 90)).child(glyph)`
- `mods/worktree/main.js:393`: `div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)`
- Signature: non-empty array of strings, `ms` default 100, `>= 16` (`quickjs/mod.rs:6123-6131`). Shows each string as the element's text (`AGENTS.md:1086-1087`). Index = `floor(clock/ms) % len` on a global clock (`materialize.rs:3086-3090`), so all copies are in step. Good for ASCII/emoji sprite cycles; strings only (no element frames).

### 6.3 `.loop(property, { from, to, period, easing })` — 5 calls
- `mods/win98/taskbar.js:305`: `.loop("opacity", { from: 0.35, to: 1, period: 1400 })` (working hourglass)
- `mods/win98/taskbar.js:420`, `mods/win98/desktop.js:56`: `.loop("opacity", { from: 0, to: 1, period: 900 })` (blocked badge blink)
- `mods/win98/dialog.js:283`: `.loop("opacity", { from: 0, to: 1, period: 1060 })` (text caret)
- `mods/win98/clippy.js:75`: `.loop("top", { from: 0, to: u(-5), period: 800 })` (bob)
- Properties: `opacity | width | height | left | top`; `from/to` numbers required; `period >= 100` ms (default 1000); `easing: linear | ease-in | ease-out | ease-in-out` (default ease-in-out) (`quickjs/mod.rs:6133-6156`).
- It is a ping-pong (triangle) wave over one period: `x = phase < .5 ? 2*phase : 2 - 2*phase`, value `from + (to-from)*ease(x)`; width/height/left/top set px (inset for left/top), opacity clamped 0..1; redraw at ~30 fps while drawn (`materialize.rs:3091-3110`). `left/top` set the inset -> element must be `.relative()` (offset) or `.absolute()`. CORRECTED (critic): loop values are written as raw `gpui::px(value)` and are **not** multiplied by the app zoom (`materialize.rs:3103-3106`), while static lengths are (`value.rs:25-27`, `scaled_px`). Clippy's `u(-5)` = `-5*scale/zoom` therefore bobs `5*scale/zoom` window px, while its static art is `n*scale` window px. To match static art, pass `n * scale` to a loop (that is, `u(n) * zoom`).
- One loop per property per element (`materialize.rs:2765`); different properties can stack (UNCONFIRMED beyond code reading: `loops` is a SmallVec of distinct properties).

### 6.4 `.transition(...)` / `.spring(...)` — NOT used in shipped code
Runtime definitions only:
- `transition(property, policy)`: property `opacity|width|height|left|top`; policy `number` (= duration) or `{ duration = 0, delay = 0, easing = "ease-out" }` (`quickjs/mod.rs:6072-6097`).
- `spring(property, { response = 250, damping = 1, epsilon = 0.001 })` (`quickjs/mod.rs:6099-6117`).
- They animate toward the value you set on that element (`opacity` must be set with `.opacity(x)`; lengths must be a number or `"Npx"` — `%`, `auto`, `"Nrem"` and the rem ramps snap, `materialize.rs:3183-3197`, `style.rs:597-600`). Identity = the element's `.id(...)` (else tree position) (`materialize.rs:2566-2571, 3538-3542`), so give moving sprites a stable `.id()`.
- Use for: sprite moving on each combat tick (`.absolute().left(x).transition("left", { duration: tickMs, easing: "linear" })`), HP bar width (`.w(px).transition("width", 300)`), damage number fade (`.opacity(o).transition("opacity", 600)`). UNCONFIRMED in practice (no shipped caller).

---

## 7. Builder methods and imports

### 7.1 Element builder methods used in shipped JS
110 names, written to `used-methods.txt` (scan: `grep -ohE '\.([a-z_0-9]+)\('` over `defaults/**/*.js`, then dropped JS built-ins, `cx.*`, handle/state methods, and the mods' own helper methods). Includes component-specific ones: `content` (Popup slot, `frame/settings/main.js:432-433`), `mode` (scrollbar, `mods/agents/main.js:455`, `frame/welcome/main.js:540`), `selectable` (TextView, `mods/machine-add/main.js:238`), `viewport_from_layout` (Scrollbar, `mods/changes/main.js:324`), `on_drop` (`frame/feedback/main.js:87`), `key_context`/`on_action` (`mods/win98/menu.js:214-215`), `active`/`hover` (state styles taking `(s) => s.<style>()`, `quickjs/mod.rs:5969-5977`), `map`/`when` (`quickjs/mod.rs:6388-6400`).

Non-builder host methods seen (not in the file):
- `cx.notify()`, `cx.stop_propagation()`, `cx.spawn(async (cx) => ...)`, `cx.sleep(ms)`, `cx.timer.every(ms, (cx)=>..)`, `cx.timer.after(ms, (cx)=>..)`, `cx.focus_handle()`, `cx.bind_keys([...])`, `cx.write_to_clipboard(text)` (`quickjs/mod.rs:7040-7090`).
- Handles: `timer.cancel()`, `task.is_done()`, `focusHandle.focus()`, `ScrollHandle.new()` + `.scroll_to_item(i)`.
- `InputState.new({ placeholder, value })`, `.on("change"|"submit"|"focus"|"blur", (e, cx)=>..)`, `.value()`, `.set_value(s)`, `.set_selected_range({start,end})`, `.focus()`; `Input.new(state)` then style (`mods/prompt/main.js:9-17,44`).
- `Scrollbar.vertical(id).mode("always").absolute().inset_0()` paired with `div().id(id).overflow_y_scroll()` (`frame/welcome/main.js:532-540`).
- `Popup.new(id, trigger).content(el)` (`frame/settings/main.js:432-433`); `TextView.html(id, html).selectable(true)`.
- `PathBuilder.fill().move_to().line_to().close().build()`, `Background.linear_gradient(angle, from, to)`, `Background.checkerboard(color, px)`, `window.paint_path(path, bg)` (`kit.js:190-200`).
- `localStorage.getItem/setItem/removeItem` (`mods/agents/main.js:89-93`).

### 7.2 Import forms (union over all shipped JS)
- `import { View, div, svg, image, PathBuilder, Background } from "gpui-kit";` — every name ever imported from gpui-kit. (AGENTS.md also lists `list`, `uniform_list` there, `AGENTS.md:1124`.)
- `import { h_flex, v_flex, ScrollHandle, Scrollbar, InputState, Input, Popup, TextView, Textarea, TextareaState, Editor, EditorState, v_virtual_list } from "gpui-base";`
- `from "herdr"`: `agents, appHome, closeOverlay, commands, exec, feedback*, focused, fonts, hc, home, keys, knownAgents, layout, layouts, machines, nextCommand, notify, openOverlay, panes, placement, playSound, presentUpdateNotes, props, readTextFile, run, sendFeedback, setAgentOrder, setShared, settings, shared, spaces, telemetry, terminals, theme, themes, updates, watchFolder, window, writeTextFile`.
- Aliasing `window`: `window as appWindow` (`mods/win98/kit.js:10`), `window as win` (`frame/palette/main.js:12`, `mods/terminals-bar/main.js:5`) — needed when the global `window.paint_path` is also used.
- Relative modules: `import Taskbar from "./taskbar.js";` default-export role classes (`mods/win98/main.js:14-21`); named helpers `import { C, ASSETS, unit, root, ... } from "./kit.js";` (`mods/win98/taskbar.js:9-12`); cross-role helper `import { closeSpaceAsk } from "./taskbar.js";` (`desktop.js:11`).
- Node-ish: `import { exists, readdir, readFile } from "fs/promises";` (`frame/palette/main.js:11`, a frame mod; UNCONFIRMED for regular mods).
- Typical minimal role file:
  ```js
  import { div, image } from "gpui-kit";
  import { h_flex, v_flex } from "gpui-base";
  import { shared, setShared } from "herdr";
  import { unit, root, C, bevel, button, win, icon, label, own, apps, setApp, openMenu, openDialog, sfx, ASSETS } from "./kit.js";
  ```
  (`mods/win98/mines.js:1-4`)

---

## 8. Theme usage

`theme()` -> `Record<string,string>`; tokens: background, surface, canvas, chrome, popover, raised, hover, selected, border, input, foreground, muted, dim, accent, accent_foreground, solid, solid_foreground, selection, working, blocked, done, idle, unknown, ansi0..ansi15 (`herdr.d.ts:341-346`). Resolver also defines `terminal_foreground`, `cursor`, `ring` (`src/settings.rs:325-356`).

Counts in shipped JS (excluding win98, which hardcodes its palette `C` in `kit.js:12-32`): foreground 117, dim 114, muted 65, border 59, hover 53, accent 37, raised 34, blocked 27, background 20, ansi2 18, popover 16, input 14, chrome 12, selected 10, ansi1 9, working 8, solid 8, solid_foreground 7, accent_foreground 4, surface 2, done 2, ring 1, idle 1, unknown 1, ansi3..6 1 each.

Status colors:
- Index by status: `t[a.status] ?? t.dim` (`mods/agents/main.js:213`), `t[status] ?? t.unknown` (`mods/spaces/main.js:68-70`), `t[c.status]` dot (`mods/tabs/main.js:123`), toast levels `{ error: "blocked", warning: "working", success: "done", info: "accent" }` (`mods/toast/main.js:9,34`).
- `t.working` spinner tint; `t.blocked` "Needs you" pill on `t.blocked + "26"` (≈15% alpha); `t.done` dot; `t.idle ?? t.dim` ring (`mods/agents/main.js:213-219`).
- Defaults when a theme doesn't set them: working = ansi3, blocked = ansi1, done = ansi4, idle/unknown = mix(bg, fg, .38) (`src/settings.rs:310, 351-354`). win98 theme sets working `#808000`, blocked `#ff0000`, done `#0000ff`, idle `#808080` (`themes/win98.json:26-29`).
- Alpha suffix idiom: `t.blocked + "26"`, `t.accent + "10"`, `t.dim + "00"`, `t.ansi2 + "22"`, `t.blocked + "14"/"40"` (`agents/main.js:215-219`, `frame/welcome/main.js:245,358`, `mods/machine-add/main.js:164`). Only safe on 6-digit tokens: values are `#rrggbb` or `#rrggbbaa`, and hover/selected/border/input are already 8-digit (`src/settings.rs:300, 311-323`).
- Panels: `.bg(t.chrome)` sidebars/bars (`mods/agents/main.js:425`, `mods/tabs/main.js:144`), `t.popover` overlays/menus (`mods/menu/main.js:129`), `t.raised` selected tab/cards, `t.hover` hover, `t.selected` focused row, `t.border` dividers, primary button `t.solid`/`t.solid_foreground` (`mods/confirm/main.js:50`).

---

## 9. Pitfalls and warnings found in shipped code and runtime

1. `child(null|undefined)` throws: "child(value) expects an element, a string, or an entity" (`quickjs/mod.rs:5874-5891`). Shipped code guards: `.when(Boolean(pic), el => el.child(pic))` (`mods/agents/main.js:365`, `mods/pane/main.js:81`). `.children([...])` must not contain null either. `child(false)` renders the text "false" (booleans become text, `:5881-5883`).
2. `when(cond, fn)` must return the element: "when(...) must return the element" (`quickjs/mod.rs:6392-6399`). Use expression arrows.
3. "Never keep a cx and use it later" — each callback gets its own (`AGENTS.md:1063-1065`). Timers' callbacks receive cx: `cx.timer.every(ms, (cx) => ...)`.
4. No `setTimeout`/`setInterval`, no top-level await (`AGENTS.md:1066-1067`).
5. "Animate natively, never with a timer" (`AGENTS.md:1084-1093`); "Every redraw of a mod redraws the whole window" (`:1084-1085`). Mod timers keep running while hidden (`AGENTS.md:1093-1094, 944-946`).
6. Module code is shared by copies and survives them; keep instance state in init, "keep side effects on globalThis out of the module's top level" (`AGENTS.md:1058-1060, 936-941`). Exception pattern that does share across copies: `globalThis[Symbol.for("herdr.repoStatus.v2")] ??= new Map()` (`mods/changes/main.js:5-6`). Saving any file reloads every copy; old timers stop "at its next cx use" (`AGENTS.md:936-939`).
7. `localStorage` is per mod+props: "Views with the same mod and props share live localStorage values" (`AGENTS.md:1061-1062`). Roles with different props do NOT share it. For cross-role *live* state use module scope, which all copies share (runtime.md Critic verification Q1). Use `shared()` only for rare persisted signals.
8. `setShared` re-renders every mod (`herdr.d.ts:498`) — never call per animation tick.
9. Every host list read copies the whole list into JS: read `panes()`/`agents()` once per render (`mods/agents/main.js:287`, `mods/spaces/main.js:23`).
10. `<mod>.<command>` goes to every shown copy (`src/mods.rs:785-798`); handle it in one role.
11. Requests via shared mailbox must ignore requests from before the copy started (`mods/win98/sol.js:16-17`, `mines.js:28`).
12. Escape is the app's: it closes the overlay before your key handler sees it; bind your own escape in a key context (`mods/win98/menu.js:36-40`).
13. A top menu starts the menu list over because "menus closed by a click outside leave stale ids" (`mods/win98/menu.js:34-35`).
14. Rows that move away after a click get no hover-out (`mods/agents/main.js:339-341`).
15. Overlays opened during startup lose the keyboard; re-focus after 600 ms (`frame/welcome/main.js:47-49`).
16. Scroll areas: padding inside the scroll child, not on the scroll area, or a fitting page shows a scrollbar (`frame/welcome/main.js:536-538`); "overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout" — use `relative` + `absolute().inset_0().overflow_y_scroll()` (`mods/changes/main.js:309-311`). Virtual lists need a definite height (`AGENTS.md:1124-1129`).
17. "GPUI can't rotate a div" (`mods/win98/dialog.js:929`) — only `svg().spin()` rotates.
18. Presses inside `kind:"window"` overlays, floats and `window_drag` blocks drag unless stopped (`own()`, `kit.js:139-142`; `herdr.d.ts:420-421`). Only the welcome header shows `cursor_grab()` and the rest stops propagation (`frame/welcome/main.js:494-530`).
19. `import { window } from "herdr"` shadows the global `window` (paint_path, localStorage): alias it (`kit.js:10`).
20. `window()` is null during `herdr-app check`: use `window()?.x` (`AGENTS.md:1096-1097`, `herdr.d.ts:308`). `checking()` is true while `herdr-app check` loads the mod and `init()` runs for real — guard side effects (`herdr.d.ts:23-25`).
21. `layout.set` on shipped layouts only applies click/look fields (`herdr.d.ts:88`); structure changes need a personal layout (clone).
22. A layout switch closes `kind:"window"` overlays; kept ones return with their layout (`herdr.d.ts:424, 433-435`).
23. Event coordinates are window px (zoomed); builder sizes are zoom-1 px (`AGENTS.md:1122-1123, 750-751`).
24. Theme alpha suffix only on 6-digit tokens (`src/settings.rs:300`).
25. `done` flips to `idle` when anyone looks, on any client (`herdr.d.ts:185-187`); sub-agent `"done"` should be read as idle, `"error"` as blocked (`mods/agents/main.js:54-61`).
26. Clean persisted per-agent maps: agents mod drops entries gone for 30 days, but only when something changed ("the list alone is empty right after a start") (`mods/agents/main.js:109-111`).
27. Validate `localStorage` JSON shape after parse (`mods/agents/main.js:89-92`, `mods/tabs/main.js:34-35`).

---

## 10. SNIPPETS (ours) for the idle-RPG mod

### 10.1 One mod, roles (mirrors win98/main.js)
```js
// mods/<game>/main.js
import { View, div } from "gpui-kit";
import { props } from "herdr";
import Stage from "./stage.js";
import Party from "./party.js";
import Nameplate from "./nameplate.js";
import Hud from "./hud.js";
import Window from "./window.js";

const ROLES = { stage: Stage, party: Party, nameplate: Nameplate, hud: Hud, window: Window };

export default class Game extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    const R = ROLES[pr.role];
    this.role = R ? new R() : null;
    this.role?.init?.(pr, cx);
  }
  render(cx) {
    if (!this.role) return div().child(`game: no role "${props()?.role}"`);
    return this.role.render(cx);
  }
  async close(cx) { await this.role?.close?.(cx); }   // win98 doesn't forward close; we may need it
}
```
Layout blocks: `{ "mod": "<game>", "props": { "role": "stage" } }`, pane header `{ "content": { "mod": "<game>", "props": { "role": "nameplate" } }, "height": 30 }` (header props arrive together with `{pane, terminal}`: win98 puts `role` in the header props and its window role reads `props()?.pane`, `layouts/win98.json:30-34` + `mods/win98/window.js:24`).

### 10.2 Agent -> character snapshot (read once per render)
```js
import { agents, terminals } from "herdr";
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
export function party() {
  const list = agents();                       // one read
  const all = terminals();                     // one read
  return list.map((a) => ({
    id: a.address,                             // stable key (machine-qualified for remote)
    name: a.pane_name || a.program?.name || a.app || "Agent",
    status: a.status,                          // working|blocked|done|idle
    resting: a.status === "done" || a.status === "idle",
    program: a.program,
    pinned: a.pinned, focused: a.focused, seq: a.seq,
    summons: all.filter((k) => k.parent === a.address && k.state === "live"),
  }));
}
```

### 10.3 Status visuals for a character (native animation only)
```js
// t = theme(); st = status
const aura = (t, st, u) =>
  st === "working" ? svg("mods/workspace-chrome/spinner.svg").size(u(12)).flex_none().text_color(t.working).spin(900)
  : st === "blocked" ? div().size(u(14)).rounded(u(4)).bg(t.blocked + "26").text_color(t.blocked).font_bold().flex().items_center().justify_center().child("!").loop("opacity", { from: 0.3, to: 1, period: 900 })
  : st === "done" ? div().size(u(7)).rounded(u(4)).bg(t.done)
  : div().size(u(7)).rounded(u(4)).border(1.5).border_color(t.idle ?? t.dim);
// walking bob for a working hero sprite:
// div().id(`hero-${id}`).relative().loop("top", { from: 0, to: u(-3), period: 600 }).child(image(`${ASSETS}/img/hero-walk.svg`).w(u(32)).h(u(32)))
```

### 10.4 Turn-finished detector (reward on working -> done/idle, persisted per copy)
```js
init(_p, cx) {
  try { this.seen = JSON.parse(localStorage.getItem("seen") ?? "{}"); } catch { this.seen = {}; }
  if (!this.seen || typeof this.seen !== "object" || Array.isArray(this.seen)) this.seen = {};
}
observe(list, onTurnDone) {
  let dirty = false;
  for (const a of list) {
    const s = a.status === "done" ? "idle" : a.status;   // done/idle are one state (agents/main.js:98-104)
    const prev = this.seen[a.address];
    if (prev === s) continue;
    if (prev === "working" && s === "idle") onTurnDone(a);
    this.seen[a.address] = s; dirty = true;
  }
  if (dirty) localStorage.setItem("seen", JSON.stringify(this.seen));
}
```
Only ONE role should award progress (else duplicated). Award inside render is allowed but avoid `setShared` loops; persist game progress with `writeTextFile(appHome()+"/data/<game>/save.json", json, lastText)` at low frequency, from one writer (runtime.md §4 and Critic verification Q2). Not `shared()`: every changed `setShared` serialises all of shared.json and re-renders every copy of every mod (`src/mods.rs:544-556`, `src/window.rs:1905-1922`). Because module scope is shared, the turn-finished detector should live in module scope (one `seen` map), not in per-copy localStorage.

### 10.5 Combat tick (data timer + native motion)
```js
// import { window as appWindow } from "herdr";   // alias: global `window` is gpui-kit's (paint_path, localStorage)
init(_p, cx) { this.last = Date.now(); this.tick = cx.timer.every(500, (cx) => this.step(cx)); }
step(cx) {
  if (appWindow()?.visible === false) return;          // AGENTS.md:1093-1097
  const now = Date.now(), dt = now - this.last; this.last = now;   // wall clock, timers drift
  /* advance simulation by dt */
  cx.notify();
}
close() { this.tick?.cancel(); }
// sprite: div().id(`mob-${m.id}`).absolute().left(u(m.x)).top(u(m.y)).transition("left", { duration: 500, easing: "linear" })
```

### 10.6 Floating "boss" or overlay windows (inventory/skills)
```js
// open once, remembered position; close by id
this.inv = openOverlay({ mod: "<game>", kind: "window", frame: "none", key: "<game>-inventory", props: { role: "window", which: "inventory" } });
// inside: own(...) on buttons; title bar may stay draggable; closeOverlay(props().overlay) to close
```

### 10.7 Click into an agent from the game
```js
own(div().id(`hero-${a.address}`).cursor_pointer().on_click(() => run("agent.focus", { terminal: a.address })))
```
