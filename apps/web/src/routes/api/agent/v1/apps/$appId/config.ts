import { createFileRoute } from "@tanstack/react-router";
import {
  decodeAgentAppConfigPatch,
  type AgentAppConfigErrorCode,
  type AgentAppConfigErrorResponse,
  type AgentAppConfigResponse,
  type AgentAppConfigView,
} from "@lrm/coforge-sdk/agent";
import type { AgentAppConfigs } from "#src/server/agent-app-configs/agent-app-configs.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { createAgentAppConfigs } from "#src/server/agent-app-configs/agent-app-configs-composition.server";
import { readAgentJsonBody } from "#src/server/agents/agent-http-routes.server";

type AgentScope = { agentId: string };
type AppConfigService = Pick<AgentAppConfigs, "view" | "update">;

const STATUS: Record<AgentAppConfigErrorCode, number> = {
  app_not_found: 404,
  config_invalid: 400,
  revision_conflict: 409,
};

const found = (config: AgentAppConfigView) =>
  Response.json({ ok: true, ...config } satisfies AgentAppConfigResponse);

function refused(errorCode: AgentAppConfigErrorCode, error: string): Response {
  const body: AgentAppConfigErrorResponse = { ok: false, errorCode, error };
  return Response.json(body, { status: STATUS[errorCode] });
}

const appNotFound = (appId: string) =>
  refused("app_not_found", `You have no App ${appId} with a config.`);

/** `GET /api/agent/v1/apps/:appId/config` (`coforge app config`): one of the calling Agent's
 * own Apps' config. */
export async function handleAgentAppConfigGet(
  principal: AgentScope,
  appId: string,
  configs: AppConfigService,
): Promise<Response> {
  const outcome = await configs.view(principal.agentId, appId);
  return outcome.state === "found" ? found(outcome.config) : appNotFound(appId);
}

/** `PATCH /api/agent/v1/apps/:appId/config` (`coforge app config --set|--unset`): a change to
 * one of the calling Agent's own Apps' config, made against `expectedRevision`. */
export async function handleAgentAppConfigPatch(
  request: Request,
  principal: AgentScope,
  appId: string,
  configs: AppConfigService,
): Promise<Response> {
  const patch = decodeAgentAppConfigPatch(await readAgentJsonBody(request));
  if (!patch)
    return refused(
      "config_invalid",
      "The body must be { expectedRevision, set, unset } with nothing else.",
    );
  const outcome = await configs.update(principal.agentId, appId, patch);
  switch (outcome.state) {
    case "updated":
      return found(outcome.config);
    case "app_not_found":
      return appNotFound(appId);
    case "revision_conflict":
      return refused(
        "revision_conflict",
        `The config is now at revision ${outcome.revision}, not ${patch.expectedRevision}.`,
      );
    case "config_invalid":
      return refused("config_invalid", outcome.reason);
  }
}

export const Route = createFileRoute("/api/agent/v1/apps/$appId/config")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: ({ context: { principal, db }, params }) =>
        handleAgentAppConfigGet(principal, params.appId, createAgentAppConfigs(db)),
      PATCH: ({ request, context: { principal, db }, params }) =>
        handleAgentAppConfigPatch(request, principal, params.appId, createAgentAppConfigs(db)),
    },
  },
});
