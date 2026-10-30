import { m } from "#src/paraglide/messages";
import { replyCountLabel } from "./conversation-labels";

/**
 * Where a thread pane's replies begin and how many there are; notices count, since they are
 * replies in the thread too. The pane always holds the whole thread, so this is the top of the
 * replies, never a load-older point. `message-text` makes it read at the size of the messages
 * under it (Settings → Message font size).
 */
export function ThreadRepliesMarker({ count }: { count: number }) {
  return (
    <div className="message-text px-4 pt-2 text-center text-md text-tertiary md:px-6">
      <p className="pb-1">{m.conversation_thread_beginning()}</p>
      <p className="border-b border-secondary pb-2">{replyCountLabel(count)}</p>
    </div>
  );
}
