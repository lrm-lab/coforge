/** Body of a channel send. `message` fills in only when `content` is nullish. */
export function agentMessageBody(
  content: string | undefined,
  message: string | undefined,
): string | undefined {
  return content ?? message;
}

export const AGENT_MESSAGE_BODY_REQUIRED_MESSAGE =
  "body required: pass content (message is accepted as alias)";
