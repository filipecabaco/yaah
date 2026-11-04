// Settings → Appearance → Fonts: the interface font and the code font (code blocks,
// diffs, tool output, terminals), each "System default" or a family installed on this
// machine (fonts.rs lists them), and a size for each. A change applies at once and is
// saved; Rust checks it and builds the CSS (settings.rs `set_fonts`), lib/fonts.ts puts
// it on the root.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronsUpDown, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { ErrorText } from "@/components/error-text";
import { api, type FontChoice, type FontSettings, type InstalledFonts } from "@/lib/api";
import { applyFonts, previewFamily } from "@/lib/fonts";

const DEFAULT = "System default";
const choiceOf = ({ ui, code, uiSize, codeSize }: FontChoice): FontChoice => ({ ui, code, uiSize, codeSize });

function FontPicker({
  label,
  value,
  families,
  monoFirst,
  onPick,
}: {
  label: string;
  value: string | null;
  families: InstalledFonts["families"];
  monoFirst?: boolean;
  onPick: (family: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => {
    if (!monoFirst) return [{ heading: "Installed", items: families }];
    return [
      { heading: "Monospace", items: families.filter((f) => f.mono) },
      { heading: "Other fonts", items: families.filter((f) => !f.mono) },
    ];
  }, [families, monoFirst]);
  const pick = (family: string | null) => {
    onPick(family);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={`${label} font`}
          className="w-72 max-w-full justify-between font-normal"
        >
          <span className="truncate" style={value ? { fontFamily: previewFamily(value) } : undefined}>
            {value ?? DEFAULT}
          </span>
          <ChevronsUpDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command label={`${label} fonts`}>
          <CommandInput placeholder={`Search ${families.length} fonts`} />
          <CommandList className="max-h-72" label={`${label} fonts`}>
            <CommandEmpty>No font matches.</CommandEmpty>
            <CommandGroup>
              <CommandItem value={DEFAULT} data-checked={value == null} onSelect={() => pick(null)}>
                {DEFAULT}
              </CommandItem>
            </CommandGroup>
            {groups.map(
              (g) =>
                g.items.length > 0 && (
                  <CommandGroup key={g.heading} heading={g.heading}>
                    {g.items.map((f) => (
                      <CommandItem
                        key={f.name}
                        value={f.name}
                        data-checked={f.name === value}
                        style={{ fontFamily: previewFamily(f.name) }}
                        onSelect={() => pick(f.name)}
                      >
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        {f.name === value && <span className="sr-only">(current)</span>}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ),
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function SizeSlider({
  label,
  value,
  shown,
  limits,
  note,
  onChange,
}: {
  label: string;
  value: number | null;
  /** What the slider shows when `value` is unset. */
  shown: number;
  limits: { min: number; max: number; default: number };
  note: string;
  onChange: (size: number) => void;
}) {
  const size = value ?? shown;
  // Spoken as shown ("14 pixels, default"), not a bare number (SR-6).
  const spoken = value == null ? `${size} pixels, ${note}` : `${size} pixels`;
  return (
    <div className="flex w-72 max-w-full flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{label} size</span>
        <span className="text-muted-foreground tabular-nums">{value == null ? `${size} px · ${note}` : `${size} px`}</span>
      </div>
      <Slider
        aria-label={`${label} size`}
        aria-valuetext={spoken}
        min={limits.min}
        max={limits.max}
        step={1}
        value={[size]}
        onValueChange={([n]) => n !== size && onChange(n)}
      />
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums" aria-hidden>
        <span>{limits.min}</span>
        <span>{limits.max}</span>
      </div>
    </div>
  );
}

export function FontsSection({ initial }: { initial: FontSettings }) {
  const [fonts, setFonts] = useState(initial);
  const [installed, setInstalled] = useState<InstalledFonts | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Changes go to Rust one after another (a slider sends many); only the latest answer is applied.
  const latest = useRef(0);

  useEffect(() => {
    let live = true;
    api.installedFonts().then(
      (list) => live && setInstalled(list),
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, []);

  const save = (change: Partial<FontChoice>) => {
    const next = { ...choiceOf(fonts), ...change };
    const run = ++latest.current;
    setFonts((f) => ({ ...f, ...next }));
    setError(null);
    api.setFonts(next).then(
      (saved) => {
        if (run !== latest.current) return;
        setFonts(saved);
        applyFonts(saved.css);
      },
      (e: unknown) => {
        if (run !== latest.current) return;
        setError(e);
        setFonts(fonts);
      },
    );
  };

  const families = installed?.families ?? [];
  const { limits } = fonts;
  const uiSize = fonts.uiSize ?? limits.uiSize.default;
  const codeFollows = Math.round((limits.codeSize.default * uiSize) / limits.uiSize.default);
  const isDefault = fonts.ui == null && fonts.code == null && fonts.uiSize == null && fonts.codeSize == null;

  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-medium">Fonts</h4>
      <p className="text-sm text-muted-foreground">
        The interface font is for all text, chats and the components agents draw. The code font is for code blocks, diffs, tool output and terminals.
        {installed &&
          (installed.fallback ? " The font folders couldn't be read, so this is a short list." : ` ${families.length} fonts on this machine.`)}
      </p>
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <div className="flex flex-col gap-3">
          <span className="text-sm font-medium">Interface</span>
          <FontPicker label="Interface" value={fonts.ui} families={families} onPick={(ui) => save({ ui })} />
          <SizeSlider
            label="Interface"
            value={fonts.uiSize}
            shown={limits.uiSize.default}
            limits={limits.uiSize}
            note="default"
            onChange={(n) => save({ uiSize: n })}
          />
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-sm font-medium">Code</span>
          <FontPicker label="Code" value={fonts.code} families={families} monoFirst onPick={(code) => save({ code })} />
          <SizeSlider
            label="Code"
            value={fonts.codeSize}
            shown={codeFollows}
            limits={limits.codeSize}
            note="follows the interface"
            onChange={(n) => save({ codeSize: n })}
          />
        </div>
      </div>
      <figure aria-label="Font preview" className="flex max-w-2xl flex-col gap-2 rounded-lg border p-3">
        <p className="text-sm">The quick brown fox jumps over the lazy dog. 0123456789</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-code">
          {'const answer = fonts.find((f) => f.mono) ?? "monospace"; // 0O 1lI'}
        </pre>
      </figure>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={isDefault} onClick={() => save({ ui: null, code: null, uiSize: null, codeSize: null })}>
          <RotateCcw /> Reset to defaults
        </Button>
        {fonts.codeSize != null && (
          <Button variant="ghost" size="sm" onClick={() => save({ codeSize: null })}>
            Code follows the interface size
          </Button>
        )}
      </div>
      <ErrorText error={error} className="text-sm" />
    </div>
  );
}
