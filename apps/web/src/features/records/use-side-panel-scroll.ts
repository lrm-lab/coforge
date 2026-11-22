import { useEffect, useLayoutEffect, useRef } from "react";

export function useSidePanelScroll({
  sessionKey,
  activeSessionId,
  timelineTailId,
  timelineLength,
  awaitingSynthesis,
}: {
  sessionKey: string;
  activeSessionId: string | null;
  timelineTailId: string;
  timelineLength: number;
  awaitingSynthesis: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const scrollReleaseTimerRef = useRef<number | null>(null);

  function scrollThreadToBottom(behavior: ScrollBehavior = "auto") {
    const scroller = scrollRef.current;
    if (!scroller) return;
    programmaticScrollRef.current = true;
    if (scrollReleaseTimerRef.current != null) {
      window.clearTimeout(scrollReleaseTimerRef.current);
      scrollReleaseTimerRef.current = null;
    }
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    scroller.scrollTop = scroller.scrollHeight;
    const releaseMs = behavior === "smooth" ? 450 : 0;
    scrollReleaseTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      scrollReleaseTimerRef.current = null;
    }, releaseMs);
  }

  function onThreadScroll() {
    if (programmaticScrollRef.current) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    stickToBottomRef.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 72;
  }

  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    scrollThreadToBottom("auto");
  }, [sessionKey, activeSessionId]);

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    scrollThreadToBottom("auto");
  }, [timelineTailId, timelineLength, awaitingSynthesis]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      scrollThreadToBottom("auto");
    });
    observer.observe(scroller);
    for (const child of scroller.children) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [timelineTailId, timelineLength]);

  useEffect(() => {
    return () => {
      if (scrollReleaseTimerRef.current != null) {
        window.clearTimeout(scrollReleaseTimerRef.current);
      }
    };
  }, []);

  return { scrollRef, stickToBottomRef, onThreadScroll };
}
