// Sample HudVMs (ARCHITECTURE §5 hudView) for the HUD strip role (mods/down-the-stack/ui/hud.js).
// The spec game/view.js has to produce, and the fixtures for tests and previews.
// Shapes: HudVM as in ARCHITECTURE §5 plus the "VM additions" at the top of ui/hud.js
// (gold / snippets / release are display strings; sprint is null | {label, have, need}; calm).

export const scenarios = {
  /** host.view returned null: the world is still loading. */
  loading: null,
  /** A busy mid-game herd. */
  normal: {
    gold: "48.2k", snippets: "133", release: "v2.3",
    sprint: { label: "Pyramid of Doom", have: 7, need: 10 },
    working: 3, blocked: 1, shipped: 2, digestDot: true, digestTip: null, calm: false, save: null,
  },
  /** Chests opened Unreviewed since the Digest was last viewed: the dot stays lit, its tooltip says why. */
  unreviewed: {
    gold: "48.2k", snippets: "133", release: "v2.3",
    sprint: { label: "Pyramid of Doom", have: 7, need: 10 },
    working: 3, blocked: 1, shipped: 2, digestDot: true,
    digestTip: "Herd panel: 2 chests opened Unreviewed (half value, no Seals): the Digest lists them", calm: false, save: null,
  },
  /** A fresh herd: nothing yet. */
  zeros: { gold: "0", snippets: "0", release: "v0.1", sprint: null, working: 0, blocked: 0, shipped: 0, digestDot: false, digestTip: null, calm: false, save: null },
  /** Save trouble (D§13.1: never silent, even with the stage hidden): a pill before the Herd button. */
  saveTrouble: {
    gold: "48.2k", snippets: "133", release: "v2.3",
    sprint: { label: "Pyramid of Doom", have: 7, need: 10 },
    working: 3, blocked: 1, shipped: 2, digestDot: false, digestTip: null, calm: false,
    save: { title: "Save restored from backup", short: "Restored", tooltip: "The save file was damaged, so the herd was restored from its backup (save.bak).\nClick for the Herd panel." },
  },
  /** Late game, big numbers, narrow strip. */
  late: {
    gold: "1.24M", snippets: "2.1k", release: "v5.0",
    sprint: { label: "The Octopus Merge", have: 3, need: 12 },
    working: 11, blocked: 4, shipped: 0, digestDot: false, digestTip: null, calm: true, save: null,
  },
};

/** Strip width (logical px) each scenario is seen at. */
export const widths = { loading: 1170, normal: 1170, unreviewed: 1170, zeros: 1170, late: 520, saveTrouble: 640 };

/** One tick later (counts change): ids must stay stable. */
export function nextTick(vm) {
  if (!vm) return vm;
  return { ...vm, working: vm.working + 1, blocked: Math.max(0, vm.blocked - 1) };
}
