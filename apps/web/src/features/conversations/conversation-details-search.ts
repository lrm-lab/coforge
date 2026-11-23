import { z } from "zod";

export const CONVERSATION_DETAILS_VIEWS = ["panel", "members", "add"] as const;
export type ConversationDetailsParam = (typeof CONVERSATION_DETAILS_VIEWS)[number];

export const detailsParamSchema = z.enum(CONVERSATION_DETAILS_VIEWS).optional().catch(undefined);

export function detailsMembersView(
  details: ConversationDetailsParam | undefined,
): "members" | "add" | null {
  return details === "members" || details === "add" ? details : null;
}

export function conversationSearchWithDetails<T extends Record<string, unknown>>(
  previous: T,
  details: ConversationDetailsParam = "panel",
) {
  const {
    threadRootId: _t,
    profile: _p,
    agentTab: _a,
    doc: _d,
    docFull: _df,
    details: _prevDetails,
    ...rest
  } = previous;
  return { ...rest, details };
}

export function conversationSearchWithoutDetails<T extends object>(
  previous: T,
): Omit<T, "details"> {
  const { details: _details, ...rest } = previous as T & { details?: unknown };
  return rest as Omit<T, "details">;
}
