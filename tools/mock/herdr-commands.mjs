// herdr's app command table, parsed from tools/mock/herdr-commands.md (a copy of herdr's
// generated docs/commands.md): every "## `name`" heading, its description and its argument table.

import fs from "node:fs";
import path from "node:path";
import { MOCK_DIR } from "./config.mjs";

function parse(md) {
  const out = [];
  let cur = null;
  for (const line of md.split("\n")) {
    const h = /^## `([^`]+)`\s*$/.exec(line);
    if (h) {
      cur = { name: h[1], args: [], about: "" };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const row = /^\|\s*`([^`]+)`\s*\|\s*(yes|no)\s*\|/.exec(line);
    if (row) {
      cur.args.push({ name: row[1], required: row[2] === "yes" });
      continue;
    }
    if (!cur.about && line.trim() && !line.startsWith("|") && !line.startsWith("#") && !line.startsWith("[")) cur.about = line.trim();
  }
  return out;
}

export const COMMANDS = parse(fs.readFileSync(path.join(MOCK_DIR, "herdr-commands.md"), "utf8"));
export const COMMAND_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
/** Namespaces that belong to the app: "<ns>.<x>" with one of these is never a mod command. */
export const APP_NAMESPACES = new Set(COMMANDS.map((c) => c.name.split(".")[0]));

/** herdr's commands::validate_args (throws the same messages). */
export function validateArgs(c, args) {
  const valid = c.args.length ? c.args.map((a) => a.name).join(", ") : "none";
  if (args === null || args === undefined) return;
  if (typeof args !== "object" || Array.isArray(args)) throw new TypeError(`${c.name}: arguments must be an object; valid arguments: ${valid}`);
  const unknown = Object.keys(args).filter((k) => !c.args.some((a) => a.name === k));
  if (unknown.length) throw new TypeError(`${c.name}: unknown argument(s): ${unknown.join(", ")}; valid arguments: ${valid}`);
  for (const [k, v] of Object.entries(args)) {
    if (["id", "pane", "space", "terminal", "target"].includes(k) && typeof v !== "string" && v !== null && v !== undefined) {
      throw new TypeError(`${c.name}: argument ${k} must be a string (or null to omit it)`);
    }
  }
}

/** herdr's commands::missing: the first required argument that is absent or blank. */
export function missingArg(c, args) {
  for (const a of c.args) {
    if (!a.required) continue;
    const v = args?.[a.name];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return a.name;
  }
  return null;
}
