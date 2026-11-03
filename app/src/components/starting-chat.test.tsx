// A new chat while its agent starts (chat.tsx `StartingChat`, use-yaah.ts `startIn`): what it
// waits for, the time so far, and a failed start with Retry and Switch agent.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartingChat } from "@/components/chat";
import type { Starting } from "@/hooks/use-yaah";
import { api, type AgentProfile } from "@/lib/api";
import { startingText } from "@/lib/format";
import { renderApp } from "@/test/app";

const agents = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
] as AgentProfile[];

const start = (over: Partial<Starting> = {}): Starting => ({
  startId: "s1",
  agentId: "codex",
  stage: "agent",
  servers: [],
  startedAt: Date.now(),
  error: null,
  over: "null",
  retry: vi.fn(),
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("what a starting chat says", () => {
  it("names the stage: the agent, the MCP servers it starts, the session", () => {
    expect(startingText({ stage: "agent", servers: [] }, "Codex")).toBe("Starting Codex…");
    expect(startingText({ stage: "mcpServers", servers: ["chrome-devtools", "fetch"] }, "Codex")).toBe(
      "Starting MCP servers: chrome-devtools, fetch…",
    );
    expect(startingText({ stage: "mcpServers", servers: ["a", "b", "c", "d", "e", "f"] }, "Codex")).toBe(
      "Starting MCP servers: a, b, c, d and 2 more…",
    );
    expect(startingText({ stage: "session", servers: [] }, "Codex")).toBe("Opening the session…");
  });
});

describe("a starting chat", () => {
  it("shows the agent, the sliding mark and the stage, and the time so far only after 2 s", () => {
    vi.useFakeTimers();
    const view = render(<StartingChat start={start()} agents={agents} onDismiss={() => {}} />);
    const status = screen.getByRole("status", { name: "Starting a chat with Codex" });
    expect(within(status).getByText("Starting Codex…")).toBeInTheDocument();
    expect(status.querySelector("svg[data-loading]")).not.toBeNull();
    expect(screen.getByText("Codex", { selector: "[data-slot=badge]" })).toBeInTheDocument();
    expect(within(status).queryByText(/\d s$/)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(within(status).queryByText(/\d s$/)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(within(status).getByText("2 s")).toBeInTheDocument();

    view.rerender(
      <StartingChat start={start({ stage: "mcpServers", servers: ["chrome-devtools", "fetch"] })} agents={agents} onDismiss={() => {}} />,
    );
    expect(within(status).getByText("Starting MCP servers: chrome-devtools, fetch…")).toBeInTheDocument();
  });

  it("keeps the composer waiting: nothing queues a message yet", () => {
    render(<StartingChat start={start({ stage: "session" })} agents={agents} onDismiss={() => {}} />);
    const composer = screen.getByRole("textbox", { name: "Message" });
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute("placeholder", "Codex is starting…");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("says why it failed, readably, with Retry, Switch agent and Close", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const onDismiss = vi.fn();
    const error =
      "session/new failed: [codex-acp] MCP server `chrome-devtools` was not started, because the Codex config already defines an MCP server with this name.";
    render(<StartingChat start={start({ error, retry })} agents={agents} onDismiss={onDismiss} />);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Codex didn't start")).toBeInTheDocument();
    const message = within(alert).getByText(error);
    expect(message.className).toContain("whitespace-pre-wrap");
    expect(message.className).toContain("text-destructive");
    expect(screen.queryByRole("status")).toBeNull();

    await user.click(within(alert).getByRole("button", { name: /Retry/ }));
    expect(retry).toHaveBeenLastCalledWith();
    await user.click(within(alert).getByRole("button", { name: /Switch agent/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Claude/ }));
    expect(retry).toHaveBeenLastCalledWith("claude");
    await user.click(within(alert).getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("starting a chat in the app", () => {
  it("shows the start in the pane, then the chat; a failed start retries into the chat", async () => {
    const { user } = renderApp();
    const real = api.newQuickChat;
    let fail = true;
    vi.spyOn(api, "newQuickChat").mockImplementation((...args) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("the agent exited before answering initialize"));
      }
      return real(...args);
    });
    await user.click(await screen.findByRole("button", { name: /^quick chat\b(?!s)/i }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/didn't start/)).toBeInTheDocument();
    expect(within(alert).getByText("the agent exited before answering initialize")).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("combobox", { name: "Message" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.newQuickChat).toHaveBeenCalledTimes(2);
    // Each start has its own id, which its progress events carry.
    const [first, second] = vi.mocked(api.newQuickChat).mock.calls.map((c) => c[3]);
    expect(first).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });
});
