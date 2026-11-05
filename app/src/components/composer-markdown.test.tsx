// Markdown help in the real message box: lists continue on Shift+Enter, ⌘B over a selection
// is bold (and doesn't fold the sidebar), and a URL pasted over a selection becomes a link.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isMac } from "@/lib/shortcuts";
import { renderApp } from "@/test/app";

async function composer() {
  const app = renderApp();
  await app.user.click(await screen.findByRole("button", { name: /^quick chat\b(?!s)/i }));
  const box = await screen.findByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
  return { ...app, box };
}

describe("markdown in the message box", () => {
  it("Shift+Enter continues a list, and an empty item ends it", async () => {
    const { user, box } = await composer();
    await user.click(box);
    await user.keyboard("- one");
    // fireEvent from here: user-event keeps its own copy of the value, and the edit (made with the
    // browser's insert-text command in the app) lands through setRangeText in the test DOM.
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(box.value).toBe("- one\n- ");
    expect(box.selectionStart).toBe(8);
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(box.value).toBe("- one\n");
  });

  it("⌘B over a selection makes it bold and leaves the sidebar alone", async () => {
    const { user, box } = await composer();
    await user.click(box);
    await user.keyboard("make this bold");
    box.setSelectionRange(10, 14);
    fireEvent.keyDown(box, { key: "b", code: "KeyB", metaKey: isMac, ctrlKey: !isMac });
    expect(box.value).toBe("make this **bold**");
    // The sidebar is still there: the key didn't reach the app's ⌘B.
    expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeInTheDocument();
    // With nothing selected, ⌘B is the sidebar's again.
    box.setSelectionRange(0, 0);
    fireEvent.keyDown(box, { key: "b", code: "KeyB", metaKey: isMac, ctrlKey: !isMac });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull());
  });

  it("a URL pasted over selected text becomes a link", async () => {
    const { user, box } = await composer();
    await user.click(box);
    await user.keyboard("see the PR");
    box.setSelectionRange(4, 10);
    fireEvent.paste(box, { clipboardData: { files: [], getData: (t: string) => (t === "text/plain" ? "https://github.com/x/y/pull/9" : "") } });
    await waitFor(() => expect(box.value).toBe("see [the PR](https://github.com/x/y/pull/9)"));
  });
});

describe("markdown in a sent message", () => {
  it("draws the user's own message as Markdown, keeping its line breaks", async () => {
    const { user, box } = await composer();
    await user.click(box);
    fireEvent.change(box, { target: { value: "say **loudly** with `code`\n- one\n- two" } });
    await user.type(box, "{Enter}");
    const log = screen.getByRole("log", { name: "Conversation" });
    const bold = await within(log).findByText("loudly");
    expect(bold.tagName).toBe("STRONG");
    expect(within(log).getByText("code").tagName).toBe("CODE");
    expect(
      within(log)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["one", "two"]);
  });
});
