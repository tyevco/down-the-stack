// Down the Stack: content tables.
//
// Every block between the "D§14.x" banners is DESIGN §14 transcribed verbatim (same ids, same array
// order, same numbers); test/formulas.test.mjs re-reads docs/DESIGN.md and checks that every value
// there is present here unchanged. Array index = integer id used in saves: append-only, never reuse.
// Percent values are fractions (0.03 = 3%). Skill coefficient pairs are [base, perRankAboveOne].
//
// Below the verbatim tables come (a) things the design references outside §14 or leaves open,
// each marked "design gap:" or citing its section, and (b) derived lookups (MAPS, *_BY_ID, ...).
// Treat everything exported here as read-only.
//
// Pure module: no imports, no host calls.

/** Content generation: bump when ids are appended or remapped (D§13.4). */
export const GEN = 1;

// ---------------------------------------------------------------------------------------------
// D§14.1 Tuning constants, classes and careers
// ---------------------------------------------------------------------------------------------

export const TUNING = {
  tickMs: 1000, maxCatchUpTicks: 5, offlineGapSec: 60, taskCloseTicks: 8, bubbleDelayTicks: 2, g: 1.07,
  weaponBase: 6, hpBase: 60, armorBase: 3, drConst: 25, drCap: 0.75, mobHpFactor: [1.6, 0.62],
  mobSwingPctOfRefHp: 0.03, xpBase: [4, 1.06], goldBase: [2, 1.05], kOfL: [22, 8, 0.18, 2.5],
  levelCap: 100, refKillsPerMin: 15.5,
  ref: {
    iOffset: 2, rarityPerL: 0.0048, polishPerL: 0.005, dmgPerL: 0.003, might: 2.3, grit: 1.7, keen: 0.7,
    critPerKeen: 0.0015, critPerL: 0.0005, hpPerL: 0.003, armorK: 13.5, armorPerL: 0.002
  },
  critBase: 0.05, critCap: 0.5, critMult: 1.5, dodgeCap: 0.3, cdrCap: 0.4, extraActCap: 0.15,
  itemFindCap: 1.5, regen: { engaged: 0.005, advance: 0.02, resting: 0.05 },
  coffee: { threshold: 0.45, cooldown: 5, heal: 0.35, carry: 20, refillTicks: 30, priceGoldMult: 2 },
  crash: { downTicks: 5, returnHp: 0.5, dropMapAfter: [3, 600], dropMapForSec: 1800 },
  lane: { size: 3, advanceScrollPx: 48, eliteOneIn: 80, duckOneIn: 20000, firstSwingDelay: 1 }, // balance: firstSwingDelay new (design 0: swings on the first hit)
  gap: { freeAbove: 2, lossPerLevel: 0.1, floor: 0.03, bonusPerLevelBelow: 0.05, bonusCapLevels: 5 }, // balance: floor (design 0.1)
  seals: {
    minMinutes: 1.5, perMinute: 0.1, capMinutes: 120, chestGoldPerSeal: 20, chestXpPerSeal: 45,
    mergeWindowSec: 300, unreviewedAfterSec: 86400, forklingMinuteCredit: 0.25
  },
  shift: { resetHourLocal: 4, bandsMin: [240, 480], kill: [1, 0.5, 0.25], seal: [1, 0.75, 0.5] },
  freshEyes: { accruePerMin: 0.25, capBaseMin: 60, capPerCampfire: 15, xpMult: 1.5 },
  unblocked: { minBlockedSec: 10, minTaskSec: 60, ticks: 120, dmg: 0.15, xp: 0.15, cooldownTicks: 300 },
  party: { perMember: 0.06, cap: 0.18, banner: 0.05 }, herdXpCap: 0.6,
  onboarding: { xp: 0.5, levelsBehind: 10 }, crowdingAt: 12,
  // offDutyGraceMin (round 4b): a hero off duty for less than this (world time, from its seenAt) is
  // never let go to make room for a hire or a Contractor's promotion: a restarted agent gets it back
  roster: { max: 30, newPerDay: 6, contractorLevelsBelowMedian: 5, offDutyGraceMin: 15 },
  forkling: { pctOfMain: 0.12, counted: 3 }, flap: { changes: 6, windowSec: 60, suppressSec: 300 },
  boss: {
    partyHpPerExtra: 0.75, swingEvery: 2, timer: 180, enrageAt: 0.8, enrageDmg: 0.5, warRoomTicks: 6,
    maxParticipants: 6, woundsKeep: 0.5, woundsSec: 172800, lessonsPerFail: 0.1, lessonsCap: 0.5,
    retryWorkingSec: 600, suspendAfterSec: 600, estimateMargin: 0.85, autoAt: 0.9, farmAt: 1.5, // balance: autoAt (design 1.0)
    repeatCooldownWorkingSec: 10800, helperCapLevels: 3, crashRejoinTicks: 10,
    xpFirst: 0.1, xpRepeat: 0.02 // balance: Need(L) per first / repeat kill (design 0.5 / 0.1, D§6.2)
  },
  release: { seals: [8, 1.35], bonusPer: 0.005, maxRelease: 60 },
  sprint: [6, 10, 25, 45, 70, 105, 160, 215, 300], quotaPerMap: 40, buildingCostGrowth: 3,
  buildingAutoBuyAt: 3, goldReserve: 0.2,
  loot: { ilvlOffset: -6, taperFrom: 50 }, // balance: new (D§8.6 item levels -6, fading to 0 at Lv 100)
  campfireDaysPerLevel: 6, // balance: new (D§10.2 has no gate; the D§12.1 model's Fresh Eyes cap grows by day / 6)
  polish: { goldBase: 100, exp: 1.6, forgeDiscount: 0.04, perLevel: 0.05, portShare: 0.5 },
  skills: {
    rankGate: 1, respecSnippetsPerLevel: 5, careerChangeSnippetsPerLevel: 25, classFreeUntilLevel: 20,
    classLockTasks: 15
  },
  fx: { numbersPerHero: 2, numbersPerRoom: 6, numbersPerStage: 12, bannerMaxMs: 3000 }
};

// Index = class id in saves (0 = intern).
export const CLASSES = [
  {
    n: 0, id: "intern", name: "Intern", role: "starter", weapon: "stick",
    growth: { might: 2.3, grit: 1.7, keen: 0.5, luck: 0.5 }, innate: null,
    weights: { dps: 0.6, ehp: 0.4 }, silhouette: "Lanyard with a blank badge"
  },
  {
    n: 1, id: "refactorer", name: "Refactorer", role: "tank", weapon: "blade",
    growth: { might: 2.2, grit: 2.3, keen: 0.5, luck: 0 },
    innate: { id: "clean_hands", name: "Clean Hands", hpPct: 0.1, bossFront: true },
    signature: { rule: "medianTaskMin", op: ">=", value: 15, priority: 3 },
    weights: { dps: 0.45, ehp: 0.55 }, silhouette: "Broad keycap body, scarf, big blade"
  },
  {
    n: 2, id: "hotfixer", name: "Hotfixer", role: "single target", weapon: "knives",
    growth: { might: 2.4, grit: 1, keen: 1.6, luck: 0 },
    innate: { id: "hot_hands", name: "Hot Hands", crit: 0.05, critMult: 1.6 },
    signature: { rule: "medianTaskMin", op: "<=", value: 5, priority: 4 },
    weights: { dps: 0.7, ehp: 0.3 }, silhouette: "Headlamp, hoodie, two knives"
  },
  {
    n: 3, id: "shellmancer", name: "Shellmancer", role: "area caster", weapon: "pipe",
    growth: { might: 2.6, grit: 1.4, keen: 0.5, luck: 0.5 },
    innate: { id: "verbose", name: "Verbose", areaTargets: 1 },
    signature: { rule: "default", priority: 5 }, weights: { dps: 0.7, ehp: 0.3 },
    silhouette: "Pointy hood with a blinking cursor at the tip"
  },
  {
    n: 4, id: "forkbinder", name: "Forkbinder", role: "summoner", weapon: "manpage",
    growth: { might: 2.2, grit: 1.6, keen: 0.6, luck: 0.6 },
    innate: { id: "parent_process", name: "Parent Process", forklingPct: 0.2 },
    signature: { rule: "subAgentShare", op: ">=", value: 0.25, priority: 1 },
    weights: { dps: 0.65, ehp: 0.35 }, silhouette: "Floating open book with orbiting dots"
  },
  {
    n: 5, id: "rubberducker", name: "Rubberducker", role: "support", weapon: "duck",
    growth: { might: 2, grit: 2, keen: 0.5, luck: 0.5 },
    innate: { id: "good_listener", name: "Good Listener", roomUnblockedMult: 2 },
    signature: { rule: "blocksPerWorkingHour", op: ">=", value: 2, priority: 2 },
    weights: { dps: 0.5, ehp: 0.5 }, silhouette: "Ochre raincoat (#C08A3E), duck on a staff"
  }
];

export const CAREERS = [
  { title: "Intern", from: 1, to: 9, gate: null },
  { title: "Junior", from: 10, to: 29, gate: "level" },
  { title: "Senior", from: 30, to: 59, gate: "seniorReview", unlockSlot: "sig" },
  { title: "Staff", from: 60, to: 89, gate: "staffReview", unlockSlot: "ult" },
  { title: "Principal", from: 90, to: 100, gate: "level", unlockSlot: "cap" }
];

// ---------------------------------------------------------------------------------------------
// D§14.2 Skills (`skills` is exported as SKILLS.byClass per ARCHITECTURE §3.1)
// ---------------------------------------------------------------------------------------------

export const SKILLS = {
  slots: [
    { slot: "main", unlock: 1, max: 20 },
    { slot: "area", unlock: 5, max: 15 },
    { slot: "passive", unlock: 10, max: 15 },
    { slot: "buff", unlock: 20, max: 15 },
    { slot: "sig", unlock: 30, max: 15, needs: "seniorReview" },
    { slot: "ult", unlock: 60, max: 15, needs: "staffReview" },
    { slot: "cap", unlock: 90, max: 10 }
  ],
  autoLearnTieOrder: ["ult", "sig", "main", "area", "cap", "passive", "buff"],
  byClass: {
    intern: [
      {
        id: "hello_world", slot: "main", name: "Hello, World", unlock: 1, max: 8, cd: 0,
        eff: { type: "hit", coef: [1, 0.03], targets: 1 },
        cue: "A tiny 'hi' speech bubble flies at the mob"
      },
      {
        id: "printf", slot: "area", name: "printf()", unlock: 5, max: 5, cd: 4,
        eff: { type: "hit", coef: [0.7, 0.03], targets: 3 }, cue: "A burst of %d glyphs"
      }
    ],
    refactorer: [
      {
        id: "extract_method", slot: "main", name: "Extract Method", cd: 0,
        eff: { type: "hit", coef: [1, 0.03], targets: 1 }, cue: "White crescent slash, 200 ms"
      },
      {
        id: "rename_symbol", slot: "area", name: "Rename Symbol", cd: 4,
        eff: { type: "hit", coef: [0.7, 0.03], targets: 3 },
        cue: "Blade whirl; letters foo turn into bar and scatter"
      },
      {
        id: "strong_typing", slot: "passive", name: "Strong Typing", cd: 0,
        eff: { type: "passive", perRank: { hpPct: 0.02, dr: 0.01 } },
        cue: "Faint :T glyphs on the body"
      },
      {
        id: "code_review", slot: "buff", name: "Code Review", cd: 30,
        eff: { type: "buff", ticks: 10, self: { dmg: [0.1, 0] }, room: { dmgTaken: [-0.05, -0.005] } },
        cue: "Magnifying-glass halo"
      },
      {
        id: "big_picture", slot: "sig", name: "Big Picture", cd: 0,
        eff: { type: "proc", everyActions: 6, coef: [2, 0.08], targets: 1, splash: 0.5 },
        cue: "Blueprint grid flashes across the slot floor"
      },
      {
        id: "big_rewrite", slot: "ult", name: "The Big Rewrite", cd: 45,
        eff: { type: "hit", coef: [5, 0.25], targets: "lane", bossAdds: true },
        cue: "Scaffolding rises for 2 ticks, then a 150 ms white wipe limited to the slot"
      },
      {
        id: "clean_architecture", slot: "cap", name: "Clean Architecture", cd: 0,
        eff: { type: "passive", perRank: { dmg: 0.02, dr: 0.01 } }, cue: "Silver trim on the scarf"
      }
    ],
    hotfixer: [
      {
        id: "quick_patch", slot: "main", name: "Quick Patch", cd: 0,
        eff: { type: "hit", coef: [0.6, 0.02], targets: 1, hits: 2, merged: true },
        cue: "Two quick flashes"
      },
      {
        id: "cherry_pick", slot: "area", name: "Cherry-Pick", cd: 4, anyTime: true,
        eff: {
          type: "hit", coef: [1.8, 0.06], targets: "lowestHp", executeBelow: 0.15, executeBoss: false
        },
        cue: "Cherry-shaped blink puff"
      },
      {
        id: "works_on_my_machine", slot: "passive", name: "Works On My Machine", cd: 0,
        eff: { type: "passive", perRank: { dodge: 0.01 } }, cue: "Dodged hits show 404"
      },
      {
        id: "stealth_commit", slot: "buff", name: "Stealth Commit", cd: 30,
        eff: {
          type: "buff", ticks: [5, "floor(rank/5)"], self: { alwaysCrit: true, untargetable: true }
        },
        cue: "Sprite at 50% opacity"
      },
      {
        id: "bisect", slot: "sig", name: "Bisect", cd: 0,
        eff: {
          type: "stacks", perStack: { dmg: 0.05 }, maxStacks: [5, "floor(rank/3)"],
          resetOnTargetChange: true
        },
        cue: "Pip counter above the target"
      },
      {
        id: "push_to_main", slot: "ult", name: "Push to Main", cd: 40,
        eff: { type: "hit", coef: [1, 0.05], targets: 1, hits: 8, alwaysCrit: true, merged: true },
        cue: "->main streaks"
      },
      {
        id: "zero_downtime", slot: "cap", name: "Zero Downtime", cd: 0,
        eff: { type: "passive", perRank: { dodge: 0.01, critDmg: 0.02 }, onDodgeHealPct: 0.01 },
        cue: "none"
      }
    ],
    shellmancer: [
      {
        id: "echo_bolt", slot: "main", name: "Echo Bolt", cd: 0,
        eff: { type: "hit", coef: [1, 0.03], targets: 1, ranged: true },
        cue: "> glyph projectile, 300 ms"
      },
      {
        id: "pipe_chain", slot: "area", name: "Pipe Chain", cd: 4,
        eff: { type: "hit", coef: [0.65, 0.03], targets: 3 }, cue: "| glyphs link the targets"
      },
      {
        id: "tab_completion", slot: "passive", name: "Tab Completion", cd: 0,
        eff: { type: "passive", perRank: { freeMainChance: 0.01 } }, cue: "A ghosted second bolt"
      },
      {
        id: "sudo", slot: "buff", name: "Sudo", cd: 30,
        eff: { type: "buff", ticks: 8, self: { dmg: [0.14, 0.01] } }, cue: "Tiny # crown"
      },
      {
        id: "cron_job", slot: "sig", name: "Cron Job", cd: 0,
        eff: { type: "proc", everyActions: 6, coef: [2, 0.08], targets: 1, splash: 0.5 },
        cue: "Clock-face projectile"
      },
      {
        id: "midnight_batch", slot: "ult", name: "Midnight Batch", cd: 50,
        eff: { type: "hit", coef: [0.8, 0.04], targets: "lane", hits: 3, merged: true, bossAdds: true },
        cue: "Three * meteors, on the hero's own cooldown"
      },
      {
        id: "root_access", slot: "cap", name: "Root Access", cd: 0,
        eff: { type: "passive", perRank: { dmg: 0.02, ignoreBossDr: 0.02 } }, cue: "Green title bar"
      }
    ],
    forkbinder: [
      {
        id: "spawn_process", slot: "main", name: "Spawn Process", cd: 0,
        eff: { type: "hit", coef: [0.85, 0.025], targets: 1, bonusHit: 0.2, merged: true },
        cue: "&-tailed imp nips the target"
      },
      {
        id: "background_jobs", slot: "area", name: "Background Jobs", cd: 4,
        eff: { type: "hit", coef: [0.65, 0.03], targets: 3 }, cue: "Three & imps dart out"
      },
      {
        id: "process_pool", slot: "passive", name: "Process Pool", cd: 0,
        eff: { type: "passive", perRank: { forklingPct: 0.01 }, countedAtRanks: [5, 10, 15] },
        cue: "Forklings wear tiny gear badges"
      },
      {
        id: "daemonize", slot: "buff", name: "Daemonize", cd: 0,
        eff: { type: "summon", everyTick: true, pctOfMain: [0.15, 0.01] },
        cue: "Cron Sprite; a small sparkle every 60 ticks, phase-offset per hero"
      },
      {
        id: "thundering_herd", slot: "sig", name: "Thundering Herd", cd: 0,
        eff: { type: "proc", everyActions: 6, coef: [0.9, 0.045], targets: "lane" },
        cue: "Summons dash across the lane"
      },
      {
        id: "fork_bomb", slot: "ult", name: "Fork Bomb", cd: 45,
        eff: { type: "hit", coef: [0.9, 0.045], targets: "randomLane", hits: 8, merged: true },
        cue: "Imps double 1, 2, 4, 8; 'Resource temporarily unavailable' fades in"
      },
      {
        id: "supervisor_tree", slot: "cap", name: "Supervisor Tree", cd: 0,
        eff: { type: "passive", perRankPerSummon: { dmg: 0.01 }, maxSummons: 7 },
        cue: "A small tree glyph over the book"
      }
    ],
    rubberducker: [
      {
        id: "quack", slot: "main", name: "Quack", cd: 0,
        eff: { type: "hit", coef: [1.05, 0.03], targets: 1, ranged: true }, cue: "Expanding ring"
      },
      {
        id: "explain_it_out_loud", slot: "area", name: "Explain It Out Loud", cd: 4,
        eff: { type: "healOrHit", healBelow: 0.85, heal: [0.08, 0.005], coef: [0.7, 0.03], targets: 3 },
        cue: "Speech squiggle, or a duck wave"
      },
      {
        id: "rubber_duck_debugging", slot: "passive", name: "Rubber Duck Debugging", cd: 0,
        eff: { type: "aura", perRank: { roomXp: 0.01, roomDmg: 0.005 }, highestOnly: true },
        cue: "none"
      },
      {
        id: "pair_programming", slot: "buff", name: "Pair Programming", cd: 30,
        eff: { type: "buff", ticks: 10, self: { dmg: [0.11, 0.01] }, ally: "lowestLevel" },
        cue: "{ } brackets around the pair"
      },
      {
        id: "ducklings", slot: "sig", name: "Ducklings", cd: 0,
        eff: {
          type: "summon", everyTick: true, count: [1, 2], secondAtRank: 8, pctOfMain: [0.19, 0.01]
        },
        cue: "Ducklings waddle behind"
      },
      {
        id: "retrospective", slot: "ult", name: "Retrospective", cd: 45,
        eff: {
          type: "roomRestore", reviveRoom: true, fullHealRoom: true, buffTicks: 15,
          roomDmg: [0.29, 0.01]
        },
        cue: "Sticky notes flutter up"
      },
      {
        id: "psychological_safety", slot: "cap", name: "Psychological Safety", cd: 0,
        eff: { type: "aura", perRank: { roomDr: 0.01 }, rebootFasterTicksPer2Ranks: 1 },
        cue: "Soft cream aura #FFF4D6"
      }
    ]
  }
};

// ---------------------------------------------------------------------------------------------
// D§14.3 Zones and maps
// ---------------------------------------------------------------------------------------------

export const ZONES = [
  {
    n: 0, id: "lint_meadows", name: "Lint Meadows", levels: [1, 11], boss: 0, sprint: 6,
    palette: { sky: "#CFEFD8", far: "#8FD19E", ground: "#4E8F5F", accent: "#E0605A" },
    scenery: "Soft green hills; dandelions with red squiggly stems", perk: { xp: 0.02 },
    maps: [
      { id: "1-1", name: "Squiggle Path", levels: [1, 4], spawn: { typo_sprout: 1 } },
      {
        id: "1-2", name: "Whitespace Fields", levels: [5, 8],
        spawn: { semicolon_sloth: 0.75, typo_sprout: 0.25 }
      },
      {
        id: "1-3", name: "Warning Gate", levels: [9, 11],
        spawn: { unused_import: 0.75, semicolon_sloth: 0.25 }
      }
    ]
  },
  {
    n: 1, id: "callback_caverns", name: "Callback Caverns", levels: [12, 22], boss: 1, sprint: 10,
    palette: { sky: "#2B2140", far: "#463566", ground: "#2E2545", accent: "#9EE6FF" },
    scenery: "Indigo caves; stalactites shaped like {{{; glowing mushrooms", perk: { gold: 0.03 },
    maps: [
      { id: "2-1", name: "Mouth of the Stack", levels: [12, 15], spawn: { callback_bat: 1 } },
      {
        id: "2-2", name: "Nested Tunnels", levels: [16, 19],
        spawn: { promise_wisp: 0.75, callback_bat: 0.25 }
      },
      {
        id: "2-3", name: "Pyramid Steps", levels: [20, 22],
        spawn: { null_pointer_frog: 0.75, promise_wisp: 0.25 }
      }
    ]
  },
  {
    n: 2, id: "regex_ruins", name: "Regex Ruins", levels: [23, 33], boss: 2, sprint: 25,
    palette: { sky: "#F3DDB0", far: "#C99A5B", ground: "#8C6A3E", accent: "#2FB9A8" },
    scenery: "Sandstone dusk; turquoise pillars carved ^.*$", perk: { crit: 0.01 },
    maps: [
      { id: "3-1", name: "Anchor Steps", levels: [23, 26], spawn: { capture_group_goblins: 1 } },
      {
        id: "3-2", name: "Quantifier Colonnade", levels: [27, 30],
        spawn: { backslash_bandit: 0.75, capture_group_goblins: 0.25 }
      },
      {
        id: "3-3", name: "The Unparsed Gate", levels: [31, 33],
        spawn: { greedy_glob: 0.75, backslash_bandit: 0.25 }
      }
    ]
  },
  {
    n: 3, id: "merge_marshes", name: "Merge Marshes", levels: [34, 44], boss: 3, sprint: 45,
    palette: {
      sky: "#D8E3C2", far: "#8FA36A", ground: "#4F5E34", accent: "#E05A5A", accent2: "#5AC46A"
    },
    scenery: "Olive swamp; fence posts of <<<<<<<; two-tone diff water", perk: { hpPct: 0.02 },
    maps: [
      { id: "4-1", name: "Fast-Forward Ford", levels: [34, 37], spawn: { diff_leech: 1 } },
      {
        id: "4-2", name: "Stash Bog", levels: [38, 41],
        spawn: { rebase_wraith: 0.75, diff_leech: 0.25 }
      },
      {
        id: "4-3", name: "Octopus Delta", levels: [42, 44],
        spawn: { merge_conflict_golem: 0.75, rebase_wraith: 0.25 }
      }
    ]
  },
  {
    n: 4, id: "dependency_jungle", name: "Dependency Jungle", levels: [45, 55], boss: 4, sprint: 70,
    palette: { sky: "#CDEBC0", far: "#4E9A5A", ground: "#24502E", accent: "#F2C14E" },
    scenery: "Vines drawn as arrow graphs; crates stamped pkg", perk: { itemFind: 0.03 },
    maps: [
      { id: "5-1", name: "Lockfile Clearing", levels: [45, 48], spawn: { left_pad_mites: 1 } },
      {
        id: "5-2", name: "Transitive Thicket", levels: [49, 52],
        spawn: { transitive_vine: 0.75, left_pad_mites: 0.25 }
      },
      {
        id: "5-3", name: "The Heaviest Grove", levels: [53, 55],
        spawn: { version_pin_porcupine: 0.75, transitive_vine: 0.25 }
      }
    ]
  },
  {
    n: 5, id: "threadlock_keep", name: "Threadlock Keep", levels: [56, 66], boss: 5, sprint: 105,
    palette: { sky: "#2A2A2E", far: "#8A5A3B", ground: "#1F1F22", accent: "#FFB347" },
    scenery: "Copper clockwork castle; padlocks; sparks", perk: { dmg: 0.02 },
    maps: [
      { id: "6-1", name: "Critical Section", levels: [56, 59], spawn: { race_condition_rats: 1 } },
      {
        id: "6-2", name: "Semaphore Walls", levels: [60, 63],
        spawn: { spinlock_top: 0.75, race_condition_rats: 0.25 }
      },
      {
        id: "6-3", name: "The Twin Locks", levels: [64, 66],
        spawn: { starved_thread: 0.75, spinlock_top: 0.25 }
      }
    ]
  },
  {
    n: 6, id: "legacy_catacombs", name: "Legacy Catacombs", levels: [67, 77], boss: 6, sprint: 160,
    palette: { sky: "#121A14", far: "#2C3B2E", ground: "#0D130F", accent: "#66FF99" },
    scenery: "CRT tombstones with green text; punch-card bricks", perk: { cdr: 0.02 },
    maps: [
      { id: "7-1", name: "Deprecated Stairs", levels: [67, 70], spawn: { todo_ghost: 1 } },
      {
        id: "7-2", name: "Hall of Comments", levels: [71, 74],
        spawn: { anonymous_author: 0.75, todo_ghost: 0.25 }
      },
      {
        id: "7-3", name: "Spaghetti Vaults", levels: [75, 77],
        spawn: { spaghetti_mummy: 0.75, anonymous_author: 0.25 }
      }
    ]
  },
  {
    n: 7, id: "production_peaks", name: "Production Peaks", levels: [78, 88], boss: 7, sprint: 215,
    palette: { sky: "#1C2236", far: "#3E4A6B", ground: "#151A2A", accent: "#FF5A5F" },
    scenery: "Stormy summit; cliffs of blinking server racks", perk: { dr: 0.01 },
    maps: [
      { id: "8-1", name: "Staging Slopes", levels: [78, 81], spawn: { flaky_test_phantom: 1 } },
      {
        id: "8-2", name: "Canary Cliffs", levels: [82, 85],
        spawn: { memory_leak_slime: 0.75, flaky_test_phantom: 0.25 }
      },
      {
        id: "8-3", name: "Friday Summit", levels: [86, 88],
        spawn: { pager_wyvern: 0.75, memory_leak_slime: 0.25 }
      }
    ]
  },
  {
    n: 8, id: "undefined_depths", name: "Undefined Depths", levels: [89, 99], boss: 8, sprint: 300,
    palette: { sky: "#1A1030", far: "#3A2466", ground: "#120A22", accent: "#C8A6FF" },
    scenery: "Void violet; glitch static; floating NaN motes", perk: { bossDmg: 0.02 },
    maps: [
      { id: "9-1", name: "Off-By-One Steps", levels: [89, 92], spawn: { off_by_one_twins: 1 } },
      {
        id: "9-2", name: "Bitflip Grotto", levels: [93, 96],
        spawn: { bitflip_moth: 0.75, off_by_one_twins: 0.25 }
      },
      {
        id: "9-3", name: "Observer's Edge", levels: [97, 99],
        spawn: { undefined_behavior: 0.75, bitflip_moth: 0.25 }
      }
    ]
  }
];

// ---------------------------------------------------------------------------------------------
// D§14.4 Mobs and traits
// ---------------------------------------------------------------------------------------------

export const TRAITS = {
  fast: { swingEvery: 1 }, slow: { swingEvery: 3 }, tanky: {}, swarm: { count: 2 },
  phaser: { missChance: 0.2 }, clumsy: { selfMissChance: 0.2, healsHero: false },
  pending: { invulnTicks: 2 }, leech: { healPct: 0.15 }, reviver: { chance: 0.25, hp: 0.4 },
  splitter: { halves: 2, hpPct: 0.3, xpPct: 0.3 }, grower: { perTick: 0.03, cap: 0.6 },
  thorns: { reflect: 0.03, meleeOnly: true, capPerTick: 0.004 }, ranged: { fromSlot: 2, swingEvery: 3 }, // balance: thorns reflect (design 0.08), capPerTick new
  shapeshifter: { everyTicks: 5, exclude: ["swarm", "splitter"] }
};

export const ELITE = {
  prefix: "Smelly", hp: 3, atk: 1.5, xp: 4, gold: 4, itemChance: 0.2, rareWeightMult: 2,
  snippetChance: 0.25, scale: 1.25
};

export const HOLO_DUCK = {
  name: "Holo Rubber Duck", hp: 4, attacks: false, leaveAfterTicks: 20, drop: "duck_chest"
};

export const MOBS = [
  {
    id: "typo_sprout", zone: 0, map: 1, name: "Typo Sprout", size: "S", traits: [], hp: 1, atk: 0.7,
    xp: 0.88, gold: 1, sprite: "Seedling whose leaf says teh", // balance: atk (design 1), xp (design 1)
    flavor: "Sprouts wherever fingers outrun eyes."
  },
  {
    // round 4 (originality): was "Semicolon Snail" (a snail as the first slow mob echoed a famous
    // game's starter monsters); same numbers, new creature, new id (mob ids are never saved)
    id: "semicolon_sloth", zone: 0, map: 2, name: "Semicolon Sloth", size: "S", traits: ["slow"],
    hp: 1.3, atk: 0.8, xp: 0.86, gold: 1, sprite: "A sleepy sloth crawling low, a ; marked on its back", // balance: atk (design 1.4), xp (design 1.2)
    flavor: "Optional in some regions. Gets there eventually."
  },
  {
    id: "unused_import", zone: 0, map: 3, name: "Unused Import", size: "M", traits: ["tanky"], hp: 1.6,
    atk: 0.5, xp: 1.47, gold: 1.5, sprite: "Sleeping imp hugging a crate it never opens", // balance: atk (design 0.8), xp (design 1.4)
    flavor: "Imported years ago. Never called."
  },
  {
    id: "callback_bat", zone: 1, map: 1, name: "Callback Bat", size: "S", traits: ["fast"], hp: 0.8,
    atk: 0.6, xp: 0.81, gold: 1, sprite: "Boomerang-shaped wings", // balance: xp (design 0.9)
    flavor: "Will call you back. Eventually. Possibly twice."
  },
  {
    id: "promise_wisp", zone: 1, map: 2, name: "Promise Wisp", size: "S", traits: ["pending"], hp: 1.1,
    atk: 1, xp: 1.16, gold: 1, sprite: "Cocoon with a loading spinner", // balance: xp (design 1.1)
    flavor: "Pending... pending... resolved."
  },
  {
    id: "null_pointer_frog", zone: 1, map: 3, name: "Null Pointer Frog", size: "M", traits: ["clumsy"],
    hp: 1, atk: 1.2, xp: 0.96, gold: 1, sprite: "Frog with an arrow-to-nothing belly", // balance: xp (design 1.1)
    flavor: "Points confidently at nothing."
  },
  {
    id: "capture_group_goblins", zone: 2, map: 1, name: "Capture Group Goblins", size: "S",
    traits: ["swarm"], swarm: 2, hp: 0.6, atk: 0.7, xp: 0.66, gold: 0.6, // balance: xp (design 0.6)
    sprite: "Two goblins holding ( and )", flavor: "They travel in (pairs)."
  },
  {
    id: "backslash_bandit", zone: 2, map: 2, name: "Backslash Bandit", size: "M", traits: ["phaser"],
    phaser: 0.2, hp: 0.9, atk: 1.1, xp: 1.07, gold: 1.2, sprite: "Masked thief with a slash-shaped cape", // balance: xp (design 1)
    flavor: "Always escaping."
  },
  {
    id: "greedy_glob", zone: 2, map: 3, name: "Greedy Glob", size: "M", traits: ["leech"], leech: 0.15,
    hp: 1.3, atk: 1, xp: 1.11, gold: 2, sprite: "Blob stamped .* swallowing pebbles", // balance: xp (design 1.3)
    flavor: "Matches everything. Including your lunch."
  },
  {
    id: "diff_leech", zone: 3, map: 1, name: "Diff Leech", size: "S", traits: ["leech"], leech: 0.2,
    hp: 0.9, atk: 1, xp: 0.86, gold: 1, sprite: "Red-and-green striped leech", // balance: xp (design 0.9)
    flavor: "+3 -3. Mostly -."
  },
  {
    id: "rebase_wraith", zone: 3, map: 2, name: "Rebase Wraith", size: "M", traits: ["reviver"],
    reviver: 0.25, hp: 1, atk: 1.2, xp: 1.01, gold: 1, sprite: "Ghost trailing afterimages", // balance: xp (design 1.2)
    flavor: "Rewrites history. Says it's cleaner."
  },
  {
    id: "merge_conflict_golem", zone: 3, map: 3, name: "Merge Conflict Golem", size: "L",
    traits: ["tanky", "splitter"], hp: 1.6, atk: 0.9, xp: 1.33, gold: 1.5, // balance: xp (design 1.6)
    sprite: "Golem whose chest reads <<<<<<< ======= >>>>>>>; splits into HEAD and incoming halves",
    flavor: "Two halves, both convinced they're right."
  },
  {
    id: "left_pad_mites", zone: 4, map: 1, name: "Left-Pad Mites", size: "S", traits: ["swarm"],
    swarm: 2, hp: 0.5, atk: 0.6, xp: 0.56, gold: 0.5, sprite: "Tiny mites carrying a whole vine", // balance: xp (design 0.5)
    flavor: "Tiny. Load-bearing."
  },
  {
    id: "transitive_vine", zone: 4, map: 2, name: "Transitive Vine", size: "M", traits: ["grower"],
    hp: 1, atk: 0.9, xp: 1.11, gold: 1, sprite: "Vine dragging crates nobody ordered", // balance: atk (design 1), xp (design 1.2)
    flavor: "You didn't plant it. Something you planted did."
  },
  {
    id: "version_pin_porcupine", zone: 4, map: 3, name: "Version Pin Porcupine", size: "M",
    traits: ["thorns"], thorns: 0.03, hp: 1.3, atk: 1, xp: 1.1, gold: 1.2, // balance: thorns (design 0.08), xp (design 1.3)
    sprite: "Quills tipped with ^ and ~", flavor: "Pinned to 0.3.1 forever."
  },
  {
    id: "race_condition_rats", zone: 5, map: 1, name: "Race Condition Rats", size: "S",
    traits: ["swarm", "fast"], swarm: 2, hp: 0.55, atk: 0.5, xp: 0.64, gold: 0.6, // balance: xp (design 0.6)
    sprite: "Twin rats that never arrive in the same order", flavor: "The winner changes every run."
  },
  {
    id: "spinlock_top", zone: 5, map: 2, name: "Spinlock Top", size: "M", traits: ["phaser"],
    phaser: 0.25, hp: 0.9, atk: 0.9, xp: 1.02, gold: 1, sprite: "A top that never stops spinning", // balance: xp (design 1)
    flavor: "Very busy. Accomplishes nothing."
  },
  {
    id: "starved_thread", zone: 5, map: 3, name: "Starved Thread", size: "M", traits: ["slow"], hp: 1.1,
    atk: 1.55, xp: 0.92, gold: 1, sprite: "Thin ghost holding a ticket number", // balance: atk (design 1.8), xp (design 1.2)
    flavor: "Hasn't been scheduled since Tuesday."
  },
  {
    id: "todo_ghost", zone: 6, map: 1, name: "TODO Ghost", size: "S", traits: ["phaser"], phaser: 0.15,
    hp: 0.9, atk: 0.9, xp: 0.88, gold: 1, sprite: "Ghost wearing a // TODO (2011) tag", // balance: xp (design 0.9)
    flavor: "Will be removed before launch."
  },
  {
    id: "anonymous_author", zone: 6, map: 2, name: "Anonymous Author", size: "M", traits: ["ranged"],
    hp: 0.9, atk: 1, xp: 0.82, gold: 1, sprite: "Hooded quill with a name tag reading unknown", // balance: atk (design 1.1), xp (design 1)
    flavor: "git blame shrugs."
  },
  {
    id: "spaghetti_mummy", zone: 6, map: 3, name: "Spaghetti Mummy", size: "L", traits: ["tanky"],
    hp: 1.6, atk: 0.8, xp: 1.24, gold: 1.5, sprite: "Wrapped in 4,000 lines of pasta", // balance: xp (design 1.5)
    flavor: "No tests. No regrets."
  },
  {
    id: "flaky_test_phantom", zone: 7, map: 1, name: "Flaky Test Phantom", size: "M",
    traits: ["phaser", "reviver"], phaser: 0.2, reviver: 0.2, hp: 0.9, atk: 1, xp: 1.08, gold: 1, // balance: xp (design 1.1)
    sprite: "Flickers in and out", flavor: "Passes on retry. Fails in CI."
  },
  {
    id: "memory_leak_slime", zone: 7, map: 2, name: "Memory Leak Slime", size: "M", traits: ["grower"],
    hp: 1, atk: 1, xp: 1.09, gold: 1, sprite: "A slime that keeps swelling", // balance: xp (design 1.2)
    flavor: "A little bigger every tick. Nobody restarts it."
  },
  {
    id: "pager_wyvern", zone: 7, map: 3, name: "Pager Wyvern", size: "M", traits: ["ranged", "fast"],
    hp: 0.9, atk: 0.7, xp: 0.84, gold: 1, sprite: "Small wyvern with a buzzing beeper", // balance: xp (design 1.1)
    flavor: "Beeps at 3 AM. Every time."
  },
  {
    id: "off_by_one_twins", zone: 8, map: 1, name: "Off-By-One Twins", size: "S", traits: ["swarm"],
    swarm: 3, hp: 0.45, atk: 0.6, xp: 0.54, gold: 0.45, sprite: "Twins. There are three of them.", // balance: xp (design 0.45)
    flavor: "There's always one more."
  },
  {
    id: "bitflip_moth", zone: 8, map: 2, name: "Bitflip Moth", size: "S", traits: ["phaser", "clumsy"],
    phaser: 0.25, clumsy: 0.1, clumsyHealsHero: true, hp: 0.9, atk: 1.1, xp: 0.97, gold: 1, // balance: xp (design 1)
    sprite: "Moth drawn to tiny cosmic-ray sparks", flavor: "Sometimes it flips the wrong bit."
  },
  {
    id: "undefined_behavior", zone: 8, map: 3, name: "Undefined Behavior", size: "L",
    traits: ["shapeshifter"], hp: 1.2, atk: 1.1, xp: 1.05, gold: 1.2, // balance: xp (design 1.4)
    sprite: "Blob that renders differently every few seconds",
    flavor: "Legally allowed to do anything."
  }
];

// ---------------------------------------------------------------------------------------------
// D§14.5 Bosses and reviews
// ---------------------------------------------------------------------------------------------

export const BOSSES = [
  {
    n: 0, id: "ignored_warning", name: "The Ignored Warning", zone: 0, level: 12, bk: 16, ak: 1,
    timer: 180, mech: 0.85, look: "Giant amber triangle printed 999+, monocle, cape of tiny triangles",
    mechanics: [
      {
        phase: 1, from: 1, to: 0.5, type: "spawnAdd", every: 20,
        add: { name: "Warning Mite", hp: 1, atk: 0.5 }, maxAlive: 3, bossDmgPerAdd: 0.1
      },
      {
        phase: 2, from: 0.5, to: 0, type: "burstAdds", count: 4,
        add: { name: "Warning Mite", hp: 1, atk: 0.5 }, invulnWhileAddsAtLeast: 2, dmgAfter: 0.3,
        label: "Promoted to Error"
      }
    ],
    enrage: { name: "Treat warnings as errors", dmg: 0.5 }, keepsake: "hazard_cone_hat",
    flavor: "Yellow since the first commit. Everyone scrolls past it."
  },
  {
    n: 1, id: "pyramid_of_doom", name: "The Pyramid of Doom", zone: 1, level: 23, bk: 28, ak: 1.3,
    timer: 180, mech: 0.85, look: "Stepped pyramid of nested braces with one eye per layer",
    mechanics: [
      { type: "layers", count: 3, overkillWasted: true },
      {
        type: "onLayerBreak", invulnTicks: 6, label: "await",
        add: { name: "Callback Bat", hp: 1, atk: 0.6, count: 3 },
        then: { label: "resolve()", hitAllPctMaxHp: 0.2, ifAddsDead: 0.05 }
      },
      { type: "finalLayerDmg", dmg: 0.3 }
    ],
    enrage: { name: "Callback hell", dmg: 0.5 }, keepsake: "curly_brace_crown",
    flavor: "Indented 47 levels deep. The base case is a rumor."
  },
  {
    n: 2, id: "catastrophic_backtracker", name: "The Catastrophic Backtracker", zone: 2, level: 34,
    bk: 32, ak: 1.6, timer: 180, mech: 0.8, look: "Long serpent of .*.*.* tokens coiled into a loop",
    mechanics: [
      {
        type: "burstCheck", every: 25, everyBelow30: 18, telegraphTicks: 5, label: "Trying again...",
        bubble: "(a+)+$", needPctMaxHp: 0.05,
        success: { stunTicks: 3, dmgTaken: 0.2, label: "Anchored" },
        fail: { healPctOfDamageLast: 0.5, windowTicks: 15 }
      }
    ],
    enrage: { name: "Timeout exceeded", dmg: 0.5 }, keepsake: "lazy_quantifier_boots",
    flavor: "One step forward, 2^n steps back."
  },
  {
    n: 3, id: "octopus_merge", name: "The Octopus Merge", zone: 3, level: 45, bk: 24, ak: 1.6,
    timer: 180, mech: 0.75,
    look: "Plum-coloured octopus with tentacles labelled feat/ fix/ wip/ docs/ test/ chore/ hotfix/ refactor/",
    mechanics: [
      {
        type: "shieldParts", parts: 8, partHpPctOfBody: 0.05, shieldWhileAtLeast: 4,
        bodyDmgTaken: -0.75, label: "Merging... {n} branches left", regrowTicks: 20,
        regrowTicksBelow40: 12, partAttack: { every: 4, pctOfSwing: 0.3, target: "random" },
        singleTargetHits: "lowestPartWhileShielded", areaHits: "partsAndBody"
      }
    ],
    enrage: { name: "Merge queue full", dmg: 0.5 }, keepsake: "octo_hoodie",
    flavor: "Merges eight branches at once. All of them are wrong."
  },
  {
    n: 4, id: "bloatodon", name: "Bloatodon, the Heaviest Object", zone: 4, level: 56, bk: 30, ak: 1.6,
    timer: 180, mech: 0.8,
    look: "Whale-sized crate stamped pkg, stuffed with smaller crates, on tiny legs",
    mechanics: [
      { type: "grow", every: 12, maxHpPct: 0.04, healPct: 0.04, counter: "+{n} deps" },
      {
        type: "spawnAdd", every: 30, add: { name: "Left-Pad Mite", hp: 0.5, atk: 0.6, count: 3 },
        drPerAdd: 0.05, drCap: 0.2
      },
      { type: "enrageAtCounter", counter: 10, label: "Install complete" }
    ],
    enrage: { name: "Install complete", dmg: 0.5 }, keepsake: "lockfile_mug",
    flavor: "Pulled in by a one-line helper. Now outweighs the sun."
  },
  {
    n: 5, id: "deadlock_hydra", name: "The Deadlock Hydra", zone: 5, level: 67, bk: 29, ak: 1.6, // balance: bk (design 32)
    timer: 180, mech: 0.85, look: "Two-headed copper hydra; each head clutches the key the other wants",
    mechanics: [
      {
        type: "twinHeads", heads: ["Mutex", "Semaphore"], singleTargetHits: "higherHpPct",
        areaHits: "both", waitingGapPts: 10, resumeGapPts: 5, biteEvery: 3, bitePctOfSwing: 0.6,
        noBasicAttack: true
      },
      {
        type: "balanceCheck", every: 40, telegraphTicks: 3, label: "Deadlock", withinPts: 5,
        success: { stunTicks: 4, dmgTaken: 0.25, label: "Resolved" }, fail: { partyWaitTicks: 3 }
      }
    ],
    enrage: { name: "Starvation", biteEvery: 2 }, keepsake: "mutex_twinfang",
    flavor: "Each head is waiting for the other to let go."
  },
  {
    n: 6, id: "monolith", name: "The Monolith", zone: 6, level: 78, bk: 28, ak: 1.6, timer: 180, // balance: bk (design 32)
    mech: 0.75, look: "Towering grey slab with blinking LEDs that cracks into glowing cubes",
    mechanics: [
      {
        phase: 1, from: 1, to: 0.6, label: "Tightly Coupled", singleTargetDmgTaken: -0.25,
        slam: { every: 4, pctOfSwing: 0.8, target: "all" }, noBasicAttack: true
      },
      {
        phase: 2, from: 0.6, to: 0, label: "Decompose", split: 6, meshHealPctPerOtherPerTick: 0.0025,
        partAttack: { every: 5, pctOfSwing: 0.5, target: "random" }, singleTargetHits: "lowestPart"
      },
      { phase: 3, when: "onePartLeft", label: "Distributed Monolith", dmg: 1, swingEvery: 2 }
    ],
    enrage: { name: "Big-bang release", dmg: 0.5 }, keepsake: "microservice_badge",
    flavor: "Split into six services. Still deploys as one."
  },
  {
    n: 7, id: "friday_deploy", name: "The Friday Deploy", zone: 7, level: 89, bk: 32, ak: 1.6,
    timer: 180, mech: 0.85,
    look: "Midnight-blue dragon in a tiny party hat, pager on its collar, tail a flaming progress bar stuck at 99%",
    mechanics: [
      {
        type: "clock", from: "4:55 PM", to: "5:00 PM", ticks: 30,
        onZero: { name: "Outage Breath", hitAllPctMaxHp: 0.3, drFactor: 0.5 }
      },
      {
        phase: 2, from: 0.66, to: 0.33, label: "4:59 PM", type: "spawnAdd", every: 25,
        add: { name: "Pager Wyvern", hp: 1, atk: 0.7, count: 2 }, clockSpeedPerAdd: 0.25
      },
      {
        phase: 3, from: 0.33, to: 0, label: "Long Weekend", clockTicks: 20, partyDmg: 0.25,
        partyBuffName: "Ship It"
      }
    ],
    enrage: { name: "The weekend is ruined", outagePct: 0.45 }, keepsake: "weekend_pass",
    badge: "read_only_friday", flavor: "Arrives at 4:55 PM on a Friday. Never alone."
  },
  {
    n: 8, id: "heisenbug", name: "The Heisenbug", zone: 8, level: 100, bk: 40, ak: 1.6, timer: 240,
    mech: 0.85, look: "Translucent moth-like bug with a dotted outline that never quite holds still",
    mechanics: [
      {
        type: "stance", every: 20, teleport: true,
        states: [
          { name: "Position", singleTargetMult: 1.5, areaMult: 0.5, sprite: "sharp" },
          { name: "Momentum", singleTargetMult: 0.5, areaMult: 1.5, sprite: "blurred" }
        ]
      },
      { type: "pulse", every: 30, hitAllPctMaxHp: 0.15, label: "Wavefunction" },
      {
        type: "observed", when: "anyParticipantFocused", cosmetic: "shimmer + eye icon",
        delayNextStanceTicks: 5, neverPenalty: true
      }
    ],
    enrage: { name: "Cannot reproduce", stanceEvery: 10 }, keepsake: "uncertainty_lens",
    flavor: "Only reproduces when nobody is looking. Looking helps a little."
  }
];

export const REVIEWS = [
  {
    id: "senior_review", level: 30, opponent: "You, Six Months Ago", hpMobs: 20, swingEvery: 2, ak: 1.3,
    timer: 150, bubbleAt: 0.5, bubble: "who wrote this?",
    reward: { title: "Senior", sp: 1, item: { slot: "weapon", rarity: 3 } }
  },
  {
    id: "staff_review", level: 60, opponent: "The Senior Reviewer", hpMobs: 26, swingEvery: 3, ak: 2,
    timer: 180, phases: ["nit:", "blocking:", "LGTM w/ comments"],
    onPhase: { add: { name: "Nitpick", hp: 1, atk: 0.5, count: 2 }, dmgTakenWhileAdds: -0.5 },
    reward: { title: "Staff", sp: 1, item: { slot: "sticker", rarity: 3 } }
  }
];

// ---------------------------------------------------------------------------------------------
// D§14.6 Rarities, drop weights, affixes, LTS properties, Keepsakes
// ---------------------------------------------------------------------------------------------

export const RARITIES = [
  {
    n: 0, id: "prototype", name: "Prototype", color: "#A0A4AB", mult: 1, affixes: 0, polishMax: 3,
    deprecate: 2, wKill: 64, wChest: 35
  },
  {
    n: 1, id: "alpha", name: "Alpha", color: "#5BD16A", mult: 1.1, affixes: 1, polishMax: 5,
    deprecate: 4, wKill: 26, wChest: 40
  },
  {
    n: 2, id: "beta", name: "Beta", color: "#4EA3FF", mult: 1.22, affixes: 2, polishMax: 7,
    deprecate: 8, wKill: 8, wChest: 19
  },
  {
    n: 3, id: "release", name: "Release", color: "#B36BFF", mult: 1.36, affixes: 3, polishMax: 9,
    deprecate: 20, wKill: 1.9, wChest: 5.2
  },
  {
    n: 4, id: "lts", name: "LTS", color: "#FF9A2E", mult: 1.52, affixes: 3, property: true,
    polishMax: 10, deprecate: 40, wKill: 0.1, wChest: 0.8
  },
  {
    n: 5, id: "keepsake", name: "Keepsake", color: "#FF7AA8", mult: 1.7, affixes: 3, unique: true,
    polishMax: 12, deprecate: null, wKill: 0, wChest: 0
  }
];

export const DROP_WEIGHTS = {
  duckChest: { beta: 45, release: 40, lts: 15 }, bossFirst: { release: 70, lts: 30 },
  bossRepeat: { beta: 50, release: 40, lts: 10, keepsakeChance: 0.15 },
  chestTierFloor: { silver: "alpha", gold: "beta" }, itemFindAffects: ["beta", "release", "lts"],
  slots: { weapon: 20, hat: 16, hoodie: 16, mug: 16, boots: 16, sticker: 16 }, weaponOwnClass: 0.7,
  killItemChance: 0.004, killSnippetChance: 0.03
};

// balance: the damage, crit, speed, XP, gold and item-find affix ranges are halved (design values
// on each line): with 3-4 affixes on most worn items, autopilot gear carried 2-3x the reference
// kit's D_ref = 0.003 L (D§5.2). The defensive ones (Typed, Robust, Uptime, Idempotence, Rate
// Limiting) keep the design ranges. docs/BALANCE.md.
export const AFFIXES = [
  {
    n: 0, id: "memo", name: "Memoized", kind: "prefix", stat: "dmg", lo: 0.01, hi: 0.02,
    slots: ["weapon", "hat", "mug", "sticker"] // balance: lo/hi (design 0.02 / 0.04)
  },
  {
    n: 1, id: "lint", name: "Linted", kind: "prefix", stat: "crit", lo: 0.005, hi: 0.01,
    slots: ["weapon", "hat", "sticker"] // balance: lo/hi (design 0.01 / 0.02)
  },
  {
    n: 2, id: "opt", name: "Optimized", kind: "prefix", stat: "critDmg", lo: 0.025, hi: 0.05,
    slots: ["weapon", "sticker"] // balance: lo/hi (design 0.05 / 0.1)
  },
  {
    n: 3, id: "async", name: "Async", kind: "prefix", stat: "extraAct", lo: 0.0025, hi: 0.005,
    slots: ["weapon", "boots", "sticker"] // balance: lo/hi (design 0.005 / 0.01)
  },
  {
    n: 4, id: "typed", name: "Typed", kind: "prefix", stat: "armorPct", lo: 0.04, hi: 0.08,
    slots: ["hat", "hoodie", "mug", "boots"]
  },
  {
    n: 5, id: "robust", name: "Robust", kind: "prefix", stat: "hpPct", lo: 0.03, hi: 0.06,
    slots: ["hat", "hoodie", "mug", "sticker"]
  },
  {
    n: 6, id: "recur", name: "Recursive", kind: "prefix", stat: "repeatHit", lo: 0.005, hi: 0.01,
    slots: ["weapon"] // balance: lo/hi (design 0.01 / 0.02)
  },
  {
    n: 7, id: "vec", name: "Vectorized", kind: "prefix", stat: "areaDmg", lo: 0.015, hi: 0.03,
    slots: ["weapon", "hat", "sticker"] // balance: lo/hi (design 0.03 / 0.06)
  },
  {
    n: 8, id: "blame", name: "Blameless", kind: "prefix", stat: "bossDmg", lo: 0.015, hi: 0.03,
    slots: ["weapon", "sticker"] // balance: lo/hi (design 0.03 / 0.06)
  },
  {
    n: 9, id: "green", name: "of the Green Build", kind: "suffix", stat: "xp", lo: 0.005, hi: 0.01,
    slots: ["hat", "sticker"] // balance: lo/hi (design 0.01 / 0.02)
  },
  {
    n: 10, id: "cache", name: "of Caching", kind: "suffix", stat: "gold", lo: 0.015, hi: 0.03,
    slots: ["boots", "mug", "sticker"] // balance: lo/hi (design 0.03 / 0.06)
  },
  {
    n: 11, id: "tab", name: "of Tab Completion", kind: "suffix", stat: "itemFind", lo: 0.01, hi: 0.02,
    slots: ["boots", "sticker"] // balance: lo/hi (design 0.02 / 0.04)
  },
  {
    n: 12, id: "uptime", name: "of Uptime", kind: "suffix", stat: "regenPct", lo: 0.0005, hi: 0.001,
    slots: ["hoodie", "mug", "sticker"]
  },
  {
    n: 13, id: "idem", name: "of Idempotence", kind: "suffix", stat: "dmgTaken", lo: -0.01, hi: -0.02,
    slots: ["hoodie", "boots"]
  },
  {
    n: 14, id: "hot", name: "of Hot Reload", kind: "suffix", stat: "cdr", lo: 0.01, hi: 0.02,
    slots: ["hat", "mug", "sticker"] // balance: lo/hi (design 0.02 / 0.04)
  },
  {
    n: 15, id: "grace", name: "of Graceful Degradation", kind: "suffix", stat: "dmgBelowHalfHp",
    lo: 0.02, hi: 0.04, slots: ["weapon", "hoodie"] // balance: lo/hi (design 0.04 / 0.08)
  },
  {
    n: 16, id: "rate", name: "of Rate Limiting", kind: "suffix", stat: "dodge", lo: 0.005, hi: 0.01,
    slots: ["hoodie", "boots"]
  }
];

// Documentation of the affix value formula (implemented in items.js affixValue()).
export const AFFIX_VALUE = "(lo + (hi - lo) * roll / 99) * tier";

export const LTS_PROPS = [
  { n: 0, id: "tenx", name: "Ten-X Keys", slot: "weapon", effect: { everyNthAction: 10, dmgMult: 10 } },
  {
    n: 1, id: "flag", name: "Feature-Flagged", slot: "any",
    effect: { alternateEveryTicks: 60, dmg: 0.25, armorPct: 0.25 }
  },
  {
    n: 2, id: "rollback", name: "Rollback", slot: "any",
    effect: { lethalLeavesHp: 0.6, cooldownTicks: 120 }
  },
  { n: 3, id: "scroll", name: "Infinite Scroll", slot: "weapon", effect: { mainHitsNext: 0.5 } },
  { n: 4, id: "reload", name: "Hot-Reloading", slot: "any", effect: { noCooldownChance: 0.15 } },
  { n: 5, id: "gc", name: "Garbage-Collected", slot: "hoodie", effect: { healPerKillPct: 0.02 } },
  { n: 6, id: "semi", name: "Optional Semicolon", slot: "sticker", effect: { critRepeatChance: 0.25 } },
  {
    n: 7, id: "mug", name: "Bottomless", slot: "mug",
    effect: { freeCoffee: true, refillTicksWhileQuesting: 10 }
  },
  { n: 8, id: "pockets", name: "Infinite-Pocket", slot: "hoodie", effect: { itemFind: 0.2 } },
  { n: 9, id: "stamp", name: "Rubber-Stamped", slot: "sticker", effect: { unblockedExtraTicks: 60 } }
];

export const KEEPSAKES = [
  {
    n: 0, id: "hazard_cone_hat", name: "Hazard Cone Hat", boss: 0, slot: "hat",
    effect: { crit: 0.05, xp: 0.05 }
  },
  {
    n: 1, id: "curly_brace_crown", name: "Curly Brace Crown", boss: 1, slot: "hat",
    effect: { rankBonus: { main: 1, area: 1 } }
  },
  {
    n: 2, id: "lazy_quantifier_boots", name: "Lazy Quantifier Boots", boss: 2, slot: "boots",
    effect: { cdr: 0.12 }
  },
  { n: 3, id: "octo_hoodie", name: "Octo-Hoodie", boss: 3, slot: "hoodie", effect: { areaTargets: 1 } },
  {
    n: 4, id: "lockfile_mug", name: "Lockfile Mug", boss: 4, slot: "mug",
    effect: { hpPct: 0.15, coffeeHeal: 0.1 }
  },
  {
    n: 5, id: "mutex_twinfang", name: "Mutex Twinfang", boss: 5, slot: "weapon", classAdaptive: true,
    effect: { bossDmg: 0.25 }
  },
  {
    n: 6, id: "microservice_badge", name: "Microservice Badge", boss: 6, slot: "sticker",
    effect: { dmgPerRoomAlly: 0.04, cap: 0.16 }
  },
  {
    n: 7, id: "weekend_pass", name: "Weekend Pass", boss: 7, slot: "sticker",
    effect: { freshEyesAccrual: 0.5, dmgWhileFreshEyes: 0.1 }
  },
  {
    n: 8, id: "uncertainty_lens", name: "Uncertainty Lens", boss: 8, slot: "hat",
    effect: { doubleCountChance: 0.12 }
  }
];

// ---------------------------------------------------------------------------------------------
// D§14.7 Item bases (the flat id list is derived below as BASE_LIST / ITEM_BASES.list)
// ---------------------------------------------------------------------------------------------

export const ITEM_BASES = {
  slotK: { weapon: 0, hat: 1, hoodie: 2, mug: 0.8, boots: 0.7, sticker: 0 },
  starter: { n: 0, slot: "weapon", type: "stick", name: "Training Stick", anyClass: true },
  weapons: {
    blade: [
      "Rusty Rename Blade", "Extract Saber", "Inline Claymore", "Abstraction Greatsword",
      "The Clean Slate"
    ],
    knives: [
      "Patch Shiv", "Monkey-Patch Knife", "Hotfix Kris", "Twin Diff Daggers", "The Midnight Patch"
    ],
    pipe: ["Pipe Wand", "Here-Doc Staff", "Subshell Scepter", "Daemon Rod", "Staff of Pure Functions"],
    manpage: [
      "Scratchpad Tome", "Manpage Grimoire", "Shell Codex", "Kernel Folio", "The Init Scripture"
    ],
    duck: ["Squeaky Duck", "Bathtub Duck", "Duck of Insight", "Brass Oracle Duck", "The Duck Who Knew"]
  },
  armor: {
    hat: ["Beanie", "Headphones", "Thinking Cap", "Noise-Dampening Helm", "Crown of Inbox Zero"],
    hoodie: ["Swag Tee", "Zip Hoodie", "Fleece Vest", "Hackathon Jacket", "Parka of Prod"],
    mug: ["Paper Cup", "Chipped Mug", "Travel Thermos", "Okayest Dev Mug", "Obsidian Pour-Over"],
    boots: [
      "Socks and Sandals", "Office Slippers", "Standing-Desk Sneakers", "Commute Boots",
      "Treads of Uptime"
    ],
    sticker: ["Vinyl Sticker", "Holo Sticker", "Die-Cut Sticker", "Enamel Pin", "Conference Badge"]
  },
  weaponTierTones: ["#8B6B4A", "#9AA3AD", "#5FB3A8", "#E8E8F0", "#2E2E3A"],
  hatTierShapes: ["beanie", "headphones", "cap", "helm", "crown"]
};

// ---------------------------------------------------------------------------------------------
// D§14.8 Buildings, badges, names, palette tokens
// ---------------------------------------------------------------------------------------------

export const BUILDINGS = [
  { n: 0, id: "campfire", name: "Campfire", max: 10, base: 800, perLevel: { freshEyesCapMin: 15 } },
  {
    n: 1, id: "coffee_machine", name: "Coffee Machine", max: 10, base: 800,
    perLevel: { coffeeHeal: 0.03, coffeePrice: -0.05 }
  },
  {
    n: 2, id: "ci_forge", name: "CI Forge", max: 10, base: 1200, perLevel: { polishGold: -0.04 },
    unlocks: { "3": "squashMerge", "5": "reroll" }
  },
  {
    n: 3, id: "vendor", name: "vendor/", max: 10, base: 1000, perLevel: { stashSlots: 10 },
    tooltip: "Heavier than it looks."
  },
  { n: 4, id: "docs_library", name: "Docs Library", max: 10, base: 1500, perLevel: { herdXp: 0.02 } },
  { n: 5, id: "war_room", name: "War Room", max: 5, base: 3000, perLevel: { bossTimerTicks: 6 } }
];

export const STASH = { base: 40, max: 140 };

export const BUG_TRACKER = {
  tiers: [
    { name: "Triaged", kills: 500 },
    { name: "Reproduced", kills: 5000 },
    { name: "Fixed", kills: 50000 }
  ],
  eliteWeight: 4
};

export const TROPHY = { dmg: 0.01, hpPct: 0.01 };

export const BADGES = [
  { id: "hello_world", name: "Hello, World", when: "firstKill" },
  { id: "first_commit", name: "First Commit", when: "firstChestOpened" },
  { id: "not_found", name: "404 Not Found", when: "dodges>=1000" },
  { id: "duck_whisperer", name: "Rubber Duck Whisperer", when: "healed>=10000" },
  { id: "pair_programmer", name: "Pair Programmer", when: "guildRoomMinutes>=60" },
  { id: "thundering_herd", name: "Thundering Herd", when: "concurrentWorking>=8" },
  { id: "fully_staffed", name: "Fully Staffed", when: "allClasses" },
  { id: "zero_warnings", name: "Zero Warnings", when: "boss0" },
  { id: "read_only_friday", name: "Read-Only Friday", when: "boss7OnLocalFriday" },
  { id: "works_when_i_dont_look", name: "Works When I Don't Look", when: "boss8" },
  { id: "ten_thousand_typos", name: "Ten Thousand Typos", when: "zone0Fixed" },
  { id: "principal_engineer", name: "Principal Engineer", when: "level100" },
  { id: "deep_backlog", name: "Deep Backlog", when: "backlogFloor>=25" },
  { id: "lucky_duck", name: "Lucky Duck", when: "holoDuck" }
];

export const NAMES = {
  first: [
    "Kip", "Nib", "Tess", "Juno", "Pax", "Rue", "Ori", "Zed", "Lumi", "Brin", "Coda", "Fen", "Ivo",
    "Mira", "Quill", "Sol", "Ada", "Bram", "Cleo", "Dex", "Echo", "Fable", "Gus", "Hana", "Ilo", "Jax",
    "Kaia", "Lark", "Moss", "Nell", "Otto", "Pim", "Quin", "Rook", "Sage", "Tobin", "Uma", "Vela",
    "Wren", "Xan", "Yuki", "Zara", "Alba", "Bix", "Cove", "Dot", "Elm", "Fizz", "Glen", "Hux", "Ines",
    "Jove", "Kit", "Lyle", "Mae", "Nox", "Oona", "Perl", "Rho", "Sable", "Tamsin", "Ula", "Vik", "Wynn"
  ],
  epithet: [
    "the Idempotent", "Two-Spaces", "of the Green Build", "the Rebased", "Semicolon-Sworn",
    "the Unblocked", "Off-By-One", "the Squashed", "Null-Safe", "of Many Branches", "the Linted",
    "Tab-Born", "the Cached", "Hot-Reloaded", "the Deterministic", "the Refactored", "Fast-Forward",
    "the Memoized", "of the Long Uptime", "the Pure", "Zero-Indexed", "the Patient", "of Clean Diffs",
    "the Typed", "Once-Deployed", "the Unflaky", "of Small Commits", "the Annotated", "the Lazy-Loaded",
    "Well-Documented", "the Thread-Safe", "the Sandboxed", "of the Quiet Logs", "the Backported",
    "Kernel-Kissed", "the Vectorized", "of Fewer Warnings", "the Rollbacked", "Merge-Minded",
    "the Async", "the Benchmarked", "of the Tidy Stack", "Monorepo-Raised", "the Parsed", "the Escaped",
    "of Good Defaults", "the Stateless", "the Shipped", "the Bisected", "of the Last Mile",
    "the Cherry-Picked", "the Unsquashed", "Lint-Free", "the Readable", "of Gentle Reviews",
    "the Tested", "the Composable", "of Short Feedback", "the Minimal", "the Portable",
    "of the Open Door", "the Reproducible", "the Graceful", "the Compiled"
  ]
};

export const PALETTE = {
  working: "#4CC38A", blocked: "#F2A93B", done: "#FFD447", idle: "#8A8F98", bubbleFill: "#FFFFFF",
  bubbleInk: "#1B1B1F", levelUp: "#7FE9F5", xp: "#7FE9F5", freshEyes: "#A9B8FF", hp: "#FF5A5F",
  danger: "#FF5A5F", coin: "#C89B3C", heal: "#6BE38A", cream: "#FFF4D6",
  termlingTint: ["#6C8CF5", "#F07D5C", "#45C2A8", "#C47BE8", "#E8B84A", "#5FB0E8", "#E86F9C", "#8FBF5A"],
  // hat tints (the stage's and the sheet's rig): a hat's tint follows its item uid (items.hatToneOf)
  hatTint: ["#E86F9C", "#5FB0E8", "#8FBF5A", "#E8B84A", "#C47BE8", "#F07D5C"]
};

export const CHEST_TIERS = [
  { id: "wooden", minSeals: 0, color: "#8B5E3C" },
  { id: "iron", minSeals: 1, color: "#9AA3AD" },
  { id: "silver", minSeals: 3, color: "#CFE3F2", floor: "alpha" },
  { id: "gold", minSeals: 6, color: "#FFD447", floor: "beta" }
];

// =============================================================================================
// Additions: things the design references outside §14, or leaves open
// =============================================================================================

/** Equipment slots in save order (D§13.2 `hero.eq`): Weapon, Hat, Hoodie, Mug, Boots, Sticker. */
export const SLOTS = ["weapon", "hat", "hoodie", "mug", "boots", "sticker"];

/** Skill slots in save order (D§13.2 `hero.sp`): Main, Area, Passive, Buff, Signature, Ultimate, Capstone. */
export const SKILL_SLOTS = SKILLS.slots.map((s) => s.slot);

/** Class weapon types in item-base order (D§14.7: refactorer, hotfixer, shellmancer, forkbinder, rubberducker). */
export const WEAPON_TYPES = CLASSES.slice(1).map((c) => c.weapon);

/** Item tiers: t = clamp(ceil(i / 20), 1, 5) (D§5.1). */
export const TIER_COUNT = 5;

/** The Backlog (D§9.8): the endless postgame, frontier zone index 9 in saves (D§13.2 `herd.zone`). */
export const BACKLOG = {
  n: 9, id: "backlog", name: "The Backlog",
  level: 100,                                   // mobs use level-100 formulas
  perFloor: { hp: 1.06, atk: 1.05, xp: 1.03 },  // HP x1.06^f, ATK x1.05^f, XP x1.03^f
  killsPerFloor: 50,
  bossEvery: 10,                                // boss index = ((f / 10) - 1) mod 9, at level 100
  lootIlvl: { base: 100, perFloor: 0.5 },       // item level 100 + floor(f / 2)
  noGapPenalty: true,
  versionTag: "v2",                             // "v2" tint on mobs; "The Friday Deploy v2: ..."
  badgeFloor: 25,                               // Deep Backlog badge (D§10.6)
  // design gap: §9.2 has no Backlog palette or scenery; original slate/ice values.
  palette: { sky: "#161A24", far: "#2B3245", ground: "#0F1219", accent: "#8AE3FF" },
  scenery: "Endless grey ticket stacks under a cold blue status light",
};

// design gap: sprite/flavour/size of the two adds that are not zone mobs are not in the design.
// Their stat multipliers (on mobHP/mobATK at the encounter level) come from D§14.5.
/** Boss and review adds that are not zone mobs (art ids fixed by ARCHITECTURE §3.1). */
export const ADDS = [
  { id: "warning_mite", name: "Warning Mite", size: "S", hp: 1.0, atk: 0.5, source: "ignored_warning",
    traits: [], sprite: "Tiny amber triangle on stubby legs", flavor: "Just one more. It's only a warning." },
  { id: "nitpick", name: "Nitpick", size: "S", hp: 1.0, atk: 0.5, source: "staff_review",
    traits: [], sprite: "A red-pen squiggle with two dot eyes", flavor: "Not blocking. Just one more thing." },
];

// The Holo Rubber Duck as a lane entity (D§9.7, D§14.4 holo_duck).
// design gap: its XP multiplier is not given (its reward is the Duck Chest); it uses 1.0 and no gold.
const HOLO_DUCK_MOB = {
  id: "holo_duck", name: HOLO_DUCK.name, size: "S", traits: [], hp: HOLO_DUCK.hp, atk: 0, xp: 1.0, gold: 0,
  attacks: HOLO_DUCK.attacks, leaveAfterTicks: HOLO_DUCK.leaveAfterTicks, drop: HOLO_DUCK.drop,
  sprite: "Iridescent sticker-sheen rubber duck", flavor: "Oh.",
};

/** Named parts of multi-part bosses (BossVM.parts labels). */
export const BOSS_PARTS = {
  octopus_merge: ["feat/", "fix/", "wip/", "docs/", "test/", "chore/", "hotfix/", "refactor/"], // D§9.6 look
  deadlock_hydra: ["Mutex", "Semaphore"],                                                        // D§14.5
  // design gap: the six Microservices are unnamed in the design.
  monolith: ["auth", "billing", "search", "profile", "mailer", "gateway"],
};

// design gap: D§7.1 floats skill names "in class colour" but defines only the Rubberducker's ochre
// (D§4.3). The others are original and avoid the reserved gold/cyan/red/white (D§11.1).
/** Class accent colours (skill-name floats, sheet accents). */
export const CLASS_COLORS = {
  intern: "#B8BEC8", refactorer: "#8FB8FF", hotfixer: "#FF8A5C",
  shellmancer: "#6BE3A0", forkbinder: "#C9A2FF", rubberducker: "#C08A3E",
};

// design gap (derived from the D§9.3 sprite notes): the one code glyph each mob carries, for the
// renderer's text overlay (MobVM.glyph). ASCII-first; "!" is never used (reserved for blocked).
/** Code glyph per lane entity id (null = none). */
export const MOB_GLYPHS = {
  typo_sprout: "teh", semicolon_sloth: ";", unused_import: "import", callback_bat: "cb()",
  promise_wisp: "...", null_pointer_frog: "->0", capture_group_goblins: "()", backslash_bandit: "\\",
  greedy_glob: ".*", diff_leech: "+-", rebase_wraith: "~1", merge_conflict_golem: "<<<",
  left_pad_mites: "pad", transitive_vine: "->", version_pin_porcupine: "^~", race_condition_rats: "??",
  spinlock_top: "@", starved_thread: "#42", todo_ghost: "TODO", anonymous_author: "???",
  spaghetti_mummy: "{}", flaky_test_phantom: "x?", memory_leak_slime: "+1", pager_wyvern: "bzz",
  off_by_one_twins: "n+1", bitflip_moth: "01", undefined_behavior: "UB",
  warning_mite: "w", nitpick: "nit", holo_duck: null,
};

// =============================================================================================
// Derived structures and lookups
// =============================================================================================

// Lookup tables are null-prototype objects: an id from a save, a command or a herdr label that
// names an Object.prototype member ("constructor", "toString", "__proto__") finds nothing
// instead of a builtin (herdr freezes the prototypes; the qjs fuzz phase feeds such ids).
function byId(list) {
  const o = Object.create(null);
  for (const x of list) o[x.id] = x;
  return o;
}

// Class skills in §14.2 carry unlock/max only on the slot table; copy them (and the review gate)
// onto each skill so every skill def is self-contained. Also record slot index and class id.
for (const cls of Object.keys(SKILLS.byClass)) {
  for (const sk of SKILLS.byClass[cls]) {
    const slotIdx = SKILL_SLOTS.indexOf(sk.slot);
    const slot = SKILLS.slots[slotIdx];
    sk.slotIdx = slotIdx;
    sk.cls = cls;
    if (sk.unlock == null) sk.unlock = slot.unlock;
    if (sk.max == null) sk.max = slot.max;
    if (sk.needs == null && slot.needs) sk.needs = slot.needs;
  }
}

/** Every skill by id (e.g. SKILL_BY_ID.big_rewrite). */
export const SKILL_BY_ID = Object.create(null);
for (const cls of Object.keys(SKILLS.byClass)) for (const sk of SKILLS.byClass[cls]) SKILL_BY_ID[sk.id] = sk;

// Boss and review adds get the id of the lane entity (and art) they spawn as.
const ADD_ID_BY_NAME = {
  "Warning Mite": "warning_mite", "Callback Bat": "callback_bat", "Left-Pad Mite": "left_pad_mites",
  "Pager Wyvern": "pager_wyvern", "Nitpick": "nitpick",
};
for (const b of BOSSES) for (const mech of b.mechanics) if (mech.add) mech.add.id = ADD_ID_BY_NAME[mech.add.name];
for (const r of REVIEWS) if (r.onPhase && r.onPhase.add) r.onPhase.add.id = ADD_ID_BY_NAME[r.onPhase.add.name];
// Review opponent art (ARCHITECTURE §8): the Senior Review is a greyed copy of the hero itself.
REVIEWS[0].art = null;
REVIEWS[1].art = "senior_reviewer";

// Map mid level = (lo + hi) / 2 rounded half to even. This reproduces every "home level" of D§5.9
// (1-1 [1,4] -> 2, 2-1 [12,15] -> 14, 9-2 [93,96] -> 94).
function midLevel(lo, hi) {
  const s = lo + hi;
  if (s % 2 === 0) return s / 2;
  const down = (s - 1) / 2;
  return down % 2 === 0 ? down : down + 1;
}

/** All 27 maps as a flat list; index = zone * 3 + idx (integer map id in saves). */
export const MAPS = [];
for (const z of ZONES) {
  z.maps.forEach((mp, idx) => {
    MAPS.push({
      n: MAPS.length, id: mp.id, zone: z.n, zoneId: z.id, idx, name: mp.name,
      levels: mp.levels, spawn: mp.spawn, mid: midLevel(mp.levels[0], mp.levels[1]), top: mp.levels[1],
    });
  });
}

/** Flat item-base list; index = base id in saves (D§14.7 id layout). tier 0 = the any-tier stick. */
export const BASE_LIST = [{ n: 0, slot: "weapon", type: "stick", tier: 0, name: ITEM_BASES.starter.name, cls: null, anyClass: true }];
WEAPON_TYPES.forEach((type, k) => {
  ITEM_BASES.weapons[type].forEach((name, t) => {
    BASE_LIST.push({ n: BASE_LIST.length, slot: "weapon", type, tier: t + 1, name, cls: CLASSES[k + 1].id, anyClass: false });
  });
});
for (const slot of SLOTS.slice(1)) {
  ITEM_BASES.armor[slot].forEach((name, t) => {
    BASE_LIST.push({ n: BASE_LIST.length, slot, type: slot, tier: t + 1, name, cls: null, anyClass: true });
  });
}
ITEM_BASES.list = BASE_LIST;

/** Lane entities by id: the 27 zone mobs plus the adds and the Holo Rubber Duck. */
export const MOB_BY_ID = Object.assign(byId(MOBS), byId(ADDS), { holo_duck: HOLO_DUCK_MOB });
// round 4: the old id of the Semicolon Sloth, for a stale reference (a sample, an older build's
// runtime data) only: not enumerable, never spawned, its art is the sloth's (def.id)
Object.defineProperty(MOB_BY_ID, "semicolon_snail", { value: MOB_BY_ID.semicolon_sloth, enumerable: false });
export const ADD_BY_ID = byId(ADDS);
export const ZONE_BY_ID = Object.assign(byId(ZONES), { backlog: BACKLOG });
export const MAP_BY_ID = byId(MAPS);
export const BOSS_BY_ID = byId(BOSSES);
export const REVIEW_BY_ID = byId(REVIEWS);
export const CLASS_BY_ID = byId(CLASSES);
export const RARITY_BY_ID = byId(RARITIES);
export const AFFIX_BY_ID = byId(AFFIXES);
export const LTS_BY_ID = byId(LTS_PROPS);
export const KEEPSAKE_BY_ID = byId(KEEPSAKES);
export const BUILDING_BY_ID = byId(BUILDINGS);
export const BADGE_BY_ID = byId(BADGES);
export const CHEST_TIER_BY_ID = byId(CHEST_TIERS);

/** id -> integer index helpers for the tables whose index is the save id. */
function indexOf(list) {
  const o = Object.create(null);
  list.forEach((x, i) => { o[x.id] = i; });
  return o;
}
export const CLASS_IDX = indexOf(CLASSES);
export const RARITY_IDX = indexOf(RARITIES);
export const AFFIX_IDX = indexOf(AFFIXES);
export const LTS_IDX = indexOf(LTS_PROPS);
export const KEEPSAKE_IDX = indexOf(KEEPSAKES);
export const BOSS_IDX = indexOf(BOSSES);
export const BUILDING_IDX = indexOf(BUILDINGS);
export const BADGE_IDX = indexOf(BADGES);
export const MAP_IDX = indexOf(MAPS);
