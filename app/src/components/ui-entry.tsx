// Transcript entries the agent puts up through yaah's UI server: rendered UI
// (with Expand, a large dialog showing the same UI), and a request to add
// folders to the chat (`ui_request_folders`).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { FolderPlus, LayoutPanelTop, Loader2, Maximize2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { CopyMenu } from "@/components/menus";
import { ErrorText } from "@/components/error-text";
import { useChat } from "@/components/chat-context";
import { UiTree } from "@/components/ui-render";
import type { FormHost } from "@/components/ui-form-host";
import { UiViewContext, type UiView } from "@/components/ui-view";
import { api, type Entry } from "@/lib/api";
import { openComponent } from "@/lib/app-events";
import { compactPath } from "@/lib/format";
import { uiTitle } from "@/lib/ui-title";
import { cn } from "@/lib/utils";

type Of<T extends Entry["type"]> = Extract<Entry, { type: T }>;

/** Typing somewhere the F key means a letter, not "expand". */
const typing = (el: EventTarget | null) => el instanceof HTMLElement && !!el.closest("input, textarea, select, [contenteditable='true']");

/** F, unmodified, not typed into a field: expand. */
const isExpandKey = (e: KeyboardEvent | ReactKeyboardEvent) =>
  (e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target);

/** The first thing to focus in expanded UI: a field, a block that takes keys (diff-review), else a button. */
function focusFirst(root: HTMLElement) {
  const el =
    root.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex='0']") ??
    root.querySelector<HTMLElement>("button:not([disabled])");
  el?.focus({ preventScroll: true });
}

/**
 * One rendered UI, in one place at a time. It is rendered once, into `host`, and `host`
 * is moved between the inline slot and the dialog's: moving a DOM node doesn't remount
 * React, so the dialog shows the very same UI (its live readings, form values, viewed
 * ticks, selected file and scroll), never a copy that would poll its sources again.
 */
function useMovable(expanded: boolean) {
  const [host] = useState(() => document.createElement("div"));
  const inline = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const inDialog = expanded && slot != null;
    const target = inDialog ? slot : inline.current;
    if (target) place(host, target, inDialog);
  }, [expanded, slot, host]);
  return { host, inline, setSlot };
}

/** Put `node` in `target`; in the dialog it fills the height, and what it holds gets the focus. */
function place(node: HTMLElement, target: HTMLElement, inDialog: boolean) {
  node.className = inDialog ? "h-full" : "";
  if (node.parentNode !== target) target.appendChild(node);
  if (inDialog) focusFirst(node);
}

export function UiEntry({ entry, index }: { entry: Of<"ui">; index: number }) {
  const sessionId = useChat()?.sessionId;
  // Forms in this UI answer through its transcript entry (and a waiting ui_ask, if any),
  // and share their draft with the agent (ui_get_values / ui_set_values).
  const form = useMemo<FormHost>(
    () => ({
      answer: entry.answer,
      asking: !!entry.askId,
      draft: entry.draft,
      draftBy: entry.draftBy,
      onSubmit: sessionId ? (values) => api.answerUi(sessionId, index, values) : undefined,
      onEdit: sessionId ? (values) => api.editUi(sessionId, index, values).then(() => undefined) : undefined,
    }),
    [entry.answer, entry.askId, entry.draft, entry.draftBy, sessionId, index],
  );
  const [expanded, setExpanded] = useState(false);
  const expand = useCallback(() => setExpanded(true), []);
  const name = uiTitle(entry);
  const view = useMemo<UiView>(() => ({ expanded, expand: expanded ? undefined : expand, name }), [expanded, expand, name]);
  const { host, inline, setSlot } = useMovable(expanded);

  // F expands it: with focus inside the entry, or with the pointer over it (unless typing elsewhere).
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!hovered || expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isExpandKey(e) || typing(document.activeElement)) return;
      e.preventDefault();
      setExpanded(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hovered, expanded]);

  return (
    <div
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (expanded || !isExpandKey(e)) return;
        e.preventDefault();
        setExpanded(true);
      }}
    >
      <CopyMenu
        act={() => {
          const component = entry.component;
          return component ? [{ label: "Open in Component library", icon: <LayoutPanelTop />, onSelect: () => openComponent(component) }] : [];
        }}
        actions={[
          { label: "Copy UI JSON", text: () => JSON.stringify(entry.tree, null, 2) },
          { label: "Copy props JSON", text: () => JSON.stringify(entry.props, null, 2) },
        ]}
      >
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LayoutPanelTop className="size-3" />
            {entry.title ?? (entry.component ? null : "UI")}
            {entry.askId && entry.answer == null && (
              <Badge variant="secondary" className="h-4 px-1 text-2xs">
                waiting for you
              </Badge>
            )}
            {entry.component && entry.version != null && (
              <Badge variant="outline" className="h-4 px-1 font-mono text-2xs">
                {entry.component} v{entry.version}
              </Badge>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              aria-label={`Expand ${name}`}
              title="Expand (F)"
              aria-pressed={expanded}
              onClick={expand}
            >
              <Maximize2 />
            </Button>
          </figcaption>
          {/* Inline, the UI sits here; expanded, it is moved into the dialog (useMovable). */}
          <div ref={inline} data-ui-slot="inline" />
          {expanded && (
            <button
              type="button"
              className="rounded-md border border-dashed px-3 py-3 text-left text-xs text-muted-foreground hover:text-foreground"
              onClick={expand}
            >
              Shown expanded
            </button>
          )}
          {createPortal(
            <UiViewContext.Provider value={view}>
              {/* Expanded, the transcript's right-click menu stays out of the dialog. */}
              <div className="contents" onContextMenu={expanded ? (e) => e.stopPropagation() : undefined}>
                <UiTree tree={entry.tree} props={entry.props} form={form} />
              </div>
            </UiViewContext.Provider>,
            host,
          )}
        </figure>
      </CopyMenu>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          className="flex h-[92vh] w-[96vw] max-w-none flex-col gap-0 bg-background p-0 sm:max-w-none"
          // Focus goes to the UI itself once it is moved in (useMovable), so its keys work at once.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex items-center gap-3 border-b px-4 py-2.5 pr-12">
            <DialogTitle className="truncate text-sm">{name}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              {entry.component && entry.version != null ? `${entry.component} v${entry.version}` : "Agent UI"}
            </DialogDescription>
          </div>
          <div ref={setSlot} data-ui-slot="dialog" className="min-h-0 flex-1 overflow-auto p-4" />
        </DialogContent>
      </Dialog>
    </div>
  );
}

const FOLDER_ANSWER: Record<string, string> = { added: "Added", declined: "Not now", cancelled: "Cancelled" };

/** The agent asks to add folders to this chat (`ui_request_folders`); it waits for Add or Not now. */
export function FolderRequestEntry({ entry, index }: { entry: Of<"folderRequest">; index: number }) {
  const chat = useChat();
  const [sending, setSending] = useState<"add" | "decline" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pending = entry.answer == null;
  const answer = (add: boolean) => {
    if (!chat) return;
    setSending(add ? "add" : "decline");
    setError(null);
    api
      .answerFolderRequest(chat.sessionId, index, add)
      .catch(setError)
      .finally(() => setSending(null));
  };
  const paths = entry.paths.map((p) => compactPath(p));
  return (
    <div role="group" aria-label="Folder request" className={cn("rounded-lg border px-3 py-2", pending && "border-amber-500/60 bg-amber-500/5")}>
      <div className="flex items-start gap-2 text-sm">
        <FolderPlus className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
        <div className="min-w-0 flex-1">
          <p>
            The agent wants to add{" "}
            {paths.map((p, i) => (
              <span key={p}>
                {i > 0 && (i === paths.length - 1 ? " and " : ", ")}
                <span className="font-mono text-xs [overflow-wrap:anywhere]" title={entry.paths[i]}>
                  {p}
                </span>
              </span>
            ))}{" "}
            to this chat
          </p>
          {entry.reason && <p className="text-xs text-muted-foreground">{entry.reason}</p>}
        </div>
      </div>
      {pending ? (
        <div className="mt-2 flex flex-wrap gap-2 pl-6">
          <Button size="sm" disabled={!chat || sending != null} onClick={() => answer(true)}>
            {sending === "add" && <Loader2 className="animate-spin" />}
            Add
          </Button>
          <Button size="sm" variant="outline" disabled={!chat || sending != null} onClick={() => answer(false)}>
            {sending === "decline" && <Loader2 className="animate-spin" />}
            Not now
          </Button>
        </div>
      ) : (
        <div className="mt-1 pl-6 text-xs text-muted-foreground">→ {FOLDER_ANSWER[entry.answer ?? ""] ?? entry.answer}</div>
      )}
      <ErrorText error={error} className="mt-1 pl-6" />
    </div>
  );
}
