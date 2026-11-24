// Wall-clock bounds for the engine tests (the convention of test/view-stage.test.mjs and
// test/ui-stage.test.mjs). `node --test` runs the test files in parallel, and a loaded machine
// stretches V8 timings several times over, so a strict budget there fails by chance. The strict
// bound applies only with PERF=1 (`PERF=1 npm test`); otherwise only a generous bound fails (10x
// the strict one: a hang or a runaway loop). The measured time always goes to the test output.
//
//   within(t, ms, strictMs, label)   t: the node:test context (t.diagnostic)

import assert from "node:assert/strict";

export const PERF = process.env.PERF === "1";
export const SLACK = PERF ? 1 : 10;

/** Asserts `ms` < strictMs (PERF=1) or < 10 x strictMs, and prints the measurement. */
export function within(t, ms, strictMs, label) {
  const bound = strictMs * SLACK;
  const note = PERF ? "PERF=1" : `${strictMs} with PERF=1`;
  if (t && typeof t.diagnostic === "function") t.diagnostic(`${label}: ${ms.toFixed(2)} ms (bound ${bound} ms; ${note})`);
  assert.ok(ms < bound, `${label}: ${ms.toFixed(1)} ms (bound ${bound} ms; ${note})`);
}
