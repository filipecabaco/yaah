// Test environment: jest-dom matchers, a clean DOM between tests, and the few
// browser APIs happy-dom leaves out that Radix and the app reach for.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

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
