// The turn-level "Working…" line at the end of a running transcript: what it says and how long the
// turn has gone. Only how the transcript is drawn; nothing here is sent to or kept by Rust.
import { useMemo } from "react";
import type { Entry } from "@/lib/api";
import { toolLabel } from "@/lib/ui-tool-label";

/** "12s", "2m 44s", "1h 02m": a turn's time so far, in the CLI's style. */
export function turnClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "8.9k", "1.2M", "412": a token count, short. */
export function shortCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * What the agent is doing right now, from the end of the transcript: a request waiting on the user,
 * a tool call still going (its label), a thought being written, or just "Working…".
 */
export function turnPhase(entries: readonly (Entry | undefined)[], turnStart: number): string {
  let thinking = false;
  for (let i = entries.length - 1; i > turnStart; i--) {
    const e = entries[i];
    if (!e) continue;
    if (e.type === "permission" && e.chosen == null) return "Waiting for your answer";
    if (e.type === "tool" && (e.status === "pending" || e.status === "in_progress")) {
      const label = toolLabel({ title: e.title, status: e.status, rawInput: e.rawInput })?.text ?? e.title;
      return `${label.replace(/[….]+$/, "")}…`;
    }
    if (i === entries.length - 1 && e.type === "thought") thinking = true;
  }
  return thinking ? "Thinking…" : "Working…";
}

/** When each chat's running turn was first seen running (and under which user message), so it survives remounts and pane switches. */
const clock = () => Date.now();
const started = new Map<string, { at: number; turn: number }>();

/**
 * Epoch ms the running turn began, or null when no turn is running. Rust sends no start time, so
 * it is when this window first saw the chat running; a new user message restarts it (a queued
 * message starts the next turn without the chat ever looking idle).
 */
export function useTurnStart(sessionId: string, running: boolean, turn: number): number | null {
  // Set during render (not an effect) so the first frame already shows the right time; idempotent per turn
  // (the map keeps the first answer, so a repeated render, or StrictMode's second, gets the same start).
  return useMemo(() => {
    if (!running) {
      started.delete(sessionId);
      return null;
    }
    const s = started.get(sessionId);
    if (s && (s.turn === turn || s.turn < 0 || turn < 0)) {
      if (s.turn < 0 && turn >= 0) s.turn = turn;
      return s.at;
    }
    const fresh = { at: clock(), turn };
    started.set(sessionId, fresh);
    return fresh.at;
  }, [sessionId, running, turn]);
}
