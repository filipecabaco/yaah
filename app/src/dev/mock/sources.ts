// Live sources (sources.rs) and database connections. Sources replay samples
// recorded from the real readers, with a little movement so live views visibly
// update; Linear's are made up (no account is connected in the mock).
import type { ConnectionInfo } from "@/lib/api";
import { asArray, asNumber, asObj, asString, type Obj } from "@/lib/narrow";
import type { Mock, Replies } from "./context";
import { sourceSamples } from "./fixtures";

export function seedSources() {
  return {
    connections: [{ name: "shop", kind: "postgres", target: "127.0.0.1:54329/shop" }] as ConnectionInfo[],
    /** The system source's CPU, drifting between reads. */
    cpu: 22,
  };
}

/** `v` moved randomly by up to `spread / 2`, kept within [lo, hi], to one decimal. */
const wobble = (v: unknown, spread: number, lo = 0, hi = 100) =>
  Math.round(Math.min(hi, Math.max(lo, (asNumber(v) ?? 0) + (Math.random() - 0.5) * spread)) * 10) / 10;

const linearIssue = (id: string, title: string, state: string, stateType: string, priority: string, variant: string, assignee: string) => ({
  id,
  title,
  state,
  stateType,
  priority,
  priorityVariant: variant,
  assignee,
  url: "https://linear.app",
  estimate: 2,
  updatedAt: "2026-11-02T10:00:00Z",
});
const linearIssues = [
  linearIssue("ENG-150", "Show refund lines on invoices", "Todo", "unstarted", "Medium", "secondary", "Alan Turing"),
  linearIssue("ENG-151", "Refund webhook retries", "Todo", "unstarted", "Low", "outline", "Grace Hopper"),
  linearIssue("ENG-142", "Partial refunds return the whole order", "In Progress", "started", "Urgent", "destructive", "Grace Hopper"),
  linearIssue("ENG-139", "Proration for mid-cycle upgrades", "In Progress", "started", "High", "default", "Ada Lovelace"),
  linearIssue("ENG-137", "Currency rounding in totals", "In Review", "started", "High", "default", "Alan Turing"),
  linearIssue("ENG-131", "Store prices in cents", "Done", "completed", "Medium", "secondary", "Ada Lovelace"),
  linearIssue("ENG-129", "Refund endpoint", "Done", "completed", "High", "default", "Grace Hopper"),
];
const linearSamples: Obj = {
  "linear.issues": linearIssues,
  "linear.issue": {
    id: "ENG-142",
    title: "Partial refunds return the whole order",
    url: "https://linear.app",
    state: "In Progress",
    stateType: "started",
    priority: "Urgent",
    priorityVariant: "destructive",
    estimate: 3,
    due: "2026-11-06",
    assignee: "Grace Hopper",
    creator: "Ada Lovelace",
    team: "Engineering",
    teamKey: "ENG",
    cycle: "Cycle 18",
    project: "Billing revamp",
    labels: ["bug", "billing"],
    description:
      "Refunding one item refunds the **whole order**: `refund()` returns `order.total` and ignores the items.\n\n**Expected:** €14.99 back for one mug. **Got:** €49.99.",
    subIssues: [
      { id: "ENG-143", title: "Failing test for partial refunds", state: "Done", done: true },
      { id: "ENG-144", title: "Refund only the given items", state: "In Progress", done: false },
      { id: "ENG-145", title: "Show refunded lines on the invoice", state: "Todo", done: false },
    ],
    subDone: 1,
    subTotal: 3,
    links: [{ title: "PR #48 Handle partial refunds", url: "https://github.com" }],
    comments: [
      { author: "Grace Hopper", body: "Repro'd with the failing test in `test/refund.test.js`. Fix is up in #48.", at: "" },
      { author: "Ada Lovelace", body: "Customer-facing, bumping to urgent.", at: "" },
    ],
  },
  "linear.board": {
    team: "Engineering",
    teamKey: "ENG",
    cycle: "Cycle 18",
    columnCount: 4,
    columns: ["Todo", "In Progress", "In Review", "Done"].map((state) => {
      const issues = linearIssues.filter((i) => i.state === state);
      return { state, type: issues[0]?.stateType ?? "started", count: issues.length, issues };
    }),
  },
  "linear.cycle": {
    team: "Engineering",
    number: 18,
    name: "Cycle 18",
    starts: "Oct 27",
    ends: "Nov 7",
    daysLeft: 4,
    progressPct: 63,
    scope: 24,
    completed: 15,
    scopeAdded: 3,
    issues: 12,
    issuesDone: 6,
    history: ["Oct 27", "Oct 28", "Oct 29", "Oct 30", "Oct 31", "Nov 3", "Nov 4", "Nov 5"].map((day, i) => ({
      day,
      scope: [21, 21, 23, 23, 24, 24, 24, 24][i],
      completed: [0, 3, 5, 8, 11, 13, 15, null][i],
    })),
  },
};

export function sourceReplies({ state }: Mock): Replies {
  function read(source: Obj): unknown {
    const kind = asString(source.kind) ?? "";
    if (kind in linearSamples) return linearSamples[kind];
    if (kind === "system") {
      state.cpu = wobble(state.cpu, 14, 6, 85);
      const s = asObj(sourceSamples.system);
      return {
        ...s,
        cpu: state.cpu,
        cores: asArray(s.cores).map((c) => wobble(c, 20)),
        memPct: wobble(s.memPct, 2),
        load1: wobble(s.load1, 0.6, 0, 16),
        processes: asArray(s.processes).map((raw) => {
          const p = asObj(raw);
          const cpu = asNumber(p.cpu) ?? 0;
          return { ...p, cpu: wobble(cpu, Math.max(2, cpu / 4), 0, 400) };
        }),
      };
    }
    if (kind === "docker.stats")
      return asArray(sourceSamples["docker.stats"]).map((raw) => {
        const s = asObj(raw);
        return { ...s, cpu: wobble((asNumber(s.cpu) ?? 0) + 1, 3, 0, 400), memPct: wobble(s.memPct, 0.05) };
      });
    if (kind === "postgres.query") {
      const hit = asObj(sourceSamples["postgres.query"])[asString(source.sql) ?? ""];
      if (hit === undefined) throw new Error("browser mock: no recorded result for this query");
      return hit;
    }
    if (kind in sourceSamples) return sourceSamples[kind];
    throw new Error(`unknown source kind \`${kind}\``);
  }

  return {
    read_source: ({ source }: { source: unknown }) => read(asObj(source)),
    list_connections: (): ConnectionInfo[] => state.connections,
    add_connection: ({ name, url }: { name: string; url: string }): ConnectionInfo => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new Error("that isn't a postgres:// URL");
      }
      const info = { name, kind: "postgres", target: `${u.hostname}:${u.port || 5432}${u.pathname}` };
      state.connections = [...state.connections.filter((c) => c.name !== name), info];
      return info;
    },
    remove_connection: ({ name }: { name: string }) => {
      state.connections = state.connections.filter((c) => c.name !== name);
      return null;
    },
  };
}
