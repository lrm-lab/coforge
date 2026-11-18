import { isRecoverableAgentTarget } from "./index";
import { isValidMessageSender } from "./message-sender";

export type AgentRecoveryContextMessage = {
  messageId: string;
  deliveryId: string;
  conversationId: string;
  sequence: number;
  target: string;
  latestSenderKind: string;
  latestSenderHandle: string;
  body: string;
};

const AGENT_RECOVERY_RESUME_MESSAGES_MAX = 100;
const UNREAD_COUNT_MAX = 4294967295;

function isRecoverableAgentMessage(message: AgentRecoveryContextMessage): boolean {
  return (
    !!message.messageId &&
    !!message.deliveryId &&
    !!message.conversationId &&
    !!message.body &&
    isRecoverableAgentTarget(message.target) &&
    Number.isSafeInteger(message.sequence) &&
    message.sequence >= 1 &&
    isValidMessageSender(message.latestSenderKind, message.latestSenderHandle)
  );
}

export function assertAgentRecoveryContext(context: {
  wakeMessage?: AgentRecoveryContextMessage;
  resumeMessages: readonly AgentRecoveryContextMessage[];
  unreadSummary: readonly { target: string; count: number }[];
}): void {
  const { wakeMessage, resumeMessages, unreadSummary } = context;
  const fail = (reason: string) => {
    throw new Error(`invalid agent recovery context: ${reason}`);
  };
  const messages = [...(wakeMessage ? [wakeMessage] : []), ...resumeMessages];
  if (resumeMessages.length > AGENT_RECOVERY_RESUME_MESSAGES_MAX)
    fail(`more than ${AGENT_RECOVERY_RESUME_MESSAGES_MAX} resume messages`);
  if (!messages.every(isRecoverableAgentMessage)) fail("a message a Start cannot carry");
  if (
    new Set(messages.map(({ messageId }) => messageId)).size !== messages.length ||
    new Set(messages.map(({ deliveryId }) => deliveryId)).size !== messages.length
  )
    fail("a repeated message");
  for (const { target, count } of unreadSummary)
    if (
      !isRecoverableAgentTarget(target) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > UNREAD_COUNT_MAX
    )
      fail("an unread count a Start cannot carry");
  if (new Set(unreadSummary.map(({ target }) => target)).size !== unreadSummary.length)
    fail("a repeated unread target");
}
