// Runs of tool calls drawn as one row that opens to the cards (lib/tool-groups.ts, tool-group.tsx):
// what breaks a run, the call still going shown live, failures counted, open state kept.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "@/App";
import { installBrowserMock } from "@/dev/browser-mock";
import { api, type Entry } from "@/lib/api";
import { foldedPermissions } from "@/lib/permissions";
import { setCardRules } from "@/lib/tool-cards";
import { groupPreview, setGroupToolCalls, transcriptRows } from "@/lib/tool-groups";

type Status = "pending" | "in_progress" | "completed" | "failed";
const tool = (id: string, title = `Read ${id}.rs`, status: Status = "completed", more: Partial<Entry> = {}): Entry =>
  ({ type: "tool", toolCallId: id, title, kind: "read", status, content: [], locations: [], rawInput: null, ...more }) as Entry;
const user = (text = "go"): Entry => ({ type: "user", text, attachments: [] });
const agent = (text: string): Entry => ({ type: "agent", text, messageId: null });
const ui: Entry = {
  type: "ui",
  askId: null,
  answer: null,
  title: "Table",
  component: null,
  version: null,
  tree: { type: "Text", text: "hi" },
  props: {},
};
const ask = (id: string, chosen: string | null = null): Entry => ({
  type: "permission",
  requestId: 1,
  toolCallId: id,
  title: id,
  options: [{ optionId: "y", name: "Yes", kind: "allow_once" }],
  chosen,
  ...(chosen ? { answer: "allow_once" as const, auto: { reason: "readOnly", why: "read-only in this chat's folders" } } : {}),
});

const rowsOf = (entries: Entry[], group = true) =>
  transcriptRows(entries, 0, foldedPermissions(entries), group).map((r) => (r.kind === "entry" ? r.index : r.indices));

describe("which tool calls make a group", () => {
  it("two or more in a row; a single call isn't grouped", () => {
    expect(rowsOf([user(), tool("a"), tool("b"), tool("c")])).toEqual([0, [1, 2, 3]]);
    expect(rowsOf([user(), tool("a"), agent("then"), tool("b")])).toEqual([0, 1, 2, 3]);
    expect(rowsOf([user(), tool("a"), tool("b")], false)).toEqual([0, 1, 2]); // with the setting off, none
  });

  it("agent text, a user message, rendered UI and a waiting permission each end a run", () => {
    expect(rowsOf([tool("a"), tool("b"), agent("x"), tool("c"), tool("d")])).toEqual([[0, 1], 2, [3, 4]]);
    expect(rowsOf([tool("a"), tool("b"), user(), tool("c"), tool("d")])).toEqual([[0, 1], 2, [3, 4]]);
    expect(rowsOf([tool("a"), tool("b"), ui, tool("c")])).toEqual([[0, 1], 2, 3]);
    expect(rowsOf([tool("a"), tool("b"), ask("b"), tool("c")])).toEqual([[0, 1], 2, 3]); // the waiting request stays in sight
  });

  it("an allowed request folded into its card, or an empty text run, doesn't end a run", () => {
    expect(rowsOf([tool("a"), ask("a", "Yes"), tool("b"), agent(""), tool("c")])).toEqual([[0, 2, 4]]);
  });

  it("an edit with a diff to show stays out of groups", () => {
    const edit = tool("e", "Edit tax.ts", "completed", { kind: "edit", content: [{ type: "diff", path: "/x/tax.ts", oldText: "a", newText: "b" }] });
    expect(rowsOf([tool("a"), tool("b"), edit, tool("c"), tool("d")])).toEqual([[0, 1], 2, [3, 4]]);
  });

  it("previews the first few distinct names", () => {
    const tools = [
      tool("a", "Read a.rs"),
      tool("b", "Read b.rs"),
      tool("c", "grep -n x"),
      tool("d", "mcp__claude_ai_Linear__get_issue"),
      tool("e", "mcp.linear.list"),
    ];
    expect(groupPreview(tools as Extract<Entry, { type: "tool" }>[])).toBe("Read, grep, get_issue (Linear), …");
  });
});

/** A chat whose transcript is `entries`, opened in the App with grouping on. */
async function openChat(entries: Entry[], { running = false } = {}) {
  const mock = installBrowserMock({ delay: 0 });
  setCardRules({});
  setGroupToolCalls(true);
  const c = await api.newQuickChat("default");
  Object.assign(mock.sessions[c.sessionId], { title: "seeded chat", running });
  mock.transcripts[c.sessionId] = entries;
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "seeded chat" }));
  const log = await screen.findByRole("log", { name: "Conversation" });
  return { log, mock, sessionId: c.sessionId };
}

describe("a group in the transcript", () => {
  it("is one quiet row with the failures and auto-allowed counted, and opens to the cards", async () => {
    const u = userEvent.setup();
    const { log } = await openChat([
      user(),
      tool("a", "Read a.rs"),
      ask("a", "Yes"),
      tool("b", "grep -n round", "failed"),
      tool("c", "Read c.rs"),
      agent("Done."),
    ]);
    const row = await within(log).findByRole("button", { name: /^3 tool calls/ });
    expect(row).toHaveTextContent("Read, grep");
    expect(row).toHaveTextContent("· 1 failed");
    expect(row).toHaveTextContent("· 1 auto-allowed");
    expect(within(row).getByText("· 1 failed")).toHaveClass("text-destructive");
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(log).queryByText("Read a.rs")).toBeNull();

    await u.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(log).getByText("Read a.rs")).toBeInTheDocument();
    expect(within(log).getByText("grep -n round")).toBeInTheDocument();
    // The folded chip is still on the card inside.
    expect(within(log).getByText("Auto-allowed")).toBeInTheDocument();

    // The keyboard closes it again (stock Collapsible: Enter on the trigger).
    row.focus();
    await u.keyboard("{Enter}");
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(log).queryByText("Read a.rs")).toBeNull();
  });

  it("keeps the call still going in sight, live, under the row", async () => {
    const { log } = await openChat(
      [
        user(),
        tool("a", "Read a.rs"),
        tool("b", "Read b.rs"),
        tool("c", "cargo test", "in_progress", {
          kind: "execute",
          content: [{ type: "content", content: { type: "text", text: "running 12 tests" } }],
        }),
      ],
      { running: true },
    );
    const row = await within(log).findByRole("button", { name: /^3 tool calls/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(log).getByText("cargo test")).toBeInTheDocument();
    expect(within(log).getByText("running 12 tests")).toBeInTheDocument();
    expect(within(log).queryByText("Read a.rs")).toBeNull();
  });

  it("stays open as the user left it when the chat is opened again", async () => {
    const u = userEvent.setup();
    const { log } = await openChat([user(), tool("a"), tool("b")]);
    await u.click(await within(log).findByRole("button", { name: /^2 tool calls/ }));
    // Away to Settings and back: the group is drawn again, still open.
    await u.click(screen.getByRole("button", { name: /^settings/i }));
    await u.keyboard("{Escape}");
    await waitFor(() =>
      expect(within(screen.getByRole("log", { name: "Conversation" })).getByRole("button", { name: /^2 tool calls/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
  });

  it("draws an old transcript the same way", async () => {
    // Saved by an earlier build: permissions without `answer`, tools as they were.
    const old = (id: string): Entry => ({
      type: "permission",
      requestId: 1,
      toolCallId: id,
      title: id,
      options: [{ optionId: "y", name: "Yes", kind: "allow_once" }],
      chosen: "Yes",
    });
    const { log } = await openChat([user(), tool("a"), old("a"), tool("b"), old("b"), tool("c"), agent("ok")]);
    expect(await within(log).findByRole("button", { name: /^3 tool calls/ })).toBeInTheDocument();
    expect(within(log).queryByRole("group", { name: /^Permission/ })).toBeNull();
  });

  it("can be turned off in Settings → Chat", async () => {
    const u = userEvent.setup();
    const { log, mock } = await openChat([user(), tool("a", "Read a.rs"), tool("b", "Read b.rs")]);
    await within(log).findByRole("button", { name: /^2 tool calls/ });
    await u.click(screen.getByRole("button", { name: /^settings/i }));
    const dialog = await screen.findByRole("dialog");
    await u.click(within(dialog).getByRole("tab", { name: "Chat" }));
    const grouping = await within(dialog).findByRole("switch", { name: "Group consecutive tool calls" });
    await waitFor(() => expect(grouping).toBeChecked());
    await u.click(grouping);
    await waitFor(() => expect(mock.groupToolCalls).toBe(false));
    await u.keyboard("{Escape}");
    expect(await within(log).findByText("Read a.rs")).toBeInTheDocument();
    expect(within(log).queryByRole("button", { name: /^2 tool calls/ })).toBeNull();
  });
});
