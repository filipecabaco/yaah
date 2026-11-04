# Model and effort in the composer

`pnpm dev` (browser mock) on port 1437, driven with vitro, 1440×900, yaah light. The mock's Claude profiles offer what
claude-agent-acp 0.100 does (mode, model, effort whose levels depend on the model, fast mode); "OpenCode · OpenRouter"
offers about 120 models; Claude (personal) offers nothing. See `docs/research/model-effort.md`.

| shot                            | what it shows                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `01-composer-row.png`           | A new Claude chat: the Model and Effort pickers under the message box, showing the current values.                |
| `02-locked-mid-turn.png`        | While a turn runs (a permission card waiting) both pickers are disabled; their tooltip says to wait for the turn. |
| `03-model-picker.png`           | The model list: the agent's names and descriptions, the current one ticked. Five values, so no search box.        |
| `04-model-picker-keyboard.png`  | ↓ ↓ from the trigger: the list has focus, so arrows and Enter work without a mouse.                               |
| `05-effort-follows-model.png`   | After picking Sonnet 4.6 the agent's answer replaces the effort levels (no Max for Sonnet).                       |
| `06-palette-actions.png`        | ⌘K "change": "Change model…" and "Change effort…" with the current values.                                        |
| `07-long-list-searchable.png`   | "Change model…" on the OpenRouter-bound OpenCode chat opens its picker with a search box focused (123 models).    |
| `08-fuzzy-search.png`           | "gpt" ranks openrouter/GPT-5.5 first (cmdk's fuzzy match over value, name and description).                       |
| `09-settings-defaults.png`      | Settings → Agents → Claude, "New chats start with": Model and Effort, both "The agent's default".                 |
| `10-settings-bound-profile.png` | A profile bound to OpenRouter: the model comes from the binding and can't get a default here; only Effort can.    |

Notes:

- The dev server ran with HMR off (a throwaway config, removed afterwards): other agents were editing the tree, and every
  save reloaded the page and reset the mock.
- `04` found a bug fixed before the later shots: without a search box focus stayed on the popover, so the list didn't
  get the arrow keys. The list now takes focus itself.
