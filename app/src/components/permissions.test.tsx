// Permission requests in the transcript (session/permissions.rs decides, this draws): an allowed
// one folds into its tool card as a chip, a pending one keeps its card, a denied one a compact
// line; MCP servers can be trusted from the card and untrusted from the chat and the project.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "@/App";
import { ChatContext } from "@/components/chat-context";
import { PermissionCard } from "@/components/permission-dock";
import { installBrowserMock } from "@/dev/browser-mock";
import { api, type Entry, type PermissionOption } from "@/lib/api";
import { foldedPermissions, permissionChip } from "@/lib/permissions";
import { setCardRules } from "@/lib/tool-cards";
import { setGroupToolCalls } from "@/lib/tool-groups";
import { renderApp, sendInQuickChat } from "@/test/app";

type Request = Extract<Entry, { type: "permission" }>;
const options: PermissionOption[] = [
  { optionId: "y", name: "Yes", kind: "allow_once" },
  { optionId: "a", name: "Yes, and don't ask again", kind: "allow_always" },
  { optionId: "n", name: "No", kind: "reject_once" },
];
const tool = (id: string, title: string): Entry => ({
  type: "tool",
  toolCallId: id,
  title,
  kind: "read",
  status: "completed",
  content: [],
  locations: [],
  rawInput: null,
});
const permission = (id: string | null, title: string, more: Partial<Extract<Entry, { type: "permission" }>> = {}): Entry => ({
  type: "permission",
  requestId: 1,
  toolCallId: id,
  title,
  options,
  chosen: null,
  ...more,
});

/** A chat whose transcript is `entries` (as Rust has it on disk), opened in the App. */
async function openChat(entries: Entry[]) {
  const mock = installBrowserMock({ delay: 0 });
  setCardRules({});
  setGroupToolCalls(false);
  const c = await api.newQuickChat("default");
  Object.assign(mock.sessions[c.sessionId], { title: "seeded chat" });
  mock.transcripts[c.sessionId] = entries;
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "seeded chat" }));
  const log = await screen.findByRole("log", { name: "Conversation" });
  await waitFor(() => expect(within(log).queryByText("Loading…")).toBeNull());
  return { mock, log };
}

/** The tool card whose title is `title`. */
const cardOf = (log: HTMLElement, title: string) =>
  [...log.querySelectorAll("button span[title]")].find((s) => s.getAttribute("title") === title)?.closest("button") as HTMLElement;

describe("an answered permission request", () => {
  it("folds into its tool card as a chip: Allowed, Always allowed or Auto-allowed with the reason", async () => {
    const { log } = await openChat([
      { type: "user", text: "go", attachments: [] },
      tool("t1", "Read a.rs"),
      permission("t1", "Read a.rs", { chosen: "Yes", answer: "allow_once" }),
      tool("t2", "Read b.rs"),
      permission("t2", "Read b.rs", { chosen: "Yes, and don't ask again", answer: "allow_always" }),
      tool("t3", "Read c.rs"),
      permission("t3", "Read c.rs", { chosen: "Yes", answer: "allow_once", auto: { reason: "readOnly", why: "read-only in this chat's folders" } }),
      tool("t4", "mcp__claude_ai_Linear__get_issue"),
      permission("t4", "mcp__claude_ai_Linear__get_issue", {
        chosen: "Yes",
        answer: "allow_once",
        auto: { reason: "trustedServer", why: "trusted in this project: Linear" },
      }),
      tool("t5", "Run ls"),
      permission("t5", "Run ls", {
        chosen: "Yes (you said don't ask again)",
        answer: "allow_once",
        auto: { reason: "remembered", why: "you said don't ask again in this chat" },
      }),
    ]);
    expect(within(log).queryByRole("group", { name: /^Permission/ })).toBeNull();
    expect(within(cardOf(log, "Read a.rs")).getByText("Allowed")).toBeInTheDocument();
    expect(within(cardOf(log, "Read b.rs")).getByText("Always allowed")).toBeInTheDocument();
    const read = cardOf(log, "Read c.rs");
    expect(within(read).getByText("Auto-allowed")).toBeInTheDocument();
    expect(read).toHaveTextContent("read-only in this chat's folders");
    const linear = cardOf(log, "mcp__claude_ai_Linear__get_issue");
    expect(within(linear).getByText("Auto-allowed")).toBeInTheDocument();
    expect(linear).toHaveTextContent("trusted in this project: Linear");
    const ls = cardOf(log, "Run ls");
    expect(within(ls).getByText("Always allowed")).toBeInTheDocument();
    expect(ls).toHaveTextContent("you said don't ask again in this chat");
  });

  it("marks a built-in read-only command as always allowed, with its reason, on the tool card", async () => {
    const { log } = await openChat([
      { type: "user", text: "go", attachments: [] },
      tool("t1", "git status"),
      permission("t1", "git status", {
        chosen: "Yes",
        answer: "allow_once",
        auto: { reason: "builtinReadOnly", why: "built-in: read-only command" },
      }),
    ]);
    const card = cardOf(log, "git status");
    expect(within(card).getByText("Always allowed (built-in: read-only)")).toBeInTheDocument();
    expect(card).toHaveTextContent("built-in: read-only command");
  });

  it("keeps a pending request whole, a denied or cancelled one as a compact line, and one with no tool card", async () => {
    const { log } = await openChat([
      { type: "user", text: "go", attachments: [] },
      tool("t1", "Write x"),
      permission("t1", "Write x"),
      tool("t2", "rm -rf build"),
      permission("t2", "rm -rf build", { chosen: "No", answer: "reject_once" }),
      tool("t3", "Deploy"),
      permission("t3", "Deploy", { chosen: "cancelled", answer: "cancelled" }),
      permission(null, "Something without a card", { chosen: "Yes", answer: "allow_once" }),
    ]);
    const pending = screen.getByRole("group", { name: "Permission requested" });
    expect(within(pending).getByRole("button", { name: "Yes" })).toBeEnabled();
    expect(within(pending).getByRole("button", { name: "No" })).toBeEnabled();
    expect(within(log).getByRole("group", { name: "Permission denied" })).toHaveTextContent("rm -rf build");
    expect(within(log).getByRole("group", { name: "Permission cancelled" })).toHaveTextContent("Deploy");
    expect(within(log).getByRole("group", { name: "Permission allowed" })).toHaveTextContent("Something without a card");
    // A denial puts no chip on its card.
    expect(within(cardOf(log, "rm -rf build")).queryByText(/allowed/i)).toBeNull();
  });

  it("shows a shell request's description and its full command, a step per line", async () => {
    const command = "cd app && pnpm build; echo rc=$?";
    await openChat([
      { type: "user", text: "go", attachments: [] },
      { ...tool("t1", command), kind: "execute", status: "pending", rawInput: { command, description: "Build the app" } } as Entry,
      permission("t1", command),
    ]);
    const pending = screen.getByRole("group", { name: "Permission requested" });
    expect(pending).toHaveTextContent("Build the app");
    const block = pending.querySelector('[data-slot="command"]');
    expect(block?.textContent).toBe("cd app &&\npnpm build;\necho rc=$?");
    expect(block).toHaveClass("whitespace-pre-wrap", "overflow-x-auto");
    expect(block).not.toHaveClass("truncate");
  });

  it("folds the same way in a transcript saved before answers were recorded", async () => {
    const old = (id: string, chosen: string) => ({ type: "permission", requestId: 1, toolCallId: id, title: id, options, chosen }) as Entry;
    const { log } = await openChat([
      { type: "user", text: "go", attachments: [] },
      tool("a", "Read old.rs"),
      old("a", "Yes"),
      tool("b", "Run make"),
      old("b", "Yes, and don't ask again (you said don't ask again)"),
      tool("c", "Run rm"),
      old("c", "No"),
    ]);
    expect(within(cardOf(log, "Read old.rs")).getByText("Allowed")).toBeInTheDocument();
    expect(within(cardOf(log, "Run make")).getByText("Always allowed")).toBeInTheDocument();
    expect(within(log).getByRole("group", { name: "Permission denied" })).toBeInTheDocument();
    expect(within(log).getAllByRole("group", { name: /^Permission/ })).toHaveLength(1);
  });

  it("is read the same by the helpers", () => {
    const entries = [tool("a", "x"), permission("a", "x", { chosen: "Yes" }), permission("b", "y", { chosen: "Yes" })];
    expect([...foldedPermissions(entries).keys()]).toEqual(["a"]);
    const e = entries[1] as Extract<Entry, { type: "permission" }>;
    expect(permissionChip(e)).toEqual({ label: "Allowed" });
    expect(permissionChip({ ...e, chosen: "Renamed since" })).toBeNull();
    expect(permissionChip({ ...e, chosen: null })).toBeNull();
  });
});

describe("trusting an MCP server", () => {
  it("is offered on a pending MCP request, says it covers every tool, and answers that server's requests", async () => {
    const { user, mock } = renderApp();
    const log = await sendInQuickChat(user, "triage ENG-142");
    const asked = await screen.findByRole("group", { name: "Permission requested" });
    expect(asked).toHaveTextContent("mcp__claude_ai_Linear__get_issue");
    // A quick chat: its scopes are quick chats (one scope for all of them) and all chats.
    const scopes = await within(asked).findByRole("group", { name: "Always allow tools from Linear" });
    expect(
      within(scopes)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["In quick chats", "In all chats"]);
    const trust = within(scopes).getByRole("button", { name: "Always allow tools from Linear in quick chats" });
    expect(asked).toHaveTextContent("Covers every Linear tool, including ones that change things");
    await user.click(trust);

    // The request folds into its card; Linear's next one is answered without asking.
    await waitFor(() => expect(cardOf(log, "mcp__claude_ai_Linear__list_comments")).toBeTruthy());
    expect(within(cardOf(log, "mcp__claude_ai_Linear__get_issue")).getByText("Auto-allowed")).toBeInTheDocument();
    await waitFor(() => expect(within(cardOf(log, "mcp__claude_ai_Linear__list_comments")).getByText("Auto-allowed")).toBeInTheDocument());
    // Reads inside the chat's folders were auto-allowed; the `rm` still asks, and stays visible once denied.
    const rm = await screen.findByRole("group", { name: "Permission requested" });
    expect(rm).toHaveTextContent("rm -rf build");
    expect(within(rm).queryByRole("button", { name: /Always allow tools from/ })).toBeNull();
    await user.click(within(rm).getByRole("button", { name: "No" }));
    expect(await within(log).findByRole("group", { name: "Permission denied" })).toHaveTextContent("rm -rf build");

    const sessionId = Object.keys(mock.sessions)[0];
    expect(mock.quickTrusted).toEqual(["claude_ai_Linear"]);
    expect(mock.sessions[sessionId].trustedMcpServers ?? []).toEqual([]);
    // The chat's header lists it, in quick chats, with a way to stop trusting it.
    await user.click(await screen.findByRole("button", { name: "1 trusted MCP server in quick chats" }));
    expect(await screen.findByText(/run without asking in quick chats/)).toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "Stop trusting claude_ai_Linear in quick chats" }));
    await waitFor(() => expect(mock.quickTrusted).toEqual([]));
    await waitFor(() => expect(screen.queryByRole("button", { name: /trusted MCP server/ })).toBeNull());
  });

  it("offers this chat, this project and all chats in a project chat, and all chats in a chat of its own", async () => {
    const mock = installBrowserMock({ delay: 0 });
    const entry = permission("t", "mcp__claude_ai_Linear__get_issue", { mcpServer: { id: "claude_ai_Linear", label: "Linear" } }) as Request;
    const inProject = await api.newSession(mock.projects[0].id, "default");
    const { unmount } = render(
      <ChatContext.Provider value={{ sessionId: inProject.sessionId, cwd: inProject.cwd, busy: true, inProject: true }}>
        <PermissionCard entry={entry} index={0} agent={null} />
      </ChatContext.Provider>,
    );
    const scopes = await screen.findByRole("group", { name: "Always allow tools from Linear" });
    expect(
      within(scopes)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Always allow tools from Linear in this chat",
      "Always allow tools from Linear in this project",
      "Always allow tools from Linear in all chats",
    ]);
    unmount();
    const own = await api.newQuickChat("default", "/Users/dev/workspace/api");
    render(
      <ChatContext.Provider value={{ sessionId: own.sessionId, cwd: own.cwd, busy: true }}>
        <PermissionCard entry={entry} index={0} agent={null} />
      </ChatContext.Provider>,
    );
    const ownScopes = await screen.findByRole("group", { name: "Always allow tools from Linear" });
    expect(
      within(ownScopes)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["In this chat", "In all chats"]);
  });

  it("in all chats: Settings lists it, and Remove stops it", async () => {
    const { user, mock } = renderApp();
    const log = await sendInQuickChat(user, "triage ENG-142");
    const asked = await screen.findByRole("group", { name: "Permission requested" });
    await user.click(await within(asked).findByRole("button", { name: "Always allow tools from Linear in all chats" }));
    await waitFor(() => expect(mock.trustedEverywhere).toEqual(["claude_ai_Linear"]));
    await waitFor(() => expect(within(cardOf(log, "mcp__claude_ai_Linear__get_issue")).getByText("Auto-allowed")).toBeInTheDocument());
    expect(cardOf(log, "mcp__claude_ai_Linear__get_issue")).toHaveTextContent("trusted in all chats: Linear");
    // The header says where.
    await user.click(await screen.findByRole("button", { name: "1 trusted MCP server in quick chats" }));
    expect(await screen.findByRole("menuitem", { name: "Stop trusting claude_ai_Linear in all chats" })).toHaveTextContent("in all chats");
    await user.keyboard("{Escape}");

    await user.click(await screen.findByRole("button", { name: /^settings/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "Chat" }));
    const list = await within(dialog).findByRole("list", { name: "MCP servers trusted in all chats" });
    expect(await within(list).findByText("claude_ai_Linear")).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "Remove claude_ai_Linear" }));
    await waitFor(() => expect(mock.trustedEverywhere).toEqual([]));
    expect(await within(list).findByText("None.")).toBeInTheDocument();
  });

  it("says what a command reading the agent's saved tool result is, and still asks", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "saved results");
    const asked = await screen.findByRole("group", { name: "Permission requested" });
    expect(asked).toHaveTextContent("Claude is reading a saved tool result");
    expect(within(asked).getByRole("button", { name: "Yes" })).toBeEnabled();
    // The search and the Read were answered by yaah, each saying why.
    expect(cardOf(log, 'Search "Wisconsin county population 2020"')).toHaveTextContent("web search allowed in Settings");
    expect(log).toHaveTextContent("Claude's saved tool result from this chat");
  });

  it("isn't offered when yaah can't tell the server, or there is no one-off option to answer with", () => {
    const linear = { id: "claude_ai_Linear", label: "Linear" };
    const { rerender } = render(<PermissionCard entry={permission("t", "Run ls") as Request} index={0} agent={null} />);
    expect(screen.queryByRole("button", { name: /Always allow tools from/ })).toBeNull();
    const alwaysOnly = permission("t", "x", { mcpServer: linear, options: options.filter((o) => o.kind !== "allow_once") });
    rerender(<PermissionCard entry={alwaysOnly as Request} index={0} agent={null} />);
    expect(screen.queryByRole("button", { name: /Always allow tools from/ })).toBeNull();
  });

  it("lists a project's trusted servers in the project, each removable", async () => {
    const { user, mock } = renderApp();
    mock.projects[0].trustedMcpServers = ["claude_ai_Linear", "linear"];
    await user.click(within(await screen.findByRole("complementary")).getByRole("button", { name: "billing revamp" }));
    const section = await screen.findByRole("region", { name: "Trusted MCP servers" });
    expect(section).toHaveTextContent("including ones that change things");
    await user.click(within(section).getByRole("button", { name: "Stop trusting claude_ai_Linear" }));
    await waitFor(() => expect(mock.projects[0].trustedMcpServers).toEqual(["linear"]));
    expect(within(section).queryByText("claude_ai_Linear")).toBeNull();
  });
});

describe("Settings → Chat → Permissions", () => {
  it("turns allowing reads in the chat's folders off and on", async () => {
    const { user, mock } = renderApp();
    await user.click(await screen.findByRole("button", { name: /^settings/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "Chat" }));
    const reads = await within(dialog).findByRole("switch", { name: "Allow reads in the chat's folders without asking" });
    await waitFor(() => expect(reads).toBeChecked());
    await user.click(reads);
    await waitFor(() => expect(mock.trustReadOnly).toBe(false));
    expect(reads).not.toBeChecked();
    await user.click(reads);
    await waitFor(() => expect(mock.trustReadOnly).toBe(true));
  });

  it("allows web searches without asking only once turned on", async () => {
    const { user, mock } = renderApp();
    await user.click(await screen.findByRole("button", { name: /^settings/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "Chat" }));
    const search = await within(dialog).findByRole("switch", { name: "Allow web searches without asking" });
    await waitFor(() => expect(search).toBeEnabled());
    expect(search).not.toBeChecked();
    expect(within(dialog).getByText(/Fetching a page still asks/)).toBeInTheDocument();
    await user.click(search);
    await waitFor(() => expect(mock.allowWebSearch).toBe(true));
    expect(search).toBeChecked();
    await user.click(search);
    await waitFor(() => expect(mock.allowWebSearch).toBe(false));
  });
});

describe("batched permission requests", () => {
  const shell = (id: string, command: string, description: string, more: Record<string, unknown> = {}): Entry =>
    ({ ...tool(id, command), kind: "execute", status: "pending", rawInput: { command, description }, ...more }) as Entry;
  const agentLaunch = (id: string, name: string): Entry =>
    ({ ...tool(id, name), status: "in_progress", rawInput: { description: name, prompt: "go", subagent_type: "Explore" } }) as Entry;
  const spy = () => {
    const calls: [number, string | null][] = [];
    vi.spyOn(api, "respondPermission").mockImplementation((_s, index, optionId) => {
      calls.push([index, optionId]);
      return Promise.resolve();
    });
    return calls;
  };
  const entries = (): Entry[] => [
    shell("t1", "npm test && npm run lint", "Run the tests"),
    permission("t1", "npm test", { requestId: 1 }),
    shell("t2", "rm -rf dist", "Clean the build"),
    permission("t2", "rm -rf dist", { requestId: 2 }),
  ];

  it("lists two waiting requests in one group with each command, and a lone one keeps its card", async () => {
    await openChat(entries());
    const batch = screen.getByRole("group", { name: "2 permission requests" });
    expect(batch).toHaveTextContent("Run the tests");
    expect(batch).toHaveTextContent("Clean the build");
    expect(batch.querySelectorAll('[data-slot="command"]')).toHaveLength(2);
    expect(screen.queryByRole("group", { name: "Permission requested" })).toBeNull();
    expect(within(batch).getAllByRole("button", { name: /^Allow: / })).toHaveLength(2);
    expect(within(batch).getAllByRole("button", { name: /don't ask again/ })).toHaveLength(2);
  });

  it("Allow all answers every listed request with the plain allow-once option, never the always one", async () => {
    const calls = spy();
    await openChat(entries());
    fireEvent.click(await screen.findByRole("button", { name: "Allow all 2 requests" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => c[1])).toEqual(["y", "y"]);
    expect(calls.map((c) => c[0])).toEqual([1, 3]);
  });

  it("Deny all picks the one-off reject; an item's own button answers just that one", async () => {
    const calls = spy();
    await openChat(entries());
    fireEvent.click(await screen.findByRole("button", { name: "Deny: Clean the build" }));
    await waitFor(() => expect(calls).toEqual([[3, "n"]]));
    fireEvent.click(screen.getByRole("button", { name: "Yes, and don't ask again: Run the tests" }));
    await waitFor(() => expect(calls[1]).toEqual([1, "a"]));
  });

  it("names the sub-agent that asked when the requests come from different asks", async () => {
    await openChat([
      agentLaunch("a1", "Explore the repo"),
      agentLaunch("a2", "Audit deps"),
      { ...shell("t1", "ls", "List files"), parentToolCallId: "a1" } as Entry,
      permission("t1", "ls"),
      { ...shell("t2", "npm audit", "Audit"), parentToolCallId: "a2" } as Entry,
      permission("t2", "npm audit"),
    ]);
    const batch = screen.getByRole("group", { name: "2 permission requests" });
    expect(batch).toHaveTextContent("Asked by sub-agent: Explore the repo");
    expect(batch).toHaveTextContent("Asked by sub-agent: Audit deps");
    expect(screen.queryByRole("group", { name: "Permission requested" })).toBeNull();
  });
});
