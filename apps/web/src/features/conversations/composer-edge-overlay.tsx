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
        <div
          className={`grid items-end gap-2 px-4 md:px-6 ${
            onShowLatest
              ? "grid-cols-[minmax(0,1fr)_auto_auto] md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
              : "grid-cols-[minmax(0,1fr)_auto]"
          }`}
        >
          <ReplyingAgentsLine
            conversationId={conversationId}
            threadRootId={threadRootId}
            className="col-start-1 min-w-0"
          />
          {onShowLatest && (
            <div className="col-start-2 flex items-end justify-self-end md:h-0 md:min-h-0 md:justify-self-center">
              <div className="md:-translate-y-2">
                <NewMessagesPill
                  conversationId={conversationId}
                  rootId={threadRootId ?? undefined}
                  viewerId={viewerId}
                  unreadCount={unreadCount}
                  onlyNew={onlyNew}
                  onShowLatest={onShowLatest}
                />
              </div>
            </div>
          )}
          <div className={`${onShowLatest ? "col-start-3" : "col-start-2"} justify-self-end`}>
            {overhead}
          </div>
        </div>
      </div>
    </div>
  );
}
