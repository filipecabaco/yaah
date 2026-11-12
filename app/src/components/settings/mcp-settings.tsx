// Settings → MCP servers: the user's own MCP servers, handed to every agent
// yaah starts (ACP session/new and session/load `mcpServers`, next to yaah's
// own `yaah-ui`). Rust stores, validates, tests and imports them
// (mcp_servers.rs); this only shows them.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  CircleCheck,
  Download,
  ExternalLink,
  KeyRound,
  LayoutGrid,
  Loader2,
  Lock,
  LogIn,
  LogOut,
  Plug,
  Plus,
  Search,
  Server,
  Wrench,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ErrorText } from "@/components/error-text";
import { fromPairs, toPairs, useAction, type Pair } from "@/components/settings/form-state";
import { ErrorAlert, Field, NavHeading, NavNote, NavRow, Pairs, Panel, PanelHeader, RemoveButton, TwoPane } from "@/components/settings/parts";
import {
  api,
  mcpApi,
  type AgentProfile,
  type McpImportCandidate,
  type McpList,
  type McpServerDraft,
  type McpServerInfo,
  type McpSignInKind,
  type McpTestReport,
  type McpTransport,
} from "@/lib/api";
import { compactPath, plural } from "@/lib/format";
import { openExternal } from "@/lib/links";
import { MCP_CATALOG, MCP_CATALOG_CATEGORIES, addedAs, catalogDraft, freeName, type McpCatalogEntry } from "@/lib/mcp-catalog";

type Selected =
  | { kind: "server"; name: string }
  | { kind: "new" }
  | { kind: "builtin" }
  | { kind: "import" }
  | { kind: "catalog" }
  /** A catalog entry that needs a key: the add form, filled in. */
  | { kind: "preset"; id: string };

const TRANSPORTS: { id: McpTransport; label: string; hint: string }[] = [
  { id: "stdio", label: "stdio (local command)", hint: "Every ACP agent supports it." },
  { id: "http", label: "HTTP (streamable)", hint: "Only agents that support HTTP MCP get it." },
  { id: "sse", label: "SSE (legacy)", hint: "Deprecated by MCP. Only agents that support SSE MCP get it." },
];

const blank: McpServerDraft = {
  original: null,
  name: "",
  transport: "stdio",
  commandLine: "",
  env: {},
  url: "",
  headers: {},
  enabled: true,
  agents: [],
};

const draftOf = (s: McpServerInfo): McpServerDraft => ({
  original: s.name,
  name: s.name,
  transport: s.transport,
  commandLine: s.commandLine,
  env: { ...s.env },
  url: s.url,
  headers: { ...s.headers },
  enabled: s.enabled,
  agents: [...(s.agents ?? [])],
});

export function McpSettings() {
  const [list, setList] = useState<McpList | null>(null);
  const [picked, setPicked] = useState<Selected | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Never rejects: a failed load shows under the list.
  const reload = () => mcpApi.list().then(setList, setError);
  useEffect(() => {
    mcpApi.list().then(setList, setError);
  }, []);

  // Until something is picked: the first server, or the catalog to start from.
  const selected: Selected | null =
    picked ?? (list ? (list.servers[0] ? { kind: "server", name: list.servers[0].name } : { kind: "catalog" }) : null);
  const preset = selected?.kind === "preset" ? MCP_CATALOG.find((e) => e.id === selected.id) : undefined;
  const server = selected?.kind === "server" ? list?.servers.find((s) => s.name === selected.name) : undefined;

  function toggle(name: string, enabled: boolean) {
    setError(null);
    mcpApi
      .setEnabled(name, enabled)
      .then((updated) => setList((l) => l && { ...l, servers: l.servers.map((s) => (s.name === name ? updated : s)) }), setError);
  }

  return (
    <TwoPane
      label="MCP servers"
      nav={
        <>
          <NavHeading>Built in</NavHeading>
          {list && (
            <NavRow
              active={selected?.kind === "builtin"}
              onClick={() => setPicked({ kind: "builtin" })}
              label={list.builtin.name}
              icon={<Lock className="size-3.5 text-muted-foreground" />}
              end={<Badge variant="outline">{list.builtin.transport}</Badge>}
            />
          )}
          <Separator className="my-2" />
          <NavHeading>Your servers</NavHeading>
          {!list && !error && <NavNote loading>Loading…</NavNote>}
          {list?.servers.length === 0 && <NavNote>None yet.</NavNote>}
          {list?.servers.map((s) => (
            <NavRow
              key={s.name}
              active={selected?.kind === "server" && selected.name === s.name}
              onClick={() => setPicked({ kind: "server", name: s.name })}
              label={s.name}
              note={s.problem ? "needs attention" : s.agents?.length ? `only ${s.agents.join(", ")}` : undefined}
              dim={!s.enabled}
              icon={
                s.problem ? (
                  <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" />
                ) : (
                  <Server className="size-3.5 text-muted-foreground" />
                )
              }
              end={s.transport !== "stdio" && <Badge variant="outline">{s.transport}</Badge>}
              action={
                <Switch
                  size="sm"
                  checked={s.enabled}
                  onCheckedChange={(on) => toggle(s.name, on)}
                  aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                />
              }
            />
          ))}
          <ErrorText error={error} className="px-2 py-1" />
          <Separator className="my-2" />
          <NavRow
            active={selected?.kind === "catalog" || selected?.kind === "preset"}
            onClick={() => setPicked({ kind: "catalog" })}
            label="Browse catalog"
            icon={<LayoutGrid className="size-3.5 text-muted-foreground" />}
          />
          <NavRow
            active={selected?.kind === "new"}
            onClick={() => setPicked({ kind: "new" })}
            label="Add server"
            icon={<Plus className="size-3.5 text-muted-foreground" />}
          />
          <NavRow
            active={selected?.kind === "import"}
            onClick={() => setPicked({ kind: "import" })}
            label="Import…"
            icon={<Download className="size-3.5 text-muted-foreground" />}
          />
        </>
      }
    >
      <Panel>
        <p className="text-sm text-muted-foreground">
          Each server goes to every agent or only the ones you pick, alongside yaah's own <code className="text-xs">yaah-ui</code>. http and sse
          servers only reach agents that support them. New chats pick up changes.
        </p>
        {!list ? null : selected?.kind === "builtin" ? (
          <BuiltinCard about={list.builtin.about} name={list.builtin.name} />
        ) : selected?.kind === "catalog" ? (
          <CatalogPanel
            servers={list.servers}
            onAdded={async (name) => {
              await reload();
              setPicked({ kind: "server", name });
            }}
            onNeedsKey={(entry) => setPicked({ kind: "preset", id: entry.id })}
            onOpen={(name) => setPicked({ kind: "server", name })}
          />
        ) : preset ? (
          <Editor
            key={`preset:${preset.id}`}
            initial={catalogDraft(
              preset,
              freeName(
                preset.id,
                list.servers.map((s) => s.name),
              ),
            )}
            server={undefined}
            storePath={list.path}
            title={`Add ${preset.label}`}
            intro={<PresetIntro entry={preset} />}
            onSaved={async (saved) => {
              await reload();
              setPicked({ kind: "server", name: saved.name });
            }}
            onRemoved={() => Promise.resolve(setPicked({ kind: "catalog" }))}
          />
        ) : selected?.kind === "import" ? (
          <ImportPanel
            onImported={async (added) => {
              await reload();
              if (added[0]) setPicked({ kind: "server", name: added[0].name });
            }}
          />
        ) : selected?.kind === "new" || server ? (
          <Editor
            // A fresh form per server.
            key={server ? `server:${server.name}` : "new"}
            initial={server ? draftOf(server) : blank}
            server={server}
            storePath={list.path}
            onSaved={async (saved) => {
              await reload();
              setPicked({ kind: "server", name: saved.name });
            }}
            onRemoved={async () => {
              setPicked(null);
              await reload();
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Pick a server on the left.</p>
        )}
      </Panel>
    </TwoPane>
  );
}

function BuiltinCard({ name, about }: { name: string; about: string }) {
  return (
    <section className="flex flex-col gap-2">
      <PanelHeader
        title={name}
        extra={
          <>
            <Badge variant="secondary">built in</Badge>
            <Badge variant="outline">http</Badge>
          </>
        }
      />
      <p className="text-sm text-muted-foreground">{about}</p>
      <p className="text-sm text-muted-foreground">
        Each chat gets its own local URL with a private token, so it can't be edited here. Agents that can't reach HTTP MCP servers chat without it.
      </p>
    </section>
  );
}

function Editor({
  initial,
  server,
  storePath,
  title,
  intro,
  onSaved,
  onRemoved,
}: {
  initial: McpServerDraft;
  server: McpServerInfo | undefined;
  storePath: string;
  title?: string;
  intro?: ReactNode;
  onSaved: (s: McpServerInfo) => Promise<void>;
  onRemoved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<McpServerDraft>(initial);
  const [env, setEnv] = useState<Pair[]>(() => toPairs(initial.env));
  const [headers, setHeaders] = useState<Pair[]>(() => toPairs(initial.headers));
  const [tested, setTested] = useState<McpTestReport | null>(null);
  const { busy, failed, run } = useAction<"test" | "save" | "remove">();
  const stdio = draft.transport === "stdio";
  const current: McpServerDraft = { ...draft, env: fromPairs(env), headers: fromPairs(headers) };
  const dirty = JSON.stringify(current) !== JSON.stringify(initial);
  const ready = !!draft.name.trim() && (stdio ? !!draft.commandLine.trim() : !!draft.url.trim());
  const stored = `Stored only on this machine, in ${compactPath(storePath)}.`;

  const test = () =>
    void run("test", async () => {
      setTested(null);
      setTested(await mcpApi.test(current));
    });
  const [signingIn, setSigningIn] = useState(false);
  // A new HTTP server that wants a browser login gets it straight away: paste the URL, Add, sign in.
  // A failed or cancelled login isn't a failed save: the server opens with its "Sign in" button.
  const save = () =>
    void run("save", async () => {
      const saved = await mcpApi.save(current);
      if (!server && saved.transport === "http" && !hasAuthorization(current.headers)) {
        const kind = await mcpApi.signInKind(saved.url).catch(() => "none" as const);
        if (kind === "oauth") {
          setSigningIn(true);
          await mcpApi.login(saved.name).catch(() => {});
          setSigningIn(false);
        }
      }
      await onSaved(saved);
    });

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <PanelHeader
        title={server ? server.name : (title ?? "Add an MCP server")}
        extra={server && !server.enabled && <Badge variant="outline">off</Badge>}
      />
      {intro}

      {server?.problem && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Not sent to agents</AlertTitle>
          <AlertDescription>
            <p>
              {server.problem.split(/`([^`]+)`/).map((part, i) =>
                i % 2 ? (
                  <code key={i} className="text-xs">
                    {part}
                  </code>
                ) : (
                  part
                ),
              )}
            </p>
          </AlertDescription>
        </Alert>
      )}
      {server && server.unsupportedBy.length > 0 && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Some agents won't get it</AlertTitle>
          <AlertDescription>
            {server.unsupportedBy.join(", ")} can't connect to {server.transport} MCP servers, so their chats run without it.
          </AlertDescription>
        </Alert>
      )}

      {server?.transport === "http" && !hasAuthorization(server.headers) && (
        <SignIn
          // Asked again when the saved URL changes.
          key={server.url}
          server={server}
          onChanged={() => onSaved(server)}
        />
      )}

      <div className="grid gap-4">
        <Field id="mcp-name" label="Name" hint="kebab-case. Agents prefix its tools with it, like mcp__name__tool.">
          <Input
            id="mcp-name"
            className="font-mono text-xs"
            value={draft.name}
            placeholder="github-issues"
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field id="mcp-transport" label="Transport" hint={TRANSPORTS.find((t) => t.id === draft.transport)?.hint}>
          <Select value={draft.transport} onValueChange={(v) => setDraft({ ...draft, transport: v as McpTransport })}>
            <SelectTrigger id="mcp-transport" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSPORTS.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {stdio ? (
          <Field id="mcp-command" label="Command" hint="Starts the server, speaking MCP on stdin/stdout. Quote words that contain spaces.">
            <Input
              id="mcp-command"
              className="font-mono [font-feature-settings:'calt'_0,'liga'_0] text-xs [font-variant-ligatures:none]"
              value={draft.commandLine}
              placeholder="npx -y @modelcontextprotocol/server-filesystem ~/notes"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, commandLine: e.target.value })}
            />
          </Field>
        ) : (
          <Field
            id="mcp-url"
            label="URL"
            hint={draft.transport === "http" && !server ? "If the server needs a sign-in, your browser opens when you add it." : undefined}
          >
            <Input
              id="mcp-url"
              className="font-mono text-xs"
              value={draft.url}
              placeholder={draft.transport === "sse" ? "https://example.com/sse" : "https://example.com/mcp"}
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
          </Field>
        )}
        <AvailableTo value={draft.agents} onChange={(agents) => setDraft({ ...draft, agents })} />
        {stdio ? (
          <Pairs
            legend="Environment"
            keyLabel="Variable name"
            keyPlaceholder="NAME"
            addLabel="Add variable"
            rows={env}
            onChange={setEnv}
            note={stored}
          />
        ) : (
          <Pairs
            legend="Headers"
            keyLabel="Header name"
            keyPlaceholder="Authorization"
            addLabel="Add header"
            rows={headers}
            onChange={setHeaders}
            note={stored}
          />
        )}
      </div>

      {failed && (
        <ErrorAlert
          title={failed.during === "test" ? "The test failed" : failed.during === "save" ? "Couldn't save" : "Couldn't remove"}
          error={failed.error}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={test} disabled={busy !== null || !ready}>
          {busy === "test" ? <Loader2 className="animate-spin" /> : <Plug />}
          {busy === "test" ? "Connecting…" : "Test"}
        </Button>
        <Button type="submit" disabled={busy !== null || !ready || (!!server && !dirty)}>
          {busy === "save" ? <Loader2 className="animate-spin" /> : <Check />}
          {signingIn ? "Waiting for the browser…" : server ? "Save changes" : "Add server"}
        </Button>
        {server && (
          <RemoveButton
            name={server.name}
            disabled={busy !== null}
            onRemove={() =>
              void run("remove", async () => {
                await mcpApi.remove(server.name);
                await onRemoved();
              })
            }
          />
        )}
      </div>

      {tested && <TestCard report={tested} />}
    </form>
  );
}

function TestCard({ report }: { report: McpTestReport }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Test result">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <CircleCheck className="size-4 translate-y-0.5 self-start text-emerald-600 dark:text-emerald-400" />
        <h3 className="text-sm font-medium">
          {report.serverName ?? "The server"}
          {report.serverVersion && <span className="font-normal text-muted-foreground"> {report.serverVersion}</span>}
        </h3>
        <span className="text-xs text-muted-foreground">
          MCP {report.protocolVersion ?? "?"} · {plural(report.tools.length, "tool")}
        </span>
      </div>
      {report.tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">It answered, but offers no tools.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {report.tools.map((t) => (
            <li key={t.name} className="flex gap-2">
              <Wrench className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <code className="text-xs">{t.name}</code>
                {t.description && <p className="line-clamp-2 text-xs text-muted-foreground">{t.description}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const pickKey = (c: McpImportCandidate) => `${c.source}\u0000${c.original}`;

/** Servers configured for Claude Code, Claude Desktop and Cursor; pick which to copy in. */
function ImportPanel({ onImported }: { onImported: (added: McpServerInfo[]) => Promise<void> }) {
  const [found, setFound] = useState<McpImportCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<unknown>(null);
  const { busy, failed, run } = useAction<"import">();

  useEffect(() => {
    mcpApi.importCandidates().then((c) => {
      setFound(c);
      setPicked(new Set(c.filter((x) => !x.alreadyAdded).map(pickKey)));
    }, setLoadError);
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, McpImportCandidate[]>();
    for (const c of found ?? []) m.set(c.source, [...(m.get(c.source) ?? []), c]);
    return [...m.values()];
  }, [found]);

  const importPicked = () =>
    void run("import", async () => {
      const picks = (found ?? []).filter((c) => picked.has(pickKey(c))).map((c) => ({ source: c.source, original: c.original }));
      await onImported(await mcpApi.import(picks));
    });

  return (
    <section className="flex flex-col gap-4">
      <PanelHeader title="Import servers">
        <p className="text-sm text-muted-foreground">
          From Claude Code (including each Claude agent's config folder), Claude Desktop and Cursor. Environment values and headers are copied too,
          but not shown here.
        </p>
      </PanelHeader>
      {!found && !loadError && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Looking for configured servers…
        </p>
      )}
      {found?.length === 0 && <p className="text-sm text-muted-foreground">No MCP servers found in those tools' configs.</p>}
      {groups.map((items) => (
        <fieldset key={items[0].source} className="flex flex-col gap-1">
          <legend className="mb-1 flex items-baseline gap-2 text-sm font-medium">
            {items[0].sourceLabel}
            <span className="font-mono text-xs font-normal text-muted-foreground">{items[0].path}</span>
          </legend>
          {items.map((c) => {
            const key = pickKey(c);
            const id = `mcp-import-${key.replace(/[^a-z0-9]/gi, "-")}`;
            return (
              <div key={key} className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-accent/50">
                <Checkbox
                  id={id}
                  className="mt-0.5"
                  checked={picked.has(key)}
                  onCheckedChange={(on) => {
                    const next = new Set(picked);
                    if (on) next.add(key);
                    else next.delete(key);
                    setPicked(next);
                  }}
                />
                <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{c.name}</span>
                    {c.name !== c.original && <span className="text-xs text-muted-foreground">was “{c.original}”</span>}
                    <Badge variant="outline">{c.transport}</Badge>
                    {c.alreadyAdded && <Badge variant="secondary">already added</Badge>}
                  </span>
                  <code className="truncate text-xs text-muted-foreground">{c.target}</code>
                  {(c.envKeys.length > 0 || c.headerKeys.length > 0) && (
                    <span className="flex flex-wrap gap-1">
                      {[...c.envKeys, ...c.headerKeys].map((k) => (
                        <Badge key={k} variant="outline" className="font-mono text-2xs text-muted-foreground">
                          {k}
                        </Badge>
                      ))}
                    </span>
                  )}
                </label>
              </div>
            );
          })}
        </fieldset>
      ))}
      {loadError != null && <ErrorAlert title="Couldn't read other tools' configs" error={loadError} />}
      {failed && <ErrorAlert title="Couldn't import" error={failed.error} />}
      {found && found.length > 0 && (
        <div>
          <Button onClick={importPicked} disabled={busy !== null || picked.size === 0}>
            {busy === "import" ? <Loader2 className="animate-spin" /> : <Download />}
            {picked.size ? `Import ${plural(picked.size, "server")}` : "Import servers"}
          </Button>
        </div>
      )}
    </section>
  );
}

/** Who gets a server: every agent, or the agents picked (a server carrying one account's credentials stays with it). */
function AvailableTo({ value, onChange }: { value: string[]; onChange: (agents: string[]) => void }) {
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null);
  useEffect(() => {
    api.listAgents().then(
      (r) => setProfiles(r.profiles),
      () => setProfiles([]),
    );
  }, []);
  const some = value.length > 0;
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id].sort() : value.filter((a) => a !== id));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">Available to</legend>
      <RadioGroup
        aria-label="Available to"
        className="flex gap-4"
        value={some ? "some" : "all"}
        onValueChange={(v) => onChange(v === "all" ? [] : (profiles?.slice(0, 1).map((p) => p.id) ?? []))}
      >
        <Label htmlFor="mcp-to-all" className="font-normal">
          <RadioGroupItem id="mcp-to-all" value="all" /> All agents
        </Label>
        <Label htmlFor="mcp-to-some" className="font-normal">
          <RadioGroupItem id="mcp-to-some" value="some" /> Only these agents
        </Label>
      </RadioGroup>
      {some && (
        <div className="flex flex-col gap-1.5 rounded-md border p-2">
          {profiles?.map((p) => (
            <Label key={p.id} htmlFor={`mcp-agent-${p.id}`} className="font-normal">
              <Checkbox id={`mcp-agent-${p.id}`} checked={value.includes(p.id)} onCheckedChange={(on) => toggle(p.id, on === true)} />
              {p.label}
              <span className="text-xs text-muted-foreground">{p.presetLabel}</span>
            </Label>
          ))}
          {value
            .filter((a) => !profiles?.some((p) => p.id === a))
            .map((a) => (
              <Label key={a} htmlFor={`mcp-agent-${a}`} className="font-normal text-muted-foreground">
                <Checkbox id={`mcp-agent-${a}`} checked onCheckedChange={() => toggle(a, false)} />
                {a} <span className="text-xs">(not a saved agent)</span>
              </Label>
            ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        A server with one account's keys or sign-in (claude-work, claude-personal) should go to that agent only. A Claude agent already loads the
        servers in its own config folder; yaah doesn't send those again.
      </p>
    </fieldset>
  );
}

const AUTH_LABEL = { oauth: "sign in", none: "no sign-in", token: "API key" } as const;

/** Well-known servers, added in one click: saved, then signed in through the browser when they need it. */
function CatalogPanel({
  servers,
  onAdded,
  onNeedsKey,
  onOpen,
}: {
  servers: McpServerInfo[];
  onAdded: (name: string) => Promise<void>;
  onNeedsKey: (entry: McpCatalogEntry) => void;
  onOpen: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  /** The entry being added, and how far it got. */
  const [busy, setBusy] = useState<{ id: string; what: string } | null>(null);
  const [failed, setFailed] = useState<{ entry: McpCatalogEntry; saved: string | null; error: unknown } | null>(null);

  const q = query.trim().toLowerCase();
  const shown = MCP_CATALOG.filter((e) => !q || `${e.label} ${e.description} ${e.category} ${e.id}`.toLowerCase().includes(q));

  async function add(entry: McpCatalogEntry) {
    if (entry.auth === "token") return onNeedsKey(entry);
    setFailed(null);
    let saved: string | null = null;
    try {
      setBusy({ id: entry.id, what: "Adding…" });
      saved = (
        await mcpApi.save(
          catalogDraft(
            entry,
            freeName(
              entry.id,
              servers.map((s) => s.name),
            ),
          ),
        )
      ).name;
      if (entry.auth === "oauth") {
        setBusy({ id: entry.id, what: "Waiting for the browser…" });
        await mcpApi.login(saved);
      }
      await onAdded(saved);
    } catch (error) {
      setFailed({ entry, saved, error });
      // Saved but not signed in: it's in the list, and /mcp or this card can log in again.
      if (saved) await onAdded(saved).catch(() => {});
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <PanelHeader title="Add from the catalog">
        <p className="text-sm text-muted-foreground">
          Well-known servers, ready to go. Ones that need a sign-in open your browser once; yaah keeps the login on this machine.
        </p>
      </PanelHeader>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search the catalog"
          className="pl-8"
          placeholder="Stripe, Cloudflare, Postgres…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {failed && (
        <ErrorAlert
          title={failed.saved ? `Added ${failed.entry.label}, but the sign-in didn't finish` : `Couldn't add ${failed.entry.label}`}
          error={failed.error}
        />
      )}
      {shown.length === 0 && <p className="text-sm text-muted-foreground">Nothing in the catalog matches. Add it by hand with “Add server”.</p>}
      {MCP_CATALOG_CATEGORIES.map((category) => {
        const items = shown.filter((e) => e.category === category);
        if (!items.length) return null;
        return (
          <fieldset key={category} className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{category}</legend>
            <ul className="grid gap-2 sm:grid-cols-2" aria-label={category}>
              {items.map((entry) => {
                const existing = addedAs(entry, servers);
                const mine = busy?.id === entry.id;
                return (
                  <li key={entry.id} className="flex flex-col gap-2 rounded-lg border p-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium">{entry.label}</span>
                      <Badge variant="outline" className="text-2xs">
                        {AUTH_LABEL[entry.auth]}
                      </Badge>
                      <button
                        type="button"
                        className="ml-auto text-muted-foreground hover:text-foreground"
                        title={`About ${entry.label}`}
                        aria-label={`About ${entry.label}`}
                        onClick={() => openExternal(entry.docs)}
                      >
                        <ExternalLink className="size-3.5" />
                      </button>
                    </div>
                    <p className="flex-1 text-xs text-muted-foreground">{entry.description}</p>
                    <div>
                      {existing ? (
                        <Button type="button" size="xs" variant="ghost" onClick={() => onOpen(existing.name)}>
                          <Check /> Added as {existing.name}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => void add(entry)}
                          aria-label={`Add ${entry.label}`}
                        >
                          {mine ? (
                            <Loader2 className="animate-spin" />
                          ) : entry.auth === "oauth" ? (
                            <LogIn />
                          ) : entry.auth === "token" ? (
                            <KeyRound />
                          ) : (
                            <Plus />
                          )}
                          {mine ? busy.what : entry.auth === "oauth" ? "Add and sign in" : entry.auth === "token" ? "Add with a key…" : "Add"}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </section>
  );
}

function PresetIntro({ entry }: { entry: McpCatalogEntry }) {
  return (
    <p className="text-sm text-muted-foreground">
      {entry.description} {entry.token?.hint}{" "}
      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => openExternal(entry.docs)}>
        How to get one
      </button>
    </p>
  );
}

const hasAuthorization = (headers: Record<string, string>) => Object.keys(headers).some((k) => k.trim().toLowerCase() === "authorization");

/** A saved HTTP server's login: signed in, one click to sign in, or why there's no button. */
function SignIn({ server, onChanged }: { server: McpServerInfo; onChanged: () => Promise<void> }) {
  const [kind, setKind] = useState<McpSignInKind | "checking" | null>(server.loggedIn ? null : "checking");
  const { busy, failed, run } = useAction<"login" | "logout">();
  useEffect(() => {
    if (server.loggedIn) return;
    let current = true;
    mcpApi.signInKind(server.url).then(
      (k) => current && setKind(k),
      () => current && setKind(null),
    );
    return () => {
      current = false;
    };
  }, [server.loggedIn, server.url]);

  const logIn = () => void run("login", async () => (await mcpApi.login(server.name), onChanged()));
  const logOut = () => void run("logout", async () => (await mcpApi.logout(server.name), setKind("oauth"), onChanged()));
  const error = failed && <ErrorAlert title={failed.during === "login" ? "The sign-in didn't finish" : "Couldn't sign out"} error={failed.error} />;

  if (server.loggedIn)
    return (
      <section aria-label="Sign-in" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
          <span>Signed in through the browser.</span>
          <Button type="button" size="xs" variant="outline" disabled={busy !== null} onClick={logIn}>
            {busy === "login" ? <Loader2 className="animate-spin" /> : <LogIn />}
            {busy === "login" ? "Waiting for the browser…" : "Sign in again"}
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={busy !== null} onClick={logOut}>
            <LogOut /> Sign out
          </Button>
        </div>
        {error}
      </section>
    );
  if (kind === "checking")
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Checking whether it needs a sign-in…
      </p>
    );
  if (kind === "oauth")
    return (
      <Alert aria-label="Sign-in">
        <LogIn />
        <AlertTitle>Sign in to use it</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <p>Agents get its tools once you've signed in. Your browser opens on its login page; yaah keeps the login on this machine.</p>
          <Button type="button" size="sm" disabled={busy !== null} onClick={logIn}>
            {busy === "login" ? <Loader2 className="animate-spin" /> : <LogIn />}
            {busy === "login" ? "Waiting for the browser…" : "Sign in"}
          </Button>
          {error}
        </AlertDescription>
      </Alert>
    );
  if (kind === "manual")
    return (
      <Alert aria-label="Sign-in">
        <KeyRound />
        <AlertTitle>Needs a token</AlertTitle>
        <AlertDescription>
          It wants a login yaah can't open in the browser for you. Add an <code className="text-xs">Authorization</code> header below with a token
          from the service, usually <code className="text-xs">Bearer &lt;token&gt;</code>.
        </AlertDescription>
      </Alert>
    );
  return null;
}
