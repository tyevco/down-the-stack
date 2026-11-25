// Gates a test can only run on a machine that has something this repo does not ship: herdr's
// source tree ($HERDR_SRC, tools/mock/config.mjs), Playwright with Chromium, the QuickJS-ng
// devDependencies, a generated file. A test that cannot run one says so in one line
// ("SKIPPED GATE: <what> (<why>)") instead of skipping silently, and STRICT_GATES=1 turns every
// such skip into a failure (a machine that is meant to run them all, such as CI).
//
//   import { skipGate, herdrSource } from "../tools/mock/gates.mjs";
//   test("…", (t) => { if (!herdrSource()) return skipGate(t, "programs.json matches herdr's", herdrMissing()); … });

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HERDR_SRC } from "./config.mjs";

export { HERDR_SRC };
/** STRICT_GATES=1: a gate that cannot run fails instead of skipping. */
export const STRICT_GATES = process.env.STRICT_GATES === "1";

/** The line a skipped gate prints (and its skip reason). */
export function gateLine(what, why) {
  return `SKIPPED GATE: ${what} (${why})`;
}

/**
 * The gate `what` cannot run here because of `why`: prints one line and skips the test `t`, or,
 * under STRICT_GATES=1, fails it. Returns undefined (write `return skipGate(t, …)`).
 */
export function skipGate(t, what, why) {
  const line = gateLine(what, why);
  if (STRICT_GATES) assert.fail(`${line}; STRICT_GATES=1 makes a skipped gate a failure`);
  console.log(`${line}; STRICT_GATES=1 makes this a failure`);
  t.skip(line);
  return undefined;
}

/** The herdr source tree when it is there (its defaults/ and src/), else null. */
export function herdrSource() {
  try {
    return fs.statSync(path.join(HERDR_SRC, "defaults")).isDirectory() && fs.statSync(path.join(HERDR_SRC, "src")).isDirectory() ? HERDR_SRC : null;
  } catch {
    return null;
  }
}

/** Why a herdr-source gate cannot run. */
export function herdrMissing() {
  return `herdr 0.1.17 source not found at ${HERDR_SRC}; set HERDR_SRC to a checkout`;
}
