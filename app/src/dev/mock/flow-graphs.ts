// The `flow` kinds, one card each: a CI pipeline as a sankey, and a service-dependency network.
// All numbers are made up. `flow-graphs.test.tsx` renders both; routed by "flow graphs" in chats.ts.
type Tree = Record<string, unknown>;
const card = (title: string, description: string, ...children: Tree[]): Tree => ({ type: "card", props: { title, description }, children });

const ci = card(
  "CI: where last week's runs went",
  "240 pushes through lint, unit tests, integration tests and build to deploy. Every run ends passed or failed.",
  {
    type: "flow",
    props: {
      kind: "sankey",
      title: "CI runs by stage, last 7 days",
      unit: " runs",
      height: 340,
      nodes: [
        { id: "push", label: "Pushes" },
        { id: "lint", label: "Lint" },
        { id: "unit", label: "Unit tests" },
        { id: "integ", label: "Integration" },
        { id: "build", label: "Build" },
        { id: "deploy", label: "Deploy (main)" },
        { id: "pass", label: "Passed", tone: "success" },
        { id: "fail", label: "Failed", tone: "danger" },
      ],
      links: [
        { source: "push", target: "lint", value: 240 },
        { source: "lint", target: "unit", value: 228 },
        { source: "lint", target: "fail", value: 12 },
        { source: "unit", target: "integ", value: 205 },
        { source: "unit", target: "fail", value: 23 },
        { source: "integ", target: "build", value: 190 },
        { source: "integ", target: "fail", value: 15 },
        { source: "build", target: "deploy", value: 120 },
        { source: "build", target: "pass", value: 66 },
        { source: "build", target: "fail", value: 4 },
        { source: "deploy", target: "pass", value: 117 },
        { source: "deploy", target: "fail", value: 3 },
      ],
    },
  },
);

// Services and who calls whom; value is requests per second at peak.
const SERVICES: [string, string, string, number][] = [
  ["cdn", "CDN", "edge", 6], ["web", "web", "edge", 5], ["mobile-gw", "mobile gateway", "edge", 3],
  ["api", "api", "core", 9], ["auth", "auth", "core", 4], ["billing", "billing", "core", 3], ["search", "search", "core", 4],
  ["notify", "notifications", "core", 2], ["jobs", "jobs", "core", 3], ["catalog", "catalog", "core", 3],
  ["postgres", "postgres", "data", 8], ["redis", "redis", "data", 5], ["kafka", "kafka", "data", 5],
  ["s3", "object store", "data", 3], ["opensearch", "opensearch", "data", 3],
]; // prettier-ignore
const CALLS: [string, string, number][] = [
  ["cdn", "web", 1200], ["web", "api", 900], ["mobile-gw", "api", 600], ["api", "auth", 700], ["api", "billing", 120],
  ["api", "search", 300], ["api", "catalog", 450], ["api", "postgres", 1500], ["api", "redis", 1100], ["auth", "postgres", 300],
  ["auth", "redis", 500], ["billing", "postgres", 140], ["billing", "kafka", 90], ["search", "opensearch", 320],
  ["catalog", "postgres", 260], ["catalog", "s3", 80], ["jobs", "kafka", 200], ["jobs", "postgres", 160], ["jobs", "s3", 60],
  ["notify", "kafka", 110], ["kafka", "notify", 110], ["mobile-gw", "auth", 150],
]; // prettier-ignore

const services = card("Service dependencies", "Who calls whom at peak, in requests per second. Grouped by tier.", {
  type: "flow",
  props: {
    kind: "network",
    title: "Service call graph",
    unit: " req/s",
    height: 400,
    nodes: SERVICES.map(([id, label, group, size]) => ({ id, label, group, size })),
    links: CALLS.map(([source, target, value]) => ({ source, target, value })),
  },
});

// A monorepo's package graph, big enough (180 nodes) that the layout runs in a worker. Seeded, so the same every run.
const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = rng(11);
const TIERS = ["app", "lib", "tooling"] as const;
const PACKAGES = Array.from({ length: 180 }, (_, i) => ({ id: `p${i}`, label: `${TIERS[i % 3]}-${Math.floor(i / 3)}`, group: TIERS[i % 3] }));
const IMPORTS = PACKAGES.slice(1).flatMap((p, i) => {
  const n = 1 + Math.floor(pick() * 2);
  return Array.from({ length: n }, () => ({ source: p.id, target: `p${Math.floor(pick() * (i + 1))}` })).filter(
    (l, k, all) => all.findIndex((m) => m.target === l.target) === k,
  );
});

const packages = card(
  "Package graph",
  "Which of the monorepo's 180 packages import which. The biggest hubs are labelled; the table lists every one.",
  {
    type: "flow",
    props: { kind: "network", title: "Package imports", height: 420, nodes: PACKAGES, links: IMPORTS },
  },
);

export const flowGraphs: [string, Tree][] = [
  ["CI: where last week's runs went", ci],
  ["Service dependencies", services],
  ["Package graph", packages],
];
