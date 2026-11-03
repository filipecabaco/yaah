// Projects from tracker items, against the real App and the browser mock
// (src/dev/mock/work-items.ts): the "From an issue" picker, starting a project
// with its prompt drafted (never sent), and the linked item on the project page.
import { screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { renderApp } from "@/test/app";

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => vi.restoreAllMocks());

/** Every Tauri command the UI sends from here on. */
function ipcCalls() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  return vi.spyOn(internals, "invoke");
}

/** ⌘K → "New project from an issue…": the dialog on its picker, once the queue is in. */
async function openPicker(user: User) {
  await user.click(await screen.findByRole("button", { name: /^Search/ }));
  await user.keyboard("from an issue");
  await user.click(await screen.findByRole("option", { name: /New project from an issue/ }));
  const dialog = await screen.findByRole("dialog", { name: "New project" });
  const list = within(dialog).getByRole("listbox", { name: "Issues" });
  await within(list).findByRole("option", { name: /Webhook retries fire twice/ });
  return { dialog, list, search: within(dialog).getByRole("combobox", { name: "Search issues" }) };
}

const titles = (list: HTMLElement) =>
  within(list)
    .queryAllByRole("option")
    .map((o) => o.getAttribute("aria-label"));

describe("New project → From an issue", () => {
  it("lists your queue across services, filters it, and resolves a pasted URL", async () => {
    const { user } = renderApp();
    const { dialog, list, search } = await openPicker(user);

    // GitHub, Linear issues and Linear projects; GitLab's token is revoked.
    expect(titles(list)).toEqual(
      expect.arrayContaining([
        "acme/api#212 Webhook retries fire twice after a timeout",
        "ENG-142 Partial refunds return the whole order",
        "8a1f2c3d4e5f Billing revamp",
      ]),
    );
    const row = within(list).getByRole("option", { name: /^ENG-142/ });
    expect(row).toHaveTextContent("Linear");
    expect(row).toHaveTextContent("In Progress");
    expect(row).toHaveTextContent("billing");
    expect(row).toHaveTextContent("start →");

    // Assigned to you, then what you created.
    await user.click(within(dialog).getByRole("tab", { name: "Created" }));
    expect(titles(list).sort()).toEqual(["ENG-137 Currency rounding in totals", "acme/infra#31 Move staging database to Postgres 17"]);
    await user.click(within(dialog).getByRole("tab", { name: "All" }));

    // Fuzzy over "service id title".
    await user.type(search, "linear partial");
    expect(titles(list)[0]).toBe("ENG-142 Partial refunds return the whole order");
    expect(titles(list)).not.toContain("acme/api#212 Webhook retries fire twice after a timeout");

    // A pasted URL for an issue that isn't in your queue.
    await user.clear(search);
    await user.click(search);
    await user.paste("https://github.com/acme/mobile/issues/412");
    expect(await within(list).findByRole("option", { name: "acme/mobile#412 Crash on sign-in with SSO on Android 15" })).toBeInTheDocument();

    // Something that isn't an issue says what it expected.
    await user.clear(search);
    await user.paste("https://example.com/nope");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/expected a GitHub or GitLab issue URL/);
  });

  it("starts a project from an issue, opens its chat with the prompt drafted, and sends nothing", async () => {
    const { user } = renderApp();
    const { search } = await openPicker(user);
    const invoke = ipcCalls();

    await user.type(search, "webhook");
    await user.keyboard("{Enter}");

    // The dialog closes on the new project's chat, with the prompt in the composer.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New project" })).toBeNull());
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await waitFor(() => expect(composer).toHaveValue("Work on acme/api#212: Webhook retries fire twice after a timeout"));
    expect(invoke).toHaveBeenCalledWith("start_project_from_item", { service: "github", id: "acme/api#212", accountId: "default" }, undefined);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain("send_prompt");
    expect(screen.queryByText("Work on acme/api#212: Webhook retries fire twice after a timeout", { selector: "[role=log] *" })).toBeNull();

    // The project is named after the issue, follows it, and has its local clones.
    const sidebar = screen.getByRole("complementary");
    await user.click(await within(sidebar).findByRole("button", { name: "#212 Webhook retries fire twice after a timeout" }));
    expect(await screen.findByRole("button", { name: "Open GitHub · acme/api#212 in the browser" })).toBeInTheDocument();
    expect(screen.getByText("api-billing")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project status" })).toHaveTextContent("planning");
  });

  it("opens the project that already follows an item instead of making another", async () => {
    const { user } = renderApp();
    const { list } = await openPicker(user);
    const invoke = ipcCalls();

    const linked = within(list).getByRole("option", { name: "8a1f2c3d4e5f Billing revamp" });
    expect(linked).toHaveTextContent("open →");
    await user.click(linked);

    expect(await screen.findByRole("textbox", { name: "Project name" })).toHaveValue("billing revamp");
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain("start_project_from_item");
  });

  it("shows a service's auth error with Reconnect, which opens its settings", async () => {
    const { user } = renderApp();
    const { dialog } = await openPicker(user);

    const errors = within(dialog).getByRole("list", { name: "Services that didn't answer" });
    expect(errors).toHaveTextContent(/GitLab refused the credential/);
    await user.click(within(errors).getByRole("button", { name: "Reconnect GitLab" }));

    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(await within(settings).findByRole("heading", { name: "GitLab" })).toBeInTheDocument();
    expect(within(settings).getByLabelText("Personal access token")).toBeInTheDocument();

    // A new token brings GitLab's issues back.
    await user.type(within(settings).getByLabelText("Personal access token"), "glpat-new");
    await user.click(within(settings).getByRole("button", { name: "Check and save" }));
    await user.keyboard("{Escape}");
    const { list } = await openPicker(user);
    expect(within(list).getByRole("option", { name: /platform\/payments-gateway#19/ })).toHaveTextContent("GitLab");
  });
});

describe("New project → From an issue, with no tracker connected", () => {
  it("points to Settings → Integrations", async () => {
    const { user } = renderApp();
    await screen.findByRole("button", { name: "billing revamp" });
    for (const service of ["github", "linear", "gitlab"]) await api.integrationDisconnect(service);

    await user.click(screen.getByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await user.click(within(dialog).getByRole("tab", { name: "From an issue" }));
    expect(await within(dialog).findByText("No tracker connected")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Open Settings → Integrations" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "New project" })).toBeNull();
  });
});

describe("a project that follows an issue", () => {
  it("shows the pill and the item live, refreshes it, and unlinks after confirming", async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole("button", { name: "billing revamp" }));

    // The pill by the name, and the Linear project through the yaah pack's component.
    expect(await screen.findByRole("button", { name: "Open Linear project · Billing revamp in the browser" })).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "Linked project" });
    expect(await within(section).findByText("ENG-139")).toBeInTheDocument();
    expect(within(section).getByText("Progress · 58%")).toBeInTheDocument();
    expect(within(section).getByText("synced 3 h ago")).toBeInTheDocument();
    const brief = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Brief" });
    await waitFor(() => expect(brief.value).toContain("**Source:** Linear project"));

    await user.click(within(section).getByRole("button", { name: "Refresh from project" }));
    expect(await within(section).findByText("synced just now")).toBeInTheDocument();

    // Unlink asks first; Keep leaves it.
    await user.click(within(section).getByRole("button", { name: "Unlink" }));
    const confirm = within(section).getByRole("group", { name: "Unlink" });
    await user.click(within(confirm).getByRole("button", { name: "Keep" }));
    expect(within(section).queryByRole("group", { name: "Unlink" })).toBeNull();

    await user.click(within(section).getByRole("button", { name: "Unlink" }));
    await user.click(within(within(section).getByRole("group", { name: "Unlink" })).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Linked project" })).toBeNull());
    expect(screen.queryByRole("button", { name: /in the browser$/ })).toBeNull();
    await waitFor(() => expect(brief.value).not.toContain("yaah:source"));
    expect(brief.value).toContain("Move invoices to the new pricing model.");
  });
});
