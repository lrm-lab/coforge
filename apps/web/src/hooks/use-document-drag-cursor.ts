import { useEffect } from "react";

/** How many mounted drags currently hold the mark; the last one to end removes it. */
let holders = 0;

/**
 * Marks the document root (`html[data-drag-cursor]`) while `dragging` is true, so `styles.css` shows
 * one grabbing cursor over the whole page; without it the cursor follows whatever is under the
 * pointer. Give the DragOverlay `pointer-events-none`, so the place beneath it can say "not
 * allowed" (`data-drop-blocked`). Unmounting mid-drag also releases the mark.
 * Native HTML5 drags cannot use this: the browser draws their cursor.
 */
export function useDocumentDragCursor(dragging: boolean) {
  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    holders += 1;
    root.dataset.dragCursor = "";
    return () => {
      holders -= 1;
      if (holders === 0) delete root.dataset.dragCursor;
    };
  }, [dragging]);
}
