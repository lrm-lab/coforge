import type { MessageSenderKind, MessageTaskMetadata } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { AttachmentView } from "#src/server/attachments/attachment-view.server";
import type { noteAgentDmLimit } from "#src/server/conversations/agent-dm-limits.server";
import type { PendingMentionActionView } from "#src/server/conversations/pending-mention-views.server";
import type { SentMessageHook } from "#src/server/conversations/sent-message-hook.server";
import type {
  AgentMessageSearchOptions,
  AgentMessageSearchPage,
} from "./agent-message-search.repositories.server";
import type { TrackedMentionState } from "./mention-delivery.repositories.server";
export type AgentFacingSender = {
  senderKind: MessageSenderKind;
  senderHandle: string;
  senderDescription: string;
};
export type AttachmentMetadata = AttachmentView;
export type DirectConversationPage = {
  messages: ({
    id: string;
    sequence: number;
    body: string;
    createdAt: Date;
    target: string;
    attachments: AttachmentMetadata[];
    task?: MessageTaskMetadata;
  } & AgentFacingSender)[];
  hasOlder: boolean;
  hasNewer: boolean;
};
export type DirectConversationPageOptions = {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  fromSequence?: number;
  throughSequence?: number;
  unread?: boolean;
};
export type LatestSenderFields = {
  latestSenderKind: MessageSenderKind;
  latestSenderHandle: string;
  latestSenderDescription: string;
};
export type AgentMentionBinding = {
  type: "user" | "agent";
  id: string;
  name: string;
};
export type AgentRecoveryContext = {
  resumeMessages: Array<
    {
      messageId: string;
      deliveryId: string;
      conversationId: string;
      sequence: number;
      createdAtMs: number;
      target: string;
      body: string;
      nonMemberMention?: boolean;
    } & LatestSenderFields
  >;
  unreadSummary: Readonly<Record<string, number>>;
  unreadConversationIds?: Readonly<Record<string, string>>;
};
export type PendingAgentDelivery = AgentRecoveryContext["resumeMessages"][number] & {
  mentionsAgent?: boolean;
};
export type AgentMentionReport = {
  pendingMentionActions: PendingMentionActionView[];
  unresolvedMentionHandles: string[];
};
export type HistoryWindow = {
  beforeSequence?: number;
  afterSequence?: number;
  limit?: number;
};
export type DirectConversationRepository = {
  readonly database: PrismaClient;
  userIdForUsername?(target: string): Promise<string>;
  noteAgentDmLimit?(input: Parameters<typeof noteAgentDmLimit>[1]): Promise<void>;
  openAgentDirect?(
    workspaceId: string,
    agentId: string,
    parentTarget: string,
  ): Promise<{
    conversation: {
      id: string;
    };
    peer:
      | {
          kind: "user";
          userId: string;
        }
      | {
          kind: "agent";
          agentId: string;
        };
  }>;
  getAgentChannel?(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<{
    id: string;
  }>;
  getAgentSendChannel?(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<{
    id: string;
    channelName?: string | null;
    needsJoin: boolean;
  }>;
  resolveAgentTarget?(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<{
    conversationId: string;
    threadRootId: string | null;
    canonicalTarget: string;
    isChannel: boolean;
  }>;
  setAgentThreadFollowed?(
    workspaceId: string,
    agentId: string,
    target: string,
    followed: boolean,
    reason?: string,
  ): Promise<{
    followed: boolean;
  }>;
  getOrCreateUserAgent(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Promise<{
    id: string;
  }>;
  sendMessage(
    conversationId: string,
    senderMemberId: string,
    senderUserId: string,
    body: string,
    attachmentIds?: string[],
    threadRootId?: string,
    withinSend?: SentMessageHook,
  ): Promise<
    {
      id: string;
      body: string;
      createdAt: Date;
      sequence: number;
      threadRootId: string | null;
      deliveryId?: string;
      workspaceId: string;
      agentId: string;
      computerId?: string;
      appBot?: boolean;
      target?: string;
      deliveryTarget?: string;
      attachments: AttachmentMetadata[];
    } & Partial<LatestSenderFields>
  >;
  receiveDeliveryAck?(input: {
    workspaceId: string;
    computerId: string;
    agentId: string;
    deliveryId?: string;
    messageId: string;
    sequence: number;
  }): Promise<TrackedMentionState>;
  readMessages?(
    workspaceId: string,
    agentId: string,
    target: string,
    page?: DirectConversationPageOptions,
  ): Promise<
    ({
      id: string;
      sequence: number;
      body: string;
      createdAt: Date;
      target: string;
      attachments: AttachmentMetadata[];
      task?: MessageTaskMetadata;
    } & AgentFacingSender)[]
  >;
  readMessagesPage?(
    workspaceId: string,
    agentId: string,
    target: string,
    page?: DirectConversationPageOptions,
  ): Promise<DirectConversationPage>;
  searchMessages?(
    workspaceId: string,
    agentId: string,
    options: AgentMessageSearchOptions,
  ): Promise<AgentMessageSearchPage>;
  resolveAgentMessage?(
    workspaceId: string,
    agentId: string,
    anchor: string,
  ): Promise<
    {
      id: string;
      sequence: number;
      body: string;
      createdAt: Date;
      target: string;
      attachments: AttachmentMetadata[];
      task?: MessageTaskMetadata;
    } & AgentFacingSender
  >;
  setAgentMessageReaction?(
    workspaceId: string,
    agentId: string,
    anchor: string,
    emoji: string,
    active: boolean,
  ): Promise<{
    messageId: string;
  }>;
  readAgentRecoveryContext?(workspaceId: string, agentId: string): Promise<AgentRecoveryContext>;
  drainAgentEvents?(
    workspaceId: string,
    agentId: string,
    limit?: number,
    target?: string,
  ): Promise<{
    messages: ({
      id: string;
      sequence: number;
      body: string;
      createdAt: Date;
      target: string;
      attachments: AttachmentMetadata[];
      task?: MessageTaskMetadata;
    } & AgentFacingSender)[];
    hasMore: boolean;
  }>;
  readPendingAgentDeliveries?(
    workspaceId: string,
    agentId: string,
  ): Promise<PendingAgentDelivery[]>;
  advanceAgentReadThrough?(
    workspaceId: string,
    agentId: string,
    target: string,
    seenUpToSequence: number,
  ): Promise<number>;
  agentMentionReport?(
    workspaceId: string,
    agentId: string,
    message: {
      id: string;
      conversationId: string;
      body: string;
    },
  ): Promise<AgentMentionReport>;
  sendAgentMessage?(
    conversationId: string,
    agentId: string,
    body: string,
    attachmentIds?: string[],
    threadRootId?: string,
    mentions?: readonly AgentMentionBinding[],
    joinChannel?: boolean,
  ): Promise<
    {
      id: string;
      body: string;
      createdAt: Date;
      sequence: number;
      threadRootId: string | null;
      deliveryId?: string;
      workspaceId: string;
      agentId: string;
      target: string;
      deliveries?: {
        deliveryId: string;
        agentId: string;
        computerId: string | null;
      }[];
      mentions?: {
        kind: string;
        actorId: string;
        handle: string;
      }[];
      attachments: AttachmentMetadata[];
    } & Partial<LatestSenderFields>
  >;
};
