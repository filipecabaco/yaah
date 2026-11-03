// Adding repositories to a chat as it goes (docs/research/chat-repos-contract.md): from ⌘K, `/repos`
// and the header's folder menu, the picker's copy for a quick chat and a project chat, and the
// transcript's notice. Against the real App and the browser mock.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, sendInQuickChat } from "@/test/app";

const ws = "/Users/dev/workspace";

/** Every `add_chat_dirs` call the app makes, by its arguments. */
function addCalls() {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const spy = vi.spyOn(internals, "invoke");
  return () => spy.mock.calls.filter(([c]) => c === "add_chat_dirs").map(([, args]) => args);
}

type User = ReturnType<typeof renderApp>["user"];

/** Tick `name` in the open picker and add it; returns the picker as it was. */
async function pickRepo(user: User, dialog: HTMLElement, name: string) {
  await user.click(await within(dialog).findByRole("option", { name: new RegExp(`^${name}\\b`) }));
  await user.click(within(dialog).getByRole("button", { name: /^Add repo to/ }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
}

const folders = () => screen.getByRole("button", { name: /folders? in this chat/ });

describe("adding repositories to a quick chat", () => {
  it("from ⌘K: the picker says it's for this chat, and the chat says what was added", async () => {
    const { user } = renderApp();
    const calls = addCalls();
    const log = await sendInQuickChat(user, "check the mcp servers");
    await screen.findByRole("button", { name: "Send" });
    expect(folders()).toHaveAccessibleName(/^1 folder in this chat/);

    await user.click(screen.getByRole("button", { name: /^Search/ }));
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    await user.type(within(palette).getByRole("combobox"), "add repositories");
    await user.click(await within(palette).findByRole("option", { name: /Add repositories….*to this chat/ }));

    const picker = await screen.findByRole("dialog", { name: "Add repositories to this chat" });
    expect(within(picker).getByText("Only this chat gets them, from the next message.")).toBeInTheDocument();
    await pickRepo(user, picker, "web");

    expect(calls().map((a) => (a as { paths: string[] }).paths)).toEqual([[`${ws}/web`]]);
    const notice = await within(log).findByRole("status", { name: "Repositories added" });
    expect(notice).toHaveTextContent(/Added web to this chat/);
    expect(notice).toHaveTextContent("~/workspace/web");
    await waitFor(() => expect(folders()).toHaveAccessibleName(/^2 folders in this chat/));
  });

  it("with /repos in the composer, marked as yaah's own", async () => {
    const { user } = renderApp();
    await sendInQuickChat(user, "check the mcp servers");
    await screen.findByRole("button", { name: "Send" });
    const composer = screen.getByRole("combobox", { name: "Message" });
    await user.type(composer, "/rep");
    await user.click(await screen.findByRole("option", { name: /\/repos.*yaah.*Add repositories to this chat/ }));
    expect(await screen.findByRole("dialog", { name: "Add repositories to this chat" })).toBeInTheDocument();
    expect(composer).toHaveValue("");
  });

  it("from the header's folder menu, which lists the chat's folders and leaves added ones out of the picker", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "check the mcp servers");
    await screen.findByRole("button", { name: "Send" });

    await user.click(folders());
    let menu = await screen.findByRole("menu");
    expect(within(menu).getByText("This chat works in")).toBeInTheDocument();
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    await user.click(within(menu).getByRole("menuitem", { name: "Add repositories…" }));
    await pickRepo(user, await screen.findByRole("dialog", { name: "Add repositories to this chat" }), "docs");
    await within(log).findByRole("status", { name: "Repositories added" });

    await user.click(folders());
    menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /^docs\s*~\/workspace\/docs/ })).toBeInTheDocument();
    expect(within(menu).getByText("New folders reach the agent with your next message.")).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Add repositories…" }));
    const picker = await screen.findByRole("dialog", { name: "Add repositories to this chat" });
    const added = await within(picker).findByRole("option", { name: /^docs\b/ });
    expect(added).toHaveAttribute("aria-disabled", "true");
  });
});

describe("adding repositories to a project chat", () => {
  it("adds them to the project, says so in the picker and the chat, and the project page shows them", async () => {
    const { user, mock } = renderApp();
    await user.click(within(await screen.findByRole("complementary")).getByRole("button", { name: "billing revamp" }));
    await user.click(await screen.findByRole("button", { name: /^New chat as/ }));
    const composer = await screen.findByRole("combobox", { name: "Message" });

    await user.type(composer, "/repos{Enter}");
    const picker = await screen.findByRole("dialog", { name: "Add repositories to billing revamp" });
    expect(within(picker).getByText(/They join the project: this chat and every other chat in it/)).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: /^web\b/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(within(picker).getByRole("option", { name: /^infra\b/ }));
    await user.click(within(picker).getByRole("button", { name: "Add repo to project" }));

    const log = screen.getByRole("log", { name: "Conversation" });
    expect(await within(log).findByRole("status", { name: "Repositories added" })).toHaveTextContent(/Added infra to this project/);
    expect(mock.projects[0].dirs).toContain(`${ws}/infra`);
    await waitFor(() => expect(folders()).toHaveAccessibleName(/^3 folders in this chat/));
    await user.click(folders());
    expect(within(await screen.findByRole("menu")).getByText("This chat works in its project's folders")).toBeInTheDocument();
  });
});
