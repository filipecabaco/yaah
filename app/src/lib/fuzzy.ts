// One fuzzy matcher for every search box: repo picker, command palette, slash commands.

/** How well `query` matches `target`: 0 is no match, higher is better. Case-insensitive. */
export function fuzzyScore(query: string, target: string | null | undefined): number {
  const q = query.trim().toLowerCase();
  const t = (target ?? "").toLowerCase();
  if (!q) return 1;
  if (!t) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 300 - at;
  // Subsequence with a bonus for consecutive hits.
  let qi = 0;
  let last = -2;
  let bonus = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (ti === last + 1) bonus += 5;
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? 50 + bonus - t.length / 10 : 0;
}

/** Best score over several fields; earlier fields weigh more. */
export function fuzzyBest(query: string, fields: (string | null | undefined)[]): number {
  return Math.max(0, ...fields.map((f, i) => fuzzyScore(query, f) * (fields.length - i)));
}

/** Items that match, best first. An empty query keeps the original order. */
export function fuzzyRank<T>(items: T[], query: string, fields: (item: T) => (string | null | undefined)[]): T[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, s: fuzzyBest(query, fields(item)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.item);
}

/**
 * The best `limit` matches, best first, with the best score (0: nothing matched) and how many
 * were left out. An empty query keeps the original order.
 */
export function rankTop<T>(
  items: T[],
  query: string,
  fields: (item: T) => (string | null | undefined)[],
  limit = Infinity,
): { shown: T[]; best: number; more: number } {
  if (!query.trim()) return { shown: items.slice(0, limit), best: 1, more: Math.max(0, items.length - limit) };
  const scored = items.map((item) => ({ item, s: fuzzyBest(query, fields(item)) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  return { shown: scored.slice(0, limit).map((x) => x.item), best: scored[0]?.s ?? 0, more: Math.max(0, scored.length - limit) };
}
