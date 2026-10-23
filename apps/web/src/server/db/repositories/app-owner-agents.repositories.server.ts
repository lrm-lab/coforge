import { APP_REGISTER_CARD_KIND, type ResolvedAppRegisterPayload } from "@lrm/coforge-sdk/agent";
import type { AppPublishStatus } from "#src/features/apps/app-publish-status";
import { UUID_LIKE_PATTERN } from "@lrm/coforge-sdk/internal";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import type { Prisma } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type {
  AppOwnerAgentStore,
  OwnedAppRow,
  OwnerAgentApp,
  RegisterCardRow,
} from "#src/server/apps/app-owner-agents.server";

const APP = {
  id: true,
  key: true,
  name: true,
  description: true,
  redirectUris: true,
  logoObjectKey: true,
  publishStatus: true,
  ownerWorkspaceId: true,
  ownerAgentId: true,
} as const;
const BY_NAME = [{ name: "asc" }, { key: "asc" }] as const;
const CARD = {
  messageId: true,
  state: true,
  payload: true,
  result: true,
  committedByUser: { select: { displayName: true, username: true } },
} as const;

/** Rows for an Agent managing the apps it registered; who may do what stays in `server/apps/`. */
export class PrismaAppOwnerAgentStore implements AppOwnerAgentStore {
  constructor(private readonly db: Prisma.TransactionClient) {}

  async agent(agentId: string) {
    const row = await this.db.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        workspaceId: true,
        role: true,
        deletedAt: true,
        workspace: { select: { slug: true } },
      },
    });
    return row
      ? {
          id: row.id,
          workspaceId: row.workspaceId,
          role: row.role,
          archived: row.deletedAt !== null,
          workspaceSlug: row.workspace.slug,
        }
      : undefined;
  }

  async candidate(workspaceId: string, handle: string) {
    const bare = handle.startsWith("@") ? handle.slice(1) : handle;
    const row = await this.db.agent.findFirst({
      where: {
        workspaceId,
        ...ACTIVE_AGENT_WHERE,
        visibility: AGENT_VISIBILITY.PUBLIC,
        systemKind: null,
        ...(UUID_LIKE_PATTERN.test(bare) ? { id: bare } : { name: bare }),
      },
      select: { id: true, name: true },
    });
    return row ?? undefined;
  }

  async agentNamed(agentId: string) {
    const row = await this.db.agent.findUnique({
      where: { id: agentId },
      select: { name: true, deletedAt: true },
    });
    return row ? { name: row.name, archived: row.deletedAt !== null } : undefined;
  }

  async setOwner(key: string, workspaceId: string, from: string | null, to: string) {
    const updated = await this.db.app.updateMany({
      where: { key, ownerWorkspaceId: workspaceId, ownerAgentId: from },
      data: { ownerAgentId: to },
    });
    return updated.count === 1;
  }

  async find(key: string): Promise<OwnerAgentApp | undefined> {
    const row = await this.db.app.findUnique({ where: { key }, select: APP });
    return row ? withStatus(row) : undefined;
  }

  async managed(agent: { id: string; workspaceId: string }, all: boolean) {
    const rows = await this.db.app.findMany({
      where: all ? { ownerWorkspaceId: agent.workspaceId } : { ownerAgentId: agent.id },
      select: APP,
      orderBy: [...BY_NAME],
    });
    return rows.map(withStatus);
  }

  async withOwners(workspaceId: string): Promise<OwnedAppRow[]> {
    const rows = await this.db.app.findMany({
      where: { ownerWorkspaceId: workspaceId, ownerAgentId: { not: null } },
      select: {
        ...APP,
        ownerAgent: {
          select: { name: true, displayName: true, visibility: true, deletedAt: true },
        },
      },
    });
    return rows.map(({ ownerAgent, ...app }) => ({
      ...withStatus(app),
      ownerAgent: ownerAgent && {
        name: ownerAgent.name,
        displayName: ownerAgent.displayName,
        visibility: ownerAgent.visibility,
        archived: ownerAgent.deletedAt !== null,
      },
    }));
  }

  async pendingCards(agentId: string, clientKey?: string): Promise<RegisterCardRow[]> {
    const rows = await this.db.actionCard.findMany({
      where: {
        kind: APP_REGISTER_CARD_KIND,
        preparedByAgentId: agentId,
        state: "pending",
        ...(clientKey === undefined ? {} : { payload: { path: ["key"], equals: clientKey } }),
      },
      select: CARD,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(card);
  }

  async card(agentId: string, messageId: string) {
    const row = await this.db.actionCard.findFirst({
      where: { kind: APP_REGISTER_CARD_KIND, preparedByAgentId: agentId, messageId },
      select: CARD,
    });
    return row ? card(row) : undefined;
  }

  /** The Agent becomes the app's owner, unless it is archived or the app already has one. */
  async assign(key: string, agentId: string) {
    const live = await this.db.agent.findFirst({
      where: { id: agentId, deletedAt: null },
      select: { id: true },
    });
    if (!live) return false;
    const updated = await this.db.app.updateMany({
      where: { key, ownerAgentId: null },
      data: { ownerAgentId: agentId },
    });
    return updated.count === 1;
  }

  async rotate(key: string, workspaceId: string, clientSecretHash: string, at: Date) {
    const updated = await this.db.app.updateMany({
      where: { key, ownerWorkspaceId: workspaceId },
      data: { clientSecretHash, secretRotatedAt: at },
    });
    return updated.count === 1;
  }
}

/** A row as the manager sees it: `apps_publish_status_check` admits only the five statuses. */
function withStatus<Row extends { publishStatus: string }>(
  row: Row,
): Omit<Row, "publishStatus"> & { publishStatus: AppPublishStatus } {
  return { ...row, publishStatus: row.publishStatus as AppPublishStatus };
}

function card(row: {
  messageId: string;
  state: string;
  payload: Prisma.JsonValue;
  result: Prisma.JsonValue;
  committedByUser: { displayName: string | null; username: string } | null;
}): RegisterCardRow {
  const payload = row.payload as unknown as ResolvedAppRegisterPayload;
  const result = row.result as { clientKey?: string } | null;
  return {
    messageId: row.messageId,
    state: row.state as RegisterCardRow["state"],
    name: payload.name,
    clientKey: result?.clientKey ?? (payload.key || null),
    committedBy: row.committedByUser?.displayName?.trim() || row.committedByUser?.username,
  };
}
