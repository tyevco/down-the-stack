// Node module-resolution hooks (registered by register.mjs; they run on the loader thread).
//
//  - bare "gpui-kit", "gpui", "gpui-base", "gpui-shell", "gpui-fps", "gpui-component", "herdr"
//    resolve to the mocks in this folder, from anywhere;
//  - "fs/promises" imported from mod code (a file under a mods/ folder) resolves to the
//    capability-checked in-memory mock; other Node built-ins herdr lacks are refused for mod code;
//  - a "?mockgen=N" query on a mod file propagates to its relative imports, so the harness can
//    load a fresh copy of a whole mod module graph (a VM restart) while the mocks stay shared.

const here = new URL("./", import.meta.url);
const MAP = {
  "gpui-kit": "gpui-kit.mjs",
  gpui: "gpui.mjs",
  "gpui-base": "gpui-base.mjs",
  "gpui-shell": "gpui-shell.mjs",
  "gpui-fps": "gpui-fps.mjs",
  "gpui-component": "gpui-component.mjs",
  herdr: "herdr.mjs",
};
// herdr's standard modules (typings.rs "declare module" list); Node's same-named built-ins stand in.
const HERDR_STD = new Set(["buffer", "path", "url", "crypto", "zlib", "console", "process", "os", "net"]);

const isModUrl = (u) => typeof u === "string" && u.startsWith("file:") && /\/mods\//.test(u) && !u.includes("/node_modules/");

export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(MAP, specifier)) {
    return { url: new URL(MAP[specifier], here).href, shortCircuit: true };
  }
  const parent = context.parentURL;
  const fromMod = isModUrl(parent);
  if (fromMod) {
    if (specifier === "fs/promises") return { url: new URL("fs-promises.mjs", here).href, shortCircuit: true };
    if (specifier.startsWith("node:")) throw new Error(`herdr mods cannot import "${specifier}" (no node: modules in QuickJS); imported from ${parent}`);
    if (!specifier.startsWith(".") && !specifier.startsWith("/") && !HERDR_STD.has(specifier)) {
      throw new Error(`herdr mods cannot import "${specifier}": not a herdr module (gpui-kit, gpui-base, herdr, fs/promises, ...); imported from ${parent}`);
    }
    if (/\.json(\?|$)/.test(specifier)) throw new Error(`herdr mods cannot import JSON ("${specifier}"); QuickJS has no JSON modules (ARCHITECTURE §2.14)`);
  }
  const result = await nextResolve(specifier, context);
  if (parent && result.url.startsWith("file:") && !result.url.includes("?") && specifier.startsWith(".")) {
    const q = new URL(parent).search;
    if (q.includes("mockgen=")) return { ...result, url: result.url + q };
  }
  return result;
}
