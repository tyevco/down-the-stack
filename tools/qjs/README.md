# QuickJS-ng harness (`npm run qjs`)

Runs the mod in the engine herdr runs it in: QuickJS-ng (quickjs-emscripten's
`@jitl/quickjs-ng-wasmfile-release-sync`, an interpreter compiled to wasm; herdr 0.1.17 also runs
quickjs-jit's plain interpreter, with no JIT tier, but natively, so these times overstate herdr's
only by the gap between wasm and native code) with herdr's limits (256 MiB heap, 1 MiB stack) and herdr's sandbox prelude
(`shims/sandbox.js`: no eval / Function, frozen Object/Array/Function/String/Number prototypes).
The Node mock (`tools/mock`, `npm run check`) is stricter about the API but runs in V8 with
nothing frozen; this catches what only the engine shows.

Every time it reports, and flags against herdr's budgets (at 50 %), is the lower of the wall time
and the process's CPU time over the same span: the engine runs on the harness's thread, so a busy
machine (waiting for a CPU) cannot make a render or a tick look slow, while real work counts in
both.

```
npm install                       # once: the devDependencies below
npm run qjs                       # every phase; results in out/qjs/results.json
npm run qjs -- --only fuzz        # one phase (comma-separated list)
npm run qjs -- --only worlds --kinds mid,late --ticks 300
npm run qjs -- --only reload --reload-kinds stress30
```

Phases: `lint` (acorn scan for engine and sandbox hazards), `builtins` (the same probes in
QuickJS-ng and V8, every difference listed), `modeval` (module evaluation against herdr's
500 ms), `check` (the `herdr-app check` path), `roles`, `load`, `worlds` (every demo world: save
round trip, ticks, every view and role render), `window` (a whole window for `--seconds`),
`diff` (QuickJS-ng against V8 on the same driver), `fuzz` (strings that collide with frozen
prototype names, e.g. a tab id "constructor"), `reload` (hot reload, below), `long` (memory over
`--long` seconds).

`reload` does what herdr does when a file of the mod is saved (`src/window.rs` `files_changed` →
gpui-shell `watch.rs` `reload`): in the VM already running build 1 it evaluates the mod's module
graph again as build 2 (every module named `<file>?v=2`, as `quickjs/mod.rs` `module_name` and
`AppModules::resolve` tag them; `globalThis` and the host modules carry over), then for each copy
initialises a new instance and releases the old one (its timers and tasks are cancelled and a
pending host call never answers; `close()` is not called). Host IO is held and answered one call
at a time in the caller's frame (`shims/herdr.js` `setHold` / `settle`), so a save can be in flight
across the reload. Five reloads per world (`--reload-kinds`, default `mid,stress30`): a plain one
after 45 s of play (with progress since the last save); one while a save's `save.json` write has
landed but not answered; one a second after the previous build loaded; one where the stage copy's
reload fails (herdr keeps the old instance running) while its save, at the `save.bak` write, is
answered after the handover; and one where another window wrote `save.json` just before (the old
host declines the handover, so the new host loads that file) while the party copy's reload fails.
Each checks that the new build's host continues the old world exactly (no rollback to
`save.json`; for the declined one, the other window's save), that the old host is retired and
never pumps, writes or reloads again, that every new copy holds one 1 s timer and one task, that no
released build's `cx` is used and no global appears, and that 20 s later (35 s after a declined
handover: a world loaded from `save.json` is saved on the 30 s beat) `save.json` holds the new
host's text, nothing else wrote, and every copy draws.

Files: `run.mjs` (the harness), `driver.js` (evaluated inside the engine), `stress30.js` (the
30-hero herd's recipe, shared with `tools/fixtures.mjs` so `npm run check` and this harness build
the same world), `shims/` (QuickJS-side
stand-ins for `herdr`, `gpui-kit`, `gpui-base`, and herdr's sandbox prelude), `lint.mjs`,
`probe.js` + `probe-node.mjs` (built-in probes), `node-run.mjs` + `node-hooks.mjs` (the V8 side
of `diff`), `node-fuzz.mjs` (the fuzz phase under V8 without frozen prototypes).

The packages are devDependencies only: `npm test` and `npm run check` never import them.
`shims/sandbox.js` is herdr's own prelude: see `NOTICE`.
