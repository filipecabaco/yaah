// `map` primitive, kind `markers` (the default) — Leaflet via react-leaflet, OpenStreetMap tiles.
// Loaded on demand; the region kinds (outline, choropleth, bubble, connection, hexbin) are
// map/geo-map.tsx and never load Leaflet. Marker labels and details are React children (portalled
// into Leaflet's tooltip/popup), so agent text is shown as text, never parsed as HTML. In a dark
// theme the tiles are inverted by a CSS filter (index.css, `.ui-map-tiles`): no second tile host,
// and the markers and labels, in other panes, keep their colours. Expanded, the map takes the
// dialog's height and refits once the dialog has settled at its final size. Routes (`lines`) are
// polylines; past 40 markers, close ones group into clusters (map-cluster.ts) that zoom in on
// Enter or a click; the fit leaves far-off markers out, with "N outside view" to bring them in.
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import {
  divIcon,
  latLngBounds,
  type CircleMarker as LeafletCircleMarker,
  type Marker as LeafletMarker,
  type Polyline as LeafletPolyline,
} from "leaflet";
import { keepLinksOutside } from "@/components/ui-blocks/links";
import { makeMarkerAccessible, markerName } from "@/components/ui-blocks/map-a11y";
import { fitController } from "@/components/ui-blocks/map-fit";
import { clusterGrid, clusterName, shouldCluster, CLUSTER_MAX_ZOOM, type Group } from "@/components/ui-blocks/map-cluster";
import { percentileView } from "@/components/ui-blocks/map/view-fit";
import { asArray, asNumber, asObj, optText } from "@/lib/narrow";
import { growAttr, growClass, useUiView } from "@/components/ui-view";
import { cn } from "@/lib/utils";

type Tone = "default" | "success" | "warning" | "danger";
type Marker = { id?: string; lat: number; lng: number; label?: string; detail?: string; tone: Tone };
type Line = { points: [number, number][]; label?: string; detail?: string; tone: Tone };
type LatLng = { lat: number; lng: number };

// Status colours are reserved for state; plain markers use categorical slot 1.
const TONE: Record<Tone, string> = {
  default: "var(--chart-1)",
  success: "#0ca30c",
  warning: "#fab219",
  danger: "#e34948",
};
// The same, as cluster rings (class names spelled out, so Tailwind sees them).
const RING: Record<Tone, string> = {
  default: "border-[var(--chart-1)]",
  success: "border-[#0ca30c]",
  warning: "border-[#fab219]",
  danger: "border-[#e34948]",
};
/** Routes past this many are not drawn (Rust refuses them; bound values are capped here). */
const MAX_LINES = 50;
const MAX_LINE_POINTS = 1000;

const isTone = (v: unknown): v is Tone => typeof v === "string" && v in TONE;

function toMarkers(raw: unknown): Marker[] {
  return asArray(raw).flatMap((m): Marker[] => {
    const o = asObj(m);
    const lat = asNumber(o.lat);
    const lng = asNumber(o.lng);
    if (lat == null || lng == null) return [];
    return [{ id: optText(o.id), lat, lng, label: optText(o.label), detail: optText(o.detail), tone: isTone(o.tone) ? o.tone : "default" }];
  });
}

/** Routes: each point a `[lat, lng]` or a marker's `id`; fewer than two places and it is no route. */
function toLines(raw: unknown, markers: Marker[]): Line[] {
  const byId = new Map(markers.flatMap((m) => (m.id ? [[m.id, m] as const] : [])));
  return asArray(raw)
    .slice(0, MAX_LINES)
    .flatMap((l): Line[] => {
      const o = asObj(l);
      const points = asArray(o.points)
        .slice(0, MAX_LINE_POINTS)
        .flatMap((p): [number, number][] => {
          if (typeof p === "string") {
            const m = byId.get(p);
            return m ? [[m.lat, m.lng]] : [];
          }
          const [lat, lng] = asArray(p).map(asNumber);
          return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [[lat, lng]] : [];
        });
      return points.length >= 2 ? [{ points, label: optText(o.label), detail: optText(o.detail), tone: isTone(o.tone) ? o.tone : "default" }] : [];
    });
}

/** `[lat, lng]` when both are numbers. */
function toCenter(raw: unknown): [number, number] | undefined {
  const [lat, lng] = asArray(raw).map(asNumber);
  return lat != null && lng != null ? [lat, lng] : undefined;
}

/** Fits the view to the places once the container has a real size, and again on resize or new places, until the user moves the map (map-fit.ts). */
function FitBounds({ places }: { places: LatLng[] }) {
  const map = useMap();
  const fit = useRef<ReturnType<typeof fitController> | null>(null);
  // By value: a re-render with the same places is no change.
  const key = places.map((m) => `${m.lat},${m.lng}`).join(";");
  useEffect(() => {
    const f = fitController(map);
    fit.current = f;
    const el = map.getContainer();
    // A size is fitted once it has held for a frame: moving into the Expand dialog and its opening
    // animation pass through sizes that would otherwise leave the map zoomed for one of them.
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      const seen = { w: el.clientWidth, h: el.clientHeight };
      frame = requestAnimationFrame(() => {
        if (el.clientWidth === seen.w && el.clientHeight === seen.h) f.resized(seen.w, seen.h);
        else settle();
      });
    };
    const ro = new ResizeObserver(settle);
    ro.observe(el);
    f.resized(el.clientWidth, el.clientHeight);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      f.dispose();
      fit.current = null;
    };
  }, [map]);
  useEffect(() => {
    fit.current?.markers(
      key.split(";").flatMap((p) => {
        const [lat, lng] = p.split(",").map(Number);
        return p ? [{ lat, lng }] : [];
      }),
    );
  }, [map, key]);
  return null;
}

/** One marker, named and reachable by keyboard (map-a11y.ts), its label on hover and focus, its detail on click or Enter. */
function Pin({ m, i, n }: { m: Marker; i: number; n: number }) {
  return (
    <CircleMarker
      center={[m.lat, m.lng]}
      radius={8}
      // A surface-coloured ring keeps overlapping markers apart.
      pathOptions={{ color: "#ffffff", weight: 2, fillColor: TONE[m.tone], fillOpacity: 0.95 }}
      eventHandlers={{
        add: (e) => {
          const layer = e.target as LeafletCircleMarker;
          makeMarkerAccessible(layer.getElement(), markerName(m, i, n), {
            open: () => (m.detail ? layer.openPopup() : layer.openTooltip()),
            focus: () => layer.openTooltip(),
            blur: () => layer.closeTooltip(),
          });
        },
      }}
    >
      {m.label && (
        <Tooltip direction="top" offset={[0, -8]}>
          {m.label}
        </Tooltip>
      )}
      {m.detail && (
        <Popup>
          {m.label && (
            <>
              <strong>{m.label}</strong>
              <br />
            </>
          )}
          {m.detail}
        </Popup>
      )}
    </CircleMarker>
  );
}

/** A cluster's icon: the count in foreground text on white, ringed in the worst status among its markers. Text only. */
function clusterIcon(g: Extract<Group, { kind: "many" }>) {
  const n = g.members.length;
  const size = n < 10 ? 30 : n < 100 ? 36 : 42;
  const el = document.createElement("span");
  el.className = cn(
    "flex size-full items-center justify-center rounded-full border-[3px] bg-white text-xs font-semibold text-neutral-900 tabular-nums shadow-sm",
    RING[g.tone],
  );
  el.textContent = String(n);
  return divIcon({ html: el, className: "ui-map-cluster", iconSize: [size, size] });
}

/** Markers, grouped into clusters at the current zoom when there are many (map-cluster.ts). */
function Markers({ markers, cluster }: { markers: Marker[]; cluster: boolean | "auto" }) {
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());
  // Listening before the first fit: FitBounds comes after this in the tree, so its effect runs later.
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  const on = shouldCluster(cluster, markers.length, zoom);
  const groups = useMemo<Group[]>(() => {
    if (!on) return markers.map((_, index) => ({ kind: "one", index }));
    const xy = markers.map((m) => {
      const p = map.project([m.lat, m.lng], zoom);
      return [p.x, p.y] as [number, number];
    });
    return clusterGrid(
      xy,
      markers.map((m) => m.tone),
    );
  }, [on, markers, map, zoom]);
  // Made once per grouping: a new icon would replace the element and drop its name.
  const icons = useMemo(() => groups.map((g) => (g.kind === "many" ? clusterIcon(g) : null)), [groups]);
  return (
    <>
      {groups.map((g, k) => {
        if (g.kind === "one") return <Pin key={`m${g.index}`} m={markers[g.index]} i={g.index} n={markers.length} />;
        const at = map.unproject([g.x, g.y], zoom);
        const zoomIn = () =>
          map.fitBounds(latLngBounds(g.members.map((i) => [markers[i].lat, markers[i].lng])), { padding: [40, 40], maxZoom: CLUSTER_MAX_ZOOM });
        return (
          <Marker
            key={`c${g.members[0]}:${g.members.length}`}
            position={at}
            icon={icons[k]!}
            keyboard={false}
            eventHandlers={{
              click: zoomIn,
              add: (e) => {
                const el = (e.target as LeafletMarker).getElement();
                el?.setAttribute("role", "button");
                el?.setAttribute("tabindex", "0");
                el?.setAttribute("aria-label", clusterName(g));
                el?.setAttribute("data-cluster", String(g.members.length));
                // Enter or Space zooms in (Leaflet's own keyboard handling listens for the deprecated keypress only).
                el?.addEventListener("keydown", (k) => {
                  if (k.key !== "Enter" && k.key !== " ") return;
                  k.preventDefault();
                  zoomIn();
                });
              },
            }}
          />
        );
      })}
    </>
  );
}

/** A route: a casing in white under a line in its tone, named for the keyboard; its label on hover and focus. */
function Route({ line, i, n }: { line: Line; i: number; n: number }) {
  const name = `${line.label ?? (n === 1 ? "Route" : `Route ${i + 1} of ${n}`)}, ${line.points.length} stops`;
  return (
    <>
      <Polyline positions={line.points} pathOptions={{ color: "#ffffff", weight: 7, opacity: 0.9, interactive: false }} />
      <Polyline
        positions={line.points}
        pathOptions={{ color: TONE[line.tone], weight: 4, opacity: 0.9, lineJoin: "round" }}
        eventHandlers={{
          add: (e) => {
            const layer = e.target as LeafletPolyline;
            makeMarkerAccessible(layer.getElement(), name, {
              open: () => (line.detail ? layer.openPopup() : layer.openTooltip()),
              focus: () => layer.openTooltip(),
              blur: () => layer.closeTooltip(),
            });
          },
        }}
      >
        {line.label && <Tooltip sticky>{line.label}</Tooltip>}
        {line.detail && (
          <Popup>
            {line.label && (
              <>
                <strong>{line.label}</strong>
                <br />
              </>
            )}
            {line.detail}
          </Popup>
        )}
      </Polyline>
    </>
  );
}

export default function UiMap({
  markers: rawMarkers,
  center: rawCenter,
  zoom,
  height,
  lines: rawLines,
  cluster: rawCluster,
}: {
  markers: unknown;
  center?: unknown;
  zoom?: unknown;
  height?: number;
  lines?: unknown;
  cluster?: unknown;
}) {
  const markers = useMemo(() => toMarkers(rawMarkers), [rawMarkers]);
  const lines = useMemo(() => toLines(rawLines, markers), [rawLines, markers]);
  const cluster: boolean | "auto" = typeof rawCluster === "boolean" ? rawCluster : "auto";
  const center = toCenter(rawCenter);
  const fit = !center && (markers.length > 0 || lines.length > 0);
  const [fitAll, setFitAll] = useState(false);
  // Far-off markers (a depot on the islands) are left out of the fit; routes are always in it.
  const pv = useMemo(() => percentileView(markers.map((m) => ({ lon: m.lng, lat: m.lat }))), [markers]);
  const outside = fit && pv ? pv.outside.length : 0;
  const places = useMemo(() => {
    const out = new Set(fitAll ? [] : (pv?.outside ?? []));
    return [...markers.filter((_, i) => !out.has(i)), ...lines.flatMap((l) => l.points.map(([lat, lng]) => ({ lat, lng })))];
  }, [markers, lines, pv, fitAll]);
  const { expanded } = useUiView();
  const h = height || 320;
  return (
    <div
      // `isolate`: Leaflet's panes use z-index 400–1000; keep them inside the map, under dialogs and menus.
      // `shrink-0` inline: `overflow-hidden` would let a flex column squash it; expanded it grows instead,
      // never under its inline height.
      {...growAttr(expanded)}
      className={cn("ui-map-tiles relative isolate rounded-lg border", expanded ? growClass(true, "") : "shrink-0", "overflow-hidden")}
      role="region"
      aria-label={markers.length ? `Map, ${markers.length === 1 ? "1 place" : `${markers.length} places`}` : "Map"}
      style={expanded ? { minHeight: h } : { height: h }}
      onClickCapture={keepLinksOutside}
      onAuxClickCapture={keepLinksOutside}
    >
      <MapContainer center={center ?? [20, 0]} zoom={asNumber(zoom) ?? 2} scrollWheelZoom={false} className="h-full w-full" attributionControl>
        {/* Fixed tile server: agents can't point the map at another host. */}
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />
        {lines.map((l, i) => (
          <Route key={i} line={l} i={i} n={lines.length} />
        ))}
        <Markers markers={markers} cluster={cluster} />
        {fit && <FitBounds places={places} />}
      </MapContainer>
      {outside > 0 && (
        <button
          type="button"
          className="absolute top-2 right-2 z-[1000] min-h-6 rounded-md border bg-background px-2 py-0.5 text-xs text-muted-foreground shadow-sm hover:text-foreground"
          aria-pressed={fitAll}
          onClick={() => setFitAll((f) => !f)}
          data-part="outside-chip"
        >
          {fitAll ? "Fit to most places" : `${outside} outside view · show all`}
        </button>
      )}
    </div>
  );
}
