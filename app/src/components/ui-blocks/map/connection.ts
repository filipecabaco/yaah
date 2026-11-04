// The connection kind's geometry, pure: each link is the great circle between its hubs
// (d3-geo's geoInterpolate), sampled and projected point by point, so it bends the right way in
// every projection, including the US atlas's pre-projected Albers, and splits where it leaves the
// map or wraps round the antimeridian. Its width follows its value; an arrowhead marks direction.
import { geoInterpolate } from "d3-geo";
import { scaleLinear } from "d3-scale";
import type { Link } from "@/components/ui-blocks/map/model";

export type XY = [number, number];
/** Stroke widths of a link, in px: thin enough to cross, thick enough to compare. */
export const LINK_WIDTH: [number, number] = [1.5, 8];
/** A link with no value, or with `width: "fixed"`. */
export const FIXED_WIDTH = 2;
/** Above this many links, only hubs are labelled. */
export const LINK_LABELS_MAX = 40;

/**
 * The great circle from `a` to `b` as pixel runs: `steps` points along it, projected, broken
 * where a point doesn't project (outside Albers USA, behind a clipped globe) or where two
 * neighbours jump further than `jump` px (the arc wrapped round the map's edge).
 */
export function arcRuns(point: (lon: number, lat: number) => XY | null, a: XY, b: XY, jump: number, steps = 64): XY[][] {
  const along = geoInterpolate(a, b);
  const runs: XY[][] = [];
  let run: XY[] = [];
  for (let i = 0; i <= steps; i++) {
    const [lon, lat] = along(i / steps);
    const p = point(lon, lat);
    const prev = run[run.length - 1];
    if (!p || (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) > jump)) {
      if (run.length > 1) runs.push(run);
      run = p ? [p] : [];
      continue;
    }
    run.push(p);
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/** The point halfway along the great circle, projected (where a link's tooltip goes). */
export function arcMidpoint(point: (lon: number, lat: number) => XY | null, a: XY, b: XY): XY | null {
  const [lon, lat] = geoInterpolate(a, b)(0.5);
  return point(lon, lat);
}

/** Cut `trim` px off the end of the last run (so an arrow's tip meets the hub's edge, not its centre). */
export function trimEnd(runs: XY[][], trim: number): XY[][] {
  if (!runs.length || trim <= 0) return runs;
  const last = [...runs[runs.length - 1]];
  let left = trim;
  while (last.length > 1) {
    const [x1, y1] = last[last.length - 1];
    const [x0, y0] = last[last.length - 2];
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (d > left) {
      const t = (d - left) / d;
      last[last.length - 1] = [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
      break;
    }
    left -= d;
    last.pop();
  }
  return [...runs.slice(0, -1), last];
}

export const runsToPath = (runs: XY[][]) => runs.map((r) => `M${r.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}`).join("");

/**
 * An arrowhead at the end of the last run: a triangle whose tip is the run's end, pointing along
 * its last step, sized with the stroke so a thick link keeps a visible head.
 */
export function arrowHead(runs: XY[][], width: number): string | null {
  const last = runs[runs.length - 1];
  if (!last || last.length < 2) return null;
  const [tx, ty] = last[last.length - 1];
  const [px, py] = last[last.length - 2];
  const d = Math.hypot(tx - px, ty - py) || 1;
  const [ux, uy] = [(tx - px) / d, (ty - py) / d];
  const len = 5 + width * 1.6;
  const half = 3 + width * 1.1;
  const bx = tx - ux * len;
  const by = ty - uy * len;
  const pts: XY[] = [
    [tx, ty],
    [bx - uy * half, by + ux * half],
    [bx + uy * half, by - ux * half],
  ];
  return `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}Z`;
}

/** Whether links are drawn by value: as asked, else when any link has one. */
export const byValue = (width: "value" | "fixed" | undefined, links: Link[]) => (width ? width === "value" : links.some((l) => l.value != null));

/** A link's stroke width from its value over [0, max] (linear, so twice the value is twice as thick). */
export function linkWidth(max: number): (v: number | undefined) => number {
  const s = scaleLinear()
    .domain([0, max > 0 ? max : 1])
    .range(LINK_WIDTH)
    .clamp(true);
  return (v) => (v == null ? FIXED_WIDTH : s(v));
}

/** Links in draw order: thickest first, so thin ones stay on top and hoverable. */
export const linkOrder = (links: Link[]) =>
  links
    .map((l, i) => [l.value ?? 0, i] as const)
    .sort(([a, i], [b, j]) => b - a || i - j)
    .map(([, i]) => i);

/** Each hub's total link value (or link count when no link has a value): its weight for labelling. */
export function hubWeights(hubs: { id: string }[], links: Link[]): Map<string, number> {
  const w = new Map(hubs.map((h) => [h.id, 0]));
  const valued = links.some((l) => l.value != null);
  for (const l of links) {
    const v = valued ? (l.value ?? 0) : 1;
    w.set(l.from, (w.get(l.from) ?? 0) + v);
    w.set(l.to, (w.get(l.to) ?? 0) + v);
  }
  return w;
}
