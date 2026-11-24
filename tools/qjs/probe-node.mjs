// V8 side of the builtins phase: probe.js in a fresh vm context (its own built-ins, so herdr's
// sandbox prelude can freeze them without touching Node), with Node's web globals copied in.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ctx = vm.createContext({});
for (const g of ["structuredClone", "queueMicrotask", "TextEncoder", "TextDecoder", "atob", "btoa", "URL", "performance"]) ctx[g] = globalThis[g];
vm.runInContext(fs.readFileSync(path.join(HERE, "shims", "sandbox.js"), "utf8"), ctx);
const r = vm.runInContext(fs.readFileSync(path.join(HERE, "probe.js"), "utf8"), ctx);
process.stdout.write(JSON.stringify(r));
