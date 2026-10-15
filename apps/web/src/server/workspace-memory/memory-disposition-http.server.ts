import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaMemoryDispositionStore } from "#src/server/db/repositories/memory-disposition.repositories.server";
import { PrismaOpenVikingBindingStore } from "#src/server/db/repositories/openviking-binding.repositories.server";
import {
  createDefaultOpenVikingGateway,
  createPrismaMemoryAgentDirectory,
} from "./memory-agent-http.server";
import { createMemoryDispositions } from "./memory-dispositions.server";
import { createMemorySourceAccess } from "#src/server/openviking/memory-source-access.server";

export async function handleMemoryDispositionHttp(input: {
  db: PrismaClient;
  workspaceId: string;
  agentId: string;
  body: unknown;
  service?: ReturnType<typeof createMemoryDispositions>;
}): Promise<Response> {
  const directory = createPrismaMemoryAgentDirectory(input.db);
  const service =
    input.service ??
    createMemoryDispositions({
      store: new PrismaMemoryDispositionStore(input.db),
      isMemoryAgent: directory.isDesignated,
      canReadSource: createMemorySourceAccess({
        bindings: new PrismaOpenVikingBindingStore(input.db),
        gateway: createDefaultOpenVikingGateway(input.db),
      }),
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
