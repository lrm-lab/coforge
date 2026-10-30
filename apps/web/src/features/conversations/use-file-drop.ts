import { useRef, useState, type DragEvent } from "react";
import { dragCarriesFiles, filesFromDrop } from "./composer-behavior";

/**
 * Drag a file over the composer to upload it through the same path as paste and the paperclip
 * button. Only a native file drag (`dragCarriesFiles`) is intercepted; a text or URL drag is left
 * untouched so the browser's own drop-to-insert behaviour still reaches the textarea. Always
 * calling `preventDefault` for a file drag (even while disabled) also keeps the browser from
 * navigating away to open the dropped file.
 */
export function useFileDrop(disabled: boolean, onFiles: (files: File[]) => void) {
  // Counts nested dragenter/dragleave pairs across the form's descendants, so the drop
  // affordance does not flicker as the pointer crosses child element boundaries.
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const handlers = {
    onDragEnter(event: DragEvent<HTMLFormElement>) {
      if (!dragCarriesFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      if (disabled) return;
      depth.current += 1;
      setDragging(true);
    },
    onDragOver(event: DragEvent<HTMLFormElement>) {
      if (!dragCarriesFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    },
    onDragLeave(event: DragEvent<HTMLFormElement>) {
      if (!dragCarriesFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop(event: DragEvent<HTMLFormElement>) {
      if (!dragCarriesFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (disabled) return;
      const files = filesFromDrop(event.dataTransfer);
      if (files.length > 0) onFiles(files);
    },
  };
  return { dragging, handlers };
}
