// The editor pane's Source Control, laid out like VS Code's: a commit box, the merge conflicts,
// the staged changes and the work tree's changes (each with open, stage or unstage, and
// discard), then the commit graph. Every action is a command on the repository
// (sources/git/editor.rs); the pane re-reads the status after each one.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, FileText, Loader2, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { editorApi, type Change, type GraphCommit, type RepoStatus } from "@/lib/editor-api";
import { baseName, plural } from "@/lib/format";
import { errorMessage } from "@/lib/narrow";
import { isMac } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { layoutGraph, type Row } from "./graph-lanes";
import { STATUS_COLOR, STATUS_WORD } from "./status";

export type ChangeSide = "staged" | "changes" | "conflicts";

export function SourceControl({
  status,
  onOpenChange,
  onOpenFile,
  onChanged,
}: {
  status: RepoStatus;
  /** Show a change as a split diff: staged ones HEAD ↔ index, the others index ↔ work tree. */
  onOpenChange: (c: Change, side: ChangeSide) => void;
  /** Open the file itself. `path` is relative to the repository. */
  onOpenFile: (path: string) => void;
  /** Something was done: read the status again. */
  onChanged: () => void;
}) {
  const cwd = status.root;
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<Change[] | null>(null);
  const [shut, setShut] = useState<Set<string>>(new Set());

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      await f();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  const paths = (cs: Change[]) => [...new Set(cs.flatMap((c) => (c.oldPath && c.status === "R" ? [c.path, c.oldPath] : [c.path])))];
  const stage = (cs: Change[]) => run("stage", () => editorApi.stage(cwd, paths(cs)));
  const unstage = (cs: Change[]) => run("unstage", () => editorApi.unstage(cwd, paths(cs)));
  const discard = (cs: Change[]) =>
    run("discard", () =>
      editorApi.discard(
        cwd,
        cs.map((c) => c.path),
      ),
    );

  const nothingStaged = status.staged.length === 0;
  const tracked = status.changes.filter((c) => !c.untracked);
  const commit = async (amend = false) => {
    // Nothing staged: commit every tracked change, as VS Code's smart commit does.
    const all = nothingStaged && !amend;
    if (!amend && !message.trim()) {
      setError("Write a commit message first.");
      return;
    }
    let short = "";
    const ok = await run("commit", async () => {
      short = await editorApi.commit(cwd, message, all, amend);
    });
    if (ok) {
      setMessage("");
      setNote(`${amend ? "Amended" : "Committed"} ${short}`);
    }
  };
  const canCommit = !busy && (!nothingStaged || tracked.length > 0);

  const section = (key: ChangeSide, title: string, list: Change[], actions: ReactNode, row: (c: Change) => ReactNode) => {
    if (!list.length) return null;
    const closed = shut.has(key);
    return (
      <section aria-label={title}>
        <div className="group/sec flex h-[22px] items-center gap-1 pr-2 pl-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:bg-accent/40">
          <button
            type="button"
            aria-expanded={!closed}
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
            onClick={() => setShut((s) => (s.has(key) ? new Set([...s].filter((x) => x !== key)) : new Set([...s, key])))}
          >
            {closed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            <span className="truncate">{title}</span>
          </button>
          <span className="flex opacity-0 group-hover/sec:opacity-100 focus-within:opacity-100">{actions}</span>
          <Badge variant="secondary" className="h-4 rounded-full px-1.5 text-[10px]">
            {list.length}
          </Badge>
        </div>
        {!closed && <ul>{list.map(row)}</ul>}
      </section>
    );
  };

  const changeRow = (side: ChangeSide) => (c: Change) => {
    const dir = c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : "";
    return (
      <li key={`${side}:${c.path}`} className="group/row flex h-[22px] items-center gap-1 pr-2 pl-5 hover:bg-accent/60">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left text-[13px]"
          title={`${c.path} · ${STATUS_WORD[c.status]}${side === "staged" ? " (staged)" : ""}`}
          onClick={() => onOpenChange(c, side)}
        >
          <span className={cn("shrink-0 truncate", c.status === "D" && "line-through")}>{baseName(c.path)}</span>
          {dir && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dir}</span>}
        </button>
        <span className="flex shrink-0 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
          {c.status !== "D" && (
            <IconAction label={`Open ${baseName(c.path)}`} onClick={() => onOpenFile(c.path)}>
              <FileText />
            </IconAction>
          )}
          {side === "changes" && (
            <IconAction label={`Discard changes to ${baseName(c.path)}`} onClick={() => setDiscarding([c])}>
              <Undo2 />
            </IconAction>
          )}
          {side === "staged" ? (
            <IconAction label={`Unstage ${baseName(c.path)}`} onClick={() => void unstage([c])}>
              <Minus />
            </IconAction>
          ) : (
            <IconAction label={`Stage ${baseName(c.path)}`} onClick={() => void stage([c])}>
              <Plus />
            </IconAction>
          )}
        </span>
        <span className={cn("w-3 shrink-0 text-center font-mono text-[11px]", STATUS_COLOR[c.status])}>{c.status}</span>
      </li>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        <span className="min-w-0 flex-1 truncate">Source Control</span>
        {busy && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-label="Working" />}
        <Button size="icon-xs" variant="ghost" title="Refresh" aria-label="Refresh source control" onClick={onChanged}>
          <RefreshCw />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          <textarea
            aria-label="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (isMac ? e.metaKey : e.ctrlKey)) {
                e.preventDefault();
                void commit();
              }
            }}
            rows={Math.min(6, Math.max(1, message.split("\n").length))}
            placeholder={`Message (${isMac ? "⌘" : "Ctrl+"}Enter to commit on "${status.branch ?? "detached HEAD"}")`}
            className="w-full resize-none rounded-sm border bg-background px-2 py-1 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <div className="flex">
            <Button
              size="sm"
              className="h-7 flex-1 rounded-r-none"
              disabled={!canCommit}
              title={nothingStaged ? "Nothing is staged: commits every change to tracked files" : undefined}
              onClick={() => void commit()}
            >
              <Check /> {nothingStaged && tracked.length ? "Commit All" : "Commit"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="h-7 rounded-l-none border-l border-primary-foreground/20 px-1.5"
                  aria-label="More commit actions"
                  disabled={!!busy}
                >
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!status.hasCommits} onSelect={() => void commit(true)}>
                  Commit (Amend)
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!status.changes.length} onSelect={() => void stage(status.changes)}>
                  Stage All Changes
                </DropdownMenuItem>
                <DropdownMenuItem disabled={nothingStaged} onSelect={() => void unstage(status.staged)}>
                  Unstage All Changes
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {error && (
            <p role="alert" className="max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap text-destructive">
              {error}
            </p>
          )}
          {note && (
            <p role="status" className="text-xs text-muted-foreground">
              {note}
            </p>
          )}
        </div>

        {section("conflicts", "Merge Changes", status.conflicts, null, changeRow("conflicts"))}
        {section(
          "staged",
          "Staged Changes",
          status.staged,
          <IconAction label="Unstage all changes" onClick={() => void unstage(status.staged)}>
            <Minus />
          </IconAction>,
          changeRow("staged"),
        )}
        {section(
          "changes",
          "Changes",
          status.changes,
          <>
            <IconAction label="Discard all changes" onClick={() => setDiscarding(status.changes)}>
              <Undo2 />
            </IconAction>
            <IconAction label="Stage all changes" onClick={() => void stage(status.changes)}>
              <Plus />
            </IconAction>
          </>,
          changeRow("changes"),
        )}
        {!status.staged.length && !status.changes.length && !status.conflicts.length && (
          <p className="px-4 py-2 text-xs text-muted-foreground">No changes in {status.name}.</p>
        )}
        {status.truncated && <p className="px-4 py-1 text-xs text-muted-foreground">Only the first 5000 changed files are listed.</p>}

        <Graph status={status} />
      </div>

      <Dialog open={!!discarding} onOpenChange={(o) => !o && setDiscarding(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Discard {discarding?.length === 1 ? `changes to ${baseName(discarding[0].path)}` : plural(discarding?.length ?? 0, "change")}?
            </DialogTitle>
            <DialogDescription>
              {discarding?.some((c) => c.untracked)
                ? "Untracked files are deleted. Changes to tracked files go back to what is staged (or committed). This can't be undone."
                : "The work tree goes back to what is staged (or committed). This can't be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscarding(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              autoFocus
              onClick={() => {
                const cs = discarding ?? [];
                setDiscarding(null);
                void discard(cs);
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button size="icon-xs" variant="ghost" className="size-5 [&_svg]:size-3.5" title={label} aria-label={label} onClick={onClick}>
      {children}
    </Button>
  );
}

// ── graph ───────────────────────────────────────────────────────────────────

const LANE_COLORS = ["#3b82f6", "#a855f7", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#ef4444", "#84cc16"];
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
const ROW_H = 22;
const LANE_W = 12;

function Graph({ status }: { status: RepoStatus }) {
  const [open, setOpen] = useState(true);
  const [commits, setCommits] = useState<GraphCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read again when HEAD or the upstream moves.
  const key = `${status.root}\n${status.oid ?? ""}\n${status.upstream ?? ""}\n${status.ahead}:${status.behind}`;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!open || seen.current === key) return;
    seen.current = key;
    if (!status.hasCommits) return;
    editorApi.graph(status.root, status.upstream, 300).then(
      (c) => {
        setCommits(c);
        setError(null);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  }, [key, open, status.root, status.upstream, status.hasCommits]);
  // A repository with no commits yet has no graph to read.
  const shown = useMemo(() => (status.hasCommits ? commits : []), [status.hasCommits, commits]);
  const rows = useMemo(() => (shown ? layoutGraph(shown) : []), [shown]);
  const width = Math.max(1, ...rows.map((r) => r.width));

  return (
    <section aria-label="Graph" className="mt-1 border-t">
      <div className="flex h-[22px] items-center gap-1 pr-2 pl-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        <button type="button" aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Graph
        </button>
        {status.upstream && (
          <span className="flex items-center gap-1 font-mono normal-case" title={`Against ${status.upstream}`}>
            {status.behind > 0 && (
              <span className="flex items-center">
                <ArrowDown className="size-3" />
                {status.behind}
              </span>
            )}
            {status.ahead > 0 && (
              <span className="flex items-center">
                <ArrowUp className="size-3" />
                {status.ahead}
              </span>
            )}
          </span>
        )}
      </div>
      {open && error && <p className="px-4 py-1 text-xs text-destructive">{error}</p>}
      {open && shown?.length === 0 && <p className="px-4 py-1 text-xs text-muted-foreground">No commits yet.</p>}
      {open && (
        <ol>
          {shown?.map((c, i) => (
            <li
              key={c.sha}
              className="flex items-center gap-1.5 pr-2 hover:bg-accent/60"
              style={{ height: ROW_H }}
              title={`${c.short} · ${c.author} · ${new Date(c.date).toLocaleString()}\n${c.subject}`}
            >
              <Lanes row={rows[i]} width={width} />
              <span className="min-w-16 flex-1 truncate text-[13px]">{c.subject}</span>
              {c.refs.slice(0, 2).map((r) => (
                <RefBadge key={r} name={r} />
              ))}
              <span className="max-w-24 shrink-0 truncate text-[11px] text-muted-foreground">{c.author}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RefBadge({ name }: { name: string }) {
  const head = name.startsWith("HEAD -> ");
  const label = name.replace(/^HEAD -> /, "").replace(/^tag: /, "");
  const remote = /^(origin|upstream)\//.test(label);
  return (
    <span
      className={cn(
        "max-w-24 min-w-6 shrink truncate rounded-full border px-1.5 font-mono text-[10px] leading-4",
        head
          ? "border-primary bg-primary/10 text-foreground"
          : remote
            ? "border-violet-500/50 text-violet-600 dark:text-violet-300"
            : "text-muted-foreground",
      )}
      title={name}
    >
      {label}
    </span>
  );
}

function Lanes({ row, width }: { row: Row | undefined; width: number }) {
  if (!row) return <span style={{ width: width * LANE_W + 4 }} />;
  const x = (c: number) => 6 + c * LANE_W;
  const mid = ROW_H / 2;
  return (
    <svg width={width * LANE_W + 4} height={ROW_H} aria-hidden className="shrink-0">
      {row.segments.map((s, i) => {
        const x1 = s.from == null ? x(row.col) : x(s.from);
        const y1 = s.from == null ? mid : 0;
        const x2 = s.to == null ? x(row.col) : x(s.to);
        const y2 = s.to == null ? mid : ROW_H;
        const d = x1 === x2 ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
        return <path key={i} d={d} stroke={laneColor(s.color)} strokeWidth={1.5} fill="none" />;
      })}
      <circle cx={x(row.col)} cy={mid} r={3.5} fill="var(--background)" stroke={laneColor(row.color)} strokeWidth={2} />
    </svg>
  );
}
