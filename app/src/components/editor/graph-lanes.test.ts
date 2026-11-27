import { describe, expect, it } from "vitest";
import { layoutGraph } from "./graph-lanes";

describe("layoutGraph", () => {
  it("keeps a straight history in one lane", () => {
    const rows = layoutGraph([
      { sha: "c", parents: ["b"] },
      { sha: "b", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(rows[1].segments).toEqual([
      { from: 0, to: null, color: 0 },
      { from: null, to: 0, color: 0 },
    ]);
    expect(rows[2].segments).toEqual([{ from: 0, to: null, color: 0 }]);
  });

  it("opens a lane for a merge's second parent and closes it where the branches meet", () => {
    // m merges f into b; f and b both come from a.
    const rows = layoutGraph([
      { sha: "m", parents: ["b", "f"] },
      { sha: "f", parents: ["a"] },
      { sha: "b", parents: ["a"] },
      { sha: "a", parents: [] },
    ]);
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 0]);
    expect(rows[0].width).toBe(2);
    // At f, lane 0 (waiting for b) passes by.
    expect(rows[1].segments).toContainEqual({ from: 0, to: 0, color: 0 });
    // At b both lanes wait for a; at a they meet.
    expect(rows[3].segments.filter((s) => s.to === null)).toHaveLength(2);
  });
});
