// Links from agent text, agent-built UI and settings open in the system
// browser, and only when they are http(s): never `file:`, `javascript:`,
// custom schemes, or the app's own webview.
import { openUrl } from "@tauri-apps/plugin-opener";

/** An absolute http(s) URL that parses. (Not a type guard: a string that fails is still a string.) */
export function isWebUrl(v: unknown): boolean {
  if (typeof v !== "string" || !/^https?:\/\//i.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Open an http(s) URL in the system browser; anything else is ignored. Failures are logged, never thrown. */
export function openExternal(url: unknown): void {
  if (typeof url !== "string" || !isWebUrl(url)) return;
  openUrl(url).catch((e: unknown) => console.error("could not open", url, e));
}

/** The host to show for a URL, or the text itself when it doesn't parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
