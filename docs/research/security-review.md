# Independent security review

November 2026. Findings from an independent review of yaah after the first code-quality pass. All numbered findings
were fixed in commit `2695665` ("Harden agent-facing surfaces after security review").

| # | Severity | Finding | Fix (commit 2695665) |
|---|---|---|---|
| 1 | High | "Read-only" Postgres still allowed `pg_read_file`, `pg_ls_dir` and `pg_terminate_backend` for superuser and privileged roles. That was reachable with no prompt, because every yaah MCP tool (`source_read` included) was auto-approved | Refuse superusers and roles with `pg_read_server_files`, `pg_write_server_files`, `pg_execute_server_program` or `pg_signal_backend`, on add and before any SQL (cached 60 s). Only the `ui_*` tools are auto-approved now |
| 2 | Medium | `browser` iframes loaded any https URL on render, so an agent could leak data with no click | Click-to-load (yaah's own `/preview/` excepted); Mermaid SVG stripped of remote images and `url()` |
| 3 | Medium | Nested library components expanded exponentially, so one agent could freeze every chat | One 3000-node expansion budget; `uses` memoised; list and preview off the main thread |
| 4 | Low | The preview server exposed the HTML file's whole folder (`/tmp` on Linux) | Shared temp folders refused; web assets only; CSP + `nosniff` on responses |
| 5 | Low | `ui_get_values` returned inlined file contents | Only `image`/`browser` `src` are inlined |
| 6 | Low | One agent process could write into another's chat | Messages from a non-owning generation are dropped; duplicate session ids refused |
| 7 | Low | Any web page could cancel a Linear sign-in | Wrong-state callbacks get a 400, and the flow keeps waiting |
| 8 | Low | The login env filter was a blocklist | Changed to an allowlist (`CLAUDE_*`, `ANTHROPIC_*`, `GEMINI_*`, `LC_*`, `FORCE_COLOR`, `NO_COLOR`, `TERM`, `LANG`) |
| 9 | Low | A library button could send hidden text as the user's message | An inline confirm shows the exact text unless it equals the label |

## Still open (informational)

- **GitHub `repo` scope** is broad: GitHub's OAuth apps have no read-only scope. Settings suggests a fine-grained PAT.
- **The OAuth client ids** (GitHub, Linear) are codrift's registered apps. yaah needs its own before shipping.
- **MCP servers with an empty agents list** go to every agent, and existing servers were scoped "All agents".
- **Secrets cross IPC:** MCP server secrets travel between Rust and the UI.
- **Token lifetime:** UI MCP tokens never expire.
- **Supply chain:** npx dependencies are pinned only at the top package.
- **Agent stderr** is shown unfiltered.
- **Subframes:** Tauri IPC in subframes is unverified.
- **Previewed pages** can still leak data through image URLs (`img-src https:` for CDN assets).
- **Previews share one origin** (`127.0.0.1:<port>`), so their storage is shared. Fix this before any third-party widget
  (see [component-model-review.md](component-model-review.md), item 11).
- **CSP not tested in a release build** (`devCsp` is null).
