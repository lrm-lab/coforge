import { UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";

import { AppError } from "#src/lib/app-error";
import { canManageApps } from "#src/features/workspaces/workspace-roles";
import {
  APP_BOT_HANDLE_CONFLICT,
  APP_BOT_NOT_DECLARED,
  APP_BOT_SCOPES,
  APP_BOT_STATUS_MAX_UNITS,
  type AppBotSummary,
} from "#src/features/apps/app-bot";
import {
  generateAgentApiKey,
  hashAgentApiKey,
  isAgentApiKeyShape,
} from "#src/server/agents/agent-api-key.server";
import type { AppActor } from "#src/server/apps/app-registry.server";
import type { AppBotPrincipal, AppBotStore, AppBotView, BotRefusal } from "./app-bot-store";

/** What `bot-token` answers: the key (shown once, never read back), its credential and the Agent. */
export type MintedBotKey = {
  credentialId: string;
  apiKey: string;
  agentId: string;
  scopes: typeof APP_BOT_SCOPES;
};

export type MintOutcome = { ok: true; key: MintedBotKey } | { ok: false; refusal: BotRefusal };

/** A status line the app sent: `null` clears it, a string is stored trimmed, anything else (an
 * empty or blank string, too many UTF-16 units, another type) is `invalid`. */
export type StatusText = { text: string | null } | "invalid";

/** The status line out of the request's `text`; the limit counts before trimming. */
export function parseStatusText(value: unknown): StatusText {
  if (value === null || value === undefined) return { text: null };
  if (typeof value !== "string" || value.length > APP_BOT_STATUS_MAX_UNITS) return "invalid";
  const trimmed = value.trim();
  return trimmed ? { text: trimmed } : "invalid";
}

export type AppBotsOptions = { now?: () => Date; newKey?: () => string };

/**
 * An app's bot, in three steps that imply nothing of each other. The app's developer declares it
 * (`declare`, `enableBot`); each Workspace's owner or admin grants it to the installation there
 * (`grant`), which makes the bot Agent the first time, and may revoke it (`revoke`); the app's
 * backend, with its client credentials, mints the bot's key (`mintKey`) and publishes a status
 * line (`setStatus`). The key is the one Agent API key format, stored by hash, and works only on
 * the capabilities of `app-bot-capabilities.server.ts`. The bot has no Computer, so nothing
 * launches it or delivers to it: its app reads what waits for it.
 */
export class AppBots {
  private readonly now: () => Date;
  private readonly newKey: () => string;

  constructor(
    private readonly store: AppBotStore,
    options: AppBotsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newKey = options.newKey ?? generateAgentApiKey;
  }

  /** Step 1: the app declares (or stops declaring) a bot. Turning it off revokes every grant and
   * disables the bots at once. Owners and admins of the Workspace that owns the app. */
  async declare(actor: AppActor, key: string, enabled: boolean): Promise<void> {
    await this.requireManager(actor);
    const app = await this.store.findOwnApp(actor.workspaceId, key);
    if (!app) throw new AppError("NOT_FOUND");
    await this.store.declare(app.id, enabled, { userId: actor.actorUserId, at: this.now() });
  }

  /** Step 2: the Workspace's owner or admin grants the bot to the app's installation here. */
  async grant(actor: AppActor, key: string): Promise<AppBotSummary> {
    await this.requireManager(actor);
    const outcome = await this.store.grant({
      workspaceId: actor.workspaceId,
      appKey: key,
      userId: actor.actorUserId,
      at: this.now(),
    });
    switch (outcome.kind) {
      case "granted":
        return outcome.bot;
      case "no_installation":
        throw new AppError("NOT_FOUND");
      case "not_declared":
        throw new AppError("CONFLICT", { errorId: APP_BOT_NOT_DECLARED });
      case "handle_conflict":
        throw new AppError("CONFLICT", { errorId: APP_BOT_HANDLE_CONFLICT });
    }
  }

  /** Revokes the grant: the bot is disabled and its key ends. Nothing happens when it is not granted. */
  async revoke(actor: AppActor, key: string): Promise<void> {
    await this.requireManager(actor);
    await this.store.revoke({
      workspaceId: actor.workspaceId,
      appKey: key,
      userId: actor.actorUserId,
      at: this.now(),
    });
  }

  /** The bot of each app installed in the Workspace, by app key, for any member. */
  async workspaceBots(actor: AppActor): Promise<Map<string, AppBotView>> {
    if (!(await this.store.memberRole(actor.workspaceId, actor.actorUserId)))
      throw new AppError("ACCESS_DENIED");
    return this.store.workspaceBots(actor.workspaceId);
  }

  /** Step 3: the app's backend (already authenticated as `clientKey`) mints the bot's key. */
  async mintKey(clientKey: string, installationId: string, rotate: boolean): Promise<MintOutcome> {
    if (!UUID_LIKE_PATTERN.test(installationId))
      return { ok: false, refusal: "installation_not_found" };
    const apiKey = this.newKey();
    const minted = await this.store.mintKey({
      clientKey,
      installationId,
      rotate,
      keyHash: hashAgentApiKey(apiKey),
    });
    if (!minted.ok) return minted;
    return {
      ok: true,
      key: {
        credentialId: minted.credentialId,
        apiKey,
        agentId: minted.agentId,
        scopes: APP_BOT_SCOPES,
      },
    };
  }

  /** The app publishes (or, with `null`, clears) the line beside its bot. */
  async setStatus(clientKey: string, installationId: string, text: string | null) {
    if (!UUID_LIKE_PATTERN.test(installationId))
      return { ok: false, refusal: "installation_not_found" } as const;
    return this.store.setStatus({ clientKey, installationId, text });
  }

  /** The bot a presented Agent API key speaks for, while its grant stands. */
  async authenticate(apiKey: string): Promise<AppBotPrincipal | undefined> {
    if (!isAgentApiKeyShape(apiKey)) return undefined;
    return this.store.findByKeyHash(hashAgentApiKey(apiKey));
  }

  private async requireManager(actor: AppActor): Promise<void> {
    const role = await this.store.memberRole(actor.workspaceId, actor.actorUserId);
    if (!role || !canManageApps(role)) throw new AppError("ACCESS_DENIED");
  }
}
