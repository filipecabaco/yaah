import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, GitBranch, Loader2, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type Repo } from "@/lib/api";
import { baseName, compactPath } from "@/lib/format";
import { ErrorText } from "@/components/error-text";
import { fuzzyRank } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Folders already in the project; shown as added and not selectable. */
  exclude: string[];
  onAdd: (dirs: string[]) => Promise<void> | void;
};

/**
 * Pick repos to add to a project: every git repo under the workspace
 * folder(s), fuzzy-searchable, multi-select. Also clones by `owner/repo` or
 * URL, and falls back to a native folder picker for anything else.
 */
export function RepoPicker({ open: isOpen, onClose, exclude, onAdd }: Props) {
  const [roots, setRoots] = useState<string[]>([]);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [cloneSource, setCloneSource] = useState("");
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Each time it opens: a clean slate, and a fresh scan.
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setQuery("");
      setSelected([]);
      setCloneSource("");
      setError(null);
      setRepos(null);
    }
  }
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    api.listRepos().then((res) => {
      if (!live) return;
      setRoots(res.roots);
      setRepos(res.repos);
    }, setError);
    return () => {
      live = false;
    };
  }, [isOpen]);

  // Name hits rank above owner/repo hits, which rank above path hits.
  const matches = useMemo(() => fuzzyRank(repos ?? [], query, (r) => [r.name, r.remote, r.path]), [repos, query]);
  // The highlight starts on the first repo that can still be added, each time the list changes.
  const [moved, setMoved] = useState<{ in: typeof matches; at: number } | null>(null);
  const cursor =
    moved?.in === matches
      ? moved.at
      : Math.max(
          0,
          matches.findIndex((m) => !exclude.includes(m.path)),
        );
  const setCursor = (at: number) => setMoved({ in: matches, at });

  function toggle(path: string) {
    if (exclude.includes(path)) return;
    setSelected((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path]));
  }

  async function changeRoots(next: string[]) {
    setError(null);
    try {
      await api.setWorkspaceRoots(next);
      setRepos(null);
      const res = await api.listRepos();
      setRoots(res.roots);
      setRepos(res.repos);
    } catch (e) {
      setError(e);
    }
  }

  async function addRoot() {
    try {
      const dir = await open({ directory: true, title: "Folder where you keep your repos" });
      if (typeof dir === "string" && !roots.includes(dir)) await changeRoots([...roots, dir]);
    } catch (e) {
      setError(e);
    }
  }

  async function browse() {
    let picked: string | string[] | null;
    try {
      picked = await open({ directory: true, multiple: true });
    } catch (e) {
      return setError(e);
    }
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    setSelected((s) => [...s, ...list.filter((d) => !s.includes(d) && !exclude.includes(d))]);
    // Show picked folders that aren't under a root, so they can be seen and unticked.
    setRepos((r) => [
      ...list.filter((d) => !r?.some((x) => x.path === d)).map((d) => ({ name: baseName(d), path: d, remote: null, branch: null })),
      ...(r ?? []),
    ]);
  }

  async function clone() {
    if (!cloneSource.trim() || !roots[0]) return;
    setCloning(true);
    setError(null);
    try {
      const repo = await api.cloneRepo(cloneSource, roots[0]);
      setRepos((r) => [repo, ...(r ?? [])]);
      setSelected((s) => [...s, repo.path]);
      setCloneSource("");
      setQuery("");
    } catch (err) {
      setError(err);
    } finally {
      setCloning(false);
    }
  }

  async function add() {
    try {
      await onAdd(selected);
      onClose();
    } catch (e) {
      setError(e);
    }
  }

  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(matches.length - 1, cursor + (e.key === "ArrowDown" ? 1 : -1)));
      setCursor(next);
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Enter toggles the highlighted repo; ⌘/Ctrl+Enter adds the selection.
      if ((e.metaKey || e.ctrlKey) && selected.length) void add();
      else if (matches[cursor]) toggle(matches[cursor].path);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-3 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add repos</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1">
            Repos in
            {roots.map((r) => (
              <Badge key={r} variant="secondary" className="gap-1 font-mono">
                {compactPath(r)}
                {roots.length > 1 && (
                  <button
                    type="button"
                    onClick={() => void changeRoots(roots.filter((x) => x !== r))}
                    title="Stop scanning this folder"
                    aria-label={`Stop scanning ${compactPath(r)}`}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </Badge>
            ))}
            {roots.length === 0 && <span>no workspace folder yet</span>}
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void addRoot()}>
              {roots.length ? "add folder" : "choose one"}
            </Button>
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            role="combobox"
            aria-label="Search repos"
            aria-expanded
            aria-controls="repo-picker-list"
            aria-autocomplete="list"
            aria-activedescendant={matches[cursor] ? `repo-option-${cursor}` : undefined}
            placeholder="Search by name, owner/repo or path…"
            className="pl-8"
          />
        </div>

        <div ref={listRef} className="-mx-1 h-72 overflow-y-auto px-1" id="repo-picker-list" role="listbox" aria-label="Repos" aria-multiselectable>
          {repos == null ? (
            <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Looking for repos…
            </p>
          ) : matches.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              {repos.length === 0 ? "No git repos found here." : "No repo matches. Clone it below?"}
            </p>
          ) : (
            matches.map((r, i) => {
              const added = exclude.includes(r.path);
              const checked = added || selected.includes(r.path);
              return (
                <div
                  key={r.path}
                  id={`repo-option-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={checked}
                  aria-disabled={added}
                  onClick={() => toggle(r.path)}
                  onMouseMove={() => setCursor(i)}
                  className={cn("flex cursor-default items-center gap-3 rounded-md px-2 py-1.5", i === cursor && "bg-muted", added && "opacity-50")}
                >
                  <Checkbox checked={checked} disabled={added} tabIndex={-1} aria-hidden className="pointer-events-none" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{r.name}</span>
                      {r.remote && r.remote !== r.name && <span className="truncate text-xs text-muted-foreground">{r.remote}</span>}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{compactPath(r.path)}</div>
                  </div>
                  {added ? (
                    <Badge variant="outline">added</Badge>
                  ) : (
                    r.branch && (
                      <span className="flex max-w-40 shrink-0 items-center gap-1 truncate text-xs text-muted-foreground">
                        <GitBranch className="size-3 shrink-0" />
                        <span className="truncate">{r.branch}</span>
                      </span>
                    )
                  )}
                </div>
              );
            })
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void clone();
          }}
          className="flex gap-2"
        >
          <Input
            aria-label="Clone a repo: owner/repo or a git URL"
            value={cloneSource}
            onChange={(e) => setCloneSource(e.target.value)}
            placeholder="Clone: owner/repo or a git URL"
            disabled={cloning || !roots[0]}
            className="font-mono text-xs"
          />
          <Button type="submit" variant="secondary" disabled={cloning || !cloneSource.trim() || !roots[0]}>
            {cloning && <Loader2 className="animate-spin" />}
            {cloning ? "Cloning…" : "Clone"}
          </Button>
        </form>

        <ErrorText error={error} className="text-sm whitespace-pre-wrap" />

        <DialogFooter className="items-center sm:justify-between">
          <Button variant="ghost" size="sm" onClick={() => void browse()}>
            <FolderOpen /> Browse…
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void add()} disabled={selected.length === 0}>
              {selected.length > 1 ? `Add ${selected.length} repos` : "Add repo"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
