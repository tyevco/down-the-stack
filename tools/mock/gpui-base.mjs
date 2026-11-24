// Mock of herdr's "gpui-base": every export in tools/api-allowlist.json base_exports.
// Components are recorded elements of their own type (e.g. { type: "Button", id }); state objects
// (InputState, ScrollHandle, ...) are minimal in-memory stand-ins with a numeric __handle.

import "./globals.mjs";
import { element, NODE, checkListArgs } from "./elements.mjs";
import { View } from "./view.mjs";
import { S } from "./state.mjs";
import { mockError } from "./validate.mjs";

const handle = () => ++S.ids.handle;
const withId = (type) => ({ new: (id) => element(type, { id: String(id) }) });
const noId = (type) => ({ new: () => element(type) });
const oneBased = (v, name) => {
  if (!Number.isInteger(v) || v < 1) throw mockError("bad-argument", name + " must be a whole number of at least 1");
  return v;
};

// ---- layout helpers: h_flex = div().flex().flex_row().items_center(); v_flex = div().flex().flex_col()
export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");

// ---- controls (unstyled), built as X.new(id)
export const Button = withId("Button");
export const Link = withId("Link");
export const Checkbox = withId("Checkbox");
export const Switch = withId("Switch");
export const Tabs = withId("Tabs");
export const Tab = withId("Tab");
export const Progress = withId("Progress");
export const Radio = withId("Radio");
export const Toggle = withId("Toggle");
export const RadioGroup = withId("RadioGroup");
export const ToggleGroup = withId("ToggleGroup");
export const Pagination = withId("Pagination");
export const Accordion = withId("Accordion");
export const AccordionTrigger = withId("AccordionTrigger");
export const Table = withId("Table");
export const TableHeader = withId("TableHeader");
export const TableBody = withId("TableBody");
export const TableCaption = withId("TableCaption");
export const Popover = withId("Popover");
export const HoverCard = withId("HoverCard");
export const Select = withId("Select");
export const Combobox = withId("Combobox");

// ---- parts, built as X.new()
export const ProgressTrack = noId("ProgressTrack");
export const ProgressIndicator = noId("ProgressIndicator");
export const Avatar = noId("Avatar");
export const AvatarFallback = noId("AvatarFallback");
export const AvatarImage = { new: (path) => element("AvatarImage", { src: String(path) }) };
export const Collapsible = noId("Collapsible");
export const AccordionItem = noId("AccordionItem");
export const AccordionPanel = noId("AccordionPanel");
export const AccordionHeader = {
  new: (trigger) => {
    if (typeof trigger?.__id !== "number") throw mockError("bad-argument", "AccordionHeader.new(trigger) expects an AccordionTrigger element");
    return element("AccordionHeader").trigger(trigger);
  },
};
export const Popup = {
  new: (id, trigger) => {
    if (typeof trigger?.__id !== "number") throw mockError("bad-argument", "Popup.new(id, trigger) expects the trigger element; a popup anchors its content to the trigger's bounds, so it cannot be built without one");
    return element("Popup", { id: String(id) }).trigger(trigger);
  },
};
export const DatePicker = {
  new: (id, focusHandle) => {
    if (typeof focusHandle?.__handle !== "number") throw mockError("bad-argument", "DatePicker.new(id, focus_handle) expects a FocusHandle from cx.focus_handle()");
    return element("DatePicker", { id: String(id) });
  },
};

export const TableRow = { new: (id, row) => element("TableRow", { id: String(id) }).map((el) => { oneBased(row, "TableRow.new row index"); return el; }) };
export const TableHead = { new: (id, col) => element("TableHead", { id: String(id) }).map((el) => { oneBased(col, "TableHead.new column index"); return el; }) };
export const TableCell = { new: (id, col) => element("TableCell", { id: String(id) }).map((el) => { oneBased(col, "TableCell.new column index"); return el; }) };

/** Which page numbers to show (null = an ellipsis), like gpui-base's pagination_items. */
export function pagination_items(current, total, visible = 7) {
  current = Number(current); total = Number(total); visible = Number(visible);
  if (total <= visible) return Array.from({ length: total }, (_, i) => i + 1);
  const side = Math.max(1, Math.floor((visible - 3) / 2));
  const out = [1];
  const lo = Math.max(2, current - side), hi = Math.min(total - 1, current + side);
  if (lo > 2) out.push(null);
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < total - 1) out.push(null);
  out.push(total);
  return out;
}

export const CalendarState = { new: () => ({ __handle: handle(), value: () => null, set_value() {}, on() {} }) };

// ---- resizable
export const h_resizable = (id) => element("h_resizable", { id: String(id) });
export const v_resizable = (id) => element("v_resizable", { id: String(id) });
export function resizable_panel() {
  const el = element("resizable_panel");
  // Own properties shadow the shared size/visible, as in herdr.
  Object.defineProperty(el, "size", {
    value: function (px) {
      if (typeof px !== "number" || !Number.isFinite(px) || px < 0) throw mockError("bad-argument", "resizable_panel size must be a finite non-negative number");
      el[NODE].methods.push(["panel_size", [px]]);
      return el;
    },
  });
  Object.defineProperty(el, "visible", { value: function (v) { el[NODE].methods.push(["panel_visible", [Boolean(v)]]); return el; } });
  return el;
}

// ---- scrolling
export const Scrollbar = {
  new: (id) => element("Scrollbar", { id: String(id) }),
  horizontal: (id) => element("Scrollbar", { id: String(id) }).axis("horizontal"),
  vertical: (id) => element("Scrollbar", { id: String(id) }).axis("vertical"),
};

function scrollPosition() {
  let offset = { x: 0, y: 0 };
  return {
    offset: () => ({ ...offset }),
    set_offset: (o) => { offset = { x: Number(o?.x) || 0, y: Number(o?.y) || 0 }; },
    scroll_to_top: () => { offset = { x: offset.x, y: 0 }; },
    scroll_to_bottom: () => {},
    bounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  };
}
export const ScrollHandle = { new: () => ({ __handle: handle(), ...scrollPosition(), scroll_to_item() {}, release() {} }) };
export const VirtualListScrollHandle = {
  new: () => ({
    __handle: handle(),
    ...scrollPosition(),
    scroll_to_item(index) { if (!Number.isInteger(index) || index < 0) throw mockError("bad-argument", "scroll_to_item(index) needs a whole, non-negative index"); },
    release() {},
  }),
};

function virtualList(name) {
  return (id, count, sizes, getKey, render) => {
    const shape = name + "(id, item_count, item_sizes, get_key, render)";
    checkListArgs(shape, count, getKey, render, "once per visible range, not once per item");
    if (Array.isArray(sizes) && sizes.length !== count) throw mockError("bad-argument", `${shape} was given ${sizes.length} item sizes for ${count} items; pass one number for a uniform extent, or one per item`);
    const el = element(name, { id: String(id) });
    el[NODE].list = { count, getKey, render, perItem: false, sizes };
    return el;
  };
}
export const v_virtual_list = virtualList("v_virtual_list");
export const h_virtual_list = virtualList("h_virtual_list");

// ---- text input
function textState(options = {}) {
  let value = String(options?.value ?? "");
  const listeners = {};
  return {
    __handle: handle(),
    value: () => value,
    set_value: (v) => { value = String(v ?? ""); },
    on: (event, fn) => { (listeners[event] ??= []).push(fn); },
    focus() {}, blur() {}, release() {},
    content: () => value, tokens: () => [], selected_range: () => ({ start: 0, end: 0 }), set_selected_range() {}, replace(t) { value = String(t); },
  };
}
const stateEl = (type) => ({ new: (state) => {
  if (typeof state?.__handle !== "number") throw mockError("bad-argument", `${type}.new(state) expects its state object`);
  return element(type);
} });
export const InputState = { new: (o) => textState(o) };
export const Input = stateEl("Input");
export const NumberInput = stateEl("NumberInput");
export const TextareaState = { new: (o) => { if (o?.rows != null) oneBased(o.rows, "TextareaState.new rows"); return textState(o); } };
export const Textarea = stateEl("Textarea");
export const EditorState = { new: (o = {}) => ({ ...textState(o), set_tab_size() {}, set_soft_wrap() {} }) };
export const Editor = stateEl("Editor");
export const TextView = {
  html: (id, text) => element("TextView", { id: String(id) }).map((el) => { el[NODE].src = `html:${String(text).slice(0, 80)}`; return el; }),
  markdown: (id, text) => element("TextView", { id: String(id) }).map((el) => { el[NODE].src = `markdown:${String(text).slice(0, 80)}`; return el; }),
};

// ---- sliders / otp
export const SliderState = {
  new: (options) => {
    const s = options ?? {};
    const min = s.min ?? 0, max = s.max ?? 100, step = s.step ?? 1, scale = String(s.scale ?? "linear");
    for (const [n, v] of [["min", min], ["max", max], ["step", step]]) if (typeof v !== "number" || !Number.isFinite(v)) throw mockError("bad-argument", `SliderState.new ${n} must be a finite number`);
    if (max <= min) throw mockError("bad-argument", "SliderState.new needs a max greater than its min");
    if (step <= 0) throw mockError("bad-argument", "SliderState.new step must be greater than 0");
    if (!["linear", "logarithmic"].includes(scale)) throw mockError("bad-argument", "SliderState.new scale must be linear or logarithmic");
    let value = s.value ?? min;
    return { __handle: handle(), value: () => value, set_value: (v) => { value = v; }, on() {}, release() {} };
  },
};
export const Slider = stateEl("Slider");
export const SliderTrack = stateEl("SliderTrack");
export const SliderIndicator = stateEl("SliderIndicator");
export const SliderThumb = stateEl("SliderThumb");
export const OtpState = {
  new: (length, options) => {
    if (!Number.isInteger(length) || length < 1 || length > 64) throw mockError("bad-argument", "OtpState.new(length) expects a whole number between 1 and 64");
    let value = String(options?.value ?? "");
    return { __handle: handle(), value: () => value, set_value: (v) => { value = String(v); }, on() {}, release() {} };
  },
};
export const OtpInput = stateEl("OtpInput");

// ---- docking
export const DockArea = {
  new: (id, options) => {
    const v = options?.version;
    if (v !== undefined && v !== null && (!Number.isSafeInteger(v) || v < 0)) throw mockError("bad-argument", "DockArea.new(id, options) version expects a whole, non-negative safe integer");
    return { __handle: handle(), id: String(id), add_panel() {}, layout: () => null, release() {} };
  },
  register_panel: (name, Class) => {
    if (typeof name !== "string" || !name) throw mockError("bad-argument", "DockArea.register_panel(name, Class) needs the name the panel is added under");
    if (typeof Class !== "function" || !(Class.prototype instanceof View)) throw mockError("bad-argument", "DockArea.register_panel(name, Class) expects the View subclass the panel is rebuilt from");
  },
};
export const dock_area = (area) => {
  if (typeof area?.__handle !== "number") throw mockError("bad-argument", "dock_area(area) expects a DockArea");
  return element("dock_area");
};
export const dock_content = () => element("dock_content");

// ---- theme
export function set_theme(theme) {
  if (S.phase !== "event" && S.phase !== "task") throw mockError("not-in-render", `set_theme() is legal only from an event handler or a task (now: ${S.phase})`);
  if (!theme || !["light", "dark"].includes(theme.appearance) || !theme.tokens) throw mockError("bad-argument", "set_theme({appearance, tokens}) needs appearance light|dark and tokens");
  S.calls.setTheme.push(theme);
}
