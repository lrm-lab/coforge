import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import {
  WORKSPACE_ONBOARDING_MODES,
  type WorkspaceOnboardingMode,
  type WorkspaceOnboardingSettings,
} from "#src/features/workspaces/onboarding-mode";
import { canManageWorkspaceSettings } from "#src/features/workspaces/workspace-roles";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";

/**
 * The Agents a Workspace may pick to welcome its new members: live, ordinary (no platform
 * assistant, app bot, Memory or weekly-report Agent) and public, so every member can message it.
 */
export function onboardingAgentWhere(workspaceId: string): Prisma.AgentWhereInput {
  return {
    workspaceId,
    ...ACTIVE_AGENT_WHERE,
    systemKind: null,
    visibility: AGENT_VISIBILITY.PUBLIC,
    workspaceMemoryAgent: null,
    weeklyReportAssistant: null,
    weeklyReportCollectorBinding: null,
  };
}

/** The Workspace's onboarding settings; null unless `actorRole` manages Workspace settings. */
export async function loadWorkspaceOnboarding(
  db: Pick<PrismaClient, "workspace" | "agent">,
  input: { workspaceId: string; actorRole: string | undefined },
): Promise<WorkspaceOnboardingSettings | null> {
  if (!canManageWorkspaceSettings(input.actorRole)) return null;
  const [workspace, agents] = await Promise.all([
    db.workspace.findUniqueOrThrow({
      where: { id: input.workspaceId },
      select: { onboardingMode: true, onboardingAgentId: true, newAgentGreeting: true },
    }),
    db.agent.findMany({
      where: onboardingAgentWhere(input.workspaceId),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, name: true, avatarMascot: true },
    }),
  ]);
  return {
    mode: onboardingMode(workspace.onboardingMode),
    agentId: workspace.onboardingAgentId,
    newAgentGreeting: workspace.newAgentGreeting,
    agents: agents.map(({ id, name, avatarMascot }) => ({
      id,
      name,
      avatarUrl: agentAvatarUrl(id, avatarMascot),
    })),
  };
}

/**
 * Saves the settings (owner or admin only) and returns them as `loadWorkspaceOnboarding` reads
 * them. `agent` mode needs an eligible Agent and the other modes none (`INVALID_INPUT`), as the
 * table's check constraint holds too.
 */
export async function saveWorkspaceOnboarding(
  db: PrismaClient,
  input: {
    workspaceId: string;
    actorRole: string | undefined;
    mode: WorkspaceOnboardingMode;
    agentId: string | null;
    newAgentGreeting: boolean;
  },
): Promise<WorkspaceOnboardingSettings> {
  if (!canManageWorkspaceSettings(input.actorRole)) throw new AppError("ACCESS_DENIED");
  const { workspaceId, mode, agentId, newAgentGreeting } = input;
  if (!WORKSPACE_ONBOARDING_MODES.includes(mode) || (mode === "agent") !== (agentId !== null))
    throw new AppError("INVALID_INPUT");
  await db.$transaction(async (tx) => {
    if (agentId) {
      // Agent first, then Workspace: the order an archive or a visibility change takes, which
      // clear the selection of an Agent they make ineligible. The share lock holds either off
      // until this commits, and the eligibility read below is the one that follows it.
      await tx.$queryRaw`SELECT "id" FROM "agents" WHERE "id" = ${agentId}::uuid FOR SHARE`;
      const eligible = await tx.agent.findFirst({
        where: { ...onboardingAgentWhere(workspaceId), id: agentId },
        select: { id: true },
      });
      if (!eligible) throw new AppError("INVALID_INPUT");
    }
    await tx.workspace.update({
      where: { id: workspaceId },
      data: { onboardingMode: mode, onboardingAgentId: agentId, newAgentGreeting },
    });
  });
  return (await loadWorkspaceOnboarding(db, { workspaceId, actorRole: input.actorRole }))!;
}

/**
 * An Agent that can no longer welcome members (archived, made private) stops being the
 * Workspace's chosen one: the Workspace falls back to the platform assistant's welcome. Runs in
 * the transaction that changes the Agent, after it updated the Agent's row.
 */
export function clearOnboardingAgent(
  tx: Pick<Prisma.TransactionClient, "workspace">,
  workspaceId: string,
  agentId: string,
) {
  return tx.workspace.updateMany({
    where: { id: workspaceId, onboardingAgentId: agentId },
    data: { onboardingMode: "assistant", onboardingAgentId: null },
  });
}

/** The stored mode; `workspaces_onboarding_mode_check` keeps the column to these values. */
function onboardingMode(value: string): WorkspaceOnboardingMode {
  return WORKSPACE_ONBOARDING_MODES.find((mode) => mode === value) ?? "assistant";
}
