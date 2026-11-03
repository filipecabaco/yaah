// Display formatting shared by every screen: counts, sizes, durations and paths.
import type { StartStage } from "@/lib/api";

const integer = new Intl.NumberFormat();

/** `1 file`, `3 files`, `1,204 lines`. `many` defaults to `one` + "s". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${integer.format(n)} ${n === 1 ? one : many}`;
}

/** `512 B`, `3.4 KB`, `1.2 MB`. */
export function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** A span of time, coarse: `45s`, `3m 05s`, `2h 07m`, `4d 3h`. */
export function formatDuration(ms: number): string {
  const s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${pad(m)}m`;
  if (m) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** How long ago a Unix time (seconds) was: `just now`, `5 min ago`, … then the date. */
export function formatAgo(secs: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - secs);
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 45) return `${Math.round(d / 86400)} d ago`;
  return new Date(secs * 1000).toLocaleDateString();
}

/** `/Users/me/src/x` → `~/src/x` for display. */
export function compactPath(path: string, home = guessHome(path)): string {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

function guessHome(path: string): string | null {
  const m = /^\/(Users|home)\/[^/]+/.exec(path);
  return m ? m[0] : null;
}

/** The last segment of a path: `~/src/app` → `app`. */
export const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

/** How long something has been running: `12 s`, `2 min 5 s`, `3 min`. */
export const elapsedText = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`);

/** At most this many MCP server names in a new chat's starting line; the rest are counted. */
const SHOWN_SERVERS = 4;

/** What a new chat is waiting for: "Starting Codex…", "Starting MCP servers: chrome-devtools, fetch…", "Opening the session…". */
export function startingText(start: { stage: StartStage; servers: string[] }, agentLabel: string): string {
  switch (start.stage) {
    case "agent":
      return `Starting ${agentLabel}…`;
    case "mcpServers": {
      const names = start.servers.slice(0, SHOWN_SERVERS).join(", ");
      const more = start.servers.length - SHOWN_SERVERS;
      return `Starting MCP servers: ${names}${more > 0 ? ` and ${more} more` : ""}…`;
    }
    case "session":
      return "Opening the session…";
  }
}
