// The `chart` primitive's props, read from untrusted JSON into fixed shapes. Pure, so the
// rules (defaults per kind, sorting, folding, caps) are tested without a renderer.
import { scaleLinear } from "d3-scale";
import { asArray, asNumber, isObj, optText, show } from "@/lib/narrow";

export type Kind = "bar" | "line" | "area" | "dumbbell";
/** `key` is our own slot name; the agent's field names are only ever shown as text, never used as a key, class or id. */
export type Series = { key: string; label: string };
export type Point = Record<string, string | number | null>;
/** `axis: "y"` is a value (a target, zero), `"x"` a category or x value, whichever way the chart lies. */
export type Ref = { axis: "x" | "y"; value: number | string; label?: string };
export type Labels = "ends" | "none" | "all";
export type Sort = "none" | "value" | "gap";
export type Orientation = "vertical" | "horizontal";

export const X = "x";
export const MAX_SERIES = 5;
/** Rows drawn at most (Rust refuses more; this keeps a bound value in check too). */
export const MAX_ROWS = 2000;
export const MAX_REFS = 20;
const LABEL_MAX = 40;

export function readKind(v: unknown): Kind {
  return v === "bar" || v === "area" || v === "dumbbell" ? v : "line";
}

/** Series as the agent named them: `"field"` or `{ key, label }`. */
export function namedSeries(rawSeries: unknown): { field: string; label: string }[] {
  return asArray(rawSeries).flatMap((s): { field: string; label: string }[] => {
    if (typeof s === "string") return [{ field: s, label: s }];
    if (isObj(s) && typeof s.key === "string") return [{ field: s.key, label: optText(s.label) ?? s.key }];
    return [];
  });
}

/**
 * The agent's rows and series, rekeyed onto fixed names: `x` for the category
 * and `series-N` per series, values as numbers (null leaves a gap). Field
 * names can then hold anything (dots, spaces, braces) without reaching
 * a path lookup, CSS or an id.
 */
export function normalise(rawData: unknown, rawSeries: unknown, x: string): { data: Point[]; series: Series[] } {
  const named = namedSeries(rawSeries);
  const series = named.map((s, i) => ({ key: `series-${i}`, label: s.label }));
  const data = asArray(rawData)
    .slice(0, MAX_ROWS)
    .filter(isObj)
    .map((r) => {
      const p: Point = { [X]: show(r[x]) };
      named.forEach((s, i) => (p[series[i].key] = asNumber(r[s.field]) ?? null));
      return p;
    });
  return { data, series };
}

export const num = (v: unknown) => (typeof v === "number" ? v : 0);

/**
 * Keep the 4 biggest series (by total size, in their given order) and fold the rest
 * into "Other" — never a 6th hue. Stacked charts sum the rest (parts of a whole);
 * otherwise "Other" is their average, so it doesn't dwarf the lines it sits beside.
 */
export function fold(data: Point[], series: Series[], stacked: boolean): { data: Point[]; series: Series[] } {
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
/** Symbols and magnitude suffixes that attach to the number: 16k, 2.5M, 77%, 30°, 21°C, 3x. */
const ATTACHED = /^(?:[kKMBT]|bn|%|‰|°[CFK]?|x|×)$/;
const MAGNITUDE = /^(?:[kKMBT]|bn)$/;

/**
 * Where a unit goes. A currency symbol leads ($12); a symbol or magnitude suffix attaches (16k,
 * 77%, 30°); a unit the agent wrote with its own leading space keeps it (" pts" → 12 pts); any
 * other word gets one space (ms → 42 ms).
 */
export function withUnit(n: string, unit: string | undefined, negative = false): string {
  if (!unit) return n;
  if (CURRENCY.has(unit)) return negative ? `-${unit}${n.slice(1)}` : `${unit}${n}`;
  // Nothing of a magnitude is just 0 ("0k" reads as a typo).
  if (n === "0" && MAGNITUDE.test(unit)) return n;
  if (unit.startsWith(" ") || ATTACHED.test(unit)) return `${n}${unit}`;
  return `${n} ${unit}`;
}

/** Compact big numbers (1.2M), keep small ones readable, and place the unit (withUnit). */
export function formatter(unit?: string) {
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const plain = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  return (v: unknown) => {
    if (typeof v !== "number") return show(v);
    const n = Math.abs(v) >= 10_000 ? compact.format(v) : plain.format(v);
    return withUnit(n, unit, v < 0);
  };
}

/** A difference: always signed, so "+2.2 pts" reads as a shift and "0" as none. */
export const signed = (fmt: (v: unknown) => string) => (v: number) => (v > 0 ? `+${fmt(v)}` : fmt(v));

/** Reference lines: `{ axis, value, label? }`, at most 20, labels as short text. */
export function readRefs(raw: unknown): Ref[] {
  return asArray(raw)
    .flatMap((r): Ref[] => {
      if (!isObj(r) || (r.axis !== "x" && r.axis !== "y")) return [];
      const value = typeof r.value === "number" && Number.isFinite(r.value) ? r.value : typeof r.value === "string" ? r.value : null;
      if (value == null) return [];
      const label = optText(r.label)?.slice(0, LABEL_MAX);
      return [{ axis: r.axis, value, label }];
    })
    .slice(0, MAX_REFS);
}

/** Direct labels. Selective by default: line, area and dumbbell label their ends; bars carry none (the axis reads them). */
export function readLabels(raw: unknown, kind: Kind): Labels {
  if (raw === "ends" || raw === "none" || raw === "all") return raw;
  return kind === "bar" ? "none" : "ends";
}

/**
 * Which way it lies. Asked for, it is honoured for bar and dumbbell; otherwise a dumbbell lies on its
 * side, and bars do when a category name is too long to sit under a column (names under columns would
 * collide, and every bar must be labelled). Lines and areas always run left to right.
 */
export function readOrientation(raw: unknown, kind: Kind, data: Point[]): Orientation {
  if (kind === "line" || kind === "area") return "vertical";
  if (raw === "vertical" || raw === "horizontal") return raw;
  if (kind === "dumbbell") return "horizontal";
  return data.some((r) => show(r[X]).length > 8) ? "horizontal" : "vertical";
}

/** Row order. `value`: biggest first (bars by total; a dumbbell by its second series). `gap`: a dumbbell's widest gap first. */
export function readSort(raw: unknown, kind: Kind): Sort {
  if (raw === "value" && (kind === "bar" || kind === "dumbbell")) return "value";
  if (raw === "gap" && kind === "dumbbell") return "gap";
  return "none";
}

export function sortRows(data: Point[], series: Series[], sort: Sort, kind: Kind): Point[] {
  if (sort === "none" || !series.length) return data;
  const [a, b] = series;
  const key =
    sort === "gap" && b
      ? (r: Point) => (r[a.key] == null || r[b.key] == null ? -1 : Math.abs(num(r[b.key]) - num(r[a.key])))
      : kind === "dumbbell" && b
        ? (r: Point) => num(r[b.key])
        : (r: Point) => series.reduce((n, s) => n + num(r[s.key]), 0);
  // Stable: equal rows keep the agent's order.
  return data
    .map((r, i) => [r, i] as const)
    .sort(([p, i], [q, j]) => key(q) - key(p) || i - j)
    .map(([r]) => r);
}

/** `domain: [low, high]`, two finite numbers with low < high, else none. */
export function readDomain(raw: unknown): [number, number] | undefined {
  const d = asArray(raw).map(asNumber);
  return d.length === 2 && d[0] != null && d[1] != null && d[0] < d[1] ? [d[0], d[1]] : undefined;
}

/**
 * The value axis. Bars, stacks and `zero: true` start at zero: their length or height is the
 * value. Lines and unstacked areas fit the data (with any reference lines and the agent's
 * `domain`), padded out to the next nice tick, so a trend from 100 to 118 runs 100–120 instead of
 * being squashed into the top of a chart that starts at 0 (95–120 when a ref sits at 100, so the
 * line isn't on the plot's border); data that crosses zero includes it.
 */
export function valueAxis(o: {
  kind: Kind;
  stacked: boolean;
  data: Point[];
  series: Series[];
  refs: Ref[];
  zero?: boolean;
  domain?: [number, number];
  ticks?: number;
}): { domain: [number, number]; ticks: number[]; zeroBased: boolean } {
  const count = o.ticks ?? 5;
  const values: number[] = [];
  for (const r of o.data) {
    if (o.stacked) {
      let up = 0;
      let down = 0;
      for (const s of o.series) {
        const v = num(r[s.key]);
        if (v < 0) down += v;
        else up += v;
      }
      values.push(up, down);
    } else for (const s of o.series) if (typeof r[s.key] === "number") values.push(r[s.key] as number);
  }
  for (const r of o.refs) if (r.axis === "y" && typeof r.value === "number") values.push(r.value);
  if (o.domain) values.push(...o.domain);
  const zeroBased = o.kind === "bar" || o.stacked || !!o.zero;
  let lo = values.length ? Math.min(...values) : 0;
  let hi = values.length ? Math.max(...values) : 1;
  if (zeroBased) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  // A flat series still gets a range around it.
  if (lo === hi) [lo, hi] = lo === 0 ? [0, 1] : [lo - Math.abs(lo) * 0.05, hi + Math.abs(hi) * 0.05];
  const scale = scaleLinear().domain([lo, hi]).nice(count);
  let [a, b] = scale.domain();
  let ticks = scale.ticks(count);
  // A reference line on the plot's edge would sit on its border (Start 100 under the first point): one more step.
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : 0;
  const onEdge = (v: number) => o.refs.some((r) => r.axis === "y" && r.value === v);
  if (step && !o.domain && !(zeroBased && a === 0) && onEdge(a)) [a, ticks] = [a - step, [a - step, ...ticks]];
  if (step && !o.domain && !(zeroBased && b === 0) && onEdge(b)) [b, ticks] = [b + step, [...ticks, b + step]];
  return { domain: [a, b], ticks, zeroBased };
}
