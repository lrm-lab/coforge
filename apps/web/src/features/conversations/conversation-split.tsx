import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";

import { localLayoutStorage } from "./local-layout-storage";

/** The narrowest the conversation and the thread/profile pane may be dragged; together, the
 * narrowest area that shows them side by side. */
const MAIN_PANE_MIN_REM = 24;
const SIDE_PANE_MIN_REM = 22;

/** The conversation beside its thread or profile pane, resizable while there is room for both. */
export function ConversationSplit({
  main,
  side,
  visibleSlot,
  threadAlone,
}: {
  main: ReactNode;
  side: ReactNode;
  visibleSlot: ConversationSlot | undefined;
  /** A thread shown without its conversation (Activity). */
  threadAlone: boolean;
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
  const measureSplit = useCallback(() => {
    const element = splitRef.current;
    if (!element) return;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    setSplitFits(element.clientWidth >= (MAIN_PANE_MIN_REM + SIDE_PANE_MIN_REM) * rem);
  }, []);
  const splitShown = wideViewport && splitFits;
  // Each layout renders its own measured wrapper, so observe again whenever the layout switches.
  useEffect(() => {
    const element = splitRef.current;
    if (!element) return;
    measureSplit();
    const observer = new ResizeObserver(measureSplit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measureSplit, splitShown]);
  if (!splitShown || threadAlone) {
    // Small screens have no room for a resizable split: the slot pane covers the main pane,
    // which stays mounted (hidden) so returning keeps its scroll, drafts and read state. A thread
    // shown alone fills the pane at every width without the conversation, which mounts afresh at
    // its jump message once it is shown.
    return (
      <div ref={splitRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!threadAlone && (
          <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", visibleSlot && "hidden")}>
            {main}
          </div>
        )}
        {side && <div className="flex min-h-0 min-w-0 flex-1 flex-col">{side}</div>}
      </div>
    );
  }
  return (
    // Measured, so the split knows when its panes stop fitting side by side.
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
          className="flex min-h-0 min-w-0 flex-col"
        >
          {main}
        </Panel>
        {visibleSlot && (
          <>
            <Separator
              aria-label={
                visibleSlot === "thread" ? m.conversation_thread() : m.agent_profile_resize()
              }
              className="hidden w-px shrink-0 bg-border-secondary transition-colors hover:bg-brand-solid data-[separator=active]:bg-brand-solid md:block"
            />
            <Panel
              id={visibleSlot}
              defaultSize="35"
              minSize={`${SIDE_PANE_MIN_REM}rem`}
              maxSize="60"
              className="flex min-h-0 min-w-0 flex-col"
            >
              {side}
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}
