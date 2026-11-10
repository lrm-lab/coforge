import type { ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";

import { localLayoutStorage } from "./local-layout-storage";

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
  if (!wideViewport || threadAlone) {
    // Small screens have no room for a resizable split: the slot pane covers the main pane,
    // which stays mounted (hidden) so returning keeps its scroll, drafts and read state. A thread
    // shown alone fills the pane at every width without the conversation, which mounts afresh at
    // its jump message once it is shown.
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
    <Group
      id="conversation"
      orientation="horizontal"
      defaultLayout={threadLayout.defaultLayout}
      onLayoutChanged={threadLayout.onLayoutChanged}
      className="flex min-h-0 min-w-0 flex-1"
    >
      <Panel
        id="main"
        // Strings are percentages of the group; numbers would be pixels.
        minSize="40"
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
            minSize="25"
            maxSize="60"
            className="flex min-h-0 min-w-0 flex-col"
          >
            {side}
          </Panel>
        </>
      )}
    </Group>
  );
}
