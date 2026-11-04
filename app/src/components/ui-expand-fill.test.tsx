// Expanded UI fills the dialog: a block's main scroll area drops its inline cap and takes the height
// left (`flex-1 min-h-0`, marked `data-grow`), a node marked `"grow": true` does the same, and
// everything else stays at its natural size. Inline rendering keeps its caps. (happy-dom has no
// layout, so these are class assertions.)
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UiTree } from "@/components/ui-render";
import { UiViewContext } from "@/components/ui-view";

const LONG = Array.from({ length: 55 }, (_, i) => `line ${i + 1} of the file`).join("\n");
const MDX = `# Title\n\n${Array.from({ length: 55 }, (_, i) => `Paragraph ${i + 1}`).join("\n\n")}\n`;

/** Renders `tree`, once its (lazily loaded) blocks are in: `ready` is a selector that appears then. */
async function show(tree: unknown, expanded: boolean, ready = ".rounded-md, ul, p") {
  document.body.innerHTML = "";
  const { container } = render(
    <UiViewContext.Provider value={{ expanded }}>
      <UiTree tree={tree} props={{}} />
    </UiViewContext.Provider>,
  );
  await waitFor(() => expect(container.querySelector(ready)).not.toBeNull());
  return container;
}

const file = (text: string, path: string) => ({ type: "textfile", props: { text, path } });

describe("expanded UI fills the dialog", () => {
  it("lets a rendered .mdx file body grow, and keeps its cap inline", async () => {
    const inline = await show(file(MDX, "docs/guide.mdx"), false);
    expect(inline.querySelector("[data-grow]")).toBeNull();
    expect(inline.querySelector(".max-h-\\[560px\\]")).not.toBeNull();

    const big = await show(file(MDX, "docs/guide.mdx"), true);
    const body = big.querySelector<HTMLElement>("[data-grow]")!;
    expect(body.className).toContain("flex-1");
    expect(body.className).toContain("min-h-0");
    expect(body.className).toContain("max-h-none");
    expect(body.className).not.toContain("max-h-[560px]");
    // The root and the wrappers up to the body take the height down to it.
    expect(big.firstElementChild!.className).toContain("h-full");
    expect(big.firstElementChild!.className).toContain("has([data-grow])");
  });

  it("grows a plain file's line box and keeps its cap inline", async () => {
    const inline = await show(file(LONG, "a.txt"), false);
    expect(inline.querySelector(".max-h-\\[480px\\]")).not.toBeNull();
    expect(inline.querySelector("[data-grow]")).toBeNull();
    const big = await show(file(LONG, "a.txt"), true);
    const body = big.querySelector<HTMLElement>("[data-grow]")!;
    expect(body.className).toContain("flex-1");
    expect(body.className).not.toContain("max-h-[480px]");
    expect(body.querySelectorAll("[data-line]").length).toBe(55);
  });

  it("grows a json tree and a file tree", async () => {
    const big = await show(
      {
        type: "stack",
        children: [
          { type: "json", props: { value: { a: 1 } } },
          { type: "filetree", props: { paths: ["a/b.ts"] } },
        ],
      },
      true,
    );
    expect(big.querySelectorAll("[data-grow]").length).toBe(2);
  });

  it("opts a node in with grow: true, only while expanded", async () => {
    const tree = {
      type: "stack",
      children: [
        { type: "heading", props: { text: "Notes" } },
        { type: "list", grow: true, props: { items: ["one", "two"] } },
      ],
    };
    expect((await show(tree, false)).querySelector("[data-grow]")).toBeNull();
    const big = await show(tree, true);
    const grown = big.querySelector<HTMLElement>("[data-grow]")!;
    expect(grown.className).toContain("flex-1");
    expect(grown.className).toContain("overflow-auto");
    expect(grown.querySelector("ul")).not.toBeNull();
    // The heading is a sibling, not inside the growing region.
    expect(grown.textContent).not.toContain("Notes");
  });

  it("does not stretch a form or a card", async () => {
    const big = await show(
      {
        type: "card",
        props: { title: "Small" },
        children: [
          { type: "text", props: { text: "hello" } },
          { type: "stack", children: ["x"] },
        ],
      },
      true,
    );
    expect(big.querySelector("[data-grow]")).toBeNull();
  });
});
