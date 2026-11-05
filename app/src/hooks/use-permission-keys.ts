// The docked permission prompt's key listener (lib/permission-keys.ts says what a key means).
import { useEffect, useRef, type RefObject } from "react";
import { KEY_GRACE_MS, keyIntent, type KeyIntent } from "@/lib/permission-keys";

/**
 * Listen for the prompt's keys in this chat: from its message box (only while empty) or from the prompt
 * itself. Runs before the message box's own handler and takes the key only when it means an answer.
 * `waiting` identifies the set of waiting requests: keys are ignored (and left to the page) for a moment
 * after it first appears or changes, so a key aimed at the last request never answers a new one.
 */
export function usePermissionKeys(root: RefObject<HTMLElement | null>, batch: boolean, handle: (intent: KeyIntent) => void, waiting = "") {
  const latest = useRef(handle);
  const since = useRef(0);
  useEffect(() => {
    since.current = Date.now();
  }, [waiting]);
  useEffect(() => {
    latest.current = handle;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const card = root.current;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const chat = card?.closest("[data-chat-root]");
      if (!card || !target || !chat?.contains(target) || e.defaultPrevented) return;
      const composer = target instanceof HTMLTextAreaElement && target.matches("textarea[data-composer]");
      if (!composer && !card.contains(target)) return;
      const intent = keyIntent(e, {
        where: composer ? "composer" : "prompt",
        empty: composer && target.value.trim() === "",
        onButton: !composer && target.closest("button, a, [role='button']") != null,
        batch,
      });
      if (!intent) return;
      e.preventDefault();
      // Swallowed, not acted on: it was meant for what was there before.
      if (Date.now() - since.current < KEY_GRACE_MS) return void e.stopPropagation();
      e.stopPropagation();
      latest.current(intent);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [root, batch]);
}
