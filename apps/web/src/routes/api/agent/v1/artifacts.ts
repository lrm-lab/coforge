import { decodeAgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { createFileRoute } from "@tanstack/react-router";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  agentAuthMiddleware,
  agentErrorResponse,
} from "#src/server/agents/agent-http-middleware.server";
import {
  runAgentArtifactOperation,
  type AgentArtifactServices,
} from "#src/server/artifacts/agent-artifacts.server";
import { artifactsEnabled } from "#src/server/artifacts/artifact-access.server";
import {
  productionArtifactShares,
  productionArtifacts,
} from "#src/server/artifacts/artifact-composition.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { agentMessagesPostDependencies } from "./messages";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { dmParentTarget } from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import { parsePeerTarget } from "#src/server/db/repositories/agent-peer-target.server";

/**
 * `coforge artifact create|read|push|history|revert` (task #385): one operation per request, as
 * JSON. A body that is not one known operation with exactly its own fields is `INVALID_INPUT`, so
 * a save's internal options can never be sent; every refusal is the Agent API's (`code`, and the
 * `errorId` in `error`).
 */
export async function handleAgentArtifactPost(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  services: AgentArtifactServices,
): Promise<Response> {
  try {
    const body = decodeAgentArtifactRequest(await request.json().catch(() => null));
    if (!body) throw new AppError("INVALID_INPUT", { errorId: "artifact-request" });
    return Response.json(await runAgentArtifactOperation(services, principal, body));
  } catch (error) {
    return agentErrorResponse(error);
  }
}

async function resolveArtifactShareTarget(
  db: PrismaClient,
  repository: ReturnType<typeof agentMessagesPostDependencies>["repository"],
  workspaceId: string,
  agentId: string,
  target: string,
) {
  const resolved = await repository.resolveAgentSendTarget(workspaceId, agentId, target);
  if (resolved.isChannel || resolved.isUserAgentDirectConversation !== false)
    return { kind: "other" as const };
  const { name, kind } = parsePeerTarget(dmParentTarget(target));
  if (kind === "human") return { kind: "other" as const };
  const agent = await db.agent.findFirst({
    where: { workspaceId, name, ...ACTIVE_AGENT_WHERE },
    select: { id: true },
  });
  return agent ? { kind: "agent" as const, agentId: agent.id } : { kind: "other" as const };
}

export const Route = createFileRoute("/api/agent/v1/artifacts")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) => {
        const messageDependencies = agentMessagesPostDependencies(db);
        return handleAgentArtifactPost(request, principal, {
          db,
          ...productionArtifacts(db),
          shares: productionArtifactShares(
            db,
            (workspaceId) => artifactsEnabled(db, workspaceId),
            (workspaceId, agentId, target) =>
              resolveArtifactShareTarget(
                db,
                messageDependencies.repository,
                workspaceId,
                agentId,
                target,
              ),
          ),
          send: ({ target, idempotencyKey, body }) =>
            messageDependencies.sender.executeFromAgent({
              workspaceId: principal.workspaceId,
              agentId: principal.agentId,
              target,
              idempotencyKey,
              body,
            }),
          enabled: (workspaceId) => artifactsEnabled(db, workspaceId),
          webPages: (workspaceId) => isFeatureEnabled("artifact-web-pages", { workspaceId }),
        });
      },
    },
  },
});
