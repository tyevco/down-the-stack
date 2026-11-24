// A mock herdr window around the mod's blocks, for preview.png and layout review:
//
//   ┌ sidebar ───────┬ tab bar ─────────────────────────────────┐
//   │ brand          │ ┌ nameplate ┐ ┌ nameplate ┐             │
//   │ party (mod)    │ │ terminal  │ │ terminal  │             │
//   │                │ └───────────┘ └───────────┘             │
//   │                ├ stage (mod) ─────────────────────────────┤
//   │ footer         ├ status bar ──────────────────────────────┤
//
// Sizes come from layouts/Down-the-Stack.json when it exists (sidebar / brand / sidebar-footer / stage /
// hud / status / tab-bar nodes, the party block's weight share against herdr's spaces list, the
// work-body padding and gap, and the pane-frame header height), else defaults. Each mod block
// holds a recorded tree.

import { newContext, treeFragment, documentHtml } from "./render.mjs";
import { resolveTheme } from "../mock/theme.mjs";
import { readLayout } from "../mock/samples.mjs";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// partyShare: the party block's share of the sidebar's list column (the rest goes to herdr's
// spaces list); padding/gap: around and between the terminal panes.
export const WINDOW_DEFAULTS = { width: 1440, height: 900, sidebar: 248, tabBar: 38, status: 26, stage: 200, header: 34, brand: 44, footer: 34, hud: 0, partyShare: 1, partyFirst: true, padding: 6, gap: 6 };

function findNode(node, pred) {
  if (!node || typeof node !== "object") return null;
  if (pred(node)) return node;
  for (const c of node.children ?? []) { const f = findNode(c, pred); if (f) return f; }
  return null;
}
const px = (n) => (n && typeof n.size?.px === "number" ? n.size.px : null);

/** Block sizes from a layout JSON (herdr layout schema) over the defaults. */
export function layoutSizes(layout = readLayout(), over = {}) {
  const s = { ...WINDOW_DEFAULTS };
  if (layout) {
    s.sidebar = px(findNode(layout, (n) => n.id === "sidebar")) ?? s.sidebar;
    s.stage = px(findNode(layout, (n) => n.id === "stage")) ?? s.stage;
    s.status = px(findNode(layout, (n) => n.id === "status")) ?? s.status;
    s.tabBar = px(findNode(layout, (n) => n.id === "tabs")) ?? s.tabBar;
    const hud = findNode(layout, (n) => n.id === "hud");
    s.hud = hud && !hud.hidden ? px(hud) ?? 26 : 0;
    const frame = findNode(layout, (n) => n.content && n.content.tab && n.content.pane);
    s.header = frame?.content?.pane?.header?.height ?? s.header;
    s.brand = px(findNode(layout, (n) => n.id === "brand")) ?? s.brand;
    s.footer = px(findNode(layout, (n) => n.id === "sidebar-footer")) ?? s.footer;
    const body = findNode(layout, (n) => n.id === "work-body");
    if (typeof body?.padding === "number") s.padding = body.padding;
    if (typeof body?.gap === "number") s.gap = body.gap;
    // The party block shares its column with siblings by weight (e.g. spaces 1 : party 1.4).
    const isParty = (c) => c.content?.mod === "mapledr" && c.content?.props?.role === "party";
    const column = findNode(layout, (n) => (n.children ?? []).some(isParty));
    if (column) {
      const weight = (c) => (c.hidden ? 0 : typeof c.size?.weight === "number" ? c.size.weight : c.size?.px != null ? 0 : 1);
      const total = column.children.reduce((a, c) => a + weight(c), 0);
      const idx = column.children.findIndex(isParty);
      if (total > 0) s.partyShare = weight(column.children[idx]) / total;
      s.partyFirst = idx === 0;
    }
  }
  return { ...s, ...over };
}

const TERMINAL_LINES = [
  ["$ ", "npm test"],
  ["", "  ✓ formulas › reference table (42 ms)"],
  ["", "  ✓ items › affix rules (18 ms)"],
  ["", "  ✓ combat › kill pace on-level (311 ms)"],
  ["", ""],
  ["", "  Tests: 3 passed, 3 total"],
  ["$ ", "git status --short"],
  ["", " M src/auth/session.ts"],
  ["$ ", "▌"],
];

function terminalHtml(t, lines = TERMINAL_LINES) {
  const rows = lines.map(([p, s]) => `<div style="white-space:pre;overflow:hidden"><span style="color:${t.ansi2}">${esc(p)}</span>${esc(s)}</div>`).join("");
  return `<div style="flex:1 1 0;min-height:0;padding:12px 14px;background:${t.background};color:${t.terminal_foreground};font:13px/1.5 'DejaVu Sans Mono',monospace;overflow:hidden">${rows}</div>`;
}

/**
 * Compose the window. Options:
 *  { theme, zoom, sizes (layoutSizes overrides), layout, title,
 *    party: tree, stage: tree, hud: tree, nameplates: [tree|null ...],
 *    panes: [{ title, focused, lines }] (one per nameplate; default 2 panes) }
 * Returns { html, sizes, blocks } where blocks gives each mod block's size (window px) so callers can
 * render trees at exactly that size.
 */
export function composeWindow(opts = {}) {
  const t = opts.theme ?? resolveTheme("graphite");
  const zoom = opts.zoom ?? 1;
  const S = layoutSizes(opts.layout, opts.sizes);
  const ctx = newContext({ zoom, theme: t });
  const nPanes = Math.max(2, opts.nameplates?.length ?? 0);
  const panes = opts.panes ?? Array.from({ length: nPanes }, (_, i) => ({ title: `agent ${i + 1}`, focused: i === 0 }));
  // The layout's 1 px divider sits between the sidebar and the work column (not inside the sidebar,
  // where the party block would paint over it).
  const workW = S.width - S.sidebar - 1;
  const paneAreaH = S.height - S.tabBar - S.stage - S.status - S.hud;
  const paneW = Math.floor((workW - 2 * S.padding - (panes.length - 1) * S.gap) / panes.length);
  const listsH = S.height - S.brand - S.footer;
  const partyH = Math.round(listsH * S.partyShare);
  const spacesH = listsH - partyH;
  const blocks = {
    party: { width: S.sidebar, height: partyH },
    stage: { width: workW, height: S.stage },
    hud: { width: workW, height: S.hud },
    nameplate: { width: paneW, height: S.header },
  };
  const block = (tree, w, h, placeholder) =>
    `<div class="block" style="width:${w}px;height:${h}px;flex:none">${tree ? treeFragment(tree, ctx) : `<div style="padding:8px;color:${t.dim};font-size:12px">${esc(placeholder)}</div>`}</div>`;

  // herdr's own spaces list, sharing the sidebar column with the party block (layout weights).
  const spaces = spacesH > 0
    ? `<div style="height:${spacesH}px;flex:none;overflow:hidden;padding:8px 10px;font-size:12px;color:${t.muted}">
        <div style="font-size:10px;letter-spacing:.08em;color:${t.dim};padding:2px 4px 6px">SPACES</div>
        ${["webapp", "api", "docs"].map((n, i) => `<div style="padding:4px 6px;border-radius:6px;${i === 0 ? `background:${t.selected};color:${t.foreground}` : ""}">${n}</div>`).join("")}
      </div>`
    : "";

  const tabs = ["webapp", "api", "docs"].map((n, i) =>
    `<div style="padding:4px 12px;border-radius:6px;font-size:12px;${i === 0 ? `background:${t.raised};color:${t.foreground}` : `color:${t.muted}`}">${n}</div>`).join("");

  const paneHtml = panes.map((p, i) => {
    const border = p.focused ? (t.mdr_gold ?? t.accent) : t.border;
    return `<div style="width:${paneW}px;display:flex;flex-direction:column;border:1px solid ${border};border-radius:8px;overflow:hidden;background:${t.background}">
      ${block(opts.nameplates?.[i] ?? null, paneW - 2, S.header, `nameplate · ${p.title}`)}
      ${terminalHtml(t, p.lines)}
    </div>`;
  }).join("");

  const body = `<div style="width:${S.width}px;height:${S.height}px;display:flex;background:${t.canvas};overflow:hidden">
  <div style="width:${S.sidebar}px;flex:none;display:flex;flex-direction:column;background:${t.chrome}">
    <div style="height:${S.brand}px;display:flex;align-items:center;gap:8px;padding:0 14px;color:${t.foreground};font-weight:600;font-size:13px">
      <span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:#f0705f"></span><span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:#e5c07b"></span><span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:#a6bd91"></span>
      <span style="margin-left:8px">Down the Stack</span></div>
    ${S.partyFirst ? "" : spaces}
    ${block(opts.party ?? null, blocks.party.width, blocks.party.height, "party (mod block)")}
    ${S.partyFirst ? spaces : ""}
    <div style="height:${S.footer}px;border-top:1px solid ${t.border};color:${t.dim};font-size:11px;padding:9px 14px">~/src/app · main</div>
  </div>
  <div style="width:1px;flex:none;background:${t.border}"></div>
  <div style="width:${workW}px;flex:none;display:flex;flex-direction:column">
    <div style="height:${S.tabBar}px;display:flex;align-items:center;gap:4px;padding:0 8px;background:${t.chrome};border-bottom:1px solid ${t.border}">${tabs}</div>
    <div style="height:${paneAreaH}px;display:flex;gap:${S.gap}px;padding:${S.padding}px">${paneHtml}</div>
    ${block(opts.stage ?? null, workW, S.stage, "stage (mod block)")}
    ${S.hud ? block(opts.hud ?? null, workW, S.hud, "hud") : ""}
    <div style="height:${S.status}px;display:flex;align-items:center;gap:16px;padding:0 12px;background:${t.chrome};border-top:1px solid ${t.border};color:${t.muted};font-size:11px">
      <span>this machine</span><span>main</span><span>agents: ${panes.length}</span><span style="margin-left:auto">⌘K commands</span></div>
  </div>
</div>`;
  return { html: documentHtml({ body, ctx, title: opts.title ?? "herdr window", width: S.width, height: S.height }), sizes: S, blocks };
}
