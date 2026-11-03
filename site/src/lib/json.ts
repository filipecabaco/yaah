// Formats a value as JSON, compactly: an object or array that fits on one line
// stays on one line. Then wraps its tokens in spans, at build time.
const WIDTH = 64;

function format(value: unknown, indent: string, col = indent.length): string {
  const flat = JSON.stringify(value, null, 1)?.replace(/\n\s*/g, " ").replace(/([[{]) /g, "$1").replace(/ ([\]}])/g, "$1") ?? "null";
  if (col + flat.length <= WIDTH || value === null || typeof value !== "object") return flat;
  const inner = indent + "  ";
  if (Array.isArray(value)) {
    return `[\n${value.map((v) => inner + format(v, inner)).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${format(v, inner, inner.length + k.length + 4)}`).join(",\n")}\n${indent}}`;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;

export function highlightJson(value: unknown): string {
  const text = format(value, "");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    out += escape(text.slice(last, m.index));
    const [whole, str, colon, lit, num, punct] = m;
    if (str !== undefined) {
      out += colon ? `<span class="tok-key">${escape(str)}</span><span class="tok-punct">${escape(colon)}</span>` : `<span class="tok-str">${escape(str)}</span>`;
    } else if (lit !== undefined) out += `<span class="tok-lit">${lit}</span>`;
    else if (num !== undefined) out += `<span class="tok-num">${num}</span>`;
    else if (punct !== undefined) out += `<span class="tok-punct">${punct}</span>`;
    else out += escape(whole);
    last = (m.index ?? 0) + whole.length;
  }
  return out + escape(text.slice(last));
}
