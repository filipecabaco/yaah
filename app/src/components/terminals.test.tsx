// Terminals against the real App and the browser mock's fake terminals: the home
// screen's New terminal, the pane picker, ⌘K and ⌘T, a terminal pane saved and
// restored, the app shortcuts a terminal leaves to the app (and the keys it keeps),
// "Open in terminal", and an agent's command live in its tool card with Stop.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { TranscriptEntry } from "@/components/entries";
import { setTerminalEngine } from "@/components/terminal/engine";
import { QUICK_EXIT_MS, RESTARTED_NOTE } from "@/components/terminal/terminal-pane";
import { installBrowserMock } from "@/dev/browser-mock";
import { startAgentTerminal } from "@/dev/mock/terminals";
import { inProject, originOf } from "@/components/terminal/use-terminals";
import type { Entry, Project, SessionInfo } from "@/lib/api";
import { panesOf, type Layout } from "@/lib/layout";
import { handleDragEvent } from "@/lib/attachments";
import { isMac } from "@/lib/shortcuts";
import { renderApp } from "@/test/app";
import { textEngine } from "@/test/text-engine";

beforeEach(() => setTerminalEngine(textEngine));
afterEach(() => setTerminalEngine(null));

/** A ⌘ shortcut (Ctrl on Linux) pressed where the keyboard is. */
function press(key: string, code: string, opts: { shift?: boolean } = {}) {
  fireEvent.keyDown(document.activeElement ?? window, { key, code, metaKey: isMac, ctrlKey: !isMac, shiftKey: !!opts.shift, bubbles: true });
}
/** An app shortcut pressed inside a terminal: ⌘ on macOS, Ctrl+Shift on Linux (Ctrl alone is the shell's). */
function pressInTerminal(key: string, code: string) {
  fireEvent.keyDown(document.activeElement ?? window, { key, code, metaKey: isMac, ctrlKey: !isMac, shiftKey: !isMac, bubbles: true });
}

const paneEls = () => [...document.querySelectorAll<HTMLElement>("[data-pane-id]")];
const terminalPanes = () => paneEls().filter((p) => p.querySelector("[data-terminal]"));
const textIn = (el: HTMLElement) => el.querySelector("[data-terminal-text]")?.textContent ?? "";

async function started() {
  const r = renderApp();
  await screen.findByRole("button", { name: /^quick chat\b(?!s)/i });
  return r;
}

/** Start a quick chat (the mock has none at first); its info. */
async function withChat() {
  const r = await started();
  await r.user.click(screen.getByRole("button", { name: /^quick chat\b(?!s)/i }));
  await screen.findByRole("combobox", { name: "Message" });
  await waitFor(() => expect(Object.keys(r.mock.sessions)).toHaveLength(1));
  return { ...r, chat: Object.values(r.mock.sessions)[0] };
}

describe("terminal panes", () => {
  it("open from the home screen in the default folder, and run what's typed", async () => {
    const { user, mock } = await started();
    await user.click(screen.getByRole("button", { name: /new terminal/i }));
    await waitFor(() => expect(terminalPanes()).toHaveLength(1));
    const pane = terminalPanes()[0];
    await waitFor(() => expect(textIn(pane)).toContain("dev@yaah %"));
    // The home pane became the terminal: no split.
    expect(paneEls()).toHaveLength(1);
    expect(within(pane).getByText("~")).toBeInTheDocument();
    const input = within(pane).getByRole("textbox", { name: "Terminal input" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.type(input, "echo hello yaah{Enter}");
    await waitFor(() => expect(textIn(pane)).toContain("hello yaah\ndev@yaah %"));
    expect(Object.values(mock.terminalInput).flat().join("")).toBe("echo hello yaah\r");
  });

  it("open from the pane picker in a folder picked there", async () => {
    const { user, mock } = await started();
    press("d", "KeyD");
    const picker = await screen.findByRole("combobox", { name: /search chats and projects/i });
    await user.click(await screen.findByRole("option", { name: /new terminal/i }));
    // The folder step: a project's repos, chats' folders, the default, or browse.
    const project = mock.projects.find((p) => p.dirs.length > 0)!;
    const [repo] = await screen.findAllByRole("option", { name: new RegExp(project.name) });
    await user.click(repo);
    await waitFor(() => expect(terminalPanes()).toHaveLength(1));
    expect(picker).not.toBeInTheDocument();
    await waitFor(() => expect(Object.values(mock.terminals).some((t) => t.cwd === project.dirs[0])).toBe(true));
  });

  it("open from ⌘K, in the default folder or the focused chat's", async () => {
    const { user, mock, chat } = await withChat();
    press("k", "KeyK");
    await user.click(await screen.findByRole("option", { name: /^new terminal here/i }));
    await waitFor(() => expect(terminalPanes()).toHaveLength(1));
    expect(paneEls()).toHaveLength(2);
    await waitFor(() => expect(Object.values(mock.terminals).map((t) => t.cwd)).toContain(chat.cwd));

    // The keyboard is in the new terminal now: the app's ⌘K from there.
    pressInTerminal("k", "KeyK");
    const palette = await screen.findByRole("dialog");
    await user.click(within(palette).getByRole("option", { name: /^new terminal in the default folder/i }));
    await waitFor(() => expect(terminalPanes()).toHaveLength(2));
  });

  it("⌘T opens one to the right of a chat, in its folder", async () => {
    const { mock, chat } = await withChat();
    press("t", "KeyT");
    await waitFor(() => expect(paneEls()).toHaveLength(2));
    const [left, right] = paneEls();
    expect(within(left).getByRole("combobox", { name: "Message" })).toBeInTheDocument();
    await waitFor(() => expect(right.querySelector("[data-terminal]")).not.toBeNull());
    expect(right).toHaveAttribute("data-focused");
    await waitFor(() => expect(Object.values(mock.terminals).map((t) => t.cwd)).toContain(chat.cwd));
  });

  it("is saved with the layout, and comes back as a new shell in the same folder after a restart", async () => {
    const { user, mock, unmount } = await started();
    await user.click(screen.getByRole("button", { name: /new terminal/i }));
    await waitFor(() => {
      const root = mock.layout?.root;
      expect(root?.type === "pane" && root.content?.kind === "terminal" && root.content.id).toBeTruthy();
    });
    const saved = mock.layout!;
    expect(saved.root.type === "pane" && saved.root.content).toMatchObject({ kind: "terminal", cwd: "/Users/dev" });
    unmount();

    // A new start: Rust has no shell by that id any more.
    const state = installBrowserMock({ delay: 0 });
    state.layout = structuredClone(saved);
    if (state.layout.root.type === "pane" && state.layout.root.content?.kind === "terminal") state.layout.root.content.cwd = "/Users/dev/workspace";
    render(<App />);
    expect(await screen.findByText(RESTARTED_NOTE)).toBeInTheDocument();
    await waitFor(() => expect(Object.values(state.terminals).map((t) => t.cwd)).toEqual(["/Users/dev/workspace"]));
    await waitFor(() => {
      const c = state.layout?.root.type === "pane" ? state.layout.root.content : null;
      expect(c?.kind === "terminal" && c.id && state.terminals[c.id]).toBeTruthy();
    });
  });
});

describe("a terminal opened from a project", () => {
  const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });
  const projectList = (name: string) => within(sidebar()).queryByRole("list", { name: `Open panes in ${name}` });
  const openPanesGroup = () => within(sidebar()).queryByRole("region", { name: "Open panes" });
  /** The saved terminal panes' contents. */
  const savedTerminals = (layout: Layout | null) =>
    layout ? panesOf(layout.root).flatMap((p) => (p.content?.kind === "terminal" ? [p.content] : [])) : [];

  /** A chat in the mock's project (billing revamp: api, web), from its page. */
  async function projectChat() {
    const r = await started();
    await r.user.click(within(sidebar()).getByRole("button", { name: "billing revamp" }));
    await r.user.click(await screen.findByRole("button", { name: /^New chat as/ }));
    await screen.findByRole("combobox", { name: "Message" });
    await waitFor(() => expect(Object.values(r.mock.sessions)).toHaveLength(1));
    return { ...r, project: r.mock.projects[0] };
  }

  it("from a project chat starts in the project's repo and is listed under the project, not in Open panes", async () => {
    const { mock, project } = await projectChat();
    press("t", "KeyT");
    await waitFor(() => expect(terminalPanes()).toHaveLength(1));
    await waitFor(() => expect(Object.values(mock.terminals).map((t) => t.cwd)).toContain(project.dirs[0]));
    const list = await waitFor(() => {
      const l = projectList(project.name);
      expect(l).not.toBeNull();
      return l!;
    });
    const row = within(list).getByRole("button", { name: /^Terminal:/ });
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveAccessibleName(/Terminal: api/);
    expect(openPanesGroup()).toBeNull();
    // Saved with its project, and with its shell once open.
    await waitFor(() => {
      const [t, ...more] = savedTerminals(mock.layout);
      expect(more).toHaveLength(0);
      expect(t).toMatchObject({ cwd: project.dirs[0], projectId: project.id });
      expect(t.id).toBeTruthy();
    });
  });

  it("from a quick chat stays in Open panes, with no project", async () => {
    const { mock, chat } = await withChat();
    press("t", "KeyT");
    const group = await waitFor(() => {
      const g = openPanesGroup();
      expect(g).not.toBeNull();
      return g!;
    });
    expect(within(group).getByRole("button", { name: /^Terminal:/ })).toBeInTheDocument();
    expect(projectList("billing revamp")).toBeNull();
    await waitFor(() => expect(savedTerminals(mock.layout)).toEqual([expect.objectContaining({ cwd: chat.cwd })]));
    expect(savedTerminals(mock.layout)[0]).not.toHaveProperty("projectId");
  });

  it("from the project's page or its sidebar menu belongs to the project too", async () => {
    const { user, mock } = await started();
    const project = mock.projects[0];
    await user.click(within(sidebar()).getByRole("button", { name: project.name }));
    await user.click(await screen.findByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(terminalPanes()).toHaveLength(1));
    // To the right of the project page.
    expect(paneEls()).toHaveLength(2);
    fireEvent.contextMenu(within(sidebar()).getByRole("button", { name: project.name }));
    await user.click(await screen.findByRole("menuitem", { name: "New terminal" }));
    await waitFor(() => expect(terminalPanes()).toHaveLength(2));
    await waitFor(() => expect(within(projectList(project.name)!).getAllByRole("button", { name: /^Terminal:/ })).toHaveLength(2));
    expect(openPanesGroup()).toBeNull();
    await waitFor(() =>
      expect(savedTerminals(mock.layout).map((t) => [t.cwd, t.projectId])).toEqual([
        [project.dirs[0], project.id],
        [project.dirs[0], project.id],
      ]),
    );
  });

  it("keeps its project after a restart", async () => {
    const { mock, project, unmount } = await projectChat();
    press("t", "KeyT");
    await waitFor(() => expect(savedTerminals(mock.layout)[0]?.id).toBeTruthy());
    const saved = structuredClone(mock.layout!);
    unmount();

    // A fresh mock: the chat beside it is gone (its pane is dropped), the project and the link are not.
    const state = installBrowserMock({ delay: 0 });
    state.layout = saved;
    render(<App />);
    expect(await screen.findByText(RESTARTED_NOTE)).toBeInTheDocument();
    const list = await waitFor(() => {
      const l = projectList(project.name);
      expect(l).not.toBeNull();
      return l!;
    });
    expect(within(list).getByRole("button", { name: /^Terminal:/ })).toBeInTheDocument();
    expect(openPanesGroup()).toBeNull();
    // The new shell's id is saved; the link stays.
    await waitFor(() => {
      const [t] = savedTerminals(state.layout);
      expect(t?.id && state.terminals[t.id]).toBeTruthy();
      expect(t?.projectId).toBe(project.id);
    });
  });

  it("moves to Open panes, still running, when its project is deleted", async () => {
    const { user, mock, project } = await projectChat();
    press("t", "KeyT");
    await waitFor(() => expect(projectList(project.name)).not.toBeNull());
    const pane = terminalPanes()[0];
    await waitFor(() => expect(textIn(pane)).toContain("dev@yaah %"));
    // Back in the chat's pane: the project's Delete… opens its page there, with the confirmation.
    await user.click(screen.getByRole("combobox", { name: "Message" }));
    await user.click(within(sidebar()).getByRole("button", { name: `Delete ${project.name}` }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const group = await waitFor(() => {
      const g = openPanesGroup();
      expect(g).not.toBeNull();
      return g!;
    });
    expect(within(group).getByRole("button", { name: /^Terminal:/ })).toBeInTheDocument();
    expect(terminalPanes()[0]).toBe(pane);
    await waitFor(() => expect(savedTerminals(mock.layout)).toHaveLength(1));
    await waitFor(() => expect(savedTerminals(mock.layout)[0]).not.toHaveProperty("projectId"));
  });

  it("whose project went while yaah was closed comes back in Open panes", async () => {
    const state = installBrowserMock({ delay: 0 });
    state.layout = {
      root: { type: "pane", id: "p1", content: { kind: "terminal", cwd: "/Users/dev/workspace/api", projectId: "gone" } },
      focused: "p1",
    };
    render(<App />);
    const group = await screen.findByRole("region", { name: "Open panes" });
    expect(within(group).getByRole("button", { name: /^Terminal:/ })).toBeInTheDocument();
    await waitFor(() => expect(savedTerminals(state.layout)[0]?.id).toBeTruthy());
    expect(savedTerminals(state.layout)[0]).not.toHaveProperty("projectId");
  });
});

describe("originOf: where a pane opened from another starts", () => {
  const project: Project = { id: "pr", name: "p", dirs: ["/w/api", "/w/web/"], status: "ongoing", createdAt: 0, contextDir: "/h/.yaah/projects/pr" };
  const chat = (cwd: string, projectId: string | null) => ({ cwd, projectId }) as SessionInfo;
  const y = { projects: [project], sessions: { a: chat("/w/web/src", "pr"), b: chat("/elsewhere", "pr"), q: chat("/w/api", null) } };

  it("keeps a project chat's own folder when it is the project's, else the first repo", () => {
    expect(originOf({ kind: "chat", id: "a" }, y)).toEqual({ cwd: "/w/web/src", projectId: "pr" });
    expect(originOf({ kind: "chat", id: "b" }, y)).toEqual({ cwd: "/w/api", projectId: "pr" });
    expect(originOf({ kind: "chat", id: "q" }, y)).toEqual({ cwd: "/w/api" });
    expect(originOf({ kind: "project", id: "pr" }, y)).toEqual({ cwd: "/w/api", projectId: "pr" });
    expect(originOf({ kind: "project", id: "nope" }, y)).toEqual({});
    expect(originOf({ kind: "terminal", cwd: "/x", projectId: "pr" }, y)).toEqual({ cwd: "/x", projectId: "pr" });
    expect(originOf({ kind: "terminal", cwd: "/x", projectId: "gone" }, y)).toEqual({ cwd: "/x", projectId: undefined });
    expect(originOf(null, y)).toEqual({});
  });

  it("counts a folder as the project's when it is one of its repos, its brief folder or inside one", () => {
    expect(inProject("/w/api", project)).toBe(true);
    expect(inProject("/w/web/deep/er", project)).toBe(true);
    expect(inProject("/h/.yaah/projects/pr", project)).toBe(true);
    expect(inProject("/w/api-billing", project)).toBe(false);
    expect(inProject("/w", project)).toBe(false);
  });
});

describe("files dropped on a terminal", () => {
  it("are typed at the prompt with their paths escaped, and not run", async () => {
    const { user, mock } = await started();
    await user.click(screen.getByRole("button", { name: /new terminal/i }));
    await screen.findByRole("textbox", { name: "Terminal input" });
    const shell = () => Object.values(mock.terminals).find((t) => !t.agent)!;
    await waitFor(() => expect(shell()).toBeDefined());

    act(() => handleDragEvent({ type: "drop", paths: ["/Users/me/My Shots/a (1).png", "/tmp/b.txt"], position: { x: 0, y: 0 } }));
    await waitFor(() => expect(mock.terminalInput[shell().id]?.join("")).toBe("/Users/me/My\\ Shots/a\\ \\(1\\).png /tmp/b.txt "));
  });
});

describe("keys in a terminal", () => {
  it("go to the shell, except the app shortcuts it leaves to the app", async () => {
    const { user, mock } = await started();
    await user.click(screen.getByRole("button", { name: /new terminal/i }));
    const input = await screen.findByRole("textbox", { name: "Terminal input" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    const shell = () => Object.values(mock.terminals).find((t) => !t.agent)!;

    // ⌘N / Ctrl+N stays in the terminal: no new chat starts.
    const chats = Object.keys(mock.sessions).length;
    press("n", "KeyN");
    // ⌘L would focus a composer; the keyboard stays here.
    press("l", "KeyL");
    expect(document.activeElement).toBe(input);
    expect(Object.keys(mock.sessions)).toHaveLength(chats);
    if (!isMac) expect(mock.terminalInput[shell().id]).toEqual(["\x0e", "\x0c"]);

    // ⌘D splits; ⌘K opens the palette; ⌘W closes the pane.
    pressInTerminal("d", "KeyD");
    await waitFor(() => expect(paneEls()).toHaveLength(2));
    await screen.findByRole("combobox", { name: /search chats and projects/i });
    act(() => input.focus());
    pressInTerminal("k", "KeyK");
    const palette = await screen.findByRole("dialog");
    fireEvent.keyDown(palette, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => input.focus());
    pressInTerminal("w", "KeyW");
    await waitFor(() => expect(terminalPanes()).toHaveLength(0));
  });
});

describe("Open in terminal", () => {
  it("opens a chat's folder in the terminal app from its folder menu", async () => {
    const { user, mock, chat } = await withChat();
    await user.click(await screen.findByRole("button", { name: /folders? in this chat/i }));
    await user.click(await screen.findByRole("menuitem", { name: /open in terminal/i }));
    await waitFor(() => expect(mock.openedInTerminalApp).toEqual([chat.cwd]));
  });
});

describe("an agent's command in its tool card", () => {
  it("streams live, read-only, and stops", async () => {
    const state = installBrowserMock({ delay: 0 });
    const t = startAgentTerminal(state, { title: "cargo test" });
    const entry: Entry = {
      type: "tool",
      toolCallId: "run1",
      title: "cargo test",
      kind: "execute",
      status: "in_progress",
      content: [{ type: "terminal", terminalId: t.id }],
      locations: [],
      rawInput: null,
    };
    const user = userEvent.setup();
    render(<TranscriptEntry entry={entry} index={0} inTurn live={false} onLogin={() => undefined} />);
    // A running command's card opens while its turn runs; open it if it isn't.
    const header = screen.getByRole("button", { name: /cargo test/i });
    if (header.getAttribute("aria-expanded") !== "true") await user.click(header);
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-tool-terminal="${t.id}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(textIn(card)).toContain("Compiling shop v0.4.0\nRunning tests…"));
    expect(within(card).getByRole("textbox", { name: "Terminal input" })).toHaveAttribute("readonly");
    await user.click(within(card).getByRole("button", { name: /stop/i }));
    await waitFor(() => expect(within(card).getByText("stopped (SIGKILL)")).toBeInTheDocument());
    expect(within(card).queryByRole("button", { name: /stop/i })).toBeNull();
    const printed = textIn(card);
    await new Promise((r) => setTimeout(r, 60));
    expect(textIn(card)).toBe(printed);
    expect(within(card).getByRole("button", { name: /open as pane/i })).toBeInTheDocument();
  });

  it("replays the output kept with the tool call once the terminal is gone", async () => {
    installBrowserMock({ delay: 0 });
    const entry: Entry = {
      type: "tool",
      toolCallId: "run2",
      title: "npm test",
      kind: "execute",
      status: "completed",
      content: [
        { type: "terminal", terminalId: "tgone", keptOutput: btoa("\x1b[31m2 failing\x1b[0m\r\nok\r\n"), exitStatus: { exitCode: 1, signal: null } },
      ],
      locations: [],
      rawInput: null,
    };
    const user = userEvent.setup();
    render(<TranscriptEntry entry={entry} index={0} inTurn={false} live={false} onLogin={() => undefined} />);
    const header = screen.getByRole("button", { name: /npm test/i });
    if (header.getAttribute("aria-expanded") !== "true") await user.click(header);
    const card = await waitFor(() => document.querySelector<HTMLElement>('[data-tool-terminal="tgone"]')!);
    await waitFor(() => expect(textIn(card)).toContain("2 failing\nok"));
    expect(within(card).getByText("exit 1")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /stop/i })).toBeNull();
  });
});

describe("a shell that exits", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A terminal pane from the home screen, its shell at the prompt; `now` drives Date.now. */
  async function openShell() {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const r = await started();
    await r.user.click(screen.getByRole("button", { name: /new terminal/i }));
    await waitFor(() => expect(terminalPanes()).toHaveLength(1));
    const pane = terminalPanes()[0];
    await waitFor(() => expect(textIn(pane)).toContain("dev@yaah %"));
    const input = within(pane).getByRole("textbox", { name: "Terminal input" });
    return { ...r, pane, input, later: (ms: number) => (now += ms) };
  }

  it("closes its pane, as terminal apps do", async () => {
    const { user, input, later } = await openShell();
    later(5_000);
    await user.type(input, "exit{Enter}");
    await waitFor(() => expect(terminalPanes()).toHaveLength(0));
    // The only pane goes back to the home screen.
    expect(await screen.findByRole("button", { name: /new terminal/i })).toBeInTheDocument();
  });

  it("closes only its own pane when the window is split", async () => {
    const { user, input, later } = await openShell();
    pressInTerminal("d", "KeyD");
    await screen.findByRole("combobox", { name: /search chats and projects/i });
    expect(paneEls()).toHaveLength(2);
    later(5_000);
    await user.type(input, "exit{Enter}");
    await waitFor(() => expect(terminalPanes()).toHaveLength(0));
    expect(paneEls()).toHaveLength(1);
  });

  it("keeps its pane open, saying so, when it dies right after starting", async () => {
    const { user, pane, input, later } = await openShell();
    later(QUICK_EXIT_MS - 1);
    await user.type(input, "exit{Enter}");
    expect(await within(pane).findByText("The shell has exited.")).toBeInTheDocument();
    expect(terminalPanes()).toHaveLength(1);
    // Its own buttons still work: a new shell in the same pane.
    await user.click(within(pane).getByRole("button", { name: /new shell/i }));
    await waitFor(() => expect(within(pane).queryByText("The shell has exited.")).not.toBeInTheDocument());
  });
});

describe("an expanded terminal", () => {
  afterEach(() => vi.restoreAllMocks());

  async function shellPane() {
    const r = await started();
    await r.user.click(screen.getByRole("button", { name: /new terminal/i }));
    await waitFor(() => expect(terminalPanes()).toHaveLength(1));
    const pane = terminalPanes()[0];
    await waitFor(() => expect(textIn(pane)).toContain("dev@yaah %"));
    return { ...r, pane };
  }
  const expandKey = () =>
    fireEvent.keyDown(document.activeElement ?? window, {
      key: "Enter",
      code: "Enter",
      metaKey: isMac,
      ctrlKey: !isMac,
      shiftKey: true,
      bubbles: true,
    });

  it("opens the same shell in a large dialog, keeps Esc for the shell, and goes back", async () => {
    const { user, pane, mock } = await shellPane();
    await user.click(within(pane).getByRole("button", { name: "Expand terminal" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(pane).getByText("Shown expanded")).toBeInTheDocument();
    // The dialog's own view of the shell, with its scrollback, taking keys.
    await waitFor(() => expect(textIn(dialog)).toContain("dev@yaah %"));
    const input = within(dialog).getByRole("textbox", { name: "Terminal input" });
    await user.type(input, "echo big{Enter}");
    await waitFor(() => expect(textIn(dialog)).toContain("big\ndev@yaah %"));
    expect(Object.values(mock.terminals).filter((t) => !t.agent)).toHaveLength(1);
    // Esc is the shell's: the dialog stays.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // ⌘⇧Enter goes back to the pane, which shows the shell again.
    expandKey();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(textIn(terminalPanes()[0])).toContain("big\ndev@yaah %"));
  });

  it("opens with ⌘⇧Enter from the pane, and closes with the pane when the shell exits", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { user, pane } = await shellPane();
    within(pane).getByRole("textbox", { name: "Terminal input" }).focus();
    expandKey();
    const dialog = await screen.findByRole("dialog");
    now += 5_000;
    await user.type(within(dialog).getByRole("textbox", { name: "Terminal input" }), "exit{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(terminalPanes()).toHaveLength(0));
  });
});
