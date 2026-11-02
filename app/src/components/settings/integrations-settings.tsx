// Settings → Integrations: the services and databases yaah reads for the user,
// which agents then use through live views (pr-view, linear-board, db-query…).
// Connecting: OAuth with no client secret (GitHub's device
// code, Linear's browser sign-in), or a personal API key. Rust holds every token;
// this screen only ever sees who is connected.
import { useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Copy, Database, ExternalLink, GitPullRequest, KeyRound, Loader2, Plus, SquareKanban, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ErrorText } from "@/components/error-text";
import { connectionReady } from "@/components/settings/form-state";
import { NavHeading, NavNote, NavRow, Panel, PanelHeader, TwoPane } from "@/components/settings/parts";
import { api, type ConnectionInfo, type IntegrationStart, type IntegrationStatus } from "@/lib/api";
import { hostOf, openExternal } from "@/lib/links";
import { cn } from "@/lib/utils";

const ICON: Record<string, ReactNode> = {
  github: <GitPullRequest className="size-3.5 text-muted-foreground" />,
  linear: <SquareKanban className="size-3.5 text-muted-foreground" />,
};

const VIA: Record<string, string> = { oauth: "OAuth", key: "API key", env: "environment variable" };

/** A background sign-in finished (Rust's "integration-changed" event). */
type Outcome = { service: string; ok: boolean; error?: string | null };

const statusText = (s: IntegrationStatus) => (s.needsReauth ? "needs reconnecting" : s.connected ? "connected" : "not connected");

export function IntegrationsSettings({ initial }: { initial?: string }) {
  const [services, setServices] = useState<IntegrationStatus[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState(initial ?? "github");
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  const load = () => {
    api.integrationsStatus().then(setServices, setError);
  };
  useEffect(() => {
    load();
    const off = listen<Outcome>("integration-changed", (e) => {
      setOutcomes((m) => ({ ...m, [e.payload.service]: e.payload }));
      load();
    });
    return () => void off.then((f) => f());
  }, []);

  const current = services?.find((s) => s.id === selected);
  return (
    <TwoPane
      label="Integrations"
      nav={
        <>
          <NavHeading>Services</NavHeading>
          {!services && !error && <NavNote loading>Checking connections…</NavNote>}
          {services?.map((s) => (
            <NavRow
              key={s.id}
              active={selected === s.id}
              onClick={() => setSelected(s.id)}
              icon={ICON[s.id]}
              label={s.label}
              note={statusText(s)}
              end={<StatusDot s={s} />}
            />
          ))}
          <ErrorText error={error} className="px-2 py-1" />
          <Separator className="my-2" />
          <NavHeading>Data</NavHeading>
          <NavRow
            active={selected === "databases"}
            onClick={() => setSelected("databases")}
            icon={<Database className="size-3.5 text-muted-foreground" />}
            label="Databases"
          />
        </>
      }
    >
      {selected === "databases" ? (
        <Databases />
      ) : current ? (
        <ServicePanel key={current.id} s={current} last={outcomes[current.id]} onChanged={load} />
      ) : null}
    </TwoPane>
  );
}

function StatusDot({ s }: { s: IntegrationStatus }) {
  const tone = s.needsReauth ? "bg-amber-500" : s.connected ? "bg-green-600 dark:bg-green-500" : "bg-muted-foreground/30";
  return <span className={cn("size-2 shrink-0 rounded-full", tone)} aria-hidden />;
}

function ServicePanel({ s, last, onChanged }: { s: IntegrationStatus; last?: Outcome; onChanged: () => void }) {
  const [start, setStart] = useState<IntegrationStart | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [key, setKey] = useState("");
  const [copied, setCopied] = useState(false);

  // The background sign-in finished (or failed): stop waiting.
  const [seen, setSeen] = useState(last);
  if (last !== seen) {
    setSeen(last);
    setStart(null);
    setBusy(null);
    if (last && !last.ok) setError(last.error ?? "Couldn't connect.");
  }

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await f();
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy((b) => (b === what ? null : b));
    }
  };

  const copyCode = (code: string) =>
    navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    );

  const connect = () =>
    run("connect", async () => {
      const started = await api.integrationConnect(s.id);
      setStart(started);
      setBusy("waiting");
      // One click: the browser opens on the approval page (GitHub's code already on the clipboard).
      if (started.flow === "browser") openExternal(started.authUrl);
      else {
        await copyCode(started.userCode);
        openExternal(started.verificationUri);
      }
    });

  const saveKey = () => run("key", () => api.integrationSetKey(s.id, key).then(() => setKey("")));

  const canDisconnect = s.connected && (s.via === "oauth" || s.via === "key");
  return (
    <Panel>
      <PanelHeader
        icon={ICON[s.id]}
        title={s.label}
        extra={
          s.needsReauth ? (
            <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
              Needs reconnecting
            </Badge>
          ) : s.connected ? (
            <Badge variant="secondary" className="gap-1">
              <Check className="size-3" /> Connected{s.account ? ` as ${s.account}` : ""}
            </Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )
        }
      >
        <p className="text-sm text-muted-foreground">{s.about}</p>
        {s.connected && s.via && (
          <p className="text-xs text-muted-foreground">
            Through {VIA[s.via]}.{s.via === "env" && ` Set by ${s.keyEnv}.`}
          </p>
        )}
      </PanelHeader>

      {s.id === "github" && <GitHubAccessNote />}

      {start?.flow === "device" && (
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <p className="text-sm">GitHub opened in your browser. Paste this code there (it's on your clipboard) and approve yaah:</p>
          <div className="flex items-center gap-2">
            <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-xl font-semibold tracking-widest">{start.userCode}</code>
            <Button variant="ghost" size="icon-sm" title="Copy" aria-label="Copy code" onClick={() => void copyCode(start.userCode)}>
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => openExternal(start.verificationUri)}>
              <ExternalLink /> Open {hostOf(start.verificationUri)}
              {start.verificationUri.replace(/^https?:\/\/[^/]+/, "")}
            </Button>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <Loader2 className="size-3 animate-spin" /> Waiting for you to approve…
            </span>
          </div>
        </section>
      )}
      {start?.flow === "browser" && (
        <section className="flex items-center gap-3 rounded-lg border p-4 text-sm" role="status">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <span>Approve yaah in the browser tab that opened.</span>
          <Button variant="link" size="sm" className="ml-auto" onClick={() => openExternal(start.authUrl)}>
            Open it again
          </Button>
        </section>
      )}

      {!start && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void connect()} disabled={!!busy}>
              {busy === "connect" ? <Loader2 className="animate-spin" /> : ICON[s.id]}
              {s.connected && s.via === "oauth" ? "Reconnect" : `Connect ${s.label}`}
            </Button>
            {canDisconnect && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-destructive"
                disabled={!!busy}
                onClick={() => void run("disconnect", () => api.integrationDisconnect(s.id))}
              >
                <Trash2 /> Disconnect
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {s.flow === "device"
              ? "Opens github.com in your browser with a short code on your clipboard. Approve there and yaah keeps the token GitHub issues; no gh CLI needed."
              : `Opens ${s.label} in your browser to approve; it hands back to yaah on 127.0.0.1:43117, and yaah keeps and refreshes the token.`}
          </p>
        </section>
      )}

      <Separator />
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (key && !busy) void saveKey();
        }}
      >
        <Label htmlFor={`key-${s.id}`} className="gap-1.5">
          <KeyRound className="size-3.5" /> Or use a personal API key
        </Label>
        <div className="flex gap-2">
          <Input
            id={`key-${s.id}`}
            type="password"
            autoComplete="off"
            value={key}
            placeholder={s.id === "linear" ? "lin_api_…" : "ghp_…"}
            onChange={(e) => setKey(e.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={!key || !!busy}>
            {busy === "key" && <Loader2 className="animate-spin" />}
            Check and save
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Make one at{" "}
          <button type="button" className="underline underline-offset-2" onClick={() => openExternal(s.keyUrl)}>
            {s.keyUrl.replace(/^https:\/\//, "")}
          </button>
          . It's checked before saving and kept on this machine only. {s.keyEnv} works too.
        </p>
      </form>

      <ErrorText error={error} className="text-sm" />
    </Panel>
  );
}

/** What a GitHub token can reach, and the narrower option. */
function GitHubAccessNote() {
  return (
    <section
      aria-label="What GitHub access yaah gets"
      className="flex flex-col gap-1.5 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground"
    >
      <p>
        Signing in with GitHub asks for the <code className="font-mono text-foreground">repo</code> scope, because GitHub's OAuth apps offer no
        read-only one. That token can read your private repositories. yaah itself only reads.
      </p>
      <p>
        For narrower access, use a{" "}
        <button type="button" className="underline underline-offset-2" onClick={() => openExternal(FINE_GRAINED_TOKEN_URL)}>
          fine-grained personal access token
        </button>{" "}
        with read-only <span className="text-foreground">Contents</span> and <span className="text-foreground">Pull requests</span>, limited to the
        repositories you choose, and paste it below.
      </p>
    </section>
  );
}

const FINE_GRAINED_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

const READ_ONLY_ROLE = `CREATE ROLE yaah_ro LOGIN PASSWORD '…';
GRANT pg_read_all_data TO yaah_ro;`;

function Databases() {
  const [list, setList] = useState<ConnectionInfo[] | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    api.listConnections().then(setList, setError);
  };
  useEffect(load, []);
  const valid = connectionReady(name, url);
  const add = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addConnection(name, url.trim());
      setName("");
      setUrl("");
      load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = (c: ConnectionInfo) => {
    setError(null);
    api.removeConnection(c.name).then(load, setError);
  };
  return (
    <Panel>
      <PanelHeader icon={<Database className="size-3.5 text-muted-foreground" />} title="Databases">
        <p className="text-sm text-muted-foreground">
          Postgres connections for live views and the SQL editor. Agents see only the names; queries run read-only (READ ONLY transaction, 15s
          timeout, row limit).
        </p>
      </PanelHeader>
      <section aria-label="Read-only role" className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
        <p>
          yaah only connects as a read-only role and refuses superusers. To make one on Postgres 14 or later, run this as an admin, then put{" "}
          <code className="font-mono text-foreground">yaah_ro</code> and its password in the URL:
        </p>
        <pre className="overflow-x-auto rounded-md bg-background px-2 py-1.5 font-mono text-foreground">{READ_ONLY_ROLE}</pre>
      </section>
      <ul className="flex flex-col divide-y rounded-lg border">
        {list?.length === 0 && <li className="p-3 text-sm text-muted-foreground">None yet.</li>}
        {list?.map((c) => (
          <li key={c.name} className="flex items-center gap-3 p-3">
            <span className="font-mono text-sm font-medium">{c.name}</span>
            <span className="truncate text-xs text-muted-foreground">{c.target}</span>
            <Button size="xs" variant="ghost" className="ml-auto text-destructive" aria-label={`Remove ${c.name}`} onClick={() => remove(c)}>
              <Trash2 /> Remove
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <Plus className="size-3.5" /> Add a connection
          </legend>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label="Name"
              placeholder="name agents use, e.g. shop"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              className="sm:w-48"
            />
            <Input
              aria-label="URL"
              type="password"
              autoComplete="off"
              placeholder="postgres://user:password@host:5432/db"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={!valid || busy}>
              {busy && <Loader2 className="animate-spin" />}
              Test and add
            </Button>
          </div>
        </fieldset>
        <ErrorText error={error} className="text-sm" />
      </form>
    </Panel>
  );
}
