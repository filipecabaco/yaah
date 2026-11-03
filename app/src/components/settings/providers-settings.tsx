// Settings → Model providers: OpenRouter (a key in the OS keychain) and Amazon
// Bedrock (an AWS profile, SSO included), which agent profiles run on instead of
// the agent's own sign-in. Rust stores, checks and translates them per agent
// (docs/research/model-providers-contract.md); this only shows them. A key goes in
// once and never comes back.
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, CircleDashed, Check, KeyRound, Loader2, LogIn, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAction } from "@/components/settings/form-state";
import { ErrorAlert, Field, Page, Section } from "@/components/settings/parts";
import {
  events,
  providersApi,
  ssoExpired,
  type AgentProfile,
  type AwsProfile,
  type BedrockPrefix,
  type ProviderCheck,
  type ProviderInfo,
  type ProviderKind,
} from "@/lib/api";
import { openSettings } from "@/lib/app-events";
import { formatAgo } from "@/lib/format";
import { openExternal } from "@/lib/links";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<ProviderKind, string> = { openrouter: "OpenRouter", bedrock: "Amazon Bedrock" };

const PREFIXES: { value: BedrockPrefix; label: string }[] = [
  { value: "us", label: "us: US regions" },
  { value: "eu", label: "eu: EU regions" },
  { value: "apac", label: "apac: Asia Pacific regions" },
  { value: "global", label: "global: any commercial region" },
];
/** The cross-region prefix a region's inference profiles use (a suggestion; the user can change it). */
const prefixFor = (region: string): BedrockPrefix =>
  region.startsWith("us-") ? "us" : region.startsWith("eu-") ? "eu" : region.startsWith("ap-") ? "apac" : "global";

const OPENROUTER_KEYS = "https://openrouter.ai/settings/keys";
const AWS_CLI = "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html";

export function ProvidersSettings({ agents, initial }: { agents: AgentProfile[]; initial?: string }) {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState<ProviderKind | null>(null);
  // A provider just added: its row tests it once.
  const [fresh, setFresh] = useState<string | null>(null);

  const reload = useCallback(() => providersApi.list().then(setProviders, setError), []);
  useEffect(() => {
    void reload();
    // Tested, signed in or changed elsewhere (another window, a bound profile's save).
    const off = events.providersChanged(() => void reload());
    return () => void off.then((f) => f());
  }, [reload]);

  return (
    <Page>
      <Section
        title="Your providers"
        about={
          <>
            An agent profile on a provider runs on your account there, with the model you pick, instead of the agent's own sign-in. Bind one in{" "}
            <Button variant="link" className="h-auto p-0 text-sm" onClick={() => openSettings("agents")}>
              Settings → Agents (ACP)
            </Button>
            : Goose, OpenCode and Claude Code can use them.
          </>
        }
      >
        {error != null && <ErrorAlert title="Couldn't read your model providers" error={error} />}
        {!providers && error == null && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </p>
        )}
        {providers?.length === 0 && <p className="text-sm text-muted-foreground">None yet. Add OpenRouter or Amazon Bedrock below.</p>}
        {providers && providers.length > 0 && (
          <ul className="flex flex-col gap-3" aria-label="Model providers">
            {providers.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                boundTo={agents.filter((a) => a.provider?.providerId === p.id)}
                highlighted={p.id === initial}
                testNow={p.id === fresh}
                onChanged={reload}
                onTested={() => setFresh(null)}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Add a provider">
        {adding ? (
          <ProviderForm
            kind={adding}
            onCancel={() => setAdding(null)}
            onSaved={(p) => {
              setAdding(null);
              setFresh(p.id);
              void reload();
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setAdding("openrouter")}>
              <Plus /> Add OpenRouter
            </Button>
            <Button variant="outline" onClick={() => setAdding("bedrock")}>
              <Plus /> Add Amazon Bedrock
            </Button>
          </div>
        )}
      </Section>
    </Page>
  );
}

/** One provider: its kind, label and last check, with Test, Edit and Remove. */
function ProviderRow({
  provider: p,
  boundTo,
  highlighted,
  testNow,
  onChanged,
  onTested,
}: {
  provider: ProviderInfo;
  boundTo: AgentProfile[];
  highlighted: boolean;
  /** Just added: test it at once. */
  testNow: boolean;
  onChanged: () => Promise<unknown>;
  onTested: () => void;
}) {
  const { busy, failed, run } = useAction<"test" | "sso" | "remove">();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const check = p.check ?? null;

  const test = useCallback(
    () =>
      void run("test", async () => {
        await providersApi.test(p.id);
        await onChanged();
      }),
    [run, p.id, onChanged],
  );
  // `aws sso login` opens the browser; Rust tests the provider again once the user signed in.
  const signIn = () =>
    void run("sso", async () => {
      await providersApi.ssoLogin(p.id);
      await onChanged();
    });

  useEffect(() => {
    if (!testNow) return;
    onTested();
    test();
  }, [testNow, onTested, test]);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);

  const names = boundTo.map((a) => `“${a.label}”`).join(", ");
  const kindHint = p.kind === "bedrock" && p.bedrock ? `${p.bedrock.profile} · ${p.bedrock.region}` : null;

  return (
    <li ref={ref} aria-label={p.label} className={cn("flex flex-col gap-3 rounded-lg border p-4", highlighted && "border-ring ring-3 ring-ring/30")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.label}</span>
        <Badge variant="secondary">{KIND_LABEL[p.kind]}</Badge>
        {kindHint && <span className="text-xs text-muted-foreground">{kindHint}</span>}
      </div>

      <Status kind={p.kind} check={check} checkedAt={p.checkedAt ?? null} busy={busy} onSignIn={signIn} />
      {check?.ok && (
        <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground" aria-label="Test result">
          {check.detail}
        </p>
      )}

      {boundTo.length > 0 && <p className="text-xs text-muted-foreground">Used by {boundTo.map((a) => a.label).join(", ")}.</p>}

      {failed && (
        <ErrorAlert
          title={
            failed.during === "remove" ? "Couldn't remove it" : failed.during === "sso" ? "The AWS SSO sign-in didn't finish" : "Couldn't test it"
          }
          error={failed.error}
        />
      )}

      {editing ? (
        <ProviderForm
          kind={p.kind}
          provider={p}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void onChanged();
          }}
        />
      ) : confirming ? (
        boundTo.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
            <span>
              {names} {boundTo.length === 1 ? "runs" : "run"} on “{p.label}”. Switch {boundTo.length === 1 ? "it" : "them"} to another provider or
              {boundTo.length === 1 ? " its" : " their"} own sign-in in Settings → Agents (ACP) first.
            </span>
            <Button type="button" variant="ghost" size="sm" autoFocus onClick={() => setConfirming(false)}>
              OK
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            Remove “{p.label}”?{p.kind === "openrouter" && " Its key is deleted from your keychain."}
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void run("remove", async () => {
                  await providersApi.remove(p.id);
                  await onChanged();
                })
              }
            >
              Remove
            </Button>
            <Button type="button" variant="ghost" size="sm" autoFocus onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={test} disabled={busy !== null}>
            {busy === "test" ? <Loader2 className="animate-spin" /> : <Plug />} Test
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={busy !== null}>
            <Pencil /> Edit
          </Button>
          <Button type="button" variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={() => setConfirming(true)}>
            <Trash2 /> Remove
          </Button>
        </div>
      )}
    </li>
  );
}

/** The last check in one line: OK, an expired SSO login (with the way out), a failure, or not yet. */
function Status({
  kind,
  check,
  checkedAt,
  busy,
  onSignIn,
}: {
  kind: ProviderKind;
  check: ProviderCheck | null;
  checkedAt: number | null;
  busy: string | null;
  onSignIn: () => void;
}) {
  if (busy === "sso")
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" /> Waiting for the AWS SSO sign-in in your browser…
      </p>
    );
  if (busy === "test")
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" /> Checking…
      </p>
    );
  if (!check)
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
        <CircleDashed className="size-3.5" /> Not checked yet. Test it to see that it works.
      </p>
    );
  if (check.ok)
    return (
      <p className="flex flex-wrap items-center gap-1.5 text-sm" role="status">
        <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" /> OK
        {check.identity && ` · ${kind === "bedrock" ? "account" : "key"} ${check.identity}`}
        {checkedAt != null && <span className="text-xs text-muted-foreground">checked {formatAgo(checkedAt)}</span>}
      </p>
    );
  if (ssoExpired(check))
    return (
      <Alert role="status">
        <CircleAlert />
        <AlertTitle>Expired SSO login</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <span>{check.detail}</span>
          <Button type="button" size="sm" onClick={onSignIn} disabled={busy !== null}>
            <LogIn /> Sign in with AWS SSO
          </Button>
        </AlertDescription>
      </Alert>
    );
  return (
    <Alert variant="destructive" role="status">
      <CircleAlert />
      <AlertTitle>The check failed</AlertTitle>
      <AlertDescription>{check.detail}</AlertDescription>
    </Alert>
  );
}

/** Add or edit a provider. An OpenRouter key goes to the keychain; a saved one is only ever replaced. */
function ProviderForm({
  kind,
  provider,
  onSaved,
  onCancel,
}: {
  kind: ProviderKind;
  provider?: ProviderInfo;
  onSaved: (p: ProviderInfo) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(provider?.label ?? (kind === "openrouter" ? "OpenRouter" : "Bedrock"));
  const [labelTouched, setLabelTouched] = useState(!!provider);
  const [secret, setSecret] = useState("");
  const [replacing, setReplacing] = useState(!provider?.hasSecret);
  const [profile, setProfile] = useState(provider?.bedrock?.profile ?? "");
  const [region, setRegion] = useState(provider?.bedrock?.region ?? "");
  const [prefix, setPrefix] = useState<BedrockPrefix | null>(provider?.bedrock?.prefix ?? null);
  const { busy, failed, run } = useAction<"save">();
  const id = provider?.id ?? `new-${kind}`;

  const ready = label.trim() !== "" && (kind === "openrouter" ? !replacing || secret.trim() !== "" : profile !== "" && region.trim() !== "");
  const save = () =>
    void run("save", async () => {
      const saved = await providersApi.save({
        id: provider?.id ?? null,
        kind,
        label: label.trim(),
        ...(kind === "bedrock" ? { bedrock: { profile, region: region.trim(), prefix: prefix ?? prefixFor(region.trim()) } } : {}),
        // Omitted: the saved key stays.
        ...(kind === "openrouter" && replacing && secret.trim() ? { secret: secret.trim() } : {}),
      });
      setSecret("");
      onSaved(saved);
    });

  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-4"
      aria-label={provider ? `Edit ${provider.label}` : `Add ${KIND_LABEL[kind]}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save();
      }}
    >
      {!provider && <h4 className="text-sm font-semibold">Add {KIND_LABEL[kind]}</h4>}
      {kind === "openrouter" ? (
        <p className="text-sm text-muted-foreground">
          One API key for models from many labs. yaah keeps the key in your system keychain and hands it only to the agents you run on it.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          yaah uses your AWS profile from <code className="text-xs">~/.aws/config</code>, SSO included, and stores no AWS secrets: agents get the
          profile name and region, and AWS reads your credentials itself. Needs the{" "}
          <Button type="button" variant="link" className="h-auto p-0 text-sm" onClick={() => openExternal(AWS_CLI)}>
            AWS CLI v2
          </Button>
          .
        </p>
      )}

      <Field id={`${id}-label`} label="Name">
        <Input
          id={`${id}-label`}
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            setLabelTouched(true);
          }}
        />
      </Field>

      {kind === "openrouter" &&
        (replacing ? (
          <Field id={`${id}-key`} label="API key" hint="Saved in your system keychain. yaah never shows it again.">
            <div className="flex gap-2">
              <Input
                id={`${id}-key`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                placeholder="sk-or-v1-…"
                value={secret}
                autoFocus={!!provider}
                onChange={(e) => setSecret(e.target.value)}
              />
              {provider?.hasSecret ? (
                <Button type="button" variant="ghost" onClick={() => (setReplacing(false), setSecret(""))}>
                  Keep the saved key
                </Button>
              ) : (
                <Button type="button" variant="link" className="shrink-0 px-1" onClick={() => openExternal(OPENROUTER_KEYS)}>
                  Get a key
                </Button>
              )}
            </div>
          </Field>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <KeyRound className="size-4 text-muted-foreground" />
            <span className="text-muted-foreground">A key is saved in your keychain. It's never shown here.</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
              Replace key
            </Button>
          </div>
        ))}

      {kind === "bedrock" && (
        <BedrockFields
          id={id}
          profile={profile}
          region={region}
          prefix={prefix}
          onProfile={(p) => {
            setProfile(p.name);
            if (p.region) setRegion(p.region);
            if (!labelTouched) setLabel(`Bedrock (${p.name})`);
          }}
          onRegion={setRegion}
          onPrefix={setPrefix}
        />
      )}

      {failed && <ErrorAlert title="Couldn't save it" error={failed.error} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy !== null || !ready}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />}
          {provider ? "Save changes" : "Add provider"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {!provider && <span className="text-xs text-muted-foreground">yaah tests it once it's added.</span>}
      </div>
    </form>
  );
}

/** An AWS profile from ~/.aws (SSO ones marked), its region, and the inference-profile prefix. */
function BedrockFields({
  id,
  profile,
  region,
  prefix,
  onProfile,
  onRegion,
  onPrefix,
}: {
  id: string;
  profile: string;
  region: string;
  prefix: BedrockPrefix | null;
  onProfile: (p: AwsProfile) => void;
  onRegion: (r: string) => void;
  onPrefix: (p: BedrockPrefix) => void;
}) {
  const [profiles, setProfiles] = useState<AwsProfile[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    providersApi.awsProfiles().then(setProfiles, setError);
  }, []);
  // Until picked, the prefix follows the region.
  const shownPrefix = prefix ?? (region.trim() ? prefixFor(region.trim()) : "us");

  return (
    <>
      <Field id={`${id}-aws-profile`} label="AWS profile" hint="From ~/.aws/config and ~/.aws/credentials. yaah reads only the names.">
        {error != null ? (
          <ErrorAlert title="Couldn't read your AWS profiles" error={error} />
        ) : profiles && profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No AWS profiles yet. Run <code className="text-xs">aws configure sso</code> (or <code className="text-xs">aws configure</code>) first.
          </p>
        ) : (
          <Select
            value={profile}
            disabled={!profiles}
            onValueChange={(name) => {
              const p = profiles?.find((x) => x.name === name);
              if (p) onProfile(p);
            }}
          >
            <SelectTrigger id={`${id}-aws-profile`} className="w-full sm:w-80" aria-label="AWS profile">
              <SelectValue placeholder={profiles ? "Pick a profile" : "Reading ~/.aws/config…"} />
            </SelectTrigger>
            <SelectContent>
              {profiles?.map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  <span>{p.name}</span>
                  {p.sso && <Badge variant="outline">SSO</Badge>}
                  {p.region && <span className="text-xs text-muted-foreground in-data-[slot=select-value]:hidden">{p.region}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-region`} label="Region" hint="Prefilled from the profile.">
          <Input
            id={`${id}-region`}
            className="font-mono text-xs"
            placeholder="us-east-1"
            spellCheck={false}
            value={region}
            onChange={(e) => onRegion(e.target.value)}
          />
        </Field>
        <Field id={`${id}-prefix`} label="Inference-profile prefix" hint={`Model ids start with it, e.g. ${shownPrefix}.anthropic.claude-…`}>
          <Select value={shownPrefix} onValueChange={(v) => onPrefix(v as BedrockPrefix)}>
            <SelectTrigger id={`${id}-prefix`} className="w-full" aria-label="Inference-profile prefix">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PREFIXES.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
    </>
  );
}
