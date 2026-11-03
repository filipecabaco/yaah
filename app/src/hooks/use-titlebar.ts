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
