// The region map kinds, one card each: a world choropleth, a US election choropleth, a bubble map
// of European store revenue and an outline with highlighted regions. All numbers are made up or
// rounded for illustration. `map-types.test.tsx` renders every entry, so they stay valid as the
// map code changes; routed by "map types" in chats.ts.
type Tree = Record<string, unknown>;
const card = (title: string, description: string, ...children: Tree[]): Tree => ({ type: "card", props: { title, description }, children });
const map = (props: Record<string, unknown>): Tree => ({ type: "map", props });

// Share of people online, %. Ids as agents write them: alpha-3, alpha-2, names.
const ONLINE: [string, number | null][] = [
  ["USA", 92], ["CAN", 94], ["MEX", 76], ["BRA", 84], ["ARG", 89], ["COL", 75], ["PER", 72], ["CHL", 90],
  ["GB", 97], ["FR", 86], ["DE", 92], ["ES", 95], ["IT", 86], ["PL", 87], ["SE", 96], ["NO", 99],
  ["Russia", 90], ["Türkiye", 86], ["Ukraine", 79], ["Egypt", 72], ["Nigeria", 55], ["Ethiopia", 19],
  ["Kenya", 40], ["South Africa", 75], ["DZA", 71], ["MAR", 90], ["COD", 27], ["AGO", 39], ["TZA", 32],
  ["SAU", 99], ["IRN", 79], ["IND", 46], ["PAK", 33], ["CHN", 77], ["JPN", 87], ["KOR", 97],
  ["IDN", 69], ["AUS", 96], ["KAZ", 92], ["MNG", 83], ["VNM", 79], ["THA", 88], ["PRK", null], ["AFG", 18],
]; // prettier-ignore

const world = card(
  "World: people online",
  "Share of the population using the internet, by country (illustrative).",
  map({
    kind: "choropleth",
    region: "world",
    title: "People online, % of population",
    data: ONLINE.map(([id, value]) => ({ id, value })),
    scale: { type: "sequential", bins: 5, unit: "%" },
    legend: { title: "Online, % of population" },
    height: 380,
  }),
);

// 2024 presidential margin, Republican minus Democrat, in points (rounded).
const MARGIN: [string, number][] = [
  ["AL", 30.5], ["AK", 13.1], ["AZ", 5.5], ["AR", 30.6], ["CA", -20.1], ["CO", -11.0], ["CT", -14.5], ["DE", -14.7],
  ["DC", -83.8], ["FL", 13.1], ["GA", 2.2], ["HI", -23.1], ["ID", 36.5], ["IL", -10.9], ["IN", 19.0], ["IA", 13.2],
  ["KS", 16.2], ["KY", 30.5], ["LA", 22.0], ["ME", -6.9], ["MD", -28.5], ["MA", -25.2], ["MI", 1.4], ["MN", -4.2],
  ["MS", 22.9], ["MO", 18.4], ["MT", 19.9], ["NE", 20.4], ["NV", 3.1], ["NH", -2.8], ["NJ", -5.9], ["NM", -6.0],
  ["NY", -12.6], ["NC", 3.2], ["ND", 36.4], ["OH", 11.2], ["OK", 34.3], ["OR", -14.3], ["PA", 1.7], ["RI", -13.8],
  ["SC", 17.8], ["SD", 29.2], ["TN", 29.7], ["TX", 13.7], ["UT", 21.6], ["VT", -31.5], ["VA", -5.8], ["WA", -18.2],
  ["WV", 41.9], ["WI", 0.9], ["WY", 45.8],
]; // prettier-ignore
const side = (v: number) => (v === 0 ? "Tie" : `${v > 0 ? "R" : "D"} +${Math.abs(v).toFixed(1)}`);

const election = card(
  "US states: 2024 margin",
  "Republican minus Democrat, in points, by state (rounded). D.C. lies past the scale and sits in its end class.",
  map({
    kind: "choropleth",
    region: "us-states",
    title: "2024 presidential margin by state",
    data: MARGIN.map(([id, value]) => ({ id, value, detail: side(value) })),
    scale: { type: "diverging", domain: [-30, 30], midpoint: 0, bins: 7, unit: " pts" },
    legend: { title: "Margin (R + / D −)" },
    height: 400,
  }),
);

// Revenue per store, M EUR. Funchal (Madeira) and Ponta Delgada (Azores) are off the main view.
const STORES: [string, number, number, number][] = [
  ["Lisbon", -9.14, 38.72, 4.2], ["Porto", -8.61, 41.15, 2.1], ["Madrid", -3.7, 40.42, 6.3], ["Barcelona", 2.17, 41.39, 5.4],
  ["Valencia", -0.38, 39.47, 1.6], ["Seville", -5.98, 37.39, 1.9], ["Paris", 2.35, 48.86, 7.9], ["Lyon", 4.84, 45.76, 2.4],
  ["Marseille", 5.37, 43.3, 1.8], ["Brussels", 4.35, 50.85, 2.2], ["Amsterdam", 4.9, 52.37, 3.6], ["Berlin", 13.4, 52.52, 3.1],
  ["Hamburg", 9.99, 53.55, 2.0], ["Munich", 11.58, 48.14, 3.3], ["Vienna", 16.37, 48.21, 2.6], ["Prague", 14.42, 50.08, 1.7],
  ["Warsaw", 21.01, 52.23, 2.3], ["Milan", 9.19, 45.46, 4.4], ["Rome", 12.5, 41.9, 3.0], ["Copenhagen", 12.57, 55.68, 1.9],
  ["Stockholm", 18.07, 59.33, 2.5], ["Dublin", -6.26, 53.35, 2.8], ["Funchal", -16.91, 32.65, 0.6], ["Ponta Delgada", -25.67, 37.74, 0.3],
]; // prettier-ignore

const bubbles = card(
  "Europe: store revenue",
  "Last year's revenue per store, in M EUR (made up). The bubble's area is the revenue.",
  map({
    kind: "bubble",
    region: "europe",
    title: "Store revenue by city",
    points: STORES.map(([label, lon, lat, value]) => ({ label, lon, lat, value, detail: `${value} M EUR` })),
    unit: "M EUR",
    height: 400,
  }),
);

const outline = card(
  "Edge locations: status by country",
  "Where the edge network runs, and how each country's sites are doing.",
  map({
    kind: "outline",
    region: "europe",
    title: "Edge locations",
    highlight: [
      { id: "PT", tone: "success", detail: "2 sites, healthy" },
      { id: "ES", tone: "success", detail: "3 sites, healthy" },
      { id: "FR", tone: "success", detail: "4 sites, healthy" },
      { id: "DE", tone: "success", detail: "5 sites, healthy" },
      { id: "GB", tone: "success", detail: "3 sites, healthy" },
      { id: "PL", tone: "warning", detail: "1 site degraded" },
      { id: "IT", tone: "danger", detail: "Milan down since 09:12" },
    ],
    points: [
      { lon: -9.14, lat: 38.72, label: "Lisbon" },
      { lon: -3.7, lat: 40.42, label: "Madrid" },
      { lon: 2.35, lat: 48.86, label: "Paris" },
      { lon: 8.68, lat: 50.11, label: "Frankfurt" },
      { lon: -0.13, lat: 51.51, label: "London" },
      { lon: 21.01, lat: 52.23, label: "Warsaw", tone: "warning" },
      { lon: 9.19, lat: 45.46, label: "Milan", tone: "danger" },
    ],
    height: 400,
  }),
);

export const mapTypes: [string, Tree][] = [
  ["World: people online", world],
  ["US states: 2024 margin", election],
  ["Europe: store revenue", bubbles],
  ["Edge locations: status by country", outline],
];
