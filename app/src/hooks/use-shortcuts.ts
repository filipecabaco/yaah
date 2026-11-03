import { useEffect, useLayoutEffect, useRef } from "react";
import { shortcutFor, type ShortcutHit, type ShortcutId } from "@/lib/shortcuts";

type Handlers = Partial<Record<ShortcutId, (hit: ShortcutHit) => void>>;

/** Shortcuts that still work while a dialog or menu is open. */
const OVER_DIALOGS: ShortcutId[] = ["palette", "help", "settings"];

/** The handlers bound last, for keys that reach the app another way (a terminal hands them over). */
let bound: { current: Handlers } | null = null;

/** Run a shortcut as if its keys were pressed (a terminal pane passes app shortcuts on this way). */
export function runShortcut(hit: ShortcutHit) {
  bound?.current[hit.id]?.(hit);
}

/** Binds the global shortcuts. Handlers may change every render; the latest ones run. */
export function useShortcuts(handlers: Handlers) {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    bound = latest;
    const onKey = (e: KeyboardEvent) => {
      const hit = shortcutFor(e);
      if (!hit || e.isComposing) return;
      e.preventDefault(); // e.g. ⌘[ is "back" in the webview
      const overlay = document.querySelector('[role="dialog"][data-state="open"], [role="menu"]');
      if (overlay && !OVER_DIALOGS.includes(hit.id)) return;
      latest.current[hit.id]?.(hit);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (bound === latest) bound = null;
    };
  }, []);
}
