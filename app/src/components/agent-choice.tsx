// Choosing the agent a chat or project starts with: a select (forms, the
// project page) and a "… with…" menu (split buttons beside New chat buttons).
import type { ReactElement, ReactNode } from "react";
import { Bot } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AgentProfile } from "@/lib/api";
import { cn } from "@/lib/utils";

/** What tells an agent apart in a list: its login state, account or preset. */
const agentDetail = (a: AgentProfile) => (a.loggedIn === false ? "not logged in" : (a.email ?? (a.label === a.presetLabel ? "" : a.presetLabel)));

export function AgentSelect({
  agents,
  value,
  onChange,
  label,
  className,
  size,
  disabled,
}: {
  agents: AgentProfile[];
  value: string;
  onChange: (id: string) => void;
  /** Its accessible name. */
  label: string;
  className?: string;
  size?: "sm" | "default";
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      {/* The name sits by the icon, not centred between it and the chevron. */}
      <SelectTrigger className={cn("*:data-[slot=select-value]:flex-1", className)} size={size} aria-label={label}>
        <Bot className="text-muted-foreground" />
        <SelectValue placeholder="No agent" />
      </SelectTrigger>
      <SelectContent>
        {agents.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            <span>{a.label}</span>
            {/* In the list only: the trigger shows the name. */}
            <span className="text-xs text-muted-foreground in-data-[slot=select-value]:hidden">{agentDetail(a)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A menu of agents to start something with, opened from `children` (its
 * trigger). `current` is marked with `currentHint` (e.g. the ⌘N keys).
 */
export function AgentMenu({
  agents,
  heading,
  current,
  currentHint,
  onPick,
  align = "start",
  children,
}: {
  agents: AgentProfile[];
  heading: string;
  current?: string;
  currentHint?: ReactNode;
  onPick: (id: string) => void;
  align?: "start" | "end";
  children: ReactElement;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-56">
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        {agents.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => onPick(a.id)}>
            <Bot />
            <span className="truncate">{a.label}</span>
            {agentDetail(a) && <span className="truncate text-xs text-muted-foreground">{agentDetail(a)}</span>}
            {a.id === current && currentHint && <DropdownMenuShortcut>{currentHint}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
