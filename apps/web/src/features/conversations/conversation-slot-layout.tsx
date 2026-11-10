import type { ReactNode } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ConversationSlot } from "#src/features/agents/profile-panel/profile-panel-slot";
import { localLayoutStorage } from "./local-layout-storage";

/**
 * The conversation's main pane and its side slot (a thread or a profile). Wide, they stand in a
 * resizable split whose share is the user's to set: remembered across visits, and kept separate
 * per slot (`react-resizable-panels` derives its storage key from `panelIds`, so ["main","thread"]
 * and ["main","profile"] never share or corrupt each other's saved size). Narrow, or for a thread
 * shown alone, there is no room for a split: the slot covers the main pane, which stays mounted
 * (hidden) so returning keeps its scroll, drafts and read state. A thread shown alone fills the
 * pane at every width without the conversation, which mounts afresh at its jump message once it is
 * shown.
 */
export function ConversationSlotLayout({
  main,
  side,
  slot,
  split,
  mainShown = true,
}: {
  main: ReactNode;
  side: ReactNode;
  slot: ConversationSlot | undefined;
  /** Side by side, resizable. Panels are flex items sized by the library's inline styles, so a
   * narrow viewport cannot collapse the split with CSS; the caller says when to stack instead. */
  split: boolean;
  /** False for a thread shown alone: the conversation is not mounted at all. */
  mainShown?: boolean;
}) {
  const layout = useDefaultLayout({
    id: "coforge-conversation",
    panelIds: slot ? ["main", slot] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });
  if (!split)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {mainShown && (
          <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", slot && "hidden")}>{main}</div>
        )}
        {side && <div className="flex min-h-0 min-w-0 flex-1 flex-col">{side}</div>}
      </div>
    );
  return (
    <Group
      id="conversation"
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
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
      {slot && (
        <>
          <Separator
            aria-label={slot === "thread" ? m.conversation_thread() : m.agent_profile_resize()}
            className="hidden w-px shrink-0 bg-border-secondary transition-colors hover:bg-brand-solid data-[separator=active]:bg-brand-solid md:block"
          />
          <Panel
            id={slot}
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
