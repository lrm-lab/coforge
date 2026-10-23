import { APP_BOT_KIND } from "#src/features/agents/agent-system-kind";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import type { Prisma } from "#src/generated/prisma/client";
import type {
  AppBotPrincipal,
  AppBotStore,
  AppBotView,
  GrantOutcome,
} from "#src/server/app-bots/app-bot-store";
import { inTransaction, type DatabaseScope } from "#src/server/db/transaction.server";
import { findAppMember } from "#src/server/db/repositories/app.repositories.server";

/** The runtime an app's bot carries: none. The column is required, nothing launches the Agent
 * (it has no Computer), and a launch would find no model. */
const BOT_RUNTIME = {
  runtime: "pi",
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};

/** Locks the installation, so its grant, revoke, key and status changes run one at a time. */
async function lockInstallation(tx: Prisma.TransactionClient, installationId: string) {
  await tx.$queryRaw`SELECT id FROM app_installations WHERE id = ${installationId}::uuid FOR UPDATE`;
}

/** Revokes the keys of the bots, in the transaction that revokes their grants or removes them. */
const revokeKeys = (tx: Prisma.TransactionClient, botIds: string[], at: Date) =>
  tx.appBotCredential.updateMany({
    where: { botId: { in: botIds }, revokedAt: null },
    data: { revokedAt: at },
  });

/** Archives bot Agents: hidden from directories and refused by the Agent API, their messages
 * kept. Granting again reactivates the same row. */
const archiveAgents = (
  tx: Prisma.TransactionClient,
  agentIds: string[],
  userId: string,
  at: Date,
) =>
  tx.agent.updateMany({
    where: { id: { in: agentIds }, deletedAt: null },
    data: { deletedAt: at, deletedByUserId: userId },
  });

/**
 * Takes the bots of the installations of `appId` in `workspace` away with them: archives their
 * Agents. Their rows, and with them their keys, go with the installations
 * (`removeAppInstallations` calls this first). The Agent stays so its messages keep their sender;
 * installing and granting again adopts it.
 */
export async function archiveAppBots(
  tx: Prisma.TransactionClient,
  input: { appId: string; workspace: string | { not: string }; userId: string; at: Date },
): Promise<void> {
  const bots = await tx.appInstallationBot.findMany({
    where: { installation: { appId: input.appId, workspaceId: input.workspace } },
    select: { agentId: true },
  });
  if (bots.length)
    await archiveAgents(
      tx,
      bots.map((bot) => bot.agentId),
      input.userId,
      input.at,
    );
}

/** The bots of the app `appId`, or of its installation `installationId`, that are granted. */
async function revokeGranted(
  tx: Prisma.TransactionClient,
  where: Prisma.AppInstallationBotWhereInput,
  userId: string,
  at: Date,
) {
  const bots = await tx.appInstallationBot.findMany({
    where: { ...where, state: "granted" },
    select: { id: true, agentId: true },
  });
  if (!bots.length) return;
  await tx.appInstallationBot.updateMany({
    where: { id: { in: bots.map((bot) => bot.id) } },
    data: { state: "revoked", revokedAt: at, statusText: null },
  });
  await revokeKeys(
    tx,
    bots.map((bot) => bot.id),
    at,
  );
  await archiveAgents(
    tx,
    bots.map((bot) => bot.agentId),
    userId,
    at,
  );
}

const BOT_OF_INSTALLATION = {
  id: true,
  agentId: true,
  state: true,
  generation: true,
  agent: { select: { deletedAt: true } },
} as const;

/** App bot rows over PostgreSQL. Who may grant and what the app's backend is told stay in
 * `server/app-bots/`. */
export class PrismaAppBotStore implements AppBotStore {
  constructor(private readonly db: DatabaseScope) {}

  async memberRole(workspaceId: string, userId: string) {
    return (await findAppMember(this.db, workspaceId, userId))?.role;
  }

  async findOwnApp(workspaceId: string, key: string) {
    return (
      (await this.db.app.findFirst({
        where: { key, ownerWorkspaceId: workspaceId },
        select: { id: true },
      })) ?? undefined
    );
  }

  declare(appId: string, enabled: boolean, input: { userId: string; at: Date }) {
    return inTransaction(this.db, async (tx) => {
      // Every installation's lock first, in id order as every locker takes them: a grant in
      // flight commits before this, and one that starts after reads the new declaration.
      await tx.$queryRaw`SELECT id FROM app_installations WHERE "appId" = ${appId}::uuid ORDER BY id FOR UPDATE`;
      await tx.app.update({ where: { id: appId }, data: { enableBot: enabled } });
      if (!enabled) await revokeGranted(tx, { installation: { appId } }, input.userId, input.at);
    });
  }

  grant(input: { workspaceId: string; appKey: string; userId: string; at: Date }) {
    return inTransaction(this.db, async (tx): Promise<GrantOutcome> => {
      const found = await tx.appInstallation.findFirst({
        where: { workspaceId: input.workspaceId, app: { key: input.appKey } },
        select: { id: true },
      });
      if (!found) return { kind: "no_installation" };
      await lockInstallation(tx, found.id);
      const installation = await tx.appInstallation.findUnique({
        where: { id: found.id },
        select: {
          id: true,
          app: { select: { key: true, name: true, description: true, enableBot: true } },
          bot: { select: { ...BOT_OF_INSTALLATION, statusText: true } },
        },
      });
      if (!installation) return { kind: "no_installation" };
      const { app, bot } = installation;
      if (!app.enableBot) return { kind: "not_declared" };
      const summary = (statusText: string | null) =>
        ({
          kind: "granted",
          bot: { installationId: installation.id, granted: true, statusText },
        }) as const;
      if (bot?.state === "granted" && !bot.agent.deletedAt) return summary(bot.statusText);
      const identity = {
        displayName: app.name,
        description: app.description,
        deletedAt: null,
        deletedByUserId: null,
      };
      if (bot) {
        // Granted again after a revoke, or after the Agent was deleted under a standing grant:
        // the same identity, a new generation, and no key of an earlier one.
        await revokeKeys(tx, [bot.id], input.at);
        await tx.appInstallationBot.update({
          where: { id: bot.id },
          data: {
            state: "granted",
            generation: bot.generation + 1,
            statusText: null,
            revokedAt: null,
            grantedByUserId: input.userId,
            grantedAt: input.at,
          },
        });
        await tx.agent.update({ where: { id: bot.agentId }, data: identity });
        return summary(null);
      }
      const agentId = await this.botAgent(tx, input, app, identity);
      if (!agentId) return { kind: "handle_conflict" };
      await tx.appInstallationBot.create({
        data: {
          installationId: installation.id,
          agentId,
          grantedByUserId: input.userId,
          grantedAt: input.at,
        },
      });
      return summary(null);
    });
  }

  /** The Agent for a first grant: an earlier installation's archived bot of this app, adopted, or
   * a new one. `undefined` when an ordinary Agent or a member holds the handle. */
  private async botAgent(
    tx: Prisma.TransactionClient,
    input: { workspaceId: string; userId: string },
    app: { key: string; name: string },
    identity: { displayName: string; description: string; deletedAt: null; deletedByUserId: null },
  ): Promise<string | undefined> {
    const member = await tx.workspaceMembership.findFirst({
      where: { workspaceId: input.workspaceId, user: { username: app.key } },
      select: { userId: true },
    });
    if (member) return undefined;
    const holder = await tx.agent.findUnique({
      where: { workspaceId_name: { workspaceId: input.workspaceId, name: app.key } },
      select: { id: true, systemKind: true, appBot: { select: { id: true } } },
    });
    if (holder) {
      if (holder.systemKind !== APP_BOT_KIND || holder.appBot) return undefined;
      await tx.agent.update({ where: { id: holder.id }, data: identity });
      return holder.id;
    }
    const created = await tx.agent.create({
      data: {
        ...identity,
        workspaceId: input.workspaceId,
        name: app.key,
        ownerId: input.userId,
        visibility: AGENT_VISIBILITY.PUBLIC,
        systemKind: APP_BOT_KIND,
        runtimeConfig: BOT_RUNTIME,
      },
      select: { id: true },
    });
    return created.id;
  }

  revoke(input: { workspaceId: string; appKey: string; userId: string; at: Date }) {
    return inTransaction(this.db, async (tx) => {
      const installation = await tx.appInstallation.findFirst({
        where: { workspaceId: input.workspaceId, app: { key: input.appKey } },
        select: { id: true },
      });
      if (!installation) return;
      await lockInstallation(tx, installation.id);
      await revokeGranted(tx, { installationId: installation.id }, input.userId, input.at);
    });
  }

  async workspaceBots(workspaceId: string) {
    const rows = await this.db.appInstallation.findMany({
      where: { workspaceId },
      select: {
        id: true,
        app: { select: { key: true, enableBot: true } },
        bot: { select: { state: true, statusText: true, agent: { select: { deletedAt: true } } } },
      },
    });
    return new Map<string, AppBotView>(
      rows.map((row) => [
        row.app.key,
        {
          declared: row.app.enableBot,
          installationId: row.id,
          granted: row.bot?.state === "granted" && !row.bot.agent.deletedAt,
          statusText: row.bot?.state === "granted" ? row.bot.statusText : null,
        },
      ]),
    );
  }

  /** The installation of the app `clientKey` with its bot, as the app's backend may see it. */
  private async ownedInstallation(tx: Prisma.TransactionClient, clientKey: string, id: string) {
    return tx.appInstallation.findFirst({
      where: { id, app: { key: clientKey } },
      select: { app: { select: { enableBot: true } }, bot: { select: BOT_OF_INSTALLATION } },
    });
  }

  mintKey(input: { clientKey: string; installationId: string; rotate: boolean; keyHash: string }) {
    return inTransaction(this.db, async (tx) => {
      // Only the app's own installation is locked: another app's id takes no lock.
      if (!(await this.ownedInstallation(tx, input.clientKey, input.installationId)))
        return { ok: false, refusal: "installation_not_found" } as const;
      await lockInstallation(tx, input.installationId);
      const found = await this.ownedInstallation(tx, input.clientKey, input.installationId);
      if (!found) return { ok: false, refusal: "installation_not_found" } as const;
      const { bot } = found;
      if (!bot || bot.state !== "granted" || !found.app.enableBot)
        return { ok: false, refusal: "bot_not_granted" } as const;
      if (bot.agent.deletedAt) return { ok: false, refusal: "bot_not_active" } as const;
      const live = await tx.appBotCredential.count({ where: { botId: bot.id, revokedAt: null } });
      if (live && !input.rotate) return { ok: false, refusal: "credential_exists" } as const;
      await revokeKeys(tx, [bot.id], new Date());
      const credential = await tx.appBotCredential.create({
        data: { botId: bot.id, keyHash: input.keyHash, generation: bot.generation },
        select: { id: true },
      });
      return { ok: true, credentialId: credential.id, agentId: bot.agentId } as const;
    });
  }

  setStatus(input: { clientKey: string; installationId: string; text: string | null }) {
    return inTransaction(this.db, async (tx) => {
      if (!(await this.ownedInstallation(tx, input.clientKey, input.installationId)))
        return { ok: false, refusal: "installation_not_found" } as const;
      await lockInstallation(tx, input.installationId);
      // One conditional write; a revoke that lands first wins and nothing is stored.
      const { count } = await tx.appInstallationBot.updateMany({
        where: {
          installationId: input.installationId,
          state: "granted",
          agent: { deletedAt: null },
          installation: { app: { key: input.clientKey, enableBot: true } },
        },
        data: { statusText: input.text },
      });
      if (count === 1) return { ok: true } as const;
      const found = await this.ownedInstallation(tx, input.clientKey, input.installationId);
      if (!found) return { ok: false, refusal: "installation_not_found" } as const;
      return {
        ok: false,
        refusal:
          !found.bot || found.bot.state !== "granted" || !found.app.enableBot
            ? "bot_not_granted"
            : "bot_not_active",
      } as const;
    });
  }

  async findByKeyHash(keyHash: string): Promise<AppBotPrincipal | undefined> {
    const credential = await this.db.appBotCredential.findUnique({
      where: { keyHash },
      select: {
        revokedAt: true,
        generation: true,
        bot: {
          select: {
            state: true,
            generation: true,
            agent: { select: { id: true, workspaceId: true, ownerId: true, deletedAt: true } },
            installation: { select: { app: { select: { enableBot: true } } } },
          },
        },
      },
    });
    const bot = credential?.bot;
    if (
      !credential ||
      !bot ||
      credential.revokedAt ||
      bot.state !== "granted" ||
      bot.generation !== credential.generation ||
      bot.agent.deletedAt ||
      !bot.installation.app.enableBot
    )
      return undefined;
    return {
      agentId: bot.agent.id,
      workspaceId: bot.agent.workspaceId,
      userId: bot.agent.ownerId,
    };
  }
}
