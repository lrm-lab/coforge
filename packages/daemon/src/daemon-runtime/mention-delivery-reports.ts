import { getLogger } from "@logtape/logtape";
import {
  diagnosticErrorName,
  type MentionDeliveryStage,
  type MentionDeliveryTerminalCode,
  type MentionDeliveryTransitionOutcome,
} from "@lrm/coforge-sdk/internal";
import type { MentionDeliveryPorts } from "./mention-delivery-ports";
import type { TrackedMentionDelivery } from "./mention-delivery-tracker";

const logger = getLogger(["coforge", "daemon", "mention-delivery"]);

/** The reports the daemon sends the cloud about a tracked mention. A report that fails is logged,
 * never thrown. */
export class MentionDeliveryReports {
  constructor(
    private readonly ports: Pick<
      MentionDeliveryPorts,
      "transition" | "terminalError" | "acknowledge"
    >,
  ) {}

  /** Diagnostic only: sent without waiting, so it never delays telling the Agent. */
  transition(
    message: TrackedMentionDelivery,
    stage: MentionDeliveryStage,
    outcome: MentionDeliveryTransitionOutcome,
  ): void {
    void this.#send("transition", message, () =>
      this.ports.transition({ ...this.#scope(message), stage, outcome }),
    );
  }

  async acknowledge(message: TrackedMentionDelivery): Promise<void> {
    await this.#send("ack", message, () => this.ports.acknowledge(message));
  }

  /** Whether the terminal error was sent. */
  terminalError(
    message: TrackedMentionDelivery,
    code: MentionDeliveryTerminalCode,
  ): Promise<boolean> {
    return this.#send("terminal_error", message, () =>
      this.ports.terminalError({ ...this.#scope(message), code }),
    );
  }

  #scope(message: TrackedMentionDelivery) {
    return {
      protocolMajor: message.protocolMajor,
      requestId: crypto.randomUUID(),
      workspaceId: message.workspaceId,
      agentId: message.agentId,
      deliveryId: message.deliveryId,
      mentionDelivery: message.mentionDelivery,
    };
  }

  /** A report that fails is logged, never thrown: the server still holds the mention pending and
   * issues it again. Whether it was sent. */
  async #send(
    kind: "transition" | "terminal_error" | "ack",
    message: TrackedMentionDelivery,
    send: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await send();
      return true;
    } catch (error) {
      logger.warn("Tracked mention delivery report was not sent", {
        event: "agent.mention_delivery.report_failed",
        report: kind,
        agent_id: message.agentId,
        delivery_id: message.deliveryId,
        error_code: diagnosticErrorName(error),
      });
      return false;
    }
  }
}
