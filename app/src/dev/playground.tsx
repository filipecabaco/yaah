// Dev-only: render any agent UI tree with props, to try ideas without an agent.
// Open http://localhost:1420/#playground in a browser (`pnpm dev`).
// `window.renderUi(tree, props)` sets both from scripts (e.g. vitro's evaluate).
import { useCallback, useEffect, useState } from "react";
import { ChatContext } from "@/components/chat-context";
import { UiTree } from "@/components/ui-render";
import { api, events } from "@/lib/api";
import { asObj, errorMessage } from "@/lib/narrow";
import catalogue from "@/ui-primitives.json";

declare global {
  interface Window {
    renderUi?: (tree: unknown, props?: Record<string, unknown>) => void;
    /** Act as the agent calling ui_set_values on the form. */
    agentSet?: (values: Record<string, unknown>) => void;
  }
}

const START = {
  tree: { type: "card", props: { title: "Hello {{name}}" }, children: [{ type: "timer", props: { label: "since load", since: "{{t}}" } }] },
  props: { name: "playground", t: new Date().toISOString() },
};

type Values = Record<string, unknown>;

function parse(tree: string, props: string): { tree: unknown; props: Values } | { error: string } {
  try {
    return { tree: JSON.parse(tree) as unknown, props: asObj(JSON.parse(props)) };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

/**
 * A chat in the browser mock for buttons with `prompt` to send to; the prompts
 * it receives are listed. (The mock answers each with a recorded reply, unseen.)
 */
function usePromptSink(onPrompt: (text: string) => void): string | null {
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    let stop: (() => void) | undefined;
    api
      .newQuickChat("playground")
      .then(async (chat) => {
        const off = await events.sessionEntry(({ sessionId, entry }) => {
          if (sessionId === chat.sessionId && entry.type === "user") onPrompt(entry.text);
        });
        if (gone) return off();
        stop = off;
        setSessionId(chat.sessionId);
      })
      .catch((e: unknown) => console.error("playground: no chat for prompts", e));
    return () => {
      gone = true;
      stop?.();
    };
  }, [onPrompt]);
  return sessionId;
}

export function Playground() {
  const [tree, setTree] = useState(JSON.stringify(START.tree, null, 2));
  const [props, setProps] = useState(JSON.stringify(START.props, null, 2));
  const [prompts, setPrompts] = useState<string[]>([]);
  const addPrompt = useCallback((text: string) => setPrompts((p) => [...p, text]), []);
  const sessionId = usePromptSink(addPrompt);
  // Forms submit here, as they would to a waiting ui_ask; Reset unlocks them.
  const [answer, setAnswer] = useState<Values | null>(null);
  const [formKey, setFormKey] = useState(0);
  // The shared draft, as Rust keeps it: values and who changed each last.
  const [draft, setDraft] = useState<{ values: Values; by: Record<string, "user" | "agent"> }>({ values: {}, by: {} });
  const edit = (values: Values, who: "user" | "agent") =>
    setDraft((d) => ({ values: { ...d.values, ...values }, by: { ...d.by, ...Object.fromEntries(Object.keys(values).map((k) => [k, who])) } }));

  useEffect(() => {
    window.agentSet = (v) => edit(v, "agent");
    window.renderUi = (t, p = {}) => {
      setTree(JSON.stringify(t, null, 2));
      setProps(JSON.stringify(p, null, 2));
    };
    return () => {
      delete window.renderUi;
      delete window.agentSet;
    };
  }, []);

  const parsed = parse(tree, props);

  return (
    <div className="grid h-screen grid-cols-[minmax(320px,1fr)_2fr] bg-background text-foreground">
      <div className="flex min-h-0 flex-col gap-2 border-r p-3">
        <div className="text-sm font-medium">UI playground</div>
        <p className="text-xs text-muted-foreground">
          Primitives: {Object.keys(catalogue.primitives).join(", ")}. Rust validation doesn't run here; this is the renderer only.
        </p>
        <label className="text-xs text-muted-foreground">Tree</label>
        <textarea
          id="pg-tree"
          value={tree}
          onChange={(e) => setTree(e.target.value)}
          className="min-h-0 flex-[2] rounded-md border bg-muted/30 p-2 font-mono text-xs"
        />
        <label className="text-xs text-muted-foreground">Props</label>
        <textarea
          id="pg-props"
          value={props}
          onChange={(e) => setProps(e.target.value)}
          className="min-h-0 flex-1 rounded-md border bg-muted/30 p-2 font-mono text-xs"
        />
        {answer && (
          <button
            className="self-start rounded border px-2 py-0.5 text-xs"
            onClick={() => {
              setAnswer(null);
              setDraft({ values: {}, by: {} });
              setFormKey((k) => k + 1);
            }}
          >
            Reset form
          </button>
        )}
        {prompts.length > 0 && (
          <div className="text-xs">
            <div className="text-muted-foreground">Prompts sent by buttons:</div>
            {prompts.map((p, i) => (
              <div key={i} className="font-mono">
                → {p}
              </div>
            ))}
          </div>
        )}
      </div>
      <div id="pg-output" className="min-h-0 overflow-auto p-6">
        <div className="mx-auto max-w-3xl">
          {"error" in parsed ? (
            <pre className="text-sm text-destructive">{parsed.error}</pre>
          ) : (
            <ChatContext.Provider value={sessionId ? { sessionId, cwd: "/Users/dev/workspace/api", busy: false } : null}>
              <UiTree
                key={formKey}
                tree={parsed.tree}
                props={parsed.props}
                form={{
                  answer,
                  asking: true,
                  draft: draft.values,
                  draftBy: draft.by,
                  onEdit: (v) => Promise.resolve(edit(v, "user")),
                  onSubmit: (v) => {
                    setAnswer(v);
                    addPrompt(`answer: ${JSON.stringify(v)}`);
                    return Promise.resolve();
                  },
                }}
              />
            </ChatContext.Provider>
          )}
        </div>
      </div>
    </div>
  );
}
