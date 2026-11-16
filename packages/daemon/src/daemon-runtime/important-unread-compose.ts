import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { composeDeliveryNotice } from "./delivery-notice";
import type { ImportantUnreadNotice } from "./important-unread-notice";
import type {
  ImportantUnreadBatchDelivery,
  ImportantUnreadComposedNotice,
} from "./important-unread-reminder";

/** What the message half of the loop needs to compose one attempt's notice. */
export type UnreadNoticeComposePorts = Readonly<{
  /** What waits for this Agent right now, which the notice counts beside the batch. */
  queued(agentId: string): readonly AgentMessageDelivery[];
  /** The Workspace's line owed before a notice, when it has one. */
  prefix(agentId: string): string;
  /** Whether the model was already shown this message in full: it is not shown again. */
  previewedInFull(agentId: string, target: string, sequence: number): boolean;
}>;

/**
 * The loop's compose port for message deliveries: the batch's notice as it reads at this attempt,
 * built from the batch and the queue at that moment rather than from the first attempt's snapshot,
 * and carrying the messages whose whole text it shows so the write records them (task #14). A
 * retry therefore counts what arrived since and never repeats a body the model already has.
 */
export function unreadNoticeComposer(ports: UnreadNoticeComposePorts) {
  return (
    agentId: string,
    _notice: ImportantUnreadNotice,
    deliveries: readonly ImportantUnreadBatchDelivery[],
  ): ImportantUnreadComposedNotice | undefined => {
    const announced = deliveries.filter(
      (delivery): delivery is AgentMessageDelivery & { target: string } =>
        delivery.messageId !== undefined && delivery.target !== undefined,
    );
    const message = announced[0];
    // A record taken over after a restart has no messages of its own: the loop's standing text
    // says where to look instead.
    if (!message) return undefined;
    const { view, notice } = composeDeliveryNotice({
      message,
      announced,
      queued: ports.queued(agentId),
      prefix: ports.prefix(agentId),
      previewedInFull: (target, sequence) => ports.previewedInFull(agentId, target, sequence),
    });
    // A retry whose every message the model already has would name the target and nothing else:
    // that is not a notice, and the loop's standing text says where to look instead.
    const saysNothing = view.rows.every(
      (row) => !row.newIds.size && !row.heldIds.size && !row.previews.length,
    );
    if (!view.rows.length || saysNothing) return undefined;
    return { text: notice, shown: view.whole };
  };
}
