// The messages a chat has queued, above its composer: each one's text (one line, opens to
// all of it), what it carries, and Send now, Edit, Move up/down and Remove; the count, why
// the queue is paused and Resume. Rust owns the queue (session/queue.rs): the order, when
// the next goes and when it pauses. This draws what it sends and asks it for changes.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Loader2, Pencil, Play, SendHorizontal, Trash2 } from "lucide-react";
import { Hint } from "@/components/shortcuts";
import { ErrorText } from "@/components/error-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { draftIntoChat, draftIntoComposer } from "@/components/chat-context";
import { api, type QueuedMessage, type SessionInfo } from "@/lib/api";
import { sendIncoming } from "@/lib/attachments";
import { configNote, countsText, mentionLabels, oneLine, pauseText, queueAnnouncement, queuedBadge, queuedItems } from "@/lib/queue";
import { cn } from "@/lib/utils";

export function ComposerQueue({ session, pane }: { session: SessionInfo; pane?: string }) {
  const { sessionId, queue } = session;
  const items = queuedItems(session);
  const [error, setError] = useState<unknown>(null);
  const [announce, setAnnounce] = useState("");
  const headingId = useId();
  const list = useRef<HTMLOListElement>(null);

  // What changed in Rust (queued here or in another pane, sent as a turn ended, paused) is announced.
  const before = useRef(queue);
  useEffect(() => {
    const said = queueAnnouncement(before.current, queue);
    before.current = queue;
    if (said) setAnnounce(said);
  }, [queue]);

  const act = (run: () => Promise<unknown>, said?: string) => {
    setError(null);
    run().then(
      () => said && setAnnounce(said),
      (e: unknown) => setError(e),
    );
  };
  /** After a row goes, the next row (or the one before it) keeps the keyboard where it was. */
  const focusRow = (index: number) =>
    setTimeout(() => {
      const rows = list.current?.querySelectorAll<HTMLElement>("[data-queue-row] button[data-first]");
      rows?.[Math.min(index, rows.length - 1)]?.focus();
    });

  const edit = (item: QueuedMessage, index: number) =>
    act(
      async () => {
        const e = await api.queueEdit(sessionId, item.id);
        const draft = { text: e.text, mentions: mentionLabels(e.text, e.mentions) };
        if (draft.text || draft.mentions.length) {
          if (pane) draftIntoComposer(draft, pane);
          else draftIntoChat(sessionId, draft);
        }
        if (e.attachments.length || e.refused.length) sendIncoming(sessionId, pane, { staged: e.attachments, refused: e.refused });
        if (!draft.text) focusRow(index);
      },
      `Back in the message box: ${oneLine(item.text)}`,
    );
  const remove = (item: QueuedMessage, index: number) =>
    act(
      async () => {
        await api.queueRemove(sessionId, item.id);
        focusRow(index);
      },
      `Removed from the queue: ${oneLine(item.text)}`,
    );
  const move = (item: QueuedMessage, index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= items.length || items[to]?.sending) return;
    act(() => api.queueMove(sessionId, item.id, to), `Moved ${by < 0 ? "up" : "down"}: ${oneLine(item.text)}, ${to + 1} of ${items.length}`);
  };

  // The live region stays mounted, so the last message leaving the queue is still announced.
  const live = (
    <p className="sr-only" role="status" aria-live="polite">
      {announce}
    </p>
  );
  if (!items.length) return live;
  const paused = pauseText(queue);
  const detail = queue?.paused?.detail;
  return (
    <section aria-labelledby={headingId} data-slot="composer-queue" className="@container border-t pt-2 pb-1">
      <div className="chat-column flex flex-col gap-1">
        <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <h2 id={headingId} className="sr-only">
            Queued messages
          </h2>
          <Badge variant="secondary" className="tabular-nums">
            {queuedBadge(items.length)}
          </Badge>
          {paused ? (
            <>
              <span className="text-muted-foreground" title={detail}>
                {paused}
              </span>
              <Button size="xs" variant="outline" onClick={() => act(() => api.queueResume(sessionId), "Queue resumed")}>
                <Play /> Resume queue
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground">{session.running ? "Sent one at a time as each turn ends" : "Sending…"}</span>
          )}
        </div>
        {paused && detail && <p className="text-xs [overflow-wrap:anywhere] text-muted-foreground">{detail}</p>}
        <ol ref={list} className="flex max-h-48 flex-col overflow-y-auto" aria-labelledby={headingId}>
          {items.map((item, i) => (
            <QueueRow
              key={item.id}
              item={item}
              index={i}
              count={items.length}
              note={configNote(session, item)}
              blocked={items.some((x) => x.sending)}
              onSendNow={() => act(() => api.queueSendNow(sessionId, item.id), `Sending next: ${oneLine(item.text)}`)}
              onEdit={() => edit(item, i)}
              onRemove={() => remove(item, i)}
              onMove={(by) => move(item, i, by)}
            />
          ))}
        </ol>
        <ErrorText error={error} />
      </div>
      {live}
    </section>
  );
}

function QueueRow({
  item,
  index,
  count,
  note,
  blocked,
  onSendNow,
  onEdit,
  onRemove,
  onMove,
}: {
  item: QueuedMessage;
  index: number;
  count: number;
  note: string | null;
  /** A queued message is on its way: Send now waits for it. */
  blocked: boolean;
  onSendNow: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(false);
  const textId = useId();
  const counts = countsText(item);
  const short = oneLine(item.text, 40);
  const sending = !!item.sending;
  const first = index === 0 || (index === 1 && blocked);
  // Alt+↑ / Alt+↓ anywhere in the row moves it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.altKey || sending || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    onMove(e.key === "ArrowUp" ? -1 : 1);
  };
  return (
    <li
      data-queue-row
      onKeyDown={onKeyDown}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      className="flex items-start gap-2 rounded-md px-1.5 py-0.5 focus-within:bg-muted/50 hover:bg-muted/50"
    >
      <span className="mt-1 w-4 shrink-0 text-right text-xs text-muted-foreground tabular-nums" aria-hidden>
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          data-first
          id={textId}
          aria-expanded={open}
          aria-label={`${open ? "Fold" : "Show all of"} queued message ${index + 1} of ${count}: ${oneLine(item.text)}`}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-[24px] w-full items-start gap-1 rounded-sm text-left text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronRight className={cn("mt-1 size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
          <span className={cn("min-w-0", open ? "[overflow-wrap:anywhere] whitespace-pre-wrap" : "truncate")}>{item.text || "Attachments only"}</span>
        </button>
        {(counts || sending || (open && note)) && (
          <p className="flex flex-wrap items-center gap-x-2 pl-4 text-xs text-muted-foreground">
            {sending && (
              <span className="flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" aria-hidden /> Sending…
              </span>
            )}
            {counts && <span>{counts}</span>}
            {open && note && <span>{note}</span>}
          </p>
        )}
      </div>
      {!sending && (
        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={`Actions for “${short}”`}>
          <Hint label="Stop the running turn and send this next">
            <Button size="xs" variant="ghost" onClick={onSendNow} disabled={blocked}>
              <SendHorizontal /> Send now
            </Button>
          </Hint>
          <Hint label="Edit: back in the message box">
            <Button size="icon-xs" variant="ghost" onClick={onEdit} aria-label={`Edit “${short}”`}>
              <Pencil />
            </Button>
          </Hint>
          <Hint label="Move up (Alt+↑)">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => onMove(-1)}
              // Stays focusable at the top, so the keyboard isn't lost; it does nothing there.
              aria-disabled={first}
              className="aria-disabled:opacity-40"
              aria-label={`Move “${short}” up`}
            >
              <ArrowUp />
            </Button>
          </Hint>
          <Hint label="Move down (Alt+↓)">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => onMove(1)}
              aria-disabled={index === count - 1}
              className="aria-disabled:opacity-40"
              aria-label={`Move “${short}” down`}
            >
              <ArrowDown />
            </Button>
          </Hint>
          <Hint label="Remove from the queue">
            <Button size="icon-xs" variant="ghost" onClick={onRemove} aria-label={`Remove “${short}” from the queue`}>
              <Trash2 />
            </Button>
          </Hint>
        </div>
      )}
    </li>
  );
}
