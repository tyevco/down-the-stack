// Usage: node --import ./tools/mock/register.mjs script.mjs
// (or `import "./tools/mock/register.mjs"` first, then load mod code with dynamic import()).
// Maps herdr's module names to the mocks in this folder; see hooks.mjs and README.md.

import { register } from "node:module";

const KEY = Symbol.for("down-the-stack.mock.hooks");
if (!globalThis[KEY]) {
  Object.defineProperty(globalThis, KEY, { value: true });
  register("./hooks.mjs", import.meta.url);
}
