// Settings → Chat: how tool-call cards open, per kind of tool. Also set from a
// card's right-click menu ("Always collapse …").
import { useEffect, useState } from "react";
import { Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorText } from "@/components/error-text";
import { Page, Section } from "@/components/settings/parts";
import { api } from "@/lib/api";
import { cardKeyLabel, saveCardRule, setCardRules, useCardRules, type CardMode } from "@/lib/tool-cards";

const MODES: { id: CardMode; label: string }[] = [
  { id: "auto", label: "Open while it runs" },
  { id: "collapsed", label: "Collapsed" },
  { id: "expanded", label: "Expanded" },
];

function ModeSelect({ value, onChange, label }: { value: CardMode; onChange: (m: CardMode) => void; label: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as CardMode)}>
      <SelectTrigger className="w-44" size="sm" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MODES.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ChatSettings() {
  const rules = useCardRules();
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [key, setKey] = useState("");
  const [mode, setMode] = useState<CardMode>("collapsed");
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.generalSettings().then((s) => {
      setCardRules(s.toolCards.rules);
      setDefaults(Object.fromEntries(s.toolCards.defaults.map((d) => [d.key, d.mode])));
    }, setError);
  }, []);
  const save = (k: string, m: CardMode | null) => {
    setError(null);
    saveCardRule(k, m).catch(setError);
  };
  const addRule = async () => {
    const k = key.trim();
    if (!k) return;
    setError(null);
    try {
      await saveCardRule(k, mode);
      setKey("");
    } catch (e) {
      setError(e);
    }
  };
  const keys = Object.keys(rules).sort((a, b) => cardKeyLabel(a).localeCompare(cardKeyLabel(b)));

  return (
    <Page>
      <Section
        title="Tool calls"
        about="How each kind of tool call's card opens in a chat. Anything not listed opens while it runs and closes when the turn ends. Right-click a card to set its kind from there."
      >
        <ul className="flex flex-col divide-y rounded-lg border">
          {keys.length === 0 && <li className="p-3 text-sm text-muted-foreground">No rules.</li>}
          {keys.map((k) => {
            const isDefault = defaults[k] === rules[k];
            return (
              <li key={k} className="flex items-center gap-3 p-2 pl-3">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-xs" title={k}>
                    {cardKeyLabel(k)}
                  </span>
                  {isDefault && <span className="text-[11px] text-muted-foreground">default</span>}
                </div>
                <span className="ml-auto flex items-center gap-1">
                  <ModeSelect value={rules[k]} onChange={(m) => save(k, m)} label={`How ${cardKeyLabel(k)} cards open`} />
                  {!isDefault && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={defaults[k] ? "Back to the default" : "Remove"}
                      aria-label={`Reset ${k}`}
                      onClick={() => save(k, null)}
                    >
                      <RotateCcw />
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void addRule();
          }}
        >
          <Input
            aria-label="Kind of tool"
            className="w-64 font-mono text-xs"
            placeholder="ToolSearch, mcp__fetch__fetch, mcp__github, kind:read"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <ModeSelect value={mode} onChange={setMode} label="How its cards open" />
          <Button type="submit" variant="outline" size="sm" disabled={!key.trim()}>
            <Plus /> Add rule
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          A tool's name, as on its card; <code>mcp__server</code> for every tool of an MCP server; <code>kind:execute</code>, <code>kind:read</code>,{" "}
          <code>kind:edit</code>… for commands, file reads, edits and so on.
        </p>
        <ErrorText error={error} className="text-sm" />
      </Section>
    </Page>
  );
}
