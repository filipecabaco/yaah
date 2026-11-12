import { describe, expect, it } from "vitest";
import { MCP_CATALOG, MCP_CATALOG_CATEGORIES, addedAs, catalogDraft, freeName } from "@/lib/mcp-catalog";

describe("MCP catalog", () => {
  it("has unique kebab-case ids, each a valid server name", () => {
    const ids = MCP_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(ids).not.toContain("yaah-ui");
  });

  it("has no two entries for the same server", () => {
    const targets = MCP_CATALOG.map((e) => e.draft.url ?? e.draft.commandLine);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("files every entry under a listed category", () => {
    for (const e of MCP_CATALOG) expect(MCP_CATALOG_CATEGORIES).toContain(e.category);
    for (const c of MCP_CATALOG_CATEGORIES) expect(MCP_CATALOG.some((e) => e.category === c)).toBe(true);
  });

  it("gives every entry something to connect to and a docs link", () => {
    for (const e of MCP_CATALOG) {
      if (e.draft.transport === "stdio") expect(e.draft.commandLine?.trim()).toBeTruthy();
      else expect(() => new URL(e.draft.url!)).not.toThrow();
      expect(e.docs).toMatch(/^https:\/\//);
      // Signing in through the browser only works for remote servers; keys need the hint.
      if (e.auth === "oauth") expect(e.draft.transport).toBe("http");
      if (e.auth === "token") expect(e.token?.hint).toBeTruthy();
    }
  });

  it("names a copy after the first free slot and spots one already added", () => {
    expect(freeName("stripe", ["stripe", "stripe-2"])).toBe("stripe-3");
    const stripe = MCP_CATALOG.find((e) => e.id === "stripe")!;
    expect(catalogDraft(stripe, "stripe-2")).toMatchObject({ name: "stripe-2", transport: "http", url: "https://mcp.stripe.com" });
    expect(addedAs(stripe, [{ name: "pay", transport: "http", url: "https://mcp.stripe.com/", commandLine: "" }])?.name).toBe("pay");
  });
});
