// Renders agent-built UI: a tree of primitives from `ui-primitives.json`, with
// {{bindings}} resolved against props (see ui-bindings.ts). Library components
// arrive already expanded by Rust into `$component` nodes, so this only knows
// primitives. It runs no agent code; everything here is data mapped onto
// shadcn, and every prop is read from `unknown` through lib/narrow.
import { Component, Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight, ExternalLink, RotateCw } from "lucide-react";
import { Markdown, SafeImage } from "@/components/markdown";
import { draftIntoComposer, useChat } from "@/components/chat-context";
import { ErrorText } from "@/components/error-text";
import { UiChoice, UiForm, UiRank, UiSelect, UiSlider, UiTextfield, UiToggle } from "@/components/ui-form";
import { FormHostContext, type FormHost } from "@/components/ui-form-host";
import { growClass, growAttr, inlineMax, useUiView } from "@/components/ui-view";
import { branch, collectTabs, eachScopes, requiredFields, resolve, resolveProps, type Scope } from "@/components/ui-bindings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { isWebUrl, openExternal } from "@/lib/links";
import { asArray, asNumber, asObj, isObj, optText, show, type Obj } from "@/lib/narrow";
import { cn } from "@/lib/utils";
import { preloadable, preloadAll, whenIdle } from "@/lib/preload";

// Library-backed blocks load on first use, so a chat without a chart never downloads its code.
// Once a chat shows agent UI, the rest are fetched while the app is idle (preloadUiBlocks), and a
// block whose code is in draws at once instead of flashing a placeholder.
const UiChart = preloadable(() => import("@/components/ui-blocks/chart").then((m) => m.default));
const UiMap = preloadable(() => import("@/components/ui-blocks/map").then((m) => m.default));
// Region maps (outline, choropleth, bubble, connection, hexbin) and flow graphs are SVG over d3 modules: no Leaflet, no tiles.
const UiGeoMap = preloadable(() => import("@/components/ui-blocks/map/geo-map").then((m) => m.default));
const UiFlow = preloadable(() => import("@/components/ui-blocks/flow/flow").then((m) => m.default));
const UiDataTable = preloadable(() => import("@/components/ui-blocks/data-table").then((m) => m.default));
const UiDiagram = preloadable(() => import("@/components/ui-blocks/diagram").then((m) => m.default));
const UiSql = preloadable(() => import("@/components/ui-blocks/sql").then((m) => m.default));
const UiDiffReview = preloadable(() => import("@/components/ui-blocks/diff-review").then((m) => m.default));
// Command output views share one chunk, loaded the first time an agent shows one.
const cliViews = () => import("@/components/ui-blocks/cli/views");
const TestsView = preloadable(() => cliViews().then((m) => m.TestsView));
const FileTreeView = preloadable(() => cliViews().then((m) => m.FileTreeView));
const JsonView = preloadable(() => cliViews().then((m) => m.JsonView));
const TextFileView = preloadable(() => cliViews().then((m) => m.TextFileView));
const WordCountView = preloadable(() => cliViews().then((m) => m.WordCountView));
const GitGraphView = preloadable(() => cliViews().then((m) => m.GitGraphView));
const GitStatusView = preloadable(() => cliViews().then((m) => m.GitStatusView));
const DiffStatView = preloadable(() => cliViews().then((m) => m.DiffStatView));
// Diffs: the `diff` and `patch` blocks, and edit tool calls.
const diffBlocks = () => import("@/components/ui-blocks/diff-blocks");
const TextDiffBlock = preloadable(() => diffBlocks().then((m) => m.TextDiffBlock));
const PatchBlock = preloadable(() => diffBlocks().then((m) => m.PatchBlock));
const BLOCKS = [UiChart, UiMap, UiGeoMap, UiFlow, UiDataTable, UiDiagram, UiSql, TestsView, TextDiffBlock, UiDiffReview];

let preloading = false;
/** After the first agent UI: fetch every block's code while the app is idle. */
function preloadUiBlocks() {
  if (preloading) return;
  preloading = true;
  whenIdle(() => void preloadAll(BLOCKS));
}

function Lazy({ height, children }: { height: number; children: ReactNode }) {
  return <Suspense fallback={<div className="animate-pulse rounded-md bg-muted" style={{ height }} />}>{children}</Suspense>;
}

// ── reading props ───────────────────────────────────────────────────────────

/** `map[key]` for a string key the map really has (not `constructor` and friends). */
function pick<T>(map: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** A positive number, else undefined (a missing or zero height means "default"). */
function positive(v: unknown): number | undefined {
  const n = asNumber(v);
  return n && n > 0 ? n : undefined;
}

/** `p.text` as text, keeping "absent" apart from "empty". */
const textOrUndefined = (v: unknown) => (v == null ? undefined : show(v));

const VARIANTS = ["default", "secondary", "destructive", "outline", "ghost", "link"] as const;
type Variant = (typeof VARIANTS)[number];
const variant = (v: unknown, fallback: Variant): Variant => ((VARIANTS as readonly unknown[]).includes(v) ? (v as Variant) : fallback);

// ── tree ────────────────────────────────────────────────────────────────────

/** An agent UI tree with its props. `form` connects its forms to the transcript entry. */
export function UiTree({ tree, props, form }: { tree: unknown; props: unknown; form?: FormHost }) {
  useEffect(preloadUiBlocks, []);
  const { expanded } = useUiView();
  return (
    <UiErrorBoundary tree={tree}>
      <FormHostContext.Provider value={form}>
        <div data-expanded={expanded || undefined} className={cn("flex flex-col gap-3 text-sm", expanded && ["h-full min-h-0", FILL_PATH])}>
          <UiNode node={tree} scope={asObj(props)} />
        </div>
      </FormHostContext.Provider>
    </UiErrorBoundary>
  );
}

/**
 * Expanded, the containers around the growing region (`[data-grow]`: a block's main scroll area, or a
 * node marked `"grow": true`) pass the dialog's height down to it: each takes the space left and may
 * shrink. Containers without one stay at their natural size, top-aligned.
 */
const FILL_PATH = "[&_*:has([data-grow])]:min-h-0 [&_*:has([data-grow=fill])]:flex-1";

/** A node marked `"grow": true`: expanded, it takes the dialog's height left and scrolls inside itself. */
function Grow({ children }: { children: ReactNode }) {
  const { expanded } = useUiView();
  if (!expanded) return children;
  return (
    <div {...growAttr(true)} className={cn("flex flex-col gap-3 *:shrink-0", growClass(true, ""))}>
      {children}
    </div>
  );
}

function Children({ nodes, scope }: { nodes: unknown; scope: Scope }) {
  return (
    <>
      {asArray(nodes).map((n, i) => (
        <UiNode key={i} node={n} scope={scope} />
      ))}
    </>
  );
}

function UiNode({ node, scope }: { node: unknown; scope: Scope }): ReactNode {
  const body = <UiNodeBody node={node} scope={scope} />;
  return isObj(node) && node.grow === true ? <Grow>{body}</Grow> : body;
}

function UiNodeBody({ node, scope }: { node: unknown; scope: Scope }): ReactNode {
  if (typeof node === "string") return <span className="whitespace-pre-wrap">{show(resolve(node, scope))}</span>;
  if (!isObj(node)) return null;
  if ("each" in node)
    return (
      <>
        {eachScopes(node, scope).map((e) => (
          <Children key={e.key} nodes={node.children} scope={e.scope} />
        ))}
      </>
    );
  if ("if" in node) return <Children nodes={branch(node, scope)} scope={scope} />;
  // A library component sees only its own props.
  if (node.type === "$component") return <UiNode node={node.tree} scope={resolveProps(node.props, scope)} />;
  return <Primitive node={node} p={resolveProps(node.props, scope)} scope={scope} />;
}

const GAP: Record<string, string> = { none: "gap-0", sm: "gap-2", md: "gap-3", lg: "gap-5" };
const ALIGN: Record<string, string> = { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch" };
const JUSTIFY: Record<string, string> = { start: "justify-start", center: "justify-center", end: "justify-end", between: "justify-between" };
const TONE: Record<string, string> = {
  default: "",
  info: "",
  muted: "text-muted-foreground",
  success: "text-green-700 dark:text-green-400",
  warning: "text-amber-700 dark:text-amber-400",
  danger: "text-destructive",
};
const TEXT_SIZE: Record<string, string> = { xs: "text-xs", sm: "text-sm", md: "text-base", lg: "text-lg" };
const WEIGHT: Record<string, string> = { medium: "font-medium", semibold: "font-semibold" };
const TREND: Record<string, ReactNode> = {
  up: <ArrowUpRight className="size-3" />,
  down: <ArrowDownRight className="size-3" />,
  flat: <ArrowRight className="size-3" />,
};

/** A block's `find`: a search the agent filled in, to show where something is. */
const find = (p: Obj) => optText(p.find);

function Primitive({ node, p, scope }: { node: Obj; p: Obj; scope: Scope }): ReactNode {
  const { expanded } = useUiView();
  const kids = <Children nodes={node.children} scope={scope} />;
  const type = show(node.type);
  switch (type) {
    case "stack":
      return (
        <div
          className={cn(
            "flex",
            p.direction === "row" ? "flex-row" : "flex-col",
            pick(GAP, p.gap) ?? GAP.md,
            !!p.wrap && "flex-wrap",
            pick(ALIGN, p.align),
            pick(JUSTIFY, p.justify),
          )}
        >
          {kids}
        </div>
      );
    case "grid": {
      const cols = Math.min(6, Math.max(1, asNumber(p.columns) || 2));
      return (
        // Exactly `columns` columns, so cells line up row by row.
        <div className={cn("grid", pick(GAP, p.gap) ?? GAP.md)} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {kids}
        </div>
      );
    }
    case "card": {
      const title = optText(p.title);
      const description = optText(p.description);
      return (
        <Card size="sm" className="min-w-0">
          {(title || description) && (
            <CardHeader>
              {title && <CardTitle>{title}</CardTitle>}
              {description && <CardDescription>{description}</CardDescription>}
            </CardHeader>
          )}
          <CardContent className="flex flex-col gap-2">{kids}</CardContent>
        </Card>
      );
    }
    case "heading": {
      const level = Math.min(3, Math.max(1, asNumber(p.level) || 2));
      return (
        <div role="heading" aria-level={level} className={cn("font-semibold", ["text-lg", "text-base", "text-sm"][level - 1])}>
          {show(p.text)}
        </div>
      );
    }
    case "text":
      return (
        <p className={cn("whitespace-pre-wrap", pick(TONE, p.tone), pick(TEXT_SIZE, p.size), pick(WEIGHT, p.weight), !!p.mono && "font-mono")}>
          {show(p.text)}
        </p>
      );
    case "markdown":
      return <Markdown>{show(p.text)}</Markdown>;
    case "code":
      return <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-code whitespace-pre">{show(p.text)}</pre>;
    case "badge":
      return (
        <Badge variant={variant(p.variant, "secondary")} className="self-start">
          {show(p.text)}
        </Badge>
      );
    case "stat": {
      const trend = pick(TREND, p.trend);
      const delta = optText(p.delta);
      const hint = optText(p.hint);
      return (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{show(p.label)}</span>
          <span className="text-2xl font-semibold tabular-nums">{show(p.value)}</span>
          {(delta || hint) && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {trend}
              {delta} {hint && <span>{hint}</span>}
            </span>
          )}
        </div>
      );
    }
    case "progress": {
      const max = asNumber(p.max) || 100;
      const pct = Math.max(0, Math.min(100, ((asNumber(p.value) ?? 0) / max) * 100));
      const label = optText(p.label);
      return (
        <div className="flex flex-col gap-1">
          {label && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{label}</span>
              <span className="tabular-nums">{Math.round(pct)}%</span>
            </div>
          )}
          <Progress value={pct} aria-label={label ?? "Progress"} />
        </div>
      );
    }
    case "alert": {
      const title = optText(p.title);
      return (
        <Alert variant={p.tone === "danger" ? "destructive" : "default"} className={pick(TONE, p.tone)}>
          {title && <AlertTitle>{title}</AlertTitle>}
          <AlertDescription>{show(p.text)}</AlertDescription>
        </Alert>
      );
    }
    case "form":
      return (
        <UiForm submitLabel={optText(p.submitLabel)} description={optText(p.description)} required={requiredFields(node)}>
          {kids}
        </UiForm>
      );
    case "textfield":
      return (
        <UiTextfield
          name={show(p.name)}
          label={show(p.label)}
          placeholder={optText(p.placeholder)}
          initial={textOrUndefined(p.default)}
          multiline={!!p.multiline}
        />
      );
    case "choice":
      return (
        <UiChoice
          name={show(p.name)}
          label={show(p.label)}
          options={p.options}
          multiple={!!p.multiple}
          initial={p.default}
          correct={p.correct}
          explanation={optText(p.explanation)}
        />
      );
    case "select":
      return <UiSelect name={show(p.name)} label={show(p.label)} options={p.options} initial={textOrUndefined(p.default)} />;
    case "slider":
      return (
        <UiSlider
          name={show(p.name)}
          label={show(p.label)}
          min={asNumber(p.min)}
          max={asNumber(p.max)}
          step={asNumber(p.step)}
          initial={asNumber(p.default)}
          unit={optText(p.unit)}
        />
      );
    case "rank":
      return <UiRank name={show(p.name)} label={show(p.label)} items={p.items} />;
    case "toggle":
      return (
        <UiToggle
          name={show(p.name)}
          label={show(p.label)}
          description={optText(p.description)}
          initial={p.default == null ? undefined : p.default === true || p.default === "true"}
        />
      );
    case "table":
      return (
        <Lazy height={160}>
          <UiDataTable columns={p.columns} rows={p.rows} empty={optText(p.empty)} find={find(p)} />
        </Lazy>
      );
    case "chart":
      return (
        <Lazy height={positive(p.height) ?? 240}>
          <UiChart
            kind={p.kind}
            data={p.data}
            x={show(p.x)}
            series={p.series}
            stacked={!!p.stacked}
            unit={optText(p.unit)}
            height={positive(p.height)}
            refs={p.refs}
            orientation={p.orientation}
            labels={p.labels}
            sort={p.sort}
            scale={p.scale}
            zero={p.zero}
            domain={p.domain}
          />
        </Lazy>
      );
    case "map":
      return p.kind === "outline" || p.kind === "choropleth" || p.kind === "bubble" || p.kind === "connection" || p.kind === "hexbin" ? (
        <Lazy height={positive(p.height) ?? 360}>
          <UiGeoMap props={p} />
        </Lazy>
      ) : (
        <Lazy height={positive(p.height) ?? 320}>
          <UiMap markers={p.markers} center={p.center} zoom={p.zoom} height={positive(p.height)} lines={p.lines} cluster={p.cluster} />
        </Lazy>
      );
    case "flow":
      return (
        <Lazy height={positive(p.height) ?? 320}>
          <UiFlow props={p} />
        </Lazy>
      );
    case "diagram":
      return (
        <Lazy height={160}>
          <UiDiagram text={show(p.text)} />
        </Lazy>
      );
    case "live":
      return <LiveSource source={p.source} every={p.every} history={p.history} as={p.as} nodes={node.children} scope={scope} />;
    case "sql":
      return (
        <Lazy height={140}>
          <UiSql connection={optText(p.connection)} sql={show(p.sql)} limit={asNumber(p.limit)} title={optText(p.title)} />
        </Lazy>
      );
    case "tests":
      return <TestsView text={textOrUndefined(p.text)} results={p.results} title={optText(p.title)} find={find(p)} />;
    case "filetree":
      return <FileTreeView text={textOrUndefined(p.text)} paths={p.paths} open={asNumber(p.open)} find={find(p)} />;
    case "json":
      return <JsonView text={textOrUndefined(p.text)} value={p.value} open={asNumber(p.open)} find={find(p)} />;
    case "textfile":
      return (
        <TextFileView
          text={show(p.text)}
          path={optText(p.path)}
          start={asNumber(p.start) || 1}
          highlight={p.highlight}
          follow={!!p.follow}
          find={find(p)}
        />
      );
    case "wordcount":
      return <WordCountView text={show(p.text)} columns={p.columns} />;
    case "gitgraph":
      return <GitGraphView text={show(p.text)} />;
    case "gitstatus":
      return <GitStatusView text={show(p.text)} />;
    case "diffstat":
      return <DiffStatView text={show(p.text)} />;
    case "timer":
      return <Timer until={p.until} since={p.since} label={optText(p.label)} done={optText(p.done)} />;
    case "kv":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {asArray(p.items).map((raw, i) => {
            const it = asObj(raw);
            return (
              <div key={i} className="contents">
                <dt className="text-muted-foreground">{show(it.label)}</dt>
                <dd className="min-w-0 break-words tabular-nums">{show(it.value)}</dd>
              </div>
            );
          })}
        </dl>
      );
    case "list": {
      const L = p.ordered ? "ol" : "ul";
      return (
        <L className={cn("flex flex-col gap-0.5 pl-5", p.ordered ? "list-decimal" : "list-disc")}>
          {asArray(p.items).map((it, i) => (
            <li key={i}>{show(it)}</li>
          ))}
        </L>
      );
    }
    case "separator":
      return <Separator />;
    case "diff":
      return <TextDiff path={show(p.path)} oldText={show(p.oldText)} newText={show(p.newText)} />;
    case "link":
      return (
        <button
          type="button"
          className="inline-flex items-center gap-1 self-start underline underline-offset-2 disabled:no-underline disabled:opacity-60"
          disabled={!isWebUrl(p.href)}
          title={show(p.href)}
          onClick={() => openExternal(p.href)}
        >
          {show(p.text)} <ExternalLink className="size-3" />
        </button>
      );
    case "button":
      return <UiButton p={p} />;
    case "collapsible":
      return (
        <UiCollapsible title={show(p.title)} open={!!p.open}>
          {kids}
        </UiCollapsible>
      );
    case "tabs": {
      const tabs = collectTabs(asArray(node.children), scope);
      if (tabs.length === 0) return null;
      return (
        <Tabs defaultValue="0">
          <TabsList>
            {tabs.map(({ tab, scope: s }, i) => (
              <TabsTrigger key={i} value={String(i)}>
                {show(resolve(asObj(tab.props).label, s))}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map(({ tab, scope: s }, i) => (
            <TabsContent key={i} value={String(i)} className="flex flex-col gap-3">
              <Children nodes={tab.children} scope={s} />
            </TabsContent>
          ))}
        </Tabs>
      );
    }
    case "tab":
      return <div className="flex flex-col gap-3">{kids}</div>;
    case "image": {
      const src = show(p.src);
      const alt = show(p.alt);
      // Natural size (capped by the column), never stretched up; tall captures scroll.
      if (src.startsWith("data:image/"))
        return (
          <div className={cn("self-start overflow-auto rounded-md border", inlineMax(expanded, "max-h-[40rem]"))}>
            <img src={src} alt={alt} width={positive(p.width)} loading="lazy" className="block h-auto max-w-full" />
          </div>
        );
      // Remote images wait for a click, as in Markdown: nothing is fetched just by showing the UI.
      if (isWebUrl(src))
        return <SafeImage src={src} alt={alt} width={positive(p.width)} className="block h-auto max-w-full self-start rounded-md border" />;
      return <span className="text-xs text-muted-foreground">[image not available: {src.slice(0, 60)}]</span>;
    }
    case "browser":
      return <BrowserFrame src={show(p.src)} title={optText(p.title)} height={positive(p.height) ?? 420} />;
    case "patch":
      return <PatchView text={show(p.text)} title={optText(p.title)} />;
    case "diffreview":
      return (
        <Lazy height={240}>
          <UiDiffReview
            text={show(p.text)}
            files={p.files}
            title={optText(p.title)}
            range={optText(p.range)}
            truncated={p.truncated === true}
            name={optText(p.name)}
          />
        </Lazy>
      );
    default:
      return <span className="text-xs text-destructive">[unknown UI type “{type}”]</span>;
  }
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * `draft` puts text in the composer; `prompt` sends it as the next message; `href` opens a web page.
 * A `prompt` that isn't just the label asks first, showing the exact text: the
 * library is shared across chats, so a button labelled "Details" could
 * otherwise send anything as the user's message.
 */
function UiButton({ p }: { p: Obj }) {
  const chat = useChat();
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const confirmId = useId();
  const draft = optText(p.draft);
  const prompt = optText(p.prompt);
  const href = show(p.href);
  const label = show(p.label);
  const asks = !draft && !!prompt && !sameText(prompt, label);
  const canSend = !!chat && !chat.busy;
  const send = (text: string) => {
    if (!chat) return;
    setError(null);
    api.sendPrompt(chat.sessionId, text).catch(setError);
  };
  const cancel = () => {
    setConfirming(false);
    trigger.current?.focus();
  };
  const confirm = () => {
    if (!prompt || !canSend) return;
    setConfirming(false);
    send(prompt);
  };
  const click = () => {
    if (draft) draftIntoComposer({ text: draft }, chat?.pane);
    else if (asks) setConfirming((c) => !c);
    else if (prompt) send(prompt);
    else openExternal(href);
  };
  return (
    <div className="flex flex-col gap-1 self-start">
      <Button
        ref={trigger}
        size="sm"
        className="self-start"
        variant={variant(p.variant, "default")}
        disabled={draft ? false : prompt ? !canSend : !isWebUrl(href)}
        title={
          draft ? "Puts this in your message box to edit" : asks ? "Shows the message it sends before sending" : prompt ? `Sends: ${prompt}` : href
        }
        aria-expanded={asks ? confirming : undefined}
        aria-controls={asks && confirming ? confirmId : undefined}
        onClick={click}
      >
        {label}
      </Button>
      {asks && confirming && (
        <div
          id={confirmId}
          role="group"
          aria-label="Send this message?"
          className="flex max-w-md flex-col gap-2 rounded-md border bg-muted/40 p-2 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement && e.target.dataset.action === "cancel")) {
              e.preventDefault();
              confirm();
            }
          }}
        >
          <span className="text-muted-foreground">Sends this as your message:</span>
          <p className="max-h-40 overflow-auto rounded-sm bg-background px-2 py-1 font-mono break-words whitespace-pre-wrap">{prompt}</p>
          <div className="flex gap-2">
            <Button size="xs" autoFocus disabled={!canSend} onClick={confirm}>
              Send
            </Button>
            <Button size="xs" variant="ghost" data-action="cancel" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function UiCollapsible({ title, open, children }: { title: string; open: boolean; children: ReactNode }) {
  const [isOpen, setOpen] = useState(open);
  // The agent can open or close it later by re-rendering with a new `open`.
  const [agentOpen, setAgentOpen] = useState(open);
  if (agentOpen !== open) {
    setAgentOpen(open);
    setOpen(open);
  }
  return (
    <Collapsible open={isOpen} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium">
        <ChevronRight className={cn("size-4 transition-transform", isOpen && "rotate-90")} /> {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-3 pl-5">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Hosts a frame must never load: the app itself and Tauri's IPC endpoint. */
const APP_HOSTS = new Set(["tauri.localhost", "ipc.localhost"]);

function frameable(src: string): boolean {
  if (!isWebUrl(src)) return false;
  const url = new URL(src);
  return url.origin !== window.location.origin && !APP_HOSTS.has(url.hostname);
}

/**
 * yaah's own preview server: `http://127.0.0.1:<port>/preview/<hex id>/…`,
 * serving a local file the agent rendered (see `preview_url` in ui_mcp.rs).
 * Checked on the parsed URL, so `..` segments and userinfo can't fake it.
 */
function isLocalPreview(src: string): boolean {
  if (!isWebUrl(src)) return false;
  const url = new URL(src);
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" && /^\/preview\/[0-9a-f]+\//.test(url.pathname);
}

/** The scheme and host of a URL, for showing where a page would load from. */
const originOf = (src: string) => (isWebUrl(src) ? new URL(src).origin : src);

/**
 * A live page in a browser-style frame. Only http(s) pages load: local pages
 * are served by yaah on 127.0.0.1 (a different origin from the app), so the
 * page gets its own storage but no way into the app. `allow-same-origin`
 * with `allow-scripts` is only safe because the frame is never the app's own
 * origin; no `allow-top-navigation` and no `allow-popups`, so it can't
 * navigate the app or open windows ("Open in browser" does that).
 *
 * Any page other than yaah's own preview waits for a click: an agent could put
 * a secret in the URL, and framing it on render would send it with no one
 * looking. The click covers this exact URL for as long as this entry is on
 * screen; a new `src` from the agent asks again.
 */
function BrowserFrame({ src, title, height }: { src: string; title?: string; height: number }) {
  const [reloads, setReloads] = useState(0);
  const [allowed, setAllowed] = useState<string | null>(null);
  const ok = frameable(src);
  const preview = ok && isLocalPreview(src);
  const loaded = ok && (preview || allowed === src);
  const shown = preview ? src.replace(/^https?:\/\/127\.0\.0\.1:\d+\/preview\/[0-9a-f]+\//, "local · ") : src;
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-1.5">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-red-400/70" />
          <span className="size-2.5 rounded-full bg-amber-400/70" />
          <span className="size-2.5 rounded-full bg-green-400/70" />
        </span>
        <span
          className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-0.5 text-center font-mono text-xs text-muted-foreground"
          title={src}
        >
          {title ? `${title} — ${shown}` : shown}
        </span>
        <Button variant="ghost" size="icon-xs" title="Reload" aria-label="Reload" disabled={!loaded} onClick={() => setReloads((n) => n + 1)}>
          <RotateCw />
        </Button>
        <Button variant="ghost" size="icon-xs" title="Open in browser" aria-label="Open in browser" disabled={!ok} onClick={() => openExternal(src)}>
          <ExternalLink />
        </Button>
      </div>
      {loaded ? (
        <iframe
          key={reloads}
          src={src}
          title={title ?? "Page preview"}
          style={{ height }}
          className="block w-full bg-white"
          sandbox="allow-scripts allow-forms allow-modals allow-same-origin"
          referrerPolicy="no-referrer"
          allow="clipboard-write"
        />
      ) : ok ? (
        <div className="flex flex-col items-start gap-2 p-4 text-sm">
          <p className="text-muted-foreground">
            This page loads from <span className="font-medium text-foreground">{originOf(src)}</span>. Nothing is fetched until you load it.
          </p>
          <code className="max-h-24 w-full overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">{src}</code>
          <Button size="sm" variant="outline" aria-label={`Load page from ${originOf(src)}`} onClick={() => setAllowed(src)}>
            Load page
          </Button>
        </div>
      ) : (
        <p className="p-4 text-xs text-muted-foreground">Can't preview “{src.slice(0, 80)}”.</p>
      )}
    </div>
  );
}

/** A diff of two texts (an edit tool call, or a `diff` node). */
export function TextDiff(props: { path: string; oldText: string; newText: string }) {
  return (
    <Lazy height={80}>
      <TextDiffBlock {...props} />
    </Lazy>
  );
}

/** `git diff` text in yaah's diff view (the `patch` block, and diffs a command printed). */
export function PatchView(props: { text: string; title?: string }) {
  return (
    <Lazy height={80}>
      <PatchBlock {...props} />
    </Lazy>
  );
}

/** One broken node shows an error instead of blanking the chat; a new tree from the agent tries again. */
class UiErrorBoundary extends Component<{ tree: unknown; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? "unknown error" };
  }
  componentDidUpdate(prev: { tree: unknown }) {
    if (this.state.error != null && prev.tree !== this.props.tree) this.setState({ error: null });
  }
  render() {
    return this.state.error != null ? <ErrorText error={this.state.error} prefix="This UI failed to render: " /> : this.props.children;
  }
}

/** Epoch ms from an ISO string, epoch number (s or ms) or numeric string. */
function toMillis(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = asNumber(v);
  if (n != null) return n < 1e12 ? n * 1000 : n;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
}

/** Ticks once a second in the app; the agent doesn't need to re-render it. */
function Timer({ until, since, label, done }: { until?: unknown; since?: unknown; label?: string; done?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const to = toMillis(until);
  const from = toMillis(since);
  let text = "—";
  let urgent = false;
  let overdue = false;
  if (to != null) {
    const left = to - now;
    // A label already says what this is ("next run in"); only add "in" without one.
    // Past the deadline it says so and keeps counting (an SLA breached 12m ago).
    text = left <= 0 ? (done ?? `overdue ${formatDuration(-left)}`) : label ? formatDuration(left) : `in ${formatDuration(left)}`;
    urgent = left > 0 && left < 60_000;
    overdue = left <= 0;
  } else if (from != null) {
    text = formatDuration(now - from);
  }
  const at = new Date(to ?? from ?? now);
  return (
    <span className="inline-flex items-baseline gap-1.5 text-sm">
      {label && <span className="text-muted-foreground">{label}</span>}
      <time
        dateTime={at.toISOString()}
        title={at.toLocaleString()}
        className={cn("font-mono tabular-nums", urgent && "text-amber-700 dark:text-amber-400", overdue && "text-destructive")}
      >
        {text}
      </time>
    </span>
  );
}

// ── live sources ────────────────────────────────────────────────────────────

const clock = (d: Date) => d.toTimeString().slice(0, 8);

/** The numbers in one reading, for `history`: top-level numeric fields, and
 *  for a list of named items (docker.stats) each item's as `<name>_<field>`. */
function sample(data: unknown, at: Date): Obj {
  const out: Obj = { t: clock(at) };
  if (Array.isArray(data)) {
    for (const item of data as unknown[]) {
      if (!isObj(item) || typeof item.name !== "string") continue;
      for (const [k, v] of Object.entries(item)) if (typeof v === "number") out[`${item.name}_${k}`] = v;
    }
  } else if (isObj(data)) {
    for (const [k, v] of Object.entries(data)) if (typeof v === "number") out[k] = v;
  }
  return out;
}

type Reading = { data: unknown; at: Date | null; error: unknown; samples: Obj[]; reading: boolean };

/** Feeds its children data the app reads itself, on an interval, with no agent turn. */
function LiveSource({
  source,
  every,
  history,
  as,
  nodes,
  scope,
}: {
  source: unknown;
  every: unknown;
  history: unknown;
  as: unknown;
  nodes: unknown;
  scope: Scope;
}) {
  const key = JSON.stringify(source ?? null);
  // Git sources read the folder of the chat this UI is in.
  const session = useChat()?.sessionId;
  const interval = every == null ? 0 : Math.max(1000, asNumber(every) ?? 0);
  const keep = Math.min(600, Math.max(0, asNumber(history) ?? 0));
  const [state, setState] = useState<Reading>({ data: undefined, at: null, error: null, samples: [], reading: true });
  const [paused, setPaused] = useState(false);
  const [nonce, setNonce] = useState(0);
  const seen = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  // Scrolled out of view: stop polling (each read is real work in Rust: sysinfo, docker, an API or a query).
  // Back in view, the effect runs again and reads at once, so the data is never stale on screen.
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setOnScreen(entries.some((e) => e.isIntersecting)), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Off screen after a first reading: wait until it scrolls back.
    if (!onScreen && seen.current) return;
    const next = (ms: number) => {
      if (!stop) timer = setTimeout(() => void read(), ms);
    };
    async function read() {
      // Don't poll for a window nobody is looking at.
      if (document.hidden && seen.current) return interval && !paused ? next(interval) : undefined;
      setState((s) => ({ ...s, reading: true }));
      try {
        const data = await api.readSource(JSON.parse(key), session);
        if (stop) return;
        const at = new Date();
        seen.current = true;
        setState((s) => ({ data, at, error: null, reading: false, samples: keep ? [...s.samples, sample(data, at)].slice(-keep) : [] }));
      } catch (e) {
        if (!stop) setState((s) => ({ ...s, error: e, at: new Date(), reading: false }));
      }
      if (interval && !paused) next(interval);
    }
    // The first read is scheduled rather than run inline, so the effect never sets state synchronously.
    next(0);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [key, session, interval, keep, paused, nonce, onScreen]);

  const name = typeof as === "string" && as ? as : "data";
  // Expanded, what it feeds fills the dialog (a diff review grows to its height).
  const { expanded } = useUiView();
  return (
    <div ref={box} className={cn("flex flex-col gap-2", expanded && "min-h-0 flex-1")}>
      {state.data === undefined && state.error == null ? (
        <div className="h-24 animate-pulse rounded-md bg-muted" />
      ) : (
        state.data !== undefined && <Children nodes={nodes} scope={{ ...scope, [name]: state.data, history: state.samples }} />
      )}
      {state.error != null && <ErrorText error={state.error} prefix="Couldn’t read: " />}
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span
          className={cn(
            "size-1.5 rounded-full",
            state.error != null ? "bg-destructive" : interval && !paused ? "bg-green-600 dark:bg-green-500" : "bg-muted-foreground/40",
            state.reading && "animate-pulse",
          )}
        />
        <span>
          {state.at ? `updated ${clock(state.at)}` : "reading…"}
          {interval > 0 &&
            (paused ? " · paused" : ` · every ${interval >= 60000 ? `${Math.round(interval / 60000)}m` : `${Math.round(interval / 1000)}s`}`)}
        </span>
        {interval > 0 && (
          <button type="button" className="underline-offset-2 hover:underline" onClick={() => setPaused(!paused)}>
            {paused ? "resume" : "pause"}
          </button>
        )}
        <button type="button" title="Refresh now" aria-label="Refresh now" className="hover:text-foreground" onClick={() => setNonce((n) => n + 1)}>
          <RotateCw className={cn("size-3", state.reading && "animate-spin")} />
        </button>
      </div>
    </div>
  );
}
