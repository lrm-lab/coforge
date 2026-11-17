import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { settlePendingNotLaunched } from "#src/server/db/repositories/mention-delivery.repositories.server";
import { revokeExternalCredentialsOf } from "#src/server/db/repositories/external-agent-credential.repositories.server";
import { externalAgentManagerAccess } from "./external-agent-access.server";
import { syncExternalPresenceBestEffort } from "./external-agent-presence-publish.server";
import { auditExternalCredential } from "./external-agent-credentials.server";

export type ExternalAgentControlAction =
  | "start"
  | "stop"
  | "restart"
  | "reset-session"
  | "full-reset";

export async function handleExternalAgentControl(
  db: PrismaClient,
  input: {
    userId: string;
    workspaceId: string;
    agentId: string;
    action: ExternalAgentControlAction;
  },
  now: () => Date = () => new Date(),
  syncPresence: typeof syncExternalPresenceBestEffort = syncExternalPresenceBestEffort,
): Promise<boolean> {
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId },
    select: { hosting: true },
  });
  if (agent?.hosting !== "external") return false;
  const access = await externalAgentManagerAccess(db, input);
  if (!access.ok || access.agent.deletedAt) throw new AppError("NOT_FOUND");
  const stopped = Boolean(access.agent.stoppedAt);
  if (input.action === "stop" && !stopped) {
    const at = now();
    const revoked = await db.$transaction(async (tx) => {
      await tx.agent.update({ where: { id: input.agentId }, data: { stoppedAt: at } });
      await settlePendingNotLaunched(tx, {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        settledAt: at,
      });
      return revokeExternalCredentialsOf(tx, input.agentId, "agent_stopped", at);
    });
    if (revoked.count > 0)
      auditExternalCredential("credentials_revoked", {
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        reason: "agent_stopped",
        count: revoked.count,
        actorUserId: input.userId,
      });
    await syncPresence(db, input);
    return true;
  }
  if (input.action === "stop" || (input.action === "start" && stopped)) {
    if (input.action === "start")
      await db.agent.update({ where: { id: input.agentId }, data: { stoppedAt: null } });
    return true;
  }
  throw new AppError("INVALID_INPUT", { errorId: "agent-external-no-runtime" });
}
