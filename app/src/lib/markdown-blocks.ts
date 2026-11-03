// Splits Markdown into top-level blocks that render the same one by one as the
// whole text does, so a streamed reply re-parses only its last block.
//
// A block ends at a blank line outside a code fence, unless what follows could
// still belong to it:
// - an indented line (list item continuation, indented code);
// - a list item after a block holding a list (one loose list, not two lists).
// A text with link reference definitions or footnotes (`[x]: …`) isn't split,
// since a definition anywhere applies to the whole document.

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^ {0,3}([-+*]|\d{1,9}[.)])( |\t|$)/;
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

export function splitBlocks(text: string): string[] {
  if (DEFINITION.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  /** The open fence: its character and length. */
  let fence: { char: string; size: number } | null = null;
  let hasList = false;
  let blankAt = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const m = FENCE.exec(line);
      if (m && m[1][0] === fence.char && m[1].length >= fence.size && !m[2].trim()) fence = null;
      continue;
    }
    if (!line.trim()) {
      if (blankAt < 0) blankAt = i;
      continue;
    }
    // A line after one or more blank lines: a new block, if it can't continue this one.
    if (blankAt > start && !/^[ \t]/.test(line) && !(hasList && LIST_ITEM.test(line))) {
      blocks.push(lines.slice(start, blankAt).join("\n"));
      start = blankAt;
      hasList = false;
    }
    blankAt = -1;
    const m = FENCE.exec(line);
    // A backtick fence's info string can't hold backticks (then it's inline code).
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) fence = { char: m[1][0], size: m[1].length };
    else if (LIST_ITEM.test(line)) hasList = true;
  }
  blocks.push(lines.slice(start).join("\n"));
  // Blank lines that start a block belong to it, so the blocks join back into the text.
  return blocks;
}
