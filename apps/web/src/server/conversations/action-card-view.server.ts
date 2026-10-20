/** What the browser sees of an action card (`ActionCards.viewsFor`), one shape per kind. */

export type ActionCardPrepareResult = { messageId: string; metadata: { kind: "action-card" } };

export type ActionCardState = "pending" | "executed" | "cancelled";

/** A resolved id plus display name for a card's chips; unresolved ids render as "unknown". */
export type ActionCardRef = { id: string; displayName: string };

export type ActionCardViewBase = {
  messageId: string;
  state: ActionCardState;
  draftHint?: string;
  committedBy?: { displayName: string };
  committedAt?: string;
  /** Whether the viewer may commit this card right now (implies `state === "pending"`). */
  canCommit: boolean;
  /** Whether the viewer may cancel this card right now (implies `state === "pending"`). */
  canCancel: boolean;
};

export type ActionCardView =
  | (ActionCardViewBase & {
      kind: "channel:create";
      name: string;
      visibility: "public" | "private";
      description?: string;
      initialHumans: ActionCardRef[];
      initialAgents: ActionCardRef[];
      result?: { channelId: string };
    })
  | (ActionCardViewBase & {
      kind: "agent:create";
      name: string;
      description?: string;
      suggestedComputer?: ActionCardRef;
      requiredComputer?: ActionCardRef;
      result?: { agentId: string };
    })
  | (ActionCardViewBase & {
      kind: "channel:add_member";
      channel: ActionCardRef;
      humans: ActionCardRef[];
      agents: ActionCardRef[];
      result?: { channelId: string; userIds: string[]; agentIds: string[] };
    })
  /** The Agent that posted it asks to use `app`; committing approves, cancelling denies. */
  | (ActionCardViewBase & {
      kind: "app:grant_agent";
      app: { key: string; name: string };
      scopes: string[];
      result?: { requestId: string };
    });
