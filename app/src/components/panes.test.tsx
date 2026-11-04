// Split panes and the sidebar, against the real App and the browser mock: splitting,
// the picker a new pane opens on, moving and closing, what acts on the focused pane,
// two chats running side by side, and the layout coming back after a restart.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "@/App";
import type { Layout } from "@/lib/layout";
import { isMac } from "@/lib/shortcuts";
import { renderApp } from "@/test/app";

/** A ⌘ shortcut (Ctrl on Linux) pressed anywhere. */
function press(key: string, code: string, opts: { shift?: boolean; alt?: boolean } = {}) {
  fireEvent.keyDown(document.activeElement ?? window, {
    key,
    code,
    metaKey: isMac,
    ctrlKey: !isMac,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
    bubbles: true,
  });
}
const splitRight = () => press("d", "KeyD");
const splitDown = () => press("D", "KeyD", { shift: true });
const closePane = () => press("w", "KeyW");
const move = (arrow: "Left" | "Right" | "Up" | "Down") => press(`Arrow${arrow}`, `Arrow${arrow}`, { alt: true });

const paneEls = () => [...document.querySelectorAll<HTMLElement>("[data-pane-id]")];
const pane = (id: string) => {
  const el = document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
  if (!el) throw new Error(`no pane ${id}`);
  return el;
};
const focusedPane = () => document.querySelector<HTMLElement>("[data-pane-id][data-focused]")?.dataset.paneId;
const composerIn = (id: string) => within(pane(id)).getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });

async function started() {
  const r = renderApp();
  await screen.findByRole("button", { name: /^quick chat\b(?!s)/i });
  return r;
}

/** Start a chat from pane `id`'s home screen or picker. */
async function quickChatIn(user: ReturnType<typeof renderApp>["user"], id: string) {
  const el = pane(id);
  const picker = within(el).queryByRole("option", { name: /^New chat with/ });
  await user.click(picker ?? within(el).getByRole("button", { name: /^quick chat\b(?!s)/i }));
  return waitFor(() => composerIn(id));
}

describe("splitting", () => {
  it("splits right with ⌘D and down with ⌘⇧D, each new pane on the picker with the keyboard in it", async () => {
    await started();
    // One pane: today's layout, no separators, no pane names.
    expect(paneEls()).toHaveLength(1);
    expect(screen.queryByRole("separator", { name: /panes/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Home" })).toBeNull();

    act(splitRight);
    expect(paneEls().map((p) => p.dataset.paneId)).toEqual(["p1", "p2"]);
    expect(focusedPane()).toBe("p2");
    expect(screen.getByRole("separator", { name: "Resize the panes side by side" })).toHaveAttribute("aria-orientation", "vertical");
    const picker = screen.getByRole("region", { name: "Open in this pane" });
    await waitFor(() => expect(within(picker).getByRole("combobox", { name: "Search chats and projects" })).toHaveFocus());
    expect(pane("p1").style.width).toBe("50%");
    expect(pane("p2").style.left).toBe("50%");

    act(splitDown);
    expect(paneEls()).toHaveLength(3);
    expect(focusedPane()).toBe("p3");
    expect(screen.getByRole("separator", { name: "Resize the panes above and below" })).toHaveAttribute("aria-orientation", "horizontal");
    expect(pane("p2").style.height).toBe("50%");
    expect(pane("p3").style.top).toBe("50%");
    expect(pane("p3").style.left).toBe("50%");
  });

  it("splits from the palette too", async () => {
    const { user } = await started();
    press("k", "KeyK");
    await user.click(await screen.findByRole("option", { name: /^Split right/ }));
    await waitFor(() => expect(paneEls()).toHaveLength(2));
    press("k", "KeyK");
    expect(await screen.findByRole("option", { name: /^Close pane/ })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /^Focus next pane/ }));
    await waitFor(() => expect(focusedPane()).toBe("p1"));
    press("k", "KeyK");
    await user.click(await screen.findByRole("option", { name: /^Close pane/ }));
    await waitFor(() => expect(paneEls()).toHaveLength(1));
  });
});

describe("the picker", () => {
  it("starts a chat with the agent picked there", async () => {
    const { user, mock } = await started();
    act(splitRight);
    const picker = pane("p2");
    await user.click(within(picker).getByRole("combobox", { name: "Agent for a new chat in this pane" }));
    await user.click(await screen.findByRole("option", { name: /^Claude \(work\)/ }));
    await user.click(within(picker).getByRole("option", { name: /^New chat with Claude \(work\)/ }));
    await waitFor(() => composerIn("p2"));
    expect(Object.values(mock.sessions).map((s) => s.accountId)).toEqual(["work"]);
    // The other pane is untouched.
    expect(within(pane("p1")).getByRole("button", { name: /^quick chat\b(?!s)/i })).toBeInTheDocument();
  });

  it("starts a chat with repositories picked in its optional step", async () => {
    const { user, mock } = await started();
    act(splitRight);
    const picker = within(pane("p2"));
    await user.click(picker.getByRole("option", { name: /^Add repositories… optional/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add repos" });
    const list = within(dialog).getByRole("listbox", { name: "Repos" });
    await user.click(await within(list).findByRole("option", { name: /^api\s/ }));
    await user.click(within(list).getByRole("option", { name: /^docs/ }));
    await user.click(within(dialog).getByRole("button", { name: /^Add/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add repos" })).toBeNull());
    const chosen = picker.getByRole("list", { name: "Repositories for the new chat" });
    expect(
      within(chosen)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["api", "docs"]);
    await user.click(within(chosen).getByRole("button", { name: "Remove docs" }));

    await user.click(picker.getByRole("option", { name: /^New chat with Claude · api/ }));
    await waitFor(() => composerIn("p2"));
    const [s] = Object.values(mock.sessions);
    expect(s.additionalDirs).toEqual(["/Users/dev/workspace/api"]);
    expect(s.extraDirs).toEqual(["/Users/dev/workspace/api"]);
  });

  it("opens an existing chat or project from one search, by keyboard", async () => {
    const { user } = await started();
    await quickChatIn(user, "p1");
    await user.type(composerIn("p1"), "explain the links{Enter}");
    await within(pane("p1")).findByText("ACP spec");

    act(splitRight);
    const search = await within(pane("p2")).findByRole("combobox", { name: "Search chats and projects" });
    await waitFor(() => expect(search).toHaveFocus());
    await user.keyboard("expl");
    expect(within(pane("p2")).getByRole("option", { name: /explain the links/, selected: true })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    // The same chat in both panes: both follow it.
    await waitFor(() => expect(within(pane("p2")).getByRole("log", { name: "Conversation" })).toHaveTextContent("ACP spec"));

    act(splitDown);
    const search2 = await within(pane("p3")).findByRole("combobox", { name: "Search chats and projects" });
    await waitFor(() => expect(search2).toHaveFocus());
    await user.keyboard("billing{ArrowDown}{ArrowUp}{Enter}");
    expect(await within(pane("p3")).findByDisplayValue("billing revamp")).toBeInTheDocument();
  });

  it("closes its pane on Esc when the search is empty, after clearing it first", async () => {
    const { user } = await started();
    act(splitRight);
    const search = within(pane("p2")).getByRole("combobox", { name: "Search chats and projects" });
    await waitFor(() => expect(search).toHaveFocus());
    await user.keyboard("zz");
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(paneEls()).toHaveLength(2);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(paneEls()).toHaveLength(1));
    expect(focusedPane()).toBe("p1");
  });
});

describe("moving and closing", () => {
  it("moves the focus with ⌘⌥ and the arrows, and a click focuses a pane", async () => {
    const { user } = await started();
    act(splitRight);
    act(splitDown); // p1 | (p2 / p3)
    act(() => move("Left"));
    expect(focusedPane()).toBe("p1");
    act(() => move("Left"));
    expect(focusedPane()).toBe("p1");
    act(() => move("Right"));
    expect(focusedPane()).toBe("p2");
    act(() => move("Down"));
    expect(focusedPane()).toBe("p3");
    act(() => move("Up"));
    expect(focusedPane()).toBe("p2");
    // The keyboard follows.
    await waitFor(() => expect(within(pane("p2")).getByRole("combobox", { name: "Search chats and projects" })).toHaveFocus());

    await user.click(within(pane("p1")).getByText(/Start a quick chat/));
    expect(focusedPane()).toBe("p1");
    // The ring shows only on the focused pane.
    expect(pane("p1").querySelector(".ring-inset")).not.toBeNull();
    expect(pane("p2").querySelector(".ring-inset")).toBeNull();
  });

  it("closes the focused pane with ⌘W, never the last one", async () => {
    await started();
    act(splitRight);
    act(splitRight);
    expect(paneEls()).toHaveLength(3);
    act(closePane);
    expect(paneEls()).toHaveLength(2);
    expect(focusedPane()).toBe("p2");
    act(closePane);
    expect(paneEls()).toHaveLength(1);
    act(closePane);
    expect(paneEls()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^quick chat\b(?!s)/i })).toBeInTheDocument();
  });

  it("⌘W on the last pane showing a chat goes back to the home screen", async () => {
    const { user } = await started();
    await quickChatIn(user, "p1");
    act(closePane);
    expect(paneEls()).toHaveLength(1);
    expect(await screen.findByRole("button", { name: /^quick chat\b(?!s)/i })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  });

  it("⌘W on the last pane closes the library, as Esc does", async () => {
    const { user } = await started();
    await quickChatIn(user, "p1");
    await user.click(screen.getByRole("button", { name: "Component library" }));
    expect(await screen.findByRole("button", { name: "Close Component library" })).toBeInTheDocument();
    act(closePane);
    await waitFor(() => composerIn("p1"));
  });
});

describe("the focused pane", () => {
  it("is what the sidebar highlights and opens into", async () => {
    const { user } = await started();
    await quickChatIn(user, "p1");
    act(splitRight);
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    const project = within(sidebar).getByRole("button", { name: "billing revamp" });
    await user.click(project);
    expect(await within(pane("p2")).findByDisplayValue("billing revamp")).toBeInTheDocument();
    expect(composerIn("p1")).toBeInTheDocument();
    expect(project.parentElement).toHaveClass("bg-sidebar-accent");

    // Back in the chat's pane, the sidebar shows the chat instead.
    await user.click(composerIn("p1"));
    const chatRow = within(sidebar).getByRole("button", { name: "New chat" });
    await waitFor(() => expect(chatRow.parentElement).toHaveClass("bg-sidebar-accent"));
    expect(project.parentElement).not.toHaveClass("bg-sidebar-accent");
  });

  it("gets ⌘N, ⌘L and ⌘. while the other pane keeps its own", async () => {
    const { user, mock } = await started();
    await quickChatIn(user, "p1");
    await user.type(composerIn("p1"), "write hello.txt please{Enter}");
    await within(pane("p1")).findByRole("group", { name: "Permission requested" });

    act(splitRight);
    // ⌘N: a quick chat in the focused (new) pane.
    act(() => press("n", "KeyN"));
    await waitFor(() => composerIn("p2"));
    expect(Object.keys(mock.sessions)).toHaveLength(2);
    // ⌘L lands in the focused pane's composer.
    act(() => press("Escape", "Escape"));
    pane("p2").focus();
    act(() => press("l", "KeyL"));
    expect(composerIn("p2")).toHaveFocus();
    // ⌘. stops nothing here: p2 isn't running, p1 still is.
    act(() => press(".", "Period"));
    const [first] = Object.values(mock.sessions);
    expect(within(pane("p1")).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    // From p1 it stops p1's turn.
    act(() => move("Left"));
    act(() => press(".", "Period"));
    await waitFor(() => expect(first.running).toBe(false));
    expect(await within(pane("p1")).findByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("⌘[ and ⌘] switch chats in the focused pane only", async () => {
    const { user } = await started();
    await quickChatIn(user, "p1");
    await user.type(composerIn("p1"), "explain the links{Enter}");
    await within(pane("p1")).findByText("ACP spec");
    act(splitRight);
    await quickChatIn(user, "p2");
    const titleIn = (id: string) => within(pane(id)).getByRole("heading", { level: 1 }).textContent;
    expect(titleIn("p2")).toBe("New chat");
    act(() => press("]", "BracketRight"));
    await waitFor(() => expect(titleIn("p2")).toBe("explain the links"));
    expect(titleIn("p1")).toBe("explain the links");
    act(() => press("[", "BracketLeft"));
    await waitFor(() => expect(titleIn("p2")).toBe("New chat"));
    expect(titleIn("p1")).toBe("explain the links");
  });
});

describe("two chats side by side", () => {
  it("stream on their own", async () => {
    const { user } = await started();
    await quickChatIn(user, "p1");
    await user.type(composerIn("p1"), "write hello.txt please{Enter}");
    const left = within(pane("p1"));
    const permission = await left.findByRole("group", { name: "Permission requested" });

    act(splitRight);
    await quickChatIn(user, "p2");
    await user.type(composerIn("p2"), "explain the links{Enter}");
    const right = within(pane("p2"));
    expect(await right.findByText("ACP spec")).toBeInTheDocument();
    // The left chat is still waiting on its permission; the right one never saw it.
    expect(right.queryByRole("group", { name: "Permission requested" })).toBeNull();
    expect(left.queryByText("ACP spec")).toBeNull();
    expect(within(permission).getByRole("button", { name: "Yes" })).toBeEnabled();

    await user.click(within(permission).getByRole("button", { name: "Yes" }));
    expect(await left.findByText(/it contains exactly/)).toBeInTheDocument();
    expect(right.queryByText(/it contains exactly/)).toBeNull();
    // Each keeps its own composer draft.
    await user.type(composerIn("p1"), "left draft");
    await user.type(composerIn("p2"), "right draft");
    expect(composerIn("p1")).toHaveValue("left draft");
    expect(composerIn("p2")).toHaveValue("right draft");
  });

  it("drafts land in the composer of the pane the action came from", async () => {
    const { user } = await started();
    await quickChatIn(user, "p1");
    await user.type(composerIn("p1"), "explain the links{Enter}");
    await within(pane("p1")).findByText("ACP spec");
    act(splitRight);
    const search = await within(pane("p2")).findByRole("combobox", { name: "Search chats and projects" });
    await user.type(search, "explain{Enter}");
    // The same chat in both; the focus is in p2, but the action is in p1's transcript.
    await within(pane("p2")).findByText("ACP spec");
    expect(focusedPane()).toBe("p2");
    fireEvent.contextMenu(within(pane("p1")).getByText("explain the links", { selector: "div" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit as new message" }));
    await waitFor(() => expect(composerIn("p1")).toHaveValue("explain the links"));
    expect(composerIn("p2")).toHaveValue("");
  });
});

describe("the layout", () => {
  it("comes back after a restart, without the panes of deleted chats", async () => {
    const { user, mock, unmount } = await started();
    await quickChatIn(user, "p1");
    act(splitRight);
    await quickChatIn(user, "p2");
    act(splitDown);
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    await user.click(within(sidebar).getByRole("button", { name: "billing revamp" }));
    await within(pane("p3")).findByDisplayValue("billing revamp");
    // Resize the first divider by keyboard: it's saved too.
    const divider = screen.getByRole("separator", { name: "Resize the panes side by side" });
    act(() => divider.focus());
    fireEvent.keyDown(divider, { key: "ArrowRight", shiftKey: true });
    expect(divider).toHaveAttribute("aria-valuenow", "60");
    await waitFor(() => expect((mock.layout?.root as Extract<Layout["root"], { type: "split" }>)?.ratio).toBeCloseTo(0.6));
    await waitFor(() => expect(mock.layout?.focused).toBe("p3"));

    unmount();
    const second = render(<App />);
    await waitFor(() => expect(paneEls()).toHaveLength(3));
    expect(focusedPane()).toBe("p3");
    expect(await within(pane("p3")).findByDisplayValue("billing revamp")).toBeInTheDocument();
    await waitFor(() => composerIn("p1"));
    expect(pane("p1").style.width).toBe("60%");

    // The right-hand chat is deleted while the app is closed: its pane goes, the project takes the column.
    const gone = (mock.layout!.root as Extract<Layout["root"], { type: "split" }>).b;
    const goneChat = gone.type === "split" && gone.a.type === "pane" && gone.a.content?.kind === "chat" ? gone.a.content.id : "";
    second.unmount();
    delete mock.sessions[goneChat];
    render(<App />);
    await waitFor(() => expect(paneEls()).toHaveLength(2));
    expect(within(pane("p3")).getByDisplayValue("billing revamp")).toBeInTheDocument();
    expect(document.querySelector('[data-pane-id="p2"]')).toBeNull();
  });

  it("resizes a divider from the keyboard, within bounds, and double-click evens it", async () => {
    await started();
    act(splitRight);
    const divider = screen.getByRole("separator", { name: "Resize the panes side by side" });
    expect(divider).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider).toHaveAttribute("aria-valuenow", "48");
    fireEvent.keyDown(divider, { key: "Home" });
    expect(divider).toHaveAttribute("aria-valuenow", divider.getAttribute("aria-valuemin"));
    expect(pane("p1").style.width).toBe("5%");
    fireEvent.keyDown(divider, { key: "End" });
    expect(divider).toHaveAttribute("aria-valuenow", "95");
    // Up and down mean nothing to a side-by-side divider.
    fireEvent.keyDown(divider, { key: "ArrowUp" });
    expect(divider).toHaveAttribute("aria-valuenow", "95");
    fireEvent.doubleClick(divider);
    expect(divider).toHaveAttribute("aria-valuenow", "50");

    act(splitDown);
    const across = screen.getByRole("separator", { name: "Resize the panes above and below" });
    fireEvent.keyDown(across, { key: "ArrowDown" });
    expect(across).toHaveAttribute("aria-valuenow", "52");
    expect(pane("p2").style.height).toBe("52%");
  });
});

describe("the sidebar", () => {
  it("hides with ⌘B or its button to nothing, the main area's title bar bringing it back, and remembers", async () => {
    const { user, mock, unmount } = await started();
    // Shown: no title bar above the panes (it's there, folded away and inert, so it can animate in).
    expect(screen.queryByRole("banner", { name: "Title bar" })).toBeNull();
    act(() => press("b", "KeyB"));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull());
    const wrapper = document.querySelector("[data-collapsed]")!.firstElementChild as HTMLElement;
    expect(wrapper.style.width).toBe("0px");
    expect(wrapper).toHaveAttribute("inert");
    await waitFor(() => expect(mock.sidebar.collapsed).toBe(true));

    // The title bar: Show sidebar, the logo and Search ⌘K, and it drags the window. No traffic-light gutter outside macOS's app.
    const bar = screen.getByRole("banner", { name: "Title bar" });
    expect(bar).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(bar).not.toHaveClass("pl-[80px]");
    expect(within(bar).getByRole("img", { name: "yaah" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /^Search/ })).toHaveTextContent(/K$/);
    await user.click(within(bar).getByRole("button", { name: /^Search/ }));
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(within(bar).getByRole("button", { name: "Show the sidebar" }));
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    expect(screen.queryByRole("banner", { name: "Title bar" })).toBeNull();
    await user.click(within(sidebar).getByRole("button", { name: "Hide the sidebar" }));
    await screen.findByRole("banner", { name: "Title bar" });

    unmount();
    render(<App />);
    expect(await screen.findByRole("banner", { name: "Title bar" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
    press("k", "KeyK");
    await user.click(await screen.findByRole("option", { name: /^Show sidebar/ }));
    expect(await screen.findByRole("complementary", { name: "Sidebar" })).toBeInTheDocument();
    await waitFor(() => expect(mock.sidebar.collapsed).toBe(false));
  });

  it("keeps its top row inside its edge: the logo, then Hide at the right, and Search on a row of its own", async () => {
    await started();
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    const hide = within(sidebar).getByRole("button", { name: "Hide the sidebar" });
    const search = within(sidebar).getByRole("button", { name: /^Search/ });
    const row = hide.parentElement!;
    expect(row).toHaveClass("flex", "justify-between", "min-w-0");
    expect(hide).toHaveClass("shrink-0");
    expect(row).toContainElement(within(sidebar).getByText("yaah"));
    expect(row).not.toContainElement(search);
    expect(search).toHaveClass("w-full");
    expect(search).toHaveTextContent(/K$/);
    // Nothing in the sidebar is laid out past its width: no fixed widths in that row.
    expect(row.className).not.toMatch(/(^|\s)w-\d/);
  });

  it("resizes by its edge within 220–480 px, double-click resets, and the width is kept", async () => {
    const { mock, unmount } = await started();
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    const edge = screen.getByRole("separator", { name: "Resize the sidebar" });
    expect(sidebar.style.width).toBe("288px");

    // Dragging the edge: the width follows the pointer, and is saved when it's let go.
    fireEvent.pointerDown(edge, { button: 0, clientX: 288 });
    fireEvent.pointerMove(window, { clientX: 350 });
    expect(sidebar.style.width).toBe("350px");
    expect(mock.sidebar.width).toBe(288);
    fireEvent.pointerUp(window, { clientX: 350 });
    await waitFor(() => expect(mock.sidebar.width).toBe(350));

    fireEvent.pointerDown(edge, { button: 0, clientX: 350 });
    fireEvent.pointerMove(window, { clientX: 2000 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(sidebar.style.width).toBe("480px"));
    fireEvent.keyDown(edge, { key: "Home" });
    await waitFor(() => expect(sidebar.style.width).toBe("220px"));
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    await waitFor(() => expect(edge).toHaveAttribute("aria-valuenow", "236"));
    await waitFor(() => expect(mock.sidebar.width).toBe(236));

    unmount();
    render(<App />);
    expect((await screen.findByRole("complementary", { name: "Sidebar" })).style.width).toBe("236px");
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize the sidebar" }));
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Sidebar" }).style.width).toBe("288px"));
  });
});
