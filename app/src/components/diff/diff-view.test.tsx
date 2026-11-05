// The full-screen review draws only the rows on screen, so a 5000-line file opens
// fast; scrolling and n/p bring the rest in, with the right line numbers.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiffView } from "@/components/diff/diff-view";
import { diffTexts, parsePatch } from "@/components/diff/model";
import { ROW, splitIndent } from "@/components/diff/lines";
import { PatchBlock, TextDiffBlock } from "@/components/ui-blocks/diff-blocks";

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
    [...dialog.querySelectorAll("[data-rows] [data-line]")].map((r) =>
      Number(r.querySelector("[data-new]")?.textContent || r.querySelector("[data-old]")?.textContent),
    );

  it("is exact (not a whole-file replace) and draws a screenful, not every row", async () => {
    const { file, dialog, rows } = await openReview();
    expect(file).toMatchObject({ added: 100, removed: 100 });
    expect(file.hunks).toHaveLength(100);
    const total = file.hunks.reduce((n, h) => n + 1 + h.lines.length, 0);
    expect(Number(rows.dataset.rows)).toBe(total);
    // The scroll height is every row's, but only a screenful (plus a margin) is in the DOM.
    expect(rows.style.height).toBe(`${total * ROW}px`);
    const drawn = rows.querySelectorAll("[data-line]").length;
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
    expect(dialog.querySelectorAll("[data-rows] [data-line]").length).toBeLessThan(150);
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

/**
 * The case that started this: Go with a tab-indented raw SQL string whose lines are
 * long. Tabs rendered 8 wide and wrapped, so it read as two ragged columns.
 */
const GO_BEFORE = "package billing\n\nconst refundQuery = `\n\tSELECT o.id, o.total_cents\n\tFROM orders o\n`\n";
const GO_AFTER =
  "package billing\n\nconst refundQuery = `\n\tSELECT o.id, o.total_cents, COALESCE(SUM(r.amount_cents), 0) AS refunded_cents, COALESCE((SELECT SUM(i.price_cents * i.quantity) FROM order_items i WHERE i.order_id = o.id AND i.id = ANY($2)), 0) AS items_cents\n\tFROM orders o\n\t\tLEFT JOIN refunds r ON r.order_id = o.id\n`\n";
const GO_PATCH = `diff --git a/internal/billing/refund.go b/internal/billing/refund.go
index 1..2 100644
--- a/internal/billing/refund.go
+++ b/internal/billing/refund.go
@@ -3,5 +3,6 @@ package billing
 const refundQuery = \`
-\tSELECT o.id, o.total_cents
+\tSELECT o.id, o.total_cents, COALESCE(SUM(r.amount_cents), 0) AS refunded_cents
 \tFROM orders o
+\t\tLEFT JOIN refunds r ON r.order_id = o.id
 \`
`;

describe("long tab-indented lines", () => {
  const codeOf = (el: HTMLElement, text: string) => [...el.querySelectorAll<HTMLElement>("[data-line]")].find((l) => l.textContent?.includes(text))!;

  it("keep tabs 4 wide and scroll sideways instead of wrapping", () => {
    const { container } = render(<PatchBlock text={GO_PATCH} />);
    const line = codeOf(container, "COALESCE");
    const code = line.lastElementChild as HTMLElement;
    expect(code.style.tabSize).toBe("4");
    expect(code).toHaveClass("whitespace-pre");
    expect(code.textContent).toBe("\tSELECT o.id, o.total_cents, COALESCE(SUM(r.amount_cents), 0) AS refunded_cents");
    // The line is as wide as its text (the file box scrolls), and its numbers stay at the left edge.
    expect(line).toHaveClass("w-max");
    expect(line.firstElementChild).toHaveClass("sticky", "left-0");
    expect(line.closest(".overflow-auto, .overflow-x-auto")).not.toBeNull();
  });

  it("wrap with a hanging indent under their own code", async () => {
    const user = userEvent.setup();
    const { container } = render(<TextDiffBlock path="internal/billing/refund.go" oldText={GO_BEFORE} newText={GO_AFTER} />);
    await user.click(screen.getByRole("button", { name: "Wrap" }));
    expect(screen.getByRole("button", { name: "Wrap" })).toHaveAttribute("aria-pressed", "true");
    const line = codeOf(container, "COALESCE");
    const code = line.lastElementChild as HTMLElement;
    const [indent, rest] = [...code.children] as HTMLElement[];
    // The leading tab keeps one tab stop (4 columns); the rest wraps in its own box beside it.
    expect(indent.textContent).toBe("\t");
    expect(indent.style.width).toBe("4ch");
    expect(rest).toHaveClass("whitespace-pre-wrap");
    expect(rest.textContent?.startsWith("SELECT")).toBe(true);
    expect(codeOf(container, "LEFT JOIN").querySelector<HTMLElement>("[style*='width']")!.style.width).toBe("8ch");
    localStorage.removeItem("yaah:diff-wrap");
  });

  it("measure indentation in columns, tabs to the next stop of 4", () => {
    expect(splitIndent("\tx")).toMatchObject({ indent: "\t", rest: "x", cols: 4 });
    expect(splitIndent("  \tx")).toMatchObject({ cols: 4 });
    expect(splitIndent("\t\t  y")).toMatchObject({ cols: 10, rest: "y" });
    expect(splitIndent("plain")).toMatchObject({ indent: "", cols: 0 });
    expect(parsePatch(GO_PATCH)[0].hunks[0].lines[1].text.startsWith("\t")).toBe(true);
  });
});
