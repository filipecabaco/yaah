// Axis ticks for React-drawn charts: d3-scale picks the values, React draws them (no d3-axis,
// no d3-selection). Pure, so the choice is tested without a renderer.
import { scaleLinear, type ScaleLinear } from "d3-scale";

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** How many ticks fit along `span` px with one every `every` px: 2 at least, 8 at most. */
export const tickCount = (span: number, every: number, min = 2, max = 8) => clamp(Math.floor(Math.abs(span) / every), min, max);

/**
 * A linear value axis over `lo`…`hi` (a flat range widened by one either side), niced, onto
 * `range` px, with its ticks: about one per `every` px.
 */
export function linearAxis(lo: number, hi: number, range: [number, number], every: number): { scale: ScaleLinear<number, number>; ticks: number[] } {
  const scale = scaleLinear()
    .domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi])
    .nice()
    .range(range);
  return { scale, ticks: scale.ticks(tickCount(range[1] - range[0], every)) };
}
