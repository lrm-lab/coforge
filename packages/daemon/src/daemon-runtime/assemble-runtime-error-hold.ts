import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { AgentDeliveryGate } from "./agent-delivery-gate";
import { RuntimeErrorDeliveryHold } from "./runtime-error-delivery-hold";
import { AgentRuntimeBackoffStore } from "#src/persistence/agent-runtime-backoff-store";

/**
 * Per-Agent delivery hold after retryable runtime errors: the backoff, the fingerprint fence, the
 * backoff's release timer, and the record a Daemon restart restores (task #565). The restore runs
 * here, before any delivery can arrive: a recorded usage limit holds its Agent's messages again
 * instead of being retried into the same limit.
 */
export function assembleRuntimeErrorDeliveryHold(input: {
  /** A thunk: field initializers run before the runtime's own state directory is assigned. */
  stateDirectory(): string;
  deliveryGate: Pick<
    AgentDeliveryGate,
    "hold" | "release" | "endHoldForNextLaunch" | "explicitHold" | "pending"
  >;
  flush(agentId: string, held: AgentMessageDelivery[]): void;
  backoffEnded(agentId: string): void;
}): RuntimeErrorDeliveryHold {
  const store = new AgentRuntimeBackoffStore(input.stateDirectory);
  const hold = new RuntimeErrorDeliveryHold({
    deliveryGate: input.deliveryGate,
    flush: input.flush,
    backoffEnded: input.backoffEnded,
    store,
  });
  // The runtime's state directory is assigned after its field initializers, so the restore runs
  // as soon as the constructor returns — still before any delivery can reach the runtime.
  queueMicrotask(() => hold.restore(store.list()));
  return hold;
}
