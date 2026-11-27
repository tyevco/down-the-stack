# Down the Stack (mod `down-the-stack`): architecture and build contract

This is the contract every module author works to. The game design (what to build, every
number) is `docs/DESIGN.md` (sections cited as D§n). How herdr and its UI toolkit really
behave is in `docs/herdr-notes/` (cited as `gpui-api.md`, `runtime.md`, `patterns.md`,
`layout.md`). When this file and the design disagree about *how* something is built, this file
wins; when they disagree about *what* the game does, the design wins unless this file
explicitly overrides it (section 9 lists every override).

The release target is herdr-app 0.1.17 (Linux, macOS, Windows). Mods are JavaScript running in
herdr's single QuickJS VM; elements are GPUI builders from `gpui-kit` / `gpui-base`.

---

## 1. Repository layout and ownership

```
layouts/Down-the-Stack.json     the layout. herdr has no display title, so it lists the layout by its
                                file name; the file is named after the game
mods/down-the-stack/            THE MOD (copied verbatim into ~/.config/herdr-app/mods/down-the-stack).
                                herdr shows the folder name too (§4), so it is named after the game
  mod.json                      {"place":"none", "overlay":{Herd panel dialog}, "palette":[...]}
                                (place MUST be "none"; "overlay" is what `mod.open` opens, §4)
  main.js                       View: role dispatcher + lifecycle (timers, nextCommand)
  host.js                       GameHost: module-scope singleton; snapshot, save/load IO, broadcast
  game/                         PURE engine. No imports of "herdr", "gpui-kit", "gpui-base".
    data.js                     content tables (D§14), exported as JS objects
    rng.js                      xorshift32, FNV-1a 32, rng helpers
    formulas.js                 D§5, D§6, item stat math, number formatting
    items.js                    item generation, naming, IP, compare/score, stash, polish, deprecate, squash, reroll
    heroes.js                   hero creation, naming, derived stats (cached), skills, auto-learn, class signature, careers
    agents.js                   snapshot reconcile: seq gating, seats/binding, forklings, contractors, tasks, chests, seen, shift, fresh eyes, flap guard, unblocked
    combat.js                   rooms, lanes, spawns, rotation, skill effects, traits, coffee, crash, kill rewards, fx emission
    boss.js                     encounters (9 bosses + 2 reviews), mechanic primitives, win estimate, wounds, lessons, suspend
    herd.js                     account systems: buildings, release train, bug tracker, trophies, badges, journal, digest, backlog
    autopilot.js                map choice + convergence, auto-equip sweep, auto-learn, polish, buildings, boss/review challenge
    world.js                    createWorld / loadWorld / serialize / tick / command (D§2.11 pipeline)
    save.js                     compact encode/decode, CRC32, migrations
    view.js                     view-model builders for every role (section 5): pure, testable;
                                a barrel over view/stage.js, view/chrome.js (party, nameplate, hud,
                                tooltips) and view/panels.js (sheet, Herd panel) (§9.10)
    demo.js                     deterministic demo worlds + snapshots for tests, previews and screenshots
                                (ships with the mod but nothing in it imports demo.js: it is never
                                evaluated in herdr; kept beside the engine it drives on purpose)
  ui/                           GPUI renderers. Consume view models only; never read engine internals.
    kit.js                      shared helpers (palette, fonts, bars, pills, own(), zoom, asset paths)
    termling.js                 the Termling rig (hero sprite built from divs) + Forkling
    stage.js                    role "stage"
    party.js                    role "party"   (left sidebar)
    nameplate.js                role "nameplate" (pane header)
    hud.js                      role "hud"     (thin optional strip)
    sheet.js                    role "sheet"   (character sheet dialog)
    herdpanel.js                role "herd"    (Herd panel dialog)
  art/                          generated assets (tools/gen-art.mjs). Never hand-edit; regenerate.
  preview.svg                   layout preview for herdr Settings (also generated)
  LICENSE                       MIT (Tyler Coles), the same text as the repository's root LICENSE
  NOTICE                        the parts adapted from herdr-app 0.1.17 (Apache-2.0), file by file
  LICENSE-APACHE-2.0            herdr-app's licence text, for those parts
tools/
  api-allowlist.json            every valid element method (from herdr source)
  used-methods.txt              the element methods herdr's own shipped mods call (herdr-notes)
  mock/                         Node mocks of "gpui-kit", "gpui-base", "herdr" + strict validator
  check.mjs                     mock `herdr-app check`, run for EVERY role with fixtures (section 7)
  fixtures.mjs                  the role matrix: props, demo world and herdr live data per role
                                (check.mjs and the preview)
  vm-samples/                   sample view models per role (section 4, UI role contract)
  preview/                      HTML renderer of recorded element trees + Playwright screenshots
                                (shoot.mjs: roles; windows.mjs: whole windows of the demo worlds)
  gen-art.mjs                   SVG generator for mods/down-the-stack/art and preview.svg
  art-sheet.mjs                 contact sheet of the generated art (Playwright, out/art-sheet.png)
  pacing-sim.mjs                headless persona simulator (D§12) using the real engine
  qjs/                          the mod in QuickJS-ng with herdr's limits and sandbox (`npm run qjs`;
                                needs `npm install`, see tools/qjs/README.md)
  reference-sim/                the Python model that produced the design's numbers
test/                           node:test unit tests (`node --test "test/*.test.mjs"`), helpers/,
                                fixtures/saves/ (one save text per format this branch has written)
docs/                           DESIGN.md, ARCHITECTURE.md, BALANCE.md, DECISIONS.md (the owner's
                                product calls, made and open), herdr-notes/
README.md, RECIPE.md, preview.png, keys.json (the optional keys section herdr's install flow merges
                                into the person's keys.json), LICENSE (MIT), package.json /
                                package-lock.json (named down-the-stack)
package.json                    "type": "module"; scripts: test, check, preview, windows, art, pacing,
                                qjs; devDependencies only for tools/qjs
```

Only `layouts/Down-the-Stack.json` and `mods/down-the-stack/` are installed. Nothing under
`mods/down-the-stack/` may depend on `tools/` or `test/`. Tests and tools import from
`mods/down-the-stack/` freely. The repository (github.com/tyevco/down-the-stack) and `package.json`
are named `down-the-stack` too; the project's earlier codename is gone from every file, folder and
screen.

---

## 2. Non-negotiable runtime rules (from herdr-notes; violating these breaks the mod)

1. **No herdr call at module top level.** Not even `appHome()`. Module code runs once per source
   revision and is shared by every copy; host calls belong in `init`, callbacks and timers.
2. **Module scope is shared by every copy of the mod** (all roles, pane headers, overlays) because
   herdr runs one QuickJS VM per window (`runtime.md` §1). We rely on this: `host.js` keeps one
   `GameHost` in a module-level variable, created lazily on first `init`.
3. **Hot reload and VM restarts wipe module state** and cancel timers without calling `close()`.
   The game must be able to resume from the save file at any moment. Never store anything only in
   memory that must survive.
   - A hot reload keeps the VM (and `globalThis`), and herdr evaluates the new code once for all
     copies (`quickjs/mod.rs:2348-2352`). A host registers itself at
     `globalThis[Symbol.for("<mod>.live.v1")]` when its load starts (`ensure()` → `register()`,
     never at top level), and remembers the host registered before it (`pred`). The next build's
     `load()` walks that chain to the newest host that finished loading (`giver()`; back-to-back
     reloads can leave the build right before it still loading) and asks it for its world with
     `handover(fileText, {unreadable})`. That host answers with its world as save text plus what the
     new build needs to decide (`continues`, `lastText`/`lastGood`/`ownTexts`, `ioBlocked`, `origin`,
     the save cue and the collapse countdown; the text is `serialize(world)`, so the live
     Contractors cross a reload as their slim records, round 5, §3.2), unless it is still loading, retired, checking or
     read-only. The new build then decides (`load()`):
     - **the old world goes on** (`loadedFrom: "reload"`, no rollback to the save) when the file
       is the one it continues, when the file cannot be read (the read error is carried over and
       the file is never written), when it is missing (the next save creates it), or when it is
       garbage another program wrote (kept aside as `save.broken`, then replaced);
     - **the file is loaded** when another window wrote a valid save since (as `conflict()` does);
     - when the file reads again after the old host could never read it, `recoverRead()`'s rule:
       the file is loaded and the old world kept aside as `save.unsaved` when the old host started
       a fresh herd or the file is a newer version (opened read-only); otherwise the old world goes
       on and the file becomes `save.bak` on the next save.

     The cue (`origin`, the restore note, the warning, `loadedAt`, failed writes, a dismissed
     notice) and the stage's collapse countdown carry over too. A one-argument `handover(text)`
     call (an older build's load) is answered only when the world continues that very file, as
     before.
   - The new host then retires every earlier build's host (`retire()` walks `pred`), whether or not
     one handed its world over: one writer per VM, since a copy whose reload fails keeps running
     the old build, and a host still loading never finishes. A retired host never starts or
     finishes a load and never pumps, saves or posts; a save it still has in flight stands down
     when answered (`retire()` bumps its save generation).
   - Each hot reload keeps the old build's module code, which QuickJS cannot free (about
     2–2.7 MiB a reload in the wasm harness; herdr restarts the VM at 75 % of its 256 MiB heap).
     After a few dozen reloads in one session GC pauses grow with it: a one-frame error banner on
     a copy then is a GC pause inside a render, not a mod bug, and restarting herdr clears it.
   - `npm run qjs -- --only reload` runs the handover in QuickJS-ng the way herdr does (the module
     graph evaluated again as `<file>?v=<n>` in the same context, the old copies' timers and tasks
     released after the new ones start, no `close()`). A new VM has no such host and loads the file.
4. **Never keep a `cx`.** Every callback gets its own. No `setTimeout`/`setInterval` (they throw):
   use `cx.timer.every(ms, (cx) => …)` / `cx.timer.after`. Timers drift: always measure time with
   `Date.now()` deltas.
5. **Budgets:** render ≤ 50 ms, event/timer/task callback ≤ 500 ms, **module eval ≤ 500 ms**
   (herdr loads every copy, and `herdr-app check`, inside a Task scope: `plugin.rs:1235-1250`,
   `scope.rs:221-252`, `sandbox.rs:439-441,513-517`; the 5 s `detached` budget never applies to a
   mod load). The mock enforces 500 ms and warns above 150 ms; measured ≈ 60-130 ms. The tick must
   be cheap (≤ ~5 ms for 30 heroes; measured in QuickJS-ng as a wasm interpreter, `npm run qjs`:
   p50 ≈ 4.3 ms, p95 ≈ 5.4–7 ms, BALANCE §11. herdr runs the same plain interpreter, with no JIT
   tier, natively: `window.rs:518` → gpui-shell `engine/quickjs/mod.rs:1787-1801`). Never do
   catch-up loops of thousands of ticks.
6. **`herdr-app check`** runs module eval, constructor, `init(undefined, cx)`, one `render`, with
   `props()`/`window()`/`placement()` null, empty lists and theme graphite. It runs `init` **with
   live exec and write capabilities** (herdr `src/mods.rs:41-46`, `herdr.d.ts:23-25`).
   - herdr's own `readTextFile`, `writeTextFile`, `exec` and `hc` are **not** narrowed during a
     check. They reach the real app home through plain `std::fs` (`mods.rs:1137-1154`,
     `mod_files.rs:14,124`), and a write only logs "the write lands for real".
   - Only the shared store (`install_check_policy`, `mods.rs:1425-1429`) and gpui-shell's own fs
     capability (`host.rs:603-628,693-711`) are narrowed.
   - So `if (checking()) { …no IO… }` is mandatory before any read, write or exec: a forgotten
     guard can overwrite the person's real save.
   - Render must work with `props()` null (show a tiny placeholder) and with an empty world.
7. **Element rules:** colors are `#rgb|#rrggbb|#rrggbbaa` strings only (theme token names throw in
   `.bg()`; read hex from `theme()`); `.child(null)` throws and `.child(false)` prints "false"
   (filter children); an element may have only one parent and may not be reused across renders;
   `.id()` takes a string; unknown methods throw. Prefer explicit px numbers (`.p(8)`, `.w(40)`)
   over rem ramps (`p_4`). Use only methods in `tools/api-allowlist.json` (the mock enforces it).
   - **Build an element completely before attaching it.** Once it has a parent, herdr rejects any
     further style, child or handler call on it with a TypeError (`spec.rs:1131-1161,1286-1300`;
     the mock throws `reused-element`). Slot and state-style elements are the exception.
   - **An `svg()` takes its colour when it is built** (`materialize.rs:812,1489-1490`): a parent's
     `.hover(s => s.text_color(..))` brightens text children but never the icon. An element that
     holds an icon hovers with its background (`s.bg(..)`), as herdr's own tabs do, and the svg
     gets its colour explicitly.
   - Colours from `theme()` go through `kit.hex()`: herdr accepts `"ff8800"` or `"#ff8800 "` in a
     theme override and hands it on verbatim, but `.bg()` throws on it. This covers `T()`, the
     dialogs' `dialogTokens()` and the stage's `mdr_*` tokens.
   - `ScrollHandle`, the input/editor states and `FocusHandle.focus()` are refused in render and
     layout (`entity_api.rs:1242,1807-1821`): create them in `init` or a handler.
8. **No z-index:** later siblings paint on top. Overlapping hitboxes all receive clicks; call
   `cx.stop_propagation()` in handlers that must not fall through.
9. **Images:** `image(path)` paths are relative to the app home: always
   `` `${ASSETS}/art/...` `` with `ASSETS = "mods/down-the-stack"` (one constant, in `ui/kit.js`,
   so `mod.clone` can rewrite it). The mod's own name is spelled only in forms `clone_mod_at`
   rewrites (`mods.rs:247-257`): `"mods/down-the-stack…"` paths and `mod: "down-the-stack"` keys.
   `host.js` reads `MOD` from `const SELF = { mod: "down-the-stack" }` (and `ui/herdpanel.js`
   spells its own `SELF` the same way), so a clone broadcasts `<clone>.tick`, opens its own
   dialogs, finds its own stage and HUD blocks and saves under `data/<clone>/`. `mod.json`'s one
   palette entry, `mod.open {"name": "down-the-stack"}`, is not rewritten by herdr (its
   `"name": …` is neither form): a clone must edit it by hand, or its entry is a duplicate of the
   original's and herdr's palette drops it (`palette/main.js` `entryId`). Always set both `.w()`
   and `.h()`; fit is always "contain"; no flip, no tint, no rotation. `svg(path)` is a one-colour mask tinted by `.text_color()` and also
   needs explicit size. SVG files must not use `<text>` (fonts are not guaranteed): draw glyphs as
   paths, or overlay real text with a div.
10. **Motion** (`gpui-api.md` §4, `runtime.md` critic Q3):
    - `.loop(prop, {from, to, period, easing})` swings there and back on one process-global clock
      (no per-element phase, no `.id()` needed). Loops with equal periods move in lockstep, so
      vary periods per entity (`period = base + (hash(key) % 9) * 37`). **Loop px values are not
      zoom-scaled**: multiply loop `from`/`to` by `settings().zoom`.
    - `.transition(prop, {duration, delay?, easing?})` animates *later* changes of a static value
      for the element with the same `.id()`. First appearance snaps. Only plain numbers / "Npx"
      animate (not rem, %, auto). Opacity animates only if `.opacity()` is set explicitly.
    - `.frames(list, ms)` cycles the element's text natively (≥ 16 ms). `.spin(ms)` only on `svg()`.
    - Properties: `opacity | width | height | left | top`.
    - Animated GIF/WebP is allowed but freezes when the window is inactive; we use SVG + motion.
11. **Re-render cost:** every redraw of any mod copy redraws the whole window. Data ticks at 1 Hz;
    everything between ticks is native motion. Never `cx.notify()` from a fast timer.
12. **`setShared` is expensive** (re-renders every copy of every mod and rewrites shared.json):
    never per tick. We don't use it for game state at all: the only calls are the party rail
    button's herdr-wide `sidebar.width` / `sidebar.collapsed`, on a click (`ui/party.js`, as
    herdr's own agents and workspace-chrome mods do).
13. **localStorage is per (mod, props)**; pane headers and overlays each get their own. Use it
    only for per-copy UI conveniences, never for game state. The mod uses none: the sheet's last
    tab is kept in module scope (`ui/sheet.js` `LAST`), since every sheet's props differ.
14. **QuickJS compatibility:** ES2020-level JS. Don't use private `#fields`, static blocks,
    `structuredClone`, top-level `await`, JSON imports, `eval`/`new Function`, or extend built-in
    prototypes (they're frozen). Relative ESM imports must include `.js`.
    - Release herdr freezes `Object.prototype` and friends (`sandbox.rs:77-96`). A plain object
      keyed by an outside id (a herdr tab id, a `herdr.tab` label, a program key, a map id from a
      command) breaks on ids like `constructor` or `toString`: writing throws, reading finds a
      builtin. Such maps are `Object.create(null)` (data.js lookup tables, `host.snapshot` tabs) or
      are read through an own-property check (`chrome.js own()`). `npm run qjs -- --only fuzz`
      feeds these ids.
15. **No sound, no notifications by default** (D§11.15). `notify()` only for the three opt-in
    milestones, posted by `host.js` alone (§4), never while `checking()`; the mod never calls
    `playSound` (herdr's `notify` has no sound of its own: the toast mod draws it, `mods.rs:1342-1347`).

---

## 3. Engine data model (game/*)

Everything in `game/` is deterministic given `(state, snapshot, nowMs)`: no `Date.now()`, no
`Math.random()`, no host calls. RNG state lives in the save (D§12.3.12).

### 3.1 Content (`game/data.js`)

`data.js` exports the D§14 tables as plain objects, keeping D§14's string ids and array order
(array index = integer id in saves; append-only):

```js
export const TUNING   // D§14.1 "tuning"
export const CLASSES  // D§14.1 "classes" (index 0 = intern)
export const CAREERS
export const SKILLS   // D§14.2: { slots, autoLearnTieOrder, byClass: { intern: [...], refactorer: [...7], ... } }
export const ZONES    // D§14.3 (9 zones, each with 3 maps)  + BACKLOG descriptor
export const TRAITS, ELITE, HOLO_DUCK, MOBS          // D§14.4
export const BOSSES, REVIEWS                          // D§14.5
export const RARITIES, AFFIXES, LTS_PROPS, KEEPSAKES  // D§14.6
export const ITEM_BASES                               // D§14.7
export const BUILDINGS, BADGES, NAMES, PALETTE        // D§14.8
export const MAPS          // derived flat list [{id:"1-1", zone:0, idx:0, levels:[1,4], spawn:{...}, name}]
export const MOB_BY_ID, BOSS_BY_ID, MAP_BY_ID, ZONE_BY_ID  // derived lookups
```

Content ids used by art and UI (must match exactly): zone ids `lint_meadows … undefined_depths`
(+ `backlog`), map ids `"1-1" … "9-3"`, the 27 mob ids, the 9 boss ids, adds `warning_mite`,
`nitpick`, the review ids `senior_review` / `staff_review`, class ids, rarity ids, chest tiers
`wooden|iron|silver|gold`.

### 3.2 In-memory state (`world.state`, saved) and runtime (`world.rt`, not saved)

The save file is the compact encoding of `world.state` (D§13; `save.js` maps readable keys to
compact ones). Engine authors may add fields; they must add them to `save.js` too, with defaults
on load.

```js
Item  = { uid, base, ilvl, rar, pol, aff: [[affixIdx, roll0to99], ...], flags, prop }
        // rar 0..5 (5 = Keepsake: prop = keepsake idx); rar 4 LTS: prop = LTS property idx; else prop = -1
        // flags: 1 locked, 2 new.  uid: from state.herd.nextUid (saved).

Hero  = { id, seat, sid, ord, name, cls, prov, L, xp, sp:[7], spFree, autoLearn,
          rev:[0|1, 0|1], eq:[Item|null ×6], pinMap:null|"2-2", fe, shift:{day, min},
          cups, hpFrac, sig:{tm:[...≤20 task minutes], blocks, workMin, subTasks, n},
          pend:[{min, fmin, title, at, sealFactor}], cd:{unblockedUntil, unblockedCdUntil, boss:{}},
          addr, lastPane, lastTab, seenAt, st:{kills, tasks, seals, wh, dodges, healed}, rng,
          look? }   // round 4b: a promoted Contractor's hoodie tint (index into
                    // PALETTE.termlingTint), saved in the hero's extras ("x": {"look": n}) so an
                    // older build keeps it; heroes.lookOf reads it, else (|id| - 1) mod 8

Herd  = { name, gold, snip, bld:[6], zone, quota:{[mapId]:kills}, meter, bank, seals, rel,
          boss:[9], bossKills:[9], fight:null|SuspendedFight, wounds:{}, lessons:{},
          bt:[9], badges:[...ids], stash:[Item...], fame:[...], backlog:{floor, kills},
          digestAt, cfg:{auto:{equip,deprecate,learn,polish,buildings,maps,boss,farm,calls,career},
          autopilot /*master switch*/, calm, stageH, nums:"all"|"crits"|"off", glow /*loot glow min
          rarity 0..5*/, collapse, collapsed /*host: it hid the stage*/, idleAt /*host: when its
          collapse countdown started, saved as "idle" only while set*/, notify:{boss,lts,principal}},
          log:[[at, kind, heroId, text, value, name?]...≤60-120], unseenUnrev /*round 4*/,
          nextUid, nextHeroId, rng, day, lastMs, tick,
          contractors /*round 5*/ }
          // journal kinds: ship, unrev (chests opened Unreviewed: text the task, value the count),
          // level, promo, drop, boss, retire, hire, hired (round 4: "Hired: <name> (was a
          // contractor)", value its level), leave, class, map, deprecate, badge
          // name (round 4): the hero's name on every line about a hero, through save.js's str
          // table; herd.lineName reads the roster's name now, else this. Contractor ids in the
          // journal are written 0 on load (they last one session); older rows without a name load
          // unchanged
          // unseenUnrev (round 4): chests opened Unreviewed since the Digest was last viewed
          // (agents.openChests adds, lossesSeen / digestSeen clear); saved in herd.x by its name
          // fight.ids never hold Contractor ids (negative) after a load (world.js repairLoaded):
          // a Contractor's slim record keeps no seat in a fight, so it rejoins a resumed fight only
          // by standing in its zone (boss.resumeFight)
          // contractors (round 5): the slim records of Contractors whose agent is away, readable
          // {seq, seat, L, xp, cls, prov, rev:[0|1,0|1], since, day, tag, sig?, name?} (agents.js
          // "Contractor records"); world.serialize writes them with every live Contractor's record
          // (agents.contractorRecords), saved under "ct" (below)

world.state = { v, gen, herd: Herd, heroes: [Hero...] }

world.rt = {                // rebuilt from snapshots; never saved
  tick, nowMs, version,     // version++ whenever anything visible changed this tick
  bind: Map<address, heroId>, live: Map<heroId, Live>, contractors: Map<address, Hero>,
  rooms: Room[], fights: Fight[], fx: Fx[], notes: Note[], banner: null|Banner,
  dirty, majorAt, lastSaveMs, errors: [],
  tzOffsetMin,              // from the snapshots (tick) or a command's tzOffsetMin argument
  msHeld,                   // milestones raised before the time zone was known (counted at the next tick)
  firstKeepsake,            // {i, name}: a herd-first kill's Keepsake, named in that kill's boss toast
  _hireLine,                // round 4: agents.hireOutlook's cache {key, line, room, ends}, once per tick
  startMs,                  // round 4b: this world's first reconcile (agents offDutySince)
  loadedLastMs,             // round 4b: the loaded save's herd.lastMs (world.loadWorld): the time
                            // the app was closed does not count in a hero's off-duty grace
  offPane,                  // round 4b: Map<heroId, pane> the pane a hero's terminal ended in, this
                            // session only (pickFreeHero ranks that hero first for a terminal there)
  contractorSeq,            // the last Contractor number given (id = -seq); round 5: loadWorld starts it
                            // at the loaded records' highest, so a new Contractor never takes one's
  recWait,                  // round 5: Set<seq> of the loaded records not claimed yet: they hold
                            // their hires while the reconnect window is open (agents.reconnectOpen)
  _restored                 // round 5: Contractors brought back from a record in this reconcile
}                           // a Contractor (rt.contractors) also carries since: when it arrived, its
                            // place in the hiring line (promoteContractors: longest-running first);
                            // a record keeps it, so a Contractor back from one keeps its place
                            // Note = {key, text, color, bornTick, showTick, kind?, heroId?, name?,
                            //   promoted?, extra?, short?}: round 4b tags from ev.note(text, color,
                            //   tag) (world.js pushNote); extra: a tick's second and later hire
                            //   notes, which do not count against the six-note queue; short (round
                            //   4c): [string], shorter forms, longest first

Live = {                    // per bound, live hero
  address, status, seq, statusSince, state: "questing"|"waiting"|"shipped"|"resting"|"supervising"|"crashed",
  focused, pinned, program, app, title, space, spaceName, tab, tabName, pane, paneName,
  machine,                  // round 4: agents.machineOf (null: this computer); Rebind keeps it
  task: null|{openTick, workSec, blockedSec, sealAcc, forkSec, spawned, closeCountdown},
  blockedSince, bubbleShown, forklings: [{address, status, title, program}], flap:[ticks],
  hp, maxHp, buffs:[{id, until, ...}], cds:{slot: readyTick}, actionCount, bisect:{target, stacks},
  crashedUntil, lastCupTick, mapId, lane: [Mob...], engagedUid, statsCache, crashes:[ticks]
}

Mob   = { uid, mobId|"warning_mite"|..., level, hp, maxHp, elite, holo, arriveTick, engaged,
          swingTick, traits: {...runtime trait state}, lanePos: 0|1|2 }
Room  = { id, mapId, zone, heroIds:[...], spaceId }     // recomputed when membership changes
Fight = { kind:"boss"|"review", bossIdx|reviewId, heroIds, parts:[{key,label,hp,maxHp,...}],
          phase, t, timer, enraged, mech:{...}, startedTick, banner }
Fx    = { key:"fx:<tick>:<n>", bornTick, kind, heroId?, mobUid?, roomId?, text, value, rar?,
          x?, y? }              // kinds in section 6.3; engine emits, view.js positions
```

**Contractor records (round 5, owner decision; D§3.4, D§13.2).** A Contractor is not a roster hero,
but the save keeps it as a slim record so it comes back as itself after a restart or hot reload.
`herd.contractors` holds the records of Contractors whose agent is away (one is left by
`agents.goOffDuty` when a Contractor's terminal ends); `world.serialize` adds a record for every live
Contractor (`agents.contractorRecords`: live ones first in hiring order, then the others; expired
ones dropped; at most `T.roster.max` in all), so `world.state` alone is not the whole save while
Contractors play. `save.js` writes them under `herd.ct`, one array row each:

```
[seq, seat, L, xp, k, since, tag, day?, extras?]
 seq    the Contractor's number: its id is -seq, and its default name (heroes.heroName(seat, 1000 + seq)),
        hoodie (heroes.lookOf) and hat (its kit's hat uid -(seq × 10 + 2), items.hatToneOf) follow from it
 seat   agents.seatKey's "space@machine/program", through the str table when a hero or another
        record shares it
 L, xp  level; XP to the whole point
 k      class | provisional << 3 | Senior review << 4 | Staff review << 5
 since  minutes from lastMs: its place in the hiring line (a tie: the lower number came first)
 tag    agents.tagOf(address): the top 24 bits of FNV-1a 32 of its terminal's address in base 36
 day    the game day it was last seen, from the top-level day (left out when 0 and nothing follows)
 extras {"sg": the signature window as hero.sig is written, only for an Intern or a provisional
        class; "n": a name other than the default; any other readable field}
```

About 35 bytes with a seat in the `str` table, 58 with a 26-character seat inline, about 125 for an
Intern with a full 20-task window. A row without a number or a seat is dropped on load; an unknown
class falls back as a hero's does. The list is left out when empty, so a save without Contractors is
byte-identical to before; an older build drops `ct` (its Contractors come back new). `loadWorld`
starts `rt.contractorSeq` at the highest number and fills `rt.recWait`; `repairLoaded` mends a
record's seat like a hero's and still clears negative ids elsewhere (journal, fight, Wounds,
Lessons, inbox): a Contractor's session-keyed state does not outlive the session.

Fields added during the build (all saved ones have defaults on load in `save.js`):
`herd.born` (the herd's first local day; `herd.herdAgeDays`, the Campfire gate), `herd.inbox` (chest
items waiting to be offered, one per tick), `herd.digestSnap` and `herd.drops` (the D§10.7 digest
baseline), `Mob.hitCt` (combat clock of the first landed hit: the swing timer starts there),
`live.tally` (per-hero counters incl. `chestXp`, `bossXp`, `reviewXp`) and `rt.tzOffsetMin` (the last
snapshot's time zone, for the views' dates). Why each exists: `docs/BALANCE.md`. For the D§11.15
settings and notifications: `herd.cfg.autopilot` / `glow` / `collapse` / `collapsed` (above),
`herd.notified` (`[local day, raised that day, last sequence number]`: the daily cap survives
restarts) and `herd.milestones` (raised, not yet taken by the host).

### 3.3 Snapshot (what `host.js` passes into `tick`)

```js
Snapshot = {
  nowMs, tzOffsetMin,            // new Date().getTimezoneOffset() (minutes, as JS reports it)
  weekday,                       // 0..6 local (for Read-Only Friday)
  windowActive,                  // window()?.active ?? true
  focusedTerminal,               // focused()?.terminal ?? null
  agents: [{ address, status, seq, app, program:{key,name,icon,tint,tile,color},
             title, space, space_name, tab, tab_index, tab_name, pane, pane_name, pinned, focused }],
  subagents: [{ address, parent, status, title, program }],
             // from terminals(): k.parent && k.state === "live" && not in agents();
             // status word: "error"→"blocked", "done"→"idle" (patterns.md §1.7)
  tabs: { [tabId]: { working_since } },   // from spaces()[].tabs[]
  spaces: [{ id, name }]
}
```

### 3.4 Engine API (module boundaries)

Authors of each module implement exactly these exports (more are allowed). Cross-module calls go
only through these.

```js
// rng.js
export function xs32(state) -> nextState            // xorshift32 step (state ≠ 0)
export function rngNext(holder) -> float in [0,1)   // holder = object with .rng (hero or herd); mutates
export function rngInt(holder, lo, hi) -> int       // inclusive
export function rngPick(holder, weightsObjOrArray) -> key|index
export function fnv1a32(str) -> uint32
export function hashKey(str) -> uint32              // alias used by renderers for phase/period jitter

// formulas.js  (pure math; D§5, D§6, D§8)
export const g, refHit, refHP, refArmor, refDPS, mobHP, mobATK, mobXP, gold, K, need, gap, DR, itemTier,
       weaponDmg, armorPiece, itemPower, polishCost, buildingCost, releaseSeals, fmtNum, fmtDuration
export function autoOn(state, key) -> boolean       // an autopilot system: its switch AND the master switch
export function cutText(s, n) -> string             // at most n UTF-16 units, never half a surrogate pair
export function shortName(name, max = 10) -> string // a hero's first word for a short note (round 4c), cut with cutText
export function wellFormed(s, repl = "\uFFFD") -> string  // lone surrogates replaced (or dropped with "")
// herdr's bridge refuses a string with a lone surrogate (rquickjs's UTF-8 conversion): every cut of
// outside text (titles, seats, task labels) goes through cutText
export function mobStats(mobDef, level, {elite, bossMult}) -> {hp, atk, xp, gold}

// items.js
export function rollItem(holder, {ilvl, source:"kill"|"elite"|"chest"|"duck"|"boss"|"review", slot?, classId?, minRar?, itemFind}) -> Item
export function itemName(item) -> string
export function itemStats(item) -> {weaponDmg, armor, affixes:{memo:0.05,...}, prop}
export function scoreDelta(hero, item, slotIdx, ctx) -> number      // autopilot score (D§8.7)
export function autoEquip(state, hero, item, ctx) -> {equipped:boolean, replaced:Item|null}
export function stashAdd(state, item) -> {kept:boolean, deprecated:Item|null}
export function deprecate(state, uid) -> {ok, snippets, gold}
export function polish(state, uid) -> {ok, cost}
export function squash(state, uids) -> {ok, item}      export function reroll(state, uid, affixIdx) -> {ok}
export function hatToneOf(uid) -> 0..5                    // round 4b: a hat's tint (PALETTE.hatTint), uid mod 6, in
                                                          // range for a Contractor's negative uid too
export function skipUidsToTone(state, tone) -> void       // round 4b: moves herd.nextUid on (at most 5) so the next
                                                          // uid has that tint: a promoted Contractor's hat keeps it

// heroes.js
export function newHero(state, {seat, sid, ord, nowMs}) -> Hero
export function heroName(seat, ord) -> string
export function stats(hero, ctx) -> Stats   // cached by (L, eq uids/pol, sp, cls, buff-free) ; ctx = {herd, roomBonuses}
export function grantXP(state, hero, amount, ev) -> {levels:int}      // level-ups emit fx via ev
export function careerOf(hero) -> {title, tier}
export function lookOf(hero) -> 0..7                      // round 4b: the hoodie tint (PALETTE.termlingTint): hero.look,
                                                          // else (|id| - 1) mod 8 as every build has drawn it
export function classSignature(hero) -> {recommended, median, bph, sub, n}
export function autoLearn(hero) ; export function learn(hero, slot) ; export function respec(hero, nowMs, {herd})
export function setClass(state, hero, cls) ; export function recordTask(hero, task, {learn})
// respec, setClass and a provisional switch (recordTask) re-spend refunded points only while
// autoOn(state, "learn") (the herd's switch and the master switch; recordTask's opts.learn, which
// agents.closeTask passes); points left unspent are spent by the next autopilot pass
export function skillValue(hero, slot) -> {def, rank, coef, cd, ...}  // rank-resolved skill numbers
// (the D§7.1 rotation itself lives in combat.js, which owns the action loop)

// agents.js
export function reconcile(world, snapshot, ev) -> void   // bind/unbind, seq-gated status, forklings, contractors, seen
export function stepStatus(world, hero, live, ev) -> void // per tick: tasks, 8 s close, chests, unblocked, flap, shift
export function openChests(world, hero, {reason}, ev) -> void  // reason "unreviewed": one "unrev" journal line
export function questName(raw, who) -> string              // a task's name: telling title, glyph stripped, cutText to 40
export function whyOf(world, hero, live) -> Why           // the why line's numbers; why.gap is the level gap as
                                                          // combat.kill applies it (none below ×1 in the Backlog)
export const _internal                                     // test-only (tellingCacheSize)
export function heroState(live) -> "questing"|"waiting"|...
export function tellingTitle(raw, who) -> string           // herdr's agents-list title test ("" = says nothing); a task keeps only telling titles
// round 4: tellingTitle also rejects a title that repeats who's spaceName, tabName or paneName
// (trimmed, case-insensitive, glyph stripped), except a string exactly equal to the pane's or a
// named tab's own name (the person's name for the place: chrome.taskLabel's fallback); its cache
// key holds those names and the strictness. questName (task and chest titles; openChests for an
// off-duty hero: its last seat, tab and pane, a remote machine suffix stripped) has no exception
export function seatKey(spaceName, spaceId, programKey, app, machine?) -> string   // D§3.1; a remote
                                                          // space: "space@machine/program" (local unchanged)
export function machineOf(agent) -> string|null           // agent.machine, else the "<machine>/" prefix of its
                                                          // space id or address (herdr mirror.rs qualify)
export function hiredToday(state) -> number               // hires this game day (D§3.4: 6)
export function promoteContractors(world, ev, spare?, recs?) -> number   // round 4, D§3.4 as built: at every reconcile
                                                          // before new terminals bind, and on retire; longest-running
                                                          // live Contractor first while hires are left and makeRoom
                                                          // finds room (a free slot, else rosterVictim: the least-
                                                          // recently-seen unbound hero below Lv 10 past its off-duty
                                                          // grace is let go); spare: heroes the new terminals of this
                                                          // snapshot claimed (reconcile step 1a); never on a read-only
                                                          // world. promote() keeps the Contractor's look (hero.look,
                                                          // its hat's tint through skipUidsToTone) and renames every
                                                          // id-keyed thing: combat.renameHero, boss.renameHero (or the
                                                          // fight remap for a stubbed boss API), journal, inbox finder.
                                                          // recs (round 5): address -> record the snapshot's terminals
                                                          // claimed; those, and loaded records within the reconnect
                                                          // window, stand in the line by their place and hold a hire
                                                          // and room each (heldRecords), so those behind them take only
                                                          // what is left beyond them
export function makeContractor(world, a, seat, nowMs, rec?) -> Hero   // D§3.4; rec (round 5): a record its terminal claimed:
                                                          // the same Contractor (id -seq, level, XP, class, reviews,
                                                          // signature, since), its kit and skills rebuilt
export function contractorRecords(world) -> [record]      // round 5: what the save holds (world.serialize): every live
                                                          // Contractor's record, then herd.contractors without expired
                                                          // ones, capped at T.roster.max; a read-only world: as loaded
export function tagOf(address) -> string                  // round 5: a record's terminal tag (base 36, at most 5 chars)
export function inOffDutyGrace(world, hero) -> boolean    // round 4b: an unbound hero off duty for less than
                                                          // T.roster.offDutyGraceMin (15) of world time: from seenAt,
                                                          // moved on by the app-closed gap for a hero not seen since
                                                          // the load (rt.loadedLastMs → rt.startMs); never let go
export function offDutyGraceEnds(world, hero) -> number   // round 4b: when that grace ends (ms), 0 when none is left
export function hireOutlook(world, heroOrId) -> null|{when:"soon"|"grace"|"day"|"slot"|"never"|"reconnect", position,
       ahead, hiresLeft, perDay, room, graced, held, atMs, days, text} // when a Contractor is hired (views: chrome.hireLine,
                                                          // panels hireOf); cached per tick in rt._hireLine. Round 4b:
                                                          // room counts graced heroes too (graced of them); "grace":
                                                          // hired when a graced hero's grace ends at atMs (unless its
                                                          // agent comes back); "soon" counts room free now only. Round 5:
                                                          // the line counts loaded records within the reconnect window
                                                          // (held of them ahead); "reconnect": hired when the window ends
                                                          // at atMs unless they come back first
// reconcile's order (round 4b): 0. unbind ended terminals (goOffDuty: seenAt, rt.offPane; round 5: a
// Contractor leaves its record); 1a. every new terminal claims its saved hero: first each one's own
// hero by saved address (ownHeroFor), then a free hero of its seat in snapshot order (pickFreeHero,
// ranking first the hero whose terminal ended in that pane this session); 1a'. round 5: every new
// terminal still without one claims a Contractor record of its seat: first each one's own record
// (by tag), then one of its seat in snapshot order (recordFor: highest level, the longest-running);
// 1b. promoteContractors(spare = the claimed heroes, recs = the claimed records); 2. bind and
// refresh top-level agents (a claim is taken; a record makes its Contractor again, makeContractor;
// else D§3.2, a newcomer hired only with a hire and room left beyond the held records and live
// Contractors); 2b. round 5: promoteContractors again when a record was taken (the Contractor
// back from it is hired in this reconcile while hiring is open); 3. sub-agents; 4. seen, focus.
// Round 5's reconnect window (reconnectOpen): from a load until T.roster.reconnectSec after
// rt.startMs, while a loaded record (rt.recWait) is unclaimed; records are pruned (expired after
// T.roster.contractorKeepDays game days, capped) at every reconcile

// combat.js
export function buildRooms(world) -> Room[]
export function renameHero(world, oldId, newId) -> void  // round 4b: a promotion's new id in rooms (heroIds, a room
                                                          // id named after its first hero), fx, actors' _act.roomId,
                                                          // _cg.fighting and apGear; rt.roomOf rebuilds
export function stepRoom(world, room, ev) -> void        // one lane tick for every questing/supervising hero in it
export function restTick(world, hero, live) -> void      // regen, coffee refill, fresh eyes

// boss.js
export function canChallenge(world, kind, idx) -> {ok, estimate, label}
export function startFight(world, kind, idx, heroIds, ev) -> Fight
export function stepFight(world, fight, ev) -> "running"|"won"|"lost"|"suspended"
export function estimate(world, kind, idx, heroIds) -> number
export function leaveSavedFight(world, heroId, ev) -> boolean   // retire / eviction: out of the paused fight
                                                          // (herd.fight); one nobody is left in ends as a Postmortem
export function renameHero(world, oldId, newId) -> void  // round 4b: running fights (heroIds, helpers), the paused
                                                          // fight (ids, hl), review Wounds and Lessons (rv<i>.<id>);
                                                          // reached through autopilot.bossApi

// herd.js
export function addGold(state, n) ; export function addSeals(world, n, ev) ; export function buy(state, bIdx)
export function herdXpBonus(state) -> number ; export function journal(state, kind, heroId, text, value, nowMs, name?)
export function lineName(state, line, byId?) -> string|null   // round 4: a journal line's hero name: the roster's
                                                          // name now (a rename shows), else the stored one, else null
export function unseenLosses(state) -> number             // round 4: herd.unseenUnrev, or (an older save) the journal's
                                                          // "unrev" lines since digestAt
export function digestDot(world) -> boolean               // rt.digestDot (back after 30 min away) or unseenLosses > 0
export function logDrop(world, hero, item, ev, {roomId, milestone}) // notable drops: journal, header note, digest count,
                                                          // pillar (roomId "arena": before the boss) and the "lts"
                                                          // milestone unless milestone:false (a herd-first Keepsake
                                                          // while the boss toast names it)
export function checkBadges(world, ev) ; export function bugTrackerKill(state, zone, elite)

// autopilot.js
export function autopilot(world, ev) -> void              // every 60 ticks and on level/gear change

// world.js
export function createWorld({nowMs, seed}) -> World
export function loadWorld(text, {nowMs}) -> {world, warning:null|string}   // repairLoaded mends an older build's
                                                          // half-emoji seats, chest titles and journal texts, and drops
                                                          // Contractor ids from the paused fight, review Wounds and
                                                          // Lessons (rv<i>.<negative>) and inbox finders (round 4b);
                                                          // records rt.loadedLastMs; round 5: rt.contractorSeq from
                                                          // the records, rt.recWait (none on a read-only world)
export function serialize(world) -> string                // JSON with crc; a held offline gap (rt.offlineHold) is
                                                          // written as not yet seen (lastMs − the held gap), so a
                                                          // restart or hot reload during the hold finds it again (§2.3);
                                                          // round 5: with agents.contractorRecords as herd.contractors
export function tick(world, snapshot) -> {advanced:boolean, ticks:int}   // D§2.11; uses snapshot.nowMs
export function command(world, name, args, nowMs, tzOffsetMin?) -> {ok:boolean, error?:string, msg?:string}
export function raiseMilestone(world, kind, {title, body}) -> boolean   // D§11.15, via ev.milestone
export function takeMilestones(world, nowMs) -> [{n, kind, at, title, body}]   // the host drains them
// World = { state, rt }
```

`ev` is a small emitter `{ fx(kind, data), note(text, color, tag?), banner(text, sub), major(),
journal(kind, heroId, text, value, name?), milestone(kind, data) }` that `world.tick` creates per tick
(note's `tag`, round 4b: `{kind: "hire", heroId, name, promoted?}` for a hire, `{heroId}` for a note
about one hero, the provisional class, a fall-back and chests opened Unreviewed; the stage reads
them, and a tick's second and later hire notes do not count against the six-note queue; round 4c:
`short`, a string or a list, longest first, of shorter forms that keep the note's point, "Tamsin:
chest opened Unreviewed" (`formulas.shortName` gives the first name), on any note; a Review's and a
retirement's notes carry the hero's id too)
(journal's `name`, round 4: the hero's name, which `emitJournal` and `boss.jot` fill in; leave and
retire lines pass it because the hero has left the roster); it enforces the fx budgets (D§11.7)
and marks `rt.version++`. `ev.milestone` (kind `boss` | `lts` | `principal`) passes only on a *live*
emitter: `world.tick` makes its emitter live unless the call is the VM's first (an app start or a
reload: chests seen on reopening), the one that settles an offline gap held for the first agent
listing (`rt.offlineHold`), an offline gap or a clock behind, and turns it off while it settles an
offline gap; `world.command` is live (a person's own action). `raiseMilestone` then
queues it in `herd.milestones` only when `herd.cfg.notify[kind]` is on and fewer than 3 were raised
this local day (the D§2.9 day, 04:00 local, from `rt.nowMs` and `rt.tzOffsetMin`; a clock that went
back a day keeps the later day's count, one more than a day back counts afresh). A milestone raised
before the time zone is known (a click within a second of a load or hot reload, with no
`tzOffsetMin` passed to `command`) waits in `rt.msHeld` and is counted toward its own local day at
the next tick; the host passes the time zone with every command, so this is a fallback. Hooks:
`world.bossKills` (a herd-first kill of a zone boss; it names that kill's Keepsake, `rt.firstKeepsake`,
while "boss" is on), `herd.logDrop` (an LTS or Keepsake drop, including a boss's Keepsake: a
repeat kill's always, a herd-first kill's only while "boss" is off), `heroes.grantXP` (a roster hero
promoted to Principal; Junior, Senior and Staff raise nothing).

### 3.5 Commands (UI → engine), all via `GameHost.command(name, args)` → `world.command`

| name | args | effect |
|---|---|---|
| `claimChest` | `{heroId}` | open pending chests (counts as seen) |
| `markSeen` | `{heroId}` | same as focusing the terminal (used on clicks) |
| `equip` | `{heroId, uid}` | equip from stash (swap old into stash, port polish) |
| `lock` | `{uid, locked}` | lock/unlock item |
| `polish` | `{uid}` | polish one level |
| `deprecate` | `{uid}` | salvage |
| `squash` | `{uids:[3]}` | Squash Merge (CI Forge 3) |
| `reroll` | `{uid, affix}` | Reroll (CI Forge 5) |
| `learn` | `{heroId, slot}` | spend 1 SP |
| `autoLearn` | `{heroId, on}` | toggle; spends at once only while `autoOn(state, "learn")`, else its msg says the herd's switch or the Autopilot is off |
| `respec` | `{heroId}` | D§7.1 |
| `setClass` | `{heroId, cls}` | D§4.2 override / career change |
| `pinMap` | `{heroId, mapId\|null}` | stay here / auto |
| `challenge` | `{kind:"boss"\|"review"\|"backlog", idx, heroId?}` | manual challenge (`backlog`: idx = floor) |
| `retreat` | `{}` | end the current fight as a Postmortem |
| `rename` | `{heroId, name}` or `{herd:true, name}` | rename |
| `retire` | `{heroId}` | Lv 30+ to Hall of Fame; its pending chests open at full value (a click), and it leaves a paused boss fight (`boss.leaveSavedFight`); the freed slot promotes a waiting Contractor at once (round 4, `promoteContractors`) |
| `rebind` | `{heroId, address}` | move a live agent onto a benched hero (its machine, `live.machine`, goes with it) |
| `buy` | `{building}` | buy a building level |
| `setting` | `{key, value}` | herd.cfg.*: calm, nums, stageH, glow (a rarity id or 0..5), collapse, auto (the master switch: `cfg.autopilot`; the systems keep their own values), auto.*, notify.*; and collapsed (the host's note that it hid the stage) |
| `digestSeen` | `{}` | clears the Herd button's "since you last looked" dot (D§10.7) and the unseen-loss count (`herd.unseenUnrev = 0`) |
| `lossesSeen` | `{}` | round 4: the unseen-loss count to 0 (the Herd panel runs it from its timer while the Digest tab is shown), the Digest's lines kept |

---

## 4. Host integration (`host.js`, `main.js`)

```js
// host.js
let HOST = null;                       // module scope; created lazily
export function getHost() { if (!HOST) HOST = new GameHost(); return HOST; }

class GameHost {
  constructor() { /* no herdr calls */ this.world = null; this.loading = null; this.version = 0; ... }
  ensure(cx)      // first call: if checking(): world = createWorld(…) in memory, no IO.
                  // else register() (§2.3: the next build finds this host even while it loads),
                  // then cx.spawn(async) load(): the previous build's world (hot reload, §2.3) →
                  // save.json → save.bak (also when save.json is missing) → either file re-signed
                  // when its only fault is the checksum (loadedFrom "unchecked") → a new herd.
                  // A text that does not load is kept aside (keepAside): save.broken the first
                  // time (created, never overwritten), then save.broken-1, -2, -3 (created while
                  // free; once all three are taken the oldest gives way: -1 ← -2 ← -3 ← the new
                  // text, each writeTextFile expecting the text just read; a copy that cannot be
                  // read is never written over; a text kept under any of the four names is not
                  // written again). No listing or removal and no program runs: herdr's mod API has
                  // neither without exec. A save.json
                  // that fails to *read* is read again after 1, 3 and 6 s, then on the 30 s beat
                  // (recoverRead()); when it reads again a herd that started fresh comes back and
                  // the session's world is kept aside as save.unsaved (then save.unsaved-1..3,
                  // the same rule); a newer version's save found then is opened read-only
                  // (never written or rotated into save.bak) and this session's world is kept as
                  // save.unsaved; a text this host wrote itself is ours (no rollback).
                  // Until loaded, view() answers null.
  pump(nowMs)     // if now - lastPumpMs < 900 → return false. Build Snapshot from herdr live data
                  // (agents(), terminals(), spaces(), focused(), window()) and call tick(world, snap).
                  // Returns true if the world advanced; then maybeSave(); then broadcast.
  broadcast()     // run(`${MOD}.tick`) → every shown copy's nextCommand() loop does cx.notify().
                  // Skipped when mayBeShown() finds no copy that herdr could show (it walks the
                  // live layout() like herdr: hidden blocks, the first visible stack child, floats,
                  // pane headers only with an open tab, open dialogs): herdr delivers <mod>.<cmd>
                  // to shown copies only and toasts "down-the-stack.tick failed" otherwise.
  claim(cmd)      // dedupe UI commands that reach every shown copy: first claim within 300 ms wins
  command(name, args)   // world.command(...) then version++ and broadcast
  maybeSave(force)      // single writer; writeTextFile(path, text, lastText) where lastText is
                  // the exact text last read/written (null only when the file is absent).
                  // Every 30 s while dirty, 2 s after a major event, and in close().
                  // Keep save.bak: before replacing save.json, write the previous text to save.bak
                  // (same expected-text discipline). Never write while checking().
                  // A save that lands while its promise never settles (its copy closed) is
                  // recognised as our own (the last 4 texts written), never reloaded as a conflict.
  flush()         // close(): never awaits a save started earlier (at quit herdr cannot settle it,
                  // lifecycle.rs:104-114): drops it, reads save.json and writes over it when it
                  // holds a text of ours. Every write carries a generation; a superseded one stops.
  saveStatus()    // null, or {readOnly, notSaving, restoredFrom: null|"bak"|"fresh"|"unchecked",
                  // title, message, detail, since}, read from host.origin (save|bak|fresh|unchecked|
                  // new; a hot reload carries origin, the note, the warning, loadedAt, failed
                  // writes and a dismissed notice, while stats.loadedFrom says "reload" for
                  // diagnostics): save trouble the player must see (D§13.1,
                  // D§13.4). The stage, party, hud and herd views get it as args.save (not in the
                  // memo key: a change moves host.version). main.js draws a dismissable chip in the
                  // stage's sky; the party footer (a dot on the rail) and the HUD show an amber cue
                  // (PartyVM.save / HudVM.save) that opens the Herd panel, so it is seen with the
                  // stage hidden; the Herd panel shows a band under its header (HerdVM.save).
  takeMilestones(nowMs) / post(list)   // D§11.15 notifications (below)
  stageAuto(nowMs, {turnedOn?})        // D§11.15 "collapse the stage when nothing is working" (below)
  stageInfo()     // round 4: {id, hidden, held} of this mod's stage block found by content (held:
                  // the collapse hid it, stageHeld(): this window's note, else the saved
                  // cfg.collapsed before the first stageAuto), or null (no stage, checking(), a
                  // retired host). For STAGE_WANT_MS (2 s) after stageStrip() it answers the state
                  // asked for, since herdr runs a mod's run() only after the callback returns and
                  // layout() lags; cleared as soon as stageAuto acts
  stageStrip(show?, id?) // round 4, the Herd panel's Stage strip switch and <mod>.stage[:show|:hide]:
                  // layout.show / layout.hide {id} (true / false; omitted toggles) whoever hid it ->
                  // {ok, id, hidden, msg?} | {ok:false, error}. Refused while checking(), loading,
                  // from a retired host or without a stage; a run() that throws is reported, not
                  // recorded. The stage is the person's then: holdStage(false) clears
                  // cfg.collapsed and hidStage, and a running countdown is called off (idleSince,
                  // cfg.idleAt); showing one the collapse had hidden says it hides again a minute
                  // after work next stops
  hotkey(name)    // sheet / herd / calm / stage / stage:show / stage:hide, once per window (claim)
  viewError(kind) // a view builder that threw: main.js shows the error chip (the party falls back
                  // to a plain list of herdr's agents()) instead of an endless "loading".
  view(kind, args) // memoised per world version: at most MEMO_MAX (64) view models; when full the
                  // oldest go first, pane headers and dialogs before stage, party and HUD (which
                  // the next pump prewarms), so a frame of many pane headers never empties the memo.
}
// save path: `${appHome()}/data/down-the-stack/save.json` (writeTextFile creates parent dirs; data/ is
// not watched). herdr keeps the copies' localStorage files (store*.json) in the same folder.
```

**Notifications (D§11.15).** Each pump takes the milestones the world raised
(`world.takeMilestones`: it empties `herd.milestones` and drops any older than 10 minutes) into the
host's outbox and asks for a save at once. `writeSave` hands the outbox entries of its world to that
save (they are already out of its text) and posts them with `notify()` only once that `save.json`
write landed:
- a restart, a hot reload or another window loads a world in which they are taken, so nothing is
  posted twice; a write that fails as a plain IO error keeps them for the next save, and one that
  loses to another writer drops them (that window posts its own, or, when it wrote this very text,
  holds them taken: `conflict()` answers `"same"`); a write that never settles (its copy closed)
  posts nothing: at most once, never twice;
- the one way a milestone is posted twice is a rollback of the save: a cold restart that finds
  `save.json` garbage loads `save.bak`, which may predate the save that took it (D§13.1). Two
  windows on one save plus another program deleting or garbling `save.json` within seconds of a kill
  can also repeat one (the `conflict()` paths load the other window's world, which lacks the kill).
  herdr 0.1.17 runs one window per app home (`main.rs` `raise_running`, `control.rs` "One Herdr per
  home"), so two windows on one save arise only from two homes sharing `data/`, or from an old
  VM's `close()` racing a VM restart (`window.rs` `restart_mods`). A hot reload never rolls back (§2.3);
- a retired host (a hot reload took over) never posts; nothing happens while `checking()` (the host
  has no IO then, and `post` checks `checking()` again), for a read-only world, or for a milestone
  older than 10 minutes; `postedKeys` is a last guard against a repeat;
- the payload is `{title, body, level: "success", action: {name: "mod.open", args: {name: MOD}}}`
  with no `icon` (a mask icon would be invisible on one theme or the other) and no sound. herdr's
  toast mod runs the action when clicked, then closes (`defaults/mods/toast/main.js`). `mod.open` is
  an app command (`commands.rs`, `window.rs:3690-3702`): it opens the overlay `mod.json` describes,
  the Herd panel on its Digest tab (`{"kind":"dialog","width":760,"height":520,"props":{"role":"herd",
  "tab":"digest"}}`), in whatever layout the window shows; `<mod>.herd` would reach shown copies
  only and fail with a toast elsewhere. `mod.open` toggles its overlay (id `mod-<mod>`), so a toast
  posted while a Herd panel is open carries no action.

**Collapse the stage (D§11.15).** `stageAuto` runs after every pump and when the setting changes.
It finds the layout node whose content is this mod's `{role: "stage"}` (any id) and acts on
transitions only:
- something quested (a crashed hero, between respawns, counts as questing) or supervised and now
  nothing does: after 60 s of that it runs `layout.hide {id}` (unless the stage is already hidden)
  and records that it holds the stage hidden;
- a hero quests or supervises again (or the setting is turned off) while it holds the stage:
  `layout.show`;
- turning the setting on (here, or in a save another window wrote) while nothing works collapses
  at once.

The countdown's start is saved as `herd.cfg.idleAt` (encoded `idle`, present only while set),
written only when this host's countdown changes, so two windows never overwrite each other's value.
A hot reload hands the countdown over (§2.3); a restart inside the minute goes on with the saved
start, but gives the new session at least 10 s of its own idling (`RESUME_IDLE_MS`: herdr may not
have reported the agents' work yet). A start or reload while nothing works and no countdown is
saved never collapses: it is not a transition.

herdr's `layout.toggle` / `.show` / `.hide` set the node's `hidden` (`window.rs:3646-3654`) and
`save()` keeps it in the layout's click state across restarts (`layouts/.state/<layout>.json`,
`window.rs:1236-1256`; `layout_sync.rs` re-applies it unless the layout file's own field changed).
So the host keeps two notes: `herd.cfg.collapsed` (saved, so after a restart it still knows the
hidden stage is its own and shows it at the first work) and `hidStage`, this window's own, which
starts from `cfg.collapsed` at the first `stageAuto` and is never changed by a save another window
wrote (a conflict reload). A stage the person shows by hand clears both (it is not re-hidden until
the next stop of work), and one they hide by hand is never shown by the host. A `layout.hide` that
`run` refuses is not recorded as held. `layout()` is read only while something is due or held;
never while `checking()`, never for a read-only world, and nothing happens in a layout without this
mod's stage block. A stage hidden without the host's note (a `.state` file left from an earlier
install, a lost save) stays hidden as far as the collapse goes; the person shows it with the Herd
panel's Stage strip switch (`stageStrip`, owner decision round 4, docs/DECISIONS.md),
`ctrl-shift-g` with the keys merged, or `herdr-app do layout.show --id stage`. A stage shown or
hidden with the switch is the person's like one toggled by hand: the collapse never shows one hidden
with it, and showing one calls off a running countdown.

```js
// main.js (sketch; the integration owner finalises it)
import { View, div } from "gpui-kit";
import { props, checking, nextCommand } from "herdr";
import { getHost } from "./host.js";
import Stage from "./ui/stage.js"; import Party from "./ui/party.js"; /* ... */
const ROLES = { stage: Stage, party: Party, nameplate: Nameplate, hud: Hud, sheet: Sheet, herd: HerdPanel };

export default class DownTheStack extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    this.host = getHost(); this.host.ensure(cx);
    const R = ROLES[pr.role]; this.role = R ? new R() : null; this.role?.init?.(pr, cx, this.host);
    if (checking()) return;
    cx.timer.every(1000, (cx) => { if (this.host.pump(Date.now())) {/* broadcast already sent */}
                                   else if (this.seen !== this.host.version && this.host.staleFor(Date.now()) > 1500) cx.notify(); });
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); this.onCommand(c, cx); cx.notify(); } });
  }
  onCommand(c, cx) { if (c === "tick") return; /* UI commands: if (this.host.claim(c)) this.role?.command?.(c, cx) */ }
  render(cx) { this.seen = this.host.version; if (!this.role) return div().child("Down the Stack"); return this.role.render(cx); }
  async close(cx) { this.role?.close?.(cx); /* if last copy: await this.host.flush() */ }
}
```

Role objects are plain classes (`init(props, cx, host)`, `render(cx)`, optional `command(name,cx)`,
`close(cx)`), like the shipped win98 mod (`patterns.md` §3).

**UI role contract (decided before the UI build).** Each `ui/<role>.js` exports a default class as
above plus a pure `render<Role>(vm, env)` with `env = { width, height, zoom, theme: T(), host, act }`,
where `act(name, args) === host.command(name, args)`. A role gets its view model with
`host.view(kind, args)` (`kind` ∈ `stage|party|nameplate|hud|sheet|herd`; `args` = the second
parameter of the matching §5 function); it returns `null` while the world loads. Herdr chrome
commands (focus, overlays, toggles) are called with `run()`/`openOverlay()`/`closeOverlay()` from
handlers, never during render. Sample view models live in `tools/vm-samples/<role>.mjs`
(`export const scenarios`) and are both the preview fixtures and the spec `view.js` must match;
fields a renderer adds beyond §5 are documented in a JSDoc "VM additions" block at the top of its
module. A role reads only
`host.world`-derived view models via `game/view.js` and herdr live data it needs for chrome
(e.g. the nameplate reads `panes()` for the real terminal title).

Key commands (the repository's `keys.json`, section `layout:Down-the-Stack`, optional; herdr's
install flow merges it into the person's `keys.json`): `down-the-stack.sheet` (focused agent's
hero), `down-the-stack.herd`, `down-the-stack.calm`, plus `layout.toggle:stage`. main.js also
handles `down-the-stack.stage`, `.stage:show` and `.stage:hide` (round 4: the Stage strip switch as
a command, `host.stageStrip`; herdr's `run_as` hands the mod `"stage:show"` for a
`down-the-stack.stage:show` key, `window.rs:3088-3112`), bound to no key: `ctrl-shift-g` stays
`layout.toggle:stage`, which works even with no copy of the mod shown. HOTKEYS is read as own
properties only, so a command named like an `Object.prototype` member reaches the role.
`<mod>.<command>` reaches shown copies only, so these work only while this layout shows (keys in a
`layout:` section apply only there anyway). `mod.json`'s one palette entry, "Down the Stack: Herd
panel", runs the app command `mod.open {"name": "down-the-stack"}` instead, which works in any
layout: it opens `mod.json`'s `"overlay"` (the Herd panel on its Digest tab) and closes it when run
again (herdr's palette lists every mod's entries in every layout, and a `<mod>.<command>` entry
picked elsewhere failed with a "down-the-stack.sheet failed" toast). The character sheet and calm
mode have no palette entry: two `mod.open` entries for one mod would be duplicates (`palette/main.js`
`entryId` drops them); they stay on the keys, the Herd panel's Roster and Settings tabs, and
clicks. There is no "switch to layout" entry: herdr's palette already builds `Layout:
Down-the-Stack` and drops duplicates.
herdr shows ids, not our title. These places show the layout file name ("Down-the-Stack") or the
mod folder name ("down-the-stack"), so both are named after the game; the game's own UI shows
neither id (D§1).
- Settings layout picker: `LOOKS[name] ?? name` (herdr `defaults/frame/settings/main.js:316`); its
  card picture is the layout's `"preview"` path, loaded, never printed. Settings prints no mod
  folder name in 0.1.17.
- Palette: `Layout: ${Cap(name)}` (`defaults/frame/palette/main.js:156`). A mod entry shows its
  `title` and `group`; the folder name is only in its search words (`:137`).
- macOS View > Layout menu (`src/macos.rs:66-69`).
- win98 Start menu (`defaults/mods/win98/taskbar.js:209-210`).
- Keys overlay: `keys  (layout:Down-the-Stack)` | `down-the-stack sheet` (`label()` turns `.` and
  `_` into spaces and keeps `-`; `defaults/mods/help/main.js:17-22,83`).
- Failed-command toast: `down-the-stack.sheet failed` (`src/window.rs:3076-3078`).
- A copy that fails to load: `down-the-stack did not load: …` (`src/window.rs:1874,4795`,
  `src/window/floats.rs:147`).

The folder name `down-the-stack` is valid everywhere herdr reads one (checked in the 0.1.17
source; `test/layout.test.mjs` "the mod folder name"):
- `mods.rs:219-221` `valid_name` (used by `mod.clone` / `layout.clone`): letters, digits, `-`, `_`.
  Mod discovery (`mods.rs:394-434`) takes any folder name.
- `<mod>.<command>` is split at the first `.` everywhere: `run()` (`window.rs:3088-3110`: a `:`
  shorthand first, then `split_once('.')` → `mods::send_command`), keys (`keys.rs:152-165`
  `gone_mod` / `valid_action`), the palette (`palette/main.js:131-132`). A `-` in the mod part is
  plain text to all of them; a `.` or `:` would not be.
- `keys.json` sections: `layout:<name>` and `mod:<name>` become GPUI key contexts built with
  `KeyContext::set`, never parsed (`window.rs:170-177`), so `-` needs no escaping (the layout
  section `layout:Down-the-Stack` already relies on it).
- Lower case, like herdr's own hyphenated folders (`machine-add`, `terminals-bar`,
  `workspace-chrome`).

Overlays: `openOverlay({mod:"down-the-stack", kind:"dialog", width:760, height:500, props:{role:"sheet", heroId}})`
and `{role:"herd"}` (dialog, 760×520), opened through `host.openSheet` / `openHerd` (one dialog of
each kind; `ui/party.js` and `ui/stage.js` open their own only when no host is given). The
Herd panel also opens from `mod.json`'s `"overlay"` (`{role:"herd", tab:"digest"}`) through the app
command `mod.open` (a notification's click), as overlay `mod-down-the-stack`. herdr puts the
overlay id in every overlay's props (`window.rs` `open_overlay`), so dialogs close on Esc / click
outside and the mod closes them with `closeOverlay(props().overlay)` however they were opened.
The host's dialog registry (`overlays.sheet`) keeps the open sheet's `heroId`, `address` and `name`.
herdr never changes an overlay's props, so a sheet copy reports what it shows on each render
(`host.followSheet(overlay, {heroId, address, name})`, round 4b: a promoted Contractor's sheet
follows it to its roster id), and `openSheet` keeps the dialog when `sheetShows(cur, heroId)`: the
same id, or a Contractor's sheet whose terminal is now bound to that roster hero of the same name
(a click that lands before the sheet redrew).

---

## 5. View models (`game/view.js`) — the only thing renderers read

All positions are logical px at zoom 1 relative to the role's own root. All colors are hex.
Every list item has a stable string `key` (used as `.id()`).

```js
export function stageView(world, { width, height, nowMs }) -> StageVM
StageVM = {
  tick, width, height, calm, nums, stillness:boolean,          // stillness: nothing questing anywhere
  empty: null | { kind: "no_agents"|"loading", title, text },
  headerNote: null | { key, text, short?:[string], color, tooltip, heroId },  // notes (D§11.15); round 4b, 4c below
  herdBanner: null | { key, text },                            // herd-first boss kill (D§11.8)
  rooms: [{ key, x, w, zone, mapId, title, shortTitle, palette:{sky,far,ground,accent},
            skyBands:[hex×4], quota:null|{have,need}, sprint:null|{have,need}, door:boolean,
            working:boolean, dusk:boolean, review:boolean, dividerLeft:boolean,
            props:[{key, sprite, x, y, w, h}] }],
  heroes: [HeroVM], mobs: [MobVM], chests: [ChestVM], boss: null|BossVM, fx: [FxVM],
  overflow: null | { key, x, w, count, dots:[hex], tooltip }
}
HeroVM = { key, heroId, address, x, y /*feet*/, scale, name, level, careerTitle, clsId, face,
           state, focused, pinned, attacking, opacity, hpFrac, xpFrac, feFrac,
           colors:{hoodie, titleBar, screen, faceInk}, programIcon:null|{path, tint, color},
           weapon:{clsId, color}, hat:null|{tier, color}, accessory: clsId,
           bubble:null|{label}, zzz:boolean, campfire:null|{x,y}, crate:boolean,
           tag:null|{text, color}, forklings:[{key, address, x, y, face, status, bubble:boolean}],
           forklingExtra:int, tooltip, nameplate:{x, y, w, text, hpFrac} }
MobVM  = { key, mobId, name, x, y /*feet*/, size, px, sprite, glyph:null|string, glyphColor,
           elite, holo, hpFrac, showHp, engaged, pacing:boolean, paceAmp, opacity, phaser,
           pending, growScale, dying:boolean }
ChestVM= { key, heroId, x, y, tier, count, open:boolean, tooltip }
BossVM = { key, bossId, name, x, y, w, h, sprite, hpFrac, segments:int, mechText, phaseLabel,
           timerFrac, enraged, invuln, parts:[{key, label, hpFrac, x, y, active}],
           banner:null|{key, text, sub, age}, stamp:null|{key, text, age}, arena:{x, w} }
FxVM   = { key, kind, x, y, text, color, age /*0 = born this tick, 1 = previous tick*/,
           dx, dy, size }     // kinds: num crit heal miss inv abs incoming poof coin loot levelup
                              //        skill coffee unblocked stamp pillar ship
export function partyView(world, { width, nowMs }) -> PartyVM
PartyVM = { compact:boolean, title, count, version, calm,
            groups:[{ key, name, offDuty:boolean, rows:[RowVM] }],
            footer:{ gold, snippets, release, sprint:null|{label, have, need}, digestDot },
            agentOrder:[address...] }
RowVM  = { key, heroId, address, name, level, careerTitle, clsName, mapLabel, status, stripe,
           face, programIcon, focused, pinned, hpFrac, xpFrac, feFrac,
           chips:[{key, kind, text, color}], tooltip, chestPending:boolean }
export function nameplateView(world, { terminal, pane }) -> null | PlateVM
PlateVM= { heroId, name, level, careerTitle, clsName, programIcon, hpFrac, xpFrac, feFrac,
           chip:{text, color}, tooltip, contractor:boolean }
export function hudView(world, { nowMs }) -> HudVM
HudVM  = { gold, snippets, release, sprint, working:int, blocked:int, shipped:int, needYou:int, digestDot }
export function sheetView(world, { heroId, tab, filter }) -> SheetVM   // D§11.13 (tabs gear/skills/stats/career/journal)
export function herdView(world, { tab, filter }) -> HerdVM                    // D§11.14 (upgrades/stash/tracker/bosses/roster/digest/settings)
```

Contract additions recorded during the build (the "VM additions" JSDoc of each `ui/` module and the
SheetVM / HerdVM typedefs in `ui/sheet.js` / `ui/herdpanel.js` are the full list):
- every view also takes optional `nowMs` and `tzOffsetMin` in its args (else `rt.nowMs` /
  `rt.tzOffsetMin`);
- `StageVM.signs: [{key, x, text}]` (a fight's participants' home slots; adjacent ones in one room
  share one sign), `rooms[].stats`, `BossVM.partSprite` / `tooltip` / `stamp.sprite`;
- `RowVM.slim` (crowded parties), the fork chip's `terminal`;
- `StashFilter.hover` / `selected` (the sheet's hovered or selected item falls back when it vanishes);
- `RosterVM.slim`, `RosterVM.emptyText` (no hero yet), `fame.more`, `backlog.challenge` (Herd panel);
- every view's args may carry `save` (host.saveStatus(), §4) for the stage, party, hud and herd;
  `PartyVM.save` / `HudVM.save: null | {title, short, tooltip}` (`chrome.saveCue`; part of their
  memo keys);
- SettingRowVM `wide` (the control on its own line: the six rarities), `inactive` + `tooltip` (an
  autopilot system while the master switch is off), and an option's `color` (a rarity's);
- `HerdVM.save: null | {title, text, tooltip}` (the save band, D§13.4) and
  `HerdVM.header.waiting` (the blocked part of `header.sub`, drawn in the blocked colour);
- SheetVM header `tagTip` / `tagTab` (the "provisional" tag explains itself and opens Career), the
  Career class option `lock` (the current provisional class's chip locks it, free), and the
  Career boss card's `challenge`, which is Retreat while its zone boss fight runs or is paused,
  and `fighting` (that fight is on: the card leads the Career tab, above the ladder, so its Retreat
  is in view at 760 × 500; the card's button sits in its title row, with the win estimate beside
  it outside a fight and beside the status during one); a running review's `statusText` reads
  "81% left against <opponent>" (the number survives the cut);
- `PlateVM.chip.short` ("!" / "! 2m": the chip below 200 px); the plate and row show BOSS /
  REVIEW only while the participant is questing or supervising (D§9.5: blocked ones hold,
  done / idle ones walk out). The stage agrees: its arena draws only participants that are
  questing, supervising, crashed or blocked (holding); a done or idle one is at home (or in the
  camp chip) with its chest or campfire (the engine gives combat ticks only to questing,
  supervising or crashed heroes, `combat.js isActive`);
- `StageVM.rooms[].pin` (header click: pinMap) and `rooms[].challenge` (the boss door, only when
  the engine would accept it), `HeroVM.reviewEnd` (Promotion banner / Postmortem card, 3 ticks),
  `BossVM.retreat` (two-click confirm), `FxVM.sheet` (loot pillar opens the sheet on the item),
  ChestVM tier `"duck"` (a Duck Chest at a Holo Rubber Duck kill; never claimable),
  `MobVM.lane` (0 = the front of its lane, a boss's first add; a crowded stage keeps the front);
- clicks that show a terminal (stage hero, bubble, chest, Forkling; party rows and fork chips;
  the sheet's Focus) use `ui/party.js showTerminal`: `pane.focus {terminal}` when `panes()` lists
  it, else `terminal.peek {terminal}`. `agent.focus` shows nothing in this layout (it has no
  agent block, `window.rs:1489-1495`), and `pane.focus` on a pane-less terminal toasts "no such
  pane".
- `RowVM.stripe` stays the D§11.1 design colour (the view knows no theme); the renderers draw a
  status mark (row stripe, folded group dot, HUD count dot) with `ui/party.js stripeColor`, the
  step for the chrome it sits on (D§11.1 as built);
- a terminal's work is named in tooltips by `chrome.js taskLabel(live)` (the party, pane header,
  the stage's hero tooltip while a task is open, the sheet's quest line and Bind tooltips): the
  live title, else the task's last title, else a pane or tab name the person gave, each judged by
  `agents.js tellingTitle` (herdr's agents-list test, plus herdr's shell and interpreter names;
  re-exported by `chrome.js`), cut to 40 characters as the Quest name is (D§2.3); "" when none
  tells anything (D§11.11 as built). The engine keeps only telling titles as `live.task.title`
  (glyph stripped, 40 characters, judged again only when the terminal is retitled), so a chest
  records the task's real name; Forkling and chest titles from older saves go through
  `tellingTitle` where they are shown. `tellingTitle` remembers its answers (a bounded map keyed by
  title, terminal, program and app): its regexes cost ~20 µs a call in QuickJS, ~2.5 µs from the map.
- round 3: `StageVM.rooms[].pin.pinned` (every hero in the room is pinned: the header draws a
  cream pin before its title, 2 elements that go with the stats on bare rooms, detail level 10 and
  up; its tooltip reads "Pinned: … click to unpin"); a pinned hero's tooltip names the header click
  only when its whole room is pinned (`roomGroups(L)` sets `ctx.headerUnpins`), else "Auto on the
  Career tab's Map card unpins"; (round 4: `RowVM.mapPin` replaces the "(pinned)" suffix, below);
- round 3: `PartyVM.groups[].chests` (the folded "Off duty" group's pending chests: a chip "×n";
  older VMs fall back to counting `chestPending` rows); the footer's and `HudVM.digestDot` also
  light while an off-duty chest is within 4 h of opening Unreviewed (`herd.digestDot`); off-duty
  row tooltips say when its chest opens Unreviewed;
- round 3: `chrome.whyLine(why, {shift, level})`: with the hero's level, a part
  "1-1 is 31 levels below: ×0.03" (`gapPart` / `gapText`) whenever the level gap is below ×1 (never
  in the Backlog); the sheet's XP breakdown carries it as part key `gap`. `Why.gap` (agents.whyOf)
  is the gap as combat applies it;
- round 3: the Herd panel's env carries `chrome: {hud, hudId, stage: null|{id, hidden}}`
  (`ui/herdpanel.js chromeNodes()`: the HUD and stage blocks found by content, this mod and role,
  as host.js `stageNode` does; the Stage height row is disabled when the layout has no stage, and a
  hidden stage is still resized), and a `bossScroll` ScrollHandle: the Bosses tab's fighting row
  is revealed with `scroll_to_item` once per fight and per visit (rows are direct children of the
  scroll area);
- round 3: the autopilot rows' hints read their thresholds from `T.boss.autoAt` / `farmAt`; the
  "career" switch is labelled "Promotion reviews" (Senior and Staff Reviews at ≥ 90 %); the skills
  tab's `autoLearn.hint`, the skill-point tooltip, the respec tooltip and the party's unspent-points
  star follow `autoOn(state, "learn")` as well as the hero's own switch;
- round 3: the digest has an "Opened Unreviewed" section (`herd.digest().unreviewed`, from the
  journal kind `unrev`) and the journal line "Chest opened Unreviewed: “…” (half value, no Seals)";
- round 3: `taskLabel` cuts with `cutText` (never half an emoji), and so does every engine cut of
  outside text; the mock and `npm run qjs` refuse a lone surrogate in any text, as herdr does.
- round 4 (stage): `MobVM.heroId` (the hero whose lane it is; null for a boss fight's adds); each
  lane or review mob is kept inside its own slot (`inSlot`: its drawn body, ×1.25 when elite, plus
  its pacing swing), stepping left instead of spilling into the next slot. The camp chip's tooltip
  lists at most 12 heroes (waiting, then "· chest waiting", working, resting) and sums up the rest
  ("…and 18 more (3 with a chest, 15 working)"); its dots follow that order;
- round 4 (party): `RowVM.waitingForks: [{key, address, name /*"<hero>'s sub-agent"*/, tooltip}]`
  (`chrome.js waitingForksOf`: blocked sub-agents, with a pane or not): "N need you" lists blocked
  rows, then these (`ui/party.js waitingList`), a group shows `!` for one, and the rail badge shows
  for one, with its own click (`showTerminal`, `stop_propagation`). The chip remembers what it
  showed last (`ui.needYou {key, focus}`), since a peek leaves the focus where it was. Older VMs
  without the field behave as before. `RowVM.mapPin: null | {tooltip}` (`mapPinMark`: a hollow-head
  pin beside the level; `slimFit` reserves its 14 px); `mapLabel` no longer ends "(pinned)";
- round 4 (Herd dot): `PartyVM.footer.digestDot` / `HudVM.digestDot` also light while chests opened
  Unreviewed since the Digest was last viewed (`herd.digestDot`, `chrome.unseenUnreviewed`), and
  `footer.digestTip` / `HudVM.digestTip` say why on the Herd button's tooltip;
- round 4 (Contractors): `chrome.hireLine(world, hero)` (`agents.hireOutlook(...).text`) ends the
  party row, pane header and stage hero tooltips of a Contractor ("Hired at the next 04:00 game day
  (today: 0 of 6 hires left)");
- round 4 (nameplate): `TIERS = {bars: 420, fullBars: 480, name: 360, micro: 200}`, `BAR_PX = {full:
  {hp: 48, xp: 64}, compact: {hp: 28, xp: 36}}`; `plan()` returns `compact`, and `ui.bars` is
  `false | "full" | "compact"` (24 px hysteresis, recorded only once the header width is measured).
  Full bars need the whole title to fit (as round 3); compact ones show from 420 px with the title
  kept ≥ 40 px (estimated, counting the centre spacer's 8 px gap), the chip in its short form when
  the full one would cost the title, the name shrinking (≥ 48 px; ≥ 40 px hovered, so the four pane
  buttons fit). The title's tooltip holds the whole title at every width;
- round 4 (sheet and Herd panel): `tabs[].tip` (the tab's key and what its badge counts: "Skills · 2
  skill points to spend · key 2"); `SheetVM.note.tooltip` (a Contractor's banner says when it is
  hired, `panels hireOf` over `hireOutlook`: "soon" / "day" (today, tomorrow or a date, at 04:00) /
  "slot" / "never"; the tooltip holds the engine's sentence, what a hire keeps and "Contractors don't
  get equity."); `sheetView` args `address` and `name`: a Contractor's sheet (negative id) follows
  its promotion to the hero bound to that terminal with that name (the VM's heroId is the new id;
  anything else reads "This hero has left the roster."); the header drops a quest that only
  repeats the space it names; journal kind `hired` has its own line; skill tooltips name a data.js
  `cue` only when the stage draws it (`DRAWN_CUES`: works_on_my_machine's "404"), and the ladder
  note says "Capstone passive"; with the master switch off the skills hint reads "Waits: the
  Autopilot is off in Settings";
- round 4 (Roster): `RosterVM.groups[].inline` (spaces holding one hero: one block first, no
  header), `RosterRowVM.space` (that row's space; slim rows draw it in a 118 px first column, 92 px
  below a 720 px dialog, where the name column narrows 170 → 140 too) and `RosterRowVM.hire: null |
  {text, tooltip, color}` (a Contractor's moment, which shrinks before the buttons do); the count
  line ends "· 24 contractors, the next hired tomorrow at 04:00" ("none hired here: this save is
  read-only");
- round 4 (Digest): "Opened Unreviewed" first, each line timed ("half value, no Seals · 06:30");
  `DigestVM.unseen` (`herd.unseenLosses`) and `seen` (an ActionVM for `lossesSeen {}`), which the
  Herd role runs from a 1 s timer made in init, never in render, only while the Digest tab is shown,
  once per unseen count (a refused command is not repeated), cancelled in `close()`;
  `digestDot` / the tab badge read `herd.digestDot`;
- round 4 (Settings): a row `{key: "stage", label: "Stage strip", chrome: {toggle: "stage"}}` right
  before the HUD strip row: on while the stage block is shown (`chromeNodes(host)` prefers
  `host.stageInfo()`, §4, over its own `layout()` walk), a click calls `host.stageStrip(show, id)`
  and flashes its answer (the switch flips only when ok; without that method it runs
  `layout.show` / `layout.hide {id}`), disabled with "This layout has no stage" without one.
- round 4b ("need you", D§11.11): `chrome.needYou(world) -> {n, heroes, subs}` (cached per world
  version: live heroes whose agent is blocked, Contractors too, plus their blocked sub-agents, by
  `chrome.heroWaits(live)` and `chrome.forkWaits(sub)`; `needYouText(n)` is "3 need you" / "1 needs
  you"). The party's `waitingForksOf` and `ui/party.js waitingList` use the same two tests; the
  Herd header's `waiting` reads "N need you"; `HudVM.needYou` is that count (the HUD's `blocked`
  stays heroes only and its tooltip adds "N need you, counting M waiting sub-agents" when sub-agents
  wait). The chip's walk (`ui.needYou = {key, seen}`) keeps every row focus it passed through and
  goes on from its last entry while the focus is one of those (or no row), and the click calls
  `cx.notify()`;
- round 4b (nameplate, D§11.12): the env's `width` is null until herdr reports the header's size
  (`on_size_change` comes after a layout); `plan(vm, W, hovered, title, folder, prevBars,
  {measured})` shows no bars while `measured` is false, and `ui.bars` records only measured plans.
  The chip outranks the bars (they go when it would not fit beside them with the name at 48 px),
  and the hero, title and bars sit in one `flex_1 min_w(0) overflow_hidden` group so it clips before
  the chip; the chip (`np-chip-<pane>`) cuts its own text only when narrower than itself;
- round 4b (header notes, D§11.15): `HeaderNote.tooltip` (the whole text; a merged note's every
  line), `HeaderNote.short` (a merged hire note's head, "Hired 6 contractors": shown whole where the
  names fit nowhere whole, never a list cut mid-way) and `HeaderNote.heroId` (the roster hero it is
  about: the note's engine tag, else the one hero of a hire's name; null: herd-wide). The hires of one tick are one note (`view/stage.js
  headerNote`, remembered per tick of birth in the stage memo, counted from the journal), shown
  while any of its hires' queue slots runs. `ui/stage.js headerNote` places it (over the hero's
  room, at the strip's right end, the left scenery or the roomiest header) and cuts between words
  (`noteText`); `headerFit` is exported for tests;
- round 4b (Roster, D§11.14): `RosterRowVM.contractor` (boolean); a Contractor's `name` carries
  "(contractor)" only when it has no `hire` line (the slim row's tooltip keeps it). Slim rows leave
  out the 52 px Retire column when no row in the list can retire, and put title · where and seen in
  one basis-0 cell so the hire moment stays whole; `panels hireOf` has a `"grace"` case ("hired in
  about N min" / "Hired in ~N min" from `atMs`);
- round 4b (looks): `termlingColors` takes the hoodie from `heroes.lookOf`, and the stage's and the
  sheet's hat colour is `PALETTE.hatTint[hatToneOf(uid)]`.
- round 4c (header notes, D§11.15): `HeaderNote.short` is a list of forms, longest first (the
  engine's `short` tag, else a hire's without the epithet; a merged note's `[head]`), and
  `HeaderNote.heroId` may name a hero with no room on the stage (off duty, at camp, retired).
  `ui/stage.js headerNote` tries the text, then each short form, whole: over the hero's room and the
  scenery beside it, then the strip's ends by the camp (a herd-wide note also the roomiest room
  header; a note about one hero never another hero's); where none fits whole, the shortest is cut
  between words. The tooltip is the whole text whenever what shows differs from it;
- round 4c (space names, D§11.14): `ui/kit.js middleCut(text, {id, tooltip, room, size})` draws a
  name that may not fit its box (estimated at 0.6 em a character) as a head that truncates and a
  tail that stays whole (`splitTail`: the trailing parts after a separator that fit in `o.tail`
  characters, 8 by default, else the last 6; never through a surrogate pair), so a narrow box shows
  "ceo-assi…res-2", with the whole name on hover; a name that surely fits stays one plain box (no
  extra elements). Used by the slim and wide Roster rows' space cell, the Roster's space headers
  (`hd-gt-<key>`, only when the header may not fit the dialog), the party's group headers
  (`pg-<key>-name`) and the sheet's Rebind lines (tail 12: the view's Rebind options carry
  `line: [before the space, the space, after it]`, which join to the tooltip; the part after the
  space gives way first). It splits the view's string for layout only; the text shown is the
  view's.

`sheetView`/`herdView` shapes are owned jointly by the engine-world author and the sheet/herd
UI author; their exact fields are defined in `game/view.js` JSDoc, which is the source of truth.
Every derived string shown to the person (tooltips, the "why" breakdown D§2.9, item names,
compare deltas) is produced in `view.js`, not in `ui/`.

---

## 6. Rendering contract under GPUI (overrides D§11.9's CSS recipe)

### 6.1 Structure of the stage
- Root: `div().id("stage").relative().size_full().overflow_hidden().bg(sky)` with
  `.on_size_change((s, cx) => { this.size = s; cx.notify(); })` (size is window px: divide by
  `settings().zoom`). Before the first size, assume 960×200.
- Children in paint order: rooms (backgrounds: sky bands → far tiles → props → ground), dividers,
  room headers, loot pillars' click targets, chests, campfires, mobs, boss, heroes (+forklings),
  bubbles, nameplates/tags, fx (a pillar's light column, with no handler), banners, overflow chip.
  Every child is `.absolute().left(x).top(y)` inside its parent. A pillar's click (the sheet on its
  item) is a transparent box under everything that takes clicks: its finder, a chest or a `!`
  bubble standing in the light keeps its own click (GPUI dispatches clicks topmost first).
- **Budget** (D§11.9.7, ~400 elements and ~150 animated nodes per render): `ui/stage.js detail()`
  counts both exactly (`termlingCost` in `ui/termling.js` for the rig), keeps 24 of each free for
  the tick's effects and picks the finest of 18 detail levels that fits (392 elements, 146
  animated); effects fill what is left (status floats first). Statuses always render (the last
  three levels merge them into fewer elements); the levels are listed in D§11.9 "as built". A level is held in the role's `ui.detail` until the finer one
  fits with 12 elements to spare. The view caps home slots at 30 (`MAX_SLOTS`, D§11.3 "as built").
- Sky: 4 horizontal bands (`skyBands`) — no gradients in mod elements. Far layer: repeated SVG
  tiles (fixed aspect) across the room, `.opacity(0.5)`; while the room is working, a slow loop
  on `left` (±16 px, period ≈ 20 s) gives the parallax drift; still otherwise.
- Ground: solid ground colour band from y=160 to bottom, 2 px accent top line, tiled ground SVG.

### 6.2 Motion recipes (all native)
`x`, `y` and amplitudes are script px (zoom 1). Loop `from`/`to` are written as raw px (gpui-shell
`materialize.rs:3100-3106`), so both ends are multiplied by `zoom` (§2.10). Static `.left()`/`.top()`
values are zoom-scaled by herdr (gpui-shell `value.rs:25-27`), and so are the transitions between
them, which animate the scaled value (`materialize.rs:3183-3197`).

| Effect | Recipe |
|---|---|
| Idle bob | `.loop("top", {from: y*zoom, to: (y - 2)*zoom, period: 1200 + jitter})` on the hero's sprite wrapper (not when calm/reduced/stillness) |
| Fighting | hero: `.loop("left", {from: x*zoom, to: (x + 6)*zoom, period: 1000})` while `attacking` (reads as lunges on the 1 Hz beat); engaged mob: opposite small loop |
| Mob pace | `.loop("left", {from: (x - paceAmp)*zoom, to: (x + paceAmp)*zoom, period: 3200 + jitter})` when `pacing` |
| Movement | positions change between ticks → `.transition("left", {duration: 900, easing: "ease-out"})` with a stable `.id(key)` |
| Damage number | `age 0`: render at (x, y), `.opacity(1)`; `age 1`: same `.id`, (x+dx, y−28), `.opacity(0)`, `.transition("top", 900)`, `.transition("opacity", 900)`; dropped at age 2 |
| Poof / coin / loot | same two-tick pattern (coin/loot: age 1 moves to the hero and fades) |
| Level-up column | cyan div, `age 0..1`, `.loop("opacity", {from:0.3, to:0.9, period: 1600})` (one pulse over its 1.6 s: a period is a whole there-and-back, `materialize.rs:3092`, and nothing flashes faster than 1 Hz); it starts at y ≥ 18 (below the header band on short stages) and its label at y ≥ 20 |
| Loot pillar | 48 px column in the rarity colour, no handler (its click is a transparent box under the heroes); the rarity name sits on a nearly opaque dark plate painted after every other effect, so a damage number never covers it |
| Blocked bubble | `.loop("top", {…3 px…, period: 1400})`; clickable `div` wrapper → `showTerminal(address)` (`ui/party.js`: `pane.focus {terminal}` with a pane, else `terminal.peek`; D§2.7) |
| Face | `.frames([">_", "> "], 530)` while questing (blinking cursor); static glyph otherwise |
| Campfire | SVG + flame glyph `.frames(["^", "*", "^", "~"], 200)`… or opacity loop on a glow div |
| zzz | `.frames(["z", "zz", "zzz", ""], 700)` |
| Boss entrance / stamp / banner | multi-tick: VM supplies `age`; renderer maps age→static target values with transitions |

No element may change size every tick (to avoid layout churn); widths only change when slots reflow.

### 6.3 The Termling rig (ui/termling.js)
Built from divs (no image needed): 40×48 at scale 1.
- Body: rounded rect (r 6) in `colors.hoodie`, 2 px darker outline.
- Title bar: 8 px tall strip in `colors.titleBar` with three 2 px dots and, if available, the
  8 px program icon (`svg(icon).text_color(color)` when `tint`, else `image(icon)`).
- Screen: inset rect in `colors.screen` with the face text (`JetBrains Mono`, 11 px, bold) in
  `colors.faceInk`.
- Legs: two 4×5 px stubs; arms: two 3×8 px stubs.
- Weapon: `svg("mods/down-the-stack/art/gear/weapon-<clsId>.svg")` tinted by `weapon.color`, held at the
  right side. Hat: `svg(".../gear/hat-<tier>.svg")` tinted. Accessory: class-specific
  `image(".../gear/acc-<clsId>.svg")`.
- Forkling: 20×24 version, no gear.
- Crashed: face `:(`, body opacity 0.6. Waiting: sits on `art/fx/crate.svg`, face `o_o`.
- Crowded stages (§6.1 budget): `lean` drops the title-bar dots and pin banner; `small` keeps
  the body, title bar, screen and weapon; `tiny` is one element, the screen framed by a
  hoodie-coloured border whose 8 px top edge reads as the title bar, the face inside (a Forkling
  likewise). Same body box, so bubbles, plates and lunges line up at every level.

---

## 7. Tooling and test contract

### 7.1 `tools/mock/` (Node ESM loader hooks)
`node --import ./tools/mock/register.mjs <script>` resolves bare `gpui-kit`, `gpui-base`,
`gpui`, `herdr` to mocks. Requirements:
- Element builder: every method call is checked against `tools/api-allowlist.json`
  (`element_methods`); unknown → throw `TypeError` like herdr. Parametric argument checks:
  colors must be hex strings; lengths numbers or "Npx"/"N%"/"Nrem"/"auto" where allowed;
  `.id()` string; `.child(null|undefined)` throws, `.child(false)` warns as an error in strict mode;
  reuse of one element under two parents throws; `.loop/.transition/.frames/.spin` policy
  validation (period ≥ 100, frames ms ≥ 16, spin only on svg, property in the MotionProperty set);
  `image()`/`svg()` without both `.w()` and `.h()` → error; image path must exist under the
  configured app home (map `mods/down-the-stack/...` to the repo) → error if missing.
- Records a serialisable tree `{type, methods:[[name,args]], children}` for the preview renderer.
- `herdr` mock: every export in herdr.d.ts; data from a fixture (`setFixture({agents, panes,
  terminals, spaces, focused, theme, settings, window, props})`); `run()` validates command names
  (app commands from herdr's docs/commands.md list + `down-the-stack.*`) and records calls;
  `layout.toggle` / `.show` / `.hide` / `.resize` act on the fixture's layout copy-on-write (and hide
  or show the copies of that mod block), failing with a toast for a node the layout lacks;
  `notify()` records its payload, validates its action and reports a call while `checking()`;
  `checking()` controllable; `readTextFile`/`writeTextFile` against an in-memory FS; a fixture's
  `runError(name, args)` hook makes a `run()` throw (a refused `layout.hide`). `exec` records its
  calls, rejects a non-positive timeout as herdr's `exec_limit` does, and runs `ls` and `rm` on the
  in-memory FS (a fixture's `exec` replaces them; throwing makes it reject). The mod itself runs no
  program (round 4: keepAside rotates instead of listing and removing, §4), so a test can assert
  `exec` was never called.
- `tools/mock/gates.mjs` (round 4): `HERDR_SRC` (`$HERDR_SRC`, else a `herdrdev/herdr-app` checkout
  next to the repository, `config.mjs`), `herdrSource()` / `herdrMissing()`, and `skipGate(t, what,
  why)`: a test that cannot run (no herdr source, no Playwright, no QuickJS devDependencies) prints
  one line, `SKIPPED GATE: <what> (<why>); STRICT_GATES=1 makes this a failure`, and skips;
  `STRICT_GATES=1` fails it instead. Every such gate in the tests goes through it.
- Per-VM globals: a mod's registered `Symbol.for("<mod>.…")` slots on `globalThis` resolve per
  mock VM through a Proxy in `globalThis`'s prototype chain (to the VM whose copy's code runs,
  following awaits, else the VM entered last), so two windows' hosts never see each other; they
  are never own properties of `globalThis` (a `delete` of one is therefore a no-op in the mock;
  the mod writes `null` instead).
- The bridge refuses text herdr would refuse: an unpaired UTF-16 surrogate in a text child, an
  `.id()`, a tooltip or any other string argument throws (`validate.mjs checkBridgeable`; herdr
  converts every string with rquickjs's UTF-8 conversion). The `tools/qjs` shim does the same.
- Budgets (render 50 ms, handler / timer / init 500 ms, module evaluation 500 ms) are judged by
  `state.mjs stopwatch()`: the lower of wall time and process CPU time over the call, so a busy
  machine waiting for a CPU never fails a render, while real work still counts
  (`stats.lastRenderWallMs` keeps the wall time). `close()` keeps its wall-clock timeout.
- `cx` mock: `notify` (throws during render), `spawn`, `timer.every/after` (manual clock),
  `focus_handle`, `stop_propagation`, `theme()`.
- `size(w, h)` (round 4b): herdr reports a size only after laying a frame out (gpui-shell
  `materialize.rs` SizeObserver, in prepaint, keyed by the element and the application
  generation), so a root size given before any render drew a root with `on_size_change` is kept
  and delivered right after the next render that does: that frame is drawn without a size, and
  the handler's `cx.notify()` asks for the next.

### 7.2 `tools/check.mjs`
0. Lint: every `.js` file of the mod is scanned for what QuickJS or herdr refuse (§2.14, timers,
   imports from `tools/` or `test/`) and `game/` for purity (§3).
1. Real-check mode: `checking() = true`, `props() = null`, empty lists → construct, `init`,
   one `render` of `main.js`. Must pass.
2. The role matrix of `tools/fixtures.mjs`: the stage on every demo world of `game/demo.js`
   (`DEMO_KINDS`: empty, first-day, mid, boss, late, idle, blocked, calm) and the other roles on
   chosen ones (`party` and its rail, `nameplate` on an agent, a blocked agent, a Contractor, a
   shell, a mod pane and while loading, `hud`, every `sheet` and `herd` tab, the D§11.15
   settings in use, and the save-trouble cues), plus the 30-hero herd (`stress30`: stage, party,
   roster). Each runs at its role's widths (the stage at check's default 360/960/1600, the late
   stage also at 3200, the 30-hero stage at 960/1600/3200) and zooms 1/2: init + render, then
   per zoom and width a resize + render, 3 simulated ticks and a re-render, then close. Must produce zero validator errors, keep render time < 50 ms (the lower of wall and CPU time, §7.1), and keep
   every stage render within 400 elements and 150 animated nodes (§6.1). The `*-emoji-cut` roles
   (stage, party, nameplate, sheet, herd) put an emoji across unit 40 of a title and a pane name
   and across unit 32 of a tab and a space name, and load a save an older build cut through an
   emoji (seats, a journal line): any half emoji reaching herdr fails them.
3. Exit 1 with a precise error list; exit 2 (INCOMPLETE, usage line) on an unknown argument, a
   missing value, bad `--widths` / `--zooms`, or a `--role` that matches nothing.

### 7.3 `tools/preview/`
Converts recorded trees to HTML/CSS (flex, absolute, sizes, colors, text, images, svg masks,
opacity; loops → CSS alternate animations; frames → JS text cycling) and screenshots with
Playwright (`chromium.launch()`, `deviceScaleFactor: 2` for user-facing shots). Produces a full
mock window (sidebar party + stage + nameplates around fake terminals) for `preview.png`, and
per-role shots for review. It is a stand-in for herdr's renderer: good for layout and art
review, not pixel-exact. `flex_grow(n)` and `flex_shrink(n)` keep their number (herdr's
`style.rs` reads one; the no-argument forms are not herdr methods).

### 7.4 Tests (`test/*.test.mjs`, `node --test`)
- formulas: D§5.8 reference table values (±1), K(L)/need table D§6.3, gap(), DR caps.
- items: affix rules (no duplicates, slot pools, value ranges), naming, polish cost example D§8.8,
  IP formula, autopilot equip threshold.
- agents: every transition in D§2.3 (incl. 8-tick close debounce, done→idle seen, seq gaps,
  flap guard, Unblocked conditions, forkling attach, seat binding/rebinding, roster limits).
- combat: kill pace within 14–19 kills/min on-level for each class at L 5/20/40/60/90;
  numbers add up to kills; traits behave (phaser misses, pending 403, splitter halves...).
- boss: each boss mechanic primitive; solo on-level wins in the D§9.5 tick ranges (±25%).
- save: round trip (serialize → load → serialize identical), CRC mismatch → .bak path, migration
  stub, size budget (30 heroes ≤ 30 KB), and every save format this branch has written
  (`test/fixtures/saves`, one text per commit that changed the format) loads with SAVE_VERSION 1.
- world: determinism (same inputs → identical state), offline gap handling, catch-up ≤ 5 ticks,
  clock going backwards.
- view: stage layout stability (status changes never move slots), overflow rules, budgets
  (≤ 400 elements and ≤ 150 animated nodes per stage render, 360–4000 px, 30–60 heroes with or
  without a boss fight, through `main.js` in the mock, and a long day's herd with every slot
  blocked or crashed with chests and sub-agents; every status cue still drawn).
- host: notifications (posted once, after the save that took them, never while checking) and the
  stage collapse (`test/host-notify.test.mjs`, `test/notify.test.mjs`).
- art (`test/art.test.mjs`): the §8 size table, k per family, masks, seamless tiles, the files on
  disk are exactly the generator's output, and every effect sprite is drawn by the mod. It also
  holds README.md and RECIPE.md to the code: the recipe's section order, the install targets, the
  repo paths they name, the herdr functions the mod imports, the commands it runs, the keys of
  `keys.json`, the save files `host.js` writes and RECIPE's count of generated SVGs. Round 4: it
  also checks that no mob in the first two zones is a snail, mushroom, slime or pig (originality).
- layout (`test/layout.test.mjs`): the layout against herdr's shipped `main.json`, and `keys.json`
  read by a port of herdr's `keys.rs` (`parse`, `tab`, `gone_mod`, `valid_action`, object bindings):
  no problem, no dropped binding, every action a real command (herdr's from `src/commands.rs` when
  `HERDR_SRC` has it, else `tools/mock/herdr-commands.md`, cross-checked) or one main.js handles
  (parsed from HOTKEYS); the package name, the two identical MIT licence files, and the NOTICE's
  claims (TITLE_MARK still equals herdr's regex when the source is there).
- end to end (`test/main-e2e.test.mjs`, round 4): main.js and host.js in the mock with live data and
  the real layout, every role on one graph, for the owner's decisions: a Contractor told when it is
  hired and promoted at the 04:00 turn; the Stage strip switch (found by content, disabled without
  a stage); a blocked pane-less sub-agent in "N need you", the group `!` and the rail badge, with
  `terminal.peek`; compact nameplate bars at 420 px with the title's tooltip. Round 4b adds: a
  promoted Contractor keeps its hoodie and hat in the party, pane header and stage, also after a
  restart (R1); restarting an agent on a full roster keeps its hero while Contractors wait, and a
  hero off duty makes room only after 15 minutes (R2); a fresh pane header at 400 / 420 px draws
  no bars before its size arrives and its chip is whole in Chromium (U1); the six hires of the
  04:00 turn are one header note at the right end for 18 s (U3); a Contractor's open sheet
  follows its promotion (U5); the "N need you" walk never repeats (U4). Round 5 adds: 32 agents in
  25 spaces with 26 saved heroes, herdr closed across 04:00 and opened again with a newcomer and two
  Contractors listed first and four three snapshots later: every Contractor comes back as itself
  (name, level, XP, class, hoodie), four are hired at their levels, longest-running first, and the
  newcomer takes none of their hires; and herdr listing every terminal at once with the newcomer
  last: the four hires still go to the Contractors at their levels.
- contractor records (`test/contractors.test.mjs`, round 5): a restart across 04:00 promotes the
  Contractor at its level with its name, class and look; a hot reload keeps its place in line and an
  Intern's signature; two Contractors in one seat; a saved hero of the seat first; a newcomer listed
  before the returning Contractor (also within one listing, and after it within one listing)
  takes none of its hires; a record whose
  agent never returns (the window, then 7 game days); expiry and the cap; a read-only world; bytes per
  record; the `r5-contractors` fixture.
- herdr gates: with `HERDR_SRC` missing, the tests that read herdr's source skip with one line each
  (`gates.mjs`); `STRICT_GATES=1 npm test` makes them fail. `test/fixtures/saves` also holds saves
  written by `a4ea9ab` (the build the owner ran), `c041909` and `d1ffb4f` (round 4b: journal names
  and two promoted heroes; `save.test` checks every fixture's heroes keep their colours), and
  `r5-contractors` (round 5's Contractor records, written by this branch's engine before that round
  was committed).
- wall-clock bounds hold on a busy machine: the engine tests (`test/helpers/perf.mjs within()`)
  and the stage tests apply their strict bounds only with `PERF=1` (else 10×, and the measured time
  is always printed); the chrome and panels tests judge a render the mock flags by its best of 5,
  each at min(wall, CPU), and time their perf checks as the best of several batches. Run `PERF=1
  npm test` on an idle machine for the strict numbers.
`tools/pacing-sim.mjs` reproduces D§12.1 milestones for the four personas within ±15% and the
bot plateau (D§12.2); it is run in CI-like `npm run pacing`. Its exit code is 1 when a milestone or
the bot is off, in `--json` mode too (the JSON carries each verdict and `bad`), and 2 on an unknown
argument. `test/pacing.test.mjs` simulates its whole games in `before()` hooks.

### 7.5 `tools/qjs/` (`npm run qjs`)
The mod in QuickJS-ng (wasm interpreter) with herdr's limits and sandbox prelude; phases and
options in `tools/qjs/README.md`. It splits findings into failures and warnings and prints
`RESULT:`; `results.json` carries `failures` and `warnings`. Exit 1 on a failure: a correctness
problem (a throw, an error chip, a render/view/task/host/shim error, a fuzz failure, a diff
mismatch, a failed reload or load, a save round trip that is not identical, an unmapped role, a
failed phase) or a time past one of herdr's budgets (render 50 ms, callbacks 500 ms, module
evaluation 500 ms). Half a budget and the tick p95 over the ~5 ms target are warnings (exit 0 unless
`--strict`). The reload phase allows each copy main.js's one timer, plus the Herd panel's own
(`ROLE_TIMERS = {herd: 1}`: its Digest `lossesSeen` timer), and `runTimer` fires every repeating
timer of a copy. The shim's `exec` exists for parity; the mod never calls it. Exit 2 on a usage error: an unknown argument or phase, a missing value, a
non-positive `--ticks` / `--seconds` / `--long`.

---

## 8. Art contract (`tools/gen-art.mjs` → `mods/down-the-stack/art/`)

SVG only, no `<text>`, crisp pixel-art style (`shape-rendering="crispEdges"` on rect art),
2 px dark outlines on mobs. Exact viewBox = intended display size at zoom 1 (the sizes below).

`image()` art may carry `width`/`height` = k × viewBox (integer k; the viewBox stays the display
size) so herdr's raster stays sharp. GPUI rasterises an SVG drawn with `image()` once, at 2× its
`width`/`height`, and samples that bitmap (linear filter, one mip) into whatever size it is drawn at
(`gpui-api.md` §3.2). So art that the UI draws larger than its viewBox gets k ≥ its largest
drawn/viewBox ratio:
- k = 2 for `mob/*` (elite × full grower = 2.0), `gear/acc-*` (sheet portrait) and `fx/campfire`;
- k = 2 for `fx/stamp-fixed` (it slams in from 160×56 and shrinks to 80×28 while it fades in);
- k = 3 for `fx/mug` (the Herd panel's building icon draws it at 26 from 12).

A size that a visible `width`/`height` transition passes through counts as a draw. Everything
else, including bosses, backgrounds and `fx/banner`, is drawn at or below its viewBox and keeps
k = 1. A denser raster there would only be minified harder. Masks (`svg()`) are rasterised at the
painted size and are always k = 1. `intrinsicScale()` in `tools/gen-art.mjs` holds the table, and
`test/art.test.mjs` checks it against every `image()` draw in the check role matrix and in the
stage scenarios (`tools/vm-samples/stage.mjs`, plus the stamp's first frame). Every `image()`
call sets both `w` and `h`: the `width`/`height` attributes are also the image's natural size, so
an unsized k = 2 sprite would lay out at twice its size. On a 2× display a sprite softens again
once drawn/viewBox × herdr's zoom exceeds its k (for example, k = 1 art drawn at full size at any
zoom above 1).

| Path | Size | Notes |
|---|---|---|
| `art/mob/<mobId>.svg` | S 28×28, M 40×40, L 56×56 | facing LEFT (heroes are on the left). All 27 mobs + `warning_mite`, `nitpick`, `holo_duck`. Code glyph drawn as paths or omitted (the renderer overlays MobVM.glyph as text when set). |
| `art/boss/<bossId>.svg` | 112×96 | all 9 bosses + `senior_reviewer` (48×56). Hydra heads / Octopus tentacles / Monolith cubes as separate parts: `art/boss/<bossId>-part.svg` (32×32) |
| `art/bg/<zoneId>-far.svg` | 160×100 | far silhouette tile, seamless horizontally |
| `art/bg/<zoneId>-prop-<1..3>.svg` | ≤ 48×64 | mid props (stalactites, pillars, fence posts...) |
| `art/bg/<zoneId>-ground.svg` | 32×40 | ground tile, seamless |
| `art/fx/chest-<tier>.svg`, `chest-<tier>-open.svg` | 28×22 | 4 tiers |
| `art/fx/` | — | `campfire.svg` 24×24, `bubble.svg` 18×20 (white, dark outline, `!` drawn as paths), `crate.svg` 24×16, `coin.svg` 6×6, `loot.svg` 10×10 (mask: tinted by rarity), `poof.svg` 24×24, `starburst.svg` 20×20 (mask), `door.svg` 24×40, `portal.svg` 32×48, `banner.svg` 12×18, `stamp-fixed.svg` 80×28, `mug.svg` 12×12, `stink.svg` 16×12, `ribbon.svg` 40×10, `tent.svg` 16×14 |
| `art/gear/weapon-<clsId>.svg` | 16×16 | MASK (single colour) for `svg()` tinting by tier metal tone; `intern, refactorer, hotfixer, shellmancer, forkbinder, rubberducker` |
| `art/gear/hat-<1..5>.svg` | 24×12 | MASK: beanie, headphones, cap, helm, crown |
| `art/gear/acc-<clsId>.svg` | 16×16 | full colour class accessory (scarf, headlamp, hood tip, book, raincoat collar, lanyard) |
| `art/ui/slot-<weapon|hat|hoodie|mug|boots|sticker>.svg` | 16×16 | MASK icons for the paper doll |
| `art/ui/<name>.svg` | 16×16 | MASK icons: `split-right, split-down, zoom, unzoom, close, sheet, herd, calm, gold, snippet, chest, boss, star, fork, gear, skills, stats, career, journal, lock` |
| `preview.svg` | 320×200 | layout preview |
| `art/fx/chest-duck.svg`, `chest-duck-open.svg` | 28×28 | Duck Chest (D§11.4) |
| `art/gear/weapon-<clsId>-edge.svg` | 16×16 | MASK of the weapon rim; stacked in cyan over tier-5 weapons so the dark metal stays visible |
| `art/bg/backlog-*` | as zones | The Backlog's far/prop/ground set |

Notes from the art build: every mob sprite already draws its code joke, so `MobVM.glyph` is
normally `null` (tooltip text only). Mobs and bosses are bottom-anchored (`top = feetY − h`);
props stand on y = 160. Boss parts: one tentacle (octopus), one key-less head (hydra), one cube
(monolith). `senior_reviewer.svg` serves both reviews. `ribbon.svg` is full colour (gold).

Palette per zone from D§9.2; rarity colours D§8.2; reserved colours D§11.1.

---

## 9. Overrides of the design (decided here)

1. D§11.9 (CSS phase-locked animation) is replaced by section 6 (GPUI loops on a global clock +
   id-keyed transitions + two-tick effects).
2. D§11.5 "hit flash brightness" → the hit mob's `opacity` dips to 0.55 for its age-0 tick.
3. D§11.10 "slot saturate(0.6)" for blocked → a translucent overlay div (`#00000033`) over the
   hero's slot region.
4. D§13.1 "fsync / rename" → herdr's `writeTextFile` (atomic replace) with the expected-text
   discipline; `.bak` kept by the host.
5. Mobs never flip direction while pacing (no mirroring in GPUI); all mobs face left.
6. Reduced motion: herdr exposes no OS reduced-motion flag; Calm mode (D§11.15) covers it and
   additionally disables loops.
7. D§3.4 Contractors are created in memory, not on the roster (until round 5 never saved, as designed); Rebind is in the sheet.
   Round 4 (owner decision "promote only", docs/DECISIONS.md): a live Contractor is promoted to a
   saved hero when hiring reopens (`agents.promoteContractors`, §3.4; D§3.4 as built). Round 5
   (owner decision): each Contractor is saved as a slim record (§3.2 "Contractor records") and comes
   back as itself after a restart.
8. The stage height setting maps to `layout.resize {id, px}` on the layout node whose content is
   this mod's stage (any id, as `host.js stageNode` finds it; disabled in a layout without one).
   Round 4: the Stage strip switch shows and hides that node (`host.stageStrip`, §4), whoever hid
   it.
9. D§5.7 map choice: Power Level is class-biased with the reference kit (Refactorer/Forkbinder
   3–4 below level, Hotfixer 3–6 above), so autopilot picks maps by hero level: the deepest open map
   whose mid level is ≤ L + 1 (by L after a crash in the last 10 minutes; the crash rule still drops
   a map). The earlier "down at most 2 levels when the weapon lags the reference kit" rule is gone
   (docs/BALANCE.md §2: one-agent herds sat a map low for days).
10. `game/view.js` is a barrel over `game/view/{stage,chrome,panels}.js`.
11. Balance deviations from D§14 numbers and D§10.2 (Campfire levels open with the herd's age, boss
    XP, thorns, mob multipliers, loot item level) are listed with their reasons in
    `docs/BALANCE.md`; every changed number carries a `// balance:` comment in `game/data.js`.
12. D§11.15 as built (DESIGN §11.15 notes): notifications count the D§2.9 game day (04:00 local),
    come from live ticks only and are posted after the save that took them; the stage collapses a
    minute after the last hero stops (a restart or reload continues a countdown, an idle start
    never starts one); the autopilot master switch keeps the per-system switches, and every
    automatic re-spend of skill points (auto-learn, respec, a class change) obeys it and the
    herd's auto-learn switch.
13. D§13.1 "`save.broken-<ms>` for later incidents" → round 4: `save.broken-1` to `-3` (and the same
    for `save.unsaved`) after the first incident's `save.broken`, the oldest giving way (§4
    `keepAside`). herdr's mod API cannot list or delete files without `exec`, and the mod runs no
    program, so the bound comes from fixed names.
