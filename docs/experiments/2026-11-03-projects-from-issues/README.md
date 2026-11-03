# Projects from issues: visual check (2026-11-03)

The "From an issue" mode of New project, the drafted prompt, the linked item on the project page and GitLab in
Settings → Integrations, checked with vitro against the browser mock (`pnpm dev`, http://localhost:1420) at 1440×900
and 760×820, light and dark. In the mock GitHub and Linear are connected and GitLab's token has been revoked, so its
issues answer with an auth error.

| File | What it shows |
|---|---|
| `01-picker-light.png` | ⌘K → "New project from an issue…": the queue across Linear, GitHub and Linear projects, the relation filter, GitLab's auth error with Reconnect, "open →" on the Linear project billing revamp already follows |
| `02-picker-pasted-url-light.png` | A pasted GitHub URL for an issue outside the queue, resolved into a row |
| `03-started-chat-drafted-light.png` | After Enter: the new project `#412 Crash on sign-in…` with its chat open and `Work on acme/mobile#412: …` drafted in the composer, not sent |
| `04-project-linear-project-light.png` | billing revamp: the "Linear project · Billing revamp" pill, the live `linear-project` component, "synced 3 h ago", Refresh and Unlink, and the brief's source block |
| `05-unlink-confirm-light.png` | Unlink's inline confirmation (Unlink / Keep) |
| `06-project-github-issue-dark.png` | The project started from the GitHub issue, dark: the pill, the live `github-issue` component, status set to planning, the matching local clone added as its folder |
| `07-picker-dark.png` | The picker in dark mode |
| `08-integrations-gitlab-dark.png` | Reconnect → Settings → Integrations on GitLab: optional instance URL, no OAuth app in this build so only the personal access token (`read_api`) |
| `09-project-narrow-light.png` | The project page at 760 px wide |
| `10-picker-narrow-light.png` | The picker at 760 px wide |
