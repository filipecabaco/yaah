// Reduced motion (MO-1): index.css stops spinners and dialog animations under
// `prefers-reduced-motion`; scrolls asked for in script follow it here, as CSS can't reach them.

/** `"smooth"`, or `"auto"` (a jump) when the system asks for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
