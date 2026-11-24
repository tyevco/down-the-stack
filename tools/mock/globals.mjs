// herdr's script globals that Node lacks: gpui's `window` object and the per-copy
// `localStorage` / `sessionStorage`. Installed once, when "gpui-kit" (or the harness) loads.

import { S, currentCopy, report } from "./state.mjs";
import { paintPath } from "./elements.mjs";
import { mockError } from "./validate.mjs";

/** localStorage is per (mod, props JSON) in herdr; sessionStorage the same, memory only. */
const stores = { local: new Map(), session: new Map() };

function storeFor(kind) {
  const c = currentCopy();
  const key = `${c?.modName ?? "?"}|${JSON.stringify(c?.props ?? null)}`;
  let m = stores[kind].get(key);
  if (!m) stores[kind].set(key, (m = new Map()));
  return m;
}

function storage(kind) {
  return Object.freeze({
    get length() { return storeFor(kind).size; },
    key(i) { return [...storeFor(kind).keys()][i] ?? null; },
    getItem(k) { const v = storeFor(kind).get(String(k)); return v === undefined ? null : v; },
    setItem(k, v) {
      if (S.phase === "render") report("warning", "storage-in-render", "localStorage.setItem during render costs a full serialise on the UI thread; write from events/timers");
      storeFor(kind).set(String(k), String(v));
    },
    removeItem(k) { storeFor(kind).delete(String(k)); },
    clear() { storeFor(kind).clear(); },
    flush() { return Promise.resolve(); },
  });
}

export function resetStorage() {
  stores.local.clear();
  stores.session.clear();
}

const notInRender = (api) => {
  if (S.phase === "render" || S.phase === "layout") throw mockError("not-in-render", `window.${api}() is not allowed during the \`${S.phase}\` phase`);
};

const dialogs = [];
export const gpuiWindow = {
  open_dialog(build, opts) {
    notInRender("open_dialog");
    if (typeof build !== "function") throw mockError("bad-argument", "window.open_dialog takes a function returning an element, not an element and not a view class");
    dialogs.push({ build, opts });
  },
  close_dialog() { dialogs.pop(); },
  close_all_dialogs() { dialogs.length = 0; },
  has_active_dialog() { return dialogs.length > 0; },
  open_sheet(build, opts) { notInRender("open_sheet"); },
  open_sheet_at(at, build, opts) { notInRender("open_sheet_at"); },
  close_sheet() {},
  has_active_sheet() { return false; },
  push_toast(opts) { notInRender("push_toast"); return "toast"; },
  remove_toast() {},
  clear_toasts() {},
  get localStorage() { return localStorageObj; },
  get sessionStorage() { return sessionStorageObj; },
  paint_path: paintPath,
  rem_size() { return 13 * (Number(S.fixture?.settings?.zoom) || 1); },
  line_height() { return 18 * (Number(S.fixture?.settings?.zoom) || 1); },
  viewport_size() { return { width: 1440, height: 900 }; },
  bounds() { return { x: 0, y: 0, width: 1440, height: 900 }; },
  mouse_position() { return { x: 0, y: 0 }; },
  appearance() { return "dark"; },
  is_window_active() { return S.fixture?.window?.active ?? true; },
  is_fullscreen() { return false; },
  is_maximized() { return false; },
  dispatch_action(name) { notInRender("dispatch_action"); },
  set_rem_size(px) { notInRender("set_rem_size"); },
  refresh() { notInRender("refresh"); },
  focus_next() { notInRender("focus_next"); },
  focus_prev() { notInRender("focus_prev"); },
  activate_window() {},
  minimize_window() {},
  zoom_window() {},
  toggle_fullscreen() {},
};

const localStorageObj = storage("local");
const sessionStorageObj = storage("session");

if (!globalThis.__downTheStackMockGlobals) {
  Object.defineProperty(globalThis, "__downTheStackMockGlobals", { value: true });
  if (globalThis.window === undefined) globalThis.window = gpuiWindow;
  if (globalThis.localStorage === undefined) globalThis.localStorage = localStorageObj;
  if (globalThis.sessionStorage === undefined) globalThis.sessionStorage = sessionStorageObj;
}
