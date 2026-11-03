# Integrations shortlist

3 November 2026. Research only. The question: which integrations are worth adding to yaah next, beyond GitHub, Linear,
GitLab (in progress), Postgres, Docker and the system?

What yaah already has:
- **Auth:** public-client OAuth (device flow, or PKCE on `127.0.0.1:43117`), with a personal-token fallback.
- **MCP servers:** remote servers get only static headers; there is no OAuth for them.

## Key finding

Several services have **no public OAuth client for their REST API**: Jira, Confluence, Notion, Asana, Supabase, Datadog,
Neon. A desktop app can't hold a client secret. Their **hosted MCP servers**, though, support dynamic client registration +
PKCE: confirmed for Notion and Datadog; secondary sources say the same for Atlassian Rovo. A generic MCP OAuth client in
yaah (DCR + PKCE on the existing loopback) would open several of them at once, as agent context and as sources read
through MCP tool calls.

## Ranked shortlist

| # | Integration | Use in yaah | Auth (public client?) | Effort |
|---|---|---|---|---|
| 1 | **Sentry issues** | Start a project from a crash; live issue (stack trace, count, last seen); latest event as agent context | Yes: device flow (RFC 8628), scopes `org:read project:read event:read`; tokens last 30 days and can be refreshed | S–M |
| 2 | **GitHub Actions runs/logs** (+ Projects v2) | Live runs and jobs from a PR; the failed job's log as agent context | The existing token (`repo` covers Actions); Projects v2 needs `read:project`, so every user re-consents | S |
| 3 | **GitLab MRs and pipelines** | MR view (the counterpart of pr-view); job logs | Yes: PKCE without a secret, device grant GA since 17.9; `read_api`. Tokens last about 2 hours and rotate on refresh | S–M |
| 4 | **Jira Cloud** | The biggest tracker yaah doesn't cover; issue and board views | **No:** 3LO needs a secret. v1 uses an API token; later, Rovo MCP. Descriptions and comments are ADF JSON and need a converter | M |
| 5 | **PagerDuty incidents** | Start an incident-response project; live timeline | Only Classic User OAuth allows a public client (PKCE, `read`). Check that refresh works without a secret | S–M |
| 6 | **Vercel deployments** | Deploy status next to PRs; build logs | Public client allowed, but per-resource permissions are in private beta, so a token for now. Every call needs `teamId` | S–M |
| 7 | **Notion pages** | Specs as agent context; start a project from a spec | **No** for REST (internal token; pages must be shared with it). Yes through hosted MCP (DCR + PKCE) | M |
| 8 | **Slack threads** | Start work from a bug thread; live thread | Public client possible (PKCE GA since 2026-03-30), but apps outside the Marketplace get 1 request/min on `conversations.replies` | L |

## Endpoints (key ones)

- **Sentry:**
  - My open issues: `GET /api/0/organizations/{org}/issues/?query=is:unresolved assigned:me`.
  - One issue: `GET /api/0/organizations/{org}/issues/{id}/`, plus `/events/latest/` for the stack trace.
  - Short ids resolve through `/shortids/{id}/`.
  - EU organisations use `de.sentry.io`.
- **GitHub Actions:**
  - Runs: `GET /repos/{o}/{r}/actions/runs?branch=&status=`.
  - Jobs: `.../runs/{id}/jobs`.
  - Logs: `.../jobs/{id}/logs` (a 302 to a short-lived URL). Cap the size, like diffs.
- **GitLab:**
  - My open MRs: `GET /merge_requests?scope=assigned_to_me&state=opened`.
  - One MR: `/projects/:id/merge_requests/:iid`.
  - Pipelines and job logs: `/projects/:id/pipelines/:pid/jobs`, `/jobs/:id/trace`.
- **Jira:**
  - Search: `GET /rest/api/3/search/jql?jql=assignee=currentUser() AND statusCategory!=Done` (the old `/search` is gone).
  - One issue: `/rest/api/3/issue/{key}`.
- **PagerDuty:**
  - My open incidents: `GET /incidents?statuses[]=triggered&statuses[]=acknowledged&user_ids[]={me}`.
  - One incident: `/incidents/{id}`, plus `/log_entries` and `/alerts`.
- **Vercel:**
  - List: `GET /v6/deployments?projectId=&target=`.
  - One deployment: `/v13/deployments/{idOrUrl}`.
  - Build log: `/v3/deployments/{id}/events`.
- **Notion:**
  - `GET /v1/pages/{id}`, `/v1/blocks/{id}/children` (recursive, 3 requests/second), `POST /v1/search`.
  - Every request needs the `Notion-Version` header.
- **Slack:**
  - `conversations.replies(channel, ts)`; a permalink `p1700000000123456` parses to `ts 1700000000.123456`.

## Rejected or deferred

- **Height:** shut down on 2025-09-24.
- **Asana:** needs a secret even with PKCE.
- **Shortcut:** token only, small audience.
- **Plane:** small, often self-hosted audience.
- **Azure DevOps:** OAuth is being retired.
- **incident.io:** API key only, list limited to 60/min.
- **Datadog:** OAuth is partner-only.
- **Confluence:** the same Atlassian auth problem as Jira.
- **Google Docs:** needs sensitive or restricted scopes and a security assessment.
- **Buildkite:** small audience.
- **CircleCI:** 90-day tokens with no refresh.
- **Netlify:** not verified.
- **Supabase and Neon:** better as feeders for Postgres connections than as new integrations.
- **PlanetScale:** not researched.

## Sources

- Sentry: https://docs.sentry.io/api/auth/ · https://docs.sentry.io/api/permissions/ · https://docs.sentry.io/api/events/list-an-organizations-issues/ · https://github.com/getsentry/cli/blob/main/DEVELOPMENT.md
- GitHub Actions: https://docs.github.com/en/rest/actions/workflow-runs · https://docs.github.com/en/rest/actions/workflow-jobs
- GitLab: https://docs.gitlab.com/api/oauth2/ · https://docs.gitlab.com/api/rest/authentication/
- Jira: https://developer.atlassian.com/cloud/jira/software/oauth-2-3lo-apps/ · https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/ · https://developer.atlassian.com/cloud/jira/platform/rate-limiting/ · https://developer.atlassian.com/cloud/rovo-mcp/
- PagerDuty: https://docs.pagerduty.com/developer/oauth-functionality · https://developer.pagerduty.com/docs/rest-api-rate-limits
- Vercel: https://vercel.com/docs/sign-in-with-vercel/scopes-and-permissions · https://vercel.com/docs/sign-in-with-vercel/authorization-server-api
- Notion: https://developers.notion.com/reference/request-limits
- Slack: https://docs.slack.dev/authentication/using-pkce/ · https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/

Some details (the Rovo MCP auth, Notion's MCP DCR, refresh behaviour for PagerDuty public clients) come from secondary
sources. Verify them before building on them.
