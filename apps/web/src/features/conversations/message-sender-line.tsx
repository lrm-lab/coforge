import { Button } from "#src/components/base/buttons/button";
import { AgentModelLabel } from "#src/features/agents/agent-model-label";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";

import type { MessageView } from "./message-row";

/** The line over a message that starts a group: who sent it (a link to their profile when there
 * is one to open), an Agent's model, a deleted Agent's badge, and the time. */
export function MessageSenderLine({
  message,
  displayName,
  deleted,
  onOpenSender,
  time,
}: {
  message: MessageView;
  displayName: string;
  deleted: boolean;
  onOpenSender: (() => void) | undefined;
  /** The message's clock time, already in the viewer's format and zone. */
  time: string;
}) {
  return (
    <p className="flex min-h-5 items-baseline gap-2 pr-8">
      {onOpenSender ? (
        <Button
          color="tertiary"
          noTextPadding
          onPress={onOpenSender}
          className="h-auto min-w-0 truncate rounded p-0 text-sm font-semibold text-primary hover:bg-transparent hover:text-primary hover:underline"
        >
          {displayName}
        </Button>
      ) : (
        <span className="min-w-0 truncate text-sm font-semibold text-primary">{displayName}</span>
      )}
      {message.senderKind === "agent" && message.senderAgentId && !deleted && (
        <AgentModelLabel agentId={message.senderAgentId} seenAt={message.createdAt} />
      )}
      {deleted && <DeletedAgentBadge />}
      <time
        dateTime={new Date(message.createdAt).toISOString()}
        className="shrink-0 text-xs text-tertiary tabular-nums"
      >
        {time}
      </time>
    </p>
  );
}
