// Settings → Agents (ACP), and the first-run screen: pick a preset (or a saved
// agent), edit its command and env, test the connection, log in, and choose
// the default. Rust builds the preset commands, detects what's installed, and
// runs the test; this only shows it.
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleCheck,
  ExternalLink,
  Loader2,
  Lock,
  LockOpen,
  LogIn,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Star,
  Terminal,
  X,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { fromPairs, toPairs, useAction, type Pair } from "@/components/settings/form-state";
import { ModelPicker } from "@/components/settings/model-picker";
import { NewChatDefaults } from "@/components/settings/agent-config-defaults";
import { ErrorAlert, Field, NavHeading, NavNote, NavRow, Pairs, PanelHeader, RemoveButton, TwoPane } from "@/components/settings/parts";
import {
  api,
  events,
  needsProviderFix,
  PROVIDER_KINDS,
  providerKindsOf,
  providersApi,
  type AgentDraft,
  type AgentPreset,
  type AgentProfile,
  type AgentReport,
  type ConformanceReport,
  type ProviderBinding,
  type ProviderInfo,
  type ProviderModel,
} from "@/lib/api";
import { openSettings } from "@/lib/app-events";
import { compactPath, formatAgo } from "@/lib/format";
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
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);

  useEffect(() => {
    api.listAgentPresets().then(setPresets, console.error);
    const load = () => providersApi.list().then(setProviders, console.error);
    void load();
    const off = events.providersChanged(() => void load());
    return () => void off.then((f) => f());
  }, []);

  // Until something is picked: the requested agent, the first saved one, or the first installed preset.
  const wanted = target.kind === "manage" ? (agents.find((a) => a.id === target.id) ?? agents[0]) : undefined;
  const firstPreset = presets?.find((p) => p.via === "binary" || p.via === "installed") ?? presets?.[0];
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
                  note={
                    [
                      a.id === defaultId && "default",
                      needsProviderFix(a) ? "its model provider's check failed" : a.loggedIn === false && "needs a login",
                    ]
                      .filter(Boolean)
                      .join(", ") || undefined
                  }
                  end={
                    <>
                      {a.id === defaultId && <Star className="size-3.5 fill-current text-muted-foreground" />}
                      {a.loggedIn === false && <Badge variant="destructive">{needsProviderFix(a) ? "fix provider" : "log in"}</Badge>}
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
          agents={agents}
          providers={providers}
          onPresets={setPresets}
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

/** Whether a preset's agent is here: installed (on PATH or by yaah), runnable through npx, or missing. */
function Via({ via }: { via: AgentPreset["via"] }) {
  if (via === "binary" || via === "installed") return <Badge variant="secondary">installed</Badge>;
  if (via === "npx") return <Badge variant="outline">npx</Badge>;
  if (via === "download") return <Badge variant="outline">downloads</Badge>;
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
  agents,
  providers,
  onPresets,
  isDefault,
  onLogin,
  onSaved,
  onRemoved,
}: {
  initial: AgentDraft;
  profile: AgentProfile | undefined;
  preset: AgentPreset | undefined;
  agents: AgentProfile[];
  providers: ProviderInfo[] | null;
  onPresets: (presets: AgentPreset[]) => void;
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
  // yaah picks the version only when the agent runs from its npm package (not a binary on PATH, not a custom command).
  const fromNpm = !!preset?.pinned && /^(\S*\/)?npx (-y|--yes) /.test(initial.commandLine);

  // The model provider it runs on (null: the agent's own sign-in). Stored apart from the draft (`set_profile_provider`).
  const savedBinding = profile?.provider ?? null;
  const [binding, setBinding] = useState<ProviderBinding | null>(savedBinding);
  const bindingDirty = JSON.stringify(binding) !== JSON.stringify(savedBinding);
  // The name yaah last suggested ("Goose · Bedrock"), replaced while the user hasn't typed their own.
  const [suggested, setSuggested] = useState<string | null>(null);
  const pickBinding = (next: ProviderBinding | null) => {
    setBinding(next);
    if (profile || (draft.label !== initial.label && draft.label !== suggested)) return;
    const kind = providers?.find((p) => p.id === next?.providerId)?.kind;
    const name = next && kind ? `${shortName(preset?.label ?? draft.label)} · ${PROVIDER_KINDS.find((k) => k.kind === kind)?.label}` : initial.label;
    setSuggested(name);
    setDraft((d) => ({ ...d, label: name }));
  };

  const test = () => void run("test", async () => setTested(await api.testAgent(current)));
  const save = () =>
    void run("save", async () => {
      let saved = profile && !dirty ? profile : await api.saveAgent(current);
      if (bindingDirty) saved = await providersApi.setProfileProvider(saved.id, binding);
      onSaved(saved, !profile);
    });

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
            {(profile?.detail ?? profile?.email) && <Badge variant="outline">{profile.detail ?? profile.email}</Badge>}
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
        <ProviderChoice
          preset={draft.preset}
          presetLabel={preset?.label ?? profile?.presetLabel ?? "This agent"}
          kinds={providerKindsOf(draft.preset, preset ? [preset] : null)}
          providers={providers}
          binding={binding}
          onChange={pickBinding}
        />
        {fromNpm && preset && <Versions preset={preset} agents={agents} onPresets={onPresets} />}
        {profile && <NewChatDefaults key={profile.id} profile={profile} />}
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
        <Button
          type="submit"
          disabled={
            busy !== null ||
            !draft.label.trim() ||
            !draft.commandLine.trim() ||
            (!!profile && !dirty && !bindingDirty) ||
            (!!binding && !binding.model)
          }
        >
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />}
          {profile ? "Save changes" : "Add agent"}
        </Button>
        {profile && (
          <>
            {/* On a model provider there's no login of its own: a failed check is fixed in Model providers. */}
            {!profile.provider ? (
              <Button type="button" variant="outline" onClick={() => onLogin(profile)} disabled={busy !== null}>
                <LogIn /> Log in…
              </Button>
            ) : (
              needsProviderFix(profile) && (
                <Button type="button" variant="outline" onClick={() => onLogin(profile)} disabled={busy !== null}>
                  <AlertTriangle /> Fix in Settings → Model providers
                </Button>
              )
            )}
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
          <Loader2 className="size-3 animate-spin" /> Starting the agent and asking what it supports. The first start of an npm-based agent goes
          through npx and can take a minute; yaah installs it meanwhile, so later starts are quick.
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
  if (preset.via === "installed" && preset.path) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" /> Installed by yaah at{" "}
        <code className="text-xs">{compactPath(preset.path)}</code>. Installed once, it starts directly with Node.
      </p>
    );
  }
  if (preset.via === "npx")
    return (
      <p className="text-sm text-muted-foreground">
        Not installed yet. Its first start runs through npx while yaah installs it once; later starts run it directly with Node.
      </p>
    );
  if (preset.via === "download") return <p className="text-sm text-muted-foreground">Not on your PATH. {preset.install}</p>;
  if (preset.via === "missing") return <p className="text-sm text-muted-foreground">Not found on your PATH. {preset.install}</p>;
  return null;
}

/** "Claude Code" → "Claude", "goose" → "Goose": the start of a suggested profile name. */
const shortName = (presetLabel: string) => {
  const s = presetLabel.replace(/ Code$/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const OWN = "own";

/**
 * Where the agent gets its model: its own sign-in, or one of your model providers
 * (Settings → Model providers) with a model picked from what the provider offers it.
 */
function ProviderChoice({
  preset,
  presetLabel,
  kinds,
  providers,
  binding,
  onChange,
}: {
  preset: string;
  presetLabel: string;
  kinds: string[];
  providers: ProviderInfo[] | null;
  binding: ProviderBinding | null;
  onChange: (b: ProviderBinding | null) => void;
}) {
  const [models, setModels] = useState<{ providerId: string; list: ProviderModel[] } | null>(null);
  const [failed, setFailed] = useState<{ providerId: string; error: unknown } | null>(null);
  const providerId = binding?.providerId ?? null;

  useEffect(() => {
    if (!providerId) return;
    let live = true;
    providersApi.models(providerId, preset).then(
      (r) => live && setModels({ providerId, list: r.models }),
      (error: unknown) => live && setFailed({ providerId, error }),
    );
    return () => {
      live = false;
    };
  }, [providerId, preset]);

  if (kinds.length === 0)
    return (
      <div className="flex flex-col gap-1.5" role="group" aria-label="Model provider">
        <span className="text-sm font-medium">Model provider</span>
        <p className="text-sm text-muted-foreground">{presetLabel} can't use Bedrock or OpenRouter: it runs on its own sign-in.</p>
      </div>
    );

  const usable = providers?.filter((p) => kinds.includes(p.kind)) ?? [];
  const chosen = usable.find((p) => p.id === providerId);
  const list = models?.providerId === providerId ? models.list : null;
  const error = failed?.providerId === providerId ? failed.error : null;
  const kindNames = (k: string) => PROVIDER_KINDS.find((x) => x.kind === k)?.label ?? k;

  return (
    <div className="flex flex-col gap-4">
      <Field
        id="agent-provider"
        label="Model provider"
        hint="yaah hands the agent its provider and model when it starts; nothing goes into its environment below."
      >
        <Select
          value={providerId ?? OWN}
          onValueChange={(v) =>
            onChange(v === OWN ? null : { providerId: v, model: v === providerId ? (binding?.model ?? "") : "", smallModel: null })
          }
        >
          <SelectTrigger id="agent-provider" className="w-full sm:w-80" aria-label="Model provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={OWN}>The agent's own sign-in</SelectItem>
            {usable.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span>{p.label}</span>
                <span className="text-xs text-muted-foreground in-data-[slot=select-value]:hidden">{kindNames(p.kind)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {providers && usable.length === 0 && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Run it on your own Bedrock or OpenRouter account:{" "}
          <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => openSettings("providers")}>
            add one in Settings → Model providers
          </Button>
          .
        </p>
      )}
      {chosen && chosen.check && !chosen.check.ok && (
        <p className="-mt-2 flex items-center gap-1.5 text-xs text-destructive" role="status">
          <AlertTriangle className="size-3.5" /> Its last check failed.{" "}
          <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => openSettings("providers")}>
            Fix in Settings → Model providers
          </Button>
        </p>
      )}
      {binding && (
        <>
          {error != null && <ErrorAlert title="Couldn't list the provider's models" error={error} />}
          <ModelPicker
            id="agent-model"
            label="Model"
            hint={preset === "claude" ? "Claude Code runs Anthropic models only." : "Models that can call tools, which agents need."}
            models={list}
            loading={!list && error == null}
            value={binding.model || null}
            onChange={(model) => onChange({ ...binding, model: model ?? "" })}
          />
          {preset === "claude" && (
            <ModelPicker
              id="agent-small-model"
              label="Small, fast model (optional)"
              hint="For Claude Code's quick background work."
              models={list}
              loading={!list && error == null}
              value={binding.smallModel ?? null}
              none="None: Claude Code's default"
              onChange={(smallModel) => onChange({ ...binding, smallModel })}
            />
          )}
        </>
      )}
    </div>
  );
}

const STATUS: Record<NonNullable<AgentPreset["activeStatus"]>, string> = {
  tested: "tested",
  verified: "verified",
  verifying: "being checked",
  installed: "not checked",
  failed: "failed its checks",
};

/**
 * Which version of an npm-based agent runs. yaah keeps it current itself: a newer
 * version runs only once it passes yaah's checks, and the user can hold it at one.
 */
function Versions({ preset, agents, onPresets }: { preset: AgentPreset; agents: AgentProfile[]; onPresets: (p: AgentPreset[]) => void }) {
  const { busy, failed, run } = useAction<"check" | "hold" | "restart" | "verify">();
  // Which version "Verify now" is running on.
  const [verifying, setVerifying] = useState<string | null>(null);
  // Agents still running the old version after a change, until the user says restart or later.
  const [restart, setRestart] = useState<{ ids: string[]; from: string; version: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { active, activeStatus, candidate, latest, held } = preset;
  if (!active) return null;
  const npmPage = `https://www.npmjs.com/package/${preset.package}`;
  const onNpm = latest && latest.latest !== active && latest.latest !== candidate?.version ? latest.latest : null;
  const names = (ids: string[]) => ids.map((id) => agents.find((a) => a.id === id)?.label ?? id).join(", ");

  const hold = (version: string | null) =>
    void run("hold", async () => {
      const { presets, running } = await api.holdAgentVersion(preset.id, version);
      onPresets(presets);
      setNote(null);
      const now = presets.find((p) => p.id === preset.id)?.active;
      if (!now || now === active) return;
      if (running.length > 0) setRestart({ ids: running, from: active, version: now });
      else setNote(`v${now} runs from the agent's next start.`);
    });

  const verify = (version: string) =>
    void run("verify", async () => {
      setVerifying(version);
      setNote(null);
      try {
        const { report, presets } = await api.verifyAgentVersion(preset.id, version);
        onPresets(presets);
        if (report.promoted) setNote(`v${version} passed yaah's checks and runs from the agent's next start.`);
      } finally {
        setVerifying(null);
      }
    });

  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4" aria-label="Version">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">
          v{active} · {STATUS[activeStatus ?? "tested"]}
        </span>
        {held && (
          <Badge variant="outline">
            <Lock /> held
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => openExternal(npmPage)}>
            npm page <ExternalLink />
          </Button>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {held
          ? `Held: yaah stays on v${active} even when a newer version passes its checks.`
          : `yaah runs the version it was tested with (v${preset.pinned}) and moves to a newer one only after that version passes yaah's checks.`}
      </p>
      <Checks report={preset.report} label={`v${active}`} />

      {preset.advisories.length > 0 && (
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertTitle>Security advisories for v{active}</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {preset.advisories.map((a) => (
                <li key={a.id}>
                  <Badge variant="outline">{a.severity}</Badge>{" "}
                  <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => openExternal(a.url)}>
                    {a.title} <ExternalLink />
                  </Button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {candidate && (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-1.5 text-sm" role="status">
            {candidate.status === "verifying" && (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Checking v{candidate.version}…
              </>
            )}
            {candidate.status === "installed" && <>v{candidate.version} is downloaded and runs once it passes yaah's checks.</>}
            {candidate.status === "verified" && <>v{candidate.version} passed yaah's checks. Release the hold to use it.</>}
            {candidate.status === "failed" && (
              <>
                <AlertTriangle className="size-3.5 text-destructive" /> v{candidate.version} failed: {candidate.failures[0] ?? "no reason recorded"}
              </>
            )}
          </p>
          <Checks report={candidate.report} label={`v${candidate.version}`} />
        </div>
      )}
      {onNpm && <p className="text-sm">v{onNpm} is out on npm. yaah checks it before using it.</p>}

      <div className="flex flex-wrap items-center gap-2">
        {held ? (
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => hold(null)}>
            <LockOpen /> Release hold
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => hold(active)}>
            <Lock /> Hold at this version
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => void run("check", async () => onPresets(await api.checkAgentUpdates()))}
        >
          {busy === "check" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check for updates
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => verify(active)}>
          {verifying === active ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify now
        </Button>
        {candidate && candidate.status !== "verified" && (
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => verify(candidate.version)}>
            {verifying === candidate.version ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Verify v{candidate.version} now
          </Button>
        )}
        <span className="text-xs text-muted-foreground">{latest ? `Checked ${formatAgo(latest.checkedAt)}` : "Not checked yet"}</span>
      </div>

      {restart && (
        <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Restart running agents">
          <span>
            {names(restart.ids)} still {restart.ids.length === 1 ? "runs" : "run"} v{restart.from}. Restart now to use v{restart.version}? A reply in
            progress finishes first.
          </span>
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void run("restart", async () => {
                await api.restartAgents(restart.ids);
                setRestart(null);
                setNote(`Restarted: the next chat starts v${restart.version}.`);
              })
            }
          >
            <RotateCw /> Restart now
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            autoFocus
            onClick={() => {
              setNote(`v${restart.version} runs from the agent's next start.`);
              setRestart(null);
            }}
          >
            Later
          </Button>
        </div>
      )}
      {note && (
        <p className="text-xs text-muted-foreground" role="status">
          {note}
        </p>
      )}
      {verifying && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3 animate-spin" /> Checking v{verifying}: starting it in a throwaway home (no sign-in), checking what yaah relies
          on, then npm audit.
        </p>
      )}
      <LiveTests id={preset.id} />
      {failed && (
        <ErrorAlert
          title={
            failed.during === "check"
              ? "Couldn't check for updates"
              : failed.during === "verify"
                ? "Couldn't verify this version"
                : "Couldn't change the version"
          }
          error={failed.error}
        />
      )}
    </section>
  );
}

/** The conformance suite's last run on a version: one line that opens to every check, then its npm audit. */
function Checks({ report, label }: { report: ConformanceReport | null; label: string }) {
  const [open, setOpen] = useState(false);
  if (!report) return null;
  const failing = report.checks.filter((c) => !c.ok).length;
  const advisories = report.advisories.length;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {report.checks.length > 0 && (
        <button
          type="button"
          className="flex w-fit items-center gap-1.5 text-left hover:text-foreground"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {failing === 0 ? (
            <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <AlertTriangle className="size-3.5 text-destructive" />
          )}
          {label}: {failing === 0 ? `all ${report.checks.length} checks passed` : `${failing} of ${report.checks.length} checks failed`},{" "}
          {formatAgo(report.checkedAt)}
          <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      )}
      {open && (
        <ul className="flex flex-col gap-1 pl-5" aria-label={`Checks on ${label}`}>
          {report.checks.map((c) => (
            <li key={c.name} className="flex gap-1.5">
              {c.ok ? (
                <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <X className="size-3.5 shrink-0 text-destructive" />
              )}
              <span>
                <span className="text-foreground">{c.name}</span> {c.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
      {report.auditedAt != null && (
        <span>
          npm audit {formatAgo(report.auditedAt)}:{" "}
          {advisories === 0 ? "no advisories" : `${advisories} ${advisories === 1 ? "advisory" : "advisories"}`}
        </span>
      )}
      {report.audit === "unavailable" && <span>Couldn't reach the npm registry, so the last audit stands.</span>}
      {report.audit === "error" && <span>npm audit didn't run: {report.auditDetail ?? "no reason given"}</span>}
    </div>
  );
}

/** Tier B of the suite (live prompts with the user's account): prepared in Rust, not switched on yet. */
function LiveTests({ id }: { id: string }) {
  const switchId = `live-tests-${id}`;
  return (
    <div className="flex items-start gap-2 border-t pt-3">
      <Switch id={switchId} checked={false} disabled aria-describedby={`${switchId}-note`} />
      <label htmlFor={switchId} className="flex flex-col gap-0.5 text-sm text-muted-foreground">
        <span className="flex flex-wrap items-center gap-2">
          Verify adapter updates with a live test <Badge variant="outline">coming soon</Badge>
        </span>
        <span id={`${switchId}-note`} className="text-xs">
          Uses your agent's account; a few cheap prompts.
        </span>
      </label>
    </div>
  );
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
