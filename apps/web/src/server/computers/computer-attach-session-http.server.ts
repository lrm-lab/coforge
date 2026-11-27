import {
  COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR,
  ComputerAttachErrorCode as Code,
  ComputerAttachSessionIntent,
  computerAttachWire,
} from "@lrm/coforge-sdk/internal/computer-attach-session";
import type { PrismaClient } from "#src/generated/prisma/client";
import { authenticateLinkedDaemon } from "#src/server/auth/daemon-request.server";
import {
  NO_RATE_LIMIT,
  RateLimitOutageLog,
  RedisAppRateLimit,
  type AppRateLimit,
} from "#src/server/app-rate-limits/app-rate-limit.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { clientAddress, publicOrigin } from "#src/server/http/public-origin.server";
import { openRedisClient } from "#src/server/redis-client.server";
import {
  completeComputerAttachSession,
  preflightComputerAttachSession,
} from "./computer-attach-session-activation.server";
import { AttachSessionError } from "./computer-attach-session-state.server";
import {
  createComputerAttachSession,
  pollComputerAttachSession,
} from "./computer-attach-session.server";

const MEDIA_TYPE = "application/protobuf";
const NO_STORE = { "cache-control": "no-store" };
const statusForError: Partial<Record<Code, number>> = {
  [Code.ATTACH_SESSION_EXPIRED]: 410,
  [Code.COMPLETION_TIMEOUT]: 410,
  [Code.ATTACH_DENIED]: 403,
  [Code.ATTACH_DISABLED]: 403,
  [Code.REQUIRES_ADMIN]: 403,
  [Code.MACHINE_KEY_MISMATCH]: 403,
  [Code.SERVER_NOT_FOUND]: 404,
  [Code.INVALID_CREDENTIAL]: 401,
  [Code.RECOVERY_UNAVAILABLE]: 409,
  [Code.COMPUTER_CONFLICT]: 409,
  [Code.TICKET_CONSUMED]: 409,
  [Code.SLOW_DOWN]: 429,
};

let creationLimit: AppRateLimit | undefined;

export function computerAttachCreationRateLimit(): AppRateLimit {
  if (creationLimit) return creationLimit;
  const redisUrl = Bun.env.COFORGE_REDIS_URL ?? Bun.env.REDIS_URL;
  if (!redisUrl) return NO_RATE_LIMIT;
  creationLimit = new RedisAppRateLimit(openRedisClient(redisUrl), {
    keyPrefix: "computer-attach-start",
    limit: 10,
    windowMs: 60_000,
    outageLog: new RateLimitOutageLog(),
  });
  return creationLimit;
}

const protobuf = (bytes: Uint8Array, status = 200, extra?: Record<string, string>) =>
  new Response(Uint8Array.from(bytes), {
    status,
    headers: { ...NO_STORE, "content-type": MEDIA_TYPE, ...extra },
  });

function attachError(error: AttachSessionError) {
  const { code, retryAfterSeconds } = error;
  return protobuf(
    computerAttachWire.error.encode({ code, retryAfterSeconds }),
    statusForError[code] ?? 400,
    retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : undefined,
  );
}

export function computerAttachCapabilities() {
  return protobuf(
    computerAttachWire.capabilities.encode({
      protocolMajor: COMPUTER_ATTACH_SESSION_PROTOCOL_MAJOR,
    }),
  );
}

async function readFrame<Value>(
  request: Request,
  decode: (bytes: Uint8Array) => Value,
): Promise<Value> {
  if (!request.body || request.headers.get("content-type") !== MEDIA_TYPE)
    throw new AttachSessionError(Code.INVALID_REQUEST);
  const reader = request.body.getReader();
  const bytes = new Uint8Array(4096);
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > bytes.length) {
        void reader.cancel().catch(() => {});
        throw new AttachSessionError(Code.INVALID_REQUEST);
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    return decode(bytes.subarray(0, offset));
  } catch {
    throw new AttachSessionError(Code.INVALID_REQUEST);
  } finally {
    reader.releaseLock();
  }
}

export async function openComputerAttachSession(
  request: Request,
  options: { db?: PrismaClient; rateLimit?: AppRateLimit } = {},
) {
  const db = options.db ?? getDatabaseClient();
  if (!db) return new Response(null, { status: 503, headers: NO_STORE });
  try {
    const limit = options.rateLimit ?? computerAttachCreationRateLimit();
    const decision = await limit.admit(clientAddress(request) ?? "unknown");
    if (!decision.allowed)
      return attachError(new AttachSessionError(Code.SLOW_DOWN, decision.retryAfterSeconds));
    const body = await readFrame(request, computerAttachWire.createRequest.decode);
    let linkedComputer: { computerId: string; ownerId: string } | undefined;
    if (body.existingComputerId && body.intent === ComputerAttachSessionIntent.ATTACH) {
      const authorized = await authenticateLinkedDaemon(request);
      if (
        authorized instanceof Response ||
        authorized.principal.computerId !== body.existingComputerId
      )
        throw new AttachSessionError(Code.INVALID_CREDENTIAL);
      linkedComputer = {
        computerId: authorized.principal.computerId,
        ownerId: authorized.principal.userId,
      };
    }
    const session = await createComputerAttachSession(db, body, {
      origin: publicOrigin(request),
      linkedComputer,
    });
    return protobuf(computerAttachWire.createResponse.encode(session), 201);
  } catch (error) {
    if (error instanceof AttachSessionError) return attachError(error);
    throw error;
  }
}

export async function runComputerAttachOperation(
  db: PrismaClient | undefined | null,
  id: string,
  operation: string,
  request: Request,
) {
  if (!db) return new Response(null, { status: 503, headers: NO_STORE });
  try {
    switch (operation) {
      case "poll": {
        const { pollSecret } = await readFrame(request, computerAttachWire.pollRequest.decode);
        const result = await pollComputerAttachSession(db, id, pollSecret);
        return protobuf(computerAttachWire.pollResponse.encode(result));
      }
      case "complete": {
        const body = await readFrame(request, computerAttachWire.completeRequest.decode);
        const result = await completeComputerAttachSession(db, id, body, {
          origin: publicOrigin(request),
        });
        return protobuf(computerAttachWire.completeResponse.encode(result), 201);
      }
      case "preflight": {
        const header = request.headers.get("authorization");
        const apiKey = header?.startsWith("Bearer ") ? header.slice(7) : "";
        const result = await preflightComputerAttachSession(db, id, apiKey);
        return protobuf(computerAttachWire.preflightResponse.encode(result));
      }
      default:
        return attachError(new AttachSessionError(Code.SERVER_NOT_FOUND));
    }
  } catch (error) {
    if (error instanceof AttachSessionError) return attachError(error);
    throw error;
  }
}
