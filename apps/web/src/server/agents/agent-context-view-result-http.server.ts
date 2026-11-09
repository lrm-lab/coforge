import {
  decodeAgentContextViewResult,
  type AgentContextViewResult,
} from "@lrm/coforge-sdk/internal";
import { authenticateAgentHttpRequest } from "./agent-api-http.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { getAgentContextViewResults } from "#src/server/centrifugo/agent-context-view-results.server";

const REQUEST_ID = /^ctxv_[A-Za-z0-9_-]{16,64}$/;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;

export type AgentContextViewResultPrincipal = {
  workspaceId: string;
  computerId: string;
  agentId: string;
};

/** Scope check kept pure so the HTTP boundary can be tested without a live database. */
export function agentContextViewResultMatchesPrincipal(
  result: Pick<AgentContextViewResult, "requestId" | "workspaceId" | "computerId" | "agentId">,
  requestId: string,
  principal: AgentContextViewResultPrincipal,
): boolean {
  return (
    result.requestId === requestId &&
    result.workspaceId === principal.workspaceId &&
    result.computerId === principal.computerId &&
    result.agentId === principal.agentId
  );
}

async function readCompressedBody(request: Request): Promise<Uint8Array | Response> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_COMPRESSED_BYTES)
        return Response.json({ error: "payload too large" }, { status: 413 });
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function receiveAgentContextViewResult(
  request: Request,
  requestId: string,
): Promise<Response> {
  if (!REQUEST_ID.test(requestId)) return Response.json({ error: "bad request" }, { status: 400 });
  const db = getDatabaseClient();
  if (!db) return Response.json({ error: "service unavailable" }, { status: 503 });
  let principal: Awaited<ReturnType<typeof authenticateAgentHttpRequest>>;
  try {
    principal = await authenticateAgentHttpRequest(request, db);
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await isFeatureEnabled("agentContextView", { workspaceId: principal.workspaceId })))
    return Response.json({ error: "not found" }, { status: 404 });
  const declared = Number(request.headers.get("x-raft-context-uncompressed-bytes"));
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_BYTES)
    return Response.json({ error: "bad request" }, { status: 400 });
  if (request.headers.get("content-encoding")?.toLowerCase() !== "gzip")
    return Response.json({ error: "unsupported encoding" }, { status: 415 });
  if (request.headers.get("x-raft-client") !== "daemon-agent-context-view")
    return Response.json({ error: "bad request" }, { status: 400 });
  if (request.headers.get("content-type")?.toLowerCase() !== "application/json")
    return Response.json({ error: "unsupported media type" }, { status: 415 });
  const declaredCompressed = Number(request.headers.get("content-length"));
  if (Number.isSafeInteger(declaredCompressed) && declaredCompressed > MAX_COMPRESSED_BYTES)
    return Response.json({ error: "payload too large" }, { status: 413 });
  const compressed = await readCompressedBody(request);
  if (compressed instanceof Response) return compressed;
  let bytes: Uint8Array;
  try {
    bytes = Bun.gunzipSync(Buffer.from(compressed));
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (bytes.byteLength !== declared || bytes.byteLength > MAX_BYTES)
    return Response.json({ error: "payload too large" }, { status: 413 });
  let result;
  try {
    result = decodeAgentContextViewResult(bytes);
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!agentContextViewResultMatchesPrincipal(result, requestId, principal))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const accepted = await getAgentContextViewResults().accept(result);
  if (!accepted) return Response.json({ error: "expired" }, { status: 410 });
  return new Response(null, { status: 204 });
}
