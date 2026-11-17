import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaExternalAgentCredentialRepository } from "#src/server/db/repositories/external-agent-credential.repositories.server";
import { extendRequestTimeout } from "#src/server/http/request-timeout.server";
import { bearerToken } from "#src/server/authorization-server/bearer-challenge.server";
import { errorResponse } from "./agent-http-error.server";
import { externalAgentsOnly } from "./external-agent-http.server";
import {
  ExternalCredentialError,
  authenticateExternalAgentKey,
  isExternalAgentPrincipal,
} from "./external-agent-credentials.server";
import { externalSeenNoter } from "./external-agent-presence-publish.server";
import { externalInboxSignal } from "./external-inbox-signal.server";
import { listWakeHints } from "./external-wake-hints.server";
import { WakeStreamLimit, openWakeStream } from "./external-wake-stream.server";

const STREAM_REQUEST_TIMEOUT_SECONDS = 120;

const streams = new WakeStreamLimit();

export async function handleWakeHintsGet(
  principal: { workspaceId: string; agentId: string },
  db: PrismaClient,
): Promise<Response> {
  if (!isExternalAgentPrincipal(principal)) return externalAgentsOnly();
  return Response.json({ hints: await listWakeHints(db, principal) });
}

export function handleWakeStreamGet(
  request: Request,
  principal: { workspaceId: string; agentId: string },
  db: PrismaClient,
): Response {
  if (!isExternalAgentPrincipal(principal)) return externalAgentsOnly();
  const release = streams.acquire(principal.credentialId);
  if (!release)
    return errorResponse("too_many_streams", "too many open wake streams for this key", 429, true);
  try {
    extendRequestTimeout(request, STREAM_REQUEST_TIMEOUT_SECONDS);
    const apiKey = bearerToken(request.headers.get("authorization") ?? "") ?? "";
    const credentials = new PrismaExternalAgentCredentialRepository(db);
    const onSeen = externalSeenNoter(db);
    const stream = openWakeStream(
      {
        listHints: () => listWakeHints(db, principal),
        subscribe: (listener) => externalInboxSignal.subscribe(principal.agentId, listener),
        revalidate: async () => {
          try {
            await authenticateExternalAgentKey(apiKey, credentials, Date.now, onSeen);
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
  } catch (error) {
    release();
    throw error;
  }
}
