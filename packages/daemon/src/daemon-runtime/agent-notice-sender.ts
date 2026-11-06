import type { MessageSenderKind } from "@lrm/coforge-sdk/internal";
import { isValidMessageSender } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

/**
 * Validates a `(kind, handle)` pair before it can reach a model-visible notice: the kind must be
 * one of the closed values and the handle must match the public handle grammar (or be empty for
 * `system`). This replaces the former regex guard on a single composed string — a newline can no
 * longer reach a notice through a sender name, because the handle is matched against the handle
 * grammar and the kind against the closed set separately. A rejected pair is logged by name and
 * dropped rather than printed; it never fails the delivery it came with.
 */
export function printableSender(
  kind: MessageSenderKind | undefined,
  handle: string | undefined,
): { kind: MessageSenderKind; handle: string } | undefined {
  if (kind === undefined) return undefined;
  if (!isValidMessageSender(kind, handle ?? "")) {
    logger.warn("rejected an unprintable message sender", {
      event: "message.sender_rejected",
      sender_kind: kind,
    });
    return undefined;
  }
  return { kind, handle: handle ?? "" };
}
