import type { PrismaClient } from "#src/generated/prisma/client";
import { agentIdempotencyKeyFromQuery } from "#src/server/agents/agent-http-routes.server";
import { errorResponse } from "#src/server/agents/agent-http-error.server";
import { isAgentApiKeyShape } from "#src/server/agents/agent-api-key.server";
import type { AppBots } from "./app-bots.server";
import { AppBotInbox, AppBotInboxCursorError } from "./app-bot-inbox.server";
import { appBotCapability } from "./app-bot-capabilities.server";

export type AppBotAgentPrincipal = {
  /** Marks a bot's principal: a route that reads differently for a bot checks for it. */
  appBot: true;
  userId: string;
  workspaceId: string;
  /** Always `NO_COMPUTER`. An optional `computerId` makes the routes' context fail to infer
   * (139 type errors), so both doors keep the daemon principal's required string. */
  computerId: string;
  agentId: string;
};

/** A bot has no Computer; routes a bot may call never read this. */
export const NO_COMPUTER = "";

/**
 * The Agent API's door for a bot. A bot presents its key alone, as `Authorization: Bearer
 * sk_agent_...`; an Agent of a Computer presents the daemon's key there and its own in
 * `x-coforge-agent-api-key`, so a request with that header is not a bot's. `undefined`: not a
 * bot's request, the Computer door decides. A key that does not hold (never issued, revoked, an
 * earlier generation, the grant or the app's declaration gone, the Agent deleted) is 401; a call
 * outside its capabilities is 403 `capability_not_granted`.
 */
export async function authenticateAppBotRequest(
  request: Request,
  bots: Pick<AppBots, "authenticate">,
): Promise<{ principal: AppBotAgentPrincipal } | Response | undefined> {
  if (request.headers.has("x-coforge-agent-api-key")) return undefined;
  const authorization = request.headers.get("authorization");
  const apiKey = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!isAgentApiKeyShape(apiKey)) return undefined;
  const bot = await bots.authenticate(apiKey);
  if (!bot) return errorResponse("invalid_credential", "unauthorized", 401, false);
  if (!appBotCapability(request.method, new URL(request.url).pathname))
    return errorResponse(
      "capability_not_granted",
      "an app bot key does not carry this capability",
      403,
      false,
    );
  return {
    principal: {
      appBot: true,
      userId: bot.userId,
      workspaceId: bot.workspaceId,
      computerId: NO_COMPUTER,
      agentId: bot.agentId,
    },
  };
}

/**
 * `GET /api/agent/v1/events` for a bot: its inbox, read without taking it. `limit` bounds the
 * page; `since` is the `cursor` of the previous answer and acknowledges everything up to it. A
 * pull without `since` acknowledges nothing, so the same messages come again until the app has
 * handled them and handed the cursor back.
 */
export async function handleAppBotEventsGet(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  db: PrismaClient,
): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const limit = query.has("limit") ? Number(query.get("limit")) : undefined;
  if (limit !== undefined && !Number.isInteger(limit))
    return Response.json({ error: "invalid events limit" }, { status: 400 });
  try {
    const inbox = await new AppBotInbox(db).check(principal, {
      ...(query.has("since") ? { since: query.get("since")! } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return Response.json({ idempotencyKey: agentIdempotencyKeyFromQuery(request), ...inbox });
  } catch (error) {
    if (error instanceof AppBotInboxCursorError)
      return Response.json({ error: "invalid since cursor" }, { status: 400 });
    throw error;
  }
}
