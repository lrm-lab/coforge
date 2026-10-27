import { Button } from "#src/components/base/buttons/button";
import { AgentModelLabel } from "#src/features/agents/agent-model-label";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";

import type { MessageView } from "./message-row";

/**
 * The line over a message that starts a group: who sent it (a link to their profile when there
 * is one to open), an Agent's model, a deleted Agent's badge, and the time. In a narrow pane the
 * model gives way first, then the name, which ends in an ellipsis: its button's label is
 * left-aligned and truncates, so a squeezed name never loses its first letters to the button's
 * centring and clipping ("eagent-ops"). The time always stays.
 */
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
          className="h-auto min-w-0 justify-start rounded p-0 text-sm font-semibold text-primary *:data-text:min-w-0 *:data-text:truncate hover:bg-transparent hover:text-primary hover:underline"
        >
          {displayName}
        </Button>
      ) : (
        <span className="min-w-0 truncate text-sm font-semibold text-primary">{displayName}</span>
      )}
      {message.senderKind === "agent" &&
        message.senderAgentId &&
        !deleted && (
          // Flex shrinks in proportion to width, so a short label at its own `shrink-[8]` still
          // left a long name to lose letters; here it gives up all its room first.
          <span className="flex min-w-0 shrink-[1000]">
            <AgentModelLabel agentId={message.senderAgentId} seenAt={message.createdAt} />
          </span>
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
