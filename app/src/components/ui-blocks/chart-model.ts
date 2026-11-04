// The `chart` primitive's props, read from untrusted JSON into fixed shapes. Pure, so the
// rules (defaults per kind, sorting, folding, caps) are tested without a renderer.
import { asArray, asNumber, isObj, optText, show } from "@/lib/narrow";

export type Kind = "bar" | "line" | "area" | "dumbbell";
/** `key` is our own slot name; the agent's field names never reach CSS (shadcn writes config keys into a <style>). */
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
 * Recharts' path lookup or the chart's CSS variables.
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

/** Compact big numbers (1.2M), keep small ones readable, and place the unit. */
export function formatter(unit?: string) {
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
 * side, and bars do when a category name is too long to sit under a column (Recharts would drop the
 * ones that collide, and every bar must be labelled). Lines and areas always run left to right.
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
