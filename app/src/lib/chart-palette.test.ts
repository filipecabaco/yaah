// Chart colours per theme: the dataviz checks (ported from the skill's validate_palette.js),
// the fallback order, and the ramps, over yaah's own surfaces and a sample of bundled themes.
import { describe, expect, it } from "vitest";
import dracula from "@shikijs/themes/dracula";
import githubDarkHc from "@shikijs/themes/github-dark-high-contrast";
import githubLight from "@shikijs/themes/github-light";
import githubLightHc from "@shikijs/themes/github-light-high-contrast";
import nord from "@shikijs/themes/nord";
import solarizedLight from "@shikijs/themes/solarized-light";
import tokyoNight from "@shikijs/themes/tokyo-night";
import bundled from "@/lib/themes.json";
import {
  YAAH_SERIES,
  chartPalette,
  chartTokens,
  checkSeries,
  contrast,
  deltaE,
  hex,
  monotone,
  nudge,
  oklch,
  type ChartPalette,
  type Rgb,
} from "@/lib/chart-palette";
import { chartPaletteFor, toPalette, toTokens, type VsCodeTheme } from "@/lib/theme-map";

const WHITE = hex("#ffffff");
const CARD_DARK = hex("#171717");
const BG_DARK = hex("#0a0a0a");
const INK_LIGHT = hex("#0a0a0a");
const INK_DARK = hex("#fafafa");
const rgb = (css: string) => css.match(/\d+/g)!.slice(0, 3).map(Number) as Rgb;

/** What every chart palette must be, whatever its source. */
function expectUsable(p: ChartPalette, surface: Rgb, name: string) {
  expect(p.check.ok, `${name}: ${p.check.problems.join("; ")}`).toBe(true);
  expect(p.series).toHaveLength(5);
  for (const c of p.series) expect(contrast(c, surface), name).toBeGreaterThanOrEqual(3);
  expect(monotone(p.seq), `${name}: sequential ramp`).toBe(true);
  // Each diverging arm moves away from the gray midpoint in lightness.
  expect(monotone(p.div.slice(0, 4)), `${name}: cool arm`).toBe(true);
  expect(monotone(p.div.slice(3)), `${name}: warm arm`).toBe(true);
  // The ramp's far end is further from the surface than its near end (it flips on dark).
  const away = (c: Rgb) => Math.abs(oklch(c)[0] - oklch(surface)[0]);
  expect(away(p.seq[6]), name).toBeGreaterThan(away(p.seq[0]));
  expect(away(p.div[0]), name).toBeGreaterThan(away(p.div[3]));
  expect(away(p.div[6]), name).toBeGreaterThan(away(p.div[3]));
}

describe("the checks match the skill's validator", () => {
  it("measures yaah's palette as validate_palette.js does (light on #fff, dark on #171717)", () => {
    // `node scripts/validate_palette.js … --surface "#ffffff"`: CVD 9.1, normal 19.6; dark: 8.4, 19.3.
    const light = checkSeries(YAAH_SERIES.light.map(hex), WHITE);
    expect(light.cvd).toBeCloseTo(9.1, 1);
    expect(light.normal).toBeCloseTo(19.6, 1);
    // Slots 3–5 are under 3:1 on white: the validator's relief WARN, which the table view answers.
    expect(light.contrast).toBeCloseTo(2.17, 2);
    const dark = checkSeries(YAAH_SERIES.dark.map(hex), CARD_DARK);
    expect(dark.cvd).toBeCloseTo(8.4, 1);
    expect(dark.normal).toBeCloseTo(19.3, 1);
    expect(dark.ok).toBe(true);
    expect(checkSeries(YAAH_SERIES.dark.map(hex), BG_DARK).ok).toBe(true);
  });

  it("caps all-pairs forms at three colours, as the skill says", () => {
    expect(checkSeries(YAAH_SERIES.dark.slice(0, 3).map(hex), CARD_DARK, "all").ok).toBe(true);
    expect(checkSeries(YAAH_SERIES.dark.map(hex), CARD_DARK, "all").ok).toBe(false);
  });

  it("fails grays and look-alikes", () => {
    const grays = ["#777777", "#888888", "#999999", "#aaaaaa", "#bbbbbb"].map(hex);
    expect(checkSeries(grays, CARD_DARK).problems.join()).toMatch(/chroma/);
    const twins = ["#2a78d6", "#2b79d7", "#eb6834", "#1baf7a", "#e87ba4"].map(hex);
    expect(checkSeries(twins, WHITE).problems.join()).toMatch(/normal-vision/);
    expect(deltaE(hex("#2a78d6"), hex("#2a78d6"))).toBe(0);
  });
});

describe("nudge", () => {
  it("steps lightness away from the surface until 3:1, keeping the hue", () => {
    const pale = hex("#eda100");
    const out = nudge(pale, WHITE);
    expect(contrast(out, WHITE)).toBeGreaterThanOrEqual(3);
    expect(Math.abs(oklch(out)[2] - oklch(pale)[2])).toBeLessThan(3);
    expect(oklch(out)[0]).toBeLessThan(oklch(pale)[0]);
    // On a dark surface it goes lighter instead.
    const deep = hex("#184f95");
    expect(oklch(nudge(deep, CARD_DARK))[0]).toBeGreaterThan(oklch(deep)[0]);
  });

  it("leaves a colour that already passes alone, and a real gray gray", () => {
    expect(nudge(hex("#2a78d6"), WHITE)).toEqual(hex("#2a78d6"));
    expect(oklch(nudge(hex("#808080"), CARD_DARK))[1]).toBeLessThan(0.01);
  });
});

describe("chartPalette", () => {
  it("uses yaah's own on yaah's surfaces when nothing else is offered", () => {
    expectUsable(chartPalette([], WHITE, INK_LIGHT), WHITE, "yaah light");
    expectUsable(chartPalette([], CARD_DARK, INK_DARK), CARD_DARK, "yaah dark");
    expect(chartPalette([], CARD_DARK, INK_DARK).source).toBe("yaah");
  });

  it("takes the theme's colours when they pass, and falls through in order when they don't", () => {
    const good = { source: "theme charts" as const, colors: YAAH_SERIES.dark.map(hex), red: hex("#e66767") };
    expect(chartPalette([good], CARD_DARK, INK_DARK).source).toBe("theme charts");
    const gray = { source: "theme charts" as const, colors: ["#777777", "#888888", "#999999", "#aaaaaa", "#bbbbbb"].map(hex) };
    const ansi = { source: "terminal ANSI" as const, colors: YAAH_SERIES.dark.map(hex) };
    const p = chartPalette([gray, ansi], CARD_DARK, INK_DARK);
    expect(p.source).toBe("terminal ANSI");
    expect(p.skipped.map((s) => s.source)).toEqual(["theme charts"]);
    expect(p.skipped[0].problems.join()).toMatch(/chroma/);
    expect(chartPalette([gray], CARD_DARK, INK_DARK).source).toBe("yaah");
  });

  it("takes yaah's poles when the theme's two don't read as opposite", () => {
    // A theme whose "red" is a violet: next to a blue pole, both cool.
    const purple = { source: "terminal ANSI" as const, colors: YAAH_SERIES.dark.map(hex), red: hex("#8a70e0") };
    const p = chartPalette([purple], CARD_DARK, INK_DARK);
    expect(p.source).toBe("terminal ANSI");
    expect(p.divSource).toBe("yaah");
  });

  it("emits plain colours under the token names index.css declares", () => {
    const tokens = chartTokens(chartPalette([], WHITE, INK_LIGHT));
    expect(Object.keys(tokens)).toEqual([
      ...[1, 2, 3, 4, 5].map((i) => `chart-${i}`),
      ...[100, 200, 300, 400, 500, 600, 700].map((s) => `scale-seq-${s}`),
      ...["neg-3", "neg-2", "neg-1", "mid", "pos-1", "pos-2", "pos-3"].map((s) => `scale-div-${s}`),
    ]);
    for (const v of Object.values(tokens)) expect(v).toMatch(/^rgb\(\d{1,3} \d{1,3} \d{1,3}\)$/);
  });
});

describe("themes", () => {
  // Two light, two dark, both high-contrast, and one with its own charts.* colours.
  const sample: [string, VsCodeTheme][] = [
    ["github-light", githubLight],
    ["solarized-light", solarizedLight],
    ["dracula", dracula],
    ["nord", nord],
    ["github-dark-high-contrast", githubDarkHc],
    ["github-light-high-contrast", githubLightHc],
    ["tokyo-night", tokyoNight],
  ];

  it.each(sample)("%s gets chart colours that pass on its own surface, or a fallback that does", (name, theme) => {
    const palette = toPalette(theme);
    const chart = chartPaletteFor(palette);
    expectUsable(chart, rgb(palette.canvas), name);
    // Every skipped source says why.
    for (const s of chart.skipped) expect(s.problems.length, `${name}: ${s.source}`).toBeGreaterThan(0);
    // The tokens a theme applies carry them.
    const tokens = toTokens(palette);
    expect(tokens["chart-1"]).toBe(`rgb(${chart.series[0].join(" ")})`);
    expect(tokens["scale-div-mid"]).toMatch(/^rgb\(/);
  });

  it("uses a theme's own colours where they pass (Tokyo Night's charts, Dracula's terminal)", () => {
    expect(chartPaletteFor(toPalette(tokyoNight as VsCodeTheme)).source).toBe("theme charts");
    expect(chartPaletteFor(toPalette(dracula as VsCodeTheme)).source).toBe("terminal ANSI");
    // Nord's are pastel: below the chroma floor, so they read as gray. yaah's, nudged, instead.
    const n = chartPaletteFor(toPalette(nord));
    expect(n.source).toBe("yaah");
    expect(n.skipped.map((s) => s.source)).toEqual(["theme charts", "terminal ANSI"]);
  });

  it("every bundled theme passes, from its own colours or a fallback", () => {
    expect(bundled.length).toBeGreaterThan(50);
    const sources = new Set<string>();
    for (const t of bundled) {
      const chart = chartPaletteFor(t.palette);
      expectUsable(chart, rgb(t.palette.canvas), t.id);
      sources.add(chart.source);
    }
    expect([...sources].sort()).toEqual(["terminal ANSI", "theme charts", "yaah"]);
  });

  it("a theme file can't put anything but a colour into the chart tokens", () => {
    const hostile: VsCodeTheme = {
      type: "dark",
      colors: {
        "editor.background": "#101010",
        "terminal.ansiBlue": "url(https://evil.example/x)",
        "charts.blue": "red; --x: 1",
        "charts.orange": "#ff8800",
      },
    };
    const tokens = toTokens(toPalette(hostile));
    for (const [k, v] of Object.entries(tokens)) expect(v, k).toMatch(/^rgb\(\d{1,3} \d{1,3} \d{1,3}\)$/);
    expect(chartPaletteFor(toPalette(hostile)).source).toBe("yaah");
  });
});
