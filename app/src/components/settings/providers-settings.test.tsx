// Settings → Model providers and the agent profiles bound to them, against the
// real App and the browser mock: adding OpenRouter and Bedrock, testing them (an
// expired AWS SSO login signed in from the row), a key that never comes back,
// binding a profile with the model picker, and a bound profile that chats once
// its provider checks out.
import { screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/app";
import { api, canChat, providersApi } from "@/lib/api";

type User = ReturnType<typeof userEvent.setup>;

async function openTab(user: User, tab: string) {
  await user.click(await screen.findByRole("button", { name: /^Settings/ }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await user.click(within(dialog).getByRole("tab", { name: tab }));
  await waitFor(() => expect(within(dialog).getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true"));
  return dialog;
}

const providerRow = async (dialog: HTMLElement, label: string) =>
  within(await within(dialog).findByRole("list", { name: "Model providers" })).findByRole("listitem", { name: label });

describe("Settings → Model providers", () => {
  it("adds OpenRouter, tests it at once, and never shows the key again", async () => {
    const { user } = renderApp();
    const dialog = await openTab(user, "Model providers");
    const key = "sk-or-v1-supersecret-abc";

    await user.click(within(dialog).getByRole("button", { name: "Add OpenRouter" }));
    const form = within(dialog).getByRole("form", { name: "Add OpenRouter" });
    await user.clear(within(form).getByLabelText("Name"));
    await user.type(within(form).getByLabelText("Name"), "OpenRouter (mine)");
    const field = within(form).getByLabelText("API key");
    expect(field).toHaveAttribute("type", "password");
    await user.type(field, key);
    await user.click(within(form).getByRole("button", { name: "Add provider" }));

    // Added and tested: the key's label, limit and tier.
    const row = await providerRow(dialog, "OpenRouter (mine)");
    expect(await within(row).findByText(/OK · key sk-or-v1-abc/)).toBeInTheDocument();
    expect(within(row).getByLabelText("Test result")).toHaveTextContent('Key "sk-or-v1-abc" works · no spending limit · free tier');

    // The key is in the keychain and nowhere on screen; editing offers to replace it, not to show it.
    const stored = (await providersApi.list()).find((p) => p.label === "OpenRouter (mine)");
    expect(stored).toMatchObject({ kind: "openrouter", hasSecret: true });
    expect(JSON.stringify(stored)).not.toContain("supersecret");
    expect(document.body.textContent).not.toContain("supersecret");
    await user.click(within(row).getByRole("button", { name: "Edit" }));
    expect(within(row).getByText(/A key is saved in your keychain\. It's never shown here\./)).toBeInTheDocument();
    expect(within(row).queryByLabelText("API key")).toBeNull();
    for (const input of document.querySelectorAll("input")) expect(input.value).not.toContain("supersecret");
    await user.click(within(row).getByRole("button", { name: "Replace key" }));
    expect(within(row).getByLabelText("API key")).toHaveValue("");
  });

  it("adds Bedrock from an AWS SSO profile: region and prefix follow it, and Test shows the account and ARN", async () => {
    const { user } = renderApp();
    const dialog = await openTab(user, "Model providers");

    await user.click(within(dialog).getByRole("button", { name: "Add Amazon Bedrock" }));
    const form = within(dialog).getByRole("form", { name: "Add Amazon Bedrock" });
    expect(within(form).getByText(/stores no AWS secrets/)).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "AWS CLI v2" })).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Add provider" })).toBeDisabled();

    await user.click(within(form).getByRole("combobox", { name: "AWS profile" }));
    const sso = await screen.findByRole("option", { name: /^eu-sandbox/ });
    expect(sso).toHaveTextContent("SSO");
    await user.click(sso);
    expect(within(form).getByLabelText("Region")).toHaveValue("eu-west-1");
    expect(within(form).getByRole("combobox", { name: "Inference-profile prefix" })).toHaveTextContent("eu: EU regions");
    expect(within(form).getByLabelText("Name")).toHaveValue("Bedrock (eu-sandbox)");
    await user.click(within(form).getByRole("button", { name: "Add provider" }));

    const row = await providerRow(dialog, "Bedrock (eu-sandbox)");
    expect(await within(row).findByText(/OK · account 123456789012/)).toBeInTheDocument();
    expect(within(row).getByLabelText("Test result")).toHaveTextContent(
      /Signed in as arn:aws:sts::123456789012:assumed-role\/.* \(account 123456789012\) in eu-west-1/,
    );
    expect((await providersApi.list()).find((p) => p.label === "Bedrock (eu-sandbox)")).toMatchObject({
      kind: "bedrock",
      hasSecret: false,
      bedrock: { profile: "eu-sandbox", region: "eu-west-1", prefix: "eu" },
    });
  });

  it("signs in to an expired AWS SSO login from the row, tests again, and the bound profile can chat", async () => {
    const { user } = renderApp();
    const bound = async () => (await api.listAgents()).profiles.find((p) => p.id === "claude-bedrock");
    expect(canChat(await bound())).toBe(false);
    const dialog = await openTab(user, "Model providers");

    const row = await providerRow(dialog, "Bedrock (work)");
    expect(within(row).getByText("Expired SSO login")).toBeInTheDocument();
    expect(within(row).getByText(/Run `aws sso login --profile work-sso`/)).toBeInTheDocument();
    expect(within(row).getByText("Used by Claude · Bedrock.")).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "Sign in with AWS SSO" }));
    expect(await within(row).findByText(/OK · account 123456789012/)).toBeInTheDocument();
    expect(within(row).queryByText("Expired SSO login")).toBeNull();
    expect(await bound()).toMatchObject({ loggedIn: true, detail: "Bedrock · us-east-1 · work-sso" });
    expect(canChat(await bound())).toBe(true);

    // Test on OpenRouter: the key's label, limit and what's left.
    const openrouter = await providerRow(dialog, "OpenRouter");
    await user.click(within(openrouter).getByRole("button", { name: "Test" }));
    expect(await within(openrouter).findByLabelText("Test result")).toHaveTextContent("$14.20 of $20.00 left");
  });

  it("won't remove a provider an agent runs on, and says which; an unused one goes", async () => {
    const { user } = renderApp();
    const dialog = await openTab(user, "Model providers");

    const row = await providerRow(dialog, "Bedrock (work)");
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    expect(within(row).getByText(/“Claude · Bedrock” runs on “Bedrock \(work\)”\. Switch it to another provider/)).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Remove" })).toBeNull();
    // Rust refuses too, naming the profiles.
    await expect(providersApi.remove("bedrock-work")).rejects.toMatch(/is used by Claude · Bedrock\. Choose another model provider for it first/);
    await user.click(within(row).getByRole("button", { name: "OK" }));

    // Once nothing runs on it, it can go (with its key).
    await providersApi.setProfileProvider("opencode-openrouter", null);
    await user.click(within(dialog).getByRole("tab", { name: "Agents (ACP)" }));
    await user.click(within(dialog).getByRole("tab", { name: "Model providers" }));
    const openrouter = await providerRow(dialog, "OpenRouter");
    await user.click(within(openrouter).getByRole("button", { name: "Remove" }));
    expect(within(openrouter).getByText(/Its key is deleted from your keychain/)).toBeInTheDocument();
    await user.click(within(openrouter).getByRole("button", { name: "Remove" }));
    await waitFor(async () => expect((await providersApi.list()).map((p) => p.id)).toEqual(["bedrock-work"]));
    await waitFor(() => expect(within(dialog).queryByRole("listitem", { name: "OpenRouter" })).toBeNull());
  });
});

describe("Settings → Agents: model provider", () => {
  it("binds a new Goose profile to OpenRouter with a model picked from the searchable list, and suggests its name", async () => {
    const { user } = renderApp();
    const dialog = await openTab(user, "Agents (ACP)");
    await user.click(await within(dialog).findByRole("button", { name: /^goose/ }));

    await user.click(within(dialog).getByRole("combobox", { name: "Model provider" }));
    await user.click(await screen.findByRole("option", { name: /^OpenRouter/ }));
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Goose · OpenRouter");
    // No model yet: nothing to save.
    expect(within(dialog).getByRole("button", { name: "Add agent" })).toBeDisabled();

    await user.click(await within(dialog).findByRole("button", { name: /^Model/ }));
    const search = await within(dialog).findByRole("combobox", { name: "Model: models" });
    const list = within(dialog).getByRole("listbox", { name: "Model: models" });
    expect(within(list).getByRole("option", { name: /GPT-5 Mini/ })).toHaveTextContent("400K context");
    expect(within(list).getByRole("option", { name: /Gemini 2\.5 Pro/ })).toHaveTextContent("1M context");
    await user.type(search, "qwen");
    const qwen = await within(list).findByRole("option", { name: /Qwen3 Coder/ });
    expect(qwen).toHaveTextContent("tools");
    expect(qwen).toHaveTextContent("free");
    expect(within(list).queryByRole("option", { name: /GPT-5/ })).toBeNull();
    await user.click(qwen);
    expect(within(dialog).getByRole("button", { name: /^Model/ })).toHaveTextContent("qwen/qwen3-coder:free");

    await user.click(within(dialog).getByRole("button", { name: "Add agent" }));
    await waitFor(async () =>
      expect((await api.listAgents()).profiles.find((p) => p.label === "Goose · OpenRouter")).toMatchObject({
        preset: "goose",
        provider: { providerId: "openrouter", model: "qwen/qwen3-coder:free" },
        loggedIn: true,
        detail: "OpenRouter · yaah-dev",
      }),
    );
    // Nothing secret or provider-specific went into the profile's own env.
    expect((await api.listAgents()).profiles.find((p) => p.label === "Goose · OpenRouter")?.env).toEqual({});
  });

  it("offers Claude only Anthropic models, plus an optional small model, on an existing profile", async () => {
    const { user } = renderApp();
    const dialog = await openTab(user, "Agents (ACP)");
    await user.click(await within(dialog).findByRole("button", { name: /^Claude \(work\)/ }));

    await user.click(within(dialog).getByRole("combobox", { name: "Model provider" }));
    await user.click(await screen.findByRole("option", { name: /^OpenRouter/ }));
    // Editing keeps the name the user gave it.
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Claude (work)");
    await user.click(await within(dialog).findByRole("button", { name: /^Model/ }));
    const list = within(dialog).getByRole("listbox", { name: "Model: models" });
    expect(within(list).queryByRole("option", { name: /GPT-5/ })).toBeNull();
    await user.click(within(list).getByRole("option", { name: /Claude Sonnet 4\.5/ }));

    await user.click(within(dialog).getByRole("button", { name: /^Small, fast model/ }));
    const small = within(dialog).getByRole("listbox", { name: "Small, fast model (optional): models" });
    expect(within(small).getByRole("option", { name: /None: Claude Code's default/ })).toBeInTheDocument();
    await user.click(within(small).getByRole("option", { name: /Claude Haiku 4\.5/ }));

    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(async () =>
      expect((await api.listAgents()).profiles.find((p) => p.id === "work")?.provider).toEqual({
        providerId: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        smallModel: "anthropic/claude-haiku-4.5",
      }),
    );
    // A bound profile has no login of its own to offer.
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: /Log in…/ })).toBeNull());
  });

  it("says why a preset can't use a model provider", async () => {
    const { user } = renderApp();
    const dialog = await openTab(user, "Agents (ACP)");
    await user.click(await within(dialog).findByRole("button", { name: /^Gemini CLI/ }));
    const group = within(dialog).getByRole("group", { name: "Model provider" });
    expect(group).toHaveTextContent("Gemini CLI can't use Bedrock or OpenRouter: it runs on its own sign-in.");
    expect(within(dialog).queryByRole("combobox", { name: "Model provider" })).toBeNull();
  });
});

describe("readiness of a profile on a model provider", () => {
  it("points a failed check to Settings → Model providers instead of a login, and chats once it passes", async () => {
    const { user, mock } = renderApp();
    const sidebar = await screen.findByRole("complementary");

    // The agent menu says where each bound profile runs, or what to fix.
    await user.click(within(sidebar).getByRole("button", { name: "Start a quick chat with…" }));
    let menu = await screen.findByRole("menu", { name: /quick chat with/i });
    expect(within(menu).getByRole("menuitem", { name: /^OpenCode · OpenRouter/ })).toHaveTextContent("OpenRouter · yaah-dev");
    await user.click(within(menu).getByRole("menuitem", { name: /^Claude · Bedrock/ }));

    // Not a login dialog: Settings on the provider to fix.
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(within(dialog).getByRole("tab", { name: "Model providers" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByRole("dialog", { name: /log in/i })).toBeNull();
    const row = await providerRow(dialog, "Bedrock (work)");
    await user.click(within(row).getByRole("button", { name: "Sign in with AWS SSO" }));
    await within(row).findByText(/OK · account/);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());

    // Ready now: the quick chat starts with it.
    await user.click(within(sidebar).getByRole("button", { name: "Start a quick chat with…" }));
    menu = await screen.findByRole("menu", { name: /quick chat with/i });
    const item = within(menu).getByRole("menuitem", { name: /^Claude · Bedrock/ });
    expect(item).toHaveTextContent("Bedrock · us-east-1 · work-sso");
    await user.click(item);
    await waitFor(() => expect(Object.values(mock.sessions).at(-1)?.accountId).toBe("claude-bedrock"));
  });

  it("offers the fix in the sidebar when the picked agent's provider check failed", async () => {
    const { user } = renderApp();
    const sidebar = await screen.findByRole("complementary");
    await user.click(within(sidebar).getByRole("combobox", { name: "Agent for new chats" }));
    await user.click(await screen.findByRole("option", { name: /^Claude · Bedrock/ }));
    await user.click(await within(sidebar).findByRole("button", { name: "Fix in Settings → Model providers" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(within(dialog).getByRole("tab", { name: "Model providers" })).toHaveAttribute("aria-selected", "true"));
  });
});
