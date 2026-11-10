// "Resume a session…" against the real App and the browser mock: from ⌘K and from a new
// pane's picker, the agent step, search, importing a session with its history, a session
// already in yaah opening its chat, and agents that can't list.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { openPalette } from "@/test/palette";
import { describe, expect, it } from "vitest";
import { isMac } from "@/lib/shortcuts";
import { renderApp } from "@/test/app";

async function started(options: Parameters<typeof renderApp>[0] = {}, setup?: (mock: ReturnType<typeof renderApp>["mock"]) => void) {
  const r = renderApp(options);
  setup?.(r.mock);
  await screen.findByRole("button", { name: /^quick chat\b(?!s)/i });
  return r;
}

/** ⌘K → "Resume a session…". */
async function openFromPalette(user: Awaited<ReturnType<typeof started>>["user"]) {
  await openPalette();
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  await user.type(within(dialog).getByRole("combobox"), "resume a session");
  await user.click(await within(dialog).findByRole("option", { name: /^Resume a session…/ }));
  return dialog;
}

const conversation = () => screen.getByRole("log", { name: "Conversation" });

describe("resume a session from ⌘K", () => {
  it("picks an agent, searches its sessions and opens one with its history", async () => {
    const { user, mock } = await started();
    const dialog = await openFromPalette(user);
    const agents = within(dialog)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(agents.some((a) => a?.startsWith("Claude (work)"))).toBe(true);

    await user.click(within(dialog).getByRole("option", { name: /^Claude dev@example\.com/ }));
    const first = await within(dialog).findByRole("option", { name: /Fix invoice rounding for multi-currency totals/ });
    expect(first).toHaveTextContent("api");
    expect(first).toHaveTextContent("min ago");
    expect(within(dialog).getByRole("option", { name: /Untitled session/ })).toBeInTheDocument();

    await user.type(within(dialog).getByRole("combobox"), "terraform");
    await waitFor(() => expect(within(dialog).getAllByRole("option")).toHaveLength(1));
    expect(within(dialog).getByRole("option")).toHaveTextContent("Terraform: move the queue workers to the new VPC");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    expect(await within(conversation()).findByText(/Plan the move of the queue workers/)).toBeInTheDocument();
    expect(within(conversation()).getByText(/workers_v2/)).toBeInTheDocument();
    const id = "c27a8f04-5e6b-4d13-b2c9-0e81f4a6d735";
    expect(mock.sessions[id]).toMatchObject({ accountId: "default", title: "Terraform: move the queue workers to the new VPC" });
  });

  it("opens the chat yaah already has instead of a second copy", async () => {
    const { user, mock } = await started();
    let dialog = await openFromPalette(user);
    await user.click(within(dialog).getByRole("option", { name: /^Claude \(work\)/ }));
    await user.click(await within(dialog).findByRole("option", { name: /Quarterly access review/ }));
    await within(conversation()).findByText(/Export everyone with admin/);
    const chats = Object.keys(mock.sessions).length;

    dialog = await openFromPalette(user);
    await user.click(within(dialog).getByRole("option", { name: /^Claude \(work\)/ }));
    const again = await within(dialog).findByRole("option", { name: /Quarterly access review/ });
    expect(again).toHaveTextContent("Already in yaah");
    expect(within(dialog).getByRole("option", { name: /Incident 4412/ })).not.toHaveTextContent("Already in yaah");
    await user.click(again);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    expect(await within(conversation()).findByText(/Export everyone with admin/)).toBeInTheDocument();
    expect(Object.keys(mock.sessions)).toHaveLength(chats);
  });

  it("says when an agent has no sessions, and ⌫ goes back to the agents", async () => {
    const { user } = await started();
    const dialog = await openFromPalette(user);
    await user.click(within(dialog).getByRole("option", { name: /^Claude · Bedrock/ }));
    expect(await within(dialog).findByText(/Claude · Bedrock has no sessions yet/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("combobox"));
    await user.keyboard("{Backspace}");
    expect(await within(dialog).findByRole("option", { name: /^Claude \(personal\)/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("option", { name: /^Claude \(personal\)/ }));
    expect(await within(dialog).findByRole("option", { name: /Plan the garden irrigation timer/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: /Fix invoice rounding/ })).toBeNull();
  });

  it("leaves out agents known not to list, and says why when one can't", async () => {
    const { user } = await started({}, (mock) => {
      const work = mock.profiles.find((p) => p.id === "work");
      if (!work) throw new Error("no work profile");
      work.report = { ...mock.profiles[0].report!, listSessions: false };
    });
    const dialog = await openFromPalette(user);
    expect(within(dialog).queryByRole("option", { name: /^Claude \(work\)/ })).toBeNull();
    expect(within(dialog).getByText("Claude (work) can't list its sessions.")).toBeInTheDocument();

    // Not known yet: offered, and the agent's answer is shown.
    await user.click(within(dialog).getByRole("option", { name: /^OpenCode · OpenRouter/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("OpenCode · OpenRouter can't list its sessions.");
  });
});

describe("resume a session from a new pane", () => {
  it("opens the session in that pane", async () => {
    const { user } = await started();
    act(() => {
      fireEvent.keyDown(document.activeElement ?? window, { key: "d", code: "KeyD", metaKey: isMac, ctrlKey: !isMac, bubbles: true });
    });
    const pane = () => {
      const el = document.querySelector<HTMLElement>('[data-pane-id="p2"]');
      if (!el) throw new Error("no pane p2");
      return el;
    };
    await user.click(within(pane()).getByRole("option", { name: /^Resume a session…/ }));
    expect(within(pane()).getByRole("heading", { name: "Resume a session" })).toBeInTheDocument();
    await user.click(within(pane()).getByRole("option", { name: /^Claude \(work\)/ }));
    await user.click(await within(pane()).findByRole("option", { name: /Incident 4412: postmortem timeline/ }));
    expect(await within(pane()).findByText(/Build the timeline for incident 4412/)).toBeInTheDocument();
    // The first pane still shows the home screen.
    expect(within(document.querySelector<HTMLElement>('[data-pane-id="p1"]')!).queryByText(/incident 4412/i)).toBeNull();
  });

  it("goes back to the picker with Esc", async () => {
    const { user } = await started();
    act(() => {
      fireEvent.keyDown(document.activeElement ?? window, { key: "d", code: "KeyD", metaKey: isMac, ctrlKey: !isMac, bubbles: true });
    });
    const pane = document.querySelector<HTMLElement>('[data-pane-id="p2"]')!;
    await user.click(within(pane).getByRole("option", { name: /^Resume a session…/ }));
    await user.click(within(pane).getByRole("combobox", { name: /Resume a session/ }));
    await user.keyboard("{Escape}");
    expect(await within(pane).findByRole("heading", { name: "Open in this pane" })).toBeInTheDocument();
  });
});

describe("while the agent lists", () => {
  it("shows that it's asking, then the sessions", async () => {
    const { user } = await started({ delay: 0.5 });
    const dialog = await openFromPalette(user);
    await user.click(within(dialog).getByRole("option", { name: /^Claude \(personal\)/ }));
    expect(within(dialog).getByText(/Asking Claude \(personal\) for its sessions…/)).toBeInTheDocument();
    expect(await within(dialog).findByRole("option", { name: /Plan the garden irrigation timer/ })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Asking/)).toBeNull();
  });
});

describe("long lists", () => {
  it("loads older sessions a page at a time", async () => {
    const { user } = await started();
    const dialog = await openFromPalette(user);
    await user.click(within(dialog).getByRole("option", { name: /^Claude dev@example\.com/ }));
    await within(dialog).findByRole("option", { name: /Fix invoice rounding/ });
    expect(within(dialog).queryByRole("option", { name: /idempotency keys/ })).toBeNull();
    await user.click(within(dialog).getByRole("option", { name: "Load older sessions" }));
    expect(await within(dialog).findByRole("option", { name: /Add idempotency keys to the refunds API/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: "Load older sessions" })).toBeNull();
  });
});
