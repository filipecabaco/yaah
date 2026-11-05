// CLI-style keys for a docked permission prompt (components/permission-dock.tsx). Pure: what a key
// means, given where it was pressed. In the message box only a bare Enter (allow once) and Esc (deny)
// count, and only while it is empty, so typing (a message that starts with a digit) is never taken;
// digits, the arrows and the letters (A / D for a batch) need the keyboard to be on the prompt itself.
// Keys are also ignored for KEY_GRACE_MS after the waiting requests change (hooks/use-permission-keys.ts),
// so a double-tapped Enter cannot approve a request that has just arrived.
export const KEY_GRACE_MS = 400;

export type KeyIntent =
  { kind: "option"; n: number } | { kind: "allow" } | { kind: "deny" } | { kind: "all"; allow: boolean } | { kind: "move"; by: -1 | 1 };

export type KeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & { isComposing?: boolean };

export type KeyContext = {
  /** Where the key was pressed: the message box, or somewhere on the prompt. */
  where: "composer" | "prompt";
  /** The message box has no text (only read for `where: "composer"`). */
  empty: boolean;
  /** On the prompt, a button has the keyboard: Enter and Space belong to it. */
  onButton: boolean;
  /** The prompt is a batch (A, D and the arrows mean something). */
  batch: boolean;
};

export function keyIntent(e: KeyEvent, ctx: KeyContext): KeyIntent | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  const composer = ctx.where === "composer";
  if (composer && !ctx.empty) return null;
  if (!composer && /^[1-9]$/.test(e.key) && !e.shiftKey) return { kind: "option", n: Number(e.key) };
  if (e.key === "Escape") return { kind: "deny" };
  if (e.key === "Enter" && !e.shiftKey) return ctx.onButton ? null : { kind: "allow" };
  if (ctx.batch && !composer && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown"))
    return { kind: "move", by: e.key === "ArrowUp" ? -1 : 1 };
  if (ctx.batch && !composer && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === "a") return { kind: "all", allow: true };
    if (k === "d") return { kind: "all", allow: false };
  }
  return null;
}
