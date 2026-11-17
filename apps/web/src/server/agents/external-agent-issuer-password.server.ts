import type { PrismaClient } from "#src/generated/prisma/client";
import type { CodeDestination } from "#src/features/auth/code-destination";
import { codeDestinationKey } from "#src/features/auth/code-destination";
import { auditExternalCredential } from "./external-agent-credentials.server";
import { syncExternalPresenceBestEffort } from "./external-agent-presence-publish.server";

type Db = Pick<PrismaClient, "user" | "externalAgentCredential" | "agent" | "$queryRaw">;

export async function revokeCredentialsOfResetPassword(
  db: Db,
  destination: CodeDestination,
  now: () => Date = () => new Date(),
): Promise<number> {
  const users = await db.user.findMany({
    where:
      destination.kind === "email"
        ? { email: { equals: destination.email, mode: "insensitive" } }
        : { phone: codeDestinationKey(destination) },
    select: { id: true },
  });
  if (users.length === 0) return 0;
  const revoked = await db.externalAgentCredential.updateManyAndReturn({
    where: { approvedByUserId: { in: users.map((user) => user.id) }, revokedAt: null },
    data: { revokedAt: now(), revokedReason: "issuer_password_reset" },
    select: { id: true, agentId: true, workspaceId: true },
  });
  for (const credential of revoked)
    auditExternalCredential("credential_revoked", {
      credentialId: credential.id,
      agentId: credential.agentId,
      workspaceId: credential.workspaceId,
      reason: "issuer_password_reset",
    });
  const agents = new Map(revoked.map((row) => [row.agentId, row.workspaceId]));
  for (const [agentId, workspaceId] of agents)
    await syncExternalPresenceBestEffort(db, { workspaceId, agentId });
  return revoked.length;
}
