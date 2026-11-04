// While a reply streams, only its last block is parsed again; reopening a chat
// reuses blocks parsed before. Counts react-markdown's parses (the one stand-in here).
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const parses = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("react-markdown", async (original) => {
  const real = await original<typeof import("react-markdown")>();
  const counted = (options: Parameters<typeof real.default>[0]) => {
    parses.texts.push(String(options.children));
    return real.default(options);
  };
  return { ...real, default: counted };
});
const { Markdown } = await import("@/components/markdown");

it("parses only the block that changed as text is appended", () => {
  const head = "## Plan\n\nFirst we read the ledger once.\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\n";
  const { rerender } = render(<Markdown>{head + "Then we"}</Markdown>);
  expect(parses.texts).toHaveLength(4);
  parses.texts.length = 0;
  rerender(<Markdown>{head + "Then we cache"}</Markdown>);
  rerender(<Markdown>{head + "Then we cache the tax table."}</Markdown>);
  expect(parses.texts).toEqual(["\nThen we cache", "\nThen we cache the tax table."]);
  // A new block starts: only it is parsed.
  parses.texts.length = 0;
  rerender(<Markdown>{head + "Then we cache the tax table.\n\n- one"}</Markdown>);
  expect(parses.texts).toEqual(["\n- one"]);
});

it("parses prose with stray < once: the compatibility pass escapes them, so nothing needs repairing", () => {
  parses.texts.length = 0;
  render(<Markdown>{"Vec<T> and <Enter> to go, if a<b then {c}, see <https://example.com>"}</Markdown>);
  expect(parses.texts).toHaveLength(1);
});

it("reuses parsed blocks when the same text is drawn again (a chat opened again)", () => {
  const text = "A reply that was drawn before.\n\nWith two blocks, one *emphasised*.";
  render(<Markdown>{text}</Markdown>).unmount();
  parses.texts.length = 0;
  const { container } = render(<Markdown>{text}</Markdown>);
  expect(parses.texts).toEqual([]);
  expect(container.querySelector("em")?.textContent).toBe("emphasised");
});

it("parses only the last block of a streamed MDX reply, keeping an open element's blocks together", () => {
  const head = '---\ntitle: Realtime\n---\n\nimport { Admonition } from "ui";\n\n<Admonition type="note">\n\nFirst.\n\n</Admonition>\n\n';
  const { rerender, container } = render(<Markdown>{head + "Next"}</Markdown>);
  expect(container.querySelector('[data-mdx="admonition"]')).toHaveTextContent("First.");
  parses.texts.length = 0;
  rerender(<Markdown>{head + "Next we"}</Markdown>);
  expect(parses.texts).toEqual(["\nNext we"]);
  // An element still open takes in the blocks after it, so it is parsed whole as it grows.
  parses.texts.length = 0;
  rerender(<Markdown>{head + "Next we\n\n<Tip>\n\nOne\n\nTwo"}</Markdown>);
  expect(parses.texts).toEqual(["\n<Tip>\n\nOne\n\nTwo\n</Tip>"]);
  expect(container.querySelector('[data-type="tip"]')).toHaveTextContent("One");
});
