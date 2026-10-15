import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaMemoryDispositionStore } from "#src/server/db/repositories/memory-disposition.repositories.server";
import { PrismaOpenVikingBindingStore } from "#src/server/db/repositories/openviking-binding.repositories.server";
import {
  createDefaultOpenVikingGateway,
  createPrismaMemoryAgentDirectory,
} from "./memory-agent-http.server";
import { createMemoryDispositions, type MemoryHintSource } from "./memory-dispositions.server";
import type { OpenVikingPolicyGateway } from "#src/server/openviking/policy-gateway.server";

/** Current source ACL only: do not redo discovery eligibility or inspect hint text. */
export function createMemorySourceAccess({
  bindings,
  gateway,
}: {
  bindings: { get(workspaceId: string): Promise<{ accountId: string } | null> };
  gateway: OpenVikingPolicyGateway;
}) {
  return async (
    workspaceId: string,
    agentId: string,
    source: MemoryHintSource,
  ): Promise<boolean> => {
    const binding = await bindings.get(workspaceId);
    if (!binding || binding.accountId !== source.accountId) return false;
    const result = await gateway.forward(
      { kind: "agent", agentId },
      {
        workspaceId,
        method: "GET",
        path: "/api/v1/fs/stat",
        query: { uri: source.uri },
      },
    );
    if (!result.ok) {
      if (result.failure.code === "capability_denied") return false;
      throw new Error("Memory source authorization is unavailable");
    }
    await result.response.body.cancel();
    if ([403, 404].includes(result.response.status)) return false;
    if (result.response.status < 200 || result.response.status >= 300)
      throw new Error("Memory source authorization is unavailable");
    return true;
  };
}

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
