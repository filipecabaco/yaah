// Settings → Integrations (integrations.rs). Both start disconnected; the
// OAuth flows "finish" a few seconds after they start.
import type { IntegrationStart, IntegrationStatus } from "@/lib/api";
import { need, type Mock, type Replies } from "./context";

export function seedIntegrations() {
  const integrations: Record<string, IntegrationStatus> = {
    github: {
      id: "github",
      label: "GitHub",
      about: "Pull requests, checks, diffs and reviews (pr-view, pr-list), read through GitHub's API with this connection.",
      flow: "device",
      connected: false,
      via: "",
      account: null,
      needsReauth: false,
      keyEnv: "GITHUB_TOKEN",
      keyUrl: "https://github.com/settings/tokens",
    },
    linear: {
      id: "linear",
      label: "Linear",
      about: "Issues, team boards and cycles (linear-issue, linear-issues, linear-board, linear-cycle). Read-only.",
      flow: "browser",
      connected: false,
      via: "",
      account: null,
      needsReauth: false,
      keyEnv: "LINEAR_API_KEY",
      keyUrl: "https://linear.app/settings/api",
    },
  };
  return { integrations };
}

export function integrationReplies(m: Mock): Replies {
  const { state } = m;
  const service = (id: string) => need(state.integrations[id], `unknown service \`${id}\``);
  const set = (id: string, change: Partial<IntegrationStatus>) => {
    Object.assign(service(id), change);
    return m.emit("integration-changed", { service: id, ok: true });
  };
  return {
    integrations_status: (): IntegrationStatus[] => Object.values(state.integrations),
    integration_connect: ({ service: id }: { service: string }): IntegrationStart => {
      service(id);
      m.later(3000, () => void set(id, { connected: true, via: "oauth", account: id === "linear" ? "dev@example.com" : "dev" }));
      return id === "github"
        ? { flow: "device", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 }
        : { flow: "browser", authUrl: "https://linear.app/oauth/authorize?client_id=mock" };
    },
    integration_set_key: async ({ service: id }: { service: string }) => {
      await set(id, { connected: true, via: "key", account: "dev@example.com" });
      return { account: "dev@example.com" };
    },
    integration_disconnect: async ({ service: id }: { service: string }) => {
      await set(id, { connected: false, via: "", account: null });
      return null;
    },
  };
}
