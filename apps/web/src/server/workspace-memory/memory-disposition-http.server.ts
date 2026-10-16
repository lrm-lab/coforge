import type { PrismaClient, Prisma } from "#src/generated/prisma/client";
import { PrismaMemoryDispositionStore } from "#src/server/db/repositories/memory-disposition.repositories.server";
import { readOpenVikingBinding } from "#src/server/db/repositories/openviking-binding.repositories.server";
import {
  createDefaultOpenVikingGateway,
  createPrismaMemoryAgentDirectory,
} from "./memory-agent-http.server";
import {
  createMemoryDispositions,
  type MemoryDispositionAuthorization,
} from "./memory-dispositions.server";
import { createMemorySourceAccess } from "#src/server/openviking/memory-source-access.server";

function authorization(
  db: PrismaClient | Prisma.TransactionClient,
): MemoryDispositionAuthorization {
  return {
    isMemoryAgent: createPrismaMemoryAgentDirectory(db).isDesignated,
    canReadSource: createMemorySourceAccess({
      bindings: { get: (workspaceId) => readOpenVikingBinding(db, workspaceId) },
      gateway: createDefaultOpenVikingGateway(db),
    }),
  };
}

export async function handleMemoryDispositionHttp(input: {
  db: PrismaClient;
  workspaceId: string;
  agentId: string;
  body: unknown;
  service?: ReturnType<typeof createMemoryDispositions>;
}): Promise<Response> {
  const service =
    input.service ??
    createMemoryDispositions({
      store: new PrismaMemoryDispositionStore(input.db, authorization),
      ...authorization(input.db),
    });
  try {
    const result = await service.submit(input.workspaceId, input.agentId, input.body);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Memory disposition service unavailable", retryable: true },
      {
        status: 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
