// The pieces every Settings tab is built from: a page of sections, the
// two-pane layout (a list on the left, the picked item on the right), list
// rows, labelled fields, key/value rows and remove-with-confirmation.
import { useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, Plus, Trash2, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { newPair, type Pair } from "@/components/settings/form-state";
import { errorMessage } from "@/lib/narrow";
import { cn } from "@/lib/utils";

/** A single-column tab (General, Chat, Keyboard). */
export function Page({ children }: { children: ReactNode }) {
  return <div className="flex max-w-2xl flex-col gap-8 p-6">{children}</div>;
}

export function Section({ title, about, children }: { title: string; about?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {about && <p className="text-sm text-muted-foreground">{about}</p>}
      </div>
      {children}
    </section>
  );
}

/** A list of things on the left, the one picked on the right. */
export function TwoPane({ label, nav, children }: { label: string; nav: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
      <ScrollArea className="max-h-56 shrink-0 border-b sm:max-h-none sm:w-60 sm:border-r sm:border-b-0">
        <nav className="flex flex-col gap-0.5 p-2" aria-label={label}>
          {nav}
        </nav>
      </ScrollArea>
      <ScrollArea className="min-h-0 flex-1">{children}</ScrollArea>
    </div>
  );
}

export function NavHeading({ children }: { children: ReactNode }) {
  return <h3 className="px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">{children}</h3>;
}

/** A line of status in the list ("Loading…", "None yet."). */
export function NavNote({ loading, children }: { loading?: boolean; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
      {loading && <Loader2 className="size-3 animate-spin" />}
      {children}
    </p>
  );
}

/**
 * A row in the left-hand list. `end` sits inside the button (badges, counts);
 * `action` sits beside it, for a control of its own such as a switch.
 */
export function NavRow({
  active,
  onClick,
  icon,
  label,
  hint,
  note,
  dim,
  end,
  action,
}: {
  active: boolean;
  onClick: () => void;
  icon?: ReactNode;
  label: string;
  /** A second line under the label. */
  hint?: ReactNode;
  /** For screen readers, after the label. */
  note?: string;
  dim?: boolean;
  end?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-2 rounded-md hover:bg-accent", active && "bg-accent", action && "pr-2")}>
      <button
        type="button"
        onClick={onClick}
        aria-current={active || undefined}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {icon}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate", dim && "text-muted-foreground")}>
            {label}
            {note && <span className="sr-only">, {note}</span>}
          </span>
          {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
        </span>
        {end}
      </button>
      {action}
    </div>
  );
}

/** The right-hand side of a two-pane tab. */
export function Panel({ children }: { children: ReactNode }) {
  return <div className="flex max-w-3xl flex-col gap-5 p-6">{children}</div>;
}

export function PanelHeader({ icon, title, extra, children }: { icon?: ReactNode; title: ReactNode; extra?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {icon}
        <h2 className="text-base font-semibold">{title}</h2>
        {extra}
      </div>
      {children}
    </header>
  );
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A failed test, save or import, with what the agent or server printed. */
export function ErrorAlert({ title, error }: { title: string; error: unknown }) {
  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="font-mono text-xs whitespace-pre-wrap">{errorMessage(error)}</AlertDescription>
    </Alert>
  );
}

/** Key/value rows: environment variables or headers. */
export function Pairs({
  legend,
  keyLabel,
  keyPlaceholder,
  addLabel,
  rows,
  onChange,
  secret = () => true,
  note,
}: {
  legend: string;
  keyLabel: string;
  keyPlaceholder: string;
  addLabel: string;
  rows: Pair[];
  onChange: (rows: Pair[]) => void;
  /** Whether a row's value is hidden; all of them by default. */
  secret?: (name: string) => boolean;
  note: ReactNode;
}) {
  // A row added with the button gets focus; rows already there don't.
  const [added, setAdded] = useState<number | null>(null);
  const edit = (id: number, patch: Partial<Pair>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      {rows.map((r) => (
        <div key={r.id} className="flex gap-2">
          <Input
            aria-label={keyLabel}
            autoFocus={r.id === added}
            className="w-2/5 font-mono text-xs"
            value={r.name}
            placeholder={keyPlaceholder}
            spellCheck={false}
            onChange={(e) => edit(r.id, { name: e.target.value })}
          />
          <Input
            aria-label={`Value of ${r.name || keyLabel.toLowerCase()}`}
            className="flex-1 font-mono text-xs"
            type={secret(r.name) ? "password" : "text"}
            autoComplete="off"
            value={r.value}
            spellCheck={false}
            onChange={(e) => edit(r.id, { value: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${r.name || keyLabel.toLowerCase()}`}
            onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
          >
            <X />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const row = newPair();
            setAdded(row.id);
            onChange([...rows, row]);
          }}
        >
          <Plus /> {addLabel}
        </Button>
        <span className="text-xs text-muted-foreground">{note}</span>
      </div>
    </fieldset>
  );
}

/** Remove, then "Remove “name”? Remove / Keep". */
export function RemoveButton({ name, disabled, onRemove }: { name: string; disabled: boolean; onRemove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button type="button" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => setConfirming(true)}>
        <Trash2 /> Remove
      </Button>
    );
  }
  return (
    <span className="ml-auto flex items-center gap-2 text-sm">
      Remove “{name}”?
      <Button type="button" variant="destructive" size="sm" onClick={onRemove} disabled={disabled}>
        Remove
      </Button>
      {/* The safe choice takes focus from the button that just went away. */}
      <Button type="button" variant="ghost" size="sm" autoFocus onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </span>
  );
}

/** Shown while a tab's code loads. */
export function TabSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-6" role="status" aria-label="Loading">
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="h-3 w-72 animate-pulse rounded bg-muted" />
      <div className="h-24 max-w-2xl animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
