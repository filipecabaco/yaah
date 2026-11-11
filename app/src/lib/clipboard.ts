// Copying: one place that writes the clipboard and says so, and "copy on select" (Settings → Chat,
// on by default): text selected in a transcript or a terminal is copied as soon as the selection is made.
import { useSyncExternalStore } from "react";

const COPIED = "yaah:copied";
const KEY = "yaah.copyOnSelect";

/** Copy `text` and tell the window ("Copied" shows briefly). */
export async function copyText(text: string, what = "Copied"): Promise<void> {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  window.dispatchEvent(new CustomEvent(COPIED, { detail: what }));
}

/** Copy, logging a failure instead of throwing (menus and buttons have nowhere to show it). */
export function copyQuietly(text: string, what?: string) {
  copyText(text, what).catch((e: unknown) => console.error("Copy failed:", e));
}

/** Listen for copies (the "Copied" note). */
export function onCopied(listener: (what: string) => void): () => void {
  const on = (e: Event) => listener(String((e as CustomEvent<string>).detail));
  window.addEventListener(COPIED, on);
  return () => window.removeEventListener(COPIED, on);
}

// ── the setting ──────────────────────────────────────────────────────────────
const listeners = new Set<() => void>();
const read = () => {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
};
let enabled = read();

export const isCopyOnSelect = () => enabled;

export function setCopyOnSelect(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Not saved: it still applies until the window closes.
  }
  listeners.forEach((l) => l());
}

export function useCopyOnSelect(): boolean {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => enabled,
  );
}

// ── text selected in the page ────────────────────────────────────────────────
/** Elements whose text is copied when the user selects it (the transcript); everything else is left alone. */
export const COPY_ON_SELECT = "[data-copy-on-select]";

/**
 * Copy what the user selected once they let go of the mouse, when it lies inside a `data-copy-on-select`
 * element. Fields are never touched (their selection is editing, not reading). Returns the way to stop.
 */
export function installCopyOnSelect(): () => void {
  let last = "";
  const onUp = () => {
    // After the click has settled the selection (a plain click clears it).
    setTimeout(() => {
      if (!enabled) return;
      const s = window.getSelection();
      const text = s?.toString() ?? "";
      if (!s || s.isCollapsed || !text.trim()) {
        last = "";
        return;
      }
      const within = (n: Node | null) => (n instanceof Element ? n : n?.parentElement)?.closest(COPY_ON_SELECT) != null;
      if (!within(s.anchorNode) || !within(s.focusNode) || text === last) return;
      last = text;
      copyQuietly(text);
    });
  };
  window.addEventListener("mouseup", onUp);
  return () => window.removeEventListener("mouseup", onUp);
}
