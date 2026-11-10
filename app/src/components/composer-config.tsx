// The composer's Model and Effort pickers, in its toolbar: shown only for what the chat's agent
// offers (ACP session config options, or the older `models`), as Rust marks them
// (`role` in session/config.rs). A pick goes to Rust, which checks it, sends it to
// the agent and emits what the agent answers; this only renders that. Disabled
// while a turn runs: a change applies to the next message.
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Cpu, Gauge, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isFocusedPane } from "@/components/chat-context";
import { api, type ConfigChoice, type ConfigOption, type SessionInfo } from "@/lib/api";
import { onOpenComposerConfig, type ConfigRole } from "@/lib/app-events";
import { choiceName, configOption } from "@/lib/composer-config";
import { ComposerMode } from "@/components/composer-mode";

/** Past this many values the list gets a search box. */
const SEARCH_FROM = 8;

const LABELS: Record<ConfigRole, { label: string }> = {
  model: { label: "Model" },
  effort: { label: "Effort" },
};

/** In the composer's toolbar; a failed pick goes to `onError`, which the composer shows under its frame. */
export function ComposerConfig({ session, pane, onError }: { session: SessionInfo; pane?: string; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState<ConfigRole | null>(null);
  const roles = (["model", "effort"] as const).filter((r) => configOption(session, r));

  // ⌘K "Change model…" / "Change effort…" open a picker in the pane they came from.
  useEffect(
    () =>
      onOpenComposerConfig((r) => {
        if (r.sessionId === session.sessionId && (r.pane === pane || (!r.pane && isFocusedPane(pane)))) setOpen(r.role);
      }),
    [session.sessionId, pane],
  );

  if (roles.length === 0) return <ComposerMode session={session} pane={pane} onError={onError} />;
  return (
    <>
      {/* Shrinks before the toolbar wraps: the values truncate (the full one is in the label and tooltip). */}
      <div role="group" aria-label="Model and effort for the next message" className="flex min-w-0 items-center gap-0.5">
        {roles.map((role) => (
          <ConfigPicker
            key={role}
            role={role}
            session={session}
            option={configOption(session, role)!}
            open={open === role}
            onOpenChange={(o) => setOpen(o ? role : null)}
            onError={onError}
          />
        ))}
      </div>
      <ComposerMode session={session} pane={pane} onError={onError} />
    </>
  );
}

function ConfigPicker({
  role,
  session,
  option,
  open,
  onOpenChange,
  onError,
}: {
  role: ConfigRole;
  session: SessionInfo;
  option: ConfigOption;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onError: (e: unknown) => void;
}) {
  const { label } = LABELS[role];
  const [saving, setSaving] = useState<string | null>(null);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const name = choiceName(option);
  const busy = session.running;
  const searchable = option.choices.length > SEARCH_FROM;
  // Values in the agent's groups, or one list.
  const groups = Object.entries(option.choices.reduce<Record<string, ConfigChoice[]>>((acc, c) => ((acc[c.group ?? ""] ??= []).push(c), acc), {}));

  async function pick(value: string) {
    onOpenChange(false);
    if (value === option.current) return;
    onError(null);
    setSaving(value);
    try {
      await api.setChatConfig(session.sessionId, option.id, value);
    } catch (e) {
      onError(e);
    } finally {
      setSaving(null);
    }
  }

  const title = busy
    ? `${label}: ${name}. Wait for the turn to end to change it.`
    : `${option.description ? `${option.description}. ` : ""}Applies to your next message.`;
  return (
    <Popover open={open && !busy} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          disabled={busy || saving != null}
          aria-label={`${label}: ${name}`}
          title={title}
          data-config={role}
          // In a narrow pane the model's long name gives way; effort levels are a word, kept whole.
          className={role === "model" ? "max-w-[16rem] min-w-[6.5rem] shrink text-muted-foreground" : "max-w-[16rem] shrink-0 text-muted-foreground"}
        >
          {/* "Model" and "Effort" in words, at every width: icons alone didn't say which was which. */}
          {saving != null && <Loader2 className="animate-spin" aria-hidden />}
          {/* The word when the pane is wide, an icon in its place when it's medium, and the value goes too when it's narrow (the title and label say them whole). */}
          <span className="hidden shrink-0 @xl:inline" aria-hidden>
            {label}
          </span>
          {role === "model" ? <Cpu aria-hidden className="@xl:hidden" /> : <Gauge aria-hidden className="@xl:hidden" />}
          <span className="truncate text-foreground @max-md:hidden">{saving != null ? (option.choices.find((c) => c.value === saving)?.name ?? saving) : name}</span>
          <ChevronDown aria-hidden className="hidden @sm:block" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-[min(24rem,calc(100vw-2rem))] p-0"
        // Without a search box the list itself takes the focus, so ↑↓ and Enter work at once.
        onOpenAutoFocus={(e) => {
          if (searchable) return;
          e.preventDefault();
          list.current?.focus();
        }}
      >
        <Command ref={list} tabIndex={-1} label={label} defaultValue={option.current} loop className="outline-none">
          {searchable && (
            <CommandInput
              autoFocus
              aria-label={`Search ${label.toLowerCase()} choices`}
              placeholder={`Search ${option.choices.length} ${role === "model" ? "models" : "levels"}`}
            />
          )}
          <CommandList id={listId} label={`${label} choices`} className="max-h-72">
            <CommandEmpty>No {role === "model" ? "model" : "level"} matches.</CommandEmpty>
            {groups.map(([group, choices]) => (
              <CommandGroup key={group} heading={group || label}>
                {choices.map((c) => (
                  <CommandItem
                    key={c.value}
                    value={c.value}
                    keywords={[c.name, c.description ?? ""]}
                    data-checked={c.value === option.current}
                    onSelect={() => void pick(c.value)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{c.name}</span>
                      {c.description && <span className="truncate text-xs text-muted-foreground">{c.description}</span>}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
