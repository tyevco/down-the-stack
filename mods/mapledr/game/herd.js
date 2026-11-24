// Account-wide systems (D§10): gold, seals and the Release Train, Localhost buildings, the herd
// XP bonus, the Bug Tracker, badges and the journal.
//
// SCAFFOLD: the signatures below are the ARCHITECTURE §3.4 contract and are final. The bodies
// are minimal so other modules can import and test against them; the engine-world engineer
// completes this file (badges, trophies, building effects, digest) per D§10.

import { BUILDINGS, BUG_TRACKER, ZONES } from "./data.js";
import { buildingCost, releaseOf } from "./formulas.js";

/** Add gold (rounded, never negative). */
export function addGold(state, n) {
  const herd = state.herd;
  herd.gold = Math.max(0, Math.round(herd.gold + (Number(n) || 0)));
  return herd.gold;
}

/** Credit Seals to the Release Train (D§10.3). Emits a banner when a release ships. */
export function addSeals(world, n, ev) {
  const herd = world.state.herd;
  const before = herd.rel;
  herd.seals += Math.max(0, Number(n) || 0);
  herd.rel = releaseOf(Math.floor(herd.seals));
  if (herd.rel > before) ev?.major?.();
  return herd.rel - before;
}

/** Buy one level of building bIdx. Returns {ok, cost, error?}. */
export function buy(state, bIdx) {
  const def = BUILDINGS[bIdx];
  if (!def) return { ok: false, error: "unknown building" };
  const lvl = state.herd.bld[bIdx] || 0;
  if (lvl >= def.max) return { ok: false, error: "max level" };
  const cost = buildingCost(def, lvl + 1);
  if (state.herd.gold < cost) return { ok: false, cost, error: "not enough gold" };
  state.herd.gold -= cost;
  state.herd.bld[bIdx] = lvl + 1;
  return { ok: true, cost };
}

/** Herd XP bonus as a fraction (D§10.4), capped at +60%. */
export function herdXpBonus(state) {
  const herd = state.herd;
  const rel = Math.min(60, herd.rel || 0) * 0.005;
  const docs = (herd.bld[4] || 0) * 0.02;
  return Math.min(0.6, rel + docs);
}

/** Append a journal line [at, kind, heroId, text, value]; keeps the newest 60. */
export function journal(state, kind, heroId, text, value, nowMs) {
  const log = state.herd.log;
  log.push([nowMs ?? state.herd.lastMs ?? 0, kind, heroId ?? 0, String(text ?? ""), value ?? 0]);
  if (log.length > 60) log.splice(0, log.length - 60);
}

/** Award any newly earned badges (D§10.6). */
export function checkBadges(world, ev) {
  // completed by the engine-world engineer
}

/** Count a kill in the zone's Bug Tracker (elites ×4). Returns the zone's tier (0..3). */
export function bugTrackerKill(state, zone, elite) {
  const bt = state.herd.bt;
  if (zone < 0 || zone >= ZONES.length) return 0;
  bt[zone] = (bt[zone] || 0) + (elite ? BUG_TRACKER.eliteWeight : 1);
  let tier = 0;
  for (const t of BUG_TRACKER.tiers) if (bt[zone] >= t.kills) tier++;
  return tier;
}
