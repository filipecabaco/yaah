// The accessibility floors on every built-in theme (docs/research/accessibility-personas.md):
// yaah's own light and dark (index.css) and each bundled VS Code theme (themes.json through
// theme-map.ts), measured on the surfaces each token is actually drawn on.
//   TH-1  muted text ≥ 4.5:1 on the page, cards, popovers, `bg-muted`, the reply bubble (`bg-muted/50`) the sidebar and dark controls (`bg-input/30`)
//   TH-2  destructive ≥ 4.5:1 on the page and on its own 10% and 20% tints (the "failed" badge)
//   FO-1  the focus ring ≥ 3:1 on the page, cards, popovers and the sidebar
//   FO-2  form-control borders (`--input`) ≥ 3:1 on the page, cards and popovers, in light themes
import { describe, expect, it } from "vitest";
import bundled from "@/lib/themes.json";
import { contrast, DESTRUCTIVE_TINTS, FLOORS, parse, toTokens, type Palette } from "@/lib/theme-map";
import { cssColor, declarations, over, readIndexCss, type Rgb } from "@/test/css-tokens";

type Rgba = [number, number, number, number];
type Theme = { id: string; dark: boolean; token: (name: string) => Rgba };

const css = await readIndexCss();
const light = declarations(css, ":root");
const dark = { ...light, ...declarations(css, ".dark") };
const fromCss = (tokens: Record<string, string>) => (name: string) => cssColor(tokens[name]);
const fromPalette = (p: Palette) => {
  const t = toTokens(p);
  return (name: string) => parse(t[name]) ?? [0, 0, 0, 1];
};

const THEMES: Theme[] = [
  { id: "yaah light", dark: false, token: fromCss(light) },
  { id: "yaah dark", dark: true, token: fromCss(dark) },
  ...(bundled as { id: string; dark: boolean; palette: Palette }[]).map((t) => ({ id: t.id, dark: t.dark, token: fromPalette(t.palette) })),
];

/** The opaque surfaces of a theme (cards and popovers may be translucent over the page in principle). */
function surfaces(t: Theme) {
  const bg = over(t.token("background"), [255, 255, 255]);
  const muted = over(t.token("muted"), bg);
  const sidebar = over(t.token("sidebar"), bg);
  return {
    background: bg,
    card: over(t.token("card"), bg),
    popover: over(t.token("popover"), bg),
    muted,
    bubble: over(t.token("muted"), bg, 0.5),
    sidebar,
    "sidebar-accent": over(t.token("sidebar-accent"), sidebar),
    // Dark controls are filled with `bg-input/30` (outline buttons, fields, the sidebar's search); light ones are see-through.
    field: t.dark ? over(t.token("input"), bg, 0.3) : bg,
    "sidebar-field": t.dark ? over(t.token("input"), sidebar, 0.3) : sidebar,
  };
}

type Surface = keyof ReturnType<typeof surfaces>;

/** The lowest contrast of token `name` over each of `on`, and where it is. */
function worst(t: Theme, name: string, on: Surface[]): { ratio: number; on: string } {
  const s = surfaces(t);
  return on.map((k) => ({ ratio: contrast(over(t.token(name), s[k]), s[k]), on: k })).reduce((a, b) => (b.ratio < a.ratio ? b : a));
}

/** Destructive text on its own tints over the page and cards. */
function destructiveOnTint(t: Theme): { ratio: number; on: string } {
  const s = surfaces(t);
  const fg = (base: Rgb) => over(t.token("destructive"), base);
  return (["background", "card"] as const)
    .flatMap((k) =>
      DESTRUCTIVE_TINTS.map((a) => ({ ratio: contrast(fg(s[k]), over(t.token("destructive"), s[k], a)), on: `${k} + ${a * 100}% tint` })),
    )
    .reduce((a, b) => (b.ratio < a.ratio ? b : a));
}

const failures = (check: (t: Theme) => { ratio: number; on: string } | null, min: number) =>
  THEMES.flatMap((t) => {
    const r = check(t);
    return r && r.ratio < min ? [`${t.id}: ${r.ratio.toFixed(2)} on ${r.on}`] : [];
  });

describe("every built-in theme clears the accessibility floors", () => {
  it("sweeps yaah's own two and all bundled VS Code themes", () => {
    expect(THEMES.length).toBeGreaterThan(60);
    expect(THEMES.filter((t) => !t.dark).length).toBeGreaterThan(10);
  });

  it("TH-1: muted text is at least 4.5:1 on the page, cards, popovers, bg-muted, the reply bubble and the sidebar", () => {
    const on: Surface[] = ["background", "card", "popover", "muted", "bubble", "sidebar", "sidebar-accent", "field", "sidebar-field"];
    expect(failures((t) => worst(t, "muted-foreground", on), FLOORS.mutedText)).toEqual([]);
  });

  it("TH-1: muted text stays quieter than body text wherever the body text clears the floor itself", () => {
    const on: Surface[] = ["background", "muted", "bubble", "sidebar", "sidebar-accent"];
    const inverted = THEMES.filter((t) => {
      if (worst(t, "foreground", on).ratio < FLOORS.mutedText) return false;
      const bg = surfaces(t).background;
      return contrast(over(t.token("muted-foreground"), bg), bg) > contrast(over(t.token("foreground"), bg), bg) + 0.01;
    }).map((t) => t.id);
    expect(inverted).toEqual([]);
  });

  it("TH-2: destructive is at least 4.5:1 on the page and on its own 10% and 20% tints", () => {
    expect(failures((t) => worst(t, "destructive", ["background", "card", "popover"]), FLOORS.destructive)).toEqual([]);
    expect(failures(destructiveOnTint, FLOORS.destructive)).toEqual([]);
  });

  it("FO-1: the focus ring is at least 3:1 on the page, cards, popovers and the sidebar", () => {
    expect(failures((t) => worst(t, "ring", ["background", "card", "popover", "sidebar"]), FLOORS.ring)).toEqual([]);
    expect(failures((t) => worst(t, "sidebar-ring", ["sidebar"]), FLOORS.ring)).toEqual([]);
  });

  it("FO-2: form-control borders are at least 3:1 on the page, cards and popovers in light themes", () => {
    expect(failures((t) => (t.dark ? null : worst(t, "input", ["background", "card", "popover"])), FLOORS.input)).toEqual([]);
  });

  it("body text still clears 4.5:1 everywhere (the floors only ever add contrast)", () => {
    expect(failures((t) => worst(t, "foreground", ["background", "card"]), 4.5)).toEqual([]);
    // Menus, dialogs and Settings: dark themes lift the popover a step off the page.
    expect(failures((t) => worst(t, "popover-foreground", ["popover"]), 4.5)).toEqual([]);
  });
});

// Region maps and flow graphs draw land, coasts, borders and the no-data hatch in tokens mixed
// from each theme's own text and surface (index.css `.ui-map`): every theme gets them, and these
// floors hold in every theme. The mix percentages are read from index.css, so they can't drift.
describe("map tokens", () => {
  const light = declarations(css, ".ui-map,\n.ui-flow");
  const dark = { ...light, ...declarations(css, ".dark .ui-map,\n.dark .ui-flow") };
  /** `color-mix(in oklab, var(--token) p%, var(--chart-surface))` → [token, p], as a light or dark theme gets it. */
  const share = (name: string, isDark: boolean): [string, number] => {
    const rule = isDark ? dark : light;
    const m = /color-mix\(in oklab, var\(--([\w-]+)\) (\d+(?:\.\d+)?)%, var\(--chart-surface\)\)/.exec(rule[name] ?? "");
    if (!m) throw new Error(`--${name} isn't a token/surface mix: ${rule[name]}`);
    return [m[1], Number(m[2]) / 100];
  };
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const enc = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  const toLab = ([r, g, b]: Rgb): Rgb => {
    const [R, G, B] = [r, g, b].map(lin);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const fromLab = ([L, a, b]: Rgb): Rgb => {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
  };
  /** color-mix(in oklab, fg p, surface). */
  const mixed = (fg: Rgb, surface: Rgb, p: number): Rgb => {
    const [a, b] = [toLab(fg), toLab(surface)];
    return fromLab([0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)) as Rgb);
  };
  const map = (t: Theme) => {
    const water = surfaces(t).background;
    const mix = (name: string) => {
      const [token, p] = share(name, t.dark);
      return mixed(over(t.token(token), water), water, p);
    };
    return { water, land: mix("map-land"), stroke: mix("map-stroke"), hatch: mix("map-hatch") };
  };
  const check = (f: (m: ReturnType<typeof map>) => [number, string]) => (t: Theme) => {
    const [ratio, on] = f(map(t));
    return { ratio, on };
  };

  it("draws coasts and borders at least 3:1 on both water and land", () => {
    expect(
      failures(
        check((m) => [Math.min(contrast(m.stroke, m.water), contrast(m.stroke, m.land)), "water or land"]),
        3,
      ),
    ).toEqual([]);
  });

  it("hatches missing data at least 3:1 on land", () => {
    expect(
      failures(
        check((m) => [contrast(m.hatch, m.land), "land"]),
        3,
      ),
    ).toEqual([]);
  });

  it("keeps land a visible step off the water, and quieter than the borders", () => {
    // A perceptual step (OKLab lightness), as a luminance ratio says next to nothing near black.
    expect(
      failures(
        check((m) => [Math.abs(toLab(m.land)[0] - toLab(m.water)[0]), "water (ΔL)"]),
        0.04,
      ),
    ).toEqual([]);
    expect(THEMES.filter((t) => contrast(map(t).land, map(t).water) >= contrast(map(t).stroke, map(t).water)).map((t) => t.id)).toEqual([]);
  });
});
