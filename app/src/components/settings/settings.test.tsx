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
  // The tab opens once its code is in (fetched when the dialog opened).
  await waitFor(() => expect(within(dialog).getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true"));
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
  it("shows what agents are told about yaah's UI, and turns it off", async () => {
    const { user } = renderApp();
    const dialog = await openSettings(user, "Chat");
    const teach = await within(dialog).findByRole("switch", { name: "Teach agents about yaah's UI" });
    await waitFor(() => expect(teach).toBeChecked());

    await user.click(within(dialog).getByRole("button", { name: /show what agents are told/i }));
    const routes = await within(dialog).findByRole("list", { name: "How each agent is told" });
    expect(within(routes).getByText(/ACP systemPrompt/)).toBeInTheDocument();
    expect(within(routes).getByText(/Claude Code plugin/)).toBeInTheDocument();
    expect(within(routes).getAllByText("Known after its first chat.").length).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("button", { name: /^The guide/ }));
    expect(await within(dialog).findByText(/# You are running inside yaah/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Components available now: .*test-report/)).toBeInTheDocument();

    await user.click(teach);
    await waitFor(async () => expect((await api.generalSettings()).teachAgents).toBe(false));
    await waitFor(() => expect(within(routes).queryByText(/ACP systemPrompt/)).not.toBeInTheDocument());
    expect(within(routes).getAllByText(/yaah-ui MCP server/).length).toBeGreaterThan(0);
  });

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

    await user.type(await within(dialog).findByRole("textbox", { name: "Kind of tool" }), "kind:delete");
    await user.click(within(dialog).getByRole("combobox", { name: "How its cards open" }));
    await user.click(await screen.findByRole("option", { name: "Expanded" }));
    await user.click(within(dialog).getByRole("button", { name: /add rule/i }));

    // Listed under its readable name, stored by Rust, and in effect for every card.
    expect(await within(dialog).findByText("Deletions (any)")).toBeInTheDocument();
    await waitFor(async () => expect((await api.generalSettings()).toolCards.rules["kind:delete"]).toBe("expanded"));
    await waitFor(() => expect(live["kind:delete"]).toBe("expanded"));

    await user.click(within(dialog).getByRole("button", { name: "Reset kind:delete" }));
    await waitFor(async () => expect((await api.generalSettings()).toolCards.rules["kind:delete"]).toBeUndefined());
    await waitFor(() => expect(live["kind:delete"]).toBeUndefined());
  });
});

describe("Settings → Agents", () => {
  it("shows which version of an npm-based agent runs, holds it there, and offers to restart what still runs the old one", async () => {
    const { user } = renderApp();
    const dialog = await openSettings(user, "Agents (ACP)");

    // The Claude adapter: tested pin, a newer version being checked, npx until yaah has installed it.
    await user.click(await within(dialog).findByRole("button", { name: /^Claude Code/ }));
    const version = await within(dialog).findByRole("region", { name: "Version" });
    expect(within(version).getByText("v0.99.1 · tested")).toBeInTheDocument();
    expect(within(version).getByText(/Checking v0\.100\.0/)).toBeInTheDocument();
    expect(within(version).getByText(/moves to a newer one only after that version passes yaah's checks/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Its first start runs through npx while yaah installs it once/)).toBeInTheDocument();
    expect(within(version).queryByRole("button", { name: /^Use v/ })).toBeNull();

    // Hold: frozen at this version, stored by Rust.
    await user.click(within(version).getByRole("button", { name: /hold at this version/i }));
    expect(await within(version).findByRole("button", { name: /release hold/i })).toBeInTheDocument();
    expect(within(version).getByText(/Held: yaah stays on v0\.99\.1/)).toBeInTheDocument();
    expect((await api.listAgentPresets()).find((p) => p.id === "claude")).toMatchObject({ held: true, active: "0.99.1" });

    // Holding at another version changes what runs: the running agent is restarted only if the user says so.
    const change = await api.holdAgentVersion("claude", "0.98.0");
    expect(change.running).toEqual(["default"]);
    await expect(api.holdAgentVersion("claude", "latest")).rejects.toThrow(/isn't an exact version/);
    await api.holdAgentVersion("claude", "0.99.1");

    // Release: back to the tested version.
    await user.click(within(version).getByRole("button", { name: /release hold/i }));
    expect(await within(version).findByRole("button", { name: /hold at this version/i })).toBeInTheDocument();
    expect((await api.listAgentPresets()).find((p) => p.id === "claude")).toMatchObject({ held: false, active: "0.99.1" });

    // Check for updates now.
    await user.click(within(version).getByRole("button", { name: /check for updates/i }));
    expect(await within(version).findByText("Checked just now")).toBeInTheDocument();
  });

  it("asks before restarting an agent whose version changed, and says when a failed version won't run", async () => {
    const { user } = renderApp();
    await api.holdAgentVersion("claude", "0.98.0");
    const dialog = await openSettings(user, "Agents (ACP)");
    await user.click(await within(dialog).findByRole("button", { name: /^Claude Code/ }));
    const version = await within(dialog).findByRole("region", { name: "Version" });
    expect(await within(version).findByText("v0.98.0 · not checked")).toBeInTheDocument();

    await user.click(within(version).getByRole("button", { name: /release hold/i }));
    const ask = await within(version).findByRole("group", { name: "Restart running agents" });
    expect(within(ask).getByText(/Claude still runs v0\.98\.0\. Restart now to use v0\.99\.1\?/)).toBeInTheDocument();
    await user.click(within(ask).getByRole("button", { name: "Later" }));
    expect(await within(version).findByText("v0.99.1 runs from the agent's next start.")).toBeInTheDocument();

    // Codex: its newer version failed, so the tested one keeps running.
    await user.click(within(dialog).getByRole("button", { name: /^Codex/ }));
    const codex = await within(dialog).findByRole("region", { name: "Version" });
    expect(within(codex).getByText("v2.5.0 · tested")).toBeInTheDocument();
    expect(within(codex).getByText(/v2\.6\.0 failed: session\/new signed out: .*unknown field `systemPrompt`/)).toBeInTheDocument();
  });

  it("verifies a version now: every check shows, a passing candidate runs next, a failing one stays out", async () => {
    const { user } = renderApp();
    const dialog = await openSettings(user, "Agents (ACP)");
    await user.click(await within(dialog).findByRole("button", { name: /^Claude Code/ }));
    const version = await within(dialog).findByRole("region", { name: "Version" });

    // The last run on what runs now, one line that opens to every check.
    const summary = within(version).getByRole("button", { name: /v0\.99\.1: all 12 checks passed/ });
    await user.click(summary);
    const checks = within(version).getByRole("list", { name: "Checks on v0.99.1" });
    expect(within(checks).getByText("session/new signed out")).toBeInTheDocument();
    expect(within(checks).getByText(/method not found \(-32601\)/)).toBeInTheDocument();
    expect(within(version).getByText(/npm audit .*: no advisories/)).toBeInTheDocument();
    // Tier B is there, off and not yet available.
    expect(within(version).getByRole("switch", { name: /live test/i })).toBeDisabled();
    expect(within(version).getByText("coming soon")).toBeInTheDocument();

    // The candidate passes and is promoted.
    await user.click(within(version).getByRole("button", { name: "Verify v0.100.0 now" }));
    expect(await within(version).findByText("v0.100.0 passed yaah's checks and runs from the agent's next start.")).toBeInTheDocument();
    expect(within(version).getByText("v0.100.0 · verified")).toBeInTheDocument();
    expect((await api.listAgentPresets()).find((p) => p.id === "claude")).toMatchObject({ active: "0.100.0", candidate: null });

    // Codex's candidate fails again: it stays out, and the failing check is named.
    await user.click(within(dialog).getByRole("button", { name: /^Codex/ }));
    const codex = await within(dialog).findByRole("region", { name: "Version" });
    await user.click(within(codex).getByRole("button", { name: "Verify v2.6.0 now" }));
    await user.click(await within(codex).findByRole("button", { name: /v2\.6\.0: 1 of 12 checks failed/ }));
    expect(within(codex).getByText(/got unknown field `systemPrompt`/, { selector: "span" })).toBeInTheDocument();
    expect(within(codex).getByText("v2.5.0 · tested")).toBeInTheDocument();
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

describe("Settings → MCP servers: secrets", () => {
  it("shows secret values masked, keeps one sent back unchanged, and replaces one typed over", async () => {
    const { user, mock } = renderApp();
    const dialog = await openSettings(user, "MCP servers");
    // Rust never sends the value itself.
    expect(JSON.stringify(await mcpApi.list())).not.toContain("ntk_5f2c9a8e7d1b");

    await user.click(await within(dialog).findByRole("button", { name: /^filesystem/ }));
    const key = await within(dialog).findByRole("textbox", { name: "Value of NOTES_API_KEY" });
    expect(key).toHaveValue("••••7d1b");
    expect(key).toHaveAccessibleDescription(/saved but never shown here/);
    // A value that isn't a secret is shown as it is.
    expect(within(dialog).getByLabelText("Value of LOG_LEVEL")).toHaveValue("info");

    // Saved untouched: the stored secret stays.
    await user.click(within(dialog).getByRole("radio", { name: "Only these agents" }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mock.mcpServers.find((s) => s.name === "filesystem")?.agents).toBeDefined());
    expect(mock.mcpServers.find((s) => s.name === "filesystem")?.env).toEqual({ NOTES_API_KEY: "ntk_5f2c9a8e7d1b", LOG_LEVEL: "info" });

    // Typed over (focus selects the mask, so typing replaces it): the new value is stored.
    const again = await within(dialog).findByRole("textbox", { name: "Value of NOTES_API_KEY" });
    await user.click(again);
    await user.keyboard("ntk_new_value_1234");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mock.mcpServers.find((s) => s.name === "filesystem")?.env.NOTES_API_KEY).toBe("ntk_new_value_1234"));
    // A value being typed is a password field; what Rust sends back is masked again.
    expect(within(dialog).getByLabelText("Value of NOTES_API_KEY")).toHaveAttribute("type", "password");
    expect((await mcpApi.list()).servers.find((s) => s.name === "filesystem")?.env.NOTES_API_KEY).toBe("••••1234");
  });

  it("says a renamed hidden value must be typed again, as Rust refuses it", async () => {
    const { user } = renderApp();
    const dialog = await openSettings(user, "MCP servers");
    await user.click(await within(dialog).findByRole("button", { name: /^filesystem/ }));
    const name = (await within(dialog).findAllByRole("textbox", { name: "Variable name" })).find(
      (i) => (i as HTMLInputElement).value === "NOTES_API_KEY",
    )!;
    await user.clear(name);
    await user.type(name, "NOTES_TOKEN");
    expect(within(dialog).getByText(/Renamed from NOTES_API_KEY: its hidden value can't move with it/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText(/the environment variable `NOTES_TOKEN` was hidden; type its value again/)).toBeInTheDocument();
  });
});

describe("Settings → MCP servers: catalog", () => {
  it("adds a sign-in server in one click: saved, logged in, then opened", async () => {
    const { user, mock } = renderApp();
    const dialog = await openSettings(user, "MCP servers");
    await user.click(await within(dialog).findByRole("button", { name: "Browse catalog" }));

    await user.type(within(dialog).getByRole("textbox", { name: "Search the catalog" }), "stripe");
    expect(within(dialog).queryByRole("button", { name: "Add Linear" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Add Stripe" }));
    expect(await within(dialog).findByText("Waiting for the browser…")).toBeInTheDocument();

    // Once signed in, the new server opens in the editor.
    expect(await within(dialog).findByRole("heading", { name: "stripe" }, { timeout: 3000 })).toBeInTheDocument();
    expect(mock.mcpServers.find((s) => s.name === "stripe")).toMatchObject({ transport: "http", url: "https://mcp.stripe.com" });

    // Back in the catalog it shows as added.
    await user.click(within(dialog).getByRole("button", { name: "Browse catalog" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Search the catalog" }), "stripe");
    expect(within(dialog).getByRole("button", { name: "Added as stripe" })).toBeInTheDocument();
  });

  it("opens the add form, filled in, for a server that needs a key", async () => {
    const { user } = renderApp();
    const dialog = await openSettings(user, "MCP servers");
    await user.click(await within(dialog).findByRole("button", { name: "Browse catalog" }));
    await user.click(within(dialog).getByRole("button", { name: "Add GitHub" }));

    expect(await within(dialog).findByRole("heading", { name: "Add GitHub" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "URL" })).toHaveValue("https://api.githubcopilot.com/mcp/");
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("github");
    expect(within(dialog).getByText(/personal access token/)).toBeInTheDocument();
  });
});

describe("Settings → MCP servers: sign-in", () => {
  it("signs in right after adding a server by URL, then signs out and back in from its page", async () => {
    const { user, mock } = renderApp();
    const dialog = await openSettings(user, "MCP servers");
    await user.click(within(await within(dialog).findByRole("navigation", { name: "MCP servers" })).getByRole("button", { name: "Add server" }));

    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "payments");
    await user.click(within(dialog).getByRole("combobox", { name: "Transport" }));
    await user.click(await screen.findByRole("option", { name: "HTTP (streamable)" }));
    await user.type(within(dialog).getByRole("textbox", { name: "URL" }), "https://mcp.stripe.com");
    expect(within(dialog).getByText(/your browser opens when you add it/)).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole("button", { name: "Add server" }).at(-1)!);
    expect(await within(dialog).findByRole("button", { name: /Waiting for the browser/ })).toBeInTheDocument();

    // Signed in once the browser is done.
    expect(await within(dialog).findByText("Signed in through the browser.", undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(mock.mcpServers.find((s) => s.name === "payments")?.url).toBe("https://mcp.stripe.com");

    // Signed out: one button signs in again.
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));
    const prompt = await within(dialog).findByRole("alert", { name: "Sign-in" });
    expect(within(prompt).getByText("Sign in to use it")).toBeInTheDocument();
    await user.click(within(prompt).getByRole("button", { name: "Sign in" }));
    expect(await within(dialog).findByText("Signed in through the browser.", undefined, { timeout: 4000 })).toBeInTheDocument();
  });

  it("says a server wants a token when yaah can't sign in to it", async () => {
    const { user } = renderApp();
    const dialog = await openSettings(user, "MCP servers");
    await user.click(within(await within(dialog).findByRole("navigation", { name: "MCP servers" })).getByRole("button", { name: "Add server" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "gh");
    await user.click(within(dialog).getByRole("combobox", { name: "Transport" }));
    await user.click(await screen.findByRole("option", { name: "HTTP (streamable)" }));
    await user.type(within(dialog).getByRole("textbox", { name: "URL" }), "https://api.githubcopilot.com/mcp/");
    await user.click(within(dialog).getAllByRole("button", { name: "Add server" }).at(-1)!);
    expect(await within(dialog).findByText("Needs a token")).toBeInTheDocument();
  });
});
