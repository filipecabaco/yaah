// The state behind a chat pane's drop zone and its composer's attachments
// (components/composer-attachments.tsx draws them). Rust reads and checks every file
// (src-tauri/src/attachments.rs); these only ask it to and keep what it answers.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from "react";
import { addDropZone, attachments as rust, onIncoming, sendIncoming, type Attachment, type DragState, type Refused } from "@/lib/attachments";
import { errorMessage } from "@/lib/narrow";

/** What a pane shows while something is dragged over it. */
export type PaneDrag = DragState | { text: true } | { browserFiles: number };

/**
 * Makes a chat pane a drop zone. Files from the OS come through Tauri's drag-drop event (real
 * paths); text, and files in a plain browser, through the DOM's. Either way only the pane under
 * the pointer reacts, and what's dropped goes to that pane's composer.
 */
export function useChatDrop(root: RefObject<HTMLElement | null>, sessionId: string, pane: string | undefined) {
  const [drag, setDrag] = useState<PaneDrag | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    return addDropZone({ el, onDrag: setDrag, onDrop: (paths) => sendIncoming(sessionId, pane, { paths }) });
  }, [root, sessionId, pane]);

  const onDragOver = useCallback((e: DragEvent) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes("Files") && !types.includes("text/plain")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const files = [...e.dataTransfer.items].filter((i) => i.kind === "file").length;
    setDrag((d) => (d && "items" in d ? d : files ? { browserFiles: files } : { text: true }));
  }, []);
  const onDragLeave = useCallback((e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag((d) => (d && "items" in d ? d : null));
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      const files = [...e.dataTransfer.files];
      const text = e.dataTransfer.getData("text/plain");
      if (!files.length && !text) return;
      e.preventDefault();
      setDrag(null);
      if (files.length) sendIncoming(sessionId, pane, { blobs: files });
      else sendIncoming(sessionId, pane, { text });
    },
    [sessionId, pane],
  );
  return { drag, handlers: { onDragOver, onDragLeave, onDrop } };
}

export type ComposerAttachments = ReturnType<typeof useComposerAttachments>;

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

/** A composer's attachments: staged in Rust, shown as chips, sent by id. */
export function useComposerAttachments(sessionId: string, pane: string | undefined, insertText: (text: string) => void) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [refused, setRefused] = useState<Refused[]>([]);
  const [pending, setPending] = useState(0);
  const [announce, setAnnounce] = useState("");
  // The latest list, for handlers and the unmount cleanup.
  const held = useRef<Attachment[]>([]);
  useEffect(() => {
    held.current = items;
  }, [items]);

  const took = useCallback((run: Promise<{ added: Attachment[]; refused: Refused[] }>, names: string[]) => {
    setPending((n) => n + 1);
    run
      .then(
        ({ added, refused }) => {
          setItems((now) => [...now, ...added]);
          setRefused(refused);
          if (added.length) setAnnounce(`Attached ${added.map((a) => a.name).join(", ")}`);
        },
        (e: unknown) => setRefused(names.map((name) => ({ name, reason: errorMessage(e) }))),
      )
      .finally(() => setPending((n) => n - 1));
  }, []);

  const addPaths = useCallback(
    (paths: string[]) => {
      if (paths.length)
        took(
          rust.stage(sessionId, paths),
          paths.map((p) => p.split("/").pop() ?? p),
        );
    },
    [sessionId, took],
  );
  const addBlobs = useCallback(
    (blobs: File[]) => {
      const images = blobs.filter((b) => IMAGE_TYPES.test(b.type));
      for (const b of images) took(rust.stagePasted(sessionId, b, b.name), [b.name || "Pasted image"]);
      const others = blobs.filter((b) => !IMAGE_TYPES.test(b.type));
      if (others.length)
        setRefused(
          others.map((b) => ({
            name: b.name || "A pasted file",
            reason: "has no path yaah can attach; drop it on the chat or use Attach",
          })),
        );
    },
    [sessionId, took],
  );

  const insert = useRef(insertText);
  useEffect(() => {
    insert.current = insertText;
  });
  useEffect(
    () =>
      onIncoming(sessionId, pane, (i) => {
        if ("paths" in i) addPaths(i.paths);
        else if ("blobs" in i) addBlobs(i.blobs);
        else if ("staged" in i) took(Promise.resolve({ added: i.staged, refused: i.refused }), []);
        else insert.current(i.text);
      }),
    [sessionId, pane, addPaths, addBlobs, took],
  );
  // What's attached and not sent stays in Rust until the composer goes.
  useEffect(
    () => () => {
      const ids = held.current.map((a) => a.id);
      if (ids.length) rust.discard(ids).catch(() => {});
    },
    [],
  );

  const remove = useCallback((id: string) => {
    const gone = held.current.find((a) => a.id === id);
    setItems((now) => now.filter((a) => a.id !== id));
    if (gone) setAnnounce(`Removed ${gone.name}`);
    rust.discard([id]).catch((e: unknown) => console.error("could not discard the attachment", e));
  }, []);

  /** Sent: Rust has let go of them already. */
  const clear = useCallback(() => {
    setItems([]);
    setRefused([]);
  }, []);

  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = [...e.clipboardData.files];
      if (!files.length) return; // text: the textarea takes it as usual
      e.preventDefault();
      // Files copied in a file manager may come with their paths as a URI list.
      const uris = e.clipboardData
        .getData("text/uri-list")
        .split(/\r?\n/)
        .filter((l) => l.startsWith("file://"))
        .map((l) => decodeURIComponent(l.slice("file://".length)));
      if (uris.length) addPaths(uris);
      else addBlobs(files);
    },
    [addPaths, addBlobs],
  );

  const pick = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: true, directory: false, title: "Attach to this message" });
    const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    addPaths(paths);
  }, [addPaths]);

  return { items, refused, pending: pending > 0, announce, addPaths, remove, clear, onPaste, pick, dismissRefused: () => setRefused([]) };
}
