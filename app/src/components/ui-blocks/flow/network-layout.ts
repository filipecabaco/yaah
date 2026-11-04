// Network layout: d3-force 3.0.0 run to a fixed number of ticks, synchronously, from d3's own
// phyllotaxis start and a seeded random source, so the same graph always settles the same way
// (testable, and stable across re-renders). Computed once per data change, in unit space; the
// renderer only fits it into its box. Large graphs run it in a worker (network-worker.ts).
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

export type NetIn = { nodes: { id: string; size?: number }[]; links: { source: string; target: string; value: number }[] };
export type NetOut = { x: number[]; y: number[]; r: number[] };

export const TICKS = 300;
/** From this many nodes the layout runs off the main thread. */
export const WORKER_MIN = 150;
const R_MIN = 5;
const R_MAX = 14;

/** A small seeded generator (an LCG), the shape d3-force's randomSource wants. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => (s = (1664525 * s + 1013904223) >>> 0) / 4294967296;
}

/** Node radius: square root of `size` over [0, max] onto 5–14px; 6px without sizes. */
export function radii(nodes: { size?: number }[]): number[] {
  const max = Math.max(0, ...nodes.map((n) => n.size ?? 0));
  return nodes.map((n) => (max > 0 && n.size != null ? R_MIN + (R_MAX - R_MIN) * Math.sqrt(n.size / max) : 6));
}

type SN = SimulationNodeDatum & { id: string; r: number };

export function layoutNetwork({ nodes, links }: NetIn, ticks = TICKS, seed = 7): NetOut {
  const r = radii(nodes);
  const sim: SN[] = nodes.map((n, i) => ({ id: n.id, r: r[i] }));
  const sl: SimulationLinkDatum<SN>[] = links.map((l) => ({ source: l.source, target: l.target }));
  const simulation = forceSimulation(sim)
    .randomSource(lcg(seed))
    .force(
      "link",
      forceLink<SN, SimulationLinkDatum<SN>>(sl)
        .id((d) => d.id)
        .distance(40),
    )
    .force("charge", forceManyBody<SN>().strength(-90))
    .force("x", forceX<SN>(0).strength(0.06))
    .force("y", forceY<SN>(0).strength(0.06))
    .force(
      "collide",
      forceCollide<SN>((d) => d.r + 3),
    )
    .stop();
  simulation.tick(ticks);
  return { x: sim.map((n) => n.x ?? 0), y: sim.map((n) => n.y ?? 0), r };
}

/**
 * The settled layout scaled and centred into a box, `pad` px in from each side. Positions in a
 * force layout carry no meaning, so a wide box may stretch it sideways, up to twice as far as
 * down, to use the room; nodes keep their size.
 */
export function fitLayout(l: NetOut, width: number, height: number, pad: number): { x: number[]; y: number[] } {
  if (!l.x.length) return { x: [], y: [] };
  const x0 = Math.min(...l.x);
  const x1 = Math.max(...l.x);
  const y0 = Math.min(...l.y);
  const y1 = Math.max(...l.y);
  const rmax = Math.max(...l.r);
  const room = (span: number, d: number) => (span - 2 * pad - 2 * rmax) / Math.max(1, d);
  let kx = room(width, x1 - x0);
  let ky = room(height, y1 - y0);
  const k = Math.min(kx, ky, 4);
  [kx, ky] = [Math.min(kx, 2 * k, 4), Math.min(ky, 2 * k, 4)];
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { x: l.x.map((x) => width / 2 + (x - cx) * kx), y: l.y.map((y) => height / 2 + (y - cy) * ky) };
}
