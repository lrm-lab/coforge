import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaExternalAgentCredentialRepository } from "#src/server/db/repositories/external-agent-credential.repositories.server";
import { extendRequestTimeout } from "#src/server/http/request-timeout.server";
import { errorResponse } from "./agent-http-error.server";
import {
  ExternalCredentialError,
  authenticateExternalAgentKey,
  isExternalAgentPrincipal,
} from "./external-agent-credentials.server";
import { externalInboxSignal } from "./external-inbox-signal.server";
import { listWakeHints } from "./external-wake-hints.server";
import { WakeStreamLimit, openWakeStream } from "./external-wake-stream.server";

const STREAM_REQUEST_TIMEOUT_SECONDS = 120;

const streams = new WakeStreamLimit();

export const externalOnly = () =>
  errorResponse("external_agents_only", "this operation is only for external Agents", 403, false);

export async function handleWakeHintsGet(
  principal: { workspaceId: string; agentId: string },
  db: PrismaClient,
): Promise<Response> {
  if (!isExternalAgentPrincipal(principal)) return externalOnly();
  return Response.json({ hints: await listWakeHints(db, principal) });
}

function bearerOf(request: Request): string {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

export function handleWakeStreamGet(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  db: PrismaClient,
): Response {
  if (!isExternalAgentPrincipal(principal)) return externalOnly();
  const release = streams.acquire(principal.credentialId);
  if (!release)
    return errorResponse("too_many_streams", "too many open wake streams for this key", 429, true);
  extendRequestTimeout(request, STREAM_REQUEST_TIMEOUT_SECONDS);
  const apiKey = bearerOf(request);
  const credentials = new PrismaExternalAgentCredentialRepository(db);
  const stream = openWakeStream(
    {
      listHints: () => listWakeHints(db, principal),
      subscribe: (listener) => externalInboxSignal.subscribe(principal.agentId, listener),
      revalidate: async () => {
        try {
          await authenticateExternalAgentKey(apiKey, credentials);
          return true;
        } catch (error) {
          if (error instanceof ExternalCredentialError) return false;
          throw error;
        }
      },
      release,
    },
    request.signal,
  );
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
