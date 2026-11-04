// An image from the chat's image store (or inline, in older chats) as a URL to draw it with.
import { useEffect, useState } from "react";
import { imageUrl, type ImageBlock } from "@/lib/attachments";
import { formatBytes } from "@/lib/format";

/** The URL to draw `block` with once it's ready; `null` until then (or when there's nothing to draw). */
export function useImageUrl(
  sessionId: string | undefined,
  block: Pick<ImageBlock, "image" | "data" | "mimeType">,
): { url: string | null; failed: boolean } {
  const { image, data, mimeType } = block;
  const [state, setState] = useState<{ key: string; url: string | null; failed: boolean }>({ key: "", url: null, failed: false });
  const key = `${sessionId}/${image ?? ""}/${data?.length ?? 0}`;
  useEffect(() => {
    const p = imageUrl(sessionId, { image, data, mimeType });
    if (!p) return;
    let live = true;
    p.then(
      (url) => live && setState({ key, url, failed: false }),
      () => live && setState({ key, url: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [key, sessionId, image, data, mimeType]);
  return state.key === key ? state : { url: null, failed: false };
}

/** "1280 × 800 · 245.0 KB". */
export function imageFacts(img: { width?: number; height?: number; size?: number; mimeType?: string }): string {
  const parts = [];
  if (img.width && img.height) parts.push(`${img.width} × ${img.height}`);
  if (img.size) parts.push(formatBytes(img.size));
  if (img.mimeType) parts.push(img.mimeType.replace("image/", "").toUpperCase());
  return parts.join(" · ");
}
