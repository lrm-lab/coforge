import type { ReactNode } from "react";

import type { ConversationProps, DirectConversationView } from "./conversation-types";
import type { ChipMention } from "./message-reference-chips";
import type { ChannelSuggestion } from "./reference-completion";
import type { StreamRead } from "./stream-state";
import type { ThreadFollow } from "./thread-pane-header";

/** What one message stream (`ConversationPane`) is given: a channel's or a DM's main stream, a
 * thread beside it, or a Task popup's discussion. */
export type ConversationPaneProps = Omit<ConversationProps, "conversation" | "agentStatus"> & {
  conversation: Omit<DirectConversationView, "agent">;
  header?: ReactNode;
  readOnlyNotice?: ReactNode;
  emptyState: { title: string; description: string; media: ReactNode };
  /** Whether this stream's read has completed - see `stream-state.ts`. */
  streamRead?: StreamRead;
  root?: DirectConversationView["messages"][number];
  /** The Task popup's discussion: the popup shows the Task above it, in place of a header. */
  inTaskPopup?: boolean;
  onClose?: () => void;
  /** Where a thread lives, named after "Thread" in its header: `#channel` or `@name`. */
  threadContext?: string;
  /** Who the main stream's composer sends to (`#channel`, `@name`), named in its placeholder. */
  composerTarget?: string;
  /** Leaves the thread for its root message in the conversation's stream. */
  onViewInConversation?: () => void;
  /** The viewer's follow state for this thread, where following is offered (channels). */
  threadFollow?: ThreadFollow;
  /** Opens a root's thread from the stream: the rows then offer each root's thread entry and
   * preview, which read the conversation's thread store (`ThreadStoreProvider`). */
  onOpenThread?: (rootId: string) => void;
  /** Shown in the thread header before its actions menu (the Agents following the thread). */
  threadHeaderAction?: ReactNode;
  /** Plain-`@handle` display resolution for the stream (see `MessageBody`). Built by each
   * wrapper — the DM from its Agent counterpart, a channel from its member directory. */
  plainMentions?: Map<string, ChipMention>;
  /** Opens a task reference's detail popup. Owned by `ThreadedConversationContent`. */
  onOpenTask?: (number: number) => void;
  /** Channel id → current name, for the channel links in a body (see `MessageBody`). Owned by
   * `ThreadedConversationContent`, which reads the viewer's channel list. */
  channelNames?: ReadonlyMap<string, string>;
  /** Every channel of the Workspace, for the composer's `#` list. Owned by
   * `ThreadedConversationContent`, which reads it from the messages layout. */
  channels?: readonly ChannelSuggestion[];
  /** The Saved view's position-only jump anchor (`?message=<uuid>`; see
   * `useConversationPositionJump`). Supplied only by the main pane's wrapper — the router
   * read lives there so this pane keeps no router hooks. */
  jumpMessage?: string;
  /** Called exactly once per consumed jump, to strip the param one-shot like a hash. */
  onJumpMessageConsumed?: () => void;
  /** False for a stream with no read cursor of its own (a Task popup's discussion): it opens at
   * its latest and draws no "New messages" divider. */
  keepsReadCursor?: boolean;
};
