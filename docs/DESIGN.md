# Down the Stack (mod id `down-the-stack`): final game design

Design version 1.0. Start point: the "signals" design (judges' consensus winner), with the presentation layer of "delight" and the boss mechanics, promotion trials and pure-simulation discipline of "depth". Every number in this document comes from one formula set (section 5 and 6). The pacing tables in sections 6 and 12 were produced by a headless simulation of exactly these formulas (per-tick lane combat for all five classes, boss fights with coffee and crashes, and a day-by-day persona model). Engineers should port that simulator into CI (section 15).

---

## 1. Pitch and title

**Title shown in the app: Down the Stack.** The mod id (its folder) is `down-the-stack` and the layout file is `Down-the-Stack.json`: herdr has no display title for either and shows the folder and file names, so both are named after the game. The codename (the repository's name) appears on no screen: nothing the mod draws and nothing herdr shows for it says "maple".

herdr's own chrome shows the ids:
- the Settings layout picker, the macOS View > Layout menu and the win98 Start menu show "Down-the-Stack";
- the palette shows "Layout: Down-the-Stack";
- herdr names mod actions by the mod folder, so the Keys overlay shows `(layout:Down-the-Stack)` next to `down-the-stack sheet`;
- a failed command shows a `down-the-stack.sheet failed` toast.

ARCHITECTURE §4 has the source lines.

Every coding agent in herdr gets a **Termling**: a small hero shaped like a living terminal window. Its screen is its face (`>_` when working, `o_o` when it needs you, `^_^` when it shipped, `-_-` when resting). Termlings fight their way down **the Stack**, a side-scrolling world of developer bugs: Typo Sprouts in Lint Meadows, Null Pointer Frogs in Callback Caverns, Merge Conflict Golems in the Merge Marshes, the Deadlock Hydra in Threadlock Keep, the Friday Deploy at the top of Production Peaks and the Heisenbug at the bottom of everything.

A Termling fights only while its agent is really working. When the agent finishes a task, a **Commit Chest** drops, sized by how long the agent worked. The chest opens when you look at the result, and only results you have seen fill the zone's **Sprint meter**, which summons the zone boss. A blocked agent's Termling sits on a crate under a white `!` bubble; click it to jump to that terminal. Gear, skills, promotions up a career ladder (Intern, Junior, Senior, Staff, Principal) and boss fights all happen on autopilot, one tick per second, in a 200 px strip under the terminals. The game never asks to be played.

**Pillars**

1. **Real work is the only fuel.** XP, gold and drops come only from agents at `working`. No other status earns combat progress, and no status ever costs anything.
2. **Seen work moves the story.** Boss progress (Seals) comes only from finished tasks a person has seen. A hung or scripted "working" agent plateaus in the first zone.
3. **Glance, don't play.** One silhouette per state. A white `!` means blocked and nothing else. Gold means "done" and nothing else. You can read the whole herd in under a second.
4. **Never nag, never punish.** No sound, no OS notifications by default, no streaks, no daily quests, no loss on death, no penalty for slow answers or for being away.
5. **Honest 1 Hz.** The simulation is a pure function evaluated once per second. All motion between ticks is native CSS loops and transitions using a phase-locked recipe that survives a full-window redraw (section 11.9).

**Originality.** All names, mobs, zones, classes, items, rarities and currencies here are original. Generic RPG words (warrior-like tank, potion-like coffee, XP, gold, boss, elite) and real programming terms used as jokes are the only borrowings. Systems were reviewed against well-known games: no failing enhancement ladder, no account-bound "heirloom" system, no per-monster card collection, no "job advancement" vocabulary, no "Bits"/"Mesos"-style currency names. Humour is about code and shared developer pain, never about people, vendors or the user's own code.

---

## 2. Core loop and agent status mapping

### 2.1 Loop

```
agent WORKING ──► Termling fights its lane in its map (1 action per tick)
     │              kills → XP, gold, drops (Daily Shift rate applies)
     │              herd kills fill map quotas → next map unlocks for everyone
     ▼
task ends (non-working status held 8 s)
     │  Commit Chest drops: Seals = minutes/10 (cap 12), items = Seals, tier by size
     ▼
person sees it (done→idle, focuses the terminal, or clicks the chest)
     │  chest opens: gear, gold, chest XP; Seals pour into the zone's Sprint meter
     ▼
Sprint meter full + zone's last map reached ──► boss door opens
     │  autopilot challenges when the win estimate ≥ 100% (or click Challenge)
     ▼
boss FIXED ──► next zone unlocks for the herd, Keepsake, trophy ──► stronger heroes, deeper maps
agent IDLE / app closed ──► Fresh Eyes pool (×1.5 kill XP next session)
```

Time scales: seconds (hits, numbers), minutes (kills, early levels), one task (a chest), one day (first bosses, Shift reset), weeks (zones, Senior and Staff promotions), months (Principal, the Heisenbug, the endless Backlog).

### 2.2 Hero states and exact per-tick effects

Precedence when several apply: **Waiting > Questing > Supervising > Shipped > Resting**. Off duty applies when the terminal no longer exists.

| herdr signal | Hero state | Stage | Per tick (1 s) |
|---|---|---|---|
| `working` | **Questing** | Fights its lane, background drifts, face `>_` | One action (skill or attack) on the engaged mob, or one advance step if none is engaged (section 5.5). Engaged mob swings per its timer. Regen 0.5% MaxHP if engaged, 2% on an advance step. Kill rewards × Daily Shift. Task minutes +1/60. Shift minutes +1/60. Fresh Eyes pool −1/60 min (if > 0). Forklings hit. Boss or trial timer advances. |
| `blocked` | **Waiting** | Sits on a crate, white `!` bubble (after 2 ticks), slot desaturated, mobs queue with `…` | Frozen: HP, cooldowns, buffs, mob timers and boss timer do not change. No damage dealt or taken. `blockedSec` +1. Task minutes paused. No Fresh Eyes accrual. |
| `done` | **Shipped** | Sits by a sparkling Commit Chest with a SHIPPED ribbon, face `^_^` | No combat. Regen 5%. Fresh Eyes +0.25 min per min. Coffee refills 1 cup per 30 ticks. |
| `idle` | **Resting** | Sits at a small campfire at the left of its own slot, face `-_-`, `z` after 10 min | No combat. Regen 5%. Fresh Eyes +0.25 min per min. Coffee refills 1 cup per 30 ticks. |
| not working, ≥1 Forkling working | **Supervising** | Stands behind its Forklings, face `>_` at 60% opacity | Acts on every 2nd tick only. Forklings act every tick. Shift minutes +0.5/60. Rewards as Questing. |
| terminal gone | **Off duty** | Waves, steps into a closing portal (300 ms), leaves the stage | Fresh Eyes +0.25 min per min (wall clock, also while the app is closed). Pending chests wait (2.4). |

Pinned, focused and party status never change these effects (2.8).

### 2.3 Tasks (Quests) and transitions

A **task** opens when a hero starts `working` and closes when a non-working status other than `blocked` has held for **8 ticks**. Flipping back to working inside those 8 ticks continues the same task. Blocked time never counts toward task minutes. The task's **Quest name** is the latest non-empty terminal `title`, truncated to 40 characters, kept only in the local save. As built the latest *telling* title (11.11 as built: status glyph stripped; not the program's name, a shell, a path or a prompt), so a task opened under its program's name has none until the agent names its work.

| Transition | Game event |
|---|---|
| (new) / idle / done → working | Open a task (or continue one in its 8 s close window). |
| working → blocked | Pause the task. Freeze the slot after the current action resolves. |
| blocked → working | Resume the task. If blocked ≥ 10 s, grant **Unblocked** (2.6). |
| working or blocked → done, held 8 s | Close the task. If minutes ≥ 1.5, drop a **pending Commit Chest** (2.4). |
| working or blocked → idle, held 8 s | Close the task. The chest drops and opens at once: the person watched it finish. |
| done → idle | **Seen.** Every pending chest of this hero opens (loot fountain). |
| done → working | A new task opens. The old chest stays pending. |
| terminal ends | An open task ≥ 1.5 min closes into a pending chest on the off-duty hero. XP already earned is kept. |
| `seq` unchanged | Status is re-read when `seq` changes, and also on herdr's **seen flip** (done → idle when the person looks; idle → done when a turn is marked unread elsewhere). herdr makes that flip without moving `seq` (`set_word` bumps `seq`; `mark_seen` and `set_turn` do not), so compare the status as well as `seq`. Any other unchanged snapshot is ignored. |
| `seq` advanced more than one step between snapshots | Apply only previous → current. working → idle is treated as "dropped and opened at once" (herdr only reports idle after the person has seen it). |

### 2.4 Seals, Commit Chests and "seen"

**Seals per task** (m = working minutes of the task, after Forkling credit):

```
rawSeals(m) = 0                 if m < 1.5
            = min(m, 120) / 10  otherwise        (linear: 1 Seal per 10 working minutes, cap 12)
seals       = Σ over the task's minutes of (1/10 × shiftSealFactor at that minute)   (cap 12)
```

Seals are linear in working time, so four 10-minute tasks and one 40-minute task earn the same 4 Seals. Chopping work up gains nothing and long autonomous runs lose nothing up to 2 hours.

**Commit Chest contents** (rolled with the hero's RNG when the task closes, credited when seen):

| Part | Formula |
|---|---|
| Items | `floor(rawSeals)` + 1 more with probability `frac(rawSeals)`. Chest rarity weights (8.2). Item level = current map's top level + U{0,1,2}. Never reduced by the Daily Shift. |
| Gold | `seals × 20 × gold(mapMid)` |
| Chest XP | `seals × 45 × mobXP(mapMid) × (1 + ΣXP%)` (no Fresh Eyes). A task is worth about +29% on top of its fighting XP. |
| Sprint credit | `seals` into the frontier zone's Sprint meter, and into the account's cumulative Seals (Release Train, 10.3). |

| Chest tier (cosmetic size, plus a floor) | rawSeals | Guarantee |
|---|---|---|
| Wooden (brown) | < 1 (under 10 min) | none |
| Iron (grey) | 1 – 2.99 | none |
| Silver (pale blue) | 3 – 5.99 | at least one Alpha or better |
| Gold (gold) | ≥ 6 (an hour or more) | at least one Beta or better |

**Merging.** If the hero already has a pending chest created less than 5 minutes ago, the new task merges into it (minutes add, tier upgrades) instead of stacking. At most 3 chest sprites are drawn per hero; more show as a `×n` tag. Pending Seals are never capped or lost.

**Seen (acknowledgment).** A pending chest opens with full value when any of these happens:
1. The hero's agent goes done → idle.
2. The hero's terminal gets `focused` (any status).
3. The person clicks the chest, the hero, or the chest icon in the sidebar row.
4. The task closed directly working → idle.

Closing a terminal is **not** acknowledgment. Pending chests on an off-duty hero wait; after 24 h they open as **Unreviewed**: half gold, half chest XP, `floor(rawSeals/2)` items, **no Seals**. The sidebar row of an off-duty hero shows its chest icon, so one click still claims it fully.

As built (round 3): the folded "Off duty" group header shows its pending chests (a gold chest chip "×n"), each off-duty row's tooltip says when its chest opens Unreviewed, and the Herd button's dot (party footer and HUD) lights while an off-duty chest is within 4 h of opening Unreviewed; viewing the Digest does not clear that dot, claiming or the opening does. A chest that opens Unreviewed (after 24 h off duty, or at once when its hero is let go to make room or is a Contractor whose agent leaves) writes one journal line, "Chest opened Unreviewed: “task” (half value, no Seals)" (or "n chests …"), which the Digest lists under "Opened Unreviewed".

### 2.5 Flap guard

More than 6 status changes for one terminal within 60 s suspends chest drops and celebrations for that hero for 5 minutes. The task stays open and keeps accumulating minutes, so nothing is lost; it simply closes once the status settles.

### 2.6 Blocked → Unblocked (flat, never graded)

When an agent goes blocked → working after at least 10 s blocked, and the current task has at least 60 s of working time, the hero gets **Unblocked**: +15% damage and +15% kill XP for 120 Questing ticks. Cooldown 300 Questing ticks. It does not depend on how quickly the person answered, so the game never rewards interrupting your own work. The bubble pops (200 ms) and the word "Unblocked" floats once (no exclamation mark).

### 2.7 Sub-agents → Forklings

A terminal with a `parent` never gets its own hero. It becomes a **Forkling** of the root hero (walk the parent chain up to 5 steps). An orphan whose parent is unknown attaches to the most recently seen hero of the same seat; if there is none it is treated as a top-level agent.

Sub-agents usually have no pane. herdr's `agent.focus` only chooses the agent that an `agent` block shows, and our layout (`Down-the-Stack`) has none. So every click that **shows a hero's terminal** (a Termling, its `!` bubble, a Commit Chest, a Forkling, a sidebar row) does what herdr's agents list does: `pane.focus {terminal}` when the terminal has a pane (this also selects its space and tab, like `agent.focus`), else `terminal.peek {terminal}`. That covers Forklings and pseudo-agents such as an orphan played as top-level.

| Forkling rule | Value |
|---|---|
| Damage | Each **working** Forkling hits the parent's target every tick for 12% of the parent's Main hit (Forkbinder: 20%, more with Process Pool). |
| Counted Forklings | 3 (Forkbinder: 3, up to 6 with Process Pool). Extra ones are drawn as a `+n` tag and do nothing. |
| Seals | A working Forkling adds 0.25 × its working minutes to the parent's open task (or to a side-quest bucket that joins the parent's next chest). The 120-minute task cap still applies. |
| Supervising | Parent not working but ≥ 1 Forkling working → parent Supervises (2.2). While the parent is Waiting, its Forklings wait too. |
| Look | Half-size Termling (20×24 px) in the parent's slot, following it. Mirrors its own status: blocked Forklings show a tiny `!` you can click to show that sub-agent (peek, see above). |
| Signature | "Spawned a sub-agent" is recorded on the parent's task for class choice (4.2). |

### 2.8 Space, pinned, focused, program, title

| Signal | Effect |
|---|---|
| `space` | Heroes in the same space are a **guild** (sidebar group). Guild members standing in the same map form a **party room** (adjacent slots share one background). Party: +6% kill XP per other Questing member in the room, max +18%. Auras and heals apply to the room. **Convergence:** a hero moves down to its guild-mates' map if that map is at most one map below its own choice. |
| `pinned` | A small banner on the hero's back. Its room gets +5% XP (only one banner counts per room). A pinned hero's slot is never folded into overflow. |
| `focused` | Spotlight only: a soft ground glow and a bold nameplate. **No width change, no mechanical effect**, except that focusing counts as "seen" (2.4). The Heisenbug reacts cosmetically (9.6). |
| `program.key` (fallback `app`) | Cosmetic only: title-bar tint (8-colour palette; unknown keys hashed into it) and the program icon on the title bar. **Never chooses the class.** |
| `title` | The hero's **Current quest**: shown in tooltips, the sheet header and the chest tooltip ("Shipped: Fix flaky auth test · 2.4 Seals · Iron chest"). Never drawn on the stage itself. |
| `tab.working_since` | Used once, on first sight of an agent that is already working (for example after an app restart): the new task starts with `min(now − working_since, 10 min)` of minutes, **for Seals only, never XP**. It is per tab, hence the cap. |
| `tab`, `pane_name` | Tie-breakers when rebinding a terminal to a hero (3.2). |

### 2.9 The three visible rules (one "why" tooltip)

Every XP bar and nameplate has a "why" tooltip, for example: `+512 XP/min = working ×1 · Fresh Eyes ×1.5 · Party +12% · Herd +23% · Unblocked +15% · Shift: 3h12m today (full rate until 4h)`. Only three rules ever limit rewards, and they are all on that tooltip:

1. **Daily Shift** (per hero, resets 04:00 local; Supervising counts half):

   | Working time today | Kill XP, gold, drops | Seals and chest gold/XP | Chest items |
   |---|---|---|---|
   | 0 – 4 h | ×1 | ×1 | full |
   | 4 – 8 h | ×0.5 | ×0.75 | full |
   | 8 h + | ×0.25 | ×0.5 | full |

2. **Seen it.** Seals and full chest value need a person to have seen the result (2.4).
3. **Fresh Eyes.** While a hero is not Questing (Shipped, Resting, Off duty, app closed; not while Waiting), its pool grows by 1 minute per 4 minutes, capped at 60 + 15 × Campfire level minutes (60 → 210). While Questing with a pool above 0, kill XP is ×1.5 and the pool drains 1 minute per minute. It only starts after the hero's first credited Seal. Shown as a pale segment on the XP bar.

Background hygiene caps (roster limits, Forkling count, crowding, flap guard) exist too but almost never bind for a real user, so they are listed in section 12, not on the tooltip.

As built (round 3): the level gap (6.2) is not one of the three rules, but when it binds (a hero standing on a map whose level is below its own, mostly under a manual pin, 11.16) the why line and the sheet's XP breakdown name it: "1-1 is 31 levels below: ×0.03". The Backlog has no gap penalty (9.8), so it never shows there.

### 2.10 Signal hygiene

- Status is processed only when `seq` changes; unknown statuses count as `idle`.
- Terminals with neither `program` nor `app` never become heroes.
- Simulated catch-up per snapshot is at most 5 ticks (`steps = clamp(round(Δt / 1 s), 0, 5)`). A gap over 60 s counts as offline: no combat, Fresh Eyes accrues from wall-clock time (clamped to 30 days), daily Shift resets if 04:00 passed.
- If the wall clock goes backwards, nothing accrues until it passes the last tick time again.
- Daily counters key on the highest local day already seen.

### 2.11 Tick pipeline (pure function)

```
tick(state, snapshot, nowMs) -> (state', renderEvents)      // ~1 Hz, deterministic given state.rng
  steps = clamp(round((nowMs - state.lastMs)/1000), 0, 5); if gap > 60 s: applyOffline(gap)
  if crossed 04:00 local: resetShift()
  reconcile(snapshot)            // seq-gated status, bind/unbind, Forklings, Contractors, focus/pin flags
  for hero in live heroes (stable order): stepStatus(hero)       // tasks, 8 s close, chests, seen, Unblocked, flap guard
  repeat steps:
    for room in rooms with ≥1 Questing/Supervising hero: stepLane(room)   // spawn, actions, swings, kills, rewards
    for fight in boss fights and trials: stepEncounter(fight)
    for hero not Questing: regen, coffee refill, Fresh Eyes accrual
  every 60 ticks: autopilot()     // equip, deprecate, skills, polish, buildings, map choice, boss challenge
  emit renderEvents (≤ 2 numbers per hero, ≤ 6 per room, ≤ 12 per stage)
  save if dirty and (30 s elapsed or a major event 2 s ago)
```

---

## 3. Character identity and persistence

### 3.1 Seat key

```
seat = norm(space.name || space.id || "nospace") + "/" + (program.key || app || "agent")
norm = lowercase, trimmed, at most 32 characters
```

As built: "characters" are UTF-16 units, and the cut never keeps half of an emoji (`formulas.cutText`; herdr refuses a lone surrogate in any text). The Quest name's 40 is cut the same way (2.3). A save from an older build whose seats were cut through an emoji is mended on load, so each hero still matches its space.

Several heroes can share a seat; each has an ordinal (0, 1, 2…) used only for its default name. The hero also stores `space.id`: if a space is renamed but its id matches, the seat is re-keyed automatically.

### 3.2 Binding (only for terminals not yet bound)

1. If the terminal has a `parent`, it becomes a Forkling (2.7).
2. Otherwise collect free heroes (not bound right now) with the same seat and pick the first that applies: `lastPane == pane_name`, then `lastTab == tab.name`, then highest level, then most recently seen. The everyday "main" hero therefore carries on.
3. If none: create a hero at the lowest free ordinal, if the roster has fewer than 30 heroes and fewer than 6 heroes were created today.
4. Otherwise the agent plays as a **Contractor** (3.4).

The address → hero map lives in memory for the address's lifetime, so reordering tabs never swaps heroes. `addr` is saved so a reload that keeps the same terminal rebinds instantly. The sheet offers **Rebind**: move a live agent onto any benched hero, of any seat.

As built (round 3): the instant rebind by saved `addr` needs the hero's seat to match, or the same space id and the same program; another program started in the same terminal (codex after claude) binds like a new terminal of its own seat, and the old hero keeps its seat and its unseen chest. Rebind moves the agent onto the target hero's own Daily Shift (2.9: the Shift is per hero), so one agent rotated across benched heroes keeps full rate past 4 or 8 working hours; this follows 12.3's "not adversarial anti-cheat" and is left for the owner to confirm (out/VERIFY.md, round 3).

### 3.3 Names

Default name = first name + epithet from `FNV1a32(seat + "#" + ordinal)`: `first[h % 64] + " " + epithet[(h >> 8) % 64]`, for example "Kip the Idempotent", "Rue Two-Spaces", "Juno of the Green Build". The guild (space name) is shown beside it, never inside it. Renaming is free. Badges unlock extra epithets.

### 3.4 Roster limits, Contractors, retirement

| Rule | Value |
|---|---|
| Saved heroes | 30 |
| New heroes per local day | 6 |
| Roster full on a new agent | Delete the least-recently-seen hero below Lv 10 (its gear goes to the stash). If every hero is Lv 10+, the agent becomes a Contractor. High-level heroes are never deleted automatically. |
| **Contractor** | Not saved. Level = max(1, median roster level − 5), reference kit at that level (all Alpha), class from the agent's signature if known, else Shellmancer. Kills and chests pay gold and Seals to the herd normally. Half of its XP goes to the lowest-level off-duty hero of the same seat, if any. Tag "(contractor)"; tooltip "Contractors don't get equity." |
| **Retire** (manual, Lv 30+) | The hero goes to the **Hall of Fame** (name, class, level, date, about 40 bytes). Gear moves to the stash. Legacy: +0.5% herd XP per retiree, max +10% (inside the herd cap, 10.4). |
| Off duty | Keeps everything; Fresh Eyes accrues; pending chests wait (2.4). |
| **Onboarding** (catch-up) | +50% XP (additive, outside the herd cap) while the hero's level ≤ herd's top level − 10. Shown as a "new hire lanyard". As built: a "New hire" chip in the character sheet's header (its tooltip gives the bonus) and "Onboarding" in the XP breakdown; no lanyard sprite (the Intern's class accessory is already one). |

---

## 4. Classes and the career ladder

### 4.1 Career ladder (replaces "job advancement")

| Title | Levels | Gate | Unlocks |
|---|---|---|---|
| **Intern** | 1 – 9 | none | Hello, World (L1), printf() (L5) |
| **Junior** *class* | 10 – 29 | reach Lv 10: class assigned (4.2) | Main (L1), Area (L5), Passive (L10), Buff (L20); Intern SP refunded |
| **Senior** *class* | 30 – 59 | win the **Senior Review** (4.5) | Signature skill, +1 SP |
| **Staff** *class* | 60 – 89 | win the **Staff Review** (4.5) | Ultimate, +1 SP |
| **Principal** *class* | 90 – 100 | reach Lv 90 ("promotion packet approved", no fight) | Capstone passive, silver title-bar trim (as built: no trim; the career title says Principal) |

The level keeps rising whether or not a review has been passed; only the tier's skill waits. Promotions recompute primary stats from Lv 1 with the class's growth, so promotion feels like a jump.

### 4.2 Class from behaviour (program never decides)

The **signature** covers the hero's last 20 qualifying tasks (closed tasks of 1.5 min or more, seen or not). First matching rule wins:

| # | Signature | Class | Why it fits |
|---|---|---|---|
| 1 | ≥ 25% of tasks spawned a sub-agent | **Forkbinder** (summoner) | Its agent forks work |
| 2 | ≥ 2.0 blocked events per working hour | **Rubberducker** (support) | Its agent talks things through with you |
| 3 | Median task ≥ 15 min | **Refactorer** (tank) | Long, steady stretches |
| 4 | Median task ≤ 5 min | **Hotfixer** (single-target, crits) | Many quick fixes |
| 5 | Anything else | **Shellmancer** (area caster) | Balanced work |

- **Provisional until 15 tasks.** At Lv 10 the hero takes the recommended class, marked *provisional*. Until it has 15 qualifying tasks on record, the class is re-evaluated after every qualifying task and switches for free (skill points are re-spent by auto-learn). At 15 tasks it locks. As built (round 3): the refunded points are re-spent only while auto-learn is on for the herd (Settings, and the autopilot master switch) as well as for the hero; otherwise they wait, and the next autopilot pass spends them once it is on (7.1).
- **Person override:** any class, free, any time before Lv 20 (this also locks it). From Lv 20, a Career Change costs 25 × L Snippets and refunds all skill points.
- The sheet's Career tab shows the live signature ("median task 12 min · 0.8 blocks/h · 10% with sub-agents → Shellmancer").
- Five Claude agents in one repo still end up varied, because classes follow behaviour, and no product is ever ranked.

### 4.3 Class table

All heroes start every primary stat at 4 (Lv 1) and gain `growth × (L − 1)`.

| Class | Role | Weapon | MIGHT / GRIT / KEEN / LUCK per level | Innate | Autopilot weights (DPS / EHP) | Silhouette |
|---|---|---|---|---|---|---|
| Intern | starter | Training Stick | 2.3 / 1.7 / 0.5 / 0.5 | none | 0.60 / 0.40 | Lanyard with a blank badge |
| Refactorer | tank | Blades | 2.2 / 2.3 / 0.5 / 0.0 | Clean Hands: +10% max HP; always stands at the front in boss fights (bosses hit the front hero) | 0.45 / 0.55 | Broad keycap body, scarf, big blade |
| Hotfixer | single target, crits | Patch Knives | 2.4 / 1.0 / 1.6 / 0.0 | Hot Hands: +5% crit, crit multiplier 1.6 | 0.70 / 0.30 | Headlamp, hoodie, two knives |
| Shellmancer | area caster | Pipes | 2.6 / 1.4 / 0.5 / 0.5 | Verbose: area skills hit +1 target | 0.70 / 0.30 | Pointy hood with a blinking `_` cursor at the tip |
| Forkbinder | summoner | Manpages | 2.2 / 1.6 / 0.6 / 0.6 | Forklings deal 20% (not 12%) | 0.65 / 0.35 | Floating open book with orbiting dots |
| Rubberducker | support | Ducks | 2.0 / 2.0 / 0.5 / 0.5 | Good Listener: Unblocked lasts twice as long for everyone in its room | 0.50 / 0.50 | Ochre raincoat (#C08A3E), duck on a staff |

Measured balance (simulated on-level farming, reference kit): kills per minute at Lv 60 Refactorer 17.4, Hotfixer 15.1, Shellmancer 18.1, Forkbinder 16.4 (without sub-agents), Rubberducker 17.0; single-target boss DPS relative to the mean: Hotfixer 1.4×, Rubberducker 1.1×, Shellmancer 0.95×, Forkbinder 0.8× (before Forklings), Refactorer 0.8× (with the most HP and DR).

### 4.4 Stat meaning

| Stat | Per point |
|---|---|
| MIGHT | +1% damage |
| GRIT | +1% max HP |
| KEEN | +0.15% crit chance |
| LUCK | +0.4% item find, +0.5% gold |

("Focus" is deliberately not a stat or rule name, so it never collides with herdr's `focused`.)

### 4.5 Promotion reviews (solo trials in the hero's own slot)

Trials run only while the hero is Questing (the timer freezes otherwise), use the boss rules of 9.5 (Wounds, Lessons Learned, no loss), and autopilot starts them when the win estimate ≥ 100%. A thin "REVIEW" banner replaces the room header. As built: at ≥ 90% (`T.boss.autoAt`, docs/BALANCE.md), under the Settings switch "Promotion reviews" (`auto.career`), which covers the Senior and Staff Reviews only.

| Review | Opponent | HP | Attack | Timer | Mechanic | Reward |
|---|---|---|---|---|---|---|
| **Senior Review** (Lv 30) | **You, Six Months Ago**: a greyed copy of the hero, in the hero's own class silhouette | 20 × mobHP(30) = 9,580 | every 2 ticks, 1.3 × mobATK(30) = 46 | 150 | At 50% HP a speech bubble: "who wrote this?" | Senior title, Signature skill, +1 SP, Release class weapon at iLvl 30 |
| **Staff Review** (Lv 60) | **The Senior Reviewer**: a tall figure in a hoodie holding a red pen | 26 × mobHP(60) = 240,292, in 3 phases labelled `nit:`, `blocking:`, `LGTM w/ comments` | every 3 ticks, 2 × mobATK(60) = 886 | 180 | Each phase change spawns 2 Nitpicks (HP 9,242, swing 222); the Reviewer takes −50% damage while any Nitpick lives | Staff title, Ultimate, +1 SP, Release Sticker at iLvl 60 |

An on-level hero clears the Senior Review in about 60–80 ticks and the Staff Review in about 110–150.

---

## 5. Stats and combat formulas

### 5.1 Notation

`L` hero level, `m` mob level, `i` item level, `R` rarity multiplier (8.4), `p` polish level, `t = clamp(ceil(i/20), 1, 5)` item tier, `g(x) = 1.07^(x−1)` (for x ≥ 1), `U(a,b)` uniform roll from the hero's RNG. Percent bonuses of one kind add together before multiplying.

### 5.2 Reference kit (the "expected hero")

Mobs, bosses, Power Level, helper caps and Contractors are all tuned against one closed-form reference hero at level L. It is not a real character; it is what an autopilot hero typically wears.

```
iRef(L)     = max(1, L − 2)                 item level
R_ref(L)    = 1 + 0.0048·L                  rarity (Prototype at L1 → about Beta-Release at L100)
P_ref(L)    = 1 + 0.005·L                   polish (p ≈ L/10, 5% each)
D_ref(L)    = 0.003·L                       damage % from affixes
MIGHT_ref   = 4 + 2.3·(L−1)    GRIT_ref = 4 + 1.7·(L−1)    KEEN_ref = 4 + 0.7·(L−1)
crit_ref    = min(0.5, 0.05 + 0.0015·KEEN_ref + 0.0005·L)
refHit(L)   = 6 · g(iRef) · R_ref · P_ref · (1 + MIGHT_ref/100) · (1 + D_ref) · (1 + 0.5·crit_ref)
refHP(L)    = 60 · g(L) · (1 + GRIT_ref/100) · (1 + 0.003·L)
refArmor(L) = 13.5 · g(iRef) · R_ref · P_ref · (1 + 0.002·L)
refDPS(L)   = mobHP(L) / 3                  single-target damage per tick of an on-level hero
```

### 5.3 Hero stats

```
MIGHT = 4 + growthMight·(L−1) + gear      (same shape for GRIT, KEEN, LUCK; growth in 4.3)
WeaponDmg = 6 · g(i) · R · (1 + 0.05·p)          (no weapon: 3 · g(L))
MaxHP     = round(60 · g(L) · (1 + GRIT/100) · (1 + HP%))
ArmorPiece= 3 · K_slot · g(i) · R · (1 + 0.05·p)   K: Hat 1.0, Hoodie 2.0, Mug 0.8, Boots 0.7 (Weapon, Sticker 0)
Armor     = Σ ArmorPiece · (1 + Armor%)
DR(m)     = min(0.75, Armor / (Armor + 25·g(m)) + flatDR%)        against an attacker of level m
Crit      = min(0.50, 0.05 + 0.0015·KEEN + gear + skills + innate)
CritMult  = 1.5 + critDmg%                  (Hotfixer 1.6)
Dodge     = min(0.30, gear + skills)         a dodged mob hit shows "404"
CDR       = min(0.40, gear + skills)         cooldowns rounded up to whole ticks
ExtraAct  = min(0.15, Async affix)           repeat the Main attack at the end of the tick
ItemFind  = min(1.50, 0.004·LUCK + gear + herd)
Gold%     = 0.005·LUCK + gear + herd
```

### 5.4 Damage

**Outgoing hit**

```
hit = WeaponDmg · (1 + MIGHT/100) · coef · (1 + ΣDmg%) · (crit ? CritMult : 1) · U(0.92, 1.08)    minimum 1
```

- `coef` is the skill coefficient (Main attack 1.00 at rank 1).
- `ΣDmg%` adds: affixes, buffs (Code Review, Sudo, Pair Programming, Retrospective…), Unblocked +15%, capstones, trophies (+1% per boss), Bug Tracker Threadlock perk, Lessons Learned (boss only), Boss% (boss only), Keepsakes.
- Shields and DR on bosses multiply afterwards. There is no level-gap damage penalty: mobs above you are simply tougher, because `g` scales their HP and attack by 7% per level.

**Incoming hit**

```
raw   = mobATK(m) · atkMult · (elite ? 1.5 : 1) · U(0.9, 1.1)
taken = max(1, round(raw · (1 − DR(m)) · (1 − roomAuraDR)))         unless dodged ("404") or invulnerable ("403")
```

On-level, one mob swing is 3% of an on-level hero's max HP after DR (by construction of mobATK).

### 5.5 Lane combat (per tick)

Each Questing hero owns a **lane** of up to 3 mobs in its slot, even inside a party room (party members' lanes sit side by side on one background).

1. **Spawn.** If the lane has fewer than 3 mobs, one spawn group enters at the right edge (1 per tick). It arrives (becomes targetable) on the next tick. Spawn group = the map's mob mix (9.1); 1 in 80 is a Smelly elite; 1 in 20,000 is the Holo Rubber Duck.
2. **Advance.** If the hero has no engaged mob, this tick is an **advance step**: walk forward (the world scrolls 48 px), regen 2% MaxHP, engage the front arrived mob. No attack.
3. **Act.** Otherwise the hero takes exactly one action from its rotation (7.1) against the engaged mob; area skills also hit other arrived lane mobs. Free actions (buff casts, summons, passive procs, Forkling hits) happen in the same tick.
4. **Mob swings.** The engaged mob swings on the tick it is first hit and every 2nd tick after (Fast: every tick; Slow: every 3rd). Ranged mobs also swing from the second lane position every 3rd tick. Unengaged mobs pace and do nothing.
5. **Deaths.** Any mob at 0 HP dies: rewards (6.2), Bug Tracker count, quota count. If the engaged mob died, the next tick is an advance step.
6. **Upkeep.** Regen 0.5% MaxHP. Coffee check. Crash check.

Each tick of the cycle is 1 s, so the 1 Hz data tick *is* the combat clock. One kill takes about 3 action ticks plus 1 advance tick on-level: about **15.5 kills per minute** (simulated mean across classes and levels; range 14–19).

### 5.6 Regen, coffee, crash

| Rule | Value |
|---|---|
| Regen | 0.5% MaxHP per tick engaged; 2% on an advance step; 5% per tick when not Questing |
| Coffee (potion) | Drunk automatically when HP < 45% and no cup in the last 5 ticks. Heals 35% MaxHP (+3% per Coffee Machine level). Each hero carries 20 cups, refilled 1 per 30 ticks while not Questing and fully before every boss fight or review. Price 2 × gold(L) per cup (−5% per Coffee Machine level). |
| Crash (death) | At 0 HP: tips over, face `:(`, a tiny "Rebooting…" bar for 5 ticks, back at 50% HP. No XP, gold or item loss. Buffs and Bisect stacks reset. |
| Crash rule | 3 crashes within 10 minutes → the hero drops one map for 30 minutes. |

Simulated sustain with the reference kit: on-level maps need 0–3 cups per working hour; maps 3 levels above need about 40–70 (autopilot avoids them); 5 levels above run out of coffee and crash.

### 5.7 Power Level and map choice

```
DPS_est = mean single-target damage per tick from a deterministic 60-tick dry run of the hero's
          rotation against a dummy (expected values, no RNG); cached, recomputed on level/gear/skill change
PL      = L + clamp(round( ln(DPS_est / refDPS(L)) / ln(1.07) ), −5, +8)      "fights like a Lv 34"
```

Autopilot map choice (on level-up, equipment change and every 60 ticks): the deepest **unlocked** map whose mid level ≤ PL + 1, then party convergence (2.8), then the crash rule. A manual "Stay here" pin overrides it. The sheet shows "Power Level 34 (Lv 31 + gear 3)".

### 5.8 Mob formulas

```
mobHP(m)  = round( (1.6 + 0.62·√m) · refHit(m) · hpMult )
mobATK(m) = round( 0.03 · refHP(m) / (1 − DR(refArmor(m), m)) · atkMult )      per swing
mobXP(m)  = round( (4 + m) · 1.06^(m−1) · xpMult )
gold(m)   = round( (2 + m) · 1.05^(m−1) · goldMult )
Smelly elite: HP ×3, ATK ×1.5, XP ×4, gold ×4 (drawn 1.25× with three green stink lines)
```

The factor `1.6 + 0.62·√m` is the fitted "rotation factor": as heroes unlock area skills, signatures and ultimates, mobs carry more HP so the kill pace stays about 15.5 per minute from level 1 to 100 (fit from the class simulation; skill unlocks still feel like small power spikes).

Reference values (multipliers 1):

| m | refHit | mobHP | mobATK | refHP | ref DR | mobXP | gold |
|---|---|---|---|---|---|---|---|
| 1 | 6.5 | 14 | 3 | 63 | 35% | 5 | 3 |
| 5 | 8.5 | 26 | 4 | 88 | 33% | 11 | 9 |
| 10 | 14.1 | 50 | 6 | 136 | 35% | 24 | 19 |
| 12 | 17.2 | 64 | 7 | 161 | 35% | 30 | 24 |
| 20 | 37.3 | 163 | 15 | 314 | 37% | 73 | 56 |
| 23 | 49.7 | 227 | 19 | 402 | 38% | 97 | 73 |
| 30 | 95.9 | 479 | 35 | 713 | 40% | 184 | 132 |
| 34 | 139 | 725 | 50 | 987 | 41% | 260 | 180 |
| 40 | 241 | 1,330 | 83 | 1,602 | 42% | 427 | 282 |
| 45 | 379 | 2,183 | 127 | 2,390 | 43% | 636 | 402 |
| 50 | 594 | 3,556 | 193 | 3,558 | 45% | 938 | 568 |
| 56 | 1,014 | 6,326 | 318 | 5,718 | 46% | 1,479 | 849 |
| 60 | 1,444 | 9,242 | 443 | 7,833 | 47% | 1,992 | 1,103 |
| 67 | 2,666 | 17,798 | 790 | 13,548 | 49% | 3,322 | 1,727 |
| 70 | 3,462 | 23,500 | 1,011 | 17,116 | 49% | 4,124 | 2,086 |
| 78 | 6,916 | 48,934 | 1,950 | 31,835 | 51% | 7,284 | 3,425 |
| 80 | 8,213 | 58,687 | 2,296 | 37,155 | 51% | 8,384 | 3,871 |
| 89 | 17,724 | 132,028 | 4,782 | 74,276 | 53% | 15,682 | 6,663 |
| 90 | 19,297 | 144,376 | 5,186 | 80,198 | 54% | 16,802 | 7,074 |
| 100 | 44,954 | 350,644 | 11,660 | 172,241 | 56% | 33,290 | 12,774 |

### 5.9 Damage versus mob HP, per zone

Each row is a zone's three mobs at their home-map mid level, with their multipliers applied. "Ticks" is single-target action ticks for an on-level reference hero (= 3 × hpMult); area skills shorten it in practice. Numbers on screen are real hits against real HP, so they always add up to the kill.

| Zone | Mob (home level) | HP | Swing | XP | Main hit | Ticks |
|---|---|---|---|---|---|---|
| Lint Meadows | Typo Sprout (2) / Semicolon Snail (6) / Unused Import (10) | 17 / 38 / 80 | 3 / 6 / 5 | 6 / 16 / 34 | 7 / 9 / 14 | 3 / 3.9 / 4.8 |
| Callback Caverns | Callback Bat (14) / Promise Wisp (18) / Null Pointer Frog (21) | 66 / 143 / 182 | 5 / 13 / 19 | 34 / 65 / 88 | 21 / 31 / 41 | 2.4 / 3.3 / 3 |
| Regex Ruins | Capture Group Goblin ×2 (24) / Backslash Bandit (28) / Greedy Glob (32) | 152 each / 349 / 767 | 15 / 33 / 42 | 64 / 154 / 285 | 55 / 80 / 115 | 1.8 each / 2.7 / 3.9 |
| Merge Marshes | Diff Leech (36) / Rebase Wraith (40) / Merge Conflict Golem (43) | 800 / 1,330 / 2,869 | 59 / 100 / 96 | 276 / 512 / 869 | 167 / 241 / 316 | 2.7 / 3 / 4.8 |
| Dependency Jungle | Left-Pad Mite ×2 (46) / Transitive Vine (50) / Version Pin Porcupine (54) | 1,204 each / 3,556 / 6,794 | 83 / 193 / 269 | 344 / 1,126 / 1,654 | 415 / 594 / 849 | 1.5 each / 3 / 3.9 |
| Threadlock Keep | Race Condition Rat ×2 (58) / Spinlock Top (62) / Starved Thread (65) | 4,208 each / 10,041 / 16,251 | 188 / 471 / 1,206 | 1,030 / 2,308 / 3,449 | 1,210 / 1,721 / 2,239 | 1.7 each / 2.7 / 3.3 |
| Legacy Catacombs | TODO Ghost (68) / Anonymous Author (72) / Spaghetti Mummy (76) | 17,576 / 25,432 / 65,240 | 772 / 1,311 / 1,324 | 3,214 / 4,759 / 9,488 | 2,909 / 4,119 / 5,821 | 2.7 / 2.7 / 4.8 |
| Production Peaks | Flaky Test Phantom (80) / Memory Leak Slime (84) / Pager Wyvern (87) | 52,818 / 84,265 / 99,329 | 2,296 / 3,183 / 2,845 | 9,222 / 13,306 / 15,023 | 8,213 / 11,571 / 14,949 | 2.7 / 3 / 2.7 |
| Undefined Depths | Off-By-One Twin ×3 (90) / Bitflip Moth (94) / Undefined Behavior (98) | 64,969 each / 185,571 / 352,681 | 3,112 / 7,893 / 10,911 | 7,561 / 22,114 / 40,681 | 19,297 / 27,091 / 37,983 | 1.4 each / 2.7 / 3.6 |

"Main hit" is the reference Main attack only; skills hit for 1.5–10× that, which is why a mob with 5–9 Main hits of HP still dies in about 3 ticks.

---

## 6. XP curve and level cap

### 6.1 Formulas

```
K(L)    = round(22 + 8·L + 0.18·L^2.5)        on-level kills needed for level L → L+1
Need(L) = mobXP(L) · K(L)                      level cap 100
```

Gap modifier (d = L − m):

```
gap(d) = 1 + 0.05·min(5, −d)           if d < 0       (mobs above you: up to +25%)
       = 1                             if 0 ≤ d ≤ 2
       = max(0.1, 1 − 0.1·(d − 2))     if d > 2       (out-levelled maps fall to 10%)
```

### 6.2 XP per kill and other sources

```
killXP  = mobXP(m) · xpMult · (elite ? 4 : 1) · gap(L − m) · (1 + ΣXP%) · (FreshEyes ? 1.5 : 1) · shiftKill · crowding
chestXP = seals · 45 · mobXP(mapMid) · (1 + ΣXP%)                         (2.4)
bossXP  = 0.5 · Need(L) on a hero's first kill of each boss; 0.1 · Need(L) on repeats; 0.5 · Need(L) per review won
ΣXP%    = gear + party (≤ 18%) + banner (5%) + Unblocked (15%) + Rubberducker aura (≤ 15%)
          + Onboarding (50%) + herd bonus (≤ 60%: Release Train, Docs Library, Lint Meadows tracker, Legacy)
crowding= min(1, 12 / number of heroes Questing at once)
```

Swarm mobs give XP per member. A Rubberducker's own aura counts for itself.

### 6.3 Table

"Raw minutes" = minutes of on-level fighting for that one level at 15.5 kills/min with no bonuses. "Pure to here" is the cumulative raw time.

| L → L+1 | K(L) | Need(L) | Raw minutes | Pure time to reach L+1 |
|---|---|---|---|---|
| 1 | 30 | 150 | 1.9 | 1.9 min |
| 2 | 39 | 234 | 2.5 | 4.5 min |
| 4 | 60 | 600 | 3.9 | 11.5 min (Lv 5) |
| 9 | 138 | 2,898 | 8.9 | 45 min (Lv 10) |
| 11 | 182 | 4,914 | 11.7 | 1.1 h (Lv 12) |
| 19 | 457 | 30,162 | 29.5 | 3.9 h (Lv 20) |
| 29 | 1,069 | 180,661 | 69 | 12.1 h (Lv 30) |
| 39 | 2,044 | 805,336 | 132 | 29 h (Lv 40) |
| 49 | 3,439 | 2,988,491 | 222 | 59 h (Lv 50) |
| 59 | 5,307 | 9,817,950 | 342 | 106 h (Lv 60) |
| 69 | 7,693 | 29,525,734 | 496 | 177 h (Lv 70) |
| 79 | 10,639 | 83,143,785 | 686 | 277 h (Lv 80) |
| 89 | 14,185 | 222,449,170 | 915 | 412 h (Lv 90) |
| 99 | 18,367 | 571,287,168 | 1,185 | 588 h (Lv 100) |

Real heroes are much faster than "pure", because chests add about 29%, Fresh Eyes adds ×1.5 for an hour or more per day, parties add up to 18% and the herd bonus grows to +60%. Simulated working time per hero for the "typical" user (three agents in one repo, 2 h a day each, 10-minute tasks, every result seen):

| Milestone | Lv 2 | Lv 5 | Lv 10 | Lv 20 | Lv 30 | Lv 50 | Lv 60 | Lv 90 | Lv 100 |
|---|---|---|---|---|---|---|---|---|---|
| Working time | 2 min | 12 min | 42 min | 2.7 h | 7.6 h | 30 h | 49 h | 154 h | 215 h |

Calendar pacing for four personas is in section 12.

### 6.4 Level-up, skill points, cap

- Level-up: full heal, +1 skill point (from Lv 2), level-up column (cyan, never gold).
- Skill points: 99 from levels plus 1 per review won = 101, against 105 total skill ranks (7.1), so choices matter all the way.
- At Lv 100 ("maintenance mode"), every 1% of Need(99) earned becomes 1 Snippet. No XP is ever lost.

---

## 7. Skills

### 7.1 Rules

- Each class has 7 skills: Main (Lv 1, max 20), Area (Lv 5, max 15), Passive (Lv 10, max 15), Buff or Summon (Lv 20, max 15), Signature (Lv 30 and Senior Review, max 15), Ultimate (Lv 60 and Staff Review, max 15), Capstone (Lv 90, max 10). Interns have two generic skills; their points are refunded at Lv 10.
- Rank notation "`A% + B%`" means `A + B·(rank − 1)` percent of a normal hit (`coef` in 5.4). Rank r requires L ≥ unlock + (r − 1).
- **Auto-learn** (default on): each point goes, within 60 ticks, to the eligible skill with the lowest rank/max ratio; ties: Ultimate, Signature, Main, Area, Capstone, Passive, Buff.
- **Respec:** free once per 24 h while Resting, otherwise 5 × L Snippets.
- As built (round 3): auto-learn spends points only while it is on for the hero *and* for the herd (the Settings switch "Auto-learn", under the autopilot master switch). A respec, a class change or a provisional switch refunds points and re-spends them only then; with the herd's switch off, the points wait (the sheet says "Waits: auto-learn is off in Settings", turning the hero's switch on flashes "Auto-learn on, but it is off for the herd (Settings)" or "…the Autopilot is off (Settings)", and the party row shows the unspent-points star), and the next autopilot pass spends them once it is back on.
- **Rotation** (one action per tick): (1) Ultimate if ready and (boss or review, ≥ 2 arrived lane mobs, or an elite); (2) Signature proc if due; (3) Area if ready and ≥ 2 arrived lane mobs (Hotfixer's Cherry-Pick: any time); (4) Main. Buffs, summons and passive procs are free actions cast when ready while engaged.
- **Burst window** (bosses only): if a burst-check telegraph (Backtracker, Hydra) starts within 4 ticks, heroes hold their Ultimate and Buff until it starts.
- Cooldowns are in ticks; CDR applies, rounded up. Ultimates announce themselves by a 2-tick visual wind-up before they are ready (never a mechanical delay).
- Display: a skill's name floats above the hero (class colour, 1 s) only for Ultimates and Signatures. Multi-hit skills show one merged number ("×8 12.4k").

### 7.2 Intern (Lv 1–9)

| Skill | Unlock | Max | CD | Effect | Cue |
|---|---|---|---|---|---|
| Hello, World | 1 | 8 | – | Hit 100% + 3% | A tiny speech bubble `hi` flies at the mob |
| printf() | 5 | 5 | 4 | Hits up to 3 lane mobs for 70% + 3% | A burst of `%d` glyphs |

### 7.3 Refactorer (tank; long steady tasks)

| Slot | Skill | Unlock | Max | CD | Effect | Visual cue |
|---|---|---|---|---|---|---|
| Main | Extract Method | 1 | 20 | – | Hit 100% + 3% | White crescent slash (200 ms) |
| Area | Rename Symbol | 5 | 15 | 4 | Up to 3 lane mobs, 70% + 3% each | Blade whirl; letters `foo` turn into `bar` and scatter |
| Passive | Strong Typing | 10 | 15 | – | +2% max HP and +1% DR per rank | Faint `:T` glyphs on the body |
| Buff | Code Review | 20 | 15 | 30 | 10 ticks: self +10% damage; room allies take −(5% + 0.5%) damage | Magnifying-glass halo |
| Signature | Big Picture | 30 + Senior | 15 | every 6th action | Slam 200% + 8% on the target; 50% of that to every other lane mob | Blueprint grid flashes across the slot floor |
| Ultimate | The Big Rewrite | 60 + Staff | 15 | 45 | 500% + 25% to every lane mob (boss: boss and its adds) | Scaffolding rises for 2 ticks, then a 150 ms white wipe limited to the slot |
| Capstone | Clean Architecture | 90 | 10 | – | +2% damage and +1% DR per rank | Silver trim on the scarf |

### 7.4 Hotfixer (single target and crits; short tasks)

| Slot | Skill | Unlock | Max | CD | Effect | Visual cue |
|---|---|---|---|---|---|---|
| Main | Quick Patch | 1 | 20 | – | 2 stabs, each 60% + 2% (one merged number) | Two quick flashes |
| Area | Cherry-Pick | 5 | 15 | 4 | Blink to the lowest-HP lane mob: 180% + 6%; instantly finishes a non-boss below 15% HP | Cherry-shaped blink puff |
| Passive | Works On My Machine | 10 | 15 | – | +1% dodge per rank | Dodged hits show `404` |
| Buff | Stealth Commit | 20 | 15 | 30 | 5 + floor(rank/5) ticks: every hit crits; mobs cannot hit you | Sprite at 50% opacity |
| Signature | Bisect | 30 + Senior | 15 | passive | +5% damage per consecutive tick on the same target, up to 5 + floor(rank/3) stacks | Pip counter above the target |
| Ultimate | Push to Main | 60 + Staff | 15 | 40 | 8 hits of 100% + 5%, always crit | `→main` streaks |
| Capstone | Zero Downtime | 90 | 10 | – | +1% dodge and +2% crit damage per rank; each dodge heals 1% max HP | none |

### 7.5 Shellmancer (area caster; the default)

| Slot | Skill | Unlock | Max | CD | Effect | Visual cue |
|---|---|---|---|---|---|---|
| Main | Echo Bolt | 1 | 20 | – | Ranged hit 100% + 3% | `>` glyph projectile (300 ms) |
| Area | Pipe Chain | 5 | 15 | 4 | Chains through up to 4 mobs (3 + Verbose), 65% + 3% each | `\|` glyphs link the targets |
| Passive | Tab Completion | 10 | 15 | – | rank% chance per action of a free extra Echo Bolt | A ghosted second bolt |
| Buff | Sudo | 20 | 15 | 30 | 8 ticks: +(14% + 1%) damage | Tiny `#` crown |
| Signature | Cron Job | 30 + Senior | 15 | every 6th action | Cron Bolt 200% + 8% on the target, 50% splash to the lane | Clock-face projectile |
| Ultimate | Midnight Batch | 60 + Staff | 15 | 50 | 3 meteors, each hits every lane mob for 80% + 4% | Three `*` meteors; on the hero's own cooldown, never synced to the wall clock |
| Capstone | Root Access | 90 | 10 | – | +2% damage per rank; ignores 2% per rank of boss DR and shields | Green title bar |

### 7.6 Forkbinder (summoner; agents that spawn sub-agents)

| Slot | Skill | Unlock | Max | CD | Effect | Visual cue |
|---|---|---|---|---|---|---|
| Main | Spawn Process | 1 | 20 | – | Hit 85% + 2.5%, plus an imp nip for 20% (one merged number) | `&`-tailed imp nips the target |
| Area | Background Jobs | 5 | 15 | 4 | 3 imps hit up to 3 lane mobs, 65% + 3% each | Three `&` imps dart out |
| Passive | Process Pool | 10 | 15 | – | Forkling damage +1% per rank (20% → 35% of Spawn Process); +1 counted Forkling at ranks 5, 10, 15 (3 → 6) | Forklings wear tiny gear badges |
| Summon | Daemonize | 20 | 15 | permanent | A Cron Sprite hits the target every tick for 15% + 1% of Spawn Process, with or without sub-agents | Sprite; a small sparkle every 60 ticks, phase-offset per hero |
| Signature | Thundering Herd | 30 + Senior | 15 | every 6th action | All summons swarm: every lane mob takes 90% + 4.5% | Summons dash across the lane |
| Ultimate | Fork Bomb | 60 + Staff | 15 | 45 | 8 imps each hit a random lane mob for 90% + 4.5% | Imps double 1→2→4→8 over 3 frames; "Resource temporarily unavailable" fades in |
| Capstone | Supervisor Tree | 90 | 10 | – | +1% damage per rank for each active summon (Cron Sprite + counted working Forklings, max 7) | A small tree glyph over the book |

### 7.7 Rubberducker (support; agents that ask for you often)

| Slot | Skill | Unlock | Max | CD | Effect | Visual cue |
|---|---|---|---|---|---|---|
| Main | Quack | 1 | 20 | – | Sonic ring 105% + 3% | Expanding ring |
| Area | Explain It Out Loud | 5 | 15 | 4 | If a room ally (or self) is below 85% HP: heal the lowest for 8% + 0.5% max HP. Otherwise a duck wave hits 3 lane mobs for 70% + 3% | Speech squiggle, or a duck wave |
| Passive | Rubber Duck Debugging | 10 | 15 | – | Room allies (self included) +1% XP per rank (highest-ranked Rubberducker in the room only) and +0.5% damage per rank | none |
| Buff | Pair Programming | 20 | 15 | 30 | 10 ticks: self and the lowest-level room ally +(11% + 1%) damage | `{ }` brackets around the pair |
| Signature | Ducklings | 30 + Senior | 15 | passive | 1 duckling (2 from rank 8); each pecks the target every tick for 19% + 1% of Quack | Ducklings waddle behind |
| Ultimate | Retrospective | 60 + Staff | 15 | 45 | Revives crashed room allies, fully heals the room, room +(29% + 1%) damage for 15 ticks | Sticky notes flutter up |
| Capstone | Psychological Safety | 90 | 10 | – | Room allies +1% DR per rank; crashed room allies reboot 1 tick faster per 2 ranks | Soft cream aura (#FFF4D6) |

---

## 8. Gear

### 8.1 Slots

| Slot | Base stat | Notes |
|---|---|---|
| Weapon | WeaponDmg (5.3) | Class-typed (Blades, Patch Knives, Pipes, Manpages, Ducks). Drawn on the sprite (shape per class, metal tone per tier). |
| Hat | Armor ×1.0 | Drawn on the sprite (5 tier shapes: beanie, headphones, cap, helm, crown). |
| Hoodie | Armor ×2.0 | Body tint on the sprite. |
| Mug | Armor ×0.8, coffee heals +2% × t | Off-hand. |
| Boots | Armor ×0.7 | |
| Sticker | none | Accessory: one extra affix instead of a base stat. |

Item level `i`, tier `t = clamp(ceil(i/20), 1, 5)`, required level `max(1, i − 3)`. The base name comes from slot (or weapon type) and tier (table in 14.7).

### 8.2 Rarities

| # | Rarity | Colour (loot glow only) | R | Affixes | Max polish | Deprecate: Snippets × t | Kill weight | Chest weight |
|---|---|---|---|---|---|---|---|---|
| 0 | Prototype | #A0A4AB | 1.00 | 0 | +3 | 2 | 64 | 35 |
| 1 | Alpha | #5BD16A | 1.10 | 1 | +5 | 4 | 26 | 40 |
| 2 | Beta | #4EA3FF | 1.22 | 2 | +7 | 8 | 8 | 19 |
| 3 | Release | #B36BFF | 1.36 | 3 | +9 | 20 | 1.9 | 5.2 |
| 4 | LTS | #FF9A2E | 1.52 | 3 + 1 LTS property | +10 | 40 | 0.1 | 0.8 |
| 5 | Keepsake (boss unique) | #FF7AA8 | 1.70 | 3 + 1 unique property | +12 | cannot be deprecated | – | – |

Item find multiplies the Beta, Release and LTS weights by (1 + IF), IF capped at +150%. Elites double those weights again. Stickers get +1 affix. An item never rolls the same affix twice. Gold (#FFD447) is never a rarity colour: it is reserved for "done".

### 8.3 Affix pool

`value = (lo + (hi − lo) · roll/99) · t`, roll stored as 0–99, rounded to 0.1. Prefixes and suffixes share one pool; an item rolls from the affixes allowed in its slot.

| Id | Name | Kind | Effect per tier t | Slots | Cap |
|---|---|---|---|---|---|
| memo | Memoized | prefix | +2–4 % damage | weapon, hat, mug, sticker | – |
| lint | Linted | prefix | +1–2 % crit chance | weapon, hat, sticker | crit 50% |
| opt | Optimized | prefix | +5–10 % crit damage | weapon, sticker | – |
| async | Async | prefix | +0.5–1 % extra-action chance | weapon, boots, sticker | 15% |
| typed | Typed | prefix | +4–8 % armor | hat, hoodie, mug, boots | – |
| robust | Robust | prefix | +3–6 % max HP | hat, hoodie, mug, sticker | – |
| recur | Recursive | prefix | +1–2 % chance a hit repeats at 50% | weapon | – |
| vec | Vectorized | prefix | +3–6 % area damage | weapon, hat, sticker | – |
| blame | Blameless | prefix | +3–6 % boss damage | weapon, sticker | – |
| green | of the Green Build | suffix | +1–2 % XP | hat, sticker | – |
| cache | of Caching | suffix | +3–6 % gold | boots, mug, sticker | – |
| tab | of Tab Completion | suffix | +2–4 % item find | boots, sticker | IF 150% |
| uptime | of Uptime | suffix | +0.05–0.1 % max HP regen per tick | hoodie, mug, sticker | – |
| idem | of Idempotence | suffix | −1–2 % damage taken | hoodie, boots | – |
| hot | of Hot Reload | suffix | −2–4 % cooldowns | hat, mug, sticker | CDR 40% |
| grace | of Graceful Degradation | suffix | +4–8 % damage while below 50% HP | weapon, hoodie | – |
| rate | of Rate Limiting | suffix | +0.5–1 % dodge | hoodie, boots | dodge 30% |

**Names:** Alpha "Memoized Pipe Wand" or "Pipe Wand of Caching"; Beta and Release "[first prefix] Base [of first suffix]" (if there is no suffix, the strongest prefix only); LTS "[Property] Base" ("Feature-Flagged Zip Hoodie"); Keepsakes have fixed names; polish adds "+N".

### 8.4 LTS properties (one per LTS item, fixed values)

| Id | Property | Slot | Effect |
|---|---|---|---|
| tenx | Ten-X Keys | weapon | Every 10th action deals ×10 damage (a "10x" pops) |
| flag | Feature-Flagged | any | Every 60 ticks switches between +25% damage and +25% armor |
| rollback | Rollback | any | A lethal hit leaves you at 60% HP instead; once per 120 ticks |
| scroll | Infinite Scroll | weapon | The Main attack also hits the next lane mob for 50% |
| reload | Hot-Reloading | any | 15% chance a skill does not go on cooldown |
| gc | Garbage-Collected | hoodie | Each kill heals 2% max HP |
| semi | Optional Semicolon | sticker | Crits have a 25% chance to strike again |
| mug | Bottomless | mug | Coffee is free and refills 1 cup per 10 ticks even while Questing |
| pockets | Infinite-Pocket | hoodie | +20% item find |
| stamp | Rubber-Stamped | sticker | Unblocked lasts 60 ticks longer |

### 8.5 Keepsakes (boss uniques; account-wide stash; never deprecated)

| Boss | Keepsake | Slot | Unique property |
|---|---|---|---|
| The Ignored Warning | Hazard Cone Hat | Hat | +5% crit chance, +5% XP |
| The Pyramid of Doom | Curly Brace Crown | Hat | +1 rank to Main and Area (can exceed max) |
| The Catastrophic Backtracker | Lazy Quantifier Boots | Boots | −12% cooldowns |
| The Octopus Merge | Octo-Hoodie | Hoodie | Area skills hit +1 target |
| Bloatodon | Lockfile Mug | Mug | +15% max HP; coffee heals +10% |
| The Deadlock Hydra | Mutex Twinfang | Weapon (takes the wearer's weapon type) | +25% boss damage |
| The Monolith | Microservice Badge | Sticker | +4% damage per other hero in the room (max +16%) |
| The Friday Deploy | Weekend Pass | Sticker | +50% Fresh Eyes build-up; +10% damage while Fresh Eyes is active |
| The Heisenbug | Uncertainty Lens | Hat | Each hit has a 12% chance to count twice |

### 8.6 Drop sources

| Source | Item chance | Rarity weights | Item level | Other |
|---|---|---|---|---|
| Normal kill | 0.4% × (1 + IF) × shiftKill | kill weights | m + U{0,1} | gold(m) × goldMult × (1 + Gold%); 3% chance of t Snippets |
| Smelly elite (1 in 80 spawns) | 20% | kill weights, Beta+ ×2 | m + U{0,1} | 4 × gold; 25% chance of 3t Snippets |
| Commit Chest | items = Seals (2.4) | chest weights (+ tier guarantee) | map top + U{0,1,2} | gold, chest XP, Seals |
| Unreviewed chest | floor(rawSeals / 2) | chest weights | as chest | half gold and XP, no Seals |
| Holo Rubber Duck (1 in 20,000 spawns) | Duck Chest: 1 item | Beta 45 / Release 40 / LTS 15 | m + 2 | 10 × gold(m), 5t Snippets |
| Boss, herd's first kill | Keepsake (to the stash) + 1 item per participant | Release 70 / LTS 30 | boss level | 60 × gold(Lb), 10t Snippets each |
| Boss, repeat kill | 1 item per participant; Keepsake 15% | Beta 50 / Release 40 / LTS 10 | boss level | 30 × gold(Lb), 5t Snippets each |
| Senior / Staff Review | class weapon / Sticker | Release | L | – |

Slot odds: Weapon 20, Hat 16, Hoodie 16, Mug 16, Boots 16, Sticker 16. A weapon matches the finder's class 70% of the time; other weapons wait in the stash for a hero of that class.

Expected per working hour per hero (no item find): about 12 items (chests 6, kills 3.7, elites 2.3), of which about 2.3 Beta or better, 0.47 Release, and one LTS per about 18 working hours. Half of all gear, and most of the good gear, comes from Commit Chests.

### 8.7 Item Power and autopilot equip

- **Item Power** (tooltip number): `IP = round(10 · i · R · (1 + 0.05p) · (1 + 0.08 · affixCount))`, with the delta against the equipped item in green or red.
- **Autopilot equip** (on every drop and every 60 ticks): `score = wD · ΔDPS_est% + wE · ΔEHP%`, where `EHP = MaxHP / (1 − DR(L)) / (1 − Dodge)` and the weights are per class (4.3). Equip if score ≥ +2%. The finder is offered the item first, then every roster hero who can use it.
- Locked items are never replaced or deprecated.

### 8.8 Stash, deprecate, upgrades

| Rule | Value |
|---|---|
| Stash ("vendor/") | Shared by the herd. 40 slots, +10 per vendor/ level, max 140. No per-hero bag. |
| Auto-deprecate | A new Prototype or Alpha item that is no upgrade for any roster hero is deprecated at once. Beta+ is kept. When the stash is full, the lowest-IP unlocked non-Keepsake item goes (logged in the journal). |
| **Deprecate** (salvage) | Snippets = yield(rarity) × t (8.2), plus 2 × gold(i). |
| **Polish** (upgrade, +1 level) | Always succeeds. +5% to the item's base stat per level, up to the rarity's max. Cost: gold `round(100 · g(i) · (p+1)^1.6 · (1 − 0.04 · CI Forge level))`, Snippets `(p+1) · t`. Example: a Beta at iLvl 50 from +0 to +7 costs about 198k gold and 84 Snippets, about 20 minutes of a Lv 50 hero's gold. |
| **Port polish** | When an equipped item is replaced in the same slot, floor(old polish / 2) levels move to the new item, free, up to its max. Upgrading never wastes polish. |
| **Squash Merge** (CI Forge 3) | 3 unlocked items of the same rarity (Prototype, Alpha or Beta) become 1 random item of the next rarity at their average iLvl. Cost 20 × gold(i). |
| **Reroll** (CI Forge 5) | Reroll one affix (type and value) on an Alpha+ non-Keepsake item. Cost 50 × gold(i) + 10t Snippets. |
| Autopilot polish | Every 60 ticks, one equipped item of one hero (round-robin, lowest polish first) is polished if gold ≥ 5× and Snippets ≥ 2× its cost; never below a 20% gold reserve. |

---

## 9. World: the Stack

### 9.1 Structure and unlocks

- Nine zones, each a "frame" of the Stack. Zone k has base level `b = 1 + 11·(k−1)` (1, 12, 23, 34, 45, 56, 67, 78, 89), mobs from b to b+10, and a boss at level `Lb = b + 11` (12, 23, 34, 45, 56, 67, 78, 89, 100).
- Each zone has 3 maps: map 1 levels [b, b+3], map 2 [b+4, b+7], map 3 [b+8, b+10]. Mob level is uniform within the map's range.
- Spawn mix: map 1 = mob A 100%; map 2 = mob B 75%, A 25%; map 3 = mob C 75%, B 25%.
- **Herd-wide waypoints:** map 1-1 is open at start. The first 40 herd kills on a map unlock the next map of that zone (a 3 px quota bar in the room header). Every hero is placed by autopilot (5.7); a new hero starts wherever its Power Level fits.
- **Boss door** (on map 3): opens when map 3 has its 40 kills **and** the zone's Sprint meter is full.
- **Sprint meter** targets (Seals): 6, 10, 25, 45, 70, 105, 160, 215, 300. Every credited Seal goes to the frontier zone's meter, wherever the hero fights. Overflow banks, up to the next zone's target, and pours in when that zone opens. Repeat boss kills need no meter.
- The herd's **first** kill of a zone's boss unlocks the next zone's map 1.

These targets are about 70% of what a casual user (one agent, 1.5 h a day, every result seen) produces while levelling through each zone, so a real person almost never waits on the meter. An agent nobody looks at never fills it.

### 9.2 Zones

| # | Zone | Levels | Maps | Palette (sky / far / ground / accent) | Scenery | Boss (Lv) | Sprint | Bug Tracker perk per tier |
|---|---|---|---|---|---|---|---|---|
| 1 | **Lint Meadows** | 1–11 | 1-1 Squiggle Path, 1-2 Whitespace Fields, 1-3 Warning Gate | #CFEFD8 / #8FD19E / #4E8F5F / #E0605A | Soft green hills; dandelions with red squiggly stems | The Ignored Warning (12) | 6 | +2% XP |
| 2 | **Callback Caverns** | 12–22 | 2-1 Mouth of the Stack, 2-2 Nested Tunnels, 2-3 Pyramid Steps | #2B2140 / #463566 / #2E2545 / #9EE6FF | Indigo caves; stalactites shaped like `{{{`; glowing mushrooms | The Pyramid of Doom (23) | 10 | +3% gold |
| 3 | **Regex Ruins** | 23–33 | 3-1 Anchor Steps, 3-2 Quantifier Colonnade, 3-3 The Unparsed Gate | #F3DDB0 / #C99A5B / #8C6A3E / #2FB9A8 | Sandstone dusk; turquoise pillars carved `^.*$` | The Catastrophic Backtracker (34) | 25 | +1% crit |
| 4 | **Merge Marshes** | 34–44 | 4-1 Fast-Forward Ford, 4-2 Stash Bog, 4-3 Octopus Delta | #D8E3C2 / #8FA36A / #4F5E34 / #E05A5A + #5AC46A | Olive swamp; fence posts of `<<<<<<<`; two-tone diff water | The Octopus Merge (45) | 45 | +2% max HP |
| 5 | **Dependency Jungle** | 45–55 | 5-1 Lockfile Clearing, 5-2 Transitive Thicket, 5-3 The Heaviest Grove | #CDEBC0 / #4E9A5A / #24502E / #F2C14E | Vines drawn as arrow graphs; crates stamped `pkg` | Bloatodon, the Heaviest Object (56) | 70 | +3% item find |
| 6 | **Threadlock Keep** | 56–66 | 6-1 Critical Section, 6-2 Semaphore Walls, 6-3 The Twin Locks | #2A2A2E / #8A5A3B / #1F1F22 / #FFB347 | Copper clockwork castle; padlocks; sparks | The Deadlock Hydra (67) | 105 | +2% damage |
| 7 | **Legacy Catacombs** | 67–77 | 7-1 Deprecated Stairs, 7-2 Hall of Comments, 7-3 Spaghetti Vaults | #121A14 / #2C3B2E / #0D130F / #66FF99 | CRT tombstones with green text; punch-card bricks | The Monolith (78) | 160 | −2% cooldowns |
| 8 | **Production Peaks** | 78–88 | 8-1 Staging Slopes, 8-2 Canary Cliffs, 8-3 Friday Summit | #1C2236 / #3E4A6B / #151A2A / #FF5A5F | Stormy summit; cliffs of blinking server racks | The Friday Deploy (89) | 215 | +1% DR |
| 9 | **Undefined Depths** | 89–99 | 9-1 Off-By-One Steps, 9-2 Bitflip Grotto, 9-3 Observer's Edge | #1A1030 / #3A2466 / #120A22 / #C8A6FF | Void violet; glitch static; floating `NaN` motes | The Heisenbug (100) | 300 | +2% boss damage |

Zone dividers on the stage: a 2 px dark line with a tiny "frame #3" label.

### 9.3 Mobs (3 per zone)

Multipliers are final (trait effects on stats are already included); traits only add behaviour (9.4). Sprites are built from SVG primitives plus one code glyph.

| Zone | Mob | Map | Traits | HP / ATK / XP | Size | Sprite | Flavour |
|---|---|---|---|---|---|---|---|
| 1 | Typo Sprout | 1 | – | 1.0 / 1.0 / 1.0 | S | Seedling whose leaf says `teh` | Sprouts wherever fingers outrun eyes. |
| 1 | Semicolon Snail | 2 | slow | 1.3 / 1.4 / 1.2 | S | `;` shell leaving a dotted trail | Optional in some regions. |
| 1 | Unused Import | 3 | tanky | 1.6 / 0.8 / 1.4 | M | Sleeping imp hugging a crate it never opens | Imported years ago. Never called. |
| 2 | Callback Bat | 1 | fast | 0.8 / 0.6 / 0.9 | S | Boomerang-shaped wings | Will call you back. Eventually. Possibly twice. |
| 2 | Promise Wisp | 2 | pending | 1.1 / 1.0 / 1.1 | S | Cocoon with a loading spinner | Pending… pending… resolved. |
| 2 | Null Pointer Frog | 3 | clumsy 20% | 1.0 / 1.2 / 1.1 | M | Frog with a `→∅` belly | Points confidently at nothing. |
| 3 | Capture Group Goblins | 1 | swarm 2 | 0.6 / 0.7 / 0.6 each | S | Two goblins holding `(` and `)` | They travel in (pairs). |
| 3 | Backslash Bandit | 2 | phaser 20% | 0.9 / 1.1 / 1.0 | M | Masked thief with a slash-shaped cape | Always escaping. |
| 3 | Greedy Glob | 3 | leech 15% | 1.3 / 1.0 / 1.3 | M | Blob stamped `.*` swallowing pebbles | Matches everything. Including your lunch. |
| 4 | Diff Leech | 1 | leech 20% | 0.9 / 1.0 / 0.9 | S | Red-and-green striped leech | +3 −3. Mostly −. |
| 4 | Rebase Wraith | 2 | reviver 25% | 1.0 / 1.2 / 1.2 | M | Ghost trailing afterimages | Rewrites history. Says it's cleaner. |
| 4 | Merge Conflict Golem | 3 | tanky, splitter | 1.6 / 0.9 / 1.6 | L | Golem whose chest reads `<<<<<<< ======= >>>>>>>` | Two halves, both convinced they're right. |
| 5 | Left-Pad Mites | 1 | swarm 2 | 0.5 / 0.6 / 0.5 each | S | Tiny mites carrying a whole vine | Tiny. Load-bearing. |
| 5 | Transitive Vine | 2 | grower | 1.0 / 1.0 / 1.2 | M | Vine dragging crates nobody ordered | You didn't plant it. Something you planted did. |
| 5 | Version Pin Porcupine | 3 | thorns 8% | 1.3 / 1.0 / 1.3 | M | Quills tipped with `^` and `~` | Pinned to 0.3.1 forever. |
| 6 | Race Condition Rats | 1 | swarm 2, fast | 0.55 / 0.5 / 0.6 each | S | Twin rats that never arrive in the same order | The winner changes every run. |
| 6 | Spinlock Top | 2 | phaser 25% | 0.9 / 0.9 / 1.0 | M | A top that never stops spinning | Very busy. Accomplishes nothing. |
| 6 | Starved Thread | 3 | slow | 1.1 / 1.8 / 1.2 | M | Thin ghost holding a ticket number | Hasn't been scheduled since Tuesday. |
| 7 | TODO Ghost | 1 | phaser 15% | 0.9 / 0.9 / 0.9 | S | Ghost wearing a `// TODO (2011)` tag | Will be removed before launch. |
| 7 | Anonymous Author | 2 | ranged | 0.9 / 1.1 / 1.0 | M | Hooded quill with a name tag reading `unknown` | git blame shrugs. |
| 7 | Spaghetti Mummy | 3 | tanky | 1.6 / 0.8 / 1.5 | L | Wrapped in 4,000 lines of pasta | No tests. No regrets. |
| 8 | Flaky Test Phantom | 1 | phaser 20%, reviver 20% | 0.9 / 1.0 / 1.1 | M | Flickers in and out | Passes on retry. Fails in CI. |
| 8 | Memory Leak Slime | 2 | grower | 1.0 / 1.0 / 1.2 | M | A slime that keeps swelling | A little bigger every tick. Nobody restarts it. |
| 8 | Pager Wyvern | 3 | ranged, fast | 0.9 / 0.7 / 1.1 | M | Small wyvern with a buzzing beeper | Beeps at 3 AM. Every time. |
| 9 | Off-By-One Twins | 1 | swarm 3 | 0.45 / 0.6 / 0.45 each | S | "Twins". There are three of them. | There's always one more. |
| 9 | Bitflip Moth | 2 | phaser 25%, clumsy 10% (heals you) | 0.9 / 1.1 / 1.0 | S | Moth drawn to tiny cosmic-ray sparks | Sometimes it flips the wrong bit. |
| 9 | Undefined Behavior | 3 | shapeshifter | 1.2 / 1.1 / 1.4 | L | Blob that renders differently every few seconds | Legally allowed to do anything. |

**Smelly elites:** 1 in 80 spawns become "Smelly <mob>" (HP ×3, ATK ×1.5, XP ×4, gold ×4, better drops; 1.25× size, three green stink lines). The name shows on hover only.

### 9.4 Trait catalogue (shared; every trait has a visible cue)

| Trait | Rule (per tick unless stated) | Cue |
|---|---|---|
| fast | Swings every tick | Speed lines |
| slow | Swings every 3rd tick | Heavy footfalls |
| tanky | Stats only (in its multipliers) | Bigger sprite |
| swarm N | One spawn group of N members, each its own lane slot and kill | N small sprites |
| phaser p | p chance a hero hit misses (`404`) | Opacity flicker 1 → 0.6, 1.2 s loop |
| clumsy p | p chance its own swing misses (`404` on the hero side); Bitflip variant heals the hero for the amount instead (`+n`) | Stumble frame |
| pending | Invulnerable for its first 2 engaged ticks (`403`) | `…` ring |
| leech p | Heals p of the damage it deals | Red sip particles |
| reviver p | p chance, once, to revive at 40% HP when killed (counts one kill) | "retry" text |
| splitter | On death, 2 halves join the lane at 30% of its HP each, 30% XP each | A crack line; halves labelled HEAD / incoming for the Golem |
| grower | +3% max and current HP per tick alive, max +60% | Sprite visibly scales up |
| thorns p | Reflects p of melee damage taken to the attacker (ranged classes immune) | Spikes |
| ranged | Also swings from the second lane position every 3rd tick | Small projectile |
| shapeshifter | Every 5 ticks copies a random trait from this list (not swarm or splitter) | Glitch frames |

### 9.5 Boss rules (all bosses and both reviews)

| Rule | Value |
|---|---|
| HP | `bossHP = round(Bk · mobHP(Lb) · (1 + 0.75·(n − 1)))`, n = participants at the start (Bk per boss, 9.6) |
| Basic attack | `round(Ak · mobATK(Lb))` every 2 ticks at the front hero (a Refactorer if present, else the highest max HP) |
| Timer | 180 ticks (Heisenbug 240), +6 per War Room level. **It runs only while at least one participant is Questing.** |
| Enrage | At 80% of the timer: the boss's named enrage (+50% damage unless stated), red tint |
| Participants | Up to 6 Questing heroes standing in that zone (any space), highest Power Level first, plus **Answer calls** helpers: Questing heroes anywhere who already beat this boss and have PL ≥ Lb; each helper's damage is capped at refDPS(Lb + 3) per tick. |
| Status during a fight | Blocked participants **hold** (no damage dealt or taken; bubble shown in the arena). A participant that goes idle or done walks out and may rejoin. No participant Questing for 10 minutes, or the app closes: the fight is **suspended** and saved (HP, phase, timer) until a participant works in the zone again. |
| Crash | Rejoins after 10 ticks at 50% HP (faster with Psychological Safety; Retrospective revives) |
| Loss (timer or everyone crashed) | **Postmortem**, never a penalty: the boss keeps 50% of the damage dealt as **Wounds** for 48 h; the party gets **Lessons Learned** +10% boss damage per failed attempt (max +50%, clears on the kill). Retry after 10 more working minutes in the zone. Patient players always win. |
| Win estimate | `E = Σ min(DPS_est_i · (1 + Boss%_i), cap_i) · (1 + Lessons) · 0.85 · timer · mech / (bossHP(n) − Wounds)`, where `mech` is the boss's mechanic factor (9.6). Labels on the boss card: **Favored** ≥ 1.2, **Even** 0.95–1.2, **Risky** < 0.95. |
| Autopilot | Challenges when the door is open and E ≥ 1.0 (setting "Auto-boss", default on). |
| Manual | **Challenge** any time the door is open and a hero is Questing in the zone; **Retreat** ends the attempt as a Postmortem. |
| Repeat kills | Beaten bosses can be fought again from their arena; per hero, once per 3 working hours per boss; autopilot farms them when E ≥ 1.5 ("Farm bosses", default on). |
| Rewards | 8.6 drops; boss XP 6.2; herd's first kill: next zone, trophy (+1% damage and max HP for everyone), Keepsake, "FIXED" stamp |

As built (round 3), suspended fights: only progress may displace a paused repeat (farm) fight: the frontier boss, or a Backlog boss floor (9.8) whose estimate reaches the autopilot threshold; the farm fight closes as a Postmortem and keeps its Wounds. A paused frontier or Backlog fight still waits. A hero who leaves the roster (retired, or let go to make room for a new hire) leaves a paused fight too; the boss keeps the HP pool it was given, and a paused fight nobody is left in closes as a Postmortem instead of waiting for a participant who never comes back. Contractors are never saved, so a restart or reload drops them from a paused fight; they rejoin it by standing in its zone. Autopilot's thresholds are 0.9 (`T.boss.autoAt`) for the frontier boss and the reviews and 1.5 for farming (docs/BALANCE.md §7).

Simulated with the reference kit and 20 coffees per hero (generic mechanic overhead: 12% invulnerable time, a 20% max-HP area hit every 25 ticks):

| Fight | Solo, on level | Solo, 2 levels under | Solo, 3 under | Trio (tank, caster, support), on level | Trio, 5 under |
|---|---|---|---|---|---|
| Zone 3 boss (Lv 34) and later | wins in 80–140 ticks, 4–10 cups | wins in 90–175 ticks, 6–15 cups | Hotfixer, Shellmancer, Rubberducker win; Refactorer and Forkbinder lose the first attempt, win the next (Wounds) | ~96–113 ticks, 1–2 cups each | ~156–160 ticks, 3–6 cups each |
| The Ignored Warning (Lv 12), Intern at Lv 9–12 | 66–93 ticks, 1–4 cups | | | | |
| The Heisenbug (Lv 100) | Hotfixer 86, Shellmancer 136 ticks | Shellmancer 168 | Shellmancer 182 of 240 | ~120 ticks | |

### 9.6 Bosses

**1. The Ignored Warning** (Lv 12, Lint Meadows; Bk 16, Ak 1.0, mech 0.85). HP 1,024 solo, 2,560 for three; swing 7.
- *Look:* a giant amber triangle with `999+` printed where an exclamation mark would be, a monocle, a cape of tiny triangles.
- *Phase 1 (100–50%):* every 20 ticks "+1 warning": a Warning Mite joins (HP mobHP(12), swing 0.5×), at most 3 alive; each living mite gives the boss +10% damage. The number on its face ticks up.
- *Phase 2 (< 50%):* "Promoted to Error": it turns red and bursts into 4 Warning Mites; it is invulnerable (`403`) while 2 or more mites live, then hits 30% harder.
- *Enrage:* "Treat warnings as errors".
- *Flavour:* "Yellow since the first commit. Everyone scrolls past it." Keepsake: Hazard Cone Hat.

**2. The Pyramid of Doom** (Lv 23, Callback Caverns; Bk 28, Ak 1.3, mech 0.85). HP 6,356 / 15,890; swing 25.
- *Look:* a stepped pyramid of nested braces `{ { { } } }` with one eye per layer.
- *Layers:* HP is 3 layers of a third each; overkill on a layer is wasted. Each layer break starts an **await**: 6 ticks invulnerable (`403`) while 3 Callback Bats join (HP mobHP(23) each). When the await ends, **resolve()** hits every hero for 20% max HP, only 5% if all bats are dead. The final layer hits 30% harder.
- *Enrage:* "Callback hell".
- *Flavour:* "Indented 47 levels deep. The base case is a rumor." Keepsake: Curly Brace Crown.

**3. The Catastrophic Backtracker** (Lv 34, Regex Ruins; Bk 32, Ak 1.6, mech 0.8). HP 23,200 / 58,000; swing 80.
- *Look:* a long serpent of `.*.*.*` tokens coiled into a loop.
- *Backtrack:* every 25 ticks it telegraphs "Trying again…" for 5 ticks; a speech bubble shows an ever-longer pattern `(a+)+$`. If the party deals at least 5% of the boss's max HP during the telegraph, it is **Anchored**: stunned 3 ticks and +20% damage taken. Otherwise it heals 50% of the damage it took in the previous 15 ticks. Heroes use the burst-window rule (7.1).
- *Below 30%:* "Exponential": telegraph every 18 ticks.
- *Enrage:* "Timeout exceeded".
- *Flavour:* "One step forward, 2^n steps back." Keepsake: Lazy Quantifier Boots.

**4. The Octopus Merge** (Lv 45, Merge Marshes; body Bk 24, Ak 1.6, mech 0.75). Body HP 52,392 / 130,980, plus 8 tentacles of 5% of body HP each; swing 203.
- *Look:* a plum-coloured octopus whose tentacles are labelled `feat/ fix/ wip/ docs/ test/ chore/ hotfix/ refactor/`.
- *Merging:* while 4 or more tentacles live, the body takes −75% ("Merging… 6 branches left"). A cut tentacle regrows after 20 ticks (12 once the body is below 40%: "Fast-forward"). Each tentacle slaps a random hero every 4 ticks for 0.3 × swing. Single-target hits go to the lowest-HP tentacle while the body is shielded; area hits strike tentacles and body.
- *Enrage:* "Merge queue full".
- *Flavour:* "Merges eight branches at once. All of them are wrong." Keepsake: Octo-Hoodie.

**5. Bloatodon, the Heaviest Object** (Lv 56, Dependency Jungle; Bk 30, Ak 1.6, mech 0.8). HP 189,780 / 474,450; swing 509.
- *Look:* a whale-sized crate stamped `pkg`, stuffed with smaller crates, on tiny legs.
- *Install:* every 12 ticks it installs a dependency: +4% max HP and a 4% heal; a counter reads "+n deps". Every 30 ticks 3 Left-Pad Mites join (HP 0.5 × mobHP(56)); each living mite gives it +5% DR (max 20%).
- *Enrage:* at 10 deps or 80% of the timer, whichever is first: "Install complete" (+50% damage).
- *Flavour:* "Pulled in by a one-line helper. Now outweighs the sun." Keepsake: Lockfile Mug.

**6. The Deadlock Hydra** (Lv 67, Threadlock Keep; Bk 32, Ak 1.6, mech 0.85). HP 569,536 / 1,423,840, split evenly between the heads **Mutex** and **Semaphore**; bite 758 per head.
- *Look:* a two-headed copper hydra; each head clutches the key the other wants.
- *Lock Contention:* single-target hits go to the head with the higher HP%; area hits both. If the heads differ by more than 10 points, the lower head is Waiting (`403`) until the gap is 5 or less.
- *Deadlock:* every 40 ticks a 3-tick telegraph. If the heads are within 5 points, it is **Resolved**: stunned 4 ticks, +25% damage taken. Otherwise every participant waits 3 ticks (`…` bubbles, never `!`).
- *Attacks:* each head bites every 3 ticks for 0.6 × swing (no other basic attack).
- *Enrage:* "Starvation": bites every 2 ticks.
- *Flavour:* "Each head is waiting for the other to let go." Keepsake: Mutex Twinfang.

**7. The Monolith** (Lv 78, Legacy Catacombs; Bk 32, Ak 1.6, mech 0.75). HP 1,565,888 / 3,914,720 (one pool); swing 3,120.
- *Look:* a towering grey slab with blinking LEDs that cracks into glowing cubes.
- *Phase 1 (100–60%):* "Tightly Coupled": −25% damage from single-target hits. Instead of a basic attack, Slam every 4 ticks hits every hero for 0.8 × swing.
- *Phase 2 (60%):* "Decompose": splits into 6 Microservices sharing the remaining pool. **Service Mesh:** each living microservice heals every other one by 0.25% of its max HP per tick, so area damage wins the race. Each attacks a random hero every 5 ticks for 0.5 × swing. Single-target hits go to the lowest-HP microservice.
- *Phase 3 (one left):* "Distributed Monolith": +100% damage, attacks every 2 ticks.
- *Enrage:* "Big-bang release".
- *Flavour:* "Split into six services. Still deploys as one." Keepsake: Microservice Badge.

**8. The Friday Deploy** (Lv 89, Production Peaks; Bk 32, Ak 1.6, mech 0.85). HP 4,224,896 / 10,562,240; swing 7,651.
- *Look:* a midnight-blue dragon in a tiny party hat, a pager on its collar, its tail a flaming progress bar stuck at 99%.
- *The Clock:* a clock above it runs from 4:55 to 5:00 PM over 30 ticks; at 5:00 **Outage Breath** hits every hero for 30% max HP (DR counts at half value) and the clock resets.
- *66–33%:* "4:59 PM": every 25 ticks 2 Pager Wyverns join (HP mobHP(89)); each living wyvern runs the clock 25% faster.
- *Below 33%:* "Long Weekend": the clock is 20 ticks long, and the party gains "Ship It" (+25% damage).
- *Enrage:* "The weekend is ruined": Outage Breath 45%.
- Badge **Read-Only Friday** when beaten on a real (local) Friday.
- *Flavour:* "Arrives at 4:55 PM on a Friday. Never alone." Keepsake: Weekend Pass.

**9. The Heisenbug** (Lv 100, Undefined Depths; Bk 40, Ak 1.6, mech 0.85, timer 240). HP 14,025,760 / 35,064,400; swing 18,656.
- *Look:* a translucent moth-like bug with a dotted outline that never quite holds still.
- *Uncertainty:* every 20 ticks it teleports and swaps state: **Position** (sharp sprite: single-target ×1.5, area ×0.5) or **Momentum** (motion-blurred: area ×1.5, single-target ×0.5).
- *Wavefunction:* every 30 ticks a pulse hits every hero for 15% max HP.
- *Observer effect (cosmetic plus a small bonus only):* while any participant's terminal is focused, it shimmers, an eye icon appears, and its next teleport is delayed 5 ticks ("pinned down"). Looking never hurts, and autopilot never counts on it.
- *Enrage:* "Cannot reproduce": teleports every 10 ticks.
- *Flavour:* "Only reproduces when nobody is looking. Looking helps a little." Keepsake: Uncertainty Lens.

### 9.7 The Holo Rubber Duck

1 in 20,000 spawns anywhere (about once per 21 working hours per hero). An iridescent sticker-sheen duck (never gold). HP 4 × mobHP(m); it never attacks and waddles off the right edge 20 ticks after arriving. Killing it drops a Duck Chest (8.6). It is the one rare "oh" moment that needs no input. Badge: Lucky Duck.

### 9.8 Postgame: The Backlog

Unlocks after the Heisenbug. Endless floors f = 1, 2, 3…: mobs from all 27 kinds with a "v2" tint, level 100 formulas with HP × 1.06^f, ATK × 1.05^f, XP × 1.03^f, no gap penalty. 50 herd kills clear a floor. Every 10th floor is a boss floor: boss `((f/10) − 1) mod 9` at level 100 with the floor multipliers ("The Friday Deploy v2: Holiday Freeze Edition"). Loot item level `100 + floor(f/2)`. A Lv 100 hero enters automatically at the deepest floor whose effective level (`100 + ln(1.06^f)/ln(1.07)`) is ≤ PL + 1. No leaderboards. As built: a boss floor displaces a paused repeat (farm) fight (9.5 as built), so the Backlog never waits on a beaten boss's zone.

---

## 10. Account-wide systems (the Herd)

### 10.1 Shared

The account is **the Herd** (renamable). Gold, Snippets, the stash ("vendor/"), building levels, the Sprint meters, map waypoints, the Bug Tracker, trophies, badges and the Hall of Fame are shared. Each hero keeps its own level, class, skills, equipment, coffee, Fresh Eyes pool and Daily Shift.

### 10.2 Localhost (the hub, shown in the Herd panel and the empty-state stage)

Cost of level n = `base · 3^(n−1)` gold. Autopilot buys the cheapest affordable upgrade when gold ≥ 3 × its cost and never drops below a 20% reserve.

| Building | Effect per level | Max | Base | Level 10 cost |
|---|---|---|---|---|
| Campfire | Fresh Eyes cap +15 min (60 → 210) | 10 | 800 | 15.7M |
| Coffee Machine | Coffee heals +3%; coffee price −5% | 10 | 800 | 15.7M |
| CI Forge | Polish gold −4%; level 3 unlocks Squash Merge, level 5 Reroll | 10 | 1,200 | 23.6M |
| vendor/ | +10 stash slots (40 → 140). Tooltip: "Heavier than it looks." | 10 | 1,000 | 19.7M |
| Docs Library | +2% herd XP | 10 | 1,500 | 29.5M |
| War Room | Boss and review timers +6 ticks | 5 | 3,000 | 243k (level 5) |

Gold income for scale (kills plus chests, about `1,050 × gold(L)` per working hour per hero): ~20k at Lv 10, ~140k at Lv 30, ~600k at Lv 50, ~2.2M at Lv 70, ~13M at Lv 100.

### 10.3 Release Train (account version)

Cumulative credited Seals set the herd's version: release r needs `round(8 · r^1.35)` Seals, shown as `v{floor(r/10)}.{r mod 10}`. Each release gives +0.5% XP and gold, up to r = 60 (+30%). Milestones: v0.1 = 8, v1.0 = 179, v2.0 = 457, v3.0 = 789, v4.0 = 1,164, v5.0 = 1,573, v6.0 = 2,012 Seals. A typical three-agent user (about 36 Seals a day) ships v1.0 on day 5 and v6.0 around day 56. Each major version unlocks a cosmetic title-bar pattern.

### 10.4 Herd XP bonus

`herd = Release Train (≤ 30%) + Docs Library (≤ 20%) + Lint Meadows tracker perk (≤ 6%) + Legacy (≤ 10%)`, **capped at +60%**. Onboarding (+50% for heroes 10+ levels behind) is separate.

### 10.5 Bug Tracker (bestiary)

- **Zone tiers, not per-mob cards:** herd kills in a zone reach **Triaged** (500), **Reproduced** (5,000) and **Fixed** (50,000); the zone's perk (9.2) applies ×1, ×2, ×3. Elites count ×4.
- Each mob still has a cosmetic bug report: ticket number (`#4127`), doodle, kill count and its flavour line. Bosses show their first-clear date.
- Every kill sends a tiny bug icon up to the room header ("filing the report"), at most one per room per tick.
- **Trophies:** each boss's herd-first kill gives +1% damage and +1% max HP to every hero (+9% total).

### 10.6 Badges (cosmetic epithets only; none reward long hours or streaks)

Hello, World (first kill) · First Commit (first chest opened) · 404 Not Found (1,000 dodges) · Rubber Duck Whisperer (10,000 HP healed) · Pair Programmer (two guild-mates share a room for 60 working minutes) · Thundering Herd (8 heroes working at once) · Fully Staffed (all five classes) · Zero Warnings (beat The Ignored Warning) · Read-Only Friday · Works When I Don't Look (beat the Heisenbug) · Ten Thousand Typos (Lint Meadows Fixed) · Principal Engineer (Lv 100) · Deep Backlog (Backlog floor 25) · Lucky Duck (Holo Rubber Duck).

### 10.7 Hall of Fame, digest

- **Hall of Fame:** retired heroes (3.4) with name, class, level and date; Legacy bonus.
- **Since you last looked:** when the herdr window regains focus after 30 minutes or more, the Herd button gets a small dot. The Herd panel's Digest tab lists levels gained, Release-or-better drops, bosses beaten and chests waiting. Never a popup.

---

## 11. Presentation

### 11.1 Art direction and the glance grammar

**Termlings** are built from SVG parts, so tiers recolour parts instead of needing new frames: a rounded-rect body (hoodie tint), a title bar (program tint plus an 8 px program icon), a screen whose face is monospace text, two stub arms, two legs (2-frame walk), one class accessory path, one weapon path (shape per class, 5 metal tones by tier: #8B6B4A, #9AA3AD, #5FB3A8, #E8E8F0, #2E2E3A with a cyan edge) and one hat path (5 tier shapes). Mobs are glyph-built (1–3 primitives plus one code glyph) with thick 2 px outlines. Backgrounds are 3 layers per zone: sky gradient, far silhouette path, mid props, ground tile. 2× pixel snapping, `image-rendering: pixelated` for text-free parts. Monospace for numbers and nameplates. No sound.

| Face | Meaning |
|---|---|
| `>_` | working (blinking cursor mouth) |
| `>_<` | the tick it lands a crit |
| `o_o` | blocked (plus the bubble) |
| `^_^` | done |
| `-_-` | idle |
| `:(` | crashed |

| You see | It means | Reserved |
|---|---|---|
| White `!` speech bubble | Blocked: the agent is waiting for you. Click it to jump there. | `!` appears **nowhere else**: not on crits, banners, bosses, mobs or tutorials |
| Gold (#FFD447): chest, SHIPPED ribbon, sidebar stripe | Done, not yet seen | Gold is never a rarity, level-up or XP colour |
| Cyan (#7FE9F5) column, XP bar | XP and level-ups | |
| Green / blue / purple / orange / rose glow | Loot rarity, on loot only | |
| Red (#FF5A5F) | HP, danger, bosses | |
| Pale periwinkle (#A9B8FF) | Fresh Eyes segment of the XP bar | |
| Sidebar stripe: green #4CC38A / amber #F2A93B / gold #FFD447 / grey #8A8F98 | working / blocked / done / idle | |

**Two palettes in one window.** herdr's own chrome (tabs, the status bar, its plain pane header) keeps herdr's status colours, where red means "needs you". The game's grammar above is its own: amber `!` means waiting, red means HP, danger and bosses. The layout deliberately does not override herdr's `working`/`blocked`/`done` tokens: layout colours beat the person's own overrides and are one value for light and dark themes, and the game's amber and gold read below 3:1 on light chrome. The game's surfaces never use red for "waiting".

As built (`ui/party.js` `stripeColor`): a status mark (the sidebar stripe, a folded guild's dot, the HUD's count dots) is drawn in a step chosen for the chrome it sits on, light or dark by the chrome itself. Every step clears 3:1 against the chrome and against herdr's hover and selected tints over it, and every pair of statuses is at least 15 apart in OKLab (×100) with normal colour vision and 6 under protan/deutan simulation (the status is also in the face, the `!` chip and "N need you"). Dark chrome keeps the table's colours except blocked, which leans orange (#ED8F2F): the table's amber is only 10.8 from the gold, too close for a 3 px mark. Light chrome has no room for a light amber or gold at 3:1, so the steps part by lightness as well as hue: working #108860, blocked #863808 (deep burnt orange, the darkest; orange in hue, OKLCH 46° against the HP red's 22°), done #9D7114 (goldenrod), idle #465769 (slate); paper gives 3.3–7.2:1 and pairs 15.4–23.2. A theme whose own tints would leave a step under 3:1 gets it deepened (light) or lightened (dark) until it clears. `test/ui-chrome.test.mjs` computes all of it.

**Stillness rule:** if nothing is working, the strip is nearly still: only campfires flicker and blocked bubbles bob. Each entity has at most one looping effect. Nothing flashes faster than 1 Hz; no full-stage flash; no banner lasts more than 3 s.

### 11.2 Stage strip composition (200 px)

```
y=0    ┌ 1-3 Warning Gate ▰▰▰▱ 31/40 · Sprint 4/6 ┬ 2-2 Nested Tunnels ───────────────┐  room headers
y=18   │  far hills (drift 8 px/s while working)   │  {{{ stalactites                  │
       │        [ ! ]                               │                                   │
y=112  │  Kip>  *  sprout  snail   ┊ Rue (o_o) … …  │  Ada >_  ))) bat  bat             │
y=160  ╞═══════════════════════════════════════════╪═══════════════════════════════════╡  ground line
       │  [Kip 9]            [Rue 8  ! 2m]          │  [Ada 17]                         │  nameplates, tags
y=200  └───────────────────────────────────────────┴───────────────────────────────────┘
```

| Band | y | Contents |
|---|---|---|
| Room header | 0–18 | Map code and name (narrow slots: "CC 2-2"), 3 px quota bar on the frontier map, "Sprint 4/6" on the frontier zone's map-3 room, boss door icon when open. Bug icons arrive here. |
| Play space | 18–160 | Sky gradient; far layer (y 40–140, 50% opacity); mid props; heroes and mobs stand on y = 160. |
| Ground band | 160–200 | Nameplate pill (y 164–178): "Kip 14" with a 2 px HP line. Status tag (y 182–194): "! 2m", "Fresh Eyes 42m", "BOSS 41%", "REVIEW". |

Positions inside a slot of width w: hero at 0.24w, Forklings at 0.10–0.18w, chest at 0.36w, campfire at 0.10w (hero sits at 0.18w), lane mobs at 0.52w / 0.70w / 0.88w (two positions, 0.58w and 0.84w, if w < 180), bubble above the head (y 92–112).

### 11.3 Slots and rooms (stable layout)

1. Every live hero has one **slot**, in herdr's own order (space, then tab, then pane). Slot width `w = clamp(stageWidth / N, 150, 320)`; spare width becomes Localhost scenery at both ends.
2. **Only adding or removing an agent reflows the strip.** Status changes, focus and level-ups never change widths or order.
3. Adjacent slots of the same space in the same map merge into a **room** (one continuous background; the party). Rooms in different zones get a 2 px divider.
4. **Overflow** (`N · 150 > stageWidth`): show `C − 1` slots plus a 150 px "+n" camp chip at the right (tiny tents with status dots; hover lists them). Fold idle first, then Supervising, then working (lowest level first). Never fold blocked, done-with-chest, focused, pinned or boss participants. Re-evaluated immediately on add/remove, and at most once per 30 s on status changes, except that a newly blocked hero is promoted at once.
5. **Boss arena:** a fight inserts one arena of width 2w at the right end (the only other reflow, a few times a day). Participants walk through a 300 ms portal; their home slots show a sign "→ The Pyramid of Doom 41%". The arena closes after the FIXED stamp or the Postmortem card.
6. **Empty states:** no agents: Localhost at night fills the strip with a sign "Help wanted: start an agent to hire a hero." All idle: each slot shows its campfire; nothing else moves.

As built (`game/view/stage.js`): when the protected heroes of rule 4 alone need more room than 150 px slots give, the slots squeeze down to 90 px (heroes drawn smaller). Past that, and past **30 slots on any strip** (what the stage's element budget, 11.9 item 7, holds at its barest detail), protected heroes fold too: chest holders first, then pinned, then focused, and blocked heroes last, lowest level first. So a 4000 px stage shows 25 slots of 150 px, or up to 30 squeezed ones; a blocked hero goes to camp only when more than 30 heroes are blocked at once. The camp chip's dot keeps its status colour.

### 11.4 Sprites

| Sprite | Size (px) | Notes |
|---|---|---|
| Termling | 40 × 48 | Part rig (11.1); 2-frame walk, 2-frame attack, sit, crate-sit, hop, tip-over |
| Forkling | 20 × 24 | Same rig, no gear |
| Mob S / M / L | 28 / 40 / 56 square | 2-frame idle; elites 1.25× with 3 stink lines |
| Boss | 112 × 96 | Rises through the header band during fights; state classes for layers, tentacles, heads, clock, phases |
| Review opponent | 48 × 56 | Greyed hero rig; tall hoodie figure with a red pen |
| Commit Chest | 28 × 22 | 4 tier tints, 2-frame lid, SHIPPED ribbon 40 × 10 |
| Duck Chest, Holo Rubber Duck | 28 × 28 | |
| Campfire | 24 × 24 | 3-frame flicker (0.6 s) |
| `!` bubble | 18 × 20 | White fill, 2 px dark outline, black `!`; hit area 32 × 32 |
| Loot cube / coin | 10 × 10 / 6 × 6 | Rarity outline glow; coins brass #C89B3C |
| Boss door, portal, banner | 24 × 40, 32 × 48, 12 × 18 | |
| FIXED stamp | 80 × 28 | |
| Zone background | full slot | Sky 2-stop gradient, 2 far silhouette paths, 3 mid props, 32 × 40 ground tile |

### 11.5 Animations (loops and transitions only; data arrives at 1 Hz)

| Animation | Trigger | Spec |
|---|---|---|
| Idle bob | always (off in reduced motion) | translateY 0 → −2 px, 1.2 s, steps(2), phase-locked |
| Walk / advance | advance step | 2 sprite frames, 0.5 s loop; mid layer slides 32 px; far layer `background-position` loop at 8 px/s while the room is working |
| Mob pace | unengaged mob in a working room | translateX ±12 px, 3.2 s alternate, flip at ends, phase from mob id |
| Attack lunge / projectile | action | 250 ms lunge 6 px (melee) or 300 ms projectile (ranged) |
| Hit flash | damage taken | `filter: brightness(2)`, 100 ms |
| Death poof | mob dies | 4-frame cloud 480 ms; bug icon floats to the header in 600 ms |
| Loot arc | drop | outer translateX linear + inner translateY ease-out/ease-in, 600 ms; then rarity glow loop 1.6 s (Beta+) |
| Loot vacuum | next tick | slides to the hero and fades, 400 ms |
| Crash | HP 0 | tip over 300 ms, `:(` face, "Rebooting…" bar over 5 ticks, fade back in |
| Coffee | cup drunk | mug icon above the head, 600 ms |
| Blocked bubble | blocked ≥ 2 ticks | pop-in 200 ms, bob 3 px on a 1.4 s loop |
| Chest | task closed | drop with a bounce 700 ms, 3 sparkles on a 1.8 s loop |
| Parallax pause | slot not working | `animation-play-state: paused` with a stored `pausedAt` |

### 11.6 Tick micro-timeline (every tick reads swing, hit, number, reply)

| ms into the tick | Event |
|---|---|
| 0 | Hero lunge (250 ms) or projectile starts (300 ms) |
| 250 | Impact: mob flashes, damage number appears, poof starts if lethal |
| 500 | Mob reply: lunge or projectile toward the hero |
| 650 | Red incoming number (or `404`) |
| 0–900 | Position tweens (advance, approach) |

Delays are positive `animation-delay` values on elements emitted for that tick.

### 11.7 Damage numbers

- 11 px monospace with a 1 px dark outline. Normal: white at 70% opacity, rises 28 px and fades over 900 ms. **Crit:** 13 px warm white on a small 4-point starburst, scale pop 1 → 1.3 → 1 in 150 ms; no exclamation mark. Incoming: red 9 px, drifting down-left. Heals: green `+N`.
- HTTP jokes: `404` dodge or miss, `403` invulnerable, `409` absorbed by a shield.
- Budget: at most 2 numbers per hero per tick (priority crit > skill > basic; the rest merge into one, e.g. "×3 1.2k"), at most 6 per room and 12 per stage per tick. XP and gold are never shown as numbers: coins arc and vacuum, the XP bar moves.
- Formatting: < 1,000 exact; 1.0k–99.9k; 100k–999k; 1.00M, 10.0M, 100M; then B.

### 11.8 Big moments (3 s or less, local to the slot)

| Moment | Presentation |
|---|---|
| Level-up | 1.6 s cyan light column, "LEVEL UP" rising in pixel text, 8 sparkles; nameplate XP bar flashes cyan 600 ms; sidebar row shimmers once (800 ms) |
| Promotion | 3 s banner across the slot ("PROMOTED: Senior Refactorer"), 12 confetti squares, new lanyard or cape (as built: the banner and the confetti only; the rig shows no career tier) |
| Review | Room header becomes "REVIEW"; the opponent fades in; "who wrote this?" bubble at 50% |
| Map cleared | A small flag "2-3 cleared"; the hero walks out the right edge; the new map cross-fades in (800 ms) |
| New zone | 2 s title card at 40% opacity: "CALLBACK CAVERNS · frame #2" |
| Boss entrance (3 ticks) | Tick 0: arena dims to 45%, hazard-striped banner slides in with name and one-liner. Tick 1: boss rises 40 px → 0 over 900 ms with one 2 px shake. Tick 2: banner slides out, segmented boss HP bar fills (800 ms). Sidebar rows of participants get a red "BOSS" chip. |
| Boss mechanics | One-line mechanic text under the HP bar ("Merging… 6 branches left", "+4 deps", clock face "4:58 PM") |
| Boss defeated | "FIXED" stamp slams down (rotated −8°, scale 2 → 1 in 300 ms), 3–5 item fountain, Keepsake floats to the stash icon, arena brightens |
| Postmortem | A calm card: "Postmortem: 38% wounds kept · Lessons Learned +10% · retry in 10 working min" |
| Herd-first boss kill | The only stage-wide moment: an 18 px banner across the header band for 3 s ("The herd reached frame #3"); never covers the play space |
| LTS / Keepsake drop | 48 px orange or rose light pillar for 3 s with the rarity name; a small star on the sidebar row for 60 s |
| Commit Chest | Drop and bounce, sparkles, SHIPPED ribbon; on seen: lid flips (2 frames), items fountain 120 ms apart, "+Ship XP" rises once |
| Holo Rubber Duck | Waddles in with a soft shine; Duck Chest pops on a kill |
| New hire / log off | Monitor-on portal (scaleY 0 → 1, 300 ms) and a one-line header note ("New hire: Kip the Idempotent") / wave and closing portal |

As built (round 3): the level-up column pulses once over its 1.6 s (a loop period is a whole there-and-back; nothing on the stage flashes faster than 1 Hz) and, on short stages, starts below the header band; its "LEVEL UP" text is cyan without a plate (it can be faint over a light sky). A loot pillar's rarity name sits on a nearly opaque dark plate painted after every other effect, so a damage number never covers it. A boss's Keepsake is logged like every notable drop: its pillar stands before the boss with the rarity name "Keepsake", the item's name goes to the header note ("Keepsake: Hazard Cone Hat") and the journal, and the digest counts it.

### 11.9 Renderer contract for a 1 Hz full-window redraw

1. **Pure render:** `render(state, tickStartMs)`. Nothing animates from JavaScript and the renderer never touches the RNG.
2. **Phase-locked loops:** every looping animation gets `animation-delay: -((tickStartMs + phase(id)) mod period) ms`, so a node recreated each tick continues mid-cycle with no visible restart.
3. **One-tick effects** (≤ 900 ms: numbers, flashes, poofs) are emitted only in their tick, keyed `fx:<tick>:<n>`, and finish before the next redraw.
4. **Multi-tick one-shots** (banners, pillars, chest drops, stamps) store `startMs` in state and are re-emitted every tick until done, with `animation-delay: -(now − startMs)` and `animation-fill-mode: both`.
5. **Movement:** each entity carries `--x0` (last tick) and `--x1` (this tick), played by a 900 ms `move` keyframe. If the host keeps DOM nodes by key, `transition: transform 900ms linear` may be used instead.
6. **Frozen slots:** store `pausedAt` and use it as "now" in that slot's phase maths, plus `animation-play-state: paused`, so frozen loops stay frozen across redraws.
7. **Budget:** at most ~400 stage elements and ~150 animated ones.

As built (`ui/stage.js` `detail()`, ARCHITECTURE §6.1): each render counts its elements and animated nodes exactly, keeps 24 of each free for that tick's effects, and picks the finest of 18 detail levels (0 to 17) that fits. Status never goes: every hero (its face, status ink and opacity), nameplate with its HP line, status tag, `!` bubble, slot overlay, chest and the camp chip always render. In order, the levels drop: ground tiles, extra props, far silhouettes, the rig's title-bar dots and pin banner, two-element mob HP bars, reflow tweens and the cursor blink ("still"), all but one Forkling per hero (a blocked one is kept), the sky bands and props, all but the front mob of each lane, room-header quota and Sprint (they stay in the header's tooltip; the ground band, dusk tint and zone divider fold into the room's own colours), the rig's limbs, icon, accessory and hat (the small rig), then the one-element tiny rig (a little terminal in the hoodie colour with the face), lane mobs, crates, chest sparkles and campfire glow. The last three levels merge status into fewer elements, hiding none of it: the `!` bubble drawn as one element, the reboot bar as one, a chest's SHIPPED ribbon and "×n" as one label (it still reads over a hero standing in front of the chest); then a blocked slot that is a room of its own takes its dim into the room's colours; then each hero's Forklings fold into one "+n" counter, amber with `!` while one is blocked (a click shows that sub-agent). Effects get what is left: "Unblocked" and "+Ship XP" first, then pillars and level-ups, then the newest numbers. A level reached is held until the finer one fits with 12 elements to spare, so heroes never flip between rigs as mobs come and go. Measured (`test/view-stage.test.mjs`, the tools/qjs stress30 recipe through `main.js`): 30 or 60 heroes, with or without a boss fight, stay at or under 392 elements and 146 animated nodes (at most 136 measured) from 360 to 4000 px (before: 445 / 137 at 2800 px, 588 / 183 at 3600 px); 30 heroes keep full detail at 1600 px, lose the sky bands around 2400 px and use the small rig from about 3200 px. 60 heroes with 45 of them blocked or holding chests (30 squeezed slots) stay at or under 392 at the coarsest levels. A long day's herd, where every slot holds status at once (30 or 60 heroes, with or without a boss fight, all blocked or crashed with chests waiting, sub-agents blocked too), needs the last three levels and stays at or under 395 elements and 150 animated nodes (at most 139 measured) from 360 to 4000 px; the coarsest level before them left it at 401 to 545 elements from 2800 px. Its worst case, every one of 30 slots blocked with chests and a blocked sub-agent during a boss fight, is the 395.

### 11.10 The status cues

- **Blocked:** after 2 ticks, the white `!` bubble above the head (bobbing 3 px). The slot is filtered `saturate(0.6)`; the engaged mob and the queue line up with `…` bubbles; the Termling sits on a crate tapping its foot (2 frames, 1 s); after 120 s a clock tag counts up ("2m", "5m", up to "1h+"). Clicking the bubble or the Termling shows its terminal (2.7). On unblock the bubble pops and "Unblocked" floats once.
- **Done:** the Commit Chest drops with a bounce, sparkles, SHIPPED ribbon in the tier colour; tooltip "Shipped: <title> · 2.4 Seals · Iron chest"; the Termling hops and waves. Seen → lid opens, loot fountains, and on the next tick the Termling sits down at its campfire.
- **Idle:** campfire at the left of the slot; the slot's background shifts to a dusk tint; mobs stop pacing; "z" bubbles after 10 minutes.
- **Supervising:** the hero stands back at 60% opacity while its Forklings fight.
- **Off duty:** wave, closing portal, slot removed (a reflow, since an agent left).

### 11.11 Party sidebar (left, 240 px)

```
HERD · 6 heroes · v2.3                                   [calm]
─ herdr-app (guild) ─────────────────────────────────────────
▌ [portrait] Kip the Idempotent                     Lv 14
▌            Junior Refactorer · 2-2 Nested Tunnels
▌            HP ▬▬▬▬▬▬▭  XP ▬▬▬▬▬▭▭▭ (Fresh Eyes segment)
▌ [portrait] Rue Two-Spaces                 ! 2m    Lv 11
▌ [portrait] Ada Null-Safe                  [chest] Lv 17
  + 2 Forklings under Kip
─ Off duty (3) ▸ ─────────────────────────────────────────────
gold 48.2k · Snippets 133 · Sprint: Pyramid of Doom 7/10 · [Herd •] [Settings]
```

- **Row (44 px):** 3 px status stripe (11.1), 32 px portrait (head crop with the live face glyph and program icon corner; focused ring when focused), line 1 name and level, line 2 career title, class and map, line 3 HP bar (red, 3 px) and XP bar (cyan, 3 px, Fresh Eyes segment), right-side chip and badges (Forkling count, Unblocked spark, star for a pending choice, red BOSS chip, chest icon).
- **Click a row:** show its terminal (2.7). Click the portrait: character sheet. Off-duty rows open the sheet. A chest icon claims the chest.
- **Waiting agents never hide:** the header shows "N need you" ("! N" when narrow) while anyone is blocked; a click shows the next blocked row's terminal (repeated clicks walk through them; rows still never re-sort). A guild header with a blocked row carries a `!` badge, folded or not, and in the 44 px rail a blocked portrait carries a `!` corner badge. The waiting chip's tooltip names the task ("Waiting for you for 2m on “Bump deps”"). As built it names the most telling label herdr gives the terminal, judged by herdr's own agents-list test: the live title (status glyph stripped), else the task's last title, else a pane or tab name the person gave; never an empty title, a path, a user@host prompt, the program's own name, or a shell or interpreter name ("zsh", "node"), and when nothing tells, the line leaves the name out. The label is cut to 40 characters, as the Quest name is (2.3). The quest, shipped-chest and Forkling lines use the same test, and so do the stage's hero, Forkling and chest tooltips, the character sheet's quest line, its Bind buttons and the digest's waiting chests. The engine applies the test too: a task keeps the last telling title as its Quest name (status glyph stripped, 40 characters), so an agent that retitles itself after its program or a shell keeps the task's real name, and its chest records that name (none when the task never had one: the journal then reads "Commit").
- As built (round 3): "N need you", the group `!` and the rail `!` count pane agents (rows) only. A waiting pane-less sub-agent shows as an amber fork chip with its count on its parent's row in the wide party (its click shows the one waiting, `terminal.peek`), and gives no cue in the 44 px rail; herdr's own status bar counts only agents too, but herdr's agents list ranks a parent by its most urgent sub-agent. Whether blocked Forklings should count is left for the owner (out/VERIFY.md, round 3). On light chrome (paper, win98) the `!` chip, "N need you" and the rail badge use the light blocked step (#863808, the stripe's own colour; the rail badge is that step with a white `!`).
- **Narrow sidebars:** below about 230 px a row keeps the chips that fit (urgent first), then the level; it never runs past the edge.
- **Order:** grouped by space (guild) in herdr's own order; rows never re-sort on status changes. Off-duty heroes collapse into one group at the bottom.
- **Footer:** gold, Snippets, Release version, frontier Sprint meter, [Herd] button (digest dot), [Settings].

### 11.12 Pane header nameplate

```
[icon] Kip the Idempotent · Lv 14 Junior Refactorer │ <terminal title, unchanged, flexible> │ HP ▬▬▭ XP ▬▬▬▭ [fighting 2-2]
```

- Left: program icon, name, level, title. Click opens the character sheet.
- Centre: herdr's own terminal title stays as it is; real information always wins.
- Right: 48 px HP bar, 64 px XP bar, status chip: "fighting 2-2" (grey), "BOSS 41%" (red), "! waiting 2m" (amber), "shipped · chest ready" (gold), "resting" (grey), "supervising 2 Forklings" (grey). The agent's own state comes first: "BOSS 41%" / "REVIEW" shows only while the participant is questing or supervising; a blocked participant reads "! waiting" (it holds its seat, 9.5, and its tooltip says "holding until you answer"), a done or idle one has walked out and reads "shipped" / "resting".
- Below 360 px the header keeps the program icon, the face, herdr's terminal title (it truncates first) and the chip; the name goes, and "Lv 14" shows only while the title keeps its room. Below 200 px: the face, the chip's short form ("!", "! 2m") and the title when 48 px are left. Hover: Power Level, current quest, Fresh Eyes, Shift, buffs and the "why" tooltip.
- As built (round 3): the HP and XP bars show only when herdr's whole terminal title fits beside them, with room reserved for the longest name and a 100 px chip whatever they are, so they depend on the pane's width and title alone and a hover never toggles them; once shown they stay until the title's room falls 24 px short. In practice that needs a pane of about 650–780 px, so an even two-pane split shows no bars (the party rows and the sheet still carry them). The title has a tooltip with the full title.

### 11.13 Character sheet (overlay, 760 × 500; Esc or click outside closes)

- **Header:** portrait, name (rename), "Senior Refactorer", guild and program, Current quest, XP bar with Fresh Eyes segment, Daily Shift bar, Power Level ("34 = Lv 31 + gear 3"), buffs, the "why" tooltip, [Focus terminal], [Retire] (Lv 30+), [Rebind].
- **Gear tab:** 6-slot paper doll on the left; shared stash grid on the right (filters: usable by this hero, slot, rarity; sort by score delta). Hover shows a compare card beside the equipped item: name in rarity colour, iLvl, required level, base stat, affixes, property, IP and green/red stat deltas ("score +3.2%"). Buttons: Equip, Lock, Polish (next level, cost), Deprecate, Squash Merge, Reroll.
- **Skills tab:** a vertical career-ladder layout, skill cards (icon, rank/max, next-rank numbers, [+]), SP counter, Auto-learn toggle, Respec.
- **Stats tab:** primary and derived stats, each formula in a tooltip, DPS_est, EHP, XP breakdown.
- **Career tab:** live signature, recommended class, provisional/locked state, class picker (free before Lv 20), review status and win estimates.
- **Journal tab:** the last 30 events (quests shipped with names, levels, notable drops, bosses).
- **Map row:** Auto (default) or pin any unlocked map; boss card with win estimate label and [Challenge].

As built: the boss card sits in the Career tab after the ladder; while its zone boss fight runs or is paused it leads the tab, red-edged, with its Retreat in the card's title row (11.16), so it is in view without scrolling at 760 × 500. Its Challenge / Fight again shares the title row with the win estimate, so both stay in view when a long ladder pushes the card down (at Lv 60+ the card's name and status lines need a scroll). In the Herd panel the Bosses tab's fight banner holds the same Retreat above the boss list. A running review's line reads "81% left against <opponent>". The Skills tab's skill-point note (Intern refund, provisional class) sits under the respec rules, and the tab's left column scrolls.

As built (round 3): outside a fight the career boss card no longer needs a scroll at Lv 60+: tiers left behind drop their won review line, and a won review on the current tier takes one line. The Herd panel's Bosses tab scrolls its fighting row into view once per fight and per visit (the Retreat stays in the banner). The journal reads chests that opened Unreviewed (2.4 as built). The XP breakdown names the level gap when it binds (2.9 as built).

### 11.14 Herd panel (overlay, Localhost)

Tabs: Upgrades (buildings), Stash, Bug Tracker, Trophies and bosses (meters, Wounds, Lessons, repeat cooldowns), Roster and Hall of Fame (retire, rebind, rename), Digest, Settings.

As built: the Settings tab's "career" switch is labelled "Promotion reviews" (`auto.career`: it starts the Senior and Staff Reviews at ≥ 90%); "Auto-boss" and "Farm bosses" read their thresholds (90% and 150%) from the tuning. The Stage height row finds the stage block by its content (this mod's stage, any id, as the host's collapse does), is dimmed with "This layout has no stage" where there is none, and still resizes a hidden stage ("The stage is hidden now; it opens at this height."). The HUD switch finds its block the same way. There is no show/hide switch for the stage itself (an open decision, out/VERIFY.md round 3). The palette has one entry, "Down the Stack: Herd panel", which opens the panel on its Digest tab from any layout (`mod.open`); the character sheet and calm mode are reached from the keys, the Roster and Settings tabs and clicks.

### 11.15 Notifications, calm controls, settings

- **Notifications:** none by default. Opt-in (each off by default, at most 3 per day, never sound): "Herd-first boss kill", "LTS or Keepsake drop", "Hero reached Principal". In-stage header notes (≤ 3 s, text only, inside the header band) cover new hires, promotions, map clears and Release-or-better drops.
- **Calm mode** (one toggle, also a hotkey): no damage numbers, no banners or pillars, stage at 60% opacity; bubbles and chests stay.
- **Reduced motion** (follows the OS): no bob, pacing or parallax; each room shows one static "DPS 1.2k" text instead of numbers; celebrations become 5 s static badges.
- **Settings:** stage height 64 / 120 / 200 px (at 64 only nameplates, chests, bubbles and HP lines); damage numbers All / Crits / Off; loot glow minimum rarity; collapse the stage when nothing is working; autopilot master switch and per-system switches (auto-equip, auto-deprecate, auto-learn, auto-polish, buildings, map choice, auto-boss, farm bosses, answer calls, career); optional sound off.

As built (ARCHITECTURE §3.4, §4):
- **Notifications** are herdr toasts (`notify`), posted by the host only. Each kind is off by default. At most 3 are raised a day over all kinds: the game's day (2.9: 04:00 local, from the snapshot's clock and time zone), counted in the save, so a restart keeps the count and a clock set back a day keeps the later day's (set back further, as when a clock that ran days ahead is put right, the count starts afresh). Only live play raises one: never the first tick after the app starts or reloads (or, when herdr lists no agents at first, the tick that first sees them), an offline gap (Unreviewed chests opened while away) or a clock behind, so reopening after a night posts no burst of stale news; a person's own commands are live. A milestone is posted only once a save that holds it as taken is on disk, so a restart, a hot reload or a second window on the same save never posts it twice (at most once: one lost with a write that never finishes is not posted later), and never one older than 10 minutes. "Herd-first boss kill" is the first kill of a zone boss ("The Deadlock Hydra: FIXED" / "The herd reached frame #4, Merge Marshes."); "LTS or Keepsake drop" names the item and its finder; "Hero reached Principal" names the hero and its title. Level "success", no icon, never a sound. A click opens the Herd panel on its Digest tab (`mod.open`, which works in any layout); while a Herd panel is open the toast has no click action.
  - Round 3: a boss's Keepsake counts as a Keepsake drop. A repeat kill's Keepsake raises "LTS or Keepsake drop"; a herd-first kill's Keepsake rides on the boss toast while "Herd-first boss kill" is on ("The herd reached frame #2, Callback Caverns. Keepsake: Hazard Cone Hat."), so the kill spends one of the day's three, and raises its own toast only while the boss kind is off. Promotions to Junior, Senior and Staff raise nothing.
  - A milestone raised by a click within a second of a load or reload, before the first tick told the time zone, counts toward the local day (the host passes the time zone with every command; the engine holds such a milestone until the next tick otherwise).
  - The one way a milestone is posted twice is a rollback of the save: a cold restart that finds `save.json` garbage loads `save.bak` (13.1), which may predate the save that took it. Two windows on one save with another program deleting or garbling `save.json` within seconds of a kill can also repeat one. A hot reload never rolls back.
  - Toasts use herdr's default timeout (5 s for "success"), like herdr's own agent toasts, and herdr closes them whether or not the window is active; the Digest keeps every line. A longer timeout is an open decision (out/VERIFY.md, round 3).
- **Loot glow minimum rarity:** All (the default: every drop glows) / Alpha / Beta / Release / LTS / Keepsake. A drop below it draws neither its loot glow nor its light pillar (pillars are LTS and Keepsake only); the header note and journal line of a Release+ drop stay.
- **Collapse the stage when nothing is working** (off by default): a minute after the last questing (crashed counts: its agent still works) or supervising hero stops, the stage block is hidden (`layout.hide`); it comes back (`layout.show`) when one quests or supervises again, and when the setting is turned off. Turning it on while nothing works collapses at once. It acts on those transitions only and shows only a stage it hid itself (the save remembers that, since herdr keeps a hidden block hidden across restarts): a stage shown or hidden by hand (`ctrl-shift-g`) stays as the person left it.
  - Round 3: an app start or reload while nothing works does not collapse the stage (it is not a transition). A countdown cut short by a restart continues from its saved start (`herd.cfg.idleAt`), giving the new session at least 10 s of its own idling; a hot reload hands it over exactly. The note that this window hid the stage is per window: a save another window wrote never changes it, so two windows on one save each show only a stage they hid.
  - A stage hidden without that note (herdr's `layouts/.state/Down-the-Stack.json` left from an earlier install, a lost save) stays hidden, as hidden by hand; it comes back with `ctrl-shift-g` (keys merged) or `herdr-app do layout.show --id stage`. herdr's palette hides `layout.show`/`toggle`, and the Settings tab has no stage switch: an open decision (out/VERIFY.md, round 3).
- **Autopilot master switch:** the first row of the Autopilot column. Off stops every system; the per-system switches keep their values (they show dimmed and inactive) and apply again when it is back on.

### 11.16 Interactions (all optional; none needed to progress)

| Target | Hover | Click |
|---|---|---|
| Termling on stage | Name, class, level, HP/XP numbers, map, status duration, current quest | Show its terminal (2.7) |
| `!` bubble | – | Show its terminal (2.7) |
| Commit Chest | Tier, Seals, shipped task title | Open it (counts as seen) and show its terminal (2.7) |
| Forkling | Sub-agent title | Show that sub-agent: `pane.focus {terminal}` if it has a pane, else `terminal.peek {terminal}` (2.7) |
| Nameplate pill (stage) or pane nameplate | – | Character sheet |
| Room header | Zone, map, quota, Sprint meter | Pin or unpin the map for heroes in the room |
| Boss door / boss card | Mechanics summary, win estimate | Challenge / Retreat |
| Loot pillar (LTS / Keepsake) | – | Sheet opens on that item's compare card (as built: the column's click target lies under the scene, so its finder, a chest or a `!` bubble standing in the light keeps its own click) |
| Sidebar row / portrait / chest icon | – | Show its terminal (2.7) / sheet / claim chest |
| Herd button | – | Herd panel |

Nothing in the game ever moves keyboard focus away from a terminal.

As built (round 3): a room whose heroes are all pinned draws a cream pin before its title (left out with the stats on bare rooms when the strip is crowded), and its header tooltip reads "Pinned: this hero stays on 1-1 · click to unpin". A pinned hero's tooltip says "(pinned: click the room header to unpin)" when its whole room is pinned, else "(pinned: Auto on the Career tab's Map card unpins)", since a header click in a mixed room pins everyone; the party row's map reads "… (pinned)". When a pin holds a hero far below its level, the why line names the gap (2.9 as built).

---

## 12. Pacing and anti-exploit rules

### 12.1 Persona pacing (simulated)

Model: every formula in this document; on-level fighting at 15.5 kills per minute; chests acknowledged; Fresh Eyes from the idle part of each day; party bonus at 60% overlap for multi-agent personas; Release Train, Docs Library (a quarter of gold) and the Lint Meadows tracker for the herd bonus; Daily Shift; boss door at the zone's last map plus the Sprint meter; trophies feeding Power Level. "Day" is a calendar day of that usage; hours in brackets are working hours per hero.

| Milestone | Casual: 1 agent, 1.5 h/day, 8-min tasks | Solo: 1 agent, 3 h/day, 12-min tasks | Typical: 3 agents in one repo, 2 h/day each, 10-min tasks | Heavy: 5 agents, 5 h/day each, 15-min tasks |
|---|---|---|---|---|
| Lv 5 | day 1 (12 min) | day 1 (12 min) | day 1 (12 min) | day 1 (12 min) |
| Lv 10 (Junior, class) | day 1 (42 min) | day 1 (42 min) | day 1 (42 min) | day 1 (36 min) |
| **Boss 1: The Ignored Warning** | **day 1 (1.0 h, Lv 12)** | **day 1 (1.0 h, Lv 12)** | **day 1 (36 min, party Lv 9)** | **day 1 (36 min, party Lv 9)** |
| Lv 20 | day 2 (2.8 h) | day 2 (3.1 h) | day 2 (2.7 h) | day 1 (2.8 h) |
| Boss 2: Pyramid of Doom | day 3 | day 2 | day 2 | day 1 |
| Lv 30 (Senior Review) | day 6 (7.9 h) | day 3 (8.8 h) | day 4 (7.6 h) | day 2 (8.3 h) |
| Boss 3: Catastrophic Backtracker | day 7 | day 4 | day 5 | day 2 |
| Boss 4: Octopus Merge | day 14 | day 8 | day 10 | day 5 |
| Lv 50 | day 21 (31 h) | day 12 (36 h) | day 16 (30 h) | day 7 (35 h) |
| Boss 5: Bloatodon | day 25 | day 15 | day 18 | day 9 |
| Lv 60 (Staff Review) | day 35 (52 h) | day 20 (60 h) | day 25 (49 h) | day 12 (57 h) |
| Boss 6: Deadlock Hydra | day 42 | day 24 | day 29 | day 14 |
| Boss 7: The Monolith | day 67 | day 38 | day 46 | day 22 |
| Boss 8: The Friday Deploy | day 100 | day 55 | day 67 | day 33 |
| Lv 90 (Principal) | day 116 (173 h) | day 62 (185 h) | day 77 (154 h) | day 38 (186 h) |
| **Boss 9: The Heisenbug** | **day 146** | **day 77** | **day 98** | **day 48** |
| Lv 100, then the Backlog | day 161 (241 h) | day 85 (253 h) | day 108 (215 h) | day 52 (259 h) |

Raw (bonus-free, on-level) working time to level: Lv 5 in 11.5 min, Lv 10 in 45 min, Lv 20 in 3.9 h, Lv 30 in 12.1 h, Lv 50 in 59 h, Lv 100 in 588 h. Bonuses cut that roughly in half by the late game.

**A typical first day.** Three agents start in "herdr-app": three Interns appear in Lint Meadows as one party room. The first level-up comes inside 2 minutes; the first finished task drops a Wooden chest that opens when you glance at the terminal. Around 36 minutes in, map 1-3 is reached and the Sprint meter shows 6/6: The Ignored Warning falls to three Lv 9 Interns in about a minute. By the end of the session all three are Juniors (a long-task agent becomes a Refactorer, a chatty one a provisional Rubberducker) and Callback Caverns is open. Overnight, Fresh Eyes fills for tomorrow.

### 12.2 Bots, for comparison

- **An always-working fake agent** (never finishes, nobody looks): Lv 19 on day 1, Lv 23 on day 7, Lv 28 on day 30, Lv 33 on day 90, Lv 42 after a year. It never fills a Sprint meter, never leaves Lint Meadows, never gets chest gear, never earns Fresh Eyes. The casual real user is Lv 50 in zone 5 on day 21.
- **A toggling bot** (fake 10-minute tasks, nobody looking): identical, because its chests are never seen; after its terminal ends they open Unreviewed with no Seals.

### 12.3 Anti-exploit rules

1. **Daily Shift** per hero: kill rewards ×1 / ×0.5 / ×0.25 after 4 and 8 working hours; Seals and chest gold/XP ×1 / ×0.75 / ×0.5; chest items never reduced. Supervising counts half.
2. **Seen it:** Seals, full chest value and the Release Train only come from results a person saw (done → idle, focusing the terminal, clicking). A terminal ending is not acknowledgment; off-duty chests open Unreviewed (no Seals) after 24 h.
3. **Linear Seals:** under 1.5 minutes earns nothing; 1 Seal per 10 working minutes; cap 12 per task. Chopping work up or running long tasks earns the same per minute.
4. **Zone gating plus the gap modifier:** out-levelled maps fall to 10% XP, so progress needs bosses, and bosses need seen Seals.
5. **Fresh Eyes** accrues only while not working (never while working or blocked), only after a first credited Seal, and is capped (60–210 min).
6. **Unblocked** needs ≥ 10 s blocked and ≥ 60 s of working in the task, has a 300-tick cooldown and is flat.
7. **Forklings:** at most 3 counted (Forkbinder up to 6); their Seal credit is 0.25 per minute inside the parent's 120-minute task cap.
8. **Roster:** 30 saved heroes, 6 new per day; extra agents are unsaved Contractors. Onboarding only up to 10 levels behind the best hero.
9. **Crowding:** more than 12 heroes Questing at once multiplies kill rewards by 12/N.
10. **Flap guard:** more than 6 status changes in 60 s pauses chests and celebrations for 5 minutes; the 8 s task-close debounce; `seq` deduplication.
11. **Clock and offline:** catch-up ≤ 5 ticks per snapshot; gaps over 60 s are offline (no combat); Fresh Eyes from wall-clock time is capped at 30 days of accrual; a backwards clock freezes accrual; daily counters use the highest day seen.
12. **Determinism:** per-hero RNG state is saved, so reloading never rerolls loot or fights. Boss attempts are committed when they start.
13. **Herd XP bonus cap** +60%; Bug Tracker tiers cap at Fixed per zone; trophies once per boss.
14. **Philosophy:** this is a single-player toy. The rules keep progress tied to real, seen work; they are not adversarial anti-cheat, and nothing is ever taken away. Save tampering is not defended against (a CRC only detects corruption).

---

## 13. Save format and versioning

### 13.1 File handling

- One JSON file, compact keys, UTF-8. Written atomically (write `save.tmp`, fsync, rename); the previous file is kept as `save.bak`.
- Saved every 30 s while dirty, 2 s after a major event (level-up, boss result, Release+ drop, chest opened, promotion), and on quit.
- `crc` is CRC32 (hex) of the file with `crc` set to `""`. On mismatch or parse failure, load `save.bak` (also when `save.json` is missing); if that fails too, load whichever file's only fault is its checksum (an edited or re-encoded but intact save); only then start fresh. A file that does not load is kept aside, never overwritten: `save.broken`, then `save.broken-<ms>` for later incidents. A `save.json` that cannot be *read* (locked, invalid UTF-8) is read again before deciding, and saving resumes once it reads; a herd that started fresh meanwhile is kept as `save.unsaved-<ms>`.
- Save trouble is never silent: a read-only, not-saving or restored save shows a notice on the stage (dismissable), a band in the Herd panel (13.4), and, so it is seen with the stage hidden, an amber cue in the party sidebar's footer (a dot on the narrow rail) and in the HUD strip that opens the Herd panel.
- Not saved: terminal bindings (except `addr` for fast rebind), mob lanes, effects, render state, Contractors, mid-tick state. A boss fight in progress is saved as a suspended fight.
- As built (round 3), hot reload (herdr reloads the mod in place when its files change): the new code takes the running world over and never rolls back to the save, also when `save.json` is unreadable (it is then never written until it reads), missing (written again) or garbage another program wrote (kept aside as `save.broken`). A valid save another window wrote since is loaded instead. When `save.json` reads again after a session that could never read it, the rule above applies at once: if that session started a fresh herd, or the file is a newer version, the file is loaded and the session's world kept aside as `save.unsaved`. A save notice survives a reload. A *cold* restart that finds `save.json` garbage still falls back to `save.bak`, the one rollback left, which can repeat a notification (11.15).

### 13.2 Shape

```json
{
  "v": 1,
  "gen": 1,
  "t": 1795000000,
  "lastMs": 1795000000123,
  "tick": 8812345,
  "day": 20781,
  "crc": "9f3a1c22",
  "herd": {
    "name": "The Herd",
    "gold": 412350, "snip": 133,
    "bld": [3, 2, 1, 2, 2, 0],
    "zone": 2, "quota": [[40, 40, 31]], "meter": 7.4, "bank": 0,
    "seals": 218.6, "rel": 17,
    "boss": [1, 1, 0, 0, 0, 0, 0, 0, 0], "bossKills": [14, 3, 0, 0, 0, 0, 0, 0, 0],
    "fight": null,
    "wounds": {"2": [0.38, 1795172800]}, "lessons": {"2": 1},
    "bt": [5210, 980, 0, 0, 0, 0, 0, 0, 0],
    "badges": "AQc=",
    "stash": [[32, 24, 2, 3, [[4, 52], [12, 48]], 0, -1]],
    "fame": [["Bram Lintwick", 1, 54, 1793000000]],
    "backlog": [0, 0],
    "digestAt": 1794990000,
    "cfg": {"auto": 4095, "calm": 0, "stageH": 200, "nums": 2, "rm": 0, "notify": 0},
    "log": [[1795000000, "ship", 7, "Fix flaky auth test", 2.4]],
    "rng": 2463534242
  },
  "heroes": [{
    "id": 7, "seat": "herdr-app/claude", "sid": "spc_19", "ord": 0,
    "n": "Kip the Idempotent",
    "c": 1, "prov": 0, "L": 14, "xp": 1290, "sp": [8, 4, 1, 0, 0, 0, 0], "spFree": 0, "auto": 1,
    "rev": [0, 0],
    "eq": [[1, 13, 2, 1, [[2, 61], [15, 20]], 0, -1], [26, 12, 1, 0, [[5, 77]], 0, -1], 0, 0, 0, 0],
    "map": null, "fe": 42.5, "shift": [20781, 192], "cups": 20, "hp": 0.92,
    "sig": {"tm": [12, 8, 31, 4, 9], "bph": 0.8, "sub": 0.1, "n": 9},
    "pend": [[24.0, "Fix flaky auth test", 1794999000, 0]],
    "cd": {"unb": 1794998000, "boss": {"1": 1794990000}},
    "addr": "t7", "lp": "main", "lt": "api", "seen": 1795000000,
    "cos": {"cape": 0, "pattern": 0},
    "st": {"kills": 51234, "tasks": 312, "seals": 288.4, "wh": 41.5},
    "rng": 913775311
  }]
}
```

| Field | Meaning |
|---|---|
| `v` / `gen` | Schema version / content generation (ids in the content tables are append-only; a removed id maps to a fallback) |
| `day` | Highest local day number seen (days since 1970 at 04:00 local) |
| `herd.bld` | Building levels in 10.2 order |
| `herd.zone` / `quota` / `meter` / `bank` | Frontier zone index (0–8, 9 = Backlog), kills per map of the frontier zone, Sprint meter fill, banked overflow |
| `herd.seals` / `rel` | Cumulative credited Seals / current release r |
| `herd.fight` | Suspended fight: `{"b": bossIdx, "hp": [...], "phase": 1, "t": ticks, "ids": [heroIds]}` or null |
| `herd.bt` | Bug Tracker kills per zone |
| `herd.badges` | Base64 bitset |
| `herd.cfg` | Settings (11.15). As built also `ap` (0: autopilot master switch off), `glow` (loot glow minimum rarity 1–5), `col` (collapse the stage when nothing works), `held` (the game hid the stage and owes it a show), each written only when set |
| `herd.nf` / `herd.ms` | As built: notifications (11.15) `[local day, raised that day, last number]`, and milestones raised but not yet posted |
| item | `[baseId, iLvl, rarity 0–5, polish, [[affixId, roll 0–99], …], flags (1 lock, 2 new), propertyId or −1]` — about 35–45 bytes; affixes stored explicitly, never regenerated from a seed |
| `hero.c` / `prov` | Class index (14.1 order) / provisional flag |
| `hero.sp` | Skill ranks in slot order (Main, Area, Passive, Buff, Signature, Ultimate, Capstone) |
| `hero.rev` | Reviews won [Senior, Staff] |
| `hero.eq` | 6 items in slot order (Weapon, Hat, Hoodie, Mug, Boots, Sticker), 0 = empty |
| `hero.fe` / `shift` | Fresh Eyes minutes / [day, working minutes today] |
| `hero.sig` | Signature window: last task minutes (≤ 20), blocks per hour, sub-agent share, qualifying task count |
| `hero.pend` | Pending chests: [minutes, quest title, created, Forkling minutes] (merged beyond 20 entries). As built the title is an index into the top-level `str` table when the title is used more than once (a save from before that wrote it inline; both load) |
| `hero.rng` | xorshift32 state; one RNG per hero, plus one herd RNG for shared rolls |

### 13.3 Size budget

30 heroes × ~520 B (with 6 equipped items) ≈ 16 KB; 140 stash items × ~40 B ≈ 5.6 KB; herd block ~1.5 KB; journal capped at 60 entries ≈ 3 KB. Worst case about 26 KB; a typical herd of 6 heroes about 7 KB.

As built (docs/BALANCE.md §10): the journal keeps 120 lines up to 20 heroes and tapers to 60 at 30. Strings used more than once (seats, space ids, pane and tab names, pending-chest titles, the journal's kinds and texts) are written once in the top-level `str` table and referred to by index. Chest items waiting in `herd.inbox` are stored as compact stash rows (≈ 37 B each). Measured:
- the 30-hero worst case above (full Release/LTS gear, 140 stash items, 60 journal lines, one pending chest each): 27.3 KB (28.7 KB before titles and journal strings were interned);
- a 30-hero herd left running (`stress30`: 30 agents over three spaces, Lv 68–95, 140 stash items) for 0 / 10,000 / 20,000 / 40,000 / 80,000 s: 19.0 / 25.1 / 26.3 / 28.6 / 28.8 KB with 2 / 37 / 68 / 121 / 120 pending chests (before: 19.4 / 26.8 / 28.7 / 31.9 / 32.1 KB);
- every one of 30 heroes holding the full 20 pending chests (600, three shared titles) on that worst case: 39.2 KB (61.0 KB with titles inline; 40.2 KB in round 3's measurement, of which the pending chests are 471 B per hero). That is the one state still over the budget; nothing depends on the budget, and herdr's hard limit is 1 MiB per file. Getting under 30 KB would take a lossy or format change (chest times to the second, columnar rows), which SAVE_VERSION 1 cannot carry without an older build misreading the save.

### 13.4 Versioning and migration

- `migrations[v]` is a list of pure functions `save_v → save_v+1`, applied in order on load; a save from a newer `v` than the code knows is opened read-only with a notice in the Herd panel. As built: also when it turns up later (a `save.json` that could not be read at start reads again as a newer version): it is opened read-only, never written or rotated into `save.bak`, and the session's world is kept aside as `save.unsaved`.
- Content ids (classes, skills, mobs, bosses, affixes, bases, properties) are integers that are never reused. Rebalancing numbers needs no migration because saves store ids, rolls and levels, not derived stats.
- `gen` bumps when content tables change; on load, unknown ids map to fallbacks (an unknown affix becomes `memo` with the same roll, an unknown base becomes the slot's tier base).

---

## 14. Content tables (paste into `data.js`)

Each block is valid JSON. Array order is the integer id used in saves (`n` where shown). Percent values are written as fractions (0.03 = 3%). Skill coefficient pairs are `[base, perRankAboveOne]`.

### 14.1 Tuning constants and classes

```json
{
  "tuning": {
    "tickMs": 1000, "maxCatchUpTicks": 5, "offlineGapSec": 60, "taskCloseTicks": 8, "bubbleDelayTicks": 2,
    "g": 1.07, "weaponBase": 6, "hpBase": 60, "armorBase": 3, "drConst": 25, "drCap": 0.75,
    "mobHpFactor": [1.6, 0.62], "mobSwingPctOfRefHp": 0.03, "xpBase": [4, 1.06], "goldBase": [2, 1.05],
    "kOfL": [22, 8, 0.18, 2.5], "levelCap": 100, "refKillsPerMin": 15.5,
    "ref": {"iOffset": 2, "rarityPerL": 0.0048, "polishPerL": 0.005, "dmgPerL": 0.003,
            "might": 2.3, "grit": 1.7, "keen": 0.7, "critPerKeen": 0.0015, "critPerL": 0.0005, "hpPerL": 0.003,
            "armorK": 13.5, "armorPerL": 0.002},
    "critBase": 0.05, "critCap": 0.5, "critMult": 1.5, "dodgeCap": 0.3, "cdrCap": 0.4, "extraActCap": 0.15, "itemFindCap": 1.5,
    "regen": {"engaged": 0.005, "advance": 0.02, "resting": 0.05},
    "coffee": {"threshold": 0.45, "cooldown": 5, "heal": 0.35, "carry": 20, "refillTicks": 30, "priceGoldMult": 2},
    "crash": {"downTicks": 5, "returnHp": 0.5, "dropMapAfter": [3, 600], "dropMapForSec": 1800},
    "lane": {"size": 3, "advanceScrollPx": 48, "eliteOneIn": 80, "duckOneIn": 20000},
    "gap": {"freeAbove": 2, "lossPerLevel": 0.1, "floor": 0.1, "bonusPerLevelBelow": 0.05, "bonusCapLevels": 5},
    "seals": {"minMinutes": 1.5, "perMinute": 0.1, "capMinutes": 120, "chestGoldPerSeal": 20, "chestXpPerSeal": 45,
              "mergeWindowSec": 300, "unreviewedAfterSec": 86400, "forklingMinuteCredit": 0.25},
    "shift": {"resetHourLocal": 4, "bandsMin": [240, 480], "kill": [1, 0.5, 0.25], "seal": [1, 0.75, 0.5]},
    "freshEyes": {"accruePerMin": 0.25, "capBaseMin": 60, "capPerCampfire": 15, "xpMult": 1.5},
    "unblocked": {"minBlockedSec": 10, "minTaskSec": 60, "ticks": 120, "dmg": 0.15, "xp": 0.15, "cooldownTicks": 300},
    "party": {"perMember": 0.06, "cap": 0.18, "banner": 0.05},
    "herdXpCap": 0.6, "onboarding": {"xp": 0.5, "levelsBehind": 10}, "crowdingAt": 12,
    "roster": {"max": 30, "newPerDay": 6, "contractorLevelsBelowMedian": 5},
    "forkling": {"pctOfMain": 0.12, "counted": 3},
    "flap": {"changes": 6, "windowSec": 60, "suppressSec": 300},
    "boss": {"partyHpPerExtra": 0.75, "swingEvery": 2, "timer": 180, "enrageAt": 0.8, "enrageDmg": 0.5, "warRoomTicks": 6,
             "maxParticipants": 6, "woundsKeep": 0.5, "woundsSec": 172800, "lessonsPerFail": 0.1, "lessonsCap": 0.5,
             "retryWorkingSec": 600, "suspendAfterSec": 600, "estimateMargin": 0.85, "autoAt": 1.0, "farmAt": 1.5,
             "repeatCooldownWorkingSec": 10800, "helperCapLevels": 3, "crashRejoinTicks": 10},
    "release": {"seals": [8, 1.35], "bonusPer": 0.005, "maxRelease": 60},
    "sprint": [6, 10, 25, 45, 70, 105, 160, 215, 300],
    "quotaPerMap": 40,
    "buildingCostGrowth": 3, "buildingAutoBuyAt": 3, "goldReserve": 0.2,
    "polish": {"goldBase": 100, "exp": 1.6, "forgeDiscount": 0.04, "perLevel": 0.05, "portShare": 0.5},
    "skills": {"rankGate": 1, "respecSnippetsPerLevel": 5, "careerChangeSnippetsPerLevel": 25, "classFreeUntilLevel": 20, "classLockTasks": 15},
    "fx": {"numbersPerHero": 2, "numbersPerRoom": 6, "numbersPerStage": 12, "bannerMaxMs": 3000}
  },
  "classes": [
    {"n": 0, "id": "intern", "name": "Intern", "role": "starter", "weapon": "stick",
     "growth": {"might": 2.3, "grit": 1.7, "keen": 0.5, "luck": 0.5}, "innate": null,
     "weights": {"dps": 0.6, "ehp": 0.4}, "silhouette": "Lanyard with a blank badge"},
    {"n": 1, "id": "refactorer", "name": "Refactorer", "role": "tank", "weapon": "blade",
     "growth": {"might": 2.2, "grit": 2.3, "keen": 0.5, "luck": 0.0},
     "innate": {"id": "clean_hands", "name": "Clean Hands", "hpPct": 0.10, "bossFront": true},
     "signature": {"rule": "medianTaskMin", "op": ">=", "value": 15, "priority": 3},
     "weights": {"dps": 0.45, "ehp": 0.55}, "silhouette": "Broad keycap body, scarf, big blade"},
    {"n": 2, "id": "hotfixer", "name": "Hotfixer", "role": "single target", "weapon": "knives",
     "growth": {"might": 2.4, "grit": 1.0, "keen": 1.6, "luck": 0.0},
     "innate": {"id": "hot_hands", "name": "Hot Hands", "crit": 0.05, "critMult": 1.6},
     "signature": {"rule": "medianTaskMin", "op": "<=", "value": 5, "priority": 4},
     "weights": {"dps": 0.7, "ehp": 0.3}, "silhouette": "Headlamp, hoodie, two knives"},
    {"n": 3, "id": "shellmancer", "name": "Shellmancer", "role": "area caster", "weapon": "pipe",
     "growth": {"might": 2.6, "grit": 1.4, "keen": 0.5, "luck": 0.5},
     "innate": {"id": "verbose", "name": "Verbose", "areaTargets": 1},
     "signature": {"rule": "default", "priority": 5},
     "weights": {"dps": 0.7, "ehp": 0.3}, "silhouette": "Pointy hood with a blinking cursor at the tip"},
    {"n": 4, "id": "forkbinder", "name": "Forkbinder", "role": "summoner", "weapon": "manpage",
     "growth": {"might": 2.2, "grit": 1.6, "keen": 0.6, "luck": 0.6},
     "innate": {"id": "parent_process", "name": "Parent Process", "forklingPct": 0.20},
     "signature": {"rule": "subAgentShare", "op": ">=", "value": 0.25, "priority": 1},
     "weights": {"dps": 0.65, "ehp": 0.35}, "silhouette": "Floating open book with orbiting dots"},
    {"n": 5, "id": "rubberducker", "name": "Rubberducker", "role": "support", "weapon": "duck",
     "growth": {"might": 2.0, "grit": 2.0, "keen": 0.5, "luck": 0.5},
     "innate": {"id": "good_listener", "name": "Good Listener", "roomUnblockedMult": 2},
     "signature": {"rule": "blocksPerWorkingHour", "op": ">=", "value": 2.0, "priority": 2},
     "weights": {"dps": 0.5, "ehp": 0.5}, "silhouette": "Ochre raincoat (#C08A3E), duck on a staff"}
  ],
  "careers": [
    {"title": "Intern", "from": 1, "to": 9, "gate": null},
    {"title": "Junior", "from": 10, "to": 29, "gate": "level"},
    {"title": "Senior", "from": 30, "to": 59, "gate": "seniorReview", "unlockSlot": "sig"},
    {"title": "Staff", "from": 60, "to": 89, "gate": "staffReview", "unlockSlot": "ult"},
    {"title": "Principal", "from": 90, "to": 100, "gate": "level", "unlockSlot": "cap"}
  ]
}
```

### 14.2 Skills

```json
{
  "slots": [
    {"slot": "main", "unlock": 1, "max": 20}, {"slot": "area", "unlock": 5, "max": 15},
    {"slot": "passive", "unlock": 10, "max": 15}, {"slot": "buff", "unlock": 20, "max": 15},
    {"slot": "sig", "unlock": 30, "max": 15, "needs": "seniorReview"}, {"slot": "ult", "unlock": 60, "max": 15, "needs": "staffReview"},
    {"slot": "cap", "unlock": 90, "max": 10}
  ],
  "autoLearnTieOrder": ["ult", "sig", "main", "area", "cap", "passive", "buff"],
  "skills": {
    "intern": [
      {"id": "hello_world", "slot": "main", "name": "Hello, World", "unlock": 1, "max": 8, "cd": 0,
       "eff": {"type": "hit", "coef": [1.0, 0.03], "targets": 1}, "cue": "A tiny 'hi' speech bubble flies at the mob"},
      {"id": "printf", "slot": "area", "name": "printf()", "unlock": 5, "max": 5, "cd": 4,
       "eff": {"type": "hit", "coef": [0.7, 0.03], "targets": 3}, "cue": "A burst of %d glyphs"}
    ],
    "refactorer": [
      {"id": "extract_method", "slot": "main", "name": "Extract Method", "cd": 0,
       "eff": {"type": "hit", "coef": [1.0, 0.03], "targets": 1}, "cue": "White crescent slash, 200 ms"},
      {"id": "rename_symbol", "slot": "area", "name": "Rename Symbol", "cd": 4,
       "eff": {"type": "hit", "coef": [0.7, 0.03], "targets": 3}, "cue": "Blade whirl; letters foo turn into bar and scatter"},
      {"id": "strong_typing", "slot": "passive", "name": "Strong Typing", "cd": 0,
       "eff": {"type": "passive", "perRank": {"hpPct": 0.02, "dr": 0.01}}, "cue": "Faint :T glyphs on the body"},
      {"id": "code_review", "slot": "buff", "name": "Code Review", "cd": 30,
       "eff": {"type": "buff", "ticks": 10, "self": {"dmg": [0.10, 0]}, "room": {"dmgTaken": [-0.05, -0.005]}}, "cue": "Magnifying-glass halo"},
      {"id": "big_picture", "slot": "sig", "name": "Big Picture", "cd": 0,
       "eff": {"type": "proc", "everyActions": 6, "coef": [2.0, 0.08], "targets": 1, "splash": 0.5}, "cue": "Blueprint grid flashes across the slot floor"},
      {"id": "big_rewrite", "slot": "ult", "name": "The Big Rewrite", "cd": 45,
       "eff": {"type": "hit", "coef": [5.0, 0.25], "targets": "lane", "bossAdds": true}, "cue": "Scaffolding rises for 2 ticks, then a 150 ms white wipe limited to the slot"},
      {"id": "clean_architecture", "slot": "cap", "name": "Clean Architecture", "cd": 0,
       "eff": {"type": "passive", "perRank": {"dmg": 0.02, "dr": 0.01}}, "cue": "Silver trim on the scarf"}
    ],
    "hotfixer": [
      {"id": "quick_patch", "slot": "main", "name": "Quick Patch", "cd": 0,
       "eff": {"type": "hit", "coef": [0.6, 0.02], "targets": 1, "hits": 2, "merged": true}, "cue": "Two quick flashes"},
      {"id": "cherry_pick", "slot": "area", "name": "Cherry-Pick", "cd": 4, "anyTime": true,
       "eff": {"type": "hit", "coef": [1.8, 0.06], "targets": "lowestHp", "executeBelow": 0.15, "executeBoss": false}, "cue": "Cherry-shaped blink puff"},
      {"id": "works_on_my_machine", "slot": "passive", "name": "Works On My Machine", "cd": 0,
       "eff": {"type": "passive", "perRank": {"dodge": 0.01}}, "cue": "Dodged hits show 404"},
      {"id": "stealth_commit", "slot": "buff", "name": "Stealth Commit", "cd": 30,
       "eff": {"type": "buff", "ticks": [5, "floor(rank/5)"], "self": {"alwaysCrit": true, "untargetable": true}}, "cue": "Sprite at 50% opacity"},
      {"id": "bisect", "slot": "sig", "name": "Bisect", "cd": 0,
       "eff": {"type": "stacks", "perStack": {"dmg": 0.05}, "maxStacks": [5, "floor(rank/3)"], "resetOnTargetChange": true}, "cue": "Pip counter above the target"},
      {"id": "push_to_main", "slot": "ult", "name": "Push to Main", "cd": 40,
       "eff": {"type": "hit", "coef": [1.0, 0.05], "targets": 1, "hits": 8, "alwaysCrit": true, "merged": true}, "cue": "->main streaks"},
      {"id": "zero_downtime", "slot": "cap", "name": "Zero Downtime", "cd": 0,
       "eff": {"type": "passive", "perRank": {"dodge": 0.01, "critDmg": 0.02}, "onDodgeHealPct": 0.01}, "cue": "none"}
    ],
    "shellmancer": [
      {"id": "echo_bolt", "slot": "main", "name": "Echo Bolt", "cd": 0,
       "eff": {"type": "hit", "coef": [1.0, 0.03], "targets": 1, "ranged": true}, "cue": "> glyph projectile, 300 ms"},
      {"id": "pipe_chain", "slot": "area", "name": "Pipe Chain", "cd": 4,
       "eff": {"type": "hit", "coef": [0.65, 0.03], "targets": 3}, "cue": "| glyphs link the targets"},
      {"id": "tab_completion", "slot": "passive", "name": "Tab Completion", "cd": 0,
       "eff": {"type": "passive", "perRank": {"freeMainChance": 0.01}}, "cue": "A ghosted second bolt"},
      {"id": "sudo", "slot": "buff", "name": "Sudo", "cd": 30,
       "eff": {"type": "buff", "ticks": 8, "self": {"dmg": [0.14, 0.01]}}, "cue": "Tiny # crown"},
      {"id": "cron_job", "slot": "sig", "name": "Cron Job", "cd": 0,
       "eff": {"type": "proc", "everyActions": 6, "coef": [2.0, 0.08], "targets": 1, "splash": 0.5}, "cue": "Clock-face projectile"},
      {"id": "midnight_batch", "slot": "ult", "name": "Midnight Batch", "cd": 50,
       "eff": {"type": "hit", "coef": [0.8, 0.04], "targets": "lane", "hits": 3, "merged": true, "bossAdds": true}, "cue": "Three * meteors, on the hero's own cooldown"},
      {"id": "root_access", "slot": "cap", "name": "Root Access", "cd": 0,
       "eff": {"type": "passive", "perRank": {"dmg": 0.02, "ignoreBossDr": 0.02}}, "cue": "Green title bar"}
    ],
    "forkbinder": [
      {"id": "spawn_process", "slot": "main", "name": "Spawn Process", "cd": 0,
       "eff": {"type": "hit", "coef": [0.85, 0.025], "targets": 1, "bonusHit": 0.2, "merged": true}, "cue": "&-tailed imp nips the target"},
      {"id": "background_jobs", "slot": "area", "name": "Background Jobs", "cd": 4,
       "eff": {"type": "hit", "coef": [0.65, 0.03], "targets": 3}, "cue": "Three & imps dart out"},
      {"id": "process_pool", "slot": "passive", "name": "Process Pool", "cd": 0,
       "eff": {"type": "passive", "perRank": {"forklingPct": 0.01}, "countedAtRanks": [5, 10, 15]}, "cue": "Forklings wear tiny gear badges"},
      {"id": "daemonize", "slot": "buff", "name": "Daemonize", "cd": 0,
       "eff": {"type": "summon", "everyTick": true, "pctOfMain": [0.15, 0.01]}, "cue": "Cron Sprite; a small sparkle every 60 ticks, phase-offset per hero"},
      {"id": "thundering_herd", "slot": "sig", "name": "Thundering Herd", "cd": 0,
       "eff": {"type": "proc", "everyActions": 6, "coef": [0.9, 0.045], "targets": "lane"}, "cue": "Summons dash across the lane"},
      {"id": "fork_bomb", "slot": "ult", "name": "Fork Bomb", "cd": 45,
       "eff": {"type": "hit", "coef": [0.9, 0.045], "targets": "randomLane", "hits": 8, "merged": true}, "cue": "Imps double 1, 2, 4, 8; 'Resource temporarily unavailable' fades in"},
      {"id": "supervisor_tree", "slot": "cap", "name": "Supervisor Tree", "cd": 0,
       "eff": {"type": "passive", "perRankPerSummon": {"dmg": 0.01}, "maxSummons": 7}, "cue": "A small tree glyph over the book"}
    ],
    "rubberducker": [
      {"id": "quack", "slot": "main", "name": "Quack", "cd": 0,
       "eff": {"type": "hit", "coef": [1.05, 0.03], "targets": 1, "ranged": true}, "cue": "Expanding ring"},
      {"id": "explain_it_out_loud", "slot": "area", "name": "Explain It Out Loud", "cd": 4,
       "eff": {"type": "healOrHit", "healBelow": 0.85, "heal": [0.08, 0.005], "coef": [0.7, 0.03], "targets": 3}, "cue": "Speech squiggle, or a duck wave"},
      {"id": "rubber_duck_debugging", "slot": "passive", "name": "Rubber Duck Debugging", "cd": 0,
       "eff": {"type": "aura", "perRank": {"roomXp": 0.01, "roomDmg": 0.005}, "highestOnly": true}, "cue": "none"},
      {"id": "pair_programming", "slot": "buff", "name": "Pair Programming", "cd": 30,
       "eff": {"type": "buff", "ticks": 10, "self": {"dmg": [0.11, 0.01]}, "ally": "lowestLevel"}, "cue": "{ } brackets around the pair"},
      {"id": "ducklings", "slot": "sig", "name": "Ducklings", "cd": 0,
       "eff": {"type": "summon", "everyTick": true, "count": [1, 2], "secondAtRank": 8, "pctOfMain": [0.19, 0.01]}, "cue": "Ducklings waddle behind"},
      {"id": "retrospective", "slot": "ult", "name": "Retrospective", "cd": 45,
       "eff": {"type": "roomRestore", "reviveRoom": true, "fullHealRoom": true, "buffTicks": 15, "roomDmg": [0.29, 0.01]}, "cue": "Sticky notes flutter up"},
      {"id": "psychological_safety", "slot": "cap", "name": "Psychological Safety", "cd": 0,
       "eff": {"type": "aura", "perRank": {"roomDr": 0.01}, "rebootFasterTicksPer2Ranks": 1}, "cue": "Soft cream aura #FFF4D6"}
    ]
  }
}
```

### 14.3 Zones and maps

```json
[
  {"n": 0, "id": "lint_meadows", "name": "Lint Meadows", "levels": [1, 11], "boss": 0, "sprint": 6,
   "palette": {"sky": "#CFEFD8", "far": "#8FD19E", "ground": "#4E8F5F", "accent": "#E0605A"},
   "scenery": "Soft green hills; dandelions with red squiggly stems", "perk": {"xp": 0.02},
   "maps": [{"id": "1-1", "name": "Squiggle Path", "levels": [1, 4], "spawn": {"typo_sprout": 1}},
            {"id": "1-2", "name": "Whitespace Fields", "levels": [5, 8], "spawn": {"semicolon_snail": 0.75, "typo_sprout": 0.25}},
            {"id": "1-3", "name": "Warning Gate", "levels": [9, 11], "spawn": {"unused_import": 0.75, "semicolon_snail": 0.25}}]},
  {"n": 1, "id": "callback_caverns", "name": "Callback Caverns", "levels": [12, 22], "boss": 1, "sprint": 10,
   "palette": {"sky": "#2B2140", "far": "#463566", "ground": "#2E2545", "accent": "#9EE6FF"},
   "scenery": "Indigo caves; stalactites shaped like {{{; glowing mushrooms", "perk": {"gold": 0.03},
   "maps": [{"id": "2-1", "name": "Mouth of the Stack", "levels": [12, 15], "spawn": {"callback_bat": 1}},
            {"id": "2-2", "name": "Nested Tunnels", "levels": [16, 19], "spawn": {"promise_wisp": 0.75, "callback_bat": 0.25}},
            {"id": "2-3", "name": "Pyramid Steps", "levels": [20, 22], "spawn": {"null_pointer_frog": 0.75, "promise_wisp": 0.25}}]},
  {"n": 2, "id": "regex_ruins", "name": "Regex Ruins", "levels": [23, 33], "boss": 2, "sprint": 25,
   "palette": {"sky": "#F3DDB0", "far": "#C99A5B", "ground": "#8C6A3E", "accent": "#2FB9A8"},
   "scenery": "Sandstone dusk; turquoise pillars carved ^.*$", "perk": {"crit": 0.01},
   "maps": [{"id": "3-1", "name": "Anchor Steps", "levels": [23, 26], "spawn": {"capture_group_goblins": 1}},
            {"id": "3-2", "name": "Quantifier Colonnade", "levels": [27, 30], "spawn": {"backslash_bandit": 0.75, "capture_group_goblins": 0.25}},
            {"id": "3-3", "name": "The Unparsed Gate", "levels": [31, 33], "spawn": {"greedy_glob": 0.75, "backslash_bandit": 0.25}}]},
  {"n": 3, "id": "merge_marshes", "name": "Merge Marshes", "levels": [34, 44], "boss": 3, "sprint": 45,
   "palette": {"sky": "#D8E3C2", "far": "#8FA36A", "ground": "#4F5E34", "accent": "#E05A5A", "accent2": "#5AC46A"},
   "scenery": "Olive swamp; fence posts of <<<<<<<; two-tone diff water", "perk": {"hpPct": 0.02},
   "maps": [{"id": "4-1", "name": "Fast-Forward Ford", "levels": [34, 37], "spawn": {"diff_leech": 1}},
            {"id": "4-2", "name": "Stash Bog", "levels": [38, 41], "spawn": {"rebase_wraith": 0.75, "diff_leech": 0.25}},
            {"id": "4-3", "name": "Octopus Delta", "levels": [42, 44], "spawn": {"merge_conflict_golem": 0.75, "rebase_wraith": 0.25}}]},
  {"n": 4, "id": "dependency_jungle", "name": "Dependency Jungle", "levels": [45, 55], "boss": 4, "sprint": 70,
   "palette": {"sky": "#CDEBC0", "far": "#4E9A5A", "ground": "#24502E", "accent": "#F2C14E"},
   "scenery": "Vines drawn as arrow graphs; crates stamped pkg", "perk": {"itemFind": 0.03},
   "maps": [{"id": "5-1", "name": "Lockfile Clearing", "levels": [45, 48], "spawn": {"left_pad_mites": 1}},
            {"id": "5-2", "name": "Transitive Thicket", "levels": [49, 52], "spawn": {"transitive_vine": 0.75, "left_pad_mites": 0.25}},
            {"id": "5-3", "name": "The Heaviest Grove", "levels": [53, 55], "spawn": {"version_pin_porcupine": 0.75, "transitive_vine": 0.25}}]},
  {"n": 5, "id": "threadlock_keep", "name": "Threadlock Keep", "levels": [56, 66], "boss": 5, "sprint": 105,
   "palette": {"sky": "#2A2A2E", "far": "#8A5A3B", "ground": "#1F1F22", "accent": "#FFB347"},
   "scenery": "Copper clockwork castle; padlocks; sparks", "perk": {"dmg": 0.02},
   "maps": [{"id": "6-1", "name": "Critical Section", "levels": [56, 59], "spawn": {"race_condition_rats": 1}},
            {"id": "6-2", "name": "Semaphore Walls", "levels": [60, 63], "spawn": {"spinlock_top": 0.75, "race_condition_rats": 0.25}},
            {"id": "6-3", "name": "The Twin Locks", "levels": [64, 66], "spawn": {"starved_thread": 0.75, "spinlock_top": 0.25}}]},
  {"n": 6, "id": "legacy_catacombs", "name": "Legacy Catacombs", "levels": [67, 77], "boss": 6, "sprint": 160,
   "palette": {"sky": "#121A14", "far": "#2C3B2E", "ground": "#0D130F", "accent": "#66FF99"},
   "scenery": "CRT tombstones with green text; punch-card bricks", "perk": {"cdr": 0.02},
   "maps": [{"id": "7-1", "name": "Deprecated Stairs", "levels": [67, 70], "spawn": {"todo_ghost": 1}},
            {"id": "7-2", "name": "Hall of Comments", "levels": [71, 74], "spawn": {"anonymous_author": 0.75, "todo_ghost": 0.25}},
            {"id": "7-3", "name": "Spaghetti Vaults", "levels": [75, 77], "spawn": {"spaghetti_mummy": 0.75, "anonymous_author": 0.25}}]},
  {"n": 7, "id": "production_peaks", "name": "Production Peaks", "levels": [78, 88], "boss": 7, "sprint": 215,
   "palette": {"sky": "#1C2236", "far": "#3E4A6B", "ground": "#151A2A", "accent": "#FF5A5F"},
   "scenery": "Stormy summit; cliffs of blinking server racks", "perk": {"dr": 0.01},
   "maps": [{"id": "8-1", "name": "Staging Slopes", "levels": [78, 81], "spawn": {"flaky_test_phantom": 1}},
            {"id": "8-2", "name": "Canary Cliffs", "levels": [82, 85], "spawn": {"memory_leak_slime": 0.75, "flaky_test_phantom": 0.25}},
            {"id": "8-3", "name": "Friday Summit", "levels": [86, 88], "spawn": {"pager_wyvern": 0.75, "memory_leak_slime": 0.25}}]},
  {"n": 8, "id": "undefined_depths", "name": "Undefined Depths", "levels": [89, 99], "boss": 8, "sprint": 300,
   "palette": {"sky": "#1A1030", "far": "#3A2466", "ground": "#120A22", "accent": "#C8A6FF"},
   "scenery": "Void violet; glitch static; floating NaN motes", "perk": {"bossDmg": 0.02},
   "maps": [{"id": "9-1", "name": "Off-By-One Steps", "levels": [89, 92], "spawn": {"off_by_one_twins": 1}},
            {"id": "9-2", "name": "Bitflip Grotto", "levels": [93, 96], "spawn": {"bitflip_moth": 0.75, "off_by_one_twins": 0.25}},
            {"id": "9-3", "name": "Observer's Edge", "levels": [97, 99], "spawn": {"undefined_behavior": 0.75, "bitflip_moth": 0.25}}]}
]
```

### 14.4 Mobs and traits

```json
{
  "traits": {
    "fast": {"swingEvery": 1}, "slow": {"swingEvery": 3}, "tanky": {},
    "swarm": {"count": 2}, "phaser": {"missChance": 0.2}, "clumsy": {"selfMissChance": 0.2, "healsHero": false},
    "pending": {"invulnTicks": 2}, "leech": {"healPct": 0.15}, "reviver": {"chance": 0.25, "hp": 0.4},
    "splitter": {"halves": 2, "hpPct": 0.3, "xpPct": 0.3}, "grower": {"perTick": 0.03, "cap": 0.6},
    "thorns": {"reflect": 0.08, "meleeOnly": true}, "ranged": {"fromSlot": 2, "swingEvery": 3},
    "shapeshifter": {"everyTicks": 5, "exclude": ["swarm", "splitter"]}
  },
  "elite": {"prefix": "Smelly", "hp": 3, "atk": 1.5, "xp": 4, "gold": 4, "itemChance": 0.2, "rareWeightMult": 2, "snippetChance": 0.25, "scale": 1.25},
  "holo_duck": {"name": "Holo Rubber Duck", "hp": 4, "attacks": false, "leaveAfterTicks": 20, "drop": "duck_chest"},
  "mobs": [
    {"id": "typo_sprout", "zone": 0, "map": 1, "name": "Typo Sprout", "size": "S", "traits": [], "hp": 1.0, "atk": 1.0, "xp": 1.0, "gold": 1.0,
     "sprite": "Seedling whose leaf says teh", "flavor": "Sprouts wherever fingers outrun eyes."},
    {"id": "semicolon_snail", "zone": 0, "map": 2, "name": "Semicolon Snail", "size": "S", "traits": ["slow"], "hp": 1.3, "atk": 1.4, "xp": 1.2, "gold": 1.0,
     "sprite": "A ; shell leaving a dotted trail", "flavor": "Optional in some regions."},
    {"id": "unused_import", "zone": 0, "map": 3, "name": "Unused Import", "size": "M", "traits": ["tanky"], "hp": 1.6, "atk": 0.8, "xp": 1.4, "gold": 1.5,
     "sprite": "Sleeping imp hugging a crate it never opens", "flavor": "Imported years ago. Never called."},
    {"id": "callback_bat", "zone": 1, "map": 1, "name": "Callback Bat", "size": "S", "traits": ["fast"], "hp": 0.8, "atk": 0.6, "xp": 0.9, "gold": 1.0,
     "sprite": "Boomerang-shaped wings", "flavor": "Will call you back. Eventually. Possibly twice."},
    {"id": "promise_wisp", "zone": 1, "map": 2, "name": "Promise Wisp", "size": "S", "traits": ["pending"], "hp": 1.1, "atk": 1.0, "xp": 1.1, "gold": 1.0,
     "sprite": "Cocoon with a loading spinner", "flavor": "Pending... pending... resolved."},
    {"id": "null_pointer_frog", "zone": 1, "map": 3, "name": "Null Pointer Frog", "size": "M", "traits": ["clumsy"], "hp": 1.0, "atk": 1.2, "xp": 1.1, "gold": 1.0,
     "sprite": "Frog with an arrow-to-nothing belly", "flavor": "Points confidently at nothing."},
    {"id": "capture_group_goblins", "zone": 2, "map": 1, "name": "Capture Group Goblins", "size": "S", "traits": ["swarm"], "swarm": 2, "hp": 0.6, "atk": 0.7, "xp": 0.6, "gold": 0.6,
     "sprite": "Two goblins holding ( and )", "flavor": "They travel in (pairs)."},
    {"id": "backslash_bandit", "zone": 2, "map": 2, "name": "Backslash Bandit", "size": "M", "traits": ["phaser"], "phaser": 0.2, "hp": 0.9, "atk": 1.1, "xp": 1.0, "gold": 1.2,
     "sprite": "Masked thief with a slash-shaped cape", "flavor": "Always escaping."},
    {"id": "greedy_glob", "zone": 2, "map": 3, "name": "Greedy Glob", "size": "M", "traits": ["leech"], "leech": 0.15, "hp": 1.3, "atk": 1.0, "xp": 1.3, "gold": 2.0,
     "sprite": "Blob stamped .* swallowing pebbles", "flavor": "Matches everything. Including your lunch."},
    {"id": "diff_leech", "zone": 3, "map": 1, "name": "Diff Leech", "size": "S", "traits": ["leech"], "leech": 0.2, "hp": 0.9, "atk": 1.0, "xp": 0.9, "gold": 1.0,
     "sprite": "Red-and-green striped leech", "flavor": "+3 -3. Mostly -."},
    {"id": "rebase_wraith", "zone": 3, "map": 2, "name": "Rebase Wraith", "size": "M", "traits": ["reviver"], "reviver": 0.25, "hp": 1.0, "atk": 1.2, "xp": 1.2, "gold": 1.0,
     "sprite": "Ghost trailing afterimages", "flavor": "Rewrites history. Says it's cleaner."},
    {"id": "merge_conflict_golem", "zone": 3, "map": 3, "name": "Merge Conflict Golem", "size": "L", "traits": ["tanky", "splitter"], "hp": 1.6, "atk": 0.9, "xp": 1.6, "gold": 1.5,
     "sprite": "Golem whose chest reads <<<<<<< ======= >>>>>>>; splits into HEAD and incoming halves", "flavor": "Two halves, both convinced they're right."},
    {"id": "left_pad_mites", "zone": 4, "map": 1, "name": "Left-Pad Mites", "size": "S", "traits": ["swarm"], "swarm": 2, "hp": 0.5, "atk": 0.6, "xp": 0.5, "gold": 0.5,
     "sprite": "Tiny mites carrying a whole vine", "flavor": "Tiny. Load-bearing."},
    {"id": "transitive_vine", "zone": 4, "map": 2, "name": "Transitive Vine", "size": "M", "traits": ["grower"], "hp": 1.0, "atk": 1.0, "xp": 1.2, "gold": 1.0,
     "sprite": "Vine dragging crates nobody ordered", "flavor": "You didn't plant it. Something you planted did."},
    {"id": "version_pin_porcupine", "zone": 4, "map": 3, "name": "Version Pin Porcupine", "size": "M", "traits": ["thorns"], "thorns": 0.08, "hp": 1.3, "atk": 1.0, "xp": 1.3, "gold": 1.2,
     "sprite": "Quills tipped with ^ and ~", "flavor": "Pinned to 0.3.1 forever."},
    {"id": "race_condition_rats", "zone": 5, "map": 1, "name": "Race Condition Rats", "size": "S", "traits": ["swarm", "fast"], "swarm": 2, "hp": 0.55, "atk": 0.5, "xp": 0.6, "gold": 0.6,
     "sprite": "Twin rats that never arrive in the same order", "flavor": "The winner changes every run."},
    {"id": "spinlock_top", "zone": 5, "map": 2, "name": "Spinlock Top", "size": "M", "traits": ["phaser"], "phaser": 0.25, "hp": 0.9, "atk": 0.9, "xp": 1.0, "gold": 1.0,
     "sprite": "A top that never stops spinning", "flavor": "Very busy. Accomplishes nothing."},
    {"id": "starved_thread", "zone": 5, "map": 3, "name": "Starved Thread", "size": "M", "traits": ["slow"], "hp": 1.1, "atk": 1.8, "xp": 1.2, "gold": 1.0,
     "sprite": "Thin ghost holding a ticket number", "flavor": "Hasn't been scheduled since Tuesday."},
    {"id": "todo_ghost", "zone": 6, "map": 1, "name": "TODO Ghost", "size": "S", "traits": ["phaser"], "phaser": 0.15, "hp": 0.9, "atk": 0.9, "xp": 0.9, "gold": 1.0,
     "sprite": "Ghost wearing a // TODO (2011) tag", "flavor": "Will be removed before launch."},
    {"id": "anonymous_author", "zone": 6, "map": 2, "name": "Anonymous Author", "size": "M", "traits": ["ranged"], "hp": 0.9, "atk": 1.1, "xp": 1.0, "gold": 1.0,
     "sprite": "Hooded quill with a name tag reading unknown", "flavor": "git blame shrugs."},
    {"id": "spaghetti_mummy", "zone": 6, "map": 3, "name": "Spaghetti Mummy", "size": "L", "traits": ["tanky"], "hp": 1.6, "atk": 0.8, "xp": 1.5, "gold": 1.5,
     "sprite": "Wrapped in 4,000 lines of pasta", "flavor": "No tests. No regrets."},
    {"id": "flaky_test_phantom", "zone": 7, "map": 1, "name": "Flaky Test Phantom", "size": "M", "traits": ["phaser", "reviver"], "phaser": 0.2, "reviver": 0.2, "hp": 0.9, "atk": 1.0, "xp": 1.1, "gold": 1.0,
     "sprite": "Flickers in and out", "flavor": "Passes on retry. Fails in CI."},
    {"id": "memory_leak_slime", "zone": 7, "map": 2, "name": "Memory Leak Slime", "size": "M", "traits": ["grower"], "hp": 1.0, "atk": 1.0, "xp": 1.2, "gold": 1.0,
     "sprite": "A slime that keeps swelling", "flavor": "A little bigger every tick. Nobody restarts it."},
    {"id": "pager_wyvern", "zone": 7, "map": 3, "name": "Pager Wyvern", "size": "M", "traits": ["ranged", "fast"], "hp": 0.9, "atk": 0.7, "xp": 1.1, "gold": 1.0,
     "sprite": "Small wyvern with a buzzing beeper", "flavor": "Beeps at 3 AM. Every time."},
    {"id": "off_by_one_twins", "zone": 8, "map": 1, "name": "Off-By-One Twins", "size": "S", "traits": ["swarm"], "swarm": 3, "hp": 0.45, "atk": 0.6, "xp": 0.45, "gold": 0.45,
     "sprite": "Twins. There are three of them.", "flavor": "There's always one more."},
    {"id": "bitflip_moth", "zone": 8, "map": 2, "name": "Bitflip Moth", "size": "S", "traits": ["phaser", "clumsy"], "phaser": 0.25, "clumsy": 0.1, "clumsyHealsHero": true, "hp": 0.9, "atk": 1.1, "xp": 1.0, "gold": 1.0,
     "sprite": "Moth drawn to tiny cosmic-ray sparks", "flavor": "Sometimes it flips the wrong bit."},
    {"id": "undefined_behavior", "zone": 8, "map": 3, "name": "Undefined Behavior", "size": "L", "traits": ["shapeshifter"], "hp": 1.2, "atk": 1.1, "xp": 1.4, "gold": 1.2,
     "sprite": "Blob that renders differently every few seconds", "flavor": "Legally allowed to do anything."}
  ]
}
```

### 14.5 Bosses and reviews

```json
{
  "bosses": [
    {"n": 0, "id": "ignored_warning", "name": "The Ignored Warning", "zone": 0, "level": 12, "bk": 16, "ak": 1.0, "timer": 180, "mech": 0.85,
     "look": "Giant amber triangle printed 999+, monocle, cape of tiny triangles",
     "mechanics": [
       {"phase": 1, "from": 1.0, "to": 0.5, "type": "spawnAdd", "every": 20, "add": {"name": "Warning Mite", "hp": 1.0, "atk": 0.5}, "maxAlive": 3, "bossDmgPerAdd": 0.10},
       {"phase": 2, "from": 0.5, "to": 0.0, "type": "burstAdds", "count": 4, "add": {"name": "Warning Mite", "hp": 1.0, "atk": 0.5}, "invulnWhileAddsAtLeast": 2, "dmgAfter": 0.30, "label": "Promoted to Error"}],
     "enrage": {"name": "Treat warnings as errors", "dmg": 0.5}, "keepsake": "hazard_cone_hat",
     "flavor": "Yellow since the first commit. Everyone scrolls past it."},
    {"n": 1, "id": "pyramid_of_doom", "name": "The Pyramid of Doom", "zone": 1, "level": 23, "bk": 28, "ak": 1.3, "timer": 180, "mech": 0.85,
     "look": "Stepped pyramid of nested braces with one eye per layer",
     "mechanics": [
       {"type": "layers", "count": 3, "overkillWasted": true},
       {"type": "onLayerBreak", "invulnTicks": 6, "label": "await", "add": {"name": "Callback Bat", "hp": 1.0, "atk": 0.6, "count": 3},
        "then": {"label": "resolve()", "hitAllPctMaxHp": 0.20, "ifAddsDead": 0.05}},
       {"type": "finalLayerDmg", "dmg": 0.30}],
     "enrage": {"name": "Callback hell", "dmg": 0.5}, "keepsake": "curly_brace_crown",
     "flavor": "Indented 47 levels deep. The base case is a rumor."},
    {"n": 2, "id": "catastrophic_backtracker", "name": "The Catastrophic Backtracker", "zone": 2, "level": 34, "bk": 32, "ak": 1.6, "timer": 180, "mech": 0.8,
     "look": "Long serpent of .*.*.* tokens coiled into a loop",
     "mechanics": [
       {"type": "burstCheck", "every": 25, "everyBelow30": 18, "telegraphTicks": 5, "label": "Trying again...", "bubble": "(a+)+$",
        "needPctMaxHp": 0.05, "success": {"stunTicks": 3, "dmgTaken": 0.20, "label": "Anchored"}, "fail": {"healPctOfDamageLast": 0.5, "windowTicks": 15}}],
     "enrage": {"name": "Timeout exceeded", "dmg": 0.5}, "keepsake": "lazy_quantifier_boots",
     "flavor": "One step forward, 2^n steps back."},
    {"n": 3, "id": "octopus_merge", "name": "The Octopus Merge", "zone": 3, "level": 45, "bk": 24, "ak": 1.6, "timer": 180, "mech": 0.75,
     "look": "Plum-coloured octopus with tentacles labelled feat/ fix/ wip/ docs/ test/ chore/ hotfix/ refactor/",
     "mechanics": [
       {"type": "shieldParts", "parts": 8, "partHpPctOfBody": 0.05, "shieldWhileAtLeast": 4, "bodyDmgTaken": -0.75, "label": "Merging... {n} branches left",
        "regrowTicks": 20, "regrowTicksBelow40": 12, "partAttack": {"every": 4, "pctOfSwing": 0.3, "target": "random"},
        "singleTargetHits": "lowestPartWhileShielded", "areaHits": "partsAndBody"}],
     "enrage": {"name": "Merge queue full", "dmg": 0.5}, "keepsake": "octo_hoodie",
     "flavor": "Merges eight branches at once. All of them are wrong."},
    {"n": 4, "id": "bloatodon", "name": "Bloatodon, the Heaviest Object", "zone": 4, "level": 56, "bk": 30, "ak": 1.6, "timer": 180, "mech": 0.8,
     "look": "Whale-sized crate stamped pkg, stuffed with smaller crates, on tiny legs",
     "mechanics": [
       {"type": "grow", "every": 12, "maxHpPct": 0.04, "healPct": 0.04, "counter": "+{n} deps"},
       {"type": "spawnAdd", "every": 30, "add": {"name": "Left-Pad Mite", "hp": 0.5, "atk": 0.6, "count": 3}, "drPerAdd": 0.05, "drCap": 0.20},
       {"type": "enrageAtCounter", "counter": 10, "label": "Install complete"}],
     "enrage": {"name": "Install complete", "dmg": 0.5}, "keepsake": "lockfile_mug",
     "flavor": "Pulled in by a one-line helper. Now outweighs the sun."},
    {"n": 5, "id": "deadlock_hydra", "name": "The Deadlock Hydra", "zone": 5, "level": 67, "bk": 32, "ak": 1.6, "timer": 180, "mech": 0.85,
     "look": "Two-headed copper hydra; each head clutches the key the other wants",
     "mechanics": [
       {"type": "twinHeads", "heads": ["Mutex", "Semaphore"], "singleTargetHits": "higherHpPct", "areaHits": "both",
        "waitingGapPts": 10, "resumeGapPts": 5, "biteEvery": 3, "bitePctOfSwing": 0.6, "noBasicAttack": true},
       {"type": "balanceCheck", "every": 40, "telegraphTicks": 3, "label": "Deadlock", "withinPts": 5,
        "success": {"stunTicks": 4, "dmgTaken": 0.25, "label": "Resolved"}, "fail": {"partyWaitTicks": 3}}],
     "enrage": {"name": "Starvation", "biteEvery": 2}, "keepsake": "mutex_twinfang",
     "flavor": "Each head is waiting for the other to let go."},
    {"n": 6, "id": "monolith", "name": "The Monolith", "zone": 6, "level": 78, "bk": 32, "ak": 1.6, "timer": 180, "mech": 0.75,
     "look": "Towering grey slab with blinking LEDs that cracks into glowing cubes",
     "mechanics": [
       {"phase": 1, "from": 1.0, "to": 0.6, "label": "Tightly Coupled", "singleTargetDmgTaken": -0.25, "slam": {"every": 4, "pctOfSwing": 0.8, "target": "all"}, "noBasicAttack": true},
       {"phase": 2, "from": 0.6, "to": 0.0, "label": "Decompose", "split": 6, "meshHealPctPerOtherPerTick": 0.0025,
        "partAttack": {"every": 5, "pctOfSwing": 0.5, "target": "random"}, "singleTargetHits": "lowestPart"},
       {"phase": 3, "when": "onePartLeft", "label": "Distributed Monolith", "dmg": 1.0, "swingEvery": 2}],
     "enrage": {"name": "Big-bang release", "dmg": 0.5}, "keepsake": "microservice_badge",
     "flavor": "Split into six services. Still deploys as one."},
    {"n": 7, "id": "friday_deploy", "name": "The Friday Deploy", "zone": 7, "level": 89, "bk": 32, "ak": 1.6, "timer": 180, "mech": 0.85,
     "look": "Midnight-blue dragon in a tiny party hat, pager on its collar, tail a flaming progress bar stuck at 99%",
     "mechanics": [
       {"type": "clock", "from": "4:55 PM", "to": "5:00 PM", "ticks": 30, "onZero": {"name": "Outage Breath", "hitAllPctMaxHp": 0.30, "drFactor": 0.5}},
       {"phase": 2, "from": 0.66, "to": 0.33, "label": "4:59 PM", "type": "spawnAdd", "every": 25, "add": {"name": "Pager Wyvern", "hp": 1.0, "atk": 0.7, "count": 2}, "clockSpeedPerAdd": 0.25},
       {"phase": 3, "from": 0.33, "to": 0.0, "label": "Long Weekend", "clockTicks": 20, "partyDmg": 0.25, "partyBuffName": "Ship It"}],
     "enrage": {"name": "The weekend is ruined", "outagePct": 0.45}, "keepsake": "weekend_pass", "badge": "read_only_friday",
     "flavor": "Arrives at 4:55 PM on a Friday. Never alone."},
    {"n": 8, "id": "heisenbug", "name": "The Heisenbug", "zone": 8, "level": 100, "bk": 40, "ak": 1.6, "timer": 240, "mech": 0.85,
     "look": "Translucent moth-like bug with a dotted outline that never quite holds still",
     "mechanics": [
       {"type": "stance", "every": 20, "teleport": true, "states": [
          {"name": "Position", "singleTargetMult": 1.5, "areaMult": 0.5, "sprite": "sharp"},
          {"name": "Momentum", "singleTargetMult": 0.5, "areaMult": 1.5, "sprite": "blurred"}]},
       {"type": "pulse", "every": 30, "hitAllPctMaxHp": 0.15, "label": "Wavefunction"},
       {"type": "observed", "when": "anyParticipantFocused", "cosmetic": "shimmer + eye icon", "delayNextStanceTicks": 5, "neverPenalty": true}],
     "enrage": {"name": "Cannot reproduce", "stanceEvery": 10}, "keepsake": "uncertainty_lens",
     "flavor": "Only reproduces when nobody is looking. Looking helps a little."}
  ],
  "reviews": [
    {"id": "senior_review", "level": 30, "opponent": "You, Six Months Ago", "hpMobs": 20, "swingEvery": 2, "ak": 1.3, "timer": 150,
     "bubbleAt": 0.5, "bubble": "who wrote this?", "reward": {"title": "Senior", "sp": 1, "item": {"slot": "weapon", "rarity": 3}}},
    {"id": "staff_review", "level": 60, "opponent": "The Senior Reviewer", "hpMobs": 26, "swingEvery": 3, "ak": 2.0, "timer": 180,
     "phases": ["nit:", "blocking:", "LGTM w/ comments"], "onPhase": {"add": {"name": "Nitpick", "hp": 1.0, "atk": 0.5, "count": 2}, "dmgTakenWhileAdds": -0.5},
     "reward": {"title": "Staff", "sp": 1, "item": {"slot": "sticker", "rarity": 3}}}
  ]
}
```

### 14.6 Rarities, affixes, LTS properties, Keepsakes

```json
{
  "rarities": [
    {"n": 0, "id": "prototype", "name": "Prototype", "color": "#A0A4AB", "mult": 1.00, "affixes": 0, "polishMax": 3, "deprecate": 2, "wKill": 64, "wChest": 35},
    {"n": 1, "id": "alpha", "name": "Alpha", "color": "#5BD16A", "mult": 1.10, "affixes": 1, "polishMax": 5, "deprecate": 4, "wKill": 26, "wChest": 40},
    {"n": 2, "id": "beta", "name": "Beta", "color": "#4EA3FF", "mult": 1.22, "affixes": 2, "polishMax": 7, "deprecate": 8, "wKill": 8, "wChest": 19},
    {"n": 3, "id": "release", "name": "Release", "color": "#B36BFF", "mult": 1.36, "affixes": 3, "polishMax": 9, "deprecate": 20, "wKill": 1.9, "wChest": 5.2},
    {"n": 4, "id": "lts", "name": "LTS", "color": "#FF9A2E", "mult": 1.52, "affixes": 3, "property": true, "polishMax": 10, "deprecate": 40, "wKill": 0.1, "wChest": 0.8},
    {"n": 5, "id": "keepsake", "name": "Keepsake", "color": "#FF7AA8", "mult": 1.70, "affixes": 3, "unique": true, "polishMax": 12, "deprecate": null, "wKill": 0, "wChest": 0}
  ],
  "dropWeights": {
    "duckChest": {"beta": 45, "release": 40, "lts": 15},
    "bossFirst": {"release": 70, "lts": 30},
    "bossRepeat": {"beta": 50, "release": 40, "lts": 10, "keepsakeChance": 0.15},
    "chestTierFloor": {"silver": "alpha", "gold": "beta"},
    "itemFindAffects": ["beta", "release", "lts"],
    "slots": {"weapon": 20, "hat": 16, "hoodie": 16, "mug": 16, "boots": 16, "sticker": 16},
    "weaponOwnClass": 0.7,
    "killItemChance": 0.004, "killSnippetChance": 0.03
  },
  "affixes": [
    {"n": 0, "id": "memo", "name": "Memoized", "kind": "prefix", "stat": "dmg", "lo": 0.02, "hi": 0.04, "slots": ["weapon", "hat", "mug", "sticker"]},
    {"n": 1, "id": "lint", "name": "Linted", "kind": "prefix", "stat": "crit", "lo": 0.01, "hi": 0.02, "slots": ["weapon", "hat", "sticker"]},
    {"n": 2, "id": "opt", "name": "Optimized", "kind": "prefix", "stat": "critDmg", "lo": 0.05, "hi": 0.10, "slots": ["weapon", "sticker"]},
    {"n": 3, "id": "async", "name": "Async", "kind": "prefix", "stat": "extraAct", "lo": 0.005, "hi": 0.01, "slots": ["weapon", "boots", "sticker"]},
    {"n": 4, "id": "typed", "name": "Typed", "kind": "prefix", "stat": "armorPct", "lo": 0.04, "hi": 0.08, "slots": ["hat", "hoodie", "mug", "boots"]},
    {"n": 5, "id": "robust", "name": "Robust", "kind": "prefix", "stat": "hpPct", "lo": 0.03, "hi": 0.06, "slots": ["hat", "hoodie", "mug", "sticker"]},
    {"n": 6, "id": "recur", "name": "Recursive", "kind": "prefix", "stat": "repeatHit", "lo": 0.01, "hi": 0.02, "slots": ["weapon"]},
    {"n": 7, "id": "vec", "name": "Vectorized", "kind": "prefix", "stat": "areaDmg", "lo": 0.03, "hi": 0.06, "slots": ["weapon", "hat", "sticker"]},
    {"n": 8, "id": "blame", "name": "Blameless", "kind": "prefix", "stat": "bossDmg", "lo": 0.03, "hi": 0.06, "slots": ["weapon", "sticker"]},
    {"n": 9, "id": "green", "name": "of the Green Build", "kind": "suffix", "stat": "xp", "lo": 0.01, "hi": 0.02, "slots": ["hat", "sticker"]},
    {"n": 10, "id": "cache", "name": "of Caching", "kind": "suffix", "stat": "gold", "lo": 0.03, "hi": 0.06, "slots": ["boots", "mug", "sticker"]},
    {"n": 11, "id": "tab", "name": "of Tab Completion", "kind": "suffix", "stat": "itemFind", "lo": 0.02, "hi": 0.04, "slots": ["boots", "sticker"]},
    {"n": 12, "id": "uptime", "name": "of Uptime", "kind": "suffix", "stat": "regenPct", "lo": 0.0005, "hi": 0.001, "slots": ["hoodie", "mug", "sticker"]},
    {"n": 13, "id": "idem", "name": "of Idempotence", "kind": "suffix", "stat": "dmgTaken", "lo": -0.01, "hi": -0.02, "slots": ["hoodie", "boots"]},
    {"n": 14, "id": "hot", "name": "of Hot Reload", "kind": "suffix", "stat": "cdr", "lo": 0.02, "hi": 0.04, "slots": ["hat", "mug", "sticker"]},
    {"n": 15, "id": "grace", "name": "of Graceful Degradation", "kind": "suffix", "stat": "dmgBelowHalfHp", "lo": 0.04, "hi": 0.08, "slots": ["weapon", "hoodie"]},
    {"n": 16, "id": "rate", "name": "of Rate Limiting", "kind": "suffix", "stat": "dodge", "lo": 0.005, "hi": 0.01, "slots": ["hoodie", "boots"]}
  ],
  "affixValue": "(lo + (hi - lo) * roll / 99) * tier",
  "properties": [
    {"n": 0, "id": "tenx", "name": "Ten-X Keys", "slot": "weapon", "effect": {"everyNthAction": 10, "dmgMult": 10}},
    {"n": 1, "id": "flag", "name": "Feature-Flagged", "slot": "any", "effect": {"alternateEveryTicks": 60, "dmg": 0.25, "armorPct": 0.25}},
    {"n": 2, "id": "rollback", "name": "Rollback", "slot": "any", "effect": {"lethalLeavesHp": 0.6, "cooldownTicks": 120}},
    {"n": 3, "id": "scroll", "name": "Infinite Scroll", "slot": "weapon", "effect": {"mainHitsNext": 0.5}},
    {"n": 4, "id": "reload", "name": "Hot-Reloading", "slot": "any", "effect": {"noCooldownChance": 0.15}},
    {"n": 5, "id": "gc", "name": "Garbage-Collected", "slot": "hoodie", "effect": {"healPerKillPct": 0.02}},
    {"n": 6, "id": "semi", "name": "Optional Semicolon", "slot": "sticker", "effect": {"critRepeatChance": 0.25}},
    {"n": 7, "id": "mug", "name": "Bottomless", "slot": "mug", "effect": {"freeCoffee": true, "refillTicksWhileQuesting": 10}},
    {"n": 8, "id": "pockets", "name": "Infinite-Pocket", "slot": "hoodie", "effect": {"itemFind": 0.2}},
    {"n": 9, "id": "stamp", "name": "Rubber-Stamped", "slot": "sticker", "effect": {"unblockedExtraTicks": 60}}
  ],
  "keepsakes": [
    {"n": 0, "id": "hazard_cone_hat", "name": "Hazard Cone Hat", "boss": 0, "slot": "hat", "effect": {"crit": 0.05, "xp": 0.05}},
    {"n": 1, "id": "curly_brace_crown", "name": "Curly Brace Crown", "boss": 1, "slot": "hat", "effect": {"rankBonus": {"main": 1, "area": 1}}},
    {"n": 2, "id": "lazy_quantifier_boots", "name": "Lazy Quantifier Boots", "boss": 2, "slot": "boots", "effect": {"cdr": 0.12}},
    {"n": 3, "id": "octo_hoodie", "name": "Octo-Hoodie", "boss": 3, "slot": "hoodie", "effect": {"areaTargets": 1}},
    {"n": 4, "id": "lockfile_mug", "name": "Lockfile Mug", "boss": 4, "slot": "mug", "effect": {"hpPct": 0.15, "coffeeHeal": 0.10}},
    {"n": 5, "id": "mutex_twinfang", "name": "Mutex Twinfang", "boss": 5, "slot": "weapon", "classAdaptive": true, "effect": {"bossDmg": 0.25}},
    {"n": 6, "id": "microservice_badge", "name": "Microservice Badge", "boss": 6, "slot": "sticker", "effect": {"dmgPerRoomAlly": 0.04, "cap": 0.16}},
    {"n": 7, "id": "weekend_pass", "name": "Weekend Pass", "boss": 7, "slot": "sticker", "effect": {"freshEyesAccrual": 0.5, "dmgWhileFreshEyes": 0.10}},
    {"n": 8, "id": "uncertainty_lens", "name": "Uncertainty Lens", "boss": 8, "slot": "hat", "effect": {"doubleCountChance": 0.12}}
  ]
}
```

### 14.7 Item bases

Ids: 0 = Training Stick; 1–25 class weapons (class order refactorer, hotfixer, shellmancer, forkbinder, rubberducker; tiers 1–5); 26–30 hats; 31–35 hoodies; 36–40 mugs; 41–45 boots; 46–50 stickers. Tier t covers item levels 1–20, 21–40, 41–60, 61–80, 81+.

```json
{
  "slotK": {"weapon": 0, "hat": 1.0, "hoodie": 2.0, "mug": 0.8, "boots": 0.7, "sticker": 0},
  "starter": {"n": 0, "slot": "weapon", "type": "stick", "name": "Training Stick", "anyClass": true},
  "weapons": {
    "blade":   ["Rusty Rename Blade", "Extract Saber", "Inline Claymore", "Abstraction Greatsword", "The Clean Slate"],
    "knives":  ["Patch Shiv", "Monkey-Patch Knife", "Hotfix Kris", "Twin Diff Daggers", "The Midnight Patch"],
    "pipe":    ["Pipe Wand", "Here-Doc Staff", "Subshell Scepter", "Daemon Rod", "Staff of Pure Functions"],
    "manpage": ["Scratchpad Tome", "Manpage Grimoire", "Shell Codex", "Kernel Folio", "The Init Scripture"],
    "duck":    ["Squeaky Duck", "Bathtub Duck", "Duck of Insight", "Brass Oracle Duck", "The Duck Who Knew"]
  },
  "armor": {
    "hat":     ["Beanie", "Headphones", "Thinking Cap", "Noise-Dampening Helm", "Crown of Inbox Zero"],
    "hoodie":  ["Swag Tee", "Zip Hoodie", "Fleece Vest", "Hackathon Jacket", "Parka of Prod"],
    "mug":     ["Paper Cup", "Chipped Mug", "Travel Thermos", "Okayest Dev Mug", "Obsidian Pour-Over"],
    "boots":   ["Socks and Sandals", "Office Slippers", "Standing-Desk Sneakers", "Commute Boots", "Treads of Uptime"],
    "sticker": ["Vinyl Sticker", "Holo Sticker", "Die-Cut Sticker", "Enamel Pin", "Conference Badge"]
  },
  "weaponTierTones": ["#8B6B4A", "#9AA3AD", "#5FB3A8", "#E8E8F0", "#2E2E3A"],
  "hatTierShapes": ["beanie", "headphones", "cap", "helm", "crown"]
}
```

### 14.8 Buildings, badges, names, palette tokens

```json
{
  "buildings": [
    {"n": 0, "id": "campfire", "name": "Campfire", "max": 10, "base": 800, "perLevel": {"freshEyesCapMin": 15}},
    {"n": 1, "id": "coffee_machine", "name": "Coffee Machine", "max": 10, "base": 800, "perLevel": {"coffeeHeal": 0.03, "coffeePrice": -0.05}},
    {"n": 2, "id": "ci_forge", "name": "CI Forge", "max": 10, "base": 1200, "perLevel": {"polishGold": -0.04}, "unlocks": {"3": "squashMerge", "5": "reroll"}},
    {"n": 3, "id": "vendor", "name": "vendor/", "max": 10, "base": 1000, "perLevel": {"stashSlots": 10}, "tooltip": "Heavier than it looks."},
    {"n": 4, "id": "docs_library", "name": "Docs Library", "max": 10, "base": 1500, "perLevel": {"herdXp": 0.02}},
    {"n": 5, "id": "war_room", "name": "War Room", "max": 5, "base": 3000, "perLevel": {"bossTimerTicks": 6}}
  ],
  "stash": {"base": 40, "max": 140},
  "bugTracker": {"tiers": [{"name": "Triaged", "kills": 500}, {"name": "Reproduced", "kills": 5000}, {"name": "Fixed", "kills": 50000}], "eliteWeight": 4},
  "trophy": {"dmg": 0.01, "hpPct": 0.01},
  "badges": [
    {"id": "hello_world", "name": "Hello, World", "when": "firstKill"},
    {"id": "first_commit", "name": "First Commit", "when": "firstChestOpened"},
    {"id": "not_found", "name": "404 Not Found", "when": "dodges>=1000"},
    {"id": "duck_whisperer", "name": "Rubber Duck Whisperer", "when": "healed>=10000"},
    {"id": "pair_programmer", "name": "Pair Programmer", "when": "guildRoomMinutes>=60"},
    {"id": "thundering_herd", "name": "Thundering Herd", "when": "concurrentWorking>=8"},
    {"id": "fully_staffed", "name": "Fully Staffed", "when": "allClasses"},
    {"id": "zero_warnings", "name": "Zero Warnings", "when": "boss0"},
    {"id": "read_only_friday", "name": "Read-Only Friday", "when": "boss7OnLocalFriday"},
    {"id": "works_when_i_dont_look", "name": "Works When I Don't Look", "when": "boss8"},
    {"id": "ten_thousand_typos", "name": "Ten Thousand Typos", "when": "zone0Fixed"},
    {"id": "principal_engineer", "name": "Principal Engineer", "when": "level100"},
    {"id": "deep_backlog", "name": "Deep Backlog", "when": "backlogFloor>=25"},
    {"id": "lucky_duck", "name": "Lucky Duck", "when": "holoDuck"}
  ],
  "names": {
    "first": ["Kip", "Nib", "Tess", "Juno", "Pax", "Rue", "Ori", "Zed", "Lumi", "Brin", "Coda", "Fen", "Ivo", "Mira", "Quill", "Sol",
              "Ada", "Bram", "Cleo", "Dex", "Echo", "Fable", "Gus", "Hana", "Ilo", "Jax", "Kaia", "Lark", "Moss", "Nell", "Otto", "Pim",
              "Quin", "Rook", "Sage", "Tobin", "Uma", "Vela", "Wren", "Xan", "Yuki", "Zara", "Alba", "Bix", "Cove", "Dot", "Elm", "Fizz",
              "Glen", "Hux", "Ines", "Jove", "Kit", "Lyle", "Mae", "Nox", "Oona", "Perl", "Rho", "Sable", "Tamsin", "Ula", "Vik", "Wynn"],
    "epithet": ["the Idempotent", "Two-Spaces", "of the Green Build", "the Rebased", "Semicolon-Sworn", "the Unblocked", "Off-By-One", "the Squashed",
                "Null-Safe", "of Many Branches", "the Linted", "Tab-Born", "the Cached", "Hot-Reloaded", "the Deterministic", "the Refactored",
                "Fast-Forward", "the Memoized", "of the Long Uptime", "the Pure", "Zero-Indexed", "the Patient", "of Clean Diffs", "the Typed",
                "Once-Deployed", "the Unflaky", "of Small Commits", "the Annotated", "the Lazy-Loaded", "Well-Documented", "the Thread-Safe", "the Sandboxed",
                "of the Quiet Logs", "the Backported", "Kernel-Kissed", "the Vectorized", "of Fewer Warnings", "the Rollbacked", "Merge-Minded", "the Async",
                "the Benchmarked", "of the Tidy Stack", "Monorepo-Raised", "the Parsed", "the Escaped", "of Good Defaults", "the Stateless", "the Shipped",
                "the Bisected", "of the Last Mile", "the Cherry-Picked", "the Unsquashed", "Lint-Free", "the Readable", "of Gentle Reviews", "the Tested",
                "the Composable", "of Short Feedback", "the Minimal", "the Portable", "of the Open Door", "the Reproducible", "the Graceful", "the Compiled"]
  },
  "palette": {
    "working": "#4CC38A", "blocked": "#F2A93B", "done": "#FFD447", "idle": "#8A8F98",
    "bubbleFill": "#FFFFFF", "bubbleInk": "#1B1B1F", "levelUp": "#7FE9F5", "xp": "#7FE9F5", "freshEyes": "#A9B8FF",
    "hp": "#FF5A5F", "danger": "#FF5A5F", "coin": "#C89B3C", "heal": "#6BE38A", "cream": "#FFF4D6",
    "termlingTint": ["#6C8CF5", "#F07D5C", "#45C2A8", "#C47BE8", "#E8B84A", "#5FB0E8", "#E86F9C", "#8FBF5A"]
  },
  "chestTiers": [
    {"id": "wooden", "minSeals": 0, "color": "#8B5E3C"}, {"id": "iron", "minSeals": 1, "color": "#9AA3AD"},
    {"id": "silver", "minSeals": 3, "color": "#CFE3F2", "floor": "alpha"}, {"id": "gold", "minSeals": 6, "color": "#FFD447", "floor": "beta"}
  ]
}
```

---

## 15. Implementation map and decision log

### 15.1 Module budget (about 3,600 lines of JS)

| Module | Lines | Contents |
|---|---|---|
| `data.js` | 700 | Section 14 tables (mostly JSON) |
| `sim/core.js` | 350 | Formulas (5, 6), reference kit, RNG (xorshift32 per hero + herd), number formatting |
| `sim/agents.js` | 300 | Snapshot reconcile, seq gating, binding, Forklings, Contractors, task model, chests, seen, Shift, Fresh Eyes, flap guard |
| `sim/combat.js` | 450 | Lanes, rotation, skill effect types (hit, proc, stacks, buff, summon, aura, healOrHit, roomRestore), traits, coffee, crash |
| `sim/boss.js` | 350 | Encounter loop, 9 mechanic primitives (spawnAdd, burstAdds, layers, burstCheck, shieldParts, grow, twinHeads, balanceCheck, split/mesh, clock, stance, pulse), reviews, estimates, Wounds and Lessons |
| `sim/economy.js` | 250 | Drops, items, affixes, auto-equip, stash, polish, port, squash, reroll, buildings, Release Train, Bug Tracker, badges |
| `sim/autopilot.js` | 120 | Map choice and convergence, auto-learn, purchases, boss and review challenges |
| `save.js` | 150 | Serialize, CRC32, atomic write, .bak, migrations |
| `ui/stage.js` | 500 | Slots, rooms, overflow, arena, sprites (SVG part rig, glyph mobs), effects, phase-locked renderer |
| `ui/sidebar.js`, `ui/nameplate.js` | 180 | Party list and pane headers |
| `ui/sheet.js`, `ui/herd.js` | 350 | Character sheet and Herd panel |
| `tools/pacing-sim.js` | (dev) | Headless persona simulator; CI regenerates the tables in 6.3, 9.5 and 12.1 and fails if they drift by more than 10% |

The reference model that produced this document's numbers (Python, same formulas) is in `tools/reference-sim/`: `model.py` and `final.py` (curves and tables), `combat4.py` (per-tick lane combat, all classes), `bosssim.py` (boss fights with coffee and crashes), `pacing4.py` (personas and bots). Port it to `tools/pacing-sim.js`.

As built: the module map is ARCHITECTURE §1 (`game/` for the engine, `game/view/` for the view models, `ui/` for the renderers, `host.js` and `main.js` for herdr), and the port is `tools/pacing-sim.mjs` (`npm run pacing`).

Per-tick cost: at most ~30 heroes × (1 action + ≤ 3 mobs) ≈ 200 small updates, plus ≤ 1 boss fight. DPS_est and Power Level are cached and recomputed only on level, gear or skill change.

### 15.2 What came from where, and what was fixed

| Decision | Source / fix |
|---|---|
| Real-signal core: Seals, chests that open when seen, Forklings drawing on the parent, behaviour-based class, "why" tooltip, bot plateau | Signals (consensus winner) |
| Termlings, glyph faces, white `!` reserved for blocked, gold reserved for done, HTTP-code combat text, SHIPPED and FIXED stamps, stillness rule, phase-locked renderer, tick micro-timeline, chest tiers, Contractors, "Help wanted" empty state, per-hero RNG | Delight |
| Boss mechanics as playable code jokes (Lock Contention, Service Mesh, branch tentacles, burst-window Anchor), win-estimate labels, promotion reviews ("You, Six Months Ago", "The Senior Reviewer"), the rare duck (renamed Holo Rubber Duck so gold stays reserved for done), digest dot, level-synced helpers, Prototype → LTS rarity names, pure simulation with CI pacing | Depth |
| First boss on day 1 for every persona | Sprint meter 6 Seals; door at map 1-3 (sim: 36 min to 1 h) |
| Boss incoming damage verified, not assumed | Bosses and reviews simulated with coffee, crashes and party sizes (9.5) |
| Seals no longer penalise long tasks | Linear 1 per 10 minutes, cap 12 (2 h) |
| Ending a terminal is not acknowledgment | Off-duty chests wait 24 h, then open Unreviewed without Seals |
| Away is never punished | Pending Seals uncapped; chests merge instead of overflowing |
| Long autonomous runs not mocked | Daily Shift softened to ×0.5 / ×0.25 on kills only; chest items never reduced; no "yawning" joke |
| Fresh Eyes is a visible bonus, not a hidden baseline | ×1.5, 60–210 minute cap, drains while working |
| Observation never hurts | Heisenbug observation is cosmetic plus a 5-tick bonus; no "Do Not Disturb" damage item |
| Damage numbers add up | Discrete lane combat with real mob HP; one action per tick |
| Regen no longer makes heroes immortal | 0.5% engaged, 2% advance; coffee matters off-level and in bosses |
| Bespoke mob traits fit the model | 14 shared traits, each a per-tick rule |
| Only behaviour picks the class; class stays provisional until 15 tasks | 4.2 |
| No failing upgrades, no "job advancement", no heirlooms, no per-mob card perks, no "Bits" | Polish always succeeds; career titles; Keepsakes; zone-level Bug Tracker perks; gold and Snippets |
| Stable layout | Slots reflow only when agents come or go (and for boss arenas); focus is a glow; no auto-rotation; blocked heroes never folded |
| Gold, `!` and crit marks never collide | Level-up and XP are cyan; crits use a starburst; banners never contain `!` |
| Humour aimed at code, not people | "Anonymous Author" ("git blame shrugs") instead of an "Original Author" |
| Synchronized wall-clock bursts removed | Midnight Batch and Cron Sprite run on per-hero phases |
| Seq gaps defined | Apply only previous → current; working → idle is a seen chest |
| `working_since` misuse | Used once, capped at 10 minutes, for Seals only |
| Overloaded "Focus" | No stat, rule or currency named focus; budget is the "Daily Shift" |
| Scope | 9 zones × 3 mobs, 5 classes × 7 skills, 9 bosses built from ~12 mechanic primitives, about 3,600 lines |
