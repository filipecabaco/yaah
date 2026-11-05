// Size-aware diff: small diffs inline, medium ones folded to a preview, large
// ones as a summary card. Any of them opens a full-screen review that takes
// over the view. Inside a chat, hunks can be asked about (drafted into the
// composer with an @mention of the file). Lines are drawn by rows.tsx: tabs 4
// wide, scrolling sideways per file, or wrapped with a hanging indent.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, FileMinus, FilePen, FilePlus, Maximize2, MessageSquareText, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { draftIntoComposer, useChat } from "@/components/chat-context";
import { useUiView } from "@/components/ui-view";
import { menuActions } from "@/lib/menu-actions";
import { changed, hunkRange, type DiffFile, type Hunk } from "@/components/diff/model";
import { hunkTop, rowsOf, useWrap, WRAP_MAX } from "@/components/diff/lines";
import { DiffLine, DiffRows, HunkHeader, WrapToggle } from "@/components/diff/rows";
import { plural } from "@/lib/format";
import { fuzzyRank } from "@/lib/fuzzy";
import { scrollBehavior } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Changed lines up to which everything is shown inline. */
const INLINE = 60;
/** Changed lines up to which files are shown folded to a preview. */
const PREVIEW = 600;
const PREVIEW_LINES = 24;
const SUMMARY_FILES = 8;

export function DiffView({ files, title }: { files: DiffFile[]; title?: string }) {
  const [review, setReview] = useState<string | null>(null);
  const [wrap, setWrap] = useWrap();
  const total = changed(files);
  const tier = total <= INLINE && files.length <= 3 ? "inline" : total <= PREVIEW && files.length <= 12 ? "preview" : "summary";
  if (files.length === 0) return <p className="text-xs text-muted-foreground">(no changes)</p>;
  const { added, removed } = totals(files);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {title && <span className="min-w-0 truncate">{title}</span>}
        <span className="tabular-nums">
          {plural(files.length, "file")} · <span className="text-green-700 dark:text-green-400">+{added}</span>{" "}
          <span className="text-red-700 dark:text-red-400">−{removed}</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          {tier !== "summary" && <WrapToggle wrap={wrap} onChange={setWrap} />}
          <Button variant="ghost" size="xs" onClick={() => setReview(files[0].path)}>
            <Maximize2 /> Review
          </Button>
        </span>
      </div>

      {tier === "summary" ? (
        <Summary files={files} onOpen={setReview} />
      ) : (
        files.map((f) => <FileBlock key={f.path} file={f} folded={tier === "preview"} wrap={wrap} onReview={() => setReview(f.path)} />)
      )}

      <Review files={files} title={title} open={review} onOpen={setReview} wrap={wrap} onWrap={setWrap} />
    </div>
  );
}

function totals(files: DiffFile[]) {
  return { added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
}

function StatusIcon({ status }: { status: DiffFile["status"] }) {
  const Icon = status === "added" ? FilePlus : status === "deleted" ? FileMinus : FilePen;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function Counts({ file }: { file: DiffFile }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-green-700 dark:text-green-400">+{file.added}</span>{" "}
      <span className="text-red-700 dark:text-red-400">−{file.removed}</span>
    </span>
  );
}

/** Proportional added/removed bar. */
function Bar({ file, max }: { file: DiffFile; max: number }) {
  const scale = (n: number) => `${Math.max(n ? 4 : 0, (n / max) * 100)}%`;
  return (
    <span className="flex h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
      <span className="bg-green-500/70" style={{ width: scale(file.added) }} />
      <span className="bg-red-500/70" style={{ width: scale(file.removed) }} />
    </span>
  );
}

function Summary({ files, onOpen }: { files: DiffFile[]; onOpen: (path: string) => void }) {
  const ranked = [...files].sort((a, b) => b.added + b.removed - (a.added + a.removed));
  const max = Math.max(...files.map((f) => f.added + f.removed));
  return (
    <div className="overflow-hidden rounded-md border">
      {ranked.slice(0, SUMMARY_FILES).map((f) => (
        <button
          key={f.path}
          onClick={() => onOpen(f.path)}
          className="flex w-full items-center gap-2 border-b px-2 py-1.5 text-left last:border-b-0 hover:bg-muted"
        >
          <StatusIcon status={f.status} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
          <Bar file={f} max={max} />
          <Counts file={f} />
        </button>
      ))}
      {files.length > SUMMARY_FILES && (
        <button
          onClick={() => onOpen(ranked[SUMMARY_FILES].path)}
          className="w-full px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
        >
          and {plural(files.length - SUMMARY_FILES, "more file")}…
        </button>
      )}
    </div>
  );
}

function FileBlock({ file, folded, wrap, onReview }: { file: DiffFile; folded: boolean; wrap: boolean; onReview: () => void }) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(!folded);
  const { expanded } = useUiView();
  const lines = file.hunks.reduce((n, h) => n + h.lines.length + 1, 0);
  const cut = !all && lines > PREVIEW_LINES;

  // Keep whole hunks until the preview budget runs out, then cut the last one.
  const shown: Hunk[] = useMemo(() => {
    if (!cut) return file.hunks;
    const out: Hunk[] = [];
    let budget = PREVIEW_LINES;
    for (const h of file.hunks) {
      if (budget <= 1) break;
      out.push({ ...h, lines: h.lines.slice(0, budget - 1) });
      budget -= h.lines.length + 1;
    }
    return out;
  }, [file, cut]);

  return (
    <div className="overflow-hidden rounded-md border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 bg-muted px-2 py-1 text-left"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <StatusIcon status={file.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
        <Counts file={file} />
      </button>
      {open && (
        <>
          {/* Unwrapped, the file scrolls sideways as one block, line numbers staying put. */}
          <div className={expanded ? "overflow-auto" : "overflow-x-auto"}>
            <div className={wrap ? "w-full" : "w-max min-w-full"}>
              {shown.map((h, i) => (
                <HunkView key={i} file={file} hunk={h} index={i} wrap={wrap} />
              ))}
            </div>
          </div>
          {cut && (
            <div className="flex items-center gap-2 border-t px-2 py-1 text-xs text-muted-foreground">
              <button type="button" className="hover:text-foreground" onClick={() => setAll(true)}>
                Show {lines - PREVIEW_LINES} more lines
              </button>
              <span>·</span>
              <button type="button" className="hover:text-foreground" onClick={onReview}>
                Open in review
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type ChatInfo = NonNullable<ReturnType<typeof useChat>>;

/** Draft "About @file lines a–b: " into the chat's composer, with the file mentioned. */
function askAbout(chat: ChatInfo, file: DiffFile, hunk: Hunk) {
  const [from, to] = hunkRange(hunk);
  const abs = file.path.startsWith("/") ? file.path : `${chat.cwd.replace(/\/$/, "")}/${file.path}`;
  const label = abs.startsWith(chat.cwd + "/") ? abs.slice(chat.cwd.length + 1) : abs;
  const range = from === to ? `line ${from}` : `lines ${from}–${to}`;
  draftIntoComposer({ text: `About @${label} ${range}: `, mention: { label, path: abs } }, chat.pane);
}

function AskButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="xs"
      className="h-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      onClick={onClick}
      title="Draft a question about these lines in the composer"
    >
      <MessageSquareText /> Ask about this
    </Button>
  );
}

function HunkView({ file, hunk, index, wrap }: { file: DiffFile; hunk: Hunk; index: number; wrap: boolean }) {
  const chat = useChat();
  const ask = chat ? () => askAbout(chat, file, hunk) : null;
  return (
    // Right-clicking the hunk offers the same in the enclosing menu (e.g. a tool card's).
    <div
      className="font-mono text-code"
      ref={ask ? menuActions([{ label: "Ask about this", icon: <MessageSquareText />, onSelect: ask }]) : undefined}
    >
      <HunkHeader hunk={hunk} index={index} tools={ask && <AskButton onClick={ask} />} />
      {hunk.lines.map((l, i) => (
        <DiffLine key={i} line={l} wrap={wrap} />
      ))}
    </div>
  );
}

/**
 * Full-screen review: file list on the left, the selected file's diff on the
 * right. j/k (or ↓/↑) move between files, n/p between hunks, / filters.
 */
function Review({
  files,
  title,
  open,
  onOpen,
  wrap,
  onWrap,
}: {
  files: DiffFile[];
  title?: string;
  open: string | null;
  onOpen: (path: string | null) => void;
  wrap: boolean;
  onWrap: (wrap: boolean) => void;
}) {
  const chat = useChat();
  const [filter, setFilter] = useState("");
  // The current hunk, for the file it was picked in: another file starts at its first hunk.
  const [at, setAt] = useState({ path: open, hunk: 0 });
  const hunk = at.path === open ? at.hunk : 0;
  const filterRef = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const shown = filter ? fuzzyRank(files, filter, (f) => [f.path]) : files;
  const current = files.find((f) => f.path === open) ?? null;
  const max = Math.max(1, ...files.map((f) => f.added + f.removed));
  const { added, removed } = totals(files);
  const { rows, starts } = useMemo(() => (current ? rowsOf(current) : { rows: [], starts: [] }), [current]);
  const close = useCallback(() => onOpen(null), [onOpen]);
  // "Ask about this" closes the review, so the composer it drafted into is in view.
  const asks = useMemo(
    () => (chat && current ? current.hunks.map((h) => () => (close(), askAbout(chat, current, h))) : null),
    [chat, current, close],
  );
  const hunkMenu = useCallback(
    (i: number) => (asks ? [{ label: "Ask about this", icon: <MessageSquareText />, onSelect: asks[i] }] : undefined),
    [asks],
  );

  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [open]);

  function move(by: number) {
    if (!shown.length) return;
    const i = shown.findIndex((f) => f.path === open);
    onOpen(shown[(i + by + shown.length) % shown.length].path);
  }
  function jumpHunk(by: number) {
    if (!current) return;
    const next = Math.max(0, Math.min(current.hunks.length - 1, hunk + by));
    setAt({ path: open, hunk: next });
    // The hunk's header row goes just under the file's sticky header.
    const el = body.current;
    if (el) el.scrollTo({ top: hunkTop(el, starts, next), behavior: scrollBehavior() });
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target instanceof HTMLInputElement;
    if (typing) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        move(e.key === "Enter" ? 0 : 1);
        filterRef.current?.blur();
      }
      return;
    }
    const keys: Record<string, () => void> = {
      j: () => move(1),
      ArrowDown: () => move(1),
      k: () => move(-1),
      ArrowUp: () => move(-1),
      n: () => jumpHunk(1),
      p: () => jumpHunk(-1),
      // After this keystroke, so the "/" itself never lands in the box.
      "/": () => setTimeout(() => filterRef.current?.focus()),
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  }

  return (
    <Dialog open={open != null} onOpenChange={(o) => !o && onOpen(null)}>
      <DialogContent
        className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 bg-background p-0 sm:max-w-none"
        onKeyDown={onKeyDown}
        // Start on the diff, not the filter box, so j/k/n/p work straight away.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          requestAnimationFrame(() => body.current?.focus());
        }}
      >
        <div className="flex items-center gap-3 border-b px-4 py-2.5 pr-12">
          <DialogTitle className="text-sm">{title ?? "Review changes"}</DialogTitle>
          <DialogDescription className="text-xs tabular-nums">
            {plural(files.length, "file")} · +{added} −{removed}
          </DialogDescription>
          <span className="ml-auto">
            <WrapToggle wrap={wrap} onChange={onWrap} disabled={rows.length > WRAP_MAX} />
          </span>
          <span className="hidden items-center gap-1 text-xs text-muted-foreground md:flex">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd> files <Kbd>n</Kbd>
            <Kbd>p</Kbd> hunks <Kbd>/</Kbd> filter <Kbd>Esc</Kbd> close
          </span>
        </div>
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col border-r">
            <div className="relative p-2">
              <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={filterRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter files"
                aria-label="Filter files"
                className="h-8 pl-7 text-xs"
              />
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
              {shown.map((f) => (
                <button
                  type="button"
                  key={f.path}
                  aria-current={f.path === open || undefined}
                  onClick={() => onOpen(f.path)}
                  className={cn("flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-muted", f.path === open && "bg-muted")}
                >
                  <span className="flex w-full items-center gap-1.5">
                    <StatusIcon status={f.status} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                      {f.path.split("/").pop()}
                    </span>
                    <Counts file={f} />
                  </span>
                  <span className="flex items-center gap-2 pl-5">
                    <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{f.path.split("/").slice(0, -1).join("/") || "."}</span>
                    <Bar file={f} max={max} />
                  </span>
                </button>
              ))}
            </nav>
          </aside>
          <div ref={body} tabIndex={-1} className="min-w-0 flex-1 overflow-auto bg-background outline-none">
            {current && (
              <div className="flex flex-col">
                <div data-sticky className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-2">
                  <StatusIcon status={current.status} />
                  <span className="min-w-0 truncate font-mono text-xs">{current.path}</span>
                  {current.status !== "modified" && <Badge variant="outline">{current.status}</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    hunk {Math.min(hunk + 1, current.hunks.length)} / {current.hunks.length}
                  </span>
                </div>
                <DiffRows
                  file={current}
                  rows={rows}
                  current={hunk}
                  scroller={body}
                  wrap={wrap}
                  hunkTools={asks ? (i) => <AskButton onClick={asks[i]} /> : undefined}
                  hunkMenu={hunkMenu}
                />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
