# Down the Stack: product decisions

The owner's product calls: the ones made, and the ones still open with what the game does today.
`docs/DESIGN.md` cites this file where a rule depends on one (D§n is a DESIGN section). The
verification rounds' working notes are not part of the repository.

## Decided

### Round 4

1. **Contractors: promote only.** Six new heroes a game day (04:00 local), day one included. A
   Contractor whose agent is still live is promoted to a saved hero when hiring reopens (the 04:00
   game day turn) or when a roster slot frees (a retire, a hero let go, a hero below Lv 10 going
   off duty while the roster is full): the longest-running Contractor first, within the day's hires
   left and the rules for a new hire (D§3.2 step 3, D§3.4). It keeps its name, level, XP, class,
   seat and pane; its reference kit becomes real saved Alpha items; its journal gets
   "Hired: <name> (was a contractor)". The party row, pane header and stage tooltips, the
   character sheet's banner and the Roster say when a Contractor will be hired. D§3.4 as built.
2. **Stage strip switch.** The Herd panel's Settings tab has a "Stage strip" show/hide switch
   right before the HUD strip switch. It shows or hides the stage whoever hid it, finds the stage
   block by its content, and is disabled ("This layout has no stage") when the layout has none.
   A stage shown or hidden with it is the person's: the collapse setting never shows one hidden
   with it, and showing one calls off a running countdown. D§11.14, D§11.15.
3. **Waiting sub-agents count.** A blocked sub-agent without a pane (a Forkling) counts in
   "N need you", its group's `!` and the rail badge, as herdr's agents list ranks a parent by its
   most urgent sub-agent. A click shows it with herdr's peek (`terminal.peek`), or focuses its pane
   when it has one. The HUD's "blocked" count stays heroes only. D§11.11.
4. **Palette:** one entry, "Down the Stack: Herd panel" (`mod.open`: any layout, Digest tab,
   toggles). The character sheet and calm mode stay on the keys, the Roster and Settings tabs and
   clicks. No change from round 3.
5. **Pane header bars in splits.** The HP / XP bars show down to a pane of about 420 px (compact
   28 / 36 px bars), with herdr's terminal title cut sooner and its whole text in a tooltip; the
   bars keep a 24 px hysteresis and depend on the width and title only. D§11.12.

Following from what the README promises ("What it touches": no network, no programs, nothing read
outside its folders, writes only its data folder): the kept-aside save copies are bounded without
running a program. Each kind keeps its first incident and the newest three (`save.broken`,
`save.broken-1` to `-3`; the same for `save.unsaved`), the oldest giving way, because herdr's mod
API cannot list or delete files without `exec`, and a mod that runs programs is flagged by herdr's
install flow. D§13.1.

### Round 4b (decided by default; the owner can change any of them)

These follow from the round-4 decisions and were settled without the owner, each the smallest
change that keeps a promise already made. Each says what to change to decide otherwise.

1. **Off-duty grace (15 minutes).** Replaces round 4's open item "Letting a hero go for a waiting
   Contractor". A hero off duty for less than 15 minutes of world time (time with the app closed
   does not count) is never let go to make room, for a Contractor's promotion or for a new agent.
   A new terminal takes back its hero (its own by address, or the one whose terminal ended in that
   pane this session) before anything is let go: every new terminal's own hero first, then free
   heroes of its seat in snapshot order. After the grace the D§3.4 rule applies as before, and a
   waiting Contractor's tooltips say "Hired in about N min, once a hero below Lv 10 has been off
   duty for 15 min (unless its agent comes back)". `T.roster.offDutyGraceMin` (0 turns it off).
   D§3.2, D§3.4.
2. **A hero looks the same for life.** A promoted Contractor keeps the hoodie and hat it had: its
   hoodie tint is saved with the hero (`look`, in the hero's extras, so older builds keep it), and
   its hat gets a saved item uid of the same tint. Contractor hats now have their own colours
   instead of a pink fallback; every saved hero renders as before. D§11 (Termling art), D§13.2.
3. **One "need you" count everywhere** (decision 3 follow-up). The party chip, the Herd panel's
   header ("N need you", was "N waiting for you" counting heroes only) and the HUD's blocked
   tooltip count blocked heroes plus blocked sub-agents (`chrome.needYou`). The HUD's "blocked"
   number stays heroes only, a status tally beside working and shipped; its tooltip adds "N need
   you, counting M waiting sub-agents" when sub-agents wait. D§11.11, D§11.14.
4. **Pane header bars and the chip** (decision 5 follow-up). A pane header shows no HP / XP bars
   until herdr has reported its width (herdr lays a header out before it reports one), and the
   hysteresis keeps only bars first shown at a measured 420 px or more. The status chip outranks
   the bars and is never clipped; only a first frame narrower than the chip itself (about 150 px)
   shortens its text with "…". D§11.12.
5. **Header notes, as built.** The hires of one tick are one note, "Hired 6 contractors: Zed,
   Coda and 4 more", with every hire's line in its tooltip; it stays up for the time its hires
   were queued for (3 s each, 18 s for six), longer than D§11.15's 3 s so it can be read and
   hovered, and the hires after a tick's first do not count against the note queue (a note raised
   meanwhile still shows, after them). Herd-wide notes sit at the strip's right end by the camp
   when they fit whole there; otherwise whole in the left scenery or the roomiest room header;
   otherwise wherever they show most (a merged hire note then shows "Hired 6 contractors" whole, the
   names in its tooltip). A note about one hero (a hire, a provisional class, a
   fall-back, chests opened Unreviewed) sits over that hero's room, whole beside it in the
   Localhost scenery when the room is too narrow. Notes are cut only between words, with the whole
   text in the tooltip, and a stage under about 130 px keeps them off the camp's "+N". D§11.15.
6. **Roster rows.** A Contractor's row drops "(contractor)" when its hire line ("Hired tomorrow
   04:00", "Hired in ~12 min") shows; the slim row's tooltip keeps it. Slim rows leave out the
   Retire column when no hero in the list can retire, and keep the hire moment whole while the
   title and then the seen text give way. D§11.14.
7. **A Contractor's open sheet follows its promotion** (decision 1 follow-up) to the roster hero
   without closing, and opening that hero's sheet keeps the dialog. D§11.13.
8. **Older builds and newer saves.** Not an update path (the README only goes forward), so
   SAVE_VERSION stays 1. An older build loads a newer save and keeps the hero fields it does not
   know (a promoted hero's `look`), but writes the round-4 journal name column back as stale
   string-table indices, so after going back to an older build and forward again, lines about
   heroes no longer on the roster can show another hero's name or "A hero". Accepted as cosmetic;
   a version bump would make older builds open newer saves read-only instead. D§13.2.

### Round 4c (decided by default; the owner can change either)

1. **Header notes keep their point** (Round 4b, 5 follow-up). Every note about one hero has short
   forms that keep the event and the hero's first name and drop the epithet: "Tamsin: chest
   opened Unreviewed" (then "Tamsin: chest Unreviewed"), "Hired: Nell (was a contractor)" (then
   "Hired Nell"), "New hire: Nell", "Tamsin: provisional Hotfixer" (then "Tamsin: Hotfixer"),
   "Tamsin fell back to 1-1", "REVIEW: Tamsin vs …" (then "REVIEW: Tamsin"), "Tamsin retired". The
   stage shows the longest form that fits whole; the whole text stays in the tooltip. A note about
   a hero with no room of its own (off duty, at camp, retired) goes where herd-wide notes go, by
   the camp at the strip's ends, never over another hero's room header; a hero with a room gets
   its room, else the scenery beside it, else the camp's corner whole rather than cut over its
   room. Herd-wide notes that lost their point when cut got short forms too: a fight's notes drop
   the boss's name ("Install complete"), "3-1 cleared: 3-2 open", "Dependency Jungle open",
   "Coffee Machine 12", "Postmortem · retry in 10 working min", "Boss fight paused", "Boss
   FIXED". To decide otherwise: a form list in the engine's note tag (`short`). D§11.15.
2. **Space names are cut in the middle** (Round 4b, 6 follow-up). Where several space names are
   cut to one width (the Roster's space column and space headers, the party's group headers, the
   character sheet's Rebind lines), a name that may not fit keeps both ends, "ceo-assi…res-2": its
   last part stays whole and the start gives way, so two "ceo-assistant-…" spaces stay apart; the
   whole name is in the tooltip (the slim row's own tooltip names it; a Rebind line's is on its
   Bind button). A Rebind line, "Claude Code in ceo-a…billing-eng · “…”", lets the task title give
   way first and keeps up to 12 characters of the space's end, so "…search-eng" and "…billing-eng"
   stay apart. The stage's room headers name maps, not spaces, and the sheet's header names one
   space, so neither changes. D§11.14.

### Round 5

1. **Contractors across a restart: a slim record** (owner decision; was open since round 4). A
   Contractor is kept as a slim record in the save (`herd.ct`, about 35 bytes with a seat a saved
   hero shares, 60 with a seat of its own like "ceo-assistant-res-2/claude"): its number (its id,
   which gives its default name, hoodie and hat), seat, level, XP, class (with its provisional flag
   and reviews; the signature window too while the class can still change, an Intern's or a
   provisional one, 3 bytes a task), its place in the hiring line and the game day it was last seen,
   and a 5-character tag of its terminal's address. After a restart or a hot reload a new terminal
   of its seat with no saved hero to take is that Contractor again (its own terminal first, by the
   tag; herdr's core keeps terminals while the app is closed), so herdr closed across 04:00 hires a
   waiting Contractor at its level. For a short reconnect window after a load (60 s,
   `T.roster.reconnectSec`) a record whose terminal is not listed yet keeps its hire and its place in
   line, so a newcomer listed first takes only the hires left beyond it. A record not claimed for 7
   game days is dropped (`T.roster.contractorKeepDays`); the records are capped at the roster's
   size (30), live Contractors first, the oldest unclaimed going first. A read-only world neither
   claims nor writes one. SAVE_VERSION stays 1: an older build drops the records (its Contractors
   come back new, as before). D§3.2, D§3.4, D§13.2.

Decided by default with it (the smallest change that keeps the promise; each says what to change
to decide otherwise):

2. **A Contractor whose terminal ends keeps its record too**, not only one live at a save: closing
   its pane then quitting the app, or restarting its agent in a new pane, brings it back as itself
   with its seat's next terminal (the record's 7 game days apply). Otherwise: write records for live
   Contractors only (`agents.goOffDuty` keepRecord).
3. **A saved hero of the seat comes first**: a new terminal takes a free saved hero of its seat
   (D§3.2) before a Contractor record, even when it is that Contractor's own terminal; the record
   waits. A terminal of the seat listed a few snapshots before the Contractor's own takes the record
   by seat, as a free saved hero is taken today (round 4b's own-first rule holds within one listing).
   So when herdr lists a seat's two terminals in different snapshots after a start, the two can swap:
   the Contractor's terminal, listed first, takes the seat's saved hero (its own terminal not listed
   yet), and the hero's terminal then takes the Contractor's record (in the review's random restarts
   listed over three snapshots, 37 of 300 had such a swap; none when every terminal is listed at
   once). Before round 5 the same terminal took the saved hero too and the hero's agent came back as
   a new Contractor. Otherwise: a terminal's own record (by tag) before a free saved hero of its seat
   (`reconcile` step 1a skips a terminal whose own record is there, and 1a' claims it).
4. **What a record does not keep**: its kit (rebuilt as the reference kit for its level and class),
   its skills (re-spent by the auto-learn rule), XP below the whole point, Daily Shift, Fresh Eyes,
   HP, cooldowns and pending chests. The chests keep round 4's behaviour: while its agent plays they
   wait for "seen" and pay the herd; when its terminal ends they open Unreviewed for the herd at once;
   chests still waiting when the app closes are not kept. Session-keyed state (journal ids, review
   Wounds and Lessons, inbox finder, fight seats) is dropped on load as before; its journal lines
   keep its name.
5. **A newcomer held back by the window** plays as a Contractor (at the herd's median level minus
   five) and is promoted keeping that level when a hire is left for it, as any agent that arrives
   while the day's hires are taken. Otherwise: hold the newcomer unbound until the window ends.
6. **Rebind lets the Contractor go**: moving a Contractor's agent onto a benched hero keeps no record
   of it (the person chose the saved hero). Otherwise: keepRecord in `agents.rebind`.
7. **Told**: a Contractor's sheet banner reads "… · not on the roster until then; …" (was "not
   saved until then"), its tooltip adds that the herd remembers its name, level, XP, class and place
   in line across restarts and for 7 game days while its agent is away (not its kit or chests);
   right after a load, one behind a held record reads "Hired in about 40 s, unless a contractor from
   before the restart comes back first"; the Roster's count line ends "· 1 contractor off duty" for
   records waiting for their agent. D§11.13, D§11.14.

### Earlier rounds

- Round 3: the palette's sheet and calm-mode entries were dropped (decision 4 above keeps it so).
- Round 1: the game's status colours are the layout's own and never override herdr's tokens
  (D§11.1).

## Open

Each item says what the game does now; nothing changes until the owner decides.

- **Toast lifetime.** Toasts use herdr's default (5 s for "success") and close whether or not the
  herdr window is active, as herdr's own agent toasts do; the Digest keeps every line. Options:
  pass `timeout: 12000` (herdr's own layout notes use it), or hold posts until
  `window()?.active`. D§11.15.
- **Rebind and the Daily Shift.** Rebind moves an agent onto the target hero's own Shift, so
  rotating one agent across benched heroes keeps full rate past 4 / 8 working hours. Recommended:
  accept it (manual, deliberate, single-player; D§12.3). Alternative: the target takes the larger
  of the two heroes' working minutes for today. D§3.2.
- **The off-duty chest dot.** While an off-duty hero's chest is within 4 h of opening Unreviewed,
  the Herd button's dot stays lit until the chest is claimed or opens; viewing the Digest does not
  clear that one. Once a chest has opened Unreviewed, the dot stays lit until the Digest is viewed
  (round 4). D§2.4.
- **A herd-first kill's Keepsake.** It is named in the boss toast while "Herd-first boss kill" is
  on, so the kill spends one of the day's three toasts; it raises its own "LTS or Keepsake drop"
  toast only while the boss kind is off. D§11.15.
- **Contractors in a paused fight.** A Contractor's slim record (round 5) does not keep its seat in
  a fight, so a restart or hot reload drops it from a paused or running boss fight; it rejoins by
  questing in the fight's zone.
- **A restart in a new pane** (round 4b). The off-duty grace (Round 4b, 1) protects a restarted
  agent's hero for 15 minutes. A relaunch in the same pane (the agent exits inside herdr's shell,
  or a new terminal in a pane that survived) takes its own hero back; closing the pane and opening
  a new one in the same space instead takes the seat's highest-level free hero (D§3.2), which may
  be another hero than its own when the seat has several off duty. herdr gives a new pane a new id,
  so nothing ties it to the old one.
- **Hovered narrow pane headers** (round 4). At about 396–440 px, hovering keeps the compact bars
  (a hover never toggles them), so the title shrinks to its icon and a "! 2m" chip gives way to the
  four pane buttons until the pointer leaves. D§11.12.
- **Round 2's product calls**, all as built: the notification day is the 04:00 game day; the stage
  collapses 60 s after the last hero stops; toasts have no icon; a milestone whose save never lands
  is lost (at most once); at most 30 stage slots (`MAX_SLOTS`) and a 24-element effects reserve;
  the small and tiny rigs, the drawn `!` bubble (20 px hit area), "SHIPPED ×n" and the "+n !"
  Forkling counter; `taskLabel` lets a telling title beat a tab the person named (herdr's agents
  list does the opposite).

## Ideas for later

- **Town.** The fighting agents keep levelling in the field; other agents could be assigned to
  jobs and stations in a town (a setting named to fit the game). Not designed yet; to be written
  up as a GitHub issue.
