// QuickJS-compatible stand-in for herdr's "herdr" module (the names the mod imports, plus a few
// neighbours), driven by a fixture the harness sets through __ctl. Semantics follow
// tools/mock/herdr.mjs (itself built from herdr's source): live reads return fresh copies, IO is
// promise-based with the expected-text discipline, checking() makes reads never resolve and
// props() null.

const S = {
  fixture: {},
  checking: false,
  props: null,
  files: new Map(),
  calls: { run: 0, tick: 0, openOverlay: 0, closeOverlay: 0, setAgentOrder: 0, setShared: 0, writeTextFile: 0, readTextFile: 0, writes: [] },
  shared: new Map(),
  overlay: 0,
};
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const never = () => new Promise(() => {});

export const __ctl = {
  S,
  setFixture(f) { S.fixture = f || {}; },
  setChecking(on) { S.checking = !!on; },
  setProps(p) { S.props = p == null ? null : p; },
  resetCalls() { S.calls = { run: 0, tick: 0, openOverlay: 0, closeOverlay: 0, setAgentOrder: 0, setShared: 0, writeTextFile: 0, readTextFile: 0, writes: [] }; },
};

export function props() { return S.checking ? null : clone(S.props); }
export function checking() { return S.checking; }
export function appHome() { return "/mock/home"; }
export function home() { return "/mock/user"; }

export function readTextFile(p) {
  S.calls.readTextFile++;
  if (typeof p !== "string") throw new TypeError("readTextFile(path) expects a string path");
  if (S.checking) return never();
  const t = S.files.get(p);
  if (t !== undefined && t.length > 1024 * 1024) return Promise.reject(new Error(`readTextFile: ${p} is larger than 1 MiB`));
  return Promise.resolve(t === undefined ? null : t);
}

export function writeTextFile(p, text, expected) {
  S.calls.writeTextFile++;
  if (typeof text !== "string") return Promise.reject(new TypeError("text must be a string"));
  if (expected !== null && typeof expected !== "string") return Promise.reject(new TypeError("expected must be the file's current text or null"));
  if (text.length > 1024 * 1024) return Promise.reject(new Error("writeTextFile: text is larger than 1 MiB"));
  const cur = S.files.get(p);
  if (expected === null) {
    if (cur !== undefined) return Promise.reject(new Error(`writeTextFile: ${p} already exists`));
  } else if (cur !== expected) {
    return Promise.reject(new Error("The file changed outside Herdr. Reload before saving; your draft is still here."));
  }
  S.files.set(p, text);
  S.calls.writes.push({ path: p, bytes: text.length });
  if (S.calls.writes.length > 50) S.calls.writes.shift();
  return Promise.resolve(null);
}

export function run(name, args) {
  if (typeof name !== "string") throw new TypeError("run(name, args) expects a command name string");
  S.calls.run++;
  if (name === "mapledr.tick") S.calls.tick++;
  return null;
}
export function nextCommand() { return never(); }
export function openOverlay(spec) {
  if (!spec || typeof spec !== "object" || (!spec.mod && !spec.layout)) throw new TypeError("openOverlay(spec) needs `mod` or `layout`");
  S.calls.openOverlay++;
  return `o${++S.overlay}`;
}
export function closeOverlay(id) { S.calls.closeOverlay++; return null; }
export function setAgentOrder(list) { S.calls.setAgentOrder++; return null; }
export function shared(key) { return S.checking ? null : clone(S.shared.has(key) ? S.shared.get(key) : null); }
export function setShared(key, value) { S.calls.setShared++; S.shared.set(key, clone(value)); return null; }
export function notify(n) { return "n1"; }
export function playSound() { return null; }

const live = (key, fallback) => () => {
  const v = S.fixture[key];
  return clone(v == null ? fallback : v);
};
export const agents = live("agents", []);
export const panes = live("panes", []);
export const terminals = live("terminals", []);
export const spaces = live("spaces", []);
export const machines = live("machines", []);
export function focused() { return clone(S.fixture.focused == null ? null : S.fixture.focused); }
export function layout() { return clone(S.fixture.layout == null ? null : S.fixture.layout); }
export function window() { return clone(S.fixture.window == null ? null : S.fixture.window); }
export function placement() { return clone(S.fixture.placement == null ? null : S.fixture.placement); }
export function theme() { return Object.assign({}, S.fixture.theme || {}); }
export function settings() { return clone(S.fixture.settings || {}); }
export function fonts() { return (S.fixture.fonts || []).slice(); }
export function keys() { return clone(S.fixture.keys || []); }
