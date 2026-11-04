// Pick a model a provider offers an agent (`provider_models`): searchable, with
// each model's context length, whether it can call tools, and OpenRouter's free
// ones marked. Opens in place, like the theme picker.
import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import type { ProviderModel } from "@/lib/api";
import { cn } from "@/lib/utils";

/** 200000 → "200K", 1048576 → "1M". */
const contextText = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
const isFree = (id: string) => id.endsWith(":free");
/** The value cmdk keeps for "none" (an empty one means nothing highlighted). */
const NONE = "__none__";

function ModelMeta({ model }: { model: ProviderModel }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {model.contextLength != null && <span className="text-xs text-muted-foreground tabular-nums">{contextText(model.contextLength)} context</span>}
      {model.tools && <Badge variant="outline">tools</Badge>}
      {isFree(model.id) && <Badge variant="secondary">free</Badge>}
    </span>
  );
}

export function ModelPicker({
  id,
  label,
  hint,
  models,
  loading,
  value,
  onChange,
  none,
}: {
  id: string;
  label: string;
  hint?: string;
  models: ProviderModel[] | null;
  loading: boolean;
  value: string | null;
  onChange: (id: string | null) => void;
  /** Offer "no model" with this label (an optional pick). */
  none?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = models?.find((m) => m.id === value);
  const listLabel = `${label}: models`;
  const pick = (v: string | null) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <button
        id={id}
        type="button"
        disabled={loading && !value}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-lg border px-2.5 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {current?.label ?? value ?? (loading ? "Loading models…" : (none ?? "Pick a model"))}
          </span>
          {value && <span className="truncate font-mono text-2xs text-muted-foreground">{value}</span>}
        </span>
        {current && <ModelMeta model={current} />}
        {loading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
        )}
      </button>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {open && models && (
        <Command label={listLabel} className="h-auto rounded-lg! border" defaultValue={value ?? (none ? NONE : undefined)}>
          <div className="flex items-center gap-1">
            <div className="flex-1">
              <CommandInput autoFocus placeholder={`Search ${models.length} models`} />
            </div>
            <Button type="button" variant="ghost" size="xs" className="mt-1" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
          <CommandList className="max-h-72" label={listLabel}>
            <CommandEmpty>No model matches.</CommandEmpty>
            {none && (
              <CommandItem value={NONE} keywords={[none]} data-checked={!value} onSelect={() => pick(null)}>
                <span className="text-muted-foreground">{none}</span>
              </CommandItem>
            )}
            {models.map((m) => (
              <CommandItem key={m.id} value={m.id} keywords={[m.label]} data-checked={m.id === value} onSelect={() => pick(m.id)}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{m.label}</span>
                  <span className="truncate font-mono text-2xs text-muted-foreground">{m.id}</span>
                </span>
                <ModelMeta model={m} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      )}
    </div>
  );
}
