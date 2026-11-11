// The composer's permission Mode picker: how often the agent asks before editing or running
// something. Shown when the chat's agent offers a `mode` option. The agent's default stays; a mode
// that stops asking altogether (bypass / full access) is never preselected or saved as a default,
// asks for a confirmation per chat and shows a red label in the composer while it is on.
import { useEffect, useState } from "react";
import { ChevronDown, Loader2, Shield, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, type SessionInfo } from "@/lib/api";
import { isFocusedPane } from "@/components/chat-context";
import { cn } from "@/lib/utils";
import { onCycleMode } from "@/lib/app-events";
import { isAuto, isUnrestricted, modeOption, modeText, nextSafeMode } from "@/lib/permission-modes";

/** The always-visible line under the message box, like the CLI's status line; it also says how to cycle. */
export function ModeStatus({ session }: { session: SessionInfo }) {
  const option = modeOption(session);
  if (!option) return null;
  const t = modeText(option, option.current);
  const unrestricted = isUnrestricted(option.current);
  const hint = session.running ? "change it when the turn ends" : "shift+tab to cycle";
  return (
    <p
      data-slot="mode-status"
      role="status"
      title={t.description}
      className={cn(
        "mt-1 truncate text-xs",
        // Several panes: the mode shows in the toolbar; this line stays only to warn that nothing is asked first.
        unrestricted ? "font-medium text-destructive" : "text-muted-foreground group-data-[many]/pane:hidden",
      )}
    >
      <span aria-hidden>⏵⏵ </span>
      {unrestricted ? (isAuto(option.current) ? "auto: agent decides" : `${t.name.toLowerCase()}: not asking`) : `${t.name.toLowerCase()} on`}{" "}
      <span className="group-data-[many]/pane:hidden">({hint})</span>
    </p>
  );
}

export function ComposerMode({ session, pane, onError }: { session: SessionInfo; pane?: string; onError: (e: unknown) => void }) {
  const option = modeOption(session);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const busy = session.running;

  // Shift+Tab in this chat's message box: the next safe mode, straight to the setter.
  useEffect(
    () =>
      onCycleMode((r) => {
        if (r.sessionId !== session.sessionId || (r.pane !== pane && !(isFocusedPane(pane) && !r.pane)) || !option || busy || saving != null) return;
        const next = nextSafeMode(option);
        if (next) void apply(next);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.sessionId, pane, option, busy, saving],
  );
  if (!option) return null;

  const current = modeText(option, option.current);
  const unrestricted = isUnrestricted(option.current);

  async function apply(value: string) {
    setConfirm(null);
    onError(null);
    setSaving(value);
    try {
      await api.setChatConfig(session.sessionId, option!.id, value);
    } catch (e) {
      onError(e);
    } finally {
      setSaving(null);
    }
  }
  function pick(value: string) {
    setOpen(false);
    if (value === option!.current) return;
    if (isUnrestricted(value)) setConfirm(value);
    else void apply(value);
  }

  const title = busy ? `Permissions: ${current.name}. Wait for the turn to end to change it.` : `${current.description}. Applies to this chat only.`;
  return (
    <>
      <Popover open={open && !busy} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            disabled={busy || saving != null}
            aria-label={`Permissions: ${current.name}`}
            title={title}
            data-config="mode"
            data-unrestricted={unrestricted || undefined}
            className={unrestricted ? "shrink-0 font-medium text-destructive" : "shrink-0 text-muted-foreground"}
          >
            {saving != null ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : unrestricted ? (
              <ShieldAlert aria-hidden />
            ) : (
              <Shield aria-hidden className="@xl:hidden" />
            )}
            <span className="hidden shrink-0 @xl:inline" aria-hidden>
              {unrestricted ? (isAuto(option.current) ? "Agent decides:" : "Not asking:") : "Permissions"}
            </span>
            <span className={unrestricted ? "truncate @max-md:hidden" : "truncate text-foreground @max-md:hidden"}>
              {saving != null ? modeText(option, saving).name : current.name}
            </span>
            <ChevronDown aria-hidden className="hidden @sm:block" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-[min(26rem,calc(100vw-2rem))] p-0">
          <Command label="Permissions" defaultValue={option.current} loop className="outline-none">
            <CommandList label="Permission modes" className="max-h-80">
              <CommandGroup heading="When the agent wants to edit or run something">
                {option.choices.map((c) => {
                  const t = modeText(option, c.value);
                  return (
                    <CommandItem
                      key={c.value}
                      value={c.value}
                      keywords={[t.name, t.description]}
                      data-checked={c.value === option.current}
                      onSelect={() => pick(c.value)}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={isUnrestricted(c.value) ? "truncate text-destructive" : "truncate"}>{t.name}</span>
                        <span className="text-xs text-muted-foreground">{t.description}</span>
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Dialog open={confirm != null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm ? `Turn on "${modeText(option, confirm).name}" for this chat?` : ""}</DialogTitle>
            <DialogDescription>
              {confirm && isAuto(confirm)
                ? "The agent decides what is safe without asking you, and so do any sub-agents it starts: it may run shell commands and change or delete files without your review. "
                : "The agent, and any sub-agents it starts, will run shell commands and change or delete files without asking you first. Nothing can be reviewed before it happens. "}
              This applies to this chat only and is never kept for new chats.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Keep asking
            </Button>
            <Button variant="destructive" onClick={() => confirm && void apply(confirm)}>
              {confirm && isAuto(confirm) ? "Let the agent decide in this chat" : "Stop asking in this chat"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
