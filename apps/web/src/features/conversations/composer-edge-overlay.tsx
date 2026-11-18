import type { ReactNode } from "react";
import { ReplyingAgentsLine } from "#src/features/agents/replying-agents-line";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import { NewMessagesPill } from "./new-messages-pill";

export function ComposerEdgeOverlay({
  column,
  conversationId,
  threadRootId,
  viewerId,
  unreadCount,
  onlyNew,
  onShowLatest,
  overhead,
}: {
  column: boolean;
  conversationId: string;
  threadRootId: string | null;
  viewerId: string | undefined;
  unreadCount?: number;
  onlyNew?: boolean;
  onShowLatest?: () => void;
  overhead?: ReactNode;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
      <div className={column ? MESSAGE_COLUMN_CLASS : undefined}>
        <div className="relative flex items-end gap-2 px-4 md:px-6">
          {onShowLatest && (
            <NewMessagesPill
              conversationId={conversationId}
              rootId={threadRootId ?? undefined}
              viewerId={viewerId}
              unreadCount={unreadCount}
              onlyNew={onlyNew}
              onShowLatest={onShowLatest}
            />
          )}
          <ReplyingAgentsLine
            conversationId={conversationId}
            threadRootId={threadRootId}
            className="min-w-0 flex-1"
          />
          {overhead}
        </div>
      </div>
    </div>
  );
}
