import { describe, expect, it } from "vitest";
import { isMac, shortcutFor, terminalShortcut } from "@/lib/shortcuts";

const key = (init: Partial<KeyboardEvent>) =>
  ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe("balance panes (⌃⌘=, Ctrl+Super+= on Linux)", () => {
  const both = key({ key: "=", code: "Equal", metaKey: true, ctrlKey: true });

  it("needs both modifiers and the = key", () => {
    expect(shortcutFor(both)).toEqual({ id: "balancePanes" });
    expect(shortcutFor(key({ key: "=", metaKey: true, ctrlKey: true }))).toEqual({ id: "balancePanes" });
    // One modifier is a size key (below), not this.
    expect(shortcutFor(key({ key: "=", code: "Equal", metaKey: isMac, ctrlKey: !isMac }))).toEqual({ id: "sizeUp" });
    expect(shortcutFor(key({ key: "+", code: "Equal", metaKey: true, ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(key({ key: "d", code: "KeyD", metaKey: true, ctrlKey: true }))).toBeNull();
  });

  it("reaches the app from inside a terminal too", () => {
    expect(terminalShortcut(both)).toEqual({ id: "balancePanes" });
  });
});

describe("text size (⌘= ⌘- ⌘0, Ctrl on Linux)", () => {
  const mod = { metaKey: isMac, ctrlKey: !isMac };

  it("= and + (with or without Shift, or the keypad) are bigger; - smaller; 0 the default", () => {
    expect(shortcutFor(key({ ...mod, key: "=", code: "Equal" }))).toEqual({ id: "sizeUp" });
    expect(shortcutFor(key({ ...mod, key: "+", code: "Equal", shiftKey: true }))).toEqual({ id: "sizeUp" });
    expect(shortcutFor(key({ ...mod, key: "+", code: "NumpadAdd" }))).toEqual({ id: "sizeUp" });
    expect(shortcutFor(key({ ...mod, key: "-", code: "Minus" }))).toEqual({ id: "sizeDown" });
    expect(shortcutFor(key({ ...mod, key: "-", code: "NumpadSubtract" }))).toEqual({ id: "sizeDown" });
    expect(shortcutFor(key({ ...mod, key: "0", code: "Digit0" }))).toEqual({ id: "sizeReset" });
    expect(shortcutFor(key({ ...mod, key: "0", code: "Numpad0" }))).toEqual({ id: "sizeReset" });
    // Not with Shift on - or 0, and never without the modifier.
    expect(shortcutFor(key({ ...mod, key: "_", code: "Minus", shiftKey: true }))).toBeNull();
    expect(shortcutFor(key({ ...mod, key: ")", code: "Digit0", shiftKey: true }))).toBeNull();
    expect(shortcutFor(key({ key: "=", code: "Equal" }))).toBeNull();
    expect(shortcutFor(key({ key: "+", code: "NumpadAdd" }))).toBeNull();
  });

  it("work inside a terminal, with the same keys (GNOME Terminal's zoom keys on Linux)", () => {
    expect(terminalShortcut(key({ ...mod, key: "=", code: "Equal" }))).toEqual({ id: "sizeUp" });
    expect(terminalShortcut(key({ ...mod, key: "-", code: "Minus" }))).toEqual({ id: "sizeDown" });
    expect(terminalShortcut(key({ ...mod, key: "0", code: "Digit0" }))).toEqual({ id: "sizeReset" });
  });
});
