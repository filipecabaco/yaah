// A value axis drawn by React: solid hairline gridlines one step off the surface, and one-line
// tick labels in the muted text token. The ticks come from `linearAxis` (ticks.ts).

/** Gridlines at each tick: `vertical` lines run from `from` to `to` in y, `horizontal` ones in x. */
export function Grid({
  ticks,
  at,
  lines,
  from,
  to,
}: {
  ticks: number[];
  at: (t: number) => number;
  lines: "vertical" | "horizontal";
  from: number;
  to: number;
}) {
  return (
    <g aria-hidden data-part="grid">
      {ticks.map((t) => {
        const p = at(t);
        return lines === "vertical" ? (
          <line key={t} x1={p} x2={p} y1={from} y2={to} stroke="var(--border)" strokeWidth={1} />
        ) : (
          <line key={t} x1={from} x2={to} y1={p} y2={p} stroke="var(--border)" strokeWidth={1} />
        );
      })}
    </g>
  );
}

/** Tick labels: under the plot at y `offset` (`bottom`), or right-aligned at x `offset` (`left`). */
export function AxisLabels({
  ticks,
  at,
  fmt,
  side,
  offset,
}: {
  ticks: number[];
  at: (t: number) => number;
  fmt: (v: unknown) => string;
  side: "bottom" | "left";
  offset: number;
}) {
  return (
    <g aria-hidden data-part="axis" className="fill-muted-foreground tabular-nums">
      {ticks.map((t) =>
        side === "bottom" ? (
          <text key={t} x={at(t)} y={offset} textAnchor="middle">
            {fmt(t)}
          </text>
        ) : (
          <text key={t} x={offset} y={at(t)} textAnchor="end" dominantBaseline="middle">
            {fmt(t)}
          </text>
        ),
      )}
    </g>
  );
}
