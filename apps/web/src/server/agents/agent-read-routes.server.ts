import {
  AGENT_READ_PROTOCOL,
  agentReadPageRequestSchema,
  agentReadConfirmationSchema,
} from "@lrm/coforge-sdk/agent";
import { z } from "zod";
import { APP_EVENT_TARGET } from "#src/server/app-agent-events/app-event-target.server";
import { AppError } from "#src/lib/app-error";
import type { PrismaClient } from "#src/generated/prisma/client";
import { readSessionSecret } from "#src/server/auth/config.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { agentErrorResponse, noStore } from "./agent-http-middleware.server";
import { readAgentJsonBody } from "./agent-http-routes.server";
import type { AgentReadPrincipal } from "./agent-read-receipts.server";
import { AgentReads } from "./agent-reads.server";

function failure(error: unknown) {
  return agentErrorResponse(error instanceof z.ZodError ? new AppError("INVALID_INPUT") : error);
}

export async function handleAgentReadPage(
  request: Request,
  principal: AgentReadPrincipal,
  reads: AgentReads,
) {
  try {
    const { source, window, confirm } = agentReadPageRequestSchema.parse(
      await readAgentJsonBody(request),
    );
    const target = source.kind === "message" ? source.target : source.channel.replace(/^dm:/, "");
    if (!/^[#@]/.test(target) || APP_EVENT_TARGET.test(target.split(":", 1)[0]!))
      throw new AppError("INVALID_INPUT");
    return noStore(Response.json(await reads.page(principal, source, window, confirm)));
  } catch (error) {
    return failure(error);
  }
}

export async function handleAgentReadConfirm(
  request: Request,
  principal: AgentReadPrincipal,
  reads: AgentReads,
) {
  try {
    const input = agentReadConfirmationSchema.parse(await readAgentJsonBody(request));
    const confirmation = await reads.confirm(principal, input);
    return noStore(Response.json({ protocol: AGENT_READ_PROTOCOL, confirmation }));
  } catch (error) {
    return failure(error);
  }
}

export async function productionAgentReads(db: PrismaClient) {
  return new AgentReads(
    db,
    await readSessionSecret(Bun.env),
    Date.now,
    new CentrifugoConversationRealtime(createCentrifugoServerApi()),
  );
}
