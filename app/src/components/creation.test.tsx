// Creating projects and quick chats, against the real App and the browser mock:
// the agent they start with (picked, kept on the project, changed on its page),
// the statement of work written into the brief, and the Add repos list driven
// from its search box.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { openPalette } from "@/test/palette";
import type userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMac } from "@/lib/shortcuts";
import { renderApp } from "@/test/app";

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => vi.restoreAllMocks());

/** Every Tauri command the UI sends from here on. */
function ipcCalls() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  return vi.spyOn(internals, "invoke");
}
type Calls = ReturnType<typeof ipcCalls>;
/** The arguments of each call to `cmd`, in order. */
const argsOf = (invoke: Calls, cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args as Record<string, unknown>);

/** ⌘N (Ctrl+N on Linux). */
const newChatKey = () => fireEvent.keyDown(window, { key: "n", code: "KeyN", metaKey: isMac, ctrlKey: !isMac });

async function pick(user: User, select: HTMLElement, option: RegExp) {
  await user.click(select);
  await user.click(await screen.findByRole("option", { name: option }));
}

async function openNewProject(user: User) {
  await user.click(within(await screen.findByRole("main")).getByRole("button", { name: /^New project/ }));
  return screen.findByRole("dialog", { name: "New project" });
}

describe("New project → Name and repos", () => {
  it("starts with the agent picked and writes the statement of work into the brief", async () => {
    const { user, mock } = renderApp();
    const dialog = await openNewProject(user);
    const agent = within(dialog).getByRole("combobox", { name: "Agent for the project's chats" });
    expect(agent).toHaveTextContent(/^Claude/);
    expect(agent).not.toHaveTextContent("work");

    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Refunds");
    await pick(user, agent, /^Claude \(work\)/);
    const sow = within(dialog).getByRole("textbox", { name: "Statement of work" });
    expect(sow).toHaveAccessibleDescription(/what's in and out of scope, and what “done” means/);
    await user.type(sow, "Goal: refunds in cents.{Enter}Out of scope: the UI.");
    const invoke = ipcCalls();
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New project" })).toBeNull());
    expect(argsOf(invoke, "create_project")).toEqual([
      { name: "Refunds", dirs: [], agentId: "work", statementOfWork: "Goal: refunds in cents.\nOut of scope: the UI." },
    ]);
    // The project page: its agent, and the brief with the statement under its heading, editable like the rest.
    expect(await screen.findByRole("combobox", { name: "Agent for new chats in this project" })).toHaveTextContent("Claude (work)");
    const brief = await screen.findByRole("textbox", { name: "Brief" });
    await waitFor(() => expect(brief).toHaveValue("# Refunds\n\n## Statement of work\n\nGoal: refunds in cents.\nOut of scope: the UI.\n"));
    await user.type(brief, "Done when: it ships.");
    await user.tab();
    const id = mock.projects.at(-1)!.id;
    await waitFor(() =>
      expect(mock.briefs[id]).toMatch(/## Statement of work\n\nGoal: refunds in cents\.\nOut of scope: the UI\.\nDone when: it ships\.$/),
    );

    // Its chats start with the project's agent, which the chat keeps.
    await user.click(screen.getByRole("button", { name: "New chat as Claude (work)" }));
    await waitFor(() => expect(argsOf(invoke, "new_session")).toEqual([{ projectId: id, accountId: "work", startId: expect.any(String) as string }]));
    expect(Object.values(mock.sessions).find((s) => s.projectId === id)?.accountId).toBe("work");
  });

  it("leaves the brief as it was without a statement, and ⌘↵ in the statement creates the project", async () => {
    const { user, mock } = renderApp();
    let dialog = await openNewProject(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Plain");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(mock.projects.at(-1)?.name).toBe("Plain"));
    expect(mock.briefs[mock.projects.at(-1)!.id]).toBe("# Plain\n\n");
    expect(mock.projects.at(-1)?.agentId).toBe("default");

    await user.click(within(screen.getByRole("complementary")).getByRole("button", { name: "New project" }));
    dialog = await screen.findByRole("dialog", { name: "New project" });
    expect(within(dialog).getByRole("textbox", { name: "Statement of work" })).toHaveValue("");
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Keyed");
    await user.type(
      within(dialog).getByRole("textbox", { name: "Statement of work" }),
      isMac ? "Ship it.{Meta>}{Enter}{/Meta}" : "Ship it.{Control>}{Enter}{/Control}",
    );
    await waitFor(() => expect(mock.projects.at(-1)?.name).toBe("Keyed"));
    expect(mock.briefs[mock.projects.at(-1)!.id]).toBe("# Keyed\n\n## Statement of work\n\nShip it.\n");
  });
});

describe("a project's agent", () => {
  it("is changed on the project page; ⌘N and New chat use it, and one chat can use another", async () => {
    const { user, mock } = renderApp();
    // The seeded project is from before agents: it follows the sidebar's.
    await user.click(within(await screen.findByRole("complementary")).getByRole("button", { name: "billing revamp" }));
    const agent = await screen.findByRole("combobox", { name: "Agent for new chats in this project" });
    expect(agent).toHaveTextContent(/^Claude/);
    const invoke = ipcCalls();
    await pick(user, agent, /^Claude \(work\)/);
    await waitFor(() => expect(argsOf(invoke, "set_project_agent")).toEqual([{ id: "p1", agentId: "work" }]));
    expect(mock.projects[0].agentId).toBe("work");
    expect(await screen.findByRole("button", { name: "New chat as Claude (work)" })).toBeEnabled();
    // The sidebar's pick is untouched.
    expect(screen.getByRole("combobox", { name: "Agent for new chats" })).not.toHaveTextContent("work");

    newChatKey();
    await waitFor(() =>
      expect(argsOf(invoke, "new_session")).toEqual([{ projectId: "p1", accountId: "work", startId: expect.any(String) as string }]),
    );

    // Back on the project: one chat with another agent, and the project keeps its own.
    await user.click(within(screen.getByRole("complementary")).getByRole("button", { name: "billing revamp" }));
    await user.click(await screen.findByRole("button", { name: "New chat with…" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /^Claude \(work\)/ })).toHaveTextContent("project's");
    await user.click(within(menu).getByRole("menuitem", { name: /^Claude\s*dev@example\.com/ }));
    await waitFor(() =>
      expect(argsOf(invoke, "new_session").at(-1)).toEqual({ projectId: "p1", accountId: "default", startId: expect.any(String) as string }),
    );
    expect(mock.projects[0].agentId).toBe("work");
  });

  it("is the one picked when starting from an issue", async () => {
    const { user, mock } = renderApp();
    await openPalette();
    await user.keyboard("from an issue");
    await user.click(await screen.findByRole("option", { name: /New project from an issue/ }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await pick(user, within(dialog).getByRole("combobox", { name: "Agent for the project's chats" }), /^Claude \(work\)/);
    const invoke = ipcCalls();
    await user.click(await within(dialog).findByRole("option", { name: /Webhook retries fire twice/ }));
    await waitFor(() => expect(argsOf(invoke, "start_project_from_item")).toEqual([{ service: "github", id: "acme/api#212", accountId: "work" }]));
    await waitFor(() => expect(mock.projects.at(-1)?.agentId).toBe("work"));
  });
});

describe("quick chats", () => {
  it("start with an agent picked from the sidebar, the home screen or the palette; ⌘N keeps the current one", async () => {
    const { user, mock } = renderApp();
    const invoke = ipcCalls();
    const quick = () => argsOf(invoke, "new_quick_chat").map((a) => a.accountId);

    // The sidebar's Chats header.
    const sidebar = await screen.findByRole("complementary");
    await user.click(within(sidebar).getByRole("button", { name: "Start a quick chat with…" }));
    let menu = await screen.findByRole("menu", { name: /quick chat with/i });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual([
      expect.stringMatching(/^Claudedev@example\.com/),
      expect.stringMatching(/^Claude \(work\)dev@work\.example$/),
      expect.stringMatching(/^Claude \(personal\)not logged in$/),
      // Profiles on a model provider say where they run, or what to fix.
      expect.stringMatching(/^OpenCode · OpenRouterOpenRouter · yaah-dev$/),
      expect.stringMatching(/^Claude · Bedrockfix in Settings → Model providers$/),
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: /^Claude \(work\)/ }));
    await waitFor(() => expect(quick()).toEqual(["work"]));
    // Persisted on the chat; the sidebar's pick stays.
    expect(Object.values(mock.sessions).at(-1)?.accountId).toBe("work");
    expect(screen.getByRole("combobox", { name: "Agent for new chats" })).not.toHaveTextContent("work");

    // ⌘N: the current agent.
    newChatKey();
    await waitFor(() => expect(quick()).toEqual(["work", "default"]));

    // The palette's "New quick chat with…".
    await openPalette();
    await user.keyboard("quick chat with");
    await user.click(await screen.findByRole("option", { name: /New quick chat with…/ }));
    await user.click(await screen.findByRole("option", { name: /^Claude \(work\)/ }));
    await waitFor(() => expect(quick()).toEqual(["work", "default", "work"]));

    // An agent that isn't logged in asks for a login instead.
    await user.click(within(sidebar).getByRole("button", { name: "Start a quick chat with…" }));
    menu = await screen.findByRole("menu", { name: /quick chat with/i });
    await user.click(within(menu).getByRole("menuitem", { name: /^Claude \(personal\)/ }));
    expect(await screen.findByRole("dialog", { name: /Log in/ })).toBeInTheDocument();
    expect(quick()).toHaveLength(3);
  });

  it("start from the home screen's split button", async () => {
    const { user, mock } = renderApp();
    const home = await screen.findByRole("main");
    await user.click(within(home).getByRole("button", { name: "Start a quick chat with…" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Claude \(work\)/ }));
    await waitFor(() => expect(Object.values(mock.sessions).at(-1)?.accountId).toBe("work"));
  });
});

describe("Add repos", () => {
  /** The New project dialog's Add repos picker, its repos listed. */
  async function openPicker(user: User) {
    const dialog = await openNewProject(user);
    await user.click(within(dialog).getByRole("button", { name: "Add repos" }));
    const picker = await screen.findByRole("dialog", { name: "Add repos" });
    const list = within(picker).getByRole("listbox", { name: "Repos" });
    await within(list).findByRole("option", { name: /^docs/ });
    return { dialog, picker, list, search: within(picker).getByRole("combobox", { name: "Search repos" }) };
  }
  const active = (search: HTMLElement) => document.getElementById(search.getAttribute("aria-activedescendant") ?? "");
  const repoName = (el: Element | null) => el?.querySelector(".font-medium")?.textContent;

  it("is driven from the search box: arrows, Space, Enter, ⌘↵", async () => {
    const { user } = renderApp();
    const { dialog, picker, list, search } = await openPicker(user);
    // Focus starts in the search (not the header's "add folder"), on the first repo.
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute("aria-controls", list.id);
    expect(repoName(active(search))).toBe("api");
    expect(search).toHaveAccessibleDescription(/move.*select.*add.*close/);

    // ↓/↑ move the highlight (it stops at the ends); Space ticks, and never types.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(repoName(active(search))).toBe("infra");
    expect(active(search)).toHaveAttribute("data-highlighted");
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(repoName(active(search))).toBe("api");
    await user.keyboard(" ");
    expect(search).toHaveValue("");
    expect(active(search)).toHaveAttribute("aria-selected", "true");
    await user.keyboard(" ");
    expect(active(search)).toHaveAttribute("aria-selected", "false");

    // Typing filters and puts the highlight back on the first match; Enter ticks it.
    await user.keyboard("{ArrowDown}");
    await user.type(search, "do");
    expect(repoName(active(search))).toBe("docs");
    await user.keyboard("{Enter}");
    expect(within(list).getByRole("option", { name: /^docs/ })).toHaveAttribute("aria-selected", "true");
    // The mouse moves the highlight too.
    await user.clear(search);
    await user.hover(within(list).getByRole("option", { name: /^web/ }));
    expect(repoName(active(search))).toBe("web");
    await user.keyboard(" ");

    // ⌘/Ctrl+Enter adds the selection.
    await user.keyboard(isMac ? "{Meta>}{Enter}{/Meta}" : "{Control>}{Enter}{/Control}");
    await waitFor(() => expect(picker).not.toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: "Remove docs" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove web" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "New project" })).toBeInTheDocument();
  });

  it("adds the only match on Enter, skips repos already added, and closes on Esc", async () => {
    const { user } = renderApp();
    const first = await openPicker(user);
    const { dialog } = first;
    let { search, list } = first;
    await user.type(search, "infra");
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add repos" })).toBeNull());
    expect(within(dialog).getByRole("button", { name: "Remove infra" })).toBeInTheDocument();

    // Again: infra is listed as added, and the highlight never lands on it.
    await user.click(within(dialog).getByRole("button", { name: "Add repos" }));
    const picker = await screen.findByRole("dialog", { name: "Add repos" });
    ({ search, list } = { search: within(picker).getByRole("combobox", { name: "Search repos" }), list: within(picker).getByRole("listbox") });
    await within(list).findByRole("option", { name: /^docs/ });
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(repoName(active(search))).toBe("api-billing");
    expect(within(list).getByRole("option", { name: /^infra/ })).toHaveAttribute("aria-disabled", "true");

    // Esc closes the picker, not the New project dialog.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add repos" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "New project" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove infra" })).toBeInTheDocument();
  });

  it("clones without creating the project around it", async () => {
    const { user, mock } = renderApp();
    const { picker } = await openPicker(user);
    const before = mock.projects.length;
    const invoke = ipcCalls();
    await user.type(within(picker).getByRole("textbox", { name: /Clone a repo/ }), "acme/billing{Enter}");
    await within(picker).findByRole("option", { name: /^billing/ }, { timeout: 5000 });
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toContain("clone_repo");
    expect(mock.projects).toHaveLength(before);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain("create_project");
    // Still open behind the picker (hidden from the accessibility tree while the picker is up).
    expect(screen.getByRole("heading", { name: "New project", hidden: true })).toBeInTheDocument();
  });
});
