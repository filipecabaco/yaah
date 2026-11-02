import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, events, type AgentProfile, type AuthMethod } from "@/lib/api";
import { compactPath } from "@/lib/format";
import { isWebUrl, openExternal } from "@/lib/links";
import { errorMessage } from "@/lib/narrow";
import { ErrorText } from "@/components/error-text";

type Phase =
  | { step: "loading" }
  | { step: "choose"; methods: AuthMethod[] }
  | { step: "waiting"; method: AuthMethod }
  | { step: "env"; method: AuthMethod }
  | { step: "done" }
  | { step: "failed"; message: string };

/** Logs an agent in through the methods it offers in ACP `authMethods`. */
export function LoginDialog({
  agent,
  onClose,
  onEditAgent,
}: {
  agent: AgentProfile | null;
  onClose: () => void;
  /** For env-var methods: open the agent's settings to set the variables. */
  onEditAgent?: (agent: AgentProfile) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ step: "loading" });
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<unknown>(null);
  const [lines, setLines] = useState<string[]>([]);
  const agentId = agent?.id;

  // Another agent (or the same one again): start over.
  const [shownId, setShownId] = useState(agentId);
  if (agentId !== shownId) {
    setShownId(agentId);
    setPhase({ step: "loading" });
    setUrl(null);
    setCode("");
    setCodeError(null);
    setLines([]);
  }

  useEffect(() => {
    if (!agentId) return;
    let live = true;
    api.loginMethods(agentId).then(
      (methods) => {
        if (!live) return;
        setPhase(
          methods.length
            ? { step: "choose", methods }
            : { step: "failed", message: "This agent offers no login methods. It may read credentials from its own config or environment." },
        );
      },
      (e: unknown) => live && setPhase({ step: "failed", message: errorMessage(e) }),
    );

    const unlisten = [
      events.loginUrl((e) => e.accountId === agentId && setUrl(e.url)),
      events.loginOutput((e) => e.accountId === agentId && setLines((prev) => [...prev.slice(-4), e.line])),
      events.loginDone((e) => {
        if (e.accountId !== agentId) return;
        setPhase(e.ok ? { step: "done" } : { step: "failed", message: e.message ?? "Login failed" });
      }),
    ];
    return () => {
      live = false;
      for (const off of unlisten) void off.then((f) => f());
    };
  }, [agentId]);

  async function start(method: AuthMethod) {
    if (!agentId) return;
    if (method.kind === "env_var") return setPhase({ step: "env", method });
    setPhase({ step: "waiting", method });
    try {
      await api.startLogin(agentId, method.id);
    } catch (e) {
      setPhase({ step: "failed", message: errorMessage(e) });
    }
  }

  function submitCode() {
    if (!agentId || !code.trim()) return;
    setCodeError(null);
    api.submitLoginCode(agentId, code).then(() => setCode(""), setCodeError);
  }

  function close() {
    if (agentId && phase.step === "waiting") api.cancelLogin(agentId).catch(console.error);
    onClose();
  }

  return (
    <Dialog open={!!agent} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log in “{agent?.label}”</DialogTitle>
          <DialogDescription>
            {agent?.preset !== "claude" ? (
              <>
                Runs <code>{agent?.commandLine}</code>.
              </>
            ) : agent.configDir ? (
              <>
                Credentials are stored in <code>{compactPath(agent.configDir)}</code>.
              </>
            ) : (
              "Uses Claude Code's default login (~/.claude)."
            )}
          </DialogDescription>
        </DialogHeader>

        {phase.step === "loading" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Asking the agent for login options…
          </p>
        )}

        {phase.step === "choose" && (
          <div className="flex flex-col gap-2">
            {phase.methods.map((m, i) => (
              <Button
                key={m.id}
                variant={i === 0 ? "default" : "outline"}
                autoFocus={i === 0}
                className="h-auto flex-col items-start gap-0.5 py-2 text-left whitespace-normal"
                onClick={() => void start(m)}
              >
                <span>{m.name}</span>
                {m.description && <span className="text-xs font-normal opacity-70">{m.description}</span>}
              </Button>
            ))}
          </div>
        )}

        {phase.step === "env" && (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Set{" "}
              {phase.method.vars.length
                ? phase.method.vars.map((v, i) => (
                    <span key={v}>
                      {i > 0 && ", "}
                      <code>{v}</code>
                    </span>
                  ))
                : "the agent's credentials"}{" "}
              in this agent's environment, then start a chat.
            </p>
            {agent && onEditAgent && (
              <Button variant="outline" size="sm" className="self-start" onClick={() => onEditAgent(agent)}>
                Edit agent
              </Button>
            )}
          </div>
        )}

        {phase.step === "waiting" && (
          <div className="flex flex-col gap-3 text-sm">
            <p className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              {phase.method.kind === "terminal"
                ? "Finish signing in in your browser."
                : "Finish signing in where the agent sends you (usually your browser)."}
            </p>
            {/* The URL comes from the agent's output: only ever open a web page. */}
            {url && isWebUrl(url) && (
              <Button variant="outline" size="sm" className="self-start" onClick={() => openExternal(url)}>
                <ExternalLink /> Open the sign-in page again
              </Button>
            )}
            {phase.method.kind === "terminal" && (
              <form
                className="flex flex-col gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitCode();
                }}
              >
                <label htmlFor="login-code" className="text-xs text-muted-foreground">
                  If the page shows a code instead of finishing on its own, paste it here:
                </label>
                <div className="flex gap-2">
                  <Input
                    id="login-code"
                    autoComplete="off"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="Authentication code"
                  />
                  <Button type="submit" variant="secondary" disabled={!code.trim()}>
                    Submit
                  </Button>
                </div>
                <ErrorText error={codeError} />
              </form>
            )}
            {lines.length > 0 && (
              <pre className="max-h-24 overflow-auto rounded-md bg-muted p-2 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">
                {lines.join("\n")}
              </pre>
            )}
          </div>
        )}

        {phase.step === "done" && <p className="text-sm">Logged in. New chats with this agent will use it.</p>}
        {phase.step === "failed" && <ErrorText error={phase.message} className="text-sm whitespace-pre-wrap" />}

        <DialogFooter>
          <Button variant={phase.step === "done" ? "default" : "outline"} onClick={close}>
            {phase.step === "done" ? "Done" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
