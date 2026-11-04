// `chart` kind "dumbbell": two values per category (before → after, poll → result) as two dots
// joined by a connector, on one shared numeric axis. Hand-drawn SVG over d3-scale, in theme
// tokens only. Each row is a ~28px hit target; hover and keyboard focus show the same tooltip,
// and every value is also in the row's accessible name, the gap labels and the table view.
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { scaleLinear } from "d3-scale";
import { X, formatter, num, signed, type Labels, type Orientation, type Point, type Ref, type Series } from "@/components/ui-blocks/chart-model";
import { binColors, binRange, colorOf, domainOf, forMarks, type Scale } from "@/components/ui-blocks/scale";
import { cn } from "@/lib/utils";
import { placeTip, type Box } from "@/components/ui-blocks/chart-layout";
import { useChartFont } from "@/components/ui-blocks/chart-font";

const ROW = 28;
const TOP = 22;
const AXIS = 22;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The container's width, followed as it resizes (a fixed guess until it has one). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth > 0) setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => e.contentRect.width > 0 && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

type Mark = { fill: string; hollow: boolean };

/** How the two series are told apart: two shades of one hue (the before → after rule), the first two slots, or, on a diverging scale, colour by value with the first series hollow. */
function marksFor(scale: Scale | null, domain: [number, number]) {
  if (scale?.type === "diverging") return (i: number, v: number): Mark => ({ fill: colorOf(scale, domain, v, true), hollow: i === 0 });
  if (scale?.type === "categorical") return (i: number): Mark => ({ fill: `var(--chart-${i + 1})`, hollow: false });
  return (i: number): Mark => ({ fill: i === 0 ? "var(--scale-seq-400)" : "var(--scale-seq-700)", hollow: false });
}

/** A dot: 8px across, with a 2px ring in the surface colour so it stays legible over the connector and the other dot. */
function Dot({ cx, cy, mark, className }: { cx: number; cy: number; mark: Mark; className?: string }) {
  return (
    <g className={className}>
      <circle cx={cx} cy={cy} r={6} fill="var(--chart-surface)" />
      {mark.hollow ? (
        <circle cx={cx} cy={cy} r={4} fill="var(--chart-surface)" stroke={mark.fill} strokeWidth={2} data-mark="dot" />
      ) : (
        <circle cx={cx} cy={cy} r={4} fill={mark.fill} data-mark="dot" />
      )}
    </g>
  );
}

function Swatch({ mark }: { mark: Mark }) {
  return (
    <svg width={12} height={12} aria-hidden className="shrink-0">
      <Dot cx={6} cy={6} mark={mark} />
    </svg>
  );
}

export function Dumbbell(props: {
  data: Point[];
  series: Series[];
  refs: Ref[];
  labels: Labels;
  orientation: Orientation;
  scale: Scale | null;
  fmt: (v: unknown) => string;
  xName: string;
  height?: number;
}) {
  const { data, series, refs, labels, orientation, fmt } = props;
  // Dots are small marks: the scale's pale steps would vanish on the surface (scale.ts).
  const scale = props.scale && forMarks(props.scale);
  const [a, b] = series;
  const { ref, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const [focus, setFocus] = useState(0);
  const rowRefs = useRef<(SVGGElement | null)[]>([]);
  const tipId = useId();
  const gapFmt = useMemo(() => signed(fmt), [fmt]);
  const horizontal = orientation === "horizontal";
  const font = useChartFont();
  const CHAR = font * 0.62;
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipSize, setTipSize] = useState<Box>({ w: 180, h: 84 });

  const values = data.flatMap((r) => [r[a.key], r[b.key]]).filter((v): v is number => typeof v === "number");
  const refValues = refs.filter((r) => r.axis === "y" && typeof r.value === "number").map((r) => r.value as number);
  const scaleDomain = scale ? domainOf(scale, values) : ([0, 1] as [number, number]);
  const mark = marksFor(scale, scaleDomain);
  const gap = (r: Point) => (r[a.key] == null || r[b.key] == null ? null : num(r[b.key]) - num(r[a.key]));
  const gapText = (r: Point) => {
    const g = gap(r);
    if (g == null) return "–";
    return labels === "all" ? `${fmt(r[a.key])} → ${fmt(r[b.key])} (${gapFmt(g)})` : gapFmt(g);
  };

  // Layout: the category labels on one side, the gap labels at the row ends.
  const longest = (xs: string[]) => Math.max(0, ...xs.map((s) => s.length));
  const catW = clamp(CHAR * longest(data.map((r) => String(r[X]))) + 12, 32, 160);
  const endW = labels === "none" ? 8 : clamp(CHAR * longest(data.map(gapText)) + 14, 40, 200);
  const n = data.length;
  const height = horizontal ? TOP + n * ROW + AXIS : props.height || 280;
  const valueLo = horizontal ? catW : TOP + (labels === "none" ? 0 : 16);
  const valueHi = horizontal ? width - endW : height - AXIS - 8;
  const axisW = horizontal ? 0 : clamp(CHAR * longest(values.map((v) => fmt(v))) + 12, 36, 96);
  const extent = [...values, ...refValues];
  const lo = extent.length ? Math.min(...extent) : 0;
  const hi = extent.length ? Math.max(...extent) : 1;
  const v = scaleLinear()
    .domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi])
    .nice()
    .range(horizontal ? [valueLo, valueHi] : [valueHi, valueLo]);
  const band = horizontal ? ROW : (width - axisW) / Math.max(1, n);
  const centre = (i: number) => (horizontal ? TOP + i * ROW + ROW / 2 : axisW + i * band + band / 2);
  /** (category position, value position) → (x, y), whichever way the chart lies. */
  const at = (c: number, val: number) => (horizontal ? { x: val, y: c } : { x: c, y: val });
  const ticks = v.ticks(clamp(Math.floor(Math.abs(valueHi - valueLo) / (horizontal ? 80 : 48)), 2, 8));

  const move = (e: KeyboardEvent, i: number) => {
    const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: n - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    const j = clamp(next, 0, n - 1);
    setFocus(j);
    rowRefs.current[j]?.focus();
  };

  const describe = (r: Point) =>
    `${r[X]}: ${a.label} ${r[a.key] == null ? "no value" : fmt(r[a.key])}, ${b.label} ${r[b.key] == null ? "no value" : fmt(r[b.key])}, gap ${gapText(r)}`;
  const tip = active != null ? data[active] : null;
  const tipAt = tip ? [tip[a.key], tip[b.key]].filter((x): x is number => typeof x === "number").map((x) => v(x)) : [];
  // Anchored on the row's outer dot; kept inside the plot (above the axis), so the card never clips it.
  const anchor = tip && active != null ? at(centre(active), tipAt.length ? (horizontal ? Math.max(...tipAt) : Math.min(...tipAt)) : valueLo) : null;
  const plotBox: Box = { w: width, h: horizontal ? TOP + n * ROW : height - AXIS };
  const tipPos = anchor ? placeTip(anchor, tipSize, plotBox) : null;
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el) return;
    const next = { w: el.offsetWidth, h: el.offsetHeight };
    if (next.w > 0 && next.h > 0 && (next.w !== tipSize.w || next.h !== tipSize.h)) setTipSize(next);
  }, [active, tipSize]);

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {series.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <Swatch mark={scale?.type === "diverging" ? { fill: "var(--muted-foreground)", hollow: i === 0 } : mark(i, 0)} />
            <span className="text-foreground">{s.label}</span>
          </li>
        ))}
        {scale?.type === "diverging" && <ScaleLegend scale={scale} domain={scaleDomain} fmt={fmt} />}
      </ul>
      <div ref={ref} className="relative w-full" onPointerLeave={() => setActive(null)}>
        <svg
          width={width}
          height={height}
          role="list"
          aria-label={`${a.label} and ${b.label} by ${props.xName}`}
          className="block overflow-visible tabular-nums"
          style={{ fontSize: font }}
          data-chart-kind="dumbbell"
        >
          {/* Gridlines: solid hairlines one step off the surface. */}
          <g aria-hidden data-part="grid">
            {ticks.map((t) => {
              const p = v(t);
              return horizontal ? (
                <line key={t} x1={p} x2={p} y1={TOP} y2={TOP + n * ROW} stroke="var(--border)" strokeWidth={1} />
              ) : (
                <line key={t} x1={axisW} x2={width} y1={p} y2={p} stroke="var(--border)" strokeWidth={1} />
              );
            })}
          </g>
          <g aria-hidden data-part="axis" className="fill-muted-foreground tabular-nums">
            {ticks.map((t) =>
              horizontal ? (
                <text key={t} x={v(t)} y={TOP + n * ROW + 15} textAnchor="middle">
                  {fmt(t)}
                </text>
              ) : (
                <text key={t} x={axisW - 6} y={v(t)} textAnchor="end" dominantBaseline="middle">
                  {fmt(t)}
                </text>
              ),
            )}
          </g>
          {/* Reference lines: solid hairlines in a text token, labelled in text, never data colour. */}
          <g data-part="refs">
            {refs.map((r, k) => {
              if (r.axis === "y" && typeof r.value === "number") {
                const p = v(r.value);
                return (
                  <g key={k} className="ui-ref">
                    {horizontal ? (
                      <line x1={p} x2={p} y1={TOP - 4} y2={TOP + n * ROW} stroke="var(--muted-foreground)" strokeWidth={1} />
                    ) : (
                      <line x1={axisW} x2={width} y1={p} y2={p} stroke="var(--muted-foreground)" strokeWidth={1} />
                    )}
                    {r.label && (
                      <text
                        x={horizontal ? p : width - 4}
                        y={horizontal ? TOP - 8 : p - 4}
                        textAnchor={horizontal ? "middle" : "end"}
                        className="fill-muted-foreground"
                      >
                        {r.label}
                      </text>
                    )}
                  </g>
                );
              }
              const i = data.findIndex((row) => row[X] === String(r.value));
              if (r.axis !== "x" || i < 0) return null;
              const c = centre(i) + (horizontal ? -ROW / 2 : -band / 2);
              return (
                <g key={k} className="ui-ref">
                  {horizontal ? (
                    <line x1={catW} x2={width - endW} y1={c} y2={c} stroke="var(--muted-foreground)" strokeWidth={1} />
                  ) : (
                    <line x1={c} x2={c} y1={TOP} y2={height - AXIS} stroke="var(--muted-foreground)" strokeWidth={1} />
                  )}
                  {r.label && (
                    <text
                      x={horizontal ? width - endW : c + 4}
                      y={horizontal ? c - 3 : TOP - 6}
                      textAnchor={horizontal ? "end" : "start"}
                      className="fill-muted-foreground"
                    >
                      {r.label}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
          {data.map((r, i) => {
            const c = centre(i);
            const va = r[a.key];
            const vb = r[b.key];
            const pa = typeof va === "number" ? at(c, v(va)) : null;
            const pb = typeof vb === "number" ? at(c, v(vb)) : null;
            const end = horizontal ? { x: width - endW + 8, y: c } : { x: c, y: Math.min(pa?.y ?? Infinity, pb?.y ?? Infinity) - 12 };
            const on = active === i;
            return (
              <g
                key={i}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                role="listitem"
                tabIndex={i === Math.min(focus, n - 1) ? 0 : -1}
                aria-label={describe(r)}
                aria-describedby={on ? tipId : undefined}
                data-row={String(r[X])}
                className="outline-none"
                onPointerEnter={() => setActive(i)}
                onFocus={() => {
                  setActive(i);
                  setFocus(i);
                }}
                onBlur={() => setActive(null)}
                onKeyDown={(e) => move(e, i)}
              >
                {/* The row's hit target: the whole band, ~28px, not the 8px dots. */}
                <rect
                  x={horizontal ? 0 : c - band / 2}
                  y={horizontal ? c - ROW / 2 : TOP}
                  width={horizontal ? width : band}
                  height={horizontal ? ROW : height - TOP - AXIS}
                  fill={on ? "var(--muted)" : "transparent"}
                  fillOpacity={on ? 0.6 : 0}
                  stroke={on ? "var(--ring)" : "none"}
                  strokeWidth={on ? 1 : 0}
                  rx={4}
                  data-part="hit"
                />
                <text
                  x={horizontal ? catW - 8 : c}
                  y={horizontal ? c : height - AXIS + 14}
                  textAnchor={horizontal ? "end" : "middle"}
                  dominantBaseline={horizontal ? "middle" : undefined}
                  className="fill-foreground"
                >
                  {String(r[X])}
                </text>
                {pa && pb && (
                  <line
                    x1={pa.x}
                    y1={pa.y}
                    x2={pb.x}
                    y2={pb.y}
                    stroke="var(--muted-foreground)"
                    strokeOpacity={0.55}
                    strokeWidth={2}
                    strokeLinecap="round"
                    data-part="connector"
                  />
                )}
                {pa && <Dot cx={pa.x} cy={pa.y} mark={mark(0, va as number)} className="ui-dot-a" />}
                {pb && <Dot cx={pb.x} cy={pb.y} mark={mark(1, vb as number)} className="ui-dot-b" />}
                {labels !== "none" && (
                  <text
                    x={end.x}
                    y={end.y}
                    textAnchor={horizontal ? "start" : "middle"}
                    dominantBaseline={horizontal ? "middle" : undefined}
                    className="fill-foreground font-medium tabular-nums"
                    data-part="gap"
                  >
                    {gapText(r)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {tip && tipPos && (
          <div
            ref={tipRef}
            id={tipId}
            role="tooltip"
            data-place={`${tipPos.x} ${tipPos.y}`}
            className="pointer-events-none absolute z-10 grid min-w-36 gap-1 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
            style={{ left: tipPos.left, top: tipPos.top }}
          >
            <div className="font-medium">{String(tip[X])}</div>
            {series.map((s, i) => (
              <div key={s.key} className="flex items-center gap-2">
                <span className={cn("h-0.5 w-3 shrink-0 rounded")} style={{ background: mark(i, num(tip[s.key])).fill }} />
                <span className="font-mono font-medium text-foreground tabular-nums">{tip[s.key] == null ? "–" : fmt(tip[s.key])}</span>
                <span className="text-muted-foreground">{s.label}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 border-t pt-1">
              <span className="font-mono font-medium text-foreground tabular-nums">{gap(tip) == null ? "–" : gapFmt(gap(tip)!)}</span>
              <span className="text-muted-foreground">gap</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The diverging scale's bins, low to high, with their ranges: a continuous colour never goes without a legend. */
function ScaleLegend({ scale, domain, fmt }: { scale: Scale; domain: [number, number]; fmt: (v: unknown) => string }) {
  const colors = binColors(scale, true);
  const own = scale.unit ? formatter(scale.unit) : fmt;
  const unitFmt = (x: number) => own(Math.round(x * 10) / 10);
  return (
    <li className="flex items-center gap-1.5" aria-label="Colour scale">
      <span className="flex">
        {colors.map((c, i) => {
          const [from, to] = binRange(scale, domain, i);
          return (
            <span
              key={i}
              className="h-2.5 w-4 first:rounded-l-sm last:rounded-r-sm"
              style={{ background: c }}
              title={`${unitFmt(from)} to ${unitFmt(to)}`}
            />
          );
        })}
      </span>
      <span className="tabular-nums">
        {unitFmt(domain[0])} to {unitFmt(domain[1])}
      </span>
    </li>
  );
}
