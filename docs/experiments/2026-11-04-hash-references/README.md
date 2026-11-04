# `#` references to GitHub, GitLab and Linear items (2026-11-04)

Branch `feat/composer-drop-model-refs`. Shots are vitro on the dev mock (`pnpm dev` on port 1463), in a chat of the
"billing revamp" project, whose folders are clones of `acme/api` and `acme/web`. The mock's GitLab token is revoked,
which is why GitLab answers with an auth error in the first shots.

| Shot                                  | What it shows                                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `01-hash-all-services.png`            | `#`: every connected service in one list. The chat's repos (`acme/api`, `acme/web`) come first, then the user's own items (Linear's `ENG-142`). Each row: service/kind icon, id, title, state badge, kind and repo/team. |
| `02-fuzzy-webhook-ranked.png`         | `#webhook`: narrowed as you type, then Rust's answer for the query (repos first); GitLab's failure is a line under the list, the others still list.                                                                      |
| `03-picked-token-and-chips.png`       | Tab inserted `github#acme/api#212 `; the token stays plain text in the textarea, and "Attaches" under it shows what it will send.                                                                                        |
| `04-linear-trigger.png`               | `linear#`: Linear issues only, with Linear's own state names.                                                                                                                                                            |
| `05-reading-on-send.png`              | Enter: "Reading" while Rust reads the references before the turn starts.                                                                                                                                                 |
| `06-transcript-chips-and-failure.png` | The sent message: each reference a chip linking to the item; `github#acme/gone#5` couldn't be read, so its chip is marked and a line says why ("Sent without its details").                                              |
| `07-pasted-link.png`                  | A pasted `https://github.com/acme/api/pull/231/files` offers to become `github#acme/api#231`.                                                                                                                            |

## Decisions

- **Token format**: `github#owner/repo#9` (a PR or an issue: GitHub numbers them together), `gitlab#group/sub/proj!45`
  (merge request) or `gitlab#group/proj#7` (issue), `linear#ENG-123`. A token starts a word (or follows `(`, `[`, a
  quote) and ends at a space or punctuation; inside backticks it stays code.
- **Plain text, not a chip, in the textarea.** A mirror overlay drifts with fonts, wrapping and scroll; a contenteditable
  breaks undo, paste and IME. The token is ordinary text you can edit, move, copy or delete, and a row of chips under
  the composer shows what will be attached.
- **Ranking (Rust)**: an exact id or number first; then real matches (prefix, substring) before letters scattered through a
  title; then the chat's repos (its clones' `origin`s, and its project's linked item; for Linear the linked item's team),
  then items involving the user (GitHub `involves:@me`, GitLab MRs you opened and issues assigned to you, Linear issues
  assigned to or created by you), then the rest; then the closer match; then the most recently updated.
- **API calls**: none per keystroke. Opening the list asks each connected service once for its recent items; typing waits
  250 ms, then asks once more for the query (at least 2 characters, or an id or number). Both are cached for 60 s, so
  typing back and forth costs nothing. Per query: GitHub 1 GraphQL request (two `search` aliases; +1 for a number, looked
  up in up to 5 of the chat's repos), Linear 1 GraphQL request, GitLab 2 REST requests per chat repo (up to 3) plus 2.
  On send: GitHub 1 request per issue, 2 per PR; GitLab 2 per issue, 3 per MR; Linear 1. At most 10 references per message.
