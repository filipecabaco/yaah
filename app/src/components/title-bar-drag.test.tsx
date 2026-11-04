// What drags the window on macOS (no native title bar): the sidebar's top row, the hidden
// sidebar's title bar and the chat header, by Tauri's `data-tauri-drag-region` rules, with
// yaah's second try when Tauri's own mousedown didn't start a drag (use-titlebar.ts).
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inDragRegion, installDragFallback } from "@/hooks/use-titlebar";
import { isMac } from "@/lib/shortcuts";
import { renderApp, sendInQuickChat } from "@/test/app";

vi.mock("@/hooks/use-titlebar", async (real) => ({
  ...(await real<typeof import("@/hooks/use-titlebar")>()),
  overlayTitlebar: () => true,
  useTrafficLights: () => true,
}));

/** The element and its ancestors, innermost first: what `composedPath()` gives a mousedown on it. */
const pathOf = (el: Element): EventTarget[] => {
  const out: EventTarget[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) out.push(n);
  return [...out, document, window];
};

const toggleSidebar = () => fireEvent.keyDown(window, { key: "b", code: "KeyB", metaKey: isMac, ctrlKey: !isMac });

describe("the hidden sidebar's title bar", () => {
  it("drags the window from anywhere but its buttons", async () => {
    renderApp();
    await screen.findByRole("complementary", { name: "Sidebar" });
    toggleSidebar();
    const bar = await screen.findByLabelText("Title bar");
    expect(bar).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(bar.closest("[data-shown]")).not.toBeNull();
    expect(bar.closest("[inert]")).toBeNull();
    expect(inDragRegion(pathOf(bar))).toBe(true);
    // The logo inside it drags too; the buttons stay buttons.
    expect(inDragRegion(pathOf(bar.querySelector("svg.yaah-mark")!))).toBe(true);
    const buttons = within(bar).getAllByRole("button");
    expect(buttons.map((b) => b.textContent || b.getAttribute("aria-label"))).toEqual(["Show the sidebar", expect.stringContaining("Search")]);
    for (const b of buttons) {
      expect(inDragRegion(pathOf(b))).toBe(false);
      expect(inDragRegion(pathOf(b.firstElementChild ?? b))).toBe(false);
    }
  });

  it("has nothing laid over it: the panes sit below it, clipped to their own area", async () => {
    renderApp();
    await screen.findByRole("complementary", { name: "Sidebar" });
    toggleSidebar();
    const bar = await screen.findByLabelText("Title bar");
    const row = bar.closest("[data-shown]")!;
    const column = row.parentElement!;
    // The bar's row comes first in the main column, then the main landmark holding the pane grid, which clips its absolutely placed panes.
    const main = column.lastElementChild as HTMLElement;
    expect(main.tagName).toBe("MAIN");
    const grid = main.firstElementChild as HTMLElement;
    expect(column.firstElementChild).toBe(row);
    expect(grid).toHaveClass("relative", "overflow-hidden", "flex-1");
    expect(grid.querySelectorAll("section[data-pane-id]").length).toBeGreaterThan(0);
    expect(row.contains(grid)).toBe(false);
    // No fixed or absolute layer anywhere outside the grid could cover it.
    const loose = [...document.body.querySelectorAll<HTMLElement>(".fixed, .absolute")].filter(
      (el) => !grid.contains(el) && !el.closest("[aria-hidden=true]"),
    );
    expect(loose).toEqual([]);
  });

  it("goes when the sidebar is back, and the sidebar's top row drags instead", async () => {
    renderApp();
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    const hide = within(sidebar).getByRole("button", { name: "Hide the sidebar" });
    const row = hide.closest<HTMLElement>("[data-tauri-drag-region]")!;
    expect(row).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(inDragRegion(pathOf(row))).toBe(true);
    expect(inDragRegion(pathOf(hide))).toBe(false);
    // The logo opts out (it's text to select), the rest of the row drags.
    expect(inDragRegion(pathOf(within(row).getByText("yaah")))).toBe(false);
    const bar = screen.getByLabelText("Title bar", { selector: "header" });
    expect(bar.closest("[inert]")).not.toBeNull();
  });
});

describe("the chat header", () => {
  it("drags the window; its badge and folder buttons stay buttons", async () => {
    const { user } = renderApp();
    await sendInQuickChat(user, "hello");
    const header = screen.getByRole("heading", { level: 1 }).closest("header")!;
    expect(header).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(inDragRegion(pathOf(header))).toBe(true);
    expect(inDragRegion(pathOf(screen.getByRole("heading", { level: 1 })))).toBe(true);
    for (const b of within(header).getAllByRole("button")) expect(inDragRegion(pathOf(b))).toBe(false);
  });
});

describe("the second try at a drag", () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => uninstall?.());

  const setup = () => {
    const start = vi.fn(() => Promise.resolve());
    uninstall = installDragFallback(start);
    render(
      <header data-tauri-drag-region="deep" aria-label="bar">
        <span>title</span>
        <button type="button">Show</button>
        <span data-tauri-drag-region="false">selectable</span>
      </header>,
    );
    return start;
  };

  it("asks again on the first move with the button down, once", () => {
    const start = setup();
    fireEvent.mouseDown(screen.getByText("title"), { button: 0, detail: 1 });
    expect(start).not.toHaveBeenCalled();
    fireEvent.mouseMove(document, { buttons: 1 });
    fireEvent.mouseMove(document, { buttons: 1 });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("leaves buttons, opted-out parts, other buttons, double clicks and released moves alone", () => {
    const start = setup();
    for (const [el, init] of [
      [screen.getByRole("button", { name: "Show" }), { button: 0, detail: 1 }],
      [screen.getByText("selectable"), { button: 0, detail: 1 }],
      [screen.getByText("title"), { button: 2, detail: 1 }],
      [screen.getByText("title"), { button: 0, detail: 2 }],
    ] as const) {
      fireEvent.mouseDown(el, init);
      fireEvent.mouseMove(document, { buttons: 1 });
    }
    fireEvent.mouseDown(screen.getByText("title"), { button: 0, detail: 1 });
    fireEvent.mouseUp(document);
    fireEvent.mouseMove(document, { buttons: 1 });
    fireEvent.mouseDown(screen.getByText("title"), { button: 0, detail: 1 });
    fireEvent.mouseMove(document, { buttons: 0 });
    expect(start).not.toHaveBeenCalled();
  });
});
