// The batch card: "Allow all" covers what the user was shown, and the highlight follows a request's id.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatContext } from "@/components/chat-context";
import { PermissionBatchCard } from "@/components/permission-batch";
import { api, type Entry, type PermissionOption } from "@/lib/api";

const options: PermissionOption[] = [
  { optionId: "y", name: "Yes", kind: "allow_once" },
  { optionId: "a", name: "Always", kind: "allow_always" },
  { optionId: "n", name: "No", kind: "reject_once" },
];
const item = (index: number, title: string) => ({
  index,
  agentId: null,
  agent: null,
  entry: { type: "permission", requestId: index, toolCallId: null, title, options, chosen: null } as Extract<Entry, { type: "permission" }>,
});
const chat = { sessionId: "s1", cwd: "/x", busy: false };
const card = (items: ReturnType<typeof item>[]) => (
  <ChatContext.Provider value={chat}>
    <div data-chat-root>
      <PermissionBatchCard items={items} />
    </div>
  </ChatContext.Provider>
);

let calls: [number, string | null][];
beforeEach(() => {
  calls = [];
  vi.spyOn(api, "respondPermission").mockImplementation((_s, index, optionId) => {
    calls.push([index, optionId]);
    return Promise.resolve();
  });
});
afterEach(() => vi.restoreAllMocks());

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

describe("PermissionBatchCard", () => {
  it("does not allow a request that arrived after the card was shown, and lists it apart", async () => {
    const { rerender } = render(card([item(1, "ls"), item(2, "pwd")]));
    rerender(card([item(1, "ls"), item(2, "pwd"), item(3, "rm -rf x")]));
    expect(screen.getByText("+1 new request, not included")).toBeInTheDocument();
    expect(screen.getByText("1 new request: answer it on its own")).toBeInTheDocument();
    // Allow all waits for the new count to be seen.
    expect(screen.getByRole("button", { name: "Allow all 2 requests" })).toBeDisabled();
    await wait(900);
    const all = screen.getByRole("button", { name: "Allow all 2 requests" });
    expect(all).toBeEnabled();
    fireEvent.click(all);
    await wait(10);
    expect(calls).toEqual([
      [1, "y"],
      [2, "y"],
    ]);
  });

  it("keeps the highlight on its request when an earlier one is answered elsewhere", async () => {
    const { rerender } = render(card([item(1, "ls"), item(2, "pwd"), item(3, "whoami")]));
    await wait(450);
    // Highlight request 2, then request 1 is answered in another pane.
    fireEvent.click(screen.getByRole("group", { name: /Request 2 of 3/ }));
    rerender(card([item(2, "pwd"), item(3, "whoami")]));
    expect(screen.getByRole("group", { name: /Request 1 of 2: pwd/ })).toHaveAttribute("aria-current", "true");
    // A key right after the set changed is ignored; later it answers request 2, not 3.
    fireEvent.keyDown(screen.getByRole("group", { name: /Request 1 of 2/ }), { key: "Enter" });
    await wait(450);
    fireEvent.keyDown(screen.getByRole("group", { name: /Request 1 of 2/ }), { key: "Enter" });
    await wait(10);
    expect(calls).toEqual([[2, "y"]]);
  });
});
