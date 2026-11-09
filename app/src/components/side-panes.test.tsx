// Side panes beside a chat: layout.ts's `ui` kind and `openBeside`, and against the real App and
// the browser mock, the agent's `ui_open_pane` (a UI moved out of the chat and kept live there, a
// diff, no duplicates) and the user's own "Open in a side pane", with Show here putting it back.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  MIN_PANE,
  openBeside,
  panesOf,
  prune,
  sameContent,
  showing,
  shownUis,
  singlePane,
  splitPane,
  uiKey,
  type Layout,
  type Selection,
} from "@/lib/layout";
import { chatPane } from "@/hooks/use-side-panes";
import { renderApp, sendInQuickChat } from "@/test/app";

const ui = (chat: string, index: number): Selection => ({ kind: "ui", chat, index });

/** p1 on chat c1, p2 (focused) on the home screen, side by side. */
function twoPanes(): Layout {
  const { layout } = splitPane(singlePane({ kind: "chat", id: "c1" }), "p1", "row", null);
  return layout;
}

describe("layout.ts: the ui kind", () => {
  it("compares by chat and index", () => {
    expect(sameContent(ui("c1", 2), ui("c1", 2))).toBe(true);
    expect(sameContent(ui("c1", 2), ui("c1", 3))).toBe(false);
    expect(sameContent(ui("c1", 2), ui("c2", 2))).toBe(false);
    expect(sameContent(ui("c1", 2), { kind: "chat", id: "c1" })).toBe(false);
  });

  it("lists the UIs shown in panes, and goes with its chat", () => {
    const { layout } = splitPane(twoPanes(), "p1", "column", ui("c1", 4));
    expect(shownUis(layout)).toEqual(new Map([[uiKey("c1", 4), "p3"]]));
    const pruned = prune(layout, (c) => !(c?.kind === "ui" && c.chat === "c1"));
    expect(panesOf(pruned.root).map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("finds the pane showing the same UI, or a diff of the same folder", () => {
    const { layout } = splitPane(twoPanes(), "p1", "column", { kind: "diff", cwd: "/a", mode: "staged" });
    expect(showing(layout, { kind: "diff", cwd: "/a", mode: "all" })?.id).toBe("p3");
    expect(showing(layout, { kind: "diff", cwd: "/b" })).toBeUndefined();
    expect(showing(layout, { kind: "diff" })).toBeUndefined();
    expect(showing(layout, ui("c1", 0))).toBeUndefined();
  });
});

describe("layout.ts: openBeside", () => {
  it("splits the chat's pane in the direction asked, the focus staying put unless asked", () => {
    const r = openBeside(twoPanes(), "p1", ui("c1", 1), "row")!;
    expect(r.id).toBe("p3");
    expect(r.layout.focused).toBe("p2");
    expect(panesOf(r.layout.root).map((p) => p.id)).toEqual(["p1", "p3", "p2"]);
    const down = openBeside(twoPanes(), "p1", ui("c1", 1), "column", { focus: true })!;
    expect(down.layout.focused).toBe("p3");
    expect(down.layout.root.type === "split" && down.layout.root.a.type === "split" && down.layout.root.a.dir).toBe("column");
  });

  it("reuses the pane already showing it (a diff takes the new mode) instead of stacking another", () => {
    const first = openBeside(twoPanes(), "p1", { kind: "diff", cwd: "/a" }, "row")!;
    const again = openBeside(first.layout, "p1", { kind: "diff", cwd: "/a", mode: "branch", base: "main" }, "row")!;
    expect(again.id).toBe(first.id);
    expect(panesOf(again.layout.root)).toHaveLength(3);
    expect(panesOf(again.layout.root).find((p) => p.id === first.id)?.content).toEqual({ kind: "diff", cwd: "/a", mode: "branch", base: "main" });
    const same = openBeside(first.layout, "p1", { kind: "diff", cwd: "/a" }, "row")!;
    expect(same.layout).toBe(first.layout);
    expect(openBeside(first.layout, "p1", { kind: "diff", cwd: "/a" }, "row", { focus: true })!.layout.focused).toBe(first.id);
  });

  it("splits the largest pane that has room when the chat's is too small, and gives up at the pane limit", () => {
    // p1 a sliver on the left (10% of 1000px is narrower than two minimum panes), p2 the rest.
    const l = twoPanes();
    const narrow: Layout = l.root.type === "split" ? { ...l, root: { ...l.root, ratio: 0.1 } } : l;
    const size = { w: 1000, h: 800 };
    const r = openBeside(narrow, "p1", ui("c1", 0), "row", { size })!;
    expect(panesOf(r.layout.root).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    // Room enough below it, though: a column split keeps p1.
    expect(openBeside(narrow, "p1", ui("c1", 0), "column", { size })!.layout.root).toMatchObject({ a: { type: "split", dir: "column" } });
    // A grid too small for anything: the chat's pane all the same.
    expect(openBeside(narrow, "p1", ui("c1", 0), "row", { size: { w: MIN_PANE.w, h: 100 } })!.layout.root).toMatchObject({ a: { type: "split" } });
    // An unknown pane: beside the focused one.
    expect(openBeside(twoPanes(), "nope", ui("c1", 0), "row")!.layout.root).toMatchObject({ b: { type: "split", a: { id: "p2" } } });

    let full = singlePane();
    while (panesOf(full.root).length < MAX_PANES) full = splitPane(full, full.focused, "row").layout;
    expect(openBeside(full, full.focused, ui("c1", 0), "row")).toBeNull();
  });

  it("starts from the pane showing the chat, the focused one among several", () => {
    const l = twoPanes();
    expect(chatPane(l, "c1")).toBe("p1");
    expect(chatPane(l, "c2")).toBeUndefined();
    const both = splitPane(l, "p2", "row", { kind: "chat", id: "c1" }).layout;
    expect(chatPane(both, "c1")).toBe("p3");
  });
});

const paneEls = () => [...document.querySelectorAll<HTMLElement>("[data-pane-id]")];
const uiPane = () => paneEls().find((p) => within(p).queryByRole("button", { name: "Close UI pane" }));
const findUiPane = () =>
  waitFor(() => {
    const p = uiPane();
    expect(p).toBeDefined();
    return p!;
  });

describe("ui_open_pane: the agent moves a UI into a side pane", () => {
  it("moves it out of the chat, keeps it live there, and Show here brings it back", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "pin the deploys in a side pane");
    const pane = await findUiPane();
    expect(pane).toHaveTextContent("Deploys");
    // The agent re-rendered it in place: the pane follows.
    await waitFor(() => expect(within(pane).getAllByText("live")).toHaveLength(2));
    // The chat keeps a link instead of a second copy.
    const note = await within(log).findByRole("note");
    expect(note).toHaveTextContent(/Shown in a side pane\s*·\s*Show here/);
    expect(within(log).queryByRole("table")).toBeNull();
    // Listed with the open panes, named by the UI.
    const open = screen.getByRole("region", { name: "Open panes" });
    expect(within(open).getByRole("button", { name: /^UI: Deploys/ })).toBeInTheDocument();

    await user.click(within(note).getByRole("button", { name: "Show here" }));
    await waitFor(() => expect(uiPane()).toBeUndefined());
    expect(paneEls()).toHaveLength(1);
    expect(await within(log).findByRole("table")).toBeInTheDocument();
    expect(within(log).queryByRole("note")).toBeNull();
  });

  it("opens the chat's diff beside it, once", async () => {
    const { user } = renderApp();
    await sendInQuickChat(user, "open the diff in a side pane");
    await waitFor(() => expect(paneEls().filter((p) => within(p).queryByRole("button", { name: "Close diff pane" }))).toHaveLength(1));
    const diff = paneEls().find((p) => within(p).queryByRole("button", { name: "Close diff pane" }))!;
    expect(await within(diff).findByRole("navigation", { name: "Files" })).toBeInTheDocument();
    // Asked again: the same pane, not another.
    await screen.findByRole("button", { name: "Send" });
    const composer = screen.getByRole("combobox", { name: "Message" });
    await user.type(composer, "show the changes in a pane{Enter}");
    await waitFor(() => expect(screen.getAllByText("The diff is open beside the chat.")).toHaveLength(2));
    expect(paneEls()).toHaveLength(2);
  });
});

describe("Open in a side pane: the user moves a UI", () => {
  it("from the entry's header, and the pane's close button puts it back", async () => {
    const { user } = renderApp();
    const log = await sendInQuickChat(user, "assemble the deploys");
    await user.click(await within(log).findByRole("button", { name: "Open Deploys in a side pane" }));
    const pane = await findUiPane();
    expect(await within(pane).findByRole("table")).toBeInTheDocument();
    expect(await within(log).findByRole("note")).toHaveTextContent("Shown in a side pane");
    // Asked again (the palette, the menu): the same pane.
    fireEvent.click(within(log).getByRole("button", { name: "Shown in a side pane" }));
    expect(paneEls()).toHaveLength(2);

    await user.click(within(pane).getByRole("button", { name: "Close UI pane" }));
    await waitFor(() => expect(uiPane()).toBeUndefined());
    expect(await within(log).findByRole("table")).toBeInTheDocument();
  });
});
