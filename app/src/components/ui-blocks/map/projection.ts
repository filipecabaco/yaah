// Projections and fits for region maps, pure (d3-geo computes; React draws). Each region set has
// its own projection: Natural Earth for the world (no polar blow-up), a Lambert azimuthal
// equal-area centred on Europe (as EPSG:3035), and, for US states, the atlas's own Albers USA
// (already in pixels, so the fit is a plain scale and shift). A view is fitted into the box with
// 8px padding at the measured pixel size: text and strokes keep their size, nothing scales a viewBox.
import { geoAlbersUsa, geoAzimuthalEqualArea, geoIdentity, geoNaturalEarth1, geoPath, type GeoPath, type GeoProjection } from "d3-geo";
import type { GeoJSON, MultiPoint } from "geojson";
import type { RegionGeo, RegionSet } from "@/components/ui-blocks/map/geo";
import type { Bbox } from "@/components/ui-blocks/map/view-fit";
export type { Bbox, LonLat } from "@/components/ui-blocks/map/view-fit";

export const FIT_PAD = 8;

/** The part of each set a map shows by default. Europe: Iceland and Portugal to the Urals' near side. */
export const FRAME: Record<Exclude<RegionSet, "us-states">, Bbox | "sphere"> = { world: "sphere", europe: [-11, 34.5, 35, 71] };

export type Projector = {
  /** The path generator for region geometry. */
  path: GeoPath;
  /** A place in pixels, or null when the projection can't show it (Albers USA outside the US). */
  point: (lon: number, lat: number) => [number, number] | null;
  /** A pixel back to a place, or null off the map. */
  invert: (x: number, y: number) => [number, number] | null;
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
      invert: (x, y) => {
        const p = identity.invert?.([x, y]);
        return (p && albers.invert?.(p)) ?? null;
      },
    };
  }
  const projection = base(geo.set);
  const frame = FRAME[geo.set];
  const shape: GeoJSON | { type: "Sphere" } =
    target.kind === "bbox" ? bboxShape(target.bbox) : frame === "sphere" ? { type: "Sphere" } : bboxShape(frame);
  projection.fitExtent(extent, shape);
  return {
    path: geoPath(projection),
    point: (lon, lat) => projection([lon, lat]) ?? null,
    invert: (x, y) => projection.invert?.([x, y]) ?? null,
  };
}

export { PERCENTILE_MIN, percentileView } from "@/components/ui-blocks/map/view-fit";

/** Whether a projected point lies inside the drawn box. */
export const inBox = (p: [number, number] | null, width: number, height: number): p is [number, number] =>
  !!p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height;

export type Ring = [number, number][];

/**
 * The pixel rings `path` draws for a geometry (after projection, clipping and resampling), so a
 * label can be tested against the shape it sits in.
 */
export function projectedRings(path: GeoPath, object: Parameters<GeoPath>[0]): Ring[] {
  const rings: Ring[] = [];
  let ring: Ring = [];
  const end = () => {
    if (ring.length > 2) rings.push(ring);
    ring = [];
  };
  geoPath(path.projection(), {
    moveTo: (x: number, y: number) => {
      end();
      ring.push([x, y]);
    },
    lineTo: (x: number, y: number) => void ring.push([x, y]),
    closePath: end,
    beginPath: () => {},
    arc: () => {},
  })(object);
  end();
  return rings;
}
