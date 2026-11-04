// A chat's model and effort (session/config.rs): what each mock agent offers,
// `set_chat_config` (checked, refused mid-turn, the agent's answer becomes the
// chat's), and Settings → Agents "New chats start with".
//
// Claude profiles offer what claude-agent-acp 0.100 does (mode, model, effort
// whose levels depend on the model, fast mode); OpenCode on OpenRouter a long
// model list (fuzzy search) and variants as effort; Gemini the older `models`.
import type { AgentConfigDefaults, ChatConfig, ConfigChoice, ConfigOption, SessionInfo } from "@/lib/api";
import { need, type Mock, type Replies } from "./context";
import type { State } from "./state";

const select = (id: string, name: string, category: string, current: string, choices: ConfigChoice[], role?: ConfigOption["role"]): ConfigOption => ({
  id,
  name,
  category,
  kind: "select",
  current,
  choices,
  ...(role ? { role } : {}),
});

const named = (values: string[]): ConfigChoice[] => values.map((v) => ({ value: v, name: v.charAt(0).toUpperCase() + v.slice(1) }));

const claudeModels: ConfigChoice[] = [
  { value: "default", name: "Default (recommended)", description: "Opus 4.6 · Most capable for complex work" },
  { value: "opus", name: "Opus 4.6", description: "Most capable for complex work" },
  { value: "sonnet", name: "Sonnet 4.6", description: "Best for everyday tasks" },
  { value: "sonnet[1m]", name: "Sonnet 4.6 (1M context)", description: "For long sessions" },
  { value: "haiku", name: "Haiku 4.5", description: "Fastest for quick answers" },
];
/** Effort levels by model, as Claude Code reports them (haiku has none). */
const claudeEfforts: Record<string, string[]> = {
  default: ["low", "medium", "high", "max"],
  opus: ["low", "medium", "high", "max"],
  sonnet: ["low", "medium", "high"],
  "sonnet[1m]": ["low", "medium", "high"],
};

function claude(model: string, effort: string): ConfigOption[] {
  const levels = claudeEfforts[model];
  return [
    select("mode", "Mode", "mode", "default", named(["default", "acceptEdits", "plan"])),
    select("model", "Model", "model", model, claudeModels, "model"),
    ...(levels
      ? [
          select(
            "effort",
            "Effort",
            "thought_level",
            levels.includes(effort) ? effort : "default",
            [{ value: "default", name: "Default" }, ...named(levels)],
            "effort",
          ),
        ]
      : []),
    select("fast", "Fast mode", "model_config", "off", named(["on", "off"])),
  ];
}

const vendors = ["anthropic", "openai", "google", "meta-llama", "mistralai", "deepseek", "qwen", "x-ai", "moonshotai", "z-ai"];
const families = ["large", "medium", "small", "coder", "vision", "instruct", "reasoner", "flash", "pro", "mini", "nano", "turbo"];
/** About 120 models, as an OpenRouter-backed OpenCode lists them. */
const openRouterModels: ConfigChoice[] = [
  { value: "openrouter/anthropic/claude-sonnet-4.5", name: "openrouter/Claude Sonnet 4.5" },
  { value: "openrouter/anthropic/claude-opus-4.6", name: "openrouter/Claude Opus 4.6" },
  { value: "openrouter/openai/gpt-5.5", name: "openrouter/GPT-5.5" },
  ...vendors.flatMap((v) =>
    families.map((f, i) => ({ value: `openrouter/${v}/${v.split("-")[0]}-${f}-${i + 1}`, name: `openrouter/${v} ${f} ${i + 1}` })),
  ),
];

function opencode(model: string, effort: string): ConfigOption[] {
  const variants = model.includes("claude") || model.includes("gpt") ? ["default", "high", "max"] : [];
  return [
    select("model", "Model", "model", model, openRouterModels, "model"),
    ...(variants.length
      ? [select("effort", "Effort", "thought_level", variants.includes(effort) ? effort : "default", named(variants), "effort")]
      : []),
    select("mode", "Mode", "mode", "build", named(["build", "plan"])),
  ];
}

/** What a profile's agent offers with `model` and `effort` in use; empty for agents without settings. */
function offered(state: State, accountId: string, model?: string, effort?: string): ConfigOption[] {
  const p = state.profiles.find((x) => x.id === accountId);
  if (p?.preset === "opencode")
    return opencode(model ?? (p.provider ? `openrouter/${p.provider.model}` : openRouterModels[0].value), effort ?? "default");
  if (p?.preset === "gemini") {
    const models = [{ value: "auto", name: "Auto (Gemini 2.5)" }, ...named(["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"])];
    return [{ ...select("model", "Model", "model", model ?? "auto", models, "model"), source: "models" }];
  }
  if (p?.preset === "claude" && p.id !== "personal") return claude(model ?? "default", effort ?? "default");
  return [];
}

function find(options: ConfigOption[] | undefined, role: ConfigOption["role"]) {
  return options?.find((o) => o.role === role);
}

/** A new chat's settings: the agent's, then the profile's defaults it offers (a bound profile's model comes from its binding). */
export function initialConfig(state: State, accountId: string): ChatConfig {
  const bound = !!state.profiles.find((p) => p.id === accountId)?.provider;
  const d = state.configDefaults[accountId] ?? {};
  const base = offered(state, accountId);
  const model = !bound && d.model && find(base, "model")?.choices.some((c) => c.value === d.model) ? d.model : undefined;
  const options = offered(state, accountId, model, d.effort ?? d.reasoning_effort);
  const choices: Record<string, string> = {};
  for (const o of options) if (d[o.id] && o.current === d[o.id]) choices[o.id] = o.current;
  return { options, choices };
}

export function seedConfig() {
  return { configDefaults: {} as Record<string, Record<string, string>> };
}

export function configReplies(m: Mock): Replies {
  const { state } = m;
  const defaultsOf = (accountId: string): AgentConfigDefaults => {
    const p = need(
      state.profiles.find((x) => x.id === accountId),
      "unknown agent",
    );
    const newest = Object.values(state.sessions)
      .filter((s) => s.accountId === accountId && s.config?.options?.length)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const options = (newest?.config?.options ?? []).filter((o) => o.role);
    const defaults = { ...(state.configDefaults[accountId] ?? {}) };
    if (p.provider) delete defaults.model;
    return { options, defaults, ...(p.provider ? { providerModel: p.provider.model } : {}) };
  };
  return {
    set_chat_config: async ({ sessionId, configId, value }: { sessionId: string; configId: string; value: string }): Promise<SessionInfo> => {
      const s: SessionInfo = need(state.sessions[sessionId], "unknown session");
      if (s.running) throw new Error("Wait for the turn to end (or stop it) before changing this.");
      const option = need(
        s.config?.options?.find((o) => o.id === configId),
        `This agent doesn't offer a setting called ${configId}.`,
      );
      if (!option.choices.some((c) => c.value === value)) throw new Error(`${value} isn't one of the values the agent offers for ${option.name}.`);
      await m.wait(250);
      const model = configId === "model" ? value : find(s.config?.options, "model")?.current;
      const effort = configId === option.id && option.role === "effort" ? value : find(s.config?.options, "effort")?.current;
      const options = offered(state, s.accountId, model, effort);
      const choices = { ...(s.config?.choices ?? {}), [configId]: value };
      // The picks follow what the agent has now (an effort level the new model lacks goes back to default).
      for (const id of Object.keys(choices)) {
        const now = options.find((o) => o.id === id)?.current;
        if (now) choices[id] = now;
      }
      s.config = { options, choices };
      await m.emit("session-info", s);
      return s;
    },
    agent_config_defaults: ({ accountId }: { accountId: string }) => defaultsOf(accountId),
    set_agent_config_default: ({ accountId, configId, value }: { accountId: string; configId: string; value: string | null }) => {
      const before = defaultsOf(accountId);
      if (value != null) {
        const o = need(
          before.options.find((x) => x.id === configId),
          `This agent doesn't offer a setting called ${configId}.`,
        );
        if (!o.choices.some((c) => c.value === value)) throw new Error(`${value} isn't one of the values the agent offers for ${o.name}.`);
        if (o.role === "model" && before.providerModel)
          throw new Error(`This profile's model comes from its model provider (${before.providerModel}).`);
      }
      const mine = { ...(state.configDefaults[accountId] ?? {}) };
      if (value == null) delete mine[configId];
      else mine[configId] = value;
      state.configDefaults[accountId] = mine;
      return defaultsOf(accountId);
    },
  };
}
