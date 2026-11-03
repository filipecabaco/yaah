# Git sources and the diff-review component (contract)

Branch `feat/chat-and-creation-improvements`. Lets agents show git data by reference instead of pasting it into
`ui_render` JSON (the cause of long "Assembling UI" waits).

## Sources (Rust, `sources.rs`, read-only, run in the chat's folder through `path_env::command`, never a shell)

| kind | params | returns |
|---|---|---|
| `git.diff` | `range?` (e.g. `main...HEAD`; default: working tree vs HEAD), `staged?` (bool), `paths?` (string[]), `context?` (lines, default 3) | `{ range, text (unified diff), files: [{ path, oldPath?, status: added\|modified\|deleted\|renamed, additions, deletions, binary }], additions, deletions, truncated }` |
| `git.log` | `range?`, `limit?` (default 50, max 500), `paths?` | `[{ sha, short, author, date, subject, body }]` |
| `git.status` | — | `{ branch, upstream?, ahead, behind, files: [{ path, index, worktree }] }` |
| `git.show` | `rev` (required), `path?` | `{ rev, text }` (a commit's patch, or a file at that revision) |

- The folder is the chat's working directory. Every git source (and `diff-review`) also takes `repo?`: another of the
  chat's folders (its `extraDirs`, its project's repos), an absolute path or `~/…`, matched by canonical path
  (`sources/git.rs` `folder`). Anything else, a symlink out included, is refused: "`<path>` isn't one of this chat's
  folders: add it with /repos". For a repo outside them the agent calls `ui_request_folders` first (chat-repos contract). Refs and paths are validated (no leading
  `-`, no `..` escaping the repo, refs match `[A-Za-z0-9._/@^~{}-]+`).
- The output is capped (e.g. 4 MB of diff text, `truncated: true`).
- Errors say what was wrong ("not a git repository", "unknown revision `x`").
- The chat's cwd is given to the source by yaah from the session, so the `live`/`source_read` call needs no path.

## Component `diff-review` (yaah pack, `src-tauri/components/diff-review.json`, plus a primitive if needed)
- **Props:** `{ range?, staged?, paths?, repo?, title? }`, live through `git.diff`.
- **Layout:** a file list (status, +/−, a "viewed" tick) and one file at a time; file tabs across the top below about 900 px wide.
- **Keyboard:** j/k file, n/p hunk, v toggles viewed, Enter opens the file view.
- **Actions, per file and per hunk:**
  - "Ask about this" (drafts a mention plus the hunk into the composer);
  - "Ask to change or revert this" (drafts a request; never applied silently);
  - Copy path, Copy hunk, Open in editor, Mark as viewed (kept per chat and range in the UI entry's draft, so it survives
    re-renders).
- **Rendering:** tabs at 4 spaces, no wrapping by default (horizontal scroll), with a wrap toggle; syntax colours as the
  existing diff view has.
