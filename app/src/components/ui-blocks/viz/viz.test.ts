// The shared figure core's pure parts: tick choice, the label dodge it re-exports, keyboard steps
// across a list and a plane, and what legends say (bin labels with open ends, bubble sizes).
import { describe, expect, it } from "vitest";
import { binLabels, dodge, linearAxis, linearStep, sizeLegendValues, spatialStep, tickCount } from "@/components/ui-blocks/viz";
import type { Scale } from "@/components/ui-blocks/scale";

describe("ticks", () => {
  it("fits one tick per so many pixels, 2 to 8", () => {
    expect(tickCount(400, 80)).toBe(5);
    expect(tickCount(40, 80)).toBe(2);
    expect(tickCount(4000, 80)).toBe(8);
    expect(tickCount(-400, 80)).toBe(5);
  });

  it("nices the axis and keeps its ticks inside it", () => {
    const { scale, ticks } = linearAxis(-0.8, 5.5, [100, 500], 80);
    expect(scale.domain()).toEqual([-1, 5.5]);
    expect(ticks).toEqual([-1, 0, 1, 2, 3, 4, 5]);
    expect(scale(-1)).toBe(100);
    expect(scale(5.5)).toBe(500);
    // A flat range still gets an axis around it.
    expect(linearAxis(3, 3, [0, 100], 48).scale.domain()).toEqual([2, 4]);
  });
});

describe("dodge", () => {
  it("moves colliding labels apart as little as it can, and drops the least important when they can't all fit", () => {
    const { placed } = dodge(
      [
        { key: "a", at: 50, size: 14 },
        { key: "b", at: 52, size: 14 },
      ],
      { min: 0, max: 200, pad: 2 },
    );
    const [a, b] = placed;
    expect(b.pos - a.pos).toBeGreaterThanOrEqual(16);
    expect((a.pos + b.pos) / 2).toBeCloseTo(51, 0);
    const crowded = dodge(
      [
        { key: "ref", at: 10, size: 14, priority: 1 },
        { key: "end", at: 12, size: 14 },
      ],
      { min: 0, max: 20 },
    );
    expect(crowded.dropped).toEqual(["end"]);
  });
});

describe("keyboard steps", () => {
  it("walks a list with arrows, Home and End, clamped at the ends", () => {
    expect(linearStep("ArrowDown", 0, 3)).toBe(1);
    expect(linearStep("ArrowRight", 2, 3)).toBe(2);
    expect(linearStep("ArrowUp", 0, 3)).toBe(0);
    expect(linearStep("End", 0, 3)).toBe(2);
    expect(linearStep("Home", 2, 3)).toBe(0);
    expect(linearStep("a", 0, 3)).toBeNull();
  });

  it("moves across a plane to the nearest item that way, favouring straight ahead", () => {
    //   0 (0,0)   1 (10,1)   2 (10,-8)
    //   3 (0,10)
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 1 },
      { x: 10, y: -8 },
      { x: 0, y: 10 },
    ];
    expect(spatialStep("ArrowRight", 0, pts)).toBe(1);
    expect(spatialStep("ArrowUp", 1, pts)).toBe(2);
    expect(spatialStep("ArrowDown", 0, pts)).toBe(3);
    expect(spatialStep("ArrowLeft", 0, pts)).toBe(0); // nothing that way: stays
    expect(spatialStep("End", 0, pts)).toBe(3);
    expect(spatialStep("x", 0, pts)).toBeNull();
  });
});

describe("legends", () => {
  const seq: Scale = { type: "sequential", bins: 4 };
  const fmt = (v: number) => String(v);

  it("labels each bin with its range, open-ended where values were clamped", () => {
    expect(binLabels(seq, [0, 100], fmt)).toEqual(["0 to 25", "25 to 50", "50 to 75", "75 to 100"]);
    expect(binLabels(seq, [0, 100], fmt, { below: true, above: true })).toEqual(["< 25", "25 to 50", "50 to 75", "> 75"]);
    // Edges round to what the bin width needs: 8.57-wide bins read as whole numbers.
    expect(binLabels({ type: "diverging", bins: 7 }, [-30, 30], fmt)[0]).toBe("-30 to -21");
    expect(binLabels({ type: "sequential", bins: 5 }, [0, 1], fmt)[1]).toBe("0.2 to 0.4");
  });

  it("picks three round bubble sizes under the largest value", () => {
    expect(sizeLegendValues(7.9)).toEqual([5, 2, 0.5]);
    expect(sizeLegendValues(1500)).toEqual([1000, 500, 100]);
    expect(sizeLegendValues(0)).toEqual([]);
  });
});
