// What a legend says, kept pure: the label of each colour bin (open-ended at a clamped end) and
// the three circle sizes of a bubble legend.
import { binRange, type Scale } from "@/components/ui-blocks/scale";

/** One decimal at most, so bin edges read as 2.5, not 2.4999999. */
export const tidy = (x: number) => Math.round(x * 10) / 10;

/** Decimals for bin edges: none when a bin spans 5 or more, one from 0.5, else two. */
export const binDecimals = (domain: [number, number], bins: number) => {
  const w = Math.abs(domain[1] - domain[0]) / Math.max(1, bins);
  return w >= 5 ? 0 : w >= 0.5 ? 1 : 2;
};
/** A bin edge rounded to the decimals its bins need. */
export const edge = (x: number, decimals: number) => {
  const r = Math.round(x * 10 ** decimals) / 10 ** decimals;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * A label per bin, low to high: "lo to hi" (`sep` between), edges rounded to what the bin width
 * needs. When values were clamped into an end bin (they lie past the domain), that end is open:
 * "< lo" for the first, "> hi" for the last.
 */
export function binLabels(
  scale: Scale,
  domain: [number, number],
  fmt: (v: number) => string,
  open: { below?: boolean; above?: boolean } = {},
  sep = " to ",
): string[] {
  const d = binDecimals(domain, scale.bins);
  return Array.from({ length: scale.bins }, (_, i) => {
    const [from, to] = binRange(scale, domain, i);
    if (i === 0 && open.below) return `< ${fmt(edge(to, d))}`;
    if (i === scale.bins - 1 && open.above) return `> ${fmt(edge(from, d))}`;
    return `${fmt(edge(from, d))}${sep}${fmt(edge(to, d))}`;
  });
}

/** A 1, 2 or 5 times a power of ten at or under `v`. */
function niceFloor(v: number): number {
  if (v <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

/**
 * Three round values for a bubble size legend, largest first: the biggest nice value at or under
 * the max, then about a half and a tenth of it (distinct, all above zero). Fewer for tiny ranges.
 */
export function sizeLegendValues(max: number): number[] {
  if (!(max > 0)) return [];
  const top = niceFloor(max);
  const out = [top, niceFloor(top / 2), niceFloor(top / 10)].filter((v, i, a) => v > 0 && a.indexOf(v) === i);
  return out;
}
