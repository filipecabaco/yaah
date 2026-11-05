import { api, type SlashCommand } from "@/lib/api";

/** The agent command a message starts with (`/usage`, `/compact focus on tests`), if it is one. */
export const commandOf = (text: string, commands: SlashCommand[]): SlashCommand | undefined => {
  const name = /^\/(\S+)/.exec(text.trim())?.[1];
  return name ? commands.find((c) => c.name === name) : undefined;
};

/**
 * Send a command text; with `stopFirst` and a turn running, stop the turn and run the command the
 * moment it has stopped (instead of leaving it to wait in the queue).
 */
export async function runCommand(sessionId: string, text: string, stopFirst: boolean): Promise<void> {
  const sent = await api.sendPrompt(sessionId, text);
  if (stopFirst && sent.status === "queued") {
    await api.queueSendNow(sessionId, sent.id);
    await api.cancelTurn(sessionId);
  }
}
