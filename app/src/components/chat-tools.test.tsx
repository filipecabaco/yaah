// Tool cards as a coding turn makes them (the mock's "command output" replay), and
// switching a chat's agent for its next message, against the real App and the browser mock.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Elapsed, TranscriptEntry } from "@/components/entries";
import { api, type Entry } from "@/lib/api";
import { elapsedText } from "@/lib/format";
import { setCardRules } from "@/lib/tool-cards";
import { answerPermissionsUntil, renderApp, sendInQuickChat } from "@/test/app";

/** The card's header button, found by the words it shows. */
const card = (log: HTMLElement, text: string | RegExp) => within(log).getByText(text).closest("button") as HTMLElement;

async function commandTurn() {
  const app = renderApp();
  // The defaults Settings ships with (settings.rs TOOL_CARD_DEFAULTS, mirrored by the mock).
  setCardRules((await api.generalSettings()).toolCards.rules);
  const log = await sendInQuickChat(app.user, "show me the command output");
  await within(log).findByText(/Discounts now apply before tax/);
  await screen.findByRole("button", { name: "Send" });
  return { ...app, log };
}

describe("tool cards", () => {
  it("name what each call did, from its input", async () => {
    const { log } = await commandTurn();
    expect(within(log).getByText("Loaded yaah's UI tools")).toBeInTheDocument();
    expect(within(log).getByText("Read the UI catalog")).toBeInTheDocument();
    expect(within(log).getByText("fetch: gov.uk/guidance/rates-of-vat-on-different-goods-and-services")).toBeInTheDocument();
    expect(within(log).getByText("Rendered Where the invoices go")).toBeInTheDocument();
    expect(within(log).getByText("tabs, map, table")).toBeInTheDocument();
    // Shell commands keep the command as their title.
    expect(within(log).getByText("git diff main...HEAD")).toBeInTheDocument();
    expect(within(log).queryByText(/›/)).toBeNull();
  });

  it("start collapsed for commands, web fetches and the fetch server", async () => {
    const { log } = await commandTurn();
    for (const title of ["git diff main...HEAD", "cargo test invoice", "fetch: gov.uk/guidance/rates-of-vat-on-different-goods-and-services"])
      expect(card(log, title)).toHaveAttribute("aria-expanded", "false");
    expect(card(log, "Fetch https://taxation-customs.ec.europa.eu/vat-rates")).toHaveAttribute("aria-expanded", "false");
  });

  it("the user's own rule still wins", async () => {
    const { log } = await commandTurn();
    act(() => setCardRules({ "kind:execute": "expanded" }));
    await waitFor(() => expect(card(log, "cargo test invoice")).toHaveAttribute("aria-expanded", "true"));
  });

  it("show command output as code without the fence, and a diff in the diff view with the raw text a click away", async () => {
    const { user, log } = await commandTurn();
    await user.click(card(log, "cargo test invoice"));
    const cargo = await within(log).findByText(/running 3 tests/);
    expect(cargo.tagName).toBe("PRE");
    expect(cargo.textContent).not.toContain("```");
    expect(cargo).toHaveAttribute("data-layout", "code");
    expect(cargo.className.split(" ")).toContain("whitespace-pre");
    expect(cargo.className).toContain("overflow-auto");
    expect(cargo.className).not.toContain("break-all");

    await user.click(card(log, "git log --oneline --decorate -4"));
    expect((await within(log).findByText(/Apply discounts before tax/)).textContent).not.toMatch(/^```/);

    await user.click(card(log, "git diff main...HEAD"));
    const raw = await within(log).findByRole("button", { name: "Raw" });
    // The diff view names the file; the fence and headers aren't shown as text.
    expect((await within(log).findAllByText(/src\/billing\/invoice\.ts/)).length).toBeGreaterThan(0);
    expect(within(log).queryByText(/^```console/)).toBeNull();
    await user.click(raw);
    const text = await within(log).findByText(/^diff --git a\/src\/billing\/invoice\.ts/);
    expect(text.tagName).toBe("PRE");
    expect(text).toHaveAttribute("data-layout", "code");
    expect(text.textContent).toContain("\tconst rate = taxRate(plan.country);");
    await user.click(within(log).getByRole("button", { name: "Diff view" }));
    expect(within(log).queryByText(/^diff --git/)).toBeNull();
  });

  it("use a wide column, and messages keep a readable measure", async () => {
    const { log } = await commandTurn();
    // The shared column (index.css `.chat-column`), in a pane-sized container.
    expect(log.classList).toContain("chat-column");
    expect(log.parentElement?.classList).toContain("@container");
    const prose = within(log)
      .getByText(/Discounts now apply before tax/)
      .closest("[data-align]");
    expect(prose).toHaveAttribute("data-align", "start");
    expect(prose?.className).toContain("max-w-[min(140ch,100%)]");
    expect(prose?.className).not.toContain("ml-auto");
  });
});

describe("a running UI tool's time so far", () => {
  afterEach(() => vi.useRealTimers());

  it("reads in seconds, then minutes", () => {
    expect([1, 12, 60, 125].map(elapsedText)).toEqual(["1 s", "12 s", "1 min", "2 min 5 s"]);
  });

  it("ticks every second, and keeps counting from when the call was first seen", () => {
    vi.useFakeTimers();
    const first = render(<Elapsed id="toolu_slow" />);
    expect(first.container.textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(first.container.textContent).toBe("12 s");
    first.unmount();
    // Scrolled away and back (or re-rendered): the same call keeps its start.
    const again = render(<Elapsed id="toolu_slow" />);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(again.container.textContent).toBe("13 s");
  });
});

describe("switching a chat's agent", () => {
  it("from the header badge: the chat says so, the composer follows, and the next message hands off", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "check the mcp servers");
    await screen.findByRole("button", { name: "Send" });

    await user.click(screen.getByRole("button", { name: /^Agent: Claude\. Switch/ }));
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const current = within(dialog).getByRole("option", { name: /^Claude this chat's agent/ });
    expect(current).toHaveAttribute("data-checked", "true");
    await user.click(within(dialog).getByRole("option", { name: /Claude \(work\)/ }));

    expect(await within(log).findByText("Claude (work)")).toBeInTheDocument();
    expect(within(log).getByRole("status", { name: "Agent switched" }).textContent).toMatch(/Switched to Claude \(work\) from Claude/);
    const composer = screen.getByRole("combobox", { name: "Message" });
    await waitFor(() => expect(composer).toHaveAttribute("placeholder", expect.stringMatching(/^Message Claude \(work\)…/)));

    await user.type(composer, "and now in markdown{Enter}");
    expect(await within(log).findByText("hand-off from Claude")).toBeInTheDocument();
  });

  it("with /agent in the composer, marked as yaah's own", async () => {
    const { user } = renderApp();
    await sendInQuickChat(user, "check the mcp servers");
    await screen.findByRole("button", { name: "Send" });
    const composer = screen.getByRole("combobox", { name: "Message" });
    await user.type(composer, "/ag");
    const option = await screen.findByRole("option", { name: /\/agent.*yaah.*Switch the agent for the next message/ });
    expect(screen.getByText("yaah", { selector: "[cmdk-group-heading]" })).toBeInTheDocument();
    await user.click(option);
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(composer).toHaveValue("");
  });

  it("from ⌘K, and refused while a turn runs", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "write hello.txt please");
    await screen.findByRole("group", { name: "Permission requested" });

    await user.click(screen.getByRole("button", { name: /^Search/ }));
    let dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await user.type(within(dialog).getByRole("combobox"), "switch agent");
    await user.click(await within(dialog).findByRole("option", { name: /Switch agent….*this chat: Claude/ }));
    await user.click(await within(dialog).findByRole("option", { name: /Claude \(work\)/ }));
    expect(await within(dialog).findByText(/Wait for the turn to end/)).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await answerPermissionsUntil(user, log, "Yes", () => !!screen.queryByRole("button", { name: "Send" }));
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await user.type(within(dialog).getByRole("combobox"), "switch agent");
    await user.click(await within(dialog).findByRole("option", { name: /Switch agent…/ }));
    await user.click(await within(dialog).findByRole("option", { name: /Claude \(work\)/ }));
    expect(await within(log).findByText(/Switched to/)).toBeInTheDocument();
  });
});

describe("a tool card's text", () => {
  // As codex-acp sends it, for a server it didn't start.
  const CODEX_ERROR =
    "[codex-acp] MCP server `chrome-devtools` was not started, because the Codex config already defines an MCP server with this name. Codex uses its own entry, or no server if that entry is disabled.";
  const tool = (text: string, status: "failed" | "completed" = "failed"): Entry => ({
    type: "tool",
    toolCallId: "t1",
    title: "Run something",
    kind: "other",
    status,
    content: [{ type: "content", content: { type: "text", text } }],
    locations: [],
    rawInput: null,
  });
  const open = async (entry: Entry) => {
    const user = userEvent.setup();
    render(<TranscriptEntry entry={entry} index={0} inTurn={false} live={false} onLogin={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Run something/ }));
  };

  it("wraps an error message in full, in the destructive colour, sized to its content", async () => {
    await open(tool(CODEX_ERROR));
    const pre = screen.getByText(CODEX_ERROR);
    expect(pre).toHaveAttribute("data-layout", "prose");
    expect(pre.className).toContain("whitespace-pre-wrap");
    expect(pre.className).toContain("[overflow-wrap:anywhere]");
    expect(pre.className).toContain("text-destructive");
    // No sideways scroll and no fixed height: it grows with the text, up to max-h-96, then scrolls down.
    expect(pre.className).toContain("overflow-y-auto");
    expect(pre.className).not.toMatch(/(^|\s)overflow-auto(\s|$)/);
    expect(pre.className).not.toMatch(/(^|\s)h-\d/);
    expect(pre.className).toContain("max-h-96");
    // One line of text plus its padding: a code row's line height (1.25 rem at the default sizes), never under the padding.
    expect(pre.className).toContain("leading-(--code-row)");
    // In the code size (Settings → Fonts), which a text colour doesn't merge away.
    expect(pre.className).toContain("text-code");
  });

  it("wraps plain output of a call that worked, in the usual colour", async () => {
    await open(tool("Saved 3 rows to invoices.csv and skipped 1 duplicate.", "completed"));
    const pre = screen.getByText(/Saved 3 rows/);
    expect(pre).toHaveAttribute("data-layout", "prose");
    expect(pre.className).not.toContain("text-destructive");
  });

  it("keeps a code block on its lines, scrolling sideways with room for the scrollbar", async () => {
    await open(tool("```ts\nconst veryLongLine = [1, 2, 3].map((n) => n * 2).filter(Boolean).join(', ');\n```", "completed"));
    const pre = screen.getByText(/const veryLongLine/);
    expect(pre).toHaveAttribute("data-layout", "code");
    expect(pre.className.split(" ")).toContain("whitespace-pre");
    expect(pre.className).toContain("overflow-auto");
    expect(pre.className).toContain("pb-3");
  });

  it("still shows a diff in the diff view", async () => {
    await open(tool("--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n-hello\n+hello, world\n bye", "completed"));
    expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
    expect(screen.queryByText(/^--- a\/notes\.txt/)).toBeNull();
  });
});

describe("MCP startup notices", () => {
  it("show a server the agent uses its own of as an info line, and failures in the notices card", () => {
    const entry: Entry = {
      type: "notices",
      items: [
        { severity: "info", title: "Codex uses its own chrome-devtools", mcpServer: "chrome-devtools" },
        { severity: "warning", title: 'MCP server "rea" didn\'t start', description: "handshake timed out", mcpServer: "rea" },
      ],
    };
    render(<TranscriptEntry entry={entry} index={0} inTurn={false} live={false} onLogin={() => {}} />);
    const info = screen.getByText("Codex uses its own chrome-devtools");
    expect(info.closest("[role=status]")?.textContent).toBe("Codex uses its own chrome-devtools");
    expect(screen.getByText("1 MCP server isn't available in this chat")).toBeInTheDocument();
    expect(screen.getByText("didn't start")).toBeInTheDocument();
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it("show only the info line when nothing failed", () => {
    const entry: Entry = { type: "notices", items: [{ severity: "info", title: "Codex uses its own fetch", mcpServer: "fetch" }] };
    render(<TranscriptEntry entry={entry} index={0} inTurn={false} live={false} onLogin={() => {}} />);
    expect(screen.getByText("Codex uses its own fetch")).toBeInTheDocument();
    expect(screen.queryByText(/isn't available/)).toBeNull();
    expect(screen.queryByRole("button", { name: "MCP servers settings" })).toBeNull();
  });
});
