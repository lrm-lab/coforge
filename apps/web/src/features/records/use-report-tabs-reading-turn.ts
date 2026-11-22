import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { isReportImageZoomOpen } from "./report-image-zoom";
import {
  clearReadingEdge,
  measureBodyEdge,
  nestedScrollOwnsWheel,
  noteReadingWheel,
  readReadingEdge,
  readingWheelPixels,
  stepMemberReportPage,
  type ReadingEdge,
  type ReadingWheelGesture,
} from "./weekly-report-reading-turn";

export type ReportTabsReadingTurn = {
  reportId: string;
  previousReportId: string | null;
  nextReportId: string | null;
  wheel: { current: ReadingWheelGesture };
  onOpenReport: (reportId: string, edge: ReadingEdge) => void;
};

export function useReportTabsReadingTurn({
  readingTurn,
  allTabIds,
  activeTab,
  setSelectedTab,
  bodyScrollerRef,
  contentEndRef,
}: {
  readingTurn: ReportTabsReadingTurn | undefined;
  allTabIds: string[];
  activeTab: string;
  setSelectedTab: (id: string) => void;
  bodyScrollerRef: RefObject<HTMLDivElement | null>;
  contentEndRef: RefObject<HTMLDivElement | null>;
}) {
  const scrollPlanRef = useRef<{ pageId: string; edge: ReadingEdge } | null>(null);
  const readingTurnRef = useRef(readingTurn);
  readingTurnRef.current = readingTurn;
  const pageIdsRef = useRef(allTabIds);
  pageIdsRef.current = allTabIds;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  useLayoutEffect(() => {
    if (!readingTurn) return;
    const edge = readReadingEdge(readingTurn.reportId);
    if (!edge) return;
    const pageId = edge === "end" ? (allTabIds.at(-1) ?? "") : (allTabIds[0] ?? "");
    if (!pageId) return;
    scrollPlanRef.current = { pageId, edge };
    setSelectedTab(pageId);
    const reportId = readingTurn.reportId;
    const timer = window.setTimeout(() => clearReadingEdge(reportId), 0);
    return () => window.clearTimeout(timer);
  }, [readingTurn?.reportId, allTabIds.join("\u0000")]);

  useLayoutEffect(() => {
    const plan = scrollPlanRef.current;
    const scroller = bodyScrollerRef.current;
    if (!plan || !scroller || plan.pageId !== activeTab) return;
    if (plan.edge === "start") {
      scroller.scrollTop = 0;
    } else if (contentEndRef.current) {
      const delta =
        contentEndRef.current.getBoundingClientRect().bottom -
        scroller.getBoundingClientRect().bottom;
      scroller.scrollTop += delta;
    }
    scrollPlanRef.current = null;
  }, [activeTab]);

  useEffect(() => {
    const scroller = bodyScrollerRef.current;
    if (!readingTurn || !scroller) return;
    const onWheel = (event: WheelEvent) => {
      const current = readingTurnRef.current;
      if (!current || event.ctrlKey || isReportImageZoomOpen()) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const deltaY = readingWheelPixels(event.deltaY, event.deltaMode, scroller.clientHeight);
      if (deltaY === 0 || nestedScrollOwnsWheel(event.target, scroller, deltaY)) return;
      const edge = measureBodyEdge(scroller, contentEndRef.current);
      if (!edge) return;
      const pinned = deltaY > 0 ? edge.atEnd : edge.atStart;
      const turned = noteReadingWheel(current.wheel.current, {
        deltaY,
        pinned,
        now: event.timeStamp || performance.now(),
      });
      current.wheel.current = turned.gesture;
      if (!pinned) return;
      event.preventDefault();
      if (turned.step === 0) return;
      const moved = stepMemberReportPage({
        pageIds: pageIdsRef.current,
        activePageId: activeTabRef.current,
        direction: turned.step,
        previousReportId: current.previousReportId,
        nextReportId: current.nextReportId,
      });
      if (moved.kind === "page") {
        scrollPlanRef.current = { pageId: moved.pageId, edge: moved.edge };
        setSelectedTab(moved.pageId);
      } else if (moved.kind === "report") {
        current.onOpenReport(moved.reportId, moved.edge);
      }
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [readingTurn?.reportId]);
}
