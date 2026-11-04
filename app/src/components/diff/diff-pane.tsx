// A diff pane: the working tree's changes of a git repository, beside the chats and shells.
// The pane's content is `{ kind: "diff", cwd, mode, base }` (layout.ts, saved with the layout).
// Rust reads everything (sources/git.rs `working_view`: repo detection, the diff in a mode, a
// fingerprint); this polls with that fingerprint, so a quiet repo costs one `git status` and a
// change refreshes the files list, keeping what was ticked as viewed. Read-only: no staging.
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, FolderSearch, GitCompare, RefreshCw, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { TerminalFolders } from "@/components/terminal/terminal-folders";
import DiffReview from "@/components/ui-blocks/diff-review";
import { UiViewContext } from "@/components/ui-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Project, SessionInfo } from "@/lib/api";
import { diffApi, type DiffView } from "@/lib/diff-api";
import { baseName, compactPath, plural } from "@/lib/format";
import type { DiffMode, Selection } from "@/lib/layout";
import { clearPaneInfo, setPaneInfo } from "@/lib/pane-info";
import { openInTerminalApp } from "@/lib/terminal-api";

type DiffContent = Extract<Selection, { kind: "diff" }>;

/** How often a visible pane asks Rust whether the repo moved. */
const POLL_MS = 3000;

const MODES: { value: DiffMode; label: string }[] = [
  { value: "all", label: "All changes" },
  { value: "staged", label: "Staged" },
  { value: "unstaged", label: "Unstaged" },
  { value: "branch", label: "Against a branch" },
];

const EMPTY: Record<DiffMode, string> = {
  all: "No changes",
  staged: "Nothing staged",
  unstaged: "No unstaged changes",
  branch: "No changes",
};

const FILL = { expanded: true };

export function DiffPane({
  pane,
  content,
  chats,
  projects,
  onContent,
  onClose,
}: {
  pane: string;
  content: DiffContent;
  /** For the folder step of a pane opened without one. */
  chats: SessionInfo[];
  projects: Project[];
  onContent: (c: DiffContent) => void;
  onClose: () => void;
}) {
  const { cwd } = content;
  const mode: DiffMode = content.mode ?? "all";
  const [view, setView] = useState<DiffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ content, view });
  useEffect(() => {
    latest.current = { content, view };
  });

  // The view belongs to a folder, mode and base: another one starts clean.
  const key = `${cwd ?? ""}\n${mode}\n${content.base ?? ""}`;
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setView(null);
    setError(null);
  }

  const load = useCallback(
    async (force: boolean) => {
      if (!cwd) return;
      const { content: c, view: v } = latest.current;
      setBusy(force);
      try {
        const next = await diffApi.read(cwd, c.mode ?? "all", c.base, force ? undefined : v?.fingerprint);
        if (latest.current.content.cwd !== cwd) return;
        setError(null);
        // Nothing moved: keep what is drawn (a new object would redraw the diff).
        setView((was) => (next.unchanged && was ? was : next));
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [cwd],
  );

  // On mount and whenever what is compared changes; then while the window is in sight, every few seconds.
  useEffect(() => {
    // Not in the effect's own body: the read sets state when it lands.
    const first = setTimeout(() => void load(true), 0);
    if (!cwd) return () => clearTimeout(first);
    const t = setInterval(() => {
      if (!document.hidden) void load(false);
    }, POLL_MS);
    const onVisible = () => !document.hidden && void load(false);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, cwd, key]);

  // The base Rust picked is kept, so the choice is saved with the layout.
  useEffect(() => {
    if (mode === "branch" && !content.base && view?.base) onContent({ ...content, base: view.base });
  }, [mode, content, view?.base, onContent]);

  const repo = view?.repo ?? null;
  const diff = view?.diff;
  const count = diff ? (Array.isArray(diff.files) ? diff.files.length : 0) : null;
  const name = repo?.name ?? (cwd ? baseName(cwd) : "Diff");

  // What the sidebar lists this pane as.
  const detail = !cwd
    ? "no folder yet"
    : view?.repo === null
      ? "not a repository"
      : count == null
        ? undefined
        : count === 0
          ? "no changes"
          : plural(count, "change");
  useEffect(() => {
    setPaneInfo(pane, { title: name, detail });
  }, [pane, name, detail]);
  useEffect(() => () => clearPaneInfo(pane), [pane]);

  const choose = async () => {
    const dir = await open({ directory: true, title: "Folder with the repository" });
    if (typeof dir === "string") onContent({ kind: "diff", cwd: dir });
  };

  const header = (
    <header data-tauri-drag-region="deep" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-background px-4 py-2.5 text-sm">
      <GitCompare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 font-medium">{cwd ? `Diff · ${name}` : "Diff"}</span>
      {repo?.branch && (
        <Badge variant="outline" className="font-mono">
          {repo.branch}
        </Badge>
      )}
      {repo?.detached && <Badge variant="outline">detached HEAD</Badge>}
      {repo && (
        <>
          <Select value={mode} onValueChange={(m) => onContent({ kind: "diff", cwd, mode: m as DiffMode, base: content.base })}>
            <SelectTrigger size="sm" className="w-auto" aria-label="What to compare">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mode === "branch" && (
            <Select value={content.base ?? view?.base ?? ""} onValueChange={(b) => onContent({ kind: "diff", cwd, mode, base: b })}>
              <SelectTrigger size="sm" className="w-auto max-w-48 font-mono" aria-label="Base branch">
                <SelectValue placeholder="Pick a base" />
              </SelectTrigger>
              <SelectContent>
                {(view?.branches ?? []).map((b) => (
                  <SelectItem key={b} value={b} className="font-mono">
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </>
      )}
      <span className="ml-auto flex min-w-0 items-center gap-1">
        {cwd && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={cwd}>
            {compactPath(cwd)}
          </span>
        )}
        {cwd && (
          <Button size="icon-xs" variant="ghost" title="Choose another folder" aria-label="Choose another folder" onClick={() => void choose()}>
            <FolderSearch />
          </Button>
        )}
        {cwd && (
          <Button size="icon-xs" variant="ghost" title="Refresh" aria-label="Refresh the diff" disabled={busy} onClick={() => void load(true)}>
            <RefreshCw className={busy ? "animate-spin motion-reduce:animate-none" : undefined} />
          </Button>
        )}
        {cwd && (
          <Button
            size="icon-xs"
            variant="ghost"
            title="Open this folder in your terminal app"
            aria-label="Open in terminal app"
            onClick={() => openInTerminalApp(repo?.root ?? cwd)}
          >
            <ExternalLink />
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" title="Close the pane" aria-label="Close diff pane" onClick={onClose}>
          <X />
        </Button>
      </span>
    </header>
  );

  let body;
  if (!cwd) {
    body = (
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 py-8">
        <div className="flex h-fit w-full max-w-md flex-col gap-3">
          <div className="flex flex-col gap-1 px-1">
            <h2 className="text-sm font-medium">Open a diff</h2>
            <p className="text-xs text-muted-foreground">The changes of a git repository. Which folder?</p>
          </div>
          <TerminalFolders
            purpose="diff"
            chats={chats}
            projects={projects}
            onPick={(dir) => dir && onContent({ kind: "diff", cwd: dir })}
            onBack={onClose}
          />
        </div>
      </div>
    );
  } else if (error) {
    body = (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
        <p className="max-w-md text-center text-muted-foreground">Couldn't read the changes: {error}</p>
        <Button variant="outline" size="sm" onClick={() => void load(true)}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );
  } else if (view?.repo === null) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
        <p className="max-w-md text-center text-muted-foreground">
          <span className="font-mono">{compactPath(cwd)}</span> isn't in a git repository, so there are no changes to show.
        </p>
        <Button variant="outline" size="sm" onClick={() => void choose()}>
          <FolderSearch /> Choose another folder
        </Button>
      </div>
    );
  } else if (!diff) {
    body = <div className="flex-1" aria-busy="true" />;
  } else {
    const untracked = view?.untracked ?? [];
    body = (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        {count === 0 ? (
          <p role="status" className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
            {EMPTY[mode]} in <span className="font-mono">{name}</span>
            {mode === "branch" && view?.base ? ` against ${view.base}` : ""}.
          </p>
        ) : (
          <UiViewContext.Provider value={FILL}>
            <DiffReview
              key={`${repo?.root}\n${mode}\n${view?.base ?? ""}`}
              text={diff.text}
              files={diff.files}
              title={name}
              range={diff.range}
              truncated={diff.truncated}
              name="diff-pane"
            />
          </UiViewContext.Provider>
        )}
        {untracked.length > 0 && mode !== "staged" && (
          <p role="status" className="shrink-0 px-1 text-xs text-muted-foreground" title={untracked.join("\n")}>
            {plural(untracked.length, "untracked file")} not shown (git doesn't diff files it doesn't track):{" "}
            <span className="font-mono">{untracked.slice(0, 3).join(", ")}</span>
            {untracked.length > 3 ? ` and ${untracked.length - 3} more` : ""}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {header}
      {body}
    </div>
  );
}
