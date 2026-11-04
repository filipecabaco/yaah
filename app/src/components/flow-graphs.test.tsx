// The mock's "flow graphs" recording (dev/mock/flow-graphs.ts): the CI sankey, the service
// network and a large package graph render with their nodes named and no prop error.
import { waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { flowGraphs } from "@/dev/mock/flow-graphs";
import { renderApp, sendInQuickChat } from "@/test/app";

describe("the flow graphs mock", () => {
  it("renders the CI sankey, the service network and the 180-package graph", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "show me the flow graphs");
    for (const [title] of flowGraphs) expect((await within(log).findAllByText(title, {}, { timeout: 10_000 })).length).toBeGreaterThan(0);
    await waitFor(
      () => expect([...log.querySelectorAll(".ui-flow")].map((f) => f.getAttribute("data-flow-kind"))).toEqual(["sankey", "network", "network"]),
      {
        timeout: 15_000,
      },
    );
    expect(within(log).getByRole("img", { name: "Failed, 57 runs, end, problem" })).toBeInTheDocument();
    expect(within(log).getByRole("img", { name: /^api, 8 links, size 9, group core/ })).toBeInTheDocument();
    // The 180-node graph is laid out off the main thread where there is a Worker; happy-dom has none, so it runs here.
    expect(log.querySelectorAll("[data-node]")).toHaveLength(8 + 15 + 180);
    expect(within(log).queryAllByRole("alert")).toHaveLength(0);
  }, 40_000);
});
