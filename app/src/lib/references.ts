// References to tracker items in the composer and the transcript: `#` (every
// connected service), `github#`, `gitlab#`, `linear#`. Rust searches, ranks,
// parses the tokens on send and reads them (references.rs); this only finds
// what the caret is on, labels rows and marks tokens Rust already resolved.
import type { Reference, ReferenceService } from "@/lib/api";

/** What the text before the caret asks to complete: `#…`, `github#…`, `gitlab#…`, `linear#…`, or a pasted link. */
export type ReferenceTrigger = { start: number; query: string; service: ReferenceService | null; link: boolean };

/** Opening characters a reference may follow besides a space (not a backtick: code stays code). */
const OPEN = `\\s([{<"'`;
/** What may follow a reference: the end, a space or punctuation. */
const CLOSE = `$|[\\s.,;:!?)\\]}>"']`;

export function findReferenceTrigger(text: string, caret: number): ReferenceTrigger | null {
  const before = text.slice(0, caret);
  const hash = new RegExp(`(^|[${OPEN}])(github|gitlab|linear)?#(\\S*)$`, "i").exec(before);
  if (hash) {
    const service = (hash[2]?.toLowerCase() ?? null) as ReferenceService | null;
    return { start: hash.index + hash[1].length, query: hash[3], service, link: false };
  }
  // A link: Rust says whether it is a PR, MR or issue (and the list shows only then).
  const link = /(^|\s)(https?:\/\/\S+)$/i.exec(before);
  if (link) return { start: caret - link[2].length, query: link[2], service: null, link: true };
  return null;
}

export const SERVICE_LABEL: Record<ReferenceService, string> = { github: "GitHub", gitlab: "GitLab", linear: "Linear" };

export const KIND_LABEL: Record<Reference["kind"], string> = { pr: "PR", mr: "MR", issue: "issue" };

/** The list's heading for a trigger. */
export function referenceHeading(service: ReferenceService | null): string {
  if (service === "github") return "GitHub pull requests and issues";
  if (service === "gitlab") return "GitLab merge requests and issues";
  if (service === "linear") return "Linear issues";
  return "Pull requests, merge requests and issues";
}

/** The row for none connected: which services to connect. */
export function connectLabel(service: ReferenceService | null): string {
  return service ? `Connect ${SERVICE_LABEL[service]} to reference its items` : "Connect GitHub, GitLab or Linear to reference their items";
}

/** The item's state in words: the tracker's own name when it has one. */
export function stateText(r: Pick<Reference, "state" | "status">): string {
  return r.status ?? r.state;
}

/** What a screen reader hears for a reference: "GitHub PR acme/api#9, Retry webhooks once, open". */
export function referenceLabel(r: Reference): string {
  const what = `${SERVICE_LABEL[r.service]} ${KIND_LABEL[r.kind]} ${r.id}`;
  if (r.error) return `${what}, couldn't be read: ${r.error}`;
  return [what, r.title, stateText(r)].filter(Boolean).join(", ");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches any of `tokens` standing as their own word (any case: Linear keys are upper case once read). */
function tokenRe(tokens: string[]): RegExp | null {
  if (!tokens.length) return null;
  const alts = [...tokens].sort((a, b) => b.length - a.length).map(escapeRe);
  return new RegExp(`(^|[${OPEN}])(${alts.join("|")})(?=${CLOSE})`, "gi");
}

/** Whether `token` still stands in `text` as its own word. */
export const standing = (text: string, token: string) => tokenRe([token])?.test(text) ?? false;

export type Segment = { text: string } | { text: string; reference: Reference };

/** `text` cut at the references Rust read for it, for drawing them as chips. Only their exact tokens are marked. */
export function segments(text: string, references: Reference[] | undefined): Segment[] {
  const re = tokenRe((references ?? []).map((r) => r.token));
  if (!re || !references) return [{ text }];
  const byToken = new Map(references.map((r) => [r.token.toLowerCase(), r]));
  const out: Segment[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index + m[1].length;
    const reference = byToken.get(m[2].toLowerCase());
    if (!reference) continue;
    if (start > at) out.push({ text: text.slice(at, start) });
    out.push({ text: m[2], reference });
    at = start + m[2].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
