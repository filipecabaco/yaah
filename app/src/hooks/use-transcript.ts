// One chat's transcript, read from the app's TranscriptStore. Only the component
// that calls this re-renders when that chat changes.
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import type { Transcript, TranscriptStore } from "@/lib/transcripts";

export const TranscriptsContext = createContext<TranscriptStore | null>(null);

export function useTranscripts(): TranscriptStore {
  const store = useContext(TranscriptsContext);
  if (!store) throw new Error("useTranscript outside a TranscriptsContext");
  return store;
}

/** The chat's transcript (undefined while it loads); opening it here loads it and keeps it in memory. */
export function useTranscript(sessionId: string): Transcript | undefined {
  const store = useTranscripts();
  const subscribe = useCallback((cb: () => void) => store.subscribe(sessionId, cb), [store, sessionId]);
  const t = useSyncExternalStore(subscribe, () => store.get(sessionId));
  useEffect(() => store.open(sessionId), [store, sessionId]);
  return t;
}
