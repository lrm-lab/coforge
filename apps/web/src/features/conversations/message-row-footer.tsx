import { MessageAttachments } from "./attachment-card";
import { useIsMessageSaved } from "./conversation-host";
import { MessageReactionBadges } from "./message-reaction-badges";
import { ReadTicks, SavedMessageMarker } from "./message-status-markers";
import { RootThread } from "./thread-summary";
import { MessageTask } from "#src/features/tasks/message-task";
import type { MessageView } from "./message-view";
import type { ReadState } from "./conversation-pane-layout";
import { cn } from "#src/lib/utils";

export function MessageRowFooter({
  message,
  viewerId,
  onToggleReaction,
  showsTask,
  onOpenThread,
  readState,
}: {
  message: Pick<MessageView, "id" | "attachments" | "reactions">;
  viewerId?: string;
  onToggleReaction?: (emoji: string, active: boolean) => void;
  showsTask: boolean;
  onOpenThread?: (rootId: string) => void;
  /** An own message's ticks (`ownMessageReadState`); absent for everyone else's. */
  readState?: ReadState;
}) {
  const saveSaved = useIsMessageSaved(message.id);
  return (
    <>
      <MessageAttachments attachments={message.attachments} />
      <MessageReactionBadges
        reactions={message.reactions}
        viewerId={viewerId}
        onToggle={onToggleReaction}
      />
      {/* Saved is a per-viewer state, so this marker is only ever the viewer's own: it says
          "this one is in your Saved" without opening the hover bar to check its bookmark. The
          Saved page itself does not repeat it — that list has its own row, where every entry is
          saved by definition. */}
      {saveSaved && <SavedMessageMarker />}
      {showsTask && <MessageTask messageId={message.id} />}
      {onOpenThread && <RootThread rootId={message.id} onOpen={onOpenThread} />}
      {/* Bottom right of the message, as on a Telegram bubble; the row's column keeps room for them,
          so the last line never runs underneath. Only the newest own message shows them outright
          (Frank); the others on a desktop hover or focus, the same gate as the action toolbar. */}
      {readState && (
        <div
          data-read-ticks={readState.latest ? "latest" : "hover"}
          className={cn(
            "absolute right-0 bottom-0",
            !readState.latest &&
              "hidden lg:[@media(hover:hover)_and_(pointer:fine)]:flex lg:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:opacity-100 lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100",
          )}
        >
          <ReadTicks state={readState.read ? "read" : "sent"} />
        </div>
      )}
    </>
  );
}
