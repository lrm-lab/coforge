import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import {
  FOOT_BAR_HOLD_MS,
  createFootBarFoldState,
  flushFootBarPending,
  openFootBarNow,
  resetFootBarScroll,
  setFootBarFocus,
  stepFootBarScroll,
  type FootBarFoldState,
} from "#src/lib/foot-bar-fold";
import { activePageFlowDepth } from "#src/lib/page-flow-handoff";

export function useFootBarFold({
  scrollRootRef,
  activeKey,
}: {
  scrollRootRef: RefObject<HTMLElement | null>;
  activeKey: string;
}) {
  const [folded, setFolded] = useState(false);
  const [initialFoldState] = useState(createFootBarFoldState);
  const stateRef = useRef<FootBarFoldState>(initialFoldState);
  const activeScrollerRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const commit = useCallback((next: FootBarFoldState) => {
    const prevFolded = stateRef.current.folded;
    stateRef.current = next;
    if (next.folded !== prevFolded) {
      setFolded(next.folded);
    }
    clearTimeout(timerRef.current);
    if (next.pendingFolded !== null) {
      const remaining = Math.max(0, FOOT_BAR_HOLD_MS - (performance.now() - next.lastTransitionAt));
      timerRef.current = setTimeout(() => {
        commit(flushFootBarPending(stateRef.current, performance.now()));
      }, remaining + 4);
    }
  }, []);

  useEffect(() => {
    activeScrollerRef.current = null;
    commit(resetFootBarScroll(stateRef.current));
  }, [activeKey, commit]);

  useEffect(() => {
    const root = scrollRootRef.current;
    if (!root) return;

    const onContainerScroll = (event: Event) => {
      if (activePageFlowDepth() > 0) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.hasAttribute("data-tab-home-scroll")) return;
      activeScrollerRef.current = target;
      commit(
        stepFootBarScroll(stateRef.current, {
          scrollTop: target.scrollTop,
          maxScrollTop: target.scrollHeight - target.clientHeight,
          viewportHeight: target.clientHeight,
          now: performance.now(),
        }),
      );
    };

    const onWindowScroll = () => {
      if (activePageFlowDepth() > 0) return;
      const doc = document.documentElement;
      if (!root.closest("[data-phone-page-scroll]")) return;
      activeScrollerRef.current = null;
      commit(
        stepFootBarScroll(stateRef.current, {
          scrollTop: window.scrollY,
          maxScrollTop: doc.scrollHeight - window.innerHeight,
          viewportHeight: window.innerHeight,
          now: performance.now(),
        }),
      );
    };

    root.addEventListener("scroll", onContainerScroll, { capture: true, passive: true });
    window.addEventListener("scroll", onWindowScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onContainerScroll, { capture: true });
      window.removeEventListener("scroll", onWindowScroll);
      clearTimeout(timerRef.current);
    };
  }, [scrollRootRef, commit]);

  const open = useCallback(() => {
    commit(openFootBarNow(stateRef.current, performance.now()));
  }, [commit]);

  const onFocusCapture = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches(":focus-visible")) return;
      commit(setFootBarFocus(stateRef.current, true, performance.now()));
    },
    [commit],
  );

  const onBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      commit(setFootBarFocus(stateRef.current, false, performance.now()));
    },
    [commit],
  );

  const scrollToTop = useCallback(
    (reducedMotion: boolean) => {
      const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";
      if (
        scrollRootRef.current?.closest("[data-phone-page-scroll]") &&
        (window.scrollY > 0 || !activeScrollerRef.current)
      ) {
        window.scrollTo({ top: 0, behavior });
        return;
      }
      const scroller =
        activeScrollerRef.current ??
        scrollRootRef.current?.querySelector<HTMLElement>("[data-tab-home-scroll]") ??
        null;
      if (!scroller) return;
      scroller.scrollTo({ top: 0, behavior });
    },
    [scrollRootRef],
  );

  return {
    folded,
    open,
    onFocusCapture,
    onBlurCapture,
    scrollToTop,
  };
}
