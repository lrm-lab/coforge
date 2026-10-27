import type { MessageSenderKind, MessageTaskMetadata } from "@lrm/coforge-sdk/internal";
import type { AttachmentView } from "#src/server/attachments/attachment-view.server";

/** The three Agent-visible sender facts, shared by every Agent-facing message shape. */
export type AgentFacingSender = {
  senderKind: MessageSenderKind;
  senderHandle: string;
  senderDescription: string;
};

/** Signed previews belong only to browser messages; Agents use their authenticated proxy route. */
export type AttachmentMetadata = AttachmentView;

export type DirectConversationPage = {
  messages: ({
    id: string;
    sequence: number;
    body: string;
    createdAt: Date;
    target: string;
    /** Always present, possibly empty; order matches send/upload order. */
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
  /** Reads from the Agent's read position and reports where it stood and where it moved. */
  unread?: boolean;
};
