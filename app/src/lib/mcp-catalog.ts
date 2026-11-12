// Well-known MCP servers, one click from Settings → MCP servers. Each entry is a ready draft:
// - "oauth": a remote HTTP server (yaah logs in to HTTP servers only) that signs in through the browser. yaah saves it and runs the login
//   (mcp_oauth.rs), which needs the server's OAuth dynamic client registration; every URL here was
//   checked to answer 401 with resource metadata and to offer a registration endpoint.
// - "none": works as is (public docs servers, local commands).
// - "token": needs a key the user pastes in, so the form opens with the field ready.
import type { McpServerDraft } from "@/lib/api";

export type McpCatalogAuth = "oauth" | "none" | "token";

export type McpCatalogCategory =
  | "Payments"
  | "Cloud & hosting"
  | "Databases"
  | "Dev tools"
  | "Observability"
  | "Work & docs"
  | "Design"
  | "Content & media"
  | "Automation"
  | "Docs & search";

export type McpCatalogEntry = {
  /** Also the name it is saved under (kebab-case), unless that is taken. */
  id: string;
  label: string;
  description: string;
  category: McpCatalogCategory;
  auth: McpCatalogAuth;
  /** Where to read about it, or to get the key. */
  docs: string;
  draft: Pick<McpServerDraft, "transport"> & Partial<Pick<McpServerDraft, "url" | "commandLine" | "env" | "headers">>;
  /** token: what to paste, and where to get it. */
  token?: { field: string; hint: string };
};

const http = (url: string) => ({ transport: "http" as const, url });
const stdio = (commandLine: string) => ({ transport: "stdio" as const, commandLine });

export const MCP_CATALOG: McpCatalogEntry[] = [
  // Payments
  {
    id: "stripe",
    label: "Stripe",
    description: "Customers, payments, subscriptions and the Stripe docs.",
    category: "Payments",
    auth: "oauth",
    docs: "https://docs.stripe.com/mcp",
    draft: http("https://mcp.stripe.com"),
  },
  {
    id: "paypal",
    label: "PayPal",
    description: "Invoices, orders, disputes and transactions.",
    category: "Payments",
    auth: "oauth",
    docs: "https://developer.paypal.com/tools/mcp-server/",
    draft: http("https://mcp.paypal.com/mcp"),
  },
  {
    id: "square",
    label: "Square",
    description: "Payments, catalog, orders and customers.",
    category: "Payments",
    auth: "oauth",
    docs: "https://developer.squareup.com/docs/mcp",
    draft: http("https://mcp.squareup.com/mcp"),
  },

  // Cloud & hosting
  {
    id: "cloudflare-docs",
    label: "Cloudflare Docs",
    description: "Search Cloudflare's documentation. No sign-in.",
    category: "Cloud & hosting",
    auth: "none",
    docs: "https://github.com/cloudflare/mcp-server-cloudflare",
    draft: http("https://docs.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-bindings",
    label: "Cloudflare Workers",
    description: "Workers, KV, R2, D1 and Hyperdrive in your account.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://github.com/cloudflare/mcp-server-cloudflare",
    draft: http("https://bindings.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-observability",
    label: "Cloudflare Observability",
    description: "Workers logs and analytics.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://github.com/cloudflare/mcp-server-cloudflare",
    draft: http("https://observability.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-builds",
    label: "Cloudflare Builds",
    description: "Workers builds and their logs.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://github.com/cloudflare/mcp-server-cloudflare",
    draft: http("https://builds.mcp.cloudflare.com/mcp"),
  },
  {
    id: "vercel",
    label: "Vercel",
    description: "Projects, deployments, build logs and Vercel docs.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://vercel.com/docs/mcp/vercel-mcp",
    draft: http("https://mcp.vercel.com"),
  },
  {
    id: "netlify",
    label: "Netlify",
    description: "Create, deploy and manage Netlify sites.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
    draft: http("https://netlify-mcp.netlify.app/mcp"),
  },
  {
    id: "railway",
    label: "Railway",
    description: "Projects, services, deployments and variables.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://docs.railway.com/reference/mcp-server",
    draft: http("https://mcp.railway.com/mcp"),
  },
  {
    id: "render",
    label: "Render",
    description: "Services, deploys, logs, metrics and Postgres.",
    category: "Cloud & hosting",
    auth: "token",
    docs: "https://render.com/docs/mcp-server",
    draft: { ...http("https://mcp.render.com/mcp"), headers: { Authorization: "" } },
    token: { field: "Authorization", hint: "Enter “Bearer ” followed by an API key from Render’s Account Settings." },
  },

  // Databases
  {
    id: "supabase",
    label: "Supabase",
    description: "Projects, SQL, migrations, edge functions and logs.",
    category: "Databases",
    auth: "oauth",
    docs: "https://supabase.com/docs/guides/getting-started/mcp",
    draft: http("https://mcp.supabase.com/mcp"),
  },
  {
    id: "neon",
    label: "Neon",
    description: "Serverless Postgres: projects, branches and SQL.",
    category: "Databases",
    auth: "oauth",
    docs: "https://neon.com/docs/ai/neon-mcp-server",
    draft: http("https://mcp.neon.tech/mcp"),
  },
  {
    id: "prisma",
    label: "Prisma Postgres",
    description: "Create and manage Prisma Postgres databases.",
    category: "Databases",
    auth: "oauth",
    docs: "https://www.prisma.io/docs/postgres/integrations/mcp-server",
    draft: http("https://mcp.prisma.io/mcp"),
  },
  {
    id: "clickhouse",
    label: "ClickHouse Cloud",
    description: "Services, databases and read-only queries.",
    category: "Databases",
    auth: "oauth",
    docs: "https://clickhouse.com/docs/use-cases/AI/MCP",
    draft: http("https://mcp.clickhouse.cloud/mcp"),
  },

  // Dev tools
  {
    id: "github",
    label: "GitHub",
    description: "Repositories, issues, pull requests and Actions.",
    category: "Dev tools",
    auth: "token",
    docs: "https://github.com/github/github-mcp-server",
    draft: { ...http("https://api.githubcopilot.com/mcp/"), headers: { Authorization: "" } },
    token: { field: "Authorization", hint: "Enter “Bearer ” followed by a personal access token from github.com/settings/tokens." },
  },
  {
    id: "gitlab",
    label: "GitLab",
    description: "Projects, issues, merge requests and pipelines on gitlab.com.",
    category: "Dev tools",
    auth: "oauth",
    docs: "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/",
    draft: http("https://gitlab.com/api/v4/mcp"),
  },
  {
    id: "linear",
    label: "Linear",
    description: "Issues, projects, cycles and comments.",
    category: "Dev tools",
    auth: "oauth",
    docs: "https://linear.app/docs/mcp",
    draft: http("https://mcp.linear.app/mcp"),
  },
  {
    id: "semgrep",
    label: "Semgrep",
    description: "Scan code for security issues.",
    category: "Dev tools",
    auth: "oauth",
    docs: "https://semgrep.dev/docs/mcp",
    draft: http("https://mcp.semgrep.ai/mcp"),
  },
  {
    id: "jam",
    label: "Jam",
    description: "Bug reports with console logs, network requests and video.",
    category: "Dev tools",
    auth: "oauth",
    docs: "https://jam.dev/docs/debug-a-jam/mcp",
    draft: http("https://mcp.jam.dev/mcp"),
  },
  {
    id: "playwright",
    label: "Playwright",
    description: "Drive a local browser. Runs on this machine with npx.",
    category: "Dev tools",
    auth: "none",
    docs: "https://github.com/microsoft/playwright-mcp",
    draft: stdio("npx -y @playwright/mcp@latest"),
  },
  {
    id: "chrome-devtools",
    label: "Chrome DevTools",
    description: "Inspect and debug a local Chrome. Runs on this machine with npx.",
    category: "Dev tools",
    auth: "none",
    docs: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    draft: stdio("npx -y chrome-devtools-mcp@latest"),
  },

  // Observability
  {
    id: "sentry",
    label: "Sentry",
    description: "Errors, issues, traces and releases.",
    category: "Observability",
    auth: "oauth",
    docs: "https://docs.sentry.io/product/sentry-mcp/",
    draft: http("https://mcp.sentry.dev/mcp"),
  },
  {
    id: "datadog",
    label: "Datadog",
    description: "Logs, metrics, traces, monitors and incidents.",
    category: "Observability",
    auth: "oauth",
    docs: "https://docs.datadoghq.com/bits_ai/mcp_server/",
    draft: http("https://mcp.datadoghq.com/api/unstable/mcp-server/mcp"),
  },
  {
    id: "grafana",
    label: "Grafana",
    description: "Dashboards, data sources and alerts in Grafana Cloud.",
    category: "Observability",
    auth: "oauth",
    docs: "https://grafana.com/docs/grafana-cloud/",
    draft: http("https://mcp.grafana.com/mcp"),
  },
  {
    id: "honeycomb",
    label: "Honeycomb",
    description: "Query events, traces and SLOs.",
    category: "Observability",
    auth: "oauth",
    docs: "https://docs.honeycomb.io/integrations/mcp/",
    draft: http("https://mcp.honeycomb.io/mcp"),
  },
  {
    id: "posthog",
    label: "PostHog",
    description: "Product analytics, feature flags and experiments.",
    category: "Observability",
    auth: "oauth",
    docs: "https://posthog.com/docs/model-context-protocol",
    draft: http("https://mcp.posthog.com/mcp"),
  },

  // Work & docs
  {
    id: "notion",
    label: "Notion",
    description: "Search, read and write pages and databases.",
    category: "Work & docs",
    auth: "oauth",
    docs: "https://developers.notion.com/docs/mcp",
    draft: http("https://mcp.notion.com/mcp"),
  },
  {
    id: "atlassian",
    label: "Atlassian",
    description: "Jira issues and Confluence pages.",
    category: "Work & docs",
    auth: "oauth",
    docs: "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    draft: http("https://mcp.atlassian.com/v1/mcp"),
  },
  {
    id: "asana",
    label: "Asana",
    description: "Tasks, projects and goals.",
    category: "Work & docs",
    auth: "oauth",
    docs: "https://developers.asana.com/docs/using-asanas-mcp-server",
    draft: http("https://mcp.asana.com/v2/mcp"),
  },
  {
    id: "monday",
    label: "monday.com",
    description: "Boards, items and updates.",
    category: "Work & docs",
    auth: "oauth",
    docs: "https://developer.monday.com/apps/docs/mondaycom-mcp-integration",
    draft: http("https://mcp.monday.com/mcp"),
  },
  {
    id: "airtable",
    label: "Airtable",
    description: "Bases, tables and records.",
    category: "Work & docs",
    auth: "oauth",
    docs: "https://support.airtable.com/docs/using-the-airtable-mcp-server",
    draft: http("https://mcp.airtable.com/mcp"),
  },
  {
    id: "intercom",
    label: "Intercom",
    description: "Conversations and contacts.",
    category: "Work & docs",
    auth: "oauth",
    docs: "https://developers.intercom.com/docs/guides/mcp",
    draft: http("https://mcp.intercom.com/mcp"),
  },

  // Design
  {
    id: "figma",
    label: "Figma",
    description: "Read designs, components and variables.",
    category: "Design",
    auth: "oauth",
    docs: "https://help.figma.com/hc/en-us/articles/32132100833559",
    draft: http("https://mcp.figma.com/mcp"),
  },
  {
    id: "canva",
    label: "Canva",
    description: "Search, create and export designs.",
    category: "Design",
    auth: "oauth",
    docs: "https://www.canva.dev/docs/connect/canva-mcp-server-setup/",
    draft: http("https://mcp.canva.com/mcp"),
  },
  {
    id: "webflow",
    label: "Webflow",
    description: "Sites, CMS collections and pages.",
    category: "Design",
    auth: "oauth",
    docs: "https://developers.webflow.com/mcp/reference/overview",
    draft: http("https://mcp.webflow.com/mcp"),
  },

  // Docs & search
  {
    id: "context7",
    label: "Context7",
    description: "Up-to-date docs for libraries and frameworks. No sign-in.",
    category: "Docs & search",
    auth: "none",
    docs: "https://context7.com",
    draft: http("https://mcp.context7.com/mcp"),
  },
  {
    id: "deepwiki",
    label: "DeepWiki",
    description: "Ask questions about public GitHub repositories. No sign-in.",
    category: "Docs & search",
    auth: "none",
    docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
    draft: http("https://mcp.deepwiki.com/mcp"),
  },
  {
    id: "hugging-face",
    label: "Hugging Face",
    description: "Search models, datasets, Spaces and papers, and run Spaces with your account.",
    category: "Docs & search",
    auth: "oauth",
    docs: "https://huggingface.co/settings/mcp",
    draft: http("https://huggingface.co/mcp?login"),
  },
  {
    id: "exa",
    label: "Exa",
    description: "Web and code search. No sign-in.",
    category: "Docs & search",
    auth: "none",
    docs: "https://docs.exa.ai/reference/exa-mcp",
    draft: http("https://mcp.exa.ai/mcp"),
  },

  // Added after the second round of research: probed the same way.
  {
    id: "zapier",
    label: "Zapier",
    description: "Thousands of apps (Gmail, Sheets, Salesforce…) through one server.",
    category: "Automation",
    auth: "oauth",
    docs: "https://help.zapier.com/hc/en-us/articles/36265392843917",
    draft: http("https://mcp.zapier.com/api/v1/connect"),
  },
  {
    id: "pipedream",
    label: "Pipedream",
    description: "Thousands of APIs and workflows through one server.",
    category: "Automation",
    auth: "oauth",
    docs: "https://pipedream.com/docs/connect/mcp",
    draft: http("https://mcp.pipedream.net/v2"),
  },
  {
    id: "paddle",
    label: "Paddle",
    description: "Billing: prices, subscriptions, transactions and revenue.",
    category: "Payments",
    auth: "oauth",
    docs: "https://developer.paddle.com/build/tools/ai/mcp",
    draft: http("https://mcp.paddle.com/mcp"),
  },
  {
    id: "heroku",
    label: "Heroku",
    description: "Apps, dynos, add-ons and logs.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://devcenter.heroku.com/articles/heroku-mcp-server",
    draft: http("https://mcp.heroku.com/mcp"),
  },
  {
    id: "digitalocean",
    label: "DigitalOcean",
    description: "Droplets, App Platform, databases and more.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://docs.digitalocean.com/reference/mcp/",
    draft: http("https://mcp.digitalocean.com/mcp"),
  },
  {
    id: "buildkite",
    label: "Buildkite",
    description: "Pipelines, builds, jobs and their logs.",
    category: "Dev tools",
    auth: "oauth",
    docs: "https://buildkite.com/docs/apis/mcp-server",
    draft: http("https://mcp.buildkite.com/mcp"),
  },
  {
    id: "postman",
    label: "Postman",
    description: "Collections, environments and API specs.",
    category: "Dev tools",
    auth: "oauth",
    docs: "https://learning.postman.com/docs/developer/postman-api/postman-mcp-server/overview/",
    draft: http("https://mcp.postman.com/mcp"),
  },
  {
    id: "algolia",
    label: "Algolia",
    description: "Indices, search analytics and settings.",
    category: "Dev tools",
    auth: "oauth",
    docs: "https://www.algolia.com/doc/guides/model-context-protocol/productivity-mcp",
    draft: http("https://mcp.algolia.com/mcp"),
  },
  {
    id: "socket",
    label: "Socket",
    description: "Security scores for npm, PyPI and other packages. No sign-in.",
    category: "Dev tools",
    auth: "none",
    docs: "https://docs.socket.dev/docs/remote-socket-mcp",
    draft: http("https://mcp.socket.dev/"),
  },
  {
    id: "globalping",
    label: "Globalping",
    description: "Ping, traceroute and DNS from probes around the world.",
    category: "Dev tools",
    auth: "oauth",
    docs: "https://github.com/jsdelivr/globalping-mcp-server",
    draft: http("https://mcp.globalping.dev/mcp"),
  },
  {
    id: "tidewave",
    label: "Tidewave",
    description: "Your running Phoenix app: eval, logs, schemas and docs. Change the port if it isn't 4000 (Rails: 3000).",
    category: "Dev tools",
    auth: "none",
    docs: "https://hexdocs.pm/tidewave/",
    draft: http("http://localhost:4000/tidewave/mcp"),
  },
  {
    id: "xcode",
    label: "Xcode",
    description: "Build, test and preview through Xcode on this Mac.",
    category: "Dev tools",
    auth: "none",
    docs: "https://developer.apple.com/documentation/xcode/giving-agentic-coding-tools-access-to-xcode",
    draft: stdio("xcrun mcpbridge"),
  },
  {
    id: "incident-io",
    label: "incident.io",
    description: "Incidents, on-call schedules and follow-ups.",
    category: "Observability",
    auth: "oauth",
    docs: "https://docs.incident.io/mcp",
    draft: http("https://mcp.incident.io/mcp"),
  },
  {
    id: "new-relic",
    label: "New Relic",
    description: "APM, logs and NRQL queries.",
    category: "Observability",
    auth: "oauth",
    docs: "https://docs.newrelic.com/docs/agentic-ai/mcp/overview/",
    draft: http("https://mcp.newrelic.com/mcp/"),
  },
  {
    id: "axiom",
    label: "Axiom",
    description: "Datasets, schemas and APL queries.",
    category: "Observability",
    auth: "oauth",
    docs: "https://axiom.co/docs/console/intelligence/mcp-server",
    draft: http("https://mcp.axiom.co/mcp"),
  },
  {
    id: "amplitude",
    label: "Amplitude",
    description: "Product analytics: charts, cohorts and experiments. EU accounts use mcp.eu.amplitude.com.",
    category: "Observability",
    auth: "oauth",
    docs: "https://amplitude.com/docs/amplitude-ai/amplitude-mcp",
    draft: http("https://mcp.amplitude.com/mcp"),
  },
  {
    id: "mixpanel",
    label: "Mixpanel",
    description: "Product analytics: events, funnels and reports.",
    category: "Observability",
    auth: "oauth",
    docs: "https://docs.mixpanel.com/docs/mcp",
    draft: http("https://mcp.mixpanel.com/mcp"),
  },
  {
    id: "miro",
    label: "Miro",
    description: "Boards, diagrams and sticky notes.",
    category: "Work & docs",
    auth: "oauth",
    docs: "https://developers.miro.com/docs/miro-mcp",
    draft: http("https://mcp.miro.com/"),
  },
  {
    id: "clickup",
    label: "ClickUp",
    description: "Tasks, lists and docs.",
    category: "Work & docs",
    auth: "oauth",
    docs: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    draft: http("https://mcp.clickup.com/mcp"),
  },
  {
    id: "todoist",
    label: "Todoist",
    description: "Tasks and projects.",
    category: "Work & docs",
    auth: "oauth",
    docs: "https://www.todoist.com/help/articles/use-todoist-with-ai-assistants",
    draft: http("https://ai.todoist.net/mcp"),
  },
  {
    id: "cal-com",
    label: "Cal.com",
    description: "Event types, bookings and availability.",
    category: "Work & docs",
    auth: "oauth",
    docs: "https://cal.com/docs/mcp-server",
    draft: http("https://mcp.cal.com/mcp"),
  },
  {
    id: "contentful",
    label: "Contentful",
    description: "Content types, entries and assets. Needs the Contentful MCP app in the space.",
    category: "Content & media",
    auth: "oauth",
    docs: "https://www.contentful.com/developers/docs/mcp",
    draft: http("https://mcp.contentful.com/mcp"),
  },
  {
    id: "sanity",
    label: "Sanity",
    description: "Documents, schemas and GROQ queries.",
    category: "Content & media",
    auth: "oauth",
    docs: "https://www.sanity.io/docs/ai/mcp-server",
    draft: http("https://mcp.sanity.io"),
  },
  {
    id: "wix",
    label: "Wix",
    description: "Sites, stores and the Wix APIs.",
    category: "Content & media",
    auth: "oauth",
    docs: "https://dev.wix.com/docs/sdk/articles/use-the-wix-mcp/about-the-wix-mcp",
    draft: http("https://mcp.wix.com/mcp"),
  },
  {
    id: "mux",
    label: "Mux",
    description: "Video assets, live streams and playback data.",
    category: "Content & media",
    auth: "oauth",
    docs: "https://www.mux.com/docs/integrations/mcp-server",
    draft: http("https://mcp.mux.com"),
  },
  {
    id: "tavily",
    label: "Tavily",
    description: "Web search and extraction built for agents.",
    category: "Docs & search",
    auth: "oauth",
    docs: "https://docs.tavily.com/documentation/mcp",
    draft: http("https://mcp.tavily.com/mcp"),
  },
  {
    id: "apify",
    label: "Apify",
    description: "Run scrapers and actors from the Apify store.",
    category: "Docs & search",
    auth: "oauth",
    docs: "https://docs.apify.com/platform/integrations/mcp",
    draft: http("https://mcp.apify.com"),
  },
  {
    id: "microsoft-learn",
    label: "Microsoft Learn",
    description: "Official Microsoft and Azure docs and code samples. No sign-in.",
    category: "Docs & search",
    auth: "none",
    docs: "https://learn.microsoft.com/en-us/training/support/mcp",
    draft: http("https://learn.microsoft.com/api/mcp"),
  },
  {
    id: "aws-knowledge",
    label: "AWS Knowledge",
    description: "Official AWS docs, API references and regional availability. No sign-in.",
    category: "Docs & search",
    auth: "none",
    docs: "https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server",
    draft: http("https://knowledge-mcp.global.api.aws"),
  },

  // Third round: the rest of the registry's sign-in servers from well-known vendors.
  {
    id: "cloudflare-radar",
    label: "Cloudflare Radar",
    description: "Internet traffic, outages, attacks and domain rankings.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    draft: http("https://radar.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-containers",
    label: "Cloudflare Containers",
    description: "Spin up a sandboxed container to run code.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    draft: http("https://containers.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-browser",
    label: "Cloudflare Browser Rendering",
    description: "Fetch pages, take screenshots and turn pages into markdown.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    draft: http("https://browser.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-logs",
    label: "Cloudflare Logpush",
    description: "Logpush jobs and their health.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    draft: http("https://logs.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-ai-gateway",
    label: "Cloudflare AI Gateway",
    description: "Logs and analytics for prompts and responses.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    draft: http("https://ai-gateway.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-autorag",
    label: "Cloudflare AutoRAG",
    description: "Search your AutoRAG documents.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    draft: http("https://autorag.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-auditlogs",
    label: "Cloudflare Audit Logs",
    description: "Who changed what in your account.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    draft: http("https://auditlogs.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-dns-analytics",
    label: "Cloudflare DNS Analytics",
    description: "DNS performance and configuration.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    draft: http("https://dns-analytics.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-graphql",
    label: "Cloudflare GraphQL Analytics",
    description: "Query Cloudflare's analytics GraphQL API.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    draft: http("https://graphql.mcp.cloudflare.com/mcp"),
  },
  {
    id: "cloudflare-dex",
    label: "Cloudflare Digital Experience",
    description: "Zero Trust device and app performance tests.",
    category: "Cloud & hosting",
    auth: "oauth",
    docs: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    draft: http("https://dex.mcp.cloudflare.com/mcp"),
  },
  {
    id: "imagekit",
    label: "ImageKit",
    description: "Origins, URL endpoints and account usage.",
    category: "Content & media",
    auth: "oauth",
    docs: "https://imagekit.io/docs/build-with-ai",
    draft: http("https://imagekit.io/mcp/admin"),
  },
  {
    id: "imagekit-media",
    label: "ImageKit Media Library",
    description: "Search, upload, tag and share your media assets.",
    category: "Content & media",
    auth: "oauth",
    docs: "https://imagekit.io/docs/build-with-ai",
    draft: http("https://imagekit.io/mcp/dam"),
  },
  {
    id: "render-presentations",
    label: "render.ai",
    description: "Make, edit and export presentations from a brief.",
    category: "Design",
    auth: "oauth",
    docs: "https://render.ai/mcp",
    draft: http("https://api.render.ai/mcp"),
  },
];

export const MCP_CATALOG_CATEGORIES: McpCatalogCategory[] = [
  "Payments",
  "Cloud & hosting",
  "Databases",
  "Dev tools",
  "Observability",
  "Work & docs",
  "Design",
  "Content & media",
  "Automation",
  "Docs & search",
];

/** The entry as a new-server draft, saved as `name`. */
export function catalogDraft(entry: McpCatalogEntry, name: string = entry.id): McpServerDraft {
  return {
    original: null,
    name,
    transport: entry.draft.transport,
    commandLine: entry.draft.commandLine ?? "",
    env: { ...entry.draft.env },
    url: entry.draft.url ?? "",
    headers: { ...entry.draft.headers },
    enabled: true,
    agents: [],
  };
}

/** `base`, else `base-2`, `base-3`…: the first name not taken (mirrors mcp_servers.rs unique_name). */
export function freeName(base: string, taken: string[]): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (candidate !== "yaah-ui" && !taken.includes(candidate)) return candidate;
  }
}

const same = (a: string, b: string) => a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");

/** The saved server this entry already is, matched on its URL or command. */
export function addedAs<S extends { name: string; transport: string; url: string; commandLine: string }>(entry: McpCatalogEntry, servers: S[]) {
  return servers.find((s) =>
    entry.draft.transport === "stdio"
      ? s.transport === "stdio" && same(s.commandLine, entry.draft.commandLine ?? "")
      : s.transport !== "stdio" && same(s.url, entry.draft.url ?? ""),
  );
}
