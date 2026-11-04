// The shared `scale` prop: how a value becomes a colour, for the dumbbell today and maps
// later. `{ type, domain?, midpoint?, bins?, unit? }`, read from untrusted props. Colours are
// only ever theme tokens (`var(--scale-*)`, `var(--chart-*)`), never a value the agent sent.
import { scaleLinear } from "d3-scale";
import { asArray, asNumber, isObj, optText } from "@/lib/narrow";

export type ScaleType = "sequential" | "diverging" | "categorical";
export type Scale = {
  type: ScaleType;
  domain?: [number, number];
  midpoint?: number;
  /** Colour classes, 2–7 (the dataviz limit; past 7 adjacent classes blur). */
  bins: number;
  unit?: string;
};

export const MAX_BINS = 7;
const SEQ = [100, 200, 300, 400, 500, 600, 700];
const ARM = ["1", "2", "3"];

/** The `scale` prop, or null when absent or not a scale. Out-of-range bins are clamped. */
export function readScale(raw: unknown): Scale | null {
  if (!isObj(raw)) return null;
  const type = raw.type === "sequential" || raw.type === "diverging" || raw.type === "categorical" ? raw.type : null;
  if (!type) return null;
  const d = asArray(raw.domain).map(asNumber);
  const domain: [number, number] | undefined = d.length === 2 && d[0] != null && d[1] != null && d[0] < d[1] ? [d[0], d[1]] : undefined;
  const bins = Math.round(asNumber(raw.bins) ?? (type === "diverging" ? 7 : 5));
  return {
    type,
    domain,
    midpoint: asNumber(raw.midpoint),
    bins: Math.max(2, Math.min(MAX_BINS, bins)),
    unit: optText(raw.unit),
  };
}

/** `n` of `of` steps, spread evenly: both ends from two up, the middle one alone. */
const spread = <T>(of: T[], n: number): T[] =>
  n >= of.length
    ? of
    : n === 1
      ? [of[Math.floor(of.length / 2)]]
      : Array.from({ length: n }, (_, i) => of[Math.round((i * (of.length - 1)) / (n - 1))]);

/** Small marks (dots) take at most this many bins: only the ramp steps that hold 3:1 on either surface. */
export const MARK_BINS = 5;

/**
 * The colour of each bin, low to high, as CSS. For areas (map regions) every step is used, the
 * palest receding toward the surface. For small marks (`marks`), the pale steps would vanish, so
 * bins are capped at 5: each arm uses its two stronger steps and the middle is the muted text gray.
 */
export function binColors(s: Scale, marks = false): string[] {
  if (s.type === "categorical") return Array.from({ length: Math.min(s.bins, 5) }, (_, i) => `var(--chart-${i + 1})`);
  if (s.type === "sequential") return spread(marks ? SEQ.slice(3) : SEQ, s.bins).map((k) => `var(--scale-seq-${k})`);
  // Diverging: equal steps per arm, the gray midpoint only when the bin count is odd.
  const arm = spread(marks ? ARM.slice(1) : ARM, Math.floor(s.bins / 2));
  const mid = s.bins % 2 ? [marks ? "var(--muted-foreground)" : "var(--scale-div-mid)"] : [];
  return [...[...arm].reverse().map((k) => `var(--scale-div-neg-${k})`), ...mid, ...arm.map((k) => `var(--scale-div-pos-${k})`)];
}

/** The domain to bin over: the agent's, else the data's extent; diverging is made symmetric about its midpoint. */
export function domainOf(s: Scale, values: number[]): [number, number] {
  if (s.domain) return s.domain;
  if (!values.length) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (s.type === "diverging") {
    const m = s.midpoint ?? 0;
    const r = Math.max(Math.abs(lo - m), Math.abs(hi - m)) || 1;
    return [m - r, m + r];
  }
  return lo === hi ? [lo, lo + 1] : [lo, hi];
}

/** Which bin a value falls in: equal-width bins over the domain, split at the midpoint when diverging. */
export function binOf(s: Scale, domain: [number, number], value: number): number {
  const [lo, hi] = domain;
  const m = s.type === "diverging" ? Math.min(hi, Math.max(lo, s.midpoint ?? (lo + hi) / 2)) : (lo + hi) / 2;
  const u = scaleLinear().domain([lo, m, hi]).range([0, 0.5, 1]).clamp(true)(value);
  return Math.min(s.bins - 1, Math.floor(u * s.bins));
}

/** Bin `i`'s range, for the legend. */
export function binRange(s: Scale, domain: [number, number], i: number): [number, number] {
  const [lo, hi] = domain;
  const m = s.type === "diverging" ? Math.min(hi, Math.max(lo, s.midpoint ?? (lo + hi) / 2)) : (lo + hi) / 2;
  const back = scaleLinear().domain([0, 0.5, 1]).range([lo, m, hi]);
  return [back(i / s.bins), back((i + 1) / s.bins)];
}

/** A value's colour on the scale, as CSS (`marks`: for dots, see binColors). */
export function colorOf(s: Scale, domain: [number, number], value: number, marks = false): string {
  return binColors(s, marks)[binOf(s, domain, value)] ?? "var(--muted-foreground)";
}

/** The scale as small marks can carry it: at most 5 bins. */
export const forMarks = (s: Scale): Scale => ({ ...s, bins: Math.min(s.bins, MARK_BINS) });

/** The `p`-quantile of sorted values (linear between neighbours, as d3.quantile). */
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  return lo + 1 < sorted.length ? sorted[lo] + (sorted[lo + 1] - sorted[lo]) * (i - lo) : sorted[lo];
}

/** Values from which an unset domain is fenced (Tukey), below that it is the extent. */
export const FENCE_MIN = 8;

/**
 * The domain a map bins over, so one extreme value can't wash out the rest. The agent's
 * `domain` when given; else, from 8 values up, Tukey's fences (Q1 − 1.5 IQR, Q3 + 1.5 IQR) cut to
 * the data, else the extent (domainOf). Values past it are clamped into the end bins, which the
 * legend then labels open-ended. `clipped` says the fences cut the extent; `below`/`above` say
 * values lie past either end.
 */
export function fencedDomain(s: Scale, values: number[]): { domain: [number, number]; clipped: boolean; below: boolean; above: boolean } {
  const past = (d: [number, number]) => ({ below: values.some((v) => v < d[0]), above: values.some((v) => v > d[1]) });
  if (s.domain || values.length < FENCE_MIN || s.type === "categorical") {
    const domain = domainOf(s, values);
    return { domain, clipped: false, ...past(domain) };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  let lo = Math.max(min, q1 - 1.5 * iqr);
  let hi = Math.min(max, q3 + 1.5 * iqr);
  if (!(hi > lo)) [lo, hi] = [min, max];
  // Round ends, so the legend reads 40–100 rather than 42.3–99; a diverging one stays even about its midpoint.
  let domain = scaleLinear()
    .domain(lo === hi ? [lo, lo + 1] : [lo, hi])
    .nice(s.bins)
    .domain() as [number, number];
  if (s.type === "diverging") {
    const m = s.midpoint ?? 0;
    const r = Math.max(Math.abs(domain[0] - m), Math.abs(domain[1] - m)) || 1;
    domain = [m - r, m + r];
  }
  const flags = past(domain);
  return { domain, clipped: flags.below || flags.above, ...flags };
}
