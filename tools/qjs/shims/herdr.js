// QuickJS-compatible stand-in for herdr's "herdr" module (the names the mod imports, plus a few
// neighbours), driven by a fixture the harness sets through __ctl. Semantics follow
// tools/mock/herdr.mjs (itself built from herdr's source): live reads return fresh copies, IO is
// promise-based with the expected-text discipline, checking() makes reads never resolve and
// props() null.
//
// Host async calls and builds (the reload phase): herdr runs readTextFile / writeTextFile as tasks
// of the calling frame's build (host_modules.rs host_async_call → scheduler awaiting_cancellable).
// Releasing that build (a hot reload, watch.rs reload → release_application_generation) cancels
// them: the work may have happened, but the continuation never runs. The driver names the frame
// (__ctl.setFrame(copy), the copy whose callback runs); a released copy's calls never settle. With
// __ctl.setHold(true) results wait for __ctl.settle() (one at a time, in the caller's frame), so a
// write can be in flight across a reload. Neither is used by the other phases (no frame, no hold: plain resolved promises).

const S = {
  fixture: {},
  checking: false,
  props: null,
  files: new Map(),
  calls: { run: 0, tick: 0, openOverlay: 0, closeOverlay: 0, setAgentOrder: 0, setShared: 0, writeTextFile: 0, readTextFile: 0, writes: [] },
  shared: new Map(),
  overlay: 0,
  frame: null,  // the copy whose callback runs ({released}), or null
  hold: false,  // results wait for __ctl.settle()
  held: [],
};
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const never = () => new Promise(() => {});

export const __ctl = {
  S,
  setFixture(f) { S.fixture = f || {}; },
  setChecking(on) { S.checking = !!on; },
  setProps(p) { S.props = p == null ? null : p; },
  resetCalls() { S.calls = { run: 0, tick: 0, openOverlay: 0, closeOverlay: 0, setAgentOrder: 0, setShared: 0, writeTextFile: 0, readTextFile: 0, writes: [] }; },
  setFrame(f) { S.frame = f || null; },
  setHold(on) { S.hold = !!on; },
  /**
   * Deliver the oldest held result (or the oldest whose frame passes `only(frame)`: the others
   * answer later) in its own frame, as herdr resumes a task in the scope that made the call; a
   * released frame's never settles. Returns 1, or 0 when nothing (matching) is held. The caller
   * drains the job queue after each, so the continuation's own calls carry that frame too.
   */
  settle(only) {
    const i = typeof only === "function" ? S.held.findIndex((h) => only(h.frame)) : S.held.length ? 0 : -1;
    if (i < 0) return 0;
    const h = S.held.splice(i, 1)[0];
    S.frame = h.frame;
    h.deliver();
    return 1;
  },
};

/** A host async call whose work `p` already ran: settles for its frame's build only (see above). */
function hostCall(p) {
  const frame = S.frame;
  if (!frame && !S.hold) return p;
  const out = p.then((v) => ({ v }), (e) => ({ e, failed: true }));
  return new Promise((res, rej) => {
    const deliver = () => out.then((r) => {
      if (frame && frame.released) return; // cancelled with its build: never settles
      if (r.failed) rej(r.e);
      else res(r.v);
    });
    if (S.hold) S.held.push({ frame, deliver });
    else deliver();
  });
}

export function props() { return S.checking ? null : clone(S.props); }
export function checking() { return S.checking; }
export function appHome() { return "/mock/home"; }
export function home() { return "/mock/user"; }

export function readTextFile(p) {
  S.calls.readTextFile++;
  if (typeof p !== "string") throw new TypeError("readTextFile(path) expects a string path");
  if (S.checking) return never();
  return hostCall(readNow(p));
}
function readNow(p) {
  const t = S.files.get(p);
  if (t !== undefined && t.length > 1024 * 1024) return Promise.reject(new Error(`readTextFile: ${p} is larger than 1 MiB`));
  return Promise.resolve(t === undefined ? null : t);
}

export function writeTextFile(p, text, expected) {
  return hostCall(writeNow(p, text, expected));
}
function writeNow(p, text, expected) {
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
  S.calls.writes.push({ path: p, bytes: text.length, seq: S.calls.writeTextFile, by: S.frame ? S.frame.name || null : null });
  if (S.calls.writes.length > 50) S.calls.writes.shift();
  return Promise.resolve(null);
}

/**
 * herdr's exec (a program run with arguments, no shell), as tools/mock/herdr.mjs machineExec:
 * `ls -1 [--] <dir>` and `rm [-f] [--] <file>...` on the shim's files (the save folder pruning,
 * host.js prune); any other program answers code 0 and no output. Never runs anything.
 */
export function exec(command, args, options) {
  S.calls.exec = (S.calls.exec || 0) + 1;
  const t = options && typeof options === "object" ? options.timeout : undefined;
  if (t != null && !(typeof t === "number" && isFinite(t) && t > 0)) throw new TypeError("timeout must be a positive number of milliseconds");
  const list = Array.isArray(args) ? args.map(String) : [];
  const at = list.indexOf("--");
  const operands = at >= 0 ? list.slice(at + 1) : list.filter((a) => a.charAt(0) !== "-");
  let r = { code: 0, stdout: "", stderr: "" };
  if (command === "ls") {
    const out = [];
    for (const d of operands) {
      const prefix = d.replace(/\/+$/, "") + "/";
      for (const k of S.files.keys()) if (k.startsWith(prefix) && k.indexOf("/", prefix.length) < 0) out.push(k.slice(prefix.length));
    }
    out.sort();
    r = { code: 0, stdout: out.length ? out.join("\n") + "\n" : "", stderr: "" };
  } else if (command === "rm") {
    for (const f of operands) S.files.delete(f);
  }
  return hostCall(Promise.resolve(r));
}

export function run(name, args) {
  if (typeof name !== "string") throw new TypeError("run(name, args) expects a command name string");
  S.calls.run++;
  if (name === "down-the-stack.tick") S.calls.tick++;
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
