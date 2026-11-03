// Settings → Chat: what agents are told about yaah's UI, and how tool-call cards
// open, per kind of tool (also set from a card's right-click menu, "Always collapse …").
import { useEffect, useState } from "react";
import { ChevronRight, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorText } from "@/components/error-text";
import { Page, Section } from "@/components/settings/parts";
import { api, type AgentGuide } from "@/lib/api";
import { cn } from "@/lib/utils";
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

/** A folded block of text an agent is given, by name. */
function Told({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium">
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1.5 max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed whitespace-pre-wrap">{text}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** "Teach agents about yaah's UI": the switch, and what each agent is told and how. */
function AgentGuideSection() {
  const [guide, setGuide] = useState<AgentGuide | null>(null);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = () => api.agentGuide().then(setGuide, setError);
  useEffect(() => {
    void load();
  }, []);
  const toggle = async (on: boolean) => {
    setError(null);
    try {
      await api.setTeachAgents(on);
      await load();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Section
      title="yaah's UI"
      about="Agents can answer with tables, charts, previews and forms in the chat. yaah tells them how, so they reply with UI instead of writing HTML files or opening other apps. Applies to new chats."
    >
      <div className="flex items-center gap-3">
        <Switch id="teach-agents" checked={guide?.enabled ?? true} disabled={!guide} onCheckedChange={(on) => void toggle(on)} />
        <Label htmlFor="teach-agents">Teach agents about yaah&apos;s UI</Label>
      </div>
      {guide && (
        <Collapsible open={shown} onOpenChange={setShown}>
          <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronRight className={cn("size-4 transition-transform", shown && "rotate-90")} />
            Show what agents are told
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 flex flex-col gap-3">
            <ul className="flex flex-col divide-y rounded-lg border text-sm" aria-label="How each agent is told">
              {guide.agents.map((a) => (
                <li key={a.id} className="flex flex-col gap-1 p-2 pl-3">
                  <span className="font-medium">{a.label}</span>
                  {!a.known ? (
                    <span className="text-xs text-muted-foreground">Known after its first chat.</span>
                  ) : a.routes.length === 0 ? (
                    <span className="text-xs text-muted-foreground">Can&apos;t reach yaah&apos;s UI server, so it isn&apos;t told about it.</span>
                  ) : (
                    <ul className="ml-4 list-disc text-xs text-muted-foreground">
                      {a.routes.map((r) => (
                        <li key={r.id}>{r.label}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            <Told title="The guide (system prompt, or the first message)" text={guide.guide} />
            {guide.skills.map((s) => (
              <Told key={s.name} title={`Skill ${s.name} (${s.path})`} text={s.text} />
            ))}
            <p className="text-xs text-muted-foreground">
              The skills are written to <code>{guide.skillsDir}</code> and, for Claude Code, wrapped as a plugin in <code>{guide.pluginDir}</code>.
              They go to each chat&apos;s agent only, never into an agent&apos;s own settings. yaah&apos;s MCP server always carries short
              instructions and the <code>ui_guide</code> tool.
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
      <ErrorText error={error} className="text-sm" />
    </Section>
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
      <AgentGuideSection />
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
