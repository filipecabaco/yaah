// Forms in agent-built UI: how the agent gets structured input from the user,
// and how the two fill something in together. Unsent values are a draft that
// Rust keeps: the user's edits go there (debounced), the agent reads it
// (ui_get_values) and writes it (ui_set_values), and the agent's changes show
// up here marked as the agent's. Submitting sends the values once: straight
// back to a waiting `ui_ask` call, or as the user's next message. Then the form
// locks and shows what was answered.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Bot, Check, CheckCircle2, GripVertical, Loader2, X, XCircle } from "lucide-react";
import { ErrorText } from "@/components/error-text";
import { FormHostContext, type FormHost } from "@/components/ui-form-host";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { asArray, isObj, optText, show, type Obj } from "@/lib/narrow";
import { cn } from "@/lib/utils";

type Values = Obj;
type Option = { value: string; label: string; description?: string };

type Ctx = {
  values: Values;
  set: (name: string, value: unknown) => void;
  init: (name: string, value: unknown) => void;
  locked: boolean;
  missing: Set<string>;
  /** Fields whose value is the agent's (until the user changes them). */
  byAgent: Set<string>;
  /** Fields the agent just changed, for a moment. */
  flash: Set<string>;
};

const FormContext = createContext<Ctx | null>(null);

/** Options as the agent wrote them: `["a", "b"]` or `[{ value, label?, description? }]`. */
function toOptions(raw: unknown): Option[] {
  return asArray(raw).flatMap((o): Option[] => {
    if (isObj(o)) {
      const value = show(o.value);
      return value ? [{ value, label: optText(o.label) ?? value, description: optText(o.description) }] : [];
    }
    const value = show(o);
    return value ? [{ value, label: value }] : [];
  });
}

const without = (s: Set<string>, name: string) => (s.has(name) ? new Set([...s].filter((x) => x !== name)) : s);
const agentFields = (host: FormHost | undefined) =>
  Object.entries(host?.draftBy ?? {})
    .filter(([, who]) => who === "agent")
    .map(([k]) => k);

function useField(name: string, initial: unknown) {
  const ctx = useContext(FormContext);
  const init = ctx?.init;
  // Register the field's starting value once per distinct value (callers pass fresh arrays).
  const initialJson = JSON.stringify(initial);
  useEffect(() => {
    if (initialJson !== undefined) init?.(name, JSON.parse(initialJson));
  }, [init, name, initialJson]);
  return {
    value: ctx?.values[name],
    set: (v: unknown) => ctx?.set(name, v),
    locked: ctx?.locked ?? true,
    missing: ctx?.missing.has(name) ?? false,
    byAgent: ctx?.byAgent.has(name) ?? false,
    flash: ctx?.flash.has(name) ?? false,
  };
}

export function UiForm({
  submitLabel,
  description,
  required,
  children,
}: {
  submitLabel?: string;
  description?: string;
  /** Names of required fields (collected by the renderer from the tree). */
  required: string[];
  children: ReactNode;
}) {
  const host = useContext(FormHostContext);
  const answered = isObj(host?.answer) ? host.answer : null;
  const cancelled = answered?.$cancelled === true;
  const [values, setValues] = useState<Values>(() => (answered && !cancelled ? answered : { ...host?.draft }));
  const [byAgent, setByAgent] = useState<Set<string>>(() => new Set(agentFields(host)));
  const [flash, setFlash] = useState<Set<string>>(new Set());
  // The agent's value last applied per field, so each change applies (and flashes) once.
  const [agentSeen, setAgentSeen] = useState<Record<string, string>>(() =>
    Object.fromEntries(agentFields(host).map((k) => [k, JSON.stringify(host?.draft?.[k])])),
  );
  // Fields the user changed that aren't stored yet: their write follows, and the last write wins.
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [local, setLocal] = useState<Values | null>(null); // optimistic lock until the stored answer arrives
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const locked = !!answered || !!local || !host?.onSubmit;

  // The agent changed the shared draft: take its values, except for fields the user is mid-edit on.
  const draftKey = JSON.stringify([host?.draft ?? null, host?.draftBy ?? null]);
  const [seenDraft, setSeenDraft] = useState(draftKey);
  if (draftKey !== seenDraft) {
    setSeenDraft(draftKey);
    const changed: Values = {};
    const seen = { ...agentSeen };
    for (const k of answered ? [] : agentFields(host)) {
      const json = JSON.stringify(host?.draft?.[k]);
      if (seen[k] === json) continue;
      seen[k] = json;
      if (!editing.has(k)) changed[k] = host?.draft?.[k];
    }
    const keys = Object.keys(changed);
    setAgentSeen(seen);
    if (keys.length) {
      setValues((prev) => ({ ...prev, ...changed }));
      setByAgent((s) => new Set([...s, ...keys]));
      setFlash(new Set(keys));
    }
  }
  useEffect(() => {
    if (!flash.size) return;
    const t = setTimeout(() => setFlash(new Set()), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  // The stored answer arrived (or changed): show exactly that.
  const answerKey = JSON.stringify(answered);
  const [seenAnswer, setSeenAnswer] = useState(answerKey);
  if (answerKey !== seenAnswer) {
    setSeenAnswer(answerKey);
    if (answered && !cancelled) setValues(answered);
  }

  // The user's changes not yet stored, sent together after a short pause in typing.
  const pending = useRef<Values>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onEdit = useRef(host?.onEdit);
  useEffect(() => {
    onEdit.current = host?.onEdit;
  });
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const changes = pending.current;
    pending.current = {};
    setEditing(new Set());
    if (Object.keys(changes).length) onEdit.current?.(changes).catch(setError);
  }, []);
  useEffect(() => flush, [flush]);

  const init = useCallback((name: string, v: unknown) => setValues((prev) => (name in prev || v === undefined ? prev : { ...prev, [name]: v })), []);
  const ctx: Ctx = {
    values,
    locked,
    missing,
    byAgent,
    flash,
    init,
    set: (name, v) => {
      setValues((prev) => ({ ...prev, [name]: v }));
      setByAgent((s) => without(s, name));
      setMissing((m) => without(m, name));
      if (host?.onEdit) {
        pending.current[name] = v;
        setEditing((s) => (s.has(name) ? s : new Set([...s, name])));
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, 350);
      }
    },
  };

  async function submit() {
    if (locked || sending || !host?.onSubmit) return;
    const empty = required.filter((n) => {
      const v = values[n];
      return v == null || v === "" || (Array.isArray(v) && v.length === 0);
    });
    if (empty.length) {
      setMissing(new Set(empty));
      return;
    }
    setSending(true);
    setError(null);
    flush();
    try {
      await host.onSubmit(values);
      setLocal(values);
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  return (
    <FormContext.Provider value={ctx}>
      <form
        className="flex flex-col gap-4 rounded-lg border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        {children}
        <div className="flex flex-wrap items-center gap-3 border-t pt-3">
          {cancelled ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <X className="size-4" /> Cancelled
            </span>
          ) : locked && host?.onSubmit ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 text-green-600" /> Sent
              {host.asking && <span>· the agent carried on with your answer</span>}
            </span>
          ) : (
            <>
              <Button type="submit" size="sm" disabled={sending || !host?.onSubmit}>
                {sending && <Loader2 className="animate-spin" />}
                {submitLabel ?? "Send"}
              </Button>
              <span className="text-xs text-muted-foreground">
                <Kbd>⌘</Kbd>
                <Kbd>↵</Kbd> {host?.asking ? "· the agent is waiting for this" : ""}
              </span>
              {missing.size > 0 && (
                <span role="alert" className="text-xs text-destructive">
                  Fill in the highlighted fields
                </span>
              )}
            </>
          )}
          <ErrorText error={error} />
        </div>
      </form>
    </FormContext.Provider>
  );
}

/** Says a value is the agent's; the field flashes when the agent changes it. */
function AgentMark({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-sm bg-primary/10 px-1 text-2xs font-normal text-primary"
      title="Filled in by the agent; change it if it's wrong"
    >
      <Bot className="size-3" /> agent
    </span>
  );
}

function Field({
  label,
  description,
  missing,
  byAgent,
  flash,
  children,
  htmlFor,
}: {
  label: string;
  description?: string;
  missing?: boolean;
  byAgent?: boolean;
  flash?: boolean;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={cn("-m-1.5 flex flex-col gap-1.5 rounded-md p-1.5 transition-colors duration-700", flash && "bg-primary/10")}>
      <Label htmlFor={htmlFor} className={cn("gap-1.5", missing && "text-destructive")}>
        {label}
        <AgentMark on={!!byAgent} />
      </Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {children}
    </div>
  );
}

export function UiTextfield({
  name,
  label,
  placeholder,
  initial,
  multiline,
}: {
  name: string;
  label: string;
  placeholder?: string;
  initial?: string;
  multiline?: boolean;
}) {
  const f = useField(name, initial);
  const id = useId();
  const common = {
    id,
    value: show(f.value),
    placeholder,
    disabled: f.locked,
    "aria-invalid": f.missing || undefined,
    onChange: (e: { target: { value: string } }) => f.set(e.target.value),
  };
  return (
    <Field label={label} missing={f.missing} byAgent={f.byAgent} flash={f.flash} htmlFor={id}>
      {multiline ? <Textarea {...common} className="min-h-24" /> : <Input {...common} />}
    </Field>
  );
}

export function UiChoice({
  name,
  label,
  options: raw,
  multiple,
  initial,
  correct,
  explanation,
}: {
  name: string;
  label: string;
  options: unknown;
  multiple?: boolean;
  initial?: unknown;
  correct?: unknown;
  explanation?: string;
}) {
  const options = toOptions(raw);
  const f = useField(name, initial ?? (multiple ? [] : undefined));
  const picked = new Set((Array.isArray(f.value) ? (f.value as unknown[]) : f.value == null ? [] : [f.value]).map(show));
  const right = correct == null ? null : new Set((Array.isArray(correct) ? (correct as unknown[]) : [correct]).map(show));
  const graded = f.locked && right != null && picked.size > 0;
  const allRight = graded && [...picked].every((v) => right.has(v)) && [...right].every((v) => picked.has(v));
  const group = useRef<HTMLDivElement>(null);
  // A radio group is one tab stop: the picked option, else the first.
  const tabStop = multiple ? null : (options.find((o) => picked.has(o.value)) ?? options[0])?.value;

  function toggle(v: string) {
    if (f.locked) return;
    if (!multiple) return f.set(v);
    const next = new Set(picked);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    f.set([...next]);
  }

  // Arrow keys move between radios and pick, like native radio buttons.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (multiple || f.locked) return;
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step || !options.length) return;
    e.preventDefault();
    const at = options.findIndex((o) => o.value === tabStop);
    const next = options[(at + step + options.length) % options.length];
    toggle(next.value);
    group.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  }

  return (
    <Field label={label} missing={f.missing} byAgent={f.byAgent} flash={f.flash}>
      <div ref={group} role={multiple ? "group" : "radiogroup"} aria-label={label} onKeyDown={onKeyDown} className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const on = picked.has(o.value);
          const isRight = graded && right.has(o.value);
          const isWrong = graded && on && !right.has(o.value);
          return (
            <button
              key={o.value}
              type="button"
              data-value={o.value}
              role={multiple ? "checkbox" : "radio"}
              aria-checked={on}
              tabIndex={tabStop == null || tabStop === o.value ? 0 : -1}
              disabled={f.locked}
              onClick={() => toggle(o.value)}
              className={cn(
                "flex items-start gap-2.5 rounded-md border p-2.5 text-left text-sm transition-colors enabled:hover:bg-muted disabled:cursor-default",
                on && "border-primary bg-primary/5",
                isRight && "border-green-600 bg-green-500/10",
                isWrong && "border-destructive bg-destructive/10",
                f.missing && "border-destructive/60",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 grid size-4 shrink-0 place-items-center border",
                  multiple ? "rounded-[4px]" : "rounded-full",
                  on && "border-primary bg-primary text-primary-foreground",
                )}
              >
                {on && <Check className="size-3" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{o.label}</span>
                {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
              </span>
              {isRight && <CheckCircle2 className="size-4 shrink-0 text-green-600" aria-label="correct" />}
              {isWrong && <XCircle className="size-4 shrink-0 text-destructive" aria-label="wrong" />}
            </button>
          );
        })}
      </div>
      {graded && (
        <p className={cn("text-sm", allRight ? "text-green-700 dark:text-green-400" : "text-destructive")}>
          {allRight ? "Correct." : "Not quite."} {explanation}
        </p>
      )}
    </Field>
  );
}

export function UiSelect({ name, label, options: raw, initial }: { name: string; label: string; options: unknown; initial?: string }) {
  const options = toOptions(raw);
  const f = useField(name, initial);
  const id = useId();
  return (
    <Field label={label} missing={f.missing} byAgent={f.byAgent} flash={f.flash} htmlFor={id}>
      <Select value={f.value == null ? undefined : show(f.value)} onValueChange={f.set} disabled={f.locked}>
        <SelectTrigger id={id} className="w-full sm:w-72" aria-invalid={f.missing || undefined}>
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function UiSlider({
  name,
  label,
  min,
  max,
  step,
  initial,
  unit,
}: {
  name: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  initial?: number;
  unit?: string;
}) {
  const lo = min ?? 0;
  const hi = max ?? 100;
  const f = useField(name, initial ?? Math.round((lo + hi) / 2));
  const v = typeof f.value === "number" ? f.value : Number(f.value ?? lo) || lo;
  return (
    <Field label={label} byAgent={f.byAgent} flash={f.flash}>
      <div className="flex items-center gap-3">
        <Slider
          value={[v]}
          min={lo}
          max={hi}
          step={step || 1}
          disabled={f.locked}
          onValueChange={([n]) => f.set(n)}
          className="flex-1"
          aria-label={label}
        />
        <span className="w-20 text-right font-mono text-sm tabular-nums">
          {v.toLocaleString()}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
    </Field>
  );
}

export function UiRank({ name, label, items: raw }: { name: string; label: string; items: unknown }) {
  const all = toOptions(raw);
  const f = useField(
    name,
    all.map((i) => i.value),
  );
  const order = (Array.isArray(f.value) ? (f.value as unknown[]) : all.map((i) => i.value)).map(show);
  const byValue = new Map(all.map((i) => [i.value, i]));
  const [dragging, setDragging] = useState<number | null>(null);

  function move(from: number, to: number) {
    if (f.locked || to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    f.set(next);
  }

  return (
    <Field label={label} byAgent={f.byAgent} flash={f.flash} description={f.locked ? undefined : "Drag, or use the arrows. First is most important."}>
      <ol className="flex flex-col gap-1.5" aria-label={label}>
        {order.map((v, i) => {
          const item = byValue.get(v);
          const name = item?.label ?? v;
          return (
            <li
              key={v}
              draggable={!f.locked}
              onDragStart={() => setDragging(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging != null) move(dragging, i);
                setDragging(null);
              }}
              className={cn("flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-sm", dragging === i && "opacity-50")}
            >
              {!f.locked && <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />}
              <span className="w-5 text-right font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1">
                {name}
                {item?.description && <span className="block text-xs text-muted-foreground">{item.description}</span>}
              </span>
              {!f.locked && (
                <span className="flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${name} up`}
                    disabled={i === 0}
                    onClick={() => move(i, i - 1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${name} down`}
                    disabled={i === order.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    <ArrowDown />
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </Field>
  );
}

export function UiToggle({ name, label, description, initial }: { name: string; label: string; description?: string; initial?: boolean }) {
  const f = useField(name, initial ?? false);
  const id = useId();
  return (
    <div className={cn("-m-1.5 flex items-start justify-between gap-4 rounded-md p-1.5 transition-colors duration-700", f.flash && "bg-primary/10")}>
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="gap-1.5">
          {label}
          <AgentMark on={f.byAgent} />
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={!!f.value} disabled={f.locked} onCheckedChange={f.set} />
    </div>
  );
}
