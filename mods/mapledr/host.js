// GameHost: the one simulation every copy of the mod shares (ARCHITECTURE §4).
//
// herdr runs one QuickJS VM per window, so module scope is shared by every copy of this mod: the
// stage, the party sidebar, every pane header, the HUD and the dialogs all see the same `HOST`.
// It owns the world, feeds it herdr's live data once a second (pump), fans redraws out to every
// shown copy (broadcast), serves memoised view models (view), runs UI commands (command), keeps
// the save file (load / maybeSave / flush) and tracks the two dialogs (sheet, Herd panel).
//
// Rules this file keeps (ARCHITECTURE §2):
//  - no herdr call at module top level: the host is created lazily by the first copy's init;
//  - while checking() (herdr-app check) there is no IO at all: an in-memory world, no timers;
//  - module state dies on hot reload / VM restart, so the save file is the only memory that
//    matters: a fresh host always resumes from it;
//  - one writer: writeTextFile(path, text, lastText) where lastText is the exact text last read or
//    written; save.bak gets the previous text first (same discipline); a conflict (someone else
//    wrote the file) reloads their save instead of clobbering it;
//  - a world that loaded read-only (a save from a newer version, rt.readOnly) is never written.
//
// Public surface (roles and main.js use only these):
//   getHost()                         the singleton
//   host.world / host.version         the world; a counter that moves whenever views may differ
//   host.ready                        false while the save loads (view() then returns null)
//   host.ensure(cx)                   first call starts the load; later calls retry a stuck load
//   host.pump(nowMs) -> boolean       ≥ 900 ms apart: snapshot → world.tick → maybeSave → broadcast
//   host.broadcast()                  run("mapledr.tick"): every shown copy re-renders
//   host.claim(cmd) -> boolean        the first copy to claim a key command within 300 ms wins
//   host.hotkey(name)                 mapledr.sheet / .herd / .calm, handled once, centrally
//   host.command(name, args)          world.command, then version++ and broadcast; returns {ok,...}
//   host.view(kind, args)             view model (memoised per world version), null while loading
//   host.openSheet(heroId, opts) / host.openHerd(tab) / host.toggleSheet / host.toggleHerd /
//   host.closeDialog(kind)            one dialog of each kind at a time
//   host.attach(info) / host.detach(token)   copy bookkeeping (dialogs register their overlay)
//   host.maybeSave(force) / host.flush()     the save policy
//   host.debugText() / host.takeUnreported() error counts for the debug tooltip / main.js

import { createWorld, loadWorld, serialize, tick as worldTick, command as worldCommand } from "./game/world.js";
import * as V from "./game/view.js";
import {
  agents, terminals, spaces, focused, window as herdrWindow, appHome, checking,
  readTextFile, writeTextFile, run, openOverlay, closeOverlay,
} from "herdr";

/** The mod's folder name: overlays and `<mod>.<command>` use it. */
export const MOD = "mapledr";

const PUMP_MS = 900;          // pump gate (every copy's 1 s timer calls pump)
const CLAIM_MS = 300;         // key commands reach every shown copy: one claim per window
const SAVE_EVERY_MS = 30000;  // while dirty (D§13.1)
const SAVE_MAJOR_MS = 2000;   // after a major event (D§13.1), and after a successful UI command
const LOAD_RETRY_MS = 10000;  // a load whose task died (its copy closed) is retried after this
const SAVE_STUCK_MS = 15000;  // a write whose task died (its copy closed) is given up after this
const STABLE_GAP_MS = 3000;   // short-lived copies (pane headers, dialogs) pump only as a fallback
const MEMO_MAX = 48;          // view models kept per world version
const MEMO_AGE_MS = 1000;     // and never older than this (time-based strings)
const PREWARM_MAX = 16;       // view models rebuilt in the pump (timer budget) instead of in render
const PREWARM_SKIP_MS = 150;  // ...unless the tick itself was already slow
// The always-visible roles, drawn by many copies every second (a dialog is one copy whose args
// follow the pointer: it builds its own view in render).
const PREWARM_KINDS = { stage: true, party: true, hud: true, nameplate: true };
const ERR_MAX = 20;

const DIALOG = {
  sheet: { width: 760, height: 500 },
  herd: { width: 760, height: 520 },
};

const VIEWS = {
  stage: (w, a) => V.stageView(w, a),
  party: (w, a) => V.partyView(w, a),
  nameplate: (w, a) => V.nameplateView(w, a),
  hud: (w, a) => V.hudView(w, a),
  sheet: (w, a) => V.sheetView(w, a),
  herd: (w, a) => V.herdView(w, a),
};

let HOST = null;

/** The shared host (created on first use, never at module evaluation). */
export function getHost() {
  if (!HOST) HOST = new GameHost();
  return HOST;
}

const msgOf = (e) => String((e && e.message) || e);
/** A memo key for view args: nowMs is left out (one view per version serves every copy). */
const argsKey = (args) => {
  try {
    return JSON.stringify(args || {}, (k, v) => (k === "nowMs" ? undefined : v));
  } catch (e) {
    return "?";
  }
};
const live = (fn, fallback) => {
  try {
    const v = fn();
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
};
const seedOf = (nowMs) => ((Math.floor(nowMs) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0) || 1;

export class GameHost {
  constructor() {
    // No herdr calls here (the host may be created while a module evaluates).
    this.world = null;
    this.placeholder = null;   // the empty world shown while the save loads
    this.version = 0;
    this.started = false;
    this.memoryOnly = false;   // checking(): no IO, ever
    this.loaded = false;
    this.loadSeq = 0;
    this.loadingSince = null;
    this.files = null;         // { dir, save, bak, broken }
    this.lastText = null;      // exact text of save.json as last read/written (null: absent)
    this.lastGood = false;     // lastText is a valid save (only then does it become save.bak)
    this.bakText = null;       // exact text of save.bak as last read/written (null: absent)
    this.brokenKept = false;
    this.ioBlocked = false;    // save.json exists but cannot be read: never write over it
    this.saving = null;        // the in-flight save (single writer)
    this.lastSaveMs = 0;
    this.majorSaved = 0;       // rt.majorAt covered by the last save
    this.saveSoonAt = null;
    this.lastPumpMs = -Infinity;
    this.lastStablePumpMs = -Infinity;
    this.savingSince = 0;
    this.claims = {};
    this.memo = { world: null, rtv: -1, hv: -1, map: new Map() };
    this.prewarming = false;   // view() calls from prewarm() don't count as a copy reading them
    this.overlays = { sheet: null, herd: null };
    this.copies = new Map();
    this.copySeq = 0;
    this.errors = [];
    this.errorCount = 0;
    this.stats = { pumps: 0, ticks: 0, lastTickMs: 0, maxTickMs: 0, saves: 0, reloads: 0, loadedFrom: null, warning: null };
  }

  /** The world can be shown (loaded, or put in place by a fixture). */
  get ready() {
    return !!this.world && (this.loaded || this.world !== this.placeholder);
  }

  // -------------------------------------------------------------------------------------------
  // Loading

  /**
   * Called by every copy's init (and timer). First call: checking() → an in-memory world with no
   * IO; otherwise an empty placeholder world while a task reads the save. Later calls restart a
   * load that never finished (the copy that started it closed and its task was cancelled).
   */
  ensure(cx) {
    if (!this.started) {
      this.started = true;
      const now = Date.now();
      if (live(checking, false)) {
        this.memoryOnly = true;
        this.world = createWorld({ nowMs: now, seed: 1 });
        this.loaded = true;
        return;
      }
      this.placeholder = createWorld({ nowMs: now, seed: 1 });
      if (!this.world) this.world = this.placeholder;
    }
    if (this.memoryOnly || this.loaded) return;
    if (this.loadingSince != null && Date.now() - this.loadingSince < LOAD_RETRY_MS) return;
    if (!cx || typeof cx.spawn !== "function") return;
    this.loadingSince = Date.now();
    cx.spawn(async (tcx) => {
      const ok = await this.load();
      if (!ok) return;
      this.broadcast();
      try { tcx.notify(); } catch (e) { /* the copy closed meanwhile */ }
    });
  }

  paths() {
    if (!this.files) {
      const home = String(appHome() || "").replace(/[\\/]+$/, "");
      const dir = `${home}/data/${MOD}`;
      this.files = { dir, save: `${dir}/save.json`, bak: `${dir}/save.bak`, broken: `${dir}/save.broken` };
    }
    return this.files;
  }

  /** Decode a save text; null when absent, {error} when it does not load. */
  decode(text, nowMs) {
    if (typeof text !== "string") return null;
    try {
      const r = loadWorld(text, { nowMs });
      if (!r || !r.world || !r.world.state || !r.world.rt) return { error: new Error("loadWorld returned no world") };
      return r;
    } catch (e) {
      return { error: e };
    }
  }

  /**
   * Read save.json (and save.bak), decide which world to run (D§13.1), adopt it. Returns true
   * when this call finished the load.
   */
  async load() {
    const seq = ++this.loadSeq;
    this.loadingSince = Date.now();
    const P = this.paths();
    let text = null;
    let readError = null;
    let bak = null;
    let bakError = null;
    try { text = await readTextFile(P.save); } catch (e) { readError = e; }
    try { bak = await readTextFile(P.bak); } catch (e) { bakError = e; }
    if (seq !== this.loadSeq || this.loaded) return false; // superseded by a newer load

    const now = Date.now();
    let world = null;
    let from = "new";
    let lastGood = true;
    if (readError) {
      // It exists but cannot be read (too big, permissions): never write over what we cannot see.
      this.error("read save.json", readError);
      this.ioBlocked = true;
    } else if (typeof text === "string") {
      const r = this.decode(text, now);
      if (r && r.world) {
        world = r.world;
        from = "save";
        if (r.warning) this.stats.warning = r.warning;
      } else {
        this.error("load save.json", r ? r.error : "empty");
        lastGood = false;
        await this.keepBroken(text);
      }
    }
    if (!world && (readError || (typeof text === "string" && !lastGood))) {
      const rb = this.decode(bak, now);
      if (rb && rb.world) {
        world = rb.world;
        from = "bak";
        if (rb.warning) this.stats.warning = rb.warning;
      } else if (rb && rb.error) {
        this.error("load save.bak", rb.error);
      }
    }
    if (bakError) this.error("read save.bak", bakError);
    if (!world) {
      world = createWorld({ nowMs: now, seed: seedOf(now) });
      if (from !== "new" || readError || !lastGood) from = "fresh";
    }
    if (seq !== this.loadSeq || this.loaded) return false;

    this.lastText = readError ? null : text;
    this.lastGood = lastGood && typeof text === "string";
    this.bakText = bakError ? null : bak;
    this.loaded = true;
    this.loadingSince = null;
    this.lastSaveMs = now;
    this.stats.loadedFrom = from;
    // A world put in place while loading (tools/check fixtures) stays; it saves over the file.
    if (!this.world || this.world === this.placeholder) this.world = world;
    this.placeholder = null;
    const rt = this.world.rt;
    this.majorSaved = rt.majorAt || 0;
    if (from === "bak" || from === "fresh") {
      // replace the unreadable save.json soon (its text is kept as save.broken)
      if (!rt.readOnly) rt.dirty = true;
      this.saveSoonAt = now + SAVE_MAJOR_MS;
    }
    this.version++;
    return true;
  }

  /** Keep a corrupt save aside once (save.broken is created, never overwritten). */
  async keepBroken(text) {
    if (this.brokenKept || this.memoryOnly || typeof text !== "string") return;
    this.brokenKept = true;
    try {
      await writeTextFile(this.paths().broken, text, null);
    } catch (e) {
      // already there from an earlier failure: keep the first one
    }
  }

  // -------------------------------------------------------------------------------------------
  // The 1 Hz pump

  /** herdr's live data as an engine Snapshot (ARCHITECTURE §3.3). */
  snapshot(nowMs) {
    const list = live(agents, []);
    const all = live(terminals, []);
    const sp = live(spaces, []);
    const f = live(focused, null);
    const w = live(herdrWindow, null);
    const d = new Date(nowMs);
    const listed = new Set();
    const out = [];
    for (const a of list) {
      if (!a || a.address == null) continue;
      listed.add(a.address);
      out.push({
        address: a.address, status: a.status, seq: a.seq, app: a.app, program: a.program, title: a.title,
        space: a.space, space_name: a.space_name, tab: a.tab, tab_index: a.tab_index, tab_name: a.tab_name,
        pane: a.pane, pane_name: a.pane_name, pinned: !!a.pinned, focused: !!a.focused,
      });
    }
    // Sub-agents without a pane are not in agents(): their raw word, error counting as blocked,
    // never done (patterns.md §1.7).
    const subagents = [];
    for (const k of all) {
      if (!k || !k.parent || k.state !== "live" || listed.has(k.address)) continue;
      const s = k.status;
      subagents.push({
        address: k.address, parent: k.parent, status: s === "error" ? "blocked" : s === "done" ? "idle" : s,
        title: k.name || k.template || (k.program && k.program.name) || k.address, program: k.program || null,
      });
    }
    const tabs = {};
    const spaceList = [];
    for (const s of sp) {
      if (!s) continue;
      spaceList.push({ id: s.id, name: s.name });
      for (const t of s.tabs || []) if (t && t.id != null) tabs[t.id] = { working_since: t.working_since == null ? null : t.working_since };
    }
    return {
      nowMs,
      tzOffsetMin: d.getTimezoneOffset(),
      weekday: d.getDay(),
      windowActive: w && w.active === false ? false : true,
      focusedTerminal: (f && f.terminal) || null,
      agents: out, subagents, tabs, spaces: spaceList,
    };
  }

  /**
   * Advance the world to nowMs from herdr's live data (at most once per 900 ms). Returns true when
   * something visible changed (the host then saved if due and broadcast already).
   * `stable`: the caller is a long-lived copy (stage, party, hud). Pane headers and dialogs close
   * often, and closing a copy cancels its pending host calls (a save in flight), so they pump only
   * when no long-lived copy has for a few seconds.
   */
  pump(nowMs, stable) {
    if (this.memoryOnly || !this.ready) return false;
    if (nowMs - this.lastPumpMs < PUMP_MS && nowMs >= this.lastPumpMs) return false;
    if (stable === false && nowMs - this.lastStablePumpMs < STABLE_GAP_MS && nowMs >= this.lastStablePumpMs) return false;
    this.lastPumpMs = nowMs;
    if (stable !== false) this.lastStablePumpMs = nowMs;
    const world = this.world;
    const rt = world.rt;
    const before = rt.version;
    let res = null;
    const t0 = Date.now();
    try {
      res = worldTick(world, this.snapshot(nowMs));
    } catch (e) {
      this.error("tick", e, true);
      return false;
    }
    const ms = Date.now() - t0;
    this.stats.pumps++;
    this.stats.lastTickMs = ms;
    if (ms > this.stats.maxTickMs) this.stats.maxTickMs = ms;
    if (res && res.advanced) this.stats.ticks += res.ticks || 0;
    // Not only when the world advanced: a clock that went back holds the world still (up to an
    // hour) while UI commands still change it and must be saved.
    this.maybeSave(false, nowMs);
    if (rt.version === before || world !== this.world) return false;
    // Only what a render actually read since the last pump (a prewarmed entry nobody read again,
    // e.g. an old stage width after a splitter drag or a closed pane's header, is dropped), the
    // costly stage / party / hud before the nameplates.
    let shown = [];
    if (this.memo.world === world) {
      const used = Array.from(this.memo.map.values()).filter((e) => e.used && PREWARM_KINDS[e.kind]);
      shown = used.filter((e) => e.kind !== "nameplate").concat(used.filter((e) => e.kind === "nameplate")).slice(0, PREWARM_MAX);
    }
    this.version++;
    // A hidden window draws nothing: skip the redraw fan-out (the copies' stale guard catches up).
    const win = live(herdrWindow, null);
    if (!win || win.visible !== false) {
      // The redraws run after this callback returns, so prewarming after the broadcast still
      // lands first; and the broadcast goes out even if prewarming hits the callback budget.
      this.broadcast();
      if (ms < PREWARM_SKIP_MS) this.prewarm(shown, nowMs);
    }
    return true;
  }

  /**
   * Rebuild the view models the copies asked for last version, here in the timer (500 ms budget)
   * rather than in each copy's render (50 ms): the renders that follow the broadcast hit the memo.
   */
  prewarm(entries, nowMs) {
    this.prewarming = true;
    try {
      for (const e of entries) {
        if (!e || !PREWARM_KINDS[e.kind]) continue;
        const a = e.args && typeof e.args === "object" && "nowMs" in e.args ? Object.assign({}, e.args, { nowMs }) : e.args;
        this.view(e.kind, a);
      }
    } finally {
      this.prewarming = false;
    }
  }

  /** Every shown copy's nextCommand() loop gets "tick" and re-renders. */
  broadcast() {
    if (this.memoryOnly) return;
    try {
      run(`${MOD}.tick`);
    } catch (e) {
      this.error("broadcast", e);
    }
  }

  /**
   * `<mod>.<command>` keys reach every shown copy; the first copy to claim one within 300 ms
   * handles it, the others ignore it.
   */
  claim(cmd, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const last = this.claims[cmd];
    if (last != null && now >= last && now - last < CLAIM_MS) return false;
    this.claims[cmd] = now;
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Commands and view models

  /** A UI command (ARCHITECTURE §3.5) at Date.now(); every copy re-renders. */
  command(name, args) {
    if (!this.ready) return { ok: false, error: "Still loading the save" };
    const now = Date.now();
    let res;
    try {
      res = worldCommand(this.world, name, args || {}, now);
    } catch (e) {
      this.error(`command ${name}`, e, true);
      res = { ok: false, error: msgOf(e) };
    }
    if (!res || typeof res !== "object") res = { ok: false, error: "No result" };
    if (res.ok && !this.world.rt.readOnly) {
      this.world.rt.dirty = true;
      // the person's own actions persist quickly (like a major event)
      if (this.saveSoonAt == null) this.saveSoonAt = now + SAVE_MAJOR_MS;
    }
    this.version++;
    this.broadcast();
    return res;
  }

  /**
   * The view model of a role (ARCHITECTURE §5): `kind` ∈ stage|party|nameplate|hud|sheet|herd,
   * `args` the second parameter of the matching view function. Null while the save loads.
   * Memoised on (world, rt.version, host.version, kind, args without nowMs) for a second, so every
   * copy drawing the same thing in one frame shares one build. A view that throws is recorded and
   * answers null (the role shows its loading state; the error surfaces in the debug tooltip).
   */
  view(kind, args) {
    if (!this.ready) return null;
    const fn = VIEWS[kind];
    if (!fn) return null;
    const world = this.world;
    const m = this.memo;
    if (m.world !== world || m.rtv !== world.rt.version || m.hv !== this.version || m.map.size > MEMO_MAX) {
      this.memo = { world, rtv: world.rt.version, hv: this.version, map: new Map() };
    }
    const key = `${kind}|${argsKey(args)}`;
    const now = Date.now();
    const hit = this.memo.map.get(key);
    if (hit && Math.abs(now - hit.at) < MEMO_AGE_MS) {
      if (!this.prewarming) hit.used = true;
      return hit.vm;
    }
    let vm = null;
    try {
      vm = fn(world, args || {});
      if (vm === undefined) vm = null;
    } catch (e) {
      this.error(`view ${kind}`, e, true);
      vm = null;
    }
    this.memo.map.set(key, { vm, at: now, kind, args, used: !this.prewarming });
    return vm;
  }

  /** The hero a terminal plays (top-level agent or contractor), or the parent of a Forkling. */
  heroForTerminal(address) {
    if (address == null || !this.ready) return null;
    const rt = this.world.rt;
    if (rt.bind && rt.bind.has(address)) return rt.bind.get(address);
    if (rt.live) {
      for (const [id, l] of rt.live) {
        if (l && Array.isArray(l.forklings) && l.forklings.some((k) => k && k.address === address)) return id;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Dialogs: one of each kind at a time

  /** Character sheet for a hero; an open sheet for another hero is replaced, not stacked. */
  openSheet(heroId, opts) {
    if (heroId == null) return null;
    const o = opts || {};
    const cur = this.overlays.sheet;
    if (cur && cur.heroId === heroId && o.tab == null && o.focus == null) return cur.id;
    if (cur) this.closeDialog("sheet");
    const props = { role: "sheet", heroId };
    if (o.tab != null) props.tab = o.tab;
    if (o.focus != null) props.focus = o.focus;
    const id = openOverlay({ mod: MOD, kind: "dialog", width: DIALOG.sheet.width, height: DIALOG.sheet.height, props });
    this.overlays.sheet = { id, heroId };
    return id;
  }

  /** The Herd panel (on `tab` if given); an open one stays (switching tab reopens it there). */
  openHerd(tab) {
    const cur = this.overlays.herd;
    if (cur && (tab == null || cur.tab === tab)) return cur.id;
    if (cur) this.closeDialog("herd");
    const props = tab != null ? { role: "herd", tab } : { role: "herd" };
    const id = openOverlay({ mod: MOD, kind: "dialog", width: DIALOG.herd.width, height: DIALOG.herd.height, props });
    this.overlays.herd = { id, tab: tab == null ? null : tab };
    return id;
  }

  toggleSheet(heroId) {
    if (this.overlays.sheet) { this.closeDialog("sheet"); return null; }
    return this.openSheet(heroId);
  }

  toggleHerd(tab) {
    if (this.overlays.herd) { this.closeDialog("herd"); return null; }
    return this.openHerd(tab);
  }

  closeDialog(kind) {
    const cur = this.overlays[kind];
    if (!cur) return false;
    this.overlays[kind] = null;
    try { closeOverlay(cur.id); } catch (e) { this.error(`close ${kind}`, e); }
    return true;
  }

  /**
   * A dialog copy announces its overlay id (props().overlay) from init. A second dialog of the
   * same kind (opened straight with openOverlay by a role) replaces the first: no stacking.
   */
  registerOverlay(kind, id, info) {
    if (!(kind in this.overlays) || id == null) return;
    const cur = this.overlays[kind];
    if (cur && cur.id !== id) {
      try { closeOverlay(cur.id); } catch (e) { this.error(`close ${kind}`, e); }
    }
    this.overlays[kind] = Object.assign({}, info || {}, { id });
  }

  unregisterOverlay(id) {
    for (const k of Object.keys(this.overlays)) if (this.overlays[k] && this.overlays[k].id === id) this.overlays[k] = null;
  }

  /** mapledr.sheet / .herd / .calm (after claim()). Returns what happened, for tests. */
  hotkey(name) {
    if (name === "sheet") {
      if (this.overlays.sheet) { this.closeDialog("sheet"); return "closed"; }
      const f = live(focused, null);
      const heroId = this.heroForTerminal(f && f.terminal);
      if (heroId != null) { this.openSheet(heroId); return "opened"; }
      // no hero focused: the roster is where heroes are picked
      if (!this.overlays.herd) { this.openHerd("roster"); return "roster"; }
      return "none";
    }
    if (name === "herd") return this.toggleHerd() == null ? "closed" : "opened";
    if (name === "calm") {
      if (!this.ready) return "none";
      const cfg = this.world.state.herd.cfg || {};
      const r = this.command("setting", { key: "calm", value: !cfg.calm });
      return r && r.ok ? (cfg.calm ? "calm" : "lively") : "none";
    }
    return "none";
  }

  // -------------------------------------------------------------------------------------------
  // Copies

  /** A copy started: { role, overlay?, heroId?, tab? }. Returns a token for detach(). */
  attach(info) {
    const token = ++this.copySeq;
    const i = info || {};
    this.copies.set(token, i);
    if (i.overlay != null && (i.role === "sheet" || i.role === "herd")) {
      this.registerOverlay(i.role, i.overlay, i.role === "sheet" ? { heroId: i.heroId == null ? null : i.heroId } : { tab: i.tab == null ? null : i.tab });
    }
    return token;
  }

  /** A copy closed. Returns true when it was the last one (then flush the save). */
  detach(token) {
    const i = this.copies.get(token);
    this.copies.delete(token);
    if (i && i.overlay != null) this.unregisterOverlay(i.overlay);
    return this.copies.size === 0;
  }

  // -------------------------------------------------------------------------------------------
  // Saving

  canWrite() {
    return !this.memoryOnly && this.loaded && !this.ioBlocked && !!this.world && !this.world.rt.readOnly && !live(checking, false);
  }

  /**
   * The save policy: every 30 s while dirty, 2 s after a major event or a UI command, always when
   * forced (close). One write at a time. Returns the in-flight promise, or null.
   */
  maybeSave(force, nowMs) {
    if (!this.canWrite()) return null;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (this.saving) {
      if (Math.abs(Date.now() - this.savingSince) < SAVE_STUCK_MS) return this.saving;
      // the copy whose task ran it closed and its host call was cancelled: never resolves
      this.error("save", "a write never finished; trying again");
      this.saving = null;
    }
    const rt = this.world.rt;
    if (!rt.dirty) return null;
    if (!force) {
      const major = (rt.majorAt || 0) > this.majorSaved && now - rt.majorAt >= SAVE_MAJOR_MS;
      const soon = this.saveSoonAt != null && now >= this.saveSoonAt;
      // (a clock that went backwards past the last save counts as due, once)
      const periodic = now - this.lastSaveMs >= SAVE_EVERY_MS || now < this.lastSaveMs;
      if (!major && !soon && !periodic) return null;
    }
    const p = this.writeSave(now);
    this.saving = p;
    this.savingSince = Date.now();
    p.then(() => { if (this.saving === p) this.saving = null; }, () => { if (this.saving === p) this.saving = null; });
    return p;
  }

  /** Save now if anything changed (close / quit); waits for a save already in flight first. */
  async flush() {
    if (this.saving) {
      try { await this.saving; } catch (e) { /* recorded */ }
    }
    const p = this.maybeSave(true);
    if (p) await p;
  }

  async writeSave(nowMs) {
    const world = this.world;
    const rt = world.rt;
    const P = this.paths();
    let text;
    try {
      text = serialize(world);
    } catch (e) {
      this.error("serialize", e, true);
      this.backOff(world);
      this.lastSaveMs = nowMs;
      return false;
    }
    const majorAt = rt.majorAt || 0;
    const prev = this.lastText;
    // Ticks during the write mark the world dirty again; a failed write restores the flag.
    rt.dirty = false;
    this.saveSoonAt = null;
    this.lastSaveMs = nowMs;
    if (prev != null && this.lastGood && prev !== text) {
      try {
        await writeTextFile(P.bak, prev, this.bakText);
        this.bakText = prev;
      } catch (e) {
        // someone else touched save.bak: learn its text for next time; the save itself goes on
        this.error("write save.bak", e);
        try { this.bakText = await readTextFile(P.bak); } catch (e2) { /* next time */ }
      }
    }
    if (world !== this.world) return false; // reloaded meanwhile
    try {
      await writeTextFile(P.save, text, prev);
    } catch (e) {
      rt.dirty = true;
      await this.conflict(e, world);
      return false;
    }
    if (world === this.world) {
      this.lastText = text;
      this.lastGood = true;
      this.majorSaved = Math.max(this.majorSaved, majorAt);
    }
    this.stats.saves++;
    return true;
  }

  /**
   * A write of save.json failed. If the file changed under us (another window or process wrote
   * it), load that save instead of clobbering it; otherwise it was a plain IO failure.
   */
  async conflict(err, world) {
    const P = this.paths();
    let cur;
    try {
      cur = await readTextFile(P.save);
    } catch (e) {
      this.error("write save.json", err);
      this.backOff(world);
      return;
    }
    if (world !== this.world) return;
    if (cur === this.lastText) {
      // a plain IO failure (disk full, permissions): retry on the 30 s beat, not every pump
      this.error("write save.json", err);
      this.backOff(world);
      return;
    }
    if (cur == null) {
      // deleted under us: the next save creates it again
      this.lastText = null;
      this.lastGood = false;
      this.saveSoonAt = Date.now();
      return;
    }
    const r = this.decode(cur, Date.now());
    if (r && r.world) {
      this.world = r.world;
      this.lastText = cur;
      this.lastGood = true;
      this.majorSaved = r.world.rt.majorAt || 0;
      this.stats.reloads++;
      this.version++;
      this.broadcast();
      return;
    }
    // somebody wrote garbage: keep it aside and take the file over with our world
    this.error("load save.json (written elsewhere)", r ? r.error : "unreadable");
    await this.keepBroken(cur);
    this.lastText = cur;
    this.lastGood = false;
    this.saveSoonAt = Date.now();
  }

  /**
   * A save failed for a reason retrying at once won't fix: count the pending major event as
   * handled so the next attempt waits for the 30 s beat (or a newer event / UI command), instead
   * of a write (plus a save.bak write) on every 1 s pump.
   */
  backOff(world) {
    if (world !== this.world) return;
    this.majorSaved = Math.max(this.majorSaved, world.rt.majorAt || 0);
    this.saveSoonAt = null;
  }

  // -------------------------------------------------------------------------------------------
  // Errors and the debug tooltip

  /**
   * Record an error (counted; the first of each kind is logged). `surface`: main.js rethrows it
   * once from a timer so herdr logs it (and the mock check fails on it).
   */
  error(where, e, surface) {
    const message = msgOf(e);
    this.errorCount++;
    const hit = this.errors.find((x) => x.where === where && x.message === message);
    if (hit) { hit.count++; return hit; }
    const entry = { where, message, count: 1, surface: !!surface, reported: false };
    this.errors.push(entry);
    if (this.errors.length > ERR_MAX) this.errors.shift();
    try { console.log(`${MOD}: ${where}: ${message}`); } catch (e2) { /* no console */ }
    return entry;
  }

  /** Errors to rethrow once (render / view / tick bugs). */
  takeUnreported() {
    const out = [];
    for (const x of this.errors) if (x.surface && !x.reported) { x.reported = true; out.push(x); }
    return out;
  }

  /** Engine errors (rt.errors) plus host errors: for a debug tooltip only. */
  debugText() {
    const rt = this.world && this.world.rt;
    const engine = rt && Array.isArray(rt.errors) ? rt.errors : [];
    const lines = [`Down the Stack: ${this.errorCount} host error(s), ${engine.length} engine error(s)`];
    for (const x of this.errors.slice(-6)) lines.push(`${x.where}: ${x.message}${x.count > 1 ? ` (×${x.count})` : ""}`);
    for (const m of engine.slice(-6)) lines.push(`engine ${m}`);
    const s = this.stats;
    lines.push(`tick ${s.lastTickMs} ms (max ${s.maxTickMs}) · saves ${s.saves} · from ${s.loadedFrom || "-"}${rt && rt.readOnly ? " · read-only" : ""}`);
    return lines.join("\n");
  }

  /** Anything for the debug tooltip? */
  hasErrors() {
    const rt = this.world && this.world.rt;
    return this.errorCount > 0 || !!(rt && Array.isArray(rt.errors) && rt.errors.length);
  }
}
