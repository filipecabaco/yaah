# Projects from tracker items: shared contract (Rust ↔ frontend)

## The feature
Start a yaah project from a GitHub issue, a Linear issue, a Linear project or a GitLab issue. The project
remembers its item, its brief carries the item, and a chat opens with a prompt drafted (not sent).
Read-only: yaah never writes to the tracker. No git branches are created.

Modelled on codrift's import (see the codrift summary below), with these differences:
- the user can also paste a URL or id, not only pick from their own queue;
- a GitHub or GitLab issue's repo is matched to a local clone (repos.rs already lists local repos with
  their origin) and added to the project's folders automatically when one matches;
- the brief block includes the latest comments (up to 10, newest last, each trimmed to 2000 characters);
- the project page shows the item live.

## Services
- `github` (issues): the existing GitHub connection. Queue: `GET /issues?filter=assigned|created&state=open&sort=updated&per_page=50`,
  minus pull requests, merged and deduped (assigned wins). Item: `GET /repos/{o}/{r}/issues/{n}` and its comments.
  Id `owner/repo#n`; URLs `https://github.com/o/r/issues/n`.
- `linear` (issues): the existing Linear connection. Queue: open (`state.type nin [completed, canceled]`) issues assigned to or
  created by me, first 50, by updatedAt. Item: `issue(id)`, by identifier (`ENG-142`) or UUID, with comments. URLs
  `https://linear.app/<ws>/issue/ENG-142/...`.
- `linear-project`: the Linear connection. Queue: projects where I'm lead or a member, not completed or canceled.
  Item: `project(id)` with name, description, url, state, progress, teams and its issues (identifier, title, state, assignee).
  URLs `https://linear.app/<ws>/project/<slug-id>`.
- `gitlab` (issues): a NEW integration in Settings → Integrations, through the same machinery as GitHub and Linear:
  - OAuth with PKCE on gitlab.com, scopes `read_api read_user`, client id from `YAAH_GITLAB_CLIENT_ID`. With no
    client id, offer only the API key (personal access token, `read_api`).
  - A custom base URL for self-managed instances, defaulting to `https://gitlab.com`.
  - Queue: `/issues?scope=assigned_to_me|created_by_me&state=opened`. Item: `/projects/:id/issues/:iid` plus notes
    (system notes excluded). Id `group/project#iid`; URLs `https://<host>/<group>/<project>/-/issues/<iid>`.

## Types (camelCase JSON)
```ts
type WorkService = "github" | "linear" | "linear-project" | "gitlab";
type WorkItem = {
  service: WorkService; id: string;            // "owner/repo#12", "ENG-142", project slug-id, "group/proj#7"
  title: string; url: string; status?: string; assignee?: string; labels: string[];
  relation?: "assigned" | "created" | "lead" | "member";
  repo?: string;                                 // "owner/repo" or "group/proj" for github/gitlab
  projectId?: string;                            // the yaah project already linked to it, if any
  updatedAt?: string;
};
type WorkQueue = { items: WorkItem[]; errors: { service: WorkService; kind: "auth" | "forbidden" | "not_found" | "rate_limited" | "other"; message: string }[] };
type ProjectLink = { service: WorkService; id: string; url: string; title: string; linkedAt: number; syncedAt: number };
// Project gains:  link?: ProjectLink
```

## Tauri commands (async, never on the main thread)
- `work_queue(): WorkQueue`: every connected service in parallel (15 s timeout each); one failing never hides the
  others; each item is tagged with `projectId` when a project already links it.
- `resolve_work_item({ input: string }): WorkItem`: a pasted URL or id. GitHub/GitLab ids need `owner/repo#n`;
  `ENG-142` is Linear; a Linear project URL is linear-project. Errors name what was expected.
- `start_project_from_item({ service, id, accountId?: string }): { project: Project; existing: boolean; chatId?: string; draft?: string; addedRepos: string[] }`
  - If a project already links this item, return it with `existing: true` and create nothing.
  - Otherwise:
    - create the project named after the item (Linear issue: `ENG-142 Title`; GitHub: `#12 Title`; trimmed to 80);
    - set its status from the item: done/closed/completed/merged/fixed → done; canceled/cancelled/archived/wontfix → archived;
      backlog/todo/unstarted/triage/open → planning; anything else → ongoing;
    - store `link`;
    - write the brief block (below);
    - add the matching local repo(s) for github/gitlab;
    - start a chat in it with `accountId` (or the default agent) and return its `chatId` plus the `draft` text for the
      composer: `Work on ENG-142: <title>` (or `Work on owner/repo#12: <title>`; for a Linear project: `Plan the work for <name>`).
  - It never sends a prompt.
- `refresh_project_link({ projectId }): Project`: re-fetch and rewrite only the brief block; update `link.title`/`syncedAt`.
  Doesn't change the project's status or name.
- `unlink_project({ projectId }): Project`: drop `link` and the brief block.
- Events: `projects-changed` (the existing event, if there is one) after start, refresh and unlink.

## The brief block (in the project's `project.md`, the brief embedded in each chat's first prompt)
Between `<!-- yaah:source:start -->` and `<!-- yaah:source:end -->` at the top. User edits outside the markers
survive a refresh. Content:
```
# ENG-142 Title

**Source:** Linear issue: <url>
**Status:** In Progress · **Assignee:** Ana · **Labels:** bug, billing

## Description

<description, or "_No description._">

## Recent comments

**Ana**, 2026-10-30: …
```
(For a Linear project: description, state and progress, then `## Issues` as a list `- ENG-1 Title (state, assignee)`.)

## Components for the project page (yaah pack, `src-tauri/components/*.json`, live sources)
- the existing `linear-issue`;
- new: `github-issue` (source `github.issue {repo, number}`), `gitlab-issue` (source `gitlab.issue {project, iid}`),
  `linear-project` (source `linear.project {id}`).
- New sources in sources.rs: `github.issue`, `github.issues` (repo list), `gitlab.issue`, `gitlab.issues`, `linear.project`,
  documented in `src/ui-primitives.json` `sources`.

## Codrift reference (from a read-only study)
- Linear GraphQL: `issues(filter:{state:{type:{nin:["completed","canceled"]}}, assignee:{isMe:{eq:true}}}, first:50, orderBy:updatedAt)`,
  and the same with `creator:{isMe}`; fields `id identifier title description url state{name} assignee{name} labels{nodes{name}}`.
- GitHub REST 2022-11-28 as above. HTTP status to error kind: 401 → auth, 403 → forbidden, 404 → not_found, 429 → rate_limited.
- Its GitLab adapter uses `/issues?scope=...` and `/projects/:id/issues/:iid`, scopes `read_api read_user`.
