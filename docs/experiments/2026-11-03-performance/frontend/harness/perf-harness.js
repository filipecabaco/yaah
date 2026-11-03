// In-page harness for the yaah frontend performance review (2026-11-03).
// Loaded into a page served by the browser mock (prod React + mock, or `pnpm dev`) with
//   await import("/perf-harness.js")
// It drives the app only through what Rust would do: `session-entry` / `session-info` events
// through the mocked Tauri IPC (window.__TAURI_INTERNALS__), and DOM clicks.
// Nothing here changes app code.

const T = () => window.__TAURI_INTERNALS__;
export const invoke = (cmd, args) => T().invoke(cmd, args);
/** Same path as `emit()` from @tauri-apps/api/event under mockIPC: listeners run synchronously. */
export const emit = (event, payload) => T().invoke("plugin:event|emit", { event, payload });

const mc = new MessageChannel();
const q = [];
mc.port1.onmessage = () => q.shift()?.();
/** One macrotask hop that queues behind React's scheduler task (also a MessageChannel). */
export const hop = () => new Promise((r) => (q.push(r), mc.port2.postMessage(0)));
export const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2) : null;
};
const mean = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null);
export const stats = (xs) => ({ n: xs.length, mean: mean(xs), p50: pct(xs, 50), p95: pct(xs, 95), max: pct(xs, 100) });

// ── realistic agent Markdown ────────────────────────────────────────────────
const BLOCKS = [
  "## Findings\n\nThe retry loop in `src/billing/invoice.ts` re-reads the **whole** ledger on every attempt, so a slow tenant multiplies the cost. See [the ACP spec](https://agentclientprotocol.com) for the expected back-off.\n\n",
  "- `computeTotals()` walks every line item twice\n- `applyTax()` allocates a new `Map` per call\n- the cache key ignores the currency, so *EUR* and *USD* collide\n\n",
  "```ts\nexport function computeTotals(lines: Line[]): Totals {\n  let net = 0;\n  for (const l of lines) net += l.qty * l.unit;\n  return { net, tax: net * 0.23, gross: net * 1.23 };\n}\n```\n\n",
  "| file | lines | change |\n|---|---:|---|\n| invoice.ts | 120 | split the loop |\n| tax.ts | 48 | memoise rates |\n| currency.ts | 30 | key by code |\n\n",
  "1. Read the ledger once per request.\n2. Cache the tax table per region, invalidated on deploy.\n3. Add a regression test with 10k line items so this can't come back.\n\n",
  "> Note: the migration `0042_pricing.sql` must run before the new code ships, otherwise the `plan_id` column is missing and every invoice fails with a 500.\n\n",
];
export function markdown(len, seed = 0) {
  let s = "";
  let i = seed;
  while (s.length < len) s += BLOCKS[i++ % BLOCKS.length];
  return s.slice(0, len);
}

// ── chats ───────────────────────────────────────────────────────────────────
let agentId;
async function agent() {
  agentId ??= (await invoke("list_agents")).defaultId;
  return agentId;
}

/** A quick chat the app knows about (as Rust would emit it), titled `title`. */
export async function newChat(title) {
  const info = await invoke("new_quick_chat", { accountId: await agent(), dir: null });
  info.title = title;
  emit("session-info", info);
  await hop();
  await hop();
  return info;
}

/** Open a chat by clicking its row in the sidebar. */
export async function openChat(title) {
  const el = [...document.querySelectorAll("aside button, aside a, aside [role=button]")].find((b) => b.textContent.trim() === title);
  if (!el) throw new Error(`no sidebar row ${title}`);
  el.click();
  await frame();
  await frame();
}

export function entryAt(i, sizes = { agent: 1500, tool: 800 }) {
  switch (i % 4) {
    case 0:
      return { type: "user", text: `Question ${i}: why is the invoice job slow for tenant ${i}?`, attachments: [] };
    case 1:
      return { type: "agent", text: markdown(sizes.agent, i), messageId: null };
    case 2:
      return {
        type: "tool",
        toolCallId: `tc-${i}`,
        title: `Read src/billing/file-${i}.ts`,
        kind: "read",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: markdown(sizes.tool, i).replace(/[#*`|>]/g, "") } }],
        locations: [{ path: `/repo/src/billing/file-${i}.ts` }],
        rawInput: { file_path: `/repo/src/billing/file-${i}.ts` },
      };
    default:
      return { type: "agent", text: markdown(400, i), messageId: null };
  }
}

/** Fill a chat with `n` finished entries, as a restored transcript would arrive. */
export async function seed(sessionId, n, start = 0) {
  for (let i = start; i < start + n; i++) emit("session-entry", { sessionId, index: i, entry: entryAt(i) });
  await frame();
  await frame();
}

export const scroller = () => document.querySelector('[role="log"]')?.parentElement;

/**
 * One streamed chunk, timed:
 *  js     = emit → React render + commit + passive effects (the auto-scroll effect forces layout here)
 *  layout = any style/layout still pending afterwards
 *  frame  = emit → the next frame has been produced
 */
export async function chunk(payload) {
  const t0 = performance.now();
  emit("session-entry", payload);
  await hop();
  await hop();
  await hop();
  const t1 = performance.now();
  void document.body.offsetHeight;
  const t2 = performance.now();
  await frame();
  const t3 = performance.now();
  return { js: t1 - t0, layout: t2 - t1, total: t2 - t0, frame: t3 - t0 };
}

/**
 * Per-chunk cost of growing entry `index` (an agent message by default) at the given sizes:
 * jump to each size, then time `samples` consecutive chunks of `step` characters.
 */
export async function growth(sessionId, index, { sizes = [1000, 10000, 50000], samples = 25, step = 24, type = "agent" } = {}) {
  const full = markdown(Math.max(...sizes) + samples * step + 10, 7);
  const out = {};
  const make = (len) =>
    type === "agent" || type === "thought" ? { type, text: full.slice(0, len), messageId: null } : { type: "user", text: full.slice(0, len), attachments: [] };
  for (const size of sizes) {
    await chunk({ sessionId, index, entry: make(size) });
    await frame();
    const rows = [];
    for (let k = 1; k <= samples; k++) rows.push(await chunk({ sessionId, index, entry: make(size + k * step) }));
    out[size] = {
      total: stats(rows.map((r) => r.total)),
      js: stats(rows.map((r) => r.js)),
      frame: stats(rows.map((r) => r.frame)),
      domNodes: document.querySelectorAll('[role="log"] *').length,
    };
  }
  return out;
}

/** JSON size and parse cost of one `session-entry` payload at a given message length (what Tauri ships per chunk). */
export function ipcCost(lengths = [1000, 10000, 50000], reps = 50) {
  const out = {};
  for (const len of lengths) {
    const json = JSON.stringify({ event: "session-entry", payload: { sessionId: "x", index: 3, entry: { type: "agent", text: markdown(len), messageId: null } } });
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) JSON.parse(json);
    out[len] = { bytes: json.length, parseMs: +((performance.now() - t0) / reps).toFixed(3) };
  }
  return out;
}

/**
 * A whole reply streamed at a fixed cadence (as the agent would), without waiting for React:
 * long animation frames and wall time tell whether the UI keeps up.
 */
export async function liveStream(sessionId, index, { length = 50000, step = 24, everyMs = 16, from = 0 } = {}) {
  const full = markdown(length, 3);
  const frames = [];
  const po = new PerformanceObserver((l) => frames.push(...l.getEntries()));
  po.observe({ type: "long-animation-frame" });
  let rafs = 0;
  let on = true;
  const gaps = [];
  let prev = performance.now();
  const counter = (t) => {
    if (!on) return;
    rafs++;
    gaps.push(t - prev);
    prev = t;
    requestAnimationFrame(counter);
  };
  requestAnimationFrame(counter);
  // One MutationObserver callback per React commit that touched the transcript.
  let commits = 0;
  const mo = new MutationObserver(() => commits++);
  mo.observe(document.querySelector('[role="log"]'), { subtree: true, childList: true, characterData: true });
  const t0 = performance.now();
  let lag = 0;
  for (let len = from + step, k = 0; len <= length; len += step, k++) {
    emit("session-entry", { sessionId, index, entry: { type: "agent", text: full.slice(0, len), messageId: null } });
    const due = t0 + (k + 1) * everyMs;
    const now = performance.now();
    if (due > now) await sleep(due - now);
    else {
      lag = now - due;
      await hop();
    }
  }
  await frame();
  const wall = performance.now() - t0;
  on = false;
  po.disconnect();
  mo.disconnect();
  const chunks = Math.floor((length - from) / step);
  return {
    chunks,
    commits,
    rafGapMs: stats(gaps.slice(1)),
    framesOver33ms: gaps.filter((g) => g > 33.4).length,
    idealMs: chunks * everyMs,
    wallMs: +wall.toFixed(0),
    finalLagMs: +lag.toFixed(0),
    fps: +((rafs / wall) * 1000).toFixed(1),
    longFrames: frames.length,
    longFrameMs: +frames.reduce((s, f) => s + f.duration, 0).toFixed(0),
    worstFrameMs: +Math.max(0, ...frames.map((f) => f.duration)).toFixed(0),
  };
}

/** Frame times while scrolling the transcript from bottom to top in `steps` rAF steps. */
export async function scrollTest(steps = 120) {
  const el = scroller();
  el.scrollTop = el.scrollHeight;
  await frame();
  const dist = el.scrollHeight - el.clientHeight;
  const times = [];
  const frames = [];
  const po = new PerformanceObserver((l) => frames.push(...l.getEntries()));
  po.observe({ type: "long-animation-frame" });
  let last = performance.now();
  for (let i = 1; i <= steps; i++) {
    el.scrollTop = dist - (dist * i) / steps;
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    times.push(now - last);
    last = now;
  }
  po.disconnect();
  return { scrollHeight: el.scrollHeight, frameMs: stats(times), longFrames: frames.length, worstFrameMs: +Math.max(0, ...frames.map((f) => f.duration)).toFixed(0) };
}

export const heapMB = () => (performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null);

window.perf = { invoke, emit, hop, frame, sleep, stats, markdown, newChat, openChat, seed, entryAt, chunk, growth, ipcCost, liveStream, scrollTest, scroller, heapMB };

// ── agent UI ────────────────────────────────────────────────────────────────

export const uiEntry = (tree, props = {}) => ({ type: "ui", askId: null, answer: null, title: null, component: null, version: null, tree, props });

export async function waitFor(pred, ms = 10000) {
  const s = performance.now();
  while (!pred()) {
    if (performance.now() - s > ms) return false;
    await new Promise((r) => setTimeout(r, 1));
  }
  return true;
}

/** The `figure` of transcript entry `index` (entries render in order, one top-level child each). */
export const figureAt = (index) => document.querySelector('[role="log"]')?.children[index] ?? null;

/** Render (or re-render) a UI entry and time it until no placeholder is left in it and `ready` holds. */
export async function renderUi(sessionId, index, tree, { props = {}, ready = () => true } = {}) {
  const t0 = performance.now();
  emit("session-entry", { sessionId, index, entry: uiEntry(tree, props) });
  await hop();
  await hop();
  const t1 = performance.now();
  const ok = await waitFor(() => {
    const f = figureAt(index);
    return f && !f.querySelector(".animate-pulse") && ready(f);
  });
  await frame();
  const f = figureAt(index);
  return { ok, firstCommitMs: +(t1 - t0).toFixed(1), readyMs: +(performance.now() - t0).toFixed(1), nodes: f ? f.querySelectorAll("*").length : 0 };
}

export const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i, name: `customer-${i}`, plan: ["free", "pro", "team"][i % 3], mrr: (i * 37) % 900, region: ["eu", "us", "ap"][i % 3] }));
export const tableTree = (n) => ({
  type: "table",
  props: { columns: [{ key: "id", label: "ID" }, { key: "name", label: "Name" }, { key: "plan", label: "Plan" }, { key: "mrr", label: "MRR", align: "right" }, { key: "region", label: "Region" }], rows: rows(n) },
});
export const paths = (n) => Array.from({ length: n }, (_, i) => `src/mod${Math.floor(i / 300)}/pkg${Math.floor(i / 30) % 10}/file${i % 30}.ts`);
export function flowchart(n) {
  const lines = ["flowchart LR"];
  for (let i = 1; i < n; i++) lines.push(`  n${Math.floor((i - 1) / 2)}[Service ${Math.floor((i - 1) / 2)}] --> n${i}[Service ${i}]`);
  return lines.join("\n");
}
export function patchText(files, linesPerFile) {
  const out = [];
  for (let f = 0; f < files; f++) {
    const removed = Array.from({ length: Math.floor(linesPerFile / 3) }, (_, k) => `-  const old${k} = legacy(${k});`);
    const added = Array.from({ length: linesPerFile }, (_, k) => `+  const price${k} = pricing.for(plan, ${k}); // file ${f}`);
    out.push(`diff --git a/src/f${f}.ts b/src/f${f}.ts\n--- a/src/f${f}.ts\n+++ b/src/f${f}.ts\n@@ -10,${removed.length + 2} +10,${added.length + 2} @@\n export function compute() {\n${removed.join("\n")}\n${added.join("\n")}\n   return total;\n }`);
  }
  return out.join("\n");
}
export const liveChart = (every = 2000, history = 60) => ({
  type: "live",
  props: { source: { kind: "system" }, every, history },
  children: [{ type: "chart", props: { kind: "line", data: "{{history}}", x: "t", series: [{ key: "cpu", label: "CPU" }], unit: "%" } }],
});

/** Counts IPC calls by command while `ms` pass. */
export async function countIpc(ms) {
  const inner = T().invoke;
  const counts = {};
  T().invoke = (cmd, args, o) => ((counts[cmd] = (counts[cmd] ?? 0) + 1), inner(cmd, args, o));
  await sleep(ms);
  T().invoke = inner;
  return counts;
}

Object.assign(window.perf, { uiEntry, waitFor, figureAt, renderUi, rows, tableTree, paths, flowchart, patchText, liveChart, countIpc });
