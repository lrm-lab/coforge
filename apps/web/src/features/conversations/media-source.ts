import { useEffect, useState } from "react";

import { mediaMimeType } from "./attachment-preview-kind";

/** Without a delivery URL a video or audio file is held in memory whole (see `useMediaSource`);
 * past this the reader is better served by the download. */
export const MEDIA_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

export type MediaSourceState =
  | { status: "loading" }
  | { status: "ready"; src: string; fallbackSrc?: string }
  | { status: "error"; tooLarge: boolean };

/**
 * Where a video or audio attachment plays from; nothing is read while `enabled` is false, and a
 * new `attempt` reads it again.
 *
 * With a signed delivery URL (`previewUrl`, a video where delivery is configured) the element
 * streams it from the CDN; once that URL has expired, the attachment route (`href`) redirects to a
 * freshly signed one, so the route is the fallback. Without one, the route serves the file as an
 * opaque download with no range requests: the whole file is fetched (bounded by
 * `MEDIA_PREVIEW_MAX_BYTES`) and played from a Blob retyped from our own allowlist, so the browser
 * decodes media and never sniffs the bytes into markup.
 */
export function useMediaSource({
  fileName,
  href,
  previewUrl,
  enabled = true,
  attempt = 0,
}: {
  fileName: string;
  href: string;
  previewUrl?: string;
  enabled?: boolean;
  attempt?: number;
}): MediaSourceState {
  // The read's result, with the inputs it was read for: one for other inputs (a retry) is stale,
  // its object URL already revoked.
  const read = `${href} ${fileName} ${attempt}`;
  const [blob, setBlob] = useState<{ read: string; state: MediaSourceState }>();
  const fetchBlob = enabled && !previewUrl;

  useEffect(() => {
    if (!fetchBlob) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    const setBlobState = (state: MediaSourceState) => setBlob({ read, state });
    (async () => {
      try {
        const mimeType = mediaMimeType(fileName);
        if (!mimeType) throw new Error("not a playable media type");
        // `?download` streams the bytes even where delivery would redirect them off this origin.
        const response = await fetch(`${href}?download`, { signal: controller.signal });
        if (!response.ok) throw new Error(`attachment media failed (${response.status})`);
        const bytes = await response.blob();
        if (controller.signal.aborted) return;
        if (bytes.size > MEDIA_PREVIEW_MAX_BYTES) {
          setBlobState({ status: "error", tooLarge: true });
          return;
        }
        // Retyped from our allowlist rather than trusting the stored content type.
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        setBlobState({ status: "ready", src: objectUrl });
      } catch {
        if (!controller.signal.aborted) setBlobState({ status: "error", tooLarge: false });
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fetchBlob, fileName, href, read]);

  if (!enabled) return { status: "loading" };
  if (previewUrl) return { status: "ready", src: previewUrl, fallbackSrc: href };
  return blob?.read === read ? blob.state : { status: "loading" };
}
