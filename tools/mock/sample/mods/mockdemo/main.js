// A tiny, valid herdr mod used by the mock's own tests and as a usage example.
// It follows the Down the Stack rules: no host calls at top level, timers in init, hex colors only,
// sized images, filtered children, ids on animated elements.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, agents, theme, settings, checking, nextCommand, run } from "herdr";

const ASSETS = "mods/mockdemo";

export default class MockDemo extends View {
  init(p, cx) {
    this.props = props() ?? p ?? {};
    this.ticks = 0;
    this.width = 960;
    this.clicks = 0;
    if (checking()) return;
    cx.timer.every(1000, (cx) => {
      this.ticks++;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.last = c;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    const zoom = Number(settings()?.zoom) || 1;
    if (!this.props?.role) return div().child("Mock demo");
    const list = agents();
    const rows = list.map((a) =>
      h_flex()
        .id(`row-${a.address}`)
        .gap(6)
        .child(div().w(8).h(8).rounded_full().bg(a.status === "working" ? t.working : t.idle))
        .child(div().text_color(t.foreground).truncate().child(a.title || a.address))
        .on_click((e, cx) => {
          this.clicks++;
          run("agent.focus", { terminal: a.address });
          cx.notify();
        }),
    );
    return div()
      .id("root")
      .relative()
      .size_full()
      .bg(t.chrome)
      .p(8)
      .on_size_change((s, cx) => {
        this.width = s.width / zoom;
        cx.notify();
      })
      .child(
        h_flex()
          .gap(8)
          .child(image(`${ASSETS}/art/hero.svg`).id("hero").w(24).h(24).loop("top", { from: 0, to: -2 * zoom, period: 1200 }))
          .child(svg(`${ASSETS}/art/gem.svg`).size(12).text_color(t.accent))
          .child(div().id("face").text_size(11).font_family("JetBrains Mono").frames([">_", "> "], 530))
          .child(div().text_color(t.muted).child(`ticks ${this.ticks} · width ${Math.round(this.width)}${this.last ? ` · ${this.last}` : ""}`)),
      )
      .children(rows)
      .when(this.clicks > 0, (el) => el.child(div().id("clicked").child(`clicked ${this.clicks}`)));
  }
}
