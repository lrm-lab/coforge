import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import {
  applyListWidth,
  commitListWidth,
  getListWidth,
  setListWidth,
  useListWidth,
} from "./conversation-list-layout";
import {
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_MAX,
  LIST_WIDTH_MIN,
  dragListWidth,
  keyListWidth,
} from "./conversation-list-width";

/**
 * The drag handle on the list column's right edge, from `lg`. A drag shows its width live and
 * keeps it on release. The drag follows the pointer on the window as well as by capture, so it
 * keeps going when the pointer leaves the handle.
 */
export function ConversationListResizeHandle() {
  const width = useListWidth();
  const [dragging, setDragging] = useState(false);
  const stopDrag = useRef<AbortController | undefined>(undefined);

  // Unmounting mid-drag keeps what is showing, so the page and storage do not disagree.
  useEffect(
    () => () => {
      if (!stopDrag.current) return;
      stopDrag.current.abort();
      stopDrag.current = undefined;
      commitListWidth();
    },
    [],
  );
  useEffect(() => {
    if (!dragging) return;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const { pointerId, clientX: startX } = event;
    const startWidth = getListWidth();
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // Pointer capture is best-effort; the window listeners still track the pointer.
    }
    stopDrag.current?.abort();
    const abort = new AbortController();
    stopDrag.current = abort;
    const move = (moved: globalThis.PointerEvent) => {
      if (moved.pointerId !== pointerId) return;
      applyListWidth(dragListWidth(startWidth, startX, moved.clientX));
    };
    const end = (ended: globalThis.PointerEvent) => {
      if (ended.pointerId !== pointerId) return;
      abort.abort();
      stopDrag.current = undefined;
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Already released.
      }
      setDragging(false);
      commitListWidth();
    };
    window.addEventListener("pointermove", move, { signal: abort.signal });
    window.addEventListener("pointerup", end, { signal: abort.signal });
    window.addEventListener("pointercancel", end, { signal: abort.signal });
    setDragging(true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = keyListWidth(event, width);
    if (next === undefined) return;
    event.preventDefault();
    setListWidth(next);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={m.conversation_list_resize()}
      aria-valuenow={Math.round(width)}
      aria-valuemin={LIST_WIDTH_MIN}
      aria-valuemax={LIST_WIDTH_MAX}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setListWidth(LIST_WIDTH_DEFAULT)}
      onKeyDown={onKeyDown}
      className={cx(
        "absolute inset-y-0 right-0 z-10 hidden w-3 cursor-col-resize touch-none outline-hidden lg:block pointer-coarse:w-6",
        // The line shows only while it is being used.
        "after:absolute after:inset-y-0 after:right-0 after:w-0.5 hover:after:bg-brand-solid focus-visible:after:bg-brand-solid data-dragging:after:bg-brand-solid",
      )}
    />
  );
}
