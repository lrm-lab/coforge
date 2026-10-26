import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
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
    /** Whether the member closed the checklist in this Workspace; then no step is read. */
    dismissed: boolean;
    steps: SetupStep[];
    /** Which GitHub flow the connect step starts. */
    githubStatus: GitHubSetupStatus;
  }> {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: {
        role: true,
        preferences: { select: { setupChecklistDismissedAt: true } },
      },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
    if (membership.preferences?.setupChecklistDismissedAt)
      return {
        dismissed: true,
        steps: [],
        githubStatus: "disconnected",
      };
    const [github, agent, computer] = await Promise.all([
      this.github(userId),
      roleCan(membership.role, "createAgents") ? this.hasOwnAgent(workspaceId, userId) : undefined,
      this.hasLocalComputer(userId),
    ]);
    const steps: SetupStep[] = [];
    if (github !== "unconfigured") steps.push({ id: "github", done: github === "connected" });
    if (agent !== undefined) steps.push({ id: "agent", done: agent });
    steps.push({ id: "computer", done: computer });
    return {
      dismissed: false,
      steps,
      githubStatus: github,
    };
  }

  /** Closes the checklist for this member in this Workspace, on every device. Closing it again
   * keeps the first time. */
  async dismiss(workspaceId: string, userId: string): Promise<void> {
    const where = { workspaceId_userId: { workspaceId, userId } };
    const membership = await this.db.workspaceMembership.findUnique({
      where,
      select: { userId: true },
    });
    if (!membership) throw new AppError("ACCESS_DENIED");
    const now = new Date();
    await this.db.workspaceMemberPreference.upsert({
      where,
      create: { workspaceId, userId, setupChecklistDismissedAt: now },
      update: {},
    });
    // The upsert may have found a row that never closed it; only a null becomes the time.
    await this.db.workspaceMemberPreference.updateMany({
      where: { workspaceId, userId, setupChecklistDismissedAt: null },
      data: { setupChecklistDismissedAt: now },
    });
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

  private async hasLocalComputer(userId: string) {
    const computer = await this.db.computer.findFirst({
      where: { ownerId: userId, kind: "local", deletedAt: null },
      select: { id: true },
    });
    return computer !== null;
  }
}
