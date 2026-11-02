import type { ReactElement } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { COMPOSER_KEYS, SHORTCUTS, type ShortcutId } from "@/lib/shortcuts";

export function Keys({ keys }: { keys: string[] }) {
  return (
    <KbdGroup>
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </KbdGroup>
  );
}

/** Tooltip naming a control, with its shortcut when it has one. */
export function Hint({ label, shortcut, children }: { label: string; shortcut?: ShortcutId; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <Keys keys={SHORTCUTS[shortcut].keys} />}
      </TooltipContent>
    </Tooltip>
  );
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sections = [
    { title: "Anywhere", rows: Object.values(SHORTCUTS) },
    { title: "In the message box", rows: COMPOSER_KEYS },
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts with a modifier work even while you type.</DialogDescription>
        </DialogHeader>
        {sections.map((s) => (
          <section key={s.title} className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">{s.title}</h3>
            {s.rows.map((r) => (
              <div key={r.label + r.keys.join()} className="flex items-center justify-between gap-4 py-0.5">
                <span>{r.label}</span>
                <Keys keys={r.keys} />
              </div>
            ))}
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
