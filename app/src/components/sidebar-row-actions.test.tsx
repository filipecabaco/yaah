// Rename and Delete buttons on sidebar rows, for the mouse: each opens what the row's
// right-click menu does (the palette's rename and delete pages for a chat; the project's
// rename and its delete confirmation for a project).
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/app";

const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });

describe("sidebar row buttons", () => {
  it("a chat row has Rename and Delete, which open the palette on that chat", async () => {
    const { user } = renderApp();
    await user.click(await screen.findByRole("button", { name: /^quick chat\b(?!s)/i }));
    await screen.findByRole("combobox", { name: "Message" });
    const s = sidebar();
    // The row itself still opens the chat by its title.
    expect(within(s).getByRole("button", { name: "New chat" })).toBeInTheDocument();

    await user.click(within(s).getByRole("button", { name: "Rename New chat" }));
    const rename = await screen.findByRole("dialog");
    expect(within(rename).getByRole("textbox")).toHaveValue("New chat");
    await user.keyboard("{Escape}");

    await user.click(within(s).getByRole("button", { name: "Delete New chat" }));
    const del = await screen.findByRole("dialog");
    expect(within(del).getByRole("option", { name: /Delete chat/ })).toBeInTheDocument();
    expect(within(del).getByRole("option", { name: /Keep it/ })).toBeInTheDocument();
  });

  it("a project row has Rename and Delete", async () => {
    const { user } = renderApp();
    const s = await screen.findByRole("complementary", { name: "Sidebar" });
    const rename = await within(s).findByRole("button", { name: "Rename billing revamp" });
    expect(within(s).getByRole("button", { name: "Delete billing revamp" })).toBeInTheDocument();
    await user.click(rename);
    // Rename opens the project with its name ready to edit.
    expect(await screen.findByDisplayValue("billing revamp")).toHaveFocus();
  });
});
