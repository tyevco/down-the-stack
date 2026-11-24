// View base class, the `cx` objects herdr hands to views, tasks and the manual-clock timers.
//
// Three cx flavors, as in herdr:
//   render cx  call-scoped; phase "render"; notify() throws.
//   event cx   call-scoped; phase "event" (handlers, and init's construct step).
//   async cx   given to init, timers and spawned tasks; valid while the copy lives and its task runs.
// Using a call-scoped cx after its call returned throws: "never keep a cx" (ARCHITECTURE §2.4).

import { S, als, clock, mockNow, report, fixture } from "./state.mjs";
import { baseTheme } from "./theme.mjs";
import { mockError } from "./validate.mjs";

let deferInit = false;

export class View {
  constructor(props) {
    // `new MyView(props)` from script reaches init inside this constructor (before subclass
    // fields are initialised), exactly like herdr; the host's own construct() defers it.
    if (!deferInit && typeof this.init === "function") {
      const copy = als.getStore() ?? S.lastCopy;
      report("warning", "script-view", "a View subclass was constructed with `new` from script: init runs inside the View constructor, before the subclass's field initialisers (gpui-api.md §7)");
      this.init(props, makeCx(copy, "async").cx);
    }
  }
}

/** Host-style construction: no props, init deferred. */
export function construct(Class) {
  deferInit = true;
  try {
    return new Class();
  } finally {
    deferInit = false;
  }
}

/** Run `fn` with the global phase set (restored afterwards). */
export function withPhase(phase, fn) {
  const prev = S.phase;
  S.phase = phase;
  try {
    return fn();
  } finally {
    S.phase = prev;
  }
}

const notInRender = (api) => {
  if (S.phase === "render" || S.phase === "layout") {
    throw mockError(api === "cx.notify()" ? "notify-in-render" : "not-in-render", `${api} is not allowed during the \`${S.phase}\` phase; request a re-render from an event handler instead`);
  }
};

function makeTask(copy, kind) {
  const task = {
    kind, copy, cancelled: false, done: false,
    handle: null,
  };
  task.handle = Object.freeze({
    cancel() { task.cancelled = true; task.done = true; clock.timers = clock.timers.filter((t) => t.task !== task); },
    is_done() { return task.done; },
  });
  copy?.tasks.add(task);
  return task;
}

/** Every outstanding task across copies (herdr caps this at 1024 per runtime). */
function outstandingTasks() {
  let n = 0;
  for (const c of S.copies) for (const t of c.tasks) if (!t.done) n++;
  return n;
}

function checkTaskLimit() {
  if (outstandingTasks() >= 1024) throw mockError("task-limit", "too many outstanding tasks (herdr allows 1024 per runtime, all mods together)", RangeError);
}

/**
 * Build a cx for `copy`. Returns { cx, scope } — the harness flips `scope.live` off when a
 * call-scoped cx's call returns, and reads `scope.stopped` after an event handler.
 */
export function makeCx(copy, flavor, { task = null } = {}) {
  const scope = { live: true, stopped: false, task, flavor };
  const check = (api) => {
    if (flavor === "async") {
      if (copy && !copy.alive) throw mockError("stale-cx", `${api}: this cx belongs to a build of the script that was reloaded or closed`, Error);
      if (task?.cancelled) throw mockError("stale-cx", `${api}: this cx belongs to a task that was cancelled`, Error);
    } else if (!scope.live) {
      throw mockError("stale-cx", `${api}: this ${flavor} cx was used after its call returned; never keep a cx (each callback gets its own)`, Error);
    }
  };

  const schedule = (ms, fn, every, api) => {
    check(api);
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw mockError("bad-argument", `${api}(ms, fn) needs a finite, non-negative number of milliseconds`);
    if (typeof fn !== "function") throw mockError("bad-argument", `${api}(ms, fn) needs a function`);
    if (S.phase === "render") report("warning", "timer-in-render", `${api} called during render creates a new timer on every render; create timers in init`);
    checkTaskLimit();
    const t = makeTask(copy, every ? "every" : "after");
    clock.timers.push({ due: mockNow() + ms, seq: clock.seq++, ms, fn, every, copy, task: t });
    return t.handle;
  };

  const cx = {
    notify(entity) {
      check("cx.notify()");
      notInRender(entity === undefined ? "cx.notify()" : "cx.notify(entity)");
      if (entity !== undefined && !entity?.__entity) throw mockError("bad-argument", "cx.notify(entity) expects an Entity from cx.new(Class, props)");
      const target = entity?.__entity ? entity.__copy : copy;
      if (target) { target.dirty = true; target.notifies++; }
      if (entity?.__entity) entity.__dirty = true;
    },
    stop_propagation() { check("cx.stop_propagation()"); scope.stopped = true; },
    propagate() { check("cx.propagate()"); scope.stopped = false; },
    phase() { return S.phase !== "none" ? S.phase : flavor === "async" ? "task" : flavor; },
    theme() { return baseTheme(fixture().theme ?? {}); },
    focus_handle() {
      check("cx.focus_handle()");
      notInRender("cx.focus_handle()");
      const h = ++S.ids.handle;
      return Object.freeze({
        __handle: h,
        focus() { S.focusedHandle = h; },
        is_focused() { return S.focusedHandle === h; },
        release() { if (S.focusedHandle === h) S.focusedHandle = null; },
      });
    },
    new(Class, props) {
      check("cx.new()");
      notInRender("cx.new(Class, props)");
      if (typeof Class !== "function" || !(Class.prototype instanceof View)) throw mockError("bad-argument", "cx.new(Class, props) expects a class that extends View");
      const view = construct(Class);
      const entity = {
        __entity: true, __handle: ++S.ids.handle, __view: view, __copy: copy, __props: props ?? null, __released: false, __dirty: true,
        set_props(p) { entity.__props = p; if (typeof view.update === "function") view.update(p); entity.__dirty = true; if (copy) copy.dirty = true; },
        release() { entity.__released = true; },
      };
      if (typeof view.init === "function") view.init(props, makeCx(copy, "async").cx);
      return entity;
    },
    spawn(fn, opts) {
      check("cx.spawn()");
      if (typeof fn !== "function") throw mockError("bad-argument", "cx.spawn(fn) expects an async function");
      checkTaskLimit();
      const t = makeTask(copy, "spawn");
      const { cx: acx } = makeCx(copy, "async", { task: t });
      let result;
      try {
        // The body runs synchronously up to its first await, like herdr's scheduler.
        result = als.run(copy, () => withPhase("task", () => fn(acx)));
      } catch (e) {
        t.done = true;
        report("error", e.code ?? "task-error", `error in script task: ${e?.message ?? e}`, { copy, stack: e?.stack });
        return t.handle;
      }
      Promise.resolve(result).then(
        () => { t.done = true; },
        (e) => {
          t.done = true;
          if (!t.cancelled && copy?.alive && e?.code !== "stale-cx") report("error", e?.code ?? "task-error", `error in script task: ${e?.message ?? e}`, { copy, stack: e?.stack });
        },
      );
      return t.handle;
    },
    sleep(ms) {
      check("cx.sleep()");
      return new Promise((resolve) => schedule(ms, () => resolve(), false, "cx.sleep"));
    },
    timer: Object.freeze({
      after: (ms, fn, opts) => schedule(ms, fn, false, "cx.timer.after"),
      every: (ms, fn, opts) => schedule(ms, fn, true, "cx.timer.every"),
    }),
    bind_keys(list) {
      check("cx.bind_keys()");
      notInRender("cx.bind_keys()");
      if (!Array.isArray(list)) throw mockError("bad-argument", "cx.bind_keys(list) expects an array of {keystroke, action, context?}");
      return list.length;
    },
    open_url(url) {
      check("cx.open_url()");
      if (!/^https?:\/\//.test(String(url))) throw mockError("bad-argument", "cx.open_url(url) opens http or https URLs only");
      S.calls.openUrl.push({ url: String(url), copy: copy?.label });
    },
    read_from_clipboard() { check("cx.read_from_clipboard()"); return S.clipboard; },
    write_to_clipboard(s) { check("cx.write_to_clipboard()"); S.clipboard = String(s); },
  };
  return { cx, scope };
}

/**
 * Advance the manual clock by `ms`, running every timer that falls due (in due order) inside its
 * copy's context. Async callbacks and spawned continuations are drained between timers.
 * Returns the number of timer callbacks run.
 */
export async function advanceTimers(ms, { flush, budgetMs = 500 } = {}) {
  const target = mockNow() + Math.max(0, ms);
  let fired = 0;
  for (let guard = 0; guard < 100000; guard++) {
    const due = clock.timers.filter((t) => t.due <= target && !t.task.cancelled).sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
    if (!due) break;
    clock.timers = clock.timers.filter((t) => t !== due);
    if (due.due > mockNow()) clock.offset += due.due - mockNow();
    if (!due.copy?.alive) continue;
    fired++;
    const { cx } = makeCx(due.copy, "async", { task: due.task });
    const t0 = performance.now();
    let result;
    try {
      result = als.run(due.copy, () => withPhase("task", () => due.fn(cx)));
    } catch (e) {
      report("error", e.code ?? "timer-error", `error in script task (timer): ${e?.message ?? e}`, { copy: due.copy, stack: e?.stack });
    }
    const spent = performance.now() - t0;
    if (spent > budgetMs) report("error", "budget", `a timer callback took ${spent.toFixed(1)} ms (budget ${budgetMs} ms)`, { copy: due.copy });
    if (result && typeof result.then === "function") {
      try { await result; } catch (e) {
        if (e?.code !== "stale-cx") report("error", e?.code ?? "timer-error", `error in script task (timer): ${e?.message ?? e}`, { copy: due.copy, stack: e?.stack });
      }
    }
    if (flush) await flush();
    if (due.every && !due.task.cancelled && due.copy.alive) {
      clock.timers.push({ ...due, due: mockNow() + due.ms, seq: clock.seq++ });
    } else {
      due.task.done = true;
    }
  }
  if (target > mockNow()) clock.offset += target - mockNow();
  if (flush) await flush();
  return fired;
}
