import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "#src/utils/cx";
import { LIST_BESIDE_CLASSES, type ListBesideFrom } from "./conversation-list-button";
import {
  applyListWidth,
  commitListWidth,
  getListWidth,
  setListWidth,
  useListWidth,
} from "./conversation-list-layout";
import {
  CONVERSATION_LIST_COLUMN,
  dragListWidth,
  keyListWidth,
  type ListColumn,
} from "./conversation-list-width";

/** The width the column shows, measured on the handle's parent (the column): less than the kept
 * one when the page caps it (Activity and Search give the conversation at least half the page), so
 * a drag or a key starts from what is seen. */
function shownWidth(column: ListColumn, handle: HTMLElement): number {
  return handle.parentElement?.getBoundingClientRect().width || getListWidth(column);
}

/**
 * The drag handle on a list column's right edge, from where the list stands beside the pane. A
 * drag shows its width live and keeps it on release. The drag follows the pointer on the window as
 * well as by capture, so it keeps going when the pointer leaves the handle.
 */
export function ConversationListResizeHandle({
  column = CONVERSATION_LIST_COLUMN,
  visibleFrom = "lg",
}: {
  column?: ListColumn;
  /** Where the list stands beside the pane; narrower, it has no edge to drag. */
  visibleFrom?: ListBesideFrom;
}) {
  const width = useListWidth(column);
  const [dragging, setDragging] = useState(false);
  const stopDrag = useRef<AbortController | undefined>(undefined);

  // Unmounting mid-drag keeps what is showing, so the page and storage do not disagree.
  useEffect(
    () => () => {
      if (!stopDrag.current) return;
      stopDrag.current.abort();
      stopDrag.current = undefined;
      commitListWidth(column);
    },
    [column],
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
    const startWidth = shownWidth(column, handle);
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
      applyListWidth(column, dragListWidth(column, startWidth, startX, moved.clientX));
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
      commitListWidth(column);
    };
    window.addEventListener("pointermove", move, { signal: abort.signal });
    window.addEventListener("pointerup", end, { signal: abort.signal });
    window.addEventListener("pointercancel", end, { signal: abort.signal });
    setDragging(true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const shown = shownWidth(column, event.currentTarget);
    const next = keyListWidth(column, event, shown);
    if (next === undefined) return;
    event.preventDefault();
    // Widening a list the page holds narrower than kept would only lower what is kept.
    if (next > shown && next <= width) return;
    setListWidth(column, next);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={column.label()}
      aria-valuenow={Math.round(width)}
      aria-valuemin={column.min}
      aria-valuemax={column.max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setListWidth(column, column.defaultWidth)}
      onKeyDown={onKeyDown}
      className={cx(
        "absolute inset-y-0 right-0 z-10 w-3 cursor-col-resize touch-none outline-hidden pointer-coarse:w-6",
        LIST_BESIDE_CLASSES[visibleFrom].list,
        // The line shows only while it is being used.
        "after:absolute after:inset-y-0 after:right-0 after:w-0.5 hover:after:bg-brand-solid focus-visible:after:bg-brand-solid data-dragging:after:bg-brand-solid",
      )}
    />
  );
}
