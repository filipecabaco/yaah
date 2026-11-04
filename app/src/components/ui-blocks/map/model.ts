// The region map's props, read from untrusted JSON into fixed shapes, and the rules that turn
// data into marks: a region's fill (a bin, or hatched for no data), bubble radii, draw order.
// Pure, so they are tested without a renderer. In step with src-tauri/src/ui_library/map.rs.
import { scaleSqrt } from "d3-scale";
import { asArray, asNumber, isObj, optText, type Obj } from "@/lib/narrow";
import { binColors, binOf, readScale, type Scale } from "@/components/ui-blocks/scale";
import { isTone, type Tone } from "@/components/ui-blocks/viz";
import { REGION_SETS, type RegionSet } from "@/components/ui-blocks/map/geo";
import type { Bbox } from "@/components/ui-blocks/map/projection";

export type MapKind = "markers" | "outline" | "choropleth" | "bubble";
export type LabelMode = "auto" | "all" | "none";
export type Highlight = { id: unknown; label?: string; detail?: string; tone: Tone };
export type Place = { id?: string; lon: number; lat: number; label: string; detail?: string; tone: Tone; value: number; shade?: number };
export type Datum = { id: unknown; value: number | null; label?: string; detail?: string };

export const CAPS = { highlight: 100, outlinePoints: 200, bubblePoints: 500, data: 3000, labelsAll: 24 } as const;
/** Labels that are always visible: this many labelled items or fewer. */
export const ALWAYS_LABEL = 12;
/** A bubble map labels its biggest few when there are more than ALWAYS_LABEL. */
export const TOP_LABELS = 5;
export const DEFAULT_HEIGHT = 360;

export type MapModel = {
  kind: Exclude<MapKind, "markers">;
  region: RegionSet;
  view: "auto" | Bbox;
  height: number;
  title?: string;
  scale: Scale | null;
  legend: { show: boolean; title?: string };
  labels: LabelMode;
  highlight: Highlight[];
  points: Place[];
  data: Datum[];
  noDataLabel: string;
  maxRadius?: number;
  unit?: string;
  borders: boolean;
};

export const readMapKind = (v: unknown): MapKind => (v === "outline" || v === "choropleth" || v === "bubble" ? v : "markers");

const text = (v: unknown, max: number) => optText(v)?.slice(0, max);

function readView(v: unknown): "auto" | Bbox {
  const b = asArray(v).map(asNumber);
  if (b.length === 4 && b.every((x) => x != null)) {
    const [w, s, e, n] = b;
    if (w < e && s < n && w >= -180 && e <= 180 && s >= -90 && n <= 90) return [w, s, e, n];
  }
  return "auto";
}

function readPlaces(raw: unknown, cap: number, needValue: boolean): Place[] {
  return asArray(raw)
    .slice(0, cap)
    .flatMap((p): Place[] => {
      if (!isObj(p)) return [];
      const lon = asNumber(p.lon);
      const lat = asNumber(p.lat);
      const value = asNumber(p.value);
      if (lon == null || lat == null || Math.abs(lon) > 180 || Math.abs(lat) > 90) return [];
      if (needValue && value == null) return [];
      return [
        {
          id: optText(p.id),
          lon,
          lat,
          label: text(p.label, 60) ?? "",
          detail: text(p.detail, 200),
          tone: isTone(p.tone) ? p.tone : "default",
          value: value ?? 0,
          shade: asNumber(p.shade),
        },
      ];
    });
}

/** Everything a region map reads from its props, defaulted and capped. */
export function readMapModel(p: Obj): MapModel {
  const kind = readMapKind(p.kind);
  const region = REGION_SETS.includes(p.region as RegionSet) ? (p.region as RegionSet) : "world";
  const legend = isObj(p.legend) ? { show: true, title: text(p.legend.title, 80) } : { show: p.legend !== false };
  const height = asNumber(p.height);
  const maxRadius = asNumber(p.maxRadius);
  return {
    kind: kind === "markers" ? "outline" : kind,
    region,
    view: readView(p.view),
    height: height ? Math.max(160, Math.min(900, height)) : DEFAULT_HEIGHT,
    title: text(p.title, 120),
    scale: readScale(p.scale),
    legend,
    labels: p.labels === "all" || p.labels === "none" ? p.labels : "auto",
    highlight: asArray(p.highlight)
      .slice(0, CAPS.highlight)
      .flatMap((h): Highlight[] =>
        isObj(h) && h.id != null
          ? [{ id: h.id, label: text(h.label, 60), detail: text(h.detail, 200), tone: isTone(h.tone) ? h.tone : "default" }]
          : [],
      ),
    points: readPlaces(p.points, kind === "bubble" ? CAPS.bubblePoints : CAPS.outlinePoints, kind === "bubble"),
    data: asArray(p.data)
      .slice(0, CAPS.data)
      .flatMap((d): Datum[] =>
        isObj(d) && d.id != null
          ? [{ id: d.id, value: d.value === null ? null : (asNumber(d.value) ?? null), label: text(d.label, 60), detail: text(d.detail, 200) }]
          : [],
      ),
    noDataLabel: text(p.noDataLabel, 40) ?? "No data",
    maxRadius: maxRadius == null ? undefined : Math.max(6, Math.min(48, maxRadius)),
    unit: text(p.unit, 12),
    borders: p.borders !== "none",
  };
}

/** The default sequential scale of a choropleth: 5 classes. */
export const DEFAULT_SCALE: Scale = { type: "sequential", bins: 5 };

export type Fill = { kind: "none" } | { kind: "bin"; bin: number; color: string };

/**
 * A region's fill: the colour of its value's bin (clamped into the end bins past the domain), or
 * none (drawn hatched, with "No data" in the legend) when it has no row or its value is null.
 * Never the lowest class for missing data.
 */
export function fillFor(value: number | null | undefined, scale: Scale, domain: [number, number]): Fill {
  if (value == null || !Number.isFinite(value)) return { kind: "none" };
  const bin = binOf(scale, domain, value);
  return { kind: "bin", bin, color: binColors(scale)[bin] ?? "var(--muted-foreground)" };
}

/** The default largest bubble: about a fourteenth of the map's short side, 6–48 px. */
export const defaultMaxRadius = (width: number, height: number) => Math.max(6, Math.min(48, Math.round(Math.min(width, height) / 14)));
/** A positive value is never drawn under this radius, so it stays visible. */
export const MIN_RADIUS = 2;

/**
 * Bubble radius: square root over [0, max], so area is proportional to value and zero is zero
 * (the gallery's extent domain is not). Positive values get at least MIN_RADIUS.
 */
export function bubbleRadius(max: number, maxRadius: number): (v: number) => number {
  const s = scaleSqrt()
    .domain([0, max > 0 ? max : 1])
    .range([0, maxRadius])
    .clamp(true);
  return (v) => (v > 0 ? Math.max(MIN_RADIUS, s(v)) : 0);
}

/** Indices of the points to draw, largest first (so small ones end up on top), negatives left out and counted. */
export function bubbleOrder(points: { value: number }[]): { order: number[]; negative: number } {
  const order = points
    .map((p, i) => [p.value, i] as const)
    .filter(([v]) => v >= 0)
    .sort(([a, i], [b, j]) => b - a || i - j)
    .map(([, i]) => i);
  return { order, negative: points.length - order.length };
}

/** Which of `n` items carry a visible label: all of them up to ALWAYS_LABEL, else the `top` biggest by value. */
export function labelled(values: number[], mode: LabelMode, top = TOP_LABELS): Set<number> {
  if (mode === "none") return new Set();
  const n = values.length;
  if (mode === "all") return new Set(Array.from({ length: Math.min(n, CAPS.labelsAll) }, (_, i) => i));
  if (n <= ALWAYS_LABEL) return new Set(Array.from({ length: n }, (_, i) => i));
  return new Set(
    values
      .map((v, i) => [v, i] as const)
      .sort(([a, i], [b, j]) => b - a || i - j)
      .slice(0, top)
      .map(([, i]) => i),
  );
}

export const describeValue = (v: number | null, fmt: (v: unknown) => string, noData: string) => (v == null ? noData : fmt(v));
