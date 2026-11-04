// yaah's own light and dark tokens, read from index.css on disk and resolved to sRGB, so the
// theme contrast tests can hold them to the same floors as the VS Code themes (theme-map.ts).
// Tests don't process CSS (even `?raw` comes back empty), and src's tsconfig has no Node
// types, hence the typed dynamic import.

export type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

export async function readIndexCss(): Promise<string> {
  const fsModule = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync: (path: string, encoding: "utf8") => string };
  const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();
  return fs.readFileSync(`${cwd}/src/index.css`, "utf8");
}

/** The `--name: value` declarations of the first rule whose selector is exactly `selector`. */
export function declarations(css: string, selector: string): Record<string, string> {
  const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`));
  if (at < 0) throw new Error(`no ${selector} rule in index.css`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const encode = (v: number) => Math.round(255 * clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));

/** OKLCH to sRGB (Björn Ottosson's matrices), clipped to the gamut. */
function oklch(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    encode(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    encode(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    encode(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/** `oklch(L C H[ / A%])` or `#rrggbb`, as index.css writes its colours. */
export function cssColor(value: string): Rgba {
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(value);
  if (ok) {
    const alpha = ok[4] == null ? 1 : Number(ok[4]) / (ok[5] ? 100 : 1);
    return [...oklch(Number(ok[1]), Number(ok[2]), Number(ok[3])), alpha];
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba;
  throw new Error(`can't read colour ${value}`);
}

/** `top` composited over the opaque `bottom`, at `top`'s alpha times `opacity` (Tailwind's `/50`). */
export function over(top: Rgba | Rgb, bottom: Rgb, opacity = 1): Rgb {
  const a = (top[3] ?? 1) * opacity;
  return [0, 1, 2].map((i) => Math.round(top[i] * a + bottom[i] * (1 - a))) as Rgb;
}
