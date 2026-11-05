// The user's own text is plain CommonMark/GFM: never read as MDX, never rewritten.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlainMarkdown } from "@/components/markdown";

const draw = (text: string) => render(<PlainMarkdown>{text}</PlainMarkdown>).container;

describe("PlainMarkdown (user messages)", () => {
  it("does not read frontmatter", () => {
    const c = draw("---\nfoo");
    expect(c.querySelector('[data-mdx="frontmatter"]')).toBeNull();
    expect(c).toHaveTextContent("foo");
  });
  it("leaves #123 as typed", () => {
    const c = draw("#123 fix");
    expect(c.querySelector("h1,h2,h3")).toBeNull();
    expect(c).toHaveTextContent("#123 fix");
  });
  it("shows <Foo> and raw HTML as text, never as elements", () => {
    const c = draw("<Foo>\n\n<script>alert(1)</script>");
    expect(c).toHaveTextContent("<Foo>");
    expect(c.querySelector("script")).toBeNull();
    expect(c).toHaveTextContent("<script>alert(1)</script>");
  });
  it("shows an import line as typed", () => {
    expect(draw('import x from "y"')).toHaveTextContent('import x from "y"');
  });
  it("still draws Markdown", () => {
    const c = draw("**bold** and `code`\n\n- one\n- two");
    expect(c.querySelector("strong")).toHaveTextContent("bold");
    expect(c.querySelectorAll("li")).toHaveLength(2);
  });
});
