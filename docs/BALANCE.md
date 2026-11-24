# Down the Stack: balance pass (engine balance engineer)

Every deliberate deviation from `docs/DESIGN.md`, why it was made and what it changed. The
acceptance criterion is D§12.1 (all milestones of the four personas within ±15%) and the D§12.2
bot plateau; the sustain criterion is D§5.6 / D§4.3 (0 crashes, ≤ 3 cups and 14–19 kills a minute
per on-level working hour on every map and class). Every changed D§14 number carries a
`// balance:` comment in `mods/mapledr/game/data.js`, and `test/formulas.test.mjs`
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

Real autopilot gear (the typical persona's, median kit within ±2 levels): 133 cases, 0 crashes, 0 over 3 cups/h (a bare Lv 6 Intern on 1-2: 0 after the snail change, 6 before; worst 3, a Forkbinder on 4-2), mean 15.8, every case within 10–25 kills/min (gear spread: 11.3 on 4-3 for a Forkbinder, 21.6 on 7-1 for a Shellmancer); `npm run pacing -- --sweep` exits 0.

"Kills a minute" counts on-level kill equivalents (kill XP / (mobXP(map mid) × gap)): a swarm half
counts what it pays, a tanky mob more; the pacing model's `KPM × mobXP(mid)` is exactly this unit.

## 2. Sustain (D§5.5, D§5.6, D§9.4)

| Change | Design | Now | Why |
|---|---|---|---|
| Swing timer start | the engaged mob swings on the tick it is first hit | on the tick after the first hit that *lands* (`T.lane.firstSwingDelay` 1, new) | A 403 (Promise Wisp) or 404 (phaser) started the timer: map 2-2 cost 15–26 crashes/h. Landing is the fix the reviewers asked for; the one-tick delay is the sustain fix: with the D§5.4 swing (3% of max HP after DR) a 3–4-action kill cost two swings against 3.5% regen, so Shellmancer/Forkbinder/Hotfixer drank 5–20 cups an hour on *plain* on-level maps (the reference simulator's 0–4 was right at the edge). With the delay on-level is safe (0 cups), +3 levels costs 0–20 cups/h and +5 levels still runs out of coffee and crashes, the D§5.6 gradient. |
| thorns (Version Pin Porcupine, 5-3) | reflects 8% of melee damage taken, unmitigated, from every hit | 3%, as one hit per tick through dodge, Stealth Commit, DR (against the mob's level) and damage-taken modifiers, at most 0.4% max HP a tick (`TRAITS.thorns.capPerTick`, new); summons, Forklings and the summoner class (its hits are imps) never trigger it | 8% unmitigated of a hero's whole output was 1.3× the mob's own swing: 46–109 crashes/h. At 3% / 0.4% the melee classes take ~a fifth more than on a plain map; 0 cups. |
| pending (Promise Wisp, 2-2) | invulnerable for its first 2 *engaged* ticks | its first 2 ticks *in the lane*, engaged or not | Queued Wisps also swallowed every area hit, so 2-2 ran at 9–11 kills/min whatever the class. The "…" ring still shows on arrival and a Wisp engaged at once still 403s. |
| Mob ATK multipliers | Typo Sprout 1.0, Semicolon Snail 1.4, Unused Import 0.8, Transitive Vine 1.0, Starved Thread 1.8, Anonymous Author 1.1 | 0.7, 0.8, 0.5, 0.9, 1.55, 1.0 | Interns wear no armour (real Interns have 64–84% of the reference EHP until their first chests), so zone 1 drank 13–20 cups/h with real gear (the snail at 0.9 still cost a bare Lv 6 Intern 6 cups/h; 0.8: 0–2); slow mobs now swing once in a 3–4-action kill (the delay) and were tuned on that; the vine (grower) and the author (ranged) were the last two maps over 3 cups for Forkbinders. |
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
| Semicolon Snail | 1.2 | 0.86 | | Race Condition Rats | 0.6 | 0.64 |
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
| Drop item levels (`items.dropIlvl`, `T.loot`) | kill/elite m + U{0,1}; chest map top + U{0,1,2}; duck m + 2; boss/review as given | each lowered by `ilvlOffset` −6, fading linearly to 0 between Lv 50 and 100 (`taperFrom` 50) | A chest landed 4–5 levels above iRef(L) = L − 2; with best-of-many selection that is far above the reference kit. Past Lv ~60 R_ref × P_ref outgrows any Beta/Release polish (Release +9 < P_ref(100) = +10), so the offset fades. |
| Affix ranges (D§8.3) | Memoized 2–4%, Linted 1–2%, Optimized 5–10%, Async 0.5–1%, Recursive 1–2%, Vectorized 3–6%, Blameless 3–6%, Green Build 1–2%, Caching 3–6%, Tab Completion 2–4%, Hot Reload 2–4%, Graceful Degradation 4–8% (× t) | all halved | 3–4 affixes on most worn items: worn damage% ran 0.5–0.9 at Lv 80 against D_ref = 0.24. Defensive affixes (Typed, Robust, Uptime, Idempotence, Rate Limiting) keep the design ranges: with them halved real gear sat at 0.8 of the reference EHP and drank on 5-3 / 8-x. |
| Autopilot polish (D§8.8) | one item per 60 ticks, up to the rarity's max, whenever gold ≥ 5× cost | the same, but only up to `polishTarget` = ceil(L / 10) (D§5.2's P_ref, p ≈ L/10); manual polish is unchanged | Gold is never short: every worn item sat at +7..+10 by Lv 25. |
| The Training Stick | grows with its Intern until Lv 10 | grows (iRef(L)) as long as the hero holds it | With drops at iRef a Junior's first class weapon can take a while; a frozen iLvl-8 stick held Lv 13–15 heroes in Lint Meadows. |
| Map choice weapon lag (ARCHITECTURE §9.9) | a weapon lagging the reference weapon moved the hero up to 2 levels down | no longer: the deepest open map with mid ≤ L + 1 (L after a crash in the last 10 minutes; the crash rule still drops a map) | With drops at iRef a weapon a few levels behind is normal; one-agent herds sat a map low for days and missed the quota on the zone's last map that opens the boss door (Boss 5–7 a week late on some seeds). |

## 5. XP sources the D§12.1 model does not have

| Change | Design | Now | Why |
|---|---|---|---|
| Boss XP (D§6.2, `T.boss.xpFirst / xpRepeat`) | 0.5 Need(L) first kill (and per review), 0.1 Need(L) per repeat | 0.1 and 0.02 | pacing4.py has no boss XP; with nine first kills, two reviews and farming every 3 working hours per boss it added 8–29% of a hero's XP from Lv 50 on. |
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
| Auto-boss threshold (`T.boss.autoAt`) | challenges at estimate E ≥ 1.0 | E ≥ 0.9 (the estimate keeps its 0.85 margin, so ≥ 1.06 of the raw need) | With gear near the reference kit a lone hero's E creeps up ~1% a level once its gear stalls (casual: 0.93 at Lb − 3, 0.98 at Lb) and autopilot never tried, so a Lessons Learned that would win the next attempt (D§9.5) never came: Boss 4–6 a week late on some seeds. Repeat-kill farming keeps E ≥ 1.5. |

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

## 10. Known limits

- Real loot is lumpy: one herd's worn gear swings between 0.5× and 2× the reference kit (a Keepsake
  or an LTS weapon, a stretch without a class weapon), so with real gear the kill pace of a given map
  ranges about 11–24 per minute around a mean of ~16, against the reference kit's 14–19.
- Persona results move by a few percent from seed to seed (boss days by a day or two); seed 1 is the
  one `npm run pacing` and the tests use.
