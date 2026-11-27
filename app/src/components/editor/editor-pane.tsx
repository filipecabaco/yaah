// An editor pane: a folder's files in Monaco, VS Code style, beside the chats. An activity bar
// switches the side bar between the Explorer and Source Control; files open in tabs, a change
// opens as a split diff (its right side editable); a terminal opens underneath with Ctrl+`.
// The pane's content is `{ kind: "editor", cwd, file, projectId }` (layout.ts, saved with the
// layout). Rust reads and writes (editor_commands.rs); this polls git's status with a
// fingerprint, so a quiet repository costs one `git status` every few seconds.
// Loaded on demand (Monaco is big): App imports it lazily.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Code2, ExternalLink, Files, GitBranch, Search, SquareTerminal, X, ArrowDown, ArrowUp, Circle } from "lucide-react";
import { TerminalFolders } from "@/components/terminal/terminal-folders";
import { TerminalView } from "@/components/terminal/terminal-view";
import { inProject } from "@/components/terminal/use-terminals";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { runShortcut } from "@/hooks/use-shortcuts";
import type { Project, SessionInfo } from "@/lib/api";
import { CHANGED, editorApi, type Change, type ChangeStatus, type FileRead, type RepoStatus } from "@/lib/editor-api";
import { baseName, compactPath, plural } from "@/lib/format";
import type { Selection } from "@/lib/layout";
import { errorMessage } from "@/lib/narrow";
import { clearPaneInfo, setPaneInfo } from "@/lib/pane-info";
import { isMac, terminalShortcut } from "@/lib/shortcuts";
import { openInTerminalApp, terminalApi } from "@/lib/terminal-api";
import { cn } from "@/lib/utils";
import { Explorer } from "./explorer";
import { acquire, baseOptions, isDirty, monaco, onDocsChange, refresh, release, save, scratchModel, type Doc } from "./monaco";
import { QuickOpen } from "./quick-open";
import { SourceControl, type ChangeSide } from "./source-control";
import { STATUS_COLOR, stronger } from "./status";

type EditorContent = Extract<Selection, { kind: "editor" }>;

/** How often a visible pane asks Rust whether the repository moved. */
const POLL_MS = 3000;
const SIDEBAR = { min: 160, max: 520, initial: 260 };
const PANEL = { min: 80, initial: 220 };

/** A file of a folder (`root`), or a change shown as a split diff (`path` relative to the repository at `root`). */
type Tab =
  | { id: string; kind: "file"; root: string; path: string }
  | { id: string; kind: "diff"; root: string; path: string; side: ChangeSide; change: Change };

/** What a tab shows once it has loaded. */
type Loaded =
  | { kind: "file"; doc: Doc }
  | { kind: "unopenable"; read: FileRead }
  | { kind: "diff"; original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel; doc: Doc | null; scratch: monaco.editor.ITextModel[] }
  | { kind: "error"; message: string };

const fileTab = (root: string, path: string): Tab => ({ id: `file:${root}/${path}`, kind: "file", root, path });

/** Ctrl+` on every platform, as in VS Code. */
const isPanelKey = (e: KeyboardEvent) => e.ctrlKey && !e.metaKey && !e.altKey && (e.code === "Backquote" || e.key === "`");
const isMod = (e: KeyboardEvent) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey;

export default function EditorPane({
  pane,
  content,
  chats,
  projects,
  onContent,
  onClose,
}: {
  pane: string;
  content: EditorContent;
  /** For the folder step of a pane opened without one. */
  chats: SessionInfo[];
  projects: Project[];
  onContent: (c: EditorContent) => void;
  onClose: () => void;
}) {
  const { cwd } = content;
  if (!cwd) {
    const pick = (dir: string) => {
      const p = projects.find((x) => x.id === content.projectId);
      onContent({ kind: "editor", cwd: dir, ...(p && inProject(dir, p) ? { projectId: p.id } : {}) });
    };
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <Header title="Editor" onClose={onClose} />
        <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 py-8">
          <div className="flex h-fit w-full max-w-md flex-col gap-3">
            <div className="flex flex-col gap-1 px-1">
              <h2 className="text-sm font-medium">Open a folder</h2>
              <p className="text-xs text-muted-foreground">Its files, its git changes and a terminal, in one pane.</p>
            </div>
            <TerminalFolders purpose="editor" chats={chats} projects={projects} onPick={(dir) => dir && pick(dir)} onBack={onClose} />
          </div>
        </div>
      </div>
    );
  }
  return <Workbench key={cwd} pane={pane} cwd={cwd} content={content} onContent={onContent} onClose={onClose} />;
}

function Header({
  title,
  detail,
  branch,
  cwd,
  onClose,
}: {
  title: string;
  detail?: string;
  branch?: string | null;
  cwd?: string;
  onClose: () => void;
}) {
  return (
    <header data-tauri-drag-region="deep" className="flex h-9 shrink-0 items-center gap-2 border-b bg-background px-3 text-sm">
      <Code2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 font-medium">{title}</span>
      {branch && (
        <Badge variant="outline" className="font-mono">
          {branch}
        </Badge>
      )}
      {detail && <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span>}
      <span className="ml-auto flex min-w-0 items-center gap-1">
        {cwd && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={cwd}>
            {compactPath(cwd)}
          </span>
        )}
        {cwd && (
          <Button
            size="icon-xs"
            variant="ghost"
            title="Open this folder in your terminal app"
            aria-label="Open in terminal app"
            onClick={() => openInTerminalApp(cwd)}
          >
            <ExternalLink />
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" title="Close the pane" aria-label="Close editor pane" onClick={onClose}>
          <X />
        </Button>
      </span>
    </header>
  );
}

type Ask = { kind: "close-tab"; tab: Tab; doc: Doc } | { kind: "close-pane"; docs: Doc[] } | { kind: "conflict"; doc: Doc };

function Workbench({
  pane,
  cwd,
  content,
  onContent,
  onClose,
}: {
  pane: string;
  cwd: string;
  content: EditorContent;
  onContent: (c: EditorContent) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<"explorer" | "scm">("explorer");
  const [sidebarW, setSidebarW] = useState(SIDEBAR.initial);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // The file the pane had open, again after a restart.
  const [tabs, setTabs] = useState<Tab[]>(() => (content.file ? [fileTab(cwd, content.file)] : []));
  const [active, setActive] = useState<string | null>(() => tabs[0]?.id ?? null);
  const [loaded, setLoaded] = useState<Map<string, Loaded>>(new Map());
  const [, setTick] = useState(0);
  const [status, setStatus] = useState<RepoStatus | null | undefined>(undefined);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [stamp, setStamp] = useState("0");
  const [ask, setAsk] = useState<Ask | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [cursor, setCursor] = useState<{ line: number; col: number; lang: string } | null>(null);
  const [panel, setPanel] = useState<{ open: boolean; id: string | null; height: number; error: string | null }>({
    open: false,
    id: null,
    height: PANEL.initial,
    error: null,
  });

  const root = useRef<HTMLDivElement>(null);
  const codeHost = useRef<HTMLDivElement>(null);
  const diffHost = useRef<HTMLDivElement>(null);
  const code = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diff = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const latest = useRef({ tabs, active, loaded, status, content, onContent, panel });
  useLayoutEffect(() => {
    latest.current = { tabs, active, loaded, status, content, onContent, panel };
  });

  // Saved or edited somewhere: dirty markers redraw.
  useEffect(() => onDocsChange(() => setTick((t) => t + 1)), []);

  // ── the editors ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!codeHost.current || !diffHost.current) return;
    const opts = baseOptions();
    const c = monaco.editor.create(codeHost.current, { ...opts, model: null });
    const d = monaco.editor.createDiffEditor(diffHost.current, {
      ...opts,
      originalEditable: false,
      renderSideBySide: true,
      // Side by side down to a narrow pane, as the user asked for a split diff; inline only below that.
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 560,
      renderOverviewRuler: true,
      ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: false },
    });
    code.current = c;
    diff.current = d;
    const saveKey = monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS;
    const quickKey = monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP;
    for (const ed of [c, d.getModifiedEditor()]) {
      ed.addCommand(saveKey, () => void saveActive());
      ed.addCommand(quickKey, () => setQuickOpen(true));
      ed.onDidChangeCursorPosition((e) => {
        const lang = ed.getModel()?.getLanguageId() ?? "plaintext";
        setCursor({ line: e.position.lineNumber, col: e.position.column, lang });
      });
    }
    return () => {
      c.dispose();
      d.dispose();
      code.current = null;
      diff.current = null;
    };
    // saveActive reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Monaco takes the app's font when Settings → Fonts changes it.
  useEffect(() => {
    const mo = new MutationObserver(() => {
      const o = baseOptions();
      code.current?.updateOptions({ fontFamily: o.fontFamily, fontSize: o.fontSize, lineHeight: o.lineHeight });
      diff.current?.updateOptions({ fontFamily: o.fontFamily, fontSize: o.fontSize, lineHeight: o.lineHeight });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => mo.disconnect();
  }, []);

  // ── git status ───────────────────────────────────────────────────────────
  const fingerprint = useRef<string | undefined>(undefined);
  const poll = useCallback(
    async (force = false) => {
      try {
        const s = await editorApi.status(cwd, force ? undefined : fingerprint.current);
        setStatusError(null);
        if (s.repo === null) {
          fingerprint.current = undefined;
          setStatus(null);
          return false;
        }
        if (s.unchanged) return false;
        fingerprint.current = s.fingerprint;
        setStatus(s);
        setStamp(s.fingerprint);
        return true;
      } catch (e) {
        setStatusError(errorMessage(e));
        return false;
      }
    },
    [cwd],
  );

  /** Open documents and open diffs read again (after the repository or the files moved). */
  const resync = useCallback(async () => {
    const { loaded: l, tabs: ts } = latest.current;
    for (const [id, got] of l) {
      const doc = got.kind === "file" ? got.doc : got.kind === "diff" ? got.doc : null;
      if (doc && (await refresh(doc)) === "conflict") setAsk((a) => a ?? { kind: "conflict", doc });
      const tab = ts.find((t) => t.id === id);
      if (got.kind === "diff" && tab?.kind === "diff") {
        const fresh = await diffSides(tab, doc);
        if (fresh.kind !== "diff") continue;
        // Only the left side (and a staged right side) can move under us; the live document already did.
        if (got.original.getValue() !== fresh.original.getValue()) got.original.setValue(fresh.original.getValue());
        if (!doc && got.modified.getValue() !== fresh.modified.getValue()) got.modified.setValue(fresh.modified.getValue());
      }
    }
  }, []);

  useEffect(() => {
    let stop = false;
    // Not in the effect's own body: the read sets state when it lands.
    const first = setTimeout(() => void poll(true), 0);
    const t = setInterval(() => {
      if (document.hidden || stop) return;
      void poll().then((moved) => moved && void resync());
    }, POLL_MS);
    const onFocus = () => void poll().then(() => resync());
    window.addEventListener("focus", onFocus);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [poll, resync]);

  const repoChanged = useCallback(() => {
    void poll(true).then(() => resync());
  }, [poll, resync]);

  // A repository path as one of the pane's own (relative to `cwd`), or null when it is outside it.
  const toLocal = useCallback(
    (p: string) => {
      if (!status) return null;
      if (!status.prefix) return p;
      return p.startsWith(`${status.prefix}/`) ? p.slice(status.prefix.length + 1) : null;
    },
    [status],
  );

  const decorations = useMemo(() => {
    const out = new Map<string, ChangeStatus>();
    if (!status) return out;
    for (const c of [...status.conflicts, ...status.staged, ...status.changes]) {
      const local = toLocal(c.path);
      if (local == null) continue;
      out.set(local, stronger(out.get(local), c.status));
      const parts = local.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = `${parts.slice(0, i).join("/")}/`;
        out.set(dir, stronger(out.get(dir), c.status));
      }
    }
    return out;
  }, [status, toLocal]);
  const changeCount = status ? status.staged.length + status.changes.length + status.conflicts.length : 0;

  // ── tabs ─────────────────────────────────────────────────────────────────
  const setLoadedFor = (id: string, l: Loaded | null) =>
    setLoaded((was) => {
      const next = new Map(was);
      if (l) next.set(id, l);
      else next.delete(id);
      return next;
    });

  const load = useCallback(async (tab: Tab) => {
    if (latest.current.loaded.has(tab.id)) return;
    try {
      if (tab.kind === "file") {
        const got = await acquire(tab.root, tab.path);
        // Closed while it loaded.
        if (!latest.current.tabs.some((t) => t.id === tab.id)) {
          if ("model" in got) release(got);
          return;
        }
        setLoadedFor(tab.id, "model" in got ? { kind: "file", doc: got } : { kind: "unopenable", read: got });
      } else {
        const doc = tab.side === "changes" && tab.change.status !== "D" ? await acquireDoc(tab.root, tab.path) : null;
        const sides = await diffSides(tab, doc);
        if (!latest.current.tabs.some((t) => t.id === tab.id)) {
          if (doc) release(doc);
          if (sides.kind === "diff") sides.scratch.forEach((m) => m.dispose());
          return;
        }
        setLoadedFor(tab.id, sides);
      }
    } catch (e) {
      setLoadedFor(tab.id, { kind: "error", message: errorMessage(e) });
    }
  }, []);

  const openTab = useCallback(
    (tab: Tab) => {
      setTabs((ts) => (ts.some((t) => t.id === tab.id) ? ts : [...ts, tab]));
      setActive(tab.id);
      void load(tab);
    },
    [load],
  );

  const openFile = useCallback((path: string) => openTab(fileTab(cwd, path)), [cwd, openTab]);

  /** A repository path: as one of the pane's files when it's inside the folder, else from the repository's top. */
  const openRepoFile = (p: string) => {
    const local = toLocal(p);
    if (local != null) openFile(local);
    else if (status) openTab(fileTab(status.root, p));
  };
  const openChange = (c: Change, side: ChangeSide) => {
    if (!status) return;
    if (side === "conflicts") return openRepoFile(c.path);
    openTab({ id: `diff:${side}:${c.path}`, kind: "diff", root: status.root, path: c.path, side, change: c });
  };

  // The tabs it started with load once the editors are up.
  useEffect(() => {
    for (const t of latest.current.tabs) void load(t);
  }, [load]);

  const activeTab = tabs.find((t) => t.id === active) ?? null;
  const activeLoaded = active ? loaded.get(active) : undefined;

  // The active file is what the layout remembers.
  useEffect(() => {
    const t = activeTab;
    const file = t?.kind === "file" && t.root === cwd ? t.path : undefined;
    const { content: c, onContent: set } = latest.current;
    if (t && file !== c.file && t.kind === "file") set({ ...c, file });
  }, [activeTab, cwd]);

  // Show the active tab in the right editor, with its scroll and selection as it was left.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const c = code.current;
    const d = diff.current;
    if (!c || !d) return;
    const prev = shown.current;
    if (prev && prev !== active) {
      const prevLoaded = latest.current.loaded.get(prev);
      if (prevLoaded?.kind === "file") viewStates.current.set(prev, c.saveViewState());
    }
    shown.current = active;
    if (activeLoaded?.kind === "file") {
      if (c.getModel() !== activeLoaded.doc.model) {
        c.setModel(activeLoaded.doc.model);
        const vs = active ? viewStates.current.get(active) : null;
        if (vs) c.restoreViewState(vs);
      }
      c.updateOptions({ readOnly: activeLoaded.doc.readonly });
      // After the event that opened it: an Enter that picked the file must not land in it as a new line.
      setTimeout(() => c.focus(), 0);
    } else if (activeLoaded?.kind === "diff") {
      const m = d.getModel();
      if (m?.original !== activeLoaded.original || m?.modified !== activeLoaded.modified) {
        d.setModel({ original: activeLoaded.original, modified: activeLoaded.modified });
      }
      d.updateOptions({ readOnly: !activeLoaded.doc, renderSideBySide: true });
      setTimeout(() => d.getModifiedEditor().focus(), 0);
    }
  }, [active, activeLoaded]);

  const releaseLoaded = (l: Loaded | undefined, drop = false) => {
    if (!l) return;
    if (l.kind === "file") release(l.doc, drop);
    if (l.kind === "diff") {
      if (l.doc) release(l.doc, drop);
      // A model the diff editor still shows can't go first.
      if (diff.current?.getModel()?.original === l.original) diff.current.setModel(null);
      l.scratch.forEach((m) => m.dispose());
    }
  };

  /** Close a tab; with unsaved edits only this tab holds, ask first. */
  const closeTab = (tab: Tab, force = false) => {
    const l = latest.current.loaded.get(tab.id);
    const doc = l?.kind === "file" ? l.doc : l?.kind === "diff" ? l.doc : null;
    if (!force && doc && isDirty(doc) && doc.refs <= 1) {
      setAsk({ kind: "close-tab", tab, doc });
      return;
    }
    const ts = latest.current.tabs;
    const i = ts.findIndex((t) => t.id === tab.id);
    const rest = ts.filter((t) => t.id !== tab.id);
    if (code.current?.getModel() && l?.kind === "file" && code.current.getModel() === l.doc.model) code.current.setModel(null);
    releaseLoaded(l, force);
    setLoadedFor(tab.id, null);
    viewStates.current.delete(tab.id);
    setTabs(rest);
    if (latest.current.active === tab.id) setActive(rest[Math.min(i, rest.length - 1)]?.id ?? null);
  };

  // Everything this pane holds goes back when it goes (unsaved documents stay for the next pane, see monaco.ts).
  useEffect(
    () => () => {
      for (const l of latest.current.loaded.values()) releaseLoaded(l);
    },
    [],
  );

  const heldDocs = () => {
    const out = new Set<Doc>();
    for (const l of latest.current.loaded.values()) {
      if (l.kind === "file") out.add(l.doc);
      if (l.kind === "diff" && l.doc) out.add(l.doc);
    }
    return [...out];
  };

  const close = () => {
    const dirty = heldDocs().filter(isDirty);
    if (dirty.length) setAsk({ kind: "close-pane", docs: dirty });
    else onClose();
  };

  // ── saving ───────────────────────────────────────────────────────────────
  const saveDoc = async (doc: Doc, force = false) => {
    try {
      await save(doc, force);
      repoChanged();
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      if (msg.startsWith(CHANGED)) setAsk({ kind: "conflict", doc });
      else setStatusError(msg);
      return false;
    }
  };
  async function saveActive() {
    const { active: a, loaded: l } = latest.current;
    const got = a ? l.get(a) : undefined;
    const doc = got?.kind === "file" ? got.doc : got?.kind === "diff" ? got.doc : null;
    if (doc) await saveDoc(doc);
  }

  // ── terminal panel ───────────────────────────────────────────────────────
  const togglePanel = useCallback(() => {
    const p = latest.current.panel;
    if (p.open) {
      setPanel({ ...p, open: false });
      // Back to the editor, as VS Code does.
      setTimeout(() => {
        const d = diff.current;
        if (latest.current.loaded.get(latest.current.active ?? "")?.kind === "diff") d?.getModifiedEditor().focus();
        else code.current?.focus();
      }, 0);
      return;
    }
    setPanel({ ...p, open: true, error: null });
    if (!p.id) {
      terminalApi.open(cwd, 100, Math.max(5, Math.floor(p.height / 16))).then(
        (o) => setPanel((x) => ({ ...x, id: o.id })),
        (e: unknown) => setPanel((x) => ({ ...x, error: errorMessage(e) })),
      );
    }
  }, [cwd]);
  // The shell goes with the pane.
  useEffect(
    () => () => {
      const id = latest.current.panel.id;
      if (id) void terminalApi.close(id).catch(() => {});
    },
    [],
  );

  // Keys: Ctrl+` anywhere in the pane (the terminal too), ⌘S / ⌘P / ⌘B outside Monaco too, and the
  // app's pane keys (⌘K, ⌘W, ⌘D…) out of Monaco, which would otherwise take ⌘K as a chord.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (isPanelKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
        return;
      }
      const inTerminal = e.target instanceof Element && !!e.target.closest("[data-editor-panel]");
      if (inTerminal) return;
      if (isMod(e) && !e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        e.stopPropagation();
        setQuickOpen(true);
        return;
      }
      if (isMod(e) && !e.shiftKey && e.code === "KeyS") {
        e.preventDefault();
        e.stopPropagation();
        void saveActive();
        return;
      }
      if (isMod(e) && !e.shiftKey && e.code === "KeyB" && e.target instanceof Element && e.target.closest(".monaco-editor")) {
        e.preventDefault();
        e.stopPropagation();
        setSidebarOpen((o) => !o);
        return;
      }
      if (e.target instanceof Element && e.target.closest(".monaco-editor")) {
        const hit = terminalShortcut(e);
        if (hit) {
          e.preventDefault();
          e.stopPropagation();
          runShortcut(hit);
        }
      }
    };
    el.addEventListener("keydown", onKey, true);
    return () => el.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [togglePanel]);

  // ── sidebar list entry ───────────────────────────────────────────────────
  const name = status?.name ?? baseName(cwd);
  const dirtyCount = heldDocs().filter(isDirty).length;
  const detail = dirtyCount ? `${plural(dirtyCount, "unsaved file")}` : changeCount ? plural(changeCount, "change") : undefined;
  useEffect(() => {
    setPaneInfo(pane, { title: name, detail });
  }, [pane, name, detail]);
  useEffect(() => () => clearPaneInfo(pane), [pane]);

  // ── layout drags ─────────────────────────────────────────────────────────
  const dragSidebar = (e: ReactPointerEvent) => drag(e, "x", sidebarW, (v) => setSidebarW(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, v))));
  const dragPanel = (e: ReactPointerEvent) => {
    const max = (root.current?.clientHeight ?? 600) - 120;
    drag(e, "y", panel.height, (v) => setPanel((p) => ({ ...p, height: Math.min(max, Math.max(PANEL.min, v)) })), true);
  };

  const langName = cursor ? (monaco.languages.getLanguages().find((l) => l.id === cursor.lang)?.aliases?.[0] ?? cursor.lang) : null;
  const breadcrumbs = activeTab ? activeTab.path.split("/") : [];

  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <Header title={`Editor · ${name}`} branch={status?.branch ?? (status?.detached ? "detached" : null)} cwd={cwd} onClose={close} />
      <div className="flex min-h-0 flex-1">
        {/* Activity bar */}
        <nav aria-label="Editor views" className="flex w-11 shrink-0 flex-col items-center gap-1 border-r bg-muted/30 py-2">
          <ActivityButton
            label="Explorer"
            active={sidebarOpen && view === "explorer"}
            onClick={() => (view === "explorer" && sidebarOpen ? setSidebarOpen(false) : (setView("explorer"), setSidebarOpen(true)))}
          >
            <Files />
          </ActivityButton>
          <ActivityButton label="Quick open a file" active={false} onClick={() => setQuickOpen(true)} keys={isMac ? "⌘P" : "Ctrl+P"}>
            <Search />
          </ActivityButton>
          <ActivityButton
            label="Source Control"
            active={sidebarOpen && view === "scm"}
            badge={changeCount || undefined}
            onClick={() => (view === "scm" && sidebarOpen ? setSidebarOpen(false) : (setView("scm"), setSidebarOpen(true)))}
          >
            <GitBranch />
          </ActivityButton>
          <div className="flex-1" />
          <ActivityButton label="Toggle the terminal" active={panel.open} onClick={togglePanel} keys="Ctrl+`">
            <SquareTerminal />
          </ActivityButton>
        </nav>

        {/* Side bar */}
        {sidebarOpen && (
          <>
            <aside className="flex min-h-0 shrink-0 flex-col bg-muted/20" style={{ width: sidebarW }}>
              {view === "explorer" ? (
                <Explorer
                  root={cwd}
                  title={name}
                  stamp={stamp}
                  decorations={decorations}
                  active={activeTab?.kind === "file" && activeTab.root === cwd ? activeTab.path : null}
                  onOpen={openFile}
                />
              ) : status ? (
                <SourceControl status={status} onOpenChange={openChange} onOpenFile={openRepoFile} onChanged={repoChanged} />
              ) : (
                <div className="p-4 text-xs text-muted-foreground">
                  {status === undefined
                    ? "Reading the repository…"
                    : statusError
                      ? `Couldn't read git: ${statusError}`
                      : `${compactPath(cwd)} isn't in a git repository.`}
                </div>
              )}
            </aside>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the side bar"
              tabIndex={0}
              onPointerDown={dragSidebar}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setSidebarW((w) => Math.max(SIDEBAR.min, w - 16));
                if (e.key === "ArrowRight") setSidebarW((w) => Math.min(SIDEBAR.max, w + 16));
              }}
              className="w-1 shrink-0 cursor-col-resize border-l bg-transparent outline-none hover:bg-ring/40 focus-visible:bg-ring/60"
            />
          </>
        )}

        {/* Editor group + panel */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            role="tablist"
            aria-label="Open files"
            className="flex h-9 shrink-0 [scrollbar-width:thin] items-stretch overflow-x-auto border-b bg-muted/20"
          >
            {tabs.map((t) => {
              const l = loaded.get(t.id);
              const doc = l?.kind === "file" ? l.doc : l?.kind === "diff" ? l.doc : null;
              const dirty = !!doc && isDirty(doc);
              const label = t.kind === "diff" ? `${baseName(t.path)} (${t.side === "staged" ? "Index" : "Working Tree"})` : baseName(t.path);
              const status = t.kind === "diff" ? t.change.status : decorations.get(t.root === cwd ? t.path : "");
              return (
                <div
                  key={t.id}
                  role="tab"
                  aria-selected={t.id === active}
                  title={t.kind === "diff" ? `${t.path} · ${t.side === "staged" ? "HEAD ↔ Index" : "Index ↔ Working Tree"}` : t.path}
                  className={cn(
                    "group/tab flex max-w-56 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 border-r pr-1 pl-3 text-[13px] select-none",
                    t.id === active
                      ? "border-t-2 border-t-primary bg-background"
                      : "border-t-2 border-t-transparent text-muted-foreground hover:bg-background/60",
                  )}
                  onClick={() => setActive(t.id)}
                  onAuxClick={(e) => e.button === 1 && closeTab(t)}
                >
                  <span className={cn("min-w-0 truncate", t.kind === "diff" && "italic", status && STATUS_COLOR[status])}>{label}</span>
                  <button
                    type="button"
                    aria-label={dirty ? `${label} has unsaved changes. Close` : `Close ${label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t);
                    }}
                    className="group/close grid size-5 shrink-0 place-items-center rounded-sm hover:bg-accent"
                  >
                    {dirty ? (
                      <>
                        <Circle className="size-2.5 fill-current group-hover/close:hidden" />
                        <X className="hidden size-3.5 group-hover/close:block" />
                      </>
                    ) : (
                      <X className={cn("size-3.5", t.id === active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100")} />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          {activeTab && (
            <div className="flex h-6 shrink-0 items-center gap-1 overflow-hidden px-3 text-xs text-muted-foreground">
              {breadcrumbs.map((b, i) => (
                <span key={i} className="flex shrink-0 items-center gap-1">
                  {i > 0 && <span className="opacity-50">›</span>}
                  <span className={cn(i === breadcrumbs.length - 1 && "text-foreground")}>{b}</span>
                </span>
              ))}
              {activeTab.kind === "diff" && (
                <span className="ml-2 opacity-70">{activeTab.side === "staged" ? "HEAD ↔ Index" : "Index ↔ Working Tree"}</span>
              )}
            </div>
          )}

          <div className="relative min-h-0 flex-1">
            <div ref={codeHost} className={cn("absolute inset-0", activeLoaded?.kind !== "file" && "hidden")} />
            <div ref={diffHost} className={cn("absolute inset-0", activeLoaded?.kind !== "diff" && "hidden")} />
            {!activeTab && (
              <div className="absolute inset-0 grid place-items-center">
                <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                  <Code2 className="size-10 opacity-30" />
                  <p>Open a file from the Explorer.</p>
                  <p className="text-xs">
                    <Kbd>{isMac ? "⌘P" : "Ctrl+P"}</Kbd> quick open · <Kbd>{isMac ? "⌘S" : "Ctrl+S"}</Kbd> save · <Kbd>Ctrl+`</Kbd> terminal
                  </p>
                </div>
              </div>
            )}
            {activeTab && !activeLoaded && <div className="absolute inset-0" aria-busy="true" />}
            {activeLoaded?.kind === "unopenable" && (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
                {activeLoaded.read.binary ? "This file is binary, so it isn't shown." : "This file is too large to open here."}
              </div>
            )}
            {activeLoaded?.kind === "error" && (
              <div role="alert" className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
                Couldn't open it: {activeLoaded.message}
              </div>
            )}
          </div>

          {panel.open && (
            <>
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the terminal"
                onPointerDown={dragPanel}
                className="h-1 shrink-0 cursor-row-resize border-t hover:bg-ring/40"
              />
              <section data-editor-panel aria-label="Terminal" className="flex shrink-0 flex-col bg-background" style={{ height: panel.height }}>
                <div className="flex h-7 shrink-0 items-center gap-2 px-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  <span className="border-b border-primary pb-0.5 text-foreground">Terminal</span>
                  <span className="ml-auto flex items-center gap-0.5 normal-case">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      title="Kill the terminal"
                      aria-label="Kill the terminal"
                      onClick={() => {
                        if (panel.id) void terminalApi.close(panel.id).catch(() => {});
                        setPanel((p) => ({ ...p, id: null, open: false }));
                      }}
                    >
                      <X />
                    </Button>
                  </span>
                </div>
                <div className="relative min-h-0 flex-1 px-2">
                  {panel.error ? (
                    <p role="alert" className="p-2 text-xs text-destructive">
                      Couldn't start a shell: {panel.error}
                    </p>
                  ) : panel.id ? (
                    <TerminalView
                      key={panel.id}
                      terminalId={panel.id}
                      interactive
                      autoFocus
                      className="h-full"
                      onExit={() => setPanel((p) => ({ ...p, id: null, open: false }))}
                      onGone={() => setPanel((p) => ({ ...p, id: null }))}
                    />
                  ) : null}
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      {/* Status bar */}
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t bg-muted/40 px-3 text-[11px] text-muted-foreground">
        {status && (
          <button type="button" className="flex items-center gap-1 hover:text-foreground" onClick={() => (setView("scm"), setSidebarOpen(true))}>
            <GitBranch className="size-3" />
            {status.branch ?? status.oid?.slice(0, 7) ?? "no commits"}
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
          </button>
        )}
        {statusError && <span className="truncate text-destructive">{statusError}</span>}
        <span className="flex-1" />
        {cursor && activeLoaded && (activeLoaded.kind === "file" || activeLoaded.kind === "diff") && (
          <>
            <span>
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span>{langName}</span>
          </>
        )}
        <button type="button" className="hover:text-foreground" onClick={togglePanel}>
          Ctrl+` Terminal
        </button>
      </footer>

      {quickOpen && (
        <QuickOpen
          root={cwd}
          onClose={() => setQuickOpen(false)}
          onPick={(path) => {
            setQuickOpen(false);
            openFile(path);
          }}
        />
      )}

      <AskDialog
        ask={ask}
        onCancel={() => setAsk(null)}
        onCloseTab={async (tab, doc, saveFirst) => {
          setAsk(null);
          if (saveFirst && !(await saveDoc(doc))) return;
          closeTab(tab, true);
        }}
        onClosePane={async (docs, saveFirst) => {
          setAsk(null);
          if (saveFirst) {
            for (const d of docs) if (!(await saveDoc(d))) return;
          } else {
            for (const l of latest.current.loaded.values()) releaseLoaded(l, true);
            setLoaded(new Map());
          }
          onClose();
        }}
        onConflict={async (doc, overwrite) => {
          setAsk(null);
          if (overwrite) await saveDoc(doc, true);
          else {
            // Take the disk's version: the edits here go.
            doc.savedAt = -1;
            doc.version = null;
            const read = await editorApi.read(doc.root, doc.path).catch(() => null);
            if (read && !read.binary) {
              doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: read.text }], () => null);
              doc.version = read.version;
              doc.savedAt = doc.model.getAlternativeVersionId();
            }
          }
        }}
      />
    </div>
  );
}

/** The editor holding the file's live document, so a diff's right side and the file's own tab edit the same text. */
async function acquireDoc(root: string, path: string): Promise<Doc | null> {
  const got = await acquire(root, path);
  return "model" in got ? got : null;
}

/** The two sides of a change: HEAD ↔ index when staged, index ↔ work tree (the live document) otherwise. */
async function diffSides(tab: Extract<Tab, { kind: "diff" }>, doc: Doc | null): Promise<Loaded> {
  const { root, path, side, change } = tab;
  const before = change.oldPath && (change.status === "R" || change.status === "C") ? change.oldPath : path;
  const text = (f: Awaited<ReturnType<typeof editorApi.file>>) => (f && !f.binary ? f.text : "");
  const scratch: monaco.editor.ITextModel[] = [];
  const tag = `${encodeURIComponent(root)}/${side}`;
  if (side === "staged") {
    const [head, index] = await Promise.all([editorApi.file(root, before, "HEAD"), editorApi.file(root, path, "INDEX")]);
    const original = scratchModel(text(head), path, `${tag}/HEAD`);
    const modified = scratchModel(change.status === "D" ? "" : text(index), path, `${tag}/INDEX`);
    scratch.push(original, modified);
    return { kind: "diff", original, modified, doc: null, scratch };
  }
  // Against the index (what `git add` would stage); an untracked file against nothing.
  const index = change.untracked ? null : await editorApi.file(root, before, "INDEX");
  const original = scratchModel(text(index), path, `${tag}/INDEX`);
  scratch.push(original);
  if (doc) return { kind: "diff", original, modified: doc.model, doc, scratch };
  const modified = scratchModel("", path, `${tag}/deleted`);
  scratch.push(modified);
  return { kind: "diff", original, modified, doc: null, scratch };
}

function drag(e: ReactPointerEvent, axis: "x" | "y", start: number, set: (v: number) => void, invert = false) {
  if (e.button !== 0) return;
  e.preventDefault();
  const origin = axis === "x" ? e.clientX : e.clientY;
  const move = (ev: PointerEvent) => {
    const delta = (axis === "x" ? ev.clientX : ev.clientY) - origin;
    set(start + (invert ? -delta : delta));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = "";
  };
  document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">{children}</kbd>;
}

function ActivityButton({
  label,
  active,
  badge,
  keys,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  badge?: number;
  keys?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={keys ? `${label} (${keys})` : label}
      onClick={onClick}
      className={cn(
        "relative grid size-9 place-items-center rounded-md text-muted-foreground hover:text-foreground [&_svg]:size-5",
        active && "text-foreground before:absolute before:top-1.5 before:bottom-1.5 before:-left-1 before:w-0.5 before:rounded before:bg-primary",
      )}
    >
      {children}
      {badge != null && (
        <span className="absolute right-0.5 bottom-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-[9px] leading-none font-semibold text-primary-foreground">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

function AskDialog({
  ask,
  onCancel,
  onCloseTab,
  onClosePane,
  onConflict,
}: {
  ask: Ask | null;
  onCancel: () => void;
  onCloseTab: (tab: Tab, doc: Doc, save: boolean) => Promise<void>;
  onClosePane: (docs: Doc[], save: boolean) => Promise<void>;
  onConflict: (doc: Doc, overwrite: boolean) => Promise<void>;
}) {
  let title = "";
  let body = "";
  let actions: React.ReactNode = null;
  if (ask?.kind === "close-tab") {
    title = `Save the changes to ${baseName(ask.doc.path)}?`;
    body = "Your changes are lost if you don't save them.";
    actions = (
      <>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" onClick={() => void onCloseTab(ask.tab, ask.doc, false)}>
          Don't Save
        </Button>
        <Button autoFocus onClick={() => void onCloseTab(ask.tab, ask.doc, true)}>
          Save
        </Button>
      </>
    );
  } else if (ask?.kind === "close-pane") {
    title = `Save ${ask.docs.length === 1 ? `the changes to ${baseName(ask.docs[0].path)}` : `changes to ${plural(ask.docs.length, "file")}`}?`;
    body = ask.docs.map((d) => d.path).join(", ");
    actions = (
      <>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" onClick={() => void onClosePane(ask.docs, false)}>
          Don't Save
        </Button>
        <Button autoFocus onClick={() => void onClosePane(ask.docs, true)}>
          Save All
        </Button>
      </>
    );
  } else if (ask?.kind === "conflict") {
    title = `${baseName(ask.doc.path)} changed on disk`;
    body =
      "Something else (the agent, another editor, git) changed the file since you opened it. Keep your version and overwrite it, or take the one on disk?";
    actions = (
      <>
        <Button variant="outline" onClick={onCancel}>
          Decide later
        </Button>
        <Button variant="outline" onClick={() => void onConflict(ask.doc, false)}>
          Take Disk Version
        </Button>
        <Button autoFocus onClick={() => void onConflict(ask.doc, true)}>
          Overwrite
        </Button>
      </>
    );
  }
  return (
    <Dialog open={!!ask} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-words">{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
