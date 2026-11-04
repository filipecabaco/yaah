// Chart colours for a theme: the categorical series slots, the sequential ramp and the
// diverging ramp, derived from the theme and checked against its own chart surface with
// the dataviz skill's checks (a port of its scripts/validate_palette.js). Pure, so
// theme-map.ts runs it whenever a theme is applied and `pnpm themes` audits every bundled one.
//
// Where the series colours come from, first that passes:
//   1. the theme's `charts.*` colours (blue, orange, green, yellow, purple), the keys VS Code
//      itself draws charts with;
//   2. its terminal ANSI colours (blue, red, cyan, yellow, magenta), the same hue order as ours;
//   3. yaah's own validated palette (dataviz reference palette), the light or dark steps.
// Each candidate is first nudged in lightness (hue kept) until every colour clears 3:1 on the
// surface, then has to pass: chroma >= 0.10 (else it reads as gray), adjacent colour-blind
// separation >= 6 (OKLab ΔE×100 under protanopia and deuteranopia, Machado 2009; 6 to 8 is the
// skill's floor band, legal because charts always carry a legend, a table view and 2px gaps)
// and the adjacent normal-vision floor >= 15. A set that fails falls through to the next.

export type Rgb = [number, number, number];
export type Mode = "light" | "dark";

/** yaah's categorical slots, the first five of the dataviz reference palette (index.css carries the same). */
export const YAAH_SERIES: Record<Mode, string[]> = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"],
};
/** The diverging pair's warm pole (reference palette slot 8, red); the cool pole is series slot 1. */
export const YAAH_RED: Record<Mode, string> = { light: "#e34948", dark: "#e66767" };

export const SERIES_SLOTS = 5;
export const CHROMA_FLOOR = 0.1;
export const CVD_FLOOR = 6;
export const CVD_TARGET = 8;
export const NORMAL_FLOOR = 15;
export const CONTRAST_MIN = 3;

// ── colour maths ────────────────────────────────────────────────────────────

export function hex(c: string): Rgb {
  const h = c.trim().replace(/^#/, "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
export const toHex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
export const toCss = (c: Rgb) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

const s2lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lin2s = (c: number) => {
  const v = Math.max(0, Math.min(1, c));
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
};
const linear = (c: Rgb) => c.map(s2lin) as [number, number, number];

function labFromLinear([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLCH: lightness 0–1, chroma, hue in degrees. */
export function oklch(c: Rgb): [number, number, number] {
  const [L, a, b] = labFromLinear(linear(c));
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

/** Linear sRGB of an OKLCH colour, possibly out of gamut. */
function linearOf(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** An OKLCH colour in sRGB, its chroma lowered until it fits (lightness and hue kept). */
export function fromOklch(L: number, C: number, h: number): Rgb {
  const inGamut = (c: number) => linearOf(L, c, h).every((v) => v >= -0.0005 && v <= 1.0005);
  let lo = 0;
  let hi = C;
  if (!inGamut(C)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid;
      else hi = mid;
    }
  } else lo = C;
  return linearOf(L, lo, h).map(lin2s) as Rgb;
}

const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;

function simulate(c: Rgb, kind: keyof typeof MACHADO): [number, number, number] {
  const v = linear(c);
  const M = MACHADO[kind];
  return M.map((row) => Math.max(0, Math.min(1, row[0] * v[0] + row[1] * v[1] + row[2] * v[2]))) as [number, number, number];
}

/** OKLab distance ×100, as the skill measures it; `kind` simulates a colour-vision deficiency. */
export function deltaE(x: Rgb, y: Rgb, kind?: keyof typeof MACHADO): number {
  const a = labFromLinear(kind ? simulate(x, kind) : linear(x));
  const b = labFromLinear(kind ? simulate(y, kind) : linear(y));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const luminance = (c: Rgb) => {
  const [r, g, b] = linear(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const isDarkSurface = (surface: Rgb) => oklch(surface)[0] < 0.6;

/**
 * The smallest change that makes a theme colour usable as a mark, hue kept: the nearest lightness
 * (within 0.25) at which it clears `min` on the surface and, if its chroma sits just under the
 * floor (a muted theme's pale cyan), at which there is gamut room to lift it to the floor.
 * A colour that is really gray stays gray, and fails the check.
 */
export function nudge(color: Rgb, surface: Rgb, min = CONTRAST_MIN): Rgb {
  const [L, C, h] = oklch(color);
  const lift = C >= CHROMA_FLOOR * 0.75 && C < CHROMA_FLOOR;
  const good = (c: Rgb) => contrast(c, surface) >= min && (!lift || oklch(c)[1] >= CHROMA_FLOOR);
  if (good(color)) return color;
  const target = lift ? CHROMA_FLOOR + 0.004 : C;
  for (let d = 0.01; d <= 0.25; d += 0.01)
    for (const l of [L - d, L + d]) {
      if (l <= 0.05 || l >= 0.97) continue;
      const out = fromOklch(l, target, h);
      if (good(out)) return out;
    }
  return color;
}

// ── the checks ──────────────────────────────────────────────────────────────

export type Check = {
  ok: boolean;
  /** Worst adjacent colour-blind ΔE (protan or deutan). */
  cvd: number;
  /** Worst adjacent normal-vision ΔE. */
  normal: number;
  /** Lowest contrast of any colour on the surface. */
  contrast: number;
  /** Lowest OKLCH chroma. */
  chroma: number;
  /** Why it failed, in the skill's words; empty when it passes. */
  problems: string[];
  /** Passing, but in a band that needs secondary encoding (the skill's WARN). */
  warnings: string[];
};

/** The skill's categorical checks over adjacent pairs (stacks, bars, lines), or all pairs (scatter, maps). */
export function checkSeries(colors: Rgb[], surface: Rgb, pairs: "adjacent" | "all" = "adjacent"): Check {
  const list: [number, number][] =
    pairs === "all"
      ? colors.flatMap((_, i) => colors.slice(i + 1).map((__, k): [number, number] => [i, i + 1 + k]))
      : colors.slice(1).map((_, i): [number, number] => [i, i + 1]);
  const worst = (f: (i: number, j: number) => number) => (list.length ? Math.min(...list.map(([i, j]) => f(i, j))) : 99);
  const cvd = worst((i, j) => Math.min(deltaE(colors[i], colors[j], "protan"), deltaE(colors[i], colors[j], "deutan")));
  const normal = worst((i, j) => deltaE(colors[i], colors[j]));
  const low = Math.min(...colors.map((c) => contrast(c, surface)));
  const chroma = Math.min(...colors.map((c) => oklch(c)[1]));
  const problems: string[] = [];
  const warnings: string[] = [];
  if (chroma < CHROMA_FLOOR) problems.push(`chroma ${chroma.toFixed(3)} < ${CHROMA_FLOOR} (reads gray)`);
  if (cvd < CVD_FLOOR) problems.push(`colour-blind ΔE ${cvd.toFixed(1)} < ${CVD_FLOOR}`);
  else if (cvd < CVD_TARGET) warnings.push(`colour-blind ΔE ${cvd.toFixed(1)} in the ${CVD_FLOOR}–${CVD_TARGET} floor band`);
  if (normal < NORMAL_FLOOR) problems.push(`normal-vision ΔE ${normal.toFixed(1)} < ${NORMAL_FLOOR}`);
  if (low < CONTRAST_MIN) problems.push(`contrast ${low.toFixed(2)}:1 < ${CONTRAST_MIN}:1 on the surface`);
  return { ok: problems.length === 0, cvd, normal, contrast: low, chroma, problems, warnings };
}

/** Lightness only rises (or only falls) along the ramp, by at least `minStep` each step. */
export function monotone(ramp: Rgb[], minStep = 0.02): boolean {
  const Ls = ramp.map((c) => oklch(c)[0]);
  const d = Ls.slice(1).map((l, i) => l - Ls[i]);
  return d.every((x) => x >= minStep) || d.every((x) => x <= -minStep);
}

// ── deriving a theme's chart colours ────────────────────────────────────────

export type SeriesSource = "theme charts" | "terminal ANSI" | "yaah";
export type Candidate = { source: SeriesSource; colors: Rgb[]; red?: Rgb };

export type ChartPalette = {
  source: SeriesSource;
  series: Rgb[];
  check: Check;
  /** Sources tried before the one used, and why each was passed over. */
  skipped: { source: SeriesSource; problems: string[] }[];
  /** --scale-seq-100 … 700: near the surface (low values) to far from it (high values). */
  seq: Rgb[];
  /** --scale-div-neg-3 … neg-1, mid, pos-1 … pos-3: cool pole, gray midpoint, warm pole. */
  div: Rgb[];
  /** Where the diverging poles came from. */
  divSource: SeriesSource;
};

/** One-hue sequential ramp of 7 steps from `hue`: lightest near a light surface, darkest near a dark one. */
export function seqRamp(hue: Rgb, surface: Rgb): Rgb[] {
  const [, C, h] = oklch(hue);
  const Ls = oklch(surface)[0];
  const dark = isDarkSurface(surface);
  const near = dark ? Math.min(0.42, Ls + 0.12) : Math.max(0.86, Math.min(0.93, Ls - 0.05));
  const far = dark ? 0.9 : 0.32;
  return Array.from({ length: 7 }, (_, i) => fromOklch(near + ((far - near) * i) / 6, Math.max(C, 0.12), h));
}

/** Diverging ramp of 7: three steps out to each pole from a gray midpoint, equal steps per arm. */
export function divRamp(cool: Rgb, warm: Rgb, mid: Rgb, surface: Rgb): Rgb[] {
  const dark = isDarkSurface(surface);
  const Lm = oklch(mid)[0];
  const far = dark ? 0.82 : 0.36;
  const arm = (pole: Rgb) => {
    const [, C, h] = oklch(pole);
    return [1, 2, 3].map((k) => fromOklch(Lm + ((far - Lm) * k) / 3, Math.max(C, 0.12), h));
  };
  return [...arm(cool).reverse(), mid, ...arm(warm)];
}

const hueGap = (a: Rgb, b: Rgb) => {
  const d = Math.abs(oklch(a)[2] - oklch(b)[2]) % 360;
  return d > 180 ? 360 - d : d;
};

/** The two poles read as opposite (cool against warm) and stay apart for colour-blind readers. */
export function polesOk(cool: Rgb, warm: Rgb): boolean {
  return hueGap(cool, warm) >= 90 && Math.min(deltaE(cool, warm, "protan"), deltaE(cool, warm, "deutan")) >= CVD_TARGET;
}

/** A neutral midpoint one step off the surface, toward the text. */
export function midGray(surface: Rgb, fg: Rgb): Rgb {
  const mix = (r: number) => [0, 1, 2].map((i) => Math.round(surface[i] * (1 - r) + fg[i] * r)) as Rgb;
  const [L, , h] = oklch(mix(isDarkSurface(surface) ? 0.16 : 0.07));
  // Desaturated, so the middle reads as "nothing", whatever tint the theme has.
  return fromOklch(L, 0.004, h);
}

/**
 * The chart colours for a theme: the first candidate set that passes on `surface`
 * (each nudged to 3:1 first), else yaah's own, nudged. Ramps from slot 1 and the warm pole.
 */
export function chartPalette(candidates: Candidate[], surface: Rgb, fg: Rgb): ChartPalette {
  const mode: Mode = isDarkSurface(surface) ? "dark" : "light";
  const yaah: Candidate = { source: "yaah", colors: YAAH_SERIES[mode].map(hex), red: hex(YAAH_RED[mode]) };
  const skipped: ChartPalette["skipped"] = [];
  let chosen: { c: Candidate; series: Rgb[]; check: Check } | null = null;
  for (const c of [...candidates.filter((c) => c.colors.length >= SERIES_SLOTS), yaah]) {
    const series = c.colors.slice(0, SERIES_SLOTS).map((x) => nudge(x, surface));
    const check = checkSeries(series, surface);
    if (check.ok || c === yaah) {
      chosen = { c, series, check };
      break;
    }
    skipped.push({ source: c.source, problems: check.problems });
  }
  const { c, series, check } = chosen!;
  const ownWarm = c.red && nudge(c.red, surface);
  const yaahWarm = nudge(yaah.red!, surface);
  const yaahCool = nudge(yaah.colors[0], surface);
  const [cool, warm, divSource] = ownWarm && polesOk(series[0], ownWarm) ? [series[0], ownWarm, c.source] : [yaahCool, yaahWarm, "yaah" as const];
  return {
    source: c.source,
    series,
    check,
    skipped,
    seq: seqRamp(series[0], surface),
    div: divRamp(cool, warm, midGray(surface, fg), surface),
    divSource,
  };
}

export const SEQ_STEPS = [100, 200, 300, 400, 500, 600, 700];
export const DIV_STEPS = ["neg-3", "neg-2", "neg-1", "mid", "pos-1", "pos-2", "pos-3"];

/** CSS variable names (without `--`) and values for a derived chart palette. */
export function chartTokens(p: ChartPalette): Record<string, string> {
  return {
    ...Object.fromEntries(p.series.map((c, i) => [`chart-${i + 1}`, toCss(c)])),
    ...Object.fromEntries(p.seq.map((c, i) => [`scale-seq-${SEQ_STEPS[i]}`, toCss(c)])),
    ...Object.fromEntries(p.div.map((c, i) => [`scale-div-${DIV_STEPS[i]}`, toCss(c)])),
  };
}
