import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import type { SetupStep } from "#src/features/onboarding/setup-steps";
import { roleCan } from "#src/features/workspaces/workspace-roles";

/** A User's GitHub connection as the checklist needs it: `unconfigured` is a deployment without
 * GitHub, the rest are `GitHubConnection.overview` statuses. */
export type GitHubSetupStatus =
  | "unconfigured"
  | "disconnected"
  | "pending_installation"
  | "reauthorize"
  | "connected";

type SetupChecklistPorts = {
  /** The stored GitHub connection status; never a live call to GitHub. */
  githubStatus(userId: string): Promise<GitHubSetupStatus>;
};

/**
 * What a Workspace member has done of the setup steps, worked out from rows that already exist, so
 * nothing stores progress. A step the deployment or the member's role cannot do is left out, and
 * the card counts only what is listed.
 */
export class SetupChecklist {
  constructor(
    private readonly db: PrismaClient,
    private readonly ports: SetupChecklistPorts,
  ) {}

  async read(
    workspaceId: string,
    userId: string,
  ): Promise<{
    steps: SetupStep[];
    /** The viewer's DM with their Workspace assistant, once it exists: where "say hi" goes. */
    assistantConversationId: string | null;
    /** Which GitHub flow the connect step starts. */
    githubStatus: GitHubSetupStatus;
  }> {
    // Everything that does not depend on the role starts together with the role lookup.
    const [membership, [assistant, github, task, computer]] = await Promise.all([
      this.db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { role: true },
      }),
      Promise.all([
        this.assistant(workspaceId, userId),
        this.github(userId),
        this.hasAgentTask(workspaceId, userId),
        this.hasLocalComputer(userId),
      ]),
    ]);
    if (!membership) throw new AppError("ACCESS_DENIED");
    const [agent, invite] = await Promise.all([
      roleCan(membership.role, "createAgents") ? this.hasOwnAgent(workspaceId, userId) : undefined,
      roleCan(membership.role, "manageMembers") ? this.hasTeammate(workspaceId) : undefined,
    ]);
    const steps: SetupStep[] = [{ id: "assistant", done: assistant.sentHi }];
    if (github !== "unconfigured") steps.push({ id: "github", done: github === "connected" });
    if (agent !== undefined) steps.push({ id: "agent", done: agent });
    steps.push({ id: "task", done: task }, { id: "computer", done: computer });
    if (invite !== undefined) steps.push({ id: "invite", done: invite });
    return { steps, assistantConversationId: assistant.conversationId, githubStatus: github };
  }

  /** The viewer's DM with their Workspace assistant and whether they have written in it. Looked up
   * by its exact direct key, which the `(workspaceId, directKey)` unique index serves. */
  private async assistant(workspaceId: string, userId: string) {
    const session = await this.db.workspaceAssistantSession.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { agentId: true },
    });
    if (!session) return { sentHi: false, conversationId: null };
    const conversation = await this.db.conversation.findUnique({
      where: {
        workspaceId_directKey: { workspaceId, directKey: agentDirectKey(userId, session.agentId) },
      },
      select: {
        id: true,
        messages: { where: { sender: { userId } }, select: { id: true }, take: 1 },
      },
    });
    return {
      sentHi: (conversation?.messages.length ?? 0) > 0,
      conversationId: conversation?.id ?? null,
    };
  }

  private async github(userId: string): Promise<GitHubSetupStatus> {
    // Setup is a hint: a lookup that fails must not take the whole card down.
    return this.ports.githubStatus(userId).catch(() => "disconnected");
  }

  private async hasOwnAgent(workspaceId: string, userId: string) {
    const agent = await this.db.agent.findFirst({
      where: { workspaceId, ownerId: userId, systemKind: null, deletedAt: null },
      select: { id: true },
    });
    return agent !== null;
  }

  private async hasAgentTask(workspaceId: string, userId: string) {
    const task = await this.db.task.findFirst({
      where: {
        workspaceId,
        creator: { userId },
        owner: { agentId: { not: null } },
      },
      select: { messageId: true },
    });
    return task !== null;
  }

  private async hasLocalComputer(userId: string) {
    const computer = await this.db.computer.findFirst({
      where: { ownerId: userId, kind: "local", deletedAt: null },
      select: { id: true },
    });
    return computer !== null;
  }

  private async hasTeammate(workspaceId: string) {
    return (await this.db.workspaceMembership.count({ where: { workspaceId }, take: 2 })) > 1;
  }
}
