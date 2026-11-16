import { AppError } from "#src/lib/app-error";
import { createFileRoute } from "@tanstack/react-router";
import {
  agentAuthMiddleware,
  agentErrorResponse,
} from "#src/server/agents/agent-http-middleware.server";
import { runPlatformMemory } from "#src/server/platform-memory/composition.server";
import { readCappedJson } from "#src/server/http/capped-json-body.server";

export const Route = createFileRoute("/api/agent/v1/memory")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      POST: ({ request, context: { principal, db } }) =>
        handlePlatformMemoryRequest(
          request,
          principal.agentId
            ? { kind: "agent", workspaceId: principal.workspaceId, agentId: principal.agentId }
            : null,
          (actor, value) => runPlatformMemory(db, actor, value),
        ),
    },
  },
});

export async function handlePlatformMemoryRequest(
  request: Request,
  actor: import("#src/server/platform-memory/contract").MemoryActor | null,
  run: (
    actor: import("#src/server/platform-memory/contract").MemoryActor,
    value: unknown,
  ) => Promise<import("@lrm/coforge-sdk/agent").PlatformMemoryResult>,
) {
  if (!actor) return agentErrorResponse(new AppError("ACCESS_DENIED"));
  try {
    const body = await readCappedJson(request, 72000);
    if (!body.ok)
      return Response.json(
        { error: "invalid memory request" },
        { status: body.reason === "too_large" ? 413 : 400 },
      );
    return Response.json(await run(actor, body.value));
  } catch (error) {
    return agentErrorResponse(error);
  }
}
