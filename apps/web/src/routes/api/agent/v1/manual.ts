import { createFileRoute } from "@tanstack/react-router";
import { isPrincipalOnCloudComputer } from "#src/server/agents/agent-cloud-computer.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { PrismaAgentManualEventRepository } from "#src/server/db/repositories/agent-manual-event.repositories.server";
import {
  recordManualEvent,
  resolveManualGet,
  type AgentManualEventRepository,
} from "#src/server/agents/agent-manual.server";
import type { AgentManualExperiments } from "#src/server/agents/manual/manual-registry.server";

export type AgentManualGetPrincipal = { workspaceId: string; agentId: string };

export async function handleAgentManualGet(
  request: Request,
  principal: AgentManualGetPrincipal,
  repository: AgentManualEventRepository | undefined,
  experiments?: AgentManualExperiments,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const topic = query.get("topic") ?? "";
  const intent = (query.get("intent") ?? "").trim();
  const reason = (query.get("reason") ?? "").trim();
  const outcome = resolveManualGet({ topic, intent, reason, experiments });
  if (outcome.status !== 400)
    await recordManualEvent(
      repository,
      principal,
      {
        kind: "get",
        topicOrQuery: topic,
        intent,
        reason,
        outcome: outcome.recordOutcome,
        resultSlugs: outcome.status === 200 ? outcome.resultSlugs : [],
      },
      (error) => console.error("agent manual event logging failed", error),
    );
  return Response.json(outcome.body, { status: outcome.status });
}

export const Route = createFileRoute("/api/agent/v1/manual")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ request, context: { principal, db } }) => {
        const needsCloudCheck = new URL(request.url).searchParams.get("topic") === "action-cards";
        return handleAgentManualGet(
          request,
          principal,
          new PrismaAgentManualEventRepository(db),
          needsCloudCheck
            ? { cloudDesktop: await isPrincipalOnCloudComputer(db, principal) }
            : undefined,
        );
      },
    },
  },
});
