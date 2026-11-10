// The ⌘K palette with hundreds of chats: ranked once per keystroke, top results
// only, best group first; and nothing built while it's closed.
import { render, screen, waitFor, within } from "@testing-library/react";
import { openPalette } from "@/test/palette";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "@/App";
import { installBrowserMock } from "@/dev/browser-mock";
import { api } from "@/lib/api";
import { rankTop } from "@/lib/fuzzy";
import { setCardRules } from "@/lib/tool-cards";

describe("rankTop", () => {
  const items = ["deploy api", "fix tests", "api docs", "release notes", "apiary"].map((label) => ({ label }));
  it("ranks the best matches first, keeps the top n, and says how many more matched", () => {
    const r = rankTop(items, "api", (i) => [i.label], 2);
    // Both start with the query; the shorter name is the closer match.
    expect(r.shown.map((i) => i.label)).toEqual(["apiary", "api docs"]);
    expect(r.more).toBe(1);
    expect(r.best).toBeGreaterThan(0);
  });
  it("keeps the order for an empty query, and reports no match as best 0", () => {
    expect(rankTop(items, " ", (i) => [i.label], 3)).toEqual({ shown: items.slice(0, 3), best: 1, more: 2 });
    expect(rankTop(items, "zzz", (i) => [i.label])).toEqual({ shown: [], best: 0, more: 0 });
  });
});

describe("the palette with 300 chats", () => {
  async function withChats(n: number) {
    const mock = installBrowserMock({ delay: 0 });
    setCardRules({});
    for (let i = 0; i < n; i++) {
      const c = await api.newQuickChat("default");
      Object.assign(mock.sessions[c.sessionId], { title: `chat number ${i}`, createdAt: 1000 + i });
    }
    const user = userEvent.setup();
    render(<App />);
    await openPalette();
    return { user, dialog: await screen.findByRole("dialog", { name: "Command palette" }) };
  }
  const chatItems = (dialog: HTMLElement) =>
    within(dialog)
      .queryAllByRole("option")
      .filter((o) => o.textContent?.startsWith("chat number"));

  it("lists the first 50 chats and says how to find the rest", async () => {
    const { dialog } = await withChats(300);
    expect(chatItems(dialog)).toHaveLength(50);
    expect(within(dialog).getByText("250 more: type to find them.")).toBeInTheDocument();
    // Newest first, as in the sidebar.
    expect(chatItems(dialog)[0]).toHaveTextContent("chat number 299");
  });

  it("ranks once per keystroke: the exact chat first, its group above the actions", async () => {
    const { user, dialog } = await withChats(300);
    await user.type(within(dialog).getByRole("combobox"), "chat number 123");
    await waitFor(() => expect(within(dialog).getAllByRole("option")[0]).toHaveTextContent("chat number 123"));
    // The best match is the one Enter runs.
    expect(within(dialog).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    const groups = [...dialog.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent);
    expect(groups[0]).toBe("Chats");
    expect(chatItems(dialog).length).toBeLessThanOrEqual(50);
  });

  it("still finds actions by name", async () => {
    const { user, dialog } = await withChats(5);
    await user.type(within(dialog).getByRole("combobox"), "keyboard");
    await waitFor(() => expect(within(dialog).getAllByRole("option")[0]).toHaveTextContent("Keyboard shortcuts"));
    expect(chatItems(dialog)).toHaveLength(0);
    // Arrows still move, and Enter runs the picked one.
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("with an empty query lists chats, then projects, then commands", async () => {
    const { dialog } = await withChats(3);
    const headings = [...dialog.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent);
    expect(headings[0]).toBe("Chats");
    expect(headings.indexOf("Chats")).toBeLessThan(headings.indexOf("Commands"));
    if (headings.includes("Projects")) expect(headings.indexOf("Projects")).toBeLessThan(headings.indexOf("Commands"));
    expect(within(dialog).getAllByRole("option")[0]).toHaveTextContent("chat number 2");
    expect(within(dialog).getByPlaceholderText("Search · @ chats and projects · # commands")).toBeInTheDocument();
  });

  it("@ shows only chats and projects behind a chip, and filters them", async () => {
    const { user, dialog } = await withChats(5);
    const input = within(dialog).getByRole("combobox");
    await user.type(input, "@");
    expect(input).toHaveValue("");
    expect(dialog.querySelector("[data-slot=palette-scope]")).toHaveTextContent("Chats and projects");
    expect(within(dialog).getByLabelText("Searching chats and projects only")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).queryByText("Keyboard shortcuts")).toBeNull());
    expect([...dialog.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent)).not.toContain("Commands");
    await user.type(input, "number 3");
    await waitFor(() => expect(chatItems(dialog)).toHaveLength(1));
    expect(chatItems(dialog)[0]).toHaveTextContent("chat number 3");
  });

  it("# shows only commands, and Backspace on an empty query drops the scope", async () => {
    const { user, dialog } = await withChats(5);
    const input = within(dialog).getByRole("combobox");
    await user.type(input, "#");
    expect(dialog.querySelector("[data-slot=palette-scope]")).toHaveTextContent("Commands");
    expect(chatItems(dialog)).toHaveLength(0);
    expect(within(dialog).getByRole("option", { name: /Keyboard shortcuts/ })).toBeInTheDocument();
    await user.type(input, "keyb");
    await waitFor(() => expect(within(dialog).getAllByRole("option")[0]).toHaveTextContent("Keyboard shortcuts"));
    // One Backspace erases the text, the next the scope (the palette stays on its top level).
    await user.keyboard("{Backspace}{Backspace}{Backspace}{Backspace}");
    expect(dialog.querySelector("[data-slot=palette-scope]")).not.toBeNull();
    await user.keyboard("{Backspace}");
    expect(dialog.querySelector("[data-slot=palette-scope]")).toBeNull();
    await waitFor(() => expect(chatItems(dialog).length).toBeGreaterThan(0));
  });

  it("a weak chat match does not bury an exact command, while an equal one still leads", async () => {
    const mock = installBrowserMock({ delay: 0 });
    setCardRules({});
    const c = await api.newQuickChat("default");
    Object.assign(mock.sessions[c.sessionId], { title: "k e y b o a r d s h o r t c u t s notes", createdAt: 1000 });
    const d = await api.newQuickChat("default");
    Object.assign(mock.sessions[d.sessionId], { title: "split notes", createdAt: 1001 });
    const user = userEvent.setup();
    render(<App />);
    await openPalette();
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox");
    await user.type(input, "keyboard shortcuts");
    await waitFor(() => expect(within(dialog).getAllByRole("option")[0]).toHaveTextContent("Keyboard shortcuts"));
    await user.clear(input);
    // Both a chat and a command contain "split": the chat group leads on a tie.
    await user.type(input, "split notes");
    await waitFor(() => expect(within(dialog).getAllByRole("option")[0]).toHaveTextContent("split notes"));
  });

  it("builds nothing while it's closed", async () => {
    installBrowserMock({ delay: 0 });
    render(<App />);
    await screen.findByRole("button", { name: "Hide the sidebar" });
    expect(document.querySelector("[cmdk-root]")).toBeNull();
  });
});
