import type {
  AgentMentionDeliveryTerminalError,
  AgentMentionDeliveryTransition,
} from "@lrm/coforge-sdk/internal";
import type { DeliveryHoldReason } from "./agent-delivery-gate";
import type { TrackedMentionDelivery } from "./mention-delivery-tracker";

/** The launch and native session the daemon reported for an Agent's running process: what a
 * tracked mention's envelope must name to be told to it. */
export type RunningMentionIdentity = Readonly<{ launchId: string; sessionId: string }>;

/** Why an Agent cannot be told a notice right now: an explicit delivery hold, or a busy runtime
 * that only takes notices between turns. */
export type MentionDeliveryBlock = DeliveryHoldReason | "queued_until_idle";

/** What the tracker needs from the rest of the runtime. */
export type MentionDeliveryPorts = {
  /** Reports sent over the daemon's WSS RPC. */
  transition(report: AgentMentionDeliveryTransition): Promise<void>;
  terminalError(report: AgentMentionDeliveryTerminalError): Promise<void>;
  /** ACKs the delivery with its envelope echoed. */
  acknowledge(message: TrackedMentionDelivery): Promise<void>;
  /** The launch and session last reported for the Agent's running process, if one runs. */
  running(agentId: string): RunningMentionIdentity | undefined;
  /** Whether the Agent's consumed cursor already covers the message. */
  consumed(message: TrackedMentionDelivery): boolean;
  /** Whether the Agent's current session already accepted a notice of this delivery. */
  told(message: TrackedMentionDelivery): boolean;
  /** Logs a decision that tells the session nothing (`agent.message.attention_decision`). */
  decided?(message: TrackedMentionDelivery, outcome: "consumed" | "already_notified"): void;
  /** Writes the delivery's notice to the Agent's session: `gone` when its process went away before
   * the notice was accepted. Rejects when the session refused it. */
  announce(message: TrackedMentionDelivery): Promise<"told" | "gone">;
  /** Whether the Agent is mid-turn: a notice written now lands in the turn in progress. */
  busy(agentId: string, conversationId?: string): boolean;
  blocked(agentId: string): MentionDeliveryBlock | undefined;
};
