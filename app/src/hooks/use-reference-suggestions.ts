// The composer's `#` list: asks Rust (references.rs) as the user types, after a
// pause, and meanwhile narrows the last answer with the same fuzzy match Rust
// ranks with, so the list follows every keystroke without a request for each.
import { useEffect, useState } from "react";
import { api, type Reference, type ReferenceService, type ReferenceSuggestions } from "@/lib/api";
import { fuzzyBest } from "@/lib/fuzzy";

/** A pause in typing this long sends the query (an empty one goes at once). */
export const REFERENCE_DEBOUNCE_MS = 250;

export type ReferenceWant = { service: ReferenceService | null; query: string; link: boolean };

export type ReferenceList = {
  /** Null until the first answer for this service. */
  items: Reference[] | null;
  /** The services asked for that are connected; null until known. */
  connected: ReferenceService[] | null;
  errors: ReferenceSuggestions["errors"];
  /** An answer for what's typed now is still coming. */
  pending: boolean;
};

type Answer = { key: string; service: ReferenceService | null; query: string; result: ReferenceSuggestions };

const keyOf = (sessionId: string, w: ReferenceWant) => `${sessionId}|${w.service ?? "*"}|${w.query}`;

export function useReferenceSuggestions(sessionId: string, want: ReferenceWant | null): ReferenceList {
  const [last, setLast] = useState<Answer | null>(null);
  const key = want ? keyOf(sessionId, want) : null;
  const service = want?.service ?? null;
  const query = want?.query ?? "";

  useEffect(() => {
    if (key == null) return;
    let stale = false;
    const t = setTimeout(
      () => {
        api.referenceSuggestions(sessionId, service, query).then(
          (result) => !stale && setLast({ key, service, query, result }),
          (e: unknown) => {
            if (stale) return;
            console.error("reference search failed", e);
            setLast({ key, service, query, result: { items: [], connected: [], errors: [] } });
          },
        );
      },
      query ? REFERENCE_DEBOUNCE_MS : 0,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [key, sessionId, service, query]);

  if (!want) return { items: null, connected: null, errors: [], pending: false };
  if (last?.key === key) return { items: last.result.items, connected: last.result.connected, errors: last.result.errors, pending: false };
  // Same list, another query: what was shown, narrowed now and kept in Rust's order (so rows don't
  // jump when its answer for this query replaces them).
  if (last && last.service === service && !want.link && last.key.startsWith(`${sessionId}|`)) {
    const items = last.result.items.filter((r) => fuzzyBest(query, [r.id, r.title, r.scope, r.token]) > 0);
    return { items, connected: last.result.connected, errors: last.result.errors, pending: true };
  }
  return { items: null, connected: null, errors: [], pending: true };
}
