// Chart geometry without a renderer: stacking by sign, bar shapes and their boxes, line and area
// paths, and which category labels fit.
import { describe, expect, it } from "vitest";
import { areaPath, barPath, linePath, pathBox, stackEnds, stackRows, thinTicks } from "@/components/ui-blocks/chart-geometry";

const series = [
  { key: "a", label: "A" },
  { key: "b", label: "B" },
  { key: "c", label: "C" },
];

describe("stackRows", () => {
  it("stacks positives up and negatives down from zero, each in series order", () => {
    const s = stackRows([{ x: "r", a: 3, b: -2, c: 4 }], series, true);
    expect(s[0]).toEqual([
      { lo: 0, hi: 3 },
      { lo: -2, hi: 0 },
      { lo: 3, hi: 7 },
    ]);
  });

  it("runs each value from zero when unstacked, and a missing value is nothing", () => {
    expect(stackRows([{ x: "r", a: 3, b: -2, c: null }], series, false)[0]).toEqual([
      { lo: 0, hi: 3 },
      { lo: -2, hi: 0 },
      { lo: 0, hi: 0 },
    ]);
  });

  it("finds each side's outer segment, skipping zeros and gaps", () => {
    expect(stackEnds([{ x: "r", a: 3, b: -2, c: 0 }], series)).toEqual([{ up: 0, down: 1 }]);
    expect(stackEnds([{ x: "r", a: null, b: 1, c: 2 }], series)).toEqual([{ up: 2, down: -1 }]);
  });
});

describe("barPath", () => {
  it("rounds only the data end, by 4px at most, and keeps the box", () => {
    const box = { x: 10, y: 20, w: 24, h: 100 };
    for (const end of ["top", "bottom", "left", "right"] as const) {
      const d = barPath(box, end);
      expect(d, end).toMatch(/Q/);
      expect(pathBox(d), end).toEqual(box);
    }
    expect(barPath(box, null)).not.toMatch(/Q/);
    expect(pathBox(barPath(box, null))).toEqual(box);
    // The top corners round off by 4: the path reaches y 20 only 4px in from each side.
    expect(barPath(box, "top")).toContain("L10,24Q10,20 14,20L30,20Q34,20 34,24");
  });

  it("rounds a thin bar by half its size", () => {
    expect(barPath({ x: 0, y: 0, w: 4, h: 50 }, "top")).toContain("Q0,0 2,0");
  });
});

describe("paths", () => {
  it("draws straight segments, or a monotone curve, with a gap at a missing point", () => {
    const pts = [{ x: 0, y: 10 }, { x: 10, y: 5 }, null, { x: 30, y: 0 }, { x: 40, y: 2 }, { x: 50, y: 1 }];
    expect(linePath(pts, "linear")).toBe("M0,10L10,5M30,0L40,2L50,1");
    expect(linePath(pts, "monotone")).toMatch(/C/);
  });

  it("closes an area between its top and bottom", () => {
    expect(areaPath([0, 10], [5, 0], [20, 20], "linear")).toBe("M0,5L10,0L10,20L0,20Z");
  });
});

describe("thinTicks", () => {
  it("keeps every label that fits", () => {
    expect(thinTicks([0, 100, 200], [30, 30, 30], 16)).toEqual([0, 1, 2]);
  });

  it("thins crowded labels evenly and always keeps the first and the last", () => {
    const pos = Array.from({ length: 31 }, (_, i) => i * 10);
    const picked = thinTicks(
      pos,
      pos.map(() => 30),
      16,
    );
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(30);
    for (let i = 1; i < picked.length; i++) expect(pos[picked[i]] - pos[picked[i - 1]]).toBeGreaterThanOrEqual(46);
  });
});
