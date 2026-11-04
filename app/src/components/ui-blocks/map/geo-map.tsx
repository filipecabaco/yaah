// `map` kinds `outline`, `choropleth` and `bubble`: React-drawn SVG over d3-geo and the bundled
// atlases (map/geo.ts), on the shared figure core (viz/). No tiles, no Leaflet, nothing fetched:
// they work offline and take every colour from theme tokens (--map-* in index.css, the --scale-*
// ramps, --chart-*). Visible labels for small counts; hover and keyboard focus show the same
// tooltip; every region or place is also in its accessible name and in the table view.
// docs/research/map-types.md.
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Feature, Geometry, Polygon } from "geojson";
import { formatter } from "@/components/ui-blocks/chart-model";
import { useChartFont } from "@/components/ui-blocks/chart-font";
import { binColors, binRange, colorOf, fencedDomain, forMarks, type Scale } from "@/components/ui-blocks/scale";
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
  tidy,
  tokenName,
  useResolvedTokens,
  useRoving,
  useSize,
  type Column,
  type Tone,
} from "@/components/ui-blocks/viz";
import { ErrorText } from "@/components/error-text";
import { REGION_NAME, resolveId, useRegion, type Region, type RegionGeo } from "@/components/ui-blocks/map/geo";
import { fitProjection, inBox, percentileView, type FitTarget } from "@/components/ui-blocks/map/projection";
import {
  ALWAYS_LABEL,
  CAPS,
  DEFAULT_SCALE,
  bubbleOrder,
  bubbleRadius,
  defaultMaxRadius,
  fillFor,
  labelled,
  readMapModel,
  type Datum,
  type Highlight,
  type MapModel,
  type Place,
} from "@/components/ui-blocks/map/model";
import { placePointLabels, placeRegionLabels, type PlacedLabel } from "@/components/ui-blocks/map/labels";
import { growAttr, growClass, useUiView } from "@/components/ui-view";
import { keepLinksOutside } from "@/components/ui-blocks/links";
import type { Obj } from "@/lib/narrow";
import { cn } from "@/lib/utils";

const VIEWS = ["map", "table"] as const;
const CREDIT: Record<RegionGeo["set"], string> = { world: "Natural Earth", europe: "Natural Earth", "us-states": "US Census Bureau" };
/** A halo in the surface colour under text that sits on the map. */
const HALO = { stroke: "var(--chart-surface)", strokeWidth: 3, strokeLinejoin: "round", paintOrder: "stroke" } as const;

export default function UiGeoMap(props: { props: Obj }) {
  // By value: a re-render with the same props is no change (the tree hands over a new object each time).
  const key = JSON.stringify(props.props);
  const model = useMemo(() => readMapModel(JSON.parse(key) as Obj), [key]);
  const geo = useRegion(model.region);
  if (geo instanceof Error) return <ErrorText error={geo} prefix={`Couldn't load the map of ${REGION_NAME[model.region]}: `} />;
  if (!geo) return <div className="animate-pulse rounded-md bg-muted" style={{ height: model.height + 32 }} aria-busy="true" />;
  return <GeoMap model={model} geo={geo} />;
}

/** One thing on the map that takes focus: a region with a row, a highlighted region, or a place. */
type Item = {
  key: string;
  name: string;
  /** The tooltip and table lines after the name, and the accessible name. */
  lines: string[];
  aria: string;
  anchor: { x: number; y: number };
  region?: Region;
  place?: { x: number; y: number; r: number };
};

/** The centre and box of a region's largest part, in pixels (where its label goes). */
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
  return { at: { x: cx, y: cy }, box: { w: x1 - x0, h: y1 - y0 } };
}

function GeoMap({ model, geo }: { model: MapModel; geo: RegionGeo }) {
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
  const choropleth = model.kind === "choropleth";
  const bubble = model.kind === "bubble";

  // ── data, joined to the geometry by canonical id ──
  const joined = useMemo(() => {
    const rows = new Map<string, Datum>();
    const highlights = new Map<string, Highlight>();
    const unknown: string[] = [];
    for (const d of model.data) {
      const id = resolveId(geo, d.id);
      if (id) rows.set(id, d);
      else unknown.push(String(d.id));
    }
    for (const h of model.highlight) {
      const id = resolveId(geo, h.id);
      if (id) highlights.set(id, h);
      else unknown.push(String(h.id));
    }
    return { rows, highlights, unknown };
  }, [model, geo]);

  const scale: Scale = choropleth ? (model.scale ?? DEFAULT_SCALE) : model.scale && bubble ? forMarks(model.scale) : DEFAULT_SCALE;
  const values = choropleth
    ? [...joined.rows.values()].flatMap((d) => (d.value == null ? [] : [d.value]))
    : model.points.flatMap((p) => (p.shade == null ? [] : [p.shade]));
  const fenced = fencedDomain(scale, values);
  const domain = fenced.domain;

  // ── projection, fitted to the box ──
  const pv = useMemo(() => (bubble ? percentileView(model.points) : null), [bubble, model.points]);
  const target: FitTarget =
    model.view !== "auto"
      ? { kind: "bbox", bbox: model.view }
      : bubble && pv
        ? { kind: "bbox", bbox: fitAll && pv.outside.length ? boxOfAll(model.points) : pv.bbox }
        : { kind: "frame" };
  const targetKey = JSON.stringify(target);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- by value: targetKey stands for target
  const proj = useMemo(() => fitProjection(geo, target, width, height), [geo, targetKey, width, height]);
  const regionPaths = useMemo(() => geo.regions.map((r) => proj.path(r.feature) ?? ""), [geo, proj]);
  const landPaths = useMemo(() => geo.land.map((f) => proj.path(f) ?? ""), [geo, proj]);
  const borders = useMemo(() => (model.borders ? (proj.path(geo.borders) ?? "") : ""), [geo, proj, model.borders]);
  const sphere = useMemo(
    () => (geo.set === "world" && model.view === "auto" && !bubble ? (proj.path({ type: "Sphere" }) ?? "") : ""),
    [geo, proj, model.view, bubble],
  );

  // ── places ──
  const maxR = model.maxRadius ?? defaultMaxRadius(width, height);
  const maxValue = Math.max(0, ...model.points.map((p) => p.value));
  const radius = useMemo(() => bubbleRadius(maxValue, maxR), [maxValue, maxR]);
  const { order: drawOrder, negative } = bubble ? bubbleOrder(model.points) : { order: model.points.map((_, i) => i), negative: 0 };
  const projected = model.points.map((p) => proj.point(p.lon, p.lat));
  const visible = projected.map((p) => inBox(p, width, height));
  const outside = model.points.filter((_, i) => !visible[i]).length;

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
      const r = geo.byId.get(id)!;
      const name = d.label ?? r.name;
      const lines = [
        d.value == null ? model.noDataLabel : fmt(d.value),
        ...(d.value == null ? [] : [binText(d.value)]),
        ...(d.detail ? [d.detail] : []),
      ];
      items.push({ key: id, name, lines, aria: `${name}, ${lines.join(", ")}`, anchor: regionAnchor(r), region: r });
    }
  if (model.kind === "outline")
    for (const [id, h] of joined.highlights) {
      const r = geo.byId.get(id)!;
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
    const cap = model.labels === "all" ? CAPS.labelsAll : Infinity;
    const regionItems = items.filter((it) => it.region);
    const few = regionItems.length <= ALWAYS_LABEL;
    const placeItems = items.filter((it) => it.place);
    const chosen = labelled(
      placeItems.map((it) => (bubble ? model.points[Number(it.key.slice(1))].value : 0)),
      model.labels,
    );
    const pointLabels = placePointLabels(
      placeItems.flatMap((it, j) => (chosen.has(j) ? [{ key: it.key, text: it.name, x: it.place!.x, y: it.place!.y, r: it.place!.r }] : [])),
      font,
      { width, height },
    );
    const regionLabels = placeRegionLabels(
      regionItems.map((it) => {
        const g = labelGeometry(it.region!.feature, proj.path);
        const short = geo.set === "us-states" ? it.region!.id : (it.region!.codes[0] ?? it.region!.id);
        // Countries by name where it fits; their code only when every region is labelled anyway.
        const texts = geo.set === "us-states" ? [short] : few || model.labels === "all" ? [it.name, short] : [it.name];
        return { key: it.key, texts, at: g.at, box: g.box, force: few || model.labels === "all" };
      }),
      font,
      { width, height },
      cap,
      // Places come first: their labels and dots are tied to a spot; a region's label can sit anywhere in it.
      [
        ...pointLabels.map((l) => l.rect),
        ...placeItems.map((it) => ({
          x0: it.place!.x - it.place!.r,
          y0: it.place!.y - it.place!.r,
          x1: it.place!.x + it.place!.r,
          y1: it.place!.y + it.place!.r,
        })),
      ],
    );
    return [...regionLabels, ...pointLabels];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- items are derived from these
  }, [model, geo, proj, font, width, height, radius]);

  // ── colours resolved, for label text over a filled region ──
  const colors = binColors(scale);
  const resolved = useResolvedTokens(rootRef, [...colors.map(tokenName), "--foreground", "--background"]);
  const textOn = (fill: string) => readableOn(resolved[tokenName(fill)], resolved["--foreground"], resolved["--background"]);

  const anyMissing = choropleth && (geo.regions.length > joined.rows.size || [...joined.rows.values()].some((d) => d.value == null));
  const empty = choropleth ? joined.rows.size === 0 : bubble ? model.points.length === 0 : false;
  const tones = new Map<Tone, number>();
  if (model.kind === "outline")
    for (const t of [...joined.highlights.values(), ...model.points].map((x) => x.tone)) tones.set(t, (tones.get(t) ?? 0) + 1);

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
  const summary = summaryOf(model, joined.rows, values, fmt, outside, negative);

  return (
    <div ref={rootRef} className="ui-map flex min-w-0 flex-col gap-2" data-map-kind={model.kind} data-set={geo.set} onClickCapture={keepLinksOutside}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {outside > 0 && (
          <button
            type="button"
            className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
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
            className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
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
                  if (choropleth) {
                    const f = fillFor(row?.value, scale, domain);
                    fill = f.kind === "bin" ? f.color : `url(#${uid}-hatch)`;
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
                      data-fill={choropleth ? (row?.value == null ? "none" : "bin") : hl ? hl.tone : "land"}
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
                        <circle
                          cx={x}
                          cy={y}
                          r={Math.max(r, 0.5)}
                          fill={fill}
                          fillOpacity={0.55}
                          stroke="var(--chart-surface)"
                          strokeWidth={1}
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
                  const color = f?.kind === "bin" ? textOn(f.color) : "var(--foreground)";
                  // On a filled region the text takes the side of the fill that reads; a halo would only muddy it.
                  const halo = f?.kind === "bin" ? {} : HALO;
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
                    className={cn(
                      i === 0 && model.kind !== "outline" ? "font-mono font-medium text-foreground tabular-nums" : "text-muted-foreground",
                    )}
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
            anyMissing={anyMissing}
            tones={tones}
            radius={radius}
            maxValue={maxValue}
            valueFmt={fmt}
            negative={negative}
            credit={CREDIT[geo.set]}
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
function boxOfAll(points: Place[]): [number, number, number, number] {
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
): string {
  const parts: string[] = [];
  if (model.kind === "choropleth") {
    parts.push(`${rows.size} regions coloured by value`);
    if (values.length) parts.push(`from ${fmt(Math.min(...values))} to ${fmt(Math.max(...values))}`);
    const missing = [...rows.values()].filter((d) => d.value == null).length;
    if (missing) parts.push(`${missing} without data`);
  } else if (model.kind === "bubble") {
    parts.push(`${model.points.length} places sized by value`);
    if (negative) parts.push(`${negative} negative ${negative === 1 ? "value" : "values"} not drawn`);
  } else parts.push(`${model.highlight.length} highlighted regions and ${model.points.length} places`);
  if (outside) parts.push(`${outside} outside the view`);
  return parts.join(", ") + ". The table view lists every value.";
}

function MapLegend(props: {
  model: MapModel;
  scale: Scale;
  domain: [number, number];
  fenced: { clipped: boolean; below: boolean; above: boolean };
  fmt: (v: unknown) => string;
  valueFmt: (v: unknown) => string;
  anyMissing: boolean;
  tones: Map<Tone, number>;
  radius: (v: number) => number;
  maxValue: number;
  negative: number;
  credit: string;
}) {
  const { model, scale, domain, fenced, fmt, valueFmt, anyMissing, tones, radius, maxValue, negative, credit } = props;
  const unit = model.scale?.unit ?? model.unit;
  const show = model.legend.show;
  const parts: ReactNode[] = [];
  if (show && model.kind === "choropleth") {
    const footer = fenced.clipped
      ? `Scale clipped at ${fmt(tidy(domain[0]))} and ${fmt(tidy(domain[1]))} so outliers don't wash out the rest; the end classes hold everything past them.`
      : undefined;
    parts.push(
      <BinLegend
        key="bins"
        scale={scale}
        domain={domain}
        unit={unit}
        title={model.legend.title}
        open={fenced}
        noData={anyMissing ? model.noDataLabel : undefined}
        footer={footer}
      />,
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
  title: string;
}) {
  const { model, geo, rows, highlights, fmt, binText, visible, title } = props;
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
    const p = model.points[i];
    const where = `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}${visible[i] ? "" : " (outside view)"}`;
    return { name: p.label || `Place ${i + 1}`, value: fmt(p.value), status: TONE_WORD[p.tone] || "", where, detail: p.detail ?? "" };
  });
  return <VizTable caption={title} columns={columns} rows={[...regionRows, ...placeRows]} />;
}
