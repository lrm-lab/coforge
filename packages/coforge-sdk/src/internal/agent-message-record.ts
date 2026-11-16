import type { ForwardedMessage } from "./forwarded-message";
import type { MessageSenderKind } from "./message-sender";
export type LocalAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};
export type AgentMessageRecord = {
  id: string;
  sequence: number;
  senderKind: MessageSenderKind;
  senderHandle: string;
  senderDescription: string;
  target: string;
  body: string;
  channelCoordination?: string;
  createdAt: string;
  attachments: LocalAttachment[];
  task?: MessageTaskMetadata;
  mentionsAgent?: boolean;
  nonMemberMention?: boolean;
  replyCount?: number;
  forwardedMessages?: ForwardedMessage[];
  forwarded?: ForwardedMessage;
  attachmentCommentAnchor?: import("../agent/attachment-comments").AgentAttachmentCommentAnchor;
};
export type MessageTaskMetadata = {
  deleted?: boolean;
  number: number;
  status: import("./tasks").TaskStatus;
  owner?: {
    displayName: string;
    handle: string;
    deleted?: boolean;
  };
};
