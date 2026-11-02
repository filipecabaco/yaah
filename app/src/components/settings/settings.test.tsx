// Settings against the real App and the browser mock: what the user changes is
// what Rust is asked to store, and what the app applies.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/app";
import { api, mcpApi } from "@/lib/api";
import { useCardRules } from "@/lib/tool-cards";

async function openSettings(user: ReturnType<typeof renderApp>["user"], tab: string) {
  await user.click(await screen.findByRole("button", { name: /^settings/i }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("tab", { name: tab }));
  expect(within(dialog).getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
  return dialog;
}

describe("Settings → General", () => {
  it("switches appearance and picks a dark theme, which the app applies and Rust stores", async () => {
    const { user } = renderApp();
    const dialog = await openSettings(user, "General");

    await user.click(await within(dialog).findByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    expect((await api.generalSettings()).appearance).toBe("dark");

    // The dark-mode picker: search the bundled themes and pick one.
    const pickers = within(dialog).getAllByRole("button", { expanded: false, name: /yaah/i });
    await user.click(pickers[pickers.length - 1]);
    await user.type(await screen.findByRole("combobox", { name: "Dark mode themes" }), "dracula");
    await user.click(await screen.findByRole("option", { name: /^Dracula Theme(?! Soft)/ }));

    await waitFor(async () => expect((await api.generalSettings()).theme).toEqual({ light: "yaah", dark: "shiki:dracula" }));
    // Its colours are applied as plain rgb() values on the root.
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--background")).toMatch(/^rgb\(\d+ \d+ \d+\)$/));
    expect(within(dialog).getByRole("button", { name: /^Dracula Theme(?! Soft)/ })).toBeInTheDocument();

    // Back to System clears the forced mode.
    await user.click(within(dialog).getByRole("radio", { name: "System" }));
    expect((await api.generalSettings()).appearance).toBe("system");
  });
});

describe("Settings → Chat", () => {
  it("adds a tool-card rule that cards follow at once, and resets it", async () => {
    const { user } = renderApp();
    let live: ReturnType<typeof useCardRules> = {};
    function Probe() {
      live = useCardRules();
      return null;
    }
    const { render } = await import("@testing-library/react");
    render(<Probe />);
    const dialog = await openSettings(user, "Chat");

    await user.type(await within(dialog).findByRole("textbox", { name: "Kind of tool" }), "kind:execute");
    await user.click(within(dialog).getByRole("combobox", { name: "How its cards open" }));
    await user.click(await screen.findByRole("option", { name: "Expanded" }));
    await user.click(within(dialog).getByRole("button", { name: /add rule/i }));

    // Listed under its readable name, stored by Rust, and in effect for every card.
    expect(await within(dialog).findByText("Commands (any)")).toBeInTheDocument();
    await waitFor(async () => expect((await api.generalSettings()).toolCards.rules["kind:execute"]).toBe("expanded"));
    await waitFor(() => expect(live["kind:execute"]).toBe("expanded"));

    await user.click(within(dialog).getByRole("button", { name: "Reset kind:execute" }));
    await waitFor(async () => expect((await api.generalSettings()).toolCards.rules["kind:execute"]).toBeUndefined());
    await waitFor(() => expect(live["kind:execute"]).toBeUndefined());
  });
});

describe("Settings → MCP servers", () => {
  it('limits a server to one agent with "Available to"', async () => {
    const { user } = renderApp();
    const dialog = await openSettings(user, "MCP servers");

    await user.click(await within(dialog).findByRole("button", { name: /^filesystem/ }));
    const availableTo = await within(dialog).findByRole("radiogroup", { name: "Available to" });
    expect(within(availableTo).getByRole("radio", { name: "All agents" })).toBeChecked();

    await user.click(within(availableTo).getByRole("radio", { name: "Only these agents" }));
    // The first agent is ticked to start with; swap it for the work account.
    const first = await within(dialog).findByRole("checkbox", { name: /^Claude ?Claude Code/ });
    expect(first).toBeChecked();
    await user.click(within(dialog).getByRole("checkbox", { name: /^Claude \(work\)/ }));
    await user.click(first);

    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(async () => {
      const saved = (await mcpApi.list()).servers.find((s) => s.name === "filesystem");
      expect(saved?.agents).toEqual(["work"]);
    });

    // And back to every agent.
    await user.click(within(dialog).getByRole("radio", { name: "All agents" }));
    expect(within(dialog).queryByRole("checkbox", { name: /^Claude \(work\)/ })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(async () => {
      const saved = (await mcpApi.list()).servers.find((s) => s.name === "filesystem");
      expect(saved?.agents ?? []).toEqual([]);
    });
  });
});
