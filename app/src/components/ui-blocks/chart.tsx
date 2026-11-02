// `chart` primitive — Recharts via shadcn's chart wrapper. Loaded on demand.
// Follows the dataviz rules: one y axis, categorical colours in fixed slot
// order (--chart-1…5, validated), legend for 2+ series, hover tooltip, thin
// marks, and a table view (the light palette's relief rule).
import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { asArray, asNumber, isObj, optText, show } from "@/lib/narrow";
import { cn } from "@/lib/utils";

/** `key` is our own slot name; the agent's field names never reach CSS (shadcn writes config keys into a <style>). */
type Series = { key: string; label: string };
type Point = Record<string, string | number | null>;

const X = "x";
const MAX_SERIES = 5;

/**
 * The agent's rows and series, rekeyed onto fixed names: `x` for the category
 * and `series-N` per series, values as numbers (null leaves a gap). Field
 * names can then hold anything (dots, spaces, braces) without reaching
 * Recharts' path lookup or the chart's CSS variables.
 */
function normalise(rawData: unknown, rawSeries: unknown, x: string): { data: Point[]; series: Series[] } {
  const named = asArray(rawSeries).flatMap((s): { field: string; label: string }[] => {
    if (typeof s === "string") return [{ field: s, label: s }];
    if (isObj(s) && typeof s.key === "string") return [{ field: s.key, label: optText(s.label) ?? s.key }];
    return [];
  });
  const series = named.map((s, i) => ({ key: `series-${i}`, label: s.label }));
  const data = asArray(rawData)
    .filter(isObj)
    .map((r) => {
      const p: Point = { [X]: show(r[x]) };
      named.forEach((s, i) => (p[series[i].key] = asNumber(r[s.field]) ?? null));
      return p;
    });
  return { data, series };
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/**
 * Keep the 4 biggest series (by total size, in their given order) and fold the rest
 * into "Other" — never a 6th hue. Stacked charts sum the rest (parts of a whole);
 * otherwise "Other" is their average, so it doesn't dwarf the lines it sits beside.
 */
function fold(data: Point[], series: Series[], stacked: boolean): { data: Point[]; series: Series[] } {
  if (series.length <= MAX_SERIES) return { data, series };
  const size = (s: Series) => data.reduce((n, r) => n + Math.abs(num(r[s.key])), 0);
  const biggest = new Set(
    [...series]
      .sort((a, b) => size(b) - size(a))
      .slice(0, MAX_SERIES - 1)
      .map((s) => s.key),
  );
  const keep = series.filter((s) => biggest.has(s.key));
  const rest = series.filter((s) => !biggest.has(s.key));
  const other = { key: "series-other", label: `Other (${rest.length}${stacked ? "" : ", average"})` };
  return {
    series: [...keep, other],
    data: data.map((row) => {
      const total = rest.reduce((n, s) => n + num(row[s.key]), 0);
      return { ...row, [other.key]: stacked ? total : total / rest.length };
    }),
  };
}

const CURRENCY = new Set(["$", "€", "£", "¥"]);

/** Compact big numbers (1.2M), keep small ones readable, and place the unit. */
function formatter(unit?: string) {
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const plain = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  return (v: unknown) => {
    if (typeof v !== "number") return show(v);
    const n = Math.abs(v) >= 10_000 ? compact.format(v) : plain.format(v);
    if (!unit) return n;
    if (CURRENCY.has(unit)) return v < 0 ? `-${unit}${n.slice(1)}` : `${unit}${n}`;
    return `${n}${unit.startsWith(" ") || unit === "%" ? unit : ` ${unit}`}`;
  };
}

export default function UiChart(props: {
  kind: unknown;
  data: unknown;
  x: string;
  series: unknown;
  stacked?: boolean;
  unit?: string;
  height?: number;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const kind = props.kind === "bar" || props.kind === "area" ? props.kind : "line";
  const stacked = !!props.stacked;
  const { data, series } = useMemo(() => {
    const n = normalise(props.data, props.series, props.x);
    return fold(n.data, n.series, stacked);
  }, [props.data, props.series, props.x, stacked]);
  const config: ChartConfig = Object.fromEntries(series.map((s, i) => [s.key, { label: s.label, color: `var(--chart-${i + 1})` }]));
  const fmt = useMemo(() => formatter(props.unit), [props.unit]);
  // Wide enough for the longest value label, so big numbers aren't clipped.
  const yWidth = Math.min(96, Math.max(36, 8 + 7 * Math.max(...data.flatMap((r) => series.map((s) => fmt(num(r[s.key])).length)), 1)));
  // Negative values (e.g. churn) stack below zero instead of on top of the positives.
  const signed = data.some((r) => series.some((s) => num(r[s.key]) < 0));
  const height = props.height || 240;
  // Long category names don't fit under vertical bars and Recharts drops the ones that collide;
  // every bar must be labelled, so long-labelled bar charts lie on their side.
  const horizontal = kind === "bar" && data.some((r) => show(r[X]).length > 8);

  const axes = (
    <>
      <CartesianGrid vertical={horizontal} horizontal={!horizontal} strokeDasharray="3 3" />
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
    </>
  );
  const stack = stacked ? "stack" : undefined;
  const last = series.length - 1;

  const chart =
    kind === "bar" ? (
      <BarChart data={data} layout={horizontal ? "vertical" : "horizontal"} stackOffset={signed ? "sign" : undefined} accessibilityLayer>
        {axes}
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            fill={`var(--color-${s.key})`}
            stackId={stack}
            // Rounded data-ends only where the bar ends: every bar, or the top of a stack.
            radius={!stack || i === last ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0}
            maxBarSize={36}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    ) : kind === "area" ? (
      <AreaChart data={data} stackOffset={signed ? "sign" : undefined} accessibilityLayer>
        {axes}
        {series.map((s) => (
          <Area
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stackId={stack}
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            fill={`var(--color-${s.key})`}
            fillOpacity={0.2}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    ) : (
      <LineChart data={data} accessibilityLayer>
        {axes}
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            type="monotone"
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            dot={data.length <= 12 ? { r: 4 } : false}
            activeDot={{ r: 5 }}
            // Live charts update every few seconds; a redraw animation would never finish.
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );

  return (
    <div className="flex flex-col gap-1">
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
        <ChartContainer config={config} className="w-full" style={{ height }}>
          {chart}
        </ChartContainer>
      ) : (
        <div className="max-h-80 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{props.x}</TableHead>
                {series.map((s) => (
                  <TableHead key={s.key} className="text-right">
                    {s.label}
                  </TableHead>
                ))}
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
