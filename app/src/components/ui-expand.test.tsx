// Expanding a rendered UI into a large dialog: the same UI moves there (not a copy), so its state
// stays in sync with the inline entry and its live source isn't read twice; blocks fill the
// dialog's height through the `expanded` flag; F opens it, j/k work inside, Esc closes it.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, sendInQuickChat } from "@/test/app";

function calls(cmd: string) {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const spy = vi.spyOn(internals, "invoke");
  return () => spy.mock.calls.filter(([c]) => c === cmd).length;
}

/** A chat showing a live diff-review (the mock's folder request, answered with Add). */
async function reviewInChat() {
  const app = renderApp();
  const reads = calls("read_source");
  const log = await sendInQuickChat(app.user, "give me the diff of my project in workspace of yaah");
  const card = await within(log).findByRole("group", { name: "Folder request" });
  await app.user.click(within(card).getByRole("button", { name: "Add" }));
  const files = await within(log).findByRole("navigation", { name: "Files" });
  const figure = files.closest("figure") as HTMLElement;
  return { ...app, log, figure, reads };
}

const review = (root: ParentNode) => root.querySelector<HTMLElement>("[data-layout]") as HTMLElement;
const current = (root: HTMLElement) => within(root).getByRole("navigation", { name: "Files" }).querySelector("[aria-current]")?.getAttribute("title");

describe("expanding a rendered UI", () => {
  it("shows the same UI in a large dialog, in sync with the entry, without reading its source again", async () => {
    const { user, figure, reads } = await reviewInChat();
    const inline = review(figure);
    expect(inline).not.toHaveAttribute("data-expanded");
    expect(within(inline).getByRole("navigation", { name: "Files" }).className).toContain("max-h-[34rem]");
    const before = reads();

    // The caption's Expand (the diff-review header has one too).
    const expand = within(figure.querySelector("figcaption") as HTMLElement).getByRole("button", { name: "Expand" });
    expect(expand).toHaveAttribute("title", "Expand (F)");
    await user.click(expand);
    const dialog = await screen.findByRole("dialog", { name: "diff-review" });
    expect(dialog.className).toContain("h-[92vh]");
    expect(dialog.className).toContain("w-[96vw]");
    // The very same element, moved: nothing was mounted twice.
    const shown = review(dialog);
    expect(shown).toBe(inline);
    expect(figure.querySelector("[data-layout]")).toBeNull();
    // Sized by the `expanded` flag: the list and the diff drop their inline caps and fill the dialog.
    expect(shown).toHaveAttribute("data-expanded", "true");
    expect(shown.className).toContain("flex-1");
    const nav = within(shown).getByRole("navigation", { name: "Files" });
    expect(nav.className).toContain("max-h-none");
    expect(nav.className).not.toContain("max-h-[34rem]");
    expect(within(shown).getByLabelText(/^Diff of /).className).toContain("max-h-none");
    // No second reader polling the same source.
    await new Promise((r) => setTimeout(r, 50));
    expect(reads()).toBe(before);

    // Tick a file as viewed in the dialog …
    const tick = within(shown).getAllByRole("button", { name: /^Mark viewed: / })[0];
    const path = tick.getAttribute("aria-label")!.replace("Mark viewed: ", "");
    await user.click(tick);
    expect(within(shown).getByRole("button", { name: `Viewed: ${path}` })).toHaveAttribute("aria-pressed", "true");

    // … Esc closes it, and the entry shows it viewed, at its inline size again.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "diff-review" })).toBeNull());
    const back = review(figure);
    expect(back).toBe(inline);
    expect(back).not.toHaveAttribute("data-expanded");
    expect(within(back).getByRole("button", { name: `Viewed: ${path}` })).toHaveAttribute("aria-pressed", "true");
    expect(within(back).getByRole("navigation", { name: "Files" }).className).toContain("max-h-[34rem]");
    expect(reads()).toBe(before);
  });

  it("opens with F from the entry, and the review's keys work inside", async () => {
    const { user, figure } = await reviewInChat();
    review(figure).focus();
    await user.keyboard("f");
    const dialog = await screen.findByRole("dialog", { name: "diff-review" });
    const shown = review(dialog);
    // Focus is on the review itself, so j/k move between files straight away.
    await waitFor(() => expect(shown).toHaveFocus());
    const first = current(shown);
    await user.keyboard("j");
    expect(current(shown)).not.toBe(first);
    await user.keyboard("k");
    expect(current(shown)).toBe(first);
    // F inside the dialog doesn't open another; the header's Expand is gone there.
    await user.keyboard("f");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(shown).queryByRole("button", { name: "Expand" })).toBeNull();
  });

  it("opens from the review's own header too, and typing f in the composer doesn't", async () => {
    const { user, figure } = await reviewInChat();
    const composer = screen.getByRole("combobox", { name: "Message" });
    await user.hover(figure);
    await user.click(composer);
    await user.hover(figure);
    await user.keyboard("f");
    expect(screen.queryByRole("dialog", { name: "diff-review" })).toBeNull();
    await user.click(within(review(figure)).getByRole("button", { name: "Expand" }));
    expect(await screen.findByRole("dialog", { name: "diff-review" })).toBeInTheDocument();
  });
});
