import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { AppError } from "#src/lib/app-error";
import { externalAgentManagerAccess } from "#src/server/agents/external-agent-access.server";
import {
  listExternalCredentials,
  revokeAllExternalCredentials,
  revokeOneExternalCredential,
} from "#src/server/agents/external-agent-credentials.server";
import { PrismaExternalAgentCredentialRepository } from "#src/server/db/repositories/external-agent-credential.repositories.server";
import { agentIdInputSchema, agentIdSchema } from "./agent.schemas";

const credentialIdInputSchema = z.object({ agentId: agentIdSchema, credentialId: z.uuid() });

async function managedExternalAgent(
  db: Parameters<typeof externalAgentManagerAccess>[0],
  input: { userId: string; workspaceId: string; agentId: string },
) {
  const access = await externalAgentManagerAccess(db, input);
  if (!access.ok || access.agent.deletedAt || access.agent.hosting !== "external")
    throw new AppError("NOT_FOUND");
}

export const listExternalAgentCredentials = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    declareNoStore();
    await managedExternalAgent(db, { userId: user.id, workspaceId, agentId: data.agentId });
    return listExternalCredentials(new PrismaExternalAgentCredentialRepository(db), data.agentId);
  });

export const revokeAllExternalAgentCredentials = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(agentIdInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    await managedExternalAgent(db, { userId: user.id, workspaceId, agentId: data.agentId });
    const revoked = await revokeAllExternalCredentials(
      new PrismaExternalAgentCredentialRepository(db),
      { agentId: data.agentId, workspaceId, reason: "revoke_all", actorUserId: user.id },
    );
    return { revoked };
  });

export const revokeExternalAgentCredential = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(credentialIdInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    await managedExternalAgent(db, { userId: user.id, workspaceId, agentId: data.agentId });
    const revoked = await revokeOneExternalCredential(
      new PrismaExternalAgentCredentialRepository(db),
      {
        credentialId: data.credentialId,
        agentId: data.agentId,
        workspaceId,
        actorUserId: user.id,
      },
    );
    return { revoked };
  });
