// Attachments (attachments.rs): drops, pastes and the Attach picker, staged per chat, and the
// chat image store. A plain browser can't give file paths, so files dragged in from the OS are
// turned into the Tauri drag-drop events the app listens to (with made-up paths under
// ~/Downloads), and `window.__yaahMock.dragFiles` / `dropFiles` do the same from a script.
import { emit } from "@tauri-apps/api/event";
import type { AgentReport, Entry } from "@/lib/api";
import type { Attachment, Described, Staged } from "@/lib/attachments";
import { asObj, asString } from "@/lib/narrow";
import { baseName, home, type Mock, type Replies } from "./context";
import type { Recording } from "./fixtures";

export function seedAttachments() {
  return {
    /** What composers attached and haven't sent, by id. */
    attachmentsStaged: {} as Record<string, Attachment & { sessionId: string }>,
    /** Image bytes by store id (every chat's in one place: ids are hashes in Rust). */
    attachmentImages: {} as Record<string, Uint8Array>,
    /** Files dropped from the OS onto the page, by the path the mock gave them. */
    attachmentsDropped: {} as Record<string, { type: string; size: number; file?: File; folder?: boolean }>,
    nextAttachment: 1,
  };
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const TEXT = /\.(md|txt|json|ts|tsx|rs|py|csv|log|toml|ya?ml)$/i;

/** A 1×1 PNG, for where there's no canvas (tests). */
const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) =>
  c.charCodeAt(0),
);

/** A picture to stand in for a file's image: drawn on a canvas when there is one. */
async function drawImage(label: string, kind: "photo" | "browser", w = 960, h = 600): Promise<Uint8Array> {
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx || typeof canvas.toBlob !== "function") return PIXEL;
  canvas.width = w;
  canvas.height = h;
  if (kind === "browser") {
    // A browser window: tab strip, address bar, a page with a heading and cards.
    ctx.fillStyle = "#f4f4f5";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#e4e4e7";
    ctx.fillRect(0, 0, w, 44);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(84, 10, w - 168, 24);
    ctx.fillStyle = "#71717a";
    ctx.font = "14px sans-serif";
    ctx.fillText(label, 96, 27);
    for (const [i, c] of ["#ef4444", "#f59e0b", "#22c55e"].entries()) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(20 + i * 18, 22, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#18181b";
    ctx.font = "bold 34px sans-serif";
    ctx.fillText("Acme dashboard", 48, 110);
    ctx.font = "16px sans-serif";
    ctx.fillStyle = "#52525b";
    ctx.fillText("Signed in as dev@acme.test · 3 deploys today", 48, 140);
    const cards = ["Revenue  $48.2k", "Active users  1,204", "Error rate  0.3%"];
    cards.forEach((t, i) => {
      const x = 48 + i * ((w - 96) / 3);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, 170, (w - 96) / 3 - 16, 110);
      ctx.fillStyle = "#18181b";
      ctx.font = "18px sans-serif";
      ctx.fillText(t, x + 16, 230);
    });
    ctx.fillStyle = "#3b82f6";
    for (let i = 0; i < 12; i++) ctx.fillRect(48 + i * 62, h - 60 - ((i * 53) % 200), 40, 60 + ((i * 53) % 200));
  } else {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#0ea5e9");
    g.addColorStop(1, "#a855f7");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = `bold ${Math.round(h / 10)}px sans-serif`;
    ctx.fillText(label, w / 12, h / 2);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : PIXEL;
}

function kindOf(path: string, meta?: { folder?: boolean }): Described["kind"] {
  if (meta?.folder || path.endsWith("/") || !/\.[A-Za-z0-9]+$/.test(baseName(path))) return "folder";
  return IMAGE.test(path) ? "image" : "file";
}

function mimeOf(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      md: "text/markdown",
      json: "application/json",
      pdf: "application/pdf",
    }[ext] ?? (TEXT.test(name) ? "text/plain" : "application/octet-stream")
  );
}

/** How Rust would send `a` to an agent with `report` (attachments.rs `blocks`). */
export function sentAs(a: Attachment, report: AgentReport | null | undefined): Attachment["sentAs"] {
  if (a.kind === "image" && report?.image) return "image";
  if (a.kind === "file" && a.text && report?.embeddedContext) return "embedded";
  return "link";
}

export function attachmentReplies(m: Mock): Replies {
  const { state } = m;
  const stage = async (path: string): Promise<Attachment | { name: string; reason: string }> => {
    const name = baseName(path);
    const meta = state.attachmentsDropped[path];
    const id = `mock-${state.nextAttachment++}`;
    if (/huge/i.test(name)) return { name, reason: "is 82 MB; images over 50 MB can't be attached" };
    const kind = kindOf(path, meta);
    if (kind === "folder") return { id, name, kind, path };
    const mimeType = meta?.type || mimeOf(name);
    const size = meta?.size || 1200 + name.length * 977;
    if (kind === "image") {
      const bytes = meta?.file ? new Uint8Array(await meta.file.arrayBuffer()) : await drawImage(name.replace(/\.[^.]+$/, ""), "photo", 640, 400);
      const image = `${id
        .padEnd(32, "0")
        .replace(/[^0-9a-f]/g, "a")
        .slice(0, 32)}.png`;
      state.attachmentImages[image] = bytes;
      const wide = /wide|panorama/i.test(name);
      return {
        id,
        name,
        kind,
        path,
        mimeType: "image/png",
        size: wide ? 4_100_000 : bytes.length,
        image,
        width: wide ? 2048 : 640,
        height: wide ? 512 : 400,
        ...(wide ? { note: "Downscaled from 9600 × 2400" } : {}),
      };
    }
    return { id, name, kind, path, mimeType, size, ...(TEXT.test(name) && size <= 64 * 1024 ? { text: true } : {}) };
  };
  const keep = (sessionId: string, found: (Attachment | { name: string; reason: string })[]): Staged => {
    const out: Staged = { added: [], refused: [] };
    for (const f of found) {
      if ("reason" in f) out.refused.push(f);
      else {
        state.attachmentsStaged[f.id] = { ...f, sessionId };
        out.added.push(f);
      }
    }
    return out;
  };
  return {
    describe_drop: ({ paths }: { paths: string[] }): Described[] =>
      paths.map((p) => ({ name: baseName(p), kind: kindOf(p, state.attachmentsDropped[p]) })),
    stage_attachments: async ({ sessionId, paths }: { sessionId: string; paths: string[] }): Promise<Staged> => {
      await m.wait(150);
      return keep(sessionId, await Promise.all(paths.map((p) => stage(p))));
    },
    // The body is the image's bytes; the chat and name come as headers, which the mock doesn't see.
    stage_pasted_image: async (body: unknown): Promise<Staged> => {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(0);
      const sessionId = Object.values(state.sessions).find((s) => !s.running)?.sessionId ?? "";
      const id = `mock-${state.nextAttachment++}`;
      const image = `${"b".repeat(26)}${String(state.nextAttachment).padStart(6, "0")}.png`;
      state.attachmentImages[image] = bytes.length ? bytes : await drawImage("Pasted", "photo", 640, 400);
      return keep(sessionId, [
        { id, name: "Pasted image.png", kind: "image", mimeType: "image/png", size: bytes.length, pasted: true, image, width: 640, height: 400 },
      ]);
    },
    discard_attachments: ({ ids }: { ids: string[] }) => {
      for (const id of ids) delete state.attachmentsStaged[id];
      return null;
    },
    read_image: async ({ id }: { sessionId: string; id: string }) => {
      if (!state.attachmentImages[id] && id.startsWith("5c7ee5"))
        state.attachmentImages[id] = await drawImage(SHOT_URLS[id] ?? "http://localhost:5173", "browser");
      const bytes = state.attachmentImages[id];
      if (!bytes) throw new Error("this image is no longer kept");
      return bytes.slice().buffer;
    },
  };
}

/** The Attach button's picker (plugin-dialog `open` titled "Attach to this message"): two files. */
export function pickAttachments(args: unknown): string[] | null {
  const title = asString(asObj(asObj(args).options).title) ?? "";
  return /attach to this message/i.test(title) ? [`${home}/Downloads/mockup.png`, `${home}/workspace/shop/README.md`] : null;
}

/** The staged attachments with `ids`, as sent to an agent with `report`; they leave the composer. */
export function takeStaged(m: Mock, ids: string[], report: AgentReport | null | undefined): Attachment[] {
  return ids.flatMap((id) => {
    const a = m.state.attachmentsStaged[id];
    if (!a) return [];
    delete m.state.attachmentsStaged[id];
    const { sessionId: _, ...rest } = a;
    return [{ ...rest, sentAs: sentAs(rest, report) }];
  });
}

// ---------------------------------------------------------------------------
// Drags from the OS in a plain browser, as Tauri's drag-drop events.

type FakeFile = { name: string; type?: string; size?: number; folder?: boolean };

const pathFor = (f: FakeFile) => (f.folder ? `${home}/workspace/${f.name}` : `${home}/Downloads/${f.name}`);

/** Install the converter, and `window.__yaahMock` for scripts. Returns its uninstall. */
export function installDragBridge(m: Mock): () => void {
  const dpr = () => window.devicePixelRatio || 1;
  const at = (x: number, y: number) => ({ x: x * dpr(), y: y * dpr() });
  const register = (files: FakeFile[]) =>
    files.map((f) => {
      const path = pathFor(f);
      m.state.attachmentsDropped[path] = { type: f.type ?? "", size: f.size ?? 0, folder: f.folder };
      return path;
    });
  const api = {
    /** Drag `files` over the point (CSS pixels): the overlay shows there. */
    dragFiles: (files: FakeFile[], x: number, y: number) => emit("tauri://drag-enter", { paths: register(files), position: at(x, y) }),
    moveTo: (x: number, y: number) => emit("tauri://drag-over", { position: at(x, y) }),
    dropFiles: (files: FakeFile[], x: number, y: number) => emit("tauri://drag-drop", { paths: register(files), position: at(x, y) }),
    leave: () => emit("tauri://drag-leave", {}),
  };
  (window as { __yaahMock?: typeof api }).__yaahMock = api;

  let inside = false;
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  const guessed = (e: DragEvent) =>
    [...(e.dataTransfer?.items ?? [])]
      .filter((i) => i.kind === "file")
      .map((i, n) => ({ name: `file-${n + 1}${i.type.startsWith("image/") ? ".png" : ".bin"}`, type: i.type }));
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!inside) {
      inside = true;
      void api.dragFiles(guessed(e), e.clientX, e.clientY);
    } else void api.moveTo(e.clientX, e.clientY);
  };
  const leave = (e: DragEvent) => {
    if (!hasFiles(e) || e.relatedTarget) return;
    inside = false;
    void api.leave();
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    inside = false;
    const files = [...(e.dataTransfer?.files ?? [])];
    const paths = register(files.map((f) => ({ name: f.name, type: f.type, size: f.size })));
    files.forEach((f, i) => (m.state.attachmentsDropped[paths[i]].file = f));
    void emit("tauri://drag-drop", { paths, position: at(e.clientX, e.clientY) });
  };
  window.addEventListener("dragenter", over, true);
  window.addEventListener("dragover", over, true);
  window.addEventListener("dragleave", leave, true);
  window.addEventListener("drop", drop, true);
  return () => {
    window.removeEventListener("dragenter", over, true);
    window.removeEventListener("dragover", over, true);
    window.removeEventListener("dragleave", leave, true);
    window.removeEventListener("drop", drop, true);
  };
}

// ---------------------------------------------------------------------------
// A recorded chat where the agent drives a browser and its screenshots come back as images
// (claude-agent-acp turns MCP image results into ACP image content; Rust keeps their bytes in
// the image store and the entry an id, attachments.rs `externalize_content`).

const SHOTS = ["5c7ee5a1b2c3d4e5f60718293a4b5c6d.png", "5c7ee5f6e5d4c3b2a1908172635a4b3c.png"];
const SHOT_URLS: Record<string, string> = { [SHOTS[0]]: "http://localhost:5173/", [SHOTS[1]]: "http://localhost:5173/deploys" };
const shot = (i: number) => ({
  type: "content",
  content: { type: "image", mimeType: "image/png", image: SHOTS[i], size: 48_213 + i * 9_000, width: 960, height: 600 },
});
const text = (t: string) => ({ type: "content", content: { type: "text", text: t } });

type Tool = Extract<Entry, { type: "tool" }>;
const tool = (id: string, title: string, status: string, content: unknown[], rawInput: unknown = {}): Tool =>
  ({ type: "tool", toolCallId: id, title, kind: "other", status, content, locations: [], rawInput }) as Tool;

export const screenshotChat: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  { event: "session-entry", index: 1, entry: { type: "agent", text: "I'll open the dashboard and take a look.", messageId: "m1" } },
  {
    event: "session-entry",
    index: 2,
    entry: tool("t1", "mcp__vitro__navigate", "completed", [text("Navigated to http://localhost:5173/")], { url: "http://localhost:5173/" }),
  },
  { event: "session-entry", index: 3, entry: tool("t2", "mcp__vitro__screenshot", "in_progress", []) },
  { event: "session-entry", index: 3, entry: tool("t2", "mcp__vitro__screenshot", "completed", [shot(0)]) },
  { event: "session-entry", index: 4, entry: tool("t3", "mcp__vitro__click", "completed", [text("Clicked “Deploys”")], { element: "Deploys tab" }) },
  { event: "session-entry", index: 5, entry: tool("t4", "mcp__vitro__screenshot", "in_progress", []) },
  { event: "session-entry", index: 5, entry: tool("t4", "mcp__vitro__screenshot", "completed", [shot(1)]) },
  {
    event: "session-entry",
    index: 6,
    entry: {
      type: "agent",
      text: "The dashboard loads and the Deploys tab shows three deploys today. Both screenshots are above; nothing looks broken.",
      messageId: "m2",
    },
  },
  { event: "session-info", running: false, stopReason: "end_turn" },
];
