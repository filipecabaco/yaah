// The `diffreview` block: a multi-file diff to review and act on, one file at a
// time. A file list (status, +/−, a viewed tick) beside the file, or file tabs
// across the top below about 900 px. j/k files, n/p hunks, v viewed, Enter
// goes to the file. Per file and per hunk: ask about it or ask for a change or
// revert (drafted into the composer, never applied), copy, open in the editor,
// mark viewed. Viewed ticks live in the UI entry's draft (per range), so they
// survive re-renders and live refreshes; a file that changed since it was
// viewed comes back unviewed.
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ClipboardCopy, Copy, ExternalLink, FileWarning, Maximize2, MessageSquareText, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { draftIntoComposer, useChat } from "@/components/chat-context";
import { FormHostContext } from "@/components/ui-form-host";
import { inlineMax, useUiView } from "@/components/ui-view";
import type { Hunk } from "@/components/diff/model";
import { hunkText, hunkTop, rowsOf, useWrap, WRAP_MAX } from "@/components/diff/lines";
import { DiffRows, WrapToggle } from "@/components/diff/rows";
import { draftFor, NARROW, reviewFiles, STATUS, type ReviewFile, type Status } from "@/components/ui-blocks/diff-review-model";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";
import { asObj } from "@/lib/narrow";
import { scrollBehavior } from "@/lib/motion";
import { cn } from "@/lib/utils";

const baseName = (p: string) => p.split("/").pop() || p;
const dirName = (p: string) => p.split("/").slice(0, -1).join("/");

/** Width of `el`, kept current (0 before layout). */
function useWidth(el: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [el]);
  return width;
}

/** Viewed ticks for `range`, kept in the UI entry's draft field `name` ({ range: { path: hash } }), else here. */
function useViewed(name: string, range: string) {
  const host = useContext(FormHostContext);
  const all = asObj(host?.draft?.[name]);
  const stored = asObj(all[range]) as Record<string, string>;
  const storedKey = JSON.stringify(stored);
  // Shown at once; dropped when the draft catches up (or moves on).
  const [optimistic, setOptimistic] = useState<{ base: string; value: Record<string, string> } | null>(null);
  const viewed = optimistic && optimistic.base === storedKey ? optimistic.value : stored;
  const set = useCallback(
    (next: Record<string, string>) => {
      setOptimistic({ base: storedKey, value: next });
      void host?.onEdit?.({ [name]: { ...all, [range]: next } }).catch(() => setOptimistic(null));
    },
    // `all` is read fresh through storedKey's change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, name, range, storedKey],
  );
  return [viewed, set] as const;
}

async function copy(text: string) {
  await navigator.clipboard?.writeText(text);
}

function StatusMark({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <span className={cn("w-3 shrink-0 text-center font-mono text-2xs font-semibold", s.tone)} title={status} aria-label={status}>
      {s.letter}
    </span>
  );
}

function Counts({ file }: { file: ReviewFile }) {
  if (file.binary) return <span className="shrink-0 text-2xs text-muted-foreground">binary</span>;
  return (
    <span className="shrink-0 font-mono text-2xs tabular-nums">
      <span className="text-green-700 dark:text-green-400">+{file.added}</span>{" "}
      <span className="text-red-700 dark:text-red-400">−{file.removed}</span>
    </span>
  );
}

/** A small icon button with its name as label and tooltip. */
function Tool({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <Button variant="ghost" size="icon-xs" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

export default function DiffReview({
  text,
  files: meta,
  title,
  range,
  truncated,
  name,
}: {
  text: string;
  files?: unknown;
  title?: string;
  range?: string;
  truncated?: boolean;
  name?: string;
}) {
  const chat = useChat();
  // In the expanded dialog the list and the diff fill its height; inline they stop at 34 rem.
  const { expanded, expand, name: uiName } = useUiView();
  const files = useMemo(() => reviewFiles(text, meta), [text, meta]);
  const [viewed, setViewed] = useViewed(name || "viewed", range || "HEAD");
  const isViewed = useCallback((f: ReviewFile) => viewed[f.path] === f.hash, [viewed]);
  const [selected, setSelected] = useState<string | null>(null);
  const current = files.find((f) => f.path === selected) ?? files[0] ?? null;
  const [at, setAt] = useState({ path: "", hunk: 0 });
  const hunk = current && at.path === current.path ? at.hunk : 0;
  const [wrap, setWrap] = useWrap();
  const [notice, setNotice] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const narrow = width > 0 && width < NARROW;
  const { rows, starts } = useMemo(() => (current ? rowsOf(current) : { rows: [], starts: [] }), [current]);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const done = files.filter(isViewed).length;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const select = useCallback((path: string) => {
    setSelected(path);
    body.current?.scrollTo({ top: 0 });
  }, []);
  const toggleViewed = useCallback(
    (f: ReviewFile) => {
      const next = { ...viewed };
      if (isViewed(f)) delete next[f.path];
      else next[f.path] = f.hash;
      setViewed(next);
    },
    [viewed, isViewed, setViewed],
  );
  const say = (msg: string) => setNotice(msg);
  const draft = useCallback(
    (kind: "ask" | "change", file: ReviewFile, h?: Hunk) => {
      if (chat) draftIntoComposer(draftFor(chat, kind, file, h), chat.pane);
    },
    [chat],
  );
  const openInEditor = (file: ReviewFile) => {
    if (!chat) return;
    api.openInEditor(chat.sessionId, file.path).then(
      () => say(`Opened ${baseName(file.path)}`),
      (e: unknown) => say(`Couldn’t open: ${String(e)}`),
    );
  };

  function move(by: number) {
    if (!files.length || !current) return;
    const i = files.findIndex((f) => f.path === current.path);
    select(files[(i + by + files.length) % files.length].path);
  }
  function jumpHunk(by: number) {
    if (!current?.hunks.length) return;
    const next = Math.max(0, Math.min(current.hunks.length - 1, hunk + by));
    setAt({ path: current.path, hunk: next });
    const el = body.current;
    if (el) el.scrollTo({ top: hunkTop(el, starts, next), behavior: scrollBehavior() });
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable='true']")) return;
    const keys: Record<string, () => void> = {
      j: () => move(1),
      k: () => move(-1),
      n: () => jumpHunk(1),
      p: () => jumpHunk(-1),
      v: () => current && toggleViewed(current),
      // Enter on a button presses it; elsewhere it goes to the file's diff.
      Enter: () => {
        body.current?.focus();
        body.current?.scrollIntoView?.({ block: "nearest" });
      },
    };
    if (e.key === "Enter" && t.closest("button")) return;
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  }

  const hunkTools = useCallback(
    (i: number) => {
      if (!current) return null;
      const h = current.hunks[i];
      return (
        <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          {chat && (
            <>
              <Tool label="Ask about this" onClick={() => draft("ask", current, h)}>
                <MessageSquareText />
              </Tool>
              <Tool label="Ask to change or revert this" onClick={() => draft("change", current, h)}>
                <Undo2 />
              </Tool>
            </>
          )}
          <Tool label="Copy hunk" onClick={() => void copy(hunkText(h)).then(() => say("Copied the hunk"))}>
            <ClipboardCopy />
          </Tool>
        </span>
      );
    },
    [chat, current, draft],
  );
  const hunkMenu = useCallback(
    (i: number) => {
      if (!current) return undefined;
      const h = current.hunks[i];
      return [
        ...(chat
          ? [
              { label: "Ask about this", icon: <MessageSquareText />, onSelect: () => draft("ask", current, h) },
              { label: "Ask to change or revert this", icon: <Undo2 />, onSelect: () => draft("change", current, h) },
            ]
          : []),
        { label: "Copy hunk", icon: <ClipboardCopy />, onSelect: () => void copy(hunkText(h)) },
      ];
    },
    [chat, current, draft],
  );

  if (files.length === 0)
    return (
      <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
        {title && <span className="font-medium text-foreground">{title} · </span>}No changes{range ? ` (${range})` : ""}.
      </div>
    );

  const tick = (f: ReviewFile) => {
    const on = isViewed(f);
    const stale = !on && f.path in viewed;
    return (
      <button
        type="button"
        aria-pressed={on}
        aria-label={`${on ? "Viewed" : "Mark viewed"}: ${f.path}`}
        title={stale ? "Changed since you viewed it" : on ? "Viewed (v)" : "Mark viewed (v)"}
        onClick={() => toggleViewed(f)}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm border",
          on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
          stale && "border-amber-500",
        )}
      >
        {on && <Check className="size-3" />}
      </button>
    );
  };

  const list = narrow ? (
    <div role="tablist" aria-label="Files" className="flex gap-1 overflow-x-auto border-b px-1 pb-1">
      {files.map((f) => (
        <div key={f.path} className={cn("flex shrink-0 items-center gap-1.5 rounded-md px-1.5", f === current ? "bg-muted" : "hover:bg-muted/60")}>
          <button
            type="button"
            role="tab"
            aria-selected={f === current}
            title={f.path}
            onClick={() => select(f.path)}
            className="flex items-center gap-1.5 py-1 font-mono text-xs"
          >
            <StatusMark status={f.status} />
            <span className={cn(isViewed(f) && "text-muted-foreground line-through decoration-muted-foreground/40")}>{baseName(f.path)}</span>
          </button>
          {tick(f)}
        </div>
      ))}
    </div>
  ) : (
    <nav aria-label="Files" className={cn("flex w-64 shrink-0 flex-col gap-px overflow-y-auto border-r p-1", inlineMax(expanded, "max-h-[34rem]"))}>
      {files.map((f) => (
        <div key={f.path} className={cn("flex items-center gap-1.5 rounded-md pr-1.5", f === current ? "bg-muted" : "hover:bg-muted/60")}>
          <button
            type="button"
            aria-current={f === current || undefined}
            title={f.path}
            onClick={() => select(f.path)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 text-left"
          >
            <StatusMark status={f.status} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn("truncate font-mono text-xs", isViewed(f) && "text-muted-foreground")}>{baseName(f.path)}</span>
              {dirName(f.path) && <span className="truncate text-2xs text-muted-foreground">{dirName(f.path)}</span>}
            </span>
            <Counts file={f} />
          </button>
          {tick(f)}
        </div>
      ))}
    </nav>
  );

  return (
    <div
      ref={root}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={title ? `Review: ${title}` : "Review changes"}
      className={cn(
        "flex flex-col overflow-hidden rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        expanded && "min-h-[24rem] flex-1",
      )}
      data-layout={narrow ? "tabs" : "list"}
      data-expanded={expanded || undefined}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs">
        {title && <span className="min-w-0 truncate font-medium">{title}</span>}
        {range && (
          <Badge variant="outline" className="font-mono">
            {range}
          </Badge>
        )}
        <span className="text-muted-foreground tabular-nums">
          {plural(files.length, "file")} · <span className="text-green-700 dark:text-green-400">+{added}</span>{" "}
          <span className="text-red-700 dark:text-red-400">−{removed}</span> · {done} of {files.length} viewed
        </span>
        <span className="ml-auto flex items-center gap-1">
          {!narrow && (
            <span className="mr-1 hidden items-center gap-1 text-muted-foreground lg:flex">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd> files <Kbd>n</Kbd>
              <Kbd>p</Kbd> hunks <Kbd>v</Kbd> viewed
            </span>
          )}
          <WrapToggle wrap={wrap} onChange={setWrap} disabled={rows.length > WRAP_MAX} />
          {expand && (
            <Button variant="ghost" size="icon-xs" aria-label={uiName ? `Expand ${uiName}` : "Expand"} title="Expand (F)" onClick={expand}>
              <Maximize2 />
            </Button>
          )}
        </span>
      </div>
      {truncated && (
        <p className="flex items-center gap-1.5 border-b bg-amber-500/10 px-3 py-1 text-xs text-amber-800 dark:text-amber-300">
          <FileWarning className="size-3.5" /> The diff is over 4 MB and was cut: some files’ changes aren’t shown.
        </p>
      )}
      <div className={cn("flex min-h-0", narrow ? "flex-col" : "flex-row", expanded && "flex-1")}>
        {list}
        {current && (
          <div
            ref={body}
            tabIndex={-1}
            aria-label={`Diff of ${current.path}`}
            className={cn("relative min-w-0 flex-1 overflow-auto outline-none", inlineMax(expanded, "max-h-[34rem]"))}
          >
            <div data-sticky className="sticky top-0 left-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-background px-3 py-1.5">
              <StatusMark status={current.status} />
              <span className="min-w-0 truncate font-mono text-xs" title={current.path}>
                {current.from && current.from !== current.path ? `${current.from} → ${current.path}` : current.path}
              </span>
              <Counts file={current} />
              {current.hunks.length > 1 && (
                <span className="text-2xs text-muted-foreground tabular-nums">
                  hunk {Math.min(hunk + 1, current.hunks.length)} / {current.hunks.length}
                </span>
              )}
              <span className="ml-auto flex flex-wrap items-center gap-0.5">
                {notice && (
                  <span role="status" className="mr-1 text-2xs text-muted-foreground">
                    {notice}
                  </span>
                )}
                {chat && (
                  <>
                    <Button variant="ghost" size="xs" onClick={() => draft("ask", current)} aria-label="Ask about this file">
                      <MessageSquareText /> {narrow ? "Ask" : "Ask about this"}
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => draft("change", current)} aria-label="Ask to change or revert this file">
                      <Undo2 /> {narrow ? "Change" : "Ask to change or revert"}
                    </Button>
                  </>
                )}
                <Tool label="Copy path" onClick={() => void copy(current.path).then(() => say("Copied the path"))}>
                  <Copy />
                </Tool>
                <Tool label="Open in editor" disabled={!chat || current.status === "deleted"} onClick={() => openInEditor(current)}>
                  <ExternalLink />
                </Tool>
                <Button
                  variant={isViewed(current) ? "secondary" : "outline"}
                  size="xs"
                  aria-pressed={isViewed(current)}
                  onClick={() => toggleViewed(current)}
                >
                  <Check /> Viewed
                </Button>
              </span>
            </div>
            {current.binary ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">Binary file: not shown.</p>
            ) : current.missing ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                Not shown: the diff was cut before this file. Open it in your editor, or ask about it.
              </p>
            ) : current.hunks.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                {current.status === "renamed" ? `Renamed from ${current.from ?? "?"}, content unchanged.` : "No content changes."}
              </p>
            ) : (
              <DiffRows file={current} rows={rows} current={hunk} scroller={body} wrap={wrap} hunkTools={hunkTools} hunkMenu={hunkMenu} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
