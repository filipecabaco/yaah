// Roving keyboard focus for the marks of a chart, map or graph: the whole figure is one tab stop
// (one item has tabIndex 0, the rest -1), arrows move between items, Home and End go to the ends.
// Items keep their own accessible name (aria-label), so the tooltip never gates what they say.
import { useCallback, useRef, useState, type KeyboardEvent } from "react";

/** Arrow keys along a list (down and right are next), Home and End; null for any other key. */
export function linearStep(key: string, i: number, n: number): number | null {
  const next = ({ ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: n - 1 } as Record<string, number>)[key];
  return next == null || n === 0 ? null : Math.max(0, Math.min(n - 1, next));
}

export type At = { x: number; y: number };

/**
 * Arrow keys across a plane (regions, bubbles, nodes): the nearest item that way, favouring the
 * ones straight ahead (sideways distance counts double). Stays put when nothing lies that way.
 * Home and End are the first and last item.
 */
export function spatialStep(key: string, i: number, points: At[]): number | null {
  const n = points.length;
  if (key === "Home") return n ? 0 : null;
  if (key === "End") return n ? n - 1 : null;
  const dir = ({ ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] } as Record<string, [number, number]>)[key];
  if (!dir || !points[i]) return null;
  const from = points[i];
  let best = i;
  let score = Infinity;
  points.forEach((p, j) => {
    if (j === i) return;
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const ahead = dx * dir[0] + dy * dir[1];
    if (ahead <= 0.5) return;
    const side = Math.abs(dx * dir[1] - dy * dir[0]);
    const s = ahead + 2 * side;
    if (s < score) [best, score] = [j, s];
  });
  return best;
}

/**
 * One roving group of `n` items. `step` maps a key to the next index (linear by default).
 * `props(i)` goes on each item; `focusItem(i)` moves focus from code.
 */
export function useRoving(n: number, step?: (key: string, i: number) => number | null) {
  const [focus, setFocus] = useState(0);
  const refs = useRef<(HTMLElement | SVGElement | null)[]>([]);
  const focusItem = useCallback((j: number) => {
    setFocus(j);
    refs.current[j]?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const next = step ? step(e.key, i) : linearStep(e.key, i, n);
    if (next == null) return;
    e.preventDefault();
    focusItem(next);
  };
  const props = (i: number) => ({
    ref: (el: HTMLElement | SVGElement | null) => {
      refs.current[i] = el;
    },
    tabIndex: i === Math.min(focus, n - 1) ? 0 : -1,
    onKeyDown: (e: KeyboardEvent) => onKeyDown(e, i),
  });
  return { focus, setFocus, focusItem, props };
}
