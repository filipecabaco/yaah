// The chat's column in wide windows: it scales with its pane, user bubbles hug its right edge
// (capped at 75ch), agent prose keeps a left-aligned 80ch measure, cards take the full width,
// and the composer shares the column. Against the real App and the browser mock.
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    const bubble = within(log).getByText("show me the command output");
    const message = bubble.closest("[data-align]") as HTMLElement;
    expect(message).toHaveAttribute("data-align", "end");
    expect(message.classList).toContain("ml-auto");
    expect(message.classList).toContain("w-fit");
    expect(message.classList).toContain("items-end");
    expect(message.className).toContain("max-w-[min(75ch,85%)]");
    // The bubble itself isn't capped again (the old 85% of 75ch left it mid-column).
    expect(bubble.className).toContain("max-w-full");
  });

  it("keeps agent prose left-aligned at 80ch, and gives cards the full width", async () => {
    const { log } = await commandTurn();
    const prose = within(log)
      .getByText(/Discounts now apply before tax/)
      .closest("[data-align]") as HTMLElement;
    expect(prose).toHaveAttribute("data-align", "start");
    expect(prose.className).toContain("max-w-[80ch]");
    expect(prose.classList).not.toContain("ml-auto");
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
