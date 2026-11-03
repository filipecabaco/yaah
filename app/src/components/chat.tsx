import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, FileText, SquareSlash, Square } from "lucide-react";
import { Hint } from "@/components/shortcuts";
import { ErrorText } from "@/components/error-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { api, type AgentProfile, type Entry, type FileMatch, type Project, type SessionInfo } from "@/lib/api";
import { compactPath } from "@/lib/format";
import { fuzzyRank } from "@/lib/fuzzy";
import { ChatContext, onDraft } from "@/components/chat-context";
import { TranscriptEntry } from "@/components/entries";
import { FolderMenu } from "@/components/menus";

type Props = {
  session: SessionInfo;
  entries: Entry[];
  agents: AgentProfile[];
  project: Project | null;
  onOpenProject: (id: string) => void;
  onLogin: (accountId: string) => void;
};

export function Chat({ session, entries, agents, project, onOpenProject, onLogin }: Props) {
  const agent = agents.find((a) => a.id === session.accountId);
  const roots = [session.cwd, ...session.additionalDirs.filter((d) => d !== project?.contextDir)];
  // Only what deep components need; a stable object, so they don't re-render on every entry.
  const chat = useMemo(
    () => ({ sessionId: session.sessionId, cwd: session.cwd, busy: session.running }),
    [session.sessionId, session.cwd, session.running],
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2.5 text-sm">
        {project && (
          <>
            <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => onOpenProject(project.id)}>
              {project.name}
            </button>
            <span className="text-muted-foreground" aria-hidden>
              /
            </span>
          </>
        )}
        <h1 className="min-w-0 truncate font-medium">{session.title}</h1>
        <Badge variant="outline" title={agent ? (agent.email ?? agent.commandLine) : undefined}>
          {agent?.label ?? session.accountId}
        </Badge>
        {agent?.report && !agent.report.mcpHttp && (
          <Badge
            variant="secondary"
            className="text-muted-foreground"
            title={`${agent.label} can't connect to HTTP MCP servers, so this chat has no UI tools (forms, tables, charts). Chatting works as usual.`}
          >
            no UI tools
          </Badge>
        )}
        <FolderMenu path={session.cwd}>
          <span className="ml-auto truncate font-mono text-xs text-muted-foreground" title={roots.map((r) => compactPath(r)).join("\n")}>
            {compactPath(session.cwd)}
            {roots.length > 1 && ` +${roots.length - 1}`}
          </span>
        </FolderMenu>
      </header>

      <ChatContext.Provider value={chat}>
        <Transcript running={session.running} entries={entries} onLogin={onLogin} />
      </ChatContext.Provider>
      <Composer key={session.sessionId} session={session} agentLabel={agent?.label} />
    </div>
  );
}

function Transcript({ running, entries, onLogin }: { running: boolean; entries: Entry[]; onLogin: (accountId: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Entries after the last user message belong to the current turn.
  const turnStart = entries.findLastIndex((e) => e?.type === "user");
  // Permission prompts carry no input; the tool call they ask about does.
  const toolInputs = useMemo(() => {
    const m = new Map<string, unknown>();
    for (const e of entries) if (e?.type === "tool" && e.rawInput != null) m.set(e.toolCallId, e.rawInput);
    return m;
  }, [entries]);

  // Follow the stream only while the user is already at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6" role="log" aria-label="Conversation" aria-busy={running}>
        {entries.length === 0 && <p className="py-16 text-center text-sm text-muted-foreground">Send a message to start.</p>}
        {entries.map((entry, i) => {
          // Rust addresses entries by index and only ever appends or replaces in place, so the index is a stable key.
          if (!entry) return null;
          const inTurn = running && i > turnStart;
          const toolInput = entry.type === "permission" && entry.toolCallId ? toolInputs.get(entry.toolCallId) : undefined;
          return (
            <TranscriptEntry
              key={i}
              entry={entry}
              index={i}
              inTurn={inTurn}
              live={inTurn && i === entries.length - 1}
              toolInput={toolInput}
              onLogin={onLogin}
            />
          );
        })}
        {running && entries[entries.length - 1]?.type === "user" && <p className="text-xs text-muted-foreground">Working…</p>}
      </div>
    </div>
  );
}

/** What the text before the caret is asking to complete: `/cmd` at the start, or `@file` anywhere. */
type Trigger = { kind: "command" | "file"; start: number; query: string };

function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: "command", start: 0, query: slash[1] };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: "file", start: caret - at[2].length - 1, query: at[2] };
  return null;
}

type Suggestion = { id: string; label: string; detail?: string; hint?: string; insert: string; path?: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `@label` still standing as its own word in the text. */
const mentioned = (text: string, label: string) => new RegExp(`(^|\\s)@${escapeRe(label)}(?=\\s|$)`).test(text);

function Composer({ session, agentLabel }: { session: SessionInfo; agentLabel?: string }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [error, setError] = useState<unknown>(null);
  /** Files picked from the @ list: label → absolute path. */
  const [mentions, setMentions] = useState<Record<string, string>>({});
  /** The last file search, for the @ trigger that started at `start`. */
  const [found, setFound] = useState<{ start: number; files: FileMatch[] } | null>(null);
  const [active, setActive] = useState(0);
  /** Start of a trigger closed with Esc; it stays closed until it's gone. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [focused, setFocused] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const moveCaret = useRef<number | null>(null);
  const listId = useId();

  // Other components (e.g. "Ask about this" on a diff) can draft into this composer.
  useEffect(
    () =>
      onDraft(({ text: add, mention }) => {
        const next = text.trim() ? `${text.replace(/\s*$/, "")}\n${add}` : add;
        moveCaret.current = next.length;
        setText(next);
        setCaret(next.length);
        if (mention) setMentions((m) => ({ ...m, [mention.label]: mention.path }));
        setTimeout(() => input.current?.focus());
      }, session.sessionId),
    [text, session.sessionId],
  );

  const trigger = useMemo(() => findTrigger(text, caret), [text, caret]);
  if (!trigger && dismissed !== null) setDismissed(null);
  const open = trigger && trigger.start !== dismissed ? trigger : null;
  const openKind = open?.kind ?? null;
  const openQuery = open?.query ?? "";
  const openStart = open?.start ?? -1;

  // File search runs in Rust over the chat's folders; debounce the keystrokes.
  const fileQuery = openKind === "file" ? openQuery : null;
  useEffect(() => {
    if (fileQuery == null) return;
    let stale = false;
    const t = setTimeout(() => {
      api.searchFiles(session.sessionId, fileQuery, 20).then(
        (files) => !stale && setFound({ start: openStart, files }),
        (e: unknown) => {
          if (stale) return;
          setFound({ start: openStart, files: [] });
          console.error("file search failed", e);
        },
      );
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [fileQuery, openStart, session.sessionId]);
  const files = fileQuery != null && found?.start === openStart ? found.files : null;

  const items: Suggestion[] = useMemo(() => {
    if (openKind === "command")
      return fuzzyRank(session.commands, openQuery, (c) => [c.name, c.description]).map((c) => ({
        id: c.name,
        label: `/${c.name}`,
        detail: c.description,
        hint: c.input?.hint,
        insert: `/${c.name} `,
      }));
    if (openKind === "file") return (files ?? []).map((f) => ({ id: f.path, label: f.label, insert: `@${f.label} `, path: f.path }));
    return [];
  }, [openKind, openQuery, session.commands, files]);

  // A new list starts at its first item.
  const listKey = `${openKind}:${openQuery}`;
  const [activeFor, setActiveFor] = useState(listKey);
  if (activeFor !== listKey) {
    setActiveFor(listKey);
    setActive(0);
  }
  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useLayoutEffect(() => {
    if (moveCaret.current == null) return;
    input.current?.setSelectionRange(moveCaret.current, moveCaret.current);
    moveCaret.current = null;
  }, [text]);

  function accept(s: Suggestion) {
    if (!open) return;
    // Replace the whole token under the caret, plus one following space.
    const rest = text.slice(caret).replace(/^\S*/, "").replace(/^ /, "");
    const pos = open.start + s.insert.length;
    setText(text.slice(0, open.start) + s.insert + rest);
    setCaret(pos);
    moveCaret.current = pos;
    const path = s.path;
    if (path) setMentions((m) => ({ ...m, [s.label]: path }));
  }

  async function send() {
    const prompt = text.trim();
    if (!prompt || session.running) return;
    setError(null);
    const paths = Object.entries(mentions)
      .filter(([label]) => mentioned(prompt, label))
      .map(([, path]) => path);
    try {
      await api.sendPrompt(session.sessionId, prompt, paths);
      setText("");
      setMentions({});
    } catch (e) {
      setError(e);
    }
  }

  function stop() {
    setError(null);
    api.cancelTurn(session.sessionId).catch(setError);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (open && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(open.start);
      return;
    }
    const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (open && items.length && plain) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(items[Math.min(active, items.length - 1)]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const showList = open != null && focused;
  return (
    <div className="border-t p-3">
      <div className="relative mx-auto flex max-w-3xl items-end gap-2">
        {showList && (
          <Command
            ref={list}
            shouldFilter={false}
            vimBindings={false}
            value={items[active]?.id ?? ""}
            onValueChange={(v) =>
              setActive(
                Math.max(
                  0,
                  items.findIndex((s) => s.id === v),
                ),
              )
            }
            // Keep focus in the textarea when an item is clicked.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute inset-x-0 bottom-full z-10 mb-2 h-auto shadow-md ring-1 ring-foreground/10"
          >
            <CommandList id={listId}>
              {items.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {open.kind === "command"
                    ? session.commands.length
                      ? "No command matches."
                      : "This chat has no slash commands yet."
                    : files == null
                      ? "Searching…"
                      : "No file matches."}
                </p>
              ) : (
                <CommandGroup heading={open.kind === "command" ? "Commands" : "Files in this chat's folders"}>
                  {items.map((s) => (
                    <CommandItem key={s.id} value={s.id} onSelect={() => accept(s)}>
                      {open.kind === "command" ? <SquareSlash /> : <FileText />}
                      {s.path ? <FileLabel label={s.label} /> : <span className="shrink-0 font-mono">{s.label}</span>}
                      {s.detail && <span className="truncate text-muted-foreground">{s.detail}</span>}
                      {s.hint && <CommandShortcut className="shrink-0 tracking-normal italic">‹{s.hint}›</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
            <footer className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
              <span>
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
              </span>
              <span>
                <Kbd>↵</Kbd> or <Kbd>Tab</Kbd> accept
              </span>
              <span className="ml-auto">
                <Kbd>Esc</Kbd> close
              </span>
            </footer>
          </Command>
        )}
        <Textarea
          id="composer"
          ref={input}
          autoFocus
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={`Message ${agentLabel ?? "the agent"}…  / for commands, @ to mention a file`}
          aria-label="Message"
          className="max-h-48 min-h-10 resize-none"
          rows={1}
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-autocomplete="list"
        />
        {session.running ? (
          <Hint label="Stop" shortcut="stop">
            <Button size="icon" variant="secondary" onClick={stop} aria-label="Stop">
              <Square />
            </Button>
          </Hint>
        ) : (
          <Hint label="Send ↵">
            <Button size="icon" onClick={() => void send()} disabled={!text.trim()} aria-label="Send">
              <ArrowUp />
            </Button>
          </Hint>
        )}
      </div>
      <ErrorText error={error} className="mx-auto mt-1 max-w-3xl" />
    </div>
  );
}

/** `src/billing/invoice.ts` with the file name standing out. */
function FileLabel({ label }: { label: string }) {
  const cut = label.lastIndexOf("/") + 1;
  return (
    <span className="min-w-0 truncate">
      <span className="font-medium">{label.slice(cut)}</span>
      {cut > 0 && <span className="ml-2 font-mono text-xs text-muted-foreground">{label.slice(0, cut)}</span>}
    </span>
  );
}
