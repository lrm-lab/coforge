import { Button } from "#src/components/base/buttons/button";
import { AgentDescriptionLabel, AgentModelLabel } from "#src/features/agents/agent-model-label";
import { DELETED_AGENT_NAME_CLASS } from "#src/features/agents/deleted-agent";
import { cn } from "#src/lib/utils";

import type { MessageView } from "./message-view";

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
  time: string;
}) {
  return (
    <p
      className={cn(
        "flex min-h-5 items-baseline gap-2 pr-8",
        "lg:[@media(hover:hover)_and_(pointer:fine)]:[li:has(>[role=separator])_&]:group-hover/message:pr-32",
        "lg:[@media(hover:hover)_and_(pointer:fine)]:[li:has(>[role=separator])_&]:group-focus-within/message:pr-32",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        {onOpenSender ? (
          <Button
            color="tertiary"
            noTextPadding
            onPress={onOpenSender}
            className={cn(
              "h-auto max-w-full shrink-0 justify-start rounded p-0 text-sm font-semibold *:data-text:min-w-0 *:data-text:truncate hover:bg-transparent hover:underline",
              deleted ? DELETED_AGENT_NAME_CLASS : "text-primary hover:text-primary",
            )}
          >
            {displayName}
          </Button>
        ) : (
          <span
            className={cn(
              "max-w-full shrink-0 truncate text-sm font-semibold",
              deleted ? DELETED_AGENT_NAME_CLASS : "text-primary",
            )}
          >
            {displayName}
          </span>
        )}
        {message.senderKind === "agent" && message.senderAgentId && !deleted && (
          <>
            <span className="flex min-w-0 empty:hidden">
              <AgentModelLabel agentId={message.senderAgentId} seenAt={message.createdAt} />
            </span>
            <AgentDescriptionLabel agentId={message.senderAgentId} seenAt={message.createdAt} />
          </>
        )}
      </span>
      <time
        dateTime={new Date(message.createdAt).toISOString()}
        className="shrink-0 text-xs text-tertiary tabular-nums"
      >
        {time}
      </time>
    </p>
  );
}
