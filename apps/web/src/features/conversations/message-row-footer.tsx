import { MessageAttachments } from "./attachment-card";
import { useIsMessageSaved } from "./conversation-host";
import { MessageReactionBadges } from "./message-reaction-badges";
import { ReadTicks, SavedMessageMarker } from "./message-status-markers";
import { RootThread } from "./thread-summary";
import { MessageTask } from "#src/features/tasks/message-task";
import type { MessageView } from "./message-view";

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
  readState?: "sent" | "read";
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
      {/* Bottom right of the message, as on a Telegram bubble; the row's column keeps room for them
          (`has-[[data-read-state]]:pr-5`), so the last line never runs underneath. */}
      {readState && (
        <div className="absolute right-0 bottom-0">
          <ReadTicks state={readState} />
        </div>
      )}
    </>
  );
}
