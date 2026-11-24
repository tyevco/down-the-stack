// Mock of herdr's "gpui-kit" (and its alias "gpui"): exactly the kit exports from
// tools/api-allowlist.json — View, div, svg, image, list, uniform_list, PathBuilder, Background.

import "./globals.mjs";
import { element, NODE, PathBuilder, Background, checkListArgs } from "./elements.mjs";
import { View } from "./view.mjs";

export { View, PathBuilder, Background };

export const div = () => element("div");
export const svg = (path) => element("svg", { src: String(path) });
export const image = (path) => element("image", { src: String(path) });

const RANGE_HINT = "once per visible range, not once per item";

function lazyList(name, perItem) {
  return (id, count, getKey, render) => {
    const shape = name + "(id, item_count, get_key, render)";
    checkListArgs(shape, count, getKey, render, perItem ? "once per item on screen, with the item's index" : RANGE_HINT);
    const el = element(name, { id: String(id) });
    el[NODE].list = { count, getKey, render, perItem, sizes: null };
    return el;
  };
}

export const list = lazyList("list", true);
export const uniform_list = lazyList("uniform_list", false);
