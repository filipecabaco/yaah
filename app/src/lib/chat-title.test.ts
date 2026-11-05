import { describe, expect, it } from "vitest";
import { displayTitle } from "@/lib/chat-title";

describe("displayTitle", () => {
  it("strips basic Markdown markers", () => {
    expect(displayTitle("## Fix **the** `bug` in [docs](https://x.y)")).toBe("Fix the bug in docs");
    expect(displayTitle("_soft_ and ~~old~~ news")).toBe("soft and old news");
  });
  it("keeps plain text, snake_case and #123 as typed", () => {
    expect(displayTitle("rename my_var_name and 2*3*4")).toBe("rename my_var_name and 2*3*4");
    expect(displayTitle("#123 fix")).toBe("#123 fix");
  });
});
