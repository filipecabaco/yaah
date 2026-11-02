import { errorMessage } from "@/lib/narrow";
import { cn } from "@/lib/utils";

/** The one way a failed action shows its error: a short destructive line, announced to screen readers. */
export function ErrorText({ error, prefix, className }: { error: unknown; prefix?: string; className?: string }) {
  if (error == null || error === "") return null;
  return (
    <p role="alert" className={cn("text-xs break-words text-destructive", className)}>
      {prefix}
      {errorMessage(error)}
    </p>
  );
}
