// The view a set of places asks for, kept apart from d3-geo so the street map (map.tsx, Leaflet)
// can fit its markers the same way without loading the region map's projections.
import { quantile } from "@/components/ui-blocks/scale";

/** [west, south, east, north] in degrees. */
export type Bbox = [number, number, number, number];
export type LonLat = { lon: number; lat: number };

/** From this many points the view drops the outer 2% on each side (the Madeira and Azores problem). */
export const PERCENTILE_MIN = 20;

/**
 * The view for a set of places: their box, from 20 points up leaving out the far-off ones (the
 * Madeira and Azores problem). A place is left out when it lies outside the 2nd–98th percentile
 * of longitude or latitude and, on that same axis, past Tukey's fence (1.5 IQR beyond the
 * quartiles): the percentile alone would also drop the northernmost of an ordinary spread. The box
 * is padded by `margin` of its size and widened to at least `minSpan` degrees (one city is a city,
 * not a doorstep). `outside` lists the places left out, for the "N outside view" chip and the table.
 */
export function percentileView(
  points: LonLat[],
  { margin = 0.08, minSpan = 3 }: { margin?: number; minSpan?: number } = {},
): { bbox: Bbox; outside: number[] } | null {
  if (!points.length) return null;
  const far = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const [p2, p98, q1, q3] = [0.02, 0.98, 0.25, 0.75].map((q) => quantile(sorted, q));
    const fence = 1.5 * (q3 - q1);
    return (v: number) => (v < p2 - 1e-9 && v < q1 - fence) || (v > p98 + 1e-9 && v > q3 + fence);
  };
  const cut = points.length >= PERCENTILE_MIN;
  const farLon = far(points.map((p) => p.lon));
  const farLat = far(points.map((p) => p.lat));
  const out = (p: LonLat) => cut && (farLon(p.lon) || farLat(p.lat));
  const outside = points.flatMap((p, i) => (out(p) ? [i] : []));
  const kept = points.filter((p) => !out(p));
  let [w, e] = [Math.min(...kept.map((p) => p.lon)), Math.max(...kept.map((p) => p.lon))];
  let [s, n] = [Math.min(...kept.map((p) => p.lat)), Math.max(...kept.map((p) => p.lat))];
  const grow = (lo: number, hi: number, min: number, max: number): [number, number] => {
    const mid = (lo + hi) / 2;
    const half = Math.max(minSpan / 2, ((hi - lo) / 2) * (1 + 2 * margin));
    return [Math.max(min, mid - half), Math.min(max, mid + half)];
  };
  [w, e] = grow(w, e, -180, 180);
  [s, n] = grow(s, n, -85, 85);
  return { bbox: [w, s, e, n], outside };
}
