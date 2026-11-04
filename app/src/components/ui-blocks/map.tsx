// `map` primitive, kind `markers` (the default) — Leaflet via react-leaflet, OpenStreetMap tiles.
// Loaded on demand; the region kinds (outline, choropleth, bubble) are map/geo-map.tsx and never
// load Leaflet. Marker labels and details are React children (portalled into Leaflet's
// tooltip/popup), so agent text is shown as text, never parsed as HTML. In a dark theme the tiles
// are inverted by a CSS filter (index.css, `.ui-map-tiles`): no second tile host, and the markers
// and labels, in other panes, keep their colours. Expanded, the map takes the dialog's height and
// refits once the dialog has settled at its final size.
import { useEffect, useMemo, useRef } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { CircleMarker as LeafletCircleMarker } from "leaflet";
import { keepLinksOutside } from "@/components/ui-blocks/links";
import { makeMarkerAccessible, markerName } from "@/components/ui-blocks/map-a11y";
import { fitController } from "@/components/ui-blocks/map-fit";
import { asArray, asNumber, asObj, optText } from "@/lib/narrow";
import { growAttr, growClass, useUiView } from "@/components/ui-view";
import { cn } from "@/lib/utils";

type Tone = "default" | "success" | "warning" | "danger";
type Marker = { lat: number; lng: number; label?: string; detail?: string; tone: Tone };

// Status colours are reserved for state; plain markers use categorical slot 1.
const TONE: Record<Tone, string> = {
  default: "var(--chart-1)",
  success: "#0ca30c",
  warning: "#fab219",
  danger: "#e34948",
};

const isTone = (v: unknown): v is Tone => typeof v === "string" && v in TONE;

function toMarkers(raw: unknown): Marker[] {
  return asArray(raw).flatMap((m): Marker[] => {
    const o = asObj(m);
    const lat = asNumber(o.lat);
    const lng = asNumber(o.lng);
    if (lat == null || lng == null) return [];
    return [{ lat, lng, label: optText(o.label), detail: optText(o.detail), tone: isTone(o.tone) ? o.tone : "default" }];
  });
}

/** `[lat, lng]` when both are numbers. */
function toCenter(raw: unknown): [number, number] | undefined {
  const [lat, lng] = asArray(raw).map(asNumber);
  return lat != null && lng != null ? [lat, lng] : undefined;
}

/** Fits the view to the markers once the container has a real size, and again on resize or new markers, until the user moves the map (map-fit.ts). */
function FitBounds({ markers }: { markers: Marker[] }) {
  const map = useMap();
  const fit = useRef<ReturnType<typeof fitController> | null>(null);
  // By value: a re-render with the same places is no change.
  const key = markers.map((m) => `${m.lat},${m.lng}`).join(";");
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

export default function UiMap({
  markers: rawMarkers,
  center: rawCenter,
  zoom,
  height,
}: {
  markers: unknown;
  center?: unknown;
  zoom?: unknown;
  height?: number;
}) {
  const markers = useMemo(() => toMarkers(rawMarkers), [rawMarkers]);
  const center = toCenter(rawCenter);
  const fit = !center && markers.length > 0;
  const { expanded } = useUiView();
  const h = height || 320;
  return (
    <div
      // `isolate`: Leaflet's panes use z-index 400–1000; keep them inside the map, under dialogs and menus.
      // `shrink-0` inline: `overflow-hidden` would let a flex column squash it; expanded it grows instead,
      // never under its inline height.
      {...growAttr(expanded)}
      className={cn("ui-map-tiles isolate rounded-lg border", expanded ? growClass(true, "") : "shrink-0", "overflow-hidden")}
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
        {fit && <FitBounds markers={markers} />}
        {markers.map((m, i) => (
          <CircleMarker
            key={i}
            center={[m.lat, m.lng]}
            radius={8}
            // A surface-coloured ring keeps overlapping markers apart.
            pathOptions={{ color: "#ffffff", weight: 2, fillColor: TONE[m.tone], fillOpacity: 0.95 }}
            eventHandlers={{
              add: (e) => {
                const layer = e.target as LeafletCircleMarker;
                makeMarkerAccessible(layer.getElement(), markerName(m, i, markers.length), {
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
        ))}
      </MapContainer>
    </div>
  );
}
