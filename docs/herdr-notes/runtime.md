# herdr-app mod runtime semantics (source-verified)

Scope: herdr-app master (~0.1.17) at `/home/user/herdrdev/herdr-app`. Source only, nothing built or run.

Path abbreviations used in citations:
- `src/…` = `/home/user/herdrdev/herdr-app/src/…`
- `shell/…` = `/home/user/herdrdev/herdr-app/vendor/gpui-kit/crates/shell/src/…`
- `qjs/…` = `shell/engine/quickjs/…`
- `AGENTS.md` = `/home/user/herdrdev/herdr-app/defaults/AGENTS.md`, `d.ts` = `defaults/herdr.d.ts`

Anything I could not prove from source is marked **UNCONFIRMED**.

---

## 0. TL;DR for the architecture decision

1. **One QuickJS VM (one runtime and one context) per app window**, shared by every mod and every copy
   (`src/window.rs:518`, `qjs/mod.rs:1816`). `globalThis` is shared across *all* mods
   (shipped `changes` and `files` share `globalThis[Symbol.for("herdr.repoStatus.v2")]`, `defaults/mods/changes/main.js:5-6`).
2. **Module code is evaluated once per source revision. All copies of a mod share it, whatever their props**
   (code cache keyed by root+entry+deps+revision, with no props in the key: `qjs/mod.rs:2349-2398`; test asserts a single
   evaluation for copies "A", "B", "C" even after all copies closed: `src/mods/render_tests.rs:282-338`).
   Module-level variables therefore make a **single shared simulation** for every role, overlay, pane header and float of the mod.
3. **Module state resets on every hot reload.** Any saved, non-hidden file under `mods/<name>/` counts (js, png, json, mp3).
   It also resets on a VM restart (memory ≥75%) and on app restart. `globalThis` survives a hot reload, but not a VM restart
   or an app restart. So the game must persist to disk itself.
4. Re-render is **per copy**. `cx.notify()` redraws only the copy that owns the cx/task. `setShared` (changed value) redraws
   **every copy of every mod** (`src/window.rs:1905-1922`). Don't drive a game tick through `setShared`.
5. Pattern: shared sim in module scope, advanced idempotently from wall clock (`advanceTo(Date.now())`) by **any** copy's
   own `cx.timer.every`. Each copy compares a module-level `version` against its last-seen value and `cx.notify()`s itself.
   Save with `writeTextFile(appHome()+"/data/<mod>/save.json", text, lastText)` every ~30 s.
   Never save inside `mods/<name>/`, which would hot-reload the mod.

---

## 1. JS contexts, copies, module state, hot reload

### One VM for everything
- `AppWindow::with_file_events` creates **one** `ShellRuntime` for the window: `src/window.rs:518` (`self.runtime: Option<Rc<ShellRuntime>>`, `src/window.rs:382`).
  Every copy loads through it: `runtime.try_load(&folder.dir, …)` in `AppWindow::load`, `src/window.rs:1870-1903`.
- `ShellRuntime` owns a single `context: JsContext` created with `JsContext::full(&js_runtime)`: `qjs/mod.rs:1370-1456`, `qjs/mod.rs:1816`.
- The sandbox says so explicitly: "One VM hosts several plugins (§27), so the built-in prototypes are shared mutable state" (`qjs/sandbox.rs:110-112`).
- Exception: `link.js` handlers run in a fresh isolated runtime per click (`qjs/mod.rs:1576-1601`, `Self::new_isolated()`).
- **One window per app home** (critic): a bare launch while a window serves `$HERDR_APP_HOME/herdr-app.sock` only raises that window and quits (`src/main.rs:128-129`, `src/control.rs:52-66` "One Herdr per home"). The app opens one `AppWindow` (`src/main.rs:257`). So there is exactly one VM, and one shared simulation, per home. A Herdr client on another machine has its own home and its own save.

### Copies share module code but each has its own instance
- `load_app` looks up `code_cache` by `fingerprint(&root, entry, &dependencies, revision)` (`qjs/mod.rs:2349-2353`). On a miss
  it evaluates the module once; on a hit it reuses the evaluated class (`qjs/mod.rs:2355-2398`). The comment says
  "Module-scope resources belong to code, not whichever copy happened to load it first" (`qjs/mod.rs:2370-2371`).
- Each copy gets a **new instance** (`construct` → `__construct(class)`, `qjs/mod.rs:3169-3183`). It also gets its own
  `ApplicationGeneration` (`new_application_generation()` per `load_app` call, `qjs/mod.rs:2353`) and its own policy (see below).
- Test `mod_copies_share_code_without_sharing_props_state_or_lifetime` (`src/mods/render_tests.rs:282-338`):
  the module-level `mark()` runs **once** for copies A, B, a failed copy, and copy C reopened after all copies closed.
  Instance fields (`this.count`) are per copy. `props()` returns each copy's own props even though the module was evaluated once.
- AGENTS.md:1059-1062: "Module code runs once per source version and is shared by copies, even after all copies close."
- **herdr functions resolve against the *current call frame's* policy**, not the module that imported them:
  `host_modules::modules()` = `crate::scope::policy().modules()` (`shell/host_modules.rs:931-933`). Each copy's policy carries
  its own `herdr` HostModule built with its props and copy id (`src/mods.rs:1454-1476`, `module(inst.clone(), copy)`).
  Consequences:
  - Do not call herdr functions (`props()`, `agents()`, …) at module top level. They answer for whichever copy is loading.
  - A copy whose async continuation is resumed by **another** copy (both await one module-level promise) runs inside the other
    copy's frame. `props()` and the live-read tracking then belong to the other copy. `cx.notify()` still redraws the owning copy
    (`TaskBinding::view`, `qjs/mod.rs:9796-9803`; AGENTS.md:1292-1293). Inferred from `scheduler.rs:822-864` (resume and drain
    inside the resumer's scope) and `scheduler.rs:933` (a task captures `scope::policy()` at creation). Prefer per-copy timers
    to shared promises.
- The default policy is replaced on every copy load (`prepare_load` → `policy::set_default`, `src/mods.rs:1448-1452`).
  Code running with no frame therefore sees the most recently loaded copy's module.

### Root `init` argument
- A root view's `init` gets `undefined` as its first argument (`initialize(&object, None)` → `Value::new_undefined`,
  `qjs/mod.rs:3237-3256`; called from `instantiate_view_with_policy`, `qjs/mod.rs:2545`). Use `props()` from `"herdr"`.
  The shipped win98 does `props() ?? p ?? {}` (`defaults/mods/win98/main.js:27`).
- `props()` is `null` for a block with no props, and in `herdr-app check` (§6).

### Hot reload (new source version)
- Herdr watches the app home itself (`src/files.rs`). `files_changed` (`src/window.rs:4357-4430`) reloads **every loaded copy**
  of an edited mod with `runtime.reload_now(root, …)` (`src/window.rs:4415-4426`).
- What counts as an edit: any path under `mods/<name>/` that passes `application_file_counts`. That excludes hidden path parts,
  `*~`, `node_modules`, `jsconfig.json` and `gpui-kit.d.ts` (`shell/watch.rs:59-64`, `src/files.rs:123-142`). The mod's
  `mod_stamp` (size+mtime of all such files, any extension) must also change (`src/files.rs:462-484`, `src/window.rs:4381-4389`).
  ⇒ Writing `mods/<name>/save.json` (or a png) at runtime **reloads the mod**. Changes under `data/` are not watched at all
  (`src/files.rs:123-132`).
  Critic: `mod_stamp` gives up (`None`) past **4096 directory entries** or **directory depth 8** (`src/files.rs:462-484`), and
  `None` counts as edited (`src/window.rs:4381-4383`). A mod folder that large reloads on every counted file event, so keep
  the art tree small and shallow.
- `reload()` (`shell/watch.rs:521-587`):
  1. Calls `load_app` again. The new revision changes the fingerprint (revision provider, `src/files.rs:28-59`), so the module is
     **re-evaluated once** and then shared by all copies. Module-level variables start fresh in the new module record.
  2. Calls `instantiate_for_view`: constructor plus `init` of a **new instance**, while the old instance is still alive.
  3. Only then releases the previous application generation (`watch.rs:572-579`). That cancels the old timers and tasks
     (`release_application_generation` → `cancel_application_tasks`, `qjs/mod.rs:2266-2278`) and swaps the object (`watch.rs:581-584`).
  - **`close()` is NOT called on reload.** Only `remove_copy` calls `runtime.close` (`src/window.rs:1425-1431`).
  - A failed reload keeps the old instance and the old module running. The error shows in `herdr-app status` (`src/window.rs:4421-4426`, `4232`).
  - QuickJS cannot free evaluated modules, so every revision's code stays in the heap: "A reload keeps the code it replaces"
    (`src/window.rs:4399-4401`).
- **VM restart:** on an edit when `memory_share() ≥ 0.75` of the 256 MiB limit (`src/window.rs:302-304`, `4402-4412`), or on an
  OOM load failure (`src/window.rs:1889`). `restart_mods` closes every copy (calling `close()`), creates a fresh VM and reloads
  the shown copies (`src/window.rs:4442-4500`). **Module state and `globalThis` are both lost.** Toasts close, and
  overlays/windows reopen.
- `globalThis` persists across normal hot reloads, because the context is the same one. Shipped mods rely on this
  (`changes/main.js:5-6`, `files/main.js:7`). Note AGENTS.md:938-941: a broken save's top-level code has already run, so
  side effects on `globalThis` from module top level are risky. Store **plain data** (no class instances, whose methods would
  belong to old code), versioned by key, e.g. `globalThis[Symbol.for("down-the-stack.sim.v1")] ??= {...}`.

---

## 2. `localStorage`

- API, assembled in the prelude (`qjs/mod.rs:6912-6929`):
  `localStorage.length` (getter), `key(i)`, `getItem(k)` → string|null, `setItem(k, v)` (`String(v)`), `removeItem(k)`,
  `clear()`, and the non-standard **`flush()` → Promise** that resolves once everything written so far is on disk (`qjs/host.rs:612-646`).
  It is also on `window.localStorage` (gpui's global `window`, not herdr's `window()`) (`qjs/mod.rs:6962`, `7001-7002`).
  `sessionStorage` has the same API, in memory only.
- **Scope**: the file is `<appHome>/data/<modName>/store.json` when props are `null`. Otherwise it is
  `store-<16 hex>.json`, where the hex is `std DefaultHasher` over `props.to_string()` (`src/mods.rs:1454-1476`).
  Copies with **byte-identical props JSON** share one live cache and write queue (`Policy::with_shared_storage_path`,
  `shell/policy.rs:172-183`). **Different props mean different stores**: each role, each pane header (props include
  `pane`/`terminal`), each float (`float`), and each overlay (props include `overlay: "o<N>"`, a new id every open,
  `src/window.rs:4027`). Overlay localStorage is effectively throwaway, and that includes kept windows reopened at start
  (`src/window/movable.rs:72-75`, new id).
  **UNCONFIRMED risk**: `DefaultHasher`'s algorithm is unspecified across Rust releases. A herdr upgrade could rename the hashed file.
- **Persistence**: real files across restarts. The file is read synchronously when a copy's policy is built
  (`with_storage_path` → `store.load()`, `shell/policy.rs:164-169`).
- **Sync vs async**: `getItem`/`setItem` are **synchronous** against an in-memory cache. The disk write runs in the background:
  one write in flight, coalesced (`drive_store`, `qjs/host.rs:558-604`). It is atomic: temp file, rename, `sync_parent`
  (`shell/storage.rs:405-430`).
- **Write cost on the UI thread, per `setItem`**: clones the whole map, then `validate_values` serialises every value and
  pretty-serialises the whole map (`shell/storage.rs:163-180`, `365-395`). Starting the background write encodes again
  (`storage.rs:231-262`, `346-354`). Roughly O(total store size) × 3 per call. That's fine for occasional writes and bad for
  per-tick writes of a 100 KB blob.
- **Limits** (`shell/storage.rs:41-44`): ≤ **1 MiB per value** (JSON-encoded, so escapes count), ≤ **4096 keys**, ≤ **8 MiB** total
  as pretty JSON, ≤ 1024 pending `flush()` waiters. Over a limit, `setItem` throws.
- In `herdr-app check`, localStorage goes to a **different real file**:
  `$XDG_DATA_HOME|~/.local/share/gpui-shell/apps/<folder-name>-<fnv64>/store.json` on Linux
  (`~/Library/Application Support/...` on macOS). It persists between checks (`shell/host.rs:604-627`, `shell/lib.rs:236-244`,
  `shell/runtime.rs:30-110`).

## 3. `shared(key)` / `setShared(key, value)`

- Store: `<appHome>/shared.json`, loaded lazily on first use (`src/mods.rs:495-498`, `515-542`). It is global to all mods, so
  prefix keys (`down-the-stack.*`). A corrupt file is moved aside and the store starts empty (`src/mods.rs:520-533`).
- `shared(k)`: a deep conversion of the stored JSON into JS **on every call** (`src/mods.rs:1354-1357`). It is not live-read
  tracked.
- `setShared(k, v)` (`src/mods.rs:1358-1361` → `set_shared` `489-493` → `SharedStore::set` `544-556`):
  - A value equal to the stored one (serde `Value` equality) is a **no-op**: no write, no re-render (`545-547`).
  - Otherwise it serialises the **entire shared map** to a String on the UI thread and sends it to a writer thread. The writer
    keeps only the newest of a burst and writes atomically (temp + rename, no fsync) (`src/mods.rs:568-582`, `src/persist.rs:24-48`).
  - Then `request(Request::Refresh)` → `refresh_mods` → `refresh_mods_matching(|_| true)`: **every loaded copy of every mod**
    is invalidated (`src/window.rs:4203`, `1905-1922`). GPUI coalesces this to one rebuild per copy per frame
    (`shell/view.rs:135-162`). Hidden copies only mark dirty and rebuild when next shown (they are not in the element tree).
- Size limits: none in herdr itself. JS→host conversion caps nesting at **16 levels** and arrays at **10,000 items**
  (`qjs/host_modules.rs:79`, `86`, `376-382`, `92-115`).
- Calling it every second with a changing value means 1 full-map serialise and 1 file write per second, plus a re-render of every
  visible mod (spaces, agents, tabs, status bar…) and a whole-window redraw (AGENTS.md:1084-1086). **Don't.** It suits rare
  cross-mod signals and settings. win98 uses it that way, e.g. `{ cmd, t: Date.now() }` requests (`defaults/mods/win98/kit.js:388-396`).
- Calling `setShared` with a new value from `render` creates a re-render loop at frame rate.
- `herdr-app check`: an in-memory, empty, non-writable store (`src/mods.rs:1425-1430`; AGENTS.md:96).

## 4. Files: `fs/promises` vs herdr `readTextFile`/`writeTextFile`

### `import * as fs from "fs/promises"` (gpui-shell, capability-gated)
- Exports (`qjs/standard/fs.rs:7-15`), plus a `default` object with the same members:
  - `readFile(path, enc?)` → `Uint8Array`, or a string with `"utf8"`/`{encoding:"utf8"}` (`qjs/host.rs:135-181`, `268-299`)
  - `writeFile(path, string|Uint8Array)` → Promise; takes **no options argument** (`qjs/host.rs:183-224`)
  - `readdir(path, {withFileTypes?})` → names, or `{name, isDirectory()}`, sorted by name (`qjs/host.rs:226-245`, `461-510`)
  - `exists(path)` → boolean (`qjs/host.rs:329-337`)
  - `unlink(path)`, `rmdir(path)` (empty directories only) (`qjs/host.rs:345-367`)
  - `mkdir(path, {recursive?})`, non-recursive by default (`qjs/host.rs:375-437`)
  - **No** `stat`, `rename`, `appendFile`, `copyFile`, `rm`, `watch`.
- Roots in the live app (`src/mods.rs:1407-1423`): read = `[home()]` (`+ appHome/mods` only for `frame-palette`),
  write = `[appHome()]`.
- **Relative paths resolve against each root in turn** (`shell/capability.rs:283-345`). A relative *read* is relative to
  `$HOME`. A relative *write* is relative to `~/.config/herdr-app`. So `fs.readFile("data/x")` reads `~/data/x`, which is
  probably not what you want. Use absolute paths from `appHome()`. There is no `~` expansion (`capability.rs:511-523`).
  `..` is normalised lexically, and symlinks are resolved before the containment check.
- A **denied path throws synchronously** (TypeError, "…outside every granted … root; add its directory to capabilities.fs…")
  at the call site. It does not reject the promise (`qjs/host.rs:525-542`). A write grant creates the root directory if it is
  missing (`capability.rs:323-325`).
- `writeFile` is **not atomic**: cap-std `Dir::write` truncates in place (`qjs/host.rs:220-223`). Limits: write 8 MiB, read 64 MiB,
  readdir 10k entries (`qjs/host.rs:441-444`). The syscall runs on the background executor.
- During **check**, the capabilities are replaced: read = `[mod folder, check-store dir]`, write = `[check-store dir]`
  (`shell/host.rs:500`, `604-627`, `693-711`). So `fs.readFile(appHome()+"/data/…")` in `init` **throws during check** and fails
  it unless guarded by `checking()`.

### herdr `readTextFile` / `writeTextFile` (not capability-gated)
- `readTextFile(path, {on?})` → `Promise<string|null>`, `null` if absent. Plain `std::fs`, **any path**. A relative path is
  relative to the process cwd (**UNCONFIRMED** what that is), so always pass an absolute path. Limit 1 MiB. Runs on a thread.
  Identical concurrent reads share one result (`src/mods.rs:1137-1148`, `src/mod_files.rs:8`, `14-45`, `98-121`).
  SETTLED (critic): a relative path goes straight to `std::fs` (`mod_files.rs:14-45`), so it is relative to the **process cwd
  inherited from the launcher**. Herdr never sets the cwd, except on Windows when the app was started inside its install folder
  (then it moves to `$HOME`, `src/update.rs:446-457`). Always pass `appHome() + "/…"`.
- `writeTextFile(path, text, expected)` → `Promise<null>` (`src/mods.rs:1149-1154`, `src/mod_files.rs:48-96`, `123-139`):
  - `expected` must equal the file's **current exact content**. Pass **`null` to create** a file that must not exist yet
    (`create_new`). On a mismatch it rejects with "The file changed outside Herdr. Reload before saving; your draft is still here."
  - Existing files are replaced **atomically**: temp file `.herdr-app-write-<nanos>` next to the target, permissions copied,
    re-checked, then `rename` (`mod_files.rs:70-96`). Parent directories are created. A process-wide mutex serialises writes.
    Each call gets a new OS thread. Limit **1 MiB**.
  - Critic: the **create** path (`expected === null`) is *not* atomic: `create_new` then `write_all` straight into the target
    (`mod_files.rs:60-67`). There is no fsync on either path. To make the first real save atomic too, create the file once with a
    tiny placeholder (`"{}"`), then always replace it with `expected = lastText`. Read and parse defensively; keep a `save.bak`.
  - Still runs for real during `check` and logs a warning (`src/mods.rs:1152`).
- **Best for a 20–100 KB save every 30 s:** `writeTextFile(appHome() + "/data/<mod>/save.json", json, lastWritten)`.
  It is atomic, off the UI thread, and cheap at this size (it reads the old file twice and writes once).
  At startup, `readTextFile` the save and keep that exact text as `lastWritten`, or `null` if absent. After each successful
  write, set `lastWritten = json`. On rejection, re-read and decide (another writer exists). Keep a module-level single-flight
  flag so two copies never write at once. Do it with `if (checking()) return;`.
  The `data/` folder isn't watched, so there's no hot reload. Alternative: localStorage with one key (≤ 1 MiB), but it is
  scoped per props, so pick a single owner copy.

## 5. Timers and clocks

- `cx.timer.every(ms, (cx) => …, opts?)` and `cx.timer.after(ms, (cx) => …, opts?)` (`qjs/mod.rs:7081-7090`,
  `qjs/scheduler.rs:617-722`). Both return a handle **`{ cancel(), is_done() }`** (`scheduler.rs:724-731`).
  Other cx members: `cx.sleep(ms)` → Promise; `cx.spawn(async (cx) => …, opts?)` → the same handle; `cx.notify()`;
  `cx.stop_propagation()`; `cx.propagate()`; `cx.phase()`; `cx.focus_handle()`; `cx.new(Class, props)`; `cx.theme()`;
  `cx.open_url()`; `cx.read_from_clipboard()`/`cx.write_to_clipboard()`; `cx.bind_keys()` (`qjs/mod.rs:7033-7085`, `10020-10146`).
- `ms` is any finite number ≥ 0 (0 allowed, no minimum) (`scheduler.rs:1682-1695`). Units are milliseconds, as a float.
- `every` waits `ms` after each callback *finishes* (`scheduler.rs:636-639`, `683-718`). It never catches up: after a stall or
  system sleep you get one late tick. **Never count ticks to measure time; use `Date.now()` deltas.**
- Callback `cx`: a Task binding. `cx.notify()` redraws the **timer owner's** copy (`qjs/mod.rs:9796-9803`).
- An exception in a callback is logged as `error in script task` and the timer **keeps running** (`scheduler.rs:854-856`).
- Each callback gets a 500 ms budget (`qjs/sandbox.rs:439-441`).
- `opts.owner`: undefined means the current view. `null` means no view owner, but the task is still bound to the copy's
  application generation, so it still dies on close or reload (`scheduler.rs:920-972`, `1635-1680`).
- **While hidden**: timers keep ticking when the copy is hidden (inactive stack child, other tab, hidden column) and when the
  window is minimized. There is no throttling (`scheduler.rs:636-639`; AGENTS.md:942-947, 1095-1099). Gate on
  `window()?.visible` yourself (d.ts:300-308).
- **Copy closes**: `close(cx)` runs first, with a 250 ms budget (`src/window.rs:1425-1431`, `qjs/lifecycle.rs:44-108`). Then the
  application generation is released. Timers stop because `readiness()` sees an inactive generation (`scheduler.rs:954-972`),
  and a task's cx throws "this cx belongs to a build of the script that was reloaded or closed" (`qjs/mod.rs:9816-9820`).
- **Hot reload**: the same cancellation for the old build, **without** `close()` (§1).
- Limit: **1024 outstanding tasks per runtime**, summed over all mods and copies (`scheduler.rs:1557-1577`). Pending async host
  calls (e.g. `nextCommand`, `exec`) go through the scheduler as tasks (`qjs/host_modules.rs:154`), so they count too.
- Globals `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` and `require` **exist but throw** a TypeError naming the
  replacement (`qjs/sandbox.rs:228-292`). `eval` is deleted and `Function`/AsyncFunction/GeneratorFunction constructors throw
  (`sandbox.rs:168-201`).
- `Date.now()` and `Math.random()` work; shipped mods use them (`win98/mines.js:57-65`, `agents/main.js:232`).
  `Date.now()` is wall-clock, **not monotonic**. Clamp negative or huge deltas for offline progress.
  `performance.now()`: the context is `JsContext::full`, documented as including the `Performance` intrinsic
  (`qjs/sandbox.rs:43-46`). Its presence and monotonicity are **UNCONFIRMED**: the QuickJS C source isn't vendored and no
  shipped mod uses it. `crypto` and `buffer` modules exist (`qjs/standard/mod.rs:29-41`).
  **Not checked**: `crypto.getRandomValues`.

## 6. `herdr-app check <dir>`: exact behaviour

Flow: `src/main.rs:102-118` calls `mods::install_check_policy()` (`src/mods.rs:1425-1430`):
`CHECKING=true`, an empty in-memory non-writable shared store, and the default policy given herdr's capabilities and a
`herdr` module for `Instance{name:"", props:null}`, copy 0 (`src/mods.rs:1432-1442`).

If there is a `link.js`, `check_link_mod` validates link rules and the `handleLink` export without running it.
A standalone link mod passes there (`src/main.rs:104-115`, `src/mods.rs:1502-1513`).

Otherwise it runs gpui-shell's checker, `shell/host.rs:453-529`:
1. Hidden 320×240 window (`host.rs:534-545`). The asset root is the **mod folder** (`host.rs:461-466`); the live app uses
   `appHome` (`src/main.rs:186`).
2. Applies the shell's own palette (`host.rs:656-671`). `mods::init`/`apply_theme` are **not** called.
   herdr `theme()` returns the built-in graphite, and `settings()` returns `Settings::default()` (`src/settings.rs:686-700`).
3. `grant_local_access` **overrides the capabilities**: storage on, read `[mod dir, store dir]`, write `[store dir]`, exit.
   localStorage moves to the gpui-shell per-path store (`host.rs:500`, `604-627`, `693-711`). (A `gpui-shell.json` manifest
   would change this; herdr mods normally have none, `shell/plugin.rs:62`.)
4. `runtime.check(root)` (`shell/plugin.rs:1357-1393`):
   `try_load` evaluates the module (500 ms budget: the load runs in a Task scope, see the budgets note below), runs the
   constructor, then **`init(undefined, cx)` for real** (500 ms budget).
   Then **one `render(cx)`** (50 ms budget) via `build_snapshot`, then `try_materialize` once for "eager native elements",
   with no layout or paint.
5. `outcome.exit` → `std::process::exit` immediately (`host.rs:526`, `559-562`). Exit code 0 only if step 4 returned Ok
   (`host.rs:576-582`).

**What runs:** module top level, constructor/class fields, `init`, one `render`, and promise jobs drained synchronously.
A `cx.spawn` body runs synchronously up to its first real await (`scheduler.rs:579-602`).
**What doesn't:** timers never fire (the process exits before the executor turns). Host async results (`exec`, `readTextFile`)
never resolve back. `close()` isn't called. Layout, paint, `on_size_change`, virtual-list item renderers ("deferred slots"),
nested view renders and event handlers don't run (`host.rs:302-306`, `plugin.rs:1347-1356`).

**Failure = any error out of load, init, render or materialize.** That includes:
- Syntax errors, unresolved imports, importing a **missing `herdr` export** (test `src/mods/render_tests.rs:499-530`),
  a default export that isn't a class (`qjs/mod.rs:2436-2443`), or a module over 8 MiB.
- An exception in the constructor or `init`, including the synchronous fs denials from §4 and `run()` with bad arguments
  (it validates against the command table synchronously: `src/mods.rs:1264-1268`). Also `openOverlay` without mod/layout
  (`src/mods.rs:1330-1333`).
- An exception in `render`: unknown element/style method ("unknown element method `x` (did you mean `y`?)",
  `qjs/mod.rs:7988`, `8297`, `8359`, `8874`, `10620-10631`); bad argument types that builders validate (e.g. `finitePositive`,
  `qjs/mod.rs:6225-6228`; per-method coverage **UNCONFIRMED**); reusing one element object under two parents
  ("already added to a parent"; the error enum is `SpecError` at `shell/spec.rs:1485-1525`: `AlreadyParented`, `SelfParent`,
  `Claimed` (an element given to a slot or state style and then also added), `Expired` (an element kept from a **previous** render,
  e.g. cached in module scope) and `DuplicateChildView`); exceeding the 50 ms render budget.
- Registered-component materialisation errors (`plugin.rs:1377-1391`).

**Not failures:** missing image or SVG files. Images are `gpui::img` elements loaded at layout/paint, and a missing asset is not an
error, only a warning (`shell/materialize.rs:1527-1536`, `shell/assets.rs:144-150`). Also not failures: unhandled spawn
rejections (logged to stderr, `scheduler.rs:741-748`, log sink at WARN `host.rs:76-79`) and errors in code paths the first
render doesn't take.

**herdr data during check:** `props()` → `null`; `placement()` → `null`; `window()` → `null`
(Snapshot default `window: Null`, `src/mods.rs:627-633`); `agents()`/`spaces()`/`panes()`/`terminals()`/`machines()` → `[]`;
`focused()`/`layout()` → `null`; `shared()` → `null` for every key; `setShared` → in memory, and its Refresh request is never
processed; `checking()` → `true`; `exec`/`hc`/`writeTextFile` **run for real** with warnings (`src/mods.rs:1131-1157`).
`run`/`openOverlay`/`notify` are queued and never processed. **UNCONFIRMED**: `fonts()` is probably `[]`, because
`note_fonts` is never called.

**For our mock validator:**
- Evaluate each module once with frozen `Object/Array/Function/String/Number.prototype`, no `eval`/`Function`, and throwing
  `setTimeout`/`setInterval`.
- Stub the herdr module with the values above. Call `new Default()` and then `init(undefined, cx)` for `props()===null`
  **and** for each role's props.
- Render once per role and time it: under 50 ms (render), 500 ms (init), 500 ms (module).
- Throw on unknown builder methods, using `gpui-kit.d.ts` method names. Throw on element reuse. Throw on `cx.notify()` during
  render ("not allowed during the `render` phase", `qjs/mod.rs:10037-10055`; `shell/scope.rs:59-61`).
- Make fs denials synchronous outside the mod folder.
- Optionally assert image paths exist ourselves, because the real check won't.

## 7. Rendering triggers and performance

- `render` runs **only** when the view is dirty and GPUI renders it. It never runs per frame (`shell/view.rs:1-23`, `287-303`).
  Native animations (`.frames`, `.spin`, `.loop`, `.transition`) run without script (AGENTS.md:1084-1099).
- What makes a copy dirty:
  1. `cx.notify()` from an event, task or timer (not allowed in render or layout: `scope.rs:59-61`). It redraws the owning copy only.
  2. **Live data, tracked per copy**: herdr records which snapshot keys a copy has *ever* read (`LiveReads::record`,
     `src/mods.rs:731-744`, `746-769`). A key is never forgotten until the copy unloads ("Reads in callbacks and child views count
     too", `src/mods.rs:775-783`). On change only those copies refresh (`refresh_snapshot_mods`, `src/window.rs:1909-1911`).
     Keys: `spaces`, `machines`, `agents`, `panes`, `terminals`, `focused`, `layout`, `window`, `floats`
     (`src/mods.rs:1278-1316`, `1348-1352`).
     - `agents` is republished whenever `publish()` runs (`src/window.rs:1932-2010`). It re-renders readers only when the JSON
       differs: status, title, focused, seq, pane/tab/space names (`src/window.rs:1974-1985`). Terminal titles have spinner
       frames stripped (`src/terminal.rs:1341-1364`, `515-520`), so Claude Code's animated title doesn't thrash.
     - `terminals` changes on list or selection changes, not on output (`src/mods.rs:684-693`, `src/window.rs:2320-2324`).
       `panes` changes only on scroll *state transitions* (AGENTS.md:411-420, `src/mods.rs:659-661`).
     - `floats` is one key for all floats and includes `hovered`/`dragging`, so hovering any float re-renders every
       `placement()` reader (`src/window/floats.rs:100-111`).
     - `window` changes on visibility, active, maximize and similar (`src/window.rs:625-631`, `4345`).
  3. **All copies of all mods**: a changed `setShared`; a look, settings or theme change (`src/window.rs:963-969`); an
     update-status change (`src/window.rs:4310-4314`); a telemetry status change (`src/telemetry.rs:636-638`).
  4. Theme token change (`shell/view.rs:292-296`), hot reload, and host refreshes.
- Coalescing: notify and refresh only set `dirty` and ask GPUI for a frame, so "three notifies before the next frame rebuild one
  snapshot" (`shell/view.rs:135-162`). Every mod redraw redraws the whole window (AGENTS.md:1084-1086). A stage at 4 re-renders/s
  means 4 window redraws/s, so keep ticks low and lean on native animation.
- Budgets (interrupt handler, per entry, `qjs/sandbox.rs:423-445`, `493-528`): **render/layout 50 ms**, **event/task/timer
  500 ms**, and `close` 250 ms shared across copies on quit (`src/window.rs:1429`). **Module evaluation is 500 ms too**:
  correction (integration audit). The 5 s `detached` budget applies only with no scope at all, but herdr loads every copy
  (`src/window.rs:1879` `try_load` → `plugin.rs:1235-1250 load_view_with_policy`), `herdr-app check` (`plugin.rs:1360`) and
  hot reloads (`watch.rs:547-552`) inside `ScopePhase::Task`, which maps to the event budget (`sandbox.rs:513-517`).
- VM heap: **256 MiB for all mods together** (`sandbox.rs:407-409`). Stack: 1 MiB (`sandbox.rs:417-419`).
- No hard element-count cap was found. Related limits: 10,000 live entities (focus handles, input states, nested views…)
  (`shell/entities.rs:54`), 4096 retained component states, 1,000,000 virtual items per render, and 10k nodes for component
  arguments (`qjs/mod.rs:9311`, `10354-10355`). A host value crossing the bridge allows nesting 16 and arrays of 10k
  (`qjs/host_modules.rs:79-86`). `agents()`/`panes()` etc. clone and convert the snapshot on every call, so call each once per render.
- **Errors in render**: the build is transactional. On a throw the **last good snapshot stays** with an **error banner** over it.
  A view that never rendered shows a full error overlay. The failure is recorded and not retried until the next invalidation
  (`shell/view.rs:62-67`, `243-284`, `310-331`). `herdr-app status` lists only load/reload errors (`src/window.rs:4232`).
  Timer and task errors only reach the log (`HERDR_APP_LOG`, `src/main.rs:132-137`).

## 8. Imports and language level

- Every file is a JS **ES module** (`Module::declare(ctx, name, source)`, `qjs/mod.rs:5723-5742`).
- Relative specifiers (`./kit.js`, `../x/y.js`) resolve against the **importing file** and must stay inside the mod root
  ("resolves outside the application directory", `qjs/mod.rs:5632-5664`, `5703-5711`). Candidates are the exact name, then
  `with_extension("js")`, so `./kit` works (`qjs/mod.rs:5652-5662`). Paths are canonicalised, then checked.
- Bare specifiers allowed: `gpui-kit` (alias `gpui`), `gpui-base`, `gpui-shell`, `gpui-fps` (`qjs/mod.rs:1302-1308`);
  standard modules `buffer`, `console`, `crypto`, `fs/promises`, `net`, `os`, `path`, `process`, `url`, `websocket`, `zlib`
  (`qjs/standard/mod.rs:29-41`); host module `herdr`; and git dependencies declared in a `gpui-shell.json` manifest
  (`qjs/mod.rs:2340-2346`). Anything else fails with a message listing the built-ins (`qjs/mod.rs:5676-5701`).
- **JSON imports: not supported.** Import attributes are ignored and the file is parsed as JS, which gives a syntax error.
  Use `export default {...}` in a `.js` file, or read the data at runtime.
- `import()` (dynamic) is allowed (`qjs/sandbox.rs:25-28`).
- **Top-level await**: the module promise is `finish()`ed synchronously at load (`qjs/mod.rs:2431-2434`), so awaiting host I/O
  at top level can't complete. AGENTS.md:1066-1067 forbids it. The exact error is **UNCONFIRMED**.
- File size ≤ **8 MiB** per module (`qjs/mod.rs:57`, `5757-5790`).
- Engine: QuickJS via longbridge `quickjs-jit` 0.12.11 (a QuickJS-ng based fork, `shell/Cargo.toml:45-52`). herdr
  0.1.17 builds it **without the JIT tier**: every window's runtime comes from `build_interpreter()`
  (`src/window.rs:518` → `ShellRuntime::new` → `qjs/mod.rs:1787-1801`, "HERDR: the plain interpreter"); the JIT
  constructors are `#[cfg(test)]` only (`qjs/mod.rs:1743-1756`, `5426-5439`). Shipped mods use optional chaining, `??=`, `Array.prototype.at`,
  `replaceAll` and Unicode property regexes (`agents/main.js:387`, `win98/taskbar.js:182`, `win98/kit.js:436`,
  `changes/main.js:61`). Classes and fields are fine.
  **UNCONFIRMED from source**: private `#fields`, static blocks, `structuredClone`. These are standard in QuickJS-ng, but no
  shipped mod uses them. Stay conservative or test them in a tiny mod.
- **Frozen prototypes** (`qjs/sandbox.rs:203-217`): `Object`, `Array`, `Function`, `String` and `Number` prototypes are frozen.
  - In strict-mode modules, *assigning* a property that exists on a frozen prototype throws, e.g. `obj.toString = …`,
    `obj.constructor = …`, or `Object.assign(o, {valueOf})`.
  - Class method definitions and object literals are fine.
  - You can't polyfill or extend `Array.prototype`.
  - `Map`/`Set` prototypes are not in the list.

## 9. Overlays, windows, floats, pane headers

- `openOverlay(spec)` → id `"o<N>"` (`src/mods.rs:1324-1340`, `818-824`). Implementation is `open_overlay` (`src/window.rs:3996-4100`):
  - kinds: `dialog` (default), `popup`, `window`.
  - The mod's `props()` = `spec.props` (or `{}`) plus **`overlay: id`** (`4026-4027`).
  - The copy **loads immediately** in `open_overlay` (`4060-4067`).
  - Sizes: a dialog defaults to 420 wide and 0.85 of the window tall. For a window, 0 means sized to content. Values ≤ 1 are a
    share of the window (`4033-4039`; d.ts:436-437).
  - `key` (windows only, `4003`): opening the same key again **replaces** the open window in its place, and the spot is
    remembered in `windows.json` (`4005-4010`, `src/window/movable.rs:42-49`).
  - `keep: true` saves the spec per layout and reopens it at start or when the layout shows, with a **new** id
    (`4089-4095`, `movable.rs:51-75`). A layout switch closes windows (`movable.rs:78-85`). `closeOverlay` on a kept window
    "forgets" it (`src/window.rs:4141-4143`).
  - Esc closes dialogs and popups, not windows (d.ts:419-424).
  - Closing calls `remove_copy` → `close()` (`src/window.rs:4147-4156`).
  - Overlay copies share the mod's module scope, so they can read the shared sim directly. Their localStorage is per open (§2).
- `notify(n)` opens a `toast` overlay, which loads the layout's toast mod as a **new copy per notification**
  (`src/mods.rs:1342-1347`, `src/window.rs:4019-4025`). Timeout is 5000 ms, or 8000 for `error`/`warning`, unless
  `timeout` is set (`src/window.rs:4049-4052`). It costs one mod load and render each and stacks on screen. Use it for rare
  milestones (boss down), never per kill.
  - It has no sound of its own (sounds are `playSound` or herdr's own attention alerts, `src/window.rs:2377-2379`).
  - The shipped toast mod runs `run(action.name, action.args ?? {})` when clicked, then closes itself
    (`defaults/mods/toast/main.js`). A `<mod>.<command>` action reaches shown copies only (below) and toasts
    "<cmd> failed" elsewhere; `mod.open {name}` is an app command that opens the `"overlay"` spec of that mod's
    `mod.json` (`src/window.rs:3690-3702`, `5446-5449`) in any layout. Running it again closes it (overlay id
    `mod-<name>`).
- `layout.toggle` / `layout.show` / `layout.hide {id}` set the node's `hidden` (`src/window.rs:3646-3654`; a node the
  shown layout lacks fails the command). The click state is written to `layouts/.state/<layout>.json` by `save()`
  (`src/window.rs:1180-1194`, `1236-1255`), so a hidden block stays hidden across restarts. A hidden block's mod copy
  keeps living (and its timers run) while its slot is in the layout (`src/window.rs:1630-1636`).
- **Floating blocks**:
  - slot `float:<id>`, props = content props plus **`float: <id>`** (`src/window.rs:5464-5468`).
  - Sized to content (`set_fit_content(true)`, `src/window.rs:1638-1646`).
  - `placement()` → `{edge, align, vertical, hovered, dragging}` or `null` (`src/mods.rs:1348-1352`, `src/window/floats.rs:100-111`).
  - Kept alive while in the layout, even when hidden (`src/window.rs:1355-1371`).
- **Pane header mod** (layout tab block `pane.header.content.mod`):
  - **One copy per pane**, slot `<paneId>#frame`, props = header props plus **`{pane: <paneId>, terminal: <address|null>}`**
    (`src/window.rs:5471-5476`).
  - Owned for every pane of every tab while that layout is shown (`src/window.rs:1372-1393`). A copy loads when the header
    first shows; by default headers only show on split tabs, unless `lone: true` (AGENTS.md:425).
  - It stays alive while hidden (another tab, a zoom) and is closed with `close()` when its pane goes.
  - Each header copy has its own localStorage file, because its props differ.
  - It reads live facts from `panes()`/`agents()` and tracks them, so it re-renders on each agents change.
- Copies in general: a block is identified by slot and `Instance{name, props}`. Changed props restart the copy
  (`src/window.rs:1630-1636`). A copy starts the first time it is visible, then lives while its slot is owned
  (`src/window.rs:1630-1648`; AGENTS.md:942-947). Switching layouts restarts layout-owned copies; pane mods stay
  (`src/window.rs:1414-1423`).
- No numeric cap on copies. The practical limits are the 1024-task, 10k-entity and 256 MiB heap limits shared by all mods.
- `<mod>.<command>` keys reach only **shown** copies (`src/mods.rs:784-799`).

## 10. `playSound` and notify cost

- `playSound(sound)` (`src/mods.rs:1259-1262` → `src/sound.rs:30-56`):
  - `"done"` and `"blocked"` are the attention sounds. Any other string is a **file path, absolute or relative to
    `appHome()`**. So use `playSound("mods/<name>/sfx/hit.mp3")`; win98 does `${ASSETS}/sounds/${name}.mp3`
    (`win98/kit.js:405-412`).
  - It returns at once. Each call spawns an OS thread plus an **external player process**. On Linux it tries
    `paplay`, `pw-play`, `ffplay`, `mpg123`, `mpv` in order, so up to 5 failed spawns if none decodes MP3. macOS tries `afplay`
    first. Windows uses MCI. Each player is capped at 15 s (`sound.rs:16-27`, `98-135`). Failures are only logged.
  - **It ignores `settings().sounds.enabled`.** herdr checks that only for its own attention sounds (`src/window.rs:2378`).
    Mods must check it, e.g. `settings().sounds?.enabled !== false`. `HERDR_APP_NO_SOUND` mutes everything (`sound.rs:31-33`).
  - No volume or stop control. Rate-limit it (e.g. ≤ 2/s, and never per hit).
- `notify()`: see §9. It is a full overlay copy each time.

## Appendix: other facts that matter

- `exec` timeout defaults to 30 s and is capped at 10 min. Output is capped at 8 MiB (`src/mods.rs:871-882`).
- `window()?.visible` is unreliable on Wayland, where it stays true (d.ts:300-308).
- AGENTS.md:1063-1065: never keep a call `cx`. A **render/event** cx (`Call(generation)`) goes stale after its call. A
  **task/timer** cx (`Task`) stays valid while its build lives and some host call is in progress (`qjs/mod.rs:9766-9836`).
  Still, don't stash cxs across copies.
- First load of a mod folder docks one copy per `mod.json` `place` unless it is `"none"` (AGENTS.md:933-936). Use
  `{"place":"none"}` for a multi-role mod, as win98 does (`defaults/mods/win98/mod.json`).

---

## Critic verification

A completeness pass over every file in `ref/`. Each answer was re-read in source (herdr-app master `2d1464e`). Nothing was
built or run. Citation prefixes are as at the top of this file, plus `taffy/` = `vendor/taffy/src/` and
`GP/` = `vendor/gpui-pre/src/`. Fixes were made in place, each marked "critic" or "CORRECTED (critic)": `gpui-api.md` §0.4,
§2.3, §3.2, §4.1 and App. B; `patterns.md` §0, §6.3, §6.4, §9.7 and §10.4; `layout.md` §0.2 and §0.3; this file §1, §4 and §6.

### Q1. Can several mod copies share one simulation through module scope?
**Yes. Module scope is the right channel. shared()/localStorage are not needed to sync roles.**
- There is one QuickJS runtime and context per window (`src/window.rs:518`, `qjs/mod.rs:1816`). There is one window per
  app home: a second launch raises the first and quits (`src/main.rs:128-129`, `src/control.rs:52-66`).
- `load_app` caches evaluated code by `fingerprint(root, entry, deps, revision)`. Props are not in the key
  (`qjs/mod.rs:2349-2353`), and a cache hit reuses the class (`2355-2398`). The comment there reads "Module-scope resources
  belong to code, not whichever copy happened to load it first".
- The test `mod_copies_share_code_without_sharing_props_state_or_lifetime` asserts `marks == 1` across copies A, B, a failed
  copy and C reopened after all closed, while `props()` stays per copy (`src/mods/render_tests.rs:282-338`). So the stage,
  party, every nameplate, the hud and the overlays all see the same module variables.
- Each copy gets its own policy, with its own `herdr` module, props and localStorage path (`src/mods.rs:1447-1476`). Host
  functions resolve against the calling frame (`shell/host_modules.rs:927-933`). So never call `agents()` or `props()` at
  module top level. Let each copy feed the sim from its own render or timer.
- Re-rendering is per copy. `cx.notify()` redraws only the caller's own view: it is allowed only in the event and task phases
  (`shell/scope.rs:58-61`, `qjs/mod.rs:10037-10055`), and `notify(entity)` reaches only retained children. There are two cheap
  ways to fan out:
  (a) each copy runs its own `cx.timer.every(T)`, compares a module-level `version` with the one it saw last, and
      `cx.notify()`s itself;
  (b) one copy calls `run("down-the-stack.refresh")`, which reaches every **shown** copy's `nextCommand()`
      (`src/window.rs:3104-3109` → `src/mods.rs:784-799`).
  Avoid `setShared` for this: a changed value re-serialises all of shared.json and refreshes every copy of every mod
  (`src/mods.rs:544-556`, `src/window.rs:1905-1922`).
- Module state resets on hot reload (a new module record per revision, `shell/watch.rs:521-587`) and on a VM restart
  (`src/window.rs:4442-4500`). `globalThis` survives a hot reload but not a VM restart. Keep the sim as plain data (optionally
  mirrored under `globalThis[Symbol.for("down-the-stack.v1")]` to survive dev reloads) and persist it to disk (Q2).
  Never store element objects across renders: `SpecError::Expired` (`shell/spec.rs:1489-1504`).

### Q2. Best persistence for a save file
**`writeTextFile(appHome() + "/data/down-the-stack/save.json", json, lastText)` from a single writer, read back with `readTextFile`.**
- It is not capability-gated: plain `std::fs` on any path (`src/mods.rs:1137-1154`, `src/mod_files.rs:14-96`). The limit is
  1 MiB (`mod_files.rs:8`). It runs on its own thread, behind a process-wide mutex (`mod_files.rs:9,48,123-139`).
- `expected` must equal the file's current bytes, or the call rejects "The file changed outside Herdr…" (`mod_files.rs:52-57`).
  Replacing an existing file is atomic: a temp file, permissions copied, a re-check, then `rename` (`mod_files.rs:68-95`).
  The **create** path (`expected=null`) is a non-atomic `create_new` + `write_all` (`mod_files.rs:60-67`), and there is no fsync
  anywhere. So create a `"{}"` placeholder once, then always replace.
- `data/` is not watched, so saving never hot-reloads (`src/files.rs:120-132`). `data/<mod>/` is created on every copy load
  (`src/mods.rs:1459-1460`) and never cleaned. Anything written under `mods/down-the-stack/` **does** reload the mod
  (`src/files.rs:133-142`).
- Relative paths resolve against the process cwd inherited from the launcher (`src/update.rs:446-457`), so always build paths
  from `appHome()`.
- During `herdr-app check` it **writes for real** (`src/mods.rs:1149-1153`), so guard with `if (checking()) return`.
- Rejected alternatives:
  - `localStorage`: scoped per props hash (`src/mods.rs:1461-1468`), so only one role could own it. Its file name also depends
    on `DefaultHasher`.
  - `fs/promises.writeFile`: not atomic (`qjs/host.rs:220-223`), and it throws synchronously in check (`shell/host.rs:693-711`).
  - `setShared`: a whole-map write plus a global re-render on every change.

### Q3. Exact motion semantics
- **loop**:
  - Value: `phase = (now % period) / period`, where `now` is milliseconds since a **process-global** `OnceLock<Instant>`,
    set on the first `loop_clock_ms()` call in the process (`MAT:2894-2898`). The wave is a triangle:
    `x = phase<.5 ? 2·phase : 2−2·phase`, `value = from + (to−from)·ease(x)` (`MAT:3091-3101`).
  - **The phase is not reset when the element appears.** There is no phase-offset parameter, so you can only de-sync by
    `period`. A loop keeps no state, so **no `.id()` is needed**.
  - left/top/width/height are set as raw `gpui::px(value)`, **not zoom-scaled** (`MAT:3103-3106`; static lengths use
    `scaled_px`, `value.rs:25-27`). Opacity is clamped to 0..1.
  - It replaces the static value and runs after `apply_motion`, so it overrides a transition on the same property
    (`MAT:796-798`). The view is woken about every 33 ms (`MAT:3108-3110`).
  - JS validation: `from`/`to` must be numbers, `period ≥ 100` ms (default 1000), easing in {linear, ease-in, ease-out,
    ease-in-out} (default ease-in-out) (`qjs/mod.rs:6134-6156`).
  - `frames(list, ms ≥ 16)` uses the same clock (`MAT:3086-3090`) and replaces the children with the current string
    (`MAT:817-819`).
- **transition / spring**:
  - The state comes from GPUI `use_keyed_state((identity, channel))` (`MAT:3209-3282` → `base/motion.rs:288-299`;
    `GP/window.rs:4319-4337`).
  - **On first sight it adopts the target, so there is no entrance animation**. Later target changes restart from the value
    sampled at that moment (it can be retargeted, `base/motion.rs:324-346`). The state is dropped when the element is absent
    for a frame (`GP/window.rs:4339`). Reduce-motion or a duration of 0 snaps (`base/motion.rs:303-317`).
  - **`.id(string)` is needed in practice.** Without it the identity is `NamedInteger("gpui-shell", SpecId)`, the element's
    index in this render's arena (`MAT:2566-2571`, `shell/spec.rs:9-11,24`), so inserting a conditional element earlier shifts
    it. Ids are namespaced under the view's `ElementId::View` (`GP/view.rs:312-314`, `GP/window.rs:3044-3054`).
  - Only a **number or `"Npx"`** length animates (`AbsoluteLength::Pixels`, `MAT:3183-3197`). `"Nrem"`, the rem ramps, `%` and
    `auto` snap (`SH/style.rs:597-600`). Opacity animates only if `.opacity(x)` is set on that element (`MAT:3133-3143`).
  - JS validation: transition takes `number | {duration=0, delay=0, easing="ease-out"}`; spring takes
    `{response=250, damping=1, epsilon=0.001}` (`qjs/mod.rs:6072-6121`).

### Q4. Absolute positioning in px, and mirroring images
- **Absolute: yes.** `div().relative().w(W).h(H).overflow_hidden()` with children
  `.absolute().left(x).top(y).w(..).h(..)` works with numbers (px × zoom).
  - Taffy (vendored 0.13.0, `Cargo.toml:94`) positions each container's absolute children against **that container**: its
    size minus border, offset by `inset + border` (`taffy/compute/flexbox.rs:2234-2400`, `taffy/compute/block.rs:689-693,1462-1500`).
    Padding doesn't shift them, and the parent's `position` is irrelevant.
  - Absolute children don't size the parent, so give it explicit dimensions.
  - Later siblings paint on top; there is no z-index.
  - `image()` takes the same refinement, including position and inset (`MAT:1527-1536`).
- **Mirroring: no.** The only transformation the shell applies is the svg spin rotation (`MAT:1483-1499`, `1495`). GPUI
  `img` has no flip, and its `object_fit`/`grayscale` aren't exposed (`GP/elements/img.rs:132-161`). Ship left- and
  right-facing files (or generate mirrored SVGs with `scale(-1 1)`).
- Animated GIF/WebP walk cycles do animate natively, but **only while the herdr window is active** and reduce-motion is off
  (`GP/elements/img.rs:331,391-397`). Give them a stable `.id()` (`MAT:1534`).

### Q5. Does a pane-header mod keep its own props?
**Yes.** `pane_header_mod` clones the layout props, then sets `props["pane"] = node id` and
`props["terminal"] = n.terminal()` (null for a mod pane) (`src/window.rs:5470-5476`). So `{role:"nameplate"}` arrives as
`{role, pane, terminal}`.
- The props must be a JSON object (anything else becomes `{}`), and `pane`/`terminal` keys are overwritten.
- The slot is `"<pane id>#frame"`, one copy per pane. Only the first `{tab, pane}` frame's header counts
  (`src/window.rs:1373-1393`).
- Floats get `float: <id>` merged the same way (`src/window.rs:5462-5468`). Blocks and stack headers get their props verbatim.
- Each header copy therefore has its own localStorage file (its props differ), while still sharing the module scope.

### Q6. What `herdr-app check <mod-dir>` validates (for the mock validator)
Flow:
1. `src/main.rs:102-118`: `install_check_policy()` sets `CHECKING=true`, an empty non-writable shared store, and a herdr
   module for `Instance{name:"", props:null}` (`src/mods.rs:1425-1442`).
2. A `link.js` pre-check runs if present.
3. `gpui_shell::host::check` (`shell/host.rs:451-529`):
   - opens a hidden 320×240 window;
   - roots assets at the **mod dir**;
   - installs the shell palette;
   - `grant_local_access` replaces the capabilities with storage on, read `[mod dir, store]`, write `[store]`, exit, and no
     network (`shell/host.rs:603-627,693-711`);
   - reads an optional `gpui-shell.json` (`plugin.rs:62`; herdr's `mod.json` is **not** read).
4. `runtime.check` (`shell/plugin.rs:1357-1393`):
   - `try_load` evaluates the module (500 ms: Task scope, see the budgets note), runs the constructor, and calls
     `init(undefined, cx)` for real (500 ms);
   - `build_snapshot` runs **one** `render` (50 ms);
   - `try_materialize` builds the native elements once with `CHECKING` set, so no animation frames are requested
     (`MAT:719-730`). There is no layout and no paint.
5. It exits 0 only if a check ran and produced no error (`host.rs:559-582`). `--print-spec` also prints the description tree
   (`host.rs:279-282,898-902`).

It fails on:
- a syntax error, an unresolved import, or a missing `herdr` export (`src/mods/render_tests.rs:498-525`);
- a default export that isn't a View class;
- a throw in module code, the constructor, `init` or `render`;
- an unknown element method (`TypeError`, re-run with the diagnostic Proxy, `qjs/mod.rs:5800-5820`);
- a bad style argument (`SH/style.rs:587-670`; `SH/value.rs:84-104`);
- a `SpecError` (`shell/spec.rs:1485-1525`: AlreadyParented, SelfParent, Claimed, Expired, DuplicateChildView);
- `cx.notify()` during render;
- a synchronous fs denial outside `[mod dir, store]`;
- `run()` with bad arguments (`src/mods.rs:1263-1268`);
- a budget overrun.

It does **not** fail on missing images, timers (they never fire), errors after the first `await`, handlers, `on_size_change`,
nested views or deferred slots.

herdr values during check: `props()` / `window()` / `placement()` / `focused()` / `layout()` are null, the lists are `[]`, and
`checking()` is true. `exec`, `hc` and `writeTextFile` run for real.

For our multi-role mod this means the real check exercises **only the `props()===null` path**. The mock must also run
`init` + `render` for each role's props (`{role:"stage"}`, `{role:"party"}`, `{role:"nameplate",pane:"n…",terminal:null}`,
`{role:"hud"}`, overlay `{role:…, overlay:"o1"}`) with non-empty fake `agents()`.

### Q7. Is the element-method allowlist complete enough?
**Yes. Nothing was missing, and nothing was added.**
- All 110 names in `used-methods.txt` are in `api-allowlist.json.element_methods` (3318 unique names).
- I re-scanned every `.name(` call in `defaults/**/*.js`. 115 of the names are in the allowlist. The extra 5 (`focus`,
  `input`, `open`, `start`, `value`) are real element methods, but in shipped code they are mod helpers or InputState calls.
  Every remaining non-allowlisted name is a JS built-in, a helper, `cx.*`, a handle or a static (`Scrollbar.vertical`,
  `TextView.html`, `PathBuilder.fill`, …).
- The groups were cross-checked against source:
  - `param_styles` equals the 59 `PARAM_STYLES` names (`SH/style.rs:86-212`);
  - `behaviors_generic` equals the 67-name list (`qjs/mod.rs:7485-7553`), and herdr registers no component methods;
  - `prelude_methods` equals the 46 `methods.X =` assignments (`qjs/mod.rs:5893-6680`);
  - the 9 `font_*` names equal `EXTRA_NULLARY` (`SH/style.rs:221-231`).
- Spot checks: about 90 game-relevant names (absolute, left, top, inset_0, size_full, overflow_hidden, opacity, transition,
  loop, frames, spin, tooltip, cursor_pointer, shadow_md, truncate, …) are present. `z_index`, `object_fit`, `scale`,
  `rotate`, `aspect_ratio`, `line_clamp`, `text_align`, `cursor`, `shadow`, `img`, `text`, `debug` and `debug_below` are
  correctly absent.
- The 3130 reflected nullary names can't be re-derived offline: they come from the non-vendored `gpui-pre-macros 0.3.8`, and
  the researcher matched its hash to `Cargo.lock`. Treat them as CONFIRMED-by-proxy.
