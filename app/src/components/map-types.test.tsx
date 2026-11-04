// The mock's "map types" recording (dev/mock/map-types.ts): every region map renders as SVG (no
// Leaflet), with its marks named and no prop error.
import { waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mapTypes } from "@/dev/mock/map-types";
import { renderApp, sendInQuickChat } from "@/test/app";

describe("the map types mock", () => {
  it("renders a world and a US choropleth, a European bubble map and an outline", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "show me the map types");
    for (const [title] of mapTypes) expect((await within(log).findAllByText(title, {}, { timeout: 10_000 })).length).toBeGreaterThan(0);
    const kinds = () =>
      [...log.querySelectorAll(".ui-map[data-map-kind]")].map((m) => `${m.getAttribute("data-map-kind")} ${m.getAttribute("data-set")}`);
    await waitFor(() => expect(kinds()).toEqual(["choropleth world", "choropleth us-states", "bubble europe", "outline europe"]), {
      timeout: 15_000,
    });
    expect(log.querySelector(".leaflet-container")).toBeNull();
    expect(within(log).getByRole("img", { name: /^Pennsylvania, 1.7 pts, class 4 of 7/ })).toBeInTheDocument();
    expect(within(log).getByRole("img", { name: "Paris, 7.9 M EUR, 7.9 M EUR" })).toBeInTheDocument();
    expect(within(log).getByRole("img", { name: "Italy, problem, Milan down since 09:12" })).toBeInTheDocument();
    expect(within(log).queryAllByRole("alert")).toHaveLength(0);
  }, 40_000);
});
