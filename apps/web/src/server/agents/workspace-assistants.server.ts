import { Prisma, type PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import {
  defaultCloudComputerId,
  startDefaultCloudComputer,
} from "#src/server/workspaces/create-workspace.server";
import { paginated } from "#src/server/db/pagination.server";
import { AGENT_DISPLAY_NAME_MAX_LENGTH } from "#src/features/agents/agent.schemas";
import { isUserLanguage } from "#src/server/db/repositories/user-preferences.repositories.server";
import { humanLabel, type HumanNames } from "#src/lib/human-label";
import type { Locale } from "#src/paraglide/runtime";
import {
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";

/** `{name}的助手` / `{name}'s Assistant`, with the owner's name cut to fit an Agent's display name.
 * Without a locale (no request to read one from) it is Chinese. */
function personalAssistantName(owner: Pick<HumanNames, "displayName">, locale: Locale = "zh-CN") {
  const suffix = locale === "zh-CN" ? "的助手" : "'s Assistant";
  let name = "";
  for (const character of humanLabel(owner)) {
    if (name.length + character.length > AGENT_DISPLAY_NAME_MAX_LENGTH - suffix.length) break;
    name += character;
  }
  return `${name}${suffix}`;
}

export const WORKSPACE_ASSISTANT_DESCRIPTION =
  "CoForge 平台通用助手：解答平台功能，协助消息、频道、任务、提醒、项目、周报及计算机操作。会话和记忆仅属于当前用户，操作遵循当前用户权限。";

const DEFAULT_RUNTIME = {
  runtime: "pi",
  provider: { kind: "default" },
  model: "",
  modelProvider: "",
  reasoning: "",
};

/**
 * The assistants that have never run: no control state and no session. The one definition of
 * "never run", for the write that re-binds such an assistant and for any read that asks.
 */
export const NEVER_RAN = {
  controlState: { equals: Prisma.DbNull },
  currentSessionId: null,
} satisfies Prisma.AgentWhereInput;

/** Workspace-wide configuration, with a private execution identity for each member. Reuses the
 * ordinary lifecycle so a member's credentials, native history and files all have one owner. */
export class WorkspaceAssistants {
  constructor(private readonly db: PrismaClient) {}

  /** The assistant this call makes is named in the owner's saved interface language, else the
   * request's `locale`, else Chinese. */
  async ensure(workspaceId: string, userId: string, options: { locale?: Locale } = {}) {
    const { session, created } = await this.ensureSession(workspaceId, userId, options);
    const conversation = await new DirectConversations(this.db).open(workspaceId, userId, {
      agentId: session.agentId,
    });
    return { agentId: session.agentId, conversationId: conversation.conversationId, created };
  }

  private async ensureSession(
    workspaceId: string,
    userId: string,
    { locale }: { locale?: Locale },
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
        const owner = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { displayName: true, preferences: { select: { language: true } } },
        });
        const saved = owner.preferences?.language;
        await tx.workspaceAssistant.upsert({
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
                displayName: personalAssistantName(owner, isUserLanguage(saved) ? saved : locale),
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

  /** Throws ACCESS_DENIED unless the member owns this Computer and it is connected to the Workspace. */
  async #requireOwnedComputer(workspaceId: string, userId: string, computerId: string) {
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
  }

  /** Only binds unconfigured sessions, never migrates an existing native history. */
  async bindComputer(workspaceId: string, userId: string, computerId: string) {
    await this.#requireOwnedComputer(workspaceId, userId, computerId);
    const session = await this.ensure(workspaceId, userId);
    await this.db.agent.updateMany({
      where: { id: session.agentId, workspaceId, ownerId: userId, computerId: null },
      data: { computerId },
    });
    return session;
  }

  /**
   * Re-binds the member's assistant to one of their own Computers with a runtime of their choice,
   * without a migration: this is allowed only while it has never run (`NEVER_RAN`), so there is no
   * native history to carry. The Agent's encrypted environment is kept, as `ManageAgents.update`
   * keeps it. `canRun` is asked only when the write would change something; it answers whether
   * the Computer can run that runtime for the member. Nothing is started here.
   */
  async configure(
    workspaceId: string,
    userId: string,
    input: { computerId: string; runtimeConfig: Omit<AgentRuntimeConfig, "environment"> },
    canRun: () => Promise<boolean>,
  ): Promise<void> {
    await this.#requireOwnedComputer(workspaceId, userId, input.computerId);
    const { agentId } = await this.ensure(workspaceId, userId);
    // The reads and `canRun` (which reads more) happen before the lock; the lock covers only the
    // re-read of the environment and the conditional write, whose `NEVER_RAN` guard decides.
    const current = await this.db.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { computerId: true, runtimeConfig: true },
    });
    const withEnvironment = (stored: unknown) => {
      const { environment } = parseAgentRuntimeConfig(stored);
      return { ...input.runtimeConfig, ...(environment ? { environment } : {}) };
    };
    // What first sign-in already provisioned (Pi on the default cloud computer) is no write.
    if (
      current.computerId === input.computerId &&
      JSON.stringify(parseAgentRuntimeConfig(current.runtimeConfig)) ===
        JSON.stringify(withEnvironment(current.runtimeConfig))
    )
      return;
    if (!(await canRun()))
      throw new AppError("INVALID_INPUT", { errorId: "agent-runtime-unavailable" });
    await getAgentRuntimeLock().run(agentId, async () => {
      const latest = await this.db.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { runtimeConfig: true },
      });
      // One conditional write: it only lands while nothing has started the assistant.
      const written = await this.db.agent.updateMany({
        where: {
          id: agentId,
          workspaceId,
          ownerId: userId,
          systemKind: WORKSPACE_ASSISTANT_KIND,
          deletedAt: null,
          ...NEVER_RAN,
        },
        data: {
          computerId: input.computerId,
          runtimeConfig: withEnvironment(latest.runtimeConfig),
        },
      });
      if (written.count === 0)
        throw new AppError("INVALID_INPUT", { errorId: "workspace-assistant-already-started" });
    });
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
