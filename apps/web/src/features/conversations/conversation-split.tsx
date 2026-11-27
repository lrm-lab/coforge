import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Group, Panel, Separator, useDefaultLayout, useGroupRef } from "react-resizable-panels";
import { AnimatePresence } from "motion/react";
import * as motion from "motion/react-m";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
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
const SIDE_PANE_DEFAULT_PCT = 35;
const LIST_COLUMN_DEFAULT_REM = 18;

export const SIDE_PANE_ENTER =
  "animate-in fade-in slide-in-from-right-3 motion-enter-sm motion-reduce:animate-none";

export type ResponsiveSplitState = {
  splitRef: RefObject<HTMLDivElement | null>;
  splitShown: boolean;
};

export function useResponsiveSplitLayout({
  active,
  mainMinRem = MAIN_PANE_MIN_REM,
  sideMinRem = SIDE_PANE_MIN_REM,
  reportListCrowd = true,
  enabled = true,
}: {
  active: boolean;
  mainMinRem?: number;
  sideMinRem?: number;
  reportListCrowd?: boolean;
  enabled?: boolean;
}): ResponsiveSplitState {
  const wideViewport = useBreakpoint("md");
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitFits, setSplitFits] = useState(true);
  const [listCrowds, setListCrowds] = useState(false);
  useReportChatListCrowd(enabled && reportListCrowd && active && listCrowds);
  const measureSplit = useCallback(() => {
    const element = splitRef.current;
    if (!element) return;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const cards = reportListCrowd ? element.closest<HTMLElement>("[data-chat-cards]") : null;
    const listBeside = cards !== null && getComputedStyle(cards).flexDirection === "row";
    const layout = splitLayout({
      rem,
      pane: element.clientWidth,
      mainMinRem,
      sideMinRem,
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
  }, [mainMinRem, reportListCrowd, sideMinRem]);
  const splitShown = wideViewport && splitFits;
  useLayoutEffect(() => {
    if (!enabled) return;
    const element = splitRef.current;
    if (!element) return;
    measureSplit();
    const observer = new ResizeObserver(measureSplit);
    observer.observe(element);
    const cards = reportListCrowd ? element.closest("[data-chat-cards]") : null;
    if (cards) observer.observe(cards);
    return () => observer.disconnect();
  }, [enabled, measureSplit, reportListCrowd, splitShown]);
  return { splitRef, splitShown };
}

export function ConversationSplit({
  main,
  side,
  visibleSlot,
  threadAlone,
  focused,
  sideExpanded = false,
  layoutId = "coforge-conversation",
  mainMinRem = MAIN_PANE_MIN_REM,
  sideMinRem = SIDE_PANE_MIN_REM,
  defaultSidePct = SIDE_PANE_DEFAULT_PCT,
  reportListCrowd = false,
  forceSplit = false,
  split,
}: {
  main: ReactNode;
  side: ReactNode;
  visibleSlot: ConversationSlot | undefined;
  threadAlone: boolean;
  focused?: FocusedPanel;
  sideExpanded?: boolean;
  layoutId?: string;
  mainMinRem?: number;
  sideMinRem?: number;
  defaultSidePct?: number;
  reportListCrowd?: boolean;
  forceSplit?: boolean;
  split?: ResponsiveSplitState;
}) {
  const groupRef = useGroupRef();
  const reduced = usePrefersReducedMotion();
  const localSplit = useResponsiveSplitLayout({
    active: !forceSplit && Boolean(visibleSlot) && !threadAlone && !sideExpanded,
    mainMinRem,
    sideMinRem,
    reportListCrowd,
    enabled: !split && !forceSplit,
  });
  const splitRef = split ? split.splitRef : localSplit.splitRef;
  const splitShown = forceSplit || (split ? split.splitShown : localSplit.splitShown);
  const splitPanelsVisible = splitShown && !threadAlone && Boolean(visibleSlot);
  const threadLayout = useDefaultLayout({
    id: layoutId,
    panelIds: splitPanelsVisible && visibleSlot ? ["main", visibleSlot] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });

  return (
    <div ref={splitRef} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {!threadAlone && (
        <Group
          groupRef={groupRef}
          orientation="horizontal"
          disabled={!splitPanelsVisible}
          defaultLayout={threadLayout.defaultLayout}
          onLayoutChanged={threadLayout.onLayoutChanged}
          className={cn(
            "flex min-h-0 min-w-0 flex-1",
            !splitPanelsVisible && "[touch-action:auto]!",
          )}
        >
          <Panel
            id="main"
            minSize={splitPanelsVisible ? `${mainMinRem}rem` : undefined}
            hidden={splitShown && (focused === "thread" || sideExpanded)}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
          >
            <div
              inert={Boolean(!splitShown && visibleSlot && focused !== "chat") || undefined}
              aria-hidden={Boolean(!splitShown && visibleSlot && focused !== "chat") || undefined}
              className="isolate flex min-h-0 min-w-0 flex-1 flex-col"
            >
              {main}
            </div>
          </Panel>
          {splitPanelsVisible && visibleSlot && (
            <>
              {!focused && !sideExpanded && (
                <Separator
                  aria-label={
                    visibleSlot === "thread"
                      ? m.conversation_thread()
                      : visibleSlot === "details"
                        ? m.channel_settings_resize()
                        : visibleSlot === "task"
                          ? m.tasks_panel_resize()
                          : m.agent_profile_resize()
                  }
                  onDoubleClick={() =>
                    groupRef.current?.setLayout({
                      main: 100 - defaultSidePct,
                      [visibleSlot]: defaultSidePct,
                    })
                  }
                  className="group/sep relative flex w-px shrink-0 cursor-col-resize items-center justify-center bg-border-secondary outline-focus-ring transition-colors hover:bg-brand-solid focus-visible:bg-brand-solid focus-visible:outline-2 data-[separator=active]:bg-brand-solid after:absolute after:inset-y-0 after:-inset-x-1.5"
                >
                  <span
                    aria-hidden="true"
                    className="pointer-events-none h-7 w-1 rounded-full bg-fg-quaternary/60 opacity-0 transition-opacity group-hover/sep:opacity-100 group-data-[separator=active]/sep:bg-brand-solid group-data-[separator=active]/sep:opacity-100"
                  />
                </Separator>
              )}
              <Panel
                id={visibleSlot}
                defaultSize={`${defaultSidePct}`}
                minSize={`${sideMinRem}rem`}
                maxSize={sideExpanded ? undefined : "60"}
                hidden={focused === "chat" && !sideExpanded}
                className="flex min-h-0 min-w-0 flex-col overflow-hidden"
              >
                <div
                  data-split-slot={visibleSlot}
                  className={cn(
                    "flex min-h-0 min-w-0 flex-1 flex-col bg-primary",
                    !sideExpanded && SIDE_PANE_ENTER,
                  )}
                >
                  {side}
                </div>
              </Panel>
            </>
          )}
        </Group>
      )}
      <AnimatePresence initial={false}>
        {(!splitShown || threadAlone) && visibleSlot && focused !== "chat" && (
          <motion.div
            key={visibleSlot}
            data-split-slot={visibleSlot}
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
            className="absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col bg-primary shadow-xl"
          >
            {side}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function splitLayout({
  rem,
  pane,
  beside,
  mainMinRem = MAIN_PANE_MIN_REM,
  sideMinRem = SIDE_PANE_MIN_REM,
}: {
  rem: number;
  pane: number;
  beside?: { area: number; list: number; gap: number };
  mainMinRem?: number;
  sideMinRem?: number;
}): { splitFits: boolean; listCrowds: boolean } {
  const needed = (mainMinRem + sideMinRem) * rem;
  if (!beside) return { splitFits: pane >= needed, listCrowds: false };
  const besideList = beside.area - beside.list - beside.gap;
  const listCrowds = besideList < needed;
  return { splitFits: (listCrowds ? beside.area : besideList) >= needed, listCrowds };
}

function listColumnWidth(rem: number) {
  const set = getComputedStyle(document.documentElement)
    .getPropertyValue(CONVERSATION_LIST_COLUMN.property)
    .trim();
  const width = Number.parseFloat(set);
  if (!Number.isFinite(width) || width <= 0) return LIST_COLUMN_DEFAULT_REM * rem;
  return set.endsWith("rem") ? width * rem : width;
}
