// The close button on every split pane (components/panes.tsx): only with several panes, on
// every kind but the terminal (which has its own), closing the pane it sits on, never a chat.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isMac } from "@/lib/shortcuts";
import { renderApp } from "@/test/app";

function press(key: string, code: string) {
  fireEvent.keyDown(document.activeElement ?? window, { key, code, metaKey: isMac, ctrlKey: !isMac, bubbles: true });
}
const splitRight = () => press("d", "KeyD");

const paneEls = () => [...document.querySelectorAll<HTMLElement>("[data-pane-id]")];
const ids = () => paneEls().map((p) => p.dataset.paneId);
const pane = (id: string) => {
  const el = document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
  if (!el) throw new Error(`no pane ${id}`);
  return el;
};
const focusedPane = () => document.querySelector<HTMLElement>("[data-pane-id][data-focused]")?.dataset.paneId;
const closeIn = (id: string) => within(pane(id)).getByRole("button", { name: "Close this pane" });
const closeButtons = () => screen.queryAllByRole("button", { name: "Close this pane" });

async function started() {
  const r = renderApp();
  await screen.findByRole("button", { name: /^quick chat\b(?!s)/i });
  return r;
}

describe("the pane close button", () => {
  it("shows only once there are two or more panes", async () => {
    await started();
    expect(closeButtons()).toHaveLength(0);
    act(splitRight);
    expect(closeButtons()).toHaveLength(2);
    act(() => closeIn("p2").click());
    await waitFor(() => expect(ids()).toEqual(["p1"]));
    expect(closeButtons()).toHaveLength(0);
  });

  it("is on the home screen, the picker, a chat, a project and the library", async () => {
    const { user } = await started();
    act(splitRight);
    // p1 is the home screen, p2 the picker.
    expect(within(pane("p1")).getByRole("button", { name: /^quick chat\b(?!s)/i })).toBeInTheDocument();
    expect(closeIn("p1")).toBeInTheDocument();
    expect(within(pane("p2")).getByRole("combobox", { name: "Search chats and projects" })).toBeInTheDocument();
    expect(closeIn("p2")).toBeInTheDocument();

    await user.click(within(pane("p1")).getByRole("button", { name: /^quick chat\b(?!s)/i }));
    await within(pane("p1")).findByRole("combobox", { name: "Message" });
    expect(closeIn("p1")).toBeInTheDocument();

    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    await user.click(within(pane("p2")).getByRole("combobox", { name: "Search chats and projects" }));
    await user.click(within(sidebar).getByRole("button", { name: "billing revamp" }));
    expect(await within(pane("p2")).findByDisplayValue("billing revamp")).toBeInTheDocument();
    expect(closeIn("p2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Component library" }));
    expect(await within(pane("p2")).findByRole("button", { name: "Close Component library" })).toBeInTheDocument();
    expect(closeIn("p2")).toBeInTheDocument();
    expect(closeButtons()).toHaveLength(2);
  });

  it("is not added to a terminal pane, which has its own", async () => {
    const { user } = await started();
    await user.click(screen.getByRole("button", { name: /new terminal/i }));
    await waitFor(() => expect(document.querySelector("[data-terminal]")).not.toBeNull());
    act(splitRight);
    expect(within(pane("p1")).getByRole("button", { name: "Close terminal pane" })).toBeInTheDocument();
    expect(within(pane("p1")).queryByRole("button", { name: "Close this pane" })).toBeNull();
    expect(closeButtons()).toHaveLength(1);
    expect(within(pane("p2")).getByRole("button", { name: "Close this pane" })).toBeInTheDocument();
  });

  it("closes its own pane, not the focused one, and leaves the focus where it was", async () => {
    const { user } = await started();
    act(splitRight);
    await user.click(within(pane("p2")).getByRole("combobox", { name: "Search chats and projects" }));
    await waitFor(() => expect(focusedPane()).toBe("p2"));
    await user.click(closeIn("p1"));
    await waitFor(() => expect(ids()).toEqual(["p2"]));
    expect(focusedPane()).toBe("p2");
    // The keyboard is in the pane that's left.
    await waitFor(() => expect(within(pane("p2")).getByRole("combobox", { name: "Search chats and projects" })).toHaveFocus());
  });

  it("moves the focus to a remaining pane when the focused one closes", async () => {
    const { user } = await started();
    act(splitRight);
    await waitFor(() => expect(focusedPane()).toBe("p2"));
    await user.click(closeIn("p2"));
    await waitFor(() => expect(ids()).toEqual(["p1"]));
    expect(focusedPane()).toBe("p1");
  });

  it("only removes the pane: the chat stays in the sidebar", async () => {
    const { user } = await started();
    await user.click(screen.getByRole("button", { name: /^quick chat\b(?!s)/i }));
    await within(pane("p1")).findByRole("combobox", { name: "Message" });
    act(splitRight);
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    const chatRow = within(sidebar).getByRole("button", { name: "New chat" });
    await user.click(closeIn("p1"));
    await waitFor(() => expect(ids()).toEqual(["p2"]));
    expect(chatRow).toBeInTheDocument();
    // And it opens again from the sidebar.
    await user.click(chatRow);
    expect(await screen.findByRole("combobox", { name: "Message" })).toBeInTheDocument();
  });

  it("is a named button reached by Tab and pressed with Enter, with the shortcut in its tooltip", async () => {
    const { user } = await started();
    act(splitRight);
    // The split hands the keyboard to the new picker; wait for that before taking it back.
    await waitFor(() => expect(within(pane("p2")).getByRole("combobox", { name: "Search chats and projects" })).toHaveFocus());
    const button = closeIn("p1");
    expect(button.tagName).toBe("BUTTON");
    act(() => button.focus());
    expect(button).toHaveFocus();
    await user.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(isMac ? "Close this pane⌘W" : "Close this paneCtrlW");
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(ids()).toEqual(["p2"]));
  });
});
