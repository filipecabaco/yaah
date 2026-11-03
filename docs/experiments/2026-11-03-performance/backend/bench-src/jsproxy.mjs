// Proxy for the webview side of one `session-entry` emit: parse + run the script Tauri evaluates.
import vm from "node:vm";
globalThis.window = globalThis; let sink = 0; globalThis.x = (e) => { sink += e.payload.entry.text.length; };
const base = "The quick brown fox jumps over the lazy dog; `code` and **bold** text, then a newline.\n";
for (const size of [1000, 10000, 50000, 200000]) {
  const text = base.repeat(Math.ceil(size / base.length)).slice(0, size);
  const payload = JSON.stringify({ sessionId: "s", index: 7, entry: { type: "agent", text, messageId: "m1" } });
  const iters = size >= 200000 ? 200 : 1000;
  let t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    // a fresh source string each time, as each chunk's script differs
    const src = `(function () { const fn = window['x']; fn && fn({event: 'session-entry', payload: ${payload}}, [${i}]) })()`;
    new vm.Script(src).runInThisContext();
  }
  const per = (performance.now() - t0) / iters;
  console.log(`webview-proxy\teval of one session-entry script, ${size / 1000}k-char message (V8 in node ${process.version})\t${(per * 1000).toFixed(1)}\tus\testimate: excludes React/markdown re-render; WebKit JSC differs`);
}
