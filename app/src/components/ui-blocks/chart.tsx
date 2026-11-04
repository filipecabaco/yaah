// `chart` primitive — Recharts via shadcn's chart wrapper, and a hand-drawn dumbbell. Loaded on demand.
// Follows the dataviz rules whatever the agent sends: one y axis, categorical colours in fixed
// slot order (--chart-1…5, from the theme and validated, lib/chart-palette.ts), legend for 2+
// series, hover tooltip, a table view, and the mark specs: solid hairline grid, bars at most
// 24px with a 2px surface gap, a 10% wash under a single area and stronger fills with 2px seams
// for stacked bands, 8px dots with a 2px surface ring, no curve that can overshoot a stack, and
// text in text tokens at the interface's size, never in a series colour. Bars and stacks start at
// zero; lines fit their data (chart-model.ts valueAxis). Labels never sit on the data: end labels
// and reference labels share a gutter outside the plot and are dodged apart (chart-layout.ts).
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
  ZIndexLayer,
  useChartWidth,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
  type LabelProps,
} from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
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
  type Point,
  type Ref,
  type Series,
} from "@/components/ui-blocks/chart-model";
import { readScale } from "@/components/ui-blocks/scale";
import { dodge, fitText, needsLegend, textWidth, type LabelItem } from "@/components/ui-blocks/chart-layout";
import { useChartFont } from "@/components/ui-blocks/chart-font";
import { show } from "@/lib/narrow";
import { ViewToggle, VizTable } from "@/components/ui-blocks/viz";

const VIEWS = ["chart", "table"] as const;
/** Stacked bars: the stack's total, for the label at its end. */
const TOTAL = "total";
/** Stacked bands: a fill strong enough to tell neighbours apart (index.css tunes it per mode). */
export const BAND_OPACITY = 0.45;
/** A single area: a wash, never a saturated block. */
export const WASH_OPACITY = 0.1;

const textProps = (font: number, muted = false) => ({ fill: muted ? "var(--muted-foreground)" : "var(--foreground)", fontSize: font });
/** A halo in the surface colour under text that sits near marks or lines. */
const HALO = { stroke: "var(--chart-surface)", strokeWidth: 4, strokeLinejoin: "round", paintOrder: "stroke" } as const;

type Side = { key: string; text: string; y: number; x: number; ref: boolean };

/**
 * The right gutter: end labels at the last point of each line or area (the band's middle when
 * stacked) and the labels of horizontal reference lines, outside the plot and dodged together
 * (chart-layout.ts) so none overlap. A label moved off its mark gets a short leader line; one that
 * can't fit at all is dropped and reported, so the legend shows instead.
 */
function SideLabels(props: {
  data: Point[];
  series: Series[];
  stacked: boolean;
  ends: boolean;
  refs: Ref[];
  horizontal: boolean;
  room: number;
  font: number;
  fmt: (v: unknown) => string;
  onDropped: (n: number) => void;
}) {
  const { data, series, stacked, ends, refs, horizontal, room, font, fmt, onDropped } = props;
  const xs = useXAxisScale();
  const ys = useYAxisScale();
  const plot = usePlotArea();
  const items: Side[] = [];
  const last = data[data.length - 1];
  if (xs && ys && plot) {
    const right = plot.x + plot.width;
    if (ends && last) {
      const x = xs(last[X]) ?? right;
      const base = { up: 0, down: 0 };
      for (const s of series) {
        const raw = last[s.key];
        if (raw == null) continue;
        const v = num(raw);
        const side = v < 0 ? "down" : "up";
        const at = stacked ? base[side] + v / 2 : v;
        if (stacked) base[side] += v;
        const y = ys(at);
        if (y != null) items.push({ key: s.key, y, text: series.length > 1 ? `${s.label} ${fmt(v)}` : fmt(v), x, ref: false });
      }
    }
    refs.forEach((r, i) => {
      if (!r.label || (r.axis === "y") === horizontal) return;
      const y = ys(r.value, { position: "middle" });
      if (y != null) items.push({ key: `ref-${i}`, y, text: r.label, x: right, ref: true });
    });
  }
  const chars = Math.max(4, Math.floor((room - 12) / (font * 0.62)));
  const size = font + 3;
  const { placed, dropped } = plot
    ? dodge(
        items.map((it) => ({ key: it.key, at: it.y, size, priority: it.ref ? 1 : 0 })),
        { min: Math.max(0, plot.y - 10), max: plot.y + plot.height + 4, pad: 2, maxShift: size * 3 },
      )
    : { placed: [], dropped: [] };
  const lost = dropped.filter((k) => !k.startsWith("ref-")).length;
  useEffect(() => onDropped(lost), [lost, onDropped]);
  if (!plot || !placed.length) return null;
  const gx = plot.x + plot.width + 10;
  const at = new Map(placed.map((p) => [p.key, p]));
  return (
    <ZIndexLayer zIndex={2000}>
      <g className="ui-side-labels" aria-hidden>
        {items.map((it) => {
          const p = at.get(it.key);
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
                {fitText(it.text, chars)}
              </text>
            </g>
          );
        })}
      </g>
    </ZIndexLayer>
  );
}

/** Labels of vertical reference lines, in a gutter above the plot (never over the data), dodged sideways. */
function TopLabels({ refs, horizontal, font }: { refs: Ref[]; horizontal: boolean; font: number }) {
  const xs = useXAxisScale();
  const plot = usePlotArea();
  const width = useChartWidth();
  if (!xs || !plot || !width) return null;
  const items: (LabelItem & { text: string })[] = [];
  refs.forEach((r, i) => {
    if (!r.label || (r.axis === "y") !== horizontal) return;
    const x = xs(r.value, { position: "middle" });
    if (x != null) items.push({ key: `ref-${i}`, at: x, size: textWidth(r.label, font), text: r.label });
  });
  const { placed } = dodge(items, { min: 2, max: width - 2, pad: 8 });
  const text = new Map(items.map((it) => [it.key, it.text]));
  return (
    <ZIndexLayer zIndex={2000}>
      <g className="ui-top-labels" aria-hidden>
        {placed.map((p) => (
          <text key={p.key} x={p.pos} y={plot.y - 6} textAnchor="middle" {...textProps(font, true)} {...HALO} data-part="ref-label">
            {text.get(p.key)}
          </text>
        ))}
      </g>
    </ZIndexLayer>
  );
}

/** One axis tick: a single line of text in a text token. Recharts' own tick wraps at spaces ("-10 / °C"). */
function tick(format: (v: unknown) => string, font: number, side: "left" | "bottom", chars = Infinity) {
  return function Tick(p: { x?: number | string; y?: number | string; payload?: { value?: unknown }; textAnchor?: string }) {
    const full = format(p.payload?.value);
    const text = fitText(full, chars);
    return (
      <text
        x={p.x}
        y={p.y}
        dy={side === "bottom" ? "0.71em" : undefined}
        dominantBaseline={side === "left" ? "middle" : undefined}
        textAnchor={(p.textAnchor as "end" | "middle" | "start") ?? (side === "left" ? "end" : "middle")}
        {...textProps(font, true)}
        className="tabular-nums"
        data-part="tick"
      >
        {text !== full && <title>{full}</title>}
        {text}
      </text>
    );
  };
}

/** A value at a mark, in a text token. Inside a stacked segment only when it fits. */
function valueLabel(fmt: (v: unknown) => string, font: number, inside = false) {
  return function ValueLabel(p: LabelProps) {
    const { x, y, width, height, value } = p as { x?: number; y?: number; width?: number; height?: number; value?: unknown };
    if (x == null || y == null || value == null) return null;
    const text = fmt(value);
    const w = Number(width ?? 0);
    const h = Number(height ?? 0);
    if (inside) {
      if (Math.abs(w) < textWidth(text, font) + 8 || Math.abs(h) < font + 3) return null;
      return (
        <text
          x={Number(x) + w / 2}
          y={Number(y) + h / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--background)"
          fontSize={font}
          data-part="value-label"
        >
          {text}
        </text>
      );
    }
    // Columns take their value on the cap; points just above.
    return (
      <text x={Number(x) + w / 2} y={Number(y) - 6} textAnchor="middle" {...textProps(font)} {...HALO} data-part="value-label">
        {text}
      </text>
    );
  };
}

function tipLabel(fmt: (v: unknown) => string, font: number) {
  return function TipLabel(p: LabelProps) {
    const { x, y, width, height, value } = p as { x?: number; y?: number; width?: number; height?: number; value?: unknown };
    if (x == null || y == null || value == null) return null;
    return (
      <text
        x={Number(x) + Number(width ?? 0) + 6}
        y={Number(y) + Number(height ?? 0) / 2}
        dominantBaseline="middle"
        {...textProps(font)}
        {...HALO}
        data-part="value-label"
      >
        {fmt(value)}
      </text>
    );
  };
}

/**
 * Reference lines through Recharts: `y` is the value axis, `x` the category axis, whichever way the
 * chart lies. A solid 1px hairline in the muted text token: visible on every theme (it is floored at
 * 4.5:1) yet quieter than the 2px data. Under lines and areas, over bars (a target across them).
 * The labels are drawn by SideLabels and TopLabels, outside the plot.
 */
function refLines(refs: Ref[], horizontal: boolean, overMarks: boolean) {
  return refs.map((r, i) => {
    const onValue = r.axis === "y";
    const at = onValue === !horizontal ? { y: r.value } : { x: r.value };
    return (
      <ReferenceLine
        key={i}
        {...at}
        stroke="var(--muted-foreground)"
        strokeWidth={1}
        ifOverflow="extendDomain"
        zIndex={overMarks ? 350 : 50}
        className="ui-ref"
      />
    );
  });
}

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
  const [dropped, setDropped] = useState(0);
  const kind = readKind(props.kind);
  const stacked = !!props.stacked && kind !== "dumbbell";
  const given = namedSeries(props.series).length;
  const sort = readSort(props.sort, kind);
  const font = useChartFont();
  const { data, series } = useMemo((): { data: Point[]; series: Series[] } => {
    const n = normalise(props.data, props.series, props.x);
    const f = kind === "dumbbell" ? n : fold(n.data, n.series, stacked);
    const sorted = sortRows(f.data, f.series, sort, kind);
    // Stacked bars carry their total for the label at the stack's end.
    return { data: stacked ? sorted.map((r) => ({ ...r, [TOTAL]: f.series.reduce((t, s) => t + num(r[s.key]), 0) })) : sorted, series: f.series };
  }, [props.data, props.series, props.x, stacked, sort, kind]);
  const config: ChartConfig = Object.fromEntries(series.map((s, i) => [s.key, { label: s.label, color: `var(--chart-${i + 1})` }]));
  const fmt = useMemo(() => formatter(props.unit), [props.unit]);
  const refs = useMemo(() => readRefs(props.refs), [props.refs]);
  const labels = readLabels(props.labels, kind);
  const orientation = readOrientation(props.orientation, kind, data);
  const horizontal = orientation === "horizontal";
  const scale = useMemo(() => readScale(props.scale), [props.scale]);
  const height = props.height || 240;
  const gapFmt = useMemo(() => signed(fmt), [fmt]);
  const zero = props.zero === true;
  const domain = useMemo(() => readDomain(props.domain), [props.domain]);
  const axis = useMemo(
    () =>
      valueAxis({
        kind,
        stacked,
        data,
        series,
        refs,
        zero,
        domain,
        ticks: horizontal ? 5 : Math.max(3, Math.min(6, Math.round(height / 60))),
      }),
    [kind, stacked, data, series, refs, zero, domain, horizontal, height],
  );
  const onDropped = useCallback((n: number) => setDropped((d) => (d === n ? d : n)), []);

  if (kind === "dumbbell" && given !== 2) {
    return <ErrorText error={`A dumbbell needs exactly 2 series (before and after, e.g. poll and result); this one has ${given}.`} />;
  }

  // Negative values (e.g. churn) stack below zero instead of on top of the positives.
  const signedData = data.some((r) => series.some((s) => num(r[s.key]) < 0));
  // The value axis is as wide as its widest tick, so "100%" or "-10 °C" is never clipped or wrapped.
  const valueW = Math.min(120, 14 + Math.max(...axis.ticks.map((t) => textWidth(fmt(t), font)), textWidth("0", font)));
  const catW = Math.min(160, Math.max(40, 12 + Math.max(0, ...data.map((r) => textWidth(String(r[X]), font)))));
  const catChars = Math.floor((catW - 12) / (font * 0.62));
  const ends = labels === "ends" && (kind === "line" || kind === "area") && data.length > 0;
  // The right gutter holds the end labels and the labels of horizontal reference lines.
  const sideRefs = refs.filter((r) => r.label && (r.axis === "y") !== horizontal);
  const topRefs = refs.some((r) => r.label && (r.axis === "y") === horizontal);
  const lastRow = data[data.length - 1];
  const sideText = [
    ...(ends ? series.map((s) => (series.length > 1 ? `${s.label} ` : "") + fmt(num(lastRow[s.key]))) : []),
    ...sideRefs.map((r) => r.label!),
  ];
  const sideRoom = sideText.length ? Math.min(200, 22 + Math.max(...sideText.map((t) => textWidth(t, font)))) : 0;
  const tipRoom = kind === "bar" && labels !== "none" ? 12 + textWidth(fmt(axis.domain[1]), font) : 0;
  // Splines can overshoot between points and, stacked, draw a total that isn't the sum: straight segments,
  // except a single unstacked series, where the monotone curve can't misstate anything.
  const curve: "monotone" | "linear" = !stacked && series.length === 1 ? "monotone" : "linear";
  const surface = "var(--chart-surface)";
  const valueTick = tick(fmt, font, horizontal ? "bottom" : "left");
  const catTick = tick(show, font, horizontal ? "left" : "bottom", horizontal ? catChars : Infinity);

  const axes = (
    <>
      {/* Solid hairlines, one step off the surface; never dashed. */}
      <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="var(--border)" strokeWidth={1} />
      {horizontal ? (
        <>
          <XAxis type="number" tickLine={false} axisLine={false} domain={axis.domain} ticks={axis.ticks} interval={0} tick={valueTick} />
          <YAxis type="category" dataKey={X} tickLine={false} axisLine={false} width={catW} interval={0} tick={catTick} />
        </>
      ) : (
        <>
          <XAxis
            dataKey={X}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            interval={kind === "bar" ? 0 : "preserveStartEnd"}
            minTickGap={16}
            tick={catTick}
          />
          <YAxis tickLine={false} axisLine={false} width={valueW} domain={axis.domain} ticks={axis.ticks} interval={0} tick={valueTick} />
        </>
      )}
      <ChartTooltip
        cursor={kind !== "bar"}
        content={
          <ChartTooltipContent
            indicator={kind === "line" ? "line" : "dot"}
            formatter={(value, name, item) => (
              <>
                <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: config[String(name)]?.color ?? item.color }} />
                <span className="text-muted-foreground">{config[String(name)]?.label ?? name}</span>
                <span className="ml-auto pl-4 font-mono font-medium text-foreground tabular-nums">{fmt(value)}</span>
              </>
            )}
          />
        }
      />
      {/* itemSorter null keeps the legend in series order (Recharts sorts by name). */}
      {needsLegend(series.length, dropped) && <ChartLegend itemSorter={null} content={<ChartLegendContent />} />}
      {refLines(refs, horizontal, kind === "bar")}
      {(ends || sideRefs.length > 0) && (
        <SideLabels
          data={data}
          series={series}
          stacked={stacked}
          ends={ends}
          refs={refs}
          horizontal={horizontal}
          room={sideRoom}
          font={font}
          fmt={fmt}
          onDropped={onDropped}
        />
      )}
      {topRefs && <TopLabels refs={refs} horizontal={horizontal} font={font} />}
    </>
  );
  const stack = stacked ? "stack" : undefined;
  const last = series.length - 1;
  const margin = { top: 12 + (topRefs ? font + 8 : 0), right: Math.max(12, sideRoom, tipRoom), left: 0, bottom: 0 };

  const chart =
    kind === "bar" ? (
      <BarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        stackOffset={signedData ? "sign" : undefined}
        barGap={2}
        margin={margin}
        accessibilityLayer
      >
        {axes}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            fill={`var(--color-${s.key})`}
            stackId={stack}
            // A 2px gap in the surface colour between stacked segments (half on each side of the seam).
            stroke={stack ? surface : undefined}
            strokeWidth={stack ? 2 : undefined}
            // Rounded data-ends only where the bar ends: every bar, or the top of a stack.
            radius={!stack || i === last ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0}
            maxBarSize={24}
            isAnimationActive={false}
          >
            {labels !== "none" && (!stack || i === last) && (
              <LabelList dataKey={stack ? TOTAL : s.key} content={horizontal ? tipLabel(fmt, font) : valueLabel(fmt, font)} />
            )}
            {labels === "all" && stack && <LabelList dataKey={s.key} content={valueLabel(fmt, font, true)} />}
          </Bar>
        ))}
      </BarChart>
    ) : kind === "area" ? (
      <AreaChart data={data} stackOffset={signedData ? "sign" : undefined} margin={margin} accessibilityLayer>
        {axes}
        {series.map((s) => (
          <Area
            key={s.key}
            dataKey={s.key}
            type={curve}
            stackId={stack}
            // Stacked: bands told apart by a stronger fill with a 2px surface seam between them (as stacked
            // bars are); alone: the series line over a 10% wash.
            className={stack ? "ui-band" : undefined}
            stroke={stack ? surface : `var(--color-${s.key})`}
            strokeWidth={2}
            fill={`var(--color-${s.key})`}
            fillOpacity={stack ? BAND_OPACITY : WASH_OPACITY}
            isAnimationActive={false}
          >
            {labels === "all" && <LabelList dataKey={s.key} content={valueLabel(fmt, font)} />}
          </Area>
        ))}
      </AreaChart>
    ) : (
      <LineChart data={data} margin={margin} accessibilityLayer>
        {axes}
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            type={curve}
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            // 8px of colour inside a 2px ring of the surface (r 5, stroke 2 centred on the edge).
            dot={data.length <= 12 ? { r: 5, strokeWidth: 2, stroke: surface, fill: `var(--color-${s.key})` } : false}
            activeDot={{ r: 6, strokeWidth: 2, stroke: surface, fill: `var(--color-${s.key})` }}
            // Live charts update every few seconds; a redraw animation would never finish.
            isAnimationActive={false}
          >
            {labels === "all" && <LabelList dataKey={s.key} content={valueLabel(fmt, font)} />}
          </Line>
        ))}
      </LineChart>
    );

  const gap = (r: Point) => (r[series[0]?.key] == null || r[series[1]?.key] == null ? null : num(r[series[1].key]) - num(r[series[0].key]));

  return (
    <div className="ui-chart flex flex-col gap-1" data-chart-kind={kind} data-orientation={orientation}>
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
          <ChartContainer config={config} className="w-full" style={{ height }}>
            {chart}
          </ChartContainer>
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
