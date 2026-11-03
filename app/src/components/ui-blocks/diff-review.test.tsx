// The diff review as agents show it: the yaah pack's `diff-review` (git.diff
// live, from the browser mock's recorded sample) and the `diffreview` block on
// its own: moving through files and hunks, its actions, viewed ticks kept in the
// UI entry's draft, tabs when narrow, and a 50-file diff staying fast.
import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import component from "../../../src-tauri/components/diff-review.json";
import { installBrowserMock } from "@/dev/browser-mock";
import { sourceSamples } from "@/dev/mock/fixtures";
import { UiTree } from "@/components/ui-render";
import { ChatContext, onDraft, type Draft } from "@/components/chat-context";
import type { FormHost } from "@/components/ui-form-host";
import { reviewFiles } from "@/components/ui-blocks/diff-review-model";
import { asObj } from "@/lib/narrow";

const sample = asObj(sourceSamples["git.diff"]);
const chat = { sessionId: "s1", cwd: "/work/shop", busy: false };

function ipcCalls() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  return vi.spyOn(internals, "invoke");
}

/** Lay the review out at `width` px (happy-dom has no layout). */
function atWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height: 600,
    top: 0,
    left: 0,
    right: width,
    bottom: 600,
    x: 0,
    y: 0,
  } as DOMRect);
}

const edits: Record<string, unknown>[] = [];
/** A `diffreview` node in a chat, its viewed ticks in a draft that edits update (as the transcript entry does). */
function Stateful({ props, initial }: { props: Record<string, unknown>; initial: Record<string, unknown> }) {
  const [draft, setDraft] = useState(initial);
  const host: FormHost = {
    draft,
    onEdit: (changes) => {
      edits.push(changes);
      setDraft({ ...draft, ...changes });
      return Promise.resolve();
    },
  };
  return (
    <ChatContext.Provider value={chat}>
      <UiTree tree={{ type: "diffreview", props: { name: "viewed", ...props } }} props={{}} form={host} />
    </ChatContext.Provider>
  );
}

async function review(props: Record<string, unknown> = { text: sample.text, files: sample.files, range: sample.range, title: "Partial refunds" }) {
  const user = userEvent.setup();
  const view = render(<Stateful props={props} initial={{}} />);
  const root = await screen.findByLabelText(/^Review: |^Review changes$/);
  return { user, root, ...view };
}

/** Two Go files, the first with two hunks far apart. */
const TWO_HUNKS = `diff --git a/internal/billing/refund.go b/internal/billing/refund.go
--- a/internal/billing/refund.go
+++ b/internal/billing/refund.go
@@ -1,3 +1,3 @@
 package billing
-// Refund gives back the whole order.
+// Refund gives back the given items.
 import "context"
@@ -40,3 +40,4 @@ func Refund() {
 \tif err != nil {
+\t\treturn 0, ErrOverRefund
 \t}
diff --git a/internal/billing/refund_test.go b/internal/billing/refund_test.go
--- a/internal/billing/refund_test.go
+++ b/internal/billing/refund_test.go
@@ -1,2 +1,2 @@
 package billing
-// old
+// new
`;

const currentFile = () => screen.getByRole("navigation", { name: "Files" }).querySelector("[aria-current]")?.getAttribute("title");

beforeEach(() => {
  installBrowserMock({ delay: 0 });
  edits.length = 0;
  atWidth(1200);
});
afterEach(() => vi.restoreAllMocks());

describe("diff-review", () => {
  it("reads git.diff in the chat's folder and lists every file, binary and renamed too", async () => {
    const invoke = ipcCalls();
    render(
      <ChatContext.Provider value={chat}>
        <UiTree
          tree={{ type: "$component", name: "diff-review", props: { range: "main...HEAD", title: "Partial refunds" }, tree: component.tree }}
          props={{}}
        />
      </ChatContext.Provider>,
    );
    const nav = await screen.findByRole("navigation", { name: "Files" });
    expect(invoke.mock.calls.find(([cmd]) => cmd === "read_source")?.[1]).toEqual({
      source: { kind: "git.diff", range: "main...HEAD" },
      session: "s1",
    });
    const titles = [...nav.querySelectorAll("button[title]:not([aria-pressed])")].map((b) => b.getAttribute("title"));
    expect(titles).toEqual([
      "docs/billing/refunds.md",
      "internal/billing/refund.go",
      "internal/billing/refund_test.go",
      "scripts/old-migrate.sh",
      "web/public/receipt.png",
      "web/src/refund-form.tsx",
    ]);
    expect(screen.getByText(/6 files/)).toHaveTextContent("6 files · +38 −14 · 0 of 6 viewed");
    // The first file is a rename with one changed line.
    expect(screen.getByText("docs/refunds.md → docs/billing/refunds.md")).toBeInTheDocument();
    await userEvent.setup().click(within(nav).getByTitle("web/public/receipt.png"));
    expect(screen.getByText("Binary file: not shown.")).toBeInTheDocument();
  });

  it("moves through files with j/k and hunks with n/p, and Enter goes to the diff", async () => {
    const { user, root } = await review({ text: TWO_HUNKS, range: "HEAD" });
    root.focus();
    expect(currentFile()).toBe("internal/billing/refund.go");
    expect(screen.getByText("hunk 1 / 2")).toBeInTheDocument();
    const body = screen.getByLabelText("Diff of internal/billing/refund.go");
    const scrolls: number[] = [];
    body.scrollTo = ((o: ScrollToOptions) => scrolls.push(o.top ?? 0)) as typeof body.scrollTo;
    await user.keyboard("n");
    expect(screen.getByText("hunk 2 / 2")).toBeInTheDocument();
    expect(scrolls).toHaveLength(1);
    await user.keyboard("p");
    expect(screen.getByText("hunk 1 / 2")).toBeInTheDocument();
    await user.keyboard("j");
    expect(currentFile()).toBe("internal/billing/refund_test.go");
    expect(screen.queryByText(/hunk \d/)).toBeNull();
    await user.keyboard("j");
    expect(currentFile()).toBe("internal/billing/refund.go");
    await user.keyboard("k");
    expect(currentFile()).toBe("internal/billing/refund_test.go");
    await user.keyboard("{Enter}");
    expect(document.activeElement).toHaveAccessibleName("Diff of internal/billing/refund_test.go");
  });

  it("drafts questions and change requests into the composer, never sending", async () => {
    const drafts: Draft[] = [];
    const stop = onDraft((d) => drafts.push(d));
    const invoke = ipcCalls();
    const { user } = await review();
    await user.click(screen.getByTitle("internal/billing/refund.go"));
    await user.click(screen.getByRole("button", { name: "Ask about this file" }));
    expect(drafts.at(-1)).toEqual({
      text: "About @internal/billing/refund.go: ",
      mention: { label: "internal/billing/refund.go", path: "/work/shop/internal/billing/refund.go" },
    });
    // Per hunk: the mention, its lines and the hunk itself.
    const hunk = screen.getAllByRole("button", { name: "Ask to change or revert this" }).at(-1)!;
    await user.click(hunk);
    const text = drafts.at(-1)!.text;
    expect(text).toMatch(/^Please change or revert this in @internal\/billing\/refund\.go lines \d+–\d+:\n\n```diff\n@@ /);
    expect(text).toContain("+\tif items > total-refunded {");
    expect(invoke.mock.calls.some(([cmd]) => cmd === "send_prompt")).toBe(false);
    stop();
  });

  it("copies paths and hunks, and opens the file in the editor", async () => {
    const invoke = ipcCalls();
    // user-event stands in for the clipboard.
    const { user } = await review();
    await user.click(screen.getByTitle("web/src/refund-form.tsx"));
    await user.click(screen.getByRole("button", { name: "Copy path" }));
    expect(await navigator.clipboard.readText()).toBe("web/src/refund-form.tsx");
    await user.click(screen.getByRole("button", { name: "Copy hunk" }));
    expect(await navigator.clipboard.readText()).toMatch(/^@@ -1,10 \+1,17 @@[^\n]*\n import \{ useState \} from "react";\n/);
    await user.click(screen.getByRole("button", { name: "Open in editor" }));
    expect(invoke).toHaveBeenCalledWith("open_in_editor", { session: "s1", path: "web/src/refund-form.tsx" }, undefined);
    expect(await screen.findByRole("status")).toHaveTextContent("Opened refund-form.tsx");
    // A deleted file has nothing to open.
    await user.click(screen.getByTitle("scripts/old-migrate.sh"));
    expect(screen.getByRole("button", { name: "Open in editor" })).toBeDisabled();
  });

  it("keeps viewed ticks in the entry's draft, per range, until the file changes", async () => {
    const { user, root, rerender } = await review();
    root.focus();
    await user.keyboard("v");
    expect(screen.getByText(/of 6 viewed/)).toHaveTextContent("1 of 6 viewed");
    const saved = asObj(asObj(edits.at(-1)?.viewed)["main...HEAD"]);
    expect(Object.keys(saved)).toEqual(["docs/billing/refunds.md"]);
    await user.click(screen.getByRole("button", { name: "Mark viewed: scripts/old-migrate.sh" }));
    expect(screen.getByRole("button", { name: "Viewed: scripts/old-migrate.sh" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/of 6 viewed/)).toHaveTextContent("2 of 6 viewed");

    // A re-render (an agent update or a live refresh) starts from the draft.
    const draft = { viewed: edits.at(-1)!.viewed };
    rerender(<Stateful props={{ text: sample.text, files: sample.files, range: "main...HEAD" }} initial={draft} />);
    expect(screen.getByText(/of 6 viewed/)).toHaveTextContent("2 of 6 viewed");
    // Another range has its own ticks.
    rerender(<Stateful props={{ text: sample.text, files: sample.files, range: "HEAD" }} initial={draft} />);
    expect(screen.getByText(/of 6 viewed/)).toHaveTextContent("0 of 6 viewed");
    // The file changed since: no longer viewed, and marked as changed.
    const changed = (sample.text as string).replace("+A refund gives back the items asked for", "+A refund gives back what was asked for");
    rerender(<Stateful props={{ text: changed, files: sample.files, range: "main...HEAD" }} initial={draft} />);
    expect(screen.getByText(/of 6 viewed/)).toHaveTextContent("1 of 6 viewed");
    expect(screen.getByRole("button", { name: "Mark viewed: docs/billing/refunds.md" })).toHaveAttribute("title", "Changed since you viewed it");
  });

  it("shows files as tabs across the top when narrow", async () => {
    atWidth(600);
    const { user } = await review();
    const tabs = screen.getByRole("tablist", { name: "Files" });
    expect(screen.queryByRole("navigation", { name: "Files" })).toBeNull();
    expect(within(tabs).getAllByRole("tab")).toHaveLength(6);
    expect(within(tabs).getByRole("tab", { name: /refunds\.md/ })).toHaveAttribute("aria-selected", "true");
    await user.click(within(tabs).getByRole("tab", { name: /refund_test\.go/ }));
    expect(within(tabs).getByRole("tab", { name: /refund_test\.go/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Diff of internal/billing/refund_test.go")).toBeInTheDocument();
    // Short labels for the actions.
    expect(screen.getByRole("button", { name: "Ask about this file" })).toHaveTextContent(/^Ask$/);
  });

  it("stays fast on a 50-file diff: one file at a time, its rows windowed", async () => {
    const patch = Array.from({ length: 50 }, (_, f) => {
      const lines = Array.from({ length: 400 }, (_, i) => (i % 4 === 0 ? `+\tline ${i} of file ${f}` : ` \tline ${i} of file ${f}`));
      return `diff --git a/src/f${f}.go b/src/f${f}.go\n--- a/src/f${f}.go\n+++ b/src/f${f}.go\n@@ -1,300 +1,400 @@\n${lines.join("\n")}\n`;
    }).join("");
    const started = performance.now();
    const { user, root } = await review({ text: patch, range: "big" });
    const took = performance.now() - started;
    expect(screen.getByText(/50 files/)).toBeInTheDocument();
    const drawn = () => document.querySelectorAll("[data-rows] [data-line]").length;
    expect(drawn()).toBeGreaterThan(20);
    expect(drawn()).toBeLessThan(150);
    root.focus();
    const before = performance.now();
    for (let i = 0; i < 10; i++) await user.keyboard("j");
    expect(currentFile()).toBe("src/f10.go");
    expect(drawn()).toBeLessThan(150);
    // Generous bounds for a slow CI machine; drawing every row takes several times this.
    expect(took).toBeLessThan(3000);
    expect(performance.now() - before).toBeLessThan(3000);
  });

  it("says when the diff was cut, and which files it couldn't show", async () => {
    const files = [...(sample.files as unknown[]), { path: "z/later.go", status: "modified", additions: 3, deletions: 1, binary: false }];
    const { user } = await review({ text: sample.text, files, range: "main...HEAD", truncated: true });
    expect(screen.getByText(/over 4 MB and was cut/)).toBeInTheDocument();
    await user.click(screen.getByTitle("z/later.go"));
    expect(screen.getByText(/the diff was cut before this file/)).toBeInTheDocument();
    expect(reviewFiles("", []).length).toBe(0);
  });

  it("shows an empty diff as no changes", async () => {
    render(<UiTree tree={{ type: "diffreview", props: { text: "", files: [], range: "HEAD", title: "Uncommitted" } }} props={{}} />);
    expect(await screen.findByText(/No changes \(HEAD\)/)).toBeInTheDocument();
  });

  it("wraps on request, with the line's indentation kept as a hanging indent", async () => {
    const { user } = await review();
    await user.click(screen.getByTitle("internal/billing/refund.go"));
    await user.click(screen.getByRole("button", { name: "Wrap" }));
    const line = [...document.querySelectorAll<HTMLElement>("[data-line]")].find((l) => l.textContent?.includes("COALESCE((SELECT"))!;
    expect(line.querySelector<HTMLElement>("[style*='width']")!.style.width).toBe("4ch");
    expect(document.querySelector("[data-rows]")).toHaveAttribute("data-wrapped", "true");
    await user.click(screen.getByRole("button", { name: "Wrap" }));
    await waitFor(() => expect(document.querySelector("[data-rows]")).toHaveAttribute("data-wrapped", "false"));
  });
});
