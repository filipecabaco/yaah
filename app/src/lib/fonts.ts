// Interface and code fonts and sizes (Settings → Appearance → Fonts).
//
// Applied in one place: four CSS variables on the root, which index.css turns into
// Tailwind's `font-sans` / `font-mono`, the root font size and `text-code`, so every
// component follows. Rust builds every value (settings.rs `fonts_for_ui`, a family
// quoted by fonts.rs); `null` removes the variable and index.css's default (today's
// look) shows. Terminals read the same variables (components/terminal/theme.ts).
import { useSyncExternalStore } from "react";
import { api, FONT_VARS, type FontSettings, type FontVar } from "@/lib/api";

/** Where the last applied fonts are kept for public/theme-boot.js, which applies them before the app loads. */
export const FONT_CACHE = "yaah:fonts";

/** What Rust produces, and nothing else: a quoted family then a plain fallback stack, or a number. */
const SAFE: Record<FontVar, RegExp> = {
  "--font-ui": /^"[^"\\]+"(, ("[A-Za-z0-9 -]+"|[A-Za-z0-9-]+))+$/,
  "--font-code": /^"[^"\\]+"(, ("[A-Za-z0-9 -]+"|[A-Za-z0-9-]+))+$/,
  "--font-ui-scale": /^\d{1,2}(\.\d{1,4})?$/,
  "--font-code-scale": /^\d{1,2}(\.\d{1,4})?$/,
};

export function safeFontValue(name: FontVar, value: string): boolean {
  return SAFE[name].test(value);
}

/** Set (or clear) the font variables on the root, and keep them for the next start. */
export function applyFonts(css: FontSettings["css"] | null | undefined) {
  const root = document.documentElement;
  const kept: Partial<Record<FontVar, string>> = {};
  for (const name of FONT_VARS) {
    const value = css?.[name];
    if (value && safeFontValue(name, value)) {
      root.style.setProperty(name, value);
      kept[name] = value;
    } else root.style.removeProperty(name);
  }
  try {
    if (Object.keys(kept).length) localStorage.setItem(FONT_CACHE, JSON.stringify(kept));
    else localStorage.removeItem(FONT_CACHE);
  } catch {
    // Storage full or off: the next start shows the default fonts until the settings arrive.
  }
}

const SAVED = "yaah:fonts-saved";

/** Fonts Rust just saved: apply them, and tell an open Settings → Fonts (it shows the new sizes). */
export function fontsSaved(saved: FontSettings) {
  applyFonts(saved.css);
  window.dispatchEvent(new CustomEvent<FontSettings>(SAVED, { detail: saved }));
}

export function onFontsSaved(cb: (saved: FontSettings) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<FontSettings>).detail);
  window.addEventListener(SAVED, listener);
  return () => window.removeEventListener(SAVED, listener);
}

// Held keys repeat fast; each step reads what the one before saved.
let stepping: Promise<unknown> = Promise.resolve();

/** ⌘= / ⌘- / ⌘0: everything a size bigger, smaller, or the default size (settings.rs `step_font_size`). */
export function stepFontSize(step: -1 | 0 | 1): Promise<void> {
  const next = stepping.then(() => api.stepFontSize(step)).then(fontsSaved);
  stepping = next.catch((e: unknown) => console.error("could not change the size", e));
  return next;
}

/** The family's name as CSS, for previewing it in a list (quoted; names are plain, fonts.rs). */
export function previewFamily(name: string): string {
  return `"${name.replace(/["\\]/g, "")}", var(--font-ui)`;
}

/** The code size over its default (1 at 12px), as the root says now: index.css derives it from the interface size unless code has its own. */
export function codeScale(): number {
  const s = getComputedStyle(document.documentElement);
  for (const name of ["--font-code-scale", "--font-ui-scale"]) {
    const n = Number.parseFloat(s.getPropertyValue(name));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!observer) {
    observer = new MutationObserver(() => listeners.forEach((l) => l()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size) {
      observer?.disconnect();
      observer = null;
    }
  };
}

/** `codeScale()`, re-rendering when Settings → Fonts changes it (for layouts that count rows in px). */
export function useCodeScale(): number {
  return useSyncExternalStore(subscribe, codeScale);
}
