import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { Entry } from "@/lib/api";
import { WorkingIndicator } from "@/components/working-indicator";
import { shortCount, turnClock, turnPhase, useTurnStart } from "@/lib/working";

const user = { type: "user", text: "go" } as Entry;
const tool = (status: string, title = "Run tests") =>
  ({ type: "tool", toolCallId: "t", title, kind: "execute", status, content: [], locations: [], rawInput: null }) as Entry;
const ask = (chosen: string | null) => ({ type: "permission", toolCallId: "t", chosen, options: [] }) as unknown as Entry;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("working indicator", () => {
  it("formats the clock and counts", () => {
    expect(turnClock(7)).toBe("7s");
    expect(turnClock(164)).toBe("2m 44s");
    expect(turnClock(3720)).toBe("1h 02m");
    expect(shortCount(412)).toBe("412");
    expect(shortCount(8900)).toBe("8.9k");
  });

  it("names the phase from the end of the transcript", () => {
    expect(turnPhase([user], 0)).toBe("Working…");
    expect(turnPhase([user, { type: "thought", text: "hm", messageId: null }], 0)).toBe("Thinking…");
    expect(turnPhase([user, tool("in_progress")], 0)).toMatch(/…$/);
    expect(turnPhase([user, tool("in_progress"), ask(null)], 0)).toBe("Waiting for your answer");
    expect(turnPhase([user, tool("completed")], 0)).toBe("Working…");
  });

  it("ticks the time, shows agents, and shows tokens only when given", () => {
    const since = Date.now();
    const { rerender } = render(<WorkingIndicator phase="Working…" since={since} />);
    expect(screen.getByText("(0s)")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(164_000));
    expect(screen.getByText("(2m 44s)")).toBeTruthy();
    expect(screen.queryByText(/tokens/)).toBeNull();
    rerender(<WorkingIndicator phase="Working…" since={since} agents={2} tokens={8900} thoughtSeconds={1} />);
    expect(screen.getByText(/Working… · 2 agents running/)).toBeTruthy();
    expect(screen.getByText("(2m 44s · ↓ 8.9k tokens · thought for 1s)")).toBeTruthy();
  });

  it("keeps the turn's start across remounts, restarts on a new turn, and clears when idle", () => {
    const a = renderHook(() => useTurnStart("s1", true, 0));
    const t0 = a.result.current!;
    a.unmount();
    vi.advanceTimersByTime(5000);
    const b = renderHook(() => useTurnStart("s1", true, 0));
    expect(b.result.current).toBe(t0);
    b.rerender();
    expect(b.result.current).toBe(t0);
    const c = renderHook(() => useTurnStart("s1", true, 4));
    expect(c.result.current).toBe(t0 + 5000);
    const d = renderHook(() => useTurnStart("s1", false, 4));
    expect(d.result.current).toBeNull();
  });
});
