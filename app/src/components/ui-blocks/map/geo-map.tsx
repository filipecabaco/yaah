// `map` kinds `outline`, `choropleth`, `bubble`, `connection` and `hexbin`: React-drawn SVG over
// d3-geo and the bundled atlases (map/geo.ts), on the shared figure core (viz/). No tiles, no
// Leaflet, nothing fetched: they work offline and take every colour from theme tokens (--map-* in
// index.css, the --scale-* ramps, --chart-*). Visible labels for small counts; hover and keyboard
// focus show the same tooltip; every region, place, link or cell is also in its accessible name
// and in the table view. A world map zoomed to a country or two draws the 1:50m coast, loaded
// then. docs/research/map-types.md.
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Feature, Geometry, Polygon } from "geojson";
import { formatter } from "@/components/ui-blocks/chart-model";
import { useChartFont } from "@/components/ui-blocks/chart-font";
import { binColors, binRange, colorOf, fencedDomain, MAX_BINS, type Scale } from "@/components/ui-blocks/scale";
import {
  BinLegend,
  binDecimals,
  edge,
  Legend,
  LegendItem,
  SizeLegend,
  SquareSwatch,
  TONE_FILL,
  TONE_WORD,
  ViewToggle,
  VizTable,
  VizTooltip,
  readableOn,
  sizeLegendValues,
  spatialStep,
  textWidth,
  tidy,
  tokenName,
  useResolvedTokens,
  useRoving,
  useSize,
  type Column,
  type Tone,
} from "@/components/ui-blocks/viz";
import { ErrorText } from "@/components/error-text";
import { REGION_NAME, resolveId, useDetail, useRegion, wantsDetail, type Region, type RegionGeo } from "@/components/ui-blocks/map/geo";
import { fitProjection, inBox, percentileView, projectedRings, type FitTarget, type LonLat } from "@/components/ui-blocks/map/projection";
import {
  ALWAYS_LABEL,
  CAPS,
  DEFAULT_SCALE,
  bubbleOrder,
  bubbleRadius,
  defaultMaxRadius,
  fillFor,
  labelled,
  missingMode,
  readMapModel,
  type Datum,
  type Highlight,
  type MapModel,
  type Place,
} from "@/components/ui-blocks/map/model";
import { clipRings, placePointLabels, placeRegionLabels, type PlacedLabel, type PointLabelInput } from "@/components/ui-blocks/map/labels";
import {
  arcMidpoint,
  arcRuns,
  arrowHead,
  byValue,
  FIXED_WIDTH,
  hubWeights,
  LINK_LABELS_MAX,
  linkOrder,
  linkWidth,
  runsToPath,
  trimEnd,
} from "@/components/ui-blocks/map/connection";
import { binPoints, type Cell } from "@/components/ui-blocks/map/hexbin";
import { growAttr, growClass, useUiView } from "@/components/ui-view";
import { keepLinksOutside } from "@/components/ui-blocks/links";
import type { Obj } from "@/lib/narrow";
import { cn } from "@/lib/utils";

const VIEWS = ["map", "table"] as const;
const CREDIT: Record<RegionGeo["set"], string> = { world: "Natural Earth", europe: "Natural Earth", "us-states": "US Census Bureau" };
/** A halo in the surface colour under text that sits on the map. */
const HALO = { stroke: "var(--chart-surface)", strokeWidth: 3, strokeLinejoin: "round", paintOrder: "stroke" } as const;
/** A bubble map with more than ALWAYS_LABEL places labels at most this many, biggest first, where they fit. */
const BUBBLE_LABELS = 10;
/** A connection map with more than ALWAYS_LABEL hubs labels the busiest this many, where they fit. */
const HUB_LABELS = 12;
/** The hexbin table lists the fullest cells, this many. */
const HEX_TABLE_ROWS = 50;
const HUB_R = 4;

/**
 * The scale as small marks (bubbles, hexagons) carry it: no more bins than the ramp has steps that
 * hold 3:1 on the surface (4 for sequential, 5 for diverging), so no class falls back to gray.
 */
const forSmallMarks = (s: Scale): Scale => ({ ...s, bins: Math.min(s.bins, binColors({ ...s, bins: MAX_BINS }, true).length) });

export default function UiGeoMap(props: { props: Obj }) {
  // By value: a re-render with the same props is no change (the tree hands over a new object each time).
  const key = JSON.stringify(props.props);
  const model = useMemo(() => readMapModel(JSON.parse(key) as Obj), [key]);
  const geo = useRegion(model.region);
  if (geo instanceof Error) return <ErrorText error={geo} prefix={`Couldn't load the map of ${REGION_NAME[model.region]}: `} />;
  if (!geo) return <div className="animate-pulse rounded-md bg-muted" style={{ height: model.height + 32 }} aria-busy="true" />;
  return <GeoMap model={model} base={geo} />;
}

/** One thing on the map that takes focus: a region with a row, a highlighted region, a place, a hub, a link or a cell. */
type Item = {
  key: string;
  name: string;
  /** The tooltip and table lines after the name, and the accessible name. */
  lines: string[];
  aria: string;
  anchor: { x: number; y: number };
  region?: Region;
  place?: { x: number; y: number; r: number };
  link?: number;
  cell?: number;
};

/** The label spot, box and pixel rings of a region's largest part (where its label goes). */
function labelGeometry(f: Feature<Geometry>, path: ReturnType<typeof fitProjection>["path"]) {
  const parts: Feature<Polygon>[] =
    f.geometry.type === "MultiPolygon"
      ? f.geometry.coordinates.map((coordinates) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates } }))
      : [f as Feature<Polygon>];
  let best = parts[0];
  let area = -1;
  for (const p of parts) {
    const a = path.area(p);
    if (a > area) [best, area] = [p, a];
  }
  const [[x0, y0], [x1, y1]] = path.bounds(best);
  const [cx, cy] = path.centroid(best);
  return { at: { x: cx, y: cy }, box: { w: x1 - x0, h: y1 - y0 }, best };
}

const latLon = (lon: number, lat: number) =>
  `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? "E" : "W"}`;

function GeoMap({ model, base }: { model: MapModel; base: RegionGeo }) {
  const { expanded } = useUiView();
  const font = useChartFont();
  const { ref, width, height: measured } = useSize({ width: 640, height: model.height });
  const height = expanded ? Math.max(240, measured) : model.height;
  const [view, setView] = useState<(typeof VIEWS)[number]>("map");
  const [fitAll, setFitAll] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const uid = useId().replace(/[^\w-]/g, "");
  const tipId = `${uid}-tip`;
  const rootRef = useRef<HTMLDivElement>(null);
  const unit = model.unit ?? model.scale?.unit;
  const fmt = useMemo(() => formatter(unit), [unit]);
  const scaleFmt = useMemo(() => (model.scale?.unit ? formatter(model.scale.unit) : fmt), [model.scale, fmt]);
  const { kind } = model;
  const choropleth = kind === "choropleth";
  const bubble = kind === "bubble";
  const connection = kind === "connection";
  const hexbin = kind === "hexbin";
  // The places a point kind fits its view to.
  const located: LonLat[] = useMemo(
    () => (bubble ? model.points : connection ? model.hubs : hexbin ? model.hexPoints : []),
    [bubble, connection, hexbin, model],
  );
  const pointView = located.length > 0;

  // ── projection, fitted to the box ──
  const pv = useMemo(() => (pointView ? percentileView(located) : null), [pointView, located]);
  // Hubs on both sides of the world: the whole world, so the arcs between them (across the Pacific) show.
  const worldWide = connection && base.set === "world" && !!pv && pv.bbox[2] - pv.bbox[0] >= 150;
  const target: FitTarget =
    model.view !== "auto"
      ? { kind: "bbox", bbox: model.view }
      : pv && !worldWide
        ? { kind: "bbox", bbox: fitAll && pv.outside.length ? boxOfAll(located) : pv.bbox }
        : { kind: "frame" };
  // Zoomed into the world: the 1:50m coast once it has loaded (the 1:110m one until then).
  const detail = useDetail(wantsDetail(base.set, target.kind === "bbox" ? target.bbox : null));
  const geo = detail ?? base;
  const targetKey = JSON.stringify(target);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- by value: targetKey stands for target
  const proj = useMemo(() => fitProjection(geo, target, width, height), [geo, targetKey, width, height]);
  const regionPaths = useMemo(() => geo.regions.map((r) => proj.path(r.feature) ?? ""), [geo, proj]);
  const landPaths = useMemo(() => geo.land.map((f) => proj.path(f) ?? ""), [geo, proj]);
  const borders = useMemo(() => (model.borders ? (proj.path(geo.borders) ?? "") : ""), [geo, proj, model.borders]);
  const sphere = useMemo(
    () => (geo.set === "world" && target.kind === "frame" ? (proj.path({ type: "Sphere" }) ?? "") : ""),
    [geo, proj, target.kind],
  );

  // ── data, joined to the geometry by canonical id ──
  const joined = useMemo(() => {
    const rows = new Map<string, Datum>();
    const highlights = new Map<string, Highlight>();
    const unknown: string[] = [];
    for (const d of model.data) {
      const id = resolveId(base, d.id);
      if (id) rows.set(id, d);
      else unknown.push(String(d.id));
    }
    for (const h of model.highlight) {
      const id = resolveId(base, h.id);
      if (id) highlights.set(id, h);
      else unknown.push(String(h.id));
    }
    return { rows, highlights, unknown };
  }, [model, base]);
  const missing = missingMode(model.missing, base.regions.length, joined.rows.size);
  const absent = choropleth ? base.regions.length - joined.rows.size : 0;

  // ── places ──
  const maxR = model.maxRadius ?? defaultMaxRadius(width, height);
  const maxValue = Math.max(0, ...model.points.map((p) => p.value));
  const radius = useMemo(() => bubbleRadius(maxValue, maxR), [maxValue, maxR]);
  const { order: drawOrder, negative } = bubble ? bubbleOrder(model.points) : { order: model.points.map((_, i) => i), negative: 0 };
  const projected = model.points.map((p) => proj.point(p.lon, p.lat));
  const visible = projected.map((p) => inBox(p, width, height));

  // ── hubs and links ──
  const hubXY = model.hubs.map((h) => proj.point(h.lon, h.lat));
  const hubVisible = hubXY.map((p) => inBox(p, width, height));
  const valued = byValue(model.width, model.links);
  const maxLink = Math.max(0, ...model.links.map((l) => l.value ?? 0));
  const widthOf = useMemo(() => linkWidth(maxLink), [maxLink]);
  const hubIndex = useMemo(() => new Map(model.hubs.map((h, i) => [h.id, i])), [model.hubs]);
  const links = useMemo(
    () =>
      model.links.map((l) => {
        const a = model.hubs[hubIndex.get(l.from)!];
        const b = model.hubs[hubIndex.get(l.to)!];
        const runs = arcRuns(proj.point, [a.lon, a.lat], [b.lon, b.lat], Math.max(width, height) / 3);
        const w = valued ? widthOf(l.value) : FIXED_WIDTH;
        const drawn = model.directed ? trimEnd(runs, HUB_R + 2) : runs;
        const half = arcMidpoint(proj.point, [a.lon, a.lat], [b.lon, b.lat]);
        // Its tooltip at the middle, or where it is on the map when the middle isn't.
        const mid = half && inBox(half, width, height) ? half : (runs.flat().find((p) => inBox(p, width, height)) ?? null);
        return { d: runsToPath(drawn), arrow: model.directed ? arrowHead(drawn, w) : null, w, mid, a, b };
      }),
    [model, hubIndex, proj, valued, widthOf, width, height],
  );
  const linkDraw = useMemo(() => linkOrder(model.links), [model.links]);
  const weights = useMemo(() => hubWeights(model.hubs, model.links), [model.hubs, model.links]);

  // ── hexagons ──
  const hex = useMemo(
    () => (hexbin ? binPoints(model.hexPoints, proj.point, { radius: model.radius, width, height, aggregate: model.aggregate }) : null),
    [hexbin, model, proj, width, height],
  );

  // ── colour scale ──
  const scale: Scale = choropleth
    ? (model.scale ?? DEFAULT_SCALE)
    : hexbin
      ? forSmallMarks(model.scale ?? DEFAULT_SCALE)
      : model.scale && bubble
        ? forSmallMarks(model.scale)
        : DEFAULT_SCALE;
  const values = choropleth
    ? [...joined.rows.values()].flatMap((d) => (d.value == null ? [] : [d.value]))
    : hex
      ? hex.cells.map((c) => c.value)
      : model.points.flatMap((p) => (p.shade == null ? [] : [p.shade]));
  // Counts start at zero, so the lowest class reads "0 to …", not "1 to 1.6".
  const fenced = fencedDomain(scale, hex && model.aggregate === "count" && values.length ? [0, ...values] : values);
  const domain = fenced.domain;

  const outside = bubble
    ? model.points.filter((_, i) => !visible[i]).length
    : connection
      ? hubVisible.filter((v) => !v).length
      : hex
        ? hex.dropped
        : 0;

  // ── the focusable items, with their words ──
  const regionIndex = useMemo(() => new Map(geo.regions.map((r, i) => [r.id, i])), [geo]);
  const items: Item[] = [];
  const binText = (v: number) => {
    const b = fillFor(v, scale, domain);
    if (b.kind !== "bin") return "";
    const d = binDecimals(domain, scale.bins);
    const [lo, hi] = binRange(scale, domain, b.bin).map((x) => edge(x, d));
    const ends =
      b.bin === 0 && fenced.below
        ? `under ${scaleFmt(tidy(hi))}`
        : b.bin === scale.bins - 1 && fenced.above
          ? `over ${scaleFmt(tidy(lo))}`
          : `${scaleFmt(tidy(lo))} to ${scaleFmt(tidy(hi))}`;
    return `class ${b.bin + 1} of ${scale.bins} (${ends})`;
  };
  const regionAnchor = (r: Region) => labelGeometry(r.feature, proj.path).at;
  if (choropleth)
    for (const [id, d] of joined.rows) {
      const r = geo.byId.get(id);
      if (!r) continue;
      const name = d.label ?? r.name;
      const lines = [
        d.value == null ? model.noDataLabel : fmt(d.value),
        ...(d.value == null ? [] : [binText(d.value)]),
        ...(d.detail ? [d.detail] : []),
      ];
      items.push({ key: id, name, lines, aria: `${name}, ${lines.join(", ")}`, anchor: regionAnchor(r), region: r });
    }
  if (kind === "outline")
    for (const [id, h] of joined.highlights) {
      const r = geo.byId.get(id);
      if (!r) continue;
      const name = h.label ?? r.name;
      const lines = [TONE_WORD[h.tone], h.detail].filter((x): x is string => !!x);
      items.push({ key: id, name, lines, aria: [name, ...lines].join(", "), anchor: regionAnchor(r), region: r });
    }
  const placeItem = new Map<number, number>();
  for (const i of drawOrder) {
    const p = model.points[i];
    const xy = projected[i];
    if (!visible[i] || !xy) continue;
    const r = bubble ? radius(p.value) : 5;
    const lines = [
      ...(bubble ? [fmt(p.value)] : []),
      ...(p.shade != null && model.scale ? [`${scaleFmt(p.shade)}`] : []),
      TONE_WORD[p.tone],
      p.detail,
    ].filter((x): x is string => !!x);
    const name = p.label || `Place ${i + 1}`;
    placeItem.set(i, items.length);
    items.push({ key: `p${i}`, name, lines, aria: [name, ...lines].join(", "), anchor: { x: xy[0], y: xy[1] }, place: { x: xy[0], y: xy[1], r } });
  }
  const hubItem = new Map<number, number>();
  model.hubs.forEach((h, i) => {
    const xy = hubXY[i];
    if (!hubVisible[i] || !xy) return;
    const n = model.links.filter((l) => l.from === h.id || l.to === h.id).length;
    const total = weights.get(h.id) ?? 0;
    const lines = [valued ? `${fmt(total)} in all` : "", `${n} ${n === 1 ? "link" : "links"}`, h.detail ?? ""].filter(Boolean);
    hubItem.set(i, items.length);
    items.push({
      key: `h${i}`,
      name: h.label,
      lines,
      aria: [h.label, ...lines].join(", "),
      anchor: { x: xy[0], y: xy[1] },
      place: { x: xy[0], y: xy[1], r: HUB_R },
    });
  });
  const linkItem = new Map<number, number>();
  model.links.forEach((l, i) => {
    const g = links[i];
    if (!g.d || !g.mid) return;
    const name = `${g.a.label} ${model.directed ? "to" : "and"} ${g.b.label}`;
    const lines = [l.value != null ? fmt(l.value) : "", l.label ?? "", l.detail ?? ""].filter(Boolean);
    linkItem.set(i, items.length);
    items.push({ key: `l${i}`, name, lines, aria: [name, ...lines].join(", "), anchor: { x: g.mid[0], y: g.mid[1] }, link: i });
  });
  hex?.cells.forEach((c, i) => {
    const ll = proj.invert(c.x, c.y);
    const name = ll ? `Cell at ${latLon(ll[0], ll[1])}` : `Cell ${i + 1}`;
    const lines = [fmt(tidy(c.value)), binText(c.value), model.aggregate === "count" ? "" : `${c.n} ${c.n === 1 ? "point" : "points"}`].filter(
      Boolean,
    );
    items.push({ key: `c${i}`, name, lines, aria: [name, ...lines].join(", "), anchor: { x: c.x, y: c.y }, cell: i });
  });

  const step = (k: string, i: number) =>
    spatialStep(
      k,
      i,
      items.map((it) => it.anchor),
    );
  const roving = useRoving(items.length, step);

  // ── labels ──
  const labels: PlacedLabel[] = useMemo(() => {
    if (model.labels === "none") return [];
    const size = { width, height };
    const cap = model.labels === "all" ? CAPS.labelsAll : Infinity;
    const regionItems = items.filter((it) => it.region);
    const few = regionItems.length <= ALWAYS_LABEL;
    const placeItems = items.filter((it) => it.place);
    const asInput = (it: Item): PointLabelInput => ({ key: it.key, text: it.name, x: it.place!.x, y: it.place!.y, r: it.place!.r });
    const marks = placeItems.map((it) => ({ key: it.key, x: it.place!.x, y: it.place!.y, r: it.place!.r }));
    let pointLabels: PlacedLabel[];
    if (bubble || connection) {
      // Most important first (biggest bubble, busiest hub); each takes the first free spot round its mark.
      const weight = (it: Item) =>
        bubble ? model.points[Number(it.key.slice(1))].value : (weights.get(model.hubs[Number(it.key.slice(1))].id) ?? 0);
      const sorted = [...placeItems].sort((a, b) => weight(b) - weight(a));
      const n = sorted.length;
      const own = model.labels === "all" ? CAPS.labelsAll : n <= ALWAYS_LABEL ? n : bubble ? BUBBLE_LABELS : HUB_LABELS;
      const inputs = sorted.slice(0, own).map(asInput);
      // Link labels, where the agent gave one and there are few links, after the hubs.
      if (connection && model.links.length <= LINK_LABELS_MAX)
        for (const it of items)
          if (it.link != null && model.links[it.link].label)
            inputs.push({ key: it.key, text: model.links[it.link].label!, x: it.anchor.x, y: it.anchor.y, r: 2 });
      pointLabels = placePointLabels(inputs, font, size, { around: true, avoid: marks });
    } else {
      const chosen = labelled(
        placeItems.map(() => 0),
        model.labels,
      );
      pointLabels = placePointLabels(
        placeItems.flatMap((it, j) => (chosen.has(j) ? [asInput(it)] : [])),
        font,
        size,
      );
    }
    const cellLabels: PlacedLabel[] = [];
    if (hex && model.labels === "all" && model.radius >= 16)
      for (const it of items) {
        if (it.cell == null) continue;
        const c = hex.cells[it.cell];
        const text = fmt(tidy(c.value));
        const w = textWidth(text, font);
        if (w > model.radius * 1.6) continue;
        cellLabels.push({
          key: it.key,
          text,
          x: c.x,
          y: c.y,
          anchor: "middle",
          rect: { x0: c.x - w / 2, y0: c.y - font / 2, x1: c.x + w / 2, y1: c.y + font / 2 },
        });
      }
    const regionLabels = placeRegionLabels(
      regionItems.map((it) => {
        const g = labelGeometry(it.region!.feature, proj.path);
        // The part that shows: a region running off the map is labelled where it is seen, sized by that.
        const rings = clipRings(projectedRings(proj.path, g.best), width, height);
        const pts = rings.flat();
        const box = pts.length
          ? {
              w: Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])),
              h: Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])),
            }
          : { w: 0, h: 0 };
        const short = geo.set === "us-states" ? it.region!.id : (it.region!.codes[0] ?? it.region!.id);
        // Countries by name where it fits; their code when every region is labelled anyway, or when a big
        // country's name won't fit inside it ("United States" across the Lower 48).
        const big = box.w * box.h > 3000;
        const texts = geo.set === "us-states" ? [short] : few || model.labels === "all" || big ? [it.name, short] : [it.name];
        return { key: it.key, texts, at: g.at, box, force: (few || model.labels === "all") && pts.length > 0, rings };
      }),
      font,
      size,
      cap,
      // Places come first: their labels and dots are tied to a spot; a region's label can sit anywhere in it.
      [...pointLabels.map((l) => l.rect), ...marks.map((m) => ({ x0: m.x - m.r, y0: m.y - m.r, x1: m.x + m.r, y1: m.y + m.r }))],
    );
    return [...regionLabels, ...pointLabels, ...cellLabels];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- items are derived from these
  }, [model, geo, proj, font, width, height, radius, hex, links, weights]);

  // ── colours resolved, for label text over a filled region or cell ──
  const colors = binColors(scale, hexbin);
  const resolved = useResolvedTokens(rootRef, [...colors.map(tokenName), "--foreground", "--background"]);
  const textOn = (fill: string) => readableOn(resolved[tokenName(fill)], resolved["--foreground"], resolved["--background"]);

  const nulls = choropleth && [...joined.rows.values()].some((d) => d.value == null);
  const hatched = choropleth && (nulls || (missing === "hatch" && absent > 0));
  const asLand = choropleth && missing === "land" && absent > 0;
  // A diverging scale's gray middle class looks like plain land: then land is drawn as outlines only.
  const outlineLand = asLand && scale.type === "diverging" && scale.bins % 2 === 1;
  // The words for each: the agent's noDataLabel names the regions without a row; nulls are "No data" beside plain land.
  const hatchLabel = missing === "land" ? "No data" : model.noDataLabel;
  const landLabel = model.noDataGiven ? model.noDataLabel : "Not in the data";
  const empty = choropleth
    ? joined.rows.size === 0
    : bubble
      ? model.points.length === 0
      : connection
        ? model.links.length === 0 && model.hubs.length === 0
        : hexbin
          ? model.hexPoints.length === 0
          : false;
  const tones = new Map<Tone, number>();
  if (kind === "outline") for (const t of [...joined.highlights.values(), ...model.points].map((x) => x.tone)) tones.set(t, (tones.get(t) ?? 0) + 1);

  const tip = active != null ? items[active] : null;
  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActive(i);
      setPinned((p) => !p);
    } else if (e.key === "Escape") {
      setPinned(false);
      setActive(null);
    }
  };
  const itemProps = (i: number) => {
    const r = roving.props(i);
    return {
      ...r,
      role: "img",
      "aria-label": items[i].aria,
      "aria-describedby": active === i ? tipId : undefined,
      "data-item": items[i].key,
      className: "outline-none",
      onPointerEnter: () => !pinned && setActive(i),
      onFocus: () => {
        setActive(i);
        roving.setFocus(i);
      },
      onBlur: () => !pinned && setActive(null),
      onKeyDown: (e: KeyboardEvent) => {
        onKey(e, i);
        r.onKeyDown(e);
      },
    };
  };

  const title = model.title ?? `Map of ${REGION_NAME[geo.set]}`;
  const summary = summaryOf(model, joined.rows, values, fmt, outside, negative, hex?.cells.length ?? 0, absent, missing);

  return (
    <div
      ref={rootRef}
      className="ui-map flex min-w-0 flex-col gap-2"
      data-map-kind={kind}
      data-set={geo.set}
      data-detail={detail ? "50m" : undefined}
      onClickCapture={keepLinksOutside}
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        {outside > 0 && (
          <button
            type="button"
            className="min-h-6 rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            aria-pressed={fitAll}
            onClick={() => setFitAll((f) => !f)}
            data-part="outside-chip"
          >
            {outside} outside view{fitAll ? "" : " · show all"}
          </button>
        )}
        {fitAll && outside === 0 && pv?.outside.length ? (
          <button
            type="button"
            className="min-h-6 rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            aria-pressed
            onClick={() => setFitAll(false)}
          >
            Fit to most places
          </button>
        ) : null}
        <ViewToggle value={view} onChange={setView} views={VIEWS} />
      </div>
      {view === "map" ? (
        <>
          <div
            ref={ref}
            {...growAttr(expanded)}
            role="region"
            aria-label={`Map, ${title}`}
            className={cn("relative w-full rounded-md", expanded ? growClass(true, "") : "shrink-0", "overflow-hidden")}
            style={expanded ? { minHeight: model.height } : { height: model.height }}
            onPointerLeave={() => !pinned && setActive(null)}
          >
            <svg
              width={width}
              height={height}
              role="group"
              aria-labelledby={`${uid}-t`}
              aria-describedby={`${uid}-d`}
              className="block tabular-nums"
              style={{ fontSize: font }}
            >
              <title id={`${uid}-t`}>{title}</title>
              <desc id={`${uid}-d`}>{summary}</desc>
              <defs>
                <pattern id={`${uid}-hatch`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width={6} height={6} fill="var(--map-land)" />
                  <line x1={0} y1={0} x2={0} y2={6} stroke="var(--map-hatch)" strokeWidth={1.5} />
                </pattern>
              </defs>
              {sphere && <path d={sphere} fill="var(--map-water)" stroke="var(--border)" strokeWidth={1} data-part="sphere" />}
              <g aria-hidden data-part="land">
                {landPaths.map((d, i) => (
                  <path key={i} d={d} fill="var(--map-land)" />
                ))}
              </g>
              <g data-part="regions">
                {geo.regions.map((r, i) => {
                  const d = regionPaths[i];
                  if (!d) return null;
                  const row = joined.rows.get(r.id);
                  const hl = joined.highlights.get(r.id);
                  let fill = "var(--map-land)";
                  let state = hl ? hl.tone : "land";
                  if (choropleth) {
                    const f = fillFor(row?.value, scale, domain);
                    if (f.kind === "bin") [fill, state] = [f.color, "bin"];
                    else if (row || missing === "hatch") [fill, state] = [`url(#${uid}-hatch)`, "none"];
                    else [fill, state] = [outlineLand ? "var(--chart-surface)" : fill, outlineLand ? "outline" : "land"];
                  } else if (hl) fill = TONE_FILL[hl.tone];
                  const it = items.findIndex((x) => x.region?.id === r.id);
                  return (
                    <path
                      key={r.id}
                      d={d}
                      fill={fill}
                      fillOpacity={hl && !choropleth ? 0.8 : undefined}
                      stroke={choropleth ? "var(--chart-surface)" : "none"}
                      strokeWidth={choropleth ? 0.75 : 0}
                      data-region={r.id}
                      data-fill={state}
                      {...(it >= 0 ? itemProps(it) : { "aria-hidden": true })}
                    />
                  );
                })}
              </g>
              {borders && (
                <path
                  d={borders}
                  fill="none"
                  stroke={choropleth ? "var(--chart-surface)" : "var(--map-stroke)"}
                  strokeWidth={choropleth ? 0.75 : 0.6}
                  strokeLinejoin="round"
                  aria-hidden
                  data-part="borders"
                  pointerEvents="none"
                />
              )}
              {outlineLand && (
                <g aria-hidden data-part="outside" pointerEvents="none">
                  {geo.regions.map((r, i) =>
                    joined.rows.has(r.id) || !regionPaths[i] ? null : (
                      <path key={r.id} d={regionPaths[i]} fill="none" stroke="var(--map-stroke)" strokeWidth={0.6} strokeLinejoin="round" />
                    ),
                  )}
                </g>
              )}
              {hex && (
                <g data-part="cells">
                  {items.map((it, k) => {
                    if (it.cell == null) return null;
                    const c: Cell = hex.cells[it.cell];
                    return (
                      <path
                        key={it.key}
                        d={hex.path}
                        transform={`translate(${c.x.toFixed(1)},${c.y.toFixed(1)})`}
                        fill={colorOf(scale, domain, c.value, true)}
                        data-mark="cell"
                        data-value={c.value}
                        {...itemProps(k)}
                      />
                    );
                  })}
                </g>
              )}
              {connection && (
                <g data-part="links">
                  {linkDraw.map((i) => {
                    const k = linkItem.get(i);
                    const g = links[i];
                    if (k == null || !g.d) return null;
                    return (
                      <g key={i} {...itemProps(k)}>
                        <path
                          d={g.d}
                          fill="none"
                          stroke="var(--chart-1)"
                          strokeOpacity={0.75}
                          strokeWidth={g.w}
                          strokeLinecap="round"
                          data-mark="link"
                          data-width={g.w.toFixed(2)}
                        />
                        {g.arrow && <path d={g.arrow} fill="var(--chart-1)" data-mark="arrow" />}
                        {/* A hit target of about 24px along thin links. */}
                        <path d={g.d} fill="none" stroke="transparent" strokeWidth={Math.max(g.w + 8, 16)} data-part="hit" />
                      </g>
                    );
                  })}
                </g>
              )}
              <g data-part="places">
                {drawOrder.map((i) => {
                  const k = placeItem.get(i);
                  if (k == null) return null;
                  const p = model.points[i];
                  const it = items[k];
                  const { x, y, r } = it.place!;
                  const fill = bubble
                    ? p.shade != null && model.scale
                      ? colorOf(scale, domain, p.shade, true)
                      : "var(--chart-1)"
                    : TONE_FILL[p.tone];
                  return (
                    <g key={it.key} {...itemProps(k)}>
                      {bubble ? (
                        // A 2px surface ring keeps overlapping bubbles apart; small ones are drawn last, on top.
                        <circle
                          cx={x}
                          cy={y}
                          r={Math.max(r, 0.5)}
                          fill={fill}
                          fillOpacity={0.7}
                          stroke="var(--chart-surface)"
                          strokeWidth={2}
                          data-mark="bubble"
                          data-value={p.value}
                        />
                      ) : (
                        <>
                          <circle cx={x} cy={y} r={6} fill="var(--chart-surface)" />
                          <circle cx={x} cy={y} r={4} fill={fill} data-mark="dot" />
                        </>
                      )}
                      {/* A hit target of about 24px around small marks. */}
                      <circle cx={x} cy={y} r={Math.max(r, 12)} fill="transparent" data-part="hit" />
                    </g>
                  );
                })}
                {model.hubs.map((_, i) => {
                  const k = hubItem.get(i);
                  if (k == null) return null;
                  const { x, y } = items[k].place!;
                  return (
                    <g key={`h${i}`} {...itemProps(k)}>
                      <circle cx={x} cy={y} r={HUB_R + 2} fill="var(--chart-surface)" />
                      <circle cx={x} cy={y} r={HUB_R} fill="var(--foreground)" data-mark="hub" />
                      <circle cx={x} cy={y} r={12} fill="transparent" data-part="hit" />
                    </g>
                  );
                })}
              </g>
              {tip && (
                <g aria-hidden pointerEvents="none" data-part="focus">
                  {tip.region ? (
                    <path
                      d={regionPaths[regionIndex.get(tip.region.id)!]}
                      fill="none"
                      stroke="var(--foreground)"
                      strokeWidth={2}
                      strokeLinejoin="round"
                    />
                  ) : tip.link != null ? (
                    <path
                      d={links[tip.link].d}
                      fill="none"
                      stroke="var(--foreground)"
                      strokeWidth={Math.max(2, links[tip.link].w)}
                      strokeLinecap="round"
                    />
                  ) : tip.cell != null && hex ? (
                    <path
                      d={hex.path}
                      transform={`translate(${hex.cells[tip.cell].x.toFixed(1)},${hex.cells[tip.cell].y.toFixed(1)})`}
                      fill="none"
                      stroke="var(--foreground)"
                      strokeWidth={2}
                    />
                  ) : (
                    <circle
                      cx={tip.place!.x}
                      cy={tip.place!.y}
                      r={Math.max(tip.place!.r, 4) + 2}
                      fill="none"
                      stroke="var(--foreground)"
                      strokeWidth={2}
                    />
                  )}
                </g>
              )}
              <g aria-hidden data-part="labels" pointerEvents="none">
                {labels.map((l) => {
                  const it = items.find((x) => x.key === l.key);
                  const row = it?.region && choropleth ? joined.rows.get(it.region.id) : undefined;
                  const f = row ? fillFor(row.value, scale, domain) : null;
                  const cellFill = it?.cell != null && hex ? colorOf(scale, domain, hex.cells[it.cell].value, true) : null;
                  const on = f?.kind === "bin" ? f.color : cellFill;
                  const color = on ? textOn(on) : "var(--foreground)";
                  // On a filled region the text takes the side of the fill that reads; a halo would only muddy it.
                  const halo = on ? {} : HALO;
                  return (
                    <text
                      key={l.key}
                      x={l.x}
                      y={l.y}
                      textAnchor={l.anchor}
                      dominantBaseline="central"
                      fill={color}
                      {...halo}
                      data-part="label"
                      data-key={l.key}
                    >
                      {l.text}
                    </text>
                  );
                })}
              </g>
              {empty && (
                <text
                  x={width / 2}
                  y={height / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="fill-muted-foreground"
                  {...HALO}
                  data-part="empty"
                >
                  No data to show
                </text>
              )}
            </svg>
            {tip && (
              <VizTooltip id={tipId} anchor={tip.anchor} box={{ w: width, h: height }}>
                <div className="font-medium">{tip.name}</div>
                {tip.lines.map((l, i) => (
                  <div
                    key={i}
                    className={cn(i === 0 && kind !== "outline" ? "font-mono font-medium text-foreground tabular-nums" : "text-muted-foreground")}
                  >
                    {l}
                  </div>
                ))}
              </VizTooltip>
            )}
          </div>
          <MapLegend
            model={model}
            scale={scale}
            domain={domain}
            fenced={fenced}
            fmt={scaleFmt}
            hatch={hatched ? hatchLabel : undefined}
            land={asLand ? landLabel : undefined}
            landOutline={outlineLand}
            tones={tones}
            radius={radius}
            maxValue={maxValue}
            valueFmt={fmt}
            negative={negative}
            credit={CREDIT[geo.set]}
            linkWidths={valued ? { max: maxLink, width: widthOf } : null}
            cells={hex ? { cells: hex.cells.length, points: model.hexPoints.length - hex.dropped } : null}
          />
        </>
      ) : (
        <MapTable
          model={model}
          geo={geo}
          rows={joined.rows}
          highlights={joined.highlights}
          fmt={fmt}
          binText={binText}
          visible={visible}
          hubVisible={hubVisible}
          cells={hex?.cells ?? []}
          invert={proj.invert}
          title={title}
        />
      )}
      {joined.unknown.length > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {joined.unknown.length === 1 ? "1 row isn't" : `${joined.unknown.length} rows aren't`} in {REGION_NAME[geo.set]} and{" "}
          {joined.unknown.length === 1 ? "isn't" : "aren't"} shown: {joined.unknown.slice(0, 5).join(", ")}
          {joined.unknown.length > 5 ? "…" : ""}
        </p>
      )}
    </div>
  );
}

/** Every place's box, padded (the "show all" view). */
function boxOfAll(points: LonLat[]): [number, number, number, number] {
  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  const [w, e] = [Math.min(...lons), Math.max(...lons)];
  const [s, n] = [Math.min(...lats), Math.max(...lats)];
  const pad = (lo: number, hi: number) => Math.max(1.5, (hi - lo) * 0.1);
  return [Math.max(-180, w - pad(w, e)), Math.max(-85, s - pad(s, n)), Math.min(180, e + pad(w, e)), Math.min(85, n + pad(s, n))];
}

/** The map in a sentence, for the SVG's <desc>: what it shows, its range, what has no data, what is off the view. */
function summaryOf(
  model: MapModel,
  rows: Map<string, Datum>,
  values: number[],
  fmt: (v: unknown) => string,
  outside: number,
  negative: number,
  cells: number,
  absent: number,
  missing: "hatch" | "land",
): string {
  const parts: string[] = [];
  if (model.kind === "choropleth") {
    parts.push(`${rows.size} regions coloured by value`);
    if (values.length) parts.push(`from ${fmt(Math.min(...values))} to ${fmt(Math.max(...values))}`);
    const nulls = [...rows.values()].filter((d) => d.value == null).length;
    if (nulls) parts.push(`${nulls} without data`);
    if (absent && missing === "land") parts.push(`${absent} other regions drawn as plain land`);
  } else if (model.kind === "bubble") {
    parts.push(`${model.points.length} places sized by value`);
    if (negative) parts.push(`${negative} negative ${negative === 1 ? "value" : "values"} not drawn`);
  } else if (model.kind === "connection") {
    parts.push(`${model.links.length} ${model.directed ? "directed " : ""}links between ${model.hubs.length} places`);
  } else if (model.kind === "hexbin") {
    const what = model.aggregate === "count" ? "how many points fall in each" : `the ${model.aggregate} of the points' weights in each`;
    parts.push(`${model.hexPoints.length} points binned into ${cells} hexagons, coloured by ${what}`);
  } else parts.push(`${model.highlight.length} highlighted regions and ${model.points.length} places`);
  if (outside) parts.push(`${outside} outside the view`);
  return parts.join(", ") + ". The table view lists every value.";
}

/** Link widths: three round values drawn at their stroke width, with the unit. */
function WidthLegend({
  max,
  width,
  fmt,
  title,
  directed,
}: {
  max: number;
  width: (v: number) => number;
  fmt: (v: unknown) => string;
  title?: string;
  directed: boolean;
}) {
  const values = sizeLegendValues(max).reverse();
  return (
    <div role="group" aria-label="Line width scale" className="flex flex-col gap-1 text-xs text-muted-foreground" data-part="width-legend">
      {title && <div className="font-medium text-foreground">{title}</div>}
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {values.map((v) => (
          <li key={v} className="flex items-center gap-1.5">
            <svg width={28} height={12} aria-hidden>
              <line x1={2} x2={26} y1={6} y2={6} stroke="var(--chart-1)" strokeOpacity={0.75} strokeWidth={width(v)} strokeLinecap="round" />
            </svg>
            <span className="tabular-nums">{fmt(v)}</span>
          </li>
        ))}
        {directed && <li className="text-2xs">Arrows point from origin to destination</li>}
      </ul>
    </div>
  );
}

function MapLegend(props: {
  model: MapModel;
  scale: Scale;
  domain: [number, number];
  fenced: { clipped: boolean; below: boolean; above: boolean };
  fmt: (v: unknown) => string;
  valueFmt: (v: unknown) => string;
  hatch?: string;
  land?: string;
  landOutline: boolean;
  tones: Map<Tone, number>;
  radius: (v: number) => number;
  maxValue: number;
  negative: number;
  credit: string;
  linkWidths: { max: number; width: (v: number) => number } | null;
  cells: { cells: number; points: number } | null;
}) {
  const { model, scale, domain, fenced, fmt, valueFmt, hatch, land, landOutline, tones, radius, maxValue, negative, credit, linkWidths, cells } =
    props;
  const unit = model.scale?.unit ?? model.unit;
  const show = model.legend.show;
  const parts: ReactNode[] = [];
  // Only the side that was cut: "clipped at 0" when nothing lies below 0 says something false.
  const ends = [fenced.below ? fmt(tidy(domain[0])) : "", fenced.above ? fmt(tidy(domain[1])) : ""].filter(Boolean);
  const clippedNote = fenced.clipped
    ? `Scale clipped at ${ends.join(" and ")} so outliers don't wash out the rest; the end ${ends.length === 1 ? "class holds" : "classes hold"} everything past ${ends.length === 1 ? "it" : "them"}.`
    : undefined;
  if (show && model.kind === "choropleth") {
    parts.push(
      <BinLegend
        key="bins"
        scale={scale}
        domain={domain}
        unit={unit}
        title={model.legend.title}
        open={fenced}
        noData={hatch}
        land={land}
        landOutline={landOutline}
        footer={clippedNote}
      />,
    );
  }
  if (show && model.kind === "hexbin" && cells) {
    const what = model.aggregate === "count" ? "Points per cell" : model.aggregate === "sum" ? "Sum per cell" : "Mean per cell";
    const footer = [
      `${cells.points} ${cells.points === 1 ? "point" : "points"} in ${cells.cells} ${cells.cells === 1 ? "cell" : "cells"}, each ${model.radius * 2} px across; cells are redrawn when the map's size changes.`,
      clippedNote,
    ]
      .filter(Boolean)
      .join(" ");
    parts.push(
      <BinLegend key="cells" scale={scale} domain={domain} unit={unit} title={model.legend.title ?? what} open={fenced} marks footer={footer} />,
    );
  }
  if (show && model.kind === "connection" && linkWidths && linkWidths.max > 0) {
    parts.push(
      <WidthLegend
        key="width"
        max={linkWidths.max}
        width={linkWidths.width}
        fmt={valueFmt}
        title={model.legend.title ?? (model.unit ? `Width: ${model.unit.trim()}` : undefined)}
        directed={model.directed}
      />,
    );
  } else if (show && model.kind === "connection" && model.directed) {
    parts.push(
      <div key="dir" className="text-2xs text-muted-foreground">
        Arrows point from origin to destination
      </div>,
    );
  }
  if (show && model.kind === "bubble") {
    parts.push(
      <SizeLegend
        key="size"
        values={sizeLegendValues(maxValue)}
        radius={radius}
        fmt={(v) => valueFmt(v)}
        title={model.legend.title ?? (model.unit ? `Size: ${model.unit.trim()}` : undefined)}
      />,
    );
    if (model.scale && model.points.some((p) => p.shade != null))
      parts.push(<BinLegend key="shade" scale={scale} domain={domain} unit={unit} marks open={fenced} />);
  }
  if (show && model.kind === "outline" && [...tones.keys()].some((t) => t !== "default")) {
    parts.push(
      <Legend key="tones">
        {[...tones].map(([t, n]) => (
          <LegendItem
            key={t}
            swatch={<SquareSwatch fill={TONE_FILL[t]} />}
            label={t === "default" ? "Marked" : TONE_WORD[t][0].toUpperCase() + TONE_WORD[t].slice(1)}
            extra={<span className="tabular-nums">({n})</span>}
          />
        ))}
      </Legend>,
    );
  }
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2" data-part="legend">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">{parts}</div>
      <div className="text-2xs text-muted-foreground">
        {negative > 0 && <span>{negative === 1 ? "1 negative value" : `${negative} negative values`} not drawn · </span>}
        Data: {credit}
      </div>
    </div>
  );
}

function MapTable(props: {
  model: MapModel;
  geo: RegionGeo;
  rows: Map<string, Datum>;
  highlights: Map<string, Highlight>;
  fmt: (v: unknown) => string;
  binText: (v: number) => string;
  visible: boolean[];
  hubVisible: boolean[];
  cells: Cell[];
  invert: (x: number, y: number) => [number, number] | null;
  title: string;
}) {
  const { model, geo, rows, highlights, fmt, binText, visible, hubVisible, cells, invert, title } = props;
  const name = (id: string) => geo.byId.get(id)?.name ?? id;
  if (model.kind === "choropleth") {
    const sorted = [...rows].sort(([, a], [, b]) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    const columns: Column[] = [
      { key: "region", label: "Region" },
      { key: "value", label: "Value", numeric: true },
      { key: "class", label: "Class" },
      { key: "detail", label: "Detail" },
    ];
    const missing = geo.regions.length - rows.size;
    return (
      <VizTable
        caption={`${title}. ${rows.size} rows${missing > 0 ? `; ${missing} regions of ${REGION_NAME[geo.set]} have no row` : ""}.`}
        columns={columns}
        rows={sorted.map(([id, d]) => ({
          region: d.label ?? name(id),
          value: d.value == null ? model.noDataLabel : fmt(d.value),
          class: d.value == null ? "" : binText(d.value),
          detail: d.detail ?? "",
        }))}
      />
    );
  }
  if (model.kind === "connection") {
    const hub = new Map(model.hubs.map((h, i) => [h.id, { h, seen: hubVisible[i] }]));
    const label = (id: string) => {
      const x = hub.get(id);
      return x ? `${x.h.label}${x.seen ? "" : " (outside view)"}` : id;
    };
    const order = linkOrder(model.links);
    const columns: Column[] = [
      { key: "from", label: model.directed ? "From" : "Between" },
      { key: "to", label: model.directed ? "To" : "And" },
      { key: "value", label: "Value", numeric: true },
      { key: "detail", label: "Detail" },
    ];
    return (
      <VizTable
        caption={`${title}. ${model.links.length} links between ${model.hubs.length} places.`}
        columns={columns}
        rows={order.map((i) => {
          const l = model.links[i];
          return {
            from: label(l.from),
            to: label(l.to),
            value: l.value == null ? "" : fmt(l.value),
            detail: [l.label, l.detail].filter(Boolean).join(" · "),
          };
        })}
      />
    );
  }
  if (model.kind === "hexbin") {
    const sorted = cells
      .map((c, i) => [c, i] as const)
      .sort(([a], [b]) => b.value - a.value)
      .slice(0, HEX_TABLE_ROWS);
    const columns: Column[] = [
      { key: "centre", label: "Cell centre" },
      { key: "value", label: model.aggregate === "count" ? "Points" : model.aggregate === "sum" ? "Sum" : "Mean", numeric: true },
      { key: "class", label: "Class" },
      { key: "n", label: "Points in it", numeric: true },
    ];
    return (
      <VizTable
        caption={`${title}. The ${sorted.length} fullest of ${cells.length} cells, ${model.radius * 2} px across at this size; resizing the map redraws them.`}
        columns={columns}
        rows={sorted.map(([c]) => {
          const ll = invert(c.x, c.y);
          return { centre: ll ? latLon(ll[0], ll[1]) : "", value: fmt(tidy(c.value)), class: binText(c.value), n: String(c.n) };
        })}
      />
    );
  }
  const columns: Column[] = [
    { key: "name", label: model.kind === "bubble" ? "Place" : "Region or place" },
    ...(model.kind === "bubble" ? [{ key: "value", label: "Value", numeric: true }] : [{ key: "status", label: "Status" }]),
    { key: "where", label: "Where" },
    { key: "detail", label: "Detail" },
  ];
  const regionRows = [...highlights].map(([id, h]) => ({
    name: h.label ?? name(id),
    status: TONE_WORD[h.tone] || "marked",
    where: id,
    detail: h.detail ?? "",
  }));
  const order = model.kind === "bubble" ? bubbleOrder(model.points).order : model.points.map((_, i) => i);
  const placeRows = order.map((i) => {
    const p: Place = model.points[i];
    const where = `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}${visible[i] ? "" : " (outside view)"}`;
    return { name: p.label || `Place ${i + 1}`, value: fmt(p.value), status: TONE_WORD[p.tone] || "", where, detail: p.detail ?? "" };
  });
  return <VizTable caption={title} columns={columns} rows={[...regionRows, ...placeRows]} />;
}
