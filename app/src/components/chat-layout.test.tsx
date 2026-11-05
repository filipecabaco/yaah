// The chat's column in wide windows: it scales with its pane, user bubbles hug its right edge
// (capped at 75ch), agent text sits in a soft left bubble up to 100ch, cards take the full width,
// and the composer shares the column. Against the real App and the browser mock.
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TranscriptEntry } from "@/components/entries";
import { renderApp, sendInQuickChat } from "@/test/app";

/**
 * The `.chat-column` rule in index.css, read from disk: tests don't process CSS (even `?raw` comes back
 * empty), and src's tsconfig has no Node types, hence the typed dynamic import.
 */
async function columnRule() {
  const fsModule = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (path: string, encoding: "utf8") => string };
  const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
  const css = fs.readFileSync(`${cwd}/src/index.css`, "utf8");
  return /\.chat-column\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
}

async function commandTurn() {
  const app = renderApp();
  const log = await sendInQuickChat(app.user, "show me the command output");
  await within(log).findByText(/Discounts now apply before tax/);
  await screen.findByRole("button", { name: "Send" });
  return { ...app, log };
}

/** Every class between `el` and the log: what could cap or shift it. */
function classesUpTo(el: Element, log: Element): string[] {
  const out: string[] = [];
  for (let n: Element | null = el; n && n !== log; n = n.parentElement) out.push(...n.classList);
  return out;
}

describe("the chat column", () => {
  it("scales with its pane: pane-sized gutters, up to 2048px", async () => {
    const rule = await columnRule();
    expect(rule).toMatch(/--chat-gutter:\s*clamp\(1rem,\s*3cqi,\s*3rem\)/);
    expect(rule).toMatch(/padding-inline:\s*var\(--chat-gutter\)/);
    expect(rule).toMatch(/max-width:\s*2048px/);
    expect(rule).toMatch(/margin-inline:\s*auto/);
  });

  it("puts the user's message on the right edge, capped at 75ch", async () => {
    const { log } = await commandTurn();
    const bubble = within(log).getByText("show me the command output").closest(".user-message") as HTMLElement;
    const message = bubble.closest("[data-align]") as HTMLElement;
    expect(message).toHaveAttribute("data-align", "end");
    expect(message.classList).toContain("ml-auto");
    expect(message.classList).toContain("w-fit");
    expect(message.classList).toContain("items-end");
    expect(message.className).toContain("max-w-[min(75ch,85%)]");
    // The bubble itself isn't capped again (the old 85% of 75ch left it mid-column).
    expect(bubble.className).toContain("max-w-full");
    // Nothing between the message and the column narrows it, so ml-auto reaches the cards' right edge
    // (the old layout's left-anchored 75ch wrapper is what put the bubble mid-column).
    const above = classesUpTo(message.parentElement as Element, log);
    expect(above.filter((c) => c.startsWith("max-w-") || c.startsWith("w-"))).toEqual([]);
    expect(above).not.toContain("items-start");
  });

  it("puts the agent's text in a soft bubble on the left, quieter than a card", async () => {
    const { log } = await commandTurn();
    const reply = within(log)
      .getByText(/Discounts now apply before tax/)
      .closest("[data-align]") as HTMLElement;
    expect(reply).toHaveAttribute("data-align", "start");
    expect(reply.classList).not.toContain("ml-auto");
    // Fits short text, up to a readable measure; index.css widens it to the full measure for wide blocks.
    expect(reply.classList).toContain("w-fit");
    expect(reply.className).toContain("max-w-[min(140ch,100%)]");
    // A muted fill and the user bubble's corners, from theme tokens; no border, unlike a tool card.
    expect(reply.classList).toContain("bg-muted/50");
    expect(reply.classList).toContain("rounded-lg");
    expect(reply.classList).not.toContain("border");
    expect(reply.classList).not.toContain("bg-card");
    expect(reply.classList).toContain("leading-relaxed");
    // The prose spacing hook in index.css.
    expect(reply.classList).toContain("agent-reply");
    const card = within(log).getByText("git diff main...HEAD").closest(".bg-card") as HTMLElement;
    expect(card.classList).toContain("border");
  });

  it("gives each run of agent text around tool calls its own bubble", async () => {
    const app = renderApp();
    const log = await sendInQuickChat(app.user, "Show me some cities in a scenario");
    await within(log).findByText(/All five items are rendered/, undefined, { timeout: 15_000 });
    const runs = log.querySelectorAll(".agent-reply");
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      // Each is a transcript entry of its own, not one bubble wrapped around the tool cards.
      expect(run.querySelector(".bg-card")).toBeNull();
      expect(run.closest("[role=log] > div")?.querySelectorAll(".agent-reply").length).toBe(1);
    }
    // A tool card sits between two bubbles.
    const entries = [...log.children];
    const kinds = entries.map((e) => (e.querySelector(".agent-reply") ? "agent" : e.querySelector(".bg-card") ? "card" : "other"));
    expect(kinds.join(" ")).toMatch(/agent( other)*( card)+( other)* agent/);
  });

  it("draws no empty bubble for a text run that hasn't streamed anything yet", () => {
    const entry = (text: string) => ({ type: "agent" as const, text, messageId: null });
    const props = { index: 0, inTurn: true, live: true, onLogin: () => {} };
    const { container, rerender } = render(<TranscriptEntry entry={entry("")} {...props} />);
    expect(container.querySelector(".agent-reply")).toBeNull();
    rerender(<TranscriptEntry entry={entry("Looking at")} {...props} />);
    expect(container.querySelector(".agent-reply")?.textContent).toBe("Looking at");
  });

  it("gives cards the full width", async () => {
    const { log } = await commandTurn();
    // A tool card and the rendered UI: nothing between them and the column caps their width.
    const cardButton = within(log).getByText("git diff main...HEAD").closest("button") as HTMLElement;
    const ui = within(log).getByRole("tablist").closest("figure") as HTMLElement;
    for (const el of [cardButton, ui]) {
      const classes = classesUpTo(el, log);
      expect(classes.filter((c) => c.startsWith("max-w-"))).toEqual([]);
      expect(classes).not.toContain("ml-auto");
    }
  });

  it("shares the column with the composer, each in its own pane-sized container", async () => {
    const { log } = await commandTurn();
    expect(log.classList).toContain("chat-column");
    expect(log.parentElement?.classList).toContain("@container");
    const composer = screen.getByRole("combobox", { name: "Message" });
    const row = composer.closest(".chat-column") as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.parentElement?.classList).toContain("@container");
    // No fixed 1400px cap left anywhere in the chat.
    expect(document.querySelector('[class*="1400px"]')).toBeNull();
  });
});
