import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";

import type { FocusedPanel } from "./conversation-focus-model";
import { CONVERSATION_LIST_COLUMN } from "./conversation-list-width";
import { localLayoutStorage } from "./local-layout-storage";

const MAIN_PANE_MIN_REM = 24;
const SIDE_PANE_MIN_REM = 22;
const LIST_COLUMN_DEFAULT_REM = 18;

const SIDE_PANE_ENTER = "animate-in fade-in slide-in-from-right-6 motion-enter-lg";

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
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitFits, setSplitFits] = useState(true);
  const [listCrowds, setListCrowds] = useState(false);
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
  if (!splitShown || threadAlone) {
    return (
      <div
        ref={splitRef}
        data-crowd-list={visibleSlot && !threadAlone && listCrowds ? "" : undefined}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {!threadAlone && (
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              visibleSlot && focused !== "chat" && "hidden",
            )}
          >
            {main}
          </div>
        )}
        {visibleSlot && (
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              SIDE_PANE_ENTER,
              focused === "chat" && "hidden",
            )}
          >
            {side}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      ref={splitRef}
      data-crowd-list={visibleSlot && listCrowds ? "" : undefined}
      className="flex min-h-0 min-w-0 flex-1"
    >
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
              className={cn("flex min-h-0 min-w-0 flex-col", SIDE_PANE_ENTER)}
            >
              {side}
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
