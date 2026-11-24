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
    While the save is in trouble (read-only, not saving, restored) an amber cue sits above it and
    opens the Herd panel. Below 160 px the list becomes a rail of portraits (the cue: a dot above
    the Herd button).
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
- **HUD**: a hidden 26 px strip with gold, Snippets, the release, the Sprint meter, working /
  blocked / shipped counts and a Herd button, plus an amber cue while the save is in trouble. A
  click anywhere on it opens the Herd panel.
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
- **Settings** (Herd panel): calm mode, damage numbers, the loot glow minimum rarity (drops below it
  draw no glow or pillar), stage height, the HUD strip, collapse the stage when nothing works (a
  minute after the last hero stops; back when one works; transitions only, so a stage shown or
  hidden by hand stays so), three opt-in notifications, and the autopilot master switch above the
  ten per-system switches (off: they show inactive and keep their values).
- **Notifications** (opt-in, at most 3 a game day that turns at 04:00 local, never a sound):
  `notify()` toasts for a herd-first boss kill, an LTS or Keepsake drop and a hero reaching
  Principal. They are raised by live ticks only (no burst after the app was closed) and posted once
  a save that took them landed, so a restart, a hot reload or a second window never repeats one;
  one older than 10 minutes is dropped. A click runs `mod.open` on this mod: `mod.json`'s
  `"overlay"` is the Herd panel on its Digest tab, which opens from any layout. A toast posted while
  the Herd panel is open has no click action, because `mod.open` toggles.

## Built from

- **Layout** `layouts/Down-the-Stack.json`, a root `row`:
  - `sidebar` column: `brand`, then `sidebar-lists` (`spaces` and `party`), then `sidebar-footer`;
  - `work` column: `tabs`, then `work-body` row (`main` and a hidden `panel` stack of `files` and
    `changes`), then `stage`, `hud` (hidden) and `status`.

  `main` is `{ "tab": "active" }` with a pane header of `{ "mod": "down-the-stack", "props": {
  "role": "nameplate" } }`. The root sets `"preview": "mods/down-the-stack/preview.svg"` and the
  `mdr_*` colours.
- **Mod** `mods/down-the-stack/` (`mod.json` has `"place": "none"`, the `"overlay"` that
  `mod.open` opens and the palette entries):
  - `main.js` dispatches on `props().role`: `party`, `nameplate`, `stage`, `hud`, and the
    `sheet` and `herd` dialogs opened with `openOverlay` (the Herd panel also by `mod.open`).
  - `host.js` keeps one game host per window. herdr runs one QuickJS VM per window, so module
    scope is shared by every copy. Once a second the host snapshots `agents()`, `terminals()`,
    `spaces()`, `focused()` and `window()`, ticks the world and runs `down-the-stack.tick` to
    redraw the shown copies (it reads `layout()` first, since herdr toasts a failure when no copy
    is shown). It saves through `readTextFile` / `writeTextFile`, posts notifications with
    `notify()`, and hides and shows the stage for the collapse setting.
  - `game/` is the pure, deterministic engine with no herdr imports. `game/view/` builds the view
    models.
  - `ui/` holds the GPUI renderers: `div`, `image`, `svg`, `.loop`, `.transition` and `.frames`.
- **Shipped mods used**: `workspace-chrome`, `spaces`, `tabs`, `files`, `changes`,
  `workspace-status`.
- **herdr functions**: `agents`, `terminals`, `spaces`, `focused`, `panes`, `props`, `window`,
  `theme`, `settings`, `layout`, `appHome`, `home`, `checking`, `readTextFile`, `writeTextFile`,
  `run`, `openOverlay`, `closeOverlay`, `nextCommand`, `setAgentOrder`, `shared`, `setShared`,
  `notify`.
- **Commands run**: `pane.focus`, `pane.split`, `pane.zoom`, `pane.close` (the nameplate's hover
  buttons), `terminal.peek`, `terminal.pin`, `layout.toggle`, `layout.resize`, `layout.hide`,
  `layout.show`, and its own `down-the-stack.tick`. The keys and palette run
  `down-the-stack.sheet` / `.herd` / `.calm`, and a notification's click runs
  `mod.open {name: "down-the-stack"}`.
- **Programs and network**: none.
- **Art**: 167 SVGs generated by `tools/gen-art.mjs` into `mods/down-the-stack/art/`, plus
  `preview.svg`:
  - mobs, bosses, zone backgrounds, most effects and the class accessories are full-colour
    `image()` art;
  - weapons, hats, UI icons and the loot and starburst effects are one-colour `svg()` masks;
  - there is no `<text>`, and the glyphs are drawn as pixels.

## Watch out

- **The folder name is load-bearing.** `down-the-stack` is written in four places. Rename all of
  them together:
  - the layout's `mod` blocks and its `preview` path;
  - the mod's code: `ASSETS` in `ui/kit.js`, `SELF = { mod: "down-the-stack" }` in `host.js`, and
    the dialogs' `openOverlay({ mod: "down-the-stack", … })` in `ui/stage.js` and `ui/party.js`;
  - the `down-the-stack.*` palette commands of `mod.json`;
  - the `down-the-stack.*` keys of `keys.example.json`.

  `mod.clone` rewrites only `mods/<name>` paths and `mod: "<name>"` keys in the copied files
  (herdr `mods.rs` `clone_mod_at`). Here those are all in the mod's code, so a clone draws its own
  art, talks to its own copies and saves under `data/<clone>/`. Edit `mod.json`'s commands, the
  layout and `keys.json` by hand.
- **Palette entries work only while this layout shows.** herdr lists every mod's palette entries
  in every layout, but `down-the-stack.sheet` / `.herd` / `.calm` reach shown copies only; picked
  elsewhere they fail with a "down-the-stack.sheet failed" toast.
- herdr has no display title for a layout: Settings, the palette ("Layout: Down-the-Stack") and the
  macOS View > Layout menu show the file name, which is why the file is named after the game. herdr
  names mod actions by the mod folder (the Keys overlay reads "down-the-stack sheet", a failed
  command toasts `down-the-stack.sheet failed`, a mod that fails to load says "down-the-stack did
  not load"), which is why the folder is named after the game too. Folder names are letters,
  digits, `-` and `_` (herdr `mods.rs` `valid_name`), lower case like herdr's own mods, and never
  contain `.`: herdr splits `<mod>.<command>` at the first dot.
- **Save**: `<app home>/data/down-the-stack/save.json`, outside the mod folder. Next to it:
  - `save.bak`, the previous good save;
  - `save.broken` (then `save.broken-<ms>`), a save that failed to load, kept aside and never
    overwritten;
  - `save.unsaved` (then `save.unsaved-<ms>`), a session that ran on a new herd while `save.json`
    could not be read.

  Save trouble shows as a notice on the stage, a cue in the party footer and the HUD, and a band
  in the Herd panel. Hot reload and VM restarts wipe module state and cancel timers without
  `close()`, so the game resumes from the save at any moment.
- **Notifications**: `<mod>.<command>` reaches shown copies only, so a toast's action uses the app
  command `mod.open` (it opens the `"overlay"` of `mod.json` in any layout, and closes it when run
  again). Post a milestone only after the save that records it landed, or a restart or a second
  window posts it again. Never call `notify` while `checking()`.
- **Hidden blocks persist**: `layout.hide` is kept in the layout's click state across restarts, so
  a mod that hides its own block must remember that it did (here `herd.cfg.collapsed`) to show it
  again.
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
  never `cx.notify()` from a fast timer. The stage also keeps to about 400 elements and 150
  animated nodes per render: it counts both exactly and thins scenery, then the rigs, then mobs
  on wide stages with many heroes, and last merges status marks into fewer elements (never
  hiding a status cue), holding a level until the finer one fits with room to spare so nothing
  flickers between levels.
- **Installing**: install or update while another layout shows. herdr reloads shown copies about
  150 ms after file changes and can briefly load a mix of old and new modules.

## Done when

- `herdr-app check <app home>/mods/down-the-stack` passes. In the repo, `npm test` and
  `npm run check` pass.
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
- With "Collapse the stage when nothing works" on, the stage hides a minute after the last agent
  stops working and shows again when one starts.
- With a notification turned on, its milestone posts one toast and no sound. Clicking the toast
  opens the Herd panel on its Digest tab, and restarting herdr does not post it again.
- Quitting and reopening herdr brings the same herd back from `save.json`.
- With no agents, the stage shows an empty-state message, and nothing throws.
