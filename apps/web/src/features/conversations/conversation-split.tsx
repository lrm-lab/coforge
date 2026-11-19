import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { AnimatePresence, motion } from "motion/react";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import {
  animateFlipFromRect,
  cancelFlipAnimation,
  consumeSharedRect,
} from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";
import { DURATION_S, EASE_IN, EASE_OUT } from "#src/utils/motion-tokens";

import { useReportChatListCrowd } from "./chat-list-crowd";
import type { FocusedPanel } from "./conversation-focus-model";
import { CONVERSATION_LIST_COLUMN } from "./conversation-list-width";
import { localLayoutStorage } from "./local-layout-storage";

const MAIN_PANE_MIN_REM = 24;
const SIDE_PANE_MIN_REM = 22;
const LIST_COLUMN_DEFAULT_REM = 18;

const SIDE_PANE_ENTER = "animate-in fade-in slide-in-from-right-6 motion-enter";

export function ConversationSplit({
  main,
  side,
  visibleSlot,
  threadAlone,
  focused,
}: {
  main: ReactNode;
  side: ReactNode;
  visibleSlot: ConversationSlot | undefined;
  threadAlone: boolean;
  focused?: FocusedPanel;
}) {
  const threadLayout = useDefaultLayout({
    id: "coforge-conversation",
    panelIds: visibleSlot ? ["main", visibleSlot] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });
  const wideViewport = useBreakpoint("md");
  const reduced = usePrefersReducedMotion();
  const splitRef = useRef<HTMLDivElement>(null);
  const sideWrapRef = useRef<HTMLDivElement>(null);
  const [splitFits, setSplitFits] = useState(true);
  const [listCrowds, setListCrowds] = useState(false);
  useReportChatListCrowd(Boolean(visibleSlot) && listCrowds && !threadAlone);
  const measureSplit = useCallback(() => {
    const element = splitRef.current;
    if (!element) return;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const cards = element.closest<HTMLElement>("[data-chat-cards]");
    const listBeside = cards !== null && getComputedStyle(cards).flexDirection === "row";
    const layout = splitLayout({
      rem,
      pane: element.clientWidth,
      beside: listBeside
        ? {
            area: cards.clientWidth,
            list: listColumnWidth(rem),
            gap: Number.parseFloat(getComputedStyle(cards).columnGap) || 0,
          }
        : undefined,
    });
    setSplitFits(layout.splitFits);
    setListCrowds(layout.listCrowds);
  }, []);
  const splitShown = wideViewport && splitFits;
  useLayoutEffect(() => {
    const element = splitRef.current;
    if (!element) return;
    measureSplit();
    const observer = new ResizeObserver(measureSplit);
    observer.observe(element);
    const cards = element.closest("[data-chat-cards]");
    if (cards) observer.observe(cards);
    return () => observer.disconnect();
  }, [measureSplit, splitShown]);

  useLayoutEffect(() => {
    if (!splitShown || !visibleSlot || reduced || !sideWrapRef.current) return;
    const origin = consumeSharedRect("side-pane-origin");
    if (!origin) return;
    const node = sideWrapRef.current;
    node.style.animation = "none";
    const anim = animateFlipFromRect(node, origin, {
      duration: 280,
      mode: "box",
      includeRadius: true,
    });
    return () => {
      if (anim) cancelFlipAnimation(node);
      node.style.animation = "";
    };
  }, [reduced, splitShown, visibleSlot]);

  if (!splitShown || threadAlone) {
    return (
      <div ref={splitRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {!threadAlone && (
          <div
            inert={Boolean(visibleSlot && focused !== "chat") || undefined}
            aria-hidden={Boolean(visibleSlot && focused !== "chat") || undefined}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {main}
          </div>
        )}
        <AnimatePresence initial={false}>
          {visibleSlot && focused !== "chat" && (
            <motion.div
              key={visibleSlot}
              ref={sideWrapRef}
              initial={reduced ? { opacity: 0 } : { x: "100%" }}
              animate={reduced ? { opacity: 1 } : { x: 0 }}
              exit={
                reduced
                  ? { opacity: 0, transition: { duration: DURATION_S.reduced } }
                  : { x: "100%", transition: { duration: DURATION_S.lgOut, ease: EASE_IN } }
              }
              transition={
                reduced
                  ? { duration: DURATION_S.reduced }
                  : { duration: DURATION_S.lg, ease: EASE_OUT }
              }
              className="absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col bg-primary shadow-xl will-change-transform"
            >
              {side}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }
  return (
    <div ref={splitRef} className="flex min-h-0 min-w-0 flex-1">
      <Group
        id="conversation"
        orientation="horizontal"
        defaultLayout={threadLayout.defaultLayout}
        onLayoutChanged={threadLayout.onLayoutChanged}
        className="flex min-h-0 min-w-0 flex-1"
      >
        <Panel
          id="main"
          minSize={`${MAIN_PANE_MIN_REM}rem`}
          hidden={focused === "thread"}
          className="flex min-h-0 min-w-0 flex-col"
        >
          {main}
        </Panel>
        {visibleSlot && (
          <>
            {!focused && (
              <Separator
                aria-label={
                  visibleSlot === "thread" ? m.conversation_thread() : m.agent_profile_resize()
                }
                className="hidden w-px shrink-0 bg-border-secondary transition-colors hover:bg-brand-solid data-[separator=active]:bg-brand-solid md:block"
              />
            )}
            <Panel
              id={visibleSlot}
              defaultSize="35"
              minSize={`${SIDE_PANE_MIN_REM}rem`}
              maxSize="60"
              hidden={focused === "chat"}
              className="flex min-h-0 min-w-0 flex-col"
            >
              <div
                ref={sideWrapRef}
                className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-primary", SIDE_PANE_ENTER)}
              >
                {side}
              </div>
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}

export function splitLayout({
  rem,
  pane,
  beside,
}: {
  rem: number;
  pane: number;
  beside?: { area: number; list: number; gap: number };
}): { splitFits: boolean; listCrowds: boolean } {
  const needed = (MAIN_PANE_MIN_REM + SIDE_PANE_MIN_REM) * rem;
  if (!beside) return { splitFits: pane >= needed, listCrowds: false };
  const besideList = beside.area - beside.list - beside.gap;
  const listCrowds = besideList < needed;
  return { splitFits: (listCrowds ? beside.area : besideList) >= needed, listCrowds };
}

function listColumnWidth(rem: number) {
  const set = getComputedStyle(document.documentElement).getPropertyValue(
    CONVERSATION_LIST_COLUMN.property,
  );
  const width = Number.parseFloat(set);
  return Number.isFinite(width) && width > 0 ? width : LIST_COLUMN_DEFAULT_REM * rem;
}
