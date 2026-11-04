// The mock's "map gallery" recording (dev/mock/map-gallery.ts): every example renders its map and
// none shows a prop error.
import { waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mapGallery } from "@/dev/mock/map-gallery";
import { renderApp, sendInQuickChat } from "@/test/app";

describe("the map gallery mock", () => {
  it("renders every example without an error", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "show me the map gallery");
    for (const [title] of mapGallery) {
      expect((await within(log).findAllByText(title, {}, { timeout: 10_000 })).length).toBeGreaterThan(0);
    }
    await waitFor(() => expect(within(log).queryAllByRole("region", { name: /^Map, / })).toHaveLength(mapGallery.length), { timeout: 15_000 });
    expect(within(log).getByRole("region", { name: "Map, 200 places" })).toBeInTheDocument();
    expect(within(log).queryAllByRole("alert")).toHaveLength(0);
  }, 40_000);
});
