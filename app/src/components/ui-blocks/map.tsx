// `map` primitive — Leaflet via react-leaflet, OpenStreetMap tiles. Loaded on demand.
// Marker labels and details are React children (portalled into Leaflet's
// tooltip/popup), so agent text is shown as text, never parsed as HTML.
import { useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { CircleMarker as LeafletCircleMarker } from "leaflet";
import { keepLinksOutside } from "@/components/ui-blocks/links";
import { makeMarkerAccessible, markerName } from "@/components/ui-blocks/map-a11y";
import { asArray, asNumber, asObj, optText } from "@/lib/narrow";

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

function FitBounds({ markers }: { markers: Marker[] }) {
  const map = useMap();
  useEffect(() => {
    if (markers.length === 0) return;
    const lats = markers.map((m) => m.lat);
    const lngs = markers.map((m) => m.lng);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lngs)],
        [Math.max(...lats), Math.max(...lngs)],
      ],
      { padding: [32, 32], maxZoom: 12 },
    );
  }, [map, markers]);
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
  return (
    <div
      // `isolate`: Leaflet's panes use z-index 400–1000; keep them inside the map, under dialogs and menus.
      className="isolate overflow-hidden rounded-lg border"
      role="region"
      aria-label={markers.length ? `Map, ${markers.length === 1 ? "1 place" : `${markers.length} places`}` : "Map"}
      style={{ height: height || 320 }}
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
