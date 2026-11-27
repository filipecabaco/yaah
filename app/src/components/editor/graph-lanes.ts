// Lanes for the Source Control graph: commits newest first (topological order) become rows,
// each with its node's column and the lines crossing the row. Lanes hold the commit they are
// waiting for; a commit takes the lane waiting for it (else a free one), hands it to its first
// parent and opens lanes for the others, and lanes that waited for it too merge into it.

export type Segment = {
  /** Column at the top of the row, or `null` from the node (a line to a parent). */
  from: number | null;
  /** Column at the bottom of the row, or `null` into the node (a line from a child). */
  to: number | null;
  /** The lane's colour index. */
  color: number;
};
export type Row = { col: number; color: number; segments: Segment[]; width: number };

type Lane = { sha: string; color: number } | null;

export function layoutGraph(commits: { sha: string; parents: string[] }[]): Row[] {
  let lanes: Lane[] = [];
  let nextColor = 0;
  const free = (ls: Lane[]) => {
    const i = ls.indexOf(null);
    return i < 0 ? ls.length : i;
  };
  const rows: Row[] = [];
  for (const c of commits) {
    const before = lanes;
    let col = before.findIndex((l) => l?.sha === c.sha);
    let color: number;
    if (col < 0) {
      col = free(before);
      color = nextColor++;
    } else {
      color = before[col]!.color;
    }
    const after: Lane[] = before.map((l) => (l?.sha === c.sha ? null : l));
    const [first, ...rest] = c.parents;
    if (first) after[col] = { sha: first, color };
    for (const p of rest) {
      if (after.some((l) => l?.sha === p)) continue;
      const at = free(after);
      after[at] = { sha: p, color: nextColor++ };
    }
    while (after.length && after[after.length - 1] === null) after.pop();

    const segments: Segment[] = [];
    before.forEach((l, i) => {
      if (!l) return;
      if (l.sha === c.sha) segments.push({ from: i, to: null, color: l.color });
      else {
        const j = after.findIndex((a) => a?.sha === l.sha);
        if (j >= 0) segments.push({ from: i, to: j, color: l.color });
      }
    });
    for (const p of c.parents) {
      const j = after.findIndex((a) => a?.sha === p);
      if (j >= 0) segments.push({ from: null, to: j, color: after[j]!.color });
    }
    rows.push({ col, color, segments, width: Math.max(before.length, after.length, col + 1) });
    lanes = after;
  }
  return rows;
}
