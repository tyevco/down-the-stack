# herdr-app layouts: schema, `main`, packaging, and the `mapledr` draft

Source: `/home/user/herdrdev/herdr-app` (master, ~0.1.17). Paths below are relative to it.
Read only: nothing was built or run. "UNCONFIRMED" marks things I could not confirm from source.

Files written next to these notes during the research (not kept in the repo; they became
`layouts/Down-the-Stack.json` and `mods/mapledr/preview.svg`):
- `mapledr.json`: the draft layout (section 3)
- `mapledr.svg`: the draft settings preview (320x200, same style as `win98.svg`)

Shipped naming (decided after these notes): the layout ships as `layouts/Down-the-Stack.json`. herdr
has no display title for a layout and shows the file name (section 4, "The settings card name").
The mod folder stays `mapledr`. The keys section is therefore `layout:Down-the-Stack`, while the
actions stay `mapledr.<cmd>`. "`mapledr.json`" below is the research draft's name.

---

## 0. Short version (the facts that matter most)

1. A layout is one serde `Node` tree (`src/layout.rs:355-431`). There is **no `deny_unknown_fields`**,
   so unknown keys are ignored. They are also **lost** whenever Herdr rewrites the file (see 1.9).
2. **Pane-header props are merged.** The layout's `props` object is cloned, then `pane` and
   `terminal` are set on it (`src/window.rs:5471-5476`; critic-verified). The props must be a JSON **object**: any
   other value is replaced by `{}` first (`if props.is_object() { props.clone() } else { json!({}) }`). Keys named
   `pane`/`terminal` in the layout props are overwritten. Only the first `{tab, pane}` frame's header is used
   (`window.rs:1373-1385`, `find_map`), so `{role:"nameplate"}` arrives as
   `{role:"nameplate", pane:"<pane id>", terminal:"<addr>"|null}`. Floats get `+float: <id>`
   (`window.rs:5464-5468`). Block and stack-header mods get their props unchanged
   (`window.rs:1287`, `1290-1297`).
3. **`localStorage` is per (mod, props)**: the file is `data/<mod>/store-<hash(props JSON)>.json`,
   or `store.json` when props are null (`src/mods.rs:1459-1473`). So `stage`, `party`, `hud` and
   *every pane's nameplate* each have their own store. Game state that several roles share must not go
   in `localStorage`. CORRECTED (critic): live state is shared through **module scope** (one evaluation per
   source revision, shared by every copy: `vendor/gpui-kit/crates/shell/src/engine/quickjs/mod.rs:2349-2398`,
   test `src/mods/render_tests.rs:282-338`). It is persisted with `writeTextFile` into `data/mapledr/save.json`.
   `shared()/setShared()` is for rare signals only (runtime.md, Critic verification Q1/Q2).
4. **`mod.json` must say `"place": "none"`.** A missing `place` defaults to `"right"`
   (`window.rs:4527`). The first time Herdr sees the folder it then docks a copy into the shown
   *personal* layout (`window.rs:4521-4538`).
5. Shipped mods look up **fixed node ids**: `sidebar` (spaces, agents and workspace-chrome use it for
   the narrow rail and folding), and `panel`, `panel-body`, `files` and `changes` (tabs mod panel
   buttons, welcome). `ctrl-shift-b` / `cmd-b` = `layout.toggle:sidebar`. Keep these ids.
6. Colors in nodes are theme names or `#rrggbb[aa]` (`window.rs:71-73` → `settings.rs:708-710`).
   An unknown name paints **magenta** (`settings.rs:703-705`). Root `colors` values **must be hex**
   (`settings.rs:661-664`). Any key in `colors` is inserted into the theme map, **custom names
   included** (`settings.rs:360-362`). So a layout can define `mdr_gold` once and use it by name in
   nodes, and mods can read it as `theme().mdr_gold`.
7. A broken layout file (a serde error) writes `layout.error` and shows the **shipped `main`**
   as a stand-in. A name Herdr doesn't ship falls back to `main` (`window.rs:162-169`, `1035-1053`).
   Look problems (unknown theme, non-hex `colors`, `font_size` outside 6..72) also go to
   `layout.error`, but the layout **is** applied, with the theme falling back to graphite
   (`window.rs:958-962`, `settings.rs:776`).

---

## 1. The layout node schema, as implemented

Parsed with `serde_json::from_str::<Node>` (`window.rs:1036`, `1129`). All sizes are logical px
at zoom 1. The renderer multiplies them by `settings::z()` (zoom) (`window.rs:5531-5546`).

### 1.1 `Node` (every node; `src/layout.rs:355-431`)

| key | type | default | notes |
|---|---|---|---|
| `id` | string | `""` | `#[serde(default)]` (l.357). Missing ids get `node-N` and **the file is rewritten** (`window.rs:1259-1277`). Give every node an id. Uniqueness is **not validated** (see 5). |
| `type` | `"block"\|"row"\|"column"\|"stack"` | required | `Kind` is internally tagged, `tag="type"`, lowercase (l.312-331), and flattened into Node (l.361). |
| `content` | Content | required for `block` | l.315-317 |
| `children` | Node[] | required for row/column/stack | l.318-330 |
| `active` | string | none | stack only: shown child id. A missing or hidden id falls back to the first visible child (l.704-707). |
| `header` | Header | none | stack only: a tab strip above or below (see 1.5) |
| `size` | `{px:f32}` \| `{weight:f32}` | weight 1 | untagged (l.79-84). Px is fixed. A weight is a share of what the px siblings leave (`window/pane_size.rs:31-37`, `window.rs:5525-5549`). |
| `min`, `max` | f32 px | none | along the parent's axis; also clamps px sizes (`pane_size.rs:57`). |
| `hidden` | bool | false | skipped in render (l.602-615). `layout.toggle/show/hide {id}` changes it (`window.rs:3646-3654`). Saved as a click. |
| `title` | string | none | caption in a stack's built-in `"tabs"` strip (`window.rs:4818`). |
| `background` | Background | none | see 1.3 |
| `border` | `{width=1, color="border"}` | none | `Line` (l.86-92): all four sides. |
| `radius` | f32 | none | the node clips (`overflow_hidden`, `window.rs:4631`) |
| `shadow` | `"sm"\|"md"\|"lg"` | none | other strings are ignored (`window.rs:5610-5617`) |
| `padding` | `16` or `[vertical, horizontal]` | none | (l.153-169). **Note the order**: `terminal_padding` is `[x, y]` (l.204-206). |
| `focus` | `{border?: Line, background?: color string}` | none | used while the focused block is inside this node (l.236-243, `window.rs:5573-5584`). Background is a color only, not a gradient. |
| `gap` | f32 | 0 | row/column: px between children. Inside a tab it inherits the pane frame `gap` (`pane_size.rs:23-25`). |
| `divider` | `{width=1, color="border", hover?, active?}` | none | row/column: a line between children (l.95-113) |
| `resizable` | bool | true | row/column: dragging its own boundaries. Not inherited. |
| `movable` | bool | none (= true) | tab panes can be dragged by the grip. Inherited from the nearest explicit ancestor (AGENTS.md:258-265). |
| `closable` | bool | true | only checked by `pane.close` for tab panes (`window.rs:3340`) |
| `floating` | Float[] | [] | see 1.6 |
| `window_drag` | bool | false | dragging moves the window; a double-click maximizes (`window.rs:4636-4638`) |
| `cloned_from` | `{name, version}` | none | written by `layout.clone` |
| Look keys (flattened `Look`, l.173-210) | | | see 1.7. **Only the root's look is used** (`window.rs:958` composes `self.chrome.look`). AGENTS.md:387 says "Today only the root's look applies". |
| root-only keys | | | see 1.8 (parsed on any node, read only from the root) |

### 1.2 `content` (`Content`, untagged, tried in this order; `src/layout.rs:10-31`)

1. `{ "terminal": "<address>" }`: a terminal block
2. `{ "mod": "<folder>", "props": <any JSON, default null> }`. The props become `props()` in the mod.
   A missing mod folder shows `"<name> did not load: no mod folder ~/.config/herdr-app/mods/<name>"`
   in the block (`window.rs:1871-1875`, `4788-4796`).
3. `{ "tab": "active", "pane": PaneFrame? }` (alias `"context"`, the 0.1.0 word): the shown tab's panes
4. `{ "agent": "focused" }`: one agent terminal at full size

Because it is untagged, a wrong field type anywhere inside (for example inside `pane`) gives serde's
generic `data did not match any variant of untagged enum Content` in `layout.error`.

### 1.3 `background` (`Background`, untagged; `src/layout.rs:124-151`)

- `"canvas"` / `"#rrggbb[aa]"`: a color (`Color(String)`)
- `{ "gradient": [a, b], "angle": 180 }`: two colors (names or hex). The angle is in degrees,
  CSS-style, and defaults to 180 (top to bottom, l.141-143).
  Rendered as `linear_gradient(angle, a@0, b@1)` (`window.rs:5598-5600`).
- `{ "image": "path", "fit": "cover"|"contain" }`, where fit defaults to `cover`. The path is joined
  to the **app home** (`mods::app_dir().join(image)`, `window.rs:5601-5606`), so
  `"mods/mapledr/art/bg.png"` works. It is drawn as an absolutely positioned child behind the content.

### 1.4 Pane frame: `{tab:"active", pane:{...}}` (`PaneFrame`, `src/layout.rs:284-310`)

| key | type | default |
|---|---|---|
| `header` | Header | none |
| `background` | Background (color, gradient or image) | none |
| `shadow` | `sm\|md\|lg` | none |
| `border` | Line `{width=1,color="border"}` | none |
| `focus` | Line: replaces `border` while the pane is focused (`pane_size.rs:15-17`) | none |
| `veil` | 0..1: fades non-selected panes with the terminal bg color (`window.rs:4621-4627`) | none |
| `radius` | f32 | none |
| `gap` | f32: px between panes | none |
| `lone` | bool: frame a one-pane tab too | false (frames only when split, `window.rs:4578-4586`) |

The frame (and so the header) is used only when the tab is split **or** `lone: true`.
Keep `focus.width == border.width`: the pane's content size subtracts the *current* border width
(`pane_size.rs:43-47`), so unequal widths re-flow the terminal on every focus change. This is
inferred from the code; I did not see it happen (UNCONFIRMED).

### 1.5 `Header` (pane header and stack header; `src/layout.rs:245-280`)

| key | type | default |
|---|---|---|
| `content` | `"tabs"` (built-in strip; only meaningful on stacks) or `{mod, props}` | required |
| `height` | f32 px | 30 (`HEADER_HEIGHT`, `window.rs:32`; `pane_size.rs:19-21`) |
| `position` | `"top"` \| `"bottom"` | top |
| `reveal` | `"always"` \| `"hover"` (drawn over the terminal, opacity 0 → 1 on group hover, so it never resizes) | always (`window.rs:4610-4618`) |

Pane header mods get one copy per pane, in slot `"<pane id>#frame"`. Their props are the
layout props **merged** with `pane` and `terminal` (`window.rs:5471-5476`; `terminal` is null for mod
panes). The header row is drawn as `div().h(height).w_full().flex().child(slot)`
(`window.rs:4611-4612`). The app's movable-pane grip appears on top-edge hover regardless of the
header (`window.rs:4691-4692`). Stack header mods use slot `"<stack id>#header"`, with props unchanged.

### 1.6 `floating` (`Float`, `src/layout.rs:61-77`)

`{ "id": string (required), "content": Content (required), "edge": "top|right(default)|bottom|left",
"align": "start|center(default)|end", "peek"?: f32 (side edges only: drawer), "hidden"?: bool }`.
- A float sits 12 px in from its node's edge and sizes to its content. Herdr draws the frame
  (popover bg, border, radius, shadow, 5 px pad). If the content renders nothing, the float is hidden
  (AGENTS.md:428-456; `window/floats.rs:127-190`). Drag-and-drop snaps it to an edge and third
  (`layout.rs:766-784`); the spot is saved as a click.
- A mod float's props get `float: <id>` (`window.rs:5464-5468`), slot `"float:<id>"`
  (`floats.rs:26-28`). It reads `placement()` → `{edge, align, vertical, hovered, dragging}`.
- A terminal float is drawn 560x320 (`floats.rs:134-136`).
- `layout.toggle/show/hide` only find **nodes**, not floats (`window.rs:3648` uses `find_mut`).
  To hide a float, render nothing.

### 1.7 Look keys (flattened `Look`; root only in practice; `src/layout.rs:173-210`, `settings.rs:583-623`)

`theme` (string, or `{light, dark}`), `colors` (map name→hex), `font`, `font_size` (6..72),
`font_weight`, `font_weight_bold` (100..900), `terminal_line_height` (0.8..2), `terminal_cell_width`
(0.8..2), `terminal_scroll_speed` (0.1..5), `ui_font`, `terminal_padding` `[x, y]`,
`terminal_opacity` (0..1).
- `theme`: a preset (`graphite`, `ink`, `moss` dark; `paper` light; `settings.rs:80`) or
  `themes/<name>.json`. An unknown theme is reported to `layout.error`, and the palette falls back
  to GRAPHITE (`settings.rs:186`, `653-660`, `776`). The person's theme pick (a click in
  `layouts/.state/<name>.json`) overrides the layout's `theme` (`window.rs:1066`, `layout_sync.rs:16-17`).
- `colors`: merged as person's settings `colors`, then layout `colors` (`settings.rs:585-586`), then
  inserted over the resolved palette (`settings.rs:360-362`). Keys may be **any** name: the existing
  theme names (`background, terminal_foreground, foreground, surface, canvas, chrome, popover, raised,
  hover, selected, border, input, muted, dim, accent, accent_foreground, solid, solid_foreground, ring,
  selection, cursor, working, blocked, done, idle, unknown, ansi0..ansi15`; `settings.rs:326-359`) or
  new ones. Values must be `#rrggbb` or `#rrggbbaa`, or they are reported (`settings.rs:661-664`).
  Overrides apply in **both** light and dark appearance, and also over a theme the person picks.
  Terminals use `background`, `terminal_foreground`, `cursor`, `selection` and `ansi0..15` from
  this map (`vt.rs:76-85`).
- Fonts: `.ttf/.otf` in `mods/<mod>/fonts/` (or the home's `fonts/`) load at start and on the next
  look change (AGENTS.md:372-375, `window.rs:955-957`). Root `ui_font` changes the font of **every**
  mod in the layout, the shipped spaces/tabs included.

### 1.8 Root-only keys (`src/layout.rs:405-430`)

| key | meaning |
|---|---|
| `titlebar` | `"system"` (default) \| `"none"`: the layout draws its own bar with `window_drag` blocks. On Linux, `none` asks for client decorations, and mods draw the window buttons when `window().buttons` (`window/titlebar.rs:38-62`). The shipped `tabs` mod already does (`mods/tabs/main.js:153-155`). |
| `traffic_lights` | `[x, y]` px: macOS window buttons with `titlebar:"none"` |
| `preview` | `"<path>.svg"` or png, relative to the app home: the settings picture |
| `terminal_menu` | mod for terminal right-click (default `menu`). Unknown: warn, then `menu` (`window.rs:3968`). |
| `link_handlers` | string[]: mods that handle Ctrl/Cmd-clicks in order |
| `toast` | mod for notifications (default `toast`; `window.rs:3982`) |
| `window_blur` | bool: frosted glass where the OS can |

### 1.9 Unknown keys, rewrites, ids

- No struct uses `deny_unknown_fields`, so unknown keys are silently ignored at parse.
- Herdr **re-serializes the file** (dropping unknown keys and your formatting) when:
  (a) a node has no `id` (`keep_ids`, `window.rs:1259-1277`);
  (b) on a personal layout, the structure changes beyond clicks: a mod docked by `place`, or
  `layout.set` (`save_layout`, `window.rs:1196-1213`; never for shipped names).
  Clicks (sizes, hidden, stack active, float spots, theme pick, background, font size, header
  height, pane border and focus) go to `layouts/.state/<name>.json` instead (`layout_sync.rs:10-46`).
  A later edit to the file wins over a click on the same field (`window.rs:1061-1065`, `1143-1146`).
- `dock()` wraps the root when the axis differs. It moves only `toast`, `terminal_menu` and
  `link_handlers` to the new root (`window.rs:5504-5523`), so the old root's `theme`, `colors`,
  `titlebar`, `traffic_lights` and `preview` would stop applying. This is one more reason for
  `"place":"none"`. (Inferred from code: UNCONFIRMED in practice.)

---

## 2. `defaults/layouts/main.json`, verbatim, and what it uses

```json
{
  "id": "root",
  "type": "row",
  "titlebar": "none",
  "traffic_lights": [
    12,
    16
  ],
  "background": "canvas",
  "terminal_padding": [
    14,
    12
  ],
  "divider": {
    "width": 1,
    "color": "border"
  },
  "children": [
    {
      "id": "sidebar",
      "type": "column",
      "size": {
        "px": 268
      },
      "min": 44,
      "max": 480,
      "background": "chrome",
      "resizable": false,
      "children": [
        {
          "id": "brand",
          "type": "block",
          "size": {
            "px": 46
          },
          "window_drag": true,
          "content": {
            "mod": "workspace-chrome"
          }
        },
        {
          "id": "sidebar-lists",
          "type": "column",
          "children": [
            {
              "id": "spaces",
              "type": "block",
              "size": {
                "weight": 1
              },
              "min": 90,
              "content": {
                "mod": "spaces"
              }
            },
            {
              "id": "agents",
              "type": "block",
              "size": {
                "weight": 1
              },
              "min": 90,
              "content": {
                "mod": "agents"
              }
            }
          ]
        },
        {
          "id": "sidebar-footer",
          "type": "block",
          "size": {
            "px": 69
          },
          "content": {
            "mod": "workspace-chrome",
            "props": {
              "footer": true
            }
          }
        }
      ]
    },
    {
      "id": "work",
      "type": "column",
      "resizable": false,
      "children": [
        {
          "id": "tabs",
          "type": "block",
          "size": {
            "px": 42
          },
          "window_drag": true,
          "content": {
            "mod": "tabs"
          }
        },
        {
          "id": "work-body",
          "type": "row",
          "padding": 8,
          "gap": 8,
          "children": [
            {
              "id": "main",
              "type": "block",
              "content": {
                "tab": "active",
                "pane": {
                  "gap": 8,
                  "radius": 10,
                  "background": "background",
                  "lone": true,
                  "border": {
                    "width": 1,
                    "color": "border"
                  },
                  "focus": {
                    "width": 1,
                    "color": "accent"
                  },
                  "header": {
                    "content": {
                      "mod": "pane"
                    },
                    "height": 30,
                    "position": "top",
                    "reveal": "always"
                  }
                }
              }
            },
            {
              "id": "panel",
              "type": "column",
              "hidden": true,
              "size": {
                "px": 368
              },
              "min": 280,
              "max": 900,
              "children": [
                {
                  "id": "panel-body",
                  "type": "stack",
                  "active": "files",
                  "children": [
                    {
                      "id": "files",
                      "type": "block",
                      "content": {
                        "mod": "files"
                      }
                    },
                    {
                      "id": "changes",
                      "type": "block",
                      "content": {
                        "mod": "changes"
                      }
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "id": "status",
          "type": "block",
          "size": {
            "px": 28
          },
          "content": {
            "mod": "workspace-status"
          }
        }
      ]
    }
  ]
}
```

Tree: `root(row)` = [`sidebar(column, 268px, chrome)` = [`brand` 46px, `sidebar-lists(column)` =
[`spaces` w1, `agents` w1], `sidebar-footer` 69px], `work(column)` = [`tabs` 42px,
`work-body(row, pad 8, gap 8)` = [`main` (tab, framed panes, `pane` header 30px), `panel(column,
hidden, 368px)` = [`panel-body(stack)` = [`files`, `changes`]]], `status` 28px]].

| mod (`defaults/mods/<name>/`) | where | props | depends on |
|---|---|---|---|
| `workspace-chrome` | `brand` | none | `sidebar` px < 160 = rail; toggles the rail with `layout.resize {id:"sidebar", px}` (main.js:15-24); `frame/welcome/herdr.png`; on macOS pads for the traffic lights |
| `workspace-chrome` | `sidebar-footer` | `{footer:true}` | Settings (`app.settings`), Add machine (`mod.open machine-add`) |
| `spaces` | `spaces` | none | `sidebar` width for the rail (main.js:20) |
| `agents` | `agents` | none (its own popup uses `{sortMenu:true}`) | `sidebar`. Calls `setAgentOrder(...)` (main.js:249). Draws the `»` that unfolds the rail (main.js:456-470). |
| `tabs` | `tabs` | none | `+` opens `new-menu` (popup 250x512); Files/Changes buttons use `panel`, `panel-body`, `files`, `changes` (main.js:126-152); draws window buttons when `window().buttons`; per-space panel memory in its own localStorage |
| `pane` | pane header | (merged `{pane, terminal}`) | reads its frame position from `layout()` |
| `files`, `changes` | `panel-body` stack | none | `shared("workspace.panels")` decides which buttons the tab bar shows |
| `workspace-status` | `status` | none | machine, branch, agent count, `app.palette` hint |
| `new-menu`, `menu`, `toast`, `picker`, `confirm`, `prompt`, `peek`, `worktree`, `machine-add`, `help` | overlays opened by the above | | `missing_mods()` only counts `"mod"` keys **in the layout file** (`window.rs:233-251`) |

All shipped mods use `mod.json` `{"place":"none"}`. Herdr's own frame mods (`frame-*`) always
count as present (`window.rs:249`).

---

## 3. Recommended draft: `mapledr.json`

The file is in this folder. It is `main.json` with these changes:

1. **`party` replaces `agents`** in `sidebar-lists`: `{ "mod": "mapledr", "props": { "role": "party" } }`,
   `weight 1.4`, `min 140` (portraits and bars need more height than the plain list). The party mod
   must take over what the `agents` mod did:
   - call `setAgentOrder(list.map(a => a.address))` in `render()`, so `agent.next/prev/select`
     (`alt-up/down`) follow the party order (AGENTS.md:174-178);
   - draw a narrow-rail mode when `find(layout(),"sidebar").size.px < 160`;
   - on macOS, draw the `»` unfold control. workspace-chrome hides its toggle on the macOS rail and
     relies on the agents list's `»` (workspace-chrome/main.js:52-53).
   - Without these, `cmd-b`/`ctrl-shift-b` still hides or shows the whole sidebar.
2. **The pane header is our nameplate:** `{ "mod": "mapledr", "props": { "role": "nameplate" } }`,
   `height 34` (one name/level row plus HP/XP bars), `top`, `always`, `lone: true`.
   `role` is preserved; Herdr adds `pane` and `terminal` (section 0, point 2).
   The nameplate should keep the shipped `pane` behaviour: click → `pane.focus {pane}`; on hover,
   split-right, split-down, zoom and close buttons. Each button stops propagation.
   The focus ring uses `mdr_gold` at the same width as the border (1).
3. **`stage`** is a new block in `work`, between `work-body` and `status`:
   `size {px:210}`, `min 120`, `max 420`. `background` is a gradient `["mdr_sky","mdr_dusk"]`, which
   shows while the mod loads or if it fails; the mod paints its own parallax over it.
   Content is `{mod:"mapledr", props:{role:"stage"}}`. It spans only the work area, so the sidebar
   keeps full height. `work` is `resizable:false`, as in main, so its height is not draggable. Resize
   it from the mod or a key with `run("layout.resize",{id:"stage",px})`; that is saved as a click.
   Clicks in a non-pane mod block leave the keyboard with the terminal (`window.rs:4776-4780`), so
   clicking a mob doesn't steal typing.
4. **`hud`** (optional) is 26px, **`hidden: true`** by default, `{role:"hud"}`, for a MapleStory-style
   HP/MP/EXP strip. A hidden block's copy starts only when first shown (AGENTS.md:942-947), so it
   costs nothing until toggled (`layout.toggle:hud`). Alternatives: draw the EXP strip along the
   stage's bottom edge (the preview does that), or replace `workspace-status` with a HUD that also
   shows its facts (machine, branch, agent count, palette hint).
5. Everything else from main is kept: `brand` and `sidebar-footer` (workspace-chrome), `spaces`,
   `tabs` (with `+` new-menu and window buttons), the `panel`/`panel-body`/`files`/`changes` ids, and
   `status`. The root keeps `titlebar:"none"`, `traffic_lights [12,16]`, `canvas`, and
   `terminal_padding [14,12]`.
6. The root `preview` is `"mods/mapledr/preview.svg"`. The path is relative to the app home
   (asset root = `mods::app_dir()`, `src/main.rs:186`), so the picture travels **inside the mod
   folder**. Installers copy only `layouts/<name>.json` and `mods/<name>/` (AGENTS.md:489-505); a
   `layouts/mapledr.svg` could be left behind.

### Colors and theme

- A layout **can** set its own `theme` and `colors` (root only). The draft deliberately sets **no
  `theme`**, so the person's light/dark theme still drives herdr's own chrome. It defines **new**
  color names in the root `colors` instead: `mdr_sky #2c2148`, `mdr_dusk #7a3f5c`,
  `mdr_ground #3a2a1c`, `mdr_grass #5d7f3a`, `mdr_parchment #efe1bf`, `mdr_ink #3b2a1a`,
  `mdr_gold #e3b04b`, `mdr_hp #d9534f`, `mdr_mp #4f8fd9`, `mdr_xp #9bd94f`.
  New names never clobber existing theme colors. Nodes use them by name (`"mdr_gold"`), and the mod
  reads them from `theme()` (`mods.rs:1315` serializes the full map; `theme().mdr_gold`). Herdr
  chrome stays on theme names (`chrome`, `canvas`, `border`, `background`).
- For a full fantasy look (warm dusk everywhere), add to the root, for example,
  `"theme": "ink"` plus overrides such as `"chrome": "#1d1626"`, `"canvas": "#241a2f"`,
  `"accent": "#e3b04b"`, `"border": "#ffffff1a"`. Caveats: hex overrides apply in light mode too and
  over a theme the person picks. A `themes/mapledr.json` would be "the layout's own" (Settings
  offers it only while `mapledr` shows; `frame/settings/main.js:362-364`). But installers may not
  copy a `themes/` file, and a missing theme only reports an error and falls back to graphite.
  If you ship one anyway, say so in RECIPE.md "Watch out".
- The settings card name is the file name: `LOOKS[name] ?? name` (`frame/settings/main.js:18`, `316`).
  There is no display-name field, so a `mapledr.json` would show as "mapledr". The shipped file is
  `Down-the-Stack.json` for this reason.
- The same name, or the mod folder name, is shown everywhere else herdr lists layouts or mod actions:
  - Palette: one row per installed layout, titled `Layout: ${Cap(name)}` (only main, terminals and
    win98 have nicer titles), so "Layout: Down-the-Stack" (`frame/palette/main.js:154-157`).
    A mod palette entry that only switches to the layout duplicates this row.
  - macOS menu bar: View > Layout has one item per layout, titled with the raw name
    (`src/macos.rs:66-69`).
  - win98 Start menu: the raw name; only win98 itself is renamed, to "Herdr 98"
    (`mods/win98/taskbar.js:209-210`).
  - Keys overlay: the key, its section in brackets, then the action with `.`/`_` turned into spaces.
    So `ctrl-shift-s  (layout:Down-the-Stack)` reads `mapledr sheet` (`mods/help/main.js:17-22,83`).
  - Mod palette entries show their own `title` (ours say "Down the Stack: …"). But a command that
    fails toasts `<mod>.<cmd> failed` (`src/window.rs:3076-3078`).
  - So a layout or mod name is visible to the person. Pick one you are happy to show, or accept that
    the id shows in herdr's chrome.

### Preview SVG

- `win98.svg` uses `viewBox="0 0 320 200"`, `shape-rendering="crispEdges"`, and flat `<rect>`s with
  one `<linearGradient>`. It has no `<text>` and is 3.5 KB. It shows the whole window in the
  layout's own colors.
- Settings draws it with `image(path).w_full().h(62).rounded(6)` inside a 124px-wide card with 6px
  padding (≈112x62 box; `frame/settings/main.js:288-309`). The fit for a non-matching aspect ratio is
  the GPUI default (UNCONFIRMED: probably contain). Keep 320x200 like win98. Avoid `<text>`: text
  needs fonts in the SVG renderer (UNCONFIRMED).
- The draft `mapledr.svg` (8.5 KB, same 320x200 style) shows: sidebar (spaces + 3 party cards with
  portrait, level badge, HP and XP bars), tab pills, two pane cards with nameplate headers (the
  focused one framed gold), the dusk stage band (hills, platform, 3 heroes, 2 mobs, boss with HP bar,
  EXP strip), and the status bar. I checked it with a small Pillow rasterizer
  (`../render/mapledr-preview.png`); no SVG renderer was available.
- `preview.png` for sharing is a real screenshot: `herdr-app shot preview.png` (AGENTS.md:67-76).

### Keys for the layout (`keys.json`, merged into the person's)

```json
{
  "layout:Down-the-Stack": {
    "ctrl-shift-g": "layout.toggle:stage",
    "ctrl-shift-j": "layout.toggle:hud",
    "ctrl-shift-i": "mapledr.inventory"
  }
}
```

- Section `layout:<name>` applies while `layouts/<name>.json` shows. The Keys overlay prints the
  section name next to each key, and the action as words (`mapledr.sheet` → "mapledr sheet"). It maps to the GPUI context
  `layout == <name>` set on the window root (`keys.rs:119-130`, `window.rs:5675`).
  Precedence: `terminal` > `layout:` > `global` (AGENTS.md:548-550). A key also in `terminal`
  (`ctrl-shift-c/v/f`, `ctrl-v`, ...) loses while a terminal has focus. `mod:mapledr` applies where a
  mapledr copy has focus (`window.rs:4761`).
- An action is `"<command>[:<first arg>]"`, `{"command","args"}`, `send:<text>`, `terminal`, or
  `"<mod>.<command>"`. The last goes to that mod's `nextCommand()` and reaches **shown copies only**.
  `mapledr.*` is skipped silently while `mods/mapledr` doesn't exist (`gone_mod`, `keys.rs:153-157`).
- **One bad entry rejects the whole keys.json**: `parse` returns `Err` if any problem
  (`keys.rs:245`). The app keeps the last good bindings and writes `keys.error`. Unknown sections
  are errors (`keys.rs:128`). `ctrl-alt-shift-escape` is reserved.
- The shipped keys leave `ctrl-shift-g/j/i` unbound on Linux and Windows, and the macOS defaults use
  no ctrl-shift letters (`defaults/keys.json`, `keys.macos.json`). Binding them takes the key away
  from terminal programs while mapledr shows (usually read as ctrl-g/j/i; Kitty-protocol programs can
  tell them apart). Avoid `ctrl-shift-u` (GTK/IBus Unicode entry on Linux; general knowledge, not
  from this source).
- On upgrade Herdr refreshes only a byte-for-byte untouched shipped keys.json (`keys.rs:174-189`),
  so after a merge new default shortcuts stop arriving. That is how Herdr treats any edited
  keys.json (AGENTS.md:535-537).

---

## 4. Packaging for herdr.dev/layouts (summary of AGENTS.md:478-531)

- **Folder** (in a public GitHub repo, one folder per item), laid out like the app home:
  ```
  mapledr/
    RECIPE.md
    preview.png                  screenshot (herdr-app shot)
    layouts/Down-the-Stack.json
    mods/mapledr/                mod.json {"place":"none", ...}, main.js, roles, art/, fonts/?, preview.svg
    keys.json                    optional: {"layout:Down-the-Stack": {...}} (AGENTS.md names keys.json for mods; a layout folder "laid out like this home" can carry one too)
  ```
- **Repo topic:** `herdr-layout` (`herdr-mod` for a mod). It shows up at herdr.dev/layouts within the
  hour (CONTRIBUTING.md:13 links github.com/topics/herdr-layout).
- **How an agent installs it:** read RECIPE.md and every file first; disclose network use, `exec`,
  `hc` and file reads outside the mod folder; copy the layout file to `layouts/` and the mod folders
  to `mods/`, leaving out RECIPE.md and preview.png; never overwrite: on a name clash, rename the file
  or folder, the `mod` names in the layout, and the mod's own `mods/<name>/` paths; merge keys.json
  sections and ask before replacing a key the person already uses; run `herdr-app check` on each mod,
  then `layout.switch {name}`.
  Make renames easy. Spell asset paths as the literal `"mods/mapledr/..."` and overlay names as
  `mod: "mapledr"`; `mod.clone` rewrites exactly these patterns (`mods.rs:247-257`). Our
  `mapledr.<cmd>` actions and the layout's `preview` path also contain the mod name; the
  `layout:Down-the-Stack` keys section contains the layout name.
- **RECIPE.md order** (a brief another agent can rebuild from):
  1. `# Name`, one paragraph of what the person sees, `![Name](preview.png)`
  2. **What you see:** regions in order, with sizes, colors and type, and what each shows
  3. **How it behaves:** every agent status (working, blocked, done, idle) and its look; clicks, keys,
     hovers; what moves
  4. **Built from:** the node tree and blocks, each mod and its `props` roles, the shipped mods it
     uses, the `herdr` functions and commands it calls, programs it runs, its art
  5. **Watch out:** pitfalls, limits, controls that do nothing yet, assumptions about the setup
  6. **Done when:** checks that prove a build works
  
  Person first; code only in Built from and Watch out; exact values (`#e3b04b`, 210px,
  `agent.focus`).
- A layout with a missing mod is **not offered** in `ctrl-shift-l` cycling or the settings picker
  (`layout_names` filters by `missing_mods`, `window.rs:187-197`). `layout.switch {name}` still
  reaches it, and its blocks then show "did not load".

---

## 5. What makes a layout fail or misbehave, and how it's reported

| cause | effect | reported |
|---|---|---|
| invalid JSON / wrong types / missing `type`, `content`, `children`, float `id` or `content`, header `content` | file not applied. First load shows the shipped stand-in (`main` for unknown names). A live edit keeps the last good tree. Herdr never writes to the file or its clicks until it's fixed (`window.rs:1031-1053`, `1158-1162`). | `layout.error`: `layouts/<name>.json was not applied: <serde msg>` (`window.rs:1076-1080`), `tracing::warn`, `herdr-app status` (`window.rs:4229-4236`) |
| untagged mismatch in `content`/`size`/`background`/`padding` | same as above | message: `data did not match any variant of untagged enum ...` |
| unknown `theme`, non-hex `colors` value, `font_size` ∉ 6..72, weights ∉ 100..900, `minimum_contrast` | layout **applied**; theme → graphite | `layout.error`, with the same "was not applied" wording (`window.rs:958-962`, `settings.rs:653-680`) |
| unknown color *name* in a node (`"background":"parchment"` without defining it) | painted magenta | nothing |
| `content.mod` folder missing | block shows `<mod> did not load: no mod folder ...`; layout hidden from cycling and settings | `herdr-app status` lists `mod <name>: ...` |
| mod JS fails to load or throws | block shows `<mod> did not load: <error>`; retried on save. Floats show a smaller version (`floats.rs:140-148`). | `herdr-app status`; `herdr-app check <folder>` beforehand |
| two nodes with the **same id** | **not validated.** `find()` returns the first, clicks and commands hit the first, and mod copies are keyed by node id (`window.rs:1287`, `1359`), so both blocks share one slot. What happens when one copy is drawn twice is UNCONFIRMED. | nothing: keep ids unique (the draft's are, checked) |
| node without `id` | auto `node-N`, and the file is rewritten (formatting and unknown keys lost) | nothing |
| layout id equal to a pane id (`n<32 hex>`), a float slot (`float:<id>`) or `<id>#frame`/`#header` | slot clash (UNCONFIRMED) | avoid those shapes |
| renamed or removed `sidebar`, `panel`, `panel-body`, `files`, `changes` | shipped mods' rail, fold and panel buttons stop working; `ctrl-shift-b` → `no node "sidebar"` | command error toast (`window.rs:3648`, `3076-3078`) |
| layout name not `[A-Za-z0-9_-]+` | `layout.switch {name}` refused (`window.rs:1086`, `mods.rs:219-221`) | warn log |
| `mod.json` without `"place":"none"` | the first time the folder is seen, a copy is docked into the shown personal layout and the file is rewritten; the root may be wrapped (see 1.9) | nothing |
| keys.json with one bad entry | the whole file is not applied; the last good keys stay | `keys.error` |
| emergency | `ctrl-alt-shift-escape` puts the shown layout and keys.json aside (`*.reset-<time>`) and goes back to `main` | |
