// Tool cards as a coding turn makes them (the mock's "command output" replay), and
// switching a chat's agent for its next message, against the real App and the browser mock.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Elapsed } from "@/components/entries";
import { api } from "@/lib/api";
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
    expect(cargo.className).toContain("whitespace-pre");
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
    expect(text.textContent).toContain("\tconst rate = taxRate(plan.country);");
    await user.click(within(log).getByRole("button", { name: "Diff view" }));
    expect(within(log).queryByText(/^diff --git/)).toBeNull();
  });

  it("use a wide column, and messages keep a readable measure", async () => {
    const { log } = await commandTurn();
    expect(log.className).toContain("max-w-[min(100%,1400px)]");
    expect(
      within(log)
        .getByText(/Discounts now apply before tax/)
        .closest(".max-w-\\[75ch\\]"),
    ).not.toBeNull();
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
    await within(log).findByRole("group", { name: "Permission requested" });

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
