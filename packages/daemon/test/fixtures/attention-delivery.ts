import type { AgentMessageDelivery, MessageSenderKind } from "@lrm/coforge-sdk/internal";

/** A message delivery to `agent-1` in `workspace-1`, as the attention index receives it. */
export const delivery = (
  id: string,
  latestSenderKind?: MessageSenderKind,
  latestSenderHandle?: string,
): AgentMessageDelivery => ({
  protocolMajor: 1,
  requestId: `request-${id}`,
  messageId: `message-${id}`,
  deliveryId: `delivery-${id}`,
  sequence: 1,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  body: "private body",
  method: "agent:v1:message:deliver",
  target: "@agent",
  ...(latestSenderKind !== undefined
    ? { latestSenderKind, latestSenderHandle: latestSenderHandle ?? "" }
    : {}),
});

/** An Agent session that hands each notice it is sent to `notify` and does nothing else. */
export const session = (notify: (notice: string) => void = () => {}) => ({
  sendMessage: async () => {},
  notify: async (notice: string) => {
    notify(notice);
  },
  subscribe: () => () => {},
  interrupt: async () => {},
  onExit: () => () => {},
  dispose: async () => {},
});
