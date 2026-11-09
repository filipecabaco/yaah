// A chat's message queue (session/queue.rs), as the mock keeps it: on the chat's info, as
// Rust does. While a turn runs `send_prompt` queues; when a turn ends normally the next
// goes; a stop pauses it; Send now stops the turn and sends that one next.
import type { MessageQueue, QueuePauseReason, QueuedMessage, Sent, SessionInfo } from "@/lib/api";
import type { Attachment } from "@/lib/attachments";
import { need, now, type Mock, type Replies } from "./context";
import { referencesIn } from "./references";

/** What starts a turn for a queued message (chats.ts `replay`), and what stops one (`cancel_turn`). */
type Hooks = { send: (sessionId: string, item: QueuedMessage) => void; cancel: (sessionId: string) => Promise<unknown> };

export function mockQueue(m: Mock, { send, cancel }: Hooks) {
  const { state } = m;
  const session = (id: string) => need(state.sessions[id], "unknown session");
  /** Not kept on the info (Rust doesn't send them either): "Send now" and Stop. */
  const runtime: Record<string, { sendNow?: string; stopping?: boolean }> = {};
  const showInfo = (s: SessionInfo) => m.emit("session-info", s);
  const items = (s: SessionInfo) => s.queue?.items ?? [];
  const setQueue = (s: SessionInfo, q: MessageQueue) => {
    const empty = !q.items?.length && !q.paused;
    if (empty && !q.lastSent) delete s.queue;
    else s.queue = q;
  };
  const pause = (s: SessionInfo, reason: QueuePauseReason, detail?: string) =>
    setQueue(s, { ...s.queue, paused: { reason, ...(detail ? { detail } : {}) } });
  const busy = (s: SessionInfo) => s.running || items(s).some((i) => i.sending);

  /** The first item goes, as `Hub::send_next` does. */
  const sendNext = (sessionId: string) => {
    const s = session(sessionId);
    const [first, ...rest] = items(s);
    if (!first || s.running || s.queue?.paused || first.sending) return;
    setQueue(s, { ...s.queue, items: rest, lastSent: first.id });
    s.running = true;
    send(sessionId, first);
  };

  const changed = async (s: SessionInfo) => {
    await showInfo(s);
    return s;
  };

  return {
    /** `send_prompt` while the chat is busy: queued; `null` when it should be sent now. */
    ifBusy(s: SessionInfo, text: string, mentions: string[], files: Attachment[]): Sent | null {
      if (!busy(s)) return null;
      const id = `q${Math.random().toString(36).slice(2, 10)}`;
      const config = Object.fromEntries((s.config?.options ?? []).filter((o) => o.role).map((o) => [o.id, o.current]));
      const item: QueuedMessage = {
        id,
        text,
        ...(mentions.length ? { mentions } : {}),
        ...(files.length ? { files: files.map(({ sentAs: _, ...a }) => a) } : {}),
        ...(referencesIn(state, text).length ? { references: referencesIn(state, text).length } : {}),
        queuedAt: now(),
        ...(Object.keys(config).length ? { config } : {}),
      };
      setQueue(s, { ...s.queue, items: [...items(s), item] });
      void showInfo(s);
      return { status: "queued", id, position: items(s).length };
    },
    /** The user stopped the turn (`Hub::cancel`). */
    stopped(sessionId: string) {
      (runtime[sessionId] ??= {}).stopping = true;
    },
    /** A turn ended (`Queue::turn_ended`): the next goes, or the queue pauses. */
    turnEnded(sessionId: string, stopReason: string | null) {
      const s = session(sessionId);
      const r = (runtime[sessionId] ??= {});
      const stopped = r.stopping;
      r.stopping = false;
      if (!items(s).length) return void (r.sendNow = undefined);
      if (r.sendNow) {
        r.sendNow = undefined;
        setQueue(s, { ...s.queue, paused: undefined });
        return sendNext(sessionId);
      }
      if (s.queue?.paused) return;
      if (stopped || stopReason === "cancelled") pause(s, "cancelled");
      else if (stopReason !== "end_turn") pause(s, "stopped", stopReason ?? "no stop reason");
      else return sendNext(sessionId);
      void showInfo(s);
    },
    replies: {
      queue_remove: ({ sessionId, id }: { sessionId: string; id: string }) => {
        const s = session(sessionId);
        setQueue(s, { ...s.queue, items: items(s).filter((i) => i.id !== id) });
        if (!items(s).length) setQueue(s, { ...s.queue, paused: undefined });
        return changed(s);
      },
      queue_edit: async ({ sessionId, id }: { sessionId: string; id: string }) => {
        const s = session(sessionId);
        const item = need(
          items(s).find((i) => i.id === id),
          "That message isn't queued any more.",
        );
        setQueue(s, { ...s.queue, items: items(s).filter((i) => i.id !== id) });
        if (!items(s).length) setQueue(s, { ...s.queue, paused: undefined });
        // Its attachments are staged in the composer again (attachments.rs `restage`).
        for (const a of item.files ?? []) state.attachmentsStaged[a.id] = { ...a, sessionId };
        await showInfo(s);
        return { text: item.text, mentions: item.mentions ?? [], attachments: item.files ?? [], refused: [] };
      },
      queue_move: ({ sessionId, id, to }: { sessionId: string; id: string; to: number }) => {
        const s = session(sessionId);
        const list = [...items(s)];
        const from = list.findIndex((i) => i.id === id);
        if (from < 0) throw new Error("That message isn't queued any more.");
        const [item] = list.splice(from, 1);
        list.splice(Math.max(0, Math.min(to, list.length)), 0, item);
        setQueue(s, { ...s.queue, items: list });
        return changed(s);
      },
      queue_clear: ({ sessionId }: { sessionId: string }) => {
        const s = session(sessionId);
        setQueue(s, { lastSent: s.queue?.lastSent });
        return changed(s);
      },
      queue_resume: async ({ sessionId }: { sessionId: string }) => {
        const s = session(sessionId);
        setQueue(s, { ...s.queue, paused: undefined });
        await showInfo(s);
        if (!s.running) sendNext(sessionId);
        return s;
      },
      queue_merge: async ({ sessionId }: { sessionId: string }) => {
        const s = session(sessionId);
        const list = items(s);
        if (!list.length) throw new Error("There is nothing queued.");
        const [head] = list;
        const merged = {
          ...head,
          text: list
            .map((i) => i.text)
            .filter(Boolean)
            .join("\n\n"),
          mentions: [...new Set(list.flatMap((i) => i.mentions ?? []))],
          files: list.flatMap((i) => i.files ?? []),
        };
        setQueue(s, { ...s.queue, items: [merged] });
        return changed(s);
      },
      queue_send_now: async ({ sessionId, id }: { sessionId: string; id: string }) => {
        const s = session(sessionId);
        const list = [...items(s)];
        const from = list.findIndex((i) => i.id === id);
        if (from < 0) throw new Error("That message isn't queued any more.");
        list.unshift(...list.splice(from, 1));
        setQueue(s, { ...s.queue, items: list, paused: undefined });
        await showInfo(s);
        if (s.running) {
          (runtime[sessionId] ??= {}).sendNow = id;
          await cancel(sessionId);
        } else sendNext(sessionId);
        return s;
      },
    } satisfies Replies,
  };
}
