// The composer's permission Mode picker (components/composer-mode.tsx) against the browser mock.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "@/App";
import { installBrowserMock } from "@/dev/browser-mock";
import { api } from "@/lib/api";
import { isUnrestricted, modeOption, modeText, nextSafeMode } from "@/lib/permission-modes";
import { setCardRules } from "@/lib/tool-cards";
import { setGroupToolCalls } from "@/lib/tool-groups";

async function openChat() {
  const mock = installBrowserMock({ delay: 0 });
  setCardRules({});
  setGroupToolCalls(false);
  const c = await api.newQuickChat("default");
  Object.assign(mock.sessions[c.sessionId], { title: "seeded chat" });
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const spy = vi.spyOn(internals, "invoke");
  const user = userEvent.setup();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "seeded chat" }));
  await screen.findByRole("combobox", { name: "Message" });
  const sets = () => spy.mock.calls.filter(([n]) => n === "set_chat_config").map(([, a]) => a);
  return { user, mock, sessionId: c.sessionId, sets };
}

describe("the composer's permission mode", () => {
  it("starts on the agent's default and describes each mode in plain words", async () => {
    const { user, mock, sessionId } = await openChat();
    expect(modeOption(mock.sessions[sessionId])?.current).toBe("default");
    await user.click(screen.getByRole("button", { name: "Permissions: Ask first" }));
    const list = await screen.findByRole("listbox", { name: "Permission modes" });
    const text = within(list)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(text[0]).toBe("Ask firstAsk for edits and commands");
    expect(text[1]).toMatch(/^Accept edits.*shell commands still ask/);
    expect(text[2]).toBe("AutoThe agent decides which actions are safe and asks only about risky ones");
    expect(text[3]).toMatch(/^Plan only/);
  });

  it("a safe mode goes straight to the setter", async () => {
    const { user, sessionId, sets } = await openChat();
    await user.click(screen.getByRole("button", { name: "Permissions: Ask first" }));
    await user.click(await screen.findByRole("option", { name: /^Accept edits/ }));
    await screen.findByRole("button", { name: "Permissions: Accept edits" });
    expect(sets()).toEqual([{ sessionId, configId: "mode", value: "acceptEdits" }]);
  });

  it("bypass needs a confirmation, then shows a persistent indicator", async () => {
    const { user, sessionId, sets } = await openChat();
    await user.click(screen.getByRole("button", { name: "Permissions: Ask first" }));
    await user.click(await screen.findByRole("option", { name: /^Bypass permissions/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/without asking/);
    expect(sets()).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Keep asking" }));
    expect(sets()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Permissions: Ask first" }));
    await user.click(await screen.findByRole("option", { name: /^Bypass permissions/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop asking in this chat" }));
    const badge = await screen.findByRole("button", { name: "Permissions: Bypass permissions" });
    expect(badge).toHaveAttribute("data-unrestricted");
    expect(badge).toHaveTextContent("Not asking:");
    await waitFor(() => expect(sets()).toEqual([{ sessionId, configId: "mode", value: "bypassPermissions" }]));
  });

  it("auto goes through the confirmation, in its own words, and shows the elevated label", async () => {
    const { user, sessionId, sets } = await openChat();
    await user.click(screen.getByRole("button", { name: "Permissions: Ask first" }));
    await user.click(await screen.findByRole("option", { name: /^Auto/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("The agent decides what is safe without asking you");
    expect(sets()).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Let the agent decide in this chat" }));
    const badge = await screen.findByRole("button", { name: "Permissions: Auto" });
    expect(badge).toHaveAttribute("data-unrestricted");
    expect(badge).toHaveTextContent("Agent decides:");
    await waitFor(() => expect(sets()).toEqual([{ sessionId, configId: "mode", value: "auto" }]));
    expect(document.querySelector('[data-slot="mode-status"]')?.textContent).toContain("auto: agent decides");
  });

  it("flags only the modes that stop asking", () => {
    expect(["bypassPermissions", "full-access", "auto"].every(isUnrestricted)).toBe(true);
    expect(["default", "acceptEdits", "plan", "read-only", "automatic-review"].some(isUnrestricted)).toBe(false);
  });
});

describe("Shift+Tab and the mode label", () => {
  const label = () => document.querySelector('[data-slot="mode-status"]')?.textContent;

  it("always shows the current mode, like the CLI's status line", async () => {
    await openChat();
    await waitFor(() => expect(label()).toBe("⏵⏵ ask first on (shift+tab to cycle)"));
  });

  it("cycles the safe modes and auto in the agent's order and never lands on bypass", async () => {
    const { user, sessionId, sets } = await openChat();
    await user.click(screen.getByRole("combobox", { name: "Message" }));
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      await user.tab({ shift: true });
      await waitFor(() => expect(sets()).toHaveLength(i + 1));
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveFocus());
      seen.push((sets()[i] as { value: string }).value);
      await waitFor(() => expect(label()).toContain("(shift+tab"));
    }
    expect(seen).toEqual(["acceptEdits", "auto", "plan", "default", "acceptEdits"]);
    expect(sets().every((s) => (s as { sessionId: string }).sessionId === sessionId)).toBe(true);
    await waitFor(() => expect(label()).toBe("⏵⏵ accept edits on (shift+tab to cycle)"));
  });

  it("describes auto, and keeps an unknown mode's own name", () => {
    const o = {
      id: "mode",
      name: "Mode",
      kind: "select",
      category: "mode",
      current: "x",
      choices: [{ value: "x", name: "Turbo", description: "Fast" }],
    } as never;
    expect(modeText(o, "auto").description).toBe("The agent decides which actions are safe and asks only about risky ones");
    expect(modeText(o, "x")).toEqual({ name: "Turbo", description: "Fast" });
  });

  it("nextSafeMode skips unrestricted modes, leaves one for the first safe, and has nowhere to go with one choice", () => {
    const opt = (current: string, values: string[]) =>
      ({
        id: "mode",
        name: "Mode",
        kind: "select",
        category: "mode",
        current,
        choices: values.map((v) => ({ value: v, name: v, description: "" })),
      }) as never;
    const all = ["default", "acceptEdits", "bypassPermissions"];
    expect(nextSafeMode(opt("acceptEdits", all))).toBe("default");
    expect(nextSafeMode(opt("bypassPermissions", all))).toBe("default");
    expect(nextSafeMode(opt("default", ["default", "full-access"]))).toBeNull();
    // auto is in the cycle
    expect(nextSafeMode(opt("acceptEdits", ["default", "acceptEdits", "auto", "bypassPermissions"]))).toBe("auto");
    expect(nextSafeMode(opt("auto", ["default", "acceptEdits", "auto", "bypassPermissions"]))).toBe("default");
  });
});
