// herdr's built-in themes as `theme()` returns them, and gpui-base's `cx.theme()` shape.
// Colors are computed exactly like herdr's settings.rs `resolve()` from the preset palettes.

const PALETTES = {
  graphite: {
    background: 0x17191d, foreground: 0xd2d4d9, selection: 0x394454, cursor: null,
    status: [0xe5c07b, 0xf0705f, 0x76a8ff],
    ansi: [0x45484f, 0xdc8c95, 0xa6bd91, 0xd8be87, 0x96b2d7, 0xb5a2ce, 0x8cbdc3, 0xd2d4d9,
      0x818793, 0xf0a5ad, 0xbad5a2, 0xead2a1, 0xb0cbef, 0xcbb7e6, 0xa4d5db, 0xf0f0f2],
  },
  ink: {
    background: 0x111720, foreground: 0xcdd6e4, selection: 0x344861, cursor: null,
    status: [0xe5c07b, 0xf0705f, 0x76a8ff],
    ansi: [0x414b5a, 0xe58c9a, 0x89c5aa, 0xd9be82, 0x91b6ee, 0xb9a0e2, 0x85c4d0, 0xcdd6e4,
      0x7f91a7, 0xf5a5b2, 0xa5dec3, 0xedd39c, 0xaccbfa, 0xd0b7f4, 0xa0dce5, 0xf0f5fc],
  },
  moss: {
    background: 0x151c19, foreground: 0xcdd7ce, selection: 0x354a40, cursor: null,
    status: [0xe5c07b, 0xf0705f, 0x76a8ff],
    ansi: [0x435248, 0xdf978d, 0xa0c4a2, 0xd4bc8b, 0x99b9cd, 0xbba4c8, 0x8bbdb5, 0xcdd7ce,
      0x82968a, 0xf1afa3, 0xb8dab9, 0xe9d2a5, 0xb1d0e2, 0xd1bddc, 0xa4d6ca, 0xeff5ee],
  },
  paper: {
    background: 0xffffff, foreground: 0x25272c, selection: 0xcfdcf5, cursor: 0x25272c,
    status: [0x9a6700, 0xc93c2c, 0x2f6fe4],
    ansi: [0x25272c, 0xc62a2a, 0x1a7f37, 0x8f5d00, 0x1f62d0, 0x7a45c8, 0x0f6f74, 0x5f6068,
      0x7b7e87, 0xd1242f, 0x1f883d, 0x9a6700, 0x0969da, 0x8250df, 0x1b7c83, 0x111214],
  },
};

const hex = (c) => "#" + c.toString(16).padStart(6, "0");
function mix(a, b, t) {
  let out = 0;
  for (const s of [16, 8, 0]) {
    const x = (a >> s) & 255, y = (b >> s) & 255;
    out |= Math.round(x * (1 - t) + y * t) << s;
  }
  return out >>> 0;
}
function isLight(c) {
  const ch = (s) => ((c >> s) & 255) / 255;
  return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0) > 0.5;
}

/** herdr's resolve(): every theme token by name, as #rrggbb / #rrggbbaa. */
export function resolveTheme(name = "graphite", overrides = {}) {
  const p = PALETTES[name] ?? PALETTES.graphite;
  const bg = p.background;
  const light = isLight(bg);
  const fg = light ? 0x1b1b1e : 0xeeeeef;
  const [working, blocked, done] = p.status ?? [p.ansi[3], p.ansi[1], p.ansi[4]];
  const L = light
    ? [hex(bg), hex(mix(bg, 0, 0.035)), "#0000000c", "#00000012", "#00000017", "#00000026", mix(bg, 0xe8e8e2, 0.2), mix(bg, 0xe8e8e2, 0.6)]
    : [hex(mix(bg, 0xffffff, 0.06)), hex(mix(bg, 0xffffff, 0.09)), "#ffffff0e", "#ffffff17", "#ffffff18", "#ffffff24", mix(bg, 0, 0.16), mix(bg, 0, 0.32)];
  const [popover, raised, hover, selected, border, input, canvas, chrome] = L;
  const t = {
    background: hex(bg),
    terminal_foreground: hex(p.foreground),
    foreground: hex(fg),
    surface: hex(bg),
    canvas: hex(canvas),
    chrome: hex(chrome),
    popover, raised, hover, selected, border, input,
    muted: hex(mix(bg, fg, light ? 0.66 : 0.6)),
    dim: hex(mix(bg, fg, light ? 0.46 : 0.38)),
    accent: hex(p.ansi[4]),
    accent_foreground: hex(bg),
    solid: hex(fg),
    solid_foreground: hex(light ? 0xffffff : mix(bg, 0, 0.28)),
    ring: hex(mix(bg, fg, 0.7)),
    selection: hex(p.selection),
    cursor: hex(p.cursor ?? p.foreground),
    working: hex(working),
    blocked: hex(blocked),
    done: hex(done),
    idle: hex(mix(bg, fg, 0.38)),
    unknown: hex(mix(bg, fg, 0.38)),
  };
  p.ansi.forEach((c, i) => { t[`ansi${i}`] = hex(c); });
  return { ...t, ...overrides };
}

export const THEME_NAMES = Object.keys(PALETTES);
export const isLightTheme = (name) => isLight((PALETTES[name] ?? PALETTES.graphite).background);

/**
 * gpui-base's frozen Theme for `cx.theme()`: semantic color tokens (at top level and under
 * `colors`), spacing, radius, typography, appearance, is_dark. Derived from a herdr theme map.
 */
export function baseTheme(h) {
  const dark = !isLight(parseInt(h.background.slice(1, 7), 16));
  const colors = Object.freeze({
    background: h.background.slice(0, 7),
    foreground: h.foreground.slice(0, 7),
    surface: h.popover.slice(0, 7),
    surface_foreground: h.foreground.slice(0, 7),
    primary: h.solid.slice(0, 7),
    primary_foreground: h.solid_foreground.slice(0, 7),
    secondary: h.raised.slice(0, 7),
    secondary_foreground: h.foreground.slice(0, 7),
    muted: h.raised.slice(0, 7),
    muted_foreground: h.muted.slice(0, 7),
    accent: h.accent.slice(0, 7),
    accent_foreground: h.accent_foreground.slice(0, 7),
    destructive: h.blocked.slice(0, 7),
    destructive_foreground: h.foreground.slice(0, 7),
    border: h.dim.slice(0, 7),
    input: h.dim.slice(0, 7),
    ring: h.ring.slice(0, 7),
    selection: h.selection.slice(0, 7),
  });
  const step = (size, line_height, weight = 400) => Object.freeze({ size, line_height, weight });
  return Object.freeze({
    ...colors,
    colors,
    spacing: Object.freeze({ xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 }),
    radius: Object.freeze({ none: 0, sm: 4, md: 6, lg: 8, xl: 12, full: 9999 }),
    typography: Object.freeze({
      sans: "Geist", mono: "JetBrains Mono",
      xs: step(11, 16), sm: step(12, 18), md: step(13, 20), lg: step(15, 22), xl: step(18, 26), mono_md: step(13, 20),
    }),
    appearance: dark ? "dark" : "light",
    is_dark: dark,
  });
}
