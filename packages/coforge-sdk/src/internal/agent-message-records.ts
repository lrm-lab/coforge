import { memoryHintMessage, readMemoryHint } from "./memory-hint";
import { assertValidMessageSender } from "./message-sender";
import { isAttachmentCommentAnchor } from "../agent/attachment-comments";
import {
  decodeLocalAttachments,
  decodeMessageTask,
  encodeLocalAttachments,
  type RawLocalAttachment,
} from "./local-daemon";
import type { AgentMessageRecord, LocalAttachment } from "./agent-message-record";

/** Agent message records as the local socket carries them: protobuf `AgentMessageRecord` on the
 * wire, `AgentMessageRecord` in TypeScript. `local-daemon` keeps only the request/response frames. */

export function encodeAgentMessageRecords(records: readonly AgentMessageRecord[]) {
  for (const m of records)
    assertValidMessageSender(m.senderKind, m.senderHandle, "Agent message record");
  return records.map((m) => ({
    ...m,
    sequence: BigInt(m.sequence),
    createdAt: m.createdAt,
    attachments: encodeLocalAttachments(m.attachments),
    task: m.task,
    memoryHint: memoryHintMessage(m.memoryHint),
    ...(m.attachmentCommentAnchor !== undefined
      ? { attachmentCommentAnchorJson: JSON.stringify(m.attachmentCommentAnchor) }
      : {}),
  }));
}

function anchorFromJson(json?: string) {
  if (json === undefined) return {};
  const anchor: unknown = JSON.parse(json);
  return isAttachmentCommentAnchor(anchor) ? { attachmentCommentAnchor: anchor } : {};
}

export function decodeAgentMessageRecords(
  records: readonly {
    id: string;
    sequence: bigint;
    senderKind: string;
    senderHandle: string;
    senderDescription: string;
    target: string;
    body: string;
    createdAt: string;
    attachments: readonly RawLocalAttachment[];
    task?: Parameters<typeof decodeMessageTask>[0];
    mentionsAgent?: boolean;
    memoryHint?: { hintId: string; tool: string };
    attachmentCommentAnchorJson?: string;
  }[],
): AgentMessageRecord[] {
  return records.map((m) => {
    assertValidMessageSender(m.senderKind, m.senderHandle, "Agent message record");
    return {
      id: m.id,
      sequence: Number(m.sequence),
      senderKind: m.senderKind,
      senderHandle: m.senderHandle,
      senderDescription: m.senderDescription,
      target: m.target,
      body: m.body,
      createdAt: m.createdAt,
      attachments: decodeLocalAttachments(m.attachments),
      ...(m.task ? { task: decodeMessageTask(m.task) } : {}),
      ...(m.mentionsAgent ? { mentionsAgent: true } : {}),
      ...(m.memoryHint ? { memoryHint: readMemoryHint(m.memoryHint) } : {}),
      ...anchorFromJson(m.attachmentCommentAnchorJson),
    };
  });
}
