import { describe, expect, it } from "vitest";
import { cardKey, cardKeyLabel, cardMode } from "@/lib/tool-cards";

// Titles and kinds as recorded from real Claude Code runs (src/dev/fixtures).
const RECORDED: [title: string, kind: string, key: string][] = [
  ["ToolSearch", "other", "ToolSearch"],
  ["mcp__yaah-ui__ui_render", "other", "mcp__yaah-ui__ui_render"],
  ["mcp__yaah-ui__ui_set_values", "other", "mcp__yaah-ui__ui_set_values"],
  ["Write /Users/dev/workspace/api/hello.txt", "edit", "kind:edit"],
  ["Read /private/var/folders/s3/ylzj6pxd3_qc6l7sv2tthldm0000gn/T/yaah-pack-25f8a972", "read", "kind:read"],
  ["node --test --test-reporter=spec", "execute", "kind:execute"],
  ['git log --graph --all --format="%h%d %s (%an, %ar)"', "execute", "kind:execute"],
  ['git config --show-origin --get-regexp "log|alias|reverse"', "execute", "kind:execute"],
  ["Explain ACP", "think", "kind:think"],
  ["Load skill: dataviz", "other", "Load skill"],
];

describe("cardKey", () => {
  it.each(RECORDED)("%s (%s) → %s", (title, kind, key) => {
    expect(cardKey(title, kind)).toBe(key);
  });

  it("doesn't mistake a colon inside a command for a label", () => {
    expect(cardKey("curl -s http://127.0.0.1:8080/health", "execute")).toBe("kind:execute");
    expect(cardKey("echo a:b", "execute")).toBe("kind:execute");
    expect(cardKey("  ", null)).toBe("kind:other");
  });
});

describe("cardMode", () => {
  it("defaults to auto", () => {
    expect(cardMode({}, "kind:execute")).toBe("auto");
  });

  it("uses the exact rule, then the MCP server's rule", () => {
    const rules = { "kind:execute": "collapsed", mcp__github: "expanded", mcp__github__get_pr: "collapsed" } as const;
    expect(cardMode(rules, "kind:execute")).toBe("collapsed");
    expect(cardMode(rules, "mcp__github__list_prs")).toBe("expanded");
    expect(cardMode(rules, "mcp__github__get_pr")).toBe("collapsed");
    expect(cardMode(rules, "mcp__linear__issue")).toBe("auto");
  });
});

describe("cardKeyLabel", () => {
  it("reads as Settings shows it", () => {
    expect(cardKeyLabel("kind:execute")).toBe("Commands (any)");
    expect(cardKeyLabel("kind:weird")).toBe("weird (any)");
    expect(cardKeyLabel("mcp__github")).toBe("github (every tool of this MCP server)");
    expect(cardKeyLabel("mcp__github__get_pr")).toBe("mcp__github__get_pr");
    expect(cardKeyLabel("ToolSearch")).toBe("ToolSearch");
  });
});
