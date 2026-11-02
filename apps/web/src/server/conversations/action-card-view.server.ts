import type { PreviewCard } from "#src/features/conversations/action-card-preview";

/** What the browser sees of an action card (`ActionCards.viewsFor`), one shape per kind. */
import type { AgentActionPrepareResponse } from "@lrm/coforge-sdk/agent";

/** What `prepare` answers, exactly the shape the Agent API promises. */
export type ActionCardPrepareResult = AgentActionPrepareResponse;

export type ActionCardState = "pending" | "executed" | "cancelled";

/** A resolved id plus display name for a card's chips; unresolved ids render as "unknown". */
export type ActionCardRef = { id: string; displayName: string };

export type ActionCardViewBase = {
  messageId: string;
  state: ActionCardState;
  draftHint?: string;
  /** What the card's one line is written from in the viewer's language, for the text that stands
   * for it (a screen reader's, a thread's reply preview). Absent for a choice card. */
  preview?: PreviewCard;
  committedBy?: { displayName: string };
  committedAt?: string;
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
      initialHumans: ActionCardRef[];
      initialAgents: ActionCardRef[];
      /** The Project the Agent suggested, for the confirm dialog to preselect. It may no longer
       * exist by the time the card is read. */
      suggestedProjectId?: string;
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
  | (ActionCardViewBase & {
      kind: "app:recover_owner";
      app: { key: string; name: string };
      toAgent: { name: string };
      result?: { clientKey: string; ownerAgent: string };
    });
