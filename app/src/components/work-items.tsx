// How a tracker's items are marked across the app: the service's icon and a badge.
import { CircleDot, FolderKanban, GitMerge, SquareKanban } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { WorkService } from "@/lib/api";
import { SERVICES } from "@/lib/work-items";
import { cn } from "@/lib/utils";

const ICONS = { github: CircleDot, linear: SquareKanban, "linear-project": FolderKanban, gitlab: GitMerge };

export function ServiceIcon({ service, className }: { service: WorkService; className?: string }) {
  const Icon = ICONS[service];
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />;
}

export function ServiceBadge({ service, className }: { service: WorkService; className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal text-muted-foreground", className)}>
      <ServiceIcon service={service} />
      {SERVICES[service].label}
    </Badge>
  );
}
