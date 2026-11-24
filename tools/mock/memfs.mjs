// A tiny in-memory POSIX file system shared by herdr's readTextFile/writeTextFile and the mocked
// "fs/promises". Reads of `<APP_HOME>/<mapped prefix>/...` fall through (read-only) to the real
// folders in config.assetRoots, so a mod can read its own shipped files.

import fs from "node:fs";
import path from "node:path";
import { APP_HOME, USER_HOME, resolveAsset } from "./config.mjs";

const P = path.posix;

export class MemFS {
  constructor() { this.reset(); }

  reset() {
    /** abs path → string | Uint8Array */
    this.files = new Map();
    this.dirs = new Set(["/"]);
    for (const d of [USER_HOME, APP_HOME, `${APP_HOME}/data`, `${APP_HOME}/mods`]) this.mkdirp(d);
  }

  norm(p) { return P.normalize(String(p)).replace(/\/+$/, "") || "/"; }

  /** Real file behind a virtual app-home path (read-only fall-through), or null. */
  real(p) {
    const n = this.norm(p);
    if (!n.startsWith(APP_HOME + "/")) return null;
    const r = resolveAsset(n.slice(APP_HOME.length + 1));
    return r.real ?? null;
  }

  mkdirp(d) {
    let cur = "/";
    for (const part of this.norm(d).split("/").filter(Boolean)) {
      cur = P.join(cur, part);
      this.dirs.add(cur);
    }
  }

  isDir(p) {
    const n = this.norm(p);
    if (this.dirs.has(n)) return true;
    const r = this.real(n);
    try { return !!r && fs.statSync(r).isDirectory(); } catch { return false; }
  }

  isFile(p) {
    const n = this.norm(p);
    if (this.files.has(n)) return true;
    const r = this.real(n);
    try { return !!r && fs.statSync(r).isFile(); } catch { return false; }
  }

  /** Returns string|Uint8Array, or undefined when absent. */
  read(p) {
    const n = this.norm(p);
    if (this.files.has(n)) return this.files.get(n);
    const r = this.real(n);
    if (r) { try { return new Uint8Array(fs.readFileSync(r)); } catch { /* absent */ } }
    return undefined;
  }

  readText(p) {
    const v = this.read(p);
    if (v === undefined) return undefined;
    return typeof v === "string" ? v : Buffer.from(v).toString("utf8");
  }

  write(p, data, { mkdirs = false } = {}) {
    const n = this.norm(p);
    const dir = P.dirname(n);
    if (mkdirs) this.mkdirp(dir);
    else if (!this.isDir(dir)) {
      const e = new Error(`ENOENT: no such file or directory, open '${n}'`);
      e.code = "ENOENT";
      throw e;
    }
    this.files.set(n, data);
  }

  unlink(p) {
    const n = this.norm(p);
    if (!this.files.delete(n)) {
      const e = new Error(`ENOENT: no such file or directory, unlink '${n}'`);
      e.code = "ENOENT";
      throw e;
    }
  }

  readdir(p) {
    const n = this.norm(p);
    const names = new Map(); // name → isDir
    const prefix = n === "/" ? "/" : n + "/";
    for (const f of this.files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) names.set(f.slice(prefix.length), false);
    for (const d of this.dirs) if (d !== n && d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) names.set(d.slice(prefix.length), true);
    const r = this.real(n);
    if (r) {
      try { for (const e of fs.readdirSync(r, { withFileTypes: true })) names.set(e.name, e.isDirectory()); } catch { /* none */ }
    }
    if (names.size === 0 && !this.isDir(n)) {
      const e = new Error(`ENOENT: no such file or directory, scandir '${n}'`);
      e.code = "ENOENT";
      throw e;
    }
    return [...names.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  rmdir(p) {
    const n = this.norm(p);
    if (!this.dirs.has(n)) { const e = new Error(`ENOENT: rmdir '${n}'`); e.code = "ENOENT"; throw e; }
    if (this.readdir(n).length) { const e = new Error(`ENOTEMPTY: directory not empty, rmdir '${n}'`); e.code = "ENOTEMPTY"; throw e; }
    this.dirs.delete(n);
  }
}

export const memfs = new MemFS();
