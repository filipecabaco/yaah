# Model and effort in the composer

The user asked for ways to set the model and the effort used, from the message box. This covers what ACP offers, what
each adapter yaah pins sends, and what yaah does with it (`src-tauri/src/session/config.rs`,
`src/components/composer-config.tsx`).

## What ACP offers

Read in the schema the adapters ship (`@agentclientprotocol/sdk` 2.1 and 2.4, `schema/v1/schema.json`).

- **Session config options (stable).** `session/new`, `session/load` (and resume and fork) may return `configOptions`:
  `[{ id, name, description?, category?, type: "select", currentValue, options }]`. `options` is either a flat list of
  `{ value, name, description? }` or a list of groups, `{ group, name, options }`.
  - `category` is `mode`, `model`, `model_config`, `thought_level`, or a custom `_…` name. The spec calls it UX-only
    and says a client must not need it to work correctly.
  - `type: "boolean"` options (`currentValue: bool`) are sent only to clients that advertise
    `clientCapabilities.session.configOptions.boolean`. yaah doesn't, so agents send those as an `on`/`off` select.
- **`session/set_config_option`** `{ sessionId, configId, value }` answers with `{ configOptions }`, which is the full
  set. One change can move other options: Claude's effort levels follow the model, and so does Codex's reasoning effort.
- **`config_option_update`** (a `session/update`) also carries the full set. Agents send it when something changes on
  their side. Claude and Codex also send it for subagent sessions, under the child's session id, which yaah doesn't
  know, so those are dropped.
- **Older and unstable:** `models: { availableModels: [{ modelId, name, description }], currentModelId }` on
  `session/new` and `session/load`, changed with `session/set_model { sessionId, modelId }`, which answers `{}`. It is
  no longer in the v1 schema, but Gemini CLI still uses it.
- **Modes:** `modes` with `session/set_mode` and `current_mode_update` is the older form. Mode is now one of the config
  options too.

## What each adapter sends (pinned versions)

Checked in the installed packages' code, and in the tier A conformance run. That run starts each adapter in a
throwaway home, signed out, and now lists the settings a signed-out `session/new` returns.

| agent                                          | how it sends settings                 | model                                                                               | effort                                                                                                                       | other settings                                                 | `session/load`                                                                                              |
| ---------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Claude Code (claude-agent-acp 0.99.1, 0.100.0) | `configOptions` and `modes`           | `model`: `default`, `opus`, `sonnet`, `sonnet[1m]`, `haiku`, …; 5 values signed out | `effort` (`thought_level`): the model's `supportedEffortLevels` plus `default`; 6 values on the default model, none on Haiku | `mode`, `fast`, `ultracode`, `agent` (only with custom agents) | 0.100 resumes the model from the transcript (`resumedModelHint`); effort comes from settings, so it is lost |
| Codex (codex-acp 2.5.0)                        | `configOptions`                       | `model`                                                                             | `reasoning_effort` (`thought_level`): the model's `supportedReasoningEfforts`                                                | `mode`, `collaboration_mode`, `fast-mode`                      | not verified; asks for a login before `session/new`                                                         |
| Gemini CLI (0.66.0, and 0.63 locally)          | `models` and `session/set_model` only | `auto` plus the Gemini models                                                       | none                                                                                                                         | `modes`                                                        | answers with `models` again                                                                                 |
| goose 1.57.0                                   | `configOptions` and `modes`           | `model`: the provider's inventory                                                   | `thinking_effort` (`thought_level`): `off`/`low`/`medium`/`high`/`max`, depending on the model                               | `provider` (no category), `mode`                               | restores the session's stored provider and model                                                            |
| OpenCode 2.2.5                                 | `configOptions`                       | `model`: `providerID/modelID` for every enabled model; 8 signed out                 | `effort` (`thought_level`): the model's `variants` plus `default`, only when it has some                                     | `mode` (its agents)                                            | restores the stored model, variant and agent                                                                |

So "effort" means Claude's thinking effort level, Codex's reasoning effort, goose's thinking effort, and OpenCode's model
variant. yaah doesn't need to know any of this per agent: it goes by category, and by id when an agent sends no category.

## What yaah does

- **Rust owns it** (`session/config.rs`). It parses `configOptions`, and falls back to `models` only when no option of
  category `model` (or id `model`) is there. Then it marks one option as the Model picker (the first `model`) and one as
  the Effort picker (the first `thought_level`). Without categories, the ids `model`, `effort`, `reasoning_effort`,
  `thinking_effort`, … stand in.
  - Input is untrusted: at most 32 options and 2000 values each, texts cut to 300 characters, repeated ids dropped. A
    current value missing from the list is added to it.
  - The options and the user's picks (`choices`) are kept in the chat's `SessionInfo.config`, which is saved with the
    chat.
- **Changing a value** (`set_chat_config`):
  - The value must be one the agent offered.
  - It is refused while a turn runs. The pickers are disabled then, and ⌘K doesn't list them.
  - An attached chat sends it at once, with `session/set_config_option` (or `session/set_model`), and the agent's answer
    becomes the chat's state. Then each pick is set to what the agent now has (the effort level after a model change).
  - A chat that isn't attached (after a restart) keeps the pick and shows it, and sends it when the next message reopens
    the session.
  - Either way the change applies to the next message.
- **Reload:** after every `session/load` (a restart, the agent restarted, folders added) and after a hand-off, the picks
  the agent doesn't have are sent again, one at a time in the order the agent lists its options. That way the model goes
  before the effort levels that depend on it. If the agent refuses a pick, it stays at what the agent has and the chat
  carries on.
- **Notifications:** a `config_option_update` replaces the options but not the picks. Only explicit changes move the
  picks.
- **Switching agents** clears the settings. The new agent's fresh session says what it offers.
- **Defaults** (Settings → Agents → "New chats start with"):
  - Saved per profile under `agentConfigDefaults` in `settings.json`.
  - The choices come from what that profile's newest chat was offered. Before its first chat there is nothing to choose
    from yet, and Settings says so.
  - A new chat (or a switched one) starts with them when the agent offers them. Each chat can still change them.
- **Model providers:** when a profile is bound to Bedrock or OpenRouter, the binding picks the provider and the model the
  agent starts with (`agent_routes.rs`, at spawn). The model picker never edits the binding. It switches the model
  inside the session, among the models the agent lists for that provider:
  - Claude on Bedrock maps `opus`/`sonnet` to the bound model and `haiku` to the small one.
  - goose and OpenCode list the provider's models.
  - A bound profile has no model default, and Rust refuses to set one. Settings shows the binding's model in its place,
    so the binding stays the one place that sets the profile's model. The effort default still works.
  - If the binding changes, the agent restarts. Chats then reapply their own picks, and a pick the new provider doesn't
    list is skipped.
  - goose's own `provider` option isn't shown, so the composer can't move a chat off its binding.
- **Conformance:** tier A's "session/new signed out" check now lists the settings an adapter offers. It fails when an
  adapter sends `configOptions` and yaah can read none of them.

## Not built (yet)

- The other options (`mode`, Claude's `fast`/`ultracode`/`agent`, Codex's `collaboration_mode`/`fast-mode`, goose's
  `provider`) are parsed and kept but not shown. A mode picker would be easy to add next (same component, role `mode`),
  but it interacts with yaah's permission handling, so it is left for a decision.
- yaah doesn't advertise boolean options, so agents send those as selects.
- Codex's and Gemini's signed-in lists, and what Codex keeps across `session/load`, need a signed-in run (tier B) to
  confirm.
