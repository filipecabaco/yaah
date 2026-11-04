import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, GitBranch, Loader2, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { api, type Repo } from "@/lib/api";
import { baseName, compactPath } from "@/lib/format";
import { ErrorText } from "@/components/error-text";
import { fuzzyRank } from "@/lib/fuzzy";
import { MOD } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Folders already in the project; shown as added and not selectable. */
  exclude: string[];
  onAdd: (dirs: string[]) => Promise<void> | void;
  /**
   * "Add to this chat" mode (⌘K, `/repos`, a chat's folder menu): the chat's project name when it
   * has one (the repos join the project, so all its chats get them), `null` for a quick chat
   * (they are the chat's own). Unset: picking repos for a project or a new chat.
   */
  addTo?: { project: string | null };
};

/** What the picker's heading and note say in "add to this chat" mode. */
function addToCopy(addTo: { project: string | null }) {
  return addTo.project
    ? {
        title: `Add repositories to ${addTo.project}`,
        note: "They join the project: this chat and every other chat in it work in them from the next message.",
      }
    : { title: "Add repositories to this chat", note: "Only this chat gets them, from the next message." };
}

/**
 * Pick repos to add to a project: every git repo under the workspace
 * folder(s), fuzzy-searchable, multi-select. Also clones by `owner/repo` or
 * URL, and falls back to a native folder picker for anything else.
 */
export function RepoPicker({ open: isOpen, onClose, exclude, onAdd, addTo }: Props) {
  const copy = addTo ? addToCopy(addTo) : null;
  const [roots, setRoots] = useState<string[]>([]);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [cloneSource, setCloneSource] = useState("");
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** A Space that ticked a repo: its character must not land in the search either. */
  const spaceTaken = useRef(false);
  // A cancelled keydown already keeps it out in browsers; this covers input that arrives
  // as its own event after the keydown (automation, some input methods).
  const attachSearch = useCallback((input: HTMLInputElement | null) => {
    searchRef.current = input;
    if (!input) return;
    const onBeforeInput = (e: InputEvent) => {
      if (spaceTaken.current && e.data === " ") e.preventDefault();
      spaceTaken.current = false;
    };
    const onKeyUp = () => (spaceTaken.current = false);
    input.addEventListener("beforeinput", onBeforeInput);
    input.addEventListener("keyup", onKeyUp);
    return () => {
      searchRef.current = null;
      input.removeEventListener("beforeinput", onBeforeInput);
      input.removeEventListener("keyup", onKeyUp);
    };
  }, []);

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
  const canAdd = (i: number) => !!matches[i] && !exclude.includes(matches[i].path);
  // The highlight starts on the first repo that can still be added, each time the list changes (typing, a scan);
  // -1 when there's none.
  const [moved, setMoved] = useState<{ in: typeof matches; at: number } | null>(null);
  const cursor = moved?.in === matches ? moved.at : matches.findIndex((m) => !exclude.includes(m.path));
  const setCursor = (at: number) => setMoved({ in: matches, at });
  const listId = useId();
  const optionId = (i: number) => `${listId}-option-${i}`;
  const highlighted = cursor >= 0 ? matches[cursor] : undefined;

  // The highlighted row stays in view, however it moved.
  useEffect(() => {
    if (cursor >= 0) listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor, matches]);

  /** The next row that can be added, `d` away; the highlight stays put at either end. */
  function step(d: 1 | -1) {
    for (let i = cursor + d; i >= 0 && i < matches.length; i += d) if (canAdd(i)) return setCursor(i);
  }

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

  async function add(dirs = selected) {
    if (dirs.length === 0) return;
    try {
      await onAdd(dirs);
      onClose();
    } catch (e) {
      setError(e);
    }
  }

  /**
   * The list is driven from the search box (focus never leaves it): ↑/↓ move the highlight,
   * Space or Enter tick the highlighted repo, Enter on the only match adds it, ⌘/Ctrl+Enter
   * adds the selection (or the highlighted repo when nothing is ticked). Esc closes (the dialog's own).
   */
  function onSearchKey(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing || e.altKey) return;
    const mod = e.metaKey || e.ctrlKey;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !mod) {
      e.preventDefault();
      step(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === " " && !mod && !e.shiftKey && highlighted) {
      e.preventDefault();
      spaceTaken.current = true;
      toggle(highlighted.path);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (mod) void add(selected.length ? selected : highlighted && canAdd(cursor) ? [highlighted.path] : []);
      else if (matches.length === 1 && canAdd(0)) void add([...selected.filter((p) => p !== matches[0].path), matches[0].path]);
      else if (highlighted) toggle(highlighted.path);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="gap-3 sm:max-w-xl"
        // Open on the search, not the first button (the header's "add folder"): typing and the arrows start there.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{copy?.title ?? "Add repos"}</DialogTitle>
          {copy && <p className="text-sm text-muted-foreground">{copy.note}</p>}
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
            ref={attachSearch}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            role="combobox"
            aria-label="Search repos"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={highlighted ? optionId(cursor) : undefined}
            aria-describedby={`${listId}-keys`}
            placeholder="Search by name, owner/repo or path…"
            className="pl-8"
          />
        </div>

        <div ref={listRef} className="-mx-1 h-72 overflow-y-auto px-1" id={listId} role="listbox" aria-label="Repos" aria-multiselectable>
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
                  id={optionId(i)}
                  data-index={i}
                  data-highlighted={i === cursor || undefined}
                  role="option"
                  aria-selected={checked}
                  aria-disabled={added}
                  onClick={() => toggle(r.path)}
                  onMouseMove={() => setCursor(i)}
                  className={cn(
                    "flex cursor-default items-center gap-3 rounded-md px-2 py-1.5",
                    i === cursor && "bg-accent text-accent-foreground ring-1 ring-ring/40 ring-inset",
                    added && "opacity-50",
                  )}
                >
                  <Checkbox checked={checked} disabled={added} tabIndex={-1} aria-hidden className="pointer-events-none" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{r.name}</span>
                      {r.remote && r.remote !== r.name && <span className="truncate text-xs text-muted-foreground">{r.remote}</span>}
                    </div>
                    <div className="truncate font-mono text-[0.6875rem] text-muted-foreground">{compactPath(r.path)}</div>
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
        <p id={`${listId}-keys`} className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>Space</Kbd> or <Kbd>↵</Kbd> select
          </span>
          <span>
            <Kbd>{MOD}</Kbd> <Kbd>↵</Kbd> add
          </span>
          <span>
            <Kbd>Esc</Kbd> close
          </span>
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            // React bubbles submit through portals: never into a form this picker sits in (New project's).
            e.stopPropagation();
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
              {addTo && (addTo.project ? " to project" : " to chat")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
