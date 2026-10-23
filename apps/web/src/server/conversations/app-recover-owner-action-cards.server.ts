import {
  APP_RECOVER_OWNER_CARD_KIND,
  type AppRecoverOwnerAction,
  type ResolvedAppRecoverOwnerPayload,
} from "@lrm/coforge-sdk/agent";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { createAppOwnerAgents } from "#src/server/apps/app-owner-agents-composition.server";
import { inTransaction } from "#src/server/db/transaction.server";
import { assertCanManageApps } from "#src/server/workspaces/member-role.server";
import { workspaceMemberRole } from "#src/server/workspaces/workspace-membership.server";
import { ActionCardError } from "./action-card-error.server";
import { publishActionCardUpdate } from "./action-card-message.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { loadPendingActionCard } from "./pending-action-card.server";

/** The one-line summary that becomes the posted Message body. */
export const appRecoverOwnerSummary = (action: AppRecoverOwnerAction) =>
  `Action card: make ${action.toAgent} the owner Agent of app ${action.clientKey}`;

/**
 * The payload an `app:recover_owner` action is stored as. The preparing Agent must manage the app
 * (`AppOwnerAgents.manager`: an admin-role Agent, since the owner is gone) and the app must have no
 * live owner Agent; otherwise the card could never be committed. Throws `ActionCardError`.
 */
export async function resolveAppRecoverOwnerPayload(
  db: PrismaClient,
  principal: { workspaceId: string; agentId: string },
  action: AppRecoverOwnerAction,
): Promise<ResolvedAppRecoverOwnerPayload> {
  try {
    const { appName, target } = await createAppOwnerAgents(db).prepareRecovery(
      principal,
      action.clientKey,
      action.toAgent,
    );
    return {
      type: APP_RECOVER_OWNER_CARD_KIND,
      clientKey: action.clientKey,
      appName,
      toAgentId: target.id,
      toAgentName: target.name,
    };
  } catch (error) {
    if (!isAppError(error)) throw error;
    if (error.code === "NOT_FOUND")
      throw new ActionCardError(
        422,
        "INVALID_HANDLE",
        `no app ${action.clientKey} that you manage`,
        { field: "--client" },
      );
    if (error.errorId === "app-owner-active")
      throw new ActionCardError(
        409,
        "APP_OWNER_ACTIVE",
        `app ${action.clientKey} has an active owner Agent`,
      );
    if (error.errorId === "app-owner-agent-invalid")
      throw new ActionCardError(
        422,
        "INVALID_HANDLE",
        `${action.toAgent} is not a live, public Agent of this Workspace`,
        { field: "--to-agent" },
      );
    throw error;
  }
}

/** What a person does with an `app:recover_owner` card: commit it to make the named Agent the app's
 * owner Agent, as a Workspace owner or admin may (the same role that registers apps). */
export class AppRecoverOwnerActionCards {
  constructor(
    private readonly db: PrismaClient,
    private readonly realtime?: ConversationRealtime,
  ) {}

  /** Re-checks that the app still has no live owner Agent and the Agent is still alive, then sets
   * the owner and settles the card, in one transaction; a second commit finds it no longer pending. */
  async commit(actor: { workspaceId: string; userId: string }, messageId: string) {
    assertCanManageApps(await workspaceMemberRole(this.db, actor.workspaceId, actor.userId));
    const card = await loadPendingActionCard(
      this.db,
      actor.workspaceId,
      actor.userId,
      messageId,
      APP_RECOVER_OWNER_CARD_KIND,
    );
    const payload = card.payload as unknown as ResolvedAppRecoverOwnerPayload;
    const recovered = await inTransaction(this.db, async (tx) => {
      const done = await createAppOwnerAgents(tx).recover(
        actor.workspaceId,
        payload.clientKey,
        payload.toAgentId,
      );
      const updated = await tx.actionCard.updateMany({
        where: { messageId, state: "pending" },
        data: {
          state: "executed",
          committedByUserId: actor.userId,
          committedAt: new Date(),
          result: { clientKey: payload.clientKey, ownerAgent: done.ownerAgent },
        },
      });
      if (updated.count === 0) throw new AppError("CONFLICT");
      return done;
    });
    await publishActionCardUpdate(this.db, this.realtime, card.conversationId, messageId);
    return { clientKey: payload.clientKey, ownerAgent: recovered.ownerAgent };
  }
}

/** What the card view shows of the payload. */
export function appRecoverOwnerView(payload: ResolvedAppRecoverOwnerPayload) {
  return {
    app: { key: payload.clientKey, name: payload.appName },
    toAgent: { name: payload.toAgentName },
  };
}
