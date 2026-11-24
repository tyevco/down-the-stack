// Mock of herdr's capability-gated "fs/promises" (what a file under mods/ gets for
// `import ... from "fs/promises"`). Backed by the shared in-memory FS (memfs.mjs).
//
// Capabilities, as in herdr: live app read = [home(), appHome()], write = [appHome()];
// during `herdr-app check`: read = [mod folder, data store], write = [data store].
// A denied path throws synchronously at the call site (not a rejected promise).
// Relative paths: reads resolve against home(), writes against appHome().

import path from "node:path";
import { memfs } from "./memfs.mjs";
import { S, currentCopy, report } from "./state.mjs";
import { APP_HOME, USER_HOME } from "./config.mjs";

const P = path.posix;
const READ_LIMIT = 64 * 1024 * 1024;
const WRITE_LIMIT = 8 * 1024 * 1024;

function roots(kind) {
  const copy = currentCopy();
  const mod = copy?.modName ?? "mapledr";
  if (S.checking) {
    const store = `${APP_HOME}/data/${mod}`;
    return kind === "read" ? [`${APP_HOME}/mods/${mod}`, store] : [store];
  }
  return kind === "read" ? [USER_HOME, APP_HOME] : [APP_HOME];
}

function resolve(p, kind, api) {
  if (typeof p !== "string") throw new TypeError(`fs.${api}(path) expects a string path`);
  if (p.startsWith("~")) throw new TypeError(`fs.${api}: "~" is not expanded; build paths from home() or appHome()`);
  const base = kind === "read" ? (S.checking ? `${APP_HOME}/mods/${currentCopy()?.modName ?? "mapledr"}` : USER_HOME) : APP_HOME;
  const abs = P.resolve(base, p);
  const allowed = roots(kind);
  if (!allowed.some((r) => abs === r || abs.startsWith(r + "/"))) {
    const e = new TypeError(`fs.${api}: "${abs}" is outside every granted ${kind} root (${allowed.join(", ")}); add its directory to capabilities.fs${S.checking ? " (during herdr-app check only the mod folder and its data store are granted)" : ""}`);
    e.code = "fs-denied";
    report("error", "fs-denied", e.message, { copy: currentCopy() });
    throw e;
  }
  if (kind === "write" && abs.startsWith(`${APP_HOME}/mods/`)) {
    report("error", "write-under-mods", `fs.${api}("${abs}") writes inside mods/, which hot-reloads the mod`, { copy: currentCopy() });
  }
  return abs;
}

const enoent = (abs, api) => Object.assign(new Error(`ENOENT: no such file or directory, ${api} '${abs}'`), { code: "ENOENT" });

export function readFile(p, enc) {
  const abs = resolve(p, "read", "readFile");
  const v = memfs.read(abs);
  if (v === undefined) return Promise.reject(enoent(abs, "open"));
  const bytes = typeof v === "string" ? new Uint8Array(Buffer.from(v, "utf8")) : v;
  if (bytes.length > READ_LIMIT) return Promise.reject(new Error("readFile: file is larger than 64 MiB"));
  const utf8 = enc === "utf8" || enc === "utf-8" || enc?.encoding === "utf8" || enc?.encoding === "utf-8";
  return Promise.resolve(utf8 ? Buffer.from(bytes).toString("utf8") : new Uint8Array(bytes));
}

export function writeFile(p, data) {
  const abs = resolve(p, "write", "writeFile");
  if (arguments.length > 2) report("warning", "fs-options", "fs.writeFile takes no options argument in herdr", { copy: currentCopy() });
  if (typeof data !== "string" && !(data instanceof Uint8Array)) return Promise.reject(new TypeError("fs.writeFile(path, data): data must be a string or Uint8Array"));
  const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  if (size > WRITE_LIMIT) return Promise.reject(new Error("writeFile: data is larger than 8 MiB"));
  try { memfs.write(abs, typeof data === "string" ? data : new Uint8Array(data)); } catch (e) { return Promise.reject(e); }
  return Promise.resolve();
}

export function readdir(p, opts) {
  const abs = resolve(p, "read", "readdir");
  let entries;
  try { entries = memfs.readdir(abs); } catch (e) { return Promise.reject(e); }
  if (opts?.withFileTypes) return Promise.resolve(entries.map(([name, dir]) => ({ name, isDirectory: () => dir })));
  return Promise.resolve(entries.map(([name]) => name));
}

export function exists(p) {
  const abs = resolve(p, "read", "exists");
  return Promise.resolve(memfs.isFile(abs) || memfs.isDir(abs));
}

export function unlink(p) {
  const abs = resolve(p, "write", "unlink");
  try { memfs.unlink(abs); } catch (e) { return Promise.reject(e); }
  return Promise.resolve();
}

export function rmdir(p) {
  const abs = resolve(p, "write", "rmdir");
  try { memfs.rmdir(abs); } catch (e) { return Promise.reject(e); }
  return Promise.resolve();
}

export function mkdir(p, opts) {
  const abs = resolve(p, "write", "mkdir");
  if (memfs.isDir(abs)) return opts?.recursive ? Promise.resolve() : Promise.reject(Object.assign(new Error(`EEXIST: file already exists, mkdir '${abs}'`), { code: "EEXIST" }));
  if (!opts?.recursive && !memfs.isDir(P.dirname(abs))) return Promise.reject(enoent(abs, "mkdir"));
  memfs.mkdirp(abs);
  return Promise.resolve();
}

export default { readFile, writeFile, readdir, exists, unlink, rmdir, mkdir };
