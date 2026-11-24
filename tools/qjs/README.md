# QuickJS-ng harness (`npm run qjs`)

Runs the mod in the engine herdr runs it in: QuickJS-ng (quickjs-emscripten's
`@jitl/quickjs-ng-wasmfile-release-sync`, an interpreter, so its times are an upper bound for
herdr's JIT build) with herdr's limits (256 MiB heap, 1 MiB stack) and herdr's sandbox prelude
(`shims/sandbox.js`: no eval / Function, frozen Object/Array/Function/String/Number prototypes).
The Node mock (`tools/mock`, `npm run check`) is stricter about the API but runs in V8 with
nothing frozen; this catches what only the engine shows.

```
npm install                       # once: the devDependencies below
npm run qjs                       # every phase; results in out/qjs/results.json
npm run qjs -- --only fuzz        # one phase (comma-separated list)
npm run qjs -- --only worlds --kinds mid,late --ticks 300
```

Phases: `lint` (acorn scan for engine and sandbox hazards), `builtins` (the same probes in
QuickJS-ng and V8, every difference listed), `modeval` (module evaluation against herdr's
500 ms), `check` (the `herdr-app check` path), `roles`, `load`, `worlds` (every demo world: save
round trip, ticks, every view and role render), `window` (a whole window for `--seconds`),
`diff` (QuickJS-ng against V8 on the same driver), `fuzz` (strings that collide with frozen
prototype names, e.g. a tab id "constructor"), `long` (memory over `--long` seconds).

Files: `run.mjs` (the harness), `driver.js` (evaluated inside the engine), `shims/` (QuickJS-side
stand-ins for `herdr`, `gpui-kit`, `gpui-base`, and herdr's sandbox prelude), `lint.mjs`,
`probe.js` + `probe-node.mjs` (built-in probes), `node-run.mjs` + `node-hooks.mjs` (the V8 side
of `diff`), `node-fuzz.mjs` (the fuzz phase under V8 without frozen prototypes).

The packages are devDependencies only: `npm test` and `npm run check` never import them.
`shims/sandbox.js` is herdr's own prelude: see `NOTICE`.
