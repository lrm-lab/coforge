import { m } from "#src/paraglide/messages";

/**
 * What failed in the AI Workbench, which decides what the reader is told:
 * - `send`: a command that may have reached the cloud computer, so a resend is said to be safe;
 * - `load`: a read of the chats or a history (nothing was sent; reading again is enough);
 * - `action`: a rename or delete.
 */
export type PiChatFailure = "send" | "load" | "action";

export function piChatFailureMessage(failure: PiChatFailure) {
  if (failure === "send") return m.pi_chat_connection_error();
  if (failure === "load") return m.pi_chat_load_error();
  return m.pi_chat_action_error();
}
