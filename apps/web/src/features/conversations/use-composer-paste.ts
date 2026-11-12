import type { ClipboardEvent } from "react";

import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { filesFromPaste } from "./composer-behavior";
import { ensureInlineImage, imageFileFromUrl, imageUrlsFromPaste } from "./paste-image";

/**
 * Paste images through the same upload path as the paperclip button. Covers three clipboard
 * shapes: real file bytes (Finder copies, screenshot tools), image URLs without bytes (copied
 * from a web page — fetched to a blob here), and non-inline rasters (e.g. TIFF — re-encoded to
 * PNG). A paste with nothing image-like now says so instead of staying silent, which used to
 * read as a broken send button. Plain-text pastes are still left to the browser.
 */
export function useComposerPaste(room: number, onFiles: (files: File[]) => void) {
  const toast = useAppToast();
  return async function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboard = event.clipboardData;
    const files = filesFromPaste(clipboard);
    const urls = files.length > 0 ? [] : imageUrlsFromPaste(clipboard);
    if (files.length === 0 && urls.length === 0) return;
    event.preventDefault();
    const inlineReady = await Promise.all(files.map((file) => ensureInlineImage(file)));
    const fetched: File[] = [];
    for (const url of urls) {
      if (fetched.length + inlineReady.length >= room) break;
      const file = await imageFileFromUrl(url);
      if (file) fetched.push(await ensureInlineImage(file));
    }
    const ready = [...inlineReady, ...fetched];
    if (ready.length === 0) {
      toast.error(m.conversation_paste_no_image());
      return;
    }
    onFiles(ready);
  };
}
