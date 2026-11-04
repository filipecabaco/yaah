// The chart's layout rules as pure functions: the label dodge, the tooltip's placement and the
// chart font size.
import { describe, expect, it } from "vitest";
import { chartFontPx, dodge, fitText, needsLegend, placeTip, type LabelItem } from "@/components/ui-blocks/chart-layout";

const label = (key: string, at: number, size = 15, priority = 0): LabelItem => ({ key, at, size, priority });

/** No two placed labels overlap, and all sit inside [min, max]. */
function expectClear(placed: { pos: number }[], size: number, min: number, max: number, pad = 2) {
  const ps = placed.map((p) => p.pos).sort((a, b) => a - b);
  for (let i = 1; i < ps.length; i++) expect(ps[i] - ps[i - 1]).toBeGreaterThanOrEqual(size + pad - 1e-9);
  for (const p of ps) {
    expect(p - size / 2).toBeGreaterThanOrEqual(min - 1e-9);
    expect(p + size / 2).toBeLessThanOrEqual(max + 1e-9);
  }
}

describe("dodge", () => {
  it("leaves labels that don't collide where they are", () => {
    const { placed, dropped } = dodge([label("a", 20), label("b", 60), label("c", 100)], { min: 0, max: 200 });
    expect(dropped).toEqual([]);
    expect(placed.map((p) => p.pos)).toEqual([20, 60, 100]);
  });

  it("nudges colliding labels apart, symmetrically, keeping the gap", () => {
    const { placed, dropped } = dodge([label("a", 100), label("b", 101), label("c", 102)], { min: 0, max: 200 });
    expect(dropped).toEqual([]);
    expectClear(placed, 15, 0, 200);
    // The group stays centred on its marks: the middle one barely moves.
    expect(Math.abs(placed.find((p) => p.key === "b")!.pos - 101)).toBeLessThan(1);
    // And their order is kept.
    expect(placed.map((p) => p.key)).toEqual(["a", "b", "c"]);
  });

  it("stays inside the plot when labels crowd an edge", () => {
    const { placed } = dodge([label("a", 2), label("b", 3), label("c", 198)], { min: 0, max: 200 });
    expectClear(placed, 15, 0, 200);
    expect(placed[0].pos).toBe(7.5);
  });

  it("merges groups that touch once nudged", () => {
    const items = [10, 12, 30, 32, 50].map((at, i) => label(`s${i}`, at));
    const { placed, dropped } = dodge(items, { min: 0, max: 200 });
    expect(dropped).toEqual([]);
    expectClear(placed, 15, 0, 200);
  });

  it("drops what can't fit, the least important in the most crowded spot first, and says which", () => {
    const items = [label("ref", 50, 15, 1), label("a", 50), label("b", 51), label("c", 52), label("d", 53)];
    const { placed, dropped } = dodge(items, { min: 0, max: 50 });
    // 50px holds three 15px labels with 2px gaps (49px).
    expect(placed).toHaveLength(3);
    expect(dropped).toHaveLength(2);
    expect(dropped).not.toContain("ref");
    expectClear(placed, 15, 0, 50);
  });

  it("drops a label pushed too far from its mark rather than float it away", () => {
    const items = [0, 1, 2, 3, 4, 5].map((d) => label(`s${d}`, 100 + d));
    const { placed, dropped } = dodge(items, { min: 0, max: 400, maxShift: 30 });
    expect(dropped.length).toBeGreaterThan(0);
    for (const p of placed) expect(Math.abs(p.pos - p.at)).toBeLessThanOrEqual(30);
    expectClear(placed, 15, 0, 400);
  });

  it("asks for the legend whenever an end label is missing", () => {
    expect(needsLegend(1, 0)).toBe(false);
    expect(needsLegend(1, 1)).toBe(true);
    expect(needsLegend(3, 0)).toBe(true);
  });
});

describe("placeTip", () => {
  const tip = { w: 180, h: 84 };
  const box = { w: 640, h: 246 };

  it("goes right of the anchor when it fits, centred on it", () => {
    expect(placeTip({ x: 100, y: 120 }, tip, box)).toEqual({ left: 112, top: 78, x: "right", y: "beside" });
  });

  it("flips left at the right edge", () => {
    const p = placeTip({ x: 600, y: 120 }, tip, box);
    expect(p.x).toBe("left");
    expect(p.left + tip.w).toBeLessThanOrEqual(600);
  });

  it("stays inside the plot on the last row, above the axis, and on the first", () => {
    const low = placeTip({ x: 100, y: 236 }, tip, box);
    expect(low.top + tip.h).toBeLessThanOrEqual(box.h);
    const high = placeTip({ x: 100, y: 4 }, tip, box);
    expect(high.top).toBe(0);
  });

  it("goes below, or above at the bottom, when neither side has room", () => {
    const narrow = { w: 300, h: 300 };
    expect(placeTip({ x: 150, y: 40 }, tip, narrow)).toMatchObject({ x: "over", y: "below", top: 52, left: 60 });
    const up = placeTip({ x: 150, y: 260 }, tip, narrow);
    expect(up).toMatchObject({ x: "over", y: "above" });
    expect(up.top + tip.h).toBeLessThanOrEqual(260);
  });
});

describe("chart text", () => {
  it("follows the interface size, never under 11px", () => {
    expect(chartFontPx(16)).toBe(12);
    expect(chartFontPx(20)).toBe(15);
    expect(chartFontPx(12)).toBe(11);
    expect(chartFontPx(NaN)).toBe(12);
  });

  it("cuts text with an ellipsis", () => {
    expect(fitText("Lisbon yearly average", 30)).toBe("Lisbon yearly average");
    expect(fitText("Lisbon yearly average", 10)).toBe("Lisbon ye…");
  });
});
