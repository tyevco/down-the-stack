# Localhost, the town (issue #1): final design

**Status: round 1 ("The Review Desk opens", section 12) is built** (2026-11-27; DESIGN D§10.8 is
the rule as built, section 15 lists where the build differs from this design and why). Rounds 2
and 3 are not built yet.

Design version 1.0 (decisions in section 13 made) for GitHub issue #1 ("Localhost jobs: heroes not fighting work stations in
town"). Start point: the **"glance"** design, which both judges ranked first (player lens 47,
engineering lens 48, against 35–40 for the others). Grafted from **"agents"**: role words with a
strength and a later-word tie, the "why" line on the Job card, the titles of the real tasks being
reviewed, Contractors waiting in `vendor/`, an open-source rank ladder, and a stable layout in which
an idle hero's desk replaces its campfire in its own slot. Grafted from **"depth"**: a bound that ties
job progress to seen work, Uptime counted in nines as the town's long-term number, a big-fight bonus
that never enters the win estimate, and the balance gates (`--no-town`, a share cap, the sweep and
bot byte-identical). Section 14 lists every "must avoid" from the judges and how this design meets it.

Every balance number marked *(fed back)* comes from real engine runs in which the town's rules
changed the world: bonus XP through `heroes.grantXP`, bonus gold and Review Desk purchases through
`herd.addGold` (so autopilot saw the gold path), and Runbooks on real fight clocks. Seeds 1–4, every
D§12.1 persona, and a 32-agent model of the owner's herd (Appendix A). No overlay that only reads
the world was used for a balance claim.

References: D§n is `docs/DESIGN.md`, A§n is `docs/ARCHITECTURE.md`, B§n is `docs/BALANCE.md`. "The
owner" is the person who runs 32 agents in about 25 spaces (screenshots 1–8 of the older build).

---

## 0. The design in twelve lines

1. **Who goes to town.** A roster hero of Lv 10 or more is **on duty** in town whenever its agent is
   shipped, resting or off duty (the app closed included), as long as one of its chests was opened
   with full value (seen) on this game day or the one before. Fighting, supervising and waiting
   heroes never are. Contractors never are.
2. **Fight first.** A hero whose agent works always fights. The town never takes a working agent's
   hero out of the field (keeping one in town on purpose is an owner decision, 13.3).
3. **Two stations, one bench.** The **Review Desk** (new) makes **LGTMs**; the **Docs Library**
   (existing building) makes **Runbooks**; the **Campfire** stays the bench for Interns and heroes
   not on duty. No seats, no assignment screen.
4. **Where each hero works** comes from the words of its space, tab or pane name ("pr-review-eng-1"
   says *review*), then its class. It never moves by need. An optional override sits on the sheet.
5. **What it makes.** 1 LGTM per hero-hour on duty (a Runbook is worth 8), shared out among everyone
   on duty, into two capped shelves: LGTMs 10 × the Review Desk's level (10–100), Runbooks 3.
6. **What it buys.** Each chest opened with full value takes one LGTM: **+10% chest XP and gold**
   ("+1.2k · LGTM" on its coin float). Each frontier boss fight, Backlog fight or promotion review
   takes one Runbook: **+10 s on its clock**, never counted in the win estimate.
7. **Job ranks.** Each hero's job XP is what it made: Drive-by, Contributor (25), Committer (100),
   Maintainer (300), Core (1,000). Each rank makes 20% more (×1.0–1.8). No combat stat changes.
8. **No new currency.** No materials, no storage to manage. The Review Desk costs 1,000 gold ×2 a
   level (1.02M for all ten) and autopilot buys a level only when the shelf filled up and still ran
   dry the same game day.
9. **Uptime in nines.** Every LGTM spent counts toward Localhost's Uptime (90% at 100 … 99.999% at
   62,500): the town's own slow number, cosmetic only.
10. **Balance** *(fed back)*: the town is 1.1–1.5% of the personas' XP and 1.65% of the owner
    model's first ten days (about 2% later), against 69–84% from kills; all 272 persona milestones
    of seeds 1–4 stay within ±15%.
11. **Screens.** Resting heroes sit at a desk or a shelf in their own slot; the camp chip becomes
    the **Localhost chip** ("LGTM ×206" by 18:00); when nothing has worked for 15 minutes the strip can
    show the whole town (owner decision, 13.2). The Upgrades tab becomes **Localhost**; the sheet's
    Career tab gets a **Job card**; the Digest gets one line. No toasts, no badge counts.
12. **Round 1** is the Review Desk alone, and it is fun on its own (section 12).

---

## 1. Pitch and name

**Pitch.** Your agents' Termlings don't stop being a team when their agents stop working. Between
tasks and after hours they walk home to **Localhost** and do the work a dev team does when it is not
shipping: the reviewers approve the tasks you shipped, by their own titles ("LGTM: “Fix flaky auth
test” (Kip)"), and the writers write the runbooks the next big fight needs. Nobody assigns anything:
`pr-review-eng-1`'s hero sits at the Review Desk because its space says so, `docs`, the leads and
`infra` write in the Docs Library. By day the town is one line on the strip, "LGTM ×206"; by night,
if you want it, the strip becomes the town itself, thirty heroes at their desks under a dark sky
with the night's unseen chests beside them. The town only helps work that really happened and that
you saw, it never fights for you, and an idle herd fills its shelves and stops.

**Name: keep Localhost** (recommended; owner decision 13.1). It is already on screen in three places the
owner has seen: the Herd panel's header ("The Herd v0.0 Localhost", screenshots 4, 7 and 8), the
empty-state stage ("N heroes are resting at Localhost", `game/view/stage.js`) and the header notes'
scenery (D§11.15). It is the right pun: localhost is where your code runs before it ships, and
127.0.0.1 is home. "Staging" was the strongest alternative, but it collides with the "stage" strip
and map 8-1 Staging Slopes, and these heroes have come back from production, not gone to it.

---

## 2. Who goes to town, and when

### 2.1 The rule

A **roster** hero is **on duty** in town when all of these hold:

1. its level is **10 or more** (Junior: a job is a new beat on the career ladder);
2. its agent is **shipped, resting or off duty** (the app closed counts as off duty), exactly the
   states that bank Fresh Eyes (D§2.2, D§2.9 rule 3);
3. **seen work today or yesterday:** a chest of its was opened with full value (D§2.4) on this game
   day or the one before (game days turn at 04:00 local, D§2.9);
4. the Review Desk is built (level 1 or more) and the world is not read-only (B§9), with the clock
   not behind (D§2.10).

| Hero state (D§2.2) | Where it is | On duty? | Fresh Eyes (unchanged) |
|---|---|---|---|
| Questing, crashed, supervising | its lane in the field | **no**: it fights | drains / none |
| Waiting (blocked) | the field, on its crate under the white `!` | **no** (frozen, as Fresh Eyes) | none |
| Shipped (chest not seen yet) | the field, by its chest (gold still means done) | yes, if rule 3 holds | +0.25 min a min |
| Resting | its own slot, at its station's prop instead of the campfire | yes, if rule 3 holds | +0.25 min a min |
| Off duty (terminal gone) or app closed | not on the stage; in the town view at its station | yes, if rule 3 holds | +0.25 min a min |
| Lv 1–9 (Intern), or rule 3 lapsed | its campfire, as today | no | as today |
| Contractor (any state) | as today; waits in `vendor/` in the town view (2.4) | never | as today |

Everything a resting hero does today goes on: regen, coffee refills, Fresh Eyes, the `z` after 10
minutes. Town work is rest from fighting, not a second kind of work, and costs the hero nothing.

### 2.2 Why rule 3 (seen work today or yesterday)

- **No progress from idling alone.** An agent that never ships anything you saw never goes on
  duty, so its hero never ranks up and never makes an LGTM. An agent that shipped once and went idle
  is on duty for at most the rest of that game day and the next one, then rests at the campfire.
- **Offline is bounded by the rule itself.** No chest can be seen while the app is closed, so an
  offline gap gives at most the time until the rule lapses (at most about 48 h, usually the night).
  A week away and an evening away make the same town output, and both are capped by the shelves.
- **The morning is never empty.** "Yesterday" keeps every hero that shipped yesterday on duty
  through the 04:00 turn and the morning (owner model: 22 of 30 heroes on duty at 08:00 on day 7,
  the rest working), so the town is busy when the owner sits down.
- It reuses the "seen it" rule the game already teaches (D§2.9 rule 2).

### 2.3 Fight first, and what the owner must do

- **Does a hero with a job still fight when its agent works? Always.** A job is only what the hero
  does while it is not fighting. Pillar 1 (D§1) and the issue's "a job must never beat fighting"
  hold by construction: the town never removes a fighter, never changes a slot, a task, a Seal, a
  chest's "seen" or a fight.
- **What the owner must do: nothing.** Every choice has a default. The optional controls are the
  station override on the Job card (7.6) and the autopilot "Buildings" switch, which already covers
  the Review Desk's purchase. If the Review Desk is never bought (Buildings off and no click), every
  hero rests at its campfire exactly as today.
- **Keeping a working agent's hero in town on purpose** is not in this design's default; it is
  owner decision 13.3, with the rules it would need if chosen.

### 2.4 Contractors

- Contractors are not on the roster (D§3.4; round 5 keeps them as slim records in `herd.ct`), so
  they hold **no station, no job XP and no duty**. Their slim record gains nothing.
- **Their chests do take LGTMs**: the desk reviews the whole herd's seen work, not only its staff's.
- **`vendor/` is their lobby** (cosmetic, from "agents"): the chip's tooltip and the Localhost tab
  say "vendor/: 2 contractors · next hired 04:00", and in the town view they wait by the `vendor/`
  crates. A promoted Contractor goes on duty as soon as rule 3 holds (a chest of its opened today
  as a Contractor counts, carried over by `agents.promote`).

### 2.5 Who is in town for the owner *(owner model, fed back, Appendix A)*

32 Claude agents in the owner's 25 spaces; most work 08:00–21:00 in 15–45-minute tasks, half with a
1–6-minute block; results are looked at 3–30 minutes after they finish by day, 30–240 minutes at
night; six night-owl agents work until about 02:00; herdr stays open. Roster 6 → 12 → 18 → 24 → 30
heroes on days 1–5 (6 hires a day), Contractors 26 → 2. Averages over the hour named, day 7:

| Moment | Fighting | Waiting | Shipped (chest unseen) | **On duty** (Review Desk · Docs Library) | Campfire | LGTM shelf | Stage shows |
|---|---|---|---|---|---|---|---|
| **03:00** | 0 | 0 | 1 | **30** (16 · 14) | 0 | 60 / 70 | the town view (if chosen, 13.2) since about 02:15 |
| **08:00** | 8 | 0 | 1 | **22** (11 · 11) | 0 | 70 / 70 | the field: the first agents start, the town view ends with the first |
| **10:00** | 17 | 1 | 10 | **12** (6 · 6) | 0 | 40 / 70 | the field; chip "LGTM ×68", 10 chests in their slots |
| **18:00** | 18 | 1 | 9 | **11** (6 · 5) | 0 | 1 / 70 (empty since early afternoon) | the field; chip "LGTM ×206" |
| **21:00** | 1 | 0 | 18 | **29** (16 · 14) | 0 | 33 / 70 | the field (the night owls still work) |

- **Role split:** the owner's 32 agents map to the Review Desk for 16 and the Docs Library for 14
  (8 by review or QA words, 14 by docs, lead, VP, assistant or ops words, 10 by class; 3.3).
- **By day** about a third of the roster is on duty, and nine or ten of those are shipped heroes
  standing by their chests in the field. The town's by-day surface is the chip, not the desks.
- **Day 1** (6 heroes, 26 Contractors): Interns at the campfire until about 10:00; the Review Desk
  opens with the first Lv 10 hero (1,000 gold); 2–6 heroes on duty; each 04:00 adds six.
- **A heavier day** (24 of 32 fighting at 10:00): about 6 on duty by day; coverage falls a few
  points; nothing else changes.

### 2.6 The personas' town *(fed back, seed 1)*

The D§12.1 personas close the app after each session, so their heroes are on duty from the end of
one session to the start of the next (rule 3 covers the whole night), and the shelves refill
offline:

| Persona | On duty a day (herd) | Review Desk | LGTM coverage (share of full-value chests with an LGTM) |
|---|---|---|---|
| Casual (1 agent, 1.5 h) | 22 h | 2 (3,000 gold, day 3) | 99% |
| Solo (1 agent, 3 h) | 21 h | 2 (3,000 gold) | 99% |
| Typical (3 agents, 2 h) | 65 h | 4 (15,000 gold, day 5) | 98% |
| Heavy (5 agents, 5 h) | 93 h | 10 (1.02M gold, day 14) | 91% |

---

## 3. Stations and jobs

### 3.1 The stations

| Station | Building | Job (title noun) | Opens | Makes | Shelf | Spent on |
|---|---|---|---|---|---|---|
| **Review Desk** | **new**: `review_desk`, base 1,000 gold, ×2 a level, max 10 (level 10: 512k; all ten 1,023,000) | reviewer | Review Desk level 1 | **LGTMs**: 1 a hero-hour on duty × rank factor | **10 × level** (10 → 100) | a chest opened with full value (3.4) |
| **Docs Library** | existing (D§10.2: +2% herd XP a level; unchanged) | writer | Docs Library level 1 (until then its staff work at the Review Desk) | **Runbooks**: 1 per 8 hero-hours on duty × rank factor | **3** | a frontier boss fight, a Backlog fight or a promotion review (3.4) |
| **Campfire** | existing (Fresh Eyes cap, gated by herd age, B§6; unchanged) | none | always | Fresh Eyes as today | 60–210 min per hero, as today | – |

The Coffee Machine, CI Forge, `vendor/` and War Room keep their D§10.2 effects and hold no job (the
issue's other job ideas are folded or dropped in Appendix B, with measured reasons).

### 3.2 Output, sharing and the shelves

- **One or many heroes per station: many, with no seats.** Seats create "station full" states to
  manage, and the shelves already bound the output.
- **Output.** Each on-duty hero makes `1/60 × (1 + 0.2 × rank)` LGTM-equivalents per minute; a
  Runbook costs 8 of them. It makes **its own station's product first**; when that shelf is full,
  the other one, from its own desk (it never moves); when both are full, it makes nothing and rests.
- **Shared pro rata.** In each tick the shelves' room is shared among all on-duty heroes in
  proportion to what each would make (hero id order only for rounding), so job XP never depends on
  ids or on who was listed first.
- **A station not built** (level 0) sends its staff to the other one; with no Review Desk nobody is
  on duty. **The building's level caps the shelf, never the staff.**
- **Nothing decays, nothing is lost.** A full shelf just stops production; nothing needs upkeep.

### 3.3 How a station is picked (automatic; first match wins)

1. **The sheet's override**, if set (Auto by default; 7.6).
2. **The Campfire** for Lv 1–9, for a hero not on duty (rule 3), or with no Review Desk.
3. **Role words**, from "agents": the hero's **space name**, then its **tab name**, then its **pane
   name** (the first of the three that has a word). Each name is split on anything that is not a
   letter or digit, lower-cased, bare numbers dropped. The strongest word wins; on a tie the **later
   word** wins ("<team>-<role>-<n>" puts the role last).

   | Station | Strong words (2) | Weak words (1) |
   |---|---|---|
   | Review Desk | review, reviews, reviewer, reviewing, pr, prs, cr, lgtm, approve, qa, test, tests, testing, e2e, audit, verify, sec, security, lint | – |
   | Docs Library | doc, docs, writer, writers, writing, wiki, readme, spec, specs, rfc, guide, guides, notes, research, res, runbook, runbooks | lead, leads, vp, ceo, cto, cpo, head, mgr, manager, pm, product, plan, planning, assistant, infra, ops, sre, oncall, devops, incident |

4. **Class**, when no name has a word: Refactorer and Rubberducker go to the Docs Library (long
   steady stretches; talking things through), every other class to the Review Desk.

The pick is **derived, never saved**: cached per hero in `world.rt`, recomputed on the 60-tick
autopilot pass and when the hero's seat, tab, pane, level, class or override changes. It never moves
by need, so a hero's station is stable and matches its name. The Job card says why: "Auto: the space
name “pr-review-eng-1” says *review*", or "Auto: no role word in “gks”; class Shellmancer".

**The owner's names** (the 25 spaces of screenshots 1 and 4 and the issue; `test/town.test.mjs`
asserts this table, 12):

| Space (agents) | Station | Why |
|---|---|---|
| pr-review-eng-1, pr-review-eng-2, pr-review-lead (review beats lead), pr-review-qa | Review Desk | *review* / *qa* |
| rnd-qa ×2, mobile-qa, qa | Review Desk | *qa* |
| ceo-assistant-writer | Docs Library | *writer* (strong) |
| ceo-assistant-res-2 | Docs Library | *res* (strong) |
| ceo-assistant-lead ×2, rnd-lead, mobile-lead | Docs Library | *lead* |
| ai-apps-vp, ai-platform-vp | Docs Library | *vp* |
| docs ×2 | Docs Library | *docs* |
| infra ×2, hitch-ops ×2 | Docs Library | *infra* / *ops*: runbooks are ops docs |
| rnd-eng-1, rnd-eng-2, mobile-eng ×2, ref-client, gks, claude-extended, quiet-front, herdr-teams ×2 | by class (mostly Review Desk) | no role word; tab names such as "herdr-teams", "herdr-mobile" or "hitch-ref" have none either |

Totals: Review Desk 8 by words, Docs Library 14 by words, 10 by class (16 · 14 in the model).

### 3.4 The products and where they are spent

| Product | Spent when | Effect | The owner sees | Never |
|---|---|---|---|---|
| **LGTM** | a Commit Chest opens **with full value** (seen, D§2.4's four ways), for a roster hero or a Contractor; one per chest (a merged chest is one), in the order `agents.openChests` opens them | that chest's XP and gold ×**1.10** | the chest's coin float reads "+1.2k · LGTM"; the chip's "LGTM ×n" grows; the Localhost tab lists the last five titles ("“Fix flaky auth test” (Kip), by Rue") | Seals, items, chest tier, Sprint, Release Train; Unreviewed chests (nobody saw them); a chest when the shelf is empty (it opens as today) |
| **Runbook** | a fight **starts** against the frontier zone's boss, a Backlog fight, or a Senior or Staff Review; not a repeat (farm) fight | **+10 s on that fight's clock** (`fight.timer += 10`; its enrage point moves with it, D§9.5). The win estimate (`boss.estimate`) and autopilot's E ≥ 0.9 check **never count it** | the fight banner's sub-line "Runbook +10 s"; the boss card's tooltip "A runbook is ready: +10 s on the clock" | damage, XP, loot, Wounds, Lessons Learned, the estimate |

- **Why +10 s and not damage** (the engineering judge's must-avoid 3): the estimate is linear in
  damage, and near a boss's level a lone hero's estimate rises only about 1.7% a level with stalled
  gear (B§7), so +5% damage in the estimate made autopilot challenge about three levels early. A
  clock bonus outside the estimate cannot pull a challenge forward; it only turns some close losses
  into wins. War Room level 5 adds +30 s; a Runbook is a third of that, for one fight.
- **Why not Lessons Learned twice after a loss** (depth's version): Postmortems are rare. Measured,
  about one a persona lifetime on seed 1 (Heavy: one in 56 days; Casual one lost frontier fight in
  170 days) and a few in the owner model's ten days, so such a Runbook would almost never be seen.
  Big fights happen 12–20 times a persona lifetime (Casual 13: 11 frontier, 2 reviews) and about 3.5
  a day in the owner's first weeks (60 promotion reviews for 30 heroes), so this Runbook is seen.

---

## 4. Job progression

**One rank per hero, not one per station.** With automatic picking a hero almost never moves, so a
per-station rank would only punish the rare move. One rank is portable and a few bytes.

| Rank | Job XP to reach | Output | Title (with the station's noun) |
|---|---|---|---|
| 0 Drive-by | 0 | ×1.0 | "Drive-by reviewer" |
| 1 Contributor | 25 | ×1.2 | "Contributor reviewer" |
| 2 Committer | 100 | ×1.4 | "Committer writer" |
| 3 Maintainer | 300 | ×1.6 | the Localhost tab names each station's top-ranked staff as its maintainer |
| 4 Core | 1,000 | ×1.8 | the Hall of Fame card keeps it ("Core reviewer") |

- **Job XP is what the hero made**: 1 per LGTM, 8 per Runbook, shared as 3.2 says. Since a shelf
  only has room when seen work used it, **job XP grows only with the herd's seen work** and never
  from idle time alone (with rule 3, never for an agent that ships nothing you saw).
- **What a rank changes:** output (×1.0 → ×1.8) and the title. Never a bonus's size, never a combat
  stat. Ranks are separate from the career ladder (D§4.1): open-source roles, not job titles.
- **How fast** *(fed back)*: the personas' heroes make 12–19 job XP a day (the shelf, not the rank,
  limits them): Contributor on day 2–3, Committer day 6–9, Maintainer day 17–25, Core day 54 (Heavy)
  to about day 82 (Casual, Typical). The owner's 30 heroes share one shelf of at most 100 and made
  46–106 each by day 10 (median 71): Contributor by day 4, Committer around day 14, Maintainer
  around day 40, Core around day 130.
  The personas see their few heroes rise; the owner sees the herd-wide numbers rise (the Review Desk
  and Uptime, 5.3) while thirty heroes climb slowly.
- **Where it shows:** the Job card (title, job XP, next rank), the hero's tooltips, the Localhost
  tab, and the Digest ("Rue and 2 more reached Committer"). **Never** a header note, a toast or a
  journal line (thirty heroes × four ranks would flood both).

---

## 5. Economy

### 5.1 What there is

**Gold and Seals only; no new currency, no materials, no storage.** LGTMs and Runbooks are capped
shelves that field events empty one at a time; the player cannot spend, trade, lose or stockpile
them past the cap. The engine's own numbers argue against materials: the owner model holds 134M gold
and 270k Snippets by day 7 with every building maxed but the age-gated Campfire, and the personas
pass 1M gold by day 10. Anything the town paid in gold, Snippets, polish or junk would be worthless
to the owner within a week.

| | Sources | Sinks |
|---|---|---|
| **LGTMs** | on-duty heroes (3.2), app-closed time included (6.5) | 1 per chest opened with full value |
| **Runbooks** | on-duty heroes, 8 LGTM-equivalents each | 1 per frontier, Backlog or review fight |
| **Gold** | unchanged; +10% on LGTM'd chests | new: Review Desk levels (1.02M for all ten) |
| **Seals, items, Snippets, Fresh Eyes** | unchanged | unchanged |
| **Uptime** | +1 per LGTM spent, +10 per Runbook spent | cosmetic only |

### 5.2 The Review Desk's levels (demand-gated)

- Cost of level n: `1,000 × 2^(n−1)` gold (1k, 2k, 4k … 512k). Max 10.
- **Autopilot** (under the existing "Buildings" switch, outside `herd.autoBuyPick`'s cheapest-first
  queue, so the other six buildings' order is untouched):
  - level 1 when a roster hero first reaches Lv 10 and gold ≥ 3 × 1,000;
  - level n + 1 at a game-day turn when, on the game day that just ended, **the LGTM shelf was full
    at some point and later ran dry**, and gold ≥ 3 × its cost (at most one level a game day).
- The person can buy a level by hand from the Localhost tab, as any building.
- *(Fed back)* Casual and Solo stop at level 2 (3,000 gold), Typical at 4 (15,000), Heavy reaches 10
  on day 14, the owner on day 10. The cheap ×2 curve keeps the gold path flat for small herds (the
  engineering judge's must-avoid 6): with ×3 (29.5M for all ten) Heavy spent 29.5M by day 14, gold
  the Docs Library's last levels also want, and its Boss 6 came a day later on seed 1; with ×2 the
  desk costs Heavy 1.02M and its milestones stay within seed noise (6.2).

### 5.3 Uptime in nines (from "depth")

Localhost counts what it has served: **S = LGTMs spent + 10 × Runbooks spent** (lifetime). Uptime is
shown in nines and never pays XP, gold, Seals or drops.

| Uptime | S | Unlocks (cosmetic: the town view and the spare-width scenery) | Owner | Heavy | Typical | Solo | Casual |
|---|---|---|---|---|---|---|---|
| booting | < 100 | – | day 1 | days 1–4 | days 1–4 | days 1–7 | days 1–9 |
| **90%** | 100 | string lights over the stations | day 2 | day 5 | day 5 | day 8 | day 10 |
| **99%** | 500 | a neon "localhost" sign | day 5 | day 11 | day 15 | day 34 | day 42 |
| **99.9%** | 2,500 | a clock tower showing the uptime | day 12 | day 30 | about day 70 | about day 160 | about day 200 |
| **99.99%** | 12,500 | lit windows in every station | about day 45 | about day 130 | about day 340 | – | – |
| **99.999%** | 62,500 | the town banner; badge **Five Nines** (epithet "of Five Nines", D§10.6) | about day 190 | about day 630 | – | – | – |

Days are *(fed back)* to the end of each run and extrapolated at the last week's rate past it. The
×5 steps give the owner a nine every few weeks to months, and the small herds a nine or two to chase
for months. One header note per new nine, herd-wide ("Localhost: 99.9% uptime", short "99.9%
uptime"): five in a herd's life.

---

## 6. Balance

### 6.1 Why the town cannot beat fighting (invariants)

1. **Every product multiplies a field event that was seen** (a chest opened with full value) or
   adds clock time to a big fight. Each event takes at most one product. No town output is XP, a
   level, a Seal, a drop, a gear change, kill XP or a Release Train step.
2. **The town never moves a fighter** (2.3) and never touches a fight's estimate (3.4).
3. **Job progress needs seen work** (rule 3 and the shelves, 2.2, 4).
4. **Bounded:** an LGTM adds 10% to one chest's XP; chest XP is 12–15% of the personas' XP and 28.5%
   of the owner's (crowding cuts kills but never chests, D§12.3.9), so the town's share is at most
   `0.10 × chest share × coverage`.
5. **The existing caps stay:** Daily Shift, crowding, the herd XP cap (an LGTM multiplies chest XP
   after ΣXP%, as the chest's own value; it is not in the herd cap), Lessons Learned, item rules.
6. **The bots are unchanged by construction:** the always-working bot never rests and is never seen;
   the toggling bot never has a credited Seal (D§12.2). Neither is ever on duty, and neither opens a
   chest with full value. The sustain sweep is one working hour with no chest and no frontier fight.

### 6.2 Measured *(fed back; seeds 1–4; +10%)*

XP by source is the engine's own tally (`live.tally`); "town share" is the LGTM bonus over all XP
earned (kills, chests, bosses, reviews and the bonus).

| Herd | Kill / chest / boss+review XP (no town) | Town share of all XP | LGTM coverage | Review Desk (gold spent) | Runbooks used / big fights (seed 1) | Mean shift of the Lv 20–100 hours vs `--no-town` | Worst milestone with the town (same seed without) | Milestones off ±15% |
|---|---|---|---|---|---|---|---|---|
| Casual | 82.2 / 13.0 / 4.8% | 1.18–1.39% | 99% | 2 (3,000) | 11 / 12 | −4.6% … −0.9% | Lv 100 −12.4%, seed 2 (−9.2%) | 0 of 68 |
| Solo | 82.9 / 12.3 / 4.8% | 1.22–1.36% | 99% | 2 (3,000) | 10 / 12 | −4.1% … +2.9% | Lv 100 −10.0%, seed 3 (−9.6%) | 0 of 68 |
| Typical | 83.3 / 12.2 / 4.6% | 1.11–1.20% | 98% | 4 (15,000) | 15 / 17 | −2.6% … +0.6% | Lv 100 −13.4%, seed 3 (−11.4%) | 0 of 68 (without the town: 1, Lv 50 −15.4% on seed 4) |
| Heavy | 79.4 / 15.1 / 5.5% | 1.41–1.53% | 91% | 10 (1,023,000) | 13 / 20 | −2.0% … +1.8% | Lv 5 +9.3% (unchanged) | 0 of 68 |
| Owner model, 10 days | 68.7 / 28.5 / 2.9% | 1.65% (rising; about 2% at steady state) | 7% day 1, 46% day 5, 64% day 8 | 10 on day 10 (1,023,000) | 18 / 35 | – | – | – |
| *+5% instead (decision 13.4)* | | 0.58–0.78% | same | same | same | −3.2% … +3.6% | Lv 100 −12.1%, Typical seed 3 | 0 of 272 |

Ranges are over seeds 1–4 (16 fed-back persona runs at +10% and 16 at +5%); the no-town runs are the
same seeds on the same tree (be57dbb with round 5's Contractor work in progress, which the personas
never exercise).

**Reading it.**

- The town is **1.1–1.5% of the personas' XP** and **1.65% of the owner model's** over its first 10
  days (coverage still rising: 7% on day 1, 46% on day 5, 63–64% on days 8–9; about 2% at steady
  state with ranks rising).
- Day-1 milestones (Lv 5, Lv 10, Boss 1) never move: nothing is made before a hero is Lv 10, has a
  seen chest and the Review Desk is built, and the first shelf fills during the first night.
- Single milestones move by up to about 12 points against the same seed without the town (Casual
  seed 2's Lv 60: +0.9% → −11.6%), in both directions: a small XP change shifts a boss by a day,
  which moves the next maps' timing. This is the amplification the engineering judge measured in the
  "agents" run, and it is why the gates below run seeds 1–4.
- The **mean** of a run's Lv 20–100 hours moves between 4.6% earlier and 2.9% later at +10% (about
  1% earlier on average over the 16 runs), and between 3.2% earlier and 3.6% later at +5%: the
  town's pull on pacing is about the size of the seed noise itself.

### 6.3 Gates and tuning rule (`tools/pacing-sim.mjs`)

1. **The town is part of the engine**, so `npm run pacing` runs it by default.
2. **`--no-town`** sets `T.town.on = false` (no duty, no buys, no bonuses): the output is
   byte-identical to the build before the town (`test/pacing.test.mjs` asserts the milestones,
   kills a minute and save sizes are unchanged).
3. **A town line per persona:** "Localhost: 1.2% of XP · LGTM coverage 98% · runbooks 15 of 17
   big fights · Review Desk 4 (15k gold) · ranks Core ×3 · Uptime 99.9%".
4. **Exit code 1** (as a milestone more than 15% off already does) when:
   - a persona's town share passes **3%** of its XP;
   - a milestone of seeds 1–4 that is within ±15% of D§12.1 without the town leaves it with the
     town (a seed that already misses without the town must not miss by more);
   - the mean of the level milestones (Lv 20–100) moves more than **6%** earlier than `--no-town`
     on the same seed.
5. **The tuning rule:** if a gate fails, the town's numbers move, never the field's: the LGTM bonus
   first (+10% → +5%), then the shelf size. `T.town` is marked `balance: new` in `data.js`.
6. **`--persona big`**: the owner model of Appendix A (32 agents, 25 spaces, herdr open overnight,
   7 days, about 90 s in V8). It prints who is on duty by hour, coverage by day, the town share, the
   Review Desk level and the save size with and without the town's fields. Gates: town share ≤ 4%,
   the town's own save bytes ≤ 0.8 KB. It is informational otherwise and left out of `all`.
7. **The sweep** (`--sweep`) and **the bot** print byte-identical results with and without the town
   (asserted).

### 6.4 Exploit check

| Case | Result |
|---|---|
| Always-working bot | never rests: never on duty; never seen: no LGTM |
| Toggling bot (fake tasks, nobody looks) | no credited Seal: never on duty (rule 3); chests Unreviewed: no LGTM |
| One agent shipped once, then idle forever | on duty until the end of the next game day; makes at most the shelves' room; then rests |
| Thirty idle agents and one working agent | the idle ones are not on duty after a day; at most one hero's seen work is boosted, +10% of its chests |
| Rebind an agent across benched heroes | job XP is the hero's; rule 3 is per hero |
| Restart, hot reload, two windows | shelves, job XP and credit days are saved; the station is derived; one writer per save (A§2.3) |
| Clock set back, read-only world | nothing accrues (D§2.10, B§9) |
| Buying Review Desk levels by hand | a bigger shelf only; still one LGTM per seen chest |

### 6.5 Offline (30 days at most, never a burst)

- An offline gap (> 60 s, D§2.10) settles after reconcile, in `world.applyOffline`, as Fresh Eyes
  does: each roster hero not Waiting is on duty for `min(gap, time until its rule 3 lapses)`,
  clamped to 30 days (`OFFLINE_CAP_MS`), and the output goes into the shelves, shared pro rata.
- **Bounded twice:** rule 3 lapses within about 48 h of the last seen chest, and the shelves hold at
  most 100 LGTMs and 3 Runbooks. Job XP from one gap is at most what fills the shelves' room (≤ 124
  for the whole herd).
- **No burst:** the shelves are spent one LGTM per chest and one Runbook per big fight as the day
  goes. No notes and no toasts while a gap settles (the emitter is not live, A§3.4; D§11.15's
  live-play rule). The Digest's line says what happened.

---

## 7. Screens

### 7.1 The glance

| Moment | The owner sees | It means |
|---|---|---|
| By day, in a slot | a resting hero at a small desk or shelf instead of the campfire; face `-_-`, the dusk tint and the "z" stay; tag "Fresh Eyes 42m" as today | it is home, reviewing or writing |
| By day, the chip | the Localhost chip at the right end: "+25", the status dots, three props, and "LGTM ×206" in XP cyan | 206 of today's chests got an LGTM |
| A chest opens | its coin float reads "+1.2k · LGTM" | seen work paid 10% more because the town reviewed it |
| A big fight starts | the banner's sub-line "Runbook +10 s" | the writers prepared it |
| Nothing works for 15 min (if chosen, 13.2) | the whole strip is Localhost: heroes at the Review Desk and the Docs Library, unseen chests beside their heroes, "LGTM 90/100 · Runbooks 3/3 · 99.9% uptime" | everyone is home and tomorrow's shelves are full |
| In the morning | one Digest line | what the idle time was worth |

Gold means done and only done, the white `!` means blocked and only blocked (D§11.1); the town adds
no amber and no `!`. Town text is cream; LGTM text is XP cyan because it is XP.

### 7.2 Stage by day (`game/view/stage.js`, `ui/stage.js`)

- **The desk in the slot.** A resting, on-duty hero (`vm.campfire` with a new `station` field) gets
  its station's prop at 0.08 w instead of the campfire: `fx/desk.svg` (a small desk with a lamp and
  a paper stack) or `fx/shelf.svg` (a short shelf with a lamp). One image and one glow loop, as the
  campfire (2 elements, 1 animated; 1 element at the bare levels): **0 elements net**. Interns and
  heroes not on duty keep the campfire. Shipped heroes keep their chest and no prop (every slot holding
  status already measures 395 of 400, D§11.9). No slot moves (D§11.3 rule 2).
- **The Localhost chip** (today's camp chip, `overflowVM` / `overflowChip`): same box (150 px; 96 px
  below a 600 px strip), same fold rules, same "+N" and status dots. The three tents become three
  props (desk, shelf, campfire): 0 net. **New:** one line in the ground band, "LGTM ×206" (today's
  count, so it grows all day): +1 element. At the three coarsest detail levels the line folds into
  the label, "+25 · LGTM ×206" (133 px of 150): **0 net at the worst case**.
- **The chip's tooltip** keeps its 12 lines (waiting, chest, working, resting) and adds three:
  "Localhost: 12 on duty (Review Desk 6 · Docs Library 6) · LGTM 40/70 · Runbooks 3/3",
  "Last LGTM: “Bump deps” (Fizz), by Rue · 206 today (61%) · 99.9% uptime",
  "vendor/: 2 contractors · next hired 04:00".
- **Spare width** (D§11.3 rule 1, Localhost scenery at both ends): with 120 px free, the right end
  draws the desk and shelf props and the "LGTM ×n" line, so small herds see the town there.
- **Effects:** " · LGTM" is appended to the coin float of an LGTM'd chest (already in the 24-element
  effects reserve): 0 elements more and no new flying glyph at the owner's 420 chests a day. A
  Runbook adds a sub-line to the existing fight banner.
- **Tooltips:** a resting hero's adds "At the Review Desk · Committer reviewer · last LGTM “Bump
  deps” (Fizz)"; a hero whose terminal is gone, in the Roster or the chip, "Off duty · at the Docs
  Library (Core writer)"; a hero not on duty "Back on duty after you see its next chest".

### 7.3 Stage when nothing works: the town view (owner decision 13.2; recommended)

- **When.** After **15 minutes** with no live hero or Contractor questing, crashed, supervising or
  **waiting**, and at least **60 minutes** after the town view last closed (a re-entry cooldown, so
  the day's edges, when one or two agents start and stop between short gaps, cannot flip the strip
  more than once an hour). In the owner model nothing works from about 02:00 to 08:00, so the view
  opens at about 02:15, after the night owls stop, and closes at about 08:00 with the first agent.
- **The way back.** One questing, crashed, supervising or waiting hero brings the field back on that
  tick. A waiting `!` is therefore never hidden, and "N need you" lives in the party and the panel.
- **Collapse.** With "collapse the stage when nothing is working" on (off by default), the stage
  hides as today and the town view never shows. The Settings row reads "When nothing works:
  **Show Localhost** (default) · Show the field · Hide the stage"; `cfg.collapse` keeps its meaning
  and a new `cfg.town` holds the first two.
- **No live agents at all.** The town view shows at once, in place of today's "Everyone is off duty"
  sign, every hero at its station. The "Help wanted" sign stays for a herd with no heroes.
- **Layout (200 px):**

  ```
  ┌ Review Desk · 16 · LGTM 90/100 ───────────────┬ Docs Library · 14 · Runbooks 3/3 ──┬ Campfire ┬ vendor/ · 2 ┐
  │ * night sky, stars        [localhost 99.9%]   │                                    │   ^^     │   [crates]  │
  │  [desk]      [desk]      [desk]               │  [shelf]     [shelf]               │          │             │
  │ -_- -_- ^_^▣ -_- -_- -_- -_- -_- -_- -_- +6   │ -_- -_- -_- -_- -_- -_- -_- +7     │          │  -_- -_-    │
  ╞═══════════════════════════════════════════════╪════════════════════════════════════╪══════════╪═════════════╡
  └───────────────────────────────────────────────┴────────────────────────────────────┴──────────┴─────────────┘
  ```

  Rooms sized by headcount (Campfire and `vendor/` 90 px, left out when empty), headers in the 0–18
  band. Heroes are tiny rigs (one element each, D§11.9's last rig) in herdr's order. **Chest holders
  are drawn first and always** (gold means done: a chest is never folded into "+n"); the rest up to
  12 a station, then "+n". Uptime props (5.3) stand in the sky band.
- **Clicks and hovers.** A hero shows its terminal (D§2.7); a chest opens it (counts as seen); a
  station header opens the Localhost tab. Hover: name, rank, station, status and Fresh Eyes.
- **Stillness** (D§11.1): only the station lamps glow and the campfire flickers; no hero bobs. Calm
  mode and reduced motion apply as in the field. At 64 px the view is one line of text ("Localhost ·
  Review Desk 16 · Docs Library 14 · vendor/ 2 · LGTM 90/100 · 99.9% uptime").
- **Budget, by construction:** sky and ground ≤ 18, four headers ≤ 8, fronts and lamps ≤ 8, Uptime
  props ≤ 5, tiny rigs ≤ 12 per station plus every chest holder and its chest (worst case 30 heroes
  with chests: 60), "+n" ≤ 4, `vendor/` ≤ 5: **≤ 140 elements and ≤ 6 animated** at 30 or 60 heroes
  from 360 to 4000 px, against D§11.9's 400 / 150. The 60-hero stress world puts at most 30 heroes
  on duty (Contractors hold no jobs). The VM is memoized per (`rt.version`, tick, size), has no mobs,
  lanes or arena, and renders cheaper than the field (herdr's 50 ms budget).
- **Override of D§11.3 rule 2** (only adding or removing an agent reflows): this is a whole-strip
  change on a status rule, behind a 15-minute quiet time and a 60-minute cooldown, a few times a
  day at most, like the boss arena's reflow. DESIGN gets the exception in D§11.3.

### 7.4 Status surfaces stay the agent's (the player judge's must-avoid 3)

The pane header chip, the party row, the Roster's status column and the HUD keep the agent's own
words: "resting 11m", "shipped · chest ready" (gold), "! waiting" (amber). The job goes only into
secondary text and tooltips ("resting · at the Review Desk"), so an idle `pr-review-*` terminal never
reads as "reviewing". The stage's status tag keeps "Fresh Eyes 42m".

### 7.5 Herd panel: the Upgrades tab becomes **Localhost**

The same first tab (key 1, still seven tabs), renamed; the panel's header already says Localhost.

```
 Localhost  99.9% uptime · 12 on duty (Review Desk 6 · Docs Library 6) · vendor/: 2 contractors
 LGTMs 40 / 70   +10% XP and gold on chests you open · today 206 of 340 (61%)
 Runbooks 3 / 3  +10 s on the clock of the next frontier, Backlog or review fight · used today 2
 Last approved: “Bump deps” (Fizz) · “Fix flaky auth test” (Kip) · “Add retry to upload” (Ada) …
 [Campfire] [Coffee Machine] [CI Forge] [vendor/] [Docs Library: 6 writers · maintainer Rue]
 [War Room] [Review Desk Lv 7 · 6 reviewers · next level when the shelf fills and runs dry · Buy 64k]
 Heroes work here when their agents rest, on days you saw their work. Nothing here needs you.
```

- The building grid gets a seventh card (Review Desk); the two station cards add their staff count,
  their maintainer (top rank) and "made today". About 30 elements more than today's tab (the Roster
  tab of 30 heroes is about 280). No badge, no dot on the tab.
- The "Last approved" titles are runtime only (the engine keeps telling titles; 0 save bytes); after
  a restart the line starts empty.
- **Roster:** no new column and no new status word; a row's tooltip adds "Committer reviewer · at
  the Review Desk".

### 7.6 Character sheet: the Career tab's Job card

The same size as the Map card (about 15 elements):

```
 Job · Review Desk                                         Committer reviewer · 112 / 300
   Auto: the space name “pr-review-eng-1” says review       [Auto] [Review Desk] [Docs Library] [Campfire]
   On duty: resting since 14:02 (seen work today) · made 112 LGTMs · last “Bump deps” (Fizz)
```

- The chips set the override (command `post`); Auto returns to the derived pick.
- Interns: "Gets a job at Lv 10 (Junior)". Not on duty: "Back on duty after you see its next
  chest". Contractors: "Contractors don't hold jobs (hired tomorrow 04:00)".
- The Stats tab's XP breakdown splits chest XP into "Chest" and "LGTM".

### 7.7 Notes, toasts, journal and the Digest

- **Toasts:** none new; the three opt-in kinds and the 3-a-day cap (D§11.15) are unchanged.
- **Header notes, herd-wide and rare:** "Localhost: the Review Desk is open" (once a herd), "Docs
  Library: writing runbooks" (once, round 2), and one per new Uptime nine (five in a herd's life).
  Never for production, a rank-up, an empty shelf, or while an offline gap settles.
- **Journal:** no town lines (it holds 60 lines at 30 heroes, which the Digest and the sheet need).
- **Digest:** one "Localhost" card after the gains and before "chests waiting", only when non-zero,
  counted from the town's lifetime counters against `herd.digestSnap`:

  > Localhost: 259 chests LGTM'd (+10% XP and gold) · 2 runbooks used · Rue and 2 more reached
  > Committer · 99.9% uptime (was 99%)

---

## 8. Save format

| Where | Field | Encoding | Bytes |
|---|---|---|---|
| hero, lifetime-counters row `st` (its extras slot, as `statCodec` writes it) | `tw: [jobXp, d]`: job XP in whole units (memory keeps the fraction); `d` = game days since its last seen chest, 0 or 1, left out when 2 or more (rule 3 lapsed) | `"st":[…,{"tw":[112,0]}]` | 13–15 a hero; 0 for a hero with neither |
| hero extras `x` | `post`: the station override (1 Campfire, 2 Review Desk, 3 Docs Library), only when set | `"x":{"post":2}` | ≈ 10, rare |
| herd extras `x.town` | `s: [lgtm, runbooks]` (one decimal), `rd`: Review Desk level, `u: [lgtmUsed, runbooksUsed]` (lifetime; Uptime and the Digest), `t: [today's LGTMs, flags]` (flags: shelf full 1, ran dry 2, for the demand rule), `ru: [[heroId, rank], …]` rank-ups since the Digest was read | `"town":{"s":[40.2,3],"rd":7,"u":[1118,9],"t":[206,3]}` | ≈ 55, + 8 a waiting rank-up |
| `herd.digestSnap` | `tw: [lgtmUsed, runbooksUsed]` | | ≈ 15 |
| Hall of Fame entry | the retired hero's rank | one more small number | 2 |
| Contractor record `herd.ct` | nothing | unchanged (35–60 B) | 0 |

- **Size.** 30 heroes and the herd: ≈ 0.55 KB. D§13.3's 30-hero worst case goes from 27.3 to
  ≈ 27.9 KB (under `save.test`'s 30 KB). The owner model's save was 29.5 KB on day 7 and 31.8 KB on
  day 10 *before* the town (pending chests and the journal's names); the town adds ≈ 0.6 KB to it.
  If the 30 KB target must hold for such herds, the fix is in the chest rows, not the town.
- **The station is derived** (3.3): 0 bytes, no migration.
- **The Review Desk's level is in `x.town`, not `bld`**: `bld` keeps 6 entries, `BUILDINGS` and
  `gen` are unchanged, and an older build keeps the whole town when it loads and saves (every new
  field is an extras key, as the round-4b `look`). **SAVE_VERSION stays 1.** As built (§15), so that
  an older build's saves on later days keep the town's meaning too, `x.town` also holds `d` (the day
  it was written on, which the credits' `d` count back from) and `dg` (the Digest's baseline, in
  place of `herd.digestSnap.tw`).
- Every save in `test/fixtures/saves` loads with the town at zero (no duty, empty shelves, Review
  Desk 0, job XP 0); a new fixture `test/fixtures/saves/r6-town.json` holds a town mid-day.
- **Runtime only** (`world.rt`, never saved): the station cache, the last approved titles, the town
  view's quiet clock and cooldown (handed over on hot reload with the collapse countdown, A§2.3).

---

## 9. Engine, tools and determinism

| Module | Change |
|---|---|
| `game/data.js` | `T.town` (`balance: new`): `on`, `minLevel` 10, `gateDays` 1, `perHour` 1, `runbookCost` 8, `rankAt` [0, 25, 100, 300, 1000], `rankRate` 0.2, `shelfPerLevel` 10, `runbookShelf` 3, `lgtmBonus` 0.10, `runbookTicks` 10, `desk` {base 1000, mult 2, max 10}, `uptimeAt` [100, 500, 2500, 12500, 62500], `runbookUptime` 10, `viewQuietMin` 15, `viewCooldownMin` 60. `TOWN` table: stations, words, ranks, titles, Uptime unlocks |
| `game/town.js` (new, pure, ≈ 250 lines) | `stationOf`, `onDuty`, `stepTown` (once per step), `settleOffline`, `takeLgtm`, `takeRunbook`, `autoDesk`, `rankOf`, `uptime`, `digestTown` |
| `game/agents.js` | `openChests`: per full-value chest `takeLgtm` → ×1.10 on its XP and gold, `tally.lgtmXp`, the coin float suffix, the last-title record; the credited-Seal path sets `d = 0`; `promote` carries today's credit |
| `game/boss.js` | fight start: `takeRunbook` for frontier, Backlog and review fights → `fight.timer += 10`, `fight.runbook = true`; `estimate` untouched |
| `game/world.js` | `stepOnce` calls `stepTown` after rest and the off-duty loop; `applyOffline` calls `settleOffline` after reconcile; the 04:00 turn ages `d` and runs the demand check; commands `post` and `buy("review_desk")` |
| `game/autopilot.js` | the 60-tick pass refreshes the station cache and calls `autoDesk` (behind "Buildings") |
| `game/herd.js` | the Digest's Localhost card, `digestMark` town counters, badge `five_nines`, the Hall of Fame rank |
| `game/view/*` | `HeroVM.campfire.station`, the chip's `lgtm` and props, `TownVM` (round 3), `localhostVM` (replaces `upgradesVM`), the Job card VM, tooltips |
| `ui/*` | `stage.js` props, chip line, town view; `herdpanel.js` tab; `sheet.js` Job card |
| `tools/gen-art.mjs` | `fx/desk.svg`, `fx/shelf.svg`, two station fronts, the Uptime props, the tab icon (A§8: generated, never hand-edited) |
| `tools/pacing-sim.mjs` | `--no-town`, the town line, the gates, `--persona big` (6.3) |
| `tools/qjs` | stress30 gains a town phase |

- **Determinism** (A§3, D§12.3.12): no RNG and no `Date.now` in the town; production in hero id
  order with pro rata sharing; LGTMs in `openChests` order; Runbooks at fight start; the station
  cache recomputed deterministically; reloading never changes an outcome (shelves, job XP and credit
  days are saved; a hot reload hands the town over in `world.state`).
- **Tick cost:** one pass over the roster per step inside the loop `stepOnce` already runs for Fresh
  Eyes (≤ 30 heroes × a few multiply-adds); string splitting only on the 60-tick pass. Expected well
  under 0.1 ms in QuickJS; `npm run qjs` stress30 p95 (5.4–7 ms today, B§11) is re-measured each
  round and must not rise by more than 0.2 ms.

---

## 10. Originality

What town and job systems in other games usually have, and what this one does instead:

- **Assignment:** workers assigned to buildings. Here presence follows the agent's real state, and
  the station follows the person's own herdr space names.
- **Professions and crafting:** gathering, materials, recipes, tool durability. None here; the two
  products are dev rituals (code review and runbooks) that only multiply or extend field events.
- **Rest bonuses:** "rested" XP. Fresh Eyes is unchanged and nothing like it is added; LGTMs ride on
  Commit Chests, the game's own seen-work mechanic.
- **Dispatch and timers:** expeditions with loot, upgrade queues, offline "collect" buttons. None:
  the town rolls no loot, makes no Seals and runs no timer the player watches.
- **Names:** Localhost, Review Desk, Docs Library, LGTM, Runbook, Uptime, Five Nines, `vendor/`, and
  the open-source ranks Drive-by, Contributor, Committer, Maintainer, Core are developer vocabulary,
  not names from a game. The Staff Review's own "LGTM w/ comments" phase (D§9.6) already speaks it.
- **Art:** desk, shelf, fronts and Uptime props are new `tools/gen-art.mjs` paths in the Termling
  style. Humour stays about code and work practice, never people.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Pacing drift (single milestones move up to ±12 points on a seed) | seeds 1–4 gate with the town; mean-shift gate; the LGTM bonus is the knob (+10% → +5%) |
| A desk in a resting slot reads as "working" | the prop replaces the campfire one for one; face `-_-`, dusk tint, "z" and "Fresh Eyes" stay; status words stay the agent's (7.4) |
| The town view's whole-strip switch | 15-minute quiet, 60-minute cooldown, immediate return, never over a waiting hero; owner decision; screenshot review in round 3 |
| Role words mis-map (jargon, other languages, emoji) | class fallback; the override; the "why" line on the Job card; the owner's 32 names in a test |
| The owner rarely sees the town view (night owls until 02:00) | the chip carries the day; the Digest the night; the tab is one key away |
| "Only 1–2% of XP" feels empty | the meaning is in visible events (desks, LGTM floats, the chip's count, Runbook banners, Uptime) |
| QuickJS tick cost | one pass inside an existing loop; stress30 re-measured each round |
| Save size for very large herds | the town adds ≈ 0.6 KB; the herd's own chest rows are the larger lever |

---

## 12. Build plan (each round: fixers → reviewers → integrator, as rounds 3–4c)

Targeted test files while working (`node --test test/town.test.mjs test/save.test.mjs
test/view-stage.test.mjs`); the full `npm test`, `npm run check`, `npm run qjs`, `npm run pacing`
(seeds 1–4) and `npm run pacing -- --sweep` once at integration.

**Round 1: "The Review Desk opens"** (the smallest round that is fun on its own). **Built**
(2026-11-27): everything below, with the differences listed in section 15.

- **Engine:** `game/town.js` with the on-duty rule (2.1), the Review Desk (levels, demand-gated
  autopilot, manual buy), LGTMs (shelf, pro rata output, `takeLgtm` at ×1.10), job XP and ranks,
  Uptime counter, offline settle; `T.town` and `TOWN` in `data.js`; hooks in `world`, `agents`,
  `autopilot`; the save fields of section 8 and the `r6-town.json` fixture. One station only: every on-duty hero
  is at the Review Desk; no Runbooks, no role words yet.
- **Views:** the desk prop in resting slots, the Localhost chip ("LGTM ×n", three props, tooltip
  lines, the fold at the coarse levels), the " · LGTM" coin float, the Localhost tab (header line,
  LGTM row, last five titles, Review Desk card), a read-only Job line on the Career tab, the Digest
  line, the "Review Desk is open" note.
- **Art:** `fx/desk.svg` and its glow (`npm run art`).
- **Tools:** `--no-town`, the town line, the share and mean-shift gates, seeds 1–4.
- **Tests:** `test/town.test.mjs` (the duty rule state by state, rule 3 across the 04:00 turn and an
  offline gap, pro rata sharing, shelf caps, demand-gated buys, rank thresholds, Contractors
  excluded but their chests LGTM'd, read-only, determinism and reload); `test/save.test.mjs` (every
  fixture loads with the town at zero; the new fixture round-trips; an older-build round trip keeps
  the extras; the 30-hero worst case ≤ 30 KB); `test/view-stage.test.mjs` (budgets unchanged with
  desks and the chip line, 30 and 60 heroes, 360–4000 px); `test/pacing.test.mjs` (`--no-town`
  byte-identical; sweep and bot identical; share > 0 from day 2 and ≤ 3%).
- **Docs:** D§10.8 "Localhost jobs", B§14, A§3.2 fields, DECISIONS (the round's defaults), README.
- **Why it stands alone:** idle heroes visibly sit at desks, the morning's chests pay "· LGTM", a
  counter grows all day, the tab names the owner's own approved tasks, Uptime starts climbing, and
  the owner did nothing.

**Round 2: "Two stations"** (if owner decision 13.5 keeps the second station; with the Review
Desk only, round 2 shrinks to the Job card's override chips and the `vendor/` lines).

- The Docs Library station and Runbooks (`takeRunbook`, the banner sub-line, the boss card tooltip,
  `--no-town` covers them); role words and the class fallback (3.3); the Job card's Auto / override
  chips and its "why" line; `vendor/` lines; the "Docs Library: writing runbooks" note; the shelf
  prop art.
- Tests: the owner's 32 names map as 3.3's table; a Runbook never changes `boss.estimate` (asserted
  on a fixture fight); a repeat fight takes none; overflow between shelves; seeds 1–4 again.

**Round 3: "The town view"** (if owner decision 13.2 keeps it; otherwise round 3 keeps only the
Uptime props in the spare-width scenery, the Five Nines badge, `--persona big` and QuickJS stress).

- `TownVM` and its renderer, the Settings row, the quiet clock and cooldown (handed over on hot
  reload), station fronts and Uptime props, the Five Nines badge, `--persona big`, QuickJS stress
  with the town.
- Tests: view-stage budgets for the town view at 30 and 60 heroes, 360–4000 px, 200 / 120 / 64 px;
  the field returns on the tick a hero quests or waits; no re-entry inside the cooldown; window
  screenshots (`npm run windows -- --roles --preview`) of the owner model at 10:00, 18:00 and 03:00.

**Round 4: "Stay in town"** (only if owner decision 13.3 says yes): the per-hero switch, its marker
and the crowding rule of 13.3; e2e through `main.js`; seeds 1–4 and `--persona big` with every
hero's switch on, to show the herd's kill XP never rises.

---

## 13. Owner decisions

**Decided (2026-11-27):** the owner chose the recommendation in every case: keep the name
**Localhost** (13.1), show **the whole town** when nothing has worked for 15 minutes (13.2), a hero
**always fights** while its agent works (13.3, so build round 4 is dropped), **+10%** on a reviewed
chest (13.4), the **Docs Library** as the second station from round 2 (13.5), and stations picked
**from space names, then class** (13.6). The options below are kept as the record of what was
weighed.

### 13.1 The town's name

The town already appears as "Localhost" in the Herd panel's header and on the empty stage.
- **Keep "Localhost" (recommended):** it is already on screen, and localhost is where code lives
  before it ships, which is where your heroes are between tasks.
- Rename it "Staging": a pun too, but it clashes with the stage strip and the Staging Slopes map.

### 13.2 What the strip shows when no agent has worked for 15 minutes

Mostly overnight and early morning; it switches back the moment any agent works or needs you.
- **The whole town (recommended):** every hero at its desk or shelf, the night's unseen chests
  beside them, the shelves and the uptime in the headers.
- Today's strip, with desks instead of campfires for the heroes that fit (the rest stay in the
  "+25" corner).
- Hide the stage (today's "collapse" setting, turned on).

### 13.3 Keeping a working agent's hero in town

You asked whether agents could be assigned to town. In this design you choose each hero's station,
but a hero always fights while its agent works.
- **No: a hero always fights while its agent works (recommended).** Fighting means "my agent is
  working" at a glance, and it keeps the balance simple.
- Yes, per hero, off by default: a "Stay in town" switch on the hero's sheet, a desk marker on the
  stage while its agent works there, no kill XP for it meanwhile, and it still counts as fighting in
  the crowded-field rule, so parking tired heroes never makes the rest of the herd faster.

### 13.4 How much a reviewed chest pays

- **+10% XP and gold on chests you have seen (recommended):** about 1.1–1.5% of all XP for small
  herds and about 2% for yours; in test runs the game's planned pace stayed on target for every
  kind of user.
- +5%: about half that (0.6–0.8%), for an even lighter touch.
- Nothing: the town is for looks only (desks, counts, uptime).

### 13.5 A second station

- **Yes, from round 2 (recommended):** the Docs Library, where your docs, lead, VP, assistant and
  infra heroes write runbooks; each runbook adds 10 seconds to your next boss fight or promotion
  review. This makes the town two different jobs instead of one.
- Review Desk only: one job for every hero.

### 13.6 How each hero's station is chosen (only matters with the second station)

- **From your space names, then class (recommended):** "pr-review-*" and "*-qa" at the Review
  Desk; "docs", "*-lead", "*-vp", "ceo-assistant-*", "infra" and "hitch-ops" at the Docs Library;
  the others by how their agent works. You can change any hero on its sheet.
- By class only: no name reading.

---

## 14. Synthesis log: winner, grafts and every "must avoid"

**Winner: "glance"**, both judges' first choice; no disagreement to settle.

**Changed from glance:** LGTM +15% → +10% (the engineering judge's ceiling; fed back on seeds 1–4
it keeps every milestone inside ±15%, worst −13.4%; +15% was not adopted untested);
Runbooks from +5% damage in the estimate to +10 s outside it; the Review Desk from ×3 (29.5M) to ×2
(1.02M) and demand-gated; its level moved from `bld` to `x.town` (no GEN, older builds keep it);
tenure by the clock → job XP by what was made, plus rule 3; "reviewing" off the status surfaces; the
night view's 60 s trigger → 15 minutes and a 60-minute cooldown, and made an owner decision;
coverage percentage → Uptime as the climbing number; the leads, VPs and assistants mapping now
tested on the real names and documented with its "why".

| Must avoid (player P, engineering E) | Where it is met |
|---|---|
| P1 whole-strip flip-flop; E9 hysteresis | 7.3: 15 min quiet, 60 min cooldown, instant return, never over a waiting hero |
| P2, E1 a working hero leaving the field automatically | 2.3: never; the explicit option is decision 13.3 and still counts in crowding |
| P3 job words on agent-status surfaces | 7.4 |
| P4, E10 per-hero notes, toasts, dots, per-chest glyphs, journal lines | 4, 7.7: Digest only; the LGTM rides on the existing coin float |
| P5 tiny invisible bonuses | two products, each with a stage cue (coin float, fight banner) |
| P6, E14 materials, storage, projects, pins, switches, crafting | 5.1: none |
| P7 staffing by need | 3.3: stable, name-derived, with a "why" and an override |
| P8 an empty town in the morning | 2.2: rule 3 keeps yesterday's workers on duty (22 of 30 at 08:00) |
| P9 the chip | 7.2: one line, folded into the label at the coarse levels; no new amber |
| P10 progress from idling | 2.2, 4: rule 3 and job XP = what seen work made room for |
| P11, E4, E5 pacing margins, fed-back measurement, blind personas | 6.2–6.3: fed back, seeds 1–4, personas reach the town every night |
| P12, E7 offline lumps | 6.5 |
| P13, E11 save budget, SAVE_VERSION, fixtures | 8 |
| P14 status-tag swap | 7.2: "Fresh Eyes 42m" stays |
| P15 word tables on the real names | 3.3 table, asserted in round 2 |
| E2 gear level lifts, free targeted affixes | none in this design |
| E3 a pre-fight bonus in the estimate | 3.4: Runbooks add clock time outside it |
| E6 the gold path | 5.2: ×2 curve, demand-gated, outside the cheapest-first queue; fed back |
| E8 stacking outside the herd cap | 6.1 item 5: one ×1.10 on one chest; no per-hero buff |
| E12 purity, determinism, tick cost | 9 |
| E13 Contractors | 2.4: no jobs; slim record unchanged |

---

## 15. As built: round 1

Round 1 is built as section 12 describes (DESIGN D§10.8; ARCHITECTURE A§3.2, A§3.4; numbers in
docs/BALANCE.md §14; the defaults the spec left open in docs/DECISIONS.md "Town round 1"). Where
the build differs from this design, and why:

| Here | As built | Why |
|---|---|---|
| 2.6, 5.2: Casual and Solo stop at Review Desk 2, Typical at 4 | Casual and Solo stop at 3 (7,000 gold), Typical at 5 (31,000); Heavy reaches 10 | the overlay counted one chest a hero a tick and read the demand flags in any order; the engine counts every chest and needs the shelf full before it runs dry. Every gate holds (BALANCE §14.1) |
| 6.2: the town is 1.1–1.5% of the personas' XP, 1.65% of the owner model's ten days | 1.18–1.58% (seeds 1–4, none of the 272 milestones off ±15%); the owner model 1.46% over its 7 days (`--persona big`) | measured in the engine itself instead of the overlay; the +10% owner decision stands, no town number moved |
| 6.5: each hero is on duty for `min(gap, time until its rule 3 lapses)`, the output shared pro rata | the same, counted from the credit each hero held **when the gap began**, and the shelf's room shared **as ticking the gap would have shared it** (the heroes on duty while it filled) | a chest seen as the app comes back (reconcile runs before the settle) made a lapsed hero's gap count in full; and a lump split by possible hours gave different shares than staying open |
| 8: `t: [today's LGTMs, flags]`, flags 1 and 2 | `t: [today's LGTMs, flags, today's chests opened with full value]`; flag 4 marks a wanted level for the game day after the demand check | the tab's "today 206 of 340 (61%)" needs the chest count (≤ 4 bytes); the demand check runs at the 04:00 turn and the buy on autopilot's pass, never during an offline settle |
| 8, 9: "a hot reload hands the town over in `world.state`" | the world crosses a hot reload as save text, which rounds job XP and the shelf; the handover's `town` field carries the exact values, the last approved titles and the runtime maps (`town.handoverTown` / `takeTown`) | so a hot reload changes no outcome (a restart still rounds down, at most 1 job XP a hero and 0.1 LGTM) |
| 7.2: the chip's props are desk, shelf, campfire | desk, campfire, desk | round 1 has no shelf (the Docs Library is round 2) |
| 7.2: " · LGTM" appended to the coin float | the coin of an LGTM'd chest is drawn as one text float in coin brass, "+1.2k · LGTM", rising above the chest | the coin is a 6 px sprite with no text; the float is the same one element, so the budget holds |
| 7.2: the spare-width scenery; 7.6: the Stats tab's "Chest" and "LGTM" split | not built | not in section 12's round 1; `live.tally.lgtmXp` already holds the bonus for the split |
| 7.2: a resting hero's tooltip "At the Review Desk · …" | a shipped hero on duty, drawn by its chest in the field, says "On duty for the Review Desk while its chest waits · …" | it stands by its chest, not at a desk (gold still means done) |
| 7.4: secondary text "resting · at the Review Desk" | the chip's hero lines say it; the sheet's header line keeps "resting · “Fix flaky auth test”" (its own word and its own last task) and puts the job on the line's tooltip ("At the Review Desk · Committer reviewer · …"); a hero not on duty reads "resting at the campfire" as before | the sheet quotes the agent's last task right after the status, so "resting · at the Review Desk · “Fix flaky auth test”" read as an idle `pr-review-*` terminal reviewing that task (must-avoid P3; the final critic) |
| 8: `tw: [jobXp, d]`, `d` the game days since the credit | `d` counts back from the day the town was written on, `herd.x.town.d` (the save's own `day`, ≈ 10 B; written whenever the town is, and alone when only a credit is), not from the save's top-level `day`; when `d` is older than the save's `day` the town's game-day turn runs on load (`town.loadDay`) | an older build keeps the town and every `tw` as they were but moves `day` on: 9cd00cd re-saving a town save 5 game days later put every such hero back on duty, making job XP and LGTMs from idle time (§2.2, P10) |
| 8: `herd.digestSnap.tw` | the Digest's baseline is `herd.x.town.dg` (a town save from before reads `digestSnap.tw` into it) | an older build's Digest writes `digestSnap` anew without `tw`, and the next Localhost card counted every lifetime LGTM as new ("1,446 chests LGTM'd"); in the town it is kept like the rest |
| 7.5: the Review Desk card last in the grid | first, across both columns, above the six buildings' 3 × 2 grid; the town lines fixed at the top, the grid scrolling below | its Buy stays in view, and its name stays whole at 608 px (the 760 px dialog at zoom 1.25) without adding height |
| 2.4, 12: `vendor/` lines in round 2 | built in round 1: the chip's tooltip and the tab's header say "vendor/: 2 contractors · next hired 04:00" | cheap and useful at once for the owner's Contractors |
| 4: the Hall of Fame card keeps the rank ("Core reviewer") | the rank is saved in the entry and `herd.hallOfFame` returns `rank` and `jobTitle`; the card does not draw it yet | not in section 12's round 1 |
| 6.3.7: the sweep and the bot print the same bytes with and without the town | they do; the sweep's real autopilot gear is harvested without the town | with the town the same seed rolls its drops at other moments, and the auto-kit sweep built from that gear moves as another seed's does (BALANCE §14.4) |

Tested end to end through `main.js` (`test/town-e2e.test.mjs`): an owner-like day of 32 agents in
the 25 spaces of 3.3, herdr closed overnight and opened in the morning, a hot reload and a
Contractor promoted mid-day.

---

## Appendix A: measurements and scripts

Scripts used for the design pass (throwaway, not tracked; build round 1 moves the gates into
`tools/pacing-sim.mjs`):

- `overlay.mjs`: the final rules applied **with feedback** inside real `world.tick` runs (bonus XP via
  `heroes.grantXP`, bonus gold and Review Desk costs via `herd.addGold`, Runbooks on `fight.timer`).
  Approximations: one LGTM per hero per tick (two chests of one hero opening in the same tick count
  once), the bonus is 10% of the chest XP the engine paid that tick, and a Runbook lands one tick
  after its fight starts.
- `personas.mjs <persona> <seed> <bonus> [base|town|both]`: `simPersona` of `tools/pacing-sim.mjs`
  with and without the overlay; `summary.mjs` and `show.mjs` print the tables; `fights.mjs` and
  `pm.mjs` count big fights and Postmortems.
- `owner-town.mjs <days> <owls> <bonus>`: the owner model (the cast of `../owner-sim.mjs`: 32 agents
  in 25 spaces, plans in its header) with the overlay and the role words of `roles.mjs`;
  `owner-show.mjs` prints the hourly duty table. `roles-test.mjs` maps the owner's names.

**The owner model** (`owner-town.mjs 10 6 0.10`, about 2 minutes in V8):

- **Cast.** 32 Claude agents in the 25 spaces of 3.3 (two agents in ceo-assistant-lead, rnd-qa,
  mobile-eng, docs, infra, hitch-ops and herdr-teams). Each starts between 08:00 and 09:30 and stops
  between 19:00 and 21:00; six night owls work until about 02:00. Tasks of 15–45 working minutes
  (owls 15–90 after 20:00), half with a 1–6-minute block; a done stretch of 3–30 minutes by day and
  30–240 at night before the result is seen, then 1–8 minutes idle. herdr stays open. Six hires a
  game day: 6 → 30 heroes on days 1–5, Contractors 26 → 2.
- **XP:** kills 68.7%, chests 28.5%, bosses and reviews 2.9%; crowding averages ×0.79 whenever
  anyone fights. The town: 1.65% of all XP over the ten days.
- **Chests and LGTMs by game day** (chests opened with full value, LGTMs used, coverage): day 1 421
  / 31 / 7%, day 2 433 / 97 / 22%, day 3 433 / 109 / 25%, day 4 428 / 163 / 38%, day 5 444 / 205 /
  46%, day 6 440 / 254 / 58%, day 7 437 / 259 / 59%, day 8 442 / 281 / 64%, day 9 445 / 281 / 63%.
  Coverage is held back by the Review Desk's one level a day (levels 1 → 10 on days 1–10, 1,023,000
  gold of the herd's 456M) and, from day 8, by daytime production (about 12 heroes on duty by day
  against 38 chests an hour); ranks lift it from there.
- **On duty by hour, day 10:** 03:00 30 (Review Desk 16, Docs Library 14; shelf 90 / 100); 08:00 23
  (6 fighting); 10:00 12 (17 fighting, 10 shipped; shelf 75); 14:00 12 (shelf empty); 18:00 10.5
  (18 fighting); 21:00 28; 23:00 29 (shelf 93).
- **Ranks on day 10:** job XP 46–106 a hero (median 71); 24 Contributors and 6 Committers with the
  thresholds of 4.
- **Runbooks:** 18 of 35 big fights (mostly promotion reviews arriving in bursts after each 04:00
  hiring); about 3 Postmortems in ten days.
- **Herd:** levels 54–57 on day 10 (zone 5), buildings `[1, 10, 10, 10, 10, 5]` (the Campfire gated
  by herd age, B§6), save 29.5 KB on day 7 and 31.8 KB on day 10 before the town's own ≈ 0.6 KB.

**The personas** (`personas.mjs`, seeds 1–4, each persona's full D§12.1 length): 30–90 s a run in
V8. Seed 1 without the town: Casual kills / chests / bosses and reviews 82.2 / 13.0 / 4.8% of XP,
Solo 82.9 / 12.3 / 4.8%, Typical 83.3 / 12.2 / 4.6%, Heavy 79.4 / 15.1 / 5.5%. Big fights on seed 1
(frontier, reviews, Backlog): Casual 13, Solo 13, Typical 17, Heavy 20; repeat (farm) fights 548
(Casual) to 627 (Solo), which take no Runbook. On-duty hours a day (herd): 22, 21, 65 and 93.

**The station rule on the owner's names** (`roles-test.mjs`): Review Desk 8 by words, Docs Library
14 by words, 10 by class (all Review Desk for a Shellmancer cast; 16 · 14 in the owner model).


## Appendix B: the issue's other ideas, folded or dropped

| Idea (issue sketch) | Here | Why |
|---|---|---|
| CI Forge: polish or reroll gear over time | dropped | free polish changes nothing (autopilot polish is capped at ⌈L/10⌉ and gold is surplus, B§4); lifting worn items toward the drop line breaks B§4's reference kit (63–72% of the personas' worn items sit 7–14 levels below it: ×1.07 a level) |
| Docs Library: herd XP or boss research | Runbooks (+10 s, outside the estimate) | herd XP already has a cap that binds for big herds (D§10.4); research inside the estimate pulls challenges about three levels early |
| Coffee Machine: a coffee stock | dropped | sustain already runs at 0 crashes and ≤ 3 cups an hour on every map (B§1.2) |
| `vendor/`: salvage into materials | `vendor/` is the Contractors' lobby (cosmetic) | Snippets and junk are surplus for every herd |
| War Room: scout bosses | dropped (the War Room keeps its timers) | a scout bonus is a pre-fight estimate change |
| Review Desk: a Seal bonus | LGTMs: chest XP and gold, never Seals | Pillar 2: Seals come only from seen work |
| On-call Desk: faster Unblocked | dropped | about +0.4% XP for the owner and 0 for the personas (no blocks in their plans); too small to see |
| Job skill per station | one rank per hero | stations rarely change; per-station ranks only punish a move |
| A town economy of materials | none | 134M gold and 270k Snippets on the owner's day 7; materials would be worthless within a week |
