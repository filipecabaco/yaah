// `chart` primitive: bar, line and area drawn by React as SVG on the shared figure core (viz/),
// with d3-scale and d3-shape only computing (scales, ticks, paths); the dumbbell is its own figure
// on the same core (dumbbell.tsx). Loaded on demand. Follows the dataviz rules whatever the agent
// sends: one value axis, categorical colours in fixed slot order (--chart-1…5, from the theme and
// validated, lib/chart-palette.ts), a legend for 2+ series, a tooltip on hover and on keyboard
// focus (a crosshair on lines and areas, the hovered category on bars), a table view, and the mark
// specs: solid hairline grid, bars at most 24px with a 4px rounded data-end and a 2px surface gap,
// 2px lines, a 10% wash under a single area and stronger fills with 2px seams for stacked bands,
// 8px dots with a 2px surface ring, no curve that can overshoot a stack, and text in text tokens at
// the interface's size, never in a series colour. Bars and stacks start at zero; lines fit their
// data (chart-model.ts valueAxis). Labels never sit on the data: end labels and reference labels
// share a gutter outside the plot and are dodged apart (chart-layout.ts).
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { scaleBand, scaleLinear, scalePoint } from "d3-scale";
import { ErrorText } from "@/components/error-text";
import { Dumbbell } from "@/components/ui-blocks/dumbbell";
import {
  X,
  fold,
  formatter,
  namedSeries,
  normalise,
  num,
  readKind,
  readLabels,
  readDomain,
  readOrientation,
  readRefs,
  readSort,
  signed,
  sortRows,
  valueAxis,
  type Kind,
  type Labels,
  type Point,
  type Ref,
  type Series,
} from "@/components/ui-blocks/chart-model";
import { readScale } from "@/components/ui-blocks/scale";
import { needsLegend } from "@/components/ui-blocks/chart-layout";
import { areaPath, barPath, linePath, stackEnds, stackRows, thinTicks, type Curve, type End } from "@/components/ui-blocks/chart-geometry";
import { useChartFont } from "@/components/ui-blocks/chart-font";
import { show } from "@/lib/narrow";
import { growAttr, growClass, useUiView } from "@/components/ui-view";
import { cn } from "@/lib/utils";
import {
  Grid,
  Legend,
  LegendItem,
  SquareSwatch,
  ViewToggle,
  VizTable,
  VizTooltip,
  dodge,
  fitText,
  readableOn,
  seriesColor,
  textWidth,
  tokenName,
  useResolvedTokens,
  useRoving,
  useSize,
  type LabelItem,
} from "@/components/ui-blocks/viz";

const VIEWS = ["chart", "table"] as const;
/** Stacked bands: a fill strong enough to tell neighbours apart (index.css tunes it per mode). */
export const BAND_OPACITY = 0.45;
/** A single area: a wash, never a saturated block. */
export const WASH_OPACITY = 0.1;
/** Bars are at most this thick, however wide their slot: the leftover is air. */
export const BAR_MAX = 24;
/** The surface gap between touching marks: stacked segments, and the bars of a group. */
export const GAP = 2;
/** A legend row under the plot, inside the chart's height. */
const LEGEND_H = 24;

const textProps = (font: number, muted = false) => ({ fill: muted ? "var(--muted-foreground)" : "var(--foreground)", fontSize: font });
/** A halo in the surface colour under text that sits near marks or lines. */
const HALO = { stroke: "var(--chart-surface)", strokeWidth: 4, strokeLinejoin: "round", paintOrder: "stroke" } as const;
const SURFACE = "var(--chart-surface)";
const TOKENS = ["--foreground", "--background", "--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"] as const;

export default function UiChart(props: {
  kind: unknown;
  data: unknown;
  x: string;
  series: unknown;
  stacked?: boolean;
  unit?: string;
  height?: number;
  refs?: unknown;
  orientation?: unknown;
  labels?: unknown;
  sort?: unknown;
  scale?: unknown;
  zero?: unknown;
  domain?: unknown;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const kind = readKind(props.kind);
  // Bars and areas stack; a line never does (its values are levels, not parts).
  const stacked = !!props.stacked && (kind === "bar" || kind === "area");
  const given = namedSeries(props.series).length;
  const sort = readSort(props.sort, kind);
  const { data, series } = useMemo((): { data: Point[]; series: Series[] } => {
    const n = normalise(props.data, props.series, props.x);
    const f = kind === "dumbbell" ? n : fold(n.data, n.series, stacked);
    return { data: sortRows(f.data, f.series, sort, kind), series: f.series };
  }, [props.data, props.series, props.x, stacked, sort, kind]);
  const fmt = useMemo(() => formatter(props.unit), [props.unit]);
  const refs = useMemo(() => readRefs(props.refs), [props.refs]);
  const labels = readLabels(props.labels, kind);
  const orientation = readOrientation(props.orientation, kind, data);
  const scale = useMemo(() => readScale(props.scale), [props.scale]);
  const gapFmt = useMemo(() => signed(fmt), [fmt]);
  const domain = useMemo(() => readDomain(props.domain), [props.domain]);

  if (kind === "dumbbell" && given !== 2) {
    return <ErrorText error={`A dumbbell needs exactly 2 series (before and after, e.g. poll and result); this one has ${given}.`} />;
  }

  const gap = (r: Point) => (r[series[0]?.key] == null || r[series[1]?.key] == null ? null : num(r[series[1].key]) - num(r[series[0].key]));

  return (
    <div className="ui-chart flex min-w-0 flex-col gap-1" data-chart-kind={kind} data-orientation={orientation}>
      <ViewToggle value={view} onChange={setView} views={VIEWS} />
      {view === "chart" ? (
        kind === "dumbbell" ? (
          <Dumbbell
            data={data}
            series={series}
            refs={refs}
            labels={labels}
            orientation={orientation}
            scale={scale}
            fmt={fmt}
            xName={props.x}
            height={props.height}
          />
        ) : (
          <Cartesian
            kind={kind}
            data={data}
            series={series}
            stacked={stacked}
            refs={refs}
            labels={labels}
            horizontal={orientation === "horizontal"}
            fmt={fmt}
            xName={props.x}
            height={props.height || 240}
            zero={props.zero === true}
            domain={domain}
          />
        )
      ) : (
        <VizTable
          columns={[
            { key: X, label: props.x },
            ...series.map((s) => ({ key: s.key, label: s.label, numeric: true })),
            ...(kind === "dumbbell" ? [{ key: "gap", label: "Gap", numeric: true }] : []),
          ]}
          rows={data.map((row) => ({
            [X]: row[X],
            ...Object.fromEntries(series.map((s) => [s.key, fmt(row[s.key])])),
            gap: gap(row) == null ? "–" : gapFmt(gap(row)!),
          }))}
        />
      )}
    </div>
  );
}

/** Axis tick labels: one line each, in the muted text token; cut to `chars` with the full text in a <title>. */
function Ticks(props: {
  axis: "value" | "category";
  items: { key: string | number; at: number; text: string }[];
  side: "left" | "bottom";
  offset: number;
  font: number;
  chars?: number;
}) {
  const { side, offset, font, chars = Infinity } = props;
  return (
    <g aria-hidden data-part="axis" data-axis={props.axis}>
      {props.items.map((t) => {
        const text = fitText(t.text, chars);
        return (
          <text
            key={t.key}
            x={side === "left" ? offset : t.at}
            y={side === "left" ? t.at : offset}
            dy={side === "bottom" ? "0.71em" : undefined}
            dominantBaseline={side === "left" ? "middle" : undefined}
            textAnchor={side === "left" ? "end" : "middle"}
            {...textProps(font, true)}
            className="tabular-nums"
            data-part="tick"
          >
            {text !== t.text && <title>{t.text}</title>}
            {text}
          </text>
        );
      })}
    </g>
  );
}

/** The legend's key: a square for bars and areas, a short line for lines (the key mirrors the mark). */
function Key({ kind, color }: { kind: Kind; color: string }) {
  if (kind !== "line") return <SquareSwatch fill={color} />;
  return <span aria-hidden className="h-0.5 w-3 shrink-0 rounded" style={{ background: color }} data-part="line-key" />;
}

type Side = { key: string; text: string; at: number; x: number; ref: boolean };

/** Bar, line and area on one value axis, any of them stacked or (bars) lying on their side. */
function Cartesian(props: {
  kind: Kind;
  data: Point[];
  series: Series[];
  stacked: boolean;
  refs: Ref[];
  labels: Labels;
  horizontal: boolean;
  fmt: (v: unknown) => string;
  xName: string;
  height: number;
  zero: boolean;
  domain?: [number, number];
}) {
  const { kind, data, series, stacked, refs, labels, horizontal, fmt } = props;
  const font = useChartFont();
  const tipId = useId();
  const root = useRef<HTMLDivElement>(null);
  const resolved = useResolvedTokens(root, TOKENS);
  const { expanded } = useUiView();
  const n = data.length;
  const last = data[n - 1];
  const colors = series.map((_, i) => seriesColor(i));
  const isBar = kind === "bar";

  // ── what the gutters must hold ──
  const ends = labels === "ends" && !isBar && n > 0;
  const sideRefs = refs.filter((r) => r.label && (r.axis === "y") !== horizontal);
  const topRefs = refs.some((r) => r.label && (r.axis === "y") === horizontal);
  const sideText = [
    ...(ends ? series.filter((s) => last[s.key] != null).map((s) => (series.length > 1 ? `${s.label} ` : "") + fmt(num(last[s.key]))) : []),
    ...sideRefs.map((r) => r.label!),
  ];
  const sideRoom = sideText.length ? Math.min(200, 22 + Math.max(...sideText.map((t) => textWidth(t, font)))) : 0;

  // ── size ──
  const legendGuess = series.length >= 2;
  const inline = Math.max(120, props.height - (legendGuess ? LEGEND_H : 0));
  const { ref, width, height: measured } = useSize({ width: 640, height: inline });
  const height = expanded ? Math.max(inline, measured) : inline;

  const axis = useMemo(
    () =>
      valueAxis({
        kind,
        stacked,
        data,
        series,
        refs,
        zero: props.zero,
        domain: props.domain,
        // About one tick per 60px of the chart's height (the dialog's height when expanded).
        ticks: horizontal ? 5 : Math.max(3, Math.min(expanded ? 10 : 6, Math.round((expanded ? height : props.height) / 60))),
      }),
    [kind, stacked, data, series, refs, props.zero, props.domain, horizontal, height, expanded, props.height],
  );
  const valueW = Math.min(120, 14 + Math.max(...axis.ticks.map((t) => textWidth(fmt(t), font)), textWidth("0", font)));
  const catW = Math.min(160, Math.max(40, 12 + Math.max(0, ...data.map((r) => textWidth(String(r[X]), font)))));
  const catChars = Math.floor((catW - 12) / (font * 0.62));
  const tipRoom = isBar && labels !== "none" && horizontal ? 12 + textWidth(fmt(axis.domain[1]), font) : 0;
  // The category (or, on its side, value) labels, 14px under the plot.
  const AXIS_GAP = 14;
  const axisRow = Math.ceil(font * 1.2) + AXIS_GAP + 2;
  const plot = (() => {
    const left = horizontal ? catW : valueW;
    const right = Math.max(12, sideRoom, tipRoom);
    const top = 12 + (topRefs ? font + 8 : 0) + (isBar && !horizontal && labels !== "none" ? font : 0);
    return { x: left, y: top, w: Math.max(10, width - left - right), h: Math.max(10, height - top - axisRow) };
  })();
  const right = plot.x + plot.w;
  const bottom = plot.y + plot.h;

  // ── scales: d3 computes, React draws ──
  const v = scaleLinear()
    .domain(axis.domain)
    .range(horizontal ? [plot.x, right] : [bottom, plot.y]);
  const idx = data.map((_, i) => i);
  const band = scaleBand<number>()
    .domain(idx)
    .range(horizontal ? [plot.y, bottom] : [plot.x, right]);
  const point = scalePoint<number>().domain(idx).range([plot.x, right]).padding(0);
  const bandW = band.bandwidth();
  const catAt = (i: number) => (isBar ? (band(i) ?? 0) + bandW / 2 : n === 1 ? plot.x + plot.w / 2 : (point(i) ?? plot.x));
  const step = isBar ? bandW : n > 1 ? plot.w / (n - 1) : plot.w;
  const catIndex = (value: number | string) => data.findIndex((r) => r[X] === show(value));

  const stack = useMemo(() => stackRows(data, series, stacked), [data, series, stacked]);
  const outer = useMemo(() => stackEnds(data, series), [data, series]);
  const signedData = data.some((r) => series.some((s) => num(r[s.key]) < 0));
  // A single unstacked series may curve (monotone can't overshoot a point); several, or a stack, are straight.
  const curve: Curve = !stacked && series.length === 1 ? "monotone" : "linear";

  // ── bars ──
  const groups = stacked ? 1 : Math.max(1, series.length);
  const slot = bandW * 0.8;
  const barW = Math.max(1, Math.min(BAR_MAX, (slot - GAP * (groups - 1)) / groups));
  const groupW = barW * groups + GAP * (groups - 1);
  type Bar = { key: string; row: number; s: number; d: string; value: number; box: { x: number; y: number; w: number; h: number } };
  const bars: Bar[] = [];
  if (isBar) {
    data.forEach((r, i) => {
      const start = (band(i) ?? 0) + (bandW - groupW) / 2;
      series.forEach((s, k) => {
        const raw = r[s.key];
        if (typeof raw !== "number" || raw === 0) return;
        const { lo, hi } = stack[i][k];
        // The 2px surface gap: a segment gives 1px at each seam it shares (never at the baseline or its outer end).
        const isEnd = !stacked || (raw > 0 ? outer[i].up === k : outer[i].down === k);
        const pa = v(lo);
        const pb = v(hi);
        const span = Math.abs(pb - pa);
        const seamLo = stacked && (raw > 0 ? lo !== 0 : !isEnd);
        const seamHi = stacked && (raw > 0 ? !isEnd : hi !== 0);
        const inset = (side: boolean) => (side ? Math.min(GAP / 2, span / 4) : 0);
        const along = start + (stacked ? 0 : k * (barW + GAP));
        let box;
        if (horizontal) {
          const x0 = Math.min(pa, pb) + inset(seamLo);
          const x1 = Math.max(pa, pb) - inset(seamHi);
          box = { x: x0, y: along, w: Math.max(0, x1 - x0), h: barW };
        } else {
          // Value up is y down: lo is the lower edge (bigger y).
          const y1 = pa - inset(seamLo);
          const y0 = pb + inset(seamHi);
          box = { x: along, y: y0, w: barW, h: Math.max(0, y1 - y0) };
        }
        const end: End = !isEnd ? null : horizontal ? (raw > 0 ? "right" : "left") : raw > 0 ? "top" : "bottom";
        bars.push({ key: `${i}-${k}`, row: i, s: k, d: barPath(box, end), value: raw, box });
      });
    });
  }

  // ── lines and areas ──
  const xs = idx.map(catAt);
  const baseline = v(Math.min(Math.max(0, axis.domain[0]), axis.domain[1]));
  const paths = !isBar
    ? series.map((s, k) => {
        const vals = data.map((r) => r[s.key]);
        if (kind === "area" && stacked) {
          const top = stack.map((row, i) => v(num(vals[i]) < 0 ? row[k].lo : row[k].hi));
          const bot = stack.map((row, i) => v(num(vals[i]) < 0 ? row[k].hi : row[k].lo));
          return {
            area: areaPath(xs, top, bot, curve),
            line: linePath(
              top.map((y, i) => ({ x: xs[i], y })),
              curve,
            ),
            tops: top,
          };
        }
        const tops = vals.map((x) => (typeof x === "number" ? v(x) : null));
        return {
          area:
            kind === "area"
              ? areaPath(
                  xs,
                  tops,
                  xs.map(() => baseline),
                  curve,
                )
              : "",
          line: linePath(
            tops.map((y, i) => (y == null ? null : { x: xs[i], y })),
            curve,
          ),
          tops,
        };
      })
    : [];

  // ── the side gutter: end labels and the labels of refs that run across it, dodged together ──
  const refAt = (r: Ref) => {
    if (r.axis === "y") return typeof r.value === "number" ? v(r.value) : null;
    const i = catIndex(r.value);
    return i < 0 ? null : catAt(i);
  };
  const side: Side[] = [];
  if (ends) {
    for (const [k, s] of series.entries()) {
      const raw = last[s.key];
      if (raw == null) continue;
      const val = num(raw);
      const seg = stack[n - 1][k];
      const at = stacked ? v((seg.lo + seg.hi) / 2) : v(val);
      side.push({ key: s.key, at, text: series.length > 1 ? `${s.label} ${fmt(val)}` : fmt(val), x: xs[n - 1], ref: false });
    }
  }
  refs.forEach((r, i) => {
    if (!r.label || (r.axis === "y") === horizontal) return;
    const at = refAt(r);
    if (at != null) side.push({ key: `ref-${i}`, at, text: r.label, x: right, ref: true });
  });
  const size = font + 3;
  const { placed, dropped } = dodge(
    side.map((it) => ({ key: it.key, at: it.at, size, priority: it.ref ? 1 : 0 })),
    { min: Math.max(0, plot.y - 10), max: bottom + 4, pad: 2, maxShift: size * 3 },
  );
  const lost = dropped.filter((k) => !k.startsWith("ref-")).length;
  const gx = right + 10;
  const sideChars = Math.max(4, Math.floor((sideRoom - 12) / (font * 0.62)));
  const sideAt = new Map(placed.map((p) => [p.key, p]));

  // The labels of refs that cross the category axis's direction, in a gutter above the plot, dodged sideways.
  const tops: (LabelItem & { text: string })[] = [];
  refs.forEach((r, i) => {
    if (!r.label || (r.axis === "y") !== horizontal) return;
    const at = refAt(r);
    if (at != null) tops.push({ key: `ref-${i}`, at, size: textWidth(r.label, font), text: r.label });
  });
  const topPlaced = dodge(tops, { min: 2, max: width - 2, pad: 8 }).placed;
  const topText = new Map(tops.map((t) => [t.key, t.text]));

  // ── focus and hover: one item per category ──
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const roving = useRoving(n);
  const on = active != null && active < n ? active : null;
  const describe = (i: number) => {
    const r = data[i];
    const parts = series.map((s) => `${s.label} ${r[s.key] == null ? "no value" : fmt(r[s.key])}`);
    if (stacked && isBar && series.length > 1) parts.push(`total ${fmt(series.reduce((t, s) => t + num(r[s.key]), 0))}`);
    return `${show(r[X])}: ${parts.join(", ")}`;
  };
  const hit = (i: number) => {
    const c = catAt(i);
    if (isBar && horizontal) return { x: 0, y: c - step / 2, w: right, h: step };
    if (isBar) return { x: c - step / 2, y: plot.y, w: step, h: plot.h };
    // A point's column, kept inside the plot: the first and last points sit on its edges.
    const x0 = Math.max(plot.x, c - step / 2);
    return { x: x0, y: plot.y, w: Math.min(right, c + step / 2) - x0, h: plot.h };
  };
  const anchor = (() => {
    if (on == null) return null;
    const c = catAt(on);
    const ext = series.flatMap((_, k) => {
      if (isBar) {
        const b = bars.filter((x) => x.row === on && x.s === k).map((x) => x.box);
        return b.map((x) => (horizontal ? x.x + x.w : x.y));
      }
      const y = paths[k]?.tops[on];
      return y == null ? [] : [y];
    });
    if (horizontal) return { x: ext.length ? Math.max(...ext) : plot.x, y: c };
    // Beside the columns, not over them: their value labels sit on the caps.
    return { x: isBar ? c + groupW / 2 + 4 : c, y: ext.length ? Math.min(...ext) : bottom };
  })();

  const legend = needsLegend(series.length, lost);
  const valueTicks = axis.ticks.map((t) => ({ key: t, at: v(t), text: fmt(t) }));
  const catTexts = data.map((r) => show(r[X]));
  const shownCats = isBar
    ? idx
    : thinTicks(
        xs,
        catTexts.map((t) => textWidth(t, font)),
        16,
      );
  const catTicks = shownCats.map((i) => ({ key: i, at: catAt(i), text: catTexts[i] }));
  const fg = resolved["--foreground"];
  const bg = resolved["--background"];
  const inside = (k: number) => readableOn(resolved[tokenName(colors[k])], fg, bg);
  const total = (i: number) => series.reduce((t, s) => t + num(data[i][s.key]), 0);
  const kindWord = kind === "bar" ? "Bar chart" : kind === "area" ? "Area chart" : "Line chart";

  const refLines = (
    <g data-part="refs" pointerEvents="none">
      {refs.map((r, i) => {
        const at = refAt(r);
        if (at == null) return null;
        // A value ref runs across the plot; a category ref along it.
        const across = (r.axis === "y") === !horizontal;
        return (
          <g key={i} className="ui-ref" data-part="ref">
            {across ? (
              <line x1={plot.x} x2={right} y1={at} y2={at} stroke="var(--muted-foreground)" strokeWidth={1} />
            ) : (
              <line x1={at} x2={at} y1={plot.y} y2={bottom} stroke="var(--muted-foreground)" strokeWidth={1} />
            )}
          </g>
        );
      })}
    </g>
  );

  let marks: ReactNode;
  if (isBar) {
    marks = (
      <g data-part="bars">
        {bars.map((b) => (
          <path key={b.key} d={b.d} fill={colors[b.s]} data-part="bar" data-series={series[b.s].key} data-index={b.row} />
        ))}
      </g>
    );
  } else {
    marks = (
      <g data-part="series">
        {series.map((s, k) => (
          <g key={s.key} data-series={s.key} className={kind === "area" && stacked ? "ui-band" : undefined}>
            {kind === "area" && (
              <path d={paths[k].area} fill={colors[k]} fillOpacity={stacked ? BAND_OPACITY : WASH_OPACITY} stroke="none" data-part="area" />
            )}
            <path
              d={paths[k].line}
              fill="none"
              // Stacked: the band's top edge is a 2px seam in the surface colour; otherwise the series line.
              stroke={kind === "area" && stacked ? SURFACE : colors[k]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              data-part="line"
            />
          </g>
        ))}
      </g>
    );
  }

  const dots =
    kind === "line" && n <= 12 ? (
      <g data-part="dots">
        {series.map((s, k) => (
          <g key={s.key} data-series={s.key}>
            {paths[k].tops.map((y, i) =>
              y == null ? null : (
                // 8px of colour inside a 2px ring of the surface (r 5, stroke 2 centred on the edge).
                <circle key={i} cx={xs[i]} cy={y} r={5} fill={colors[k]} stroke={SURFACE} strokeWidth={2} data-mark="dot" />
              ),
            )}
          </g>
        ))}
      </g>
    ) : null;

  const valueLabels: ReactNode[] = [];
  if (labels !== "none" && isBar) {
    data.forEach((_, i) => {
      const own = bars.filter((b) => b.row === i);
      if (!own.length) return;
      const items = stacked
        ? [
            {
              value: total(i),
              box: own.reduce((a, b) => (horizontal ? (b.box.x + b.box.w > a.x + a.w ? b.box : a) : b.box.y < a.y ? b.box : a), own[0].box),
            },
          ]
        : own.map((b) => ({ value: b.value, box: b.box }));
      for (const [j, it] of items.entries()) {
        const neg = it.value < 0;
        const at = horizontal
          ? { x: neg ? it.box.x - 6 : it.box.x + it.box.w + 6, y: it.box.y + it.box.h / 2, anchor: neg ? "end" : "start" }
          : { x: it.box.x + it.box.w / 2, y: neg ? it.box.y + it.box.h + font + 2 : it.box.y - 6, anchor: "middle" };
        valueLabels.push(
          <text
            key={`v-${i}-${j}`}
            x={at.x}
            y={at.y}
            textAnchor={at.anchor as "start" | "end" | "middle"}
            dominantBaseline={horizontal ? "middle" : undefined}
            {...textProps(font)}
            {...HALO}
            className="tabular-nums"
            data-part="value-label"
          >
            {fmt(it.value)}
          </text>,
        );
      }
    });
    // Inside a stacked segment only when the value fits with room to spare; else the tooltip and table carry it.
    if (labels === "all" && stacked) {
      for (const b of bars) {
        const text = fmt(b.value);
        if (b.box.w < textWidth(text, font) + 8 || b.box.h < font + 3) continue;
        valueLabels.push(
          <text
            key={`in-${b.key}`}
            x={b.box.x + b.box.w / 2}
            y={b.box.y + b.box.h / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={inside(b.s)}
            fontSize={font}
            className="tabular-nums"
            data-part="value-label"
          >
            {text}
          </text>,
        );
      }
    }
  }
  if (labels === "all" && !isBar) {
    series.forEach((s, k) =>
      paths[k].tops.forEach((y, i) => {
        if (y == null || data[i][s.key] == null) return;
        valueLabels.push(
          <text
            key={`v-${k}-${i}`}
            x={xs[i]}
            y={y - 8}
            textAnchor="middle"
            {...textProps(font)}
            {...HALO}
            className="tabular-nums"
            data-part="value-label"
          >
            {fmt(data[i][s.key])}
          </text>,
        );
      }),
    );
  }

  const tip =
    on != null && anchor ? (
      <VizTooltip id={tipId} anchor={anchor} box={{ w: width, h: bottom }}>
        <div className="font-medium">{show(data[on][X])}</div>
        {series.map((s, k) => (
          <div key={s.key} className="flex items-center gap-2">
            <span className="h-0.5 w-3 shrink-0 rounded" style={{ background: colors[k] }} />
            <span className="font-mono font-medium text-foreground tabular-nums">{data[on][s.key] == null ? "–" : fmt(data[on][s.key])}</span>
            <span className="text-muted-foreground">{s.label}</span>
          </div>
        ))}
        {stacked && isBar && series.length > 1 && (
          <div className="flex items-center gap-2 border-t pt-1">
            <span className="font-mono font-medium text-foreground tabular-nums">{fmt(total(on))}</span>
            <span className="text-muted-foreground">total</span>
          </div>
        )}
      </VizTooltip>
    ) : null;

  return (
    <div ref={root} className="flex min-w-0 flex-col gap-1">
      <div
        ref={ref}
        {...growAttr(expanded)}
        className={cn("relative w-full", expanded ? growClass(true, "") : "shrink-0")}
        style={expanded ? { minHeight: inline } : { height: inline }}
        onPointerLeave={() => !focused && setActive(null)}
      >
        <svg
          width={width}
          height={height}
          role="list"
          aria-label={`${kindWord}: ${series.map((s) => s.label).join(", ")} by ${props.xName}`}
          className="block overflow-visible tabular-nums"
          style={{ fontSize: font }}
          data-stack-offset={stacked && signedData ? "sign" : undefined}
        >
          {/* Gridlines: solid hairlines one step off the surface, at the value ticks only. */}
          {horizontal ? (
            <Grid ticks={axis.ticks} at={v} lines="vertical" from={plot.y} to={bottom} />
          ) : (
            <Grid ticks={axis.ticks} at={v} lines="horizontal" from={plot.x} to={right} />
          )}
          {horizontal ? (
            <>
              <Ticks axis="value" items={valueTicks} side="bottom" offset={bottom + AXIS_GAP} font={font} />
              <Ticks axis="category" items={catTicks} side="left" offset={plot.x - 8} font={font} chars={catChars} />
            </>
          ) : (
            <>
              <Ticks axis="value" items={valueTicks} side="left" offset={plot.x - 8} font={font} />
              <Ticks axis="category" items={catTicks} side="bottom" offset={bottom + AXIS_GAP} font={font} />
            </>
          )}
          {/* The hovered category's band, behind the bars. */}
          {isBar && on != null && (
            <rect
              {...rectOf(hit(on), horizontal ? { x: plot.x, w: plot.w } : undefined)}
              rx={4}
              fill="var(--muted)"
              fillOpacity={0.6}
              data-part="hover"
            />
          )}
          {/* Reference lines: a solid 1px hairline in the muted text token (floored at 4.5:1), quieter than the 2px data. Under lines and areas, over bars (a target across them). */}
          {!isBar && refLines}
          {marks}
          {isBar && refLines}
          {/* The crosshair finds the x: a hairline at the hovered point, and every series' point on it. */}
          {!isBar && on != null && (
            <line
              x1={xs[on]}
              x2={xs[on]}
              y1={plot.y}
              y2={bottom}
              stroke="var(--muted-foreground)"
              strokeWidth={1}
              data-part="crosshair"
              pointerEvents="none"
            />
          )}
          {dots}
          {!isBar && on != null && (
            <g data-part="active" pointerEvents="none">
              {series.map((s, k) => {
                const y = paths[k].tops[on];
                return y == null || data[on][s.key] == null ? null : (
                  <circle key={s.key} cx={xs[on]} cy={y} r={6} fill={colors[k]} stroke={SURFACE} strokeWidth={2} />
                );
              })}
            </g>
          )}
          <g pointerEvents="none">{valueLabels}</g>
          <g aria-hidden pointerEvents="none" data-part="side-labels">
            {side.map((it) => {
              const p = sideAt.get(it.key);
              if (!p) return null;
              const moved = Math.abs(p.pos - p.at) > 2;
              return (
                <g key={p.key}>
                  {moved && (
                    <polyline
                      points={`${it.x + 2},${p.at} ${gx - 6},${p.at} ${gx - 2},${p.pos}`}
                      fill="none"
                      stroke="var(--muted-foreground)"
                      strokeWidth={1}
                      data-part="leader"
                    />
                  )}
                  <text
                    x={gx}
                    y={p.pos}
                    dominantBaseline="middle"
                    {...textProps(font, it.ref)}
                    {...HALO}
                    data-part={it.ref ? "ref-label" : "end-label"}
                    data-key={p.key}
                  >
                    {fitText(it.text, sideChars)}
                  </text>
                </g>
              );
            })}
          </g>
          <g aria-hidden pointerEvents="none" data-part="top-labels">
            {topPlaced.map((p) => (
              <text key={p.key} x={p.pos} y={plot.y - 6} textAnchor="middle" {...textProps(font, true)} {...HALO} data-part="ref-label">
                {topText.get(p.key)}
              </text>
            ))}
          </g>
          {/* Hit targets: a whole category (band or column), bigger than any mark, one tab stop for all; direct children of the list so they are its items. */}
          <>
            {data.map((r, i) => (
              <g
                key={i}
                {...roving.props(i)}
                role="listitem"
                aria-label={describe(i)}
                aria-describedby={on === i ? tipId : undefined}
                data-row={show(r[X])}
                data-index={i}
                className="outline-none"
                onPointerEnter={() => setActive(i)}
                onFocus={() => {
                  setActive(i);
                  setFocused(true);
                  roving.setFocus(i);
                }}
                onBlur={() => {
                  setFocused(false);
                  setActive(null);
                }}
              >
                <rect
                  {...rectOf(hit(i))}
                  rx={4}
                  fill="transparent"
                  stroke={focused && on === i ? "var(--ring)" : "none"}
                  strokeWidth={focused && on === i ? 2 : 0}
                  data-part="hit"
                />
              </g>
            ))}
          </>
        </svg>
        {tip}
      </div>
      {legend && (
        <Legend className="justify-center">
          {series.map((s, k) => (
            <LegendItem key={s.key} swatch={<Key kind={kind} color={colors[k]} />} label={s.label} />
          ))}
        </Legend>
      )}
    </div>
  );
}

const rectOf = (b: { x: number; y: number; w: number; h: number }, over?: { x: number; w: number }) => ({
  x: over?.x ?? b.x,
  y: b.y,
  width: Math.max(0, over?.w ?? b.w),
  height: Math.max(0, b.h),
});
