import { m } from "#src/paraglide/messages";

/** What to tell the reader, and where to send them, when the server refused a send with a
 * specific `errorId` that has a remedy of its own. Every other failure keeps the generic reason. */
export type UnsentGuidance = { message: () => string; action: "connect-computer" };

const GUIDANCE: Readonly<Record<string, UnsentGuidance>> = {
  "workspace-assistant-computer-required": {
    message: () => m.workspace_assistant_computer_required(),
    action: "connect-computer",
  },
};

export function unsentGuidance(errorId: string | undefined): UnsentGuidance | undefined {
  return errorId ? GUIDANCE[errorId] : undefined;
}
