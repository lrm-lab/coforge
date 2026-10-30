import { useQuery } from "@tanstack/react-query";

import { Button } from "#src/components/base/buttons/button";
import { conversationAroundQuery } from "#src/features/conversations/conversation-queries";
import { MessagePreview } from "#src/features/conversations/message-preview";
import { m } from "#src/paraglide/messages";

/** The message a Task was made from, as one line that opens it: its channel, sender and text. The
 * read is the window the jump to it lands in, so opening it reads nothing more. A thread reply is
 * not in that window, nor is a message the reader cannot see: the line then names the channel. */
export function TaskSourceLink({
  conversationId,
  messageId,
  channel,
  onOpen,
}: {
  conversationId: string;
  messageId: string;
  channel: string;
  onOpen: () => void;
}) {
  const { data: message } = useQuery({
    ...conversationAroundQuery(conversationId, messageId),
    select: (page) => page.messages.find((message) => message.id === messageId),
    // Only a preview: no read on every popup, and no retries for a message that is gone.
    staleTime: 60_000,
    retry: false,
  });
  return (
    // One line: the text cuts off at the field's edge.
    <Button
      color="link-color"
      size="sm"
      onPress={onOpen}
      className="max-w-full min-w-0 [&_[data-text]]:truncate"
    >
      {message ? (
        <>
          {channel} · {message.senderName}:{" "}
          <MessagePreview body={message.body} mentions={message.mentions} />
        </>
      ) : (
        m.tasks_source_message({ channel })
      )}
    </Button>
  );
}
