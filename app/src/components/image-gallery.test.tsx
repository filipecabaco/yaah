// The mosaic a tool group's thumbnails open: all the images as tiles, one large on a click.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChatContext } from "@/components/chat-context";
import { ToolGroup } from "@/components/tool-group";
import type { Entry } from "@/lib/api";

type Tool = Extract<Entry, { type: "tool" }>;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function shot(n: number): Tool {
  return {
    type: "tool",
    toolCallId: `t${n}`,
    title: "vitro: screenshot",
    kind: "other",
    status: "completed",
    content: [{ type: "content", content: { type: "image", data: PNG, mimeType: "image/png", image: `img-${n}.png` } }],
  } as unknown as Tool;
}

function setup(count: number) {
  const tools = Array.from({ length: count }, (_, i) => shot(i));
  const user = userEvent.setup();
  render(
    <ChatContext.Provider value={{ sessionId: "s1" } as never}>
      <ToolGroup id="g" tools={tools} running={tools.map(() => false)} autoAllowed={0} card={() => null} />
    </ChatContext.Provider>,
  );
  return { user };
}

describe("image mosaic", () => {
  it("opens from any thumbnail, a tile opens one image, Prev/Next/keys/Back/Esc step through", async () => {
    const { user } = setup(7);
    const thumbs = screen.getAllByRole("button", { name: /^Open vitro: screenshot/ });
    expect(thumbs).toHaveLength(4);
    await user.click(thumbs[2]);
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("button", { name: /^Open image \d+ of 7/ })).toHaveLength(7);

    await user.click(within(dialog).getByRole("button", { name: /^Open image 3 of 7/ }));
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("3 of 7")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(within(dialog).getByText("4 of 7")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(within(dialog).getByText("6 of 7")).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    await user.click(within(dialog).getByRole("button", { name: "Previous image" }));
    expect(within(dialog).getByText("4 of 7")).toBeInTheDocument();

    // Esc: single -> mosaic, with focus on the tile just left; Esc again closes.
    await user.keyboard("{Escape}");
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /^Open image 4 of 7/ })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: /^Open image 1 of 7/ }));
    await user.click(screen.getByRole("button", { name: "Back to all" }));
    expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: /^Open image/ })).toHaveLength(7);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("gives focus back to the clicked thumbnail, and '+N more inside' opens the mosaic too", async () => {
    const { user } = setup(7);
    const thumbs = screen.getAllByRole("button", { name: /^Open vitro: screenshot/ });
    await user.click(thumbs[1]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(thumbs[1]).toHaveFocus();

    const more = screen.getByRole("button", { name: "+3 more inside" });
    await user.click(more);
    expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: /^Open image/ })).toHaveLength(7);
    await user.keyboard("{Escape}");
    expect(more).toHaveFocus();
  });
});
