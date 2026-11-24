// Mock of "gpui-fps".
import "./globals.mjs";
import { element } from "./elements.mjs";

let visible = false;
export const fps_monitor = () => element("fps_monitor");
export const show_fps_monitor = (options) => { visible = true; };
export const hide_fps_monitor = () => { visible = false; };
export const fps_monitor_visible = () => visible;
