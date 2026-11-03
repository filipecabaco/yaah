// How a chat card names yaah's own UI tools. While an agent is still building UI (ui_render,
// ui_ask) or storing a component, the card says so (with a spinner); once the call is in, it
// takes the UI's own title or the component's name.

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | null;

export function uiToolLabel(title: string, status: ToolStatus, input: unknown): { text: string; busy: boolean } | null {
  const tool = /^mcp__yaah-ui__(.+)$/.exec(title)?.[1];
  if (tool !== "ui_render" && tool !== "ui_ask" && tool !== "ui_save_component") return null;
  const busy = status === "pending" || status === "in_progress";
  const failed = status === "failed";
  const arg = (k: string) => {
    const v = input && typeof input === "object" ? (input as Record<string, unknown>)[k] : undefined;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  if (tool === "ui_save_component") {
    const name = arg("name") ?? "a component";
    return { text: busy ? `Storing ${name}` : failed ? `Couldn't store ${name}` : `Stored ${name}`, busy };
  }
  if (busy) return { text: "Assembling UI", busy };
  if (failed) return { text: "Couldn't build the UI", busy };
  return { text: arg("title") ?? arg("component") ?? (tool === "ui_ask" ? "Asked with UI" : "Rendered UI"), busy };
}
