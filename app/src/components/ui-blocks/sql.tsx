// `sql` primitive: write and run read-only SQL against a saved connection.
// CodeMirror for the editor (SQL highlighting, completion from the
// connection's real schema); the query runs in Rust through the
// `postgres.query` source (READ ONLY transaction, 15s timeout, row limit).
// The agent writes or rewrites the SQL by rendering again with a new `sql`;
// the user edits and runs it, and can send query + result back to the chat.
// Loaded on demand.
import { useEffect, useId, useRef, useState } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { PostgreSQL, sql as sqlLanguage } from "@codemirror/lang-sql";
import { Database, History, Loader2, MessageSquarePlus, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/error-text";
import { draftIntoComposer, useChat } from "@/components/chat-context";
import UiDataTable from "@/components/ui-blocks/data-table";
import { api, type ConnectionInfo } from "@/lib/api";
import { plural } from "@/lib/format";
import { errorMessage } from "@/lib/narrow";
import { cn } from "@/lib/utils";

type Result = { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean };
type Schema = { tables: { schema: string; table: string; columns: { name: string; type: string }[] }[] };

const theme = EditorView.theme({
  "&": { fontSize: "var(--text-code)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { fontFamily: "var(--font-code)", padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted-foreground)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, var(--muted) 60%, transparent)" },
  ".cm-tooltip": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: "6px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-foreground)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "color-mix(in oklab, var(--primary) 20%, transparent)" },
});

/** CodeMirror's completion schema: table → columns, by plain and qualified name. */
function completionSchema(s: Schema | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of s?.tables ?? []) {
    const cols = t.columns.map((c) => c.name);
    out[t.table] = cols;
    if (t.schema !== "public") out[`${t.schema}.${t.table}`] = cols;
  }
  return out;
}

type Ran = { sql: string; ms: number } & ({ result: Result } | { error: unknown });

export default function UiSql({ connection, sql = "", limit, title }: { connection?: string; sql?: string; limit?: number; title?: string }) {
  const chat = useChat();
  const connId = useId();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [language] = useState(() => new Compartment());
  const [connections, setConnections] = useState<ConnectionInfo[] | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [conn, setConn] = useState(connection ?? "");
  // The agent picked another connection (an in-place re-render): follow it.
  const [agentConn, setAgentConn] = useState(connection);
  if (agentConn !== connection) {
    setAgentConn(connection);
    setConn(connection ?? "");
  }
  // Tagged with its connection, so switching never shows the previous one's tables.
  const [loaded, setLoaded] = useState<{ conn: string; schema: Schema | null } | null>(null);
  const schema = loaded?.conn === conn ? loaded.schema : null;
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState<Ran | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  useEffect(() => {
    api.listConnections().then(
      (list) => {
        setConnections(list);
        setConn((c) => c || list[0]?.name || "");
      },
      (e: unknown) => setListError(e),
    );
  }, []);

  useEffect(() => {
    if (!conn) return;
    let stale = false;
    // No schema only means no completion; running the query reports the real error.
    api.readSource({ kind: "postgres.schema", connection: conn }).then(
      (s) => !stale && setLoaded({ conn, schema: s as Schema }),
      () => !stale && setLoaded({ conn, schema: null }),
    );
    return () => {
      stale = true;
    };
  }, [conn]);

  async function runQuery() {
    const text = view.current?.state.doc.toString().trim() ?? "";
    if (!text || !conn || running) return;
    setRunning(true);
    const started = performance.now();
    try {
      const result = (await api.readSource({ kind: "postgres.query", connection: conn, sql: text, ...(limit ? { limit } : {}) })) as Result;
      setRan({ sql: text, result, ms: performance.now() - started });
    } catch (e) {
      setRan({ sql: text, error: e, ms: performance.now() - started });
    } finally {
      setRunning(false);
      setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 10));
    }
  }
  // The editor's ⌘↵ binding is set up once; it calls the latest `runQuery` through this ref.
  const run = useRef(() => {});
  useEffect(() => {
    // runQuery catches its own errors.
    run.current = () => void runQuery();
  });

  // The agent's last query, so a re-render with the same text doesn't wipe the user's edits.
  const lastFromAgent = useRef(sql);

  // The editor, once.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: lastFromAgent.current,
        extensions: [
          basicSetup,
          theme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "SQL query" }),
          language.of(sqlLanguage({ dialect: PostgreSQL, upperCaseKeywords: true })),
          // ⌘↵ / Ctrl↵ runs, ahead of the editor's own Enter handling.
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  run.current();
                  return true;
                },
              },
            ]),
          ),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
  }, [language]);

  // Completion follows the connection's schema.
  useEffect(() => {
    view.current?.dispatch({
      effects: language.reconfigure(sqlLanguage({ dialect: PostgreSQL, upperCaseKeywords: true, schema: completionSchema(schema) })),
    });
  }, [language, schema]);

  // The agent rewrote the query (an in-place re-render): it replaces the text.
  useEffect(() => {
    const v = view.current;
    if (!v || sql === lastFromAgent.current) return;
    lastFromAgent.current = sql;
    replaceText(v, sql);
  }, [sql]);

  const sendToChat = () => {
    if (!ran) return;
    const outcome =
      "error" in ran
        ? `It failed: ${errorMessage(ran.error)}`
        : `It returned ${ran.result.rows.length}${ran.result.truncated ? "+" : ""} rows (${ran.result.columns.join(", ")}).`;
    draftIntoComposer({ text: `About this query on \`${conn}\`:\n\`\`\`sql\n${ran.sql}\n\`\`\`\n${outcome}\n` }, chat?.pane);
  };

  const tables = schema?.tables.length;
  const result = ran && "result" in ran ? ran.result : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col rounded-md border">
        <div className="flex items-center gap-2 border-b px-2 py-1">
          <Database className="size-3.5 text-muted-foreground" />
          <label htmlFor={connId} className="sr-only">
            Connection
          </label>
          <select
            id={connId}
            value={conn}
            onChange={(e) => setConn(e.target.value)}
            className="h-7 rounded bg-transparent text-xs font-medium outline-none"
          >
            {!connections?.some((c) => c.name === conn) && conn && <option value={conn}>{conn}</option>}
            {connections?.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} · {c.target}
              </option>
            ))}
          </select>
          {title && <span className="truncate text-xs text-muted-foreground">{title}</span>}
          <span className="ml-auto text-2xs text-muted-foreground">{tables != null ? `${plural(tables, "table")} · read-only` : "read-only"}</span>
          {history.length > 1 && (
            <label className="flex items-center gap-1 text-xs text-muted-foreground" title="Earlier queries">
              <History className="size-3.5" />
              <select
                value=""
                aria-label="Earlier queries"
                onChange={(e) => {
                  if (view.current && e.target.value) replaceText(view.current, e.target.value);
                }}
                className="h-7 max-w-28 bg-transparent outline-none"
              >
                <option value="">History</option>
                {history.map((h, i) => (
                  <option key={i} value={h}>
                    {h.replace(/\s+/g, " ").slice(0, 60)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button size="xs" onClick={() => void runQuery()} disabled={running || !conn} title="Run (⌘↵)">
            {running ? <Loader2 className="animate-spin" /> : <Play />}
            Run
          </Button>
        </div>
        <div ref={host} className="max-h-72 min-h-20 overflow-auto" />
      </div>
      <ErrorText error={listError} className="px-1" />

      {ran && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn(!result && "text-destructive")}>
              {!result ? "Query failed" : result.truncated ? `${result.rows.length.toLocaleString()}+ rows` : plural(result.rows.length, "row")}
            </span>
            <span>· {Math.round(ran.ms)} ms</span>
            {chat && (
              <Button variant="ghost" size="xs" className="ml-auto" onClick={sendToChat}>
                <MessageSquarePlus /> Send to chat
              </Button>
            )}
          </div>
          {"error" in ran ? (
            // Postgres errors run over several lines (DETAIL, HINT): keep their breaks.
            <ErrorText error={ran.error} className="rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono whitespace-pre-wrap" />
          ) : (
            <>
              <UiDataTable columns={ran.result.columns} rows={ran.result.rows} empty="No rows." />
              {ran.result.truncated && <p className="text-xs text-muted-foreground">Stopped at the row limit; add a LIMIT or narrow the query.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function replaceText(v: EditorView, text: string) {
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
}
