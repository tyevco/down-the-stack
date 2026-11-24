// The Termling rig (ARCHITECTURE §6.3, DESIGN §11.1/§11.4): a hero drawn as a tiny terminal in a
// hoodie, built from divs plus three art parts (weapon and hat masks, class accessory). Also the
// 20×24 Forkling (same rig, no gear). Pure: everything comes from the HeroVM; no herdr calls.
//
// Geometry, at scale 1 (rig box 40×48, feet on the bottom edge):
//
//        hat 24×12 (top −3)            accessory per class
//      ┌──────────────────────┐ y 6    body 36×37, r 6, 2 px darker outline
//      │▓ title bar 8 · • • [i]│       title bar 8 px: three 2 px dots + 8 px program icon
//    ▌ │  ┌──── screen ────┐   │ ▐     arms: two 3×8 stubs (one div, left/right borders)
//      │  │      >_        │   │ ⟋     weapon 16×16 mask held on the right
//      │  └────────────────┘   │
//      └──────────────────────┘ y 43
//           ▌        ▌          y 48   legs: two 4×5 stubs (one div, left/right borders)
//
// Element economy matters (the stage budget is 400 elements for 12 heroes): the body div is the
// rig's root and every part is its absolute child, so a full hero is 12 elements (13 with a
// tier-5 weapon edge, 14 with a pin banner). Children are placed in the body's padding box, which starts inside its
// 2 px border; `inner()` converts rig coordinates to that box.

import { div, svg, image } from "gpui-kit";
import { art, MONO, jitter } from "./kit.js";

/** Rig sizes at scale 1. */
export const RIG = { w: 40, h: 48 };
export const FORK = { w: 20, h: 24 };

const BODY = { x: 2, y: 6, w: 36, h: 37, border: 2 };
const EDGE_CYAN = "#6FE6F2"; // tier-5 weapon rim (DESIGN §11.1 "with a cyan edge")

// Class accessory placement in rig coordinates: [left, top, size].
const ACC = {
  intern: [15, 34, 10],        // lanyard and badge under the screen
  refactorer: [22, 33, 12],    // scarf end hanging at the right hip
  hotfixer: [24, 0, 14],       // headlamp on the head, beam to the right
  shellmancer: [24, -7, 14],   // pointy hood tip with the cursor
  forkbinder: [-13, 6, 14],    // floating open book at the left shoulder
  rubberducker: [13, 34, 14],  // raincoat collar under the screen
};

/** Darken (f < 0) or lighten (f > 0) a #rrggbb colour. Other inputs come back unchanged. */
export function shade(hex, f) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}/.test(hex)) return hex;
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (s) => {
    const c = (n >> s) & 255;
    const v = f < 0 ? c * (1 + f) : c + (255 - c) * f;
    return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/** Relative luminance 0..1 of a #rrggbb colour (for picking readable dots/ink). */
export function luma(hex) {
  if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}/.test(hex)) return 0.5;
  const n = parseInt(hex.slice(1, 7), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

const num = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * The hero sprite. Returns the rig's root element (the body), absolutely positioned in its parent.
 *
 * hero: HeroVM (ARCHITECTURE §5 + stage.js "VM additions").
 * env:  { zoom } (loop px are not zoom-scaled by herdr, so loops multiply by it).
 * o:    { feetX, feetY } where the rig stands, in the parent's coordinates (default hero.x / y),
 *       { bob, lunge, blink } motion switches (the stage turns them off for calm and stillness),
 *       { lean } drops the title-bar dots (the stage's crowded-stage element economy).
 * The stage adds handlers and the tooltip on the returned element.
 */
export function renderTermling(hero, env, o = {}) {
  const s = num(hero.scale, 1);
  const z = num(env?.zoom, 1);
  const u = (n) => Math.round(n * s * 100) / 100;
  const col = hero.colors ?? {};
  const hoodie = col.hoodie ?? "#6C8CF5";
  const outline = shade(hoodie, -0.55);
  const bar = col.titleBar ?? shade(hoodie, -0.25);
  const feetX = num(o.feetX, hero.x);
  const feetY = num(o.feetY, hero.y);
  const left = Math.round((feetX - RIG.w * s / 2 + BODY.x * s) * 100) / 100;
  const top = Math.round((feetY - RIG.h * s + BODY.y * s) * 100) / 100;
  // rig coordinates → the body's padding box
  const ix = (x) => u(x - BODY.x - BODY.border);
  const iy = (y) => u(y - BODY.y - BODY.border);

  const body = div().id(hero.key).absolute().left(left).top(top).w(u(BODY.w)).h(u(BODY.h))
    .rounded(u(6)).bg(hoodie).border(u(BODY.border)).border_color(outline)
    .opacity(num(hero.opacity, 1))
    .transition("left", { duration: 900, easing: "ease-out" })
    .transition("opacity", { duration: 300 });
  if (o.lunge) body.loop("left", { from: left * z, to: (left + u(6)) * z, period: 1000, easing: "ease-in-out" });
  else if (o.bob) body.loop("top", { from: top * z, to: (top - u(2)) * z, period: jitter(hero.key, 1200, 41), easing: "ease-in-out" });

  // Arms first so the gear paints over them; both stubs are the side borders of one div.
  body.child(div().absolute().left(ix(-1)).top(iy(22)).w(u(42)).h(u(8))
    .border_l(u(3)).border_r(u(3)).border_color(shade(hoodie, -0.3)));
  body.child(div().absolute().left(ix(11)).top(iy(43)).w(u(18)).h(u(5))
    .border_l(u(4)).border_r(u(4)).border_color(outline));
  // Title bar with three dots (outer two are borders, the middle one a child) and the icon.
  const dot = luma(bar) > 0.6 ? "#00000073" : "#FFFFFFB3";
  body.child(div().absolute().left(0).top(0).w(u(32)).h(u(8)).rounded_t(u(4)).bg(bar));
  if (!o.lean) {
    body.child(div().absolute().left(ix(7)).top(iy(11)).w(u(10)).h(u(2))
      .border_l(u(2)).border_r(u(2)).border_color(dot)
      .child(div().absolute().left(u(2)).top(0).w(u(2)).h(u(2)).bg(dot)));
  }
  const icon = programIcon(hero.programIcon, u(8));
  if (icon) body.child(icon.absolute().left(ix(28)).top(iy(8)));
  // Screen with the face. The blinking cursor is native frames() text while questing.
  const screen = div().absolute().left(ix(6)).top(iy(18)).w(u(28)).h(u(18)).rounded(u(2))
    .bg(col.screen ?? "#1B1B1F").flex().items_center().justify_center()
    .text_size(u(11)).line_height(1).font_family(MONO).font_weight(700).text_color(col.faceInk ?? "#4CC38A")
    .whitespace_nowrap();
  const face = typeof hero.face === "string" && hero.face ? hero.face : ">_";
  if (o.blink && face === ">_") screen.frames([">_", "> "], 530);
  else screen.child(face);
  body.child(screen);
  // Class accessory (full colour), weapon (tinted mask + cyan rim at tier 5), hat (tinted mask).
  const acc = ACC[hero.accessory];
  if (acc) body.child(image(art(`gear/acc-${hero.accessory}.svg`)).absolute().left(ix(acc[0])).top(iy(acc[1])).w(u(acc[2])).h(u(acc[2])));
  const wcls = hero.weapon?.clsId;
  if (wcls) {
    body.child(svg(art(`gear/weapon-${wcls}.svg`)).absolute().left(ix(35)).top(iy(15)).w(u(16)).h(u(16))
      .text_color(hero.weapon.color ?? "#9AA3AD"));
    if (hero.weapon.edge) {
      body.child(svg(art(`gear/weapon-${wcls}-edge.svg`)).absolute().left(ix(35)).top(iy(15)).w(u(16)).h(u(16))
        .text_color(EDGE_CYAN));
    }
  }
  // Pinned (D§2.8): a small banner on the hero's back, its pole behind the left shoulder.
  if (hero.pinned && !o.lean) {
    body.child(image(art("fx/banner.svg")).absolute().left(ix(-8)).top(iy(-8)).w(u(8)).h(u(12)));
  }
  const tier = hero.hat?.tier;
  if (tier >= 1 && tier <= 5) {
    body.child(svg(art(`gear/hat-${tier}.svg`)).absolute().left(ix(8)).top(iy(-3)).w(u(24)).h(u(12))
      .text_color(hero.hat.color ?? "#E86F9C"));
  }
  return body;
}

/** herdr's program icon: a tinted mask when `tint`, else the full-colour image (patterns.md §1.4). */
export function programIcon(p, size) {
  if (!p || typeof p.path !== "string" || !p.path) return null;
  return p.tint
    ? svg(p.path).w(size).h(size).text_color(p.color ?? "#FFFFFF")
    : image(p.path).w(size).h(size);
}

/**
 * A Forkling (sub-agent): a 20×24 Termling without gear, in its parent's colours. Returns the
 * body element (absolute); the stage adds the click and tooltip. `fk` = HeroVM.forklings[i].
 */
export function renderForkling(fk, hero, env, o = {}) {
  const col = hero.colors ?? {};
  const hoodie = col.hoodie ?? "#6C8CF5";
  const outline = shade(hoodie, -0.55);
  const feetX = num(o.feetX, fk.x);
  const feetY = num(o.feetY, fk.y);
  const left = Math.round((feetX - 9) * 100) / 100;
  const top = Math.round((feetY - 24 + 2) * 100) / 100;
  const z = num(env?.zoom, 1);
  const body = div().id(fk.key).absolute().left(left).top(top).w(18).h(19).rounded(4)
    .bg(hoodie).border(1).border_color(outline).border_t(3)
    .transition("left", { duration: 900, easing: "ease-out" });
  if (o.bob) body.loop("top", { from: top * z, to: (top - 1) * z, period: jitter(fk.key, 900, 43), easing: "ease-in-out" });
  // padding box starts after the 1 px side borders and the 3 px "title bar" top border
  body.child(div().absolute().left(1).top(1).w(14).h(10).rounded(1).bg(col.screen ?? "#1B1B1F")
    .flex().items_center().justify_center().text_size(7).line_height(1).font_family(MONO).font_weight(700)
    .text_color(fk.status === "blocked" ? "#F2A93B" : col.faceInk ?? "#4CC38A").whitespace_nowrap()
    .child(typeof fk.face === "string" && fk.face ? fk.face : ">_"));
  body.child(div().absolute().left(3).top(16).w(10).h(3).border_l(3).border_r(3).border_color(outline));
  return body;
}
