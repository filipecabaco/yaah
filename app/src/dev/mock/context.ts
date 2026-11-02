// What every area of the browser mock shares: the fake home folder, the
// command handler shape, and the per-install context (state, timing, events).
import type { State } from "./state";

export const home = "/Users/dev";
export const ws = `${home}/workspace`;

/** Unix seconds, as Rust stamps things. */
export const now = () => Math.floor(Date.now() / 1000);

/**
 * Answers one Rust command. Arguments arrive as `src/lib/api.ts` sends them, so
 * each handler annotates its own (`({ id }: { id: string }) => …`). A thrown
 * Error rejects the `invoke` with its message, as a failed Rust command does.
 */
export type Handler = (args: never) => unknown;
export type Replies = Record<string, Handler>;

/** Everything a handler can reach. A fresh one is built by each `installBrowserMock()`. */
export type Mock = {
  state: State;
  /** Waits `ms` scaled by the `delay` option; with 0 it still yields a macrotask so React renders in between. */
  wait(ms: number): Promise<void>;
  /** Runs `f` after `ms` (scaled the same way). Cleared when the mock is installed again. */
  later(ms: number, f: () => void): void;
  /** Emits an app event with a copy of `payload`, as Tauri serialises it. */
  emit(event: string, payload: unknown): Promise<void>;
};

/** The value, or a failed command with `message`. */
export function need<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

/** The last path segment (a file or folder name). */
export const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;
