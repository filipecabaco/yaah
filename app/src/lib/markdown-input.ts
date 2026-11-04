// Markdown help while typing a message: lists that continue on a new line, Tab to indent a
// list item, a selection wrapped in the mark typed over it (or ⌘B / ⌘I / ⌘E), a closing
// fence after ```, and a URL pasted over a selection made into a link.
//
// Every helper is pure: it takes the text and the selection and returns the edit to make
// (or null to leave the key alone). `applyEdit` makes it through the browser's own
// insert-text command, so ⌘Z undoes it like typing.

/** Replace `from`–`to` with `insert`, then select `selStart`–`selEnd`. */
export type Edit = { from: number; to: number; insert: string; selStart: number; selEnd: number };
type Sel = { text: string; start: number; end: number };

const INDENT = "  ";
/** A list or quote line: indent, then the marker ("- ", "* ", "+ ", "3. ", "3) ", "- [ ] ", "> "). */
const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))( \[[ xX]\])?( +)|^(\s*)(>+ ?)/;

function lineAt(text: string, pos: number) {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const nl = text.indexOf("\n", pos);
  return { start, end: nl === -1 ? text.length : nl };
}

/** Inside a fenced code block at `pos` (an odd number of fence lines before it). */
function inFence(text: string, pos: number): boolean {
  const before = text.slice(0, lineAt(text, pos).start);
  return (before.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 === 1;
}

/** The marker the next line takes: the same bullet, the next number, an unchecked box, the quote. */
function nextMarker(m: RegExpExecArray): { indent: string; marker: string } {
  if (m[8] !== undefined) return { indent: m[7], marker: m[8] };
  const box = m[5] ? " [ ]" : "";
  const bullet = m[2] ?? `${Number(m[3]) + 1}${m[4]}`;
  return { indent: m[1], marker: `${bullet}${box}${m[6]}` };
}

/**
 * A new line (Shift+Enter): continue the list or quote the caret is in; on an item with nothing
 * after its marker, end the list instead. After an opening ``` fence, add the closing one.
 */
export function newLine({ text, start, end }: Sel): Edit | null {
  if (start !== end) return null;
  const line = lineAt(text, start);
  const head = text.slice(line.start, start);
  // An opening fence (with or without a language) at the end of its line: close it.
  const fence = /^(\s*)(```|~~~)[\w+-]*$/.exec(head);
  if (fence && start === line.end && !inFence(text, start)) {
    const open = `\n${fence[1]}`;
    return { from: start, to: end, insert: `${open}\n${fence[1]}${fence[2]}`, selStart: start + open.length, selEnd: start + open.length };
  }
  if (inFence(text, start)) return null;
  const m = ITEM.exec(head);
  if (!m) return null;
  const rest = text.slice(line.start + m[0].length, line.end);
  // Nothing after the marker: the list is over, the marker goes.
  if (!rest.trim() && start >= line.start + m[0].length) {
    return { from: line.start, to: line.end, insert: "", selStart: line.start, selEnd: line.start };
  }
  // The caret inside the marker itself: a plain new line.
  if (start < line.start + m[0].length) return null;
  const { indent, marker } = nextMarker(m);
  const insert = `\n${indent}${marker}`;
  return { from: start, to: end, insert, selStart: start + insert.length, selEnd: start + insert.length };
}

/** Tab / Shift+Tab on list lines: indent or outdent every selected item. Elsewhere Tab moves focus. */
export function indent({ text, start, end }: Sel, out: boolean): Edit | null {
  const first = lineAt(text, start).start;
  const last = lineAt(text, Math.max(start, end - (end > start && text[end - 1] === "\n" ? 1 : 0))).end;
  const lines = text.slice(first, last).split("\n");
  if (!lines.every((l) => ITEM.test(l) || !l.trim()) || !lines.some((l) => ITEM.test(l))) return null;
  let shiftStart = 0;
  let shiftEnd = 0;
  const changed = lines.map((l, i) => {
    if (!l.trim()) return l;
    const cut = out ? Math.min(INDENT.length, /^ */.exec(l)![0].length) : 0;
    const by = out ? -cut : INDENT.length;
    if (i === 0) shiftStart = by;
    shiftEnd += by;
    return out ? l.slice(cut) : INDENT + l;
  });
  if (out && shiftEnd === 0) return null;
  const insert = changed.join("\n");
  return {
    from: first,
    to: last,
    insert,
    selStart: Math.max(first, start + shiftStart),
    selEnd: Math.max(first, end + shiftEnd),
  };
}

const PAIRS: Record<string, string> = { "`": "`", "*": "*", _: "_", "~": "~", '"': '"', "(": ")", "[": "]" };

/** Typing a mark over a selection wraps it: `code`, *em*, (aside). Without a selection, null. */
export function wrapTyped({ text, start, end }: Sel, key: string): Edit | null {
  const close = PAIRS[key];
  if (!close || start === end) return null;
  return wrap({ text, start, end }, key, close);
}

/** ⌘B, ⌘I, ⌘E: **bold**, _italic_, `code` around the selection, or off again when it's already wrapped. */
export function wrapShortcut(sel: Sel, kind: "bold" | "italic" | "code"): Edit | null {
  if (sel.start === sel.end) return null;
  const mark = { bold: "**", italic: "_", code: "`" }[kind];
  return wrap(sel, mark, mark, true);
}

function wrap({ text, start, end }: Sel, open: string, close: string, toggle = false): Edit {
  const inner = text.slice(start, end);
  if (toggle && text.slice(start - open.length, start) === open && text.slice(end, end + close.length) === close) {
    const from = start - open.length;
    return { from, to: end + close.length, insert: inner, selStart: from, selEnd: from + inner.length };
  }
  return { from: start, to: end, insert: `${open}${inner}${close}`, selStart: start + open.length, selEnd: end + open.length };
}

/** A URL pasted over selected text: [text](url). */
export function pasteLink({ text, start, end }: Sel, pasted: string): Edit | null {
  const url = pasted.trim();
  if (start === end || !/^https?:\/\/\S+$/.test(url)) return null;
  const label = text.slice(start, end);
  if (label.includes("\n") || /^https?:\/\//.test(label)) return null;
  const insert = `[${label}](${url})`;
  return { from: start, to: end, insert, selStart: start + insert.length, selEnd: start + insert.length };
}

/**
 * Make the edit in the textarea through the browser's insert-text command, so it lands on the
 * undo stack, and tell React (an `input` event follows). Without that command, sets the value and sends `input` itself.
 */
export function applyEdit(el: HTMLTextAreaElement, edit: Edit) {
  el.focus();
  el.setSelectionRange(edit.from, edit.to);
  // Deprecated but still the only way to keep native undo in a textarea (WebKit, Chromium, Gecko).
  const done = edit.insert ? document.execCommand?.("insertText", false, edit.insert) : document.execCommand?.("delete");
  if (!done) {
    // The prototype's setter, not `el.value =`: React tracks the element's own, and would then see
    // no change and put the old text back on its next render.
    const next = el.value.slice(0, edit.from) + edit.insert + el.value.slice(edit.to);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.setSelectionRange(edit.selStart, edit.selEnd);
}

/**
 * The edit a keydown in the message box asks for, if any. `listOpen`: a suggestion list has the
 * arrows, Enter and Tab. Enter sends the message, so a new line is Shift+Enter.
 */
export function markdownKey(e: KeyboardEvent, sel: Sel, opts: { listOpen: boolean; mod: boolean }): Edit | null {
  if (e.isComposing) return null;
  if (opts.mod && !e.altKey && !e.shiftKey) {
    const kind = ({ b: "bold", i: "italic", e: "code" } as const)[e.key.toLowerCase() as "b" | "i" | "e"];
    return kind ? wrapShortcut(sel, kind) : null;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (opts.listOpen) return null;
  if (e.key === "Enter" && e.shiftKey) return newLine(sel);
  if (e.key === "Tab") return indent(sel, e.shiftKey);
  // A printable key over a selection (Shift is how most layouts type * _ ~ " ( ).
  return e.key.length === 1 ? wrapTyped(sel, e.key) : null;
}
