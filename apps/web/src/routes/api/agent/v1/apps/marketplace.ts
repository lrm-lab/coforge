import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  AGENT_APP_MARKETPLACE_LIMIT_DEFAULT,
  AGENT_APP_MARKETPLACE_LIMIT_MAX,
  AGENT_APP_MARKETPLACE_QUERY_MAX,
  type AgentAppMarketplaceResponse,
} from "@lrm/coforge-sdk/agent";
import { toMarketplaceAppInfo } from "#src/features/apps/marketplace-app.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import {
  agentAppRefusal,
  agentAppServiceRefusal,
} from "#src/server/agents/agent-app-refusals.server";
import type { AppInstallations } from "#src/server/app-marketplace/app-installations.server";
import { createAppInstallations } from "#src/server/app-marketplace/app-installations-composition.server";

const searchSchema = z.object({
  query: z
    .string()
    .trim()
    .max(AGENT_APP_MARKETPLACE_QUERY_MAX)
    // PostgreSQL text cannot hold NUL; no control character belongs in a search.
    .regex(/^\P{Cc}*$/u)
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AGENT_APP_MARKETPLACE_LIMIT_MAX)
    .default(AGENT_APP_MARKETPLACE_LIMIT_DEFAULT),
});

/** `GET /api/agent/v1/apps/marketplace` (`coforge app marketplace`): the apps other Workspaces
 * published, as a member of the calling Agent's Workspace sees them, browsed with the Agent's
 * own identity. Read only. */
export async function handleAgentAppMarketplace(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  installations: Pick<AppInstallations, "browseForAgent">,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = searchSchema.safeParse({
    query: params.get("query") ?? undefined,
    limit: params.get("limit") || undefined,
  });
  if (!parsed.success)
    return agentAppRefusal(
      "invalid_input",
      `query is at most ${AGENT_APP_MARKETPLACE_QUERY_MAX} characters and limit a whole number from 1 to ${AGENT_APP_MARKETPLACE_LIMIT_MAX}.`,
    );
  const query = parsed.data.query || null;
  const { limit } = parsed.data;
  try {
    const { listings, truncated } = await installations.browseForAgent(
      { workspaceId: principal.workspaceId, agentId: principal.agentId },
      { query, limit },
    );
    const body: AgentAppMarketplaceResponse = {
      surface: "public_marketplace",
      metadataTrust: "untrusted_app_supplied",
      query,
      limit,
      truncated,
      apps: listings.map(({ installed, ...listing }) => {
        // The declaration revision is what an install sends back; an Agent installs nothing.
        const { permissionRevision: _revision, ...app } = toMarketplaceAppInfo(listing);
        return { ...app, installed };
      }),
    };
    return Response.json(body);
  } catch (error) {
    return agentAppServiceRefusal(error);
  }
}

export const Route = createFileRoute("/api/agent/v1/apps/marketplace")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ request, context: { principal, db } }) =>
        handleAgentAppMarketplace(request, principal, createAppInstallations(db)),
    },
  },
});
