// A gallery of small dashboards, one per subject, each showing off a different chart kind or prop.
// All numbers are made up. `chart-gallery.test.tsx` renders every one, so they stay valid as the
// chart and map code change.
type Tree = Record<string, unknown>;
const stat = (label: string, value: string, extra: Record<string, unknown> = {}): Tree => ({ type: "stat", props: { label, value, ...extra } });
const statRow = (...stats: Tree[]): Tree => ({ type: "grid", props: { columns: stats.length, gap: "md" }, children: stats });
const card = (title: string, description: string, ...children: Tree[]): Tree => ({ type: "card", props: { title, description }, children });
const chart = (props: Record<string, unknown>): Tree => ({ type: "chart", props });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const lisbon = [12, 13, 15, 17, 20, 23, 26, 26, 24, 20, 15, 13];
const oslo = [-4, -4, 0, 5, 11, 15, 18, 17, 12, 6, 1, -2];
const cairo = [14, 15, 18, 22, 27, 29, 30, 30, 28, 25, 20, 15];

const weather = card(
  "Climate: monthly mean temperature",
  "Three cities, degrees Celsius. The line is Lisbon's yearly average. Made-up data.",
  statRow(
    stat("Hottest month", "Cairo, 30 °C", { hint: "July and August" }),
    stat("Coldest month", "Oslo, -4 °C", { hint: "January and February" }),
    stat("Widest swing", "Oslo, 22 °C", { hint: "Between January and July" }),
  ),
  chart({
    kind: "line",
    x: "month",
    unit: " °C",
    height: 280,
    data: MONTHS.map((month, i) => ({ month, lisbon: lisbon[i], oslo: oslo[i], cairo: cairo[i] })),
    series: [
      { key: "lisbon", label: "Lisbon" },
      { key: "oslo", label: "Oslo" },
      { key: "cairo", label: "Cairo" },
    ],
    refs: [{ axis: "y", value: 19.0, label: "Lisbon yearly average" }],
    labels: "ends",
  }),
);

const sales = card(
  "Product sales: units by region",
  "Stacked by region per quarter, biggest quarter first. Made-up data.",
  statRow(
    stat("Units this year", "48.2k", { delta: "+9%", trend: "up" }),
    stat("Best region", "EMEA", { hint: "38% of units" }),
    stat("Weakest quarter", "Q2", { delta: "-4%", trend: "down" }),
  ),
  chart({
    kind: "bar",
    stacked: true,
    x: "quarter",
    sort: "value",
    labels: "ends",
    unit: "k",
    height: 280,
    data: [
      { quarter: "Q1", emea: 4.1, amer: 3.2, apac: 2.0, latam: 0.9 },
      { quarter: "Q2", emea: 3.8, amer: 2.9, apac: 1.8, latam: 0.8 },
      { quarter: "Q3", emea: 4.6, amer: 3.7, apac: 2.4, latam: 1.1 },
      { quarter: "Q4", emea: 5.9, amer: 4.8, apac: 3.1, latam: 1.6 },
    ],
    series: [
      { key: "emea", label: "EMEA" },
      { key: "amer", label: "Americas" },
      { key: "apac", label: "APAC" },
      { key: "latam", label: "LATAM" },
    ],
  }),
);

const traffic = card(
  "Web traffic: requests by service",
  "Requests per second over a day, stacked. Made-up data.",
  statRow(
    stat("p50 latency", "42 ms", { delta: "-3 ms", trend: "down" }),
    stat("p99 latency", "380 ms", { delta: "+25 ms", trend: "up" }),
    stat("Error rate", "0.18%", { trend: "flat" }),
    stat("Peak", "4,980 rps", { hint: "At 18:00" }),
  ),
  chart({
    kind: "area",
    stacked: true,
    x: "hour",
    unit: " rps",
    height: 280,
    labels: "ends",
    data: ["00:00", "04:00", "08:00", "12:00", "16:00", "18:00", "20:00", "23:00"].map((hour, i) => ({
      hour,
      api: [420, 310, 980, 1500, 1800, 2100, 1600, 800][i],
      web: [300, 180, 700, 1200, 1500, 1700, 1400, 600][i],
      search: [120, 80, 340, 600, 720, 800, 650, 260][i],
      auth: [60, 40, 220, 310, 330, 380, 290, 120][i],
    })),
    series: [
      { key: "api", label: "API" },
      { key: "web", label: "Web" },
      { key: "search", label: "Search" },
      { key: "auth", label: "Auth" },
    ],
  }),
);

const TEAMS: [string, number, number][] = [
  ["Harbour City", 61, 78],
  ["Northgate", 72, 70],
  ["Riverside", 55, 68],
  ["Old Town", 80, 74],
  ["Eastfield", 48, 66],
  ["Westbrook", 66, 69],
  ["Stonebridge", 58, 51],
  ["Lakeshore", 70, 83],
];
const sports = card(
  "Sports: points, last season against this season",
  "A fictional league. Widest change first.",
  statRow(
    stat("Biggest climb", "Eastfield, +18 pts"),
    stat("Biggest drop", "Stonebridge, -7 pts"),
    stat("League average", "70.8 pts", { delta: "+3.1", trend: "up" }),
  ),
  chart({
    kind: "dumbbell",
    x: "team",
    sort: "gap",
    unit: " pts",
    data: TEAMS.map(([team, last, now]) => ({ team, last, now })),
    series: [
      { key: "last", label: "Last season" },
      { key: "now", label: "This season" },
    ],
    scale: { type: "categorical" },
  }),
);

const health = card(
  "Public health: vaccination rate by country",
  "Share of adults vaccinated. The line is the 80% target. Made-up data.",
  statRow(stat("Countries at target", "3 of 8"), stat("Median", "77%"), stat("Lowest", "Country H, 52%", { trend: "down" })),
  chart({
    kind: "bar",
    orientation: "horizontal",
    x: "country",
    sort: "value",
    labels: "ends",
    unit: "%",
    data: [
      ["Country A", 91],
      ["Country B", 86],
      ["Country C", 82],
      ["Country D", 78],
      ["Country E", 74],
      ["Country F", 69],
      ["Country G", 61],
      ["Country H", 52],
    ].map(([country, rate]) => ({ country, rate })),
    series: [{ key: "rate", label: "Vaccinated" }],
    refs: [{ axis: "y", value: 80, label: "Target 80%" }],
  }),
);

const index = [100, 102.4, 101.1, 104.8, 107.2, 105.6, 109.9, 112.3, 110.4, 114.8, 118.1, 116.5];
const finance = card(
  "Finance: a made-up stock index",
  "Monthly close. The line marks the starting value of 100.",
  statRow(
    stat("Close", "116.5", { delta: "+16.5%", trend: "up" }),
    stat("High", "118.1", { hint: "November" }),
    stat("Worst month", "Mar, -1.3%", { trend: "down" }),
  ),
  chart({
    kind: "line",
    x: "month",
    height: 260,
    data: MONTHS.map((month, i) => ({ month, close: index[i] })),
    series: [{ key: "close", label: "Index" }],
    refs: [{ axis: "y", value: 100, label: "Start 100" }],
  }),
  {
    type: "table",
    props: {
      columns: [
        { key: "ticker", label: "Ticker" },
        { key: "name", label: "Company" },
        { key: "price", label: "Price", align: "right" },
        { key: "change", label: "Change", align: "right" },
      ],
      rows: [
        { ticker: "AAA", name: "Alpha Works", price: "142.10", change: "+1.8%" },
        { ticker: "BRV", name: "Bravo Freight", price: "58.40", change: "-0.6%" },
        { ticker: "CHL", name: "Charlie Labs", price: "233.75", change: "+3.2%" },
        { ticker: "DLT", name: "Delta Grid", price: "31.05", change: "-2.1%" },
      ],
    },
  },
);

const HUBS: [string, number, number, number][] = [
  ["Rotterdam", 51.92, 4.48, 1840],
  ["Hamburg", 53.55, 9.99, 1510],
  ["Lyon", 45.76, 4.84, 920],
  ["Madrid", 40.42, -3.7, 1130],
  ["Milan", 45.46, 9.19, 1260],
  ["Warsaw", 52.23, 21.01, 780],
  ["Gothenburg", 57.71, 11.97, 540],
  ["Athens", 37.98, 23.73, 410],
];
const travel = card(
  "Logistics: hubs across Europe",
  "Eight made-up distribution hubs and their weekly shipments.",
  statRow(
    stat("Weekly shipments", "8,390", { delta: "+5%", trend: "up" }),
    stat("On-time", "94.6%", { trend: "flat" }),
    stat("Busiest hub", "Rotterdam"),
  ),
  {
    type: "map",
    props: {
      height: 340,
      markers: HUBS.map(([label, lat, lng, n]) => ({
        lat,
        lng,
        label,
        detail: `${n.toLocaleString("en")} shipments a week`,
        tone: n > 1500 ? "success" : n < 600 ? "warning" : "default",
      })),
    },
  },
  chart({
    kind: "bar",
    x: "hub",
    sort: "value",
    labels: "ends",
    height: 260,
    data: HUBS.map(([hub, , , shipments]) => ({ hub, shipments })),
    series: [{ key: "shipments", label: "Shipments a week" }],
  }),
);

const energy = card(
  "Energy: electricity mix",
  "Share of generation by source over a made-up year, percent.",
  statRow(
    stat("Low-carbon share", "71%", { delta: "+6 pts", trend: "up" }),
    stat("Peak solar", "34%", { hint: "June" }),
    stat("Gas", "29%", { delta: "-6 pts", trend: "down" }),
  ),
  chart({
    kind: "area",
    stacked: true,
    x: "month",
    unit: "%",
    height: 280,
    labels: "ends",
    data: MONTHS.map((month, i) => {
      const solar = [6, 8, 13, 19, 26, 34, 33, 30, 21, 12, 7, 5][i];
      const wind = [24, 23, 22, 18, 14, 11, 10, 12, 17, 22, 25, 26][i];
      const nuclear = 22;
      return { month, solar, wind, nuclear, gas: 100 - solar - wind - nuclear };
    }),
    series: [
      { key: "solar", label: "Solar" },
      { key: "wind", label: "Wind" },
      { key: "nuclear", label: "Nuclear" },
      { key: "gas", label: "Gas" },
    ],
  }),
);

/** [title, tree] per subject, in the order they are shown. */
export const chartGallery: [string, Tree][] = [
  ["Climate", weather],
  ["Product sales", sales],
  ["Web traffic", traffic],
  ["Sports", sports],
  ["Public health", health],
  ["Finance", finance],
  ["Logistics", travel],
  ["Energy", energy],
];
