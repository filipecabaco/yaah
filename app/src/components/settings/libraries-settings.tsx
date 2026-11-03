// Settings → Components: the component libraries agents can use. yaah's own,
// the user's collection, and libraries installed from a git repo or a folder.
// Rust fetches, validates, stores and updates them (and refuses what it must);
// this screen shows what it reports and passes along what the user picked.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronRight, CircleAlert, Download, ExternalLink, FolderOpen, GitBranch, Loader2, Package, RefreshCw, Search, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { ErrorText } from "@/components/error-text";
import { NavNote, Section } from "@/components/settings/parts";
import { events, libraryApi, type LibraryInfo, type LibraryPreview, type LibrarySource, type LibraryUpdate } from "@/lib/api";
import { compactPath, formatAgo, plural } from "@/lib/format";
import { isWebUrl, openExternal } from "@/lib/links";
import { cn } from "@/lib/utils";

/** How a source kind reads on a badge. */
const READS: Record<string, string> = {
  github: "GitHub",
  linear: "Linear",
  postgres: "Postgres",
  docker: "Docker",
  system: "System",
  git: "git",
  files: "Files",
};

const KIND: Record<LibraryInfo["kind"], string | null> = { builtin: "built in", local: "yours", git: null, folder: "folder" };

const shortSha = (sha?: string) => sha?.slice(0, 7);

export function LibrariesSettings() {
  const [libs, setLibs] = useState<LibraryInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    libraryApi.list().then((l) => {
      setLibs(l);
      setError(null);
    }, setError);
  }, []);
  useEffect(() => {
    load();
    // Installs, updates and removals from anywhere (another window, an agent) show here.
    const off = events.librariesChanged(load);
    return () => void off.then((f) => f());
  }, [load]);

  const installedIds = libs?.map((l) => l.id) ?? [];
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex max-w-3xl flex-col gap-8 p-6">
        <Section
          title="Libraries"
          about="Agents can use every component of an enabled library. Turn one off to hide its components without removing it."
        >
          {!libs && !error && <NavNote loading>Reading libraries…</NavNote>}
          <ErrorText error={error} className="text-sm" />
          {libs && (
            <ul className="flex flex-col divide-y rounded-lg border" aria-label="Libraries">
              {libs.map((l) => (
                <LibraryRow key={l.id} lib={l} installedIds={installedIds} onChanged={load} />
              ))}
            </ul>
          )}
        </Section>
        <AddLibrary libs={libs ?? []} onInstalled={load} />
      </div>
    </ScrollArea>
  );
}

// ── one library ─────────────────────────────────────────────────────────────

function LibraryRow({ lib, installedIds, onChanged }: { lib: LibraryInfo; installedIds: string[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<"update" | "remove" | "toggle" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const managed = lib.kind === "git" || lib.kind === "folder";

  const act = async (kind: "update" | "remove" | "toggle", f: () => Promise<unknown>) => {
    setBusy(kind);
    setNote(null);
    setError(null);
    try {
      await f();
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const update = () => act("update", async () => setNote(updateNote(await libraryApi.update(lib.id))));
  const toggle = (on: boolean) => act("toggle", () => libraryApi.setEnabled(lib.id, on));
  const remove = () => act("remove", () => libraryApi.remove(lib.id));

  return (
    <li className="flex flex-col gap-2 p-3" aria-label={lib.title}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("text-sm font-medium", !lib.enabled && "text-muted-foreground")}>{lib.title}</span>
            {lib.version && <span className="text-xs text-muted-foreground tabular-nums">v{lib.version}</span>}
            {KIND[lib.kind] && <Badge variant="outline">{KIND[lib.kind]}</Badge>}
            {!lib.enabled && <Badge variant="secondary">off</Badge>}
          </div>
          {lib.description && <p className="line-clamp-2 text-xs text-muted-foreground">{lib.description}</p>}
          <Meta lib={lib} />
          <Reads reads={lib.reads} needs={lib.needs} installedIds={installedIds} />
        </div>
        {managed && (
          <div className="flex shrink-0 items-center gap-1">
            {confirming ? (
              <span className="flex items-center gap-1.5 text-xs">
                Remove “{lib.title}”?
                <Button size="xs" variant="destructive" disabled={!!busy} onClick={() => void remove()}>
                  {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />} Remove
                </Button>
                {/* The safe choice takes focus from the button that just went away. */}
                <Button size="xs" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <>
                <Switch
                  size="sm"
                  className="mx-1"
                  checked={lib.enabled}
                  disabled={!!busy}
                  onCheckedChange={(on) => void toggle(on)}
                  aria-label={`${lib.enabled ? "Disable" : "Enable"} ${lib.title}`}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => void update()}
                  aria-label={`Update ${lib.title}`}
                  title={
                    lib.kind === "git"
                      ? `Fetch the newest ${lib.source?.kind === "git" && lib.source.ref ? lib.source.ref : "commit"}`
                      : "Read the folder again"
                  }
                >
                  {busy === "update" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Update
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-destructive"
                  disabled={!!busy}
                  aria-label={`Remove ${lib.title}`}
                  onClick={() => setConfirming(true)}
                >
                  <Trash2 /> Remove
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {note && (
        <p className="text-xs text-muted-foreground" role="status">
          {note}
        </p>
      )}
      <ErrorText error={error} />
      <Problems lib={lib} />
    </li>
  );
}

function updateNote(r: LibraryUpdate): string {
  const changed = r.changed.length ? ` ${plural(r.changed.length, "component")} changed: ${r.changed.join(", ")}.` : "";
  if (r.from && r.to && r.from !== r.to) return `Updated ${shortSha(r.from)} → ${shortSha(r.to)}.${changed || " No component changed."}`;
  if (r.from && r.from === r.to) return "Already up to date.";
  return `Read again.${changed}`;
}

/** Publisher, where it comes from, and how many components it has. */
function Meta({ lib }: { lib: LibraryInfo }) {
  const valid = lib.components.filter((c) => c.valid).length;
  const invalid = lib.components.length - valid;
  const facts = [
    lib.publisher && `by ${lib.publisher}`,
    `${plural(valid, "component")}${invalid > 0 ? `, ${invalid} not loaded` : ""}`,
    lib.updatedAt != null && `updated ${formatAgo(lib.updatedAt)}`,
    lib.kind === "local" && "share them from the Component library page",
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
      <p>{facts.join(" · ")}</p>
      {lib.source && (
        <p className="min-w-0">
          <SourceLine source={lib.source} commit={lib.commit} />
        </p>
      )}
    </div>
  );
}

/** A git URL with its ref and commit, or a folder path. */
function SourceLine({ source, commit }: { source: LibrarySource; commit?: string }) {
  if (source.kind === "folder")
    return (
      <span className="inline-flex min-w-0 items-center gap-1" title={source.path}>
        <FolderOpen className="size-3 shrink-0" />
        <span className="truncate font-mono">{compactPath(source.path)}</span>
      </span>
    );
  const link = isWebUrl(source.url);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      <GitBranch className="size-3 shrink-0" />
      {link ? (
        <button type="button" className="truncate font-mono underline-offset-2 hover:underline" onClick={() => openExternal(source.url)}>
          {source.url.replace(/^https:\/\//, "")}
        </button>
      ) : (
        <span className="truncate font-mono">{source.url}</span>
      )}
      <span className="font-mono">
        @ {source.ref ?? "default branch"}
        {commit && ` · ${shortSha(commit)}`}
      </span>
    </span>
  );
}

/** "Reads GitHub Postgres" and "Uses other-lib" badges. */
function Reads({ reads, needs, installedIds, bare }: { reads: string[]; needs: string[]; installedIds: string[]; bare?: boolean }) {
  if (!reads.length && !needs.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      {reads.length > 0 && (
        <>
          {!bare && <span>Reads</span>}
          {reads.map((r) => (
            <Badge key={r} variant="secondary" className="h-4 px-1.5 text-[10px]">
              {READS[r] ?? r}
            </Badge>
          ))}
        </>
      )}
      {needs.length > 0 && (
        <>
          {!bare && <span className={cn(reads.length > 0 && "ml-2")}>Uses</span>}
          {needs.map((n) => {
            const missing = !installedIds.includes(n);
            return (
              <Badge key={n} variant={missing ? "destructive" : "outline"} className="h-4 px-1.5 font-mono text-[10px]">
                {n}
                {missing && <span className="font-sans">· not installed</span>}
              </Badge>
            );
          })}
        </>
      )}
    </div>
  );
}

/** Library errors and components that didn't load, folded away. */
function Problems({ lib }: { lib: LibraryInfo }) {
  const [open, setOpen] = useState(false);
  const invalid = lib.components.filter((c) => !c.valid);
  const count = lib.errors.length + invalid.length;
  if (!count) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <CircleAlert className="size-3" /> {plural(count, "problem")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ProblemList errors={lib.errors} invalid={invalid} className="mt-1.5 ml-5" />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ProblemList({ errors, invalid, className }: { errors: string[]; invalid: LibraryInfo["components"]; className?: string }) {
  return (
    <ul className={cn("flex flex-col gap-1 text-xs", className)}>
      {errors.map((e) => (
        <li key={e} className="text-amber-700 dark:text-amber-400">
          {e}
        </li>
      ))}
      {invalid.map((c) => (
        <li key={c.name}>
          <span className="font-mono">{c.name}</span>
          <span className="text-destructive"> won't load: {c.error ?? "invalid"}</span>
        </li>
      ))}
    </ul>
  );
}

// ── add a library ───────────────────────────────────────────────────────────

function AddLibrary({ libs, onInstalled }: { libs: LibraryInfo[]; onInstalled: () => void }) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState<"inspect" | "install" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<LibraryPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const inspect = async (source: LibrarySource) => {
    if (busy) return;
    setBusy("inspect");
    setError(null);
    setDone(null);
    setPreview(null);
    try {
      setPreview(await libraryApi.inspect(source));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const inspectUrl = () => {
    if (!url.trim()) return;
    void inspect({ kind: "git", url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) });
  };
  const chooseFolder = async () => {
    try {
      const path = await open({ directory: true, title: "Folder with a component library (yaah-library.json)" });
      if (typeof path === "string") await inspect({ kind: "folder", path });
    } catch (e) {
      setError(e);
    }
  };
  const install = async () => {
    if (!preview || busy) return;
    setBusy("install");
    setError(null);
    try {
      const lib = await libraryApi.install(preview.stagingId);
      setPreview(null);
      setUrl("");
      setRef("");
      setDone(`Installed ${lib.title}: ${plural(lib.components.filter((c) => c.valid).length, "component")} agents can use now.`);
      onInstalled();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Add a library"
      about="Libraries are data: they render yaah's building blocks and can only read the sources they list. Private repos use your git credentials or your GitHub connection."
    >
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          inspectUrl();
        }}
      >
        <div className="flex min-w-56 flex-1 flex-col gap-1.5">
          <Label htmlFor="library-url">Git URL</Label>
          <Input
            id="library-url"
            value={url}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://github.com/acme-inc/yaah-components"
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="flex w-36 flex-col gap-1.5">
          <Label htmlFor="library-ref">Tag or branch</Label>
          <Input id="library-ref" value={ref} spellCheck={false} autoComplete="off" placeholder="default" onChange={(e) => setRef(e.target.value)} />
        </div>
        <Button type="submit" variant="outline" disabled={!url.trim() || !!busy}>
          {busy === "inspect" ? <Loader2 className="animate-spin" /> : <Search />} Inspect
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>or</span>
        <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => void chooseFolder()}>
          <FolderOpen /> Choose folder…
        </Button>
        <span>A folder is read in place, so your edits show without reinstalling.</span>
      </div>

      <ErrorText error={error} className="text-sm whitespace-pre-wrap" />
      {done && (
        <p className="text-sm" role="status">
          {done}
        </p>
      )}
      {preview && (
        <PreviewCard
          p={preview}
          replacing={libs.find((l) => l.id === preview.replaces)}
          installedIds={libs.map((l) => l.id)}
          busy={busy === "install"}
          onInstall={() => void install()}
          onCancel={() => setPreview(null)}
        />
      )}
    </Section>
  );
}

function PreviewCard({
  p,
  replacing,
  installedIds,
  busy,
  onInstall,
  onCancel,
}: {
  p: LibraryPreview;
  replacing: LibraryInfo | undefined;
  installedIds: string[];
  busy: boolean;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const valid = p.components.filter((c) => c.valid);
  const invalid = p.components.filter((c) => !c.valid);
  // The preview opens below the fold: bring it into view.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Braces matter: browsers' scrollIntoView can return a promise, and an effect must not.
    void ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [p.stagingId]);
  return (
    <section ref={ref} aria-label={`Preview of ${p.title}`} className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Package className="size-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold">{p.title}</h4>
          {p.version && <span className="text-xs text-muted-foreground tabular-nums">v{p.version}</span>}
          <Badge variant="outline" className="font-mono">
            {p.id}
          </Badge>
          {p.homepage && isWebUrl(p.homepage) && (
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => openExternal(p.homepage)}
            >
              <ExternalLink className="size-3" /> homepage
            </button>
          )}
        </div>
        {p.publisher && <p className="text-xs text-muted-foreground">by {p.publisher}</p>}
        {p.description && <p className="text-sm">{p.description}</p>}
        {p.source && (
          <p className="text-[11px] text-muted-foreground">
            <SourceLine source={p.source} commit={p.commit} />
          </p>
        )}
      </header>

      {p.replaces && (
        <Alert>
          <RefreshCw />
          <AlertTitle>Replaces the installed “{replacing?.title ?? p.replaces}”</AlertTitle>
          <AlertDescription>
            {replacing?.version && p.version && replacing.version !== p.version
              ? `Installing swaps v${replacing.version} for v${p.version}. `
              : "Installing swaps the installed copy for this one. "}
            Its components keep their names ({p.id}/…).
          </AlertDescription>
        </Alert>
      )}

      <Detail label="Reads">
        {p.reads.length ? (
          <Reads bare reads={p.reads} needs={[]} installedIds={installedIds} />
        ) : (
          <span className="text-xs text-muted-foreground">Nothing: its components only show what agents pass them.</span>
        )}
      </Detail>
      {p.needs.length > 0 && (
        <Detail label="Uses">
          <Reads bare reads={[]} needs={p.needs} installedIds={installedIds} />
        </Detail>
      )}
      {p.errors.length > 0 && (
        <Detail label="Problems">
          <ProblemList errors={p.errors} invalid={[]} />
        </Detail>
      )}

      <Detail label={`${plural(p.components.length, "component")}${invalid.length ? `, ${invalid.length} won't load` : ""}`}>
        <ul className="flex flex-col divide-y rounded-md border">
          {p.components.map((c) => (
            <li key={c.name} className="flex flex-col gap-0.5 px-3 py-2">
              <span className="flex items-center gap-1.5">
                {!c.valid && <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-label="Invalid" />}
                <span className={cn("font-mono text-xs", !c.valid && "text-muted-foreground line-through")}>{c.name}</span>
              </span>
              {c.description && <span className="line-clamp-2 text-xs text-muted-foreground">{c.description}</span>}
              {!c.valid && <span className="text-xs text-destructive">Won't load: {c.error ?? "invalid"}</span>}
            </li>
          ))}
        </ul>
      </Detail>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || valid.length === 0} onClick={onInstall}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />}
          {p.replaces ? "Install and replace" : "Install"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-xs text-muted-foreground">
          {valid.length === 0 ? "No component in it can load." : `${plural(valid.length, "component")} will be available to agents.`}
        </span>
      </div>
    </section>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h5 className="text-xs font-medium text-muted-foreground">{label}</h5>
      {children}
    </div>
  );
}
