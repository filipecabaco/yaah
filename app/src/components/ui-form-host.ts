// How a form in agent-built UI reaches its transcript entry: the stored answer,
// the draft shared with the agent, and how to submit or store an edit.
import { createContext } from "react";

export type FormHost = {
  /** The submitted answer, `{ $cancelled: true }` if the ask was cancelled, or null. */
  answer?: unknown;
  /** True when the agent is waiting on this form (ui_ask). */
  asking?: boolean;
  onSubmit?: (values: Record<string, unknown>) => Promise<void>;
  /** Unsent values, shared with the agent, and who changed each field last. */
  draft?: Record<string, unknown>;
  draftBy?: Record<string, "user" | "agent">;
  /** Store the user's changes in the shared draft. */
  onEdit?: (changes: Record<string, unknown>) => Promise<void>;
};

/** The host for forms in one agent UI (set by UiTree). */
export const FormHostContext = createContext<FormHost | undefined>(undefined);
