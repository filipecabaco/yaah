// The permission prompt, docked above the composer (where the queue panel sits): the same place every
// time, in the chat's column, so answering never means hunting through the transcript. One waiting
// request is a single card, two or more a batch card (components/permission-batch.tsx); the transcript
// keeps only a small row for each (entries.tsx). Keys work like the CLI's, from the message box while
// it is empty or from the prompt: digits pick the numbered option, Enter allows once, Esc denies
// (lib/permission-keys.ts). Appearing never takes the focus; a screen reader is told at once.
import { useMemo, useRef, useState } from "react";
import { Loader2, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyMenu } from "@/components/menus";
import { CommandBlock } from "@/components/entries";
import { ErrorText } from "@/components/error-text";
import { KeyCap } from "@/components/permission-keys";
import { usePermissionKeys } from "@/hooks/use-permission-keys";
import { PermissionBatchCard } from "@/components/permission-batch";
import { useChat } from "@/components/chat-context";
import { useTranscript } from "@/hooks/use-transcript";
import { api, type Entry, type SessionInfo } from "@/lib/api";
import { focusAfterPermission } from "@/lib/pane-focus";
import { denyOption, onceOption, pendingRequests } from "@/lib/permission-batch";
import { SCOPE_WORDS, trustApi, useTrustView, type TrustScope } from "@/lib/trust-api";
import { shellCommand, shellDescription } from "@/lib/ui-tool-label";

type Request = Extract<Entry, { type: "permission" }>;

const OPTION_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  allow_once: "default",
  allow_always: "secondary",
  reject_once: "outline",
  reject_always: "destructive",
};

/** The pending requests of `session`, docked above its composer. */
export function PermissionDock({ session }: { session: SessionInfo }) {
  const transcript = useTranscript(session.sessionId);
  const entries = transcript?.entries;
  const pending = useMemo(() => pendingRequests(entries ?? []), [entries]);
  if (!pending || !entries) return null;
  const items = pending.items.flatMap((m) => {
    const entry = entries[m.index];
    if (entry?.type !== "permission") return [];
    const call = entry.toolCallId ? entries.find((e) => e?.type === "tool" && e.toolCallId === entry.toolCallId) : undefined;
    return [{ ...m, entry, toolInput: call?.type === "tool" ? call.rawInput : undefined }];
  });
  if (items.length === 0) return null;
  return (
    <section aria-label="Waiting for your answer" data-slot="permission-dock" className="@container border-t pt-2 pb-1">
      <div className="chat-column">
        {items.length > 1 ? (
          <PermissionBatchCard items={items} />
        ) : (
          <PermissionCard key={items[0].index} entry={items[0].entry} index={items[0].index} toolInput={items[0].toolInput} agent={items[0].agent} />
        )}
      </div>
    </section>
  );
}

/** One waiting request: what it is for, the whole command, who asked, and its numbered options. */
export function PermissionCard({ entry, index, toolInput, agent }: { entry: Request; index: number; toolInput?: unknown; agent: string | null }) {
  const chat = useChat();
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const card = useRef<HTMLDivElement>(null);
  const respond = (optionId: string) => {
    if (!chat || sending != null) return;
    setSending(optionId);
    setError(null);
    const moveOn = focusAfterPermission(card.current);
    api
      .respondPermission(chat.sessionId, index, optionId)
      .then(moveOn)
      .catch(setError)
      .finally(() => setSending(null));
  };
  // Trusting answers with the one-off option, so it is offered only when there is one.
  const server = entry.options.some((o) => o.kind === "allow_once") ? entry.mcpServer : undefined;
  // Where this chat can trust it (session/trust.rs): this chat, its project, quick chats, all chats.
  const view = useTrustView(server ? chat?.sessionId : undefined);
  const trust = (scope: TrustScope) => {
    if (!chat) return;
    setSending(`trust:${scope}`);
    setError(null);
    const moveOn = focusAfterPermission(card.current);
    trustApi
      .trustMcpServer(chat.sessionId, index, scope)
      .then(moveOn)
      .catch(setError)
      .finally(() => setSending(null));
  };
  usePermissionKeys(
    card,
    false,
    (i) => {
      const id =
        i.kind === "option"
          ? entry.options[i.n - 1]?.optionId
          : i.kind === "allow"
            ? onceOption(entry.options, "allow_once")
            : i.kind === "deny"
              ? denyOption(entry.options)
              : undefined;
      if (id) respond(id);
    },
    String(index),
  );
  const command = shellCommand(toolInput);
  const said = shellDescription(toolInput);
  const request = () => (toolInput == null ? entry.title : `${entry.title}\n\n${JSON.stringify(toolInput, null, 2)}`);
  return (
    <CopyMenu actions={[{ label: "Copy request", text: request }]}>
      <div ref={card} role="group" aria-label="Permission requested" className="rounded-lg border border-amber-500/60 bg-amber-500/5 px-3 py-2">
        <div className="flex items-start gap-2 text-sm">
          <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Permission requested</div>
            <div className="text-2xs text-muted-foreground">Asked by {agent ? `sub-agent: ${agent}` : "the main agent"}</div>
            {/* Rust's words for what the request is (permissions.rs `command_note`); it still asks. */}
            {entry.note && <div className="text-xs text-muted-foreground">{entry.note}</div>}
            {/* Said at once, not only when the polite log gets to it (SR-2). */}
            <span role="alert" className="sr-only">
              Permission requested: {entry.title}
            </span>
            {said && <div className="text-xs">{said}</div>}
            {command ? (
              <CommandBlock command={command} className="mt-1 max-h-48 text-muted-foreground" />
            ) : (
              <div className="max-h-48 overflow-y-auto font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">{entry.title}</div>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {entry.options.map((o, k) => (
            <Button
              key={o.optionId}
              size="sm"
              variant={OPTION_VARIANT[o.kind] ?? "outline"}
              aria-keyshortcuts={k < 9 ? String(k + 1) : undefined}
              disabled={!chat || sending != null}
              onClick={() => respond(o.optionId)}
            >
              {sending === o.optionId ? <Loader2 className="animate-spin" /> : k < 9 && <KeyCap n={k + 1} />}
              {o.name}
            </Button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Enter to allow, Esc to deny — digits work once the prompt is focused; or just keep typing
        </p>
        {server && view && view.offered.length > 0 && (
          <div className="mt-2 flex flex-col items-start gap-1 border-t pt-2">
            <div className="text-xs font-medium">Always allow tools from {server.label}</div>
            <div role="group" aria-label={`Always allow tools from ${server.label}`} className="-ml-2 flex flex-wrap gap-1">
              {view.offered.map((scope) => (
                <Button
                  key={scope}
                  size="sm"
                  variant="ghost"
                  aria-label={`Always allow tools from ${server.label} ${SCOPE_WORDS[scope]}`}
                  disabled={!chat || sending != null}
                  onClick={() => trust(scope)}
                >
                  {SCOPE_WORDS[scope].replace(/^in/, "In")}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Covers every {server.label} tool, including ones that change things: yaah can&apos;t tell which only read.
            </p>
          </div>
        )}
        <ErrorText error={error} className="mt-1" />
      </div>
    </CopyMenu>
  );
}
