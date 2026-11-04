// Settings → MCP servers: the user's own MCP servers, handed to every agent
// yaah starts (ACP session/new and session/load `mcpServers`, next to yaah's
// own `yaah-ui`). Rust stores, validates, tests and imports them
// (mcp_servers.rs); this only shows them.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, CircleCheck, Download, Loader2, Lock, Plug, Plus, Server, Wrench } from "lucide-react";
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
  type McpTestReport,
  type McpTransport,
} from "@/lib/api";
import { compactPath, plural } from "@/lib/format";

type Selected = { kind: "server"; name: string } | { kind: "new" } | { kind: "builtin" } | { kind: "import" };

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

  // Until something is picked: the first server, or the empty "add" form.
  const selected: Selected | null = picked ?? (list ? (list.servers[0] ? { kind: "server", name: list.servers[0].name } : { kind: "new" }) : null);
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
  onSaved,
  onRemoved,
}: {
  initial: McpServerDraft;
  server: McpServerInfo | undefined;
  storePath: string;
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
  const save = () => void run("save", async () => onSaved(await mcpApi.save(current)));

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <PanelHeader title={server ? server.name : "Add an MCP server"} extra={server && !server.enabled && <Badge variant="outline">off</Badge>} />

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
          <Field id="mcp-url" label="URL">
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
          {server ? "Save changes" : "Add server"}
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
