// The browser mock's election dashboard ("election dashboard"), the shape an agent built for the
// user: stat tiles, tabs, the poll-against-result dumbbell with its Tie line, and a stacked area.
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
  });
});
