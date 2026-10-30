import type { ComponentProps } from "react";
import { ReplyingAgentsLine } from "#src/features/agents/replying-agents-line";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import { MessageNavigationGroup } from "./message-navigation-group";

/**
 * Along the composer's top edge, over the history's bottom padding: who is typing on the left, and
 * the jump group anchored to the composer's top-right corner. The overlay repeats the composer's
 * column and side margins, so both sit right above the composer at any width rather than at the
 * far pane edge beside the scrollbar, and the line truncates before the group instead of running
 * under it.
 */
export function ComposerEdgeOverlay({
  narrow,
  conversationId,
  threadRootId,
  navigation,
}: {
  /** A narrow pane keeps no message column, as its composer does. */
  narrow: boolean;
  conversationId: string;
  threadRootId: string | null;
  navigation: ComponentProps<typeof MessageNavigationGroup>;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
      <div className={narrow ? undefined : MESSAGE_COLUMN_CLASS}>
        <div className="flex items-end gap-2 px-4 md:px-6">
          <ReplyingAgentsLine
            conversationId={conversationId}
            threadRootId={threadRootId}
            className="min-w-0 flex-1"
          />
          <MessageNavigationGroup {...navigation} />
        </div>
      </div>
    </div>
  );
}
