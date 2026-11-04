// VS Code colour theme → yaah's colour tokens. Pure TypeScript, so it can be
// audited outside the browser (scripts/build-themes.ts runs it over every bundled theme).
//
// Themes disagree about which keys they define: some set three workbench
// colours, some four hundred, and plenty set `focusBorder` to something
// invisible. So every token resolves as: candidate keys in order → the first
// that is actually legible → otherwise the theme's own hue, corrected until it is.
// Chart colours follow the theme too, but only through chart-palette.ts, which checks each
// set against the theme's own surface and falls back to yaah's validated palette.

import { chartPalette, chartTokens, type Candidate, type ChartPalette } from "./chart-palette.ts";

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
  /** The theme's own chart colour candidates (`rgb()`), checked when the theme is applied (chart-palette.ts). */
  chartSources?: ChartSources;
};

/** Series candidates in yaah's slot order (blue, orange, aqua, yellow, magenta), with a red for the diverging warm pole. */
export type ChartSources = { charts?: string[]; chartsRed?: string; ansi?: string[]; ansiRed?: string };

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
  // Only a full set counts: a theme that names three chart colours hasn't designed a palette.
  const set = (keys: string[]) => {
    const got = keys.map((k) => pick(c, bg, [k]));
    return got.every((x) => x != null) ? got.map((x) => toCss(x)) : undefined;
  };
  const one = (key: string) => {
    const x = pick(c, bg, [key]);
    return x ? toCss(x) : undefined;
  };
  const chartSources: ChartSources = {
    charts: set(["charts.blue", "charts.orange", "charts.green", "charts.yellow", "charts.purple"]),
    chartsRed: one("charts.red"),
    ansi: set([ansi("Blue"), ansi("Red"), ansi("Cyan"), ansi("Yellow"), ansi("Magenta")]),
    ansiRed: one(ansi("Red")),
  };
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
    chartSources,
  };
}

/** The chart colours a palette gets on its canvas (cards are the canvas): the theme's own if they pass, else yaah's. */
export function chartPaletteFor(p: Palette): ChartPalette {
  const s = p.chartSources ?? {};
  const candidates: Candidate[] = [];
  if (s.charts) candidates.push({ source: "theme charts", colors: s.charts.map(rgb), red: s.chartsRed ? rgb(s.chartsRed) : undefined });
  if (s.ansi) candidates.push({ source: "terminal ANSI", colors: s.ansi.map(rgb), red: s.ansiRed ? rgb(s.ansiRed) : undefined });
  return chartPalette(candidates, rgb(p.canvas), rgb(p.fg));
}

/** Text on a filled accent (buttons): whichever of the theme's text, white or black reads best. */
function onAccent(accent: Rgb, fg: Rgb, canvas: Rgb): Rgb {
  return [canvas, fg, WHITE, BLACK].sort((a, b) => contrast(b, accent) - contrast(a, accent))[0];
}

// ── Accessibility floors (docs/research/accessibility-personas.md: TH-1, TH-2, FO-1, FO-2) ──
// The palette keeps a theme's own picks; these floors hold for the tokens built from it, on
// every surface the token is drawn on, so a stored palette (themes.json) or a user's file
// gets them too without being remapped. index.css keeps yaah's own light and dark to the same
// floors (theme-contrast.test.ts checks both).

/** WCAG 2.x minimums per token: small text 4.5:1, focus indicators and control borders 3:1. */
export const FLOORS = { mutedText: 4.5, destructive: 4.5, ring: 3, input: 3 } as const;

/** Tints the destructive colour is drawn on (badges, buttons, failed output): its own 10% and 20%. */
export const DESTRUCTIVE_TINTS = [0.1, 0.2] as const;

/**
 * `color` pushed until it clears `min` on every one of `surfaces`: first toward `via` (muted text
 * goes toward the body text, so it doesn't outshine it where the body text itself suffices), then
 * toward white or black, whichever the surfaces aren't. `onTints` also checks it on its own tints
 * over the first surface.
 */
function clearOn(color: Rgb, surfaces: Rgb[], min: number, { onTints = [], via }: { onTints?: readonly number[]; via?: Rgb } = {}): Rgb {
  const target = luminance(surfaces[0]) < 0.5 ? WHITE : BLACK;
  const fails = (c: Rgb) => surfaces.some((s) => contrast(c, s) < min) || onTints.some((a) => contrast(c, mix(surfaces[0], c, a)) < min);
  let out = color;
  if (via) {
    for (let i = 0; i < 48 && fails(out); i++) out = mix(out, via, 0.08);
    // Rounding stalls a step or two short: land on it.
    if (fails(out)) out = via;
  }
  for (let i = 0; i < 48 && fails(out); i++) out = mix(out, target, 0.06);
  return out;
}

/** The surfaces muted text, the focus ring and the destructive colour sit on, as `toTokens` builds them. */
type TokenSurfaces = { bg: Rgb; raised: Rgb; popover: Rgb; sidebar: Rgb; sidebarAccent: Rgb };

/** Muted text, destructive, focus ring and input border, each floored on the surfaces it is drawn on. */
function flooredTokens(p: Palette, s: TokenSurfaces, colors: { fg: Rgb; border: Rgb; accent: Rgb }) {
  const { fg, border, accent } = colors;
  // The soft reply bubble is `bg-muted/50` over the page.
  const bubble = mix(s.bg, s.raised, 0.5);
  // Dark controls are filled with `bg-input/30` (outline buttons, fields, the sidebar's search), and `--input`
  // is the theme's border: a strong one (Dracula's purple) tints them enough to matter for the text on them.
  const fields = p.dark ? [mix(s.bg, border, 0.3), mix(s.sidebar, border, 0.3)] : [];
  const textSurfaces = [s.bg, s.raised, bubble, s.popover, s.sidebar, s.sidebarAccent, ...fields];
  return {
    // Body text clears the page by construction (toPalette); dark popovers sit a step lighter.
    popoverForeground: clearOn(fg, [s.popover], 4.5),
    mutedForeground: clearOn(rgb(p.muted), textSurfaces, FLOORS.mutedText, { via: fg }),
    destructive: clearOn(rgb(p.removeFg), [s.bg, s.popover, s.raised], FLOORS.destructive, { onTints: DESTRUCTIVE_TINTS }),
    ring: clearOn(accent, [s.bg, s.popover, s.sidebar], FLOORS.ring),
    // Light themes only: in dark ones `--input` also fills fields and outline buttons (`dark:bg-input/30`).
    input: p.dark ? border : clearOn(border, [s.bg, s.popover], FLOORS.input),
  };
}

/** The app's CSS variables (shadcn tokens) from a palette. */
export function toTokens(p: Palette): Record<string, string> {
  const [bg, surface, border, fg, accent] = [p.canvas, p.surface, p.border, p.fg, p.accent].map(rgb);
  const raised = mix(bg, fg, p.dark ? 0.08 : 0.05);
  const onPrimary = onAccent(accent, fg, bg);
  const popover = p.dark ? mix(bg, WHITE, 0.03) : bg;
  const sidebarAccent = mix(surface, fg, p.dark ? 0.08 : 0.06);
  const floored = flooredTokens(p, { bg, raised, popover, sidebar: surface, sidebarAccent }, { fg, border, accent });
  const tokens: Record<string, Rgb | string> = {
    background: bg,
    foreground: fg,
    card: bg,
    "card-foreground": fg,
    popover,
    "popover-foreground": floored.popoverForeground,
    primary: accent,
    "primary-foreground": onPrimary,
    secondary: raised,
    "secondary-foreground": fg,
    muted: raised,
    "muted-foreground": floored.mutedForeground,
    accent: raised,
    "accent-foreground": fg,
    destructive: floored.destructive,
    border,
    input: floored.input,
    ring: floored.ring,
    sidebar: surface,
    "sidebar-foreground": fg,
    "sidebar-primary": accent,
    "sidebar-primary-foreground": onPrimary,
    "sidebar-accent": sidebarAccent,
    "sidebar-accent-foreground": fg,
    "sidebar-border": border,
    "sidebar-ring": floored.ring,
  };
  const out = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, typeof v === "string" ? v : toCss(v)]));
  return { ...out, ...chartTokens(chartPaletteFor(p)) };
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
    // The accessibility floors (FLOORS): the reply bubble, the focus ring, destructive on its tints, input borders.
    mutedOnBubble: contrast(rgb(t["muted-foreground"]), mix(rgb(t.background), rgb(t.muted), 0.5)),
    ring: Math.min(...[t.background, t.popover, t.sidebar].map((s) => contrast(rgb(t.ring), rgb(s)))),
    destructive: contrast(rgb(t.destructive), rgb(t.background)),
    destructiveOnTint: Math.min(...DESTRUCTIVE_TINTS.map((a) => contrast(rgb(t.destructive), mix(rgb(t.background), rgb(t.destructive), a)))),
    // Dark themes keep `--input` as their border (it also fills controls there): not floored.
    input: p.dark ? Infinity : Math.min(contrast(rgb(t.input), rgb(t.background)), contrast(rgb(t.input), rgb(t.popover))),
  };
}
