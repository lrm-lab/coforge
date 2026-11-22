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

function rootFontSizePx(): number {
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

function isRtlElement(element: HTMLElement): boolean {
  return getComputedStyle(element).direction === "rtl";
}

function shownWidth(column: ListColumn, handle: HTMLElement): number {
  const px = handle.parentElement?.offsetWidth;
  return px ? px / rootFontSizePx() : getListWidth(column);
}

export function ConversationListResizeHandle({
  column = CONVERSATION_LIST_COLUMN,
  visibleFrom = "lg",
}: {
  column?: ListColumn;
  visibleFrom?: ListBesideFrom;
}) {
  const width = useListWidth(column);
  const [dragging, setDragging] = useState(false);
  const stopDrag = useRef<AbortController | undefined>(undefined);

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
    const remPx = rootFontSizePx();
    const rtl = isRtlElement(handle);
    const startWidth = shownWidth(column, handle);
    try {
      handle.setPointerCapture(pointerId);
    } catch {}
    stopDrag.current?.abort();
    const abort = new AbortController();
    stopDrag.current = abort;
    const move = (moved: globalThis.PointerEvent) => {
      if (moved.pointerId !== pointerId) return;
      applyListWidth(
        column,
        dragListWidth(column, startWidth, startX / remPx, moved.clientX / remPx, rtl),
      );
    };
    const end = (ended: globalThis.PointerEvent) => {
      if (ended.pointerId !== pointerId) return;
      abort.abort();
      stopDrag.current = undefined;
      try {
        handle.releasePointerCapture(pointerId);
      } catch {}
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
    const next = keyListWidth(column, event, shown, isRtlElement(event.currentTarget));
    if (next === undefined) return;
    event.preventDefault();
    if (next > shown && next <= width) return;
    setListWidth(column, next);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={column.label()}
      aria-valuenow={Math.round(width * 10) / 10}
      aria-valuemin={column.min}
      aria-valuemax={column.max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={() => setListWidth(column, column.defaultWidth)}
      onKeyDown={onKeyDown}
      className={cx(
        "absolute inset-y-0 z-10 w-3 cursor-col-resize touch-none outline-hidden pointer-coarse:w-6",
        LIST_BESIDE_CLASSES[visibleFrom].list,
        "after:absolute after:inset-y-0 after:w-0.5 hover:after:bg-brand-solid focus-visible:after:bg-brand-solid data-dragging:after:bg-brand-solid",
        column.edge === "left" ? "start-0 after:start-0" : "end-0 after:end-0",
      )}
    />
  );
}
