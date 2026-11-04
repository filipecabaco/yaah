// Projections and fits for region maps, pure (d3-geo computes; React draws). Each region set has
// its own projection: Natural Earth for the world (no polar blow-up), a Lambert azimuthal
// equal-area centred on Europe (as EPSG:3035), and, for US states, the atlas's own Albers USA
// (already in pixels, so the fit is a plain scale and shift). A view is fitted into the box with
// 8px padding at the measured pixel size: text and strokes keep their size, nothing scales a viewBox.
import { geoAlbersUsa, geoAzimuthalEqualArea, geoIdentity, geoNaturalEarth1, geoPath, type GeoPath, type GeoProjection } from "d3-geo";
import type { GeoJSON, MultiPoint } from "geojson";
import { quantile } from "@/components/ui-blocks/scale";
import type { RegionGeo, RegionSet } from "@/components/ui-blocks/map/geo";

export const FIT_PAD = 8;
/** [west, south, east, north] in degrees. */
export type Bbox = [number, number, number, number];
export type LonLat = { lon: number; lat: number };

/** The part of each set a map shows by default. Europe: Iceland and Portugal to the Urals' near side. */
export const FRAME: Record<Exclude<RegionSet, "us-states">, Bbox | "sphere"> = { world: "sphere", europe: [-11, 34.5, 35, 71] };

export type Projector = {
  /** The path generator for region geometry. */
  path: GeoPath;
  /** A place in pixels, or null when the projection can't show it (Albers USA outside the US). */
  point: (lon: number, lat: number) => [number, number] | null;
};

/** Points around a box's edge, so a fit on a sphere follows the curved sides. */
function bboxShape([w, s, e, n]: Bbox): MultiPoint {
  const steps = 8;
  const coordinates: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    coordinates.push([w + (e - w) * t, s], [w + (e - w) * t, n], [w, s + (n - s) * t], [e, s + (n - s) * t]);
  }
  return { type: "MultiPoint", coordinates };
}

const base = (set: Exclude<RegionSet, "us-states">): GeoProjection =>
  set === "world" ? geoNaturalEarth1() : geoAzimuthalEqualArea().rotate([-10, -52]).clipAngle(90);

/** The atlas's own projection for US places: Albers USA at the scale us-atlas pre-projected with. */
const usAlbers = () => geoAlbersUsa().scale(1300).translate([487.5, 305]);

export type FitTarget = { kind: "frame" } | { kind: "bbox"; bbox: Bbox };

/**
 * A projection fitted to `target` inside a `width`×`height` box (minus `pad` on every side): the
 * set's default frame, or a box of lon/lat (the data's view, or the agent's `view`).
 */
export function fitProjection(geo: Pick<RegionGeo, "set" | "regions">, target: FitTarget, width: number, height: number, pad = FIT_PAD): Projector {
  const extent: [[number, number], [number, number]] = [
    [pad, pad],
    [Math.max(pad + 1, width - pad), Math.max(pad + 1, height - pad)],
  ];
  if (geo.set === "us-states") {
    const albers = usAlbers();
    // A box of places as a grid through Albers USA (points it can't place, off the US, are left out).
    const grid = ([w, s, e, n]: Bbox) => {
      const out: [number, number][] = [];
      for (let i = 0; i <= 8; i++)
        for (let j = 0; j <= 8; j++) {
          const p = albers([w + ((e - w) * i) / 8, s + ((n - s) * j) / 8]);
          if (p) out.push(p);
        }
      return out;
    };
    const placed = target.kind === "bbox" ? grid(target.bbox) : [];
    const shape: GeoJSON =
      placed.length >= 2 ? { type: "MultiPoint", coordinates: placed } : { type: "FeatureCollection", features: geo.regions.map((r) => r.feature) };
    const identity = geoIdentity().fitExtent(extent, shape);
    return {
      path: geoPath(identity),
      point: (lon, lat) => {
        const p = albers([lon, lat]);
        return p ? identity(p) : null;
      },
    };
  }
  const projection = base(geo.set);
  const frame = FRAME[geo.set];
  const shape: GeoJSON | { type: "Sphere" } =
    target.kind === "bbox" ? bboxShape(target.bbox) : frame === "sphere" ? { type: "Sphere" } : bboxShape(frame);
  projection.fitExtent(extent, shape);
  return { path: geoPath(projection), point: (lon, lat) => projection([lon, lat]) ?? null };
}

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

/** Whether a projected point lies inside the drawn box. */
export const inBox = (p: [number, number] | null, width: number, height: number): p is [number, number] =>
  !!p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height;
