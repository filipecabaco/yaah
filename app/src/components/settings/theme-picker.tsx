// Pick a colour theme for light or dark mode: yaah's own, the 65 bundled VS Code
// themes, or any dropped into ~/.config/yaah/themes. The highlighted theme
// (by mouse or arrow keys) previews the whole app; Enter or a click picks it.
import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { Palette } from "@/lib/theme-map";
import { BUNDLED, customPalette, previewTheme, type ThemeEntry } from "@/lib/theme";
import { cn } from "@/lib/utils";

type Swatch = Pick<Palette, "canvas" | "surface" | "fg" | "accent">;

// yaah's own tokens, as swatches (index.css).
const YAAH_SWATCH: Record<"light" | "dark", Swatch> = {
  light: { canvas: "#ffffff", surface: "#fafafa", fg: "#0a0a0a", accent: "#171717" },
  dark: { canvas: "#0a0a0a", surface: "#171717", fg: "#fafafa", accent: "#e5e5e5" },
};

function Swatch({ p }: { p: Swatch }) {
  return (
    <span className="flex h-9 w-14 shrink-0 overflow-hidden rounded-md border" style={{ background: p.canvas }} aria-hidden>
      <span className="h-full w-3" style={{ background: p.surface }} />
      <span className="flex flex-1 flex-col justify-center gap-1 px-1.5">
        <span className="h-1 w-full rounded-full" style={{ background: p.fg }} />
        <span className="h-1 w-2/3 rounded-full" style={{ background: p.accent }} />
      </span>
    </span>
  );
}

export function ThemePicker({
  slot,
  value,
  custom,
  onPick,
}: {
  slot: "light" | "dark";
  value: string;
  custom: { file: string; label: string; type: string | null }[];
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(value);
  const [customEntries, setCustomEntries] = useState<ThemeEntry[]>([]);

  // Custom themes are mapped like the bundled ones (and sorted into light/dark by their colours).
  useEffect(() => {
    let live = true;
    void Promise.all(
      custom.map(async (c): Promise<ThemeEntry | null> => {
        const palette = await customPalette(c.file).catch(() => null);
        return palette && { id: `custom:${c.file}`, label: c.label, dark: palette.dark, palette, custom: true };
      }),
    ).then((list) => {
      if (live) setCustomEntries(list.filter((x) => x !== null));
    });
    return () => {
      live = false;
    };
  }, [custom]);

  // A preview never outlives the open list (switching tabs or closing Settings unmounts it).
  useEffect(() => {
    if (open) return () => previewTheme(null);
  }, [open]);

  const entries = useMemo(() => {
    const own: ThemeEntry = { id: "yaah", label: "yaah", dark: slot === "dark", palette: null };
    return [own, ...customEntries, ...BUNDLED].filter((t) => t.dark === (slot === "dark"));
  }, [slot, customEntries]);

  const current = entries.find((t) => t.id === value);
  const swatch = (t?: ThemeEntry) => t?.palette ?? YAAH_SWATCH[slot];
  const close = () => {
    previewTheme(null);
    setOpen(false);
  };
  const listLabel = `${slot === "dark" ? "Dark" : "Light"} mode themes`;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => {
          if (open) return close();
          setHighlighted(value);
          setOpen(true);
        }}
        aria-expanded={open}
        className="flex w-full max-w-md items-center gap-3 rounded-lg border p-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Swatch p={swatch(current)} />
        <span className="flex flex-col">
          <span className="font-medium">{current?.label ?? "yaah"}</span>
          <span className="text-xs text-muted-foreground">{slot === "dark" ? "Dark mode" : "Light mode"}</span>
        </span>
        <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <Command
          label={listLabel}
          className="h-auto rounded-lg! border"
          value={highlighted}
          onValueChange={(id) => {
            setHighlighted(id);
            previewTheme(id || null);
          }}
        >
          <div className="flex items-center gap-1">
            <div className="flex-1">
              <CommandInput autoFocus placeholder={`Search ${entries.length} ${slot} themes`} />
            </div>
            <Button variant="ghost" size="xs" className="mt-1" onClick={close}>
              Done
            </Button>
          </div>
          <CommandList className="max-h-80" aria-label={listLabel} onMouseLeave={() => previewTheme(null)}>
            <CommandEmpty>No theme matches.</CommandEmpty>
            {entries.map((t) => (
              <CommandItem
                key={t.id}
                value={t.id}
                keywords={[t.label]}
                data-checked={t.id === value}
                onSelect={() => {
                  onPick(t.id);
                  close();
                }}
              >
                <Swatch p={swatch(t)} />
                <span className="min-w-0 flex-1 truncate">{t.label}</span>
                {t.custom && <span className="text-[10px] text-muted-foreground">yours</span>}
                {t.id === value && <span className="sr-only">(current)</span>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      )}
    </div>
  );
}
