// Region maps without a renderer: projection fits and the percentile view, scale binning with
// fences and clamped ends, hatching for missing data, bubble radii and order, which labels show,
// label placement, region ids, and the generated id list against the bundled geometry.
import { describe, expect, it } from "vitest";
import { geoBounds } from "d3-geo";
import { feature } from "topojson-client";
import type { FeatureCollection } from "geojson";
import type { Topology } from "topojson-specification";
import regionIds from "@/assets/geo/region-ids.json";
import { binOf, fencedDomain, type Scale } from "@/components/ui-blocks/scale";
import { loadRegion, resolveId, REGION_SETS, type RegionGeo } from "@/components/ui-blocks/map/geo";
import { FIT_PAD, fitProjection, inBox, percentileView } from "@/components/ui-blocks/map/projection";
import { bubbleOrder, bubbleRadius, defaultMaxRadius, fillFor, labelled, MIN_RADIUS, readMapModel } from "@/components/ui-blocks/map/model";
import { fitInBox, placePointLabels, placeRegionLabels } from "@/components/ui-blocks/map/labels";

const geos = Object.fromEntries(await Promise.all(REGION_SETS.map(async (s) => [s, await loadRegion(s)] as const))) as Record<string, RegionGeo>;
const SIZES: [number, number][] = [
  [360, 200],
  [900, 500],
  [252, 252],
  [1400, 760],
];

describe("projection fit", () => {
  it("puts each set's frame inside the padded box at every size, filling one side", () => {
    for (const set of REGION_SETS) {
      for (const [w, h] of SIZES) {
        const p = fitProjection(geos[set], { kind: "frame" }, w, h);
        const shape =
          set === "world"
            ? ({ type: "Sphere" } as const)
            : set === "us-states"
              ? { type: "FeatureCollection" as const, features: geos[set].regions.map((r) => r.feature) }
              : null;
        if (!shape) continue;
        const [[x0, y0], [x1, y1]] = p.path.bounds(shape);
        expect(x0).toBeGreaterThanOrEqual(FIT_PAD - 0.5);
        expect(y0).toBeGreaterThanOrEqual(FIT_PAD - 0.5);
        expect(x1).toBeLessThanOrEqual(w - FIT_PAD + 0.5);
        expect(y1).toBeLessThanOrEqual(h - FIT_PAD + 0.5);
        // It fills the box along one axis.
        expect(Math.max((x1 - x0) / (w - 2 * FIT_PAD), (y1 - y0) / (h - 2 * FIT_PAD))).toBeGreaterThan(0.98);
      }
    }
  });

  it("fits a box of places, and places US cities through the atlas's own Albers USA", () => {
    const p = fitProjection(geos.europe, { kind: "bbox", bbox: [-10, 36, 25, 60] }, 600, 400);
    for (const [lon, lat] of [
      [-9.14, 38.72],
      [21.01, 52.23],
    ])
      expect(inBox(p.point(lon, lat), 600, 400)).toBe(true);
    expect(inBox(p.point(100, 10), 600, 400)).toBe(false);
    const us = fitProjection(geos["us-states"], { kind: "frame" }, 975, 610);
    const philly = us.point(-75.16, 39.95)!;
    const pa = geos["us-states"].byId.get("PA")!;
    const [[x0, y0], [x1, y1]] = us.path.bounds(pa.feature);
    expect(philly[0]).toBeGreaterThan(x0);
    expect(philly[0]).toBeLessThan(x1);
    expect(philly[1]).toBeGreaterThan(y0);
    expect(philly[1]).toBeLessThan(y1);
    expect(us.point(-9.14, 38.72)).toBeNull(); // Lisbon isn't in Albers USA
  });

  it("fits most places from 20 up, leaving the far-off ones outside the view", () => {
    const mainland = Array.from({ length: 22 }, (_, i) => ({ lon: -9 + (i % 6) * 5, lat: 38 + Math.floor(i / 6) * 4 }));
    const islands = [
      { lon: -31.1, lat: 39.45 }, // Flores, Azores
      { lon: -23.51, lat: 14.93 }, // Praia, Cape Verde
    ];
    const v = percentileView([...mainland, ...islands])!;
    expect(v.outside.sort()).toEqual([22, 23]);
    expect(v.bbox[0]).toBeGreaterThan(-31.1);
    expect(v.bbox[1]).toBeGreaterThan(14.93);
    // The ordinary ends of a spread stay: only places far past the rest are left out.
    expect(percentileView(mainland)!.outside).toEqual([]);
    // Under 20 places nothing is cut.
    expect(percentileView([...mainland.slice(0, 10), ...islands])!.outside).toEqual([]);
    // One place: a city, not a doorstep.
    const one = percentileView([{ lon: 2.35, lat: 48.86 }])!.bbox;
    expect(one[2] - one[0]).toBeGreaterThanOrEqual(3);
    expect(percentileView([])).toBeNull();
  });
});

describe("scale binning", () => {
  const seq: Scale = { type: "sequential", bins: 5 };

  it("bins exact thresholds into the upper bin and clamps outliers into the end bins", () => {
    expect([0, 19.99, 20, 40, 99.9, 100].map((v) => binOf(seq, [0, 100], v))).toEqual([0, 0, 1, 2, 4, 4]);
    expect(binOf(seq, [0, 100], -50)).toBe(0);
    expect(binOf(seq, [0, 100], 1e9)).toBe(4);
  });

  it("splits a diverging scale at its midpoint", () => {
    const div: Scale = { type: "diverging", bins: 7, midpoint: 0 };
    expect(binOf(div, [-30, 30], 0)).toBe(3);
    expect(binOf(div, [-30, 30], -0.1)).toBe(3);
    expect(binOf(div, [-30, 30], -30)).toBe(0);
    expect(binOf(div, [-30, 30], 30)).toBe(6);
  });

  it("fences an outlier off an unset domain (Tukey), with round ends and the clamped side open", () => {
    const values = [10, 11, 12, 12, 13, 14, 15, 16, 400];
    const f = fencedDomain(seq, values);
    expect(f.domain[1]).toBeLessThan(400);
    expect(f.domain[1]).toBeGreaterThanOrEqual(16);
    expect(f.clipped).toBe(true);
    expect(f.above).toBe(true);
    expect(f.below).toBe(false);
    expect(f.domain.every((d) => Number.isInteger(d))).toBe(true);
    // Under 8 values, or a domain given: no fences.
    expect(fencedDomain(seq, [1, 2, 400]).clipped).toBe(false);
    expect(fencedDomain({ ...seq, domain: [0, 50] }, values)).toEqual({ domain: [0, 50], clipped: false, below: false, above: true });
    // A diverging one stays even about its midpoint.
    const d = fencedDomain({ type: "diverging", bins: 7, midpoint: 0 }, [-6, -3, -1, 0, 1, 2, 3, 5, 80]).domain;
    expect(d[0]).toBe(-d[1]);
  });

  it("hatches missing data, never giving it the lowest class", () => {
    expect(fillFor(null, seq, [0, 100])).toEqual({ kind: "none" });
    expect(fillFor(undefined, seq, [0, 100])).toEqual({ kind: "none" });
    expect(fillFor(Number.NaN, seq, [0, 100])).toEqual({ kind: "none" });
    expect(fillFor(0, seq, [0, 100])).toEqual({ kind: "bin", bin: 0, color: "var(--scale-seq-100)" });
    expect(fillFor(100, seq, [0, 100])).toEqual({ kind: "bin", bin: 4, color: "var(--scale-seq-700)" });
  });
});

describe("bubbles", () => {
  it("makes area proportional to value, zero nothing, and a small positive value still visible", () => {
    const r = bubbleRadius(100, 40);
    expect(r(100)).toBe(40);
    expect(r(0)).toBe(0);
    expect(r(-5)).toBe(0);
    expect(Math.PI * r(50) ** 2 * 2).toBeCloseTo(Math.PI * r(100) ** 2, 6);
    expect(r(0.0001)).toBe(MIN_RADIUS);
    expect(defaultMaxRadius(1400, 420)).toBe(30);
    expect(defaultMaxRadius(100, 50)).toBe(6);
  });

  it("draws the largest first and leaves negative values out, counted", () => {
    expect(bubbleOrder([{ value: 1 }, { value: 9 }, { value: -2 }, { value: 4 }])).toEqual({ order: [1, 3, 0], negative: 1 });
  });

  it("labels every place up to 12, else the 5 biggest", () => {
    expect(labelled([1, 2, 3], "auto").size).toBe(3);
    const many = Array.from({ length: 20 }, (_, i) => i);
    expect([...labelled(many, "auto")].sort((a, b) => a - b)).toEqual([15, 16, 17, 18, 19]);
    expect(labelled(many, "none").size).toBe(0);
    expect(
      labelled(
        Array.from({ length: 40 }, () => 1),
        "all",
      ).size,
    ).toBe(24);
  });
});

describe("labels", () => {
  it("picks the first text that fits a region's box", () => {
    expect(fitInBox(["Pennsylvania", "PA"], { w: 60, h: 30 }, 11)).toBe("PA");
    expect(fitInBox(["Brazil", "BR"], { w: 200, h: 100 }, 11)).toBe("Brazil");
    expect(fitInBox(["Malta", "MT"], { w: 4, h: 4 }, 11)).toBeNull();
  });

  it("never overlaps two labels, biggest regions first, and keeps clear of places", () => {
    const placed = placeRegionLabels(
      [
        { key: "a", texts: ["Alpha"], at: { x: 100, y: 100 }, box: { w: 200, h: 100 } },
        { key: "b", texts: ["Beta"], at: { x: 105, y: 102 }, box: { w: 100, h: 50 } },
        { key: "c", texts: ["Gamma"], at: { x: 300, y: 100 }, box: { w: 100, h: 50 } },
      ],
      11,
      { width: 500, height: 300 },
      Infinity,
      [{ x0: 290, y0: 95, x1: 310, y1: 105 }],
    );
    expect(placed.map((p) => p.key)).toEqual(["a"]);
  });

  it("puts a place's label right of its mark, left at the edge, else none", () => {
    const [a, b] = placePointLabels(
      [
        { key: "a", text: "Lisbon", x: 50, y: 50, r: 4 },
        { key: "b", text: "Helsinki", x: 495, y: 50, r: 4 },
      ],
      11,
      { width: 500, height: 100 },
    );
    expect(a.anchor).toBe("start");
    expect(a.x).toBeGreaterThan(54);
    expect(b.anchor).toBe("end");
    const crowded = placePointLabels(
      [
        { key: "a", text: "Lisbon", x: 100, y: 50, r: 4 },
        { key: "b", text: "Lisboa", x: 100, y: 51, r: 4 },
        { key: "c", text: "Lissabon", x: 100, y: 52, r: 4 },
      ],
      11,
      { width: 500, height: 100 },
    );
    expect(crowded.map((p) => p.key)).toEqual(["a", "b"]);
  });
});

describe("region ids", () => {
  it("resolves codes, numbers and names to the canonical id", () => {
    const w = geos.world;
    for (const raw of ["PRT", "PT", "pt", "620", 620, "Portugal"]) expect(resolveId(w, raw)).toBe("PRT");
    expect(resolveId(w, "United States")).toBe("USA");
    expect(resolveId(w, "Atlantis")).toBeNull();
    const us = geos["us-states"];
    for (const raw of ["PA", "42", 42, "Pennsylvania", "pennsylvania"]) expect(resolveId(us, raw)).toBe("PA");
    expect(resolveId(us, 6)).toBe("CA");
    expect(resolveId(geos.europe, "MT")).toBe("MLT");
  });

  it("lists exactly the regions each bundled geometry carries (the file Rust validates against)", async () => {
    const ids = regionIds as Record<string, { id: string }[]>;
    for (const set of REGION_SETS) {
      expect(ids[set].map((r) => r.id).sort()).toEqual(geos[set].regions.map((r) => r.id).sort());
    }
    expect(geos["us-states"].regions).toHaveLength(51);
    // Antarctica is land on the world map, not a region a value goes to.
    expect(geos.world.byId.has("ATA")).toBe(false);
    // Europe's overseas parts were clamped off: France stays in Europe.
    const raw = (await import("@/assets/geo/europe.topo.json?raw")).default;
    const topo = JSON.parse(raw) as Topology;
    const fc = feature(topo, topo.objects.regions) as FeatureCollection;
    const [[w, s], [e]] = geoBounds(fc.features.find((f) => f.id === "FRA")!);
    expect(w).toBeGreaterThan(-60);
    expect(e).toBeLessThan(100);
    expect(s).toBeGreaterThan(14);
  });
});

describe("props", () => {
  it("reads, defaults and caps what the agent sent", () => {
    const m = readMapModel({
      kind: "choropleth",
      region: "mars",
      height: 5000,
      labels: "bogus",
      data: Array.from({ length: 4000 }, (_, i) => ({ id: i, value: i })),
    });
    expect(m.region).toBe("world");
    expect(m.height).toBe(900);
    expect(m.labels).toBe("auto");
    expect(m.data).toHaveLength(3000);
    expect(m.legend.show).toBe(true);
    const b = readMapModel({
      kind: "bubble",
      points: [
        { lon: 1, lat: 2, value: 3, label: "x" },
        { lon: 500, lat: 2, value: 1 },
        { lon: 1, lat: 2 },
      ],
    });
    expect(b.points).toHaveLength(1);
    expect(readMapModel({ kind: "outline", view: [10, 0, 0, 10] }).view).toBe("auto");
    expect(readMapModel({ kind: "outline", view: [-10, 35, 30, 60] }).view).toEqual([-10, 35, 30, 60]);
  });
});
