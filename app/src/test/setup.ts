// Test environment: jest-dom matchers, a clean DOM between tests, and the few
// browser APIs happy-dom leaves out that Radix and the app reach for.
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// The browser mock stops first (if a test installed it), so nothing it was still streaming
// reaches a listener that cleanup has just removed (Tauri logs "Couldn't find callback id").
afterEach(() => {
  (globalThis as { __yaahDisposeMock?: () => void }).__yaahDisposeMock?.();
  cleanup();
});
// Views and dialogs the app doesn't need at startup load on first use (a dynamic import, which
// vitest transforms the first time): give a `findBy…` time for that.
configure({ asyncUtilTimeout: 5000 });

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;
// Radix calls these on pointer and focus moves; happy-dom has no layout to act on.
const missing = { scrollIntoView: () => undefined, hasPointerCapture: () => false, releasePointerCapture: () => undefined };
for (const [name, value] of Object.entries(missing))
  if (!(name in Element.prototype)) Object.defineProperty(Element.prototype, name, { value, configurable: true });

// Node 26 claims the `localStorage` global for its own Web Storage (off without
// --localstorage-file), which hides happy-dom's. An in-memory one, as a browser has.
// (Checked through its descriptor: reading Node's getter prints a warning.)
const nodeStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!nodeStorage || nodeStorage.get) {
  class MemoryStorage implements Storage {
    private items = new Map<string, string>();
    get length() {
      return this.items.size;
    }
    clear() {
      this.items.clear();
    }
    getItem(key: string) {
      return this.items.get(key) ?? null;
    }
    key(i: number) {
      return [...this.items.keys()][i] ?? null;
    }
    removeItem(key: string) {
      this.items.delete(key);
    }
    setItem(key: string, value: string) {
      this.items.set(key, String(value));
    }
  }
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
}
