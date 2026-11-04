import type { PreviewCard } from "#src/features/conversations/action-card-preview";

/** What the browser sees of an action card (`ActionCards.viewsFor`), one shape per kind. */
import type { AgentActionPrepareResponse } from "@lrm/coforge-sdk/agent";

/** What `prepare` answers, exactly the shape the Agent API promises. */
export type ActionCardPrepareResult = AgentActionPrepareResponse;

export type ActionCardState = "pending" | "executed" | "cancelled" | "expired" | "answered_in_chat";

/** How long a pending card waits before it expires, from the moment it is posted. */
export const ACTION_CARD_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * The state a reader sees: a pending row whose `expiresAt` has passed reads as expired even before
 * the sweep writes it, so a slow tick never leaves an expired card answerable.
 */
export function effectiveActionCardState(
  state: string,
  expiresAt: Date | null | undefined,
  now = new Date(),
): ActionCardState {
  if (state === "pending" && expiresAt && expiresAt.getTime() <= now.getTime()) return "expired";
  return state as ActionCardState;
}

/** A resolved id plus display name for a card's chips; unresolved ids render as "unknown". */
export type ActionCardRef = { id: string; displayName: string };
/** A human or Agent the card names, with the picture the card shows for them. */
export type ActionCardPersonRef = ActionCardRef & { avatarUrl: string | null };

export type ActionCardViewBase = {
  messageId: string;
  state: ActionCardState;
  draftHint?: string;
  /** What the card's one line is written from in the viewer's language, for the text that stands
   * for it (a screen reader's, a thread's reply preview). Absent for a choice card. */
  preview?: PreviewCard;
  /** Who committed it; `isViewer` lets the handled line name only someone else. */
  committedBy?: { displayName: string; isViewer: boolean };
  committedAt?: string;
  /** When a pending card expires (7 days after it was posted). */
  expiresAt?: string;
  /** The asked person's first message that answered a choice in chat. */
  answeredInChat?: { messageId: string };
  /** Whether the viewer may commit this card right now (implies `state === "pending"`). */
  canCommit: boolean;
  /** Whether the viewer may cancel this card right now (implies `state === "pending"`). */
  canCancel: boolean;
};

/** What an `app:register` card shows of the app it would register; the client secret is never
 * part of it. A null `clientKey` is made from the name on commit. */
export type AppRegisterCardFields = {
  clientKey: string | null;
  name: string;
  redirectUrls: string[];
  homepageUrl: string | null;
  description: string;
  whenToUse: string;
  category: string;
  scopes: string[];
  agentManifestUrl: string | null;
};

export type ActionCardView =
  | (ActionCardViewBase & {
      kind: "channel:create";
      name: string;
      visibility: "public" | "private";
      description?: string;
      initialHumans: ActionCardPersonRef[];
      initialAgents: ActionCardPersonRef[];
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
      /** `id` is null to a viewer who cannot read the channel (task #302). */
      channel: { id: string | null; displayName: string };
      humans: ActionCardPersonRef[];
      agents: ActionCardPersonRef[];
      result?: { channelId: string; userIds: string[]; agentIds: string[] };
    })
  /** The Agent that posted it asks to use `app`; committing approves, cancelling denies. */
  | (ActionCardViewBase & {
      kind: "app:grant_agent";
      app: { key: string; name: string };
      scopes: string[];
      result?: { requestId: string };
    })
  /** The Agent that posted it asks to register `app` with itself as the owner Agent; committing
   * registers it, as a Workspace owner or admin may. */
  | (ActionCardViewBase & {
      kind: "app:register";
      app: AppRegisterCardFields;
      result?: { clientKey: string; noOwnerAgent?: boolean };
    })
  /** The Agent that posted it asks to make `toAgent` the owner Agent of `app`, which has none
   * alive; committing does, as a Workspace owner or admin may. */
  /** Fields to type into the Agent's browser. Values are not on the card. */
  | (ActionCardViewBase & {
      kind: "page:fill";
      prompt?: string;
      computerId: string;
      agentId: string;
      fields: { id: string; label: string; input: "text" | "password" }[];
      result?: { filled: string[] };
    })
  /** Open this Agent's cloud desktop when page:fill cannot finish the step. */
  | (ActionCardViewBase & {
      kind: "desktop:takeover";
      prompt?: string;
      computerId: string;
      agentId: string;
      agentName: string;
      result?: { done: true };
    })
  /** An Agent's question with clickable options, for the person it names. */
  | (ActionCardViewBase & {
      kind: "choice";
      prompt: string;
      options: { id: string; label: string }[];
      /** The asked person as the card names them, and whether that is the viewer; absent on a card
       * made before every choice named one, which nobody can answer. */
      asked?: { displayName: string; isViewer: boolean };
      /** Present when the card offers the person's own answer as its last row; absent when the
       * Agent turned it off and on cards made before it existed. */
      other?: { label?: string };
      result?: { optionId: string; label: string; text?: string };
    })
  /** An Agent's several questions on one card, one submit answering all, for the person it
   * names. */
  | (ActionCardViewBase & {
      kind: "questions";
      prompt?: string;
      questions: {
        id: string;
        prompt: string;
        select: "one" | "many";
        options: { id: string; label: string; description?: string; recommended?: true }[];
        other?: { label?: string };
      }[];
      asked?: { displayName: string; isViewer: boolean };
      result?: {
        answers: {
          questionId: string;
          prompt: string;
          selection: { optionId: string; label: string; recommended?: true; text?: string }[];
        }[];
      };
    })
  | (ActionCardViewBase & {
      kind: "app:recover_owner";
      app: { key: string; name: string };
      toAgent: { name: string };
      result?: { clientKey: string; ownerAgent: string };
    });
