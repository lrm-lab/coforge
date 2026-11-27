import type { ComponentProps } from "react";

import { ConversationTaskDemand } from "#src/features/tasks/conversation-task-demand";
import { ConversationPane } from "./conversation-pane";
import type { DirectConversationView } from "./conversation-types";
import { ThreadLoadStatus, ThreadRootState, threadRootLoadOf } from "./thread-root-state";
import { useConversationThread } from "./thread-queries";

type PaneProps = ComponentProps<typeof ConversationPane>;

export function ThreadPane({
  conversation,
  root,
  inTaskPopup,
  threadContext,
  threadShowBack,
  onClose,
  ...pane
}: Omit<PaneProps, "conversation" | "root"> & {
  conversation: Omit<DirectConversationView, "agent" | "messages">;
  root: NonNullable<PaneProps["root"]>;
}) {
  const thread = useConversationThread(conversation.conversationId, root.id);
  if (!thread.data) {
    const load = threadRootLoadOf(thread);
    const retry = () => void thread.refetch();
    return inTaskPopup ? (
      <ThreadLoadStatus load={load} withRoot={false} onRetry={retry} />
    ) : (
      <ThreadRootState
        load={load}
        context={threadContext}
        onClose={onClose}
        onRetry={retry}
        showBack={threadShowBack}
      />
    );
  }
  return (
    <>
      <ConversationTaskDemand
        conversationId={conversation.conversationId}
        channelName={pane.channelNames?.get(conversation.conversationId)}
        messages={thread.data.replies}
        hasNewer={false}
        readWindow={false}
        openTaskNumber={undefined}
      />
      <ConversationPane
        {...pane}
        root={root}
        inTaskPopup={inTaskPopup}
        threadContext={threadContext}
        threadShowBack={threadShowBack}
        onClose={onClose}
        conversation={{ ...conversation, messages: thread.data.replies }}
      />
    </>
  );
}
