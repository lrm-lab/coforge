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
  /** The reports held for each Agent whose Stop is under way, by delivery. */
  readonly #held = new Map<string, Map<string, Array<() => Promise<unknown>>>>();

  constructor(
    private readonly ports: Pick<
      MentionDeliveryPorts,
      "transition" | "terminalError" | "acknowledge"
    >,
  ) {}

  /** The Agent's Stop begins: its reports wait for the Stop's outcome. */
  hold(agentId: string): void {
    if (!this.#held.has(agentId)) this.#held.set(agentId, new Map());
  }

  /** The Stop ended: the held reports go out in order when the process is still running, and are
   * dropped when it is gone. Returns the deliveries that had reports held. */
  release(agentId: string, send: boolean): ReadonlySet<string> {
    const held = this.#held.get(agentId);
    this.#held.delete(agentId);
    if (!held) return new Set();
    if (send) for (const sends of held.values()) for (const report of sends) void report();
    return new Set(held.keys());
  }

  #holds(message: TrackedMentionDelivery, report: () => Promise<unknown>): boolean {
    const held = this.#held.get(message.agentId);
    if (!held) return false;
    held.set(message.deliveryId, [...(held.get(message.deliveryId) ?? []), report]);
    return true;
  }

  /** Diagnostic only: sent without waiting, so it never delays telling the Agent. */
  transition(
    message: TrackedMentionDelivery,
    stage: MentionDeliveryStage,
    outcome: MentionDeliveryTransitionOutcome,
  ): void {
    const send = () =>
      this.#send("transition", message, () =>
        this.ports.transition({ ...this.#scope(message), stage, outcome }),
      );
    if (!this.#holds(message, send)) void send();
  }

  async acknowledge(message: TrackedMentionDelivery): Promise<void> {
    const send = () => this.#send("ack", message, () => this.ports.acknowledge(message));
    if (!this.#holds(message, send)) await send();
  }

  /** Whether the terminal error was sent; false while it is held. */
  async terminalError(
    message: TrackedMentionDelivery,
    code: MentionDeliveryTerminalCode,
  ): Promise<boolean> {
    const send = () =>
      this.#send("terminal_error", message, () =>
        this.ports.terminalError({ ...this.#scope(message), code }),
      );
    return this.#holds(message, send) ? false : send();
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
