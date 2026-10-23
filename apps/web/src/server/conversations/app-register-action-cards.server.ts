import {
  APP_REGISTER_CARD_KIND,
  type AppRegisterAction,
  type ResolvedAppRegisterPayload,
} from "@lrm/coforge-sdk/agent";
import { APP_FIXED_SCOPES } from "@lrm/coforge-sdk/internal/app-scopes";
import {
  APP_INPUT_ERROR_IDS,
  checkAppInput,
  type AppInputField,
  type AppRegistrationInput,
} from "#src/features/apps/app-registration";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import type { AppRegistrationNotices } from "#src/server/apps/app-registration-notices.server";
import { PrismaAppOwnerAgentStore } from "#src/server/db/repositories/app-owner-agents.repositories.server";
import { inTransaction } from "#src/server/db/transaction.server";
import { ActionCardError } from "./action-card-error.server";
import { publishActionCardUpdate } from "./action-card-message.server";
import type { ConversationRealtime } from "./conversation-realtime.server";
import { loadPendingActionCard } from "./pending-action-card.server";

/** The flag an Agent set that each registry field comes from, named in a refusal. */
const FLAGS: Record<AppInputField, string> = {
  key: "--client-key",
  name: "--name",
  description: "--description",
  whenToUse: "--when-to-use",
  homepageUrl: "--homepage-url",
  redirectUris: "--redirect-url",
  category: "--category",
  allowedScopes: "--scope",
  agentManifestUrl: "--agent-manifest-url",
};

/** A key stands in for a blank one while the input is checked: it is made on commit. */
const PLACEHOLDER_KEY = "app-to-be-named";

/** The one-line summary that becomes the posted Message body. */
export const appRegisterSummary = (action: AppRegisterAction) =>
  `Action card: register app ${action.name}`;

/**
 * The payload an `app:register` action is stored as, after the registry's own input rules
 * (`checkAppInput`) have accepted it, so a card that could never be committed is refused when
 * prepared. Throws `ActionCardError("INVALID_ACTION")` naming the flag whose value was refused, or
 * `APP_EXISTS` for a client key already taken.
 */
export async function resolveAppRegisterPayload(
  db: PrismaClient,
  action: AppRegisterAction,
): Promise<ResolvedAppRegisterPayload> {
  const key = action.clientKey ?? "";
  const scopes = [...new Set([...APP_FIXED_SCOPES, ...action.scopes])];
  const input: AppRegistrationInput = {
    key: key || PLACEHOLDER_KEY,
    name: action.name,
    description: action.description ?? "",
    whenToUse: action.whenToUse ?? "",
    homepageUrl: action.homepageUrl ?? null,
    redirectUris: action.redirectUrls,
    category: (action.category ?? "other") as AppRegistrationInput["category"],
    allowedScopes: scopes,
    agentManifestUrl: action.agentManifestUrl ?? null,
  };
  const outcome = checkAppInput(input, "registration");
  if (!outcome.ok)
    throw new ActionCardError(
      422,
      "INVALID_ACTION",
      `${FLAGS[outcome.field]} is not acceptable (${APP_INPUT_ERROR_IDS[outcome.field]})`,
      { field: FLAGS[outcome.field] },
    );
  const { value } = outcome;
  if (key && (await db.app.findUnique({ where: { key }, select: { id: true } })))
    throw new ActionCardError(409, "APP_EXISTS", `an app with client key ${key} already exists`);
  return {
    type: APP_REGISTER_CARD_KIND,
    key,
    name: value.name,
    description: value.description,
    whenToUse: value.whenToUse,
    homepageUrl: value.homepageUrl,
    redirectUris: value.redirectUris,
    category: value.category,
    allowedScopes: value.allowedScopes,
    agentManifestUrl: value.agentManifestUrl ?? null,
  };
}

/** What a person does with an `app:register` card: commit it to register the app for the Agent
 * that prepared it, as `AppRegistry.registerApp` authorizes (a Workspace owner or admin). */
export class AppRegisterActionCards {
  constructor(
    private readonly db: PrismaClient,
    private readonly realtime?: ConversationRealtime,
    private readonly notices?: Pick<AppRegistrationNotices, "send">,
  ) {}

  /**
   * Registers the app and makes the preparing Agent its owner, then marks the card executed, in
   * one transaction: a second commit finds the card no longer pending and registers nothing. The
   * client secret goes only to the owner Agent, in a private notice sent after the commit; it is
   * not returned, stored on the card or logged.
   */
  async commit(
    actor: { workspaceId: string; userId: string },
    messageId: string,
  ): Promise<{ clientKey: string }> {
    const card = await loadPendingActionCard(
      this.db,
      actor.workspaceId,
      actor.userId,
      messageId,
      APP_REGISTER_CARD_KIND,
    );
    const { type: _type, ...input } = card.payload as unknown as ResolvedAppRegisterPayload;
    const agentId = card.preparedByAgentId;
    const created = await inTransaction(this.db, async (tx) => {
      const { app, clientSecret } = await createAppRegistry(tx).registerApp(
        { workspaceId: actor.workspaceId, actorUserId: actor.userId },
        input as AppRegistrationInput,
      );
      const owned = await new PrismaAppOwnerAgentStore(tx).assign(app.key, agentId);
      await this.settle(tx, messageId, actor.userId, app.key, owned);
      return { app, clientSecret, owned };
    });
    // Browsers refresh the card; the owner Agent alone gets the secret, privately and best effort
    // (an Agent that misses it rotates it).
    await Promise.all([
      publishActionCardUpdate(this.db, this.realtime, card.conversationId, messageId),
      created.owned
        ? this.notices?.send({
            agentId,
            appKey: created.app.key,
            appName: created.app.name,
            clientSecret: created.clientSecret,
          })
        : undefined,
    ]);
    return { clientKey: created.app.key };
  }

  private async settle(
    tx: Prisma.TransactionClient,
    messageId: string,
    userId: string,
    clientKey: string,
    owned: boolean,
  ) {
    const updated = await tx.actionCard.updateMany({
      where: { messageId, state: "pending" },
      data: {
        state: "executed",
        committedByUserId: userId,
        committedAt: new Date(),
        // No owner Agent (it was archived or deleted first): the card says so, and no secret was sent.
        result: owned ? { clientKey } : { clientKey, noOwnerAgent: true },
      },
    });
    if (updated.count === 0) throw new AppError("CONFLICT");
  }
}

/** What the card view shows of the payload. */
export function appRegisterView(payload: ResolvedAppRegisterPayload) {
  return {
    clientKey: payload.key || null,
    name: payload.name,
    redirectUrls: payload.redirectUris,
    homepageUrl: payload.homepageUrl,
    description: payload.description,
    whenToUse: payload.whenToUse,
    category: payload.category,
    scopes: payload.allowedScopes,
    agentManifestUrl: payload.agentManifestUrl,
  };
}
