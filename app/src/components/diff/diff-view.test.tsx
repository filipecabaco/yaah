// The full-screen review draws only the rows on screen, so a 5000-line file opens
// fast; scrolling and n/p bring the rest in, with the right line numbers.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiffView, ROW } from "@/components/diff/diff-view";
import { diffTexts } from "@/components/diff/model";

/** 5000 lines with every 50th changed: 100 hunks of 9 rows each in the review. */
function bigFile() {
  const before = Array.from({ length: 5000 }, (_, i) => `const line${i + 1} = ${i};`);
  const after = before.map((l, i) => (i % 50 === 0 ? `${l} // changed` : l));
  return diffTexts("src/big.ts", before.join("\n"), after.join("\n"));
}

describe("the review of a 5000-line diff", () => {
  async function openReview() {
    const user = userEvent.setup();
    const file = bigFile();
    render(<DiffView files={[file]} />);
    await user.click(screen.getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog", { name: "Review changes" });
    const rows = dialog.querySelector<HTMLElement>("[data-rows]")!;
    return { user, file, dialog, rows, body: rows.closest<HTMLElement>("[tabindex='-1']")! };
  }
  const lineNumbers = (dialog: HTMLElement) =>
    [...dialog.querySelectorAll("[data-rows] .grid")].map((r) => Number(r.children[1]?.textContent || r.children[0]?.textContent));

  it("is exact (not a whole-file replace) and draws a screenful, not every row", async () => {
    const { file, dialog, rows } = await openReview();
    expect(file).toMatchObject({ added: 100, removed: 100 });
    expect(file.hunks).toHaveLength(100);
    const total = file.hunks.reduce((n, h) => n + 1 + h.lines.length, 0);
    expect(Number(rows.dataset.rows)).toBe(total);
    // The scroll height is every row's, but only a screenful (plus a margin) is in the DOM.
    expect(rows.style.height).toBe(`${total * ROW}px`);
    const drawn = rows.querySelectorAll(".grid").length;
    expect(drawn).toBeGreaterThan(20);
    expect(drawn).toBeLessThan(150);
    expect(lineNumbers(dialog)[0]).toBe(1);
  });

  it("draws the rows scrolled to, with their line numbers", async () => {
    const { dialog, body } = await openReview();
    // happy-dom has no layout: give the box a size and a scroll position.
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(body, "scrollTop", { configurable: true, writable: true, value: 0 });
    // Each hunk is a header and 8 lines (a change with 3 lines either side): hunk 60 is around line 3000.
    act(() => {
      body.scrollTop = 60 * 9 * ROW;
      fireEvent.scroll(body);
    });
    await waitFor(() => expect(lineNumbers(dialog)).toContain(3001));
    expect(lineNumbers(dialog)).not.toContain(1);
    expect(dialog.querySelectorAll("[data-rows] .grid").length).toBeLessThan(150);
  });

  it("n jumps to the next hunk, marked down its edge", async () => {
    const { user, dialog, body } = await openReview();
    const scrolls: number[] = [];
    body.scrollTo = ((o: ScrollToOptions) => scrolls.push(o.top ?? 0)) as typeof body.scrollTo;
    await user.keyboard("n");
    expect(within(dialog).getByText("hunk 2 / 100")).toBeInTheDocument();
    // Hunk 2's header row: hunk 1 is its header and its lines before it.
    expect(scrolls.at(-1)).toBeGreaterThan(0);
    expect((scrolls.at(-1) ?? 0) % ROW).toBe(0);
  });
});
