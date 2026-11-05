// The accessibility fixes from docs/research/accessibility-personas.md, against the real App and
// the browser mock where they are behaviour (focus), and against the markup and CSS where they are
// presentation (happy-dom has no layout or contrast).
//   KB-1  focus goes back to where it was after Settings, ⌘K and Expand close, and moves on after a permission answer
//   SR-5  one main landmark, and a skip link past the sidebar
//   SR-3  each Expand button and dialog is named by its UI, not "Expand" and a slug
//   SR-6  the font sliders speak their value as shown
//   SR-4  map markers are named, focusable buttons
//   SM-1  chips and badges never render under 11px
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "@/App";
import { makeMarkerAccessible, markerName } from "@/components/ui-blocks/map-a11y";
import { installBrowserMock } from "@/dev/browser-mock";
import { api, type Entry, type PermissionOption } from "@/lib/api";
import { isMac } from "@/lib/shortcuts";
import { setCardRules } from "@/lib/tool-cards";
import { setGroupToolCalls } from "@/lib/tool-groups";
import { uiTitle } from "@/lib/ui-title";
import { renderApp, sendInQuickChat } from "@/test/app";
import { declarations, readIndexCss } from "@/test/css-tokens";

/** A ⌘ shortcut (Ctrl on Linux) pressed where the keyboard is. */
function press(key: string, code: string) {
  fireEvent.keyDown(document.activeElement ?? window, { key, code, metaKey: isMac, ctrlKey: !isMac, bubbles: true });
}

async function chatWithComposer() {
  const app = renderApp();
  const log = await sendInQuickChat(app.user, "hello there");
  const composer = screen.getByRole("combobox", { name: "Message" });
  await app.user.click(composer);
  expect(composer).toHaveFocus();
  return { ...app, log, composer };
}

describe("KB-1: focus comes back when a dialog closes", () => {
  it("Settings (⌘,) gives the keyboard back to the message box", async () => {
    const { user, composer } = await chatWithComposer();
    press(",", "Comma");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("the command palette (⌘K) gives it back when dismissed", async () => {
    const { user, composer } = await chatWithComposer();
    press("k", "KeyK");
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("still does under React's StrictMode, which runs the dialog's effects twice (as main.tsx renders)", async () => {
    installBrowserMock({ delay: 0 });
    setCardRules({});
    setGroupToolCalls(false);
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    const user = userEvent.setup();
    const log = await sendInQuickChat(user, "hello there");
    expect(log).toBeInTheDocument();
    const composer = screen.getByRole("combobox", { name: "Message" });
    await user.click(composer);
    press("k", "KeyK");
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("Settings opened from the sidebar gives it back to the sidebar button", async () => {
    const { user } = renderApp();
    const button = await screen.findByRole("button", { name: /^settings/i });
    await user.click(button);
    await screen.findByRole("dialog", { name: "Settings" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    await waitFor(() => expect(button).toHaveFocus());
  });

  it("an expanded UI gives it back to its Expand button", async () => {
    const app = renderApp();
    const log = await sendInQuickChat(app.user, "give me the diff of my project in workspace of yaah");
    const card = await within(log).findByRole("group", { name: "Folder request" });
    await app.user.click(within(card).getByRole("button", { name: "Add" }));
    const files = await within(log).findByRole("navigation", { name: "Files" });
    const caption = files.closest("figure")!.querySelector("figcaption") as HTMLElement;
    const expand = within(caption).getByRole("button", { name: /^Expand / });
    await app.user.click(expand);
    await screen.findByRole("dialog", { name: "yaah: the last commit against the one before" });
    await app.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(expand).toHaveFocus());
  });
});

const options: PermissionOption[] = [
  { optionId: "y", name: "Yes", kind: "allow_once" },
  { optionId: "n", name: "No", kind: "reject_once" },
];
const pending = (requestId: number, title: string): Entry => ({ type: "permission", requestId, toolCallId: null, title, options, chosen: null });

/** A chat whose transcript is `entries`, opened in the App. */
async function openChat(entries: Entry[]) {
  const mock = installBrowserMock({ delay: 0 });
  setCardRules({});
  setGroupToolCalls(false);
  const c = await api.newQuickChat("default");
  Object.assign(mock.sessions[c.sessionId], { title: "seeded chat" });
  mock.transcripts[c.sessionId] = entries;
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "seeded chat" }));
  return await screen.findByRole("log", { name: "Conversation" });
}

describe("KB-1: answering a permission moves the keyboard on", () => {
  it("to the next request waiting, then to the message box", async () => {
    // Two waiting requests are one grouped card; answering one leaves the other as a single card.
    await openChat([{ type: "user", text: "go", attachments: [] }, pending(1, "Run ls"), pending(2, "Run pwd")]);
    const batch = await screen.findByRole("group", { name: "2 permission requests" });
    const allow = within(batch).getByRole("button", { name: "Allow: Run ls" });
    allow.focus();
    fireEvent.click(allow);
    const second = await screen.findByRole("group", { name: "Permission requested" });
    await waitFor(() => expect(within(second).getByRole("button", { name: "Yes" })).toHaveFocus());
    fireEvent.click(within(second).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveFocus());
  });

  it("announces a waiting request at once (SR-2)", async () => {
    await openChat([{ type: "user", text: "go", attachments: [] }, pending(1, "Run ls")]);
    const card = await screen.findByRole("group", { name: "Permission requested" });
    expect(within(card).getByRole("alert")).toHaveTextContent("Permission requested: Run ls");
  });
});

describe("SR-5: landmarks and a skip link", () => {
  it("has one main landmark around the panes, and a skip link first that lands in the message box", async () => {
    const { user, composer } = await chatWithComposer();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("main")).toContainElement(composer);
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    // First in the tab order: before the sidebar.
    const focusable = document.querySelectorAll("a[href], button:not([disabled]), [tabindex='0'], textarea, input");
    expect(focusable[0]).toBe(skip);
    expect(screen.getByRole("complementary", { name: "Sidebar" }).compareDocumentPosition(skip) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    composer.blur();
    await user.click(skip);
    expect(composer).toHaveFocus();
  });
});

describe("SR-3: Expand and its dialog are named by the UI", () => {
  it("names a UI by its title, then by what its props show, then by its component in words", () => {
    expect(uiTitle({ title: "Refunds", component: "file-view", props: { path: "src/a.rs" } })).toBe("Refunds");
    expect(uiTitle({ title: null, component: "file-view", props: { path: "src/billing/refund.rs" } })).toBe("src/billing/refund.rs");
    expect(uiTitle({ title: null, component: "file-view", props: {} })).toBe("File view");
    expect(uiTitle({ title: null, component: null })).toBe("UI");
  });

  it("gives each Expand button in a chat its own name, and the dialog a human title", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "expand fill");
    await waitFor(() => expect(within(log).getAllByRole("button", { name: /^Expand/ }).length).toBeGreaterThanOrEqual(6));
    const names = within(log)
      .getAllByRole("button", { name: /^Expand/ })
      .filter((b) => b.closest("figcaption"))
      .map((b) => b.getAttribute("aria-label"));
    expect(names).not.toContain("Expand");
    expect(names).toContain("Expand docs/release.mdx");
    expect(names).toContain("Expand Container logs");
    await user.click(within(log).getByRole("button", { name: "Expand docs/release.mdx" }));
    const dialog = await screen.findByRole("dialog", { name: "docs/release.mdx" });
    expect(dialog).toHaveAccessibleDescription(/^file-view v\d+$/);
  });
});

describe("SR-6: the font sliders speak their value", () => {
  it("says pixels and default, as the label beside it does", async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole("button", { name: /^settings/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "General" }));
    const ui = await within(dialog).findByRole("slider", { name: "Interface size" });
    expect(ui).toHaveAttribute("aria-valuenow", "14");
    expect(ui).toHaveAttribute("aria-valuetext", "14 pixels, default");
    fireEvent.keyDown(ui, { key: "ArrowRight" });
    await waitFor(() => expect(ui).toHaveAttribute("aria-valuetext", "15 pixels"));
    expect(within(dialog).getByRole("slider", { name: "Code size" }).getAttribute("aria-valuetext")).toMatch(/^\d+ pixels/);
  });
});

describe("SR-4: map markers", () => {
  it("are named by their label and status, or by their place in the list", () => {
    expect(markerName({ label: "Ohio", tone: "default" }, 0, 3)).toBe("Ohio");
    expect(markerName({ label: "Ohio", tone: "danger" }, 0, 3)).toBe("Ohio (problem)");
    expect(markerName({ label: undefined, tone: "warning" }, 1, 3)).toBe("Marker 2 of 3 (warning)");
  });

  it("become focusable buttons that show their label on focus and open on Enter", () => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const seen: string[] = [];
    makeMarkerAccessible(path, "Ohio (problem)", { open: () => seen.push("open"), focus: () => seen.push("focus"), blur: () => seen.push("blur") });
    expect(path).toHaveAttribute("role", "button");
    expect(path).toHaveAttribute("tabindex", "0");
    expect(path).toHaveAttribute("aria-label", "Ohio (problem)");
    path.dispatchEvent(new FocusEvent("focus"));
    path.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    path.dispatchEvent(new KeyboardEvent("keydown", { key: "a", cancelable: true }));
    path.dispatchEvent(new FocusEvent("blur"));
    expect(seen).toEqual(["focus", "open", "blur"]);
  });
});

describe("SM-1: the smallest text has a floor", () => {
  it("floors text-xs and text-2xs at 11px in the theme, so the 12px interface doesn't shrink them under it", async () => {
    const css = await readIndexCss();
    const theme = declarations(css, "@theme inline");
    expect(theme["text-xs"]).toBe("max(0.75rem, 11px)");
    expect(theme["text-2xs"]).toBe("max(0.6875rem, 11px)");
    // No arbitrary rem sizes under the floor left in components.
    expect(css).not.toMatch(/text-\[0\.6/);
  });

  it("draws the Allowed chip on a tool card at the floored size", async () => {
    const log = await openChat([
      { type: "user", text: "go", attachments: [] },
      { type: "tool", toolCallId: "t1", title: "Read a.rs", kind: "read", status: "completed", content: [], locations: [], rawInput: null },
      { type: "permission", requestId: 1, toolCallId: "t1", title: "Read a.rs", options, chosen: "Yes", answer: "allow_once" },
    ]);
    const chip = await within(log).findByText("Allowed");
    expect(chip.parentElement).toHaveClass("text-2xs");
    expect(chip.parentElement?.className).not.toMatch(/text-\[/);
  });
});
