// The layout (layouts/Down-the-Stack.json), the mod manifest (mods/down-the-stack/mod.json), the optional
// keys (keys.json: herdr's install flow merges a file of that name, defaults/AGENTS.md "Layouts and
// mods other people made") and the licence files, checked against herdr 0.1.17's own rules:
//   - layout schema: src/layout.rs (Node, Content, PaneFrame, Header, Background, Size, Look);
//     colors: settings.rs (`#rrggbb[aa]` or a theme name; unknown names paint magenta);
//   - palette entries: defaults/frame/palette/main.js (modEntry);
//   - keys: src/keys.rs (sections, actions, parse()) and defaults/keys*.json (collisions).
// docs/herdr-notes/layout.md summarises all of it. The herdr source tree is optional: when it is at
// $HERDR_SRC (tools/mock/config.mjs) the shipped lists are read from it and the layout is also
// diffed against the shipped main.json; otherwise the snapshots below are used, and each gate that
// needs the source says so in one line (tools/mock/gates.mjs; STRICT_GATES=1 fails instead).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HERDR_SRC, herdrSource, herdrMissing, skipGate } from "../tools/mock/gates.mjs";
import { COMMANDS as DOC_COMMANDS } from "../tools/mock/herdr-commands.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HERDR = HERDR_SRC;
const KEYS_FILE = path.join(REPO, "keys.json");
const LAYOUT_FILE = path.join(REPO, "layouts", "Down-the-Stack.json");
/** The mod folder: herdr shows it to players (Keys overlay, failed-command toasts, "did not load"). */
const MOD = "down-the-stack";
const MOD_DIR = path.join(REPO, "mods", MOD);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonIfAny = (file) => (fs.existsSync(file) ? readJson(file) : null);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// ---------------------------------------------------------------------------------------------
// Snapshots of herdr 0.1.17 (used when the source tree is absent)

/** defaults/mods/* */
const SHIPPED_MODS_SNAPSHOT = [
  "agents", "changes", "confirm", "files", "help", "machine-add", "menu", "new-menu", "pane", "peek",
  "picker", "prompt", "spaces", "tabs", "terminals-bar", "terminals-pane", "toast", "win98",
  "workspace-chrome", "workspace-status", "worktree",
];
const SHIPPED_MODS = (() => {
  const dir = path.join(HERDR, "defaults", "mods");
  try { return new Set(fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory())); }
  catch { return new Set(SHIPPED_MODS_SNAPSHOT); }
})();

/** settings.rs resolve(): every theme color name. */
const THEME_NAMES = new Set([
  "background", "terminal_foreground", "foreground", "surface", "canvas", "chrome", "popover", "raised",
  "hover", "selected", "border", "input", "muted", "dim", "accent", "accent_foreground", "solid",
  "solid_foreground", "ring", "selection", "cursor", "working", "blocked", "done", "idle", "unknown",
  ...Array.from({ length: 16 }, (_, i) => `ansi${i}`),
]);

/** Every key bound by defaults/keys.json and defaults/keys.macos.json (any section). */
const DEFAULT_KEYS_SNAPSHOT = [
  // keys.json
  "alt-1", "alt-2", "alt-3", "alt-4", "alt-5", "alt-6", "alt-7", "alt-8", "alt-9", "alt-h", "alt-j", "alt-k",
  "alt-l", "alt-left", "alt-right", "alt-shift-h", "alt-shift-j", "alt-shift-k", "alt-shift-l", "ctrl-+",
  "ctrl--", "ctrl-0", "ctrl-=", "ctrl-1", "ctrl-2", "ctrl-3", "ctrl-4", "ctrl-5", "ctrl-6", "ctrl-7", "ctrl-8",
  "ctrl-9", "ctrl-pagedown", "ctrl-pageup", "ctrl-tab", "ctrl-shift-tab", "alt-]", "alt-[",
  "ctrl-shift-pagedown", "ctrl-shift-pageup", "alt-down", "alt-up", "ctrl-?", "ctrl-shift-/", "ctrl-shift-?",
  "ctrl-shift-b", "ctrl-shift-n", "ctrl-shift-t", "ctrl-shift-k", "ctrl-shift-p", "ctrl-,", "ctrl-shift-o",
  "ctrl-shift-e", "ctrl-shift-w", "ctrl-shift-x", "ctrl-shift-z", "ctrl-shift-l", "f2", "shift-f2",
  "ctrl-backspace", "ctrl-left", "ctrl-right", "ctrl-shift-c", "ctrl-shift-v", "ctrl-shift-f", "ctrl-v",
  "ctrl-insert", "shift-insert",
  // keys.macos.json
  "cmd-q", "cmd-h", "cmd-alt-h", "cmd-m", "cmd-t", "cmd-w", "cmd-shift-]", "cmd-shift-[", "cmd-alt-]",
  "cmd-alt-[", "cmd-]", "cmd-[", "cmd-shift-l", "cmd-n", "cmd-p", "cmd-shift-p", "cmd-,", "cmd-d",
  "cmd-shift-d", "cmd-shift-w", "cmd-shift-enter", "cmd-alt-left", "cmd-alt-right", "cmd-alt-up",
  "cmd-alt-down", "cmd-alt-shift-left", "cmd-alt-shift-right", "cmd-alt-shift-up", "cmd-alt-shift-down",
  "cmd-/", "cmd-shift-/", "cmd-b", "cmd-=", "cmd-+", "cmd--", "cmd-0", "cmd-1", "cmd-2", "cmd-3", "cmd-4",
  "cmd-5", "cmd-6", "cmd-7", "cmd-8", "cmd-9", "cmd-f", "cmd-a", "cmd-c", "cmd-v", "alt-backspace",
  "cmd-left", "cmd-right", "cmd-backspace",
];
const DEFAULT_KEYS = (() => {
  const keys = new Set(DEFAULT_KEYS_SNAPSHOT);
  for (const f of ["keys.json", "keys.macos.json"]) {
    const j = readJsonIfAny(path.join(HERDR, "defaults", f));
    for (const section of Object.values(j ?? {})) for (const k of Object.keys(section)) keys.add(k);
  }
  return keys;
})();

/** The app commands this repo's files use, with their arguments (src/commands.rs). */
const APP_COMMANDS = {
  "layout.switch": [{ name: "name", required: false }],
  "layout.toggle": [{ name: "id", required: true }],
  "layout.show": [{ name: "id", required: true }],
  "layout.hide": [{ name: "id", required: true }],
  "layout.resize": [{ name: "id", required: true }, { name: "px", required: false }, { name: "weight", required: false }],
  "mod.open": [{ name: "name", required: true }],
};

/**
 * The mod's own commands (ARCHITECTURE §4): the key commands main.js hands to host.hotkey (its
 * HOTKEYS table, read from the source so a new one cannot be missed), and the roles a layout node
 * may ask for (§1).
 */
const MOD_COMMANDS = (() => {
  const src = fs.readFileSync(path.join(MOD_DIR, "main.js"), "utf8");
  const m = /^const HOTKEYS = \{([^}]*)\};$/m.exec(src);
  assert.ok(m, "main.js: const HOTKEYS = { … };");
  return new Set([...m[1].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/g)].map((x) => x[1] ?? x[2]));
})();
const LAYOUT_ROLES = new Set(["stage", "party", "nameplate", "hud"]);

// ---------------------------------------------------------------------------------------------
// A validator for herdr's layout schema (src/layout.rs). Collects every problem as "where: what".

const NODE_KEYS = new Set([
  "id", "type", "cloned_from", "content", "children", "active", "header", "size", "min", "max", "hidden",
  "title", "background", "border", "radius", "shadow", "padding", "focus", "gap", "divider", "movable",
  "closable", "resizable", "floating", "window_drag",
]);
/** Look keys parse on any node, but herdr only applies the root's (window.rs:958). */
const LOOK_KEYS = new Set([
  "theme", "colors", "font", "font_size", "font_weight", "font_weight_bold", "terminal_line_height",
  "terminal_cell_width", "terminal_scroll_speed", "ui_font", "terminal_padding", "terminal_opacity",
]);
const ROOT_KEYS = new Set(["titlebar", "traffic_lights", "preview", "terminal_menu", "link_handlers", "toast", "window_blur"]);
const PANE_FRAME_KEYS = new Set(["header", "background", "shadow", "border", "focus", "veil", "radius", "gap", "lone"]);
const HEADER_KEYS = new Set(["content", "reveal", "height", "position"]);
const FLOAT_KEYS = new Set(["id", "content", "edge", "align", "peek", "hidden"]);
const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/; // parse_hex: 6 or 8 digits only (#rgb is a name → magenta)

function validateLayout(root) {
  const errors = [];
  const err = (where, what) => errors.push(`${where}: ${what}`);
  const custom = isObj(root.colors) ? new Set(Object.keys(root.colors)) : new Set();
  const nodes = [];
  const floats = [];
  const mods = []; // { name, props, where }

  const unknownKeys = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) if (!allowed.has(k)) err(where, `unknown key "${k}" (ignored, and dropped when herdr rewrites the file)`);
  };
  const color = (v, where) => {
    if (typeof v !== "string") return err(where, `color must be a string, got ${JSON.stringify(v)}`);
    if (!HEX.test(v) && !THEME_NAMES.has(v) && !custom.has(v)) err(where, `"${v}" is neither #rrggbb[aa], a theme name, nor defined in the root "colors" (paints magenta)`);
  };
  const line = (v, where, keys = ["width", "color"]) => {
    if (!isObj(v)) return err(where, "must be an object");
    unknownKeys(v, new Set(keys), where);
    if ("width" in v && !(isNum(v.width) && v.width >= 0)) err(where, "width must be a number ≥ 0");
    for (const k of keys.filter((k) => k !== "width")) if (k in v) color(v[k], `${where}.${k}`);
  };
  const background = (v, where) => {
    if (typeof v === "string") return color(v, where);
    if (!isObj(v)) return err(where, "must be a color, {gradient,angle} or {image,fit}");
    if ("gradient" in v) {
      unknownKeys(v, new Set(["gradient", "angle"]), where);
      if (!Array.isArray(v.gradient) || v.gradient.length !== 2) return err(where, "gradient takes exactly two colors");
      v.gradient.forEach((c, i) => color(c, `${where}.gradient[${i}]`));
      if ("angle" in v && !isNum(v.angle)) err(where, "angle must be a number (degrees)");
    } else if ("image" in v) {
      unknownKeys(v, new Set(["image", "fit"]), where);
      if (typeof v.image !== "string" || !v.image) err(where, "image must be a path relative to the app home");
      if ("fit" in v && !["cover", "contain"].includes(v.fit)) err(where, `fit must be cover|contain, got ${JSON.stringify(v.fit)}`);
    } else err(where, "must be a color, {gradient,angle} or {image,fit}");
  };
  const header = (h, where) => {
    if (!isObj(h)) return err(where, "must be an object");
    unknownKeys(h, HEADER_KEYS, where);
    if (h.content === "tabs") { /* the built-in strip */ }
    else if (isObj(h.content) && typeof h.content.mod === "string") {
      unknownKeys(h.content, new Set(["mod", "props"]), `${where}.content`);
      mods.push({ name: h.content.mod, props: h.content.props ?? null, where: `${where}.content` });
    } else err(where, `content must be "tabs" or {mod, props}`);
    if ("height" in h && !(isNum(h.height) && h.height > 0)) err(where, "height must be a number > 0");
    if ("position" in h && !["top", "bottom"].includes(h.position)) err(where, "position must be top|bottom");
    if ("reveal" in h && !["always", "hover"].includes(h.reveal)) err(where, "reveal must be always|hover");
  };
  const paneFrame = (p, where) => {
    if (!isObj(p)) return err(where, "must be an object");
    unknownKeys(p, PANE_FRAME_KEYS, where);
    if ("header" in p) header(p.header, `${where}.header`);
    if ("background" in p) background(p.background, `${where}.background`);
    if ("border" in p) line(p.border, `${where}.border`);
    if ("focus" in p) line(p.focus, `${where}.focus`);
    if ("shadow" in p && !["sm", "md", "lg"].includes(p.shadow)) err(where, "shadow must be sm|md|lg");
    if ("veil" in p && !(isNum(p.veil) && p.veil >= 0 && p.veil <= 1)) err(where, "veil must be 0..1");
    for (const k of ["radius", "gap"]) if (k in p && !isNum(p[k])) err(where, `${k} must be a number`);
    if ("lone" in p && typeof p.lone !== "boolean") err(where, "lone must be a boolean");
  };
  const content = (c, where) => {
    if (!isObj(c)) return err(where, "content must be an object");
    // Untagged enum, tried in this order (layout.rs Content).
    if (typeof c.terminal === "string") unknownKeys(c, new Set(["terminal"]), where);
    else if (typeof c.mod === "string") {
      unknownKeys(c, new Set(["mod", "props"]), where);
      mods.push({ name: c.mod, props: c.props ?? null, where });
    } else if (typeof c.tab === "string" || typeof c.context === "string") {
      unknownKeys(c, new Set(["tab", "context", "pane"]), where);
      if ("pane" in c) paneFrame(c.pane, `${where}.pane`);
    } else if (typeof c.agent === "string") unknownKeys(c, new Set(["agent"]), where);
    else err(where, "content matches no variant (terminal | mod | tab | agent)");
  };

  const walk = (n, where, isRoot) => {
    if (!isObj(n)) return err(where, "node must be an object");
    nodes.push(n);
    const at = n.id ? `${where}#${n.id}` : where;
    for (const k of Object.keys(n)) {
      if (NODE_KEYS.has(k)) continue;
      if (LOOK_KEYS.has(k) || ROOT_KEYS.has(k)) { if (!isRoot) err(at, `"${k}" is read from the root only`); continue; }
      err(at, `unknown key "${k}" (ignored, and dropped when herdr rewrites the file)`);
    }
    if (typeof n.id !== "string" || !n.id) err(at, "every node needs an id (herdr rewrites the file to add node-N ids)");
    const containers = ["row", "column", "stack"];
    if (n.type === "block") {
      if (!("content" in n)) err(at, "a block needs content");
      else content(n.content, `${at}.content`);
      for (const k of ["children", "active", "header", "divider", "gap"]) if (k in n) err(at, `"${k}" is not for blocks`);
    } else if (containers.includes(n.type)) {
      if (!Array.isArray(n.children)) err(at, `a ${n.type} needs a children array`);
      else if (!n.children.length) err(at, `a ${n.type} with no children shows nothing`);
      if ("content" in n) err(at, `a ${n.type} has no content`);
      if (n.type === "stack") {
        if ("active" in n && !(n.children ?? []).some((c) => c.id === n.active)) err(at, `active "${n.active}" is not a child`);
        if ("header" in n) header(n.header, `${at}.header`);
      } else for (const k of ["active", "header"]) if (k in n) err(at, `"${k}" is for stacks only`);
      (n.children ?? []).forEach((c, i) => walk(c, `${at}/${c?.id ?? i}`, false));
    } else err(at, `type must be block|row|column|stack, got ${JSON.stringify(n.type)}`);

    if ("size" in n) {
      const s = n.size;
      const ok = isObj(s) && Object.keys(s).length === 1 &&
        ((isNum(s.px) && s.px >= 0) || (isNum(s.weight) && s.weight > 0));
      if (!ok) err(at, `size must be {px: n ≥ 0} or {weight: n > 0}, got ${JSON.stringify(s)}`);
    }
    for (const k of ["min", "max", "radius", "gap"]) if (k in n && !(isNum(n[k]) && n[k] >= 0)) err(at, `${k} must be a number ≥ 0`);
    if (isNum(n.min) && isNum(n.max) && n.min > n.max) err(at, "min > max");
    if (isNum(n.size?.px) && ((isNum(n.min) && n.size.px < n.min) || (isNum(n.max) && n.size.px > n.max))) err(at, "px outside min..max (herdr clamps it)");
    for (const k of ["hidden", "movable", "closable", "resizable", "window_drag"]) if (k in n && typeof n[k] !== "boolean") err(at, `${k} must be a boolean`);
    if ("title" in n && typeof n.title !== "string") err(at, "title must be a string");
    if ("shadow" in n && !["sm", "md", "lg"].includes(n.shadow)) err(at, "shadow must be sm|md|lg");
    if ("padding" in n && !(isNum(n.padding) || (Array.isArray(n.padding) && n.padding.length === 2 && n.padding.every(isNum)))) err(at, "padding must be n or [vertical, horizontal]");
    if ("background" in n) background(n.background, `${at}.background`);
    if ("border" in n) line(n.border, `${at}.border`);
    if ("divider" in n) line(n.divider, `${at}.divider`, ["width", "color", "hover", "active"]);
    if ("focus" in n) {
      if (!isObj(n.focus)) err(at, "focus must be an object");
      else {
        unknownKeys(n.focus, new Set(["border", "background"]), `${at}.focus`);
        if ("border" in n.focus) line(n.focus.border, `${at}.focus.border`);
        if ("background" in n.focus) color(n.focus.background, `${at}.focus.background`);
      }
    }
    if ("floating" in n) {
      if (!Array.isArray(n.floating)) err(at, "floating must be an array");
      else n.floating.forEach((f, i) => {
        const fw = `${at}.floating[${i}]`;
        if (!isObj(f)) return err(fw, "must be an object");
        unknownKeys(f, FLOAT_KEYS, fw);
        if (typeof f.id !== "string" || !f.id) err(fw, "a float needs an id");
        floats.push(f);
        content(f.content, `${fw}.content`);
        if ("edge" in f && !["top", "right", "bottom", "left"].includes(f.edge)) err(fw, "edge must be top|right|bottom|left");
        if ("align" in f && !["start", "center", "end"].includes(f.align)) err(fw, "align must be start|center|end");
      });
    }
  };

  walk(root, "root", true);

  // Root look and root-only keys.
  if ("colors" in root) {
    if (!isObj(root.colors)) err("root.colors", "must be an object of name → hex");
    else for (const [k, v] of Object.entries(root.colors)) if (!HEX.test(String(v))) err(`root.colors.${k}`, `"${v}" is not #rrggbb or #rrggbbaa`);
  }
  if ("titlebar" in root && !["system", "none"].includes(root.titlebar)) err("root", "titlebar must be system|none");
  if ("traffic_lights" in root && !(Array.isArray(root.traffic_lights) && root.traffic_lights.length === 2 && root.traffic_lights.every(isNum))) err("root", "traffic_lights must be [x, y]");
  if ("terminal_padding" in root && !(Array.isArray(root.terminal_padding) && root.terminal_padding.length === 2 && root.terminal_padding.every(isNum))) err("root", "terminal_padding must be [x, y]");
  if ("font_size" in root && !(isNum(root.font_size) && root.font_size >= 6 && root.font_size <= 72)) err("root", "font_size must be 6..72");
  for (const k of ["terminal_menu", "toast"]) if (k in root) mods.push({ name: root[k], props: null, where: `root.${k}` });
  for (const m of root.link_handlers ?? []) mods.push({ name: m, props: null, where: "root.link_handlers" });

  // Ids: present, unique (herdr does not check: find() returns the first), and not slot-shaped.
  const ids = [...nodes.map((n) => n.id), ...floats.map((f) => f.id)].filter((id) => typeof id === "string" && id);
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) err(`#${id}`, "duplicate id");
    seen.add(id);
    if (/^n[0-9a-f]{32}$/.test(id) || id.startsWith("float:") || id.includes("#")) err(`#${id}`, "id clashes with herdr's slot names (pane ids, float:<id>, <id>#frame/#header)");
  }
  return { errors, nodes, floats, mods, ids };
}

// ---------------------------------------------------------------------------------------------

const layout = readJson(LAYOUT_FILE);
const V = validateLayout(layout);
const byId = (id, node = layout) => {
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const f = byId(id, c); if (f) return f; }
  return null;
};
const parentOf = (id, node = layout) => {
  for (const c of node.children ?? []) { if (c.id === id) return node; const f = parentOf(id, c); if (f) return f; }
  return null;
};
const within = (ancestorId, id) => Boolean(byId(id, byId(ancestorId) ?? {}));
const mainFrame = () => byId("main").content.pane;

describe("layouts/Down-the-Stack.json", () => {
  test("parses, and the layout name is one layout.switch accepts", () => {
    assert.ok(isObj(layout));
    assert.match(path.basename(LAYOUT_FILE, ".json"), /^[A-Za-z0-9_-]+$/);
  });

  test("herdr shows the file name as the layout's title: it names the game, never the codename", () => {
    // herdr has no display title for a layout: the palette builds `Layout: ${Cap(name)}`
    // (defaults/frame/palette/main.js:154-157), Settings and the macOS View > Layout menu show the
    // raw name (settings/main.js:316 `LOOKS[name] ?? name`, src/macos.rs:66-69).
    const files = fs.readdirSync(path.join(REPO, "layouts")).filter((f) => f.endsWith(".json"));
    assert.deepEqual(files, ["Down-the-Stack.json"]);
    for (const f of files) {
      const name = f.slice(0, -".json".length);
      const title = `Layout: ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      assert.doesNotMatch(name, /maple/i, `${f}: Settings would show "${name}"`);
      assert.doesNotMatch(title, /maple/i);
      assert.match(title, /Down-the-Stack/);
    }
  });

  test("matches herdr's layout schema (types, content, sizes, colors, root-only keys)", () => {
    assert.deepEqual(V.errors, []);
  });

  test("every node has a unique id", () => {
    assert.equal(new Set(V.ids).size, V.ids.length);
    assert.equal(V.ids.length, V.nodes.length + V.floats.length);
  });

  test("required ids are present", () => {
    for (const id of ["sidebar", "spaces", "party", "tabs", "main", "panel", "panel-body", "files", "changes", "stage", "status", "hud"]) {
      assert.ok(byId(id), `missing node "${id}"`);
    }
  });

  test("every referenced mod exists (shipped by herdr, or mods/down-the-stack)", () => {
    assert.ok(fs.existsSync(path.join(MOD_DIR, "mod.json")), "mods/down-the-stack/mod.json is missing");
    for (const m of V.mods) {
      const ok = m.name === MOD || SHIPPED_MODS.has(m.name) || m.name.startsWith("frame-");
      assert.ok(ok, `${m.where}: unknown mod "${m.name}"`);
    }
  });

  test("every down-the-stack block names a known role in an object props", () => {
    const ours = V.mods.filter((m) => m.name === MOD);
    assert.ok(ours.length >= 4);
    for (const m of ours) {
      assert.ok(isObj(m.props), `${m.where}: props must be an object (herdr replaces anything else by {})`);
      assert.ok(LAYOUT_ROLES.has(m.props.role), `${m.where}: unknown role ${JSON.stringify(m.props.role)}`);
    }
    const roles = ours.map((m) => m.props.role).sort();
    assert.deepEqual(roles, ["hud", "nameplate", "party", "stage"], "each role appears exactly once");
  });

  test("custom colors are mdr_ tokens defined at the root; theme colors are left to the person", () => {
    const colors = layout.colors ?? {};
    assert.ok(Object.keys(colors).length > 0);
    for (const [k, v] of Object.entries(colors)) {
      assert.match(k, /^mdr_[a-z0-9_]+$/, `${k}: custom tokens are prefixed mdr_`);
      assert.ok(!THEME_NAMES.has(k), `${k} would override the person's theme`);
      assert.match(v, HEX);
    }
    assert.equal(layout.theme, undefined, "no theme: the person's light/dark theme keeps driving herdr's chrome");
    // herdr's status colours stay herdr's (ux-glance-1): a layout colour beats the person's own
    // override (settings.rs:585-586 `colors.extend(look.colors)`) and is one value for light and
    // dark themes alike (the game's #F2A93B / #FFD447 are under 3:1 on the paper chrome), so
    // tabs, spaces and the status bar keep the person's working/blocked/done colours.
    for (const k of ["working", "blocked", "done", "idle", "unknown", "accent", "foreground", "background"]) assert.ok(!(k in colors), `${k} is the person's`);
    // D§11.1 / D§14.8 reserved meaning colours, exactly.
    const reserved = { mdr_working: "#4CC38A", mdr_blocked: "#F2A93B", mdr_done: "#FFD447", mdr_idle: "#8A8F98",
      mdr_xp: "#7FE9F5", mdr_fresh_eyes: "#A9B8FF", mdr_hp: "#FF5A5F", mdr_bubble: "#FFFFFF", mdr_bubble_ink: "#1B1B1F" };
    for (const [k, v] of Object.entries(reserved)) assert.equal(colors[k]?.toUpperCase(), v, k);
    // Every custom token is used by a node or kept for the mod (read as theme().mdr_*): no typos in nodes.
    const used = JSON.stringify(layout.children).match(/"mdr_[a-z0-9_]+"/g) ?? [];
    for (const u of used) assert.ok(JSON.parse(u) in colors, `${u} used but not defined`);
  });

  test("the window chrome works like main: titlebar, traffic lights, drag areas, sidebar fold", () => {
    assert.equal(layout.titlebar, "none");
    assert.deepEqual(layout.traffic_lights, [12, 16]);
    assert.equal(byId("brand").window_drag, true, "brand keeps window dragging");
    assert.equal(byId("tabs").window_drag, true, "the tab bar keeps window dragging (and draws window buttons)");
    assert.deepEqual(byId("brand").content, { mod: "workspace-chrome" });
    assert.deepEqual(byId("sidebar-footer").content, { mod: "workspace-chrome", props: { footer: true } });
    const sb = byId("sidebar");
    assert.equal(sb.type, "column");
    assert.deepEqual([sb.size, sb.min, sb.max, sb.resizable, sb.background], [{ px: 268 }, 44, 480, false, "chrome"]);
    assert.equal(parentOf("sidebar"), layout, "sidebar is a child of the root row (the root divider drags it)");
    assert.equal(layout.preview, "mods/down-the-stack/preview.svg");
  });

  test("the party replaces the shipped agents list inside the sidebar", () => {
    const party = byId("party");
    assert.equal(party.type, "block");
    assert.deepEqual(party.content, { mod: "down-the-stack", props: { role: "party" } });
    assert.equal(parentOf("party").id, "sidebar-lists");
    assert.ok(within("sidebar", "party"));
    assert.ok(!V.mods.some((m) => m.name === "agents"), "the agents list is replaced, not doubled");
    assert.equal(byId("spaces").content.mod, "spaces");
  });

  test("the pane header is the nameplate (role nameplate, 30–34 px, framed even when alone)", () => {
    const f = mainFrame();
    assert.equal(byId("main").content.tab, "active");
    assert.equal(f.lone, true);
    assert.equal(f.header.content.mod, MOD);
    assert.equal(f.header.content.props.role, "nameplate");
    assert.ok(!("pane" in f.header.content.props) && !("terminal" in f.header.content.props), "herdr sets pane/terminal itself");
    assert.ok(f.header.height >= 30 && f.header.height <= 34, `height ${f.header.height}`);
    assert.equal(f.header.position ?? "top", "top");
    assert.equal(f.header.reveal ?? "always", "always");
    assert.equal(f.focus.width, f.border.width, "equal widths, so focus never re-flows the terminal");
  });

  test("the stage spans the work column between the panes and the status bar", () => {
    const stage = byId("stage");
    assert.equal(stage.type, "block");
    assert.deepEqual(stage.content, { mod: "down-the-stack", props: { role: "stage" } });
    assert.deepEqual([stage.size, stage.min, stage.max], [{ px: 200 }, 64, 420]);
    assert.ok(!stage.hidden && !stage.window_drag, "shown, and clicks reach the mod instead of dragging the window");
    const work = parentOf("stage");
    assert.equal(work.id, "work");
    assert.equal(work.type, "column");
    const order = work.children.map((c) => c.id);
    assert.ok(order.indexOf("work-body") < order.indexOf("stage") && order.indexOf("stage") < order.indexOf("status"), order.join(","));
  });

  test("the hud is optional: present, hidden by default", () => {
    const hud = byId("hud");
    assert.deepEqual(hud.content, { mod: "down-the-stack", props: { role: "hud" } });
    assert.equal(hud.hidden, true);
    assert.equal(parentOf("hud").id, "work");
  });

  test("files/changes panel and status bar are kept as main has them", () => {
    const panel = byId("panel"), body = byId("panel-body");
    assert.equal(panel.hidden, true);
    assert.equal(body.type, "stack");
    assert.equal(body.active, "files");
    assert.deepEqual(body.children.map((c) => [c.id, c.content.mod]), [["files", "files"], ["changes", "changes"]]);
    assert.ok(within("work-body", "panel"));
    assert.equal(byId("status").content.mod, "workspace-status");
    assert.equal(byId("tabs").content.mod, "tabs");
  });

  test("differs from herdr's shipped main.json only by the Down the Stack changes", (t) => {
    const main = readJsonIfAny(path.join(HERDR, "defaults", "layouts", "main.json"));
    if (!main) return skipGate(t, "the layout against herdr's shipped main.json", herdrMissing());
    // Undo exactly the documented changes; what is left must be main, key for key.
    const undone = JSON.parse(JSON.stringify(layout));
    delete undone.preview;
    delete undone.colors;
    const find = (n, id) => (n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);
    const lists = find(undone, "sidebar-lists");
    lists.children = lists.children.map((c) => (c.id === "party" ? { id: "agents", type: "block", size: { weight: 1 }, min: 90, content: { mod: "agents" } } : c));
    find(undone, "main").content.pane.header = { content: { mod: "pane" }, height: 30, position: "top", reveal: "always" };
    const work = find(undone, "work");
    work.children = work.children.filter((c) => c.id !== "stage" && c.id !== "hud");
    assert.deepEqual(undone, main);
  });

  test("the validator itself catches the mistakes it exists for", () => {
    const bad = (mutate) => {
      const l = JSON.parse(JSON.stringify(layout));
      mutate(l, (id) => byId(id, l));
      return validateLayout(l).errors.join("\n");
    };
    assert.match(bad((l, f) => { f("stage").background = "mdr_nope"; }), /paints magenta/);
    assert.match(bad((l, f) => { f("stage").background = "#fff"; }), /paints magenta/);
    assert.match(bad((l) => { l.colors.mdr_x = "gold"; }), /not #rrggbb/);
    assert.match(bad((l, f) => { f("hud").id = "stage"; }), /duplicate id/);
    assert.match(bad((l, f) => { delete f("stage").id; }), /needs an id/);
    assert.match(bad((l, f) => { delete f("stage").content; }), /needs content/);
    assert.match(bad((l, f) => { f("stage").type = "panel"; }), /type must be/);
    assert.match(bad((l, f) => { f("stage").size = { px: 200, weight: 1 }; }), /size must be/);
    assert.match(bad((l, f) => { f("stage").size = { px: 500 }; }), /outside min\.\.max/);
    assert.match(bad((l, f) => { f("work").colors = { mdr_a: "#000000" }; }), /root only/);
    assert.match(bad((l, f) => { f("stage").contnet = {}; }), /unknown key "contnet"/);
    assert.match(bad((l, f) => { f("main").content.pane.header.reveal = "sometimes"; }), /reveal/);
    assert.match(bad((l, f) => { f("panel-body").active = "nope"; }), /not a child/);
    assert.match(bad((l, f) => { f("stage").content = { mod: 3 }; }), /no variant/);
  });

  test("the preview picture, when generated, is a 320×200 SVG without <text>", (t) => {
    const file = path.join(REPO, layout.preview);
    if (!fs.existsSync(file)) return skipGate(t, "the layout preview picture", `${layout.preview} not generated yet: npm run art`);
    const svg = fs.readFileSync(file, "utf8");
    assert.match(svg, /viewBox="0 0 320 200"/);
    assert.ok(!/<text[\s>]/.test(svg), "no <text>: fonts are not guaranteed in the SVG renderer");
  });
});

// ---------------------------------------------------------------------------------------------

describe("mods/down-the-stack/mod.json", () => {
  const manifest = readJson(path.join(MOD_DIR, "mod.json"));

  test('place is "none" (anything else docks a copy into the person\'s own layout)', () => {
    assert.ok(isObj(manifest));
    assert.equal(manifest.place, "none");
  });

  test("palette entries pass herdr's palette checks (frame/palette modEntry)", () => {
    assert.ok(Array.isArray(manifest.palette) && manifest.palette.length > 0);
    const ids = new Set(), titles = new Set();
    for (const p of manifest.palette) {
      assert.ok(isObj(p));
      assert.equal(typeof p.title, "string");
      assert.ok(p.title.trim(), "title must not be blank");
      assert.equal(typeof p.command, "string");
      const args = p.args ?? {};
      assert.ok(isObj(args), `${p.command}: args must be an object`);
      if ("group" in p) assert.notEqual(String(p.group).trim(), "Recent", "Recent is reserved");
      if ("words" in p) assert.equal(typeof p.words, "string");
      const known = APP_COMMANDS[p.command];
      if (known) {
        const names = known.map((a) => a.name);
        for (const k of Object.keys(args)) assert.ok(names.includes(k), `${p.command}: unknown argument ${k}`);
        for (const a of known) if (a.required) assert.ok(typeof args[a.name] === "string" && args[a.name].trim(), `${p.command}: ${a.name} required`);
      } else {
        // A mod command: "<this mod>.<command>", no arguments, handled by the mod (ARCHITECTURE §4).
        const [mod, cmd] = p.command.split(/\.(.*)/s);
        assert.equal(mod, MOD, `${p.command}: a mod's own commands start with "${MOD}."`);
        assert.ok(MOD_COMMANDS.has(cmd), `${p.command}: not a ${MOD} command`);
        assert.deepEqual(args, {}, `${p.command}: mod commands take no arguments`);
      }
      const id = `${p.command}:${JSON.stringify(args)}`;
      assert.ok(!ids.has(id), `duplicate entry ${id} (herdr skips it)`);
      assert.ok(!titles.has(p.title), `duplicate title ${p.title}`);
      ids.add(id); titles.add(p.title);
    }
  });

  test("every entry works from any layout: the Herd panel through mod.open, no <mod>.<command>", () => {
    // herdr lists every mod's palette entries in every layout (palette/main.js modPalettes), but
    // `<mod>.<command>` reaches shown copies only (mods.rs send_command): picked while another
    // layout shows, it fails with a "<mod>.<command> failed" toast (window.rs command_error).
    // mod.open is an app command that opens mod.json's "overlay" anywhere (window.rs "mod.open");
    // the palette keeps it only when its name is a mod folder with a main.js (modPalettes). The
    // sheet and calm mode stay in the Herd panel (Roster, Settings) and the layout's keys.
    const entries = Object.fromEntries(manifest.palette.map((p) => [p.title, [p.command, p.args ?? {}]]));
    assert.deepEqual(entries["Down the Stack: Herd panel"], ["mod.open", { name: MOD }]);
    assert.ok(fs.existsSync(path.join(REPO, "mods", MOD, "main.js")), "mod.open names this mod folder");
    for (const p of manifest.palette) {
      assert.ok(APP_COMMANDS[p.command], `${p.title}: ${p.command} reaches shown copies only (fails outside this layout)`);
      assert.notEqual(p.command, "layout.toggle", `${p.title}: names a node of this layout only`);
    }
    // what the Herd panel holds, so the palette finds it by these words too
    for (const w of ["roster", "settings", "sheet", "calm"]) assert.ok(manifest.palette[0].words.includes(w), w);
    assert.equal(manifest.overlay.props.role, "herd", "mod.open opens the Herd panel");
  });

  test("no entry duplicates one herdr's palette builds itself (herdr drops those silently)", () => {
    // palette/main.js:154-157 adds `layout.switch {name}` for every installed layout, and :173-180
    // skips a mod entry whose (command, args) is already there: a mod entry switching to this
    // layout would never show.
    for (const p of manifest.palette) assert.notEqual(p.command, "layout.switch", `${p.title}: herdr already lists every layout`);
  });
});

// ---------------------------------------------------------------------------------------------

/** "ctrl-shift-g" → "ctrl-shift-g" with modifiers sorted ("ctrl--" is ctrl + minus). */
function normKey(stroke) {
  const minus = stroke.endsWith("--");
  const parts = (minus ? stroke.slice(0, -2) : stroke).split("-");
  const key = minus ? "-" : parts.pop();
  return [...parts.map((m) => m.toLowerCase()).sort(), key.toLowerCase()].join("-");
}
const MODIFIERS = new Set(["ctrl", "alt", "shift", "cmd", "super", "win", "fn", "platform"]);

/**
 * herdr's app command table: src/commands.rs when the source is there (`cmd("name", &[req("a"),
 * opt("b")], …)`), else the copy of its generated docs/commands.md the mock uses. name → [{name, required}].
 */
const HERDR_COMMANDS = (() => {
  const out = new Map();
  let rs = null;
  try { rs = fs.readFileSync(path.join(HERDR, "src", "commands.rs"), "utf8"); } catch { rs = null; }
  if (rs) {
    for (const m of rs.matchAll(/\bcmd\("([^"]+)",\s*&\[([^\]]*)\]/g)) {
      out.set(m[1], [...m[2].matchAll(/\b(req|opt)\("([^"]+)"\)/g)].map((a) => ({ name: a[2], required: a[1] === "req" })));
    }
    return out;
  }
  for (const c of DOC_COMMANDS) out.set(c.name, c.args.map((a) => ({ name: a.name, required: a.required })));
  return out;
})();

/**
 * herdr 0.1.17's keys.json reader, src/keys.rs parse() (its first error rejects the whole file and
 * herdr keeps the defaults): the sections tab() accepts, string actions (gone_mod: a `<mod>.<cmd>`
 * whose mods/<mod> folder is missing is dropped silently; valid_action), the reserved escape hatch,
 * and object bindings (CommandBinding::command: only command/args, a real command, args an
 * object that validate_args accepts). Returns {problems, dropped, bindings: [{section, keys, action}]}.
 */
function readKeys(text, { commands = HERDR_COMMANDS, modDirs = new Set([MOD]) } = {}) {
  let sections;
  try { sections = JSON.parse(text); } catch (e) { return { problems: [`not JSON: ${e.message}`], dropped: [], bindings: [] }; }
  // serde: BTreeMap<String, BTreeMap<String, Binding>>, Binding = String | Map (untagged)
  if (!isObj(sections)) return { problems: ["keys.json must be an object of sections"], dropped: [], bindings: [] };
  for (const [sec, map] of Object.entries(sections)) {
    if (!isObj(map)) return { problems: [`${sec}: a section must be an object of key → action`], dropped: [], bindings: [] };
    for (const [k, a] of Object.entries(map)) if (typeof a !== "string" && !isObj(a)) return { problems: [`${sec}.${k}: an action is a string or an object`], dropped: [], bindings: [] };
  }
  const nameOf = (a) => (a.includes(":") ? a.slice(0, a.indexOf(":")) : a);
  const goneMod = (a) => {
    const n = nameOf(a);
    if (commands.has(n) || !n.includes(".")) return false;
    const m = n.slice(0, n.indexOf("."));
    // (mods_dir().join("") is mods/ itself, a folder: an empty mod part is never "gone")
    return m !== "" && !m.startsWith("frame-") && !modDirs.has(m);
  };
  const validAction = (a) => {
    const n = nameOf(a);
    const at = n.indexOf(".");
    return commands.has(n) || a === "terminal" || a.startsWith("send:") || (at > 0 && at < n.length - 1);
  };
  const problems = [], dropped = [], bindings = [];
  for (const [section, map] of Object.entries(sections)) {
    const mod = section.startsWith("mod:") ? section.slice(4) : null;
    const lay = section.startsWith("layout:") ? section.slice(7) : null;
    if (!(section === "global" || section === "terminal" || mod || lay)) {
      problems.push(`unknown section ${JSON.stringify(section)}: use "global", "terminal", "layout:<name>" or "mod:<name>"`);
      continue;
    }
    for (const [keys, action] of Object.entries(map)) {
      if (typeof action === "string") {
        if (goneMod(action)) { dropped.push(`${section}.${keys}`); continue; }
        if (!validAction(action)) { problems.push(`${section}.${keys}: unknown action ${JSON.stringify(action)}`); continue; }
      }
      if (keys === "ctrl-alt-shift-escape") { problems.push("ctrl-alt-shift-escape is reserved for resetting Herdr"); continue; }
      if (isObj(action)) {
        const extra = Object.keys(action).find((f) => f !== "command" && f !== "args");
        const spec = typeof action.command === "string" ? commands.get(action.command) : null;
        const args = action.args ?? {};
        if (extra) problems.push(`${section}.${keys}: unknown key binding field ${JSON.stringify(extra)}; use command and args`);
        else if (typeof action.command !== "string") problems.push(`${section}.${keys}: key binding command must be a string`);
        else if (!spec) problems.push(`${section}.${keys}: unknown key binding command ${JSON.stringify(action.command)}`);
        else if (!isObj(args)) problems.push(`${section}.${keys}: ${action.command}: key binding args must be an object`);
        else {
          const unknown = Object.keys(args).filter((k) => !spec.some((a) => a.name === k));
          if (unknown.length) problems.push(`${section}.${keys}: ${action.command}: unknown argument(s): ${unknown.join(", ")}`);
        }
      }
      bindings.push({ section, keys, action });
    }
  }
  return { problems, dropped, bindings };
}

describe("keys.json", () => {
  const keys = readJson(KEYS_FILE);
  const name = path.basename(LAYOUT_FILE, ".json");

  test(`has exactly one section, "layout:${name}" (unknown sections reject the whole keys.json)`, () => {
    assert.deepEqual(Object.keys(keys), [`layout:${name}`]);
    assert.ok(isObj(keys[`layout:${name}`]));
  });

  test("keys are well formed and leave terminal programs their usual keys", () => {
    for (const k of Object.keys(keys[`layout:${name}`])) {
      assert.ok(!/\s/.test(k), `${k}: one keystroke, no chords`);
      const parts = normKey(k).split("-");
      const key = parts.pop();
      for (const m of parts) assert.ok(MODIFIERS.has(m), `${k}: unknown modifier ${m}`);
      assert.ok(key.length > 0);
      assert.notEqual(normKey(k), normKey("ctrl-alt-shift-escape"), "reserved escape hatch");
      if (parts.includes("ctrl") && parts.length === 1) assert.fail(`${k}: plain ctrl+key belongs to the program`);
      assert.ok(!(parts.length === 1 && parts[0] === "alt"), `${k}: alt+key is readline's (word moves) and AltGr's`);
      assert.notEqual(normKey(k), normKey("ctrl-shift-u"), "ctrl-shift-u is IBus/GTK Unicode entry");
      // Legacy terminals send ctrl-shift-X as ctrl-X: keep away from the control characters that
      // stand for Backspace, Tab, Enter, newline and Escape.
      if (parts.includes("ctrl")) assert.ok(!["h", "i", "j", "m", "["].includes(key), `${k}: aliases a terminal control character`);
    }
  });

  test("no key collides with herdr's defaults (keys.json and keys.macos.json, any section)", () => {
    const taken = new Set([...DEFAULT_KEYS].map(normKey));
    for (const k of Object.keys(keys[`layout:${name}`])) assert.ok(!taken.has(normKey(k)), `${k} is a herdr default`);
  });

  test("actions are valid: layout toggles of real nodes, or the mod's own commands (this layout's section only)", () => {
    // `<mod>.<command>` reaches shown copies only: bound in this layout's section it fires only
    // while this layout (and so a copy of the mod) shows.
    assert.deepEqual(Object.keys(keys), [`layout:${name}`]);
    for (const [k, action] of Object.entries(keys[`layout:${name}`])) {
      assert.equal(typeof action, "string", `${k}: string actions only`);
      const [cmd, value] = action.split(/:(.*)/s);
      if (APP_COMMANDS[cmd]) {
        assert.ok(["layout.toggle", "layout.show", "layout.hide"].includes(cmd), `${k}: unexpected app command ${cmd}`);
        assert.ok(byId(value), `${k}: no node "${value}" in the layout`);
        assert.ok(!["sidebar", "panel"].includes(value), `${k}: herdr already binds that toggle`);
      } else {
        // not an app command: herdr hands the mod everything after the first '.' (window.rs run_as),
        // "stage:show" included, so the whole tail must be a command main.js handles
        assert.ok(action.startsWith(`${MOD}.`), `${k}: unknown action ${action}`);
        assert.ok(MOD_COMMANDS.has(action.slice(MOD.length + 1)), `${k}: ${action} is not a ${MOD} command`);
      }
    }
  });

  test("is the file herdr's install flow merges: keys.json at the repo's root (keys.example.json is gone)", () => {
    // defaults/AGENTS.md "Layouts and mods other people made": an installing agent merges a
    // keys.json it finds next to the layouts and mods; a keys.example.json it skips
    assert.ok(fs.existsSync(KEYS_FILE));
    assert.ok(!fs.existsSync(path.join(REPO, "keys.example.json")), "one keys file, under the name herdr's install flow reads");
  });

  test("herdr's keys.rs reads it without a problem and drops no binding; only the layout:Down-the-Stack section", () => {
    const r = readKeys(fs.readFileSync(KEYS_FILE, "utf8"));
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.dropped, [], "a <mod>.<command> whose mod folder is missing is bound to nothing");
    assert.deepEqual([...new Set(r.bindings.map((b) => b.section))], [`layout:${name}`]);
    assert.equal(r.bindings.length, Object.keys(keys[`layout:${name}`]).length);
  });

  test("every action names a real command: herdr's (with a valid shorthand argument) or one main.js handles", () => {
    for (const { keys: k, action } of readKeys(fs.readFileSync(KEYS_FILE, "utf8")).bindings) {
      assert.equal(typeof action, "string", k);
      const colon = action.indexOf(":");
      const head = colon < 0 ? action : action.slice(0, colon);
      const spec = HERDR_COMMANDS.get(head);
      if (spec) {
        // commands::shorthand: the value fills the first argument; run_as refuses one for a
        // command without arguments, and commands::missing a required one left empty
        assert.ok(spec.length > 0, `${k}: ${head} takes no shorthand argument`);
        const args = colon < 0 ? {} : { [spec[0].name]: action.slice(colon + 1) };
        for (const a of spec) if (a.required) assert.ok(typeof args[a.name] === "string" && args[a.name].trim(), `${k}: ${head} needs ${a.name}`);
        if (head.startsWith("layout.") && args.id) assert.ok(byId(args.id), `${k}: no node "${args.id}" in the layout`);
      } else {
        // `<mod>.<command>`: herdr hands the mod everything after the first '.' (mods::send_command)
        const at = action.indexOf(".");
        assert.equal(action.slice(0, at), MOD, `${k}: ${action}`);
        assert.ok(MOD_COMMANDS.has(action.slice(at + 1)), `${k}: main.js handles no "${action.slice(at + 1)}" (HOTKEYS)`);
      }
    }
  });

  test("the keys.rs reader catches the mistakes herdr rejects or drops", () => {
    const one = (section, action) => readKeys(JSON.stringify({ [section]: { "ctrl-shift-g": action } }));
    assert.deepEqual(one(`layout:${name}`, "layout.toggle:stage").problems, []);
    assert.match(one("layout:", "layout.toggle:stage").problems.join(), /unknown section/);
    assert.match(one("layouts:x", "layout.toggle:stage").problems.join(), /unknown section/);
    assert.match(one(`layout:${name}`, "toggle-stage").problems.join(), /unknown action/);
    assert.match(one(`layout:${name}`, ".sheet").problems.join(), /unknown action/);
    assert.deepEqual(one(`layout:${name}`, "not-installed.sheet").dropped, [`layout:${name}.ctrl-shift-g`]);
    assert.deepEqual(one(`layout:${name}`, `${MOD}.stage:show`).problems, []);
    assert.match(readKeys(JSON.stringify({ global: { "ctrl-alt-shift-escape": "app.help" } })).problems.join(), /reserved/);
    assert.match(one("global", { command: "layout.resize", args: { typo: 1 } }).problems.join(), /unknown argument/);
    assert.match(one("global", { command: "layout.nope" }).problems.join(), /unknown key binding command/);
    assert.match(one("global", { command: "layout.resize", why: 1 }).problems.join(), /unknown key binding field/);
    assert.match(readKeys(JSON.stringify({ global: { k: 3 } })).problems.join(), /string or an object/);
    assert.match(readKeys("{").problems.join(), /not JSON/);
  });

  test("binds the stage toggle and the character sheet", () => {
    const actions = Object.values(keys[`layout:${name}`]);
    assert.ok(actions.includes("layout.toggle:stage"));
    assert.ok(actions.includes("down-the-stack.sheet"));
  });
});

// ---------------------------------------------------------------------------------------------

describe("the mod folder name (herdr shows it to players)", () => {
  const manifest = readJson(path.join(MOD_DIR, "mod.json"));
  const keys = readJson(KEYS_FILE);
  const ids = [
    ...manifest.palette.map((p) => p.command).filter((c) => !APP_COMMANDS[c]),
    ...Object.values(Object.values(keys)[0]).filter((a) => !APP_COMMANDS[a.split(/:(.*)/s)[0]]),
  ];

  test("is the only mod folder, and a name herdr accepts and splits back out of a command id", () => {
    const dirs = fs.readdirSync(path.join(REPO, "mods")).filter((n) => fs.statSync(path.join(REPO, "mods", n)).isDirectory());
    assert.deepEqual(dirs, [MOD]);
    // src/mods.rs valid_name: letters, digits, '-' and '_' (mod.clone and layout.clone refuse others)
    assert.match(MOD, /^[A-Za-z0-9_-]+$/);
    // lower case like herdr's own folders (machine-add, terminals-bar, workspace-chrome); no '.' or
    // ':', which the command parsers split on
    assert.match(MOD, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(!SHIPPED_MODS.has(MOD), "a shipped mod's name would collide with herdr's own folder");
  });

  test("every <mod>.<command> id parses back to this mod the way herdr parses it", () => {
    assert.ok(ids.length >= 3, ids.join(", "));
    // and the palette's mod.open names this folder (palette/main.js modPalettes drops one that does not)
    for (const p of manifest.palette.filter((e) => e.command === "mod.open")) assert.equal(p.args.name, MOD);
    for (const id of ids) {
      // window.rs run_as: `name:value` shorthand only when the part before ':' is an app command
      // (commands::find), then a mod's `<mod>.<command>` (split_once('.')) → mods::send_command(m, c)
      const colon = id.indexOf(":");
      assert.ok(colon < 0 || !APP_COMMANDS[id.slice(0, colon)], `${id}: would be read as an app command's name:value`);
      const at = id.indexOf(".");
      const [m, c] = [id.slice(0, at), id.slice(at + 1)];
      assert.equal(m, MOD, id);
      assert.ok(MOD_COMMANDS.has(c), id);
      // keys.rs valid_action / gone_mod: non-empty halves, and mods/<m> must be a folder
      assert.ok(m && c && fs.statSync(path.join(REPO, "mods", m)).isDirectory(), id);
      // frame/palette/main.js modEntry: the prefix before the first '.' is the entry's own mod
      assert.equal(id.slice(0, id.indexOf(".")), MOD, id);
    }
  });

  test("never says maple where herdr prints it (Keys overlay, toasts, did-not-load, palette)", () => {
    // defaults/mods/help/main.js label(): the action with '.' and '_' read as spaces
    const keysLabel = (action) => action.split(":")[0].replace(/[._]/g, " ");
    assert.equal(keysLabel(`${MOD}.sheet`), "down-the-stack sheet");
    const shown = [
      MOD,
      ...ids.map(keysLabel),
      ...ids.map((id) => `${id} failed`),                       // window.rs command_error toast title
      `${MOD}.tick failed`,
      `${MOD} did not load:`,                                    // window.rs mod error panel
      `no mod folder ~/.config/herdr-app/mods/${MOD}`,
      ...manifest.palette.map((p) => `${p.group ?? ""} ${p.title} ${p.words ?? ""} ${MOD}`), // palette row and search words
      layout.preview,
      ...Object.keys(keys),                                      // keys overlay section "(layout:…)"
    ];
    for (const s of shown) assert.doesNotMatch(s, /maple/i, s);
  });

  test("the spellings herdr and mod.clone rely on all name this folder", () => {
    // ARCHITECTURE §2.9: one spelling per form clone_mod_at rewrites (src/mods.rs:247-257)
    const host = fs.readFileSync(path.join(MOD_DIR, "host.js"), "utf8");
    const kit = fs.readFileSync(path.join(MOD_DIR, "ui", "kit.js"), "utf8");
    assert.match(host, new RegExp(`^const SELF = \\{ mod: "${MOD}" \\};$`, "m"));
    assert.match(kit, new RegExp(`^export const ASSETS = "mods/${MOD}";$`, "m"));
    assert.ok(layout.preview.startsWith(`mods/${MOD}/`), layout.preview);
    const ours = V.mods.filter((m) => m.name === MOD);
    assert.equal(ours.length, 4, "stage, party, nameplate, hud");
    for (const file of [LAYOUT_FILE, path.join(MOD_DIR, "mod.json"), KEYS_FILE]) {
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /maple/i, path.relative(REPO, file));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Licences (round 4, L5) and the repository's name (L4)

describe("licences and names", () => {
  const read = (...rel) => fs.readFileSync(path.join(REPO, ...rel), "utf8");
  const MIT_START = "MIT License\n\nCopyright (c) 2026 Tyler Coles\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";

  test("the repository and the mod folder (what people install) carry the MIT licence", () => {
    for (const rel of [["LICENSE"], ["mods", MOD, "LICENSE"]]) {
      const text = read(...rel);
      assert.ok(text.startsWith(MIT_START), `${rel.join("/")}: the standard MIT text with its copyright line`);
      assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
    }
    assert.equal(read("mods", MOD, "LICENSE"), read("LICENSE"), "the same text in both");
    assert.equal(readJson(path.join(REPO, "package.json")).license, "MIT");
  });

  test("the mod folder credits what it adapts from herdr-app under Apache-2.0, with the licence beside it", () => {
    const apache = read("mods", MOD, "LICENSE-APACHE-2.0");
    assert.equal(apache, read("tools", "mock", "LICENSE-APACHE-2.0"));
    assert.match(apache, /Apache License\s+Version 2\.0, January 2004/);
    const notice = read("mods", MOD, "NOTICE");
    assert.match(notice, /herdr-app 0\.1\.17/);
    assert.match(notice, /LICENSE-APACHE-2\.0 in this\s+folder/);
    // every adapted part, under the file that holds it (and that file exists)
    for (const [file, origin] of [
      ["game/agents.js", "defaults/mods/agents/main.js"], ["ui/party.js", "defaults/mods/agents/main.js"],
      ["ui/nameplate.js", "defaults/mods/pane/main.js"], ["ui/nameplate.js", "defaults/mods/peek/main.js"],
      ["host.js", "defaults/mods/agents/main.js"],
      ["game/view/chrome.js", "defaults/programs.json"], ["layouts/Down-the-Stack.json", "defaults/layouts/main.json"],
    ]) {
      const at = notice.indexOf(`\n${file}\n`);
      assert.ok(at >= 0, `NOTICE names ${file}`);
      const block = notice.slice(at, notice.indexOf("\n\n", at + 1));
      assert.ok(block.includes(origin), `${file}: from ${origin}`);
      assert.ok(fs.existsSync(file.startsWith("layouts/") ? path.join(REPO, file) : path.join(MOD_DIR, file)), file);
    }
    // tools/mock no longer claims the whole repository is the project's own work
    const mockNotice = read("tools", "mock", "NOTICE");
    assert.doesNotMatch(mockNotice, /Everything else in this repository is the project's own work/);
    assert.match(mockNotice, /mods\/down-the-stack\/NOTICE/);
  });

  test("the NOTICE's verbatim parts are herdr's: TITLE_MARK is the clean() regex of the agents list", (t) => {
    const agents = fs.readFileSync(path.join(MOD_DIR, "game", "agents.js"), "utf8");
    const mark = /^const TITLE_MARK = (\/.+\/u);$/m.exec(agents);
    assert.ok(mark, "game/agents.js TITLE_MARK");
    const file = path.join(HERDR, "defaults", "mods", "agents", "main.js");
    if (!herdrSource() || !fs.existsSync(file)) return skipGate(t, "TITLE_MARK against herdr's defaults/mods/agents/main.js", herdrMissing());
    assert.ok(fs.readFileSync(file, "utf8").includes(`.replace(${mark[1]}, "")`), "herdr's clean() regex, unchanged");
  });

  test("package.json and its lock carry the repository's name (tyevco/down-the-stack)", () => {
    const pkg = readJson(path.join(REPO, "package.json"));
    const lock = readJson(path.join(REPO, "package-lock.json"));
    assert.equal(pkg.name, "down-the-stack");
    assert.equal(lock.name, pkg.name);
    assert.equal(lock.packages[""].name, pkg.name);
  });

  test("herdr's source tree is there for the gates that read it (else the shipped lists above are 0.1.17 snapshots)", (t) => {
    if (!herdrSource()) return skipGate(t, "layout, keys and palette checks against herdr's own source", herdrMissing());
    assert.ok(fs.existsSync(path.join(HERDR, "src", "keys.rs")));
    assert.ok(fs.existsSync(path.join(HERDR, "src", "commands.rs")));
    // the docs copy the mock and the snapshots use is the source's command table
    const rs = [...fs.readFileSync(path.join(HERDR, "src", "commands.rs"), "utf8").matchAll(/\bcmd\("([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(DOC_COMMANDS.map((c) => c.name).sort(), rs, "tools/mock/herdr-commands.md is herdr's command table");
    for (const m of SHIPPED_MODS_SNAPSHOT) assert.ok(SHIPPED_MODS.has(m), `${m}: in the snapshot, not in herdr's defaults/mods`);
  });
});
