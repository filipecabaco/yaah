// A chat's message queue as the composer shows it. Rust owns the queue (session/queue.rs):
// the order, when the next message goes and when it pauses. These only turn what it
// sends into words.
import type { MessageQueue, QueuedMessage, SessionInfo } from "@/lib/api";
import { choiceName, configOption } from "@/lib/composer-config";
import { plural } from "@/lib/format";

export const queuedItems = (session: SessionInfo): QueuedMessage[] => session.queue?.items ?? [];

/** "2 queued". */
export const queuedBadge = (n: number) => `${n} queued`;

/** A message's text on one line, for labels and announcements. */
export function oneLine(text: string, max = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "Attachments only";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "2 attachments · 1 reference", or "" when it has neither. */
export function countsText(item: QueuedMessage): string {
  const files = item.files?.length ?? 0;
  const refs = item.references ?? 0;
  return [files && plural(files, "attachment"), refs && plural(refs, "reference")].filter(Boolean).join(" · ");
}

/** Why the queue waits, in words; null while it sends. */
export function pauseText(queue: MessageQueue | undefined): string | null {
  const p = queue?.paused;
  if (!p) return null;
  switch (p.reason) {
    case "error":
      return "Paused: the turn ended with an error";
    case "cancelled":
      return "Paused: the turn was stopped";
    case "permission":
      return "Paused: a permission request was still waiting";
    case "stopped":
      return `Paused: the turn ended early (${p.detail ?? "no reason given"})`;
    case "restart":
      return "Paused since yaah restarted";
    case "sendFailed":
      return "Paused: the next message couldn't be sent";
  }
}

/**
 * The model and effort the message was queued with, when they differ from the chat's
 * now (the chat's picks apply when it is sent): "Queued with Opus · High".
 */
export function configNote(session: SessionInfo, item: QueuedMessage): string | null {
  const then = item.config ?? {};
  const shown = (["model", "effort"] as const).flatMap((role) => {
    const o = configOption(session, role);
    const was = o && then[o.id];
    return o && was ? [{ o, was }] : [];
  });
  if (!shown.some(({ o, was }) => was !== o.current)) return null;
  const was = shown.map(({ o, was }) => o.choices.find((c) => c.value === was)?.name ?? was).join(" · ");
  const now = shown.map(({ o }) => choiceName(o)).join(" · ");
  return `Queued with ${was}; it goes with the chat's current ${now}`;
}

/**
 * The `@label` each mentioned path had in the text (labels are paths inside the chat's
 * folders), so Edit can hand the mentions back to the composer.
 */
export function mentionLabels(text: string, paths: string[]): { label: string; path: string }[] {
  const labels = [...text.matchAll(/(^|\s)@(\S+)/g)].map((m) => m[2]);
  return paths.flatMap((path) => {
    const label = labels.find((l) => path === l || path.endsWith(`/${l}`));
    return label ? [{ label, path }] : [];
  });
}

/** What changed between two states of a queue, for the live region (null: nothing to say). */
export function queueAnnouncement(before: MessageQueue | undefined, after: MessageQueue | undefined): string | null {
  const was = before?.items ?? [];
  const now = after?.items ?? [];
  const added = now.filter((i) => !was.some((w) => w.id === i.id));
  if (added.length) return `Queued: ${oneLine(added[added.length - 1].text)}. ${queuedBadge(now.length)}`;
  const sent = after?.lastSent && after.lastSent !== before?.lastSent ? was.find((w) => w.id === after.lastSent) : undefined;
  if (sent) return `Sent from the queue: ${oneLine(sent.text)}.${now.length ? ` ${queuedBadge(now.length)}` : ""}`;
  if (after?.paused && !before?.paused) return `${pauseText(after)}. ${queuedBadge(now.length)}`;
  return null;
}
