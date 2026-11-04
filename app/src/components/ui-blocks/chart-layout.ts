// Layout rules for chart text, kept pure so they are tested without a renderer: the chart's font
// size, label widths, the label dodge (end labels and reference-line labels sharing a gutter),
// and where the dumbbell's tooltip goes so its card never clips it.

/** Chart text (axes, end and reference labels) follows the interface size: text-xs, never under 11px. */
export const MIN_CHART_FONT = 11;
export function chartFontPx(rootPx: number): number {
  const px = Number.isFinite(rootPx) && rootPx > 0 ? rootPx * 0.75 : 12;
  return Math.max(MIN_CHART_FONT, Math.round(px * 10) / 10);
}

/** A generous width estimate for a run of text at `font` px (tabular digits run about 0.6em). */
export const textWidth = (text: string, font: number) => Math.ceil(text.length * font * 0.62);

/** `text` cut to `chars` characters, with an ellipsis when it was longer. */
export function fitText(text: string, chars: number): string {
  if (text.length <= chars) return text;
  return chars <= 1 ? "…" : `${text.slice(0, chars - 1)}…`;
}

/** A label to place along one axis: its wanted centre, its size along that axis, and how much it matters. */
export type LabelItem = { key: string; at: number; size: number; priority?: number };
export type Placed = { key: string; at: number; pos: number };

/**
 * The label dodge: labels keep a `pad` gap and stay inside [min, max], each moved as little as it
 * can (overlapping labels are grouped and each group centred on its labels' wanted spots, then
 * groups that touch merge). When they can't all fit, or one would end up further than `maxShift`
 * from its mark, the least important label in the most crowded spot is dropped, and reported, so
 * the caller can show the legend instead: a label is never lost silently.
 */
export function dodge(
  items: LabelItem[],
  { min, max, pad = 2, maxShift = Infinity }: { min: number; max: number; pad?: number; maxShift?: number },
): { placed: Placed[]; dropped: string[] } {
  let keep = [...items].sort((a, b) => a.at - b.at);
  const dropped: string[] = [];
  const drop = () => {
    // The lowest priority first; among those, the one closest to a neighbour.
    const crowd = (i: number) =>
      Math.min(i > 0 ? keep[i].at - keep[i - 1].at : Infinity, i < keep.length - 1 ? keep[i + 1].at - keep[i].at : Infinity);
    let worst = 0;
    keep.forEach((it, i) => {
      const w = keep[worst];
      if ((it.priority ?? 0) < (w.priority ?? 0) || ((it.priority ?? 0) === (w.priority ?? 0) && crowd(i) < crowd(worst))) worst = i;
    });
    dropped.push(keep[worst].key);
    keep = keep.filter((_, i) => i !== worst);
  };
  const span = (xs: LabelItem[]) => xs.reduce((n, x) => n + x.size, 0) + pad * Math.max(0, xs.length - 1);
  while (keep.length && span(keep) > max - min) drop();
  for (;;) {
    const placed = place(keep, min, max, pad);
    const far = placed.findIndex((p) => Math.abs(p.pos - p.at) > maxShift);
    if (far < 0 || !keep.length) return { placed, dropped };
    // Dropping any label frees room; drop the one that moved furthest when they tie on priority.
    const lowest = Math.min(...keep.map((k) => k.priority ?? 0));
    const shift = (i: number) => ((keep[i].priority ?? 0) === lowest ? Math.abs(placed[i].pos - placed[i].at) : -1);
    let worst = 0;
    keep.forEach((_, i) => shift(i) > shift(worst) && (worst = i));
    dropped.push(keep[worst].key);
    keep = keep.filter((_, i) => i !== worst);
  }
}

/** Cluster placement of labels that are known to fit, sorted by `at`. */
function place(items: LabelItem[], min: number, max: number, pad: number): Placed[] {
  type Group = { items: LabelItem[]; start: number; size: number };
  const settle = (g: Group) => {
    g.size = g.items.reduce((n, x) => n + x.size, 0) + pad * (g.items.length - 1);
    // Each label's offset in the group, then the start that puts the labels, on average, on their marks.
    let off = 0;
    let want = 0;
    for (const it of g.items) {
      want += it.at - (off + it.size / 2);
      off += it.size + pad;
    }
    g.start = Math.min(Math.max(want / g.items.length, min), max - g.size);
  };
  let groups: Group[] = items.map((it) => ({ items: [it], start: 0, size: 0 }));
  groups.forEach(settle);
  for (let merged = true; merged;) {
    merged = false;
    const next: Group[] = [];
    for (const g of groups) {
      const prev = next[next.length - 1];
      if (prev && prev.start + prev.size + pad > g.start + 1e-6) {
        prev.items.push(...g.items);
        settle(prev);
        merged = true;
      } else next.push(g);
    }
    groups = next;
  }
  return groups.flatMap((g) => {
    let off = g.start;
    return g.items.map((it) => {
      const pos = off + it.size / 2;
      off += it.size + pad;
      return { key: it.key, at: it.at, pos };
    });
  });
}

/** A legend for 2+ series always; for one series only when its end label had to be dropped. */
export const needsLegend = (series: number, dropped: number) => series >= 2 || dropped > 0;

export type Box = { w: number; h: number };
export type TipPlace = { left: number; top: number; x: "right" | "left" | "over"; y: "beside" | "below" | "above" };

/**
 * Where a tooltip goes, inside `box` (the plot, so it never covers the axis or spills out of the
 * card): beside the anchor, on the right if it fits, else on the left, vertically centred on it
 * and kept inside; when neither side has room, below the anchor, or above when below doesn't fit.
 */
export function placeTip(anchor: { x: number; y: number }, tip: Box, box: Box, gap = 12): TipPlace {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi), v));
  const beside = (top: number): number => clamp(top, 0, box.h - tip.h);
  if (anchor.x + gap + tip.w <= box.w) return { left: anchor.x + gap, top: beside(anchor.y - tip.h / 2), x: "right", y: "beside" };
  if (anchor.x - gap - tip.w >= 0) return { left: anchor.x - gap - tip.w, top: beside(anchor.y - tip.h / 2), x: "left", y: "beside" };
  const left = clamp(anchor.x - tip.w / 2, 0, box.w - tip.w);
  if (anchor.y + gap + tip.h <= box.h) return { left, top: anchor.y + gap, x: "over", y: "below" };
  return { left, top: Math.max(0, anchor.y - gap - tip.h), x: "over", y: "above" };
}
