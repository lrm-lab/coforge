import { assertValidMessageSender, type MessageSenderKind } from "./message-sender";
import type { MessageAttentionSummary as MessageAttentionSummaryMessage } from "#src/internal/gen/coforge/rpc/v1/local_rpc_pb";
import { safeUint64 } from "./agent-observation-codec";
import { assertUint } from "./codec";

export type MessageAttentionSummary = {
  target: string;
  pendingCount: number;
  firstPendingSequence: number;
  latestSequence: number;
  /** When the newest pending message was created, in epoch milliseconds; unset when the server
   * predates it. */
  latestCreatedAtMs?: number;
  latestSenderKind?: MessageSenderKind;
  /** Public handle without a leading "@". No description on this summary. */
  latestSenderHandle?: string;
  flags: string[];
};

export function encodeMessageAttentionSummary(summary: MessageAttentionSummary) {
  if (summary.latestSenderKind !== undefined)
    assertValidMessageSender(
      summary.latestSenderKind,
      summary.latestSenderHandle ?? "",
      "message attention summary",
    );
  if (summary.latestCreatedAtMs !== undefined)
    assertUint(summary.latestCreatedAtMs, Number.MAX_SAFE_INTEGER, "message attention time");
  return {
    ...summary,
    firstPendingSequence: BigInt(summary.firstPendingSequence),
    latestSequence: BigInt(summary.latestSequence),
    latestCreatedAtMs:
      summary.latestCreatedAtMs === undefined ? undefined : BigInt(summary.latestCreatedAtMs),
  };
}

export function decodeMessageAttentionSummary(
  summary: MessageAttentionSummaryMessage,
): MessageAttentionSummary {
  if (summary.latestSenderKind !== undefined)
    assertValidMessageSender(
      summary.latestSenderKind,
      summary.latestSenderHandle ?? "",
      "message attention summary",
    );
  return {
    target: summary.target,
    pendingCount: summary.pendingCount,
    firstPendingSequence: Number(summary.firstPendingSequence),
    latestSequence: Number(summary.latestSequence),
    ...(summary.latestCreatedAtMs !== undefined
      ? { latestCreatedAtMs: safeUint64(summary.latestCreatedAtMs, "message attention time") }
      : {}),
    ...(summary.latestSenderKind
      ? {
          latestSenderKind: summary.latestSenderKind as MessageAttentionSummary["latestSenderKind"],
          latestSenderHandle: summary.latestSenderHandle,
        }
      : {}),
    flags: summary.flags,
  };
}
