// The browser mock's election dashboard ("election dashboard"), the shape an agent built for the
// user: stat tiles, tabs, the poll-against-result dumbbell with its Tie line, a stacked area, and
// a US choropleth of the results.
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, sendInQuickChat } from "@/test/app";

describe("the election dashboard mock", () => {
  it("renders the stats, the dumbbell sorted by gap with a Tie line, and the count over the night", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "build me an election dashboard");
    expect(await within(log).findByText("Election night: polls against results")).toBeInTheDocument();
    expect(within(log).getByText("Average polling miss")).toBeInTheDocument();
    expect(within(log).getByText("8 of 14")).toBeInTheDocument();

    // The chart block loads on first use.
    const chart = await within(log).findByRole("list", { name: "Final poll average and Result by state" }, { timeout: 10_000 });
    const rows = within(chart).getAllByRole("listitem");
    expect(rows).toHaveLength(14);
    // Widest gap first: Louisiana moved 7 points, Minnesota 0.4.
    expect(rows[0]).toHaveAttribute("data-row", "LA");
    expect(rows.at(-1)).toHaveAttribute("data-row", "MN");
    expect(within(chart).getByText("Tie")).toBeInTheDocument();
    expect(rows[0].getAttribute("aria-label")).toBe("LA: Final poll average 15 pts, Result 22 pts, gap +7 pts");
    expect(screen.getByLabelText("Colour scale")).toBeInTheDocument();

    await user.click(within(log).getByRole("tab", { name: "Count over the night" }));
    expect(await within(log).findByRole("tabpanel")).toBeInTheDocument();
    expect(within(log).getByRole("tabpanel").querySelector('[data-chart-kind="area"]')).not.toBeNull();

    // The map tab fills each state by its result on the same diverging scale, no tiles.
    await user.click(within(log).getByRole("tab", { name: "Map" }));
    const map = await within(log).findByRole("region", { name: "Map, Result margin in the 14 states" }, { timeout: 10_000 });
    expect(map.querySelector('path[data-region="LA"]')).toHaveAttribute("fill", "var(--scale-div-pos-3)");
    expect(map.querySelector('path[data-region="MN"]')).toHaveAttribute("fill", "var(--scale-div-neg-1)");
    expect(map.querySelector('path[data-region="CA"]')!.getAttribute("fill")).toMatch(/hatch/);
    expect(within(log).getByRole("img", { name: "Louisiana, 22 pts, class 7 of 7 (17 pts to 24 pts), R +22.0" })).toBeInTheDocument();
    expect(within(log).getByText("Not in this set")).toBeInTheDocument();
    expect(log.querySelector(".leaflet-container")).toBeNull();
  });
});
