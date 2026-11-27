// The editor pane's Explorer: the folder's files as a tree, read one folder at a time as it is
// opened (editor_commands.rs `editor_list`), each file and folder coloured by its git change the
// way VS Code does. Re-read when the repository moves (the pane bumps `stamp`) or on Refresh.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, File, FilePlus, FolderClosed, FolderOpen, FolderPlus, ListCollapse, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { editorApi, type ChangeStatus, type DirEntry } from "@/lib/editor-api";
import { errorMessage } from "@/lib/narrow";
import { cn } from "@/lib/utils";
import { STATUS_COLOR } from "./status";

export function Explorer({
  root,
  title,
  stamp,
  decorations,
  active,
  onOpen,
}: {
  root: string;
  title: string;
  /** Changes when the files may have moved: the open folders are read again. */
  stamp: string;
  /** Git status by path relative to `root` (files), and `dir/` keys for folders holding changes. */
  decorations: Map<string, ChangeStatus>;
  /** The file the editor shows, highlighted here. */
  active: string | null;
  onOpen: (path: string) => void;
}) {
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(new Map());
  const [open, setOpen] = useState<Set<string>>(() => new Set([""]));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ dir: string; folder: boolean } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  const load = useCallback(
    async (dirs: string[]) => {
      const got = await Promise.all(
        dirs.map((d) =>
          editorApi.list(root, d).then(
            (list) => [d, list] as const,
            (e: unknown) => {
              if (d === "") setError(errorMessage(e));
              return null;
            },
          ),
        ),
      );
      setChildren((was) => {
        const next = new Map(was);
        for (const g of got) if (g) next.set(g[0], g[1]);
        return next;
      });
      if (got[0]) setError(null);
    },
    [root],
  );

  // The folder, and every folder left open, whenever the files may have moved.
  useEffect(() => {
    void load([...openRef.current]);
  }, [load, stamp]);

  // The active file's folders open, as VS Code reveals it.
  useEffect(() => {
    if (!active) return;
    const parts = active.split("/").slice(0, -1);
    const dirs = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    const missing = dirs.filter((d) => !openRef.current.has(d));
    if (!missing.length) return;
    setOpen((was) => new Set([...was, ...missing]));
    void load(missing);
  }, [active, load]);

  const toggle = (dir: string) => {
    setSelected(dir);
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!children.has(dir)) void load([dir]);
      }
      return next;
    });
  };

  /** Where a new file goes: the selected folder, or the selected file's folder. */
  const targetDir = () => {
    if (!selected) return "";
    const isDir = [...children.values()].flat().find((e) => e.path === selected)?.dir;
    return isDir ? selected : selected.split("/").slice(0, -1).join("/");
  };
  const startCreate = (folder: boolean) => {
    const dir = targetDir();
    if (dir) setOpen((was) => new Set([...was, dir]));
    setCreating({ dir, folder });
  };
  const create = async (name: string) => {
    const c = creating;
    setCreating(null);
    if (!c || !name.trim()) return;
    const path = c.dir ? `${c.dir}/${name.trim()}` : name.trim();
    try {
      await editorApi.create(root, path, c.folder);
      const parents = path.split("/").slice(0, -1);
      const dirs = ["", ...parents.map((_, i) => parents.slice(0, i + 1).join("/"))];
      setOpen((was) => new Set([...was, ...dirs.slice(1)]));
      await load([...new Set([...openRef.current, ...dirs])]);
      if (!c.folder) onOpen(path);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const rows: React.ReactNode[] = [];
  const walk = (dir: string, depth: number) => {
    if (creating?.dir === dir) rows.push(<NewEntry key={`new:${dir}`} depth={depth} folder={creating.folder} onDone={(name) => void create(name)} />);
    for (const e of children.get(dir) ?? []) {
      const status = decorations.get(e.dir ? `${e.path}/` : e.path);
      const isOpen = open.has(e.path);
      rows.push(
        <li key={e.path} role="none">
          <button
            type="button"
            role="treeitem"
            aria-expanded={e.dir ? isOpen : undefined}
            aria-selected={e.path === active}
            title={e.path}
            onClick={() => (e.dir ? toggle(e.path) : (setSelected(e.path), onOpen(e.path)))}
            className={cn(
              "flex h-[22px] w-full items-center gap-1 pr-2 text-left text-[13px] hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none",
              e.path === active && "bg-accent",
              selected === e.path && e.path !== active && "bg-accent/40",
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
          >
            {e.dir ? (
              <>
                {isOpen ? <ChevronDown className="size-3.5 shrink-0 opacity-70" /> : <ChevronRight className="size-3.5 shrink-0 opacity-70" />}
                {isOpen ? (
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" />
                )}
              </>
            ) : (
              <>
                <span className="w-3.5 shrink-0" />
                <File className="size-3.5 shrink-0 text-muted-foreground" />
              </>
            )}
            <span className={cn("min-w-0 flex-1 truncate", status && STATUS_COLOR[status], e.link && "italic")}>{e.name}</span>
            {status && <span className={cn("shrink-0 font-mono text-[11px]", STATUS_COLOR[status])}>{e.dir ? "•" : status}</span>}
          </button>
        </li>,
      );
      if (e.dir && isOpen) walk(e.path, depth + 1);
    }
  };
  walk("", 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        <span className="min-w-0 flex-1 truncate" title={root}>
          {title}
        </span>
        <Button size="icon-xs" variant="ghost" title="New file" aria-label="New file" onClick={() => startCreate(false)}>
          <FilePlus />
        </Button>
        <Button size="icon-xs" variant="ghost" title="New folder" aria-label="New folder" onClick={() => startCreate(true)}>
          <FolderPlus />
        </Button>
        <Button size="icon-xs" variant="ghost" title="Refresh" aria-label="Refresh the files" onClick={() => void load([...open])}>
          <RefreshCw />
        </Button>
        <Button size="icon-xs" variant="ghost" title="Collapse folders" aria-label="Collapse folders" onClick={() => setOpen(new Set([""]))}>
          <ListCollapse />
        </Button>
      </div>
      {error && (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <ul role="tree" aria-label="Files" className="min-h-0 flex-1 overflow-auto pb-4">
        {rows}
      </ul>
    </div>
  );
}

function NewEntry({ depth, folder, onDone }: { depth: number; folder: boolean; onDone: (name: string) => void }) {
  const [name, setName] = useState("");
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") finish(name);
    if (e.key === "Escape") finish("");
  };
  return (
    <li className="flex h-[22px] items-center gap-1 pr-2" style={{ paddingLeft: 8 + depth * 12 + 14 }}>
      {folder ? <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" /> : <File className="size-3.5 shrink-0 text-muted-foreground" />}
      <input
        autoFocus
        aria-label={folder ? "New folder name" : "New file name"}
        placeholder={folder ? "folder name" : "file name (a/b.ex makes folders)"}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(name)}
        className="h-5 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1 font-mono text-xs outline-none"
      />
    </li>
  );
}
