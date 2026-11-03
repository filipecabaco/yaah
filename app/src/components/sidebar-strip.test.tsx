// The sidebar's top row and the hidden sidebar's title bar in macOS's app, where the
// traffic lights sit over the window's top-left corner (tauri.conf.json
// `trafficLightPosition`: 16, 28; three 12 px lights 8 px apart, centred 26 px down).
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isMac } from "@/lib/shortcuts";
import { renderApp } from "@/test/app";

vi.mock("@/hooks/use-titlebar", () => ({ overlayTitlebar: () => true, useTrafficLights: () => true }));

describe("with the traffic lights showing", () => {
  it("leaves them their corner, shown and hidden", async () => {
    renderApp();
    const sidebar = await screen.findByRole("complementary", { name: "Sidebar" });
    // Shown: the sidebar's first row starts after the lights; Hide stays at its right edge.
    const hide = within(sidebar).getByRole("button", { name: "Hide the sidebar" });
    expect(hide.parentElement).toHaveClass("pl-[68px]", "justify-between", "h-7");

    fireEvent.keyDown(window, { key: "b", code: "KeyB", metaKey: isMac, ctrlKey: !isMac });
    // Hidden: no strip at all. The main area's title bar takes the lights' row: 80 px of gutter,
    // then Show sidebar, the logo and Search, 52 px tall like the sidebar's first row (12 + 28 + 12),
    // so the lights are centred in it.
    const bar = await screen.findByRole("banner", { name: "Title bar" });
    expect(bar).toHaveClass("pl-[80px]", "h-[52px]", "items-center");
    const [show, logo, search] = [
      within(bar).getByRole("button", { name: "Show the sidebar" }),
      within(bar).getByRole("img", { name: "yaah" }),
      within(bar).getByRole("button", { name: /^Search/ }),
    ];
    expect(show.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(logo.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull());
  });
});
