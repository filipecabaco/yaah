// Legends for every figure: series or groups (a swatch and a name), a colour scale (the bins,
// with their ranges), and bubble sizes (nested circles on one baseline). A colour or a size never
// goes without one. Text is in text tokens; only the swatch wears the colour.
import type { ReactNode } from "react";
import { binColors, binRange, type Scale } from "@/components/ui-blocks/scale";
import { formatter } from "@/components/ui-blocks/chart-model";
import { binLabels, tidy } from "@/components/ui-blocks/viz/legend-model";
import { cn } from "@/lib/utils";

/** The legend row: wraps, muted text, named for assistive tech. */
export function Legend({ children, className, label = "Legend" }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground", className)} aria-label={label}>
      {children}
    </ul>
  );
}

export function LegendItem({ swatch, label, extra }: { swatch: ReactNode; label: ReactNode; extra?: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      {swatch}
      <span className="text-foreground">{label}</span>
      {extra}
    </li>
  );
}

/** A square swatch in a colour (categorical groups, tones). */
export function SquareSwatch({ fill, pattern }: { fill: string; pattern?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("size-2.5 shrink-0 rounded-[2px]", pattern && "ui-hatch border border-[var(--map-hatch)]")}
      style={pattern ? undefined : { background: fill }}
    />
  );
}

/** Compact: the bins as one strip and the domain's ends (the dumbbell's diverging scale). */
export function ScaleLegend({
  scale,
  domain,
  fmt,
  marks = true,
}: {
  scale: Scale;
  domain: [number, number];
  fmt: (v: unknown) => string;
  marks?: boolean;
}) {
  const colors = binColors(scale, marks);
  const own = scale.unit ? formatter(scale.unit) : fmt;
  const unitFmt = (x: number) => own(tidy(x));
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

/** Units that sit on the number (77%, 16k, $12); any other is said once, after the bins. */
const ATTACHED = /^(?:[kKMBT]|bn|%|‰|°[CFK]?|x|×|[$€£¥])$/;

/**
 * Full: a title, one swatch per bin with its range under it (open-ended at a clamped end, edges
 * rounded to what the bins need), the diverging midpoint marked, a hatched "no data" swatch, and a
 * footer (why the scale was clipped). A worded unit (" pts", "M EUR") is said once, not per bin.
 */
export function BinLegend(props: {
  scale: Scale;
  domain: [number, number];
  unit?: string;
  title?: string;
  open?: { below?: boolean; above?: boolean };
  noData?: string;
  /** A plain land swatch and its words: regions drawn outside the data (a choropleth's `missing: "land"`). */
  land?: string;
  /** The land swatch as an outline on the surface (land drawn that way so it can't pass for a gray middle class). */
  landOutline?: boolean;
  footer?: string;
  marks?: boolean;
}) {
  const { scale, domain, unit, title, open, noData, land, landOutline = false, footer, marks = false } = props;
  const colors = binColors(scale, marks);
  const attached = !!unit && ATTACHED.test(unit.trim());
  const fmt = formatter(attached ? unit.trim() : undefined);
  // A true minus, and "to" between edges once one is negative ("−21 to −13" reads; "-21–-13" doesn't).
  const num = (v: number) => fmt(v).replace(/^-/, "−");
  const shown = binLabels(scale, domain, num, open, domain[0] < 0 ? " to " : "–");
  const spoken = binLabels(scale, domain, num, open);
  const mid = scale.type === "diverging" && scale.bins % 2 === 1 ? Math.floor(scale.bins / 2) : -1;
  return (
    <div role="group" aria-label="Colour scale" className="flex flex-col gap-1 text-xs text-muted-foreground" data-part="bin-legend">
      {title && <div className="font-medium text-foreground">{title}</div>}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <ol className="flex items-start">
          {colors.map((c, i) => (
            <li
              key={i}
              className="flex min-w-12 flex-col gap-0.5"
              aria-label={`${i + 1} of ${colors.length}: ${spoken[i]}${unit && !attached ? ` ${unit.trim()}` : ""}${i === mid ? " (midpoint)" : ""}`}
            >
              <span
                className={cn(
                  "h-2.5 w-full",
                  i === 0 && "rounded-l-sm",
                  i === colors.length - 1 && "rounded-r-sm",
                  i === mid && "ring-1 ring-foreground ring-inset",
                )}
                style={{ background: c }}
              />
              <span className="pr-2 text-2xs leading-tight whitespace-nowrap tabular-nums" aria-hidden>
                {shown[i]}
              </span>
            </li>
          ))}
        </ol>
        {unit && !attached && <span className="self-end text-2xs">{unit.trim()}</span>}
        {noData && (
          <div className="flex min-w-12 flex-col gap-0.5" data-part="no-data">
            <span className="ui-hatch h-2.5 w-full rounded-sm border border-[var(--map-hatch)]" />
            <span className="text-2xs leading-tight whitespace-nowrap">{noData}</span>
          </div>
        )}
        {land && (
          <div className="flex min-w-12 flex-col gap-0.5" data-part="land">
            <span
              className={cn(
                "h-2.5 w-full rounded-sm border border-[var(--map-stroke)]",
                landOutline ? "bg-[var(--chart-surface)]" : "bg-[var(--map-land)]",
              )}
            />
            <span className="text-2xs leading-tight whitespace-nowrap">{land}</span>
          </div>
        )}
      </div>
      {footer && <div className="text-2xs">{footer}</div>}
    </div>
  );
}

/**
 * Bubble sizes: nested circles sharing a bottom baseline, each with a dashed leader to its value,
 * drawn with the map's own radius function so the legend reads true.
 */
export function SizeLegend({
  values,
  radius,
  fmt,
  title,
}: {
  values: number[];
  radius: (v: number) => number;
  fmt: (v: number) => string;
  title?: string;
}) {
  if (!values.length) return null;
  const big = radius(values[0]);
  const labelX = big * 2 + 10;
  const w = labelX + 8 + Math.max(...values.map((v) => fmt(v).length)) * 7;
  const h = big * 2 + 4;
  return (
    <div role="group" aria-label="Size scale" className="flex flex-col gap-1 text-xs text-muted-foreground" data-part="size-legend">
      {title && <div className="font-medium text-foreground">{title}</div>}
      <svg width={w} height={h} aria-hidden className="overflow-visible" style={{ fontSize: 11 }}>
        {values.map((v) => {
          const r = radius(v);
          const cy = h - 2 - r;
          return (
            <g key={v}>
              <circle cx={big} cy={cy} r={r} fill="none" stroke="var(--muted-foreground)" strokeWidth={1} />
              <line x1={big} x2={labelX} y1={cy - r} y2={cy - r} stroke="var(--muted-foreground)" strokeDasharray="2 2" strokeWidth={1} />
              <text x={labelX + 4} y={cy - r} dominantBaseline="middle" className="fill-muted-foreground tabular-nums">
                {fmt(v)}
              </text>
            </g>
          );
        })}
      </svg>
      <span className="sr-only">{values.map((v) => fmt(v)).join(", ")}</span>
    </div>
  );
}
