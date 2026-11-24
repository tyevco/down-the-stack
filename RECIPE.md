# Down the Stack

Every coding agent in the window becomes a Termling, a small pixel-art hero shaped like a terminal
window whose screen is its face. A 200 px strip under the terminals shows the herd fighting
developer bugs (Typo Sprouts, Null Pointer Frogs, the Deadlock Hydra) while their agents work.
Termlings rest at a campfire when idle, sit on a crate under a white `!` when blocked, and show a
Commit Chest when they ship. The left sidebar lists the herd as hero cards. Each pane header is the
hero's nameplate. The game runs itself, one tick per second, and never asks to be played.

![Down the Stack](preview.png)

## What you see

Left to right, top to bottom (`layouts/Down-the-Stack.json`):

- **Sidebar**: 268 px wide, background `chrome`.
  - Brand row, 46 px (herdr's `workspace-chrome`, draggable).
  - Spaces list (herdr's `spaces`, weight 1).
  - **The Herd** (weight 1.4): a header "The Herd N" with a calm-mode moon. Under it, one group per
    space, with 44 px hero rows:
    - a status stripe on the left;
    - a mini Termling portrait with its program icon;
    - the name, then "Lv N";
    - the career title, class and map;
    - thin HP (red `#FF5A5F`), XP (cyan `#7FE9F5`) and Fresh Eyes bars;
    - chips, such as a `!` on a blocked hero or a Forkling count.

    Heroes whose terminal closed sit in a dimmed, collapsed off-duty group. The footer shows gold,
    Snippets, the release number, a settings gear, a **Herd** button, and the zone's Sprint meter.
    Below 160 px the list becomes a rail of portraits.
  - Footer, 69 px (herdr's `workspace-chrome` footer).
- **Work column**:
  - Tabs, 42 px (herdr's `tabs`).
  - The active tab's panes, with 8 px padding and gap, radius 10 and a 1 px border (accent when
    focused). Each pane has a 34 px **nameplate** header. For an agent pane it shows:
    - the program icon;
    - the Termling's screen with its live face;
    - the hero name and level;
    - herdr's own terminal title and folder;
    - 48 px HP and 64 px XP bars;
    - a status chip on the right (for example "fighting 3-3" in grey, or "! waiting" in amber).

    Narrow panes drop parts. A non-agent pane gets herdr's plain header.
  - A hidden 368 px side panel (herdr's `files` / `changes`).
- **Stage**: 200 px tall (64 to 420), on a night gradient from `#151126` to `#2E2545`.
  - One room per map, each with a header band: the map name, a kill quota or the Sprint meter.
  - Pixel-art backgrounds per zone: sky bands, a far silhouette layer, props, and a tiled ground
    from y = 160.
  - Termlings stand in fixed slots with a name and level tag under their feet. Mobs face left
    towards them.
  - Chests, campfires, bubbles, damage numbers and banners are drawn over that.
  - When a zone boss is challenged, its room becomes an arena with the boss (112×96 px art), an HP
    bar and the mechanic's text.
- **HUD**: a hidden 26 px strip with gold, Snippets, the release and working / blocked / shipped
  counts.
- **Status bar**: 28 px (herdr's `workspace-status`).

Status colours come from the layout's `colors`: working `#4CC38A`, blocked `#F2A93B`, done
`#FFD447`, idle `#8A8F98`. Chrome follows herdr's theme; game colours appear only where they mean
something.

## How it behaves

- **working**: the Termling fights its lane on the 1 Hz beat. Its face is a blinking `>_`, and the
  room's far layer drifts. It earns XP, gold and drops, and Forklings (its sub-agents, half-size
  Termlings) hit too.
- **blocked**: after 2 ticks the hero sits on a crate under a white `!` bubble and its slot dims.
  Everything about it freezes: no damage dealt or taken.
- **done**: the task closes and a pending Commit Chest appears with a SHIPPED ribbon; the face is
  `^_^`. The chest opens with a loot fountain when you look at that terminal. Only results you have
  seen fill the Sprint meter that summons the zone boss.
- **idle**: the hero rests at a campfire with face `-_-`, and shows `z` after 10 minutes.
- **Terminal gone**: the hero steps into a portal and goes off duty. Its pending chests wait.
- **Clicks**:
  - a Termling or its `!` focuses that agent; a double click opens its character sheet;
  - a sidebar row focuses the agent's pane, and a paneless sub-agent opens in herdr's peek;
  - a row's portrait, or a right click on the row, opens the character sheet (a 760×500 dialog);
  - the Herd button opens the Herd panel (760×520: upgrades, stash, bug tracker, bosses, roster,
    digest, settings);
  - the nameplate's hero part focuses the pane and opens the sheet. On hover the nameplate shows
    split, zoom and close buttons.
- **Keys** (optional, `keys.example.json`, section `layout:Down-the-Stack`): `ctrl-shift-g` toggles the
  stage, `ctrl-shift-s` opens the focused hero's sheet, `ctrl-shift-a` the Herd panel and
  `ctrl-shift-d` calm mode. The palette has "Down the Stack: character sheet / Herd panel / calm
  mode", and herdr's own "Layout: Down-the-Stack" row switches to it.
- **Motion**: all motion is native (`.loop`, `.transition`, `.frames`): bobbing, lunges, pacing
  mobs and two-tick damage numbers. Calm mode removes damage numbers, banners and loops and dims
  the stage. The view models only change once per second.

## Built from

- **Layout** `layouts/Down-the-Stack.json`, a root `row`:
  - `sidebar` column: `brand`, then `sidebar-lists` (`spaces` and `party`), then `sidebar-footer`;
  - `work` column: `tabs`, then `work-body` row (`main` and a hidden `panel` stack of `files` and
    `changes`), then `stage`, `hud` (hidden) and `status`.

  `main` is `{ "tab": "active" }` with a pane header of `{ "mod": "mapledr", "props": { "role":
  "nameplate" } }`. The root sets `"preview": "mods/mapledr/preview.svg"` and the `mdr_*`
  colours.
- **Mod** `mods/mapledr/` (`mod.json` has `"place": "none"` and the palette entries):
  - `main.js` dispatches on `props().role`: `party`, `nameplate`, `stage`, `hud`, and the
    `sheet` and `herd` dialogs opened with `openOverlay`.
  - `host.js` keeps one game host per window. herdr runs one QuickJS VM per window, so module
    scope is shared by every copy. The host snapshots `agents()`, `terminals()`, `spaces()` and
    `focused()` once a second and saves through `readTextFile` / `writeTextFile`.
  - `game/` is the pure, deterministic engine with no herdr imports. `game/view/` builds the view
    models.
  - `ui/` holds the GPUI renderers: `div`, `image`, `svg`, `.loop`, `.transition` and `.frames`.
- **Shipped mods used**: `workspace-chrome`, `spaces`, `tabs`, `files`, `changes`,
  `workspace-status`.
- **herdr functions**: `agents`, `terminals`, `spaces`, `focused`, `panes`, `props`, `window`,
  `theme`, `settings`, `layout`, `appHome`, `home`, `checking`, `readTextFile`, `writeTextFile`,
  `run`, `openOverlay`, `closeOverlay`, `nextCommand`, `setAgentOrder`, `shared`, `setShared`.
- **Commands run**: `pane.focus`, `terminal.peek`, `terminal.pin`, `layout.toggle`,
  `layout.resize`, and its own `mapledr.*`.
- **Programs and network**: none.
- **Art**: about 170 SVGs generated by `tools/gen-art.mjs` into `mods/mapledr/art/`:
  - mobs, bosses, zone backgrounds and effects are full-colour `image()` art;
  - gear and UI icons are one-colour `svg()` masks;
  - there is no `<text>`, and the glyphs are drawn as pixels.

## Watch out

- **The folder name is load-bearing.** `mapledr` is written in the layout's `mod` blocks, its
  `preview` path, `ASSETS` in `ui/kit.js` and `SELF = { mod: "mapledr" }` in `host.js`. Rename all
  of them together. `mod.clone` rewrites the mod's own copies of these (a clone saves under
  `data/<clone>/`), but not `mod.json`'s `mapledr.*` palette commands or the layout: edit those by
  hand.
- **Palette entries work only while this layout shows.** herdr lists every mod's palette entries
  in every layout, but `mapledr.sheet` / `.herd` / `.calm` reach shown copies only; picked
  elsewhere they fail with a "mapledr.sheet failed" toast.
- herdr has no display title for a layout: Settings, the palette ("Layout: Down-the-Stack") and the
  macOS View > Layout menu show the file name, which is why the file is named after the game. herdr
  names mod actions by the mod folder, so the Keys overlay ("mapledr sheet") and failed-command
  toasts (`mapledr.sheet failed`) still show `mapledr`.
- **Save**: `<app home>/data/mapledr/save.json`, outside the mod folder, plus `save.bak` and the
  `save.broken` / `save.broken-<ms>` files that a save which fails to load is kept aside as (never
  overwritten), and `save.unsaved-<ms>` if a session ran on a new herd while `save.json` was
  unreadable. Save trouble shows as a notice on the stage and a band in the Herd panel. Hot reload and VM restarts wipe module state and cancel timers without
  `close()`, so the game resumes from the save at any moment.
- **`herdr-app check`** runs `init` with real file writes and exec. Every read and write is
  guarded by `checking()`; a forgotten guard can overwrite the real save.
- **Paneless sub-agents** (most Forklings): `agent.focus` only picks what an `agent` block shows,
  and this layout has none. Show them with `pane.focus {terminal}` when they have a pane, else
  `terminal.peek {terminal}`.
- **Status `seq`**: herdr's seen flip (done ↔ idle) does not bump an agent's `seq`, so don't gate
  status changes on `seq` alone.
- **`image()` SVGs** are rasterised once at 2× their `width`/`height` and then scaled with a
  linear filter. Art drawn larger than its viewBox (mobs, accessories, the campfire and mug icons,
  the FIXED stamp) carries `width`/`height` = k × viewBox, so always set both `w` and `h`.
- **Loop values are raw px**: multiply both `from` and `to` by `settings().zoom`. Static
  lengths are zoom-scaled by herdr.
- **Budgets**: render ≤ 50 ms, callbacks ≤ 500 ms, module evaluation ≤ 500 ms (herdr loads mods
  in a task scope, not the 5 s "detached" one). Every redraw of any copy redraws the window, so
  never `cx.notify()` from a fast timer.
- **Installing**: install or update while another layout shows. herdr reloads shown copies about
  150 ms after file changes and can briefly load a mix of old and new modules.

## Done when

- `herdr-app check <app home>/mods/mapledr` passes. In the repo, `npm test` and `npm run check`
  pass.
- After `layout.switch {"name": "Down-the-Stack"}`:
  - the sidebar lists one hero row per agent, grouped by space;
  - each agent pane's header shows its hero's nameplate;
  - the stage shows one Termling per agent.
- A working agent's Termling fights, and its XP bar fills in the sidebar and the nameplate.
- A blocked agent's Termling sits on a crate under a white `!` within a few seconds (2 ticks).
  Clicking it focuses that terminal.
- An agent that finishes while you look elsewhere leaves a pending chest. Looking at its terminal
  opens it.
- `ctrl-shift-g` (once the keys are merged) hides and shows the stage.
- Quitting and reopening herdr brings the same herd back from `save.json`.
- With no agents, the stage shows an empty-state message, and nothing throws.
