// Marker clusters on the street map, without Leaflet (map-cluster.ts): grid grouping, the worst
// status, when clustering is on, and a cluster's name.
import { describe, expect, it } from "vitest";
import { CLUSTER_MAX_ZOOM, CLUSTER_MIN, clusterGrid, clusterName, shouldCluster } from "@/components/ui-blocks/map-cluster";

describe("marker clusters", () => {
  it("groups markers sharing a grid cell, at their mean, keeping lone ones as they are", () => {
    const groups = clusterGrid(
      [
        [10, 10],
        [20, 30],
        [200, 200],
        [30, 12],
      ],
      ["default", "warning", "default", "success"],
    );
    expect(groups).toEqual([
      { kind: "many", members: [0, 1, 3], x: 20, y: 52 / 3, tone: "warning", tones: { default: 1, warning: 1, success: 1 } },
      { kind: "one", index: 2 },
    ]);
  });

  it("clusters from 40 markers when automatic, as told otherwise, never close in", () => {
    expect(shouldCluster("auto", CLUSTER_MIN - 1, 5)).toBe(false);
    expect(shouldCluster("auto", CLUSTER_MIN, 5)).toBe(true);
    expect(shouldCluster(true, 3, 5)).toBe(true);
    expect(shouldCluster(false, 500, 5)).toBe(false);
    expect(shouldCluster(true, 500, CLUSTER_MAX_ZOOM)).toBe(false);
  });

  it("names a cluster by its count and statuses, worst first", () => {
    const [g] = clusterGrid(
      [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
      ["danger", "success", "danger"],
    );
    expect(g.kind === "many" && clusterName(g)).toBe("3 places, 2 problem, 1 good. Zoom in to see them");
  });
});
