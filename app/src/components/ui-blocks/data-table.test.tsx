import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import UiDataTable from "@/components/ui-blocks/data-table";

describe("table primitive", () => {
  it("takes rows as arrays in column order, as well as objects", () => {
    render(<UiDataTable columns={["Server", "Endpoint"]} rows={[["Zapier", "mcp.zapier.com"], { Server: "Miro", Endpoint: "mcp.miro.com" }]} />);
    expect(screen.getByRole("cell", { name: "Zapier" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "mcp.zapier.com" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Miro" })).toBeInTheDocument();
    expect(screen.queryByText("Nothing to show")).toBeNull();
  });

  // 30 services, n = 1..30: past 8 rows there's a filter box, past 25 a second page.
  const services = Array.from({ length: 30 }, (_, i) => ({ name: `service-${String(i + 1).padStart(2, "0")}`, n: i + 1 }));
  const firstColumn = () =>
    within(screen.getAllByRole("rowgroup")[1])
      .getAllByRole("row")
      .map((r) => within(r).getAllByRole("cell")[0].textContent);

  it("pages past 25 rows", () => {
    render(<UiDataTable columns={["name", "n"]} rows={services} />);
    expect(firstColumn()).toHaveLength(25);
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(firstColumn()).toEqual(["service-26", "service-27", "service-28", "service-29", "service-30"]);
  });

  it("filters rows across every column", () => {
    render(<UiDataTable columns={["name", "n"]} rows={services} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter rows" }), { target: { value: "service-1" } });
    expect(firstColumn()).toEqual([
      "service-10",
      "service-11",
      "service-12",
      "service-13",
      "service-14",
      "service-15",
      "service-16",
      "service-17",
      "service-18",
      "service-19",
    ]);
    expect(screen.getByText("10 of 30 rows")).toBeInTheDocument();
  });

  it("sorts numbers as numbers, both ways", () => {
    render(<UiDataTable columns={["name", "n"]} rows={services.slice(0, 12)} />);
    const header = screen.getAllByRole("columnheader")[1];
    fireEvent.click(within(header).getByRole("button"));
    const first = header.getAttribute("aria-sort");
    const once = firstColumn();
    fireEvent.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).not.toBe(first);
    expect(firstColumn()).toEqual([...once].reverse());
    expect([once[0], once[11]].sort()).toEqual(["service-01", "service-12"]);
  });
});
