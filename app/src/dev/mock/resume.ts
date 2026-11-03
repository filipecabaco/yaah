// "Resume a session…" (session/resume.rs): each Claude profile's own sessions, started in
// its CLI, listed a page at a time from that profile's agent and brought in as chats with
// their history. Profiles of other agents can't list theirs.
import type { AgentSession, AgentSessions, Entry, SessionInfo } from "@/lib/api";
import { home, need, now, ws, type Mock, type Replies } from "./context";
import { slashCommands } from "./chats";

/** Sessions per `list_agent_sessions` page, as the agent pages them. */
const PAGE = 8;

/** A session as its CLI left it: what was asked, what the agent did, and the follow-up. */
type Outside = {
  id: string;
  title: string | null;
  cwd: string;
  minutesAgo: number;
  ask: string;
  file: string;
  answer: string;
  followUp: string;
  reply: string;
};

const s = (
  id: string,
  title: string | null,
  cwd: string,
  minutesAgo: number,
  ask: string,
  file: string,
  answer: string,
  followUp: string,
  reply: string,
): Outside => ({
  id,
  title,
  cwd,
  minutesAgo,
  ask,
  file,
  answer,
  followUp,
  reply,
});

/** By profile id: each profile has its own config dir, so its own sessions. */
const outside: Record<string, Outside[]> = {
  default: [
    s(
      "4f1c9a2e-7b1d-4c55-9f0e-2a6d1b3c8e01",
      "Fix invoice rounding for multi-currency totals",
      `${ws}/api`,
      18,
      "Totals on EUR invoices are off by a cent when there are more than 20 lines. Find out why and fix it.",
      "src/billing/invoice.ts",
      "The total sums rounded line amounts, so the rounding errors add up. I changed `invoiceTotal` to sum exact minor units and round once at the end.",
      "Add a regression test with 23 lines at €0.105.",
      "Added `invoice-rounding.test.ts`; it fails on the old code and passes now.",
    ),
    s(
      "9d3e5b71-0c2a-4e8f-8a41-77f2c6d0b9a2",
      "Billing page: plan cards overflow on narrow screens",
      `${ws}/web`,
      95,
      "The plan cards on /billing overflow below 380px. Make them stack.",
      "src/pages/billing/PlanCards.tsx",
      "The grid had a fixed `minmax(220px, 1fr)`. It's `repeat(auto-fit, minmax(min(100%, 220px), 1fr))` now, so cards stack on phones.",
      "And the price line wraps oddly.",
      "The price and the period are one `nowrap` span now; the period drops to its own line only when it must.",
    ),
    s(
      "c27a8f04-5e6b-4d13-b2c9-0e81f4a6d735",
      "Terraform: move the queue workers to the new VPC",
      `${ws}/infra`,
      60 * 5,
      "Plan the move of the queue workers to vpc-main without downtime.",
      "modules/workers/main.tf",
      "Two steps: bring up a second worker group in vpc-main draining from the same queue, then remove the old group once its in-flight jobs are done.",
      "Write the first step.",
      "Added `workers_v2` behind `var.enable_v2`; `terraform plan` shows 6 to add, 0 to change, 0 to destroy.",
    ),
    s(
      "e8b46d19-2f7c-4a90-9c3d-5a1e0b7f62c4",
      "Why is the webhook retry test flaky?",
      `${ws}/api`,
      60 * 26,
      "test/webhooks/retry.test.ts fails about one run in ten. Why?",
      "test/webhooks/retry.test.ts",
      "It waits a fixed 50 ms for the retry, but the backoff has jitter up to 80 ms. I made the test advance fake timers instead of sleeping.",
      "Any other tests with real sleeps?",
      "Three more in test/webhooks and one in test/jobs; all switched to fake timers.",
    ),
    s(
      "1a5f7c3b-8d2e-4b6a-a0f9-c4e3d2b1a098",
      null,
      `${ws}/docs`,
      60 * 30,
      "Proofread the pricing page for consistency with the new plan names.",
      "docs/pricing.md",
      'Four places still said "Pro" for what is now "Team". Fixed, and the comparison table\'s footnote now matches.',
      "And the FAQ?",
      "The FAQ was already right.",
    ),
    s(
      "7b2d9e60-4c1a-4f83-b5e7-90a6c3d8f214",
      "Migrate the sessions table to UUID keys",
      `${ws}/api-billing`,
      60 * 52,
      "Write a migration that moves sessions.id from bigint to uuid, online.",
      "src/db/migrations/0043_sessions_uuid.sql",
      "Added a `uuid` column with a default, backfilled in batches of 10k, then swapped the primary key in one short transaction.",
      "How long does the swap lock?",
      "Only the final `ALTER TABLE … ADD PRIMARY KEY USING INDEX`: about 40 ms on a copy of production.",
    ),
    s(
      "f0c3a7e2-9b5d-4e16-8c72-3d4b1a6e0f95",
      "Mobile: crash when the session expires mid-checkout",
      `${ws}/clients/mobile`,
      60 * 24 * 3,
      "The app crashes when the session expires during checkout. Logs attached.",
      "src/checkout/CheckoutScreen.tsx",
      "The 401 handler navigates away while the payment sheet is still mounted. It now closes the sheet first, then sends you to sign in with the cart kept.",
      "Does the cart survive a cold start too?",
      "Yes: it's persisted on every change, not only on background.",
    ),
    s(
      "3e9a1d5c-6f2b-4c87-9e04-b7a2c5d8f136",
      "Draft the Q4 reliability review",
      `${ws}/docs`,
      60 * 24 * 5,
      "Draft the Q4 reliability review from the incident notes.",
      "docs/reviews/q4-reliability.md",
      "A first draft with the four incidents, time to detect and to recover, and three actions ranked by how much downtime they'd have saved.",
      "Make the summary shorter.",
      "The summary is three sentences now.",
    ),
    s(
      "a6d0b4f8-1c3e-4a72-b9d5-e2f7c0a1b483",
      "Speed up the CI cache restore",
      `${ws}/infra`,
      60 * 24 * 9,
      "CI spends four minutes restoring caches. Can we cut that?",
      ".github/workflows/ci.yml",
      "The cache key includes the whole lockfile tree, so every branch misses. Keyed it on the lockfile hash plus the toolchain version: restores take 40 s now.",
      "And pnpm's store?",
      "Moved to its own cache entry; it hits on 95% of runs.",
    ),
    s(
      "5c8e2f1a-7d4b-4e09-a3c6-1b9d0e7f2a54",
      "Add idempotency keys to the refunds API",
      `${ws}/api`,
      60 * 24 * 14,
      "Refund requests can be retried by clients. Make them idempotent.",
      "src/api/refunds.ts",
      "POST /refunds takes an `Idempotency-Key` header; a repeat within 24 h returns the first response and creates nothing.",
      "Document it.",
      "Added to docs/api/refunds.md with an example.",
    ),
  ],
  work: [
    s(
      "b91f0e3d-2a7c-4d58-8e16-c0a4b7d2f963",
      "Quarterly access review: export the admin list",
      `${ws}/infra`,
      40,
      "Export everyone with admin on the production accounts, for the access review.",
      "scripts/access-review.exs",
      "Wrote an Elixir script that reads the IAM policies and prints admins per account as CSV: 14 people across 3 accounts.",
      "Flag anyone who hasn't signed in for 90 days.",
      "Two flagged; they're marked in the last column.",
    ),
    s(
      "2d6c8a4e-5f1b-4e3a-9b70-d8e2c1f0a5b7",
      "Incident 4412: postmortem timeline",
      `${ws}/docs`,
      60 * 20,
      "Build the timeline for incident 4412 from the pager log.",
      "docs/incidents/4412.md",
      "The timeline has 11 entries from first alert to all-clear; detection took 6 minutes, recovery 34.",
      "What would have caught it sooner?",
      "An alert on queue age, not just depth: it crossed 5 minutes 20 minutes before the first page.",
    ),
  ],
  personal: [
    s(
      "6e0a3c9f-4b2d-4f71-8a5e-b3d1c7f9e208",
      "Plan the garden irrigation timer",
      `${home}/projects/garden`,
      60 * 8,
      "Write the schedule logic for the irrigation timer: three zones, skip when it rained.",
      "src/schedule.ts",
      "Each zone has a start time and duration; a run is skipped when the last 24 h had more than 5 mm of rain.",
      "Stagger the zones so pressure holds.",
      "Zones now start 10 minutes apart.",
    ),
  ],
};

const sessionFor = (o: Outside, chats: Record<string, SessionInfo>): AgentSession => ({
  sessionId: o.id,
  title: o.title,
  cwd: o.cwd,
  updatedAt: now() - o.minutesAgo * 60,
  ...(chats[o.id] ? { alreadyInYaah: o.id } : {}),
});

/** What `session/load` replays, recorded as the chat's transcript. */
function history(o: Outside): Entry[] {
  const path = `${o.cwd}/${o.file}`;
  return [
    { type: "user", text: o.ask, attachments: [] },
    { type: "thought", text: `Reading ${o.file} first, then I'll check where it's used.`, messageId: null },
    {
      type: "tool",
      toolCallId: `${o.id}-read`,
      title: `Read ${o.file}`,
      kind: "read",
      status: "completed",
      content: [],
      locations: [{ path }],
      rawInput: { file_path: path },
    },
    { type: "agent", text: o.answer, messageId: null },
    {
      type: "plan",
      entries: [
        { content: "Find the cause", priority: "high", status: "completed" },
        { content: "Fix it", priority: "high", status: "completed" },
        { content: "Check nothing else depends on the old behaviour", priority: "medium", status: "completed" },
      ],
    },
    { type: "user", text: o.followUp, attachments: [] },
    { type: "agent", text: o.reply, messageId: null },
  ];
}

export function resumeReplies(m: Mock): Replies {
  const { state } = m;
  const profile = (id: string) =>
    need(
      state.profiles.find((p) => p.id === id),
      `unknown agent ${id}; add it again in Manage agents`,
    );
  const cantList = (id: string) => {
    const p = profile(id);
    if (p.preset !== "claude" && p.preset !== "codex") throw new Error(`${p.label} can't list its sessions.`);
    return p;
  };
  return {
    list_agent_sessions: async ({
      accountId,
      cwd,
      cursor,
    }: {
      accountId: string;
      cwd: string | null;
      cursor: string | null;
    }): Promise<AgentSessions> => {
      cantList(accountId);
      // Starting the agent and reading its session files takes a moment.
      await m.wait(cursor ? 300 : 700);
      const all = (outside[accountId] ?? []).filter((o) => !cwd || o.cwd === cwd);
      const offset = Number(cursor?.replace("offset:", "") ?? 0) || 0;
      const sessions = all.slice(offset, offset + PAGE).map((o) => sessionFor(o, state.sessions));
      return { sessions, nextCursor: offset + PAGE < all.length ? `offset:${offset + PAGE}` : null };
    },
    import_agent_session: async ({
      accountId,
      sessionId,
      cwd,
      title,
    }: {
      accountId: string;
      sessionId: string;
      cwd: string;
      title: string | null;
    }) => {
      const existing = state.sessions[sessionId];
      if (existing) return existing;
      const p = cantList(accountId);
      const o = need(
        (outside[accountId] ?? []).find((x) => x.id === sessionId),
        `${p.label} has no session ${sessionId}`,
      );
      // The agent replays the history.
      await m.wait(600);
      const project = state.projects.find((pr) => pr.dirs.some((d) => cwd === d || cwd.startsWith(`${d}/`)));
      const info: SessionInfo = {
        sessionId,
        projectId: project?.id ?? null,
        createdAt: now(),
        accountId,
        cwd,
        additionalDirs: project ? [...project.dirs.filter((d) => d !== cwd), project.contextDir] : [],
        title: (title ?? o.ask).replace(/\s+/g, " ").slice(0, 60),
        running: false,
        stopReason: null,
        commands: slashCommands,
        extraDirs: [],
      };
      state.sessions[sessionId] = info;
      state.transcripts[sessionId] = history(o);
      await m.emit("session-info", info);
      return info;
    },
  };
}
