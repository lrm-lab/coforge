import { MessageAttachments } from "./attachment-card";
import { useIsMessageSaved } from "./conversation-host";
import { MessageReactionBadges } from "./message-reaction-badges";
import { SavedMessageMarker } from "./message-status-markers";
import { RootThread } from "./thread-summary";
import { MessageTask } from "#src/features/tasks/message-task";
import type { MessageView } from "./message-row";

export function MessageRowFooter({
  message,
  viewerId,
  onToggleReaction,
  showsTask,
  onOpenThread,
}: {
  message: Pick<MessageView, "id" | "attachments" | "reactions">;
  viewerId?: string;
  onToggleReaction?: (emoji: string, active: boolean) => void;
  showsTask: boolean;
  onOpenThread?: (rootId: string) => void;
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
      {saveSaved && <SavedMessageMarker />}
      {showsTask && <MessageTask messageId={message.id} />}
      {onOpenThread && <RootThread rootId={message.id} onOpen={onOpenThread} />}
    </>
  );
}
