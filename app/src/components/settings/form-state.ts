// State helpers the Settings editors share: one async action at a time, and
// key/value rows (env, headers) with stable ids so React keeps each row's
// input when another is removed.
import { useCallback, useState } from "react";

/** Runs one action at a time: which one is running, and what the last one failed with. `run` never rejects. */
export function useAction<K extends string>() {
  const [busy, setBusy] = useState<K | null>(null);
  const [failed, setFailed] = useState<{ during: K; error: unknown } | null>(null);
  const run = useCallback(async (kind: K, f: () => Promise<unknown>): Promise<void> => {
    setBusy(kind);
    setFailed(null);
    try {
      await f();
    } catch (error) {
      setFailed({ during: kind, error });
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, failed, run };
}

export type Pair = { id: number; name: string; value: string };

let lastPairId = 0;
export const newPair = (name = "", value = ""): Pair => ({ id: ++lastPairId, name, value });
export const toPairs = (record: Record<string, string>): Pair[] => Object.entries(record).map(([name, value]) => newPair(name, value));
/** Rows with a name, as a record (blank rows are dropped). */
export const fromPairs = (rows: Pair[]): Record<string, string> =>
  Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name, r.value]));

/** Whether a Postgres connection's name and URL are worth testing; Rust checks them for real. */
export const connectionReady = (name: string, url: string) => /^[a-z][a-z0-9-]{1,31}$/.test(name) && /^postgres(ql)?:\/\//.test(url.trim());
