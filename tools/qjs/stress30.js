// The 30-hero herd ("stress30"), one recipe for every tool that builds it: tools/fixtures.mjs (the
// npm run check roles stage-30, party-30, herd-roster-30, and its tests) imports it under Node, and
// tools/qjs/driver.js imports it inside QuickJS-ng (npm run qjs), so the two always run the same
// world. Plain ES2020 with no imports of its own: `G` holds the game modules of the caller's module
// graph ({ Demo, W, liveHeroes, rollItem, stashPut, addGold, addSnippets }).
//
// The roster maximum (TUNING.roster.max 30), and the stage's element and animation budget's hardest
// case (D§11.9.7, ARCHITECTURE §6.1): 30 agents hired over five days (6 a day) in three spaces,
// every sixth with three sub-agents (Forklings), high levels and rare gear, a full stash, the late
// zones open, and a zone boss fight started 30 s before `nowMs`.

const SEC = 1000;
const DAY = 24 * 3600 * SEC;

export function stressWorld(G, nowMs) {
  const { Demo, W } = G;
  const t0 = nowMs - 5 * DAY - 10 * 60 * SEC;
  const plans = [[["working", 3000]], [["working", 1500], ["done", 300]], [["working", 600], ["blocked", 90], ["working", 900]], [["idle", 600], ["working", 1200]], [["working", 2000], ["done", 120], ["idle", 200]]];
  const progs = ["claude", "codex", "pi", "opencode"];
  const ags = [];
  for (let k = 0; k < 30; k++) {
    const sp = k % 3;
    const subs = k % 6 === 0 ? [0, 1, 2].map((j) => ({ address: `t${k + 1}s${j}`, plan: [["working", 400 + 50 * j], ["done", 60]], title: `sub ${j}` })) : [];
    ags.push(Demo.makeAgent({
      address: `t${k + 1}`, program: progs[k % progs.length], space: `spc_${sp + 1}`, spaceName: ["herdr-app", "infra", "api-gateway"][sp],
      tab: `tab_${sp}_${k >> 3}`, tabIndex: k >> 3, tabName: `t${k >> 3}`, plan: plans[k % plans.length], start: (k * 137) % 1500, titleIdx: k,
      from: t0 + Math.floor(k / 6) * DAY, subs,
    }));
  }
  const cast = Demo.makeCast(ags, { focus: "t3" });
  const world = W.createWorld({ nowMs: t0, seed: 7 });
  Demo.runCast(world, cast, t0 + SEC);
  for (let d = 1; d <= 5; d++) {
    Demo.advanceCast(cast, (t0 + d * DAY - world.state.herd.lastMs) / SEC);
    W.tick(world, Demo.castSnapshot(cast, t0 + d * DAY));
  }
  Demo._internal.clearZones(world, 8, { kills: 4 });
  const classes = ["refactorer", "hotfixer", "shellmancer", "forkbinder", "rubberducker"];
  const heroes = G.liveHeroes(world).map((p) => p[0]);
  heroes.forEach((h, i) => Demo._internal.grow(world, h, { L: 95 - (i % 10) * 3, cls: classes[i % classes.length], rar: i % 3 === 0 ? 4 : 3, pol: 6, keepsake: i < 9 ? i : -1 }));
  const finder = heroes[0];
  for (let k = 0; k < 120; k++) {
    const it = G.rollItem(finder, { ilvl: 70 + (k % 30), source: k % 7 === 0 ? "boss" : "chest", classId: finder.cls, state: world.state });
    G.stashPut(world.state, it);
  }
  G.addGold(world.state, 9e7);
  G.addSnippets(world.state, 40000);
  world.state.herd.bld = [9, 9, 8, 9, 7, 6];
  world.state.herd.born = world.state.herd.day - 64;
  Demo.runCast(world, cast, nowMs - 30 * SEC);
  world.rt.demo = { cast };
  const challenge = W.command(world, "challenge", { kind: "boss", idx: 7 }, nowMs - 30 * SEC);
  Demo.runCast(world, cast, nowMs);
  world.rt.demo = { cast };
  return { world, snapshot: Demo.castSnapshot(cast, nowMs), challenge };
}
