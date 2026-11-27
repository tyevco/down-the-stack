// Localhost fixtures for tests (docs/TOWN.md round 1): put a town into any world, the way the
// engine keeps it (game/town.js), without playing the days it takes. Pure Node ESM; read-only for
// other test files: keep the API stable.
//
//   seedTown(world, {rd, shelf, used, today, chests, flags, ranks, credit, jobXp, titles})
//     rd       Review Desk level (default 1); shelf: LGTMs on it (default 0); used: lifetime LGTMs
//     today / chests / flags: herd.town.t (today's LGTMs, flags FULL 1 DRY 2 WANT 4, full-value chests)
//     ranks    [[heroId, rank], ...] waiting for the Digest (herd.town.ru)
//     credit   true (default): every roster hero of Lv 10+ has seen work today (st.tw creditDay =
//              herd.day); a number: that many game days ago; false: none
//     jobXp    a number for every roster hero, or a function (hero, i) -> number
//     titles   [{title, heroId, name, byId, byName}] the last approved, newest first (runtime)
//   -> the herd.town object

import { townState } from "../../mods/down-the-stack/game/town.js";
import { TUNING as T } from "../../mods/down-the-stack/game/data.js";

export function seedTown(world, opts = {}) {
  const { state } = world;
  const town = townState(state);
  town.rd = opts.rd ?? 1;
  town.s[0] = opts.shelf ?? 0;
  town.u[0] = opts.used ?? 0;
  town.t = [opts.today ?? 0, opts.flags ?? 0, opts.chests ?? 0];
  town.ru = (opts.ranks || []).map((e) => e.slice());
  const credit = opts.credit ?? true;
  state.heroes.forEach((h, i) => {
    if (!h.st) h.st = { kills: 0, tasks: 0, seals: 0, wh: 0, dodges: 0, healed: 0 };
    const xp = typeof opts.jobXp === "function" ? opts.jobXp(h, i) : opts.jobXp || 0;
    const tw = [xp];
    if (credit !== false && h.L >= T.town.minLevel) tw.push((state.herd.day || 0) - (credit === true ? 0 : credit));
    if (tw.length > 1 || xp) h.st.tw = tw;
    else delete h.st.tw;
  });
  if (opts.titles) {
    if (!world.rt) world.rt = {};
    world.rt.town = { jobs: new Map(), owed: new Map(), titles: opts.titles.map((x) => Object.assign({ at: 0, byId: null, byName: null, title: null }, x)) };
  }
  return town;
}
