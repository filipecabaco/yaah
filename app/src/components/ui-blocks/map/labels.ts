// Visible labels on a map, chosen and placed without measuring the DOM (a character-width
// estimate, textWidth): region labels go where the region's box can hold them, place labels go
// right of their mark (left at the edge), and no label ever overlaps one already placed.
import { textWidth } from "@/components/ui-blocks/chart-layout";

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
};

/**
 * Region labels: biggest regions first, each the first text that fits inside its box; forced ones
 * fall back to their shortest text. A label that would overlap a placed one or anything `taken`
 * (place marks and their labels), or leave the map, is skipped.
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
  for (const it of order) {
    if (placed.length >= cap) break;
    const text = fitInBox(it.texts, it.box, font) ?? (it.force ? [...it.texts].filter(Boolean).sort((a, b) => a.length - b.length)[0] : null);
    if (!text) continue;
    const w = textWidth(text, font);
    const rect = { x0: it.at.x - w / 2 - 2, y0: it.at.y - font / 2 - 1, x1: it.at.x + w / 2 + 2, y1: it.at.y + font / 2 + 1 };
    if (!inside(rect, size.width, size.height) || placed.some((p) => overlaps(p.rect, rect)) || taken.some((t) => overlaps(t, rect))) continue;
    placed.push({ key: it.key, text, x: it.at.x, y: it.at.y, anchor: "middle", rect });
  }
  return placed;
}

export type PointLabelInput = { key: string; text: string; x: number; y: number; r: number };

/**
 * Labels beside marks, in the order given (most important first): right of the mark, or left of it
 * when the right would leave the map or hit a placed label. Neither fits: no label (the mark keeps
 * its tooltip and its table row). Labels carry a surface halo, so they may cross other marks.
 */
export function placePointLabels(items: PointLabelInput[], font: number, size: { width: number; height: number }): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  for (const it of items) {
    if (!it.text) continue;
    const w = textWidth(it.text, font);
    const y0 = it.y - font / 2 - 1;
    const y1 = it.y + font / 2 + 1;
    const right: Rect = { x0: it.x + it.r + 3, y0, x1: it.x + it.r + 3 + w, y1 };
    const left: Rect = { x0: it.x - it.r - 3 - w, y0, x1: it.x - it.r - 3, y1 };
    const free = (r: Rect) => inside(r, size.width, size.height) && !placed.some((p) => overlaps(p.rect, r));
    const rect = free(right) ? right : free(left) ? left : null;
    if (!rect) continue;
    placed.push({ key: it.key, text: it.text, x: rect === right ? rect.x0 : rect.x1, y: it.y, anchor: rect === right ? "start" : "end", rect });
  }
  return placed;
}
