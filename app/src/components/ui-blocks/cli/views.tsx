// Views for command output: tests, tree, json, cat, wc, git log/status/--stat.
// Each takes what the command printed and shows it for what it is.
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Copy,
  File,
  Folder,
  FolderOpen,
  GitBranch,
  Search,
  Tag,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/markdown";
import { useFind } from "@/components/ui-blocks/find";
import { growAttr, growClass, useUiView } from "@/components/ui-view";
import { formatBytes, formatDuration, plural } from "@/lib/format";
import { fuzzyScore } from "@/lib/fuzzy";
import { asArray, asNumber, isObj, optArray, optText, show } from "@/lib/narrow";
import { cn } from "@/lib/utils";
import {
  countFiles,
  parseDiffStat,
  parseGitLog,
  parseGitStatus,
  parseJsonDocs,
  parseTests,
  parseTree,
  parseWc,
  treeFromPaths,
  type FileNode,
  type GitFile,
  type GitRef,
  type GitRow,
  type TestCase,
  type TestRun,
  type TestStatus,
} from "./parse";

const UiDataTable = lazy(() => import("@/components/ui-blocks/data-table"));

const GOOD = "text-green-700 dark:text-green-400";
const BAD = "text-destructive";
const WARN = "text-amber-700 dark:text-amber-400";
const fmt = new Intl.NumberFormat();
/** Keep the end of a long path, where the file name is. */
const tail = (p: string, n = 40) => (p.length > n ? "…" + p.slice(p.length - n + 1) : p);

function Section({
  title,
  count,
  tone,
  open: initial,
  children,
}: {
  title: string;
  count: number;
  tone?: string;
  open: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <span className={tone}>{fmt.format(count)}</span> {title}
      </button>
      {open && <div className="flex flex-col pl-5">{children}</div>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  function copy() {
    navigator.clipboard.writeText(text).then(
      () => setState("copied"),
      () => setState("failed"),
    );
    setTimeout(() => setState("idle"), 1500);
  }
  const label = state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : "Copy";
  return (
    <Button variant="ghost" size="icon-xs" title={label} aria-label={label} onClick={copy}>
      {state === "copied" ? <Check /> : state === "failed" ? <X /> : <Copy />}
    </Button>
  );
}

/** The search box of a view: icon and input, labelled by its placeholder. Enter (⇧Enter) can step through matches. */
function SearchInput({
  value,
  onChange,
  label,
  onEnter,
}: {
  value: string;
  onChange: (q: string) => void;
  label: string;
  onEnter?: (back: boolean) => void;
}) {
  return (
    <>
      <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!onEnter || e.key !== "Enter") return;
          e.preventDefault();
          onEnter(e.shiftKey);
        }}
        placeholder={label}
        aria-label={label}
        className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none"
      />
    </>
  );
}

/** A scroll box that brings its first `[data-hit]` row into view (inside the box, not the whole chat) when the matches change. */
function useScrollToHit(hits: unknown) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>("[data-hit]");
    if (box.current && el) box.current.scrollTop = Math.max(0, el.offsetTop - box.current.offsetTop - 48);
  }, [hits]);
  return box;
}

// ── tests ───────────────────────────────────────────────────────────────────

/** "a::b::name" → muted "a::b::" and the name. */
function TestName({ t }: { t: TestCase }) {
  const cut = t.name.lastIndexOf("::");
  return (
    <span className="min-w-0 truncate font-mono text-xs" title={t.name}>
      {t.file && <span className="text-muted-foreground">{t.file} › </span>}
      {cut > 0 && <span className="text-muted-foreground">{t.name.slice(0, cut + 2)}</span>}
      {cut > 0 ? t.name.slice(cut + 2) : t.name}
    </span>
  );
}

/** Test times are short: `<1ms`, `35ms`, `1.2s`, `14s`, then `2m 05s`. */
function ms(n?: number) {
  if (n == null) return "";
  if (n >= 60_000) return formatDuration(n);
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}s` : n >= 1 ? `${Math.round(n)}ms` : "<1ms";
}

const isStatus = (v: unknown): v is TestStatus => v === "pass" || v === "fail" || v === "skip";

/** Results the agent passed as data: `{ name, status, file?, duration?, message? }`; an unknown status counts as a failure. */
function toTests(raw: unknown[]): TestRun {
  return {
    tests: raw.filter(isObj).map((r) => ({
      name: show(r.name),
      status: isStatus(r.status) ? r.status : "fail",
      file: optText(r.file),
      duration: asNumber(r.duration),
      message: optText(r.message),
    })),
  };
}

export function TestsView({ text, results, title, find }: { text?: string; results?: unknown; title?: string; find?: string }) {
  const run = useMemo(() => {
    const list = optArray(results);
    return list ? toTests(list) : parseTests(text ?? "");
  }, [text, results]);
  const [filter, setFilter] = useFind(find);
  const listed = { pass: 0, fail: 0, skip: 0 };
  for (const t of run.tests) listed[t.status]++;
  // The summary line wins when the runner listed fewer tests than it ran (pytest without -v, mix without --trace).
  const counts = run.summary && run.summary.pass + run.summary.fail + run.summary.skip >= run.tests.length ? run.summary : listed;
  const total = counts.pass + counts.fail + counts.skip;
  const match = (t: TestCase) => !filter.trim() || fuzzyScore(filter, `${t.file ?? ""} ${t.name}`) > 0;
  const of = (s: TestStatus) => run.tests.filter((t) => t.status === s && match(t));
  const failed = of("fail");
  const passed = of("pass");
  const skipped = of("skip");

  if (total === 0)
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">No test results found in this output.</span>
        {text && <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-code">{text}</pre>}
      </div>
    );

  const Icon = counts.fail ? CircleX : CircleCheck;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon className={cn("size-5 shrink-0", counts.fail ? BAD : GOOD)} />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 text-sm">
          {title && <span className="font-medium">{title}</span>}
          {counts.fail > 0 && <span className={cn("font-medium", BAD)}>{fmt.format(counts.fail)} failed</span>}
          <span className={GOOD}>{fmt.format(counts.pass)} passed</span>
          {counts.skip > 0 && <span className="text-muted-foreground">{fmt.format(counts.skip)} skipped</span>}
        </div>
        {run.durationMs != null && <span className="text-xs text-muted-foreground tabular-nums">{ms(run.durationMs)}</span>}
      </div>
      <div
        className="flex h-2 gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={`${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`}
      >
        {counts.fail > 0 && <div className="bg-destructive" style={{ flex: counts.fail }} />}
        {counts.pass > 0 && <div className="bg-green-600 dark:bg-green-500" style={{ flex: counts.pass }} />}
        {counts.skip > 0 && <div className="bg-muted-foreground/30" style={{ flex: counts.skip }} />}
      </div>
      {(run.tests.length > 30 || filter) && (
        <div className="flex items-center gap-1.5 rounded-md border px-2">
          <SearchInput value={filter} onChange={setFilter} label="Filter tests" />
        </div>
      )}
      {failed.map((t, i) => (
        <Failure key={t.name + i} t={t} open={i < 5} />
      ))}
      {counts.fail > listed.fail && <p className="text-xs text-muted-foreground">The output didn't list every failure.</p>}
      {passed.length > 0 && (
        <Section
          key={filter ? "found" : "all"}
          title="passed"
          count={passed.length}
          tone={GOOD}
          open={!!filter || (counts.fail === 0 && passed.length <= 12)}
        >
          <Rows tests={passed} />
        </Section>
      )}
      {counts.pass > listed.pass && listed.pass === 0 && (
        <p className="text-xs text-muted-foreground">Passing tests weren't listed in the output (run verbose to see them).</p>
      )}
      {skipped.length > 0 && (
        <Section key={filter ? "found" : "all"} title="skipped" count={skipped.length} open={!!filter}>
          <Rows tests={skipped} />
        </Section>
      )}
    </div>
  );
}

function Rows({ tests }: { tests: TestCase[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? tests : tests.slice(0, 200);
  return (
    <>
      {shown.map((t, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          {t.status === "pass" ? (
            <Check className={cn("size-3.5 shrink-0", GOOD)} />
          ) : (
            <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <TestName t={t} />
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{ms(t.duration)}</span>
        </div>
      ))}
      {!all && tests.length > 200 && (
        <button type="button" className="self-start py-1 text-xs text-muted-foreground underline" onClick={() => setAll(true)}>
          Show {fmt.format(tests.length - 200)} more
        </button>
      )}
    </>
  );
}

function Failure({ t, open: initial }: { t: TestCase; open: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="flex flex-col rounded-md border border-destructive/30 bg-destructive/5">
      <button
        type="button"
        aria-expanded={t.message ? open : undefined}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-2 py-1.5 text-left"
      >
        <CircleX className={cn("size-3.5 shrink-0", BAD)} />
        <TestName t={t} />
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{ms(t.duration)}</span>
        {t.message && <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
      </button>
      {open && t.message && (
        <pre className="mx-2 mb-2 max-h-72 overflow-auto rounded bg-background/70 p-2 font-mono text-code whitespace-pre-wrap">{t.message}</pre>
      )}
    </div>
  );
}

// ── tree ────────────────────────────────────────────────────────────────────

type TreeHits = { matches: Set<FileNode>; trail: Set<FileNode> };

/** Nodes matching the query (by name; by path when it has a "/"), and the folders leading to them. */
function searchTree(root: FileNode, query: string): TreeHits | null {
  const q = query.trim();
  if (!q) return null;
  const matches = new Set<FileNode>();
  const trail = new Set<FileNode>();
  const walk = (n: FileNode, path: string): boolean => {
    const full = n === root ? "" : path ? `${path}/${n.name}` : n.name;
    const self = n !== root && fuzzyScore(q, q.includes("/") ? full : n.name) > 0;
    let below = false;
    for (const c of n.children) if (walk(c, full)) below = true;
    if (self) matches.add(n);
    if (below) trail.add(n);
    return self || below;
  };
  walk(root, "");
  return { matches, trail };
}

export function FileTreeView({ text, paths, open, find }: { text?: string; paths?: unknown; open?: number; find?: string }) {
  const { root, summary } = useMemo(() => {
    const list = optArray(paths);
    return list ? { root: treeFromPaths(list.map(show)), summary: undefined } : parseTree(text ?? "");
  }, [text, paths]);
  const counts = useMemo(() => countFiles(root), [root]);
  const depth = open ?? (counts.files + counts.dirs <= 60 ? 99 : 2);
  const [key, setKey] = useState(0);
  const [allOpen, setAllOpen] = useState<boolean | null>(null);
  const [query, setQuery] = useFind(find);
  const hits = useMemo(() => searchTree(root, query), [root, query]);
  const { expanded } = useUiView();
  const box = useScrollToHit(hits);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{summary ?? `${plural(counts.dirs, "folder")}, ${plural(counts.files, "file")}`}</span>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="xs" onClick={() => (setAllOpen(true), setQuery(""), setKey((k) => k + 1))}>
            Expand all
          </Button>
          <Button variant="ghost" size="xs" onClick={() => (setAllOpen(false), setQuery(""), setKey((k) => k + 1))}>
            Collapse
          </Button>
        </span>
      </div>
      <div className="flex flex-col rounded-md border">
        {(counts.files > 15 || query) && (
          <div className="flex items-center gap-1.5 border-b px-2">
            <SearchInput value={query} onChange={setQuery} label="Find a file or folder" />
            {hits && <span className="text-xs text-muted-foreground">{plural(hits.matches.size, "match", "matches")}</span>}
          </div>
        )}
        <div
          ref={box}
          key={`${key}:${query}`}
          {...growAttr(expanded, false)}
          className={cn("overflow-auto py-1 font-mono text-code", growClass(expanded, "max-h-[480px]", false))}
        >
          {hits && hits.matches.size === 0 ? (
            <p className="px-3 py-2 font-sans text-muted-foreground">Nothing matches “{query}”.</p>
          ) : (
            <TreeRow
              node={root}
              level={0}
              openDepth={allOpen === true ? 99 : allOpen === false ? 1 : depth}
              hits={hits}
              query={query.includes("/") ? "" : query.trim()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TreeRow({
  node,
  level,
  openDepth,
  hits,
  query,
}: {
  node: FileNode;
  level: number;
  openDepth: number;
  hits: TreeHits | null;
  query: string;
}) {
  // While searching, only the way to the matches is open.
  const [open, setOpen] = useState(hits ? hits.trail.has(node) : level < openDepth);
  const sub = node.dir ? countFiles(node) : null;
  const Icon = node.dir ? (open ? FolderOpen : Folder) : File;
  const hit = !!hits?.matches.has(node);
  const kids = hits ? node.children.filter((c) => hits.matches.has(c) || hits.trail.has(c)) : node.children;
  const row = (
    <>
      <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", !node.dir && "invisible")} />
      <Icon className={cn("size-3.5 shrink-0", node.dir ? "text-[var(--chart-1)]" : "text-muted-foreground")} />
      <span className={cn("truncate", node.dir && "font-medium")}>{hit && query ? <Mark text={node.name} q={query} /> : node.name}</span>
      {sub && !open && sub.files > 0 && <span className="ml-auto shrink-0 text-2xs text-muted-foreground">{fmt.format(sub.files)}</span>}
    </>
  );
  const rowClass = cn("flex w-full items-center gap-1.5 py-[3px] pr-2 text-left", hit && "bg-amber-500/15");
  const indent = { paddingLeft: 8 + level * 16 };
  return (
    <>
      {/* Folders toggle; files are plain rows, not buttons that do nothing. */}
      {node.dir ? (
        <button
          type="button"
          aria-expanded={open}
          data-hit={hit || undefined}
          onClick={() => setOpen(!open)}
          className={cn(rowClass, "hover:bg-muted/60")}
          style={indent}
        >
          {row}
        </button>
      ) : (
        <div data-hit={hit || undefined} className={rowClass} style={indent}>
          {row}
        </div>
      )}
      {open &&
        (hits && hit && node.dir ? node.children : kids).map((c, i) => (
          <TreeRow key={i} node={c} level={level + 1} openDepth={openDepth} hits={hit && node.dir ? null : hits} query={query} />
        ))}
    </>
  );
}

// ── json ────────────────────────────────────────────────────────────────────

const STR = "text-emerald-700 dark:text-emerald-400";
const NUM = "text-sky-700 dark:text-sky-400";
const LIT = "text-violet-700 dark:text-violet-400";

function size(v: unknown): number {
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + size(x), 1);
  if (v && typeof v === "object") return Object.values(v).reduce<number>((n, x) => n + size(x), 1);
  return 1;
}

type JsonHits = { match: Set<string>; trail: Set<string>; q: string };

/** Paths whose key or value contains the query, or that equal/end with it ("customer.email"). */
function searchJson(value: unknown, query: string): JsonHits | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const match = new Set<string>();
  const trail = new Set<string>();
  const walk = (v: unknown, path: string, key: string): boolean => {
    const lower = path.toLowerCase();
    let self = key.toLowerCase().includes(q) || lower === q || lower.endsWith("." + q);
    let below = false;
    if (v && typeof v === "object") {
      for (const [k, x] of Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)) {
        if (walk(x, path ? `${path}.${k}` : k, Array.isArray(v) ? "" : k)) below = true;
      }
    } else if ((v === null ? "null" : show(v)).toLowerCase().includes(q)) self = true;
    if (self) match.add(path);
    if (below) trail.add(path);
    return self || below;
  };
  walk(value, "", "");
  return { match, trail, q: query.trim() };
}

export function JsonView({ text, value, open, find }: { text?: string; value?: unknown; open?: number; find?: string }) {
  const parsed = useMemo(
    () => (text != null && value === undefined ? parseJsonDocs(text) : { ok: true as const, value, many: false }),
    [text, value],
  );
  const [raw, setRaw] = useState(false);
  const { expanded } = useUiView();
  const [query, setQuery] = useFind(find);
  const hits = useMemo(() => (parsed.ok ? searchJson(parsed.value, query) : null), [parsed, query]);
  // Once per document, not per keystroke in the search box.
  const shape = useMemo(() => {
    if (!parsed.ok) return null;
    // Several jq documents are a list at the top; paths start at their index.
    const docs: [string, unknown][] = parsed.many ? asArray(parsed.value).map((v, i) => [String(i), v]) : [["", parsed.value]];
    return { pretty: JSON.stringify(parsed.value, null, 2) ?? "", depth: open ?? (size(parsed.value) <= 80 ? 99 : 2), docs };
  }, [parsed, open]);
  const box = useScrollToHit(hits);
  if (!parsed.ok || !shape)
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs text-destructive">Not valid JSON: {parsed.ok ? "" : parsed.error}</span>
        <pre className="max-h-96 overflow-auto rounded-md bg-muted p-2 font-mono text-code">{text}</pre>
      </div>
    );
  const { pretty, depth, docs } = shape;
  return (
    <div className="flex flex-col rounded-md border">
      <div className="flex items-center gap-1.5 border-b px-2">
        <SearchInput value={query} onChange={setQuery} label="Find a key, value or path" />
        {hits && <span className="shrink-0 text-xs text-muted-foreground">{plural(hits.match.size, "match", "matches")}</span>}
        <Button variant="ghost" size="xs" onClick={() => setRaw(!raw)}>
          {raw ? "Tree" : "Raw"}
        </Button>
        <CopyButton text={pretty} />
      </div>
      <div
        ref={box}
        key={query}
        {...growAttr(expanded, false)}
        className={cn("overflow-auto p-2 pl-5 font-mono text-code leading-(--code-row)", growClass(expanded, "max-h-[520px]", false))}
      >
        {raw ? (
          <pre className="whitespace-pre">{pretty}</pre>
        ) : (
          docs.map(([path, v], i) => (
            <div key={i} className={cn(i > 0 && "mt-1 border-t pt-1")}>
              <JsonNode value={v} path={path} depth={0} open={depth} hits={hits} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Scalar({ v, q }: { v: unknown; q?: string }) {
  const t = (s: string) => (q ? <Mark text={s} q={q} /> : s);
  if (typeof v === "string") return <span className={cn(STR, "break-all")}>"{t(v)}"</span>;
  if (typeof v === "number") return <span className={NUM}>{t(String(v))}</span>;
  if (v === null) return <span className="text-muted-foreground italic">null</span>;
  return <span className={LIT}>{t(show(v))}</span>;
}

function JsonNode({
  value,
  path,
  depth,
  open,
  hits,
  name,
  last = true,
}: {
  value: unknown;
  path: string;
  depth: number;
  open: number;
  hits: JsonHits | null;
  name?: string;
  last?: boolean;
}) {
  const isArr = Array.isArray(value);
  // While searching, only the way to the matches is open.
  const [shown, setShown] = useState(hits ? hits.trail.has(path) : depth < open);
  const [limit, setLimit] = useState(100);
  const hit = !!hits?.match.has(path);
  const q = hit ? hits!.q : undefined;
  const key = name != null && (
    <>
      <span className="text-foreground">{q ? <Mark text={`"${name}"`} q={q} /> : `"${name}"`}</span>
      <span className="text-muted-foreground">: </span>
    </>
  );
  const comma = !last && <span className="text-muted-foreground">,</span>;
  const row = cn(hit && "-ml-1 rounded-sm bg-amber-500/15 pl-1");
  const pad = { paddingLeft: depth ? 16 : 0 };
  // Entries for an array or object; null for a scalar.
  const entries: [string, unknown][] | null = isArr
    ? asArray(value).map((v, i): [string, unknown] => [String(i), v])
    : isObj(value)
      ? Object.entries(value)
      : null;
  if (!entries)
    return (
      <div style={pad}>
        <span data-hit={hit || undefined} className={row}>
          {key}
          <Scalar v={value} q={q} />
        </span>
        {comma}
      </div>
    );
  const [o, c] = isArr ? ["[", "]"] : ["{", "}"];
  if (!entries.length)
    return (
      <div style={pad}>
        <span data-hit={hit || undefined} className={row}>
          {key}
          <span className="text-muted-foreground">{o + c}</span>
        </span>
        {comma}
      </div>
    );
  return (
    <div style={pad}>
      <button
        type="button"
        aria-expanded={shown}
        data-hit={hit || undefined}
        onClick={() => setShown(!shown)}
        className={cn("-ml-4 inline-flex items-center text-left hover:bg-muted/60", hit && "rounded-sm bg-amber-500/15")}
      >
        <ChevronRight className={cn("size-3 text-muted-foreground transition-transform", shown && "rotate-90")} />
        <span className="ml-1">
          {key}
          <span className="text-muted-foreground">{o}</span>
          {!shown && (
            <>
              <span className="text-muted-foreground"> … {c}</span>
              <span className="ml-1.5 text-2xs text-muted-foreground">{plural(entries.length, isArr ? "item" : "key")}</span>
              {comma}
            </>
          )}
        </span>
      </button>
      {shown && (
        <>
          {entries.slice(0, limit).map(([k, v], i) => (
            <JsonNode
              key={k}
              name={isArr ? undefined : k}
              value={v}
              path={path ? `${path}.${k}` : k}
              depth={depth + 1}
              open={open}
              hits={hits}
              last={i === entries.length - 1}
            />
          ))}
          {entries.length > limit && (
            <button type="button" className="pl-4 text-2xs text-muted-foreground underline" onClick={() => setLimit((l) => l + 100)}>
              {fmt.format(entries.length - limit)} more
            </button>
          )}
          <div>
            <span className="text-muted-foreground">{c}</span>
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

// ── cat ─────────────────────────────────────────────────────────────────────

function parseDelimited(text: string, sep: string): { columns: { key: string; label: string }[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      records.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) records.push([...row, cell]);
  const [head = [], ...body] = records.filter((r) => r.some((c) => c !== ""));
  const columns = head.map((h, i) => ({ key: `c${i}`, label: h || `column ${i + 1}` }));
  return { columns, rows: body.map((r) => Object.fromEntries(columns.map((c, i) => [c.key, r[i] ?? ""]))) };
}

export function TextFileView({
  text,
  path,
  start = 1,
  highlight,
  follow = false,
  find,
}: {
  text: string;
  path?: string;
  start?: number;
  highlight?: unknown;
  follow?: boolean;
  find?: string;
}) {
  const ext = path?.split(".").pop()?.toLowerCase() ?? "";
  const kind = ["md", "markdown", "mdx"].includes(ext)
    ? "markdown"
    : ext === "csv"
      ? "csv"
      : ext === "tsv"
        ? "tsv"
        : ext === "json"
          ? "json"
          : "text";
  const [raw, setRaw] = useState(false);
  const { expanded } = useUiView();
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const bytes = useMemo(() => new TextEncoder().encode(text).length, [text]);
  const marked = useMemo(() => asArray(highlight).flatMap((n) => asNumber(n) ?? []), [highlight]);
  const table = useMemo(() => (kind === "csv" || kind === "tsv" ? parseDelimited(text, kind === "csv" ? "," : "\t") : null), [kind, text]);
  const header = (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {path && <span className="truncate font-mono text-foreground">{path}</span>}
      <span className="shrink-0">
        {plural(lines.length, "line")} · {formatBytes(bytes)}
      </span>
      <span className="ml-auto flex shrink-0 gap-0.5">
        {kind !== "text" && (
          <Button variant="ghost" size="xs" onClick={() => setRaw(!raw)}>
            {raw ? "Formatted" : "Raw"}
          </Button>
        )}
        <CopyButton text={text} />
      </span>
    </div>
  );
  let body: ReactNode;
  if (!raw && kind === "markdown")
    body = (
      <div {...growAttr(expanded)} className={cn("overflow-auto rounded-md border px-4 py-3", growClass(expanded, "max-h-[560px]"))}>
        <Markdown>{text}</Markdown>
      </div>
    );
  else if (!raw && table)
    body = (
      <Suspense fallback={<div className="h-40 animate-pulse rounded-md bg-muted" />}>
        <UiDataTable columns={table.columns} rows={table.rows} find={find} />
      </Suspense>
    );
  else if (!raw && kind === "json") body = <JsonView text={text} find={find} />;
  else body = <Lines lines={lines} start={start} highlight={marked} follow={follow} find={find} />;
  return (
    <div className="flex flex-col gap-1">
      {header}
      {body}
    </div>
  );
}

/** Short text sits inline; longer text gets line numbers, a scroll box and search. */
function Lines({ lines, start, highlight, follow, find }: { lines: string[]; start: number; highlight: number[]; follow: boolean; find?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const { expanded } = useUiView();
  // Follow the end as the text grows, unless the reader scrolled up to look at something.
  const pinned = useRef(true);
  const [query, setQuery] = useFind(find);
  const q = query.toLowerCase();
  // Which match is current, for the query it was picked in: a new query starts at its first match.
  const [at, setAt] = useState({ q, i: 0 });
  const current = at.q === q ? at.i : 0;
  const [wrap, setWrap] = useState(false);
  const [all, setAll] = useState(false);
  const hits = useMemo(() => {
    const out: number[] = [];
    if (q) for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(q)) out.push(i);
    return out;
  }, [lines, q]);
  const marks = new Set(highlight);
  const firstMark = highlight.length ? Math.min(...highlight) - start : -1;
  // The line to show: the current match, else the first marked line.
  const target = hits.length ? hits[current % hits.length] : firstMark;
  useEffect(() => {
    if (follow && pinned.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [follow, lines]);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${target}"]`);
    if (box.current && el) box.current.scrollTop = Math.max(0, el.offsetTop - box.current.offsetTop - box.current.clientHeight / 3);
  }, [target]);
  const short = lines.length <= 12 && lines.every((l) => l.length <= 120) && !highlight.length && !follow && !query;
  if (short) return <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-code whitespace-pre">{lines.join("\n")}</pre>;
  const cap = all || target >= 2000 ? lines.length : 2000;
  const hitSet = new Set(hits);
  const width = String(start + lines.length).length;
  const step = (d: number) => {
    if (hits.length) setAt({ q, i: (current + d + hits.length) % hits.length });
  };
  return (
    <div className="flex flex-col rounded-md border">
      <div className="flex items-center gap-1.5 border-b px-2">
        <SearchInput value={query} onChange={setQuery} label="Find" onEnter={(back) => step(back ? -1 : 1)} />
        {q && (
          <span className="flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {hits.length ? `${(current % hits.length) + 1} of ${hits.length}` : "no matches"}
            {hits.length > 1 && (
              <>
                <Button variant="ghost" size="icon-xs" title="Previous (⇧↵)" onClick={() => step(-1)}>
                  <ArrowUp />
                </Button>
                <Button variant="ghost" size="icon-xs" title="Next (↵)" onClick={() => step(1)}>
                  <ArrowDown />
                </Button>
              </>
            )}
          </span>
        )}
        <Button variant="ghost" size="xs" onClick={() => setWrap(!wrap)}>
          {wrap ? "No wrap" : "Wrap"}
        </Button>
      </div>
      <div
        ref={box}
        onScroll={(e) => (pinned.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 24)}
        {...growAttr(expanded)}
        className={cn("overflow-auto py-1 font-mono text-code leading-(--code-row)", growClass(expanded, "max-h-[480px]"))}
      >
        {lines.slice(0, cap).map((line, i) => (
          <div
            key={i}
            data-line={i}
            className={cn("flex", (marks.has(start + i) || hitSet.has(i)) && "bg-amber-500/15", i === target && hits.length > 0 && "bg-amber-500/30")}
          >
            <span
              // A highlighted line also gets a bar by its number: a shape, not the tint alone (CV-1).
              className={cn(
                "sticky left-0 shrink-0 border-l-2 border-transparent bg-background px-2 text-right text-muted-foreground/70 select-none",
                (marks.has(start + i) || hitSet.has(i)) && "border-amber-500 text-foreground",
              )}
              style={{ width: `${width + 2}ch` }}
            >
              {start + i}
            </span>
            <span className={cn("pr-3", wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre")}>
              {hitSet.has(i) ? <Mark text={line} q={query} /> : line || " "}
            </span>
          </div>
        ))}
        {lines.length > cap && (
          <button type="button" className="px-2 py-1 text-xs text-muted-foreground underline" onClick={() => setAll(true)}>
            Show all {fmt.format(lines.length)} lines
          </button>
        )}
      </div>
    </div>
  );
}

function Mark({ text, q }: { text: string; q: string }) {
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-amber-300/60 text-inherit dark:bg-amber-500/40">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

// ── wc ──────────────────────────────────────────────────────────────────────

const WC_LABEL: Record<string, string> = { lines: "Lines", words: "Words", bytes: "Bytes", chars: "Characters" };

const wcValue = (col: string, n: number) => (col === "bytes" ? formatBytes(n) : fmt.format(n));

export function WordCountView({ text, columns }: { text: string; columns?: unknown }) {
  const { expanded } = useUiView();
  const rows = useMemo(() => parseWc(text), [text]);
  const width = Math.max(1, ...rows.map((r) => r.counts.length));
  const named = asArray(columns).map(show);
  const cols = named.length
    ? named
    : width === 1
      ? ["lines"]
      : width === 2
        ? ["lines", "words"]
        : ["lines", "words", "bytes", "chars"].slice(0, width);
  const files = rows.filter((r) => !r.total);
  const total = rows.find((r) => r.total)?.counts ?? cols.map((_, i) => files.reduce((n, r) => n + (r.counts[i] ?? 0), 0));
  const sorted = [...files].sort((a, b) => (b.counts[0] ?? 0) - (a.counts[0] ?? 0));
  const max = sorted[0]?.counts[0] || 1;
  if (!rows.length) return <pre className="rounded-md bg-muted p-2 font-mono text-code">{text}</pre>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        {cols.map((c, i) => (
          <div key={c} className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">
              {WC_LABEL[c] ?? c}
              {files.length > 1 ? " (total)" : ""}
            </span>
            <span className="text-2xl font-semibold tabular-nums">{wcValue(c, total[i] ?? 0)}</span>
          </div>
        ))}
        {files.length > 1 && (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Files</span>
            <span className="text-2xl font-semibold tabular-nums">{fmt.format(files.length)}</span>
          </div>
        )}
      </div>
      {files.length > 1 && (
        <div {...growAttr(expanded, false)} className={cn("flex flex-col gap-1 overflow-y-auto", growClass(expanded, "max-h-[420px]", false))}>
          <span className="text-xs text-muted-foreground">{WC_LABEL[cols[0]] ?? cols[0]} per file</span>
          {sorted.map((r, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-2 text-xs" title={r.name}>
              <span className="truncate font-mono">{tail(r.name)}</span>
              <div className="h-3 rounded-sm bg-muted">
                <div className="h-3 rounded-sm bg-[var(--chart-1)]" style={{ width: `${Math.max(1, ((r.counts[0] ?? 0) / max) * 100)}%` }} />
              </div>
              <span className="text-right tabular-nums">
                {wcValue(cols[0], r.counts[0] ?? 0)}
                {cols.slice(1).map((c, j) => (
                  <span key={c} className="ml-2 text-muted-foreground">
                    {wcValue(c, r.counts[j + 1] ?? 0)}
                    {c === "words" ? " w" : ""}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
      {files.length === 1 && files[0].name && <span className="font-mono text-xs text-muted-foreground">{files[0].name}</span>}
    </div>
  );
}

// ── git log --graph ─────────────────────────────────────────────────────────

const CW = 10; // px per graph column; lanes are two columns apart
const LANE = (col: number) => `var(--chart-${(Math.round(col / 2) % 5) + 1})`;

/** One row of the graph as SVG, with lines joined to the rows around it. */
function GraphCell({ rows, i, h, cols }: { rows: GitRow[]; i: number; h: number; cols: number }) {
  const g = rows[i].graph;
  const up = rows[i - 1]?.graph ?? "";
  const down = rows[i + 1]?.graph ?? "";
  const x = (c: number) => c * CW + CW / 2;
  const els: ReactNode[] = [];
  for (let c = 0; c < g.length; c++) {
    const ch = g[c];
    const stroke = LANE(c);
    if (ch === "|") els.push(<line key={c} x1={x(c)} y1={0} x2={x(c)} y2={h} stroke={stroke} strokeWidth={2} />);
    else if (ch === "/")
      els.push(<line key={c} x1={x(c + 1)} y1={0} x2={x(c - 1)} y2={h} stroke={LANE(c + 1)} strokeWidth={2} strokeLinecap="round" />);
    else if (ch === "\\")
      els.push(<line key={c} x1={x(c - 1)} y1={0} x2={x(c + 1)} y2={h} stroke={LANE(c - 1)} strokeWidth={2} strokeLinecap="round" />);
    else if (ch === "_") els.push(<line key={c} x1={x(c - 1)} y1={h} x2={x(c + 1)} y2={h} stroke={stroke} strokeWidth={2} />);
    else if (ch === "*") {
      const top = "|*".includes(up[c] ?? " ") || up[c + 1] === "/" || up[c - 1] === "\\";
      const bottom = "|*".includes(down[c] ?? " ") || down[c - 1] === "/" || down[c + 1] === "\\";
      if (top) els.push(<line key={`t${c}`} x1={x(c)} y1={0} x2={x(c)} y2={h / 2} stroke={stroke} strokeWidth={2} />);
      if (bottom) els.push(<line key={`b${c}`} x1={x(c)} y1={h / 2} x2={x(c)} y2={h} stroke={stroke} strokeWidth={2} />);
      els.push(<circle key={`c${c}`} cx={x(c)} cy={h / 2} r={4} fill={stroke} stroke="var(--background)" strokeWidth={2} />);
    }
  }
  const w = cols * CW + 4;
  return (
    <svg width={w} height={h} className="shrink-0 overflow-visible" aria-hidden>
      {els}
    </svg>
  );
}

function RefBadge({ r }: { r: GitRef }) {
  if (r.kind === "head") return <Badge className="h-4 px-1.5 text-2xs">HEAD</Badge>;
  if (r.kind === "tag")
    return (
      <Badge variant="outline" className="h-4 gap-0.5 px-1.5 text-2xs">
        <Tag className="size-2.5" />
        {r.name}
      </Badge>
    );
  return (
    <Badge
      variant={r.kind === "branch" ? "secondary" : "outline"}
      className={cn("h-4 gap-0.5 px-1.5 text-2xs", r.kind === "remote" && "text-muted-foreground")}
    >
      <GitBranch className="size-2.5" />
      {r.name}
    </Badge>
  );
}

export function GitGraphView({ text }: { text: string }) {
  const { expanded } = useUiView();
  const rows = useMemo(() => parseGitLog(text), [text]);
  const commits = rows.filter((r) => r.hash).length;
  // One graph width for every row, so hashes and subjects line up.
  const cols = Math.max(1, ...rows.map((r) => r.graph.trimEnd().length));
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{plural(commits, "commit")}</span>
      <div {...growAttr(expanded, false)} className={cn("overflow-y-auto rounded-md border py-1", growClass(expanded, "max-h-[560px]", false))}>
        {rows.map((r, i) => {
          const h = r.hash ? 26 : 10;
          return (
            <div key={i} className="flex items-center gap-2 pr-3 pl-2 text-xs hover:bg-muted/40" style={{ height: h }}>
              <GraphCell rows={rows} i={i} h={h} cols={cols} />
              {r.hash && <span className="font-mono text-2xs text-muted-foreground">{r.hash}</span>}
              {r.refs.length > 0 && (
                <span className="flex min-w-0 shrink gap-1 overflow-hidden">
                  {r.refs.map((ref, j) => (
                    <RefBadge key={j} r={ref} />
                  ))}
                </span>
              )}
              {r.subject && (
                <span className={cn("min-w-0 flex-1 truncate", !r.hash && "text-muted-foreground")} title={r.subject}>
                  {r.subject}
                </span>
              )}
              {r.author && (
                <span className="shrink-0 pl-3 text-muted-foreground">
                  {r.author} · {r.date}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── git status ──────────────────────────────────────────────────────────────

const CODE_TONE: Record<string, string> = {
  A: GOOD,
  M: WARN,
  D: BAD,
  R: "text-sky-700 dark:text-sky-400",
  C: "text-sky-700 dark:text-sky-400",
  T: WARN,
  U: BAD,
  "?": "text-muted-foreground",
};

export function GitStatusView({ text }: { text: string }) {
  const s = useMemo(() => parseGitStatus(text), [text]);
  const groups: [string, GitFile[], string][] = [
    ["Conflicts", s.conflicted, BAD],
    ["Staged", s.staged, GOOD],
    ["Not staged", s.unstaged, WARN],
    ["Untracked", s.untracked, "text-muted-foreground"],
  ];
  const clean = groups.every(([, f]) => !f.length);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <GitBranch className="size-4 text-muted-foreground" />
        <span className="font-mono font-medium">{s.branch ?? "(no branch)"}</span>
        {s.upstream && <span className="font-mono text-xs text-muted-foreground">→ {s.upstream}</span>}
        {s.ahead > 0 && (
          <Badge variant="secondary" className="gap-0.5">
            <ArrowUp className="size-3" />
            {s.ahead} ahead
          </Badge>
        )}
        {s.behind > 0 && (
          <Badge variant="outline" className="gap-0.5">
            <ArrowDown className="size-3" />
            {s.behind} behind
          </Badge>
        )}
        {clean && <span className={cn("ml-auto text-xs", GOOD)}>Clean working tree</span>}
      </div>
      {groups.map(([title, files, tone]) =>
        files.length ? (
          <div key={title} className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">
              {title} <span className={tone}>{files.length}</span>
            </span>
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 font-mono text-xs">
                <span className={cn("w-3 shrink-0 text-center font-semibold", CODE_TONE[f.code])} title={f.label}>
                  {f.code}
                </span>
                <span className="truncate">
                  {f.from && <span className="text-muted-foreground">{f.from} → </span>}
                  {f.path}
                </span>
                <span className="ml-auto shrink-0 font-sans text-2xs text-muted-foreground">{f.label}</span>
              </div>
            ))}
          </div>
        ) : null,
      )}
      {s.other.length > 0 && <pre className="font-mono text-xs text-muted-foreground">{s.other.join("\n")}</pre>}
    </div>
  );
}

// ── --stat ──────────────────────────────────────────────────────────────────

export function DiffStatView({ text }: { text: string }) {
  const { expanded } = useUiView();
  const { files, summary } = useMemo(() => parseDiffStat(text), [text]);
  const sorted = [...files].sort((a, b) => b.added + b.removed - (a.added + a.removed));
  const max = Math.max(1, ...files.map((f) => f.added + f.removed));
  // Git's summary line is exact; per-file splits are estimated when the bars are scaled.
  const added = Number(summary?.match(/(\d+) insertions?/)?.[1] ?? files.reduce((n, f) => n + f.added, 0));
  const removed = Number(summary?.match(/(\d+) deletions?/)?.[1] ?? files.reduce((n, f) => n + f.removed, 0));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3 text-sm">
        <span>{plural(files.length, "file")}</span>
        <span className={GOOD}>+{fmt.format(added)}</span>
        <span className={BAD}>−{fmt.format(removed)}</span>
        {summary && <span className="ml-auto truncate text-xs text-muted-foreground">{summary}</span>}
      </div>
      <div
        {...growAttr(expanded, false)}
        className={cn("flex flex-col gap-1", expanded ? growClass(true, "", false) : sorted.length > 16 && "max-h-[420px] overflow-y-auto")}
      >
        {sorted.map((f, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_7rem_5.5rem] items-center gap-2 text-xs" title={f.path}>
            <span className="truncate font-mono">{tail(f.path, 60)}</span>
            <div className="flex h-2.5 gap-px">
              {f.binary ? (
                <span className="text-2xs text-muted-foreground">binary</span>
              ) : (
                <>
                  <div className="rounded-sm bg-green-600 dark:bg-green-500" style={{ width: `${(f.added / max) * 100}%` }} />
                  <div className="rounded-sm bg-destructive" style={{ width: `${(f.removed / max) * 100}%` }} />
                </>
              )}
            </div>
            <span className="text-right tabular-nums">
              <span className={GOOD}>+{f.added}</span> <span className={BAD}>−{f.removed}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
