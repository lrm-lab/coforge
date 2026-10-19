import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { isAppErrorCode } from "#src/lib/app-error";
import { errorResponse } from "#src/server/agents/agent-http-error.server";
import { agentAuthMiddleware } from "#src/server/agents/agent-http-middleware.server";
import { readAgentJsonBody } from "#src/server/agents/agent-http-routes.server";
import { configuredGitHub } from "#src/server/integrations/github-config.server";
import type { GitHubConnection } from "#src/server/integrations/github-connection.server";

const requestSchema = z.object({}).strict();

/**
 * `POST /api/agent/v1/github-credentials` (`coforge github credential`, behind `git push`): a
 * current GitHub user token of the Agent's owner. `github` is `null` when this server has no GitHub
 * configured, which no retry fixes. `credential()` logs its own failures.
 */
export async function handleGitHubCredentialPost(
  request: Request,
  principal: { userId: string },
  github: Pick<GitHubConnection, "credential"> | null,
): Promise<Response> {
  if (!requestSchema.safeParse(await readAgentJsonBody(request)).success)
    return errorResponse("INVALID_INPUT", "request body must be an empty JSON object", 400, false);
  if (!github)
    return errorResponse(
      "TEMPORARILY_UNAVAILABLE",
      "GitHub is not configured on this server",
      503,
      false,
    );
  try {
    return Response.json(await github.credential(principal.userId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (isAppErrorCode(error, "ACCESS_DENIED"))
      return errorResponse(
        "GITHUB_RECONNECT_REQUIRED",
        "GitHub is not connected for this Agent's owner, or its authorization expired; " +
          "the owner must reconnect GitHub in Settings → Integrations",
        403,
        false,
      );
    return errorResponse(
      "TEMPORARILY_UNAVAILABLE",
      "GitHub could not issue a credential right now; try again shortly",
      503,
      true,
    );
  }
}

/** The configured GitHub connection, or `null` when it is missing or its configuration is invalid
 * (`readGitHubConfig` throws on an invalid one, which is logged). */
async function configuredConnection() {
  try {
    return (await configuredGitHub())?.connection ?? null;
  } catch (error) {
    console.error("[agent] GitHub configuration is invalid", error);
    return null;
  }
}

export const Route = createFileRoute("/api/agent/v1/github-credentials")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: async ({ request, context: { principal } }) =>
        handleGitHubCredentialPost(request, principal, await configuredConnection()),
    },
  },
});
