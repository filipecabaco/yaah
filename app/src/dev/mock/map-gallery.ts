// A gallery of map examples at different scales and densities. All data is made up. Only what the
// `map` primitive supports is used: markers (lat, lng, label, detail, tone), center, zoom, height.
// `map-gallery.test.tsx` renders every entry, so they stay valid as the map code changes.
type Tree = Record<string, unknown>;
type Tone = "default" | "success" | "warning" | "danger";
type Pt = [string, number, number];
const stat = (label: string, value: string, extra: Record<string, unknown> = {}): Tree => ({ type: "stat", props: { label, value, ...extra } });
const statRow = (...stats: Tree[]): Tree => ({ type: "grid", props: { columns: stats.length, gap: "md" }, children: stats });
const card = (title: string, description: string, ...children: Tree[]): Tree => ({ type: "card", props: { title, description }, children });
const chart = (props: Record<string, unknown>): Tree => ({ type: "chart", props });
const table = (columns: [string, string, ("left" | "right")?][], rows: Record<string, string | number>[]): Tree => ({
  type: "table",
  props: { columns: columns.map(([key, label, align]) => ({ key, label, ...(align ? { align } : {}) })), rows },
});
const map = (height: number, markers: Tree[], extra: Record<string, unknown> = {}): Tree => ({ type: "map", props: { height, markers, ...extra } });
const text = (value: string): Tree => ({ type: "text", props: { text: value } });

// Deterministic pseudo-random, so the dense example is the same on every run.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

// City scale: bike stations in Lisbon.
const STATIONS: [string, number, number, number][] = [
  ["Praça do Comércio", 38.7075, -9.1364, 18],
  ["Cais do Sodré", 38.7068, -9.1444, 12],
  ["Rossio", 38.7139, -9.1394, 20],
  ["Restauradores", 38.7165, -9.1408, 9],
  ["Baixa-Chiado", 38.7107, -9.1397, 6],
  ["Bairro Alto", 38.7132, -9.1455, 4],
  ["Príncipe Real", 38.7176, -9.1487, 7],
  ["Avenida da Liberdade", 38.7203, -9.1456, 15],
  ["Marquês de Pombal", 38.7253, -9.15, 22],
  ["Parque Eduardo VII", 38.7292, -9.1534, 10],
  ["Saldanha", 38.7347, -9.1449, 13],
  ["Picoas", 38.7311, -9.1473, 3],
  ["Campo Pequeno", 38.7423, -9.1458, 11],
  ["Alameda", 38.7367, -9.1337, 16],
  ["Arroios", 38.7335, -9.1355, 5],
  ["Intendente", 38.7206, -9.1352, 8],
  ["Martim Moniz", 38.7172, -9.1360, 14],
  ["Graça", 38.7191, -9.1289, 2],
  ["Santa Apolónia", 38.7138, -9.1226, 17],
  ["Campo das Cebolas", 38.7098, -9.1317, 6],
  ["Alfama", 38.7105, -9.1295, 1],
  ["Estrela", 38.7128, -9.1595, 9],
  ["Santos", 38.7066, -9.1536, 12],
  ["Alcântara", 38.7034, -9.1760, 19],
  ["Belém", 38.6979, -9.2064, 21],
  ["Jardim da Estrela", 38.7137, -9.1604, 8],
  ["Campo de Ourique", 38.7168, -9.1672, 10],
  ["Amoreiras", 38.7239, -9.1608, 7],
];
const bikes = card(
  "City scale: bike stations in Lisbon",
  "28 made-up stations close together. The label is the station and its free bikes.",
  statRow(stat("Stations", "28"), stat("Free bikes now", String(STATIONS.reduce((s, x) => s + x[3], 0))), stat("Empty stations", String(STATIONS.filter((x) => x[3] <= 2).length), { hint: "2 bikes or fewer" })),
  map(
    420,
    STATIONS.map(([label, lat, lng, n]) => ({ lat, lng, label: `${label}: ${n} bikes`, detail: `${n} free bikes`, tone: (n <= 2 ? "danger" : n <= 6 ? "warning" : "success") as Tone })),
  ),
  text("Green: 7 or more bikes. Amber: 3 to 6. Red: 2 or fewer. The number is in every label."),
);

// Country scale: store revenue across Portugal.
const STORES: [string, number, number, number][] = [
  ["Lisboa", 38.72, -9.14, 4.8],
  ["Porto", 41.15, -8.61, 3.9],
  ["Braga", 41.55, -8.43, 1.6],
  ["Coimbra", 40.21, -8.43, 1.2],
  ["Faro", 37.02, -7.93, 1.4],
  ["Évora", 38.57, -7.91, 0.6],
  ["Viseu", 40.66, -7.91, 0.7],
  ["Funchal", 32.65, -16.91, 0.9],
  ["Ponta Delgada", 37.74, -25.67, 0.5],
];
const stores = card(
  "Country scale: store revenue in Portugal",
  "Nine made-up stores, yearly revenue in millions of euros, in the marker labels.",
  statRow(stat("Revenue", `€${STORES.reduce((s, x) => s + x[3], 0).toFixed(1)}M`, { delta: "+7%", trend: "up" }), stat("Top store", "Lisboa"), stat("Stores", String(STORES.length))),
  map(380, STORES.map(([label, lat, lng, v]) => ({ lat, lng, label: `${label}: €${v}M`, detail: `€${v}M a year`, tone: (v >= 3 ? "success" : v < 0.8 ? "warning" : "default") as Tone }))),
  chart({ kind: "bar", x: "store", sort: "value", labels: "ends", unit: "M", height: 240, data: STORES.map(([store, , , v]) => ({ store, revenue: v })), series: [{ key: "revenue", label: "Revenue, € millions" }] }),
);

// Continent scale: edge locations with status.
const EDGE: [string, number, number, "ok" | "degraded" | "down", number][] = [
  ["Dublin", 53.35, -6.26, "ok", 12],
  ["London", 51.51, -0.13, "ok", 9],
  ["Paris", 48.86, 2.35, "ok", 11],
  ["Madrid", 40.42, -3.7, "degraded", 48],
  ["Lisbon", 38.72, -9.14, "ok", 14],
  ["Frankfurt", 50.11, 8.68, "ok", 8],
  ["Milan", 45.46, 9.19, "ok", 15],
  ["Stockholm", 59.33, 18.07, "ok", 17],
  ["Warsaw", 52.23, 21.01, "degraded", 55],
  ["Athens", 37.98, 23.73, "down", 0],
  ["Helsinki", 60.17, 24.94, "ok", 19],
  ["Bucharest", 44.43, 26.1, "ok", 22],
];
const TONE: Record<string, Tone> = { ok: "success", degraded: "warning", down: "danger" };
const edge = card(
  "Continent scale: edge locations across Europe",
  "Twelve made-up edge locations. Status is in the label and the table as well as the colour.",
  statRow(
    stat("OK", String(EDGE.filter((e) => e[3] === "ok").length)),
    stat("Degraded", String(EDGE.filter((e) => e[3] === "degraded").length), { trend: "down" }),
    stat("Down", String(EDGE.filter((e) => e[3] === "down").length), { trend: "down" }),
  ),
  map(400, EDGE.map(([label, lat, lng, s, ms]) => ({ lat, lng, label: `${label} (${s})`, detail: s === "down" ? "No response" : `${ms} ms median`, tone: TONE[s] }))),
  text("Legend: green is ok, amber is degraded (over 40 ms), red is down."),
  table(
    [["site", "Site"], ["status", "Status"], ["latency", "Median latency", "right"]],
    EDGE.map(([site, , , status, ms]) => ({ site, status, latency: status === "down" ? "none" : `${ms} ms` })),
  ),
);

// World scale: offices.
const OFFICES: Pt[] = [
  ["San Francisco", 37.77, -122.42],
  ["New York", 40.71, -74.01],
  ["São Paulo", -23.55, -46.63],
  ["London", 51.51, -0.13],
  ["Lagos", 6.52, 3.38],
  ["Nairobi", -1.29, 36.82],
  ["Dubai", 25.2, 55.27],
  ["Singapore", 1.35, 103.82],
  ["Tokyo", 35.68, 139.69],
  ["Sydney", -33.87, 151.21],
];
const world = card(
  "World scale: offices on six continents",
  "Ten made-up offices. The map fits them all, so it opens zoomed far out.",
  statRow(stat("Offices", String(OFFICES.length)), stat("Continents", "6"), stat("Time zones", "9")),
  map(380, OFFICES.map(([label, lat, lng]) => ({ lat, lng, label, detail: "Office" }))),
);

// Route-like: a delivery round.
const STOPS: [string, number, number, string][] = [
  ["Depot, Rua do Século", 38.7118, -9.1486, "08:00"],
  ["Mercado da Ribeira", 38.7064, -9.1458, "08:25"],
  ["Praça do Comércio", 38.7075, -9.1364, "08:50"],
  ["Sé de Lisboa", 38.7099, -9.133, "09:10"],
  ["Castelo", 38.7139, -9.1335, "09:35"],
  ["Martim Moniz", 38.7172, -9.136, "10:00"],
  ["Rossio", 38.7139, -9.1394, "10:20"],
  ["Depot, return", 38.7118, -9.1486, "10:50"],
];
const route = card(
  "Route: a delivery round",
  "Eight stops in order. The number is in each label; the markers are not joined by a line.",
  statRow(stat("Stops", String(STOPS.length - 1)), stat("Duration", "2 h 50 min"), stat("Distance", "11.4 km")),
  map(
    380,
    STOPS.map(([label, lat, lng, t], i) => ({ lat, lng, label: `${i + 1}. ${label}`, detail: `Arrive ${t}`, tone: (i === 0 || i === STOPS.length - 1 ? "default" : "success") as Tone })),
  ),
  table(
    [["n", "Stop", "right"], ["name", "Name"], ["eta", "Arrive", "right"]],
    STOPS.map(([name, , , eta], i) => ({ n: i + 1, name, eta })),
  ),
);

// Single point.
const single = card(
  "Single point: one location",
  "One marker. The map zooms in on it instead of fitting a box.",
  statRow(stat("Site", "Lisbon HQ"), stat("Desks", "120")),
  map(300, [{ lat: 38.7223, lng: -9.1393, label: "Lisbon HQ", detail: "Rua Augusta 100 (made up)" }]),
);

// Dense: about 200 weather stations around central Europe.
const rand = rng(42);
const CENTRES: [number, number, number][] = [[48.5, 9, 16], [46.5, 2.5, 14], [51, 10.5, 20], [50, 20, 12], [45, 12, 12], [52.5, 0, 8]];
const stations = Array.from({ length: 200 }, (_, i) => {
  const [lat, lng, spread] = CENTRES[i % CENTRES.length];
  const t = Math.round((12 + (lat - 48) * -1.2 + (rand() - 0.5) * 8) * 10) / 10;
  return { id: `WS-${String(i + 1).padStart(3, "0")}`, lat: lat + (rand() - 0.5) * (spread / 3), lng: lng + (rand() - 0.5) * spread, t };
});
const dense = card(
  "Dense: 200 weather stations",
  "Made-up stations across western and central Europe, temperature in the label. For checking speed and fit.",
  statRow(
    stat("Stations", "200"),
    stat("Hottest", `${Math.max(...stations.map((s) => s.t))} °C`),
    stat("Coldest", `${Math.min(...stations.map((s) => s.t))} °C`),
  ),
  map(460, stations.map((s) => ({ lat: s.lat, lng: s.lng, label: `${s.id}: ${s.t} °C`, detail: `${s.t} °C`, tone: (s.t >= 18 ? "danger" : s.t <= 6 ? "warning" : "default") as Tone }))),
  text("Red: 18 °C or more. Amber: 6 °C or less. Each label carries the reading."),
);

// Mixed dashboard.
const REGIONS: [string, number, number, number, number][] = [
  ["Nordics", 59.9, 10.75, 3.1, 8],
  ["UK and Ireland", 52.5, -1.5, 5.4, 12],
  ["Iberia", 40.0, -4.0, 2.7, -3],
  ["DACH", 48.1, 11.6, 6.2, 5],
  ["Benelux", 51.0, 4.5, 3.8, 2],
  ["Italy", 42.5, 12.5, 2.9, -1],
  ["Eastern Europe", 50.0, 20.0, 2.2, 14],
];
const mixed = card(
  "Mixed dashboard: sales by region",
  "A map, the same regions as a bar, and headline tiles. Made-up data, € millions.",
  statRow(
    stat("Sales", `€${REGIONS.reduce((s, r) => s + r[3], 0).toFixed(1)}M`, { delta: "+6%", trend: "up" }),
    stat("Best region", "DACH", { hint: "€6.2M" }),
    stat("Fastest growth", "Eastern Europe", { delta: "+14%", trend: "up" }),
    stat("Shrinking", "Iberia", { delta: "-3%", trend: "down" }),
  ),
  {
    type: "grid",
    props: { columns: 2, gap: "md" },
    children: [
      map(320, REGIONS.map(([label, lat, lng, v, g]) => ({ lat, lng, label: `${label}: €${v}M`, detail: `${g > 0 ? "+" : ""}${g}% on last year`, tone: (g < 0 ? "danger" : g >= 10 ? "success" : "default") as Tone }))),
      chart({ kind: "bar", x: "region", sort: "value", labels: "ends", unit: "M", height: 320, data: REGIONS.map(([region, , , sales]) => ({ region, sales })), series: [{ key: "sales", label: "Sales, € millions" }] }),
    ],
  },
);

/** [title, tree] per example, in the order they are shown. */
export const mapGallery: [string, Tree][] = [
  ["City scale: bike stations in Lisbon", bikes],
  ["Country scale: store revenue in Portugal", stores],
  ["Continent scale: edge locations across Europe", edge],
  ["World scale: offices on six continents", world],
  ["Route: a delivery round", route],
  ["Single point: one location", single],
  ["Dense: 200 weather stations", dense],
  ["Mixed dashboard: sales by region", mixed],
];
