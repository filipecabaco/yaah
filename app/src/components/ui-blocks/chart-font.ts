// The chart's text size, from the interface font size (Settings → Fonts sets `--font-ui-scale`,
// which scales the root font size): charts re-measure their labels when it changes.
import { useSyncExternalStore } from "react";
import { chartFontPx } from "@/components/ui-blocks/chart-layout";

function rootPx(): number {
  if (typeof document === "undefined") return 16;
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

function subscribe(change: () => void) {
  // The font settings write style properties on <html>; a theme writes its class.
  const mo = new MutationObserver(change);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  return () => mo.disconnect();
}

/** Chart text size in px (see chartFontPx). */
export function useChartFont(): number {
  return chartFontPx(useSyncExternalStore(subscribe, rootPx, () => 16));
}
