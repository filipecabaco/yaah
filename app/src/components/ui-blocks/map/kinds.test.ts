// The phase-2 map rules without a renderer: plain land for a mostly-missing choropleth, labels at
// the pole of inaccessibility and only inside their shape, bubble labels round their marks, great
// circles and their widths and arrowheads, hexagon binning, the 50m world for zoomed views, and
// the props each new kind reads.
import { describe, expect, it } from "vitest";
import { geoInterpolate, geoNaturalEarth1 } from "d3-geo";
import {
  clipRings,
  ink,
  insideRings,
  PLACE_LABEL_CHARS,
  placePointLabels,
  placeRegionLabels,
  poleOf,
  rectInside,
} from "@/components/ui-blocks/map/labels";
import {
  arcMidpoint,
  arcRuns,
  arrowHead,
  byValue,
  hubWeights,
  LINK_WIDTH,
  linkOrder,
  linkWidth,
  trimEnd,
} from "@/components/ui-blocks/map/connection";
import { binPoints } from "@/components/ui-blocks/map/hexbin";
import { CAPS, missingMode, readMapModel } from "@/components/ui-blocks/map/model";
import { loadDetail, loadRegion, wantsDetail } from "@/components/ui-blocks/map/geo";
import { fitProjection, projectedRings, type Ring } from "@/components/ui-blocks/map/projection";

// An L: its centroid falls in the notch, outside the shape (Mexico's problem, squared off).
const L: Ring[] = [
  [
    [0, 0],
    [100, 0],
    [100, 20],
    [20, 20],
    [20, 100],
    [0, 100],
  ],
];

describe("choropleth missing regions", () => {
  it("hatches the gaps while most regions have a row, else draws them as plain land, unless told", () => {
    expect(missingMode(undefined, 51, 51)).toBe("hatch");
    expect(missingMode(undefined, 51, 30)).toBe("hatch");
    expect(missingMode(undefined, 51, 14)).toBe("land");
    expect(missingMode(undefined, 177, 44)).toBe("land");
    expect(missingMode("hatch", 177, 44)).toBe("hatch");
    expect(missingMode("land", 51, 50)).toBe("land");
  });
});

describe("region labels inside their shape", () => {
  it("finds the point furthest inside, not the centroid in the notch", () => {
    const pole = poleOf(L, 0.5);
    expect(insideRings(L, pole.x, pole.y)).toBe(true);
    expect(pole.d).toBeGreaterThan(9);
    // The centroid of the L's outline lies in its notch.
    expect(insideRings(L, 35, 35)).toBe(false);
  });

  it("places a label only where its whole box lies inside the rings, else skips it", () => {
    const at = { x: 35, y: 35 };
    const wide = placeRegionLabels([{ key: "a", texts: ["Mexico"], at, box: { w: 100, h: 100 }, rings: L }], 11, { width: 200, height: 200 });
    // The pole is in the corner; the label slides along the top arm, wholly inside.
    expect(wide).toHaveLength(1);
    expect(rectInside(L, ink(wide[0].rect, 11))).toBe(true);
    expect(wide[0].x).toBeGreaterThan(20);
    const thin: Ring[] = [
      [
        [0, 40],
        [30, 40],
        [30, 48],
        [0, 48],
      ],
    ];
    expect(
      placeRegionLabels([{ key: "t", texts: ["Chile"], at: { x: 15, y: 44 }, box: { w: 30, h: 8 }, rings: thin }], 11, { width: 100, height: 100 }),
    ).toEqual([]);
    // Forced (few regions): the shortest text at the pole, inside or not.
    const forced = placeRegionLabels(
      [{ key: "t", texts: ["Chile", "CL"], at: { x: 15, y: 44 }, box: { w: 30, h: 8 }, rings: thin, force: true }],
      11,
      { width: 100, height: 100 },
    );
    expect(forced.map((l) => l.text)).toEqual(["CL"]);
  });

  it("cuts rings to the map, so a region running off it is labelled in the part that shows", () => {
    const [cut] = clipRings(L, 50, 50);
    expect(Math.max(...cut.map((p) => p[1]))).toBe(50);
    expect(Math.max(...cut.map((p) => p[0]))).toBe(50);
    expect(insideRings([cut], 10, 45)).toBe(true);
    expect(clipRings(L, 50, 50).length).toBe(1);
    expect(
      clipRings(
        [
          [
            [200, 200],
            [300, 200],
            [300, 300],
          ],
        ],
        50,
        50,
      ),
    ).toEqual([]);
  });

  it("puts Mexico's label inside Mexico on the world map", async () => {
    const world = await loadRegion("world");
    const p = fitProjection(world, { kind: "frame" }, 900, 460);
    const mex = world.byId.get("MEX")!;
    const rings = projectedRings(p.path, mex.feature);
    const [[x0, y0], [x1, y1]] = p.path.bounds(mex.feature);
    const [cx, cy] = p.path.centroid(mex.feature);
    const [l] = placeRegionLabels([{ key: "MEX", texts: ["Mexico", "MX"], at: { x: cx, y: cy }, box: { w: x1 - x0, h: y1 - y0 }, rings }], 11, {
      width: 900,
      height: 460,
    });
    // Its glyphs inside Mexico (it used to sit on the Gulf coast, at the box's centre).
    expect(l).toBeDefined();
    expect(rectInside(rings, ink(l.rect, 11))).toBe(true);
  });
});

describe("place labels", () => {
  it("tries right, left, above and below, keeps off other marks' centres, cuts long names and stops at the cap", () => {
    const marks = [
      { key: "a", x: 100, y: 50, r: 10 },
      { key: "b", x: 125, y: 50, r: 4 },
    ];
    const [a] = placePointLabels(
      [{ key: "a", text: "Amsterdam", x: 100, y: 50, r: 10 }],
      11,
      { width: 400, height: 100 },
      { around: true, avoid: marks },
    );
    // Right would cover b's centre: it goes left.
    expect(a.anchor).toBe("end");
    const boxed = placePointLabels(
      [{ key: "a", text: "Amsterdam", x: 60, y: 50, r: 10 }],
      11,
      { width: 120, height: 100 },
      {
        around: true,
        avoid: [...marks, { key: "c", x: 30, y: 50, r: 4 }],
      },
    );
    expect(boxed[0].anchor).toBe("middle");
    const long = placePointLabels([{ key: "x", text: "Llanfairpwllgwyngyll station", x: 10, y: 50, r: 2 }], 11, { width: 900, height: 100 });
    expect(long[0].text).toHaveLength(PLACE_LABEL_CHARS);
    expect(long[0].text.endsWith("…")).toBe(true);
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, text: "Place", x: 20 + i * 60, y: 50, r: 3 }));
    expect(placePointLabels(many, 11, { width: 2000, height: 100 }, { cap: 10 })).toHaveLength(10);
  });
});

describe("connection", () => {
  const proj = geoNaturalEarth1().fitSize([960, 500], { type: "Sphere" });
  const point = (lon: number, lat: number) => proj([lon, lat]) ?? null;

  it("follows the great circle, its midpoint the geodesic one", () => {
    const lis: [number, number] = [-9.14, 38.77];
    const jfk: [number, number] = [-73.78, 40.64];
    const runs = arcRuns(point, lis, jfk, 300);
    expect(runs).toHaveLength(1);
    const mid = arcMidpoint(point, lis, jfk)!;
    expect(mid).toEqual(proj(geoInterpolate(lis, jfk)(0.5)));
    // The great circle bows north of the straight line between them.
    expect(mid[1]).toBeLessThan((point(...lis)![1] + point(...jfk)![1]) / 2);
  });

  it("splits an arc that wraps round the antimeridian", () => {
    const runs = arcRuns(point, [139.7, 35.7], [-122.4, 37.8], 300);
    expect(runs.length).toBe(2);
  });

  it("widths are linear over [0, max]; no value is the fixed width; thickest drawn first", () => {
    const w = linkWidth(10);
    expect(w(0)).toBe(LINK_WIDTH[0]);
    expect(w(10)).toBe(LINK_WIDTH[1]);
    expect(w(20)).toBe(LINK_WIDTH[1]);
    expect(w(5)).toBeCloseTo((LINK_WIDTH[0] + LINK_WIDTH[1]) / 2);
    expect(w(undefined)).toBe(2);
    const links = [
      { from: "a", to: "b", value: 1 },
      { from: "a", to: "c", value: 9 },
      { from: "b", to: "c" },
    ];
    expect(linkOrder(links)).toEqual([1, 0, 2]);
    expect(byValue(undefined, links)).toBe(true);
    expect(byValue("fixed", links)).toBe(false);
    expect(byValue(undefined, [{ from: "a", to: "b" }])).toBe(false);
    expect(hubWeights([{ id: "a" }, { id: "b" }, { id: "c" }], links)).toEqual(
      new Map([
        ["a", 10],
        ["b", 1],
        ["c", 9],
      ]),
    );
  });

  it("an arrowhead's tip is the trimmed end, pointing along the last step", () => {
    const runs = trimEnd(
      [
        [
          [0, 0],
          [100, 0],
        ],
      ],
      6,
    );
    expect(runs[0][1]).toEqual([94, 0]);
    const head = arrowHead(runs, 2)!;
    expect(head.startsWith("M94.0,0.0")).toBe(true);
    expect(arrowHead([], 2)).toBeNull();
  });
});

describe("hexbin", () => {
  const identity = (lon: number, lat: number): [number, number] => [lon, lat];
  const pts = [
    { lon: 10, lat: 10, weight: 2 },
    { lon: 11, lat: 10, weight: 4 },
    { lon: 12, lat: 11 },
    { lon: 80, lat: 80, weight: 1 },
    { lon: 500, lat: 10 },
  ];

  it("counts points per cell, sums or averages weights, and leaves points off the box out", () => {
    const counted = binPoints(pts, identity, { radius: 10, width: 100, height: 100, aggregate: "count" });
    expect(counted.dropped).toBe(1);
    expect(counted.cells.map((c) => c.value).sort()).toEqual([1, 3]);
    const sum = binPoints(pts, identity, { radius: 10, width: 100, height: 100, aggregate: "sum" });
    expect(sum.cells.map((c) => c.value).sort()).toEqual([1, 6]);
    const mean = binPoints(pts, identity, { radius: 10, width: 100, height: 100, aggregate: "mean" });
    expect(mean.cells.map((c) => c.value).sort()).toEqual([1, 3]);
    expect(mean.cells.find((c) => c.value === 3)!.n).toBe(3);
    expect(counted.path.startsWith("m")).toBe(true);
  });
});

describe("the 50m world", () => {
  it("is drawn only for narrow world views, and carries the same ids", async () => {
    expect(wantsDetail("world", null)).toBe(false);
    expect(wantsDetail("world", [-180, -85, 180, 85])).toBe(false);
    expect(wantsDetail("world", [-10, 36, 4, 44])).toBe(true);
    expect(wantsDetail("europe", [-10, 36, 4, 44])).toBe(false);
    const [coarse, fine] = await Promise.all([loadRegion("world"), loadDetail()]);
    expect(new Set(fine.regions.map((r) => r.id))).toEqual(new Set(coarse.regions.map((r) => r.id)));
    const vertices = (id: string, g: typeof coarse) => JSON.stringify(g.byId.get(id)!.feature.geometry).length;
    expect(vertices("PRT", fine)).toBeGreaterThan(vertices("PRT", coarse) * 2);
  });
});

describe("new props", () => {
  it("reads hubs and links (unknown ends and self-links left out), hexbin points and their options", () => {
    const c = readMapModel({
      kind: "connection",
      hubs: [
        { id: "LIS", label: "Lisbon", lon: -9.1, lat: 38.8 },
        { id: "JFK", lon: -73.8, lat: 40.6 },
        { id: "LIS", lon: 0, lat: 0 },
        { id: "bad", lon: 400, lat: 0 },
      ],
      links: [
        { from: "LIS", to: "JFK", value: 9 },
        { from: "LIS", to: "LIS", value: 1 },
        { from: "LIS", to: "XXX" },
        { from: "JFK", to: "LIS", value: -3 },
      ],
      directed: true,
      width: "fixed",
    });
    expect(c.hubs.map((h) => h.label)).toEqual(["Lisbon", "JFK"]);
    expect(c.links).toEqual([
      { from: "LIS", to: "JFK", value: 9, label: undefined, detail: undefined },
      { from: "JFK", to: "LIS", value: undefined, label: undefined, detail: undefined },
    ]);
    expect(c.directed).toBe(true);
    expect(c.width).toBe("fixed");
    expect(c.points).toEqual([]);
    const h = readMapModel({
      kind: "hexbin",
      points: [{ lon: 1, lat: 2 }, { lon: 1, lat: 2, weight: 3 }, { lat: 1 }],
      radius: 100,
      aggregate: "mean",
    });
    expect(h.hexPoints).toEqual([
      { lon: 1, lat: 2 },
      { lon: 1, lat: 2, weight: 3 },
    ]);
    expect(h.radius).toBe(40);
    expect(h.aggregate).toBe("mean");
    expect(h.points).toEqual([]);
    expect(readMapModel({ kind: "hexbin", points: Array.from({ length: 6000 }, () => ({ lon: 0, lat: 0 })) }).hexPoints).toHaveLength(CAPS.hexPoints);
    expect(readMapModel({ kind: "choropleth", missing: "land" }).missing).toBe("land");
    expect(readMapModel({ kind: "choropleth", missing: "grey" }).missing).toBeUndefined();
  });
});
