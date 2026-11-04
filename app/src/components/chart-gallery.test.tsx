// The mock's "chart gallery" recording (dev/mock/chart-gallery.ts): every subject's dashboard
// renders, and none shows a prop error (a bad series count, a ref without a label...).
import { waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { chartGallery } from "@/dev/mock/chart-gallery";
import { renderApp, sendInQuickChat } from "@/test/app";

describe("the chart gallery mock", () => {
  it("renders every dashboard without an error", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "show me the chart gallery");
    for (const [, tree] of chartGallery) {
      const title = (tree.props as { title: string }).title;
      expect(await within(log).findByText(title, {}, { timeout: 10_000 })).toBeInTheDocument();
    }
    // One chart per subject, loaded on first use: eight `.ui-chart` wrappers, and a ninth `data-chart-kind`
    // on the dumbbell's own <svg> (it is its own figure; bar, line and area draw inside the wrapper).
    const kinds = () => [...log.querySelectorAll(".ui-chart[data-chart-kind]")].map((c) => c.getAttribute("data-chart-kind"));
    await waitFor(() => expect(kinds()).toEqual(["line", "bar", "area", "dumbbell", "bar", "line", "bar", "area"]), { timeout: 15_000 });
    expect(log.querySelectorAll("[data-chart-kind]")).toHaveLength(9);
    expect(log.querySelectorAll("svg[data-chart-kind='dumbbell']")).toHaveLength(1);
    // The logistics card's map.
    expect(await within(log).findByRole("region", { name: "Map, 8 places" }, { timeout: 10_000 })).toBeInTheDocument();
    expect(within(log).queryAllByRole("alert")).toHaveLength(0);
  }, 30_000);
});
