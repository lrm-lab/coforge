import { Button } from "#src/components/base/buttons/button";
import { AgentDescriptionLabel, AgentModelLabel } from "#src/features/agents/agent-model-label";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import { cn } from "#src/lib/utils";

import type { MessageView } from "./message-view";

/**
 * The line over a message that starts a group: who sent it (a link to their profile when there
 * is one to open), an Agent's model and description, a deleted Agent's badge, and the time. In a
 * narrow pane the description gives way first, then the model, then the name, which ends in an
 * ellipsis; the time always stays.
 *
 * The name does not shrink at all: flex shrinks every item in proportion to its width, so even a
 * name next to a label with a far larger shrink factor lost a fraction of a pixel, and a truncating
 * name shows its ellipsis at any shortfall ("leagent-o…" beside a still-visible "gemini-…"). The
 * name and the model share a box that shrinks instead; the model takes the shortfall, and the name
 * is cut only by that box's width (`max-w-full`), once the model has none left. Its button's label
 * is left-aligned and truncates, so a cut name keeps its first letters.
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
    <p
      className={cn(
        "flex min-h-5 items-baseline gap-2 pr-8",
        // Under the "new messages" divider the hover bar sits at this line's end
        // (`MessageActionToolbar`); the line leaves it room where the bar shows.
        "lg:[@media(hover:hover)_and_(pointer:fine)]:[li:has(>[role=separator])_&]:pr-32",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        {onOpenSender ? (
          <Button
            color="tertiary"
            noTextPadding
            onPress={onOpenSender}
            className="h-auto max-w-full shrink-0 justify-start rounded p-0 text-sm font-semibold text-primary *:data-text:min-w-0 *:data-text:truncate hover:bg-transparent hover:text-primary hover:underline"
          >
            {displayName}
          </Button>
        ) : (
          <span className="max-w-full shrink-0 truncate text-sm font-semibold text-primary">
            {displayName}
          </span>
        )}
        {message.senderKind === "agent" && message.senderAgentId && !deleted && (
          <>
            {/* Hidden while the label draws nothing (models off, or none known), so no gap is
                  left; the description draws no element at all when there is none. */}
            <span className="flex min-w-0 empty:hidden">
              <AgentModelLabel agentId={message.senderAgentId} seenAt={message.createdAt} />
            </span>
            <AgentDescriptionLabel agentId={message.senderAgentId} seenAt={message.createdAt} />
          </>
        )}
      </span>
      {/* Outside the box, like the time: a name cut to the box then leaves room for the badge. */}
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
