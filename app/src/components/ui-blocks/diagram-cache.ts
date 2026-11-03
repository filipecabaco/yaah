// Drawn Mermaid diagrams by (theme, text). Drawing is the slow part of opening a
// chat with diagrams (hundreds of ms for a big one), and the same text in the same
// theme always draws the same SVG, so each is drawn once and shown again from here.
// Failures are kept too: the same text fails the same way.
import { Lru } from "@/lib/lru";
import { errorMessage } from "@/lib/narrow";

export type Drawn = { svg: string } | { error: string };
/** Draws `text` into an SVG whose element ids start with `id`. */
export type DrawFn = (id: string, text: string, theme: string) => Promise<string>;

export class DiagramCache {
  private drawn: Lru<string, Drawn>;
  private inFlight = new Map<string, Promise<Drawn>>();
  private next = 0;

  constructor(
    private draw: DrawFn,
    max = 64,
  ) {
    this.drawn = new Lru(max);
  }

  private static key = (theme: string, text: string) => `${theme}\u0000${text}`;

  /** The drawing, if it's done (so a chat opens with its diagrams already there). */
  peek(theme: string, text: string): Drawn | undefined {
    return this.drawn.get(DiagramCache.key(theme, text));
  }

  /** The drawing, drawn now unless it's done or being drawn. */
  get(theme: string, text: string): Promise<Drawn> {
    const key = DiagramCache.key(theme, text);
    const hit = this.drawn.get(key);
    if (hit) return Promise.resolve(hit);
    let p = this.inFlight.get(key);
    if (!p) {
      p = this.draw(`mermaid-${++this.next}`, text, theme).then(
        (svg): Drawn => ({ svg }),
        (e: unknown): Drawn => ({ error: errorMessage(e) }),
      );
      this.inFlight.set(key, p);
      void p.then((d) => {
        this.inFlight.delete(key);
        this.drawn.set(key, d);
      });
    }
    return p;
  }

  get size() {
    return this.drawn.size;
  }
}
