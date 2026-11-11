// Resizable table columns (hooks/use-column-resize.ts) in a Markdown table: dragging or arrowing a header
// edge fixes the layout, a double-click gives it back to the browser.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/markdown";

const TABLE = "| name | note |\n|---|---|\n| a | first |\n| b | second |";

function table() {
  render(<Markdown>{TABLE}</Markdown>);
  return document.querySelector("table")!;
}

describe("Markdown tables", () => {
  it("scroll in their own box and have a resize handle on every header cell", () => {
    const t = table();
    expect(t.closest("[data-md-table]")).not.toBeNull();
    expect(screen.getAllByRole("separator", { name: /Resize column/ })).toHaveLength(2);
    expect(t).not.toHaveAttribute("data-fixed");
  });

  it("fix their layout when an edge is dragged, and go back on a double-click", () => {
    const t = table();
    const [first] = screen.getAllByRole("separator");
    fireEvent.pointerDown(first, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 220 });
    fireEvent.pointerUp(window, { clientX: 220 });
    expect(t).toHaveAttribute("data-fixed");
    expect(t.style.tableLayout).toBe("fixed");
    fireEvent.doubleClick(first);
    expect(t).not.toHaveAttribute("data-fixed");
  });

  it("move an edge with the arrow keys, and never below a minimum width", () => {
    const t = table();
    const [first] = screen.getAllByRole("separator");
    fireEvent.keyDown(first, { key: "ArrowLeft", shiftKey: true });
    expect(t).toHaveAttribute("data-fixed");
    expect(t.querySelector("th")!.style.width).toBe("48px");
  });
});

describe("the table primitive", () => {
  it("has the same resize handles, and keeps sorting on its header buttons", async () => {
    const { default: UiDataTable } = await import("@/components/ui-blocks/data-table");
    render(
      <UiDataTable
        columns={["name", "count"]}
        rows={[
          { name: "a", count: 1 },
          { name: "b", count: 2 },
        ]}
      />,
    );
    const handles = screen.getAllByRole("separator", { name: /Resize/ });
    expect(handles).toHaveLength(2);
    fireEvent.keyDown(handles[0], { key: "ArrowRight" });
    expect(screen.getByRole("table")).toHaveStyle({ tableLayout: "fixed" });
    fireEvent.doubleClick(handles[0]);
    expect(screen.getByRole("table").style.tableLayout).toBe("");
    expect(screen.getByRole("button", { name: /name/ })).toBeInTheDocument();
  });
});
