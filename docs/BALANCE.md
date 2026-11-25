# Down the Stack: balance pass (engine balance engineer)

Every deliberate deviation from `docs/DESIGN.md`, why it was made and what it changed. The
acceptance criterion is D§12.1 (all milestones of the four personas within ±15%) and the D§12.2
bot plateau; the sustain criterion is D§5.6 / D§4.3 (0 crashes, ≤ 3 cups and 14–19 kills a minute
per on-level working hour on every map and class). Every changed D§14 number carries a
`// balance:` comment in `mods/down-the-stack/game/data.js`, and `test/formulas.test.mjs`
(`BALANCE_DEVIATIONS`) holds the list as `[design, data]` pairs, checked against both files.

Tools: `npm run pacing` (personas, bot; `--seed N`), `npm run pacing -- --sweep` (every map × class,
one working hour, the reference kit and real autopilot gear), `test/combat.test.mjs` (the sweep
with the reference kit) and `test/pacing.test.mjs` (shortened persona runs and the real-gear sweep).

## 1. Results

### 1.1 D§12.1 pacing (`npm run pacing`, seed 1; working hours per hero, days for bosses)

| Milestone | Casual before → after | Solo before → after | Typical before → after | Heavy before → after |
|---|---|---|---|---|
| Lv 5 | −20% → +0% | +0% → +0% | −15% → −7% | −10% → +9% |
| Lv 10 | −23% → −9% | −23% → −3% | −29% → −10% | −17% → −8% |
| Boss 1 | +10% → +8% | +2% → +1% | −15% → +1% | +10% → +1% |
| Lv 20 | −9% → −4% | −5% → 0% | +3% → −8% | −4% → −3% |
| Lv 30 | −22% → −3% | −21% → +0% | −14% → −7% | −16% → −5% |
| Boss 4 (day) | 10 vs 14 → 13 vs 14 | 6 vs 8 → 7 vs 8 | 8 vs 10 → 9 vs 10 | 4 vs 5 → 5 vs 5 |
| Lv 50 | −31% → −2% | −31% → −7% | −28% → −4% | −28% → −1% |
| Lv 60 | −31% → +2% | −35% → −4% | −29% → −6% | −29% → +5% |
| Boss 7 (day) | 47 vs 67 → 65 vs 67 | 24 vs 38 → 36 vs 38 | 34 vs 46 → 45 vs 46 | 17 vs 22 → 24 vs 22 |
| Lv 90 | −32% → −8% | −35% → −3% | −32% → −5% | −31% → +1% |
| Boss 9 (day) | 108 vs 146 → 135 vs 146 | 56 vs 77 → 74 vs 77 | 73 vs 98 → 93 vs 98 | 36 vs 48 → 50 vs 48 |
| Lv 100 | −33% (162 h) → −10% (216.5 h) | −33% (169 h) → −7% (235.0 h) | −32% (147 h) → −9% (195.3 h) | −31% (180 h) → −1% (256.8 h) |
| Milestones off (of 17) | 14 → 0 | 13 → 0 | 11 → 0 | 10 → 0 |

The always-working bot (D§12.2: Lv 19 / 23 / 28 / 33 on days 1 / 7 / 30 / 90): before Lv 21 / 25 /
36, after Lv 21 / 24 / 28 / 35 (`--persona bot --long`: day 90 Lv 35 vs 33).

Robustness (seeds 1–4, all four personas, 68 milestones each): 0 of 68 off for every persona (worst: Typical L100 −12% on seed 2, Casual L100 −11% on seed 3, Solo L50 −12% on seed 4, Heavy Boss 6 +14% on seed 1; boss days all within ±15% or one day).

The "design" hours are pacing4.py's unrounded values (`DESIGN` in `tools/pacing-sim.mjs`): D§12.1
prints them rounded to 0.1 h or whole minutes ("12 min" is 0.2 h; typical Lv 5 is really 11 min and
Boss 1 for three or five agents 34 / 33 min, not 36), and a 0.05 h rounding is a third of the ±15%
on the first milestones.

### 1.2 Sustain sweep (one on-level working hour per case; 27 maps × 5 classes, the Intern on zone 1, the Backlog)

| Reference kit (D§5.2), 133 cases | before | after |
|---|---|---|
| cases with crashes | 23 (5-3 Hotfixer 109/h, Forkbinder 102/h, Refactorer 46/h; Backlog Hotfixer 40/h; 2-2 13–14/h) | 0 |
| cases over 3 cups/h | 54 (20 cups = the whole pack, on 2-2, 2-3, 3-2, 5-2, 5-3, 6-3, 7-2, 9-3, ...) | 0 |
| kill pace outside 14–19 on-level kills/min | 41 (2-2: 9–11) | 0 (mean 15.7; slowest Hotfixer 7-1 14.1, fastest Shellmancer Backlog 18.2) |

Real autopilot gear (the typical persona's, median kit within ±2 levels): 133 cases, 0 crashes, 0 over 3 cups/h (a bare Lv 6 Intern on 1-2: 0 after the Semicolon Sloth's ATK change, 6 before; worst 3, a Forkbinder on 4-2), mean 15.8, every case within 10–25 kills/min (gear spread: 11.3 on 4-3 for a Forkbinder, 21.6 on 7-1 for a Shellmancer); `npm run pacing -- --sweep` exits 0.

"Kills a minute" counts on-level kill equivalents (kill XP / (mobXP(map mid) × gap)): a swarm half
counts what it pays, a tanky mob more; the pacing model's `KPM × mobXP(mid)` is exactly this unit.

## 2. Sustain (D§5.5, D§5.6, D§9.4)

| Change | Design | Now | Why |
|---|---|---|---|
| Swing timer start | the engaged mob swings on the tick it is first hit | on the tick after the first hit that *lands* (`T.lane.firstSwingDelay` 1, new) | A 403 (Promise Wisp) or 404 (phaser) started the timer: map 2-2 cost 15–26 crashes/h. Landing is the fix the reviewers asked for; the one-tick delay is the sustain fix: with the D§5.4 swing (3% of max HP after DR) a 3–4-action kill cost two swings against 3.5% regen, so Shellmancer/Forkbinder/Hotfixer drank 5–20 cups an hour on *plain* on-level maps (the reference simulator's 0–4 was right at the edge). With the delay on-level is safe (0 cups), +3 levels costs 0–20 cups/h and +5 levels still runs out of coffee and crashes, the D§5.6 gradient. |
| thorns (Version Pin Porcupine, 5-3) | reflects 8% of melee damage taken, unmitigated, from every hit | 3%, as one hit per tick through dodge, Stealth Commit, DR (against the mob's level) and damage-taken modifiers, at most 0.4% max HP a tick (`TRAITS.thorns.capPerTick`, new); summons, Forklings and the summoner class (its hits are imps) never trigger it. A dodged reflection is no dodged attack: it does not count towards 404 Not Found and Zero Downtime does not heal on it (`combat.hitHero` `reflect`) | 8% unmitigated of a hero's whole output was 1.3× the mob's own swing: 46–109 crashes/h. At 3% / 0.4% the melee classes take ~a fifth more than on a plain map; 0 cups. Through dodge, a dodged reflection healed 1% max HP: at the 30% dodge cap the spikes became a net heal for a Zero Downtime Hotfixer. |
| pending (Promise Wisp, 2-2) | invulnerable for its first 2 *engaged* ticks | its first 2 ticks *in the lane*, engaged or not | Queued Wisps also swallowed every area hit, so 2-2 ran at 9–11 kills/min whatever the class. The "…" ring still shows on arrival and a Wisp engaged at once still 403s. |
| Mob ATK multipliers | Typo Sprout 1.0, Semicolon Sloth 1.4, Unused Import 0.8, Transitive Vine 1.0, Starved Thread 1.8, Anonymous Author 1.1 | 0.7, 0.8, 0.5, 0.9, 1.55, 1.0 | Interns wear no armour (real Interns have 64–84% of the reference EHP until their first chests), so zone 1 drank 13–20 cups/h with real gear (the sloth at 0.9 still cost a bare Lv 6 Intern 6 cups/h; 0.8: 0–2); slow mobs now swing once in a 3–4-action kill (the delay) and were tuned on that; the vine (grower) and the author (ranged) were the last two maps over 3 cups for Forkbinders. |
| Backlog floor (autopilot) | deepest floor with effective level ≤ PL + 1 | also ≤ 1 + ln(EHP / refEHP(100)) / ln 1.05 | Floor f hits 1.05^f harder; PL alone sent Hotfixers (PL ≈ L + 8, least HP) to floor 10 to crash. |

## 3. Kill pace (D§4.3, D§5.5, D§9.3)

D§9.3 says the mob multipliers already include the traits' effect on pace; measured with the
reference kit they did not (2-2 at 10, swarm maps 12–14, tanky / slow / ranged maps 18–21 on-level
kills a minute). The **XP multipliers** were re-fitted so that every mob's own map runs at about
15.5 for the class average (`tools/pacing-sim.mjs sweepCase` on single-mob maps; the reference
kit's sweep mean is 15.6), zone 1 nudged for the Lv 5 / Lv 10 milestones:

| Mob | design XP | now | | Mob | design XP | now |
|---|---|---|---|---|---|---|
| Typo Sprout | 1 | 0.88 | | Version Pin Porcupine | 1.3 | 1.1 |
| Semicolon Sloth | 1.2 | 0.86 | | Race Condition Rats | 0.6 | 0.64 |
| Unused Import | 1.4 | 1.47 | | Spinlock Top | 1 | 1.02 |
| Callback Bat | 0.9 | 0.81 | | Starved Thread | 1.2 | 0.92 |
| Promise Wisp | 1.1 | 1.16 | | TODO Ghost | 0.9 | 0.88 |
| Null Pointer Frog | 1.1 | 0.96 | | Anonymous Author | 1 | 0.82 |
| Capture Group Goblins | 0.6 | 0.66 | | Spaghetti Mummy | 1.5 | 1.24 |
| Backslash Bandit | 1 | 1.07 | | Flaky Test Phantom | 1.1 | 1.08 |
| Greedy Glob | 1.3 | 1.11 | | Memory Leak Slime | 1.2 | 1.09 |
| Diff Leech | 0.9 | 0.86 | | Pager Wyvern | 1.1 | 0.84 |
| Rebase Wraith | 1.2 | 1.01 | | Off-By-One Twins | 0.45 | 0.54 |
| Merge Conflict Golem | 1.6 | 1.33 | | Bitflip Moth | 1 | 0.97 |
| Left-Pad Mites | 0.5 | 0.56 | | Undefined Behavior | 1.4 | 1.05 |
| Transitive Vine | 1.2 | 1.11 | |  |  |  |

The class spread is D§4.3's (Shellmancer fastest, Hotfixer slowest, ~1.2×), so the band 14–19 only
holds with the class mean near 15.5–16 (the slowest, a Hotfixer on 7-1 / 8-3 / 9-3, runs 14.1–14.3; Anonymous Author and Pager Wyvern got +3% XP so that 7-2 and 8-3 stay above 14).

## 4. Loot: real autopilot gear back to the reference kit (D§5.2, D§8)

Before: autopilot heroes wore 1.4–2× the reference kit's DPS (Release with 3–4 affixes in every slot
by Lv 25, every item polished to its rarity's max, damage affixes 2–3× D_ref), 19–30 kills/min.
After: real gear averages **dps ≈ 1.0×, EHP ≈ 0.9–1.0×** the reference kit (spread 0.5–2×: Keepsakes,
LTS, the review weapons), measured on every hero of every persona (`gearRecorder`).

| Change | Design | Now | Why |
|---|---|---|---|
| Drop item levels (`items.dropIlvl`, `T.loot`) | kill/elite m + U{0,1}; chest map top + U{0,1,2}; duck m + 2; boss/review as given | kill, elite, chest and duck drops lowered by `ilvlOffset` −6, fading linearly to 0 between Lv 50 and 100 (`taperFrom` 50); boss and review rewards keep Lb / L as given (`boss.winFight`, `items.rollReviewReward`; Keepsakes the boss level) | A chest landed 4–5 levels above iRef(L) = L − 2; with best-of-many selection that is far above the reference kit. Past Lv ~60 R_ref × P_ref outgrows any Beta/Release polish (Release +9 < P_ref(100) = +10), so the offset fades. A boss or review reward is a few items a week; at Lb it is the prize of the fight. |
| Affix ranges (D§8.3) | Memoized 2–4%, Linted 1–2%, Optimized 5–10%, Async 0.5–1%, Recursive 1–2%, Vectorized 3–6%, Blameless 3–6%, Green Build 1–2%, Caching 3–6%, Tab Completion 2–4%, Hot Reload 2–4%, Graceful Degradation 4–8% (× t) | all halved | 3–4 affixes on most worn items: worn damage% ran 0.5–0.9 at Lv 80 against D_ref = 0.24. Defensive affixes (Typed, Robust, Uptime, Idempotence, Rate Limiting) keep the design ranges: with them halved real gear sat at 0.8 of the reference EHP and drank on 5-3 / 8-x. |
| Autopilot polish (D§8.8) | one item per 60 ticks, up to the rarity's max, whenever gold ≥ 5× cost | the same, but only up to `polishTarget` = ceil(L / 10) (D§5.2's P_ref, p ≈ L/10), and never a weapon of another class's type (target 0); manual polish is unchanged | Gold is never short: every worn item sat at +7..+10 by Lv 25. An off-class weapon (left in hand by a provisional class switch or a Career Change) is swung as a Training Stick, so its polish did nothing, and it was usually the lowest-polished item, so autopilot picked it first. |
| The Training Stick | grows with its Intern until Lv 10 | grows (iRef(L)) as long as the hero holds it | With drops at iRef a Junior's first class weapon can take a while; a frozen iLvl-8 stick held Lv 13–15 heroes in Lint Meadows. |
| Map choice weapon lag (ARCHITECTURE §9.9) | a weapon lagging the reference weapon moved the hero up to 2 levels down | no longer: the deepest open map with mid ≤ L + 1 (L after a crash in the last 10 minutes; the crash rule still drops a map) | With drops at iRef a weapon a few levels behind is normal; one-agent herds sat a map low for days and missed the quota on the zone's last map that opens the boss door (Boss 5–7 a week late on some seeds). |
| Guild convergence (D§2.8, `autopilot.CONVERGE_BELOW`) | a hero moves down to its guild-mates' map if that map is at most one map below its own choice | the same, but only to a map whose mid is at least L − 4 | A hero far above that map farmed at a heavy gap penalty to keep a lagging mate company, and a guild held there stopped feeding the frontier map's quota: a 10-day stall in `tools/pacing-sim.mjs`. |
| A weapon of another class's type (left in hand by a free provisional switch or a Career Change, D§4.2) | the design does not say; weapons are class-typed (D§8.1) | swung like a Training Stick of its item level (no rarity, polish, affixes or property; `heroes.combine`); autopilot treats the slot as empty (`items.isUpgrade`: any usable class weapon that is no worse goes on) and the switch runs the targeted equip sweep the same tick (`agents.closeTask`) | It counted for nothing: a Lv 12 hero that switched for free fought bare-handed (3 g(L): weapon damage 15.0 → 6.3, Power Level 12 → 7) until a class weapon dropped, possibly on every qualifying task until the class locked. |

## 5. XP sources the D§12.1 model does not have

| Change | Design | Now | Why |
|---|---|---|---|
| Boss XP (D§6.2, `T.boss.xpFirst / xpRepeat`) | 0.5 Need(L) first kill (and per review), 0.1 Need(L) per repeat | 0.1 and 0.02 | pacing4.py has no boss XP; with nine first kills, two reviews and farming every 3 working hours per boss it added 8–29% of a hero's XP from Lv 50 on. |
| Boss XP and the level gap (`boss.winFight`) | no gap factor | × gap(L − Lb) like kill XP (D§6.1, so out-levelled kills fall to the 0.03 floor); Backlog bosses have no gap (D§9.8) | Farming long-beaten bosses (D§9.5 repeat kills, with Answer-calls helpers far above them) otherwise paid on-level XP for trivial fights. |
| Gap floor (D§6.1) | 0.1 | 0.03 | The model's bot fights at 15.5 kills/min; an out-levelled engine hero one-shots three mobs a tick (≈ 50/min, a Senior Review weapon does the rest), so at 10% XP per kill the bot was Lv 36 on day 30 (design 28). 0.03 per kill ≈ 10% of the model's XP a minute. Only out-levelled farming feels it. |

## 6. Fresh Eyes (D§2.9, D§10.2)

| Change | Design | Now | Why |
|---|---|---|---|
| Campfire levels (`T.campfireDaysPerLevel` 6, `herd.buildingGate`) | bought like any building (cheapest first) | level n opens on the herd's day 6n (`herd.born`, kept by `world.tick`; `herdAgeDays`) | The model's Fresh Eyes cap is 60 + 15 × ⌊day/6⌋. Real gold bought Campfire 6–10 within days, so from Lv 25 Fresh Eyes covered whole sessions (×1.5 kill XP) where the model had 30–60%. Persona gold differs 17× (one agent 1.5 h vs five 5 h), so no price fits; the herd's age does. `buy` answers "Campfire 3 opens on the herd's day 18 (day 9 now)". |
| Fresh Eyes in boss fights | drains 1 min per working minute | now also in fights (it only drained in lanes) | bug |

## 7. Bosses (D§9.5, D§9.6)

| Boss | design Bk | now | Why |
|---|---|---|---|
| The Deadlock Hydra | 32 | 29 | The hardest relative to the model (+10–17% days late for every persona). |
| The Monolith | 32 | 28 | Estimate ≥ 1 only at Lb − 1 for a solo Shellmancer (the model: Lb − 3 with trophies). |

Solo on-level win times stay in D§9.5's 80–140 ticks ±25% for every class (the shortest: The
Friday Deploy, Hotfixer ~62; the longest: The Catastrophic Backtracker, Forkbinder ~164).

| Change | Design | Now | Why |
|---|---|---|---|
| Auto-boss threshold (`T.boss.autoAt`) | challenges at estimate E ≥ 1.0 (D§9.5); promotion reviews at E ≥ 100% (D§4.5) | E ≥ 0.9 for both, the frontier boss and the Senior / Staff Reviews (`autopilot.autoChallenge`; the estimate keeps its 0.85 margin, so ≥ 1.06 of the raw need) | With gear near the reference kit a lone hero's E creeps up ~1% a level once its gear stalls (casual: 0.93 at Lb − 3, 0.98 at Lb) and autopilot never tried, so a Lessons Learned that would win the next attempt (D§9.5) never came: Boss 4–6 a week late on some seeds. Repeat-kill farming keeps E ≥ 1.5. |
| The Octopus Merge's tentacles (D§9.6) | "a cut tentacle regrows after 20 ticks (12 once the body is below 40%)": a timer per tentacle | cut tentacles regrow one at a time, one every 20 / 12 ticks (`boss.js` KITS.octopus_merge) | With a timer per tentacle 8 × 5% of the body regrowing every 20 ticks outpaced any solo hero and a trio: the fight could not be won, against D§9.5's 80–140 ticks and mech 0.75. |
| Bloatodon's installs (D§9.6) | every 12 ticks "+4% max HP and a 4% heal" | +4% of the starting pool as max HP (the raised cap starts empty) and a heal of 4% of the HP it has left; installing stops at 10 deps ("Install complete", the enrage) | A 4%-of-max heal every 12 ticks out-healed a third of an on-level hero's damage and no solo class but the Hotfixer finished in 180 ticks (D§9.5 expects 80–140 and mech 0.8). |
| A suspended fight (D§9.5) | resumes "until a participant works in the zone again" | a saved participant Questing in the fight's zone resumes it (and one Questing elsewhere drops out of it); a saved Answer-calls helper resumes it from anywhere, as it joined (`boss.resumeFight`) | Any participant Questing anywhere used to resume it and pulled a hero pinned to another zone into the fight; but repeat-kill fights are mostly helpers, and with the zone rule alone they stayed paused for days and blocked every other farm fight. |
| A paused repeat (farm) fight and the Backlog (D§9.5, D§9.8) | a suspended fight waits for a participant in its zone | the frontier boss or a Backlog boss floor (E ≥ autoAt) displaces a paused repeat fight, which closes as a Postmortem with its Wounds kept (`autopilot.autoChallenge`); a paused frontier or Backlog fight still waits. A hero who leaves the roster (retired, or let go for a new hire) leaves a paused fight, and the last one out closes it as a Postmortem (`boss.leaveSavedFight`); Contractor ids are dropped from it on load | In the end-game nobody stands in a beaten boss's zone again: a farm fight paused there (its participant retired, or questing in the Backlog) never resumed, and with no frontier boss left to displace it, it held up farming and every Backlog boss floor for good (D§11.16: nothing needed to progress). |

## 8. Simulator (`tools/pacing-sim.mjs`)

- Targets are pacing4.py's unrounded hours (section 1.1).
- Agents of a herd start 5% of a task length apart (was 15%): the model runs a herd's heroes in
  lockstep, and with 15% a five-agent herd's first hero waited a quarter of an hour for its last
  guild-mate (guild convergence, D§2.8) and Heavy's Lv 10 / Boss 1 ran 15–20% late.
- `--sweep`, `sweep()`, `sweepCase()`, `fullRefKit()` (the complete D§5.2 kit: since the affix
  ranges were halved, test/helpers/engine.mjs `refKit` cannot carry a whole reference bonus in one
  affix), `gearRecorder()` / `harvestGear()` / `autoKit()` (real autopilot gear).

## 9. Other engine fixes in this pass

- **Read-only worlds** (a save from a newer version) reconcile for display only: no hires (new agents
  play as unsaved Contractors), no chest drops or openings, no Unblocked, no XP.
- **Clock behind by less than an hour**: the snapshot is still reconciled with zero steps (statuses,
  bindings, chests seen), accrual waits for the clock to pass the last tick; more than an hour resyncs.
- **Digest** (D§10.7) is snapshot-based: `digestSeen` records every hero's level, boss kills, credited
  Seals, notable drops (`herd.drops`, counted by `logDrop`) and badges (`herd.digestSnap`); the digest
  diffs against it and uses the journal only for details. Extra output fields: `levels[].from`,
  `dropsMore`, `shippedMore`, `bossesMore`, `sealsShipped`.
- **Chest items** are rolled when a chest opens and wait in `herd.inbox` (saved), one offered to the
  roster per `world.tick` (`agents.drainInbox`); `autopilot.offerDrop` no longer re-scores heroes that
  already declined an item. A 240-item chest with 30 heroes: claim ~3 ms, ticks median ~0.4 ms, p99
  ~2–3 ms (V8).
- **The Ignored Warning**'s "+1 warning (n)" stays up for 3 ticks (it was overwritten in the same tick).
- **herdr's seen flip**: herdr bumps an agent's seq only when the core's status word changes
  (`src/model.rs` `set_word`); done ↔ idle is its seen flag (`mark_seen`, `set_turn`) and keeps the
  seq, so `agents.processTops` re-reads that one change at the same seq (`isSeenFlip`). The scripted
  agents (`demo.js`, the tests' Sim, so `tools/pacing-sim.mjs`) model it: no seq bump on done ↔ idle.
  Pacing results are unchanged (the sim's done → idle used to bump seq and land in the same place).
- **Offline gaps settle after reconcile** (`world.tick`): agents that outlived the app are live again,
  so their chests are not off-duty chests and a Waiting hero earns no Fresh Eyes; a first listing
  that is empty after an app start holds the gap for up to 10 ticks (`rt.offlineHold`). The hold is
  memory only, so a save written during it (a close within those seconds flushes one) records the
  gap as not yet seen (`world.serialize` writes `lastMs` minus the held gap): a restart or a hot
  reload then finds the gap again instead of losing its Fresh Eyes (`test/world.test.mjs`).
- **The blocked clock is wall-clock time** (`agents.blockedSec`, `syncClocks`): an offline gap or
  dropped catch-up seconds count towards Unblocked's 10 s and the "! 15m" tag.
- **Effects age per `world.tick` call** (`settleFx`): a pump that runs 2 steps shows all its effects
  at age 0 (D§11.7's per-frame number caps applied across the steps) and keeps the last call's fade.
- A pane closed inside the 8-tick close after working → idle opens its chest as watched.
- **Tick cost in QuickJS** (ARCHITECTURE §2.5, `npm run qjs`'s 30-hero stress world, a wasm
  interpreter): the XP tooltip numbers (`live.why`, `agents.whyOf`) refresh every 5 ticks with the
  heroes taking turns by id (a fifth of the herd a tick, was all of it on every 5th tick), and their
  party counts come from one pass over the herd kept for the tick (`rt.whyRooms`; was a scan of the
  herd per hero). `heroes.stats` checks its cache without allocating and keeps the Bug Tracker
  tiers for the last kill counts seen; `world.makeEmitter` stamps effects in place and keeps the
  hero-to-room map while `rt.rooms` is unchanged; `agents.attachForklings` skips heroes without
  Forklings. Saves, effects, pacing and the sweep are unchanged (only the tooltip refresh moved);
  stress-world ticks over 600 s, five interleaved runs each on a machine shared with other work:
  p95 7.1–9.6 → 6.0–7.1 ms (median 8.5 → 6.3), mean 5.3 → 5.0 ms (medians), and the every-5th-tick
  spike (+2.7 ms) is gone. The ~5 ms target is still missed by the interpreter (section 11).

## 10. Save contents

| Change | Design | Now | Why |
|---|---|---|---|
| Journal length (`logMax`, in `formulas.js`; re-exported by `herd.js`, also used by `items.js`'s own journal lines) | D§13.3: capped at 60 entries (≈ 3 KB) | 120 entries up to 20 heroes, 6 fewer for each hero past 20, so D§13.3's 60 from 30 heroes (`herd.LOG_MAX` 120). A line with a 40-character text takes ≈ 57 B (`test/herd.test.mjs`: 60 more lines, 3.3 KB more); its kind, and a text used twice, are indexes into the string table (below). D§13.3's worst case (30 heroes in full gear, 140 stash items) keeps 60 lines: 27.0 KB (`test/herd.test.mjs`; 28.4 KB before the string table held journal strings); with a flat 120 distinct lines it would be 30.3 KB (32.0 KB). | D§11.13 promises a hero's Journal tab "the last 30 events"; 60 lines covered 55–180 minutes of a four-agent herd, 12–17 lines a hero. |
| The string table (`save.js` `str`) | D§13.2: seats and names inline | every string used more than once in the save goes into the top-level `str` table, written as its index: seats, space ids, pane and tab names (as before), and now pending-chest titles and the journal's kinds and texts. Saves written before load unchanged (their slots hold strings; a non-string is boxed so it never reads as an index), SAVE_VERSION stays 1 (`test/fixtures/saves` holds a save of every format this branch wrote). | platform-save-6: a 30-hero herd left alone for ~11 h went over 30 KB (stress30: 31.9 KB at 40,000 s; now 28.6 KB, and 28.8 KB at 80,000 s), and 30 × 20 pending chests took 61.0 KB (now 39.2 KB). Pacing personas at the end of their run: Casual 13.7 → 11.4 KB, Solo 14.1 → 12.0 KB, Typical 15.9 → 13.5 KB, Heavy 25.9 → 23.3 KB. D§13.3 lists every measurement. |
| First-clear dates (D§10.5) | from the journal | `herd.bossAt` (epoch seconds per boss, set once by `boss.winFight` / `world.tick`, saved on the generic path) | The "FIXED" line rolls out of the journal within hours; the bosses tab lost the date. |

## 11. Known limits

- The 30-hero stress world's tick p95 in `npm run qjs` (QuickJS-ng as a wasm interpreter, no JIT)
  stays above ARCHITECTURE §2.5's ~5 ms (5.4–7 ms from run to run; median ~4.3 ms, of which
  ~2.3 ms is the lane combat of ~27 questing heroes, `combat.stepRoom`). herdr 0.1.17 runs the same
  kind of engine: quickjs-jit's plain interpreter, with its JIT tier left out (`window.rs:518` →
  gpui-shell `engine/quickjs/mod.rs:1787-1801`, `build_interpreter()`), compiled natively rather
  than to wasm, so its ticks should be somewhat faster than these but not by a JIT's margin (not
  measured: herdr is never run here). V8 runs the same ticks at a median of 0.3–0.4 ms (p95
  0.9–1.2 ms).

- Real loot is lumpy: one herd's worn gear swings between 0.5× and 2× the reference kit (a Keepsake
  or an LTS weapon, a stretch without a class weapon), so with real gear the kill pace of a given map
  ranges about 11–24 per minute around a mean of ~16, against the reference kit's 14–19.
- Persona results move by a few percent from seed to seed (boss days by a day or two); seed 1 is the
  one `npm run pacing` and the tests use.

## 12. Round 4 (engine)

The owner's decisions and the fixes from the real-herdr screenshots. None of them changes a number
of the balance: `npm run pacing` gives the same milestones, day for day and hour for hour, and
`npm run pacing -- --sweep` the same 133 + 133 cases (the personas never hire a seventh hero in a
day, so no Contractor ever plays in them).

| Change | Before | Now | Why |
|---|---|---|---|
| The Semicolon Sloth (map 1-2, the slow mob of Lint Meadows; id `semicolon_sloth`) | the Semicolon Snail (`semicolon_snail`), a `;` shell leaving a dotted trail | a sleepy sloth crawling low, a `;` marked on its back, long pale claws; flavour "Optional in some regions. Gets there eventually."; glyph `;`. HP 1.3, ATK 0.8, XP 0.86, gold 1, trait slow, size S: every number as before | Originality: a snail as one of the first things a hero fights echoes a famous game's starter monsters. Mob ids are never saved, so the id changed with it; `MOB_BY_ID.semicolon_snail` still resolves to the sloth (not enumerable, never spawned) for a stale reference. The other early mobs were checked (`test/art.test.mjs`): a seedling, the sloth, a sleeping imp, a bat, a cocoon wisp and a frog; no snail, mushroom, slime or pig in the first two zones (Memory Leak Slime fights in zone 8) |
| Contractor promotion (owner decision 1, "promote only") | a Contractor played until its agent left; only a new terminal could take a freed hire | a live Contractor joins the roster when hiring reopens: the 04:00 game day turn, or a slot freeing (a retire promotes at once; a hero below Lv 10 going off duty on a full roster lets the line in, as it would a new agent, from the next snapshot on: in the snapshot its terminal ended in, a replacement terminal takes it back first, D§3.2 step 2). Longest-running first, within the day's 6 hires and the rules for a new hire (D§3.2 step 3, D§3.4), before any newcomer of the same reconcile. It keeps its name, level, XP, class, skills, stats, pending chests, seat and terminal; its reference kit becomes saved Alpha items with new uids; journal "hired": "Hired: <name> (was a contractor)" (value: its level) and a header note. `agents.hireOutlook` tells the views when (`soon`, `day` with the next 04:00, `slot`, `never`) | Six heroes a day, day one included, left 26 of the owner's 32 agents as Contractors for good |
| Journal lines name their hero | `[at, kind, heroId, text, value]`; the Digest looked the name up in the roster, so a Contractor's or a hero let go's line read "A hero" | `[at, kind, heroId, text, value, name]` for every line about a hero (`herd.lineName`: the roster's name now, else the stored one); a reload sets Contractor ids in the journal to 0 (they were that session's only) | The Digest said "A hero shipped …" for the Contractors' work. Save size: the names are written inline until `save.js` puts the sixth column in its string table: persona saves at the end of their run 11.7 / 12.3 / 13.8 / 23.9 KB → 13.4 / 13.9 / 15.5 / 25.6 KB inline, 11.8 / 12.5 / 14.1 / 24.2 KB with the table (measured with the three-line `save.js` change) |
| Unseen losses | the Herd dot lit while an off-duty chest was within 4 h of opening Unreviewed, and went dark the moment it opened | a chest opening Unreviewed (24 h off duty, a hero let go, a Contractor leaving) raises a header note at once ("<name>: a chest opened Unreviewed (half value)") and adds to `herd.unseenUnrev` (saved), which lights the Herd dot (`herd.digestDot`) until the Digest is viewed: the `lossesSeen` command (the Digest shown) or `digestSeen` (Mark as read) set it to 0. A save from before the count counts the journal's Unreviewed lines since the last read | Round 3's critic: the dot went dark exactly when the loss happened |
| Titles that repeat the place | a terminal titled after its folder became the Quest name ("Shipped “rnd-qa”") | `tellingTitle` rejects a title that only repeats the agent's space, tab or pane name (trimmed, any case, without the status glyph); the exact pane or named-tab name passes as itself (the label's fallback), the engine's Quest names and chest titles (`questName`) never take one; off duty, the hero's last seat, tab and pane count | Claude Code titles its terminal after the folder, which herdr names the space after too |
| Seats on other machines | `space/program` for every machine: same-named spaces on two machines shared seats and benched heroes | `space@machine/program` for a space on another machine (`agents.machineOf`: a snapshot `machine`, else the machine prefix herdr puts on remote space ids and addresses); this computer's seats are byte-identical. A hero last seen on another machine never goes to an agent of this one; an older save's remote hero is re-keyed by its space id | Round 3's critic |

