# Model providers: Bedrock and OpenRouter (2026-11-03)

Branch `feat/model-providers-bedrock-openrouter`. The settings and profile screens for
[the contract](../../research/model-providers-contract.md), checked with vitro on the dev mock (`pnpm dev`,
http://localhost:1420) at 1440 × 900 and 420 × 860, in light and dark mode. The mock's messages are the ones
`providers.rs` writes.

## What was built

- **Settings → Model providers** (`providers-settings.tsx`), a new tab after Agents. Each provider is listed with its kind,
  its label and its last check: "OK · key yaah-dev" or "OK · account 123456789012" with Rust's one-line detail, a failed
  check, or "Expired SSO login" with **Sign in with AWS SSO**. That button runs `aws sso login` in the background and
  waits for Rust's `provider-sso-login` event, which arrives after the provider is tested again. Each row has Test, Edit
  and Remove. Remove asks first; when profiles are bound, it names them and offers no way to remove.
- **Add OpenRouter:** a name and a password field for the API key. Once saved, the key never comes back: Edit shows "A
  key is saved in your keychain" and **Replace key**.
- **Add Amazon Bedrock:** a name, an AWS profile picker fed by `aws_profiles` (SSO profiles marked), the region
  (prefilled from the profile), and the inference-profile prefix (us/eu/apac/global, defaulting from the region). The
  form says that yaah uses your AWS profile, stores no AWS secrets and needs AWS CLI v2. A new provider is tested as soon
  as it's added.
- **Agents → a profile → Model provider:** "The agent's own sign-in" or one of your providers, then a searchable model
  picker fed by `provider_models`. Each model shows its context length and a "tools" badge, and OpenRouter's `:free`
  models are marked "free". Claude also gets an optional small/fast model. A new profile's name is suggested ("Goose ·
  OpenRouter"). Presets that can't use a provider say so ("Gemini CLI can't use Bedrock or OpenRouter").
- **Readiness:** the sidebar's agent select, the agent menus, ⌘K and the chat badge's tooltip show the profile's `detail`
  where the email used to be. A bound profile whose check passed can chat. A failed check reads "fix in Settings → Model
  providers": logging it in opens that tab on the provider instead of a login dialog.

## Screenshots

| File | What it shows |
|---|---|
| `01-providers-light.png` | The list: OpenRouter OK (key label, limit), Bedrock with an expired SSO login, and who uses each |
| `02-add-bedrock-light.png` | Add Amazon Bedrock with the `eu-sandbox` SSO profile picked: the region and the `eu` prefix follow it, and the name is suggested |
| `03-sso-signed-in-light.png` | After Sign in with AWS SSO: tested again, OK · account, and the ARN in the detail |
| `04-claude-bedrock-model-picker-light.png` | Claude · Bedrock: provider, the model picker (Anthropic only, context, tools), and the small-model picker below |
| `05-openrouter-free-models-dark.png` | OpenCode · OpenRouter, searching "free": the `:free` models marked; the header badge shows the detail |
| `06-unsupported-preset-dark.png` | Gemini CLI: "can't use Bedrock or OpenRouter: it runs on its own sign-in" |
| `07-sidebar-agent-detail-dark.png` | The sidebar's agent select: emails for Claude logins, "OpenRouter · yaah-dev", and "fix in Settings → Model providers" |
| `08-sidebar-fix-provider-light.png` | Claude · Bedrock picked with a failed check: the sidebar offers the fix, not a login |
| `09-providers-narrow-dark.png` | 420 px wide, dark: the list stacks and the long ARN wraps (it overflowed before the fix below) |
| `10-remove-refused-narrow-dark.png` | Remove on a provider a profile is bound to: it names the profile and offers no way to remove |
| `11-providers-dark.png` | The list in dark mode at 1440 px |

## Found and fixed while checking

- At 420 px, the ARN in a Bedrock check (no spaces) made the whole tab scroll sideways inside the dialog's scroll area.
  The detail now wraps anywhere (`overflow-wrap: anywhere`).
- The prefix hint now follows the chosen prefix ("e.g. eu.anthropic.claude-…").
