// What every diff view shares about lines: tabs 4 wide, fixed row heights for
// windowing, the wrap preference, and finding a hunk to scroll to.
import { useState } from "react";
import type { DiffFile, Hunk, Line } from "@/components/diff/model";

/** Columns a tab takes. Browsers default to 8, which turns tab-indented code into a staircase. */
export const TAB = 4;
/** Height of one row (a hunk header or a line) when lines don't wrap. */
export const ROW = 20;
/** Rows drawn above and below what's on screen. */
export const OVERSCAN = 40;
/** Past this many rows a file stays windowed (and unwrapped): wrapped rows have no fixed height to window by. */
export const WRAP_MAX = 3000;

/** The tab size, for the element a diff's text is in. */
export const tabStyle = { tabSize: TAB, MozTabSize: TAB } as const;

/** A line's leading whitespace, the rest, and how many columns the whitespace takes. */
export function splitIndent(text: string): { indent: string; rest: string; cols: number } {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? "";
  let cols = 0;
  for (const c of indent) cols = c === "\t" ? cols + TAB - (cols % TAB) : cols + 1;
  return { indent, rest: text.slice(indent.length), cols };
}

const WRAP_KEY = "yaah:diff-wrap";

/** Whether diffs wrap: off by default, remembered on this machine. */
export function useWrap(): [boolean, (wrap: boolean) => void] {
  const [wrap, setWrap] = useState(() => {
    try {
      return localStorage.getItem(WRAP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = (w: boolean) => {
    setWrap(w);
    try {
      localStorage.setItem(WRAP_KEY, w ? "1" : "0");
    } catch {
      // Not remembered; still applies here.
    }
  };
  return [wrap, set];
}

export type Row = { hunk: number; line?: Line };

/** A file's hunks as rows: each hunk's header, then its lines; and where each hunk starts. */
export function rowsOf(file: DiffFile): { rows: Row[]; starts: number[] } {
  const rows: Row[] = [];
  const starts: number[] = [];
  file.hunks.forEach((h, i) => {
    starts.push(rows.length);
    rows.push({ hunk: i });
    for (const line of h.lines) rows.push({ hunk: i, line });
  });
  return { rows, starts };
}

/**
 * Where to scroll `body` so hunk `index` sits just under the file's sticky header
 * (`[data-sticky]`): from the drawn header when it is in the DOM, else from its row.
 */
export function hunkTop(body: HTMLElement, starts: number[], index: number): number {
  const rows = body.querySelector<HTMLElement>("[data-rows]");
  const sticky = body.querySelector<HTMLElement>("[data-sticky]")?.offsetHeight ?? 0;
  const top = rows?.offsetTop ?? 0;
  const header = rows?.querySelector<HTMLElement>(`[data-hunk-header="${index}"]`);
  if (rows?.dataset.wrapped === "true" && header) return top + header.offsetTop - sticky;
  return top + (starts[index] ?? 0) * ROW - sticky;
}

/** A hunk as unified diff text (its header and lines), for the clipboard or a message. */
export function hunkText(hunk: Hunk): string {
  return [hunk.header, ...hunk.lines.map((l) => `${l.kind}${l.text}`)].join("\n");
}
