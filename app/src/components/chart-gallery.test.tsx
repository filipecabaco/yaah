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
    // At least eight charts (one per subject, one with two), loaded on first use.
    await waitFor(() => expect(log.querySelectorAll("[data-chart-kind]").length).toBeGreaterThanOrEqual(8), { timeout: 15_000 });
    expect(within(log).queryAllByRole("alert")).toHaveLength(0);
  }, 30_000);
});
