// Real tool calls, taken from the recorded agent sessions in
// app/src/dev/fixtures/ (live-pack, live-ask, live-scenarios). Long strings and
// lists are trimmed where marked with "…"; nothing else is changed.

export const testReport = {
  component: "test-report",
  props: {
    title: "Test run",
    command: "node --test --test-reporter=spec",
    text: "✔ totals an order (0.282292ms)\n✔ refunds a whole order (0.048458ms)\n✖ refunds part of an order (0.535875ms)\nℹ tests 3\nℹ pass 2\nℹ fail 1\n…",
  },
};

export const dbQuery = {
  component: "db-query",
  props: {
    connection: "shop",
    title: "Revenue by product category (price_cents ÷ 100)",
    sql: "select p.category, round(sum(o.quantity * p.price_cents) / 100.0, 2) as revenue, count(*) as orders\nfrom orders o\njoin products p on p.id = o.product_id\ngroup by p.category\norder by revenue desc",
    chart: { kind: "bar", x: "category", series: [{ key: "revenue", label: "Revenue" }] },
  },
};

export const ask = {
  title: "A few questions before I suggest a weekend project",
  tree: {
    type: "form",
    props: { submitLabel: "Get my recommendation" },
    children: [
      {
        type: "select",
        props: {
          name: "language",
          label: "Preferred language",
          default: "elixir",
          options: [{ label: "Elixir", value: "elixir" }, { label: "Rust", value: "rust" }, "…"],
        },
      },
      { type: "slider", props: { name: "hours", label: "Time available this weekend", min: 2, max: 24, step: 1, default: 8, unit: "h" } },
      {
        type: "choice",
        props: {
          name: "kind",
          label: "What kind of project?",
          multiple: true,
          options: [{ label: "CLI tool", value: "cli", description: "Something you run in the terminal" }, "…"],
        },
      },
      {
        type: "rank",
        props: {
          name: "priorities",
          label: "What matters most? (drag to order)",
          items: [{ label: "Learning something new", value: "learn" }, "…"],
        },
      },
      "…",
    ],
  },
};

export const bugForm = {
  id: "bug",
  title: "Bug report: partial refund",
  tree: {
    type: "form",
    props: {
      description: "I've drafted what the failing test shows; please check it, fill in the rest, then send.",
      submitLabel: "File bug",
    },
    children: [
      { type: "textfield", props: { name: "title", label: "Title", required: true } },
      { type: "textfield", props: { name: "steps", label: "Steps to reproduce", multiline: true, required: true } },
      {
        type: "select",
        props: {
          name: "severity",
          label: "Severity",
          required: true,
          options: [{ label: "Minor", value: "minor" }, { label: "Major", value: "major" }, "…"],
        },
      },
      "…",
    ],
  },
};

export const bugValues = {
  id: "bug",
  values: {
    title: "Partial refund returns the full order total instead of the refunded items' value",
    steps: "1. Run `node --test --test-reporter=spec`.\n2. Test \"refunds part of an order\" (test/refund.test.js:8) …",
    severity: "major",
    area: "billing / refunds (src/billing/refund.js)",
  },
};

export const saveMarkerMap = {
  name: "marker-map",
  description:
    "A titled card with an interactive map of labelled point markers (lat/lng, label, optional detail and tone). Use to place any set of locations (cities, offices, servers) on a map.",
  props: {
    type: "object",
    required: ["title", "markers"],
    properties: { title: { type: "string" }, markers: { type: "array" } },
  },
  tree: {
    type: "card",
    props: { title: "{{title}}", description: "{{description}}" },
    children: [{ type: "map", props: { markers: "{{markers}}", height: "{{height}}" } }],
  },
};

export const renderMarkerMap = {
  component: "marker-map",
  props: {
    title: "20 most populous urban areas",
    height: 420,
    markers: [
      { label: "Tokyo", detail: "37.2M", lat: 35.68, lng: 139.69 },
      { label: "Delhi", detail: "33.8M", lat: 28.61, lng: 77.21 },
      "…",
    ],
  },
};

export const systemMonitor = { component: "system-monitor", props: {} };
