import { z } from "zod";

/** The authorization request's raw query; one past the sign-in return limit is refused by the
 * endpoint itself (`invalid_request`), so this bound only keeps the input finite. */
export const authorizationPageInputSchema = z.object({ search: z.string().max(8_192) });

/** The consent page's answer: its handle, and Continue (with the Workspace chosen) or Cancel. */
export const authorizationDecisionInputSchema = z.object({
  handle: z.string().min(1).max(8_192),
  decision: z.discriminatedUnion("approve", [
    z.object({ approve: z.literal(true), workspaceId: z.uuid() }),
    z.object({ approve: z.literal(false) }),
  ]),
});
