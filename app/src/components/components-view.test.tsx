// The Component library page against the real App and the browser mock:
// filtering by library, copying a component into the user's collection, and
// sharing some of the user's components as a library.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/app";
import { api } from "@/lib/api";

async function openLibrary(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(await screen.findByRole("button", { name: "Component library" }));
  return screen.findByRole("navigation", { name: "Components" });
}

describe("Component library", () => {
  it("filters by library and shows which library each component comes from", async () => {
    const { user } = renderApp();
    const nav = await openLibrary(user);
    const chips = screen.getByRole("group", { name: "Show library" });
    expect(
      within(chips)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["All", "yaah", "My components", "Platform kit"]);

    await user.click(within(chips).getByRole("button", { name: "Platform kit" }));
    expect(within(chips).getByRole("button", { name: "Platform kit" })).toHaveAttribute("aria-pressed", "true");
    expect(
      within(nav)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Platform kit"]);
    expect(within(nav).getByRole("button", { name: /platform\/host-health/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /^pr-list/ })).toBeNull();
    // The first of its components opens, labelled with its library.
    expect(await screen.findByRole("heading", { level: 2, name: "platform/host-health" })).toBeInTheDocument();
    expect(screen.getByText("from Platform kit · read-only")).toBeInTheDocument();

    await user.click(within(chips).getByRole("button", { name: "All" }));
    expect(
      within(nav)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Provided by yaah", "My components", "Platform kit"]);
  });

  it("copies a library component into the user's collection under a name they choose", async () => {
    const { user } = renderApp();
    const nav = await openLibrary(user);
    await user.click(within(nav).getByRole("button", { name: /platform\/host-health/ }));
    await screen.findByRole("heading", { level: 2, name: "platform/host-health" });

    await user.click(screen.getByRole("button", { name: "Copy to my collection" }));
    const name = screen.getByRole("textbox", { name: "Name in your collection" });
    // Its short name to start with, which is free.
    expect(name).toHaveValue("host-health");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Copied as host-health.");
    const copy = (await api.listComponents()).find((c) => c.name === "host-health");
    expect(copy).toMatchObject({ source: "local", changeNote: "Copied from platform/host-health." });

    // Copying again under the same name is refused, and says why.
    await user.click(screen.getByRole("button", { name: "Copy to my collection" }));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent('already have a component called "host-health"');
    await user.clear(screen.getByRole("textbox", { name: "Name in your collection" }));
    await user.type(screen.getByRole("textbox", { name: "Name in your collection" }), "host-health-2");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied as host-health-2."));

    // "Open it" goes to the copy, which has no copy action of its own.
    await user.click(screen.getByRole("button", { name: "Open it" }));
    expect(await screen.findByRole("heading", { level: 2, name: "host-health-2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy to my collection" })).toBeNull();
  });

  it("shares components as a library, adding the ones they use, and shows how to publish it", async () => {
    const { user } = renderApp();
    await openLibrary(user);
    await user.click(screen.getByRole("button", { name: "Share as library…" }));
    const dialog = await screen.findByRole("dialog", { name: "Share as library" });

    const exportButton = within(dialog).getByRole("button", { name: "Export" });
    expect(exportButton).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: /^ops-board/ }));
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "ops-kit");
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Ops kit");
    await user.type(within(dialog).getByRole("textbox", { name: "Description" }), "What's running and what's scheduled.");
    expect(within(dialog).getByRole("textbox", { name: "Version" })).toHaveValue("1.0.0");
    await user.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    expect(await within(dialog).findByText("~/Documents")).toBeInTheDocument();

    // ops-board is made of two other local components: nothing is written until they come too.
    await user.click(exportButton);
    const missing = await within(dialog).findByRole("alert");
    expect(missing).toHaveTextContent("They use components you didn't pick");
    expect(missing).toHaveTextContent("agent-status-panel, cron-schedule.");

    await user.click(within(missing).getByRole("button", { name: "Add them and export" }));
    const done = await within(dialog).findByRole("status");
    expect(done).toHaveTextContent("Exported 3 components to /Users/dev/Documents/ops-kit.");
    const commands = within(done).getByLabelText("Commands to publish");
    expect(commands.textContent).toContain("cd /Users/dev/Documents/ops-kit");
    expect(commands.textContent).toContain("git init");
    expect(commands.textContent).toContain("git commit -m 'Publish ops-kit 1.0.0'");
    expect(commands.textContent).toContain("git remote add origin <repo-url>");
    expect(done).toHaveTextContent("Others install it from Settings → Components");

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share as library" })).toBeNull());
  });
});
