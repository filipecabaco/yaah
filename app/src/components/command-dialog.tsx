// A slash command typed while a turn runs. Commands act on the chat (/usage, /compact, /clear),
// so they don't wait in the message queue among ordinary messages: a dialog asks when to run it.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SlashCommand } from "@/lib/api";
import { runCommand } from "@/lib/slash-commands";
import { Kbd } from "@/components/ui/kbd";
import { isMac } from "@/lib/shortcuts";

export function CommandDialog({
  sessionId,
  command,
  text,
  running,
  onClose,
  onDone,
}: {
  sessionId: string;
  command: SlashCommand;
  /** The text typed, which the user can still change (arguments). */
  text: string;
  /** The turn is still running; when it has ended the command runs at once. */
  running: boolean;
  onClose: () => void;
  /** It was sent: the composer can clear. */
  onDone: () => void;
}) {
  const [value, setValue] = useState(text.trim());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function run(stopFirst: boolean) {
    setBusy(true);
    setError(null);
    try {
      await runCommand(sessionId, value.trim(), stopFirst);
      onDone();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run /{command.name}</DialogTitle>
          <DialogDescription>
            {command.description || "A command of the agent."} {running ? "The agent is still working on a turn." : ""}
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Command"
          value={value}
          autoFocus
          spellCheck={false}
          className="font-mono"
          placeholder={command.input?.hint ?? undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || busy || !value.trim()) return;
            // Ctrl/⌘+Enter is "now": stop the turn and run. Enter alone waits for the turn.
            void run(running && (e.ctrlKey || e.metaKey));
          }}
        />
        <ErrorText error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={running ? "outline" : "default"} onClick={() => void run(false)} disabled={busy || !value.trim()}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {running ? "Run after this turn" : "Run"}
          </Button>
          {running && (
            <Button onClick={() => void run(true)} disabled={busy || !value.trim()}>
              Stop turn and run <Kbd>{isMac ? "⌘↵" : "Ctrl+↵"}</Kbd>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
