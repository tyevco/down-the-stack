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
//  - module state dies on hot reload / VM restart, so the save file is the memory that matters:
//    a fresh host resumes from it. On a hot reload (same VM) the previous build's host is still
//    reachable through globalThis[Symbol.for("<mod>.live.v1")] (a host registers there when its
//    load starts). The new host takes that world over (decoded by the new code) instead of rolling
//    back to the last save when the world continues the file just read, and also when the file is
//    unreadable, missing or garbage another program left (as conflict() and recoverRead() keep
//    their world); it loads the file when another window saved since, or when the file reads again
//    holding a herd the old world never had (that world is then kept aside as save.unsaved). What
//    the player was told about the save, and the collapse countdown, carry over with the world.
//    Either way the new host retires the earlier builds' hosts once it has loaded (one writer per
//    VM: a copy whose reload failed keeps an old build running): they never load, write or
//    register again, and a save one still has in flight stands down (npm run qjs -- --only reload
//    runs this in QuickJS-ng, the way herdr re-evaluates a mod in the same context);
//  - one writer: writeTextFile(path, text, lastText) where lastText is the exact text last read or
//    written; save.bak gets the previous text first (same discipline); a conflict (someone else
//    wrote the file) reloads their save instead of clobbering it, but a text this host wrote
//    itself (a write that landed while its promise never came back) is recognised as its own;
//  - nothing the player had is thrown away: a save that does not load is kept aside (save.broken,
//    then save.broken-1..3: the first incident and the newest three, keepAside; no program runs), a
//    save whose only fault is its checksum is loaded anyway, an unreadable save.json is read again a
//    few times and then on the 30 s beat;
//  - a world that loaded read-only (a save from a newer version, rt.readOnly) is never written, nor
//    is such a save found when an unreadable save.json reads again (it is opened read-only then);
//  - save trouble is shown to the player (saveStatus(): the views get it as args.save);
//  - opt-in notifications (D§11.15) are posted with notify() only after a save that holds them
//    landed (writeSave → post), so a restart, a hot reload or a second window sharing the save can
//    never post one twice; never while checking(), never with a sound;
//  - "collapse the stage when nothing is working" (D§11.15) hides and shows the layout's stage
//    block on transitions only (stageAuto), and shows only a stage it hid itself (this window's
//    own note, whatever another window saves); a restart or hot reload inside the minute goes on
//    with the countdown (herd.cfg.idleAt). The person shows or hides the stage whoever hid it with
//    the Herd panel's Stage strip switch or <mod>.stage (stageStrip): the stage is theirs then.
//
// Public surface (roles and main.js use only these):
//   getHost()                         the singleton
//   host.world / host.version         the world; a counter that moves whenever views may differ
//   host.ready                        false while the save loads (view() then returns null)
//   host.ensure(cx)                   first call starts the load; later calls retry a stuck load
//   host.pump(nowMs) -> boolean       ≥ 900 ms apart: snapshot → world.tick → maybeSave → broadcast
//   host.broadcast()                  run("down-the-stack.tick"): every shown copy re-renders
//   host.claim(cmd) -> boolean        the first copy to claim a key command within 300 ms wins
//   host.hotkey(name)                 down-the-stack.sheet / .herd / .calm / .stage[:show|:hide], once, centrally
//   host.command(name, args)          world.command, then version++ and broadcast; returns {ok,...}
//   host.view(kind, args)             view model (memoised per world version), null while loading
//   host.openSheet(heroId, opts) / host.openHerd(tab) / host.toggleSheet / host.toggleHerd /
//   host.closeDialog(kind)            one dialog of each kind at a time
//   host.followSheet(overlay, info)   the open sheet's hero now (a promoted Contractor's new id)
//   host.attach(info) / host.detach(token)   copy bookkeeping (dialogs register their overlay)
//   host.maybeSave(force) / host.flush()     the save policy
//   host.saveStatus()                 null, or {readOnly?, notSaving?, restoredFrom?, message, ...}
//   host.viewError(kind)              the message of a view builder that threw (else null)
//   host.mayBeShown()                 can a copy be shown now (layout(), open tab, dialogs)?
//   host.stageAuto(nowMs)             collapse / restore the stage block (pump and the setting)
//   host.stageInfo() / host.stageStrip(show?)  the stage block's {id, hidden, held}; show / hide / toggle it
//   host.debugText() / host.takeUnreported() error counts for the debug tooltip / main.js

import {
  createWorld, loadWorld, serialize, tick as worldTick, command as worldCommand, takeMilestones as worldTakeMilestones,
  MILESTONE_TTL_MS,
} from "./game/world.js";
import { crc32, saveSize } from "./game/save.js";
// Localhost's runtime part (the last approved titles, docs/TOWN.md §7.5) crosses a hot reload
import * as Town from "./game/town.js";
import * as V from "./game/view.js";
import {
  agents, terminals, spaces, focused, layout, window as herdrWindow, appHome, checking,
  readTextFile, writeTextFile, run, openOverlay, closeOverlay, notify,
} from "herdr";

/**
 * The mod's folder name: overlays, `<mod>.<command>` and the save folder use it. Spelled as a
 * `mod: "<name>"` key because that is a form `mod.clone` rewrites (src/mods.rs clone_mod_at), so
 * a clone talks to its own copies, opens its own dialogs and keeps its own save.
 */
const SELF = { mod: "down-the-stack" };
export const MOD = SELF.mod;

const PUMP_MS = 900;          // pump gate (every copy's 1 s timer calls pump)
const CLAIM_MS = 300;         // key commands reach every shown copy: one claim per window
const SAVE_EVERY_MS = 30000;  // while dirty (D§13.1)
const SAVE_MAJOR_MS = 2000;   // after a major event (D§13.1), and after a successful UI command
const LOAD_RETRY_MS = 10000;  // a load whose task died (its copy closed) is retried after this
const SAVE_STUCK_MS = 15000;  // a write whose task died (its copy closed) is given up after this
const READ_RETRY_MS = [1000, 3000, 6000]; // save.json that fails to read: tries again before deciding
const OWN_TEXTS = 4;          // texts this host wrote (or tried to) that may land without an answer
const NOT_SAVING_AFTER = 2;   // consecutive failed writes before the player is told
const STABLE_GAP_MS = 3000;   // short-lived copies (pane headers, dialogs) pump only as a fallback
const MEMO_MAX = 64;          // view models kept per world version (then the oldest go, chrome last)
const MEMO_AGE_MS = 1000;     // and never older than this (time-based strings)
const PREWARM_MAX = 16;       // view models rebuilt in the pump (timer budget) instead of in render
const PREWARM_SKIP_MS = 150;  // ...unless the tick itself was already slow
const COLLAPSE_AFTER_MS = 60000; // nothing working this long (after something did) collapses the stage
const RESUME_IDLE_MS = 10000;  // a countdown carried over a restart still waits this long in the new session
const STAGE_WANT_MS = 2000;    // stageInfo() answers the state stageStrip() asked for until layout() has it
const KEEP_ASIDE = 3;          // save.broken-1..3 / save.unsaved-1..3: the newest incidents after the first (keepAside)
const POSTED_KEEP = 32;       // milestone keys this host posted (a second guard against a repeat)
// The always-visible roles, drawn by many copies every second (a dialog is one copy whose args
// follow the pointer: it builds its own view in render).
const PREWARM_KINDS = { stage: true, party: true, hud: true, nameplate: true };
const ERR_MAX = 20;

const DIALOG = {
  sheet: { width: 760, height: 500 },
  herd: { width: 760, height: 520 },
};

// Roles whose view models receive args.save (saveStatus()) when the save is in trouble.
const SAVE_ARGS = { stage: true, party: true, hud: true, herd: true };

const VIEWS = {
  stage: (w, a) => V.stageView(w, a),
  party: (w, a) => V.partyView(w, a),
  nameplate: (w, a) => V.nameplateView(w, a),
  hud: (w, a) => V.hudView(w, a),
  sheet: (w, a) => V.sheetView(w, a),
  herd: (w, a) => V.herdView(w, a),
};

/** The short label of a save status (the stage chip, the Herd panel band). */
function saveTitle(readOnly, notSaving, restoredFrom) {
  return readOnly ? "Save is read-only"
    : notSaving ? "Not saving"
      : restoredFrom === "fresh" ? "Save didn't load: new herd"
        : restoredFrom === "unchecked" ? "Save failed its checksum"
          : "Save restored from backup";
}

/**
 * Is any hero (Contractors too) questing or supervising (D§11.15 "nothing is working")? A
 * "crashed" hero is a questing one between respawns (agents.heroState): its agent still works.
 */
const WORKING_STATES = { questing: true, crashed: true, supervising: true };
function anyWorking(rt) {
  for (const l of rt && rt.live ? rt.live.values() : []) if (l && WORKING_STATES[l.state] === true) return true;
  return false;
}

/** The layout node that holds this mod's stage block (any id), or null. */
function stageNode(root) {
  let found = null;
  const walk = (n, depth) => {
    if (found || !n || typeof n !== "object" || depth > 64) return;
    const c = n.content && typeof n.content === "object" ? n.content : null;
    if (c && c.mod === MOD && c.props && typeof c.props === "object" && c.props.role === "stage" && typeof n.id === "string") {
      found = n;
      return;
    }
    for (const k of Array.isArray(n.children) ? n.children : []) walk(k, depth + 1);
  };
  walk(root, 0);
  return found;
}

let HOST = null;
/** Where a host leaves itself for the next build after a hot reload (per VM, never top level). */
const LIVE_KEY = Symbol.for(`${MOD}.live.v1`);

/** The shared host (created on first use, never at module evaluation). */
export function getHost() {
  if (!HOST) HOST = new GameHost();
  return HOST;
}

/**
 * The memo is full (many pane headers drawn in one frame, or a splitter drag's widths): drop the
 * oldest entries, pane headers and dialogs before the stage, party and HUD, which every frame
 * draws and the next pump prewarms. Dropping the whole map instead would lose those mid-frame,
 * so their next build would land in a render rather than in the pump.
 */
const MEMO_KEEP = { stage: true, party: true, hud: true };
function evictMemo(map) {
  const target = MEMO_MAX - Math.max(1, Math.floor(MEMO_MAX / 4));
  for (const pass of [0, 1]) {
    for (const [k, e] of map) {
      if (map.size <= target) return;
      if (pass === 1 || !(e && MEMO_KEEP[e.kind] === true)) map.delete(k);
    }
  }
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

/**
 * The same save text with its checksum recomputed (null when it has no "crc" field). Used only
 * when the checksum is the one thing wrong with both save.json and save.bak: loading that data
 * beats starting a new herd over it (the original text is kept aside first).
 */
function resign(text) {
  if (typeof text !== "string") return null;
  let body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  body = body.trim();
  const m = /"crc":"[0-9a-fA-F]*"/.exec(body);
  if (!m) return null;
  const blank = body.replace(m[0], '"crc":""');
  return blank.replace('"crc":""', `"crc":"${crc32(blank)}"`);
}

const SAVE_TEXTS = {
  readOnly: "This save was made by a newer version of Down the Stack, so it is open read-only: nothing you do is saved.",
  ioBlocked: (P) => `The save file can't be read (${P.save}), so nothing is being saved. Fix or move it aside; saving resumes once it reads.`,
  writes: "Saving keeps failing (a full disk or missing permission?): recent progress is not on disk yet.",
  // (fallbacks: load() words the restore from what it actually found and kept, restoreNote())
  bak: "The save file could not be loaded, so the herd was restored from its backup (save.bak).",
  fresh: "The save file could not be loaded, so a new herd started.",
  unchecked: "The save failed its checksum (it was edited or damaged) and was loaded anyway.",
};

/**
 * What the player is told about a world that did not come straight from save.json: what was
 * wrong with save.json (`json`: unreadable | missing | damaged | checksum) and save.bak (`bak`:
 * ok | absent | unreadable | damaged | checksum), and the files the bad texts were kept as.
 */
function restoreNote(from, json, bak, kept) {
  const keptLine = kept.length ? ` ${kept.length > 1 ? "The damaged files were" : "The damaged file was"} kept as ${kept.join(" and ")}.` : "";
  const jsonSaid = { unreadable: "The save file couldn't be read", missing: "The save file was missing", damaged: "The save file was damaged", checksum: "The save file failed its checksum" }[json] || "The save file could not be loaded";
  if (from === "bak") return `${jsonSaid}, so the herd was restored from its backup (save.bak).${keptLine}`;
  if (from === "unchecked") return `${SAVE_TEXTS.unchecked}${keptLine}`;
  if (from === "fresh") {
    const bakSaid = { absent: "there was no backup", unreadable: "its backup couldn't be read", damaged: "its backup was damaged", checksum: "its backup failed its checksum" }[bak] || "its backup could not be loaded";
    return `${jsonSaid} and ${bakSaid}, so a new herd started.${keptLine}`;
  }
  return null;
}

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
    this.keptAside = [];       // texts kept aside this session (save.broken*): each kept once
    this.restoreNote = null;   // saveStatus() wording of how this world was restored (load())
    this.ioBlocked = false;    // save.json exists but cannot be read: never write over it (retried)
    this.saving = null;        // the in-flight save (single writer)
    this.saveGen = 0;          // bumped by every save; an older save's continuation stands down
    this.ownTexts = [];        // texts this host wrote or tried to write (newest last)
    this.failedWrites = 0;     // consecutive failed writes of save.json
    this.loadedAt = 0;
    this.statusKey = "";       // saveStatus() as last seen by pump (a change re-renders)
    this.saveNoticeSeen = null; // the save notice the player dismissed (main.js, stage)
    this.sizeLogged = false;
    this.viewErrors = Object.create(null); // kind -> message of the last throwing build of it
    this.retired = false;      // a newer build took this world over (hot reload): never write
    this.pred = null;          // the earlier build's host in this VM until this one has loaded (hot reload)
    this.origin = null;        // how this herd started: save | bak | fresh | unchecked | new (kept across a hot reload)
    this.lastSaveMs = 0;
    this.majorSaved = 0;       // rt.majorAt covered by the last save
    this.saveSoonAt = null;
    this.lastPumpMs = -Infinity;
    this.lastStablePumpMs = -Infinity;
    this.savingSince = 0;
    this.claims = Object.create(null);
    this.memo = { world: null, rtv: -1, hv: -1, map: new Map() };
    this.prewarming = false;   // view() calls from prewarm() don't count as a copy reading them
    this.overlays = { sheet: null, herd: null };
    this.copies = new Map();
    this.copySeq = 0;
    this.errors = [];
    this.errorCount = 0;
    this.stats = { pumps: 0, ticks: 0, lastTickMs: 0, maxTickMs: 0, saves: 0, reloads: 0, loadedFrom: null, warning: null, notified: 0 };
    this.outbox = [];          // milestones taken from the world, waiting for a save that holds that
    this.postedKeys = [];      // milestones this host posted (kind|at|n)
    this.stageWas = null;      // stageAuto: was anything working at the last pump (null: not seen yet)
    this.collapseWas = null;   // stageAuto: herd.cfg.collapse at the last pump
    this.idleSince = null;     // stageAuto: when the stage may collapse (armed by a transition)
    this.idleNoted = undefined; // stageAuto: the idle start last written to herd.cfg.idleAt (undefined: not yet)
    this.hidStage = null;      // stageAuto: this window's stage is hidden by this host (null: from cfg.collapsed)
    this.stageWant = null;     // stageStrip: {id, hidden, at} asked of herdr, until layout() shows it
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
      // a hot reload: the earlier build's host (its world, or the one it is still loading)
      this.pred = this.previousHost();
      this.register();
    }
    if (this.memoryOnly || this.loaded || this.retired) return;
    if (this.loadingSince != null && Date.now() - this.loadingSince < LOAD_RETRY_MS) return;
    if (!cx || typeof cx.spawn !== "function") return;
    this.loadingSince = Date.now();
    cx.spawn(async (tcx) => {
      const ok = await this.load(tcx);
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
   * when this call finished the load. Order: the previous build's world after a hot reload (when
   * it continues this very file), save.json, save.bak (also when save.json is missing but the bak
   * is there), then either file with only a checksum fault, then a new herd. `tcx` (the loading task's cx) lets a save.json that fails to read be
   * read again a few times before the host settles for the backup.
   */
  async load(tcx) {
    const seq = ++this.loadSeq;
    this.loadingSince = Date.now();
    const P = this.paths();
    // superseded by a newer load, or by the next build (a host retired while it loads never loads)
    const stale = () => seq !== this.loadSeq || this.loaded || this.retired;
    let text = null;
    let readError = null;
    for (let attempt = 0; ; attempt++) {
      readError = null;
      try { text = await readTextFile(P.save); } catch (e) { readError = e; text = null; }
      if (stale()) return false;
      // Another program holding the file, a sync tool's placeholder: often gone a moment later.
      if (!readError || attempt >= READ_RETRY_MS.length || !tcx || typeof tcx.sleep !== "function") break;
      this.loadingSince = Date.now();
      try { await tcx.sleep(READ_RETRY_MS[attempt]); } catch (e) { return false; }
      if (stale()) return false;
      this.loadingSince = Date.now();
    }
    let bak = null;
    let bakError = null;
    try { bak = await readTextFile(P.bak); } catch (e) { bakError = e; }
    if (stale()) return false;

    const now = Date.now();
    let world = null;
    let from = "new";
    let warning = null;
    let lastGood = true;
    let jsonFault = null;
    let bakFault = null;
    const kept = []; // file names the bad texts were kept aside as (what the player is told)
    const keep = async (t) => {
      const p = await this.keepBroken(t);
      if (p) kept.push(String(p).split("/").pop());
    };
    let fileR; // save.json decoded, once
    const fileDecoded = () => (fileR === undefined ? (fileR = this.decode(text, now)) : fileR);
    // The previous builds' hosts in this VM (a hot reload): the newest one that finished loading is
    // asked for its world (handover()), and every one of them is retired below whatever it answers.
    const prevHost = this.pred;
    const giver = this.giver();
    const h = giver ? this.previousBuild(giver, readError ? null : text, { unreadable: !!readError }) : null;
    const v2 = !!(h && h.v === 2);
    let lastText = readError ? null : text;
    if (h) {
      // "take": its world goes on (it continues this file, or the file is unreadable, missing or
      // garbage: the newest progress is in that world, as conflict() and recoverRead() keep theirs);
      // "file": another window wrote a save since, so that save is loaded (as conflict() does);
      // "unsaved": the file reads again after the previous build could never read it, and holds a
      // herd that world never had (it started fresh) or one this build cannot write (newer
      // version): the file is loaded and that world kept aside as save.unsaved (recoverRead()).
      let plan = "take";
      if (v2 && !readError && !h.continues && typeof text === "string") {
        const r = fileDecoded();
        if (r && r.world) plan = !h.ioBlocked ? "file" : r.world.rt.readOnly || h.origin === "fresh" ? "unsaved" : "take";
      }
      if (plan === "take") {
        const r = this.decode(h.text, now);
        if (r && r.world && !r.world.rt.readOnly) {
          world = r.world;
          from = "reload";
          warning = r.warning || null;
          for (const t of Array.isArray(h.ownTexts) ? h.ownTexts : []) this.noteOwn(t);
          if (!v2) {
            // an earlier build answers only when its world continues this very file
            lastGood = !!h.lastGood;
          } else if (readError) {
            // never write what cannot be read; recoverRead() knows the file by this text again
            lastText = typeof h.lastText === "string" ? h.lastText : null;
            lastGood = !!h.lastGood;
          } else if (typeof text !== "string") {
            lastGood = false; // deleted: the next save creates it again
          } else if (h.continues) {
            lastGood = text === h.lastText ? !!h.lastGood : true;
          } else {
            const fr = fileDecoded();
            lastGood = !!(fr && fr.world); // a save it could not read before becomes save.bak
            if (!lastGood) {
              // garbage another program wrote: kept aside, and the next save replaces it
              this.error("load save.json (hot reload)", fr ? fr.error : "unreadable");
              await keep(text);
            }
          }
        }
      } else if (plan === "unsaved") {
        await this.keepAside(h.text, `${P.dir}/save.unsaved`);
      }
    }
    if (world) {
      // handed over by the previous build (hot reload)
      if (readError) {
        this.error("read save.json", readError);
        this.ioBlocked = true;
      }
    } else if (readError) {
      // It exists but cannot be read (too big, permissions, held open): never write over what we
      // cannot see. maybeSave reads it again on the 30 s beat; saving resumes once it reads.
      this.error("read save.json", readError);
      this.ioBlocked = true;
    } else if (typeof text === "string") {
      const r = fileDecoded();
      if (r && r.world) {
        world = r.world;
        from = "save";
        warning = r.warning || null;
      } else {
        jsonFault = r ? r.error : new Error("empty");
        this.error("load save.json", jsonFault);
        lastGood = false;
        await keep(text);
      }
    }
    // save.json missing while save.bak is there (moved or deleted by another program, a partial
    // copy of data/): the herd in the bak is the player's, and the second save of a new herd
    // would rotate over it.
    const missing = !world && !readError && typeof text !== "string";
    if (!world && (readError || !lastGood || (missing && typeof bak === "string"))) {
      const rb = this.decode(bak, now);
      if (rb && rb.world) {
        world = rb.world;
        from = "bak";
        warning = rb.warning || null;
      } else if (rb && rb.error) {
        bakFault = rb.error;
        this.error("load save.bak", rb.error);
        // the second save after this one would rotate over it: keep it aside now
        await keep(bak);
      }
    }
    if (!world) {
      // Before a new herd: data whose only fault is its checksum (an edit, a stray byte) loads.
      for (const [t, fault, name] of [[text, jsonFault, "save.json"], [bak, bakFault, "save.bak"]]) {
        if (!fault || fault.code !== "crc") continue;
        const r = this.decode(resign(t), now);
        if (r && r.world) {
          world = r.world;
          from = "unchecked";
          warning = `${name} failed its checksum and was loaded anyway`;
          break;
        }
      }
    }
    if (bakError) this.error("read save.bak", bakError);
    if (!world) {
      world = createWorld({ nowMs: now, seed: seedOf(now) });
      if (from !== "new" || readError || !lastGood || bakFault || (missing && bakError)) from = "fresh";
    }
    if (stale()) return false;
    const jsonWas = readError ? "unreadable" : missing ? "missing" : jsonFault ? (jsonFault.code === "crc" ? "checksum" : "damaged") : null;
    const bakWas = bakError ? "unreadable" : bakFault ? (bakFault.code === "crc" ? "checksum" : "damaged") : typeof bak === "string" ? "ok" : "absent";

    if (from === "reload") {
      this.lastText = lastText;
      this.lastGood = lastGood;
    } else {
      this.lastText = readError ? null : text;
      this.lastGood = lastGood && typeof text === "string";
    }
    this.bakText = bakError ? null : bak;
    this.loaded = true;
    this.loadingSince = null;
    this.loadedAt = now;
    this.lastSaveMs = now;
    this.stats.loadedFrom = from;
    if (warning) this.stats.warning = warning;
    if (from === "reload" && v2) {
      // the same world goes on: so does what the player is told about its save (the restore cue,
      // its wording and age, failing writes, a dismissed notice)
      this.origin = typeof h.origin === "string" ? h.origin : null;
      this.restoreNote = typeof h.restoreNote === "string" ? h.restoreNote : null;
      if (typeof h.warning === "string") this.stats.warning = h.warning;
      if (Number.isFinite(h.loadedAt)) this.loadedAt = h.loadedAt;
      this.failedWrites = Number.isFinite(h.failedWrites) ? h.failedWrites : 0;
      if (typeof h.noticeSeen === "string") this.saveNoticeSeen = h.noticeSeen;
    } else {
      this.origin = from === "reload" ? null : from;
      this.restoreNote = restoreNote(from, jsonWas, bakWas, kept);
    }
    // the collapse countdown and the stage this window's host hid are this window's, whatever world
    // goes on
    if (v2 && h.stage && typeof h.stage === "object") {
      const s = h.stage;
      if (typeof s.was === "boolean") this.stageWas = s.was;
      if (typeof s.on === "boolean") this.collapseWas = s.on;
      if (Number.isFinite(s.idleSince)) this.idleSince = s.idleSince;
      if (typeof s.hid === "boolean") this.hidStage = s.hid;
      if (s.idleNoted === null || Number.isFinite(s.idleNoted)) this.idleNoted = s.idleNoted;
    }
    // A world put in place while loading (tools/check fixtures) stays; it saves over the file.
    if (!this.world || this.world === this.placeholder) this.world = world;
    this.placeholder = null;
    // the town's last approved titles are runtime only (never saved): a hot reload hands them over
    // with the world they belong to (after a restart the Localhost tab's line starts empty)
    if (from === "reload" && v2 && h.town && this.world === world && typeof Town.takeTown === "function") {
      try { Town.takeTown(world, h.town); } catch (e) { this.error("hot reload (Localhost titles)", e); }
    }
    const rt = this.world.rt;
    this.majorSaved = rt.majorAt || 0;
    if (from === "bak" || from === "fresh" || from === "unchecked" || from === "reload") {
      // replace the damaged save.json soon (its text was kept aside); after a hot reload, put
      // the previous build's unsaved progress on disk
      if (!rt.readOnly) rt.dirty = true;
      this.saveSoonAt = now + SAVE_MAJOR_MS;
    }
    // One writer per VM: the previous builds' hosts never write again, whether one handed its world
    // over or not (it declines when another window wrote save.json), and one still loading never
    // finishes. A copy whose reload failed keeps running that build (watch.rs reload), and its host
    // would fight this one over save.json.
    if (prevHost) {
      try { if (typeof prevHost.retire === "function") prevHost.retire(); } catch (e) { /* an old build */ }
      if (giver && giver !== prevHost) {
        try { if (typeof giver.retire === "function") giver.retire(); } catch (e) { /* an old build */ }
      }
    }
    this.pred = null; // the earlier builds can go
    this.statusKey = JSON.stringify(this.saveStatus());
    this.version++;
    return true;
  }

  /**
   * Leave this host where the next build finds it after a hot reload (same VM only). Done when the
   * load starts (ensure), not when it ends: a reload that lands while this host is still loading
   * must find it, retire it and take the world from the build before it, or two hosts would run.
   */
  register() {
    if (this.memoryOnly || this.retired) return;
    try { globalThis[LIVE_KEY] = this; } catch (e) { /* no handover then */ }
  }

  /** The host an earlier build of this VM registered (hot reload), or null. */
  previousHost() {
    let prev = null;
    try { prev = globalThis[LIVE_KEY]; } catch (e) { return null; }
    return prev && prev !== this && typeof prev === "object" ? prev : null;
  }

  /**
   * The newest earlier build's host that finished its load (back-to-back reloads: the build right
   * before this one may still be loading, and the one before it still has the world), or null.
   */
  giver() {
    let h = this.pred;
    for (let n = 0; h && typeof h === "object" && h !== this && n < 16; n++) {
      if (h.retired) return null;
      if (h.loaded) return h;
      h = h.pred;
    }
    return null;
  }

  /** The previous build's handover (see handover()), or null. */
  previousBuild(prev, fileText, info) {
    if (!prev || prev === this || typeof prev.handover !== "function") return null;
    try {
      const h = prev.handover(fileText, info);
      return h && typeof h.text === "string" ? Object.assign({}, h, { host: prev }) : null;
    } catch (e) {
      this.error("hot reload", e);
      return null;
    }
  }

  /**
   * Called on this (old) host by the next build after a hot reload, with the save.json text that
   * build just read (null when missing or unreadable) and `info` ({unreadable}). Answers this world
   * as save text with what the new build needs to decide (load()): whether the world continues
   * that file, the expected text, the texts this host wrote, whether it could read the file, how
   * the herd started (the restore cue) and the collapse countdown. Null when it has no world to
   * give (still loading, retired, checking, read-only). Called with one argument (by an earlier
   * build's load), it answers only when the world continues this very file, as that build expects.
   */
  handover(fileText, info) {
    if (!this.loaded || this.memoryOnly || this.retired || !this.world || this.world.rt.readOnly) return null;
    const continues = this.lastText === fileText || (fileText != null && this.ownTexts.includes(fileText));
    if (!info || typeof info !== "object") {
      if (this.ioBlocked || !continues) return null;
      return { text: serialize(this.world), lastGood: this.lastText === fileText ? this.lastGood : true, ownTexts: this.ownTexts.slice() };
    }
    return {
      v: 2, text: serialize(this.world), continues,
      lastText: this.lastText, lastGood: this.lastGood, ownTexts: this.ownTexts.slice(), ioBlocked: this.ioBlocked,
      origin: this.origin, restoreNote: this.restoreNote, warning: this.stats.warning, loadedAt: this.loadedAt,
      failedWrites: this.failedWrites, noticeSeen: this.saveNoticeSeen,
      stage: { was: this.stageWas, on: this.collapseWas, idleSince: this.idleSince, hid: this.hidStage, idleNoted: this.idleNoted },
      // Localhost's last approved titles (runtime only; plain data)
      town: typeof Town.handoverTown === "function" ? Town.handoverTown(this.world) : null,
    };
  }

  /**
   * A newer build took over: never write again. A save of ours still in flight stands down when it
   * resumes (a copy whose reload failed keeps this build running, and its pending write is
   * answered after the handover): its save.json write would otherwise land over the new host's
   * expected text, and the new host would reload it as someone else's save. The builds before this
   * one that it never retired (it was still loading) are retired with it.
   */
  retire() {
    if (this.retired) return;
    this.retired = true;
    this.saveGen++;
    this.saving = null;
    this.outbox = [];
    const p = this.pred;
    this.pred = null;
    try { if (globalThis[LIVE_KEY] === this) globalThis[LIVE_KEY] = null; } catch (e) { /* nothing registered */ }
    if (p && p !== this && typeof p.retire === "function") {
      try { p.retire(); } catch (e) { /* an old build */ }
    }
  }

  /**
   * Keep a save that did not load aside: save.broken the first time (D§13.1), then save.broken-1,
   * -2 and -3 (keepAside). Each text once.
   */
  async keepBroken(text) {
    return this.keepAside(text, this.paths().broken);
  }

  /**
   * Keeps a text aside under `stem` (save.broken, save.unsaved) without running a program or
   * listing the folder: herdr's mod API can do neither without exec, and the mod runs no programs.
   * The first incident's `<stem>` is only ever created, never overwritten. Later incidents fill
   * `<stem>-1`, `-2`, `-3` (created, oldest first); once all three hold a text, the oldest is
   * dropped: -1 takes -2's text, -2 takes -3's and the new text goes to -3, each write checked
   * against the text just read (writeTextFile replaces a file atomically). So a kind never holds
   * more than its first incident and the newest three. A text already kept under any of the four
   * names is not written again. Returns the path the text went to, or null.
   */
  async keepAside(text, stem) {
    if (this.memoryOnly || typeof text !== "string" || !text) return null;
    if (this.keptAside.includes(text)) return null;
    this.keptAside.push(text);
    if (this.keptAside.length > 8) this.keptAside.shift();
    const names = [stem];
    for (let i = 1; i <= KEEP_ASIDE; i++) names.push(`${stem}-${i}`);
    const texts = [];
    for (const p of names) {
      let t;
      try { t = await readTextFile(p); } catch (e) { t = undefined; /* unknown: never written over */ }
      if (t === text) return p;
      texts.push(t);
    }
    for (let i = 0; i < names.length; i++) {
      if (texts[i] !== null) continue;
      try {
        await writeTextFile(names[i], text, null);
        return names[i];
      } catch (e) { /* taken meanwhile: try the next name */ }
    }
    const ring = texts.slice(1);
    if (ring.every((t) => typeof t === "string")) {
      try {
        for (let i = 1; i < names.length - 1; i++) await writeTextFile(names[i], texts[i + 1], texts[i]);
        await writeTextFile(names[names.length - 1], text, texts[names.length - 1]);
        return names[names.length - 1];
      } catch (e) {
        this.error("keep a damaged save", e);
        return null;
      }
    }
    this.error("keep a damaged save", `could not keep it aside as ${stem}`);
    return null;
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
    // agents() carries no parent: a sub-agent kept in a pane (terminal.keep, `hc run --keep`) is
    // listed there too, and must stay its parent's Forkling (D§2.7), so take parent from terminals().
    const parentOf = new Map();
    for (const k of all) if (k && k.parent != null && k.state === "live" && k.address != null) parentOf.set(k.address, String(k.parent));
    const listed = new Set();
    const out = [];
    for (const a of list) {
      if (!a || a.address == null) continue;
      listed.add(a.address);
      out.push({
        address: a.address, status: a.status, seq: a.seq, app: a.app, program: a.program, title: a.title,
        space: a.space, space_name: a.space_name, tab: a.tab, tab_index: a.tab_index, tab_name: a.tab_name,
        pane: a.pane, pane_name: a.pane_name, pinned: !!a.pinned, focused: !!a.focused,
        parent: parentOf.has(a.address) ? parentOf.get(a.address) : null,
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
    // Keyed by herdr tab ids, which a `herdr.tab` label can choose ("constructor", "__proto__"):
    // no prototype, so such a key neither hits a frozen Object.prototype member nor swaps the
    // prototype.
    const tabs = Object.create(null);
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
    if (this.memoryOnly || this.retired || !this.ready) return false;
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
    // milestones the tick (or a command since the last pump) raised: saved now, posted after
    this.takeMilestones(nowMs);
    // Not only when the world advanced: a clock that went back holds the world still (up to an
    // hour) while UI commands still change it and must be saved.
    this.maybeSave(false, nowMs);
    this.stageAuto(nowMs);
    // save trouble that appeared or cleared (a failed write, a save.json that reads again) redraws
    const statusChanged = this.noteSaveStatus();
    if ((rt.version === before && !statusChanged) || world !== this.world) return false;
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

  /**
   * Every shown copy's nextCommand() loop gets "tick" and re-renders. herdr hands
   * `<mod>.<command>` to shown copies only and shows an error toast ("<mod>.tick failed") when
   * none listens, while hidden copies keep their timers and keep pumping: so no broadcast while
   * no copy can be shown (mayBeShown). A copy that shows again is drawn by herdr, and main.js's
   * stale guard catches any copy up within ~2 s.
   */
  broadcast() {
    if (this.memoryOnly) return false;
    if (!this.mayBeShown()) return false;
    try {
      run(`${MOD}.tick`);
      return true;
    } catch (e) {
      this.error("broadcast", e);
      return false;
    }
  }

  /**
   * Could a copy of this mod be shown now? layout() is the live layout (layout.toggle sets
   * `hidden`): a block of this mod outside hidden nodes and inactive stack children, or the pane
   * header while a tab is open, or an open dialog. A layout that never names this mod (another
   * layout, or a shape this does not know) answers true.
   */
  mayBeShown() {
    if (this.overlays.sheet || this.overlays.herd) return true;
    const root = live(layout, null);
    if (!root || typeof root !== "object") return true;
    let named = false;
    let shown = false;
    let tabOpen = null;
    const headerOf = (c) => (c && c.pane && typeof c.pane === "object" && c.pane.header && typeof c.pane.header === "object" ? c.pane.header.content : null);
    const walk = (n, visible, depth) => {
      if (shown || !n || typeof n !== "object" || depth > 64) return;
      const vis = visible && n.hidden !== true;
      const c = n.content && typeof n.content === "object" ? n.content : null;
      if (c && c.mod === MOD) {
        named = true;
        if (vis) shown = true;
      }
      const h = headerOf(c);
      if (h && typeof h === "object" && h.mod === MOD) {
        named = true;
        if (vis) {
          if (tabOpen == null) { const f = live(focused, null); tabOpen = !!(f && f.tab != null); }
          if (tabOpen) shown = true;
        }
      }
      // a stack's header block and the blocks floating over a node show with it (window.rs visible)
      const sh = n.type === "stack" && n.header && typeof n.header === "object" ? n.header.content : null;
      if (sh && typeof sh === "object" && sh.mod === MOD) {
        named = true;
        if (vis) shown = true;
      }
      for (const f of Array.isArray(n.floating) ? n.floating : []) {
        const fc = f && typeof f === "object" && f.content && typeof f.content === "object" ? f.content : null;
        if (fc && fc.mod === MOD) {
          named = true;
          if (vis && f.hidden !== true) shown = true;
        }
      }
      const kids = Array.isArray(n.children) ? n.children : [];
      // herdr's active_child (layout.rs): the active id among the visible children, else the first visible one
      let active = null;
      if (n.type === "stack") {
        const open = kids.filter((k) => k && typeof k === "object" && k.hidden !== true);
        active = open.find((k) => k.id === n.active) || open[0] || null;
      }
      for (const k of kids) walk(k, vis && (n.type !== "stack" || k === active), depth + 1);
    };
    walk(root, true, 0);
    return shown || !named;
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
    const collapseWas = !!(this.world.state.herd.cfg && this.world.state.herd.cfg.collapse);
    let res;
    try {
      // with the local time zone, so a milestone a click raises counts toward the local day at
      // once (the engine would otherwise hold it until the next tick, world.js raiseMilestone)
      res = worldCommand(this.world, name, args || {}, now, new Date(now).getTimezoneOffset());
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
    // turning "collapse the stage" on or off acts at once (stageAuto restores a stage it hid)
    if (res.ok && name === "setting" && args && args.key === "collapse") {
      this.stageAuto(now, { turnedOn: !collapseWas && !!this.world.state.herd.cfg.collapse });
    }
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
    const fn = typeof kind === "string" && Object.prototype.hasOwnProperty.call(VIEWS, kind) ? VIEWS[kind] : null;
    if (!fn) return null;
    const world = this.world;
    const m = this.memo;
    if (m.world !== world || m.rtv !== world.rt.version || m.hv !== this.version) {
      this.memo = { world, rtv: world.rt.version, hv: this.version, map: new Map() };
    } else if (m.map.size >= MEMO_MAX) {
      evictMemo(m.map);
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
      vm = fn(world, this.viewArgs(kind, args));
      if (vm === undefined) vm = null;
      if (this.viewErrors[kind] != null) delete this.viewErrors[kind];
    } catch (e) {
      this.error(`view ${kind}`, e, true);
      this.viewErrors[kind] = msgOf(e);
      vm = null;
    }
    this.memo.map.set(key, { vm, at: now, kind, args, used: !this.prewarming });
    return vm;
  }

  /**
   * The args a view builder gets: the role's own, plus args.save (saveStatus()) for the roles
   * that can show save trouble (D§13.4), only while there is some. Not part of the memo key: a
   * change of status moves this.version instead.
   */
  viewArgs(kind, args) {
    const a = args || {};
    const save = SAVE_ARGS[kind] === true ? this.saveStatus() : null;
    return save ? Object.assign({}, a, { save }) : a;
  }

  /**
   * The message of the view builder of `kind` that threw on its last build, else null. view()
   * answers null both while loading and after a throw; main.js uses this to tell them apart.
   */
  viewError(kind) {
    return typeof kind === "string" && this.viewErrors[kind] != null ? this.viewErrors[kind] : null;
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
    if (cur && this.sheetShows(cur, heroId) && o.tab == null && o.focus == null) {
      cur.heroId = heroId;
      return cur.id;
    }
    if (cur) this.closeDialog("sheet");
    const props = { role: "sheet", heroId };
    if (o.tab != null) props.tab = o.tab;
    if (o.focus != null) props.focus = o.focus;
    const id = openOverlay({ mod: MOD, kind: "dialog", width: DIALOG.sheet.width, height: DIALOG.sheet.height, props });
    this.overlays.sheet = { id, heroId };
    return id;
  }

  /**
   * Does the open sheet (overlays.sheet) show this hero? By id; or a Contractor's sheet whose
   * Contractor was promoted (round 4) and has a roster id now: the hero bound to the terminal the
   * sheet last reported (followSheet) with the name it reported. A click on the promoted hero
   * before the sheet has drawn its new id then keeps the dialog instead of closing and reopening it.
   */
  sheetShows(cur, heroId) {
    if (cur.heroId === heroId) return true;
    if (!(cur.heroId < 0) || !(heroId > 0) || !cur.address || !this.ready) return false;
    const rt = this.world.rt;
    if (!rt.bind || rt.bind.get(cur.address) !== heroId) return false;
    const hero = this.world.state.heroes.find((h) => h.id === heroId);
    return !!hero && (cur.name == null || hero.name === cur.name);
  }

  /**
   * A sheet copy reports what it shows each render (ui/sheet.js): its hero id (a promoted
   * Contractor's sheet follows it to its roster id), terminal and name. herdr cannot change an
   * overlay's props, so the dialog registry keeps them: openSheet for that hero keeps the dialog.
   */
  followSheet(overlay, info) {
    const cur = this.overlays.sheet;
    if (!cur || overlay == null || cur.id !== overlay || !info) return;
    if (Number.isInteger(info.heroId)) cur.heroId = info.heroId;
    if (typeof info.address === "string" && info.address) cur.address = info.address;
    if (typeof info.name === "string" && info.name) cur.name = info.name;
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

  /** down-the-stack.sheet / .herd / .calm (after claim()). Returns what happened, for tests. */
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
    // down-the-stack.stage (toggle), .stage:show, .stage:hide (keys.json `name:value`: herdr hands
    // the mod "stage:show", window.rs run_as): the Settings tab's Stage strip switch, as a command
    if (name === "stage" || name === "stage:show" || name === "stage:hide") {
      const r = this.stageStrip(name === "stage" ? undefined : name === "stage:show");
      return r && r.ok ? (r.hidden ? "hidden" : "shown") : "none";
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
    return !this.memoryOnly && !this.retired && this.loaded && !this.ioBlocked && !!this.world && !this.world.rt.readOnly && !live(checking, false);
  }

  /**
   * The save policy: every 30 s while dirty, 2 s after a major event or a UI command, always when
   * forced (close). One write at a time. Returns the in-flight promise, or null. While save.json
   * cannot be read (ioBlocked) it is read again on the 30 s beat instead.
   */
  maybeSave(force, nowMs) {
    if (this.ioBlocked && !this.memoryOnly && !this.retired && this.loaded) return this.retryRead(nowMs);
    if (!this.canWrite()) return null;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (this.saving) {
      if (Math.abs(Date.now() - this.savingSince) < SAVE_STUCK_MS) return this.saving;
      // the copy whose task ran it closed and its host call was cancelled: never resolves (the
      // write itself may have landed: conflict() recognises our own text)
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
    return this.track(this.writeSave(now));
  }

  /** Make `p` the in-flight save. */
  track(p) {
    this.saving = p;
    this.savingSince = Date.now();
    p.then(() => { if (this.saving === p) this.saving = null; }, () => { if (this.saving === p) this.saving = null; });
    return p;
  }

  /**
   * Save now if anything changed (close / quit). Never waits for a save started before: on quit
   * herdr drives only the host calls made inside close() (one shared 250 ms), so an earlier
   * write's continuation may never run. Instead it reads save.json (a call made here, so it is
   * driven) and writes over it if that is still our text, skipping the save.bak step.
   */
  async flush() {
    if (this.ioBlocked || !this.canWrite()) return;
    if (!this.saving) {
      const p = this.maybeSave(true);
      if (p) await p;
      return;
    }
    this.saving = null;
    this.saveGen++; // the earlier save stands down if it ever resumes
    let cur;
    try {
      cur = await readTextFile(this.paths().save);
    } catch (e) {
      this.error("read save.json", e);
      return;
    }
    if (!this.canWrite()) return;
    if (cur !== this.lastText) {
      if (cur == null) {
        this.lastText = null;
        this.lastGood = false;
      } else if (this.ownTexts.includes(cur)) {
        this.lastText = cur; // the earlier write landed
        this.lastGood = true;
      } else {
        return; // someone else wrote it meanwhile: the next session loads theirs
      }
    }
    this.world.rt.dirty = true;
    await this.track(this.writeSave(Date.now(), { skipBak: true }));
  }

  /** Remember a text this host is writing: if the write lands unanswered, it is still ours. */
  noteOwn(text) {
    if (typeof text !== "string" || this.ownTexts.includes(text)) return;
    this.ownTexts.push(text);
    if (this.ownTexts.length > OWN_TEXTS) this.ownTexts.shift();
  }

  async writeSave(nowMs, opts) {
    const world = this.world;
    const rt = world.rt;
    const P = this.paths();
    const gen = ++this.saveGen;
    let text;
    try {
      text = serialize(world);
    } catch (e) {
      this.error("serialize", e, true);
      this.failedWrites++;
      this.backOff(world);
      this.lastSaveMs = nowMs;
      return false;
    }
    // The milestones taken from this world so far are out of `text`: posted once it is on disk.
    const posting = this.outbox.filter((o) => o.world === world);
    this.outbox = [];
    if (!this.sizeLogged) {
      const size = saveSize(text);
      if (!size.ok) {
        this.sizeLogged = true;
        try { console.log(`${MOD}: save is ${size.bytes} bytes (budget ${size.budget})`); } catch (e) { /* no console */ }
      }
    }
    const majorAt = rt.majorAt || 0;
    const prev = this.lastText;
    // Ticks during the write mark the world dirty again; a failed write restores the flag.
    rt.dirty = false;
    this.saveSoonAt = null;
    this.lastSaveMs = nowMs;
    if (!(opts && opts.skipBak) && prev != null && this.lastGood && prev !== text) {
      try {
        await writeTextFile(P.bak, prev, this.bakText);
        this.bakText = prev;
      } catch (e) {
        // someone else touched save.bak: learn its text for next time; the save itself goes on
        this.error("write save.bak", e);
        try { this.bakText = await readTextFile(P.bak); } catch (e2) { /* next time */ }
      }
    }
    // reloaded meanwhile, or a newer save (a flush on close) took over
    if (world !== this.world || gen !== this.saveGen) {
      this.requeue(posting, world);
      return false;
    }
    this.noteOwn(text);
    try {
      await writeTextFile(P.save, text, prev);
    } catch (e) {
      if (gen !== this.saveGen) { this.requeue(posting, world); return false; }
      rt.dirty = true;
      const found = await this.conflict(e, world, text);
      // A conflict reloads the other writer's world: these milestones were never on disk (the
      // other window posts its own). The very text this write held, written by someone else (a
      // second window whose world ran the same), holds them taken: theirs to post. A plain IO
      // failure, or an earlier write of ours that landed unanswered, keeps them for the next save.
      if (found !== "same") this.requeue(posting, world);
      return false;
    }
    if (world === this.world && gen === this.saveGen) {
      this.lastText = text;
      this.lastGood = true;
      this.majorSaved = Math.max(this.majorSaved, majorAt);
    }
    this.failedWrites = 0;
    this.stats.saves++;
    // on disk now: a restart, a reload or another window loads a world in which these were taken
    if (world === this.world) this.post(posting);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Notifications (D§11.15): opt-in milestones, posted after the save that took them landed

  /**
   * Take the milestones the world raised (herd.milestones, world.takeMilestones) into the outbox
   * and ask for a save now: they are posted when a save that no longer holds them is on disk
   * (writeSave → post). Never while checking() (the host has no IO then at all) or read-only.
   */
  takeMilestones(nowMs) {
    if (this.memoryOnly || this.retired || !this.world || this.world.rt.readOnly) return 0;
    const q = this.world.state.herd.milestones;
    if (!Array.isArray(q) || !q.length) return 0;
    const got = worldTakeMilestones(this.world, nowMs);
    for (const m of got) this.outbox.push({ m, world: this.world });
    if (got.length) this.saveSoonAt = Math.min(this.saveSoonAt == null ? Infinity : this.saveSoonAt, nowMs);
    return got.length;
  }

  /** Milestones whose save did not land go back to the outbox while their world is still ours. */
  requeue(list, world) {
    if (!list.length || world !== this.world || this.retired) return;
    this.outbox = list.concat(this.outbox.filter((o) => !list.includes(o)));
  }

  /**
   * Posts taken milestones with herdr's notify() (no sound: notify has none, and the mod never
   * calls playSound). Not from a retired host (a hot reload took over), never while checking(),
   * never one older than MILESTONE_TTL_MS, never the same one twice. A click opens the Herd panel
   * with `mod.open` (an app command, so it works in any layout; mod.json "overlay"); while a Herd
   * panel is open the toast carries no action, since mod.open would close the one it opened.
   */
  post(list) {
    if (!list || !list.length || this.retired || this.memoryOnly || live(checking, true)) return 0;
    const now = Date.now();
    let n = 0;
    for (const { m } of list) {
      const key = `${m.kind}|${m.at}|${m.n}`;
      if (this.postedKeys.includes(key) || !(now - m.at <= MILESTONE_TTL_MS)) continue;
      this.postedKeys.push(key);
      if (this.postedKeys.length > POSTED_KEEP) this.postedKeys.shift();
      const n0 = { title: m.title, body: m.body, level: "success" };
      if (!this.overlays.herd) n0.action = { name: "mod.open", args: { name: MOD } };
      try {
        notify(n0);
        n++;
        this.stats.notified++;
      } catch (e) {
        this.error("notify", e);
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------------------------
  // "Collapse the stage when nothing is working" (D§11.15)

  /**
   * Hides the layout's stage block (layout.hide) when nothing has been working for
   * COLLAPSE_AFTER_MS after something did (or at once when the setting is turned on while nothing
   * works), and shows it again (layout.show) when a hero quests or supervises again. It acts on
   * those transitions only, so a stage the person shows or hides by hand stays as they left it, and
   * it shows only a stage it hid itself: herd.cfg.collapsed (saved, since herdr keeps a hidden
   * block hidden across restarts) says so. Turning the setting off shows that stage again. Never
   * while checking(), never for a read-only world; nothing in a layout without this mod's stage.
   * opts.turnedOn: the person just turned the setting on (command()). Returns what it did
   * ("hidden" | "shown" | null), for tests.
   */
  stageAuto(nowMs, opts) {
    if (this.memoryOnly || this.retired || !this.ready || this.world.rt.readOnly || live(checking, true)) return null;
    const world = this.world;
    const cfg = world.state.herd.cfg || {};
    const on = cfg.collapse === true;
    const working = anyWorking(world.rt);
    const wasWorking = this.stageWas;
    const wasOn = this.collapseWas;
    this.stageWas = working;
    this.collapseWas = on;
    // Whether this window's stage is hidden by this host is this window's own: it starts from the
    // saved note (a restart), and a save another window wrote (a conflict reload) never changes it.
    if (this.hidStage == null) this.hidStage = cfg.collapsed === true;
    // nothing works: arm on a transition (something stopped, or the setting was just turned on,
    // here or in a save another window wrote). A host that starts while nothing works goes on
    // with the countdown the previous session saved (herd.cfg.idleAt), never a new one.
    if (!on || working) this.idleSince = null;
    else if (wasWorking === true) this.idleSince = nowMs;
    else if ((opts && opts.turnedOn) || wasOn === false) this.idleSince = nowMs - COLLAPSE_AFTER_MS;
    else if (wasWorking === null && this.idleSince == null && Number.isFinite(cfg.idleAt)) {
      // (at least a few seconds of this session's own idling: herdr may not have reported the
      // agents' work yet right after a start)
      this.idleSince = Math.min(nowMs, Math.max(cfg.idleAt, nowMs - COLLAPSE_AFTER_MS + RESUME_IDLE_MS));
    }
    this.noteIdle(world);
    const due = on && !working && this.idleSince != null && nowMs - this.idleSince >= COLLAPSE_AFTER_MS;
    // layout() only when there is something to do: a stage this host holds hidden, or a collapse due
    const held = this.hidStage === true;
    if (!held && !due) return null;
    const node = stageNode(live(layout, null));
    if (!node) {
      this.idleSince = null;
      this.noteIdle(world);
      return null;
    }
    const hidden = node.hidden === true;
    if (held) {
      if (!hidden) this.holdStage(false); // shown since (by hand, or a layout reset): not ours any more
      else if (!on || working) return this.showStage(node); // turned off, or a hero works again
    }
    if (!due) return null;
    this.idleSince = null;
    this.noteIdle(world);
    if (hidden) return null; // hidden by hand already: not ours to show later
    if (!this.layoutCmd("layout.hide", node.id)) return null;
    this.stageWant = null; // what the Stage strip switch asked is history now
    this.holdStage(true);
    return "hidden";
  }

  /**
   * Keep the countdown's start in the save (herd.cfg.idleAt, the host's own note like
   * cfg.collapsed), so a restart inside the minute goes on with it. Written only when this host's
   * countdown changes: a save another window wrote is never answered with ours (no back and forth).
   */
  noteIdle(world) {
    const v = this.idleSince == null ? null : this.idleSince;
    if (v === this.idleNoted) return;
    this.idleNoted = v;
    const cfg = world.state.herd.cfg;
    if (!cfg || typeof cfg !== "object") return;
    if (v == null) {
      if (cfg.idleAt == null) return;
      delete cfg.idleAt;
    } else {
      cfg.idleAt = v;
    }
    world.rt.dirty = true;
  }

  showStage(node) {
    if (!this.layoutCmd("layout.show", node.id)) return null;
    this.stageWant = null;
    this.holdStage(false);
    return "shown";
  }

  /**
   * The stage is hidden by this host, which owes it a layout.show: this.hidStage (this window), and
   * herd.cfg.collapsed (saved, so that a restart knows), written soon: herdr keeps the hidden
   * block hidden across a restart, so a crash before the next periodic save must not lose the note.
   */
  holdStage(held) {
    this.hidStage = held;
    const cfg = this.world.state.herd.cfg || {};
    if (!!cfg.collapsed === held || this.world.rt.readOnly) return;
    try {
      const r = worldCommand(this.world, "setting", { key: "collapsed", value: held }, Date.now());
      if (r && r.ok) {
        this.world.rt.dirty = true;
        if (this.saveSoonAt == null) this.saveSoonAt = Date.now() + SAVE_MAJOR_MS;
        this.version++;
      }
    } catch (e) {
      this.error("stage collapse", e);
    }
  }

  layoutCmd(name, id, where) {
    try {
      run(name, { id });
      return true;
    } catch (e) {
      this.error(`${where || "stage collapse"} (${name})`, e);
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // The stage strip shown or hidden by the person (owner decision, round 4)

  /**
   * The layout's stage block as the Settings tab shows it: {id, hidden, held} (held: the collapse
   * hid it and owes it a layout.show), or null when the layout has none, while checking() or from
   * a retired host. Found by content (this mod's {role: "stage"}, any id), as stageAuto finds it.
   * herdr runs a mod's run() after the calling callback returns, so for a moment after
   * stageStrip() layout() still shows the old state: the state asked for is answered until
   * layout() has it (at most STAGE_WANT_MS).
   */
  stageInfo() {
    if (this.memoryOnly || this.retired || live(checking, true)) return null;
    const node = stageNode(live(layout, null));
    if (!node) return null;
    let hidden = node.hidden === true;
    const want = this.stageWant;
    if (want) {
      const age = Date.now() - want.at;
      if (want.id !== node.id || want.hidden === hidden || !(age >= 0 && age < STAGE_WANT_MS)) this.stageWant = null;
      else hidden = want.hidden;
    }
    return { id: node.id, hidden, held: this.stageHeld() };
  }

  /**
   * Whether this window's stage is hidden by the collapse, which owes it a layout.show: this
   * host's note, or before its first stageAuto (right after a start) the saved herd.cfg.collapsed
   * stageAuto starts from.
   */
  stageHeld() {
    if (this.hidStage != null) return this.hidStage === true;
    const herd = this.world && this.world.state ? this.world.state.herd : null;
    return !!(herd && herd.cfg && herd.cfg.collapsed === true);
  }

  /**
   * Shows (`show` true) or hides (false) the layout's stage block, or toggles it (no `show`): the
   * Herd panel's "Stage strip" switch and the `<mod>.stage[:show|:hide]` command. It acts whoever
   * hid the stage (the collapse, the person, herdr's .state file from an earlier install), on the
   * node found by content (`id`, what the caller saw, is not needed). Coexists with "collapse the
   * stage" (D§11.15): a stage shown or hidden here is the person's, so the collapse drops its hold
   * (herd.cfg.collapsed and this window's note): it never shows a stage hidden here, and a stage
   * shown here is not hidden again until work next stops (a countdown already running is called
   * off). Never while checking() or from a retired host; refused while the save loads (the
   * collapse's saved note is not known yet). Returns {ok, id?, hidden?, msg?, error?}.
   */
  stageStrip(show, id) {
    if (this.memoryOnly || live(checking, true)) return { ok: false, error: "Not while herdr-app check runs" };
    if (this.retired) return { ok: false, error: "Down the Stack was just reloaded: try again" };
    if (!this.ready) return { ok: false, error: "Still loading the save" };
    const info = this.stageInfo();
    if (!info) return { ok: false, error: "This layout has no stage" };
    const wantShown = typeof show === "boolean" ? show : info.hidden;
    const held = this.stageHeld();
    if (wantShown === info.hidden) {
      if (!this.layoutCmd(wantShown ? "layout.show" : "layout.hide", info.id, "stage strip")) {
        return { ok: false, error: `herdr refused to ${wantShown ? "show" : "hide"} the stage` };
      }
      this.stageWant = { id: info.id, hidden: !wantShown, at: Date.now() };
    }
    // the person's now: no countdown runs on, and nothing is owed a layout.show
    if (this.idleSince != null) {
      this.idleSince = null;
      this.noteIdle(this.world);
    }
    this.holdStage(false);
    const cfg = this.world.state.herd.cfg || {};
    const msg = wantShown && held && cfg.collapse === true
      ? "Stage strip shown. “Collapse the stage” hides it again a minute after work next stops."
      : null;
    return msg ? { ok: true, id: info.id, hidden: !wantShown, msg } : { ok: true, id: info.id, hidden: !wantShown };
  }

  /**
   * A write of save.json failed. If the file changed under us (another window or process wrote
   * it), load that save instead of clobbering it; if it holds a text this host wrote (a write
   * that landed while its promise never came back), carry on from it; otherwise it was a plain
   * IO failure.
   */
  async conflict(err, world, attempted) {
    const P = this.paths();
    let cur;
    try {
      cur = await readTextFile(P.save);
    } catch (e) {
      this.error("write save.json", err);
      this.failedWrites++;
      this.backOff(world);
      return "io";
    }
    if (world !== this.world) return "replaced";
    if (cur === this.lastText) {
      // a plain IO failure (disk full, permissions): retry on the 30 s beat, not every pump
      this.error("write save.json", err);
      this.failedWrites++;
      this.backOff(world);
      return "io";
    }
    if (cur != null && this.ownTexts.includes(cur)) {
      // our own earlier write landed after all (or another writer wrote this very text): the
      // next save goes over it
      this.lastText = cur;
      this.lastGood = true;
      this.saveSoonAt = Date.now();
      return cur === attempted ? "same" : "own";
    }
    if (cur == null) {
      // deleted under us: the next save creates it again
      this.lastText = null;
      this.lastGood = false;
      this.saveSoonAt = Date.now();
      return "deleted";
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
      return "reloaded";
    }
    // somebody wrote garbage: keep it aside and take the file over with our world
    this.error("load save.json (written elsewhere)", r ? r.error : "unreadable");
    await this.keepBroken(cur);
    this.lastText = cur;
    this.lastGood = false;
    this.saveSoonAt = Date.now();
    return "garbage";
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

  /** save.json could not be read: read it again on the 30 s beat (one read at a time). */
  retryRead(nowMs) {
    if (this.saving) {
      if (Math.abs(Date.now() - this.savingSince) < SAVE_STUCK_MS) return this.saving;
      this.saving = null; // its copy closed and the read never came back: read again
    }
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (now - this.lastSaveMs < SAVE_EVERY_MS && now >= this.lastSaveMs) return null;
    this.lastSaveMs = now;
    return this.track(this.recoverRead());
  }

  /**
   * save.json reads again. Our world goes on (the file becomes save.bak on the next save), unless
   * this session never had the herd (a new one started because nothing loaded), or the file is a
   * save from a newer version (D§13.4: read-only, never written): then the herd in the file comes
   * back (read-only for a newer one), and this session's world is kept aside as save.unsaved. A
   * file this host wrote itself (unreadable for a while after a hot reload) is just ours again.
   */
  async recoverRead() {
    const P = this.paths();
    let cur;
    try {
      cur = await readTextFile(P.save);
    } catch (e) {
      this.error("read save.json", e);
      return false;
    }
    if (!this.ioBlocked || this.retired) return false;
    const world = this.world;
    this.ioBlocked = false;
    if (typeof cur !== "string") {
      this.lastText = null;
      this.lastGood = false;
    } else {
      const r = this.decode(cur, Date.now());
      const ours = cur === this.lastText || this.ownTexts.includes(cur);
      if (r && r.world && !ours && (this.origin === "fresh" || r.world.rt.readOnly)) {
        let mine = null;
        try { mine = serialize(world); } catch (e) { /* nothing to keep */ }
        if (mine) await this.keepAside(mine, `${P.dir}/save.unsaved`);
        if (world !== this.world || this.retired) return false;
        this.world = r.world;
        this.lastText = cur;
        this.lastGood = !r.world.rt.readOnly;
        this.majorSaved = r.world.rt.majorAt || 0;
        this.saveSoonAt = null;
        this.origin = "save";
        this.restoreNote = null;
        this.stats.loadedFrom = "save";
        this.stats.reloads++;
        this.version++;
        this.broadcast();
        return true;
      }
      this.lastText = cur;
      this.lastGood = !!(r && r.world);
      if (!this.lastGood) await this.keepBroken(cur);
    }
    if (this.world.rt.readOnly) return true;
    this.world.rt.dirty = true;
    this.saveSoonAt = Date.now();
    this.version++;
    return true;
  }

  /**
   * Save trouble the player must hear about (D§13.1, D§13.4), or null when all is well:
   * { readOnly, notSaving, restoredFrom: null|"bak"|"fresh"|"unchecked", title, message, detail, since }
   * (title: the short label the stage notice and the Herd panel show, message: the full wording).
   */
  saveStatus() {
    if (!this.loaded || this.memoryOnly || !this.world) return null;
    const rt = this.world.rt;
    const lines = [];
    let readOnly = false;
    let notSaving = false;
    if (rt.readOnly) {
      readOnly = true;
      lines.push(SAVE_TEXTS.readOnly);
    } else if (this.ioBlocked) {
      notSaving = true;
      lines.push(SAVE_TEXTS.ioBlocked(this.paths()));
    } else if (this.failedWrites >= NOT_SAVING_AFTER) {
      notSaving = true;
      lines.push(SAVE_TEXTS.writes);
    }
    const from = this.origin;
    const restoredFrom = from === "bak" || from === "fresh" || from === "unchecked" ? from : null;
    if (restoredFrom) lines.push(this.restoreNote || SAVE_TEXTS[restoredFrom]);
    if (!lines.length) return null;
    return Object.freeze({ readOnly, notSaving, restoredFrom, title: saveTitle(readOnly, notSaving, restoredFrom), message: lines.join(" "), detail: this.stats.warning || null, since: this.loadedAt });
  }

  /** True when saveStatus() changed since the last call (the views then rebuild). */
  noteSaveStatus() {
    const key = JSON.stringify(this.saveStatus());
    if (key === this.statusKey) return false;
    this.statusKey = key;
    return true;
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
    lines.push(`tick ${s.lastTickMs} ms (max ${s.maxTickMs}) · saves ${s.saves} · from ${s.loadedFrom || "-"}${rt && rt.readOnly ? " · read-only" : ""}${this.ioBlocked ? " · not saving" : ""}`);
    const st = this.saveStatus();
    if (st) lines.push(st.message);
    return lines.join("\n");
  }

  /** Anything for the debug tooltip? */
  hasErrors() {
    const rt = this.world && this.world.rt;
    return this.errorCount > 0 || !!(rt && Array.isArray(rt.errors) && rt.errors.length) || !!this.saveStatus();
  }
}
