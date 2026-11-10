// Queued messages (components/composer-queue.tsx, session/queue.rs) against the real App
// and the browser mock: Enter while a turn runs queues and clears the composer; the list
// above the composer, its count and announcements; Edit, Remove, Move, Send now; a stop
// pauses the queue and Resume sends it in order; ⌘K "Clear queue".
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { openPalette } from "@/test/palette";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "@/App";
import { installBrowserMock } from "@/dev/browser-mock";
import { api, type QueuedMessage, type SessionInfo } from "@/lib/api";
import { setCardRules } from "@/lib/tool-cards";
import { setGroupToolCalls } from "@/lib/tool-groups";

const item = (id: string, text: string, more: Partial<QueuedMessage> = {}): QueuedMessage => ({ id, text, queuedAt: 0, ...more });

/** A chat opened in the App; `seed` changes it first (running, a queue). */
async function openChat(seed: (s: SessionInfo) => void = () => {}) {
  const mock = installBrowserMock({ delay: 0 });
  setCardRules({});
  setGroupToolCalls(false);
  const c = await api.newQuickChat("default");
  Object.assign(mock.sessions[c.sessionId], { title: "seeded chat" });
  seed(mock.sessions[c.sessionId]);
  const user = userEvent.setup();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "seeded chat" }));
  const input = await screen.findByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  return { user, mock, sessionId: c.sessionId, input };
}

const queueList = () => screen.queryByRole("list", { name: "Queued messages" });
const rows = () =>
  within(queueList()!)
    .getAllByRole("listitem")
    .map((li) => within(li).getAllByRole("button")[0].textContent);
const live = () => screen.getAllByRole("status").map((s) => s.textContent ?? "");
const sent = () =>
  within(screen.getByRole("log", { name: "Conversation" }))
    .queryAllByText(/^markdown (second|third|alpha|beta)$/)
    .map((e) => e.textContent);

describe("queued messages", () => {
  it("queues on Enter while a turn runs, clears the composer, and says so", async () => {
    const { user, input, mock, sessionId } = await openChat((s) => Object.assign(s, { running: true }));
    expect(queueList()).toBeNull();
    await user.type(input, "second{Enter}");
    expect(input.value).toBe("");
    await waitFor(() => expect(queueList()).not.toBeNull());
    expect(rows()).toEqual(["second"]);
    expect(screen.getByText("1 queued")).toBeInTheDocument();
    expect(live()).toContain("Queued: second. 1 queued");
    await user.type(input, "third{Enter}");
    await waitFor(() => expect(rows()).toEqual(["second", "third"]));
    expect(screen.getByText("2 queued")).toBeInTheDocument();
    expect(mock.sessions[sessionId].queue?.items?.map((i) => i.text)).toEqual(["second", "third"]);
  });

  it("the Queue button queues too, for the mouse; it shows only while a turn runs and there's a message", async () => {
    const { user, input } = await openChat((s) => Object.assign(s, { running: true }));
    expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
    await user.type(input, "second");
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    await waitFor(() => expect(rows()).toEqual(["second"]));
    expect(input.value).toBe("");
    expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("pauses when the turn is stopped, and Resume sends them in order as each turn ends", async () => {
    const { user, input } = await openChat((s) => Object.assign(s, { running: true }));
    await user.type(input, "markdown second{Enter}");
    await user.type(input, "markdown third{Enter}");
    await waitFor(() => expect(rows()).toEqual(["markdown second", "markdown third"]));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Paused: the turn was stopped")).toBeInTheDocument();
    expect(live()).toContain("Paused: the turn was stopped. 2 queued");
    expect(sent()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Resume queue" }));
    await waitFor(() => expect(sent()).toEqual(["markdown second", "markdown third"]), { timeout: 5000 });
    await waitFor(() => expect(queueList()).toBeNull());
    expect(live().some((l) => l.startsWith("Sent from the queue: markdown third"))).toBe(true);
  });

  it("lists each message with what it carries; Move, Remove and Edit change it in Rust", async () => {
    const files = [{ id: "att-1", name: "spec.md", kind: "file" as const, size: 12, path: "/Users/dev/spec.md" }];
    const { user, input, mock, sessionId } = await openChat((s) =>
      Object.assign(s, {
        running: true,
        queue: {
          items: [
            item("a", "alpha see @src/app.ts", { files, references: 2, mentions: ["/Users/dev/workspace/shop/src/app.ts"] }),
            item("b", "beta\nwith a second line"),
            item("c", "gamma"),
          ],
        },
      }),
    );
    expect(rows()).toEqual(["alpha see @src/app.ts", "beta\nwith a second line", "gamma"]);
    expect(screen.getByText("1 attachment · 2 references")).toBeInTheDocument();
    expect(screen.getByText("3 queued")).toBeInTheDocument();

    // One line, opens to all of it.
    const beta = within(queueList()!).getAllByRole("listitem")[1];
    const toggle = within(beta).getByRole("button", { name: /Show all of queued message 2 of 3/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await user.click(within(beta).getByRole("button", { name: "Move “beta with a second line” up" }));
    await waitFor(() => expect(mock.sessions[sessionId].queue?.items?.map((i) => i.id)).toEqual(["b", "a", "c"]));
    expect(live()).toContain("Moved up: beta with a second line, 1 of 3");
    // Alt+↑ on a row moves it up.
    fireEvent.keyDown(within(queueList()!).getAllByRole("listitem")[2], { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(mock.sessions[sessionId].queue?.items?.map((i) => i.id)).toEqual(["b", "c", "a"]));

    await user.click(screen.getByRole("button", { name: "Remove “gamma” from the queue" }));
    await waitFor(() => expect(mock.sessions[sessionId].queue?.items?.map((i) => i.id)).toEqual(["b", "a"]));
    expect(live()).toContain("Removed from the queue: gamma");

    // Edit: the text, its mention and its attachment are back in the composer; the item leaves the queue.
    await user.click(screen.getByRole("button", { name: "Edit “alpha see @src/app.ts”" }));
    await waitFor(() => expect(input.value).toBe("alpha see @src/app.ts"));
    expect(await screen.findByText("spec.md")).toBeInTheDocument();
    await waitFor(() => expect(mock.sessions[sessionId].queue?.items?.map((i) => i.id)).toEqual(["b"]));
    expect(mock.attachmentsStaged["att-1"]).toBeDefined();
  });

  it("one Send now for the queue stops the running turn and sends the first; the rest follow", async () => {
    await openChat((s) => Object.assign(s, { running: true, queue: { items: [item("a", "markdown alpha"), item("b", "markdown beta")] } }));
    expect(screen.getAllByRole("button", { name: /Send now/ })).toHaveLength(1);
    expect(within(queueList()!).queryByRole("button", { name: /Send now/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Send now/ }));
    await waitFor(() => expect(sent()).toEqual(["markdown alpha", "markdown beta"]), { timeout: 5000 });
    await waitFor(() => expect(queueList()).toBeNull());
  });

  it("⌘K offers Clear queue only when the chat has one", async () => {
    const { user, mock, sessionId } = await openChat((s) =>
      Object.assign(s, { running: true, queue: { items: [item("a", "alpha"), item("b", "beta")] } }),
    );
    await openPalette();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await user.type(within(palette).getByRole("combobox"), "clear queue");
    await user.click(await within(palette).findByRole("option", { name: /Clear queue.*2 queued/ }));
    await waitFor(() => expect(queueList()).toBeNull());
    expect(mock.sessions[sessionId].queue?.items ?? []).toEqual([]);

    await openPalette();
    const again = await screen.findByRole("dialog", { name: "Command palette" });
    await user.type(within(again).getByRole("combobox"), "clear queue");
    expect(within(again).queryByRole("option", { name: /Clear queue/ })).toBeNull();
  });
});
