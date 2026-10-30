import {
  AGENT_MENTION_DELIVERY_TERMINAL_ERROR_METHOD,
  AGENT_MENTION_DELIVERY_TRANSITION_METHOD,
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_MESSAGE_REJECT_METHOD,
  encodeAgentMentionDeliveryTerminalError,
  encodeAgentMentionDeliveryTransition,
  encodeAgentMessageDeliveryAck,
  encodeAgentMessageDeliveryRejection,
  type AgentMentionDeliveryTerminalError,
  type AgentMentionDeliveryTransition,
  type AgentMessageDeliveryAck,
  type AgentMessageDeliveryRejection,
} from "@lrm/coforge-sdk/internal";

/**
 * The one-line notices a daemon sends over the control channel without waiting for an answer:
 * delivery acknowledgements and rejections, and mention settlements. None of them keeps state — a
 * transport replaced mid-flight just drops the answer.
 */
export class DaemonNoticePublications {
  constructor(private readonly rpc: (method: string, data: Uint8Array) => Promise<unknown>) {}

  sendDeliveryAck(ack: AgentMessageDeliveryAck): Promise<void> {
    return this.rpc(AGENT_MESSAGE_ACK_METHOD, encodeAgentMessageDeliveryAck(ack)).then(
      () => undefined,
    );
  }

  sendDeliveryRejection(rejection: AgentMessageDeliveryRejection): Promise<void> {
    return this.rpc(
      AGENT_MESSAGE_REJECT_METHOD,
      encodeAgentMessageDeliveryRejection(rejection),
    ).then(() => undefined);
  }

  sendMentionDeliveryTransition(report: AgentMentionDeliveryTransition): Promise<void> {
    return this.rpc(
      AGENT_MENTION_DELIVERY_TRANSITION_METHOD,
      encodeAgentMentionDeliveryTransition(report),
    ).then(() => undefined);
  }

  sendMentionDeliveryTerminalError(report: AgentMentionDeliveryTerminalError): Promise<void> {
    return this.rpc(
      AGENT_MENTION_DELIVERY_TERMINAL_ERROR_METHOD,
      encodeAgentMentionDeliveryTerminalError(report),
    ).then(() => undefined);
  }
}
