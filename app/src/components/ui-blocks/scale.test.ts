import { describe, expect, it } from "vitest";
import { binColors, binOf, binRange, colorOf, domainOf, readScale } from "@/components/ui-blocks/scale";

describe("readScale", () => {
  it("reads the shared shape and clamps bins to 2–7", () => {
    expect(readScale({ type: "diverging", domain: [-20, 20], midpoint: 0, bins: 7, unit: " pts" })).toEqual({
      type: "diverging",
      domain: [-20, 20],
      midpoint: 0,
      bins: 7,
      unit: " pts",
    });
    expect(readScale({ type: "sequential", bins: 12 })?.bins).toBe(7);
    expect(readScale({ type: "sequential", bins: 0 })?.bins).toBe(2);
    expect(readScale({ type: "sequential", domain: [5, 1] })?.domain).toBeUndefined();
    expect(readScale({ type: "rainbow" })).toBeNull();
    expect(readScale("diverging")).toBeNull();
  });
});

describe("colours", () => {
  it("are theme tokens only: one hue for sequential, two arms and a gray middle for diverging", () => {
    expect(binColors(readScale({ type: "sequential", bins: 3 })!)).toEqual(["var(--scale-seq-100)", "var(--scale-seq-400)", "var(--scale-seq-700)"]);
    expect(binColors(readScale({ type: "diverging", bins: 7 })!)).toEqual([
      "var(--scale-div-neg-3)",
      "var(--scale-div-neg-2)",
      "var(--scale-div-neg-1)",
      "var(--scale-div-mid)",
      "var(--scale-div-pos-1)",
      "var(--scale-div-pos-2)",
      "var(--scale-div-pos-3)",
    ]);
    // An even count has no middle bin: equal steps either side.
    expect(binColors(readScale({ type: "diverging", bins: 4 })!)).toEqual([
      "var(--scale-div-neg-3)",
      "var(--scale-div-neg-1)",
      "var(--scale-div-pos-1)",
      "var(--scale-div-pos-3)",
    ]);
  });

  it("bin either side of the midpoint, even on a lopsided domain", () => {
    const s = readScale({ type: "diverging", domain: [-10, 30], midpoint: 0, bins: 2 })!;
    expect(binOf(s, s.domain!, -0.1)).toBe(0);
    expect(binOf(s, s.domain!, 0.1)).toBe(1);
    expect(colorOf(s, s.domain!, 29)).toBe("var(--scale-div-pos-2)");
    expect(binRange(s, s.domain!, 0)).toEqual([-10, 0]);
    // Out of the domain: clamped to the end bins.
    expect(binOf(s, s.domain!, 99)).toBe(1);
  });

  it("make a diverging domain symmetric about the midpoint when none is given", () => {
    const s = readScale({ type: "diverging", midpoint: 0 })!;
    expect(domainOf(s, [-3, 12])).toEqual([-12, 12]);
    expect(domainOf(readScale({ type: "sequential" })!, [2, 8])).toEqual([2, 8]);
    expect(domainOf(readScale({ type: "sequential" })!, [])).toEqual([0, 1]);
  });
});
