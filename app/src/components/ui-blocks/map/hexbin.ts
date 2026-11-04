// The hexbin kind's binning, pure: points are projected first and binned in pixels
// (d3-hexbin), so every hexagon is regular on screen; a cell's value is the count of its points,
// or the sum or mean of their weights. Cells depend on the drawn size, so they are recomputed on
// resize (the table says so). Empty cells are not drawn.
import { hexbin as d3hexbin } from "d3-hexbin";
import type { Aggregate, HexPoint } from "@/components/ui-blocks/map/model";

export type Cell = {
  /** The cell's centre in px. */
  x: number;
  y: number;
  /** How many points fell in it. */
  n: number;
  /** Its value: n, or the sum or mean of the points' weights. */
  value: number;
  /** The indices of its points. */
  members: number[];
};

/**
 * Bin `points` into hexagons of `radius` px inside `width`×`height` (points that don't project,
 * or fall outside the box, are left out and counted in `dropped`). Sum and mean use only points
 * with a weight; a cell none of whose points has one gets no value and isn't drawn.
 */
export function binPoints(
  points: HexPoint[],
  project: (lon: number, lat: number) => [number, number] | null,
  { radius, width, height, aggregate }: { radius: number; width: number; height: number; aggregate: Aggregate },
): { cells: Cell[]; dropped: number; path: string } {
  type P = [number, number, number];
  const inBox: P[] = [];
  let dropped = 0;
  points.forEach((p, i) => {
    const xy = project(p.lon, p.lat);
    if (!xy || xy[0] < 0 || xy[0] > width || xy[1] < 0 || xy[1] > height) dropped++;
    else inBox.push([xy[0], xy[1], i]);
  });
  const hb = d3hexbin<P>()
    .x((d) => d[0])
    .y((d) => d[1])
    .radius(radius)
    .extent([
      [0, 0],
      [width, height],
    ]);
  const cells: Cell[] = [];
  for (const bin of hb(inBox)) {
    const members = bin.map((d) => d[2]);
    let value = members.length;
    if (aggregate !== "count") {
      const ws = members.flatMap((i) => (points[i].weight == null ? [] : [points[i].weight]));
      if (!ws.length) continue;
      const sum = ws.reduce((a, b) => a + b, 0);
      value = aggregate === "sum" ? sum : sum / ws.length;
    }
    cells.push({ x: bin.x, y: bin.y, n: members.length, value, members });
  }
  // A pixel in, so neighbouring cells keep a 2px gap of surface between them.
  return { cells, dropped, path: hb.hexagon(Math.max(1, radius - 1)) };
}
