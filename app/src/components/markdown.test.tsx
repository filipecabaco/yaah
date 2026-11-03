// Markdown drawn block by block must be exactly what one whole render draws, at
// every point of a streamed reply (code fences included), while only the last
// block is parsed again as text arrives.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown, WholeMarkdown } from "@/components/markdown";
import { splitBlocks } from "@/lib/markdown-blocks";

const html = (el: React.ReactElement) => {
  const { container, unmount } = render(el);
  const out = container.innerHTML;
  unmount();
  return out;
};
const same = (text: string) => expect(html(<Markdown>{text}</Markdown>)).toBe(html(<WholeMarkdown>{text}</WholeMarkdown>));

/** Markdown that is easy to split wrongly. */
const CORPUS: Record<string, string> = {
  paragraphs: "One.\n\nTwo, with **bold** and `code`.\n\n\n\nThree after several blank lines.",
  headings: "# Title\n\nIntro.\n\n## Section\n\nText\n===\n\nSetext above.",
  "loose list": "- one\n\n- two\n\n- three\n\nAfter the list.",
  "ordered list across blank lines": "1. first\n\n2. second\n\n3. third",
  "list item with a continuation paragraph": "- item\n\n  still the item\n\n- next\n\nOut.",
  "nested list": "- a\n  - a.1\n\n  - a.2\n- b",
  "fence with blank lines": "Before.\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nAfter.",
  "tilde fence holding backticks": "~~~md\n```\nnot closed here\n\n~~~\n\nDone.",
  "longer closing fence": "````\n```\ninner\n\n```\n````\n\nAfter.",
  "fence in a list item": "- step:\n\n  ```sh\n  run\n\n  more\n  ```\n\n- next",
  "indented code": "Para.\n\n    code line\n\n    more code\n\nPara.",
  table: "| a | b |\n|---|--:|\n| 1 | 2 |\n\nText.",
  blockquotes: "> one\n\n> two\n\nPlain.",
  "reference links": "See [the spec][spec].\n\nMore text.\n\n[spec]: https://agentclientprotocol.com",
  footnote: "A claim.[^1]\n\nMore.\n\n[^1]: The source.",
  "thematic breaks": "Above.\n\n---\n\n* * *\n\nBelow.",
  html: "<div>\n\nInside?\n\n</div>\n\nText.",
  "task list": "- [x] done\n\n- [ ] todo",
  "inline backticks in a fence-looking line": "```not a fence``` still text\n\nNext.",
};

describe("splitBlocks", () => {
  it("joins back into the text, every time", () => {
    for (const text of Object.values(CORPUS)) expect(splitBlocks(text).join("\n")).toBe(text);
  });

  it("splits at blank lines outside code fences", () => {
    expect(splitBlocks("a\n\nb\n\n```\nc\n\nd\n```\n\ne")).toEqual(["a", "\nb", "\n```\nc\n\nd\n```", "\ne"]);
  });

  it("keeps a list together across blank lines, and indented continuations with their item", () => {
    expect(splitBlocks(CORPUS["loose list"])).toEqual(["- one\n\n- two\n\n- three", "\nAfter the list."]);
    expect(splitBlocks(CORPUS["list item with a continuation paragraph"])).toEqual(["- item\n\n  still the item\n\n- next", "\nOut."]);
  });

  it("doesn't split a text with link definitions or footnotes (they apply to the whole text)", () => {
    expect(splitBlocks(CORPUS["reference links"])).toHaveLength(1);
    expect(splitBlocks(CORPUS.footnote)).toHaveLength(1);
  });
});

describe("<Markdown> block by block", () => {
  it.each(Object.entries(CORPUS))("draws %s exactly as a whole render does", (_, text) => same(text));

  it("is identical at every point of a streamed reply, with fences opening and closing across chunks", () => {
    const reply = [
      "## Findings",
      "",
      "The loop re-reads the ledger:",
      "",
      "```ts",
      "for (const l of lines) {",
      "",
      "  net += l.qty * l.unit;",
      "}",
      "```",
      "",
      "1. Read once.",
      "",
      "2. Cache the tax table.",
      "",
      "| file | change |",
      "|---|---|",
      "| invoice.ts | split |",
      "",
      "> Note: run the migration first.",
    ].join("\n");
    // Every 7 characters, as chunks would arrive; each prefix must match.
    for (let n = 1; n <= reply.length; n += 7) same(reply.slice(0, n));
    same(reply);
  });
});
