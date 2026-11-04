// Fitting the map to its markers, against a fake Leaflet map (map-fit.ts).
import { describe, expect, it } from "vitest";
import { FIT_MAX_ZOOM, FIT_PADDING, fitController, fitTarget, type FitMap } from "@/components/ui-blocks/map-fit";

/** A stand-in for Leaflet's map: records calls and fires movestart/zoomstart as Leaflet does, synchronously. */
function fakeMap() {
  const handlers: Record<string, (() => void)[]> = {};
  const fire = (t: string) => (handlers[t] ?? []).forEach((f) => f());
  const calls: string[] = [];
  const map: FitMap = {
    invalidateSize: () => calls.push("invalidateSize"),
    fitBounds: (b, o) => {
      calls.push(`fitBounds ${JSON.stringify(b)} padding ${o.padding.join(",")} max ${o.maxZoom}`);
      fire("movestart");
      fire("zoomstart");
    },
    setView: (c, z) => {
      calls.push(`setView ${JSON.stringify(c)} ${z}`);
      fire("movestart");
    },
    on: (t, f) => (handlers[t] ??= []).push(f),
    off: (t, f) => (handlers[t] = (handlers[t] ?? []).filter((g) => g !== f)),
  };
  return { map, calls, fire, handlers };
}

const hubs = [
  { lat: 51.92, lng: 4.48 },
  { lat: 37.98, lng: 23.73 },
  { lat: 57.71, lng: 11.97 },
];

describe("fitTarget", () => {
  it("boxes several markers, and shows one spot at a street-level zoom", () => {
    expect(fitTarget([])).toEqual({ kind: "none" });
    expect(fitTarget(hubs)).toEqual({
      kind: "bounds",
      bounds: [
        [37.98, 4.48],
        [57.71, 23.73],
      ],
    });
    const one = { lat: 51.92, lng: 4.48 };
    expect(fitTarget([one])).toEqual({ kind: "point", center: [51.92, 4.48], zoom: FIT_MAX_ZOOM });
    expect(fitTarget([one, { ...one }, { ...one }])).toEqual({ kind: "point", center: [51.92, 4.48], zoom: FIT_MAX_ZOOM });
  });
});

describe("fitController", () => {
  it("waits for a real size before fitting, then tells Leaflet the size and fits with padding", () => {
    const { map, calls } = fakeMap();
    const fit = fitController(map);
    fit.markers(hubs);
    fit.resized(0, 0);
    expect(calls).toEqual([]);
    fit.resized(800, 340);
    const box = [
      [37.98, 4.48],
      [57.71, 23.73],
    ];
    expect(calls).toEqual(["invalidateSize", `fitBounds ${JSON.stringify(box)} padding ${FIT_PADDING},${FIT_PADDING} max ${FIT_MAX_ZOOM}`]);
    expect(FIT_PADDING).toBeGreaterThanOrEqual(32);
  });

  it("refits when the markers change and when the container resizes", () => {
    const { map, calls } = fakeMap();
    const fit = fitController(map);
    fit.resized(800, 340);
    fit.markers(hubs);
    fit.markers([hubs[0]]);
    expect(calls.at(-1)).toBe(`setView [51.92,4.48] ${FIT_MAX_ZOOM}`);
    calls.length = 0;
    fit.resized(420, 340);
    expect(calls).toEqual(["invalidateSize", "setView [51.92,4.48] 13"]);
    // The same size again is no change.
    fit.resized(420, 340);
    expect(calls).toHaveLength(2);
    // Its own moves don't count as the user's.
    expect(fit.userMoved).toBe(false);
  });

  it("stops fitting once the user pans or zooms", () => {
    const { map, calls, fire } = fakeMap();
    const fit = fitController(map);
    fit.resized(800, 340);
    fit.markers(hubs);
    fire("zoomstart");
    expect(fit.userMoved).toBe(true);
    calls.length = 0;
    fit.resized(1000, 500);
    fit.markers([hubs[0]]);
    // Leaflet still learns the new size, but the view is left where the user put it.
    expect(calls).toEqual(["invalidateSize"]);
  });

  it("lets go of the map's events when disposed", () => {
    const { map, handlers } = fakeMap();
    const fit = fitController(map);
    fit.dispose();
    expect(handlers.movestart).toEqual([]);
    expect(handlers.zoomstart).toEqual([]);
  });
});
