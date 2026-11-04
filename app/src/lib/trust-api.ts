// Where trust applies, as Rust keeps it (session/trust.rs): this chat, its project, quick chats
// (every chat without a project in a scratch folder shares one scope) or all chats. This only
// reads and asks; Rust decides what is offered and what a request gets.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** permissions.rs `Scope`. */
export type TrustScope = "chat" | "project" | "quickChats" | "everywhere";

/** trust.rs `TrustView`: where a chat's own choices go, what its cards offer, and every server trusted for it. */
export type TrustView = {
  here: TrustScope;
  offered: TrustScope[];
  servers: { id: string; label: string; scope: TrustScope }[];
};

/** trust.rs `PermissionSettings`: Settings → Chat's permission switches and the servers trusted in all chats. */
export type PermissionSettings = {
  trustReadOnly: boolean;
  allowWebSearch: boolean;
  trustedEverywhere: { id: string; label: string }[];
};

/** permissions.rs `Scope::words`. */
export const SCOPE_WORDS: Record<TrustScope, string> = {
  chat: "in this chat",
  project: "in this project",
  quickChats: "in quick chats",
  everywhere: "in all chats",
};

export const trustApi = {
  trustScope: (sessionId: string) => invoke<TrustView>("trust_scope", { sessionId }),
  /** "Always allow tools from <server>" in `scope` (one the chat's view offers); its waiting requests are answered. */
  trustMcpServer: (sessionId: string, index: number, scope: TrustScope) => invoke<void>("trust_mcp_server", { sessionId, index, scope }),
  permissionSettings: () => invoke<PermissionSettings>("permission_settings"),
  setAllowWebSearch: (enabled: boolean) => invoke<void>("set_allow_web_search", { enabled }),
  untrustEverywhere: (server: string) => invoke<PermissionSettings>("untrust_mcp_server_everywhere", { server }),
  untrustQuickChats: (server: string) => invoke<void>("untrust_quick_chat_mcp_server", { server }),
};

/** Any trust changed (a server trusted or not, a "don't ask again" in quick chats, a project's list). */
export function onTrustChanged(cb: () => void): () => void {
  const unlisten = Promise.all([listen("trust-changed", () => cb()), listen("projects-changed", () => cb())]);
  return () =>
    void unlisten.then(
      (fns) => fns.forEach((f) => f()),
      () => {},
    );
}

/** Chat `sessionId`'s trust view, kept current; null until read (or when it can't be). `key`: re-read when it changes (a move to a project). */
export function useTrustView(sessionId: string | undefined, key?: unknown): TrustView | null {
  const [view, setView] = useState<TrustView | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const read = () =>
      trustApi.trustScope(sessionId).then(
        (v) => live && setView(v),
        () => live && setView(null),
      );
    void read();
    const off = onTrustChanged(() => void read());
    return () => {
      live = false;
      off();
    };
  }, [sessionId, key]);
  return view;
}
