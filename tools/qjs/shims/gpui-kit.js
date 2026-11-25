// QuickJS-compatible stand-in for herdr's "gpui-kit" (and the element half of "gpui-base").
//
// Like herdr's prelude (quickjs/mod.rs:5793-5990) every element shares ONE prototype that carries
// every name in tools/api-allowlist.json element_methods (injected as globalThis.__ELEMENT_METHODS),
// so an unknown method is a TypeError "not a function" at call time, as in herdr's fast prototype.
// Each call records [name, args] (herdr records into a Rust spec arena; the cost here is a JS array
// push, the same order as herdr's native __applyParamStyle bridge call).
//
// Enforced here (herdr throws): .child(null|undefined) / bad child, element reused under two
// parents, non-string .id(), colors that are not #rgb/#rrggbb/#rrggbbaa on the color styles, and a
// string that is not valid UTF-8 anywhere it crosses into Rust (a child, a tooltip, an id, any
// style argument): rquickjs String::to_string runs str::from_utf8, which refuses a lone surrogate.
// Recorded (herdr would render it wrong): boolean children, non-finite numbers.
// No parent back-pointers: the tree must stay acyclic so QuickJS frees it by refcount alone.

const ERRS = (globalThis.__shimErrs = globalThis.__shimErrs || []);
const STATS = (globalThis.__shimStats = globalThis.__shimStats || { nodes: 0, calls: 0 });
const err = (code, msg) => { if (ERRS.length < 200) ERRS.push({ code, msg }); };

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR = new Set(["bg", "text_color", "text_bg", "border_color"]);
const STATE = new Set(["hover", "active", "focus", "range_style", "cell_style", "cell_active_style", "caret_style"]);
const SLOTS = new Set(["content", "trigger", "input", "decrement_button", "increment_button", "image", "fallback", "header", "footer", "panel"]);
const HANDLES = new Set(["track_focus", "track_scroll", "content_focus_handle"]);

const proto = {};
const styleProto = {};

// An unpaired UTF-16 surrogate (an emoji cut in half) is not UTF-8: herdr's bridge throws on it.
const SURROGATE = /[\uD800-\uDFFF]/;
function utf8(s, where) {
  if (!SURROGATE.test(s)) return;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { i++; continue; }
    } else if (c < 0xdc00 || c > 0xdfff) continue;
    throw new TypeError(`${where}: invalid utf-8: an unpaired surrogate at index ${i}`);
  }
}
const strArgs = (args, where) => { for (let i = 0; i < args.length; i++) if (typeof args[i] === "string") utf8(args[i], where); };

function El(type, src) {
  this.t = type;
  this.m = [];
  this.c = [];
  this.u = false; // attached or claimed
  if (src !== undefined) this.src = src;
  STATS.nodes++;
}
El.prototype = proto;

function attach(parent, value, where) {
  if (value instanceof El) {
    if (value.u) throw new TypeError(`element \`${value.t}\` was already added to a parent; elements are single-use values`);
    value.u = true;
    parent.c.push(value);
    return;
  }
  const t = typeof value;
  if (t === "string") { utf8(value, where); parent.c.push(value); return; }
  if (t === "number") {
    if (!Number.isFinite(value)) err("non-finite", `${where}(${value})`);
    parent.c.push(String(value));
    return;
  }
  if (t === "boolean") { err("boolean-child", `${where}(${value}) renders the text "${value}"`); parent.c.push(String(value)); return; }
  if (value && value.__entity) { parent.c.push({ view: true }); return; }
  throw new TypeError("child(value) expects an element, a string, or an entity from cx.new(Class, props)");
}

const names = globalThis.__ELEMENT_METHODS || [];
for (let i = 0; i < names.length; i++) {
  const name = names[i];
  if (COLOR.has(name)) {
    proto[name] = function (v) {
      STATS.calls++;
      if (typeof v !== "string" || !HEX.test(v)) throw new TypeError(`${name}(color): expected #rgb, #rrggbb or #rrggbbaa, got ${typeof v === "string" ? JSON.stringify(v) : typeof v}`);
      this.m.push([name, v]);
      return this;
    };
  } else {
    proto[name] = function (a, b) {
      STATS.calls++;
      if (typeof a === "number" && !Number.isFinite(a)) err("non-finite", `.${name}(${a})`);
      strArgs(arguments, name);
      this.m.push(arguments.length > 1 ? [name, a, b] : [name, a]);
      return this;
    };
  }
  styleProto[name] = function (a) { if (typeof a === "string") utf8(a, name); this.m.push([name, a]); return this; };
}

proto.id = function (v) {
  STATS.calls++;
  if (typeof v !== "string") throw new TypeError(`id(value) expects a string, got ${typeof v}`);
  utf8(v, "id");
  this.m.push(["id", v]);
  return this;
};
proto.tooltip = function (v) {
  STATS.calls++;
  if (typeof v !== "string") throw new TypeError(`tooltip(text) expects a string, got ${typeof v}`);
  utf8(v, "tooltip");
  this.m.push(["tooltip", v]);
  return this;
};
proto.child = function (v) { STATS.calls++; attach(this, v, "child"); return this; };
proto.children = function (list) {
  STATS.calls++;
  if (list == null || typeof list[Symbol.iterator] !== "function") throw new TypeError("children(list) expects an iterable");
  for (const c of list) attach(this, c, "children");
  return this;
};
proto.when = function (cond, branch) {
  STATS.calls++;
  if (!cond) return this;
  const out = branch(this);
  if (out == null) throw new TypeError("when(...) must return the element");
  return out;
};
proto.map = function (fn) { STATS.calls++; return fn(this); };
for (const name of STATE) {
  proto[name] = function (declare) {
    STATS.calls++;
    if (typeof declare !== "function") throw new TypeError(`${name}(declare) expects a function`);
    const target = Object.create(styleProto);
    target.m = [];
    declare(target);
    this.m.push([name, target.m]);
    return this;
  };
}
for (const name of SLOTS) {
  proto[name] = function (v) {
    STATS.calls++;
    if (!(v instanceof El)) throw new TypeError(`${name}(element) expects an element`);
    if (v.u) throw new TypeError("element already used");
    v.u = true;
    this.m.push([name, v]);
    return this;
  };
}
for (const name of HANDLES) {
  proto[name] = function (h) {
    STATS.calls++;
    if (!h || typeof h.__handle !== "number") throw new TypeError(`${name}(handle) expects a handle`);
    this.m.push([name, "handle"]);
    return this;
  };
}

let handleSeq = 0;
export const nextHandle = () => ++handleSeq;

export const element = (type, src) => new El(type, src);
export const isElement = (v) => v instanceof El;

export class View {
  constructor() {}
}

export const div = () => new El("div");
export const svg = (path) => { const p = String(path); utf8(p, "svg"); return new El("svg", p); };
export const image = (path) => { const p = String(path); utf8(p, "image"); return new El("image", p); };
export const list = (id, count, getKey, render) => new El("list", String(id));
export const uniform_list = (id, count, getKey, render) => new El("uniform_list", String(id));
export const PathBuilder = { fill: () => ({ move_to() {}, line_to() {}, close() {} }), stroke: () => ({ move_to() {}, line_to() {}, close() {} }) };
export const Background = { solid: (c) => ({ c }) };

/** Serialisable tree (functions as "fn", handles as their tag). */
export function treeOf(v) {
  if (!(v instanceof El)) return v;
  const m = [];
  for (const call of v.m) {
    const out = [call[0]];
    for (let i = 1; i < call.length; i++) {
      const a = call[i];
      out.push(typeof a === "function" ? "fn" : a instanceof El ? treeOf(a) : Array.isArray(a) ? a.map((x) => (Array.isArray(x) ? x : x)) : a);
    }
    m.push(out);
  }
  const o = { t: v.t, m, c: v.c.map(treeOf) };
  if (v.src !== undefined) o.src = v.src;
  return o;
}

/** Count nodes in a tree. */
export function countNodes(v) {
  if (!(v instanceof El)) return 0;
  let n = 1;
  for (const c of v.c) n += countNodes(c);
  for (const call of v.m) if (call[1] instanceof El) n += countNodes(call[1]);
  return n;
}
