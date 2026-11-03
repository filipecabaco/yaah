// Projects from tracker items (work_items.rs): the queue across GitHub, Linear
// (issues and projects) and GitLab, resolving a pasted URL or id, starting a
// project from an item (a chat with the prompt drafted, never sent), refresh
// and unlink, and the live sources the project page shows the item with.
// GitLab's token was revoked (see integrations.ts): its issues answer with an
// auth error until a new key is saved.
import type { Project, ProjectLink, ProjectStatus, StartedProject, WorkItem, WorkQueue, WorkService } from "@/lib/api";
import { asNumber, asString, type Obj } from "@/lib/narrow";
import { openProjectChat } from "./chats";
import { now, type Mock, type Replies } from "./context";
import { addProject } from "./projects";
import type { State } from "./state";

type Comment = { author: string; body: string; at: string };
/** An item as its tracker holds it: what the queue lists, plus what its page shows. */
type Tracked = WorkItem & {
  /** In the user's own queue (assigned, created, lead or member), or only reachable by pasting it. */
  inQueue: boolean;
  author: string;
  description: string;
  comments: Comment[];
  createdAt: string;
  milestone?: string;
  /** Linear projects: lead, teams, progress and issues. */
  project?: {
    lead: string;
    teams: string[];
    progressPct: number;
    targetDate: string;
    issues: { id: string; title: string; state: string; assignee: string | null }[];
  };
};

const gh = (repo: string, n: number, rest: Omit<Tracked, "service" | "id" | "url" | "repo">): Tracked => ({
  service: "github",
  id: `${repo}#${n}`,
  url: `https://github.com/${repo}/issues/${n}`,
  repo,
  ...rest,
});
const gl = (project: string, iid: number, rest: Omit<Tracked, "service" | "id" | "url" | "repo">): Tracked => ({
  service: "gitlab",
  id: `${project}#${iid}`,
  url: `https://gitlab.com/${project}/-/issues/${iid}`,
  repo: project,
  ...rest,
});
const lin = (id: string, slug: string, rest: Omit<Tracked, "service" | "id" | "url">): Tracked => ({
  service: "linear",
  id,
  url: `https://linear.app/acme/issue/${id}/${slug}`,
  ...rest,
});

/** Everything the trackers hold for the mock user (Grace: `ghopper` on GitHub, `grace` on GitLab). */
const TRACKED: Tracked[] = [
  gh("acme/api", 212, {
    title: "Webhook retries fire twice after a timeout",
    status: "Open",
    assignee: "ghopper",
    labels: ["bug", "webhooks"],
    relation: "assigned",
    updatedAt: "2026-11-03T08:40:00Z",
    inQueue: true,
    author: "alan-t",
    createdAt: "2026-10-29T14:02:00Z",
    milestone: "November",
    description:
      "When Stripe's webhook times out at 10s we retry, but the first attempt still lands, so `invoice.paid` is handled twice and the customer gets two receipts.\n\n**Expected:** one receipt. **Got:** two, about 12s apart.",
    comments: [
      { author: "alan-t", body: "Seen 14 times in the last week, always on invoices with more than 40 lines.", at: "2026-10-30T09:12:00Z" },
      { author: "ghopper", body: "The idempotency key is set after the handler runs. Moving it before should do it.", at: "2026-11-02T16:30:00Z" },
    ],
  }),
  gh("acme/web", 88, {
    title: "Invoice page shows totals before tax",
    status: "Open",
    assignee: "ghopper",
    labels: ["bug", "billing"],
    relation: "assigned",
    updatedAt: "2026-11-02T17:05:00Z",
    inQueue: true,
    author: "ada-l",
    createdAt: "2026-10-31T11:20:00Z",
    description: "The total on `/invoices/:id` is the subtotal. Tax is added on the PDF but not on the page.",
    comments: [],
  }),
  gh("acme/infra", 31, {
    title: "Move staging database to Postgres 17",
    status: "Open",
    labels: ["infra"],
    relation: "created",
    updatedAt: "2026-10-28T10:00:00Z",
    inQueue: true,
    author: "ghopper",
    createdAt: "2026-10-20T10:00:00Z",
    description: "Staging is on 15. Production moves in December; staging should run 17 for a month first.",
    comments: [],
  }),
  gh("acme/mobile", 412, {
    title: "Crash on sign-in with SSO on Android 15",
    status: "Open",
    assignee: "kat-j",
    labels: ["crash", "android"],
    updatedAt: "2026-11-01T12:00:00Z",
    inQueue: false,
    author: "support-bot",
    createdAt: "2026-10-30T07:45:00Z",
    description: "`IllegalStateException` in `SsoCallbackActivity` when the browser returns after the app was killed.",
    comments: [{ author: "kat-j", body: "Repro'd on a Pixel 8 with \"Don't keep activities\" on.", at: "2026-10-31T10:00:00Z" }],
  }),
  lin("ENG-142", "partial-refunds-return-the-whole-order", {
    title: "Partial refunds return the whole order",
    status: "In Progress",
    assignee: "Grace Hopper",
    labels: ["bug", "billing"],
    relation: "assigned",
    updatedAt: "2026-11-03T09:10:00Z",
    inQueue: true,
    author: "Ada Lovelace",
    createdAt: "2026-10-27T09:00:00Z",
    description: "Refunding one item refunds the **whole order**: `refund()` returns `order.total` and ignores the items.",
    comments: [{ author: "Ada Lovelace", body: "Customer-facing, bumping to urgent.", at: "2026-10-30T15:00:00Z" }],
  }),
  lin("ENG-150", "show-refund-lines-on-invoices", {
    title: "Show refund lines on invoices",
    status: "Todo",
    assignee: "Grace Hopper",
    labels: ["billing"],
    relation: "assigned",
    updatedAt: "2026-11-01T13:00:00Z",
    inQueue: true,
    author: "Alan Turing",
    createdAt: "2026-10-31T13:00:00Z",
    description: "A refunded line shows as a negative line under the original, with the refund date.",
    comments: [],
  }),
  lin("ENG-137", "currency-rounding-in-totals", {
    title: "Currency rounding in totals",
    status: "In Review",
    assignee: "Alan Turing",
    labels: ["bug"],
    relation: "created",
    updatedAt: "2026-10-30T18:00:00Z",
    inQueue: true,
    author: "Grace Hopper",
    createdAt: "2026-10-24T10:00:00Z",
    description: "Totals in JPY show two decimals.",
    comments: [],
  }),
  {
    service: "linear-project",
    id: "8a1f2c3d4e5f",
    url: "https://linear.app/acme/project/billing-revamp-8a1f2c3d4e5f",
    title: "Billing revamp",
    status: "In Progress",
    assignee: "Grace Hopper",
    labels: [],
    relation: "lead",
    updatedAt: "2026-11-02T09:00:00Z",
    inQueue: true,
    author: "Grace Hopper",
    createdAt: "2026-09-15T09:00:00Z",
    description: "Move invoices, refunds and proration to the new pricing model before the January price change.",
    comments: [],
    project: {
      lead: "Grace Hopper",
      teams: ["Engineering", "Finance"],
      progressPct: 58,
      targetDate: "2026-12-19",
      issues: [
        { id: "ENG-131", title: "Store prices in cents", state: "Done", assignee: "Ada Lovelace" },
        { id: "ENG-139", title: "Proration for mid-cycle upgrades", state: "In Progress", assignee: "Ada Lovelace" },
        { id: "ENG-142", title: "Partial refunds return the whole order", state: "In Progress", assignee: "Grace Hopper" },
        { id: "ENG-150", title: "Show refund lines on invoices", state: "Todo", assignee: "Grace Hopper" },
      ],
    },
  },
  {
    service: "linear-project",
    id: "0c9e7b6a5d4f",
    url: "https://linear.app/acme/project/self-serve-refunds-0c9e7b6a5d4f",
    title: "Self-serve refunds",
    status: "Planned",
    labels: [],
    relation: "member",
    updatedAt: "2026-10-29T09:00:00Z",
    inQueue: true,
    author: "Ada Lovelace",
    createdAt: "2026-10-10T09:00:00Z",
    description: "Customers refund within 14 days from their account page, without a support ticket.",
    comments: [],
    project: {
      lead: "Ada Lovelace",
      teams: ["Engineering"],
      progressPct: 0,
      targetDate: "2027-02-27",
      issues: [{ id: "ENG-160", title: "Refund page in the account area", state: "Backlog", assignee: null }],
    },
  },
  gl("platform/payments-gateway", 19, {
    title: "Retry 3-D Secure challenges on timeout",
    status: "Open",
    assignee: "Grace Hopper",
    labels: ["payments"],
    relation: "assigned",
    updatedAt: "2026-11-02T11:00:00Z",
    inQueue: true,
    author: "Kat Johnson",
    createdAt: "2026-10-28T11:00:00Z",
    description: "A 3-D Secure challenge that times out fails the payment. The bank allows one retry.",
    comments: [{ author: "Kat Johnson", body: "About 0.4% of EU card payments hit this.", at: "2026-10-29T08:00:00Z" }],
  }),
  gl("platform/ledger", 7, {
    title: "Nightly ledger export misses late refunds",
    status: "Open",
    labels: ["bug", "ledger"],
    relation: "created",
    updatedAt: "2026-10-31T22:00:00Z",
    inQueue: true,
    author: "Grace Hopper",
    createdAt: "2026-10-31T22:00:00Z",
    description: "Refunds booked after 23:00 UTC are missing from that night's export and never show up in the next one.",
    comments: [],
  }),
];

const LABEL: Record<WorkService, string> = { github: "GitHub", linear: "Linear", "linear-project": "Linear project", gitlab: "GitLab" };
const SOURCE_LABEL: Record<WorkService, string> = {
  github: "GitHub issue",
  linear: "Linear issue",
  "linear-project": "Linear project",
  gitlab: "GitLab issue",
};
const INTEGRATION: Record<WorkService, string> = { github: "github", linear: "linear", "linear-project": "linear", gitlab: "gitlab" };
const REVOKED = "GitLab refused the credential (HTTP 401): reconnect in Settings → Integrations";

const START = "<!-- yaah:source:start -->";
const END = "<!-- yaah:source:end -->";

const same = (a: { service: WorkService; id: string }, service: WorkService, id: string) =>
  a.service === service && a.id.toLowerCase() === id.toLowerCase();

/** The brief's block for an item, as work_items.rs `brief_block` writes it. */
function briefBlock(t: Tracked): string {
  const heading = t.service === "linear-project" ? t.title : `${t.id} ${t.title}`;
  const facts = [t.status && `**Status:** ${t.status}`];
  if (t.project) facts.push(`**Progress:** ${t.project.progressPct}%`, `**Lead:** ${t.project.lead}`, `**Teams:** ${t.project.teams.join(", ")}`);
  else if (t.assignee) facts.push(`**Assignee:** ${t.assignee}`);
  if (t.labels.length) facts.push(`**Labels:** ${t.labels.join(", ")}`);
  let out = `# ${heading}\n\n**Source:** ${SOURCE_LABEL[t.service]}: ${t.url}\n${facts.filter(Boolean).join(" · ")}\n\n## Description\n\n${t.description || "_No description._"}\n`;
  if (t.project)
    out += `\n## Issues\n\n${t.project.issues.map((i) => `- ${i.id} ${i.title} (${i.state}, ${i.assignee ?? "unassigned"})`).join("\n")}\n`;
  else if (t.comments.length)
    out += `\n## Recent comments\n\n${t.comments.map((c) => `**${c.author}**, ${c.at.slice(0, 10)}: ${c.body}`).join("\n\n")}\n`;
  return `${START}\n${out}${END}\n`;
}

/** The brief with its block replaced (or added at the top), keeping the user's text around it. */
function withBlock(brief: string, block: string): string {
  const at = brief.indexOf(START);
  const end = brief.indexOf(END);
  if (at < 0 || end < 0) return `${block}\n${brief}`;
  return brief.slice(0, at) + block + brief.slice(end + END.length).replace(/^\n/, "");
}

function withoutBlock(brief: string): string {
  const at = brief.indexOf(START);
  const end = brief.indexOf(END);
  return at < 0 || end < 0 ? brief : (brief.slice(0, at) + brief.slice(end + END.length)).replace(/^\n+/, "");
}

/** A project's status from its item's (work_items.rs). */
function statusFor(status = ""): ProjectStatus {
  const s = status.toLowerCase();
  if (["done", "closed", "completed", "merged", "fixed"].includes(s)) return "done";
  if (["canceled", "cancelled", "archived", "wontfix"].includes(s)) return "archived";
  if (["backlog", "todo", "unstarted", "triage", "open", "planned"].includes(s)) return "planning";
  return "ongoing";
}

const projectName = (t: Tracked) =>
  (t.service === "linear" ? `${t.id} ${t.title}` : t.service === "linear-project" ? t.title : `#${t.id.split("#").pop()} ${t.title}`).slice(0, 80);
const draftFor = (t: Tracked) => (t.service === "linear-project" ? `Plan the work for ${t.title}` : `Work on ${t.id}: ${t.title}`);

/** The billing revamp project follows the Linear project it came from (synced three hours ago). */
export function linkSeededProjects(state: Pick<State, "projects" | "briefs">) {
  const p = state.projects.find((x) => x.id === "p1");
  const t = TRACKED.find((x) => x.service === "linear-project" && x.title === "Billing revamp");
  if (!p || !t) return;
  const at = now() - 3 * 3600;
  p.link = { service: t.service, id: t.id, url: t.url, title: t.title, linkedAt: at - 86400 * 9, syncedAt: at };
  state.briefs[p.id] = withBlock(state.briefs[p.id] ?? "", briefBlock(t));
}

export function workItemReplies(m: Mock): Replies {
  const { state } = m;

  /** Why a service can't be read right now, if it can't. */
  function unreachable(service: WorkService): string | null {
    const integration = state.integrations[INTEGRATION[service]];
    if (!integration?.connected) return `${LABEL[service]} isn't connected: connect it in Settings → Integrations`;
    if (service === "gitlab" && state.gitlabRevoked) return REVOKED;
    return null;
  }

  /** The item as the queue and resolve return it, tagged with the project that follows it. */
  const asItem = ({
    inQueue: _q,
    author: _a,
    description: _d,
    comments: _c,
    createdAt: _t,
    milestone: _m,
    project: _p,
    ...item
  }: Tracked): WorkItem => {
    const linked = state.projects.find((p) => p.link && same(p.link, item.service, item.id));
    return linked ? { ...item, projectId: linked.id } : item;
  };

  function find(service: WorkService, id: string): Tracked {
    const why = unreachable(service);
    if (why) throw new Error(why);
    const t = TRACKED.find((x) => same(x, service, id));
    if (!t) throw new Error(`${LABEL[service]}: ${id} not found`);
    return t;
  }

  /** What a pasted URL or id names (work_items.rs `parse`). */
  function parse(input: string): { service: WorkService; id: string } | null {
    const t = input.trim();
    // owner/repo#12 is GitHub unless only GitLab is connected; three or more path parts are GitLab.
    const bareRef = (path: string): WorkService =>
      path.split("/").length > 2 || (!state.integrations.github?.connected && !!state.integrations.gitlab?.connected) ? "gitlab" : "github";
    const rules: [RegExp, (m: RegExpMatchArray) => { service: WorkService; id: string }][] = [
      [/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/i, (m) => ({ service: "github", id: `${m[1]}#${m[2]}` })],
      [/^https?:\/\/[^/]+\/(.+?)\/-\/issues\/(\d+)/i, (m) => ({ service: "gitlab", id: `${m[1]}#${m[2]}` })],
      [/^https?:\/\/linear\.app\/[^/]+\/issue\/([a-z][a-z0-9]*-\d+)/i, (m) => ({ service: "linear", id: m[1].toUpperCase() })],
      [/^https?:\/\/linear\.app\/[^/]+\/project\/[\w-]*?([0-9a-f]{12})\/?$/i, (m) => ({ service: "linear-project", id: m[1] })],
      [/^[a-z][a-z0-9]*-\d+$/i, (m) => ({ service: "linear", id: m[0].toUpperCase() })],
      [/^([\w.-]+(?:\/[\w.-]+)+)#(\d+)$/, (m) => ({ service: bareRef(m[1]), id: m[0] })],
    ];
    for (const [re, f] of rules) {
      const hit = t.match(re);
      if (hit) return f(hit);
    }
    return null;
  }

  const changed = (projectId: string) => m.emit("projects-changed", { projectId });
  const project = (id: string): Project & { link: ProjectLink } => {
    const p = state.projects.find((x) => x.id === id);
    if (!p) throw new Error(`no project ${id}`);
    if (!p.link) throw new Error(`“${p.name}” doesn't follow an issue`);
    return p as Project & { link: ProjectLink };
  };

  return {
    work_queue: async (): Promise<WorkQueue> => {
      await m.wait(500);
      const services: WorkService[] = ["github", "linear", "linear-project", "gitlab"];
      const errors: WorkQueue["errors"] = [];
      const open = services.filter((s) => {
        if (!state.integrations[INTEGRATION[s]]?.connected) return false;
        const why = unreachable(s);
        if (why) errors.push({ service: s, kind: "auth", message: why });
        return !why;
      });
      const items = TRACKED.filter((t) => t.inQueue && open.includes(t.service))
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .map(asItem);
      return { items, errors };
    },

    resolve_work_item: async ({ input }: { input: string }): Promise<WorkItem> => {
      await m.wait(300);
      const ref = parse(input);
      if (!ref)
        throw new Error(
          `\`${input.trim()}\`: expected a GitHub or GitLab issue URL or \`owner/repo#12\`, a Linear issue (\`ENG-142\` or its URL) or a Linear project URL`,
        );
      return asItem(find(ref.service, ref.id));
    },

    start_project_from_item: async ({
      service,
      id,
      accountId,
    }: {
      service: WorkService;
      id: string;
      accountId?: string | null;
    }): Promise<StartedProject> => {
      await m.wait(700);
      const t = find(service, id);
      const existing = state.projects.find((p) => p.link && same(p.link, service, t.id));
      if (existing) return { project: existing, existing: true, addedRepos: [] };

      const addedRepos = t.repo ? state.repos.filter((r) => r.remote === t.repo).map((r) => r.path) : [];
      // The project keeps the agent its first chat starts with (work_items.rs `start`).
      const account = accountId || state.defaultAgent || state.profiles[0]?.id;
      const p = addProject(m, projectName(t), addedRepos, { agentId: account });
      const at = now();
      p.status = statusFor(t.status);
      p.link = { service, id: t.id, url: t.url, title: t.title, linkedAt: at, syncedAt: at };
      state.briefs[p.id] = briefBlock(t);
      void changed(p.id);

      if (!account)
        return {
          project: p,
          existing: false,
          addedRepos,
          chatError: "no agent is set up: add one in Settings → Agents, then start a chat in the project",
        };
      const chat = openProjectChat(m, p, account);
      void m.emit("session-info", chat);
      return { project: p, existing: false, chatId: chat.sessionId, draft: draftFor(t), addedRepos };
    },

    refresh_project_link: async ({ projectId }: { projectId: string }): Promise<Project> => {
      await m.wait(600);
      const p = project(projectId);
      const t = find(p.link.service, p.link.id);
      p.link = { ...p.link, title: t.title, syncedAt: now() };
      state.briefs[p.id] = withBlock(state.briefs[p.id] ?? "", briefBlock(t));
      void changed(p.id);
      return p;
    },

    unlink_project: ({ projectId }: { projectId: string }): Project => {
      const p = project(projectId);
      delete (p as Project).link;
      state.briefs[p.id] = withoutBlock(state.briefs[p.id] ?? "");
      void changed(p.id);
      return p;
    },
  };
}

// ── live sources (work_items.rs `source`) ──────────────────────────────────

const githubIssue = (t: Tracked) => {
  const [repo, n] = t.id.split("#");
  return {
    repo,
    number: Number(n),
    ref: t.id,
    title: t.title,
    url: t.url,
    body: t.description,
    state: "open",
    stateLabel: t.status ?? "Open",
    author: t.author,
    assignee: t.assignee ?? null,
    assignees: t.assignee ? [t.assignee] : [],
    labels: t.labels,
    milestone: t.milestone ?? null,
    commentCount: t.comments.length,
    comments: t.comments,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    closedAt: null,
    isPullRequest: false,
  };
};

const gitlabIssue = (t: Tracked) => {
  const [project, iid] = t.id.split("#");
  return {
    project,
    iid: Number(iid),
    ref: t.id,
    title: t.title,
    url: t.url,
    description: t.description,
    state: "opened",
    stateLabel: t.status ?? "Open",
    author: t.author,
    assignee: t.assignee ?? null,
    assignees: t.assignee ? [t.assignee] : [],
    labels: t.labels,
    milestone: t.milestone ?? null,
    dueDate: null,
    commentCount: t.comments.length,
    comments: t.comments,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    closedAt: null,
  };
};

const linearProject = (t: Tracked) => {
  const p = t.project ?? { lead: "", teams: [], progressPct: 0, targetDate: "", issues: [] };
  const issues = p.issues.map((i) => ({ ...i, stateType: i.state === "Done" ? "completed" : "started", done: i.state === "Done" }));
  return {
    id: t.id,
    uuid: `9d2c-${t.id}`,
    name: t.title,
    url: t.url,
    description: t.description,
    summary: t.description,
    state: t.status,
    stateType: "started",
    progressPct: p.progressPct,
    lead: p.lead,
    teams: p.teams,
    startDate: t.createdAt.slice(0, 10),
    targetDate: p.targetDate,
    updatedAt: t.updatedAt,
    issueCount: issues.length,
    issuesDone: issues.filter((i) => i.done).length,
    issues,
  };
};

/** `github.issue`, `github.issues`, `gitlab.issue`, `gitlab.issues` and `linear.project`; undefined for any other kind. */
export function workItemSource(state: State, kind: string, source: Obj): unknown {
  const lookup = (service: WorkService, id: string) => {
    if (service === "gitlab" && state.gitlabRevoked) throw new Error(REVOKED);
    const t = TRACKED.find((x) => same(x, service, id));
    if (!t) throw new Error(`${LABEL[service]}: ${id} not found`);
    return t;
  };
  switch (kind) {
    case "github.issue":
      return githubIssue(lookup("github", `${asString(source.repo)}#${asNumber(source.number) ?? asString(source.number)}`));
    case "gitlab.issue":
      return gitlabIssue(lookup("gitlab", `${asString(source.project)}#${asNumber(source.iid) ?? asString(source.iid)}`));
    case "linear.project":
      return linearProject(lookup("linear-project", asString(source.id) ?? ""));
    case "github.issues":
      return TRACKED.filter((t) => t.service === "github" && t.repo === asString(source.repo)).map(githubIssue);
    case "gitlab.issues":
      if (state.gitlabRevoked) throw new Error(REVOKED);
      return TRACKED.filter((t) => t.service === "gitlab").map(gitlabIssue);
    default:
      return undefined;
  }
}
