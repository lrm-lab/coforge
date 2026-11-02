import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, XClose as X } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { ReportSectionEditor } from "./report-editor/report-section-editor";
import { isReportImageZoomOpen } from "./report-image-zoom";
import { stepReportPage } from "./report-present";
import { RecordsReadingColumn } from "./records-reading-column";
import {
  initialReadingWheelGesture,
  measureBodyEdge,
  nestedScrollOwnsWheel,
  noteReadingWheel,
  readingWheelPixels,
  type ReadingEdge,
} from "./weekly-report-reading-turn";

export function ReportPresentMode({
  pages,
  startIndex,
  placeholder,
  onClose,
}: {
  pages: ReadonlyArray<{ name: string; markdown: string }>;
  startIndex: number;
  placeholder: string;
  onClose: (index: number) => void;
}) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(startIndex, 0), Math.max(pages.length - 1, 0)),
  );
  const page = pages[index];
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentEndRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef(initialReadingWheelGesture());
  const scrollEdgeRef = useRef<ReadingEdge | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const pageCountRef = useRef(pages.length);
  pageCountRef.current = pages.length;

  function turnPage(direction: -1 | 1) {
    const next = stepReportPage(indexRef.current, pageCountRef.current, direction);
    if (next === indexRef.current) return;
    scrollEdgeRef.current = direction > 0 ? "start" : "end";
    setIndex(next);
  }
  const turnPageRef = useRef(turnPage);
  turnPageRef.current = turnPage;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (isReportImageZoomOpen()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose(indexRef.current);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        turnPageRef.current(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        turnPageRef.current(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, pages.length]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const edge = scrollEdgeRef.current;
    scrollEdgeRef.current = null;
    if (!scroller || !edge) return;
    if (edge === "start") {
      scroller.scrollTop = 0;
      return;
    }
    const end = contentEndRef.current;
    if (!end) return;
    scroller.scrollTop +=
      end.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
  }, [index]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || isReportImageZoomOpen()) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const deltaY = readingWheelPixels(event.deltaY, event.deltaMode, scroller.clientHeight);
      if (deltaY === 0 || nestedScrollOwnsWheel(event.target, scroller, deltaY)) return;
      const edge = measureBodyEdge(scroller, contentEndRef.current);
      if (!edge) return;
      const pinned = deltaY > 0 ? edge.atEnd : edge.atStart;
      const turned = noteReadingWheel(gestureRef.current, {
        deltaY,
        pinned,
        now: event.timeStamp || performance.now(),
      });
      gestureRef.current = turned.gesture;
      if (!pinned) return;
      event.preventDefault();
      if (turned.step === 0) return;
      turnPageRef.current(turned.step);
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [pages.length]);

  if (!page) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-primary safe-area-padding"
      role="dialog"
      aria-modal="true"
      aria-label={page.name}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-secondary px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-md font-semibold text-primary">{page.name}</h2>
        <span className="text-sm text-tertiary">
          {index + 1} / {pages.length}
        </span>
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={X}
          aria-label={m.records_report_present_close()}
          onClick={() => onClose(index)}
        />
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={scrollerRef} className="h-full overflow-y-auto overscroll-y-contain">
          <RecordsReadingColumn className="py-8">
            <ReportSectionEditor
              key={page.name}
              defaultValue={page.markdown}
              placeholder={placeholder}
              editable={false}
              onUpdate={() => {}}
            />
          </RecordsReadingColumn>
          <div ref={contentEndRef} className="h-px" aria-hidden="true" />
        </div>
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={ChevronLeft}
          aria-label={m.records_report_present_prev()}
          isDisabled={index === 0}
          onClick={() => turnPage(-1)}
          className="absolute top-1/2 left-3 -translate-y-1/2"
        />
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={ChevronRight}
          aria-label={m.records_report_present_next()}
          isDisabled={index === pages.length - 1}
          onClick={() => turnPage(1)}
          className="absolute top-1/2 right-3 -translate-y-1/2"
        />
      </div>
    </div>,
    document.body,
  );
}
