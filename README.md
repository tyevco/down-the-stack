# Down the Stack

An idle side-scrolling dungeon for [herdr](https://herdr.dev). Every coding agent becomes a
**Termling**, a small hero shaped like a terminal window. It fights developer bugs while its agent
works, waits on a crate while the agent needs you, and drops a Commit Chest when the agent ships.
Nothing needs playing: one tick per second, autopilot for everything.

![Down the Stack](preview.png)

It is a herdr-app 0.1.17 **layout** (`layouts/Down-the-Stack.json`) plus the **mod** it shows
(`mods/down-the-stack/`). `RECIPE.md` is the brief to rebuild it, and `docs/DESIGN.md` is the full
game design.

## Install

herdr's app home is the same on every OS, macOS and Windows included:
1. `$HERDR_APP_HOME` if set;
2. else `$XDG_CONFIG_HOME/herdr-app`;
3. else `~/.config/herdr-app`.

Below, `<home>` means that folder.

1. **Show another layout first** (for example `ctrl-shift-l`, `cmd-shift-l` on macOS, or Settings).
   - herdr watches `layouts/` and `mods/`, and reloads every copy of a mod that is on screen
     about 150 ms after files change.
   - A slow copy over a running install can load a mix of old and new modules for a moment.
   - Copying to a temporary folder and renaming it into place also avoids this.
2. Copy the files:
   ```sh
   cp layouts/Down-the-Stack.json  <home>/layouts/Down-the-Stack.json
   cp -r mods/down-the-stack       <home>/mods/down-the-stack
   ```
   - The mod folder **must be named `down-the-stack`**. These all use that name:
     - the layout's `"mod": "down-the-stack"` blocks and its `"preview"` path;
     - the asset root `ASSETS = "mods/down-the-stack"` (`mods/down-the-stack/ui/kit.js`);
     - `SELF = { mod: "down-the-stack" }` (`mods/down-the-stack/host.js`: overlays, commands and
       the save folder) and the dialogs' `openOverlay({ mod: "down-the-stack", … })`
       (`mods/down-the-stack/ui/stage.js`, `mods/down-the-stack/ui/party.js`);
     - the `down-the-stack.*` commands in `mod.json` and `keys.example.json`.
   - If the name is taken, rename all of them together. herdr's `mod.clone` rewrites only
     `mods/<name>` paths and `mod: "<name>"` keys, which covers the ones in the mod's code. It
     leaves the `down-the-stack.*` commands of `mod.json`, the layout and `keys.json` alone.
   - The layout file's name is its title in herdr, so keep `Down-the-Stack` unless that is taken
     too.
   - Leave `RECIPE.md`, `preview.png`, `docs/`, `tools/` and `test/` out: the mod needs none of
     them.
3. Check the mod:
   ```sh
   herdr-app check <home>/mods/down-the-stack
   ```
4. Optional keys: merge the `layout:Down-the-Stack` section of `keys.example.json` into
   `<home>/keys.json`.
   Add the section, and ask yourself before replacing a key you already use. These keys apply only
   while this layout shows:

   | Key | Action |
   |---|---|
   | `ctrl-shift-g` | show or hide the stage strip (`layout.toggle:stage`) |
   | `ctrl-shift-s` | character sheet of the focused agent's hero (`down-the-stack.sheet`) |
   | `ctrl-shift-a` | Herd panel (`down-the-stack.herd`) |
   | `ctrl-shift-d` | calm mode (`down-the-stack.calm`) |

   An untouched `keys.json` is replaced by newer default shortcuts when herdr updates. Once you edit
   it, it is yours, and new default shortcuts must be added by hand.
5. Switch to it in any of these ways:
   - the Settings layout picker (the card is called "Down-the-Stack");
   - the palette row "Layout: Down-the-Stack";
   - the command `layout.switch {"name": "Down-the-Stack"}`;
   - `ctrl-shift-l` cycling (`cmd-shift-l` on macOS).

   Your own layout stays as it was, and the same key switches back.

herdr has no display title for a layout, so Settings, the palette and the macOS View > Layout menu
show the file name, "Down-the-Stack". herdr names mod actions by the mod folder, so the Keys
overlay reads "down-the-stack sheet" and a failed command toasts `down-the-stack.sheet failed`. The
game itself only says "Down the Stack".

## What it touches

- It runs no programs and makes no network requests.
- It reads and writes its save in `<home>/data/down-the-stack/`:
  - `save.json`, and `save.bak`, the previous good save;
  - `save.broken` (then `save.broken-<ms>`): a save that failed to load, kept aside and never
    overwritten;
  - `save.unsaved` (then `save.unsaved-<ms>`): a session that ran on a new herd while
    `save.json` could not be read, kept aside once the old save is back.
- It posts no notifications unless you turn them on in the Herd panel's Settings tab (herd-first
  boss kill, LTS or Keepsake drop, a hero reaches Principal). Then it posts at most 3 a game day
  (the day turns at 04:00) as herdr toasts, never with a sound, and only for what happens while
  herdr runs. Clicking one opens the Herd panel on its Digest tab (`mod.open`), from any layout.
- With "Collapse the stage when nothing works" on (Settings tab, off by default), it hides its own
  stage block a minute after the last hero stops working and shows it again when one works
  (`layout.hide` / `layout.show`). herdr keeps a hidden block hidden across restarts
  (`<home>/layouts/.state/`), and the save remembers that the game hid it.
- Its own buttons change the layout as herdr's chrome does: the sidebar's rail button
  (`layout.resize` on `sidebar` and herdr's shared `sidebar.width` / `sidebar.collapsed`, like
  herdr's agents list), and the Settings tab's stage height and HUD strip (`layout.resize` /
  `layout.toggle`).
- It does no IO during `herdr-app check`.

## Update and uninstall

- **Update:** show another layout, replace both copies the same way as installing, run
  `herdr-app check` again, then switch back. The save carries over.
- **Uninstall:** delete `<home>/layouts/Down-the-Stack.json` and `<home>/mods/down-the-stack/`. Also
  delete `<home>/data/down-the-stack/` to drop the save. Remove the `layout:Down-the-Stack` section
  from `keys.json` if you merged it.

## Develop

You need Node 22 or later. `npm test`, `npm run check`, `npm run art` and `npm run pacing` use no
packages (a few tests take screenshots with Playwright when it is installed and skip otherwise).
`npm run qjs` needs the devDependencies in `package.json`, so run `npm install` once first. The
screenshot commands need Playwright with Chromium, loaded with `require("playwright")`, so install
it where Node finds it.

| Command | What it does |
|---|---|
| `npm test` | unit tests (`node --test "test/*.test.mjs"`); wall-clock bounds are loose unless `PERF=1 npm test`, which applies the strict ones (run it on an idle machine) |
| `npm run check` | a Node mock of `herdr-app check` plus every role at several widths and zooms |
| `npm run preview` | HTML renders and screenshots of the roles into `out/` |
| `npm run windows -- --roles --preview` | whole-window screenshots of the demo worlds into `out/` (`--roles` adds each role alone, `--preview` also rewrites `preview.png`) |
| `npm run art` | regenerate `mods/down-the-stack/art/` and `preview.svg` (never hand-edit art) |
| `node tools/art-sheet.mjs` | a contact sheet of every generated asset into `out/art-sheet.png` |
| `npm run pacing` | the headless persona simulator (`-- --sweep` for the full sweep) |
| `npm run qjs` | the mod in QuickJS-ng with herdr's limits and sandbox (`tools/qjs/README.md`) |

Read `docs/ARCHITECTURE.md` (the build contract and herdr's runtime rules) before changing the
mod. `docs/BALANCE.md` lists the intended deviations from the design. `docs/herdr-notes/` has
research notes on herdr, with source citations.
