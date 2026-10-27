import type { MessageSenderKind, MessageTaskMetadata } from "@lrm/coforge-sdk/internal";
import type { AttachmentView } from "#src/server/attachments/attachment-view.server";

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
