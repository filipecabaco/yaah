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
/** CSS variables set on the root: at first, the ones public/theme-boot.js restored from the last run. */
const rootStyle = document.documentElement.style;
let applied: string[] = Array.from({ length: rootStyle.length }, (_, i) => rootStyle.item(i)).filter((k) => k.startsWith("--"));
/** Where the last applied theme is kept for public/theme-boot.js, which applies it before the app loads. */
export const THEME_CACHE = "yaah:theme";
export type CachedTheme = { dark: boolean; tokens: Record<string, string> };
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
  const tokens: Record<string, string> = {};
  if (palette) {
    for (const [k, v] of Object.entries(toTokens(palette))) {
      // Only ever a plain colour: a theme file can't smuggle other CSS into a variable.
      if (!SAFE_COLOR.test(v)) continue;
      root.style.setProperty(`--${k}`, v);
      applied.push(`--${k}`);
      tokens[`--${k}`] = v;
    }
  }
  // A theme's own polarity wins (a dark theme stays dark); yaah's follows the mode.
  const isDark = palette ? palette.dark : dark;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  root.dataset.theme = isDark ? "dark" : "light";
  // For the next start (not while the picker previews one).
  if (preview == null) {
    try {
      localStorage.setItem(THEME_CACHE, JSON.stringify({ dark: isDark, tokens } satisfies CachedTheme));
    } catch {
      // Storage full or off: the next start follows the OS until the settings arrive.
    }
  }
}

/** public/theme-boot.js applied a theme from the last run. */
const restored = () => document.documentElement.dataset.theme != null;

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

/**
 * Follow the OS light/dark setting. Without a theme from the last run, apply yaah's own
 * now; with one (public/theme-boot.js put it up before any script), keep it until the
 * saved settings arrive (`setThemes`/`setAppearance`), so the start never flashes another.
 */
export function followTheme() {
  if (!restored()) void apply();
  os.addEventListener("change", () => void apply());
}

/** The saved settings couldn't be read: show yaah's own colours, following the OS. */
export const settingsUnavailable = () => void apply();
