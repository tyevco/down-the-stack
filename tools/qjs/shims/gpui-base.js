// QuickJS-compatible stand-in for herdr's "gpui-base": the exports the mod imports (h_flex, v_flex,
// Input, InputState, ScrollHandle) plus inert stand-ins for the common controls.
import { element, nextHandle, View } from "gpui-kit";

export { View };
export const h_flex = () => element("h_flex");
export const v_flex = () => element("v_flex");

const withId = (type) => ({ new: (id) => element(type, String(id)) });
export const Button = withId("Button");
export const Link = withId("Link");
export const Checkbox = withId("Checkbox");
export const Switch = withId("Switch");
export const Tabs = withId("Tabs");
export const Tab = withId("Tab");
export const Progress = withId("Progress");
export const Radio = withId("Radio");
export const Toggle = withId("Toggle");

/** Input.new(state) — herdr's stateful text input element. */
export const Input = { new: (state) => { if (!state || typeof state.__handle !== "number") throw new TypeError("Input.new(state) expects an InputState"); return element("Input"); } };

export const InputState = {
  new: (opts) => {
    let value = String((opts && opts.value) || "");
    const handlers = {};
    return {
      __handle: nextHandle(),
      value: () => value,
      set_value: (v) => { value = String(v); },
      on: (evt, fn) => { handlers[evt] = fn; },
      focus: () => {},
      release: () => {},
    };
  },
};

export const ScrollHandle = {
  new: () => {
    let offset = { x: 0, y: 0 };
    return {
      __handle: nextHandle(),
      offset: () => ({ x: offset.x, y: offset.y }),
      set_offset: (o) => { offset = { x: Number(o && o.x) || 0, y: Number(o && o.y) || 0 }; },
      scroll_to_top: () => { offset = { x: offset.x, y: 0 }; },
      scroll_to_bottom: () => {},
      scroll_to_item: () => {},
      bounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      release: () => {},
    };
  },
};
