// Colours for figures, only ever theme tokens (index.css, or a VS Code theme's derived set,
// lib/chart-palette.ts), never a value an agent sent. Plus the one place a figure looks at the
// resolved colours: choosing the readable text token over a filled mark.
import { useLayoutEffect, useState, type RefObject } from "react";
import { contrast } from "@/lib/theme-map";

/** Categorical slot `i` (0-based), cycling through the theme's five. */
export const seriesColor = (i: number) => `var(--chart-${(i % 5) + 1})`;

export type Tone = "default" | "success" | "warning" | "danger";
export const TONES: readonly Tone[] = ["default", "success", "warning", "danger"];
/** Status fills: a state, never a series. Plain marks take categorical slot 1. */
export const TONE_FILL: Record<Tone, string> = {
  default: "var(--chart-1)",
  success: "var(--chart-3)",
  warning: "var(--chart-4)",
  danger: "var(--destructive)",
};
/** A tone in words, as its colour alone can't say it (WCAG 1.4.1). */
export const TONE_WORD: Record<Tone, string> = { default: "", success: "good", warning: "warning", danger: "problem" };
export const isTone = (v: unknown): v is Tone => typeof v === "string" && (TONES as readonly string[]).includes(v);

type Rgb = [number, number, number];

/** A CSS colour as sRGB, through a 1×1 canvas (so `oklch()`, `color-mix()` and named colours all resolve). */
function rgbOf(css: string, ctx: CanvasRenderingContext2D | null): Rgb | null {
  if (!ctx || !css) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return a === 0 ? null : [r, g, b];
}

function canvas(): CanvasRenderingContext2D | null {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    return c.getContext("2d", { willReadFrequently: true });
  } catch {
    return null;
  }
}

/**
 * The resolved colour of each `--token` on `ref`'s element, re-read when the theme changes (a
 * theme writes its class and style on <html>). Give it an element that stays mounted (a figure's
 * root, not an <svg> a view switch replaces). Empty until resolved, and in a DOM without canvas.
 */
export function useResolvedTokens(ref: RefObject<Element | null>, tokens: readonly string[]): Record<string, Rgb> {
  const [out, setOut] = useState<Record<string, Rgb>>({});
  const key = tokens.join(" ");
  useLayoutEffect(() => {
    const ctx = canvas();
    // Read through the ref each time: the element can be replaced while the hook lives on.
    const read = () => {
      const el = ref.current;
      if (!el?.isConnected) return;
      const style = getComputedStyle(el);
      const next: Record<string, Rgb> = {};
      for (const t of key.split(" ")) {
        const rgb = rgbOf(style.getPropertyValue(t).trim(), ctx);
        if (rgb) next[t] = rgb;
      }
      setOut((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => mo.disconnect();
  }, [ref, key]);
  return out;
}

/** The text token that reads best on `fill` (resolved), between the foreground and the background; foreground when unknown. */
export function readableOn(fill: Rgb | undefined, fg: Rgb | undefined, bg: Rgb | undefined): "var(--foreground)" | "var(--background)" {
  if (!fill || !fg || !bg) return "var(--foreground)";
  return contrast(fill, bg) > contrast(fill, fg) ? "var(--background)" : "var(--foreground)";
}

/** `var(--name)` → `--name`, for looking a token up in useResolvedTokens' result. */
export const tokenName = (cssVar: string) => cssVar.replace(/^var\((--[\w-]+)\)$/, "$1");
