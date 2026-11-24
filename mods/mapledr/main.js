// Down the Stack (mod "mapledr"): one mod, six roles. The layout and the overlays give each copy
// props { role }:
//   stage      the dungeon strip under the terminals          (ui/stage.js)
//   party      the left-sidebar party list                    (ui/party.js)
//   nameplate  every pane header ({pane, terminal} from herdr) (ui/nameplate.js)
//   hud        the thin optional strip                        (ui/hud.js)
//   sheet      the character sheet dialog ({heroId, overlay}) (ui/sheet.js)
//   herd       the Herd panel dialog ({tab?, overlay})        (ui/herdpanel.js)
//
// Every copy shares one GameHost (host.js, module scope). Each copy (outside herdr-app check):
//  - runs a 1 s timer: host.pump() advances the world at most once per 900 ms across all copies and
//    broadcasts run("mapledr.tick"); a copy that still shows an old version 1.5 s later (a missed
//    broadcast, a hidden copy) re-renders itself;
//  - listens on nextCommand(): "tick" → re-render; the key commands mapledr.sheet / .herd / .calm
//    reach every shown copy, so the first copy to claim one handles it centrally (host.hotkey) and
//    the others only re-render. The roles' own command() handlers are not used for these three;
//    any other command is passed to the role.
// render() delegates to the role inside a try/catch: a renderer bug shows a small error chip
// (with the debug tooltip) instead of breaking herdr's chrome, and is rethrown once from the next
// timer tick so herdr logs it (`herdr-app status`; the mock check fails on it). A view builder
// that throws (host.view answers null, which also means "still loading") shows the same chip
// instead of an endless loading state; the party then also lists herdr's agents plainly, since
// this layout has no other agent list. Save trouble (host.saveStatus) puts a small notice on the
// stage until the player dismisses it.

import { View, div } from "gpui-kit";
import { props, checking, nextCommand, agents, run } from "herdr";
import { getHost } from "./host.js";
import { T, kids } from "./ui/kit.js";
import Stage from "./ui/stage.js";
import Party from "./ui/party.js";
import Nameplate from "./ui/nameplate.js";
import Hud from "./ui/hud.js";
import Sheet from "./ui/sheet.js";
import HerdPanel from "./ui/herdpanel.js";
import { useDialogs } from "./ui/party.js";

const ROLES = { stage: Stage, party: Party, nameplate: Nameplate, hud: Hud, sheet: Sheet, herd: HerdPanel };
const HOTKEYS = { sheet: true, herd: true, calm: true };
// Copies that live as long as the layout; pane headers and dialogs pump only as a fallback.
const STABLE = { stage: true, party: true, hud: true };
const STALE_MS = 1500;
// Roles whose view failure shows the error chip (a nameplate falls back to herdr's plain header).
const VIEW_CHIP = { stage: true, party: true, hud: true, sheet: true, herd: true };
const PLAIN_ROWS = 12;

const msgOf = (e) => String((e && e.message) || e);

export default class Mapledr extends View {
  init(p, cx) {
    const pr = props() || p || {};
    this.props = pr;
    this.roleName = typeof pr.role === "string" ? pr.role : null;
    this.host = getHost();
    this.host.ensure(cx);
    useDialogs(this.host); // sheet / Herd clicks in every role go through the host's dialog registry
    this.seen = -1;
    this.staleSince = null;
    this.failure = null; // { message, role, reported }
    this.token = this.host.attach({ role: this.roleName, overlay: pr.overlay, heroId: pr.heroId, tab: pr.tab });
    const R = this.roleName && Object.prototype.hasOwnProperty.call(ROLES, this.roleName) ? ROLES[this.roleName] : null;
    this.role = null;
    if (R) {
      try {
        this.role = new R();
        if (typeof this.role.init === "function") this.role.init(pr, cx, this.host);
      } catch (e) {
        this.fail(e, "init");
      }
    }
    if (checking()) return;
    cx.timer.every(1000, (tcx) => this.onTimer(tcx));
    cx.spawn(async (tcx) => {
      for (;;) {
        const c = await nextCommand();
        try {
          this.onCommand(c, tcx);
        } catch (e) {
          this.host.error(`command ${c}`, e, true);
        }
        tcx.notify();
      }
    });
  }

  /** The 1 s timer: pump the shared world, catch up a stale copy, surface errors once. */
  onTimer(cx) {
    const host = this.host;
    const now = Date.now();
    host.ensure(cx);
    const changed = host.pump(now, STABLE[this.roleName] === true);
    if (!changed && this.seen !== host.version) {
      if (this.staleSince == null) this.staleSince = now;
      else if (now - this.staleSince >= STALE_MS) { this.staleSince = now; cx.notify(); }
    }
    // herdr logs a throwing timer ("error in script task") and keeps it running: rethrow each
    // distinct problem once, after the work above is done.
    const problems = host.takeUnreported().map((x) => `${x.where}: ${x.message}`);
    const f = this.failure;
    if (f && !f.reported) {
      f.reported = true;
      problems.unshift(`${this.roleName || "mod"} ${f.phase} failed: ${f.message}`);
    }
    if (problems.length) throw new Error(`${problems.join("; ")}`);
  }

  /** A command from nextCommand(): "tick" just re-renders (the caller notifies). */
  onCommand(c, cx) {
    if (c === "tick") return;
    if (HOTKEYS[c]) {
      if (this.host.claim(c)) this.host.hotkey(c);
      return;
    }
    if (this.role && typeof this.role.command === "function") this.role.command(c, cx);
  }

  fail(e, phase) {
    const message = msgOf(e);
    if (!this.failure || this.failure.message !== message) this.failure = { message, phase, reported: false };
    this.host.error(`${this.roleName || "mod"} ${phase}`, e);
  }

  render(cx) {
    const host = this.host;
    this.seen = host.version;
    this.staleSince = null;
    if (!this.role) return neutral(this.roleName);
    let el;
    try {
      el = this.role.render(cx);
    } catch (e) {
      this.fail(e, "render");
      return errorChip(this.roleName, host.debugText());
    }
    // The role's view builder threw: its null reads as "loading" to the role, so say what it is.
    const viewError = VIEW_CHIP[this.roleName] && typeof host.viewError === "function" ? host.viewError(this.roleName) : null;
    if (viewError) {
      return this.roleName === "party" ? plainParty(host.debugText()) : errorChip(this.roleName, host.debugText());
    }
    if (this.roleName === "stage" && el && typeof el.child === "function") {
      // A notice while the save is in trouble (until dismissed), and a tiny debug dot while
      // anything went wrong (tooltip only).
      const st = typeof host.saveStatus === "function" ? host.saveStatus() : null;
      if (st && host.saveNoticeSeen !== st.message) el = el.child(saveNotice(st, host));
      if (host.hasErrors()) el = el.child(debugDot(host.debugText()));
    }
    return el;
  }

  async close(cx) {
    try {
      if (this.role && typeof this.role.close === "function") this.role.close(cx);
    } catch (e) {
      this.host.error(`${this.roleName || "mod"} close`, e);
    }
    const last = this.host.detach(this.token);
    // The last copy flushes; so does a closing stage / party / HUD copy (on quit herdr closes the
    // copies one by one, and a leaked copy token must not keep the last flush from happening).
    // flush() writes only a dirty world, so this is cheap.
    if (last || STABLE[this.roleName] === true) {
      try { await this.host.flush(); } catch (e) { this.host.error("flush", e); }
    }
  }
}

/** No role (herdr-app check, or a block without props): a quiet placeholder. */
function neutral(role) {
  return div().id("mdr-neutral").size_full().flex().items_center().justify_center()
    .text_size(11).text_color("#8A8F98")
    .child(role ? `Down the Stack: no role "${role}"` : "Down the Stack");
}

/** A renderer threw: a small chip instead of the role (details in the tooltip). */
function errorChip(role, tooltip) {
  return div().id("mdr-error").size_full().flex().items_center().px(8).overflow_hidden()
    .child(div().id("mdr-error-chip").flex_none().flex().items_center().gap(6).h(20).px(8).rounded(6)
      .bg("#F2A93B26").border(1).border_color("#F2A93B66")
      .text_size(11).text_color("#F2A93B").whitespace_nowrap()
      .tooltip(String(tooltip || ""))
      .child(`Down the Stack: the ${role || "mod"} view hit a snag`));
}

/** The save is read-only, not being written, or was restored: a chip in the stage's top-right sky (under the lane bar). */
function saveNotice(st, host) {
  const label = String(st.title || "Save trouble");
  return div().id("mdr-save-notice").absolute().top(22).right(8).flex().items_center().gap(6).h(20).px(8).rounded(6)
    .bg("#1B1B1FE6").border(1).border_color("#F2A93B99").cursor_pointer()
    .text_size(11).text_color("#F2A93B").whitespace_nowrap()
    .tooltip(`${st.message}${st.detail ? `\n(${st.detail})` : ""}\nClick to hide this notice.`)
    .on_click((_e, cx) => {
      host.saveNoticeSeen = st.message;
      cx.stop_propagation();
      cx.notify();
    })
    .child(div().size(6).flex_none().rounded_full().bg("#F2A93B"))
    .child(label);
}

/** The party's view failed: herdr's agents as a plain list (this layout has no other one). */
function plainParty(tooltip) {
  const t = T();
  let list = [];
  try { list = agents() || []; } catch (e) { list = []; }
  const DOT = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle };
  const rows = list.filter((a) => a && a.address != null).slice(0, PLAIN_ROWS).map((a, i) => {
    const name = String(a.pane_name || a.title || a.tab_name || a.address);
    return div().id(`mdr-plain-${i}`).flex().items_center().gap(8).h(26).px(10).rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        // agents() lists pane terminals: focus the pane (this layout has no agent block for agent.focus)
        try { run("pane.focus", { terminal: String(a.address) }); } catch (err) { /* gone meanwhile */ }
        cx.stop_propagation();
      })
      .child(div().size(7).flex_none().rounded_full().bg(DOT[a.status] || t.idle))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.fg).child(name));
  });
  return div().id("mdr-plain-party").size_full().flex().flex_col().gap(2).p(8).overflow_hidden()
    .children(kids([
      errorChip("party", tooltip).h(32).flex_none(),
      rows.length ? null : div().px(10).text_size(12).text_color(t.dim).child("No agents running"),
      ...rows,
    ]));
}

/** Debug-only marker: a dim dot in the stage's top-right corner; the details are its tooltip. */
function debugDot(tooltip) {
  return div().id("mdr-debug").absolute().top(3).right(3).size(6).rounded_full().bg("#F2A93B80").tooltip(String(tooltip || ""));
}
