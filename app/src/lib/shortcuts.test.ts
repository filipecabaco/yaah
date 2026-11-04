import { describe, expect, it } from "vitest";
import { isMac, shortcutFor, terminalShortcut } from "@/lib/shortcuts";

const key = (init: Partial<KeyboardEvent>) =>
  ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe("balance panes (⌃⌘=, Ctrl+Super+= on Linux)", () => {
  const both = key({ key: "=", code: "Equal", metaKey: true, ctrlKey: true });

  it("needs both modifiers and the = key", () => {
    expect(shortcutFor(both)).toEqual({ id: "balancePanes" });
    expect(shortcutFor(key({ key: "=", metaKey: true, ctrlKey: true }))).toEqual({ id: "balancePanes" });
    expect(shortcutFor(key({ key: "=", code: "Equal", metaKey: isMac, ctrlKey: !isMac }))).toBeNull();
    expect(shortcutFor(key({ key: "+", code: "Equal", metaKey: true, ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(key({ key: "d", code: "KeyD", metaKey: true, ctrlKey: true }))).toBeNull();
  });

  it("reaches the app from inside a terminal too", () => {
    expect(terminalShortcut(both)).toEqual({ id: "balancePanes" });
  });
});
