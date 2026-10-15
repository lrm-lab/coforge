import { PrismaMemoryDispositionStore } from "#src/server/db/repositories/memory-disposition.repositories.server";
/**
 * Thin HTTP assembly for the Memory Agent route. Routes stay adapters.
 */

import { readFileSync } from "node:fs";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaOpenVikingBindingStore } from "../db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryCitationStore } from "../db/repositories/workspace-memory-citation.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../db/repositories/workspace-memory-profile.repositories.server";
import { createOpenVikingPolicyGateway } from "../openviking/policy-gateway.server";
import { createOpenVikingRuntimeClient } from "../openviking/runtime-client.server";
import { createMemoryAgentFenceLookup } from "./memory-agent-fence";
import { resolveUnansweredMemoryOfferTarget } from "./explicit-memory-answer";
import { createMemoryCitationBindings } from "./memory-citations";
import { createMemoryAgentBudgetLedger } from "./memory-agent-budget";
import {
  createMemoryAgentCommands,
  memoryAgentResultToResponse,
  triggerMessageIdFrom,
  type MemoryAgentCommands,
  type MemoryAgentDirectory,
} from "./memory-agent-route";
import { createPrismaExplicitMemoryDiagnosis } from "./explicit-diagnosis.server";
import { createMemoryOffers } from "./memory-offers";
import {
  createPrismaMemoryOfferChannels,
  createPrismaMemoryOfferPublisher,
} from "./offer-delivery.server";
import {
  createCatalogOpenVikingMemoryReadClient,
  type OpenVikingMemoryReadClient,
} from "../openviking/memory-agent-reads";
import { createOpenVikingMemoryReads } from "../openviking/openviking-memory-reads";

const budgets = createMemoryAgentBudgetLedger();

export function createPrismaMemoryAgentDirectory(db: PrismaClient): MemoryAgentDirectory {
  return {
    async isDesignated(workspaceId, agentId) {
      const mapped = await db.openVikingMappedIdentity.findFirst({
        where: { workspaceId, actorKind: "memory_agent", actorSubject: agentId },
        select: { id: true },
      });
      return mapped !== null;
    },
  };
}

export function createScopedMemoryAgentHttpCommands(
  db: PrismaClient,
  _workspaceId: string,
  extras: {
    openvikingReads?: OpenVikingMemoryReadClient;
    directory?: MemoryAgentDirectory;
  } = {},
): MemoryAgentCommands {
  const profiles = new PrismaWorkspaceMemoryProfileStore(db);
  const citationsStore = new PrismaWorkspaceMemoryCitationStore(db);
  const citations = createMemoryCitationBindings({ openviking: citationsStore });
  const offers = createMemoryOffers({
    citations,
    offers: citationsStore,
    publisher: createPrismaMemoryOfferPublisher(db),
    channels: createPrismaMemoryOfferChannels(db),
    hints: {
      prepare(input) {
        const seconds = Number(Bun.env.COFORGE_MEMORY_HINT_TTL_SECONDS);
        return new PrismaMemoryDispositionStore(db).prepare({
          ...input,
          ttlMilliseconds: seconds * 1000,
        });
      },
    },
  });
  return createMemoryAgentCommands({
    fence: createMemoryAgentFenceLookup(profiles),
    directory: extras.directory ?? createPrismaMemoryAgentDirectory(db),
    budgets,
    citations,
    offers,
    diagnose: createPrismaExplicitMemoryDiagnosis({
      db,
      citations,
      offers,
      authorization: resolveOpenVikingAuthorization,
    }),
    openviking: createOpenVikingMemoryReads({
      client: extras.openvikingReads ?? createDefaultOpenVikingReadClient(db),
      citations,
    }),
    offerTargets: {
      resolve(currentWorkspaceId, memoryAgentId) {
        return resolveUnansweredMemoryOfferTarget(db, currentWorkspaceId, memoryAgentId);
      },
    },
  });
}

export async function handleMemoryAgentHttp(input: {
  db: PrismaClient;
  workspaceId: string;
  agentId: string;
  request: Request;
  body: unknown;
  commands?: MemoryAgentCommands;
}): Promise<Response> {
  const commands =
    input.commands ?? createScopedMemoryAgentHttpCommands(input.db, input.workspaceId);
  const operationId =
    input.body && typeof input.body === "object" && "operationId" in input.body
      ? String((input.body as { operationId?: unknown }).operationId ?? "memory")
      : "memory";
  const result = await commands.handle({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    triggerMessageId: triggerMessageIdFrom(input.request, operationId),
    command: input.body,
  });
  return memoryAgentResultToResponse(result);
}

function accountKeyFor(credentialRef: string): string | undefined {
  const path = Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE;
  if (!path) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const key = raw[credentialRef];
  if (typeof key !== "string" || key.length === 0)
    throw new Error("openviking account key is missing");
  return key;
}

export function createDefaultOpenVikingGateway(db: PrismaClient) {
  const bindings = new PrismaOpenVikingBindingStore(db);
  return createOpenVikingPolicyGateway({
    profiles: new PrismaWorkspaceMemoryProfileStore(db),
    bindings,
    runtime: createOpenVikingRuntimeClient({
      baseUrl: Bun.env.COFORGE_OPENVIKING_URL ?? "http://127.0.0.1:0",
    }),
    resolveAuthorization: resolveOpenVikingAuthorization,
  });
}

function createDefaultOpenVikingReadClient(db: PrismaClient): OpenVikingMemoryReadClient {
  const bindings = new PrismaOpenVikingBindingStore(db);
  const gateway = createDefaultOpenVikingGateway(db);
  return createCatalogOpenVikingMemoryReadClient({
    async forward(request) {
      const result = await gateway.forward(
        { kind: "memory_agent", agentId: request.agentId },
        {
          workspaceId: request.workspaceId,
          method: request.method,
          path: request.path,
          query: request.query,
          headers: request.body === undefined ? undefined : { "content-type": "application/json" },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        },
      );
      if (!result.ok) throw new Error(result.failure.message);
      if (result.response.status >= 400)
        throw new Error(`openviking upstream status ${result.response.status}`);
      const text = await new Response(result.response.body).text();
      const parsed = text ? JSON.parse(text) : {};
      const binding = await bindings.get(request.workspaceId);
      if (binding && parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return { ...parsed, accountId: binding.accountId };
      return parsed;
    },
  });
}

async function resolveOpenVikingAuthorization(credentialRef: string): Promise<string> {
  if (!credentialRef.startsWith("secret:")) throw new Error("invalid credential ref");
  const token = accountKeyFor(credentialRef) ?? Bun.env.COFORGE_OPENVIKING_RUNTIME_TOKEN;
  if (!token) throw new Error("openviking runtime token is not configured");
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}
