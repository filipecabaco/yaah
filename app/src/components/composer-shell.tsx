// The composer's frame: one rounded surface holding what the message carries (attachment and
// reference chips, refusals), the message box with no border of its own, and a toolbar (Attach,
// Model and Effort, the trigger keys, Send or Stop). Focus shows on the frame as a 2px line in the
// solid `--ring`, which every theme keeps at 3:1 or more on the page (theme-map.ts FLOORS), so
// typing no longer lights up the loudest element on screen. Behaviour stays in chat.tsx.
import type { MouseEvent, ReactNode, RefObject } from "react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/** What the message box's description tells screen readers (the toolbar shows it as keys). */
export const TRIGGER_HELP =
  "Type / for commands, @ to mention a file, or # for an issue or pull request. Enter sends; Shift+Enter starts a new line.";

/** The textarea inside the frame: no border, ring or fill of its own (the frame has them). */
export const COMPOSER_INPUT =
  "max-h-48 min-h-10 resize-none rounded-none border-0 bg-transparent px-3 pt-2.5 pb-1 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent";

export function ComposerShell({
  carries,
  carrying = false,
  toolbar,
  input,
  children,
}: {
  /** Chips, progress and refusals; mounted always (they hold a live region), laid out only when `carrying`. */
  carries?: ReactNode;
  carrying?: boolean;
  toolbar: ReactNode;
  /** The message box: a press on the frame's empty space puts the caret there. */
  input?: RefObject<HTMLTextAreaElement | null>;
  /** The textarea. */
  children: ReactNode;
}) {
  function onMouseDown(e: MouseEvent<HTMLDivElement>) {
    const el = input?.current;
    if (!el || el.disabled) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, li, [role=alert], [data-radix-popper-content-wrapper]")) return;
    e.preventDefault();
    el.focus();
  }
  return (
    <div
      data-slot="composer"
      onMouseDown={onMouseDown}
      // The page's own background, not a control's `dark:bg-input/30`: refusals sit inside, and destructive
      // text on that fill drops under 4.5:1 in Dracula and Night Owl (theme-contrast.test.ts measures the page).
      className={cn(
        "flex flex-col rounded-xl border border-input bg-background transition-[border-color,box-shadow] duration-150 ease-out motion-reduce:transition-none",
        "has-[[data-composer]:focus-visible]:border-ring has-[[data-composer]:focus-visible]:ring-1 has-[[data-composer]:focus-visible]:ring-ring",
      )}
    >
      <div className={carrying ? "flex flex-col gap-1.5 px-2 pt-2" : "contents"}>{carries}</div>
      {children}
      <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 px-1.5 pb-1.5">{toolbar}</div>
    </div>
  );
}

/**
 * The trigger keys in the toolbar: with their words when the pane is wide, the keys alone when
 * it's medium, nothing when it's narrow. Hidden from screen readers, which get `TRIGGER_HELP`
 * as the message box's description instead.
 */
export function TriggerHint() {
  const pair = (key: string, word: string) => (
    <span className="inline-flex items-center gap-1">
      <Kbd>{key}</Kbd>
      <span className="hidden @4xl:inline">{word}</span>
    </span>
  );
  return (
    <span
      aria-hidden
      title="/ for commands, @ to mention a file, # for an issue or pull request"
      className="hidden items-center gap-1 text-xs text-muted-foreground @2xl:inline-flex @4xl:gap-2.5"
    >
      {pair("/", "commands")}
      {pair("@", "files")}
      {pair("#", "issues and PRs")}
    </span>
  );
}
