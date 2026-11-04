// A figure's box, followed as it resizes (ResizeObserver on the wrapper). Until the box has a
// width the fallback stands, so happy-dom (no layout) renders at a known, deterministic size.
import { useLayoutEffect, useRef, useState } from "react";

export type Size = { width: number; height: number };

export function useSize<T extends HTMLElement = HTMLDivElement>(fallback: Size = { width: 640, height: 0 }) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A box without a width yet (off screen, mid-move into a dialog) keeps the last real size.
    const read = (width: number, height: number) =>
      setSize((s) =>
        width > 0 && (width !== s.width || (height > 0 && height !== s.height)) ? { width, height: height > 0 ? height : s.height } : s,
      );
    read(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver(([e]) => read(e.contentRect.width, e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}
