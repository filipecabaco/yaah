// Chat flows against the real App and the recorded replays in src/dev/fixtures.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { answerPermissionsUntil, renderApp, sendInQuickChat } from "@/test/app";
import { setCardRules } from "@/lib/tool-cards";

const WRITE = "Write /Users/dev/workspace/api/hello.txt";

describe("a quick chat", () => {
  it("replays a recorded turn, pausing on the permission until it is answered", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "write hello.txt please");

    // The agent asks before writing; nothing after it plays until the user answers.
    const permission = await screen.findByRole("group", { name: "Permission requested" });
    expect(within(permission).getAllByText(WRITE).length).toBeGreaterThan(0);
    expect(within(log).queryByText(/I created/)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await user.click(within(permission).getByRole("button", { name: "Yes" }));
    // Answered: the request folds into the Write card, as a chip.
    await waitFor(() => expect(screen.queryByRole("group", { name: "Permission requested" })).toBeNull());
    const card = within(log).getAllByText(WRITE)[0].closest("button") as HTMLElement;
    expect(within(card).getByText("Allowed")).toBeInTheDocument();

    // The rest of the recording: the reply, as Markdown, and the turn ends.
    expect(await within(log).findByText(/it contains exactly/)).toBeInTheDocument();
    // The reply streams in: wait for its inline code (the diff line above also says "hi from yaah", as a span).
    expect(await within(log).findByText("hi from yaah", { selector: "code" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("collapses a tool card when its turn ends, unless a rule says otherwise", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "write hello.txt please");
    await screen.findByRole("group", { name: "Permission requested" });

    // While the turn runs the Write card is open and shows its diff.
    const card = () => within(log).getAllByText(WRITE)[0].closest("button") as HTMLElement;
    await waitFor(() => expect(card()).toHaveAttribute("aria-expanded", "true"));

    await user.click(screen.getByRole("button", { name: "Yes" }));
    await screen.findByRole("button", { name: "Send" });
    // Turn over: `auto` closes it.
    await waitFor(() => expect(card()).toHaveAttribute("aria-expanded", "false"));

    // A rule for edits (Settings → Chat, or the card's menu) opens it for good.
    act(() => setCardRules({ "kind:edit": "expanded" }));
    await waitFor(() => expect(card()).toHaveAttribute("aria-expanded", "true"));
    act(() => setCardRules({ "kind:edit": "collapsed" }));
    await waitFor(() => expect(card()).toHaveAttribute("aria-expanded", "false"));

    // The user can still open it by hand.
    await user.click(card());
    expect(card()).toHaveAttribute("aria-expanded", "true");
  });

  it("offers the rule from the card's right-click menu", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "write hello.txt please");
    await screen.findByRole("group", { name: "Permission requested" });
    const title = within(log).getAllByText(WRITE)[0];

    fireEvent.contextMenu(title);
    const menu = await screen.findByRole("menu");
    // Edits open only while they run (auto), so the menu offers the other two.
    expect(within(menu).getByRole("menuitem", { name: /Always collapse “Edits \(any\)”/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Always expand “Edits \(any\)”/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /only while it runs/ })).toBeNull();
    await user.click(within(menu).getByRole("menuitem", { name: /Always collapse/ }));

    const trigger = title.closest("button") as HTMLElement;
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  });

  it("shows the agent's notices with a way to the MCP settings", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "check the mcp servers");

    const card = await within(log).findByRole("status");
    expect(within(card).getByText("2 MCP servers aren't available in this chat")).toBeInTheDocument();
    expect(within(card).getByText("linear")).toBeInTheDocument();
    expect(within(card).getByText("needs authentication")).toBeInTheDocument();
    // The ACP boilerplate pointing at /mcp is dropped; the cause stays.
    expect(within(card).getByText("· spawn uvx ENOENT.")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "MCP servers settings" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: /MCP servers/i, selected: true })).toBeInTheDocument();
  });

  it("completes slash commands from the agent", async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole("button", { name: /^quick chat\b(?!s)/i }));
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "/comp");
    expect(composer).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("option", { name: /\/compact/ })).toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(composer).toHaveValue("/compact ");
    expect(composer).toHaveAttribute("aria-expanded", "false");
  });
});

describe("a form the user and the agent fill together", () => {
  it("shows the agent's values, lets the user take a field over, and sends once", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "file a bug report");
    const formTitle = () => within(log).queryByText("Bug report: partial refund");

    // The recorded run asks to run three commands first.
    await answerPermissionsUntil(user, log, "Yes", () => formTitle() != null, 30_000);
    const figure = formTitle()!.closest("figure")!;

    // The agent filled the draft with ui_set_values: its fields say so.
    await waitFor(() => expect(within(figure).getAllByText("agent").length).toBeGreaterThan(1));
    const area = within(figure).getByRole("textbox", { name: /area/i });
    expect(area).toHaveValue("billing / refunds (src/billing/refund.js)");
    const marksBefore = within(figure).getAllByText("agent").length;

    // The user takes one field over: it stops being the agent's.
    await user.clear(area);
    await user.type(area, "billing");
    expect(area).toHaveValue("billing");
    expect(within(figure).getAllByText("agent")).toHaveLength(marksBefore - 1);

    // Sending locks the form with what was sent.
    await user.click(within(figure).getByRole("button", { name: /send|file|submit/i }));
    expect(await within(figure).findByText("Sent")).toBeInTheDocument();
    expect(area).toBeDisabled();
    expect(area).toHaveValue("billing");
  });
});

describe("the ui_render card", () => {
  it("spins while ui_render is pending and in progress, says what it builds, then that it rendered it", async () => {
    // Real (short) waits between the recorded steps, so each state is on screen for a moment.
    const { user } = renderApp({ delay: 0.3 });
    const statuses: (string | null)[] = [];
    const { events } = await import("@/lib/api");
    const off = await events.sessionEntry((e) => {
      if (e.entry.type === "tool" && e.entry.toolCallId === "toolu_assemble") statuses.push(e.entry.status);
    });
    const log = await sendInQuickChat(user, "show the deploys");

    // Pending, then in progress: the card says the UI is being built (its title once known), with a spinner.
    const card = (await within(log).findByText(/^Building (the UI…|Deploys)$/)).closest('[data-slot="collapsible-trigger"]')
      ?.parentElement as HTMLElement;
    expect(within(card).getByText("in progress")).toHaveClass("sr-only");
    expect(card.querySelector(".animate-spin")).not.toBeNull();
    expect(within(card).queryByText("done")).toBeNull();

    // Completed: "Rendered" and the UI's title, with what's in it, no spinner, and the UI itself below.
    expect(await within(log).findByText("Rendered Deploys")).toBeInTheDocument();
    await waitFor(() => expect(within(log).queryByText(/^Building/)).toBeNull());
    const done = within(log).getByText("Rendered Deploys").closest('[data-slot="collapsible-trigger"]')?.parentElement as HTMLElement;
    expect(done.querySelector(".animate-spin")).toBeNull();
    expect(within(done).getByText("done")).toBeInTheDocument();
    expect(within(done).getByText("table")).toBeInTheDocument();
    expect(await within(log).findByRole("table")).toHaveTextContent("rolling out");
    expect(statuses).toEqual(["pending", "in_progress", "in_progress", "completed"]);
    off();
  });
});
