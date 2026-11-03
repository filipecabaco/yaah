// Mermaid drawings are kept by (theme, text): the same diagram is drawn once,
// a theme change draws it again, and the oldest go first.
import { describe, expect, it } from "vitest";
import { DiagramCache } from "@/components/ui-blocks/diagram-cache";

function counting() {
  const calls: { id: string; text: string; theme: string }[] = [];
  const cache = new DiagramCache(async (id, text, theme) => {
    calls.push({ id, text, theme });
    await new Promise((r) => setTimeout(r, 1));
    if (text.includes("oops")) throw new Error("Parse error on line 1");
    return `<svg id="${id}">${theme}:${text}</svg>`;
  }, 3);
  return { cache, calls };
}

describe("DiagramCache", () => {
  it("draws a (theme, text) once, and hands back the same drawing after", async () => {
    const { cache, calls } = counting();
    expect(cache.peek("neutral", "graph LR; a-->b")).toBeUndefined();
    const first = await cache.get("neutral", "graph LR; a-->b");
    expect(await cache.get("neutral", "graph LR; a-->b")).toBe(first);
    expect(cache.peek("neutral", "graph LR; a-->b")).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("draws the same text again for another theme", async () => {
    const { cache, calls } = counting();
    await cache.get("neutral", "graph LR; a-->b");
    const dark = await cache.get("dark", "graph LR; a-->b");
    expect(dark).toEqual({ svg: '<svg id="mermaid-2">dark:graph LR; a-->b</svg>' });
    expect(calls.map((c) => c.theme)).toEqual(["neutral", "dark"]);
  });

  it("draws once when several diagrams ask for the same one at the same time", async () => {
    const { cache, calls } = counting();
    const all = await Promise.all([1, 2, 3].map(() => cache.get("neutral", "graph TD; x")));
    expect(new Set(all).size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("keeps failures too (the same text fails the same way)", async () => {
    const { cache, calls } = counting();
    expect(await cache.get("neutral", "oops")).toEqual({ error: "Parse error on line 1" });
    expect(cache.peek("neutral", "oops")).toEqual({ error: "Parse error on line 1" });
    expect(calls).toHaveLength(1);
  });

  it("forgets the least recently used past its size", async () => {
    const { cache, calls } = counting();
    for (const t of ["a", "b", "c"]) await cache.get("neutral", t);
    // "a" is used again, so "b" is the oldest when "d" comes in.
    await cache.get("neutral", "a");
    await cache.get("neutral", "d");
    expect(cache.size).toBe(3);
    expect(cache.peek("neutral", "b")).toBeUndefined();
    expect(cache.peek("neutral", "a")).toBeDefined();
    await cache.get("neutral", "b");
    expect(calls.map((c) => c.text)).toEqual(["a", "b", "c", "d", "b"]);
  });
});
