import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { SendDirectMessage } from "#src/server/conversations/direct-message.server";
import { getMessageRequestIdempotency } from "#src/server/conversations/redis-message-request-idempotency.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { createExplicitMemoryDiagnosis, type DiagnosisScope } from "./explicit-diagnosis";
import { createOpenVikingExplicitDiagnosis } from "#src/server/openviking/explicit-diagnosis.server";
import { createOpenVikingRuntimeClient } from "#src/server/openviking/runtime-client.server";
import { PrismaOpenVikingBindingStore } from "#src/server/db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "#src/server/db/repositories/workspace-memory-profile.repositories.server";
import { isOpenVikingWorkspaceReady } from "#src/server/openviking/policy-gateway.server";
import type { MemoryCitationBindings } from "./memory-citations";
import type { MemoryOffers } from "./memory-offers";

import { resolveMemoryDiagnosisScope } from "./memory-diagnosis-scope.server";

export function createPrismaExplicitMemoryDiagnosis(input: {
  db: PrismaClient;
  citations: MemoryCitationBindings;
  offers: MemoryOffers;
  authorization(credentialRef: string): Promise<string>;
}) {
  const { db } = input;
  const bindings = new PrismaOpenVikingBindingStore(db);
  const profiles = new PrismaWorkspaceMemoryProfileStore(db);
  const run = createOpenVikingExplicitDiagnosis({
    runtime: createOpenVikingRuntimeClient({
      baseUrl: Bun.env.COFORGE_OPENVIKING_URL ?? "http://127.0.0.1:0",
    }),
    async identity(workspaceId, targetAgentId) {
      const binding = await bindings.get(workspaceId);
      if (!binding || !isOpenVikingWorkspaceReady(await profiles.get(workspaceId), binding))
        throw new Error("diagnosis_workspace_unavailable");
      return {
        accountId: binding.accountId,
        userId: `agent:${targetAgentId}`,
        role: "user",
        authorization: await input.authorization(binding.credentialRef),
      };
    },
  });
  return createExplicitMemoryDiagnosis({
    async resolve({ workspaceId, agentId, messageId }): Promise<DiagnosisScope> {
      const ttl = Number(Bun.env.COFORGE_MEMORY_HINT_TTL_SECONDS);
      if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("diagnosis_hint_ttl_required");
      return resolveMemoryDiagnosisScope(db, { workspaceId, agentId, messageId });
    },
    run,
    async notifyFailure({ workspaceId, agentId, scope, reason }) {
      const [group, target] = await Promise.all([
        db.conversation.findFirstOrThrow({
          where: { id: scope.conversationId, workspaceId },
          select: { channelName: true },
        }),
        db.agent.findFirstOrThrow({
          where: { id: scope.targetAgentId, workspaceId },
          select: { name: true },
        }),
      ]);
      const api = createCentrifugoServerApi();
      const sender = new SendDirectMessage(
        new PrismaDirectConversationRepository(db),
        getMessageRequestIdempotency(),
        api,
        new CentrifugoConversationRealtime(api),
      );
      const safeReason = /^[a-z_]+$/.test(reason) ? reason : "diagnosis_failed";
      const result = await sender.executeFromAgent({
        workspaceId,
        agentId,
        target: `#${group.channelName}`,
        idempotencyKey: `diagnosis-status:${scope.requestId}:failed`,
        body: `@${target.name} 四角色诊断未完成（${safeReason}）。本次没有交付诊断建议，也没有执行修复。诊断锚点消息：${scope.requestId}`,
        mentions: [{ type: "agent", id: scope.targetAgentId, name: target.name }],
      });
      return result.id;
    },
    async publish({ workspaceId, agentId, scope, result, body }) {
      const binding = await bindings.get(workspaceId);
      if (!binding) throw new Error("diagnosis_workspace_unavailable");
      const citations = await input.citations.bindOpenVikingHits(
        workspaceId,
        `diagnosis-${scope.requestId}`,
        [
          {
            accountId: binding.accountId,
            uri: result.report_uri,
            contentHash: result.content_hash,
            citationId: `ov:diagnosis:${scope.requestId}`,
            matchedLevel: "L2",
            title: "Four-role diagnosis report",
          },
        ],
      );
      const delivered = await input.offers.publish({
        workspaceId,
        memoryAgentId: agentId,
        operationId: `diagnosis-${scope.requestId}`,
        conversationId: scope.conversationId,
        targetAgentId: scope.targetAgentId,
        recipientRationale:
          scope.triggerKind === "task_state"
            ? "Memory-initiated diagnosis of this agent's observed task state"
            : "answers this agent's explicit diagnosis request",
        citationRefs: citations.map((citation) => citation.citationId),
        body,
      });
      return { duplicate: delivered.duplicate, messageId: delivered.offer.messageId };
    },
  });
}
