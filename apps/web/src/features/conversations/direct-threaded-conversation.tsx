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
    avatar: { name: string; src?: string | null };
  };
}) {
  return (
    <ThreadedConversation
      {...props}
      conversationName={name}
      threadContext={threadContext ?? name}
      emptyState={{
        ...emptyState,
        media: (
          <ActorAvatar
            presence={false}
            size="2xl"
            alt={avatar.name}
            src={avatar.src ?? undefined}
            name={avatar.name}
            className="ring-1 ring-secondary"
          />
        ),
      }}
    />
  );
}
