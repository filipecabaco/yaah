// The app's keyboard shortcuts. macOS uses ⌘, Linux uses Ctrl. Every global
// shortcut needs that modifier, so plain typing in a field is never taken.
import type { Direction } from "@/lib/layout";

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl";
export const SHIFT = isMac ? "⇧" : "Shift";
export const ALT = isMac ? "⌥" : "Alt";
/** The second modifier of the one two-modifier shortcut: ⌃ with ⌘ on macOS, Super with Ctrl on Linux. */
export const CTRL = isMac ? "⌃" : "Super";

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
  | "balancePanes"
  | "newTerminal"
  | "toggleTerminal"
  | "focusPane"
  | "toggleSidebar"
  | "sizeUp"
  | "sizeDown"
  | "sizeReset"
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
  // Ghostty's "equalize splits" keys; matched in shortcutFor, since it takes both modifiers.
  balancePanes: { label: "Balance the panes: every pane the same size", keys: isMac ? [CTRL, MOD, "="] : [MOD, CTRL, "="] },
  newTerminal: { label: "New terminal to the right, in this pane's folder", keys: [MOD, "T"], code: "KeyT" },
  toggleTerminal: { label: "Switch between the agent and a terminal in its folder", keys: [MOD, "J"], code: "KeyJ" },
  focusPane: { label: "Move to the next pane over", keys: [MOD, ALT, "←↑↓→"] },
  toggleSidebar: { label: "Show or hide the sidebar", keys: [MOD, "B"], code: "KeyB" },
  // ⌘+ (⌘⇧=) and the keypad's + and − count too; matched in shortcutFor.
  sizeUp: { label: "Bigger: interface and code text", keys: [MOD, "="], code: "Equal" },
  sizeDown: { label: "Smaller: interface and code text", keys: [MOD, "-"], code: "Minus" },
  sizeReset: { label: "Default text size", keys: [MOD, "0"], code: "Digit0" },
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
  // ⌃⌘= (Ctrl+Super+= on Linux), Ghostty's keys for balancing splits: the one shortcut with both.
  if (e.metaKey && e.ctrlKey && !e.altKey && !e.shiftKey && (e.code ? e.code === "Equal" : e.key === "=")) return { id: "balancePanes" };
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  // ⌘⌥ + an arrow moves between panes; no other shortcut takes ⌥.
  if (e.altKey) {
    const dir = ARROWS[e.key];
    return dir && !e.shiftKey ? { id: "focusPane", dir } : null;
  }
  // Match the physical key; fall back to the character when no code is reported.
  const is = (code: string, key: string) => (e.code ? e.code === code : e.key.toLowerCase() === key);
  // ⌘= and ⌘+ (Shift on most layouts), ⌘-, ⌘0, and the keypad's.
  if (e.code === "NumpadAdd" || (e.shiftKey && is("Equal", "+"))) return { id: "sizeUp" };
  if (e.code === "NumpadSubtract") return e.shiftKey ? null : { id: "sizeDown" };
  if (e.code === "Numpad0") return e.shiftKey ? null : { id: "sizeReset" };
  const digit = /^Digit([1-9])$/.exec(e.code) ?? (!e.code ? /^([1-9])$/.exec(e.key) : null);
  if (digit) return e.shiftKey ? null : { id: "jumpChat", n: Number(digit[1]) };
  for (const [id, s] of Object.entries(SHORTCUTS)) {
    if (s.code && is(s.code, s.keys[s.keys.length - 1].toLowerCase()) && !!s.shift === e.shiftKey) return { id: id as ShortcutId };
  }
  return null;
}

/** What a terminal leaves to the app; every other key goes to the shell. */
const IN_TERMINAL = new Set<ShortcutId>([
  "palette",
  "splitRight",
  "splitDown",
  "closePane",
  "newTerminal",
  "toggleTerminal",
  "focusPane",
  "balancePanes",
  "sizeUp",
  "sizeDown",
  "sizeReset",
]);
/** On Linux these keep plain Ctrl in a terminal too, as GNOME Terminal's zoom keys do. */
const SIZE_KEYS = new Set<ShortcutId>(["sizeUp", "sizeDown", "sizeReset"]);

/**
 * The app shortcut a keydown in a terminal is, if it's one a terminal leaves to the app.
 * On macOS that's ⌘K, ⌘D, ⌘⇧D, ⌘W, ⌘T and ⌘⌥ arrows. On Linux Ctrl+K, Ctrl+D and Ctrl+W
 * are the shell's (kill line, end of input, delete word), so there it takes Shift too
 * (Ctrl+Shift+K, D, W, T), as GNOME Terminal does; Ctrl+Alt arrows stay as they are.
 * The size keys (Ctrl+=, Ctrl+-, Ctrl+0) are GNOME Terminal's zoom keys, so they stay plain.
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
  // Ctrl+Super+= is no shell's key.
  if (e.metaKey && e.ctrlKey) {
    const hit = shortcutFor(e);
    return hit?.id === "balancePanes" ? hit : null;
  }
  if (e.ctrlKey && !e.metaKey) {
    const hit = shortcutFor(e);
    if (hit && SIZE_KEYS.has(hit.id)) return hit;
  }
  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null;
  const unshifted = { key: e.key.toLowerCase(), code: e.code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
  const hit = shortcutFor(unshifted);
  return hit && IN_TERMINAL.has(hit.id) && hit.id !== "splitDown" ? hit : null;
}
