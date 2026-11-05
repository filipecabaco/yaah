// Plain-language names for the agent's permission `mode` option (ACP category `mode`), so the
// composer can say what each does. Values are the agents' own (Claude: default, acceptEdits, plan,
// bypassPermissions; Codex: read-only, auto, full-access); an unknown one keeps the agent's name.
import type { ConfigOption, SessionInfo } from "@/lib/api";

export type ModeText = { name: string; description: string };

const TEXT: Record<string, ModeText> = {
  default: { name: "Ask first", description: "Ask for edits and commands" },
  acceptEdits: { name: "Accept edits", description: "File edits in this chat's folders go through; shell commands still ask" },
  plan: { name: "Plan only", description: "Read and plan, change nothing" },
  dontAsk: { name: "Don't ask", description: "Only what is already allowed runs; everything else is refused" },
  bypassPermissions: { name: "Bypass permissions", description: "Run everything without asking, including shell commands" },
  "read-only": { name: "Read only", description: "Read files; ask before changing anything" },
  auto: { name: "Auto", description: "The agent decides which actions are safe and asks only about risky ones" },
  "full-access": { name: "Full access", description: "Run everything without asking, with no sandbox" },
  build: { name: "Build", description: "Make changes" },
};

/** `auto`: the agent decides what is safe without asking (Claude's adapter groups it with bypassPermissions). */
export const isAuto = (value: string) => /^auto$/i.test(value.trim());

/** A mode that stops (or leaves it to the agent) asking: needs a per-chat confirmation, is never a default, Shift+Tab never reaches it. */
export const isUnrestricted = (value: string) => /bypass|full[-_ ]?access|danger/i.test(value) || isAuto(value);

/** The chat's permission mode option, if its agent offers one. */
export const modeOption = (session: SessionInfo): ConfigOption | undefined =>
  session.config?.options?.find((o) => o.kind === "select" && (o.category === "mode" || o.id === "mode") && o.role == null);

export const modeText = (o: ConfigOption, value: string): ModeText => {
  const c = o.choices.find((x) => x.value === value);
  return TEXT[value] ?? { name: c?.name ?? value, description: c?.description ?? "" };
};

/**
 * The mode Shift+Tab moves to: the next one the agent offers after the current, in its order, wrapping
 * round. Auto is part of the cycle (the agent still judges what is risky, as in the CLI); bypass and full
 * access are not (they stay behind the confirmation dialog); from one of those, the first cyclable mode.
 * Null when there is nowhere to go.
 */
export const nextSafeMode = (o: ConfigOption): string | null => {
  const cyclable = (x: string) => isAuto(x) || !isUnrestricted(x);
  const safe = o.choices.filter((c) => cyclable(c.value) && (isAuto(c.value) || cyclable(c.name))).map((c) => c.value);
  if (safe.length === 0 || (safe.length === 1 && safe[0] === o.current)) return null;
  const at = safe.indexOf(o.current);
  return safe[(at + 1) % safe.length];
};
