// The permission prompt docked above the composer, and its CLI-style keys (lib/permission-keys.ts).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "@/App";
import { installBrowserMock } from "@/dev/browser-mock";
import { api, type Entry, type PermissionOption } from "@/lib/api";
import { KEY_GRACE_MS, keyIntent } from "@/lib/permission-keys";
import { setCardRules } from "@/lib/tool-cards";
import { setGroupToolCalls } from "@/lib/tool-groups";

const options: PermissionOption[] = [
  { optionId: "y", name: "Yes", kind: "allow_once" },
  { optionId: "a", name: "Yes, and don't ask again for ls", kind: "allow_always" },
  { optionId: "n", name: "No", kind: "reject_once" },
];
const ask = (requestId: number, title: string, toolCallId: string | null = null): Entry => ({
  type: "permission",
  requestId,
  toolCallId,
  title,
  options,
  chosen: null,
});
/** Past the moment keys are ignored after a request appears. */
const settle = () => new Promise((r) => setTimeout(r, KEY_GRACE_MS + 50));
const user0: Entry = { type: "user", text: "go", attachments: [] };

async function openChat(entries: Entry[]) {
  const mock = installBrowserMock({ delay: 0 });
  setCardRules({});
  setGroupToolCalls(false);
  const c = await api.newQuickChat("default");
  Object.assign(mock.sessions[c.sessionId], { title: "seeded chat" });
  mock.transcripts[c.sessionId] = entries;
  const calls: [number, string | null][] = [];
  vi.spyOn(api, "respondPermission").mockImplementation((_s, index, optionId) => {
    calls.push([index, optionId]);
    return Promise.resolve();
  });
  const user = userEvent.setup();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "seeded chat" }));
  const composer = await screen.findByRole("combobox", { name: "Message" });
  return { user, calls, composer };
}

describe("the docked permission prompt", () => {
  it("sits right above the composer, names who asked, shows numbered real options and the hint", async () => {
    const { composer } = await openChat([user0, ask(1, "ls -la")]);
    const card = await screen.findByRole("group", { name: "Permission requested" });
    const dock = card.closest('[data-slot="permission-dock"]')!;
    expect(dock.nextElementSibling).toContainElement(composer);
    expect(card).toHaveTextContent("Asked by the main agent");
    expect(
      within(card)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["1Yes", "2Yes, and don't ask again for ls", "3No"]);
    expect(within(card).getByRole("button", { name: "Yes" })).toHaveAttribute("aria-keyshortcuts", "1");
    expect(card).toHaveTextContent("Enter to allow, Esc to deny — digits work once the prompt is focused; or just keep typing");
    expect(within(card).getByRole("alert")).toHaveTextContent("Permission requested: ls -la");
    // It does not take the keyboard from the message box.
    expect(composer).toHaveFocus();
  });

  it("answers with Enter or Esc from the empty message box, and a digit only from the prompt", async () => {
    const { user, calls, composer } = await openChat([user0, ask(1, "ls -la")]);
    const card = await screen.findByRole("group", { name: "Permission requested" });
    await settle();
    await user.click(composer);
    await user.keyboard("2");
    expect(composer).toHaveValue("2");
    expect(calls).toEqual([]);
    await user.clear(composer);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls).toEqual([[1, "y"]]));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(calls[1]).toEqual([1, "n"]));
    expect(composer).toHaveValue("");
    within(card).getByRole("button", { name: "Yes" }).focus();
    await user.keyboard("2");
    await waitFor(() => expect(calls[2]).toEqual([1, "a"]));
  });

  it("ignores answer keys for a moment after a request appears", async () => {
    const { user, calls, composer } = await openChat([user0, ask(1, "ls -la")]);
    await screen.findByRole("group", { name: "Permission requested" });
    await user.click(composer);
    await user.keyboard("{Enter}");
    expect(calls).toEqual([]);
    await settle();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls).toEqual([[1, "y"]]));
  });

  it("never takes keys while a draft is being typed", async () => {
    const { user, calls, composer } = await openChat([user0, ask(1, "ls -la")]);
    await screen.findByRole("group", { name: "Permission requested" });
    await settle();
    await user.click(composer);
    await user.keyboard("1 test please{Escape}");
    expect(composer).toHaveValue("1 test please");
    expect(calls).toEqual([]);
  });

  it("a batch: Enter answers the highlighted one from the box; arrows, digits, A and D need the card", async () => {
    const { user, calls, composer } = await openChat([user0, ask(1, "ls"), ask(2, "pwd"), ask(3, "whoami")]);
    const batch = await screen.findByRole("group", { name: "3 permission requests" });
    expect(batch.closest('[data-slot="permission-dock"]')).not.toBeNull();
    await settle();
    await user.click(composer);
    // The arrows and digits are not the box's to take.
    await user.keyboard("{ArrowDown}3");
    expect(composer).toHaveValue("3");
    expect(calls).toEqual([]);
    await user.clear(composer);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls).toEqual([[1, "y"]]));
    await user.keyboard("a");
    expect(composer).toHaveValue("a");
    expect(calls).toHaveLength(1);

    await user.clear(composer);
    await settle();
    within(batch).getByRole("button", { name: "Allow: pwd" }).focus();
    await user.keyboard("a");
    await waitFor(() => expect(calls.slice(1)).toEqual([1, 2, 3].map((i) => [i, "y"])));
    await settle();
    within(batch).getByRole("button", { name: "Allow: pwd" }).focus();
    await user.keyboard("d");
    await waitFor(() => expect(calls.slice(4)).toEqual([1, 2, 3].map((i) => [i, "n"])));
  });

  it("a sub-agent's request names the sub-agent", async () => {
    const launch = {
      type: "tool",
      toolCallId: "a1",
      title: "Explore the repo",
      kind: "other",
      status: "in_progress",
      content: [],
      locations: [],
      rawInput: { description: "Explore the repo", prompt: "go", subagent_type: "Explore" },
    } as Entry;
    const call = {
      ...launch,
      toolCallId: "t1",
      title: "ls",
      kind: "execute",
      parentToolCallId: "a1",
      rawInput: { command: "ls", description: "List" },
    } as Entry;
    await openChat([user0, launch, call, ask(1, "ls", "t1")]);
    expect(await screen.findByRole("group", { name: "Permission requested" })).toHaveTextContent("Asked by sub-agent: Explore the repo");
  });
});

describe("keyIntent", () => {
  const key = (k: string, more: object = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...more });
  const ctx = { where: "composer" as const, empty: true, onButton: false, batch: false };
  it("reads only Enter and Esc in an empty message box, and nothing in a draft", () => {
    expect(keyIntent(key("2"), ctx)).toBeNull();
    expect(keyIntent(key("Enter"), ctx)).toEqual({ kind: "allow" });
    expect(keyIntent(key("Escape"), ctx)).toEqual({ kind: "deny" });
    expect(keyIntent(key("Enter"), { ...ctx, empty: false })).toBeNull();
    expect(keyIntent(key("Escape"), { ...ctx, empty: false })).toBeNull();
    expect(keyIntent(key("Enter", { shiftKey: true }), ctx)).toBeNull();
    expect(keyIntent(key("a"), { ...ctx, batch: true })).toBeNull();
    expect(keyIntent(key("ArrowDown"), { ...ctx, batch: true })).toBeNull();
  });
  it("reads digits on the prompt", () => {
    expect(keyIntent(key("2"), { where: "prompt", empty: false, onButton: false, batch: false })).toEqual({ kind: "option", n: 2 });
    expect(keyIntent(key("1", { metaKey: true }), { where: "prompt", empty: false, onButton: false, batch: false })).toBeNull();
  });
  it("leaves Enter to a focused button, and gives a batch A, D and the arrows", () => {
    const on = { where: "prompt" as const, empty: false, onButton: true, batch: true };
    expect(keyIntent(key("Enter"), on)).toBeNull();
    expect(keyIntent(key("A"), on)).toEqual({ kind: "all", allow: true });
    expect(keyIntent(key("d"), on)).toEqual({ kind: "all", allow: false });
    expect(keyIntent(key("ArrowUp"), on)).toEqual({ kind: "move", by: -1 });
    expect(keyIntent(key("a"), { ...on, batch: false })).toBeNull();
  });
});
