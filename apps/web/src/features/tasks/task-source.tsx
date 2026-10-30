import type { TaskView } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";

/** The message a Task was made from, as one line that opens it: its channel, sender and text. */
export function TaskSourceLink({
  source: { senderName, preview },
  channel,
  onOpen,
}: {
  source: NonNullable<TaskView["sourceMessage"]>;
  channel: string;
  onOpen: () => void;
}) {
  return (
    // One line: the text cuts off at the field's edge.
    <Button
      color="link-color"
      size="sm"
      onPress={onOpen}
      className="max-w-full min-w-0 [&_[data-text]]:truncate"
    >
      {channel} · {senderName ? `${senderName}: ${preview}` : preview}
    </Button>
  );
}
