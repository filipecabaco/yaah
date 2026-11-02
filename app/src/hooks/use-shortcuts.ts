import { useEffect, useLayoutEffect, useRef } from "react";
import { shortcutFor, type ShortcutId } from "@/lib/shortcuts";

type Handlers = Partial<Record<ShortcutId, (n?: number) => void>>;

/** Shortcuts that still work while a dialog or menu is open. */
const OVER_DIALOGS: ShortcutId[] = ["palette", "help", "settings"];

/** Binds the global shortcuts. Handlers may change every render; the latest ones run. */
export function useShortcuts(handlers: Handlers) {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = shortcutFor(e);
      if (!hit || e.isComposing) return;
      e.preventDefault(); // e.g. ⌘[ is "back" in the webview
      const overlay = document.querySelector('[role="dialog"][data-state="open"], [role="menu"]');
      if (overlay && !OVER_DIALOGS.includes(hit.id)) return;
      latest.current[hit.id]?.(hit.n);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
