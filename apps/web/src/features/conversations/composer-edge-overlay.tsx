import type { ReactNode } from "react";
import { ReplyingAgentsLine } from "#src/features/agents/replying-agents-line";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import { cx } from "#src/utils/cx";
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
  showAgentActivity = true,
}: {
  column: boolean;
  conversationId: string;
  threadRootId: string | null;
  viewerId: string | undefined;
  unreadCount?: number;
  onlyNew?: boolean;
  onShowLatest?: () => void;
  overhead?: ReactNode;
  showAgentActivity?: boolean;
}) {
  if (!showAgentActivity && !onShowLatest && !overhead) return null;
  const columns =
    onShowLatest && overhead
      ? "grid-cols-[minmax(0,1fr)_auto] @[42.5rem]/composer-edge:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
      : onShowLatest
        ? "grid-cols-[minmax(0,1fr)_auto] @[37.5rem]/composer-edge:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
        : overhead
          ? "grid-cols-[minmax(0,1fr)_auto]"
          : "grid-cols-[minmax(0,1fr)]";
  const latestAlign = overhead
    ? "justify-self-end @[42.5rem]/composer-edge:justify-self-center"
    : "justify-self-end @[37.5rem]/composer-edge:justify-self-center";
  return (
    <div className="@container/composer-edge pointer-events-none absolute inset-x-0 bottom-0 z-10">
      <div className={column ? MESSAGE_COLUMN_CLASS : undefined}>
        <div className={cx("grid items-center gap-2 px-4 md:px-6", columns)}>
          {showAgentActivity && (
            <ReplyingAgentsLine
              conversationId={conversationId}
              threadRootId={threadRootId}
              className="col-start-1 flex min-w-0 items-center"
            />
          )}
          {onShowLatest && (
            <div className={cx("col-start-2 flex items-center", latestAlign)}>
              <NewMessagesPill
                conversationId={conversationId}
                rootId={threadRootId ?? undefined}
                viewerId={viewerId}
                unreadCount={unreadCount}
                onlyNew={onlyNew}
                onShowLatest={onShowLatest}
              />
            </div>
          )}
          {overhead && (
            <div
              className={
                onShowLatest
                  ? "hidden items-center justify-self-end @[42.5rem]/composer-edge:col-start-3 @[42.5rem]/composer-edge:flex"
                  : "col-start-2 flex items-center justify-self-end"
              }
            >
              {overhead}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
