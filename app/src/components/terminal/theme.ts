// A terminal's colours from the app's CSS variables, so it follows the yaah theme
// (and a VS Code theme picked in Settings) and light/dark. Engines want plain
// colours, and the app's are often `oklch(…)`: each is resolved through a canvas.
import type { TerminalTheme } from "./engine";

let probe: CanvasRenderingContext2D | null | undefined;

/** Any CSS colour as `#rrggbb` (or as it was, where there's no canvas to resolve it). */
export function toHex(css: string): string {
  const v = css.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (probe === undefined) {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      probe = c.getContext("2d", { willReadFrequently: true });
    } catch {
      probe = null;
    }
  }
  if (!probe || !v) return v;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = v;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** The theme in effect on `el` (its CSS variables cascade from the root). */
export function readTerminalTheme(el: Element = document.documentElement): TerminalTheme {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => toHex(s.getPropertyValue(name) || fallback);
  const foreground = v("--foreground", "#171717");
  return {
    background: v("--terminal-background", v("--card", "#ffffff")),
    foreground,
    cursor: foreground,
    cursorAccent: v("--card", "#ffffff"),
    selectionBackground: v("--terminal-selection", "#7f7f7f"),
    ansi: Array.from({ length: 16 }, (_, i) => v(`--terminal-ansi-${i}`, i === 0 ? "#000000" : foreground)),
  };
}

/** Calls `cb` when the app's theme changes (light/dark, a theme picked or previewed). */
export function onThemeChange(cb: () => void): () => void {
  const mo = new MutationObserver(() => cb());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  return () => mo.disconnect();
}

/** The app's monospace font (Geist Mono when it's installed). */
export const TERMINAL_FONT = '"Geist Mono", "GeistMono", ui-monospace, SFMono-Regular, Menlo, Monaco, "DejaVu Sans Mono", monospace';
