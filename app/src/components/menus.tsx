// Right-click menus. WebKit's default menu (Look Up, Translate, Inspect Element…)
// means nothing in an app, so it only survives in text fields, where paste and
// spelling are useful. Everything here is menu UI: actions call into `api` or
// callbacks passed in.
//
// Every menu follows one order: the primary action (Open), then other actions,
// then copy items, then a separator and the destructive action last.
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Copy, ExternalLink, FolderInput, FolderOpen, FolderPlus, MessageSquare, Pencil, Square, SquareTerminal, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { api, type SessionInfo } from "@/lib/api";
import { isWebUrl, openExternal } from "@/lib/links";
import { openInTerminalApp } from "@/lib/terminal-api";
import { actionsAt, type MenuAction } from "@/lib/menu-actions";
import { formatKeys, isMac, MOD, SHORTCUTS } from "@/lib/shortcuts";

const COPY_KEYS = formatKeys([MOD, "C"]);

function copyText(text: string) {
  navigator.clipboard.writeText(text).catch((e: unknown) => console.error("Copy failed:", e));
}

/** A menu item that copies `text`. */
export function CopyMenuItem({ text, children }: { text: string; children: ReactNode }) {
  return <ContextMenuItem onSelect={() => copyText(text)}>{children}</ContextMenuItem>;
}

/** "Reveal in Finder" on macOS. */
const REVEAL_LABEL = isMac ? "Reveal in Finder" : "Show in file manager";

/** Show a file or folder selected in the system file manager. */
function reveal(path: string) {
  revealItemInDir(path).catch((e: unknown) => console.error("could not reveal", path, e));
}

/** Reveal a folder, then copy its path. */
function FolderItems({ path }: { path: string }) {
  return (
    <>
      <ContextMenuItem onSelect={() => reveal(path)}>
        <FolderOpen /> {REVEAL_LABEL}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => openInTerminalApp(path)}>
        <SquareTerminal /> Open in terminal
      </ContextMenuItem>
      <ContextMenuSeparator />
      <CopyMenuItem text={path}>
        <Copy /> Copy folder path
      </CopyMenuItem>
    </>
  );
}

/** Right-click menu for a folder path shown as text (a chat's folder in its header). */
export function FolderMenu({ path, children }: { path: string; children: ReactElement }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <FolderItems path={path} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ── What a right-click landed on ────────────────────────────────────────────

export type { MenuAction };

/** What was under the pointer, read when a menu opens. */
export type MenuTarget = {
  /** Text selected anywhere. */
  selection: string;
  /** The selection, when it lies inside the menu's own element. */
  ownSelection: string;
  /** An http(s) link (Markdown `a`) under the pointer. */
  link: string | null;
  /** The text of a Markdown code block under the pointer. */
  code: string | null;
  /** Actions elements under the pointer registered with `menuActions`, innermost first. */
  scoped: MenuAction[];
};

const NOTHING: MenuTarget = { selection: "", ownSelection: "", link: null, code: null, scoped: [] };

type SelectionSnapshot = { text: string; anchor: Node | null; focus: Node | null };

function snapshot(): SelectionSnapshot {
  const s = window.getSelection();
  return { text: s?.toString() ?? "", anchor: s?.anchorNode ?? null, focus: s?.focusNode ?? null };
}

/** A right-click, or a Control-click on macOS. */
const opensMenu = (e: ReactMouseEvent) => e.button === 2 || (isMac && e.button === 0 && e.ctrlKey);

/** Reads the menu's target on right-click. Spread `handlers` on the trigger. */
function useMenuTarget() {
  const [target, setTarget] = useState(NOTHING);
  // WebKit selects the word under a right-click before the menu event fires, so
  // the selection the user made is the one there on mousedown.
  const before = useRef<SelectionSnapshot | null>(null);

  function read(e: ReactMouseEvent<HTMLElement>): MenuTarget {
    const sel = before.current ?? snapshot();
    before.current = null;
    const root = e.currentTarget;
    const el = e.target instanceof Element ? e.target : null;
    const href = el?.closest("a[href]")?.getAttribute("href") ?? null;
    const pre = el?.closest(".markdown pre");
    const inside = (n: Node | null) => n != null && root.contains(n);
    const t: MenuTarget = {
      selection: sel.text,
      ownSelection: sel.text && inside(sel.anchor) && inside(sel.focus) ? sel.text : "",
      link: href && isWebUrl(href) ? href : null,
      code: pre ? (pre.textContent ?? "").replace(/\n$/, "") : null,
      scoped: actionsAt(el),
    };
    setTarget(t);
    return t;
  }

  const handlers = {
    onMouseDownCapture: (e: ReactMouseEvent) => {
      before.current = opensMenu(e) ? snapshot() : null;
    },
  };
  return { target, read, handlers };
}

const isEmpty = (t: MenuTarget) => !t.selection && !t.link && t.code == null && t.scoped.length === 0;

/** Copies what `text` returns when picked. */
type CopyItem = { label: string; text: () => string; keys?: string };

/**
 * The items for a target: link, then actions, then copies, then `extra`, each
 * group set apart. `onAct` runs before an action (not a copy) is picked.
 */
function TargetItems({
  target: t,
  act,
  copies,
  extra,
  onAct,
}: {
  target: MenuTarget;
  act: MenuAction[];
  copies: CopyItem[];
  extra: MenuAction[];
  onAct: () => void;
}) {
  const action = (a: MenuAction) => (
    <ContextMenuItem
      key={a.label}
      onSelect={() => {
        onAct();
        a.onSelect();
      }}
    >
      {a.icon} {a.label}
    </ContextMenuItem>
  );
  const groups: ReactNode[][] = [
    t.link
      ? [
          <ContextMenuItem key="open-link" onSelect={() => openExternal(t.link)}>
            <ExternalLink /> Open link
          </ContextMenuItem>,
          <CopyMenuItem key="copy-link" text={t.link}>
            <Copy /> Copy link
          </CopyMenuItem>,
        ]
      : [],
    [...act, ...t.scoped].map(action),
    copies.map((c) => (
      <ContextMenuItem key={c.label} onSelect={() => copyText(c.text())}>
        <Copy /> {c.label}
        {c.keys && <ContextMenuShortcut>{c.keys}</ContextMenuShortcut>}
      </ContextMenuItem>
    )),
    extra.map(action),
  ];
  return groups
    .filter((g) => g.length > 0)
    .map((g, i) => (
      <Fragment key={i}>
        {i > 0 && <ContextMenuSeparator />}
        {g}
      </Fragment>
    ));
}

/** Whether focus should stay where an action put it (e.g. the composer) when the menu closes. */
function useKeepFocus() {
  const acted = useRef(false);
  return {
    onAct: () => (acted.current = true),
    onOpenChange: (open: boolean) => open && (acted.current = false),
    onCloseAutoFocus: (e: Event) => acted.current && e.preventDefault(),
  };
}

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
 * Wraps the whole app. Right-clicks no other menu claims get a menu only when
 * there is something to do: open or copy a link, copy a code block or the
 * selection. In dev builds, Alt/Option + right-click reaches the native menu
 * (and Inspect Element).
 */
export function AppContextMenu({ children }: { children: ReactElement }) {
  const { target, read, handlers } = useMenuTarget();
  const focus = useKeepFocus();

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

  const { code, selection } = target;
  const copies: CopyItem[] = [];
  if (code != null) copies.push({ label: "Copy code", text: () => code });
  if (selection) copies.push({ label: "Copy", text: () => selection, keys: COPY_KEYS });

  return (
    <ContextMenu onOpenChange={focus.onOpenChange}>
      <ContextMenuTrigger
        asChild
        className="select-auto"
        {...handlers}
        // Runs before any nested menu, so fields inside them keep the native menu too.
        onContextMenuCapture={(e) => isEditable(e.target) && e.stopPropagation()}
        onContextMenu={(e) => {
          if (e.defaultPrevented) return; // a nested menu opened
          if (isEmpty(read(e))) e.preventDefault(); // no menu at all
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={focus.onCloseAutoFocus}>
        <TargetItems target={target} act={[]} copies={copies} extra={[]} onAct={focus.onAct} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Right-click menu for a transcript entry: a link's Open/Copy when the click
 * is on one, then `act` (given what was clicked, e.g. to quote the selection),
 * then copy items (selection, code block, `actions`), then `extra`.
 */
export function CopyMenu({
  act,
  actions = [],
  extra = [],
  children,
}: {
  act?: (target: MenuTarget) => MenuAction[];
  actions?: CopyItem[];
  extra?: MenuAction[];
  children: ReactElement;
}) {
  const { target, read, handlers } = useMenuTarget();
  const focus = useKeepFocus();
  const { code, selection } = target;
  const copies: CopyItem[] = [];
  if (selection) copies.push({ label: "Copy selection", text: () => selection, keys: COPY_KEYS });
  if (code != null) copies.push({ label: "Copy code", text: () => code });
  copies.push(...actions);
  return (
    <ContextMenu onOpenChange={focus.onOpenChange}>
      <ContextMenuTrigger asChild className="select-auto" {...handlers} onContextMenu={read}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={focus.onCloseAutoFocus}>
        <TargetItems target={target} act={act?.(target) ?? []} copies={copies} extra={extra} onAct={focus.onAct} />
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
        <FolderItems path={chat.cwd} />
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
