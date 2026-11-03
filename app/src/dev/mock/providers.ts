// Model providers (providers.rs): an OpenRouter key that checks out, and a Bedrock
// provider on an AWS SSO profile whose login expired until "Sign in with AWS SSO"
// runs. Bound agent profiles are ready while their provider's last check passed.
// Messages are the ones providers.rs writes.
import type {
  AgentProfile,
  AwsProfile,
  ProviderBinding,
  ProviderCheck,
  ProviderDraft,
  ProviderInfo,
  ProviderKind,
  ProviderModel,
  ProviderModels,
} from "@/lib/api";
import { need, now, type Mock, type Replies } from "./context";
import type { State } from "./state";

/** What Rust keeps: providers.json, and the key in the keychain. */
type Stored = Omit<ProviderInfo, "hasSecret" | "summary"> & { secret: string | null };

const ACCOUNT = "123456789012";

/** `~/.aws/config`: two SSO profiles (one signed in), a key-based default, and one without a region. */
const AWS_PROFILES: AwsProfile[] = [
  { name: "default", region: "us-east-1", sso: false },
  { name: "work-sso", region: "us-east-1", sso: true },
  { name: "eu-sandbox", region: "eu-west-1", sso: true },
  { name: "personal", region: null, sso: false },
];

const ssoExpiredCheck = (profile: string): ProviderCheck => ({
  ok: false,
  detail: `The AWS SSO login for profile ${profile} has expired. Run \`aws sso login --profile ${profile}\`, then test again.`,
  action: "ssoLogin",
});

export function seedProviders() {
  const providers: Stored[] = [
    {
      id: "openrouter",
      kind: "openrouter",
      label: "OpenRouter",
      checkedAt: now() - 3600,
      check: { ok: true, detail: 'Key "yaah-dev" works · $14.20 of $20.00 left', identity: "yaah-dev" },
      secret: "sk-or-v1-seeded-0000",
    },
    {
      id: "bedrock-work",
      kind: "bedrock",
      label: "Bedrock (work)",
      bedrock: { profile: "work-sso", region: "us-east-1", prefix: "us" },
      checkedAt: now() - 600,
      check: ssoExpiredCheck("work-sso"),
      secret: null,
    },
  ];
  return { providers, awsProfiles: AWS_PROFILES, ssoSignedIn: new Set<string>(["eu-sandbox"]) };
}

const KIND: Record<ProviderKind, string> = { openrouter: "OpenRouter", bedrock: "Bedrock" };

/** What the UI is shown (providers.rs `ProviderInfo`): never the key, only whether there is one. */
function infoOf({ secret, ...p }: Stored): ProviderInfo {
  const summary =
    p.kind === "bedrock" && p.bedrock
      ? `Bedrock · ${p.bedrock.region} · ${p.bedrock.profile}`
      : `${KIND[p.kind]} · ${(p.check?.ok && p.check.identity) || p.label}`;
  return { ...p, hasSecret: secret !== null, summary };
}

/** Two seeded profiles bound to providers: OpenCode on OpenRouter (ready) and Claude on the expired Bedrock. */
export function boundProfiles(): AgentProfile[] {
  const base = { args: [] as string[], env: {}, configDir: null, report: null, email: null, installed: true };
  return [
    {
      ...base,
      id: "opencode-openrouter",
      label: "OpenCode · OpenRouter",
      preset: "opencode",
      command: "opencode",
      args: ["acp"],
      commandLine: "opencode acp",
      presetLabel: "OpenCode",
      loggedIn: null,
      provider: { providerId: "openrouter", model: "anthropic/claude-sonnet-4.5" },
    },
    {
      ...base,
      id: "claude-bedrock",
      label: "Claude · Bedrock",
      preset: "claude",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"],
      commandLine: "npx -y @agentclientprotocol/claude-agent-acp@0.99.1",
      presetLabel: "Claude Code",
      loggedIn: null,
      provider: {
        providerId: "bedrock-work",
        model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        smallModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
    },
  ];
}

/** A profile as `list_agents` reports it (agents.rs `readiness`): a bound one is ready while its provider's last check passed. */
export function withProvider(state: State, p: AgentProfile): AgentProfile {
  if (!p.provider) return p;
  const stored = state.providers.find((x) => x.id === p.provider?.providerId);
  if (!stored) return { ...p, loggedIn: false, email: null, detail: "model provider removed" };
  return { ...p, loggedIn: stored.check ? stored.check.ok : null, email: null, detail: infoOf(stored).summary };
}

const OPENROUTER_MODELS: ProviderModel[] = [
  { id: "anthropic/claude-sonnet-4.5", label: "Anthropic: Claude Sonnet 4.5", contextLength: 1_000_000, tools: true },
  { id: "anthropic/claude-opus-4.1", label: "Anthropic: Claude Opus 4.1", contextLength: 200_000, tools: true },
  { id: "anthropic/claude-haiku-4.5", label: "Anthropic: Claude Haiku 4.5", contextLength: 200_000, tools: true },
  { id: "openai/gpt-5", label: "OpenAI: GPT-5", contextLength: 400_000, tools: true },
  { id: "openai/gpt-5-mini", label: "OpenAI: GPT-5 Mini", contextLength: 400_000, tools: true },
  { id: "google/gemini-2.5-pro", label: "Google: Gemini 2.5 Pro", contextLength: 1_048_576, tools: true },
  { id: "moonshotai/kimi-k2", label: "MoonshotAI: Kimi K2", contextLength: 131_072, tools: true },
  { id: "z-ai/glm-4.6", label: "Z.AI: GLM 4.6", contextLength: 202_752, tools: true },
  { id: "deepseek/deepseek-chat-v3.1", label: "DeepSeek: DeepSeek V3.1", contextLength: 163_840, tools: true },
  { id: "qwen/qwen3-coder:free", label: "Qwen: Qwen3 Coder 480B A35B (free)", contextLength: 262_144, tools: true },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Meta: Llama 3.3 70B Instruct (free)", contextLength: 131_072, tools: true },
];

/** Inference-profile ids first (prefixed), as `list-inference-profiles` gives them; then on-demand foundation models. */
const bedrockModels = (prefix: string): ProviderModel[] => [
  { id: `${prefix}.anthropic.claude-sonnet-4-5-20250929-v1:0`, label: "Claude Sonnet 4.5", contextLength: 200_000, tools: true },
  { id: `${prefix}.anthropic.claude-opus-4-1-20250805-v1:0`, label: "Claude Opus 4.1", contextLength: 200_000, tools: true },
  { id: `${prefix}.anthropic.claude-haiku-4-5-20251001-v1:0`, label: "Claude Haiku 4.5", contextLength: 200_000, tools: true },
  { id: `${prefix}.amazon.nova-pro-v1:0`, label: "Amazon Nova Pro", contextLength: 300_000, tools: true },
  { id: `${prefix}.meta.llama4-maverick-17b-instruct-v1:0`, label: "Llama 4 Maverick 17B Instruct", contextLength: 1_000_000, tools: true },
  { id: "mistral.mistral-large-2407-v1:0", label: "Mistral Large (24.07)", contextLength: 128_000, tools: true },
  { id: "cohere.command-r-plus-v1:0", label: "Command R+", contextLength: 128_000, tools: false },
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "provider";

export function providerReplies(m: Mock): Replies {
  const { state } = m;
  const find = (id: string) =>
    need(
      state.providers.find((p) => p.id === id),
      `no model provider ${id}`,
    );
  // Rust emits both: bound profiles' readiness follows the provider.
  const changed = async () => {
    await m.emit("providers-changed", null);
    await m.emit("accounts-changed", null);
  };

  async function check(p: Stored): Promise<ProviderCheck> {
    if (p.kind === "openrouter") {
      await m.wait(500);
      if (!p.secret?.startsWith("sk-or-")) return { ok: false, detail: "OpenRouter refused the key (401). Check it at openrouter.ai/settings/keys." };
      // The seeded key is a paid one with a $20 limit; a new one is on the free tier, without a limit.
      if (p.secret.includes("seeded")) return { ok: true, detail: 'Key "yaah-dev" works · $14.20 of $20.00 left', identity: "yaah-dev" };
      const label = `sk-or-v1-${p.secret.slice(-3)}`;
      return { ok: true, detail: `Key "${label}" works · no spending limit · free tier`, identity: label };
    }
    await m.wait(700);
    const b = need(p.bedrock, "a Bedrock provider needs an AWS profile");
    const aws = state.awsProfiles.find((x) => x.name === b.profile);
    if (!aws) return { ok: false, detail: `The config profile (${b.profile}) could not be found` };
    if (aws.sso && !state.ssoSignedIn.has(b.profile)) return ssoExpiredCheck(b.profile);
    const arn = aws.sso
      ? `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_Developer_0a1b2c3d4e5f/dev@example.com`
      : `arn:aws:iam::${ACCOUNT}:user/dev`;
    return { ok: true, detail: `Signed in as ${arn} (account ${ACCOUNT}) in ${b.region}`, identity: ACCOUNT };
  }

  async function test(p: Stored): Promise<ProviderInfo> {
    const result = await check(p);
    p.check = result;
    p.checkedAt = now();
    await changed();
    return infoOf(p);
  }

  return {
    list_providers: (): ProviderInfo[] => state.providers.map(infoOf),
    aws_profiles: async (): Promise<AwsProfile[]> => {
      await m.wait(200);
      return state.awsProfiles;
    },
    save_provider: async (d: ProviderDraft): Promise<ProviderInfo> => {
      if (!d.label.trim()) throw new Error("Give the provider a name.");
      const old = d.id ? find(d.id) : undefined;
      if (old && old.kind !== d.kind) throw new Error("A provider's kind can't change; add a new one instead.");
      const secret = d.secret?.trim() || null;
      if (d.kind === "openrouter" && !secret && !old?.secret) throw new Error("Paste your OpenRouter API key.");
      if (d.kind === "bedrock") {
        if (!d.bedrock?.profile.trim()) throw new Error("Pick an AWS profile.");
        if (!d.bedrock.region.trim()) throw new Error("Enter the AWS region, e.g. us-east-1.");
      }
      let id = d.id ?? slug(d.label);
      for (let n = 2; !d.id && state.providers.some((p) => p.id === id); n++) id = `${slug(d.label)}-${n}`;
      const bedrock = d.kind === "bedrock" && d.bedrock ? { ...d.bedrock, region: d.bedrock.region.trim() } : undefined;
      // A new key or another AWS profile or region: the last check no longer says anything.
      const same = old && !secret && JSON.stringify(old.bedrock ?? null) === JSON.stringify(bedrock ?? null);
      const stored: Stored = {
        id,
        kind: d.kind,
        label: d.label.trim(),
        ...(bedrock ? { bedrock } : {}),
        ...(same ? { check: old.check, checkedAt: old.checkedAt } : {}),
        secret: d.kind === "openrouter" ? (secret ?? old?.secret ?? null) : null,
      };
      state.providers = old ? state.providers.map((p) => (p.id === id ? stored : p)) : [...state.providers, stored];
      await changed();
      return infoOf(stored);
    },
    delete_provider: async ({ id }: { id: string }) => {
      const p = find(id);
      const bound = state.profiles.filter((x) => x.provider?.providerId === id).map((x) => x.label);
      if (bound.length)
        throw new Error(
          `"${p.label}" is used by ${bound.join(", ")}. Choose another model provider for ${bound.length === 1 ? "it" : "them"} first.`,
        );
      state.providers = state.providers.filter((x) => x.id !== id);
      await changed();
      return null;
    },
    test_provider: ({ id }: { id: string }) => test(find(id)),
    // `aws sso login` runs in the background; the browser sign-in "finishes" after a moment, then the provider is tested again.
    provider_sso_login: ({ id }: { id: string }) => {
      const p = find(id);
      const profile = need(p.bedrock?.profile, "only Bedrock providers sign in with AWS SSO");
      m.later(1500, () => {
        state.ssoSignedIn.add(profile);
        void test(p).then((provider) => m.emit("provider-sso-login", { id, ok: !!provider.check?.ok, provider }));
      });
      return null;
    },
    provider_models: async ({ id, preset }: { id: string; preset: string }): Promise<ProviderModels> => {
      const p = find(id);
      await m.wait(400);
      const all = p.kind === "openrouter" ? OPENROUTER_MODELS : bedrockModels(p.bedrock?.prefix ?? "us");
      // Claude Code only runs Anthropic models; Goose and OpenCode anything that can call tools.
      const models = preset === "claude" ? all.filter((x) => x.id.includes("anthropic")) : all.filter((x) => x.tools);
      return { models, cachedAt: now() - 1200 };
    },
    set_profile_provider: async ({ accountId, binding }: { accountId: string; binding: ProviderBinding | null }): Promise<AgentProfile> => {
      const p = need(
        state.profiles.find((x) => x.id === accountId),
        `unknown agent ${accountId}`,
      );
      if (binding) {
        const provider = find(binding.providerId);
        if (!["claude", "goose", "opencode"].includes(p.preset)) throw new Error(`${p.presetLabel} can't use ${provider.label}`);
        if (!binding.model) throw new Error("Pick a model.");
      }
      const next: AgentProfile = { ...p, provider: binding };
      if (!binding) delete next.provider;
      state.profiles = state.profiles.map((x) => (x.id === accountId ? next : x));
      await m.emit("accounts-changed", null);
      return withProvider(state, next);
    },
  };
}
