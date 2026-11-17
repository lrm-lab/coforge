import type { PrismaClient } from "#src/generated/prisma/client";
import { encodeAgentActivity } from "@lrm/coforge-sdk/internal";
import { agentActivityChannelFor } from "#src/features/agents/agent-activity";
import { AgentActivityRepository } from "#src/server/db/repositories/agent-activity.repositories.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { errorResponse } from "./agent-http-error.server";
import { getAgentDisplay } from "./agent-display.server";
import {
  type ExternalActivityPorts,
  type ExternalActivityRow,
  ingestExternalActivity,
} from "./external-agent-activity.server";
import { parseExternalActivityIngest } from "./external-agent-activity-ingest.server";
import { claimExternalEventIds, releaseExternalEventIds } from "./external-agent-event-ids.server";
import { isExternalAgentPrincipal } from "./external-agent-credentials.server";
import {
  externalCentrifugo,
  productionExternalDisplayPorts,
  publishExternalDisplay,
} from "./external-agent-presence-publish.server";
import { externalAgentsOnly } from "./external-agent-http.server";

let eventIdRedis: ReturnType<typeof openRedisClient> | undefined;

export function productionExternalActivityPorts(db: PrismaClient): ExternalActivityPorts {
  eventIdRedis ??= openRedisClient(redisUrlFor("external Agent activity"));
  const redis = eventIdRedis;
  const display = productionExternalDisplayPorts(db);
  return {
    claimEventIds: (agent, ids) => claimExternalEventIds(redis, agent, ids),
    releaseEventIds: (agent, ids) => releaseExternalEventIds(redis, agent, ids),
    display: getAgentDisplay(),
    statusReported: {
      isSet: async (agentId) =>
        Boolean(
          (
            await db.agent.findUnique({
              where: { id: agentId },
              select: { externalStatusReportedAt: true },
            })
          )?.externalStatusReportedAt,
        ),
      set: async (agentId, at) => {
        await db.agent.updateMany({
          where: { id: agentId, externalStatusReportedAt: null },
          data: { externalStatusReportedAt: at },
        });
      },
    },
    record: (rows) => new AgentActivityRepository(db).recordMany(rows),
    publishDisplay: (snapshot) => publishExternalDisplay(display, snapshot),
    publishActivity: async (rows: readonly ExternalActivityRow[]) => {
      const [first] = rows;
      if (!first) return;
      const visibility = await display.visibility(first.workspaceId, first.agentId);
      if (visibility === undefined) return;
      const channel = agentActivityChannelFor(first.workspaceId, first.agentId, visibility);
      await externalCentrifugo().publishBatch(
        rows.map(({ computerId: _computer, ...frame }) => ({
          channel,
          data: encodeAgentActivity(frame),
        })),
      );
    },
  };
}

export async function handleExternalActivityPost(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  ports: () => ExternalActivityPorts,
  now: () => number = Date.now,
): Promise<Response> {
  if (!isExternalAgentPrincipal(principal)) return externalAgentsOnly();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_request", "the body must be JSON", 400, false);
  }
  const received = now();
  const parsed = parseExternalActivityIngest(body, received);
  if (!parsed.ok)
    return errorResponse(
      parsed.code,
      `the activity request is invalid (${parsed.code})`,
      400,
      false,
    );
  return Response.json(await ingestExternalActivity(ports(), principal, parsed.events, received));
}
