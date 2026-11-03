// The `diff` and `patch` blocks, and edit tool calls' diffs. In a chunk of their own
// (the diff model and view aren't needed until a chat shows a diff).
import { useMemo } from "react";
import { DiffView } from "@/components/diff/diff-view";
import { diffTexts, parsePatch } from "@/components/diff/model";

/** A diff of two texts (an edit tool call, or a `diff` node). */
export function TextDiffBlock({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  const files = useMemo(() => [diffTexts(path, oldText, newText)], [path, oldText, newText]);
  return <DiffView files={files} />;
}

/** `git diff` / `diff -u` text; anything else shows as it is. */
export function PatchBlock({ text, title }: { text: string; title?: string }) {
  const files = useMemo(() => parsePatch(text), [text]);
  if (files.length === 0) return <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{text || "(empty diff)"}</pre>;
  return <DiffView files={files} title={title} />;
}
