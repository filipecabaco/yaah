// Sankey layout: d3-sankey 0.12.3 places the nodes and link bands; we draw them. Pure and
// deterministic for a given input and size. The link shape is our own horizontal curve, so
// d3-sankey's d3-shape 1.x copy is never bundled (only its small d3-array 2.x copy is).
import { sankey, sankeyJustify } from "d3-sankey";
import type { FlowLink, FlowNode } from "@/components/ui-blocks/flow/flow-model";

export type SankeyBox = {
  id: string;
  label: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  value: number;
  depth: number;
  inValue: number;
  outValue: number;
};
/** `path` is the band's centre line; `area` its outline (filled, with its two edges stroked). */
export type SankeyBand = {
  i: number;
  source: string;
  target: string;
  value: number;
  width: number;
  path: string;
  area: string;
  mid: { x: number; y: number };
};
export type SankeyLayout = { nodes: SankeyBox[]; links: SankeyBand[]; columns: number };

export const NODE_WIDTH = 12;

/** A link band's centre line: a horizontal cubic from the source's right edge to the target's left. */
export function bandPath(x0: number, y0: number, x1: number, y1: number): string {
  const xm = (x0 + x1) / 2;
  return `M${x0},${y0}C${xm},${y0} ${xm},${y1} ${x1},${y1}`;
}

/**
 * A link band's outline: its top and bottom edges as the same horizontal cubic, `w` apart, joined at
 * the source's right edge and the target's left. Filled, it is the band; stroked, its edges.
 */
export function bandArea(x0: number, y0: number, x1: number, y1: number, w: number): string {
  const xm = (x0 + x1) / 2;
  const h = w / 2;
  const r = (n: number) => Math.round(n * 100) / 100;
  const [a, b, c, d] = [y0 - h, y1 - h, y1 + h, y0 + h].map(r);
  return `M${r(x0)},${a}C${r(xm)},${a} ${r(xm)},${b} ${r(x1)},${b}L${r(x1)},${c}C${r(xm)},${c} ${r(xm)},${d} ${r(x0)},${d}Z`;
}

type N = FlowNode & { inValue?: number; outValue?: number };
type L = FlowLink & { i: number };

/**
 * Nodes in columns by depth (justified: sinks on the right), bands as wide as their values, inside
 * `width`×`height` less `inset` on the left and right for labels. Call only on links checked by
 * readFlow (no cycles, ends exist).
 */
export function layoutSankey(nodes: FlowNode[], links: FlowLink[], width: number, height: number, inset = { left: 0, right: 0 }): SankeyLayout {
  if (!nodes.length) return { nodes: [], links: [], columns: 0 };
  const pad = Math.max(6, Math.min(16, (height / Math.max(1, nodes.length)) * 0.4));
  const gen = sankey<N, L>()
    .nodeId((d) => d.id)
    .nodeAlign(sankeyJustify)
    .nodeWidth(NODE_WIDTH)
    .nodePadding(pad)
    .iterations(6)
    .extent([
      [inset.left + 1, 1],
      [Math.max(inset.left + NODE_WIDTH * 2, width - inset.right - 1), Math.max(2, height - 1)],
    ]);
  const g = gen({ nodes: nodes.map((n) => ({ ...n })), links: links.map((l, i) => ({ ...l, i })) });
  const id = (n: unknown) => (n as { id: string }).id;
  const out: SankeyBox[] = g.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    x0: n.x0 ?? 0,
    x1: n.x1 ?? 0,
    y0: n.y0 ?? 0,
    y1: n.y1 ?? 0,
    value: n.value ?? 0,
    depth: n.depth ?? 0,
    inValue: (n.targetLinks ?? []).reduce((t, l) => t + l.value, 0),
    outValue: (n.sourceLinks ?? []).reduce((t, l) => t + l.value, 0),
  }));
  const at = new Map(out.map((n) => [n.id, n]));
  const bands: SankeyBand[] = g.links.map((l) => {
    const s = at.get(id(l.source))!;
    const t = at.get(id(l.target))!;
    const y0 = l.y0 ?? 0;
    const y1 = l.y1 ?? 0;
    return {
      i: l.i,
      source: s.id,
      target: t.id,
      value: l.value,
      width: Math.max(1, l.width ?? 1),
      path: bandPath(s.x1, y0, t.x0, y1),
      area: bandArea(s.x1, y0, t.x0, y1, Math.max(1, l.width ?? 1)),
      mid: { x: (s.x1 + t.x0) / 2, y: (y0 + y1) / 2 },
    };
  });
  return { nodes: out, links: bands.sort((a, b) => a.i - b.i), columns: Math.max(0, ...out.map((n) => n.depth)) + 1 };
}

export type SankeyLabel = { x: number; y: number; anchor: "start" | "end" | "middle" };
type R = { x0: number; y0: number; x1: number; y1: number };

/**
 * Where each node's label goes, biggest nodes first: beside the node (right, or left for the last
 * column, which has no room on its right), else the other side, else just above it; never over
 * another label and never out of the box. A node whose label fits nowhere is left unlabelled (its
 * tooltip, name and table row still say it).
 */
export function placeSankeyLabels(
  nodes: SankeyBox[],
  text: (n: SankeyBox) => string,
  font: number,
  width: number,
  height: number,
  columns: number,
): Map<string, SankeyLabel> {
  const out = new Map<string, SankeyLabel>();
  const placed: R[] = [];
  const w = (s: string) => Math.ceil(s.length * font * 0.62);
  const free = (r: R) =>
    r.x0 >= 0 && r.x1 <= width && r.y0 >= 0 && r.y1 <= height && !placed.some((p) => r.x0 < p.x1 && p.x0 < r.x1 && r.y0 < p.y1 && p.y0 < r.y1);
  for (const n of [...nodes].sort((a, b) => b.value - a.value)) {
    const t = text(n);
    const tw = w(t);
    const cy = (n.y0 + n.y1) / 2;
    const h = font + 2;
    const right = { at: { x: n.x1 + 6, y: cy, anchor: "start" as const }, r: { x0: n.x1 + 4, y0: cy - h / 2, x1: n.x1 + 8 + tw, y1: cy + h / 2 } };
    const left = { at: { x: n.x0 - 6, y: cy, anchor: "end" as const }, r: { x0: n.x0 - 8 - tw, y0: cy - h / 2, x1: n.x0 - 4, y1: cy + h / 2 } };
    const above = {
      at: { x: (n.x0 + n.x1) / 2, y: n.y0 - h / 2 - 2, anchor: "middle" as const },
      r: { x0: (n.x0 + n.x1) / 2 - tw / 2 - 2, y0: n.y0 - h - 3, x1: (n.x0 + n.x1) / 2 + tw / 2 + 2, y1: n.y0 - 1 },
    };
    const order = n.depth === columns - 1 ? [left, right, above] : [right, left, above];
    const pick = order.find((c) => free(c.r));
    if (!pick) continue;
    placed.push(pick.r);
    out.set(n.id, pick.at);
  }
  return out;
}
