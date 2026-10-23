import { APP_GRANT_AGENT_CARD_KIND, type ResolvedActionCardPayload } from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  AgentAppAccessActor as Actor,
  AppAgentAccess,
} from "#src/server/app-agent-access/app-agent-access.server";
import { loadPendingActionCard } from "./pending-action-card.server";

/** What a person does with an `app:grant_agent` approval card: commit it to approve the Agent's
 * request, cancel it to deny it, each as `AppAgentAccess` authorizes. */
export class AppGrantActionCards {
  constructor(private readonly db: PrismaClient) {}

  /** Commit: approves the request. */
  async commit(
    actor: Actor,
    messageId: string,
    access: Pick<AppAgentAccess, "approve">,
    /** The scopes the committing card displayed; the approval is refused if the request moved on. */
    shownScopes?: readonly string[],
  ): Promise<void> {
    const { agentId, requestId } = (await this.load(actor, messageId)).payload;
    await access.approve(actor, { agentId, requestId, scopes: shownScopes });
  }

  /** Cancel: denies the request. */
  async deny(actor: Actor, messageId: string, access: Pick<AppAgentAccess, "deny">): Promise<void> {
    await access.deny(actor, (await this.load(actor, messageId)).payload);
  }

  private async load(actor: Actor, id: string) {
    const card = await loadPendingActionCard(
      this.db,
      actor.workspaceId,
      actor.userId,
      id,
      APP_GRANT_AGENT_CARD_KIND,
    );
    return {
      ...card,
      payload: card.payload as ResolvedActionCardPayload & { type: "app:grant_agent" },
    };
  }
}
