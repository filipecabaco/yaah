// The composer's Model and Effort pickers (components/composer-config.tsx) against
// the real App and the browser mock: shown only for what the agent offers, a pick
// goes to Rust (`set_chat_config`) and the chat shows what comes back, locked while
// a turn runs, reachable from ⌘K, and Settings → Agents "New chats start with".
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { openPalette } from "@/test/palette";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "@/App";
import { installBrowserMock } from "@/dev/browser-mock";
import { api, type SessionInfo } from "@/lib/api";
import { setCardRules } from "@/lib/tool-cards";
import { setGroupToolCalls } from "@/lib/tool-groups";

/** Every `set_chat_config` call the app makes, by its arguments. */
function setCalls() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const spy = vi.spyOn(internals, "invoke");
  return () => spy.mock.calls.filter(([c]) => c === "set_chat_config").map(([, args]) => args);
}

/** A chat with `account`'s agent, opened in the App; `seed` changes it first. */
async function openChat(account: string, seed: (s: SessionInfo) => void = () => {}) {
  const mock = installBrowserMock({ delay: 0 });
  setCardRules({});
  setGroupToolCalls(false);
  const c = await api.newQuickChat(account);
  Object.assign(mock.sessions[c.sessionId], { title: "seeded chat" });
  seed(mock.sessions[c.sessionId]);
  const user = userEvent.setup();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "seeded chat" }));
  await screen.findByRole("combobox", { name: "Message" });
  return { user, mock, sessionId: c.sessionId };
}

const pickers = () => screen.queryByRole("group", { name: "Model and effort for the next message" });

describe("the composer's model and effort", () => {
  it("shows what the agent offers; a new model goes to Rust and the effort levels follow it", async () => {
    const { user, sessionId } = await openChat("default");
    const calls = setCalls();
    const group = pickers()!;
    const model = within(group).getByRole("button", { name: "Model: Default (recommended)" });
    expect(within(group).getByRole("button", { name: "Effort: Default" })).toBeInTheDocument();

    await user.click(model);
    const list = await screen.findByRole("listbox", { name: "Model choices" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Default (recommended)Opus 4.6 · Most capable for complex work",
      "Opus 4.6Most capable for complex work",
      "Sonnet 4.6Best for everyday tasks",
      "Sonnet 4.6 (1M context)For long sessions",
      "Haiku 4.5Fastest for quick answers",
    ]);
    expect(screen.queryByRole("combobox", { name: /search/i })).toBeNull();
    await user.click(within(list).getByRole("option", { name: /^Haiku 4\.5/ }));

    expect(calls()).toEqual([{ sessionId, configId: "model", value: "haiku" }]);
    await within(group).findByRole("button", { name: "Model: Haiku 4.5" });
    // Haiku has no effort levels: the agent stops offering one, so the picker goes.
    await waitFor(() => expect(within(group).queryByRole("button", { name: /^Effort/ })).toBeNull());

    await user.click(within(group).getByRole("button", { name: "Model: Haiku 4.5" }));
    await user.click(within(await screen.findByRole("listbox", { name: "Model choices" })).getByRole("option", { name: /^Opus 4\.6/ }));
    await user.click(await within(group).findByRole("button", { name: "Effort: Default" }));
    await user.click(within(await screen.findByRole("listbox", { name: "Effort choices" })).getByRole("option", { name: "Max" }));
    await within(group).findByRole("button", { name: "Effort: Max" });
    expect(calls().at(-1)).toEqual({ sessionId, configId: "effort", value: "max" });
  });

  it("isn't there for an agent that offers neither", async () => {
    await openChat("personal");
    expect(pickers()).toBeNull();
  });

  it("is locked while a turn runs, and ⌘K offers neither until it ends", async () => {
    const { user, sessionId } = await openChat("default", (s) => Object.assign(s, { running: true }));
    const model = within(pickers()!).getByRole("button", { name: "Model: Default (recommended)" });
    expect(model).toBeDisabled();
    expect(model).toHaveAttribute("title", expect.stringMatching(/Wait for the turn to end/));
    await expect(api.setChatConfig(sessionId, "model", "haiku")).rejects.toThrow(/Wait for the turn to end/);

    await openPalette();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await user.type(within(palette).getByRole("combobox"), "change model");
    expect(within(palette).queryByRole("option", { name: /Change model…/ })).toBeNull();
  });

  it("opens from ⌘K on the chat's picker, and a long list is searchable", async () => {
    const { user, sessionId } = await openChat("opencode-openrouter");
    const calls = setCalls();
    await openPalette();
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await user.type(within(palette).getByRole("combobox"), "change model");
    await user.click(await within(palette).findByRole("option", { name: /Change model….*Claude Sonnet 4\.5/ }));

    const search = await screen.findByPlaceholderText(/^Search \d+ models/);
    await waitFor(() => expect(search).toHaveFocus());
    await user.type(search, "gpt 5.5");
    const list = screen.getByRole("listbox", { name: "Model choices" });
    await waitFor(() => expect(within(list).getAllByRole("option")[0]).toHaveTextContent("openrouter/GPT-5.5"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(calls()).toEqual([{ sessionId, configId: "model", value: "openrouter/openai/gpt-5.5" }]));
    await within(pickers()!).findByRole("button", { name: "Model: openrouter/GPT-5.5" });
  });
});

describe("Settings → Agents, New chats start with", () => {
  it("offers the newest chat's values, and the next chat starts with them; a provider's model isn't overridden", async () => {
    const mock = installBrowserMock({ delay: 0 });
    await api.newQuickChat("default");
    await expect(api.setAgentConfigDefault("default", "model", "gpt-9")).rejects.toThrow(/isn't one of the values/);
    const d = await api.setAgentConfigDefault("default", "model", "sonnet");
    expect(d.defaults).toEqual({ model: "sonnet" });
    await api.setAgentConfigDefault("default", "effort", "high");
    const next = await api.newQuickChat("default");
    expect(next.config?.options?.find((o) => o.role === "model")?.current).toBe("sonnet");
    expect(next.config?.options?.find((o) => o.role === "effort")?.current).toBe("high");

    await api.newQuickChat("claude-bedrock");
    const bound = await api.agentConfigDefaults("claude-bedrock");
    expect(bound.providerModel).toMatch(/claude-sonnet-4-5/);
    await expect(api.setAgentConfigDefault("claude-bedrock", "model", "haiku")).rejects.toThrow(/model provider/);
    expect(mock.configDefaults).toEqual({ default: { model: "sonnet", effort: "high" } });
  });

  it("shows the defaults in the agent's settings and saves a change at once", async () => {
    installBrowserMock({ delay: 0 });
    await api.newQuickChat("default");
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /^settings/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "Agents (ACP)" }));
    await user.click((await within(dialog).findAllByRole("button", { name: /^Claude\b/ }))[0]);
    const defaults = await within(dialog).findByRole("group", { name: "New chats start with" });
    const model = await within(defaults).findByRole("combobox", { name: "Model" });
    expect(model).toHaveTextContent("The agent's default");
    await user.click(model);
    await user.click(await screen.findByRole("option", { name: "Sonnet 4.6" }));
    await waitFor(async () => expect((await api.agentConfigDefaults("default")).defaults).toEqual({ model: "sonnet" }));
  });
});
