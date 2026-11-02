// Light/dark and colour themes.
//
// Simple by default: Appearance is System, Light or Dark, in yaah's own colours.
// On top of that, a theme for light mode and one for dark mode, from any VS Code
// colour theme: the 65 Shiki bundles (pre-mapped in themes.json by
// `pnpm themes`) or a .json the user drops in ~/.config/yaah/themes. A theme's
// colours become the app's CSS variables through theme-map.ts, which keeps
// every one readable. Chart colours are never themed.
import { api, type Appearance } from "@/lib/api";
import bundled from "@/lib/themes.json";
import { toPalette, toTokens, type Palette } from "@/lib/theme-map";

export type ThemeChoice = { light: string; dark: string };
export type ThemeEntry = { id: string; label: string; dark: boolean; palette: Palette | null; custom?: boolean };

export const YAAH: ThemeEntry[] = [
  { id: "yaah", label: "yaah", dark: false, palette: null },
  { id: "yaah", label: "yaah", dark: true, palette: null },
];
export const BUNDLED = bundled as ThemeEntry[];

const os = window.matchMedia("(prefers-color-scheme: dark)");
let appearance: Appearance = "system";
let themes: ThemeChoice = { light: "yaah", dark: "yaah" };
let preview: string | null = null;
const customPalettes = new Map<string, Palette>();
let applied: string[] = [];
/** What theme-map produces: `rgb(r g b)` with integer channels. */
const SAFE_COLOR = /^rgb\(\d{1,3} \d{1,3} \d{1,3}\)$/;

const darkMode = () => appearance === "dark" || (appearance === "system" && os.matches);

/** A custom theme's palette, read through Rust by file name. */
export async function customPalette(file: string): Promise<Palette> {
  const hit = customPalettes.get(file);
  if (hit) return hit;
  const p = toPalette(await api.readCustomTheme(file));
  customPalettes.set(file, p);
  return p;
}

async function paletteFor(id: string): Promise<Palette | null> {
  if (id.startsWith("shiki:")) return BUNDLED.find((t) => t.id === id)?.palette ?? null;
  if (id.startsWith("custom:")) return customPalette(id.slice("custom:".length)).catch(() => null);
  return null;
}

// Each apply() supersedes earlier ones still waiting on a custom theme read (hovering through the picker).
let generation = 0;

async function apply() {
  const run = ++generation;
  const dark = darkMode();
  const id = preview ?? (dark ? themes.dark : themes.light);
  const palette = await paletteFor(id);
  if (run !== generation) return;
  const root = document.documentElement;
  for (const k of applied) root.style.removeProperty(k);
  applied = [];
  if (palette) {
    for (const [k, v] of Object.entries(toTokens(palette))) {
      // Only ever a plain colour: a theme file can't smuggle other CSS into a variable.
      if (!SAFE_COLOR.test(v)) continue;
      root.style.setProperty(`--${k}`, v);
      applied.push(`--${k}`);
    }
  }
  // A theme's own polarity wins (a dark theme stays dark); yaah's follows the mode.
  const isDark = palette ? palette.dark : dark;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
}

export function setAppearance(a: Appearance) {
  appearance = a;
  void apply();
}

export function setThemes(t: ThemeChoice) {
  themes = t;
  void apply();
}

/** Show a theme while the pointer is on it in the picker; `null` goes back. */
export function previewTheme(id: string | null) {
  preview = id;
  void apply();
}

export function followTheme() {
  void apply();
  os.addEventListener("change", () => void apply());
}
