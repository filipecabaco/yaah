// Region maps drawn for real (happy-dom, no layout: the box is its 640px fallback): each kind's
// marks and names, the table view, keyboard focus and its tooltip, the legends, missing data
// hatched, ids that don't resolve said, Leaflet never loaded, and only theme tokens for colour.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import UiGeoMap from "@/components/ui-blocks/map/geo-map";
import { UiViewContext } from "@/components/ui-view";

// Region kinds draw SVG: importing Leaflet at all would fail this file.
vi.mock("leaflet", () => {
  throw new Error("Leaflet was imported by a region map");
});
vi.mock("react-leaflet", () => {
  throw new Error("react-leaflet was imported by a region map");
});

async function draw(props: Record<string, unknown>, expanded = false) {
  const view = render(
    <UiViewContext.Provider value={{ expanded }}>
      <UiGeoMap props={props} />
    </UiViewContext.Provider>,
  );
  await waitFor(() => expect(view.container.querySelector("svg [data-part=regions]")).not.toBeNull());
  return view;
}

const margins = {
  kind: "choropleth",
  region: "us-states",
  title: "2024 margin by state",
  data: [
    { id: "PA", value: 1.7, detail: "R +1.7" },
    { id: "Michigan", value: 1.4 },
    { id: "VA", value: -5.8 },
    { id: "WY", value: 46.1 },
    { id: "VT", value: null },
  ],
  scale: { type: "diverging", domain: [-20, 20], midpoint: 0, bins: 7, unit: " pts" },
  legend: { title: "Margin (R + / D −)" },
};

describe("choropleth", () => {
  it("colours each region by its bin and hatches the ones without data", async () => {
    const { container } = await draw({ ...margins, missing: "hatch" });
    const fill = (id: string) => container.querySelector(`path[data-region="${id}"]`)!.getAttribute("fill");
    expect(container.querySelectorAll("path[data-region]")).toHaveLength(51);
    expect(fill("PA")).toBe("var(--scale-div-mid)");
    expect(fill("WY")).toBe("var(--scale-div-pos-3)"); // 46.1 clamped into the top bin
    expect(fill("VA")).toBe("var(--scale-div-neg-1)");
    expect(fill("VT")).toMatch(/^url\(#.+-hatch\)$/); // null: no data
    expect(fill("TX")).toMatch(/^url\(#.+-hatch\)$/); // no row: no data
    expect(container.querySelector("pattern line")).toHaveAttribute("stroke", "var(--map-hatch)");
  });

  it("draws regions without a row as plain land when most of the set has none, nulls still hatched", async () => {
    const { container } = await draw(margins);
    const at = (id: string) => container.querySelector(`path[data-region="${id}"]`)!;
    // A diverging scale with a gray middle class: plain land is an outline, so the two can't be confused.
    expect(at("TX")).toHaveAttribute("fill", "var(--chart-surface)");
    expect(at("TX")).toHaveAttribute("data-fill", "outline");
    expect(container.querySelectorAll("[data-part=outside] path")).toHaveLength(46);
    // A sequential scale has no gray class: land keeps its fill.
    const seq = await draw({ ...margins, scale: { type: "sequential", bins: 5 } });
    expect(seq.container.querySelector('path[data-region="TX"]')).toHaveAttribute("fill", "var(--map-land)");
    seq.unmount();
    expect(at("VT").getAttribute("fill")).toMatch(/hatch/);
    const legend = screen.getByRole("group", { name: "Colour scale" });
    expect(within(legend).getByText("Not in the data")).toBeInTheDocument();
    expect(within(legend).getByText("No data")).toBeInTheDocument();
  });

  it("names every region with a row, and the legend says the bins, the open end and no data", async () => {
    const { container } = await draw(margins);
    expect(screen.getByRole("img", { name: "Pennsylvania, 1.7 pts, class 4 of 7 (-3 pts to 3 pts), R +1.7" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Vermont, No data/ })).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(5);
    const legend = screen.getByRole("group", { name: "Colour scale" });
    expect(within(legend).getByText("Margin (R + / D −)")).toBeInTheDocument();
    const bins = within(legend).getAllByRole("listitem");
    expect(bins).toHaveLength(7);
    expect(bins[6]).toHaveAccessibleName(/^7 of 7: > 14 pts/);
    expect(bins[3]).toHaveAccessibleName(/midpoint/);
    expect(within(legend).getByText("No data")).toBeInTheDocument();
    // Few regions: every one is labelled, by its postal code, on the map itself.
    const labels = [...container.querySelectorAll("[data-part=label]")].map((t) => t.textContent);
    expect(labels).toEqual(expect.arrayContaining(["PA", "VA", "WY"]));
  });

  it("flips to a table of every row, sorted by value, with its class", async () => {
    const user = userEvent.setup();
    await draw(margins);
    await user.click(screen.getByRole("button", { name: "table" }));
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector("td")!.textContent)).toEqual(["Wyoming", "Pennsylvania", "Michigan", "Virginia", "Vermont"]);
    expect(rows[0]).toHaveTextContent("class 7 of 7 (over 14 pts)");
    expect(rows[4]).toHaveTextContent("No data");
    expect(screen.getByRole("table")).toHaveTextContent("46 regions of US states have no row");
  });

  it("is one tab stop; arrows move between regions and show the same tooltip as hover", async () => {
    const user = userEvent.setup();
    await draw(margins);
    await user.tab();
    await user.tab();
    await user.tab();
    const first = document.activeElement!;
    expect(first).toHaveAttribute("data-region", "PA");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pennsylvania1.7 pts");
    expect(first).toHaveAttribute("aria-describedby", screen.getByRole("tooltip").id);
    expect(document.querySelectorAll("[data-region][tabindex='0']")).toHaveLength(1);
    await user.keyboard("{End}");
    expect(document.activeElement).toHaveAttribute("data-region", "VT");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Vermont");
    // Enter pins the tooltip, Escape clears it.
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("says which rows aren't in the set instead of dropping them silently", async () => {
    await draw({ ...margins, data: [...margins.data, { id: "Puerto Rico", value: 3 }] });
    expect(screen.getByRole("status")).toHaveTextContent("1 row isn't in US states and isn't shown: Puerto Rico");
  });

  it("fences an outlier off an unset domain and says so", async () => {
    const data = ["DEU", "FRA", "ESP", "ITA", "POL", "PRT", "NLD", "BEL", "AUT"].map((id, i) => ({ id, value: 10 + i }));
    await draw({ kind: "choropleth", region: "europe", data: [...data, { id: "MLT", value: 900 }] });
    expect(screen.getByRole("group", { name: "Colour scale" })).toHaveTextContent("Scale clipped at");
    expect(screen.getByRole("img", { name: /^Malta, 900, class 5 of 5 \(over/ })).toBeInTheDocument();
  });

  it("draws the base and says so when there are no rows", async () => {
    const { container } = await draw({ kind: "choropleth", region: "world", data: [] });
    expect(container.querySelector("[data-part=empty]")).toHaveTextContent("No data to show");
    expect(container.querySelectorAll("path[data-region]").length).toBeGreaterThan(170);
  });
});

describe("bubble", () => {
  const stores = {
    kind: "bubble",
    region: "europe",
    unit: "M EUR",
    points: [
      { lon: -9.14, lat: 38.72, label: "Lisbon", value: 4.2 },
      { lon: 2.35, lat: 48.86, label: "Paris", value: 7.9 },
      { lon: 13.4, lat: 52.52, label: "Berlin", value: 3.1 },
      { lon: 0, lat: 45, label: "Nowhere", value: -1 },
    ],
  };

  it("sizes by area over [0, max], draws the largest first, and labels a small set at once", async () => {
    const { container } = await draw(stores);
    const bubbles = [...container.querySelectorAll("[data-mark=bubble]")];
    expect(bubbles.map((b) => Number(b.getAttribute("data-value")))).toEqual([7.9, 4.2, 3.1]);
    const [paris, lisbon] = bubbles.map((b) => Number(b.getAttribute("r")));
    expect(lisbon ** 2 / paris ** 2).toBeCloseTo(4.2 / 7.9, 2);
    expect(bubbles[0]).toHaveAttribute("fill", "var(--chart-1)");
    const labels = [...container.querySelectorAll("[data-part=label]")].map((t) => t.textContent);
    expect(labels.sort()).toEqual(["Berlin", "Lisbon", "Paris"]);
    expect(screen.getByRole("img", { name: "Paris, 7.9 M EUR" })).toBeInTheDocument();
  });

  it("has a nested size legend and counts the negative values it left out", async () => {
    await draw(stores);
    const legend = screen.getByRole("group", { name: "Size scale" });
    expect(legend).toHaveTextContent("5 M EUR, 2 M EUR, 0.5 M EUR");
    expect(legend.querySelectorAll("circle")).toHaveLength(3);
    expect(document.querySelector("[data-part=legend]")).toHaveTextContent("1 negative value not drawn");
  });

  it("fits most places and offers the far-off ones behind a chip", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 24 }, (_, i) => ({ lon: -2 + (i % 6) * 3, lat: 42 + Math.floor(i / 6) * 2, label: `S${i}`, value: 1 + i }));
    const { container } = await draw({ kind: "bubble", region: "world", points: [...many, { lon: 151.2, lat: -33.9, label: "Sydney", value: 3 }] });
    const chip = container.querySelector("[data-part=outside-chip]")!;
    expect(chip).toHaveTextContent("1 outside view");
    expect(screen.queryByRole("img", { name: /^Sydney/ })).toBeNull();
    await user.click(chip);
    expect(screen.getByRole("img", { name: /^Sydney/ })).toBeInTheDocument();
  });
});

describe("outline", () => {
  it("marks highlighted regions with their tone in colour and in words, places as dots, and a tone key", async () => {
    const { container } = await draw({
      kind: "outline",
      region: "europe",
      highlight: [{ id: "PT", tone: "success" }, { id: "Poland", tone: "warning", detail: "degraded" }, { id: "DE" }],
      points: [{ lon: -9.14, lat: 38.72, label: "Lisbon" }],
    });
    expect(container.querySelector('path[data-region="PRT"]')).toHaveAttribute("fill", "var(--chart-3)");
    expect(container.querySelector('path[data-region="POL"]')).toHaveAttribute("fill", "var(--chart-4)");
    expect(container.querySelector('path[data-region="DEU"]')).toHaveAttribute("fill", "var(--chart-1)");
    expect(container.querySelector('path[data-region="FRA"]')).toHaveAttribute("fill", "var(--map-land)");
    expect(screen.getByRole("img", { name: "Poland, warning, degraded" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Lisbon" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("Good(1)");
    expect(container.querySelector("[data-part=borders]")).toHaveAttribute("stroke", "var(--map-stroke)");
  });
});

const flights = {
  kind: "connection",
  region: "world",
  title: "Daily flights",
  unit: " flights",
  hubs: [
    { id: "LIS", label: "Lisbon", lon: -9.14, lat: 38.77 },
    { id: "GRU", label: "Sao Paulo", lon: -46.47, lat: -23.43 },
    { id: "JFK", label: "New York", lon: -73.78, lat: 40.64 },
  ],
  links: [
    { from: "LIS", to: "GRU", value: 6 },
    { from: "LIS", to: "JFK", value: 9, label: "TP 209" },
    { from: "JFK", to: "GRU", value: 3 },
  ],
  directed: true,
};

// A tight cluster round Paris and a few points further off.
const stations = {
  kind: "hexbin",
  region: "europe",
  title: "Weather stations",
  unit: " stations",
  radius: 16,
  view: [-12, 35, 30, 60],
  points: [
    ...Array.from({ length: 30 }, (_, i) => ({ lon: 2.3 + (i % 5) * 0.05, lat: 48.8 + Math.floor(i / 5) * 0.05 })),
    { lon: -9.1, lat: 38.7 },
    { lon: 13.4, lat: 52.5 },
    { lon: 21.0, lat: 52.2 },
  ],
};

describe("connection", () => {
  it("draws each link as a great circle, as wide as its value, thickest first, with arrowheads", async () => {
    const { container } = await draw(flights);
    const lines = [...container.querySelectorAll("[data-mark=link]")];
    expect(lines).toHaveLength(3);
    const widths = lines.map((l) => Number(l.getAttribute("data-width")));
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    expect(widths[0]).toBe(8);
    expect(container.querySelectorAll("[data-mark=arrow]")).toHaveLength(3);
    // A great circle is a curve: many points, not one straight segment.
    expect(lines[0].getAttribute("d")!.split("L").length).toBeGreaterThan(20);
    expect(container.querySelectorAll("[data-mark=hub]")).toHaveLength(3);
  });

  it("names hubs and links, labels the hubs and the link that has a label, and keys the widths", async () => {
    const { container } = await draw(flights);
    expect(screen.getByRole("img", { name: "Lisbon to New York, 9 flights, TP 209" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Lisbon, 15 flights in all, 2 links" })).toBeInTheDocument();
    const labels = [...container.querySelectorAll("[data-part=label]")].map((t) => t.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Lisbon", "Sao Paulo", "New York", "TP 209"]));
    const legend = screen.getByRole("group", { name: "Line width scale" });
    expect(legend).toHaveTextContent("Arrows point from origin to destination");
    expect(legend.querySelectorAll("line")).toHaveLength(3);
  });

  it("flips to a table of links, busiest first", async () => {
    const user = userEvent.setup();
    await draw(flights);
    await user.click(screen.getByRole("button", { name: "table" }));
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => [...r.querySelectorAll("td")].slice(0, 3).map((td) => td.textContent))).toEqual([
      ["Lisbon", "New York", "9 flights"],
      ["Lisbon", "Sao Paulo", "6 flights"],
      ["New York", "Sao Paulo", "3 flights"],
    ]);
  });
});

describe("hexbin", () => {
  it("bins points into hexagons coloured by count, says how many, and lists the fullest cells", async () => {
    const user = userEvent.setup();
    const { container } = await draw(stations);
    const cells = [...container.querySelectorAll("[data-mark=cell]")];
    expect(cells.length).toBeGreaterThanOrEqual(4);
    const values = cells.map((c) => Number(c.getAttribute("data-value")));
    expect(values.reduce((a, b) => a + b, 0)).toBe(33);
    expect(cells.every((c) => /^var\(--scale-seq-\d+\)$/.test(c.getAttribute("fill")!))).toBe(true);
    expect(screen.getAllByRole("img", { name: /^Cell at \d+\.\d° N, \d+\.\d° [EW], \d+ stations, class \d of 4/ }).length).toBe(cells.length);
    expect(screen.getByRole("group", { name: "Colour scale" })).toHaveTextContent(`33 points in ${cells.length} cells, each 32 px across`);
    await user.click(screen.getByRole("button", { name: "table" }));
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(cells.length);
    expect(rows[0].querySelectorAll("td")[1].textContent).toBe(`${Math.max(...values)} stations`);
  });
});

describe("bubble crowds", () => {
  it("rings every bubble in the surface colour and labels up to 10 of a crowd, none overlapping", async () => {
    const crowd = Array.from({ length: 30 }, (_, i) => ({
      lon: 2 + (i % 6) * 0.6,
      lat: 48 + Math.floor(i / 6) * 0.6,
      label: `Store ${i}`,
      value: 1 + i,
    }));
    const { container } = await draw({ kind: "bubble", region: "europe", points: crowd, view: [-10, 35, 30, 60] });
    const bubbles = [...container.querySelectorAll("[data-mark=bubble]")];
    expect(bubbles.every((b) => b.getAttribute("stroke") === "var(--chart-surface)" && b.getAttribute("stroke-width") === "2")).toBe(true);
    const labels = [...container.querySelectorAll("[data-part=label]")];
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThanOrEqual(10);
    // The biggest is labelled first.
    expect(labels.map((l) => l.textContent)).toContain("Store 29");
  });
});

describe("the 50m world", () => {
  it("draws a zoomed world view from the detailed coast once it loads", async () => {
    const { container } = await draw({ kind: "outline", region: "world", view: [-10, 36, 4, 44], highlight: [{ id: "PT" }] });
    await waitFor(() => expect(container.querySelector('[data-detail="50m"]')).not.toBeNull());
    expect(container.querySelector('path[data-region="PRT"]')).not.toBeNull();
    const whole = await draw({ kind: "outline", region: "world", highlight: [{ id: "PT" }] });
    expect(whole.container.querySelector("[data-detail]")).toBeNull();
  });
});

describe("theme", () => {
  it("takes every colour from a theme token: no hex, rgb or named colour anywhere in the map", async () => {
    for (const props of [
      margins,
      { kind: "bubble", region: "world", points: [{ lon: 0, lat: 0, label: "a", value: 1 }] },
      { kind: "outline", highlight: [{ id: "BR", tone: "danger" }] },
      flights,
      stations,
    ]) {
      const { container, unmount } = await draw(props);
      const colours = [...container.querySelectorAll("svg *")].flatMap((el) =>
        ["fill", "stroke"].map((a) => el.getAttribute(a)).filter((v): v is string => v != null),
      );
      const bad = colours.filter((c) => !/^(var\(--[\w-]+\)|url\(#[\w-]+\)|none|transparent)$/.test(c));
      expect(bad).toEqual([]);
      unmount();
    }
  });

  it("fills the Expand dialog and keeps at least its inline height", async () => {
    const { container } = await draw(margins, true);
    const box = container.querySelector<HTMLElement>("[data-grow]")!;
    expect(box.getAttribute("data-grow")).toBe("fill");
    expect(box.className).toContain("flex-1");
    expect(box.style.minHeight).toBe("360px");
    const inline = await draw(margins, false);
    expect(inline.container.querySelector("[data-grow]")).toBeNull();
  });
});
