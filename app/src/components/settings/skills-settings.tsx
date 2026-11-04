// Settings → Skills: the skills each agent yaah runs can load, and a quick
// install from GitHub. A skill is a folder with a SKILL.md (name and
// description) plus any files and scripts it needs. Rust finds the folders,
// reads the repos, checks the limits and writes the files; this screen only
// shows what it reports and passes along what the user picked.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BookOpen,
  CircleAlert,
  Download,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ErrorText } from "@/components/error-text";
import { NavHeading, NavNote, NavRow, Panel, PanelHeader, TwoPane } from "@/components/settings/parts";
import { api, type InstalledSkill, type SkillInstalled, type SkillLocation, type SkillLookup, type SkillsOverview } from "@/lib/api";
import { compactPath, formatAgo, formatBytes, plural } from "@/lib/format";
import { openExternal } from "@/lib/links";
import { cn } from "@/lib/utils";

const INSTALL = "install";

export function SkillsSettings() {
  const [overview, setOverview] = useState<SkillsOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const load = () => {
    api.listSkills().then(setOverview, setError);
  };
  useEffect(load, []);

  // Until something is picked: the first skills folder, or the installer.
  const selected = picked ?? overview?.locations[0]?.dir ?? INSTALL;
  const current = overview?.locations.find((l) => l.dir === selected);
  return (
    <TwoPane
      label="Skills"
      nav={
        <>
          <NavHeading>Installed</NavHeading>
          {!overview && !error && <NavNote loading>Reading skills folders…</NavNote>}
          {overview?.locations.length === 0 && <NavNote>No agent with a skills folder yet.</NavNote>}
          {overview?.locations.map((l) => (
            <NavRow
              key={l.dir}
              active={selected === l.dir}
              onClick={() => setPicked(l.dir)}
              icon={<FolderOpen className="size-3.5 text-muted-foreground" />}
              label={l.label}
              hint={<span className="font-mono">{compactPath(l.dir)}</span>}
              note={plural(l.skills.length, "skill")}
              end={<span className="text-xs text-muted-foreground tabular-nums">{l.skills.length}</span>}
            />
          ))}
          <Separator className="my-2" />
          <NavHeading>Add</NavHeading>
          <NavRow
            active={selected === INSTALL}
            onClick={() => setPicked(INSTALL)}
            icon={<Download className="size-3.5 text-muted-foreground" />}
            label="Install from GitHub"
          />
        </>
      }
    >
      <ErrorText error={error} className="p-6 text-sm" />
      {overview && selected === INSTALL && <InstallPanel overview={overview} onInstalled={load} onShow={setPicked} />}
      {overview && current && (
        <LocationPanel key={current.dir} l={current} unsupported={overview.unsupported} onChanged={load} onInstall={() => setPicked(INSTALL)} />
      )}
    </TwoPane>
  );
}

function TrustNote() {
  return (
    <Alert>
      <ShieldAlert />
      <AlertTitle>Install skills only from sources you trust</AlertTitle>
      <AlertDescription>
        A skill can include scripts, and the agent may run them when it uses the skill. yaah never runs anything it downloads, but your agent might.
        Read a skill before installing it.
      </AlertDescription>
    </Alert>
  );
}

// ── Installed ───────────────────────────────────────────────────────────────

function LocationPanel({
  l,
  unsupported,
  onChanged,
  onInstall,
}: {
  l: SkillLocation;
  unsupported: SkillsOverview["unsupported"];
  onChanged: () => void;
  onInstall: () => void;
}) {
  return (
    <Panel>
      <PanelHeader
        icon={<FolderOpen className="size-3.5 text-muted-foreground" />}
        title={l.label}
        extra={
          <Badge variant="outline" className="font-mono">
            {compactPath(l.dir)}
          </Badge>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>Read by</span>
          {l.agents.map((a) => (
            <Badge key={a.id} variant="secondary">
              {a.label}
            </Badge>
          ))}
          <button type="button" className="ml-1 inline-flex items-center gap-1 underline underline-offset-2" onClick={() => openExternal(l.docs)}>
            <BookOpen className="size-3" /> docs
          </button>
        </div>
      </PanelHeader>

      {l.skills.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          <span>{l.exists ? "No skills in this folder yet." : "This folder doesn't exist yet; installing a skill creates it."}</span>
          <Button size="sm" variant="outline" onClick={onInstall}>
            <Download /> Install from GitHub
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {l.skills.map((s) => (
            <SkillRow key={s.dir} s={s} onChanged={onChanged} />
          ))}
        </ul>
      )}

      {unsupported.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not shown: {unsupported.map((a) => a.label).join(", ")}. Their docs don't confirm a skills folder yaah can manage.
        </p>
      )}
    </Panel>
  );
}

function SkillRow({ s, onChanged }: { s: InstalledSkill; onChanged: () => void }) {
  const [busy, setBusy] = useState<"update" | "remove" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  // "Delete folder?" goes back to "Remove" after a few seconds.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const update = async () => {
    setBusy("update");
    setNote(null);
    setError(null);
    try {
      const r = await api.skillsUpdate(s.dir);
      setNote(r.updated ? `Updated to ${r.sha.slice(0, 7)}.` : "Already up to date.");
      if (r.updated) onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!confirming) return setConfirming(true);
    setBusy("remove");
    setError(null);
    try {
      await api.skillsRemove(s.dir);
      onChanged();
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  };

  return (
    <li className="flex flex-col gap-1.5 p-3">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{s.name}</span>
            {s.folder !== s.name && <span className="font-mono text-xs text-muted-foreground">{s.folder}/</span>}
            {s.linked && (
              <Badge variant="outline" className="gap-1">
                <Link2 className="size-3" /> linked
              </Badge>
            )}
          </div>
          {s.description && <p className="line-clamp-2 text-xs text-muted-foreground">{s.description}</p>}
          {s.problem && (
            <p className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
              <CircleAlert className="size-3" /> {s.problem}
            </p>
          )}
          <p className="flex flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground">
            {s.source ? (
              <>
                <GitBranch className="size-3" />
                <SourceLink source={s.source} className="font-mono" />
                <span>
                  · {s.source.ref} @ {s.source.sha.slice(0, 7)} · installed {formatAgo(s.source.installedAt)}
                </span>
              </>
            ) : (
              <span>{s.linked ? "Linked from elsewhere" : "Added outside yaah"}</span>
            )}
            <span>· {plural(s.files, "file")}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {s.source && (
            <Button size="xs" variant="ghost" disabled={!!busy} onClick={() => void update()} title="Fetch the latest from the same branch">
              {busy === "update" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Update
            </Button>
          )}
          <Button
            size="xs"
            variant={confirming ? "destructive" : "ghost"}
            className={cn(!confirming && "text-destructive")}
            disabled={!!busy}
            aria-label={confirming ? undefined : `Remove ${s.name}`}
            onClick={() => void remove()}
          >
            {busy === "remove" ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {confirming ? (s.linked ? "Remove link?" : "Delete folder?") : "Remove"}
          </Button>
        </div>
      </div>
      {note && (
        <p className="text-xs text-muted-foreground" role="status">
          {note}
        </p>
      )}
      <ErrorText error={error} />
    </li>
  );
}

/** A repo (and folder in it) on github.com. */
function SourceLink({
  source,
  className,
  children,
}: {
  source: { repo: string; ref: string; path: string };
  className?: string;
  children?: ReactNode;
}) {
  const url = `https://github.com/${source.repo}/tree/${source.ref}${source.path ? `/${source.path}` : ""}`;
  return (
    <button type="button" className={cn("underline-offset-2 hover:underline", className)} onClick={() => openExternal(url)}>
      {source.repo}
      {source.path && `/${source.path}`}
      {children}
    </button>
  );
}

// ── Install from GitHub ─────────────────────────────────────────────────────

function InstallPanel({ overview, onInstalled, onShow }: { overview: SkillsOverview; onInstalled: () => void; onShow: (dir: string) => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"lookup" | "install" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [found, setFound] = useState<SkillLookup | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState(overview.defaultTarget ?? overview.locations[0]?.dir ?? "");
  const [replace, setReplace] = useState(false);
  const [results, setResults] = useState<SkillInstalled[] | null>(null);

  const lookup = async (source = input) => {
    if (!source.trim() || busy) return;
    setInput(source);
    setBusy("lookup");
    setError(null);
    setFound(null);
    setResults(null);
    try {
      const r = await api.skillsLookup(source.trim());
      setFound(r);
      const installable = r.skills.filter((s) => !s.problem);
      setPicked(new Set(installable.length === 1 ? [installable[0].path] : []));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const clashes = useMemo(() => found?.skills.filter((s) => picked.has(s.path) && s.installedIn.includes(target)) ?? [], [found, picked, target]);
  const install = async () => {
    if (!found || picked.size === 0 || busy) return;
    setBusy("install");
    setError(null);
    try {
      const r = await api.skillsInstall({ repo: found.repo, ref: found.ref, sha: found.sha, paths: [...picked], target, replace });
      setResults(r);
      const done = new Set(r.filter((x) => !x.error).map((x) => x.path));
      setFound({
        ...found,
        skills: found.skills.map((s) =>
          done.has(s.path) && !s.installedIn.includes(target) ? { ...s, installedIn: [...s.installedIn, target] } : s,
        ),
      });
      setPicked(new Set([...picked].filter((p) => !done.has(p))));
      setReplace(false);
      onInstalled();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (path: string, on: boolean) => setPicked((p) => (on ? new Set(p).add(path) : new Set([...p].filter((x) => x !== path))));
  const installable = found?.skills.filter((s) => !s.problem) ?? [];
  const targetLocation = overview.locations.find((l) => l.dir === target);

  return (
    <Panel>
      <PanelHeader icon={<Download className="size-3.5 text-muted-foreground" />} title="Install from GitHub">
        <p className="text-sm text-muted-foreground">
          Paste <span className="font-mono text-xs">owner/repo</span>, a folder in it, or a github.com link. yaah finds every folder with a SKILL.md
          and shows what each one does before you install.
        </p>
      </PanelHeader>

      <TrustNote />

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void lookup();
        }}
      >
        <Label htmlFor="skills-source">Source</Label>
        <div className="flex gap-2">
          <Input
            id="skills-source"
            value={input}
            placeholder="anthropics/skills, or https://github.com/owner/repo/tree/main/skills/x"
            onChange={(e) => setInput(e.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={!input.trim() || !!busy}>
            {busy === "lookup" ? <Loader2 className="animate-spin" /> : <Search />}
            Look up
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Suggested:</span>
          {overview.suggested.map((s) => (
            <Button key={s.repo} type="button" size="xs" variant="secondary" title={s.about} disabled={!!busy} onClick={() => void lookup(s.repo)}>
              <Sparkles /> {s.repo}
            </Button>
          ))}
        </div>
      </form>

      <ErrorText error={error} className="text-sm" />

      {found && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <SourceLink source={found} className="inline-flex items-center gap-1 font-mono font-medium">
              <ExternalLink className="size-3" />
            </SourceLink>
            <span className="text-xs text-muted-foreground">
              {found.ref} @ {found.sha.slice(0, 7)} · {plural(found.skills.length, "skill")}
            </span>
            {installable.length > 1 && (
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                onClick={() => setPicked(picked.size === installable.length ? new Set() : new Set(installable.map((s) => s.path)))}
              >
                {picked.size === installable.length ? "Select none" : "Select all"}
              </Button>
            )}
          </div>
          {!found.authenticated && (
            <p className="text-xs text-muted-foreground">
              Not signed in to GitHub: lookups count against GitHub's 60 requests an hour. Connect GitHub in Integrations for more, and for private
              repos.
            </p>
          )}
          {found.notes.map((n) => (
            <p key={n} className="text-xs text-amber-700 dark:text-amber-400">
              {n}
            </p>
          ))}
          <ul className="flex flex-col divide-y rounded-lg border">
            {found.skills.map((s) => {
              const id = `skill-${s.path || "root"}`;
              return (
                <li key={s.path} className={cn("flex items-start gap-3 p-3", s.problem && "opacity-70")}>
                  <Checkbox
                    id={id}
                    className="mt-0.5"
                    disabled={!!s.problem}
                    checked={picked.has(s.path)}
                    onCheckedChange={(v) => toggle(s.path, v === true)}
                  />
                  <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{s.name}</span>
                      {s.folder !== s.name && <span className="font-mono text-xs text-muted-foreground">{s.folder}/</span>}
                      {s.installedIn.includes(target) && <Badge variant="outline">installed</Badge>}
                    </span>
                    {s.description && <span className="line-clamp-2 text-xs text-muted-foreground">{s.description}</span>}
                    <span className="text-2xs text-muted-foreground">
                      {s.path || "(repo root)"} · {plural(s.files, "file")} · {formatBytes(s.bytes)}
                      {s.skipped.length > 0 && ` · skips ${plural(s.skipped.length, "symlink or submodule", "symlinks or submodules")}`}
                    </span>
                    {s.problem && (
                      <span className="flex items-center gap-1 text-xs text-destructive">
                        <CircleAlert className="size-3" /> Can't install: {s.problem}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="skills-target" className="text-sm">
                Install into
              </Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger id="skills-target" size="sm" className="min-w-56">
                  <SelectValue placeholder="Pick a skills folder" />
                </SelectTrigger>
                <SelectContent>
                  {overview.locations.map((l) => (
                    <SelectItem key={l.dir} value={l.dir}>
                      {l.label} <span className="font-mono text-xs text-muted-foreground">{compactPath(l.dir)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="ml-auto"
                disabled={picked.size === 0 || !target || !!busy || (clashes.length > 0 && !replace)}
                onClick={() => void install()}
              >
                {busy === "install" ? <Loader2 className="animate-spin" /> : <Download />}
                {picked.size ? `Install ${plural(picked.size, "skill")}` : "Install skills"}
              </Button>
            </div>
            {clashes.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <Switch id="skills-replace" checked={replace} onCheckedChange={setReplace} />
                <Label htmlFor="skills-replace" className="text-xs font-normal">
                  Replace what's already installed ({clashes.map((c) => c.folder).join(", ")})
                </Label>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Read by {targetLocation?.agents.map((a) => a.label).join(", ") || "—"}. Pinned to {found.sha.slice(0, 7)}; Update later fetches the
              newest {found.ref}.
            </p>
          </div>
        </section>
      )}

      {results && (
        <section className="flex flex-col gap-1.5" role="status">
          {results.map((r) => (
            <p key={r.path} className={cn("flex items-start gap-1.5 text-sm", r.error && "text-destructive")}>
              {r.error ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <Download className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <span>
                <span className="font-medium">{r.folder}</span>
                {r.error ? `: ${r.error}` : ` installed${targetLocation ? ` for ${targetLocation.label}` : ""}.`}
              </span>
            </p>
          ))}
          {results.some((r) => !r.error) && (
            <Button size="xs" variant="link" className="self-start px-0" onClick={() => onShow(target)}>
              Show installed skills
            </Button>
          )}
        </section>
      )}
    </Panel>
  );
}
