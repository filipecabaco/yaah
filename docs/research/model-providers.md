# Bedrock and OpenRouter across ACP agents

3 November 2026. Research only. Sources: the installed adapter dists, each agent's source at its pinned tag, the ACP
registry (all 47 `agent.json`), the ACP spec and RFDs, and vendor docs. No agent was run with credentials. Items marked
UNVERIFIED were inferred from code or docs.

## Do Bedrock or OpenRouter "support ACP"?

Neither ships an ACP agent or an ACP endpoint:
- **Bedrock AgentCore** speaks MCP, HTTP, A2A and AG-UI, not ACP.
- **Kiro (Amazon)** is an ACP agent, but runs on Kiro's service, not your Bedrock account; bring-your-own-model is "not planned".
- **OpenRouter's "Ori" CLI** is an ACP *client* that drives Claude Code, Codex, OpenCode and Pi with OpenRouter credentials,
  not an ACP agent.

What does exist at the ACP level:
1. **The "Configurable LLM Providers" RFD** (draft): the agent advertises `agentCapabilities.providers`. The client then
   calls `providers/list`, `providers/set {providerId, apiType: anthropic|openai|azure|vertex|bedrock, baseUrl, headers}` and
   `providers/disable` after `initialize` and before `session/new`; this is process-scoped. **claude-agent-acp 0.100.0
   implements it** (anthropic, bedrock, vertex) and **codex-acp 2.5.0** implements it (openai only).
   - Caveat: Claude's `apiType: bedrock` is built for gateways. It uses a bearer token, blanks the region, and skips the
     AWS credential chain, so it can't carry an AWS profile or SSO login. Native Bedrock with a profile still needs env vars.
2. **A "gateway" auth method** (`clientCapabilities.auth._meta.gateway: true`): Claude offers `gateway`/`gateway-bedrock`,
   Codex offers `gateway` (OpenAI), and Gemini offers `gateway` (Google).
3. **The ACP Streamable HTTP/WebSocket transport RFD** (Active): Goose ships it (`goose serve`). It's only relevant for
   remote agents.

**Recommendation:** use `providers/set` where an agent advertises `providers`, and translate to env or config elsewhere.

## Why provider-only profiles look "not logged in" in yaah today
- For Claude, `agents.rs` `info()` sets `logged_in = email.is_some()` from `.claude.json`'s `oauthAccount`. A Bedrock or
  OpenRouter profile has no email, so `canChat()` blocks it.
- yaah ignores claude-agent-acp's `_auth/status_update`, which reports `{kind: external|gateway|api_key}`. That's the
  right signal.
- Non-Claude presets only become "not logged in" after an ACP `-32000`, so env-configured agents already count as ready.

## Agent × provider × mechanism

| Agent | Bedrock | OpenRouter | Per-process isolation | Ready without sign-in |
|---|---|---|---|---|
| **Claude Code** | Native: `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, plus `AWS_PROFILE` (SSO ok) / `AWS_BEARER_TOKEN_BEDROCK` / access keys; model through `ANTHROPIC_MODEL` or `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` (e.g. `us.anthropic.claude-sonnet-4-6`) | Anthropic-compatible: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=sk-or-…`, `ANTHROPIC_API_KEY=""`, model `anthropic/claude-…`; or `providers/set` (UNVERIFIED picker behaviour) | `CLAUDE_CONFIG_DIR` | Adapter: yes. yaah: no (the email check) |
| **Goose** (`goose acp`) | Native (AWS SDK chain): `GOOSE_PROVIDER=aws_bedrock`, `GOOSE_MODEL=us.…` (no automatic prefixing), `AWS_PROFILE`/`AWS_REGION` or a bearer key | `GOOSE_PROVIDER=openrouter`, `OPENROUTER_API_KEY` | `GOOSE_PATH_ROOT`, `GOOSE_DISABLE_KEYRING=1` | Yes; provider/model as session config options |
| **OpenCode v2** (`opencode acp`) | Native `amazon-bedrock` (profile, keys or bearer; Converse with caching); use a prefixed id | `OPENROUTER_API_KEY`, `openrouter/…` | `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR` (a saved credential beats env) | Yes |
| **Codex** | Native, **OpenAI models only** (`amazon-bedrock-runtime` / `amazon-bedrock`) | Custom provider in `config.toml` (`wire_api="responses"`, `env_key`) | **Needs a per-profile `CODEX_HOME`** | Yes with `CODEX_HOME` |
| **Copilot CLI** | Not native; Bedrock API key against the OpenAI-compatible route (GPT/open-weight) | `COPILOT_PROVIDER_*`, `COPILOT_MODEL`, `COPILOT_OFFLINE=true` | `COPILOT_HOME` | Yes (≥1.0.89) |
| **Qwen Code** | Not native (UNVERIFIED anthropic-route workaround) | `OPENAI_API_KEY/BASE_URL/MODEL`, `--auth-type openai` | `QWEN_HOME` | Likely |
| **Cline** | Native and richest (profile/SSO, prefixing, caching); settings only in `providers.json` | `CLINE_PROVIDER=openrouter`, `CLINE_API_KEY` | `CLINE_DIR`, `CLINE_PROVIDER_SETTINGS_PATH` | Only with `CLINE_API_KEY` set |
| Gemini, Auggie, Cursor, Kiro, Kimi | No (or vendor-only) | No | — | Vendor login |
| Kilo (OpenCode v1 fork) | Native with **automatic prefixing** | Yes | `KILO_CONFIG_CONTENT`, `KILO_AUTH_CONTENT` | Yes |

## OpenRouter
- **APIs:** OpenAI Chat `/api/v1/chat/completions` and Responses `/api/v1/responses` (stateless). Anthropic Messages is at
  `/api/v1/messages` (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`). It's strict about thinking-block signatures; Claude
  Code is only guaranteed on Anthropic upstreams.
- **Key check:** `GET /api/v1/key` (Bearer) returns label, limit, remaining, usage and free tier; 401 when bad.
- **Models:** `GET /api/v1/models?supported_parameters=tools` returns id, context, pricing and parameters.
- **Limits:**
  - `:free` models: 20 RPM and 50 or 1000 per day;
  - 402 carries `limit_source`, and 429 carries `X-RateLimit-*`;
  - **a mid-stream error arrives as an SSE `finish_reason:"error"`**, not as an HTTP status.
- **Attribution headers:** `HTTP-Referer`, `X-OpenRouter-Title`.

## Bedrock
- **Auth:**
  - an AWS profile (SSO, `aws login`);
  - access keys;
  - **Bedrock API keys** (`AWS_BEARER_TOKEN_BEDROCK`; short-term ≤12 h, long-term until a set expiry). These work on
    Bedrock and Bedrock Runtime actions only, not STS.
- **Endpoints:** `bedrock-runtime` (Invoke, Converse, plus OpenAI `/openai/v1` and Anthropic `/anthropic`) and
  `bedrock-mantle` (OpenAI and Anthropic, with `/v1/models`).
- **Which API each agent uses:** Claude Code uses Invoke; Goose, OpenCode and Cline use Converse; Codex uses Responses.
- **Listing:** `GET /foundation-models` and `GET /inference-profiles` on `bedrock.{region}`. Offer inference-profile ids
  (`us.`, `eu.`, `apac.`, `global.`…), since newer Claude models are profile-only.
- **Without a new crate:**
  - a bearer key: plain `reqwest` (S);
  - access keys: hand-written SigV4 with `sha2` plus `hmac` (already in the lockfile) (S–M);
  - a profile or SSO: the `aws` CLI (`sts get-caller-identity`, `bedrock list-inference-profiles`), about 0.5–1 s per call.
  - The full AWS SDK is too heavy.
- **Gotchas:**
  - Anthropic models need a one-time use-case form per account;
  - caching varies by model and region;
  - there's no WebSearch on Bedrock;
  - Codex on Bedrock is GPT-only;
  - Goose and OpenCode need prefixed ids.

## Recommended design
- **Data model:** `~/.config/yaah/providers.json` (0600) holds providers: OpenRouter {key}, and Bedrock {region, auth:
  profile|apiKey|accessKeys|ambient, prefix}. Each agent profile gets an optional **binding** {provider, model,
  small model}, translated **at spawn** and never written into the profile's env.
- **Per-agent translation:** one `route(preset, provider, binding)` function per preset returns env, env removals, files
  to write (e.g. Codex `config.toml` in a per-profile `CODEX_HOME`) and/or a `providers/set` call. Unsupported presets
  hide the picker and say why.
- **Settings:**
  - Settings → Model providers: Add OpenRouter (key) and Add Bedrock (region; an AWS profile picked from `~/.aws/config`,
    an API key or access keys), each with Test.
  - The agent form gets a "Model provider" control and a model picker.
- **Readiness:** a validated binding counts as ready, and so does `_auth/status_update` `kind ∈ {external, gateway,
  api_key}`. `-32000` stays the backstop.
- **Model listing:** OpenRouter tool-capable models (cached for a day); Bedrock inference profiles plus foundation models,
  filtered per agent.
- **Security:** pass secrets only to the process that needs them. An agent's shell can read its env, so prefer:
  - Bedrock profile mode (only `AWS_PROFILE`/`AWS_REGION`);
  - credential-helper commands (Claude `apiKeyHelper`/`awsCredentialExport`, Codex `auth.command`, Copilot
    `…_API_KEY_COMMAND`) that call a `yaah credential` helper;
  - short-term Bedrock keys minted from a profile.
- **Conformance:** a Tier A "provider mode" against a local `tiny_http` stub speaking OpenAI, Anthropic and OpenRouter.
  It checks `session/new` without `-32000`, one prompt with a tool call, that the model id reached the stub, and that no
  secrets appear in argv. Native Bedrock SigV4 is covered only in Tier B (live).
- **Order:**
  1. Claude Code (only blocked today by the readiness check);
  2. Goose;
  3. OpenCode v2;
  4. Codex;
  5. Copilot, Qwen, Cline;
  6. then Kilo.

  Goose and OpenCode would need managed binary installs from the registry, with sha256 checks.

## Effort
| Piece | Size |
|---|---|
| Readiness fix | S |
| Providers store, Settings and the binding | M |
| OpenRouter checks and model listing | S |
| Bedrock checks and model listing | M |
| Claude, Goose and OpenCode translation | M |
| Codex, Copilot, Qwen and Cline translation | M |
| The `providers/set` and gateway path | S–M |
| Stub conformance | M |
| Managed binary installs | M |

Overall L. A first slice (Claude, Goose and OpenCode, with both providers) is about M.
