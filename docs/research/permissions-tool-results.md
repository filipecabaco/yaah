# Permission prompts for the agent's saved tool results

Research only; no app code changed. Evidence: the chat transcript `~/.yaah/sessions/44cfaa80-dd88-41f8-ba23-b6149982d632.json`,
claude-agent-acp 0.100.0 and the Claude Code 2.1.316 binary it runs (`~/.yaah/agents/`), Claude Code's permissions docs
(code.claude.com/docs/en/permissions), and `app/src-tauri/src/session/permissions.rs`.

## What the prompts are

When an MCP tool result is too large to return inline, Claude Code writes it to
`<config dir>/projects/<cwd slug>/<session id>/tool-results/mcp-<server>-<tool>-<n>.txt` and tells the model "Output too
large (...). Full output saved to: <path>" (strings in the CLI binary; the slug replaces every character outside
`[a-zA-Z0-9-]` with `-`). The config dir is `CLAUDE_CONFIG_DIR`, here `~/.claude-personal`. The model then reads that file
back, usually with Bash (`grep`, `sed -n`, `cut`), because it wants to slice and search a 5,000-line Wikipedia page. The
prompt the user saw is yaah asking about one of those read-back commands. It is read-only in intent, but yaah only sees an
`execute` tool call with a command string.

## Why yaah asks

`decide` auto-allows only `kind` `read` or `search` with every path inside the chat's folders. A Bash call arrives as kind
`execute`, with `locations: []` and `rawInput: { command, description }`. So it never qualifies, and the files are outside
the chat's cwd anyway. Claude Code asks too, for its own reasons: the docs say a built-in set of read-only commands (`ls`,
`cat`, `head`, `tail`, `grep`, `wc`, `cd`...) runs without prompting, but `sed` prompts when an unquoted glob is present,
the binary rejects "unquoted variable expansion" (`$F`) and "bare assignment to a non-allowlisted environment variable",
and commands whose paths fall outside the working directories are not covered. `F=...; ... $F` trips those, so the
adapter's `canUseTool` fires and yaah forwards it.

Claude's own Read tool does not prompt: in this chat one `Read` of a `tool-results` file (entry 58, kind `read`) produced
no permission entry at all. Claude Code treats its own saved results as readable. yaah would also have asked for that Read
(path outside the chat's folders) had it arrived, but it did not arrive.

## How many prompts this chat had

34 permission entries: 1 WebSearch, 10 `mcp__fetch__fetch` (9 answered by the "remembered" rule), and 23 Bash (`execute`)
prompts, all answered Yes once (4 of them "don't ask again", which Claude saves for itself and which did not stop later
prompts, since each command differs). Of the 23:

- 14 are read-only pipelines on a saved result: 10 with `F=<abs path>; grep|sed|cut ... $F` (some with a `clean(){...}`
  function or `for` loop), 4 with `cd <tool-results dir>/; f=<name>; grep ... $f | sed ...` (requests 14, 17, 31, 32;
  request 31 and 32 are the second example the coordinator sent).
- 3 copy results to `/tmp/tx` (`D=<dir>; cp $D/x /tmp/tx/p1.txt; wc -l`): a write outside the chat.
- 5 run on those copies (`cd /tmp/tx; grep|awk|sed`), outside the chat's folders. They exist only because the model copied
  the files out; with the files readable in place the model would probably not have copied.
- 1 writes JSON into the chat's scratch folder (`mkdir -p ...; cat > wisconsin.json <<'EOF'`): a real write, should ask.

So 17 of 23 touch `tool-results` and 22 of 23 are read-only or copies of read-only data.

## How others handle it

- Claude Code (terminal): reads of its own tool-results are allowed; read-only Bash is allowed by a built-in command list
  and only inside the working or `additionalDirectories`; anything it cannot parse asks. The set is not configurable.
- claude-agent-acp: passes `canUseTool` through as `session/request_permission` (options allow-once, allow-with-updates,
  reject), and passes `additionalDirectories` to the SDK. It adds no extra policy. Making the tool-results dir an
  `additionalDirectories` entry is possible but would also grant Claude Code edit rules there and relies on yaah knowing
  the session id before `session/new`, which it does not.
- Zed and the ACP clients I know of (UNVERIFIED; I did not re-check them): they show the agent's prompt and offer
  "always allow" per tool or command, with no shell parsing of their own, matching the existing `permissions.md`.

## Options

(a) The chat's tool-results dir as a read root. After the session starts, yaah knows the ACP session id and the profile's
config dir, so it can compute the one directory above and add it to the roots `decide` checks. Effect: `read` and
`search` there (Read, Grep, Glob) are allowed with the read-only chip. Security: the directory holds only what the agent
itself fetched or ran, for this session; anything else in it was already given to that agent. The existing check
resolves symlinks and `..`, and Claude Code itself refuses to persist through a symlink, so a link out of the folder fails
the inside test. Risk: a prompt-injected page could cause reads of its own saved text, which are already in the model's
context. It does not extend to the config dir's other folders (settings, credentials, other sessions): the root must be
the single session's `tool-results`, not `~/.claude-personal`. Does not touch `execute`.

(b) A narrow read-only shell rule. Allow `execute` only when the whole command parses as a sequence/pipeline of
`grep`, `sed -n`, `cut`, `head`, `tail`, `wc`, `cat`, `ls`, `cd`, with plain `NAME=literal;` assignments, no redirection,
no substitution, and every path inside the roots. It would have covered 14 of the 23 prompts. The honest cost:
- Grammar: quoting, `$F`/`${F}` expansion, `clean(){...}` functions, `for` loops, heredocs, `$((n+14))` arithmetic, `;`
  vs `&&` vs newlines, `\` continuations. Claude's own analyzer is thousands of lines and still lists special cases. A
  hand parser must reject anything it does not fully understand, which means rejecting the function and `for` shapes
  above, leaving ~10 of 14 covered.
- Variables: `F=...; grep x $F` must be evaluated by yaah itself (only literal assignments, substituted before the path
  check). Env tricks (`IFS`, `PATH`, `GREP_OPTIONS`, `LESSOPEN`) need a reject list.
- Flags: `sed` is the dangerous one (`w file`, `e` command, `s///e` and `s///w`, `-i`, `-f script`), `grep -f`
  reads patterns from any file, `jq` can read files with `--rawfile`/`--slurpfile`/`-f`, `cat`/`head` take any path. Each tool
  needs a flag allowlist, not a blocklist.
- Symlinks and globs: paths must be resolved after variable substitution; unquoted globs must be refused or expanded.
- It also contradicts `permissions.md` and PR #8's explicit "no yaah shell allowlist; the agent knows its shell better".
  This case does not change that: Claude Code already auto-allows most of this class when paths are in its working
  directories, and the thing missing is a path root, which (a) supplies for the Read/Grep tools. A conservative parser can be
  made safe against a fixed grammar, but the value is only about 60% of one chat's prompts and the maintenance and bypass
  surface are permanent. Not recommended now.
  Both `cd <dir>/; f=name; grep ... $f` and `F=<abs>; ... $F` would need relative-path resolution against a `cd`, one more
  stateful step to get wrong.

(c) Steering. Tell Claude, via a short system-prompt addition or the adapter's `_meta.claudeCode.options`, to use Read
(with offset/limit) and Grep on saved tool results and to avoid `cp`/`cd` games. With (a), the Read/Grep calls would be
auto-allowed, and Claude Code already does not prompt for Read. It is agent-specific (yaah is agent-generic, see memory),
and the model may still reach for Bash: here it used Bash 23 times and Read once, since Grep and Read cannot do `sed` plus
`cut` in one go. It is a hint, not a guarantee, so it must not be the only fix.

(d) Explain better. When an `execute` prompt's command mentions a path under the profile's `projects/*/tool-results/`,
show "Claude is reading a saved tool result" and render the command. It makes the prompt understandable, changes no
authority, and applies to Codex-like equivalents. It leaves the prompt count unchanged.

## Recommendation

Do (a) plus (d), and offer (c) as an optional Claude-only hint. Skip (b).

What this covers: Read/Grep/Glob on the session's saved results with no prompt, and a clear explanation for the Bash
prompts that remain. What it does not cover: Bash read-backs (14 of the 23 here) still ask if the model chooses Bash, and
any `cp` to `/tmp` or `cd /tmp/tx` flows ask. If users still find that too noisy, a better lever than a yaah parser is
the agent's own mechanism, such as a user's `permissions.allow` rule for the read-only commands or Claude's
`additionalDirectories`, which the agent parses.

Implementation notes for later: resolve the config dir from the profile's `CLAUDE_CONFIG_DIR` (`~/.claude` when unset),
compute the slug from the real cwd with `[^a-zA-Z0-9-]` replaced by `-`, use the ACP session id (not necessarily the yaah
chat id; they matched here), add only `<dir>/projects/<slug>/<session>/tool-results`, and only for the Claude adapter.
Show a distinct chip text ("saved tool result") so the user can tell it from folder reads.

## Tests to add when built

1. `read` of `<cfg>/projects/<slug>/<session>/tool-results/x.txt` is allowed; the same under `<cfg>/projects/<slug>/` or
   another session id asks.
2. `search` (Grep) with `path` = that directory is allowed; with `path` = `<cfg>` asks.
3. A symlink inside `tool-results` pointing to `~/.ssh` or `<cfg>/.credentials.json` asks; `..` out asks.
4. Sibling prefix `tool-results-evil` asks.
5. `execute` with a `cat` of the same file still asks (no shell rule).
6. A config dir from the profile (`~/.claude-personal`) and the default (`~/.claude`) both resolve; an unset or relative
   `CLAUDE_CONFIG_DIR` adds no root.
7. The roots are removed when the chat ends or the session id changes (resume, fork).
8. The slug function against the real example: cwd `/Users/filipecabaco/.yaah/scratch/be2cba80a028` gives
   `-Users-filipecabaco--yaah-scratch-be2cba80a028`.
9. (d) the prompt text shows "reading a saved tool result" only when the command's path argument is inside that directory,
   not for a command that merely contains the string.
