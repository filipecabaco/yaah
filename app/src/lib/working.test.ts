import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resultSummary } from "@/lib/subagents";
import { useTurnStart } from "@/lib/working";

describe("useTurnStart", () => {
  afterEach(() => vi.useRealTimers());

  it("starts the clock when the chat is first seen running, not when the pane mounted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result, rerender } = renderHook(({ running }) => useTurnStart("s-clock", running, 0), { initialProps: { running: false } });
    expect(result.current).toBeNull();
    vi.setSystemTime(1_040_000);
    rerender({ running: true });
    expect(result.current).toBe(1_040_000);
    vi.setSystemTime(1_050_000);
    rerender({ running: true });
    expect(result.current).toBe(1_040_000);
  });

  it("restarts for a new user message even when the chat never looked idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const { result, rerender } = renderHook(({ turn }) => useTurnStart("s-next", true, turn), { initialProps: { turn: 3 } });
    expect(result.current).toBe(2_000_000);
    vi.setSystemTime(2_100_000);
    rerender({ turn: 9 });
    expect(result.current).toBe(2_100_000);
  });
});

describe("resultSummary", () => {
  it("skips the adapter's receipt for a background launch", () => {
    expect(resultSummary("Async agent launched successfully. (This tool result is internal metadata)")).toBeNull();
    expect(resultSummary("Async agent launched successfully.\n\nFound 3 issues in billing")).toBe("Found 3 issues in billing");
  });
});
