# Gemini CLI: not measured (not signed in)

3 November 2026. The live UI test (`app/src-tauri/src/live_ui_review.rs`, `#[ignore]`) was to run with a Gemini CLI
profile on three prompts. It was skipped: Gemini CLI 0.63 is installed, but it isn't signed in on this machine.
`~/.gemini/settings.json` selects `oauth-personal`, and there is no `oauth_creds.json`, no active account in
`google_accounts.json`, no keychain entry and no `GEMINI_API_KEY`.

To run it once signed in (`gemini`, then sign in with Google): `live_ui_review` calls `run_turns`, which reads the user's
own profiles. For Gemini, call `run_turns_as` with a temp `agents::Store` holding one Gemini profile (`gemini --acp`), so
`~/.config/yaah/agents.json` isn't touched, and pick three prompts with `YAAH_REVIEW_ONLY` (for example 1, 4, 6: slides,
cube, saved component).

What Gemini gets today (`agent_guide::plan`): the `yaah-ui` MCP server (instructions, `ui_guide`, the skills as resources
and prompts) and the guide at the top of the chat's first prompt; its `session/new` takes no system prompt or skills option.
The guide now names every tool both ways (`mcp__yaah-ui__ui_catalog` and the bare `ui_catalog`).
