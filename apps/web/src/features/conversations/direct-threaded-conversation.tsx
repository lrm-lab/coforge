import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import type { ThreadedConversationProps } from "./conversation-types";
import { ThreadedConversation } from "./threaded-conversation";

export function DirectThreadedConversation({
  name,
  threadContext,
  emptyState: { avatar, ...emptyState },
  ...props
}: Omit<ThreadedConversationProps, "conversationName" | "threadContext" | "emptyState"> & {
  name: string;
  threadContext?: string;
  emptyState: {
    title: string;
    description: string;
    footer?: ThreadedConversationProps["emptyState"]["footer"];
    avatar: { name: string; src?: string | null; userId?: string; agentId?: string };
  };
}) {
  return (
    <ThreadedConversation
      {...props}
      conversationName={name}
      threadContext={threadContext ?? name}
      emptyState={{
        ...emptyState,
        singleLineDescription: true,
        media: (
          <ActorAvatar
            presence={false}
            size="2xl"
            userId={avatar.userId}
            agentId={avatar.agentId}
            alt={avatar.name}
            src={avatar.src ?? undefined}
            name={avatar.name}
          />
        ),
      }}
    />
  );
}
