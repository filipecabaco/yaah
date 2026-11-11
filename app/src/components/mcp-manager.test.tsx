// `/mcp` (components/mcp-manager.tsx) on the browser mock: every saved server with its state, and what
// can be done about it (log in through the browser, log out, turn on or off).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { McpManager } from "@/components/mcp-manager";
import { installBrowserMock } from "@/dev/browser-mock";
import { mcpApi } from "@/lib/api";

async function open() {
  installBrowserMock({ delay: 0 });
  await mcpApi.save({
    original: null,
    name: "notion",
    transport: "http",
    commandLine: "",
    env: {},
    url: "https://mcp.notion.example/mcp",
    headers: {},
    enabled: true,
    agents: [],
  });
  const user = userEvent.setup();
  render(<McpManager open onClose={() => {}} />);
  const list = await screen.findByRole("list", { name: "MCP servers" });
  await waitFor(() => expect(list).toHaveAttribute("aria-busy", "false"));
  return { user, list };
}

const row = (list: HTMLElement, name: string) => within(list).getByRole("button", { name: new RegExp(name) });

describe("/mcp", () => {
  it("lists every server with how it is doing", async () => {
    const { list } = await open();
    expect(row(list, "filesystem")).toHaveTextContent("2 tools");
    expect(row(list, "sqlite")).toHaveTextContent("disabled");
    expect(row(list, "notion")).toHaveTextContent("needs authentication");
  });

  it("logs in to a server that needs it, then logs out again", async () => {
    const { user, list } = await open();
    await user.click(row(list, "notion"));
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(row(list, "notion")).toHaveTextContent("2 tools"), { timeout: 4000 });
    // The server stays open while it reconnects.
    expect(await screen.findByText(/logged in by yaah/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(row(list, "notion")).toHaveTextContent("needs authentication"));
  });

  it("turns a disabled server on", async () => {
    const { user, list } = await open();
    await user.click(row(list, "sqlite"));
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(row(list, "sqlite")).not.toHaveTextContent("disabled"));
  });

  it("starts with the keyboard on the list", async () => {
    const { list } = await open();
    await waitFor(() => expect(row(list, "filesystem")).toHaveFocus());
  });
});
