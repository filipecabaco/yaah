// Monaco for the editor pane, loaded with the pane (never on the app's first paint). Only the
// editor core, its features (find, folding, multi-cursor, the diff editor…) and the Monarch
// grammars: no language services, so one small editor worker and no TypeScript worker.
// The theme is made from the app's CSS variables, so the editor follows the yaah theme and
// light/dark like the terminal does (terminal/theme.ts).
//
// Models are shared by file: two panes on the same file edit one buffer and agree on whether
// it is saved. A pane takes a reference with `acquire` and gives it back with `release`.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
import "monaco-editor/languages/definitions/register.all";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { onThemeChange, readTerminalFont, toHex } from "@/components/terminal/theme";
import { editorApi, type FileRead } from "@/lib/editor-api";

export { monaco };

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// ── theme ───────────────────────────────────────────────────────────────────

const THEME = "yaah";

function applyTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => toHex(s.getPropertyValue(name) || fallback);
  const dark = document.documentElement.classList.contains("dark");
  const bg = v("--background", dark ? "#0a0a0a" : "#ffffff");
  const fg = v("--foreground", dark ? "#fafafa" : "#171717");
  const muted = v("--muted-foreground", "#737373");
  const border = v("--border", "#e5e5e5");
  const accent = v("--accent", dark ? "#262626" : "#f5f5f5");
  const popover = v("--popover", bg);
  monaco.editor.defineTheme(THEME, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      "editorGutter.background": bg,
      "editorLineNumber.foreground": `${muted}99`,
      "editorLineNumber.activeForeground": fg,
      "editor.lineHighlightBackground": `${accent}80`,
      "editor.lineHighlightBorder": "#00000000",
      "editorWidget.background": popover,
      "editorWidget.border": border,
      "editorSuggestWidget.background": popover,
      "editorSuggestWidget.border": border,
      "editorHoverWidget.background": popover,
      "editorHoverWidget.border": border,
      "minimap.background": bg,
      "scrollbarSlider.background": `${muted}33`,
      "scrollbarSlider.hoverBackground": `${muted}55`,
      "editorIndentGuide.background1": `${border}`,
      "diffEditor.border": border,
    },
  });
  monaco.editor.setTheme(THEME);
}

let themed = false;
/** The yaah theme, made once and remade whenever the app's theme changes. */
function ensureTheme() {
  if (themed) return;
  themed = true;
  applyTheme();
  onThemeChange(applyTheme);
}

/** Options every editor of the pane shares: the app's code font and size, VS Code's look otherwise. */
export function baseOptions(): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  ensureTheme();
  const font = readTerminalFont(12.5);
  return {
    theme: THEME,
    fontFamily: font.fontFamily,
    fontSize: font.fontSize,
    lineHeight: Math.round(font.fontSize * 1.55),
    automaticLayout: true,
    minimap: { enabled: true, renderCharacters: false, scale: 1 },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    renderWhitespace: "selection",
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: "active", indentation: true },
    stickyScroll: { enabled: true },
    fixedOverflowWidgets: true,
    padding: { top: 6 },
  };
}

// ── documents ───────────────────────────────────────────────────────────────

export type Doc = {
  /** Absolute path, the registry's key. */
  key: string;
  root: string;
  /** Relative to `root`. */
  path: string;
  model: monaco.editor.ITextModel;
  /** The version on disk the model was read from or last saved as (null: overwrite on save). */
  version: string | null;
  /** The model's alternative version id when it matched the disk: dirty when it differs. */
  savedAt: number;
  readonly: boolean;
  refs: number;
};

const docs = new Map<string, Doc>();
const loading = new Map<string, Promise<Doc | FileRead>>();
const listeners = new Set<() => void>();

export const absPath = (root: string, path: string) => `${root.replace(/\/+$/, "")}/${path}`;

/** Something about a document changed (saved, dirty, reloaded): views re-read `isDirty`. */
export function onDocsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
const changed = () => listeners.forEach((cb) => cb());

export const isDirty = (d: Doc) => !d.model.isDisposed() && d.model.getAlternativeVersionId() !== d.savedAt;

/**
 * The document for file `path` of `root`, read on first use, with a reference taken. A file that
 * can't be edited (binary, too large) comes back as what was read, with no model.
 */
export async function acquire(root: string, path: string): Promise<Doc | FileRead> {
  const key = absPath(root, path);
  const have = docs.get(key);
  if (have && !have.model.isDisposed()) {
    have.refs++;
    return have;
  }
  let p = loading.get(key);
  if (!p) {
    p = editorApi.read(root, path).then((read) => {
      if (read.binary || read.tooLarge) return read;
      const uri = monaco.Uri.file(key);
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(read.text, undefined, uri);
      const doc: Doc = { key, root, path, model, version: read.version, savedAt: model.getAlternativeVersionId(), readonly: read.readonly, refs: 0 };
      model.onDidChangeContent(() => changed());
      docs.set(key, doc);
      return doc;
    });
    loading.set(key, p);
    void p.finally(() => loading.delete(key)).catch(() => {});
  }
  const got = await p;
  if ("model" in got) got.refs++;
  return got;
}

/**
 * Give back a reference. The last one disposes the model, unless it has unsaved edits: those stay
 * for the next pane that opens the file (a pane switched away with ⌘J and back keeps them).
 * `drop`: dispose it anyway (the user chose "Don't Save").
 */
export function release(doc: Doc, drop = false) {
  doc.refs = Math.max(0, doc.refs - 1);
  if (doc.refs > 0 || (isDirty(doc) && !drop)) return;
  docs.delete(doc.key);
  if (!doc.model.isDisposed()) doc.model.dispose();
  changed();
}

/** The open document for a file, if any pane has it. */
export const openDoc = (root: string, path: string) => docs.get(absPath(root, path));

/** Save to disk. Refused with editor-api `CHANGED` when the file moved on since it was read, unless `force`. */
export async function save(doc: Doc, force = false) {
  const at = doc.model.getAlternativeVersionId();
  doc.version = await editorApi.write(doc.root, doc.path, doc.model.getValue(), force ? null : doc.version);
  doc.savedAt = at;
  changed();
}

/**
 * Read the file again when it changed on disk: replaced in place (undo can bring the editor's text
 * back) when the document has no unsaved edits; left alone, and reported, when it has.
 */
export async function refresh(doc: Doc): Promise<"same" | "reloaded" | "conflict" | "gone"> {
  let read: FileRead;
  try {
    read = await editorApi.read(doc.root, doc.path);
  } catch {
    return "gone";
  }
  if (read.version === doc.version || doc.model.isDisposed()) return "same";
  if (isDirty(doc)) return "conflict";
  if (read.text !== doc.model.getValue()) doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: read.text }], () => null);
  doc.version = read.version;
  doc.savedAt = doc.model.getAlternativeVersionId();
  changed();
  return "reloaded";
}

/** Every open document under `root` (for the pane's poll and its close prompt). */
export const docsUnder = (root: string) => [...docs.values()].filter((d) => d.root === root);

/** A read-only model with `text` for the left side of a diff, named so Monaco picks the file's language. */
export function scratchModel(text: string, path: string, tag: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.from({ scheme: "yaah-git", path: `/${tag}/${path}` });
  const old = monaco.editor.getModel(uri);
  if (old) {
    if (old.getValue() !== text) old.setValue(text);
    return old;
  }
  return monaco.editor.createModel(text, undefined, uri);
}
