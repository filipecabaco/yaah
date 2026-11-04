// Geometry for bar, line and area charts, kept pure so it is tested without a renderer: stacks
// (negative values below zero), bar shapes with one rounded data-end, line and area paths (d3-shape
// only computes them; React draws), and which category labels fit along an axis.
import { area, curveLinear, curveMonotoneX, line } from "d3-shape";
import { num, type Point, type Series } from "@/components/ui-blocks/chart-model";

/** Each series' extent per row, stacked by sign: positives up from 0, negatives down from 0 (d3's `stackOffsetDiverging`). */
export type Stack = { lo: number; hi: number }[][];

/** `stack[row][series]`: where each value's segment runs; unstacked, a value runs from 0 to itself. */
export function stackRows(data: Point[], series: Series[], stacked: boolean): Stack {
  return data.map((r) => {
    let up = 0;
    let down = 0;
    return series.map((s) => {
      const v = num(r[s.key]);
      if (!stacked) return v < 0 ? { lo: v, hi: 0 } : { lo: 0, hi: v };
      if (v < 0) {
        const seg = { lo: down + v, hi: down };
        down += v;
        return seg;
      }
      const seg = { lo: up, hi: up + v };
      up += v;
      return seg;
    });
  });
}

/** For each row, the series whose segment ends the stack on the positive side and on the negative side (their data-ends are the rounded ones). */
export function stackEnds(data: Point[], series: Series[]): { up: number; down: number }[] {
  return data.map((r) => {
    let up = -1;
    let down = -1;
    series.forEach((s, i) => {
      const v = r[s.key];
      if (typeof v !== "number" || v === 0) return;
      if (v > 0) up = i;
      else down = i;
    });
    return { up, down };
  });
}

export type End = "top" | "bottom" | "left" | "right" | null;
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * A bar as a path: square at the baseline, its data-end rounded (radius 4, less on a thin bar).
 * Corners are quadratic curves through the corner point, so every number in the path is a point
 * inside the bar's box (tests read the box back from it).
 */
export function barPath({ x, y, w, h }: Rect, end: End, radius = 4): string {
  const f = (n: number) => Math.round(n * 100) / 100;
  const r = end == null ? 0 : Math.max(0, Math.min(radius, w / 2, h / 2));
  const [x0, y0, x1, y1] = [x, y, x + w, y + h].map(f);
  if (r <= 0) return `M${x0},${y0}L${x1},${y0}L${x1},${y1}L${x0},${y1}Z`;
  const R = f(r);
  switch (end) {
    case "top":
      return `M${x0},${y1}L${x0},${f(y0 + R)}Q${x0},${y0} ${f(x0 + R)},${y0}L${f(x1 - R)},${y0}Q${x1},${y0} ${x1},${f(y0 + R)}L${x1},${y1}Z`;
    case "bottom":
      return `M${x0},${y0}L${x1},${y0}L${x1},${f(y1 - R)}Q${x1},${y1} ${f(x1 - R)},${y1}L${f(x0 + R)},${y1}Q${x0},${y1} ${x0},${f(y1 - R)}Z`;
    case "right":
      return `M${x0},${y0}L${f(x1 - R)},${y0}Q${x1},${y0} ${x1},${f(y0 + R)}L${x1},${f(y1 - R)}Q${x1},${y1} ${f(x1 - R)},${y1}L${x0},${y1}Z`;
    default:
      return `M${x1},${y0}L${x1},${y1}L${f(x0 + R)},${y1}Q${x0},${y1} ${x0},${f(y1 - R)}L${x0},${f(y0 + R)}Q${x0},${y0} ${f(x0 + R)},${y0}Z`;
  }
}

/** The box a path made of absolute points (M, L, Q, C, Z) covers: what barPath drew. */
export function pathBox(d: string): Rect {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export type Pt = { x: number; y: number } | null;
export type Curve = "monotone" | "linear";
const curveOf = (c: Curve) => (c === "monotone" ? curveMonotoneX : curveLinear);
const round = (n: number) => Math.round(n * 100) / 100;

/** A line through the points; a null point leaves a gap. */
export function linePath(points: Pt[], curve: Curve): string {
  return (
    line<Pt>()
      .defined((p) => p != null)
      .x((p) => round(p!.x))
      .y((p) => round(p!.y))
      .curve(curveOf(curve))(points) ?? ""
  );
}

/** The region between `top` and `bottom` (one y per point, same x); a null top leaves a gap. */
export function areaPath(xs: number[], top: (number | null)[], bottom: number[], curve: Curve): string {
  const idx = xs.map((_, i) => i);
  return (
    area<number>()
      .defined((i) => top[i] != null)
      .x((i) => round(xs[i]))
      .y0((i) => round(bottom[i]))
      .y1((i) => round(top[i]!))
      .curve(curveOf(curve))(idx) ?? ""
  );
}

/**
 * Which category labels to draw along an axis without overlap: every one when they fit, else every
 * k-th, always keeping the first and the last (the one before the last gives way to it).
 * `pos` are label centres in order, `widths` their widths, `gap` the least space between two.
 */
export function thinTicks(pos: number[], widths: number[], gap: number): number[] {
  const n = pos.length;
  if (n <= 2) return pos.map((_, i) => i);
  const clear = (i: number, j: number) => Math.abs(pos[j] - pos[i]) - (widths[i] + widths[j]) / 2 >= gap;
  for (let k = 1; k < n; k++) {
    const pick: number[] = [];
    for (let i = 0; i < n; i += k) pick.push(i);
    let ok = pick.every((p, i) => i === 0 || clear(pick[i - 1], p));
    if (!ok) continue;
    if (pick[pick.length - 1] !== n - 1) {
      while (pick.length > 1 && !clear(pick[pick.length - 1], n - 1)) pick.pop();
      pick.push(n - 1);
      ok = pick.length < 2 || clear(pick[pick.length - 2], n - 1);
    }
    if (ok) return pick;
  }
  return [0, n - 1];
}
