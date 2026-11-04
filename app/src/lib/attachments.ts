// Attachments in the composer (dropped, pasted or picked) and images in the transcript.
// Mirrors `src-tauri/src/attachments.rs`, which reads every file, sniffs its type, holds images
// to the limits and builds the ACP blocks. This side only says what will happen and draws it.
import { invoke } from "@tauri-apps/api/core";
import type { AgentReport } from "@/lib/api";
import { Lru } from "@/lib/lru";
import { plural } from "@/lib/format";

export type AttachmentKind = "image" | "file" | "folder";

/** One attachment: in the composer before it is sent, in the user's message (`files`) after. */
export type Attachment = {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType?: string;
  /** Bytes, as sent (a downscaled image's new size). */
  size?: number;
  /** Where it is on disk (a pasted image's is the chat's own copy). */
  path?: string;
  /** Pasted: there's no file of the user's to reveal. */
  pasted?: boolean;
  /** The image in the chat's image store. */
  image?: string;
  width?: number;
  height?: number;
  /** e.g. "Downscaled from 9000 × 6000". */
  note?: string;
  /** Small UTF-8 text: embedded for agents that take embedded context. */
  text?: boolean;
  /** How it went, once sent. */
  sentAs?: "image" | "embedded" | "link";
};

export type Refused = { name: string; reason: string };
export type Staged = { added: Attachment[]; refused: Refused[] };
/** A dragged path, from its name and metadata only (Rust reads nothing yet). */
export type Described = { name: string; kind: AttachmentKind };

/** An ACP image block as the transcript keeps it: its bytes in the chat's image store (`image`), or inline (`data`, older chats). */
export type ImageBlock = {
  type: "image";
  mimeType?: string;
  image?: string;
  data?: string;
  size?: number;
  width?: number;
  height?: number;
  uri?: string;
  /** Too large to keep, or unreadable: why. */
  omitted?: string;
};

export const attachments = {
  describe: (paths: string[]) => invoke<Described[]>("describe_drop", { paths }),
  /** Attach dropped or picked paths to `sessionId`'s composer. */
  stage: (sessionId: string, paths: string[]) => invoke<Staged>("stage_attachments", { sessionId, paths }),
  /** A pasted image: its bytes go to Rust once, as the request body. */
  stagePasted: async (sessionId: string, blob: Blob, name?: string) =>
    invoke<Staged>("stage_pasted_image", new Uint8Array(await blob.arrayBuffer()), {
      headers: { "x-yaah-session": encodeURIComponent(sessionId), "x-yaah-name": encodeURIComponent(name ?? "") },
    }),
  discard: (ids: string[]) => invoke<void>("discard_attachments", { ids }),
  readImage: (sessionId: string, id: string) => invoke<ArrayBuffer>("read_image", { sessionId, id }),
};

// ---------------------------------------------------------------------------
// Words

const KINDS: [AttachmentKind, string][] = [
  ["image", "image"],
  ["file", "file"],
  ["folder", "folder"],
];

/** "2 images and 1 file". */
export function countText(items: { kind: AttachmentKind }[]): string {
  const parts = KINDS.map(([k, word]) => [items.filter((i) => i.kind === k).length, word] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => plural(n, word));
  if (parts.length <= 1) return parts[0] ?? "nothing";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The overlay's headline. */
export function dropHeadline(items: Described[]): string {
  return items.length ? `Drop to attach ${countText(items)} to this message` : "Drop to attach to this message";
}

/** What the agent can take, as it applies to what's dragged ("Claude takes images; other files go as file references"). */
export function capabilityText(agent: string, report: AgentReport | null | undefined, items: Described[]): string {
  const images = items.some((i) => i.kind === "image");
  const others = items.some((i) => i.kind !== "image");
  const otherText = report?.embeddedContext ? "small text files go inline, other files as file references" : "files go as file references";
  if (!report) return images ? `If ${agent} takes images they go as images; otherwise as file references` : `Files go as file references`;
  if (images && !report.image) return `${agent} doesn't take images, so they go as file references${others ? ", like the other files" : ""}`;
  if (images && !others) return `${agent} takes images`;
  if (images) return `${agent} takes images; ${report.embeddedContext ? otherText : "other files go as file references"}`;
  return `${otherText[0].toUpperCase()}${otherText.slice(1)}`;
}

/** How a sent attachment went, for its chip's tooltip. */
export function sentText(a: Attachment): string {
  switch (a.sentAs) {
    case "image":
      return "Sent as an image";
    case "embedded":
      return "Sent inline (the file's text)";
    case "link":
      return a.kind === "image" ? "Sent as a file reference (this agent doesn't take images)" : "Sent as a file reference";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Drops from the OS: Tauri hands them to the webview's drag-drop event with real paths
// and positions. Each chat pane registers its element; the one under the pointer gets
// the overlay, the drop and nothing else.

export type DragState = { items: Described[] };

type Zone = {
  el: HTMLElement;
  onDrag: (state: DragState | null) => void;
  onDrop: (paths: string[]) => void;
};

const zones = new Set<Zone>();
let current: { paths: string[]; items: Described[]; zone: Zone | null } | null = null;

function zoneAt(x: number, y: number): Zone | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  return [...zones].find((z) => z.el.contains(hit)) ?? null;
}

/** A physical position (what Tauri sends) in CSS pixels. */
const logical = (p: { x: number; y: number }) => ({ x: p.x / (window.devicePixelRatio || 1), y: p.y / (window.devicePixelRatio || 1) });

function retarget(zone: Zone | null) {
  if (!current) return;
  if (current.zone !== zone) current.zone?.onDrag(null);
  current.zone = zone;
  zone?.onDrag({ items: current.items });
}

type DragPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

/** Apply one drag-drop event; exported for tests. */
export function handleDragEvent(e: DragPayload) {
  if (e.type === "leave") {
    current?.zone?.onDrag(null);
    current = null;
    return;
  }
  const { x, y } = logical(e.position);
  if (e.type === "enter") {
    // Text from another app arrives with no paths: nothing to attach.
    if (!e.paths.length) return;
    current = { paths: e.paths, items: e.paths.map((p) => ({ name: p.split("/").pop() || p, kind: "file" })), zone: null };
    const paths = e.paths;
    retarget(zoneAt(x, y));
    attachments.describe(paths).then(
      (items) => {
        if (current?.paths !== paths) return;
        current.items = items;
        current.zone?.onDrag({ items });
      },
      (err: unknown) => console.error("could not describe the drag", err),
    );
    return;
  }
  if (e.type === "over") {
    if (current) retarget(zoneAt(x, y));
    return;
  }
  const zone = zoneAt(x, y);
  current?.zone?.onDrag(null);
  current = null;
  if (zone && e.paths.length) zone.onDrop(e.paths);
}

/** Listening to the webview's drag-drop event: while any pane is a drop zone. Resolves to its unlisten. */
let installed: Promise<(() => void) | null> | null = null;

async function install(): Promise<(() => void) | null> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => handleDragEvent(e.payload));
}

/** Register a chat pane as a drop zone; returns its unregister. */
export function addDropZone(zone: Zone): () => void {
  zones.add(zone);
  installed ??= install().catch((e: unknown) => {
    console.error("drag and drop isn't available", e);
    return null;
  });
  return () => {
    zones.delete(zone);
    if (current?.zone === zone) current.zone = null;
    if (zones.size === 0 && installed) {
      const was = installed;
      installed = null;
      current = null;
      void was.then((unlisten) => unlisten?.());
    }
  };
}

// ---------------------------------------------------------------------------
// Into a composer: what a pane's drop zone (or anything else) hands to the composer of that
// pane, by chat and pane, the way drafts reach it.

/** Paths (a drop from the OS), files from a browser drop (their bytes; only images are taken), or text. */
export type Incoming = { paths: string[] } | { blobs: File[] } | { text: string };
type Inbox = { sessionId: string; pane?: string; cb: (i: Incoming) => void };
const inboxes = new Set<Inbox>();

export function onIncoming(sessionId: string, pane: string | undefined, cb: (i: Incoming) => void): () => void {
  const inbox = { sessionId, pane, cb };
  inboxes.add(inbox);
  return () => void inboxes.delete(inbox);
}

export function sendIncoming(sessionId: string, pane: string | undefined, incoming: Incoming) {
  for (const i of inboxes) if (i.sessionId === sessionId && i.pane === pane) i.cb(incoming);
}

// ---------------------------------------------------------------------------
// Images: bytes from Rust become `blob:` URLs (CSP `img-src` allows `blob:` and `data:`), one per image, reused.

const urls = new Lru<string, Promise<string>>(200, (_, url) => {
  void url.then((u) => u.startsWith("blob:") && URL.revokeObjectURL(u)).catch(() => {});
});

/** A URL to show `block` with, or null when there's nothing to show. */
export function imageUrl(sessionId: string | undefined, block: Pick<ImageBlock, "image" | "data" | "mimeType">): Promise<string> | null {
  if (block.data) return Promise.resolve(`data:${block.mimeType ?? "image/png"};base64,${block.data}`);
  if (!block.image || !sessionId) return null;
  const key = `${sessionId}/${block.image}`;
  const hit = urls.get(key);
  if (hit) return hit;
  const mime = block.mimeType ?? mimeOf(block.image);
  const url = attachments.readImage(sessionId, block.image).then((bytes) => URL.createObjectURL(new Blob([bytes], { type: mime })));
  url.catch(() => urls.delete(key));
  urls.set(key, url);
  return url;
}

function mimeOf(id: string): string {
  const ext = id.split(".").pop();
  return ext === "jpg" ? "image/jpeg" : `image/${ext ?? "png"}`;
}

/** The image blocks of a tool call's content. */
export function toolImages(content: { type: string; content?: unknown }[]): ImageBlock[] {
  return content.flatMap((c) => {
    const inner = c.content as { type?: string } | undefined;
    return c.type === "content" && inner?.type === "image" ? [inner as ImageBlock] : [];
  });
}

/** A file path from a `file://` URI, for "Reveal". */
export function pathOfUri(uri: string | undefined): string | null {
  if (!uri?.startsWith("file://")) return null;
  try {
    return decodeURIComponent(uri.slice("file://".length));
  } catch {
    return uri.slice("file://".length);
  }
}
