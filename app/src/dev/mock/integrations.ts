// Settings → Integrations (integrations.rs). GitHub and Linear start connected
// over OAuth; GitLab through a personal access token that has since been
// revoked, so its issues fail with an auth error until a new key is saved (see
// work-items.ts). The OAuth flows "finish" a few seconds after they start.
import type { IntegrationStart, IntegrationStatus } from "@/lib/api";
import { need, type Mock, type Replies } from "./context";

export function seedIntegrations() {
  const integrations: Record<string, IntegrationStatus> = {
    github: {
      id: "github",
      label: "GitHub",
      about:
        "Pull requests, checks, diffs and reviews (pr-view, pr-list), and issues (github-issue), read through GitHub's API with this connection.",
      flow: "device",
      connected: true,
      via: "oauth",
      account: "ghopper",
      needsReauth: false,
      keyEnv: "GITHUB_TOKEN",
      keyUrl: "https://github.com/settings/tokens",
    },
    linear: {
      id: "linear",
      label: "Linear",
      about: "Issues, projects, team boards and cycles (linear-issue, linear-project, linear-board, linear-cycle). Read-only.",
      flow: "browser",
      connected: true,
      via: "oauth",
      account: "grace@acme.dev",
      needsReauth: false,
      keyEnv: "LINEAR_API_KEY",
      keyUrl: "https://linear.app/settings/api",
    },
    gitlab: {
      id: "gitlab",
      label: "GitLab",
      about: "Issues (gitlab-issue) on gitlab.com or a self-managed instance, read through GitLab's API. Read-only.",
      // No OAuth app ships for GitLab: a personal access token is the only way.
      flow: "key",
      connected: true,
      via: "key",
      account: "grace",
      needsReauth: false,
      keyEnv: "GITLAB_TOKEN",
      keyUrl: "https://gitlab.com/-/user_settings/personal_access_tokens?name=yaah&scopes=read_api",
      baseUrl: "https://gitlab.com",
    },
  };
  return {
    integrations,
    /** GitLab's saved token was revoked: reads fail with 401 until a new key is saved. */
    gitlabRevoked: true,
  };
}

const ACCOUNTS: Record<string, string> = { github: "ghopper", linear: "grace@acme.dev", gitlab: "grace" };
const GITLAB_COM = "https://gitlab.com";

/** A GitLab instance's address as integrations.rs keeps it: https, no trailing slash; empty is gitlab.com. */
function gitlabBase(input: string | null | undefined): string {
  const raw = (input ?? "").trim().replace(/\/+$/, "");
  if (!raw) return GITLAB_COM;
  if (!/^https:\/\/[\w.-]+(:\d+)?(\/[\w.-]+)*$/.test(raw)) throw new Error(`\`${raw}\` isn't a GitLab address; use https://gitlab.example.com`);
  return raw;
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
    integration_connect: ({ service: id, baseUrl }: { service: string; baseUrl?: string | null }): IntegrationStart => {
      const s = service(id);
      if (s.flow === "key") throw new Error(`no ${s.label} app is set up to sign in with; use a personal access token`);
      const base = id === "gitlab" ? gitlabBase(baseUrl) : null;
      m.later(3000, () => {
        if (id === "gitlab") state.gitlabRevoked = false;
        void set(id, { connected: true, via: "oauth", account: ACCOUNTS[id], ...(base ? { baseUrl: base } : {}) });
      });
      return id === "github"
        ? { flow: "device", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900 }
        : { flow: "browser", authUrl: `${base ?? "https://linear.app"}/oauth/authorize?client_id=mock` };
    },
    integration_set_key: async ({ service: id, key, baseUrl }: { service: string; key: string; baseUrl?: string | null }) => {
      if (!key.trim()) throw new Error("paste a key first");
      if (id === "gitlab") state.gitlabRevoked = false;
      await set(id, { connected: true, via: "key", account: ACCOUNTS[id], ...(id === "gitlab" ? { baseUrl: gitlabBase(baseUrl) } : {}) });
      return { account: ACCOUNTS[id] };
    },
    integration_disconnect: async ({ service: id }: { service: string }) => {
      await set(id, { connected: false, via: "", account: null, ...(id === "gitlab" ? { baseUrl: GITLAB_COM } : {}) });
      return null;
    },
  };
}
