# How codrift starts work from a tracker item

3 November 2026. A read-only study of `../codrift`, used as the model for yaah's "projects from tracker items". File
references are to the codrift repo.

## Flow

- **Entry point:**
  - The only UI entry is the New Initiative overlay (`assets/src/lib/NewInitiative.svelte`).
  - Row 0 creates an empty initiative; below it, "Your work" lists your assigned and created items across connected
    services (`listAssignedItems`).
  - Fuzzy search runs over "service id title", and Tab cycles all, assigned and created.
  - Each row shows "start →", or "open →" when the item is already imported.
  - An `auth` error offers Reconnect.
  - There is **no** paste-a-URL input in the UI; only the CLI and MCP can import an arbitrary id.
- **Data:** a shared `Item` (id, title, description, url, labels, status, assignee). Comments, sub-issues and branch names are
  never fetched; `linked_prs` is always empty.
  - **Linear:** two `issues(...)` queries (assignee isMe, creator isMe; open states, first 50).
  - **GitHub:** `GET /issues?filter=assigned|created&state=open`, with pull requests dropped.
  - **GitLab:** `/issues?scope=...`.
  - **Linear Projects:** projects you lead, with their issues.
- **Import** (`Integration.do_import`):
  1. creates an initiative named after the item;
  2. links `{service, item_id, url}`;
  3. maps the status (done → done, cancelled → archived, backlog/todo → planning, else ongoing);
  4. writes `integration.json`;
  5. writes a `source` managed block (between markers) into `initiative.md`, above `## Goal`.
- **No branch or worktree** is created at import time. "Branch Git Directories" later uses `codrift/<slug(item_id)>`;
  Linear's own `branchName` is ignored.
- **The agent's brief:** there is no first prompt. `initiative.md` is symlinked as `CLAUDE.md` in the context directory, and the agent gets
  `--add-dir`.
- **Link back:**
  - A pill opens the item.
  - A manual "Sync Imported Context" rewrites only the source block.
  - Nothing is ever written to the tracker ("read-first").
- **Edge cases:**
  - An already-imported item returns the existing initiative.
  - Closed items are excluded from the queue.
  - Expired tokens refresh, or surface a Reconnect.
  - One failing service never hides the others.

## What yaah does differently

Decided with the user on 2026-11-03:
- Pasting a URL or id works.
- A GitHub or GitLab repo is matched to the local clone and added to the project.
- The brief includes recent comments.
- The project page shows the item live.
- A chat opens with the prompt drafted, not sent.
- **No branch** is created (the user's choice).
- Trackers: GitHub issues, Linear issues, Linear projects, GitLab issues.

Contract: `work_items` in `app/src-tauri/src/work_items.rs`.
