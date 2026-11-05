// Two or more permission requests waiting in a chat, answered from one card docked above the composer
// (permission-dock.tsx): each listed in full (what it is for, the whole command, who asked), with its
// own numbered options, and "Allow all" / "Deny all" for the lot. Keys: Enter / Esc answer the
// highlighted one from the message box; with the keyboard on the card also ↑/↓ (move), 1-9, A and D
// (all). "All" covers the requests shown when the card appeared; a later one is a separate "new" row.
// The highlight follows a request's id. Answers go through api.respondPermission one by one, with the
// same option a single card's Allow or Deny picks; never an "always" one unless clicked on an item.
import { useEffect, useRef, useState } from "react";
import { Loader2, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandBlock } from "@/components/entries";
import { KeyCap } from "@/components/permission-keys";
import { usePermissionKeys } from "@/hooks/use-permission-keys";
import { ErrorText } from "@/components/error-text";
import { useChat } from "@/components/chat-context";
import { api, type Entry } from "@/lib/api";
import { focusAfterPermission } from "@/lib/pane-focus";
import { denyOption, onceOption, type PermissionBatchItem } from "@/lib/permission-batch";
import { cn } from "@/lib/utils";
import { shellCommand, shellDescription } from "@/lib/ui-tool-label";

type Request = Extract<Entry, { type: "permission" }>;

type Props = {
  /** The waiting requests, in order, with who asked. */
  items: (PermissionBatchItem & { entry: Request; toolInput?: unknown })[];
};

export function PermissionBatchCard({ items: live }: Props) {
  const chat = useChat();
  const card = useRef<HTMLDivElement>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The requests the user is looking at, fixed when the card is shown (by request index): "Allow all"
  // covers these and no others. One that arrives later is listed apart, with its own buttons.
  const [seen, setSeen] = useState<number[]>(() => live.map((i) => i.index));
  const [cursorId, setCursorId] = useState<number | null>(null);
  const [settling, setSettling] = useState(false);
  const busy = sending != null || !chat;

  const frozen = live.filter((i) => seen.includes(i.index));
  // Everything the user was looking at is answered: what is left is what they see now.
  const regroup = frozen.length === 0;
  const items = regroup ? live : frozen;
  const fresh = regroup ? [] : live.filter((i) => !seen.includes(i.index));
  const rows = [...items, ...fresh];
  if (regroup && live.length > 0) setSeen(live.map((i) => i.index));
  // A new count is shown before it can be passed over: Allow all waits a moment.
  const freshKey = fresh.map((i) => i.index).join(",");
  const [shownKey, setShownKey] = useState(freshKey);
  if (freshKey !== shownKey) {
    setShownKey(freshKey);
    setSettling(freshKey !== "");
  }
  useEffect(() => {
    if (!settling) return;
    const t = setTimeout(() => setSettling(false), 800);
    return () => clearTimeout(t);
  }, [settling, freshKey]);

  /** Answer `picks` in order, stopping at the first failure; what was answered drops out of the card as its entry updates. */
  const run = async (key: string, picks: { index: number; optionId: string }[]) => {
    if (!chat) return;
    setSending(key);
    setError(null);
    const moveOn = focusAfterPermission(card.current);
    try {
      for (const p of picks) await api.respondPermission(chat.sessionId, p.index, p.optionId);
      // After the card has re-rendered: what is left may now be a single card, which is where focus goes.
      setTimeout(moveOn, 50);
    } catch (e) {
      setError(e);
    } finally {
      setSending(null);
    }
  };
  const answer = (key: string, picks: { index: number; optionId: string }[]) => void run(key, picks);
  // Only the requests the user has been shown (`items`), never one that arrived since.
  const all = (kind: "allow_once" | "reject_once") =>
    items.flatMap((i) => {
      const optionId = onceOption(i.entry.options, kind);
      return optionId ? [{ index: i.index, optionId }] : [];
    });
  const allow = all("allow_once");
  const deny = all("reject_once");

  // The highlight follows the request, not its place in the list; if it is gone, back to the first.
  const at = Math.max(
    0,
    rows.findIndex((r) => r.index === cursorId),
  );
  const cur = rows[at];
  usePermissionKeys(
    card,
    true,
    (i) => {
      if (busy || settling || !cur) return;
      if (i.kind === "move") return setCursorId(rows[Math.max(0, Math.min(rows.length - 1, at + i.by))].index);
      if (i.kind === "all") return i.allow ? answer("all:allow", allow) : answer("all:deny", deny);
      const optionId =
        i.kind === "option"
          ? cur.entry.options[i.n - 1]?.optionId
          : i.kind === "allow"
            ? onceOption(cur.entry.options, "allow_once")
            : denyOption(cur.entry.options);
      if (optionId) answer(`${cur.index}:key`, [{ index: cur.index, optionId }]);
    },
    rows.map((r) => r.index).join(","),
  );

  return (
    <div
      ref={card}
      role="group"
      aria-label={`${rows.length} permission requests`}
      className="rounded-lg border border-amber-500/60 bg-amber-500/5 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <ShieldQuestion className="size-4 shrink-0 text-amber-600" aria-hidden />
        <div className="min-w-0 flex-1 font-medium">{rows.length} permission requests</div>
        <span role="alert" className="sr-only">
          {rows.length} permission requests waiting
        </span>
        <Button
          size="sm"
          disabled={busy || settling || allow.length === 0}
          onClick={() => answer("all:allow", allow)}
          aria-label={`Allow all ${items.length} requests`}
        >
          {sending === "all:allow" ? <Loader2 className="animate-spin" /> : <KeyCap n="A" />}
          Allow all {items.length}
        </Button>
        {fresh.length > 0 && (
          <span role="status" className="text-xs font-medium text-amber-700 dark:text-amber-400">
            +{fresh.length} new {fresh.length === 1 ? "request" : "requests"}, not included
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || settling || deny.length === 0}
          onClick={() => answer("all:deny", deny)}
          aria-label={`Deny all ${items.length} requests`}
        >
          {sending === "all:deny" ? <Loader2 className="animate-spin" /> : <KeyCap n="D" />}
          Deny all
        </Button>
      </div>
      <ol className="mt-2 flex max-h-[40vh] flex-col divide-y overflow-y-auto">
        {rows.map((it, n) => {
          const { entry } = it;
          const command = shellCommand(it.toolInput);
          const said = shellDescription(it.toolInput);
          const label = said ?? entry.title;
          const here = n === at;
          const isNew = fresh.includes(it);
          return (
            <li
              key={it.index}
              role="group"
              aria-label={`Request ${n + 1} of ${rows.length}: ${label}`}
              aria-current={here || undefined}
              className={cn("flex flex-col gap-1 border-l-2 py-2 pl-2 first:pt-1 last:pb-1", here ? "border-amber-500" : "border-transparent")}
              onClick={() => setCursorId(it.index)}
            >
              {isNew && <div className="text-2xs font-semibold text-amber-700 dark:text-amber-400">1 new request: answer it on its own</div>}
              <div className="text-2xs font-medium text-muted-foreground">Asked by {it.agent ? `sub-agent: ${it.agent}` : "the main agent"}</div>
              {entry.note && <div className="text-xs text-muted-foreground">{entry.note}</div>}
              {said && <div className="text-xs">{said}</div>}
              {command ? (
                <CommandBlock command={command} className="max-h-32 text-muted-foreground" />
              ) : (
                <div className="font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">{entry.title}</div>
              )}
              <div className="flex flex-wrap gap-2">
                {entry.options.map((o, k) => {
                  const word = o.kind === "allow_once" ? "Allow" : o.kind === "reject_once" ? "Deny" : o.name;
                  return (
                    <Button
                      key={o.optionId}
                      size="xs"
                      variant={o.kind === "allow_once" ? "default" : o.kind === "allow_always" ? "secondary" : "outline"}
                      disabled={busy}
                      aria-label={`${word}: ${label}`}
                      aria-keyshortcuts={here && k < 9 ? String(k + 1) : undefined}
                      onClick={() => answer(`${it.index}:${o.optionId}`, [{ index: it.index, optionId: o.optionId }])}
                    >
                      {sending === `${it.index}:${o.optionId}` ? <Loader2 className="animate-spin" /> : here && k < 9 && <KeyCap n={k + 1} />}
                      {word}
                    </Button>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Enter to allow, Esc to deny the highlighted request — digits, ↑/↓, A (allow all) and D (deny all) work once this card is focused; or just keep
        typing.
      </p>
      <ErrorText error={error} className="mt-1" />
    </div>
  );
}
