// The diff pane and the sidebar's "Open panes", against the real App and the browser mock's fake
// repository: opening from the picker and ⌘K, modes and the base branch, live refresh, the
// non-repository state, save and restore, and terminal and diff rows appearing, focusing and closing.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "@/App";
import { setTerminalEngine } from "@/components/terminal/engine";
import { installBrowserMock } from "@/dev/browser-mock";
import { touchFakeRepo } from "@/dev/mock/diff";
import { isMac } from "@/lib/shortcuts";
import { singlePane, sameContent, splitPane } from "@/lib/layout";
import { renderApp } from "@/test/app";
import { textEngine } from "@/test/text-engine";

beforeEach(() => setTerminalEngine(textEngine));
afterEach(() => setTerminalEngine(null));

function press(key: string, code: string) {
  // On the window: a shell would keep Ctrl+D and the like for itself (Linux).
  fireEvent.keyDown(window, { key, code, metaKey: isMac, ctrlKey: !isMac, bubbles: true });
}
const paneEls = () => [...document.querySelectorAll<HTMLElement>("[data-pane-id]")];
const diffPane = () => paneEls().find((p) => within(p).queryByRole("button", { name: "Close diff pane" }));
const findDiffPane = () =>
  waitFor(() => {
    const p = diffPane();
    expect(p).toBeDefined();
    return p!;
  });
const fileTicks = (pane: HTMLElement) =>
  within(within(pane).getByRole("navigation", { name: "Files" })).getAllByRole("button", { name: /^(Viewed|Mark viewed):/ });
const openPanes = () => screen.queryByRole("region", { name: "Open panes" });

async function started() {
  const r = renderApp();
  await screen.findByRole("button", { name: /^quick chat\b(?!s)/i });
  return r;
}

/** A diff of the first project's first repo, opened from the pane picker. */
async function openDiffFromPicker(r: Awaited<ReturnType<typeof started>>) {
  press("d", "KeyD");
  await screen.findByRole("combobox", { name: /search chats and projects/i });
  await r.user.click(await screen.findByRole("option", { name: /open diff/i }));
  const project = r.mock.projects.find((p) => p.dirs.length > 0)!;
  const [repo] = await screen.findAllByRole("option", { name: new RegExp(project.name) });
  await r.user.click(repo);
  return project;
}

describe("layout.ts: the diff kind", () => {
  it("compares by folder, mode and base", () => {
    expect(sameContent({ kind: "diff", cwd: "/a" }, { kind: "diff", cwd: "/a" })).toBe(true);
    expect(sameContent({ kind: "diff", cwd: "/a" }, { kind: "diff", cwd: "/b" })).toBe(false);
    expect(sameContent({ kind: "diff", cwd: "/a", mode: "staged" }, { kind: "diff", cwd: "/a" })).toBe(false);
    expect(sameContent({ kind: "diff", cwd: "/a", mode: "branch", base: "main" }, { kind: "diff", cwd: "/a", mode: "branch", base: "dev" })).toBe(
      false,
    );
    expect(sameContent({ kind: "diff" }, { kind: "terminal" })).toBe(false);
  });

  it("splits a pane onto one", () => {
    const { layout, id } = splitPane(singlePane(), "p1", "row", { kind: "diff", cwd: "/a" });
    expect(layout.focused).toBe(id);
  });
});

describe("diff panes", () => {
  it("open from the pane picker, show the changes, and appear in the sidebar", async () => {
    const r = await started();
    expect(openPanes()).toBeNull();
    const project = await openDiffFromPicker(r);
    const pane = await findDiffPane();
    expect(pane).toBeTruthy();
    // The files list and a diff; the header names the repo and branch.
    expect(await within(pane).findByRole("navigation", { name: "Files" })).toBeInTheDocument();
    expect(within(pane).getByText("feat/new-billing-page")).toBeInTheDocument();
    expect(within(pane).getByText(/1 untracked file not shown/)).toBeInTheDocument();
    const row = await within(await screen.findByRole("region", { name: "Open panes" })).findByRole("button", { name: /^Diff:/ });
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row.textContent).toMatch(/\d+ changes?/);
    expect(row).toHaveAccessibleName(new RegExp(`Diff: .*${project.dirs[0].split("/").pop()}`));
  });

  it("open from ⌘K, in a folder the pane asks for", async () => {
    const r = await started();
    press("k", "KeyK");
    await r.user.click(await screen.findByRole("option", { name: /^open diff/i }));
    const pane = await findDiffPane();
    expect(within(pane).getByText(/which folder/i)).toBeInTheDocument();
    const project = r.mock.projects.find((p) => p.dirs.length > 0)!;
    const [repo] = await within(pane).findAllByRole("option", { name: new RegExp(project.name) });
    await r.user.click(repo);
    expect(await within(pane).findByRole("navigation", { name: "Files" })).toBeInTheDocument();
  });

  it("switches what it compares, and the base branch", async () => {
    const r = await started();
    await openDiffFromPicker(r);
    const pane = await findDiffPane();
    await within(pane).findByRole("navigation", { name: "Files" });
    const all = fileTicks(pane).length;
    await r.user.click(within(pane).getByRole("combobox", { name: "What to compare" }));
    await r.user.click(await screen.findByRole("option", { name: "Staged" }));
    await waitFor(() => expect(fileTicks(pane)).toHaveLength(1));
    expect(all).toBeGreaterThan(1);
    await r.user.click(within(pane).getByRole("combobox", { name: "What to compare" }));
    await r.user.click(await screen.findByRole("option", { name: "Against a branch" }));
    const base = await within(pane).findByRole("combobox", { name: "Base branch" });
    await waitFor(() => expect(base).toHaveTextContent("main"));
    // Saved with the layout.
    await waitFor(() => {
      const saved = JSON.stringify(r.mock.layout);
      expect(saved).toContain('"kind":"diff"');
      expect(saved).toContain('"mode":"branch"');
      expect(saved).toContain('"base":"main"');
    });
  });

  it("refreshes when the repository changes, and by hand", async () => {
    const r = await started();
    await openDiffFromPicker(r);
    const pane = await findDiffPane();
    await within(pane).findByRole("navigation", { name: "Files" });
    touchFakeRepo();
    // The refresh button reads on demand (the poll does the same on its timer).
    await r.user.click(within(pane).getByRole("button", { name: "Refresh the diff" }));
    expect(within(pane).getByRole("navigation", { name: "Files" })).toBeInTheDocument();
  });

  it("says so when the folder is not in a git repository", async () => {
    const r = await started();
    r.unmount();
    const state = installBrowserMock({ delay: 0 });
    state.layout = { root: { type: "pane", id: "p1", content: { kind: "diff", cwd: "/Users/dev/plain" } }, focused: "p1" };
    render(<App />);
    expect(await screen.findByText(/isn't in a git repository/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /choose another folder/i }).length).toBeGreaterThan(0);
    const row = await screen.findByRole("button", { name: /^Diff:/ });
    expect(row).toHaveTextContent("not a repository");
  });

  it("comes back with the layout, mode and base", async () => {
    const r = await started();
    r.unmount();
    const state = installBrowserMock({ delay: 0 });
    state.layout = {
      root: { type: "pane", id: "p1", content: { kind: "diff", cwd: "/Users/dev/workspace/api", mode: "unstaged" } },
      focused: "p1",
    };
    render(<App />);
    const pane = await findDiffPane();
    expect(await within(pane).findByRole("combobox", { name: "What to compare" })).toHaveTextContent("Unstaged");
    expect(await within(pane).findByRole("navigation", { name: "Files" })).toBeInTheDocument();
  });

  it("closes from its X, leaving home when it was the last pane", async () => {
    const r = await started();
    await openDiffFromPicker(r);
    const pane = await findDiffPane();
    await r.user.click(within(pane).getByRole("button", { name: "Close diff pane" }));
    await waitFor(() => expect(diffPane()).toBeUndefined());
    await waitFor(() => expect(openPanes()).toBeNull());
  });
});

describe("the sidebar's open panes", () => {
  it("list terminals and diffs, mark the focused one, focus on click and close from the row", async () => {
    const r = await started();
    // One chat, then a terminal and a diff beside it.
    await r.user.click(screen.getByRole("button", { name: /^quick chat\b(?!s)/i }));
    await screen.findByRole("combobox", { name: "Message" });
    expect(openPanes()).toBeNull();
    press("t", "KeyT");
    const section = await screen.findByRole("region", { name: "Open panes" });
    const term = await within(section).findByRole("button", { name: /^Terminal:/ });
    expect(term).toHaveAttribute("aria-current", "true");
    press("d", "KeyD");
    await screen.findByRole("combobox", { name: /search chats and projects/i });
    await r.user.click(await screen.findByRole("option", { name: /open diff/i }));
    const project = r.mock.projects.find((p) => p.dirs.length > 0)!;
    const [repo] = await screen.findAllByRole("option", { name: new RegExp(project.name) });
    await r.user.click(repo);
    const diff = await within(section).findByRole("button", { name: /^Diff:/ });
    await waitFor(() => expect(diff).toHaveAttribute("aria-current", "true"));
    expect(term).not.toHaveAttribute("aria-current");
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);

    // Click goes to the pane.
    await r.user.click(term);
    await waitFor(() => expect(term).toHaveAttribute("aria-current", "true"));
    expect(document.querySelector("[data-pane-id][data-focused] [data-terminal]")).not.toBeNull();

    // Close from the row: its pane goes, then its row.
    await r.user.click(within(section).getByRole("button", { name: /^Close diff /i }));
    await waitFor(() => expect(within(section).queryByRole("button", { name: /^Diff:/ })).toBeNull());
    expect(diffPane()).toBeUndefined();
    await r.user.click(within(section).getByRole("button", { name: /^Close terminal /i }));
    await waitFor(() => expect(openPanes()).toBeNull());
    // The chat is still there.
    expect(screen.getByRole("combobox", { name: "Message" })).toBeInTheDocument();
  });

  it("goes away with a terminal pane that closes itself", async () => {
    const r = await started();
    await r.user.click(screen.getByRole("button", { name: /new terminal/i }));
    await screen.findByRole("region", { name: "Open panes" });
    const pane = paneEls()[0];
    await r.user.click(within(pane).getByRole("button", { name: "Close terminal pane" }));
    await waitFor(() => expect(openPanes()).toBeNull());
  });
});
