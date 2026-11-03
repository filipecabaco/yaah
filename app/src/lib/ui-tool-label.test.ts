import { describe, expect, it } from "vitest";
import { uiToolLabel } from "@/lib/ui-tool-label";

describe("how chat cards name yaah's UI tools", () => {
  it("says the UI is assembling while the call runs, then takes its title or component", () => {
    expect(uiToolLabel("mcp__yaah-ui__ui_render", "in_progress", { title: "Deploys" })).toEqual({ text: "Assembling UI", busy: true });
    expect(uiToolLabel("mcp__yaah-ui__ui_render", "pending", {})).toEqual({ text: "Assembling UI", busy: true });
    expect(uiToolLabel("mcp__yaah-ui__ui_render", "completed", { title: "Deploys", component: "x" })?.text).toBe("Deploys");
    expect(uiToolLabel("mcp__yaah-ui__ui_render", "completed", { component: "pr-view" })?.text).toBe("pr-view");
    expect(uiToolLabel("mcp__yaah-ui__ui_render", "completed", { title: "  " })?.text).toBe("Rendered UI");
    expect(uiToolLabel("mcp__yaah-ui__ui_ask", "completed", null)?.text).toBe("Asked with UI");
    expect(uiToolLabel("mcp__yaah-ui__ui_render", "failed", {})).toEqual({ text: "Couldn't build the UI", busy: false });
  });

  it("says a component is being stored, then that it was (or wasn't)", () => {
    expect(uiToolLabel("mcp__yaah-ui__ui_save_component", "in_progress", { name: "deploy-card" })).toEqual({
      text: "Storing deploy-card",
      busy: true,
    });
    expect(uiToolLabel("mcp__yaah-ui__ui_save_component", "completed", { name: "deploy-card" })?.text).toBe("Stored deploy-card");
    expect(uiToolLabel("mcp__yaah-ui__ui_save_component", "failed", { name: "deploy-card" })?.text).toBe("Couldn't store deploy-card");
  });

  it("leaves every other tool alone", () => {
    expect(uiToolLabel("mcp__yaah-ui__ui_catalog", "in_progress", {})).toBeNull();
    expect(uiToolLabel("mcp__vitro__click", "in_progress", {})).toBeNull();
    expect(uiToolLabel("Read file", "completed", {})).toBeNull();
  });
});
