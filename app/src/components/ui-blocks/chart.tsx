// `chart` primitive — Recharts via shadcn's chart wrapper, and a hand-drawn dumbbell. Loaded on demand.
// Follows the dataviz rules whatever the agent sends: one y axis, categorical colours in fixed
// slot order (--chart-1…5, from the theme and validated, lib/chart-palette.ts), legend for 2+
// series, hover tooltip, a table view, and the mark specs: solid hairline grid, bars at most
// 24px with a 2px surface gap, a 10% area wash, 8px dots with a 2px surface ring, no curve that
// can overshoot a stack, and text in text tokens, never in a series colour.
import { useMemo, useState } from "react";
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
  useXAxisScale,
  useYAxisScale,
  type LabelProps,
} from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  readOrientation,
  readRefs,
  readSort,
  signed,
  sortRows,
  type Point,
  type Ref,
  type Series,
} from "@/components/ui-blocks/chart-model";
import { readScale } from "@/components/ui-blocks/scale";
import { cn } from "@/lib/utils";
import { inlineMax, useUiView } from "@/components/ui-view";

const TEXT = { fill: "var(--foreground)", fontSize: 11 } as const;
const MUTED = { fill: "var(--muted-foreground)", fontSize: 11 } as const;
const CHAR = 6.6;
/** Stacked bars: the stack's total, for the label at its end. */
const TOTAL = "total";

/**
 * Direct labels at the right end of each line or area: the value (with the series name when
 * there are several), in text tokens beside the mark. When two would collide, none is drawn:
 * nudged labels drift off their lines, and the legend and tooltip already name every series.
 */
function EndLabels({ data, series, stacked, fmt }: { data: Point[]; series: Series[]; stacked: boolean; fmt: (v: unknown) => string }) {
  const xs = useXAxisScale();
  const ys = useYAxisScale();
  const last = data[data.length - 1];
  if (!xs || !ys || !last) return null;
  const x = xs(last[X]);
  if (x == null) return null;
  // Stacked: the middle of the layer's band at the last point (positives stack up, negatives down); otherwise the point.
  const items: { key: string; y: number; text: string }[] = [];
  const base = { up: 0, down: 0 };
  for (const s of series) {
    const raw = last[s.key];
    if (raw == null) continue;
    const v = num(raw);
    const side = v < 0 ? "down" : "up";
    const at = stacked ? base[side] + v / 2 : v;
    if (stacked) base[side] += v;
    const y = ys(at);
    if (y != null) items.push({ key: s.key, y, text: series.length > 1 ? `${s.label} ${fmt(v)}` : fmt(v) });
  }
  const sorted = [...items].sort((p, q) => p.y - q.y);
  if (sorted.some((it, i) => i > 0 && it.y - sorted[i - 1].y < 13)) return null;
  return (
    <g className="ui-end-labels" aria-hidden>
      {items.map((it) => (
        <text key={it.key} x={x + 8} y={it.y} dominantBaseline="middle" {...TEXT} data-part="end-label">
          {it.text}
        </text>
      ))}
    </g>
  );
}

/** A value at a mark, in a text token. Inside a stacked segment only when it fits. */
function valueLabel(fmt: (v: unknown) => string, inside = false) {
  return function ValueLabel(p: LabelProps) {
    const { x, y, width, height, value } = p as { x?: number; y?: number; width?: number; height?: number; value?: unknown };
    if (x == null || y == null || value == null) return null;
    const text = fmt(value);
    const w = Number(width ?? 0);
    const h = Number(height ?? 0);
    if (inside) {
      if (Math.abs(w) < CHAR * text.length + 8 || Math.abs(h) < 14) return null;
      return (
        <text
          x={Number(x) + w / 2}
          y={Number(y) + h / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--background)"
          fontSize={11}
          data-part="value-label"
        >
          {text}
        </text>
      );
    }
    // Columns take their value on the cap; points just above.
    return (
      <text x={Number(x) + w / 2} y={Number(y) - 6} textAnchor="middle" {...TEXT} data-part="value-label">
        {text}
      </text>
    );
  };
}

function tipLabel(fmt: (v: unknown) => string) {
  return function TipLabel(p: LabelProps) {
    const { x, y, width, height, value } = p as { x?: number; y?: number; width?: number; height?: number; value?: unknown };
    if (x == null || y == null || value == null) return null;
    return (
      <text
        x={Number(x) + Number(width ?? 0) + 6}
        y={Number(y) + Number(height ?? 0) / 2}
        dominantBaseline="middle"
        {...TEXT}
        data-part="value-label"
      >
        {fmt(value)}
      </text>
    );
  };
}

/** Reference lines through Recharts: `y` is the value axis, `x` the category axis, whichever way the chart lies. */
function refLines(refs: Ref[], horizontal: boolean) {
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
        className="ui-ref"
        label={r.label ? { value: r.label, position: "y" in at ? "insideTopRight" : "insideTopLeft", ...MUTED } : undefined}
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
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const kind = readKind(props.kind);
  const stacked = !!props.stacked && kind !== "dumbbell";
  const given = namedSeries(props.series).length;
  const sort = readSort(props.sort, kind);
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
  // Wide enough for the longest value label, so big numbers aren't clipped.
  const yWidth = Math.min(96, Math.max(36, 8 + 7 * Math.max(...data.flatMap((r) => series.map((s) => fmt(num(r[s.key])).length)), 1)));
  // Negative values (e.g. churn) stack below zero instead of on top of the positives.
  const signedData = data.some((r) => series.some((s) => num(r[s.key]) < 0));
  const height = props.height || 240;
  const { expanded } = useUiView();
  const gapFmt = useMemo(() => signed(fmt), [fmt]);

  if (kind === "dumbbell" && given !== 2) {
    return <ErrorText error={`A dumbbell needs exactly 2 series (before and after, e.g. poll and result); this one has ${given}.`} />;
  }

  // Right margin for the end labels, so they are never clipped.
  const endRoom =
    labels === "ends" && (kind === "line" || kind === "area") && data.length
      ? Math.min(
          180,
          12 + CHAR * Math.max(...series.map((s) => (series.length > 1 ? s.label.length + 1 : 0) + fmt(num(data[data.length - 1][s.key])).length)),
        )
      : 12;
  // Splines can overshoot between points and, stacked, draw a total that isn't the sum: straight segments,
  // except a single unstacked series, where the monotone curve can't misstate anything.
  const curve: "monotone" | "linear" = !stacked && series.length === 1 ? "monotone" : "linear";
  const surface = "var(--chart-surface)";

  const axes = (
    <>
      {/* Solid hairlines, one step off the surface; never dashed. */}
      <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="var(--border)" strokeWidth={1} />
      {horizontal ? (
        <>
          <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} />
          <YAxis type="category" dataKey={X} tickLine={false} axisLine={false} width={104} interval={0} />
        </>
      ) : (
        <>
          <XAxis dataKey={X} tickLine={false} axisLine={false} tickMargin={8} interval={kind === "bar" ? 0 : "preserveStartEnd"} minTickGap={16} />
          <YAxis tickLine={false} axisLine={false} width={yWidth} tickFormatter={(v) => fmt(v)} />
        </>
      )}
      <ChartTooltip
        cursor={kind !== "bar"}
        content={
          <ChartTooltipContent
            indicator={kind === "line" ? "line" : "dot"}
            formatter={(value, name, item) => (
              <>
                <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} />
                <span className="text-muted-foreground">{config[String(name)]?.label ?? name}</span>
                <span className="ml-auto pl-4 font-mono font-medium text-foreground tabular-nums">{fmt(value)}</span>
              </>
            )}
          />
        }
      />
      {/* itemSorter null keeps the legend in series order (Recharts sorts by name). */}
      {series.length >= 2 && <ChartLegend itemSorter={null} content={<ChartLegendContent />} />}
      {refLines(refs, horizontal)}
    </>
  );
  const stack = stacked ? "stack" : undefined;
  const last = series.length - 1;
  const margin = { top: 12, right: endRoom, left: 0, bottom: 0 };

  const chart =
    kind === "bar" ? (
      <BarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        stackOffset={signedData ? "sign" : undefined}
        barGap={2}
        margin={{ ...margin, right: labels === "none" ? 12 : 48 }}
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
              <LabelList dataKey={stack ? TOTAL : s.key} content={horizontal ? tipLabel(fmt) : valueLabel(fmt)} />
            )}
            {labels === "all" && stack && <LabelList dataKey={s.key} content={valueLabel(fmt, true)} />}
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
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            fill={`var(--color-${s.key})`}
            // A wash, never a saturated block.
            fillOpacity={0.1}
            isAnimationActive={false}
          >
            {labels === "all" && <LabelList dataKey={s.key} content={valueLabel(fmt)} />}
          </Area>
        ))}
        {labels === "ends" && <EndLabels data={data} series={series} stacked={stacked} fmt={fmt} />}
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
            {labels === "all" && <LabelList dataKey={s.key} content={valueLabel(fmt)} />}
          </Line>
        ))}
        {labels === "ends" && <EndLabels data={data} series={series} stacked={false} fmt={fmt} />}
      </LineChart>
    );

  const gap = (r: Point) => (r[series[0]?.key] == null || r[series[1]?.key] == null ? null : num(r[series[1].key]) - num(r[series[0].key]));

  return (
    <div className="ui-chart flex flex-col gap-1" data-chart-kind={kind} data-orientation={orientation}>
      <div className="flex justify-end">
        <div className="inline-flex rounded-md border p-0.5 text-xs" role="group" aria-label="View">
          {(["chart", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn("rounded px-2 py-0.5 capitalize", view === v ? "bg-muted font-medium" : "text-muted-foreground")}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
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
        <div className={cn("overflow-auto rounded-md border", inlineMax(expanded, "max-h-80"))}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{props.x}</TableHead>
                {series.map((s) => (
                  <TableHead key={s.key} className="text-right">
                    {s.label}
                  </TableHead>
                ))}
                {kind === "dumbbell" && <TableHead className="text-right">Gap</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row, i) => (
                <TableRow key={i}>
                  <TableCell>{row[X]}</TableCell>
                  {series.map((s) => (
                    <TableCell key={s.key} className="text-right tabular-nums">
                      {fmt(row[s.key])}
                    </TableCell>
                  ))}
                  {kind === "dumbbell" && <TableCell className="text-right tabular-nums">{gap(row) == null ? "–" : gapFmt(gap(row)!)}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
