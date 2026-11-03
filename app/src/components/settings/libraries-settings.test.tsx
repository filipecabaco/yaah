// Settings → Components against the real App and the browser mock (the Tauri
// IPC fake): what the user inspects, installs and removes is what Rust is asked.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/app";
import { libraryApi } from "@/lib/api";

const ACME = "https://github.com/acme-inc/yaah-components";
const PLATFORM = "https://github.com/northwind/yaah-platform";

async function openComponentsTab(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(await screen.findByRole("button", { name: /^settings/i }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("tab", { name: "Components" }));
  await within(dialog).findByRole("list", { name: "Libraries" });
  return dialog;
}

async function inspect(user: ReturnType<typeof renderApp>["user"], dialog: HTMLElement, url: string) {
  await user.type(within(dialog).getByRole("textbox", { name: "Git URL" }), url);
  await user.click(within(dialog).getByRole("button", { name: "Inspect" }));
}

describe("Settings → Components", () => {
  it("lists yaah's own and the user's first, then installed libraries with where they come from and what they read", async () => {
    const { user } = renderApp();
    const dialog = await openComponentsTab(user);
    const rows = within(within(dialog).getByRole("list", { name: "Libraries" })).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["yaah", "My components", "Platform kit"]);

    const platform = rows[2];
    expect(within(platform).getByText("v0.4.1")).toBeInTheDocument();
    expect(within(platform).getByText(/by Northwind platform team · 2 components/)).toBeInTheDocument();
    expect(within(platform).getByText("github.com/northwind/yaah-platform")).toBeInTheDocument();
    expect(within(platform).getByText(/@ main · 1a7e3f9/)).toBeInTheDocument();
    expect(within(platform).getByText("Docker")).toBeInTheDocument();
    expect(within(platform).getByText("System")).toBeInTheDocument();
    // Its library-level problems are folded away until asked for.
    expect(within(platform).queryByText(/symbolic link/)).toBeNull();
    await user.click(within(platform).getByRole("button", { name: /1 problem/ }));
    expect(within(platform).getByText(/symbolic link/)).toBeInTheDocument();
    // yaah's own and the user's can't be switched off or removed.
    expect(within(rows[0]).queryByRole("switch")).toBeNull();
    expect(within(rows[1]).queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("inspects a git URL, previews it with its invalid component flagged, and installs it", async () => {
    const { user } = renderApp();
    const dialog = await openComponentsTab(user);
    await inspect(user, dialog, ACME);

    const preview = await within(dialog).findByRole("region", { name: "Preview of Acme components" });
    expect(within(preview).getByText("by Acme Inc.")).toBeInTheDocument();
    expect(within(preview).getByText("v1.2.0")).toBeInTheDocument();
    expect(within(preview).getByText("GitHub")).toBeInTheDocument();
    expect(within(preview).getByText("3 components, 1 won't load")).toBeInTheDocument();
    expect(within(preview).getByText(/Won't load: tree: `sparkline` is not a primitive/)).toBeInTheDocument();
    expect(within(preview).queryByText(/Replaces the installed/)).toBeNull();
    // Nothing is installed by looking.
    expect((await libraryApi.list()).map((l) => l.id)).not.toContain("acme");

    await user.click(within(preview).getByRole("button", { name: "Install" }));
    expect(await within(dialog).findByText(/Installed Acme components: 2 components/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: /Preview of/ })).toBeNull();
    await within(within(dialog).getByRole("list", { name: "Libraries" })).findByRole("listitem", { name: "Acme components" });
    const acme = (await libraryApi.list()).find((l) => l.id === "acme");
    expect(acme).toMatchObject({ enabled: true, source: { kind: "git", url: ACME } });
  });

  it("says when a library replaces one already installed, and Cancel discards the preview", async () => {
    const { user } = renderApp();
    const dialog = await openComponentsTab(user);
    await inspect(user, dialog, PLATFORM);

    const preview = await within(dialog).findByRole("region", { name: "Preview of Platform kit" });
    expect(within(preview).getByText("Replaces the installed “Platform kit”")).toBeInTheDocument();
    expect(within(preview).getByRole("button", { name: "Install and replace" })).toBeEnabled();

    await user.click(within(preview).getByRole("button", { name: "Cancel" }));
    expect(within(dialog).queryByRole("region", { name: /Preview of/ })).toBeNull();
  });

  it("shows why a URL can't be read", async () => {
    const { user } = renderApp();
    const dialog = await openComponentsTab(user);
    await inspect(user, dialog, "https://github.com/someone/private-kit");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/repository not found.*connect GitHub/);
  });

  it("inspects a folder picked in the file dialog", async () => {
    const { user } = renderApp();
    const dialog = await openComponentsTab(user);
    await user.click(within(dialog).getByRole("button", { name: "Choose folder…" }));
    const preview = await within(dialog).findByRole("region", { name: "Preview of Acme components" });
    expect(within(preview).getByText("~/workspace/acme-components")).toBeInTheDocument();
  });

  it("turns a library off, and removes it only after an inline confirmation", async () => {
    const { user } = renderApp();
    const dialog = await openComponentsTab(user);
    const list = within(dialog).getByRole("list", { name: "Libraries" });
    const row = within(list).getByRole("listitem", { name: "Platform kit" });

    await user.click(within(row).getByRole("switch", { name: "Disable Platform kit" }));
    await waitFor(async () => expect((await libraryApi.list()).find((l) => l.id === "platform")?.enabled).toBe(false));
    expect(await within(row).findByRole("switch", { name: "Enable Platform kit" })).not.toBeChecked();

    await user.click(within(row).getByRole("button", { name: "Remove Platform kit" }));
    expect(within(row).getByText("Remove “Platform kit”?")).toBeInTheDocument();
    // Keep backs out without asking Rust for anything.
    await user.click(within(row).getByRole("button", { name: "Keep" }));
    expect((await libraryApi.list()).some((l) => l.id === "platform")).toBe(true);

    await user.click(within(row).getByRole("button", { name: "Remove Platform kit" }));
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(list).queryByRole("listitem", { name: "Platform kit" })).toBeNull());
    expect((await libraryApi.list()).some((l) => l.id === "platform")).toBe(false);
  });

  it("updates a git library and says what changed", async () => {
    const { user } = renderApp();
    const dialog = await openComponentsTab(user);
    const row = within(within(dialog).getByRole("list", { name: "Libraries" })).getByRole("listitem", { name: "Platform kit" });
    await user.click(within(row).getByRole("button", { name: "Update Platform kit" }));
    expect(await within(row).findByRole("status")).toHaveTextContent("Updated 1a7e3f9 → 9d2b7c4. 1 component changed: platform/containers.");
  });
});
