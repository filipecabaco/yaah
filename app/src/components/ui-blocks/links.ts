// Links inside markup a library drew (Mermaid SVG, Leaflet's attribution) must
// never navigate the app's own webview: http(s) opens in the system browser,
// anything else does nothing.
import type { MouseEvent } from "react";
import { openExternal } from "@/lib/links";

/**
 * For `onClickCapture` and `onAuxClickCapture` on the element that holds the
 * library's markup. Capture, because Leaflet stops clicks on its controls from
 * bubbling.
 */
export function keepLinksOutside(e: MouseEvent) {
  const a = e.target instanceof Element ? e.target.closest("a[href], a[*|href]") : null;
  if (!a) return;
  e.preventDefault();
  openExternal(a.getAttribute("href") ?? a.getAttribute("xlink:href"));
}
