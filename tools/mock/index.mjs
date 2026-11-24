// Public API of the mock herdr runtime (for tests, tools/check.mjs and tools/preview).
// Mods themselves only ever import "gpui-kit" / "gpui-base" / "herdr" (mapped by register.mjs).

export { mountMod, mountView, mounted, tickAll, reloadAll, globalErrors, globalWarnings, walkLive, Mounted, BUDGET, clearAssetCache } from "./harness.mjs";
export {
  S as state, setFixture, updateFixture, fixture, defaultFixture, checkFixture, setChecking, resetState,
  setClock, mockNow, flush, report, clock,
} from "./state.mjs";
export { advanceTimers as advanceTimers, View } from "./view.mjs";
export { serialize, isElement, nodeOf } from "./elements.mjs";
export { memfs } from "./memfs.mjs";
export { resolveTheme, baseTheme } from "./theme.mjs";
export { COMMANDS } from "./herdr-commands.mjs";
export { APP_HOME, USER_HOME, REPO, MODS_DIR, OUT_DIR, setAssetRoot, resolveAsset } from "./config.mjs";
export { sampleFixture, agent, paneFor, terminalFor, PROGRAMS, readLayout } from "./samples.mjs";
export { resetStorage } from "./globals.mjs";

import { S, deliver, flush as flushAll } from "./state.mjs";
/** Recorded host calls: run, openOverlay, closeOverlay, notify, setAgentOrder, playSound, ... */
export const calls = () => S.calls;
/** Deliver a command to every mounted copy of a mod (like keys.json "<mod>:<command>"). */
export async function sendCommand(cmd, { mod = "mapledr" } = {}) {
  for (const c of S.copies) if (c.alive && c.modName === mod && !c.hidden) deliver(c, cmd);
  await flushAll();
}
