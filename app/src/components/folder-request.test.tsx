// The agent asking to add a folder to the chat (`ui_request_folders`): the inline card, Add
// (through the add-repos flow, then diff-review reads the repo with `repo`) and Not now.
// Against the real App and the browser mock's "diff of my project" replay.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, sendInQuickChat } from "@/test/app";

const repo = "/Users/dev/Documents/workspace/yaah";

/** Every call the app makes to `cmd`, by its arguments. */
function calls(cmd: string) {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const spy = vi.spyOn(internals, "invoke");
  return () => spy.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

async function askForTheRepo() {
  const app = renderApp();
  const answers = calls("answer_folder_request");
  const adds = calls("add_chat_dirs");
  const log = await sendInQuickChat(app.user, "give me the diff of my project in workspace of yaah");
  const card = await within(log).findByRole("group", { name: "Folder request" });
  return { ...app, log, card, answers, adds };
}

describe("a folder request", () => {
  it("says what the agent wants to add and why, and waits", async () => {
    const { card } = await askForTheRepo();
    expect(card).toHaveTextContent("The agent wants to add ~/Documents/workspace/yaah to this chat");
    expect(card).toHaveTextContent("to show the diff of your yaah project");
    expect(within(card).getByText("~/Documents/workspace/yaah")).toHaveAttribute("title", repo);
    expect(within(card).getByRole("button", { name: "Add" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Not now" })).toBeEnabled();
    // The turn is waiting on the user.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("Add: the folder joins the chat, and the diff review reads it", async () => {
    const { user, log, card, answers } = await askForTheRepo();
    await user.click(within(card).getByRole("button", { name: "Add" }));
    expect(answers()).toEqual([expect.objectContaining({ index: 2, add: true })]);
    await within(card).findByText("→ Added");
    expect(within(card).queryByRole("button", { name: "Add" })).toBeNull();
    // The add-repos flow's notice, and the folder in the chat's header.
    expect(await within(log).findByRole("status", { name: "Repositories added" })).toHaveTextContent("Added yaah to this chat");
    expect(screen.getByRole("button", { name: /folders? in this chat/ })).toHaveAccessibleName(/^2 folders in this chat/);
    // diff-review with `repo` reads it (the mock refuses a repo outside the chat's folders, as Rust does).
    expect(await within(log).findByRole("navigation", { name: "Files" })).toBeInTheDocument();
    expect(within(log).queryByText(/isn't one of this chat's folders/)).toBeNull();
    await screen.findByRole("button", { name: "Send" });
  });

  it("Not now: nothing is added and the agent carries on without it", async () => {
    const { user, log, card, answers, adds } = await askForTheRepo();
    await user.click(within(card).getByRole("button", { name: "Not now" }));
    expect(answers()).toEqual([expect.objectContaining({ add: false })]);
    await within(card).findByText("→ Not now");
    await within(log).findByText("OK, I'll leave that folder out of this chat.");
    expect(adds()).toEqual([]);
    expect(within(log).queryByRole("status", { name: "Repositories added" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: /folders? in this chat/ })).toHaveAccessibleName(/^1 folder in this chat/));
  });
});
