# gpui-kit / gpui-base element API reference for herdr mods (source-derived)

Written from source only (herdr-app master, gpui-shell vendored at `vendor/gpui-kit`, GPUI at
`vendor/gpui-pre` = crate `gpui-pre 0.3.8`, patched in `Cargo.toml:80`). Nothing was built or run.
Machine-readable companion: `api-allowlist.json` (same folder).

Path abbreviations used in citations (all relative to `<herdr-app source>/`):

| abbrev | path |
|---|---|
| `SH/` | `vendor/gpui-kit/crates/shell/src/` |
| `Q` | `vendor/gpui-kit/crates/shell/src/engine/quickjs/mod.rs` (holds the JS **PRELUDE**, lines 5794-7456) |
| `MAT` | `vendor/gpui-kit/crates/shell/src/materialize.rs` |
| `TY` | `vendor/gpui-kit/crates/shell/src/typings.rs` (the `.d.ts` generator; most of the d.ts is literal text in it) |
| `BASE/` | `vendor/gpui-kit/crates/base/src/` |
| `GP/` | `vendor/gpui-pre/src/` |
| `MAC/` | crates.io `gpui-pre-macros-0.3.8/src/` — downloaded as source only, sha256 `d2ad26ca…a9f4` matches `Cargo.lock:3242-3245`. It holds the macro that generates GPUI's style ramps and the reflection pass. |
| `AG` | `defaults/AGENTS.md` (the herdr mod guide) |

Legend: **CONFIRMED** = read in code. **UNCONFIRMED** = inferred or not traced to the end.

---

## 0. The ten things most likely to bite a game mod

1. **The kit has no `z_index`** (GPUI `Style` has none; grep finds none in `GP/style.rs`, `GP/styled.rs`, `MAT`). Paint order is tree order: a **later sibling paints on top**. Absolute children follow the same rule. Only `Popover`, `HoverCard`, `Popup`, tooltips and dialogs paint in a higher deferred layer.
2. **Overlapping elements all get hover and click.** GPUI hit-tests every hitbox under the pointer, and only an `occlude`/`BlockMouseExceptScroll` hitbox stops it (`GP/window.rs:1120-1132`). The shell does not expose `occlude`. Use `cx.stop_propagation()` in the inner handler (`TY:995-1007`).
3. **The `.bg()` argument must be a color string**: `#rgb`, `#rrggbb` or `#rrggbbaa` (`SH/value.rs:89-104,113-131`). Theme token names like `"surface"` throw. A `Background` object passed to `.bg()` also throws, because bridging accepts only null, boolean, number, string or function (`Q:10250-10265`).
   - **Gradients exist only as a path fill**: `window.paint_path(rect, Background.linear_gradient(angle, from, to))`. See §2.9.
4. **Elements cannot be flipped, mirrored, scaled or rotated.** The only transform is `spin(ms)` on `svg()` (`MAT:1474-1499`; the single `with_transformation(Transformation::rotate(..))` in the shell is at `MAT:1495`). GPUI's `img` has `object_fit`/`grayscale` but the shell exposes neither, and neither flips (`GP/elements/img.rs:132-161`). CONFIRMED (critic). Ship separate left-facing and right-facing images. For SVG art, a build script can emit the mirror as `<g transform="translate(W 0) scale(-1 1)">…</g>`.
5. **A transition snaps the first time an element appears.** It animates only *later* changes of the target (`BASE/motion.rs:262-263,293-299`). Its state is keyed by `.id()`, or else by the element's creation index in that render (`MAT:2566-2571,2579-2654`). **Give every animated element a stable, unique `.id(string)`.**
6. **`loop` runs on one global clock** (`MAT:2895-2898`), so an element does not start at `from` when it appears. Two loops with the same `period` move in step. Vary `period` per entity to de-sync them.
7. **The nullary ramps are rem-based, and herdr's rem is not 16 px.** `p_4` is 1rem, and herdr sets rem = `ui_font_size × zoom`, where `ui_font_size` defaults to 13 (`src/window.rs:5625`, `src/settings.rs:563,835-836`). So `p_4` is about 13 px.
   - Use the numeric forms (`.p(16)`, `.w(48)`) for exact sizes.
   - Numbers passed to methods are px multiplied by the app zoom (`SH/value.rs:12-27`).
   - `border_1` and friends are raw `px(1.)` and are **not** zoom-scaled (`MAC/styles.rs:623-663` + border suffixes).
8. **Some child values throw or render oddly.**
   - `.child(false)` renders the text "false". `true` and numbers become text too (`Q:5874-5891`).
   - `.child(null)` or `.child(undefined)` throws a TypeError.
   - Guard conditional children with `.when(cond, el => el.child(x))`.
9. **Render has a 50 ms budget.** An event or task has 500 ms. Top-level module evaluation has the 5 s `detached` budget only outside any scope (`SH/engine/quickjs/sandbox.rs:436-443`, installed at `Q:1853`); herdr loads mods inside a Task scope (`SH/plugin.rs:1235-1250`), so in practice module evaluation also has 500 ms (`sandbox.rs:513-517`). `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` and `require` exist but throw a hint (`sandbox.rs:228-241`).
10. **Unknown methods throw**, and so does a bad unit or type in a style argument. The check runs eagerly at the call site (`Q:8250-8254`). The render then fails, and the view shows an error banner while the previous build stays alive (`AG` "A broken save keeps the old version running").

---

## 1. Module exports

The import specifiers that resolve are `"gpui-kit"`, `"gpui"` (an alias of gpui-kit), `"gpui-base"`, `"gpui-shell"`, `"gpui-fps"` and `"gpui-component"` (`Q:1300-1306`, `TY:622-629`). The standard modules are `"buffer"`, `"path"`, `"url"`, `"crypto"`, `"zlib"`, `"console"`, `"process"`, `"os"`, `"fs/promises"` and so on (`TY:3914-4053`). Herdr adds `"herdr"`.

### 1.1 `"gpui-kit"` — `exports::GPUI` (`Q:1119-1132`), values at `Q:7144-7192`

| export | signature | notes |
|---|---|---|
| `View` | `abstract class View { init?(props, cx); update?(props); close?(cx); render(cx) }` | §7 |
| `div()` | `() => NativeElement` | GPUI default style: `display: block`, `position: relative`, `flex_shrink: 1` (`GP/style.rs:774-802`). **It is not flex until you call `.flex()`.** |
| `svg(path)` | `(path: string) => NativeElement` | A monochrome mask tinted with `text_color`. See §3. |
| `image(path)` | `(path: string) => NativeElement` | Full color: PNG, JPEG, GIF, WebP, SVG and more. See §3. |
| `list(id, item_count, get_key, render)` | `render(index, cx) => Element` | Lazy list. It needs a definite height (`TY:2140-2195`). |
| `uniform_list(id, item_count, get_key, render)` | `render(range, cx) => Element[]` | `TY:2197-2215` |
| `PathBuilder` | `.fill()` or `.stroke(width)` → `move_to`, `line_to`, `curve_to`, `cubic_bezier_to`, `arc_to`, `add_polygon(points, closed=true)`, `close`, `dash_array` (stroke only), `build()` | Coordinates are a number (px, zoom-scaled) or `"N%"` of the painted bounds (`SH/path.rs:13-38`, `Q:6320-6368`). |
| `Background` | `solid(color)`, `stop(color, fraction)`, `linear_gradient(angle, from, to)`, `pattern_slash(color, width, interval)`, `checkerboard(color, size)`; instance methods `.opacity(f)` and `.color_space("srgb"\|"oklab")` | Usable **only** with `window.paint_path` (`Q:6300-6318,7165-7192`). |

The kit has **no** `img`, `text`, `span`, `canvas`, `deferred` or `anchored` export. Text is `.child("string")`. The `text(row.name)` in one d.ts example comment (`TY:3059`) is stale.

### 1.2 `"gpui-base"` — `exports::GPUI_BASE` (`Q:1135-1211`), values at `Q:7202-7452`

- **Layout:** `h_flex()` is `div().flex().flex_row().items_center()`. `v_flex()` is `div().flex().flex_col()`, with no cross-axis alignment, so children stretch (`BASE/styled.rs:105-115`).
- **Controls, all unstyled**, built as `X.new(id)`: `Button`, `Link` (`.href(url)`), `Checkbox`, `Switch`, `Tabs`, `Tab`, `Radio`, `Toggle`, `RadioGroup`, `ToggleGroup`, `Progress`.
- **Parts**, built as `X.new()`: `ProgressTrack`, `ProgressIndicator`, `Avatar`, `AvatarImage.new(path)`, `AvatarFallback`, `Collapsible`, `AccordionItem`, `AccordionPanel`. Also `Accordion.new(id)`, `AccordionHeader.new(trigger)` and `AccordionTrigger.new(id)`.
- **Pagination:** `Pagination`, and `pagination_items(cur, total, visible=7)`.
- **Tables:** `Table`, `TableHeader`, `TableBody`, `TableCaption` (built with `id`); `TableRow.new(id, row)`, `TableHead.new(id, col)` and `TableCell.new(id, col)`, where `row` and `col` are 1-based integers.
- **Resizable:** `h_resizable(id)`, `v_resizable(id)`, `resizable_panel()`. The panel has its own `.size(px)` and `.visible(bool)`, which shadow the shared methods (`Q:6281-6295`).
- **Anchored surfaces:**
  - `Popover.new(id)`: has `trigger`/`content` slots, `open`, `default_open`, `on_open_change`, `anchor`, `mouse_button` and `overlay_closable`.
  - `HoverCard.new(id)`: has `trigger`/`content` slots, `open_delay` (default 600 ms), `close_delay` (default 300 ms) and `anchor` (default `top_center`).
  - `Popup.new(id, trigger)`.
  - `Select.new(id)`, `Combobox.new(id)` and `DatePicker.new(id, focusHandle)`.
- **Scrolling:** `Scrollbar.new(id)`, `.horizontal(id)` and `.vertical(id)`; `v_virtual_list(id, count, sizes, get_key, render)`, `h_virtual_list(…)`; `ScrollHandle.new()` and `VirtualListScrollHandle.new()`.
- **Text input:** `InputState.new({placeholder, value})`, `Input.new(state)`, `NumberInput.new(state)`, `TextareaState.new({…, rows})`, `Textarea.new(state)`, `EditorState.new(opts)`, `Editor.new(state)`.
- **Rich text:** `TextView.html(id, html)` and `TextView.markdown(id, md)`, with `selectable`, `scrollable`, `raw_html`, `on_link_click`, `on_selection_change` and `highlight_range`.
- **State-backed controls:**
  - `SliderState.new({min, max, step, scale, value})`, with `Slider`, `SliderTrack`, `SliderIndicator` and `SliderThumb` built as `.new(state)`.
  - `OtpState.new(len, {value, masked})` and `OtpInput.new(state)`.
  - `CalendarState.new()`.
- **Docking:** `DockArea.new(id, {version})` and `DockArea.register_panel(name, Class)`; `dock_area(area)` and `dock_content()`.
- **Theme:** `set_theme({appearance, tokens})`, legal only from an event or a task.

### 1.3 `"gpui-shell"` — **no runtime values** (`exports::GPUI_SHELL = []`, `Q:1224`)

It provides TypeScript types only (`TY:2037-2115`):

- `LengthString` = `` `${n}px` | `${n}rem` | `${n}%` ``.
- `ScopePhase` = `"render" | "event" | "task" | "layout" | "none"`.
- `PathCoordinate`, `Props` (`Record<string, any>`), `ElementBounds {x, y, width, height}`.
- `DialogOptions {escape_dismissable?, backdrop_dismissable?}`.
- `ToastOptions {title, description?, level?: "info"|"success"|"warning"|"error", timeout?, id?}`.
- `TaskOptions {owner?: View|null}`.
- `MotionProperty` = `"opacity"|"width"|"height"|"left"|"top"`.
- `MotionEasing` = `"linear"|"ease-in"|"ease-out"|"ease-in-out"`.
- `TransitionPolicy {duration, delay?, easing?}`, `LoopPolicy {from, to, period?, easing?}`, `SpringPolicy {response?, damping?, epsilon?}`.

### 1.4 `"gpui-fps"`: `fps_monitor()`, `show_fps_monitor(opts)`, `hide_fps_monitor()`, `fps_monitor_visible()` (`Q:1215-1220`)

### 1.5 `"gpui-component"`: empty in herdr

Herdr registers no components: `FrozenComponentRegistry::default()` (`src/main.rs:118`, `src/mods.rs:84`). The `SH/component_registry.rs` file is the adapter seam for future host components, and mods have no use for it.

### 1.6 Globals

- `window`: the `Window` object (`Q:6942-7008`; types at `TY:2290-2438`):
  - Overlays: `open_dialog(() => Element, opts)`, `close_dialog`, `open_sheet`, `open_sheet_at`, `push_toast`.
  - Storage: `localStorage` and `sessionStorage`.
  - Painting: `paint_path`.
  - Measurement, legal in render: `rem_size()`, `line_height()`, `viewport_size()`, `bounds()`, `mouse_position()`, `appearance()`.
  - Actions, illegal in render: `dispatch_action`, `set_rem_size`, `refresh`, `focus_next`, `focus_prev`.
- `localStorage` and `sessionStorage` (bare), and `console`.

---

## 2. Element methods

**All elements share one prototype.** Every method below exists on `div`, `svg`, `image`, `Button` and the rest. A method that does not apply to an element is usually inert, or logs a warning (`TY:66-69`; prelude `Q:5796-5862`). A missing method is a `TypeError`. The render is then re-run once against a Proxy prototype, which produces `unknown style method \`x\` (did you mean: y?)` (`Q:5806-5820`, `SH/style.rs:500-524`).

Sources of names, enumerated in `api-allowlist.json` (3318 names in total):

- **59 parametric styles**: `SH/style.rs:79-212` (`PARAM_STYLES`), applied by `apply_param` at `SH/style.rs:405-497`.
- **3130 reflected no-argument GPUI `Styled` methods**: `gpui::styled_reflection::methods` (`SH/style.rs:240-247`).
  - The reflection macro keeps every trait method with the shape `fn name(self) -> Self` and exactly one parameter, after expanding the nine known style macros (`MAC/derive_inspector_reflection.rs:14-37,55-85,195-277`).
  - The names were regenerated from `GP/styled.rs` and `MAC/styles.rs` by a one-off script (not in this repository) that applies the same macro expansion.
  - `debug` and `debug_below` exist only in debug builds (`GP/styled.rs:892-903`).
- **7 reflected gpui-base `StyledExt` methods**: `h_flex`, `v_flex`, `debug_red`, `debug_blue`, `debug_yellow`, `debug_green`, `debug_pink`. The `debug_*` ones are no-ops in release (`BASE/styled.rs:78-171`).
  - **`.h_flex()` and `.v_flex()` are also chainable methods on any element.**
- **9 hand-bound font weights**: `font_thin` (100) through `font_black` (900) (`SH/style.rs:221-231`). The reflection pass does not see the `macro_rules!` that generates them.
- **67 generic behaviors**: the `__behaviorNames` list (`Q:7485-7553`), dispatched through `__apply`.
- **46 prelude-defined methods**: `methods.X = …` in the prelude, such as `child`, `hover`, `transition` and `loop`.

### 2.1 Argument grammar for parametric styles (`SH/style.rs:405-497`, `575-670`)

| type | accepts | rejects |
|---|---|---|
| **Length** | number = px × zoom; `"12px"` (× zoom); `"1.5rem"`; `"50%"` (fraction of the parent); `"auto"` | other strings, null |
| **DefiniteLength** | as Length | `"auto"` throws |
| **AbsoluteLength** | number, `"Npx"`, `"Nrem"` | `"%"` and `"auto"` throw |
| **Color** | `"#rgb"`, `"#rrggbb"`, `"#rrggbbaa"` | token names, `rgb()`, numbers |
| number | finite JS number | strings |

Notes on the grammar:

- `NaN` is a number and is **not** rejected (`as_f32` makes no finiteness check, `SH/value.rs:47-55`), so `.w(NaN)` slips through. Guard your arithmetic.
- `cx.theme().colors.*` serialize as `#rrggbb` (`SH/engine/quickjs/theme_api.rs:375-379`). Append two hex digits for alpha, for example `t.primary + "80"`.

| method(s) | type |
|---|---|
| `w h size min_w min_h min_size max_w max_h max_size` | Length |
| `m mx my mt mb ml mr` | Length. Negative values are OK. |
| `inset top bottom left right` | Length. Used as the offsets of a relative or absolute element. |
| `p px py pt pb pl pr` | DefiniteLength. **`.px(n)` is padding-x, not "pixels".** |
| `gap gap_x gap_y` | DefiniteLength |
| `flex_grow(n) flex_shrink(n)` | number |
| `flex_basis` | Length |
| `bg text_color text_bg border_color` | Color. `text_color` is inherited by children and svgs. |
| `text_size` | AbsoluteLength (px or rem) |
| `font_family(name)` | string: the font family name, not a file name |
| `font_weight(n)` | number 100..900; out-of-range throws (`SH/style.rs:638-646`) |
| `line_height(x)` | A bare **number is a multiplier** of the font size (`1.2`). A string is a length: `"18px"`, `"120%"` (`SH/style.rs:470-475,631-636`). |
| `opacity(x)` | number, 0..1. Applies to the element **and its descendants**, multiplicatively (`GP/window.rs:4176-4192`). It does not clamp at bind time. |
| `border border_t border_b border_l border_r border_x border_y` | AbsoluteLength. It draws nothing without `border_color`. |
| `rounded rounded_t rounded_b rounded_l rounded_r rounded_tl rounded_tr rounded_bl rounded_br` | AbsoluteLength. Percentages throw, so a circle is `rounded_full` or `rounded(size/2)`. |

**Not bound**, so calling them is an unknown-method TypeError, although GPUI has them (`SH/style.rs:61-75`; `GP/styled.rs` parametric list):

- Text: `aspect_ratio(n)` (only `aspect_square` exists), `line_clamp(n)`, `text_align(e)` (use `text_left`, `text_center`, `text_right`), `text_overflow(e)`, `font(..)`, `font_features`, `text_decoration_color`.
- Pointer and decoration: `cursor(e)` (use the `cursor_*` methods), `shadow(vec)` (use the `shadow_*` presets), `scrollbar_width`.
- Grid: `grid_cols(n)`, `grid_rows`, `col_start`, `col_end`, `col_span`, `row_start`, `row_end`, `row_span`.
- gpui-base helpers: `paddings`, `margins`, `refine_style`, `corner_radii`, `debug_focused`.

### 2.2 No-argument ramps generated by GPUI macros (`MAC/styles.rs:531-587,589-621,699-1160`)

There are 2811 box ramps, built from the prefixes and suffixes below:

- **Prefixes that allow `auto`**:
  - `w`, `h`, `size`, `min_size`, `min_w`, `min_h`, `max_size`, `max_w`, `max_h`
  - `m`, `mt`, `mb`, `my`, `mx`, `ml`, `mr`
  - `inset`, `top`, `bottom`, `left`, `right`
- **Prefixes without `auto`**: `p`, `pt`, `pb`, `px`, `py`, `pl`, `pr`, `gap`, `gap_x`, `gap_y`.
- **Suffixes:**
  - Rem steps (n/4 rem): `0` (0 px), `0p5`, `1`, `1p5`, `2`, `2p5`, `3`, `3p5`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `16`, `20`, `24`, `32`, `40`, `48`, `56`, `64`, `72`, `80`, `96`, `112`, `128`.
  - `px` (1 px) and `full` (100%).
  - Fractions: `1_2`, `1_3`, `2_3`, `1_4`, `2_4`, `3_4`, `1_5`, `2_5`, `3_5`, `4_5`, `1_6`, `5_6`, `1_12`.
  - `auto`, on the auto prefixes only.
- **Negatives:** every non-auto suffix also exists as `{prefix}_neg_{suffix}`, for example `top_neg_2`, `left_neg_full` or `mt_neg_px`.
- **Examples:** `size_full`, `w_full`, `h_full`, `inset_0`, `left_1_2`, `w_auto`, `gap_2`, `p_neg_1`.

Two more families:

- **Corners** (81): `rounded`, `rounded_t`, `rounded_b`, `rounded_r`, `rounded_l`, `rounded_tl`, `rounded_tr`, `rounded_bl`, `rounded_br`, each followed by `_none`, `_xs`, `_sm`, `_md`, `_lg`, `_xl`, `_2xl`, `_3xl` or `_full` (`rounded_full` is 9999 px) (`MAC/styles.rs:1161-1277`).
- **Borders** (119): `border`, `border_t`, `border_b`, `border_r`, `border_l`, `border_x`, `border_y`, each followed by a width of 0-12, 16, 20, 24 or 32 (raw px), plus `border_dashed`.

### 2.3 The other 119 no-argument `Styled` methods, by group

- **Display:** `block`, `flex`, `grid`, `hidden` (display:none, removed from layout), `visible`, `invisible` (visibility:hidden; keeps its layout and does not paint, `GP/elements/div.rs:2549-2551`).
- **Position:** `relative`, `absolute`.
  - `absolute` with `left` and `top` is relative to the **direct parent** box. CONFIRMED (critic) in the vendored taffy 0.13.0 that herdr patches in (`Cargo.toml:94` `taffy = { path = "vendor/taffy" }`): each container lays out its own absolute children in `perform_absolute_layout_on_absolute_children` (`vendor/taffy/src/compute/flexbox.rs:2234-2400`, `block.rs:689-693,1462-1500`). The offset is `left + parent.border_left` (padding does **not** shift it; insets and `%` resolve against the parent size minus border). There is no "nearest positioned ancestor" concept, so the parent's own `relative`/`absolute` doesn't matter (div defaults to `relative` anyway, `GP/style.rs:774-802`). Absolute children don't size the parent: give the stage container an explicit `w`/`h` or `size_full()`. The shipped mods use this pattern, for example the win98 `gradient()` layer, `image().absolute().top(0).left(0)` at `defaults/mods/win98/dialog.js:136`, and Solitaire cards (`win98/sol.js:200-224`).
  - The default position is relative, so `.left(n)` and `.top(n)` on a normal element offset it visually. The win98 Clippy mod bobs with `relative()` plus `loop("top")` (`defaults/mods/win98/clippy.js:70-75`).
- **Flex:**
  - Direction: `flex_row`, `flex_row_reverse`, `flex_col`, `flex_col_reverse`.
  - Wrap: `flex_wrap`, `flex_wrap_reverse`, `flex_nowrap`.
  - Sizing: `flex_1` (grow 1, shrink 1, basis 0), `flex_auto`, `flex_initial`, `flex_none`, `flex_grow_0`, `flex_grow_1`, `flex_shrink_0`, `flex_shrink_1`.
  - Alignment: `items_start`, `items_end`, `items_center`, `items_baseline`, `items_stretch`; `justify_start`, `justify_end`, `justify_center`, `justify_between`, `justify_around`, `justify_evenly`; `content_normal`, `content_center`, `content_start`, `content_end`, `content_between`, `content_around`, `content_evenly`, `content_stretch`; `self_start`, `self_end`, `self_flex_start`, `self_flex_end`, `self_center`, `self_baseline`, `self_stretch`.
- **Grid** (no column-count setter exists, so grid is of little use): `col_start_auto`, `col_end_auto`, `col_span_full`, `row_start_auto`, `row_end_auto`, `row_span_full`.
- **Sizing:** `aspect_square`.
- **Overflow:** `overflow_hidden`, `overflow_x_hidden`, `overflow_y_hidden` (each clips its children). The scroll variants are behaviors; see §2.6.
- **Cursor:** `cursor_default`, `cursor_pointer`, `cursor_text`, `cursor_move`, `cursor_not_allowed`, `cursor_context_menu`, `cursor_crosshair`, `cursor_vertical_text`, `cursor_alias`, `cursor_copy`, `cursor_no_drop`, `cursor_grab`, `cursor_grabbing`, `cursor_ew_resize`, `cursor_ns_resize`, `cursor_nesw_resize`, `cursor_nwse_resize`, `cursor_col_resize`, `cursor_row_resize`, `cursor_n_resize`, `cursor_e_resize`, `cursor_s_resize`, `cursor_w_resize`.
- **Shadow presets:** `shadow_none`, `shadow_2xs`, `shadow_xs`, `shadow_sm`, `shadow_md`, `shadow_lg`, `shadow_xl`, `shadow_2xl`. They use black at alpha 0.05–0.25 (`MAC/styles.rs:384-490`). You cannot set a color or a custom shadow.
- **Text:**
  - Sizes, in rem: `text_xs` (0.75), `text_sm`, `text_base` (1.0), `text_lg`, `text_xl`, `text_2xl`, `text_3xl`.
  - Alignment: `text_left`, `text_center`, `text_right`.
  - Style: `italic`, `not_italic`, `underline`, `line_through`.
  - Decoration: `text_decoration_none`, `text_decoration_solid`, `text_decoration_wavy`, `text_decoration_0`, `text_decoration_1`, `text_decoration_2`, `text_decoration_4`, `text_decoration_8`.
  - White space: `whitespace_normal`, `whitespace_nowrap`.
  - Overflow: `text_ellipsis`, `text_ellipsis_start`, `text_ellipsis_middle`; `truncate` is overflow hidden + nowrap + ellipsis (`GP/styled.rs:139-141`).
  - Weights: `font_thin` … `font_black`.

### 2.4 Children and composition (prelude `Q:5862-5935`, `6388-6399`)

- `child(x)` takes an `Element`, an `Entity` (from `cx.new`) or a `string | number | boolean`; the last three are converted to text with `String(x)`. Anything else throws.
- `children(iterable)` applies the same rule to each item.
- `map(f)` returns whatever `f(el)` returns.
- `when(cond, el => el…)` applies the branch only when `cond` is truthy. **The branch must return the element**; otherwise it throws (`Q:6392-6399`).
- An element is consumed when used. Reusing a stored element throws (`TY:63-65`).
- Slots, which take an element and render it elsewhere: `content`, `trigger`, `input`, `decrement_button`, `increment_button`, `image` (Avatar's slot, not the image constructor), `fallback`, `header`, `footer`, `panel`.

### 2.5 State styles: `hover(fn)`, `active(fn)`, `focus(fn)` (`Q:5969-5987`, `MAT:1694-1720`, `2224-2237`)

- `fn(el)` receives a *detached* element that collects **style methods only**. Its return value is ignored, so `.hover(s => s.bg("#335"))` works.
- `hover` needs no id. `active` and `focus` force an identity.
- State styles are **honored on `div`, `h_flex`, `v_flex`** and on the components that apply them. They are **not** honored on `image()`, `svg()` or text: wrap those in a div.
- The `range_style`, `cell_style`, `cell_active_style` and `caret_style` slots work the same way, for the slider and OTP components.

### 2.6 Behaviors (generic list at `Q:7485-7553`; Rust side `MAT:3504-3753`)

- **Identity:**
  - `id(name: string)`. A non-string **throws** "id(name) expects a string" (`Q:8678-8689`).
  - Components built with `X.new(id)` use that id instead.
- **Pointer:**
  - `on_click((event: {click_count, modifiers}, cx) => void)` (`Q:3951-4005`). `disabled(true)` blocks it.
  - `on_mouse_down(button, (e, cx) => …)` and `on_mouse_up(button, …)`, where button is `"left"|"right"|"middle"|"back"|"forward"` (`Q:8428-8470`).
  - `on_mouse_down_out(fn)`, `on_window_mouse_up(button, fn)`.
  - `on_mouse_move((e: {position, local_position, bounds, modifiers, pressed_button?}, cx))`, `on_window_mouse_move(fn)`.
  - `on_hover((hovered: boolean, cx) => …)`. A stale exit is suppressed while the pointer stays inside the box (`MAT:2432-2438`).
  - `on_scroll_wheel((e: {delta, delta_lines?, touch_phase, …}, cx))`, `on_pinch(fn)`.
  - `on_drop(({paths}, cx))`, `drag_paths(paths, {on?})`.
  - Event payload types are at `TY:1100-1218`.
- **Layout:** `on_size_change(({width, height}, cx) => …)` gives logical window px, so divide by `settings().zoom` before reusing them as lengths (`AG` §UI). Use it on div, h_flex or v_flex with a stable id.
  - It fires only **after a layout** (round 4b): gpui-shell wraps the element in a `SizeObserver` whose prepaint compares (application generation, size) with the last one it saw and, when they differ, defers the callback with `window.defer` (`SH/materialize.rs:2358-2420`, `SH/engine/quickjs/mod.rs:4247`). So a copy's first frame always renders without a size, a hot reload (a new application generation) is measured again, and nothing fires while `checking()` (`SH/materialize.rs:2362`). Plan the first frame for an unknown width.
- **Keyboard:**
  - `on_key_down((e: {key, keystroke, key_char?, modifiers, is_held?}, cx))` and `on_key_up`. They fire only on the focus path, so pair them with `track_focus(handle)`.
  - Also `on_modifiers_changed`, `key_context(str)`, `on_action(name, (e, cx))`, `tab_index(n)`, `tab_stop(bool)`, `track_focus(FocusHandle)`.
- **Tooltip:** `tooltip(text: string)`. Only a string is accepted; an element throws (`Q:8693-8704`).
  - It shows after about 0.5 s and uses the theme's surface, border, radius and spacing (`SH/materialize/components/tooltip.rs:60-80`).
  - It is wired on `div`, `h_flex`, `v_flex` and `Button` only.
  - For a rich tooltip, use `HoverCard.new(id).trigger(el).content(el).open_delay(ms)`.
- **Scrolling:**
  - `overflow_scroll`, `overflow_x_scroll`, `overflow_y_scroll`: native scroll.
  - `overflow_scrollbar`, `overflow_x_scrollbar`, `overflow_y_scrollbar`: also paint a base scrollbar.
  - `track_scroll(handle)` drives the position from a handle.
- **Accessibility:** `accessibility_label`, `role`, `aria_selected`, `aria_active_descendant`, `aria_level`, `set_position(pos, size)`.
- **Component state:** `disabled`, `selected`, `checked`, `pressed`, `value(percent)` (a non-number throws), `indeterminate`, `open`, `default_open`, `overlay_closable`, `anchor(name)` (one of `top_left`, `top_right`, `bottom_left`, `bottom_right`, `top_center`, `bottom_center`, `left_center`, `right_center`; `MAT:3339-3348`), `mouse_button`, `open_delay(ms)`, `close_delay(ms)`, `axis`, `mode`, `scroll_size`, `viewport_from_layout`, `size_range`, `on_resize`, `row_count`, `column_count`, `with_item_to_measure_index`, `controls_right`, `keep_mounted`, `start`, `content_focus_handle`, `frame_budget`.
- **Text, input and dock:**
  - TextView: `selectable`, `scrollable`, `raw_html`, `highlight_range`, `on_link_click`, `on_selection_change`.
  - Inline tokens: `token`, `on_token_click`, `on_token_hover`.
  - Change and lifecycle callbacks: `on_change`, `on_step`, `on_open_change`, `on_confirm`, `on_dismiss`, `on_item_click`, `on_item_secondary_click`.
  - Dock commands: `select_tab`, `close_panel`, `toggle_zoom`, `drag_tab`, `drop_tab`, `toggle_dock`, `resize_dock`.
- **Motion:** `transition`, `spring`, `loop`, `frames`, `spin`. See §4.

**Where input is wired** (`MAT:2153-2169`): `div`, `h_flex`, `v_flex`, `Button`, `Link`, `Checkbox`, `Switch`, `Radio`, `Toggle`, `Tabs`, `Tab`.

- On `image()`, `svg()`, a path or text, handlers are **dropped**, with a log warning (`MAT:2109-2151`). The Image arm builds a bare `gpui::img`, and the Svg arm a bare `gpui::svg` (`MAT:1474-1536`).
- **Wrap sprites in a `div` to make them clickable.**

### 2.7 Paint order, clipping and visibility

- **There is no z-index.** Children paint in order, and the last sibling ends up on top. A floating damage number therefore belongs *after* the mob in `children`.
- `overflow_hidden` clips descendants to the box. Without it, absolute children may draw outside their parent.
- To hide something: `hidden()` removes it from layout; `invisible()` keeps its space and paints nothing; `opacity(0)` keeps both and **still receives the pointer** (UNCONFIRMED for `invisible`).

### 2.8 Hover, cursor and stop_propagation

- Clicks bubble: an inner and an outer `on_click` both fire. Call `cx.stop_propagation()` in the inner one, and `cx.propagate()` undoes it (`TY:995-1007`).
- `cursor_*` styles work on any element with a hitbox. Adding a handler or a cursor style creates one (GPUI behavior; UNCONFIRMED in the shell).

### 2.9 Gradients, patterns and vector shapes

```js
import { PathBuilder, Background } from "gpui-kit";
const RECT = () => PathBuilder.fill().move_to("0%","0%").line_to("100%","0%").line_to("100%","100%").line_to("0%","100%").close().build();
// inside a .relative() parent, as the FIRST child so content paints over it:
window.paint_path(RECT(), Background.linear_gradient(180, "#2a6cbd", "#0b2a57")).absolute().top(0).left(0).size_full()
```

This pattern is the win98 `gradient()` helper (`defaults/mods/win98/kit.js:190-195`).

- **Angle** is in degrees: 0 points to the top, increasing clockwise (`GP/color.rs:858-864`). So 90 runs left→right and 180 runs top→bottom.
- **Stops:** `Background.stop(color, f)` takes `f` as a **fraction 0..1**, although the parameter is named "percentage" (`GP/color.rs:890-893`; the default stops are 0 and 1, `Q:7176-7180`).
- `.opacity(f)` and `.color_space("oklab")` are available on a Background.
- **Paths** can draw any polygon, curve or arc (`add_polygon`, `arc_to`). Strokes use `PathBuilder.stroke(width)`.
- Ancestor opacity applies to paths (`GP/window.rs:4741-4744`). A path's own `.opacity()` style is probably *not* applied, so use `Background.opacity` (UNCONFIRMED).
- Paths have no input handlers.

---

## 3. `image()` and `svg()`

### 3.1 Resolving the path

- Paths resolve against the **application root**, which in herdr is `~/.config/herdr-app` (or `$HERDR_APP_HOME`, `$XDG_CONFIG_HOME/herdr-app`) (`src/main.rs:186`, `src/mods.rs:62-65`).
- They do **not** resolve against the mod or the importing file (`SH/assets.rs:1-15`). Write `image("mods/<name>/sprites/hero.png")` (`AG:948-951`).
- `..` is refused (`SH/assets.rs:74-84`). With `following_links()`, a symlink that leads out of the directory is still served.
- Files over 16 MiB are refused (`SH/assets.rs:27`).
- A missing file draws nothing and logs one warning per path (`SH/assets.rs:211-217,277-286`).
- Saving an asset under `mods/` live-updates every mod showing it (`AG:950-951`).
- A string that parses as a URL (`https://…`) becomes a URI resource and is fetched over HTTP (`GP/elements/img.rs:54-82`). Prefer local files.

### 3.2 `image(path)`, a full-color raster (`MAT:1527-1536`, `GP/elements/img.rs`)

- **Formats:** avif, jpg/jpeg, png, gif, webp, tif, tga, dds, bmp, ico, hdr, exr, pnm, qoi, svg (`img.rs:213-218`).
- **Animated GIF and WebP** advance their frames natively. This needs an element id, which the shell always gives, an active window, and reduced motion off (`img.rs:384-390`, `MAT:1529-1534`).
  - Critic: `window.is_window_active()` gates the frame request, so a GIF walk cycle **freezes while the herdr window is not the focused OS window** (and with OS reduce-motion). `.loop` has no such gate (`MAT:3080-3110`). The per-frame advance is also gated on an active window (`img.rs:331`).
  - Frame state (`ImgState {frame_index, last_frame_time}`, `img.rs:254-354`) is keyed by the element id (`MAT:1534`, `element_id(id, key)`). Without `.id()` it is the creation index, so a conditional sibling earlier in the render restarts the GIF. Give sprite images a stable `.id()`. A newly seen image starts at frame 0.
  - **Sprite-sheet cropping works**: `div().w(32).h(32).overflow_hidden().child(image(sheet).absolute().left(-32*k).top(0).w(32*N).h(32))`. Stepping frames still needs a re-render, because `frames()` only swaps text.
- **Sizing:**
  - With neither `w` nor `h` set, the image takes its intrinsic size in raw image px, which is **not** zoom-scaled. For an SVG that is its `width`/`height` attributes (the 2× raster divided by its scale factor 2, `GP/assets.rs:168-172`, used at `img.rs:357`).
  - With one side set as an absolute length, the other follows the aspect ratio (`img.rs:358-382`).
  - **Always set `w` and `h`** (or `size`) in script px.
- **Object fit is always `Contain`** (`img.rs:141`). `object_fit` and `grayscale` are not exposed, so give the box the same aspect ratio as the image.
- **SVG through `image()`** is rasterized once, at 2× its intrinsic size: the loader calls `render_single_frame(&bytes, 1.0)` (`img.rs:773-775`; the TODO at `img.rs:654-655` shows the display scale factor is ignored), and `ScaleFactor(1)` becomes 1 × `SMOOTH_SVG_SCALE_FACTOR` (2) of the SVG's `width`/`height` (`GP/svg_renderer.rs:81,200-207,272-283`). Neither the drawn size, the display's DPR nor herdr's zoom changes that raster. Drawn larger than that, it blurs, so give sprite SVGs intrinsic `width`/`height` at least half their largest on-screen device size. On a 2× display at zoom 1 that means `width`/`height` ≥ the largest drawn size in script px. Down the Stack keeps the viewBox at the zoom-1 display size and writes `width`/`height` = k × viewBox for art drawn bigger (`tools/gen-art.mjs` `intrinsicScale`, ARCHITECTURE §8).
- **Sampling filter (confirmed):** the atlas sampler is linear for both magnification and minification (`gpui-pre-wgpu/src/wgpu_renderer.rs:1416-1420`; Metal `gpui-pre-apple/src/shaders.metal:716-717` for polychrome sprites). Atlas textures have a single mip level (`wgpu_atlas.rs:215` `mip_level_count: 1`; `metal_atlas.rs:143-160` sets none, so Metal's default of 1 applies). There is no nearest-neighbor option. So a raster drawn larger is smoothed, and a raster drawn much smaller is point-sampled and can alias. Integer ratios of axis-aligned pixel art stay exact. Don't make the intrinsic size bigger than the largest draw needs.
- **What else applies:** `opacity`, `rounded_*` (corner radii are applied, `img.rs:495-501`), `bg`, `border`, `absolute`, `left` and `top`, plus `transition`, `loop` and `spring` on the 5 motion properties.
  - There is no tint, flip, rotate or scale.
  - There are no handlers; wrap the image in a div.

### 3.3 `svg(path)`, a monochrome icon mask (`MAT:1474-1499`, `GP/elements/svg.rs:125-160`)

- It paints the SVG's alpha in the inherited `text_color`. Set `.text_color(c)` to tint it (`MAT:1475-1481,1489-1490`).
- It is rasterized at the exact painted size, so it stays crisp at any size.
- **It has no intrinsic size: set `.size(n)` or `w`/`h`** (UNCONFIRMED that 0×0 is the default, but every shipped call sizes it).
- `.spin(ms)` rotates it once per `ms`.
- To build a multi-colour sprite from svg masks, stack several `svg()` layers, each with its own `text_color`, inside an absolute container. Use `image()` for true colour.

---

## 4. Motion (all native: no script runs per frame)

Motion is recorded as ops at `Q:6072-6164`, resolved at `MAT:2689-2774`, and applied per materialize at `MAT:795-798`, `3080-3182`.

Every materialize of a view applies **transitions first** (`apply_motion`), **then loops** (`apply_loops`) (`MAT:796-798`). A loop on the same property therefore overrides both the transition and the static style.

### 4.1 `transition(prop, policy)` and `spring(prop, policy?)`

- **prop** is one of `"opacity" | "width" | "height" | "left" | "top"`. Anything else throws (`Q:6072-6079`).
- **transition policy:** either a number (the duration in ms) or `{duration=0, delay=0, easing="ease-out"}`. Durations are 0..86 400 000 ms (`Q:6080-6091`, `6248-6252`). With no `duration` given, the duration is 0 and the transition snaps.
- **spring defaults:** `{response: 250 ms, damping: 1, epsilon: 0.001}` (`Q:6099-6121`).
- **What gets animated:**
  - The **target** is the element's own static style value for that property in the current snapshot: `.left(x)`, `.top(y)`, `.w(n)`, `.h(n)`, `.opacity(a)`.
  - Lengths animate **only when the target is `Length::Definite(DefiniteLength::Absolute(AbsoluteLength::Pixels(_)))`** (`MAT:3183-3197`, `animate_length`). That is a **number** or an `"Npx"` string only (`SH/style.rs:587-610`: both go through `scaled_px`). CORRECTED (critic): `"Nrem"` parses to `AbsoluteLength::Rems` (`SH/style.rs:597-600`), so rem targets **snap**, and so do the rem-based nullary ramps (`left_4`, `w_8`, …). Percentages and `auto` snap too. When the property is unset, nothing happens.
  - Opacity animates only if `.opacity(x)` is set on that element (`MAT:3133-3143`). **Always set it explicitly**, both while shown and while hidden.
- **How a change is detected** (`BASE/motion.rs:268-360`, `579-650`):
  - State lives in GPUI keyed element state, under `(identity, channel)` (`MAT:3209-3282`, `GP/window.rs:4318-4336`).
  - On first sight, the state is created with `from = target`, so **an element that appears does not animate in**.
  - Each materialize compares the new target with the stored one. If it differs, the transition restarts from the value sampled at that instant toward the new target, so it is retargetable mid-flight.
  - The state lives "as long as this element is being rendered in consecutive frames". If the element is absent for a frame, it is forgotten.
- **Identity** (`MAT:2566-2654`):
  - `.id("str")` gives `ElementId::Name(str)`, which is stable across reorders.
  - Without an id, the identity is `NamedInteger("gpui-shell", SpecId)`, where SpecId is the element's **creation index** in the render's arena (`SH/spec.rs:1-25`; the arena resets every script render). Inserting a conditional element earlier in the render shifts every later SpecId. The animation then jumps, or another element inherits it.
  - Components built with `X.new(id)` use their constructor id.
  - The key is `(identity, channel)` looked up with GPUI `use_keyed_state` → `with_global_id`, which prefixes the current element-id stack (`GP/window.rs:3044-3054,4319-4337`). The view element pushes `ElementId::View(entity_id)` (`GP/view.rs:312-314`), so the same `.id("hero-1")` in two different copies should not collide (inference). Inside one copy, keep animated ids unique.
- **Entrance and exit animations:**
  - To animate an entrance, render the start value first. On the next tick (`cx.timer.after(16…, …)`), set the end value and call `cx.notify()`.
  - To animate an exit, keep the element rendered until its transition finishes.
- **Smooth walking:** if your game ticks every T ms and sets `.left(x)` each tick, use `transition("left", {duration: T, easing: "linear"})`.
- **Reduced motion:** with OS reduce-motion on, transitions and springs snap (`BASE/motion.rs:303`; spring at `628`).
- **Cost:** while a transition runs, `window.request_animation_frame()` re-materializes the view every frame, with no VM involved (`BASE/motion.rs:356-358`).

### 4.2 `loop(prop, {from, to, period = 1000, easing = "ease-in-out"})`

- `from` and `to` must be numbers. `period` must be at least 100 ms, otherwise it throws a RangeError (`Q:6134-6156`); Rust also clamps it to `max(100)` (`MAT:2770`).
- **Waveform:** a triangle wave on one **process-global clock**:
  - `phase = (now % period) / period` (`MAT:3091-3101`).
  - `x = 2·phase` for `phase < 0.5`, else `2 − 2·phase`.
  - `value = from + (to − from) · ease(x)`.
  - So the value is `from` at phase 0 and `to` at phase 0.5. The clock's epoch is its first use in the process (`MAT:2895-2898`).
- **It does not start at `from` when the element appears.** Loops with equal periods stay in sync. No `.id()` is needed, because a loop keeps no state.
- **Units:**
  - `left`, `top`, `width` and `height` are written as `gpui::px(value)`, which is **raw px, NOT multiplied by the app zoom** (`MAT:3103-3106`). Static `.left(n)` *is* zoom-scaled. At zoom ≠ 1, divide or multiply by `settings().zoom` yourself.
  - Opacity is clamped to 0..1 (`MAT:3102`).
- **Effect:**
  - It **replaces** that property's static value; it does not add to it. `.left(100).loop("left", …)` ignores the 100.
  - To bob around a base position, put the loop on an inner `relative()` element, whose `top` is an offset from its normal position (win98 Clippy does this).
  - `left` and `top` need the element to be relative (the default) or absolute.
- **Combining:**
  - Several loops on **different** properties of one element are allowed. A second loop on the **same** property replaces the first (`MAT:2765`).
  - Combining with `transition` on other properties is fine.
- **Redraw rate:** the view is woken at about 30 fps (`wake_view_after(33 ms)`, `MAT:3108-3110`). Each wake re-materializes the whole view natively, so a loop costs `O(view size)` per step. To isolate cost, put heavy animated parts in a retained child view (`cx.new`). The wake targets `window.current_view()` (`MAT:3045-3078`), so only that child should rebuild (UNCONFIRMED but follows from the code).
- **No time-based stop.** It runs only while the element is drawn.
- **Reduced motion:** loops do **not** check reduce-motion.
- **Square-wave trick, useful for 2-frame sprite flips** (inference; untested):
  - Opacity is clamped, so `loop("opacity", {from: -10, to: 11, period: P, easing: "linear"})` is fully on for the middle half of each period and fully off otherwise. Swap `from` and `to` for the opposite frame.
  - Opacity multiplies down the tree, so a parent at period P with a child at P/2 gives four ping-pong frames, A B C D D C B A.

### 4.3 `frames(list: string[], ms)`

- It shows `list[floor(now/ms) % len]` **as the element's only child text**, using the same global clock (`MAT:798,817-819`, `3086-3090`).
- **Other children of that element are dropped**, so put frames on a dedicated leaf.
- `ms` must be at least 16, otherwise it throws (`Q:6124-6131`). The default is 100.
- The view wakes exactly at the next frame boundary.

### 4.4 `spin(ms)`

- It works on **svg() only**: one full turn every `ms`, where `ms` is at least 100 (`Q:6159-6164`, `MAT:2736-2739`, `1483-1498`).
- It redraws every **100 ms, so about 10 fps**, both when inline and when hosted by ShellRoot (`MAT:1497`, `3015-3037`). The d.ts's "about 30 fps" is wrong for `spin`.
- It is ignored on other elements.

### 4.5 Limits and cost

- No property other than the five can be animated: there is no scale, rotation (except spin) or color animation.
- Script-driven animation (`cx.timer.every(…) → cx.notify()`) re-runs `render` and redraws the whole window. Herdr's guide says to animate natively (`AG:1084-1097`).
- Use timers for game logic ticks at modest rates, and let `transition` interpolate between ticks.

---

## 5. Events and interaction

This section summarizes §2.6. The full handler signatures are in `TY:1100-1218` and `1404-1500`.

- `on_click((event, cx) => …)`, where event is `{click_count, modifiers: {shift, control, alt, platform, function}}`.
  - It works on `div` without an explicit id, because the shell auto-identifies it (`MAT:2236-2283`).
  - **Use `.id()` anyway.** A click spans mouse-down and mouse-up, and a render in between changes an unnamed element's identity (inference from SpecId identity; UNCONFIRMED).
- Handlers run in the **event** phase with a 500 ms budget. A handler that throws is logged and does not crash (`Q:4004-4007`).
- `cx.stop_propagation()` and `cx.propagate()`.
- **Tooltips:** use `.tooltip("text")` on div, flex or Button. For rich content, use `HoverCard` (trigger and content slots; `open_delay` default 600 ms; `close_delay` default 300 ms; `anchor`). For click-opened menus, use `Popover` or `Popup`.
- **Cursor:** use the `cursor_*` nullary styles, for example `.cursor_pointer()`.
- **Keyboard:**
  1. Herdr mod.json needs `"focusable": true` (`AG:919-923`).
  2. Create the handle in `init`: `this.h = cx.focus_handle()`. Creating it during render throws (`SH/engine/quickjs/entity_api.rs:1203-1218`).
  3. Attach it with `.track_focus(this.h).on_key_down((e, cx) => …)`, and call `this.h.focus()` to take the keyboard.
- **Chords and actions:** `cx.bind_keys([{keystroke: "ctrl-k", action: "x", context?}])`, then `.on_action("x", fn)` together with `.key_context("Name")`.

---

## 6. The `cx` API (`TY:961-1094`; prelude `Q:7033-7090`; `notify` etc. at `Q:10020-10140`)

| member | notes |
|---|---|
| `cx.notify(entity?)` | Re-renders this view, or the retained child `entity`. **It throws in render and layout** (`Q:10039-10055`; `SH/scope.rs:58-61`). It is legal in events, tasks and timers. |
| `cx.stop_propagation()`, `cx.propagate()` | See above. |
| `cx.phase()` | Returns `"render"`, `"event"`, `"task"`, `"layout"` or `"none"`. |
| `cx.theme()` | A frozen gpui-base `Theme`: `colors.{background, foreground, surface, surface_foreground, primary, primary_foreground, secondary, secondary_foreground, muted, muted_foreground, accent, accent_foreground, destructive, destructive_foreground, border, input, ring, selection, …}` as `#rrggbb`; `spacing.{xxs..xxl}`; `radius.{none..full}`; `typography`; `appearance`; `is_dark` (`TY:3738-3811`, `SH/theme_tokens.rs:121-141`). Herdr's own `theme()` from `"herdr"` carries herdr's palette (`ansi*`, `working`, …); see herdr.d.ts. |
| `cx.focus_handle()` | Returns `FocusHandle {focus(), is_focused(), release()}`. **Not in render.** |
| `cx.new(Class, props)` | Returns a retained child `Entity {set_props(props), release()}`. Mount it with `.child(entity)`. Not in render or layout (`SH/engine/quickjs/mod.rs:10633-10646`). The class must extend `View` (`Q:7066-7071`). |
| `cx.spawn(async (acx) => …, {owner?})` | Returns `Task {cancel(), is_done()}`. `acx` is an AsyncContext and stays valid across `await`. |
| `cx.sleep(ms)` | `Promise<void>` |
| `cx.timer.after(ms, (acx) => …, opts?)` | A one-shot `Task` (`SH/engine/quickjs/scheduler.rs:618-639`). |
| `cx.timer.every(ms, (acx) => …, opts?)` | A repeating `Task`. Each interval starts **after the previous call has finished**, so ticks never stack (`scheduler.rs:640-700`; `TY:4087-4096`). `ms` must be ≥ 0 and finite; there is no minimum (`scheduler.rs:1682-1695`). `.cancel()` stops it. The owner is the running view: tasks stop when it closes or reloads, and a loop ends at its next `cx` use (`AG:938-940`). |
| `cx.bind_keys(list)` | Returns the number bound. Not in render. |
| `cx.open_url(url)` | http or https only. |
| `cx.read_from_clipboard()`, `cx.write_to_clipboard(s)` | |

- **Scope:** the `cx` handed to `render` and to event handlers is call-scoped, and using it after an `await` throws a stale-context error. `init` and task or timer callbacks receive an AsyncContext.
- **Timers in render:** `cx.timer` is not refused in render (`scheduler.rs` has no phase check), but a timer created there is new on every render. Create timers in `init`.
- **Herdr while hidden:** timers keep running while the copy or window is hidden. Check `window()?.visible` from `"herdr"` (`AG:1093-1097`).
- **Retained-entity limit:** 10 000 live entities (`SH/entities.rs:54`) and 1024 outstanding tasks per runtime (`scheduler.rs:1557`).

---

## 7. View lifecycle and sub-components

- **The host creates the view in two steps.** First it calls `new Class()` with **no props**, while `deferInit` is true (`Q:6826-6834`). Then it calls `init(props, asyncCx)` (`Q:6839-6841`). Class field initializers are therefore safe, and **the constructor never sees props**.
- **Script-created views run `init` early.** `new MyView(props)` written in your own script calls `init(props, asyncCx)` *inside the `View` constructor* (`Q:6891-6899`), which is before the subclass's class fields are initialized. Fields declared with initializers would overwrite whatever `init` set. Avoid `new SomeView()` for helpers.
- **`render(cx)`** returns an Element, an Entity or a string (`TY:1236-1262`). It runs only when the view is invalidated: by `cx.notify()`, a reload, a theme change, or herdr state changes such as `"Mods re-render when they change"` (`defaults/herdr.d.ts:156`, `498`).
  - Plain repaints, hover, loops and transitions replay the snapshot and never enter the VM (`SH/view.rs:1-23`).
  - The previous snapshot stays alive for one generation, so clicks landing in between still resolve (`SH/view.rs:48-55`).
- **`update(props)`** runs on a retained child when its parent calls `entity.set_props(…)`.
- **`close(cx)`** runs on the application root only, with up to 250 ms for cleanup (`AG:1077-1083`).
- **The roles pattern** (what win98 does, `defaults/mods/win98/main.js:25-38`): the default-exported `View` builds plain JS role objects that have `init` and `render` methods, then calls `this.role.init(props, cx)` and returns `this.role.render(cx)`. Any function returning an Element composes; elements are just values built per render.
- **Retained child views** via `cx.new(Class, props)` give an independent `notify` and snapshot. They also give independent loop, transition and re-materialize cost, as far as the code shows. Each child is mounted at most once per parent snapshot (`TY:1299-1310`).

---

## 8. Text

- `.child("text")` creates a GPUI text run with no box of its own (`MAT:1182-1196`). Style comes from the parent: `text_size`, `text_color`, `font_family`, `font_weight` or `font_*`, `line_height`, `italic`, `text_center`, `whitespace_nowrap`, `truncate`. A text run cannot take handlers, roles or ids.
- **`"\n"` breaks lines** (`GP/text_system.rs:775-850` shapes each line). Text wraps to the container width unless `whitespace_nowrap()` is set.
- **Truncating:** `truncate()` gives a single line with an ellipsis. Its parent needs a constrained width (`w`, `flex_1` plus `min_w(0)`, and so on). `line_clamp(n)` is **not** bound.
- **Unicode** works; herdr itself animates spinners with Braille glyphs `⠋⠙…` (`AG:1086`). Colour emoji depends on platform font fallback (UNCONFIRMED).
- **Custom fonts:**
  - Drop `.ttf`, `.otf` or `.ttc` files in `mods/<name>/fonts/` (or the home's `fonts/`). They load at start and on the next look change (`src/settings.rs:845-873`, `AG:372-375`).
  - Then call `.font_family("Family Name")` with the font's internal family name, not its file name. For example, win98 ships `PixelatedMSSansSerif-Regular.ttf` and uses `"Pixelated MS Sans Serif"` (`defaults/mods/win98/kit.js:34-35`).
  - The default UI font is Geist; the defaults also bundle JetBrains Mono and Geist Mono (`AG:370`).
- **Sizes:**
  - `text_size(n)` is px multiplied by zoom.
  - `text_xs` … `text_3xl` are rem, and herdr's rem is `ui_font_size × zoom` (13 by default).
  - Line height is a multiplier when given a bare number.
- `text_bg(color)` paints behind the glyphs only. `underline` and `line_through` are available; the underline colour cannot be set (`text_decoration_color` is not bound).

---

## Appendix A — pixel-exact drawing under zoom (from win98's kit)

Herdr multiplies every script px by `settings().zoom` (`src/settings.rs:782` → `SH/value.rs:17-27`). For crisp 1-pixel art, win98 uses `u(n) = n * scale / zoom` (`defaults/mods/win98/kit.js:45-50`). Note again that loop px is *not* zoom-multiplied (§4.2) and that nullary `border_N` is raw px.

## Appendix B — UNCONFIRMED list

- ~~Whether taffy positions absolute children against their direct parent~~ SETTLED by the critic: direct parent, always (see §2.3 Position).
- ~~Whether an upscaled image uses smooth (linear) filtering~~ SETTLED: linear for magnification and minification, one mip level (see §3.2). Still open: whether `svg()` defaults to 0×0 when given no size.
- Whether `invisible()` and `opacity(0)` elements keep receiving pointer events.
- Whether a path's own `.opacity()` style is ignored.
- Whether a loop or transition inside a retained child view wakes only that child.
- Whether an unnamed element can lose a click when a render lands between mouse-down and mouse-up.
- Whether colour emoji render.
- Whether `cx.new` follows the same deferred-init path as the root view (`__view_new` was not traced).
- Whether `render` returning `null` or `undefined` is an error (the declared types exclude it).
