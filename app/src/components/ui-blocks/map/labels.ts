// Visible labels on a map, chosen and placed without measuring the DOM (a character-width
// estimate, textWidth): a region's label goes at its pole of inaccessibility (the point furthest
// inside the shape, so "Mexico" doesn't sit on the coast) and only when the whole label lies
// inside it; place labels go beside their mark, and no label ever overlaps one already placed.
import { fitText, textWidth } from "@/components/ui-blocks/chart-layout";
import type { Ring } from "@/components/ui-blocks/map/projection";

export type Rect = { x0: number; y0: number; x1: number; y1: number };
export type PlacedLabel = { key: string; text: string; x: number; y: number; anchor: "start" | "middle" | "end"; rect: Rect };

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (r: Rect, w: number, h: number) => r.x0 >= 0 && r.y0 >= 0 && r.x1 <= w && r.y1 <= h;

/** The first of `texts` (longest form first) that fits a `box` at `font` px, with a little room each side. */
export function fitInBox(texts: string[], box: { w: number; h: number }, font: number): string | null {
  if (box.h < font + 2) return null;
  return texts.find((t) => t && textWidth(t, font) + 4 <= box.w) ?? null;
}

export type RegionLabelInput = {
  key: string;
  /** Candidate texts, preferred first (a name, then a short code). */
  texts: string[];
  /** Where the label goes (the centre of the region's largest part) and that part's box. */
  at: { x: number; y: number };
  box: { w: number; h: number };
  /** Label even when it doesn't fit inside (few labelled regions): its shortest text, still never overlapping. */
  force?: boolean;
  /** The part's pixel rings: when given, a label goes at its pole of inaccessibility and must lie inside. */
  rings?: Ring[];
};

/** Whether a point is inside the rings (even-odd, so holes and clipped pieces count right). */
export function insideRings(rings: Ring[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

function segmentDistance(px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  let dx = bx - ax;
  let dy = by - ay;
  let x = ax;
  let y = ay;
  if (dx !== 0 || dy !== 0) {
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    x += dx * t;
    y += dy * t;
  }
  dx = px - x;
  dy = py - y;
  return Math.hypot(dx, dy);
}

/** Signed distance from a point to the rings' edge: positive inside. */
function edgeDistance(rings: Ring[], x: number, y: number): number {
  let min = Infinity;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) min = Math.min(min, segmentDistance(x, y, ring[i], ring[j]));
  return (insideRings(rings, x, y) ? 1 : -1) * min;
}

/**
 * The pole of inaccessibility: the point inside the rings furthest from their edge, to within
 * `precision` px (the quadtree search of Mapbox's polylabel, written out here). `d` is that
 * distance, the radius of the biggest circle that fits.
 */
export function poleOf(rings: Ring[], precision = 2): { x: number; y: number; d: number } {
  const pts = rings.flat();
  if (!pts.length) return { x: 0, y: 0, d: 0 };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const size = Math.min(x1 - x0, y1 - y0);
  if (size <= 0) return { x: x0, y: y0, d: 0 };
  type Cell = { x: number; y: number; h: number; d: number; max: number };
  const cell = (x: number, y: number, h: number): Cell => {
    const d = edgeDistance(rings, x, y);
    return { x, y, h, d, max: d + h * Math.SQRT2 };
  };
  const queue: Cell[] = [];
  for (let x = x0; x < x1; x += size) for (let y = y0; y < y1; y += size) queue.push(cell(x + size / 2, y + size / 2, size / 2));
  let best = cell((x0 + x1) / 2, (y0 + y1) / 2, 0);
  // The centroid of the outer ring is often a good first guess.
  let a = 0;
  let cx = 0;
  let cy = 0;
  const ring = rings[0];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
    cx += (ring[i][0] + ring[j][0]) * f;
    cy += (ring[i][1] + ring[j][1]) * f;
    a += f * 3;
  }
  if (a !== 0) {
    const c = cell(cx / a, cy / a, 0);
    if (c.d > best.d) best = c;
  }
  // Bounded, so a very long coast can't stall a render.
  for (let n = 0; queue.length && n < 1500; n++) {
    let k = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].max > queue[k].max) k = i;
    const c = queue.splice(k, 1)[0];
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    const h = c.h / 2;
    queue.push(cell(c.x - h, c.y - h, h), cell(c.x + h, c.y - h, h), cell(c.x - h, c.y + h, h), cell(c.x + h, c.y + h, h));
  }
  return { x: best.x, y: best.y, d: best.d };
}

const spotsFor = (pole: { x: number; y: number } | null, centroid: { x: number; y: number }, w: number, font: number) =>
  pole
    ? [
        pole,
        ...[0.25, -0.25, 0.5, -0.5].map((k) => ({ x: pole.x + k * w, y: pole.y })),
        ...[0.8, -0.8].map((k) => ({ x: pole.x, y: pole.y + k * font })),
        centroid,
      ]
    : [centroid];

/**
 * The part of a label's box that must lie inside its shape: the glyphs, not the room kept round
 * them (textWidth is a generous estimate, and caps and descenders don't fill the line).
 */
export const ink = (r: Rect, font: number): Rect => {
  const dx = (r.x1 - r.x0) * 0.06 + 2;
  const dy = font * 0.2 + 1;
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 - dx, y1: r.y1 - dy };
};

/**
 * The rings cut to the `width`×`height` box (Sutherland–Hodgman, side by side), so a region
 * that runs off the map is labelled in the part that shows.
 */
export function clipRings(rings: Ring[], width: number, height: number): Ring[] {
  type Side = { inside: (p: [number, number]) => boolean; cut: (a: [number, number], b: [number, number]) => [number, number] };
  const at = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const sides: Side[] = [
    { inside: (p) => p[0] >= 0, cut: (a, b) => at(a, b, (0 - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[0] <= width, cut: (a, b) => at(a, b, (width - a[0]) / (b[0] - a[0])) },
    { inside: (p) => p[1] >= 0, cut: (a, b) => at(a, b, (0 - a[1]) / (b[1] - a[1])) },
    { inside: (p) => p[1] <= height, cut: (a, b) => at(a, b, (height - a[1]) / (b[1] - a[1])) },
  ];
  return rings.flatMap((ring) => {
    let out = ring;
    for (const side of sides) {
      const next: Ring = [];
      out.forEach((p, i) => {
        const prev = out[(i + out.length - 1) % out.length];
        if (side.inside(p)) {
          if (!side.inside(prev)) next.push(side.cut(prev, p));
          next.push(p);
        } else if (side.inside(prev)) next.push(side.cut(prev, p));
      });
      out = next;
      if (!out.length) return [];
    }
    return out.length > 2 ? [out] : [];
  });
}

/** Whether a label's box lies inside the rings: its corners and the middle of each side. */
export function rectInside(rings: Ring[], r: Rect): boolean {
  const mx = (r.x0 + r.x1) / 2;
  const my = (r.y0 + r.y1) / 2;
  const probes: [number, number][] = [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x0, r.y1],
    [r.x1, r.y1],
    [mx, r.y0],
    [mx, r.y1],
    [r.x0, my],
    [r.x1, my],
  ];
  return probes.every(([x, y]) => insideRings(rings, x, y));
}

/**
 * Region labels: biggest regions first, each the first text that fits. With rings, a label goes
 * at the pole of inaccessibility (or slid along its row, else at the centroid), and fits only when
 * its whole box lies inside the shape; without them, when the box of the part can hold it. Forced ones fall back to their
 * shortest text at the pole, inside or not. A label that would overlap a placed one or anything
 * `taken` (place marks and their labels), or leave the map, is skipped.
 */
export function placeRegionLabels(
  items: RegionLabelInput[],
  font: number,
  size: { width: number; height: number },
  cap = Infinity,
  taken: Rect[] = [],
): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const order = [...items].sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  const rectAt = (text: string, at: { x: number; y: number }): Rect => {
    const w = textWidth(text, font);
    return { x0: at.x - w / 2 - 2, y0: at.y - font / 2 - 1, x1: at.x + w / 2 + 2, y1: at.y + font / 2 + 1 };
  };
  const free = (rect: Rect) =>
    inside(rect, size.width, size.height) && !placed.some((p) => overlaps(p.rect, rect)) && !taken.some((t) => overlaps(t, rect));
  for (const it of order) {
    if (placed.length >= cap) break;
    let choice: { text: string; at: { x: number; y: number }; rect: Rect } | null = null;
    if (it.rings?.length) {
      // Too small for even a short label: skip the search.
      const big = it.box.h >= font + 2 && it.box.w >= textWidth("XX", font);
      const pole = big || it.force ? poleOf(it.rings) : null;
      for (const text of big ? it.texts.filter(Boolean) : [])
        // The pole, then slid along its row (a wide label in a shape whose widest point is a corner), then the centroid.
        for (const at of spotsFor(pole, it.at, textWidth(text, font), font)) {
          const rect = rectAt(text, at);
          if (!choice && rectInside(it.rings, ink(rect, font)) && free(rect)) choice = { text, at, rect };
        }
      if (!choice && it.force) {
        const text = [...it.texts].filter(Boolean).sort((a, b) => a.length - b.length)[0];
        const at = pole ?? it.at;
        const rect = text ? rectAt(text, at) : null;
        if (text && rect && free(rect)) choice = { text, at, rect };
      }
    } else {
      const text = fitInBox(it.texts, it.box, font) ?? (it.force ? [...it.texts].filter(Boolean).sort((a, b) => a.length - b.length)[0] : null);
      const rect = text ? rectAt(text, it.at) : null;
      if (text && rect && free(rect)) choice = { text, at: it.at, rect };
    }
    if (choice) placed.push({ key: it.key, text: choice.text, x: choice.at.x, y: choice.at.y, anchor: "middle", rect: choice.rect });
  }
  return placed;
}

export type PointLabelInput = { key: string; text: string; x: number; y: number; r: number };

/** The longest a place label runs before it is cut with an ellipsis (the full name is in the tooltip and table). */
export const PLACE_LABEL_CHARS = 18;

/**
 * Labels beside marks, in the order given (most important first): right of the mark, left of
 * it, then (with `around`) above and below, the first spot that stays on the map and clear of
 * placed labels and of any point in `avoid` (other marks' centres, so a label never hides a
 * mark). Neither fits: no label (the mark keeps its tooltip and its table row). Long names are cut
 * (fitText). Labels carry a surface halo, so they may cross other marks' edges.
 */
export function placePointLabels(
  items: PointLabelInput[],
  font: number,
  size: { width: number; height: number },
  { around = false, avoid = [], cap = Infinity }: { around?: boolean; avoid?: { key: string; x: number; y: number; r: number }[]; cap?: number } = {},
): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  for (const it of items) {
    if (placed.length >= cap) break;
    if (!it.text) continue;
    const text = fitText(it.text, PLACE_LABEL_CHARS);
    const w = textWidth(text, font);
    const y0 = it.y - font / 2 - 1;
    const y1 = it.y + font / 2 + 1;
    const spots: { rect: Rect; x: number; y: number; anchor: PlacedLabel["anchor"] }[] = [
      { rect: { x0: it.x + it.r + 3, y0, x1: it.x + it.r + 3 + w, y1 }, x: it.x + it.r + 3, y: it.y, anchor: "start" },
      { rect: { x0: it.x - it.r - 3 - w, y0, x1: it.x - it.r - 3, y1 }, x: it.x - it.r - 3, y: it.y, anchor: "end" },
    ];
    if (around) {
      const up = it.y - it.r - 2 - font / 2;
      const down = it.y + it.r + 2 + font / 2;
      spots.push(
        { rect: { x0: it.x - w / 2, y0: up - font / 2 - 1, x1: it.x + w / 2, y1: up + font / 2 + 1 }, x: it.x, y: up, anchor: "middle" },
        { rect: { x0: it.x - w / 2, y0: down - font / 2 - 1, x1: it.x + w / 2, y1: down + font / 2 + 1 }, x: it.x, y: down, anchor: "middle" },
      );
    }
    const clear = (r: Rect) =>
      avoid.every((a) => {
        if (a.key === it.key) return true;
        // A mark's core: its centre, or a little of a small one.
        const k = Math.min(a.r, 4);
        return !overlaps(r, { x0: a.x - k, y0: a.y - k, x1: a.x + k, y1: a.y + k });
      });
    const spot = spots.find((s) => inside(s.rect, size.width, size.height) && !placed.some((p) => overlaps(p.rect, s.rect)) && clear(s.rect));
    if (!spot) continue;
    placed.push({ key: it.key, text, x: spot.x, y: spot.y, anchor: spot.anchor, rect: spot.rect });
  }
  return placed;
}
