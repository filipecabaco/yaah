// Fitting the map to its markers (map.tsx), apart from Leaflet so it is tested without it.
// Leaflet measures its container when it is created; in a transcript the container can still be
// 0×0 then (off screen entries skip layout, a lazily loaded card, a pane mid-resize), and a fit
// computed at that size zooms to the maximum on the wrong spot. So the fit waits for a real
// size, runs again whenever the size or the markers change, and stops once the user has panned
// or zoomed: the map is theirs from then on.

export type LatLng = [number, number];
/** Room kept around the markers, in px: a marker's 8px radius, its ring, and its tooltip's arrow. */
export const FIT_PADDING = 40;
/** The closest a fit zooms: one marker, or several on one spot, show their street, not a doorstep. */
export const FIT_MAX_ZOOM = 13;

export type FitTarget = { kind: "none" } | { kind: "point"; center: LatLng; zoom: number } | { kind: "bounds"; bounds: [LatLng, LatLng] };

/** What to show for these markers: nothing, one spot at FIT_MAX_ZOOM, or the box around them all. */
export function fitTarget(markers: { lat: number; lng: number }[]): FitTarget {
  if (!markers.length) return { kind: "none" };
  const lats = markers.map((m) => m.lat);
  const lngs = markers.map((m) => m.lng);
  const sw: LatLng = [Math.min(...lats), Math.min(...lngs)];
  const ne: LatLng = [Math.max(...lats), Math.max(...lngs)];
  if (sw[0] === ne[0] && sw[1] === ne[1]) return { kind: "point", center: sw, zoom: FIT_MAX_ZOOM };
  return { kind: "bounds", bounds: [sw, ne] };
}

/** The parts of a Leaflet map the fit uses. */
export type FitMap = {
  invalidateSize(options?: { pan?: boolean; animate?: boolean }): unknown;
  fitBounds(bounds: [LatLng, LatLng], options: { padding: [number, number]; maxZoom: number; animate: boolean }): unknown;
  setView(center: LatLng, zoom: number, options: { animate: boolean }): unknown;
  on(type: string, fn: () => void): unknown;
  off(type: string, fn: () => void): unknown;
};

/**
 * Keeps `map` fitted: `resized(w, h)` with the container's size (from a ResizeObserver),
 * `markers(list)` when they change. Moves the map itself makes don't count as the user's.
 */
export function fitController(map: FitMap) {
  let size = { w: 0, h: 0 };
  let target: FitTarget = { kind: "none" };
  let ours = false;
  let user = false;
  const moved = () => {
    if (!ours) user = true;
  };
  map.on("movestart", moved);
  map.on("zoomstart", moved);
  const quietly = (f: () => void) => {
    ours = true;
    try {
      f();
    } finally {
      ours = false;
    }
  };
  const fit = () => {
    if (user || size.w <= 0 || size.h <= 0 || target.kind === "none") return;
    const t = target;
    quietly(() => {
      if (t.kind === "point") map.setView(t.center, t.zoom, { animate: false });
      else map.fitBounds(t.bounds, { padding: [FIT_PADDING, FIT_PADDING], maxZoom: FIT_MAX_ZOOM, animate: false });
    });
  };
  return {
    resized(w: number, h: number) {
      if (w === size.w && h === size.h) return;
      size = { w, h };
      if (w <= 0 || h <= 0) return;
      // Leaflet caches its size: tell it, so tiles load for the whole box and the fit uses the real one.
      quietly(() => map.invalidateSize({ pan: false, animate: false }));
      fit();
    },
    markers(list: { lat: number; lng: number }[]) {
      target = fitTarget(list);
      fit();
    },
    /** Whether the user has moved the map (and so it no longer fits itself). */
    get userMoved() {
      return user;
    },
    dispose() {
      map.off("movestart", moved);
      map.off("zoomstart", moved);
    },
  };
}
