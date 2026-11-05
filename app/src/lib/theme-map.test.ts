import { describe, expect, it } from "vitest";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import solarizedLight from "@shikijs/themes/solarized-light";
import dracula from "@shikijs/themes/dracula";
import bundled from "@/lib/themes.json";
import { legibility, parse, toPalette, toTokens, type Palette, type VsCodeTheme } from "@/lib/theme-map";

// The bar every theme has to clear (the same one `pnpm themes` enforces).
const MIN = {
  text: 4.5,
  muted: 4.5,
  mutedOnMuted: 4.5,
  mutedOnBubble: 4.5,
  accent: 3,
  onPrimary: 4.5,
  sidebarText: 4.5,
  sidebarMuted: 4.5,
  ring: 3,
  destructive: 4.5,
  destructiveOnTint: 4.5,
  input: 3,
};
const SAFE = /^rgb\(\d{1,3} \d{1,3} \d{1,3}\)$/;

function expectLegible(p: Palette) {
  const l = legibility(p);
  for (const [k, min] of Object.entries(MIN)) expect(l[k as keyof typeof l], k).toBeGreaterThanOrEqual(min);
}

describe("parse", () => {
  it("reads the colour syntaxes VS Code themes use", () => {
    expect(parse("#fff")).toEqual([255, 255, 255, 1]);
    expect(parse("#00000080")).toEqual([0, 0, 0, 128 / 255]);
    expect(parse("#1e1e1e")).toEqual([30, 30, 30, 1]);
    expect(parse("rgb(10, 20, 30)")).toEqual([10, 20, 30, 1]);
    expect(parse("rgba(10 20 30 / 0.5)")).toEqual([10, 20, 30, 0.5]);
  });

  it("rejects or clamps anything that isn't a colour", () => {
    expect(parse(undefined)).toBeNull();
    expect(parse(42)).toBeNull();
    expect(parse("red")).toBeNull();
    expect(parse("#12")).toBeNull();
    expect(parse("rgb(1e999, 0, 0)")).toBeNull();
    expect(parse("rgb(100%, 0%, 0%)")).toBeNull();
    expect(parse("rgb(999, -20, 3.6)")).toEqual([255, 0, 4, 1]);
    expect(parse("rgba(0, 0, 0, 7)")).toEqual([0, 0, 0, 1]);
  });
});

describe("toPalette", () => {
  it.each([
    ["github-dark", githubDark, true],
    ["github-light", githubLight, false],
    ["solarized-light", solarizedLight, false],
    ["dracula", dracula, true],
  ])("maps %s legibly and keeps its polarity", (_, theme, dark) => {
    const p = toPalette(theme);
    expect(p.dark).toBe(dark);
    expectLegible(p);
  });

  it("every bundled theme in themes.json passes the audit", () => {
    expect(bundled.length).toBeGreaterThan(50);
    for (const t of bundled) {
      expect(t.palette, t.id).toBeTruthy();
      expectLegible(t.palette);
    }
  });

  it("an unreadable or hostile theme file still yields plain, legible colours", () => {
    const hostile: VsCodeTheme = {
      type: "dark",
      colors: {
        "editor.background": "#000",
        // Invisible text, a CSS injection attempt, and non-strings, as a dropped-in file might have.
        "editor.foreground": "#000000",
        foreground: "red; background: url(https://evil.example/x)",
        "textLink.foreground": "rgb(0,0,0); --x: 1",
        "sideBar.background": { nested: true },
        descriptionForeground: "expression(alert(1))",
      },
    };
    const p = toPalette(hostile);
    expectLegible(p);
    for (const [k, v] of Object.entries(toTokens(p))) expect(v, k).toMatch(SAFE);
  });

  it("a theme with no colours at all falls back to its declared type", () => {
    expect(toPalette({ type: "light" }).dark).toBe(false);
    expect(toPalette({}).dark).toBe(true);
    expectLegible(toPalette({ type: "light" }));
  });
});
