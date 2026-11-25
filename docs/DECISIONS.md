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
- **Contractors in a paused fight.** Contractors are never saved, so a restart or hot reload drops
  them from a paused or running boss fight; they rejoin by questing in the fight's zone.
- **Contractors across a restart** (round 4). After a restart or hot reload the hiring line
  re-forms in snapshot order, so "longest-running first" is lost; a Contractor waiting across a
  restart at 04:00 binds as a new terminal and is hired fresh at Lv 1 if hires remain, without its
  level or kit. Saving Contractors would fix both (a save format change). D§3.4.
- **Letting a hero go for a waiting Contractor** (round 4). On a full roster with a Contractor
  waiting and a hire left, an off-duty hero below Lv 10 is let go one snapshot after its terminal
  ends (the D§3.4 rule for a new hire), so restarting that agent can delete its hero while the
  relaunched agent waits as a Contractor. Option: let go only heroes off duty for at least some
  minutes.
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
