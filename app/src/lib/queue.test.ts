import { describe, expect, it } from "vitest";
import type { MessageQueue, QueuedMessage, SessionInfo } from "@/lib/api";
import { configNote, countsText, mentionLabels, oneLine, pauseText, queueAnnouncement } from "@/lib/queue";

const item = (id: string, text: string, more: Partial<QueuedMessage> = {}): QueuedMessage => ({ id, text, queuedAt: 0, ...more });

describe("the queue in words", () => {
  it("says what each message carries, on one line", () => {
    expect(countsText(item("a", "x"))).toBe("");
    expect(countsText(item("a", "x", { files: [{ id: "f", name: "a.png", kind: "image" }], references: 3 }))).toBe("1 attachment · 3 references");
    expect(oneLine("  two\n  lines  ")).toBe("two lines");
    expect(oneLine("")).toBe("Attachments only");
    expect(oneLine("x".repeat(80), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("says why it is paused", () => {
    const q = (reason: NonNullable<MessageQueue["paused"]>["reason"], detail?: string): MessageQueue => ({ items: [], paused: { reason, detail } });
    expect(pauseText(undefined)).toBeNull();
    expect(pauseText({ items: [] })).toBeNull();
    expect(pauseText(q("cancelled"))).toBe("Paused: the turn was stopped");
    expect(pauseText(q("stopped", "max_tokens"))).toBe("Paused: the turn ended early (max_tokens)");
    expect(pauseText(q("restart"))).toBe("Paused since yaah restarted");
    expect(pauseText(q("permission"))).toMatch(/permission request/);
  });

  it("announces a message queued, one sent, and a pause, and nothing else", () => {
    const one = { items: [item("a", "first")] };
    const two = { items: [item("a", "first"), item("b", "second")] };
    expect(queueAnnouncement(undefined, one)).toBe("Queued: first. 1 queued");
    expect(queueAnnouncement(one, two)).toBe("Queued: second. 2 queued");
    expect(queueAnnouncement(two, { items: [item("b", "second")], lastSent: "a" })).toBe("Sent from the queue: first. 1 queued");
    expect(queueAnnouncement({ items: [item("b", "second")], lastSent: "a" }, { lastSent: "b" })).toBe("Sent from the queue: second.");
    expect(queueAnnouncement(two, { ...two, paused: { reason: "error" } })).toBe("Paused: the turn ended with an error. 2 queued");
    expect(queueAnnouncement(two, { items: [item("b", "second"), item("a", "first")] })).toBeNull();
  });

  it("finds each mention's @label, so Edit gives the composer its mentions back", () => {
    expect(mentionLabels("see @src/app.ts and @README.md", ["/w/shop/src/app.ts", "/w/shop/README.md", "/w/shop/gone.ts"])).toEqual([
      { label: "src/app.ts", path: "/w/shop/src/app.ts" },
      { label: "README.md", path: "/w/shop/README.md" },
    ]);
  });

  it("notes the model and effort it was queued with only when they changed", () => {
    const session = {
      config: {
        options: [
          {
            id: "model",
            name: "Model",
            kind: "select",
            current: "sonnet",
            role: "model",
            choices: [
              { value: "opus", name: "Opus" },
              { value: "sonnet", name: "Sonnet" },
            ],
          },
          { id: "effort", name: "Effort", kind: "select", current: "high", role: "effort", choices: [{ value: "high", name: "High" }] },
        ],
      },
    } as unknown as SessionInfo;
    expect(configNote(session, item("a", "x", { config: { model: "sonnet", effort: "high" } }))).toBeNull();
    expect(configNote(session, item("a", "x"))).toBeNull();
    expect(configNote(session, item("a", "x", { config: { model: "opus", effort: "high" } }))).toBe(
      "Queued with Opus · High; it goes with the chat's current Sonnet · High",
    );
  });
});
