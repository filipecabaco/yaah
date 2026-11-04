import { describe, expect, it } from "vitest";
import { applyEdit, indent, markdownKey, newLine, pasteLink, wrapShortcut, wrapTyped, type Edit } from "@/lib/markdown-input";

/** `|` marks the caret, `[` … `]` a selection; returns the text and selection. */
function at(marked: string) {
  const caret = marked.indexOf("|");
  if (caret !== -1) return { text: marked.replace("|", ""), start: caret, end: caret };
  const start = marked.indexOf("«");
  const end = marked.indexOf("»") - 1;
  return { text: marked.replace("«", "").replace("»", ""), start, end };
}

/** The text after the edit, with the caret (or selection) marked the same way. */
function after(marked: string, edit: Edit | null) {
  const { text } = at(marked);
  if (!edit) return null;
  const out = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  if (edit.selStart === edit.selEnd) return out.slice(0, edit.selStart) + "|" + out.slice(edit.selStart);
  return out.slice(0, edit.selStart) + "«" + out.slice(edit.selStart, edit.selEnd) + "»" + out.slice(edit.selEnd);
}

const nl = (m: string) => after(m, newLine(at(m)));

describe("a new line continues the list", () => {
  it("bullets, numbers, checkboxes and quotes carry on", () => {
    expect(nl("- one|")).toBe("- one\n- |");
    expect(nl("  * nested|")).toBe("  * nested\n  * |");
    expect(nl("3. three|")).toBe("3. three\n4. |");
    expect(nl("9) nine|")).toBe("9) nine\n10) |");
    expect(nl("- [x] done|")).toBe("- [x] done\n- [ ] |");
    expect(nl("> quoted|")).toBe("> quoted\n> |");
  });

  it("splits an item at the caret", () => {
    expect(nl("- one| two")).toBe("- one\n- | two");
  });

  it("an empty item ends the list", () => {
    expect(nl("- one\n- |")).toBe("- one\n|");
    expect(nl("1. one\n2. |")).toBe("1. one\n|");
  });

  it("leaves plain lines, the marker itself and code blocks alone", () => {
    expect(newLine(at("plain text|"))).toBeNull();
    expect(newLine(at("-| one"))).toBeNull();
    expect(newLine(at("```\n- in code|"))).toBeNull();
    expect(newLine(at("-1 not a list|"))).toBeNull();
  });

  it("closes a fence that was just opened", () => {
    expect(nl("```ts|")).toBe("```ts\n|\n```");
    expect(nl("  ~~~|")).toBe("  ~~~\n  |\n  ~~~");
    // The closing fence of a block isn't opened again.
    expect(newLine(at("```\ncode\n```|"))).toBeNull();
  });
});

describe("Tab on list lines", () => {
  it("indents and outdents the item, keeping the caret with the text", () => {
    expect(after("- one|", indent(at("- one|"), false))).toBe("  - one|");
    expect(after("  - one|", indent(at("  - one|"), true))).toBe("- one|");
  });

  it("indents every selected item", () => {
    expect(after("«- a\n- b»", indent(at("«- a\n- b»"), false))).toBe("  «- a\n  - b»");
  });

  it("is not taken off plain text or an item already at the margin", () => {
    expect(indent(at("plain|"), false)).toBeNull();
    expect(indent(at("«- a\nplain»"), false)).toBeNull();
    expect(indent(at("- a|"), true)).toBeNull();
  });
});

describe("wrapping a selection", () => {
  it("typing a mark over a selection wraps it", () => {
    expect(after("say «hi»", wrapTyped(at("say «hi»"), "`"))).toBe("say `«hi»`");
    expect(after("«note»", wrapTyped(at("«note»"), "("))).toBe("(«note»)");
    expect(after("«x»", wrapTyped(at("«x»"), "["))).toBe("[«x»]");
    expect(wrapTyped(at("say |"), "`")).toBeNull();
    expect(wrapTyped(at("«hi»"), "a")).toBeNull();
  });

  it("⌘B / ⌘I / ⌘E wrap, and unwrap when already wrapped", () => {
    expect(after("«bold»", wrapShortcut(at("«bold»"), "bold"))).toBe("**«bold»**");
    expect(after("«it»", wrapShortcut(at("«it»"), "italic"))).toBe("_«it»_");
    expect(after("«x»", wrapShortcut(at("«x»"), "code"))).toBe("`«x»`");
    expect(after("**«bold»**", wrapShortcut(at("**«bold»**"), "bold"))).toBe("«bold»");
    // No selection: the key keeps its usual meaning (⌘B shows or hides the sidebar).
    expect(wrapShortcut(at("bold|"), "bold")).toBeNull();
  });
});

describe("pasting a link over a selection", () => {
  it("makes a markdown link", () => {
    expect(after("see «the PR»", pasteLink(at("see «the PR»"), "https://github.com/x/y/pull/9"))).toBe(
      "see [the PR](https://github.com/x/y/pull/9)|",
    );
  });

  it("only for a URL over one line of text", () => {
    expect(pasteLink(at("see |"), "https://x.dev")).toBeNull();
    expect(pasteLink(at("«text»"), "not a url")).toBeNull();
    expect(pasteLink(at("«a\nb»"), "https://x.dev")).toBeNull();
    expect(pasteLink(at("«https://old.dev»"), "https://x.dev")).toBeNull();
  });
});

describe("which keys ask for an edit", () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({ key: "", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...init }) as KeyboardEvent;
  const off = { listOpen: false, mod: false };

  it("Shift+Enter, Tab, marks and the shortcuts; plain Enter sends", () => {
    expect(markdownKey(key({ key: "Enter", shiftKey: true }), at("- a|"), off)).not.toBeNull();
    expect(markdownKey(key({ key: "Enter" }), at("- a|"), off)).toBeNull();
    expect(markdownKey(key({ key: "Tab" }), at("- a|"), off)).not.toBeNull();
    expect(markdownKey(key({ key: "*", shiftKey: true }), at("«a»"), off)).not.toBeNull();
    expect(markdownKey(key({ key: "b", metaKey: true }), at("«a»"), { listOpen: false, mod: true })).not.toBeNull();
  });

  it("leaves the keys to an open suggestion list and to an IME", () => {
    expect(markdownKey(key({ key: "Tab" }), at("- a|"), { listOpen: true, mod: false })).toBeNull();
    expect(markdownKey(key({ key: "Enter", shiftKey: true, isComposing: true }), at("- a|"), off)).toBeNull();
  });
});

describe("applyEdit", () => {
  it("changes the textarea, tells React, and sets the selection", () => {
    const el = document.createElement("textarea");
    document.body.append(el);
    el.value = "- one";
    let inputs = 0;
    el.addEventListener("input", () => inputs++);
    applyEdit(el, { from: 5, to: 5, insert: "\n- ", selStart: 8, selEnd: 8 });
    expect(el.value).toBe("- one\n- ");
    expect([el.selectionStart, el.selectionEnd]).toEqual([8, 8]);
    expect(inputs).toBeGreaterThan(0);
    el.remove();
  });
});
