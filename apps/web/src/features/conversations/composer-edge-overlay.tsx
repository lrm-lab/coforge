import type { ComponentProps, ReactNode } from "react";
import { ReplyingAgentsLine } from "#src/features/agents/replying-agents-line";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import { MessageNavigationGroup } from "./message-navigation-group";

/**
 * Along the composer's top edge, over the history's bottom padding: the Agents' line on the left, and
 * the jump group anchored to the composer's top-right corner, the host's `overhead` just before it. The overlay repeats the composer's
 * column and side margins, so both sit right above the composer at any width rather than at the
 * far pane edge beside the scrollbar, and the line truncates before the group instead of running
 * under it.
 */
export function ComposerEdgeOverlay({
  column,
  conversationId,
  threadRootId,
  navigation,
  overhead,
}: {
  /** Lines up with the message column, as the composer does. */
  column: boolean;
  conversationId: string;
  threadRootId: string | null;
  navigation: ComponentProps<typeof MessageNavigationGroup>;
  /** What the page hosting the conversation floats over its composer (`ComposerHost`). */
  overhead?: ReactNode;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
      <div className={column ? MESSAGE_COLUMN_CLASS : undefined}>
        <div className="flex items-end gap-2 px-4 md:px-6">
          <ReplyingAgentsLine
            conversationId={conversationId}
            threadRootId={threadRootId}
            className="min-w-0 flex-1"
          />
          {overhead}
          <MessageNavigationGroup {...navigation} />
        </div>
      </div>
    </div>
  );
}
