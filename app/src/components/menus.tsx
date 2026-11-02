// Right-click menus. WebKit's default menu (Look Up, Translate, Inspect Element…)
// means nothing in an app, so it only survives in text fields, where paste and
// spelling are useful. Everything here is menu UI: actions call into `api` or
// callbacks passed in.
import { createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Copy, FolderInput, FolderPlus, MessageSquare, Pencil, Square, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { api, type SessionInfo } from "@/lib/api";
import { formatKeys, MOD, SHORTCUTS } from "@/lib/shortcuts";

const COPY_KEYS = formatKeys([MOD, "C"]);

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch((e: unknown) => console.error("Copy failed:", e));
}

/** A menu item that copies `text`. */
export function CopyMenuItem({ text, children }: { text: string; children: ReactNode }) {
  return <ContextMenuItem onSelect={() => copyText(text)}>{children}</ContextMenuItem>;
}

const selectedText = () => window.getSelection()?.toString() ?? "";

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", "number"]);

/** Text fields keep the native menu (paste, spelling). */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const field = target.closest("input, textarea");
  if (field instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(field.type);
  if (field) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/**
 * Wraps the whole app. Right-clicks no other menu claims get nothing, or a
 * Copy menu when text is selected. In dev builds, Alt/Option + right-click
 * reaches the native menu (and Inspect Element).
 */
export function AppContextMenu({ children }: { children: ReactElement }) {
  const [selection, setSelection] = useState("");

  useEffect(() => {
    const bypass = (e: MouseEvent) => {
      if (e.altKey) e.stopImmediatePropagation();
    };
    // Catches what React never sees, e.g. a right-click outside the app root.
    const suppress = (e: MouseEvent) => {
      if (!e.defaultPrevented && !isEditable(e.target)) e.preventDefault();
    };
    if (import.meta.env.DEV) window.addEventListener("contextmenu", bypass, true);
    document.addEventListener("contextmenu", suppress);
    return () => {
      window.removeEventListener("contextmenu", bypass, true);
      document.removeEventListener("contextmenu", suppress);
    };
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        className="select-auto"
        // Runs before any nested menu, so fields inside them keep the native menu too.
        onContextMenuCapture={(e) => isEditable(e.target) && e.stopPropagation()}
        onContextMenu={(e) => {
          if (e.defaultPrevented) return; // a nested menu opened
          const text = selectedText();
          if (text) setSelection(text);
          else e.preventDefault(); // no menu at all
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => copyText(selection)}>
          <Copy /> Copy
          <ContextMenuShortcut>{COPY_KEYS}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Copies what `text` returns when picked. */
type CopyAction = { label: string; text: () => string };

/** Any other action, below the copy actions. */
export type MenuAction = { label: string; icon?: ReactNode; onSelect: () => void };

/** Right-click menu for a transcript entry: Copy selection when text is selected, copy actions, then `extra` below a separator. */
export function CopyMenu({ actions, extra = [], children }: { actions: CopyAction[]; extra?: MenuAction[]; children: ReactElement }) {
  const [selection, setSelection] = useState("");
  return (
    <ContextMenu onOpenChange={(open) => open && setSelection(selectedText())}>
      <ContextMenuTrigger asChild className="select-auto">
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {selection && (
          <>
            <ContextMenuItem onSelect={() => copyText(selection)}>
              <Copy /> Copy selection
              <ContextMenuShortcut>{COPY_KEYS}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {actions.map((a) => (
          <ContextMenuItem key={a.label} onSelect={() => copyText(a.text())}>
            <Copy /> {a.label}
          </ContextMenuItem>
        ))}
        {extra.length > 0 && <ContextMenuSeparator />}
        {extra.map((a) => (
          <ContextMenuItem key={a.label} onSelect={a.onSelect}>
            {a.icon} {a.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Rename, move and delete for chat rows; App opens them in the command palette. */
export type ChatActionsValue = {
  activeId: string | null;
  rename: (chat: SessionInfo) => void;
  remove: (chat: SessionInfo) => void;
  move: (chat: SessionInfo) => void;
  promote: (chat: SessionInfo) => void;
};

const ChatActions = createContext<ChatActionsValue | null>(null);

export function ChatActionsProvider({ value, children }: { value: ChatActionsValue; children: ReactNode }) {
  return <ChatActions value={value}>{children}</ChatActions>;
}

/** A chat row in the sidebar or on the project page. */
export function ChatMenu({ chat, onOpen, children }: { chat: SessionInfo; onOpen: () => void; children: ReactElement }) {
  const actions = useContext(ChatActions);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <MessageSquare /> Open
        </ContextMenuItem>
        {chat.running && (
          <ContextMenuItem
            onSelect={() => {
              api.cancelTurn(chat.sessionId).catch(console.error);
            }}
          >
            <Square /> Stop
            {actions?.activeId === chat.sessionId && <ContextMenuShortcut>{formatKeys(SHORTCUTS.stop.keys)}</ContextMenuShortcut>}
          </ContextMenuItem>
        )}
        {actions && (
          <ContextMenuItem onSelect={() => actions.rename(chat)}>
            <Pencil /> Rename…
          </ContextMenuItem>
        )}
        {actions && (
          <ContextMenuItem onSelect={() => actions.move(chat)}>
            <FolderInput /> Move to project…
          </ContextMenuItem>
        )}
        {actions && !chat.projectId && (
          <ContextMenuItem onSelect={() => actions.promote(chat)}>
            <FolderPlus /> Turn into project…
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <CopyMenuItem text={chat.sessionId}>
          <Copy /> Copy session ID
        </CopyMenuItem>
        {actions && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => actions.remove(chat)}>
              <Trash2 /> Delete…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
