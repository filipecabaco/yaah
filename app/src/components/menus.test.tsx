// Right-click menus against the real App and the browser mock: what each menu
// offers where it opens, and that its items do what they say.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatKeys, isMac, MOD, SHORTCUTS } from "@/lib/shortcuts";
import { renderApp, sendInQuickChat } from "@/test/app";

const keys = (id: keyof typeof SHORTCUTS) => formatKeys(SHORTCUTS[id].keys);
const REVEAL = isMac ? "Reveal in Finder" : "Show in file manager";

/** Right-click `el` and return the menu that opens. */
async function rightClick(el: Element) {
  fireEvent.contextMenu(el);
  return screen.findByRole("menu");
}

const items = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((i) => i.textContent.trim());

/** Every call to a Tauri command, as the browser mock receives it. */
function spyInvoke() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  return vi.spyOn(internals, "invoke");
}

const spyClipboard = () => vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

afterEach(() => {
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

describe("a link in an agent's reply", () => {
  it("opens or copies the link from the top of the message's menu", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "explain the links");
    const link = await within(log).findByText("ACP spec");
    const invoke = spyInvoke();
    const writeText = spyClipboard();

    const menu = await rightClick(link);
    expect(items(menu).slice(0, 2)).toEqual(["Open link", "Copy link"]);
    expect(items(menu)).toContain("Copy text");
    await user.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://agentclientprotocol.com/protocol/overview");

    await user.click(within(await rightClick(link)).getByRole("menuitem", { name: "Open link" }));
    expect(invoke).toHaveBeenCalledWith(
      "plugin:opener|open_url",
      expect.objectContaining({ url: "https://agentclientprotocol.com/protocol/overview" }),
      undefined,
    );
  });

  it("offers nothing for a link that isn't a web link, and Copy code inside a code block", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "explain the links");
    const local = await within(log).findByText("config.toml");
    expect(items(await rightClick(local))).not.toContain("Open link");
    await user.keyboard("{Escape}");

    const writeText = spyClipboard();
    const menu = await rightClick(
      // Highlighted, the command is split into coloured spans: find the block by its whole text.
      await within(log).findByText((_, el) => el?.tagName === "CODE" && el.textContent?.trim() === "cargo test --lib retry"),
    );
    expect(items(menu)).toContain("Copy code");
    await user.click(within(menu).getByRole("menuitem", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("cargo test --lib retry");
  });
});

describe("messages", () => {
  it("quotes an agent message in the composer, or only the selected part of it", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "explain the links");
    const last = await within(log).findByText("It backs off up to five times.");
    const composer = screen.getByRole("combobox", { name: "Message" });

    await user.click(within(await rightClick(last)).getByRole("menuitem", { name: "Quote in reply" }));
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toMatch(/^> The retry logic follows/));
    expect((composer as HTMLTextAreaElement).value).toContain("\n>\n> ```sh\n> cargo test --lib retry\n");
    await user.clear(composer);

    // Select "five times" in the last paragraph.
    const text = last.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf("five"));
    range.setEnd(text, text.data.indexOf("."));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    expect(window.getSelection()?.toString()).toBe("five times");
    const menu = await rightClick(last);
    expect(items(menu)).toContain(`Copy selection${formatKeys([MOD, "C"])}`);
    await user.click(within(menu).getByRole("menuitem", { name: "Quote in reply" }));
    await waitFor(() => expect(composer).toHaveValue("> five times\n\n"));
  });

  it("puts the user's own message back in the composer to edit", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "explain the links");
    await within(log).findByText("ACP spec");
    const composer = screen.getByRole("combobox", { name: "Message" });

    const menu = await rightClick(within(log).getByText("explain the links"));
    expect(items(menu)).toEqual(["Edit as new message", "Copy text"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Edit as new message" }));
    await waitFor(() => expect(composer).toHaveValue("explain the links"));
  });
});

describe("tool calls and permissions", () => {
  it("copies a permission request with the input of the tool call it asks about", async () => {
    const { user } = renderApp();
    await sendInQuickChat(user, "write hello.txt please");
    const permission = await screen.findByRole("group", { name: "Permission requested" });
    const writeText = spyClipboard();

    const menu = await rightClick(within(permission).getByText("Permission requested"));
    expect(items(menu)).toEqual(["Copy request"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Copy request" }));
    const copied = writeText.mock.calls[0][0];
    expect(copied.split("\n")[0]).toBe("Write /Users/dev/workspace/api/hello.txt");
    expect(JSON.parse(copied.slice(copied.indexOf("\n\n") + 2))).toEqual({
      content: "hi from yaah",
      file_path: "/Users/dev/workspace/api/hello.txt",
    });
  });

  it("offers the file path, and Ask about this on the card's diff", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "write hello.txt please");
    await screen.findByRole("group", { name: "Permission requested" });

    // The card's title: no diff under the pointer.
    const title = within(log).getAllByText("Write /Users/dev/workspace/api/hello.txt")[0];
    const menu = await rightClick(title);
    expect(items(menu)).toEqual(expect.arrayContaining(["Copy title", "Copy input", "Copy file path"]));
    expect(items(menu)).not.toContain("Ask about this");
    await user.keyboard("{Escape}");

    // A line of its diff: Ask about this first, then the card's own items.
    const line = await within(log).findByText("hi from yaah", { selector: "span" });
    const onDiff = await rightClick(line);
    expect(items(onDiff)[0]).toBe("Ask about this");
    expect(items(onDiff)).toContain("Copy file path");
    await user.click(within(onDiff).getByRole("menuitem", { name: "Ask about this" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("About @/Users/dev/workspace/api/hello.txt line 1: "));
  });

  it("opens a rendered library component in the Component library", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "show the service status as ui");
    const badge = await within(log).findByText("service-status-overview v1", {}, { timeout: 15_000 });

    const menu = await rightClick(badge);
    expect(items(menu)).toEqual(["Open in Component library", "Copy UI JSON", "Copy props JSON"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Open in Component library" }));
    expect(await screen.findByRole("heading", { level: 2, name: "service-status-overview" })).toBeInTheDocument();
  });
});

describe("the sidebar", () => {
  it("starts chats and projects from the Chats header, and projects from the Projects header", async () => {
    const { user } = renderApp();
    const chats = await screen.findByText("Chats", { selector: "span" });

    const menu = await rightClick(chats);
    expect(items(menu)).toEqual([
      `New quick chat${keys("newChat")}`,
      "Quick chat with",
      "New chat in a folder…",
      `New project…${keys("newProject")}`,
    ]);
    await user.keyboard("{Escape}");

    const projects = await rightClick(screen.getByText("Projects", { selector: "span" }));
    expect(items(projects)).toEqual([`New project…${keys("newProject")}`]);
    await user.click(within(projects).getByRole("menuitem", { name: /New project/ }));
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeInTheDocument();
  });

  it("reveals or copies a chat's folder from its row", async () => {
    const { user } = renderApp();
    await sendInQuickChat(user, "explain the links");
    const title = screen.getByRole("heading", { level: 1 }).textContent ?? "";
    const row = within(screen.getByRole("complementary")).getByRole("button", { name: title });
    const invoke = spyInvoke();
    const writeText = spyClipboard();

    const menu = await rightClick(row);
    expect(items(menu)).toEqual(expect.arrayContaining(["Open", REVEAL, "Copy folder path", "Copy session ID", "Delete…"]));
    await user.click(within(menu).getByRole("menuitem", { name: "Copy folder path" }));
    const folder = writeText.mock.calls[0][0];
    expect(folder).toMatch(/\/\.yaah\/scratch\//);

    await user.click(within(await rightClick(row)).getByRole("menuitem", { name: REVEAL }));
    expect(invoke).toHaveBeenCalledWith("plugin:opener|reveal_item_in_dir", { paths: [folder] }, undefined);
  });
});

describe("the Component library", () => {
  it("copies a library component's name, or opens the copy form for it from its row", async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole("button", { name: "Component library" }));
    const nav = await screen.findByRole("navigation", { name: "Components" });
    const writeText = spyClipboard();

    const row = await within(nav).findByRole("button", { name: /platform\/host-health/ });
    const menu = await rightClick(row);
    expect(items(menu)).toEqual(["Open", "Copy to my collection…", "Copy name"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Copy name" }));
    expect(writeText).toHaveBeenCalledWith("platform/host-health");

    await user.click(within(await rightClick(row)).getByRole("menuitem", { name: "Copy to my collection…" }));
    expect(await screen.findByRole("heading", { level: 2, name: "platform/host-health" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name in your collection" })).toHaveValue("host-health");

    // The user's own components can be shared instead.
    const own = await rightClick(within(nav).getByRole("button", { name: /^ops-board/ }));
    expect(items(own)).toEqual(["Open", "Share as library…", "Copy name"]);
    await user.click(within(own).getByRole("menuitem", { name: "Share as library…" }));
    expect(await screen.findByRole("dialog", { name: "Share as library" })).toBeInTheDocument();
  });
});
