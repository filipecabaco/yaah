// Search boxes the agent can fill: a block's `find` prop starts the query, so
// the agent can point at where something is ("the refund code is here").
// The user can change it; a new `find` from the agent (an in-place re-render)
// takes over again.
import { useState } from "react";

export function useFind(find?: string): [string, (q: string) => void] {
  const fromAgent = find ?? "";
  const [query, setQuery] = useState(fromAgent);
  // Adjust during render when the agent's value changes (no effect, no extra paint).
  const [seen, setSeen] = useState(fromAgent);
  if (seen !== fromAgent) {
    setSeen(fromAgent);
    setQuery(fromAgent);
  }
  return [query, setQuery];
}
