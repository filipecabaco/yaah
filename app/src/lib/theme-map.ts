// VS Code colour theme → yaah's colour tokens. Pure TypeScript, so it can be
// audited outside the browser (scripts/build-themes.ts runs it over every bundled theme).
//
// Themes disagree about which keys they define: some set three workbench
// colours, some four hundred, and plenty set `focusBorder` to something
// invisible. So every token resolves as: candidate keys in order → the first
// that is actually legible → otherwise the theme's own hue, corrected until it is.
// Chart colours are not themed: they stay the validated colour-blind-safe palette.

export type VsCodeTheme = {
  name?: string;
  displayName?: string;
  type?: string;
  // From a user's file: values are checked by `parse`, never trusted as CSS.
  colors?: Record<string, unknown>;
};

/** What a theme becomes: a few colours, then the app's CSS variables from them. */
export type Palette = {
  canvas: string;
  surface: string;
  border: string;
  fg: string;
  muted: string;
  accent: string;
  addFg: string;
  removeFg: string;
  selection: string;
  dark: boolean;
};

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`, clamped to 0–255 and alpha 0–1. Anything else is null. */
export function parse(value: unknown): Rgba | null {
  if (typeof value !== "string" || !value) return null;
  const v = value.trim();
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (fn) {
    const parts = fn[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
    const ch = (n: number) => Math.round(Math.min(255, Math.max(0, n)));
    return [ch(parts[0]), ch(parts[1]), ch(parts[2]), parts.length > 3 ? Math.min(1, Math.max(0, parts[3])) : 1];
  }
  const hex = v.replace(/^#/, "");
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const pair = (s: string) => parseInt(s.length === 1 ? s + s : s, 16);
  if (hex.length === 3 || hex.length === 4) return [pair(hex[0]), pair(hex[1]), pair(hex[2]), hex.length === 4 ? pair(hex[3]) / 255 : 1];
  if (hex.length === 6 || hex.length === 8)
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
      hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    ];
  return null;
}

/** Composites a possibly translucent colour over an opaque one. */
function flatten(top: Rgba, bottom: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(top[i] * top[3] + bottom[i] * (1 - top[3]))) as Rgb;
}

function mix(a: Rgb, b: Rgb, ratio: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] * (1 - ratio) + b[i] * ratio)) as Rgb;
}

function luminance(c: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const toCss = (c: Rgb) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
const rgb = (css: string): Rgb => css.match(/\d+/g)!.slice(0, 3).map(Number) as Rgb;

/** Pushes a colour toward white or black (whichever the background isn't) until it clears `min`. Hue survives. */
function ensure(color: Rgb, bg: Rgb, min: number): Rgb {
  const target = luminance(bg) < 0.5 ? WHITE : BLACK;
  let out = color;
  for (let i = 0; i < 24 && contrast(out, bg) < min; i++) out = mix(out, target, 0.08);
  return out;
}

/** First key that carries a visible colour, composited over `bg`. */
function pick(colors: Record<string, unknown>, bg: Rgb, keys: string[]): Rgb | null {
  for (const key of keys) {
    const p = parse(colors[key]);
    // Fully transparent is how themes say "not set".
    if (p && p[3] > 0.05) return flatten(p, bg);
  }
  return null;
}

/** First candidate that is already legible; else the first one, corrected. */
function pickLegible(colors: Record<string, unknown>, bg: Rgb, keys: string[], min: number, fallback: Rgb): Rgb {
  const candidates: Rgb[] = [];
  for (const key of keys) {
    const p = parse(colors[key]);
    if (p && p[3] > 0.05) candidates.push(flatten(p, bg));
  }
  return candidates.find((c) => contrast(c, bg) >= min) ?? ensure(candidates[0] ?? fallback, bg, min);
}

const ansi = (name: string) => `terminal.ansi${name}`;

export function toPalette(theme: VsCodeTheme): Palette {
  const c = theme.colors ?? {};
  const canvasRaw = parse(c["editor.background"]) ?? parse(c["editorPane.background"]);
  const declared = typeof theme.type === "string" ? theme.type.toLowerCase() : "";
  const fallbackBg: Rgb = declared.startsWith("light") ? [255, 255, 255] : [10, 13, 18];
  const bg: Rgb = canvasRaw ? [canvasRaw[0], canvasRaw[1], canvasRaw[2]] : fallbackBg;
  const dark = declared ? !declared.startsWith("light") && declared !== "hclight" : luminance(bg) < 0.5;

  // Body text: 4.5:1 is the line between "themed" and "unusable".
  const fg = pickLegible(c, bg, ["editor.foreground", "foreground"], 4.5, dark ? WHITE : BLACK);
  // Panels sit a hair off the canvas; themes that reuse one colour get a nudge, or the sidebar dissolves.
  const surfaceRaw = pick(c, bg, ["sideBar.background", "editorGroupHeader.tabsBackground", "panel.background", "activityBar.background"]);
  const borderRaw = pick(c, bg, ["panel.border", "editorGroup.border", "sideBar.border", "contrastBorder", "widget.border"]);
  const border = borderRaw && contrast(borderRaw, bg) >= 1.25 ? borderRaw : mix(bg, fg, dark ? 0.18 : 0.14);
  // Secondary text: legible (3:1) but quieter than body text.
  let muted = pickLegible(
    c,
    bg,
    ["descriptionForeground", "editorLineNumber.foreground", "disabledForeground", "tab.inactiveForeground"],
    3,
    mix(bg, fg, 0.6),
  );
  if (contrast(muted, fg) < 1.25) muted = ensure(mix(fg, bg, 0.4), bg, 3);
  // The sidebar carries the same text: a theme panel that can't (dark sidebar on a light theme) gives way to a derived one.
  const derived = mix(bg, dark ? WHITE : BLACK, 0.04);
  const fits = (s: Rgb) => contrast(fg, s) >= 4.5 && contrast(muted, s) >= 3;
  let surface = surfaceRaw && contrast(surfaceRaw, bg) >= 1.02 && fits(surfaceRaw) ? surfaceRaw : derived;
  // Text then clears the panel too (it sits further from the text than the canvas does, so the canvas still passes).
  const text = ensure(fg, surface, 4.5);
  muted = ensure(muted, surface, 3);
  if (contrast(text, bg) < 4.5) surface = derived;
  // The accent carries focus, selection and every "this is actionable" mark; focusBorder is often invisible, hence its rank.
  const accent = pickLegible(
    c,
    bg,
    [
      "textLink.foreground",
      "editorLink.activeForeground",
      "activityBarBadge.background",
      "progressBar.background",
      "button.background",
      "focusBorder",
      ansi("BrightBlue"),
      ansi("Blue"),
      ansi("BrightMagenta"),
      ansi("Yellow"),
    ],
    3,
    [224, 146, 46],
  );
  const addFg = pickLegible(
    c,
    bg,
    ["gitDecoration.addedResourceForeground", "charts.green", ansi("Green"), ansi("BrightGreen")],
    3,
    dark ? [74, 222, 128] : [22, 134, 58],
  );
  const removeFg = pickLegible(
    c,
    bg,
    ["gitDecoration.deletedResourceForeground", "charts.red", ansi("Red"), ansi("BrightRed")],
    3,
    dark ? [248, 113, 113] : [215, 58, 73],
  );
  const selection = pick(c, bg, ["editor.selectionBackground", "selection.background"]) ?? mix(bg, accent, 0.35);
  return {
    canvas: toCss(bg),
    surface: toCss(surface),
    border: toCss(border),
    fg: toCss(text),
    muted: toCss(muted),
    accent: toCss(accent),
    addFg: toCss(addFg),
    removeFg: toCss(removeFg),
    selection: toCss(selection),
    dark,
  };
}

/** Text on a filled accent (buttons): whichever of the theme's text, white or black reads best. */
function onAccent(accent: Rgb, fg: Rgb, canvas: Rgb): Rgb {
  return [canvas, fg, WHITE, BLACK].sort((a, b) => contrast(b, accent) - contrast(a, accent))[0];
}

/** The app's CSS variables (shadcn tokens) from a palette. */
export function toTokens(p: Palette): Record<string, string> {
  const [bg, surface, border, fg, accent] = [p.canvas, p.surface, p.border, p.fg, p.accent].map(rgb);
  const raised = mix(bg, fg, p.dark ? 0.08 : 0.05);
  const onPrimary = onAccent(accent, fg, bg);
  const tokens: Record<string, Rgb | string> = {
    background: bg,
    foreground: fg,
    card: bg,
    "card-foreground": fg,
    popover: p.dark ? mix(bg, WHITE, 0.03) : bg,
    "popover-foreground": fg,
    primary: accent,
    "primary-foreground": onPrimary,
    secondary: raised,
    "secondary-foreground": fg,
    muted: raised,
    "muted-foreground": p.muted,
    accent: raised,
    "accent-foreground": fg,
    destructive: p.removeFg,
    border,
    input: border,
    ring: accent,
    sidebar: surface,
    "sidebar-foreground": fg,
    "sidebar-primary": accent,
    "sidebar-primary-foreground": onPrimary,
    "sidebar-accent": mix(surface, fg, p.dark ? 0.08 : 0.06),
    "sidebar-accent-foreground": fg,
    "sidebar-border": border,
    "sidebar-ring": accent,
  };
  return Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, typeof v === "string" ? v : toCss(v)]));
}

/** Readability of the tokens that matter, for the audit. */
export function legibility(p: Palette) {
  const t = toTokens(p);
  return {
    text: contrast(rgb(t.foreground), rgb(t.background)),
    muted: contrast(rgb(t["muted-foreground"]), rgb(t.background)),
    mutedOnMuted: contrast(rgb(t["muted-foreground"]), rgb(t.muted)),
    accent: contrast(rgb(t.primary), rgb(t.background)),
    onPrimary: contrast(rgb(t["primary-foreground"]), rgb(t.primary)),
    sidebarText: contrast(rgb(t["sidebar-foreground"]), rgb(t.sidebar)),
    sidebarMuted: contrast(rgb(t["muted-foreground"]), rgb(t.sidebar)),
  };
}
