// Settings → Agents (ACP), and the first-run screen: pick a preset (or a saved
// agent), edit its command and env, test the connection, log in, and choose
// the default. Rust builds the preset commands, detects what's installed, and
// runs the test; this only shows it.
import { useEffect, useState } from "react";
import { AlertTriangle, Check, CircleCheck, ExternalLink, Loader2, LogIn, Plug, Plus, Star, Terminal, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { fromPairs, toPairs, useAction, type Pair } from "@/components/settings/form-state";
import { ErrorAlert, Field, NavHeading, NavNote, NavRow, Pairs, PanelHeader, RemoveButton, TwoPane } from "@/components/settings/parts";
import { api, type AgentDraft, type AgentPreset, type AgentProfile, type AgentReport } from "@/lib/api";
import { compactPath } from "@/lib/format";
import { openExternal } from "@/lib/links";

/** What the Agents tab opens on: adding one, or a saved agent (the default one when no id). */
export type AgentTarget = { kind: "add" } | { kind: "manage"; id?: string };

type Selected = { kind: "profile"; id: string } | { kind: "preset"; id: string };

export type AgentsProps = {
  agents: AgentProfile[];
  defaultId: string | null;
  target: AgentTarget;
  onLogin: (agent: AgentProfile) => void;
  /** A new agent was saved (the first one, on first run). */
  onSaved?: (agent: AgentProfile) => void;
};

const draftOf = (p: AgentProfile): AgentDraft => ({
  id: p.id,
  label: p.label,
  preset: p.preset,
  commandLine: p.commandLine,
  env: { ...p.env },
  configDir: p.configDir ?? null,
});

const SECRET = /key|token|secret|password/i;

export function AgentsSettings({ agents, defaultId, target, onLogin, onSaved }: AgentsProps) {
  const [presets, setPresets] = useState<AgentPreset[] | null>(null);
  const [picked, setPicked] = useState<Selected | null>(null);

  useEffect(() => {
    api.listAgentPresets().then(setPresets, console.error);
  }, []);

  // Until something is picked: the requested agent, the first saved one, or the first installed preset.
  const wanted = target.kind === "manage" ? (agents.find((a) => a.id === target.id) ?? agents[0]) : undefined;
  const firstPreset = presets?.find((p) => p.via === "binary" && p.id !== "custom") ?? presets?.[0];
  const selected: Selected | null =
    picked ?? (wanted ? { kind: "profile", id: wanted.id } : firstPreset ? { kind: "preset", id: firstPreset.id } : null);

  const profile = selected?.kind === "profile" ? agents.find((a) => a.id === selected.id) : undefined;
  const preset = presets?.find((p) => p.id === (selected?.kind === "preset" ? selected.id : profile?.preset));
  const draft = profile ? draftOf(profile) : selected?.kind === "preset" ? preset?.draft : undefined;

  return (
    <TwoPane
      label="Agents"
      nav={
        <>
          {agents.length > 0 && (
            <>
              <NavHeading>Your agents</NavHeading>
              {agents.map((a) => (
                <NavRow
                  key={a.id}
                  active={selected?.kind === "profile" && selected.id === a.id}
                  onClick={() => setPicked({ kind: "profile", id: a.id })}
                  label={a.label}
                  hint={a.label === a.presetLabel ? undefined : a.presetLabel}
                  note={[a.id === defaultId && "default", a.loggedIn === false && "needs a login"].filter(Boolean).join(", ") || undefined}
                  end={
                    <>
                      {a.id === defaultId && <Star className="size-3.5 fill-current text-muted-foreground" />}
                      {a.loggedIn === false && <Badge variant="destructive">log in</Badge>}
                    </>
                  }
                />
              ))}
              <Separator className="my-2" />
            </>
          )}
          <NavHeading>Add an agent</NavHeading>
          {!presets && <NavNote loading>Looking for installed agents…</NavNote>}
          {presets?.map((p) => (
            <NavRow
              key={p.id}
              active={selected?.kind === "preset" && selected.id === p.id}
              onClick={() => setPicked({ kind: "preset", id: p.id })}
              label={p.label}
              icon={p.id === "custom" ? <Terminal className="size-3.5 text-muted-foreground" /> : <Plus className="size-3.5 text-muted-foreground" />}
              end={<Via via={p.via} />}
            />
          ))}
        </>
      }
    >
      {selected && draft ? (
        <Editor
          // A fresh form for each agent or preset.
          key={`${selected.kind}:${selected.id}`}
          initial={draft}
          profile={profile}
          preset={preset}
          isDefault={!!profile && profile.id === defaultId}
          onLogin={onLogin}
          onSaved={(saved, isNew) => {
            setPicked({ kind: "profile", id: saved.id });
            if (isNew) onSaved?.(saved);
          }}
          onRemoved={() => setPicked(null)}
        />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">Pick an agent on the left.</p>
      )}
    </TwoPane>
  );
}

/** Whether a preset's agent is here: installed, runnable through npx, or missing. */
function Via({ via }: { via: AgentPreset["via"] }) {
  if (via === "binary") return <Badge variant="secondary">installed</Badge>;
  if (via === "npx") return <Badge variant="outline">npx</Badge>;
  if (via === "missing")
    return (
      <Badge variant="outline" className="text-muted-foreground">
        not found
      </Badge>
    );
  return null;
}

function Editor({
  initial,
  profile,
  preset,
  isDefault,
  onLogin,
  onSaved,
  onRemoved,
}: {
  initial: AgentDraft;
  profile: AgentProfile | undefined;
  preset: AgentPreset | undefined;
  isDefault: boolean;
  onLogin: (agent: AgentProfile) => void;
  onSaved: (agent: AgentProfile, isNew: boolean) => void;
  onRemoved: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial);
  const [env, setEnv] = useState<Pair[]>(() => toPairs(initial.env));
  const [tested, setTested] = useState<AgentReport | null>(null);
  const { busy, failed, run } = useAction<"test" | "save" | "remove" | "default">();
  const current: AgentDraft = { ...draft, env: fromPairs(env) };
  const dirty = JSON.stringify(current) !== JSON.stringify(initial);
  // A fresh test wins; otherwise what the agent said last time it started.
  const report = tested ?? (dirty ? null : (profile?.report ?? null));

  const test = () => void run("test", async () => setTested(await api.testAgent(current)));
  const save = () => void run("save", async () => onSaved(await api.saveAgent(current), !profile));

  return (
    <form
      className="flex flex-col gap-5 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <PanelHeader
        title={profile ? profile.label : preset?.label}
        extra={
          <>
            {isDefault && <Badge variant="secondary">default</Badge>}
            {profile?.email && <Badge variant="outline">{profile.email}</Badge>}
            {preset?.docs && (
              <Button type="button" variant="link" size="sm" className="ml-auto h-auto p-0 text-xs" onClick={() => openExternal(preset.docs)}>
                Docs <ExternalLink />
              </Button>
            )}
          </>
        }
      >
        {preset && <p className="text-sm text-muted-foreground">{preset.blurb}</p>}
        {preset && !profile && <Found preset={preset} />}
        {profile && !profile.installed && (
          <p className="text-sm text-muted-foreground">
            <code>{profile.command}</code> isn't on your PATH.{preset?.install && ` ${preset.install}`}
          </p>
        )}
      </PanelHeader>

      <div className="grid gap-4">
        <Field id="agent-label" label="Name">
          <Input id="agent-label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        </Field>
        <Field id="agent-command" label="Command" hint="The agent must speak ACP on stdin/stdout. Quote words that contain spaces.">
          <Input
            id="agent-command"
            className="font-mono [font-feature-settings:'calt'_0,'liga'_0] text-xs [font-variant-ligatures:none]"
            value={draft.commandLine}
            placeholder="my-agent --acp"
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, commandLine: e.target.value })}
          />
        </Field>
        {draft.preset === "claude" && (
          <Field id="agent-config" label="Claude config folder" hint="Each folder is a separate Claude login. Empty uses Claude Code's default.">
            <Input
              id="agent-config"
              className="font-mono text-xs"
              value={draft.configDir ? compactPath(draft.configDir) : ""}
              placeholder="~/.claude"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, configDir: e.target.value || null })}
            />
          </Field>
        )}
        <Pairs
          legend="Environment"
          keyLabel="Variable name"
          keyPlaceholder="NAME"
          addLabel="Add variable"
          rows={env}
          onChange={setEnv}
          secret={(name) => SECRET.test(name)}
          note="Stored only on this machine, in ~/.config/yaah/agents.json."
        />
      </div>

      {failed && (
        <ErrorAlert
          title={failed.during === "test" ? "The agent didn't start" : failed.during === "save" ? "Couldn't save" : "Something went wrong"}
          error={failed.error}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Labels stay put while busy: a button that changes width shoves its neighbours mid-fade,
            and WebKit then leaves a ghost of the old one behind. Progress goes in the status line. */}
        <Button type="button" variant="outline" onClick={test} disabled={busy !== null || !draft.commandLine.trim()}>
          {busy === "test" ? <Loader2 className="animate-spin" /> : <Plug />}
          Test connection
        </Button>
        <Button type="submit" disabled={busy !== null || !draft.label.trim() || !draft.commandLine.trim() || (!!profile && !dirty)}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />}
          {profile ? "Save changes" : "Add agent"}
        </Button>
        {profile && (
          <>
            <Button type="button" variant="outline" onClick={() => onLogin(profile)} disabled={busy !== null}>
              <LogIn /> Log in…
            </Button>
            {!isDefault && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void run("default", () => api.setDefaultAgent(profile.id))}
              >
                <Star /> Make default
              </Button>
            )}
            <RemoveButton
              name={profile.label}
              disabled={busy !== null}
              onRemove={() =>
                void run("remove", async () => {
                  await api.removeAgent(profile.id);
                  onRemoved();
                })
              }
            />
          </>
        )}
      </div>
      {busy === "test" && (
        <p className="-mt-2 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3 animate-spin" /> Starting the agent and asking what it supports. An agent run through npx can take a minute the
          first time.
        </p>
      )}

      {report && <ReportCard report={report} fresh={!!tested} />}
    </form>
  );
}

function Found({ preset }: { preset: AgentPreset }) {
  if (preset.via === "binary" && preset.path) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" /> Found at <code className="text-xs">{compactPath(preset.path)}</code>
      </p>
    );
  }
  if (preset.via === "npx") return <p className="text-sm text-muted-foreground">Not installed; runs through npx and downloads on first use.</p>;
  if (preset.via === "missing") return <p className="text-sm text-muted-foreground">Not found on your PATH. {preset.install}</p>;
  return null;
}

/** What `initialize` returned: who the agent is and what it can do in yaah. */
function ReportCard({ report, fresh }: { report: AgentReport; fresh: boolean }) {
  const name = report.title ?? report.name ?? "The agent";
  const when = new Date(report.checkedAt * 1000).toLocaleString();
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Connection test result">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <CircleCheck className="size-4 translate-y-0.5 self-start text-emerald-600 dark:text-emerald-400" />
        <h3 className="text-sm font-medium">
          {name}
          {report.version && <span className="font-normal text-muted-foreground"> {report.version}</span>}
        </h3>
        <span className="text-xs text-muted-foreground">
          ACP v{report.protocolVersion ?? "?"} · {fresh ? "just now" : `last started ${when}`}
        </span>
      </div>

      {!report.compatible && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Unsupported protocol version</AlertTitle>
          <AlertDescription>yaah speaks ACP v1; this agent answered v{report.protocolVersion ?? "?"}. Chats with it won't start.</AlertDescription>
        </Alert>
      )}
      {report.compatible && !report.mcpHttp && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>No UI tools in its chats</AlertTitle>
          <AlertDescription>
            This agent can't connect to HTTP MCP servers, so it can't render forms, tables and charts in the chat. Chatting works as usual.
          </AlertDescription>
        </Alert>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <Cap label="UI tools (HTTP MCP)" ok={report.mcpHttp} />
        <Cap label="Reopen earlier chats" ok={report.loadSession} />
        <Cap label="Projects with several folders" ok={report.additionalDirs} />
        <Cap label="Project brief sent inline" ok={report.embeddedContext} />
        <Cap label="Images in prompts" ok={report.image} />
      </dl>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Login methods</span>
        {report.authMethods.length === 0 ? (
          <p className="text-sm text-muted-foreground">None offered: it uses its own config or environment.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {report.authMethods.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span>{m.name}</span>
                <Badge variant="outline">{m.kind === "env_var" ? m.vars.join(", ") || "env" : m.kind}</Badge>
                {m.description && <span className="text-xs text-muted-foreground">{m.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Cap({ label, ok }: { label: string; ok: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1">
        {ok ? <Check className="size-4 text-emerald-600 dark:text-emerald-400" /> : <X className="size-4 text-muted-foreground" />}
        <span className={ok ? undefined : "text-muted-foreground"}>{ok ? "yes" : "no"}</span>
      </dd>
    </>
  );
}
