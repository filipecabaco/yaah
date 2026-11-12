// `/mcp`: the MCP servers yaah gives its agents, as the CLI's "Manage MCP servers" shows them: each one's
// state (connected with its tools, needs a login, failed, off) and what can be done about it: log in
// through the browser, log out, reconnect, turn it on or off, open it in Settings. Rust connects to every
// server and runs the OAuth flow (mcp_servers.rs, mcp_oauth.rs); this shows the result.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Check, CircleSlash, Loader2, LogIn, LogOut, RefreshCw, Settings, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ErrorText } from "@/components/error-text";
import { mcpApi, type McpStatus } from "@/lib/api";
import { openSettings } from "@/lib/app-events";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";

const GLYPH = {
  connected: <Check className="size-4 text-green-600 dark:text-green-400" aria-hidden />,
  "needs-login": <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />,
  failed: <X className="size-4 text-destructive" aria-hidden />,
  disabled: <CircleSlash className="size-4 text-muted-foreground" aria-hidden />,
} as const;

/** The state as the right-hand column says it. */
const summary = (s: McpStatus) =>
  s.state === "connected"
    ? plural(s.tools.length, "tool")
    : s.state === "needs-login"
      ? "needs authentication"
      : s.state === "failed"
        ? "failed"
        : "disabled";

export function McpManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[min(42rem,94vw)] max-w-none flex-col gap-3 sm:max-w-none">
        {/* Mounted while open, so each opening starts fresh and connects again. */}
        <Body onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function Body({ onClose }: { onClose: () => void }) {
  const [servers, setServers] = useState<McpStatus[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** The server being logged in, logged out or switched, so its buttons wait. */
  const [busy, setBusy] = useState<{ name: string; what: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let current = true;
    mcpApi.status().then(
      (s) => current && setServers(s),
      (e: unknown) => {
        if (!current) return;
        setError(e);
        setServers([]);
      },
    );
    return () => {
      current = false;
    };
  }, [round]);
  // Once the servers are in, the keyboard is on the list (↑/↓ move through it, Enter opens a server).
  useEffect(() => {
    if (servers?.length) list.current?.querySelector<HTMLElement>("[data-mcp-row]")?.focus();
  }, [servers?.length]);
  /** Connect to everything again. */
  const load = () => {
    setServers(null);
    setRound((r) => r + 1);
  };

  const run = (name: string, what: string, action: () => Promise<unknown>) => {
    setError(null);
    setBusy({ name, what });
    action()
      .catch(setError)
      .finally(() => {
        setBusy(null);
        load();
      });
  };
  const logIn = (s: McpStatus) => run(s.name, "Waiting for the browser…", () => mcpApi.login(s.name));
  const logOut = (s: McpStatus) => run(s.name, "Logging out…", () => mcpApi.logout(s.name));
  const toggle = (s: McpStatus) => run(s.name, s.enabled ? "Turning off…" : "Turning on…", () => mcpApi.setEnabled(s.name, !s.enabled));

  const onKeyDown = (e: KeyboardEvent) => {
    if (!servers?.length || (e.target instanceof HTMLElement && e.target.closest("[data-mcp-actions]"))) return;
    const to = (i: number) => {
      e.preventDefault();
      const next = Math.max(0, Math.min(servers.length - 1, i));
      setSelected(next);
      list.current?.querySelectorAll<HTMLElement>("[data-mcp-row]")[next]?.focus();
    };
    if (e.key === "ArrowDown") to(selected + 1);
    else if (e.key === "ArrowUp") to(selected - 1);
    else if (e.key === "Home") to(0);
    else if (e.key === "End") to(servers.length - 1);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="flex flex-col gap-0.5 pr-6">
        <DialogTitle>Manage MCP servers</DialogTitle>
        <DialogDescription>
          {servers ? plural(servers.length, "server") : "Connecting…"} · the ones yaah gives your agents (Settings → MCP servers)
        </DialogDescription>
      </div>
      <ul ref={list} className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto" aria-label="MCP servers" aria-busy={servers === null}>
        {servers === null && (
          <li className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Connecting to your servers…
          </li>
        )}
        {servers?.length === 0 && !error && (
          <li className="px-2 py-6 text-sm text-muted-foreground">
            No servers yet. Add Stripe, Cloudflare, Linear and more from the catalog in Settings → MCP servers, or import the ones from Claude Code
            there.
          </li>
        )}
        {servers?.map((s, i) => {
          const isOpen = expanded === s.name;
          const mine = busy?.name === s.name;
          return (
            <li key={s.name} className={cn("rounded-md", i === selected && "bg-muted/60")}>
              <button
                type="button"
                data-mcp-row
                aria-expanded={isOpen}
                tabIndex={i === selected ? 0 : -1}
                onFocus={() => setSelected(i)}
                onClick={() => setExpanded(isOpen ? null : s.name)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {mine ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden /> : GLYPH[s.state]}
                <span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
                <span className={cn("shrink-0 text-xs", s.state === "needs-login" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                  {mine ? busy.what : summary(s)}
                </span>
              </button>
              {isOpen && (
                <div data-mcp-actions className="flex flex-col gap-2 px-9 pb-2 text-xs">
                  <p className="text-muted-foreground">
                    {s.transport === "stdio" ? "Local command" : s.transport === "http" ? "HTTP server" : "SSE server"}
                    {s.loggedIn && " · logged in by yaah"}
                  </p>
                  {s.detail && <p className="[overflow-wrap:anywhere] text-muted-foreground">{s.detail}</p>}
                  {s.tools.length > 0 && (
                    <p className="max-h-24 overflow-y-auto font-mono [overflow-wrap:anywhere] text-muted-foreground">
                      {s.tools.map((t) => t.name).join(", ")}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {s.transport === "http" && s.enabled && !s.loggedIn && (
                      <Button size="xs" variant={s.state === "needs-login" ? "default" : "outline"} disabled={!!busy} onClick={() => logIn(s)}>
                        <LogIn /> Log in
                      </Button>
                    )}
                    {s.transport === "http" && s.loggedIn && (
                      <>
                        <Button size="xs" variant="outline" disabled={!!busy} onClick={() => logIn(s)}>
                          <LogIn /> Log in again
                        </Button>
                        <Button size="xs" variant="outline" disabled={!!busy} onClick={() => logOut(s)}>
                          <LogOut /> Log out
                        </Button>
                      </>
                    )}
                    <Button size="xs" variant="outline" disabled={!!busy} onClick={load}>
                      <RefreshCw /> Reconnect
                    </Button>
                    <Button size="xs" variant="outline" disabled={!!busy} onClick={() => toggle(s)}>
                      {s.enabled ? "Turn off" : "Turn on"}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        onClose();
                        openSettings("mcp");
                      }}
                    >
                      <Settings /> Edit in Settings
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorText error={error} />
      <p className="text-xs text-muted-foreground">
        ↑/↓ to move · Enter to open a server · Esc to close. Servers an agent has in its own config (Claude&apos;s connectors, say) are managed by
        that agent.
      </p>
    </div>
  );
}
