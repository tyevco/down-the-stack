# Down the Stack (`mapledr`): architecture and build contract

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
                                file name; the file is named after the game, not the codename
mods/mapledr/                   THE MOD (copied verbatim into ~/.config/herdr-app/mods/mapledr)
  mod.json                      {"place":"none", "palette":[...]}   (place MUST be "none")
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
    view.js                     view-model builders for every role (section 5): pure, testable
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
  preview.svg                   layout preview for herdr Settings
tools/
  api-allowlist.json            every valid element method (from herdr source)
  mock/                         Node mocks of "gpui-kit", "gpui-base", "herdr" + strict validator
  check.mjs                     mock `herdr-app check`, run for EVERY role with fixtures (section 7)
  preview/                      HTML renderer of recorded element trees + Playwright screenshots
  gen-art.mjs                   SVG generator for mods/mapledr/art
  pacing-sim.mjs                headless persona simulator (D§12) using the real engine
  qjs/                          the mod in QuickJS-ng with herdr's limits and sandbox (`npm run qjs`;
                                needs `npm install`, see tools/qjs/README.md)
  reference-sim/                the Python model that produced the design's numbers
test/                           node:test unit tests (`node --test "test/*.test.mjs"`)
docs/                           DESIGN.md, ARCHITECTURE.md, herdr-notes/
README.md, RECIPE.md, preview.png
package.json                    "type": "module"; scripts: test, check, preview, windows, art, pacing,
                                qjs; devDependencies only for tools/qjs
```

Only `layouts/Down-the-Stack.json` and `mods/mapledr/` are installed. Nothing under `mods/mapledr/`
may depend on `tools/` or `test/`. Tests and tools import from `mods/mapledr/` freely.

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
     copies (`quickjs/mod.rs:2348-2352`). The host registers itself, inside `load()` and never at
     top level, at `globalThis[Symbol.for("<mod>.live.v1")]`. The next build's `load()` asks it for
     its world (`handover(fileText)`); it answers only when its last written text is the file just
     read, so the new host continues that world (`loadedFrom: "reload"`) instead of rolling back
     up to 30 s. The old host is retired and never writes again. A new VM has no such host and
     loads the file.
4. **Never keep a `cx`.** Every callback gets its own. No `setTimeout`/`setInterval` (they throw):
   use `cx.timer.every(ms, (cx) => …)` / `cx.timer.after`. Timers drift: always measure time with
   `Date.now()` deltas.
5. **Budgets:** render ≤ 50 ms, event/timer/task callback ≤ 500 ms, **module eval ≤ 500 ms**
   (herdr loads every copy, and `herdr-app check`, inside a Task scope: `plugin.rs:1235-1250`,
   `scope.rs:221-252`, `sandbox.rs:439-441,513-517`; the 5 s `detached` budget never applies to a
   mod load). The mock enforces 500 ms and warns above 150 ms; measured ≈ 60-130 ms. The tick must
   be cheap (≤ ~5 ms for 30 heroes). Never do catch-up loops of thousands of ticks.
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
   `` `${ASSETS}/art/...` `` with `ASSETS = "mods/mapledr"` (one constant, in `ui/kit.js`, so
   `mod.clone` can rewrite it). The mod's own name is spelled only in forms `clone_mod_at`
   rewrites (`mods.rs:247-257`): `"mods/mapledr…"` paths and `mod: "mapledr"` keys. `host.js`
   reads `MOD` from `const SELF = { mod: "mapledr" }`, so a clone broadcasts `<clone>.tick`, opens
   its own dialogs and saves under `data/<clone>/`. `mod.json`'s palette commands
   (`mapledr.sheet` …) are not rewritten by herdr; a clone must edit them by hand (herdr's palette
   drops an entry whose prefix is not the mod's own name). Always set both `.w()` and `.h()`; fit is always "contain"; no
   flip, no tint, no rotation. `svg(path)` is a one-colour mask tinted by `.text_color()` and also
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
    never per tick. We don't use it for game state at all.
13. **localStorage is per (mod, props)**; pane headers and overlays each get their own. Use it
    only for per-copy UI conveniences (e.g. the sheet's last tab), never for game state.
14. **QuickJS compatibility:** ES2020-level JS. Don't use private `#fields`, static blocks,
    `structuredClone`, top-level `await`, JSON imports, `eval`/`new Function`, or extend built-in
    prototypes (they're frozen). Relative ESM imports must include `.js`.
    - Release herdr freezes `Object.prototype` and friends (`sandbox.rs:77-96`). A plain object
      keyed by an outside id (a herdr tab id, a `herdr.tab` label, a program key, a map id from a
      command) breaks on ids like `constructor` or `toString`: writing throws, reading finds a
      builtin. Such maps are `Object.create(null)` (data.js lookup tables, `host.snapshot` tabs) or
      are read through an own-property check (`chrome.js own()`). `npm run qjs -- --only fuzz`
      feeds these ids.
15. **No sound, no OS notifications by default** (D§11.15). `notify()` only for opt-in milestones.

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
          addr, lastPane, lastTab, seenAt, st:{kills, tasks, seals, wh, dodges, healed}, rng }

Herd  = { name, gold, snip, bld:[6], zone, quota:{[mapId]:kills}, meter, bank, seals, rel,
          boss:[9], bossKills:[9], fight:null|SuspendedFight, wounds:{}, lessons:{},
          bt:[9], badges:[...ids], stash:[Item...], fame:[...], backlog:{floor, kills},
          digestAt, cfg:{auto:{equip,deprecate,learn,polish,buildings,maps,boss,farm,calls,career},
          calm, stageH, nums:"all"|"crits"|"off", notify:{boss,lts,principal}},
          log:[[at, kind, heroId, text, value]...≤60], nextUid, nextHeroId, rng, day, lastMs, tick }

world.state = { v, gen, herd: Herd, heroes: [Hero...] }

world.rt = {                // rebuilt from snapshots; never saved
  tick, nowMs, version,     // version++ whenever anything visible changed this tick
  bind: Map<address, heroId>, live: Map<heroId, Live>, contractors: Map<address, Hero>,
  rooms: Room[], fights: Fight[], fx: Fx[], notes: Note[], banner: null|Banner,
  dirty, majorAt, lastSaveMs, errors: []
}

Live = {                    // per bound, live hero
  address, status, seq, statusSince, state: "questing"|"waiting"|"shipped"|"resting"|"supervising"|"crashed",
  focused, pinned, program, app, title, space, spaceName, tab, tabName, pane, paneName,
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

Fields added during the build (all saved ones have defaults on load in `save.js`):
`herd.born` (the herd's first local day; `herd.herdAgeDays`, the Campfire gate), `herd.inbox` (chest
items waiting to be offered, one per tick), `herd.digestSnap` and `herd.drops` (the D§10.7 digest
baseline), `Mob.hitCt` (combat clock of the first landed hit: the swing timer starts there),
`live.tally` (per-hero counters incl. `chestXp`, `bossXp`, `reviewXp`) and `rt.tzOffsetMin` (the last
snapshot's time zone, for the views' dates). Why each exists: `docs/BALANCE.md`.

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

// heroes.js
export function newHero(state, {seat, sid, ord, nowMs}) -> Hero
export function heroName(seat, ord) -> string
export function stats(hero, ctx) -> Stats   // cached by (L, eq uids/pol, sp, cls, buff-free) ; ctx = {herd, roomBonuses}
export function grantXP(state, hero, amount, ev) -> {levels:int}      // level-ups emit fx via ev
export function careerOf(hero) -> {title, tier}
export function classSignature(hero) -> {recommended, median, bph, sub, n}
export function autoLearn(hero) ; export function learn(hero, slot) ; export function respec(hero, nowMs)
export function skillValue(hero, slot) -> {def, rank, coef, cd, ...}  // rank-resolved skill numbers
// (the D§7.1 rotation itself lives in combat.js, which owns the action loop)

// agents.js
export function reconcile(world, snapshot, ev) -> void   // bind/unbind, seq-gated status, forklings, contractors, seen
export function stepStatus(world, hero, live, ev) -> void // per tick: tasks, 8 s close, chests, unblocked, flap, shift
export function openChests(world, hero, {reason}, ev) -> void
export function heroState(live) -> "questing"|"waiting"|...

// combat.js
export function buildRooms(world) -> Room[]
export function stepRoom(world, room, ev) -> void        // one lane tick for every questing/supervising hero in it
export function restTick(world, hero, live) -> void      // regen, coffee refill, fresh eyes

// boss.js
export function canChallenge(world, kind, idx) -> {ok, estimate, label}
export function startFight(world, kind, idx, heroIds, ev) -> Fight
export function stepFight(world, fight, ev) -> "running"|"won"|"lost"|"suspended"
export function estimate(world, kind, idx, heroIds) -> number

// herd.js
export function addGold(state, n) ; export function addSeals(world, n, ev) ; export function buy(state, bIdx)
export function herdXpBonus(state) -> number ; export function journal(state, kind, heroId, text, value, nowMs)
export function checkBadges(world, ev) ; export function bugTrackerKill(state, zone, elite)

// autopilot.js
export function autopilot(world, ev) -> void              // every 60 ticks and on level/gear change

// world.js
export function createWorld({nowMs, seed}) -> World
export function loadWorld(text, {nowMs}) -> {world, warning:null|string}
export function serialize(world) -> string                // JSON with crc
export function tick(world, snapshot) -> {advanced:boolean, ticks:int}   // D§2.11; uses snapshot.nowMs
export function command(world, name, args, nowMs) -> {ok:boolean, error?:string, msg?:string}
// World = { state, rt }
```

`ev` is a small emitter `{ fx(kind, data), note(text, color), banner(text, sub), major() }` that
`world.tick` creates per tick; it enforces the fx budgets (D§11.7) and marks `rt.version++`.

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
| `autoLearn` | `{heroId, on}` | toggle |
| `respec` | `{heroId}` | D§7.1 |
| `setClass` | `{heroId, cls}` | D§4.2 override / career change |
| `pinMap` | `{heroId, mapId\|null}` | stay here / auto |
| `challenge` | `{kind:"boss"\|"review"\|"backlog", idx, heroId?}` | manual challenge (`backlog`: idx = floor) |
| `retreat` | `{}` | end the current fight as a Postmortem |
| `rename` | `{heroId, name}` or `{herd:true, name}` | rename |
| `retire` | `{heroId}` | Lv 30+ to Hall of Fame |
| `rebind` | `{heroId, address}` | move a live agent onto a benched hero |
| `buy` | `{building}` | buy a building level |
| `setting` | `{key, value}` | herd.cfg.* (calm, nums, stageH, auto.*, notify.*) |
| `digestSeen` | `{}` | clears the Herd button's "since you last looked" dot (D§10.7) |

---

## 4. Host integration (`host.js`, `main.js`)

```js
// host.js
let HOST = null;                       // module scope; created lazily
export function getHost() { if (!HOST) HOST = new GameHost(); return HOST; }

class GameHost {
  constructor() { /* no herdr calls */ this.world = null; this.loading = null; this.version = 0; ... }
  ensure(cx)      // first call: if checking(): world = createWorld(…) in memory, no IO.
                  // else cx.spawn(async) load(): the previous build's world (hot reload, §2.3) →
                  // save.json → save.bak (also when save.json is missing) → either file re-signed
                  // when its only fault is the checksum (loadedFrom "unchecked") → a new herd.
                  // A text that does not load is kept aside create-only: save.broken, then
                  // save.broken-<ms> (never overwritten; identical texts kept once). A save.json
                  // that fails to *read* is read again after 1, 3 and 6 s, then on the 30 s beat;
                  // when it reads again a herd that started fresh comes back and the session's
                  // world is kept as save.unsaved-<ms>. Until loaded, view() answers null.
  pump(nowMs)     // if now - lastPumpMs < 900 → return false. Build Snapshot from herdr live data
                  // (agents(), terminals(), spaces(), focused(), window()) and call tick(world, snap).
                  // Returns true if the world advanced; then maybeSave(); then broadcast.
  broadcast()     // run(`${MOD}.tick`) → every shown copy's nextCommand() loop does cx.notify().
                  // Skipped when mayBeShown() finds no copy that herdr could show (it walks the
                  // live layout() like herdr: hidden blocks, the first visible stack child, floats,
                  // pane headers only with an open tab, open dialogs): herdr delivers <mod>.<cmd>
                  // to shown copies only and toasts "mapledr.tick failed" otherwise.
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
                  // title, message, detail, since}: save trouble the player must see (D§13.1,
                  // D§13.4). The stage, party, hud and herd views get it as args.save (not in the
                  // memo key: a change moves host.version). main.js draws a dismissable chip in the
                  // stage's sky; the Herd panel shows a band under its header (HerdVM.save).
  viewError(kind) // a view builder that threw: main.js shows the error chip (the party falls back
                  // to a plain list of herdr's agents()) instead of an endless "loading".
}
// save path: `${appHome()}/data/mapledr/save.json` (writeTextFile creates parent dirs; data/ is not watched)
```

```js
// main.js (sketch; the integration owner finalises it)
import { View, div } from "gpui-kit";
import { props, checking, nextCommand } from "herdr";
import { getHost } from "./host.js";
import Stage from "./ui/stage.js"; import Party from "./ui/party.js"; /* ... */
const ROLES = { stage: Stage, party: Party, nameplate: Nameplate, hud: Hud, sheet: Sheet, herd: HerdPanel };

export default class Mapledr extends View {
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

Key commands (`keys.json` section `layout:Down-the-Stack`, optional): `mapledr.sheet` (focused agent's
hero), `mapledr.herd`, `mapledr.calm`. `mod.json` adds palette entries for the same (herdr lists
every mod's palette entries in every layout: used while another layout shows, they fail with a
"mapledr.sheet failed" toast, because `<mod>.<command>` reaches shown copies only). There is no
"switch to layout" entry: herdr's palette already builds `Layout: Down-the-Stack` and drops
duplicates.
herdr shows ids, not our title. These places show the layout file name ("Down-the-Stack") or the
mod folder name ("mapledr"); the game's own UI shows neither id (D§1).
- Settings layout picker: `LOOKS[name] ?? name` (herdr `defaults/frame/settings/main.js:316`).
- Palette: `Layout: ${Cap(name)}` (`defaults/frame/palette/main.js:156`).
- macOS View > Layout menu (`src/macos.rs:66-69`).
- win98 Start menu (`defaults/mods/win98/taskbar.js:209-210`).
- Keys overlay: `keys  (layout:Down-the-Stack)` | `mapledr sheet`
  (`defaults/mods/help/main.js:17-22,83`).
- Failed-command toast: `mapledr.sheet failed` (`src/window.rs:3076-3078`).

Overlays: `openOverlay({mod:"mapledr", kind:"dialog", width:760, height:500, props:{role:"sheet", heroId}})`
and `{role:"herd"}` (dialog, 760×520). Dialogs close on Esc / click outside; the mod closes them
with `closeOverlay(props().overlay)`.

---

## 5. View models (`game/view.js`) — the only thing renderers read

All positions are logical px at zoom 1 relative to the role's own root. All colors are hex.
Every list item has a stable string `key` (used as `.id()`).

```js
export function stageView(world, { width, height, nowMs }) -> StageVM
StageVM = {
  tick, width, height, calm, nums, stillness:boolean,          // stillness: nothing questing anywhere
  empty: null | { kind: "no_agents"|"loading", title, text },
  headerNote: null | { key, text, color },                     // ≤3 s notes (D§11.15)
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
HudVM  = { gold, snippets, release, sprint, working:int, blocked:int, shipped:int, digestDot }
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
- `RosterVM.slim`, `fame.more`, `backlog.challenge` (Herd panel);
- every view's args may carry `save` (host.saveStatus(), §4) for the stage, party, hud and herd;
- `HerdVM.save: null | {title, text, tooltip}` (the save band, D§13.4) and
  `HerdVM.header.waiting` (the blocked part of `header.sub`, drawn in the blocked colour);
- SheetVM header `tagTip` / `tagTab` (the "provisional" tag explains itself and opens Career), the
  Career class option `lock` (the current provisional class's chip locks it, free), and the
  Career boss card's `challenge`, which is Retreat while its zone boss fight runs or is paused;
- `PlateVM.chip.short` ("!" / "! 2m": the chip below 200 px); the plate and row show BOSS /
  REVIEW only while the participant is questing or supervising (D§9.5: blocked ones hold,
  done / idle ones walk out). The stage agrees: its arena draws only participants that are
  questing, supervising, crashed or blocked (holding); a done or idle one is at home (or in the
  camp chip) with its chest or campfire (the engine gives combat ticks only to questing,
  supervising or crashed heroes, `combat.js isActive`);
- `StageVM.rooms[].pin` (header click: pinMap) and `rooms[].challenge` (the boss door, only when
  the engine would accept it), `HeroVM.reviewEnd` (Promotion banner / Postmortem card, 3 ticks),
  `BossVM.retreat` (two-click confirm), `FxVM.sheet` (loot pillar opens the sheet on the item),
  ChestVM tier `"duck"` (a Duck Chest at a Holo Rubber Duck kill; never claimable);
- clicks that show a terminal (stage hero, bubble, chest, Forkling; party rows and fork chips;
  the sheet's Focus) use `ui/party.js showTerminal`: `pane.focus {terminal}` when `panes()` lists
  it, else `terminal.peek {terminal}`. `agent.focus` shows nothing in this layout (it has no
  agent block, `window.rs:1489-1495`), and `pane.focus` on a pane-less terminal toasts "no such
  pane".

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
  room headers, chests, campfires, mobs, boss, heroes (+forklings), bubbles, nameplates/tags, fx,
  banners, overflow chip. Every child is `.absolute().left(x).top(y)` inside its parent.
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
| Level-up column | cyan div, `age 0..1`, `.loop("opacity", {from:0.3, to:0.9, period: 400})` |
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
- Weapon: `svg("mods/mapledr/art/gear/weapon-<clsId>.svg")` tinted by `weapon.color`, held at the
  right side. Hat: `svg(".../gear/hat-<tier>.svg")` tinted. Accessory: class-specific
  `image(".../gear/acc-<clsId>.svg")`.
- Forkling: 20×24 version, no gear.
- Crashed: face `:(`, body opacity 0.6. Waiting: sits on `art/fx/crate.svg`, face `o_o`.

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
  configured app home (map `mods/mapledr/...` to the repo) → error if missing.
- Records a serialisable tree `{type, methods:[[name,args]], children}` for the preview renderer.
- `herdr` mock: every export in herdr.d.ts; data from a fixture (`setFixture({agents, panes,
  terminals, spaces, focused, theme, settings, window, props})`); `run()` validates command names
  (app commands from herdr's docs/commands.md list + `mapledr.*`) and records calls;
  `checking()` controllable; `readTextFile`/`writeTextFile` against an in-memory FS.
- `cx` mock: `notify` (throws during render), `spawn`, `timer.every/after` (manual clock),
  `focus_handle`, `stop_propagation`, `theme()`.

### 7.2 `tools/check.mjs`
1. Real-check mode: `checking() = true`, `props() = null`, empty lists → construct, `init`,
   one `render` of `main.js`. Must pass.
2. For every role (`stage`, `party`, `nameplate` with and without an agent pane, `hud`, `sheet`,
   `herd`) and several demo worlds (`game/demo.js`: empty, first-day, mid-game with a boss fight,
   late-game with overflow, all-idle, blocked-heavy) at widths 360/960/1600 and zooms 1/2: run
   init + render + 3 simulated ticks (+ re-render). Must produce zero validator errors and keep
   render time < 50 ms each.
3. Exit non-zero with a precise error list.

### 7.3 `tools/preview/`
Converts recorded trees to HTML/CSS (flex, absolute, sizes, colors, text, images, svg masks,
opacity; loops → CSS alternate animations; frames → JS text cycling) and screenshots with
Playwright (`chromium.launch()`, `deviceScaleFactor: 2` for user-facing shots). Produces a full
mock window (sidebar party + stage + nameplates around fake terminals) for `preview.png`, and
per-role shots for review. It is a stand-in for herdr's renderer: good for layout and art
review, not pixel-exact.

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
  stub, size budget (30 heroes ≤ 30 KB).
- world: determinism (same inputs → identical state), offline gap handling, catch-up ≤ 5 ticks,
  clock going backwards.
- view: stage layout stability (status changes never move slots), overflow rules, budgets
  (≤ 400 elements per stage render).
`tools/pacing-sim.mjs` reproduces D§12.1 milestones for the four personas within ±15% and the
bot plateau (D§12.2); it is run in CI-like `npm run pacing`.

---

## 8. Art contract (`tools/gen-art.mjs` → `mods/mapledr/art/`)

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
| `art/fx/` | — | `campfire.svg` 24×24, `bubble.svg` 18×20 (white, dark outline, `!` drawn as paths), `crate.svg` 24×16, `coin.svg` 6×6, `loot.svg` 10×10 (mask: tinted by rarity), `poof.svg` 24×24, `starburst.svg` 20×20 (mask), `door.svg` 24×40, `portal.svg` 32×48, `banner.svg` 12×18, `stamp-fixed.svg` 80×28, `mug.svg` 12×12, `stink.svg` 16×12, `ribbon.svg` 40×10, `tent.svg` 16×14, `lanyard.svg` 10×12 |
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
7. D§3.4 Contractors are created in memory and never saved (as designed); Rebind is in the sheet.
8. The stage height setting maps to `layout.resize {id:"stage", px}`.
9. D§5.7 map choice: Power Level is class-biased with the reference kit (Refactorer/Forkbinder
   3–4 below level, Hotfixer 3–6 above), so autopilot picks maps by hero level: the deepest open map
   whose mid level is ≤ L + 1 (by L after a crash in the last 10 minutes; the crash rule still drops
   a map). The earlier "down at most 2 levels when the weapon lags the reference kit" rule is gone
   (docs/BALANCE.md §2: one-agent herds sat a map low for days).
10. `game/view.js` is a barrel over `game/view/{stage,chrome,panels}.js`.
11. Balance deviations from D§14 numbers and D§10.2 (Campfire levels open with the herd's age, boss
    XP, thorns, mob multipliers, loot item level) are listed with their reasons in
    `docs/BALANCE.md`; every changed number carries a `// balance:` comment in `game/data.js`.
