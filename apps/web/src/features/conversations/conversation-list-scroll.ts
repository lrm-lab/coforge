import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { activePageFlowDepth } from "#src/lib/page-flow-handoff";

export type ConversationListScrollHost = {
  scroller: {
    scrollTop: number;
    closest: (selector: string) => Element | null;
  };
  win: {
    readonly scrollY: number;
    scrollTo: (options: ScrollToOptions) => void;
  };
};

export type ConversationListScrollMode = {
  phone: boolean;
  showList: boolean;
  listVisible: boolean;
  pageFlowActive?: boolean;
};

export function isPhonePageScrollActive(
  scroller: Pick<ConversationListScrollHost["scroller"], "closest">,
): boolean {
  return (
    scroller.closest("[data-phone-page-scroll]") !== null &&
    scroller.closest("[data-phone-stack-root]") !== null
  );
}

function readSurfaceScrollTop(host: ConversationListScrollHost): number {
  return Math.max(
    0,
    isPhonePageScrollActive(host.scroller) ? host.win.scrollY : host.scroller.scrollTop,
  );
}

function readHost(scroller: HTMLElement | null): ConversationListScrollHost | null {
  if (!scroller || typeof window === "undefined") return null;
  return { scroller, win: window };
}

export function createConversationListScrollMemory() {
  let savedScrollTop: number | null = null;
  let pendingRestore = false;
  let suppressAutoReveal = false;
  let wasShowingList = false;

  const reset = () => {
    savedScrollTop = null;
    pendingRestore = false;
    suppressAutoReveal = false;
    wasShowingList = false;
  };

  const recordScroll = (
    host: ConversationListScrollHost,
    mode: ConversationListScrollMode,
    source: "window" | "container",
  ) => {
    if (!mode.phone || !mode.showList || !mode.listVisible || mode.pageFlowActive) return;
    const pageScroll = isPhonePageScrollActive(host.scroller);
    if (source === "window") {
      if (!pageScroll) return;
      savedScrollTop = Math.max(0, host.win.scrollY);
      return;
    }
    if (pageScroll) return;
    savedScrollTop = Math.max(0, host.scroller.scrollTop);
  };

  const captureBeforeLeave = (
    host: ConversationListScrollHost,
    mode: ConversationListScrollMode,
  ) => {
    if (!mode.phone || !mode.showList || mode.pageFlowActive) return;
    savedScrollTop = readSurfaceScrollTop(host);
    pendingRestore = true;
  };

  const syncLayout = (host: ConversationListScrollHost, mode: ConversationListScrollMode) => {
    if (!mode.phone) {
      reset();
      return;
    }
    if (mode.showList && mode.listVisible) {
      if (pendingRestore && savedScrollTop !== null) {
        pendingRestore = false;
        suppressAutoReveal = true;
        if (isPhonePageScrollActive(host.scroller)) {
          host.scroller.scrollTop = 0;
          host.win.scrollTo({ top: savedScrollTop, behavior: "instant" });
        } else {
          host.scroller.scrollTop = savedScrollTop;
        }
      }
      wasShowingList = true;
      return;
    }
    if (!mode.showList) {
      if (wasShowingList && savedScrollTop !== null) {
        pendingRestore = true;
      }
      wasShowingList = false;
      if (
        !mode.listVisible &&
        pendingRestore &&
        savedScrollTop !== null &&
        !isPhonePageScrollActive(host.scroller)
      ) {
        host.scroller.scrollTop = savedScrollTop;
      }
    }
  };

  const finishRestoreFlush = (
    host: ConversationListScrollHost,
    mode: ConversationListScrollMode,
  ) => {
    suppressAutoReveal = false;
    if (
      mode.phone &&
      mode.showList &&
      mode.listVisible &&
      !mode.pageFlowActive &&
      savedScrollTop === null
    ) {
      savedScrollTop = readSurfaceScrollTop(host);
    }
  };

  return {
    reset,
    recordScroll,
    captureBeforeLeave,
    syncLayout,
    finishRestoreFlush,
    isAutoRevealSuppressed: () => suppressAutoReveal,
    getSavedScrollTop: () => savedScrollTop,
  };
}

export function useConversationListScrollRestoration({
  scrollerRef,
  workspaceId,
  phone,
  showList,
  listVisible,
}: {
  scrollerRef: RefObject<HTMLElement | null>;
  workspaceId: string | undefined;
  phone: boolean;
  showList: boolean;
  listVisible: boolean;
}) {
  const [memory] = useState(createConversationListScrollMemory);
  const modeRef = useRef<ConversationListScrollMode>({ phone, showList, listVisible });
  const previousWorkspaceIdRef = useRef(workspaceId);

  useLayoutEffect(() => {
    if (previousWorkspaceIdRef.current !== workspaceId) {
      previousWorkspaceIdRef.current = workspaceId;
      memory.reset();
    }
    modeRef.current = { phone, showList, listVisible };
    const host = readHost(scrollerRef.current);
    if (!host) return;
    memory.syncLayout(host, {
      phone,
      showList,
      listVisible,
      pageFlowActive: activePageFlowDepth() > 0,
    });
  }, [memory, scrollerRef, workspaceId, phone, showList, listVisible]);

  useEffect(() => {
    const host = readHost(scrollerRef.current);
    if (!host) return;
    memory.finishRestoreFlush(host, {
      phone,
      showList,
      listVisible,
      pageFlowActive: activePageFlowDepth() > 0,
    });
  }, [memory, scrollerRef, workspaceId, phone, showList, listVisible]);

  useEffect(() => {
    if (!phone || !showList || !listVisible) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const host: ConversationListScrollHost = { scroller, win: window };
    const currentMode = (): ConversationListScrollMode => ({
      phone,
      showList,
      listVisible,
      pageFlowActive: activePageFlowDepth() > 0,
    });
    const onWindowScroll = () => memory.recordScroll(host, currentMode(), "window");
    const onContainerScroll = () => memory.recordScroll(host, currentMode(), "container");
    window.addEventListener("scroll", onWindowScroll, { passive: true });
    scroller.addEventListener("scroll", onContainerScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onWindowScroll);
      scroller.removeEventListener("scroll", onContainerScroll);
    };
  }, [memory, scrollerRef, phone, showList, listVisible]);

  const captureBeforeLeave = useCallback(() => {
    const host = readHost(scrollerRef.current);
    if (!host) return;
    memory.captureBeforeLeave(host, {
      ...modeRef.current,
      pageFlowActive: activePageFlowDepth() > 0,
    });
  }, [memory, scrollerRef]);

  const shouldRevealCurrentRow = useCallback(() => !memory.isAutoRevealSuppressed(), [memory]);

  return { captureBeforeLeave, shouldRevealCurrentRow };
}
