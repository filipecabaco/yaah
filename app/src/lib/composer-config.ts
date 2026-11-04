// Which of a chat's settings the composer shows (Rust marks them with `role`, session/config.rs).
import type { ConfigOption, SessionInfo } from "@/lib/api";
import type { ConfigRole } from "@/lib/app-events";

/** The option the composer shows as `role`, if the chat's agent offers one. */
export const configOption = (session: SessionInfo, role: ConfigRole): ConfigOption | undefined =>
  session.config?.options?.find((o) => o.role === role && o.kind === "select");

/** The name of the value in use. */
export const choiceName = (o: ConfigOption) => o.choices.find((c) => c.value === o.current)?.name ?? o.current;
