import { m } from "#src/paraglide/messages";

/** What to tell the reader when the server refused a send with an `errorId` that has a remedy of
 * its own; every other failure keeps the generic reason. The only remedy so far is to connect a
 * Computer, so the row offers that button for any guidance. A second remedy needs its own field. */
export type UnsentGuidance = { message: () => string };

const GUIDANCE: Readonly<Record<string, UnsentGuidance>> = {
  "workspace-assistant-computer-required": {
    message: () => m.workspace_assistant_computer_required(),
  },
};

export function unsentGuidance(errorId: string | undefined): UnsentGuidance | undefined {
  return errorId ? GUIDANCE[errorId] : undefined;
}
