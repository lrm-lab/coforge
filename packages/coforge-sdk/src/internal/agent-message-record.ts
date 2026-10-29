import type { MessageSenderKind } from "./message-sender";

/** The Message shape every Agent-facing read and send answers with: one conversation's message,
 * its sender, target, attachments, Task metadata and delivery hints. */

export type LocalAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};
export type AgentMessageRecord = {
  memoryHint?: import("#src/agent/memory-disposition").MemoryHintDelivery;
  id: string;
  sequence: number;
  senderKind: MessageSenderKind;
  /** Public handle without a leading "@"; required for "human"/"agent", empty for "system". */
  senderHandle: string;
  /** The sender's role text; empty when there is none. */
  senderDescription: string;
  target: string;
  body: string;
  createdAt: string;
  /** Always present, possibly empty; order matches send/upload order. */
  attachments: LocalAttachment[];
  task?: MessageTaskMetadata;
  /** True when this message personally @mentioned the reading Agent. */
  mentionsAgent?: boolean;
  /** True when the reading Agent is not in the channel and was notified of this one message. */
  nonMemberMention?: boolean;
  /** How many replies this message's thread holds; absent when it has none. */
  replyCount?: number;
};
export type MessageTaskMetadata = {
  number: number;
  status: import("./tasks").TaskStatus;
  /** `handle` has no leading "@"; `deleted` marks an Agent deleted while still holding the Task. */
  owner?: { displayName: string; handle: string; deleted?: boolean };
};
