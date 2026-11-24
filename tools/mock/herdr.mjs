// Mock of herdr's "herdr" module: exactly the exports of tools/mock/herdr.d.ts, nothing else
// (a mod importing a name herdr lacks must fail here too). Live data comes from the fixture
// (state.mjs setFixture); host effects are recorded in S.calls for tests.
//
// Strictness beyond herdr (reported, not thrown, unless herdr itself throws):
//  - any host call while a mod's module top level is evaluating (ARCHITECTURE §2.1)
//  - writeTextFile while checking(), or under mods/ (hot-reloads the mod)
//  - run() with an unknown command or a missing required argument (herdr fails later, silently)
//  - run("<mod>.<command>") with no shown copy of that mod (herdr shows a "<cmd> failed" toast)
//
// Fixture hooks for IO trouble (tests): fixture().readError?.(absPath) → an Error (or message) makes
// that readTextFile reject; fixture().hangAfterWrite?.(absPath) → true makes that writeTextFile
// land on disk but never settle (herdr: the calling copy went away while the write ran).

import path from "node:path";
import { S, als, report, fixture, deliver } from "./state.mjs";
import { memfs } from "./memfs.mjs";
import { APP_HOME, USER_HOME } from "./config.mjs";
import { COMMANDS, COMMAND_BY_NAME, APP_NAMESPACES, validateArgs, missingArg } from "./herdr-commands.mjs";
import { resolveTheme, THEME_NAMES, isLightTheme } from "./theme.mjs";

const MAX_TEXT = 1024 * 1024;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Every host call goes through here: top-level detection and live-read tracking. */
function host(name, liveKey) {
  const copy = als.getStore();
  if (S.evaluating && !copy) {
    report("error", "top-level-herdr", `herdr \`${name}()\` was called at module top level; host calls belong in init, callbacks and timers (ARCHITECTURE §2.1)`, { copy: S.lastCopy });
  }
  const c = copy ?? S.lastCopy;
  if (liveKey && c) c.liveReads.add(liveKey);
  return c;
}

const never = () => new Promise(() => {});

// ---- process / files

export function exec(command, args = [], options = {}) {
  const c = host("exec");
  S.calls.exec.push({ command, args, options, copy: c?.label });
  if (S.checking) report("warning", "exec-in-check", `exec("${command}") runs for real during \`herdr-app check\`; guard it with checking()`, { copy: c });
  const fx = fixture().exec;
  return Promise.resolve(fx ? fx(command, args, options) : { code: 0, stdout: "", stderr: "" });
}

export function hc(args) {
  const c = host("hc");
  S.calls.hc.push({ args, copy: c?.label });
  return Promise.resolve({ code: 0, stdout: "", stderr: "" });
}

export function home() { host("home"); return USER_HOME; }
export function appHome() { host("appHome"); return APP_HOME; }
export function checking() { host("checking"); return S.checking; }

function absolute(p, api, c) {
  if (typeof p !== "string") throw new TypeError(`${api}(path) expects a string path`);
  if (!p.startsWith("/")) report("warning", "relative-path", `${api}("${p}"): a relative path resolves against the process cwd in herdr; build paths from appHome()`, { copy: c });
  return path.posix.resolve(USER_HOME, p);
}

export function readTextFile(p, options) {
  const c = host("readTextFile");
  const abs = absolute(p, "readTextFile", c);
  S.calls.readTextFile.push({ path: abs, copy: c?.label });
  // In `herdr-app check` host async results never come back (the process exits first).
  if (S.checking) return never();
  const fail = typeof fixture().readError === "function" ? fixture().readError(abs) : null;
  if (fail) return Promise.reject(fail instanceof Error ? fail : new Error(String(fail)));
  const text = memfs.readText(abs);
  if (text !== undefined && Buffer.byteLength(text) > MAX_TEXT) return Promise.reject(new Error(`readTextFile: ${abs} is larger than 1 MiB`));
  return Promise.resolve(text === undefined ? null : text);
}

export function writeTextFile(p, text, expected) {
  const c = host("writeTextFile");
  const abs = absolute(p, "writeTextFile", c);
  S.calls.writeTextFile.push({ path: abs, text, expected, copy: c?.label });
  if (typeof text !== "string") return Promise.reject(new TypeError("writeTextFile(path, text, expected): text must be a string"));
  if (expected !== null && typeof expected !== "string") return Promise.reject(new TypeError("writeTextFile(path, text, expected): expected must be the file's current text or null"));
  if (S.checking) report("error", "write-in-check", `writeTextFile("${abs}") during \`herdr-app check\` writes for real; guard IO with checking() (ARCHITECTURE §2.6)`, { copy: c });
  if (abs.startsWith(APP_HOME + "/mods/")) report("error", "write-under-mods", `writeTextFile("${abs}") writes inside mods/, which hot-reloads the mod; save under appHome()/data/ instead`, { copy: c });
  if (Buffer.byteLength(text) > MAX_TEXT) return Promise.reject(new Error(`writeTextFile: text is larger than 1 MiB`));
  const current = memfs.readText(abs);
  if (expected === null) {
    if (current !== undefined) return Promise.reject(new Error(`writeTextFile: ${abs} already exists (expected null creates a new file only)`));
  } else if (current !== expected) {
    return Promise.reject(new Error("The file changed outside Herdr. Reload before saving; your draft is still here."));
  }
  memfs.write(abs, text, { mkdirs: true });
  if (typeof fixture().hangAfterWrite === "function" && fixture().hangAfterWrite(abs)) return never();
  return Promise.resolve(null);
}

export function knownAgents(options) { host("knownAgents"); return Promise.resolve(clone(fixture().knownAgents ?? [])); }
export function pickFolder(options) { host("pickFolder"); return Promise.resolve(null); }
export function pickFiles(options) { host("pickFiles"); return Promise.resolve(null); }

export function playSound(sound) {
  const c = host("playSound");
  S.calls.playSound.push({ sound, copy: c?.label });
  report("warning", "sound", `playSound("${sound}"): no sound by default (D§11.15, ARCHITECTURE §2.15)`, { copy: c });
  return null;
}

// ---- commands

export function run(name, args) {
  const c = host("run");
  if (typeof name !== "string") throw new TypeError("run(name, args) expects a command name string");
  const command = COMMAND_BY_NAME.get(name);
  S.calls.run.push({ name, args: clone(args) ?? null, copy: c?.label });
  if (command) {
    validateArgs(command, args); // herdr throws these synchronously
    const missing = missingArg(command, args);
    if (missing) report("error", "bad-command", `run("${name}"): required argument \`${missing}\` is missing (herdr fails the command when it runs)`, { copy: c });
    return null;
  }
  const dot = name.indexOf(".");
  const ns = dot > 0 ? name.slice(0, dot) : "";
  const sub = dot > 0 ? name.slice(dot + 1) : "";
  if (!ns || !sub || APP_NAMESPACES.has(ns)) {
    report("error", "bad-command", `run("${name}"): unknown command (not in herdr's command table, and not "<mod>.<command>")`, { copy: c });
    return null;
  }
  // "<mod>.<command>": delivered to every shown copy's nextCommand() (never during check). herdr
  // skips hidden copies (src/mods.rs send_command: SHOWN_COPIES) and, when none listens, answers
  // `unknown command` and shows an error toast (window.rs run → command_error).
  if (S.checking) return null;
  const targets = S.copies.filter((k) => k.alive && k.modName === ns && !k.hidden);
  if (!targets.length) {
    S.calls.toasts.push({ title: `${name} failed`, copy: c?.label });
    report("error", "no-mod-copy", `run("${name}"): no copy of mod "${ns}" is shown; herdr would show an error toast "${name} failed"`, { copy: c });
  }
  for (const k of targets) deliver(k, sub);
  return null;
}

export function nextCommand() {
  const c = host("nextCommand");
  if (!c || S.checking) return never();
  if (c.queue.length) return Promise.resolve(c.queue.shift());
  return new Promise((resolve) => c.waiters.push(resolve));
}

export function commands() {
  host("commands");
  return COMMANDS.map((c) => ({ name: c.name, args: c.args.map((a) => ({ ...a })), about: c.about }));
}

// ---- live data

const live = (key, fallback) => () => {
  host(key, key);
  const v = fixture()[key];
  return clone(v ?? fallback);
};

export const machines = live("machines", []);
export const spaces = live("spaces", []);
export const agents = live("agents", []);
export const panes = live("panes", []);
export const terminals = live("terminals", []);
export function focused() { host("focused", "focused"); return clone(fixture().focused ?? null); }
export function layout() { host("layout", "layout"); return clone(fixture().layout ?? null); }
export function layouts() { host("layouts"); return clone(fixture().layouts ?? []); }
export function window() { host("window", "window"); return clone(fixture().window ?? null); }
export function placement() { host("placement", "floats"); return clone(fixture().placement ?? null); }

export function setAgentOrder(addresses) {
  const c = host("setAgentOrder");
  const list = Array.isArray(addresses) ? addresses.map(String) : [];
  S.agentOrder = list;
  S.calls.setAgentOrder.push({ addresses: list, copy: c?.label });
  return null;
}

export function setWindowTitle(title) {
  const c = host("setWindowTitle");
  if (title !== null && title !== undefined && typeof title !== "string") throw new TypeError("setWindowTitle(title) expects a string or null");
  S.calls.setWindowTitle.push({ title: title ?? null, copy: c?.label });
  return null;
}

export function setBadge(text) {
  const c = host("setBadge");
  if (text !== null && text !== undefined && typeof text !== "string") throw new TypeError("setBadge(text) expects a string or null");
  S.calls.setBadge.push({ text: text ?? null, copy: c?.label });
  return null;
}

export function theme() { host("theme"); return { ...(fixture().theme ?? resolveTheme("graphite")) }; }
export function themes() {
  host("themes");
  return THEME_NAMES.map((name) => ({ name, light: isLightTheme(name), colors: resolveTheme(name) }));
}
export function fonts() { host("fonts"); return [...(fixture().fonts ?? [])]; }
export function settings() { host("settings"); return clone(fixture().settings); }
export function keys() { host("keys"); return clone(fixture().keys ?? []); }

export function updates() {
  host("updates");
  return {
    app: { version: "0.1.17", ready: null, updates: true },
    notes: [],
    core: { version: "0.1.17", managed: null, ready: null, updating: false, error: null },
    checked: null, checks: true, checking: false,
  };
}
export function presentUpdateNotes(versions) { const c = host("presentUpdateNotes"); S.calls.presentUpdateNotes.push({ versions, copy: c?.label }); return null; }
export function telemetry() { host("telemetry"); return null; }

// Feedback is frame-only in herdr; the mock answers inertly.
export function feedbackPreview(message, email, images) { host("feedbackPreview"); return { body: null, available: false }; }
export function feedbackPasteImage() { host("feedbackPasteImage"); return null; }
export function feedbackPickImages() { host("feedbackPickImages"); return Promise.resolve([]); }
export function feedbackAttachImages(paths) { host("feedbackAttachImages"); return []; }
export function feedbackClearImages() { host("feedbackClearImages"); return null; }
export function sendFeedback(body, images) { host("sendFeedback"); return Promise.resolve(null); }

// ---- overlays / notifications

export function openOverlay(spec) {
  const c = host("openOverlay");
  if (!spec || typeof spec !== "object" || (!spec.mod && !spec.layout)) {
    throw new TypeError("openOverlay(spec) needs `mod` or `layout`");
  }
  const id = `o${++S.ids.overlay}`;
  S.calls.openOverlay.push({ id, spec: clone(spec), copy: c?.label });
  return id;
}

export function closeOverlay(id) {
  const c = host("closeOverlay");
  S.calls.closeOverlay.push({ id, copy: c?.label });
  return null;
}

export function notify(n) {
  const c = host("notify");
  if (!n || typeof n.title !== "string") throw new TypeError("notify(n) needs a string title");
  if (n.level && !["info", "success", "warning", "error"].includes(n.level)) throw new TypeError(`notify: level must be info, success, warning or error`);
  if (n.action) {
    const cmd = COMMAND_BY_NAME.get(n.action.name);
    if (cmd) validateArgs(cmd, n.action.args);
  }
  const id = `n${++S.ids.notify}`;
  S.calls.notify.push({ id, n: clone(n), copy: c?.label });
  return id;
}

// ---- props / shared

export function props() {
  const c = host("props");
  if (S.checking) return null;
  return clone(c ? c.props : fixture().props ?? null);
}

export function shared(key) {
  host("shared");
  if (S.checking) return null;
  return clone(S.shared.get(key) ?? null);
}

export function setShared(key, value) {
  const c = host("setShared");
  if (S.phase === "render") report("error", "setshared-in-render", `setShared("${key}") during render re-renders every copy of every mod: a render loop`, { copy: c });
  S.calls.setShared.push({ key, value: clone(value), copy: c?.label });
  const before = JSON.stringify(S.shared.get(key) ?? null);
  S.shared.set(key, clone(value));
  if (before !== JSON.stringify(value ?? null)) for (const k of S.copies) k.dirty = true;
  return null;
}

export function watchFolder(p) {
  const c = host("watchFolder");
  S.calls.watchFolder.push({ path: p, copy: c?.label });
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  promise.cancel = () => resolve([]);
  return promise;
}
