import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";

import type { FocusedPanel } from "./conversation-focus-model";
import { CONVERSATION_LIST_COLUMN } from "./conversation-list-width";
import { localLayoutStorage } from "./local-layout-storage";

/** The narrowest the conversation and the thread/profile pane may be dragged; together, the
 * narrowest area that shows them side by side. */
const MAIN_PANE_MIN_REM = 24;
const SIDE_PANE_MIN_REM = 22;
/** The list column's width before one is set (`LIST_COLUMN_CLASS`'s fallback). */
const LIST_COLUMN_DEFAULT_REM = 18;

/** The conversation beside its thread or profile pane, resizable while there is room for both. */
export function ConversationSplit({
  main,
  side,
  visibleSlot,
  threadAlone,
  focused,
}: {
  main: ReactNode;
  /** The pane beside the conversation, told whether the conversation stands beside it (not covered
   * by it, not in full screen), which the thread's title depends on. */
  side: (beside: boolean) => ReactNode;
  visibleSlot: ConversationSlot | undefined;
  /** A thread shown without its conversation (Activity). */
  threadAlone: boolean;
  /** The pane in full screen (task #75): the other and the separator hide. The panes stay mounted,
   * and the library keeps its sizes, so leaving restores the split. */
  focused?: FocusedPanel;
}) {
  // The thread/profile pane's share of the width is the user's to set; remembered across visits,
  // and kept separate per slot (`react-resizable-panels` derives its storage key from `panelIds`,
  // so ["main","thread"] and ["main","profile"] never share or corrupt each other's saved size).
  const threadLayout = useDefaultLayout({
    id: "coforge-conversation",
    panelIds: visibleSlot ? ["main", visibleSlot] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });
  // Panels are flex items sized by the library's inline styles, so a narrow viewport cannot
  // collapse the split with CSS; unmount the resizable Group and stack full-width panes
  // instead. Both panes stay mounted so drafts and scroll survive, matching the desktop slot.
  const wideViewport = useBreakpoint("md");
  // Side by side only while both panes fit at their minimum width; below that the slot pane
  // covers the conversation, as on a phone, instead of squeezing either into a strip.
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitFits, setSplitFits] = useState(true);
  // Whether the Chat list must give way to an open pane (`data-crowd-list`; `splitLayout`).
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
  // Each layout renders its own measured wrapper, so observe again whenever the layout switches.
  // Before paint, so a window too narrow for both panes never flashes the squeezed split.
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
    // Small screens have no room for a resizable split: the slot pane covers the main pane,
    // which stays mounted (hidden) so returning keeps its scroll, drafts and read state. A thread
    // shown alone fills the pane at every width without the conversation, which mounts afresh at
    // its jump message once it is shown.
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
            className={cn("flex min-h-0 min-w-0 flex-1 flex-col", focused === "chat" && "hidden")}
          >
            {side(false)}
          </div>
        )}
      </div>
    );
  }
  return (
    // Measured, so the split knows when its panes stop fitting side by side. `data-crowd-list` (here
    // and above) asks the conversation list to give way while a pane is open beside the chat.
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
              className="flex min-h-0 min-w-0 flex-col"
            >
              {side(focused !== "thread")}
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}

/**
 * Whether the conversation and its open pane fit side by side, and whether the Chat list beside
 * them (`beside`, on a desktop) must give way for it. Judged from the whole Chat area less the
 * list's set width, never from the pane's own width, which grows when the list hides: that would
 * bring the list back, and round again. Where even the whole area is too narrow (a large text
 * size), the list still gives way, so the open pane covers the conversation as on a phone.
 */
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

/** The Chat list's width as set (`CONVERSATION_LIST_COLUMN`), whether or not it is showing. */
function listColumnWidth(rem: number) {
  const set = getComputedStyle(document.documentElement).getPropertyValue(
    CONVERSATION_LIST_COLUMN.property,
  );
  const width = Number.parseFloat(set);
  return Number.isFinite(width) && width > 0 ? width : LIST_COLUMN_DEFAULT_REM * rem;
}
