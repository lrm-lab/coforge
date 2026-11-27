import type { ReactNode } from "react";

import type { ConversationProps, DirectConversationView } from "./conversation-types";
import type { ChipMention } from "./message-reference-chips";
import type { ChannelSuggestion } from "./reference-completion";
import type { StreamRead } from "./stream-state";
import type { ThreadFollow } from "./thread-pane-header";

export type ConversationPaneProps = Omit<ConversationProps, "conversation"> & {
  conversation: Omit<DirectConversationView, "agent">;
  header?: ReactNode;
  readOnlyNotice?: ReactNode;
  emptyState: {
    title: string;
    description: string;
    media: ReactNode;
    singleLineDescription?: boolean;
  };
  streamRead?: StreamRead;
  root?: DirectConversationView["messages"][number];
  inTaskPopup?: boolean;
  lead?: ReactNode;
  onClose?: () => void;
  threadContext?: string;
  composerTarget?: string;
  onViewInConversation?: () => void;
  threadFollow?: ThreadFollow;
  onOpenThread?: (rootId: string) => void;
  threadHeaderAction?: ReactNode;
  plainMentions?: Map<string, ChipMention>;
  onOpenTask?: (number: number) => void;
  channelNames?: ReadonlyMap<string, string>;
  channels?: readonly ChannelSuggestion[];
  jumpMessage?: string;
  onJumpMessageConsumed?: () => void;
  paneVisible?: boolean;
  keepsReadCursor?: boolean;
};
