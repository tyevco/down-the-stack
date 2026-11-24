// Portions ported from gpui-kit's QuickJS prelude (herdr-app 0.1.17,
// vendor/gpui-kit/crates/shell/src/engine/quickjs/mod.rs), Copyright 2024 - 2026 Longbridge,
// Apache License 2.0 (see tools/mock/NOTICE and tools/mock/LICENSE-APACHE-2.0); modified for Node.
//
// The element builder: a strict stand-in for gpui-shell's prelude elements.
//
// Every element shares one prototype holding every allowlisted method (tools/api-allowlist.json);
// any other name throws herdr's "unknown element method" TypeError. Arguments are validated like
// herdr validates them (validate.mjs). Each call is recorded on a Node so the harness can check the
// finished tree (images sized, files present, ...), fire handlers, and serialise it for previews.

import { methodKind, PARAM_STYLES, unknownMethodMessage, ELEMENT_METHODS, NULLARY_STYLES, BEHAVIORS, PRELUDE } from "./allowlist.mjs";
import * as V from "./validate.mjs";
import { S, report } from "./state.mjs";

const { mockError } = V;

/** Symbol under which an element object keeps its Node. */
export const NODE = Symbol.for("mapledr.mock.node");
export const FN = "[fn]";

let uid = 1;

export class Node {
  constructor(type, { src = null, id = null, detached = false } = {}) {
    this.uid = uid++;
    this.type = type;
    this.src = src;
    this.id = id;
    /** [[name, args]] in call order (functions replaced by "[fn]" on serialisation) */
    this.methods = [];
    this.children = [];
    this.parent = null;
    this.gen = S.render.gen;
    this.claimed = false;
    this.detached = detached;
    /** handler key ("on_click", "on_mouse_down:left", "on_action:name") → [fn] */
    this.handlers = {};
    /** state styles: hover/active/focus/... → [[name, args]] */
    this.state = {};
    /** named slots: content/trigger/... → Node */
    this.slots = {};
    this.text = null;
    this.list = null;
    this.entity = null;
    this.path = null;
  }

  /** Last recorded args for a method name, or undefined. */
  last(name) {
    for (let i = this.methods.length - 1; i >= 0; i--) if (this.methods[i][0] === name) return this.methods[i][1];
    return undefined;
  }
  has(name) { return this.methods.some((m) => m[0] === name); }
}

export const textNode = (text) => { const n = new Node("text"); n.text = text; return n; };

// ---------------------------------------------------------------------------------------------
// The shared prototype

const methods = {};

// Property names that tooling probes on arbitrary objects; answering them with a throwing
// function would turn `await el` or JSON.stringify(el) into confusing failures.
const PROBES = new Set(["then", "toJSON", "inspect", "asymmetricMatch", "$$typeof", "nodeType", "_isMockFunction", "@@__IMMUTABLE_ITERABLE__@@"]);

const proto = new Proxy(methods, {
  get(target, name, receiver) {
    const found = Reflect.get(target, name, receiver);
    if (found !== undefined) return found;
    if (typeof name !== "string" || name.startsWith("__") || PROBES.has(name)) return undefined;
    return function unknownMethod() {
      throw mockError("unknown-method", unknownMethodMessage(name));
    };
  },
});

/** Wrap a Node in an element object (what mods see). */
export function makeElement(node) {
  const el = Object.create(proto);
  Object.defineProperty(el, NODE, { value: node });
  Object.defineProperty(el, "__id", { value: node.uid }); // like herdr's elements
  node.el = el;
  if (S.render.active) S.render.created++;
  return el;
}

export const isElement = (v) => !!(v && typeof v === "object" && v[NODE]);
export const nodeOf = (el) => el[NODE];

export function element(type, opts) {
  return makeElement(new Node(type, opts));
}

function self(el, method) {
  const node = el?.[NODE];
  if (!node) throw mockError("bad-receiver", `${method}() was called on something that is not an element`);
  if (S.render.active && node.gen !== S.render.gen && !node.detached) {
    throw mockError("expired-element", "this element belongs to a previous render pass; elements are single-use values and must be rebuilt each time render runs");
  }
  // herdr's SpecArena refuses every call on an element that already has a parent (spec.rs
  // check_live → AlreadyParented, thrown to script as a TypeError): build an element completely,
  // then attach it. A slot's element (claimed) still takes styles, as in herdr.
  if (node.parent && !node.claimed && !node.detached) {
    throw mockError("reused-element", `${method}(): element \`${node.type}\` was already added to a parent; elements are single-use values (finish building it before .child())`);
  }
  return node;
}

const serArg = (a) => (typeof a === "function" ? FN : a && typeof a === "object" && "__handle" in a ? `[handle ${a.__handle}]` : a);

// ---- styles

function defineNullary(name) {
  methods[name] = function (...args) {
    const node = self(this, name);
    if (args.length) report("warning", "nullary-arg", `${name}() takes no argument; ${JSON.stringify(args.map(serArg))} is ignored (did you mean the parametric form?)`);
    node.methods.push([name, []]);
    return this;
  };
}

function defineParam(name, type) {
  methods[name] = function (...args) {
    const node = self(this, name);
    const soft = V.checkParamStyle(name, type, args);
    // NaN/Infinity is an error for every style (opacity included); an out-of-range opacity is a warning.
    for (const msg of soft) {
      const range = /is outside 0\.\.1/.test(msg);
      report(range ? "warning" : "error", range ? "opacity-range" : "non-finite", msg);
    }
    node.methods.push([name, [args[0]]]);
    return this;
  };
}

// ---- behaviors (herdr's generic __apply)

const HANDLERS = new Set([
  "on_click", "on_link_click", "on_selection_change", "on_resize", "on_size_change", "on_change", "token",
  "on_token_click", "on_token_hover", "on_open_change", "on_confirm", "on_dismiss", "on_step", "on_item_click",
  "on_item_secondary_click", "on_mouse_move", "on_window_mouse_move", "on_hover", "on_key_down", "on_key_up",
  "on_modifiers_changed", "on_mouse_down_out", "on_drop", "on_scroll_wheel", "on_pinch",
]);
const BUTTONS = ["left", "right", "middle", "back", "forward"];

function refuseInLayout(name) {
  if (S.phase === "layout") {
    throw mockError("handler-in-layout", `\`${name}\` cannot be registered from a virtual list's item renderer: the rows are rebuilt every frame, so a handler registered there would pile up for as long as the view stood`);
  }
}

// Input is wired only on div-like elements and controls; on image()/svg()/paths herdr drops the
// handler with a log line, so a sprite that "takes clicks" silently does nothing (gpui-api §2.6).
const NO_INPUT = new Set(["image", "svg", "path"]);

function addHandler(node, key, fn) {
  if (NO_INPUT.has(node.type)) {
    report("error", "handler-on-image", `${key.split(":")[0]} on ${node.type}("${node.src ?? ""}") is dropped by herdr; wrap the sprite in a div and put the handler there`);
    return;
  }
  (node.handlers[key] ??= []).push(fn);
}

function defineBehavior(name) {
  methods[name] = function (...args) {
    const node = self(this, name);
    for (const a of args) V.checkBridgeable(a, name);
    if (name === "id") {
      if (typeof args[0] !== "string") throw mockError("bad-id", "id(name) expects a string; it is the element's stable identity, so it must not change between renders");
      node.id = args[0];
    } else if (name === "tooltip") {
      if (typeof args[0] !== "string") throw mockError("bad-argument", "tooltip(text) expects a string; a tooltip built from an element is not bound yet");
      if (NO_INPUT.has(node.type)) report("warning", "tooltip-on-image", `tooltip on ${node.type}() is not wired in herdr; put it on a wrapping div`);
    } else if (name === "value") {
      if (typeof args[0] !== "number" || !Number.isFinite(args[0])) throw mockError("bad-argument", "value(percent) expects a number between 0 and 100");
    } else if (name === "on_mouse_down" || name === "on_mouse_up" || name === "on_window_mouse_up") {
      refuseInLayout(name);
      if (typeof args[0] !== "string") throw mockError("bad-argument", `${name}(button, handler) expects a button first: "left", "right", "middle", "back" or "forward"`);
      if (typeof args[1] !== "function") throw mockError("bad-argument", `${name}(button, handler) expects a function second`);
      if (!BUTTONS.includes(args[0]) || (name === "on_window_mouse_up" && ["back", "forward"].includes(args[0]))) {
        throw mockError("bad-argument", `${name}: unknown mouse button ${JSON.stringify(args[0])}`);
      }
      addHandler(node, `${name}:${args[0]}`, args[1]);
    } else if (name === "on_action") {
      refuseInLayout(name);
      if (typeof args[0] !== "string" || !args[0]) throw mockError("bad-argument", "on_action(action, handler) expects the action's name first, as a non-empty string");
      if (typeof args[1] !== "function") throw mockError("bad-argument", "on_action(action, handler) expects a function second");
      addHandler(node, `on_action:${args[0]}`, args[1]);
    } else if (HANDLERS.has(name)) {
      refuseInLayout(name);
      const fn = args.find((a) => typeof a === "function");
      if (!fn) throw mockError("bad-argument", `${name}(handler) expects a function`);
      addHandler(node, name, fn);
    }
    node.methods.push([name, args]);
    return this;
  };
}

// ---- children

function attach(parent, value, where) {
  if (value && typeof value === "object" && value[NODE]) {
    const c = value[NODE];
    if (c === parent) throw mockError("self-parent", "an element cannot be added to itself");
    if (S.render.active && c.gen !== S.render.gen) {
      throw mockError("expired-element", "this element belongs to a previous render pass; elements are single-use values and must be rebuilt each time render runs");
    }
    if (c.detached) throw mockError("claimed-element", "a state-style target (from hover/active/focus) cannot be added to the tree");
    if (c.claimed) throw mockError("claimed-element", "this element was given to a method that takes one — a state style's declarations, or a named slot such as content — and cannot also be added to the tree");
    if (c.parent) throw mockError("reused-element", `element \`${c.type}\` was already added to a parent; elements are single-use values`);
    c.parent = parent;
    parent.children.push(c);
    return;
  }
  if (value && typeof value === "object" && value.__entity) {
    const v = new Node("view");
    v.entity = value;
    v.parent = parent;
    parent.children.push(v);
    return;
  }
  const t = typeof value;
  if (t === "string" || t === "number") {
    if (t === "number" && !Number.isFinite(value)) report("error", "non-finite", `${where}(${value}) renders the text "${value}"; guard the arithmetic`);
    const n = textNode(String(value));
    n.parent = parent;
    parent.children.push(n);
    return;
  }
  if (t === "boolean") {
    // herdr renders String(value): a stray `cond && el` shows the word "false" on screen.
    report("error", "boolean-child", `${where}(${value}) renders the text "${value}"; filter conditional children or use .when(cond, el => ...)`);
    const n = textNode(String(value));
    n.parent = parent;
    parent.children.push(n);
    return;
  }
  const what = value === null ? "null" : value === undefined ? "undefined" : t;
  throw mockError(value == null ? "null-child" : "bad-child", `child(value) expects an element, a string, or an entity from cx.new(Class, props); ${where} got ${what}`);
}

methods.child = function (value) {
  const node = self(this, "child");
  attach(node, value, "child");
  return this;
};

methods.children = function (list) {
  const node = self(this, "children");
  if (list == null || typeof list[Symbol.iterator] !== "function") {
    throw mockError("bad-child", `children(list) expects an iterable of children; got ${list === null ? "null" : typeof list}`);
  }
  let i = 0;
  for (const c of list) attach(node, c, `children([…])[${i++}]`);
  return this;
};

// ---- slots

const SLOTS = ["content", "trigger", "input", "decrement_button", "increment_button", "image", "fallback", "header", "footer", "panel"];
for (const name of SLOTS) {
  methods[name] = function (value) {
    const node = self(this, name);
    if (!isElement(value)) throw mockError("bad-argument", `${name}(element) expects an element`);
    const c = value[NODE];
    if (c.parent) throw mockError("reused-element", `element \`${c.type}\` was already added to a parent; elements are single-use values`);
    if (c.claimed) throw mockError("claimed-element", "this element was already given to a slot");
    if (S.render.active && c.gen !== S.render.gen) throw mockError("expired-element", "this element belongs to a previous render pass");
    c.claimed = true;
    c.parent = node;
    node.slots[name] = c;
    node.methods.push([name, ["[element]"]]);
    return this;
  };
}

// ---- handles

for (const [name, what] of [["track_focus", "a FocusHandle from cx.focus_handle(), not a name or an element"], ["track_scroll", "a ScrollHandle or VirtualListScrollHandle"], ["content_focus_handle", "a FocusHandle from cx.focus_handle(), not a name or an element"]]) {
  methods[name] = function (handle) {
    const node = self(this, name);
    if (typeof handle?.__handle !== "number") throw mockError("bad-argument", `${name}(handle) expects ${what}`);
    node.methods.push([name, [handle]]);
    return this;
  };
}

// ---- state styles: a detached element that collects style calls only

const stateProto = new Proxy({}, {
  get(_t, name) {
    if (typeof name !== "string" || name.startsWith("__") || PROBES.has(name)) return undefined;
    const kind = methodKind(name);
    if (!kind) return () => { throw mockError("unknown-method", unknownMethodMessage(name)); };
    return function (...args) {
      if (kind === "param") {
        V.checkParamStyle(name, PARAM_STYLES.get(name), args);
        this.__list.push([name, [args[0]]]);
      } else if (kind === "nullary") {
        this.__list.push([name, []]);
      } else {
        report("warning", "state-non-style", `${this.__state}(): only style methods apply inside a state style; .${name}() is ignored`);
      }
      return this;
    };
  },
});

for (const name of ["hover", "active", "focus", "range_style", "cell_style", "cell_active_style", "caret_style"]) {
  methods[name] = function (declare) {
    const node = self(this, name);
    if (typeof declare !== "function") throw mockError("bad-argument", `${name}(declare) expects a function that styles the element it is given`);
    if (NO_INPUT.has(node.type) && (name === "hover" || name === "active")) report("warning", "state-on-image", `${name}() styles are not honored on ${node.type}(); wrap it in a div`);
    const target = Object.create(stateProto);
    Object.defineProperty(target, "__list", { value: (node.state[name] ??= []) });
    Object.defineProperty(target, "__state", { value: name });
    declare(target);
    node.methods.push([name, [FN]]);
    return this;
  };
}

// ---- motion

methods.transition = function (property, options) {
  const node = self(this, "transition");
  node.methods.push(["transition", V.checkTransition(property, options)]);
  return this;
};
methods.spring = function (property, options) {
  const node = self(this, "spring");
  node.methods.push(["spring", V.checkSpring(property, options)]);
  return this;
};
methods.loop = function (property, options) {
  const node = self(this, "loop");
  const args = V.checkLoop(property, options);
  if (node.methods.some((m) => m[0] === "loop" && m[1][0] === args[0])) {
    report("warning", "loop-replaced", `a second loop("${args[0]}") on one element replaces the first`);
  }
  node.methods.push(["loop", args]);
  return this;
};
methods.frames = function (list, ms) {
  const node = self(this, "frames");
  node.methods.push(["frames", V.checkFrames(list, ms)]);
  return this;
};
methods.spin = function (ms) {
  const node = self(this, "spin");
  const args = V.checkSpin(ms);
  if (node.type !== "svg") report("error", "spin-not-svg", `spin() only turns svg() elements; on a \`${node.type}\` it is ignored`);
  node.methods.push(["spin", args]);
  return this;
};

// ---- small validated prelude methods

const ANCHORS = ["top_left", "top_right", "bottom_left", "bottom_right", "top_center", "bottom_center", "left_center", "right_center"];
function oneOf(name, allowed) {
  methods[name] = function (value) {
    const node = self(this, name);
    value = String(value);
    if (!allowed.includes(value)) throw mockError("bad-argument", `${name}(value) must be ${allowed.join(", ")}; got ${JSON.stringify(value)}`);
    node.methods.push([name, [value]]);
    return this;
  };
}
oneOf("axis", ["horizontal", "vertical"]);
oneOf("mode", ["scrolling", "hover", "always"]);
oneOf("anchor", ANCHORS);
oneOf("mouse_button", BUTTONS);

methods.scroll_size = function (w, h) {
  const node = self(this, "scroll_size");
  for (const [v, n] of [[w, "scroll_size width"], [h, "scroll_size height"]]) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw mockError("bad-argument", `${n} must be a finite non-negative number`);
  }
  node.methods.push(["scroll_size", [w, h]]);
  return this;
};
methods.frame_budget = function (ms) {
  const node = self(this, "frame_budget");
  node.methods.push(["frame_budget", [V.finitePositive(ms, "frame_budget")]]);
  return this;
};
for (const name of ["open_delay", "close_delay"]) {
  methods[name] = function (ms) {
    const node = self(this, name);
    node.methods.push([name, [V.finiteDuration(ms, name)]]);
    return this;
  };
}
methods.size_range = function (min, max) {
  const node = self(this, "size_range");
  const args = [min];
  if (typeof min !== "number" || !Number.isFinite(min) || min < 0) throw mockError("bad-argument", "size_range min must be a finite non-negative number");
  if (max !== undefined && max !== null) {
    if (typeof max !== "number" || !Number.isFinite(max) || max < 0) throw mockError("bad-argument", "size_range max must be a finite non-negative number");
    args.push(max);
  }
  node.methods.push(["size_range", args]);
  return this;
};
methods.drag_paths = function (paths, opts) {
  const node = self(this, "drag_paths");
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) throw mockError("bad-argument", "drag_paths(paths) expects an array of path strings");
  node.methods.push(["drag_paths", [paths.slice(), opts?.on ?? null]]);
  return this;
};
for (const name of ["select_tab", "close_panel", "toggle_zoom", "drag_tab", "drop_tab", "toggle_dock", "resize_dock"]) {
  methods[name] = function (...args) {
    const node = self(this, name);
    node.methods.push([name, args]);
    return this;
  };
}

// ---- control flow

methods.map = function (transform) {
  self(this, "map");
  return transform(this);
};
methods.when = function (condition, branch) {
  self(this, "when");
  if (!condition) return this;
  const produced = branch(this);
  if (produced === undefined || produced === null) throw mockError("when-return", "when(...) must return the element", Error);
  return produced;
};

// ---- install everything from the allowlist, in herdr's precedence order

for (const name of NULLARY_STYLES) if (ELEMENT_METHODS.has(name)) defineNullary(name);
for (const [name, type] of PARAM_STYLES) defineParam(name, type);
for (const name of BEHAVIORS) defineBehavior(name);
for (const name of PRELUDE) {
  // Anything the prelude defines that has no dedicated implementation above is recorded as is.
  if (!Object.prototype.hasOwnProperty.call(methods, name)) {
    methods[name] = function (...args) {
      const node = self(this, name);
      node.methods.push([name, args]);
      return this;
    };
  }
}
for (const name of ELEMENT_METHODS) if (!Object.prototype.hasOwnProperty.call(methods, name)) defineBehavior(name);

// ---------------------------------------------------------------------------------------------
// Serialisation

/**
 * A plain JSON tree for previews and assertions:
 * { type, id?, src?, methods: [[name, args]], children: [...], text?, handlers?, state?, slots? }
 * Text children are { type: "text", text }. `text` on an element joins its direct text children.
 */
export function serialize(node) {
  if (node.type === "text") return { type: "text", text: node.text };
  const out = { type: node.type };
  if (node.id != null) out.id = node.id;
  if (node.src != null) out.src = node.src;
  out.methods = node.methods.map(([n, a]) => [n, a.map(serArg)]);
  out.children = node.children.map(serialize);
  const texts = node.children.filter((c) => c.type === "text").map((c) => c.text);
  if (texts.length) out.text = texts.join("");
  const h = Object.keys(node.handlers);
  if (h.length) out.handlers = h;
  if (Object.keys(node.state).length) out.state = Object.fromEntries(Object.entries(node.state).map(([k, l]) => [k, l.map(([n, a]) => [n, a.map(serArg)])]));
  if (Object.keys(node.slots).length) out.slots = Object.fromEntries(Object.entries(node.slots).map(([k, n]) => [k, serialize(n)]));
  if (node.path) out.path = node.path;
  return out;
}

/** Depth-first walk over a live Node tree (children and slots). */
export function walk(node, fn, parent = null) {
  fn(node, parent);
  for (const c of node.children) walk(c, fn, node);
  for (const c of Object.values(node.slots)) walk(c, fn, node);
}

// ---------------------------------------------------------------------------------------------
// PathBuilder / Background (copied semantics from herdr's prelude)

const coordinate = (value, name) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?(?:\d+(?:\.\d*)?|\.\d+)%$/.test(value)) return value;
  throw mockError("bad-argument", name + " must be a finite pixel number or percentage string");
};

const background = (kind, values, opacityFactor = 1, colorSpace = "srgb") => Object.freeze({
  __background: true, kind, values: Object.freeze(values), opacityFactor, colorSpace,
  opacity(factor) {
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0) throw mockError("bad-argument", "background opacity must be a finite non-negative number");
    return background(kind, values, factor, colorSpace);
  },
  color_space(space) {
    space = String(space).toLowerCase();
    if (!["srgb", "oklab"].includes(space)) throw mockError("bad-argument", "background color_space must be srgb or oklab");
    return background(kind, values, opacityFactor, space);
  },
});

export const Background = Object.freeze({
  solid: (color) => background("solid", [String(color)]),
  stop: (color, percentage) => {
    if (typeof percentage !== "number" || !Number.isFinite(percentage)) throw mockError("bad-argument", "background stop percentage must be finite");
    return Object.freeze({ __backgroundStop: true, color: String(color), percentage });
  },
  linear_gradient: (angle, from, to) => {
    angle = Number(angle);
    if (!Number.isFinite(angle)) throw mockError("bad-argument", "linear gradient angle must be finite");
    const stop = (value, fallback, name) => {
      if (typeof value === "string") return [value, fallback];
      if (!value?.__backgroundStop) throw mockError("bad-argument", name + " must be a color or Background.stop(color, percentage)");
      return [value.color, value.percentage];
    };
    const a = stop(from, 0, "gradient from stop");
    const b = stop(to, 1, "gradient to stop");
    return background("linear-gradient", [String(angle), a[0], String(a[1]), b[0], String(b[1])]);
  },
  pattern_slash: (color, width, interval) => background("pattern-slash", [String(color), String(V.finitePositive(width, "pattern width")), String(V.finitePositive(interval, "pattern interval"))]),
  checkerboard: (color, size) => background("checkerboard", [String(color), String(V.finitePositive(size, "checkerboard size"))]),
});

function pathBuilder(fill, width) {
  const commands = [];
  const b = {};
  const command = (name, arity) => (...args) => {
    if (args.length < arity) throw mockError("bad-argument", name + " expects at least " + arity + " argument(s)");
    for (let i = 0; i < arity; i++) coordinate(args[i], name + " coordinate");
    commands.push([name, ...args]);
    return b;
  };
  b.move_to = command("move_to", 2);
  b.line_to = command("line_to", 2);
  b.curve_to = command("curve_to", 4);
  b.cubic_bezier_to = command("cubic_bezier_to", 6);
  b.arc_to = (...args) => {
    if (args.length < 7) throw mockError("bad-argument", "arc_to expects at least 7 argument(s)");
    coordinate(args[0], "arc x radius"); coordinate(args[1], "arc y radius");
    if (typeof args[2] !== "number" || !Number.isFinite(args[2])) throw mockError("bad-argument", "arc rotation must be finite");
    coordinate(args[5], "arc destination x"); coordinate(args[6], "arc destination y");
    commands.push(["arc_to", ...args]);
    return b;
  };
  b.close = () => { commands.push(["close"]); return b; };
  b.dash_array = (values) => {
    if (fill) throw mockError("bad-argument", "dash_array is only available on stroke paths");
    if (!Array.isArray(values) || values.some((v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0)) throw mockError("bad-argument", "dash_array(values) expects positive finite pixel numbers");
    commands.push(["dash_array", ...values]);
    return b;
  };
  b.add_polygon = (points, closed = true) => {
    if (!Array.isArray(points) || points.length === 0) throw mockError("bad-argument", "add_polygon(points) expects a non-empty array");
    points.forEach((p, i) => {
      if (!Array.isArray(p) || p.length < 2) throw mockError("bad-argument", "each polygon point must be [x, y]");
      command(i === 0 ? "move_to" : "line_to", 2)(p[0], p[1]);
    });
    if (closed) b.close();
    return b;
  };
  b.build = () => Object.freeze({ __path: true, fill, width, commands: Object.freeze(commands.map((c) => Object.freeze(c.slice()))) });
  return b;
}

export const PathBuilder = Object.freeze({
  fill: () => pathBuilder(true, 0),
  stroke: (width) => pathBuilder(false, V.finitePositive(width, "stroke width")),
});

/** window.paint_path(path, background) → a path element. */
export function paintPath(pathValue, paintValue) {
  if (!pathValue?.__path) throw mockError("bad-argument", "window.paint_path(path, background) expects a Path built by PathBuilder");
  const paint = paintValue?.__background ? paintValue : background("solid", [String(paintValue)]);
  if (paint.kind === "solid") V.checkColor(paint.values[0], "paint_path");
  if (paint.kind === "linear-gradient") { V.checkColor(paint.values[1], "linear_gradient"); V.checkColor(paint.values[3], "linear_gradient"); }
  const el = element("path");
  el[NODE].path = { fill: pathValue.fill, width: pathValue.width, commands: pathValue.commands.map((c) => c.slice()), paint: { kind: paint.kind, values: paint.values.slice(), opacity: paint.opacityFactor, colorSpace: paint.colorSpace } };
  return el;
}

/** herdr's checkListArgs. */
export function checkListArgs(shape, count, getKey, render, hint) {
  if (!Number.isInteger(count) || count < 0) throw mockError("bad-argument", shape + " needs a whole, non-negative item_count");
  if (typeof getKey !== "function") throw mockError("bad-argument", shape + " needs get_key(index) to return each item's stable string key");
  if (typeof render !== "function") throw mockError("bad-argument", shape + " needs a render function; it is called " + hint);
}

