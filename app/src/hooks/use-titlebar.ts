// The macOS window has no title bar of its own (tauri.conf.json: titleBarStyle
// "Overlay"): the traffic lights sit over the sidebar's top row, which leaves
// room for them. In full screen they are gone, and so is the room. Linux keeps
// its window decorations, so nothing moves there.
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** The real app on macOS (not the browser mock, not tests). */
export const overlayTitlebar = () => isTauri() && /Macintosh|Mac OS X/.test(navigator.userAgent);

/** Whether the traffic lights are showing over the sidebar's top row (macOS, not full screen). */
export function useTrafficLights(): boolean {
  const overlay = overlayTitlebar();
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!overlay) return;
    const win = getCurrentWindow();
    let stop = false;
    const check = () =>
      void win.isFullscreen().then(
        (f) => !stop && setFullscreen(f),
        () => undefined,
      );
    check();
    // Entering and leaving full screen resizes the window.
    const unlisten = win.onResized(check);
    return () => {
      stop = true;
      void unlisten.then((f) => f());
    };
  }, [overlay]);
  return overlay && !fullscreen;
}

const DRAG_ATTR = "data-tauri-drag-region";
const CLICKABLE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"]);

const clickable = (el: HTMLElement) =>
  CLICKABLE.has(el.tagName) ||
  (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") ||
  (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
  INTERACTIVE_ROLES.has(el.getAttribute("role") ?? "");

/**
 * Whether a press on `path` (innermost first) drags the window, by the rules of Tauri's own
 * drag script: `deep` anywhere inside, bare/`true` on the element itself, `false` or a control
 * in between stops it.
 */
export function inDragRegion(path: EventTarget[]): boolean {
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    const attr = node.getAttribute(DRAG_ATTR);
    if (attr === null) {
      if (clickable(node)) return false;
      continue;
    }
    if (attr === "false") return false;
    if (attr === "deep") return true;
    if (attr === "" || attr === "true") return node === path[0];
  }
  return false;
}

/**
 * Tauri starts a window drag on mousedown in a drag region by asking the native side, which
 * drags only if the event AppKit is handling when that request lands is a mouse press. With a
 * real trackpad or mouse it often isn't (a pressure or gesture event, or none), and the press
 * then does nothing. So: if the window hasn't started moving by the first move with the button
 * still down, ask again from that move, while AppKit is handling the drag. (Once a drag starts,
 * AppKit tracks the mouse itself and the page gets no more moves, so this asks at most once.)
 * Returns the uninstaller.
 */
export function installDragFallback(start: () => Promise<void> = () => getCurrentWindow().startDragging()): () => void {
  let pending = false;
  const down = (e: MouseEvent) => {
    pending = e.button === 0 && e.detail === 1 && inDragRegion(e.composedPath());
  };
  const move = (e: MouseEvent) => {
    if (!pending) return;
    pending = false;
    if ((e.buttons & 1) === 0) return;
    start().catch(() => undefined);
  };
  const up = () => {
    pending = false;
  };
  document.addEventListener("mousedown", down, true);
  document.addEventListener("mousemove", move, true);
  document.addEventListener("mouseup", up, true);
  return () => {
    document.removeEventListener("mousedown", down, true);
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("mouseup", up, true);
  };
}
