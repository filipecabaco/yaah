// A UI the agent rendered in a chat, moved out of its transcript into a pane of its own (the
// agent's `ui_open_pane`, or the entry's "Open in a side pane"). The pane's content is
// `{ kind: "ui", chat, index }` (layout.ts); it reads that entry from the chat's transcript, so
// when the agent renders again with the same id the pane updates in place. Its forms answer and
// share drafts exactly as inline (ui-entry.tsx `UiContent`). Closing it puts the UI back in the chat.
import { useEffect, useMemo } from "react";
import { LayoutPanelTop, X } from "lucide-react";
import { ChatContext } from "@/components/chat-context";
import { UiBadges, UiContent } from "@/components/ui-entry";
import type { UiView } from "@/components/ui-view";
import { Button } from "@/components/ui/button";
import { useTranscript, useTranscripts } from "@/hooks/use-transcript";
import type { SessionInfo } from "@/lib/api";
import { displayTitle } from "@/lib/chat-title";
import type { Selection } from "@/lib/layout";
import { clearPaneInfo, setPaneInfo } from "@/lib/pane-info";
import { uiTitle } from "@/lib/ui-title";

type UiPaneContent = Extract<Selection, { kind: "ui" }>;

export function UiPane({
  pane,
  content,
  session,
  chatPane,
  onClose,
}: {
  pane: string;
  content: UiPaneContent;
  /** The chat the UI belongs to (undefined while chats load). */
  session: SessionInfo | undefined;
  /** A pane showing that chat, if any: where a button in the UI drafts its message. */
  chatPane?: string;
  onClose: () => void;
}) {
  const { chat: sessionId, index } = content;
  const store = useTranscripts();
  const transcript = useTranscript(sessionId);
  const raw = transcript?.entries[index];
  const entry = raw?.type === "ui" ? raw : undefined;
  // An older UI than the chat has loaded: fetch earlier pages until it's in.
  const before = !!transcript && !transcript.error && index < transcript.from;
  useEffect(() => {
    if (before) store.loadEarlier(sessionId).catch((e: unknown) => console.error("could not load the UI's entry", e));
  }, [before, store, sessionId, transcript?.from]);

  const name = entry ? uiTitle(entry) : "UI";
  const chatTitle = session ? displayTitle(session.title) : undefined;
  const view = useMemo<UiView>(() => ({ expanded: true, name }), [name]);
  const chat = useMemo(
    () => (session ? { sessionId, cwd: session.cwd, busy: session.running, pane: chatPane, inProject: !!session.projectId } : null),
    [session, sessionId, chatPane],
  );

  // What the sidebar lists this pane as.
  useEffect(() => {
    setPaneInfo(pane, { title: name, detail: chatTitle });
  }, [pane, name, chatTitle]);
  useEffect(() => () => clearPaneInfo(pane), [pane]);

  let body;
  if (entry) {
    body = (
      <ChatContext.Provider value={chat}>
        <div className="h-full">
          <UiContent entry={entry} index={index} sessionId={sessionId} view={view} />
        </div>
      </ChatContext.Provider>
    );
  } else if (!transcript || before) {
    body = <div className="h-full" aria-busy="true" />;
  } else {
    body = (
      <p role="status" className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
        {transcript.error ?? "This UI is no longer in its chat."}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header data-tauri-drag-region="deep" className="flex shrink-0 items-center gap-2 border-b bg-background px-4 py-2.5 text-sm">
        <LayoutPanelTop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium">{name}</span>
        {entry && <UiBadges entry={entry} />}
        <span className="ml-auto flex min-w-0 items-center gap-1">
          {chatTitle && (
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={`From the chat ${chatTitle}`}>
              {chatTitle}
            </span>
          )}
          <Button size="icon-xs" variant="ghost" title="Close the pane: the UI goes back into its chat" aria-label="Close UI pane" onClick={onClose}>
            <X />
          </Button>
        </span>
      </header>
      <div data-ui-slot="pane" className="min-h-0 flex-1 overflow-auto p-4">
        {body}
      </div>
    </div>
  );
}
