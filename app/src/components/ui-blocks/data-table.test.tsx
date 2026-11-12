import { render, screen } from "@testing-library/react";
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
});
