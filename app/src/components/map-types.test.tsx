// The mock's "map types" recording (dev/mock/map-types.ts): every region map renders as SVG (no
// Leaflet), with its marks named and no prop error; the two street maps are Leaflet, with a route
// and clusters.
import { waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mapTypes } from "@/dev/mock/map-types";
import { renderApp, sendInQuickChat } from "@/test/app";

describe("the map types mock", () => {
  it("renders every region kind as SVG and the street maps with a route and clusters", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "show me the map types");
    for (const [title] of mapTypes) expect((await within(log).findAllByText(title, {}, { timeout: 10_000 })).length).toBeGreaterThan(0);
    const kinds = () =>
      [...log.querySelectorAll(".ui-map[data-map-kind]")].map((m) => `${m.getAttribute("data-map-kind")} ${m.getAttribute("data-set")}`);
    await waitFor(
      () =>
        expect(kinds()).toEqual([
          "choropleth world",
          "choropleth us-states",
          "bubble europe",
          "outline europe",
          "connection world",
          "connection europe",
          "hexbin europe",
          "choropleth world",
        ]),
      { timeout: 15_000 },
    );
    // Only the two street maps load Leaflet.
    await waitFor(() => expect(log.querySelectorAll(".leaflet-container")).toHaveLength(2), { timeout: 15_000 });
    expect(log.querySelector('path[aria-label="Morning round · 14 km, 9 stops"]')).not.toBeNull();
    expect(log.querySelectorAll("[data-cluster]").length).toBeGreaterThan(0);
    // Most of the world has no row: plain land, not hatched.
    expect(log.querySelector('.ui-map[data-set=world] path[data-region="ATA"], .ui-map[data-set=world] path[data-region="FIN"]')).toHaveAttribute(
      "data-fill",
      "land",
    );
    expect(within(log).getByRole("img", { name: "London to New York, 14 flights, London–New York is a trunk route" })).toBeInTheDocument();
    expect(within(log).getByRole("img", { name: /^Pennsylvania, 1.7 pts, class 4 of 7/ })).toBeInTheDocument();
    expect(within(log).getByRole("img", { name: "Paris, 7.9 M EUR, 7.9 M EUR" })).toBeInTheDocument();
    expect(within(log).getByRole("img", { name: "Italy, problem, Milan down since 09:12" })).toBeInTheDocument();
    expect(within(log).queryAllByRole("alert")).toHaveLength(0);
  }, 40_000);
});
