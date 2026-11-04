// The composer's `#` references (references.rs): suggestions from the trackers
// the mock user has connected, ranked the way Rust ranks them (the chat's repos
// first, then the user's, then newest), and reading the tokens of a sent message.
// GitLab's saved token was revoked (see integrations.ts): it answers with an auth
// error until a new key is saved.
import type { Reference, ReferenceService, ReferenceSuggestions } from "@/lib/api";
import { fuzzyBest } from "@/lib/fuzzy";
import { need, type Mock, type Replies } from "./context";
import type { State } from "./state";

type Item = Reference & { yours?: boolean };

const item = (
  service: ReferenceService,
  kind: Reference["kind"],
  id: string,
  title: string,
  state: Reference["state"],
  rest: Partial<Item> = {},
): Item => {
  const sep = id.search(/[#!](?=\d+$)/);
  const scope = service === "linear" ? id.split("-")[0] : id.slice(0, sep);
  const n = id.slice(sep + 1);
  const url =
    service === "github"
      ? `https://github.com/${scope}/${kind === "pr" ? "pull" : "issues"}/${n}`
      : service === "gitlab"
        ? `https://gitlab.com/${scope}/-/${kind === "mr" ? "merge_requests" : "issues"}/${n}`
        : `https://linear.app/acme/issue/${id}`;
  return { service, kind, id, token: `${service}#${id}`, title, url, state, scope, updatedAt: "2026-11-01T00:00:00Z", ...rest };
};

/** What the trackers hold for the mock user (Grace: `ghopper` on GitHub, `grace` on GitLab). */
const ITEMS: Item[] = [
  item("github", "pr", "acme/api#231", "Retry webhooks once after a timeout", "open", { updatedAt: "2026-11-04T09:10:00Z", yours: true }),
  item("github", "pr", "acme/api#229", "Set the idempotency key before the handler runs", "draft", { updatedAt: "2026-11-03T17:20:00Z" }),
  item("github", "issue", "acme/api#212", "Webhook retries fire twice after a timeout", "open", { updatedAt: "2026-11-03T08:40:00Z", yours: true }),
  item("github", "pr", "acme/api#204", "Round invoice lines half to even", "merged", { updatedAt: "2026-10-30T12:00:00Z" }),
  item("github", "pr", "acme/web#97", "Invoice page: show totals after tax", "merged", { updatedAt: "2026-11-02T15:00:00Z", yours: true }),
  item("github", "issue", "acme/web#88", "Invoice page shows totals before tax", "open", { updatedAt: "2026-11-01T10:00:00Z" }),
  item("github", "issue", "acme/web#61", "Dark mode for the billing settings", "closed", {
    status: "Not planned",
    updatedAt: "2026-09-12T10:00:00Z",
  }),
  item("github", "pr", "acme/infra#41", "Rotate the staging certificates", "open", { updatedAt: "2026-10-29T10:00:00Z", yours: true }),
  item("github", "issue", "ghopper/dotfiles#3", "zsh prompt is slow in big repos", "open", { updatedAt: "2026-10-20T10:00:00Z", yours: true }),
  item("gitlab", "mr", "acme/platform/billing!58", "Export the ledger as CSV", "open", { updatedAt: "2026-11-02T10:00:00Z", yours: true }),
  item("gitlab", "issue", "acme/platform/billing#19", "Ledger export misses refunded lines", "open", {
    updatedAt: "2026-10-28T10:00:00Z",
    yours: true,
  }),
  item("linear", "issue", "ENG-142", "Partial refunds for multi-line invoices", "open", {
    status: "In Progress",
    updatedAt: "2026-11-03T12:00:00Z",
    yours: true,
  }),
  item("linear", "issue", "ENG-150", "Cents get lost when splitting payments", "open", {
    status: "In Review",
    updatedAt: "2026-11-02T12:00:00Z",
    yours: true,
  }),
  item("linear", "issue", "ENG-131", "Webhook signature check fails on retries", "done", { status: "Done", updatedAt: "2026-10-25T12:00:00Z" }),
  item("linear", "issue", "OPS-27", "Alert when webhook retries spike", "open", { status: "Todo", updatedAt: "2026-10-24T12:00:00Z" }),
];

const REVOKED = "GitLab refused the credential (HTTP 401): reconnect in Settings → Integrations";
const SERVICES: ReferenceService[] = ["github", "gitlab", "linear"];
const strip = ({ yours: _, ...r }: Item): Reference => r;

/** `owner/repo` of each of the chat's folders that is a clone (from the mock's repo list). */
function chatRepos(state: State, sessionId: string): string[] {
  const s = state.sessions[sessionId];
  if (!s) return [];
  const dirs = [s.cwd, ...s.additionalDirs];
  return state.repos.filter((r) => r.remote && dirs.includes(r.path)).map((r) => r.remote!.toLowerCase());
}

/** A tracker link as its item (references.rs `parse_link`). */
function fromLink(url: string): Item | undefined {
  const linear = /^https?:\/\/linear\.app\/[\w-]+\/issue\/([a-z]\w*-\d+)/i.exec(url)?.[1]?.toUpperCase();
  if (linear) return ITEMS.find((i) => i.id === linear);
  // A PR's page, its files or commits tab; GitHub also opens a PR at /issues/<n>.
  const bare = url
    .split(/[?#]/)[0]
    .replace(/\/(files|commits|diffs)?\/?$/, "")
    .replace("/issues/", "/pull/")
    .toLowerCase();
  return ITEMS.find((i) => i.url.toLowerCase().replace("/issues/", "/pull/") === bare);
}

export function referenceReplies(m: Mock): Replies {
  const { state } = m;
  const connected = (only: ReferenceService | null) => SERVICES.filter((s) => (only == null || s === only) && state.integrations[s]?.connected);
  return {
    reference_suggestions: async ({ sessionId, service, query }: { sessionId: string; service: ReferenceService | null; query: string }) => {
      need(state.sessions[sessionId], "unknown session");
      const on = connected(service);
      const out: ReferenceSuggestions = { items: [], connected: on, errors: [] };
      const q = query.trim();
      await m.wait(q ? 350 : 200);
      if (/^https?:\/\//i.test(q)) {
        const hit = fromLink(q);
        if (hit && on.includes(hit.service)) out.items.push(strip(hit));
        return out;
      }
      if (on.includes("gitlab") && state.gitlabRevoked) out.errors.push({ service: "gitlab", kind: "auth", message: REVOKED });
      const here = chatRepos(state, sessionId);
      const tier = (i: Item) => (here.includes(i.scope.toLowerCase()) ? 0 : i.yours ? 1 : 2);
      const n = /^[#!]?(\d+)$/.exec(q)?.[1];
      const exact = (i: Item) =>
        q !== "" &&
        (i.id.toLowerCase() === q.toLowerCase() ||
          i.token.toLowerCase() === q.toLowerCase() ||
          (n != null && i.id.endsWith(n) && /[#!-]$/.test(i.id.slice(0, -n.length))));
      out.items = ITEMS.filter((i) => on.includes(i.service) && !(i.service === "gitlab" && state.gitlabRevoked))
        .map((i) => ({ i, score: q ? fuzzyBest(q, [i.id, i.title, i.scope, i.token]) : 1 }))
        .filter((x) => x.score > 0 || exact(x.i))
        .sort(
          (a, b) =>
            Number(exact(b.i)) - Number(exact(a.i)) ||
            Number(a.score < 200) - Number(b.score < 200) ||
            tier(a.i) - tier(b.i) ||
            b.score - a.score ||
            (b.i.updatedAt ?? "").localeCompare(a.i.updatedAt ?? ""),
        )
        .slice(0, 30)
        .map((x) => strip(x.i));
      return out;
    },
  };
}

/** The user entry's `references`, when the text has any. */
export function referenceEntry(state: State, text: string): { references?: Reference[] } {
  const references = referencesIn(state, text);
  return references.length ? { references } : {};
}

/** Every reference token in a sent message, read as references.rs does (one it can't read carries why). */
export function referencesIn(state: State, text: string): Reference[] {
  const re = /(^|[\s([{<"'])(github|gitlab|linear)#([\w.-]+(?:\/[\w.-]+)+[#!]\d+|[a-z][\w]*-\d+)(?=$|[\s.,;:!?)\]}>"'])/gi;
  const seen = new Set<string>();
  const out: Reference[] = [];
  for (const m of text.matchAll(re)) {
    const service = m[2].toLowerCase() as ReferenceService;
    const id = service === "linear" ? m[3].toUpperCase() : m[3];
    const token = `${service}#${id}`;
    if (seen.has(token.toLowerCase())) continue;
    seen.add(token.toLowerCase());
    const hit = ITEMS.find((i) => i.token.toLowerCase() === token.toLowerCase());
    const label = { github: "GitHub", gitlab: "GitLab", linear: "Linear" }[service];
    const error = !state.integrations[service]?.connected
      ? `${label} isn't connected: connect it in Settings → Integrations`
      : service === "gitlab" && state.gitlabRevoked
        ? REVOKED
        : hit
          ? undefined
          : `${label}: not found`;
    if (hit && !error) out.push(strip(hit));
    else {
      const kind = service === "gitlab" ? (id.includes("!") ? "mr" : "issue") : service === "github" ? "pr" : "issue";
      out.push({ service, kind, id, token, title: "", url: "", state: "", scope: id.split(/[#!]|-(?=\d+$)/)[0], error });
    }
  }
  return out;
}
