// Code that loads on first use, but can be fetched ahead of time. A component made
// with `preloadable` renders straight away once its code is in, without suspending
// (React.lazy suspends on first render even when the code is already loaded, and
// React then holds the fallback up for about 300 ms). Before that it suspends like
// React.lazy.
import { createElement, type ComponentType } from "react";

export type Preloadable<P> = ComponentType<P> & {
  /** Fetch the code now; resolves when it's in. */
  preload: () => Promise<unknown>;
  /** The code is in: rendering won't suspend. */
  readonly loaded: boolean;
};

export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>): Preloadable<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = () =>
    (pending ??= load().then(
      (c) => (loaded = c),
      (e: unknown) => {
        // A failed load can be tried again (the next render or preload).
        pending = null;
        throw e;
      },
    ));
  function Preloaded(props: P) {
    // Not loaded yet: suspend the way React.lazy does, by throwing the load (Suspense's own protocol).
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (!loaded) throw preload();
    return createElement(loaded, props);
  }
  return Object.defineProperties(Object.assign(Preloaded, { preload }), {
    loaded: { get: () => loaded !== null },
  }) as Preloadable<P>;
}

/** Runs `f` when the app is idle (Safari's WebKit has no requestIdleCallback: a short timeout there). */
export function whenIdle(f: () => void, timeout = 2000): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(f, { timeout });
    return () => cancelIdleCallback(id);
  }
  const t = setTimeout(f, Math.min(timeout, 500));
  return () => clearTimeout(t);
}

/** Preload each, quietly: a failure shows when the code is really needed. */
export const preloadAll = (list: { preload: () => Promise<unknown> }[]) => Promise.allSettled(list.map((c) => c.preload())).then(() => undefined);
