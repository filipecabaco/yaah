// The app's keyboard shortcuts. macOS uses ⌘, Linux uses Ctrl. Every global
// shortcut needs that modifier, so plain typing in a field is never taken.
import type { Direction } from "@/lib/layout";

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl";
export const SHIFT = isMac ? "⇧" : "Shift";
export const ALT = isMac ? "⌥" : "Alt";

export type ShortcutId =
  | "palette"
  | "newChat"
  | "newProject"
  | "focusComposer"
  | "stop"
  | "prevChat"
  | "nextChat"
  | "jumpChat"
  | "splitRight"
  | "splitDown"
  | "closePane"
  | "newTerminal"
  | "focusPane"
  | "toggleSidebar"
  | "help"
  | "settings";

type Shortcut = { label: string; keys: string[]; code?: string; shift?: boolean };

export const SHORTCUTS: Record<ShortcutId, Shortcut> = {
  palette: { label: "Command palette", keys: [MOD, "K"], code: "KeyK" },
  newChat: { label: "New chat in the current project", keys: [MOD, "N"], code: "KeyN" },
  newProject: { label: "New project", keys: [MOD, SHIFT, "N"], code: "KeyN", shift: true },
  focusComposer: { label: "Focus the message box", keys: [MOD, "L"], code: "KeyL" },
  stop: { label: "Stop the running turn", keys: [MOD, "."], code: "Period" },
  prevChat: { label: "Previous chat", keys: [MOD, "["], code: "BracketLeft" },
  nextChat: { label: "Next chat", keys: [MOD, "]"], code: "BracketRight" },
  jumpChat: { label: "Nth chat of the current project", keys: [MOD, "1–9"] },
  splitRight: { label: "Split the pane to the right", keys: [MOD, "D"], code: "KeyD" },
  splitDown: { label: "Split the pane downward", keys: [MOD, SHIFT, "D"], code: "KeyD", shift: true },
  closePane: { label: "Close the pane", keys: [MOD, "W"], code: "KeyW" },
  newTerminal: { label: "New terminal to the right, in this pane's folder", keys: [MOD, "T"], code: "KeyT" },
  focusPane: { label: "Move to the next pane over", keys: [MOD, ALT, "←↑↓→"] },
  toggleSidebar: { label: "Show or hide the sidebar", keys: [MOD, "B"], code: "KeyB" },
  help: { label: "Keyboard shortcuts", keys: [MOD, "/"], code: "Slash" },
  settings: { label: "Settings", keys: [MOD, ","], code: "Comma" },
};

/** Keys that work while typing a message. */
export const COMPOSER_KEYS: { label: string; keys: string[] }[] = [
  { label: "Send", keys: ["Enter"] },
  { label: "New line", keys: [SHIFT, "Enter"] },
  { label: "Slash commands (at the start)", keys: ["/"] },
  { label: "Mention a file", keys: ["@"] },
  { label: "Move in a list", keys: ["↑", "↓"] },
  { label: "Accept a suggestion (or Enter)", keys: ["Tab"] },
  { label: "Close a list, menu or dialog", keys: ["Esc"] },
];

/** `⌘⇧N` on macOS, `Ctrl+Shift+N` on Linux. */
export function formatKeys(keys: string[]): string {
  return keys.join(isMac ? "" : "+");
}

const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** A shortcut a keydown is: which one, the digit for ⌘1–9, the direction for ⌘⌥ arrows. */
export type ShortcutHit = { id: ShortcutId; n?: number; dir?: Direction };

/** Which shortcut a keydown is, if any. Only modifier combos count. */
export function shortcutFor(e: KeyboardEvent): ShortcutHit | null {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  // ⌘⌥ + an arrow moves between panes; no other shortcut takes ⌥.
  if (e.altKey) {
    const dir = ARROWS[e.key];
    return dir && !e.shiftKey ? { id: "focusPane", dir } : null;
  }
  // Match the physical key; fall back to the character when no code is reported.
  const is = (code: string, key: string) => (e.code ? e.code === code : e.key.toLowerCase() === key);
  const digit = /^Digit([1-9])$/.exec(e.code) ?? (!e.code ? /^([1-9])$/.exec(e.key) : null);
  if (digit) return e.shiftKey ? null : { id: "jumpChat", n: Number(digit[1]) };
  for (const [id, s] of Object.entries(SHORTCUTS)) {
    if (s.code && is(s.code, s.keys[s.keys.length - 1].toLowerCase()) && !!s.shift === e.shiftKey) return { id: id as ShortcutId };
  }
  return null;
}

/** What a terminal leaves to the app; every other key goes to the shell. */
const IN_TERMINAL = new Set<ShortcutId>(["palette", "splitRight", "splitDown", "closePane", "newTerminal", "focusPane"]);

/**
 * The app shortcut a keydown in a terminal is, if it's one a terminal leaves to the app.
 * On macOS that's ⌘K, ⌘D, ⌘⇧D, ⌘W, ⌘T and ⌘⌥ arrows. On Linux Ctrl+K, Ctrl+D and Ctrl+W
 * are the shell's (kill line, end of input, delete word), so there it takes Shift too
 * (Ctrl+Shift+K, D, W, T), as GNOME Terminal does; Ctrl+Alt arrows stay as they are.
 */
export function terminalShortcut(e: KeyboardEvent): ShortcutHit | null {
  if (isMac) {
    const hit = shortcutFor(e);
    return hit && IN_TERMINAL.has(hit.id) ? hit : null;
  }
  if (e.altKey) {
    const hit = shortcutFor(e);
    return hit?.id === "focusPane" ? hit : null;
  }
  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null;
  const unshifted = { key: e.key.toLowerCase(), code: e.code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
  const hit = shortcutFor(unshifted);
  return hit && IN_TERMINAL.has(hit.id) && hit.id !== "splitDown" ? hit : null;
}
