// Paths and the asset map shared by every part of the mock.
//
// herdr resolves image()/svg() paths against the app home (~/.config/herdr-app). The mock's app
// home is the virtual folder APP_HOME; `assetRoots` maps its sub-folders onto real folders so the
// validator can check that art exists and the preview can inline it.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const MOCK_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TOOLS_DIR = path.dirname(MOCK_DIR);
export const REPO = path.dirname(TOOLS_DIR);
export const MODS_DIR = path.join(REPO, "mods");
export const OUT_DIR = path.join(REPO, "out");
/**
 * Read-only herdr-app 0.1.17 source checkout (the shipped program icons; the tests' herdr gates
 * read its defaults and src): $HERDR_SRC, else a `herdrdev/herdr-app` checkout next to this repo.
 * tools/mock/gates.mjs says when a test cannot read it.
 */
export const HERDR_SRC_DEFAULT = path.resolve(REPO, "..", "herdrdev", "herdr-app");
export const HERDR_SRC = process.env.HERDR_SRC || HERDR_SRC_DEFAULT;

/** herdr's appHome() and home() in the mock. Both are virtual (in-memory FS). */
export const APP_HOME = "/mock/home";
export const USER_HOME = "/mock/user";

/** prefix (relative to the app home) → real directory. Longest prefix wins. */
export const assetRoots = new Map([
  ["mods/down-the-stack", path.join(MODS_DIR, "down-the-stack")],
  ["icons", path.join(HERDR_SRC, "defaults", "icons")],
]);

/** Map `mods/<name>` (or any prefix) onto a real folder, e.g. for a test mod. */
export function setAssetRoot(prefix, dir) {
  assetRoots.set(String(prefix).replace(/^\/+|\/+$/g, ""), dir);
}

/**
 * Resolve an asset path the way herdr does (relative to the app home) onto the real disk.
 * Returns { real } or { error } (string). Never throws.
 */
export function resolveAsset(p) {
  if (typeof p !== "string" || p.length === 0) return { error: "empty asset path" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return { error: `asset path "${p}" is a URL; herdr would fetch it over the network (use a file under the app home)` };
  let rel = p;
  if (rel.startsWith("/")) {
    if (rel.startsWith(APP_HOME + "/")) rel = rel.slice(APP_HOME.length + 1);
    else return { error: `asset path "${p}" is absolute; herdr resolves image()/svg() paths relative to the app home (write "mods/<mod>/...")` };
  }
  if (rel.split("/").includes("..")) return { error: `asset path "${p}" contains ".."; herdr refuses it` };
  rel = path.posix.normalize(rel).replace(/^\.\//, "");
  let best = null;
  for (const [prefix, dir] of assetRoots) {
    if ((rel === prefix || rel.startsWith(prefix + "/")) && (!best || prefix.length > best[0].length)) best = [prefix, dir];
  }
  if (!best) return { error: `asset path "${p}" is not under any mapped app-home folder (${[...assetRoots.keys()].join(", ")})` };
  const real = path.join(best[1], rel.slice(best[0].length));
  return { real };
}

/** True if a file path or file: URL belongs to mod code (anything inside a `mods/` folder). */
export function isModPath(p) {
  if (!p) return false;
  const s = String(p);
  return /\/mods\//.test(s) && !s.includes("/node_modules/");
}

export function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
