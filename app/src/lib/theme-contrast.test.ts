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
