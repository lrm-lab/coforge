import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import {
  defaultCloudComputerId,
  startDefaultCloudComputer,
} from "#src/server/workspaces/create-workspace.server";
import { paginated } from "#src/server/db/pagination.server";

export const WORKSPACE_ASSISTANT_DESCRIPTION =
  "CoForge 平台通用助手：解答平台功能，协助消息、频道、任务、提醒、项目、周报及计算机操作。会话和记忆仅属于当前用户，操作遵循当前用户权限。";

const DEFAULT_RUNTIME = {
  runtime: "pi",
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};

/** Workspace-wide configuration, with a private execution identity for each member. Reuses the
 * ordinary lifecycle so a member's credentials, native history and files all have one owner. */
export class WorkspaceAssistants {
  constructor(private readonly db: PrismaClient) {}

  async ensure(workspaceId: string, userId: string) {
    const { session, created } = await this.ensureSession(workspaceId, userId);
    const conversation = await new DirectConversations(this.db).open(workspaceId, userId, {
      agentId: session.agentId,
    });
    return { agentId: session.agentId, conversationId: conversation.conversationId, created };
  }

  private async ensureSession(
    workspaceId: string,
    userId: string,
  ): Promise<{ session: { agentId: string }; created: boolean }> {
    // The steady state is a read: the shared row and the member's session already exist, and a
    // sidebar load must not write. Only a first open, or a session still waiting for its
    // computer, enters the transaction below (which re-reads everything it decides on).
    const [membership, existing] = await Promise.all([
      this.db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { role: true },
      }),
      this.db.workspaceAssistantSession.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        include: { agent: { select: { computerId: true } } },
      }),
    ]);
    if (!membership) throw new AppError("ACCESS_DENIED");
    if (existing?.agent.computerId) return { session: existing, created: false };
    if (existing) {
      // An unbound session rebinds with one conditional update — a compare-and-set that stays
      // outside the creation transaction so an absent computer keeps the read write-free.
      const computer = await this.db.computer.findFirst({
        where: {
          ownerId: userId,
          kind: "cloud",
          cloudSlot: "default",
          deletedAt: null,
          workspaces: { some: { workspaceId } },
        },
        orderBy: [{ kind: "asc" }, { cloudSlot: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (computer)
        await this.db.agent.updateMany({
          where: { id: existing.agentId, workspaceId, ownerId: userId, computerId: null },
          data: { computerId: computer.id },
        });
      return { session: existing, created: false };
    }
    try {
      let created = false;
      const session = await this.db.$transaction(async (tx) => {
        const membership = await tx.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId } },
          select: { role: true },
        });
        if (!membership) throw new AppError("ACCESS_DENIED");
        const existing = await tx.workspaceAssistantSession.findUnique({
          where: { workspaceId_userId: { workspaceId, userId } },
          include: { agent: { select: { computerId: true } } },
        });
        if (existing?.agent.computerId) return existing;
        const computer = await tx.computer.findFirst({
          where: {
            ownerId: userId,
            kind: "cloud",
            cloudSlot: "default",
            deletedAt: null,
            workspaces: { some: { workspaceId } },
          },
          orderBy: [{ kind: "asc" }, { cloudSlot: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        if (existing) {
          if (computer)
            await tx.agent.updateMany({
              where: { id: existing.agentId, workspaceId, ownerId: userId, computerId: null },
              data: { computerId: computer.id },
            });
          return existing;
        }
        const assistant = await tx.workspaceAssistant.upsert({
          where: { workspaceId },
          create: { workspaceId },
          update: { workspaceId },
        });
        created = true;
        return tx.workspaceAssistantSession.create({
          data: {
            assistant: { connect: { workspaceId } },
            user: { connect: { id: userId } },
            agent: {
              create: {
                workspaceId,
                ownerId: userId,
                name: `assistant-${crypto.randomUUID()}`,
                displayName: assistant.displayName,
                description: WORKSPACE_ASSISTANT_DESCRIPTION,
                systemKind: WORKSPACE_ASSISTANT_KIND,
                introductionDueAt: new Date(),
                visibility: "private",
                computerId: computer?.id,
                runtimeConfig: DEFAULT_RUNTIME,
              },
            },
          },
        });
      });
      return { session, created };
    } catch (error) {
      // Both the Agent and binding are rolled back for a losing first-open transaction.
      if (isUniqueViolation(error)) {
        const existing = await this.db.workspaceAssistantSession.findUnique({
          where: { workspaceId_userId: { workspaceId, userId } },
        });
        if (existing) return { session: existing, created: false };
      }
      throw error;
    }
  }

  /** Only binds unconfigured sessions, never migrates an existing native history. */
  async bindComputer(workspaceId: string, userId: string, computerId: string) {
    const computer = await this.db.computer.findFirst({
      where: {
        id: computerId,
        ownerId: userId,
        deletedAt: null,
        workspaces: { some: { workspaceId } },
      },
      select: { id: true },
    });
    if (!computer) throw new AppError("ACCESS_DENIED");
    const session = await this.ensure(workspaceId, userId);
    await this.db.agent.updateMany({
      where: { id: session.agentId, workspaceId, ownerId: userId, computerId: null },
      data: { computerId },
    });
    return session;
  }

  /**
   * Where a deployment with no cloud cluster runs the assistant: the oldest local Computer the user
   * added that is connected to this Workspace (a v7 id sorts by creation, so the choice never
   * flips between sends). Another member's Computer is never considered, an administrator's
   * included. An offline one still counts; the send says so as it does for any Agent.
   */
  async #ownComputerId(workspaceId: string, userId: string): Promise<string | undefined> {
    const computer = await this.db.computer.findFirst({
      where: {
        ownerId: userId,
        kind: "local",
        deletedAt: null,
        workspaces: { some: { workspaceId } },
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    return computer?.id;
  }

  /** Called only for an authorized browser send. Normal DMs never provision a Computer. */
  async prepareConversation(
    workspaceId: string,
    userId: string,
    conversationId: string,
    startCloudComputer: (input: {
      userId: string;
      workspaceId: string;
      now: Date;
    }) => Promise<unknown>,
  ): Promise<void> {
    const session = await this.db.workspaceAssistantSession.findFirst({
      where: { workspaceId, userId, agent: { conversations: { some: { conversationId } } } },
      select: { agentId: true },
    });
    if (!session) return;
    await this.ensure(workspaceId, userId);
    const agent = await this.db.agent.findUniqueOrThrow({
      where: { id: session.agentId },
      select: { computerId: true },
    });
    if (agent.computerId) return;
    const started = await startDefaultCloudComputer(startCloudComputer, {
      workspaceId,
      userId,
      now: new Date(),
    });
    const computerId =
      defaultCloudComputerId(started) ?? (await this.#ownComputerId(workspaceId, userId));
    if (!computerId)
      throw new AppError("TEMPORARILY_UNAVAILABLE", {
        errorId: "workspace-assistant-computer-required",
      });
    await this.bindComputer(workspaceId, userId, computerId);
  }
}

/** Deployment backfill; safe to repeat and bounded to one membership page at a time. */
export async function backfillWorkspaceAssistants(
  db: PrismaClient,
  provision?: (workspaceId: string, userId: string) => Promise<unknown>,
): Promise<{ provisioned: number }> {
  const assistants = new WorkspaceAssistants(db);
  let provisioned = 0;
  for (let page = 1; ; page++) {
    const [members, pagination] = await paginated(db)
      .workspaceMembership.paginate({
        select: { workspaceId: true, userId: true },
        orderBy: [{ workspaceId: "asc" }, { userId: "asc" }],
      })
      .withPages({ limit: 100, page });
    for (const member of members) {
      try {
        await (provision ?? ((workspaceId, userId) => assistants.ensure(workspaceId, userId)))(
          member.workspaceId,
          member.userId,
        );
        provisioned++;
      } catch (error) {
        if (!(error instanceof AppError && error.code === "ACCESS_DENIED")) throw error;
      }
    }
    if (pagination.isLastPage) return { provisioned };
  }
}
