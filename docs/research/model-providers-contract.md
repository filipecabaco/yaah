# Model providers (contract)

Branch `feat/model-providers-bedrock-openrouter`. Research: [model-providers.md](model-providers.md).

## Decisions (from the user)
- **Providers:** OpenRouter and Amazon Bedrock, for **Goose, OpenCode and Claude Code**, not Claude only.
- **Bedrock auth:** an **AWS profile, including SSO** (`~/.aws/config`), validated and listed through the `aws` CLI.
- **Secrets** (the OpenRouter key) go in the **OS keychain** (macOS Keychain, Linux Secret Service) through the `keyring`
  crate (a new dependency, approved). Nothing secret goes in JSON. A Bedrock profile has no secret, only the profile name
  and region.
- **A provider-backed agent is its own profile**, e.g. "Goose · Bedrock", "OpenCode · OpenRouter", "Claude · Bedrock".

## Data (Rust)
- `~/.config/yaah/providers.json` (0600) holds the non-secret part:
  `{ providers: [{ id, kind: "openrouter" | "bedrock", label, bedrock?: { profile, region, prefix? /* us|eu|apac|global */ }, checkedAt?, check?: { ok, detail } }] }`.
- **OpenRouter key:** keychain service `dev.yaah.app`, account `provider:<id>`.
- **`agents::Profile`** gains `#[serde(default)] provider: Option<Binding>`, with
  `Binding { providerId, model, smallModel? }`. It's translated **at spawn**, never written into `Profile.env`.
  `same_command` compares the binding.

## Commands (camelCase, async)
- `list_providers() -> ProviderInfo[]`: `{ id, kind, label, bedrock?, hasSecret, check? }`. Never returns a secret.
- `save_provider({ id?, kind, label, bedrock?, secret? })`: an omitted `secret` keeps the stored one.
- `delete_provider({ id })`: refused while a profile is bound to it, with a message naming the profiles.
- `test_provider({ id })`:
  - OpenRouter: `GET https://openrouter.ai/api/v1/key` (label, limit, remaining, free tier);
  - Bedrock: `aws sts get-caller-identity --profile P` (account and arn). On an expired SSO login, the message says
    "run `aws sso login --profile P`", and an action can run it.
- `provider_models({ id, preset }) -> { models: [{ id, label, contextLength?, tools: bool }], cachedAt }`:
  - OpenRouter: `/api/v1/models?supported_parameters=tools`;
  - Bedrock: `aws bedrock list-inference-profiles` plus `list-foundation-models` (TEXT, ON_DEMAND), preferring
    inference-profile ids;
  - filtered per preset (Claude: Anthropic models only; Goose/OpenCode: anything tool-capable);
  - cached for a day.
- `aws_profiles() -> [{ name, region?, sso: bool }]`, parsed from `~/.aws/config`/`credentials` (names only, never secrets).
- `set_profile_provider({ accountId, binding | null })`.

## Readiness
- A profile with a binding to a provider whose last check passed counts as ready (`loggedIn: true`), and shows
  `detail` ("Bedrock · us-east-1 · <profile>" / "OpenRouter · <key label>") where the email would be.
- Handle claude-agent-acp's `_auth/status_update` (`kind` of external, gateway or api_key means ready).
- The ACP `-32000` stays the backstop.

## Per-agent translation (`agent_routes.rs`)
`route(preset, provider, binding, profile_dir) -> Result<Route, Unsupported>`, where
`Route { env, env_remove, files, acp_providers_set? }`:
- **Goose:**
  - always `GOOSE_PATH_ROOT=<profile dir>` and `GOOSE_DISABLE_KEYRING=1`;
  - Bedrock: `GOOSE_PROVIDER=aws_bedrock`, `GOOSE_MODEL=<prefixed id>`, `AWS_PROFILE`, `AWS_REGION`;
  - OpenRouter: `GOOSE_PROVIDER=openrouter`, `GOOSE_MODEL`, `OPENROUTER_API_KEY`.
- **OpenCode (v2):** `OPENCODE_CONFIG_CONTENT` JSON with the provider (`amazon-bedrock` with profile and region, or
  `openrouter`) and `model` (`amazon-bedrock/<prefixed id>` / `openrouter/<id>`), plus `OPENCODE_DISABLE_PROJECT_CONFIG`
  where appropriate.
  - Bedrock: `AWS_PROFILE`, `AWS_REGION`.
  - OpenRouter: `OPENROUTER_API_KEY`.
  - Use a per-profile data dir, so a saved credential can't win.
- **Claude Code:**
  - Bedrock: `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_PROFILE`, `AWS_REGION`, `ANTHROPIC_MODEL` /
    `ANTHROPIC_DEFAULT_*_MODEL`, and remove `ANTHROPIC_API_KEY`.
  - OpenRouter: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_API_KEY=""`,
    model env; or `providers/set` when the adapter advertises `providers` (`apiType: "anthropic"`, `baseUrl`, the
    `Authorization` header). Prefer env until the model picker behaviour is verified.
- **Attribution headers:** add OpenRouter's (`HTTP-Referer: https://filipecabaco.github.io/yaah/`, `X-OpenRouter-Title: yaah`)
  where the agent supports custom headers.
- **Secrets** go only to that agent's process (no `OPENROUTER_API_KEY` on Bedrock profiles).

## Managed installs
- Goose and OpenCode come from the ACP registry's release archives (`agent.json` `distribution`), with **sha256 verified**,
  into `~/.yaah/agents/<id>@<version>/`. They follow the same install/verify/promote/hold flow as the npm adapters
  (`agent_install.rs`, `agent_versions.rs`).
- A binary on PATH still wins.
- OpenCode uses the registry's v2 (`opencode-v2`) build.

## Conformance
- **Tier A "provider mode":** a local `tiny_http` stub speaking OpenAI Chat/Responses, Anthropic Messages and the
  OpenRouter `/models` and `/key` endpoints. Each preset starts with its translated route pointed at the stub, and the
  checks are:
  - `session/new` gets no `-32000`;
  - one prompt streams with a tool call;
  - the model id reached the stub;
  - no secret appears in argv.
- **Tier B (live, `#[ignore]`):** Bedrock with the user's AWS profile.
