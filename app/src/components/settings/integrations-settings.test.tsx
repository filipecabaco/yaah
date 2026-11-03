// Settings → Integrations shows a credential the service refused as refused (not
// "Connected"), with why and a way to reconnect; a new key clears it.
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/app";
import { api } from "@/lib/api";

async function openIntegrations(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(await screen.findByRole("button", { name: /^Settings/ }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await user.click(within(dialog).getByRole("tab", { name: "Integrations" }));
  return dialog;
}

describe("a refused credential", () => {
  it("shows as refused with Rust's reason, and Reconnect leads to a new key", async () => {
    const { user } = renderApp();
    const dialog = await openIntegrations(user);
    const nav = await within(dialog).findByRole("navigation", { name: "Integrations" });
    const gitlab = within(nav).getByRole("button", { name: /GitLab/ });
    expect(gitlab).toHaveTextContent("credential refused");
    expect(within(nav).getByRole("button", { name: /GitHub/ })).toHaveTextContent("connected");

    await user.click(gitlab);
    expect(within(dialog).getByText("Credential refused")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Connected as/)).toBeNull();
    const alert = within(dialog).getByRole("alert");
    expect(alert).toHaveTextContent("GitLab refused the saved key");
    expect(alert).toHaveTextContent("GitLab refused the credential (HTTP 401): reconnect in Settings → Integrations.");

    // GitLab connects with a token: Reconnect puts the cursor in the token field.
    await user.click(within(alert).getByRole("button", { name: "Reconnect" }));
    const field = within(dialog).getByLabelText("Personal access token");
    expect(field).toHaveFocus();
    await user.type(field, "glpat-new{Enter}");
    expect(await within(dialog).findByText("Connected as grace")).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect((await api.integrationsStatus()).find((s) => s.id === "gitlab")).toMatchObject({ state: "connected", message: null });
  });
});
