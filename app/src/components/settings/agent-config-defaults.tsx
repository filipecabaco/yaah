// Settings → Agents, "New chats start with": the model and effort a profile's new
// chats are set to, from what its agent offered in its newest chat
// (session/config.rs `agent_defaults`). Saved at once; Rust checks each value.
// A profile on a model provider takes its model from that binding, so only its
// effort has a default here.
import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorText } from "@/components/error-text";
import { api, type AgentConfigDefaults, type AgentProfile, type ConfigOption } from "@/lib/api";

/** The Select value for "no default": the agent's own. */
const AGENTS = "__agent__";
const LABEL: Record<NonNullable<ConfigOption["role"]>, string> = { model: "Model", effort: "Effort" };

export function NewChatDefaults({ profile }: { profile: AgentProfile }) {
  const [state, setState] = useState<AgentConfigDefaults | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let stale = false;
    api.agentConfigDefaults(profile.id).then(
      (d) => !stale && setState(d),
      (e: unknown) => !stale && setError(e),
    );
    return () => {
      stale = true;
    };
  }, [profile.id]);
  if (!state) return error ? <ErrorText error={error} /> : null;

  const set = (id: string, value: string) => {
    setError(null);
    api.setAgentConfigDefault(profile.id, id, value === AGENTS ? null : value).then(setState, setError);
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">New chats start with</legend>
      {state.options.length === 0 ? (
        <p className="text-xs text-muted-foreground">Start a chat with {profile.label} to choose the model and effort its new chats start with.</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          {state.options.map((o) => {
            const role = o.role!;
            const fromProvider = role === "model" && state.providerModel;
            const id = `agent-default-${o.id}`;
            return (
              <div key={o.id} className="flex flex-col gap-1.5">
                {fromProvider ? (
                  <>
                    <span className="text-xs text-muted-foreground">{LABEL[role]}</span>
                    <p className="flex h-8 items-center font-mono text-xs" title="Set by the model provider binding above">
                      {state.providerModel}
                    </p>
                  </>
                ) : (
                  <>
                    <label htmlFor={id} className="text-xs text-muted-foreground">
                      {LABEL[role]}
                    </label>
                    <Select value={state.defaults[o.id] ?? AGENTS} onValueChange={(v) => set(o.id, v)}>
                      <SelectTrigger id={id} className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={AGENTS}>The agent's default</SelectItem>
                        {o.choices.map((c) => (
                          <SelectItem key={c.value} value={c.value}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {state.providerModel
          ? "The model comes from the model provider; a chat can still switch it in its composer."
          : "Each chat can change these in its composer; a chat keeps what it was set to."}
      </p>
      <ErrorText error={error} />
    </fieldset>
  );
}
