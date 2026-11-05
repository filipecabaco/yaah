import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CodeBlock } from "@/components/code-block";
import { TranscriptEntry } from "@/components/entries";
import { canHighlight, highlightTokens, MAX_HIGHLIGHT_BYTES, MAX_HIGHLIGHT_LINES } from "@/lib/highlight";
import type { Entry } from "@/lib/api";
import userEvent from "@testing-library/user-event";

const tokens = (el: HTMLElement) => el.querySelectorAll("span.hl");

describe("CodeBlock", () => {
  it("highlights by path, with a gutter that is not part of the code", async () => {
    const { container } = render(<CodeBlock text={"const a = 1;\nlet b = 2;"} path="/x/a.ts" lineNumbers start={10} />);
    await waitFor(() => expect(tokens(container).length).toBeGreaterThan(2));
    const code = container.querySelector("code")!;
    expect(code.textContent).toBe("const a = 1;\nlet b = 2;");
    const gutter = container.querySelector("[data-gutter]")!;
    expect(gutter.textContent).toBe("10\n11");
    expect(gutter).toHaveAttribute("aria-hidden", "true");
    expect(gutter.className).toContain("select-none");
    expect(container.querySelector("pre")).toHaveAttribute("data-layout", "code");
    expect(container.querySelector("span.hl")).toHaveAttribute("style", expect.stringContaining("--shiki-light"));
  });

  it("strips a file read's numbers into the gutter and keeps the offset", async () => {
    const { container } = render(<CodeBlock text={"   41\tfn a() {}\n   42\t}\n"} path="a.rs" />);
    await waitFor(() => expect(tokens(container).length).toBeGreaterThan(0));
    expect(container.querySelector("code")!.textContent).toBe("fn a() {}\n}");
    expect(container.querySelector("[data-gutter]")!.textContent).toBe("41\n42");
  });

  it("stays plain for an unknown extension", () => {
    const { container } = render(<CodeBlock text="hello world" path="notes.zzz" />);
    expect(container.querySelector("pre")!.textContent).toBe("hello world");
    expect(tokens(container).length).toBe(0);
    expect(container.querySelector("[data-gutter]")).toBeNull();
  });

  it("stays plain for huge input", async () => {
    const big = "a".repeat(MAX_HIGHLIGHT_BYTES + 1);
    expect(canHighlight(big)).toBe(false);
    expect(canHighlight("x\n".repeat(MAX_HIGHLIGHT_LINES + 1))).toBe(false);
    expect(await highlightTokens(big, "typescript")).toBeNull();
    const { container } = render(<CodeBlock text={big} path="a.ts" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(tokens(container).length).toBe(0);
  });

  it("tokenizes in slices without changing the result", async () => {
    const src = Array.from({ length: 900 }, (_, i) => `const v${i} = \`x${i}\`; /* c */`).join("\n");
    const out = await highlightTokens(src, "typescript");
    expect(out).toHaveLength(900);
    expect(out![899].map((t) => t.content).join("")).toBe("const v899 = `x899`; /* c */");
  });
});

describe("a Read card", () => {
  it("shows highlighted code with the numbers beside it", async () => {
    const entry: Entry = {
      type: "tool",
      toolCallId: "r1",
      title: "Read composer-mode.test.tsx",
      kind: "read",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: '     1\t// The composer\n     2\timport { a } from "b";\n' } }],
      locations: [{ path: "/p/composer-mode.test.tsx" }],
      rawInput: { file_path: "/p/composer-mode.test.tsx" },
    };
    const user = userEvent.setup();
    const { container } = render(<TranscriptEntry entry={entry} index={0} inTurn={false} live={false} onLogin={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Read composer-mode/ }));
    await waitFor(() => expect(tokens(container).length).toBeGreaterThan(3));
    expect(container.querySelector("code")!.textContent).toBe('// The composer\nimport { a } from "b";');
    expect(container.querySelector("[data-gutter]")!.textContent).toBe("1\n2");
  });
});
