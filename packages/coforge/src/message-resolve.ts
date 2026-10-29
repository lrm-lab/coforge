import { ambiguousMessageIdError, formatMessageResolve } from "./message-format";

/** `coforge message resolve`: the one message an id names, whole, with where to look when it
 * matches nothing or more than one. */
export async function runMessageResolve(
  resolve: (messageId: string) => Promise<unknown>,
  messageId: string,
): Promise<string> {
  try {
    return formatMessageResolve(await resolve(messageId), messageId);
  } catch (error) {
    // The server refuses a prefix it cannot settle with one message; name that refusal.
    if (error instanceof Error && /ambiguous message prefix/i.test(error.message))
      throw ambiguousMessageIdError(messageId);
    throw error;
  }
}
