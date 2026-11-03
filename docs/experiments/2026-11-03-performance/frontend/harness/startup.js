// Evaluated in the page after load: startup timings from the browser's own buffers.
// Long animation frames (LoAF) and LCP come from buffered PerformanceObservers.
(async () => {
  const buffered = (type) =>
    new Promise((resolve) => {
      const out = [];
      try {
        const po = new PerformanceObserver((l) => out.push(...l.getEntries()));
        po.observe({ type, buffered: true });
        setTimeout(() => (po.disconnect(), resolve(out)), 300);
      } catch {
        resolve(out);
      }
    });
  const nav = performance.getEntriesByType("navigation")[0];
  const paints = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, +p.startTime.toFixed(1)]));
  const lcp = await buffered("largest-contentful-paint");
  const loaf = await buffered("long-animation-frame");
  const res = performance.getEntriesByType("resource");
  const js = res.filter((r) => r.name.endsWith(".js"));
  const css = res.filter((r) => r.name.endsWith(".css"));
  const fonts = res.filter((r) => /woff2?$/.test(r.name));
  const last = lcp[lcp.length - 1];
  return {
    url: location.href,
    domContentLoaded: +nav.domContentLoadedEventEnd.toFixed(1),
    load: +nav.loadEventEnd.toFixed(1),
    ...paints,
    lcp: last ? { t: +last.startTime.toFixed(1), el: last.element?.tagName + "." + (last.element?.className || "").toString().slice(0, 40), size: last.size } : null,
    jsFiles: js.length,
    jsLastResponseEnd: +Math.max(...js.map((r) => r.responseEnd)).toFixed(1),
    jsDecodedKB: +(js.reduce((s, r) => s + r.decodedBodySize, 0) / 1000).toFixed(1),
    cssDecodedKB: +(css.reduce((s, r) => s + r.decodedBodySize, 0) / 1000).toFixed(1),
    fonts: fonts.map((f) => f.name.split("/").pop()),
    longFrames: loaf.map((f) => ({
      start: +f.startTime.toFixed(0),
      dur: +f.duration.toFixed(0),
      blocking: +f.blockingDuration.toFixed(0),
      scripts: f.scripts
        .slice(0, 3)
        .map((s) => `${(s.sourceURL || "").split("/").pop()}:${s.sourceFunctionName || s.invoker} ${s.duration.toFixed(0)}ms`),
    })),
    perfMarks: window.__perfMarks ?? null,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null,
    domNodes: document.getElementsByTagName("*").length,
  };
})();
