// Before/after measurements for REVIEW 9 (2026-11-03). Loaded after perf-harness.js:
//   await import("/perf-harness.js"); await import("/measure.js")
// `mode`: "entry" streams by re-sending the whole entry (the old protocol, what Rust did before),
// "append" streams with `session-append` (the new protocol). Both builds accept "entry".
const P = window.perf;
const { emit, hop, frame, stats, markdown, openChat, seed, waitFor } = P;
let bump = 0;
/** A chat titled `title`, sorted newest of all (the sidebar shows the newest quick chats). */
async function newChat(title) {
  const list = await P.invoke("list_agents");
  const info = await P.invoke("new_quick_chat", { accountId: list.defaultId, dir: null });
  info.title = title;
  info.createdAt = 4_000_000_000 + ++bump;
  emit("session-info", info);
  await hop();
  await hop();
  return info;
}
const flush = () => window.__yaahFlush?.();
const log = () => document.querySelector('[role="log"]');

async function step(fire) {
  const t0 = performance.now();
  fire();
  flush();
  await hop();
  await hop();
  await hop();
  const t1 = performance.now();
  void document.body.offsetHeight;
  const t2 = performance.now();
  await frame();
  return { js: t1 - t0, total: t2 - t0, frame: performance.now() - t0 };
}

export async function streaming(mode, sizes = [1000, 10000, 50000], samples = 25, chunk = 24) {
  const info = await newChat(`stream-${mode}`);
  await openChat(`stream-${mode}`);
  const id = info.sessionId;
  const full = markdown(Math.max(...sizes) + samples * chunk + 10, 7);
  const out = {};
  for (const size of sizes) {
    await step(() => emit("session-entry", { sessionId: id, index: 0, entry: { type: "agent", text: full.slice(0, size), messageId: null } }));
    await frame();
    const rows = [];
    for (let k = 1; k <= samples; k++) {
      const len = size + k * chunk;
      rows.push(
        await step(() =>
          mode === "append"
            ? emit("session-append", { sessionId: id, index: 0, field: "text", text: full.slice(len - chunk, len), len })
            : emit("session-entry", { sessionId: id, index: 0, entry: { type: "agent", text: full.slice(0, len), messageId: null } }),
        ),
      );
    }
    const text = log()?.textContent ?? "";
    out[size] = { total: stats(rows.map((r) => r.total)), frame: stats(rows.map((r) => r.frame)), rendered: text.length > size * 0.6 };
  }
  return out;
}

/** A 45k → 50k reply at one 24-char chunk every 16 ms, as fast as Rust would emit them. */
export async function live(mode, from = 45000, length = 50000, chunk = 24, everyMs = 16) {
  const info = await newChat(`live-${mode}`);
  await openChat(`live-${mode}`);
  const id = info.sessionId;
  const full = markdown(length, 3);
  emit("session-entry", { sessionId: id, index: 0, entry: { type: "agent", text: full.slice(0, from), messageId: null } });
  await frame();
  await frame();
  const frames = [];
  const po = new PerformanceObserver((l) => frames.push(...l.getEntries()));
  po.observe({ type: "long-animation-frame" });
  let rafs = 0;
  let on = true;
  const tick = () => on && (rafs++, requestAnimationFrame(tick));
  requestAnimationFrame(tick);
  let commits = 0;
  const mo = new MutationObserver(() => commits++);
  mo.observe(log(), { subtree: true, childList: true, characterData: true });
  const t0 = performance.now();
  let k = 0;
  for (let len = from + chunk; len <= length; len += chunk, k++) {
    if (mode === "append") emit("session-append", { sessionId: id, index: 0, field: "text", text: full.slice(len - chunk, len), len });
    else emit("session-entry", { sessionId: id, index: 0, entry: { type: "agent", text: full.slice(0, len), messageId: null } });
    const due = t0 + (k + 1) * everyMs;
    const now = performance.now();
    if (due > now) await new Promise((r) => setTimeout(r, due - now));
    else await hop();
  }
  await frame();
  await frame();
  const wall = performance.now() - t0;
  on = false;
  po.disconnect();
  mo.disconnect();
  const ok = (log()?.textContent ?? "").includes(full.slice(length - 200, length - 150).replace(/[#*`|>\-\n]/g, "").slice(0, 10));
  return {
    chunks: k,
    commits,
    fps: +((rafs / wall) * 1000).toFixed(1),
    wallMs: Math.round(wall),
    longFrames: frames.length,
    longFrameMs: Math.round(frames.reduce((s, f) => s + f.duration, 0)),
    ok,
  };
}

/** A chunk for a chat that isn't shown, while another (small) one is. */
export async function background(mode, samples = 25) {
  const bg = await newChat(`bg-${mode}`);
  await openChat(`bg-${mode}`);
  emit("session-entry", { sessionId: bg.sessionId, index: 0, entry: { type: "agent", text: markdown(1000, 1), messageId: null } });
  await frame();
  const fg = await newChat(`fg-${mode}`);
  await openChat(`fg-${mode}`);
  let text = markdown(1000, 1);
  const rows = [];
  for (let k = 0; k < samples; k++) {
    const add = ` more ${k}`;
    text += add;
    rows.push(
      await step(() =>
        mode === "append"
          ? emit("session-append", { sessionId: bg.sessionId, index: 0, field: "text", text: add, len: text.length })
          : emit("session-entry", { sessionId: bg.sessionId, index: 0, entry: { type: "agent", text, messageId: null } }),
      ),
    );
  }
  void fg;
  return stats(rows.map((r) => r.total));
}

export async function extraChats(n) {
  const list = await P.invoke("list_agents");
  for (let i = 0; i < n; i++) {
    const info = await P.invoke("new_quick_chat", { accountId: list.defaultId, dir: null });
    info.title = `extra chat ${i}`;
    emit("session-info", info);
  }
  await frame();
  await frame();
}

const heavyTree = () => ({
  type: "stack",
  children: [
    ...[10, 30, 60, 100, 150, 201].map((n) => ({ type: "diagram", props: { text: P.flowchart(n) } })),
    { type: "map", props: { markers: [{ lat: 38.72, lng: -9.14, label: "Lisbon" }, { lat: 52.52, lng: 13.4, label: "Berlin" }], height: 240 } },
    P.tableTree(200),
    { type: "timer", props: { since: new Date(Date.now() - 60000).toISOString(), label: "running" } },
  ],
});

/** Chats to switch between: small, 240, 1000 entries, and one with heavy agent UI. */
export async function makeSwitchChats() {
  const made = {};
  for (const [title, fill] of [
    ["sw-small", async (id) => emit("session-entry", { sessionId: id, index: 0, entry: { type: "user", text: "hi", attachments: [] } })],
    ["sw-240", (id) => seed(id, 240)],
    ["sw-1000", (id) => seed(id, 1000)],
    [
      "sw-ui",
      async (id) => {
        emit("session-entry", { sessionId: id, index: 0, entry: { type: "user", text: "show me", attachments: [] } });
        emit("session-entry", { sessionId: id, index: 1, entry: P.uiEntry(heavyTree()) });
      },
    ],
  ]) {
    const info = await newChat(title);
    await openChat(title);
    await fill(info.sessionId);
    await frame();
    made[title] = info.sessionId;
  }
  // Let the heavy UI finish once (mermaid chunk loaded, first renders done).
  await openChat("sw-ui");
  await waitFor(() => log()?.querySelectorAll("svg[id^=mermaid], [data-diagram] svg, .mermaid svg, figure svg").length >= 6 && !log().querySelector(".animate-pulse"), 30000);
  await frame();
  return made;
}

const ready = {
  // The chat is open when its last entries are on screen (entryAt(236) / entryAt(996) are user questions).
  "sw-240": () => log()?.textContent.includes("Question 236:"),
  "sw-1000": () => log()?.textContent.includes("Question 996:"),
  "sw-ui": () => {
    const l = log();
    return l && l.textContent.includes("show me") && !l.querySelector(".animate-pulse") && l.querySelectorAll("svg").length >= 6 && l.querySelector(".leaflet-container");
  },
};

export async function switchTo(title, reps = 8) {
  const times = [];
  for (let r = 0; r < reps; r++) {
    await openChat("sw-small");
    await frame();
    const t0 = performance.now();
    await openChat(title);
    await waitFor(ready[title], 30000);
    await frame();
    times.push(performance.now() - t0);
  }
  return { ...stats(times), first: +times[0].toFixed(1), domNodes: log()?.querySelectorAll("*").length };
}

const key = (k, code, init = {}) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, metaKey: /Mac/.test(navigator.platform), ctrlKey: !/Mac/.test(navigator.platform), bubbles: true, ...init }));

export async function settingsFirstVisit() {
  const dialogReady = () => {
    const d = document.querySelector('[role="dialog"]');
    const panel = d?.querySelector('[role="tabpanel"][data-state="active"]');
    return panel && !panel.querySelector('[aria-label="Loading"]') && panel.textContent.trim().length > 20;
  };
  let t0 = performance.now();
  key(",", "Comma");
  await waitFor(dialogReady, 10000);
  await frame();
  const open = performance.now() - t0;
  const first = {};
  const again = {};
  const tabs = () => [...document.querySelectorAll('[role="dialog"] [role="tab"]')];
  for (const pass of [first, again]) {
    for (const t of tabs()) {
      if (t.getAttribute("data-state") === "active") continue;
      const name = t.textContent.trim();
      t0 = performance.now();
      t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      await waitFor(() => t.getAttribute("data-state") === "active" && dialogReady(), 10000);
      await frame();
      pass[name] = +(performance.now() - t0).toFixed(1);
    }
    // back to the first tab between passes
    const g = tabs()[0];
    g.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    await waitFor(dialogReady);
    await frame();
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await frame();
  return { openMs: +open.toFixed(1), firstVisit: first, revisit: again, firstMean: stats(Object.values(first)).mean, revisitMean: stats(Object.values(again)).mean };
}

export async function paletteKeystrokes(query = "extra chat 12") {
  key("k", "KeyK");
  await waitFor(() => document.querySelector("[cmdk-input]"));
  await frame();
  const input = document.querySelector("[cmdk-input]");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const items = document.querySelectorAll("[cmdk-item]").length;
  const rows = [];
  for (let i = 1; i <= query.length; i++) {
    const t0 = performance.now();
    setter.call(input, query.slice(0, i));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await hop();
    await hop();
    await hop();
    const t1 = performance.now();
    await frame();
    // settled: the list stops changing for a frame
    let changed = true;
    const mo = new MutationObserver(() => (changed = true));
    mo.observe(document.querySelector("[cmdk-list]"), { subtree: true, childList: true, attributes: true });
    while (changed) {
      changed = false;
      await frame();
    }
    mo.disconnect();
    rows.push({ js: t1 - t0, settled: performance.now() - t0 });
  }
  const top = document.querySelector("[cmdk-item]")?.textContent;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  key("k", "KeyK");
  await frame();
  return { itemsAtOpen: items, js: stats(rows.map((r) => r.js)), settled: stats(rows.map((r) => r.settled)), topResult: top };
}

window.measure = { streaming, live, background, extraChats, makeSwitchChats, switchTo, settingsFirstVisit, paletteKeystrokes };

/** A `diff` of a 5000-line file with every 7th line changed: diff + render, then the full-screen review. */
export async function bigDiffReview() {
  const before = Array.from({ length: 5000 }, (_, i) => `const line${i + 1} = compute(${i});`);
  const after = before.map((l, i) => (i % 7 === 0 ? `${l} // changed` : l));
  const c = await newChat(`diff-${Math.random()}`);
  await openChat(c.title);
  const t0 = performance.now();
  emit("session-entry", { sessionId: c.sessionId, index: 0, entry: P.uiEntry({ type: "diff", props: { path: "src/big.ts", oldText: before.join("\n"), newText: after.join("\n") } }) });
  flush();
  await waitFor(() => [...(log()?.querySelectorAll("button") ?? [])].some((b) => b.textContent.includes("Review")), 20000);
  await frame();
  const inline = performance.now() - t0;
  const counts = log().textContent.match(/\+(\d+)\s*−(\d+)/)?.slice(1, 3);
  const t1 = performance.now();
  [...log().querySelectorAll("button")].find((b) => b.textContent.includes("Review")).click();
  await waitFor(() => document.querySelector('[role="dialog"]')?.textContent.includes("hunk"), 20000);
  await frame();
  const review = performance.now() - t1;
  const nodes = document.querySelector('[role="dialog"]').querySelectorAll("*").length;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await frame();
  return { inlineMs: Math.round(inline), reviewOpenMs: Math.round(review), reviewDomNodes: nodes, addedRemoved: counts };
}
window.measure.bigDiffReview = bigDiffReview;
